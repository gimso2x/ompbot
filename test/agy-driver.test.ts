import { afterAll, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgyOmpDriver, parseAgyModels } from "../src/omp/agy-driver";
import { turnAnswerParts } from "../src/omp/answers";
import { OmpDriverError, type OmpEvent, type OmpExitInfo, type OmpFinal } from "../src/omp/driver";

const tempDirs: string[] = [];
const FAKE_SCRIPT = join(import.meta.dir, "helpers", "fake-agy.ts");
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
	frame?: { event?: string; message?: { content?: string } };
}

interface Harness {
	root: string;
	executable: string;
	workspace: string;
	sessionDir: string;
	logFile: string;
	make(options?: {
		model?: string;
		thinking?: string;
		systemPrompt?: string;
		env?: Record<string, string>;
	}): AgyOmpDriver;
	readLog(): LogEntry[];
}

function makeHarness(): Harness {
	const root = tempDir("ompbot-agy-");
	const workspace = join(root, "workspace");
	const sessionDir = join(root, "sessions", "e1");
	const executable = join(root, "bin", "agy");
	mkdirSync(join(root, "bin"));
	writeFileSync(executable, `#!/bin/sh\nexec "${BUN}" "${FAKE_SCRIPT}" "$@"\n`);
	chmodSync(executable, 0o755);
	const logFile = join(root, "fake-agy.log");
	return {
		root,
		executable,
		workspace,
		sessionDir,
		logFile,
		make: (options = {}) =>
			new AgyOmpDriver({
				agyExecutable: executable,
				cwd: workspace,
				sessionDir,
				...(options.model === undefined ? {} : { model: options.model }),
				...(options.thinking === undefined ? {} : { thinking: options.thinking }),
				...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
				env: { FAKE_AGY_LOG: logFile, ...(options.env ?? {}) },
				baseEnv: { HOME: root, PATH: process.env.PATH ?? "/usr/bin:/bin" },
				startupTimeoutMs: 10_000,
			}),
		readLog: () =>
			readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as LogEntry),
	};
}

function nextFinal(driver: AgyOmpDriver): Promise<OmpFinal> {
	const { promise, resolve } = Promise.withResolvers<OmpFinal>();
	const off = driver.onFinal((final) => {
		off();
		resolve(final);
	});
	return promise;
}

function nextEvent(driver: AgyOmpDriver, match: (event: OmpEvent) => boolean): Promise<OmpEvent> {
	const { promise, resolve } = Promise.withResolvers<OmpEvent>();
	const off = driver.onEvent((event) => {
		if (!match(event)) return;
		off();
		resolve(event);
	});
	return promise;
}

/** Resolves once the fake's log holds an entry `match` accepts (a log write is the fake's event). */
function logged(harness: Harness, match: (entry: LogEntry) => boolean): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const check = (): void => {
		const lines = readFileSync(harness.logFile, "utf8").split("\n");
		const found = lines.some((line) => {
			try {
				return match(JSON.parse(line) as LogEntry);
			} catch {
				return false; // empty tail or a line still being appended
			}
		});
		if (!found) return;
		watcher.close();
		resolve();
	};
	const watcher = watch(harness.logFile, check);
	check();
	return promise;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function spawns(harness: Harness): string[][] {
	return harness
		.readLog()
		.filter((entry) => entry.dir === "argv" && entry.argv?.[0] !== "models")
		.map((entry) => entry.argv ?? []);
}

function sentContents(harness: Harness): string[] {
	return harness
		.readLog()
		.filter((entry) => entry.dir === "in" && entry.frame?.event === "user")
		.map((entry) => entry.frame?.message?.content ?? "");
}

const BASE_ARGS = ["--input-format", "stream-json", "--output-format", "stream-json", "-p", ""];

test("start fails fast with agy_executable_missing", async () => {
	const root = tempDir("ompbot-agy-missing-");
	const driver = new AgyOmpDriver({
		agyExecutable: join(root, "no-such-agy"),
		cwd: root,
		sessionDir: join(root, "s"),
		baseEnv: { HOME: root, PATH: "/usr/bin:/bin" },
	});
	const error = await driver.start().catch((e: unknown) => e);
	expect(error).toBeInstanceOf(OmpDriverError);
	expect(error).toMatchObject({ code: "agy_executable_missing" });
	expect(driver.pid).toBeUndefined();
});

