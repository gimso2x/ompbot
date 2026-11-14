import { resolve, sep } from "node:path";
import type { ChannelAdapter, ChannelPolicy, OwnerIngest } from "../channel/adapter";
import { MAX_INBOUND_FILES, saveInboundAttachment } from "../channel/attachments";
import {
	guardInbound,
	isChannelMessageAddressed,
	recordInbound,
	recordPeerInbound,
	resolveThreadLinks,
	settleCardReply,
} from "../channel/inbound";
import {
	answerFooter,
	DeliveryPump,
	type DeliverySendResult,
	deliverySender,
	finishDeliveryStatus,
} from "../channel/pump";
import { RetryAfterGate } from "../channel/retry";
import { type StatusEntry, StatusTracker } from "../channel/status";
import { DENIED_TEXT, errorText, escapeMrkdwn, type FinalOutcome, STATUS_MIN_INTERVAL_MS } from "../channel/text";
import type { AdapterClock, CoreSink, DeliveryItem, DeliverySource, IngestOutcome } from "../channel/types";
import type { TurnProgress } from "../core/mailbox";
import {
	isOwner,
	normalizeInbound,
	normalizePeerInbound,
	originKeyForMessage,
	parseThreadRef,
	TOP_LEVEL_TS,
	threadRefOf,
	unescapeSlackText,
} from "../core/normalize";
import { COMMAND_TEXT, type CommandKind } from "../core/types";
import type { Logger } from "../log";
import { MONITOR_ORIGIN_PREFIX } from "../monitors/ledger";
import {
	type CardFallback,
	HEADER_LIMIT,
	headerBlock,
	type MentionNames,
	plainHeaderText,
	renderMarkdownParts,
	renderParts,
	type SlackAttachment,
} from "./format";
import {
	type SlackBlockActionPayload,
	SlackCallError,
	type SlackHandlers,
	type SlackInboundFile,
	type SlackMessageEvent,
	SlackRateLimitedError,
	type SlackSlashPayload,
	type SlackTransport,
	type SlashAck,
} from "./transport";

/** Posted once in a thread whose peer-input cap was hit; mentions no bot. */
export const PEER_HOP_NOTICE = "피어 대화 상한에 닿았습니다. 이어 가려면 오너가 말해 주세요.";
/** Default per-thread cap on peer input (`peerHopLimit` unset). */
export const DEFAULT_PEER_HOP_LIMIT = { turns: 3, windowMinutes: 30 } as const;

/** Peer bots the adapter accepts (config `peerBots`). */
export type PeerBotList = ReadonlyArray<{ userId: string; name: string }>;

export interface SlackAdapterOptions {
	transport: SlackTransport;
	core: CoreSink;
	deliveries: DeliverySource;
	ownerUserId: string;
	clock: AdapterClock;
	log: Logger;
	/** Directory for downloaded inbound attachments (`<home>/media`); without it attachments are skipped with a note. */
	mediaRoot?: string;
	/** Channel IDs where the owner's message counts as addressed without a mention (solo channels). */
	mentionFreeChannels?: readonly string[];
	/** The #log ledger channel: inbound there never becomes a turn, even with a mention. */
	logChannel?: string;
	/** Peer bots whose channel messages that mention this bot are accepted (config `peerBots`). Default none. */
	peerBots?: PeerBotList;
	/** In a channel only a mention addresses the bot (mentionFreeChannels and thread participation are ignored). */
	requireMention?: boolean;
	/** Peer input cap per thread. Default `DEFAULT_PEER_HOP_LIMIT`. */
	peerHopLimit?: { turns: number; windowMinutes: number };
	/**
	 * Whether a thread root (`<channel>:<ts>`) is a registered [TASK]: its single status reaction belongs to the task
	 * sweep, so a finished turn only removes its 👀 there and leaves no ✅/⚠️/❌ mark.
	 */
	isTaskRoot?: (threadRef: string) => boolean;
	/**
	 * Called when the live ingest of an event threw and was swallowed as `inbound_failed`. The daemon wires the
	 * backfill trigger here: the live path never advances the watermark, so without it a transient failure would sit
	 * unanswered until the next socket (re)connect. An immediate retry is safe — the runner merges concurrent
	 * triggers (single-flight + follow-up) and re-ingest is idempotent on `platform_message_id`. Best effort: a
	 * throw from it is logged, never propagated to the transport.
	 */
	onInboundFailure?: () => void;
	/**
	 * One missed-message recovery pass (the backfill trigger): `recover()` runs it, and so does every socket reconnect
	 * after the first connect. Absent: `recover()` is a no-op.
	 */
	recover?: () => void;
}

class BlockedError extends Error {}

const SLASH_COMMANDS: Record<string, CommandKind> = Object.fromEntries(
	(Object.entries(COMMAND_TEXT) as Array<[CommandKind, string]>).map(([kind, text]) => [text, kind]),
);

/** Channel types the bot answers in besides the owner DM (public, private and group DMs it was invited to). */
const CHANNEL_TYPES = new Set(["channel", "group", "mpim"]);

