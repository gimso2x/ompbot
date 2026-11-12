import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { timezoneOfHome } from "../config";
import { sessionToResume } from "../core/mailbox";
import { callDaemon } from "../daemon/ipc";
import { isRecord } from "../omp/type-guards";
import { redact } from "../redact";
import type { OriginRow } from "../store/db";

export const LANES_USAGE = `  lanes watch <lane|origin> [--lines N]   follow a lane's or conversation's omp session read-only: user text, assistant
                                 text and tool calls, one line each (last N, default 10, then new entries); the file is the
                                 one the daemon's running child has open, else the one the next child would resume; Ctrl-C stops
`;

/** How often the followed file is re-stat'ed; new entries show well within 2 s. */
const POLL_MS = 250;
/** How long the daemon may take to name the open file before the rule-only choice is used. */
const DAEMON_ASK_MS = 3_000;
const PREVIEW_CHARS = 200;
const DEFAULT_LINES = 10;

/** Test seam of `lanesCommand`. */
export interface LanesDeps {
	write?: (line: string) => void;
	error?: (line: string) => void;
	/** Stops the watch; absent = Ctrl-C / SIGTERM of this process. */
	signal?: AbortSignal;
	/** The file the daemon's running child of `originKey` has open; absent = the daemon socket of `homeDir`. */
	askDaemon?: (originKey: string) => Promise<DaemonAnswer>;
	pollMs?: number;
}

/** `open`: the running child's file; `none`: the daemon runs no child for it; `down`: no daemon answered. */
export type DaemonAnswer = { kind: "open"; file: string } | { kind: "none" } | { kind: "down"; reason: string };

async function askDaemonSocket(homeDir: string, originKey: string): Promise<DaemonAnswer> {
	const socket = join(homeDir, "ompbot.sock");
	if (!existsSync(socket)) return { kind: "down", reason: "no socket" };
	let response: unknown;
	try {
		response = await callDaemon(socket, { op: "session_file", origin: originKey }, DAEMON_ASK_MS);
	} catch (error) {
		return { kind: "down", reason: error instanceof Error ? error.message : String(error) };
	}
	if (!isRecord(response) || response.ok !== true) {
		const why = isRecord(response) && typeof response.error === "string" ? response.error : "bad response";
		return { kind: "down", reason: why };
	}
	return typeof response.sessionFile === "string" ? { kind: "open", file: response.sessionFile } : { kind: "none" };
}

/**
 * The origin `target` names: a lane name (`lanes.name`) first, else an origin key. Read from a read-only connection,
 * so watching never writes the ledger. Undefined when neither matches.
 */
export function resolveWatchTarget(homeDir: string, target: string): { origin: OriginRow; lane?: string } | undefined {
	const db = new Database(join(homeDir, "ompbot.db"), { readonly: true, strict: true });
	try {
		const lane = db.query("SELECT origin_key FROM lanes WHERE name = ?").get(target) as { origin_key: string } | null;
		const originKey = lane?.origin_key ?? target;
		const origin = db
			.query(
				"SELECT origin_key AS originKey, epoch, session_dir AS sessionDir, updated_at AS updatedAt, session_file AS sessionFile, model, thinking FROM origins WHERE origin_key = ?",
			)
			.get(originKey) as OriginRow | null;
		if (origin === null) return undefined;
		return lane === null ? { origin } : { origin, lane: target };
	} finally {
		db.close();
	}
}

const preview = (text: string): string => {
	const flat = redact(text).replace(/\s+/g, " ").trim();
	return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
};

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
		.join(" ");
}

function toolSummary(part: Record<string, unknown>): string {
	const name = typeof part.name === "string" ? part.name : "?";
	const args = isRecord(part.arguments) ? part.arguments : undefined;
	const intent = typeof part.intent === "string" ? part.intent : typeof args?.i === "string" ? args.i : undefined;
	const detail = intent ?? (args === undefined ? "" : JSON.stringify(args));
	return detail === "" ? name : `${name} ${preview(detail)}`;
}

/**
 * One omp session record as watch lines: a user message, each assistant text part and each tool call get one line
 * (`HH:MM:SS user: …`, `assistant: …`, `tool: <name> <intent or arguments>`); every other record prints nothing.
 */
export function summarizeEntry(record: unknown, timezone: string): string[] {
	if (!isRecord(record) || record.type !== "message" || !isRecord(record.message)) return [];
	const { role, content } = record.message;
	const at = typeof record.timestamp === "string" ? new Date(record.timestamp) : undefined;
	const clock =
		at === undefined || Number.isNaN(at.getTime())
			? "--:--:--"
			: at.toLocaleTimeString("en-GB", { timeZone: timezone, hour12: false });
	if (role === "user") {
		const text = preview(textOf(content));
		return text === "" ? [] : [`${clock} user: ${text}`];
	}
	if (role !== "assistant" || !Array.isArray(content)) return [];
	const lines: string[] = [];
	for (const part of content) {
		if (!isRecord(part)) continue;
		if (part.type === "text" && typeof part.text === "string") {
			const text = preview(part.text);
			if (text !== "") lines.push(`${clock} assistant: ${text}`);
		} else if (part.type === "toolCall") {
			lines.push(`${clock} tool: ${toolSummary(part)}`);
		}
	}
	return lines;
}

