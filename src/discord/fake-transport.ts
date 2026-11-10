import { downloadDiscordAttachment } from "./attachments";
import {
	type CreateMessageArgs,
	DiscordCallError,
	type DiscordChannelInfo,
	type DiscordHandlers,
	type DiscordInteraction,
	type DiscordMessageEvent,
	type DiscordReactionEvent,
	type DiscordTransport,
	type DownloadAttachmentArgs,
	type EditInteractionResponseArgs,
	type EditMessageArgs,
	type ListMessagesArgs,
	type MessageTarget,
	type ReactionArgs,
	type RegisterCommandsArgs,
	type RespondInteractionArgs,
	type StartThreadArgs,
	type UploadFileArgs,
} from "./transport";

/** Thread channel type Discord gives a thread started from a message in a text channel (PUBLIC_THREAD). */
const PUBLIC_THREAD = 11;

/** First id the fakes hand out; snowflake-sized so id handling sees realistic values. */
export const FAKE_ID_BASE = 900_000_000_000_000_000n;

export type FakeDiscordCall =
	| ({ method: "createMessage"; id: string } & CreateMessageArgs)
	| ({ method: "editMessage" } & EditMessageArgs)
	| ({ method: "deleteMessage" } & MessageTarget)
	| ({ method: "addReaction" | "removeReaction" } & ReactionArgs)
	| ({ method: "startThread"; id: string } & StartThreadArgs)
	| ({ method: "uploadFile"; id: string } & UploadFileArgs)
	| ({ method: "downloadAttachment" } & DownloadAttachmentArgs)
	| ({ method: "respondInteraction" } & RespondInteractionArgs)
	| ({ method: "editInteractionResponse" } & EditInteractionResponseArgs)
	| { method: "deleteInteractionResponse"; token: string }
	| { method: "getChannel"; channelId: string }
	| ({ method: "listMessages" } & ListMessagesArgs);

/**
 * In-memory transport, the Discord twin of `FakeSlackTransport`: every call lands in `calls`, `failNext[method]`
 * queues errors thrown by that method's next calls, `emit*` feed gateway events to the handlers given to `start`.
 */
export class FakeDiscordTransport implements DiscordTransport {
	readonly calls: FakeDiscordCall[] = [];
	readonly failNext: Partial<Record<FakeDiscordCall["method"] | "registerCommands", Error[]>> = {};
	/** Slash command sets registered at start; kept apart from `calls`, which log the message path. */
	readonly commandSets: RegisterCommandsArgs[] = [];
	/** Canned channel history for `listMessages`: `history[<channel>]`, any order (served oldest-first). */
	readonly history: Map<string, DiscordMessageEvent[]> = new Map();
	/** CDN files `downloadAttachment` serves, by URL (anything else is a 404). */
	readonly downloads: Map<string, Uint8Array> = new Map();
	/** Every HTTP request the downloads made, with its headers (no credentials may appear). */
	readonly downloadRequests: Array<{ url: string; headers: Record<string, string> }> = [];
	handlers: DiscordHandlers | undefined;
	readonly #channels = new Map<string, DiscordChannelInfo>();
	readonly #botUserId: string;
	readonly #applicationId: string;
	#seq = 0n;

	constructor(ids: { botUserId?: string; applicationId?: string } = {}) {
		this.#botUserId = ids.botUserId ?? "500000000000000000";
		this.#applicationId = ids.applicationId ?? "600000000000000000";
	}

	async start(handlers: DiscordHandlers): Promise<{ botUserId: string; applicationId: string }> {
		this.handlers = handlers;
		return { botUserId: this.#botUserId, applicationId: this.#applicationId };
	}

	async stop(): Promise<void> {
		this.handlers = undefined;
	}

	/** Channel metadata `getChannel` returns (threads, parents, DMs). */
	setChannel(info: DiscordChannelInfo): void {
		this.#channels.set(info.id, info);
	}

	count(method: FakeDiscordCall["method"]): number {
		return this.calls.filter((c) => c.method === method).length;
	}

	#nextId(): string {
		this.#seq += 1n;
		return String(FAKE_ID_BASE + this.#seq);
	}

	#maybeFail(method: FakeDiscordCall["method"] | "registerCommands"): void {
		const err = this.failNext[method]?.shift();
		if (err) throw err;
	}

