import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTaskJson, type TaskRow, type TaskTransitionRow } from "../tasks/ledger";
import { formatLocal } from "../time";

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
 * the last event left (a block, its resume and the next block each count). `review`: the install has peer bots
 * (config `peerBots`) that cross-review specs; without them the review node is not part of the flow.
 */
export function taskFlowStatus(tasks: FlowTask[], transitions: FlowTransition[], review: boolean): FlowStatus[] {
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
		for (const node of review ? ["spec", "review", "dispatch"] : ["spec", "dispatch"]) {
			set(node, "pass", "등록 전 단계 · 기록 없음", task.createdAt);
		}
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

/** Short node names of the `task-flow-viewer.md` flow graph, in flow order. */
const NODE_NAMES: Record<string, string> = {
	spec: "스펙",
	review: "검토",
	dispatch: "위임",
	register: "등록",
	worktree: "워크트리",
	agent: "워커 기동",
	build: "구현",
	progress: "진행 기록",
	ac: "수락기준",
	integrity: "무결성",
	signals: "check 재실행",
	outcome: "Outcome",
	ownerReview: "오너 리뷰",
	land: "머지·반영",
};
const NODE_ORDER = Object.keys(NODE_NAMES);

export type TaskStageTone = "run" | "fail" | "wait" | "done" | "off";
export interface TaskStage {
	label: string;
	msg: string;
	tone: TaskStageTone;
}

/**
 * Where a task is now, from its {@link taskFlowStatus} lines (`statuses` may hold other tasks' lines): closed states
 * first, then its earliest unresolved failure in flow order, then review, else the running node.
 */
export function taskStage(
	task: Pick<TaskRow, "taskId" | "status" | "progressAt" | "closedAt">,
	statuses: FlowStatus[],
	timezone: string,
): TaskStage {
	/** `MM-DD HH:mm` in the bot's zone (`config.timezone`). */
	const short = (ms: number): string => formatLocal(ms, timezone).slice(5, 16);
	if (task.status === "cancelled") return { label: "취소", msg: "", tone: "off" };
	if (task.status === "done") {
		return { label: "완료", msg: task.closedAt === null ? "" : `close ${short(task.closedAt)}`, tone: "done" };
	}
	const mine = statuses.filter((line) => line.task === task.taskId);
	const fail = mine
		.filter((line) => line.status === "fail")
		.sort((a, b) => NODE_ORDER.indexOf(a.node) - NODE_ORDER.indexOf(b.node))[0];
	if (fail !== undefined)
		return { label: `${NODE_NAMES[fail.node] ?? fail.node}에서 막힘`, msg: fail.msg, tone: "fail" };
	if (task.status === "review") return { label: "오너 리뷰 차례", msg: "Outcome 도달 · 머지 대기", tone: "wait" };
	const running = mine.find((line) => line.status === "running");
	return {
		label: running === undefined ? "진행 중" : `${NODE_NAMES[running.node] ?? running.node} 중`,
		msg: task.progressAt === null ? "" : `진행 기록 ${short(task.progressAt)}`,
		tone: "run",
	};
}

const VIEWER = new URL("./viewer.html", import.meta.url);
const jsonBlock = (id: string) => new RegExp(`(<script type="application/json" id="${id}">)([\\s\\S]*?)(</script>)`);
/** JSON safe inside a `<script>` element: `<` never starts a closing tag. */
const embed = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

/**
 * Tasks and transitions from a read-only handle; the database file is never written. A home without a ledger has no
 * tasks (like `ompbot feedback`).
 */
function readFlow(dbPath: string): { tasks: (FlowTask & { updatedAt: number })[]; transitions: FlowTransition[] } {
	if (!existsSync(dbPath)) return { tasks: [], transitions: [] };
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

/**
 * Writes `target` through a new temporary file (`wx`: a link planted at the temporary name is removed, never followed)
 * renamed over it, so a polling viewer never reads half of it and a link at `target` is replaced, not written through.
 */
function writeReplacing(target: string, text: string): void {
	const tmp = `${target}.tmp`;
	rmSync(tmp, { force: true });
	writeFileSync(tmp, text, { flag: "wx" });
	renameSync(tmp, target);
}

/** Writes `status.json` (see `writeReplacing`). */
export function writeFlowStatus(dbPath: string, outDir: string, review: boolean): FlowStatus[] {
	const { tasks, transitions } = readFlow(dbPath);
	const status = taskFlowStatus(tasks, transitions, review);
	writeReplacing(join(outDir, "status.json"), JSON.stringify(status));
	return status;
}

interface FlowEdge {
	from: string;
	to: string;
}

/** The default graph without the review node: its incoming edges are joined to its outgoing ones. */
function withoutReview(graph: { nodes: { id: string }[]; edges: FlowEdge[] }): void {
	const into = graph.edges.filter((e) => e.to === "review").map((e) => e.from);
	const out = graph.edges.filter((e) => e.from === "review").map((e) => e.to);
	graph.nodes = graph.nodes.filter((n) => n.id !== "review");
	graph.edges = [
		...graph.edges.filter((e) => e.from !== "review" && e.to !== "review"),
		...into.flatMap((from) => out.map((to) => ({ from, to }))),
	];
}

/**
 * `viewer.html` with the default graph, this package's version and the database snapshot, plus `status.json`.
 * `review`: see {@link taskFlowStatus}; false drops the review node from the graph too. `timezone` names the snapshot time.
 */
export function exportFlow(dbPath: string, outDir: string, review: boolean, timezone: string, now = Date.now()): void {
	mkdirSync(outDir, { recursive: true });
	const { tasks } = readFlow(dbPath);
	const status = writeFlowStatus(dbPath, outDir, review);
	const html = readFileSync(VIEWER, "utf8");
	const graph = JSON.parse(jsonBlock("flow-default").exec(html)?.[2] ?? "{}");
	if (!review) withoutReview(graph);
	const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

	Object.assign(graph, {
		version,
		memo: `ompbot.db 스냅샷 ${formatLocal(now, timezone).slice(0, 16)} ${timezone}`,
		items: tasks.map((t) => ({ id: t.taskId, status: t.status, at: new Date(t.updatedAt).toISOString() })),
	});
	const filled = html
		.replace(jsonBlock("flow-data"), (_, open, _old, close) => open + embed(graph) + close)
		.replace(jsonBlock("flow-status"), (_, open, _old, close) => open + embed(status) + close);
	writeReplacing(join(outDir, "viewer.html"), filled);
}
