import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOP_LEVEL_TS } from "../src/core/normalize";
import { Daemon } from "../src/daemon/daemon";
import { dispatchEnv } from "../src/dispatch/omp";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import { SlackCallError } from "../src/slack/transport";
import { acceptanceItems } from "../src/tasks/docs";
import type { TaskRow } from "../src/tasks/ledger";
import { makeHome, type TestHome, WaitingTransport } from "./helpers/bot-home";

const CHANNEL = "C1";
const THREAD = "1700.000100";
const clock = { now: () => Date.now() };

let home: TestHome;
let daemon: Daemon;
let transport: WaitingTransport;
let logs: string[];

beforeEach(async () => {
	home = makeHome("ompbot-autoland-");
	logs = [];
	transport = new WaitingTransport();
	const sessions = new FakeSessionStore();
	daemon = new Daemon({
		config: home.config,
		channels: [new SlackBinding(new SlackChannel(transport))],
		log: createLogger({ sink: (line) => logs.push(line), clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot",
		driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
	});
	await daemon.start();
});

afterEach(async () => {
	await daemon.stop();
	home.remove();
});

/** A [TASK] in review on `repo`, its thread `threadRef`. */
function seedTask(over: { threadRef?: string; repo?: string } = {}): TaskRow {
	const tasks = daemon.store.tasks;
	const row = tasks.register({
		title: "로그 회전",
		risk: "L2",
		originKey: `slack/ch/${CHANNEL}/t/${THREAD}`,
		threadRef: over.threadRef ?? `${CHANNEL}:${THREAD}`,
		host: null,
		repo: over.repo ?? "/r/repo",
		acceptance: acceptanceItems(["하나", "둘"]),
	});
	tasks.transition(row.taskId, "review", "bot");
	return tasks.require(row.taskId);
}

const markers = () => transport.posts((text) => text === "🤖 자동 머지");
const mergeInbounds = () => daemon.store.listInbound().filter((row) => row.textRef.trim().startsWith("머지해"));

describe("daemon repoMatches (git common directory)", () => {
	let root: string;
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], {
			env: dispatchEnv(process.env),
			stdio: "ignore",
		});
	const initRepo = (dir: string) => {
		git("init", "-q", dir);
		git("-C", dir, "commit", "-q", "--allow-empty", "-m", "init");
	};

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "ompbot-autoland-git-"));
		initRepo(join(root, "ompbot"));
		git("-C", join(root, "ompbot"), "worktree", "add", "-q", join(root, "ompbot-t-1"), "-b", "task/T-1");
		initRepo(join(root, "ompbotx"));
		symlinkSync(join(root, "ompbot"), join(root, "ompbot-link"));
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	test("AC-6: another worktree of the same repository matches; a look-alike separate repository does not", async () => {
		const worktree = seedTask({ repo: join(root, "ompbot-t-1") });
		expect(await daemon.repoMatches(worktree, [join(root, "ompbot")])).toBe(true);
		expect(await daemon.repoMatches(worktree, [join(root, "ompbotx"), join(root, "ompbot")])).toBe(true);
		expect(await daemon.repoMatches(worktree, [join(root, "ompbotx")])).toBe(false);
		const lookalike = seedTask({ repo: join(root, "ompbotx") });
		expect(await daemon.repoMatches(lookalike, [join(root, "ompbot")])).toBe(false);
	});

	test("AC-6: a symlinked repos entry matches; a missing or non-git path never does", async () => {
		const worktree = seedTask({ repo: join(root, "ompbot-t-1") });
		expect(await daemon.repoMatches(worktree, [join(root, "ompbot-link")])).toBe(true);
		expect(await daemon.repoMatches(worktree, [join(root, "nowhere")])).toBe(false);
		expect(await daemon.repoMatches(seedTask({ repo: join(root, "nowhere") }), [join(root, "ompbot")])).toBe(false);
		expect(await daemon.repoMatches(seedTask({ repo: root }), [root])).toBe(false);
	});
});

describe("daemon autoLand", () => {
	test("AC-7: puts an owner '머지해 …' into the task thread under the 🤖 자동 머지 marker and answers true", async () => {
		const row = seedTask();
		expect(await daemon.autoLand(row)).toBe(true);
		expect(markers()).toHaveLength(1);
		expect(markers()[0]).toMatchObject({ channel: CHANNEL, threadTs: THREAD });
		const inbound = mergeInbounds();
		expect(inbound).toHaveLength(1);
		expect(inbound[0]).toMatchObject({ threadRef: `${CHANNEL}:${THREAD}` });
	});

	test("AC-7: a top-level or unparsable thread ref puts nothing in and answers false", async () => {
		expect(await daemon.autoLand(seedTask({ threadRef: `${CHANNEL}:${TOP_LEVEL_TS}` }))).toBe(false);
		expect(await daemon.autoLand(seedTask({ threadRef: "not-a-thread" }))).toBe(false);
		expect(markers()).toHaveLength(0);
		expect(mergeInbounds()).toHaveLength(0);
	});

	test("AC-7: a draining daemon puts nothing in and answers false", async () => {
		const row = seedTask();
		daemon.setDraining(true);
		expect(await daemon.autoLand(row)).toBe(false);
		daemon.setDraining(false);
		expect(markers()).toHaveLength(0);
		expect(mergeInbounds()).toHaveLength(0);
	});

	test("AC-7: a second call for a task still in flight answers false; once settled the task is taken again", async () => {
		const row = seedTask();
		const both = await Promise.all([daemon.autoLand(row), daemon.autoLand(row)]);
		expect(both).toEqual([true, false]);
		expect(markers()).toHaveLength(1);
		expect(await daemon.autoLand(row)).toBe(true);
		expect(markers()).toHaveLength(2);
	});

	test("AC-7: a failed attempt (marker post throws) releases the guard: the next call goes in", async () => {
		const row = seedTask();
		transport.failNext.postMessage = [new SlackCallError("definitive", "slack_platform_error:channel_not_found")];
		await expect(daemon.autoLand(row)).rejects.toThrow();
		expect(mergeInbounds()).toHaveLength(0);
		expect(await daemon.autoLand(row)).toBe(true);
		expect(mergeInbounds()).toHaveLength(1);
	});
});
