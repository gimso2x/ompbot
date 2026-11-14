import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Daemon } from "../src/daemon/daemon";
import { createLogger } from "../src/log";
import { openMonitorLedger } from "../src/monitors/ledger";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { clearFreeze, writeFreeze } from "../src/ops/freeze";
import { redact } from "../src/redact";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import { makeHome, type TestHome, WaitingTransport } from "./helpers/bot-home";
import { killSpawned, runCliCapture, runMain } from "./helpers/daemon-process";

const clock = { now: () => Date.now() };
let home: TestHome;

beforeEach(() => {
	home = makeHome("ompbot-monitors-cli-");
	mkdirSync(join(home.dir, "scripts"));
});

afterEach(() => {
	killSpawned();
	home.remove();
});

// In-process: the real `bun src/main.ts` start is covered once by the smoke test below.
const monitors = (...args: string[]) => runCliCapture(home.dir, ["monitors", ...args]);

// A bound, not a wait: a hung command still fails the test on a loaded host.
setDefaultTimeout(30_000);

function writeScript(name: string, body: string): string {
	const path = join(home.dir, "scripts", name);
	writeFileSync(path, body);
	chmodSync(path, 0o755);
	return path;
}

interface CliJson {
	monitor: { id: string; trigger: unknown };
	monitors: unknown[];
	schedules: Record<string, { effectiveTimezone: string; nextFireAt: string }>;
}

/** Shape of the CLI's JSON output; each test only reads the fields its command prints. */
const parse = (text: string) => JSON.parse(text) as CliJson;

