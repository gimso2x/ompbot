import { basename } from "node:path";
import { ErrorCode, WebClient } from "@slack/web-api";
import { redact } from "../redact";
import { downloadAttachmentFile } from "./attachments";
import { SocketClient } from "./socket-client";
import {
	type HistoryMessage,
	type HistoryPage,
	type SlackBlockActionPayload,
	SlackCallError,
	type SlackHandlers,
	type SlackMessageEvent,
	SlackRateLimitedError,
	type SlackReactionEvent,
	type SlackSlashPayload,
	type SlackTransport,
} from "./transport";

/**
 * Maps @slack/web-api failures onto the adapter's error classes. Platform errors (`ok:false`) mean Slack refused the call;
 * request/HTTP errors leave the outcome unknown.
 */
export function mapWebApiError(err: unknown): Error {
	const e = err as { code?: string; retryAfter?: number; data?: { error?: string }; message?: string };
	if (e?.code === ErrorCode.RateLimitedError) return new SlackRateLimitedError((e.retryAfter ?? 1) * 1000);
	if (e?.code === ErrorCode.PlatformError) {
		return new SlackCallError("definitive", `slack_platform_error:${e.data?.error ?? "unknown"}`);
	}
	return new SlackCallError("ambiguous", e?.message ?? String(err));
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		throw mapWebApiError(err);
	}
}

/**
 * Slack's SDK types history/replies rows as a union that omits the backfill fields; one named boundary cast with a
 * runtime ts check, instead of scattered inline casts.
 */
type SlackHistoryRow = {
	ts: string;
	text?: string;
	user?: string;
	thread_ts?: string;
	bot_id?: string;
	subtype?: string;
	reply_count?: number;
	files?: SlackMessageEvent["files"];
	attachments?: SlackMessageEvent["attachments"];
};

function toHistoryMessage(raw: unknown): HistoryMessage | undefined {
	const row = raw as SlackHistoryRow;
	if (typeof row?.ts !== "string") return undefined;
	return {
		files: row.files,
		attachments: row.attachments,
		ts: row.ts,
		text: row.text,
		user: row.user,
		thread_ts: row.thread_ts,
		bot_id: row.bot_id,
		subtype: row.subtype,
		reply_count: row.reply_count,
	};
}

function toHistoryPage(res: { messages?: unknown[]; response_metadata?: { next_cursor?: string } }): HistoryPage {
	const messages = (res.messages ?? []).flatMap((raw) => {
		const message = toHistoryMessage(raw);
		return message === undefined ? [] : [message];
	});
	return { messages, nextCursor: res.response_metadata?.next_cursor || undefined };
}

/** Socket lifecycle event surfaced to the daemon's structured log; `detail` is body-less (never tokens). */
export interface SocketLifecycleEvent {
	type: "connected" | "reconnecting" | "error";
	detail?: string;
}

/**
 * Socket up/down rule. Starts `down` at construction; `hello` goes up; `reconnecting` goes down only from up (while
 * already down `since` is kept, so a long outage ages instead of resetting on each backoff). `error` never changes
 * the state: the socket client reports handler and parse errors on a live socket and on every reconnect backoff.
 */
export class SocketConnectionState {
	#state: "up" | "down" = "down";
	#since: number;

	constructor(now: number) {
		this.#since = now;
	}

	on(event: SocketLifecycleEvent["type"], now: number): void {
		if (event === "connected") {
			if (this.#state !== "up") {
				this.#state = "up";
				this.#since = now;
			}
		} else if (event === "reconnecting" && this.#state === "up") {
			this.#state = "down";
			this.#since = now;
		}
	}

