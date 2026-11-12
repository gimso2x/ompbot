// Teams' inbound path and delivery sender (doc/plans/teams-channel.md TASK B): the owner gate on the Entra object id,
// the configured tenant only, a group chat only when the bot is mentioned, a 1:1 chat always. An accepted message
// gets a typing indicator at once; a turn still running after `longTurnMs` gets one `⏳ 작업 중` line, edited to its
// result at the end. Answers reply to the original Activity id through the shared delivery pump.
import type { ChannelAdapter, ChannelPolicy, OwnerIngest } from "../channel/adapter";
import { renderMentions } from "../channel/port";
import { DeliveryPump, type DeliverySender, type DeliverySendResult } from "../channel/pump";
import {
	FINAL_MARKS,
	type FinalOutcome,
	formatElapsed,
	runningStatusText,
	STATUS_MIN_INTERVAL_MS,
} from "../channel/text";
import type { AdapterClock, CoreSink, DeliveryItem, DeliverySource, IngestOutcome } from "../channel/types";
import type { TurnProgress } from "../core/mailbox";
import { isOwner, normalizeInbound, parseThreadRef, TOP_LEVEL_TS } from "../core/normalize";
import { chatOriginKey } from "../core/origin-key";
import type { Logger } from "../log";
import type { TeamsConversation } from "../store/db";
import type { TeamsAuth } from "./auth";
import type { TeamsChannel, TeamsConversations } from "./channel";
import { renderTeamsParts, stripMentions } from "./format";
import { TeamsServer } from "./server";
import { TeamsCallError, type TeamsConnector, TeamsRateLimitedError } from "./transport";
import { type TeamsActivity, teamsAlias } from "./types";

/** A turn running longer than this gets its `⏳ 작업 중` line. */
export const LONG_TURN_MS = 60_000;

export interface TeamsAdapterOptions {
	channel: TeamsChannel;
	conversations: TeamsConversations;
	core: CoreSink;
	deliveries: DeliverySource;
	tenantId: string;
	ownerAadObjectId: string;
	/** Users whose mentions get a read-only answer through `CoreSink.onGuestInbound`; everyone else is dropped. */
	guestAadObjectIds?: readonly string[] | undefined;
	/** `qa`: the owner's messages take the guest path too. Default `full`. */
	ownerMode?: "full" | "qa" | undefined;
	clock: AdapterClock;
	log: Logger;
	/** The endpoint to serve; absent: no listener (Activities only through `handleActivity`). */
	listen?: { hostname: string; port: number; auth: TeamsAuth } | undefined;
	longTurnMs?: number | undefined;
	statusIntervalMs?: number | undefined;
}

interface StatusEntry {
	alias: string;
	/** The owner Activity the turn answers (the status line replies to it). */
	root: string;
	startedAt: number;
	lastUpdateAt: number;
	statusId: string | undefined;
	stalled: boolean;
	progress: TurnProgress | undefined;
}

