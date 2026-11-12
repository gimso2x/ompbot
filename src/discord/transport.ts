// Every Discord call the adapter makes goes through DiscordTransport; tests use FakeDiscordTransport.

/** GUILDS | GUILD_MESSAGES | GUILD_MESSAGE_REACTIONS | DIRECT_MESSAGES | DIRECT_MESSAGE_REACTIONS | MESSAGE_CONTENT. */
export const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 10) | (1 << 12) | (1 << 13) | (1 << 15);

/** Longest `content` Discord accepts in one message. */
export const MESSAGE_CONTENT_LIMIT = 2000;

/** Whole-request cap of a message with attachments (Create Message); larger files fail before the request. */
export const UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;

export interface DiscordUser {
	id: string;
	username?: string | undefined;
	bot?: boolean | undefined;
}

export interface DiscordAttachment {
	id: string;
	filename: string;
	size: number;
	url: string;
	content_type?: string | undefined;
}

/** `MESSAGE_CREATE` payload (and one row of channel history): only the fields the bot reads. */
export interface DiscordMessageEvent {
	id: string;
	channel_id: string;
	/** Absent in DMs. */
	guild_id?: string | undefined;
	author: DiscordUser;
	content: string;
	/** 0 default, 19 reply; other values are system messages. */
	type: number;
	mentions?: ReadonlyArray<DiscordUser> | undefined;
	message_reference?: { message_id?: string; channel_id?: string; guild_id?: string } | undefined;
	attachments?: ReadonlyArray<DiscordAttachment> | undefined;
	timestamp?: string | undefined;
}

/** `MESSAGE_REACTION_ADD` / `MESSAGE_REACTION_REMOVE`; `emoji.name` is the unicode emoji for standard emoji. */
export interface DiscordReactionEvent {
	type: "add" | "remove";
	user_id: string;
	channel_id: string;
	message_id: string;
	guild_id?: string | undefined;
	emoji: { id: string | null; name: string | null };
}

/** `INTERACTION_CREATE`: type 2 application command, type 3 message component. */
export interface DiscordInteraction {
	id: string;
	application_id: string;
	type: number;
	token: string;
	channel_id?: string | undefined;
	guild_id?: string | undefined;
	data?:
		| {
				custom_id?: string | undefined;
				component_type?: number | undefined;
				name?: string | undefined;
				options?: ReadonlyArray<{ name: string; type: number; value?: unknown }> | undefined;
		  }
		| undefined;
	/** Guild interactions carry the user under `member`, DM interactions under `user`. */
	member?: { user: DiscordUser } | undefined;
	user?: DiscordUser | undefined;
	/** The channel it came from; its `type` tells the bot's DM (1) from a group DM (3). */
	channel?: { id: string; type: number } | undefined;
	message?: { id: string; channel_id: string } | undefined;
}

export interface DiscordHandlers {
	message(event: DiscordMessageEvent): Promise<void>;
	reaction(event: DiscordReactionEvent): Promise<void>;
	interaction(interaction: DiscordInteraction): Promise<void>;
	/** Every Ready (`resumed: false`: a new session, the events in between are lost) and Resumed (`resumed: true`). */
	ready?(info: { resumed: boolean }): void;
}

/** What the adapter caches per channel id: a thread (type 10/11/12) has `parentId`; DMs have no `guildId`. */
export interface DiscordChannelInfo {
	id: string;
	type: number;
	parentId?: string | undefined;
	guildId?: string | undefined;
}

export interface AllowedMentions {
	parse: ReadonlyArray<"users" | "roles" | "everyone">;
	users?: readonly string[] | undefined;
	replied_user?: boolean | undefined;
}

/** A reply target; the message is posted even when the referenced one is gone. */
export interface MessageReference {
	messageId: string;
}

export interface CreateMessageArgs {
	channelId: string;
	content?: string | undefined;
	embeds?: readonly unknown[] | undefined;
	components?: readonly unknown[] | undefined;
	messageReference?: MessageReference | undefined;
	allowedMentions?: AllowedMentions | undefined;
}

/** `components: []` removes the buttons of an earlier message. */
export interface EditMessageArgs {
	channelId: string;
	messageId: string;
	content?: string | undefined;
	embeds?: readonly unknown[] | undefined;
	components?: readonly unknown[] | undefined;
	allowedMentions?: AllowedMentions | undefined;
}

export interface MessageTarget {
	channelId: string;
	messageId: string;
}

export interface ReactionArgs extends MessageTarget {
	/** Unicode emoji (see `emoji.ts`); URL-encoded by the transport. */
	emoji: string;
}

export interface StartThreadArgs extends MessageTarget {
	/** 1–100 characters. */
	name: string;
}

export interface ListMessagesArgs {
	channelId: string;
	/** Snowflake watermark: only messages with a greater id. */
	after?: string | undefined;
	/** 1–100, default 50. */
	limit?: number | undefined;
}

