import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { HistoryPage, SlackHandlers, SlackTransport } from "../slack/transport";

/**
 * Test-only transport (daemon uses it only when `OMPBOT_TEST_HOOKS=1` and `OMPBOT_TEST_TRANSPORT=<file>`): every Slack
 * call is appended to a JSONL file, so a test can count messages across daemon crashes and restarts. Nothing leaves
 * the machine. Message timestamps stay unique across processes because the sequence resumes from the file.
 */
export class FileFakeTransport implements SlackTransport {
	#seq: number;

	constructor(
		private readonly path: string,
		private readonly botUserId = "UBOTFAKE",
	) {
		this.#seq = existsSync(path)
			? readFileSync(path, "utf8")
					.split("\n")
					.filter((line) => line.includes('"method":"postMessage"')).length
			: 0;
	}

	async start(_handlers: SlackHandlers): Promise<{ botUserId: string }> {
		return { botUserId: this.botUserId };
	}

	async stop(): Promise<void> {}

	#log(entry: Record<string, unknown>): void {
		appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
	}

	async addReaction(args: { channel: string; timestamp: string; name: string }): Promise<void> {
		this.#log({ method: "addReaction", ...args });
	}

	async removeReaction(args: { channel: string; timestamp: string; name: string }): Promise<void> {
		this.#log({ method: "removeReaction", ...args });
	}

	async postMessage(args: {
		channel: string;
		text: string;
		threadTs?: string | undefined;
		blocks?: readonly unknown[] | undefined;
	}): Promise<{ ts: string }> {
		this.#seq += 1;
		const ts = `1800000000.${String(this.#seq).padStart(6, "0")}`;
		this.#log({ method: "postMessage", ...args, ts });
		return { ts };
	}

	async updateMessage(args: {
		channel: string;
		ts: string;
		text: string;
		blocks?: readonly unknown[] | undefined;
	}): Promise<void> {
		this.#log({ method: "updateMessage", ...args });
	}

	async uploadFile(args: {
		channel: string;
		threadTs?: string | undefined;
		filePath: string;
		title?: string | undefined;
		comment?: string | undefined;
	}): Promise<{ fileId: string }> {
		this.#log({ method: "uploadFile", ...args });
		return { fileId: "FFILEFAKE" };
	}

	async postEphemeral(args: { channel: string; user: string; text: string }): Promise<void> {
		this.#log({ method: "postEphemeral", ...args });
	}

	async getPermalink(args: { channel: string; ts: string }): Promise<string> {
		return `https://slack.test/archives/${args.channel}/p${args.ts.replace(".", "")}`;
	}

	async downloadAttachment(): Promise<void> {
		throw new Error("no attachments in file transport tests");
	}

	async conversationsReplies(): Promise<HistoryPage> {
		return { messages: [] };
	}

	async conversationsHistory(): Promise<HistoryPage> {
		return { messages: [] };
	}
}
