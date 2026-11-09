import type { Logger } from "../log";
import { redact } from "../redact";
import { type HistoryMessage, SlackCallError, type SlackMessageEvent, type SlackTransport } from "./transport";

/** How far back the very first pass reaches when a target has no watermark (upstream: 24h bounded bootstrap). */
export const BOOTSTRAP_LOOKBACK_MS = 24 * 60 * 60_000;
export const PAGE_LIMIT = 200;
export const MAX_PAGES = 10;
/** Definitive per-message failures before it is dead-lettered and skipped (upstream: 3). */
export const MAX_MESSAGE_ATTEMPTS = 3;
/** A message ts further than this past "now" is treated as clock skew and never moves a watermark. */
const FUTURE_TS_SLACK_S = 300;
/** Unreadable-channel strikes before the target is skipped until the daemon restarts (upstream: 3). */
export const QUARANTINE_ATTEMPTS = 3;

export interface ChannelTarget {
	channel: string;
	kind: "im" | "channel";
}

export interface ThreadTarget {
	channel: string;
	rootTs: string;
}

/** Backfill watermarks live in the ledger, not in a sidecar file (ompbot keeps all state in SQLite). */
export interface CursorStore {
	getCursor(cursorKey: string): string | undefined;
	setCursor(cursorKey: string, lastTs: string): void;
	deleteCursor(cursorKey: string): void;
}

export interface BackfillDeps {
	transport: SlackTransport;
	/** The adapter's live ingest path; the outcome decides watermark movement. */
	ingest(event: SlackMessageEvent): Promise<"recorded" | "duplicate" | "dropped">;
	notifier(channel: string, text: string): Promise<void>;
	cursors: CursorStore;
	log: Logger;
	now: number;
	botUserId: string;
	channels: ChannelTarget[];
	threads: ThreadTarget[];
	/** Test overrides for the scan budget. */
	pageLimit?: number;
	maxPages?: number;
}

export interface TargetSummary {
	key: string;
	scanned: number;
	recovered: number;
	truncated: boolean;
	skipped: boolean;
}

export interface BackfillSummary {
	targets: TargetSummary[];
	recovered: number;
	failed: number;
}

/** Slack ts compare without float precision loss: integer part, then fraction padded to equal length. */
export function compareSlackTs(a: string, b: string): number {
	const [aSec = "", aFrac = ""] = a.split(".");
	const [bSec = "", bFrac = ""] = b.split(".");
	if (aSec.length !== bSec.length) return aSec.length < bSec.length ? -1 : 1;
	if (aSec !== bSec) return aSec < bSec ? -1 : 1;
	const width = Math.max(aFrac.length, bFrac.length, 1);
	const aPad = aFrac.padEnd(width, "0");
	const bPad = bFrac.padEnd(width, "0");
	return aPad < bPad ? -1 : aPad === bPad ? 0 : 1;
}

export function channelCursorKey(channel: string): string {
	return `ch:${channel}`;
}

export function threadCursorKey(channel: string, rootTs: string): string {
	return `thr:${channel}:${rootTs}`;
}

/** Contination marker for a truncated pass: the oldest ts the truncated scan reached. */
export function continuationKey(key: string): string {
	return `cont:${key}`;
}

function maxSlackTs(a: string | undefined, b: string | undefined): string | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return compareSlackTs(a, b) >= 0 ? a : b;
}

function isBotMessage(message: HistoryMessage, botUserId: string): boolean {
	return message.bot_id !== undefined || message.user === botUserId;
}

/** Slack refuses read calls sent as JSON bodies; @slack/web-api form-encodes for us (the 2026-09-17 incident). */
function isUnreadableChannelError(error: unknown): boolean {
	if (!(error instanceof SlackCallError) || error.kind !== "definitive") return false;
	// thread_not_found: the thread's root was deleted. Like a left channel it never comes back, so the thread target
	// takes the same strikes and quarantine instead of a warning on every pass until it leaves the 7-day window.
	return /slack_platform_error:(channel_not_found|not_in_channel|missing_scope|is_archived|invalid_auth|thread_not_found)/.test(
		error.message,
	);
}

