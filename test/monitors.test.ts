import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	symlinkSync,
	watch,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OriginRouter, sessionDirFor } from "../src/core/origin";
import type { InboundRecord } from "../src/core/types";
import { createLogger } from "../src/log";
import {
	type EventStage,
	MONITOR_INCIDENT_REPEAT_MS,
	type MonitorEventRow,
	monitorOrigin,
	nextFireOf,
	openMonitorLedger,
} from "../src/monitors/ledger";
import { specOfRow } from "../src/monitors/portable";
import { CATCHUP_MAX_SLOTS, MonitorScheduler } from "../src/monitors/scheduler";
import { MAX_SCRIPT_STDERR_TAIL_CHARS, runScript } from "../src/monitors/script";
import { MonitorSpecError, mergeMonitorSpec, parseMonitorSpec } from "../src/monitors/spec";
import { OmpDriverError } from "../src/omp/driver";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { gcSessions, LEDGER_RETENTION_DAYS } from "../src/ops/gc";
import { redact } from "../src/redact";
import { openStore, type Store } from "../src/store/db";

const OWNER = "UOWNER";
const T0 = Date.UTC(2026, 5, 1, 0, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// The spec's retry delays, written out independently of the implementation's table.
const BACKOFF_1 = 10 * MINUTE;
const BACKOFF_2 = HOUR;
const BACKOFF_3 = 4 * HOUR;

class FakeClock {
	t = T0;
	now(): number {
		return this.t;
	}
	advance(ms: number): void {
		this.t += ms;
	}
}

interface Behavior {
	holdTurns?: boolean;
	respond?: (prompt: string) => string;
	startFails?: boolean;
}

let dir: string;
let clock: FakeClock;
let store: Store;
let router: OriginRouter;
let scheduler: MonitorScheduler;
let drivers: FakeOmpDriver[];
let behavior: Behavior;
let logLines: string[];
let frozenState: { since: string; reason: string; by: string } | undefined;
let budgetState: { day: string; cost: number; cap: number } | undefined;

const scriptsRoot = () => join(dir, "scripts");

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-monitors-"));
	mkdirSync(scriptsRoot());
	mkdirSync(join(dir, "workspace"));
	clock = new FakeClock();
	logLines = [];
	drivers = [];
	behavior = {};
	frozenState = undefined;
	budgetState = undefined;
	const sessions = new FakeSessionStore();
	const log = createLogger({ sink: (line) => logLines.push(line), clock, redact });
	store = openStore({ timezone: "Asia/Seoul", path: join(dir, "ompbot.db"), clock, redact, slackOwnerUserId: OWNER });
	router = new OriginRouter({
		timezone: "Asia/Seoul",
		store,
		clock,
		log,
		sessionsRoot: join(dir, "sessions"),
		statusProvider: () => "status: ok",
		driverFactory: (_origin, sessionDir) => {
			const driver = new FakeOmpDriver({
				sessionDir,
				store: sessions,
				...(behavior.holdTurns ? { holdTurns: true } : {}),
				...(behavior.respond ? { respond: behavior.respond } : {}),
				...(behavior.startFails ? { startError: new OmpDriverError("omp_executable_missing", "no omp") } : {}),
			});
			drivers.push(driver);
			return driver;
		},
	});
	scheduler = new MonitorScheduler({
		store,
		router,
		clock,
		log,
		scriptsRoot: scriptsRoot(),
		workspaceDir: join(dir, "workspace"),
		homeDir: dir,
		frozen: () => frozenState,
		budgetExceeded: () => budgetState,
	});
	scheduler.start();
});

