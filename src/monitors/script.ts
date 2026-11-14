import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolveScript, SCRIPT_TIMEOUT_MS } from "./spec";

/** The payload handed to the agent is cut to this many chars (the script is not killed for it). */
export const MAX_SCRIPT_OUTPUT_CHARS = 8000;
/** Memory bound for the head of the output kept for the payload; the hash still covers the whole stream. */
const MAX_SCRIPT_COLLECT_CHARS = 4 * 1024 * 1024;
/** The end of an output past the head bound kept for its last line (the wake gate) and the stderr tail. */
const SCRIPT_TAIL_CHARS = 64 * 1024;
/** The stderr tail attached to the monitor_script log event (stdout keeps the gate, the hash and the wake call). */
export const MAX_SCRIPT_STDERR_TAIL_CHARS = 2000;
/** How long the stdio streams may still take to close after "exit": a detached background child holding a pipe
 * end delays "close" to the timeout (a setsid daemon: forever, which would stall the monitor). */
const STREAM_CLOSE_GRACE_MS = 1000;
const TRUNCATION_MARK = "\n...[truncated]...\n";
const EMPTY_HASH = createHash("sha256").update("").digest("hex");

export interface ScriptResult {
	/** Exit code 0: the watch condition holds and the monitor fires. */
	fired: boolean;
	exitCode: number | null;
	timedOut: boolean;
	/** Killed because `signal` aborted (daemon shutdown); `fired` is then false. */
	aborted?: boolean;
	/** Trimmed output cut to `MAX_SCRIPT_OUTPUT_CHARS` (the last line is kept). */
	stdout: string;
	/** Trimmed stderr cut to `MAX_SCRIPT_STDERR_TAIL_CHARS` (feeds only the monitor_script log tail). */
	stderr: string;
	/** sha256 of the whole trimmed output, not of the cut payload. */
	outputHash: string;
	/** The whole output's last non-empty line is `{"wakeAgent": false}`. */
	wakeOff: boolean;
	/** Why it did not run at all (path check or spawn failure). */
	error?: string;
}

/** The result of a check that never ran: no exit code, `error` says why (path check or spawn failure). */
function notRun(error: string): ScriptResult {
	return {
		fired: false,
		exitCode: null,
		timedOut: false,
		stdout: "",
		stderr: "",
		outputHash: EMPTY_HASH,
		wakeOff: false,
		error,
	};
}

/**
 * Runs a watch script once. The command is re-checked against the scripts root on every run (a symlink swapped
 * after `add` must not escape), it gets a minimal environment (`PATH`, `LANG`, `HOME`, `OMPBOT_HOME` = `homeDir`,
 * `OMPBOT_MONITOR_ID`), and the whole process group is killed on timeout or when `signal` aborts.
 */