/** A message's shared (quoted) attachments as text. */
function quotedOf(event: SlackMessageEvent): string[] {
	return (event.attachments ?? [])
		.flatMap((a) => [a.pretext, a.text ?? a.fallback])
		.filter((t): t is string => typeof t === "string" && t !== "")
		.map(unescapeSlackText);
}

export class SlackAdapter implements ChannelAdapter {
	readonly platform = "slack" as const;
	private readonly transport: SlackTransport;
	private readonly core: CoreSink;
	private readonly deliveries: DeliverySource;
	private readonly ownerUserId: string;
	private readonly clock: AdapterClock;
	private readonly log: Logger;
	private readonly mediaRoot: string | undefined;
	private mentionFreeChannels: ReadonlySet<string>;
	private logChannel: string | undefined;
	private peerBots: PeerBotList;
	private requireMention: boolean;
	private peerHopLimit: { turns: number; windowMinutes: number };
	private readonly isTaskRoot: ((threadRef: string) => boolean) | undefined;
	private readonly onInboundFailure: (() => void) | undefined;
	readonly #status: StatusTracker;
	readonly #gate: RetryAfterGate;
	/** Slack refused a `markdown` block once: every later answer takes the plain mrkdwn path until the restart. */
	#markdownBlocksOff = false;
	/** Slack refused a card holding a chart once: every later card draws its charts as ASCII until the restart. */
	#chartBlocksOff = false;
	/** The path a delivery's first attempt chose, so a rate-limited resume counts `sentParts` in the same chunks. */
	readonly #deliveryPaths = new Map<number, "markdown" | "plain">();
	private ready: Promise<string> | undefined;
	#botUserId: string | undefined;
	readonly #recover: (() => void) | undefined;
	readonly #pump: DeliveryPump;