interface ScanResult {
	/** Ascending by ts. */
	messages: HistoryMessage[];
	/** True when the page budget ran out before the scan reached the watermark (or the bootstrap floor). */
	truncated: boolean;
	/** True when a message at or below the watermark was seen: everything older is already covered. */
	reachedWatermark: boolean;
	/** Lowest ts seen in this scan (the continuation point when truncated). */
	oldestSeen: string | undefined;
}

export interface ScanPageArgs {
	/** Upper ts bound: set on the first page of a continuation pass (upstream: `latest=olderThan`). */
	latest?: string;
	cursor?: string;
}

/**
 * Walks history newest-first via cursor pagination until the watermark is crossed, the page budget is spent, or
 * Slack runs out of messages. Returns the window sorted ascending, ready for in-order ingest.
 */
async function scanNewestFirst(
	fetchPage: (args: ScanPageArgs) => Promise<{ messages: HistoryMessage[]; nextCursor?: string | undefined }>,
	watermark: string,
	maxPages: number,
	continuation: string | undefined,
): Promise<ScanResult> {
	const messages: HistoryMessage[] = [];
	let cursor: string | undefined;
	let truncated = false;
	let reachedWatermark = false;
	for (let page = 0; page < maxPages; page++) {
		// A continuation pass keeps its latest bound on EVERY page: dropping it after page one would re-expand the
		// window and the gap would never close.
		const args = continuation !== undefined ? { latest: continuation, ...(cursor ? { cursor } : {}) } : { cursor };
		const result = await fetchPage(args);
		for (const message of result.messages) {
			if (compareSlackTs(message.ts, watermark) <= 0) {
				reachedWatermark = true;
				break;
			}
			messages.push(message);
		}
		if (reachedWatermark || result.nextCursor === undefined) break;
		cursor = result.nextCursor;
		if (page === maxPages - 1) truncated = true;
	}
	messages.sort((a, b) => compareSlackTs(a.ts, b.ts));
	const oldestSeen = messages[0]?.ts;
	if (!truncated && (oldestSeen === undefined || compareSlackTs(oldestSeen, watermark) < 0)) {
		// The window ends at or below the watermark: everything down to it is covered.
		reachedWatermark = true;
	}
	return { messages, truncated, reachedWatermark, oldestSeen };
}

/**
 * Thread replies come oldest-first with the (old) root leading the first page, so the newest-first early exit would
 * stop on the root. Walks forward instead, skipping the root and anything at/below the watermark. A spent page budget
 * leaves the NEWER replies for the next pass, which is safe because the handled prefix advances the watermark.
 */
async function scanAscending(
	fetchPage: (args: ScanPageArgs) => Promise<{ messages: HistoryMessage[]; nextCursor?: string | undefined }>,
	watermark: string,
	maxPages: number,
	rootTs: string,
): Promise<ScanResult> {
	const messages: HistoryMessage[] = [];
	let cursor: string | undefined;
	let truncated = false;
	for (let page = 0; page < maxPages; page++) {
		const result = await fetchPage(cursor === undefined ? {} : { cursor });
		for (const message of result.messages) {
			if (message.ts === rootTs || compareSlackTs(message.ts, watermark) <= 0) continue;
			messages.push(message);
		}
		if (result.nextCursor === undefined) break;
		cursor = result.nextCursor;
		if (page === maxPages - 1) truncated = true;
	}
	messages.sort((a, b) => compareSlackTs(a.ts, b.ts));
	return { messages, truncated, reachedWatermark: !truncated, oldestSeen: messages[0]?.ts };
}

const TRANSIENT_STORE_ERROR = /SQLITE_(BUSY|LOCKED|FULL|IOERR)/;

/**
 * Whether an ingest failure is a per-message failure that counts toward the dead-letter budget. Transient Slack errors
 * and transient ledger errors (busy/locked/full/io) stay retryable without counting: they are not the message's fault.
 */
function countsTowardDeadLetter(error: unknown): boolean {
	if (error instanceof SlackCallError) return error.kind === "definitive";
	const code = (error as { code?: unknown } | null)?.code;
	if (typeof code === "string" && TRANSIENT_STORE_ERROR.test(code)) return false;
	return !TRANSIENT_STORE_ERROR.test(error instanceof Error ? error.message : String(error));
}

