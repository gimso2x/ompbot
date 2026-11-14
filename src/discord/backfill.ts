// Discord missed-message recovery (doc/plans/discord-channel.md §13). A resumed gateway replays what it missed; a new
// session, a restart or a failed live ingest does not, so a pass reads every Discord conversation's channel after its
// watermark and feeds the messages through the adapter's live ingest path, where the ledger's duplicate check stops
// anything already taken. Snowflake ids grow with time, so `after=<watermark>` is the whole window.
import { countsTowardDeadLetter, SingleFlightBackfill } from "../channel/backfill";
import { errorText } from "../channel/text";
import type { IngestOutcome } from "../channel/types";
import type { Logger } from "../log";
import { redact } from "../redact";
import {
	DiscordCallError,
	type DiscordMessageEvent,
	DiscordRateLimitedError,
	type DiscordTransport,
} from "./transport";

/** Discord's `limit` maximum for a channel's message list. */
export const PAGE_LIMIT = 100;
/** Pages one target reads per pass; the rest waits for the next pass (the watermark keeps the place). */
export const MAX_PAGES = 10;
/** How far back a target without a watermark reaches on its first pass. */
export const BOOTSTRAP_LOOKBACK_MS = 24 * 60 * 60_000;
/** Definitive failures of one message before it is skipped so the messages after it are not held forever. */
export const MAX_MESSAGE_ATTEMPTS = 3;
/** Discord JSON error codes of a channel the bot cannot read: Unknown Channel, Missing Access. */
const UNREADABLE_CODES: ReadonlySet<number> = new Set([10003, 50001]);
/** First millisecond of the Discord epoch (2015-01-01T00:00:00Z); a snowflake's top 42 bits count from here. */
const DISCORD_EPOCH_MS = 1_420_070_400_000n;

/** The watermark key of a channel; Slack's are `ch:` / `thr:`, so the two never share a row. */
export function discordCursorKey(channelId: string): string {
	return `dc:${channelId}`;
}

/** Epoch milliseconds a snowflake id was minted at. */
export function snowflakeTime(id: string): number {
	return Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS);
}

/** The smallest snowflake of `ms`: `after=` it lists everything posted from that moment on. */
export function snowflakeAt(ms: number): string {
	const since = BigInt(Math.floor(ms)) - DISCORD_EPOCH_MS;
	return String(since > 0n ? since << 22n : 0n);
}

/** The larger of two snowflakes, by value: ids differ in length, so a string compare would get it wrong. */
function laterId(a: string, b: string): string {
	return BigInt(a) >= BigInt(b) ? a : b;
}

export interface BackfillCursors {
	getCursor(key: string): string | undefined;
	setCursor(key: string, value: string): void;
}

/** One channel to read: a DM (`dm: true`), a server channel or thread (`false`), or not known yet (`undefined`). */
export interface BackfillTarget {
	channelId: string;
	dm?: boolean | undefined;
}

export interface DiscordBackfillDeps {
	transport: Pick<DiscordTransport, "listMessages">;
	cursors: BackfillCursors;
	log: Logger;
	now(): number;
	/** Read fresh at every pass. */
	targets(): BackfillTarget[];
	/**
	 * Whether the adapter can take messages: false (the gateway never came up) skips the pass, since every message
	 * would be dropped and the watermark would move over them.
	 */
	ready(): Promise<boolean>;
	/**
	 * The channel as the adapter's cache knows it: `dm`, the server it belongs to (history rows carry none), or
	 * `undefined` when Discord has no such channel for the bot.
	 */
	locate(channelId: string): Promise<{ dm: true } | { dm: false; guildId: string } | undefined>;
	/** The live ingest path; a throw stops the target before that message (it is read again next pass). */
	ingest(event: DiscordMessageEvent): Promise<IngestOutcome>;
	/**
	 * Once per target scan that recorded messages: `recovered` are their ids, oldest first; `dm` whether the channel is a
	 * DM. A throw is logged (`backfill_notice_failed`); the watermark has already moved.
	 */
	notify?(target: { channelId: string; dm: boolean; recovered: readonly string[] }): Promise<void>;
	maxPages?: number | undefined;
}

/** Unknown Channel / Missing Access: the bot cannot read the channel at all. */
function unreadable(err: unknown): boolean {
	return err instanceof DiscordCallError && err.code !== undefined && UNREADABLE_CODES.has(err.code);
}

/**
 * Single-flight recovery. A channel the bot cannot read is quarantined until the restart, so a left server costs one
 * failed read.
 */
export class DiscordBackfill extends SingleFlightBackfill {
	readonly #deps: DiscordBackfillDeps;
	readonly #quarantined = new Set<string>();
	readonly #attempts = new Map<string, number>();

	constructor(deps: DiscordBackfillDeps) {
		super();
		this.#deps = deps;
	}

	protected failed(err: unknown): void {
		this.#deps.log.error("discord_backfill_failed", { error: redact(errorText(err)) });
	}

