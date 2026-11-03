import { Database } from "bun:sqlite";
import {
	type AcceptanceItem,
	agentNameOf,
	branchOf,
	formatTaskId,
	kstDay,
	type TaskRisk,
	worktreePathOf,
} from "./docs";

export const TASK_STATUSES = ["working", "blocked", "review", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskActor = "bot" | "human";

/** Statuses only a human `close` can reach; a closed task never moves again. */
const HUMAN_ONLY: readonly TaskStatus[] = ["done", "cancelled"];
/** What the bot paths (tool, sweep) may do: working ⇄ blocked, working → review, review → working (resume). */
const BOT_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
	working: ["blocked", "review"],
	blocked: ["working"],
	review: ["working"],
	done: [],
	cancelled: [],
};

export class TaskTransitionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TaskTransitionError";
	}
}

export interface TaskClock {
	now(): number;
}

export interface TaskRow {
	taskId: string;
	title: string;
	risk: TaskRisk;
	originKey: string;
	threadRef: string;
	/** `dispatchHosts` key; null = the bot's own machine. */
	host: string | null;
	repo: string;
	worktree: string;
	branch: string;
	agent: string;
	status: TaskStatus;
	/** Acceptance criteria exactly as registered. */
	acceptance: AcceptanceItem[];
	createdAt: number;
	updatedAt: number;
	/** PROGRESS.md `updated` as last seen by the sweep (epoch ms). */
	progressAt: number | null;
	remindedAt: number | null;
	/** Notices already posted: key → when. */
	notices: Record<string, number>;
	closedAt: number | null;
}

export interface NewTask {
	title: string;
	risk: TaskRisk;
	originKey: string;
	threadRef: string;
	host: string | null;
	repo: string;
	acceptance: AcceptanceItem[];
}

export const TASK_SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
	task_id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	risk TEXT NOT NULL,
	origin_key TEXT NOT NULL,
	thread_ref TEXT NOT NULL,
	host TEXT,
	repo TEXT NOT NULL,
	worktree TEXT NOT NULL,
	branch TEXT NOT NULL,
	agent TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('working','blocked','review','done','cancelled')),
	acceptance_json TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	progress_at INTEGER,
	reminded_at INTEGER,
	notices_json TEXT NOT NULL DEFAULT '{}',
	closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS tasks_thread ON tasks(thread_ref);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
