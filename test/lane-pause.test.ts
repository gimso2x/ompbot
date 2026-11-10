import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openBotStore } from "../src/core/origin";
import { Daemon, PENDING_ALERT_AFTER } from "../src/daemon/daemon";
import { classifyLaneControl } from "../src/lanes/control";
import { laneLandBlockers } from "../src/lanes/land";
import { CLAIM_GRACE_MS, PROGRESS_INTERVAL_MS } from "../src/lanes/manager";
import type { LaneRow } from "../src/lanes/status";
import type { VerifyResult } from "../src/lanes/verify";
import { createLogger } from "../src/log";
import type { OmpState } from "../src/omp/driver";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { collectGates, LANE_STUCK_MS, ORIGIN_SILENT_MS } from "../src/ops/gates";
import { redact } from "../src/redact";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import { makeHome, OWNER, type TestHome, WaitingTransport } from "./helpers/bot-home";
import { git, makeRepo } from "./helpers/git-fixtures";
import { LANE_START, laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

// Lane pause/resume (doc/plans/lane-task-parity.md D절): the code — never a model — decides from an exact phrase
// match, the registry row `paused` is the single source of the hold, the turn is aborted and only a re-read state
// (registry paused · no turn · omp settled) is reported as stopped. Everything git-related stays on this machine.

const clock = { now: () => Date.now() };

let home: TestHome;
let repos: string[];
let scratch: string[];

beforeEach(() => {
	home = makeHome("ompbot-lane-pause-home-");
	repos = [];
	scratch = [];
});

afterEach(() => {
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** Resolves once `cond` holds; microtask polling only (a settle bound, never a fixed wait). */
async function until(cond: () => boolean, tries = 200): Promise<void> {
	for (let i = 0; !cond() && i < tries; i++) await Promise.resolve();
	expect(cond()).toBeTrue();
}

/** A driver whose omp never settles: abort lands but `state()` keeps reporting a queued message starting a turn. */
class NeverSettledDriver extends FakeOmpDriver {
	async state(): Promise<OmpState> {
		const base = await super.state();
		return { ...base, idle: true, settled: false, queuedMessageCount: 1 };
	}
}

describe("classifyLaneControl: exact phrase match only (AC-1)", () => {
	test("the listed phrases pause (whitespace, trailing .!?~, case-insensitive)", () => {
		for (const text of [
			"멈춰",
			"멈춰줘",
			"멈춰봐",
			"잠깐",
			"잠깐만",
			"잠시만",
			"그만",
			"그만해",
			"일시정지",
			"중단",
			"중지",
			"stop",
			"pause",
			"!pause",
			"멈춰?",
			"잠깐?",
			"잠시만!",
			"그만해.",
			"STOP",
			"Pause~",
			"  멈춰  ",
			"중단!",
		]) {
			expect(classifyLaneControl(text)).toBe("pause");
		}
	});

	test("the listed phrases resume", () => {
		for (const text of ["계속", "계속해", "계속해줘", "재개", "재개해", "continue", "!unpause", "계속!", "CONTINUE"]) {
			expect(classifyLaneControl(text)).toBe("resume");
		}
	});

	test("anything else is an ordinary message, not a control", () => {
		for (const text of [
			"잠깐 이거 확인해줘",
			"멈추지 말고 계속 해",
			"멈춰야 하나?",
			"!resume",
			"",
			"   ",
			"!pause now",
			"멈춰 주세요",
			"잠깐만요",
			"resume",
			"unpause",
			"계속 가자",
			"그만두기 전에 이것도",
		]) {
			expect(classifyLaneControl(text)).toBeUndefined();
		}
	});
});

describe("lanes inside the daemon: pause settles in the core (AC-2, AC-4, AC-5, AC-7)", () => {
	let daemons: Daemon[];
	let drivers: Map<string, FakeOmpDriver>;
	let transport: WaitingTransport;
	let sessions: FakeSessionStore;
	let logs: string[];

	beforeEach(() => {
		daemons = [];
		drivers = new Map();
		transport = new WaitingTransport();
		sessions = new FakeSessionStore();
		logs = [];
	});

	afterEach(async () => {
		for (const daemon of daemons) await daemon.stop();
	});

	async function startDaemon(
		options: { hold?: boolean; pendingRetryMs?: number; clock?: { now(): number } } = {},
	): Promise<Daemon> {
		const daemon = new Daemon({
			config: home.config,
			...(options.pendingRetryMs === undefined ? {} : { pendingRetryMs: options.pendingRetryMs }),
			...(options.clock === undefined ? {} : { clock: options.clock }),
			channels: [new SlackBinding(new SlackChannel(transport))],
			log: createLogger({ sink: (line) => logs.push(line), clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			stopDrainMs: 10,
			driverFactory: (origin, sessionDir) => {
				const driver = new FakeOmpDriver({
					sessionDir,
					store: sessions,
					...(options.hold === true ? { holdTurns: true } : {}),
				});
				drivers.set(origin, driver);
				return driver;
			},
		});
		daemons.push(daemon);
		await daemon.start();
		return daemon;
	}

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

	/** A lane whose first turn is held (the daemon's fake omp keeps it running until aborted). */
	async function heldLane(title: string, daemon: Daemon): Promise<{ lane: LaneRow; rootTs: string }> {
		const repo = makeRepo(repos);
		await daemon.inject({ origin: "slack/dm/D1", asOwner: true, text: `작업: ${title} @${repo}` });
		await transport.waitForPosts((text) => text.includes(`작업 레인 \`${title}\`을 시작했습니다`));
		const root = transport.posts((text) => text === `🔄 ${title}`)[0];
		expect(root).toBeDefined();
		await until(
			() =>
				(drivers.get(`ompbot/work/${title}`)?.calls.filter((call) => call.startsWith("prompt:")) ?? []).length === 1,
		);
		const lane = daemon.store.getLane(title);
		expect(lane?.status).toBe("working");
		return { lane: lane as LaneRow, rootTs: root?.ts ?? "" };
	}

	test("`멈춰` in a running lane settles as `lane:` without reaching omp; the turn aborts once; the answer reports the re-read state (AC-2)", async () => {
		const daemon = await startDaemon({ hold: true });
		const { lane, rootTs } = await heldLane("pause-me", daemon);
		const origin = lane.originKey;

		await ownerMessage("멈춰", "1900000000.000100", rootTs);
		await transport.waitForPosts((text) => text.includes("멈췄습니다"));

		const row = daemon.store.getInbound("D1:1900000000.000100");
		expect(row).toMatchObject({ originKey: origin, state: "answered" });
		expect(row?.opRef).toStartWith("lane:");
		const after = daemon.store.getLane("pause-me");
		expect(after?.status).toBe("paused");
		expect(after?.meta.pausedFrom).toBe("working");
		expect(after?.meta.pausedBy).toBe("owner-message");
		expect(after?.meta.pausedAt).toBeNumber();
		// omp saw neither the text nor a steer; the running turn was aborted exactly once and settled.
		const driver = drivers.get(origin);
		expect(driver?.calls.filter((call) => call.startsWith("prompt:"))).toHaveLength(1);
		expect(driver?.calls.some((call) => call.startsWith("steer:"))).toBe(false);
		expect(driver?.calls.filter((call) => call === "abort")).toHaveLength(1);
		expect((await driver?.state())?.settled).toBe(true);
		// No failure notice; the answer states what was re-read after the stop.
		expect(transport.posts((text) => text.includes("[turn failed]"))).toHaveLength(0);
		const answer = daemon.store.listDeliveries({ originKey: origin }).find((delivery) => delivery.opRef === row?.opRef);
		expect(answer?.body).toContain("멈췄습니다");
		expect(answer?.body).toContain("확인");
		expect(answer?.body).toContain("paused");
	});

	test("a held lane's owner messages stay pending with exactly one notice, and survive a daemon restart (AC-4, AC-5)", async () => {
		const first = await startDaemon({ hold: true });
		const { lane, rootTs } = await heldLane("hold-it", first);
		await ownerMessage("멈춰", "1900000000.000100", rootTs);
		await transport.waitForPosts((text) => text.includes("멈췄습니다"));

		await ownerMessage("이거 확인해줘", "1900000000.000200", rootTs);
		await ownerMessage("그리고 이것도", "1900000000.000300", rootTs);
		await until(() => transport.posts((text) => text.includes("전달하지 않았습니다")).length >= 1);
		expect(first.store.getInbound("D1:1900000000.000200")?.state).toBe("pending");
		expect(first.store.getInbound("D1:1900000000.000300")?.state).toBe("pending");
		expect(transport.posts((text) => text.includes("전달하지 않았습니다"))).toHaveLength(1);
		expect(drivers.get(lane.originKey)?.calls.filter((call) => call.startsWith("steer:"))).toHaveLength(0);

		// Restart: the registry row still holds the lane and the pending rows with it.
		await first.stop();
		const second = await startDaemon({ hold: true });
		expect(second.store.getLane("hold-it")?.status).toBe("paused");
		expect(second.store.getInbound("D1:1900000000.000200")?.state).toBe("pending");
		expect(second.store.getInbound("D1:1900000000.000300")?.state).toBe("pending");

		// `계속` delivers the held owner messages into a fresh turn of the same lane session.
		await ownerMessage("계속", "1900000000.000400", rootTs);
		await transport.waitForPosts((text) => text.includes("재개했습니다"));
		expect(second.store.getLane("hold-it")?.status).toBe("working");
		await until(() =>
			(drivers.get(lane.originKey)?.calls.filter((call) => call.startsWith("prompt:")) ?? []).some((call) =>
				call.includes("이거 확인해줘"),
			),
		);
		expect(second.store.getInbound("D1:1900000000.000200")?.state).toBe("dispatched");
		expect(second.store.getInbound("D1:1900000000.000300")?.state).toBe("dispatched");
		const answer = second.store
			.listDeliveries({ originKey: lane.originKey })
			.find((delivery) => delivery.opRef === second.store.getInbound("D1:1900000000.000400")?.opRef);
		expect(answer?.body).toContain("재개했습니다");
	});

	test("a held message is a deliberate wait: no stuck-dispatch alert from the sweep, no origin_silent gate (AC-4)", async () => {
		let now = Date.now();
		const daemon = await startDaemon({ hold: true, pendingRetryMs: 1, clock: { now: () => now } });
		const { rootTs } = await heldLane("quiet-hold", daemon);
		await ownerMessage("멈춰", "1900000000.000100", rootTs);
		await transport.waitForPosts((text) => text.includes("멈췄습니다"));
		await ownerMessage("이거 확인해줘", "1900000000.000200", rootTs);
		await until(() => transport.posts((text) => text.includes("전달하지 않았습니다")).length === 1);
		expect(daemon.store.getInbound("D1:1900000000.000200")?.state).toBe("pending");

		// More sweeps than the alert threshold, each past the retry interval.
		for (let i = 0; i < PENDING_ALERT_AFTER + 2; i++) {
			now += 60_000;
			await daemon.sweep();
			// Let a retry's settle (resumePending → count → notice) run before the next sweep.
			for (let turn = 0; turn < 50; turn++) await Promise.resolve();
		}
		expect(daemon.store.getInbound("D1:1900000000.000200")?.state).toBe("pending");
		expect(transport.posts((text) => text.includes("보내지 못하고"))).toHaveLength(0);
		// Logged synchronously when the retry streak alerts: absent means no retry was counted at all.
		expect(logs.some((line) => line.includes("event=pending_dispatch_notified"))).toBe(false);
		const silent = collectGates({ homeDir: home.dir, now: now + ORIGIN_SILENT_MS + 60_000 }).find(
			(gate) => gate.name === "origin_silent",
		);
		expect(silent?.state).toBe("closed");
	});

	test("the ▶ 재개 button resumes a paused lane from the status message (AC-5)", async () => {
		const daemon = await startDaemon({ hold: true });
		const { lane, rootTs } = await heldLane("button-resume", daemon);
		await ownerMessage("멈춰", "1900000000.000100", rootTs);
		await transport.waitForPosts((text) => text.includes("멈췄습니다"));

		await transport.emitBlockAction({
			user: { id: OWNER },
			channel: { id: "D1" },
			message: { ts: lane.meta.statusTs ?? "" },
			actions: [{ action_id: `ompbot:lane:resume:${lane.name}`, value: lane.name }],
		});
		await transport.waitForPosts((text) => text.includes("재개했습니다"));
		expect(daemon.store.getLane("button-resume")?.status).toBe("working");
		expect(daemon.store.getLane("button-resume")?.meta.pausedFrom).toBeUndefined();
	});

	test("`멈춰` on a closed lane with a pending landing holds only the auto-merge; `머지해` still lands (AC-7)", async () => {
		const repo = makeRepo(repos);
		const daemon = await startDaemon();
		await daemon.inject({ origin: "slack/dm/D1", asOwner: true, text: `작업: hold-merge @${repo}` });
		await transport.waitForPosts((text) => text.includes("작업 레인 `hold-merge`을 시작했습니다"));
		await transport.waitForPosts((text) => text.startsWith("ECHO ulw explore"));
		const lane = daemon.store.getLane("hold-merge");
		expect(lane?.status).toBe("working");
		const root = transport.posts((text) => text === "🔄 hold-merge")[0];
		const base = git(repo, "symbolic-ref", "--short", "HEAD");
		const before = git(repo, "rev-parse", "HEAD");

		// Real work and a real claim: the lane closes with a pending landing and its Outcome card.
		writeFileSync(join(lane?.cwd ?? "", "a.txt"), "a\n");
		git(lane?.cwd ?? "", "add", "--", "a.txt");
		git(lane?.cwd ?? "", "commit", "-q", "-m", "add a.txt");
		const claim = daemon.hostToolsFor(lane?.originKey ?? "").find((tool) => tool.name === "ompbot_claim_done");
		await claim?.execute(
			{ repo: lane?.cwd ?? "", commit: "HEAD", summary: "a.txt 추가" },
			{ signal: new AbortController().signal },
		);
		await transport.waitForPosts((text) => text.includes("🔍 머지 대기"));
		expect(daemon.store.getLane("hold-merge")?.status).toBe("closed");
		expect(daemon.store.getLane("hold-merge")?.meta.land?.state).toBe("pending");

		await ownerMessage("멈춰", "1900000000.000100", root?.ts ?? "");
		await transport.waitForPosts((text) => text.includes("자동 머지"));
		const held = daemon.store.getLane("hold-merge");
		expect(held?.status).toBe("closed"); // never paused
		expect(held?.meta.land?.autoLandHeld).toBe("오너 멈춤");
		expect(laneLandBlockers(held as LaneRow, { repos: [repo], maxRisk: "L2" }, true, false).join(" ")).toContain(
			"오너 멈춤",
		);

		await ownerMessage("머지해", "1900000000.000200", root?.ts ?? "");
		await transport.waitForPosts((text) => text.includes("머지했습니다"));
		const landed = daemon.store.getLane("hold-merge");
		expect(landed?.meta.land?.state).toBe("landed");
		expect(git(repo, "rev-parse", base)).not.toBe(before);
	});
});

describe("pause outcome is the re-read state (manager, AC-3)", () => {
	test("a driver that never settles: the answer says what failed and a repeated `멈춰` retries the abort", async () => {
		const neverSettled = new Map<string, NeverSettledDriver>();
		const h = laneHarness(home.dir, {
			driver: (origin, sessionDir) => {
				const driver = new NeverSettledDriver({ sessionDir, holdTurns: true });
				neverSettled.set(origin, driver);
				return driver;
			},
		});
		const repo = makeRepo(repos);
		const lane = await h.manager.start({ title: "never-settled", cwd: repo, channel: "D1" });
		await h.settle();
		const driver = neverSettled.get(lane.originKey);
		expect(driver).toBeDefined();

		const first = await h.manager.pause(lane.name, "owner-message");
		expect(first.handled).toBe(true);
		expect(first.text).toContain("멈추지 못했습니다");
		expect(first.text).not.toContain("멈췄습니다");
		expect(first.text).toContain("settled");
		// The registry stays paused (every autonomous action already held) and abort ran once.
		expect(h.store.getLane(lane.name)?.status).toBe("paused");
		expect(driver?.calls.filter((call) => call === "abort")).toHaveLength(1);

		const second = await h.manager.pause(lane.name, "owner-message");
		expect(second.text).toContain("멈추지 못했습니다");
		expect(driver?.calls.filter((call) => call === "abort")).toHaveLength(2);
		h.close();
	});
});

describe("while paused, every autonomous action is held (manager, AC-4)", () => {
	test("15 minutes pass without a status edit; the tick judges no claim, lands nothing, steers nothing", async () => {
		let verifyCalls = 0;
		let landCalls = 0;
		const h = laneHarness(home.dir, {
			// The first check cannot finish (git unavailable): the claim is left for the tick to judge after the grace.
			verify: async () => {
				verifyCalls += 1;
				if (verifyCalls === 1) throw new Error("git unavailable");
				return { ok: false, reasons: ["커밋 없음"] };
			},
			land: async () => {
				landCalls += 1;
				return { state: "landed", preSha: "x" };
			},
		});
		const repo = makeRepo(repos);
		const lane = await h.manager.start({ title: "quiet", cwd: repo, channel: "D1" });
		await h.settle();

		await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "a".repeat(40), summary: "x" });
		await h.settle();
		expect(h.store.getLane(lane.name)?.status).toBe("done-claimed");
		expect(verifyCalls).toBe(1); // the claim's own check only; nothing is in flight now

		await h.manager.pause(lane.name, "owner-message");
		await h.settle();
		expect(h.store.getLane(lane.name)?.status).toBe("paused");

		const statusTs = h.store.getLane(lane.name)?.meta.statusTs ?? "";
		const editsOf = () =>
			h.transport.calls.filter((call) => call.method === "updateMessage" && call.ts === statusTs).length;
		const editsBefore = editsOf();
		h.advance(PROGRESS_INTERVAL_MS + 60_000);
		h.advance(CLAIM_GRACE_MS + 60_000);
		await h.manager.tick();
		await h.settle();
		expect(editsOf()).toBe(editsBefore);
		// No verdict, no landing, no steer; the claim waits under the pause.
		expect(verifyCalls).toBe(1);
		expect(landCalls).toBe(0);
		const after = h.store.getLane(lane.name);
		expect(after?.status).toBe("paused");
		expect(after?.meta.pausedFrom).toBe("done-claimed");
		expect(after?.meta.claim?.commit).toBe("a".repeat(40));
		expect(h.steers(lane.originKey)).toHaveLength(0);

		// Control: once the owner resumes, the same tick does judge the claim (so the hold above was the pause).
		await h.manager.resume(lane.name, "owner-message");
		await h.settle();
		h.advance(CLAIM_GRACE_MS + 60_000);
		await h.manager.tick();
		await h.settle();
		expect(verifyCalls).toBe(2);
		expect(h.store.getLane(lane.name)?.status).toBe("not-done");
		h.close();
	});

	test("a not-done verdict that lands while paused steers nothing and transitions nothing", async () => {
		const gate = Promise.withResolvers<VerifyResult>();
		const h = laneHarness(home.dir, { verify: async () => gate.promise });
		const repo = makeRepo(repos);
		const lane = await h.manager.start({ title: "late-notdone", cwd: repo, channel: "D1" });
		await h.settle();
		const settled = h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "a".repeat(40), summary: "x" });
		void settled;
		await until(() => h.store.getLane(lane.name)?.status === "done-claimed");

		await h.manager.pause(lane.name, "owner-message");
		await h.settle();
		gate.resolve({ ok: false, reasons: ["커밋 없음"] });
		await settled;
		await h.settle();
		const after = h.store.getLane(lane.name);
		expect(after?.status).toBe("paused"); // not-done never happened
		expect(after?.meta.pausedFrom).toBe("done-claimed");
		expect(h.steers(lane.originKey)).toHaveLength(0);
		expect(h.prompts(lane.originKey)).toHaveLength(1); // the start prompt only
		h.close();
	});

	test("the lane tools answer a paused notice and record nothing", async () => {
		const h = laneHarness(home.dir);
		const repo = makeRepo(repos);
		const lane = await h.manager.start({ title: "tools-held", cwd: repo, channel: "D1" });
		await h.settle();
		await h.manager.pause(lane.name, "owner-message");
		await h.settle();

		const claimReply = await h.manager.claimDone(lane.originKey, {
			repo: lane.cwd,
			commit: "b".repeat(40),
			summary: "done?",
		});
		expect(claimReply).toContain("paused");
		const progressReply = await h.manager.progress(lane.originKey, "중간 보고");
		expect(progressReply).toContain("paused");
		const after = h.store.getLane(lane.name);
		expect(after?.meta.claim).toBeUndefined();
		expect(after?.meta.milestone).toBeUndefined();
		expect(after?.status).toBe("paused");
		h.close();
	});
});

describe("resume returns to pausedFrom and delivers the held messages (manager, AC-5)", () => {
	test("working: held owner messages go out only at resume; nothing else unpause (tick, tools)", async () => {
		const h = laneHarness(home.dir);
		const repo = makeRepo(repos);
		const lane = await h.manager.start({ title: "resume-working", cwd: repo, channel: "D1" });
		await h.settle();
		await h.manager.pause(lane.name, "owner-message");
		await h.settle();
		const pausedAt = h.store.getLane(lane.name)?.meta.pausedAt;
		expect(pausedAt).toBeNumber();

		h.store.recordInbound({
			originKey: lane.originKey,
			platformMessageId: "D1:1900000000.000900",
			textRef: "늦게 온 지시",
			threadRef: lane.threadRef,
		});
		await h.settle();
		expect(h.store.getInbound("D1:1900000000.000900")?.state).toBe("pending");

		// Neither the tick nor the lane tools lift the pause.
		await h.manager.tick();
		await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "c".repeat(40), summary: "x" });
		await h.manager.progress(lane.originKey, "보고");
		await h.settle();
		expect(h.store.getLane(lane.name)?.status).toBe("paused");

		const outcome = await h.manager.resume(lane.name, "owner-message");
		await h.settle();
		expect(outcome.handled).toBe(true);
		expect(outcome.text).toContain("재개했습니다");
		expect(h.store.getLane(lane.name)?.status).toBe("working");
		expect(h.store.getLane(lane.name)?.meta.pausedAt).toBeUndefined();
		expect(h.prompts(lane.originKey).some((text) => text.includes("늦게 온 지시"))).toBe(true);
		expect(h.steers(lane.originKey).some((text) => text.includes("오너가 재개했습니다"))).toBe(true);
		expect(h.store.getInbound("D1:1900000000.000900")?.state).toBe("dispatched");
		h.close();
	});

	test("done-claimed: the claim survives and claimedAt restarts at resume", async () => {
		const gate = Promise.withResolvers<VerifyResult>();
		const h = laneHarness(home.dir, { verify: async () => gate.promise });
		const repo = makeRepo(repos);
		const lane = await h.manager.start({ title: "resume-claim", cwd: repo, channel: "D1" });
		await h.settle();
		const settled = h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "d".repeat(40), summary: "x" });
		void settled;
		await until(() => h.store.getLane(lane.name)?.status === "done-claimed");
		const claimedAt = h.store.getLane(lane.name)?.meta.claim?.claimedAt;

		await h.manager.pause(lane.name, "owner-message");
		await h.settle();
		const pausedAt = h.store.getLane(lane.name)?.meta.pausedAt;
		h.advance(120_000);
		const outcome = await h.manager.resume(lane.name, "owner-message");
		await h.settle();
		expect(outcome.text).toContain("재개했습니다");
		const after = h.store.getLane(lane.name);
		expect(after?.status).toBe("done-claimed");
		expect(after?.meta.claim?.commit).toBe("d".repeat(40));
		expect(after?.meta.claim?.claimedAt ?? 0).toBeGreaterThan(pausedAt ?? 0);
		expect(after?.meta.claim?.claimedAt ?? 0).toBeGreaterThan(claimedAt ?? 0);
		gate.resolve({ ok: true, sha: "d".repeat(40) });
		await settled;
		h.close();
	});

	test("done-claimed: an owner message held under the pause answers the claim, so resume returns to working", async () => {
		const gate = Promise.withResolvers<VerifyResult>();
		const h = laneHarness(home.dir, { verify: async () => gate.promise });
		const repo = makeRepo(repos);
		const lane = await h.manager.start({ title: "resume-answered", cwd: repo, channel: "D1" });
		await h.settle();
		const settled = h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "e".repeat(40), summary: "x" });
		void settled;
		await until(() => h.store.getLane(lane.name)?.status === "done-claimed");
		await h.manager.pause(lane.name, "owner-message");
		await h.settle();
		h.store.recordInbound({
			originKey: lane.originKey,
			platformMessageId: "D1:1900000000.000950",
			textRef: "아직 아니야, 이것도 고쳐",
			threadRef: lane.threadRef,
		});

		await h.manager.resume(lane.name, "owner-message");
		await h.settle();
		const after = h.store.getLane(lane.name);
		expect(after?.status).toBe("working");
		expect(after?.meta.claim).toBeUndefined();
		gate.resolve({ ok: true, sha: "e".repeat(40) });
		await settled;
		await h.settle();
		expect(h.store.getLane(lane.name)?.status).toBe("working"); // the stale claim closes nothing
		h.close();
	});

	test("resume during a freeze: the lane is given back, no resume steer goes out, and the answer says so", async () => {
		const state: { value: { since: string; reason: string; by: string } | undefined } = { value: undefined };
		const h = laneHarness(home.dir, { frozen: () => state.value });
		const repo = makeRepo(repos);
		const lane = await h.manager.start({ title: "resume-frozen", cwd: repo, channel: "D1" });
		await h.settle();
		await h.manager.pause(lane.name, "owner-message");
		await h.settle();
		state.value = { since: "2027-01-15T00:00:00Z", reason: "점검", by: "owner" };

		const outcome = await h.manager.resume(lane.name, "owner-message");
		await h.settle();
		expect(outcome.text).toContain("재개했습니다");
		expect(outcome.text).toContain("보내지 않았습니다");
		expect(h.store.getLane(lane.name)?.status).toBe("working");
		expect(h.steers(lane.originKey)).toHaveLength(0);
		expect(h.prompts(lane.originKey)).toHaveLength(1); // the start prompt only
		h.close();
	});

	test("two lanes started at once from the same title get distinct names", async () => {
		const h = laneHarness(home.dir);
		const repo = makeRepo(repos);
		// Both starts have picked their name before either row exists: the status posts wait for each other.
		const post = h.transport.postMessage.bind(h.transport);
		const both = Promise.withResolvers<void>();
		let statusPosts = 0;
		h.transport.postMessage = async (args) => {
			if (args.text.startsWith("⏳")) {
				statusPosts += 1;
				if (statusPosts === 2) both.resolve();
				await both.promise;
			}
			return post(args);
		};
		const [a, b] = await Promise.all([
			h.manager.start({ title: "twin", cwd: repo, channel: "D1" }),
			h.manager.start({ title: "twin", cwd: repo, channel: "D1" }),
		]);
		await h.settle();
		expect(a.name).not.toBe(b.name);
		expect(h.store.getLane(a.name)?.status).toBe("working");
		expect(h.store.getLane(b.name)?.status).toBe("working");
		h.close();
	});

	test("resume on a lane that is not paused changes nothing", async () => {
		const h = laneHarness(home.dir);
		const repo = makeRepo(repos);
		const lane = await h.manager.start({ title: "not-paused", cwd: repo, channel: "D1" });
		await h.settle();
		const outcome = await h.manager.resume(lane.name, "owner-message");
		expect(outcome.handled).toBe(false);
		expect(h.store.getLane(lane.name)?.status).toBe("working");
		h.close();
	});
});