	snapshot(): { state: "up" | "down"; since: number } {
		return { state: this.#state, since: this.#since };
	}
}

/** Socket Mode + Web API. Tokens are passed in by the caller (read from files by config); never logged here. */
export class SocketModeTransport implements SlackTransport {
	private readonly web: WebClient;
	private readonly appToken: string;
	private readonly botToken: string;
	private socket: SocketClient | undefined;
	/** Fired on every (re)connect of the socket; the daemon uses it to trigger missed-message backfill. */
	onReady: () => void = () => {};
	private readonly onLifecycle: (event: SocketLifecycleEvent) => void;
	private readonly connection = new SocketConnectionState(Date.now());

	constructor(
		tokens: { botToken: string; appToken: string },
		options: { onReady?: () => void; onLifecycle?: (event: SocketLifecycleEvent) => void } = {},
	) {
		// rejectRateLimitedCalls: surface 429 to the adapter instead of the client sleeping on it internally.
		this.web = new WebClient(tokens.botToken, { rejectRateLimitedCalls: true });
		this.appToken = tokens.appToken;
		this.botToken = tokens.botToken;
		if (options.onReady) this.onReady = options.onReady;
		this.onLifecycle = options.onLifecycle ?? (() => {});
	}

	connectionState(): { state: "up" | "down"; since: number } {
		return this.connection.snapshot();
	}

	async start(handlers: SlackHandlers): Promise<{ botUserId: string }> {
		// Every envelope is acked first; handlers run afterwards (Slack redelivers unacked envelopes after 3s).
		this.socket = new SocketClient({
			appToken: this.appToken,
			onError: (err) => {
				console.error(redact(`[ompbot] slack socket: ${err.message}`));
				this.connection.on("error", Date.now());
				this.onLifecycle({ type: "error", detail: err.message });
			},
			onReconnect: (reason) => {
				this.connection.on("reconnecting", Date.now());
				this.onLifecycle({ type: "reconnecting", detail: reason });
			},
			onHello: () => {
				this.connection.on("connected", Date.now());
				this.onLifecycle({ type: "connected" });
				this.onReady();
			},
			handlers: {
				eventsApi: async (payload) => {
					// Slack shapes events_api payloads by our app's event subscriptions: `message` and the two reaction events.
					const event = (payload as { event?: SlackMessageEvent | SlackReactionEvent }).event;
					if (event?.type === "message") await handlers.message(event);
					else if (event?.type === "reaction_added" || event?.type === "reaction_removed") {
						await handlers.reaction(event);
					}
				},
				// Slash and interactive payloads are Slack-defined; the adapter validates the fields it reads.
				slashCommand: (payload) => handlers.slash(payload as SlackSlashPayload),
				interactive: async (payload) => {
					const body = payload as SlackBlockActionPayload & { type: string };
					if (body.type === "block_actions") await handlers.blockAction(body);
				},
			},
		});
		const auth = await guarded(() => this.web.auth.test());
		if (!auth.user_id) throw new Error("auth.test returned no user_id");
		await this.socket.start();
		return { botUserId: auth.user_id };
	}

	async stop(): Promise<void> {
		this.socket?.stop();
	}

	async addReaction(args: { channel: string; timestamp: string; name: string }): Promise<void> {
		await guarded(() => this.web.reactions.add(args));
	}

	async removeReaction(args: { channel: string; timestamp: string; name: string }): Promise<void> {
		await guarded(() => this.web.reactions.remove(args));
	}

	async postMessage(args: {
		channel: string;
		text: string;
		threadTs?: string | undefined;
		blocks?: readonly unknown[] | undefined;
		attachments?: readonly unknown[] | undefined;
	}): Promise<{ ts: string }> {
		const res = await guarded(() =>
			this.web.chat.postMessage({
				channel: args.channel,
				text: args.text,
				...(args.threadTs ? { thread_ts: args.threadTs } : {}),
				...(args.blocks ? { blocks: [...args.blocks] as never } : {}),
				...(args.attachments ? { attachments: [...args.attachments] as never } : {}),
				mrkdwn: true,
				unfurl_links: false,
			}),
		);
		if (!res.ts) throw new SlackCallError("ambiguous", "chat.postMessage returned no ts");
		return { ts: res.ts };
	}

