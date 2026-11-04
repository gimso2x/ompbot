import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Daemon, DRAIN_DEFERRED_COMMAND_TEXT } from "../src/daemon/daemon";
import { callDaemon } from "../src/daemon/ipc";
import {
	RESTART_NOTICE_FILE,
	RESTART_NOTICE_STALE_MS,
	RESTART_NOTICE_TEXT,
	writeRestartMarker,
} from "../src/daemon/restart-notice";
import { renderStatusText } from "../src/daemon/status";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { SlackChannel } from "../src/slack/channel";
import { makeHome, OWNER, type TestHome, WaitingTransport } from "./helpers/bot-home";
import { killSpawned, runMain } from "./helpers/daemon-process";

const DM = "D1";
const ORIGIN = `slack/dm/${DM}`;
const clock = { now: () => Date.now() };

let home: TestHome;
let transport: WaitingTransport;
let daemon: Daemon;
let drivers: FakeOmpDriver[];
let logs: string[];
let waiters: Array<() => void>;
const sessions = new FakeSessionStore();

/** Resolves once `count` log lines carry `event=<event>` (subscribed before the action that logs it). */
function untilLog(event: string, count = 1): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const check = () => {
		if (logs.filter((line) => line.includes(`event=${event}`)).length < count) return;
		waiters = waiters.filter((w) => w !== check);
		resolve();
	};
	waiters.push(check);
	check();
	return promise;
}

async function boot(holdTurns: boolean): Promise<Daemon> {
	transport = new WaitingTransport();
	const started = new Daemon({
		config: home.config,
		slack: new SlackChannel(transport),
		clock,
		log: createLogger({
			sink: (line) => {
				logs.push(line);
				for (const waiter of [...waiters]) waiter();
			},
			clock,
			redact,
		}),
		ompVersion: "omp-test 0",
		bootId: `boot-${drivers.length}`,
		sweepMs: 3_600_000, // sweeps are driven by the test
		gateSweepMs: 0,
		taskSweepMs: 0,
		stopDrainMs: 250, // held fake turns must not outwait the afterEach hook at shutdown
		driverFactory: (_origin, sessionDir) => {
			const driver = new FakeOmpDriver({ sessionDir, store: sessions, holdTurns });
			drivers.push(driver);
			return driver;
		},
	});
	await started.start();
	return started;
}

function ownerMessage(ts: string, text: string): Promise<unknown> {
	return transport.emitMessage({ type: "message", channel: DM, channel_type: "im", user: OWNER, text, ts });
}

const inboundState = (ts: string) => daemon.store.getInbound(`${DM}:${ts}`)?.state;

beforeEach(() => {
	home = makeHome("ompbot-drain-");
	drivers = [];
	logs = [];
	waiters = [];
});

afterEach(async () => {
	killSpawned();
	await daemon.stop();
	home.remove();
});

