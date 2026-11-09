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
CREATE TABLE IF NOT EXISTS task_transitions (
	transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
	task_id TEXT NOT NULL REFERENCES tasks(task_id),
	from_status TEXT,
	to_status TEXT NOT NULL,
	actor TEXT NOT NULL CHECK (actor IN ('bot','human')),
	reason TEXT,
	at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS task_transitions_task ON task_transitions(task_id, transition_id);
`;

/** One append-only line of a task's status history; the registration line has `fromStatus: null`. */
export interface TaskTransitionRow {
	transitionId: number;
	taskId: string;
	fromStatus: TaskStatus | null;
	toStatus: TaskStatus;
	actor: TaskActor;
	reason: string | null;
	at: number;
}

/** Creates the tables in a database that may predate them (idempotent, never touches rows). */
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

interface TransitionSql {
	transition_id: number;
	task_id: string;
	from_status: TaskStatus | null;
	to_status: TaskStatus;
	actor: TaskActor;
	reason: string | null;
	at: number;
}

/**
 * A row's JSON columns, each on its own: an `acceptance_json` that does not parse to an array reads as `[]`, a
 * `notices_json` that does not parse to a plain object as `{}`, and `broken` names the columns that did so. One
 * damaged row never breaks a read of the others.
 */
export function parseTaskJson(
	acceptanceJson: string,
	noticesJson: string,
): { acceptance: AcceptanceItem[]; notices: Record<string, number>; broken: string[] } {
	const parse = (text: string): unknown => {
		try {
			return JSON.parse(text);
		} catch {
			return undefined;
		}
	};
	const broken: string[] = [];
	const acceptance = parse(acceptanceJson);
	if (!Array.isArray(acceptance)) broken.push("acceptance_json");
	const notices = parse(noticesJson);
	const plain = typeof notices === "object" && notices !== null && !Array.isArray(notices);
	if (!plain) broken.push("notices_json");
	return {
		acceptance: Array.isArray(acceptance) ? (acceptance as AcceptanceItem[]) : [],
		notices: plain ? (notices as Record<string, number>) : {},
		broken,
	};
}

const toTask = (r: TaskSql): TaskRow => {
	const { acceptance, notices } = parseTaskJson(r.acceptance_json, r.notices_json);
	return {
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
		acceptance,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		progressAt: r.progress_at,
		remindedAt: r.reminded_at,
		notices,
		closedAt: r.closed_at,
	};
};

/** `T-YYYYMMDD-` (11 characters), then the day's number as an integer: `-100` follows `-99`, not `-10`. */
const TASK_ORDER = "substr(task_id, 1, 11), CAST(substr(task_id, 12) AS INTEGER), task_id";

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
			const prefix = `T-${day}-`;
			// Numeric max: as text, `-99` sorts after `-100`, and the 101st id would collide.
			const { last } = this.#db
				.query("SELECT MAX(CAST(substr(task_id, ?) AS INTEGER)) AS last FROM tasks WHERE task_id LIKE ?")
				.get(prefix.length + 1, `${prefix}%`) as { last: number | null };
			const taskId = formatTaskId(day, (last ?? 0) + 1);
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
			this.#recordTransition(taskId, null, "working", "bot", "registered", now);
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
		return (this.#db.query(`SELECT * FROM tasks ORDER BY ${TASK_ORDER}`).all() as TaskSql[]).map(toTask);
	}

	/** Tasks the sweep watches. */
	listActive(): TaskRow[] {
		return (
			this.#db
				.query(`SELECT * FROM tasks WHERE status IN ('working','blocked') ORDER BY ${TASK_ORDER}`)
				.all() as TaskSql[]
		).map(toTask);
	}

	/** Tasks waiting on the owner's review: the sweep re-alerts the ones left there a day or more. */
	listInReview(): TaskRow[] {
		return (
			this.#db.query(`SELECT * FROM tasks WHERE status = 'review' ORDER BY ${TASK_ORDER}`).all() as TaskSql[]
		).map(toTask);
	}

	/** Whether a Slack thread root (`<channel>:<ts>`) carries a registered task. */
	isTaskRoot(threadRef: string): boolean {
		return this.#db.query("SELECT 1 FROM tasks WHERE thread_ref = ? LIMIT 1").get(threadRef) !== null;
	}

	/**
	 * Moves a task. The bot (`actor: "bot"`) can never reach `done`/`cancelled`; only a human close does, from any
	 * open state. Closed tasks never move. Same-state moves are no-ops. Each real move appends one history line in the
	 * same transaction.
	 */
	transition(taskId: string, to: TaskStatus, actor: TaskActor, reason?: string): TaskRow {
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
			this.#recordTransition(taskId, row.status, to, actor, reason ?? null, now);
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

	/** The task's status history in `transition_id` order (empty for tasks registered before the history existed). */
	history(taskId: string): TaskTransitionRow[] {
		return (
			this.#db
				.query("SELECT * FROM task_transitions WHERE task_id = ? ORDER BY transition_id")
				.all(taskId) as TransitionSql[]
		).map((r) => ({
			transitionId: r.transition_id,
			taskId: r.task_id,
			fromStatus: r.from_status,
			toStatus: r.to_status,
			actor: r.actor,
			reason: r.reason,
			at: r.at,
		}));
	}

	#recordTransition(
		taskId: string,
		from: TaskStatus | null,
		to: TaskStatus,
		actor: TaskActor,
		reason: string | null,
		at: number,
	): void {
		this.#db
			.query(
				"INSERT INTO task_transitions (task_id, from_status, to_status, actor, reason, at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(taskId, from, to, actor, reason, at);
	}

	/**
	 * Deletes the row of a registration that failed before the agent started (never a started task), with its history
	 * lines first (foreign keys). The only path that removes history lines.
	 */
	discard(taskId: string): void {
		this.#db.transaction(() => {
			if (this.#db.query("SELECT 1 FROM tasks WHERE task_id = ? AND status = 'working'").get(taskId) === null) return;
			this.#db.query("DELETE FROM task_transitions WHERE task_id = ?").run(taskId);
			this.#db.query("DELETE FROM tasks WHERE task_id = ?").run(taskId);
		})();
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
