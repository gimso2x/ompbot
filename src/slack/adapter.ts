import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TurnProgress } from "../core/mailbox";
import {
	isOwner,
	normalizeInbound,
	normalizePeerInbound,
	parseThreadRef,
	THREAD_LINK_PREFIX,
	TOP_LEVEL_TS,
	threadRefOf,
	unescapeSlackText,
} from "../core/normalize";
import {
	COMMAND_TEXT,
	type CommandKind,
	parseCommand,
	parseThreadMuteCommand,
	type ThreadMuteCommand,
} from "../core/types";
import type { Logger } from "../log";
import { MONITOR_ORIGIN_PREFIX } from "../monitors/ledger";
import { scanForInjection } from "../safety/injection";
import {
	type CardFallback,
	formatElapsed,
	HEADER_LIMIT,
	headerBlock,
	type MentionNames,
	plainHeaderText,
	renderMarkdownParts,
	renderParts,
	STALL_STATUS_TEXT,
} from "./format";
import {
	type SlackBlockActionPayload,
	SlackCallError,
	type SlackHandlers,
	type SlackInboundFile,
	type SlackMessageEvent,
	SlackRateLimitedError,
	type SlackReactionEvent,
	type SlackSlashPayload,
	type SlackTransport,
	type SlashAck,
} from "./transport";

export const STATUS_MIN_INTERVAL_MS = 15_000;
/** Longest text of one progress line (a tool call, the current todo item) in the running status message. */
const ACTIVITY_MAX = 60;
/** Posted once in a thread whose peer-input cap was hit; mentions no bot. */
export const PEER_HOP_NOTICE = "피어 대화 상한에 닿았습니다. 이어 가려면 오너가 말해 주세요.";
export const DENIED_TEXT = "권한 없음: 이 봇은 오너만 사용할 수 있습니다.";
/** Inbound attachment budget (hermes-agent parity: images get more room than documents). */
export const MAX_INBOUND_FILES = 6;
export const MAX_INBOUND_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_INBOUND_DOC_BYTES = 20 * 1024 * 1024;
/** Text attachments up to this size are scanned for instruction-like passages. */
const MAX_SCANNED_TEXT_BYTES = 1024 * 1024;
/** Extensions (lowercase, from the file name) scanned as text whatever the mimetype says. */
const SCANNED_TEXT_EXT: Record<string, true> = {
	txt: true,
	md: true,
	csv: true,
	json: true,
	log: true,
	yaml: true,
	yml: true,
	html: true,
	xml: true,
};

const KNOWN_MIME_EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"application/pdf": "pdf",
	"text/plain": "txt",
	"text/markdown": "md",
	"text/csv": "csv",
	"application/zip": "zip",
};

function attachmentExtension(name: string | undefined, mimetype: string | undefined): string {
	const fromName = name === undefined ? undefined : /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase();
	if (fromName !== undefined) return fromName;
	if (mimetype !== undefined && KNOWN_MIME_EXT[mimetype] !== undefined) return KNOWN_MIME_EXT[mimetype];
	if (mimetype?.startsWith("image/"))
		return (
			mimetype
				.slice(6)
				.replace(/[^a-z0-9]/g, "")
				.slice(0, 5) || "bin"
		);
	return "bin";
}

/** What the core receives for an accepted owner message. Structurally what the store's recordInbound needs, plus the thread. */
export interface InboundMessage {
	platformMessageId: string;
	originKey: string;
	text: string;
	threadRef: string;
	ownerVerified: true;
}

/**
 * What the core receives for an accepted peer bot message. Its own type, without `ownerVerified`: it can never be
 * passed where an owner message is expected.
 */
export interface PeerInboundMessage {
	platformMessageId: string;
	originKey: string;
	/** Header and fenced body (see `normalizePeerInbound`). */
	text: string;
	threadRef: string;
	peer: { userId: string; name: string };
}

/** The core's verdict on a peer message: recorded (empty), a redelivery, or dropped (`notice`: post the cap notice now). */
export interface PeerInboundOutcome {
	duplicate?: true;
	dropped?: "peer_in_lane_thread" | "peer_hop_cap";
	notice?: boolean;
}

/** Default per-thread cap on peer input (`peerHopLimit` unset). */
export const DEFAULT_PEER_HOP_LIMIT = { turns: 3, windowMinutes: 30 } as const;

/** Peer bots the adapter accepts (config `peerBots`). */
export type PeerBotList = ReadonlyArray<{ userId: string; name: string }>;

/** The adapter's whole view of the core. Owner input arrives through `onInbound`, peer bot input through `onPeerInbound`. */
export interface CoreSink {
	/**
	 * A peer bot's request. The core decides what the adapter cannot see: a duplicate, a work lane's thread
	 * (`peer_in_lane_thread`) and the thread's hop cap (`peer_hop_cap`; `notice` is true exactly once per cap episode,
	 * the adapter then posts the cap notice).
	 */
	onPeerInbound?(message: PeerInboundMessage, hop: { turns: number; windowMs: number }): PeerInboundOutcome;
	/** `duplicate: true` (Slack redelivery of a message already recorded) suppresses the 👀 and the status message. */
	onInbound(
		message: InboundMessage,
	): Promise<{ duplicate?: boolean } | undefined> | { duplicate?: boolean } | undefined;
	/** Ephemeral reply text; `undefined` sends an empty ack because the answer is posted as its own message. */
	onCommand(command: {
		command: CommandKind;
		/** Text after the slash command (`""` when none). */
		arg: string;
		originKey: string;
		channel: string;
		userId: string;
	}): Promise<string | undefined> | string | undefined;
	onAction(action: {
		actionId: string;
		value?: string | undefined;
		userId: string;
		channel?: string | undefined;
		messageTs?: string | undefined;
	}): Promise<void> | void;
	/**
	 * An owner reply in a thread: if that thread is an approval card's, the core settles the card with the reply
	 * (`settled`), recognises a replay (`duplicate`) or names the asking conversation the reply must reach (`route`).
	 * `undefined`: not an approval card thread — the reply takes the normal inbound path.
	 */
	onCardReply?(reply: {
		threadRef: string;
		platformMessageId: string;
		text: string;
	}): { kind: "settled" } | { kind: "duplicate" } | { kind: "route"; originKey: string } | undefined;
	/** Whether the bot already takes part in this thread, so an unaddressed owner reply in a channel thread counts. */
	knowsThread?(threadRef: string): boolean;
	/** Whether the owner muted this thread with `!shutup`: the bot stays quiet there until a mention or `!unshutup`. */
	isThreadMuted?(threadRef: string): boolean;
	/** Records or clears a thread mute (`!shutup` / `!unshutup` / mention release); idempotent. */
	setThreadMute?(threadRef: string, muted: boolean): void;
	/**
	 * Whether this exact mute-command event was already handled. A mute command never becomes an inbound row (it takes
	 * no turn), so without this a backfill replay of the same `!shutup` event would re-post the 🤫/🔊 notice on every
	 * pass. Pure lookup; `rememberMuteCommand` is the recording half.
	 */
	seenMuteCommand?(platformMessageId: string): boolean;
	/** Durably marks a mute-command event handled after it ran, so replays resolve as duplicates. */
	rememberMuteCommand?(platformMessageId: string): void;
}

