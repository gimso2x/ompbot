import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatOriginKey } from "../src/core/origin-key";
import { buildRecallBlock } from "../src/core/recall";
import { briefingFileName } from "../src/dashboard/briefing";
import { buildSnapshot } from "../src/dashboard/snapshot";
import { createLogger } from "../src/log";
import { nextFireOf, openMonitorLedger } from "../src/monitors/ledger";
import { parseMonitorSpec } from "../src/monitors/spec";
import { buildMonitorTools } from "../src/monitors/tools";
import { ledgerDay } from "../src/ops/cost-cap";
import { redact } from "../src/redact";
import { buildFloorsPrompt } from "../src/safety/prompt";
import { renderContext, renderProgress } from "../src/tasks/docs";
import { TaskLedger } from "../src/tasks/ledger";
import { buildTaskPrompt } from "../src/tasks/prompt";

const NY = "America/New_York";
/** 2026-11-12T00:00:00Z: 2026-11-11 19:00 in New York (EST, -05:00), 09:00 on the 12th in Seoul. */
const T = Date.parse("2026-11-12T00:00:00Z");

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ompbot-tz-"));
	mkdirSync(join(home, "scripts"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("AC-2: the daily cost ledger day follows config.timezone", () => {
	test("New York: the key changes at New York midnight, also across the DST end on 2026-11-01", () => {
		expect(ledgerDay(Date.parse("2026-11-01T03:59:59Z"), NY)).toBe("20261031");
		expect(ledgerDay(Date.parse("2026-11-01T04:00:00Z"), NY)).toBe("20261101");
		expect(ledgerDay(Date.parse("2026-11-02T04:59:59Z"), NY)).toBe("20261101");
		expect(ledgerDay(Date.parse("2026-11-02T05:00:00Z"), NY)).toBe("20261102");
	});

	test("Asia/Seoul: the same keys the old fixed +9h day gave", () => {
		expect(ledgerDay(Date.parse("2026-11-11T15:00:00Z"), "Asia/Seoul")).toBe("20261112");
		expect(ledgerDay(Date.parse("2026-11-11T14:59:59Z"), "Asia/Seoul")).toBe("20261111");
	});
});

describe("AC-3: a monitor without a zone takes config.timezone at registration", () => {
	for (const [zone, expectedNext] of [
		["UTC", "2026-11-12T09:00:00.000Z"],
		["Asia/Seoul", "2026-11-13T00:00:00.000Z"],
	] as const) {
		test(`cron without timezone under ${zone}: stored zone and next fire in it`, () => {
			const ledger = openMonitorLedger(join(home, "ompbot.db"), { now: () => T });
			try {
				const spec = parseMonitorSpec(
					{ name: "daily", trigger: { kind: "cron", schedule: "0 9 * * *" }, instruction: "x" },
					{ scriptsRoot: join(home, "scripts"), defaultTimezone: zone },
				);
				const row = ledger.addMonitor(spec);
				expect(row.trigger).toEqual({ kind: "cron", schedule: "0 9 * * *", timezone: zone });
				expect(new Date(nextFireOf(row) ?? 0).toISOString()).toBe(expectedNext);
			} finally {
				ledger.close();
			}
		});
	}

	test("an `at` without an offset is wall-clock time in config.timezone", () => {
		const spec = parseMonitorSpec(
			{ name: "once", trigger: { kind: "at", at: "2026-11-20T09:00" }, instruction: "x" },
			{ scriptsRoot: join(home, "scripts"), defaultTimezone: NY },
		);
		expect(spec.trigger).toEqual({ kind: "at", at: "2026-11-20T14:00:00.000Z" });
	});
});

describe("AC-4: written times carry the configured zone's offset (America/New_York)", () => {
	test("TASK documents: PROGRESS updated and context registration time", () => {
		expect(renderProgress("T-20261111-01", T, NY)).toContain("updated: 2026-11-11T19:00:00-05:00\n");
		const meta = {
			taskId: "T-20261111-01",
			hostLabel: "local",
			repo: "/r",
			worktree: "/r-t",
			branch: "task/T-20261111-01",
			agent: "t-20261111-01",
			threadLink: "C1:1.1",
			registeredAt: T,
			timezone: NY,
		};
		const spec = {
			title: "t",
			goal: "g",
			risk: "L1" as const,
			repo: "/r",
			scope: [],
			exclusions: [],
			acceptance: ["a"],
		};
		expect(renderContext(meta, spec, "원문")).toContain("등록: 2026-11-11T19:00:00-05:00");
	});

	test("TASK id date is the New York day", () => {
		const ledger = new TaskLedger(new Database(":memory:", { strict: true }), {
			clock: { now: () => T },
			timezone: NY,
		});
		const row = ledger.register({
			title: "t",
			risk: "L1",
			originKey: "slack/dm/D1",
			threadRef: "C1:1.1",
			host: null,
			repo: "/r",
			acceptance: [{ id: "AC-1", text: "a" }],
		});
		expect(row.taskId).toBe("T-20261111-01");
	});

	test("briefing file name", () => {
		expect(briefingFileName(T, NY)).toBe("20261111-190000");
	});

	test("recall dates", () => {
		const result = buildRecallBlock({
			text: "지난번에 얘기한 grafana 대시보드 설정 기억나?",
			candidates: [
				{
					kind: "inbound",
					originKey: "slack/dm/D1",
					threadRef: "D1:1.1",
					createdAt: T,
					text: "grafana 대시보드 설정 손봐줘",
					opRef: null,
				},
			],
			freshSession: true,
			channel: "D1",
			timezone: NY,
		});
		expect(result.block).toContain("- 2026-11-11 19:00 오너");
	});

	test("dashboard snapshot generatedAt", async () => {
		const snapshot = await buildSnapshot({
			homeDir: home,
			repoDir: home,
			timezone: NY,
			config: undefined,
			now: () => T,
			callDaemon: async () => {
				throw new Error("no daemon");
			},
			run: async () => ({ code: 1, stdout: "", timedOut: false }),
			ompVersion: async () => "omp-stub 0.0.0",
			hostOps: () => {
				throw new Error("no hosts");
			},
			collectGates: () => [],
		});
		expect(snapshot.generatedAt).toBe("2026-11-11T19:00:00-05:00");
		expect(snapshot.timezone).toBe(NY);
	});
});

describe("AC-6: prompt and tool texts name config.timezone and its offset", () => {
	const persona = chatOriginKey({ platform: "slack", kind: "dm", conversationId: "D1" });

	test("monitor tool descriptions", () => {
		const ledger = openMonitorLedger(join(home, "ompbot.db"), { now: () => T });
		try {
			const tools = buildMonitorTools({
				originKey: persona,
				ledger,
				scriptsRoot: join(home, "scripts"),
				timezone: NY,
				now: () => T,
				log: createLogger({ sink: () => undefined, clock: { now: () => T }, redact }),
			});
			const text = JSON.stringify(tools.map((tool) => [tool.description, tool.parameters]));
			expect(text).toContain("<ISO time, America/New_York (now -05:00) unless an offset is given>");
			expect(text).toContain("timezone?:<default America/New_York>");
			expect(text).toContain("e.g. 2026-10-19T15:04:00-05:00");
			expect(text).toContain("next fire time (America/New_York)");
			expect(text).not.toContain("Asia/Seoul");
		} finally {
			ledger.close();
		}
	});

	test("floors MONITOR line of a persona session", () => {
		const floors = buildFloorsPrompt("/home/x/.ompbot/secrets", persona, false, false, false, {
			timezone: { name: NY, offset: "-05:00" },
		});
		expect(floors).toContain("America/New_York 기준 ISO(-05:00)로 계산하고");
		expect(floors).toContain("compute `at` in America/New_York");
	});

	test("TASK worker prompt", () => {
		const prompt = buildTaskPrompt({
			mode: "new",
			taskId: "T-20261111-01",
			worktree: "/r-t",
			branch: "task/T-20261111-01",
			timezone: NY,
			now: T,
		});
		expect(prompt).toContain("`updated`(ISO8601, America/New_York -05:00)");
	});
});
