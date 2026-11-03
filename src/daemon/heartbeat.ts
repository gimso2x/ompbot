import { readFileSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseStampFields, parseStampTs, writeAtomic0600 } from "../ops/stamp";

/** The histogram type `monitorEventLoopDelay` returns (derived: bun-types does not export `IntervalHistogram`). */
type LoopHistogram = ReturnType<typeof monitorEventLoopDelay>;

/** Sweep cadence of the daemon's periodic work (lanes tick, monitors, gates, approvals, media). */
export const DEFAULT_SWEEP_MS = 15_000;
/** Stamp file at `<home>/sweep-heartbeat`, updated at the end of every sweep. */
export const SWEEP_HEARTBEAT_FILE = "sweep-heartbeat";
/** A max event-loop delay past this warns `event_loop_blocked`: the one loop every mailbox depends on was stuck. */
export const EVENT_LOOP_WARN_MS = 5_000;
/** Sampling resolution of the loop-delay histogram, milliseconds. */
const LOOP_RESOLUTION_MS = 20;

export interface SweepHeartbeat {
	/** Parsed from the stamp's `ts=` field; falls back to the file mtime. */
	ts: Date;
	/** Max observed event-loop delay since the previous sweep, milliseconds (`loop_ms=` in the stamp). */
	loopMs: number | undefined;
	/** Slack socket state (`socket=` + `socket_since=`); absent when the transport reports none or an old daemon wrote the stamp. */
	socket?: { state: "up" | "down"; since: Date } | undefined;
	/** `draining=0|1`; absent when an older daemon (before this field) wrote the stamp. */
	draining?: boolean | undefined;
}

/** What one beat records besides the loop delay. */
export interface BeatState {
	socket?: { state: "up" | "down"; since: number } | undefined;
	draining: boolean;
}

/** Reads the sweep heartbeat stamp; `undefined` when it does not exist or is unreadable. */
export function readSweepHeartbeat(homeDir: string): SweepHeartbeat | undefined {
	const path = join(homeDir, SWEEP_HEARTBEAT_FILE);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	const fields = parseStampFields(text);
	const ts = parseStampTs(fields, path);
	if (ts === undefined) return undefined;
	const loopMs = fields.get("loop_ms");
	const result: SweepHeartbeat = {
		ts,
		loopMs: loopMs !== undefined && /^\d+$/.test(loopMs) ? Number(loopMs) : undefined,
	};
	const socketState = fields.get("socket");
	const socketSince = fields.get("socket_since");
	if ((socketState === "up" || socketState === "down") && socketSince !== undefined) {
		const since = new Date(socketSince);
		if (!Number.isNaN(since.getTime())) result.socket = { state: socketState, since };
	}
	const draining = fields.get("draining");
	if (draining === "0" || draining === "1") result.draining = draining === "1";
	return result;
}

/** Atomic 0600 write (temp + fsync + rename), the shared discipline in `ops/stamp.ts` (backup stamp included). */
function writeHeartbeatAtomic(path: string, content: string): void {
	writeAtomic0600(path, content);
}

/**
 * Owns the event-loop delay histogram and the heartbeat stamp of one daemon. Every origin's mailbox runs on one Bun
 * event loop, so a blocked loop freezes everything at once — including the very `setInterval` that would notice. The
 * stamp is the proof of life after the fact: its age opens the `sweep_stalled` gate even when the loop never got a
 * chance to say anything while it was stuck, and the recorded `loop_ms` leaves a trace of how bad it was.
 */
export class SweepHeartbeatWriter {
	readonly #homeDir: string;
	readonly #histogram: LoopHistogram;

	constructor(homeDir: string) {
		this.#homeDir = homeDir;
		this.#histogram = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
		this.#histogram.enable();
	}

	/** Records a finished sweep: stamps the file with the max loop delay since the last beat, then resets. */
	beat(now: number, state: BeatState = { draining: false }): number {
		const loopMs = Math.round(this.#histogram.max / 1e6);
		this.#histogram.reset();
		const socket =
			state.socket === undefined
				? ""
				: ` socket=${state.socket.state} socket_since=${new Date(state.socket.since).toISOString()}`;
		writeHeartbeatAtomic(
			join(this.#homeDir, SWEEP_HEARTBEAT_FILE),
			`ts=${new Date(now).toISOString()} loop_ms=${loopMs}${socket} draining=${state.draining ? 1 : 0}\n`,
		);
		return loopMs;
	}

	stop(): void {
		this.#histogram.disable();
	}
}
