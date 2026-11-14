// Discord's inbound path and delivery sender: the same rules as the Slack adapter (owner gate, addressing,
// 👀 + ⏳ status, the shared delivery pump), on Discord's shapes (doc/plans/discord-channel.md §7–8).
import { join } from "node:path";
import type { ChannelAdapter, ChannelPolicy, OwnerIngest } from "../channel/adapter";
import {
	MAX_INBOUND_DOC_BYTES,
	MAX_INBOUND_FILES,
	MAX_INBOUND_IMAGE_BYTES,
	saveInboundAttachment,
} from "../channel/attachments";
import {
	guardInbound,
	isChannelMessageAddressed,
	recordInbound,
	recordPeerInbound,
	resolveThreadLinks,
	settleCardReply,
} from "../channel/inbound";
import { renderMentions } from "../channel/port";
import {
	answerFooter,
	DeliveryPump,
	type DeliverySendResult,
	deliverySender,
	finishDeliveryStatus,
} from "../channel/pump";
import { RetryAfterGate } from "../channel/retry";
import { type StatusEntry, StatusTracker } from "../channel/status";
import {
	cutCodePointSafe,
	DENIED_TEXT,
	errorText,
	type FinalOutcome,
	oneLine,
	progressLine,
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
	TOP_LEVEL_TS,
	threadRefOf,
} from "../core/normalize";
import { parseChatOrigin } from "../core/origin-key";
import type { Logger } from "../log";
import { DEFAULT_PEER_HOP_LIMIT, PEER_HOP_NOTICE, type PeerBotList } from "../slack/adapter";
import { type BackfillCursors, type BackfillTarget, DiscordBackfill, snowflakeTime } from "./backfill";
import { type Destination, type DiscordChannel, PUBLIC_THREAD, THREAD_EXISTS, THREAD_NAME_MAX } from "./channel";
import { toDiscordEmoji } from "./emoji";
import { type DiscordPart, renderDiscordMessages } from "./format";
import {
	type DiscordAttachment,
	DiscordCallError,
	type DiscordHandlers,
	type DiscordInteraction,
	type DiscordMessageEvent,
	DiscordRateLimitedError,
	type DiscordTransport,
} from "./transport";

/** Message types the bot reads: a plain message and a reply. Everything else is a system message. */
const READ_TYPES: ReadonlySet<number> = new Set([0, 19]);
const DM_CHANNEL = 1;
/** Interaction type of a message component (button click). */
const MESSAGE_COMPONENT = 3;
/** Interaction callback types: a message (with flags), and the deferred update that only acknowledges a click. */
const CHANNEL_MESSAGE = 4;
const DEFERRED_UPDATE_MESSAGE = 6;
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

