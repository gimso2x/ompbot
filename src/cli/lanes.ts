import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, timezoneOfHome } from "../config";
import { sessionToResume } from "../core/mailbox";
import { callDaemon } from "../daemon/ipc";
import { withOmpProfile } from "../omp/env";
import { newestSessionFile } from "../omp/session-heal";
import { isRecord } from "../omp/type-guards";
import { redact } from "../redact";
import type { OriginRow } from "../store/db";
import { TASK_ID_PATTERN } from "../tasks/docs";
import { sourceAgentDir } from "./omp";

export const LANES_USAGE = `  lanes watch <lane|origin> [--lines N]   follow a lane's or conversation's omp session read-only: user text, assistant
                                 text and tool calls, one line each (last N, default 10, then new entries); the file is the
                                 one the daemon's running child has open, else the one the next child would resume; Ctrl-C stops
  lanes watch <T-YYYYMMDD-NN>    the same for a local herdr TASK worker: the newest omp session of its worktree
  lanes attach <lane> [--wait] [--keep-paused]
                                 take a lane's session over in this terminal: the daemon stops the lane's turn (--wait: lets it
                                 finish) and its omp child, then omp --resume opens the same file in the lane's worktree; when
                                 omp exits the lane is handed back and resumed (--keep-paused: stays paused). Thread messages
                                 wait meanwhile. The daemon must be running; if this process dies the lane is taken back
`;

/** How often the followed file is re-stat'ed; new entries show well within 2 s. */
const POLL_MS = 250;
/** How long the daemon may take to name the open file before the rule-only choice is used. */
const DAEMON_ASK_MS = 3_000;
/** `lane_attach` without `--wait`: the abort and the child stop. */
const ATTACH_MS = 60_000;
/** `lane_attach --wait`: the running turn may take this long to end. */
const ATTACH_WAIT_MS = 60 * 60_000;
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
	/** HOME and PI_CODING_AGENT_DIR, which place a TASK worker's omp sessions; absent = `process.env`. */
	env?: Record<string, string | undefined>;
	/** The omp command `lanes attach` runs (before `--resume …`); absent = the daemon's `ompExecutable` from config. */
	ompCommand?: string[];
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

/** The file `ompbot lanes watch` follows, how it names the target, and why that file; a string is the one error line. */
type WatchPick = { file: string; label: string; source: string } | string;

async function pickOriginFile(homeDir: string, target: string, deps: LanesDeps): Promise<WatchPick> {
	const found = resolveWatchTarget(homeDir, target);
	if (found === undefined) return `no lane or origin named ${target}`;
	const { origin } = found;
	const answer = await (deps.askDaemon ?? ((key: string) => askDaemonSocket(homeDir, key)))(origin.originKey);
	const file = answer.kind === "open" ? answer.file : sessionToResume(origin);
	if (file === undefined || !existsSync(file))
		return `${target} has no session file yet (${file ?? origin.sessionDir})`;
	const source =
		answer.kind === "open"
			? "open in the running child"
			: answer.kind === "none"
				? "no running child; the file the next child resumes"
				: `no answer from the daemon (${answer.reason}); the file the next child resumes`;
	const label = found.lane === undefined ? origin.originKey : `lane ${found.lane} (${origin.originKey})`;
	return { file, label, source };
}

/**
 * The folder omp keeps the sessions of a cwd in, under `sessionsRoot`: omp's default-session-dir naming (omp
 * `session-paths.ts`, read 2026-11-13): a cwd inside the temp root is `-tmp-<rest>`, one inside the user's home
 * `-<rest>` (path separators and `:` as `-`), any other `--<path>--`. The cwd and both roots are compared by real path.
 */
