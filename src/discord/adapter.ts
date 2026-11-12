// Discord's inbound path and delivery sender: the same rules as the Slack adapter (owner gate, addressing, mute,
// 👀 + ⏳ status, the shared delivery pump), on Discord's shapes (doc/plans/discord-channel.md §7–8).
import { join } from "node:path";
import type { ChannelAdapter, ChannelPolicy, OwnerIngest } from "../channel/adapter";
import {
	MAX_INBOUND_DOC_BYTES,
	MAX_INBOUND_FILES,
	MAX_INBOUND_IMAGE_BYTES,
	saveInboundAttachment,
} from "../channel/attachments";
import { renderMentions } from "../channel/port";
import { DeliveryPump, type DeliverySender, type DeliverySendResult } from "../channel/pump";
import {
	cutCodePointSafe,
	DENIED_TEXT,
	FINAL_MARKS,
	type FinalOutcome,
	formatElapsed,
	oneLine,
	progressLine,
	runningStatusText,
	STATUS_MIN_INTERVAL_MS,
} from "../channel/text";
import type { AdapterClock, CoreSink, DeliveryItem, DeliverySource, IngestOutcome } from "../channel/types";
import type { TurnProgress } from "../core/mailbox";
import {
	isOwner,
	normalizeInbound,
	normalizePeerInbound,
	originKeyForMessage,
	parseThreadRef,
	THREAD_LINK_PREFIX,
	TOP_LEVEL_TS,
	threadRefOf,
} from "../core/normalize";
import { chatOriginKey, parseChatOrigin } from "../core/origin-key";
import {
	COMMAND_TEXT,
	type CommandKind,
	parseCommand,
	parseThreadMuteCommand,
	TAKES_ARG,
	type ThreadMuteCommand,
} from "../core/types";
import type { Logger } from "../log";
import { DEFAULT_PEER_HOP_LIMIT, PEER_HOP_NOTICE, type PeerBotList } from "../slack/adapter";
import { type BackfillCursors, type BackfillTarget, DiscordBackfill } from "./backfill";
import { type Destination, type DiscordChannel, PUBLIC_THREAD, THREAD_EXISTS, THREAD_NAME_MAX } from "./channel";
import { fromDiscordEmoji, toDiscordEmoji } from "./emoji";
import { type DiscordPart, mrkdwnToDiscord, renderDiscordMessages } from "./format";
import {
	type ApplicationCommand,
	type DiscordAttachment,
	DiscordCallError,
	type DiscordHandlers,
	type DiscordInteraction,
	type DiscordMessageEvent,
	DiscordRateLimitedError,
	type DiscordReactionEvent,
	type DiscordTransport,
	MESSAGE_CONTENT_LIMIT,
} from "./transport";

/** Message types the bot reads: a plain message and a reply. Everything else is a system message. */
const READ_TYPES: ReadonlySet<number> = new Set([0, 19]);
const DM_CHANNEL = 1;
/** Interaction types: a slash command, a message component (button click). */
const APPLICATION_COMMAND = 2;
const MESSAGE_COMPONENT = 3;
/**
 * Interaction callback types: a message (with flags), the deferred message a slash command fills later ("thinking"),
 * and the deferred update that only acknowledges a click.
 */
const CHANNEL_MESSAGE = 4;
const DEFERRED_CHANNEL_MESSAGE = 5;
const DEFERRED_UPDATE_MESSAGE = 6;
/** Application command option type of a free-text argument. */
const STRING_OPTION = 3;
/** Message flag: only the clicking user sees the response. */
const EPHEMERAL = 64;
/** Interaction ids remembered against gateway replays; the oldest are forgotten past this. */
const SEEN_INTERACTIONS_MAX = 1000;
/** Messages whose refused-thread notice was posted; the set is emptied past this. */
const THREAD_NOTICE_MEMORY = 1000;
/** Discord shows "typing…" for about 10 s per call: one call every 8 s keeps it on without a gap. */
const TYPING_INTERVAL_MS = 8_000;
/** Typing stops this long after the message; a longer turn shows its progress in the status message. */
const TYPING_MAX_MS = 330_000;
/** Characters of the replied-to post put in the prompt's context line. */
const REPLY_CONTEXT_MAX = 300;

/** What each slash command does, as its picker shows it (Slack's manifest wording; Discord allows 1–100 characters). */
const COMMAND_DESCRIPTIONS: Record<CommandKind, string> = {
	new: "ompbot 대화를 새로 시작",
	status: "ompbot 상태 확인",
	model: "모델 보기·바꾸기",
	thinking: "thinking 수준 보기·바꾸기",
	compact: "컨텍스트 압축",
	resume: "저장된 세션 목록·이어가기",
	queue: "진행 중인 작업과 대기열 보기·대기 취소",
	followup: "끝난 뒤 다음 작업으로 보내기",
	usage: "토큰·비용 사용량 보기",
	distill: "이 대화 세션에서 스킬 후보 리뷰",
	btw: "진행 중인 작업에 섞지 않고 곁질문에만 답하기",
	undo: "최근 변경 턴 되돌리기",
	budget: "오늘 비용과 상한 보기·오늘 상한 끄기",
	brief: "지금 상태를 한 장 이미지로 받기",
};

/**
 * The slash command set: every `COMMAND_TEXT` entry without its `/` (`new-ompbot` …); a command that takes an
 * argument has one optional text option, so the core sees the same `<command> <text>` a typed command gives.
 */
const SLASH_COMMANDS: readonly ApplicationCommand[] = (
	Object.entries(COMMAND_TEXT) as Array<[CommandKind, string]>
).map(([kind, text]) => ({
	name: text.slice(1),
	description: COMMAND_DESCRIPTIONS[kind],
	options: TAKES_ARG.has(kind)
		? [{ type: STRING_OPTION, name: "text", description: "명령 뒤에 붙일 내용", required: false }]
		: [],
}));
const SLASH_KINDS: ReadonlyMap<string, CommandKind> = new Map(
	(Object.entries(COMMAND_TEXT) as Array<[CommandKind, string]>).map(([kind, text]) => [text.slice(1), kind]),
);
/** Ephemeral hint for a command typed where the bot holds no conversation (a group DM). */
const COMMAND_PLACE_TEXT = "이 명령은 봇과의 DM이나 봇이 있는 서버 채널에서만 쓸 수 있습니다.";
const COMMAND_FAILED_TEXT = "명령 처리에 실패했습니다. 로그를 확인하세요.";

export interface DiscordAdapterOptions {
	/** The port: its transport carries every call, its channel cache tells threads from messages. */
	channel: DiscordChannel;
	core: CoreSink;
	deliveries: DeliverySource;
	ownerUserId: string;
	clock: AdapterClock;
	log: Logger;
	/** Servers whose messages are taken; absent: every server. DMs are not affected. */
	guildIds?: readonly string[] | undefined;
	/** Channel ids where the owner's message counts as addressed without a mention. */
	mentionFreeChannels?: readonly string[] | undefined;
	/** The Discord #log ledger channel (`channels.discord.logChannelId`): inbound there or in its threads never becomes a turn. */
	logChannel?: string | undefined;
	/** In a server channel only a mention addresses the bot. */
	requireMention?: boolean | undefined;
	/** Peer bots whose server channel messages that mention this bot are taken (`channels.discord.peerBots`). */
	peerBots?: PeerBotList | undefined;
	/** Peer input cap per thread (top-level `peerHopLimit`). Default `DEFAULT_PEER_HOP_LIMIT`. */
	peerHopLimit?: { turns: number; windowMinutes: number } | undefined;
	/** Whether a thread root is a registered [TASK]: its status reaction belongs to the task sweep. */
	isTaskRoot?: ((threadRef: string) => boolean) | undefined;
	/** Called after a live message failed as `inbound_failed` (the missed-message recovery trigger). */
	onInboundFailure?: (() => void) | undefined;
	/**
	 * Missed-message recovery behind `recover()`: the watermarks and the channels to read (asked at every pass).
	 * Absent: `recover()` does nothing.
	 */
	recovery?: { cursors: BackfillCursors; targets(): BackfillTarget[]; maxPages?: number | undefined } | undefined;
	/** Directory for downloaded inbound attachments (`<home>/media`); without it attachments are skipped with a note. */
	mediaRoot?: string | undefined;
	statusIntervalMs?: number | undefined;
	/** The typing indicator's interval timer (tests fire it by hand). Default `setInterval`/`clearInterval`, unref'd. */
	typingTimers?: TypingTimers | undefined;
}

