import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WATCHDOG_STALL_MS, watchdogStallMs } from "../src/daemon/watchdog";
import { makeHome, type TestHome } from "./helpers/bot-home";
import { killSpawned, spawnDaemon } from "./helpers/daemon-process";

const WATCHDOG = join(import.meta.dir, "..", "src", "daemon", "watchdog.ts");
const STALL_MS = 1_000;

/**
 * A child bun process using the watchdog: `block` stalls its main thread for good, `idle` keeps an idle event loop
 * for three stall windows, `stopped` stops the watchdog and then stalls for three windows. The surviving modes print
 * `survived` and exit 0 on their own. Real time on purpose: the watchdog thread reads the wall clock of another
 * thread, which fake timers cannot drive; the test only awaits the child's exit.
 */
const CHILD = `
import { startWatchdog } from ${JSON.stringify(WATCHDOG)};
const [mode, logPath] = process.argv.slice(2);
const stallMs = ${STALL_MS};
const watchdog = startWatchdog({ stallMs, beatMs: 100, logPath });
console.log("ready");
if (mode === "block") {
	for (;;) {}
}
if (mode === "idle") {
	setTimeout(() => {
		console.log("survived");
		process.exit(0);
	}, 3 * stallMs);
}
if (mode === "stopped") {
	watchdog.stop();
	const until = Date.now() + 3 * stallMs;
	while (Date.now() < until) {}
	console.log("survived");
	process.exit(0);
}
`;

type Mode = "block" | "idle" | "stopped";
const dirs: string[] = [];
const children = new Set<Bun.Subprocess>();

/**
 * Runs one child to its end in a directory of its own (its script and `ompbot.log`: the `block` child's kill line
 * must not reach another child's log). Bounded: a child still running after `limitMs` is killed and reported.
 */
interface ChildResult {
	code: number;
	signal: number | NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	log: string;
	elapsedMs: number;
}

async function runChild(mode: Mode, limitMs = 15_000): Promise<ChildResult> {
	const dir = mkdtempSync(join(tmpdir(), `ompbot-watchdog-${mode}-`));
	dirs.push(dir);
	writeFileSync(join(dir, "child.ts"), CHILD);
	const logPath = join(dir, "ompbot.log");
	const child = Bun.spawn(["bun", join(dir, "child.ts"), mode, logPath], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	children.add(child);
	const startedAt = Date.now();
	const limit = setTimeout(() => child.kill("SIGTERM"), limitMs);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	clearTimeout(limit);
	children.delete(child);
	let log = "";
	try {
		log = readFileSync(logPath, "utf8");
	} catch {
		// no kill line written
	}
	return { code, signal: child.signalCode, stdout, stderr, log, elapsedMs: Date.now() - startedAt };
}

describe("startWatchdog (child bun process)", () => {
	// The three children run at the same time: the file waits for the longest one instead of their sum.
	let results: Record<Mode, ChildResult>;
	beforeAll(async () => {
		const [block, idle, stopped] = await Promise.all([runChild("block"), runChild("idle"), runChild("stopped")]);
		results = { block, idle, stopped };
	}, 20_000);
	afterAll(() => {
		for (const child of children) child.kill("SIGKILL");
		children.clear();
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	test("a main thread stuck in a loop is SIGKILLed a few seconds after the stall limit, with watchdog_kill on stderr and in the log", () => {
		const result = results.block;
		expect(result.stdout).toBe("ready\n");
		expect(result.signal).toBe("SIGKILL");
		expect(result.elapsedMs).toBeGreaterThanOrEqual(STALL_MS);
		expect(result.elapsedMs).toBeLessThan(STALL_MS + 8_000);
		const line = JSON.parse(result.stderr.trim().split("\n").at(-1) ?? "{}");
		expect(line).toMatchObject({ level: "error", event: "watchdog_kill" });
		expect(line.stalled_ms).toBeGreaterThanOrEqual(STALL_MS);
		expect(result.log).toContain('"event":"watchdog_kill"');
	});

	test("an idle but responsive main thread outlives three stall windows", () => {
		const result = results.idle;
		expect(result).toMatchObject({ code: 0, signal: null, stdout: "ready\nsurvived\n", log: "" });
		expect(result.stderr).not.toContain("watchdog_kill");
	});

	test("after stop() a stalled main thread is left alone", () => {
		expect(results.stopped).toMatchObject({ code: 0, signal: null, stdout: "ready\nsurvived\n", log: "" });
	});

	test("the stall limit is 120 s unless the test hooks set it", () => {
		expect(watchdogStallMs({})).toBe(WATCHDOG_STALL_MS);
		expect(WATCHDOG_STALL_MS).toBe(120_000);
		expect(watchdogStallMs({ OMPBOT_WATCHDOG_STALL_MS: "1000" })).toBe(WATCHDOG_STALL_MS);
		expect(watchdogStallMs({ OMPBOT_TEST_HOOKS: "1", OMPBOT_WATCHDOG_STALL_MS: "1000" })).toBe(1_000);
	});
});

describe("runDaemon exit record (real daemon process)", () => {
	let home: TestHome;
	beforeEach(() => {
		home = makeHome("ompbot-exit-");
	});
	afterEach(() => {
		killSpawned();
		home.remove();
	});
	const logFile = () => readFileSync(join(home.dir, "logs", "ompbot.log"), "utf8");

	for (const [hook, kind] of [
		["rejection", "unhandledRejection"],
		["exception", "uncaughtException"],
	] as const) {
		test(`an ${kind} leaves one daemon_fatal line in ompbot.log and exits 1`, async () => {
			const daemon = spawnDaemon(home.dir, join(home.dir, "transport.jsonl"), { OMPBOT_TEST_FATAL: hook });
			expect(await daemon.exited).toBe(1);
			const fatal = logFile()
				.split("\n")
				.filter((line) => line.includes("event=daemon_fatal"));
			expect(fatal).toHaveLength(1);
			expect(fatal[0]).toContain(`kind=${kind}`);
			expect(fatal[0]).toContain("test_fatal");
			expect(logFile()).toContain("event=daemon_exit code=1");
			await daemon.waitLog(/event=daemon_fatal/);
		}, 30_000);
	}

	test("a SIGTERM stop records daemon_exit code=0", async () => {
		const daemon = spawnDaemon(home.dir, join(home.dir, "transport.jsonl"));
		await daemon.waitLog(/event=daemon_ready/);
		daemon.signal("SIGTERM");
		expect(await daemon.exited).toBe(0);
		expect(logFile()).toContain("event=daemon_exit code=0");
		expect(logFile()).not.toContain("daemon_fatal");
		await daemon.waitLog(/event=daemon_exit code=0/);
	}, 30_000);
});
