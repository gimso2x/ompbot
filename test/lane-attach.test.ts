import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANES_USAGE, lanesCommand } from "../src/cli/lanes";
import { Daemon } from "../src/daemon/daemon";
import { DEFAULT_SWEEP_MS } from "../src/daemon/heartbeat";
import { callDaemon } from "../src/daemon/ipc";
import { parseLaneActionId } from "../src/lanes/card";
import type { LaneRow } from "../src/lanes/status";
import { createLogger } from "../src/log";
import type { OmpState } from "../src/omp/driver";
import { FakeOmpDriver, type FakeOmpDriverOptions, FakeSessionStore } from "../src/omp/fake-driver";
import { newestSessionFile } from "../src/omp/session-heal";
import { redact } from "../src/redact";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import { makeHome, OWNER, type TestHome, WaitingTransport } from "./helpers/bot-home";
import { makeRepo } from "./helpers/git-fixtures";
import { removeRepoAndWorktrees } from "./helpers/lane-harness";

// doc/plans/lane-attach.md 2단계: a lane's session is handed to a terminal omp over IPC (lane_attach / lane_detach) and
// taken back — never by guessing from files. The fake omp below opens real files like omp does: at start the newest
// session of its dir (a new file in an empty dir), `switchSession` the named one, and `state()` reports it.

let fileSeq = 0;

class FileSessionDriver extends FakeOmpDriver {
	readonly dir: string;
	file: string | undefined;
	alive = false;

	constructor(options: FakeOmpDriverOptions & { sessionDir: string }) {
		super(options);
		this.dir = options.sessionDir;
	}

	async start(): Promise<void> {
		await super.start();
		mkdirSync(this.dir, { recursive: true });
		this.file = newestSessionFile(this.dir);
		if (this.file === undefined) {
			fileSeq += 1;
			this.file = join(this.dir, `2027-01-01T00-00-${String(fileSeq).padStart(2, "0")}-000Z_child.jsonl`);
			writeFileSync(this.file, "");
		}
		this.alive = true;
	}

	async switchSession(sessionFile: string): Promise<{ cancelled: boolean }> {
		const result = await super.switchSession(sessionFile);
		this.file = sessionFile;
		return result;
	}

	async state(): Promise<OmpState> {
		const base = await super.state();
		return this.file === undefined ? base : { ...base, sessionFile: this.file };
	}

	async stop(): Promise<void> {
		this.alive = false;
		await super.stop();
	}
}

const entry = (role: string, text: string): string =>
	`${JSON.stringify({ type: "message", timestamp: "2027-01-01T00:00:00.000Z", message: { role, content: [{ type: "text", text }], ...(role === "assistant" ? { usage: { cost: { total: 0.25 } } } : {}) } })}\n`;