export interface DeliveryItem {
	deliveryId: number;
	originKey: string;
	threadRef: string;
	body: string;
	redelivered: boolean;
	/** Other threads whose rows were closed by the same op (steered messages): their status is finished too. */
	finishThreadRefs?: readonly string[] | undefined;
	/** Threads of rows the same op discarded (`queue drop`): their ⏳ ends as `🚫 취소됨` instead of ✅/⚠️. */
	cancelThreadRefs?: readonly string[] | undefined;
	/**
	 * False for output nobody asked for in that thread (a work lane's own report): a thread without a running status
	 * entry is then left alone instead of getting the post-restart ✅ reaction. Default true.
	 */
	finishUntracked?: boolean | undefined;
	/**
	 * A text sent while its turn still runs (interim delivery): the thread's status message and progress keep going,
	 * and the answer gets no elapsed-time footer. Default false.
	 */
	keepStatus?: boolean | undefined;
	/** Messages of this answer a rate-limited earlier send already posted: the send resumes after them. */
	sentParts?: number | undefined;
	/** Top-level answer resumed after part 1: the ts parts 2+ reply under. */
	replyTs?: string | null | undefined;
}

/** Where a rate-limited send stopped and when Slack takes `chat.postMessage` again. */
export interface DeliveryRetry {
	at: number;
	sentParts: number;
	replyTs?: string | undefined;
}

/** Implemented by the daemon on top of the store; the adapter never imports the mailbox or the store. */
export interface DeliverySource {
	claimDue(): Promise<DeliveryItem[]> | DeliveryItem[];
	confirm(deliveryId: number): Promise<void> | void;
	/** `definitive`: nothing was posted (backoff and retry). `ambiguous`: a message may exist (sticky, never auto-resent). */
	fail(deliveryId: number, error: string, outcome: "definitive" | "ambiguous"): Promise<void> | void;
	/** Rate limited (429 or still blocked): nothing more was posted; retry at `retry.at` without counting a failure. */
	defer(deliveryId: number, error: string, retry: DeliveryRetry): Promise<void> | void;
	/**
	 * One Slack message a delivery posted (`part`: its 0-based index in the answer), so a reaction on it finds the turn.
	 * A throw is logged (`delivery_post_record_failed`) and never stops the delivery. Absent: nothing is recorded.
	 */
	recordPost?(post: { channel: string; ts: string; deliveryId: number; part: number }): Promise<void> | void;
	/** The owner added or removed 👍/👎 on a message; the source ignores messages no delivery posted. */
	recordFeedback?(feedback: {
		channel: string;
		ts: string;
		verdict: "up" | "down";
		action: "added" | "removed";
		eventTs: string;
	}): Promise<void> | void;
}

/** 👍/👎 reaction names (a skin tone suffix `::skin-tone-N` dropped) → verdict; any other emoji is no feedback. */
const FEEDBACK_REACTIONS = new Map<string, "up" | "down">([
	["+1", "up"],
	["thumbsup", "up"],
	["-1", "down"],
	["thumbsdown", "down"],
]);

export interface AdapterClock {
	now(): number;
}

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
	statusIntervalMs?: number;
}

/** How a thread's ⏳ status message and 👀 reaction end: normal close, failure, or a cancelled wait. */
type FinalOutcome = "done" | "failed" | "cancelled";

/** One place deciding how each final outcome reads in the status line and which reaction mark it leaves. */
const FINAL_MARKS: Record<FinalOutcome, { label: string; mark: string }> = {
	done: { label: "✅ 완료", mark: "white_check_mark" },
	cancelled: { label: "🚫 취소됨", mark: "x" },
	failed: { label: "⚠️ 실패", mark: "warning" },
};

interface StatusEntry {
	channel: string;
	root: string;
	statusTs: string | undefined;
	startedAt: number;
	lastUpdateAt: number;
	/** Inbound messages carrying our 👀 in this thread. */
	reactionTs: Set<string>;
	/** Settles when the 👀 and the status message creation are done (never rejects). */
	setup: Promise<void>;
	/** False for command threads: they get no `⏳` message. */
	showStatus: boolean;
	final: FinalOutcome | undefined;
	/** The turn has emitted no omp event for the stall window; the status shows `STALL_STATUS_TEXT`. */
	stalled: boolean;
	/** The turn's progress summary (`setProgress`), shown under the first status line. */
	progress: TurnProgress | undefined;
	/** How the status message ends: `delete` once the answer carries its footer, `update` to the final label. */
	finalAction: "delete" | "update";
	statusDone: boolean;
	reactionsDone: boolean;
}

class BlockedError extends Error {}

/** What a single inbound event ended up as (`ingestRecovered` reports this to the backfill). */
export type IngestOutcome = "recorded" | "duplicate" | "dropped";

const SLASH_COMMANDS: Record<string, CommandKind> = Object.fromEntries(
	(Object.entries(COMMAND_TEXT) as Array<[CommandKind, string]>).map(([kind, text]) => [text, kind]),
);

/** Channel types the bot answers in besides the owner DM (public, private and group DMs it was invited to). */
const CHANNEL_TYPES = new Set(["channel", "group", "mpim"]);

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Collapses control characters and line separators so untrusted text cannot start a new prompt line. */
function oneLine(text: string, max: number): string {
	return text
		.replace(/[\p{Cc}\u2028\u2029]+/gu, " ")
		.trim()
		.slice(0, max);
}

