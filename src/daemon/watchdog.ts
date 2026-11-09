import { Worker } from "node:worker_threads";

/**
 * A main thread stuck this long (a synchronous call or a loop that never yields) gets the process killed. Far above
 * `sweep_stalled` (45 s, an alert): killing is for a daemon that will not come back by itself.
 */
export const WATCHDOG_STALL_MS = 120_000;

export interface WatchdogOptions {
	stallMs: number;
	/** How often the main thread beats (default 1 s). */
	beatMs?: number;
	/** `ompbot.log`: the `watchdog_kill` line is appended here as well as written to stderr (the journal). */
	logPath?: string;
}

/**
 * Starts the liveness watchdog: the main thread bumps a shared counter on a timer, a worker thread watches it and
 * SIGKILLs the process once it stops moving for `stallMs` (see `watchdog-worker.ts`). Neither the timer nor the
 * worker keeps the process alive. `stop()` ends both, so a stall after it is never fatal.
 */
export function startWatchdog(options: WatchdogOptions): { stop(): void } {
	const beats = new SharedArrayBuffer(4);
	const counter = new Int32Array(beats);
	const timer = setInterval(() => Atomics.add(counter, 0, 1), options.beatMs ?? 1_000);
	timer.unref();
	const worker = new Worker(new URL("./watchdog-worker.ts", import.meta.url), {
		workerData: { beats, stallMs: options.stallMs, logPath: options.logPath },
	});
	worker.unref();
	return {
		stop() {
			clearInterval(timer);
			void worker.terminate();
		},
	};
}

/** The stall limit for this process: the default, or `OMPBOT_WATCHDOG_STALL_MS` under `OMPBOT_TEST_HOOKS=1` only. */
export function watchdogStallMs(env: Record<string, string | undefined>): number {
	const override = env.OMPBOT_TEST_HOOKS === "1" ? Number(env.OMPBOT_WATCHDOG_STALL_MS) : Number.NaN;
	return Number.isFinite(override) && override > 0 ? override : WATCHDOG_STALL_MS;
}
