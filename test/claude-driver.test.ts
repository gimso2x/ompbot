import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { turnAnswerParts } from "../src/omp/answers";
import { type ClaudeApprovalHook, ClaudeOmpDriver } from "../src/omp/claude-driver";
import { OmpDriverError, type OmpFinal } from "../src/omp/driver";

const tempDirs: string[] = [];
const FAKE_SCRIPT = join(import.meta.dir, "helpers", "fake-claude.ts");
const BUN = process.execPath;

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

interface LogEntry {
	dir: string;
	argv?: string[];
	frame?: Record<string, unknown>;
}

interface Harness {
	driver: ClaudeOmpDriver;
	root: string;
	home: string;
	executable: string;
	workspace: string;
	sessionDir: string;
	logFile: string;
	readLog(): LogEntry[];
}

interface HarnessOptions {
	auth?: boolean;
	model?: string;
	thinking?: string;
	approval?: ClaudeApprovalHook;
	env?: Record<string, string>;
}

function makeHarness(options: HarnessOptions = {}): Harness {
	const root = tempDir("ompbot-claude-");
	const workspace = join(root, "workspace");
	const sessionDir = join(root, "sessions", "e1");
	const home = join(root, "home");
	mkdirSync(join(home, ".claude"), { recursive: true });
	if (options.auth !== false) writeFileSync(join(home, ".claude", ".credentials.json"), "{}\n", { mode: 0o600 });
	const executable = join(root, "bin", "claude");
	mkdirSync(join(root, "bin"));
	writeFileSync(executable, `#!/bin/sh\nexec "${BUN}" "${FAKE_SCRIPT}" "$@"\n`);
	chmodSync(executable, 0o755);
	const logFile = join(root, "fake-claude.log");
	const driver = new ClaudeOmpDriver({
		claudeExecutable: executable,
		cwd: workspace,
		sessionDir,
		...(options.model === undefined ? {} : { model: options.model }),
		...(options.thinking === undefined ? {} : { thinking: options.thinking }),
		...(options.approval === undefined ? {} : { approval: options.approval }),
		env: { FAKE_CLAUDE_LOG: logFile, ...(options.env ?? {}) },
		baseEnv: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
		startupGraceMs: 2_000,
	});
	return {
		driver,
		root,
		home,
		executable,
		workspace,
		sessionDir,
		logFile,
		readLog: () =>
			readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as LogEntry),
	};
}

