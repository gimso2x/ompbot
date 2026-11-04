import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/log";
import { normalizeIncidentError } from "../src/monitors/incidents";
import { type ClaimResult, MONITOR_INCIDENT_REPEAT_MS } from "../src/monitors/ledger";
import { isWakeGateOff, MonitorScheduler } from "../src/monitors/scheduler";
import { runScript } from "../src/monitors/script";
import { type MonitorSpec, parseMonitorSpec } from "../src/monitors/spec";
import { redact } from "../src/redact";
import {
	APPROVAL_ACTION_PREFIX,
	ApprovalBroker,
	type ApprovalStore,
	type ApprovalTimers,
	approvalActionId,
	parseApprovalActionId,
} from "../src/safety/approval";
import { SlackChannel } from "../src/slack/channel";
import { FakeSlackTransport } from "../src/slack/fake-transport";
import { openStore, type Store } from "../src/store/db";

const OWNER = "UOWNER";
const T0 = Date.UTC(2026, 5, 1, 0, 0, 0);
const MINUTE = 60_000;

class FakeClock {
	t = T0;
	now(): number {
		return this.t;
	}
	advance(ms: number): void {
		this.t += ms;
	}
}

let dir: string;
let clock: FakeClock;
let store: Store;
let scheduler: MonitorScheduler;

const scriptsRoot = () => join(dir, "scripts");
const dbPath = () => join(dir, "ompbot.db");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-adv-monapp-"));
	mkdirSync(scriptsRoot());
	mkdirSync(join(dir, "workspace"));
	clock = new FakeClock();
	const log = createLogger({ sink: () => undefined, clock, redact });
	store = openStore({ path: dbPath(), clock, redact, ownerSlackUserId: OWNER });
	// The router only has to accept the hand-off: events stay `dispatched`, so stages show what the ledger decided.
	scheduler = new MonitorScheduler({
		store,
		router: { route: async () => {}, newEpochIfIdle: async () => false },
		clock,
		log,
		scriptsRoot: scriptsRoot(),
		workspaceDir: join(dir, "workspace"),
	});
	scheduler.start();
});