/** One progress line: a single line of at most `ACTIVITY_MAX`, never ending in a lone high surrogate. */
function progressLine(text: string): string {
	const cut = oneLine(text, ACTIVITY_MAX);
	return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * The running status message: `⏳ 작업 중 · mm:ss · 도구 N회` (or the stalled text and the elapsed time), then the
 * todo, steer, retry and recent-tool lines; a line whose value is 0 or unknown is left out.
 */
function runningStatusText(stalled: boolean, elapsedMs: number, progress: TurnProgress | undefined): string {
	const tools = progress?.tools ?? 0;
	const head = stalled
		? `${STALL_STATUS_TEXT} · ${formatElapsed(elapsedMs)}`
		: `⏳ 작업 중 · ${formatElapsed(elapsedMs)}${tools > 0 ? ` · 도구 ${tools}회` : ""}`;
	if (progress === undefined) return head;
	const lines = [head];
	const { todo } = progress;
	if (todo !== undefined && todo.total > 0) {
		const current = todo.current === undefined ? "" : progressLine(todo.current);
		lines.push(`📋 ${todo.done}/${todo.total}${current === "" ? "" : ` · ${current}`}`);
	}
	if (progress.steers > 0) lines.push(`📨 추가 메시지 ${progress.steers}건 반영`);
	if (progress.retries > 0) lines.push(`🔁 모델 재시도 ${progress.retries}회`);
	for (const tool of progress.recentTools) {
		const line = progressLine(tool);
		if (line !== "") lines.push(`· ${line}`);
	}
	return lines.join("\n");
}

async function fileExists(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

export class SlackAdapter {
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
	private readonly statusIntervalMs: number;
	private readonly isTaskRoot: ((threadRef: string) => boolean) | undefined;
	private readonly onInboundFailure: (() => void) | undefined;
	private readonly statuses = new Map<string, StatusEntry>();
	private readonly blockedUntil = new Map<string, number>();
	/** Slack refused a `markdown` block once: every later answer takes the plain mrkdwn path until the restart. */
	#markdownBlocksOff = false;
	/** Slack refused a card holding a chart once: every later card draws its charts as ASCII until the restart. */
	#chartBlocksOff = false;
	/** The path a delivery's first attempt chose, so a rate-limited resume counts `sentParts` in the same chunks. */
	readonly #deliveryPaths = new Map<number, "markdown" | "plain">();
	private ready: Promise<string> | undefined;
	#botUserId: string | undefined;

	constructor(options: SlackAdapterOptions) {
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
		this.statusIntervalMs = options.statusIntervalMs ?? STATUS_MIN_INTERVAL_MS;
		this.isTaskRoot = options.isTaskRoot;
		this.onInboundFailure = options.onInboundFailure;
	}

	/** Config reload: the next inbound event follows the new channel policy. */
	setChannelPolicy(policy: {
		mentionFreeChannels?: readonly string[];
		logChannel?: string;
		peerBots?: PeerBotList;
		requireMention?: boolean;
		peerHopLimit?: { turns: number; windowMinutes: number };
	}): void {
		this.mentionFreeChannels = new Set(policy.mentionFreeChannels ?? []);
		this.logChannel = policy.logChannel;
		this.peerBots = policy.peerBots ?? [];
		this.requireMention = policy.requireMention === true;
		this.peerHopLimit = policy.peerHopLimit ?? DEFAULT_PEER_HOP_LIMIT;
	}

	async start(): Promise<void> {
		const handlers: SlackHandlers = {
			message: (event) => this.handleMessage(event),
			reaction: (event) => this.handleReaction(event),
			slash: (payload) => this.handleSlash(payload),
			blockAction: (payload) => this.handleBlockAction(payload),
		};
		this.ready = this.transport.start(handlers).then((r) => r.botUserId);
		this.#botUserId = await this.ready;
	}

	/** The bot's own user id once connected (`<@id>` addresses it in a channel). */
	get botUserId(): string | undefined {
		return this.#botUserId;
	}

	async stop(): Promise<void> {
		await this.transport.stop();
	}

	// ---- Slack API calls with per-method Retry-After blocking ----

	private isBlocked(method: string): boolean {
		const until = this.blockedUntil.get(method);
		return until !== undefined && this.clock.now() < until;
	}

	private async call<T>(method: string, fn: () => Promise<T>): Promise<T> {
		if (this.isBlocked(method)) throw new BlockedError(method);
		try {
			return await fn();
		} catch (err) {
			if (err instanceof SlackRateLimitedError) {
				this.blockedUntil.set(method, this.clock.now() + err.retryAfterMs);
				this.log.warn("slack_rate_limited", { method, retry_after_ms: err.retryAfterMs });
			}
			throw err;
		}
	}

	// ---- inbound messages ----

	async handleMessage(event: SlackMessageEvent): Promise<void> {
		try {
			await this.processMessage(event);
		} catch (err) {
			this.log.error("inbound_failed", { channel: event.channel, ts: event.ts, error: errorText(err) });
			// The swallowed event is invisible to the backfill watermark, so it would wait for the next socket
			// (re)connect; the callback lets the daemon re-reach it through the backfill right away.
			try {
				this.onInboundFailure?.();
			} catch (cbErr) {
				this.log.warn("inbound_failure_callback_failed", { error: errorText(cbErr) });
			}
		}
	}

	private async processMessage(event: SlackMessageEvent): Promise<IngestOutcome> {
		const inChannel = event.channel_type !== undefined && CHANNEL_TYPES.has(event.channel_type);
		if (event.channel_type !== "im" && !inChannel) return "dropped";
		// #log is a ledger, not a conversation: nothing said there reaches omp.
		if (event.channel === this.logChannel) {
			this.log.info("inbound_dropped", { reason: "log_channel", channel: event.channel, ts: event.ts });
			return "dropped";
		}
		const botUserId = await this.ready;
		if (botUserId === undefined) return "dropped";
		const cardReply = await this.#processCardReply(event, botUserId);
		if (cardReply !== undefined) return cardReply;
		const peer = event.user === botUserId ? undefined : this.peerBots.find((p) => p.userId === event.user);
		if (peer !== undefined) return this.#processPeerMessage(event, botUserId, peer, inChannel);
		if (event.bot_id !== undefined && !isOwner(event.user, this.ownerUserId)) {
			this.log.info("inbound_dropped", { reason: "bot_message", channel: event.channel, ts: event.ts });
			return "dropped";
		}
		// A file message is un-subtyped (the subtype rejection must not drop it) only for file_share itself: an edit or
		// delete event that merely carries `files` stays rejected.
		const files = event.files ?? [];
		const fileMessage =
			files.length > 0 && (event.subtype === undefined || event.subtype === "" || event.subtype === "file_share");
		const subtype = fileMessage && event.subtype === "file_share" ? undefined : event.subtype;
		let text = unescapeSlackText(event.text ?? "");
		let muteContext:
			| { ref: string; mentioned: boolean; muted: boolean; command: ThreadMuteCommand | undefined }
			| undefined;
		if (inChannel) {
			// In a channel a message counts as addressed when the channel is mention-free (solo channel), the bot is
			// mentioned, or it is a reply in a thread the bot is already part of. A thread muted with `!shutup` stays
			// quiet even in a mention-free channel — except a mute toggle (`!unshutup` has to get through) and a
			// mention, which releases the mute below.
			const mention = `<@${botUserId}>`;
			const threadRef = event.thread_ts === undefined ? undefined : `${event.channel}:${event.thread_ts}`;
			const mentionFree = this.mentionFreeChannels.has(event.channel);
			const mentioned = text.includes(mention);
			text = text.split(mention).join(" ").trim();
			const muteRef = `${event.channel}:${event.thread_ts ?? event.ts}`;
			const muted = this.core.isThreadMuted?.(muteRef) === true;
			const command = parseThreadMuteCommand(text);
			// `requireMention` makes the mention the only address; otherwise a mention-free channel or a known thread counts too.
			const audible = this.requireMention
				? mentioned
				: mentionFree || mentioned || (threadRef !== undefined && this.core.knowsThread?.(threadRef) === true);
			// A message that mentions a peer bot but not this bot is meant for the peer, whatever the channel policy says.
			const forPeer = !mentioned && this.peerBots.some((p) => text.includes(`<@${p.userId}>`));
			const addressed = audible && !forPeer && (mentioned || command !== undefined || !muted);
			if (!addressed) {
				this.log.info("inbound_dropped", {
					reason: muted ? "thread_muted" : "not_addressed",
					channel: event.channel,
					ts: event.ts,
				});
				return "dropped";
			}
			muteContext = { ref: muteRef, mentioned, muted, command };
		}
		const quoted = (event.attachments ?? [])
			.flatMap((a) => [a.pretext, a.text ?? a.fallback])
			.filter((t): t is string => typeof t === "string" && t !== "")
			.map(unescapeSlackText);
		const normalizeArgs = {
			userId: event.user ?? (event.bot_id ? botUserId : undefined),
			botUserId,
			ownerUserId: this.ownerUserId,
			quoted,
			channel: event.channel,
			ts: event.ts,
			threadTs: event.thread_ts,
			subtype,
			channelType: event.channel_type,
		};
		// Authorization and addressing are settled BEFORE any disk or network work: a non-owner's (or unaddressed) file
		// is never downloaded. The placeholder only stands in for the notes the download will add to an empty text.
		const gate = normalizeInbound({ ...normalizeArgs, text: fileMessage && text.trim() === "" ? "[file]" : text });
		if (!gate.accept) {
			this.log.info("inbound_dropped", { reason: gate.reason, channel: event.channel, ts: event.ts });
			return "dropped";
		}
		// Thread mute commands are owner-only bookkeeping (never an omp prompt) and must work inside a muted
		// thread, so they are settled right after the owner gate, before any turn machinery. They never become
		// inbound rows, so the core remembers handled ones durably: a backfill replay of the same event is a
		// duplicate (the toggle itself is idempotent, and a mention may have released the thread since).
		const muteCommand = muteContext?.command ?? (inChannel ? undefined : parseThreadMuteCommand(text));
		if (muteCommand !== undefined) {
			const platformMessageId = gate.inbound.platformMessageId;
			if (this.core.seenMuteCommand?.(platformMessageId) === true) {
				this.log.info("inbound_duplicate", { id: platformMessageId });
				return "duplicate";
			}
			const outcome = await this.#runMuteCommand(muteCommand, event, muteContext);
			if (outcome === "recorded") this.core.rememberMuteCommand?.(platformMessageId);
			return outcome;
		}
		if (muteContext?.muted && muteContext.mentioned) {
			// The owner addressing the bot in a muted thread re-arms it; this message itself becomes a normal turn.
			this.core.setThreadMute?.(muteContext.ref, false);
			this.log.info("thread_mute", { thread: muteContext.ref, muted: false, via: "mention" });
		}
		if (fileMessage) {
			const notes = await this.#collectAttachments(event, files);
			text = [text.trim(), ...notes].filter((line) => line !== "").join("\n");
		}
		const result = normalizeInbound({ ...normalizeArgs, text });
		if (!result.accept) {
			this.log.info("inbound_dropped", { reason: result.reason, channel: event.channel, ts: event.ts });
			return "dropped";
		}
		const { inbound } = result;
		const outcome = await this.core.onInbound(inbound);
		if (outcome?.duplicate) {
			this.log.info("inbound_duplicate", { id: inbound.platformMessageId });
			return "duplicate";
		}
		const parsed = parseThreadRef(inbound.threadRef);
		if (parsed) {
			const command = parseCommand(inbound.text);
			await this.beginStatus(
				inbound.threadRef,
				parsed.channel,
				parsed.threadTs,
				event,
				inbound.originKey,
				command === undefined || command.kind === "followup",
			);
		}
		return "recorded";
	}

	/**
	 * A message of an allowlisted peer bot: accepted only in a channel, un-subtyped and mentioning this bot. It never
	 * takes an owner path — no mute handling, no attachment download, no card reply, no command parsing (the text goes
	 * to the core fenced) — and is capped per thread by the core (`onPeerInbound`).
	 */
	async #processPeerMessage(
		event: SlackMessageEvent,
		botUserId: string,
		peer: { userId: string; name: string },
		inChannel: boolean,
	): Promise<IngestOutcome> {
		const drop = (reason: string): IngestOutcome => {
			this.log.info("inbound_dropped", { reason, channel: event.channel, ts: event.ts, peer: peer.userId });
			return "dropped";
		};
		if (!inChannel) return drop("peer_dm");
		if (event.subtype !== undefined && event.subtype !== "") return drop("subtype");
		const mention = `<@${botUserId}>`;
		const raw = unescapeSlackText(event.text ?? "");
		if (!raw.includes(mention)) return drop("peer_not_mentioned");
		if (this.core.onPeerInbound === undefined) return drop("peer_unsupported");
		// An owner-muted thread stays quiet for peers too, and a peer mention never releases the mute.
		if (this.core.isThreadMuted?.(`${event.channel}:${event.thread_ts ?? event.ts}`) === true) {
			return drop("thread_muted");
		}
		const quoted = (event.attachments ?? [])
			.flatMap((a) => [a.pretext, a.text ?? a.fallback])
			.filter((t): t is string => typeof t === "string" && t !== "")
			.map(unescapeSlackText);
		const result = normalizePeerInbound({
			peer,
			text: raw.split(mention).join(" ").trim(),
			quoted,
			channel: event.channel,
			ts: event.ts,
			threadTs: event.thread_ts,
			subtype: event.subtype,
		});
		if (!result.accept) return drop(result.reason);
		const { inbound } = result;
		const outcome = this.core.onPeerInbound(inbound, {
			turns: this.peerHopLimit.turns,
			windowMs: this.peerHopLimit.windowMinutes * 60_000,
		});
		if (outcome.duplicate) {
			this.log.info("inbound_duplicate", { id: inbound.platformMessageId });
			return "duplicate";
		}
		if (outcome.dropped !== undefined) {
			this.log.info("inbound_dropped", {
				reason: outcome.dropped,
				channel: event.channel,
				ts: event.ts,
				peer: peer.userId,
			});
			if (outcome.dropped === "peer_hop_cap" && outcome.notice === true) {
				// No bot mention in the notice: it must not invite another peer reply.
				await this.postNotice(event.channel, PEER_HOP_NOTICE, event.thread_ts ?? event.ts);
			}
			return "dropped";
		}
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
	async #processCardReply(event: SlackMessageEvent, botUserId: string): Promise<IngestOutcome | undefined> {
		if (this.core.onCardReply === undefined) return undefined;
		if (event.thread_ts === undefined || event.thread_ts === "" || event.thread_ts === event.ts) return undefined;
		if (!isOwner(event.user, this.ownerUserId) || (event.subtype !== undefined && event.subtype !== ""))
			return undefined;
		const text = unescapeSlackText(event.text ?? "")
			.split(`<@${botUserId}>`)
			.join(" ")
			.trim();
		if (text === "") return undefined;
		const threadRef = `${event.channel}:${event.thread_ts}`;
		const platformMessageId = `${event.channel}:${event.ts}`;
		const result = this.core.onCardReply({ threadRef, platformMessageId, text });
		if (result === undefined) return undefined;
		if (result.kind === "duplicate") {
			this.log.info("inbound_duplicate", { id: platformMessageId });
			return "duplicate";
		}
		if (result.kind === "settled") return "recorded";
		const outcome = await this.core.onInbound({
			platformMessageId,
			originKey: result.originKey,
			text,
			threadRef,
			ownerVerified: true,
		});
		if (outcome?.duplicate) {
			this.log.info("inbound_duplicate", { id: platformMessageId });
			return "duplicate";
		}
		await this.beginStatus(threadRef, event.channel, event.thread_ts, event, result.originKey, true);
		return "recorded";
	}

	/** Backfill entry: the exact live path, but reporting the outcome so the caller can count recovered messages. */
	ingestRecovered(event: SlackMessageEvent): Promise<IngestOutcome> {
		return this.processMessage(event);
	}

	/**
	 * `!shutup` / `!unshutup`: durable per-thread mute for channel threads (mention-free solo channels and threads the
	 * bot takes part in). A DM has no addressing gate, so there is nothing to mute — the owner gets a hint instead.
	 */
	async #runMuteCommand(
		command: ThreadMuteCommand,
		event: SlackMessageEvent,
		context: { ref: string; mentioned: boolean; muted: boolean } | undefined,
	): Promise<IngestOutcome> {
		if (context === undefined) {
			await this.#postMuteNotice(
				event.channel,
				event.thread_ts ?? event.ts,
				"🤫 스레드 뮤트(!shutup)는 채널이나 채널 스레드에서만 쓸 수 있습니다. DM은 항상 반응합니다.",
			);
			return "recorded";
		}
		if (this.core.setThreadMute === undefined) return "dropped";
		const muted = command === "shutup";
		this.core.setThreadMute(context.ref, muted);
		this.log.info("thread_mute", {
			thread: context.ref,
			muted,
			via: "command",
			channel: event.channel,
			ts: event.ts,
		});
		const text = muted
			? "🤫 이 스레드를 뮤트했습니다. 이 스레드의 메시지에는 반응하지 않습니다. 해제는 !unshutup 또는 저를 멘션하는 것입니다."
			: context.muted
				? "🔊 스레드 뮤트를 해제했습니다. 이제 이 스레드에서 다시 반응합니다."
				: "🔊 이 스레드는 뮤트되어 있지 않습니다.";
		await this.#postMuteNotice(event.channel, event.thread_ts ?? event.ts, text);
		return "recorded";
	}

	/** Best-effort in-thread notice for a mute toggle; failures are logged, never thrown. */
	async #postMuteNotice(channel: string, threadTs: string, text: string): Promise<void> {
		try {
			await this.call("chat.postMessage", () => this.transport.postMessage({ channel, text, threadTs }));
		} catch (err) {
			this.log.warn("thread_mute_notice_failed", { channel, error: errorText(err) });
		}
	}

	/**
	 * Best-effort root message (missed-message notice), or a reply when `threadTs` is given; failures are logged, never
	 * thrown. A notice of two or more lines goes out as a card: its first line as the header, the rest as one section;
	 * `text` stays the whole notice. Blocks Slack refuses (`invalid_blocks`) are dropped and the notice is sent once more.
	 */
	async postNotice(channel: string, text: string, threadTs?: string): Promise<void> {
		const blocks = this.#noticeBlocks(text);
		// Same rate-limit key as the delivery pump and the status/mute posts: one chat.postMessage 429 blocks them all.
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
		// Downloads run in parallel: destinations are per-file (fileKey hash) and downloadAttachment writes through a
		// unique tmp path per call, so nothing collides, and Promise.all preserves the note order. Worst-case
		// turn-start latency is the slowest single file instead of the sum of all of them.
		const notes = await Promise.all(
			files.slice(0, MAX_INBOUND_FILES).map((file) => this.#saveAttachment(file, event, mediaRoot)),
		);
		if (files.length > MAX_INBOUND_FILES) {
			notes.push(`[첨부 생략: ${files.length - MAX_INBOUND_FILES}개 — 메시지당 최대 ${MAX_INBOUND_FILES}개]`);
		}
		return notes;
	}

	/** Downloads one file into `<mediaRoot>/inbound/<ts>/`; failures become a notice line, never a dropped message. */
	async #saveAttachment(file: SlackInboundFile, event: SlackMessageEvent, mediaRoot: string): Promise<string> {
		// Names, mimetypes and errors are attacker-influenced text that lands in the prompt: one line, always.
		const name = oneLine(file.name ?? file.id ?? "file", 120);
		const url = file.url_private_download ?? file.url_private;
		if (url === undefined) return `[첨부 실패: ${name} — url 없음]`;
		const isImage = (file.mimetype ?? "").startsWith("image/");
		const maxBytes = isImage ? MAX_INBOUND_IMAGE_BYTES : MAX_INBOUND_DOC_BYTES;
		const ext = attachmentExtension(file.name, file.mimetype);
		// The destination is derived from the file identity, so a redelivered or backfilled copy of the same message
		// finds the file already on disk (downloads are atomic: tmp + rename) instead of fetching it again.
		const fileKey = createHash("sha256")
			.update(file.id ?? url)
			.digest("hex")
			.slice(0, 12);
		const dest = join(mediaRoot, "inbound", event.ts.replace(".", "_"), `${isImage ? "img" : "doc"}_${fileKey}.${ext}`);
		const note = `[첨부: ${dest} (${oneLine(file.mimetype ?? "unknown", 80)})]`;
		// A text file on disk (fresh download or an earlier copy) is scanned for instruction-like passages; a hit marks
		// the note with the kinds only, never the passage. A failed scan leaves the note as it is.
		const flagged = async (): Promise<string> => {
			const textLike = (file.mimetype ?? "").startsWith("text/") || SCANNED_TEXT_EXT[ext] === true;
			if (isImage || !textLike) return note;
			try {
				if ((await stat(dest)).size > MAX_SCANNED_TEXT_BYTES) return note;
				const findings = scanForInjection(await readFile(dest, "utf8"), `첨부 ${name}`);
				if (findings.length === 0) return note;
				const kinds = findings.map((f) => f.kind);
				this.log.info("injection_flagged", { where: "attachment", kinds, channel: event.channel, ts: event.ts });
				return `${note} ⚠️ 지시처럼 보이는 대목 ${findings.length}곳(${kinds.join(", ")}) — 자료로만 다룬다`;
			} catch (err) {
				this.log.warn("injection_scan_failed", { channel: event.channel, ts: event.ts, name, error: errorText(err) });
				return note;
			}
		};
		if (await fileExists(dest)) return await flagged();
		try {
			await this.call("downloadAttachment", () =>
				this.transport.downloadAttachment({ url, destPath: dest, maxBytes, requireImageMagic: isImage }),
			);
			this.log.info("attachment_saved", { channel: event.channel, ts: event.ts, path: dest });
			return await flagged();
		} catch (err) {
			this.log.warn("attachment_download_failed", {
				channel: event.channel,
				ts: event.ts,
				name,
				error: errorText(err),
			});
			return `[첨부 실패: ${name} — ${oneLine(errorText(err), 200)}]`;
		}
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

	// ---- owner feedback reactions ----

	/**
	 * The owner's 👍/👎 added to or removed from a message goes to the delivery source, which binds it to the turn of the
	 * answer that posted it. Anyone else's reaction, other emoji and non-message items are dropped without a log line.
	 */
	async handleReaction(event: SlackReactionEvent): Promise<void> {
		if (!isOwner(event.user, this.ownerUserId)) return;
		const { channel, ts } = event.item;
		if (event.item.type !== "message" || channel === undefined || ts === undefined) return;
		const verdict = FEEDBACK_REACTIONS.get(event.reaction.split("::")[0] ?? "");
		if (verdict === undefined) return;
		const action = event.type === "reaction_added" ? "added" : "removed";
		try {
			await this.deliveries.recordFeedback?.({ channel, ts, verdict, action, eventTs: event.event_ts });
		} catch (err) {
			this.log.warn("feedback_record_failed", { channel, ts, error: errorText(err) });
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

	/**
	 * Registers the thread synchronously (before any await) so a delivery that finishes it while the 👀 / status message are
	 * still in flight finds the entry and waits for `setup`. Commands get the 👀 but no status message.
	 */
	private beginStatus(
		threadRef: string,
		channel: string,
		root: string,
		event: SlackMessageEvent,
		originKey: string,
		showStatus: boolean,
	): Promise<void> {
		const ack = this.acknowledge(event, originKey);
		const existing = this.statuses.get(threadRef);
		if (existing && existing.final === undefined) {
			existing.reactionTs.add(event.ts);
			existing.setup = Promise.all([existing.setup, ack]).then(() => undefined);
			return existing.setup;
		}
		const now = this.clock.now();
		const entry: StatusEntry = {
			channel,
			root,
			statusTs: undefined,
			startedAt: now,
			lastUpdateAt: now,
			reactionTs: new Set([event.ts]),
			setup: Promise.resolve(),
			showStatus,
			final: undefined,
			stalled: false,
			progress: undefined,
			finalAction: "update",
			statusDone: false,
			reactionsDone: false,
		};
		this.statuses.set(threadRef, entry);
		const created = showStatus ? this.createStatus(threadRef, entry) : Promise.resolve();
		entry.setup = Promise.all([ack, created]).then(() => undefined);
		return entry.setup;
	}

	private async createStatus(threadRef: string, entry: StatusEntry): Promise<void> {
		try {
			const posted = await this.call("chat.postMessage", () =>
				this.transport.postMessage({
					channel: entry.channel,
					threadTs: entry.root,
					text: `⏳ 작업 중 · ${formatElapsed(0)}`,
				}),
			);
			entry.statusTs = posted.ts;
		} catch (err) {
			this.log.warn("status_create_failed", { thread: threadRef, error: errorText(err) });
		}
	}

	/** Called by the daemon on a timer. Updates each running status at most once per interval; finishes pending finals. */
	async tick(): Promise<void> {
		for (const [threadRef, entry] of [...this.statuses]) {
			if (entry.final !== undefined) {
				await this.flushFinal(threadRef, entry);
			} else if (entry.statusTs !== undefined && this.clock.now() - entry.lastUpdateAt >= this.statusIntervalMs) {
				await this.updateRunning(threadRef, entry, entry.statusTs);
			}
		}
	}

	/** The daemon reports a silent (or resumed) turn: the running status text switches at once, outside the 15s cadence. */
	async setStalled(threadRef: string, stalled: boolean): Promise<void> {
		const entry = this.statuses.get(threadRef);
		if (!entry || entry.final !== undefined) return;
		entry.stalled = stalled;
		await entry.setup;
		if (entry.statusTs !== undefined && entry.final === undefined) {
			await this.updateRunning(threadRef, entry, entry.statusTs);
		}
	}

	/**
	 * The daemon reports the turn's progress (tool calls, todo, steers, retries). It is stored at once (the next 15s
	 * update shows it); an extra update is coaxed out only when the cadence already allows one, so a turn with
	 * many tool calls still updates the status at most once per interval.
	 */
	async setProgress(threadRef: string, progress: TurnProgress): Promise<void> {
		const entry = this.statuses.get(threadRef);
		if (!entry || entry.final !== undefined) return;
		entry.progress = progress;
		await entry.setup;
		if (
			entry.statusTs !== undefined &&
			entry.final === undefined &&
			this.clock.now() - entry.lastUpdateAt >= this.statusIntervalMs
		) {
			await this.updateRunning(threadRef, entry, entry.statusTs);
		}
	}

	private async updateRunning(threadRef: string, entry: StatusEntry, statusTs: string): Promise<void> {
		const text = runningStatusText(entry.stalled, this.clock.now() - entry.startedAt, entry.progress);
		try {
			await this.call("chat.update", () =>
				this.transport.updateMessage({ channel: entry.channel, ts: statusTs, text }),
			);
			entry.lastUpdateAt = this.clock.now();
		} catch (err) {
			if (err instanceof BlockedError || err instanceof SlackRateLimitedError) return;
			entry.lastUpdateAt = this.clock.now();
			this.log.warn("status_update_failed", { thread: threadRef, error: errorText(err) });
		}
	}

	/**
	 * Marks the turn finished: the status message is deleted (`delete`: the answer carries the footer) or becomes
	 * ✅/⚠️ (`update`), 👀 is removed, ✅/⚠️ reaction added. Retried by tick() under a rate limit.
	 */
	async finishStatus(threadRef: string, outcome: FinalOutcome, action: "delete" | "update" = "update"): Promise<void> {
		let entry = this.statuses.get(threadRef);
		if (!entry) {
			const parsed = parseThreadRef(threadRef);
			if (!parsed) return;
			// After a restart nothing is tracked; the thread root is where the first 👀 lives.
			entry = {
				channel: parsed.channel,
				root: parsed.threadTs,
				statusTs: undefined,
				startedAt: this.clock.now(),
				lastUpdateAt: this.clock.now(),
				reactionTs: new Set([parsed.threadTs]),
				setup: Promise.resolve(),
				showStatus: false,
				final: undefined,
				stalled: false,
				progress: undefined,
				finalAction: "update",
				statusDone: false,
				reactionsDone: false,
			};
			this.statuses.set(threadRef, entry);
		}
		entry.final = outcome;
		entry.finalAction = action;
		await this.flushFinal(threadRef, entry);
	}

	private async flushFinal(threadRef: string, entry: StatusEntry): Promise<void> {
		const outcome = entry.final;
		if (outcome === undefined) return;
		await entry.setup;
		if (!entry.statusDone) {
			if (entry.statusTs === undefined) {
				entry.statusDone = true;
			} else if (entry.finalAction === "delete") {
				const statusTs = entry.statusTs;
				try {
					await this.call("chat.delete", () => this.transport.deleteMessage({ channel: entry.channel, ts: statusTs }));
					entry.statusDone = true;
				} catch (err) {
					// Rate limited: tick() deletes again. Refused: the status stays and shows the final label instead.
					if (!(err instanceof BlockedError || err instanceof SlackRateLimitedError)) {
						this.log.warn("status_delete_failed", { thread: threadRef, error: errorText(err) });
						entry.finalAction = "update";
					}
				}
			}
			if (!entry.statusDone && entry.statusTs !== undefined && entry.finalAction === "update") {
				const statusTs = entry.statusTs;
				const text = `${FINAL_MARKS[outcome].label} · ${formatElapsed(this.clock.now() - entry.startedAt)}`;
				try {
					await this.call("chat.update", () =>
						this.transport.updateMessage({ channel: entry.channel, ts: statusTs, text }),
					);
					entry.statusDone = true;
				} catch (err) {
					if (!(err instanceof BlockedError || err instanceof SlackRateLimitedError)) {
						entry.statusDone = true;
						this.log.warn("status_final_failed", { thread: threadRef, error: errorText(err) });
					}
				}
			}
		}
		if (!entry.reactionsDone) {
			const mark = FINAL_MARKS[outcome].mark;
			let pending = false;
			for (const ts of entry.reactionTs) {
				const target = { channel: entry.channel, timestamp: ts };
				pending =
					(await this.swapReaction("reactions.remove", () =>
						this.transport.removeReaction({ ...target, name: "eyes" }),
					)) || pending;
				// A registered [TASK] root keeps the task sweep's status reaction; the turn mark would fight it.
				if (ts === entry.root && this.isTaskRoot?.(threadRefOf(entry.channel, ts)) === true) continue;
				pending =
					(await this.swapReaction("reactions.add", () => this.transport.addReaction({ ...target, name: mark }))) ||
					pending;
			}
			entry.reactionsDone = !pending;
		}
		if (entry.statusDone && entry.reactionsDone) this.statuses.delete(threadRef);
	}

	/** Returns true when the step must be retried later (rate limited). Other errors (no_reaction, already_reacted) are final. */
	private async swapReaction(method: string, fn: () => Promise<void>): Promise<boolean> {
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
	 * Claims due deliveries and posts them. Does nothing while chat.postMessage is rate limited; a 429 mid-batch sends
	 * the rest of the batch back unsent to wait for the same block. Returns how many were confirmed.
	 */
	async pumpDeliveries(): Promise<number> {
		if (this.isBlocked("chat.postMessage")) return 0;
		let confirmed = 0;
		for (const delivery of await this.deliveries.claimDue()) {
			if (this.isBlocked("chat.postMessage")) {
				await this.#deferDelivery(delivery, new BlockedError("chat.postMessage"), delivery.sentParts ?? 0);
				continue;
			}
			if (await this.sendDelivery(delivery)) confirmed += 1;
		}
		return confirmed;
	}

	/** Back to pending until chat.postMessage's block ends; `sent` messages of it are already in Slack. */
	async #deferDelivery(delivery: DeliveryItem, err: unknown, sent: number, replyTs?: string): Promise<void> {
		const at = this.blockedUntil.get("chat.postMessage") ?? this.clock.now();
		this.log.warn("delivery_deferred", {
			id: delivery.deliveryId,
			sent_parts: sent,
			retry_in_ms: Math.max(0, at - this.clock.now()),
			error: errorText(err),
		});
		await this.deliveries.defer(delivery.deliveryId, errorText(err), {
			at,
			sentParts: sent,
			...(replyTs === undefined ? {} : { replyTs }),
		});
	}

	/** Swaps each `{{thread-link:<channel>:<ts>}}` the ledger left (log copy, steered-thread pointer) for ` · [스레드 보기](<permalink>)`; none on failure. */
	async #resolveThreadLinks(body: string): Promise<string> {
		if (!body.includes(THREAD_LINK_PREFIX)) return body;
		const pattern = /\{\{thread-link:([A-Z0-9]+):([0-9.]+)\}\}/g;
		let out = "";
		let last = 0;
		for (const match of body.matchAll(pattern)) {
			out += body.slice(last, match.index);
			last = match.index + match[0].length;
			try {
				const url = await this.call("chat.getPermalink", () =>
					this.transport.getPermalink({ channel: match[1] ?? "", ts: match[2] ?? "" }),
				);
				out += ` · [스레드 보기](${url})`;
			} catch (err) {
				this.log.warn("permalink_failed", { channel: match[1], error: errorText(err) });
			}
		}
		return out + body.slice(last);
	}

	private async sendDelivery(delivery: DeliveryItem): Promise<boolean> {
		const target = parseThreadRef(delivery.threadRef);
		if (!target) {
			await this.deliveries.fail(delivery.deliveryId, `invalid thread_ref ${delivery.threadRef}`, "definitive");
			return false;
		}
		const body = await this.#resolveThreadLinks(delivery.body);
		const outcome = delivery.body.startsWith("[turn failed]") ? "failed" : "done";
		const cancelled = new Set(delivery.cancelThreadRefs ?? []);
		// The answer's own thread loses its status message below, so the elapsed time and tool count move under it.
		const footer =
			delivery.keepStatus || cancelled.has(delivery.threadRef)
				? undefined
				: this.#footerOf(delivery.threadRef, outcome);
		let path = this.#deliveryPaths.get(delivery.deliveryId) ?? (this.#markdownBlocksOff ? "plain" : "markdown");
		let parts: ReadonlyArray<{ text: string; blocks?: readonly unknown[]; card?: CardFallback }>;
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
				const post = (text: string, blocks: readonly unknown[] | undefined) =>
					this.call("chat.postMessage", () =>
						this.transport.postMessage({
							channel: target.channel,
							text,
							...(threadTs === undefined ? {} : { threadTs }),
							...(blocks === undefined ? {} : { blocks }),
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
					await this.#recordPost({
						channel: target.channel,
						ts: posted.ts,
						deliveryId: delivery.deliveryId,
						part: sent,
					});
					sent += 1;
				}
				break;
			} catch (err) {
				// Slack answered "later" for this message: it and the ones after it were not posted.
				if (err instanceof BlockedError || err instanceof SlackRateLimitedError) {
					await this.#deferDelivery(delivery, err, sent, target.threadTs === TOP_LEVEL_TS ? threadTs : undefined);
					return false;
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
				this.log.warn("delivery_failed", {
					id: delivery.deliveryId,
					sent_parts: sent,
					outcome: definitive ? "definitive" : "ambiguous",
					error: errorText(err),
				});
				await this.deliveries.fail(delivery.deliveryId, errorText(err), definitive ? "definitive" : "ambiguous");
				return false;
			}
		}
		this.#deliveryPaths.delete(delivery.deliveryId);
		await this.deliveries.confirm(delivery.deliveryId);
		this.log.info("delivery_sent", {
			id: delivery.deliveryId,
			parts: parts.length,
			path,
			redelivered: delivery.redelivered,
		});
		// The turn still runs: its status stays until the turn-end delivery.
		if (delivery.keepStatus) return true;
		// Every row the op closed (steered messages sit in their own threads) gets its status finished, not only the lead.
		for (const threadRef of new Set([delivery.threadRef, ...(delivery.finishThreadRefs ?? [])])) {
			if (delivery.finishUntracked === false && !this.statuses.has(threadRef)) continue;
			const final = cancelled.has(threadRef) ? "cancelled" : outcome;
			// Only the thread holding the answer (and its footer) drops the status; the other threads keep the label.
			await this.finishStatus(
				threadRef,
				final,
				threadRef === delivery.threadRef && final !== "cancelled" ? "delete" : "update",
			);
		}
		return true;
	}

	/** Best effort: a failed record is one warn line, and the answer goes on to its next part. */
	async #recordPost(post: { channel: string; ts: string; deliveryId: number; part: number }): Promise<void> {
		try {
			await this.deliveries.recordPost?.(post);
		} catch (err) {
			this.log.warn("delivery_post_record_failed", { id: post.deliveryId, part: post.part, error: errorText(err) });
		}
	}

	/**
	 * Posts a card part. A definitive `invalid_blocks`/`invalid_arguments` refusal is retried at once, never touching
	 * `#markdownBlocksOff`: a card with a native chart next goes with ASCII charts (turning `#chartBlocksOff` on, so later
	 * cards and a resume start there), then any card as its fence's code block without blocks. The text step's error,
	 * and any other error, goes to the caller's catch.
	 */
	async #postCard<T>(
		id: number,
		index: number,
		part: { text: string; blocks?: readonly unknown[] },
		card: CardFallback,
		post: (text: string, blocks: readonly unknown[] | undefined) => Promise<T>,
	): Promise<T> {
		const steps: Array<{ step: "blocks" | "ascii"; blocks: readonly unknown[] | undefined }> = [];
		// Charts turned off by an earlier card of this answer: its ASCII form goes first.
		if (card.asciiBlocks === undefined || !this.#chartBlocksOff) steps.push({ step: "blocks", blocks: part.blocks });
		if (card.asciiBlocks !== undefined) steps.push({ step: "ascii", blocks: card.asciiBlocks });
		for (const { step, blocks } of steps) {
			try {
				return await post(part.text, blocks);
			} catch (err) {
				const refused =
					err instanceof SlackCallError &&
					err.kind === "definitive" &&
					/invalid_blocks|invalid_arguments/.test(errorText(err));
				if (!refused) throw err;
				this.log.warn("card_blocks_rejected", { id, part: index, step, error: errorText(err) });
				if (step === "blocks" && card.asciiBlocks !== undefined && !this.#chartBlocksOff) {
					this.#chartBlocksOff = true;
					this.log.warn("card_chart_blocks_disabled", { id, error: errorText(err) });
				}
			}
		}
		return post(card.text, undefined);
	}

	/**
	 * `✅ 00:42 · 도구 6회` for a thread whose running status this answer replaces; none without a running status
	 * (monitor, post-restart) or for a command thread, which never showed a `⏳` message.
	 */
	#footerOf(threadRef: string, outcome: "done" | "failed"): string | undefined {
		const entry = this.statuses.get(threadRef);
		if (entry === undefined || entry.final !== undefined || !entry.showStatus) return undefined;
		const mark = FINAL_MARKS[outcome].label.split(" ")[0];
		const tools = entry.progress?.tools ?? 0;
		return `${mark} ${formatElapsed(this.clock.now() - entry.startedAt)}${tools > 0 ? ` · 도구 ${tools}회` : ""}`;
	}
}
