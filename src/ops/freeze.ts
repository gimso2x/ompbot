import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** `<home>/FROZEN`: while it exists the bot takes no autonomous action; owner conversation turns stay allowed. */
export interface FreezeState {
	/** ISO instant the freeze was set. */
	since: string;
	reason: string;
	/** Who set it: `cli` for `ompbot freeze`. */
	by: string;
}

/** A frozen daemon re-reads the file at most this often, so a CLI freeze lands within a few seconds. */
export const FREEZE_CACHE_MS = 2_000;

const MAX_REASON_CHARS = 200;

export function freezePath(homeDir: string): string {
	return join(homeDir, "FROZEN");
}

/**
 * The freeze state of a home; `undefined` when not frozen. A FROZEN file that cannot be parsed still means frozen
 * (fail closed): the file's mere presence is the switch, its content only explains it.
 */
export function readFreeze(homeDir: string): FreezeState | undefined {
	const path = freezePath(homeDir);
	if (!existsSync(path)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<FreezeState>;
		return {
			since: typeof raw.since === "string" ? raw.since : "unknown",
			reason: typeof raw.reason === "string" ? raw.reason : "",
			by: typeof raw.by === "string" ? raw.by : "unknown",
		};
	} catch {
		return { since: "unknown", reason: "FROZEN unreadable", by: "unknown" };
	}
}

/** Writes FROZEN (0600, atomic). An existing freeze keeps its original `since`; the reason is replaced. */
export function writeFreeze(homeDir: string, input: { reason?: string; by: string; now: number }): FreezeState {
	const existing = readFreeze(homeDir);
	const state: FreezeState = {
		since: existing !== undefined && existing.since !== "unknown" ? existing.since : new Date(input.now).toISOString(),
		reason: (input.reason ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_REASON_CHARS),
		by: input.by,
	};
	const path = freezePath(homeDir);
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
	return state;
}

/** Removes FROZEN; true when a freeze was in place. */
export function clearFreeze(homeDir: string): boolean {
	const was = existsSync(freezePath(homeDir));
	rmSync(freezePath(homeDir), { force: true });
	return was;
}

/** Cached `readFreeze` for hot paths (a monitor tick, every dispatch call); refreshes after `FREEZE_CACHE_MS`. */
export function createFreezeProbe(
	homeDir: string,
	now: () => number = Date.now,
	cacheMs: number = FREEZE_CACHE_MS,
): () => FreezeState | undefined {
	let checkedAt = Number.NEGATIVE_INFINITY;
	let state: FreezeState | undefined;
	return () => {
		const at = now();
		if (at - checkedAt >= cacheMs || at < checkedAt) {
			state = readFreeze(homeDir);
			checkedAt = at;
		}
		return state;
	};
}

export function frozenMessage(state: FreezeState): string {
	return `동결 중입니다(${state.since}${state.reason === "" ? "" : `, 사유: ${state.reason}`}). 원격 위임·모니터·작업 레인은 멈춰 있고, 오너가 \`ompbot unfreeze\`로 풀어야 합니다.`;
}