afterEach(async () => {
	await scheduler.idle();
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function writeScript(name: string, body: string): string {
	const path = join(scriptsRoot(), name);
	writeFileSync(path, body);
	chmodSync(path, 0o755);
	return path;
}

/** A read-only second connection: the Store keeps its handle private. */
function rawQuery<T>(sql: string, ...params: string[]): T[] {
	const db = new Database(dbPath(), { readonly: true });
	try {
		return db.query(sql).all(...params) as T[];
	} finally {
		db.close();
	}
}

const approvalStatus = (id: string): string | undefined =>
	rawQuery<{ status: string }>("SELECT status FROM approvals WHERE approval_id = ?", id)[0]?.status;

type ScriptTriggerOverrides = { fire?: "edge" | "every"; once?: boolean; suppressUnchanged?: boolean };

/** A ledger-level script monitor spec (never executed; `recordScriptCheck` is fed by hand). */
const scriptSpec = (name: string, trigger: ScriptTriggerOverrides = {}): MonitorSpec => ({
	name,
	trigger: { kind: "script", command: ["/bin/true"], intervalMs: MINUTE, fire: "every", once: false, ...trigger },
	instruction: "x",
	overlap: "queue",
	enabled: true,
});

const checkStatus = (r: ClaimResult | undefined): string => (r === undefined ? "none" : r.status);

// ---------------------------------------------------------------------------------------------------------------
// suppressUnchanged
// ---------------------------------------------------------------------------------------------------------------

describe("suppressUnchanged (script end to end)", () => {
	const outFile = () => join(dir, "out.txt");
	const emit = (text: string) => writeFileSync(outFile(), text);
	const addEmitter = (trigger: ScriptTriggerOverrides = {}) => {
		const script = writeScript("emit.sh", '#!/bin/sh\ncat "$1"\n');
		return store.monitors.addMonitor(
			parseMonitorSpec(
				{
					name: "emitter",
					trigger: {
						kind: "script",
						command: [script, outFile()],
						intervalMs: MINUTE,
						fire: "every",
						suppressUnchanged: true,
						...trigger,
					},
					instruction: "report",
				},
				{ scriptsRoot: scriptsRoot() },
			),
		);
	};
	async function interval() {
		clock.advance(MINUTE);
		await scheduler.tick();
		await scheduler.idle();
	}
	const skipped = () => store.monitors.listEvents().map((event) => event.stage === "skipped");

	test("whitespace inside the output changes the hash; only edge whitespace (trimmed by the runner) does not", async () => {
		addEmitter();
		emit("a  b");
		await interval();
		emit("a b");
		await interval();
		emit("a b\n\n\n");
		await interval();
		emit("   a b");
		await interval();
		// Inner-space difference is a different output (no normalization): the 2nd one fires. Edge whitespace is trimmed
		// by runScript, so the 3rd and 4th are the same output as the 2nd.
		expect(skipped()).toEqual([false, false, true, true]);
		const last = store.monitors.listEvents().at(-1);
		expect(last?.payload?.startsWith(`no_change:${sha("a b").slice(0, 8)}`)).toBe(true);
	});

	test("every + suppress: repeated output is skipped, a change refreshes the hash, and A,B,A fires the second A", async () => {
		const monitor = addEmitter();
		emit("A");
		await interval();
		await interval();
		await interval();
		expect(skipped()).toEqual([false, true, true]);
		emit("B");
		await interval();
		expect(store.monitors.getMonitor(monitor.id)?.lastOutputHash).toBe(sha("B"));
		emit("A");
		await interval();
		// Only the immediately previous met output is compared.
		expect(skipped()).toEqual([false, true, true, false, false]);
		expect(store.monitors.getMonitor(monitor.id)?.lastOutputHash).toBe(sha("A"));
	});

	test("a wake_gate line suppresses the agent but still records the hash and the met state", async () => {
		const monitor = addEmitter();
		const gated = 'alert\n{"wakeAgent": false}';
		emit(gated);
		await interval();
		const [event] = store.monitors.listEvents();
		expect(event?.stage).toBe("skipped");
		expect(event?.payload?.startsWith("wake_gate\n")).toBe(true);
		const row = store.monitors.getMonitor(monitor.id);
		expect(row?.lastScriptState).toBe("met");
		expect(row?.lastOutputHash).toBe(sha(gated));
		// wakeAgent:true on the same last line position does wake the agent.
		emit('alert\n{"wakeAgent": true}');
		await interval();
		expect(skipped()).toEqual([true, false]);
	});

	test("DEFECT: output that differs only after the 8000-char cap is hashed as unchanged and the change is swallowed", async () => {
		const script = writeScript("long.sh", "#!/bin/sh\nhead -c 8100 /dev/zero | tr '\\0' x\necho\ncat \"$1\"\n");
		store.monitors.addMonitor(
			parseMonitorSpec(
				{
					name: "long",
					trigger: {
						kind: "script",
						command: [script, outFile()],
						intervalMs: MINUTE,
						fire: "every",
						suppressUnchanged: true,
					},
					instruction: "report",
				},
				{ scriptsRoot: scriptsRoot() },
			),
		);
		emit("version-1");
		await interval();
		emit("version-2");
		await interval();
		// The real change (version-1 -> version-2) sits past the cap, so the second check must still wake the agent.
		expect(skipped()).toEqual([false, false]);
	});

	test('DEFECT: a {"wakeAgent": false} last line is lost when the output exceeds the 8000-char cap', async () => {
		const script = writeScript(
			"biglog.sh",
			"#!/bin/sh\nhead -c 9000 /dev/zero | tr '\\0' x\necho\necho '{\"wakeAgent\": false}'\n",
		);
		const result = await runScript([script], { scriptsRoot: scriptsRoot(), cwd: dir });
		expect(result.fired).toBe(true);
		expect(isWakeGateOff(result.stdout)).toBe(true);
	});
});

describe("suppressUnchanged (ledger)", () => {
	test("once + suppress: the first fire consumes the once; the re-armed monitor must fire even with identical output", () => {
		const ledger = store.monitors;
		const monitor = ledger.addMonitor(scriptSpec("once-suppress", { once: true, suppressUnchanged: true }));
		const first = ledger.recordScriptCheck({ monitorId: monitor.id, outcome: "met", slotAt: 1_000, hash: "HASH-A" });
		expect(checkStatus(first)).toBe("admitted");
		expect(ledger.getMonitor(monitor.id)?.enabled).toBe(false);
		// "re-enabling re-arms" a one-shot (updateMonitor resets the cursor and the observed state)...
		ledger.updateMonitor(monitor.id, {
			...scriptSpec("once-suppress", { once: true, suppressUnchanged: true }),
			enabled: true,
		});
		const second = ledger.recordScriptCheck({ monitorId: monitor.id, outcome: "met", slotAt: 2_000, hash: "HASH-A" });
		// ...but the stale last_output_hash survives, so the re-armed fire is silently turned into a `no_change` skip
		// and the one-shot burns itself without ever waking the agent.
		expect(checkStatus(second)).toBe("admitted");
	});

	test("changing the script command resets the edge state but must also drop the stale output hash", () => {
		const ledger = store.monitors;
		const monitor = ledger.addMonitor(scriptSpec("cmd-change", { suppressUnchanged: true }));
		ledger.recordScriptCheck({ monitorId: monitor.id, outcome: "met", slotAt: 1_000, hash: "HASH-A" });
		ledger.updateMonitor(monitor.id, {
			...scriptSpec("cmd-change", { suppressUnchanged: true }),
			trigger: {
				kind: "script",
				command: ["/bin/false"],
				intervalMs: MINUTE,
				fire: "every",
				once: false,
				suppressUnchanged: true,
			},
		});
		expect(ledger.getMonitor(monitor.id)?.lastScriptState).toBeNull();
		const next = ledger.recordScriptCheck({ monitorId: monitor.id, outcome: "met", slotAt: 2_000, hash: "HASH-A" });
		expect(checkStatus(next)).toBe("admitted");
	});

	test("an error check leaves the hash alone; a different output after it fires and replaces the hash", () => {
		const ledger = store.monitors;
		const monitor = ledger.addMonitor(scriptSpec("err-hash", { suppressUnchanged: true }));
		const check = (outcome: "met" | "unmet" | "error", slotAt: number, hash?: string) =>
			ledger.recordScriptCheck({ monitorId: monitor.id, outcome, slotAt, ...(hash === undefined ? {} : { hash }) });
		expect(checkStatus(check("met", 1, "H1"))).toBe("admitted");
		expect(check("error", 2)).toBeUndefined();
		expect(ledger.getMonitor(monitor.id)?.lastOutputHash).toBe("H1");
		expect(checkStatus(check("met", 3, "H1"))).toBe("skipped_overlap");
		expect(checkStatus(check("met", 4, "H2"))).toBe("admitted");
		expect(ledger.getMonitor(monitor.id)?.lastOutputHash).toBe("H2");
		// A met check without a hash never suppresses and never erases the stored hash.
		expect(checkStatus(check("met", 5))).toBe("admitted");
		expect(ledger.getMonitor(monitor.id)?.lastOutputHash).toBe("H2");
	});

	test("[regression] edge monitor that recovers (unmet) and trips again with identical output fires again", () => {
		const ledger = store.monitors;
		const monitor = ledger.addMonitor(scriptSpec("edge-recur", { fire: "edge", suppressUnchanged: true }));
		const check = (outcome: "met" | "unmet", slotAt: number) =>
			ledger.recordScriptCheck({ monitorId: monitor.id, outcome, slotAt, hash: "HASH-DISK-91" });
		expect(checkStatus(check("met", 1))).toBe("admitted");
		expect(check("unmet", 2)).toBeUndefined();
		// An unmet check re-arms the monitor and forgets the stored hash, so the recurrence after recovery fires.
		expect(ledger.getMonitor(monitor.id)?.lastOutputHash).toBeNull();
		expect(checkStatus(check("met", 3))).toBe("admitted");
	});

	test("every + suppress without the flag set never suppresses identical output", () => {
		const ledger = store.monitors;
		const monitor = ledger.addMonitor(scriptSpec("no-flag", { suppressUnchanged: false }));
		const check = (slotAt: number) =>
			ledger.recordScriptCheck({ monitorId: monitor.id, outcome: "met", slotAt, hash: "H" });
		expect([checkStatus(check(1)), checkStatus(check(2)), checkStatus(check(3))]).toEqual([
			"admitted",
			"admitted",
			"admitted",
		]);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// wake gate
// ---------------------------------------------------------------------------------------------------------------

describe("isWakeGateOff", () => {
	const gate = '{"wakeAgent": false}';
	test.each([
		["plain last line", `report\n${gate}`, true],
		["only line", gate, true],
		["compact JSON", '{"wakeAgent":false}', true],
		["leading BOM (String.trim strips U+FEFF)", `report\n\uFEFF${gate}`, true],
		["leading spaces and tabs", `report\n \t ${gate}`, true],
		["CRLF line endings", `report\r\n${gate}\r\n`, true],
		["trailing blank lines", `report\n${gate}\n\n\n  \n`, true],
		["NBSP padding", `\u00A0${gate}\u00A0`, true],
		["extra keys are fine", '{"wakeAgent": false, "reason": "quiet"}', true],
		["empty stdout", "", false],
		["whitespace only", " \n\t\n", false],
		["gate is not the last non-empty line", `${gate}\nmore output`, false],
		["wakeAgent true", '{"wakeAgent": true}', false],
		["string false", '{"wakeAgent": "false"}', false],
		["number 0", '{"wakeAgent": 0}', false],
		["null value", '{"wakeAgent": null}', false],
		["nested object", '{"result": {"wakeAgent": false}}', false],
		["array wrapper", '[{"wakeAgent": false}]', false],
		["JSON null", "null", false],
		["bare number", "5", false],
		["invalid JSON (single quotes)", "{'wakeAgent': false}", false],
		["invalid JSON (trailing comma)", '{"wakeAgent": false,}', false],
		["prose before the JSON on the same line", `status ${gate}`, false],
		["zero-width space before the JSON", `\u200B${gate}`, false],
		["pretty-printed multi-line JSON ends with a brace line", '{\n  "wakeAgent": false\n}', false],
		["duplicate keys: the last one wins", '{"wakeAgent": false, "wakeAgent": true}', false],
		["Korean prose line", "정상입니다 — 알릴 것 없음", false],
	])("%s", (_name, stdout, expected) => {
		expect(isWakeGateOff(stdout)).toBe(expected);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// [SILENT] / NO_REPORT
// ---------------------------------------------------------------------------------------------------------------

describe("answer markers: NO_REPORT and [SILENT]", () => {
	/** Runs one manual event to `settleAnswered` and returns whether it would be reported. */
	function settle(answer: string): { report: boolean; stage: string } {
		const ledger = store.monitors;
		const monitor =
			ledger.getMonitor("answers") ??
			ledger.addMonitor({
				...scriptSpec("answers"),
				trigger: { kind: "cron", schedule: "0 0 1 1 *", timezone: "UTC" },
			});
		const event = ledger.admitManual(monitor.id);
		expect(ledger.markDispatched(event.eventId, `monitor:${monitor.id}:${event.eventId}:1`)).toBe(true);
		const settled = ledger.settleAnswered(event.eventId, answer);
		if (settled === undefined) throw new Error("settleAnswered returned undefined");
		return { report: settled.report, stage: settled.event.stage };
	}

	test.each([
		["bare NO_REPORT", "NO_REPORT"],
		["bare [SILENT]", "[SILENT]"],
		["surrounding spaces and newlines", "  \n[SILENT]\n  "],
		["CRLF", "[SILENT]\r\n"],
		["NO_REPORT padded", "\n\tNO_REPORT \n"],
	])("whole-response marker stays silent: %s", (_name, answer) => {
		expect(settle(answer)).toEqual({ report: false, stage: "no_report" });
	});

	test.each([
		["lower-case [silent]", "[silent]"],
		["bracketless SILENT", "SILENT"],
		["marker plus a period", "[SILENT]."],
		["no_report lower-case", "no_report"],
		["marker only in the middle of the body", "alpha\n[SILENT]\nomega"],
		["marker embedded in a sentence", "표식 [SILENT] 는 이렇게 씁니다"],
	])("non-marker text is still reported: %s", (_name, answer) => {
		expect(settle(answer)).toEqual({ report: true, stage: "authored" });
	});

	test("DEFECT: first line [SILENT] with a body is documented (and prompted) as silent, but is delivered with the literal marker", () => {
		// buildMonitorPrompt tells the agent: "전달을 조용히 생략하고 기록만 남기려면 첫 줄을 [SILENT]로 하세요", and the
		// SILENT doc comment says entire-response / first-line / last-line. settleAnswered only checks the whole text.
		expect(settle("[SILENT]\n기록용: 디스크 91%, 임계 미만이라 알리지 않음").report).toBe(false);
	});

	test("DEFECT: last line [SILENT] after a body is documented as silent, but is delivered", () => {
		expect(settle("점검 결과 이상 없음\n[SILENT]").report).toBe(false);
	});

	test("DEFECT: NO_REPORT and [SILENT] together (two lines) are not silent", () => {
		expect(settle("NO_REPORT\n[SILENT]").report).toBe(false);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// incidents
// ---------------------------------------------------------------------------------------------------------------

describe("recordMonitorIncident", () => {
	const REPEAT = MONITOR_INCIDENT_REPEAT_MS;

	test("window boundary: exactly repeatMs re-alerts, one ms earlier stays quiet; the re-alert restarts the window", () => {
		const incidents = store.monitors;
		expect(incidents.recordMonitorIncident("mA", "boom", 10_000)).toEqual({ notify: true, count: 1 });
		expect(incidents.recordMonitorIncident("mA", "boom", 10_000 + REPEAT - 1)).toEqual({ notify: false, count: 2 });
		// A quiet repeat does not refresh alerted_at: the window is still anchored at 10_000.
		expect(incidents.recordMonitorIncident("mA", "boom", 10_000 + REPEAT)).toEqual({ notify: true, count: 3 });
		expect(incidents.recordMonitorIncident("mA", "boom", 10_000 + REPEAT + 1)).toEqual({ notify: false, count: 4 });
		expect(incidents.recordMonitorIncident("mA", "boom", 10_000 + 2 * REPEAT)).toEqual({ notify: true, count: 5 });
	});

	test("repeatMs = 0 alerts every time; a backwards clock stays quiet instead of throwing", () => {
		const incidents = store.monitors;
		expect(incidents.recordMonitorIncident("mZ", "x", 5_000, 0).notify).toBe(true);
		expect(incidents.recordMonitorIncident("mZ", "x", 5_000, 0).notify).toBe(true);
		expect(incidents.recordMonitorIncident("mZ", "x", 5_001, 0).notify).toBe(true);
		const back = incidents.recordMonitorIncident("mZ", "x", 1_000, REPEAT);
		expect(back.notify).toBe(false);
		expect(back.count).toBe(4);
	});

	test("the same error on another monitor is a separate incident, and resolving one leaves the other open", () => {
		const incidents = store.monitors;
		expect(incidents.recordMonitorIncident("m1", "connection refused", 1_000)).toEqual({ notify: true, count: 1 });
		expect(incidents.recordMonitorIncident("m2", "connection refused", 1_100)).toEqual({ notify: true, count: 1 });
		expect(incidents.recordMonitorIncident("m1", "connection refused", 1_200).notify).toBe(false);
		incidents.resolveMonitorIncidents("m1");
		expect(incidents.recordMonitorIncident("m2", "connection refused", 1_300)).toEqual({ notify: false, count: 2 });
		expect(incidents.recordMonitorIncident("m1", "connection refused", 1_400)).toEqual({ notify: true, count: 1 });
	});

	test("a different error on the same monitor is its own incident and is not resolved-by-proxy", () => {
		const incidents = store.monitors;
		expect(incidents.recordMonitorIncident("m1", "ENOENT script", 1_000).notify).toBe(true);
		expect(incidents.recordMonitorIncident("m1", "EACCES script", 1_001).notify).toBe(true);
		expect(incidents.recordMonitorIncident("m1", "ENOENT script", 1_002).notify).toBe(false);
	});

	test("resolved then recurrence inside the window alerts loudly with the count reset; resolving nothing is harmless", () => {
		const incidents = store.monitors;
		incidents.resolveMonitorIncidents("never-seen");
		expect(incidents.recordMonitorIncident("m1", "oops", 1_000).notify).toBe(true);
		expect(incidents.recordMonitorIncident("m1", "oops", 2_000).count).toBe(2);
		incidents.resolveMonitorIncidents("m1");
		incidents.resolveMonitorIncidents("m1");
		expect(incidents.recordMonitorIncident("m1", "oops", 3_000)).toEqual({ notify: true, count: 1 });
		expect(incidents.recordMonitorIncident("m1", "oops", 3_001)).toEqual({ notify: false, count: 2 });
	});

	test.each([
		["603s vs 611s", "timeout after 603s", "timeout after 611s"],
		["Korean seconds", "시간 초과 603초", "시간 초과 611초"],
		["Korean minutes", "10분 동안 응답 없음", "20분 동안 응답 없음"],
		["Korean hours", "2시간 경과", "5시간 경과"],
		["decimal hours", "stalled 1.5h", "stalled 2.25h"],
		["milliseconds", "took 1200ms", "took 980ms"],
		["long ids", "run 8812345 failed", "run 9923456 failed"],
		["whitespace and the turn-failed prefix", "[turn failed]   timeout   after 603s", "timeout after 611s"],
	])("masking treats these as one incident: %s", (_name, a, b) => {
		expect(normalizeIncidentError(a)).toBe(normalizeIncidentError(b));
		const incidents = store.monitors;
		incidents.recordMonitorIncident("mmask", a, 1_000);
		expect(incidents.recordMonitorIncident("mmask", b, 2_000).notify).toBe(false);
	});

	test('masking gap: spelled-out English units ("90 seconds" vs "95 seconds") should share one incident', () => {
		// `\d+\s*(ms|초|분|시간|s\b|m\b|h\b)` needs the unit to end at a word boundary, so "seconds"/"minutes"/"hours"
		// are not masked and 2-digit numbers fall below the `\d{3,}` fallback.
		expect(normalizeIncidentError("timed out after 90 seconds")).toBe(
			normalizeIncidentError("timed out after 95 seconds"),
		);
	});

	test("[regression] 3-digit numbers keep distinct failures as separate incidents (HTTP 429 vs 503, exit 137 vs 139)", () => {
		const incidents = store.monitors;
		expect(incidents.recordMonitorIncident("mhttp", "upstream HTTP 429", 1_000).notify).toBe(true);
		expect(incidents.recordMonitorIncident("mhttp", "upstream HTTP 503", 2_000).notify).toBe(true);
		expect(normalizeIncidentError("exit code 137")).not.toBe(normalizeIncidentError("exit code 139"));
	});

	test("[regression] the signature covers the whole text, so errors differing after 200 chars are separate incidents", () => {
		const prefix = "x".repeat(200);
		expect(store.monitors.recordMonitorIncident("mlong", `${prefix} cause: disk full`, 1_000).notify).toBe(true);
		expect(store.monitors.recordMonitorIncident("mlong", `${prefix} cause: permission denied`, 2_000).notify).toBe(
			true,
		);
	});

	test("[regression] turn-failure signs differing only in exit 137 vs 139 are separate alert incidents", () => {
		const first = store.recordAlertIncident("dispatch:k", "[turn failed] exit 137 (killed)", 1_000);
		const other = store.recordAlertIncident("dispatch:k", "[turn failed] exit 139 (killed)", 2_000);
		expect(first.notify).toBe(true);
		expect(other.notify).toBe(true);
		expect(store.recordAlertIncident("dispatch:k", "[turn failed] exit 139 (killed)", 3_000).notify).toBe(false);
	});

	test("empty and unicode-only errors do not break the signature", () => {
		const incidents = store.monitors;
		expect(incidents.recordMonitorIncident("mempty", "", 1_000)).toEqual({ notify: true, count: 1 });
		expect(incidents.recordMonitorIncident("mempty", "   \n\t ", 1_001)).toEqual({ notify: false, count: 2 });
		expect(incidents.recordMonitorIncident("mkr", "💥 모니터 실패 — 원인 불명", 1_000).notify).toBe(true);
		expect(incidents.recordMonitorIncident("mkr", "💥 모니터 실패 — 원인 불명", 1_001).notify).toBe(false);
	});

	test("removing a monitor must not leave its incident rows behind (no FK on monitor_incidents)", () => {
		const monitor = store.monitors.addMonitor(scriptSpec("incident-owner"));
		store.monitors.recordMonitorIncident(monitor.id, "boom", 1_000);
		expect(store.monitors.removeMonitor(monitor.id)).toBe(true);
		const rows = rawQuery<{ n: number }>(
			"SELECT COUNT(*) AS n FROM monitor_incidents WHERE monitor_id = ?",
			monitor.id,
		);
		expect(rows[0]?.n).toBe(0);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// approvals
// ---------------------------------------------------------------------------------------------------------------

/** Resolves `shown` when the buttons go up and `finalized` when a card update removes them. */
class CardTransport extends FakeSlackTransport {
	readonly shown = Promise.withResolvers<{ ts: string }>();
	readonly finalized = Promise.withResolvers<{ text: string }>();

	override async updateMessage(args: {
		channel: string;
		ts: string;
		text: string;
		blocks?: readonly unknown[] | undefined;
	}): Promise<void> {
		await super.updateMessage(args);
		if (args.blocks !== undefined && args.blocks.length > 0) this.shown.resolve({ ts: args.ts });
		else this.finalized.resolve({ text: args.text });
	}
}

class ManualTimers implements ApprovalTimers {
	readonly callbacks = new Map<number, () => void>();
	#next = 1;
	set(fn: () => void): unknown {
		const id = this.#next++;
		this.callbacks.set(id, fn);
		return id;
	}
	clear(handle: unknown): void {
		this.callbacks.delete(handle as number);
	}
	fireAll(): void {
		for (const fn of [...this.callbacks.values()]) fn();
	}
}

const quietLog = () => createLogger({ sink: () => undefined, clock: { now: () => 0 }, redact });

function makeBroker(
	transport: FakeSlackTransport,
	timers: ApprovalTimers,
	now: () => number,
	approvalStore: ApprovalStore = store as unknown as ApprovalStore,
	timeoutMs?: number,
): ApprovalBroker {
	return new ApprovalBroker({
		port: new SlackChannel(transport),
		ownerUserId: OWNER,
		log: quietLog(),
		store: approvalStore,
		clock: { now },
		timers,
		...(timeoutMs === undefined ? {} : { timeoutMs }),
	});
}

const click = (decision: "approve" | "deny", ts: string, userId = OWNER, channel = "D1") => ({
	actionId: approvalActionId(decision, channel, ts),
	userId,
});

describe("durable approval rows (db)", () => {
	const create = (id: string, expiresAt: number) =>
		store.createApproval({
			approvalId: id,
			channel: "D1",
			messageTs: id.split(":")[1] ?? id,
			summary: "s",
			createdAt: 1_000,
			expiresAt,
		});

	test("expires_at boundary: one ms before is not due, exactly now is due, and a second sweep finds nothing", () => {
		create("D1:1.1", 5_000);
		expect(store.expirePendingApprovals(4_999)).toEqual([]);
		expect(approvalStatus("D1:1.1")).toBe("pending");
		expect(store.expirePendingApprovals(5_000).map((row) => row.approvalId)).toEqual(["D1:1.1"]);
		expect(store.expirePendingApprovals(5_000)).toEqual([]);
		expect(approvalStatus("D1:1.1")).toBe("expired");
	});

	test("every terminal state is final: approve->deny, deny->approve, expired->approve, unknown id", () => {
		create("D1:1.1", 90_000);
		create("D1:2.2", 90_000);
		create("D1:3.3", 90_000);
		expect(store.decideApproval("D1:1.1", "approved", 2_000)).toBe(true);
		expect(store.decideApproval("D1:1.1", "denied", 2_001)).toBe(false);
		expect(approvalStatus("D1:1.1")).toBe("approved");
		expect(store.decideApproval("D1:2.2", "denied", 2_000)).toBe(true);
		expect(store.decideApproval("D1:2.2", "approved", 2_001)).toBe(false);
		expect(approvalStatus("D1:2.2")).toBe("denied");
		expect(store.expirePendingApprovals(1, false).map((row) => row.approvalId)).toEqual(["D1:3.3"]);
		expect(store.decideApproval("D1:3.3", "approved", 2_002)).toBe(false);
		expect(store.decideApproval("D9:9.9", "approved", 2_003)).toBe(false);
	});

	test("DEFECT (design): a row that is already due (now >= expires_at) but not yet swept can still be approved", () => {
		create("D1:1.1", 5_000);
		// expirePendingApprovals(5_000) would expire this row, so deciding "approved" at 5_000 must lose.
		expect(store.decideApproval("D1:1.1", "approved", 5_000)).toBe(false);
	});

	test("a forced sweep takes future rows and leaves decided rows alone", () => {
		create("D1:1.1", 9_000_000);
		create("D1:2.2", 9_000_000);
		store.decideApproval("D1:1.1", "approved", 2_000);
		expect(store.expirePendingApprovals(3_000, false).map((row) => row.approvalId)).toEqual(["D1:2.2"]);
		expect(approvalStatus("D1:1.1")).toBe("approved");
	});

	test("duplicate approval ids are rejected by the primary key instead of overwriting", () => {
		create("D1:1.1", 9_000);
		expect(() => create("D1:1.1", 99_000)).toThrow();
		expect(
			rawQuery<{ expires_at: number }>("SELECT expires_at FROM approvals WHERE approval_id = 'D1:1.1'")[0]?.expires_at,
		).toBe(9_000);
	});
});

describe("approval action ids", () => {
	test("round trip", () => {
		expect(parseApprovalActionId(approvalActionId("deny", "D123", "1800000000.000001"))).toEqual({
			decision: "deny",
			channel: "D123",
			ts: "1800000000.000001",
		});
	});

	test.each([
		["empty", ""],
		["wrong prefix", "ompbot:approvalx:approve:D1:1.1"],
		["upper-case decision", `${APPROVAL_ACTION_PREFIX}:APPROVE:D1:1.1`],
		["unknown decision", `${APPROVAL_ACTION_PREFIX}:maybe:D1:1.1`],
		["empty channel", `${APPROVAL_ACTION_PREFIX}:approve::1.1`],
		["empty ts", `${APPROVAL_ACTION_PREFIX}:approve:D1:`],
		["extra segment", `${APPROVAL_ACTION_PREFIX}:approve:D1:1.1:extra`],
		["missing segment", `${APPROVAL_ACTION_PREFIX}:approve:D1`],
		["leading space", ` ${APPROVAL_ACTION_PREFIX}:approve:D1:1.1`],
	])("rejects %s", (_name, actionId) => {
		expect(parseApprovalActionId(actionId)).toBeUndefined();
	});
});

describe("ApprovalBroker races", () => {
	/** Starts a request and waits until its buttons are up. */
	async function start(
		opts: { now?: () => number; store?: ApprovalStore; timeoutMs?: number; signal?: AbortSignal } = {},
	) {
		const transport = new CardTransport();
		const timers = new ManualTimers();
		const broker = makeBroker(transport, timers, opts.now ?? (() => 1_000), opts.store, opts.timeoutMs);
		const done = broker.request("D1", "git push --force", opts.signal);
		const { ts } = await transport.shown.promise;
		return { transport, timers, broker, done, ts, id: `D1:${ts}` };
	}

	test("click before the timeout: approved wins, the ledger says approved, the timer is cleared", async () => {
		const { broker, timers, done, ts, id } = await start();
		expect(broker.handleAction(click("approve", ts))).toBe(true);
		timers.fireAll();
		expect(await done).toBe("approved");
		expect(approvalStatus(id)).toBe("approved");
		expect(timers.callbacks.size).toBe(0);
		expect(broker.pendingCount).toBe(0);
	});

	test("timeout before the click: timeout wins and the ledger says expired", async () => {
		const { broker, timers, done, ts, id } = await start();
		timers.fireAll();
		expect(await done).toBe("timeout");
		expect(approvalStatus(id)).toBe("expired");
		// After the request is over a late click is ignored.
		expect(broker.handleAction(click("approve", ts))).toBe(false);
		expect(approvalStatus(id)).toBe("expired");
	});

	test("double click approve -> deny in the same tick: the first decision stands in the result and the ledger", async () => {
		const { broker, done, ts, id } = await start();
		broker.handleAction(click("approve", ts));
		broker.handleAction(click("deny", ts));
		expect(await done).toBe("approved");
		expect(approvalStatus(id)).toBe("approved");
	});

	test('DEFECT (minor): the second click of a double click reports `true` ("settled a pending request") though it settled nothing', async () => {
		const { broker, done, ts } = await start();
		expect(broker.handleAction(click("approve", ts))).toBe(true);
		// Documented: "Returns true when the click settled a pending request"; a repeated click is "ignored".
		expect(broker.handleAction(click("deny", ts))).toBe(false);
		await done;
	});

	test("DEFECT (minor): a click that lands after the timer fired but before the request unwinds reports `true`", async () => {
		const { broker, timers, done, ts } = await start();
		timers.fireAll();
		expect(broker.handleAction(click("approve", ts))).toBe(false);
		expect(await done).toBe("timeout");
	});

	test("DEFECT: after the periodic sweeper expired the row and rewrote the card to 'timed out', a click still approves", async () => {
		let now = 1_000;
		const { broker, timers, transport, done, ts, id } = await start({ now: () => now, timeoutMs: 60_000 });
		now = 61_000; // exactly expires_at: the sweep (daemon.ts sweeper) expires the row and relabels the card
		expect(await broker.expireStale()).toBe(1);
		expect(approvalStatus(id)).toBe("expired");
		const card = transport.calls.filter((c) => c.method === "updateMessage").at(-1);
		expect(card?.method === "updateMessage" ? card.text : "").toContain("시간 초과");
		// The owner clicks the (already relabelled) card in the window before the in-memory timer fires.
		const handled = broker.handleAction(click("approve", ts));
		timers.fireAll();
		const outcome = await done;
		// The ledger is documented as "the authority": a click on an expired row must not grant anything.
		expect(handled).toBe(false);
		expect(outcome).toBe("timeout");
	});

	test("non-owner clicks, foreign message ts and malformed ids are ignored; the owner's click still works afterwards", async () => {
		const { broker, done, ts, id } = await start();
		expect(broker.handleAction(click("approve", ts, "UINTRUDER"))).toBe(false);
		expect(broker.handleAction(click("approve", "1800000000.999999"))).toBe(false);
		expect(broker.handleAction(click("approve", ts, OWNER, "D2"))).toBe(false);
		expect(broker.handleAction({ actionId: "ompbot:approval:approve:D1", userId: OWNER })).toBe(false);
		expect(broker.handleAction({ actionId: "something:else", userId: OWNER })).toBe(false);
		expect(broker.pendingCount).toBe(1);
		expect(approvalStatus(id)).toBe("pending");
		expect(broker.handleAction(click("deny", ts))).toBe(true);
		expect(await done).toBe("denied");
		expect(approvalStatus(id)).toBe("denied");
	});

	test("broker restart: the old card's click is ignored by a fresh broker, the boot sweep relabels the card and expires the row", async () => {
		const first = await start();
		const second = makeBroker(first.transport, new ManualTimers(), () => 2_000);
		expect(second.handleAction(click("approve", first.ts))).toBe(false);
		expect(await second.expireStale(false)).toBe(1);
		expect(approvalStatus(first.id)).toBe("expired");
		const final = await first.transport.finalized.promise;
		expect(final.text).toContain("재시작으로 만료됨");
		// A second boot sweep has nothing left to do and sends no further card update.
		const updates = first.transport.count("updateMessage");
		expect(await second.expireStale(false)).toBe(0);
		expect(first.transport.count("updateMessage")).toBe(updates);
		first.timers.fireAll();
		await first.done;
	});

	test("an already-aborted signal denies without hanging and leaves no pending state", async () => {
		const controller = new AbortController();
		controller.abort();
		const transport = new CardTransport();
		const timers = new ManualTimers();
		const broker = makeBroker(transport, timers, () => 1_000);
		expect(await broker.request("D1", "rm -rf /", controller.signal)).toBe("denied");
		expect(broker.pendingCount).toBe(0);
		expect(timers.callbacks.size).toBe(0);
		const ts = transport.calls.find((c) => c.method === "postMessage")?.ts ?? "";
		// Nobody pressed anything: the ledger keeps `denied` for the owner's own no and records an abort as expired.
		expect(approvalStatus(`D1:${ts}`)).toBe("expired");
	});

	test("a failing card update fails closed: denied, timer cleared, nothing left pending", async () => {
		const transport = new CardTransport();
		transport.failNext.updateMessage = [new Error("slack down")];
		const timers = new ManualTimers();
		const broker = makeBroker(transport, timers, () => 1_000);
		expect(await broker.request("D1", "deploy")).toBe("denied");
		expect(broker.pendingCount).toBe(0);
		expect(timers.callbacks.size).toBe(0);
	});

	test("a ledger that cannot record the request does not block the decision (createApproval failure is logged)", async () => {
		const failing: ApprovalStore = {
			createApproval: () => {
				throw new Error("database is locked");
			},
			decideApproval: () => false,
			getApproval: () => undefined,
			replyApproval: () => false,
			expirePendingApprovals: () => [],
		};
		const { broker, done, ts } = await start({ store: failing });
		expect(broker.handleAction(click("approve", ts))).toBe(true);
		expect(await done).toBe("approved");
	});

	test("DEFECT: a ledger that cannot record the decision makes request() reject instead of returning the owner's click", async () => {
		const real = store as unknown as ApprovalStore;
		const flaky: ApprovalStore = {
			createApproval: (input) => real.createApproval(input),
			decideApproval: () => {
				throw new Error("database is locked");
			},
			getApproval: (id) => real.getApproval(id),
			replyApproval: (id, ts, text, now) => real.replyApproval(id, ts, text, now),
			expirePendingApprovals: (now, due) => real.expirePendingApprovals(now, due),
		};
		const { broker, done, ts } = await start({ store: flaky });
		expect(broker.handleAction(click("approve", ts))).toBe(true);
		// createApproval's failure is caught and logged, decideApproval's is not: the owner's real answer is lost to an
		// exception that the caller cannot tell apart from a transport failure.
		await expect(done).resolves.toBe("approved");
	});

	test("DEFECT (minor): the 2500-char summary cut can split a surrogate pair and post a malformed string to Slack", async () => {
		const summary = `${"x".repeat(2499)}😀 tail`;
		const { transport, timers, done } = await start();
		timers.fireAll();
		await done;
		const other = new CardTransport();
		const otherTimers = new ManualTimers();
		const broker = makeBroker(other, otherTimers, () => 1_000);
		const pending = broker.request("D1", summary);
		await other.shown.promise;
		const posted = other.calls.find((c) => c.method === "postMessage");
		otherTimers.fireAll();
		await pending;
		expect(posted?.method === "postMessage" ? posted.text.isWellFormed() : false).toBe(true);
		expect(transport.count("postMessage")).toBe(1);
	});
});
