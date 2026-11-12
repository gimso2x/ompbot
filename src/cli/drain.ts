import { join } from "node:path";
import { parseArgs } from "node:util";
import { callDaemon } from "../daemon/ipc";
import type { DrainCounts } from "../daemon/status";

export const DRAIN_USAGE = `  drain [--wait [--timeout <min>]] | --cancel
                                 hold new turns/monitor fires for a restart (inbound stays pending); --wait exits 0 once
                                 no turn, host tool or approval is left, or cancels the drain and exits 1 at the
                                 timeout (default 60 min); --cancel ends the drain and dispatches what waited
`;

/** How often `drain --wait` re-reads the daemon's counts. */
const POLL_MS = 1_000;
const DEFAULT_TIMEOUT_MIN = 60;

type DrainResponse = { ok: true; draining: boolean } & DrainCounts;

function isDrainResponse(value: unknown): value is DrainResponse {
	return typeof value === "object" && value !== null && "ok" in value && value.ok === true && "draining" in value;
}

const countsText = (r: DrainCounts): string => `turns=${r.turns} hostTools=${r.hostTools} approvals=${r.approvals}`;

export interface DrainWaitOptions {
	/** One daemon drain op; throws when the daemon is unreachable or answers something unexpected. */
	call: (op: "drain" | "drain_status" | "drain_cancel") => Promise<DrainResponse>;
	timeoutMin: number;
	/**
	 * Cut limit (min): still busy by then, the wait ends `{ ok: true, cut: true }` with the drain kept on (the caller
	 * restarts anyway). Given, it replaces `timeoutMin`; absent, the timeout cancels the drain as before.
	 */
	cutAfterMin?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** Called once after the drain is requested, before the wait loop. */
	onStarted?: (counts: DrainCounts) => void;
}

export type DrainWaitResult =
	| { ok: true; cut?: true; counts: DrainCounts }
	| { ok: false; reason: "cancelled_elsewhere" | "timeout"; counts: DrainCounts }
	| { ok: false; reason: "unreachable"; error: string };

/** Starts a drain and waits until nothing is unfinished; on timeout the drain is cancelled. Shared by `drain --wait` and `apply`. */
export async function waitForDrain(options: DrainWaitOptions): Promise<DrainWaitResult> {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
	let accepted = false;
	try {
		const cut = options.cutAfterMin !== undefined;
		const deadline = now() + (options.cutAfterMin ?? options.timeoutMin) * 60_000;
		let state = await options.call("drain");
		accepted = true;
		options.onStarted?.(state);
		for (;;) {
			if (!state.draining) return { ok: false, reason: "cancelled_elsewhere", counts: state };
			if (state.turns === 0 && state.hostTools === 0 && state.approvals === 0) return { ok: true, counts: state };
			if (now() >= deadline) {
				if (cut) return { ok: true, cut: true, counts: state };
				await options.call("drain_cancel");
				return { ok: false, reason: "timeout", counts: state };
			}
			await sleep(Math.min(POLL_MS, Math.max(0, deadline - now())));
			state = await options.call("drain_status");
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// The daemon has no drain expiry: a drain it accepted must not outlive this wait, or new turns stay held.
		if (!accepted) return { ok: false, reason: "unreachable", error: message };
		let cancel: string;
		try {
			await options.call("drain_cancel");
			cancel = "drain cancelled";
		} catch (cancelError) {
			cancel = `drain cancel failed: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`;
		}
		return { ok: false, reason: "unreachable", error: `${message}; ${cancel}` };
	}
}

/** Typed daemon drain call over the unix socket. */
export function socketDrainCall(socketPath: string): DrainWaitOptions["call"] {
	return async (op) => {
		const response = await callDaemon(socketPath, { op }, 10_000);
		if (!isDrainResponse(response)) throw new Error(`unexpected response: ${JSON.stringify(response)}`);
		return response;
	};
}

/** `ompbot drain`; resolves with the exit code. */
export async function drainCommand(args: string[], homeDir: string): Promise<number> {
	const { values } = parseArgs({
		args,
		options: { wait: { type: "boolean" }, timeout: { type: "string" }, cancel: { type: "boolean" } },
	});
	// `Number("")` is 0: the value must look like a number, as `apply --timeout` requires.
	const timeoutMin =
		values.timeout === undefined
			? DEFAULT_TIMEOUT_MIN
			: /^\d+(\.\d+)?$/.test(values.timeout)
				? Number(values.timeout)
				: Number.NaN;
	if (!Number.isFinite(timeoutMin) || timeoutMin < 0) {
		process.stderr.write("drain: --timeout must be a non-negative number of minutes\n");
		return 2;
	}
	const socketPath = join(homeDir, "ompbot.sock");
	const call = socketDrainCall(socketPath);
	const unreachable = (error: unknown): number => {
		process.stderr.write(`drain: daemon not reachable (${error instanceof Error ? error.message : String(error)})\n`);
		return 1;
	};
	if (values.cancel === true || values.wait !== true) {
		try {
			if (values.cancel === true) {
				process.stdout.write(`drain cancelled ${countsText(await call("drain_cancel"))}\n`);
			} else {
				process.stdout.write(`drain started ${countsText(await call("drain"))}\n`);
			}
			return 0;
		} catch (error) {
			return unreachable(error);
		}
	}
	const result = await waitForDrain({
		call,
		timeoutMin,
		onStarted: (counts) => process.stdout.write(`drain started ${countsText(counts)}\n`),
	});
	if (result.ok) {
		process.stdout.write(`drain_done ${countsText(result.counts)}\n`);
		return 0;
	}
	if (result.reason === "unreachable") return unreachable(result.error);
	process.stderr.write(
		result.reason === "timeout"
			? `drain: timed out after ${timeoutMin} min, drain cancelled ${countsText(result.counts)}\n`
			: `drain: cancelled elsewhere ${countsText(result.counts)}\n`,
	);
	return 1;
}