test("one turn completes; entries, usage and the system prompt on the first message only", async () => {
	const harness = makeHarness();
	const driver = harness.make({ model: "gemini-3.8-flash-high", systemPrompt: "FLOORS" });
	await driver.start();
	const opened = await driver.openSession();
	expect(opened.resumed).toBe(false);
	expect(opened.sessionId.length).toBeGreaterThan(0);
	expect(await driver.leafId()).toBe(null);

	const done = nextFinal(driver);
	const opRef = await driver.prompt("hello");
	expect(await done).toEqual({ opRef, status: "completed", text: "REPLY1:hello" });

	const all = await driver.entriesSince();
	expect(all.entries.map((entry) => entry.message?.role)).toEqual(["user", "assistant"]);
	expect(all.entries[0]?.message?.content).toBe("hello");
	expect(all.entries[1]?.message).toMatchObject({
		stopReason: "stop",
		provider: "agy",
		model: "gemini-3.8-flash-high",
		usage: { input: 100, output: 7, cacheRead: 40 },
	});
	expect(all.entries[1]?.message?.usage?.cost).toBeUndefined();
	expect(turnAnswerParts(all.entries)).toEqual(["REPLY1:hello"]);
	const leaf = await driver.leafId();
	expect(leaf).toBe(all.leafId);
	expect((await driver.entriesSince(leaf ?? undefined)).entries).toEqual([]);
	expect(await driver.entriesSince("nope").catch((e: unknown) => e)).toMatchObject({ code: "unknown_since" });

	// Second turn: same process, conversation continues, no second system prompt.
	const second = nextFinal(driver);
	await driver.prompt("again");
	expect(await second).toMatchObject({ status: "completed", text: "REPLY2:again" });
	expect(sentContents(harness)).toEqual(["FLOORS\n\n---\n\nhello", "again"]);
	expect(spawns(harness)).toEqual([
		[...BASE_ARGS, "--model", "gemini-3.8-flash-high", "--dangerously-skip-permissions"],
	]);
	expect(await driver.state()).toMatchObject({
		sessionId: opened.sessionId,
		idle: true,
		queuedMessageCount: 0,
		model: "agy/gemini-3.8-flash-high",
		thinking: "high",
	});
	await driver.stop();
});

test("an ERROR result ends the turn as error", async () => {
	const harness = makeHarness();
	const driver = harness.make();
	await driver.start();
	const done = nextFinal(driver);
	const opRef = await driver.prompt("@error");
	expect(await done).toEqual({ opRef, status: "error", text: "", error: "boom" });
	expect(await driver.state()).toMatchObject({ idle: true });
	await driver.stop();
});

