import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
 * `<home>/unfrozen-at`: ISO instant of the last `clearFreeze`. FROZEN itself is gone by then, so this is how
 * `monitors_stalled` knows the monitors the freeze held back have only just been let go.
 */
export function unfrozenAtPath(homeDir: string): string {
	return join(homeDir, "unfrozen-at");
}

/** When the last freeze was lifted (ms epoch); `undefined` without a readable stamp. */
export function readUnfrozenAt(homeDir: string): number | undefined {
	try {
		const at = Date.parse(readFileSync(unfrozenAtPath(homeDir), "utf8").trim());
		return Number.isNaN(at) ? undefined : at;
	} catch {
		return undefined;
	}
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
	// Renaming over a FROZEN directory fails; removing it first would open an unfrozen window. Name the fix instead.
	if (lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true) {
		throw new Error(`${path}: FROZEN is not a regular file; run \`ompbot unfreeze\` first`);
	}
	const tmp = `${path}.tmp`;
	try {
		writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
		renameSync(tmp, path);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
	return state;
}

/**
 * Removes FROZEN (a directory too); true when a freeze was in place. Lifting one stamps `unfrozen-at` first, so no
 * reader sees neither; a removal that fails puts the previous stamp back, so a freeze still in place is never stamped lifted.
 */
export function clearFreeze(homeDir: string, now: number = Date.now()): boolean {
	const path = freezePath(homeDir);
	const was = lstatSync(path, { throwIfNoEntry: false }) !== undefined;
	if (!was) return false;
	const stampPath = unfrozenAtPath(homeDir);
	let previous: string | undefined;
	try {
		previous = readFileSync(stampPath, "utf8");
	} catch {
		previous = undefined;
	}
	writeFileSync(stampPath, `${new Date(now).toISOString()}\n`, { mode: 0o600 });
	try {
		rmSync(path, { recursive: true, force: true });
	} catch (error) {
		if (previous === undefined) rmSync(stampPath, { force: true });
		else writeFileSync(stampPath, previous, { mode: 0o600 });
		throw error;
	}
	return true;
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
