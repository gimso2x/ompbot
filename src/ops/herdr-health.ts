import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessRunner } from "../dispatch/omp";
import { TASK_SWEEP_MS } from "../tasks/sweeper";
import { parseStampFields, parseStampTs, writeAtomic0600 } from "./stamp";

/** `<home>/herdr-health`: the daemon's last local `herdr status server` result, read by the `herdr_unreachable` gate. */
export const HERDR_HEALTH_FILE = "herdr-health";
/** Consecutive failed checks before `herdr_unreachable` opens (15 minutes at the 5-minute task sweep). */
export const HERDR_UNREACHABLE_AFTER = 3;
/** `herdr status server` gets this long before the check counts as failed. */
export const HERDR_HEALTH_TIMEOUT_MS = 10_000;
/** A stamp older than three task sweeps judges nothing: the daemon stopped checking (a dead daemon is sweep_stalled's). */
export const HERDR_HEALTH_STALE_MS = 3 * TASK_SWEEP_MS;

export interface HerdrHealthStamp {
	ts: Date;
	ok: boolean;
	/** Consecutive failed checks up to this one (0 after a success). */
	fails: number;
	/** First failure of the current streak (ISO), `-` without one. */
	since: string;
	error?: string;
}

/** The stamp, or `undefined` when no daemon with herdr on has written one (or it is unreadable). */
export function readHerdrHealth(homeDir: string): HerdrHealthStamp | undefined {
	const path = join(homeDir, HERDR_HEALTH_FILE);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	const fields = parseStampFields(text);
	const ts = parseStampTs(fields, path);
	if (ts === undefined) return undefined;
	const fails = Number(fields.get("fails"));
	const error = fields.get("error");
	return {
		ts,
		ok: fields.get("ok") === "1",
		fails: Number.isSafeInteger(fails) && fails >= 0 ? fails : 0,
		since: fields.get("since") ?? "-",
		...(error === undefined ? {} : { error }),
	};
}

/**
 * The daemon's local herdr probe: `<bin> status server` must exit 0 with a `status: running` line. Each check writes
 * the stamp; the failure streak lives in memory and continues from the stamp after a restart.
 */
export class HerdrHealthProbe {
	readonly #options: { homeDir: string; bin: string; run: ProcessRunner; now(): number };
	#streak: { fails: number; since: string } | undefined;

	constructor(options: { homeDir: string; bin: string; run: ProcessRunner; now(): number }) {
		this.#options = options;
	}

	async check(): Promise<HerdrHealthStamp> {
		const { homeDir, bin, run, now } = this.#options;
		if (this.#streak === undefined) {
			const previous = readHerdrHealth(homeDir);
			this.#streak =
				previous === undefined || previous.ok
					? { fails: 0, since: "-" }
					: { fails: previous.fails, since: previous.since };
		}
		const result = await run([bin, "status", "server"], { timeoutMs: HERDR_HEALTH_TIMEOUT_MS });
		const running = result.code === 0 && !result.timedOut && /^status:\s*running\s*$/m.test(result.stdout);
		const ts = new Date(now());
		let error: string | undefined;
		if (running) {
			this.#streak = { fails: 0, since: "-" };
		} else {
			const firstLine = (text: string | undefined) => text?.trim().split("\n")[0]?.trim() ?? "";
			const reason = result.timedOut
				? "timed out"
				: firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.code}`;
			error = reason.replace(/\s+/g, "_").slice(0, 160);
			this.#streak = {
				fails: this.#streak.fails + 1,
				since: this.#streak.fails === 0 ? ts.toISOString() : this.#streak.since,
			};
		}
		const { fails, since } = this.#streak;
		writeAtomic0600(
			join(homeDir, HERDR_HEALTH_FILE),
			`ts=${ts.toISOString()} ok=${running ? 1 : 0} fails=${fails} since=${since}${error === undefined ? "" : ` error=${error}`}\n`,
		);
		return { ts, ok: running, fails, since, ...(error === undefined ? {} : { error }) };
	}
}
