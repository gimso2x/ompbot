import { checkTask, type TaskCheck, type TaskCheckRequest, type TaskChecksRun, type TaskJudgement } from "./checker";
import { docsDirOf } from "./docs";
import type { TaskHostOps } from "./host";
import type { TaskRow } from "./ledger";
import { CHECK_TIMEOUT_MS, runSignal, type SignalCheck } from "./signals";

export type TaskEvaluation = { ok: true; judgement: TaskJudgement } | { ok: false; error: string };

/**
 * Check results per task at one HEAD, keyed by signal text (the sweeper's, in memory): the same commit is checked
 * once, a new HEAD replaces the entry, a restart runs the checks again.
 */
export type TaskCheckCache = Map<string, { head: string; results: Map<string, SignalCheck> }>;

const UNCOMMITTED = "미커밋 변경이 있어 check를 미룹니다";

/** Runs the checks at the worktree's HEAD, reusing what this HEAD already answered; uncommitted changes defer them. */
async function runTaskChecks(
	row: TaskRow,
	ops: TaskHostOps,
	cache: TaskCheckCache,
	requests: readonly TaskCheckRequest[],
): Promise<TaskChecksRun> {
	const head = await ops.headOf(row.worktree);
	if (!head.clean) return { deferred: UNCOMMITTED };
	let entry = cache.get(row.taskId);
	if (entry?.head !== head.sha) {
		entry = { head: head.sha, results: new Map() };
		cache.set(row.taskId, entry);
	}
	const io = {
		runCheck: (argv: string[]) => ops.runCheck({ worktree: row.worktree, argv, timeoutMs: CHECK_TIMEOUT_MS }),
		readFile: async (path: string) => {
			const read = await ops.readFile(`${row.worktree}/${path}`);
			if (!read.ok) throw new Error(`cannot read ${path}: ${read.error}`);
			return read.value;
		},
	};
	const results: TaskCheck[] = [];
	// One at a time: two test suites racing in one worktree would judge each other.
	for (const request of requests) {
		let result = entry.results.get(request.signal);
		if (result === undefined) {
			result = await runSignal(request.signal, io);
			entry.results.set(request.signal, result);
		}
		results.push({ id: request.id, signal: request.signal, ok: result.ok, detail: result.detail });
	}
	return { head: head.sha, results };
}

/**
 * Reads spec.md, PROGRESS.md and outcome.md from the task's host and judges them. Any read that cannot be answered
 * (host down, timeout) is a failed evaluation — never a verdict; a file that is simply absent is judged as absent.
 * `checks` (the sweep's cache) turns on the `[check: …]` runs; other readers (CLI, dashboard) judge the documents only.
 */
export async function evaluateTask(row: TaskRow, ops: TaskHostOps, checks?: TaskCheckCache): Promise<TaskEvaluation> {
	const dir = docsDirOf(row.worktree, row.taskId);
	try {
		const [spec, progress, outcome] = await Promise.all(
			["spec.md", "PROGRESS.md", "outcome.md"].map((name) => ops.readFile(`${dir}/${name}`)),
		);
		for (const read of [spec, progress, outcome]) {
			if (read === undefined || !read.ok) return { ok: false, error: read?.ok === false ? read.error : "read failed" };
		}
		const text = (read: typeof spec): string | undefined => (read?.ok ? read.value : undefined);
		const judgement = await checkTask({
			snapshot: row.acceptance,
			spec: text(spec),
			progress: text(progress),
			outcome: text(outcome),
			commitCheck: (hash) =>
				ops.commitOnTaskBranch({ worktree: row.worktree, branch: row.branch, taskId: row.taskId, hash }),
			...(checks === undefined ? {} : { runChecks: (requests) => runTaskChecks(row, ops, checks, requests) }),
		});
		return { ok: true, judgement };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