export function ompSessionDirFor(cwd: string, userHome: string, sessionsRoot: string, tempRoot = tmpdir()): string {
	const real = (path: string): string => {
		try {
			return realpathSync(resolve(path));
		} catch {
			return resolve(path);
		}
	};
	const canonical = real(cwd);
	const within = (root: string): string | undefined => {
		const rel = relative(real(root), canonical);
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? rel : undefined;
	};
	const encode = (prefix: string, rel: string): string => {
		const encoded = rel.replace(/[/\\:]/g, "-");
		return encoded === "" ? prefix : prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`;
	};
	const inTemp = within(tempRoot);
	const inHome = within(userHome);
	const name =
		inTemp !== undefined
			? encode("-tmp", inTemp)
			: inHome !== undefined
				? encode("-", inHome)
				: `--${canonical.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(sessionsRoot, name);
}

/**
 * A herdr TASK worker's session: the `tasks` row's worktree names the omp session folder, whose newest file the worker
 * writes. Only local TASKs (`host` null); a remote one is watched on its host.
 */
function pickTaskFile(homeDir: string, taskId: string, deps: LanesDeps): WatchPick {
	const db = new Database(join(homeDir, "ompbot.db"), { readonly: true, strict: true });
	let row: { host: string | null; worktree: string } | null;
	try {
		const table = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get();
		row =
			table === null
				? null
				: (db.query("SELECT host, worktree FROM tasks WHERE task_id = ?").get(taskId) as {
						host: string | null;
						worktree: string;
					} | null);
	} finally {
		db.close();
	}
	if (row === null) return `no TASK named ${taskId}`;
	if (row.host !== null) return `${taskId} runs on ${row.host}; a remote TASK is watched on that host`;
	const env = deps.env ?? process.env;
	const userHome = env.HOME ?? homedir();
	const sessionsRoot = join(sourceAgentDir(env), "sessions");
	const dir = ompSessionDirFor(row.worktree, userHome, sessionsRoot);
	const file = existsSync(dir) ? newestSessionFile(dir) : undefined;
	if (file === undefined) return `${taskId} has no omp session yet (${dir})`;
	return { file, label: `TASK ${taskId} (${row.worktree})`, source: "the newest session of the worker's folder" };
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
	const timer = setInterval(tick, POLL_MS);
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
		error(`lanes watch: one <lane|origin|T-…> expected (ompbot --help)`);
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
	const picked = TASK_ID_PATTERN.test(target)
		? pickTaskFile(homeDir, target, deps)
		: await pickOriginFile(homeDir, target, deps);
	if (typeof picked === "string") {
		error(`lanes watch: ${picked}`);
		return 1;
	}
	const { file, label, source } = picked;
	const timezone = timezoneOfHome(homeDir);
	const size = statSync(file).size;
	write(`watching ${label}`);
	write(`file ${file} — ${source}`);
	// A partial last line is left for `follow`: the backlog ends, and following starts, right after the last newline.
	const head = readRange(file, 0, size);
	const start = head.lastIndexOf(0x0a) + 1;
	if (backlog > 0) {
		for (const line of linesOf(head.subarray(0, start).toString("utf8"), timezone).slice(-backlog)) write(line);
	}
	await follow(file, start, timezone, write, deps.signal ?? processSignal());
	return 0;
}

/** The `*.jsonl` files of `dir` now (none for a missing dir). */
function sessionFilesIn(dir: string): Set<string> {
	if (!existsSync(dir)) return new Set();
	return new Set(
		readdirSync(dir)
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => join(dir, name)),
	);
}

/**
 * `ompbot lanes attach <lane>`: asks the daemon (`lane_attach`) to release the lane, runs `omp --resume <file>` in this
 * terminal in the lane's worktree, then gives the lane back (`lane_detach`) with the session files omp created
 * meanwhile. The daemon's answer is the only signal: nothing is guessed from files or mtimes.
 */
async function attachCommand(args: string[], homeDir: string, deps: LanesDeps): Promise<number> {
	const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));
	const error = deps.error ?? ((line: string) => process.stderr.write(`${line}\n`));
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: { wait: { type: "boolean" }, "keep-paused": { type: "boolean" } },
	});
	const [lane, ...extra] = positionals;
	if (lane === undefined || extra.length > 0) {
		error("lanes attach: one <lane> expected (ompbot --help)");
		return 2;
	}
	const socket = join(homeDir, "ompbot.sock");
	if (!existsSync(socket)) {
		error("lanes attach: the daemon is not running (no ompbot.sock); attach needs it to release the lane");
		return 1;
	}
	let ompCommand = deps.ompCommand;
	let env: Record<string, string | undefined> = deps.env ?? process.env;
	if (ompCommand === undefined) {
		const config = loadConfig(homeDir, { checkTokens: false });
		ompCommand = [config.ompExecutable];
		env = withOmpProfile(env, config.ompProfile);
	}
	const wait = values.wait === true;
	let answer: unknown;
	try {
		answer = await callDaemon(
			socket,
			{ op: "lane_attach", lane, pid: process.pid, wait, keepPaused: values["keep-paused"] === true },
			wait ? ATTACH_WAIT_MS : ATTACH_MS,
		);
	} catch (cause) {
		error(`lanes attach: no answer from the daemon (${cause instanceof Error ? cause.message : String(cause)})`);
		return 1;
	}
	if (
		!isRecord(answer) ||
		answer.ok !== true ||
		typeof answer.sessionFile !== "string" ||
		typeof answer.cwd !== "string" ||
		typeof answer.sessionDir !== "string"
	) {
		const why = isRecord(answer) && typeof answer.error === "string" ? answer.error : "bad response";
		error(`lanes attach: ${why}`);
		return 1;
	}
	const { sessionFile, cwd, sessionDir } = answer;
	write(`attached lane ${lane}: ${sessionFile}`);
	write("the lane is paused; quit omp to hand it back");
	const before = sessionFilesIn(sessionDir);
	// Ctrl-C belongs to omp in this terminal: this process must live on to hand the lane back.
	const ignore = () => {};
	process.on("SIGINT", ignore);
	let code: number;
	try {
		const child = Bun.spawn([...ompCommand, "--resume", sessionFile, "--session-dir", sessionDir], {
			cwd,
			env,
			stdio: ["inherit", "inherit", "inherit"],
		});
		code = await child.exited;
	} catch (cause) {
		error(`lanes attach: omp did not start (${cause instanceof Error ? cause.message : String(cause)})`);
		code = -1;
	} finally {
		process.off("SIGINT", ignore);
	}
	const newFiles = [...sessionFilesIn(sessionDir)].filter((file) => !before.has(file)).sort();
	let back: unknown;
	try {
		back = await callDaemon(socket, { op: "lane_detach", lane, sessionFile, newFiles }, ATTACH_MS);
	} catch (cause) {
		error(
			`lanes attach: could not hand the lane back (${cause instanceof Error ? cause.message : String(cause)}); the daemon takes it back within a minute after this process exits`,
		);
		return 1;
	}
	if (!isRecord(back) || back.ok !== true) {
		const why = isRecord(back) && typeof back.error === "string" ? back.error : "bad response";
		error(`lanes attach: hand-back refused: ${why}`);
		return 1;
	}
	write(`handed lane ${lane} back${newFiles.length > 0 ? ` (new session files: ${newFiles.join(", ")})` : ""}`);
	if (typeof back.text === "string") write(back.text);
	return code === 0 ? 0 : 1;
}

/** `ompbot lanes <sub>`: `watch` and `attach`. */
export async function lanesCommand(args: string[], homeDir: string, deps: LanesDeps = {}): Promise<number> {
	const [sub, ...rest] = args;
	if (sub === "watch") return await watchCommand(rest, homeDir, deps);
	if (sub === "attach") return await attachCommand(rest, homeDir, deps);
	process.stderr.write(`usage: ompbot lanes\n${LANES_USAGE}`);
	return sub === undefined || sub === "--help" ? 0 : 2;
}
