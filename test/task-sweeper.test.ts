import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon/daemon";
import { type HerdrAgentStatusResult, realProcessRunner, setLocalHerdrBin } from "../src/dispatch/omp";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import { type FakeCall, FakeSlackTransport } from "../src/slack/fake-transport";
import type { TaskJudgement } from "../src/tasks/checker";
import { resumeTask, type TaskDispatchDeps } from "../src/tasks/dispatch";
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
import { formatAgentWaitingNotice, NUDGE_MAX } from "../src/tasks/notify";
import { restatedHash } from "../src/tasks/resume-check";
import {
	READ_FAILURE_NOTICE_AFTER,
	REVIEW_REALERT_MS,
	STALE_NOTICE_MS,
	STALE_REMIND_MS,
	TASK_SWEEP_MS,
	type TaskSweepDeps,
	TaskSweeper,
	taskChangedPaths,
} from "../src/tasks/sweeper";
import { makeHome, OWNER, type TestHome, WaitingTransport } from "./helpers/bot-home";
import { registryOf } from "./helpers/channels";
import { killSpawned, runMain } from "./helpers/daemon-process";
import { git as gitFixture } from "./helpers/git-fixtures";

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
		restated: "",
		evidence: {},
		summary: [],
		checks: [],
		integrityWarnings: [],
		reachKey: "k1",
		acceptance: [],
		steps: [],
		problems: [],
		...over,
	};
}

const SUMMARY = ["로그 파일이 10MB를 넘으면 회전합니다.", "bun test 5 pass 0 fail, 스펙 밖 예외 없음."];

const reachedJudgement = (over: Partial<TaskJudgement> = {}): TaskJudgement =>
	judgement({
		reached: true,
		acChecked: 2,
		evidence: { "AC-1": ["commit abc1234 feat"], "AC-2": ["test bun test → 5 pass"] },
		summary: SUMMARY,
		...over,
	});

/** The text of the first Outcome card a fresh rig posts for `over`. */
async function reachedCard(over: Partial<TaskJudgement> = {}): Promise<string> {
	const r = rig();
	r.next.value = { ok: true, judgement: reachedJudgement(over) };
	await r.sweeper.sweep();
	const post = posts(r)[0];
	return post && "text" in post ? post.text : "";
}

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
	/** What the fake `herdr agent read` answers, and how often the sweeper asked. */
	screen: { value: { ok: boolean; output?: string; error?: string } };
	readCalls: { count: number };
}

