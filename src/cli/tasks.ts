import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config";
import { callDaemon } from "../daemon/ipc";
import { summarizeJudgement } from "../tasks/checker";
import { evaluateTask } from "../tasks/evaluate";
import { resolveTaskHost } from "../tasks/host";
import { openTaskLedger, type TaskRow, TaskTransitionError } from "../tasks/ledger";

export const TASKS_USAGE = `  tasks list [--json]            [TASK] registry
  tasks show <id>                registry row and the current Outcome judgement
  tasks check <id>               judge now; the running daemon posts/reacts like its sweep does
  tasks close <id> --as done|cancelled   human-only completion (the bot can never do this); worktree and branch stay
`;

function describe(row: TaskRow): string {
	const where = `${row.host ?? "local"}:${row.worktree}`;
	return `${row.taskId}  ${row.status.padEnd(9)}  ${row.risk}  ${row.title}  [${where} ${row.branch}]  agent=${row.agent}  AC=${row.acceptance.length}`;
}

function dispatchHostsOf(homeDir: string): Record<string, { ssh: string }> | undefined {
	try {
		return loadConfig(homeDir).dispatchHosts;
	} catch {
		return undefined;
	}
}

/** Asks the running daemon to act on a task (post, react); `undefined` when no daemon answers. */
async function askDaemon(
	homeDir: string,
	request: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
	try {
		const response = await callDaemon(join(homeDir, "ompbot.sock"), request, 60_000);
		return typeof response === "object" && response !== null ? (response as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** `ompbot tasks ...` against the ledger file directly; Slack side effects go through the running daemon. */
export async function tasksCommand(args: string[], homeDir: string): Promise<number> {
	const [sub, ...rest] = args;
	if (sub !== "list" && sub !== "show" && sub !== "check" && sub !== "close") {
		process.stderr.write(`usage: ompbot tasks <list|show|check|close>\n${TASKS_USAGE}`);
		return 2;
	}
	const { values, positionals } = parseArgs({
		args: rest,
		allowPositionals: true,
		options: { json: { type: "boolean" }, as: { type: "string" } },
	});
	const ledger = openTaskLedger(join(homeDir, "ompbot.db"));
	try {
		const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
		if (sub === "list") {
			const rows = ledger.list();
			if (values.json === true) out({ tasks: rows });
			else if (rows.length === 0) process.stdout.write("no tasks\n");
			else for (const row of rows) process.stdout.write(`${describe(row)}\n`);
			return 0;
		}
		const taskId = positionals[0];
		const row = taskId === undefined ? undefined : ledger.get(taskId);
		if (row === undefined) {
			process.stderr.write(`tasks ${sub}: task not found: ${taskId ?? "(id required)"}\n`);
			return 1;
		}
		if (sub === "close") {
			if (values.as !== "done" && values.as !== "cancelled") {
				process.stderr.write("tasks close: --as done|cancelled required\n");
				return 2;
			}
			const closed = ledger.transition(row.taskId, values.as, "human");
			out({ closed: closed.taskId, status: closed.status, closedAt: closed.closedAt });
			const synced = await askDaemon(homeDir, { op: "tasks_sync", id: row.taskId });
			if (synced?.ok !== true) process.stderr.write("tasks close: daemon not reachable — Slack reaction not updated\n");
			return 0;
		}
		if (sub === "check" && (row.status === "working" || row.status === "blocked")) {
			const checked = await askDaemon(homeDir, { op: "tasks_check", id: row.taskId });
			if (checked?.ok === true) {
				out(checked);
				return 0;
			}
			process.stderr.write("tasks check: daemon not reachable — judging only, nothing posted\n");
		}
		const evaluation = await evaluateTask(row, resolveTaskHost(row.host, dispatchHostsOf(homeDir)));
		if (!evaluation.ok) {
			process.stderr.write(`tasks ${sub}: read failed: ${evaluation.error}\n`);
			out({ task: row });
			return 1;
		}
		out({ task: row, judgement: evaluation.judgement, summary: summarizeJudgement(evaluation.judgement, row.status) });
		return 0;
	} catch (error) {
		if (!(error instanceof TaskTransitionError)) throw error;
		process.stderr.write(`tasks ${sub}: ${error.message}\n`);
		return 1;
	} finally {
		ledger.close();
	}
}
