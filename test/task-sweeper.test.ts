import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon/daemon";
import { type HerdrAgentStatusResult, setLocalHerdrBin } from "../src/dispatch/omp";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { FakeSlackTransport } from "../src/slack/fake-transport";
import type { TaskJudgement } from "../src/tasks/checker";
import {
	acceptanceItems,
	docsDirOf,
	formatKst,
	renderContext,
	renderOutcome,
	renderProgress,
	renderSpec,
} from "../src/tasks/docs";
import type { TaskEvaluation } from "../src/tasks/evaluate";
import { TaskLedger, type TaskRow } from "../src/tasks/ledger";
import {
	READ_FAILURE_NOTICE_AFTER,
	STALE_NOTICE_MS,
	STALE_REMIND_MS,
	type TaskSweepDeps,
	TaskSweeper,
} from "../src/tasks/sweeper";
import { makeHome, OWNER, type TestHome, WaitingTransport } from "./helpers/bot-home";
import { killSpawned, runMain } from "./helpers/daemon-process";

const T0 = Date.parse("2026-10-26T06:00:00Z");
const MIN = 60_000;
const noop = { info() {}, warn() {} };

function judgement(over: Partial<TaskJudgement> = {}): TaskJudgement {
	return {
		reached: false,
		acChecked: 0,
		acTotal: 2,
		stepsDone: 0,
		stepsTotal: 1,
		status: "working",
		updatedAt: formatKst(T0),
		updatedAtMs: T0,
		specChanged: false,
		specKey: "spec1",
		blocked: false,
		blockedReason: "",
		decision: { question: "", recommend: "", impact: "" },
		current: "S1",
		evidence: {},
		reachKey: "k1",
		problems: [],
		...over,
	};
}

const reachedJudgement = (over: Partial<TaskJudgement> = {}): TaskJudgement =>
	judgement({
		reached: true,
		acChecked: 2,
		evidence: { "AC-1": ["commit abc1234 feat"], "AC-2": ["test bun test → 5 pass"] },
		...over,
	});

interface Rig {
	sweeper: TaskSweeper;
	ledger: TaskLedger;
	transport: FakeSlackTransport;
	clock: { ms: number };
	row: TaskRow;
	next: { value: TaskEvaluation };
	reminders: string[];
	remindOk: { value: boolean };
	evaluations: { count: number };
	/** What the fake herdr answers for the task's agent (idle unless a test says otherwise). */
	agent: { value: HerdrAgentStatusResult };
	statusCalls: { count: number };
}

function rig(over: Partial<Pick<TaskSweepDeps, "boardLink" | "log" | "frozen">> = {}): Rig {
	const clock = { ms: T0 };
	const ledger = new TaskLedger(new Database(":memory:", { strict: true }), { clock: { now: () => clock.ms } });
	const row = ledger.register({
		title: "로그 회전",
		risk: "L2",
		originKey: "slack/ch/C1/t/100.1",
		threadRef: "C1:100.1",
		host: null,
		repo: "/r/repo",
		acceptance: acceptanceItems(["하나", "둘"]),
	});
	const transport = new FakeSlackTransport();
	const next: { value: TaskEvaluation } = { value: { ok: true, judgement: judgement() } };
	const reminders: string[] = [];
	const remindOk = { value: true };
	const evaluations = { count: 0 };
	const agent: { value: HerdrAgentStatusResult } = { value: { ok: true, status: "idle" } };
	const statusCalls = { count: 0 };
	const deps: TaskSweepDeps = {
		ledger,
		evaluate: async () => {
			evaluations.count += 1;
			return next.value;
		},
		remind: async (_row, text) => {
			if (!remindOk.value) return { ok: false, error: "no agent" };
			reminders.push(text);
			return { ok: true };
		},
		agentStatus: async () => {
			statusCalls.count += 1;
			return agent.value;
		},
		transport,
		ownerUserId: "UOWN",
		now: () => clock.ms,
		log: noop,
		...over,
	};
	return {
		sweeper: new TaskSweeper(deps),
		ledger,
		transport,
		clock,
		row,
		next,
		reminders,
		remindOk,
		evaluations,
		agent,
		statusCalls,
	};
}

const posts = (r: Rig) => r.transport.calls.filter((c) => c.method === "postMessage");
const reactions = (r: Rig) =>
	r.transport.calls.filter((c) => c.method === "addReaction" || c.method === "removeReaction");
