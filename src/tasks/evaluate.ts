import { checkTask, type TaskJudgement } from "./checker";
import { docsDirOf } from "./docs";
import type { TaskHostOps } from "./host";
import type { TaskRow } from "./ledger";

export type TaskEvaluation = { ok: true; judgement: TaskJudgement } | { ok: false; error: string };

/**
 * Reads spec.md, PROGRESS.md and outcome.md from the task's host and judges them. Any read that cannot be answered
 * (host down, timeout) is a failed evaluation — never a verdict; a file that is simply absent is judged as absent.
 */
export async function evaluateTask(row: TaskRow, ops: TaskHostOps): Promise<TaskEvaluation> {
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
		});
		return { ok: true, judgement };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
