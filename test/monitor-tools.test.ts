import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openBotStore } from "../src/core/origin";
import { Daemon } from "../src/daemon/daemon";
import { readStatusFromDb, renderStatusText, summarizeMonitors } from "../src/daemon/status";
import { laneOriginKey } from "../src/lanes/status";
import { createLogger } from "../src/log";
import { type MonitorLedger, monitorOrigin, openMonitorLedger } from "../src/monitors/ledger";
import { buildMonitorTools } from "../src/monitors/tools";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { buildFloorsPrompt } from "../src/safety/prompt";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import { makeHome, type TestHome, WaitingTransport } from "./helpers/bot-home";

const ORIGIN = "slack/dm/D1";
/** 2026-10-19 06:00:00 UTC = 15:00 in Asia/Seoul. */
const NOW = Date.parse("2026-10-19T06:00:00Z");
const log = createLogger({ sink: () => undefined, clock: { now: () => NOW }, redact });

let home: TestHome;
let ledger: MonitorLedger;

beforeEach(() => {
	home = makeHome("ompbot-monitor-tools-");
	mkdirSync(join(home.dir, "scripts"));
	ledger = openMonitorLedger(join(home.dir, "ompbot.db"), { now: () => NOW });
});

afterEach(() => {
	ledger.close();
	home.remove();
});

function tools(originKey = ORIGIN) {
	const built = buildMonitorTools({ originKey, ledger, scriptsRoot: join(home.dir, "scripts"), log });
	const get = (name: string) => {
		const tool = built.find((candidate) => candidate.name === name);
		if (!tool) throw new Error(`tool missing: ${name}`);
		return (params: Record<string, unknown>) => tool.execute(params, { signal: new AbortController().signal });
	};
	return {
		built,
		add: get("ompbot_monitor_add"),
		list: get("ompbot_monitor_list"),
		remove: get("ompbot_monitor_remove"),
	};
}

function tools2(webhook: { port: number } | undefined) {
	const built = buildMonitorTools({
		originKey: ORIGIN,
		ledger,
		scriptsRoot: join(home.dir, "scripts"),
		workspaceDir: home.config.workspaceDir,
		webhook,
		log,
	});
	const get = (name: string) => {
		const tool = built.find((candidate) => candidate.name === name);
		if (!tool) throw new Error(`tool missing: ${name}`);
		return (params: Record<string, unknown>) => tool.execute(params, { signal: new AbortController().signal });
	};
	return { add: get("ompbot_monitor_add"), list: get("ompbot_monitor_list") };
}

const AT = { kind: "at", at: "2026-10-19T15:05:00+09:00" };