/** One adapter-level block per kind of call: a 429 on posting must not stop status edits, and the other way round. */
type Route = "post" | "edit" | "delete" | "react" | "typing";

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
	readonly #status: StatusTracker;
	/** Typing per thread ref; a stopped entry stays until finishStatus so the same turn is not typed again. */
	readonly #typing = new Map<string, TypingEntry>();
	readonly #typingTimers: TypingTimers;
	readonly #gate: RetryAfterGate;
	readonly #pump: DeliveryPump;
	readonly #recovery: DiscordBackfill | undefined;
	/** Interactions already handled (a resumed gateway can replay one): insertion-ordered, capped. */
	readonly #seenInteractions = new Set<string>();
	/** Messages whose refused thread start already left the channel notice (`#startThread`). */
	readonly #threadNoticeSent = new Set<string>();
	/** Recovered server roots that opened their thread, until their scan's notice picks one (`#recoveryNotice`). */
	readonly #recoveredThreads = new Set<string>();
	#ready: Promise<string | undefined> = Promise.resolve(undefined);
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
		this.#typingTimers = options.typingTimers ?? INTERVAL_TIMERS;
		this.#gate = new RetryAfterGate({
			clock: options.clock,
			park: (route, retryAfterMs) => options.log.warn("discord_rate_limited", { route, retry_after_ms: retryAfterMs }),
		});
		this.#pump = new DeliveryPump({
			source: options.deliveries,
			sender: deliverySender({
				gate: this.#gate,
				key: "post",
				blockedReason: "discord createMessage",
				send: (delivery) => this.#send(delivery),
				finish: (delivery, result) => this.#finishDelivered(delivery, result),
			}),
			clock: options.clock,
			log: options.log,
		});
		this.#status = new StatusTracker({
			clock: options.clock,
			intervalMs: STATUS_MIN_INTERVAL_MS,
			platform: {
				create: (entry, text) => this.#createStatus(entry, text),
				edit: (entry, text, final) => this.#editStatus(entry, text, final),
				remove: (entry) => this.#removeStatus(entry),
				removeEyes: (target) =>
					this.#swapReaction(() =>
						this.#transport.removeReaction({
							channelId: target.channelId,
							messageId: target.messageId,
							emoji: toDiscordEmoji("eyes"),
						}),
					),
				addMark: (target, mark) =>
					this.#swapReaction(() =>
						this.#transport.addReaction({
							channelId: target.channelId,
							messageId: target.messageId,
							emoji: toDiscordEmoji(mark),
						}),
					),
				isTaskRoot: (threadRef) => this.#isTaskRoot?.(threadRef),
			},
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
	 * such as 4004/4014 — leaves Discord off and is logged; every other part of the daemon keeps running.
	 */
	async start(): Promise<void> {
		const handlers: DiscordHandlers = {
			message: (event) => this.handleMessage(event),
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

	async #call<T>(route: Route, fn: () => Promise<T>): Promise<T> {
		return this.#gate.call(
			route,
			fn,
			(remainingMs) => new DiscordRateLimitedError(remainingMs),
			(err) => (err instanceof DiscordRateLimitedError ? err.retryAfterMs : undefined),
		);
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

	// ---- button clicks ----

	/**
	 * A button click (INTERACTION_CREATE type 3). Discord voids the interaction unless it is answered within 3 s, so
	 * the answer goes out first: a stranger gets an ephemeral denial, the owner a deferred update (type 6) — then the
	 * core's onAction runs, the way a Slack block action does, and edits the card itself if it needs to.
	 */
	async handleInteraction(interaction: DiscordInteraction): Promise<void> {
		if (interaction.type !== MESSAGE_COMPONENT) return;
		if (this.#seenInteractions.has(interaction.id)) {
			this.#log.info("interaction_duplicate", { id: interaction.id });
			return;
		}
		this.#seenInteractions.add(interaction.id);
		if (this.#seenInteractions.size > SEEN_INTERACTIONS_MAX) {
			const oldest = this.#seenInteractions.values().next().value;
			if (oldest !== undefined) this.#seenInteractions.delete(oldest);
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

	// ---- inbound messages ----

	async handleMessage(event: DiscordMessageEvent): Promise<void> {
		await guardInbound(this.#log, { channel: event.channel_id, id: event.id }, this.#onInboundFailure, () =>
			this.#processMessage(event, []),
		);
	}

	#drop(event: DiscordMessageEvent, reason: string, peer?: string): IngestOutcome {
		this.#log.info("inbound_dropped", { reason, channel: event.channel_id, id: event.id, ...(peer && { peer }) });
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
			// A message that mentions a peer bot but not this bot is meant for the peer, whatever the channel policy says.
			const forPeer =
				!mentioned &&
				this.#peerBots.some(
					(p) =>
						text.includes(`<@${p.userId}>`) ||
						text.includes(`<@!${p.userId}>`) ||
						(event.mentions?.some((user) => user.id === p.userId) ?? false),
				);
			const addressed = isChannelMessageAddressed(this.#core, {
				// A reply to this bot's post addresses it like a mention, unless its text mentions only a peer.
				mentioned: mentioned || (repliesToBot && !forPeer),
				forPeer,
				threadRef: threadId === undefined ? undefined : threadRefOf(conversationId, threadId),
				requireMention: this.#requireMention,
				mentionFree: this.#mentionFree.has(conversationId),
			});
			if (!addressed) return this.#drop(event, "not_addressed");
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
		const recorded = inbound;
		return recordInbound(this.#core, this.#log, recorded, (thread, showStatus) =>
			this.#beginStatus(recorded.threadRef, thread.channel, thread.threadTs, spot, recorded.originKey, {
				showStatus,
				typing: showStatus,
			}),
		);
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
		const drop = (reason: string): IngestOutcome => this.#drop(event, reason, peer.userId);
		if (event.guild_id === undefined) return drop("peer_dm");
		if (this.#guildIds !== undefined && !this.#guildIds.has(event.guild_id)) return drop("guild_not_allowed");
		const tokens = [`<@${botUserId}>`, `<@!${botUserId}>`];
		if (!tokens.some((token) => event.content.includes(token))) {
			await this.#notePeerSeen(event, peer.userId);
			return drop("peer_not_mentioned");
		}
		if (this.#core.onPeerInbound === undefined) return drop("peer_unsupported");
		const { conversationId, threadId } = await this.#serverPlace(event);
		if (conversationId === this.#logChannel) return drop("log_channel");
		// A root's keys are those of the thread the owner path would open from it (Discord: thread id = message id).
		const root = threadId ?? event.id;
		const threadRef = threadRefOf(conversationId, root);
		// Before the hop cap: a post dropped there still shows the peer is awake.
		this.#core.onPeerSeen?.({ threadRef, peerUserId: peer.userId, at: snowflakeTime(event.id) });
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
		// A root gets the cap notice as a reply, no thread.
		const refused = await recordPeerInbound(this.#core, this.#log, inbound, this.#peerHopLimit, drop, () =>
			this.postNotice(conversationId, PEER_HOP_NOTICE, root),
		);
		if (refused !== undefined) return refused;
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

	/** A server message's conversation (a thread's parent) and thread (undefined at a channel root). */
	async #serverPlace(event: DiscordMessageEvent): Promise<{ conversationId: string; threadId: string | undefined }> {
		const info = await this.#port.channelInfo(event.channel_id);
		if (info === undefined) throw new Error(`unknown channel ${event.channel_id}`);
		return info.parentId !== undefined && info.type !== 0
			? { conversationId: info.parentId, threadId: event.channel_id }
			: { conversationId: event.channel_id, threadId: undefined };
	}

	/**
	 * A peer post that does not mention this bot is never taken, but it still answers this bot's calls to that peer in
	 * its thread (`onPeerSeen`), outside the #log channel. A failed channel lookup is logged and the
	 * post dropped as before.
	 */
	async #notePeerSeen(event: DiscordMessageEvent, peerUserId: string): Promise<void> {
		const onPeerSeen = this.#core.onPeerSeen;
		if (onPeerSeen === undefined) return;
		let place: { conversationId: string; threadId: string | undefined };
		try {
			place = await this.#serverPlace(event);
		} catch (err) {
			this.#log.warn("peer_seen_lookup_failed", { channel: event.channel_id, id: event.id, error: errorText(err) });
			return;
		}
		if (place.conversationId === this.#logChannel) return;
		const threadRef = threadRefOf(place.conversationId, place.threadId ?? event.id);
		onPeerSeen({ threadRef, peerUserId, at: snowflakeTime(event.id) });
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
		if (this.#core.onCardReply === undefined || text === "") return undefined;
		const platformMessageId = threadRefOf(conversationId, event.id);
		const cards = [event.message_reference?.message_id, threadId].filter(
			(id): id is string => id !== undefined && id !== event.id,
		);
		for (const card of cards) {
			const threadRef = threadRefOf(conversationId, card);
			const settled = await settleCardReply(
				this.#core,
				this.#log,
				{ threadRef, platformMessageId, text, injected },
				(originKey) =>
					this.#beginStatus(threadRef, conversationId, card, spot, originKey, { showStatus: true, typing: true }),
			);
			if (settled !== undefined) return settled;
		}
		return undefined;
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
		const setup = this.#status.begin(threadRef, {
			channel: conversationId,
			root,
			reaction: spot,
			showStatus: options.showStatus,
			setup: this.#acknowledge(spot, originKey),
		});
		return Promise.all([setup, typing]).then(() => undefined);
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
		if (this.#gate.isBlocked("typing")) return;
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

	async #createStatus(entry: StatusEntry, text: string): Promise<void> {
		try {
			const destination = await this.#port.destination(entry.channel, entry.root);
			const posted = await this.#call("post", () =>
				this.#transport.createMessage({
					channelId: destination.channelId,
					content: text,
					messageReference: destination.messageReference,
					allowedMentions: { parse: [] },
				}),
			);
			entry.statusChannel = destination.channelId;
			entry.statusId = posted.id;
		} catch (err) {
			this.#log.warn("status_create_failed", { thread: threadRefOf(entry.channel, entry.root), error: errorText(err) });
		}
	}

	async tick(): Promise<void> {
		await this.#status.tick();
	}

	async setStalled(threadRef: string, stalled: boolean): Promise<void> {
		await this.#status.setStalled(threadRef, stalled);
	}

	async setProgress(threadRef: string, progress: TurnProgress): Promise<void> {
		await this.#status.setProgress(threadRef, progress);
	}

	/** `true`: rate limited, the tracker retries on a later tick. A refusal is one warn line and `false`. */
	async #editStatus(entry: StatusEntry, text: string, final: boolean): Promise<boolean> {
		const { statusChannel, statusId } = entry;
		if (statusChannel === undefined || statusId === undefined) return false;
		try {
			await this.#call("edit", () =>
				this.#transport.editMessage({
					channelId: statusChannel,
					messageId: statusId,
					content: text,
					allowedMentions: { parse: [] },
				}),
			);
			return false;
		} catch (err) {
			if (err instanceof DiscordRateLimitedError) return true;
			this.#log.warn(final ? "status_final_failed" : "status_update_failed", {
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
			await this.#call("delete", () =>
				this.#transport.deleteMessage({ channelId: statusChannel, messageId: statusId }),
			);
			return false;
		} catch (err) {
			if (err instanceof DiscordRateLimitedError) return true;
			this.#log.warn("status_delete_failed", { thread: threadRefOf(entry.channel, entry.root), error: errorText(err) });
			entry.finalAction = "update";
			return false;
		}
	}

	/**
	 * Marks the turn finished: the status message is deleted (`delete`: the answer carries the footer) or becomes
	 * ✅/⚠️ (`update`), 👀 is removed and the result mark added. Retried by tick() under a rate limit.
	 */
	async finishStatus(threadRef: string, outcome: FinalOutcome, action: "delete" | "update" = "update"): Promise<void> {
		this.#stopTyping(threadRef, true);
		await this.#status.finish(threadRef, outcome, action);
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

	async #send(delivery: DeliveryItem): Promise<DeliverySendResult> {
		const target = parseThreadRef(delivery.threadRef);
		if (target === undefined) {
			return { kind: "failed", error: `invalid thread_ref ${delivery.threadRef}`, outcome: "definitive", sentParts: 0 };
		}
		const topLevel = target.threadTs === TOP_LEVEL_TS;
		const footer = answerFooter(delivery, (threadRef, outcome) => this.#status.footer(threadRef, outcome));
		let sent = delivery.sentParts ?? 0;
		// A top-level answer is one message: parts 2+ reply to part 1 instead of standing alone.
		let replyTo = topLevel && sent > 0 ? (delivery.replyTs ?? undefined) : undefined;
		const deferred = (err: DiscordRateLimitedError): DeliverySendResult => ({
			kind: "deferred",
			error: err,
			retry: {
				at: this.#gate.untilOf("post") ?? this.#clock.now() + err.retryAfterMs,
				sentParts: sent,
				...(topLevel && replyTo !== undefined ? { replyTs: replyTo } : {}),
			},
		});
		let parts: DiscordPart[];
		let destination: Destination | undefined;
		try {
			// Mention tokens in the port's syntax, then thread-link tokens.
			const links = /\{\{thread-link:([0-9]+):([0-9]+)\}\}/g;
			const body = await resolveThreadLinks(renderMentions(delivery.body, this.#port), links, this.#log, (id, root) =>
				this.#port.permalink({ platform: "discord", conversationId: id, messageId: root, threadId: root }),
			);
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

	/** After the confirm or once the answer is given up: the shared status finish over this adapter's statuses. */
	#finishDelivered(delivery: DeliveryItem, result: "sent" | "undelivered"): Promise<void> {
		return finishDeliveryStatus(delivery, result, {
			finishStatus: (threadRef, outcome, action) => this.finishStatus(threadRef, outcome, action),
			tracks: (threadRef) => this.#status.tracks(threadRef),
		});
	}
}
