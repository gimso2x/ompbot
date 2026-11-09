import type { ChannelPort as SlackTransport } from "../channel/port";
import type { HerdrAgentStatusResult } from "../dispatch/omp";
import type { FreezeState } from "../ops/freeze";
import type { TaskJudgement } from "./checker";
import { digest, summarizeJudgement } from "./checker";
import type { TaskCheckCache, TaskEvaluation } from "./evaluate";
import type { TaskLedger, TaskRow } from "./ledger";
import {
	type AutoLandPolicy,
	autoLandBlockers,
	buildAgentWaitingCard,
	buildAutoLandCard,
	buildBlockedCard,
	buildLostCard,
	buildNudgeLimitCard,
	buildReachedCard,
	buildReviewWaitingCard,
	formatReadFailureNotice,
	formatSpecChangedNotice,
	formatStaleNotice,
	NUDGE_MAX,
	postToThread,
	setStatusReaction,
	type TaskCard,
	type TaskSlackLog,
	unmetLines,
} from "./notify";

/** Sweep cadence of the daemon. */
export const TASK_SWEEP_MS = 5 * 60_000;
/** PROGRESS.md untouched this long → the agent gets a reminder (once per interval). */
export const STALE_REMIND_MS = 30 * 60_000;
/** ... and this long → the task thread is told once. */
export const STALE_NOTICE_MS = 2 * 60 * 60_000;
/** A task left in review this long is brought up to the owner again, once per interval. */
export const REVIEW_REALERT_MS = 24 * 60 * 60_000;
/** Consecutive unreadable sweeps before the thread is told once. */
export const READ_FAILURE_NOTICE_AFTER = 3;
const NUDGE_HEAD =
	"Outcome 판정이 아직 미도달입니다. 아래를 채우거나, 진행할 수 없으면 PROGRESS.md status를 blocked로 바꾸고 사유를 적으세요.";

/** Where the nudge count starts: the latest `resume:<ms>` mark of `resumeTask`, else the registration. */
function nudgeBase(row: TaskRow): number {
	const resumes = Object.keys(row.notices)
		.filter((key) => key.startsWith("resume:"))
		.map((key) => Number(key.slice("resume:".length)))
		.filter((at) => Number.isFinite(at));
	return Math.max(row.createdAt, ...resumes);
}

/** Unmet-condition nudges recorded since `nudgeBase`. */
function nudgesSince(row: TaskRow): number {
	const since = nudgeBase(row);
	return Object.entries(row.notices).filter(([key, at]) => key.startsWith("unmet:") && at >= since).length;
}

export interface TaskSweepDeps {
	ledger: TaskLedger;
	/** Judges a task; `checks` is the sweeper's check-result cache, to hand to `evaluateTask` so checks run. */
	evaluate(row: TaskRow, checks: TaskCheckCache): Promise<TaskEvaluation>;
	/** Freeze switch (`<home>/FROZEN`): while it returns a state no reminder is sent to the agent. */
	frozen?: () => FreezeState | undefined;
	/**
	 * Sends a prompt to the task's herdr agent. `unconfirmed`: herdr took the prompt but saw no start (it may have
	 * landed), so the sweep counts it as sent rather than repeating it next sweep.
	 */
	remind(row: TaskRow, text: string): Promise<{ ok: boolean; error?: string; unconfirmed?: boolean }>;
	/** What herdr says the task's agent is doing: working/blocked defer the reminder, gone posts the LOST notice. */
	agentStatus(row: TaskRow): Promise<HerdrAgentStatusResult>;
	/** The agent's screen tail (`herdr agent read`), read only for a wait notice that is about to be posted. */
	readAgent(row: TaskRow): Promise<{ ok: boolean; output?: string; error?: string }>;
	transport: SlackTransport;
	/** The task's herdr board card link for the reached/blocked/stale notices; absent → no board footer. */
	boardLink?(row: TaskRow): Promise<string | undefined>;
	/** Live `taskAutoLand` (maxRisk defaulted); `undefined` (or absent) → every reached task gets the 머지 question. */
	autoLandPolicy?(): AutoLandPolicy | undefined;
	/** Whether a local task's repository shares its git common directory with one of `repos`. Never asked for a remote task. */
	repoMatches?(row: TaskRow, repos: readonly string[]): Promise<boolean>;
	/** Puts "머지해" into the task thread as the owner; true = it went in. */
	autoLand?(row: TaskRow): Promise<boolean>;
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
	/** `[check: …]` results per task HEAD (in memory: a restart runs the checks again). */
	readonly #checks: TaskCheckCache = new Map();
	/**
	 * When each task's agent was first seen herdr-`blocked` in its current wait (in memory: a restart may tell the
	 * owner once more about a wait that is still going on). The wait notice is keyed by it.
	 */
	readonly #waitingSince = new Map<string, number>();

