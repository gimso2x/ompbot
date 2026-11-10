import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STALL_STATUS_TEXT } from "../src/channel/text";
import { doctorCommand } from "../src/cli/index";
import {
	isProviderLimit,
	type ProviderLimitInfo,
	type StallEscalation,
	type TurnProgress,
	toolActivityText,
} from "../src/core/mailbox";
import { OriginRouter, openBotStore, sessionDirFor } from "../src/core/origin";
import type { InboundRecord } from "../src/core/types";
import {
	MONITOR_STALL_ABORT_MS,
	STALL_MS,
	STALL_NOTIFY_COUNT,
	STALL_NOTIFY_MS,
	STALL_RELEASE_MS,
} from "../src/core/types";
import { Daemon, GATE_RESOLVE_CLOSED_SWEEPS } from "../src/daemon/daemon";
import { runDoctor } from "../src/daemon/doctor";
import { SWEEP_HEARTBEAT_FILE } from "../src/daemon/heartbeat";
import { renderStatusText } from "../src/daemon/status";
import { herdrSshArgv, type ProcessRunner, type RunProcessResult } from "../src/dispatch/omp";
import { createLogger } from "../src/log";
import { MONITOR_SCHEMA } from "../src/monitors/ledger";
import { OmpDriverError, type OmpEvent } from "../src/omp/driver";
import { FakeOmpDriver, type FakeOmpDriverOptions, FakeSessionStore } from "../src/omp/fake-driver";
import { STAMP_FILE } from "../src/ops/backup";
import { collectGates, INBOUND_STARVATION_MS, SWEEP_STALLED_MS, TURNS_FAILING_WINDOW_MS } from "../src/ops/gates";
import { gcSessions } from "../src/ops/gc";
import { LOG_FILES, LOG_MAX_BYTES, LogDirError, openLogSink, rotatingFileSink } from "../src/ops/logfile";
import { redact } from "../src/redact";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import type { SlackTransport } from "../src/slack/transport";
import { ALERT_INCIDENT_REPEAT_MS, type Store } from "../src/store/db";
import { makeHome, OWNER, type TestHome, WaitingTransport } from "./helpers/bot-home";
import { killSpawned, runMain, spawnDaemon } from "./helpers/daemon-process";

const ORIGIN = "slack/dm/D1";
const DAY_MS = 24 * 60 * 60 * 1000;

class FakeClock {
	t = 1_000_000;
	now(): number {
		return this.t;
	}
	advance(ms: number): void {
		this.t += ms;
	}
}

/** Fake driver whose events, steer failures and prompt failures the test controls. */
class OpsDriver extends FakeOmpDriver {
	failSteers = 0;
	failPrompts = 0;
	readonly #listeners = new Set<(event: OmpEvent) => void>();

	override async steer(text: string): Promise<void> {
		if (this.failSteers > 0) {
			this.failSteers--;
			throw new Error("steer refused");
		}
		return super.steer(text);
	}

	override async prompt(text: string): Promise<string> {
		if (this.failPrompts > 0) {
			this.failPrompts--;
			throw new OmpDriverError("rpc_error", "Could not restore model: fake/alpha");
		}
		return super.prompt(text);
	}

	override onEvent(listener: (event: OmpEvent) => void): () => void {
		this.#listeners.add(listener);
		const off = super.onEvent(listener);
		return () => {
			this.#listeners.delete(listener);
			off();
		};
	}