describe("ompbot monitors (CLI)", () => {
	test("add / list / update / test / remove round trip", async () => {
		const added = await monitors(
			"add",
			"--json",
			JSON.stringify({
				name: "morning",
				trigger: { kind: "cron", schedule: "30 9 * * *" },
				instruction: "good morning",
			}),
		);
		expect(added.code).toBe(0);
		const { monitor } = parse(added.stdout);
		expect(monitor).toMatchObject({ name: "morning", overlap: "queue", enabled: true });
		expect(monitor.trigger).toEqual({ kind: "cron", schedule: "30 9 * * *", timezone: "Asia/Seoul" });

		const listed = parse((await monitors("list", "--json")).stdout);
		expect(listed.monitors).toHaveLength(1);
		const schedule = listed.schedules[monitor.id];
		expect(schedule?.effectiveTimezone).toBe("Asia/Seoul");
		const next = new Date(schedule?.nextFireAt ?? "");
		expect([next.getUTCHours(), next.getUTCMinutes()]).toEqual([0, 30]); // 09:30 KST
		expect(next.getTime()).toBeGreaterThan(Date.now());

		const text = await monitors("list");
		expect(text.stdout).toContain("morning");
		expect(text.stdout).toContain("Asia/Seoul");

		const updated = await monitors(
			"update",
			"morning",
			"--json",
			JSON.stringify({ trigger: { schedule: "0 8 * * *" }, overlap: "skip" }),
		);
		expect(updated.code).toBe(0);
		expect(parse(updated.stdout).monitor).toMatchObject({
			overlap: "skip",
			trigger: { kind: "cron", schedule: "0 8 * * *", timezone: "Asia/Seoul" },
		});

		const fired = await monitors("test", monitor.id);
		expect(fired.code).toBe(0);
		expect(parse(fired.stdout)).toMatchObject({ fired: true, stage: "admitted" });
		const ledger = openMonitorLedger(join(home.dir, "ompbot.db"));
		try {
			expect(ledger.listEvents().map((event) => [event.stage, event.manual])).toEqual([["admitted", true]]);
		} finally {
			ledger.close();
		}

		const removed = await monitors("remove", "morning");
		expect(removed.code).toBe(0);
		// By name, with a slot and an event attached (cascaded rows must not hide the deletion).
		expect(JSON.parse(removed.stdout)).toEqual({ removed: true, id: monitor.id });
		expect(parse((await monitors("list", "--json")).stdout).monitors).toEqual([]);
	});

	test("test while frozen still admits the manual event but says `frozen: true` (the daemon will skip it)", async () => {
		const added = await monitors(
			"add",
			"--json",
			JSON.stringify({ name: "frz", trigger: { kind: "cron", schedule: "30 9 * * *" }, instruction: "x" }),
		);
		expect(added.code).toBe(0);
		writeFreeze(home.dir, { reason: "점검", by: "cli", now: Date.now() });
		const fired = await monitors("test", "frz");
		expect(fired.code).toBe(0);
		expect(JSON.parse(fired.stdout)).toMatchObject({ fired: true, frozen: true });
		clearFreeze(home.dir);
		const thawed = JSON.parse((await monitors("test", "frz")).stdout);
		expect(thawed.fired).toBe(true);
		expect(thawed.frozen).toBeUndefined();
	});

	test("list renders at and script triggers by the shared ledger rules, with the CLI's own separators", async () => {
		const script = writeScript("watch.sh", "#!/bin/sh\nexit 0\n");
		const added = await monitors(
			"add",
			"--json",
			JSON.stringify({
				name: "wake",
				trigger: { kind: "at", at: "2026-10-19T15:05:00+09:00" },
				instruction: "i",
				copyChannel: "C0123456789",
			}),
		);
		expect(added.code).toBe(0);
		const scripted = await monitors(
			"add",
			"--json",
			JSON.stringify({
				name: "watch",
				trigger: { kind: "script", command: [script], intervalMs: 60_000, fire: "every" },
				instruction: "i",
			}),
		);
		expect(scripted.code).toBe(0);
		const text = (await monitors("list")).stdout;
		// The CLI keeps an `at` trigger's stored ISO string raw (the host tool renders Asia/Seoul wall clock instead).
		expect(text).toContain("wake  [at 2026-10-19T06:05:00.000Z]");
		// Shared trigger rule: fire=every carries no state= suffix.
		expect(text).toContain(`watch  [script ${script} every 60s fire=every]`);
		// Shared option suffixes joined with the CLI's two-space separator.
		expect(text).toContain("copyChannel=C0123456789  next=");
	});

	test("list shows the last check error with its time and streak; a healthy monitor shows none", async () => {
		const script = writeScript("broken.sh", "#!/bin/sh\nexit 0\n");
		const ids: string[] = [];
		for (const name of ["broken", "fine"]) {
			const added = await monitors(
				"add",
				"--json",
				JSON.stringify({ name, trigger: { kind: "script", command: [script], intervalMs: 60_000 }, instruction: "i" }),
			);
			expect(added.code).toBe(0);
			ids.push(parse(added.stdout).monitor.id);
		}
		const ledger = openMonitorLedger(join(home.dir, "ompbot.db"), { now: () => Date.UTC(2026, 10, 13, 6, 0, 0) });
		try {
			ledger.recordCheckError(ids[0] ?? "", "spawn failed: EACCES");
			ledger.recordCheckError(ids[0] ?? "", "spawn failed: EACCES");
		} finally {
			ledger.close();
		}
		const lines = (await monitors("list")).stdout.split("\n");
		expect(lines.find((line) => line.includes(" broken "))).toContain(
			"checkError(x2)=spawn failed: EACCES @ 2026-11-13 15:00:00 Asia/Seoul",
		);
		expect(lines.find((line) => line.includes(" fine "))).not.toContain("checkError");
	});

	test("remove by id reports removed:true, an unknown name fails", async () => {
		const added = await monitors(
			"add",
			"--json",
			JSON.stringify({ name: "gone", trigger: { kind: "cron", schedule: "30 9 * * *" }, instruction: "i" }),
		);
		const { monitor } = parse(added.stdout);
		const removed = await monitors("remove", monitor.id);
		expect(JSON.parse(removed.stdout)).toEqual({ removed: true, id: monitor.id });
		expect((await monitors("remove", "gone")).code).toBe(1);
	});

	test("bad specs are rejected with a message and exit 1", async () => {
		const badCron = await monitors(
			"add",
			"--json",
			JSON.stringify({ name: "x", trigger: { kind: "cron", schedule: "99 * * * *" }, instruction: "i" }),
		);
		expect(badCron.code).toBe(1);
		expect(badCron.stderr).toContain("monitors add:");
		const noJson = await monitors("add");
		expect(noJson.code).toBe(1);
		const unknown = await monitors("update", "nope", "--json", "{}");
		expect(unknown.code).toBe(1);
		expect(unknown.stderr).toContain("monitor not found");
		// Smoke: a real `bun src/main.ts` process (exit code through process.exit).
		const spawned = await runMain(home.dir, ["monitors", "bogus"]);
		expect(spawned.code).toBe(2);
		expect(spawned.stderr).toContain("monitors");
	});

	test("script intervalMs above 366 days is refused without a row; 366 days exactly is accepted", async () => {
		const script = writeScript("rare.sh", "#!/bin/sh\nexit 0\n");
		const add = (intervalMs: number) =>
			monitors(
				"add",
				"--json",
				JSON.stringify({ name: "rare", trigger: { kind: "script", command: [script], intervalMs }, instruction: "i" }),
			);
		for (const intervalMs of [31_622_400_001, 9e15]) {
			const refused = await add(intervalMs);
			expect(refused.code).toBe(1);
			expect(refused.stderr).toContain("between 60000 and 31622400000");
			expect((await monitors("list")).stdout).toBe("no monitors\n");
		}
		const accepted = await add(31_622_400_000);
		expect(accepted.code).toBe(0);
		expect(parse(accepted.stdout).monitor.trigger).toMatchObject({ intervalMs: 31_622_400_000 });
	});

	test("a stored row whose script interval is past the Date range: list, list --json and show still exit 0 with no next time", async () => {
		const script = writeScript("old.sh", "#!/bin/sh\nexit 0\n");
		const added = await monitors(
			"add",
			"--json",
			JSON.stringify({
				name: "old",
				trigger: { kind: "script", command: [script], intervalMs: 60_000 },
				instruction: "i",
			}),
		);
		expect(added.code).toBe(0);
		const { monitor } = parse(added.stdout);
		// What a row written before the upper bound may hold.
		const db = new Database(join(home.dir, "ompbot.db"));
		try {
			db.run("UPDATE monitors SET trigger_json = ? WHERE id = ?", [
				JSON.stringify({ kind: "script", command: [script], intervalMs: 9e15 }),
				monitor.id,
			]);
		} finally {
			db.close();
		}

		const text = await monitors("list");
		expect(text.code).toBe(0);
		expect(text.stdout).toContain("next=-");
		const listed = await monitors("list", "--json");
		expect(listed.code).toBe(0);
		expect(parse(listed.stdout).schedules[monitor.id]?.nextFireAt).toBeNull();
		const shown = await monitors("show", "old");
		expect(shown.code).toBe(0);
		expect(JSON.parse(shown.stdout).schedule.nextFireAt).toBeNull();
	});

	test("deliver: verbatim on a script monitor shows in list and --json; bad values and non-script triggers exit 1", async () => {
		const script = writeScript("relay.sh", "#!/bin/sh\nexit 0\n");
		const scriptTrigger = { kind: "script", command: [script], intervalMs: 60_000 };
		const add = (spec: Record<string, unknown>) => monitors("add", "--json", JSON.stringify(spec));
		const relay = await add({ name: "relay", trigger: scriptTrigger, instruction: "i", deliver: "verbatim" });
		expect(relay.code).toBe(0);
		expect(parse(relay.stdout).monitor).toMatchObject({ name: "relay", deliver: "verbatim" });
		expect(
			(await add({ name: "plain", trigger: { kind: "cron", schedule: "30 9 * * *" }, instruction: "i" })).code,
		).toBe(0);

		const listed = parse((await monitors("list", "--json")).stdout).monitors as Array<{
			name: string;
			deliver: string;
		}>;
		expect(listed.map((row) => [row.name, row.deliver])).toEqual([
			["relay", "verbatim"],
			["plain", "turn"],
		]);
		const lines = (await monitors("list")).stdout.trim().split("\n");
		expect(lines.find((line) => line.includes("relay"))).toContain("  deliver=verbatim  ");
		expect(lines.find((line) => line.includes("plain"))).not.toContain("deliver=");

		const badValue = await add({ name: "bad", trigger: scriptTrigger, instruction: "i", deliver: "copy" });
		expect([badValue.code, badValue.stderr]).toEqual([1, 'monitors add: deliver must be "turn" or "verbatim"\n']);
		const notScript = await add({
			name: "bad",
			trigger: { kind: "cron", schedule: "30 9 * * *" },
			instruction: "i",
			deliver: "verbatim",
		});
		expect([notScript.code, notScript.stderr]).toEqual([
			1,
			'monitors add: deliver "verbatim" needs a script trigger or a cron trigger with a command\n',
		]);
		const toCron = await monitors(
			"update",
			"relay",
			"--json",
			JSON.stringify({ trigger: { kind: "cron", schedule: "0 8 * * *" } }),
		);
		expect([toCron.code, toCron.stderr]).toEqual([
			1,
			'monitors update: deliver "verbatim" needs a script trigger or a cron trigger with a command\n',
		]);
		const plainToVerbatim = await monitors("update", "plain", "--json", JSON.stringify({ deliver: "verbatim" }));
		expect(plainToVerbatim.code).toBe(1);

		// An unrelated update keeps verbatim; switching back to turn is allowed.
		const renamed = await monitors("update", "relay", "--json", JSON.stringify({ overlap: "skip" }));
		expect(parse(renamed.stdout).monitor).toMatchObject({ overlap: "skip", deliver: "verbatim" });
		const back = await monitors("update", "relay", "--json", JSON.stringify({ deliver: "turn" }));
		expect(parse(back.stdout).monitor).toMatchObject({ deliver: "turn" });
	});

	test("cron command: refusals exit 1, list and --json show it, an update keeps it and command null turns it back", async () => {
		const script = writeScript("brief.sh", "#!/bin/sh\necho brief\n");
		const cron = { kind: "cron", schedule: "0 8 * * *", timezone: "Asia/Seoul", command: [script], timeoutMs: 900_000 };
		const add = (spec: Record<string, unknown>) => monitors("add", "--json", JSON.stringify(spec));
		const noVerbatim = await add({ name: "brief", trigger: cron, instruction: "i" });
		expect([noVerbatim.code, noVerbatim.stderr]).toEqual([
			1,
			'monitors add: a cron trigger with a command needs deliver "verbatim"\n',
		]);
		const badTimeout = await add({
			name: "brief",
			trigger: { ...cron, timeoutMs: 1_800_001 },
			instruction: "i",
			deliver: "verbatim",
		});
		expect(badTimeout.code).toBe(1);
		expect((await add({ name: "brief", trigger: cron, instruction: "i", deliver: "verbatim" })).code).toBe(0);

		const listed = parse((await monitors("list", "--json")).stdout).monitors as Array<{ trigger: unknown }>;
		expect(listed.map((row) => row.trigger)).toEqual([cron]);
		const line = (await monitors("list")).stdout.trim();
		expect(line).toContain(`[cron "0 8 * * *" Asia/Seoul command=${script} timeout=900s]`);
		expect(line).toContain("  deliver=verbatim  ");

		const moved = await monitors("update", "brief", "--json", JSON.stringify({ trigger: { schedule: "30 7 * * *" } }));
		expect(parse(moved.stdout).monitor).toMatchObject({
			trigger: { ...cron, schedule: "30 7 * * *" },
			deliver: "verbatim",
		});
		const half = await monitors("update", "brief", "--json", JSON.stringify({ trigger: { command: null } }));
		expect(half.code).toBe(1);
		const back = await monitors(
			"update",
			"brief",
			"--json",
			JSON.stringify({ trigger: { command: null }, deliver: "turn" }),
		);
		expect(back.code).toBe(0);
		expect(parse(back.stdout).monitor).toMatchObject({
			trigger: { kind: "cron", schedule: "30 7 * * *", timezone: "Asia/Seoul" },
			deliver: "turn",
		});
		expect(parse(back.stdout).monitor.trigger).not.toHaveProperty("command");
	});

	test("a script monitor must live under <home>/scripts", async () => {
		const outside = join(home.dir, "outside.sh");
		writeFileSync(outside, "#!/bin/sh\nexit 0\n");
		chmodSync(outside, 0o755);
		const result = await monitors(
			"add",
			"--json",
			JSON.stringify({
				name: "s",
				trigger: { kind: "script", command: [outside], intervalMs: 60_000 },
				instruction: "i",
			}),
		);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("must live under");
	});

	test("test on a script monitor runs the check first; only exit 0 fires with stdout as payload", async () => {
		const yes = writeScript("yes.sh", "#!/bin/sh\necho 'cpu hot'\nexit 0\n");
		const no = writeScript("no.sh", "#!/bin/sh\necho 'sensor gone' >&2\nexit 1\n");
		for (const [name, script] of [
			["yes", yes],
			["no", no],
		] as const) {
			const added = await monitors(
				"add",
				"--json",
				JSON.stringify({ name, trigger: { kind: "script", command: [script], intervalMs: 60_000 }, instruction: "i" }),
			);
			expect(added.code).toBe(0);
		}
		const fired = await monitors("test", "yes");
		expect(fired.code).toBe(0);
		const skipped = await monitors("test", "no");
		expect(skipped.code).toBe(1);
		expect(parse(skipped.stdout)).toMatchObject({ fired: false, exitCode: 1, stderr: "sensor gone" });
		const ledger = openMonitorLedger(join(home.dir, "ompbot.db"));
		try {
			const events = ledger.listEvents();
			expect(events).toHaveLength(1);
			expect(events[0]?.payload).toBe("cpu hot");
		} finally {
			ledger.close();
		}
	});

	test("test on a script monitor runs with config.workspaceDir as cwd, like the sweep", async () => {
		// The sweep passes cwd = config.workspaceDir (monitors/scheduler.ts); a relative-path script must pass here too.
		writeFileSync(join(home.dir, "workspace", "marker.txt"), "x");
		const script = writeScript("cwd.sh", "#!/bin/sh\ntest -f marker.txt || { echo 'no marker' >&2; exit 1; }\n");
		const added = await monitors(
			"add",
			"--json",
			JSON.stringify({
				name: "cwd",
				trigger: { kind: "script", command: [script], intervalMs: 60_000 },
				instruction: "i",
			}),
		);
		expect(added.code).toBe(0);
		const fired = await monitors("test", "cwd");
		expect(fired.code).toBe(0);
		expect(parse(fired.stdout)).toMatchObject({ fired: true, stage: "admitted" });
	});

	test("without a config.json the test falls back to the home as cwd", async () => {
		writeFileSync(join(home.dir, "marker.txt"), "x"); // in the home, not the workspace
		const script = writeScript("home-cwd.sh", "#!/bin/sh\ntest -f marker.txt || { echo 'no marker' >&2; exit 1; }\n");
		const added = await monitors(
			"add",
			"--json",
			JSON.stringify({
				name: "home-cwd",
				trigger: { kind: "script", command: [script], intervalMs: 60_000 },
				instruction: "i",
			}),
		);
		expect(added.code).toBe(0);
		unlinkSync(join(home.dir, "config.json"));
		const fired = await monitors("test", "home-cwd");
		expect(fired.code).toBe(0);
		expect(parse(fired.stdout)).toMatchObject({ fired: true, stage: "admitted" });
	});

	test("webhook: refused without config.webhook; with it add + show print the URL and the token", async () => {
		const spec = JSON.stringify({ name: "hook", trigger: { kind: "webhook" }, instruction: "i" });
		const refused = await monitors("add", "--json", spec);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain("webhook");

		const raw = JSON.parse(readFileSync(home.config.configPath, "utf8")) as Record<string, unknown>;
		writeFileSync(home.config.configPath, JSON.stringify({ ...raw, webhook: { port: 8123 } }), { mode: 0o600 });
		const added = await monitors("add", "--json", spec);
		expect(added.code).toBe(0);
		const trigger = parse(added.stdout).monitor.trigger as { id: string; token: string };
		const shown = JSON.parse((await monitors("show", "hook")).stdout) as {
			webhook: { url: string; token: string };
		};
		expect(shown.webhook).toEqual({ url: `http://127.0.0.1:8123/hook/${trigger.id}`, token: trigger.token });
		// A plain `list` line names the hook path but not the secret.
		const listed = await monitors("list");
		expect(listed.stdout).toContain(`/hook/${trigger.id}`);
		expect(listed.stdout).not.toContain(trigger.token);
		const listJson = await monitors("list", "--json");
		expect(listJson.stdout).not.toContain(trigger.token);
		expect(listJson.stdout).toContain(trigger.id);
		const updated = await monitors("update", "hook", "--json", JSON.stringify({ instruction: "j" }));
		expect(updated.stdout).not.toContain(trigger.token);
		const after = JSON.parse((await monitors("show", "hook")).stdout) as { webhook: { token: string } };
		expect(after.webhook.token).toBe(trigger.token);
		expect((await monitors("show", "missing")).code).toBe(1);
	});

	test("procedureFiles: add / update / clear, and a file outside the workspace is refused", async () => {
		writeFileSync(join(home.dir, "workspace", "proc.md"), "steps");
		writeFileSync(join(home.dir, "outside.md"), "x");
		const base = { name: "proc", trigger: { kind: "cron", schedule: "0 9 * * *" }, instruction: "i" };
		const outside = await monitors(
			"add",
			"--json",
			JSON.stringify({ ...base, procedureFiles: [join(home.dir, "outside.md")] }),
		);
		expect(outside.code).toBe(1);
		const file = join(home.dir, "workspace", "proc.md");
		const added = await monitors("add", "--json", JSON.stringify({ ...base, procedureFiles: [file] }));
		expect(added.code).toBe(0);
		expect((parse(added.stdout).monitor as unknown as { procedureFiles: string[] }).procedureFiles).toEqual([file]);
		const renamed = await monitors("update", "proc", "--json", JSON.stringify({ instruction: "j" }));
		expect((parse(renamed.stdout).monitor as unknown as { procedureFiles: string[] }).procedureFiles).toEqual([file]);
		const cleared = await monitors("update", "proc", "--json", JSON.stringify({ procedureFiles: null }));
		expect((parse(cleared.stdout).monitor as unknown as { procedureFiles: string[] }).procedureFiles).toEqual([]);
	});
});

