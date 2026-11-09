import { appendFileSync, writeSync } from "node:fs";
import { workerData } from "node:worker_threads";

/**
 * The watchdog's own thread: it reads the main thread's beat counter every second, and when the counter has not moved
 * for `stallMs` it logs `watchdog_kill` and SIGKILLs the whole process, so systemd (`Restart=on-failure`) starts a new
 * one. It runs while the main thread is stuck, which is the whole point: nothing here may wait on the main thread.
 */
const { beats, stallMs, logPath } = workerData as { beats: SharedArrayBuffer; stallMs: number; logPath?: string };
const counter = new Int32Array(beats);
let seen = Atomics.load(counter, 0);
let movedAt = Date.now();

setInterval(() => {
	const now = Date.now();
	const value = Atomics.load(counter, 0);
	if (value !== seen) {
		seen = value;
		movedAt = now;
		return;
	}
	if (now - movedAt < stallMs) return;
	const line = `${JSON.stringify({ ts: new Date(now).toISOString(), level: "error", event: "watchdog_kill", stalled_ms: now - movedAt, pid: process.pid })}\n`;
	try {
		writeSync(2, line);
	} catch {
		// stderr closed: the log file below is the record
	}
	if (logPath !== undefined) {
		try {
			appendFileSync(logPath, line, { mode: 0o600 });
		} catch {
			// the kill matters more than its record
		}
	}
	process.kill(process.pid, "SIGKILL");
}, 1_000);