describe("ompbot drain", () => {
	test("--wait exits 0 once the running turn ends; meanwhile inbound stays pending and no monitor fires; the next process answers it", async () => {
		daemon = await boot(true);
		const started = untilLog("turn_start");
		await ownerMessage("1700.000001", "first");
		await started;

		const draining = untilLog("drain_started");
		const cli = runMain(home.dir, ["drain", "--wait", "--timeout", "1"]);
		await draining;

		const deferred = untilLog("drain_deferred");
		await ownerMessage("1700.000002", "second");
		await deferred;
		expect(inboundState("1700.000002")).toBe("pending");
		const monitor = daemon.store.monitors.addMonitor({
			name: "due",
			trigger: { kind: "at", at: new Date(Date.now() - 60_000).toISOString() },
			instruction: "x",
			overlap: "queue",
			enabled: true,
		});
		await daemon.sweep();
		expect(daemon.store.monitors.listEvents({ monitorId: monitor.id })).toEqual([]);
		expect(daemon.status().drain).toEqual({ turns: 1, hostTools: 0, approvals: 0 });
		expect(renderStatusText(daemon.status())).toContain("재시작 대기(drain) 중 · 진행 턴 1");

		drivers[0]?.release();
		const done = await cli;
		expect(done.stdout).toContain("drain_done turns=0 hostTools=0 approvals=0");
		expect(done.code).toBe(0);
		// No steer and no new prompt while draining: the second message is still waiting for the restart.
		expect(drivers[0]?.calls.filter((c) => c.startsWith("steer:") || c.startsWith("prompt:"))).toEqual([
			"prompt:first",
		]);
		expect(inboundState("1700.000002")).toBe("pending");

		await daemon.stop();
		daemon = await boot(false);
		await transport.waitForPosts((text) => text.includes("ECHO second"));
		expect(inboundState("1700.000002")).toBe("answered");
		expect(daemon.status().drain).toBeUndefined();
	});

	test("a timeout cancels the drain and exits 1; what waited is dispatched", async () => {
		daemon = await boot(true);
		const started = untilLog("turn_start");
		await ownerMessage("1700.000001", "first");
		await started;
		expect((await runMain(home.dir, ["drain"])).code).toBe(0);
		const deferred = untilLog("drain_deferred");
		await ownerMessage("1700.000002", "second");
		await deferred;

		const steered = untilLog("steer_delivered");
		const timedOut = await runMain(home.dir, ["drain", "--wait", "--timeout", "0"]);
		expect(timedOut.code).toBe(1);
		expect(timedOut.stderr).toContain("timed out after 0 min, drain cancelled turns=1");
		await steered;
		expect(inboundState("1700.000002")).toBe("dispatched");
		expect(daemon.status().drain).toBeUndefined();
	});

	test("--cancel ends the drain and the waiting message starts its turn", async () => {
		daemon = await boot(false);
		expect((await runMain(home.dir, ["drain"])).code).toBe(0);
		const deferred = untilLog("drain_deferred");
		await ownerMessage("1700.000001", "hello");
		await deferred;
		expect(inboundState("1700.000001")).toBe("pending");

		const cancelled = await runMain(home.dir, ["drain", "--cancel"]);
		expect(cancelled.code).toBe(0);
		expect(cancelled.stdout).toContain("drain cancelled");
		await transport.waitForPosts((text) => text.includes("ECHO hello"));
		expect(inboundState("1700.000001")).toBe("answered");
	});

	describe("restart notices", () => {
		const notices = (text: string) => transport.posts((t) => t === text).map((p) => `${p.channel}:${p.threadTs}`);

		test("drain tells the active conversation in its thread; the next process says it is back; the marker is consumed", async () => {
			daemon = await boot(false);
			await ownerMessage("1700.000001", "hello");
			await transport.waitForPosts((text) => text.includes("ECHO hello"));

			expect((await runMain(home.dir, ["drain"])).code).toBe(0);
			await transport.waitForPosts((text) => text === RESTART_NOTICE_TEXT.draining);
			expect(notices(RESTART_NOTICE_TEXT.draining)).toEqual([`${DM}:1700.000001`]);
			expect(existsSync(join(home.dir, RESTART_NOTICE_FILE))).toBe(true);

			await daemon.stop();
			daemon = await boot(false);
			await transport.waitForPosts((text) => text === RESTART_NOTICE_TEXT.back);
			expect(notices(RESTART_NOTICE_TEXT.back)).toEqual([`${DM}:1700.000001`]);
			expect(existsSync(join(home.dir, RESTART_NOTICE_FILE))).toBe(false);
			expect(notices(RESTART_NOTICE_TEXT.cancelled)).toEqual([]);
		});

		test("a cancelled drain says so instead; a plain restart without a drain says nothing", async () => {
			daemon = await boot(false);
			await ownerMessage("1700.000001", "hello");
			await transport.waitForPosts((text) => text.includes("ECHO hello"));
			expect((await runMain(home.dir, ["drain"])).code).toBe(0);
			expect((await runMain(home.dir, ["drain", "--cancel"])).code).toBe(0);
			await transport.waitForPosts((text) => text === RESTART_NOTICE_TEXT.cancelled);
			expect(existsSync(join(home.dir, RESTART_NOTICE_FILE))).toBe(false);

			await daemon.stop();
			const ready = untilLog("daemon_ready", 2);
			daemon = await boot(false);
			await ready;
			expect(notices(RESTART_NOTICE_TEXT.back)).toEqual([]);
		});

		test("restartNotice=false posts nothing; a stale marker is dropped silently", async () => {
			home.config.restartNotice = false;
			daemon = await boot(false);
			await ownerMessage("1700.000001", "hello");
			await transport.waitForPosts((text) => text.includes("ECHO hello"));
			expect((await runMain(home.dir, ["drain"])).code).toBe(0);
			expect(notices(RESTART_NOTICE_TEXT.draining)).toEqual([]);
			expect(existsSync(join(home.dir, RESTART_NOTICE_FILE))).toBe(false);

			await daemon.stop();
			home.config.restartNotice = true;
			writeRestartMarker(home.dir, { at: Date.now() - RESTART_NOTICE_STALE_MS - 1, threads: [`${DM}:1700.000001`] });
			const dropped = untilLog("restart_notice_dropped");
			daemon = await boot(false);
			await dropped;
			expect(notices(RESTART_NOTICE_TEXT.back)).toEqual([]);
			expect(existsSync(join(home.dir, RESTART_NOTICE_FILE))).toBe(false);
		});
	});

	test("a slash command during a drain is recorded once and told it runs after the restart; status still answers", async () => {
		daemon = await boot(false);
		const slashRows = () =>
			daemon.store
				.listInbound()
				.filter((row) => row.platformMessageId.startsWith(`slash:${DM}:`))
				.map((row) => [row.textRef, row.state]);
		daemon.setDraining(true);
		const ack = await transport.emitSlash({ command: "/new-ompbot", user_id: OWNER, channel_id: DM });
		expect(ack).toEqual({ response_type: "ephemeral", text: DRAIN_DEFERRED_COMMAND_TEXT });
		expect(slashRows()).toEqual([["/new-ompbot", "pending"]]);
		const status = await transport.emitSlash({ command: "/status-ompbot", user_id: OWNER, channel_id: DM });
		expect(status?.text).toBe(renderStatusText(daemon.status()));
		expect(slashRows()).toHaveLength(1);
		daemon.setDraining(false);
		expect(await transport.emitSlash({ command: "/usage-ompbot", user_id: OWNER, channel_id: DM })).toBeUndefined();
	});

	test("a waiting approval counts as a running host tool and a pending approval", async () => {
		daemon = await boot(false);
		const tool = daemon.hostToolsFor(ORIGIN).find((t) => t.name === "ompbot_request_approval");
		if (!tool) throw new Error("tool missing");
		void tool.execute({ summary: "force push main" }, { signal: new AbortController().signal });
		await transport.waitForPosts((text) => text.startsWith("🔐 승인 요청"));
		const socket = `${home.dir}/ompbot.sock`;
		expect(await callDaemon(socket, { op: "drain" })).toEqual({
			ok: true,
			draining: true,
			turns: 0,
			hostTools: 1,
			approvals: 1,
		});
		expect((await runMain(home.dir, ["drain", "--wait", "--timeout", "0"])).code).toBe(1);
		expect(await callDaemon(socket, { op: "drain_status" })).toMatchObject({ draining: false });
	});
});