	async updateMessage(args: {
		channel: string;
		ts: string;
		text: string;
		blocks?: readonly unknown[] | undefined;
	}): Promise<void> {
		const { blocks, ...rest } = args;
		await guarded(() => this.web.chat.update({ ...rest, ...(blocks ? { blocks: [...blocks] as never } : {}) }));
	}

	async deleteMessage(args: { channel: string; ts: string }): Promise<void> {
		await guarded(() => this.web.chat.delete(args));
	}

	async uploadFile(args: {
		channel: string;
		threadTs?: string | undefined;
		filePath: string;
		title?: string | undefined;
		comment?: string | undefined;
	}): Promise<{ fileId: string }> {
		const res = await guarded(() =>
			this.web.filesUploadV2({
				// `thread_ts` is part of a discriminated destination union in the SDK types, so the two shapes are
				// built explicitly instead of spreading an optional key.
				...(args.threadTs === undefined
					? { channel_id: args.channel }
					: { channel_id: args.channel, thread_ts: args.threadTs }),
				file: args.filePath,
				filename: basename(args.filePath),
				...(args.title ? { title: args.title } : {}),
				...(args.comment ? { initial_comment: args.comment } : {}),
			}),
		);
		const fileId = res.files?.flatMap((group) => group.files ?? []).find((file) => file.id)?.id;
		if (!fileId) throw new SlackCallError("ambiguous", "files.uploadV2 returned no file id");
		return { fileId };
	}

	async postEphemeral(args: {
		channel: string;
		user: string;
		text: string;
		threadTs?: string | undefined;
	}): Promise<void> {
		await guarded(() =>
			this.web.chat.postEphemeral({
				channel: args.channel,
				user: args.user,
				text: args.text,
				...(args.threadTs ? { thread_ts: args.threadTs } : {}),
			}),
		);
	}

	async getPermalink(args: { channel: string; ts: string }): Promise<string> {
		const res = await guarded(() => this.web.chat.getPermalink({ channel: args.channel, message_ts: args.ts }));
		if (!res.permalink) throw new SlackCallError("definitive", "chat.getPermalink returned no permalink");
		return res.permalink;
	}

	async downloadAttachment(args: {
		url: string;
		destPath: string;
		maxBytes: number;
		requireImageMagic?: boolean;
	}): Promise<void> {
		const result = await downloadAttachmentFile({
			url: args.url,
			bearerToken: this.botToken,
			destPath: args.destPath,
			maxBytes: args.maxBytes,
			requireImageMagic: args.requireImageMagic,
		});
		if (!result.ok) throw new SlackCallError("definitive", `attachment_download_failed:${result.error}`);
	}

	async conversationsHistory(args: {
		channel: string;
		oldest?: string | undefined;
		latest?: string | undefined;
		limit?: number | undefined;
		cursor?: string | undefined;
	}): Promise<HistoryPage> {
		const res = await guarded(() =>
			this.web.conversations.history({
				channel: args.channel,
				...(args.oldest ? { oldest: args.oldest } : {}),
				...(args.latest ? { latest: args.latest } : {}),
				...(args.cursor ? { cursor: args.cursor } : {}),
				limit: args.limit ?? 200,
			}),
		);
		return toHistoryPage(res);
	}

	async conversationsReplies(args: {
		channel: string;
		ts: string;
		oldest?: string | undefined;
		latest?: string | undefined;
		limit?: number | undefined;
		cursor?: string | undefined;
	}): Promise<HistoryPage> {
		const res = await guarded(() =>
			this.web.conversations.replies({
				channel: args.channel,
				ts: args.ts,
				...(args.oldest ? { oldest: args.oldest } : {}),
				...(args.latest ? { latest: args.latest } : {}),
				...(args.cursor ? { cursor: args.cursor } : {}),
				limit: args.limit ?? 200,
			}),
		);
		return toHistoryPage(res);
	}
}