afterEach(async () => {
	await scheduler.idle();
	await router.close();
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

const cronMonitor = (
	schedule: string,
	extra: { overlap?: "skip" | "queue"; name?: string; channel?: string; copyChannel?: string } = {},
) =>
	store.monitors.addMonitor({
		name: extra.name ?? "watch",
		trigger: { kind: "cron", schedule, timezone: "UTC" },
		instruction: "check the thing",
		overlap: extra.overlap ?? "queue",
		enabled: true,
		...(extra.channel === undefined ? {} : { channel: extra.channel }),
		...(extra.copyChannel === undefined ? {} : { copyChannel: extra.copyChannel }),
	});

/** One scheduler pass plus every script check and prompt hand-off it started. */
async function run() {
	const summary = await scheduler.tick();
	await scheduler.idle();
	return summary;
}

/** Resolves once `predicate` holds, re-evaluated on every ledger event change (the test timeout bounds the wait). */
function until(predicate: () => boolean): Promise<void> {
	if (predicate()) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	const off = store.monitors.subscribe(() => {
		if (!predicate()) return;
		off();
		resolve();
	});
	return promise;
}

const stages = (): EventStage[] => store.monitors.listEvents().map((event) => event.stage);
const answered = (event: MonitorEventRow) => event.stage === "authored" || event.stage === "delivered";
const prompts = () => drivers.flatMap((driver) => driver.calls).filter((call) => call.startsWith("prompt:"));

describe("monitors: exactly once", () => {
	test("a slot claimed twice, or replayed from a rewound cursor, produces one event and one prompt", async () => {
		const monitor = cronMonitor("* * * * *");
		clock.advance(MINUTE);
		const slot = T0 + MINUTE;

		const first = await run();
		expect(first.claimed).toBe(1);
		await until(() => store.monitors.listEvents().every(answered));

		expect(store.monitors.claimSlot({ monitorId: monitor.id, slotAt: slot }).status).toBe("duplicate");
		store.monitors.setCursor(monitor.id, T0);
		const replay = await run();
		expect(replay.claimed).toBe(0);

		expect(store.monitors.listEvents()).toHaveLength(1);
		expect(store.monitors.listSlots(monitor.id)).toEqual([{ slotAt: slot, state: "claimed", reason: null }]);
		expect(prompts()).toHaveLength(1);
	});
});

describe("monitors: cron cursor", () => {
	test("a tick with no slot due leaves the cursor and the next fire alone; a due slot moves the cursor to now", async () => {
		const monitor = cronMonitor("* * * * *");
		const cursorOf = () => store.monitors.getMonitor(monitor.id)?.cursorAt;
		clock.advance(MINUTE);
		expect((await run()).claimed).toBe(1);
		expect(cursorOf()).toBe(T0 + MINUTE);

		for (let i = 0; i < 3; i++) {
			clock.advance(15_000);
			expect((await run()).claimed).toBe(0);
		}
		expect(cursorOf()).toBe(T0 + MINUTE);
		const row = store.monitors.getMonitor(monitor.id);
		expect(row === undefined ? null : nextFireOf(row)).toBe(T0 + 2 * MINUTE);

		clock.advance(15_000);
		expect((await run()).claimed).toBe(1);
		expect(cursorOf()).toBe(clock.now());
		expect(store.monitors.listSlots(monitor.id)).toHaveLength(2);
	});
});

describe("monitors: daily cost ceiling", () => {
	const BUDGET = { day: "20260601", cost: 12, cap: 10 };

	test("a script monitor held by the ceiling keeps its schedule current instead of looking stalled (qa50b M-14)", async () => {
		const script = writeScript("held.sh", "#!/bin/sh\nexit 1\n");
		const monitor = store.monitors.addMonitor({
			name: "held",
			trigger: { kind: "script", command: [script], intervalMs: MINUTE },
			instruction: "x",
			overlap: "queue",
			enabled: true,
		});
		budgetState = BUDGET;
		clock.advance(20 * MINUTE);
		await run();
		const row = store.monitors.getMonitor(monitor.id);
		expect(row?.cursorAt).toBe(clock.now());
		expect(row === undefined ? null : nextFireOf(row)).toBe(clock.now() + MINUTE);
		// Nothing ran while held.
		expect(logLines.some((line) => line.includes("event=monitor_script"))).toBe(false);
	});

	test("due slots become skipped `budget` events with nothing dispatched; lifting it fires again without replaying", async () => {
		const monitor = cronMonitor("* * * * *");
		budgetState = BUDGET;
		clock.advance(3 * MINUTE);
		const held = await run();
		expect(held).toMatchObject({ claimed: 0, skippedBudget: 3, dispatched: 0 });
		expect(stages()).toEqual(["skipped", "skipped", "skipped"]);
		expect(store.monitors.listEvents().every((event) => event.payload?.startsWith("budget"))).toBe(true);
		expect(prompts()).toHaveLength(0);

		budgetState = undefined;
		clock.advance(MINUTE);
		const resumed = await run();
		expect(resumed.claimed).toBe(1);
		await until(() => store.monitors.listEvents().filter(answered).length === 1);
		expect(prompts()).toHaveLength(1);
		// The three held minutes stay skipped: only the new minute runs.
		expect(store.monitors.listEvents()).toHaveLength(4);
		expect(store.monitors.getMonitor(monitor.id)?.cursorAt).toBe(clock.now());
	});

	test("an event admitted before the ceiling is reached is skipped, not queued for a burst after midnight", async () => {
		const monitor = cronMonitor("0 0 1 1 *");
		const claim = store.monitors.claimSlot({ monitorId: monitor.id, slotAt: clock.now(), manual: true });
		if (claim.status !== "admitted") throw new Error("expected an admitted event");
		budgetState = BUDGET;
		await run();
		const event = store.monitors.getEvent(claim.event.eventId);
		expect(event?.stage).toBe("skipped");
		expect(event?.error).toBe("budget");
		expect(logLines.filter((line) => line.includes("event=monitor_budget_skip"))).toHaveLength(1);
		budgetState = undefined;
		await run();
		expect(prompts()).toHaveLength(0);
	});

	test("a script check does not run while the ceiling stands, and the freeze reason wins when both hold", async () => {
		const script = join(scriptsRoot(), "c.sh");
		writeFileSync(script, "#!/bin/sh\necho met\nexit 0\n", { mode: 0o755 });
		const monitor = store.monitors.addMonitor({
			name: "check",
			trigger: { kind: "script", command: [script], intervalMs: MINUTE },
			instruction: "act",
			overlap: "queue",
			enabled: true,
		});
		budgetState = BUDGET;
		clock.advance(MINUTE);
		expect(await run()).toMatchObject({ claimed: 0, dispatched: 0 });
		expect(store.monitors.listEvents()).toHaveLength(0);
		// A held check never starts a turn; its due time is skipped like a cron slot (qa50b M-14), never replayed.
		expect(store.monitors.getMonitor(monitor.id)?.cursorAt).toBe(T0 + MINUTE);
		expect(store.monitors.getMonitor(monitor.id)?.lastScriptState).toBeNull();

		// Both holds at once: the freeze switch names the skip, so a frozen tick keeps its own reason.
		const cron = cronMonitor("* * * * *");
		frozenState = { since: "2026-06-01T00:00:00.000Z", reason: "점검", by: "cli" };
		clock.advance(MINUTE);
		const both = await run();
		expect(both).toMatchObject({ claimed: 0, skippedFrozen: 1, skippedBudget: 0 });
		const events = store.monitors.listEvents().filter((event) => event.monitorId === cron.id);
		expect(events).toHaveLength(1);
		expect(events[0]?.payload?.startsWith("frozen")).toBe(true);
	});
});

describe("monitors: freeze switch", () => {
	const FREEZE = { since: "2026-06-01T00:00:00.000Z", reason: "점검", by: "cli" };

	test("frozen minutes become skipped `frozen` events, nothing is prompted, and unfreezing does not replay them", async () => {
		const monitor = cronMonitor("* * * * *");
		frozenState = FREEZE;
		clock.advance(3 * MINUTE);
		const held = await run();
		expect(held).toMatchObject({ claimed: 0, skippedFrozen: 3, dispatched: 0 });
		expect(stages()).toEqual(["skipped", "skipped", "skipped"]);
		expect(store.monitors.listEvents().every((event) => event.payload?.startsWith("frozen"))).toBe(true);
		expect(prompts()).toHaveLength(0);

		frozenState = undefined;
		clock.advance(MINUTE);
		const resumed = await run();
		expect(resumed.claimed).toBe(1);
		await until(() => store.monitors.listEvents().filter(answered).length === 1);
		expect(prompts()).toHaveLength(1);
		expect(store.monitors.listEvents()).toHaveLength(4);
		expect(store.monitors.getMonitor(monitor.id)?.cursorAt).toBe(clock.now());
	});

	test("an event admitted before the freeze is skipped instead of queued for a burst after unfreeze", async () => {
		const monitor = cronMonitor("0 0 1 1 *");
		const claim = store.monitors.claimSlot({ monitorId: monitor.id, slotAt: clock.now(), manual: true });
		if (claim.status !== "admitted") throw new Error("expected an admitted event");
		frozenState = FREEZE;
		await run();
		const event = store.monitors.getEvent(claim.event.eventId);
		expect(event?.stage).toBe("skipped");
		expect(event?.error).toBe("frozen");
		frozenState = undefined;
		await run();
		expect(prompts()).toHaveLength(0);
	});

	test("a one-shot `at` monitor that comes due while frozen stays enabled and unclaimed, then fires once after unfreeze", async () => {
		const monitor = store.monitors.addMonitor({
			name: "once",
			trigger: { kind: "at", at: new Date(T0 + MINUTE).toISOString() },
			instruction: "do it",
			overlap: "queue",
			enabled: true,
		});
		frozenState = FREEZE;
		clock.advance(2 * MINUTE);
		expect(await run()).toMatchObject({ claimed: 0, skippedFrozen: 1 });
		expect(await run()).toMatchObject({ claimed: 0, skippedFrozen: 1 });
		expect(store.monitors.getMonitor(monitor.id)?.enabled).toBe(true);
		expect(store.monitors.listSlots(monitor.id)).toEqual([]);
		expect(logLines.filter((line) => line.includes("event=monitor_at_held_frozen"))).toHaveLength(1);
		expect(prompts()).toHaveLength(0);

		frozenState = undefined;
		clock.advance(MINUTE);
		expect((await run()).claimed).toBe(1);
		await until(() => store.monitors.listEvents().filter(answered).length === 1);
		expect(prompts()).toHaveLength(1);
		expect(store.monitors.getMonitor(monitor.id)?.enabled).toBe(false);
	});
});

describe("monitors: restart catch-up", () => {
	test("hourly monitor down for 30h: newest 24 slots run, the 6 older ones are recorded as skipped", async () => {
		behavior.holdTurns = true;
		const monitor = cronMonitor("0 * * * *");
		clock.advance(30 * HOUR);
		const summary = await run();
		const slots = store.monitors.listSlots(monitor.id);
		expect(summary.claimed).toBe(CATCHUP_MAX_SLOTS);
		expect(summary.skippedCatchUp).toBe(6);
		expect(slots.filter((s) => s.state === "claimed")).toHaveLength(24);
		expect(slots.filter((s) => s.state === "skipped")).toHaveLength(6);
		const skippedAts = slots.filter((s) => s.state === "skipped").map((s) => s.slotAt);
		const claimedAts = slots.filter((s) => s.state === "claimed").map((s) => s.slotAt);
		expect(Math.max(...skippedAts)).toBeLessThan(Math.min(...claimedAts));
		expect(claimedAts.every((at) => clock.now() - at <= 24 * HOUR)).toBe(true);
		expect(store.monitors.getMonitor(monitor.id)?.cursorAt).toBe(clock.now());
	});

	test("minutely monitor down for 2h: 24 run, 96 are skipped; a second tick adds nothing", async () => {
		behavior.holdTurns = true;
		const monitor = cronMonitor("* * * * *");
		clock.advance(2 * HOUR);
		const summary = await run();
		expect(summary.claimed).toBe(24);
		expect(summary.skippedCatchUp).toBe(96);
		const again = await run();
		expect(again.claimed + again.skippedCatchUp).toBe(0);
		const slots = store.monitors.listSlots(monitor.id);
		expect(slots).toHaveLength(120);
		expect(slots.filter((s) => s.reason === "catchup_limit")).toHaveLength(96);
	});
});

describe("monitors: overlap", () => {
	test("skip: a fire while the previous one is still running is recorded as skipped", async () => {
		behavior.holdTurns = true;
		cronMonitor("* * * * *", { overlap: "skip" });
		clock.advance(MINUTE);
		await run();
		clock.advance(MINUTE);
		const second = await run();
		expect(second.claimed).toBe(0);
		expect(second.skippedOverlap).toBe(1);
		const events = store.monitors.listEvents();
		expect(events.map((e) => e.stage)).toEqual(["dispatched", "skipped"]);
		expect(events[1]?.skippedBy).toBe(events[0]?.eventId ?? -1);
		expect(prompts()).toHaveLength(1);
	});

	test("queue: the second fire waits for the first turn, then runs", async () => {
		behavior.holdTurns = true;
		const monitor = cronMonitor("* * * * *", { overlap: "queue" });
		clock.advance(MINUTE);
		await run();
		clock.advance(MINUTE);
		const second = await run();
		expect(second.claimed).toBe(1);
		expect(second.dispatched).toBe(0);
		expect(stages()).toEqual(["dispatched", "admitted"]);
		expect(prompts()).toHaveLength(1);

		drivers[0]?.release();
		await until(
			() => store.monitors.listEvents()[0] !== undefined && answered(store.monitors.listEvents()[0] as MonitorEventRow),
		);
		const third = await run();
		expect(third.dispatched).toBe(1);
		expect(prompts()).toHaveLength(2);
		// The idle fire ran in a fresh session, so the held turn lives on the replacement driver now.
		expect(store.getOrigin(monitorOrigin(monitor.id))?.epoch).toBe(2);
		drivers.at(-1)?.release();
		await until(() => store.monitors.listEvents().every(answered));
		expect(stages().every((stage) => stage === "authored")).toBe(true);
	});
});

describe("monitors: per-fire session", () => {
	test("an idle fire starts a fresh session: the epoch bumps and the retired child is replaced", async () => {
		behavior.respond = () => "ok";
		const monitor = cronMonitor("* * * * *");
		clock.advance(MINUTE);
		await run();
		await until(() => store.monitors.listEvents().every(answered));
		expect(store.getOrigin(monitorOrigin(monitor.id))?.epoch).toBe(1);
		expect(drivers).toHaveLength(1);
		const firstSession = await drivers[0]?.state();

		clock.advance(MINUTE);
		await run();
		await until(() => store.monitors.listEvents().every(answered));
		const origin = store.getOrigin(monitorOrigin(monitor.id));
		expect(origin?.epoch).toBe(2);
		expect(origin?.sessionDir).toBe(sessionDirFor(join(dir, "sessions"), monitorOrigin(monitor.id), 2));
		// The idle child of epoch 1 was stopped; the fire's prompt went to a child in epoch 2's empty session.
		expect(drivers).toHaveLength(2);
		expect(drivers[0]?.calls.filter((call) => call.startsWith("prompt:"))).toHaveLength(1);
		expect(drivers[1]?.calls.filter((call) => call.startsWith("prompt:"))).toHaveLength(1);
		expect((await drivers[1]?.state())?.sessionId).not.toBe(firstSession?.sessionId);
	});

	test("a busy origin keeps its session: the gate refuses the bump while a turn runs", async () => {
		behavior.holdTurns = true;
		const monitor = cronMonitor("* * * * *");
		clock.advance(MINUTE);
		await run();
		expect(store.getOrigin(monitorOrigin(monitor.id))?.epoch).toBe(1);
		expect(await router.newEpochIfIdle(monitorOrigin(monitor.id))).toBe(false);
		expect(store.getOrigin(monitorOrigin(monitor.id))?.epoch).toBe(1);
		expect(drivers).toHaveLength(1);

		// Once the turn settles, the same gate bumps; the next dispatch then opens the fresh session.
		drivers[0]?.release();
		await until(() => store.monitors.listEvents().every(answered));
		expect(await router.newEpochIfIdle(monitorOrigin(monitor.id))).toBe(true);
		expect(store.getOrigin(monitorOrigin(monitor.id))?.epoch).toBe(2);
	});
});

describe("monitors: at", () => {
	test("fires once, then the monitor is disabled", async () => {
		const monitor = store.monitors.addMonitor({
			name: "once",
			trigger: { kind: "at", at: new Date(T0 + MINUTE).toISOString() },
			instruction: "say hi",
			overlap: "queue",
			enabled: true,
		});
		expect((await run()).claimed).toBe(0);
		expect(store.monitors.getMonitor(monitor.id)?.enabled).toBe(true);

		clock.advance(MINUTE);
		expect((await run()).claimed).toBe(1);
		expect(store.monitors.getMonitor(monitor.id)?.enabled).toBe(false);

		clock.advance(MINUTE);
		expect((await run()).claimed).toBe(0);
		await until(() => store.monitors.listEvents().every(answered));
		expect(store.monitors.listEvents()).toHaveLength(1);
		expect(prompts()).toHaveLength(1);
	});

	test("an at time more than 24h in the past is skipped, never run", async () => {
		const monitor = store.monitors.addMonitor({
			name: "late",
			trigger: { kind: "at", at: new Date(T0 + MINUTE).toISOString() },
			instruction: "say hi",
			overlap: "queue",
			enabled: true,
		});
		clock.advance(25 * HOUR);
		const summary = await run();
		expect(summary.claimed).toBe(0);
		expect(summary.skippedCatchUp).toBe(1);
		expect(store.monitors.listEvents()).toHaveLength(0);
		expect(store.monitors.listSlots(monitor.id)).toEqual([
			{ slotAt: T0 + MINUTE, state: "skipped", reason: "catchup_age" },
		]);
		expect(store.monitors.getMonitor(monitor.id)?.enabled).toBe(false);
		expect(prompts()).toHaveLength(0);
	});
});

describe("monitors: answers and delivery", () => {
	test("NO_REPORT is recorded and nothing is delivered", async () => {
		behavior.respond = () => "NO_REPORT";
		const monitor = cronMonitor("* * * * *");
		clock.advance(MINUTE);
		await run();
		await until(() => stages().includes("no_report"));
		expect(store.listDeliveries()).toHaveLength(0);
		expect(
			store.listInbound({ state: "answered" }).filter((row) => row.originKey === monitorOrigin(monitor.id)),
		).toHaveLength(1);
	});

	test("a report is delivered as one top-level `⏰ <name>` message, then the event becomes delivered", async () => {
		behavior.respond = () => "disk 91%";
		const monitor = cronMonitor("* * * * *", { name: "disk" });
		clock.advance(MINUTE);
		await run();
		await until(() => stages().includes("authored"));
		const rows = store.listDeliveries({ originKey: monitorOrigin(monitor.id) });
		expect(rows).toHaveLength(1);
		expect(rows[0]?.body).toBe("⏰ disk\ndisk 91%");
		expect(rows[0]?.threadRef).toBe(`${OWNER}:-`);

		for (const row of store.claimDue()) store.confirmDelivery(row.deliveryId);
		await run();
		expect(stages()).toEqual(["delivered"]);
	});

	test("output goes to the owner's known DM channel when there is one", async () => {
		behavior.respond = () => "hello";
		store.ensureOrigin("slack/dm/D9", sessionDirFor(join(dir, "sessions"), "slack/dm/D9", 1));
		cronMonitor("* * * * *");
		clock.advance(MINUTE);
		await run();
		await until(() => stages().includes("authored"));
		expect(store.listDeliveries()[0]?.threadRef).toBe("D9:-");
	});

	test("a channel monitor delivers to `<channel>:-` while a DM monitor keeps the owner DM ref", async () => {
		behavior.respond = () => "report";
		const withChannel = cronMonitor("* * * * *", { name: "brief", channel: "C0123456789" });
		const dmMonitor = cronMonitor("* * * * *", { name: "plain" });
		expect(store.monitors.getMonitor(withChannel.id)?.channel).toBe("C0123456789");
		expect(dmMonitor.channel).toBeNull();
		clock.advance(MINUTE);
		await run();
		await until(() => stages().filter((s) => s === "authored").length === 2);
		expect(store.listDeliveries({ originKey: monitorOrigin(withChannel.id) })[0]?.threadRef).toBe("C0123456789:-");
		expect(store.listDeliveries({ originKey: monitorOrigin(dmMonitor.id) })[0]?.threadRef).toBe(`${OWNER}:-`);
	});

	test("copyChannel: a delivered answer is copied top-level with the same body; the primary delivery is unchanged", async () => {
		behavior.respond = () => "disk 91%";
		const monitor = cronMonitor("* * * * *", { name: "disk", copyChannel: "C0COPYCHAN1" });
		expect(store.monitors.getMonitor(monitor.id)?.copyChannel).toBe("C0COPYCHAN1");
		clock.advance(MINUTE);
		await run();
		await until(() => stages().includes("authored"));
		const rows = store.listDeliveries({ originKey: monitorOrigin(monitor.id) });
		expect(rows.map((row) => [row.threadRef, row.body])).toEqual([
			[`${OWNER}:-`, "⏰ disk\ndisk 91%"],
			["C0COPYCHAN1:-", "⏰ disk\ndisk 91%"],
		]);
		// Settling the same answer again is idempotent: still exactly one copy.
		expect(rows.filter((row) => row.threadRef === "C0COPYCHAN1:-")).toHaveLength(1);
	});

	test("copyChannel: a silent answer is copied without its marker line, or as `알릴 내용 없음` when nothing remains", async () => {
		const answers = ["NO_REPORT", "[SILENT]\n디스크 정상, 변화 없음", "점검 결과 이상 없음\n[SILENT]"];
		let next = 0;
		behavior.respond = () => answers[next++ % answers.length] ?? "NO_REPORT";
		const monitor = cronMonitor("* * * * *", { name: "disk", copyChannel: "C0COPYCHAN1" });
		for (let i = 0; i < answers.length; i++) {
			clock.advance(MINUTE);
			await run();
			await until(() => stages().filter((s) => s === "no_report").length === i + 1);
		}
		const bodies = store
			.listDeliveries({ originKey: monitorOrigin(monitor.id) })
			.map((row) => [row.threadRef, row.body]);
		expect(bodies).toEqual([
			["C0COPYCHAN1:-", "⏰ disk\n알릴 내용 없음"],
			["C0COPYCHAN1:-", "⏰ disk\n디스크 정상, 변화 없음"],
			["C0COPYCHAN1:-", "⏰ disk\n점검 결과 이상 없음"],
		]);
	});

	test("copyChannel: a monitor without one never copies, and a failure notice is not copied", async () => {
		behavior.respond = () => "NO_REPORT";
		cronMonitor("* * * * *");
		clock.advance(MINUTE);
		await run();
		await until(() => stages().includes("no_report"));
		expect(store.listDeliveries()).toHaveLength(0);

		behavior.startFails = true;
		const failing = cronMonitor("0 0 1 1 *", { name: "failing", copyChannel: "C0COPYCHAN1" });
		store.monitors.admitManual(failing.id);
		await run();
		for (const backoff of [BACKOFF_1, BACKOFF_2, BACKOFF_3]) {
			clock.advance(backoff);
			await run();
		}
		const rows = store.listDeliveries({ originKey: monitorOrigin(failing.id) });
		expect(rows).toHaveLength(1);
		expect(rows[0]?.body).toContain("failed_no_retry");
		expect(rows[0]?.threadRef).toBe(`${OWNER}:-`);
	});

	test("script payload reaches the prompt as fenced data", async () => {
		const script = writeScript("fire.sh", "#!/bin/sh\necho 'disk 91%'\nexit 0\n");
		store.monitors.addMonitor({
			name: "disk",
			trigger: { kind: "script", command: [script], intervalMs: MINUTE },
			instruction: "judge the disk",
			overlap: "queue",
			enabled: true,
		});
		clock.advance(MINUTE);
		await run();
		await until(() => stages().includes("authored"));
		const prompt = prompts()[0] ?? "";
		expect(prompt).toContain("judge the disk");
		expect(prompt).toContain("disk 91%");
		expect(prompt).toContain("[payload]");
		expect(store.monitors.listEvents()[0]?.payload).toBe("disk 91%");
	});
});

describe("monitors: verbatim delivery", () => {
	/** A scheduler over the shared store whose router only records what it was handed (and never finishes when `hang`). */
	const withRouter = (hang = false) => {
		const routed: InboundRecord[] = [];
		const verbatimScheduler = new MonitorScheduler({
			store,
			router: {
				route(record) {
					routed.push(record);
					return hang ? new Promise<void>(() => undefined) : Promise.resolve();
				},
				newEpochIfIdle: async () => false,
			},
			clock,
			log: createLogger({ sink: () => undefined, clock, redact }),
			scriptsRoot: scriptsRoot(),
			workspaceDir: join(dir, "workspace"),
			homeDir: dir,
		});
		const runOnce = async () => {
			await verbatimScheduler.tick();
			await verbatimScheduler.idle();
		};
		return { routed, runOnce };
	};
	/** A `fire: every` script monitor whose payload is the content of `payload.txt`. */
	const verbatimMonitor = (payload: string, extra: { copyChannel?: string } = {}) => {
		const payloadFile = join(dir, "payload.txt");
		writeFileSync(payloadFile, payload);
		const script = writeScript("relay.sh", '#!/bin/sh\ncat "$1"\n');
		return store.monitors.addMonitor({
			name: "relay",
			trigger: { kind: "script", command: [script, payloadFile], intervalMs: MINUTE, fire: "every" },
			instruction: "copy the payload",
			overlap: "queue",
			enabled: true,
			deliver: "verbatim",
			...(extra.copyChannel === undefined ? {} : { copyChannel: extra.copyChannel }),
		});
	};
	const PAYLOAD = "*네이버 세션 만료*\n<@UOWNER> 재로그인 필요\n- `run:all` 대기 중 _2건_";

	test("a fired verbatim monitor posts `⏰ <name>\\n<payload>` without a turn, then the event becomes delivered", async () => {
		const { routed, runOnce } = withRouter();
		const monitor = verbatimMonitor(PAYLOAD);
		clock.advance(MINUTE);
		await runOnce();
		expect(routed).toEqual([]);
		expect(store.listInbound().filter((row) => row.originKey === monitorOrigin(monitor.id))).toHaveLength(0);
		const rows = store.listDeliveries({ originKey: monitorOrigin(monitor.id) });
		expect(rows.map((row) => [row.threadRef, row.body])).toEqual([[`${OWNER}:-`, `⏰ relay\n${PAYLOAD}`]]);
		const [event] = store.monitors.listEvents({ monitorId: monitor.id });
		expect([event?.stage, event?.answer, event?.deliveryId]).toEqual(["authored", PAYLOAD, rows[0]?.deliveryId]);

		for (const row of store.claimDue()) store.confirmDelivery(row.deliveryId);
		await runOnce();
		expect(stages()).toEqual(["delivered"]);
	});

	test("queued events of a verbatim monitor all go out in order even when the router never finishes", async () => {
		const { routed, runOnce } = withRouter(true);
		const monitor = verbatimMonitor("first");
		store.monitors.admitManual(monitor.id, "queued one");
		store.monitors.admitManual(monitor.id, "queued two");
		await runOnce();
		expect(routed).toEqual([]);
		expect(store.listDeliveries({ originKey: monitorOrigin(monitor.id) }).map((row) => row.body)).toEqual([
			"⏰ relay\nqueued one",
			"⏰ relay\nqueued two",
		]);
		clock.advance(MINUTE);
		await runOnce();
		expect(store.listDeliveries({ originKey: monitorOrigin(monitor.id) }).map((row) => row.body)).toEqual([
			"⏰ relay\nqueued one",
			"⏰ relay\nqueued two",
			"⏰ relay\nfirst",
		]);
		expect(stages()).toEqual(["authored", "authored", "authored"]);
	});

	test("copyChannel gets one `<opRef>:copy` of the post", async () => {
		const { runOnce } = withRouter();
		const monitor = verbatimMonitor(PAYLOAD, { copyChannel: "C0COPYCHAN1" });
		clock.advance(MINUTE);
		await runOnce();
		const rows = store.listDeliveries({ originKey: monitorOrigin(monitor.id) });
		const [event] = store.monitors.listEvents({ monitorId: monitor.id });
		const opRef = `monitor:${monitor.id}:${event?.eventId}:1:verbatim`;
		expect(rows.map((row) => [row.opRef, row.threadRef, row.body])).toEqual([
			[opRef, `${OWNER}:-`, `⏰ relay\n${PAYLOAD}`],
			[`${opRef}:copy`, "C0COPYCHAN1:-", `⏰ relay\n${PAYLOAD}`],
		]);
		expect(event?.deliveryId).toBe(rows[0]?.deliveryId);
	});

	test("an empty payload ends as no_report with no post and no copy", async () => {
		const { routed, runOnce } = withRouter();
		const monitor = verbatimMonitor("", { copyChannel: "C0COPYCHAN1" });
		clock.advance(MINUTE);
		await runOnce();
		expect(routed).toEqual([]);
		expect(stages()).toEqual(["no_report"]);
		expect(store.listDeliveries({ originKey: monitorOrigin(monitor.id) })).toHaveLength(0);
	});

	test("a monitor without deliver is a turn monitor and still runs a turn", async () => {
		const { routed, runOnce } = withRouter();
		const script = writeScript("plain.sh", "#!/bin/sh\necho 'disk 91%'\n");
		const monitor = store.monitors.addMonitor({
			name: "plain",
			trigger: { kind: "script", command: [script], intervalMs: MINUTE },
			instruction: "judge the disk",
			overlap: "queue",
			enabled: true,
		});
		expect(monitor.deliver).toBe("turn");
		clock.advance(MINUTE);
		await runOnce();
		expect(routed.map((record) => record.originKey)).toEqual([monitorOrigin(monitor.id)]);
		expect(stages()).toEqual(["dispatched"]);
		expect(store.listDeliveries()).toHaveLength(0);
	});

	test("a database without the deliver column gains it and its monitors become turn monitors", () => {
		const added = cronMonitor("* * * * *", { name: "old" });
		const path = join(dir, "ompbot.db");
		store.close();
		const raw = new Database(path);
		raw.run("ALTER TABLE monitors DROP COLUMN deliver");
		raw.close();
		store = openStore({ timezone: "Asia/Seoul", path, clock, redact });
		expect(store.monitors.getMonitor(added.id)?.deliver).toBe("turn");
		const script = writeScript("relay.sh", "#!/bin/sh\nexit 0\n");
		const relay = store.monitors.addMonitor({
			name: "relay",
			trigger: { kind: "script", command: [script], intervalMs: MINUTE },
			instruction: "x",
			overlap: "queue",
			enabled: true,
			deliver: "verbatim",
		});
		expect(relay.deliver).toBe("verbatim");
	});

	test("spec: deliver defaults to turn, takes only turn|verbatim, and verbatim needs a script trigger", () => {
		const ctx = { scriptsRoot: scriptsRoot(), defaultTimezone: "Asia/Seoul" };
		const script = writeScript("relay.sh", "#!/bin/sh\nexit 0\n");
		const base = { name: "n", trigger: { kind: "script", command: [script], intervalMs: MINUTE }, instruction: "x" };
		expect(parseMonitorSpec(base, ctx).deliver ?? "turn").toBe("turn");
		const verbatim = parseMonitorSpec({ ...base, deliver: "verbatim" }, ctx);
		expect(verbatim.deliver).toBe("verbatim");
		expect(mergeMonitorSpec(verbatim, { overlap: "skip" }, ctx).deliver).toBe("verbatim");
		expect(() => parseMonitorSpec({ ...base, deliver: "copy" }, ctx)).toThrow(MonitorSpecError);
		expect(() =>
			parseMonitorSpec({ ...base, trigger: { kind: "cron", schedule: "0 9 * * *" }, deliver: "verbatim" }, ctx),
		).toThrow(MonitorSpecError);
		expect(() => mergeMonitorSpec(verbatim, { trigger: { kind: "cron", schedule: "0 9 * * *" } }, ctx)).toThrow(
			MonitorSpecError,
		);
		const cron = mergeMonitorSpec(verbatim, { trigger: { kind: "cron", schedule: "0 9 * * *" }, deliver: "turn" }, ctx);
		expect([cron.trigger.kind, cron.deliver ?? "turn"]).toEqual(["cron", "turn"]);
	});
});

describe("monitors: cron command (verbatim, no turn)", () => {
	const ctx = () => ({ scriptsRoot: scriptsRoot(), defaultTimezone: "UTC" });
	/** A minutely cron monitor whose command is `body`, built through the spec parser like `monitors add`. */
	const commandMonitor = (
		body: string,
		extra: { args?: string[]; copyChannel?: string; overlap?: "skip" | "queue"; timeoutMs?: number } = {},
	) => {
		const script = writeScript("cmd.sh", body);
		const spec = parseMonitorSpec(
			{
				name: "brief",
				trigger: {
					kind: "cron",
					schedule: "* * * * *",
					command: [script, ...(extra.args ?? [])],
					...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }),
				},
				instruction: "run the script and answer its stdout verbatim",
				deliver: "verbatim",
				...(extra.overlap === undefined ? {} : { overlap: extra.overlap }),
				...(extra.copyChannel === undefined ? {} : { copyChannel: extra.copyChannel }),
			},
			ctx(),
		);
		return store.monitors.addMonitor(spec);
	};
	const PAYLOAD = "*아침 브리핑*\n<@UOWNER> 확인 필요\n- `run:all` _2건_ [링크](https://example.com)";
	const logged = (name: string) => logLines.filter((line) => line.includes(`event=${name} `));
	const bodies = (monitorId: string) =>
		store.listDeliveries({ originKey: monitorOrigin(monitorId) }).map((row) => row.body);
	const runsIn = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").length : 0);
	/** Resolves once `path` exists, woken by a watch on its directory (the test timeout bounds the wait). */
	const fileAppears = (path: string): Promise<void> => {
		const { promise, resolve } = Promise.withResolvers<void>();
		const watcher = watch(dirname(path), () => {
			if (!existsSync(path)) return;
			watcher.close();
			resolve();
		});
		if (existsSync(path)) {
			watcher.close();
			resolve();
		}
		return promise;
	};
	/** Exits 0 at once from its second run on; the first run writes its pid to $1 and blocks until $2 (a FIFO) is written. */
	const BLOCKING =
		'#!/bin/sh\nif [ -f "$1" ]; then echo second; exit 0; fi\necho $$ > "$1.tmp"\nmv "$1.tmp" "$1"\nread line < "$2"\necho "done $line"\n';
	const fifo = () => {
		const path = join(dir, "release.fifo");
		expect(spawnSync("mkfifo", [path]).status).toBe(0);
		return path;
	};
	const release = (path: string) => {
		const fd = openSync(path, "w");
		writeSync(fd, "go\n");
		closeSync(fd);
	};

	test("a due slot runs the command once without a turn; stdout is posted word for word, with its copy", async () => {
		const out = join(dir, "out.txt");
		const runs = join(dir, "runs");
		writeFileSync(out, PAYLOAD);
		const monitor = commandMonitor('#!/bin/sh\necho run >> "$2"\ncat "$1"\n', {
			args: [out, runs],
			copyChannel: "C0COPYCHAN1",
		});
		const seen: EventStage[] = [];
		const off = store.monitors.subscribe((event) => {
			if (seen.at(-1) !== event.stage) seen.push(event.stage);
		});
		clock.advance(MINUTE);
		await run();
		expect(runsIn(runs)).toBe(1);
		expect(prompts()).toEqual([]);
		expect(drivers).toHaveLength(0);
		expect(store.listInbound().filter((row) => row.originKey === monitorOrigin(monitor.id))).toHaveLength(0);
		const [event] = store.monitors.listEvents({ monitorId: monitor.id });
		const opRef = `monitor:${monitor.id}:${event?.eventId}:1:verbatim`;
		const rows = store.listDeliveries({ originKey: monitorOrigin(monitor.id) });
		expect(rows.map((row) => [row.opRef, row.threadRef, row.body])).toEqual([
			[opRef, `${OWNER}:-`, `⏰ brief\n${PAYLOAD}`],
			[`${opRef}:copy`, "C0COPYCHAN1:-", `⏰ brief\n${PAYLOAD}`],
		]);
		expect([event?.stage, event?.payload, event?.answer, event?.deliveryId]).toEqual([
			"authored",
			PAYLOAD,
			PAYLOAD,
			rows[0]?.deliveryId,
		]);

		for (const row of store.claimDue()) store.confirmDelivery(row.deliveryId);
		await run();
		off();
		expect(seen).toEqual(["admitted", "dispatched", "authored", "delivered"]);
		expect(runsIn(runs)).toBe(1);
		expect(logged("monitor_command")).toHaveLength(1);
		expect(logged("monitor_verbatim")).toHaveLength(1);
		expect(logged("monitor_dispatch")).toHaveLength(0);
	});

	test("spec: command lives under the scripts dir, needs verbatim, bounds timeoutMs, is kept by updates and cleared by null", () => {
		const outsideDir = join(dir, "outside");
		mkdirSync(outsideDir);
		const outside = writeScript("evil.sh", "#!/bin/sh\nexit 0\n", outsideDir);
		const plain = join(scriptsRoot(), "plain.sh");
		writeFileSync(plain, "#!/bin/sh\nexit 0\n");
		const script = writeScript("cmd.sh", "#!/bin/sh\necho hi\n");
		const spec = (trigger: Record<string, unknown>, deliver?: string) => ({
			name: "n",
			trigger: { kind: "cron", schedule: "0 8 * * *", ...trigger },
			instruction: "x",
			...(deliver === undefined ? {} : { deliver }),
		});
		const rejects = (input: unknown, message: string) =>
			expect(() => parseMonitorSpec(input, ctx())).toThrow(new RegExp(message));
		rejects(spec({ command: [outside] }, "verbatim"), "must live under");
		rejects(spec({ command: [plain] }, "verbatim"), "not an executable");
		rejects(spec({ command: [script] }), 'needs deliver "verbatim"');
		rejects(spec({ command: [script] }, "turn"), 'needs deliver "verbatim"');
		rejects(spec({}, "verbatim"), "cron trigger with a command");
		rejects(spec({ command: [script], timeoutMs: 999 }, "verbatim"), "timeoutMs must be");
		rejects(spec({ command: [script], timeoutMs: 1_800_001 }, "verbatim"), "timeoutMs must be");
		rejects(spec({ command: [script], timeoutMs: 1500.5 }, "verbatim"), "timeoutMs must be");
		rejects(spec({ timeoutMs: 60_000 }), "timeoutMs needs trigger.command");

		expect(parseMonitorSpec(spec({ command: script }, "verbatim"), ctx()).trigger).toEqual({
			kind: "cron",
			schedule: "0 8 * * *",
			timezone: "UTC",
			command: [script],
		});
		const current = parseMonitorSpec(
			spec({ command: [script, "--days", "7"], timeoutMs: 1_800_000 }, "verbatim"),
			ctx(),
		);
		const moved = mergeMonitorSpec(current, { trigger: { schedule: "30 7 * * *" } }, ctx());
		expect(moved.trigger).toEqual({
			kind: "cron",
			schedule: "30 7 * * *",
			timezone: "UTC",
			command: [script, "--days", "7"],
			timeoutMs: 1_800_000,
		});
		expect(mergeMonitorSpec(current, { overlap: "skip" }, ctx()).trigger).toEqual(current.trigger);
		expect(() => mergeMonitorSpec(current, { trigger: { command: null } }, ctx())).toThrow(MonitorSpecError);
		const back = mergeMonitorSpec(current, { trigger: { command: null }, deliver: "turn" }, ctx());
		expect([back.trigger, back.deliver ?? "turn"]).toEqual([
			{ kind: "cron", schedule: "0 8 * * *", timezone: "UTC" },
			"turn",
		]);
	});

	test("a failing command ends failed_no_retry at once with one owner notice carrying its first stdout line; a repeat stays quiet", async () => {
		const monitor = commandMonitor('#!/bin/sh\necho "agy quota exhausted"\necho detail\nexit 3\n');
		clock.advance(MINUTE);
		await run();
		const [event] = store.monitors.listEvents({ monitorId: monitor.id });
		expect([event?.stage, event?.attempts, event?.nextAttemptAt]).toEqual(["failed_no_retry", 1, null]);
		expect(event?.error).toBe("[command failed] agy quota exhausted");
		const rows = store.listDeliveries({ originKey: monitorOrigin(monitor.id) });
		expect(rows.map((row) => row.threadRef)).toEqual([`${OWNER}:-`]);
		expect(rows[0]?.body).toBe(
			"⏰ brief\n⚠️ 모니터 실행이 1번 실패해 재시도를 멈췄습니다 (failed_no_retry): agy quota exhausted",
		);
		expect(logged("monitor_command_failed")).toHaveLength(1);

		clock.advance(MINUTE);
		await run();
		expect(stages()).toEqual(["failed_no_retry", "failed_no_retry"]);
		expect(bodies(monitor.id)).toHaveLength(1);
		clock.advance(BACKOFF_1);
		await run();
		expect(bodies(monitor.id)).toHaveLength(1);
		expect(stages().every((stage) => stage === "failed_no_retry")).toBe(true);
	});

	test("a command past its timeoutMs is killed and fails with `timed out after <n>s`", async () => {
		const pidFile = join(dir, "pid");
		// Real 1 s (the smallest timeoutMs): this exercises the runner's own timer and a real SIGKILL of the group.
		const monitor = commandMonitor('#!/bin/sh\necho $$ > "$1"\necho started\nexec sleep 30\n', {
			args: [pidFile],
			timeoutMs: 1000,
		});
		clock.advance(MINUTE);
		await run();
		const [event] = store.monitors.listEvents({ monitorId: monitor.id });
		expect([event?.stage, event?.attempts, event?.nextAttemptAt]).toEqual(["failed_no_retry", 1, null]);
		expect(event?.error?.startsWith("[command failed] timed out after 1s")).toBe(true);
		const notices = bodies(monitor.id);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("(failed_no_retry): timed out after 1s");
		const pid = Number(readFileSync(pidFile, "utf8").trim());
		expect(() => process.kill(-pid, 0)).toThrow();
	});

	test("an exception inside the run is caught: monitor_command_failed and failed_no_retry, the scheduler keeps going", async () => {
		const monitor = commandMonitor("#!/bin/sh\necho ok\n");
		store.deliverMonitorVerbatim = () => {
			throw new Error("ledger exploded");
		};
		clock.advance(MINUTE);
		await run();
		const [event] = store.monitors.listEvents({ monitorId: monitor.id });
		expect([event?.stage, event?.attempts]).toEqual(["failed_no_retry", 1]);
		expect(event?.error).toBe("[command failed] Error: ledger exploded");
		expect(logged("monitor_command_failed").some((line) => line.includes("ledger exploded"))).toBe(true);
		expect(bodies(monitor.id)).toHaveLength(1);
		clock.advance(MINUTE);
		expect((await run()).claimed).toBe(1);
	});

	test('exit 0 with empty output or a closing `{"wakeAgent": false}` is no_report with no post and no copy; [SILENT] is posted as is', async () => {
		const out = join(dir, "out.txt");
		const monitor = commandMonitor('#!/bin/sh\ncat "$1"\n', { args: [out], copyChannel: "C0COPYCHAN1" });
		writeFileSync(out, "");
		clock.advance(MINUTE);
		await run();
		writeFileSync(out, 'checked 3 feeds\n{"wakeAgent": false}\n');
		clock.advance(MINUTE);
		await run();
		expect(stages()).toEqual(["no_report", "no_report"]);
		expect(bodies(monitor.id)).toEqual([]);

		writeFileSync(out, "[SILENT]\n");
		clock.advance(MINUTE);
		await run();
		expect(stages()).toEqual(["no_report", "no_report", "authored"]);
		expect(bodies(monitor.id)).toEqual(["⏰ brief\n[SILENT]", "⏰ brief\n[SILENT]"]);
	});

	test("environment: HOME, OMPBOT_HOME, OMPBOT_MONITOR_ID, PATH and LANG reach the command and a script check, nothing else of the daemon's", async () => {
		const allowed = ["HOME", "OMPBOT_HOME", "OMPBOT_MONITOR_ID", "PATH", "LANG", "PWD", "SHLVL", "_"];
		const keysOf = (text: string | null | undefined) =>
			new Map(
				(text ?? "")
					.split("\n")
					.filter((line) => line.includes("="))
					.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
			);
		process.env.OMPBOT_TEST_DAEMON_ONLY = "leak";
		try {
			const command = commandMonitor("#!/bin/sh\nenv\n");
			const check = store.monitors.addMonitor({
				name: "check",
				trigger: {
					kind: "script",
					command: [writeScript("check.sh", "#!/bin/sh\nenv\n")],
					intervalMs: MINUTE,
					fire: "every",
				},
				instruction: "x",
				overlap: "queue",
				enabled: true,
				deliver: "verbatim",
			});
			clock.advance(MINUTE);
			await run();
			for (const monitor of [command, check]) {
				const [event] = store.monitors.listEvents({ monitorId: monitor.id });
				const env = keysOf(event?.answer);
				expect([...env.keys()].filter((key) => !allowed.includes(key))).toEqual([]);
				expect([env.get("HOME"), env.get("OMPBOT_HOME"), env.get("OMPBOT_MONITOR_ID")]).toEqual([
					process.env.HOME,
					dir,
					monitor.id,
				]);
				expect(env.has("PATH") && env.has("LANG")).toBe(true);
			}
		} finally {
			delete process.env.OMPBOT_TEST_DAEMON_ONLY;
		}
	});

	test("after stop() a due event starts no command and stays admitted", async () => {
		const runs = join(dir, "runs");
		commandMonitor('#!/bin/sh\necho run >> "$1"\necho hi\n', { args: [runs] });
		scheduler.stop();
		clock.advance(MINUTE);
		await run();
		expect(stages()).toEqual(["admitted"]);
		expect(runsIn(runs)).toBe(0);
		expect(logged("monitor_command")).toHaveLength(0);
	});

	test("stop() mid-command: idle() does not wait for timeoutMs, the group dies, the event stays dispatched and a restart posts it once", async () => {
		const pidFile = join(dir, "pid");
		const monitor = commandMonitor(BLOCKING, { args: [pidFile, fifo()], timeoutMs: 1_800_000 });
		clock.advance(MINUTE);
		await scheduler.tick();
		await fileAppears(pidFile);
		const pid = Number(readFileSync(pidFile, "utf8").trim());
		expect(stages()).toEqual(["dispatched"]);

		scheduler.stop();
		await scheduler.idle();
		expect(() => process.kill(-pid, 0)).toThrow();
		expect(stages()).toEqual(["dispatched"]);
		expect(logged("monitor_command_aborted")).toHaveLength(1);
		expect(bodies(monitor.id)).toEqual([]);

		const reopened = openStore({
			timezone: "Asia/Seoul",
			path: join(dir, "ompbot.db"),
			clock,
			redact,
			slackOwnerUserId: OWNER,
		});
		const restarted = new MonitorScheduler({
			store: reopened,
			router: { route: async () => {}, newEpochIfIdle: async () => false },
			clock,
			log: createLogger({ sink: () => {}, clock, redact }),
			scriptsRoot: scriptsRoot(),
			workspaceDir: join(dir, "workspace"),
			homeDir: dir,
		});
		try {
			expect(restarted.start()).toBe(1);
			expect(reopened.monitors.listEvents().map((event) => event.stage)).toEqual(["admitted"]);
			await restarted.tick();
			await restarted.idle();
			await restarted.tick();
			await restarted.idle();
			expect(reopened.monitors.listEvents().map((event) => event.stage)).toEqual(["authored"]);
			expect(reopened.listDeliveries({ originKey: monitorOrigin(monitor.id) }).map((row) => row.body)).toEqual([
				"⏰ brief\nsecond",
			]);
		} finally {
			reopened.close();
		}
	});

	test("queue: the next event waits while the command runs, then runs; skip records skipped_overlap", async () => {
		const pidFile = join(dir, "pid");
		const gate = fifo();
		const monitor = commandMonitor(BLOCKING, { args: [pidFile, gate] });
		clock.advance(MINUTE);
		await scheduler.tick();
		await fileAppears(pidFile);
		clock.advance(MINUTE);
		await scheduler.tick();
		expect(stages()).toEqual(["dispatched", "admitted"]);
		expect(logged("monitor_command")).toHaveLength(1);
		release(gate);
		await scheduler.idle();
		expect(stages()).toEqual(["authored", "authored"]);
		expect(bodies(monitor.id)).toEqual(["⏰ brief\ndone go", "⏰ brief\nsecond"]);

		store.monitors.removeMonitor(monitor.id);
		rmSync(pidFile);
		const skipping = commandMonitor(BLOCKING, { args: [pidFile, gate], overlap: "skip" });
		clock.advance(MINUTE);
		await scheduler.tick();
		await fileAppears(pidFile);
		clock.advance(MINUTE);
		const second = await scheduler.tick();
		expect(second.skippedOverlap).toBe(1);
		const events = () => store.monitors.listEvents({ monitorId: skipping.id }).map((event) => event.stage);
		expect(events()).toEqual(["dispatched", "skipped"]);
		release(gate);
		await scheduler.idle();
		expect(events()).toEqual(["authored", "skipped"]);
	});

	test("frozen: the command does not run and the event is skipped `frozen`", async () => {
		const runs = join(dir, "runs");
		const monitor = commandMonitor('#!/bin/sh\necho run >> "$1"\necho hi\n', { args: [runs] });
		frozenState = { since: "2026-06-01T00:00:00Z", reason: "test", by: "owner" };
		clock.advance(MINUTE);
		await run();
		const [event] = store.monitors.listEvents({ monitorId: monitor.id });
		expect(event?.stage).toBe("skipped");
		expect(event?.payload?.startsWith("frozen")).toBe(true);
		expect(runsIn(runs)).toBe(0);
		expect(bodies(monitor.id)).toEqual([]);
	});
});