	/** An omp event arriving from the child. */
	fire(event: OmpEvent): void {
		for (const listener of this.#listeners) listener(event);
	}
}

let counter = 0;
function msg(text: string): InboundRecord {
	const id = `m${++counter}`;
	return { platformMessageId: id, originKey: ORIGIN, ownerVerified: true, text, threadRef: id };
}

/** Dispatch is fire-and-forget behind the 👀 ack, so a test simulating turn silence waits for `turn_start` first. */
async function untilLine(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for a log line");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("event log lines and stall detection (mailbox, fake clock)", () => {
	let dir: string;
	let clock: FakeClock;
	let store: Store;
	let router: OriginRouter;
	let drivers: OpsDriver[];
	let lines: string[];
	let stalls: Array<{ originKey: string; threadRef: string; stalled: boolean; silentMs: number }>;
	let escalations: StallEscalation[];
	let providerLimits: ProviderLimitInfo[];
	let activities: Array<{ originKey: string; threadRef: string; progress: TurnProgress }>;
	let driverOptions: FakeOmpDriverOptions;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ompbot-ops-"));
		clock = new FakeClock();
		store = openBotStore(join(dir, "ompbot.db"), clock);
		drivers = [];
		lines = [];
		stalls = [];
		escalations = [];
		providerLimits = [];
		activities = [];
		driverOptions = { holdTurns: true };
		const sessions = new FakeSessionStore();
		router = new OriginRouter({
			store,
			clock,
			sessionsRoot: join(dir, "sessions"),
			log: createLogger({ sink: (line) => lines.push(line), clock, redact }),
			statusProvider: () => "status",
			onStall: (info) => stalls.push(info),
			onStallEscalate: (info) => escalations.push(info),
			onProviderLimit: (info) => providerLimits.push(info),
			onProgress: (info) => activities.push(info),
			driverFactory: (_origin, sessionDir) => {
				const driver = new OpsDriver({ ...driverOptions, sessionDir, store: sessions });
				drivers.push(driver);
				return driver;
			},
		});
	});

	afterEach(async () => {
		await router.close();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("turn_start, steer_delivered, steer_failed action=defer and omp_exit are key=value lines", async () => {
		await router.route(msg("first"));
		await router.route(msg("second"));
		const driver = drivers[0];
		if (!driver) throw new Error("no driver was started");
		driver.failSteers = 1;
		await router.route(msg("third"));
		driver.crash(137);
		await router.mailbox(ORIGIN).sweepIdle(); // runs behind the exit handler on the actor's chain

		expect(lines.find((l) => l.includes("event=turn_start"))).toMatch(
			/ level=info event=turn_start origin=slack\/dm\/D1 epoch=1 opRef=\S+$/,
		);
		expect(lines.find((l) => l.includes("event=steer_delivered"))).toMatch(
			/ level=info event=steer_delivered origin=slack\/dm\/D1 id=m\d+ opRef=\S+$/,
		);
		expect(lines.find((l) => l.includes("event=steer_failed"))).toMatch(
			/ level=warn event=steer_failed origin=slack\/dm\/D1 id=m\d+ action=defer error=/,
		);
		expect(lines.find((l) => l.includes("event=omp_exit"))).toMatch(
			/ level=warn event=omp_exit origin=slack\/dm\/D1 code=137 expected=false$/,
		);
	});

	test("a turn with no event for 120 s raises one stall_alert; an event clears it and re-arms the detector", async () => {
		await router.route(msg("long task"));
		const driver = drivers[0];
		if (!driver) throw new Error("no driver was started");
		const turn = store.listInbound({ originKey: ORIGIN })[0];

		clock.advance(STALL_MS - 1);
		expect(router.sweepStalls()).toBe(0);
		expect(lines.some((l) => l.includes("stall_alert"))).toBe(false);

		clock.advance(1);
		expect(router.sweepStalls()).toBe(1);
		const alert = lines.filter((l) => l.includes("event=stall_alert"));
		expect(alert).toHaveLength(1);
		expect(alert[0]).toMatch(/ level=warn event=stall_alert origin=slack\/dm\/D1 silentMs=120000 opRef=\S+$/);
		expect(stalls).toEqual([
			{ originKey: ORIGIN, threadRef: turn?.threadRef ?? "missing", stalled: true, silentMs: STALL_MS },
		]);

		clock.advance(STALL_MS); // still silent: no second alert for the same silence
		expect(router.sweepStalls()).toBe(0);
		expect(lines.filter((l) => l.includes("event=stall_alert"))).toHaveLength(1);

		driver.fire({ type: "tool_execution_update" });
		expect(lines.some((l) => l.includes("event=stall_cleared"))).toBe(true);

		clock.advance(STALL_MS - 1);
		expect(router.sweepStalls()).toBe(0);
		clock.advance(1);
		expect(router.sweepStalls()).toBe(1); // a new silence of the same turn is a new stall, merged into the alert
		expect(lines.filter((l) => l.includes("event=stall_alert"))).toHaveLength(1);
		expect(lines.filter((l) => l.includes("event=stall_repeat"))).toHaveLength(1);
	});

	test("repeated stalls of one turn log stall_alert once then stall_repeat; the status text does not flip", async () => {
		await router.route(msg("long task"));
		const driver = drivers[0];
		if (!driver) throw new Error("no driver was started");
		// The 2026-10-30 pattern: 2 min silence, one event, 3 min calm... silence again.
		for (let round = 0; round < 3; round++) {
			clock.advance(STALL_MS);
			expect(router.sweepStalls()).toBe(1);
			clock.advance(8 * 60_000);
			driver.fire({ type: "tool_execution_update" });
			clock.advance(3 * 60_000 - STALL_MS); // below the release window: the next stall comes first
		}
		expect(lines.filter((l) => l.includes("event=stall_alert"))).toHaveLength(1);
		const repeats = lines.filter((l) => l.includes("event=stall_repeat"));
		expect(repeats).toHaveLength(2);
		expect(repeats[1]).toMatch(/ count=3 totalSilentMs=\d+$/);
		expect(stalls.map((s) => s.stalled)).toEqual([true]);
	});

	test("the stalled status text is released once the turn runs past the release window without stalling", async () => {
		await router.route(msg("long task"));
		const driver = drivers[0];
		if (!driver) throw new Error("no driver was started");
		clock.advance(STALL_MS);
		router.sweepStalls();
		driver.fire({ type: "tool_execution_update" });
		clock.advance(STALL_RELEASE_MS - 1);
		driver.fire({ type: "tool_execution_update" }); // keeps the turn lively but is not a reason to release yet
		router.sweepStalls();
		expect(stalls.map((s) => s.stalled)).toEqual([true]);
		clock.advance(1);
		router.sweepStalls();
		expect(stalls.map((s) => s.stalled)).toEqual([true, false]);
		expect(lines.some((l) => l.includes("event=stall_released"))).toBe(true);
	});

	test("conversation origin: the third stall of a turn asks the owner once and never aborts the turn", async () => {
		await router.route(msg("long task"));
		const driver = drivers[0];
		if (!driver) throw new Error("no driver was started");
		for (let round = 0; round < STALL_NOTIFY_COUNT; round++) {
			expect(escalations).toHaveLength(0);
			clock.advance(STALL_MS);
			router.sweepStalls();
			clock.advance(60_000);
			driver.fire({ type: "tool_execution_update" });
		}
		expect(escalations).toHaveLength(1);
		expect(escalations[0]).toMatchObject({ originKey: ORIGIN, kind: "notify", count: STALL_NOTIFY_COUNT });
		clock.advance(STALL_MS);
		router.sweepStalls(); // a fourth stall of the same turn: no second DM
		clock.advance(60 * 60_000);
		router.sweepStalls();
		expect(escalations).toHaveLength(1);
		expect(driver.calls).not.toContain("abort");
		expect(lines.filter((l) => l.includes("event=stall_escalated"))).toHaveLength(1);
	});

	test("conversation origin: one long silence past the time threshold asks the owner once", async () => {
		await router.route(msg("stuck forever"));
		clock.advance(STALL_MS);
		router.sweepStalls();
		clock.advance(STALL_NOTIFY_MS - STALL_MS - 1);
		router.sweepStalls();
		expect(escalations).toHaveLength(0);
		clock.advance(1);
		router.sweepStalls();
		clock.advance(5 * 60_000);
		router.sweepStalls();
		expect(escalations).toHaveLength(1);
		expect(escalations[0]).toMatchObject({ kind: "notify", count: 1, totalSilentMs: STALL_NOTIFY_MS });
		expect(store.listInbound({ originKey: ORIGIN })[0]?.state).toBe("dispatched");
	});

	test("a new turn of the same origin counts its stalls from zero", async () => {
		await router.route(msg("first"));
		const driver = drivers[0];
		if (!driver) throw new Error("no driver was started");
		for (let round = 0; round < 2; round++) {
			clock.advance(STALL_MS);
			router.sweepStalls();
			driver.fire({ type: "tool_execution_update" });
		}
		driver.release();
		await untilLine(() => store.listInbound({ originKey: ORIGIN }).every((r) => r.state !== "dispatched"));
		await router.route(msg("second"));
		clock.advance(STALL_MS);
		router.sweepStalls();
		expect(lines.filter((l) => l.includes("event=stall_alert"))).toHaveLength(2);
		expect(escalations).toHaveLength(0);
	});

	test("monitor origin: silence past the abort threshold aborts the turn, fails the monitor event and tells the owner once", async () => {
		const monitor = store.monitors.addMonitor({
			name: "watch",
			trigger: { kind: "cron", schedule: "0 0 1 1 *", timezone: "UTC" },
			instruction: "check",
			overlap: "queue",
			enabled: true,
		});
		const event = store.monitors.admitManual(monitor.id);
		const origin = `monitor/${monitor.id}`;
		expect(store.monitors.markDispatched(event.eventId, `monitor:${monitor.id}:${event.eventId}:1`)).toBe(true);
		await router.route({
			platformMessageId: `monitor:${monitor.id}:${event.eventId}:1`,
			originKey: origin,
			ownerVerified: true,
			text: "check",
			threadRef: store.topLevelThreadRef(),
		});
		await untilLine(() => lines.some((l) => l.includes("event=turn_start")));
		const driver = drivers[0];
		if (!driver) throw new Error("no driver was started");

		clock.advance(STALL_MS);
		router.sweepStalls();
		clock.advance(MONITOR_STALL_ABORT_MS - STALL_MS - 1);
		router.sweepStalls();
		expect(escalations).toHaveLength(0);
		expect(driver.calls).not.toContain("abort");

		clock.advance(1);
		router.sweepStalls();
		await untilLine(() => store.monitors.getEvent(event.eventId)?.stage === "failed");
		expect(driver.calls).toContain("abort");
		expect(escalations).toHaveLength(1);
		expect(escalations[0]).toMatchObject({ originKey: origin, kind: "abort", totalSilentMs: MONITOR_STALL_ABORT_MS });
		expect(store.monitors.getEvent(event.eventId)?.error).toContain("stall_abort");
		expect(router.mailbox(origin).state.busy).toBe(false);
		router.sweepStalls();
		expect(escalations).toHaveLength(1);
	});

	test("monitor origin: a failure while settling the aborted turn is logged as stall_abort_settle_failed", async () => {
		const monitor = store.monitors.addMonitor({
			name: "watch",
			trigger: { kind: "cron", schedule: "0 0 1 1 *", timezone: "UTC" },
			instruction: "check",
			overlap: "queue",
			enabled: true,
		});
		const event = store.monitors.admitManual(monitor.id);
		const origin = `monitor/${monitor.id}`;
		expect(store.monitors.markDispatched(event.eventId, `monitor:${monitor.id}:${event.eventId}:1`)).toBe(true);
		await router.route({
			platformMessageId: `monitor:${monitor.id}:${event.eventId}:1`,
			originKey: origin,
			ownerVerified: true,
			text: "check",
			threadRef: store.topLevelThreadRef(),
		});
		await untilLine(() => lines.some((l) => l.includes("event=turn_start")));
		store.recordTurnFailure = () => {
			throw new Error("ledger write failed");
		};
		clock.advance(MONITOR_STALL_ABORT_MS);
		router.sweepStalls();
		await untilLine(() => lines.some((l) => l.includes("event=stall_abort_settle_failed")));
		expect(lines.some((l) => l.includes("event=stall_abort_settle_failed") && l.includes("ledger write failed"))).toBe(
			true,
		);
		expect(lines.some((l) => l.includes("event=stall_abort_failed"))).toBe(false);
	});

	test("monitor origin: a fire queued behind the stalled turn runs on a fresh child after the abort", async () => {
		const monitor = store.monitors.addMonitor({
			name: "watch",
			trigger: { kind: "cron", schedule: "0 0 1 1 *", timezone: "UTC" },
			instruction: "check",
			overlap: "queue",
			enabled: true,
		});
		const origin = `monitor/${monitor.id}`;
		const fire = async (): Promise<void> => {
			const event = store.monitors.admitManual(monitor.id);
			const id = `monitor:${monitor.id}:${event.eventId}:1`;
			expect(store.monitors.markDispatched(event.eventId, id)).toBe(true);
			await router.route({
				platformMessageId: id,
				originKey: origin,
				ownerVerified: true,
				text: "check",
				threadRef: store.topLevelThreadRef(),
			});
		};
		await fire();
		await untilLine(() => lines.some((l) => l.includes("event=turn_start")));
		const first = drivers[0];
		if (!first) throw new Error("no driver was started");
		first.failSteers = 1; // the steer fails: the row stays pending behind the running turn
		await fire();

		clock.advance(MONITOR_STALL_ABORT_MS);
		router.sweepStalls();
		await untilLine(() => drivers.length === 2);
		expect(first.calls).toContain("abort");
		await untilLine(() => drivers[1]?.calls.some((c) => c.startsWith("prompt:")) === true);
		expect(first.calls.filter((c) => c.startsWith("prompt:"))).toHaveLength(1);
	});

	test("no stall_alert while a host tool (approval wait) runs; silence after it returns alerts as before", async () => {
		await router.route(msg("deploy"));
		const mailbox = router.mailbox(ORIGIN);
		const click = Promise.withResolvers<string>();
		const approval = mailbox.trackHostTool(() => click.promise);
		expect(router.hostToolsRunning()).toBe(1);

		clock.advance(3 * STALL_MS); // the owner takes minutes to click
		expect(router.sweepStalls()).toBe(0);
		clock.advance(2 * STALL_NOTIFY_MS);
		expect(router.sweepStalls()).toBe(0);
		expect(escalations).toHaveLength(0);
		expect(lines.some((l) => l.includes("event=stall_alert"))).toBe(false);

		click.resolve("approved");
		expect(await approval).toBe("approved");
		expect(router.hostToolsRunning()).toBe(0);
		// The silence is measured from the tool's return, not from the turn's last omp event.
		clock.advance(STALL_MS - 1);
		expect(router.sweepStalls()).toBe(0);
		clock.advance(1);
		expect(router.sweepStalls()).toBe(1);
		expect(lines.filter((l) => l.includes("event=stall_alert"))).toHaveLength(1);
	});

	test("a failing host tool still ends its rest from stall detection", async () => {
		await router.route(msg("upload"));
		const mailbox = router.mailbox(ORIGIN);
		await expect(mailbox.trackHostTool(() => Promise.reject(new Error("upload refused")))).rejects.toThrow(
			"upload refused",
		);
		expect(mailbox.hostToolsRunning).toBe(0);
		clock.advance(STALL_MS);
		expect(router.sweepStalls()).toBe(1);
	});

	test("an idle origin never raises a stall", async () => {
		await router.route(msg("quick"));
		const driver = drivers[0];
		if (!driver) throw new Error("no driver was started");
		const settled = new Promise<void>((resolve) => driver.onFinal(() => resolve()));
		driver.release();
		await settled;
		await router.mailbox(ORIGIN).sweepIdle(); // runs behind the final handler on the actor's chain
		clock.advance(10 * STALL_MS);
		expect(router.sweepStalls()).toBe(0);
	});

	test("a long turn that keeps emitting events keeps inbound_starved closed; silence opens it", async () => {
		await router.route(msg("long task"));
		const driver = drivers[0];
		if (!driver) throw new Error("no driver was started");
		const starved = () => collectGates({ homeDir: dir, now: clock.t }).find((g) => g.name === "inbound_starved");

		for (let i = 0; i < 4; i++) {
			clock.advance(INBOUND_STARVATION_MS - 60_000);
			driver.fire({ type: "tool_execution_update" });
		}
		expect(starved()?.state).toBe("closed");

		clock.advance(INBOUND_STARVATION_MS);
		expect(starved()?.state).toBe("open");
	});

	test("tool_execution_start reaches onProgress: the tool count and one line per call (tool name plus short args)", async () => {
		driverOptions.toolCalls = [
			{ name: "bash", args: { command: "git status", cwd: "/tmp" } },
			{ name: "read", args: { file_path: "a.ts" } },
		];
		const record = msg("job");
		await router.route(record);
		// The fake driver reports tool calls from a macrotask (socket delivery), after the turn is recorded.
		await untilLine(() => activities.length >= 2);
		const base = { steers: 0, retries: 0 };
		expect(activities).toEqual([
			{
				originKey: ORIGIN,
				threadRef: record.threadRef,
				progress: { ...base, tools: 1, recentTools: ["bash command=git status"] },
			},
			{
				originKey: ORIGIN,
				threadRef: record.threadRef,
				progress: { ...base, tools: 2, recentTools: ["bash command=git status", "read file_path=a.ts"] },
			},
		]);
		// The events still count as turn events: no stall is raised while tools keep starting.
		expect(lines.some((l) => l.includes("event=stall_alert"))).toBe(false);
	});

	test("progress: todo results, steered messages and model retries reach onProgress; view reads and errors do not", async () => {
		const record = msg("job");
		await router.route(record);
		const driver = drivers[0];
		if (!driver) throw new Error("no driver was started");
		const phases = [
			{
				name: "구현",
				tasks: [
					{ content: "드라이버", status: "completed" },
					{ content: "카드", status: "in_progress" },
					{ content: "버린 일", status: "abandoned" },
					{ content: "문서", status: "pending" },
				],
			},
		];
		const todoEnd = (op: string, isError = false): OmpEvent => ({
			type: "tool_execution_end",
			toolName: "todo",
			isError,
			result: { content: [], details: { op, phases } },
		});
		driver.fire(todoEnd("view"));
		driver.fire(todoEnd("done", true));
		expect(activities).toEqual([]);
		driver.fire(todoEnd("start"));
		driver.fire({ type: "auto_retry_start", attempt: 2, maxAttempts: 5, delayMs: 1, errorMessage: "timeout" });
		await router.route(msg("추가 지시"));
		const todo = { done: 1, total: 3, current: "카드" };
		expect(activities.map((a) => a.progress)).toEqual([
			{ tools: 0, recentTools: [], steers: 0, retries: 0, todo },
			{ tools: 0, recentTools: [], steers: 0, retries: 2, todo },
			{ tools: 0, recentTools: [], steers: 1, retries: 2, todo },
		]);
		expect(activities.every((a) => a.threadRef === record.threadRef)).toBe(true);
	});

	const ZAI_LIMIT_ERROR =
		'429 {"type":"error","error":{"type":"rate_limit_error","code":"1310","message":"[1310][Weekly/Monthly Limit Exhausted]"}}';
	const TIMEOUT_ERROR = "OpenAI completions stream timed out while waiting for the first event";
	const retryStart = (errorMessage: unknown): OmpEvent => ({
		type: "auto_retry_start",
		attempt: 1,
		maxAttempts: 10,
		delayMs: 500,
		errorMessage,
	});

	test("provider limit: the fake driver's scripted auto_retry_start calls onProviderLimit once, even when repeated", async () => {
		driverOptions.events = [retryStart(ZAI_LIMIT_ERROR)];
		const record = msg("job");
		await router.route(record);
		await untilLine(() => providerLimits.length >= 1);
		const driver = drivers[0];
		if (!driver) throw new Error("no driver was started");
		driver.fire(retryStart(ZAI_LIMIT_ERROR));
		driver.fire({ ...retryStart(ZAI_LIMIT_ERROR), attempt: 2 });
		expect(providerLimits).toEqual([
			{ originKey: ORIGIN, threadRef: record.threadRef, attempt: 1, maxAttempts: 10, errorMessage: ZAI_LIMIT_ERROR },
		]);
		expect(lines.filter((l) => l.includes("event=provider_limit_hit"))).toHaveLength(1);
		expect(lines.some((l) => l.includes("event=provider_limit_hit") && l.includes("Limit Exhausted"))).toBe(true);
	});

	test("provider limit: a first-event timeout, malformed errorMessage values and malformed auto_retry_end events do not call the hook", async () => {
		await router.route(msg("job"));
		await untilLine(() => lines.some((l) => l.includes("event=turn_start")));
		const driver = drivers[0];
		if (!driver) throw new Error("no driver was started");
		driver.fire(retryStart(TIMEOUT_ERROR));
		driver.fire(retryStart(undefined));
		driver.fire(retryStart(429));
		driver.fire({ type: "auto_retry_start", attempt: 1 });
		driver.fire({ type: "auto_retry_end", success: false, attempt: 3 }); // no finalError
		driver.fire({ type: "auto_retry_end", success: false, attempt: 3, finalError: 429 });
		driver.fire({ type: "auto_retry_end", success: true, attempt: 2, finalError: "429 rate_limit_error" });
		expect(providerLimits).toEqual([]);
		expect(lines.some((l) => l.includes("event=provider_limit_hit"))).toBe(false);
		driver.release();
	});

	test("provider limit: auto_retry_end with finalError alone (retry.maxDelayMs path) calls the hook with maxAttempts 0, once per turn with a later retry start", async () => {
		const record = msg("job");
		await router.route(record);
		await untilLine(() => lines.some((l) => l.includes("event=turn_start")));
		const driver = drivers[0];
		if (!driver) throw new Error("no driver was started");
		driver.fire({
			type: "auto_retry_end",
			success: false,
			attempt: 3,
			finalError: "exceeds retry.maxDelayMs … Original error: 429 rate_limit_error",
		});
		driver.fire(retryStart(ZAI_LIMIT_ERROR));
		expect(providerLimits).toEqual([
			{
				originKey: ORIGIN,
				threadRef: record.threadRef,
				attempt: 3,
				maxAttempts: 0,
				errorMessage: "exceeds retry.maxDelayMs … Original error: 429 rate_limit_error",
			},
		]);
		driver.release();
	});

	test("provider limit: retry and fallback events do not refresh the stall clock", async () => {
		await router.route(msg("job"));
		await untilLine(() => lines.some((l) => l.includes("event=turn_start")));
		const driver = drivers[0];
		if (!driver) throw new Error("no driver was started");
		clock.advance(STALL_MS);
		expect(router.sweepStalls()).toBe(1);
		expect(lines.some((l) => l.includes("event=stall_alert"))).toBe(true);
		driver.fire(retryStart(ZAI_LIMIT_ERROR));
		driver.fire({ type: "retry_fallback_applied", from: "zai/a", to: "zai/b", role: "default", reason: "429" });
		expect(lines.some((l) => l.includes("event=stall_cleared"))).toBe(false);
		expect(lines.some((l) => l.includes("event=retry_fallback_applied") && l.includes("to=zai/b"))).toBe(true);
		driver.fire({ type: "message_update" }); // a real event still clears it
		expect(lines.some((l) => l.includes("event=stall_cleared"))).toBe(true);
		driver.release();
	});

	test("provider limit: isProviderLimit separates usage limits from other retry causes", () => {
		for (const message of [
			ZAI_LIMIT_ERROR,
			"429 Too Many Requests",
			"You exceeded your quota",
			"Usage limit reached",
			"rate_limit",
		]) {
			expect(isProviderLimit(message)).toBe(true);
		}
		for (const message of [TIMEOUT_ERROR, "connection reset", "overloaded_error 529", "", "error 14290"]) {
			expect(isProviderLimit(message)).toBe(false);
		}
	});

	test("toolActivityText prefers naming keys, keeps at most two scalars and degrades to the tool name", () => {
		expect(toolActivityText("bash", { command: "git status", cwd: "/tmp" })).toBe("bash command=git status");
		expect(toolActivityText("web", { q: "omp slack", depth: 2 })).toBe("web q=omp slack depth=2"); // no naming key: first two
		expect(toolActivityText("mcp", { payload: { nested: true } })).toBe("mcp"); // non-scalar args are not shown
		expect(toolActivityText("bash", "git push --force")).toBe("bash git push --force");
		expect(toolActivityText("bash", undefined)).toBe("bash");
		// omp's intent (or an `i` left in the args) names the call better than a heredoc's first characters.
		expect(toolActivityText("bash", { command: "cat > /tmp/a.js <<'EOF'" }, "Reading  Slack\nthread")).toBe(
			"bash · Reading Slack thread",
		);
		expect(toolActivityText("read", { path: "a.ts", i: "Reading config" })).toBe("read · Reading config");
		expect(toolActivityText("bash", { command: "git status" }, "  ")).toBe("bash command=git status");
	});
});

