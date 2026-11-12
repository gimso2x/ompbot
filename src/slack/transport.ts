// Every Slack call the adapter makes goes through SlackTransport; tests use FakeSlackTransport.

/** One Slack message attachment (forwarded/unfurled content), the quoted-material source. */
export interface SlackMessageAttachment {
	text?: string;
	fallback?: string;
	pretext?: string;
	author_name?: string;
}

/** One Slack file of a `file_share` message; the adapter downloads it into the media root. */
export interface SlackInboundFile {
	id?: string | undefined;
	name?: string | undefined;
	mimetype?: string | undefined;
	size?: number | undefined;
	url_private?: string | undefined;
	url_private_download?: string | undefined;
}

export interface SlackMessageEvent {
	type: "message";
	channel: string;
	channel_type?: string | undefined;
	user?: string | undefined;
	bot_id?: string | undefined;
	text?: string | undefined;
	ts: string;
	thread_ts?: string | undefined;
	subtype?: string | undefined;
	attachments?: ReadonlyArray<SlackMessageAttachment> | undefined;
	/** Inbound files (Slack `file_share`); the adapter downloads them into the media root. */
	files?: ReadonlyArray<SlackInboundFile> | undefined;
}

/** `reaction_added` / `reaction_removed` (Events API); the adapter reads only reactions on messages. */
export interface SlackReactionEvent {
	type: "reaction_added" | "reaction_removed";
	user?: string | undefined;
	/** Emoji name without colons; a skin tone rides as `::skin-tone-N`. */
	reaction: string;
	item: { type: string; channel?: string | undefined; ts?: string | undefined };
	event_ts: string;
}

export interface SlackSlashPayload {
	command: string;
	user_id: string;
	channel_id: string;
	text?: string | undefined;
}

export interface SlackBlockActionPayload {
	user: { id: string };
	channel?: { id: string } | undefined;
	message?: { ts: string; thread_ts?: string | undefined } | undefined;
	actions: ReadonlyArray<{ action_id: string; value?: string | undefined }>;
}

export interface SlashAck {
	response_type: "ephemeral";
	text: string;
}

export interface SlackHandlers {
	message(event: SlackMessageEvent): Promise<void>;
	reaction(event: SlackReactionEvent): Promise<void>;
	/** `undefined` acks with no message: the command's answer arrives as a post of its own. */
	slash(payload: SlackSlashPayload): Promise<SlashAck | undefined>;
	blockAction(payload: SlackBlockActionPayload): Promise<void>;
}

export interface SlackReply {
	ts: string;
	text?: string | undefined;
	user?: string | undefined;
	thread_ts?: string | undefined;
}

/** One message from `conversations.history` / `conversations.replies` (backfill only reads). */
export interface HistoryMessage extends SlackReply {
	bot_id?: string | undefined;
	subtype?: string | undefined;
	/** Thread parents only: replies live behind `conversations.replies`. */
	reply_count?: number | undefined;
	/** `file_share` files and forwarded attachments: backfill must hand them to the same ingest path as live events. */
	files?: ReadonlyArray<SlackInboundFile> | undefined;
	attachments?: ReadonlyArray<SlackMessageAttachment> | undefined;
}

export interface HistoryPage {
	messages: HistoryMessage[];
	/** Present when more pages follow; pass as `cursor`. */
	nextCursor?: string | undefined;
}

export interface SlackTransport {
	/** Connects Socket Mode, wires the handlers (each Slack envelope is acked before its handler runs) and resolves the bot's user id. */
	start(handlers: SlackHandlers): Promise<{ botUserId: string }>;
	/** Fired on every (re)connect of the underlying socket, when the implementation supports it (Socket Mode does). */
	onReady?: () => void;
	/** Socket connection state for the heartbeat; `undefined` when the implementation has no socket (fakes). */
	connectionState?(): { state: "up" | "down"; since: number } | undefined;
	stop(): Promise<void>;
	addReaction(args: { channel: string; timestamp: string; name: string }): Promise<void>;
	removeReaction(args: { channel: string; timestamp: string; name: string }): Promise<void>;
	postMessage(args: {
		channel: string;
		text: string;
		threadTs?: string | undefined;
		/** Block Kit blocks (approval buttons); `text` stays the notification fallback. */
		blocks?: readonly unknown[] | undefined;
		/** Legacy attachments (a toned card: `{ color, blocks }`, the colour bar on the left edge). */
		attachments?: readonly unknown[] | undefined;
	}): Promise<{ ts: string }>;
	/** `blocks: []` removes the blocks of an earlier message (buttons gone after a decision). */
	updateMessage(args: {
		channel: string;
		ts: string;
		text: string;
		blocks?: readonly unknown[] | undefined;
	}): Promise<void>;
	/** `chat.delete` of one of the bot's own messages (the ⏳ status message once the answer is in). */
	deleteMessage(args: { channel: string; ts: string }): Promise<void>;
	postEphemeral(args: { channel: string; user: string; text: string; threadTs?: string | undefined }): Promise<void>;
	/** `chat.getPermalink`: the URL of one message (a thread root links to its thread). */
	getPermalink(args: { channel: string; ts: string }): Promise<string>;
	/** Newest-first page of channel/DM history for missed-message backfill; `oldest`/`latest` are Slack ts bounds. */
	conversationsHistory(args: {
		channel: string;
		oldest?: string | undefined;
		latest?: string | undefined;
		limit?: number | undefined;
		cursor?: string | undefined;
	}): Promise<HistoryPage>;
	/** One thread's replies, oldest-first with the root leading the first page; `oldest`/`latest` bound the scan. */
	conversationsReplies(args: {
		channel: string;
		ts: string;
		oldest?: string | undefined;
		latest?: string | undefined;
		limit?: number | undefined;
		cursor?: string | undefined;
	}): Promise<HistoryPage>;
	/**
	 * Uploads a local file with `files.uploadV2`: into the thread when `threadTs` is set, else the channel's main
	 * view.
	 */
	uploadFile(args: {
		channel: string;
		/** Thread the file lands in (the origin's current conversation); omitted → the channel's main view. */
		threadTs?: string | undefined;
		filePath: string;
		title?: string | undefined;
		comment?: string | undefined;
	}): Promise<{ fileId: string }>;
	/** Downloads one inbound Slack attachment (auth-bearing URL) to `destPath` under the caller's size cap. */
	downloadAttachment(args: {
		url: string;
		destPath: string;
		maxBytes: number;
		requireImageMagic?: boolean;
	}): Promise<void>;
}

/** HTTP 429. `retryAfterMs` comes from the Retry-After header. */
export class SlackRateLimitedError extends Error {
	readonly retryAfterMs: number;
	constructor(retryAfterMs: number) {
		super(`slack rate limited, retry after ${retryAfterMs}ms`);
		this.name = "SlackRateLimitedError";
		this.retryAfterMs = retryAfterMs;
	}
}

/**
 * `definitive`: Slack refused the call, nothing was posted. `ambiguous`: network/5xx, the outcome is unknown
 * (a message may or may not exist), so a delivery must not be blindly retried.
 */
export class SlackCallError extends Error {
	readonly kind: "definitive" | "ambiguous";
	constructor(kind: "definitive" | "ambiguous", message: string) {
		super(message);
		this.name = "SlackCallError";
		this.kind = kind;
	}
}