describe("monitors: failure backoff", () => {
	test("retries after 10m, 1h and 4h, then failed_no_retry with exactly one notice", async () => {
		behavior.startFails = true;
		const monitor = cronMonitor("0 0 1 1 *");
		const event = store.monitors.admitManual(monitor.id);
		const current = () => store.monitors.getEvent(event.eventId) as MonitorEventRow;

		let summary = await run();
		expect(summary.dispatched).toBe(1);
		expect([current().stage, current().attempts, current().nextAttemptAt]).toEqual([
			"failed",
			1,
			clock.now() + BACKOFF_1,
		]);

		summary = await run();
		expect(summary.dispatched).toBe(0);
		clock.advance(BACKOFF_1 - 1);
		expect((await run()).dispatched).toBe(0);
		expect(current().attempts).toBe(1);

		clock.advance(1);
		expect((await run()).dispatched).toBe(1);
		expect([current().stage, current().attempts, current().nextAttemptAt]).toEqual([
			"failed",
			2,
			clock.now() + BACKOFF_2,
		]);

		clock.advance(BACKOFF_2);
		expect((await run()).dispatched).toBe(1);
		expect([current().stage, current().attempts, current().nextAttemptAt]).toEqual([
			"failed",
			3,
			clock.now() + BACKOFF_3,
		]);
		expect(store.listDeliveries({ originKey: monitorOrigin(monitor.id) })).toHaveLength(0);

		clock.advance(BACKOFF_3);
		expect((await run()).dispatched).toBe(1);
		expect([current().stage, current().attempts, current().nextAttemptAt]).toEqual(["failed_no_retry", 4, null]);

		clock.advance(24 * HOUR);
		expect((await run()).dispatched).toBe(0);
		const notices = store.listDeliveries({ originKey: monitorOrigin(monitor.id) });
		expect(notices).toHaveLength(1);
		expect(notices[0]?.body).toContain("failed_no_retry");
		expect(notices[0]?.body.startsWith("⏰ watch\n")).toBe(true);
		expect(notices[0]?.threadRef).toBe(`${OWNER}:-`);
	});

	test("an empty answer counts as a failed attempt, not a delivered report", async () => {
		behavior.respond = () => "";
		const monitor = cronMonitor("0 0 1 1 *");
		store.monitors.admitManual(monitor.id);
		await run();
		await until(() => stages().includes("failed"));
		expect(store.listDeliveries()).toHaveLength(0);
	});

	test("the same monitor failing with the same error re-alerts once per window, not per fire", async () => {
		const currentEvent = (eventId: number) => store.monitors.getEvent(eventId) as MonitorEventRow;
		const driveToTerminal = async (eventId: number) => {
			await run();
			for (const backoff of [BACKOFF_1, BACKOFF_2, BACKOFF_3]) {
				clock.advance(backoff);
				await run();
			}
			await until(() => currentEvent(eventId).stage === "failed_no_retry");
		};
		behavior.startFails = true;
		const monitor = cronMonitor("0 0 1 1 *");
		const first = store.monitors.admitManual(monitor.id);
		await driveToTerminal(first.eventId);
		expect(store.listDeliveries({ originKey: monitorOrigin(monitor.id) })).toHaveLength(1);

		// A second failing cycle with the same normalized error stays quiet.
		const second = store.monitors.admitManual(monitor.id);
		await driveToTerminal(second.eventId);
		expect(store.listDeliveries({ originKey: monitorOrigin(monitor.id) })).toHaveLength(1);
	});

	test("disabling a monitor resolves its open incidents, by setEnabled and by an update (qa50b M-15)", () => {
		const ledger = store.monitors;
		const monitor = cronMonitor("* * * * *");
		expect(ledger.recordMonitorIncident(monitor.id, "boom", 1_000).notify).toBe(true);
		ledger.setEnabled(monitor.id, false);
		ledger.setEnabled(monitor.id, true);
		expect(ledger.recordMonitorIncident(monitor.id, "boom", 2_000).notify).toBe(true);
		const row = ledger.getMonitor(monitor.id);
		if (row === undefined) throw new Error("monitor gone");
		ledger.updateMonitor(monitor.id, { ...specOfRow(row), enabled: false });
		ledger.updateMonitor(monitor.id, { ...specOfRow(row), enabled: true });
		expect(ledger.recordMonitorIncident(monitor.id, "boom", 3_000).notify).toBe(true);
	});

	test("disabling a monitor by an update skips its queued fires instead of running them (qa-i 66)", async () => {
		const monitor = cronMonitor("* * * * *", { channel: "C0CHAN" });
		const claim = store.monitors.claimSlot({ monitorId: monitor.id, slotAt: T0 });
		if (claim.status !== "admitted") throw new Error("expected an admitted fire");
		const row = store.monitors.getMonitor(monitor.id);
		if (row === undefined) throw new Error("monitor gone");
		store.monitors.updateMonitor(monitor.id, { ...specOfRow(row), enabled: false });
		await run();
		expect(prompts()).toHaveLength(0);
		expect(stages()).toEqual(["skipped"]);
	});

	test("incidents suppress repeats, reopen after a healthy run, and re-alert after the window", () => {
		const ledger = store.monitors;
		const signature = "timeout after 603s";
		expect(ledger.recordMonitorIncident("m-ledger", signature, 1_000).notify).toBe(true);
		expect(ledger.recordMonitorIncident("m-ledger", signature, 2_000).notify).toBe(false);
		// Durations are masked: a different number is the same incident.
		expect(ledger.recordMonitorIncident("m-ledger", "timeout after 611s", 3_000).notify).toBe(false);
		// A healthy run resolves it; the same error afterwards alerts again.
		ledger.resolveMonitorIncidents("m-ledger");
		expect(ledger.recordMonitorIncident("m-ledger", signature, 4_000).notify).toBe(true);
		// Inside the repeat window it stays quiet, and past the window it alerts again.
		expect(ledger.recordMonitorIncident("m-ledger", signature, 5_000).notify).toBe(false);
		expect(ledger.recordMonitorIncident("m-ledger", signature, 4_000 + MONITOR_INCIDENT_REPEAT_MS + 1).notify).toBe(
			true,
		);
	});
});