export async function runScript(
	command: readonly string[],
	options: {
		scriptsRoot: string;
		timeoutMs?: number;
		cwd: string;
		monitorId?: string;
		homeDir?: string;
		signal?: AbortSignal;
		streamCloseGraceMs?: number;
	},
): Promise<ScriptResult> {
	let real: string;
	try {
		real = resolveScript(command, options.scriptsRoot);
	} catch (error) {
		return notRun(String(error instanceof Error ? error.message : error));
	}
	let child: ChildProcess;
	try {
		child = spawn(real, command.slice(1), {
			cwd: options.cwd,
			// stderr is piped for the monitor_script log tail; it never touches the gate, the hash or the wake call.
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				LANG: process.env.LANG ?? "C.UTF-8",
				...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
				...(options.homeDir === undefined ? {} : { OMPBOT_HOME: options.homeDir }),
				...(options.monitorId === undefined ? {} : { OMPBOT_MONITOR_ID: options.monitorId }),
			},
		});
	} catch (error) {
		// spawn throws synchronously for what it cannot take (a NUL byte in an argument): a run that did not happen.
		return notRun(error instanceof Error ? error.message : String(error));
	}
	// stdout: the head (payload) up to the collect bound, then a rolling tail (last line); the hash takes every chunk.
	let head = "";
	let tail: string | undefined;
	const hash = trimmedHash();
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		hash.update(chunk);
		const room = MAX_SCRIPT_COLLECT_CHARS - head.length;
		if (room > 0) head += chunk.slice(0, room);
		if (chunk.length > room) tail = `${tail ?? ""}${chunk.slice(Math.max(room, 0))}`.slice(-SCRIPT_TAIL_CHARS);
	});
	// Only the last `MAX_SCRIPT_STDERR_TAIL_CHARS` chars reach the log: a rolling tail is enough.
	let stderr = "";
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		stderr = `${stderr}${chunk}`.slice(-SCRIPT_TAIL_CHARS);
	});
	const done = Promise.withResolvers<{ code: number | null; spawnError?: string }>();
	child.once("error", (error) => done.resolve({ code: null, spawnError: error.message }));
	child.once("close", (code) => done.resolve({ code }));
	// "close" additionally waits for every stdio stream, so a background child that outlives the
	// script while holding a pipe end delays it to the timeout (a setsid daemon: forever). The
	// code is already known at "exit": give the streams a short grace to drain, then take the
	// code and drop the streams with whatever output arrived.
	child.once("exit", (code) => {
		const drain = setTimeout(() => {
			child.stdout?.destroy();
			child.stderr?.destroy();
			done.resolve({ code });
		}, options.streamCloseGraceMs ?? STREAM_CLOSE_GRACE_MS);
		child.once("close", () => clearTimeout(drain));
	});
	const killGroup = () => {
		try {
			if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	};
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		killGroup();
	}, options.timeoutMs ?? SCRIPT_TIMEOUT_MS);
	let abortRequested = false;
	const onAbort = () => {
		abortRequested = true;
		killGroup();
	};
	if (options.signal?.aborted) onAbort();
	else options.signal?.addEventListener("abort", onAbort, { once: true });
	const { code, spawnError } = await done.promise;
	clearTimeout(timer);
	options.signal?.removeEventListener("abort", onAbort);
	// A script that already exited 0 when the abort came finished its work: only a killed run counts as aborted.
	const aborted = abortRequested && code !== 0;
	if (spawnError !== undefined) {
		return notRun(spawnError);
	}
	// Hash and wake gate come from the whole output; only the payload handed to the agent is cut. Past the collect
	// bound the text is the head plus the tail's whole lines (its first line is cut off at the tail's start).
	const newline = tail?.indexOf("\n") ?? -1;
	const lastLines = tail === undefined ? "" : newline === -1 ? undefined : tail.slice(newline + 1);
	const full = tail === undefined ? head.trim() : `${head.trimStart()}\n${(lastLines ?? tail).trimEnd()}`;
	return {
		fired: !timedOut && !aborted && code === 0,
		exitCode: code,
		timedOut,
		...(aborted ? { aborted } : {}),
		stdout: capPayload(full),
		stderr: tailOf(stderr.trim()),
		outputHash: hash.digest(),
		// A tail without a newline is the middle of one line longer than the tail: not the gate line.
		wakeOff: lastLines !== undefined && isWakeGateOff(full),
	};
}

/**
 * sha256 of the stream's `trim()`med text, fed chunk by chunk: leading whitespace is skipped, trailing whitespace is
 * held back until more text follows it (JS `trim` and `\s` strip the same characters).
 */
function trimmedHash(): { update(chunk: string): void; digest(): string } {
	const sha = createHash("sha256");
	let started = false;
	let pending = "";
	return {
		update(chunk) {
			const text = started ? chunk : chunk.replace(/^\s+/, "");
			if (text === "") return;
			started = true;
			const joined = pending + text;
			// A backward scan, not /\s+$/: that regex is quadratic on a long whitespace run followed by text.
			let end = joined.length;
			while (end > 0 && /\s/.test(joined[end - 1] as string)) end -= 1;
			pending = joined.slice(end);
			sha.update(joined.slice(0, end));
		},
		digest: () => sha.digest("hex"),
	};
}

/** Cuts `text` to its last `MAX_SCRIPT_STDERR_TAIL_CHARS` chars (the failure reason sits at the end of stderr). */
function tailOf(text: string): string {
	if (text.length <= MAX_SCRIPT_STDERR_TAIL_CHARS) return text;
	return text.slice(-MAX_SCRIPT_STDERR_TAIL_CHARS);
}

/** Cuts `text` to the payload cap but keeps its last non-empty line, so a trailing wake gate survives the cut. */
function capPayload(text: string): string {
	if (text.length <= MAX_SCRIPT_OUTPUT_CHARS) return text;
	const tail = text.slice(text.lastIndexOf("\n") + 1).trim();
	if (tail === "" || tail.length > MAX_SCRIPT_OUTPUT_CHARS / 2) return text.slice(0, MAX_SCRIPT_OUTPUT_CHARS);
	const keep = MAX_SCRIPT_OUTPUT_CHARS - tail.length - TRUNCATION_MARK.length;
	return `${text.slice(0, keep)}${TRUNCATION_MARK}${tail}`;
}

/**
 * Wake gate (hermes monitor mode): the script's last non-empty stdout line being exactly `{"wakeAgent": false}`
 * means "the check ran, stay quiet" — the agent turn and the delivery are both skipped.
 */
export function isWakeGateOff(stdout: string): boolean {
	const lines = stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	const last = lines[lines.length - 1];
	if (last === undefined) return false;
	try {
		return (JSON.parse(last) as { wakeAgent?: unknown } | null)?.wakeAgent === false;
	} catch {
		return false;
	}
}