function rig(
	over: Partial<
		Pick<TaskSweepDeps, "boardLink" | "log" | "frozen" | "remind" | "autoLandPolicy" | "repoMatches" | "autoLand">
	> = {},
	task: Partial<Pick<TaskRow, "host" | "risk">> = {},
): Rig {
	const clock = { ms: T0 };
	const ledger = new TaskLedger(new Database(":memory:", { strict: true }), { clock: { now: () => clock.ms } });
	const row = ledger.register({
		title: "로그 회전",
		risk: task.risk ?? "L2",
		originKey: "slack/ch/C1/t/100.1",
		threadRef: "C1:100.1",
		host: task.host ?? null,
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
	const screen: Rig["screen"] = { value: { ok: true, output: "› 승인할까요? [y/n]" } };
	const readCalls = { count: 0 };
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
		readAgent: async () => {
			readCalls.count += 1;
			return screen.value;
		},
		channels: registryOf(new SlackChannel(transport)),
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
		screen,
		readCalls,
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
		expect(r.ledger.history(r.row.taskId).at(-1)).toMatchObject({
			fromStatus: "working",
			toStatus: "review",
			actor: "bot",
			reason: "outcome reached AC 2/2",
		});
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

	test("Outcome card post: header 🔍 머지 대기 · <title>, criteria and branch fields, one primary 머지 button with the task id", async () => {
		const r = rig({ boardLink: async () => "https://board.test/c/1" });
		r.next.value = { ok: true, judgement: reachedJudgement() };
		await r.sweeper.sweep();
		const post = posts(r)[0];
		const blocks = post && "blocks" in post ? post.blocks : undefined;
		expect(blocks?.[0]).toEqual({
			type: "header",
			text: { type: "plain_text", text: "🔍 머지 대기 · 로그 회전", emoji: true },
		});
		expect(blocks).toContainEqual({
			type: "section",
			fields: [
				{ type: "mrkdwn", text: "*수락기준*\n2/2" },
				{ type: "mrkdwn", text: "*브랜치*\n`task/T-20261026-01`" },
				{ type: "mrkdwn", text: "*워커*\nlocal/t-20261026-01 · T-20261026-01" },
			],
		});
		expect(blocks).toContainEqual({
			type: "actions",
			elements: [
				{
					type: "button",
					style: "primary",
					text: { type: "plain_text", text: "머지" },
					action_id: "ompbot:task:merge:T-20261026-01",
					value: "T-20261026-01",
				},
			],
		});
		expect(blocks?.at(-1)).toEqual({
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: "머지 = close → ff merge → push → 정리 · 재시작은 따로 승인 · 작업 보드: https://board.test/c/1",
				},
			],
		});
		const body = JSON.stringify(blocks?.[1]);
		expect(body).toContain("로그 파일이 10MB를 넘으면 회전합니다.");
		expect(body).toContain("<@UOWN>");
	});

	test("Outcome card shows the worker's summary lines, not the criteria or the evidence list", async () => {
		const text = await reachedCard();
		const lines = text.split("\n");
		expect(lines.slice(1, 5)).toEqual(["", `• ${SUMMARY[0]}`, `• ${SUMMARY[1]}`, ""]);
		expect(text).not.toContain("*수락기준*");
		expect(text).not.toContain("*증거*");
		expect(text).not.toContain("[1] commit");
		expect(text).not.toContain("abc1234");
		expect(text).not.toContain("• AC-1");
		expect(text).not.toContain("요약 없음");
	});

	test("no summary: one warning line in its place", async () => {
		const text = await reachedCard({ summary: [] });
		expect(text.split("\n").slice(1, 4)).toEqual([
			"",
			"⚠️ 요약 없음 — docs/tasks/T-20261026-01/outcome.md를 직접 봐 주세요.",
			"",
		]);
		expect(text).not.toContain("• ");
	});

	test("a long summary: the first three lines, each clipped to 200 characters", async () => {
		const long = "가".repeat(250);
		const text = await reachedCard({ summary: ["하나", long, "셋", "넷", "다섯"] });
		const bullets = text.split("\n").filter((line) => line.startsWith("• "));
		expect(bullets).toEqual(["• 하나", `• ${"가".repeat(199)}…`, "• 셋"]);
		for (const line of bullets) expect(line.slice(2).length).toBeLessThanOrEqual(200);
		expect(text).not.toContain("넷");
	});

	test("criteria citing the same commit-only evidence still raise the weak-evidence warning", async () => {
		const shared = { "AC-1": ["commit abc1234 feat"], "AC-2": ["commit abc1234 feat"] };
		const flagged = await reachedCard({ evidence: shared });
		expect(flagged).toContain(
			`• ${SUMMARY[1]}\n\n⚠️ 증거 약함: AC-1·AC-2가 같은 커밋 증거만 댔습니다. 커밋이 각 기준을 채우는지는 봇이 판정하지 않습니다.\n\n*질문*`,
		);
		// A criterion with its own test line is not commit-only.
		const own = await reachedCard({
			evidence: { "AC-1": ["commit abc1234 feat"], "AC-2": ["commit abc1234 feat", "test bun test → 5 pass"] },
		});
		expect(own).not.toContain("증거 약함");
	});

	test("the card closes with the question, how to answer and where the evidence lives", async () => {
		const lines = (await reachedCard()).split("\n");
		expect(lines.slice(-3)).toEqual([
			"*질문*: 브랜치 `task/T-20261026-01`를 main에 머지할까요?",
			'*답하는 법*: 이 스레드에 "머지해"라고 답하면 봇이 close→merge→push·워크트리 정리까지 하고, 서비스 반영(재시작)이 필요하면 그때 승인을 따로 요청합니다. 고칠 점이 있으면 그 내용을 적어 주세요.',
			"*근거*: `docs/tasks/T-20261026-01/outcome.md` · `git -C /r/repo-t-20261026-01 log --oneline main..task/T-20261026-01` (local)",
		]);
		expect(lines.join("\n")).not.toContain("*변경 보기*");
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
		// Each sweep move is one history line carrying the PROGRESS reason.
		expect(r.ledger.history(r.row.taskId).map((h) => [h.fromStatus, h.toStatus, h.actor, h.reason])).toEqual([
			[null, "working", "bot", "registered"],
			["working", "blocked", "bot", "토큰 없음"],
			["blocked", "working", "bot", "PROGRESS status: working"],
			["working", "blocked", "bot", "다른 사유"],
		]);
	});

	test("blocked again after a resume reports again, even with the same (or no) reason; one block reports once", async () => {
		const r = rig();
		for (const blockedReason of ["토큰 없음", ""]) {
			const before = posts(r).length;
			r.next.value = { ok: true, judgement: judgement({ blocked: true, status: "blocked", blockedReason }) };
			await r.sweeper.sweep();
			await r.sweeper.sweep();
			expect(posts(r)).toHaveLength(before + 1);
			// The owner answered, the agent resumed, then it hit the same wall again.
			r.next.value = { ok: true, judgement: judgement() };
			await r.sweeper.sweep();
			expect(r.ledger.require(r.row.taskId).status).toBe("working");
			r.next.value = { ok: true, judgement: judgement({ blocked: true, status: "blocked", blockedReason }) };
			await r.sweeper.sweep();
			await r.sweeper.sweep();
			expect(posts(r)).toHaveLength(before + 2);
			r.next.value = { ok: true, judgement: judgement() };
			await r.sweeper.sweep();
		}
	});

	test("blocked without a written reason is recorded as the PROGRESS status", async () => {
		const r = rig();
		r.next.value = { ok: true, judgement: judgement({ blocked: true, status: "blocked" }) };
		await r.sweeper.sweep();
		expect(r.ledger.history(r.row.taskId).at(-1)).toMatchObject({
			toStatus: "blocked",
			reason: "PROGRESS status: blocked",
		});
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
			readAgent: async () => ({ ok: true, output: "" }),
			channels: registryOf(new SlackChannel(r.transport)),
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

	test("an agent waiting for input (blocked in herdr) gets no reminder either; the owner is told instead", async () => {
		const r = rig();
		r.agent.value = { ok: true, status: "blocked" };
		r.clock.ms = T0 + STALE_REMIND_MS;
		const [result] = await r.sweeper.sweep();
		expect(r.reminders).toEqual([]);
		expect(r.ledger.require(r.row.taskId).remindedAt).toBeNull();
		expect(result?.actions).toEqual(["agent waiting notice", "reminder deferred (blocked)"]);
		expect(posts(r)).toHaveLength(1);
	});

	test("a herdr-blocked worker: one owner notice with the screen tail per wait; working or idle then blocked again tells once more", async () => {
		const r = rig();
		r.screen.value = { ok: true, output: "작업 중…\n\n› 이 파일을 지울까요? [y/n]\n" };
		const waitNotices = () => posts(r).filter((post) => "text" in post && post.text.includes("워커 대기"));
		r.agent.value = { ok: true, status: "blocked" };
		r.clock.ms = T0 + 5 * MIN;
		const [first] = await r.sweeper.sweep();
		expect(first?.actions).toContain("agent waiting notice");
		expect(waitNotices()).toHaveLength(1);
		expect(waitNotices()[0]).toMatchObject({ channel: "C1", threadTs: "100.1" });
		const text = (waitNotices()[0] as { text: string }).text;
		expect(text.split("\n")[0]).toBe(
			"⚠️ 워커 대기 · 로그 회전 — herdr 에이전트 `t-20261026-01`가 입력을 기다리거나 오류로 멈췄습니다. (local/t-20261026-01 · T-20261026-01) <@UOWN>",
		);
		expect(text).toContain("*화면 끝부분*:\n```\n작업 중…\n› 이 파일을 지울까요? [y/n]\n```");
		expect(text).toContain("agent_blocked");

		for (let i = 0; i < 2; i++) {
			r.clock.ms += 5 * MIN;
			await r.sweeper.sweep();
		}
		expect(waitNotices()).toHaveLength(1);

		for (const between of ["working", "idle"] as const) {
			r.agent.value = { ok: true, status: between };
			r.clock.ms += 5 * MIN;
			await r.sweeper.sweep();
			r.agent.value = { ok: true, status: "blocked" };
			r.clock.ms += 5 * MIN;
			await r.sweeper.sweep();
			r.clock.ms += 5 * MIN;
			await r.sweeper.sweep();
		}
		expect(waitNotices()).toHaveLength(3);
	});

	test("the wait notice goes out while frozen, says when the screen cannot be read, and masks secret shapes", async () => {
		const r = rig({ frozen: () => ({ since: "2026-10-30T01:00:00.000Z", reason: "점검", by: "cli" }) });
		r.agent.value = { ok: true, status: "blocked" };
		r.screen.value = { ok: false, error: `agent read failed: ${"x".repeat(200)}` };
		await r.sweeper.sweep();
		expect(posts(r)).toHaveLength(1);
		const text = (posts(r)[0] as { text: string }).text;
		expect(text).toContain("워커 대기");
		expect(text).toContain(`*화면*: 읽지 못함 (agent read failed: ${"x".repeat(120 - "agent read failed: ".length)})`);
		expect(text).not.toContain("```");
		expect(r.reminders).toEqual([]);

		const row = r.ledger.require(r.row.taskId);
		const masked = formatAgentWaitingNotice(
			row,
			{ ok: true, output: `토큰은 xoxb-TEST-0 입니다\n${"가".repeat(250)}\n펜스 \`\`\` 안` },
			"UOWN",
		);
		expect(masked).not.toContain("xoxb-TEST-0");
		expect(masked).toContain("토큰은 [REDACTED] 입니다");
		expect(masked).toContain(`\n${"가".repeat(200)}\n`);
		expect(masked).toContain("펜스 ʼʼʼ 안");
		const tail = formatAgentWaitingNotice(
			row,
			{ ok: true, output: Array.from({ length: 20 }, (_, i) => `줄${i + 1}`).join("\n") },
			"UOWN",
		);
		expect(tail).toContain("```\n줄9\n");
		expect(tail).not.toContain("줄8\n");
	});

	test("a wait notice whose screen shows a provider limit says the worker will not resume by itself, with the reset time", async () => {
		const r = rig();
		const row = r.ledger.require(r.row.taskId);
		const limited = formatAgentWaitingNotice(
			row,
			{
				ok: true,
				output:
					"edit src/a.ts\nError: 429 Usage limit reached for 5 hour. Your limit will reset at 2026-11-09 18:00:46 (type=1308)\n",
			},
			"UOWN",
		);
		expect(limited.split("\n")[0]).toContain("공급자 한도(요청 제한·사용량)로 멈췄습니다");
		expect(limited).toContain(
			"*이어가는 법*: 한도가 풀리는 2026-11-09 18:00:46 뒤 작업 보드의 herdr 화면에 `이어서`라고 입력합니다.",
		);
		expect(limited).not.toContain("*답하는 법*");

		// omp 18.18.7 at 80 columns, captured from tmux against a provider that answers 429.
		const wrapped = formatAgentWaitingNotice(
			row,
			{
				ok: true,
				output: [
					" hello",
					"─".repeat(80),
					" ✘ 429 [1308][Usage limit reached for 5 hour. Your limit will reset at",
					"   2026-11-09 18:00:46] (type=rate_limit_error param=1308)",
					" Dismissed when you send your next message.",
					"─".repeat(80),
				].join("\n"),
			},
			"UOWN",
		);
		expect(wrapped).toContain("*이어가는 법*: 한도가 풀리는 2026-11-09 18:00:46 뒤");

		const noReset = formatAgentWaitingNotice(
			row,
			{ ok: true, output: '{"type":"error","error":{"type":"rate_limit_error","message":"Please try again later."}}' },
			"UOWN",
		);
		expect(noReset).toContain("*이어가는 법*: 한도가 풀린 뒤 작업 보드의 herdr 화면에");

		for (const output of ["› 429줄짜리 파일을 지울까요? [y/n]", "overloaded 함수 시그니처를 고칠까요?"]) {
			const question = formatAgentWaitingNotice(row, { ok: true, output }, "UOWN");
			expect(question).toContain("입력을 기다리거나 오류로 멈췄습니다");
			expect(question).toContain("*답하는 법*: 작업 보드의 herdr 화면에서 직접 답합니다.");
		}
	});

	test("an unanswerable herdr keeps the wait: blocked, failed lookup, blocked again posts nothing new", async () => {
		const r = rig();
		r.agent.value = { ok: true, status: "blocked" };
		await r.sweeper.sweep();
		r.agent.value = { ok: false, error: "agent list failed: server not running" };
		r.clock.ms += 5 * MIN;
		await r.sweeper.sweep();
		r.agent.value = { ok: true, status: "blocked" };
		r.clock.ms += 5 * MIN;
		await r.sweeper.sweep();
		expect(posts(r).filter((post) => "text" in post && post.text.includes("워커 대기"))).toHaveLength(1);
	});

	test("one status question per working task per sweep; the screen is read only by the sweep that posts", async () => {
		const r = rig();
		r.agent.value = { ok: true, status: "blocked" };
		for (let i = 1; i <= 3; i++) {
			r.clock.ms += 5 * MIN;
			await r.sweeper.sweep();
			expect(r.statusCalls.count).toBe(i);
			expect(r.readCalls.count).toBe(1);
		}
		r.agent.value = { ok: true, status: "idle" };
		r.clock.ms += 5 * MIN;
		await r.sweeper.sweep();
		r.agent.value = { ok: true, status: "blocked" };
		r.clock.ms += 5 * MIN;
		await r.sweeper.sweep();
		expect(r.statusCalls.count).toBe(5);
		expect(r.readCalls.count).toBe(2);
	});

	test("an unconfirmed reminder or nudge counts as sent: warned once, not repeated on the next sweep", async () => {
		const warnings: Array<{ event: string; fields?: Record<string, unknown> }> = [];
		const sent: string[] = [];
		const r = rig({
			log: { info() {}, warn: (event, fields) => warnings.push({ event, fields }) },
			remind: async (_row, text) => {
				sent.push(text);
				return { ok: false, unconfirmed: true, error: "agent prompt unconfirmed: agent_prompt_stalled" };
			},
		});
		r.clock.ms = T0 + STALE_REMIND_MS;
		const [first] = await r.sweeper.sweep();
		expect(first?.actions).toEqual(["stale reminder to agent"]);
		expect(r.ledger.require(r.row.taskId).remindedAt).toBe(r.clock.ms);
		expect(warnings).toEqual([
			{
				event: "task_remind_unconfirmed",
				fields: { task: r.row.taskId, error: "agent prompt unconfirmed: agent_prompt_stalled" },
			},
		]);
		r.clock.ms += 5 * MIN;
		await r.sweeper.sweep();
		expect(sent).toHaveLength(1);

		r.next.value = { ok: true, judgement: judgement({ problems: ["AC-1: outcome.md에 절이 없습니다"] }) };
		r.clock.ms += 5 * MIN;
		const [nudged] = await r.sweeper.sweep();
		expect(nudged?.actions).toEqual(["unmet nudge to agent"]);
		r.clock.ms += 5 * MIN;
		await r.sweeper.sweep();
		expect(sent).toHaveLength(2);
		expect(warnings.filter((w) => w.event === "task_remind_failed")).toEqual([]);
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

	test("an idle agent with unmet conditions is nudged once with the problem list, well before 30 minutes", async () => {
		const r = rig();
		const problems = ["AC-1: spec.md 체크박스가 [x]가 아닙니다", "AC-2: commit 또는 test 증거가 없습니다"];
		r.next.value = { ok: true, judgement: judgement({ problems }) };
		r.clock.ms = T0 + 5 * MIN;
		const [first] = await r.sweeper.sweep();
		expect(r.reminders).toEqual([
			"Outcome 판정이 아직 미도달입니다. 아래를 채우거나, 진행할 수 없으면 PROGRESS.md status를 blocked로 바꾸고 사유를 적으세요.\n- AC-1: spec.md 체크박스가 [x]가 아닙니다\n- AC-2: commit 또는 test 증거가 없습니다",
		]);
		expect(first?.actions).toEqual(["unmet nudge to agent"]);
		expect(r.ledger.require(r.row.taskId).remindedAt).toBe(r.clock.ms);
		r.clock.ms += 5 * MIN;
		await r.sweeper.sweep();
		expect(r.reminders).toHaveLength(1);
	});

	test("changed unmet conditions nudge an idle or done agent once more", async () => {
		const r = rig();
		r.next.value = { ok: true, judgement: judgement({ problems: ["AC-1: outcome.md에 절이 없습니다"] }) };
		r.clock.ms = T0 + MIN;
		await r.sweeper.sweep();
		r.agent.value = { ok: true, status: "done" };
		r.clock.ms += 5 * MIN;
		await r.sweeper.sweep(); // same problems while done: nothing
		expect(r.reminders).toHaveLength(1);
		r.next.value = { ok: true, judgement: judgement({ problems: ["AC-2: commit 또는 test 증거가 없습니다"] }) };
		r.clock.ms += 5 * MIN;
		const [changed] = await r.sweeper.sweep();
		expect(changed?.actions).toEqual(["unmet nudge to agent"]);
		expect(r.reminders).toHaveLength(2);
		expect(r.reminders[1]?.split("\n").slice(1)).toEqual(["- AC-2: commit 또는 test 증거가 없습니다"]);
		r.clock.ms += 5 * MIN;
		await r.sweeper.sweep();
		expect(r.reminders).toHaveLength(2);
	});

	test("no nudge for a busy, waiting, vanished, unknown or unanswerable agent, nor while frozen", async () => {
		const unmet = judgement({ problems: ["AC-1: spec.md 체크박스가 [x]가 아닙니다"] });
		const statuses: HerdrAgentStatusResult[] = [
			{ ok: true, status: "working" },
			{ ok: true, status: "blocked" },
			{ ok: true, status: "gone" },
			{ ok: true, status: "unknown" },
			{ ok: false, error: "agent list failed" },
		];
		for (const value of statuses) {
			const r = rig();
			r.agent.value = value;
			r.next.value = { ok: true, judgement: unmet };
			r.clock.ms = T0 + 5 * MIN;
			const [result] = await r.sweeper.sweep();
			expect(r.reminders).toEqual([]);
			expect(result?.actions).not.toContain("unmet nudge to agent");
			expect(Object.keys(r.ledger.require(r.row.taskId).notices).some((key) => key.startsWith("unmet:"))).toBe(false);
		}
		const state: { value: { since: string; reason: string; by: string } | undefined } = {
			value: { since: "2026-10-30T01:00:00.000Z", reason: "점검", by: "cli" },
		};
		const frozen = rig({ frozen: () => state.value });
		frozen.next.value = { ok: true, judgement: unmet };
		frozen.clock.ms = T0 + 5 * MIN;
		await frozen.sweeper.sweep();
		expect(frozen.reminders).toEqual([]);
		state.value = undefined; // the nudge follows the unfreeze
		await frozen.sweeper.sweep();
		expect(frozen.reminders).toHaveLength(1);
	});

	test("a failed nudge records nothing and is tried again on the next sweep", async () => {
		const warnings: string[] = [];
		const r = rig({ log: { info() {}, warn: (event) => warnings.push(event) } });
		r.next.value = { ok: true, judgement: judgement({ problems: ["AC-1: outcome.md에 절이 없습니다"] }) };
		r.remindOk.value = false;
		r.clock.ms = T0 + 5 * MIN;
		const [failed] = await r.sweeper.sweep();
		expect(failed?.actions).toEqual([]);
		expect(warnings).toContain("task_remind_failed");
		expect(r.ledger.require(r.row.taskId)).toMatchObject({ notices: {}, remindedAt: null });
		r.remindOk.value = true;
		r.clock.ms += 5 * MIN;
		await r.sweeper.sweep();
		expect(r.reminders).toHaveLength(1);
		expect(r.reminders[0]).toStartWith("Outcome 판정이 아직 미도달입니다.");
	});

	test("the 30-minute reminder carries the unmet list, and one sweep sends the agent at most one prompt", async () => {
		const r = rig();
		const problems = Array.from({ length: 10 }, (_, i) => `AC-${i + 1}: ${"가".repeat(i === 0 ? 250 : 3)}`);
		r.next.value = { ok: true, judgement: judgement({ problems }) };
		r.clock.ms = T0 + STALE_REMIND_MS; // the nudge and the reminder are both due: only the nudge goes
		const [first] = await r.sweeper.sweep();
		expect(first?.actions).toEqual(["unmet nudge to agent"]);
		expect(r.reminders).toHaveLength(1);

		r.clock.ms += STALE_REMIND_MS;
		const [second] = await r.sweeper.sweep();
		expect(second?.actions).toEqual(["stale reminder to agent"]);
		expect(r.reminders).toHaveLength(2);
		const lines = (r.reminders[1] ?? "").split("\n");
		expect(lines[0]).toBe(
			"PROGRESS.md가 60분 넘게 갱신되지 않았습니다. 지금 단계와 다음 행동을 PROGRESS.md의 updated·current·next에 반영하세요. 한 단계가 30분을 넘으면 30분마다 중간 갱신합니다.",
		);
		expect(lines.slice(1)).toEqual([
			`- AC-1: ${"가".repeat(194)}`,
			...problems.slice(1, 8).map((problem) => `- ${problem}`),
			"- …외 2개",
		]);
		// The nudge carries the same list.
		expect((r.reminders[0] ?? "").split("\n").slice(1)).toEqual(lines.slice(1));
	});

	test("AC-4: ever-changing unmet conditions get exactly NUDGE_MAX nudges, then one owner notice; a resume counts anew", async () => {
		const r = rig();
		const herdr: string[][] = [];
		const dispatch: TaskDispatchDeps = {
			ledger: r.ledger,
			originKey: "slack/ch/C1/t/100.1",
			threadRef: () => "C1:100.1",
			rootText: () => undefined,
			channels: registryOf(new SlackChannel(r.transport)),
			now: () => r.clock.ms,
			workspaceDir: "/ws",
			run: async (cmd) => {
				herdr.push(cmd);
				const agents = [{ name: r.row.agent, agent_status: "idle" }];
				return {
					code: 0,
					stdout: cmd.includes("list") ? JSON.stringify({ result: { agents } }) : "{}",
					timedOut: false,
				};
			},
			log: noop,
		};
		const sweepWith = async (n: number) => {
			r.next.value = { ok: true, judgement: judgement({ problems: [`AC-1: 조건 ${n}`] }) };
			r.clock.ms += MIN;
			const [result] = await r.sweeper.sweep();
			return result?.actions ?? [];
		};
		const limitNotices = () => posts(r).filter((p) => "text" in p && p.text.includes("nudge 상한"));

		for (let n = 1; n <= NUDGE_MAX; n++) expect(await sweepWith(n)).toEqual(["unmet nudge to agent"]);
		expect(r.reminders).toHaveLength(4);
		expect(await sweepWith(5)).toEqual(["nudge limit notice"]);
		expect(await sweepWith(6)).toEqual([]);
		expect(await sweepWith(7)).toEqual([]);
		expect(r.reminders).toHaveLength(4);
		expect(limitNotices()).toHaveLength(1);
		const notice = limitNotices()[0];
		expect(notice && "text" in notice ? notice.text.split("\n") : []).toEqual([
			`⚠️ nudge 상한 · 로그 회전 — 미충족 조건을 4번 알렸지만 Outcome에 닿지 않았습니다. (local/${r.row.agent} · ${r.row.taskId}) <@UOWN>`,
			"*남은 조건*:",
			"- AC-1: 조건 5",
			"*답하는 법*: 이 스레드에 지시를 적으면 담당 에이전트에 넘겨 재개하고, 알림 횟수를 다시 셉니다.",
		]);
		expect(notice).toMatchObject({ channel: "C1", threadTs: "100.1" });

		r.clock.ms += MIN;
		expect(await resumeTask(dispatch, { id: r.row.taskId, task: "다시 해", host: undefined })).toContain(
			"살아 있는 에이전트에 재개 프롬프트를 보냈습니다",
		);
		expect(herdr.some((cmd) => cmd.includes("prompt"))).toBe(true);
		for (let n = 8; n < 8 + NUDGE_MAX; n++) expect(await sweepWith(n)).toEqual(["unmet nudge to agent"]);
		expect(r.reminders).toHaveLength(8);
		expect(await sweepWith(99)).toEqual(["nudge limit notice"]);
		expect(limitNotices()).toHaveLength(2);
	});

	test("AC-4: the nudge-limit notice reaches the owner while frozen; the agent still hears nothing", async () => {
		const state: { value: { since: string; reason: string; by: string } | undefined } = {
			value: undefined,
		};
		const r = rig({ frozen: () => state.value });
		const sweepWith = async (n: number) => {
			r.next.value = { ok: true, judgement: judgement({ problems: [`AC-1: 조건 ${n}`] }) };
			r.clock.ms += MIN;
			return (await r.sweeper.sweep())[0]?.actions ?? [];
		};
		for (let n = 1; n <= NUDGE_MAX; n++) await sweepWith(n);
		state.value = { since: "2026-10-30T01:00:00.000Z", reason: "점검", by: "cli" };
		expect(await sweepWith(5)).toEqual(["nudge limit notice"]);
		expect(r.reminders).toHaveLength(NUDGE_MAX);
	});

	test("AC-5: a task left in review is brought up again at 24 and 48 hours, once each, without judging it", async () => {
		const r = rig();
		r.next.value = { ok: true, judgement: reachedJudgement() };
		await r.sweeper.sweep();
		expect(r.ledger.require(r.row.taskId).status).toBe("review");
		const evaluated = r.evaluations.count;
		const asked = r.statusCalls.count;
		const waiting = () => posts(r).flatMap((p) => ("text" in p && p.text.includes("리뷰 대기") ? [p.text] : []));

		r.clock.ms = T0 + REVIEW_REALERT_MS - MIN;
		expect(await r.sweeper.sweep()).toMatchObject([{ status: "review", summary: "리뷰 대기 23시간", actions: [] }]);
		r.clock.ms = T0 + REVIEW_REALERT_MS + 3 * MIN;
		expect(await r.sweeper.sweep()).toEqual([
			{ taskId: r.row.taskId, status: "review", read: true, summary: "리뷰 대기 24시간", actions: ["review re-alert"] },
		]);
		expect(waiting()).toEqual([
			[
				`🔍 리뷰 대기 24시간 · 로그 회전 — Outcome 도달 뒤 닫히지 않았습니다. (local/${r.row.agent} · ${r.row.taskId}) <@UOWN>`,
				`*답하는 법*: "머지해"라고 답하거나 고칠 점을 적어 주세요. 그만두려면 \`tasks close ${r.row.taskId} --as cancelled\`.`,
			].join("\n"),
		]);
		for (const hours of [25, 30, 47]) {
			r.clock.ms = T0 + hours * 60 * MIN;
			await r.sweeper.sweep();
		}
		expect(waiting()).toHaveLength(1);
		r.clock.ms = T0 + 2 * REVIEW_REALERT_MS + MIN;
		await r.sweeper.sweep();
		await r.sweeper.sweep();
		expect(waiting()).toHaveLength(2);
		expect(waiting()[1]).toStartWith("🔍 리뷰 대기 48시간 · 로그 회전");
		expect([r.evaluations.count, r.statusCalls.count]).toEqual([evaluated, asked]);
	});

	test("AC-5: the review re-alert is posted while frozen, and a resumed task (working again) is not re-alerted", async () => {
		const state = { value: { since: "2026-10-30T01:00:00.000Z", reason: "점검", by: "cli" } };
		const r = rig({ frozen: () => state.value });
		r.next.value = { ok: true, judgement: reachedJudgement() };
		await r.sweeper.sweep();
		r.clock.ms = T0 + REVIEW_REALERT_MS;
		const [result] = await r.sweeper.sweep();
		expect(result?.actions).toEqual(["review re-alert"]);

		const back = rig();
		back.next.value = { ok: true, judgement: reachedJudgement() };
		await back.sweeper.sweep();
		back.ledger.transition(back.row.taskId, "working", "bot", "resume dispatch");
		back.next.value = { ok: true, judgement: judgement({ problems: ["AC-1: 조건"] }) };
		back.clock.ms = T0 + REVIEW_REALERT_MS + MIN;
		await back.sweeper.sweep();
		expect(posts(back).some((p) => "text" in p && p.text.includes("리뷰 대기"))).toBe(false);
	});

	test("syncReaction puts the single reaction of the closed status on the root", async () => {
		const r = rig();
		r.ledger.transition(r.row.taskId, "done", "human");
		expect(await r.sweeper.syncReaction(r.row.taskId)).toBe(true);
		expect(added(r)).toEqual(["white_check_mark"]);
		expect(await r.sweeper.syncReaction("T-19990101-01")).toBe(false);
	});
});

describe("TaskSweeper: auto-land (taskAutoLand)", () => {
	const POLICY = { repos: ["/r/repo"], maxRisk: "L2" as const };
	const PASSED = [{ id: "AC-2", signal: 'command ["bun","test"]', ok: true, detail: "exit 0" }];
	const textOf = (post: FakeCall | undefined): string => (post && "text" in post ? post.text : "");
	const blocksOf = (post: FakeCall | undefined): unknown[] =>
		post && "blocks" in post ? [...(post.blocks ?? [])] : [];
	const hasMergeButton = (post: FakeCall | undefined): boolean =>
		JSON.stringify(blocksOf(post)).includes('"action_id":"ompbot:task:merge:');
	const header = (post: FakeCall | undefined): string => JSON.stringify(blocksOf(post)[0] ?? null);

	/** A rig with the policy on, `repoMatches` answering `matched`, and `autoLand` answering `landed`. */
	function autoRig(
		opts: { matched?: boolean; landed?: (row: TaskRow) => Promise<boolean>; frozen?: boolean } = {},
		task: Partial<Pick<TaskRow, "host" | "risk">> = {},
	) {
		const calls = { autoLand: 0, repoMatches: 0, postsAtAutoLand: [] as number[], repos: [] as string[][] };
		const warnings: string[] = [];
		const r: Rig = rig(
			{
				...(opts.frozen === true
					? { frozen: () => ({ since: "2026-10-30T01:00:00.000Z", reason: "점검", by: "cli" }) }
					: {}),
				autoLandPolicy: () => POLICY,
				repoMatches: async (_row, repos) => {
					calls.repoMatches += 1;
					calls.repos.push([...repos]);
					return opts.matched ?? true;
				},
				autoLand: async (row) => {
					calls.autoLand += 1;
					calls.postsAtAutoLand.push(posts(r).length);
					return opts.landed === undefined ? true : opts.landed(row);
				},
				log: { info() {}, warn: (event) => warnings.push(event) },
			},
			task,
		);
		return { r, calls, warnings };
	}

	test("AC-1: without taskAutoLand a task meeting every condition gets today's card and side effects, autoLand never called", async () => {
		const reached = reachedJudgement({ checks: PASSED });
		let autoLands = 0;
		let matches = 0;
		const off = rig({
			autoLandPolicy: () => undefined,
			repoMatches: async () => {
				matches += 1;
				return true;
			},
			autoLand: async () => {
				autoLands += 1;
				return true;
			},
		});
		off.next.value = { ok: true, judgement: reached };
		await off.sweeper.sweep();
		// Today's sweeper: no auto-land dependencies at all.
		const today = rig();
		today.next.value = { ok: true, judgement: reached };
		await today.sweeper.sweep();

		expect(off.ledger.require(off.row.taskId).status).toBe("review");
		expect(added(off)).toEqual(["mag"]);
		expect(reactions(off)).toEqual(reactions(today));
		expect(posts(off)).toHaveLength(1);
		expect(posts(off)).toEqual(posts(today));
		expect(hasMergeButton(posts(off)[0])).toBe(true);
		expect(textOf(posts(off)[0])).not.toContain("자동 머지");
		expect(autoLands).toBe(0);
		expect(matches).toBe(0);
		await off.sweeper.sweep();
		expect(posts(off)).toHaveLength(1);
		expect(autoLands).toBe(0);
	});

	test("AC-2: a local task meeting every condition: autoLand once, then one buttonless 🚚 card; the same reachKey again adds nothing", async () => {
		const { r, calls } = autoRig();
		r.next.value = { ok: true, judgement: reachedJudgement({ checks: PASSED }) };
		await r.sweeper.sweep();
		expect(r.ledger.require(r.row.taskId).status).toBe("review");
		expect(added(r)).toEqual(["mag"]);
		expect(calls.autoLand).toBe(1);
		expect(calls.postsAtAutoLand).toEqual([0]); // autoLand goes first, the card after it
		expect(calls.repos).toEqual([POLICY.repos]);
		expect(posts(r)).toHaveLength(1);
		const card = posts(r)[0];
		expect(card).toMatchObject({ channel: "C1", threadTs: "100.1" });
		expect(header(card)).toContain("🚚 자동 머지 · 로그 회전");
		expect(blocksOf(card).some((b) => typeof b === "object" && b !== null && "type" in b && b.type === "actions")).toBe(
			false,
		);
		expect(textOf(card)).not.toContain("<@UOWN>");
		expect(textOf(card)).not.toContain("*질문*");
		expect(textOf(card)).toContain("재실행 검사 1/1 통과");
		expect(textOf(card)).toContain(`• ${SUMMARY[0]}`);
		await r.sweeper.sweep();
		await r.sweeper.sweep();
		expect(calls.autoLand).toBe(1);
		expect(posts(r)).toHaveLength(1);
	});

	const failed = { id: "AC-2", signal: 'command ["bun","test"]', ok: false, detail: "exit 1" };
	test.each<
		[
			string,
			{ matched?: boolean; frozen?: boolean },
			Partial<Pick<TaskRow, "host" | "risk">>,
			Partial<TaskJudgement>,
			string,
		]
	>([
		["① a remote host key", {}, { host: "wsl" }, { checks: PASSED }, "원격"],
		["② repoMatches false", { matched: false }, {}, { checks: PASSED }, "taskAutoLand.repos"],
		["③ risk above maxRisk", {}, { risk: "L3" }, { checks: PASSED }, "L3"],
		["④ no re-run check", {}, {}, { checks: [] }, "재실행 검사 없음"],
		["⑤ one re-run check failed", {}, {}, { checks: [...PASSED, failed] }, "재실행 검사 실패"],
		["⑥ an integrity warning", {}, {}, { checks: PASSED, integrityWarnings: ["무결성 guard: x"] }, "무결성"],
		[
			"⑦ a shared commit evidence warning",
			{},
			{},
			{ checks: PASSED, evidence: { "AC-1": ["commit abc1234 feat"], "AC-2": ["commit abc1234 feat"] } },
			"공유 커밋",
		],
		[
			"⑧ an unfinished PROGRESS step",
			{},
			{},
			{
				checks: PASSED,
				steps: [
					{ id: "S1", text: "step 1", done: true },
					{ id: "S9", text: "review-work", done: false },
				],
			},
			"PROGRESS 미완료 단계",
		],
		["(freeze) the bot is frozen", { frozen: true }, {}, { checks: PASSED }, "동결 중"],
	])("AC-3 %s: no autoLand, one 머지 card with the '자동 머지 안 함' line", async (_name, opts, task, over, reason) => {
		const { r, calls } = autoRig(opts, task);
		r.next.value = { ok: true, judgement: reachedJudgement(over) };
		await r.sweeper.sweep();
		expect(calls.autoLand).toBe(0);
		expect(posts(r)).toHaveLength(1);
		const card = posts(r)[0];
		expect(header(card)).toContain("🔍 머지 대기 · 로그 회전");
		expect(hasMergeButton(card)).toBe(true);
		const skip = textOf(card)
			.split("\n")
			.find((line) => line.startsWith("자동 머지 안 함: "));
		expect(skip).toContain(reason);
		expect(JSON.stringify(blocksOf(card))).toContain("자동 머지 안 함: ");
		await r.sweeper.sweep();
		expect(posts(r)).toHaveLength(1);
		expect(calls.autoLand).toBe(0);
	});

	test("AC-7: a remote task (host set) never reaches repoMatches", async () => {
		const { r, calls } = autoRig({}, { host: "wsl" });
		r.next.value = { ok: true, judgement: reachedJudgement({ checks: PASSED }) };
		await r.sweeper.sweep();
		expect(calls.repoMatches).toBe(0);
		expect(calls.autoLand).toBe(0);
		expect(posts(r)).toHaveLength(1);
	});

	test.each<[string, () => Promise<boolean>]>([
		["returns false", async () => false],
		[
			"throws",
			async () => {
				throw new Error("marker post failed");
			},
		],
	])(
		"AC-4: autoLand %s: one 머지 card with the ⚠️ line, no 🚚 card; the other task goes on; a repeat sweep adds nothing",
		async (_name, failure) => {
			const { r, calls, warnings } = autoRig({
				landed: async (row) => (row.taskId === r.row.taskId ? failure() : true),
			});
			const other = r.ledger.register({ ...r.row, host: null, acceptance: r.row.acceptance, threadRef: "C1:200.1" });
			r.next.value = { ok: true, judgement: reachedJudgement({ checks: PASSED }) };
			await r.sweeper.sweep();
			expect(calls.autoLand).toBe(2);
			const first = posts(r).filter((p) => "threadTs" in p && p.threadTs === "100.1");
			expect(first).toHaveLength(1);
			expect(header(first[0])).toContain("🔍 머지 대기");
			expect(hasMergeButton(first[0])).toBe(true);
			expect(textOf(first[0]).split("\n")[0]).toStartWith("⚠️ 자동 머지를 시작하지 못해");
			expect(JSON.stringify(blocksOf(first[0]))).toContain("⚠️ 자동 머지를 시작하지 못해");
			expect(posts(r).filter((p) => header(p).includes("🚚"))).toHaveLength(1); // the other task's
			const second = posts(r).filter((p) => "threadTs" in p && p.threadTs === "200.1");
			expect(second).toHaveLength(1);
			expect(header(second[0])).toContain("🚚 자동 머지");
			expect(r.ledger.require(r.row.taskId).status).toBe("review");
			expect(r.ledger.require(other.taskId).status).toBe("review");
			expect(warnings).toContain("task_autoland_failed");
			await r.sweeper.sweep();
			expect(calls.autoLand).toBe(2);
			expect(posts(r)).toHaveLength(2);
		},
	);
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
			channels: [new SlackBinding(new SlackChannel(transport))],
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

	/** A git command that must succeed (the task worktree is a real one: the sweep reads its branch diff). */
	function git(cwd: string, ...args: string[]): void {
		const result = Bun.spawnSync(["git", "-C", cwd, ...args]);
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	}

	/** Registers a task whose worktree is what `startTask` leaves: a branch off main opened by the docs commit. */
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
		mkdirSync(row.repo);
		git(row.repo, "init", "-q", "-b", "main");
		git(row.repo, "config", "user.name", "t");
		git(row.repo, "config", "user.email", "t@t");
		git(row.repo, "commit", "-q", "--allow-empty", "-m", "init");
		git(row.repo, "worktree", "add", "-q", "-b", row.branch, row.worktree);
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
		git(row.worktree, "add", "--", `docs/tasks/${row.taskId}`);
		git(row.worktree, "commit", "-q", "-m", `docs(task): ${row.taskId} 4문서`);
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
			channels: [new SlackBinding(new SlackChannel(new WaitingTransport()))],
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

	test("herdr health: on, each check asks the local herdr server and writes the stamp; off writes nothing", async () => {
		const off = await boot(home.config);
		await off.daemon.checkHerdrHealth();
		expect(off.herdrCalls).toEqual([]);
		expect(existsSync(join(home.dir, "herdr-health"))).toBe(false);
		await off.daemon.stop();

		const on = await boot({ ...home.config, herdr: {} });
		await on.daemon.checkHerdrHealth(); // the fake herdr prints no `status: running` line
		await on.daemon.checkHerdrHealth();
		expect(on.herdrCalls).toEqual([
			["herdr", "status", "server"],
			["herdr", "status", "server"],
		]);
		expect(readFileSync(join(home.dir, "herdr-health"), "utf8")).toMatch(/^ts=\S+ ok=0 fails=2 since=\S+ error=\S+\n$/);
		expect(on.lines.filter((l) => l.includes("event=herdr_health_failed"))).toHaveLength(2);
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

describe("TaskSweeper: file overlap between active tasks of one repository", () => {
	interface OverlapRig {
		sweeper: TaskSweeper;
		ledger: TaskLedger;
		transport: FakeSlackTransport;
		clock: { ms: number };
		a: TaskRow;
		b: TaskRow;
		/** Paths each task's `changedPaths` answers (by task id). */
		paths: Map<string, string[]>;
		/** Task ids `changedPaths` was asked for, in order. */
		asked: string[];
		/** `<taskId>: <text>` of every prompt that reached an agent. */
		reminders: string[];
		/** herdr status per task id (idle when unset). */
		agents: Map<string, HerdrAgentStatusResult>;
		remindOk: { value: boolean };
		next: { value: TaskEvaluation };
		logs: string[];
	}

	function overlapRig(): OverlapRig {
		const clock = { ms: T0 };
		const ledger = new TaskLedger(new Database(":memory:", { strict: true }), { clock: { now: () => clock.ms } });
		const register = (threadTs: string, host: string | null = null) =>
			ledger.register({
				title: `작업 ${threadTs}`,
				risk: "L2",
				originKey: `slack/ch/C1/t/${threadTs}`,
				threadRef: `C1:${threadTs}`,
				host,
				repo: "/r/repo",
				acceptance: acceptanceItems(["하나"]),
			});
		const a = register("100.1");
		const b = register("200.1");
		const transport = new FakeSlackTransport();
		const paths = new Map<string, string[]>();
		const asked: string[] = [];
		const reminders: string[] = [];
		const agents = new Map<string, HerdrAgentStatusResult>();
		const remindOk = { value: true };
		const next: { value: TaskEvaluation } = { value: { ok: true, judgement: judgement() } };
		const logs: string[] = [];
		const sweeper = new TaskSweeper({
			ledger,
			evaluate: async () => next.value,
			remind: async (row, text) => {
				if (!remindOk.value) return { ok: false, error: "no agent" };
				reminders.push(`${row.taskId}: ${text}`);
				return { ok: true };
			},
			agentStatus: async (row) => agents.get(row.taskId) ?? { ok: true, status: "idle" },
			readAgent: async () => ({ ok: true, output: "" }),
			changedPaths: async (row) => {
				asked.push(row.taskId);
				return paths.get(row.taskId);
			},
			channels: registryOf(new SlackChannel(transport)),
			ownerUserId: "UOWN",
			now: () => clock.ms,
			log: { info: (event) => logs.push(event), warn: (event) => logs.push(event) },
		});
		return { sweeper, ledger, transport, clock, a, b, paths, asked, reminders, agents, remindOk, next, logs };
	}

	const threadPosts = (r: OverlapRig) =>
		r.transport.calls.flatMap((c) => (c.method === "postMessage" ? [{ threadTs: c.threadTs, text: c.text }] : []));

	test("AC-4: a shared src file tells both threads and both idle agents once; the next sweep sends nothing", async () => {
		const r = overlapRig();
		r.paths.set(r.a.taskId, ["src/daemon/daemon.ts", "README.md"]);
		r.paths.set(r.b.taskId, ["src/tasks/sweeper.ts", "src/daemon/daemon.ts"]);
		await r.sweeper.sweep();
		const posts = threadPosts(r);
		expect(posts.map((p) => p.threadTs).sort()).toEqual(["100.1", "200.1"]);
		for (const post of posts) {
			expect(post.text).toBe(
				`⚠️ 파일 겹침: ${r.a.taskId}와 ${r.b.taskId}가 src/daemon/daemon.ts를 함께 고칩니다. 먼저 끝나는 쪽을 랜딩한 뒤 다른 쪽을 rebase하세요.`,
			);
		}
		expect(r.reminders.sort()).toEqual(
			[
				`${r.a.taskId}: 다른 TASK ${r.b.taskId}가 같은 파일(src/daemon/daemon.ts)을 고치고 있습니다. 그 파일 변경은 범위 안에서 최소로 하고, 겹치는 함수·절을 PROGRESS.md 메모에 적으세요.`,
				`${r.b.taskId}: 다른 TASK ${r.a.taskId}가 같은 파일(src/daemon/daemon.ts)을 고치고 있습니다. 그 파일 변경은 범위 안에서 최소로 하고, 겹치는 함수·절을 PROGRESS.md 메모에 적으세요.`,
			].sort(),
		);
		await r.sweeper.sweep();
		expect(threadPosts(r)).toHaveLength(2);
		expect(r.reminders).toHaveLength(2);
	});

	test("AC-4: more than five shared paths are cut to five plus a count", async () => {
		const r = overlapRig();
		const shared = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"];
		r.paths.set(r.a.taskId, shared);
		r.paths.set(r.b.taskId, [...shared].reverse());
		await r.sweeper.sweep();
		expect(threadPosts(r)[0]?.text).toContain("a.ts, b.ts, c.ts, d.ts, e.ts 외 2개를 함께 고칩니다");
	});

	test("AC-4: an intersection of docs/tasks/** only, or none, sends nothing", async () => {
		const r = overlapRig();
		r.paths.set(r.a.taskId, ["docs/tasks/T-1/PROGRESS.md", "src/a.ts"]);
		r.paths.set(r.b.taskId, ["docs/tasks/T-1/PROGRESS.md", "src/b.ts"]);
		await r.sweeper.sweep();
		r.paths.set(r.b.taskId, []);
		await r.sweeper.sweep();
		expect(threadPosts(r)).toHaveLength(0);
		expect(r.reminders).toHaveLength(0);
	});

	test("AC-4: a remote task is never asked for its changed paths", async () => {
		const r = overlapRig();
		const remote = r.ledger.register({
			title: "원격",
			risk: "L2",
			originKey: "slack/ch/C1/t/300.1",
			threadRef: "C1:300.1",
			host: "remote1",
			repo: "/r/repo",
			acceptance: acceptanceItems(["하나"]),
		});
		r.paths.set(remote.taskId, ["src/daemon/daemon.ts"]);
		r.paths.set(r.a.taskId, ["src/daemon/daemon.ts"]);
		await r.sweeper.sweep();
		expect(r.asked).not.toContain(remote.taskId);
		expect(threadPosts(r)).toHaveLength(0);
	});

	test("AC-4b: a working agent is not prompted (key not recorded) while the threads hear it once; it is prompted once idle", async () => {
		const r = overlapRig();
		r.paths.set(r.a.taskId, ["src/daemon/daemon.ts"]);
		r.paths.set(r.b.taskId, ["src/daemon/daemon.ts"]);
		r.agents.set(r.a.taskId, { ok: true, status: "working" });
		await r.sweeper.sweep();
		expect(threadPosts(r)).toHaveLength(2);
		expect(r.reminders.map((line) => line.split(":")[0])).toEqual([r.b.taskId]);
		expect(Object.keys(r.ledger.require(r.a.taskId).notices).some((key) => key.startsWith("overlapworker:"))).toBe(
			false,
		);
		expect(r.logs).toContain("task_overlap_remind_deferred");
		r.agents.set(r.a.taskId, { ok: true, status: "idle" });
		await r.sweeper.sweep();
		expect(threadPosts(r)).toHaveLength(2);
		expect(r.reminders.map((line) => line.split(":")[0])).toEqual([r.b.taskId, r.a.taskId]);
		await r.sweeper.sweep();
		expect(r.reminders).toHaveLength(2);
	});

	test("AC-4b: a failed prompt records nothing and is sent on the next sweep that succeeds", async () => {
		const r = overlapRig();
		r.paths.set(r.a.taskId, ["src/daemon/daemon.ts"]);
		r.paths.set(r.b.taskId, ["src/daemon/daemon.ts"]);
		r.remindOk.value = false;
		await r.sweeper.sweep();
		expect(threadPosts(r)).toHaveLength(2);
		expect(r.reminders).toHaveLength(0);
		r.remindOk.value = true;
		await r.sweeper.sweep();
		expect(threadPosts(r)).toHaveLength(2);
		expect(r.reminders).toHaveLength(2);
	});

	test("AC-4b: an agent that got the stale reminder in this sweep hears of the overlap on the next one", async () => {
		const r = overlapRig();
		r.paths.set(r.a.taskId, ["src/daemon/daemon.ts"]);
		r.paths.set(r.b.taskId, ["src/daemon/daemon.ts"]);
		r.clock.ms = T0 + STALE_REMIND_MS;
		r.next.value = { ok: true, judgement: judgement({ updatedAtMs: T0 }) };
		await r.sweeper.sweep();
		// Both agents got the 30-minute reminder: one prompt per sweep, so the overlap waits.
		expect(r.reminders).toHaveLength(2);
		expect(r.reminders.every((line) => line.includes("PROGRESS.md가"))).toBe(true);
		expect(threadPosts(r).filter((p) => p.text.startsWith("⚠️ 파일 겹침"))).toHaveLength(2);
		r.clock.ms += TASK_SWEEP_MS;
		await r.sweeper.sweep();
		expect(r.reminders.filter((line) => line.includes("다른 TASK"))).toHaveLength(2);
	});

	test("AC-4b: a frozen bot prompts no agent and records nothing", async () => {
		const r = overlapRig();
		r.paths.set(r.a.taskId, ["src/daemon/daemon.ts"]);
		r.paths.set(r.b.taskId, ["src/daemon/daemon.ts"]);
		const frozen = new TaskSweeper({
			ledger: r.ledger,
			evaluate: async () => r.next.value,
			remind: async (row, text) => {
				r.reminders.push(`${row.taskId}: ${text}`);
				return { ok: true };
			},
			agentStatus: async () => ({ ok: true, status: "idle" }),
			readAgent: async () => ({ ok: true, output: "" }),
			changedPaths: async (row) => r.paths.get(row.taskId),
			frozen: () => ({ since: new Date(T0).toISOString(), reason: "test", by: "cli" }),
			channels: registryOf(new SlackChannel(r.transport)),
			ownerUserId: "UOWN",
			now: () => r.clock.ms,
			log: noop,
		});
		await frozen.sweep();
		expect(threadPosts(r)).toHaveLength(2);
		expect(r.reminders).toHaveLength(0);
		await r.sweeper.sweep();
		expect(r.reminders).toHaveLength(2);
	});
});

describe("taskChangedPaths", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function repoOn(branch: string): string {
		const repo = mkdtempSync(join(tmpdir(), "ompbot-overlap-"));
		roots.push(repo);
		gitFixture(repo, "init", "-q", "-b", branch);
		writeFileSync(join(repo, "README.md"), "hello\n");
		gitFixture(repo, "add", "README.md");
		gitFixture(repo, "commit", "-q", "-m", "init");
		return repo;
	}

	/** On a task branch: one committed file, one modified tracked file, one untracked file, one docs/tasks file. */
	function work(repo: string): void {
		gitFixture(repo, "checkout", "-q", "-b", "task/T-1");
		mkdirSync(join(repo, "src"));
		writeFileSync(join(repo, "src", "a.ts"), "a\n");
		gitFixture(repo, "add", "src/a.ts");
		gitFixture(repo, "commit", "-q", "-m", "a");
		writeFileSync(join(repo, "README.md"), "changed\n");
		writeFileSync(join(repo, "new file.txt"), "n\n");
		mkdirSync(join(repo, "docs", "tasks", "T-1"), { recursive: true });
		writeFileSync(join(repo, "docs", "tasks", "T-1", "PROGRESS.md"), "p\n");
	}

	test("AC-4b: a repository without main falls back to master", async () => {
		const repo = repoOn("master");
		work(repo);
		expect(await taskChangedPaths(repo, realProcessRunner)).toEqual({
			ok: true,
			paths: ["README.md", "new file.txt", "src/a.ts"],
		});
	});

	test("AC-4b: a clone uses origin/HEAD before main or master", async () => {
		const upstream = repoOn("trunk");
		const clone = mkdtempSync(join(tmpdir(), "ompbot-overlap-clone-"));
		roots.push(clone);
		rmSync(clone, { recursive: true, force: true });
		gitFixture(tmpdir(), "clone", "-q", upstream, clone);
		work(clone);
		expect(await taskChangedPaths(clone, realProcessRunner)).toEqual({
			ok: true,
			paths: ["README.md", "new file.txt", "src/a.ts"],
		});
	});

	test("AC-4b: no base branch at all is a failure with a reason", async () => {
		const repo = repoOn("trunk");
		work(repo);
		const result = await taskChangedPaths(repo, realProcessRunner);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe("no_base_branch");
	});
});

describe("TaskSweeper: the resumed agent's restated line", () => {
	const RESTATED = "로그 회전 / S2 회전 구현 / bun test 통과";
	const MISSING = "⚠️ 재개 뒤 PROGRESS는 갱신됐지만 재개 이해(restated)가 없습니다";
	const texts = (r: Rig): string[] => posts(r).map((post) => ("text" in post ? post.text : ""));
	/** Marks a resume at `at` the way `resumeTask` does, with the `restated` value PROGRESS.md had then. */
	const resumeAt = (r: Rig, at: number, before: string): void => {
		r.ledger.recordNotice(r.row.taskId, `resume:${at}`);
		r.ledger.recordNotice(r.row.taskId, `restated-before:${at}:${restatedHash(before)}`);
	};

	test("a new value is posted once; the same value never again; a changed one once more", async () => {
		const r = rig();
		r.next.value = { ok: true, judgement: judgement({ restated: RESTATED }) };
		await r.sweeper.sweep();
		expect(texts(r)).toEqual([`🔁 재개 이해: ${RESTATED}`]);
		expect(r.ledger.require(r.row.taskId).notices).toHaveProperty(`restated:${restatedHash(RESTATED)}`);
		await r.sweeper.sweep();
		expect(texts(r)).toHaveLength(1);
		r.next.value = { ok: true, judgement: judgement({ restated: "로그 회전 / S3 문서 / guide.md 두 줄" }) };
		await r.sweeper.sweep();
		await r.sweeper.sweep();
		expect(texts(r)).toEqual([`🔁 재개 이해: ${RESTATED}`, "🔁 재개 이해: 로그 회전 / S3 문서 / guide.md 두 줄"]);
	});

	test("a failed post records nothing and the next sweep posts it", async () => {
		const warns: Array<[string, Record<string, unknown> | undefined]> = [];
		const r = rig({ log: { info() {}, warn: (event, fields) => warns.push([event, fields]) } });
		r.next.value = { ok: true, judgement: judgement({ restated: RESTATED }) };
		r.transport.failNext.postMessage = [new Error("rate_limited")];
		const attempts = () => texts(r).filter((text) => text === `🔁 재개 이해: ${RESTATED}`).length;
		await r.sweeper.sweep();
		expect(attempts()).toBe(1); // the fake records the call it then fails
		expect(Object.keys(r.ledger.require(r.row.taskId).notices).some((key) => key.startsWith("restated:"))).toBe(false);
		expect(
			warns.some(([event, fields]) => event === "task_restated_post_failed" && fields?.task === r.row.taskId),
		).toBe(true);
		await r.sweeper.sweep();
		expect(attempts()).toBe(2);
		expect(r.ledger.require(r.row.taskId).notices).toHaveProperty(`restated:${restatedHash(RESTATED)}`);
		await r.sweeper.sweep();
		expect(attempts()).toBe(2);
	});

	test("PROGRESS updated after a resume without a restated line: one warning per resume", async () => {
		const r = rig();
		const resumed = T0 + 10 * MIN;
		resumeAt(r, resumed, "");
		r.clock.ms = T0 + 20 * MIN;
		r.next.value = { ok: true, judgement: judgement({ updatedAtMs: T0 + 15 * MIN }) };
		await r.sweeper.sweep();
		await r.sweeper.sweep();
		expect(texts(r)).toEqual([MISSING]);
		expect(r.ledger.require(r.row.taskId).notices).toHaveProperty(`restated-missing:${resumed}`);
		// The next resume is a new chance to write it, and a new warning when it is skipped again.
		const again = T0 + 30 * MIN;
		resumeAt(r, again, "");
		r.clock.ms = T0 + 40 * MIN;
		r.next.value = { ok: true, judgement: judgement({ updatedAtMs: T0 + 35 * MIN }) };
		await r.sweeper.sweep();
		expect(texts(r)).toEqual([MISSING, MISSING]);
	});

	test("restated left as it was before the resume is missing too; a new one is not", async () => {
		const r = rig();
		const OLD = "로그 회전 / S1 / 테스트";
		r.ledger.recordNotice(r.row.taskId, `restated:${restatedHash(OLD)}`); // posted before the resume
		resumeAt(r, T0 + 10 * MIN, OLD);
		r.clock.ms = T0 + 20 * MIN;
		r.next.value = { ok: true, judgement: judgement({ updatedAtMs: T0 + 15 * MIN, restated: OLD }) };
		await r.sweeper.sweep();
		expect(texts(r)).toEqual([MISSING]);

		const fresh = rig();
		resumeAt(fresh, T0 + 10 * MIN, OLD);
		fresh.clock.ms = T0 + 20 * MIN;
		fresh.next.value = { ok: true, judgement: judgement({ updatedAtMs: T0 + 15 * MIN, restated: RESTATED }) };
		await fresh.sweeper.sweep();
		expect(texts(fresh)).toEqual([`🔁 재개 이해: ${RESTATED}`]);
	});

	test("no warning before PROGRESS moves past the resume, or without any resume", async () => {
		const r = rig();
		resumeAt(r, T0 + 10 * MIN, "");
		r.clock.ms = T0 + 20 * MIN;
		r.next.value = { ok: true, judgement: judgement({ updatedAtMs: T0 + 10 * MIN }) };
		await r.sweeper.sweep();
		expect(texts(r)).toEqual([]);

		const never = rig();
		never.next.value = { ok: true, judgement: judgement({ updatedAtMs: T0 + 15 * MIN }) };
		never.clock.ms = T0 + 20 * MIN;
		await never.sweeper.sweep();
		expect(texts(never)).toEqual([]);
	});

	test("a resume known only from the ledger's resume dispatch transition counts too", async () => {
		const r = rig();
		r.ledger.transition(r.row.taskId, "blocked", "bot", "PROGRESS status: blocked");
		r.clock.ms = T0 + 10 * MIN;
		r.ledger.transition(r.row.taskId, "working", "bot", "resume dispatch");
		r.clock.ms = T0 + 20 * MIN;
		r.next.value = { ok: true, judgement: judgement({ updatedAtMs: T0 + 15 * MIN }) };
		await r.sweeper.sweep();
		expect(texts(r)).toEqual([MISSING]);
		expect(r.ledger.require(r.row.taskId).notices).toHaveProperty(`restated-missing:${T0 + 10 * MIN}`);
	});
});