	async createMessage(args: CreateMessageArgs): Promise<{ id: string }> {
		const id = this.#nextId();
		this.calls.push({ method: "createMessage", ...args, id });
		this.#maybeFail("createMessage");
		return { id };
	}

	async editMessage(args: EditMessageArgs): Promise<void> {
		this.calls.push({ method: "editMessage", ...args });
		this.#maybeFail("editMessage");
	}

	async deleteMessage(args: MessageTarget): Promise<void> {
		this.calls.push({ method: "deleteMessage", ...args });
		this.#maybeFail("deleteMessage");
	}

	async addReaction(args: ReactionArgs): Promise<void> {
		this.calls.push({ method: "addReaction", ...args });
		this.#maybeFail("addReaction");
	}

	async removeReaction(args: ReactionArgs): Promise<void> {
		this.calls.push({ method: "removeReaction", ...args });
		this.#maybeFail("removeReaction");
	}

	async startThread(args: StartThreadArgs): Promise<{ id: string }> {
		const id = args.messageId;
		this.calls.push({ method: "startThread", ...args, id });
		this.#maybeFail("startThread");
		this.#channels.set(id, {
			id,
			type: PUBLIC_THREAD,
			parentId: args.channelId,
			guildId: this.#channels.get(args.channelId)?.guildId,
		});
		return { id };
	}

	async getChannel(channelId: string): Promise<DiscordChannelInfo> {
		this.calls.push({ method: "getChannel", channelId });
		this.#maybeFail("getChannel");
		const info = this.#channels.get(channelId);
		if (info === undefined)
			throw new DiscordCallError("definitive", "discord_http_404:10003 Unknown Channel", 404, 10003);
		return { ...info };
	}

	async listMessages(args: ListMessagesArgs): Promise<DiscordMessageEvent[]> {
		this.calls.push({ method: "listMessages", ...args });
		this.#maybeFail("listMessages");
		const after = args.after === undefined ? -1n : BigInt(args.after);
		return (this.history.get(args.channelId) ?? [])
			.filter((m) => BigInt(m.id) > after)
			.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
			.slice(0, args.limit ?? 50)
			.map((m) => ({ ...m }));
	}

	async uploadFile(args: UploadFileArgs): Promise<{ id: string }> {
		const id = this.#nextId();
		this.calls.push({ method: "uploadFile", ...args, id });
		this.#maybeFail("uploadFile");
		return { id };
	}

	/** The real CDN download (host allowlist, size cap, image magic, atomic write) over `downloads` instead of the network. */
	async downloadAttachment(args: DownloadAttachmentArgs): Promise<void> {
		this.calls.push({ method: "downloadAttachment", ...args });
		this.#maybeFail("downloadAttachment");
		const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			this.downloadRequests.push({ url, headers: Object.fromEntries(new Headers(init?.headers)) });
			const body = this.downloads.get(url);
			return body === undefined ? new Response("not found", { status: 404 }) : new Response(body, { status: 200 });
		}) as typeof fetch;
		const result = await downloadDiscordAttachment({ ...args, fetchImpl, retries: 0 });
		if (!result.ok) throw new DiscordCallError("definitive", `attachment_download_failed:${result.error}`);
	}

	async respondInteraction(args: RespondInteractionArgs): Promise<void> {
		this.calls.push({ method: "respondInteraction", ...args });
		this.#maybeFail("respondInteraction");
	}

	async editInteractionResponse(args: EditInteractionResponseArgs): Promise<void> {
		this.calls.push({ method: "editInteractionResponse", ...args });
		this.#maybeFail("editInteractionResponse");
	}

	async deleteInteractionResponse(args: { token: string }): Promise<void> {
		this.calls.push({ method: "deleteInteractionResponse", ...args });
		this.#maybeFail("deleteInteractionResponse");
	}

	async registerCommands(args: RegisterCommandsArgs): Promise<void> {
		this.commandSets.push(args);
		this.#maybeFail("registerCommands");
	}

	/** A gateway Ready (`resumed: false`, a new session) or Resumed after `start`. */
	emitReady(info: { resumed: boolean }): void {
		this.handlers?.ready?.(info);
	}

	async emitMessage(event: DiscordMessageEvent): Promise<void> {
		await this.handlers?.message(event);
	}

	async emitReaction(event: DiscordReactionEvent): Promise<void> {
		await this.handlers?.reaction(event);
	}

	async emitInteraction(interaction: DiscordInteraction): Promise<void> {
		await this.handlers?.interaction(interaction);
	}
}
