import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, timezoneOfHome } from "../config";
import { callDaemon, IpcNoResponse } from "../daemon/ipc";
import { exportFlow, writeFlowStatus } from "../flow/task-flow";
import { summarizeJudgement, taskChecksOf } from "../tasks/checker";
import { evaluateTask } from "../tasks/evaluate";
import { resolveTaskHost } from "../tasks/host";
import { openTaskLedger, type TaskRow, TaskTransitionError } from "../tasks/ledger";
import { CHECK_TIMEOUT_MS } from "../tasks/signals";

export const TASKS_USAGE = `  tasks list [--json]            [TASK] registry
  tasks show <id>                registry row, transition history and the current Outcome judgement
  tasks check <id>               judge now; the running daemon posts/reacts like its sweep does
  tasks close <id> --as done|cancelled   human-only completion (the bot can never do this); worktree and branch stay
  tasks pause <id>               owner pause: the sweep holds prompts, stale notice and auto-merge; the worker gets an Esc
  tasks resume <id>              lifts the pause (sweep hold only; the worker is not prompted)
  tasks flow --out <dir> [--watch <s>]   flow viewer html + status.json from a read-only database; --watch rewrites status.json
`;

function describe(row: TaskRow): string {
	const where = `${row.host ?? "local"}:${row.worktree}`;
	return `${row.taskId}  ${row.status.padEnd(9)}  ${row.risk}  ${row.title}  [${where} ${row.branch}]  agent=${row.agent}  AC=${row.acceptance.length}`;
}

function dispatchHostsOf(homeDir: string): Record<string, { ssh: string }> | undefined {
	try {
		return loadConfig(homeDir).dispatchHosts;
	} catch (error) {
		// Without the config a remote TASK resolves as local and fails later with a misleading read error.
		process.stderr.write(`tasks: config unreadable, dispatch hosts unknown: ${String(error)}\n`);
		return undefined;
	}
}

/** Whether the flow has the spec review node: `peerBots` or `channels.discord.peerBots` names at least one peer bot. */
function hasPeerReview(homeDir: string): boolean {
	if (!existsSync(join(homeDir, "config.json"))) return false;
	try {
		const config = loadConfig(homeDir, { checkTokens: false });
		return (config.peerBots?.length ?? 0) > 0 || (config.channels.discord?.peerBots?.length ?? 0) > 0;
	} catch (error) {
		process.stderr.write(`tasks flow: config unreadable, review node left out: ${String(error)}\n`);
		return false;
	}
}

/** The IPC wait of every request but `check`. */
const IPC_TIMEOUT_MS = 60_000;

/**
 * How long `tasks check` waits for the daemon: its check runs every `[check: …]` signal of the task one after another,
 * each bounded by `CHECK_TIMEOUT_MS`, plus the plain wait for the reads and posts around them.
 */
export function checkIpcTimeoutMs(row: TaskRow): number {
	return taskChecksOf(row.acceptance).length * CHECK_TIMEOUT_MS + IPC_TIMEOUT_MS;
}

/** Test seam of `tasksCommand`. */
export interface TasksCommandOptions {
	/** Overrides `checkIpcTimeoutMs` for `check`. */
	checkTimeoutMs?: number;
}

/**
 * Asks the running daemon to act on a task (post, react). `unreachable`: nothing listens, so nothing was done;
 * `no_response`: the request went out but no answer came in `timeoutMs`, so the daemon may still be acting on it.
 */
async function askDaemon(
	homeDir: string,
	request: Record<string, unknown>,
	timeoutMs = IPC_TIMEOUT_MS,
): Promise<Record<string, unknown> | "unreachable" | "no_response"> {
	try {
		const response = await callDaemon(join(homeDir, "ompbot.sock"), request, timeoutMs);
		return typeof response === "object" && response !== null ? (response as Record<string, unknown>) : "no_response";
	} catch (error) {
		return error instanceof IpcNoResponse ? "no_response" : "unreachable";
	}
}