/** Resolves once `cond` holds; microtask polling only (a settle bound, never a fixed wait). */
async function until(cond: () => boolean, tries = 500): Promise<void> {
	for (let i = 0; !cond() && i < tries; i++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
	expect(cond()).toBeTrue();
}

describe("lane attach / detach through the daemon", () => {
	let home: TestHome;
	let repos: string[];
	let daemon: Daemon | undefined;
	let drivers: FileSessionDriver[];
	let transport: WaitingTransport;
	let logs: string[];
	let alivePids: Set<number>;

	beforeEach(() => {
		home = makeHome("ompbot-lane-attach-");
		repos = [];
		drivers = [];
		transport = new WaitingTransport();
		logs = [];
		alivePids = new Set([4242]);
	});

	afterEach(async () => {
		await daemon?.stop();
		daemon = undefined;
		home.remove();
		for (const repo of repos) removeRepoAndWorktrees(repo);
	});

	async function startDaemon(): Promise<Daemon> {
		const sessions = new FakeSessionStore();
		daemon = new Daemon({
			config: home.config,
			channels: [new SlackBinding(new SlackChannel(transport))],
			log: createLogger({ sink: (line) => logs.push(line), clock: { now: () => Date.now() }, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			stopDrainMs: 10,
			pidAlive: (pid) => alivePids.has(pid),
			driverFactory: (_origin, sessionDir) => {
				const driver = new FileSessionDriver({ sessionDir, store: sessions, holdTurns: true });
				drivers.push(driver);
				return driver;
			},
		});
		await daemon.start();
		return daemon;
	}

	const ownerMessage = (text: string, ts: string, threadTs: string) =>
		transport.emitMessage({
			type: "message",
			channel: "D1",
			channel_type: "im",
			user: OWNER,
			text,
			ts,
			thread_ts: threadTs,
		});

	/** A lane whose first turn is running (held by the fake omp until aborted). */
	async function runningLane(
		d: Daemon,
		title: string,
	): Promise<{ lane: LaneRow; rootTs: string; child: FileSessionDriver }> {
		const repo = makeRepo(repos);
		await d.inject({ origin: "slack/dm/D1", asOwner: true, text: `작업: ${title} @${repo}` });
		await transport.waitForPosts((text) => text.includes(`작업 레인 \`${title}\`을 시작했습니다`));
		const root = transport.posts((text) => text === `🔄 ${title}`)[0];
		await until(() => drivers.some((driver) => driver.calls.some((call) => call.startsWith("prompt:"))));
		const lane = d.store.getLane(title) as LaneRow;
		expect(lane.status).toBe("working");
		return { lane, rootTs: root?.ts ?? "", child: drivers.at(-1) as FileSessionDriver };
	}

	const attach = (d: Daemon, lane: string, extra: Record<string, unknown> = {}) =>
		callDaemon(d.socketPath, { op: "lane_attach", lane, pid: 4242, ...extra }) as Promise<Record<string, unknown>>;
	const detach = (d: Daemon, lane: string, sessionFile: string, newFiles: string[] = []) =>
		callDaemon(d.socketPath, { op: "lane_detach", lane, sessionFile, newFiles }) as Promise<Record<string, unknown>>;

	test("AC-1: attach answers the child's open file, aborts the running turn and leaves no lane child while released", async () => {
		const d = await startDaemon();
		const { lane, child } = await runningLane(d, "hand-me");
		const before = (await child.state()).sessionFile;
		expect(before).toBeString();

		const answer = await attach(d, lane.name);
		expect(answer).toEqual({ ok: true, sessionFile: before, cwd: lane.cwd, sessionDir: lane.sessionDir });
		expect(child.calls.filter((call) => call === "abort")).toHaveLength(1);
		expect(drivers.filter((driver) => driver.alive)).toHaveLength(0);
		const held = d.store.getLane(lane.name);
		expect(held?.status).toBe("paused");
		expect(held?.meta.attach).toMatchObject({ pid: 4242, sessionFile: before, wasPaused: false, keepPaused: false });
		// A second attach and a resume are refused while the terminal holds it.
		expect(await attach(d, lane.name)).toMatchObject({ ok: false });
		await d.sweep();
		expect(drivers.filter((driver) => driver.alive)).toHaveLength(0);
		expect(transport.posts((text) => text.includes("터미널 omp에서 이 레인을 넘겨받았습니다"))).toHaveLength(1);
	});

	test("AC-1: attach with wait lets the running turn finish instead of aborting it", async () => {
		const d = await startDaemon();
		const { lane, child } = await runningLane(d, "wait-me");
		const answer = attach(d, lane.name, { wait: true });
		await until(() => d.store.getLane(lane.name)?.meta.attach !== undefined);
		expect(child.alive).toBe(true);
		child.release();
		expect(await answer).toMatchObject({ ok: true, sessionFile: child.file });
		expect(child.calls.filter((call) => call === "abort")).toHaveLength(0);
		expect(child.alive).toBe(false);
	});

	test("AC-2 · AC-3: thread messages wait during attach; after detach the next child opens the attached file, not a newer one", async () => {
		const d = await startDaemon();
		const { lane, rootTs, child } = await runningLane(d, "give-back");
		const answer = await attach(d, lane.name);
		const file = answer.sessionFile as string;

		// The terminal writes the same file; a newer file also appears in the dir (what the daemon must not pick).
		appendFileSync(file, entry("user", "터미널 질문") + entry("assistant", "터미널 답"));
		const newer = join(lane.sessionDir, "2027-02-01T00-00-00-000Z_other.jsonl");
		writeFileSync(newer, "");
		utimesSync(file, new Date(1_000_000), new Date(1_000_000));
		expect(newestSessionFile(lane.sessionDir)).toBe(newer);

		await ownerMessage("터미널 중에 보낸 지시", "1900000000.000100", rootTs);
		await ownerMessage("!model fake/beta", "1900000000.000200", rootTs);
		await transport.waitForPosts((text) => text.includes("터미널에서 작업 중이라 전달하지 않았습니다"));
		expect(d.store.getInbound("D1:1900000000.000100")?.state).toBe("pending");
		expect(d.store.getInbound("D1:1900000000.000200")?.state).toBe("pending");
		expect(drivers).toHaveLength(1); // not even the command started a child

		expect(await detach(d, lane.name, file)).toMatchObject({ ok: true });
		await until(
			() => drivers.length === 2 && drivers[1]?.calls.some((call) => call.includes("터미널 중에 보낸 지시")) === true,
		);
		const next = drivers[1] as FileSessionDriver;
		expect(next.calls).toContain(`switchSession:${file}`);
		expect((await next.state()).sessionFile).toBe(file);
		expect(logs.some((line) => line.includes("event=session_resume_mismatch"))).toBe(false);
		expect(d.store.getOrigin(lane.originKey)?.sessionFile).toBe(file);
		expect(d.store.getOrigin(lane.originKey)?.epoch).toBe(1);
		expect(d.store.getLane(lane.name)?.status).toBe("working");
		expect(d.store.getLane(lane.name)?.meta.attach).toBeUndefined();
		expect(d.store.getInbound("D1:1900000000.000100")?.state).toBe("dispatched");
		// The hand-back summary: one terminal turn, its cost, no resume steer into the lane.
		expect(transport.posts((text) => text.includes("TUI에서 1턴") && text.includes("$0.25"))).toHaveLength(1);
		expect(next.calls.some((call) => call.includes("오너가 재개했습니다"))).toBe(false);
		expect(child.alive).toBe(false);
	});

	test("AC-2: new session files from the terminal keep the lane paused on the original file until the owner picks", async () => {
		const d = await startDaemon();
		const { lane, rootTs } = await runningLane(d, "pick-one");
		const file = (await attach(d, lane.name)).sessionFile as string;
		const created = join(lane.sessionDir, "2027-03-01T00-00-00-000Z_new.jsonl");
		writeFileSync(created, "");

		expect(await detach(d, lane.name, file, [created])).toMatchObject({ ok: true });
		const after = d.store.getLane(lane.name);
		expect(after?.status).toBe("paused");
		expect(after?.meta.attach).toBeUndefined();
		expect(after?.meta.sessionChoices).toEqual({ files: [file, created], resume: true });
		expect(d.store.getOrigin(lane.originKey)?.sessionFile).toBe(file);
		const card = transport.posts((text) => text.includes("이어 쓸 파일을 고르세요"))[0];
		const actions = JSON.stringify(card?.blocks ?? []);
		expect(actions).toContain(`ompbot:lane:session:${lane.name}:0`);
		expect(actions).toContain(`ompbot:lane:session:${lane.name}:1`);
		expect(parseLaneActionId(`ompbot:lane:session:${lane.name}:1`)).toEqual({
			kind: "session",
			name: lane.name,
			index: 1,
		});

		await transport.emitBlockAction({
			user: { id: OWNER },
			channel: { id: "D1" },
			message: { ts: card?.ts ?? "" },
			actions: [{ action_id: `ompbot:lane:session:${lane.name}:1`, value: lane.name }],
		});
		await transport.waitForPosts((text) => text.includes("이어 쓸 파일을"));
		expect(d.store.getOrigin(lane.originKey)?.sessionFile).toBe(created);
		expect(d.store.getLane(lane.name)?.status).toBe("working");
		expect(d.store.getLane(lane.name)?.meta.sessionChoices).toBeUndefined();
		await ownerMessage("이어서", "1900000000.000300", rootTs);
		await until(() => drivers.length === 2);
		await until(() => (drivers[1]?.calls ?? []).includes(`switchSession:${created}`));
	});

	test("AC-3: a dead attach process is taken back by the next lane tick (sweeps run well within a minute)", async () => {
		expect(DEFAULT_SWEEP_MS).toBeLessThanOrEqual(60_000);
		const d = await startDaemon();
		const { lane, rootTs } = await runningLane(d, "orphan");
		const file = (await attach(d, lane.name)).sessionFile as string;
		await ownerMessage("고아 중에 온 글", "1900000000.000400", rootTs);
		await transport.waitForPosts((text) => text.includes("터미널에서 작업 중이라 전달하지 않았습니다"));

		await d.sweep();
		await until(() => d.store.getLane(lane.name)?.meta.attach !== undefined); // still alive: nothing changes
		expect(d.store.getLane(lane.name)?.status).toBe("paused");

		alivePids.delete(4242);
		await d.sweep();
		await until(() => d.store.getLane(lane.name)?.status === "working");
		expect(d.store.getLane(lane.name)?.meta.attach).toBeUndefined();
		expect(d.store.getOrigin(lane.originKey)?.sessionFile).toBe(file);
		await until(
			() => drivers.length === 2 && drivers[1]?.calls.some((call) => call.includes("고아 중에 온 글")) === true,
		);
		expect(drivers[1]?.calls).toContain(`switchSession:${file}`);
		expect(transport.posts((text) => text.includes("attach 프로세스가 끝나 코어가 되찾음"))).toHaveLength(1);
	});

	test("keep-paused and a lane paused before the attach stay paused after the hand-back", async () => {
		const d = await startDaemon();
		const { lane } = await runningLane(d, "stay-put");
		const file = (await attach(d, lane.name, { keepPaused: true })).sessionFile as string;
		expect(
			await callDaemon(d.socketPath, { op: "lane_detach", lane: lane.name, sessionFile: "/other.jsonl", newFiles: [] }),
		).toMatchObject({ ok: false });
		expect(await detach(d, lane.name, file)).toMatchObject({ ok: true });
		expect(d.store.getLane(lane.name)?.status).toBe("paused");
		expect(d.store.getLane(lane.name)?.meta.attach).toBeUndefined();
		expect(drivers.filter((driver) => driver.alive)).toHaveLength(0);
		expect(await detach(d, lane.name, file)).toMatchObject({ ok: false });
		rmSync(file, { force: true });
	});

	/** A stand-in for `omp`: records its cwd and argv, writes one terminal turn to the resumed file, maybe a new file. */
	function fakeOmp(newFile: boolean): { script: string; mark: string } {
		const script = join(home.dir, "fake-omp.sh");
		const mark = join(home.dir, "fake-omp.mark");
		const user = entry("user", "CLI 터미널 질문").trim().replaceAll("'", "'\\''");
		const assistant = entry("assistant", "CLI 터미널 답").trim().replaceAll("'", "'\\''");
		writeFileSync(
			script,
			[
				"#!/bin/bash",
				`printf '%s\\n' "$PWD" "$*" > '${mark}'`,
				`printf '%s\\n' '${user}' '${assistant}' >> "$2"`,
				newFile ? `: > "$4/2027-04-01T00-00-00-000Z_tui-new.jsonl"` : "",
				"exit 0",
			].join("\n"),
		);
		return { script, mark };
	}

	test("CLI: `lanes attach` runs omp --resume on the attached file in the lane's worktree, then hands the lane back", async () => {
		expect(LANES_USAGE).toContain("lanes attach <lane> [--wait] [--keep-paused]");
		alivePids.add(process.pid);
		const d = await startDaemon();
		const { lane, child } = await runningLane(d, "cli-attach");
		const file = (await child.state()).sessionFile as string;
		const { script, mark } = fakeOmp(false);
		const out: string[] = [];
		const code = await lanesCommand(["attach", lane.name], home.dir, {
			write: (line) => out.push(line),
			error: (line) => out.push(`ERR ${line}`),
			ompCommand: ["bash", script],
		});
		expect(out.filter((line) => line.startsWith("ERR"))).toEqual([]);
		expect(code).toBe(0);
		const [cwd, argv] = readFileSync(mark, "utf8").split("\n");
		expect(cwd).toBe(realpathSync(lane.cwd));
		expect(argv).toBe(`--resume ${file} --session-dir ${lane.sessionDir}`);
		expect(out).toContain(`attached lane ${lane.name}: ${file}`);
		expect(out.some((line) => line.includes("TUI에서 1턴"))).toBe(true);
		expect(d.store.getLane(lane.name)?.status).toBe("working");
		expect(d.store.getLane(lane.name)?.meta.attach).toBeUndefined();
		expect(d.store.getOrigin(lane.originKey)?.sessionFile).toBe(file);
	});

	test("CLI: a new session file omp created is sent as newFiles and keeps the lane paused for the owner's pick", async () => {
		alivePids.add(process.pid);
		const d = await startDaemon();
		const { lane } = await runningLane(d, "cli-new-file");
		const { script } = fakeOmp(true);
		const out: string[] = [];
		expect(
			await lanesCommand(["attach", lane.name, "--keep-paused"], home.dir, {
				write: (line) => out.push(line),
				error: (line) => out.push(`ERR ${line}`),
				ompCommand: ["bash", script],
			}),
		).toBe(0);
		const created = join(lane.sessionDir, "2027-04-01T00-00-00-000Z_tui-new.jsonl");
		expect(out.some((line) => line.includes(`new session files: ${created}`))).toBe(true);
		const after = d.store.getLane(lane.name);
		expect(after?.status).toBe("paused");
		expect(after?.meta.sessionChoices?.files[1]).toBe(created);
		expect(after?.meta.sessionChoices?.resume).toBe(false);
	});

	test("CLI: without a daemon, or for an unknown lane, attach exits non-zero with one error line", async () => {
		const out: string[] = [];
		const opts = {
			write: (line: string) => out.push(line),
			error: (line: string) => out.push(`ERR ${line}`),
			ompCommand: ["false"],
		};
		expect(await lanesCommand(["attach", "nope"], home.dir, opts)).toBe(1);
		expect(out).toEqual([
			"ERR lanes attach: the daemon is not running (no ompbot.sock); attach needs it to release the lane",
		]);
		await startDaemon();
		out.length = 0;
		expect(await lanesCommand(["attach", "nope"], home.dir, opts)).toBe(1);
		expect(out).toEqual(["ERR lanes attach: no lane named nope"]);
	});
});