/** One accepted owner message, whichever way it came (a live Activity or `ingestOwner`). */
interface OwnerMessage {
	conversation: TeamsConversation;
	messageId: string;
	text: string;
	quoted: readonly string[];
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export class TeamsAdapter implements ChannelAdapter {
	readonly platform = "teams" as const;
	readonly #port: TeamsChannel;
	readonly #connector: TeamsConnector;
	readonly #conversations: TeamsConversations;
	readonly #core: CoreSink;
	readonly #deliveries: DeliverySource;
	readonly #tenantId: string;
	readonly #owner: string;
	readonly #guests: ReadonlySet<string>;
	readonly #ownerQa: boolean;
	readonly #clock: AdapterClock;
	readonly #log: Logger;
	readonly #listen: TeamsAdapterOptions["listen"];
	readonly #longTurnMs: number;
	readonly #statusIntervalMs: number;
	readonly #statuses = new Map<string, StatusEntry>();
	readonly #pump: DeliveryPump;
	/** Typing indicators in flight (tests and shutdown wait for them). */
	readonly #side = new Set<Promise<void>>();
	#server: TeamsServer | undefined;
	#boundPort: number | undefined;
	#upSince: number | undefined;
	#postBlockedUntil = 0;

	constructor(options: TeamsAdapterOptions) {
		this.#port = options.channel;
		this.#connector = options.channel.connector;
		this.#conversations = options.conversations;
		this.#core = options.core;
		this.#deliveries = options.deliveries;
		this.#tenantId = options.tenantId.toLowerCase();
		this.#owner = options.ownerAadObjectId.toLowerCase();
		this.#guests = new Set((options.guestAadObjectIds ?? []).map((id) => id.toLowerCase()));
		this.#ownerQa = options.ownerMode === "qa";
		this.#clock = options.clock;
		this.#log = options.log;
		this.#listen = options.listen;
		this.#longTurnMs = options.longTurnMs ?? LONG_TURN_MS;
		this.#statusIntervalMs = options.statusIntervalMs ?? STATUS_MIN_INTERVAL_MS;
		this.#pump = new DeliveryPump({
			source: options.deliveries,
			sender: this.#sender(),
			clock: options.clock,
			log: options.log,
		});
	}

	get botUserId(): string {
		return this.#connector.botId;
	}

	/** The port the endpoint listens on once started (`listen.port` 0 picks a free one). */
	get listenPort(): number | undefined {
		return this.#boundPort;
	}

	async start(): Promise<void> {
		const listen = this.#listen;
		if (listen === undefined) return;
		this.#server = new TeamsServer({
			hostname: listen.hostname,
			port: listen.port,
			auth: listen.auth,
			log: this.#log,
			onActivity: (activity) => this.handleActivity(activity).then(() => undefined),
		});
		try {
			this.#boundPort = this.#server.start();
			this.#upSince = this.#clock.now();
			this.#log.info("teams_listening", { host: listen.hostname, port: this.#boundPort });
		} catch (err) {
			// A taken port leaves Teams off; the rest of the daemon keeps running.
			this.#server = undefined;
			this.#log.error("teams_start_failed", { error: errorText(err) });
		}
	}

	async stop(): Promise<void> {
		await this.#server?.stop();
		this.#server = undefined;
		this.#upSince = undefined;
		await this.idle();
	}

	/** Resolves once no typing indicator is in flight. */
	async idle(): Promise<void> {
		await Promise.all([...this.#side]);
	}

	connectionState(): { state: "up" | "down"; since: number } | undefined {
		return this.#upSince === undefined ? undefined : { state: "up", since: this.#upSince };
	}

	/** Teams does not resend what the daemon missed: there is nothing to recover. */
	recover(): void {}

	/** Teams' policy lives under `channels.teams` (restart); the top-level Slack keys do not apply. */
	setChannelPolicy(_policy: ChannelPolicy): void {}

	// ---- inbound ----

	#drop(activity: { id?: string | undefined }, reason: string, from?: string): IngestOutcome {
		// `from` (the sender's Entra object id, not a secret) lets the operator add a guest to `guestAadObjectIds`.
		this.#log.info("inbound_dropped", { reason, platform: "teams", id: activity.id ?? "", ...(from ? { from } : {}) });
		return "dropped";
	}

	/** An authenticated Activity from the endpoint. Never throws: a failure is logged as `inbound_failed`. */
	async handleActivity(activity: TeamsActivity): Promise<IngestOutcome> {
		try {
			return await this.#processActivity(activity);
		} catch (err) {
			this.#log.error("inbound_failed", { platform: "teams", id: activity.id ?? "", error: errorText(err) });
			return "dropped";
		}
	}

	async #processActivity(activity: TeamsActivity): Promise<IngestOutcome> {
		if (activity.type !== "message") return this.#drop(activity, "subtype");
		const tenant = (activity.channelData?.tenant?.id ?? activity.conversation?.tenantId ?? "").toLowerCase();
		if (tenant !== this.#tenantId) return this.#drop(activity, "tenant_mismatch");
		const type = activity.conversation?.conversationType;
		// Team channels (threads under `;messageid=`) are outside this scope.
		const kind = type === "personal" ? "dm" : type === "groupChat" ? "ch" : undefined;
		if (kind === undefined) return this.#drop(activity, "conversation_type");
		if (activity.from?.id !== undefined && activity.from.id === this.botUserId) {
			return this.#drop(activity, "bot_message");
		}
		// The owner/guest gate comes before anything is stored, so a stranger leaves no trace but the log line.
		const aad = activity.from?.aadObjectId?.toLowerCase();
		const owner = isOwner(aad, this.#owner);
		const guest = !owner && aad !== undefined && this.#guests.has(aad);
		if (!owner && !guest) return this.#drop(activity, "not_owner", aad);
		const { id, serviceUrl } = activity;
		const conversationId = activity.conversation?.id;
		if (!id || !serviceUrl || !conversationId) return this.#drop(activity, "malformed");
		if (kind === "ch") {
			const botIds = [activity.recipient?.id, this.botUserId];
			const mentioned = (activity.entities ?? []).some(
				(entity) =>
					entity.type === "mention" && entity.mentioned?.id !== undefined && botIds.includes(entity.mentioned.id),
			);
			if (!mentioned) return this.#drop(activity, "not_addressed");
		}
		const conversation: TeamsConversation = {
			alias: teamsAlias(conversationId),
			conversationId,
			serviceUrl,
			tenantId: tenant,
			kind,
		};
		this.#conversations.upsertTeamsConversation(conversation);
		// A Teams 1:1 the owner wrote in stays a notice-home candidate, whichever path the message takes.
		if (owner) this.#conversations.markTeamsOwnerSpoke(conversation.alias);
		const text = stripMentions(activity.text ?? "");
		// The owner in a group chat or channel gets the qa run too: a full turn there would answer from the owner's
		// session, memory and tools in front of everyone in the room.
		if (guest || this.#ownerQa || kind === "ch") {
			return this.#acceptGuest({
				conversation,
				messageId: id,
				text,
				asker: { aadObjectId: aad ?? "", name: activity.from?.name },
				owner,
			});
		}
		return this.#accept({ conversation, messageId: id, text, quoted: [] });
	}

	/** A guest's question (or the owner's under `qa`): the core answers it read-only; only a typing indicator here. */
	#acceptGuest(input: {
		conversation: TeamsConversation;
		messageId: string;
		text: string;
		asker: { aadObjectId: string; name?: string | undefined };
		owner: boolean;
	}): IngestOutcome {
		const { conversation, messageId } = input;
		if (input.text === "") return this.#drop({ id: messageId }, "empty");
		const onGuest = this.#core.onGuestInbound;
		if (onGuest === undefined) return this.#drop({ id: messageId }, "guest_unsupported");
		const outcome = onGuest.call(this.#core, {
			platformMessageId: `${conversation.alias}:${messageId}`,
			conversationId: conversation.alias,
			kind: conversation.kind,
			threadRef: `${conversation.alias}:${messageId}`,
			text: input.text,
			asker: input.asker,
			owner: input.owner,
		});
		if (outcome?.duplicate) {
			this.#log.info("inbound_duplicate", { id: messageId });
			return "duplicate";
		}
		this.#log.info("guest_inbound_ack", { alias: conversation.alias, id: messageId, owner: input.owner });
		this.#sendTyping(conversation, messageId);
		return "recorded";
	}

	async #accept(message: OwnerMessage): Promise<IngestOutcome> {
		const { conversation, messageId } = message;
		const gate = normalizeInbound({
			userId: this.#owner,
			botUserId: this.botUserId,
			ownerUserId: this.#owner,
			text: message.text,
			quoted: message.quoted,
			channel: conversation.alias,
			ts: messageId,
			channelType: conversation.kind === "dm" ? "im" : "channel",
			platform: "teams",
		});
		if (!gate.accept) return this.#drop({ id: messageId }, gate.reason);
		// A group chat has no threads: the whole chat is one origin, its answers reply to each message.
		const inbound = {
			...gate.inbound,
			originKey: chatOriginKey({ platform: "teams", kind: conversation.kind, conversationId: conversation.alias }),
		};
		const outcome = await this.#core.onInbound(inbound);
		if (outcome?.duplicate) {
			this.#log.info("inbound_duplicate", { id: inbound.platformMessageId });
			return "duplicate";
		}
		this.#log.info("inbound_ack", { origin: inbound.originKey, id: messageId });
		this.#beginStatus(inbound.threadRef, conversation, messageId);
		return "recorded";
	}

	/** An owner message the daemon puts in (a button path, `inject`): taken like a live one in a known conversation. */
	async ingestOwner(input: OwnerIngest): Promise<IngestOutcome> {
		const known = this.#conversations.teamsConversation(input.conversationId);
		if (known === undefined) return this.#drop({ id: input.messageId }, "unknown_conversation");
		return this.#accept({
			conversation: known,
			messageId: input.messageId,
			text: input.text,
			quoted: input.quoted ?? [],
		});
	}

	// ---- typing and the long-turn status line ----

	#beginStatus(threadRef: string, conversation: TeamsConversation, root: string): void {
		const now = this.#clock.now();
		if (!this.#statuses.has(threadRef)) {
			this.#statuses.set(threadRef, {
				alias: conversation.alias,
				root,
				startedAt: now,
				lastUpdateAt: now,
				statusId: undefined,
				stalled: false,
				progress: undefined,
			});
		}
		this.#sendTyping(conversation, root);
	}

	/** One typing indicator, best effort (tracked so tests and shutdown can wait for it). */
	#sendTyping(conversation: TeamsConversation, root: string): void {
		const typing = this.#connector
			.sendActivity(conversation.serviceUrl, conversation.conversationId, { type: "typing" })
			.then(
				() => undefined,
				(err: unknown) => this.#log.warn("ack_failed", { platform: "teams", id: root, error: errorText(err) }),
			);
		this.#side.add(typing);
		void typing.finally(() => this.#side.delete(typing));
	}

	async tick(): Promise<void> {
		const now = this.#clock.now();
		for (const [threadRef, entry] of [...this.#statuses]) {
			if (entry.statusId === undefined) {
				if (now - entry.startedAt >= this.#longTurnMs) await this.#postStatus(threadRef, entry);
			} else if (now - entry.lastUpdateAt >= this.#statusIntervalMs) {
				await this.#editStatus(
					threadRef,
					entry,
					runningStatusText(entry.stalled, now - entry.startedAt, entry.progress),
				);
			}
		}
	}

	async setStalled(threadRef: string, stalled: boolean): Promise<void> {
		const entry = this.#statuses.get(threadRef);
		if (entry === undefined) return;
		entry.stalled = stalled;
		if (entry.statusId !== undefined) {
			const elapsed = this.#clock.now() - entry.startedAt;
			await this.#editStatus(threadRef, entry, runningStatusText(stalled, elapsed, entry.progress));
		}
	}

	async setProgress(threadRef: string, progress: TurnProgress): Promise<void> {
		const entry = this.#statuses.get(threadRef);
		if (entry === undefined) return;
		entry.progress = progress;
	}

	async #postStatus(threadRef: string, entry: StatusEntry): Promise<void> {
		// Set before the await: a tick meanwhile must not post a second line.
		entry.statusId = "";
		try {
			const posted = await this.#port.post(
				{ conversationId: entry.alias, threadId: entry.root },
				{ text: `⏳ 작업 중 · ${formatElapsed(this.#clock.now() - entry.startedAt)}` },
			);
			entry.statusId = posted.messageId;
			entry.lastUpdateAt = this.#clock.now();
		} catch (err) {
			this.#log.warn("status_create_failed", { thread: threadRef, error: errorText(err) });
		}
	}

	async #editStatus(threadRef: string, entry: StatusEntry, text: string): Promise<void> {
		if (entry.statusId === undefined || entry.statusId === "") return;
		entry.lastUpdateAt = this.#clock.now();
		try {
			await this.#port.edit(
				{ platform: "teams", conversationId: entry.alias, messageId: entry.statusId, threadId: entry.root },
				{ text },
			);
		} catch (err) {
			if (!(err instanceof TeamsRateLimitedError)) {
				this.#log.warn("status_update_failed", { thread: threadRef, error: errorText(err) });
			}
		}
	}

	/** Ends the thread's status: a posted `⏳` line becomes its result; nothing else is left to clean up. */
	async finishStatus(threadRef: string, outcome: FinalOutcome): Promise<void> {
		const entry = this.#statuses.get(threadRef);
		if (entry === undefined) return;
		this.#statuses.delete(threadRef);
		await this.#editStatus(
			threadRef,
			entry,
			`${FINAL_MARKS[outcome].label} · ${formatElapsed(this.#clock.now() - entry.startedAt)}`,
		);
	}

	// ---- notices and deliveries ----

	/** Best-effort notice at the top of the conversation, or as a reply to `threadId`; never throws. */
	async postNotice(conversationId: string, text: string, threadId?: string): Promise<void> {
		try {
			await this.#port.post({ conversationId, ...(threadId === undefined ? {} : { threadId }) }, { text });
		} catch (err) {
			this.#log.warn("notice_failed", { channel: conversationId, error: errorText(err) });
		}
	}

	pumpDeliveries(): Promise<number> {
		return this.#pump.pump();
	}

	#sender(): DeliverySender {
		return {
			isBlocked: () => this.#clock.now() < this.#postBlockedUntil,
			blockedUntil: () => Math.max(this.#postBlockedUntil, this.#clock.now()),
			blockedReason: () => "teams sendActivity",
			send: (delivery) => this.#send(delivery),
			afterSent: (delivery) => this.#finishDelivered(delivery),
		};
	}

	async #send(delivery: DeliveryItem): Promise<DeliverySendResult> {
		const target = parseThreadRef(delivery.threadRef);
		let conversation: TeamsConversation;
		try {
			if (target === undefined) throw new Error(`invalid thread_ref ${delivery.threadRef}`);
			conversation = this.#port.conversation(target.channel);
		} catch (err) {
			return { kind: "failed", error: errorText(err), outcome: "definitive", sentParts: 0 };
		}
		const replyToId = target.threadTs === TOP_LEVEL_TS ? undefined : target.threadTs;
		const outcome = delivery.body.startsWith("[turn failed]") ? "failed" : "done";
		const cancelled = new Set(delivery.cancelThreadRefs ?? []);
		const footer =
			delivery.keepStatus || cancelled.has(delivery.threadRef)
				? undefined
				: this.#footerOf(delivery.threadRef, outcome);
		const parts = renderTeamsParts(renderMentions(delivery.body, this.#port), delivery.redelivered, footer);
		let sent = Math.min(delivery.sentParts ?? 0, parts.length);
		try {
			for (const text of parts.slice(sent)) {
				const posted = await this.#connector.sendActivity(conversation.serviceUrl, conversation.conversationId, {
					type: "message",
					text,
					textFormat: "markdown",
					...(replyToId === undefined ? {} : { replyToId }),
				});
				if (posted.id !== undefined) {
					await this.#recordPost({
						channel: conversation.alias,
						ts: posted.id,
						deliveryId: delivery.deliveryId,
						part: sent,
					});
				}
				sent += 1;
			}
			return { kind: "sent", parts: parts.length };
		} catch (err) {
			if (err instanceof TeamsRateLimitedError) {
				this.#postBlockedUntil = this.#clock.now() + err.retryAfterMs;
				this.#log.warn("teams_rate_limited", { retry_after_ms: err.retryAfterMs });
				return { kind: "deferred", error: err, retry: { at: this.#postBlockedUntil, sentParts: sent } };
			}
			const definitive = sent === 0 && err instanceof TeamsCallError && err.kind === "definitive";
			return {
				kind: "failed",
				error: errorText(err),
				outcome: definitive ? "definitive" : "ambiguous",
				sentParts: sent,
			};
		}
	}

	async #finishDelivered(delivery: DeliveryItem): Promise<void> {
		if (delivery.keepStatus) return;
		const outcome = delivery.body.startsWith("[turn failed]") ? "failed" : "done";
		const cancelled = new Set(delivery.cancelThreadRefs ?? []);
		for (const threadRef of new Set([delivery.threadRef, ...(delivery.finishThreadRefs ?? [])])) {
			await this.finishStatus(threadRef, cancelled.has(threadRef) ? "cancelled" : outcome);
		}
	}

	async #recordPost(post: { channel: string; ts: string; deliveryId: number; part: number }): Promise<void> {
		try {
			await this.#deliveries.recordPost?.(post);
		} catch (err) {
			this.#log.warn("delivery_post_record_failed", { id: post.deliveryId, part: post.part, error: errorText(err) });
		}
	}

	/** `✅ 00:42 · 도구 6회` under an answer whose turn had no `⏳` line (a posted line shows the result itself). */
	#footerOf(threadRef: string, outcome: "done" | "failed"): string | undefined {
		const entry = this.#statuses.get(threadRef);
		if (entry === undefined || entry.statusId !== undefined) return undefined;
		const mark = FINAL_MARKS[outcome].label.split(" ")[0];
		const tools = entry.progress?.tools ?? 0;
		return `${mark} ${formatElapsed(this.#clock.now() - entry.startedAt)}${tools > 0 ? ` · 도구 ${tools}회` : ""}`;
	}
}