describe("daemon with monitors", () => {
	test("an at monitor that is due posts exactly one top-level ⏰ message", async () => {
		const transport = new WaitingTransport();
		const sessions = new FakeSessionStore();
		const daemon = new Daemon({
			config: home.config,
			channels: [new SlackBinding(new SlackChannel(transport))],
			log: createLogger({ sink: () => undefined, clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			driverFactory: (_origin, sessionDir) =>
				new FakeOmpDriver({ sessionDir, store: sessions, respond: () => "시험 알림 nonce-42" }),
		});
		try {
			await daemon.start();
			const monitor = daemon.store.monitors.addMonitor({
				name: "wake",
				trigger: { kind: "at", at: new Date(Date.now() - 1_000).toISOString() },
				instruction: "알려줘",
				overlap: "queue",
				enabled: true,
			});
			await daemon.sweep();
			await transport.waitForPosts((text) => text.startsWith("⏰ "));
			await daemon.pump();
			await daemon.sweep();
			await daemon.pump();

			const posts = transport.posts((text) => text.startsWith("⏰ "));
			expect(posts).toHaveLength(1);
			expect(posts[0]?.text).toBe("⏰ wake\n시험 알림 nonce-42");
			expect(posts[0]?.threadTs).toBeUndefined();
			expect(posts[0]?.channel).toBe(home.config.ownerSlackUserId);
			expect(daemon.store.monitors.listEvents().map((event) => event.stage)).toEqual(["delivered"]);
			expect(daemon.store.monitors.getMonitor(monitor.id)?.enabled).toBe(false);
			// No reactions or status messages were stamped for the monitor turn.
			expect(transport.calls.filter((call) => call.method === "addReaction")).toHaveLength(0);
		} finally {
			await daemon.stop();
		}
	});
});