function linesOf(chunk: string, timezone: string): string[] {
	const out: string[] = [];
	for (const raw of chunk.split("\n")) {
		if (raw.trim() === "") continue;
		let record: unknown;
		try {
			record = JSON.parse(raw);
		} catch {
			out.push(`(unreadable session line, ${raw.length} chars)`);
			continue;
		}
		out.push(...summarizeEntry(record, timezone));
	}
	return out;
}

/** Bytes `[from, to)` of `file`, read through a read-only descriptor. */
function readRange(file: string, from: number, to: number): Buffer {
	const buffer = Buffer.alloc(to - from);
	const fd = openSync(file, "r");
	try {
		let done = 0;
		while (done < buffer.length) {
			const n = readSync(fd, buffer, done, buffer.length - done, from + done);
			if (n === 0) break;
			done += n;
		}
		return buffer.subarray(0, done);
	} finally {
		closeSync(fd);
	}
}

/**
 * Follows `file` from its current end: complete new lines are summarized and written as they land; a trailing partial
 * line waits for its newline. Resolves when `signal` aborts. Only ever opens the file read-only.
 */
function follow(
	file: string,
	start: number,
	timezone: string,
	write: (line: string) => void,
	signal: AbortSignal,
	pollMs: number,
): Promise<void> {
	let offset = start;
	let pending = Buffer.alloc(0);
	const tick = () => {
		const size = statSync(file).size;
		if (size < offset) {
			// Rewritten shorter (not omp's append-only writing): start over from its new end.
			write(`(session file shrank ${offset} -> ${size} bytes; following from the new end)`);
			offset = size;
			pending = Buffer.alloc(0);
			return;
		}
		if (size === offset) return;
		const data = Buffer.concat([pending, readRange(file, offset, size)]);
		offset = size;
		const cut = data.lastIndexOf(0x0a);
		if (cut === -1) {
			pending = data;
			return;
		}
		pending = data.subarray(cut + 1);
		for (const line of linesOf(data.subarray(0, cut).toString("utf8"), timezone)) write(line);
	};
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setInterval(tick, pollMs);
	const stop = () => {
		clearInterval(timer);
		resolve();
	};
	if (signal.aborted) stop();
	else signal.addEventListener("abort", stop, { once: true });
	return promise;
}

function processSignal(): AbortSignal {
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	return controller.signal;
}

async function watchCommand(args: string[], homeDir: string, deps: LanesDeps): Promise<number> {
	const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));
	const error = deps.error ?? ((line: string) => process.stderr.write(`${line}\n`));
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: { lines: { type: "string" } },
	});
	const [target, ...extra] = positionals;
	if (target === undefined || extra.length > 0) {
		error(`lanes watch: one <lane|origin> expected (ompbot --help)`);
		return 2;
	}
	const backlog = values.lines === undefined ? DEFAULT_LINES : Number(values.lines);
	if (!Number.isInteger(backlog) || backlog < 0) {
		error(`lanes watch: --lines must be a whole number >= 0`);
		return 2;
	}
	if (!existsSync(join(homeDir, "ompbot.db"))) {
		error(`lanes watch: no ompbot.db in ${homeDir}`);
		return 1;
	}
	const found = resolveWatchTarget(homeDir, target);
	if (found === undefined) {
		error(`lanes watch: no lane or origin named ${target}`);
		return 1;
	}
	const { origin } = found;
	const answer = await (deps.askDaemon ?? ((key: string) => askDaemonSocket(homeDir, key)))(origin.originKey);
	const file = answer.kind === "open" ? answer.file : sessionToResume(origin);
	if (file === undefined || !existsSync(file)) {
		error(`lanes watch: ${target} has no session file yet (${file ?? origin.sessionDir})`);
		return 1;
	}
	const source =
		answer.kind === "open"
			? "open in the running child"
			: answer.kind === "none"
				? "no running child; the file the next child resumes"
				: `no answer from the daemon (${answer.reason}); the file the next child resumes`;
	const timezone = timezoneOfHome(homeDir);
	const size = statSync(file).size;
	write(`watching ${found.lane === undefined ? origin.originKey : `lane ${found.lane} (${origin.originKey})`}`);
	write(`file ${file} — ${source}`);
	// A partial last line is left for `follow`: the backlog ends, and following starts, right after the last newline.
	const head = readRange(file, 0, size);
	const start = head.lastIndexOf(0x0a) + 1;
	if (backlog > 0) {
		for (const line of linesOf(head.subarray(0, start).toString("utf8"), timezone).slice(-backlog)) write(line);
	}
	await follow(file, start, timezone, write, deps.signal ?? processSignal(), deps.pollMs ?? POLL_MS);
	return 0;
}

/** `ompbot lanes <sub>`; only `watch` exists. */
export async function lanesCommand(args: string[], homeDir: string, deps: LanesDeps = {}): Promise<number> {
	const [sub, ...rest] = args;
	if (sub === "watch") return await watchCommand(rest, homeDir, deps);
	process.stderr.write(`usage: ompbot lanes\n${LANES_USAGE}`);
	return sub === undefined || sub === "--help" ? 0 : 2;
}