test("tool steps become toolCall/toolResult entries and tool events", async () => {
	const harness = makeHarness();
	const driver = harness.make();
	await driver.start();
	const toolStart = nextEvent(driver, (event) => event.type === "tool_execution_start");
	const done = nextFinal(driver);
	await driver.prompt("@tool run it");
	expect(await toolStart).toMatchObject({ toolName: "run_command", args: { CommandLine: "echo hi" } });
	await done;
	const { entries } = await driver.entriesSince();
	expect(entries.map((entry) => entry.message?.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
	expect(entries[1]?.message).toMatchObject({
		stopReason: "toolUse",
		content: [{ type: "toolCall", name: "run_command", arguments: { CommandLine: "echo hi" } }],
	});
	expect(entries[2]?.message?.content).toEqual([{ type: "text", text: "hi" }]);
	expect(turnAnswerParts(entries)).toEqual(["REPLY1:@tool run it"]);
	await driver.stop();
});

test("openSession resumes the pointer conversation; newSession starts fresh", async () => {
	const harness = makeHarness();
	const first = harness.make();
	await first.start();
	const opened = await first.openSession();
	const pointer = join(harness.sessionDir, "agy-conversation.json");
	expect(JSON.parse(readFileSync(pointer, "utf8"))).toEqual({ conversationId: opened.sessionId });
	await first.stop();

	const second = harness.make();
	await second.start();
	expect(await second.openSession()).toEqual({ resumed: true, sessionId: opened.sessionId });
	expect(spawns(harness).at(-1)).toEqual([
		...BASE_ARGS,
		"--conversation",
		opened.sessionId,
		"--dangerously-skip-permissions",
	]);

	await second.newSession();
	const fresh = await second.openSession();
	expect(fresh.resumed).toBe(false);
	expect(fresh.sessionId).not.toBe(opened.sessionId);
	expect(spawns(harness).at(-1)).toEqual([...BASE_ARGS, "--dangerously-skip-permissions"]);
	expect(JSON.parse(readFileSync(pointer, "utf8"))).toEqual({ conversationId: fresh.sessionId });
	await second.stop();
});

test("a conversation agy no longer knows is not reported as resumed", async () => {
	const harness = makeHarness();
	mkdirSync(harness.sessionDir, { recursive: true });
	writeFileSync(
		join(harness.sessionDir, "agy-conversation.json"),
		`${JSON.stringify({ conversationId: "gone-1234" })}\n`,
	);
	const driver = harness.make({ env: { FAKE_AGY_UNKNOWN_CONVERSATION: "1" } });
	await driver.start();
	const opened = await driver.openSession();
	expect(opened.resumed).toBe(false);
	expect(opened.sessionId).not.toBe("gone-1234");
	const pointer = JSON.parse(readFileSync(join(harness.sessionDir, "agy-conversation.json"), "utf8"));
	expect(pointer).toEqual({ conversationId: opened.sessionId });
	await driver.stop();
});

test("switchSession pins and resumes the given conversation id", async () => {
	const harness = makeHarness();
	const driver = harness.make();
	await driver.start();
	await driver.switchSession("/somewhere/conv-abcdef12.jsonl");
	expect(await driver.openSession()).toEqual({ resumed: true, sessionId: "conv-abcdef12" });
	expect(await driver.switchSession("x").catch((e: unknown) => e)).toMatchObject({ code: "rpc_error" });
	await driver.stop();
});

test("availableModels runs `agy models` once; setModel and setThinking respawn on the same conversation", async () => {
	expect(parseAgyModels("Fetching available models...\na-high\tA (High)\n\nb\tB\n")).toEqual(["a-high", "b"]);
	const harness = makeHarness();
	const driver = harness.make({ model: "gemini-3.8-flash-low", thinking: "medium" });
	await driver.start();
	const { sessionId } = await driver.openSession();
	expect(spawns(harness).at(-1)).toContain("gemini-3.8-flash-medium");

	const models = await driver.availableModels();
	expect(models).toEqual([
		"agy/gemini-3.8-flash-high",
		"agy/gemini-3.8-flash-medium",
		"agy/gemini-3.8-flash-low",
		"agy/gpt-oss-120b-medium",
	]);
	expect(await driver.availableModels()).toEqual(models);

	expect(await driver.setModel("agy/nope").catch((e: unknown) => e)).toMatchObject({ code: "rpc_error" });
	expect(await driver.setModel("claude/opus").catch((e: unknown) => e)).toMatchObject({ code: "rpc_error" });
	expect(await driver.setModel("agy/gemini-3.8-flash-high")).toBe("agy/gemini-3.8-flash-high");
	expect(spawns(harness).at(-1)).toEqual([
		...BASE_ARGS,
		"--conversation",
		sessionId,
		"--model",
		"gemini-3.8-flash-high",
		"--dangerously-skip-permissions",
	]);

	expect(await driver.thinkingLevels()).toEqual(["low", "medium", "high"]);
	await driver.setThinking("low");
	expect(await driver.state()).toMatchObject({ sessionId, model: "agy/gemini-3.8-flash-low", thinking: "low" });
	expect(await driver.setThinking("xhigh").catch((e: unknown) => e)).toMatchObject({ code: "rpc_error" });

	await driver.setModel("agy/gpt-oss-120b-medium");
	// gpt-oss has no -low variant: the thinking switch is refused instead of spawning an unknown model.
	expect(await driver.setThinking("low").catch((e: unknown) => e)).toMatchObject({ code: "rpc_error" });

	const listings = harness.readLog().filter((entry) => entry.dir === "argv" && entry.argv?.[0] === "models");
	expect(listings.length).toBe(1);
	await driver.stop();
});

test("steer while a turn runs is queued and answered within the same turn", async () => {
	const harness = makeHarness();
	const driver = harness.make();
	await driver.start();
	const started = nextEvent(driver, (event) => event.type === "step_update");
	const done = nextFinal(driver);
	const opRef = await driver.prompt("@hold");
	await started;
	await driver.steer("also this");
	expect(await driver.state()).toMatchObject({ idle: false, queuedMessageCount: 1 });
	expect(sentContents(harness)).toEqual(["@hold"]);

	const pid = driver.pid;
	if (pid === undefined) throw new Error("no child");
	process.kill(pid, "SIGUSR1");
	expect(await done).toEqual({ opRef, status: "completed", text: "REPLY2:also this" });
	expect(sentContents(harness)).toEqual(["@hold", "also this"]);
	expect(turnAnswerParts((await driver.entriesSince()).entries)).toEqual(["HELD-DONE", "REPLY2:also this"]);
	expect(await driver.state()).toMatchObject({ idle: true, queuedMessageCount: 0 });
	expect(await driver.steer("late").catch((e: unknown) => e)).toMatchObject({ code: "rpc_error" });
	await driver.stop();
});

test("abort interrupts the child; the turn ends aborted and the next prompt resumes the conversation", async () => {
	const harness = makeHarness();
	const driver = harness.make();
	const exits: unknown[] = [];
	driver.onExit((info) => exits.push(info));
	await driver.start();
	const { sessionId } = await driver.openSession();
	const firstPid = driver.pid;
	const started = nextEvent(driver, (event) => event.type === "step_update");
	const done = nextFinal(driver);
	const opRef = await driver.prompt("@hold");
	await started;
	await driver.steer("dropped");
	await driver.abort();
	expect(await done).toEqual({ opRef, status: "aborted", text: "", error: "interrupted" });
	expect(driver.pid).toBeUndefined();
	expect(exits).toEqual([]);

	const next = nextFinal(driver);
	await driver.prompt("after");
	expect(await next).toMatchObject({ status: "completed", text: "REPLY1:after" });
	expect(driver.pid).not.toBe(firstPid);
	expect(spawns(harness).at(-1)).toEqual([...BASE_ARGS, "--conversation", sessionId, "--dangerously-skip-permissions"]);
	expect(sentContents(harness)).toEqual(["@hold", "after"]);
	await driver.stop();
	expect(exits).toEqual([]);
});

test("a respawn waits for the previous child to exit; that child's late output stays out of the new one", async () => {
	const harness = makeHarness();
	const driver = harness.make();
	await driver.start();
	const lingered = nextFinal(driver);
	await driver.prompt("@linger");
	await lingered;
	const oldPid = driver.pid;
	if (oldPid === undefined) throw new Error("no child");
	try {
		const termed = logged(harness, (entry) => entry.dir === "term");
		const switched = driver.switchSession("conv-abcdef12");
		await termed;
		// The old child ignores SIGTERM until SIGUSR2: no new child may be running beside it.
		expect(driver.pid).toBeUndefined();
		expect(spawns(harness)).toHaveLength(1);
		process.kill(oldPid, "SIGUSR2");
		await switched;
	} finally {
		if (alive(oldPid)) process.kill(oldPid, "SIGKILL");
	}
	expect(driver.pid).not.toBe(oldPid);
	expect(await driver.openSession()).toEqual({ resumed: true, sessionId: "conv-abcdef12" });
	expect((await driver.entriesSince()).entries).toEqual([]);

	const exit = Promise.withResolvers<OmpExitInfo>();
	driver.onExit((info) => exit.resolve(info));
	const newPid = driver.pid;
	if (newPid === undefined) throw new Error("no child");
	process.kill(newPid, "SIGINT");
	expect((await exit.promise).stderr).not.toContain("OLD-CHILD-STDERR");
	await driver.stop();
});

test("a respawn during a turn ends that turn aborted before the new child takes prompts", async () => {
	const harness = makeHarness();
	const driver = harness.make({ model: "gemini-3.8-flash-high" });
	const finals: OmpFinal[] = [];
	driver.onFinal((final) => finals.push(final));
	await driver.start();

	const started = nextEvent(driver, (event) => event.type === "step_update");
	const first = await driver.prompt("@hold");
	await started;
	await driver.newSession();
	expect(finals).toEqual([{ opRef: first, status: "aborted", text: "", error: "agy restarted (new session)" }]);
	expect(await driver.state()).toMatchObject({ idle: true });

	const restarted = nextEvent(driver, (event) => event.type === "step_update");
	const second = await driver.prompt("@hold");
	await restarted;
	await driver.setModel("agy/gemini-3.8-flash-low");
	expect(finals.at(-1)).toEqual({ opRef: second, status: "aborted", text: "", error: "agy restarted (model change)" });

	const done = nextFinal(driver);
	const third = await driver.prompt("after");
	expect(await done).toEqual({ opRef: third, status: "completed", text: "REPLY1:after" });
	expect(finals).toHaveLength(3);
	await driver.stop();
});

test("a steered message that cannot be sent ends the turn as error", async () => {
	const harness = makeHarness();
	const realSpawn = Bun.spawn;
	// stdin of the real fake child, except that writing the steered line fails like a broken pipe.
	const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
		const proc = realSpawn(...args);
		if (proc.stdin === undefined || typeof proc.stdin === "number") return proc;
		const stdin = proc.stdin;
		return {
			pid: proc.pid,
			exited: proc.exited,
			stdout: proc.stdout,
			stderr: proc.stderr,
			kill: (signal?: NodeJS.Signals) => proc.kill(signal),
			stdin: {
				write: (data: string) => {
					if (data.includes("STEER-FAIL")) throw new Error("EPIPE: broken pipe, write");
					return stdin.write(data);
				},
			},
		};
	}) as unknown as typeof Bun.spawn);
	try {
		const driver = harness.make();
		await driver.start();
		const started = nextEvent(driver, (event) => event.type === "step_update");
		const done = nextFinal(driver);
		const opRef = await driver.prompt("@hold");
		await started;
		await driver.steer("STEER-FAIL");
		const pid = driver.pid;
		if (pid === undefined) throw new Error("no child");
		process.kill(pid, "SIGUSR1");
		expect(await done).toEqual({
			opRef,
			status: "error",
			text: "HELD-DONE",
			error: "steer 전송 실패: agy stdin is closed",
		});
		expect(await driver.state()).toMatchObject({ idle: true, queuedMessageCount: 0 });
		await driver.stop();
	} finally {
		spawnSpy.mockRestore();
	}
});

