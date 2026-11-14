import { closeSync, openSync, readSync, statSync } from "node:fs";
import { isRecord } from "../omp/type-guards";
import type { GitRunner } from "./verify";

/**
 * Helpers of the terminal hand-over of a lane (`ompbot lanes attach`, doc/plans/lane-attach.md 2단계): what the
 * terminal omp did to the session file and the worktree, read once at the hand-back for the thread's summary.
 */

/** The size of `file` now; 0 when it does not exist (yet). */
export function fileSize(file: string): number {
	try {
		return statSync(file).size;
	} catch {
		return 0;
	}
}

/** What the terminal appended to the session file: owner prompts (turns) and the assistant messages' cost. */
export interface SessionDelta {
	turns: number;
	costUsd: number;
}

/** Reads `file` from byte `from` (the size at the hand-over) and counts the user turns and the cost written since. */
export function sessionDelta(file: string, from: number): SessionDelta {
	const size = fileSize(file);
	if (size <= from) return { turns: 0, costUsd: 0 };
	const buffer = Buffer.alloc(size - from);
	const fd = openSync(file, "r");
	try {
		readSync(fd, buffer, 0, buffer.length, from);
	} finally {
		closeSync(fd);
	}
	let turns = 0;
	let costUsd = 0;
	for (const line of buffer.toString("utf8").split("\n")) {
		if (line.trim() === "") continue;
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			continue; // a partial last line (still being written) carries nothing countable yet
		}
		if (!isRecord(record) || record.type !== "message" || !isRecord(record.message)) continue;
		const { role, usage } = record.message;
		if (role === "user") turns += 1;
		if (role === "assistant" && isRecord(usage) && isRecord(usage.cost) && typeof usage.cost.total === "number") {
			costUsd += usage.cost.total;
		}
	}
	return { turns, costUsd };
}

/** The worktree HEAD, or undefined when git cannot say (not a repository, git missing). */
export async function headOf(git: GitRunner, cwd: string): Promise<string | undefined> {
	const result = await git(["-C", cwd, "rev-parse", "HEAD"]).catch(() => undefined);
	return result?.code === 0 ? result.stdout.trim() : undefined;
}

/**
 * Files that differ from `head` (committed or not) plus untracked ones; without `head`, the uncommitted ones only.
 * Undefined when git cannot say.
 */
export async function changedFilesSince(
	git: GitRunner,
	cwd: string,
	head: string | undefined,
): Promise<number | undefined> {
	const diff = await git(["-C", cwd, "diff", "--name-only", ...(head === undefined ? [] : [head])]).catch(
		() => undefined,
	);
	const untracked = await git(["-C", cwd, "ls-files", "--others", "--exclude-standard"]).catch(() => undefined);
	if (diff?.code !== 0 || untracked?.code !== 0) return undefined;
	const files = new Set(
		`${diff.stdout}\n${untracked.stdout}`
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== ""),
	);
	return files.size;
}
