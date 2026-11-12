import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TurnFailureEscalation } from "../src/core/mailbox";
import { OriginRouter } from "../src/core/origin";
import type { InboundRecord } from "../src/core/types";
import { createLogger } from "../src/log";
import type { OmpEvent } from "../src/omp/driver";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { sessionWindowCost } from "../src/ops/cost-cap";
import { redact } from "../src/redact";
import { openStore, type Store } from "../src/store/db";
import { localDay } from "../src/time";

const ORIGIN = "slack/dm/DBUDGET";

class FakeClock {
	t = Date.UTC(2026, 10, 10, 12, 0, 0);
	now(): number {
		return this.t;
	}
	advance(ms: number): void {
		this.t += ms;
	}
}

/** A `message_end` carrying one assistant call's cost, as omp reports it inside a turn. */
const usageEvent = (total: number): OmpEvent => ({
	type: "message_end",
	message: { role: "assistant", content: [], usage: { input: 10, output: 1, cost: { total } } },
});

let dir: string;
let clock: FakeClock;
let store: Store;
let router: OriginRouter;
let drivers: FakeOmpDriver[];
let logLines: string[];
let escalations: TurnFailureEscalation[];
let costCap: { turnUsd?: number; dailyUsd?: number } | undefined;
let escalateAfter: number | undefined;
let sessionStore: FakeSessionStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-cost-cap-"));
	clock = new FakeClock();
	store = openStore({ timezone: "Asia/Seoul", path: join(dir, "ompbot.db"), clock, redact });
	drivers = [];
	logLines = [];
	escalations = [];
	costCap = undefined;
	escalateAfter = undefined;
	sessionStore = new FakeSessionStore();
	router = buildRouter();
});

/** A router over the current store/clock; `beforeEach` builds one, and a test may build another before routing. */
function buildRouter(options: { sessionFile?: string } = {}): OriginRouter {
	return new OriginRouter({
		timezone: "Asia/Seoul",
		store,
		clock,
		log: createLogger({ sink: (line) => logLines.push(line), clock, redact }),
		sessionsRoot: join(dir, "sessions"),
		statusProvider: () => "status: ok",
		costCap: () => costCap,
		...(escalateAfter === undefined ? {} : { escalateAfter }),
		onEscalate: (info) => escalations.push(info),
		driverFactory: (_origin, sessionDir) => {
			const driver = new FakeOmpDriver({
				holdTurns: true,
				sessionDir,
				store: sessionStore,
				...(options.sessionFile === undefined ? {} : { sessionFile: options.sessionFile }),
			});
			drivers.push(driver);
			return driver;
		},
	});
}