async function backfillTarget(input: {
	key: string;
	channel: string;
	/** Set for thread targets: replies are scanned oldest-first and the root itself is never ingested here. */
	rootTs?: string;
	deps: BackfillDeps;
	watermarkKey: string;
	/** Bootstrap floor for targets with no watermark yet (`now - 24h` in Slack seconds). */
	bootstrapFloor: string;
	scan: (page: ScanPageArgs) => Promise<{ messages: HistoryMessage[]; nextCursor?: string | undefined }>;
	toEvent: (message: HistoryMessage) => SlackMessageEvent;
	notice: (recovered: number) => { channel: string; text: string } | undefined;
	attempts: Map<string, number>;
	quarantine: Map<string, number>;
}): Promise<TargetSummary> {
	const { deps } = input;
	const summary: TargetSummary = { key: input.key, scanned: 0, recovered: 0, truncated: false, skipped: false };
	const storedWatermark = deps.cursors.getCursor(input.watermarkKey);
	const watermark = storedWatermark ?? input.bootstrapFloor;
	const continuation = deps.cursors.getCursor(continuationKey(input.key));

	let scan: ScanResult;
	try {
		// input.scan matches fetchPage exactly; a continuation pass scans BELOW the previous window (latest=olderThan).
		const maxPages = deps.maxPages ?? MAX_PAGES;
		scan =
			input.rootTs === undefined
				? await scanNewestFirst(input.scan, watermark, maxPages, continuation)
				: await scanAscending(input.scan, watermark, maxPages, input.rootTs);
		// Strikes count CONSECUTIVE unreadable passes: a good read (bot re-invited) starts the count over.
		input.quarantine.delete(input.key);
	} catch (error) {
		if (isUnreadableChannelError(error)) {
			const strikes = (input.quarantine.get(input.key) ?? 0) + 1;
			input.quarantine.set(input.key, strikes);
			if (strikes >= QUARANTINE_ATTEMPTS) {
				summary.skipped = true;
				deps.log.warn("backfill_quarantined", { target: input.key, strikes, error: String(error) });
			} else {
				deps.log.warn("backfill_read_failed", { target: input.key, strikes, error: String(error) });
			}
		} else {
			deps.log.warn("backfill_read_failed", { target: input.key, error: String(error) });
		}
		summary.truncated = true; // retry on the next trigger; nothing advanced
		return summary;
	}
	summary.scanned = scan.messages.length;

	// Ingest oldest-first. `lastHandled` only moves across messages that were fully processed (or dead-lettered),
	// so the watermark never skips over an unhandled message.
	// A message stamped past `now + FUTURE_TS_SLACK_S` (clock skew, bad data) is still ingested but never becomes the
	// watermark: every later genuine message would sit below it and be invisible to all future passes.
	const futureCutoff = String(Math.floor(deps.now / 1000) + FUTURE_TS_SLACK_S);
	let lastHandled: string | undefined;
	let futureSeen = false;
	for (const message of scan.messages) {
		const stopAt = lastHandled;
		if (compareSlackTs(message.ts, futureCutoff) > 0) {
			futureSeen = true;
		} else {
			lastHandled = message.ts;
		}
		if (isBotMessage(message, deps.botUserId)) continue;
		const attemptKey = `${input.key}:${message.ts}`;
		try {
			const outcome = await input.deps.ingest(input.toEvent(message));
			if (outcome === "recorded") summary.recovered += 1;
			input.attempts.delete(attemptKey);
		} catch (error) {
			if (countsTowardDeadLetter(error)) {
				const attemptCount = (input.attempts.get(attemptKey) ?? 0) + 1;
				input.attempts.set(attemptKey, attemptCount);
				if (attemptCount >= MAX_MESSAGE_ATTEMPTS) {
					input.attempts.delete(attemptKey);
					deps.log.error("backfill_dead_letter", { target: input.key, ts: message.ts, error: String(error) });
				} else {
					deps.log.warn("backfill_message_failed", {
						target: input.key,
						ts: message.ts,
						attempts: attemptCount,
						error: String(error),
					});
					summary.truncated = true;
					lastHandled = stopAt;
					break;
				}
			} else {
				deps.log.warn("backfill_message_retryable", { target: input.key, ts: message.ts, error: String(error) });
				summary.truncated = true;
				lastHandled = stopAt;
				break;
			}
		}
	}
	if (futureSeen) deps.log.warn("backfill_future_ts", { target: input.key, cutoff: futureCutoff });
	const ingestFailed = summary.truncated;
	// Highest ts handled by earlier truncated passes of a continuation chain. The chain only scans BELOW its marker,
	// so when it closes the watermark must jump to this (not to the last window's newest), or the gap is re-ingested.
	const hiKey = `hi:${input.key}`;

	if (input.rootTs !== undefined) {
		// Oldest-first scan: the handled prefix is contiguous with the watermark, so it advances even when the pass
		// stopped early; the newer replies are simply picked up by the next pass.
		if (lastHandled !== undefined) {
			deps.cursors.setCursor(input.watermarkKey, lastHandled);
		} else if (!ingestFailed && !scan.truncated && storedWatermark === undefined) {
			deps.cursors.setCursor(input.watermarkKey, input.bootstrapFloor);
		}
		summary.truncated = ingestFailed || scan.truncated;
	} else if (ingestFailed) {
		// Messages above the failure are unhandled and the window sits above the unscanned gap: move nothing, so the
		// next pass re-reads this same window (already-recorded rows come back as duplicates).
		summary.truncated = true;
	} else if (scan.truncated && !scan.reachedWatermark) {
		summary.truncated = true;
		if (scan.oldestSeen !== undefined) {
			deps.cursors.setCursor(continuationKey(input.key), scan.oldestSeen);
			const high = maxSlackTs(lastHandled, deps.cursors.getCursor(hiKey));
			if (high !== undefined) deps.cursors.setCursor(hiKey, high);
		}
	} else {
		// Window fully handled down to the watermark: the watermark jumps over the whole chain, not just this window.
		const next = maxSlackTs(lastHandled, deps.cursors.getCursor(hiKey));
		if (next !== undefined) {
			deps.cursors.setCursor(input.watermarkKey, next);
		} else if (storedWatermark === undefined) {
			// Empty window on the first pass: store the bootstrap floor so the next pass only looks at newer messages.
			deps.cursors.setCursor(input.watermarkKey, input.bootstrapFloor);
		}
		deps.cursors.deleteCursor(continuationKey(input.key));
		deps.cursors.deleteCursor(hiKey);
	}

	if (summary.recovered > 0) {
		const notice = input.notice(summary.recovered);
		if (notice !== undefined) {
			try {
				await deps.notifier(notice.channel, notice.text);
			} catch (error) {
				// The notice is best effort: the messages are already handled and the watermark moved.
				deps.log.warn("backfill_notice_failed", { target: input.key, error: String(error) });
			}
		}
	}
	return summary;
}