/** Records every chat.update text so a test can await the one it expects. */
class UpdateWatchingTransport extends WaitingTransport {
	readonly updates: string[] = [];
	readonly #waiters = new Set<() => void>();

	override async updateMessage(args: Parameters<WaitingTransport["updateMessage"]>[0]): Promise<void> {
		await super.updateMessage(args);
		this.updates.push(args.text);
		for (const waiter of [...this.#waiters]) waiter();
	}

	/** Resolves on the first update at or after index `from` whose text satisfies `match` (bounded wait). */
	waitForUpdate(match: (text: string) => boolean, from = 0, timeoutMs = 10_000): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const check = () => {
			if (!this.updates.slice(from).some(match)) return;
			clearTimeout(timer);
			this.#waiters.delete(check);
			resolve();
		};
		const timer = setTimeout(() => {
			this.#waiters.delete(check);
			reject(new Error(`timed out waiting for a status update; saw ${JSON.stringify(this.updates)}`));
		}, timeoutMs);
		this.#waiters.add(check);
		check();
		return promise;
	}
}

describe("daemon surface: status text, stall status, delivery_state", () => {
	let home: TestHome;
	let clock: FakeClock;
	let transport: UpdateWatchingTransport;
	let daemon: Daemon;
	let drivers: OpsDriver[];
	let lines: string[];

	beforeEach(() => {
		home = makeHome("ompbot-ops-daemon-");
		clock = new FakeClock();
		clock.t = Date.now();
		transport = new UpdateWatchingTransport();
		drivers = [];
		lines = [];
	});

	afterEach(async () => {
		await daemon?.stop();
		killSpawned();
		home.remove();
	});

	async function startDaemon(holdTurns: boolean, toolCalls?: FakeOmpDriverOptions["toolCalls"]): Promise<void> {
		const sessions = new FakeSessionStore();
		daemon = new Daemon({
			config: home.config,
			channels: [new SlackBinding(new SlackChannel(transport))],
			clock,
			log: createLogger({ sink: (line) => lines.push(line), clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			driverFactory: (_origin, sessionDir) => {
				const driver = new OpsDriver({ sessionDir, store: sessions, holdTurns, ...(toolCalls ? { toolCalls } : {}) });
				drivers.push(driver);
				return driver;
			},
		});
		await daemon.start();
	}

	test("the status message shows '⏸ 응답 없음 2분' after 120 s of silence and returns to '⏳' when events resume", async () => {
		await startDaemon(true);
		await daemon.inject({ origin: ORIGIN, asOwner: true, text: "long task" });
		await untilLine(() => lines.some((l) => l.includes("event=turn_start")));
		const driver = drivers[0];
		if (!driver) throw new Error("no driver was started");

		clock.advance(STALL_MS);
		const stalled = transport.waitForUpdate((text) => text.startsWith(STALL_STATUS_TEXT));
		await daemon.sweep();
		await stalled;
		expect(lines.some((l) => l.includes("event=stall_alert"))).toBe(true);

		// Events resuming do not flip the text back at once (stalls of one turn are merged)...
		driver.fire({ type: "message_update" });
		await daemon.sweep();
		expect(transport.updates.at(-1)?.startsWith(STALL_STATUS_TEXT)).toBe(true);
		// ...only a calm stretch of STALL_RELEASE_MS after the clearing event releases it.
		const before = transport.updates.length;
		clock.advance(STALL_RELEASE_MS);
		driver.fire({ type: "message_update" });
		const released = transport.waitForUpdate((text) => text.startsWith("⏳ 작업 중"), before);
		await daemon.sweep();
		await released;

		driver.release();
		await transport.waitForPosts((text) => text.includes("ECHO long task"));
	});

	test("the running status shows '⏳ 작업 중 · mm:ss · 도구 N회' plus the tool lines, and the stall text takes the first line", async () => {
		await startDaemon(true, [{ name: "bash", args: { command: "git status" } }]);
		await daemon.inject({ origin: ORIGIN, asOwner: true, text: "long task" });
		await untilLine(() => lines.some((l) => l.includes("event=turn_start")));
		const driver = drivers[0];
		if (!driver) throw new Error("no driver was started");

		// Tool activity is stored as it happens and rendered on the regular 15 s cadence.
		clock.advance(16_000);
		const withActivity = transport.waitForUpdate((text) => text.includes("bash command=git status"));
		await daemon.sweep();
		await withActivity;
		expect(transport.updates.at(-1)).toMatch(/^⏳ 작업 중 · \d{2}:\d{2} · 도구 1회\n· bash command=git status$/);

		// Silence puts the stall text on the first line; the progress lines stay under it.
		clock.advance(STALL_MS);
		await daemon.sweep();
		const stalled = transport.updates.at(-1)?.split("\n") ?? [];
		expect(stalled[0]?.startsWith(`${STALL_STATUS_TEXT} · `)).toBe(true);
		expect(stalled.slice(1)).toEqual(["· bash command=git status"]);

		// Events resume: back to ⏳ with the last known activity.
		driver.fire({ type: "message_update" });
		await transport.waitForUpdate((text) => text.startsWith("⏳ 작업 중") && text.includes("bash"));
		driver.release();
		await transport.waitForPosts((text) => text.includes("ECHO long task"));
	});

	test("delivery rows log from=new -> pending -> inflight -> confirmed", async () => {
		await startDaemon(false);
		await daemon.inject({ origin: ORIGIN, asOwner: true, text: "hello" });
		await transport.waitForPosts((text) => text.includes("ECHO hello"));
		await daemon.pump(); // the confirm of the delivery runs behind the post
		const states = lines
			.filter((l) => l.includes("event=delivery_state"))
			.map((l) => /from=(\S+) to=(\S+)/.exec(l)?.slice(1));
		expect(states).toEqual([
			["new", "pending"],
			["pending", "inflight"],
			["inflight", "confirmed"],
		]);
		expect(lines.find((l) => l.includes("event=delivery_state"))).toMatch(
			/ event=delivery_state id=1 from=new to=pending$/,
		);
	});

	test("/status-ompbot answers exactly what `ompbot status` prints", async () => {
		await startDaemon(false);
		await daemon.inject({ origin: ORIGIN, asOwner: true, text: "hello" });
		await transport.waitForPosts((text) => text.includes("ECHO hello"));
		await daemon.pump();
		const ack = await transport.emitSlash({ command: "/status-ompbot", user_id: OWNER, channel_id: "D1" });
		const cli = await runMain(home.dir, ["status"]);
		expect(cli.code, cli.stderr).toBe(0);
		expect(ack?.text).toContain("데몬 실행 중");
		expect(cli.stdout).toBe(`${ack?.text}\n`);
		expect(ack?.text).toBe(renderStatusText(daemon.status()));
	});

	test("/model-ompbot answers at the top level where it was typed: empty ack, no placeholder root post", async () => {
		await startDaemon(false);
		for (const [i, channel] of ["D1", "C1"].entries()) {
			const ack = await transport.emitSlash({ command: "/model-ompbot", user_id: OWNER, channel_id: channel });
			expect(ack).toBeUndefined();
			await transport.waitForPosts((text) => text.includes("현재 모델:"), i + 1);
		}
		const answers = transport.posts((text) => text.includes("현재 모델:"));
		expect(answers.map((post) => [post.channel, post.threadTs])).toEqual([
			["D1", undefined],
			["C1", undefined],
		]);
		expect(transport.posts((text) => text.startsWith("🧪 inject"))).toEqual([]);
	});
});

describe("alert incidents: owner-notice repeat suppression (store)", () => {
	test("first occurrence notifies, the same sign stays quiet 24h, then re-alerts; resolve re-arms", () => {
		const dir = mkdtempSync(join(tmpdir(), "ompbot-incidents-"));
		const clock = new FakeClock();
		const store = openBotStore(join(dir, "ompbot.db"), clock);
		try {
			const scope = "turns:slack/dm/D1";
			expect(store.recordAlertIncident(scope, "Could not restore model: x", clock.now())).toMatchObject({
				notify: true,
				count: 1,
			});
			clock.advance(60_000);
			expect(store.recordAlertIncident(scope, "Could not restore model: x", clock.now())).toMatchObject({
				notify: false,
				count: 2,
			});
			clock.advance(ALERT_INCIDENT_REPEAT_MS);
			expect(store.recordAlertIncident(scope, "Could not restore model: x", clock.now())).toMatchObject({
				notify: true,
				count: 3,
			});
			store.resolveAlertIncidents(scope);
			clock.advance(60_000);
			expect(store.recordAlertIncident(scope, "Could not restore model: x", clock.now())).toMatchObject({
				notify: true,
				count: 1,
			});
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/** Writes a backup stamp dated now, so the backup_age gate closes. */
function writeBackupStamp(homeDir: string): void {
	mkdirSync(join(homeDir, "backups"), { recursive: true });
	writeFileSync(
		join(homeDir, "backups", STAMP_FILE),
		`ts=${new Date().toISOString()} file=ompbot-x.db bytes=1 sha256=abc integrity=ok check=quick_check\n`,
	);
}

describe("daemon self-diagnosis (무인 신뢰성 루프: 자가 보고)", () => {
	let home: TestHome;
	let clock: FakeClock;
	let transport: WaitingTransport;
	let daemon: Daemon;
	let drivers: OpsDriver[];
	let lines: string[];

	beforeEach(() => {
		home = makeHome("ompbot-ops-selfdiag-");
		clock = new FakeClock();
		clock.t = Date.now();
		transport = new WaitingTransport();
		drivers = [];
		lines = [];
	});

	afterEach(async () => {
		await daemon?.stop();
		killSpawned();
		home.remove();
	});

	async function startDaemon(options: { gateSweepMs?: number; failPrompts?: number } = {}): Promise<void> {
		const sessions = new FakeSessionStore();
		const failPrompts = options.failPrompts ?? 0;
		daemon = new Daemon({
			config: home.config,
			channels: [new SlackBinding(new SlackChannel(transport))],
			clock,
			log: createLogger({ sink: (line) => lines.push(line), clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			...(options.gateSweepMs === undefined ? {} : { gateSweepMs: options.gateSweepMs }),
			driverFactory: (_origin, sessionDir) => {
				const driver = new OpsDriver({ sessionDir, store: sessions });
				driver.failPrompts = failPrompts;
				drivers.push(driver);
				return driver;
			},
		});
		await daemon.start();
	}

	test("a gate opening DMs the owner once, recovery reports, a quick re-open stays quiet (24h suppression)", async () => {
		await startDaemon({ gateSweepMs: 5_000 }); // no backup stamp -> backup_age is open from boot
		const opened = transport.waitForPosts((text) => text.includes("게이트 backup_age 열림"));
		await daemon.sweep();
		await opened;
		expect(transport.posts((text) => text.includes("[자가진단] 게이트 backup_age"))).toHaveLength(1);

		writeBackupStamp(home.dir);
		clock.advance(6_000);
		const recovered = transport.waitForPosts((text) => text.includes("게이트 backup_age 회복"));
		await daemon.sweep();
		await recovered;

		rmSync(join(home.dir, "backups", STAMP_FILE)); // flaps open again within 24h
		clock.advance(6_000);
		await daemon.sweep();
		expect(transport.posts((text) => text.includes("게이트 backup_age 열림"))).toHaveLength(1);
	});

	test("a socket down for 10+ minutes DMs the owner once (self-report, fake clock)", async () => {
		await startDaemon({ gateSweepMs: 5_000 });
		writeBackupStamp(home.dir);
		const downSince = clock.now();
		(transport as { connectionState?: SlackTransport["connectionState"] }).connectionState = () => ({
			state: "down",
			since: downSince,
		});
		await daemon.sweep(); // the beat stamps socket=down
		clock.advance(10 * 60_000 + 1_000);
		const opened = transport.waitForPosts((text) => text.includes("게이트 slack_disconnected 열림"));
		await daemon.sweep(); // the gate pass reads the stamp of the previous beat
		await opened;
		const posted = transport.posts((text) => text.includes("[자가진단] 게이트 slack_disconnected"));
		expect(posted).toHaveLength(1);
		expect(posted[0]?.text).toContain("🚨 [자가진단] 게이트 slack_disconnected 열림");
	});

	test("three failed turns DM the owner once, further failures stay quiet, /status lists the open gate", async () => {
		await startDaemon({ failPrompts: 99 }); // every prompt fails with the stale-model sign
		const dm = transport.waitForPosts((text) => text.includes("연속 실패"));
		for (let i = 0; i < 3; i++) {
			await daemon.inject({ origin: ORIGIN, asOwner: true, text: `job ${i}` });
		}
		await dm;
		const posted = transport.posts((text) => text.includes("연속 실패"));
		expect(posted).toHaveLength(1);
		expect(posted[0]?.text).toContain(ORIGIN);
		expect(posted[0]?.text).toContain("3번 연속 실패");
		expect(posted[0]?.channel).toBe("D1"); // the owner DM, not the failing thread
		expect(lines.some((line) => line.includes("event=turn_failures_notified"))).toBe(true);

		await daemon.inject({ origin: ORIGIN, asOwner: true, text: "job 3" });
		await transport.waitForPosts((text) => text.startsWith("[turn failed]"), 4);
		expect(transport.posts((text) => text.includes("연속 실패"))).toHaveLength(1); // same sign, still one DM

		const status = renderStatusText(daemon.status());
		expect(status).toContain("자가진단 게이트");
		expect(status).toContain("turns_failing recent=4");
	});

	test("turns_failing (a window gate) closes silently when its evidence ages out: no false '회복' DM", async () => {
		await startDaemon({ gateSweepMs: 5_000, failPrompts: 99 }); // every prompt fails with the stale-model sign
		const dm = transport.waitForPosts((text) => text.includes("연속 실패"));
		for (let i = 0; i < 3; i++) {
			await daemon.inject({ origin: ORIGIN, asOwner: true, text: `job ${i}` });
		}
		await dm;
		const gateOpen = transport.waitForPosts((text) => text.includes("게이트 turns_failing 열림"));
		clock.advance(6_000); // past the gate sweep interval, still deep inside the 1h evidence window
		await daemon.sweep();
		await gateOpen;

		// The bot is still broken; only the 1h evidence window elapsed. A "이전 문제가 해결되었습니다" DM would be a lie.
		clock.advance(TURNS_FAILING_WINDOW_MS + 60_000);
		await daemon.sweep();
		expect(daemon.status().openGates.map((gate) => gate.name)).not.toContain("turns_failing");
		expect(transport.posts((text) => text.includes("게이트 turns_failing 회복"))).toHaveLength(0);
		// The recovery notice is the only ✅ [자가진단] text (the open notice says "회복되면 다시 알립니다").
		expect(transport.posts((text) => text.startsWith("✅ [자가진단]"))).toHaveLength(0);
	});

	test("a restart does not forget an alerted gate: the recovery DM still fires when the gate closes", async () => {
		await startDaemon({ gateSweepMs: 5_000 }); // no backup stamp -> backup_age is open from boot
		const opened = transport.waitForPosts((text) => text.includes("게이트 backup_age 열림"));
		await daemon.sweep();
		await opened;
		await daemon.stop();

		// A new incarnation on the same ledger: the 24h suppression keeps the still-open gate quiet, but the
		// standing incident re-seeds "the owner was alerted", so the recovery DM must not be skipped.
		await startDaemon({ gateSweepMs: 5_000 });
		await daemon.sweep();
		expect(transport.posts((text) => text.includes("게이트 backup_age 열림"))).toHaveLength(1);

		writeBackupStamp(home.dir);
		clock.advance(6_000);
		const recovered = transport.waitForPosts((text) => text.includes("게이트 backup_age 회복"));
		await daemon.sweep();
		await recovered;
		expect(transport.posts((text) => text.includes("게이트 backup_age 회복"))).toHaveLength(1);
	});

	/** Status of a gate's alert incident row read straight from the ledger (WAL-safe readonly open). */
	function gateIncidentStatus(gate: string): string | undefined {
		const db = new Database(join(home.dir, "ompbot.db"), { readonly: true });
		try {
			const row = db.query("select status from alert_incidents where scope = ?").get(`gate:${gate}`) as {
				status: string;
			} | null;
			return row?.status;
		} finally {
			db.close();
		}
	}

	/** Advances one gate-sweep interval and runs the sweep chain. */
	async function sweepOnce(): Promise<void> {
		clock.advance(6_000);
		await daemon.sweep();
	}

	test("an alerted gate that stayed closed for 3 sweeps re-alerts when it opens again", async () => {
		await startDaemon({ gateSweepMs: 5_000 }); // no stamp -> open from boot
		await daemon.sweep();
		await transport.waitForPosts((text) => text.includes("게이트 backup_age 열림"));

		writeBackupStamp(home.dir);
		await sweepOnce(); // close: recovery DM, closedSweeps=1
		await transport.waitForPosts((text) => text.includes("게이트 backup_age 회복"));
		await sweepOnce(); // closedSweeps=2
		expect(gateIncidentStatus("backup_age")).toBe("alerted");
		await sweepOnce(); // closedSweeps=3 -> incident resolved
		expect(gateIncidentStatus("backup_age")).toBe("resolved");

		rmSync(join(home.dir, "backups", STAMP_FILE));
		await sweepOnce();
		await transport.waitForPosts((text) => text.includes("게이트 backup_age 열림"), 2);
		expect(transport.posts((text) => text.includes("게이트 backup_age 열림"))).toHaveLength(2);
	});

	test("a re-open one sweep after the recovery stays quiet (flap suppression, incident not resolved)", async () => {
		await startDaemon({ gateSweepMs: 5_000 });
		await daemon.sweep();
		await transport.waitForPosts((text) => text.includes("게이트 backup_age 열림"));

		writeBackupStamp(home.dir);
		await sweepOnce();
		await transport.waitForPosts((text) => text.includes("게이트 backup_age 회복"));
		rmSync(join(home.dir, "backups", STAMP_FILE));
		await sweepOnce(); // open again before the 3rd closed sweep
		await sweepOnce();
		expect(transport.posts((text) => text.includes("게이트 backup_age 열림"))).toHaveLength(1);
		expect(gateIncidentStatus("backup_age")).toBe("alerted");

		// A pending resolve must not survive an interruption: close again, then it needs a fresh run of 3 sweeps.
		writeBackupStamp(home.dir);
		await sweepOnce(); // closedSweeps=1 (recovery DM)
		await sweepOnce(); // 2
		expect(gateIncidentStatus("backup_age")).toBe("alerted");
		await sweepOnce(); // 3
		expect(gateIncidentStatus("backup_age")).toBe("resolved");
	});

	test("a gate already closed at boot clears its leftover alerted incident, so the next open alerts", async () => {
		await startDaemon({ gateSweepMs: 5_000 });
		await daemon.sweep();
		await transport.waitForPosts((text) => text.includes("게이트 backup_age 열림"));
		await daemon.stop();
		expect(gateIncidentStatus("backup_age")).toBe("alerted");

		writeBackupStamp(home.dir); // closed by the time the new incarnation looks
		await startDaemon({ gateSweepMs: 5_000 });
		await daemon.sweep(); // first observation: closed -> stale row resolved
		expect(gateIncidentStatus("backup_age")).toBe("resolved");
		expect(transport.posts((text) => text.includes("게이트 backup_age 회복"))).toHaveLength(0);

		rmSync(join(home.dir, "backups", STAMP_FILE));
		await sweepOnce();
		await transport.waitForPosts((text) => text.includes("게이트 backup_age 열림"), 2);
		expect(transport.posts((text) => text.includes("게이트 backup_age 열림"))).toHaveLength(2);
	});

	/** Fails three more owner turns (every prompt fails) and sweeps once, so turns_failing opens; waits for its DM. */
	async function openTurnsFailing(round: number): Promise<void> {
		for (let i = 0; i < 3; i++) {
			await daemon.inject({ origin: ORIGIN, asOwner: true, text: `job ${round}-${i}` });
		}
		await transport.waitForPosts((text) => text.startsWith("[turn failed]"), 3 * round);
		await sweepOnce();
		await transport.waitForPosts((text) => text.includes("게이트 turns_failing 열림"), round);
	}

	test("a window gate's incident resolves silently after the closed sweeps, so a recurrence alerts again", async () => {
		await startDaemon({ gateSweepMs: 5_000, failPrompts: 99 }); // every prompt fails with the stale-model sign
		await openTurnsFailing(1);
		expect(gateIncidentStatus("turns_failing")).toBe("alerted");

		clock.advance(TURNS_FAILING_WINDOW_MS); // the evidence ages out: the next sweep sees the gate closed
		for (let sweep = 1; sweep < GATE_RESOLVE_CLOSED_SWEEPS; sweep++) {
			await sweepOnce();
			expect(gateIncidentStatus("turns_failing")).toBe("alerted");
		}
		await sweepOnce();
		expect(gateIncidentStatus("turns_failing")).toBe("resolved");
		// Resolving is bookkeeping only: an aged-out window is not a fix, so no recovery DM.
		expect(transport.posts((text) => text.includes("게이트 turns_failing 회복"))).toHaveLength(0);

		await openTurnsFailing(2); // well inside 24h of the first alert: only the resolve lets it notify again
		expect(transport.posts((text) => text.includes("게이트 turns_failing 열림"))).toHaveLength(2);
		expect(gateIncidentStatus("turns_failing")).toBe("alerted");
	});

	test("a window gate already closed at boot resolves its leftover alerted incident without a recovery DM", async () => {
		await startDaemon({ gateSweepMs: 5_000, failPrompts: 99 });
		await openTurnsFailing(1);
		await daemon.stop();
		expect(gateIncidentStatus("turns_failing")).toBe("alerted");

		clock.advance(TURNS_FAILING_WINDOW_MS); // aged out by the time the new incarnation looks
		await startDaemon({ gateSweepMs: 5_000 });
		await daemon.sweep(); // first observation: closed -> stale row resolved
		expect(gateIncidentStatus("turns_failing")).toBe("resolved");
		expect(transport.posts((text) => text.includes("게이트 turns_failing 회복"))).toHaveLength(0);
	});

	test("an unknown gate (nothing to judge) keeps its previous state: no notice, no resolve, recovery only on a real close", async () => {
		await startDaemon({ gateSweepMs: 5_000 });
		writeBackupStamp(home.dir);
		await daemon.sweep(); // first observation: sweep_stalled and slack_disconnected closed
		const heartbeat = join(home.dir, SWEEP_HEARTBEAT_FILE);
		const notices = (gate: string) => transport.posts((text) => text.includes(`[자가진단] 게이트 ${gate}`));

		// (a) closed -> unknown: the stamp is gone, so both heartbeat gates cannot be judged; nothing is said.
		rmSync(heartbeat);
		// (d) unknown is not an open gate for status.
		expect(daemon.status().openGates.map((gate) => gate.name)).not.toContain("sweep_stalled");
		await sweepOnce();
		expect(notices("sweep_stalled")).toHaveLength(0);
		expect(notices("slack_disconnected")).toHaveLength(0);

		// sweep_stalled opens: the stamp written by the last sweep is older than three sweeps.
		clock.advance(SWEEP_STALLED_MS + 6_000);
		const opened = transport.waitForPosts((text) => text.includes("게이트 sweep_stalled 열림"));
		await daemon.sweep();
		await opened;
		expect(gateIncidentStatus("sweep_stalled")).toBe("alerted");

		// (b) open -> unknown for longer than the resolve run: no "회복", the alerted row stays.
		for (let sweep = 0; sweep < GATE_RESOLVE_CLOSED_SWEEPS + 1; sweep++) {
			rmSync(heartbeat);
			await sweepOnce();
		}
		expect(transport.posts((text) => text.includes("게이트 sweep_stalled 회복"))).toHaveLength(0);
		expect(gateIncidentStatus("sweep_stalled")).toBe("alerted");

		// (c) a real close (fresh stamp from the last sweep) reports the recovery once.
		const recovered = transport.waitForPosts((text) => text.includes("게이트 sweep_stalled 회복"));
		await sweepOnce();
		await recovered;
		expect(transport.posts((text) => text.includes("게이트 sweep_stalled 회복"))).toHaveLength(1);
		expect(notices("slack_disconnected")).toHaveLength(0);
	});

	test("gateSweepMs=0 disables gate reporting entirely: an open gate never DMs, status still lists it", async () => {
		await startDaemon({ gateSweepMs: 0 }); // no backup stamp -> backup_age is open from boot
		await daemon.sweep();
		expect(transport.posts((text) => text.includes("[자가진단]"))).toHaveLength(0);
		expect(daemon.status().openGates.map((gate) => gate.name)).toContain("backup_age");
	});
});

describe("ompbot doctor claude agent checks", () => {
	let dir: string;
	const savedEnv = new Map<string, string | undefined>();

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ompbot-doctor-claude-"));
		chmodSync(dir, 0o700);
		mkdirSync(join(dir, "secrets"), { recursive: true });
		for (const [name, prefix] of [
			["slack-bot-token", "xoxb-TEST-0"],
			["slack-app-token", "xapp-TEST-0"],
		] as const) {
			writeFileSync(join(dir, "secrets", name), `${prefix}\n`, { mode: 0o600 });
		}
		const fakeClaude = join(dir, "fake-claude");
		writeFileSync(fakeClaude, "#!/bin/sh\necho '2.1.311 (Claude Code)'\n", { mode: 0o755 });
		writeFileSync(
			join(dir, "config.json"),
			JSON.stringify({
				schemaVersion: 1,
				channels: { slack: { ownerUserId: "UOWNER0" } },
				slack: { botTokenFile: "secrets/slack-bot-token", appTokenFile: "secrets/slack-app-token" },
				ompExecutable: process.execPath,
				workspaceDir: "workspace",
				agent: "claude",
				claudeExecutable: fakeClaude,
			}),
			{ mode: 0o600 },
		);
		// Pin the credential lookup to the fixture (and away from this machine's real ~/.claude).
		for (const key of ["CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const) {
			savedEnv.set(key, process.env[key]);
			delete process.env[key];
		}
		process.env.CLAUDE_CONFIG_DIR = join(dir, ".claude");
	});
	afterEach(() => {
		for (const [key, value] of savedEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	async function claudeLines(): Promise<string[]> {
		const lines: string[] = [];
		await runDoctor(dir, (line) => lines.push(line));
		return lines.filter((line) => /^(ok|fail) claude/.test(line));
	}

	test("credentials present: executable and auth pass", async () => {
		mkdirSync(join(dir, ".claude"), { recursive: true });
		writeFileSync(join(dir, ".claude", ".credentials.json"), "{}\n", { mode: 0o600 });
		const lines = await claudeLines();
		expect(lines[0]).toContain("ok claude: ");
		expect(lines[1]).toContain("ok claude auth:");
	});

	test("no credentials and no key env: auth fails naming the path", async () => {
		const lines = await claudeLines();
		expect(lines[0]).toContain("ok claude: ");
		expect(lines[1]).toContain("fail claude auth:");
		expect(lines[1]).toContain(join(dir, ".claude", ".credentials.json"));
	});

	test("agent claude never spawns omp: no omp runtime line (its ompExecutable here is a standalone binary)", async () => {
		const lines: string[] = [];
		await runDoctor(dir, (line) => lines.push(line));
		expect(lines.filter((line) => line.includes("omp runtime"))).toEqual([]);
	});
});

describe("ompbot doctor omp runtime check", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ompbot-doctor-runtime-"));
		mkdirSync(join(dir, "secrets"));
		writeFileSync(join(dir, "secrets", "slack-bot-token"), "xoxb-TEST-0\n", { mode: 0o600 });
		writeFileSync(join(dir, "secrets", "slack-app-token"), "xapp-TEST-0\n", { mode: 0o600 });
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	async function runtimeLine(ompExecutable: string): Promise<string | undefined> {
		writeFileSync(
			join(dir, "config.json"),
			JSON.stringify({
				schemaVersion: 1,
				channels: { slack: { ownerUserId: "UOWNER0" } },
				slack: { botTokenFile: "secrets/slack-bot-token", appTokenFile: "secrets/slack-app-token" },
				ompExecutable,
				workspaceDir: "workspace",
			}),
			{ mode: 0o600 },
		);
		const lines: string[] = [];
		await runDoctor(dir, (line) => lines.push(line));
		return lines.find((line) => line.includes("omp runtime"));
	}

	function launcher(bunRange: string): string {
		const root = mkdtempSync(join(dir, "pkg-"));
		mkdirSync(join(root, "dist"));
		writeFileSync(join(root, "package.json"), JSON.stringify({ engines: { bun: bunRange } }));
		writeFileSync(join(root, "dist", "cli.js"), "#!/usr/bin/env bun\n", { mode: 0o755 });
		return join(root, "dist", "cli.js");
	}

	test("a standalone binary or a too-old bun fails; the package launcher with a satisfied bun passes", async () => {
		expect(await runtimeLine(process.execPath)).toStartWith("fail omp runtime: omp_launcher_standalone ");
		expect(await runtimeLine(launcher(">=999.0.0"))).toStartWith("fail omp runtime: bun_too_old ");
		const ok = launcher(`>=${Bun.version}`);
		expect(await runtimeLine(ok)).toBe(`ok omp runtime: launcher=${realpathSync(ok)}`);
	});

	test("an ompExecutable that is a directory is a failed line, and the rest of the report still runs", async () => {
		const folder = mkdtempSync(join(dir, "omp-dir-"));
		writeFileSync(
			join(dir, "config.json"),
			JSON.stringify({
				schemaVersion: 1,
				channels: { slack: { ownerUserId: "UOWNER0" } },
				slack: { botTokenFile: "secrets/slack-bot-token", appTokenFile: "secrets/slack-app-token" },
				ompExecutable: folder,
				workspaceDir: "workspace",
			}),
			{ mode: 0o600 },
		);
		const lines: string[] = [];
		await runDoctor(dir, (line) => lines.push(line));
		expect(lines.find((line) => line.includes("omp runtime"))).toStartWith(`fail omp runtime: ${folder} unreadable (`);
		expect(lines.some((line) => line.includes("backup bundle"))).toBe(true);
	});
});

describe("ompbot doctor backup bundle check", () => {
	let dir: string;

	/** A ledger-only home: a stamp from a backup that had no bundle sources, and none since. */
	function writeBundlessStamp(): void {
		mkdirSync(join(dir, "backups"), { recursive: true });
		writeFileSync(
			join(dir, "backups", STAMP_FILE),
			`ts=${new Date().toISOString()} file=ompbot-x.db bytes=1 sha256=abc integrity=ok check=quick_check\n`,
		);
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ompbot-doctor-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	/** Only the `backup bundle` line matters here, so the rest of doctor (config, secrets, Slack) is out of scope. */
	async function bundleLine(): Promise<string | undefined> {
		const lines: string[] = [];
		await runDoctor(dir, (line) => lines.push(line));
		return lines.find((line) => line.includes("backup bundle"));
	}

	test("a ledger-only home passes without a bundle; a home with sources must name one", async () => {
		writeBundlessStamp();
		expect(await bundleLine()).toBe("ok backup bundle: sources=none (ledger-only home)");

		mkdirSync(join(dir, "sessions"), { recursive: true });
		expect(await bundleLine()).toBe("fail backup bundle: bundle=none (run ompbot backup again)");
	});
});

describe("ompbot doctor dispatch hosts", () => {
	let home: TestHome;
	beforeEach(() => {
		home = makeHome("ompbot-doctor-hosts-");
		const path = join(home.dir, "config.json");
		const config = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(
			path,
			JSON.stringify({ ...config, herdr: {}, dispatchHosts: { wsl: { ssh: "wsl" }, oci: { ssh: "host2" } } }),
			{ mode: 0o600 },
		);
	});
	afterEach(() => home.remove());

	/** Rewrites config.json's herdr section (`undefined` drops it together with dispatchHosts, which needs herdr). */
	function setHerdr(herdr: { bin?: string } | undefined): void {
		const path = join(home.dir, "config.json");
		const { dispatchHosts, herdr: _old, ...rest } = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(path, JSON.stringify(herdr === undefined ? rest : { ...rest, herdr, dispatchHosts }), {
			mode: 0o600,
		});
	}
	const stubDoctor = async (_home: string, write: (line: string) => void) => {
		write("ok config: stub");
		return 0;
	};
	/** `herdr integration status`, local (`<bin> integration status`) or over ssh (quoted remote words). */
	const isIntegrationStatus = (cmd: string[]) =>
		(cmd[1] === "integration" && cmd[2] === "status") || cmd.slice(-2).join(" ") === "'integration' 'status'";
	const INTEGRATION_CURRENT =
		"codex: not installed (/home/u/.codex/hooks.json)\nomp: current (v10) (/home/u/.omp/agent/extensions/herdr-omp-agent-state.ts)\n";

	test("herdr on: the local herdr --version line comes first; a missing herdr fails the exit code", async () => {
		setHerdr({ bin: "/opt/herdr/bin/herdr" });
		const calls: string[][] = [];
		const ok: ProcessRunner = async (cmd) => {
			calls.push(cmd);
			if (isIntegrationStatus(cmd)) return { code: 0, stdout: INTEGRATION_CURRENT, stderr: "", timedOut: false };
			return { code: 0, stdout: cmd[0] === "/opt/herdr/bin/herdr" ? "herdr 0.9.1\n" : "", stderr: "", timedOut: false };
		};
		const lines: string[] = [];
		expect(await doctorCommand(home.dir, (line) => lines.push(line), { doctor: stubDoctor, run: ok })).toBe(0);
		expect(lines).toEqual([
			"ok config: stub",
			"ok herdr: /opt/herdr/bin/herdr herdr 0.9.1",
			"ok herdr omp integration: omp: current (v10)",
			"ok dispatch host wsl: ssh wsl",
			"ok herdr omp integration on wsl: omp: current (v10)",
			"ok dispatch host oci: ssh host2",
			"ok herdr omp integration on oci: omp: current (v10)",
		]);
		expect(calls[0]).toEqual(["/opt/herdr/bin/herdr", "--version"]);

		setHerdr({});
		const missing: ProcessRunner = async (cmd) =>
			cmd[0] === "herdr"
				? { code: null, stdout: "spawn failed: ENOENT", timedOut: false }
				: { code: 0, stdout: "", stderr: "", timedOut: false };
		const failed: string[] = [];
		expect(await doctorCommand(home.dir, (line) => failed.push(line), { doctor: stubDoctor, run: missing })).toBe(1);
		expect(failed[1]).toBe("fail herdr: herdr spawn failed: ENOENT");
	});

	test("herdr off: no herdr line and nothing is run", async () => {
		setHerdr(undefined);
		const calls: string[][] = [];
		const run: ProcessRunner = async (cmd) => {
			calls.push(cmd);
			return { code: 0, stdout: "", stderr: "", timedOut: false };
		};
		const lines: string[] = [];
		expect(await doctorCommand(home.dir, (line) => lines.push(line), { doctor: stubDoctor, run })).toBe(0);
		expect(lines).toEqual(["ok config: stub"]);
		expect(calls).toEqual([]);
	});

	test("herdr omp integration: current is ok; not installed or a failing command is a warning that keeps the exit code", async () => {
		setHerdr({ bin: "/opt/herdr/bin/herdr" });
		const path = join(home.dir, "config.json");
		const withHerdrBin = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(
			path,
			JSON.stringify({ ...withHerdrBin, dispatchHosts: { wsl: { ssh: "wsl", herdrBin: "/home/u/.local/bin/herdr" } } }),
			{ mode: 0o600 },
		);
		const lineOf = async (integration: RunProcessResult, doctorCode: number) => {
			const calls: string[][] = [];
			const run: ProcessRunner = async (cmd) => {
				calls.push(cmd);
				if (isIntegrationStatus(cmd)) return integration;
				return { code: 0, stdout: "herdr 0.9.5\n", stderr: "", timedOut: false };
			};
			const lines: string[] = [];
			const code = await doctorCommand(home.dir, (line) => lines.push(line), {
				doctor: async (_home, write) => {
					write("ok config: stub");
					return doctorCode;
				},
				run,
			});
			return { code, lines, calls };
		};
		const notInstalled: RunProcessResult = {
			code: 0,
			stdout: "omp: not installed (/home/u/.omp/agent/extensions/herdr-omp-agent-state.ts)\n",
			stderr: "",
			timedOut: false,
		};
		const broken: RunProcessResult = {
			code: 2,
			stdout: "",
			stderr: "error: unrecognized subcommand 'integration'\n",
			timedOut: false,
		};
		for (const doctorCode of [0, 1]) {
			const missing = await lineOf(notInstalled, doctorCode);
			expect(missing.code).toBe(doctorCode);
			expect(missing.lines[2]).toBe(
				"fail herdr omp integration: omp: not installed — herdr integration install omp (warning only)",
			);
			expect(missing.lines[4]).toBe(
				"fail herdr omp integration on wsl: omp: not installed — herdr integration install omp (warning only)",
			);
			const failing = await lineOf(broken, doctorCode);
			expect(failing.code).toBe(doctorCode);
			expect(failing.lines[2]).toBe(
				"fail herdr omp integration: integration status failed: error: unrecognized subcommand 'integration' — herdr integration install omp (warning only)",
			);
			const current = await lineOf({ code: 0, stdout: INTEGRATION_CURRENT, stderr: "", timedOut: false }, doctorCode);
			expect(current.code).toBe(doctorCode);
			expect(current.lines[2]).toBe("ok herdr omp integration: omp: current (v10)");
			expect(current.calls).toContainEqual(["/opt/herdr/bin/herdr", "integration", "status"]);
			expect(current.calls).toContainEqual(herdrSshArgv("wsl", "/home/u/.local/bin/herdr", ["integration", "status"]));
		}
	});

	test("one ok/fail line per dispatch host through the injected runner; a down host never changes the exit code", async () => {
		const calls: string[][] = [];
		const run: ProcessRunner = async (cmd) => {
			calls.push(cmd);
			if (isIntegrationStatus(cmd) && !cmd.includes("wsl")) {
				return { code: 0, stdout: INTEGRATION_CURRENT, stderr: "", timedOut: false };
			}
			if (cmd[0] === "herdr") return { code: 0, stdout: "herdr 0.9.1\n", stderr: "", timedOut: false };
			return cmd.includes("wsl")
				? { code: 255, stdout: "", stderr: "ssh: connect to host x port 2222: Connection refused\n", timedOut: false }
				: { code: 0, stdout: "", stderr: "", timedOut: false };
		};
		for (const doctorCode of [0, 1]) {
			const lines: string[] = [];
			const code = await doctorCommand(home.dir, (line) => lines.push(line), {
				doctor: async (_home, write) => {
					write("ok config: stub");
					return doctorCode;
				},
				run,
			});
			expect(code).toBe(doctorCode);
			expect(lines).toEqual([
				"ok config: stub",
				"ok herdr: herdr herdr 0.9.1",
				"ok herdr omp integration: omp: current (v10)",
				"fail dispatch host wsl: ssh: connect to host x port 2222: Connection refused (warning only)",
				"fail herdr omp integration on wsl: integration status failed: ssh: connect to host x port 2222: Connection refused — herdr integration install omp (warning only)",
				"ok dispatch host oci: ssh host2",
				"ok herdr omp integration on oci: omp: current (v10)",
			]);
		}
		expect(calls[2]).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", "wsl", "true"]);
	});
});

describe("ompbot backup bundle size cap (config maxBundleBytes + --max-bundle-bytes)", () => {
	let home: TestHome;

	beforeEach(() => {
		home = makeHome("ompbot-ops-bundlecap-");
	});
	afterEach(() => {
		killSpawned();
		home.remove();
	});

	/** A seeded ledger plus a sessions tree well past a 10-byte cap (and past the config's reach-around). */
	function seedBackedUpHome(): void {
		const db = new Database(join(home.dir, "ompbot.db"), { create: true, strict: true });
		db.run("CREATE TABLE origins (origin_key TEXT PRIMARY KEY)");
		db.close();
		mkdirSync(join(home.dir, "sessions", "slack-dm-D1", "e1"), { recursive: true });
		writeFileSync(
			join(home.dir, "sessions", "slack-dm-D1", "e1", "s.jsonl"),
			'{"message":{"role":"user","content":"안녕"}}\n',
		);
	}

	test("config maxBundleBytes reaches the backup and the flag overrides it", async () => {
		writeFileSync(
			join(home.dir, "config.json"),
			JSON.stringify({
				schemaVersion: 1,
				channels: { slack: { ownerUserId: OWNER } },
				slack: { botTokenFile: "secrets/slack-bot-token", appTokenFile: "secrets/slack-app-token" },
				ompExecutable: join(home.dir, "fake-omp"),
				workspaceDir: "workspace",
				maxBundleBytes: 10,
			}),
			{ mode: 0o600 },
		);
		seedBackedUpHome();

		const capped = await runMain(home.dir, ["backup"]);
		expect(capped.code, capped.stderr).toBe(1);
		expect(capped.stderr).toContain("bundle_too_large");
		expect(existsSync(join(home.dir, "backups", STAMP_FILE))).toBe(false);

		const lifted = await runMain(home.dir, ["backup", "--max-bundle-bytes", String(512 * 1024 * 1024)]);
		expect(lifted.code, lifted.stderr).toBe(0);
		expect(lifted.stdout).toContain("backup bundle file=");
	});

	test("an invalid cap is refused: the flag with exit 2, the config with ConfigError exit 1", async () => {
		seedBackedUpHome();
		const flag = await runMain(home.dir, ["backup", "--max-bundle-bytes", "0"]);
		expect(flag.code).toBe(2);
		expect(flag.stderr).toContain("--max-bundle-bytes must be a positive integer");

		writeFileSync(
			join(home.dir, "config.json"),
			JSON.stringify({
				schemaVersion: 1,
				channels: { slack: { ownerUserId: OWNER } },
				slack: { botTokenFile: "secrets/slack-bot-token", appTokenFile: "secrets/slack-app-token" },
				ompExecutable: join(home.dir, "fake-omp"),
				workspaceDir: "workspace",
				maxBundleBytes: -5,
			}),
			{ mode: 0o600 },
		);
		const config = await runMain(home.dir, ["backup"]);
		expect(config.code).toBe(1);
		expect(config.stderr).toContain("field=maxBundleBytes");
	});
});

describe("log rotation", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ompbot-ops-log-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("the defaults are 10 MB x 5 files", () => {
		expect(LOG_MAX_BYTES).toBe(10 * 1024 * 1024);
		expect(LOG_FILES).toBe(5);
	});

	test("rotates before a write would pass maxBytes, keeps `files` files in total and drops the oldest", () => {
		const path = join(dir, "ompbot.log");
		const sink = rotatingFileSink(path, { maxBytes: 100, files: 3 });
		const line = (n: number) => `${String(n).padStart(2, "0")}${"x".repeat(37)}`; // 39 bytes + newline = 40
		for (let n = 1; n <= 9; n++) sink(line(n));
		expect(readdirSync(dir).sort()).toEqual(["ompbot.log", "ompbot.log.1", "ompbot.log.2"]);
		for (const name of readdirSync(dir)) expect(readFileSync(join(dir, name)).length).toBeLessThanOrEqual(100);
		expect(readFileSync(path, "utf8")).toBe(`${line(9)}\n`);
		expect(readFileSync(`${path}.1`, "utf8")).toBe(`${line(7)}\n${line(8)}\n`);
		expect(readFileSync(`${path}.2`, "utf8")).toBe(`${line(5)}\n${line(6)}\n`);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("an existing live file counts towards the limit after a restart", () => {
		const path = join(dir, "ompbot.log");
		writeFileSync(path, `${"y".repeat(79)}\n`);
		rotatingFileSink(path, { maxBytes: 100, files: 2 })("z".repeat(30));
		expect(readFileSync(`${path}.1`, "utf8")).toBe(`${"y".repeat(79)}\n`);
		expect(readFileSync(path, "utf8")).toBe(`${"z".repeat(30)}\n`);
	});
});

describe("refusing to start when the log directory is unusable", () => {
	let home: TestHome;
	beforeEach(() => {
		home = makeHome("ompbot-ops-logdir-");
	});
	afterEach(() => {
		killSpawned();
		home.remove();
	});

	test("a logs path that is not a directory raises log_dir_unwritable", () => {
		writeFileSync(join(home.dir, "logs"), "not a directory");
		expect(() => openLogSink(home.dir)).toThrow(LogDirError);
		expect(() => openLogSink(home.dir)).toThrow(/^log_dir_unwritable: .*logs/);
	});

	test.skipIf(process.getuid?.() === 0)("a read-only logs directory raises log_dir_unwritable", () => {
		mkdirSync(join(home.dir, "logs"), { mode: 0o500 });
		try {
			expect(() => openLogSink(home.dir)).toThrow(/^log_dir_unwritable: .*logs \(EACCES\)/);
		} finally {
			chmodSync(join(home.dir, "logs"), 0o700);
		}
	});

	test("the daemon process exits 1 with the reason on stderr and holds no lock or socket", async () => {
		writeFileSync(join(home.dir, "logs"), "not a directory");
		const daemon = spawnDaemon(home.dir, join(home.dir, "transport.jsonl"));
		const reason = await daemon.waitLog(/refusing to start: log_dir_unwritable: .*logs/);
		expect(reason).toContain(home.dir);
		expect(await daemon.exited).toBe(1);
		expect(existsSync(join(home.dir, "ompbot.lock"))).toBe(false);
		expect(existsSync(join(home.dir, "ompbot.sock"))).toBe(false);
	});
});

describe("ompbot gc", () => {
	let home: TestHome;
	const sessionsRoot = () => join(home.dir, "sessions");
	const sessionOf = (origin: string, epoch: number) => sessionDirFor(sessionsRoot(), origin, epoch);

	/** A session directory with one file, the directory and the file last modified `ageDays` ago. */
	function makeSession(path: string, ageDays: number, fileAgeDays = ageDays): void {
		mkdirSync(path, { recursive: true });
		const file = join(path, "session.jsonl");
		writeFileSync(file, "{}\n");
		utimesSync(file, new Date(Date.now() - fileAgeDays * DAY_MS), new Date(Date.now() - fileAgeDays * DAY_MS));
		utimesSync(path, new Date(Date.now() - ageDays * DAY_MS), new Date(Date.now() - ageDays * DAY_MS));
	}

	beforeEach(() => {
		home = makeHome("ompbot-ops-gc-");
		const store = openBotStore(join(home.dir, "ompbot.db"), { now: () => Date.now() });
		store.ensureOrigin(ORIGIN, sessionOf(ORIGIN, 1));
		store.newEpoch(ORIGIN, sessionOf(ORIGIN, 2));
		store.newEpoch(ORIGIN, sessionOf(ORIGIN, 3));
		store.ensureOrigin("slack/dm/D2", sessionOf("slack/dm/D2", 1));
		store.close();
		makeSession(sessionOf(ORIGIN, 1), 60); // previous epoch, old: the only one to delete
		makeSession(sessionOf(ORIGIN, 2), 60, 2); // previous epoch, directory old but a file written 2 days ago
		makeSession(sessionOf(ORIGIN, 3), 60); // CURRENT epoch, old: never deleted
		makeSession(sessionOf("slack/dm/D2", 1), 60); // current (only) epoch of another origin
		makeSession(sessionOf("slack/dm/DX", 1), 60); // origin unknown to the ledger
		makeSession(join(dirname(sessionOf(ORIGIN, 1)), "notes"), 60); // not named e<N>
	});
	afterEach(() => {
		killSpawned();
		home.remove();
	});

	test("deletes only previous-epoch directories whose newest file is past the retention window", () => {
		const options = { homeDir: home.dir, retentionDays: 30, now: Date.now() };
		const dry = gcSessions({ ...options, dryRun: true });
		expect(dry.removed).toEqual([sessionOf(ORIGIN, 1)]);
		expect(existsSync(sessionOf(ORIGIN, 1))).toBe(true);

		const result = gcSessions(options);
		expect(result.removed).toEqual([sessionOf(ORIGIN, 1)]);
		expect(result.retained).toEqual([sessionOf(ORIGIN, 2)]);
		expect(existsSync(sessionOf(ORIGIN, 1))).toBe(false);
		for (const kept of [
			sessionOf(ORIGIN, 2),
			sessionOf(ORIGIN, 3),
			sessionOf("slack/dm/D2", 1),
			sessionOf("slack/dm/DX", 1),
			join(dirname(sessionOf(ORIGIN, 1)), "notes"),
		]) {
			expect(existsSync(kept), kept).toBe(true);
		}
	});

	test("a retention window longer than the age deletes nothing", () => {
		expect(gcSessions({ homeDir: home.dir, retentionDays: 90, now: Date.now() }).removed).toEqual([]);
	});

	test("`ompbot gc` honours --dry-run and then deletes with the default 30-day retention", async () => {
		const dry = await runMain(home.dir, ["gc", "--dry-run"]);
		expect(dry.code, dry.stderr).toBe(0);
		expect(dry.stdout).toContain(`gc would_remove path=${sessionOf(ORIGIN, 1)}`);
		expect(existsSync(sessionOf(ORIGIN, 1))).toBe(true);
		const real = await runMain(home.dir, ["gc"]);
		expect(real.code, real.stderr).toBe(0);
		expect(real.stdout).toContain(`gc removed path=${sessionOf(ORIGIN, 1)}`);
		expect(real.stdout).toContain("gc_done removed=1 retained=1");
		expect(existsSync(sessionOf(ORIGIN, 1))).toBe(false);
	});
});

describe("ompbot gc: thread-scoped sessions", () => {
	let home: TestHome;
	const sessionOf = (origin: string, epoch = 1) => sessionDirFor(join(home.dir, "sessions"), origin, epoch);

	/** A session directory with one file; the session dir and its parent origin dir are backdated together. */
	function makeSession(path: string, ageDays: number): void {
		mkdirSync(path, { recursive: true });
		const file = join(path, "session.jsonl");
		writeFileSync(file, "{}\n");
		const old = new Date(Date.now() - ageDays * DAY_MS);
		utimesSync(file, old, old);
		utimesSync(path, old, old);
		// gc reads the origin dir's own newest mtime too (an epoch bump there is real activity).
		utimesSync(dirname(path), old, old);
	}

	beforeEach(() => {
		home = makeHome("ompbot-ops-gc-thread-");
		const store = openBotStore(join(home.dir, "ompbot.db"), { now: () => Date.now() });
		store.ensureOrigin("slack/ch/C1", sessionOf("slack/ch/C1"));
		store.ensureOrigin("slack/ch/C1/t/100.1", sessionOf("slack/ch/C1/t/100.1")); // fresh thread: kept
		store.ensureOrigin("slack/ch/C1/t/50.9", sessionOf("slack/ch/C1/t/50.9")); // expired thread: removed
		store.ensureOrigin("slack/dm/D1", sessionOf("slack/dm/D1"));
		store.close();
		makeSession(sessionOf("slack/ch/C1"), 60);
		makeSession(sessionOf("slack/ch/C1/t/100.1"), 1);
		makeSession(sessionOf("slack/ch/C1/t/50.9"), 60);
		makeSession(sessionOf("slack/dm/D1"), 1);
	});
	afterEach(() => {
		killSpawned();
		home.remove();
	});

	test("an expired thread origin loses directory and ledger row; fresh ones and channel/DM origins stay", () => {
		const options = { homeDir: home.dir, retentionDays: 30, now: Date.now() };
		const dry = gcSessions({ ...options, dryRun: true });
		expect(dry.threadOriginsRemoved).toEqual(["slack/ch/C1/t/50.9"]);
		expect(existsSync(sessionOf("slack/ch/C1/t/50.9"))).toBe(true);

		const result = gcSessions(options);
		expect(result.threadOriginsRemoved).toEqual(["slack/ch/C1/t/50.9"]);
		expect(existsSync(sessionOf("slack/ch/C1/t/50.9"))).toBe(false);
		expect(existsSync(sessionOf("slack/ch/C1/t/100.1"))).toBe(true);
		// Channel and DM origins are epoch-managed: gc only ever touches their previous epochs.
		expect(existsSync(sessionOf("slack/ch/C1"))).toBe(true);
		expect(existsSync(sessionOf("slack/dm/D1"))).toBe(true);
		// The ledger row is gone; a later message simply opens a fresh origin.
		const check = openBotStore(join(home.dir, "ompbot.db"), { now: () => Date.now() });
		try {
			expect(check.getOrigin("slack/ch/C1/t/50.9")).toBeUndefined();
			expect(check.getOrigin("slack/ch/C1/t/100.1")).toBeDefined();
		} finally {
			check.close();
		}
	});
});

describe("ompbot gc: deleted-monitor origins", () => {
	let home: TestHome;
	const sessionOf = (origin: string, epoch = 1) => sessionDirFor(join(home.dir, "sessions"), origin, epoch);

	function makeSession(path: string, ageDays: number): void {
		mkdirSync(path, { recursive: true });
		const file = join(path, "session.jsonl");
		writeFileSync(file, "{}\n");
		const old = new Date(Date.now() - ageDays * DAY_MS);
		utimesSync(file, old, old);
		utimesSync(path, old, old);
		utimesSync(dirname(path), old, old);
	}

	function originRow(key: string): boolean {
		const check = openBotStore(join(home.dir, "ompbot.db"), { now: () => Date.now() });
		try {
			return check.getOrigin(key) !== undefined;
		} finally {
			check.close();
		}
	}

	beforeEach(() => {
		home = makeHome("ompbot-ops-gc-monitor-");
		const store = openBotStore(join(home.dir, "ompbot.db"), { now: () => Date.now() });
		for (const key of ["monitor/mold", "monitor/mnew", "monitor/mlive", "slack/ch/C1/t/50.9"]) {
			store.ensureOrigin(key, sessionOf(key));
		}
		store.close();
		const db = new Database(join(home.dir, "ompbot.db"), { strict: true });
		db.exec(MONITOR_SCHEMA);
		db.run(
			"INSERT INTO monitors (id, name, trigger_json, instruction, cursor_at, created_at, updated_at) VALUES ('mlive', 'live', '{}', 'x', 0, 0, 0)",
		);
		db.close();
		makeSession(sessionOf("monitor/mold"), 60); // deleted monitor, expired: removed
		makeSession(sessionOf("monitor/mnew"), 1); // deleted monitor, recent: retained
		makeSession(sessionOf("monitor/mlive"), 60); // live monitor: never touched
		makeSession(sessionOf("slack/ch/C1/t/50.9"), 60);
	});
	afterEach(() => home.remove());

	test("an orphan monitor origin past retention loses directory and ledger row", () => {
		const result = gcSessions({ homeDir: home.dir, retentionDays: 30, now: Date.now() });
		expect(result.monitorOriginsRemoved).toEqual(["monitor/mold"]);
		expect(existsSync(sessionOf("monitor/mold"))).toBe(false);
		expect(originRow("monitor/mold")).toBe(false);
		// Thread origins keep their own list and behavior.
		expect(result.threadOriginsRemoved).toEqual(["slack/ch/C1/t/50.9"]);
	});

	test("an orphan monitor origin newer than the cutoff is retained", () => {
		const result = gcSessions({ homeDir: home.dir, retentionDays: 30, now: Date.now() });
		expect(result.monitorOriginsRemoved).not.toContain("monitor/mnew");
		expect(existsSync(sessionOf("monitor/mnew"))).toBe(true);
		expect(originRow("monitor/mnew")).toBe(true);
	});

	test("a live monitor's origin is never touched, however old", () => {
		const result = gcSessions({ homeDir: home.dir, retentionDays: 30, now: Date.now() });
		expect(result.monitorOriginsRemoved).not.toContain("monitor/mlive");
		expect(existsSync(sessionOf("monitor/mlive"))).toBe(true);
		expect(originRow("monitor/mlive")).toBe(true);
	});

	test("dry-run reports the orphan but removes nothing", () => {
		const result = gcSessions({ homeDir: home.dir, retentionDays: 30, now: Date.now(), dryRun: true });
		expect(result.monitorOriginsRemoved).toEqual(["monitor/mold"]);
		expect(existsSync(sessionOf("monitor/mold"))).toBe(true);
		expect(originRow("monitor/mold")).toBe(true);
	});

	test("an orphan at epoch 2 is removed even though pruning its e1 dir bumps the origin dir mtime", () => {
		const key = "monitor/mepoch";
		const db = new Database(join(home.dir, "ompbot.db"), { strict: true });
		db.run("INSERT INTO origins (origin_key, epoch, session_dir, updated_at) VALUES (?, 2, ?, 0)", [
			key,
			sessionOf(key, 2),
		]);
		db.close();
		makeSession(sessionOf(key, 1), 60);
		makeSession(sessionOf(key, 2), 60);
		const dry = gcSessions({ homeDir: home.dir, retentionDays: 30, now: Date.now(), dryRun: true });
		expect(dry.monitorOriginsRemoved).toContain(key);
		const result = gcSessions({ homeDir: home.dir, retentionDays: 30, now: Date.now() });
		expect(result.monitorOriginsRemoved).toContain(key);
		expect(existsSync(dirname(sessionOf(key, 1)))).toBe(false);
		expect(originRow(key)).toBe(false);
	});

	test("a home without a monitors table skips the rule instead of failing", () => {
		const db = new Database(join(home.dir, "ompbot.db"), { strict: true });
		db.exec("DROP TABLE monitor_events; DROP TABLE monitor_slots; DROP TABLE monitor_incidents; DROP TABLE monitors");
		db.close();
		const result = gcSessions({ homeDir: home.dir, retentionDays: 30, now: Date.now() });
		expect(result.monitorOriginsRemoved).toEqual([]);
		expect(existsSync(sessionOf("monitor/mold"))).toBe(true);
	});
});

describe("examples/ops-check-ompbot.json", () => {
	test("is a proposal of uniquely identified checks for the ompbot unit and status command", () => {
		const proposal = JSON.parse(
			readFileSync(join(import.meta.dir, "..", "examples", "ops-check-ompbot.json"), "utf8"),
		) as {
			checks: Array<{ id: string; type: string; unit?: string; cmd?: string; expect?: string }>;
		};
		const ids = proposal.checks.map((check) => check.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(proposal.checks.find((check) => check.type === "systemd")?.unit).toBe("ompbot.service");
		const status = proposal.checks.find((check) => check.type === "cmd");
		expect(status?.cmd).toContain("main.ts status");
		expect(status?.expect).toBe("데몬 실행 중");
	});
});