	protected async pass(): Promise<void> {
		const { log } = this.#deps;
		if (!(await this.#deps.ready())) {
			log.warn("discord_backfill_skipped", { reason: "not_ready" });
			return;
		}
		const targets = new Map<string, BackfillTarget>();
		for (const target of this.#deps.targets()) {
			const known = targets.get(target.channelId);
			if (known === undefined || known.dm === undefined) targets.set(target.channelId, target);
		}
		let scanned = 0;
		let recovered = 0;
		let skipped = 0;
		for (const target of targets.values()) {
			if (this.#quarantined.has(target.channelId)) {
				skipped += 1;
				continue;
			}
			const result = await this.#scan(target);
			scanned += result.scanned;
			recovered += result.recovered;
		}
		log.info("discord_backfill", {
			targets: targets.size,
			scanned,
			recovered,
			quarantined: this.#quarantined.size,
			skipped,
		});
	}

	#quarantine(key: string, channelId: string, error: string): void {
		this.#quarantined.add(channelId);
		this.#deps.log.warn("backfill_quarantined", { target: key, error });
	}

	/** One channel's scan, then the recovery notice when it recorded anything. */
	async #scan(target: BackfillTarget): Promise<{ scanned: number; recovered: number }> {
		const recovered: string[] = [];
		const place: { dm: boolean } = { dm: target.dm === true };
		const scanned = await this.#read(target, recovered, place);
		const notify = this.#deps.notify;
		if (recovered.length > 0 && notify !== undefined) {
			try {
				await notify({ channelId: target.channelId, dm: place.dm, recovered });
			} catch (err) {
				// The notice is best effort: the messages are already handled and the watermark moved.
				this.#deps.log.warn("backfill_notice_failed", {
					target: discordCursorKey(target.channelId),
					error: redact(errorText(err)),
				});
			}
		}
		return { scanned, recovered: recovered.length };
	}

	/**
	 * Reads one channel oldest-first from its watermark, page after page, moving the watermark over handled messages.
	 * Recorded ids go to `recovered`; `place.dm` ends up true for a DM. Resolves the number of messages read.
	 */
	async #read(target: BackfillTarget, recovered: string[], place: { dm: boolean }): Promise<number> {
		const { cursors, log } = this.#deps;
		const key = discordCursorKey(target.channelId);
		const done = { scanned: 0 };
		let guildId: string | undefined;
		if (target.dm !== true) {
			try {
				const located = await this.#deps.locate(target.channelId);
				if (located === undefined) {
					this.#quarantine(key, target.channelId, "unknown channel");
					return done.scanned;
				}
				guildId = located.dm ? undefined : located.guildId;
				place.dm = located.dm;
			} catch (err) {
				// After a restart the channel cache is empty, so a left server answers here first (403 50001).
				if (unreadable(err)) this.#quarantine(key, target.channelId, redact(errorText(err)));
				else log.warn("backfill_read_failed", { target: key, error: redact(errorText(err)) });
				return done.scanned;
			}
		}
		const stored = cursors.getCursor(key);
		let watermark = stored ?? snowflakeAt(this.#deps.now() - BOOTSTRAP_LOOKBACK_MS);
		const maxPages = this.#deps.maxPages ?? MAX_PAGES;
		for (let page = 0; page < maxPages; page++) {
			let messages: DiscordMessageEvent[];
			try {
				messages = await this.#deps.transport.listMessages({
					channelId: target.channelId,
					after: watermark,
					limit: PAGE_LIMIT,
				});
			} catch (err) {
				if (unreadable(err)) this.#quarantine(key, target.channelId, redact(errorText(err)));
				else log.warn("backfill_read_failed", { target: key, error: redact(errorText(err)) });
				return done.scanned;
			}
			done.scanned += messages.length;
			for (const message of messages) {
				const attemptKey = `${target.channelId}:${message.id}`;
				try {
					// History rows name no server: the target's is put back, so a server message never reads as a DM.
					const outcome = await this.#deps.ingest({ ...message, channel_id: target.channelId, guild_id: guildId });
					if (outcome === "recorded") recovered.push(message.id);
					this.#attempts.delete(attemptKey);
				} catch (err) {
					const platform =
						err instanceof DiscordRateLimitedError
							? false
							: err instanceof DiscordCallError
								? err.kind === "definitive"
								: undefined;
					if (!countsTowardDeadLetter(err, platform)) {
						// Rate limit, Discord 5xx/network or a busy ledger: not the message's fault, the next pass retries it.
						log.warn("backfill_message_retryable", { target: key, id: message.id, error: redact(errorText(err)) });
						if (watermark !== stored) cursors.setCursor(key, watermark);
						return done.scanned;
					}
					const attempts = (this.#attempts.get(attemptKey) ?? 0) + 1;
					if (attempts < MAX_MESSAGE_ATTEMPTS) {
						this.#attempts.set(attemptKey, attempts);
						log.warn("backfill_message_failed", {
							target: key,
							id: message.id,
							attempts,
							error: redact(errorText(err)),
						});
						if (watermark !== stored) cursors.setCursor(key, watermark);
						return done.scanned;
					}
					this.#attempts.delete(attemptKey);
					log.error("backfill_dead_letter", { target: key, id: message.id, error: redact(errorText(err)) });
				}
				watermark = laterId(watermark, message.id);
			}
			cursors.setCursor(key, watermark);
			if (messages.length < PAGE_LIMIT) break;
		}
		return done.scanned;
	}
}