describe("monitors: schema migration", () => {
	test("opening a database that predates monitors keeps its data and adds the tables", () => {
		store.ensureOrigin("slack/dm/D1", "sess/e1");
		store.recordInbound({ originKey: "slack/dm/D1", platformMessageId: "D1:1.1", textRef: "old", threadRef: "D1:1.1" });
		store.recordAnswer({ originKey: "slack/dm/D1", opRef: "x", threadRef: "D1:1.1", parts: ["old answer"] });
		const path = join(dir, "ompbot.db");
		cronMonitor("* * * * *");
		store.close();

		const raw = new Database(path);
		raw.run("DROP TABLE monitor_events");
		raw.run("DROP TABLE monitor_slots");
		raw.run("DROP TABLE monitors");
		raw.close();

		const reopened = openStore({ timezone: "Asia/Seoul", path, clock, redact });
		try {
			expect(reopened.listDeliveries().map((row) => row.body)).toEqual(["old answer"]);
			expect(reopened.getInbound("D1:1.1")?.textRef).toBe("old");
			expect(reopened.monitors.listMonitors()).toEqual([]);
			reopened.monitors.addMonitor({
				name: "fresh",
				trigger: { kind: "cron", schedule: "* * * * *", timezone: "UTC" },
				instruction: "x",
				overlap: "queue",
				enabled: true,
			});
		} finally {
			reopened.close();
		}
		// The afterEach hooks close the original store again; reopen so that is a no-op on a live handle.
		store = openStore({ timezone: "Asia/Seoul", path, clock, redact });
	});

	test("model/thinking pins round-trip through add/update/list and a pre-pin table gains the columns", () => {
		const spec = {
			name: "pinned",
			trigger: { kind: "cron" as const, schedule: "* * * * *", timezone: "UTC" },
			instruction: "x",
			overlap: "queue" as const,
			enabled: true,
		};
		const added = store.monitors.addMonitor({ ...spec, model: "fake/beta", thinking: "high" });
		expect([added.model, added.thinking]).toEqual(["fake/beta", "high"]);
		const plain = store.monitors.addMonitor({ ...spec, name: "plain" });
		expect([plain.model, plain.thinking]).toEqual([null, null]);
		const updated = store.monitors.updateMonitor(added.id, { ...spec, model: "fake/alpha" });
		expect([updated?.model, updated?.thinking]).toEqual(["fake/alpha", null]);
		expect(
			store.monitors
				.listMonitors()
				.map((m) => [m.name, m.model, m.thinking])
				.sort(),
		).toEqual([
			["pinned", "fake/alpha", null],
			["plain", null, null],
		]);
		store.monitors.updateMonitor(added.id, { ...spec, model: "fake/beta", thinking: "low" });
		const path = join(dir, "ompbot.db");
		store.close();
		const raw = new Database(path);
		raw.run("ALTER TABLE monitors DROP COLUMN model");
		raw.run("ALTER TABLE monitors DROP COLUMN thinking");
		raw.close();
		store = openStore({ timezone: "Asia/Seoul", path, clock, redact });
		const migrated = store.monitors.listMonitors();
		expect(migrated.map((m) => [m.name, m.model, m.thinking]).sort()).toEqual([
			["pinned", null, null],
			["plain", null, null],
		]);
		expect(store.monitors.addMonitor({ ...spec, name: "after", model: "fake/alpha", thinking: "off" }).thinking).toBe(
			"off",
		);
	});

	test("copyChannel round-trips through add/update/list and a pre-copy table gains the column", () => {
		const spec = {
			name: "copied",
			trigger: { kind: "cron" as const, schedule: "* * * * *", timezone: "UTC" },
			instruction: "x",
			overlap: "queue" as const,
			enabled: true,
		};
		const added = store.monitors.addMonitor({ ...spec, copyChannel: "C0COPYCHAN1" });
		expect(added.copyChannel).toBe("C0COPYCHAN1");
		expect(store.monitors.addMonitor({ ...spec, name: "plain" }).copyChannel).toBeNull();
		expect(store.monitors.updateMonitor(added.id, { ...spec, copyChannel: "C0COPYCHAN2" })?.copyChannel).toBe(
			"C0COPYCHAN2",
		);
		expect(store.monitors.updateMonitor(added.id, spec)?.copyChannel).toBeNull();
		store.monitors.updateMonitor(added.id, { ...spec, copyChannel: "C0COPYCHAN1" });
		const path = join(dir, "ompbot.db");
		store.close();
		const raw = new Database(path);
		raw.run("ALTER TABLE monitors DROP COLUMN copy_channel");
		raw.close();
		store = openStore({ timezone: "Asia/Seoul", path, clock, redact });
		expect(
			store.monitors
				.listMonitors()
				.map((m) => [m.name, m.copyChannel])
				.sort(),
		).toEqual([
			["copied", null],
			["plain", null],
		]);
		expect(store.monitors.addMonitor({ ...spec, name: "after", copyChannel: "C0COPYCHAN1" }).copyChannel).toBe(
			"C0COPYCHAN1",
		);
	});

	test("monitor rows survive a reopen", () => {
		cronMonitor("* * * * *");
		const path = join(dir, "ompbot.db");
		store.close();
		store = openStore({ timezone: "Asia/Seoul", path, clock, redact });
		expect(store.monitors.listMonitors().map((m) => m.name)).toEqual(["watch"]);
	});
});