const added = (r: Rig) =>
	r.transport.calls.filter((c) => c.method === "addReaction").map((c) => ("name" in c ? c.name : ""));

describe("TaskSweeper", () => {
	test("Outcome reached: review, 🔍, one notice with owner mention and evidence; the next sweep does nothing", async () => {
		const r = rig();
		r.next.value = { ok: true, judgement: reachedJudgement() };
		await r.sweeper.sweep();
		expect(r.ledger.require(r.row.taskId).status).toBe("review");
		expect(added(r)).toEqual(["mag"]);
		expect(
			reactions(r).some((c) => c.method === "removeReaction" && "name" in c && c.name === "hourglass_flowing_sand"),
		).toBe(true);
		expect(posts(r)).toHaveLength(1);
		const post = posts(r)[0];
		expect(post).toMatchObject({ channel: "C1", threadTs: "100.1" });
		const text = post && "text" in post ? post.text : "";
		expect(text.split("\n")[0]).toStartWith("🔍 Outcome 도달 · 로그 회전");
		expect(text.split("\n")[0]).toContain("2/2");
		expect(text.split("\n")[0]).toEndWith("(local/t-20261026-01 · T-20261026-01) <@UOWN>");
		expect(text).toContain("• AC-1 하나 — [1]\n• AC-2 둘 — [2]");
		expect(text).toContain("[1] commit abc1234 feat\n[2] test bun test → 5 pass");
		expect(text).not.toContain("증거 약함");
		expect(text).toContain("git -C /r/repo-t-20261026-01 log --oneline main..task/T-20261026-01");
		expect(text).toContain('"머지해"라고 답하면 봇이 close→merge→push');
		expect(text).not.toContain("작업 보드"); // no board configured → no footer

		const callsBefore = r.transport.calls.length;
		await r.sweeper.sweep(); // review tasks are not swept
		expect(r.transport.calls).toHaveLength(callsBefore);
		// Same judgement key re-checked directly (e.g. `tasks check` after a resume) never reposts.
		r.ledger.transition(r.row.taskId, "working", "bot");
		await r.sweeper.check(r.ledger.require(r.row.taskId));
		expect(posts(r)).toHaveLength(1);
		expect(r.ledger.require(r.row.taskId).status).toBe("review");
		// New evidence is a new key and reports again.
		r.ledger.transition(r.row.taskId, "working", "bot");
		r.next.value = { ok: true, judgement: { ...reachedJudgement(), reachKey: "k2" } };
		await r.sweeper.check(r.ledger.require(r.row.taskId));
		expect(posts(r)).toHaveLength(2);
	});

	test("Outcome notice lists shared evidence once, flags commit-only evidence shared by criteria, counts unreported tests", async () => {
		const r = rig();
		const ran = "test bun test → 1148 pass 0 fail / Ran 1168 tests across 67 files.";
		r.next.value = {
			ok: true,
			judgement: reachedJudgement({
				evidence: { "AC-1": ["commit abc1234 feat"], "AC-2": ["commit abc1234 feat", ran] },
			}),
		};
		await r.sweeper.sweep();
		const post = posts(r)[0];
		const text = post && "text" in post ? post.text : "";
		expect(text).toContain("• AC-1 하나 — [1]\n• AC-2 둘 — [1][2]");
		expect(text).toContain(`[1] commit abc1234 feat\n[2] ${ran} (pass·fail 밖 20개: skip 등)`);
		expect(text).not.toContain("증거 약함"); // AC-2 has its own test line

		const same = rig();
		same.next.value = {
			ok: true,
			judgement: reachedJudgement({ evidence: { "AC-1": ["commit abc1234 feat"], "AC-2": ["commit abc1234 feat"] } }),
		};
		await same.sweeper.sweep();
		const flagged = posts(same)[0];
		const flaggedText = flagged && "text" in flagged ? flagged.text : "";
		expect(flaggedText).toContain("[1] commit abc1234 feat\n\n⚠️ 증거 약함: AC-1·AC-2가 같은 커밋 증거만 댔습니다.");
	});

	test("blocked: 🚧 and one owner-mention report per reason; unblocking returns to ⏳", async () => {
		const r = rig();
		r.next.value = {
			ok: true,
			judgement: judgement({ blocked: true, status: "blocked", blockedReason: "토큰 없음", current: "S2" }),
		};
		await r.sweeper.sweep();
		await r.sweeper.sweep();
		expect(r.ledger.require(r.row.taskId).status).toBe("blocked");
		expect(added(r)).toEqual(["construction"]);
		expect(posts(r)).toHaveLength(1);
		const text = (posts(r)[0] as { text: string }).text;
		expect(text.split("\n")[0]).toBe(
			"🚧 멈춤 · 로그 회전 — 결정이 필요합니다. (local/t-20261026-01 · T-20261026-01) <@UOWN>",
		);
		expect(text).toContain("*사유*: 토큰 없음");
		expect(text).toContain("*지금 단계*: S2");
		// Decision parts the agent did not write are left out, not printed empty.
		expect(text).not.toContain("*질문*");
		expect(text).not.toContain("*추천*");

		r.next.value = { ok: true, judgement: judgement() };
		await r.sweeper.sweep();
		expect(r.ledger.require(r.row.taskId).status).toBe("working");
		expect(added(r)).toEqual(["construction", "hourglass_flowing_sand"]);
		// A different reason reports again.
		r.next.value = { ok: true, judgement: judgement({ blocked: true, blockedReason: "다른 사유" }) };
		await r.sweeper.sweep();
		expect(posts(r)).toHaveLength(2);
	});

	test("blocked with a decision request: question, recommendation and impact, then the board card", async () => {
		const r = rig({ boardLink: async () => "https://board.test/task/?card=w1:p2" });
		r.next.value = {
			ok: true,
			judgement: judgement({
				blocked: true,
				status: "blocked",
				blockedReason: "push 승인 필요",
				decision: { question: "origin에 push할까요?", recommend: "push 후 CI 확인", impact: "CI가 처음 돈다" },
				current: "S3",
			}),
		};
		await r.sweeper.sweep();
		const lines = (posts(r)[0] as { text: string }).text.split("\n");
		expect(lines).toContain("*질문*: origin에 push할까요?");
		expect(lines).toContain("*추천*: push 후 CI 확인");
		expect(lines).toContain("*영향*: CI가 처음 돈다");
		expect(lines.slice(-3)).toEqual(["", "작업 보드", "https://board.test/task/?card=w1:p2"]);
	});

	test("a failing board lookup still posts the notice, without the footer", async () => {
		const warnings: string[] = [];
		const r = rig({
			boardLink: async () => {
				throw new Error("herdr down");
			},
			log: { info() {}, warn: (event) => warnings.push(event) },
		});
		r.next.value = { ok: true, judgement: reachedJudgement() };
		await r.sweeper.sweep();
		expect(posts(r)).toHaveLength(1);
		expect((posts(r)[0] as { text: string }).text).not.toContain("작업 보드");
		expect(warnings).toContain("task_board_link_failed");
	});

	test("a changed spec warns once without an owner mention and never reaches", async () => {
		const r = rig();
		r.next.value = { ok: true, judgement: judgement({ specChanged: true, specKey: "changed" }) };
		await r.sweeper.sweep();
		await r.sweeper.sweep();
		expect(posts(r)).toHaveLength(1);
		const text = (posts(r)[0] as { text: string }).text;
		expect(text).toContain("수락기준이 등록 스냅샷과 다릅니다");
		expect(text).not.toContain("<@");
		expect(r.ledger.require(r.row.taskId).status).toBe("working");
	});

	test("frozen: no reminder reaches the agent and none is marked sent, so it follows the unfreeze", async () => {
		const state: { value: { since: string; reason: string; by: string } | undefined } = {
			value: { since: "2026-10-30T01:00:00.000Z", reason: "점검", by: "cli" },
		};
		const events: string[] = [];
		const log = {
			info: (event: string, fields?: Record<string, unknown>) => void events.push(`${event} ${fields?.task}`),
			warn() {},
		};
		const r = rig({ frozen: () => state.value, log });
		r.clock.ms = T0 + STALE_REMIND_MS;
		await r.sweeper.sweep();
		r.clock.ms += 5 * MIN;
		await r.sweeper.sweep(); // still frozen, next 5-minute sweep: no second line
		expect(r.reminders).toEqual([]);
		const held = () => events.filter((event) => event === `task_remind_frozen ${r.row.taskId}`);
		expect(held()).toHaveLength(1);
		expect(r.ledger.require(r.row.taskId).remindedAt).toBeNull();
		state.value = undefined;
		await r.sweeper.sweep();
		expect(r.reminders).toHaveLength(1);
		// A new freeze logs the next held reminder once again.
		state.value = { since: "2026-10-30T09:00:00.000Z", reason: "재점검", by: "cli" };
		r.clock.ms += STALE_REMIND_MS;
		await r.sweeper.sweep();
		await r.sweeper.sweep();
		expect(held()).toHaveLength(2);
	});

	test("stale PROGRESS: reminder to the agent every 30 minutes, one thread notice after 2 hours", async () => {
		const r = rig();
		r.clock.ms = T0 + STALE_REMIND_MS - MIN;
		await r.sweeper.sweep();
		expect(r.reminders).toEqual([]);

		r.clock.ms = T0 + STALE_REMIND_MS;
		await r.sweeper.sweep();
		expect(r.reminders).toHaveLength(1);
		expect(r.reminders[0]).toContain("30분 넘게 갱신되지 않았습니다");
		await r.sweeper.sweep(); // same instant: not again
		r.clock.ms += 10 * MIN;
		await r.sweeper.sweep();
		expect(r.reminders).toHaveLength(1);

		r.clock.ms = T0 + 2 * STALE_REMIND_MS;
		await r.sweeper.sweep();
		expect(r.reminders).toHaveLength(2);
		expect(posts(r)).toHaveLength(0);

		r.clock.ms = T0 + STALE_NOTICE_MS;
		await r.sweeper.sweep();
		await r.sweeper.sweep();
		expect(posts(r)).toHaveLength(1);
		expect((posts(r)[0] as { text: string }).text).toContain("120분 넘게 갱신되지 않았습니다");
	});

	test("a progress update resets the staleness clock; a failed reminder is retried", async () => {
		const r = rig();
		r.remindOk.value = false;
		r.clock.ms = T0 + STALE_REMIND_MS;
		await r.sweeper.sweep();
		expect(r.ledger.require(r.row.taskId).remindedAt).toBeNull();
		r.remindOk.value = true;
		await r.sweeper.sweep();
		expect(r.reminders).toHaveLength(1);

		r.next.value = { ok: true, judgement: judgement({ updatedAtMs: r.clock.ms, updatedAt: formatKst(r.clock.ms) }) };
		r.clock.ms += 29 * MIN;
		await r.sweeper.sweep();
		expect(r.reminders).toHaveLength(1);
		expect(r.ledger.require(r.row.taskId).progressAt).toBe(T0 + STALE_REMIND_MS);
	});

	test("a future updated (agent wrote 15:25 at 15:22) counts as now, so the reminder is not pushed back", async () => {
		const r = rig();
		r.clock.ms = T0 + 10 * MIN;
		const written = r.clock.ms + 3 * MIN;
		r.next.value = { ok: true, judgement: judgement({ updatedAtMs: written, updatedAt: formatKst(written) }) };
		await r.sweeper.sweep();
		expect(r.ledger.require(r.row.taskId).progressAt).toBe(T0 + 10 * MIN);

		r.clock.ms = T0 + 10 * MIN + STALE_REMIND_MS;
		await r.sweeper.sweep();
		expect(r.reminders).toHaveLength(1);
	});

	test("read failures are logged, never a verdict; the third in a row tells the thread once", async () => {
		const r = rig();
		r.next.value = { ok: false, error: "host unreachable" };
		for (let i = 1; i < READ_FAILURE_NOTICE_AFTER; i++) await r.sweeper.sweep();
		expect(posts(r)).toHaveLength(0);
		expect(r.ledger.require(r.row.taskId).status).toBe("working");
		await r.sweeper.sweep();
		await r.sweeper.sweep();
		expect(posts(r)).toHaveLength(1);
		expect((posts(r)[0] as { text: string }).text).toContain("3회 연속 읽지 못했습니다");
		expect(r.reminders).toEqual([]);

		r.next.value = { ok: true, judgement: reachedJudgement() };
		await r.sweeper.sweep();
		expect(r.ledger.require(r.row.taskId).status).toBe("review");
	});

	test("an evaluator that throws counts as a read failure and does not stop other tasks", async () => {
		const r = rig();
		const other = r.ledger.register({ ...r.row, host: null, acceptance: r.row.acceptance, threadRef: "C1:200.1" });
		let calls = 0;
		const sweeper = new TaskSweeper({
			ledger: r.ledger,
			evaluate: async () => {
				calls += 1;
				if (calls === 1) throw new Error("boom");
				return { ok: true, judgement: reachedJudgement() };
			},
			remind: async () => ({ ok: true }),
			agentStatus: async () => ({ ok: true, status: "idle" }),
			transport: r.transport,
			ownerUserId: "UOWN",
			now: () => r.clock.ms,
			log: noop,
		});
		const results = await sweeper.sweep();
		expect(results.map((x) => x.read)).toEqual([false, true]);
		expect(r.ledger.require(other.taskId).status).toBe("review");
	});

	test("the bot-side status path can never produce done or cancelled", async () => {
		const r = rig();
		r.next.value = { ok: true, judgement: reachedJudgement() };
		await r.sweeper.sweep();
		expect(["review", "working", "blocked"]).toContain(r.ledger.require(r.row.taskId).status);
		expect(() => r.ledger.transition(r.row.taskId, "done", "bot")).toThrow();
	});

	test("a working agent is not interrupted: the reminder waits, then goes once on the first idle sweep", async () => {
		const r = rig();
		r.agent.value = { ok: true, status: "working" };
		r.clock.ms = T0 + STALE_REMIND_MS + 5 * MIN;
		const [first] = await r.sweeper.sweep();
		expect(r.reminders).toEqual([]);
		expect(r.ledger.require(r.row.taskId).remindedAt).toBeNull();
		expect(first?.actions).toContain("reminder deferred (working)");
		r.clock.ms += 5 * MIN;
		await r.sweeper.sweep();
		expect(r.reminders).toEqual([]);
		expect(r.ledger.require(r.row.taskId).remindedAt).toBeNull();

		r.agent.value = { ok: true, status: "idle" };
		r.clock.ms += 5 * MIN;
		await r.sweeper.sweep();
		expect(r.reminders).toHaveLength(1);
		expect(r.ledger.require(r.row.taskId).remindedAt).toBe(r.clock.ms);
		r.clock.ms += 5 * MIN;
		await r.sweeper.sweep();
		expect(r.reminders).toHaveLength(1);
	});

	test("an agent waiting for input (blocked in herdr) gets no reminder either", async () => {
		const r = rig();
		r.agent.value = { ok: true, status: "blocked" };
		r.clock.ms = T0 + STALE_REMIND_MS;
		const [result] = await r.sweeper.sweep();
		expect(r.reminders).toEqual([]);
		expect(r.ledger.require(r.row.taskId).remindedAt).toBeNull();
		expect(result?.actions).toEqual(["reminder deferred (blocked)"]);
		expect(posts(r)).toHaveLength(0);
	});

	test("a vanished agent: no reminder, one LOST notice with the resume call per progress base", async () => {
		const r = rig();
		r.agent.value = { ok: true, status: "gone" };
		r.clock.ms = T0 + STALE_REMIND_MS;
		const [result] = await r.sweeper.sweep();
		expect(r.reminders).toEqual([]);
		expect(result?.actions).toEqual(["LOST notice"]);
		expect(posts(r)).toHaveLength(1);
		expect(posts(r)[0]).toMatchObject({ channel: "C1", threadTs: "100.1" });
		const text = (posts(r)[0] as { text: string }).text;
		expect(text.split("\n")[0]).toBe(
			"👻 에이전트 없음 · 로그 회전 — herdr에 `t-20261026-01` 에이전트가 없습니다. (local/t-20261026-01 · T-20261026-01) <@UOWN>",
		);
		expect(text).toContain('taskSpec:{id:"T-20261026-01"}');

		r.clock.ms += 5 * MIN;
		await r.sweeper.sweep();
		r.clock.ms += 5 * MIN;
		await r.sweeper.sweep();
		expect(posts(r)).toHaveLength(1);
		expect(r.reminders).toEqual([]);

		// A resume (`resumeTask`) restarts the progress clock; vanishing again is a new loss.
		r.ledger.setProgressAt(r.row.taskId, r.clock.ms);
		r.clock.ms += 5 * MIN;
		await r.sweeper.sweep();
		await r.sweeper.sweep();
		expect(posts(r)).toHaveLength(2);
		expect((posts(r)[1] as { text: string }).text).toContain("👻 에이전트 없음");
	});

	test("frozen: the LOST notice is still posted (it tells the owner, not the agent)", async () => {
		const r = rig({ frozen: () => ({ since: "2026-10-30T01:00:00.000Z", reason: "점검", by: "cli" }) });
		r.agent.value = { ok: true, status: "gone" };
		await r.sweeper.sweep();
		expect(posts(r)).toHaveLength(1);
		expect((posts(r)[0] as { text: string }).text).toContain("👻 에이전트 없음");
	});

	test("an unanswerable herdr or an unknown status leaves the reminder as before", async () => {
		const warnings: Array<{ event: string; fields?: Record<string, unknown> }> = [];
		const r = rig({ log: { info() {}, warn: (event, fields) => warnings.push({ event, fields }) } });
		r.agent.value = { ok: false, error: "agent list failed: server not running" };
		r.clock.ms = T0 + STALE_REMIND_MS;
		await r.sweeper.sweep();
		expect(r.reminders).toHaveLength(1);
		expect(warnings).toContainEqual({
			event: "task_agent_status_failed",
			fields: { task: r.row.taskId, error: "agent list failed: server not running" },
		});

		r.agent.value = { ok: true, status: "unknown" };
		r.clock.ms += STALE_REMIND_MS;
		await r.sweeper.sweep();
		expect(r.reminders).toHaveLength(2);
		expect(posts(r)).toHaveLength(0);
	});

	test("a working agent still gets the 2-hour thread notice once", async () => {
		const r = rig();
		r.agent.value = { ok: true, status: "working" };
		r.clock.ms = T0 + STALE_NOTICE_MS;
		await r.sweeper.sweep();
		r.clock.ms += 5 * MIN;
		await r.sweeper.sweep();
		expect(r.reminders).toEqual([]);
		expect(posts(r)).toHaveLength(1);
		expect((posts(r)[0] as { text: string }).text).toContain("120분 넘게 갱신되지 않았습니다");
	});

	test("herdr is asked once per working task per sweep, never for a blocked or reached one", async () => {
		const r = rig();
		r.clock.ms = T0 + STALE_REMIND_MS; // reminder due: the LOST check and the reminder share one answer
		await r.sweeper.sweep();
		expect(r.reminders).toHaveLength(1);
		expect(r.statusCalls.count).toBe(1);
		r.agent.value = { ok: true, status: "working" };
		r.clock.ms += STALE_REMIND_MS;
		await r.sweeper.sweep();
		expect(r.statusCalls.count).toBe(2);

		r.next.value = { ok: true, judgement: judgement({ blocked: true, blockedReason: "토큰 없음" }) };
		await r.sweeper.sweep();
		expect(r.statusCalls.count).toBe(2);
		r.next.value = { ok: true, judgement: reachedJudgement() };
		await r.sweeper.sweep();
		expect(r.statusCalls.count).toBe(2);
	});

	test("syncReaction puts the single reaction of the closed status on the root", async () => {
		const r = rig();
		r.ledger.transition(r.row.taskId, "done", "human");
		expect(await r.sweeper.syncReaction(r.row.taskId)).toBe(true);
		expect(added(r)).toEqual(["white_check_mark"]);
		expect(await r.sweeper.syncReaction("T-19990101-01")).toBe(false);
	});
});

