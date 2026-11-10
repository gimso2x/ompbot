import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli/index";
import { Daemon } from "../src/daemon/daemon";
import { auditContext, createDispatchAudit, describeCall, installProcessAudit } from "../src/dispatch/audit";
import { realProcessRunner } from "../src/dispatch/omp";
import { buildDispatchTool } from "../src/dispatch/tool";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { clearFreeze, createFreezeProbe, freezePath, readFreeze, writeFreeze } from "../src/ops/freeze";
import { collectGates } from "../src/ops/gates";
import { redact } from "../src/redact";
import { SKILL_REVIEW_ORIGIN } from "../src/review/skills";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import { makeHome, type TestHome, WaitingTransport } from "./helpers/bot-home";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-freeze-"));
});

afterEach(() => {
	installProcessAudit(undefined);
	rmSync(dir, { recursive: true, force: true });
});

const warns = (): { lines: string[]; log: { warn(event: string, fields?: Record<string, unknown>): void } } => {
	const lines: string[] = [];
	return { lines, log: { warn: (event) => void lines.push(event) } };
};

describe("FROZEN file", () => {
	test("write → read → clear; a repeated freeze keeps the original since and replaces the reason", () => {
		expect(readFreeze(dir)).toBeUndefined();
		const first = writeFreeze(dir, { reason: "  키 유출\n의심 ", by: "cli", now: Date.parse("2026-10-30T01:00:00Z") });
		expect(first).toEqual({ since: "2026-10-30T01:00:00.000Z", reason: "키 유출 의심", by: "cli" });
		expect(statSync(freezePath(dir)).mode & 0o777).toBe(0o600);
		const again = writeFreeze(dir, { reason: "조사 중", by: "cli", now: Date.parse("2026-10-30T09:00:00Z") });
		expect(again.since).toBe(first.since);
		expect(readFreeze(dir)?.reason).toBe("조사 중");
		expect(clearFreeze(dir)).toBe(true);
		expect(readFreeze(dir)).toBeUndefined();
		expect(clearFreeze(dir)).toBe(false);
	});

	test("an unparseable FROZEN still means frozen (fail closed)", () => {
		writeFileSync(freezePath(dir), "{not json");
		expect(readFreeze(dir)).toBeDefined();
	});

	test("the probe re-reads after its cache window, so a freeze or unfreeze lands within seconds", () => {
		let now = 1_000;
		const probe = createFreezeProbe(dir, () => now, 2_000);
		expect(probe()).toBeUndefined();
		writeFreeze(dir, { by: "cli", now });
		expect(probe()).toBeUndefined();
		now += 2_000;
		expect(probe()).toBeDefined();
		clearFreeze(dir);
		now += 2_000;
		expect(probe()).toBeUndefined();
	});
});