function writeScript(name: string, body: string, root = scriptsRoot()): string {
	const path = join(root, name);
	writeFileSync(path, body);
	chmodSync(path, 0o755);
	return path;
}

describe("monitors: script runner", () => {
	test("exit 0 fires and stdout is the payload", async () => {
		const script = writeScript("ok.sh", "#!/bin/sh\necho payload-text\nexit 0\n");
		const result = await runScript([script], { scriptsRoot: scriptsRoot(), cwd: dir });
		expect(result).toMatchObject({ fired: true, exitCode: 0, timedOut: false, stdout: "payload-text" });
	});

	test("a NUL byte in a command argument is rejected by the spec and reported, not thrown, by the runner (qa-i 131)", async () => {
		const script = writeScript("nul.sh", "#!/bin/sh\nexit 0\n");
		const ctx = { scriptsRoot: scriptsRoot(), defaultTimezone: "Asia/Seoul" };
		expect(() =>
			parseMonitorSpec(
				{ name: "n", trigger: { kind: "script", command: [script, "a\u0000b"], intervalMs: MINUTE }, instruction: "x" },
				ctx,
			),
		).toThrow(MonitorSpecError);
		const result = await runScript([script, "a\u0000b"], { scriptsRoot: scriptsRoot(), cwd: dir });
		expect(result).toMatchObject({ fired: false, exitCode: null });
		expect(result.error).toBeString();
	});

	test("exit 1 does not fire", async () => {
		const script = writeScript("no.sh", "#!/bin/sh\necho nope\nexit 1\n");
		const result = await runScript([script], { scriptsRoot: scriptsRoot(), cwd: dir });
		expect(result).toMatchObject({ fired: false, exitCode: 1, timedOut: false });
	});

	test("stderr is collected for the log tail while stdout still drives the gate", async () => {
		const script = writeScript("reason.sh", "#!/bin/sh\necho 'disk 92%' >&2\nexit 1\n");
		const result = await runScript([script], { scriptsRoot: scriptsRoot(), cwd: dir });
		expect(result).toMatchObject({ fired: false, exitCode: 1, stdout: "", stderr: "disk 92%" });
	});

	test("a stderr past the cap keeps only its last chars", async () => {
		const script = writeScript(
			"noisy.sh",
			"#!/bin/sh\n{ head -c 3000 /dev/zero | tr '\\0' A; echo END-MARK; } >&2\nexit 1\n",
		);
		const result = await runScript([script], { scriptsRoot: scriptsRoot(), cwd: dir });
		expect(result.stderr).toBe(`${"A".repeat(MAX_SCRIPT_STDERR_TAIL_CHARS - 8)}END-MARK`);
	});

	test("output past the collect bound keeps its tail: wake gate, hash and stderr reason see the whole stream (qa50b M-13)", async () => {
		const script = writeScript(
			"huge.sh",
			"#!/bin/sh\nhead -c 5000000 /dev/zero | tr '\\0' A\necho\necho '{\"wakeAgent\": false}'\n{ head -c 5000000 /dev/zero | tr '\\0' B; echo; echo REASON-END; } >&2\nexit 0\n",
		);
		const result = await runScript([script], { scriptsRoot: scriptsRoot(), cwd: dir });
		expect(result).toMatchObject({ fired: true, wakeOff: true });
		const whole = `${"A".repeat(5_000_000)}\n{"wakeAgent": false}`;
		expect(result.outputHash).toBe(createHash("sha256").update(whole).digest("hex"));
		expect(result.stdout.endsWith('{"wakeAgent": false}')).toBe(true);
		expect(result.stderr.endsWith("REASON-END")).toBe(true);
	});

	test("a background child holding the stderr pipe does not push the run to the timeout", async () => {
		const script = writeScript("holder.sh", "#!/bin/sh\n( sleep 30 >&2 ) &\nsleep 0.2\nexit 0\n");
		const started = Date.now();
		const result = await runScript([script], { scriptsRoot: scriptsRoot(), cwd: dir, streamCloseGraceMs: 100 });
		expect(result).toMatchObject({ fired: true, exitCode: 0, timedOut: false });
		expect(Date.now() - started).toBeLessThan(500);
	});

	test("a setsid daemon holding the stderr pipe cannot stall the runner", async () => {
		const script = writeScript("daemon.sh", "#!/bin/sh\nsetsid sleep 30 >&2 &\nexit 0\n");
		const started = Date.now();
		const result = await runScript([script], { scriptsRoot: scriptsRoot(), cwd: dir, streamCloseGraceMs: 100 });
		expect(result).toMatchObject({ fired: true, exitCode: 0, timedOut: false });
		expect(Date.now() - started).toBeLessThan(500);
	});

	test("without the option a held pipe gets the default 1 s close grace", async () => {
		const script = writeScript("holder.sh", "#!/bin/sh\n( sleep 30 >&2 ) &\nexit 0\n");
		const started = Date.now();
		const result = await runScript([script], { scriptsRoot: scriptsRoot(), cwd: dir });
		expect(result).toMatchObject({ fired: true, exitCode: 0, timedOut: false });
		expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	test("the monitor_script log event carries the stderr tail; a silent failure carries none", async () => {
		const loud = writeScript("loud.sh", "#!/bin/sh\necho 'disk missing' >&2\nexit 1\n");
		const quiet = writeScript("quiet.sh", "#!/bin/sh\necho met\nexit 1\n");
		const loudMonitor = store.monitors.addMonitor({
			name: "loud",
			trigger: { kind: "script", command: [loud], intervalMs: MINUTE },
			instruction: "x",
			overlap: "queue",
			enabled: true,
		});
		const quietMonitor = store.monitors.addMonitor({
			name: "quiet",
			trigger: { kind: "script", command: [quiet], intervalMs: MINUTE },
			instruction: "x",
			overlap: "queue",
			enabled: true,
		});
		clock.advance(MINUTE);
		await run();
		const lineOf = (id: string) =>
			logLines.find((line) => line.includes("event=monitor_script") && line.includes(`monitor=${id} `)) ?? "";
		const loudLine = lineOf(loudMonitor.id);
		expect(loudLine).toContain("exit=1");
		expect(loudLine).toContain('tail="disk missing"');
		const quietLine = lineOf(quietMonitor.id);
		expect(quietLine).toContain("exit=1");
		expect(quietLine).not.toContain("tail=");
	});

	test("an unchanged quiet unmet check logs once; a later met check logs again", async () => {
		const flag = join(dir, "flag");
		const script = writeScript("gate.sh", '#!/bin/sh\n[ -f "$1" ]\n');
		const monitor = store.monitors.addMonitor({
			name: "quietgate",
			trigger: { kind: "script", command: [script, flag], intervalMs: MINUTE },
			instruction: "x",
			overlap: "queue",
			enabled: true,
		});
		const scriptLines = () =>
			logLines.filter((line) => line.includes("event=monitor_script") && line.includes(`monitor=${monitor.id} `));
		for (let i = 0; i < 3; i++) {
			clock.advance(MINUTE);
			await run();
		}
		expect(scriptLines()).toHaveLength(1);
		expect(scriptLines()[0]).toContain("fired=false");
		writeFileSync(flag, "");
		clock.advance(MINUTE);
		await run();
		expect(scriptLines()).toHaveLength(2);
		expect(scriptLines()[1]).toContain("fired=true");
	});

	test("a script over its time limit is killed and does not fire", async () => {
		const pidFile = join(dir, "pid");
		const script = writeScript("slow.sh", '#!/bin/sh\necho $$ > "$1"\nexec sleep 30\n');
		const started = Date.now();
		// Real 300 ms: this exercises the runner's own platform timer and a real SIGKILL of a child process.
		const result = await runScript([script, pidFile], { scriptsRoot: scriptsRoot(), cwd: dir, timeoutMs: 300 });
		expect(result.timedOut).toBe(true);
		expect(result.fired).toBe(false);
		expect(Date.now() - started).toBeLessThan(10_000);
		const pid = Number(readFileSync(pidFile, "utf8").trim());
		expect(pid).toBeGreaterThan(1);
		expect(() => process.kill(pid, 0)).toThrow();
	});

	test("the scheduler runs a script at most once per interval", async () => {
		const marker = join(dir, "runs");
		const script = writeScript("count.sh", '#!/bin/sh\necho run >> "$1"\nexit 1\n');
		store.monitors.addMonitor({
			name: "gate",
			trigger: { kind: "script", command: [script, marker], intervalMs: MINUTE },
			instruction: "x",
			overlap: "queue",
			enabled: true,
		});
		const runs = () => (existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").length : 0);
		clock.advance(30_000);
		await run();
		expect(runs()).toBe(0);
		clock.advance(30_000);
		await run();
		expect(runs()).toBe(1);
		await run();
		expect(runs()).toBe(1);
		clock.advance(59_000);
		await run();
		expect(runs()).toBe(1);
		clock.advance(1_000);
		await run();
		expect(runs()).toBe(2);
		expect(store.monitors.listEvents()).toHaveLength(0);
	});

	test("a script outside the scripts directory is refused and never runs", async () => {
		const outsideDir = join(dir, "outside");
		mkdirSync(outsideDir);
		const marker = join(dir, "ran");
		const outside = writeScript("evil.sh", '#!/bin/sh\necho x > "$1"\n', outsideDir);

		const direct = await runScript([outside, marker], { scriptsRoot: scriptsRoot(), cwd: dir });
		expect(direct.fired).toBe(false);
		expect(direct.error).toContain("must live under");

		symlinkSync(outside, join(scriptsRoot(), "link.sh"));
		const viaLink = await runScript([join(scriptsRoot(), "link.sh"), marker], { scriptsRoot: scriptsRoot(), cwd: dir });
		expect(viaLink.error).toContain("must live under");

		const traversal = await runScript([`${scriptsRoot()}/../outside/evil.sh`, marker], {
			scriptsRoot: scriptsRoot(),
			cwd: dir,
		});
		expect(traversal.error).toContain("must live under");

		const relative = await runScript(["evil.sh"], { scriptsRoot: scriptsRoot(), cwd: dir });
		expect(relative.error).toContain("absolute");
		expect(existsSync(marker)).toBe(false);
	});
});

describe("monitors: script edge triggering", () => {
	/** Exit 0 while the flag file given as $1 exists. */
	const flagScript = () => writeScript("flag.sh", '#!/bin/sh\n[ -f "$1" ]\n');
	const flag = () => join(dir, "flag");
	const setFlag = (on: boolean) => (on ? writeFileSync(flag(), "x") : rmSync(flag(), { force: true }));
	const addWatch = (extra: { fire?: "edge" | "every"; once?: boolean } = {}) =>
		store.monitors.addMonitor(
			parseMonitorSpec(
				{
					name: "flagwatch",
					trigger: { kind: "script", command: [flagScript(), flag()], intervalMs: MINUTE, ...extra },
					instruction: "report the flag",
				},
				{ scriptsRoot: scriptsRoot(), defaultTimezone: "Asia/Seoul" },
			),
		);
	const events = () => store.monitors.listEvents().length;
	/** One interval later, one check. */
	async function interval() {
		clock.advance(MINUTE);
		await run();
	}

	beforeEach(() => {
		behavior.holdTurns = true;
	});

	test("edge fires once across several met intervals", async () => {
		const monitor = addWatch();
		setFlag(true);
		for (let i = 0; i < 4; i++) await interval();
		expect(events()).toBe(1);
		expect(store.monitors.getMonitor(monitor.id)?.lastScriptState).toBe("met");
	});

	test("edge re-arms after an unmet check, and a first unmet check does not fire", async () => {
		const monitor = addWatch();
		await interval();
		expect(events()).toBe(0);
		expect(store.monitors.getMonitor(monitor.id)?.lastScriptState).toBe("unmet");
		setFlag(true);
		await interval();
		await interval();
		expect(events()).toBe(1);
		setFlag(false);
		await interval();
		expect(store.monitors.getMonitor(monitor.id)?.lastScriptState).toBe("unmet");
		setFlag(true);
		await interval();
		await interval();
		expect(events()).toBe(2);
	});

	test("a check that cannot run leaves the state alone", async () => {
		const monitor = addWatch();
		setFlag(true);
		await interval();
		expect(events()).toBe(1);
		rmSync(join(scriptsRoot(), "flag.sh"));
		await interval();
		expect(store.monitors.getMonitor(monitor.id)?.lastScriptState).toBe("met");
		flagScript();
		await interval();
		expect(events()).toBe(1);
	});

	test("the edge state survives a restart: no refire while the condition stays met", async () => {
		const monitor = addWatch();
		setFlag(true);
		await interval();
		expect(events()).toBe(1);
		await scheduler.idle();

		// A second process on the same database file: only the durable state carries over.
		const reopened = openStore({
			timezone: "Asia/Seoul",
			path: join(dir, "ompbot.db"),
			clock,
			redact,
			slackOwnerUserId: OWNER,
		});
		const restarted = new MonitorScheduler({
			store: reopened,
			router: { route: async () => {}, newEpochIfIdle: async () => false },
			clock,
			log: createLogger({ sink: () => {}, clock, redact }),
			scriptsRoot: scriptsRoot(),
			workspaceDir: join(dir, "workspace"),
			homeDir: dir,
		});
		try {
			restarted.start();
			expect(reopened.monitors.getMonitor(monitor.id)?.lastScriptState).toBe("met");
			for (let i = 0; i < 3; i++) {
				clock.advance(MINUTE);
				await restarted.tick();
				await restarted.idle();
			}
			expect(reopened.monitors.listEvents()).toHaveLength(1);
			setFlag(false);
			clock.advance(MINUTE);
			await restarted.tick();
			await restarted.idle();
			setFlag(true);
			clock.advance(MINUTE);
			await restarted.tick();
			await restarted.idle();
			expect(reopened.monitors.listEvents()).toHaveLength(2);
		} finally {
			reopened.close();
		}
	});

	test("every keeps firing on each met interval", async () => {
		addWatch({ fire: "every" });
		setFlag(true);
		for (let i = 0; i < 3; i++) await interval();
		expect(events()).toBe(3);
	});

	test("once disables the monitor after its first fire", async () => {
		const monitor = addWatch({ once: true });
		setFlag(true);
		await interval();
		expect(events()).toBe(1);
		expect(store.monitors.getMonitor(monitor.id)?.enabled).toBe(false);
		setFlag(false);
		await interval();
		setFlag(true);
		await interval();
		expect(events()).toBe(1);
	});

	test("once with every also stops after the first fire; re-enabling re-arms", async () => {
		const monitor = addWatch({ fire: "every", once: true });
		setFlag(true);
		await interval();
		await interval();
		expect(events()).toBe(1);
		store.monitors.updateMonitor(monitor.id, {
			...monitor,
			channel: undefined,
			copyChannel: undefined,
			model: undefined,
			thinking: undefined,
			enabled: true,
		});
		expect(store.monitors.getMonitor(monitor.id)?.lastScriptState).toBeNull();
		await interval();
		expect(events()).toBe(2);
	});

	test("rows from before the state column read as null", () => {
		const path = join(dir, "old.db");
		const old = new Database(path, { create: true, strict: true });
		old.run(
			"CREATE TABLE monitors (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, trigger_json TEXT NOT NULL, instruction TEXT NOT NULL, overlap TEXT NOT NULL DEFAULT 'queue', enabled INTEGER NOT NULL DEFAULT 1, cursor_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
		);
		old.run(
			`INSERT INTO monitors VALUES ('mold', 'old', '{"kind":"script","command":["/x"],"intervalMs":60000}', 'i', 'queue', 1, 0, 0, 0)`,
		);
		const ledger = openMonitorLedger(path);
		try {
			expect(ledger.getMonitor("old")?.lastScriptState).toBeNull();
		} finally {
			ledger.close();
			old.close();
		}
	});

	test("three check errors in a row alert the owner once; a 4th adds none; a good check clears the streak", async () => {
		const monitor = addWatch();
		const row = () => store.monitors.getMonitor(monitor.id);
		const notices = () => store.listDeliveries({ originKey: monitorOrigin(monitor.id) });
		rmSync(join(scriptsRoot(), "flag.sh"));
		await interval();
		await interval();
		expect(row()?.checkErrorStreak).toBe(2);
		expect(row()?.lastCheckError).toBeTruthy();
		expect(row()?.lastCheckErrorAt).toBe(clock.now());
		expect(notices()).toHaveLength(0);
		await interval();
		expect(row()?.checkErrorStreak).toBe(3);
		expect(notices()).toHaveLength(1);
		expect(notices()[0]?.threadRef).toBe(`${OWNER}:-`);
		expect(notices()[0]?.body.startsWith("⏰ flagwatch\n")).toBe(true);
		expect(notices()[0]?.body).toContain("3번 연속");
		await interval();
		expect(row()?.checkErrorStreak).toBe(4);
		expect(notices()).toHaveLength(1);
		flagScript();
		await interval();
		expect([row()?.checkErrorStreak, row()?.lastCheckError, row()?.lastCheckErrorAt]).toEqual([0, null, null]);
		// The recovery resolved the incident: the next run of three errors alerts again.
		rmSync(join(scriptsRoot(), "flag.sh"));
		for (let i = 0; i < 3; i++) await interval();
		expect(notices()).toHaveLength(2);
	});

	test("rows from before the check error columns gain them with a zero streak", () => {
		const monitor = addWatch();
		const path = join(dir, "ompbot.db");
		store.close();
		const raw = new Database(path);
		raw.run("ALTER TABLE monitors DROP COLUMN last_check_error");
		raw.run("ALTER TABLE monitors DROP COLUMN last_check_error_at");
		raw.run("ALTER TABLE monitors DROP COLUMN check_error_streak");
		raw.close();
		store = openStore({ timezone: "Asia/Seoul", path, clock, redact, slackOwnerUserId: OWNER });
		const migrated = store.monitors.getMonitor(monitor.id);
		expect([migrated?.checkErrorStreak, migrated?.lastCheckError, migrated?.lastCheckErrorAt]).toEqual([0, null, null]);
	});

	test("spec: fire defaults to edge, once to false; merge inherits; bad values are rejected", () => {
		const ctx = { scriptsRoot: scriptsRoot(), defaultTimezone: "Asia/Seoul" };
		const script = flagScript();
		const base = { name: "n", trigger: { kind: "script", command: [script], intervalMs: MINUTE }, instruction: "x" };
		const spec = parseMonitorSpec(base, ctx);
		expect(spec.trigger).toMatchObject({ fire: "edge", once: false });
		const every = parseMonitorSpec({ ...base, trigger: { ...base.trigger, fire: "every", once: true } }, ctx);
		expect(mergeMonitorSpec(every, { trigger: { intervalMs: 120_000 } }, ctx).trigger).toMatchObject({
			fire: "every",
			once: true,
			intervalMs: 120_000,
		});
		expect(() => parseMonitorSpec({ ...base, trigger: { ...base.trigger, fire: "always" } }, ctx)).toThrow(
			MonitorSpecError,
		);
		expect(() => parseMonitorSpec({ ...base, trigger: { ...base.trigger, once: "yes" } }, ctx)).toThrow(
			MonitorSpecError,
		);
	});
});

describe("monitors: spec validation", () => {
	const ctx = () => ({ scriptsRoot: scriptsRoot(), defaultTimezone: "Asia/Seoul" });

	test("defaults: queue overlap, enabled, Asia/Seoul", () => {
		const spec = parseMonitorSpec(
			{ name: "n", trigger: { kind: "cron", schedule: "0 9 * * *" }, instruction: "do it" },
			ctx(),
		);
		expect(spec).toEqual({
			name: "n",
			trigger: { kind: "cron", schedule: "0 9 * * *", timezone: "Asia/Seoul" },
			instruction: "do it",
			overlap: "queue",
			enabled: true,
		});
	});

	test("rejects an instruction over 4000 characters, a bad overlap and unknown keys", () => {
		const base = { name: "n", trigger: { kind: "cron", schedule: "0 9 * * *" }, instruction: "x" };
		expect(() => parseMonitorSpec({ ...base, instruction: "x".repeat(4001) }, ctx())).toThrow(MonitorSpecError);
		expect(parseMonitorSpec({ ...base, instruction: "x".repeat(4000) }, ctx()).instruction).toHaveLength(4000);
		expect(() => parseMonitorSpec({ ...base, overlap: "later" }, ctx())).toThrow(MonitorSpecError);
		expect(() => parseMonitorSpec({ ...base, extra: 1 }, ctx())).toThrow(MonitorSpecError);
	});

	test("channel: valid ids kept, malformed rejected, update keeps or clears it", () => {
		const base = { name: "n", trigger: { kind: "cron", schedule: "0 9 * * *" }, instruction: "x" };
		expect(parseMonitorSpec({ ...base, channel: "C0123456789" }, ctx()).channel).toBe("C0123456789");
		expect(parseMonitorSpec({ ...base, channel: "G0123456789" }, ctx()).channel).toBe("G0123456789");
		expect("channel" in parseMonitorSpec(base, ctx())).toBe(false);
		for (const bad of ["", "D0123456789", "c0123456789", "C123", "C0123456789 ", 5, true]) {
			expect(() => parseMonitorSpec({ ...base, channel: bad }, ctx())).toThrow(MonitorSpecError);
		}
		expect(() => parseMonitorSpec({ ...base, chanel: "C0123456789" }, ctx())).toThrow(MonitorSpecError);
		const current = parseMonitorSpec({ ...base, channel: "C0123456789" }, ctx());
		expect(mergeMonitorSpec(current, { name: "m" }, ctx()).channel).toBe("C0123456789");
		expect("channel" in mergeMonitorSpec(current, { channel: null }, ctx())).toBe(false);
	});

	test("copyChannel: valid ids kept, malformed rejected, update keeps or clears it", () => {
		const base = { name: "n", trigger: { kind: "cron", schedule: "0 9 * * *" }, instruction: "x" };
		expect(parseMonitorSpec({ ...base, copyChannel: "C0123456789" }, ctx()).copyChannel).toBe("C0123456789");
		expect("copyChannel" in parseMonitorSpec(base, ctx())).toBe(false);
		for (const bad of ["", "D0123456789", "c0123456789", "C123", 5, true]) {
			expect(() => parseMonitorSpec({ ...base, copyChannel: bad }, ctx())).toThrow(MonitorSpecError);
		}
		const current = parseMonitorSpec({ ...base, copyChannel: "C0123456789" }, ctx());
		expect(mergeMonitorSpec(current, { name: "m" }, ctx()).copyChannel).toBe("C0123456789");
		expect("copyChannel" in mergeMonitorSpec(current, { copyChannel: null }, ctx())).toBe(false);
	});

	test("model/thinking: valid pins kept, malformed rejected, update keeps or clears them", () => {
		const base = { name: "n", trigger: { kind: "cron", schedule: "0 9 * * *" }, instruction: "x" };
		const pinned = parseMonitorSpec({ ...base, model: "anthropic/claude-opus-5-5", thinking: "max" }, ctx());
		expect(pinned.model).toBe("anthropic/claude-opus-5-5");
		expect(pinned.thinking).toBe("max");
		const plain = parseMonitorSpec(base, ctx());
		expect("model" in plain || "thinking" in plain).toBe(false);
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
			expect(parseMonitorSpec({ ...base, thinking: level }, ctx()).thinking).toBe(level);
		}
		for (const bad of ["", "opus", "/x", "a/", "a/b c", " a/b", "a/b\n", 5, true]) {
			expect(() => parseMonitorSpec({ ...base, model: bad }, ctx())).toThrow(MonitorSpecError);
		}
		for (const bad of ["", "MAX", "ultra", 3, true]) {
			expect(() => parseMonitorSpec({ ...base, thinking: bad }, ctx())).toThrow(MonitorSpecError);
		}
		expect(() => parseMonitorSpec({ ...base, modle: "a/b" }, ctx())).toThrow(MonitorSpecError);
		const kept = mergeMonitorSpec(pinned, { name: "m" }, ctx());
		expect([kept.model, kept.thinking]).toEqual(["anthropic/claude-opus-5-5", "max"]);
		const half = mergeMonitorSpec(pinned, { thinking: null }, ctx());
		expect(half.model).toBe("anthropic/claude-opus-5-5");
		expect("thinking" in half).toBe(false);
		const cleared = mergeMonitorSpec(pinned, { model: null, thinking: null }, ctx());
		expect("model" in cleared || "thinking" in cleared).toBe(false);
	});

	test("script interval below 60 seconds is rejected", () => {
		const script = writeScript("s.sh", "#!/bin/sh\nexit 0\n");
		const spec = (intervalMs: number) => ({
			name: "n",
			trigger: { kind: "script", command: [script], intervalMs },
			instruction: "x",
		});
		expect(() => parseMonitorSpec(spec(59_999), ctx())).toThrow(MonitorSpecError);
		expect(parseMonitorSpec(spec(60_000), ctx()).trigger).toMatchObject({ kind: "script", intervalMs: 60_000 });
	});

	test("an at time without an offset is read in Asia/Seoul", () => {
		const spec = parseMonitorSpec(
			{ name: "n", trigger: { kind: "at", at: "2026-06-01T09:00:00" }, instruction: "x" },
			ctx(),
		);
		expect(spec.trigger).toEqual({ kind: "at", at: "2026-06-01T00:00:00.000Z" });
	});
});

describe("monitors: event retention (gc)", () => {
	const DAY = 24 * HOUR;
	const FINAL = ["delivered", "failed_no_retry", "skipped", "no_report"];
	const OPEN = ["admitted", "dispatched", "authored", "failed"];
	let home: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "ompbot-monitor-gc-"));
		openStore({ timezone: "Asia/Seoul", path: join(home, "ompbot.db"), clock: new FakeClock(), redact }).close();
		const db = new Database(join(home, "ompbot.db"), { strict: true });
		db.run(
			"INSERT INTO monitors (id, name, trigger_json, instruction, cursor_at, created_at, updated_at) VALUES ('m1', 'm', '{}', 'x', 0, 0, 0)",
		);
		const insert = db.query(
			"INSERT INTO monitor_events (monitor_id, slot_at, stage, created_at, updated_at) VALUES ('m1', 0, ?, 0, ?)",
		);
		for (const stage of [...FINAL, ...OPEN]) insert.run(stage, T0 - 91 * DAY);
		for (const stage of FINAL) insert.run(stage, T0 - 89 * DAY);
		db.close();
	});
	afterEach(() => rmSync(home, { recursive: true, force: true }));

	function stages(): string[] {
		const db = new Database(join(home, "ompbot.db"), { readonly: true });
		try {
			return (
				db.query("SELECT stage, updated_at FROM monitor_events ORDER BY event_id").all() as Array<{
					stage: string;
					updated_at: number;
				}>
			).map((row) => `${row.stage}@${Math.round((T0 - row.updated_at) / DAY)}`);
		} finally {
			db.close();
		}
	}

	test(`final stages older than ${LEDGER_RETENTION_DAYS} days go; open stages and younger events stay`, () => {
		const result = gcSessions({ homeDir: home, retentionDays: 30, now: T0 });
		expect(result.ledgerRemoved.monitorEvents).toBe(4);
		expect(stages()).toEqual([...OPEN.map((stage) => `${stage}@91`), ...FINAL.map((stage) => `${stage}@89`)]);
	});

	test("dry-run counts them and deletes nothing", () => {
		expect(gcSessions({ homeDir: home, retentionDays: 30, now: T0, dryRun: true }).ledgerRemoved.monitorEvents).toBe(4);
		expect(stages()).toHaveLength(12);
	});
});
