import type { HerdrAgentStatusResult } from "../dispatch/omp";
import type { FreezeState } from "../ops/freeze";
import type { SlackTransport } from "../slack/transport";
import type { TaskJudgement } from "./checker";
import { summarizeJudgement } from "./checker";
import type { TaskEvaluation } from "./evaluate";
import type { TaskLedger, TaskRow } from "./ledger";
import {
	formatBlockedNotice,
	formatLostNotice,
	formatReachedNotice,
	formatReadFailureNotice,
	formatSpecChangedNotice,
	formatStaleNotice,
	postToThread,
	setStatusReaction,
	type TaskSlackLog,
} from "./notify";

/** Sweep cadence of the daemon. */
export const TASK_SWEEP_MS = 5 * 60_000;
/** PROGRESS.md untouched this long → the agent gets a reminder (once per interval). */
export const STALE_REMIND_MS = 30 * 60_000;
/** ... and this long → the task thread is told once. */
export const STALE_NOTICE_MS = 2 * 60 * 60_000;
/** Consecutive unreadable sweeps before the thread is told once. */
export const READ_FAILURE_NOTICE_AFTER = 3;

export interface TaskSweepDeps {
	ledger: TaskLedger;
	evaluate(row: TaskRow): Promise<TaskEvaluation>;
	/** Freeze switch (`<home>/FROZEN`): while it returns a state no reminder is sent to the agent. */
	frozen?: () => FreezeState | undefined;
	/** Sends a prompt to the task's herdr agent. */
	remind(row: TaskRow, text: string): Promise<{ ok: boolean; error?: string }>;
	/** What herdr says the task's agent is doing: working/blocked defer the reminder, gone posts the LOST notice. */
	agentStatus(row: TaskRow): Promise<HerdrAgentStatusResult>;
	transport: SlackTransport;
	/** The task's herdr board card link for the reached/blocked/stale notices; absent → no board footer. */
	boardLink?(row: TaskRow): Promise<string | undefined>;
	ownerUserId: string;
	now(): number;
	log: TaskSlackLog & { info(event: string, fields?: Record<string, unknown>): void };
}

/** What one check did, for the CLI (`tasks check`). */
export interface TaskCheckResult {
	taskId: string;
	status: TaskRow["status"];
	read: boolean;
	summary: string;
	judgement?: TaskJudgement;
	/** Human-readable list of the side effects this check had (posts, reaction swaps, reminders). */
	actions: string[];
	error?: string;
}

/**
 * The [TASK] sweep: files and git only, never an LLM. Each notice kind is posted at most once per key (the ledger
 * records the key before the post, so a repeated sweep over the same state stays silent), the single status
 * reaction on the thread root follows the registry status, and the bot can only move working ⇄ blocked/review.
 */
export class TaskSweeper {
	readonly #deps: TaskSweepDeps;
	/** Consecutive read failures per task (in memory: a restart only delays the alert). */
	readonly #failures = new Map<string, { count: number; since: number }>();
	/** Last `updated` value read from each task's PROGRESS.md (in memory: a restart re-reads it once). */
	readonly #seenUpdated = new Map<string, number>();
	/** Tasks whose held reminder was already logged during the current freeze (one `task_remind_frozen` per freeze). */
	readonly #remindHeld = new Set<string>();

	constructor(deps: TaskSweepDeps) {
		this.#deps = deps;
	}

	/** One pass over every working or blocked task. A task that throws never stops the others. */
	async sweep(): Promise<TaskCheckResult[]> {
		const results: TaskCheckResult[] = [];
		for (const row of this.#deps.ledger.listActive()) {
			try {
				results.push(await this.check(row));
			} catch (error) {
				this.#deps.log.warn("task_sweep_failed", { task: row.taskId, error: String(error) });
			}
		}
		return results;
	}