/** `ompbot tasks ...` against the ledger file directly; Slack side effects go through the running daemon. */
export async function tasksCommand(
	args: string[],
	homeDir: string,
	options: TasksCommandOptions = {},
): Promise<number> {
	const [sub, ...rest] = args;
	if (
		sub !== "list" &&
		sub !== "show" &&
		sub !== "check" &&
		sub !== "close" &&
		sub !== "pause" &&
		sub !== "resume" &&
		sub !== "flow"
	) {
		process.stderr.write(`usage: ompbot tasks <list|show|check|close|pause|resume|flow>\n${TASKS_USAGE}`);
		return 2;
	}
	const { values, positionals } = parseArgs({
		args: rest,
		allowPositionals: true,
		options: { json: { type: "boolean" }, as: { type: "string" }, out: { type: "string" }, watch: { type: "string" } },
	});
	if (sub === "flow") {
		// Before the ledger: opening it migrates the schema, and the flow export must never write the database.
		// setInterval holds at most 2^31-1 ms; a longer period fires every 1 ms instead.
		const seconds = values.watch === undefined ? 0 : /^\d+(\.\d+)?$/.test(values.watch) ? Number(values.watch) : 0;
		if (values.out === undefined || (values.watch !== undefined && !(seconds >= 1 && seconds <= 2_147_483))) {
			process.stderr.write("tasks flow: --out <dir> required, --watch takes 1 to 2147483 seconds\n");
			return 2;
		}
		const dbPath = join(homeDir, "ompbot.db");
		const outDir = values.out;
		const review = hasPeerReview(homeDir);
		const timezone = timezoneOfHome(homeDir);
		exportFlow(dbPath, outDir, review, timezone);
		process.stdout.write(`${join(outDir, "viewer.html")}\n`);
		if (seconds === 0) return 0;
		// A home without ompbot.db exports an empty flow, but a database that was there and went away ends the watch.
		const hadDb = existsSync(dbPath);
		const { promise, resolve } = Promise.withResolvers<number>();
		const timer = setInterval(() => {
			try {
				if (hadDb && !existsSync(dbPath)) throw new Error(`database went away: ${dbPath}`);
				writeFlowStatus(dbPath, outDir, review);
			} catch (error) {
				// The same failure would repeat every period (a database that went away): report it once and stop.
				clearInterval(timer);
				const reason = error instanceof Error ? error.message : String(error);
				process.stderr.write(`tasks flow: status.json not rewritten: ${reason.split("\n")[0]}\n`);
				resolve(1);
			}
		}, seconds * 1000);
		return await promise;
	}
	const ledger = openTaskLedger(join(homeDir, "ompbot.db"), timezoneOfHome(homeDir));
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
			const closed = ledger.transition(row.taskId, values.as, "human", `close --as ${values.as}`);
			out({ closed: closed.taskId, status: closed.status, closedAt: closed.closedAt });
			const synced = await askDaemon(homeDir, { op: "tasks_sync", id: row.taskId });
			if (typeof synced === "string" || synced.ok !== true)
				process.stderr.write("tasks close: daemon not reachable — Slack reaction not updated\n");
			return 0;
		}
		if (sub === "pause" || sub === "resume") {
			const answered = await askDaemon(homeDir, {
				op: sub === "pause" ? "tasks_pause" : "tasks_resume",
				id: row.taskId,
			});
			if (typeof answered !== "string") {
				out(answered);
				return answered.ok === true ? 0 : 1;
			}
			// No daemon: the ledger mark alone holds the next sweep; the worker gets no Esc.
			const marked = sub === "pause" ? ledger.pauseTask(row.taskId) : ledger.unpauseTask(row.taskId);
			out({ ok: true, task: marked.taskId, paused: ledger.isPaused(marked) });
			if (sub === "pause")
				process.stderr.write("tasks pause: daemon not reachable — paused in the ledger, no Esc sent\n");
			return 0;
		}
		if (sub === "check" && (row.status === "working" || row.status === "blocked")) {
			const timeoutMs = options.checkTimeoutMs ?? checkIpcTimeoutMs(row);
			const checked = await askDaemon(homeDir, { op: "tasks_check", id: row.taskId }, timeoutMs);
			if (checked === "no_response") {
				// The daemon has the request and may still post: a local verdict here could contradict it.
				process.stderr.write(
					`tasks check: no daemon answer in ${Math.round(timeoutMs / 1000)}s — 응답 지연 — 게시 여부 모름 (posting unknown; not judged locally)\n`,
				);
				return 1;
			}
			if (checked !== "unreachable" && checked.ok === true) {
				out(checked);
				return 0;
			}
			process.stderr.write("tasks check: daemon not reachable — judging only, nothing posted\n");
		}
		const evaluation = await evaluateTask(row, resolveTaskHost(row.host, dispatchHostsOf(homeDir)));
		if (!evaluation.ok) {
			process.stderr.write(`tasks ${sub}: read failed: ${evaluation.error}\n`);
			out(sub === "show" ? { task: row, history: ledger.history(row.taskId) } : { task: row });
			return 1;
		}
		out({
			task: row,
			judgement: evaluation.judgement,
			summary: summarizeJudgement(evaluation.judgement, row.status),
			...(sub === "show" ? { history: ledger.history(row.taskId) } : {}),
		});
		return 0;
	} catch (error) {
		if (!(error instanceof TaskTransitionError)) throw error;
		process.stderr.write(`tasks ${sub}: ${error.message}\n`);
		return 1;
	} finally {
		ledger.close();
	}
}