export interface TypingTimers {
	set(fn: () => unknown, ms: number): unknown;
	clear(handle: unknown): void;
}

const INTERVAL_TIMERS: TypingTimers = {
	set: (fn, ms) => setInterval(fn, ms).unref(),
	clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** One thread's typing indicator, from the owner message until the first answer, the turn's end or the cap. */
interface TypingEntry {
	/** Where "typing…" shows: the thread channel, or the DM. Unknown until the lookup settles. */
	channelId: string | undefined;
	startedAt: number;
	handle: unknown;
	stopped: boolean;
}

/** Where one owner message is: the channel it was posted in and its id (👀 goes there). */
interface MessageSpot {
	channelId: string;
	messageId: string;
}

interface StatusEntry {
	conversationId: string;
	root: string;
	statusChannel: string | undefined;
	statusId: string | undefined;
	startedAt: number;
	lastUpdateAt: number;
	/** Owner messages carrying our 👀 in this thread: message id → channel. */
	reactions: Map<string, string>;
	setup: Promise<void>;
	showStatus: boolean;
	final: FinalOutcome | undefined;
	stalled: boolean;
	progress: TurnProgress | undefined;
	finalAction: "delete" | "update";
	statusDone: boolean;
	reactionsDone: boolean;
}

/** One adapter-level block per kind of call: a 429 on posting must not stop status edits, and the other way round. */
type Route = "post" | "edit" | "delete" | "react" | "typing";

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export class DiscordAdapter implements ChannelAdapter {
	readonly platform = "discord" as const;
	readonly #port: DiscordChannel;
	readonly #transport: DiscordTransport;
	readonly #core: CoreSink;
	readonly #deliveries: DeliverySource;
	readonly #owner: string;
	readonly #clock: AdapterClock;
	readonly #log: Logger;
	readonly #guildIds: ReadonlySet<string> | undefined;
	#mentionFree: ReadonlySet<string>;
	readonly #logChannel: string | undefined;
	#requireMention: boolean;
	readonly #peerBots: PeerBotList;
	#peerHopLimit: { turns: number; windowMinutes: number };
	readonly #isTaskRoot: ((threadRef: string) => boolean) | undefined;
	readonly #onInboundFailure: (() => void) | undefined;
	readonly #mediaRoot: string | undefined;
	readonly #statusIntervalMs: number;
	readonly #statuses = new Map<string, StatusEntry>();
	/** Typing per thread ref; a stopped entry stays until finishStatus so the same turn is not typed again. */
	readonly #typing = new Map<string, TypingEntry>();
	readonly #typingTimers: TypingTimers;
	readonly #blockedUntil = new Map<Route, number>();
	readonly #pump: DeliveryPump;
	readonly #recovery: DiscordBackfill | undefined;
	/** Interactions already handled (a resumed gateway can replay one): insertion-ordered, capped. */
	readonly #seenInteractions = new Set<string>();
	/** Messages whose refused thread start already left the channel notice (`#startThread`). */
	readonly #threadNoticeSent = new Set<string>();
	/** Recovered server roots that opened their thread, until their scan's notice picks one (`#recoveryNotice`). */
	readonly #recoveredThreads = new Set<string>();
	#ready: Promise<string | undefined> = Promise.resolve(undefined);
	/** The start-time slash command registration; settles (never rejects) once every scope was tried. */
	#commands: Promise<void> = Promise.resolve();
	/** Microseconds of the last feedback event stamp: stamps strictly increase, so a later event always wins. */
	#lastFeedbackMicros = 0;
	#botUserId: string | undefined;

	constructor(options: DiscordAdapterOptions) {
		this.#port = options.channel;
		this.#transport = options.channel.transport;
		this.#core = options.core;
		this.#deliveries = options.deliveries;
		this.#owner = options.ownerUserId;
		this.#clock = options.clock;
		this.#log = options.log;
		this.#guildIds = options.guildIds === undefined ? undefined : new Set(options.guildIds);
		this.#mentionFree = new Set(options.mentionFreeChannels ?? []);
		this.#logChannel = options.logChannel;
		this.#requireMention = options.requireMention === true;
		this.#peerBots = options.peerBots ?? [];
		this.#peerHopLimit = options.peerHopLimit ?? DEFAULT_PEER_HOP_LIMIT;
		this.#isTaskRoot = options.isTaskRoot;
		this.#onInboundFailure = options.onInboundFailure;
		this.#mediaRoot = options.mediaRoot;
		this.#statusIntervalMs = options.statusIntervalMs ?? STATUS_MIN_INTERVAL_MS;
		this.#typingTimers = options.typingTimers ?? INTERVAL_TIMERS;
		this.#pump = new DeliveryPump({
			source: options.deliveries,
			sender: this.#sender(),
			clock: options.clock,
			log: options.log,
		});
		const recovery = options.recovery;
		this.#recovery =
			recovery === undefined
				? undefined
				: new DiscordBackfill({
						transport: this.#transport,
						cursors: recovery.cursors,
						log: options.log,
						now: () => options.clock.now(),
						targets: () => recovery.targets(),
						maxPages: recovery.maxPages,
						ready: async () => (await this.#ready) !== undefined,
						locate: async (channelId) => {
							const info = await this.#port.channelInfo(channelId);
							if (info === undefined) return undefined;
							if (info.guildId === undefined) return { dm: true };
							return { dm: false, guildId: info.guildId };
						},
						ingest: async (event) => {
							let opened = false;
							const outcome = await this.#processMessage(event, [], false, () => {
								opened = true;
							});
							if (opened && outcome === "recorded") this.#recoveredThreads.add(event.id);
							return outcome;
						},
						notify: (target) => this.#recoveryNotice(target),
					});
	}

	get botUserId(): string | undefined {
		return this.#botUserId;
	}

	/**
	 * Connects in the background: the daemon (and Slack) never waits for the gateway. A failed start — a fatal close
	 * such as 4004/4014 — leaves Discord off and is logged; every other part of the daemon keeps running. Once ready
	 * the slash commands are registered; a refused registration is a warning, the typed `!` commands still work.
	 */
	async start(): Promise<void> {
		const handlers: DiscordHandlers = {
			message: (event) => this.handleMessage(event),
			reaction: (event) => this.handleReaction(event),
			interaction: (interaction) => this.handleInteraction(interaction),
			// A new session lost the events in between (a resume replays them). The first Ready comes before start()
			// has the bot id: that one is the daemon's own startup recover().
			ready: ({ resumed }) => {
				if (!resumed && this.#botUserId !== undefined) this.recover();
			},
		};
		this.#ready = this.#transport.start(handlers).then(
			({ botUserId }) => {
				this.#botUserId = botUserId;
				this.#log.info("discord_ready", { bot_user_id: botUserId });
				return botUserId;
			},
			(err: unknown) => {
				this.#log.error("discord_start_failed", { error: errorText(err) });
				return undefined;
			},
		);
		this.#commands = this.#ready.then((botUserId) => (botUserId === undefined ? undefined : this.#registerCommands()));
	}

	/** Resolves once the start-time command registration has settled (whatever its outcome). */
	commandsReady(): Promise<void> {
		return this.#commands;
	}

	/**
	 * Overwrites the command set: globally (DMs and every server), or per allowed server when `guildIds` is set —
	 * a server's set shows at once, the global one can take a while to spread.
	 */
	async #registerCommands(): Promise<void> {
		const guilds = this.#guildIds === undefined || this.#guildIds.size === 0 ? [undefined] : [...this.#guildIds];
		for (const guildId of guilds) {
			const scope = guildId ?? "global";
			try {
				await this.#transport.registerCommands({
					...(guildId === undefined ? {} : { guildId }),
					commands: SLASH_COMMANDS,
				});
				this.#log.info("discord_commands_registered", { scope, count: SLASH_COMMANDS.length });
			} catch (err) {
				this.#log.warn("discord_commands_register_failed", { scope, error: errorText(err) });
			}
		}
	}

	async stop(): Promise<void> {
		for (const typing of this.#typing.values()) this.#haltTyping(typing);
		this.#typing.clear();
		await this.#transport.stop();
	}

	connectionState(): { state: "up" | "down"; since: number } | undefined {
		return this.#transport.connectionState?.();
	}

	/** Starts a missed-message pass over every Discord conversation's channel (one at a time; extra triggers coalesce). */
	recover(): void {
		this.#recovery?.trigger();
	}

	/** Resolves once no recovery pass runs or waits (tests, shutdown). */
	recoveryIdle(): Promise<void> {
		return this.#recovery?.waitForIdle() ?? Promise.resolve();
	}

	/**
	 * Config reload. Discord's own policy keys live under `channels.discord`, which needs a restart; of the top-level
	 * keys only `peerHopLimit` is shared by both platforms, so only it is taken here.
	 */
	setChannelPolicy(policy: ChannelPolicy): void {
		this.#peerHopLimit = policy.peerHopLimit ?? DEFAULT_PEER_HOP_LIMIT;
	}

	/** An owner message the daemon puts in, fed through the live path as the owner's own message. */
	async ingestOwner(input: OwnerIngest): Promise<IngestOutcome> {
		const botUserId = await this.#ready;
		// `kind` is the daemon's guess from Slack id shapes; a Discord DM is told by its channel having no server.
		const conversation = input.kind === "ch" ? await this.#port.channelInfo(input.conversationId) : undefined;
		const inChannel = conversation?.guildId !== undefined;
		return this.#processMessage(
			{
				id: input.messageId,
				// A DM has no threads: its `threadId` is the message the marker replied to, not a channel.
				channel_id: input.kind === "dm" ? input.conversationId : (input.threadId ?? input.conversationId),
				...(input.kind === "dm" && input.threadId !== undefined
					? { message_reference: { message_id: input.threadId } }
					: {}),
				guild_id: inChannel ? conversation?.guildId : undefined,
				author: { id: this.#owner },
				content: `${inChannel && botUserId !== undefined ? `<@${botUserId}> ` : ""}${input.text}`,
				type: 0,
			},
			input.quoted ?? [],
			input.injected === true,
		);
	}

	// ---- Discord calls with per-route Retry-After blocking ----

	#isBlocked(route: Route): boolean {
		const until = this.#blockedUntil.get(route);
		return until !== undefined && this.#clock.now() < until;
	}

	async #call<T>(route: Route, fn: () => Promise<T>): Promise<T> {
		const until = this.#blockedUntil.get(route);
		if (until !== undefined && this.#clock.now() < until) {
			throw new DiscordRateLimitedError(until - this.#clock.now());
		}
		try {
			return await fn();
		} catch (err) {
			if (err instanceof DiscordRateLimitedError) {
				this.#blockedUntil.set(route, this.#clock.now() + err.retryAfterMs);
				this.#log.warn("discord_rate_limited", { route, retry_after_ms: err.retryAfterMs });
			}
			throw err;
		}
	}

	/** Best-effort post; failures are logged under `event`, never thrown. */
	async #postText(conversationId: string, threadId: string | undefined, text: string, event: string): Promise<void> {
		try {
			const destination = await this.#port.destination(conversationId, threadId);
			await this.#call("post", () =>
				this.#transport.createMessage({
					channelId: destination.channelId,
					content: text,
					messageReference: destination.messageReference,
					allowedMentions: this.#port.allowedMentions(text),
				}),
			);
		} catch (err) {
			this.#log.warn(event, { channel: conversationId, error: errorText(err) });
		}
	}

	/**
	 * Slack's recovery notice where the recovered answers show: a reply to the oldest recovered DM message, or in the
	 * thread of the oldest recovered server root that opened one. A thread channel gets none (its answers are in it),
	 * nor does a channel whose recovered messages opened no thread (commands): the channel body stays clean.
	 */
	async #recoveryNotice(target: { channelId: string; dm: boolean; recovered: readonly string[] }): Promise<void> {
		const opened = target.recovered.filter((id) => this.#recoveredThreads.delete(id));
		const anchor = (target.dm ? target.recovered : opened).reduce<string | undefined>(
			(min, id) => (min === undefined || BigInt(id) < BigInt(min) ? id : min),
			undefined,
		);
		if (anchor === undefined) return;
		await this.#postText(
			target.channelId,
			anchor,
			`⏬ 봇이 응답하지 못한 동안 도착한 메시지 ${target.recovered.length}건을 처리합니다`,
			"backfill_notice_failed",
		);
	}

	/** Best-effort notice at the channel's top level, or under `threadId` (a thread, or the message it answers). */
	async postNotice(conversationId: string, text: string, threadId?: string): Promise<void> {
		await this.#postText(conversationId, threadId, text, "notice_failed");
	}

	// ---- owner feedback reactions ----

	/**
	 * The owner's 👍/👎 added to or removed from a message a delivery posted goes to the delivery source, which binds
	 * it to the turn of that answer. Gateway reactions carry no time, so each gets an arrival stamp in Slack's
	 * `<seconds>.<micros>` form, strictly increasing: of two events on one message the later one wins. Anyone else's
	 * reaction, other emoji and messages no delivery posted are dropped without a log line.
	 */
	async handleReaction(event: DiscordReactionEvent): Promise<void> {
		if (!isOwner(event.user_id, this.#owner)) return;
		const name = fromDiscordEmoji(event.emoji.name);
		const verdict = name === "+1" ? "up" : name === "-1" ? "down" : undefined;
		if (verdict === undefined) return;
		const post = { channel: event.channel_id, ts: event.message_id };
		const micros = Math.max(Math.floor(this.#clock.now() * 1000), this.#lastFeedbackMicros + 1);
		this.#lastFeedbackMicros = micros;
		const eventTs = `${Math.floor(micros / 1_000_000)}.${String(micros % 1_000_000).padStart(6, "0")}`;
		try {
			if (this.#deliveries.isPost !== undefined && !(await this.#deliveries.isPost(post))) return;
			await this.#deliveries.recordFeedback?.({
				...post,
				verdict,
				action: event.type === "add" ? "added" : "removed",
				eventTs,
			});
		} catch (err) {
			this.#log.warn("feedback_record_failed", { ...post, error: errorText(err) });
		}
	}

	// ---- button clicks ----

	/**
	 * A button click (INTERACTION_CREATE type 3). Discord voids the interaction unless it is answered within 3 s, so
	 * the answer goes out first: a stranger gets an ephemeral denial, the owner a deferred update (type 6) — then the
	 * core's onAction runs, the way a Slack block action does, and edits the card itself if it needs to.
	 */
	async handleInteraction(interaction: DiscordInteraction): Promise<void> {
		if (interaction.type !== MESSAGE_COMPONENT && interaction.type !== APPLICATION_COMMAND) return;
		if (this.#seenInteractions.has(interaction.id)) {
			this.#log.info("interaction_duplicate", { id: interaction.id });
			return;
		}
		this.#seenInteractions.add(interaction.id);
		if (this.#seenInteractions.size > SEEN_INTERACTIONS_MAX) {
			const oldest = this.#seenInteractions.values().next().value;
			if (oldest !== undefined) this.#seenInteractions.delete(oldest);
		}
		if (interaction.type === APPLICATION_COMMAND) {
			await this.#handleCommand(interaction);
			return;
		}
		try {
			const userId = (interaction.member?.user ?? interaction.user)?.id ?? "";
			const respond = (response: { type: number; data?: Record<string, unknown> }) =>
				this.#transport.respondInteraction({ interactionId: interaction.id, token: interaction.token, response });
			if (!isOwner(userId, this.#owner)) {
				this.#log.warn("action_denied", { user: userId });
				await respond({ type: CHANNEL_MESSAGE, data: { content: DENIED_TEXT, flags: EPHEMERAL } });
				return;
			}
			const customId = interaction.data?.custom_id;
			const message = interaction.message;
			try {
				await respond({ type: DEFERRED_UPDATE_MESSAGE });
			} catch (err) {
				// The click is the owner's either way; only Discord's "interaction failed" hint shows.
				this.#log.warn("interaction_ack_failed", { id: interaction.id, error: errorText(err) });
			}
			if (customId === undefined || message === undefined) return;
			this.#port.rememberMessage(message.id, message.channel_id);
			// The core's channel is the conversation: a thread's parent, a DM or channel itself.
			const info = interaction.guild_id === undefined ? undefined : await this.#port.channelInfo(message.channel_id);
			const channel = info?.parentId !== undefined && info.type !== 0 ? info.parentId : message.channel_id;
			await this.#core.onAction({
				actionId: customId,
				value: this.#port.buttonValue(message.id, customId),
				userId,
				channel,
				messageTs: message.id,
			});
		} catch (err) {
			this.#log.error("action_failed", { error: errorText(err) });
		}
	}

	/**
	 * A slash command (INTERACTION_CREATE type 2), Slack's `handleSlash` on Discord's shapes. Refusals (a stranger, an
	 * unknown name, a group DM) are an ephemeral reply. The owner's command is acknowledged within Discord's 3 s as a
	 * deferred ephemeral response (type 5) before the core runs it, and the core's text then fills that response; with
	 * no text (the answer is posted as its own message) the placeholder is deleted. In a server the command runs on the
	 * conversation it was typed in: the channel's origin, or a thread's own origin with the answer inside the thread.
	 */
	async #handleCommand(interaction: DiscordInteraction): Promise<void> {
		const userId = (interaction.member?.user ?? interaction.user)?.id ?? "";
		const name = interaction.data?.name ?? "";
		const { id: interactionId, token } = interaction;
		const reply = (content: string) =>
			this.#transport.respondInteraction({
				interactionId,
				token,
				response: { type: CHANNEL_MESSAGE, data: { content, flags: EPHEMERAL } },
			});
		try {
			if (!isOwner(userId, this.#owner)) {
				this.#log.warn("command_denied", { command: name, user: userId });
				await reply(DENIED_TEXT);
				return;
			}
			const command = SLASH_KINDS.get(name);
			if (command === undefined) {
				await reply(`알 수 없는 명령: /${name}`);
				return;
			}
			const channelId = interaction.channel_id ?? interaction.channel?.id;
			const guildId = interaction.guild_id;
			const dm = guildId === undefined && interaction.channel?.type === DM_CHANNEL;
			if (channelId === undefined || (guildId === undefined && !dm)) {
				await reply(COMMAND_PLACE_TEXT);
				return;
			}
			if (guildId !== undefined && this.#guildIds !== undefined && !this.#guildIds.has(guildId)) {
				await reply("이 서버에서는 ompbot 명령을 받지 않습니다.");
				return;
			}
			try {
				await this.#transport.respondInteraction({
					interactionId,
					token,
					response: { type: DEFERRED_CHANNEL_MESSAGE, data: { flags: EPHEMERAL } },
				});
			} catch (err) {
				// Too late or refused: Discord shows "interaction failed", the command still runs for the owner.
				this.#log.warn("interaction_ack_failed", { id: interactionId, error: errorText(err) });
			}
			const option = interaction.data?.options?.find((o) => o.name === "text")?.value;
			let text: string | undefined;
			try {
				let originKey: string;
				if (dm) {
					this.#port.remember({ id: channelId, type: DM_CHANNEL });
					originKey = chatOriginKey({ platform: "discord", kind: "dm", conversationId: channelId });
				} else {
					// Inside the try: a failed lookup still fills the deferred response instead of leaving it "thinking".
					const info = await this.#port.channelInfo(channelId);
					const thread = info?.parentId !== undefined && info.type !== 0;
					originKey = chatOriginKey({
						platform: "discord",
						kind: "ch",
						conversationId: thread ? (info?.parentId ?? channelId) : channelId,
						...(thread ? { threadId: channelId } : {}),
					});
				}
				text = await this.#core.onCommand({
					command,
					arg: typeof option === "string" ? option.trim() : "",
					originKey,
					channel: channelId,
					userId,
				});
			} catch (err) {
				this.#log.error("command_failed", { command: name, error: errorText(err) });
				text = COMMAND_FAILED_TEXT;
			}
			if (text === undefined) await this.#transport.deleteInteractionResponse({ token });
			else {
				await this.#transport.editInteractionResponse({
					token,
					content: cutCodePointSafe(mrkdwnToDiscord(text), MESSAGE_CONTENT_LIMIT),
					allowedMentions: { parse: [] },
				});
			}
		} catch (err) {
			this.#log.error("command_interaction_failed", { command: name, error: errorText(err) });
		}
	}

	// ---- inbound messages ----

	async handleMessage(event: DiscordMessageEvent): Promise<void> {
		try {
			await this.#processMessage(event, []);
		} catch (err) {
			this.#log.error("inbound_failed", { channel: event.channel_id, id: event.id, error: errorText(err) });
			try {
				this.#onInboundFailure?.();
			} catch (cbErr) {
				this.#log.warn("inbound_failure_callback_failed", { error: errorText(cbErr) });
			}
		}
	}

	#drop(event: DiscordMessageEvent, reason: string): IngestOutcome {
		this.#log.info("inbound_dropped", { reason, channel: event.channel_id, id: event.id });
		return "dropped";
	}

	/**
	 * The prompt's context line for a reply: `답장 대상(<author>): <first 300 characters>`, fenced with the other quoted
	 * material. Only a post of this bot, the owner or a peer bot is quoted; a deleted post, one without its author or
	 * text, and anyone else's post give none. No extra Discord call: what the event carries is all there is.
	 */
	#replyContext(ref: DiscordMessageEvent["referenced_message"], botUserId: string): string | undefined {
		const author = ref?.author?.id;
		const content = ref?.content?.replace(/\s+/g, " ").trim() ?? "";
		if (author === undefined || content === "") return undefined;
		const label =
			author === botUserId
				? "이 봇"
				: isOwner(author, this.#owner)
					? "오너"
					: this.#peerBots.find((p) => p.userId === author)?.name;
		if (label === undefined) return undefined;
		return `답장 대상(${label}): ${cutCodePointSafe(content, REPLY_CONTEXT_MAX)}`;
	}

	/**
	 * `injected`: an `ompbot inject` message (`OwnerIngest.injected`), which may not answer a card. `onThread`: told when
	 * the message opened its own thread (recovery picks its notice's place by it).
	 */
	async #processMessage(
		event: DiscordMessageEvent,
		quoted: readonly string[],
		injected = false,
		onThread?: () => void,
	): Promise<IngestOutcome> {
		if (!READ_TYPES.has(event.type)) return this.#drop(event, "subtype");
		const botUserId = await this.#ready;
		if (botUserId === undefined) return "dropped";
		if (event.author.id === botUserId) return this.#drop(event, "bot_message");
		// A peer is told by its id, whatever the bot flag says.
		const peer = this.#peerBots.find((p) => p.userId === event.author.id);
		if (peer !== undefined) return this.#processPeerMessage(event, botUserId, peer);
		if (event.author.bot === true) return this.#drop(event, "bot_message");
		// The owner gate comes before any lookup, so a stranger's message costs no API call.
		if (!isOwner(event.author.id, this.#owner)) return this.#drop(event, "not_owner");
		const dm = event.guild_id === undefined;
		if (!dm && this.#guildIds !== undefined && !this.#guildIds.has(event.guild_id ?? "")) {
			return this.#drop(event, "guild_not_allowed");
		}
		// The core's ids: the conversation is the channel (a thread's parent), the thread the Discord thread id.
		let conversationId = event.channel_id;
		let threadId: string | undefined;
		if (dm) {
			this.#port.remember({ id: event.channel_id, type: DM_CHANNEL });
		} else {
			const info = await this.#port.channelInfo(event.channel_id);
			if (info === undefined) throw new Error(`unknown channel ${event.channel_id}`);
			if (info.parentId !== undefined && info.type !== 0) {
				conversationId = info.parentId;
				threadId = event.channel_id;
			}
			// The log channel is a ledger, not a conversation: nothing said there or in its threads reaches omp.
			if (conversationId === this.#logChannel) return this.#drop(event, "log_channel");
		}
		const spot: MessageSpot = { channelId: event.channel_id, messageId: event.id };
		let text = event.content;
		let muteContext:
			| { ref: string; mentioned: boolean; muted: boolean; command: ThreadMuteCommand | undefined }
			| undefined;
		if (!dm) {
			const tokens = [`<@${botUserId}>`, `<@!${botUserId}>`];
			const repliesToBot = event.referenced_message?.author?.id === botUserId;
			// A pinging reply lists its target under `mentions`: for a reply to this bot only a mention in the text counts.
			const mentioned =
				tokens.some((token) => text.includes(token)) ||
				(!repliesToBot && (event.mentions?.some((user) => user.id === botUserId) ?? false));
			for (const token of tokens) text = text.split(token).join(" ");
			text = text.trim();
			const cardReply = await this.#processCardReply(event, conversationId, threadId, text, spot, injected);
			if (cardReply !== undefined) return cardReply;
			const threadRef = threadId === undefined ? undefined : threadRefOf(conversationId, threadId);
			const muteRef = threadRefOf(conversationId, threadId ?? event.id);
			const muted = this.#core.isThreadMuted?.(muteRef) === true;
			const command = parseThreadMuteCommand(text);
			// A message that mentions a peer bot but not this bot is meant for the peer, whatever the channel policy says.
			const forPeer =
				!mentioned &&
				this.#peerBots.some(
					(p) =>
						text.includes(`<@${p.userId}>`) ||
						text.includes(`<@!${p.userId}>`) ||
						(event.mentions?.some((user) => user.id === p.userId) ?? false),
				);
			// A reply to this bot's post addresses it like a mention (requireMention and the mute release included),
			// unless its text mentions only a peer: then `forPeer` wins.
			const addressed = mentioned || (repliesToBot && !forPeer);
			const audible = this.#requireMention
				? addressed
				: this.#mentionFree.has(conversationId) ||
					addressed ||
					(threadRef !== undefined && this.#core.knowsThread?.(threadRef) === true);
			if (!audible || forPeer || !(addressed || command !== undefined || !muted)) {
				return this.#drop(event, muted ? "thread_muted" : "not_addressed");
			}
			muteContext = { ref: muteRef, mentioned: addressed, muted, command };
		} else {
			const cardReply = await this.#processCardReply(event, conversationId, undefined, text, spot, injected);
			if (cardReply !== undefined) return cardReply;
		}
		const replyContext = this.#replyContext(event.referenced_message, botUserId);
		// A forward's text is the snapshots', fenced like Slack's shared messages; their files are not fetched.
		const snapshots = event.message_snapshots ?? [];
		const forwarded = snapshots
			.map((snapshot) => snapshot.message?.content ?? "")
			.filter((content) => content.trim() !== "");
		const forwardedFiles = snapshots.reduce((sum, snapshot) => sum + (snapshot.message?.attachments?.length ?? 0), 0);
		const forwardNote = forwardedFiles === 0 ? [] : [`[전달된 첨부 ${forwardedFiles}개는 받지 않았습니다]`];
		const args = {
			userId: event.author.id,
			botUserId,
			ownerUserId: this.#owner,
			text,
			quoted: [...quoted, ...forwarded, ...(replyContext === undefined ? [] : [replyContext])],
			channel: conversationId,
			ts: event.id,
			threadTs: threadId,
			channelType: dm ? "im" : "channel",
			platform: "discord" as const,
		};
		// The owner gate and addressing are settled above, before any download; the placeholder only stands in for the
		// notes the download adds to an empty text.
		const files = event.attachments ?? [];
		const gate = normalizeInbound({
			...args,
			text: [files.length > 0 && text.trim() === "" ? "[file]" : text, ...forwardNote]
				.filter((line) => line.trim() !== "")
				.join("\n"),
		});
		if (!gate.accept) return this.#drop(event, gate.reason);
		const muteCommand = muteContext?.command ?? (dm ? parseThreadMuteCommand(text) : undefined);
		if (muteCommand !== undefined) {
			const id = gate.inbound.platformMessageId;
			if (this.#core.seenMuteCommand?.(id) === true) {
				this.#log.info("inbound_duplicate", { id });
				return "duplicate";
			}
			const outcome = await this.#runMuteCommand(muteCommand, conversationId, threadId ?? event.id, muteContext);
			if (outcome === "recorded") this.#core.rememberMuteCommand?.(id);
			return outcome;
		}
		if (muteContext?.muted && muteContext.mentioned) {
			this.#core.setThreadMute?.(muteContext.ref, false);
			this.#log.info("thread_mute", { thread: muteContext.ref, muted: false, via: "mention" });
		}
		// A server root that is no command opens its own thread, the way a Slack root opens its own origin.
		let inbound = gate.inbound;
		const opensThread = !dm && threadId === undefined && parseChatOrigin(inbound.originKey)?.threadId !== undefined;
		if (opensThread) {
			// A forward has no text of its own: its thread is named after the original.
			await this.#startThread(conversationId, event, text.trim() === "" ? (forwarded[0] ?? "") : text);
			onThread?.();
		}
		if (opensThread || files.length > 0) {
			const notes = files.length === 0 ? [] : await this.#collectAttachments(event, files);
			const body = [text.trim(), ...forwardNote, ...notes].filter((line) => line !== "").join("\n");
			const final = normalizeInbound({ ...args, text: body, ...(opensThread ? { threadTs: event.id } : {}) });
			if (!final.accept) return this.#drop(event, final.reason);
			inbound = final.inbound;
		}
		const outcome = await this.#core.onInbound(inbound);
		if (outcome?.duplicate) {
			this.#log.info("inbound_duplicate", { id: inbound.platformMessageId });
			return "duplicate";
		}
		const parsed = parseThreadRef(inbound.threadRef);
		if (parsed !== undefined) {
			const command = parseCommand(inbound.text);
			const showStatus = command === undefined || command.kind === "followup";
			await this.#beginStatus(inbound.threadRef, parsed.channel, parsed.threadTs, spot, inbound.originKey, {
				showStatus,
				typing: showStatus,
			});
		}
		return "recorded";
	}

	/**
	 * A message of an allowlisted peer bot, Slack's rules on Discord's shapes: a server channel or thread only, a read
	 * type, this bot mentioned (whatever the channel policy), no muted thread. It never takes an owner path — no card
	 * reply, no attachment download, no command parsing (the text goes to the core fenced) — and is capped per thread
	 * by the core. A channel root's thread is opened only once the core recorded the message, so a dropped peer
	 * message leaves no empty thread.
	 */
	async #processPeerMessage(
		event: DiscordMessageEvent,
		botUserId: string,
		peer: { userId: string; name: string },
	): Promise<IngestOutcome> {
		const drop = (reason: string): IngestOutcome => {
			this.#log.info("inbound_dropped", { reason, channel: event.channel_id, id: event.id, peer: peer.userId });
			return "dropped";
		};
		if (event.guild_id === undefined) return drop("peer_dm");
		if (this.#guildIds !== undefined && !this.#guildIds.has(event.guild_id)) return drop("guild_not_allowed");
		const tokens = [`<@${botUserId}>`, `<@!${botUserId}>`];
		if (!tokens.some((token) => event.content.includes(token))) return drop("peer_not_mentioned");
		const onPeerInbound = this.#core.onPeerInbound;
		if (onPeerInbound === undefined) return drop("peer_unsupported");
		let conversationId = event.channel_id;
		let threadId: string | undefined;
		const info = await this.#port.channelInfo(event.channel_id);
		if (info === undefined) throw new Error(`unknown channel ${event.channel_id}`);
		if (info.parentId !== undefined && info.type !== 0) {
			conversationId = info.parentId;
			threadId = event.channel_id;
		}
		if (conversationId === this.#logChannel) return drop("log_channel");
		// A root's keys are those of the thread the owner path would open from it (Discord: thread id = message id).
		const root = threadId ?? event.id;
		const threadRef = threadRefOf(conversationId, root);
		// An owner-muted thread stays quiet for peers too, and a peer mention never releases the mute.
		if (this.#core.isThreadMuted?.(threadRef) === true) return drop("thread_muted");
		let text = event.content;
		for (const token of tokens) text = text.split(token).join(" ");
		text = text.trim();
		const quoted = (event.embeds ?? [])
			.flatMap((embed) => [embed.title, embed.description])
			.filter((part): part is string => typeof part === "string" && part !== "");
		const opensThread = threadId === undefined && this.#core.knowsThread?.(threadRef) !== true;
		const result = normalizePeerInbound({
			peer,
			text,
			quoted,
			platformMessageId: threadRefOf(conversationId, event.id),
			// A peer's text is fenced, never a command: its origin is always the thread's.
			originKey: originKeyForMessage(conversationId, "channel", event.id, threadId, "", "discord"),
			threadRef,
		});
		if (!result.accept) return drop(result.reason);
		const { inbound } = result;
		const outcome = onPeerInbound(inbound, {
			turns: this.#peerHopLimit.turns,
			windowMs: this.#peerHopLimit.windowMinutes * 60_000,
		});
		if (outcome.duplicate) {
			this.#log.info("inbound_duplicate", { id: inbound.platformMessageId });
			return "duplicate";
		}
		if (outcome.dropped !== undefined) {
			drop(outcome.dropped);
			if (outcome.dropped === "peer_hop_cap" && outcome.notice === true) {
				// No bot mention in the notice: it must not invite another peer reply. A root gets it as a reply, no thread.
				await this.postNotice(conversationId, PEER_HOP_NOTICE, root);
			}
			return "dropped";
		}
		if (opensThread) await this.#startThread(conversationId, event, text, false);
		await this.#beginStatus(
			threadRef,
			conversationId,
			root,
			{ channelId: event.channel_id, messageId: event.id },
			inbound.originKey,
			{ showStatus: true },
		);
		return "recorded";
	}

	/**
	 * Downloads an owner message's attachments (at most `MAX_INBOUND_FILES`) into `<mediaRoot>/inbound/<message id>/`
	 * and returns their prompt notes. A file whose declared size is over its cap is refused without a download.
	 */
	async #collectAttachments(event: DiscordMessageEvent, files: ReadonlyArray<DiscordAttachment>): Promise<string[]> {
		const mediaRoot = this.#mediaRoot;
		if (mediaRoot === undefined) return [`[첨부 실패: ${files.length}개 — 미디어 저장이 구성되지 않았습니다]`];
		const dir = join(mediaRoot, "inbound", event.id);
		const where = { channel: event.channel_id, id: event.id };
		const notes = await Promise.all(
			files.slice(0, MAX_INBOUND_FILES).map((file) => {
				const image = (file.content_type ?? "").startsWith("image/");
				const cap = image ? MAX_INBOUND_IMAGE_BYTES : MAX_INBOUND_DOC_BYTES;
				if (file.size > cap) {
					this.#log.warn("attachment_too_large", { ...where, size: file.size, max: cap });
					return `[첨부 실패: ${oneLine(file.filename, 120)} — too_large (${file.size} > ${cap} bytes)]`;
				}
				return saveInboundAttachment({
					file: { id: file.id, name: file.filename, mimetype: file.content_type, url: file.url },
					dir,
					where,
					log: this.#log,
					download: (args) => this.#transport.downloadAttachment(args),
				});
			}),
		);
		if (files.length > MAX_INBOUND_FILES) {
			notes.push(`[첨부 생략: ${files.length - MAX_INBOUND_FILES}개 — 메시지당 최대 ${MAX_INBOUND_FILES}개]`);
		}
		return notes;
	}

	/**
	 * Starts the message's thread (or finds it started); a refusal leaves a notice and fails the message. `known`: the
	 * thread is there already (a caller that recorded the message first asks before recording).
	 */
	async #startThread(
		conversationId: string,
		event: DiscordMessageEvent,
		text: string,
		known = this.#core.knowsThread?.(threadRefOf(conversationId, event.id)) === true,
	): Promise<void> {
		if (!known) {
			const line = progressLine(text.split("\n")[0] ?? "");
			const name = (line === "" ? "ompbot" : line).slice(0, THREAD_NAME_MAX);
			try {
				await this.#transport.startThread({ channelId: conversationId, messageId: event.id, name });
			} catch (err) {
				if (!(err instanceof DiscordCallError && err.code === THREAD_EXISTS)) {
					// Once per message: a backfill retry of the same refused message fails again without a second notice.
					if (this.#threadNoticeSent.has(event.id)) throw err;
					if (this.#threadNoticeSent.size >= THREAD_NOTICE_MEMORY) this.#threadNoticeSent.clear();
					this.#threadNoticeSent.add(event.id);
					await this.#postText(
						conversationId,
						event.id,
						`⚠️ 스레드를 만들지 못해 이 메시지를 받지 못했습니다(${oneLine(errorText(err), 120)}). 봇의 스레드 만들기·스레드 글쓰기 권한을 확인해 주세요.`,
						"thread_start_notice_failed",
					);
					throw err;
				}
			}
		}
		this.#port.remember({ id: event.id, type: PUBLIC_THREAD, parentId: conversationId, guildId: event.guild_id });
	}

	/**
	 * An owner reply to an approval card settles it: in a DM or channel the reply points at the card message, inside a
	 * thread started from the card the thread is the card. `undefined`: no card behind it, the normal path goes on.
	 */
	async #processCardReply(
		event: DiscordMessageEvent,
		conversationId: string,
		threadId: string | undefined,
		text: string,
		spot: MessageSpot,
		injected: boolean,
	): Promise<IngestOutcome | undefined> {
		const onCardReply = this.#core.onCardReply;
		if (onCardReply === undefined || text === "") return undefined;
		const platformMessageId = threadRefOf(conversationId, event.id);
		const cards = [event.message_reference?.message_id, threadId].filter(
			(id): id is string => id !== undefined && id !== event.id,
		);
		for (const card of cards) {
			const threadRef = threadRefOf(conversationId, card);
			const result = onCardReply({ threadRef, platformMessageId, text, injected });
			if (result === undefined) continue;
			if (result.kind === "injected_rejected") return "card_rejected";
			if (result.kind === "duplicate") {
				this.#log.info("inbound_duplicate", { id: platformMessageId });
				return "duplicate";
			}
			if (result.kind === "settled") return "recorded";
			const outcome = await this.#core.onInbound({
				platformMessageId,
				originKey: result.originKey,
				text,
				threadRef,
				ownerVerified: true,
			});
			if (outcome?.duplicate) {
				this.#log.info("inbound_duplicate", { id: platformMessageId });
				return "duplicate";
			}
			await this.#beginStatus(threadRef, conversationId, card, spot, result.originKey, {
				showStatus: true,
				typing: true,
			});
			return "recorded";
		}
		return undefined;
	}

	/** `!shutup` / `!unshutup`: a server thread's durable mute; a DM has nothing to mute, so it gets a hint. */
	async #runMuteCommand(
		command: ThreadMuteCommand,
		conversationId: string,
		threadId: string,
		context: { ref: string; muted: boolean } | undefined,
	): Promise<IngestOutcome> {
		if (context === undefined) {
			await this.#postText(
				conversationId,
				threadId,
				"🤫 스레드 뮤트(!shutup)는 서버 채널이나 스레드에서만 쓸 수 있습니다. DM은 항상 반응합니다.",
				"thread_mute_notice_failed",
			);
			return "recorded";
		}
		if (this.#core.setThreadMute === undefined) return "dropped";
		const muted = command === "shutup";
		this.#core.setThreadMute(context.ref, muted);
		this.#log.info("thread_mute", { thread: context.ref, muted, via: "command" });
		const text = muted
			? "🤫 이 스레드를 뮤트했습니다. 이 스레드의 메시지에는 반응하지 않습니다. 해제는 !unshutup 또는 저를 멘션하는 것입니다."
			: context.muted
				? "🔊 스레드 뮤트를 해제했습니다. 이제 이 스레드에서 다시 반응합니다."
				: "🔊 이 스레드는 뮤트되어 있지 않습니다.";
		await this.#postText(conversationId, threadId, text, "thread_mute_notice_failed");
		return "recorded";
	}

	// ---- 👀 and the status message ----

	async #acknowledge(spot: MessageSpot, originKey: string): Promise<void> {
		try {
			await this.#call("react", () => this.#transport.addReaction({ ...spot, emoji: toDiscordEmoji("eyes") }));
			this.#log.info("inbound_ack", { origin: originKey, id: spot.messageId });
		} catch (err) {
			this.#log.warn("ack_failed", { origin: originKey, id: spot.messageId, error: errorText(err) });
		}
	}

	/**
	 * Registers the thread before any await, so a delivery finishing it meanwhile waits for `setup`. `typing`: an owner
	 * message whose turn shows its status also gets the typing indicator (a peer's never does).
	 */
	#beginStatus(
		threadRef: string,
		conversationId: string,
		root: string,
		spot: MessageSpot,
		originKey: string,
		options: { showStatus: boolean; typing?: boolean },
	): Promise<void> {
		const typing = options.typing === true ? this.#startTyping(threadRef, conversationId, root) : undefined;
		const ack = this.#acknowledge(spot, originKey);
		const existing = this.#statuses.get(threadRef);
		if (existing !== undefined && existing.final === undefined) {
			existing.reactions.set(spot.messageId, spot.channelId);
			existing.setup = Promise.all([existing.setup, ack]).then(() => undefined);
			return Promise.all([existing.setup, typing]).then(() => undefined);
		}
		const now = this.#clock.now();
		const entry: StatusEntry = {
			conversationId,
			root,
			statusChannel: undefined,
			statusId: undefined,
			startedAt: now,
			lastUpdateAt: now,
			reactions: new Map([[spot.messageId, spot.channelId]]),
			setup: Promise.resolve(),
			showStatus: options.showStatus,
			final: undefined,
			stalled: false,
			progress: undefined,
			finalAction: "update",
			statusDone: false,
			reactionsDone: false,
		};
		this.#statuses.set(threadRef, entry);
		const created = options.showStatus ? this.#createStatus(threadRef, entry) : Promise.resolve();
		entry.setup = Promise.all([ack, created]).then(() => undefined);
		return Promise.all([entry.setup, typing]).then(() => undefined);
	}

	// ---- typing indicator ----

	/**
	 * Types once at once, then every `TYPING_INTERVAL_MS` on the adapter's own timer, until the first answer, the turn's
	 * end, `TYPING_MAX_MS` or a failed call. One entry per thread: a second message of the same turn adds nothing. A
	 * restart drain types nothing (the message waits for the next process).
	 */
	async #startTyping(threadRef: string, conversationId: string, root: string): Promise<void> {
		if (this.#typing.has(threadRef) || this.#core.isDraining?.() === true) return;
		const typing: TypingEntry = {
			channelId: undefined,
			startedAt: this.#clock.now(),
			handle: undefined,
			stopped: false,
		};
		this.#typing.set(threadRef, typing);
		try {
			typing.channelId = (await this.#port.destination(conversationId, root)).channelId;
		} catch (err) {
			this.#log.warn("discord_typing_failed", { thread: threadRef, error: errorText(err) });
			this.#haltTyping(typing);
			return;
		}
		if (typing.stopped) return;
		typing.handle = this.#typingTimers.set(() => this.#sendTyping(threadRef, typing), TYPING_INTERVAL_MS);
		await this.#sendTyping(threadRef, typing);
	}

	/** One typing call; a failure (429 included) is logged once and stops this thread's typing, nothing else. */
	async #sendTyping(threadRef: string, typing: TypingEntry): Promise<void> {
		const channelId = typing.channelId;
		if (typing.stopped || channelId === undefined) return;
		if (this.#clock.now() - typing.startedAt > TYPING_MAX_MS) {
			this.#haltTyping(typing);
			return;
		}
		// Another thread's 429 blocked the route: skip this beat without a call.
		if (this.#isBlocked("typing")) return;
		try {
			await this.#call("typing", () => this.#transport.triggerTyping(channelId));
		} catch (err) {
			if (typing.stopped) return;
			this.#log.warn("discord_typing_failed", { thread: threadRef, error: errorText(err) });
			this.#haltTyping(typing);
		}
	}

	#haltTyping(typing: TypingEntry): void {
		typing.stopped = true;
		if (typing.handle !== undefined) this.#typingTimers.clear(typing.handle);
		typing.handle = undefined;
	}

	/** Stops the thread's typing; `forget`: the turn is over, so the thread's next turn types again. */
	#stopTyping(threadRef: string, forget: boolean): void {
		const typing = this.#typing.get(threadRef);
		if (typing === undefined) return;
		this.#haltTyping(typing);
		if (forget) this.#typing.delete(threadRef);
	}

	async #createStatus(threadRef: string, entry: StatusEntry): Promise<void> {
		try {
			const destination = await this.#port.destination(entry.conversationId, entry.root);
			const posted = await this.#call("post", () =>
				this.#transport.createMessage({
					channelId: destination.channelId,
					content: `⏳ 작업 중 · ${formatElapsed(0)}`,
					messageReference: destination.messageReference,
					allowedMentions: { parse: [] },
				}),
			);
			entry.statusChannel = destination.channelId;
			entry.statusId = posted.id;
		} catch (err) {
			this.#log.warn("status_create_failed", { thread: threadRef, error: errorText(err) });
		}
	}

	async tick(): Promise<void> {
		for (const [threadRef, entry] of [...this.#statuses]) {
			if (entry.final !== undefined) await this.#flushFinal(threadRef, entry);
			else if (this.#clock.now() - entry.lastUpdateAt >= this.#statusIntervalMs) {
				await this.#updateRunning(threadRef, entry);
			}
		}
	}

	async setStalled(threadRef: string, stalled: boolean): Promise<void> {
		const entry = this.#statuses.get(threadRef);
		if (entry === undefined || entry.final !== undefined) return;
		entry.stalled = stalled;
		await entry.setup;
		if (entry.final === undefined) await this.#updateRunning(threadRef, entry);
	}

	async setProgress(threadRef: string, progress: TurnProgress): Promise<void> {
		const entry = this.#statuses.get(threadRef);
		if (entry === undefined || entry.final !== undefined) return;
		entry.progress = progress;
		await entry.setup;
		if (entry.final === undefined && this.#clock.now() - entry.lastUpdateAt >= this.#statusIntervalMs) {
			await this.#updateRunning(threadRef, entry);
		}
	}

	async #updateRunning(threadRef: string, entry: StatusEntry): Promise<void> {
		const { statusChannel, statusId } = entry;
		if (statusChannel === undefined || statusId === undefined) return;
		const content = runningStatusText(entry.stalled, this.#clock.now() - entry.startedAt, entry.progress);
		try {
			await this.#call("edit", () =>
				this.#transport.editMessage({
					channelId: statusChannel,
					messageId: statusId,
					content,
					allowedMentions: { parse: [] },
				}),
			);
			entry.lastUpdateAt = this.#clock.now();
		} catch (err) {
			if (err instanceof DiscordRateLimitedError) return;
			entry.lastUpdateAt = this.#clock.now();
			this.#log.warn("status_update_failed", { thread: threadRef, error: errorText(err) });
		}
	}

	/**
	 * Marks the turn finished: the status message is deleted (`delete`: the answer carries the footer) or becomes
	 * ✅/⚠️ (`update`), 👀 is removed and the result mark added. Retried by tick() under a rate limit.
	 */
	async finishStatus(threadRef: string, outcome: FinalOutcome, action: "delete" | "update" = "update"): Promise<void> {
		this.#stopTyping(threadRef, true);
		let entry = this.#statuses.get(threadRef);
		if (entry === undefined) {
			const parsed = parseThreadRef(threadRef);
			if (parsed === undefined) return;
			// After a restart nothing is tracked; the thread root (in the conversation channel) carries the first 👀.
			entry = {
				conversationId: parsed.channel,
				root: parsed.threadTs,
				statusChannel: undefined,
				statusId: undefined,
				startedAt: this.#clock.now(),
				lastUpdateAt: this.#clock.now(),
				reactions: new Map([[parsed.threadTs, parsed.channel]]),
				setup: Promise.resolve(),
				showStatus: false,
				final: undefined,
				stalled: false,
				progress: undefined,
				finalAction: "update",
				statusDone: false,
				reactionsDone: false,
			};
			this.#statuses.set(threadRef, entry);
		}
		entry.final = outcome;
		entry.finalAction = action;
		await this.#flushFinal(threadRef, entry);
	}

	async #flushFinal(threadRef: string, entry: StatusEntry): Promise<void> {
		const outcome = entry.final;
		if (outcome === undefined) return;
		await entry.setup;
		const { statusChannel, statusId } = entry;
		if (!entry.statusDone && (statusChannel === undefined || statusId === undefined)) entry.statusDone = true;
		if (!entry.statusDone && statusChannel !== undefined && statusId !== undefined) {
			if (entry.finalAction === "delete") {
				try {
					await this.#call("delete", () =>
						this.#transport.deleteMessage({ channelId: statusChannel, messageId: statusId }),
					);
					entry.statusDone = true;
				} catch (err) {
					// Rate limited: tick() deletes again. Refused: the status stays and shows the final label instead.
					if (!(err instanceof DiscordRateLimitedError)) {
						this.#log.warn("status_delete_failed", { thread: threadRef, error: errorText(err) });
						entry.finalAction = "update";
					}
				}
			}
			if (!entry.statusDone && entry.finalAction === "update") {
				const content = `${FINAL_MARKS[outcome].label} · ${formatElapsed(this.#clock.now() - entry.startedAt)}`;
				try {
					await this.#call("edit", () =>
						this.#transport.editMessage({
							channelId: statusChannel,
							messageId: statusId,
							content,
							allowedMentions: { parse: [] },
						}),
					);
					entry.statusDone = true;
				} catch (err) {
					if (!(err instanceof DiscordRateLimitedError)) {
						entry.statusDone = true;
						this.#log.warn("status_final_failed", { thread: threadRef, error: errorText(err) });
					}
				}
			}
		}
		if (!entry.reactionsDone) {
			const mark = toDiscordEmoji(FINAL_MARKS[outcome].mark);
			const eyes = toDiscordEmoji("eyes");
			let pending = false;
			for (const [messageId, channelId] of entry.reactions) {
				const target = { channelId, messageId };
				pending =
					(await this.#swapReaction(() => this.#transport.removeReaction({ ...target, emoji: eyes }))) || pending;
				// A registered [TASK] root keeps the task sweep's status reaction; the turn mark would fight it.
				if (messageId === entry.root && this.#isTaskRoot?.(threadRefOf(entry.conversationId, messageId)) === true) {
					continue;
				}
				pending = (await this.#swapReaction(() => this.#transport.addReaction({ ...target, emoji: mark }))) || pending;
			}
			entry.reactionsDone = !pending;
		}
		if (entry.statusDone && entry.reactionsDone) this.#statuses.delete(threadRef);
	}

	/** True when the step must be retried later (rate limited); other errors (unknown reaction) are final. */
	async #swapReaction(fn: () => Promise<void>): Promise<boolean> {
		try {
			await this.#call("react", fn);
			return false;
		} catch (err) {
			if (err instanceof DiscordRateLimitedError) return true;
			this.#log.info("reaction_skipped", { error: errorText(err) });
			return false;
		}
	}

	// ---- deliveries ----

	pumpDeliveries(): Promise<number> {
		return this.#pump.pump();
	}

	#sender(): DeliverySender {
		return {
			isBlocked: () => this.#isBlocked("post"),
			blockedUntil: () => this.#blockedUntil.get("post") ?? this.#clock.now(),
			blockedReason: () => "discord createMessage",
			send: (delivery) => this.#send(delivery),
			afterSent: (delivery) => this.#finishDelivered(delivery),
		};
	}

	/** Mention tokens in the port's syntax, thread-link tokens as ` · [스레드 보기](<permalink>)` (none on failure). */
	async #resolveTokens(body: string): Promise<string> {
		const text = renderMentions(body, this.#port);
		if (!text.includes(THREAD_LINK_PREFIX)) return text;
		let out = "";
		let last = 0;
		for (const match of text.matchAll(/\{\{thread-link:([0-9]+):([0-9]+)\}\}/g)) {
			out += text.slice(last, match.index);
			last = match.index + match[0].length;
			const [, conversationId = "", messageId = ""] = match;
			try {
				const url = await this.#port.permalink({
					platform: "discord",
					conversationId,
					messageId,
					threadId: messageId,
				});
				if (url !== undefined) out += ` · [스레드 보기](${url})`;
			} catch (err) {
				this.#log.warn("permalink_failed", { channel: conversationId, error: errorText(err) });
			}
		}
		return out + text.slice(last);
	}

	async #send(delivery: DeliveryItem): Promise<DeliverySendResult> {
		const target = parseThreadRef(delivery.threadRef);
		if (target === undefined) {
			return { kind: "failed", error: `invalid thread_ref ${delivery.threadRef}`, outcome: "definitive", sentParts: 0 };
		}
		const topLevel = target.threadTs === TOP_LEVEL_TS;
		const cancelled = new Set(delivery.cancelThreadRefs ?? []);
		const outcome = delivery.body.startsWith("[turn failed]") ? "failed" : "done";
		const footer =
			delivery.keepStatus || cancelled.has(delivery.threadRef)
				? undefined
				: this.#footerOf(delivery.threadRef, outcome);
		let sent = delivery.sentParts ?? 0;
		// A top-level answer is one message: parts 2+ reply to part 1 instead of standing alone.
		let replyTo = topLevel && sent > 0 ? (delivery.replyTs ?? undefined) : undefined;
		const deferred = (err: DiscordRateLimitedError): DeliverySendResult => ({
			kind: "deferred",
			error: err,
			retry: {
				at: this.#blockedUntil.get("post") ?? this.#clock.now() + err.retryAfterMs,
				sentParts: sent,
				...(topLevel && replyTo !== undefined ? { replyTs: replyTo } : {}),
			},
		});
		let parts: DiscordPart[];
		let destination: Destination | undefined;
		try {
			const body = await this.#resolveTokens(delivery.body);
			const rendered = renderDiscordMessages(body, delivery.redelivered, footer);
			if (rendered.cardIssues !== undefined) {
				this.#log.warn("card_spec_invalid", {
					id: delivery.deliveryId,
					issues: rendered.cardIssues.slice(0, 5).map((issue) => issue.slice(0, 200)),
				});
			}
			parts = rendered;
			sent = Math.min(sent, parts.length);
			destination = topLevel ? undefined : await this.#port.destination(target.channel, target.threadTs);
		} catch (err) {
			// Nothing was posted for this attempt: a failed lookup is a definitive failure, retried with backoff.
			if (err instanceof DiscordRateLimitedError) return deferred(err);
			return { kind: "failed", error: errorText(err), outcome: "definitive", sentParts: sent };
		}
		try {
			for (const part of parts.slice(sent)) {
				const channelId = destination?.channelId ?? target.channel;
				const messageReference =
					destination === undefined
						? replyTo === undefined
							? undefined
							: { messageId: replyTo }
						: destination.messageReference;
				const posted = await this.#call("post", () =>
					this.#transport.createMessage({
						channelId,
						content: part.content,
						messageReference,
						allowedMentions: this.#port.allowedMentions(part.content),
						...(part.embeds === undefined ? {} : { embeds: part.embeds }),
					}),
				);
				if (topLevel) replyTo ??= posted.id;
				this.#stopTyping(delivery.threadRef, false);
				await this.#recordPost({ channel: channelId, ts: posted.id, deliveryId: delivery.deliveryId, part: sent });
				sent += 1;
			}
			return { kind: "sent", parts: parts.length };
		} catch (err) {
			if (err instanceof DiscordRateLimitedError) return deferred(err);
			// Discord refused the first message (4xx): nothing of the answer exists. Anything else — a network or 5xx
			// error, or a refusal after parts went out — may leave a partial answer, so it is never resent blindly.
			const definitive = sent === 0 && err instanceof DiscordCallError && err.kind === "definitive";
			return {
				kind: "failed",
				error: errorText(err),
				outcome: definitive ? "definitive" : "ambiguous",
				sentParts: sent,
			};
		}
	}

	/** After the confirm: the answer's thread (and every thread its op closed) gets its status finished. */
	async #finishDelivered(delivery: DeliveryItem): Promise<void> {
		if (delivery.keepStatus) return;
		const outcome = delivery.body.startsWith("[turn failed]") ? "failed" : "done";
		const cancelled = new Set(delivery.cancelThreadRefs ?? []);
		for (const threadRef of new Set([delivery.threadRef, ...(delivery.finishThreadRefs ?? [])])) {
			if (delivery.finishUntracked === false && !this.#statuses.has(threadRef)) continue;
			const final = cancelled.has(threadRef) ? "cancelled" : outcome;
			await this.finishStatus(
				threadRef,
				final,
				threadRef === delivery.threadRef && final !== "cancelled" ? "delete" : "update",
			);
		}
	}

	async #recordPost(post: { channel: string; ts: string; deliveryId: number; part: number }): Promise<void> {
		try {
			await this.#deliveries.recordPost?.(post);
		} catch (err) {
			this.#log.warn("delivery_post_record_failed", { id: post.deliveryId, part: post.part, error: errorText(err) });
		}
	}

	/** `✅ 00:42 · 도구 6회` for a thread whose running status this answer replaces. */
	#footerOf(threadRef: string, outcome: "done" | "failed"): string | undefined {
		const entry = this.#statuses.get(threadRef);
		if (entry === undefined || entry.final !== undefined || !entry.showStatus) return undefined;
		const mark = FINAL_MARKS[outcome].label.split(" ")[0];
		const tools = entry.progress?.tools ?? 0;
		return `${mark} ${formatElapsed(this.#clock.now() - entry.startedAt)}${tools > 0 ? ` · 도구 ${tools}회` : ""}`;
	}
}
