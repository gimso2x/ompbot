// AC-4/AC-5 at the daemon and ledger level: the day's first-breach notice, `!budget`'s answers, the off/on switch
// that survives a restart and lifts at KST midnight, the `cost_cap` gate and the registered command.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Daemon } from "../src/daemon/daemon";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { budgetBreach, dailyBudgetState, dailyNoticeKey, dailyOffKey, ledgerDay } from "../src/ops/cost-cap";
import { redact } from "../src/redact";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import { openStore } from "../src/store/db";
import { makeHome, type TestHome, WaitingTransport } from "./helpers/bot-home";

const ORIGIN = "slack/dm/D1";
const MINUTE = 60_000;
/** 2026-11-10 21:00 KST: the day is 20261110 and the next KST midnight is three hours of fake time away. */
const T0 = Date.parse("2026-11-10T12:00:00Z");

let home: TestHome;
let clock: { t: number; now(): number };
let lines: string[];
let transport: WaitingTransport;
let daemon: Daemon | undefined;

beforeEach(() => {
	home = makeHome("ompbot-cost-cap-daemon-");
	clock = {
		t: T0,
		now() {
			return this.t;
		},
	};
	lines = [];
	transport = new WaitingTransport();
	daemon = undefined;
});

afterEach(async () => {
	await daemon?.stop();
	home.remove();
});