	constructor(deps: TaskSweepDeps) {
		this.#deps = deps;
	}

	/**
	 * One pass over every working or blocked task, then over the tasks left in review (a reminder to the owner only).
	 * A task that throws never stops the others.
	 */
	async sweep(): Promise<TaskCheckResult[]> {
		const results: TaskCheckResult[] = [];
		const judged = new Set<string>();
		for (const row of this.#deps.ledger.listActive()) {
			judged.add(row.taskId);
			try {
				results.push(await this.check(row));
			} catch (error) {
				this.#deps.log.warn("task_sweep_failed", { task: row.taskId, error: String(error) });
			}
		}
		for (const row of this.#deps.ledger.listInReview()) {
			if (judged.has(row.taskId)) continue; // reached in this very pass
			try {
				results.push(await this.#reviewWaiting(row));
			} catch (error) {
				this.#deps.log.warn("task_sweep_failed", { task: row.taskId, error: String(error) });
			}
		}
		return results;
	}

	/**
	 * A review task is not judged again (no evaluate, no herdr): it only tells the owner once per full day it has waited
	 * since its last move to review. Not held by a freeze — the notice is for the owner.
	 */
	async #reviewWaiting(row: TaskRow): Promise<TaskCheckResult> {
		const { ledger } = this.#deps;
		const entry = ledger.history(row.taskId).findLast((item) => item.toStatus === "review");
		const since = entry?.at ?? row.updatedAt;
		const waited = this.#deps.now() - since;
		const hours = Math.max(0, Math.floor(waited / 3_600_000));
		const days = Math.floor(waited / REVIEW_REALERT_MS);
		const actions: string[] = [];
		if (days >= 1 && ledger.recordNotice(row.taskId, `review:${entry?.transitionId ?? 0}:${days}`)) {
			await this.#post(row, buildReviewWaitingCard(row, hours, this.#deps.ownerUserId, await this.#boardLink(row)));
			actions.push("review re-alert");
		}
		return { taskId: row.taskId, status: row.status, read: true, summary: `리뷰 대기 ${hours}시간`, actions };
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
			evaluation = await this.#deps.evaluate(row, this.#checks);
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
				ledger.transition(row.taskId, "blocked", "bot", judgement.blockedReason || "PROGRESS status: blocked");
				status = "blocked";
				await setStatusReaction(this.#deps.transport, log, row.threadRef, "blocked");
				actions.push("working → blocked, 🚧");
			}
			// Keyed by the block itself (its working → blocked transition): a resume and a new block report again,
			// even for the same reason; repeated sweeps over one block stay silent.
			const since = ledger.history(row.taskId).findLast((entry) => entry.toStatus === "blocked")?.transitionId ?? 0;
			if (ledger.recordNotice(row.taskId, `blocked:${since}:${judgement.blockedReason}`)) {
				await this.#post(row, buildBlockedCard(row, judgement, this.#deps.ownerUserId, await this.#boardLink(row)));
				actions.push("blocked notice");
			}
			return this.#result(row, status, judgement, actions);
		}
		if (status === "blocked") {
			ledger.transition(row.taskId, "working", "bot", "PROGRESS status: working");
			status = "working";
			await setStatusReaction(this.#deps.transport, log, row.threadRef, "working");
			actions.push("blocked → working, ⏳");
		}

		if (judgement.reached) {
			ledger.transition(row.taskId, "review", "bot", `outcome reached AC ${judgement.acChecked}/${judgement.acTotal}`);
			status = "review";
			await setStatusReaction(this.#deps.transport, log, row.threadRef, "review");
			actions.push("working → review, 🔍");
			if (ledger.recordNotice(row.taskId, `reached:${judgement.reachKey}`)) {
				await this.#reachedNotice(row, judgement, actions);
			}
			return this.#result(row, status, judgement, actions);
		}

		await this.#staleness(row, now, actions, judgement);
		return this.#result(row, status, judgement, actions);
	}

	/**
	 * The one card of a reach (its `reached:<reachKey>` notice key is already recorded, so a repeat sweep never gets
	 * here). With `taskAutoLand` on and nothing in the way, "머지해" goes into the thread first and the card only
	 * reports it; a skipped or failed auto-merge leaves today's 머지 question with one line saying why.
	 */
	async #reachedNotice(row: TaskRow, judgement: TaskJudgement, actions: string[]): Promise<void> {
		const { log, ownerUserId } = this.#deps;
		const policy = this.#deps.autoLandPolicy?.();
		const link = await this.#boardLink(row);
		if (policy === undefined || this.#deps.autoLand === undefined) {
			await this.#post(row, buildReachedCard(row, judgement, ownerUserId, link));
			actions.push("Outcome notice");
			return;
		}
		// A remote task's repo path means nothing to the local git, so it is never looked up.
		const repoMatched = row.host === null && (await this.#repoMatches(row, policy.repos));
		// A freeze stops every autonomous action, and merging unasked is one: the owner is asked instead.
		const blockers = [
			...(this.#deps.frozen?.() === undefined ? [] : ["동결 중"]),
			...autoLandBlockers(row, judgement, policy, repoMatched),
		];
		if (blockers.length > 0) {
			log.info("task_autoland_skipped", { task: row.taskId, reasons: blockers.join(" · ") });
			await this.#post(
				row,
				buildReachedCard(row, judgement, ownerUserId, link, { kind: "skipped", reasons: blockers }),
			);
			actions.push("Outcome notice (auto-merge skipped)");
			return;
		}
		let landed = false;
		try {
			landed = (await this.#deps.autoLand?.(row)) === true;
			if (!landed) log.warn("task_autoland_failed", { task: row.taskId, error: "not_accepted" });
		} catch (error) {
			log.warn("task_autoland_failed", { task: row.taskId, error: String(error) });
		}
		if (landed) {
			await this.#post(row, buildAutoLandCard(row, judgement, link));
			actions.push("auto-merge started");
			return;
		}
		await this.#post(row, buildReachedCard(row, judgement, ownerUserId, link, { kind: "failed" }));
		actions.push("Outcome notice (auto-merge failed)");
	}

	/** A failed or throwing comparison is a mismatch: the owner is asked as before. */
	async #repoMatches(row: TaskRow, repos: readonly string[]): Promise<boolean> {
		if (this.#deps.repoMatches === undefined) return false;
		try {
			return await this.#deps.repoMatches(row, repos);
		} catch (error) {
			this.#deps.log.warn("task_repo_match_failed", { task: row.taskId, error: String(error) });
			return false;
		}
	}

	async #staleness(row: TaskRow, now: number, actions: string[], judgement: TaskJudgement): Promise<void> {
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
			await this.#post(row, buildLostCard(row, this.#deps.ownerUserId, await this.#boardLink(row)));
			actions.push("LOST notice");
		}
		// A waiting agent refuses new prompts, so only the owner can unblock it: told once per wait, frozen or not
		// (like LOST). An unanswered lookup says nothing about the wait, so it neither starts nor ends one.
		if (status === "blocked") {
			const since = this.#waitingSince.get(row.taskId) ?? now;
			this.#waitingSince.set(row.taskId, since);
			if (ledger.recordNotice(row.taskId, `agentwait:${since}`)) {
				const screen = await this.#readAgent(row);
				await this.#post(row, buildAgentWaitingCard(row, screen, this.#deps.ownerUserId, await this.#boardLink(row)));
				actions.push("agent waiting notice");
			}
		} else if (agent.ok) {
			this.#waitingSince.delete(row.taskId);
		}
		const stale = age >= STALE_REMIND_MS && (fresh.remindedAt === null || now - fresh.remindedAt >= STALE_REMIND_MS);
		const due = !frozen && stale;
		if (!frozen) this.#remindHeld.delete(row.taskId);
		else if (stale && status !== "gone" && !this.#remindHeld.has(row.taskId)) {
			this.#remindHeld.add(row.taskId);
			this.#deps.log.info("task_remind_frozen", { task: row.taskId });
		}
		// An agent that ended its turn short of the outcome hears why at once, once per distinct set of unmet conditions.
		// It takes the place of the 30-minute reminder in that sweep: at most one prompt per sweep reaches the agent.
		const unmetKey = `unmet:${digest(judgement.problems)}`;
		const wantsNudge =
			(status === "idle" || status === "done") && judgement.problems.length > 0 && !(unmetKey in fresh.notices);
		// At most NUDGE_MAX nudges since the last resume (or registration); past that the owner hears it once, even frozen.
		const capped = wantsNudge && nudgesSince(fresh) >= NUDGE_MAX;
		if (capped && ledger.recordNotice(row.taskId, `nudgecap:${nudgeBase(fresh)}`)) {
			await this.#post(
				row,
				buildNudgeLimitCard(row, judgement.problems, this.#deps.ownerUserId, await this.#boardLink(row)),
			);
			actions.push("nudge limit notice");
		}
		const nudge = !frozen && wantsNudge && !capped;
		if (nudge) {
			if (await this.#remind(row, [NUDGE_HEAD, ...unmetLines(judgement.problems)].join("\n"))) {
				ledger.recordNotice(row.taskId, unmetKey);
				ledger.markReminded(row.taskId, now);
				actions.push("unmet nudge to agent");
			}
		} else if (due && (status === "working" || status === "blocked")) {
			// A busy or waiting agent is not interrupted; the next sweep judges again, so the reminder follows idle.
			this.#deps.log.info("task_remind_deferred", { task: row.taskId, agentStatus: status });
			actions.push(`reminder deferred (${status})`);
		} else if (due && status !== "gone") {
			const minutes = Math.floor(age / 60_000);
			const text = [
				`PROGRESS.md가 ${minutes}분 넘게 갱신되지 않았습니다. 지금 단계와 다음 행동을 PROGRESS.md의 updated·current·next에 반영하세요. 한 단계가 30분을 넘으면 30분마다 중간 갱신합니다.`,
				...unmetLines(judgement.problems),
			].join("\n");
			if (await this.#remind(row, text)) {
				ledger.markReminded(row.taskId, now);
				actions.push("stale reminder to agent");
			}
		}
		if (age >= STALE_NOTICE_MS && ledger.recordNotice(row.taskId, `stale2h:${base}`)) {
			await this.#post(row, formatStaleNotice(row, Math.floor(age / 60_000), await this.#boardLink(row)));
			actions.push("stale notice");
		}
	}

	/**
	 * One prompt to the agent; true when it counts as sent. An unconfirmed delivery (herdr saw no start, the text may
	 * have landed) counts too, so the agent is not sent the same prompt again on the next sweep.
	 */
	async #remind(row: TaskRow, text: string): Promise<boolean> {
		const sent = await this.#deps.remind(row, text);
		if (sent.ok) return true;
		if (sent.unconfirmed === true) {
			this.#deps.log.warn("task_remind_unconfirmed", { task: row.taskId, error: sent.error ?? "unknown" });
			return true;
		}
		this.#deps.log.warn("task_remind_failed", { task: row.taskId, error: sent.error ?? "unknown" });
		return false;
	}

	/** The screen for a wait notice; a failed or throwing read becomes the notice's "could not read" line. */
	async #readAgent(row: TaskRow): Promise<{ ok: boolean; output?: string; error?: string }> {
		try {
			return await this.#deps.readAgent(row);
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
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

	#post(row: TaskRow, card: TaskCard | string): Promise<boolean> {
		return postToThread(this.#deps.transport, this.#deps.log, row.threadRef, card);
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