export interface UploadFileArgs {
	channelId: string;
	filePath: string;
	/** Defaults to the file's base name. */
	filename?: string | undefined;
	content?: string | undefined;
	messageReference?: MessageReference | undefined;
	allowedMentions?: AllowedMentions | undefined;
}

/** One inbound attachment to `destPath` under the caller's size cap; images must pass the magic check. */
export interface DownloadAttachmentArgs {
	url: string;
	destPath: string;
	maxBytes: number;
	requireImageMagic?: boolean | undefined;
}

export interface InteractionResponse {
	/** 4 message, 5 deferred message, 6 deferred update. */
	type: number;
	data?: Record<string, unknown> | undefined;
}

export interface RespondInteractionArgs {
	interactionId: string;
	token: string;
	response: InteractionResponse;
}

export interface EditInteractionResponseArgs {
	token: string;
	content?: string | undefined;
	components?: readonly unknown[] | undefined;
	allowedMentions?: AllowedMentions | undefined;
}

/** One chat-input (slash) command as `PUT …/commands` takes it. */
export interface ApplicationCommand {
	/** 1–32 characters, lower-case letters, digits and `-`. */
	name: string;
	/** 1–100 characters. */
	description: string;
	options?: ReadonlyArray<{ type: number; name: string; description: string; required: boolean }> | undefined;
}

/** Replaces the application's whole command set: global, or one server's (shown there at once). */
export interface RegisterCommandsArgs {
	guildId?: string | undefined;
	commands: readonly ApplicationCommand[];
}

export interface DiscordTransport {
	/** Connects the gateway, wires the handlers and resolves the bot's user id and application id on Ready. */
	start(handlers: DiscordHandlers): Promise<{ botUserId: string; applicationId: string }>;
	/** Gateway state for the heartbeat; `undefined` when the implementation has no socket (fakes). */
	connectionState?(): { state: "up" | "down"; since: number } | undefined;
	stop(): Promise<void>;
	createMessage(args: CreateMessageArgs): Promise<{ id: string }>;
	editMessage(args: EditMessageArgs): Promise<void>;
	deleteMessage(args: MessageTarget): Promise<void>;
	addReaction(args: ReactionArgs): Promise<void>;
	removeReaction(args: ReactionArgs): Promise<void>;
	/** Thread from a message; Discord gives the thread the message's id. */
	startThread(args: StartThreadArgs): Promise<{ id: string }>;
	getChannel(channelId: string): Promise<DiscordChannelInfo>;
	/** Oldest-first page of a channel's messages after the watermark (missed-message backfill). */
	listMessages(args: ListMessagesArgs): Promise<DiscordMessageEvent[]>;
	/** Posts one message with the file attached; resolves the message id. */
	uploadFile(args: UploadFileArgs): Promise<{ id: string }>;
	/** Downloads one inbound attachment from Discord's CDN (no credentials sent); throws with the reason on failure. */
	downloadAttachment(args: DownloadAttachmentArgs): Promise<void>;
	/** Must happen within 3 s of the interaction or its token is void. */
	respondInteraction(args: RespondInteractionArgs): Promise<void>;
	editInteractionResponse(args: EditInteractionResponseArgs): Promise<void>;
	deleteInteractionResponse(args: { token: string }): Promise<void>;
	registerCommands(args: RegisterCommandsArgs): Promise<void>;
}

/** HTTP 429 or a route whose bucket is spent; `retryAfterMs` is when the route opens again. */
export class DiscordRateLimitedError extends Error {
	readonly retryAfterMs: number;
	readonly global: boolean;
	constructor(retryAfterMs: number, global = false) {
		super(`discord rate limited, retry after ${retryAfterMs}ms`);
		this.name = "DiscordRateLimitedError";
		this.retryAfterMs = retryAfterMs;
		this.global = global;
	}
}

/**
 * `definitive`: Discord refused the call (4xx) or it was refused before sending, nothing was posted. `ambiguous`:
 * network/5xx/timeout, a message may or may not exist, so a delivery must not be blindly retried.
 */
export class DiscordCallError extends Error {
	readonly kind: "definitive" | "ambiguous";
	/** HTTP status when Discord answered. */
	readonly status: number | undefined;
	/** Discord JSON error code (e.g. 50001 Missing Access, 160004 thread already exists). */
	readonly code: number | undefined;
	constructor(kind: "definitive" | "ambiguous", message: string, status?: number, code?: number) {
		super(message);
		this.name = "DiscordCallError";
		this.kind = kind;
		this.status = status;
		this.code = code;
	}
}

/** Gateway close codes that must not be retried: 4004 authentication, 4010–4014 shard/version/intents. */
export const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

/** The gateway closed with a code in `FATAL_CLOSE_CODES`; the client stopped and will not reconnect. */
export class DiscordGatewayFatalError extends Error {
	readonly code: number;
	constructor(code: number, reason: string) {
		super(`discord gateway closed ${code}${reason ? `: ${reason}` : ""}`);
		this.name = "DiscordGatewayFatalError";
		this.code = code;
	}
}