/** A daemon over this home with the given ceilings; `sweepMs` is long so only explicit `sweep()` calls run. */
async function boot(costCap: { turnUsd?: number; dailyUsd?: number }): Promise<Daemon> {
	const sessions = new FakeSessionStore();
	const d = new Daemon({
		config: { ...home.config, costCap },
		channels: [new SlackBinding(new SlackChannel(transport))],
		clock,
		log: createLogger({ sink: (line) => lines.push(line), clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot",
		sweepMs: 3_600_000,
		gateSweepMs: 0,
		taskSweepMs: 0,
		driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
	});
	daemon = d;
	await d.start();
	return d;
}

const notices = (): string[] => transport.posts((text) => text.includes("하루 상한 $10.00")).map((post) => post.text);
const stopLogs = (): string[] => lines.filter((line) => line.includes("event=cost_cap_daily_stop"));

describe("AC-4: daily cap notice", () => {
	test("the day's first breach posts one owner notice and later sweeps the same day stay quiet", async () => {
		const d = await boot({ dailyUsd: 10 });
		const day = ledgerDay(clock.t, "Asia/Seoul");
		d.store.addDailyUsage({ day, originKey: ORIGIN, cost: 12, calls: 3 });

		await d.sweep();
		await transport.waitForPosts((text) => text.includes("하루 상한 $10.00"));
		expect(notices()).toHaveLength(1);
		expect(notices()[0]).toContain("$12.00");
		expect(notices()[0]).toContain("!budget off");
		expect(d.store.getCursor(dailyNoticeKey(day))).toBeDefined();

		clock.t += MINUTE;
		await d.sweep();
		expect(notices()).toHaveLength(1);
		expect(stopLogs()).toHaveLength(1);
	});

	test("!budget answers today's total, its top origins and both ceilings", async () => {
		const d = await boot({ turnUsd: 20, dailyUsd: 300 });
		d.store.addDailyUsage({ day: ledgerDay(clock.t, "Asia/Seoul"), originKey: ORIGIN, cost: 12.5, calls: 3 });
		d.store.addDailyUsage({ day: ledgerDay(clock.t, "Asia/Seoul"), originKey: "monitor/daily", cost: 1.25, calls: 1 });

		await d.inject({ origin: ORIGIN, asOwner: true, text: "!budget" });
		await transport.waitForPosts((text) => text.includes("하루 $300.00"));
		const reply = transport.posts((text) => text.includes("하루 $300.00"))[0]?.text ?? "";
		expect(reply).toContain(`오늘(${ledgerDay(clock.t, "Asia/Seoul")}) 비용(정가 환산) $13.75`);
		expect(reply).toContain("턴 $20.00");
		expect(reply).toContain(`${ORIGIN} $12.50`);
		expect(reply).toContain("상한까지 $286.25 남았습니다");
	});
});

describe("AC-4: !budget off/on and the day boundary", () => {
	/** A daemon over `dailyUsd: 10` that already spent $12 today and has a per-minute monitor. */
	async function overCap(): Promise<{ daemon: Daemon; monitorId: string; day: string }> {
		const d = await boot({ dailyUsd: 10 });
		const day = ledgerDay(clock.t, "Asia/Seoul");
		d.store.addDailyUsage({ day, originKey: ORIGIN, cost: 12, calls: 3 });
		const monitor = d.store.monitors.addMonitor({
			name: "watch",
			trigger: { kind: "cron", schedule: "* * * * *", timezone: "UTC" },
			instruction: "check the thing",
			overlap: "queue",
			enabled: true,
		});
		return { daemon: d, monitorId: monitor.id, day };
	}

	const budgetSkips = (d: Daemon, monitorId: string) =>
		d.store.monitors
			.listEvents()
			.filter((event) => event.monitorId === monitorId && event.payload?.startsWith("budget") === true);

	/** Called (not fired) events of the monitor: everything a held tick never records. */
	const fired = (d: Daemon, monitorId: string) =>
		d.store.monitors
			.listEvents()
			.filter((event) => event.monitorId === monitorId && event.payload?.startsWith("budget") !== true);

	test("off lifts the day's ceiling for monitor fires, holds across a restart, and on re-arms it silently", async () => {
		const { daemon: d, monitorId, day } = await overCap();
		clock.t += 3 * MINUTE;
		await d.sweep();
		await transport.waitForPosts((text) => text.includes("하루 상한 $10.00"));
		expect(budgetSkips(d, monitorId)).toHaveLength(3);
		expect(fired(d, monitorId)).toHaveLength(0);

		await d.inject({ origin: ORIGIN, asOwner: true, text: "!budget off" });
		await transport.waitForPosts((text) => text.includes("하루 상한을 껐습니다"));
		expect(d.store.getCursor(dailyOffKey(day))).toBeDefined();
		expect(budgetBreach(dailyBudgetState({ store: d.store, day, cap: 10 }))).toBeUndefined();

		// A restart is a new Store over the same ledger: the day's off flag is still there, so the hook stays undefined.
		const reopened = openStore({ timezone: "Asia/Seoul", path: join(home.dir, "ompbot.db"), clock, redact });
		try {
			const state = dailyBudgetState({ store: reopened, day, cap: 10 });
			expect(state.off).toBe(true);
			expect(budgetBreach(state)).toBeUndefined();
		} finally {
			reopened.close();
		}

		// With the ceiling lifted the next due slot fires instead of being recorded as held.
		clock.t += MINUTE;
		await d.sweep();
		expect(fired(d, monitorId)).toHaveLength(1);
		expect(budgetSkips(d, monitorId)).toHaveLength(3);

		await d.inject({ origin: ORIGIN, asOwner: true, text: "!budget on" });
		await transport.waitForPosts((text) => text.includes("하루 상한을 다시 켰습니다"));
		expect(d.store.getCursor(dailyOffKey(day))).toBeUndefined();
		clock.t += MINUTE;
		await d.sweep();
		expect(budgetSkips(d, monitorId)).toHaveLength(4);
		// The day's notice already went out: re-arming does not send it again.
		expect(notices()).toHaveLength(1);
		expect(stopLogs()).toHaveLength(1);
	});

	test("KST midnight lifts the off flag by itself: the new day starts armed and its own first breach notifies", async () => {
		const { daemon: d, monitorId, day } = await overCap();
		await d.inject({ origin: ORIGIN, asOwner: true, text: "!budget off" });
		await transport.waitForPosts((text) => text.includes("하루 상한을 껐습니다"));
		const next = ledgerDay(Date.parse("2026-11-11T00:00:00+09:00"), "Asia/Seoul");
		expect(next).not.toBe(day);

		clock.t = Date.parse("2026-11-11T00:00:00+09:00");
		const state = dailyBudgetState({ store: d.store, day: next, cap: 10 });
		expect(state.off).toBe(false);
		expect(d.store.getCursor(dailyOffKey(next))).toBeUndefined();
		// The new day starts with no spend, so monitors fire again (the three hours since the last tick are a catch-up
		// burst, capped by the scheduler, so only "nothing was held" is asserted).
		expect(budgetBreach(state)).toBeUndefined();
		await d.sweep();
		expect(fired(d, monitorId).length).toBeGreaterThan(0);
		expect(budgetSkips(d, monitorId)).toHaveLength(0);

		// Spending past the cap again that day is a fresh breach: the new day gets its own first notice (the old day's
		// ceiling was lifted before any sweep, so it never posted one).
		d.store.addDailyUsage({ day: next, originKey: ORIGIN, cost: 11, calls: 1 });
		clock.t += MINUTE;
		await d.sweep();
		await transport.waitForPosts((text) => text.includes("하루 상한 $10.00"));
		expect(notices()).toHaveLength(1);
		expect(d.store.getCursor(dailyNoticeKey(next))).toBeDefined();
		expect(d.store.getCursor(dailyNoticeKey(day))).toBeUndefined();
		const days = lines.filter((line) => line.includes("event=cost_cap_daily_stop"));
		expect(days.some((line) => line.includes(`day=${next}`))).toBe(true);
	});
});
