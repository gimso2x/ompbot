import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTaskJson, type TaskRow, type TaskTransitionRow } from "../tasks/ledger";

export type FlowTask = Pick<TaskRow, "taskId" | "status" | "createdAt" | "progressAt" | "notices">;
export type FlowTransition = Pick<TaskTransitionRow, "taskId" | "fromStatus" | "toStatus" | "actor" | "reason" | "at">;
export type FlowNodeStatus = "running" | "pass" | "fail" | "fixed";
/** One line of `status.json`: the viewer paints `status` and `msg` on `node` while `task` is the selected chip. */
export interface FlowStatus {
	task: string;
	node: string;
	status: FlowNodeStatus;
	msg: string;
	at: string;
}

const JUDGE = ["ac", "integrity", "signals", "outcome"];
const INTEGRITY_WORDS = ["diff", "무결성", "too large", "상한"];

/**
 * Node states of each task: notices and transitions merged in time order and replayed, so a node shows the value
 * the last event left (a block, its resume and the next block each count).
 */
export function taskFlowStatus(tasks: FlowTask[], transitions: FlowTransition[]): FlowStatus[] {
	return tasks.flatMap((task) => {
		const nodes = new Map<string, { status: FlowNodeStatus; msg: string; at: number }>();
		const set = (node: string, status: FlowNodeStatus, msg: string, at: number) => nodes.set(node, { status, msg, at });
		const fixFailed = (at: number, msg?: string) => {
			for (const [node, s] of nodes) if (s.status === "fail") set(node, "fixed", msg ?? s.msg, at);
		};
		const reach = (at: number) => {
			for (const node of JUDGE) set(node, "pass", "", at);
			for (const node of ["build", "progress"]) if (!nodes.has(node)) set(node, "pass", "", at);
			if (nodes.get("ownerReview")?.status === "fail") set("ownerReview", "fixed", "리뷰 반려", at);
		};
		for (const node of ["spec", "review", "dispatch"]) set(node, "pass", "등록 전 단계 · 기록 없음", task.createdAt);
		for (const node of ["register", "worktree", "agent"]) set(node, "pass", "", task.createdAt);
		if (task.progressAt !== null) set("progress", "pass", "", task.progressAt);

		const events = [
			...transitions.filter((t) => t.taskId === task.taskId).map((move) => ({ at: move.at, move, key: "" })),
			...Object.entries(task.notices).map(([key, at]) => ({ at, move: undefined, key })),
		].sort((a, b) => a.at - b.at);
		for (const { at, move, key } of events) {
			if (move === undefined) {
				const kind = key.slice(0, key.indexOf(":"));
				if (kind === "unmet") set("ac", "fail", "수락기준 미충족", at);
				else if (kind === "lost") set("agent", "fail", "에이전트 없음", at);
				else if (kind === "resume") fixFailed(at);
				else if (kind === "reached") reach(at);
				else if (kind === "stale2h") set("progress", nodes.get("progress")?.status ?? "running", "2시간 무갱신", at);
				else if (kind === "blocked") {
					// `blocked:<n>:<reason>`; notices written before the counter existed are `blocked:<reason>`.
					const reason = key.slice(8).replace(/^\d+:/, "");
					const integrity = INTEGRITY_WORDS.some((word) => reason.includes(word));
					set(integrity ? "integrity" : "build", "fail", reason.slice(0, 120), at);
				}
				continue;
			}
			const { fromStatus: from, toStatus: to, reason } = move;
			if (from === "blocked" && to === "working") fixFailed(at);
			else if (from === "working" && to === "review") reach(at);
			else if (from === "review" && to === "working") set("ownerReview", "fail", "리뷰 반려", at);
			else if (to === "cancelled") set("land", "fail", "취소", at);
			else if (to === "done") {
				if (from !== "review") {
					fixFailed(at, `오너 종료 · ${reason ?? ""}`);
					for (const node of JUDGE) if (!nodes.has(node)) set(node, "fixed", "오너 종료 · 판정 생략", at);
				}
				for (const node of ["ownerReview", "land"]) set(node, "pass", reason ?? "", at);
			}
		}
		if (task.status === "working" && !JUDGE.some((node) => nodes.has(node))) {
			set("build", "running", "", Math.max(task.createdAt, task.progressAt ?? 0));
		}
		return [...nodes].map(([node, s]) => ({
			task: task.taskId,
			node,
			status: s.status,
			msg: s.msg,
			at: new Date(s.at).toISOString(),
		}));
	});
}

const VIEWER = new URL("./viewer.html", import.meta.url);
const jsonBlock = (id: string) => new RegExp(`(<script type="application/json" id="${id}">)([\\s\\S]*?)(</script>)`);
/** JSON safe inside a `<script>` element: `<` never starts a closing tag. */
const embed = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

/** Tasks and transitions from a read-only handle; the database file is never written. */
function readFlow(dbPath: string): { tasks: (FlowTask & { updatedAt: number })[]; transitions: FlowTransition[] } {
	const db = new Database(dbPath, { readonly: true, strict: true });
	try {
		const rows = db
			.query("SELECT task_id, status, created_at, updated_at, progress_at, notices_json FROM tasks ORDER BY task_id")
			.all() as {
			task_id: string;
			status: TaskRow["status"];
			created_at: number;
			updated_at: number;
			progress_at: number | null;
			notices_json: string;
		}[];
		const transitions = db
			.query(
				`SELECT task_id AS taskId, from_status AS fromStatus, to_status AS toStatus, actor, reason, at
				FROM task_transitions ORDER BY transition_id`,
			)
			.all() as FlowTransition[];
		const tasks = rows.map((r) => ({
			taskId: r.task_id,
			status: r.status,
			createdAt: r.created_at,
			updatedAt: r.updated_at,
			progressAt: r.progress_at,
			notices: parseTaskJson("[]", r.notices_json).notices,
		}));
		return { tasks, transitions };
	} finally {
		db.close();
	}
}

/** Writes `status.json` through a temporary file, so a polling viewer never reads half of it. */
export function writeFlowStatus(dbPath: string, outDir: string): FlowStatus[] {
	const { tasks, transitions } = readFlow(dbPath);
	const status = taskFlowStatus(tasks, transitions);
	const target = join(outDir, "status.json");
	writeFileSync(`${target}.tmp`, JSON.stringify(status));
	renameSync(`${target}.tmp`, target);
	return status;
}

/** `viewer.html` with the default graph, this package's version and the database snapshot, plus `status.json`. */
export function exportFlow(dbPath: string, outDir: string, now = Date.now()): void {
	mkdirSync(outDir, { recursive: true });
	const { tasks } = readFlow(dbPath);
	const status = writeFlowStatus(dbPath, outDir);
	const html = readFileSync(VIEWER, "utf8");
	const graph = JSON.parse(jsonBlock("flow-default").exec(html)?.[2] ?? "{}");
	const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
	const kst = new Date(now + 9 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
	Object.assign(graph, {
		version,
		memo: `ompbot.db 스냅샷 ${kst} KST`,
		items: tasks.map((t) => ({ id: t.taskId, status: t.status, at: new Date(t.updatedAt).toISOString() })),
	});
	const filled = html
		.replace(jsonBlock("flow-data"), (_, open, _old, close) => open + embed(graph) + close)
		.replace(jsonBlock("flow-status"), (_, open, _old, close) => open + embed(status) + close);
	writeFileSync(join(outDir, "viewer.html"), filled);
}
