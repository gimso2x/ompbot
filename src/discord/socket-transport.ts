import { redact } from "../redact";
import { downloadDiscordAttachment } from "./attachments";
import { DiscordGateway } from "./gateway";
import { DiscordRest } from "./rest";
import {
	type CreateMessageArgs,
	DiscordCallError,
	type DiscordChannelInfo,
	type DiscordGatewayFatalError,
	type DiscordHandlers,
	type DiscordMessageEvent,
	type DiscordTransport,
	type DownloadAttachmentArgs,
	type EditMessageArgs,
	type ListMessagesArgs,
	type MessageTarget,
	type ReactionArgs,
	type RespondInteractionArgs,
	type StartThreadArgs,
	type UploadFileArgs,
} from "./transport";

/** Gateway lifecycle event surfaced to the daemon's structured log; `detail` is body-less (never the token). */
export interface GatewayLifecycleEvent {
	type: "connected" | "reconnecting" | "error";
	detail?: string;
}

export interface DiscordSocketTransportOptions {
	/** REST base (tests point it at a local server); the gateway URL comes from its `GET /gateway/bot`. */
	baseUrl?: string;
	fetchImpl?: typeof fetch;
	/** Applied once at start as the bot's global display name (`PATCH /users/@me`); a failure is logged, not fatal. */
	displayName?: string;
	/** Every Ready/Resumed; a new session (`resumed: false`) is where missed-message backfill starts. */
	onReady?: (info: { resumed: boolean }) => void;
	/** A non-retryable gateway close: Discord stops, the rest of the daemon keeps running. */
	onFatal?: (error: DiscordGatewayFatalError) => void;
	onLifecycle?: (event: GatewayLifecycleEvent) => void;
}

/** Gateway + REST. The token is passed in by the caller (read from its secret file by config); never logged here. */
export class DiscordSocketTransport implements DiscordTransport {
	readonly #token: string;
	readonly #rest: DiscordRest;
	readonly #options: DiscordSocketTransportOptions;
	readonly #createdAt = Date.now();
	#gateway: DiscordGateway | undefined;

	constructor(tokens: { botToken: string }, options: DiscordSocketTransportOptions = {}) {
		this.#token = tokens.botToken;
		this.#options = options;
		this.#rest = new DiscordRest({
			token: tokens.botToken,
			...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
			...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
		});
	}

	async start(handlers: DiscordHandlers): Promise<{ botUserId: string; applicationId: string }> {
		const lifecycle = this.#options.onLifecycle ?? (() => {});
		this.#gateway = new DiscordGateway({
			token: this.#token,
			url: async () => (await this.#rest.getGatewayBot()).url,
			handlers,
			onReady: (info) => {
				lifecycle({ type: "connected", ...(info.resumed ? { detail: "resumed" } : {}) });
				this.#options.onReady?.(info);
				handlers.ready?.(info);
			},
			onFatal: (error) => this.#options.onFatal?.(error),
			onError: (error) => {
				console.error(redact(`[ompbot] discord gateway: ${error.message}`));
				lifecycle({ type: "error", detail: error.message });
			},
			onReconnect: (reason) => lifecycle({ type: "reconnecting", detail: reason }),
		});
		const ids = await this.#gateway.start();
		const displayName = this.#options.displayName;
		if (displayName !== undefined) {
			try {
				await this.#rest.patchCurrentUser({ displayName });
			} catch (err) {
				console.error(redact(`[ompbot] discord display_name: ${(err as Error).message}`));
			}
		}
		return ids;
	}

	connectionState(): { state: "up" | "down"; since: number } {
		return this.#gateway?.connectionState() ?? { state: "down", since: this.#createdAt };
	}

	async stop(): Promise<void> {
		this.#gateway?.stop();
	}

	/** When the latest spent REST bucket reopens (0 = none); the delivery pump defers instead of posting into it. */
	blockedUntil(): number {
		return this.#rest.blockedUntil();
	}

	createMessage(args: CreateMessageArgs): Promise<{ id: string }> {
		return this.#rest.createMessage(args);
	}

	editMessage(args: EditMessageArgs): Promise<void> {
		return this.#rest.editMessage(args);
	}

	deleteMessage(args: MessageTarget): Promise<void> {
		return this.#rest.deleteMessage(args);
	}

	addReaction(args: ReactionArgs): Promise<void> {
		return this.#rest.addReaction(args);
	}

	removeReaction(args: ReactionArgs): Promise<void> {
		return this.#rest.removeReaction(args);
	}

	startThread(args: StartThreadArgs): Promise<{ id: string }> {
		return this.#rest.startThread(args);
	}

	getChannel(channelId: string): Promise<DiscordChannelInfo> {
		return this.#rest.getChannel(channelId);
	}

	listMessages(args: ListMessagesArgs): Promise<DiscordMessageEvent[]> {
		return this.#rest.listMessages(args);
	}

	uploadFile(args: UploadFileArgs): Promise<{ id: string }> {
		return this.#rest.uploadFile(args);
	}

	async downloadAttachment(args: DownloadAttachmentArgs): Promise<void> {
		const result = await downloadDiscordAttachment({
			...args,
			...(this.#options.fetchImpl === undefined ? {} : { fetchImpl: this.#options.fetchImpl }),
		});
		if (!result.ok) throw new DiscordCallError("definitive", `attachment_download_failed:${result.error}`);
	}

	respondInteraction(args: RespondInteractionArgs): Promise<void> {
		return this.#rest.respondInteraction(args);
	}

	triggerTyping(channelId: string): Promise<void> {
		return this.#rest.triggerTyping(channelId);
	}
}