describe("a held lane that starts working again is stopped once (AC-6)", () => {
	test("tool_execution_start outside a turn: one warning in the thread and the abort retries", async () => {
		const h = laneHarness(home.dir);
		const repo = makeRepo(repos);
		const lane = await h.manager.start({ title: "held-work", cwd: repo, channel: "D1" });
		await h.settle();
		await h.manager.pause(lane.name, "owner-message");
		await h.settle();
		const driver = h.drivers.get(lane.originKey);
		expect(driver?.calls.filter((call) => call === "abort")).toHaveLength(1);
		expect(h.store.getLane(lane.name)?.status).toBe("paused");

		driver?.emitTestEvent({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash" });
		await h.settle();
		expect(h.transport.posts((text) => text.includes("다시 작업을 시작했습니다"))).toHaveLength(1);
		expect(driver?.calls.filter((call) => call === "abort")).toHaveLength(2);
		expect(h.store.getLane(lane.name)?.status).toBe("paused");

		// More of the same runaway work: still one warning for this pause.
		driver?.emitTestEvent({ type: "tool_execution_start", toolCallId: "c2", toolName: "bash" });
		driver?.emitTestEvent({ type: "tool_execution_start", toolCallId: "c3", toolName: "bash" });
		await h.settle();
		expect(h.transport.posts((text) => text.includes("다시 작업을 시작했습니다"))).toHaveLength(1);
		h.close();
	});
});

describe("the lanes CHECK constraint and the stuck gate (AC-8)", () => {
	/** The CREATE TABLE text of `lanes` in a database file (a named cast: sqlite_master rows are untyped). */
	function lanesDdl(path: string, readonly = true): string {
		const db = new Database(path, { readonly });
		const row = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'lanes'").get() as
			| { sql: string }
			| undefined;
		db.close();
		if (row === undefined) throw new Error(`no lanes table in ${path}`);
		return row.sql;
	}

	test("a fresh database is created with `paused` in the lanes CHECK", () => {
		const h = laneHarness(home.dir);
		h.close();
		expect(lanesDdl(join(home.dir, "ompbot.db"))).toContain("'paused'");
	});

	test("a pre-pause `lanes` table is rebuilt with its rows once `paused` arrives", () => {
		const path = join(home.dir, "old-ledger.db");
		const seed = openBotStore(path, clock);
		seed.close();
		const raw = new Database(path);
		raw.run("DROP TABLE lanes");
		raw.run(`CREATE TABLE lanes (
			name TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			thread_ref TEXT NOT NULL UNIQUE,
			origin_key TEXT NOT NULL UNIQUE,
			cwd TEXT NOT NULL,
			session_dir TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'working'
				CHECK (status IN ('working','done-claimed','not-done','closed')),
			history TEXT NOT NULL DEFAULT '[]',
			meta TEXT NOT NULL DEFAULT '{}',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`);
		raw.run(
			"INSERT INTO lanes (name, title, thread_ref, origin_key, cwd, session_dir, status, history, meta, created_at, updated_at) VALUES ('old', '옛 레인', 'D1:1', 'ompbot/work/old', '/tmp/x', '/tmp/x', 'working', '[]', '{}', 1, 1)",
		);
		raw.close();

		const store = openBotStore(path, clock);
		expect(store.getLane("old")).toMatchObject({ name: "old", title: "옛 레인", status: "working" });
		store.transitionLane("old", "paused", { event: "paused" }, { pausedFrom: "working" });
		expect(store.getLane("old")?.status).toBe("paused");
		store.close();
		expect(lanesDdl(path)).toContain("'paused'");
	});

	test("the lanes_stuck gate does not count a paused lane, however long it sits", async () => {
		const h = laneHarness(home.dir);
		const repo = makeRepo(repos);
		const lane = await h.manager.start({ title: "gate-paused", cwd: repo, channel: "D1" });
		await h.settle();
		// The gate reads the harness clock's future: two days after the lane's last activity.
		const later = LANE_START + 2 * LANE_STUCK_MS;
		const stuck = () => collectGates({ homeDir: home.dir, now: later }).find((gate) => gate.name === "lanes_stuck");
		expect(stuck()?.state).toBe("open"); // control: the same quiet lane counts while it is working
		await h.manager.pause(lane.name, "owner-message");
		await h.settle();
		expect(stuck()?.state).toBe("closed");
		h.close();
	});
});

describe("the pause/resume buttons ride the status message (AC-5)", () => {
	test("working shows ⏸ 멈춤, paused shows the ⏸ text and ▶ 재개", async () => {
		const h = laneHarness(home.dir);
		const repo = makeRepo(repos);
		const lane = await h.manager.start({ title: "button-view", cwd: repo, channel: "D1" });
		await h.settle();
		const statusTs = h.store.getLane(lane.name)?.meta.statusTs ?? "";
		const lastStatus = () => {
			const call = h.transport.calls.findLast((call) => call.method === "updateMessage" && call.ts === statusTs);
			return call?.method === "updateMessage" ? call : undefined;
		};

		// The working status message (a post at the start, then edits) carries the pause button.
		const working = h.transport.posts().find((post) => post.ts === statusTs);
		expect(working?.text).toContain("⏳ button-view");
		expect(JSON.stringify(working?.blocks ?? [])).toContain(`ompbot:lane:pause:${lane.name}`);

		await h.manager.pause(lane.name, "button");
		await h.settle();
		const paused = lastStatus();
		expect(paused?.text).toContain("⏸ button-view");
		expect(paused?.text).toContain("멈춤");
		expect(JSON.stringify(paused?.blocks ?? [])).toContain(`ompbot:lane:resume:${lane.name}`);

		await h.manager.resume(lane.name, "button");
		await h.settle();
		expect(h.store.getLane(lane.name)?.status).toBe("working");
		expect(lastStatus()?.text).toContain("⏳ button-view");
		h.close();
	});
});
