import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, fileSink } from "../src/log";
import { createAggregatingLogger, startServiceAlive } from "../src/ops/log-hygiene";
import { byteLength, redact } from "../src/redact";

const clock = { now: () => Date.UTC(2026, 9, 19, 12, 0, 0) };
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-log-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function capture(maxLineBytes?: number) {
	const lines: string[] = [];
	const log = createLogger({ sink: (l) => lines.push(l), clock, redact, ...(maxLineBytes ? { maxLineBytes } : {}) });
	return { lines, log };
}

describe("logger", () => {
	test("emits grep-stable key=value lines", () => {
		const { lines, log } = capture();
		log.info("omp_exit", { code: 1, origin: "dm:U1", ok: false, note: "two words", gone: null, skip: undefined });
		expect(lines).toEqual([
			'ts=2026-10-19T12:00:00.000Z level=info event=omp_exit code=1 origin=dm:U1 ok=false note="two words" gone=null',
		]);
	});

	test("newlines and quotes cannot split a line or forge fields", () => {
		const { lines, log } = capture();
		log.warn("evt", { msg: 'a\nlevel=error "x"' });
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain("\n");
	});

	test("reserved and odd keys are neutralised", () => {
		const { lines, log } = capture();
		log.info("evt", { level: "forged", "a b": 1 });
		expect(lines[0]).toBe("ts=2026-10-19T12:00:00.000Z level=info event=evt f_level=forged a_b=1");
	});

	test("every line passes redact: tokens in event, keys, values and objects", () => {
		const { lines, log } = capture();
		log.error("xoxb-TEST-0", {
			token: "xoxb-TEST-0",
			app: "xapp-TEST-0",
			e: "xoxe-TEST-0",
			nested: { k: "sk-ant-TEST-0" },
		});
		const all = lines.join("\n");
		expect(all).not.toMatch(/xox[a-z]-TEST|xapp-TEST|sk-ant-TEST/);
		expect(all).toContain("[REDACTED]");
	});

	test("injected redact is what runs, and a throwing redact never leaks the payload", () => {
		const lines: string[] = [];
		const log = createLogger({
			sink: (l) => lines.push(l),
			clock,
			redact: () => {
				throw new Error("nope");
			},
		});
		log.info("evt", { secret: "xoxb-TEST-0" });
		expect(lines).toEqual(["ts=2026-10-19T12:00:00.000Z level=error event=log_redact_failed"]);
	});

	test("line byte budget (incl. newline) is applied after redaction", () => {
		const { lines, log } = capture(120);
		log.info("evt", { a: "xoxb-a", pad: "x".repeat(500) });
		const line = lines[0] ?? "";
		expect(byteLength(`${line}\n`)).toBeLessThanOrEqual(120);
		expect(line.endsWith(" truncated=1")).toBe(true);
		expect(line).toContain("[REDACTED]");
	});

	test("file sink writes a 0600 log with no token pattern (grep -c = 0)", () => {
		const path = join(dir, "ompbot.log");
		const log = createLogger({ sink: fileSink(path), clock, redact });
		log.info("startup", { bot: "xoxb-TEST-0", app: "xapp-TEST-0", other: "xoxe-TEST-0" });
		log.error("failure", { err: "auth failed for xoxp-TEST-0" });
		const text = readFileSync(path, "utf8");
		expect(text.split("\n").filter(Boolean)).toHaveLength(2);
		expect(text.match(/xox[a-z]-TEST|xapp-TEST/g)?.length ?? 0).toBe(0);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		if (process.env.OMPBOT_TEST_LOG_OUT) {
			Bun.write(process.env.OMPBOT_TEST_LOG_OUT, text);
		}
	});
});

describe("log hygiene", () => {
	/** A manual scheduler: `tick()` is the hour passing. */
	function manualSchedule() {
		let fn: (() => void) | undefined;
		let cancelled = false;
		return {
			schedule: (f: () => void) => {
				fn = f;
				return () => {
					cancelled = true;
				};
			},
			tick: () => fn?.(),
			get cancelled() {
				return cancelled;
			},
		};
	}

	function setup() {
		const lines: string[] = [];
		let now = Date.UTC(2026, 9, 30, 0, 0, 0);
		const clk = { now: () => now };
		const inner = createLogger({ sink: (l) => lines.push(l), clock: clk, redact });
		const timer = manualSchedule();
		const log = createAggregatingLogger(inner, { clock: clk, schedule: timer.schedule });
		return {
			lines,
			log,
			timer,
			advance: (ms: number) => {
				now += ms;
			},
			clk,
			inner,
		};
	}

	test("routine drops are counted, not written; the hourly flush writes one log_summary with the counts", () => {
		const { lines, log, timer, advance } = setup();
		for (let i = 0; i < 5; i++) log.info("inbound_dropped", { reason: "bot_message", channel: "C1", ts: `1.${i}` });
		log.info("inbound_dropped", { reason: "not_addressed", channel: "C1", ts: "2.0" });
		expect(lines).toEqual([]);
		advance(3_600_000);
		timer.tick();
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("level=info event=log_summary window_s=3600 total=6");
		expect(lines[0]).toContain("inbound_dropped_bot_message=5");
		expect(lines[0]).toContain("inbound_dropped_not_addressed=1");
		// counters reset: a quiet hour writes nothing
		timer.tick();
		expect(lines).toHaveLength(1);
	});

	test("warn/error, other info events and other drop reasons pass through as their own lines", () => {
		const { lines, log } = setup();
		log.warn("inbound_dropped", { reason: "bot_message" });
		log.error("inbound_dropped", { reason: "bot_message" });
		log.info("inbound_dropped", { reason: "log_channel" });
		log.info("inbound_dropped", {});
		log.info("tool_start", { tool: "read" });
		log.debug("inbound_dropped", { reason: "bot_message" });
		expect(lines.map((l) => /level=(\w+) event=(\w+)/.exec(l)?.slice(1).join(":"))).toEqual([
			"warn:inbound_dropped",
			"error:inbound_dropped",
			"info:inbound_dropped",
			"info:inbound_dropped",
			"info:tool_start",
			"debug:inbound_dropped",
		]);
	});

	test("stop cancels the timer and flushes the remaining counts, so a shutdown loses none", () => {
		const { lines, log, timer } = setup();
		log.info("inbound_dropped", { reason: "bot_message" });
		log.stop();
		expect(timer.cancelled).toBe(true);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("inbound_dropped_bot_message=1");
	});

	test("service_alive writes uptime and the snapshot each interval, survives a failing snapshot, stops on cancel", () => {
		const { lines, inner, clk, advance } = setup();
		const timer = manualSchedule();
		let busy = 0;
		const stop = startServiceAlive({
			log: inner,
			clock: clk,
			schedule: timer.schedule,
			snapshot: () => ({ origins: 3, busy: busy++, pending: 0, dispatched: 1 }),
		});
		advance(3_600_000);
		timer.tick();
		expect(lines[0]).toBe(
			"ts=2026-10-30T01:00:00.000Z level=info event=service_alive uptime_s=3600 origins=3 busy=0 pending=0 dispatched=1",
		);
		const broken = manualSchedule();
		startServiceAlive({
			log: inner,
			clock: clk,
			schedule: broken.schedule,
			snapshot: () => {
				throw new Error("db closed");
			},
		});
		broken.tick();
		expect(lines[1]).toContain("event=service_alive");
		expect(lines[1]).toContain("snapshot_error");
		stop();
		expect(timer.cancelled).toBe(true);
	});
});