describe("dispatch audit", () => {
	test("describeCall names the ssh target and the remote command, local calls are `local`", () => {
		const ssh = describeCall([
			"ssh",
			"-o",
			"BatchMode=yes",
			"-o",
			"ConnectTimeout=8",
			"me@box",
			"--",
			"'herdr'",
			"'agent'",
			"'list'",
		]);
		expect(ssh).toEqual({ host: "me@box", argv0: "ssh", text: "'herdr' 'agent' 'list'" });
		expect(describeCall(["herdr", "agent", "list"])).toEqual({
			host: "local",
			argv0: "herdr",
			text: "herdr agent list",
		});
	});

	test("describeCall reads the target after `--` (ssh <opts> -- <host> <cmd>, the offsite form)", () => {
		expect(describeCall(["ssh", "-o", "BatchMode=yes", "--", "host2", "ls"])).toEqual({
			host: "host2",
			argv0: "ssh",
			text: "ls",
		});
	});

	test("a line carries host, masked capped command, short hash, rc and ms; origin comes from the context", () => {
		const lines: string[] = [];
		const audit = createDispatchAudit({
			homeDir: dir,
			log: warns().log,
			now: () => Date.parse("2026-10-30T01:02:03Z"),
			sink: (line) => lines.push(line),
		});
		// Assembled at runtime so secret scanners (gitleaks) do not flag the fixture; the value is unchanged.
		const token = ["xoxb", "1234567890", "abcdefghijklmnop"].join("-");
		auditContext.run({ origin: "slack/dm/D1" }, () =>
			audit.record(
				["ssh", "-o", "BatchMode=yes", "wsl", "--", "echo", token, "x".repeat(1_000)],
				{ code: 7, timedOut: false },
				42,
			),
		);
		audit.record(["herdr", "agent", "list"], { code: null, timedOut: true }, 5);
		const first = JSON.parse(lines[0] as string);
		expect(first).toMatchObject({
			ts: "2026-10-30T01:02:03.000Z",
			host: "wsl",
			argv0: "ssh",
			rc: 7,
			ms: 42,
			origin: "slack/dm/D1",
		});
		expect(first.cmd).not.toContain(token);
		expect(first.cmd.length).toBeLessThanOrEqual(301);
		expect(first.cmdSha256).toMatch(/^[0-9a-f]{16}$/);
		const second = JSON.parse(lines[1] as string);
		expect(second).toMatchObject({ host: "local", argv0: "herdr", rc: null, timedOut: true });
		expect(second.origin).toBeUndefined();
	});

	test("writes 0600 JSONL under <home>/logs through the real process runner", async () => {
		installProcessAudit(createDispatchAudit({ homeDir: dir, log: warns().log }));
		const result = await realProcessRunner(["sh", "-c", "exit 3"], {});
		expect(result.code).toBe(3);
		const file = join(dir, "logs", "dispatch-audit.jsonl");
		expect(statSync(file).mode & 0o777).toBe(0o600);
		const entry = JSON.parse(readFileSync(file, "utf8").trim());
		expect(entry).toMatchObject({ host: "local", argv0: "sh", rc: 3 });
	});

	test("a write failure warns once and never blocks the call", async () => {
		writeFileSync(join(dir, "logs"), "a file where the directory should be");
		const { lines, log } = warns();
		installProcessAudit(createDispatchAudit({ homeDir: dir, log }));
		for (let n = 0; n < 3; n++) {
			expect((await realProcessRunner(["sh", "-c", "echo ok"], {})).stdout.trim()).toBe("ok");
		}
		expect(lines).toEqual(["dispatch_audit_write_failed"]);
	});
});

describe("ompbot_dispatch under freeze", () => {
	const noop = { info() {}, warn() {} };
	function tool(frozen: () => ReturnType<typeof readFreeze>) {
		const calls: string[][] = [];
		const built = buildDispatchTool({
			originKey: "slack/dm/D1",
			ompExecutable: "omp",
			homeDir: dir,
			workspaceDir: dir,
			dispatchHosts: { wsl: { ssh: "wsl-ssh" } },
			herdr: {},
			frozen,
			run: async (cmd) => {
				calls.push(cmd);
				return { code: 0, stdout: "done", timedOut: false };
			},
			log: noop,
		});
		return { built, calls };
	}

	test("frozen: every mode is refused with a 동결 error and nothing runs; unfrozen runs again", async () => {
		const state = { value: readFreeze(dir) };
		const { built, calls } = tool(() => state.value);
		state.value = { since: "2026-10-30T01:00:00.000Z", reason: "점검", by: "cli" };
		const signal = new AbortController().signal;
		for (const params of [{ task: "빌드" }, { mode: "herdr", name: "a", task: "x" }, { host: "wsl", name: "a" }]) {
			await expect(built.execute(params, { signal })).rejects.toThrow(/동결/);
		}
		expect(calls).toEqual([]);
		state.value = undefined;
		expect(await built.execute({ task: "빌드" }, { signal })).toBe("done");
		expect(calls).toHaveLength(1);
	});
});

