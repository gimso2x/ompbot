import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tasksCommand } from "../src/cli/tasks";
import { Daemon } from "../src/daemon/daemon";
import {
	HERDR_INTERRUPT_WAIT_MS,
	type HerdrAgentStatusResult,
	herdrInterruptAgent,
	type ProcessRunner,
	type RunProcessResult,
} from "../src/dispatch/omp";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import type { TaskJudgement } from "../src/tasks/checker";
import { acceptanceItems } from "../src/tasks/docs";
import type { TaskEvaluation } from "../src/tasks/evaluate";
import { TaskLedger, type TaskRow } from "../src/tasks/ledger";
import { STALE_NOTICE_MS, type TaskSweepDeps, TaskSweeper } from "../src/tasks/sweeper";
import { localIso } from "../src/time";
import { makeHome, OWNER, type TestHome, WaitingTransport } from "./helpers/bot-home";
import { registryOf } from "./helpers/channels";
import { makeRepo } from "./helpers/git-fixtures";
import { removeRepoAndWorktrees } from "./helpers/lane-harness";
import { type FakeCall, FakeSlackTransport } from "./helpers/slack-fake-transport";

// herdr TASK pause (doc/plans/lane-task-parity.md E절): the pause lives in the ledger's notices as `pause:<ms>` /
// `unpause:<ms>` marks, the sweep holds every prompt and the stale notice of a paused task (judging goes on), the
// worker gets an Esc and only a re-read herdr state reports it stopped.

const T0 = Date.parse("2026-11-10T06:00:00Z");
const MIN = 60_000;