`;

/** Creates the table in a database that may predate it (idempotent, never touches rows). */
export function migrateTaskSchema(db: Database): void {
	db.run(TASK_SCHEMA);
}

interface TaskSql {
	task_id: string;
	title: string;
	risk: TaskRisk;
	origin_key: string;
	thread_ref: string;
	host: string | null;
	repo: string;
	worktree: string;
	branch: string;
	agent: string;
	status: TaskStatus;
	acceptance_json: string;
	created_at: number;
	updated_at: number;
	progress_at: number | null;
	reminded_at: number | null;
	notices_json: string;
	closed_at: number | null;
}

const toTask = (r: TaskSql): TaskRow => ({
	taskId: r.task_id,
	title: r.title,
	risk: r.risk,
	originKey: r.origin_key,
	threadRef: r.thread_ref,
	host: r.host,
	repo: r.repo,
	worktree: r.worktree,
	branch: r.branch,
	agent: r.agent,
	status: r.status,
	acceptance: JSON.parse(r.acceptance_json) as AcceptanceItem[],
	createdAt: r.created_at,
	updatedAt: r.updated_at,
	progressAt: r.progress_at,
	remindedAt: r.reminded_at,
	notices: JSON.parse(r.notices_json) as Record<string, number>,
	closedAt: r.closed_at,
});

/** Durable registry of [TASK] work. Works on any database handle, so the CLI uses it without the full `Store`. */
export class TaskLedger {
	readonly #db: Database;
	readonly #clock: TaskClock;

	constructor(db: Database, options: { clock: TaskClock }) {
		this.#db = db;
		this.#clock = options.clock;
		migrateTaskSchema(db);
	}

	/** Allocates the next `T-YYYYMMDD-NN` of the KST day and inserts the row as `working`, in one transaction. */
	register(input: NewTask): TaskRow {
		return this.#db.transaction(() => {
			const now = this.#clock.now();
			const day = kstDay(now);
			const last = this.#db
				.query("SELECT task_id FROM tasks WHERE task_id LIKE ? ORDER BY task_id DESC LIMIT 1")
				.get(`T-${day}-%`) as { task_id: string } | null;
			const seq = last === null ? 1 : Number(last.task_id.slice(`T-${day}-`.length)) + 1;
			const taskId = formatTaskId(day, seq);
			this.#db
				.query(
					`INSERT INTO tasks (task_id, title, risk, origin_key, thread_ref, host, repo, worktree, branch, agent, status,
						acceptance_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'working', ?, ?, ?)`,
				)
				.run(
					taskId,
					input.title,
					input.risk,
					input.originKey,
					input.threadRef,
					input.host,
					input.repo,
					worktreePathOf(input.repo, taskId),
					branchOf(taskId),
					agentNameOf(taskId),
					JSON.stringify(input.acceptance),
					now,
					now,
				);
			return this.require(taskId);
		})();
	}

	get(taskId: string): TaskRow | undefined {
		const row = this.#db.query("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as TaskSql | null;
		return row === null ? undefined : toTask(row);
	}

	require(taskId: string): TaskRow {
		const row = this.get(taskId);
		if (row === undefined) throw new TaskTransitionError(`task not found: ${taskId}`);
		return row;
	}

	/** The task bound to a herdr agent on `host` (null = local), if any. */
	getByAgent(agent: string, host: string | null): TaskRow | undefined {
		const row = this.#db.query("SELECT * FROM tasks WHERE agent = ? AND host IS ?").get(agent, host) as TaskSql | null;
		return row === null ? undefined : toTask(row);
	}

	list(): TaskRow[] {
		return (this.#db.query("SELECT * FROM tasks ORDER BY task_id").all() as TaskSql[]).map(toTask);
	}

	/** Tasks the sweep watches. */
	listActive(): TaskRow[] {
		return (
			this.#db.query("SELECT * FROM tasks WHERE status IN ('working','blocked') ORDER BY task_id").all() as TaskSql[]
		).map(toTask);
	}

	/** Whether a Slack thread root (`<channel>:<ts>`) carries a registered task. */
	isTaskRoot(threadRef: string): boolean {
		return this.#db.query("SELECT 1 FROM tasks WHERE thread_ref = ? LIMIT 1").get(threadRef) !== null;
	}

	/**
	 * Moves a task. The bot (`actor: "bot"`) can never reach `done`/`cancelled`; only a human close does, from any
	 * open state. Closed tasks never move. Same-state moves are no-ops.
	 */
	transition(taskId: string, to: TaskStatus, actor: TaskActor): TaskRow {
		return this.#db.transaction(() => {
			const row = this.require(taskId);
			if (row.status === to) return row;
			if (actor === "bot" && HUMAN_ONLY.includes(to)) {
				throw new TaskTransitionError(`${taskId}: ${to}는 사람의 close로만 갈 수 있습니다`);
			}
			if (row.status === "done" || row.status === "cancelled") {
				throw new TaskTransitionError(`${taskId}: 이미 ${row.status}로 닫힌 작업입니다`);
			}
			if (actor === "human" && !HUMAN_ONLY.includes(to)) {
				throw new TaskTransitionError(`${taskId}: 사람은 done·cancelled로만 옮깁니다`);
			}
			if (actor === "bot" && !BOT_TRANSITIONS[row.status].includes(to)) {
				throw new TaskTransitionError(`${taskId}: ${row.status} → ${to} 전이는 허용되지 않습니다`);
			}
			const now = this.#clock.now();
			this.#db
				.query("UPDATE tasks SET status = ?, updated_at = ?, closed_at = ? WHERE task_id = ?")
				.run(to, now, HUMAN_ONLY.includes(to) ? now : null, taskId);
			return this.require(taskId);
		})();
	}

	/**
	 * Marks a notice key as posted. True only for the call that set it, so the caller posts exactly when it wins —
	 * a repeated sweep over the same state stays silent.
	 */
	recordNotice(taskId: string, key: string): boolean {
		return this.#db.transaction(() => {
			const row = this.require(taskId);
			if (key in row.notices) return false;
			const notices = { ...row.notices, [key]: this.#clock.now() };
			this.#db.query("UPDATE tasks SET notices_json = ? WHERE task_id = ?").run(JSON.stringify(notices), taskId);
			return true;
		})();
	}

	setProgressAt(taskId: string, progressAt: number): void {
		this.#db.query("UPDATE tasks SET progress_at = ? WHERE task_id = ?").run(progressAt, taskId);
	}

	markReminded(taskId: string, at: number): void {
		this.#db.query("UPDATE tasks SET reminded_at = ? WHERE task_id = ?").run(at, taskId);
	}

	/** Deletes the row of a registration that failed before the agent started (never a started task). */
	discard(taskId: string): void {
		this.#db.query("DELETE FROM tasks WHERE task_id = ? AND status = 'working'").run(taskId);
	}

	close(): void {
		this.#db.close();
	}
}

/** Standalone connection for the CLI. */
export function openTaskLedger(path: string, clock: TaskClock = { now: () => Date.now() }): TaskLedger {
	const db = new Database(path, { create: true, strict: true });
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA busy_timeout = 5000");
	return new TaskLedger(db, { clock });
}