afterEach(async () => {
	await router.close();
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
function msg(text: string): InboundRecord {
	const id = `m${++counter}`;
	return { platformMessageId: id, originKey: ORIGIN, ownerVerified: true, text, threadRef: id };
}

/** Starts a held turn; `route` resolves once the mailbox recorded it and prompted the (fake, held) child. */
async function startTurn(text: string): Promise<FakeOmpDriver> {
	await router.route(msg(text));
	const driver = drivers.at(-1);
	if (driver === undefined) throw new Error("the mailbox started no driver");
	return driver;
}

/** Lets a held turn finish and waits for the mailbox's final path (the ledger write happens inside it). */
async function finishTurn(driver: FakeOmpDriver): Promise<void> {
	const settled = Promise.withResolvers<void>();
	const off = driver.onFinal(() => {
		off();
		settled.resolve();
	});
	driver.release();
	await settled.promise;
	await router.mailbox(ORIGIN).sweepIdle();
}

const bodies = (): string[] => store.listDeliveries({ originKey: ORIGIN }).map((row) => row.body);

describe("AC-1: per-turn cost cap", () => {
	test("turnUsd=1: $0.6+$0.5 steers once with the cap, a later $0.2 does not steer again", async () => {
		costCap = { turnUsd: 1 };
		const driver = await startTurn("비싼 작업");
		driver.emitTestEvent(usageEvent(0.6));
		expect(driver.calls.filter((call) => call.startsWith("steer:"))).toHaveLength(0);
		driver.emitTestEvent(usageEvent(0.5));
		// The steer runs on the mailbox's serial chain (a held turn keeps the lane busy): wait for it to drain.
		await router.mailbox(ORIGIN).sweepIdle();
		const steers = driver.calls.filter((call) => call.startsWith("steer:"));
		expect(steers).toHaveLength(1);
		expect(steers[0]).toContain("비용 상한($1.00)");
		driver.emitTestEvent(usageEvent(0.2));
		await router.mailbox(ORIGIN).sweepIdle();
		expect(driver.calls.filter((call) => call.startsWith("steer:"))).toHaveLength(1);
		expect(driver.calls).not.toContain("abort");
		expect(logLines.some((line) => line.includes("event=cost_cap_turn_soft"))).toBe(true);
		driver.release();
		await router.mailbox(ORIGIN).sweepIdle();
	});

	test("reaching 1.5x aborts the turn: one `cost_cap` failure notice, no consecutive-failure escalation", async () => {
		costCap = { turnUsd: 1 };
		// With escalateAfter=1 any counted failure escalates at once: the exclusion is what keeps this at zero.
		// It is read when a mailbox is built, so the router is rebuilt before the first message is routed.
		escalateAfter = 1;
		await router.close();
		router = buildRouter();
		const driver = await startTurn("폭주하는 작업");
		const settled = Promise.withResolvers<void>();
		const off = driver.onFinal(() => {
			off();
			settled.resolve();
		});
		driver.emitTestEvent(usageEvent(1.6));
		await settled.promise;
		await router.mailbox(ORIGIN).sweepIdle();
		expect(driver.calls).toContain("abort");
		expect(bodies()).toHaveLength(1);
		expect(bodies()[0]).toContain("비용 상한 $1.00의 1.5배를 넘어 턴을 멈췄습니다");
		expect(bodies()[0]).toContain("이번 턴 $1.60");
		expect(escalations).toHaveLength(0);
		expect(logLines.some((line) => line.includes("event=turn_failures_escalated"))).toBe(false);
	});

	test("without `costCap` a turn never steers nor aborts", async () => {
		const driver = await startTurn("평범한 작업");
		driver.emitTestEvent(usageEvent(9.9));
		driver.emitTestEvent(usageEvent(9.9));
		expect(driver.calls.filter((call) => call.startsWith("steer:"))).toHaveLength(0);
		expect(driver.calls).not.toContain("abort");
		driver.release();
		await router.mailbox(ORIGIN).sweepIdle();
	});
});

describe("AC-2: daily ledger", () => {
	test("addDailyUsage accumulates one row per day and origin, and KST midnight starts a new row", () => {
		// 2026-11-10T14:59:00Z is 23:59 KST; one minute later is the next KST day (same UTC date).
		clock.t = Date.parse("2026-11-10T14:59:00Z");
		const late = localDay(clock.now(), "Asia/Seoul");
		store.addDailyUsage({ day: late, originKey: ORIGIN, cost: 1.5, calls: 2 });
		store.addDailyUsage({ day: late, originKey: ORIGIN, cost: 0.5, calls: 1 });
		store.addDailyUsage({ day: late, originKey: "monitor/daily", cost: 2, calls: 1 });
		expect(store.dailyCost(late)).toBe(4);
		expect(store.dailyCost(late, ORIGIN)).toBe(2);
		expect(store.topDailyOrigins(late, 3)).toEqual([
			{ originKey: "monitor/daily", cost: 2 },
			{ originKey: ORIGIN, cost: 2 },
		]);

		clock.advance(60_000);
		const next = localDay(clock.now(), "Asia/Seoul");
		expect(next).not.toBe(late);
		expect(store.dailyCost(next)).toBe(0);
		store.addDailyUsage({ day: next, originKey: ORIGIN, cost: 3, calls: 1 });
		expect(store.dailyCost(next)).toBe(3);
		expect(store.dailyCost(late)).toBe(4);
	});

	test("a finished turn adds its session-window cost: own $1 + in-window sub-agent $2, out-of-window $5 skipped", async () => {
		clock.t = Date.parse("2026-11-10T12:00:00Z");
		const turnStart = clock.now();
		const sessionFile = join(dir, "sessions", "session.jsonl");
		mkdirSync(dirname(sessionFile), { recursive: true });
		// The turn's own call sits after the start cursor; the pre-cursor call is an earlier turn's spend.
		const before = [
			{ id: "e1", type: "model_change", timestamp: new Date(turnStart - 60_000).toISOString() },
			{
				id: "e2",
				type: "message",
				timestamp: new Date(turnStart - 30_000).toISOString(),
				message: { role: "assistant", usage: { cost: { total: 7 } } },
			},
			{ id: "e3", type: "message", timestamp: new Date(turnStart).toISOString(), message: { role: "user" } },
			{
				id: "e4",
				type: "message",
				timestamp: new Date(turnStart + 1_000).toISOString(),
				message: { role: "assistant", usage: { cost: { total: 1 } } },
			},
		];
		writeFileSync(sessionFile, `${before.map((record) => JSON.stringify(record)).join("\n")}\n`);
		// Sub-agent transcripts beside the session: one record inside the turn window, one from hours earlier.
		const subFile = join(dir, "sessions", "session", "sub-1.jsonl");
		mkdirSync(dirname(subFile), { recursive: true });
		writeFileSync(
			subFile,
			`${[
				{ type: "model_usage", timestamp: new Date(turnStart + 2_000).toISOString(), usage: { cost: { total: 1.5 } } },
				{
					type: "message",
					timestamp: new Date(turnStart + 3_000).toISOString(),
					message: { role: "assistant", usage: { cost: { total: 0.5 } } },
				},
				{
					type: "model_usage",
					timestamp: new Date(turnStart - 7_200_000).toISOString(),
					usage: { cost: { total: 5 } },
				},
			]
				.map((record) => JSON.stringify(record))
				.join("\n")}\n`,
		);
		sessionStore = new FakeSessionStore();
		router = buildRouter({ sessionFile });
		const driver = await startTurn("하위 에이전트를 쓰는 턴");
		driver.emitTestEvent(usageEvent(1));
		clock.advance(10_000);
		await finishTurn(driver);

		const day = localDay(turnStart, "Asia/Seoul");
		expect(store.dailyCost(day, ORIGIN)).toBeCloseTo(3, 6);
		expect(logLines.some((line) => line.includes("event=usage_daily_failed"))).toBe(false);
	});

	test("depth 2 sub-agents count once each: own $1 + child $1 + grandchild $2 = $4, past the depth cap skipped", async () => {
		const t0 = Date.parse("2026-11-10T12:00:00Z");
		const at = (ms: number): string => new Date(t0 + ms).toISOString();
		const usageLine = (ms: number, total: number): string =>
			`${JSON.stringify({ type: "model_usage", timestamp: at(ms), usage: { cost: { total } } })}\n`;
		const sessionFile = join(dir, "sessions", "session.jsonl");
		const stem = join(dir, "sessions", "session");
		mkdirSync(join(stem, "sub-a", "nested-b"), { recursive: true });
		writeFileSync(
			sessionFile,
			`${[
				{ id: "u0", type: "message", timestamp: at(-1_000), message: { role: "user" } },
				{
					id: "a1",
					type: "message",
					timestamp: at(1_000),
					message: { role: "assistant", usage: { cost: { total: 1 } } },
				},
			]
				.map((record) => JSON.stringify(record))
				.join("\n")}\n`,
		);
		writeFileSync(join(stem, "sub-a.jsonl"), usageLine(2_000, 1));
		writeFileSync(join(stem, "sub-a", "nested-b.jsonl"), usageLine(3_000, 2));
		writeFileSync(join(stem, "sub-a", "nested-b", "too-deep.jsonl"), usageLine(4_000, 8));

		const got = await sessionWindowCost({ sessionFile, afterEntryId: "u0", from: t0, to: t0 + 10_000 });
		expect(got).toEqual({ cost: 4, calls: 3 });
	});

	test("a child dying mid-turn still adds the turn's live total to the day, once (#49)", async () => {
		clock.t = Date.parse("2026-11-10T12:00:00Z");
		const driver = await startTurn("도중에 죽는 턴");
		driver.emitTestEvent(usageEvent(1.25));
		driver.crash(137);
		await router.mailbox(ORIGIN).sweepIdle();
		// A second exit of the same child finds no turn left to charge.
		driver.crash(137);
		await router.mailbox(ORIGIN).sweepIdle();

		const day = localDay(clock.now(), "Asia/Seoul");
		expect(store.dailyCost(day, ORIGIN)).toBeCloseTo(1.25, 6);
		expect(bodies()).toEqual(["[turn failed] omp_exited code=137 — 다시 보내 주세요"]);
	});

	test("a turn settled by its final and then exiting is charged once (#49)", async () => {
		clock.t = Date.parse("2026-11-10T12:00:00Z");
		router = buildRouter({ sessionFile: join(dir, "gone", "session.jsonl") });
		const driver = await startTurn("끝난 뒤 죽는 턴");
		driver.emitTestEvent(usageEvent(0.75));
		await finishTurn(driver);
		driver.crash(137);
		await router.mailbox(ORIGIN).sweepIdle();

		expect(store.dailyCost(localDay(clock.now(), "Asia/Seoul"), ORIGIN)).toBeCloseTo(0.75, 6);
	});

	test("an unreadable session file falls back to the turn's live total and logs usage_daily_failed", async () => {
		clock.t = Date.parse("2026-11-10T12:00:00Z");
		const sessionFile = join(dir, "gone", "session.jsonl");
		router = buildRouter({ sessionFile });
		const driver = await startTurn("세션 파일이 사라진 턴");
		driver.emitTestEvent(usageEvent(1.25));
		await finishTurn(driver);

		const day = localDay(clock.now(), "Asia/Seoul");
		expect(store.dailyCost(day, ORIGIN)).toBeCloseTo(1.25, 6);
		expect(logLines.some((line) => line.includes("event=usage_daily_failed"))).toBe(true);
	});
});
