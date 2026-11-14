/**
 * The end of an omp session jsonl (herdr `agent_session` path): the last assistant message and the lines after it,
 * read backwards line by line on this machine or, through {@link LAST_ASSISTANT_PY}, on a remote one. Shared by the
 * dashboard (what a pane says) and the task sweeper (did the worker stop on a question).
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isRecord } from "./type-guards";

export type JsonRecord = Record<string, unknown>;

/** The last assistant message of a session and the lines after it (file order). */
export interface AssistantTail {
	message: JsonRecord;
	after: JsonRecord[];
}

/** A session file is read back from its end this much at a time, and no further back than {@link SESSION_TAIL_MAX_BYTES}. */
export const SESSION_TAIL_CHUNK_BYTES = 256 * 1024;
export const SESSION_TAIL_MAX_BYTES = 4 * 1024 * 1024;

/** herdr's `agent_session` (outside-controlled JSON): `{kind: "path", value}` with an absolute `.jsonl` path, else none. */
export function sessionPathOf(value: unknown): string | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const session = value as { kind?: unknown; value?: unknown };
	if (session.kind !== "path" || typeof session.value !== "string") return undefined;
	return isAbsolute(session.value) && session.value.endsWith(".jsonl") ? session.value : undefined;
}

/** One session line as a record; a broken or half-written line is `undefined` (skipped). */
export function parseSessionLine(line: string): JsonRecord | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** The chat message a session line carries (`{type: "message", message: {role, …}}`), if any. */
export function messageOf(line: JsonRecord | undefined): JsonRecord | undefined {
	return line?.type === "message" && isRecord(line.message) ? line.message : undefined;
}

/** The last assistant message among whole, parsed lines (file order) and the readable lines after it. */
export function lastAssistantIn(lines: ReadonlyArray<JsonRecord | undefined>): AssistantTail | undefined {
	for (let i = lines.length - 1; i >= 0; i--) {
		const message = messageOf(lines[i]);
		if (message?.role === "assistant") {
			return { message, after: lines.slice(i + 1).filter((line): line is JsonRecord => line !== undefined) };
		}
	}
	return undefined;
}

function splitLines(data: Buffer): Buffer[] {
	const parts: Buffer[] = [];
	let start = 0;
	for (let at = data.indexOf(0x0a); at >= 0; at = data.indexOf(0x0a, start)) {
		parts.push(data.subarray(start, at));
		start = at + 1;
	}
	parts.push(data.subarray(start));
	return parts;
}

/**
 * The last assistant message of a local session file and the lines after it, read backwards line by line
 * {@link SESSION_TAIL_CHUNK_BYTES} at a time: a line cut by a chunk start waits for the earlier bytes, so lines are
 * decoded whole (UTF-8 safe); at the file start the first line is whole too. Undefined when no assistant message is
 * within the last {@link SESSION_TAIL_MAX_BYTES}. Throws when the file cannot be opened or read.
 */
export function readLastAssistant(path: string): AssistantTail | undefined {
	const fd = openSync(path, "r");
	try {
		let pos = fstatSync(fd).size;
		let consumed = 0;
		let head: Buffer = Buffer.alloc(0); // the front of a line whose start is still unread
		let after: JsonRecord[] = [];
		while (pos > 0 && consumed < SESSION_TAIL_MAX_BYTES) {
			const step = Math.min(SESSION_TAIL_CHUNK_BYTES, SESSION_TAIL_MAX_BYTES - consumed, pos);
			pos -= step;
			consumed += step;
			const chunk = Buffer.alloc(step);
			readSync(fd, chunk, 0, step, pos);
			const parts = splitLines(head.length === 0 ? chunk : Buffer.concat([chunk, head]));
			head = pos > 0 ? (parts.shift() ?? Buffer.alloc(0)) : Buffer.alloc(0);
			const lines = parts.filter((line) => line.length > 0).map((line) => parseSessionLine(line.toString("utf8")));
			const found = lastAssistantIn(lines);
			if (found !== undefined) return { message: found.message, after: [...found.after, ...after] };
			after = [...lines.filter((line): line is JsonRecord => line !== undefined), ...after];
		}
		return undefined;
	} finally {
		closeSync(fd);
	}
}

/**
 * The remote twin of {@link readLastAssistant}, run as `python3 -` with this program on stdin (the `{"path"}` argument
 * is base64 JSON inside it, never an argv word). Prints one JSON object: `{"lines": [...]}` with the whole lines from
 * the last assistant line to the end, `{"lines": null}` when none is within the byte cap, or `{"error": "..."}`.
 */