describe("daemon: sweep, IPC and CLI on a real local worktree", () => {
	let home: TestHome;
	let transport: WaitingTransport;
	let daemon: Daemon;
	let worktreeRoot: string;
	/** Every argv the daemon handed to herdr, and the agents its fake `agent list` reports (idle). */
	let herdrCalls: string[][];
	let herdrAgents: string[];
	const clock = { now: () => Date.now() };

	beforeEach(async () => {
		home = makeHome("ompbot-task-daemon-");
		transport = new WaitingTransport();
		worktreeRoot = mkdtempSync(join(tmpdir(), "ompbot-task-wt-"));
		herdrCalls = [];
		herdrAgents = [];
		const sessions = new FakeSessionStore();
		daemon = new Daemon({
			herdrRun: async (cmd) => {
				herdrCalls.push(cmd);
				const agents = herdrAgents.map((name) => ({ name, pane_id: `p-${name}`, agent_status: "idle" }));
				return { code: 0, stdout: JSON.stringify({ result: { agents } }), timedOut: false };
			},
			config: { ...home.config, herdr: {} },
			transport,
			clock,
			log: createLogger({ sink: () => undefined, clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			taskSweepMs: 0,
			gateSweepMs: 0,
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		await daemon.start();
	});

	afterEach(async () => {
		await daemon.stop();
		killSpawned();
		home.remove();
		rmSync(worktreeRoot, { recursive: true, force: true });
	});

	function registerWithDocs(done: boolean): TaskRow {
		const acceptance = acceptanceItems(["회전 테스트가 통과한다"]);
		const row = daemon.store.tasks.register({
			title: "t",
			risk: "L1",
			originKey: "slack/ch/C1",
			threadRef: "C1:100.1",
			host: null,
			repo: join(worktreeRoot, "repo"),
			acceptance,
		});
		herdrAgents.push(row.agent);
		const dir = docsDirOf(row.worktree, row.taskId);
		mkdirSync(dir, { recursive: true });
		const meta = {
			taskId: row.taskId,
			hostLabel: "local",
			repo: row.repo,
			worktree: row.worktree,
			branch: row.branch,
			agent: row.agent,
			threadLink: "x",
			registeredAt: row.createdAt,
		};
		const spec = {
			title: "t",
			risk: "L1" as const,
			goal: "g",
			scope: [],
			exclusions: [],
			acceptance: [],
			repo: row.repo,
		};
		const specText = renderSpec(meta, spec, acceptance);
		writeFileSync(join(dir, "spec.md"), done ? specText.replace("- [ ]", "- [x]") : specText);
		writeFileSync(join(dir, "PROGRESS.md"), renderProgress(row.taskId, Date.now()));
		writeFileSync(
			join(dir, "outcome.md"),
			done ? `${renderOutcome(row.taskId)}## AC-1\n- test: bun test → 5 pass\n` : renderOutcome(row.taskId),
		);
		writeFileSync(join(dir, "context.md"), renderContext(meta, { ...spec, acceptance: ["x"] }, "원문"));
		return row;
	}

	test("sweepTasks: nothing while incomplete; once complete exactly one notice and 🔍, then silence", async () => {
		const row = registerWithDocs(false);
		await daemon.sweepTasks();
		expect(transport.calls).toEqual([]);
		expect(herdrCalls).toContainEqual(["herdr", "agent", "list"]);
		expect(daemon.store.tasks.require(row.taskId).status).toBe("working");

		const dir = docsDirOf(row.worktree, row.taskId);
		const spec = join(dir, "spec.md");
		writeFileSync(spec, (await Bun.file(spec).text()).replace("- [ ]", "- [x]"));
		writeFileSync(join(dir, "outcome.md"), `${renderOutcome(row.taskId)}## AC-1\n- test: bun test → 5 pass\n`);
		await daemon.sweepTasks();
		expect(transport.posts((t) => t.includes("Outcome 도달"))).toHaveLength(1);
		expect(transport.posts()[0]).toMatchObject({ channel: "C1", threadTs: "100.1" });
		expect(transport.calls.filter((c) => c.method === "addReaction")).toMatchObject([
			{ channel: "C1", timestamp: "100.1", name: "mag" },
		]);
		expect(daemon.store.tasks.require(row.taskId).status).toBe("review");
		const count = transport.calls.length;
		await daemon.sweepTasks();
		expect(transport.calls).toHaveLength(count);
	});

	test("ompbot tasks check goes through the daemon; close is human-only and flips the reaction to ✅", async () => {
		const row = registerWithDocs(true);
		const checked = await runMain(home.dir, ["tasks", "check", row.taskId]);
		expect(checked.code).toBe(0);
		const body = JSON.parse(checked.stdout) as { ok: boolean; status: string; actions: string[]; summary: string };
		expect(body).toMatchObject({ ok: true, status: "review", summary: expect.stringContaining("AC 1/1") });
		expect(body.actions).toEqual(["working → review, 🔍", "Outcome notice"]);
		expect(transport.posts((t) => t.includes("Outcome 도달"))).toHaveLength(1);

		const closed = await runMain(home.dir, ["tasks", "close", row.taskId, "--as", "done"]);
		expect(closed.code).toBe(0);
		expect(closed.stderr).toBe("");
		expect(daemon.store.tasks.require(row.taskId)).toMatchObject({ status: "done" });
		const last = transport.calls.filter((c) => c.method === "addReaction").at(-1);
		expect(last).toMatchObject({ channel: "C1", timestamp: "100.1", name: "white_check_mark" });
		expect(OWNER).toBe("UOWNER");
	});
});

describe("daemon: herdr off (config without herdr)", () => {
	let home: TestHome;
	let daemon: Daemon | undefined;
	const clock = { now: () => Date.now() };

	beforeEach(() => {
		home = makeHome("ompbot-herdr-off-");
		daemon = undefined;
	});
	afterEach(async () => {
		await daemon?.stop();
		setLocalHerdrBin(undefined);
		home.remove();
	});

	async function boot(config: ConstructorParameters<typeof Daemon>[0]["config"]) {
		const lines: string[] = [];
		const herdrCalls: string[][] = [];
		const sessions = new FakeSessionStore();
		daemon = new Daemon({
			herdrRun: async (cmd) => {
				herdrCalls.push(cmd);
				return { code: 0, stdout: JSON.stringify({ result: { agents: [] } }), timedOut: false };
			},
			config,
			transport: new WaitingTransport(),
			clock,
			log: createLogger({ sink: (line) => void lines.push(line), clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot-herdr-off",
			taskSweepMs: 0,
			gateSweepMs: 0,
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		await daemon.start();
		return { lines, herdrCalls, daemon };
	}

	test("no TaskSweeper: sweeps never run; a working row at boot warns tasks_orphaned exactly once and stays", async () => {
		const first = await boot(home.config);
		expect(first.lines.filter((l) => l.includes("event=tasks_orphaned"))).toEqual([]);
		expect(first.lines.some((l) => l.includes("event=daemon_ready") && l.includes("herdr=off"))).toBe(true);
		const row = first.daemon.store.tasks.register({
			title: "t",
			risk: "L1",
			originKey: "slack/ch/C1",
			threadRef: "C1:100.1",
			host: null,
			repo: "/nonexistent/repo",
			acceptance: acceptanceItems(["x"]),
		});
		await first.daemon.stop();

		const second = await boot(home.config);
		await second.daemon.sweepTasks();
		await second.daemon.sweepTasks();
		expect(second.herdrCalls).toEqual([]);
		const orphaned = second.lines.filter((l) => l.includes("event=tasks_orphaned"));
		expect(orphaned).toHaveLength(1);
		expect(orphaned[0]).toContain("count=1");
		expect(second.daemon.store.tasks.require(row.taskId).status).toBe("working");
	});

	test("herdr on: the sweep asks herdr about the working row and daemon_ready says herdr=on", async () => {
		const first = await boot({ ...home.config, herdr: {} });
		expect(first.lines.some((l) => l.includes("event=daemon_ready") && l.includes("herdr=on"))).toBe(true);
		first.daemon.store.tasks.register({
			title: "t",
			risk: "L1",
			originKey: "slack/ch/C1",
			threadRef: "C1:100.1",
			host: null,
			repo: "/nonexistent/repo",
			acceptance: acceptanceItems(["x"]),
		});
		await first.daemon.sweepTasks();
		expect(first.herdrCalls.length).toBeGreaterThan(0);
		expect(first.lines.filter((l) => l.includes("event=tasks_orphaned"))).toEqual([]);
	});

	test("chat host tools follow the switch: off has no taskSpec, on matches the full schema", async () => {
		const off = await boot(home.config);
		const offTool = off.daemon.hostToolsFor("slack/dm/D0123456789").find((t) => t.name === "ompbot_dispatch");
		expect(JSON.stringify(offTool?.parameters)).not.toContain("taskSpec");
		await off.daemon.stop();
		const on = await boot({ ...home.config, herdr: {} });
		const onTool = on.daemon.hostToolsFor("slack/dm/D0123456789").find((t) => t.name === "ompbot_dispatch");
		expect(JSON.stringify(onTool?.parameters)).toContain("taskSpec");
	});

	test("herdr.bin: the daemon's local herdr calls run that binary", async () => {
		const argvFile = join(home.dir, "herdr-argv");
		const bin = join(home.dir, "fake-herdr");
		writeFileSync(bin, `#!/bin/sh\necho "$@" >> '${argvFile}'\necho '{"result":{"agents":[]}}'\n`, { mode: 0o755 });
		const { daemon: started } = await boot({ ...home.config, herdr: { bin } });
		const tool = started.hostToolsFor("slack/dm/D0123456789").find((t) => t.name === "ompbot_dispatch");
		await tool?.execute({ mode: "herdr", name: "x" }, { signal: new AbortController().signal });
		expect(await Bun.file(argvFile).text()).toBe("agent read x\n");
	});
});
