import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type {
	CreateMessageArgs,
	DiscordChannelInfo,
	DiscordHandlers,
	DiscordMessageEvent,
	DiscordTransport,
	EditInteractionResponseArgs,
	EditMessageArgs,
	MessageTarget,
	ReactionArgs,
	RegisterCommandsArgs,
	RespondInteractionArgs,
	StartThreadArgs,
	UploadFileArgs,
} from "./transport";

/** First id the fakes hand out; snowflake-sized so id handling sees realistic values. */
export const FAKE_ID_BASE = 900_000_000_000_000_000n;

/** Calls that mint a message id; their log lines also count the ids already handed out. */
const ID_METHODS = /"method":"(createMessage|uploadFile)"/;

/**
 * Test-only transport (the Discord twin of `FileFakeTransport`, for `OMPBOT_TEST_TRANSPORT=<file>` runs): every call is
 * appended to a JSONL file, so a test can count messages across daemon crashes and restarts. Nothing leaves the
 * machine. Message ids stay unique across processes because the sequence resumes from the file.
 */
export class FileFakeDiscordTransport implements DiscordTransport {
	#seq: bigint;

	constructor(
		private readonly path: string,
		private readonly ids: { botUserId: string; applicationId: string } = {
			botUserId: "500000000000000009",
			applicationId: "600000000000000009",
		},
	) {
		this.#seq = existsSync(path)
			? BigInt(
					readFileSync(path, "utf8")
						.split("\n")
						.filter((line) => ID_METHODS.test(line)).length,
				)
			: 0n;
	}

	async start(_handlers: DiscordHandlers): Promise<{ botUserId: string; applicationId: string }> {
		return { ...this.ids };
	}

	async stop(): Promise<void> {}

	#log(entry: Record<string, unknown>): void {
		appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
	}

	#nextId(): string {
		this.#seq += 1n;
		return String(FAKE_ID_BASE + this.#seq);
	}

	async createMessage(args: CreateMessageArgs): Promise<{ id: string }> {
		const id = this.#nextId();
		this.#log({ method: "createMessage", ...args, id });
		return { id };
	}

	async editMessage(args: EditMessageArgs): Promise<void> {
		this.#log({ method: "editMessage", ...args });
	}

	async deleteMessage(args: MessageTarget): Promise<void> {
		this.#log({ method: "deleteMessage", ...args });
	}

	async addReaction(args: ReactionArgs): Promise<void> {
		this.#log({ method: "addReaction", ...args });
	}

	async removeReaction(args: ReactionArgs): Promise<void> {
		this.#log({ method: "removeReaction", ...args });
	}

	async startThread(args: StartThreadArgs): Promise<{ id: string }> {
		this.#log({ method: "startThread", ...args });
		return { id: args.messageId };
	}

	async getChannel(channelId: string): Promise<DiscordChannelInfo> {
		// No guild state in file runs: every channel reads as a DM channel.
		return { id: channelId, type: 1 };
	}

	async listMessages(): Promise<DiscordMessageEvent[]> {
		return [];
	}

	async uploadFile(args: UploadFileArgs): Promise<{ id: string }> {
		const id = this.#nextId();
		this.#log({ method: "uploadFile", ...args, id });
		return { id };
	}

	async downloadAttachment(): Promise<void> {
		throw new Error("no attachments in file transport tests");
	}

	async respondInteraction(args: RespondInteractionArgs): Promise<void> {
		this.#log({ method: "respondInteraction", ...args });
	}

	async editInteractionResponse(args: EditInteractionResponseArgs): Promise<void> {
		this.#log({ method: "editInteractionResponse", ...args });
	}

	async deleteInteractionResponse(args: { token: string }): Promise<void> {
		this.#log({ method: "deleteInteractionResponse", ...args });
	}

	async registerCommands(args: RegisterCommandsArgs): Promise<void> {
		this.#log({ method: "registerCommands", ...args });
	}

	async triggerTyping(channelId: string): Promise<void> {
		this.#log({ method: "triggerTyping", channelId });
	}
}