describe("ompbot_monitor_add / list / remove", () => {
	test("add stores the monitor and returns the id with the next fire in Asia/Seoul", async () => {
		const { add } = tools();
		const result = await add({ name: "reminder", trigger: AT, instruction: "알려줘" });
		const [row] = ledger.listMonitors();
		expect(row).toMatchObject({ name: "reminder", overlap: "queue", enabled: true });
		expect(row?.trigger).toEqual({ kind: "at", at: "2026-10-19T06:05:00.000Z" });
		expect(result).toContain(row?.id ?? "?");
		expect(result).toContain("2026-10-19 15:05:00 Asia/Seoul");
	});

	test("an at without an offset is Seoul wall-clock time; a JSON-text trigger is accepted", async () => {
		const { add } = tools();
		await add({ name: "local", trigger: JSON.stringify({ kind: "at", at: "2026-10-19T16:00:00" }), instruction: "x" });
		expect(ledger.getMonitor("local")?.trigger).toEqual({ kind: "at", at: "2026-10-19T07:00:00.000Z" });
	});

	test("validation errors are thrown and nothing is stored", async () => {
		const { add } = tools();
		const outside = join(home.dir, "outside.sh");
		writeFileSync(outside, "#!/bin/sh\n");
		chmodSync(outside, 0o755);
		const bad: Array<[Record<string, unknown>, RegExp]> = [
			[{ name: "a", trigger: { kind: "cron", schedule: "61 * * * *" }, instruction: "x" }, /trigger/],
			[{ name: "a", trigger: { kind: "nope" }, instruction: "x" }, /trigger\.kind/],
			[{ name: "a", trigger: AT, instruction: "x".repeat(4001) }, /4000/],
			[{ name: "a", trigger: AT, instruction: "" }, /instruction/],
			[{ name: "a", trigger: AT, instruction: "x", overlap: "maybe" }, /overlap/],
			[{ name: "a", trigger: "{not json", instruction: "x" }, /trigger must be an object/],
			[
				{ name: "a", trigger: { kind: "script", command: [outside], intervalMs: 60_000 }, instruction: "x" },
				/scripts/i,
			],
			[{ name: "a", trigger: { kind: "script", command: ["x.sh"], intervalMs: 1000 }, instruction: "x" }, /intervalMs/],
		];
		for (const [params, message] of bad) await expect(add(params)).rejects.toThrow(message);
		expect(ledger.listMonitors()).toEqual([]);
	});

	test("a script under <home>/scripts is accepted; a duplicate name is refused", async () => {
		const { add } = tools();
		const script = join(home.dir, "scripts", "check.sh");
		writeFileSync(script, "#!/bin/sh\nexit 0\n");
		chmodSync(script, 0o755);
		await add({ name: "watch", trigger: { kind: "script", command: [script], intervalMs: 60_000 }, instruction: "x" });
		expect(ledger.getMonitor("watch")?.trigger.kind).toBe("script");
		await expect(add({ name: "watch", trigger: AT, instruction: "x" })).rejects.toThrow(/already exists/);
		expect(ledger.listMonitors()).toHaveLength(1);
	});

	test("deliver: add stores verbatim for a script and list shows each monitor's deliver mode", async () => {
		const { add, list } = tools();
		const script = join(home.dir, "scripts", "relay.sh");
		writeFileSync(script, "#!/bin/sh\nexit 0\n");
		chmodSync(script, 0o755);
		await add({
			name: "relay",
			trigger: { kind: "script", command: [script], intervalMs: 60_000 },
			instruction: "x",
			deliver: "verbatim",
		});
		await add({ name: "one", trigger: AT, instruction: "x" });
		// Both rows share the fixed clock's created_at, so list order falls back to the random id.
		expect(
			ledger
				.listMonitors()
				.map((row) => [row.name, row.deliver])
				.sort(),
		).toEqual([
			["one", "turn"],
			["relay", "verbatim"],
		]);
		const lines = (await list({})).split("\n");
		expect(lines.find((line) => line.includes('"relay"'))).toContain(" deliver=verbatim ");
		expect(lines.find((line) => line.includes('"one"'))).toContain(" deliver=turn ");
		await expect(add({ name: "bad", trigger: AT, instruction: "x", deliver: "verbatim" })).rejects.toThrow(
			/script trigger/,
		);
	});

	test("list shows each monitor with its next fire; remove works by id or by name", async () => {
		const { add, list, remove } = tools();
		expect(await list({})).toBe("no monitors");
		await add({ name: "one", trigger: AT, instruction: "x" });
		await add({ name: "daily", trigger: { kind: "cron", schedule: "0 9 * * *" }, instruction: "y" });
		const script = join(home.dir, "scripts", "check.sh");
		writeFileSync(script, "#!/bin/sh\nexit 0\n");
		chmodSync(script, 0o755);
		await add({
			name: "watch",
			trigger: { kind: "script", command: [script], intervalMs: 60_000 },
			instruction: "x",
			channel: "C0123456789",
			model: "provider/model",
			thinking: "off",
		});
		const text = await list({});
		expect(text).toContain('"one"');
		// The tool renders an `at` trigger as Asia/Seoul wall clock, like its `next=`.
		expect(text).toContain('"one" [at 2026-10-19 15:05:00 Asia/Seoul]');
		// Shared rendering rule (monitors/ledger describeMonitorTrigger): a script trigger shows its last check state,
		// and pinned options join with the tool's single-space separator.
		expect(text).toContain(`[script ${script} every 60s fire=edge state=-]`);
		expect(text).toContain("channel=C0123456789 model=provider/model thinking=off");
		expect(text).toContain("next=2026-10-19 15:05:00 Asia/Seoul");
		expect(text).toContain("next=2026-10-20 09:00:00 Asia/Seoul");

		const id = ledger.getMonitor("one")?.id ?? "?";
		expect(await remove({ id })).toContain("removed");
		expect(await remove({ name: "daily" })).toContain("removed");
		expect(ledger.listMonitors()).toHaveLength(1);
		await expect(remove({ name: "daily" })).rejects.toThrow(/not found/);
		await expect(remove({})).rejects.toThrow(/required/);
	});
});