describe("gate and CLI", () => {
	test("the frozen gate is open exactly while FROZEN exists, with the reason in the detail", () => {
		const gate = () => collectGates({ homeDir: dir, now: Date.now() }).find((g) => g.name === "frozen");
		expect(gate()).toMatchObject({ state: "closed", detail: "off" });
		writeFreeze(dir, { reason: "key leak", by: "cli", now: Date.now() });
		expect(gate()?.state).toBe("open");
		expect(gate()?.detail).toContain("reason=key_leak");
		clearFreeze(dir);
		expect(gate()?.state).toBe("closed");
	});

	test("ompbot freeze / gates --json / unfreeze round trip", async () => {
		const out: string[] = [];
		const write = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string) => {
			out.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		try {
			const env = { OMPBOT_HOME: dir };
			expect(await runCli(["freeze", "--reason", "test"], env)).toBe(0);
			expect(readFreeze(dir)?.reason).toBe("test");
			expect(await runCli(["gates", "--json"], env)).toBe(1);
			const gates = JSON.parse(out.at(-1) as string).gates as Array<{ name: string; state: string }>;
			expect(gates.find((g) => g.name === "frozen")?.state).toBe("open");
			expect(await runCli(["unfreeze"], env)).toBe(0);
			expect(existsSync(freezePath(dir))).toBe(false);
			expect(out.at(-1)).toBe("unfrozen\n");
		} finally {
			process.stdout.write = write;
		}
	});
});

describe("daemon under freeze", () => {
	let home: TestHome;
	let daemon: Daemon | undefined;
	beforeEach(() => {
		home = makeHome("ompbot-freeze-daemon-");
	});
	afterEach(async () => {
		await daemon?.stop();
		home.remove();
	});

	test("owner conversation turns still get answered and status reports FROZEN", async () => {
		writeFreeze(home.dir, { reason: "test", by: "cli", now: Date.now() });
		const sessions = new FakeSessionStore();
		const transport = new WaitingTransport();
		daemon = new Daemon({
			config: home.config,
			channels: [new SlackBinding(new SlackChannel(transport))],
			log: createLogger({ sink: () => undefined, clock: { now: () => Date.now() }, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		await daemon.start();
		await daemon.inject({ origin: "slack/dm/D1", asOwner: true, text: "안녕" });
		await transport.waitForPosts((posted) => posted.includes("ECHO 안녕"));
		expect(daemon.status().frozen?.reason).toBe("test");
	});

	/**
	 * A daemon with skillReviewTurns=1 whose owner DM already has one answered turn when the first sweep runs (the
	 * baseline), then one more answered turn and a second sweep. Returns the driver origins and log lines.
	 */
	async function reviewAfterOneTurn(): Promise<{ origins: string[]; lines: string[] }> {
		const sessions = new FakeSessionStore();
		const transport = new WaitingTransport();
		const lines: string[] = [];
		const origins: string[] = [];
		const clock = { now: () => Date.now() };
		daemon = new Daemon({
			config: { ...home.config, skillReviewTurns: 1 },
			channels: [new SlackBinding(new SlackChannel(transport))],
			clock,
			log: createLogger({ sink: (line) => void lines.push(line), clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			sweepMs: 3_600_000,
			gateSweepMs: 0,
			taskSweepMs: 0,
			driverFactory: (origin, sessionDir) => {
				origins.push(origin);
				return new FakeOmpDriver({ sessionDir, store: sessions });
			},
		});
		await daemon.start();
		const answer = async (text: string) => {
			await daemon?.inject({ origin: "slack/dm/D1", asOwner: true, text });
			await transport.waitForPosts((posted) => posted.includes(`ECHO ${text}`));
		};
		await answer("하나");
		await daemon.sweep(); // first look at the DM: records answered=1 as the baseline, no review yet
		expect(origins).not.toContain(SKILL_REVIEW_ORIGIN);
		await answer("둘");
		await daemon.sweep(); // one more answered turn since the baseline: a review is due
		return { origins, lines };
	}

	test("unfrozen: after the baseline sweep, skillReviewTurns more answered DM turns start a skill review", async () => {
		const { origins } = await reviewAfterOneTurn();
		expect(origins).toContain(SKILL_REVIEW_ORIGIN);
	});

	test("a due skill review does not start an omp turn while frozen (skill_review_skipped_frozen)", async () => {
		writeFreeze(home.dir, { reason: "test", by: "cli", now: Date.now() });
		const { origins, lines } = await reviewAfterOneTurn();
		expect(origins).not.toContain(SKILL_REVIEW_ORIGIN);
		expect(lines.filter((line) => line.includes("event=skill_review_skipped_frozen"))).toHaveLength(1);
		expect(daemon?.drainCounts().turns).toBe(0);
	});
});
