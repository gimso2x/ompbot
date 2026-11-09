import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
	HistoryMessage,
	HistoryPage,
	SlackBlockActionPayload,
	SlackHandlers,
	SlackMessageEvent,
	SlackReactionEvent,
	SlackReply,
	SlackSlashPayload,
	SlackTransport,
	SlashAck,
} from "./transport";

export type FakeCall =
	| { method: "addReaction" | "removeReaction"; channel: string; timestamp: string; name: string }
	| {
			method: "postMessage";
			channel: string;
			text: string;
			threadTs?: string | undefined;
			blocks?: readonly unknown[] | undefined;
			ts: string;
	  }
	| { method: "updateMessage"; channel: string; ts: string; text: string; blocks?: readonly unknown[] | undefined }
	| { method: "deleteMessage"; channel: string; ts: string }
	| { method: "postEphemeral"; channel: string; user: string; text: string }
	| { method: "getPermalink"; channel: string; ts: string }
	| {
			method: "uploadFile";
			channel: string;
			threadTs?: string | undefined;
			filePath: string;
			title?: string | undefined;
			comment?: string | undefined;
			fileId: string;
	  };

/** In-memory transport. `failNext[method]` queues errors thrown by that method's next calls; `emit*` feed events in. */
export class FakeSlackTransport implements SlackTransport {
	readonly calls: FakeCall[] = [];
	readonly failNext: Partial<Record<FakeCall["method"], Error[]>> = {};
	readonly replies: SlackReply[] = [];
	handlers: SlackHandlers | undefined;
	private seq = 0;

	constructor(private readonly botUserId = "UBOT") {}

	async start(handlers: SlackHandlers): Promise<{ botUserId: string }> {
		this.handlers = handlers;
		return { botUserId: this.botUserId };
	}

	async stop(): Promise<void> {
		this.handlers = undefined;
	}

	count(method: FakeCall["method"]): number {
		return this.calls.filter((c) => c.method === method).length;
	}

	private maybeFail(method: FakeCall["method"]): void {
		const err = this.failNext[method]?.shift();
		if (err) throw err;
	}

	async addReaction(args: { channel: string; timestamp: string; name: string }): Promise<void> {
		this.calls.push({ method: "addReaction", ...args });
		this.maybeFail("addReaction");
	}

	async removeReaction(args: { channel: string; timestamp: string; name: string }): Promise<void> {
		this.calls.push({ method: "removeReaction", ...args });
		this.maybeFail("removeReaction");
	}

	async postMessage(args: {
		channel: string;
		text: string;
		threadTs?: string | undefined;
		blocks?: readonly unknown[] | undefined;
	}): Promise<{ ts: string }> {
		this.seq += 1;
		const ts = `1800000000.${String(this.seq).padStart(6, "0")}`;
		this.calls.push({ method: "postMessage", ...args, ts });
		this.maybeFail("postMessage");
		return { ts };
	}

	async updateMessage(args: {
		channel: string;
		ts: string;
		text: string;
		blocks?: readonly unknown[] | undefined;
	}): Promise<void> {
		this.calls.push({ method: "updateMessage", ...args });
		this.maybeFail("updateMessage");
	}

	async deleteMessage(args: { channel: string; ts: string }): Promise<void> {
		this.calls.push({ method: "deleteMessage", ...args });
		this.maybeFail("deleteMessage");
	}

	async uploadFile(args: {
		channel: string;
		threadTs?: string | undefined;
		filePath: string;
		title?: string | undefined;
		comment?: string | undefined;
	}): Promise<{ fileId: string }> {
		this.seq += 1;
		const fileId = `F${String(this.seq).padStart(6, "0")}`;
		this.calls.push({ method: "uploadFile", ...args, fileId });
		this.maybeFail("uploadFile");
		return { fileId };
	}

	async postEphemeral(args: { channel: string; user: string; text: string }): Promise<void> {
		this.calls.push({ method: "postEphemeral", ...args });
		this.maybeFail("postEphemeral");
	}