test("steered messages dropped by a failed turn are named in the error", async () => {
	const harness = makeHarness();
	const driver = harness.make();
	await driver.start();
	const started = nextEvent(driver, (event) => event.type === "step_update");
	const done = nextFinal(driver);
	const opRef = await driver.prompt("@hold @fail");
	await started;
	await driver.steer("one");
	await driver.steer("two");
	const pid = driver.pid;
	if (pid === undefined) throw new Error("no child");
	process.kill(pid, "SIGUSR1");
	expect(await done).toEqual({ opRef, status: "error", text: "", error: "boom (steer 2건 미전달)" });
	expect(sentContents(harness)).toEqual(["@hold @fail"]);
	expect(await driver.state()).toMatchObject({ idle: true, queuedMessageCount: 0 });
	await driver.stop();
});

test("a child that dies on its own is reported through onExit", async () => {
	const harness = makeHarness();
	const driver = harness.make();
	const exit = Promise.withResolvers<unknown>();
	driver.onExit((info) => exit.resolve(info));
	await driver.start();
	const pid = driver.pid;
	if (pid === undefined) throw new Error("no child");
	process.kill(pid, "SIGINT");
	expect(await exit.promise).toMatchObject({ code: 130, expected: false });
	expect(driver.pid).toBeUndefined();
	await driver.stop();
});

test("compact is refused with rpc_error", async () => {
	const harness = makeHarness();
	const driver = harness.make();
	await driver.start();
	const error = await driver.compact().catch((e: unknown) => e);
	expect(error).toBeInstanceOf(OmpDriverError);
	expect(error).toMatchObject({ code: "rpc_error", message: "agy 세션은 compact를 지원하지 않습니다" });
	expect(existsSync(join(harness.sessionDir, "agy-conversation.json"))).toBe(true);
	await driver.stop();
});