function judgement(over: Partial<TaskJudgement> = {}): TaskJudgement {
	return {
		reached: false,
		acChecked: 0,
		acTotal: 2,
		stepsDone: 0,
		stepsTotal: 1,
		status: "working",
		updatedAt: localIso(T0, "Asia/Seoul"),
		updatedAtMs: T0,
		specChanged: false,
		specKey: "spec1",
		blocked: false,
		needsOwner: false,
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

const PASSED = [{ id: "AC-2", signal: 'command ["bun","test"]', ok: true, detail: "exit 0" }];
const reached = (): TaskJudgement =>
	judgement({
		reached: true,
		acChecked: 2,
		evidence: { "AC-1": ["commit abc1234 feat"], "AC-2": ["test bun test → 5 pass"] },
		summary: ["로그 회전", "bun test 5 pass"],
		checks: PASSED,
	});

interface Rig {
	sweeper: TaskSweeper;
	ledger: TaskLedger;
	transport: FakeSlackTransport;
	clock: { ms: number };
	row: TaskRow;
	next: { value: TaskEvaluation };
	reminders: string[];
	agent: { value: HerdrAgentStatusResult };
	autoLands: { count: number };
	infos: string[];
}

function rig(over: Partial<TaskSweepDeps> = {}): Rig {
	const clock = { ms: T0 };
	const ledger = new TaskLedger(new Database(":memory:", { strict: true }), {
		timezone: "Asia/Seoul",
		clock: { now: () => clock.ms },
	});
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
	const agent: { value: HerdrAgentStatusResult } = { value: { ok: true, status: "idle" } };
	const autoLands = { count: 0 };
	const infos: string[] = [];
	const deps: TaskSweepDeps = {
		ledger,
		evaluate: async () => next.value,
		remind: async (_row, text) => {
			reminders.push(text);
			return { ok: true };
		},
		agentStatus: async () => agent.value,
		readAgent: async () => ({ ok: true, output: "" }),
		channels: registryOf(new SlackChannel(transport)),
		ownerUserId: "UOWN",
		now: () => clock.ms,
		log: { info: (event) => infos.push(event), warn() {} },
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
		agent,
		autoLands,
		infos,
	};
}

const posts = (r: Rig) => r.transport.calls.filter((c) => c.method === "postMessage");
const postText = (post: FakeCall | undefined): string => JSON.stringify(post ?? null);

describe("ledger pause marks", () => {
	test("pause/unpause write notice marks; the larger mark wins, also within one millisecond", () => {
		const r = rig();
		const id = r.row.taskId;
		expect(r.ledger.isPaused(r.ledger.require(id))).toBe(false);
		r.ledger.pauseTask(id);
		expect(r.ledger.isPaused(r.ledger.require(id))).toBe(true);
		expect(Object.keys(r.ledger.require(id).notices).some((key) => key.startsWith("pause:"))).toBe(true);
		r.ledger.unpauseTask(id);
		expect(r.ledger.isPaused(r.ledger.require(id))).toBe(false);
		// Same clock millisecond: a pause right after an unpause still pauses.
		r.ledger.pauseTask(id);
		expect(r.ledger.isPaused(r.ledger.require(id))).toBe(true);
		// Status, history and the other columns are untouched.
		expect(r.ledger.require(id).status).toBe("working");
		expect(r.ledger.history(id)).toHaveLength(1);
	});

	test("only working or blocked tasks pause; getByThread lists a thread's tasks", () => {
		const r = rig();
		r.ledger.transition(r.row.taskId, "review", "bot");
		expect(() => r.ledger.pauseTask(r.row.taskId)).toThrow();
		const other = r.ledger.register({
			title: "둘째",
			risk: "L1",
			originKey: "slack/ch/C1/t/100.1",
			threadRef: "C1:100.1",
			host: null,
			repo: "/r/repo",
			acceptance: acceptanceItems(["x"]),
		});
		r.ledger.transition(other.taskId, "blocked", "bot");
		r.ledger.pauseTask(other.taskId);
		expect(r.ledger.isPaused(r.ledger.require(other.taskId))).toBe(true);
		expect(r.ledger.getByThread("C1:100.1").map((row) => row.taskId)).toEqual([r.row.taskId, other.taskId]);
		expect(r.ledger.getByThread("C1:999.9")).toEqual([]);
	});
});

describe("the sweep holds a paused task (AC-1)", () => {
	test("30-minute reminder and 2-hour stale notice: none while paused; after unpause the same sweep sends them", async () => {
		const r = rig();
		r.ledger.pauseTask(r.row.taskId);
		r.clock.ms = T0 + STALE_NOTICE_MS + 5 * MIN;
		await r.sweeper.sweep();
		await r.sweeper.sweep();
		expect(r.reminders).toEqual([]);
		expect(posts(r)).toHaveLength(0);
		expect(r.infos.filter((event) => event === "task_remind_paused")).toHaveLength(1);
		// Judging went on.
		expect(r.ledger.require(r.row.taskId).progressAt).toBe(T0);

		r.ledger.unpauseTask(r.row.taskId);
		await r.sweeper.sweep();
		expect(r.reminders).toHaveLength(1);
		expect(r.reminders[0]).toContain("PROGRESS.md가");
		expect(posts(r).filter((post) => postText(post).includes("갱신"))).toHaveLength(1);
	});

	test("unmet-condition nudge: none while paused; after unpause it goes out", async () => {
		const r = rig();
		r.next.value = { ok: true, judgement: judgement({ problems: ["AC-1: outcome.md에 절이 없습니다"] }) };
		r.ledger.pauseTask(r.row.taskId);
		await r.sweeper.sweep();
		expect(r.reminders).toEqual([]);
		r.ledger.unpauseTask(r.row.taskId);
		await r.sweeper.sweep();
		expect(r.reminders).toHaveLength(1);
		expect(r.reminders[0]).toContain("AC-1: outcome.md에 절이 없습니다");
	});

	test("a reach while paused: no auto-merge, the 머지 card names `멈춤 중`; unpaused the same reach auto-merges", async () => {
		const policyDeps = (r: { autoLands: { count: number } }): Partial<TaskSweepDeps> => ({
			autoLandPolicy: () => ({ repos: ["/r/repo"], maxRisk: "L2" }),
			repoMatches: async () => true,
			autoLand: async () => {
				r.autoLands.count += 1;
				return true;
			},
		});
		const autoLands = { count: 0 };
		const paused = rig(policyDeps({ autoLands }));
		paused.next.value = { ok: true, judgement: reached() };
		paused.ledger.pauseTask(paused.row.taskId);
		await paused.sweeper.sweep();
		expect(autoLands.count).toBe(0);
		expect(posts(paused)).toHaveLength(1);
		expect(postText(posts(paused)[0])).toContain("멈춤 중");
		expect(postText(posts(paused)[0])).toContain("ompbot:task:merge:");
		expect(paused.reminders).toEqual([]);

		// Paused while this very sweep judged it (the checks can take minutes): still held.
		const pauseDuringJudging: { ledger?: TaskLedger } = {};
		const late = rig({
			...policyDeps({ autoLands }),
			evaluate: async (row) => {
				pauseDuringJudging.ledger?.pauseTask(row.taskId);
				return { ok: true, judgement: reached() };
			},
		});
		pauseDuringJudging.ledger = late.ledger;
		await late.sweeper.sweep();
		expect(autoLands.count).toBe(0);
		expect(postText(posts(late)[0])).toContain("멈춤 중");

		const free = rig(policyDeps({ autoLands }));
		free.next.value = { ok: true, judgement: reached() };
		await free.sweeper.sweep();
		expect(autoLands.count).toBe(1);
		expect(postText(posts(free)[0])).not.toContain("멈춤 중");
	});
});

describe("the file-overlap prompt skips a paused task", () => {
	test("both tasks hear of the overlap in their threads; only the unpaused agent is prompted", async () => {
		const prompted: string[] = [];
		const r = rig({
			changedPaths: async () => ["src/a.ts"],
			remind: async (row) => {
				prompted.push(row.taskId);
				return { ok: true };
			},
		});
		const other = r.ledger.register({
			title: "둘째",
			risk: "L2",
			originKey: "slack/ch/C1/t/200.1",
			threadRef: "C1:200.1",
			host: null,
			repo: "/r/repo",
			acceptance: acceptanceItems(["x"]),
		});
		r.ledger.pauseTask(r.row.taskId);
		await r.sweeper.sweep();
		expect(prompted).toEqual([other.taskId]);
		expect(posts(r).filter((post) => postText(post).includes("파일 겹침"))).toHaveLength(2);
	});
});

describe("WORKING-WHILE-PAUSED (AC-4)", () => {
	test("a paused task whose agent is herdr-working: one warning per pause, never a prompt", async () => {
		const r = rig();
		r.agent.value = { ok: true, status: "working" };
		r.ledger.pauseTask(r.row.taskId);
		const warnings = () => posts(r).filter((post) => postText(post).includes("멈춘 TASK"));
		// The pause's own Esc may still be waiting for the agent: no warning yet.
		r.clock.ms += HERDR_INTERRUPT_WAIT_MS;
		await r.sweeper.sweep();
		expect(warnings()).toHaveLength(0);
		r.clock.ms += 1;
		await r.sweeper.sweep();
		await r.sweeper.sweep();
		expect(warnings()).toHaveLength(1);
		expect(r.reminders).toEqual([]);
		// A new pause is a new warning.
		r.ledger.unpauseTask(r.row.taskId);
		r.clock.ms += MIN;
		r.ledger.pauseTask(r.row.taskId);
		r.clock.ms += MIN;
		await r.sweeper.sweep();
		expect(warnings()).toHaveLength(2);
		// Idle again: nothing more.
		r.agent.value = { ok: true, status: "idle" };
		await r.sweeper.sweep();
		expect(warnings()).toHaveLength(2);
	});

	test("an unpaused working agent gets no warning", async () => {
		const r = rig();
		r.agent.value = { ok: true, status: "working" };
		await r.sweeper.sweep();
		expect(posts(r).filter((post) => postText(post).includes("멈춘 TASK"))).toHaveLength(0);
	});
});

describe("herdrInterruptAgent (AC-3)", () => {
	const WAIT = [
		"agent",
		"wait",
		"t-1",
		"--until",
		"idle",
		"--until",
		"done",
		"--until",
		"blocked",
		"--timeout",
		"15000",
	];

	function fakeHerdr(answer: { list?: RunProcessResult; wait?: RunProcessResult; sendKeys?: RunProcessResult }) {
		const calls: string[][] = [];
		const run: ProcessRunner = async (cmd) => {
			calls.push(cmd);
			const verb = cmd.includes("'send-keys'") || cmd.includes("send-keys") ? "send-keys" : undefined;
			if (verb !== undefined) return answer.sendKeys ?? { code: 0, stdout: "", timedOut: false };
			if (cmd.includes("wait") || cmd.includes("'wait'"))
				return answer.wait ?? { code: 0, stdout: "", timedOut: false };
			return answer.list ?? { code: 0, stdout: JSON.stringify({ result: { agents: [] } }), timedOut: false };
		};
		return { calls, run };
	}
	const listing = (status: string): RunProcessResult => ({
		code: 0,
		stdout: JSON.stringify({ result: { agents: [{ name: "t-1", pane_id: "p1", agent_status: status }] } }),
		timedOut: false,
	});

	test.each(["idle", "done", "blocked"])("re-read %s: send-keys esc → wait → list, confirmed", async (status) => {
		const h = fakeHerdr({ list: listing(status) });
		const result = await herdrInterruptAgent("t-1", { run: h.run, herdrBin: "herdr" });
		expect(h.calls).toEqual([
			["herdr", "agent", "send-keys", "t-1", "esc"],
			["herdr", ...WAIT],
			["herdr", "agent", "list"],
		]);
		expect(result.confirmed).toBe(true);
		expect<string | undefined>(result.status).toBe(status);
		expect(result.text).toContain("멈춤을 확인했습니다");
		expect(result.text).not.toContain("확인하지 못했습니다");
	});

	test.each([
		["working", listing("working")],
		["unknown", listing("unknown")],
		["gone", { code: 0, stdout: JSON.stringify({ result: { agents: [] } }), timedOut: false }],
		["read failure", { code: 1, stdout: "", stderr: "boom", timedOut: false }],
		["unparsable list", { code: 0, stdout: "not json", timedOut: false }],
	] as Array<[string, RunProcessResult]>)("re-read %s: not confirmed", async (_name, list) => {
		const h = fakeHerdr({ list, wait: { code: 1, stdout: "", stderr: "timeout", timedOut: false } });
		const result = await herdrInterruptAgent("t-1", { run: h.run, herdrBin: "herdr" });
		expect(h.calls).toEqual([
			["herdr", "agent", "send-keys", "t-1", "esc"],
			["herdr", ...WAIT],
			["herdr", "agent", "list"],
		]);
		expect(result.confirmed).toBe(false);
		expect(result.text).toContain("확인하지 못했습니다");
		expect(result.text).not.toContain("멈춤을 확인했습니다");
	});

	test("a refused send-keys is not confirmed and never prompts", async () => {
		const h = fakeHerdr({ sendKeys: { code: 1, stdout: "", stderr: "no such agent", timedOut: false } });
		const result = await herdrInterruptAgent("t-1", { run: h.run, herdrBin: "herdr" });
		expect(result.confirmed).toBe(false);
		expect(result.text).toContain("확인하지 못했습니다");
		expect(h.calls.some((cmd) => cmd.some((arg) => arg.includes("prompt")))).toBe(false);
	});

	test("never `agent prompt`, in any case", async () => {
		for (const status of ["idle", "working", "gone"]) {
			const h = fakeHerdr({ list: listing(status) });
			await herdrInterruptAgent("t-1", { run: h.run, herdrBin: "herdr" });
			expect(h.calls.some((cmd) => cmd.some((arg) => arg.includes("prompt")))).toBe(false);
		}
	});

	test("a remote host runs the same three calls as ssh arguments after `--`", async () => {
		const h = fakeHerdr({ list: listing("idle") });
		const result = await herdrInterruptAgent("t-1", { run: h.run, sshTarget: "wsl-ssh" });
		const ssh = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "--", "wsl-ssh"];
		const quoted = (args: string[]) => args.map((arg) => `'${arg}'`);
		expect(h.calls).toEqual([
			[...ssh, ...quoted(["herdr", "agent", "send-keys", "t-1", "esc"])],
			[...ssh, ...quoted(["herdr", ...WAIT])],
			[...ssh, ...quoted(["herdr", "agent", "list"])],
		]);
		expect(result.confirmed).toBe(true);
	});
});

describe("pause from the task thread and the CLI (AC-2)", () => {
	let home: TestHome;
	let daemon: Daemon;
	let transport: WaitingTransport;
	let drivers: Map<string, FakeOmpDriver>;
	let herdrCalls: string[][];
	let agentStatus: Map<string, string>;
	let repos: string[];

	beforeEach(async () => {
		home = makeHome("ompbot-task-pause-");
		transport = new WaitingTransport();
		drivers = new Map();
		herdrCalls = [];
		agentStatus = new Map();
		repos = [];
		const sessions = new FakeSessionStore();
		daemon = new Daemon({
			config: { ...home.config, herdr: {} },
			herdrRun: async (cmd) => {
				herdrCalls.push(cmd);
				if (cmd[1] === "agent" && cmd[2] === "list") {
					const agents = [...agentStatus].map(([name, agent_status]) => ({ name, pane_id: `p-${name}`, agent_status }));
					return { code: 0, stdout: JSON.stringify({ result: { agents } }), timedOut: false };
				}
				return { code: 0, stdout: "", timedOut: false };
			},
			channels: [new SlackBinding(new SlackChannel(transport))],
			log: createLogger({ sink: () => undefined, clock: { now: () => Date.now() }, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			stopDrainMs: 10,
			driverFactory: (origin, sessionDir) => {
				const driver = new FakeOmpDriver({ sessionDir, store: sessions, holdTurns: true });
				drivers.set(origin, driver);
				return driver;
			},
		});
		await daemon.start();
	});

	afterEach(async () => {
		await daemon.stop();
		home.remove();
		for (const repo of repos) removeRepoAndWorktrees(repo);
	});

	const seed = (threadTs: string, title = "로그 회전"): TaskRow => {
		const row = daemon.store.tasks.register({
			title,
			risk: "L2",
			originKey: `slack/dm/D1/t/${threadTs}`,
			threadRef: `D1:${threadTs}`,
			host: null,
			repo: "/r/repo",
			acceptance: acceptanceItems(["하나"]),
		});
		agentStatus.set(row.agent, "idle");
		return row;
	};
	const ownerMessage = (text: string, ts: string, threadTs: string) =>
		transport.emitMessage({
			type: "message",
			channel: "D1",
			channel_type: "im",
			user: OWNER,
			text,
			ts,
			thread_ts: threadTs,
		});
	const paused = (id: string) => daemon.store.tasks.isPaused(daemon.store.tasks.require(id));
	const sentKeys = () => herdrCalls.filter((cmd) => cmd.includes("send-keys"));
	const prompted = () => herdrCalls.filter((cmd) => cmd.includes("prompt"));

	test("`멈춰` in a thread with one active task pauses only it, sends one Esc, never reaches omp; `계속` resumes it", async () => {
		const mine = seed("1700.000100");
		const other = seed("1700.000200", "다른 일");
		// A running lane elsewhere is left alone.
		const repo = makeRepo(repos);
		await daemon.inject({ origin: "slack/dm/D1", asOwner: true, text: `작업: side-lane @${repo}` });
		await transport.waitForPosts((text) => text.includes("작업 레인 `side-lane`을 시작했습니다"));

		await ownerMessage("멈춰", "1700.000300", "1700.000100");
		await transport.waitForPosts((text) => text.includes("멈췄습니다") && text.includes(mine.taskId));
		expect(paused(mine.taskId)).toBe(true);
		expect(paused(other.taskId)).toBe(false);
		const row = daemon.store.getInbound("D1:1700.000300");
		expect(row?.state).toBe("answered");
		expect(row?.opRef).toStartWith("task:");
		expect(drivers.get(`slack/dm/D1/t/1700.000100`)).toBeUndefined();
		expect(sentKeys()).toEqual([["herdr", "agent", "send-keys", mine.agent, "esc"]]);
		expect(prompted()).toEqual([]);
		const answer = transport.posts((text) => text.includes(mine.taskId) && text.includes("멈췄습니다"))[0];
		expect(answer?.text).toContain("멈춤을 확인했습니다");
		expect(daemon.store.getLane("side-lane")?.status).toBe("working");
		expect(drivers.get("ompbot/work/side-lane")?.calls.includes("abort")).toBe(false);

		await ownerMessage("계속", "1700.000400", "1700.000100");
		await transport.waitForPosts((text) => text.includes("재개했습니다") && text.includes(mine.taskId));
		expect(paused(mine.taskId)).toBe(false);
		expect(daemon.store.getInbound("D1:1700.000400")?.opRef).toStartWith("task:");
		expect(prompted()).toEqual([]);
	});

	test("a thread with two active tasks pauses nothing and answers both ids", async () => {
		const a = seed("1700.000100");
		const b = seed("1700.000100", "둘째");
		await ownerMessage("멈춰", "1700.000300", "1700.000100");
		await transport.waitForPosts((text) => text.includes(a.taskId) && text.includes(b.taskId));
		expect(paused(a.taskId)).toBe(false);
		expect(paused(b.taskId)).toBe(false);
		expect(sentKeys()).toEqual([]);
		expect(daemon.store.getInbound("D1:1700.000300")?.opRef).toStartWith("task:");
	});

	test("a worker still herdr-working after the Esc: the sweep hold stands, the answer does not claim it stopped", async () => {
		const mine = seed("1700.000100");
		agentStatus.set(mine.agent, "working");
		const answer = await daemon.controlTask(mine.taskId, "pause");
		expect(answer.ok).toBe(true);
		expect(paused(mine.taskId)).toBe(true);
		expect(answer.text).toContain("확인하지 못했습니다(herdr 상태: working)");
		expect(answer.text).not.toContain("⏸");
		expect(prompted()).toEqual([]);
	});

	test("`ompbot tasks pause|resume <id>` does the same through the daemon", async () => {
		const mine = seed("1700.000100");
		const other = seed("1700.000200", "다른 일");
		expect(await tasksCommand(["pause", mine.taskId], home.dir)).toBe(0);
		expect(paused(mine.taskId)).toBe(true);
		expect(paused(other.taskId)).toBe(false);
		expect(sentKeys()).toEqual([["herdr", "agent", "send-keys", mine.agent, "esc"]]);
		expect(await tasksCommand(["resume", mine.taskId], home.dir)).toBe(0);
		expect(paused(mine.taskId)).toBe(false);
		expect(prompted()).toEqual([]);
		// A task in review is not paused.
		daemon.store.tasks.transition(other.taskId, "review", "bot");
		expect(await tasksCommand(["pause", other.taskId], home.dir)).toBe(1);
		expect(paused(other.taskId)).toBe(false);
	});
});