	async getPermalink(args: { channel: string; ts: string }): Promise<string> {
		this.calls.push({ method: "getPermalink", ...args });
		this.maybeFail("getPermalink");
		return `https://slack.test/archives/${args.channel}/p${args.ts.replace(".", "")}`;
	}

	/** Canned attachment downloads: `downloads[url]` is the bytes written to destPath. */
	readonly downloads: Map<string, Uint8Array> = new Map();
	/** When set, `downloadAttachment` throws this instead of writing. */
	downloadError: Error | undefined;

	async downloadAttachment(args: {
		url: string;
		destPath: string;
		maxBytes: number;
		requireImageMagic?: boolean;
	}): Promise<void> {
		if (this.downloadError !== undefined) throw this.downloadError;
		const bytes = this.downloads.get(args.url);
		if (bytes === undefined) throw new Error(`no canned download for ${args.url}`);
		await mkdir(dirname(args.destPath), { recursive: true });
		await writeFile(args.destPath, bytes);
	}

	/** Canned threads for `conversationsReplies`: `threads[<channel>:<rootTs>]` is the oldest-first message list. */
	readonly threads: Map<string, HistoryMessage[]> = new Map();
	/** Every `conversationsReplies` call, in order. */
	readonly replyCalls: Array<{ channel: string; ts: string; limit?: number | undefined }> = [];
	/** When set, the next `conversationsReplies` call fails once with this error. */
	failRepliesNext: Error | undefined;

	async conversationsReplies(args?: { channel: string; ts: string; limit?: number | undefined }): Promise<HistoryPage> {
		if (args !== undefined) this.replyCalls.push({ channel: args.channel, ts: args.ts, limit: args.limit });
		if (this.failRepliesNext !== undefined) {
			const error = this.failRepliesNext;
			this.failRepliesNext = undefined;
			throw error;
		}
		const thread = args === undefined ? undefined : this.threads.get(`${args.channel}:${args.ts}`);
		if (thread !== undefined) return { messages: thread.slice(0, args?.limit).map((m) => ({ ...m })) };
		return { messages: this.replies.map((reply) => ({ ...reply })) };
	}

	/** Configurable history feed for backfill tests: `history[<channel>]` is the full newest-first message list. */
	readonly history: Map<string, HistoryMessage[]> = new Map();
	/** When set, `conversationsHistory` fails once with this error (per channel key). */
	readonly failHistoryNext: Map<string, Error> = new Map();

	async conversationsHistory(args: {
		channel: string;
		oldest?: string | undefined;
		latest?: string | undefined;
		limit?: number | undefined;
		cursor?: string | undefined;
	}): Promise<HistoryPage> {
		const failure = this.failHistoryNext.get(args.channel);
		if (failure !== undefined) {
			this.failHistoryNext.delete(args.channel);
			throw failure;
		}
		const all = this.history.get(args.channel) ?? [];
		// Newest-first; apply latest/oldest as Slack would (exclusive-ish bounds via numeric compare).
		const upper = args.latest === undefined ? Number.POSITIVE_INFINITY : Number(args.latest);
		const lower = args.oldest === undefined ? Number.NEGATIVE_INFINITY : Number(args.oldest);
		const window = all.filter((m) => {
			const ts = Number(m.ts);
			return ts > lower && ts < upper;
		});
		const limit = args.limit ?? 200;
		const offset = args.cursor === undefined ? 0 : Number(args.cursor);
		const page = window.slice(offset, offset + limit);
		const nextCursor = offset + limit < window.length ? String(offset + limit) : undefined;
		return { messages: page.map((message) => ({ ...message })), nextCursor };
	}

	async emitMessage(event: SlackMessageEvent): Promise<void> {
		await this.handlers?.message(event);
	}

	async emitReaction(event: SlackReactionEvent): Promise<void> {
		await this.handlers?.reaction(event);
	}

	async emitSlash(payload: SlackSlashPayload): Promise<SlashAck | undefined> {
		return this.handlers?.slash(payload);
	}

	async emitBlockAction(payload: SlackBlockActionPayload): Promise<void> {
		await this.handlers?.blockAction(payload);
	}
}