export const LAST_ASSISTANT_PY = `
import base64, json, os, sys
CHUNK = ${SESSION_TAIL_CHUNK_BYTES}
MAX = ${SESSION_TAIL_MAX_BYTES}
def is_assistant(raw):
    try:
        value = json.loads(raw)
    except Exception:
        return False
    message = value.get("message") if isinstance(value, dict) and value.get("type") == "message" else None
    return isinstance(message, dict) and message.get("role") == "assistant"
def tail(path):
    with open(path, "rb") as f:
        pos = os.fstat(f.fileno()).st_size
        consumed = 0
        head = b""
        after = []
        while pos > 0 and consumed < MAX:
            step = min(CHUNK, MAX - consumed, pos)
            pos -= step
            consumed += step
            f.seek(pos)
            parts = (f.read(step) + head).split(b"\\n")
            head = parts.pop(0) if pos > 0 else b""
            lines = [line for line in parts if line]
            for i in range(len(lines) - 1, -1, -1):
                if is_assistant(lines[i]):
                    return [line.decode("utf-8", "replace") for line in lines[i:]] + after
            after = [line.decode("utf-8", "replace") for line in lines] + after
    return None
def main():
    args = json.loads(base64.b64decode(ARGS).decode("utf-8"))
    try:
        out = {"lines": tail(args["path"])}
    except Exception as error:
        out = {"error": str(error)}
    sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode("utf-8"))
`;

/** The whole `python3 -` program for one session path: {@link LAST_ASSISTANT_PY} with its argument, then the call. */
export function lastAssistantProgram(path: string): string {
	const args = Buffer.from(JSON.stringify({ path }), "utf8").toString("base64");
	return `ARGS = "${args}"\n${LAST_ASSISTANT_PY}\nmain()\n`;
}

/** {@link LAST_ASSISTANT_PY} output read back as the same tail the local reader gives; throws on an error or bad output. */
export function parseLastAssistantOutput(stdout: string): AssistantTail | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error("session tail output is not JSON");
	}
	if (!isRecord(parsed)) throw new Error("session tail output is not an object");
	if (typeof parsed.error === "string") throw new Error(parsed.error);
	if (parsed.lines === null) return undefined;
	if (!Array.isArray(parsed.lines)) throw new Error("session tail output has no lines");
	return lastAssistantIn(parsed.lines.map((line) => (typeof line === "string" ? parseSessionLine(line) : undefined)));
}

/** The first tool call of the tail's assistant message with no `toolResult` of the same id after it. */
export function pendingToolCall(found: AssistantTail): JsonRecord | undefined {
	const content = Array.isArray(found.message.content) ? found.message.content.filter(isRecord) : [];
	const answered = new Set(
		found.after
			.map(messageOf)
			.filter((message) => message?.role === "toolResult" && typeof message.toolCallId === "string")
			.map((message) => message?.toolCallId as string),
	);
	return content.find(
		(block) => block.type === "toolCall" && !(typeof block.id === "string" && answered.has(block.id)),
	);
}

/** What a worker's last answer is, for the question check. */
export interface LastAnswer {
	/** The text blocks of the last assistant message, joined by newlines. */
	text: string;
	/** It ended on an error (`stopReason: "error"` or an `errorMessage`). */
	errored: boolean;
	/** It has a tool call with no result yet (herdr `blocked`: an `ask` or a tool approval). */
	pendingTool: boolean;
	/** A `user` message came after it (an answer or a prompt is already in). */
	userAfter: boolean;
}

export function lastAnswerOf(found: AssistantTail): LastAnswer {
	const content = Array.isArray(found.message.content) ? found.message.content.filter(isRecord) : [];
	const text = content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
	const error = typeof found.message.errorMessage === "string" ? found.message.errorMessage : "";
	return {
		text,
		errored: found.message.stopReason === "error" || error !== "",
		pendingTool: pendingToolCall(found) !== undefined,
		userAfter: found.after.some((line) => messageOf(line)?.role === "user"),
	};
}

/** Whether a text ends on a question: its last non-empty line, trimmed, ends with `?` or `？`. Lanes and tasks share it. */
export function endsWithQuestion(text: string): boolean {
	const last = text
		.split("\n")
		.map((line) => line.trim())
		.findLast((line) => line !== "");
	return last !== undefined && /[?？]$/.test(last);
}

/** The answer's text when the worker stopped on a question in prose; an error end, a pending tool call or a later user message is no such stop. */
export function questionOf(answer: LastAnswer): string | undefined {
	if (answer.errored || answer.pendingTool || answer.userAfter) return undefined;
	return endsWithQuestion(answer.text) ? answer.text : undefined;
}
