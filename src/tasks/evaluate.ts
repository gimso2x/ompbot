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

/**
 * Runs the checks at `worktree`'s HEAD; uncommitted changes defer them. `resultsAt(head)` hands back the signal
 * results already known at that HEAD (filled in place as signals run, except inconclusive ones), so the same commit is
 * never checked twice — a timed-out signal is run again.
 * Shared by the task sweep and the work lanes; host failures throw. An aborted `signal` kills the running check and
 * throws before the next one (what ran is then no verdict).
 */
export async function runWorktreeChecks(
	ops: TaskHostOps,
	worktree: string,
	resultsAt: (head: string) => Map<string, SignalCheck>,
	requests: readonly TaskCheckRequest[],
	signal?: AbortSignal,
): Promise<TaskChecksRun> {
	const head = await ops.headOf(worktree);
	if (!head.clean) return { deferred: UNCOMMITTED };
	const known = resultsAt(head.sha);
	const io = {
		runCheck: (argv: string[]) =>
			ops.runCheck({ worktree, argv, timeoutMs: CHECK_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) }),
		readBytes: async (path: string) => {
			const read = await ops.readBytes(`${worktree}/${path}`);
			if (!read.ok) throw new Error(`cannot read ${path}: ${read.error}`);
			return read.value;
		},
	};
	const results: TaskCheck[] = [];
	// One at a time: two test suites racing in one worktree would judge each other.
	for (const request of requests) {
		let result = known.get(request.signal);
		if (result === undefined) {
			signal?.throwIfAborted();
			result = await runSignal(request.signal, io);
			// A killed check is no verdict: it must not reach the known results.
			signal?.throwIfAborted();
			// A timed-out run proves nothing either way: the next judgement runs it again.
			if (!result.inconclusive) known.set(request.signal, result);
		}
		results.push({
			id: request.id,
			signal: request.signal,
			ok: result.ok,
			detail: result.detail,
			...(result.inconclusive ? { inconclusive: true as const } : {}),
		});
	}
	return { head: head.sha, results };
}

/** The task's checks through the sweep's cache: a new HEAD replaces the task's entry. */
function runTaskChecks(
	row: TaskRow,
	ops: TaskHostOps,
	cache: TaskCheckCache,
	requests: readonly TaskCheckRequest[],
): Promise<TaskChecksRun> {
	return runWorktreeChecks(
		ops,
		row.worktree,
		(head) => {
			let entry = cache.get(row.taskId);
			if (entry?.head !== head) {
				entry = { head, results: new Map() };
				cache.set(row.taskId, entry);
			}
			return entry.results;
		},
		requests,
	);
}

/** The task branch's diff for the integrity classifier; a failed read defers the classification, never passes it. */
async function readBranchDiff(row: TaskRow, ops: TaskHostOps): Promise<{ diff: string } | { error: string }> {
	const read = await ops.branchDiff({ worktree: row.worktree, branch: row.branch, taskId: row.taskId });
	return read.ok ? { diff: read.value } : { error: read.error };
}

/**
 * Reads spec.md, PROGRESS.md and outcome.md from the task's host and judges them. Any read that cannot be answered
 * (host down, timeout) is a failed evaluation — never a verdict; a file that is simply absent is judged as absent.
 * `checks` (the sweep's cache) turns on the `[check: …]` runs and the branch-diff integrity read; other readers (CLI,
 * dashboard) judge the documents only.
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
			...(checks === undefined
				? {}
				: {
						runChecks: (requests) => runTaskChecks(row, ops, checks, requests),
						integrity: () => readBranchDiff(row, ops),
					}),
		});
		return { ok: true, judgement };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