/** A second driver over the same root as `first` (same fake log, so `lastArgv` sees every spawn). */
function restartDriver(first: Harness): ClaudeOmpDriver {
	return new ClaudeOmpDriver({
		claudeExecutable: first.executable,
		cwd: first.workspace,
		sessionDir: first.sessionDir,
		env: { FAKE_CLAUDE_LOG: first.logFile },
		baseEnv: { HOME: first.home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
		startupGraceMs: 2_000,
	});
}

function nextFinal(driver: ClaudeOmpDriver): Promise<OmpFinal> {
	const { promise, resolve } = Promise.withResolvers<OmpFinal>();
	const off = driver.onFinal((final) => {
		off();
		resolve(final);
	});
	return promise;
}

function permissionResponses(log: LogEntry[]): Array<Record<string, unknown>> {
	return log
		.filter(
			(entry) =>
				entry.dir === "in" &&
				entry.frame?.type === "control_response" &&
				String((entry.frame.response as Record<string, unknown> | undefined)?.request_id ?? "").startsWith("perm-"),
		)
		.map((entry) => {
			const outer = (entry.frame as Record<string, unknown>).response as Record<string, unknown>;
			return (outer?.response ?? {}) as Record<string, unknown>;
		});
}

/** The first permission decision (allow/deny) the driver answered with; throws when it never answered. */
function permissionDecision(log: LogEntry[]): Record<string, unknown> {
	const decision = permissionResponses(log).at(0);
	if (decision === undefined || decision.behavior === undefined)
		throw new Error("no permission control_response in log");
	return decision;
}

/** argv of the fake CLI's latest spawn; throws when the child never even started. */
function lastArgv(harness: Harness): string[] {
	const argv = harness.readLog().findLast((entry) => entry.dir === "argv")?.argv;
	if (argv === undefined) throw new Error("fake claude logged no argv");
	return argv;
}

test("start fails fast with claude_executable_missing", async () => {
	const root = tempDir("ompbot-claude-missing-");
	const driver = new ClaudeOmpDriver({
		claudeExecutable: join(root, "no-such-claude"),
		cwd: root,
		sessionDir: join(root, "s"),
		baseEnv: { HOME: root, PATH: "/usr/bin:/bin" },
	});
	const error = await driver.start().catch((e: unknown) => e);
	expect(error).toBeInstanceOf(OmpDriverError);
	expect(error).toMatchObject({ code: "claude_executable_missing" });
	expect(driver.pid).toBeUndefined();
});

test("start fails with claude_not_authenticated without credentials", async () => {
	const harness = makeHarness({ auth: false });
	const error = await harness.driver.start().catch((e: unknown) => e);
	expect(error).toBeInstanceOf(OmpDriverError);
	expect(error).toMatchObject({ code: "claude_not_authenticated" });
	expect(harness.driver.pid).toBeUndefined();
});

test("fresh session: prompt, final, entries and answers", async () => {
	const harness = makeHarness();
	const driver = harness.driver;
	await driver.start();
	expect(typeof driver.pid).toBe("number");
	const opened = await driver.openSession();
	expect(opened.resumed).toBe(false);
	expect(opened.sessionId.length).toBeGreaterThan(0);

	expect(await driver.leafId()).toBe(null);
	expect((await driver.entriesSince()).entries).toEqual([]);

	const done = nextFinal(driver);
	const opRef = await driver.prompt("hello");
	const final = await done;
	expect(final).toMatchObject({ opRef, status: "completed", text: "FAKE-REPLY" });

	const all = await driver.entriesSince();
	expect(all.entries.map((e) => e.message?.role)).toEqual(["user", "assistant"]);
	expect(all.entries[1]?.message?.stopReason).toBe("stop");
	expect(turnAnswerParts(all.entries)).toEqual(["FAKE-REPLY"]);
	const leaf = await driver.leafId();
	expect(leaf).toBe(all.leafId);
	expect((await driver.entriesSince(leaf ?? undefined)).entries).toEqual([]);
	const rejection = await driver.entriesSince("nope").catch((e: unknown) => e);
	expect(rejection).toMatchObject({ code: "unknown_since" });

	const argv = harness.readLog().find((entry) => entry.dir === "argv")?.argv ?? [];
	expect(argv).toEqual([
		"-p",
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--verbose",
		"--replay-user-messages",
		"--setting-sources",
		"user",
	]);
	await driver.stop();
});

test("openSession resumes the pointer session; newSession starts fresh", async () => {
	const harness = makeHarness();
	await harness.driver.start();
	const opened = await harness.driver.openSession();
	await harness.driver.stop();

	const driver2 = restartDriver(harness);
	await driver2.start();
	const resumed = await driver2.openSession();
	expect(resumed.resumed).toBe(true);
	expect(resumed.sessionId).toBe(opened.sessionId);
	expect((await driver2.state()).sessionId).toBe(opened.sessionId);
	const resumedArgv = lastArgv(harness);
	expect(resumedArgv).toContain("--resume");
	expect(resumedArgv).toContain(opened.sessionId);

	await driver2.newSession();
	const fresh = await driver2.openSession();
	expect(fresh.resumed).toBe(false);
	expect(fresh.sessionId).not.toBe(opened.sessionId);
	expect(lastArgv(harness)).not.toContain("--resume");
	await driver2.stop();
});

test("a gone pointer session falls back to a fresh conversation", async () => {
	const harness = makeHarness({ env: { FAKE_CLAUDE_RESUME_MISSING: "1" } });
	const driver = harness.driver;
	await driver.start();
	const opened = await driver.openSession();
	expect(opened.resumed).toBe(false);
	expect(existsSync(join(harness.sessionDir, "claude-session.json"))).toBe(true); // re-pinned to the fresh session
	const done = nextFinal(driver);
	await driver.prompt("hello");
	expect((await done).text).toBe("FAKE-REPLY");
	await driver.stop();
});

test("setModel switches via set_model and validates", async () => {
	const harness = makeHarness();
	const driver = harness.driver;
	await driver.start();
	await driver.openSession();
	expect(await driver.setModel("claude/opus")).toBe("claude/opus");
	expect((await driver.state()).model).toBe("claude/opus");
	const control = harness
		.readLog()
		.filter((entry) => entry.dir === "in" && entry.frame?.type === "control_request")
		.map((entry) => entry.frame as Record<string, unknown>)
		.at(-1);
	expect(control?.request).toMatchObject({ subtype: "set_model", model: "opus" });
	const unknown = await driver.setModel("claude/nope").catch((e: unknown) => e);
	expect(unknown).toBeInstanceOf(OmpDriverError);
	const wrongProvider = await driver.setModel("gpt-5/x").catch((e: unknown) => e);
	expect(wrongProvider).toBeInstanceOf(OmpDriverError);
	await driver.stop();
});

test("spawn --model maps into state.model", async () => {
	const harness = makeHarness({ model: "haiku" });
	const driver = harness.driver;
	await driver.start();
	await driver.openSession();
	expect((await driver.state()).model).toBe("claude/haiku");
	await driver.stop();
});

test("setThinking maps off to tokens 0 and levels to effort flags", async () => {
	const harness = makeHarness({ thinking: "high" });
	const driver = harness.driver;
	await driver.start();
	await driver.openSession();
	expect((await driver.state()).thinking).toBe("high");
	const controls = () =>
		harness
			.readLog()
			.filter((entry) => entry.dir === "in" && entry.frame?.type === "control_request")
			.map((entry) => (entry.frame as Record<string, unknown>).request as Record<string, unknown>);
	expect(controls().at(-1)).toMatchObject({ subtype: "apply_flag_settings", settings: { effort: "high" } });
	await driver.setThinking("off");
	expect(controls().at(-1)).toMatchObject({ subtype: "set_max_thinking_tokens", max_thinking_tokens: 0 });
	await driver.setThinking("low");
	expect(controls().at(-1)).toMatchObject({ subtype: "apply_flag_settings", settings: { effort: "low" } });
	const rejected = await driver.setThinking("ultra").catch((e: unknown) => e);
	expect(rejected).toBeInstanceOf(OmpDriverError);
	await driver.stop();
});

test("dangerous bash is denied without an approval surface", async () => {
	const harness = makeHarness();
	const driver = harness.driver;
	await driver.start();
	await driver.openSession();
	const done = nextFinal(driver);
	await driver.prompt("@tool rm -rf /tmp/somewhere");
	const final = await done;
	expect(final.status).toBe("completed");
	expect(final.text).toBe("TOOL-DENIED");
	expect(permissionResponses(harness.readLog())).toHaveLength(1);
	expect(permissionDecision(harness.readLog())).toMatchObject({ behavior: "deny" });
	await driver.stop();
});

test("dangerous bash escalates to the approval hook", async () => {
	const seen: Array<{ toolName: string; command: string }> = [];
	const harness = makeHarness({
		approval: async (request) => {
			seen.push({ toolName: request.toolName, command: request.command });
			return "approved";
		},
	});
	const driver = harness.driver;
	await driver.start();
	await driver.openSession();
	const done = nextFinal(driver);
	await driver.prompt("@tool git push --force origin main");
	const final = await done;
	expect(final.text).toBe("TOOL-DONE");
	expect(seen).toEqual([{ toolName: "Bash", command: "git push --force origin main" }]);
	expect(permissionDecision(harness.readLog())).toMatchObject({ behavior: "allow" });
	await driver.stop();
});

test("a throwing approval hook still answers the CLI with a deny", async () => {
	const harness = makeHarness({
		approval: async () => {
			throw new Error("slack 429");
		},
	});
	const driver = harness.driver;
	await driver.start();
	await driver.openSession();
	const done = nextFinal(driver);
	await driver.prompt("@tool git push --force origin main");
	const final = await done;
	expect(final.text).toBe("TOOL-DENIED");
	expect(permissionResponses(harness.readLog())).toHaveLength(1);
	expect(permissionDecision(harness.readLog())).toMatchObject({ behavior: "deny" });
	await driver.stop();
});

test("safe bash runs without asking the owner", async () => {
	const harness = makeHarness();
	const driver = harness.driver;
	await driver.start();
	await driver.openSession();
	const done = nextFinal(driver);
	await driver.prompt("@tool echo safe");
	expect((await done).text).toBe("TOOL-DONE");
	// The CLI still asks; the driver answers allow itself — no approval hook exists in this harness.
	const answers = permissionResponses(harness.readLog());
	expect(answers).toHaveLength(1);
	expect(permissionDecision(harness.readLog())).toMatchObject({ behavior: "allow" });
	await driver.stop();
});

test("edits inside the workspace run, outside the workspace are denied", async () => {
	let asked = 0;
	const harness = makeHarness({
		approval: async () => {
			asked += 1;
			return "approved";
		},
	});
	const driver = harness.driver;
	await driver.start();
	await driver.openSession();
	const inside = nextFinal(driver);
	await driver.prompt("@edit inside.md");
	expect((await inside).text).toBe("EDIT-DONE");
	const outside = nextFinal(driver);
	await driver.prompt("@edit /etc/hostname");
	expect((await outside).text).toBe("EDIT-DENIED");
	expect(asked).toBe(0);
	await driver.stop();
});

test("steer lands mid-turn and the final answer includes it", async () => {
	const harness = makeHarness();
	const driver = harness.driver;
	await driver.start();
	await driver.openSession();
	const done = nextFinal(driver);
	await driver.prompt("@steer");
	await driver.steer("끼워넣어");
	const final = await done;
	expect(final.text).toBe("PART2:끼워넣어");
	const roles = (await driver.entriesSince()).entries.map((e) => `${e.message?.role}:${e.message?.stopReason ?? ""}`);
	expect(roles).toEqual(["user:", "assistant:", "user:", "assistant:stop"]);
	await driver.stop();
});

test("abort ends the turn as aborted", async () => {
	const harness = makeHarness();
	const driver = harness.driver;
	await driver.start();
	await driver.openSession();
	const done = nextFinal(driver);
	const opRef = await driver.prompt("@abort");
	await driver.abort();
	const final = await done;
	expect(final.opRef).toBe(opRef);
	expect(final.status).toBe("aborted");
	await driver.stop();
});

test("compact returns the summary and the compact call's input tokens", async () => {
	const harness = makeHarness();
	const driver = harness.driver;
	await driver.start();
	await driver.openSession();
	const result = await driver.compact("focus on the driver work");
	expect(result).toEqual({ tokensBefore: 4321, summary: "COMPACT-SUMMARY" });
	await driver.stop();
});

test("switchSession resumes by claude session id", async () => {
	const harness = makeHarness();
	const driver = harness.driver;
	await driver.start();
	const target = "12345678-abcd-abcd-abcd-1234567890ab.jsonl";
	await driver.switchSession(target);
	expect(lastArgv(harness)).toContain("12345678-abcd-abcd-abcd-1234567890ab");
	const rejected = await driver.switchSession("short").catch((e: unknown) => e);
	expect(rejected).toBeInstanceOf(OmpDriverError);
	await driver.stop();
});
