import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DaemonAnswer, LANES_USAGE, lanesCommand, ompSessionDirFor, summarizeEntry } from "../src/cli/lanes";
import { openBotStore, sessionDirFor } from "../src/core/origin";
import { Daemon } from "../src/daemon/daemon";
import { callDaemon } from "../src/daemon/ipc";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import { TASK_SCHEMA } from "../src/tasks/ledger";
import { makeHome, type TestHome, WaitingTransport } from "./helpers/bot-home";

const LANE = "watch-lane";
const LANE_ORIGIN = `ompbot/work/${LANE}`;
const THREAD_ORIGIN = "discord/ch/C1/t/T1";
const MAIN = join(import.meta.dir, "..", "src", "main.ts");
/** A home directory and a host name, put together at run time so the public core carries neither literal. */
const HOME = ["", "home", "ubuntu"].join("/");
const SECOND_OCI_HOST = ["oci", 2].join("");

const entry = (role: string, content: unknown, timestamp = "2026-11-13T01:02:03.000Z"): string =>
	`${JSON.stringify({ type: "message", id: "e", parentId: null, timestamp, message: { role, content } })}\n`;

/**
 * Collects watch output; `next(match)` resolves on the write event of the first matching line. The timer is only the
 * upper bound of that wait (AC-3's "within 2 s" is the behavior under test), never a sleep.
 */
function collector() {
	const lines: string[] = [];
	const waiters: { match: (line: string) => boolean; resolve: (line: string) => void }[] = [];
	const write = (line: string) => {
		lines.push(line);
		for (const waiter of waiters.splice(0)) {
			if (waiter.match(line)) waiter.resolve(line);
			else waiters.push(waiter);
		}
	};
	const next = (match: (line: string) => boolean, ms: number): Promise<string> => {
		const seen = lines.find(match);
		if (seen !== undefined) return Promise.resolve(seen);
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		const timer = setTimeout(() => reject(new Error(`no matching line within ${ms}ms: ${lines.join(" | ")}`)), ms);
		waiters.push({
			match,
			resolve: (line) => {
				clearTimeout(timer);
				resolve(line);
			},
		});
		return promise;
	};
	return { lines, write, next };
}