/**
 * One backfill pass over every channel and thread target. Watermarks only advance over fully handled windows;
 * truncated passes leave a continuation marker so the next pass resumes below the unscanned gap (upstream
 * semantics: live traffic never advances a watermark, and a truncated scan never does either). `state` carries
 * per-message attempt budgets and channel quarantine strikes ACROSS passes; pass it from the long-lived runner.
 */
export async function runBackfillPass(
	deps: BackfillDeps,
	state: { attempts: Map<string, number>; quarantine: Map<string, number> } = {
		attempts: new Map(),
		quarantine: new Map(),
	},
): Promise<BackfillSummary> {
	const { attempts, quarantine } = state;
	const targets: TargetSummary[] = [];
	const bootstrapFloor = String(Math.floor((deps.now - BOOTSTRAP_LOOKBACK_MS) / 1000));

	for (const target of deps.channels) {
		const key = channelCursorKey(target.channel);
		if ((quarantine.get(key) ?? 0) >= QUARANTINE_ATTEMPTS) {
			targets.push({ key, scanned: 0, recovered: 0, truncated: false, skipped: true });
			continue;
		}
		targets.push(
			await backfillTarget({
				key,
				channel: target.channel,
				deps,
				watermarkKey: key,
				bootstrapFloor,
				scan: (page) =>
					deps.transport.conversationsHistory({
						channel: target.channel,
						oldest: deps.cursors.getCursor(key) ?? bootstrapFloor,
						...(page.latest ? { latest: page.latest } : {}),
						...(page.cursor ? { cursor: page.cursor } : {}),
						limit: deps.pageLimit ?? PAGE_LIMIT,
					}),
				toEvent: (message) => ({
					type: "message",
					channel: target.channel,
					channel_type: target.kind,
					user: message.user,
					bot_id: message.bot_id,
					text: message.text,
					ts: message.ts,
					thread_ts: message.thread_ts,
					subtype: message.subtype,
					files: message.files,
					attachments: message.attachments,
				}),
				notice: (recovered) => ({
					channel: target.channel,
					text: `⏬ 봇이 응답하지 못한 동안 도착한 메시지 ${recovered}건을 처리합니다`,
				}),
				attempts,
				quarantine,
			}),
		);
	}

	for (const thread of deps.threads) {
		const key = threadCursorKey(thread.channel, thread.rootTs);
		if ((quarantine.get(key) ?? 0) >= QUARANTINE_ATTEMPTS) {
			targets.push({ key, scanned: 0, recovered: 0, truncated: false, skipped: true });
			continue;
		}
		// The channel read already failed as unreadable (left, archived, deleted): its threads would fail the same way,
		// one warning each. Follow the channel's strikes instead — retried while it is striking, skipped once it is
		// quarantined, read again as soon as a channel read succeeds (which clears the strikes).
		const channelStrikes = quarantine.get(channelCursorKey(thread.channel)) ?? 0;
		if (channelStrikes > 0) {
			const skipped = channelStrikes >= QUARANTINE_ATTEMPTS;
			targets.push({ key, scanned: 0, recovered: 0, truncated: !skipped, skipped });
			continue;
		}
		targets.push(
			await backfillTarget({
				key,
				channel: thread.channel,
				rootTs: thread.rootTs,
				deps,
				watermarkKey: key,
				bootstrapFloor,
				scan: (page) =>
					deps.transport.conversationsReplies({
						channel: thread.channel,
						ts: thread.rootTs,
						oldest: deps.cursors.getCursor(key) ?? bootstrapFloor,
						...(page.latest ? { latest: page.latest } : {}),
						...(page.cursor ? { cursor: page.cursor } : {}),
						limit: deps.pageLimit ?? PAGE_LIMIT,
					}),
				toEvent: (message) => ({
					type: "message",
					channel: thread.channel,
					channel_type: "channel",
					user: message.user,
					bot_id: message.bot_id,
					text: message.text,
					ts: message.ts,
					// Replies must land in the parent thread even if Slack omits thread_ts on the reply row.
					thread_ts: thread.rootTs,
					subtype: message.subtype,
					files: message.files,
					attachments: message.attachments,
				}),
				notice: () => undefined, // thread answers surface in the thread itself; no root notice
				attempts,
				quarantine,
			}),
		);
	}

	const recovered = targets.reduce((sum, target) => sum + target.recovered, 0);
	deps.log.info("slack_backfill", {
		targets: targets.length,
		scanned: targets.reduce((sum, target) => sum + target.scanned, 0),
		recovered,
		failed: targets.filter((target) => target.skipped).length,
		truncated: targets.filter((target) => target.truncated).length,
	});
	return { targets, recovered, failed: targets.filter((target) => target.skipped).length };
}

