import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

/** One omp session file of an origin, as listed by `/resume-ompbot`. */
export interface SavedSession {
	/** Absolute path of the `.jsonl` file. */
	file: string;
	/** omp session id (from the `session` header line); the file name when the header is unreadable. */
	id: string;
	/** Epoch directory (`e<N>`) the file lives in. */
	epochDir: string;
	modifiedAt: number;
	/** First user message, shortened; `""` when the session has none yet. */
	preview: string;
}

const HEAD_BYTES = 64 * 1024;
const PREVIEW_CHARS = 60;

function readHead(file: string): string {
	const fd = openSync(file, "r");
	try {
		const buffer = Buffer.alloc(HEAD_BYTES);
		const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
		return buffer.subarray(0, read).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: unknown) =>
			typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part
				? String(part.text ?? "")
				: "",
		)
		.join("");
}

/** Session id and first user message from the first 64 KiB of a session file (complete lines only). */
function describe(file: string): { id: string | undefined; preview: string } {
	let id: string | undefined;
	let preview = "";
	const lines = readHead(file).split("\n");
	lines.pop(); // possibly cut off
	for (const line of lines) {
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof record !== "object" || record === null || !("type" in record)) continue;
		if (record.type === "session" && "id" in record && typeof record.id === "string") id = record.id;
		if (record.type === "message" && "message" in record) {
			const message = record.message as { role?: unknown; content?: unknown } | null;
			if (message?.role === "user") {
				preview = textOf(message.content).replace(/\s+/g, " ").trim();
				break;
			}
		}
	}
	if (preview.length > PREVIEW_CHARS) preview = `${preview.slice(0, PREVIEW_CHARS)}…`;
	return { id, preview };
}

/** Every session file under `<originDir>/e<N>/`, newest first. */
export function listSavedSessions(originDir: string): SavedSession[] {
	if (!existsSync(originDir)) return [];
	const sessions: SavedSession[] = [];
	for (const epochDir of readdirSync(originDir)) {
		if (!/^e\d+$/.test(epochDir)) continue;
		const dir = join(originDir, epochDir);
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".jsonl")) continue;
			const file = join(dir, name);
			const { id, preview } = describe(file);
			sessions.push({
				file,
				id: id ?? name.slice(0, -".jsonl".length),
				epochDir,
				modifiedAt: statSync(file).mtimeMs,
				preview,
			});
		}
	}
	return sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/** True when the epoch directory holds no session file yet: the next child open creates the origin's first session. */
export function epochDirIsFresh(sessionDir: string): boolean {
	if (!existsSync(sessionDir)) return true;
	return !readdirSync(sessionDir).some((name) => name.endsWith(".jsonl"));
}

/**
 * `/resume-ompbot <arg>`: a 1-based index into `sessions` (when in range), else a unique session-id prefix of at least 4
 * characters (ids can start with digits).
 */
export function pickSession(sessions: readonly SavedSession[], arg: string): SavedSession | undefined {
	if (/^\d+$/.test(arg)) {
		const indexed = sessions[Number(arg) - 1];
		if (indexed) return indexed;
	}
	if (arg.length < 4) return undefined;
	const matches = sessions.filter((session) => session.id.startsWith(arg));
	return matches.length === 1 ? matches[0] : undefined;
}