	/** Re-applies the single status reaction of a task (after a human `close`). */
	async syncReaction(taskId: string): Promise<boolean> {
		const row = this.#deps.ledger.get(taskId);
		if (row === undefined) return false;
		await setStatusReaction(this.#deps.transport, this.#deps.log, row.threadRef, row.status);
		return true;
	}

	/** Judges one task and applies the sweep's rules to it. */
	async check(row: TaskRow): Promise<TaskCheckResult> {
		const { ledger, log } = this.#deps;
		const now = this.#deps.now();
		const actions: string[] = [];
		let evaluation: TaskEvaluation;
		try {
			evaluation = await this.#deps.evaluate(row);
		} catch (error) {
			evaluation = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}

		if (!evaluation.ok) {
			const streak = this.#failures.get(row.taskId) ?? { count: 0, since: now };
			streak.count += 1;
			this.#failures.set(row.taskId, streak);
			log.warn("task_read_failed", { task: row.taskId, count: streak.count, error: evaluation.error });
			if (streak.count >= READ_FAILURE_NOTICE_AFTER && ledger.recordNotice(row.taskId, `readfail:${streak.since}`)) {
				await this.#post(row, formatReadFailureNotice(row, streak.count, evaluation.error));
				actions.push("read-failure notice");
			}
			return {
				taskId: row.taskId,
				status: row.status,
				read: false,
				summary: `판정 읽기 실패: ${evaluation.error}`,
				actions,
				error: evaluation.error,
			};
		}
		this.#failures.delete(row.taskId);
		const judgement = evaluation.judgement;

		const written = judgement.updatedAtMs;
		if (written !== undefined && written !== this.#seenUpdated.get(row.taskId)) {
			// Each written `updated` counts once, when first seen. A time later than the real one counts as now —
			// otherwise it would push the stale reminder back by the difference, then again once the clock passes it.
			this.#seenUpdated.set(row.taskId, written);
			let progressAt = written;
			if (written > now) {
				log.warn("task_updated_future", { task: row.taskId, updatedAtMs: written, now });
				progressAt = now;
			}
			if (progressAt > (row.progressAt ?? 0)) ledger.setProgressAt(row.taskId, progressAt);
		}
		if (judgement.specChanged && ledger.recordNotice(row.taskId, `spec:${judgement.specKey}`)) {
			await this.#post(row, formatSpecChangedNotice(row));
			actions.push("spec-change warning");
		}

		let status = row.status;
		if (judgement.blocked) {
			if (status === "working") {
				ledger.transition(row.taskId, "blocked", "bot");
				status = "blocked";
				await setStatusReaction(this.#deps.transport, log, row.threadRef, "blocked");
				actions.push("working → blocked, 🚧");
			}
			if (ledger.recordNotice(row.taskId, `blocked:${judgement.blockedReason}`)) {
				await this.#post(row, formatBlockedNotice(row, judgement, this.#deps.ownerUserId, await this.#boardLink(row)));
				actions.push("blocked notice");
			}
			return this.#result(row, status, judgement, actions);
		}
		if (status === "blocked") {
			ledger.transition(row.taskId, "working", "bot");
			status = "working";
			await setStatusReaction(this.#deps.transport, log, row.threadRef, "working");
			actions.push("blocked → working, ⏳");
		}

		if (judgement.reached) {
			ledger.transition(row.taskId, "review", "bot");
			status = "review";
			await setStatusReaction(this.#deps.transport, log, row.threadRef, "review");
			actions.push("working → review, 🔍");
			if (ledger.recordNotice(row.taskId, `reached:${judgement.reachKey}`)) {
				await this.#post(row, formatReachedNotice(row, judgement, this.#deps.ownerUserId, await this.#boardLink(row)));
				actions.push("Outcome notice");
			}
			return this.#result(row, status, judgement, actions);
		}

		await this.#staleness(row, now, actions);
		return this.#result(row, status, judgement, actions);
	}

	async #staleness(row: TaskRow, now: number, actions: string[]): Promise<void> {
		const { ledger } = this.#deps;
		const fresh = ledger.require(row.taskId);
		const base = Math.max(fresh.progressAt ?? 0, fresh.createdAt);
		const age = now - base;
		// A frozen bot sends the agent nothing and does not mark the task reminded: the reminder follows the unfreeze.
		const frozen = this.#deps.frozen?.() !== undefined;
		// One herdr question per working task per sweep, shared by the LOST check and the reminder below.
		const agent = await this.#agentStatus(row);
		const status = agent.ok ? agent.status : undefined;
		// The LOST notice is for the owner, not the agent, so a freeze does not hold it. A resume moves the base.
		if (status === "gone" && ledger.recordNotice(row.taskId, `lost:${base}`)) {
			await this.#post(row, formatLostNotice(row, this.#deps.ownerUserId, await this.#boardLink(row)));
			actions.push("LOST notice");
		}
		const stale = age >= STALE_REMIND_MS && (fresh.remindedAt === null || now - fresh.remindedAt >= STALE_REMIND_MS);
		const due = !frozen && stale;
		if (!frozen) this.#remindHeld.delete(row.taskId);
		else if (stale && status !== "gone" && !this.#remindHeld.has(row.taskId)) {
			this.#remindHeld.add(row.taskId);
			this.#deps.log.info("task_remind_frozen", { task: row.taskId });
		}
		if (due && (status === "working" || status === "blocked")) {
			// A busy or waiting agent is not interrupted; the next sweep judges again, so the reminder follows idle.
			this.#deps.log.info("task_remind_deferred", { task: row.taskId, agentStatus: status });
			actions.push(`reminder deferred (${status})`);
		} else if (due && status !== "gone") {
			const minutes = Math.floor(age / 60_000);
			const text = `PROGRESS.md가 ${minutes}분 넘게 갱신되지 않았습니다. 지금 단계와 다음 행동을 PROGRESS.md의 updated·current·next에 반영하세요. 한 단계가 30분을 넘으면 30분마다 중간 갱신합니다.`;
			const sent = await this.#deps.remind(row, text);
			if (sent.ok) {
				ledger.markReminded(row.taskId, now);
				actions.push("stale reminder to agent");
			} else {
				this.#deps.log.warn("task_remind_failed", { task: row.taskId, error: sent.error ?? "unknown" });
			}
		}
		if (age >= STALE_NOTICE_MS && ledger.recordNotice(row.taskId, `stale2h:${base}`)) {
			await this.#post(row, formatStaleNotice(row, Math.floor(age / 60_000), await this.#boardLink(row)));
			actions.push("stale notice");
		}
	}

	/** herdr's view of the task's agent; a failed or throwing lookup is logged and leaves the reminder as before. */
	async #agentStatus(row: TaskRow): Promise<HerdrAgentStatusResult> {
		let result: HerdrAgentStatusResult;
		try {
			result = await this.#deps.agentStatus(row);
		} catch (error) {
			result = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		if (!result.ok) this.#deps.log.warn("task_agent_status_failed", { task: row.taskId, error: result.error });
		return result;
	}

	async #boardLink(row: TaskRow): Promise<string | undefined> {
		if (this.#deps.boardLink === undefined) return undefined;
		try {
			return await this.#deps.boardLink(row);
		} catch (error) {
			this.#deps.log.warn("task_board_link_failed", { task: row.taskId, error: String(error) });
			return undefined;
		}
	}

	#post(row: TaskRow, text: string): Promise<boolean> {
		return postToThread(this.#deps.transport, this.#deps.log, row.threadRef, text);
	}

	#result(row: TaskRow, status: TaskRow["status"], judgement: TaskJudgement, actions: string[]): TaskCheckResult {
		return {
			taskId: row.taskId,
			status,
			read: true,
			summary: summarizeJudgement(judgement, status),
			judgement,
			actions,
		};
	}
}