/**
 * Single-flight trigger (upstream RecoveryScheduler): concurrent triggers coalesce into one follow-up pass instead of
 * stacking. The daemon wires `transport.onReady` and startup to `trigger()`.
 */
export class BackfillRunner {
	#running = false;
	#followUp = false;
	#lastRun: Promise<void> = Promise.resolve();
	readonly #state = { attempts: new Map<string, number>(), quarantine: new Map<string, number>() };

	constructor(private readonly buildDeps: () => BackfillDeps) {}

	trigger(): void {
		if (this.#running) {
			this.#followUp = true;
			return;
		}
		this.#running = true;
		this.#lastRun = this.#drain();
	}

	/** Resolves when no pass is in flight and no follow-up is pending (tests and graceful shutdown). */
	waitForIdle(): Promise<void> {
		return this.#lastRun;
	}

	/** Never throws: when building the deps is what failed there is no logger, so fall back to stderr. */
	#reportFailure(error: unknown): void {
		try {
			this.buildDeps().log.error("slack_backfill_failed", { error: String(error) });
		} catch {
			console.error(redact(`[ompbot] slack_backfill_failed: ${String(error)}`));
		}
	}

	async #drain(): Promise<void> {
		try {
			do {
				this.#followUp = false;
				await runBackfillPass(this.buildDeps(), this.#state);
			} while (this.#followUp);
		} catch (error) {
			this.#reportFailure(error);
		} finally {
			this.#running = false;
		}
	}
}