function runMain(args: string[], home: string): { code: number; stderr: string; stdout: string } {
	const result = Bun.spawnSync([process.execPath, MAIN, ...args], {
		env: { ...process.env, OMPBOT_HOME: home },
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: result.exitCode ?? -1, stderr: result.stderr.toString(), stdout: result.stdout.toString() };
}

describe("ompbot lanes watch", () => {
	let home: TestHome;
	let laneDir: string;
	let threadDir: string;

	beforeEach(() => {
		home = makeHome("ompbot-lanes-watch-");
		const store = openBotStore(join(home.dir, "ompbot.db"), { now: () => Date.now() }, "Asia/Seoul");
		laneDir = sessionDirFor(join(home.dir, "sessions"), LANE_ORIGIN, 1);
		threadDir = sessionDirFor(join(home.dir, "sessions"), THREAD_ORIGIN, 1);
		store.insertLane({
			name: LANE,
			title: "watch test",
			threadRef: "C1:T9",
			originKey: LANE_ORIGIN,
			cwd: home.dir,
			sessionDir: laneDir,
			meta: { startedAt: 0, lastProgressAt: 0, steerSeq: 0 },
		});
		store.ensureOrigin(THREAD_ORIGIN, threadDir);
		store.close();
		mkdirSync(laneDir, { recursive: true });
		mkdirSync(threadDir, { recursive: true });
	});

	afterEach(() => home.remove());

	test("AC-1: the help lists `lanes watch <lane|origin>`; an unknown name exits non-zero with one error line", () => {
		expect(LANES_USAGE).toContain("lanes watch <lane|origin>");
		const help = runMain(["--help"], home.dir);
		expect(help.code).toBe(0);
		expect(help.stderr).toContain("lanes watch <lane|origin>");

		const missing = runMain(["lanes", "watch", "no-such-lane"], home.dir);
		expect(missing.code).toBe(1);
		expect(missing.stdout).toBe("");
		expect(missing.stderr).toBe("lanes watch: no lane or origin named no-such-lane\n");
	});

	test("AC-1: a lane name and an origin key both resolve to their origin's session", async () => {
		writeFileSync(join(laneDir, "lane.jsonl"), entry("user", [{ type: "text", text: "레인 첫 글" }]));
		writeFileSync(join(threadDir, "thread.jsonl"), entry("user", "스레드 첫 글"));
		const none = async (): Promise<DaemonAnswer> => ({ kind: "none" });
		for (const [target, file, text] of [
			[LANE, join(laneDir, "lane.jsonl"), "레인 첫 글"],
			[THREAD_ORIGIN, join(threadDir, "thread.jsonl"), "스레드 첫 글"],
		] as const) {
			const out = collector();
			const controller = new AbortController();
			const done = lanesCommand(["watch", target], home.dir, {
				write: out.write,
				error: out.write,
				signal: controller.signal,
				askDaemon: none,
			});
			await out.next((line) => line.endsWith(`user: ${text}`), 2_000);
			controller.abort();
			expect(await done).toBe(0);
			expect(out.lines.some((line) => line.startsWith(`file ${file} `))).toBe(true);
		}
	});

	test("AC-2: the file follows sessionToResume (pin, else newest in the dir) unless the daemon names an open file", async () => {
		const older = join(laneDir, "older.jsonl");
		const newer = join(laneDir, "newer.jsonl");
		writeFileSync(older, "");
		writeFileSync(newer, "");
		utimesSync(older, new Date(1_000_000), new Date(1_000_000));
		const fileOf = async (askDaemon: () => Promise<DaemonAnswer>): Promise<string | undefined> => {
			const out = collector();
			const controller = new AbortController();
			controller.abort();
			expect(
				await lanesCommand(["watch", LANE], home.dir, { write: out.write, signal: controller.signal, askDaemon }),
			).toBe(0);
			return out.lines.find((line) => line.startsWith("file "))?.split(" ")[1];
		};
		expect(await fileOf(async () => ({ kind: "down", reason: "no socket" }))).toBe(newer);
		expect(await fileOf(async () => ({ kind: "open", file: older }))).toBe(older);

		const store = openBotStore(join(home.dir, "ompbot.db"), { now: () => Date.now() }, "Asia/Seoul");
		store.newEpoch(LANE_ORIGIN, laneDir, undefined, older); // what `/resume-ompbot` pins
		store.close();
		expect(await fileOf(async () => ({ kind: "none" }))).toBe(older);
	});

	test("AC-3: an appended entry prints within 2 s, and the watch leaves the file's mtime and size alone", async () => {
		const file = join(laneDir, "s.jsonl");
		writeFileSync(file, entry("user", [{ type: "text", text: "처음" }]));
		utimesSync(file, new Date(2_000_000), new Date(2_000_000));
		const before = statSync(file);
		const out = collector();
		const controller = new AbortController();
		const done = lanesCommand(["watch", LANE], home.dir, {
			write: out.write,
			signal: controller.signal,
			askDaemon: async () => ({ kind: "none" }),
		});
		await out.next((line) => line.endsWith("user: 처음"), 2_000);
		const started = statSync(file);
		expect([started.mtimeMs, started.size]).toEqual([before.mtimeMs, before.size]);

		// A record split over two writes prints once, after its newline lands.
		const assistant = entry("assistant", [
			{ type: "thinking", thinking: "속생각" },
			{ type: "text", text: "작업 중입니다" },
			{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls", i: "Listing files" } },
		]);
		appendFileSync(file, assistant.slice(0, 40));
		appendFileSync(file, assistant.slice(40));
		const appended = statSync(file);
		await out.next((line) => line.endsWith("tool: bash Listing files"), 2_000);
		controller.abort();
		expect(await done).toBe(0);
		const after = statSync(file);
		expect([after.mtimeMs, after.size]).toEqual([appended.mtimeMs, appended.size]);
		expect(out.lines.filter((line) => line.includes("작업 중입니다"))).toEqual(["10:02:03 assistant: 작업 중입니다"]);
		expect(out.lines.some((line) => line.includes("속생각"))).toBe(false);
	});

	test("summaries: user string content, tool call without intent, and records that are not messages", () => {
		expect(summarizeEntry(JSON.parse(entry("user", "안녕")), "Asia/Seoul")).toEqual(["10:02:03 user: 안녕"]);
		expect(
			summarizeEntry(
				JSON.parse(entry("assistant", [{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }])),
				"Asia/Seoul",
			),
		).toEqual(['10:02:03 tool: read {"path":"a.ts"}']);
		expect(summarizeEntry(JSON.parse(entry("toolResult", [{ type: "text", text: "out" }])), "Asia/Seoul")).toEqual([]);
		expect(summarizeEntry({ type: "model_change", model: "x/y" }, "Asia/Seoul")).toEqual([]);
	});
});

describe("daemon session_file op", () => {
	const ORIGIN = "slack/dm/D1";
	let home: TestHome;
	let daemon: Daemon | undefined;

	beforeEach(() => {
		home = makeHome("ompbot-lanes-watch-daemon-");
	});

	afterEach(async () => {
		await daemon?.stop();
		home.remove();
	});

	test("AC-2: the running child's open file is answered over the socket and preferred by the watch", async () => {
		const openFile = join(home.dir, "open-session.jsonl");
		writeFileSync(openFile, entry("user", "열린 파일"));
		const drivers: FakeOmpDriver[] = [];
		const started = Promise.withResolvers<void>();
		const sessions = new FakeSessionStore();
		daemon = new Daemon({
			config: home.config,
			channels: [new SlackBinding(new SlackChannel(new WaitingTransport()))],
			log: createLogger({
				sink: (line) => {
					if (line.includes("event=turn_start")) started.resolve();
				},
				clock: { now: () => Date.now() },
				redact,
			}),
			ompVersion: "omp-test 0",
			bootId: "kernel-boot-id",
			driverFactory: (_origin, sessionDir) => {
				const driver = new FakeOmpDriver({ sessionDir, store: sessions, holdTurns: true, sessionFile: openFile });
				drivers.push(driver);
				return driver;
			},
		});
		expect(await callDaemon(daemon.socketPath, { op: "session_file", origin: ORIGIN }).catch(() => "down")).toBe(
			"down",
		);
		await daemon.start();
		expect(await callDaemon(daemon.socketPath, { op: "session_file", origin: ORIGIN })).toEqual({
			ok: true,
			sessionFile: null,
		});
		await daemon.inject({ origin: ORIGIN, asOwner: true, text: "일해" });
		await started.promise;
		expect(await callDaemon(daemon.socketPath, { op: "session_file", origin: ORIGIN })).toEqual({
			ok: true,
			sessionFile: openFile,
		});
		expect(await callDaemon(daemon.socketPath, { op: "session_file" })).toMatchObject({ ok: false });

		const out = collector();
		const controller = new AbortController();
		const done = lanesCommand(["watch", ORIGIN], home.dir, { write: out.write, signal: controller.signal });
		await out.next((line) => line.endsWith("user: 열린 파일"), 2_000);
		controller.abort();
		expect(await done).toBe(0);
		expect(out.lines).toContain(`file ${openFile} — open in the running child`);
		drivers[0]?.release();
	});
});

describe("ompbot lanes watch <TASK id>", () => {
	let home: TestHome;
	let env: Record<string, string>;

	/** A `tasks` row as the dispatcher writes it; `host` null is a local TASK. */
	function insertTask(taskId: string, host: string | null, worktree: string): void {
		const db = new Database(join(home.dir, "ompbot.db"), { strict: true });
		db.run(TASK_SCHEMA);
		db.query(
			`INSERT INTO tasks (task_id, title, risk, origin_key, thread_ref, host, repo, worktree, branch, agent, status,
				acceptance_json, created_at, updated_at) VALUES (?, 't', 'L1', 'o', 'C1:T1', ?, '/r', ?, 'b', 'a', 'working', '[]', 0, 0)`,
		).run(taskId, host, worktree);
		db.close();
	}

	beforeEach(() => {
		home = makeHome("ompbot-lanes-watch-task-");
		const store = openBotStore(join(home.dir, "ompbot.db"), { now: () => Date.now() }, "Asia/Seoul");
		store.close();
		// The worker's HOME and agent dir live in the test home: nothing reads the real ~/.omp.
		env = { HOME: join(home.dir, "user"), PI_CODING_AGENT_DIR: join(home.dir, "user", ".omp", "agent") };
		mkdirSync(env.HOME as string, { recursive: true });
	});

	afterEach(() => home.remove());

	test("AC-4: the session folder name follows omp's rule (measured 11-13: home-relative, / as -)", () => {
		expect(ompSessionDirFor(`${HOME}/work/ompbot-t-20261113-03`, HOME, "/s", "/tmp")).toBe(
			"/s/-work-ompbot-t-20261113-03",
		);
		expect(ompSessionDirFor("/tmp/a/b", HOME, "/s", "/tmp")).toBe("/s/-tmp-a-b");
		expect(ompSessionDirFor("/opt/x/y", HOME, "/s", "/tmp")).toBe("/s/--opt-x-y--");
	});

	test("AC-4: a local TASK's worker session prints a new entry within 2 s", async () => {
		const worktree = join(env.HOME as string, "work", "proj-t-20261113-09");
		mkdirSync(worktree, { recursive: true });
		insertTask("T-20261113-09", null, worktree);
		const dir = ompSessionDirFor(worktree, env.HOME as string, join(env.PI_CODING_AGENT_DIR as string, "sessions"));
		mkdirSync(dir, { recursive: true });
		const older = join(dir, "2026-11-12T00-00-00-000Z_old.jsonl");
		const file = join(dir, "2026-11-13T00-00-00-000Z_new.jsonl");
		writeFileSync(older, entry("user", "옛 세션"));
		utimesSync(older, new Date(1_000_000), new Date(1_000_000));
		writeFileSync(file, entry("user", "워커 시작"));

		const out = collector();
		const controller = new AbortController();
		const done = lanesCommand(["watch", "T-20261113-09"], home.dir, {
			write: out.write,
			error: out.write,
			signal: controller.signal,
			env,
		});
		await out.next((line) => line.endsWith("user: 워커 시작"), 2_000);
		appendFileSync(file, entry("assistant", [{ type: "text", text: "워커가 일하는 중" }]));
		await out.next((line) => line.endsWith("assistant: 워커가 일하는 중"), 2_000);
		controller.abort();
		expect(await done).toBe(0);
		expect(out.lines).toContain(`watching TASK T-20261113-09 (${worktree})`);
		expect(out.lines.some((line) => line.startsWith(`file ${file} `))).toBe(true);
	});

	test("AC-4: a remote TASK and an unknown TASK exit non-zero with one error line", () => {
		insertTask("T-20261113-10", SECOND_OCI_HOST, `${HOME}/work/x-t-20261113-10`);
		const remote = runMain(["lanes", "watch", "T-20261113-10"], home.dir);
		expect(remote.code).toBe(1);
		expect(remote.stdout).toBe("");
		expect(remote.stderr).toBe(
			`lanes watch: T-20261113-10 runs on ${SECOND_OCI_HOST}; a remote TASK is watched on that host\n`,
		);

		const missing = runMain(["lanes", "watch", "T-20261113-99"], home.dir);
		expect(missing.code).toBe(1);
		expect(missing.stdout).toBe("");
		expect(missing.stderr).toBe("lanes watch: no TASK named T-20261113-99\n");
	});
});