describe("who gets the tools", () => {
	test("monitor and lane origins (and non-DM origins) get none, so a monitor cannot register monitors", () => {
		expect(tools().built.map((tool) => tool.name)).toEqual([
			"ompbot_monitor_add",
			"ompbot_monitor_list",
			"ompbot_monitor_remove",
		]);
		for (const origin of [monitorOrigin("mabc12345"), laneOriginKey("work"), "slack/channel/C1"]) {
			expect(buildMonitorTools({ originKey: origin, ledger, scriptsRoot: home.dir, log })).toEqual([]);
		}
	});

	test("the daemon registers them for the owner DM only", async () => {
		const sessions = new FakeSessionStore();
		const daemon = new Daemon({
			config: home.config,
			channels: [new SlackBinding(new SlackChannel(new WaitingTransport()))],
			log,
			ompVersion: "omp-test 0",
			bootId: "boot",
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		await daemon.start();
		try {
			const names = (origin: string) => daemon.hostToolsFor(origin).map((tool) => tool.name);
			expect(names(ORIGIN)).toContain("ompbot_monitor_add");
			expect(names(monitorOrigin("mabc12345"))).not.toContain("ompbot_monitor_add");
			expect(names(laneOriginKey("work"))).not.toContain("ompbot_monitor_add");
		} finally {
			await daemon.stop();
		}
	});

	test("the system prompt mentions the monitor tools for persona sessions only", () => {
		expect(buildFloorsPrompt("/s", ORIGIN)).toContain("ompbot_monitor_add");
		expect(buildFloorsPrompt("/s", monitorOrigin("mabc12345"))).not.toContain("ompbot_monitor_add");
		expect(buildFloorsPrompt("/s")).not.toContain("ompbot_monitor_add");
	});
});

describe("status groups thread sessions", () => {
	test("thread origins collapse into one `<channel> × N스레드` line; DM and channel origins stay listed", () => {
		const dbPath = join(home.dir, "threads.db");
		const store = openBotStore(dbPath, { now: () => NOW });
		try {
			store.ensureOrigin("slack/dm/D1", "/s/dm");
			store.ensureOrigin("slack/ch/C1", "/s/ch");
			store.ensureOrigin("slack/ch/C1/t/100.1", "/s/t1");
			store.ensureOrigin("slack/ch/C1/t/200.2", "/s/t2");
		} finally {
			store.close();
		}
		const text = renderStatusText(readStatusFromDb(dbPath, "omp-test 0"));
		expect(text).toContain("origin 4개");
		expect(text).toContain("• slack/dm/D1 epoch=1");
		expect(text).toContain("• slack/ch/C1 epoch=1");
		expect(text).toContain("• slack/ch/C1 × 2스레드");
		// No per-thread line leaks into the human-readable list.
		expect(text).not.toContain("slack/ch/C1/t/");
	});
});

describe("status shows monitors", () => {
	test("summarizeMonitors counts every monitor and names the soonest enabled fire", async () => {
		const { add } = tools();
		expect(summarizeMonitors(ledger.listMonitors())).toEqual({ count: 0, next: null });
		await add({ name: "later", trigger: { kind: "at", at: "2026-10-19T18:00:00+09:00" }, instruction: "x" });
		await add({ name: "soon", trigger: AT, instruction: "x" });
		await add({
			name: "off",
			trigger: { kind: "at", at: "2026-10-19T15:01:00+09:00" },
			instruction: "x",
			enabled: false,
		});
		expect(summarizeMonitors(ledger.listMonitors())).toEqual({
			count: 3,
			next: { name: "soon", at: "2026-10-19T06:05:00.000Z" },
		});
	});

	test("the text and the read-only database report show count, name and Seoul time", async () => {
		const dbPath = join(home.dir, "full.db");
		const store = openBotStore(dbPath, { now: () => NOW });
		try {
			const built = buildMonitorTools({ originKey: ORIGIN, ledger: store.monitors, scriptsRoot: home.dir, log });
			await built[0]?.execute(
				{ name: "soon", trigger: AT, instruction: "x" },
				{ signal: new AbortController().signal },
			);
		} finally {
			store.close();
		}
		const report = readStatusFromDb(dbPath, "omp-test 0");
		expect(report.monitors).toEqual({ count: 1, next: { name: "soon", at: "2026-10-19T06:05:00.000Z" } });
		expect(renderStatusText(report)).toContain("모니터 1개 · 다음 발사 soon 2026-10-19 15:05:00 (Asia/Seoul)");
		expect(renderStatusText({ ...report, monitors: { count: 0, next: null } })).toContain("모니터 0개");
	});
});

describe("webhook trigger and procedureFiles through the tool", () => {
	test("add returns the URL and token once; list shows the path but never the token", async () => {
		const { add, list } = tools2({ port: 8123 });
		const result = String(await add({ name: "hook", trigger: { kind: "webhook" }, instruction: "x" }));
		const row = ledger.getMonitor("hook");
		if (row?.trigger.kind !== "webhook") throw new Error("not a webhook monitor");
		expect(result).toContain(`http://127.0.0.1:8123/hook/${row.trigger.id}`);
		expect(result).toContain(`Bearer ${row.trigger.token}`);
		const listed = String(await list({}));
		expect(listed).toContain(`/hook/${row.trigger.id}`);
		expect(listed).not.toContain(row.trigger.token);
	});

	test("a webhook trigger is refused without config.webhook", async () => {
		const { add } = tools2(undefined);
		await expect(add({ name: "hook", trigger: { kind: "webhook" }, instruction: "x" })).rejects.toThrow(/webhook/);
		expect(ledger.listMonitors()).toEqual([]);
	});

	test("procedureFiles are stored for a workspace file and refused outside the workspace", async () => {
		const { add } = tools2(undefined);
		const inside = join(home.config.workspaceDir, "proc.md");
		writeFileSync(inside, "steps");
		await add({ name: "proc", trigger: AT, instruction: "x", procedureFiles: [inside] });
		expect(ledger.getMonitor("proc")?.procedureFiles).toEqual([inside]);
		const outside = join(home.dir, "outside.md");
		writeFileSync(outside, "x");
		await expect(add({ name: "bad", trigger: AT, instruction: "x", procedureFiles: [outside] })).rejects.toThrow(
			/must live under/,
		);
	});
});