	constructor(options: SlackAdapterOptions) {
		this.#recover = options.recover;
		this.#gate = new RetryAfterGate({
			clock: options.clock,
			park: (method, retryAfterMs) => options.log.warn("slack_rate_limited", { method, retry_after_ms: retryAfterMs }),
		});
		this.#pump = new DeliveryPump({
			source: options.deliveries,
			sender: deliverySender({
				gate: this.#gate,
				key: "chat.postMessage",
				blockedReason: "chat.postMessage",
				send: (delivery) => this.sendDelivery(delivery),
				finish: (delivery, result) => this.#finishDelivered(delivery, result),
			}),
			clock: options.clock,
			log: options.log,
		});
		this.transport = options.transport;
		this.core = options.core;
		this.deliveries = options.deliveries;
		this.ownerUserId = options.ownerUserId;
		this.clock = options.clock;
		this.log = options.log;
		this.mediaRoot = options.mediaRoot;
		this.mentionFreeChannels = new Set(options.mentionFreeChannels ?? []);
		this.logChannel = options.logChannel;
		this.peerBots = options.peerBots ?? [];
		this.requireMention = options.requireMention === true;
		this.peerHopLimit = options.peerHopLimit ?? DEFAULT_PEER_HOP_LIMIT;
		this.isTaskRoot = options.isTaskRoot;
		this.onInboundFailure = options.onInboundFailure;
		this.#status = new StatusTracker({
			clock: options.clock,
			intervalMs: STATUS_MIN_INTERVAL_MS,
			platform: {
				create: (entry, text) => this.#createStatus(entry, text),
				edit: (entry, text, final) => this.#editStatus(entry, text, final),
				remove: (entry) => this.#removeStatus(entry),
				removeEyes: (target) =>
					this.#swapReaction("reactions.remove", () =>
						this.transport.removeReaction({ channel: target.channelId, timestamp: target.messageId, name: "eyes" }),
					),
				addMark: (target, mark) =>
					this.#swapReaction("reactions.add", () =>
						this.transport.addReaction({ channel: target.channelId, timestamp: target.messageId, name: mark }),
					),
				isTaskRoot: (threadRef) => this.isTaskRoot?.(threadRef),
			},
		});
	}

	/** Config reload: the next inbound event follows the new channel policy. */
	setChannelPolicy(policy: ChannelPolicy): void {
		this.mentionFreeChannels = new Set(policy.mentionFreeChannels ?? []);
		this.logChannel = policy.logChannel;
		this.peerBots = policy.peerBots ?? [];
		this.requireMention = policy.requireMention === true;
		this.peerHopLimit = policy.peerHopLimit ?? DEFAULT_PEER_HOP_LIMIT;
	}

	async start(): Promise<void> {
		const handlers: SlackHandlers = {
			message: (event) => this.handleMessage(event),
			slash: (payload) => this.handleSlash(payload),
			blockAction: (payload) => this.handleBlockAction(payload),
		};
		this.ready = this.transport.start(handlers).then((r) => r.botUserId);
		this.#botUserId = await this.ready;
		// Every reconnect after this first connect runs a recovery pass; the first one is the daemon's `recover()`.
		const recover = this.#recover;
		if (recover !== undefined) this.transport.onReady = () => recover();
	}

	/** The bot's own user id once connected (`<@id>` addresses it in a channel). */
	get botUserId(): string | undefined {
		return this.#botUserId;
	}

	async stop(): Promise<void> {
		await this.transport.stop();
	}

	connectionState(): { state: "up" | "down"; since: number } | undefined {
		return this.transport.connectionState?.();
	}

	recover(): void {
		this.#recover?.();
	}

	/**
	 * An owner message the daemon puts in (TASK card button, auto-merge, inject): built as the Slack event the owner's
	 * own message would be — text and quotes Slack-escaped, the bot mention leading it in a channel — and fed through
	 * the live message path, so the same gates and acknowledgements apply.
	 */
	async ingestOwner(input: OwnerIngest): Promise<IngestOutcome> {
		const inChannel = input.kind === "ch";
		const mention = inChannel && this.#botUserId !== undefined ? `<@${this.#botUserId}> ` : "";
		return this.processMessage(
			{
				type: "message",
				channel: input.conversationId,
				channel_type: inChannel ? "channel" : "im",
				user: this.ownerUserId,
				text: `${mention}${escapeMrkdwn(input.text)}`,
				ts: input.messageId,
				...(input.threadId === undefined ? {} : { thread_ts: input.threadId }),
				attachments: input.quoted?.map((text) => ({ text: escapeMrkdwn(text) })),
			},
			input.injected === true,
		);
	}

	// ---- Slack API calls with per-method Retry-After blocking ----

	private async call<T>(method: string, fn: () => Promise<T>): Promise<T> {
		return this.#gate.call(
			method,
			fn,
			() => new BlockedError(method),
			(err) => (err instanceof SlackRateLimitedError ? err.retryAfterMs : undefined),
		);
	}

	// ---- inbound messages ----

	async handleMessage(event: SlackMessageEvent): Promise<void> {
		// The swallowed event is invisible to the backfill watermark; the callback re-reaches it right away.
		await guardInbound(this.log, { channel: event.channel, ts: event.ts }, this.onInboundFailure, () =>
			this.processMessage(event),
		);
	}

	#drop(event: SlackMessageEvent, reason: string, peer?: string): IngestOutcome {
		this.log.info("inbound_dropped", { reason, channel: event.channel, ts: event.ts, ...(peer && { peer }) });
		return "dropped";
	}

	/** `injected`: an `ompbot inject` message (`OwnerIngest.injected`), which may not answer a card. */
	private async processMessage(event: SlackMessageEvent, injected = false): Promise<IngestOutcome> {
		const inChannel = event.channel_type !== undefined && CHANNEL_TYPES.has(event.channel_type);
		if (event.channel_type !== "im" && !inChannel) return "dropped";
		// #log is a ledger, not a conversation: nothing said there reaches omp.
		if (event.channel === this.logChannel) return this.#drop(event, "log_channel");
		const botUserId = await this.ready;
		if (botUserId === undefined) return "dropped";
		const cardReply = await this.#processCardReply(event, botUserId, injected);
		if (cardReply !== undefined) return cardReply;
		const peer = event.user === botUserId ? undefined : this.peerBots.find((p) => p.userId === event.user);
		if (peer !== undefined) return this.#processPeerMessage(event, botUserId, peer, inChannel);
		if (event.bot_id !== undefined && !isOwner(event.user, this.ownerUserId)) return this.#drop(event, "bot_message");
		// A file message is un-subtyped (the subtype rejection must not drop it) only for file_share itself: an edit or
		// delete event that merely carries `files` stays rejected. A file_share whose files Slack left out (deleted or
		// not accessible) keeps its text, with a note in place of the files.
		const files = event.files ?? [];
		const fileShare = event.subtype === "file_share";
		const fileMessage = files.length > 0 && (event.subtype === undefined || event.subtype === "" || fileShare);
		const filesMissing = fileShare && files.length === 0;
		const subtype = fileShare ? undefined : event.subtype;
		let text = unescapeSlackText(event.text ?? "");
		if (inChannel) {
			const mention = `<@${botUserId}>`;
			const mentioned = text.includes(mention);
			text = text.split(mention).join(" ").trim();
			const addressed = isChannelMessageAddressed(this.core, {
				mentioned,
				// A message that mentions a peer bot but not this bot is meant for the peer.
				forPeer: !mentioned && this.peerBots.some((p) => text.includes(`<@${p.userId}>`)),
				threadRef: event.thread_ts === undefined ? undefined : `${event.channel}:${event.thread_ts}`,
				requireMention: this.requireMention,
				mentionFree: this.mentionFreeChannels.has(event.channel),
			});
			if (!addressed) return this.#drop(event, "not_addressed");
		}
		const normalizeArgs = {
			userId: event.user ?? (event.bot_id ? botUserId : undefined),
			botUserId,
			ownerUserId: this.ownerUserId,
			quoted: quotedOf(event),
			channel: event.channel,
			ts: event.ts,
			threadTs: event.thread_ts,
			subtype,
			channelType: event.channel_type,
		};
		// Authorization and addressing are settled BEFORE any disk or network work: a non-owner's (or unaddressed) file
		// is never downloaded. The placeholder only stands in for the notes the download will add to an empty text.
		const gate = normalizeInbound({
			...normalizeArgs,
			text: (fileMessage || filesMissing) && text.trim() === "" ? "[file]" : text,
		});
		if (!gate.accept) return this.#drop(event, gate.reason);
		if (fileMessage) {
			const notes = await this.#collectAttachments(event, files);
			text = [text.trim(), ...notes].filter((line) => line !== "").join("\n");
		} else if (filesMissing) {
			text = [text.trim(), "[첨부 실패: Slack이 파일 정보를 보내지 않았습니다(삭제됐거나 볼 수 없는 파일)]"]
				.filter((line) => line !== "")
				.join("\n");
		}
		const result = normalizeInbound({ ...normalizeArgs, text });
		if (!result.accept) return this.#drop(event, result.reason);
		const { inbound } = result;
		return recordInbound(this.core, this.log, inbound, (thread, showStatus) =>
			this.beginStatus(inbound.threadRef, thread.channel, thread.threadTs, event, inbound.originKey, showStatus),
		);
	}

	/**
	 * A message of an allowlisted peer bot: accepted only in a channel, un-subtyped and mentioning this bot. It never
	 * takes an owner path — no attachment download, no card reply, no command parsing (the text goes
	 * to the core fenced) — and is capped per thread by the core (`onPeerInbound`).
	 */
	async #processPeerMessage(
		event: SlackMessageEvent,
		botUserId: string,
		peer: { userId: string; name: string },
		inChannel: boolean,
	): Promise<IngestOutcome> {
		const drop = (reason: string): IngestOutcome => this.#drop(event, reason, peer.userId);
		if (!inChannel) return drop("peer_dm");
		if (event.subtype !== undefined && event.subtype !== "") return drop("subtype");
		const mention = `<@${botUserId}>`;
		const raw = unescapeSlackText(event.text ?? "");
		if (!raw.includes(mention)) return drop("peer_not_mentioned");
		if (this.core.onPeerInbound === undefined) return drop("peer_unsupported");
		const result = normalizePeerInbound({
			peer,
			text: raw.split(mention).join(" ").trim(),
			quoted: quotedOf(event),
			platformMessageId: `${event.channel}:${event.ts}`,
			// A peer's text is fenced, never a command: its origin is always the thread's.
			originKey: originKeyForMessage(event.channel, "channel", event.ts, event.thread_ts, ""),
			threadRef: threadRefOf(event.channel, event.thread_ts ?? event.ts),
			subtype: event.subtype,
		});
		if (!result.accept) return drop(result.reason);
		const { inbound } = result;
		const refused = await recordPeerInbound(this.core, this.log, inbound, this.peerHopLimit, drop, () =>
			this.postNotice(event.channel, PEER_HOP_NOTICE, event.thread_ts ?? event.ts),
		);
		if (refused !== undefined) return refused;
		const parsed = parseThreadRef(inbound.threadRef);
		if (parsed) {
			await this.beginStatus(inbound.threadRef, parsed.channel, parsed.threadTs, event, inbound.originKey, true);
		}
		return "recorded";
	}

	/**
	 * The owner's reply in an approval card's thread counts as addressed without a mention, in any channel or DM, and
	 * never takes the normal path: a pending card is settled by it (no inbound row, no session), a settled card's
	 * reply goes to the asking conversation with the card thread as its thread. Non-owner replies fall through (and
	 * are ignored there).
	 */
	async #processCardReply(
		event: SlackMessageEvent,
		botUserId: string,
		injected: boolean,
	): Promise<IngestOutcome | undefined> {
		const threadTs = event.thread_ts;
		if (this.core.onCardReply === undefined) return undefined;
		if (threadTs === undefined || threadTs === "" || threadTs === event.ts) return undefined;
		if (!isOwner(event.user, this.ownerUserId) || (event.subtype !== undefined && event.subtype !== ""))
			return undefined;
		const text = unescapeSlackText(event.text ?? "")
			.split(`<@${botUserId}>`)
			.join(" ")
			.trim();
		if (text === "") return undefined;
		const threadRef = `${event.channel}:${threadTs}`;
		const reply = { threadRef, platformMessageId: `${event.channel}:${event.ts}`, text, injected };
		return settleCardReply(this.core, this.log, reply, (originKey) =>
			this.beginStatus(threadRef, event.channel, threadTs, event, originKey, true),
		);
	}

	/** Backfill entry: the exact live path, but reporting the outcome so the caller can count recovered messages. */
	async ingestRecovered(event: SlackMessageEvent): Promise<Exclude<IngestOutcome, "card_rejected">> {
		const outcome = await this.processMessage(event);
		// Only an injected owner message is refused at a card; a recovered Slack event never is one.
		if (outcome === "card_rejected") throw new Error("unreachable: a recovered event is not injected");
		return outcome;
	}

	/**
	 * Best-effort root message (missed-message notice), or a reply when `threadTs` is given; failures are logged, never
	 * thrown. A notice of two or more lines goes out as a card: its first line as the header, the rest as one section;
	 * `text` stays the whole notice. Blocks Slack refuses (`invalid_blocks`) are dropped and the notice is sent once more.
	 */
	async postNotice(channel: string, text: string, threadTs?: string): Promise<void> {
		const blocks = this.#noticeBlocks(text);
		// Same rate-limit key as the delivery pump and the status posts: one chat.postMessage 429 blocks them all.
		const send = (withBlocks: readonly unknown[] | undefined) =>
			this.call("chat.postMessage", () =>
				this.transport.postMessage({
					channel,
					text,
					...(threadTs === undefined ? {} : { threadTs }),
					...(withBlocks === undefined ? {} : { blocks: withBlocks }),
				}),
			);
		try {
			try {
				await send(blocks);
			} catch (err) {
				const refused =
					err instanceof SlackCallError &&
					err.kind === "definitive" &&
					/invalid_blocks|invalid_arguments/.test(errorText(err));
				if (blocks === undefined || !refused) throw err;
				this.log.warn("notice_blocks_rejected", { channel, error: errorText(err) });
				await send(undefined);
			}
		} catch (err) {
			this.log.warn("backfill_notice_failed", { channel, error: errorText(err) });
		}
	}

	/** Header (first line, at most 150 chars, mrkdwn stripped) + section (the rest) for a notice of two or more lines. */
	#noticeBlocks(text: string): readonly unknown[] | undefined {
		const newline = text.indexOf("\n");
		if (newline < 0) return undefined;
		const first = text.slice(0, newline);
		const rest = text.slice(newline + 1);
		// A section's text holds 3,000 characters; a longer notice stays plain rather than be refused.
		if (first.length > HEADER_LIMIT || rest.trim() === "" || rest.length > 3_000) return undefined;
		const title = plainHeaderText(first, this.#mentionNames());
		if (title === "") return undefined;
		return [headerBlock(title), { type: "section", text: { type: "mrkdwn", text: rest } }];
	}

	#mentionNames(): MentionNames {
		return { ownerUserId: this.ownerUserId, peerBots: this.peerBots };
	}

	/** Downloads inbound files (up to `MAX_INBOUND_FILES`) and returns the prompt note lines for them. */
	async #collectAttachments(event: SlackMessageEvent, files: readonly SlackInboundFile[]): Promise<string[]> {
		const mediaRoot = this.mediaRoot;
		if (mediaRoot === undefined) {
			return [`[첨부 실패: ${files.length}개 — 미디어 저장이 구성되지 않았습니다]`];
		}
		// The message ts names the download directory: anything but Slack's `<seconds>.<micros>` could leave mediaRoot.
		const inboundRoot = resolve(mediaRoot, "inbound");
		const dir = resolve(inboundRoot, event.ts.replace(".", "_"));
		if (!/^\d+\.\d+$/.test(event.ts) || !dir.startsWith(inboundRoot + sep)) {
			this.log.warn("attachment_bad_ts", { channel: event.channel, files: files.length });
			return [`[첨부 실패: ${files.length}개 — 메시지 ts가 올바르지 않아 저장하지 않았습니다]`];
		}
		// Downloads run in parallel: destinations are per-file (fileKey hash) and downloadAttachment writes through a
		// unique tmp path per call, so nothing collides, and Promise.all preserves the note order. Worst-case
		// turn-start latency is the slowest single file instead of the sum of all of them.
		const notes = await Promise.all(
			files.slice(0, MAX_INBOUND_FILES).map((file) => this.#saveAttachment(file, event, dir)),
		);
		if (files.length > MAX_INBOUND_FILES) {
			notes.push(`[첨부 생략: ${files.length - MAX_INBOUND_FILES}개 — 메시지당 최대 ${MAX_INBOUND_FILES}개]`);
		}
		return notes;
	}

	/** Downloads one file into `dir` (`<mediaRoot>/inbound/<ts>/`); failures become a notice line, never a dropped message. */
	#saveAttachment(file: SlackInboundFile, event: SlackMessageEvent, dir: string): Promise<string> {
		return saveInboundAttachment({
			file: {
				id: file.id,
				name: file.name,
				mimetype: file.mimetype,
				url: file.url_private_download ?? file.url_private,
			},
			dir,
			where: { channel: event.channel, ts: event.ts },
			log: this.log,
			download: (args) => this.call("downloadAttachment", () => this.transport.downloadAttachment(args)),
		});
	}

	private async acknowledge(event: SlackMessageEvent, originKey: string): Promise<void> {
		try {
			await this.call("reactions.add", () =>
				this.transport.addReaction({ channel: event.channel, timestamp: event.ts, name: "eyes" }),
			);
			const ackMs = Math.max(0, Math.round(this.clock.now() - Number(event.ts) * 1000));
			this.log.info("inbound_ack", { origin: originKey, ts: event.ts, ack_ms: ackMs });
		} catch (err) {
			this.log.warn("ack_failed", { origin: originKey, ts: event.ts, error: errorText(err) });
		}
	}

	// ---- slash commands and button clicks ----

	async handleSlash(payload: SlackSlashPayload): Promise<SlashAck | undefined> {
		if (!isOwner(payload.user_id, this.ownerUserId)) {
			this.log.warn("command_denied", { command: payload.command, user: payload.user_id });
			return { response_type: "ephemeral", text: DENIED_TEXT };
		}
		const command = SLASH_COMMANDS[payload.command];
		if (command === undefined) return { response_type: "ephemeral", text: `알 수 없는 명령: ${payload.command}` };
		const isDm = payload.channel_id.startsWith("D");
		if (!isDm && !/^[CG]/.test(payload.channel_id)) {
			return { response_type: "ephemeral", text: "이 명령은 봇과의 DM이나 봇이 초대된 채널에서만 쓸 수 있습니다." };
		}
		try {
			const text = await this.core.onCommand({
				command,
				arg: (payload.text ?? "").trim(),
				originKey: isDm ? `slack/dm/${payload.channel_id}` : `slack/ch/${payload.channel_id}`,
				channel: payload.channel_id,
				userId: payload.user_id,
			});
			return text === undefined ? undefined : { response_type: "ephemeral", text };
		} catch (err) {
			this.log.error("command_failed", { command: payload.command, error: errorText(err) });
			return { response_type: "ephemeral", text: "명령 처리에 실패했습니다. 로그를 확인하세요." };
		}
	}

	async handleBlockAction(payload: SlackBlockActionPayload): Promise<void> {
		try {
			if (!isOwner(payload.user.id, this.ownerUserId)) {
				this.log.warn("action_denied", { user: payload.user.id });
				if (payload.channel) {
					await this.transport.postEphemeral({
						channel: payload.channel.id,
						user: payload.user.id,
						text: DENIED_TEXT,
					});
				}
				return;
			}
			for (const action of payload.actions) {
				await this.core.onAction({
					actionId: action.action_id,
					value: action.value,
					userId: payload.user.id,
					channel: payload.channel?.id,
					messageTs: payload.message?.ts,
				});
			}
		} catch (err) {
			this.log.error("action_failed", { error: errorText(err) });
		}
	}

	// ---- status message ----

	/** Registers the thread with the shared tracker (the 👀 ack and the status message run inside it). */
	private beginStatus(
		threadRef: string,
		channel: string,
		root: string,
		event: SlackMessageEvent,
		originKey: string,
		showStatus: boolean,
	): Promise<void> {
		return this.#status.begin(threadRef, {
			channel,
			root,
			reaction: { channelId: event.channel, messageId: event.ts },
			showStatus,
			setup: this.acknowledge(event, originKey),
		});
	}

	/** Called by the daemon on a timer. Updates each running status at most once per interval; finishes pending finals. */
	async tick(): Promise<void> {
		await this.#status.tick();
	}

	/** The daemon reports a silent (or resumed) turn: the running status text switches at once, outside the 15s cadence. */
	async setStalled(threadRef: string, stalled: boolean): Promise<void> {
		await this.#status.setStalled(threadRef, stalled);
	}

	/** The daemon reports the turn's progress (tool calls, to-do list, steers, retries). */
	async setProgress(threadRef: string, progress: TurnProgress): Promise<void> {
		await this.#status.setProgress(threadRef, progress);
	}

	/**
	 * Marks the turn finished: the status message is deleted (`delete`: the answer carries the footer) or becomes
	 * ✅/⚠️ (`update`), 👀 is removed, ✅/⚠️ reaction added. Retried by tick() under a rate limit.
	 */
	async finishStatus(threadRef: string, outcome: FinalOutcome, action: "delete" | "update" = "update"): Promise<void> {
		await this.#status.finish(threadRef, outcome, action);
	}

	/** Posts the thread's `⏳` line; a refused post is one warn line and leaves the thread without one. */
	async #createStatus(entry: StatusEntry, text: string): Promise<void> {
		try {
			const posted = await this.call("chat.postMessage", () =>
				this.transport.postMessage({ channel: entry.channel, threadTs: entry.root, text }),
			);
			entry.statusChannel = entry.channel;
			entry.statusId = posted.ts;
		} catch (err) {
			this.log.warn("status_create_failed", { thread: threadRefOf(entry.channel, entry.root), error: errorText(err) });
		}
	}

	/** `true`: rate limited, the tracker retries on a later tick. A refusal is one warn line and `false`. */
	async #editStatus(entry: StatusEntry, text: string, final: boolean): Promise<boolean> {
		const { statusChannel, statusId } = entry;
		if (statusChannel === undefined || statusId === undefined) return false;
		try {
			await this.call("chat.update", () =>
				this.transport.updateMessage({ channel: statusChannel, ts: statusId, text }),
			);
			return false;
		} catch (err) {
			if (err instanceof BlockedError || err instanceof SlackRateLimitedError) return true;
			this.log.warn(final ? "status_final_failed" : "status_update_failed", {
				thread: threadRefOf(entry.channel, entry.root),
				error: errorText(err),
			});
			return false;
		}
	}

	/** `true`: rate limited, tick() deletes again. A refusal turns the finish into an update of the final label. */
	async #removeStatus(entry: StatusEntry): Promise<boolean> {
		const { statusChannel, statusId } = entry;
		if (statusChannel === undefined || statusId === undefined) return false;
		try {
			await this.call("chat.delete", () => this.transport.deleteMessage({ channel: statusChannel, ts: statusId }));
			return false;
		} catch (err) {
			if (err instanceof BlockedError || err instanceof SlackRateLimitedError) return true;
			this.log.warn("status_delete_failed", { thread: threadRefOf(entry.channel, entry.root), error: errorText(err) });
			entry.finalAction = "update";
			return false;
		}
	}

	/** Returns true when the step must be retried later (rate limited). Other errors (no_reaction, already_reacted) are final. */
	async #swapReaction(method: string, fn: () => Promise<void>): Promise<boolean> {
		try {
			await this.call(method, fn);
			return false;
		} catch (err) {
			if (err instanceof BlockedError || err instanceof SlackRateLimitedError) return true;
			this.log.info("reaction_skipped", { method, error: errorText(err) });
			return false;
		}
	}

	// ---- deliveries ----

	/**
	 * Claims due deliveries and posts them (the shared `DeliveryPump`). Does nothing while chat.postMessage is rate
	 * limited; a 429 mid-batch sends the rest of the batch back unsent to wait for the same block. Returns how many were
	 * confirmed.
	 */
	pumpDeliveries(): Promise<number> {
		return this.#pump.pump();
	}

	/** Back to pending until chat.postMessage's block ends; `sent` messages of it are already in Slack. */
	#deferred(err: unknown, sent: number, replyTs?: string): DeliverySendResult {
		return {
			kind: "deferred",
			error: err,
			retry: {
				at: this.#gate.untilOf("chat.postMessage") ?? this.clock.now(),
				sentParts: sent,
				...(replyTs === undefined ? {} : { replyTs }),
			},
		};
	}

	private async sendDelivery(delivery: DeliveryItem): Promise<DeliverySendResult> {
		const target = parseThreadRef(delivery.threadRef);
		if (!target) {
			return {
				kind: "failed",
				error: `invalid thread_ref ${delivery.threadRef}`,
				outcome: "definitive",
				sentParts: 0,
			};
		}
		const links = /\{\{thread-link:([A-Z0-9]+):([0-9.]+)\}\}/g;
		const body = await resolveThreadLinks(delivery.body, links, this.log, (channel, ts) =>
			this.call("chat.getPermalink", () => this.transport.getPermalink({ channel, ts })),
		);
		// The answer's own thread loses its status message below, so the elapsed time and tool count move under it.
		const footer = answerFooter(delivery, (threadRef, outcome) => this.#status.footer(threadRef, outcome));
		let path = this.#deliveryPaths.get(delivery.deliveryId) ?? (this.#markdownBlocksOff ? "plain" : "markdown");
		let parts: ReadonlyArray<{
			text: string;
			blocks?: readonly unknown[];
			attachments?: readonly SlackAttachment[];
			card?: CardFallback;
		}>;
		for (;;) {
			const markdown =
				path === "markdown"
					? renderMarkdownParts(body, delivery.redelivered, footer, {
							names: this.#mentionNames(),
							monitorHeader: delivery.originKey.startsWith(MONITOR_ORIGIN_PREFIX),
							cards: true,
							charts: !this.#chartBlocksOff,
						})
					: undefined;
			if (markdown?.cardIssues !== undefined) {
				this.log.warn("card_spec_invalid", {
					id: delivery.deliveryId,
					issues: markdown.cardIssues.slice(0, 5).map((issue) => issue.slice(0, 200)),
				});
			}
			if (markdown === undefined) path = "plain";
			parts = markdown ?? renderParts(body, delivery.redelivered, footer).map((text) => ({ text }));
			this.#deliveryPaths.set(delivery.deliveryId, path);
			// A rate-limited earlier send already posted the first `sent` messages: resume after them.
			let sent = Math.min(delivery.sentParts ?? 0, parts.length);
			// A top-level answer is one message: parts 2+ reply under part 1 instead of becoming further top-level posts.
			let threadTs =
				target.threadTs === TOP_LEVEL_TS ? (sent > 0 ? (delivery.replyTs ?? undefined) : undefined) : target.threadTs;
			try {
				const post = (text: string, blocks: readonly unknown[] | undefined, attachments?: readonly SlackAttachment[]) =>
					this.call("chat.postMessage", () =>
						this.transport.postMessage({
							channel: target.channel,
							text,
							...(threadTs === undefined ? {} : { threadTs }),
							...(blocks === undefined ? {} : { blocks }),
							...(attachments === undefined ? {} : { attachments }),
						}),
					);
				// Whether a text part of this answer is already in Slack as a `markdown` block, and whether text parts now go
				// without blocks. Neither changes the parts, so a resume posts the same messages in the same order.
				let markdownPosted = parts.slice(0, sent).some((part) => part.card === undefined);
				let plainText = this.#markdownBlocksOff;
				for (const part of parts.slice(sent)) {
					let posted: { ts: string };
					if (part.card !== undefined) {
						posted = await this.#postCard(delivery.deliveryId, sent, part, part.card, post);
					} else if (plainText) {
						posted = await post(part.text, undefined);
					} else {
						try {
							posted = await post(part.text, part.blocks);
						} catch (err) {
							// Only cards are up (the first part's refusal starts over plain below): this part goes once
							// without blocks, the cards are not resent, and so does every later text part and answer.
							const refusedAfterCards =
								path === "markdown" &&
								sent > 0 &&
								!markdownPosted &&
								err instanceof SlackCallError &&
								err.kind === "definitive" &&
								/invalid_blocks|invalid_arguments/.test(errorText(err));
							if (!refusedAfterCards) throw err;
							if (!this.#markdownBlocksOff) {
								this.#markdownBlocksOff = true;
								this.log.warn("markdown_blocks_disabled", { id: delivery.deliveryId, error: errorText(err) });
							}
							plainText = true;
							posted = await post(part.text, undefined);
						}
						markdownPosted = !plainText;
					}
					if (target.threadTs === TOP_LEVEL_TS) threadTs ??= posted.ts;
					sent += 1;
				}
				break;
			} catch (err) {
				// Slack answered "later" for this message: it and the ones after it were not posted.
				if (err instanceof BlockedError || err instanceof SlackRateLimitedError) {
					return this.#deferred(err, sent, target.threadTs === TOP_LEVEL_TS ? threadTs : undefined);
				}
				const definitive = sent === 0 && err instanceof SlackCallError && err.kind === "definitive";
				const refused = path === "markdown" && /invalid_blocks|invalid_arguments/.test(errorText(err));
				if (refused && definitive) {
					// Nothing of this answer is in Slack yet: it starts over on the plain path, and so does every later one.
					if (!this.#markdownBlocksOff) {
						this.#markdownBlocksOff = true;
						this.log.warn("markdown_blocks_disabled", { id: delivery.deliveryId, error: errorText(err) });
					}
					path = "plain";
					continue;
				}
				if (refused) {
					this.log.warn("markdown_blocks_rejected_midway", {
						id: delivery.deliveryId,
						sent_parts: sent,
						error: errorText(err),
					});
				}
				this.#deliveryPaths.delete(delivery.deliveryId);
				return {
					kind: "failed",
					error: errorText(err),
					outcome: definitive ? "definitive" : "ambiguous",
					sentParts: sent,
				};
			}
		}
		this.#deliveryPaths.delete(delivery.deliveryId);
		return { kind: "sent", parts: parts.length, path };
	}

	/** After the confirm or once the answer is given up: the shared status finish over this adapter's statuses. */
	#finishDelivered(delivery: DeliveryItem, result: "sent" | "undelivered"): Promise<void> {
		return finishDeliveryStatus(delivery, result, {
			finishStatus: (threadRef, outcome, action) => this.finishStatus(threadRef, outcome, action),
			tracks: (threadRef) => this.#status.tracks(threadRef),
		});
	}

	/**
	 * Posts a card part. A definitive `invalid_blocks`/`invalid_arguments` refusal is retried at once, never touching
	 * `#markdownBlocksOff`: a card with a `tone` first goes as its coloured attachment (`attachment`), then as the same
	 * blocks at the top level without the colour (`top_blocks`); a card with a native chart next goes with ASCII charts
	 * (`ascii`, inside the coloured attachment for a toned card; turning `#chartBlocksOff` on, so later cards and a resume
	 * start there), then any card as its fence's code block without blocks. The text step's error, and any other error,
	 * goes to the caller's catch.
	 */
	async #postCard<T>(
		id: number,
		index: number,
		part: { text: string; blocks?: readonly unknown[]; attachments?: readonly SlackAttachment[] },
		card: CardFallback,
		post: (
			text: string,
			blocks: readonly unknown[] | undefined,
			attachments?: readonly SlackAttachment[],
		) => Promise<T>,
	): Promise<T> {
		type Step = {
			step: "blocks" | "attachment" | "top_blocks" | "ascii";
			blocks: readonly unknown[] | undefined;
			attachments?: readonly SlackAttachment[];
		};
		const color = part.attachments?.[0]?.color;
		const steps: Step[] = [];
		// Charts turned off by an earlier card of this answer: its ASCII form goes first.
		if (card.asciiBlocks === undefined || !this.#chartBlocksOff) {
			if (part.attachments === undefined) steps.push({ step: "blocks", blocks: part.blocks });
			else {
				steps.push({ step: "attachment", blocks: undefined, attachments: part.attachments });
				steps.push({ step: "top_blocks", blocks: part.blocks });
			}
		}
		if (card.asciiBlocks !== undefined) {
			steps.push(
				color === undefined
					? { step: "ascii", blocks: card.asciiBlocks }
					: { step: "ascii", blocks: undefined, attachments: [{ color, blocks: card.asciiBlocks }] },
			);
		}
		for (const { step, blocks, attachments } of steps) {
			try {
				// Without top-level blocks Slack shows `text` above the attachment: the card would read twice. The
				// notification text moves into the attachment's `fallback`.
				if (attachments !== undefined) {
					return await post(
						"",
						blocks,
						attachments.map((attachment) => ({ ...attachment, fallback: part.text })),
					);
				}
				return await post(part.text, blocks, attachments);
			} catch (err) {
				const refused =
					err instanceof SlackCallError &&
					err.kind === "definitive" &&
					/invalid_blocks|invalid_arguments/.test(errorText(err));
				if (!refused) throw err;
				this.log.warn("card_blocks_rejected", { id, part: index, step, error: errorText(err) });
				// The last native-chart step refused: charts are what Slack would not take.
				if ((step === "blocks" || step === "top_blocks") && card.asciiBlocks !== undefined && !this.#chartBlocksOff) {
					this.#chartBlocksOff = true;
					this.log.warn("card_chart_blocks_disabled", { id, error: errorText(err) });
				}
			}
		}
		return post(card.text, undefined);
	}
}
