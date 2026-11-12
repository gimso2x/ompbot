import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OriginRouter, openBotStore, sessionDirFor } from "../src/core/origin";
import { Daemon } from "../src/daemon/daemon";
import {
	CLAIM_GRACE_MS,
	DEFAULT_MAX_LANES,
	LaneCapError,
	LaneInputError,
	LaneManager,
	PROGRESS_INTERVAL_MS,
} from "../src/lanes/manager";
import { buildLaneTools } from "../src/lanes/tools";
import { buildLanePrompt, isReopenCommand, parseLaneTrigger } from "../src/lanes/trigger";
import { type VerifyResult, verifyClaim } from "../src/lanes/verify";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { collectGates } from "../src/ops/gates";
import { redact } from "../src/redact";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import type { Store } from "../src/store/db";
import { makeHome, OWNER, type TestHome, WaitingTransport } from "./helpers/bot-home";
import { registryOf } from "./helpers/channels";
import { git, makeRepo } from "./helpers/git-fixtures";
import { removeRepoAndWorktrees } from "./helpers/lane-harness";

const START = 1_800_000_000_000;
const SHA = "a".repeat(40);

let home: TestHome;
let repos: string[];
let workRepo: string | undefined;

beforeEach(() => {
	home = makeHome("ompbot-lanes-home-");
	repos = [];
	workRepo = undefined;
});

afterEach(() => {
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
});

/** Adds one more commit, as a lane doing real work would. */
function commitMore(repo: string): void {
	writeFileSync(join(repo, `work-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`), "work\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "work");
}

interface Harness {
	manager: LaneManager;
	store: Store;
	transport: WaitingTransport;
	router: OriginRouter;
	drivers: Map<string, FakeOmpDriver>;
	/** Every log line the manager and router wrote. */
	logs: string[];
	advance(ms: number): void;
	/** Resolves once every mailbox call and background verdict the manager started has been handled. */
	settle(): Promise<void>;
	updates(ts: string): string[];
	close(): void;
}

function harness(
	options: {
		maxLanes?: number;
		verify?: (e: never, cwd: string, baseSha?: string, baseBranch?: string) => Promise<VerifyResult>;
		frozen?: () => { since: string; reason: string; by: string } | undefined;
	} = {},
): Harness {
	let now = START;
	const clock = { now: () => now };
	const store = openBotStore(join(home.dir, "ompbot.db"), clock, "Asia/Seoul");
	const transport = new WaitingTransport();
	const sessions = new FakeSessionStore();
	const drivers = new Map<string, FakeOmpDriver>();
	const sessionsRoot = join(home.dir, "sessions");
	const logs: string[] = [];
	const log = createLogger({ sink: (line) => logs.push(line), clock, redact });
	const router = new OriginRouter({
		timezone: "Asia/Seoul",
		store,
		clock,
		log,
		sessionsRoot,
		statusProvider: () => "",
		driverFactory: (origin, sessionDir) => {
			const driver = new FakeOmpDriver({ sessionDir, store: sessions, holdTurns: true });
			drivers.set(origin, driver);
			return driver;
		},
	});
	const pending: Promise<unknown>[] = [];
	const manager = new LaneManager({
		timezone: "Asia/Seoul",
		store,
		channels: registryOf(new SlackChannel(transport)),
		clock,
		log,
		sessionsRoot,
		route: (record) => {
			const run = router.route(record);
			pending.push(run);
			return run;
		},
		stopWhenIdle: (origin) => {
			const run = router.mailbox(origin).stopWhenIdle();
			pending.push(run);
			return run;
		},
		pauseTurn: (origin) => {
			const run = router.mailbox(origin).pauseTurn();
			pending.push(run);
			return run;
		},
		resumePending: (origin) => {
			const run = router.mailbox(origin).resumePending();
			pending.push(run);
			return run;
		},
		sessionDirFor: (origin) => sessionDirFor(sessionsRoot, origin, 1),
		...(options.maxLanes === undefined ? {} : { maxLanes: options.maxLanes }),
		...(options.frozen === undefined ? {} : { frozen: options.frozen }),
		...(options.verify === undefined ? {} : { verify: options.verify as never }),
	});
	return {
		manager,
		store,
		transport,
		router,
		drivers,
		logs,
		advance: (ms) => {
			now += ms;
		},
		settle: async () => {
			await Promise.all(pending);
			await manager.settledInBackground();
		},
		updates: (ts) =>
			transport.calls.flatMap((call) => (call.method === "updateMessage" && call.ts === ts ? [call.text] : [])),
		close: () => store.close(),
	};
}

/** One git repository per test for lanes whose claims are judged by a stubbed `verify` (made on first use). */
const cwdOf = (): string => {
	workRepo ??= makeRepo(repos);
	return workRepo;
};

describe("lane trigger parsing", () => {
	test("`작업: <제목> @<절대경로>` with title, path and brief", () => {
		expect(parseLaneTrigger("작업: readme-line @/tmp/x/lane-repo")).toEqual({
			title: "readme-line",
			cwd: "/tmp/x/lane-repo",
			brief: "",
		});
		expect(parseLaneTrigger("  작업:  긴 제목 여러 단어 @/srv/app\nREADME에 한 줄 추가\n그리고 커밋")).toEqual({
			title: "긴 제목 여러 단어",
			cwd: "/srv/app",
			brief: "README에 한 줄 추가\n그리고 커밋",
		});
	});

	test("anything that is not an absolute path is not a trigger", () => {
		expect(parseLaneTrigger("작업: x @relative/path")).toBeUndefined();
		expect(parseLaneTrigger("작업: 경로 없음")).toBeUndefined();
		expect(parseLaneTrigger("안녕 작업: x @/tmp")).toBeUndefined();
	});

	test("the lane prompt starts with the ulw keyword line and names the claim tool", () => {
		const prompt = buildLanePrompt({
			name: "demo",
			title: "Demo",
			cwd: "/tmp/p-l-20261110-01",
			brief: "do it",
			branch: "lane/L-20261110-01",
			baseBranch: "main",
			acceptance: [{ id: "AC-1", text: 'README 한 줄 [check: command ["bun","test"]]' }],
		});
		expect(prompt.split("\n")[0]).toBe("ulw explore ulw debugging set goal and work");
		expect(prompt).toContain("Demo");
		expect(prompt).toContain("do it");
		expect(prompt).toContain("/tmp/p-l-20261110-01");
		expect(prompt).toContain("lane/L-20261110-01");
		expect(prompt).toContain("AC-1: README 한 줄");
		expect(prompt).toContain("ompbot_claim_done");
		expect(prompt).toContain("ompbot_lane_progress");
	});
});

describe("verifyClaim (real git)", () => {
	test("clean tree and existing commit -> ok with the full sha", async () => {
		const repo = makeRepo(repos);
		const result = await verifyClaim({ repo, commit: "HEAD", summary: "s" }, repo);
		expect(result).toEqual({ ok: true, sha: git(repo, "rev-parse", "HEAD") });
	});

	test("uncommitted changes -> not ok, names the path", async () => {
		const repo = makeRepo(repos);
		writeFileSync(join(repo, "README.md"), "changed\n");
		writeFileSync(join(repo, "new.txt"), "x\n");
		const result = await verifyClaim({ repo, commit: "HEAD", summary: "s" }, repo);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reasons.join("\n")).toContain("uncommitted changes");
		expect(result.reasons.join("\n")).toContain("README.md");
		expect(result.reasons.join("\n")).toContain("new.txt");
	});

	test("a commit that does not exist, a non-commit argument, a foreign or relative repo are all refused", async () => {
		const repo = makeRepo(repos);
		const missing = await verifyClaim({ repo, commit: "deadbeef".repeat(5), summary: "s" }, repo);
		expect(missing.ok === false && missing.reasons.join()).toContain("does not exist");
		const option = await verifyClaim({ repo, commit: "--upload-pack=x", summary: "s" }, repo);
		expect(option.ok === false && option.reasons.join()).toContain("not a valid commit id");
		const other = makeRepo(repos);
		const foreign = await verifyClaim({ repo: other, commit: "HEAD", summary: "s" }, repo);
		expect(foreign.ok === false && foreign.reasons.join()).toContain("repo_mismatch");
		const relative = await verifyClaim({ repo: "lane-repo", commit: "HEAD", summary: "s" }, repo);
		expect(relative.ok === false && relative.reasons.join()).toContain("absolute");
	});

	test("both failures are reported together", async () => {
		const repo = makeRepo(repos);
		writeFileSync(join(repo, "dirty.txt"), "x\n");
		const result = await verifyClaim({ repo, commit: "f".repeat(40), summary: "s" }, repo);
		expect(result.ok === false && result.reasons).toHaveLength(2);
	});

	test("a nested repository under the lane cwd cannot stand in for the project, even with the outer tree dirty", async () => {
		const repo = makeRepo(repos);
		const base = git(repo, "rev-parse", "HEAD");
		const nested = join(repo, "nested");
		mkdirSync(nested);
		git(nested, "init", "-q");
		git(nested, "commit", "-q", "--allow-empty", "-m", "nested");
		writeFileSync(join(repo, "dirty.txt"), "x\n");
		const result = await verifyClaim({ repo: nested, commit: "HEAD", summary: "s" }, repo, base);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reasons.join()).toContain("repo_mismatch");
	});

	test("a claim naming a repository above the lane cwd is refused, and a cwd outside any repository never verifies", async () => {
		const outer = makeRepo(repos);
		const inner = join(outer, "inner");
		mkdirSync(inner);
		git(inner, "init", "-q");
		git(inner, "commit", "-q", "--allow-empty", "-m", "inner");
		const above = await verifyClaim({ repo: outer, commit: "HEAD", summary: "s" }, inner);
		expect(above.ok === false && above.reasons.join()).toContain("repo_mismatch");
		const bare = realpathSync(mkdtempSync(join(tmpdir(), "ompbot-lanes-repo-")));
		repos.push(bare);
		const outside = await verifyClaim({ repo: outer, commit: "HEAD", summary: "s" }, bare);
		expect(outside.ok === false && outside.reasons.join()).toContain("not inside a git repository");
	});

	test("a subdirectory of the lane's repository is the same repository", async () => {
		const repo = makeRepo(repos);
		const sub = join(repo, "pkg");
		mkdirSync(sub);
		const result = await verifyClaim({ repo: sub, commit: "HEAD", summary: "s" }, repo);
		expect(result).toEqual({ ok: true, sha: git(repo, "rev-parse", "HEAD") });
	});

	test("the starting commit is not new work (no_new_commit); a newer commit passes; an unrelated history does not", async () => {
		const repo = makeRepo(repos);
		const base = git(repo, "rev-parse", "HEAD");
		for (const commit of ["HEAD", base]) {
			const same = await verifyClaim({ repo, commit, summary: "s" }, repo, base);
			expect(same.ok === false && same.reasons.join()).toContain("no_new_commit");
		}
		commitMore(repo);
		const head = git(repo, "rev-parse", "HEAD");
		expect(await verifyClaim({ repo, commit: "HEAD", summary: "s" }, repo, base)).toEqual({ ok: true, sha: head });
		const old = await verifyClaim({ repo, commit: base, summary: "s" }, repo, base);
		expect(old.ok === false && old.reasons.join()).toContain("no_new_commit");
		git(repo, "checkout", "-q", "--orphan", "other");
		git(repo, "commit", "-q", "--allow-empty", "-m", "unrelated");
		const unrelated = await verifyClaim({ repo, commit: "HEAD", summary: "s" }, repo, base);
		expect(unrelated.ok === false && unrelated.reasons.join()).toContain("no_new_commit");
	});

	/** A repository on branch `lane` with claim commit `first` on it, while the base branch moved on by one commit. */
	function reopenedLane(): { repo: string; base: string; first: string } {
		const repo = makeRepo(repos);
		const base = git(repo, "symbolic-ref", "--short", "HEAD");
		git(repo, "checkout", "-q", "-b", "lane");
		writeFileSync(join(repo, "lane.txt"), "lane\n");
		git(repo, "add", "lane.txt");
		git(repo, "commit", "-q", "-m", "lane work");
		const first = git(repo, "rev-parse", "HEAD");
		git(repo, "checkout", "-q", base);
		writeFileSync(join(repo, "base.txt"), "base\n");
		git(repo, "add", "base.txt");
		git(repo, "commit", "-q", "-m", "base moved");
		git(repo, "checkout", "-q", "lane");
		return { repo, base, first };
	}

	test("AC-1: rebased onto the base branch after !reopen (no longer descends from the earlier claim): passes with work above the base, no_new_commit without", async () => {
		const { repo, base, first } = reopenedLane();
		git(repo, "rebase", "-q", base);
		const rebased = git(repo, "rev-parse", "HEAD");
		const claim = { repo, commit: "HEAD", summary: "s" };
		expect(await verifyClaim(claim, repo, first, base)).toEqual({ ok: true, sha: rebased });
		// Without the base branch the rule is as before.
		const old = await verifyClaim(claim, repo, first);
		expect(old.ok === false && old.reasons.join()).toContain("does not descend");
		// The rebase dropped the work (the branch sits on the base): no new commit above it.
		git(repo, "reset", "-q", "--hard", base);
		const empty = await verifyClaim(claim, repo, first, base);
		expect(empty.ok === false && empty.reasons.join()).toContain("no_new_commit");
		// A base branch that cannot be read cannot judge the rebase: refused as before, and the reason says so.
		git(repo, "reset", "-q", "--hard", rebased);
		const unread = await verifyClaim(claim, repo, first, "no-such-branch");
		expect(unread.ok === false && unread.reasons.join()).toContain("could not be read to judge a rebase");
	});

	test("AC-1b: a claim that is an ancestor of the base branch (the base merged in, no work) is no_new_commit though it descends from baseSha", async () => {
		const { repo, base, first } = reopenedLane();
		const start = git(repo, "rev-parse", `${first}~1`);
		git(repo, "reset", "-q", "--hard", start);
		git(repo, "merge", "-q", "--ff-only", base);
		const claim = { repo, commit: "HEAD", summary: "s" };
		const merged = await verifyClaim(claim, repo, start, base);
		expect(merged.ok === false && merged.reasons.join()).toContain(
			`no_new_commit: commit ${git(repo, "rev-parse", base)} is already in ${base}`,
		);
		// Without the base branch it would have passed: the merge descends from the starting commit.
		expect((await verifyClaim(claim, repo, start)).ok).toBe(true);
		// Work on top of the merged base passes.
		commitMore(repo);
		expect((await verifyClaim(claim, repo, start, base)).ok).toBe(true);
	});
});

describe("lane start and registry", () => {
	test("a frozen bot refuses to start a lane (no thread, no row) and starts again after unfreeze", async () => {
		const state: { value: { since: string; reason: string; by: string } | undefined } = {
			value: { since: "2026-10-30T01:00:00.000Z", reason: "점검", by: "cli" },
		};
		const h = harness({ frozen: () => state.value });
		await expect(h.manager.start({ title: "Demo task", cwd: cwdOf(), channel: "D1" })).rejects.toThrow(/동결/);
		expect(h.transport.posts(() => true)).toHaveLength(0);
		expect(h.store.listLanes()).toHaveLength(0);
		state.value = undefined;
		const lane = await h.manager.start({ title: "Demo task", cwd: cwdOf(), channel: "D1" });
		await h.settle();
		expect(lane.status).toBe("working");
	});

	test("start posts `🔄 title`, a `⏳` status message, a registry row and the ulw first prompt", async () => {
		const h = harness();
		const lane = await h.manager.start({ title: "Demo task", cwd: cwdOf(), brief: "write the thing", channel: "D1" });
		await h.settle();

		const root = h.transport.posts((text) => text === "🔄 Demo task")[0];
		const status = h.transport.posts((text) => text === "⏳ Demo task · 00:00")[0];
		expect(root?.threadTs).toBeUndefined();
		expect(status?.threadTs).toBe(root?.ts);
		expect(lane).toMatchObject({
			name: "demo-task",
			title: "Demo task",
			originKey: "ompbot/work/demo-task",
			status: "working",
			threadRef: `D1:${root?.ts}`,
			cwd: lane.meta.worktree,
		});
		expect(lane.meta.worktree).toStartWith(`${cwdOf()}-l-`);
		expect(lane.meta.statusTs).toBe(status?.ts);
		expect(lane.sessionDir).toBe(sessionDirFor(join(home.dir, "sessions"), "ompbot/work/demo-task", 1));
		expect(h.store.getOrigin("ompbot/work/demo-task")?.sessionDir).toBe(lane.sessionDir);
		const prompt = h.drivers.get("ompbot/work/demo-task")?.calls.find((call) => call.startsWith("prompt:")) ?? "";
		expect(prompt.startsWith("prompt:ulw explore ulw debugging set goal and work\n")).toBe(true);
		expect(prompt).toContain("Demo task");
		expect(prompt).toContain("write the thing");
		h.close();
	});

	test("two lanes get separate origins and session dirs; equal titles get a numbered name", async () => {
		const h = harness();
		const a = await h.manager.start({ title: "same", cwd: makeRepo(repos), channel: "D1" });
		const b = await h.manager.start({ title: "same", cwd: makeRepo(repos), channel: "D1" });
		await h.settle();
		expect([a.name, b.name]).toEqual(["same", "same-2"]);
		expect(a.sessionDir).not.toBe(b.sessionDir);
		expect(a.threadRef).not.toBe(b.threadRef);
		h.close();
	});

	test("bad input is refused with a message and creates nothing", async () => {
		const h = harness();
		await expect(h.manager.start({ title: "  ", cwd: cwdOf(), channel: "D1" })).rejects.toBeInstanceOf(LaneInputError);
		await expect(h.manager.start({ title: "x", cwd: "relative", channel: "D1" })).rejects.toThrow("절대경로");
		await expect(h.manager.start({ title: "x", cwd: join(home.dir, "nope"), channel: "D1" })).rejects.toThrow(
			"없습니다",
		);
		expect(h.store.listLanes()).toEqual([]);
		expect(h.transport.posts()).toEqual([]);
		h.close();
	});

	test("registry transitions are validated", async () => {
		const h = harness();
		const lane = await h.manager.start({ title: "t", cwd: cwdOf(), channel: "D1" });
		await h.settle();
		expect(() => h.store.transitionLane(lane.name, "closed", { event: "x" })).toThrow("invalid_transition");
		h.store.transitionLane(lane.name, "done-claimed", { event: "claim" });
		h.store.transitionLane(lane.name, "closed", { event: "closed", sha: SHA });
		expect(() => h.store.transitionLane(lane.name, "done-claimed", { event: "x" })).toThrow("invalid_transition");
		expect(() => h.store.transitionLane(lane.name, "not-done", { event: "x" })).toThrow("invalid_transition");
		h.store.transitionLane(lane.name, "working", { event: "reopened" });
		expect(h.store.getLane(lane.name)?.history.map((entry) => entry.event)).toEqual([
			"created",
			"claim",
			"closed",
			"reopened",
		]);
		h.close();
	});
});

describe("concurrent lane cap", () => {
	test("the default cap is 4: the fifth start is refused with a clear message", async () => {
		expect(DEFAULT_MAX_LANES).toBe(4);
		const h = harness();
		const cwds = [cwdOf(), makeRepo(repos), makeRepo(repos), makeRepo(repos), makeRepo(repos)];
		for (let n = 0; n < 4; n += 1) {
			const cwd = cwds[n];
			if (cwd === undefined) throw new Error("test needs five cwds");
			await h.manager.start({ title: `lane ${n + 1}`, cwd, channel: "D1" });
		}
		const fifth = cwds[4];
		if (fifth === undefined) throw new Error("test needs five cwds");
		const refused = await h.manager.start({ title: "lane 5", cwd: fifth, channel: "D1" }).catch((e: unknown) => e);
		expect(refused).toBeInstanceOf(LaneCapError);
		expect(String((refused as Error).message)).toContain("상한(4개)");
		expect(h.store.listLanes()).toHaveLength(4);
		expect(h.transport.posts((text) => text.includes("lane 5"))).toEqual([]);
		h.close();
	});

	test("simultaneous starts cannot exceed the cap, and a closed lane frees its slot", async () => {
		// Three repositories, so the cap is the only thing that can refuse the third start.
		const reposForStarts = [makeRepo(repos), makeRepo(repos), makeRepo(repos)];
		const h = harness({ maxLanes: 2 });
		const results = await Promise.allSettled(
			reposForStarts.map((repo, n) => h.manager.start({ title: `p${n + 1}`, cwd: repo, channel: "D1" })),
		);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
		expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
		await h.settle();
		const first = h.store.listLanes()[0];
		if (!first) throw new Error("no lane");
		commitMore(first.cwd);
		await h.manager.claimDone(first.originKey, { repo: first.cwd, commit: "HEAD", summary: "s" });
		expect(h.store.getLane(first.name)?.status).toBe("closed");
		await h.manager.start({ title: "after", cwd: first.meta.repo ?? "", channel: "D1" });
		expect(h.store.countOpenLanes()).toBe(2);
		await h.settle();
		h.close();
	});
});

describe("several lanes on one repository (each in its own worktree; no workspace lease)", () => {
	test("a second start on the same repository, and one on its sub path, run beside the first; a parent outside git is refused", async () => {
		const repo = makeRepo(repos);
		mkdirSync(join(repo, "pkg"));
		const h = harness();
		const first = await h.manager.start({ title: "first", cwd: repo, channel: "D1" });
		const second = await h.manager.start({ title: "second", cwd: repo, channel: "D1" });
		const sub = await h.manager.start({ title: "sub", cwd: join(repo, "pkg"), channel: "D1" });
		await h.settle();
		expect(h.store.listLanes().map((lane) => lane.status)).toEqual(["working", "working", "working"]);
		expect(new Set([first.meta.worktree, second.meta.worktree, sub.meta.worktree]).size).toBe(3);
		expect(sub.cwd).toBe(join(sub.meta.worktree ?? "", "pkg"));
		// The temp directory above the repository is not inside any git repository.
		await expect(h.manager.start({ title: "outer", cwd: dirname(repo), channel: "D1" })).rejects.toBeInstanceOf(
			LaneInputError,
		);
		expect(h.store.listLanes()).toHaveLength(3);
		h.close();
	});

	test("two lanes on different repositories run side by side", async () => {
		const h = harness();
		const a = await h.manager.start({ title: "a", cwd: makeRepo(repos), channel: "D1" });
		const b = await h.manager.start({ title: "b", cwd: makeRepo(repos), channel: "D1" });
		await h.settle();
		expect(h.store.listLanes().map((lane) => lane.status)).toEqual(["working", "working"]);
		expect(a.cwd).not.toBe(b.cwd);
		h.close();
	});

	test("two starts racing on the same repository both start, in different worktrees", async () => {
		const repo = makeRepo(repos);
		const h = harness();
		const results = await Promise.allSettled([
			h.manager.start({ title: "r1", cwd: repo, channel: "D1" }),
			h.manager.start({ title: "r2", cwd: repo, channel: "D1" }),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
		const worktrees = h.store.listLanes().map((lane) => lane.meta.worktree);
		expect(new Set(worktrees).size).toBe(2);
		await h.settle();
		h.close();
	});
});

describe("done claims are verified by the core", () => {
	test("clean repo + existing commit: lane closed with the sha, root and status become 🔍 (waiting for its merge), child stops after its turn", async () => {
		const repo = makeRepo(repos);
		const h = harness();
		const lane = await h.manager.start({ title: "readme-line", cwd: repo, channel: "D1" });
		const wt = lane.cwd;
		await h.settle();
		const driver = h.drivers.get(lane.originKey);
		if (!driver) throw new Error("no driver");
		const stopped = Promise.withResolvers<void>();
		driver.onExit(() => stopped.resolve());
		const rootTs = lane.threadRef.slice(lane.threadRef.indexOf(":") + 1);

		commitMore(wt);
		const text = await h.manager.claimDone(lane.originKey, { repo: wt, commit: "HEAD", summary: "added a line" });
		await h.settle();
		const head = git(wt, "rev-parse", "HEAD");
		expect(text).toContain(head);
		const closed = h.store.getLane(lane.name);
		expect(closed?.status).toBe("closed");
		expect(closed?.meta.sha).toBe(head);
		expect(closed?.history.at(-1)).toMatchObject({ event: "closed", sha: head });
		// Closed is not merged yet: ✅ comes with the landing (test/lane-land.test.ts).
		expect(h.updates(rootTs).at(-1)).toBe("🔍 readme-line");
		expect(h.updates(lane.meta.statusTs ?? "").at(-1)).toBe("🔍 readme-line · 머지 대기");
		// The turn that made the claim is still running: the child lives until it has reported.
		expect(h.router.mailbox(lane.originKey).state.driverRunning).toBe(true);
		driver.release();
		await stopped.promise;
		expect(h.router.mailbox(lane.originKey).state.driverRunning).toBe(false);
		h.close();
	});

	test("uncommitted work -> not-done with reasons steered into the lane; root stays 🔄", async () => {
		const repo = makeRepo(repos);
		const h = harness();
		const lane = await h.manager.start({ title: "dirty", cwd: repo, channel: "D1" });
		const wt = lane.cwd;
		await h.settle();
		writeFileSync(join(wt, "README.md"), "hello\nnew line\n");
		const rootTs = lane.threadRef.slice(lane.threadRef.indexOf(":") + 1);

		const text = await h.manager.claimDone(lane.originKey, { repo: wt, commit: "HEAD", summary: "done?" });
		await h.settle();
		expect(text).toContain("[not-done]");
		expect(text).toContain("uncommitted changes");
		const after = h.store.getLane(lane.name);
		expect(after?.status).toBe("not-done");
		expect(after?.history.at(-1)?.event).toBe("not_done");
		expect(after?.history.at(-1)?.detail).toContain("README.md");
		expect(h.updates(rootTs)).not.toContain("✅ dirty");
		const steers = h.drivers.get(lane.originKey)?.calls.filter((call) => call.startsWith("steer:")) ?? [];
		expect(steers).toHaveLength(1);
		expect(steers[0]).toContain("not-done");
		expect(steers[0]).toContain("README.md");
		// Never closes by itself, however long it waits.
		h.advance(CLAIM_GRACE_MS * 10);
		await h.manager.tick();
		expect(h.store.getLane(lane.name)?.status).toBe("not-done");

		// Fixing it and claiming again closes.
		git(wt, "commit", "-q", "-am", "add line");
		await h.manager.claimDone(lane.originKey, { repo: wt, commit: "HEAD", summary: "now committed" });
		expect(h.store.getLane(lane.name)?.status).toBe("closed");
		expect(h.store.getLane(lane.name)?.meta.sha).toBe(git(wt, "rev-parse", "HEAD"));
		h.close();
	});

	test("frozen: a not-done verdict is not steered into the running lane (lane_send_held_frozen); after unfreeze the next one is", async () => {
		const repo = makeRepo(repos);
		const state: { value: { since: string; reason: string; by: string } | undefined } = { value: undefined };
		const h = harness({ frozen: () => state.value });
		const lane = await h.manager.start({ title: "held", cwd: repo, channel: "D1" });
		const wt = lane.cwd;
		await h.settle();
		writeFileSync(join(wt, "README.md"), "hello\nnew line\n");
		const steers = () => h.drivers.get(lane.originKey)?.calls.filter((call) => call.startsWith("steer:")) ?? [];

		state.value = { since: "2026-10-30T01:00:00.000Z", reason: "점검", by: "cli" };
		expect(await h.manager.claimDone(lane.originKey, { repo: wt, commit: "HEAD", summary: "done?" })).toContain(
			"[not-done]",
		);
		await h.settle();
		expect(steers()).toHaveLength(0);
		expect(h.logs.some((line) => line.includes("event=lane_send_held_frozen") && line.includes("lane=held"))).toBe(
			true,
		);
		expect(h.store.getLane(lane.name)?.status).toBe("not-done");

		state.value = undefined;
		await h.manager.claimDone(lane.originKey, { repo: wt, commit: "HEAD", summary: "done now?" });
		await h.settle();
		expect(steers()).toHaveLength(1);
		expect(steers()[0]).toContain("not-done");
		h.close();
	});

	test("frozen: the core's deferred claim verdict waits out the freeze, then steers once after unfreeze", async () => {
		const state: { value: { since: string; reason: string; by: string } | undefined } = { value: undefined };
		let verifyCalls = 0;
		const verify = async (): Promise<VerifyResult> => {
			verifyCalls += 1;
			if (verifyCalls === 1) throw new Error("git busy");
			return { ok: false, reasons: ["uncommitted changes: README.md"] };
		};
		const h = harness({ frozen: () => state.value, verify });
		const lane = await h.manager.start({ title: "graced", cwd: cwdOf(), channel: "D1" });
		await h.settle();
		const steers = () => h.drivers.get(lane.originKey)?.calls.filter((call) => call.startsWith("steer:")) ?? [];

		// The first check cannot run: the claim stays pending for the core's later verdict.
		expect(await h.manager.claimDone(lane.originKey, { repo: cwdOf(), commit: "HEAD", summary: "done?" })).toContain(
			"검증을 지금 끝내지 못했습니다",
		);
		state.value = { since: "2026-10-30T01:00:00.000Z", reason: "점검", by: "cli" };
		h.advance(CLAIM_GRACE_MS);
		await h.manager.tick();
		await h.settle();
		expect(verifyCalls).toBe(1);
		expect(h.store.getLane(lane.name)?.status).toBe("done-claimed");
		expect(steers()).toHaveLength(0);

		state.value = undefined;
		await h.manager.tick();
		await h.settle();
		expect(verifyCalls).toBe(2);
		expect(h.store.getLane(lane.name)?.status).toBe("not-done");
		expect(steers()).toHaveLength(1);
		expect(steers()[0]).toContain("uncommitted changes");
		h.close();
	});

	test("frozen while the core's deferred verify runs: the claim stays pending and unfreeze still steers (R4)", async () => {
		const state: { value: { since: string; reason: string; by: string } | undefined } = { value: undefined };
		let verifyCalls = 0;
		const verify = async (): Promise<VerifyResult> => {
			verifyCalls += 1;
			if (verifyCalls === 1) throw new Error("git busy");
			// The freeze lands while git runs for the tick's verdict.
			if (verifyCalls === 2) state.value = { since: "2026-10-30T01:00:00.000Z", reason: "점검", by: "cli" };
			return { ok: false, reasons: ["uncommitted changes: README.md"] };
		};
		const h = harness({ frozen: () => state.value, verify });
		const lane = await h.manager.start({ title: "midfreeze", cwd: cwdOf(), channel: "D1" });
		await h.settle();
		const steers = () => h.drivers.get(lane.originKey)?.calls.filter((call) => call.startsWith("steer:")) ?? [];
		await h.manager.claimDone(lane.originKey, { repo: cwdOf(), commit: "HEAD", summary: "done?" });

		h.advance(CLAIM_GRACE_MS);
		await h.manager.tick();
		await h.settle();
		expect(verifyCalls).toBe(2);
		expect(h.store.getLane(lane.name)?.status).toBe("done-claimed");
		expect(steers()).toHaveLength(0);

		state.value = undefined;
		await h.manager.tick();
		await h.settle();
		expect(verifyCalls).toBe(3);
		expect(h.store.getLane(lane.name)?.status).toBe("not-done");
		expect(steers()).toHaveLength(1);
		h.close();
	});

	test("a claimed commit that does not exist is not-done", async () => {
		const repo = makeRepo(repos);
		const h = harness();
		const lane = await h.manager.start({ title: "ghost", cwd: repo, channel: "D1" });
		const wt = lane.cwd;
		await h.settle();
		const text = await h.manager.claimDone(lane.originKey, { repo: wt, commit: "1234567", summary: "s" });
		expect(text).toContain("does not exist");
		expect(h.store.getLane(lane.name)?.status).toBe("not-done");
		h.close();
	});

	test("the lane records its starting commit; claiming it again is not-done (no_new_commit) until work is committed", async () => {
		const repo = makeRepo(repos);
		const base = git(repo, "rev-parse", "HEAD");
		const h = harness();
		const lane = await h.manager.start({ title: "no-op", cwd: repo, channel: "D1" });
		const wt = lane.cwd;
		await h.settle();
		expect(h.store.getLane(lane.name)?.meta.baseSha).toBe(base);
		const text = await h.manager.claimDone(lane.originKey, { repo: wt, commit: "HEAD", summary: "nothing" });
		expect(text).toContain("no_new_commit");
		expect(h.store.getLane(lane.name)?.status).toBe("not-done");
		commitMore(wt);
		await h.manager.claimDone(lane.originKey, { repo: wt, commit: "HEAD", summary: "now real" });
		expect(h.store.getLane(lane.name)?.status).toBe("closed");
		h.close();
	});

	test("5-minute rule (fake clock): a claim whose check could not run is judged after 5 minutes and closes only if it passes", async () => {
		let calls = 0;
		const h = harness({
			verify: async () => {
				calls += 1;
				if (calls === 1) throw new Error("git unavailable");
				return { ok: true, sha: SHA };
			},
		});
		const lane = await h.manager.start({ title: "slow", cwd: cwdOf(), channel: "D1" });
		await h.settle();
		const text = await h.manager.claimDone(lane.originKey, { repo: cwdOf(), commit: "HEAD", summary: "s" });
		expect(text).toContain("5분");
		expect(h.store.getLane(lane.name)?.status).toBe("done-claimed");

		h.advance(CLAIM_GRACE_MS - 1);
		await h.manager.tick();
		await h.manager.settledInBackground();
		expect(calls).toBe(1);
		expect(h.store.getLane(lane.name)?.status).toBe("done-claimed");

		h.advance(1);
		await h.manager.tick();
		await h.manager.settledInBackground();
		expect(calls).toBe(2);
		expect(h.store.getLane(lane.name)).toMatchObject({ status: "closed", meta: { sha: SHA } });
		h.close();
	});

	test("5-minute rule: when the late check fails the lane becomes not-done, never closed", async () => {
		let calls = 0;
		const h = harness({
			verify: async () => {
				calls += 1;
				if (calls === 1) throw new Error("git unavailable");
				return { ok: false, reasons: ["uncommitted changes in /x (1 path): a.txt"] };
			},
		});
		const lane = await h.manager.start({ title: "late-fail", cwd: cwdOf(), channel: "D1" });
		await h.settle();
		await h.manager.claimDone(lane.originKey, { repo: cwdOf(), commit: "HEAD", summary: "s" });
		h.advance(CLAIM_GRACE_MS);
		await h.manager.tick();
		await h.settle();
		expect(h.store.getLane(lane.name)?.status).toBe("not-done");
		expect(
			h.drivers.get(lane.originKey)?.calls.some((call) => call.startsWith("steer:") && call.includes("a.txt")),
		).toBe(true);
		h.close();
	});

	test("an owner message answers a pending claim: it does not auto-close afterwards", async () => {
		let calls = 0;
		const h = harness({
			verify: async () => {
				calls += 1;
				if (calls === 1) throw new Error("git unavailable");
				return { ok: true, sha: SHA };
			},
		});
		const lane = await h.manager.start({ title: "answered", cwd: cwdOf(), channel: "D1" });
		await h.settle();
		await h.manager.claimDone(lane.originKey, { repo: cwdOf(), commit: "HEAD", summary: "s" });
		const pending = h.store.getLane(lane.name);
		if (!pending) throw new Error("no lane");
		h.manager.onOwnerMessage(pending);
		expect(h.store.getLane(lane.name)?.status).toBe("working");
		h.advance(CLAIM_GRACE_MS * 2);
		await h.manager.tick();
		expect(calls).toBe(1);
		expect(h.store.getLane(lane.name)?.status).toBe("working");
		h.close();
	});

	test("lane host tools: claim_done and lane_progress run through the manager; input is validated", async () => {
		const repo = makeRepo(repos);
		const h = harness();
		const lane = await h.manager.start({ title: "tools", cwd: repo, channel: "D1" });
		const wt = lane.cwd;
		await h.settle();
		const tools = buildLaneTools(h.manager, lane.originKey);
		expect(tools.map((tool) => tool.name)).toEqual(["ompbot_lane_progress", "ompbot_claim_done"]);
		const signal = new AbortController().signal;
		const [progress, claim] = tools;
		await expect(claim?.execute({ repo: wt }, { signal })).rejects.toThrow("commit is required");
		expect(await progress?.execute({ text: "tests written" }, { signal })).toBe("progress recorded");
		commitMore(wt);
		expect(await claim?.execute({ repo: wt, commit: "HEAD", summary: "s" }, { signal })).toContain("검증 통과");
		h.close();
	});
});

describe("closed lane follow-up: a question keeps it closed, `!reopen` reopens", () => {
	async function closedLane(h: Harness, repo: string) {
		const lane = await h.manager.start({ title: "followup", cwd: repo, channel: "D1" });
		const wt = lane.cwd;
		await h.settle();
		commitMore(wt);
		expect(await h.manager.claimDone(lane.originKey, { repo: wt, commit: "HEAD", summary: "s" })).toContain(
			"검증 통과",
		);
		const closed = h.store.getLane(lane.name);
		if (closed?.status !== "closed") throw new Error("lane did not close");
		return closed;
	}

	test("`!reopen` is the whole first word only", () => {
		expect(isReopenCommand("!reopen")).toBe(true);
		expect(isReopenCommand("  !reopen 고쳐줘  ")).toBe(true);
		expect(isReopenCommand("!reopen\n고쳐줘")).toBe(true);
		expect(isReopenCommand("!reopened")).toBe(false);
		expect(isReopenCommand("이것도 !reopen 해줘")).toBe(false);
		expect(isReopenCommand("왜 이렇게 했어?")).toBe(false);
	});

	test("an owner question in a closed lane records owner_question and leaves the lane closed", async () => {
		const repo = makeRepo(repos);
		const h = harness();
		const closed = await closedLane(h, repo);
		h.manager.onOwnerMessage(closed, "이 커밋에서 왜 README를 바꿨어?");
		const after = h.store.getLane(closed.name);
		expect(after?.status).toBe("closed");
		expect(after?.history.at(-1)?.event).toBe("owner_question");
		expect(after?.history.map((entry) => entry.event)).not.toContain("reopened");
		expect(after?.meta.sha).toBe(closed.meta.sha);
		await h.settle();
		h.close();
	});

	test("`!reopen <지시>` reopens from the closing sha; only a new commit and claim_done close it again", async () => {
		const repo = makeRepo(repos);
		const h = harness();
		const closed = await closedLane(h, repo);
		const wt = closed.cwd;
		const closedSha = closed.meta.sha;
		h.manager.onOwnerMessage(closed, "!reopen 고쳐줘");
		const reopened = h.store.getLane(closed.name);
		expect(reopened?.status).toBe("working");
		expect(reopened?.history.at(-1)?.event).toBe("reopened");
		expect(reopened?.meta.baseSha).toBe(closedSha);
		// The usual check still applies: no commit after the closing sha is not done.
		expect(await h.manager.claimDone(closed.originKey, { repo: wt, commit: "HEAD", summary: "s" })).toContain(
			"[not-done]",
		);
		expect(h.store.getLane(closed.name)?.status).toBe("not-done");
		commitMore(wt);
		expect(await h.manager.claimDone(closed.originKey, { repo: wt, commit: "HEAD", summary: "s" })).toContain(
			"검증 통과",
		);
		const again = h.store.getLane(closed.name);
		expect(again?.status).toBe("closed");
		expect(again?.meta.sha).toBe(git(wt, "rev-parse", "HEAD"));
		expect(again?.meta.sha).not.toBe(closedSha);
		await h.settle();
		h.close();
	});

	test("on a closed lane, claim_done and lane_progress change nothing and point to `!reopen`", async () => {
		const repo = makeRepo(repos);
		const h = harness();
		const closed = await closedLane(h, repo);
		const wt = closed.cwd;
		const [progress, claim] = buildLaneTools(h.manager, closed.originKey);
		const signal = new AbortController().signal;
		expect(await progress?.execute({ text: "more work" }, { signal })).toContain("!reopen");
		commitMore(wt);
		expect(await claim?.execute({ repo: wt, commit: "HEAD", summary: "s" }, { signal })).toContain("!reopen");
		const after = h.store.getLane(closed.name);
		expect(after?.status).toBe("closed");
		expect(after?.history).toEqual(closed.history);
		expect(after?.meta.sha).toBe(closed.meta.sha);
		await h.settle();
		h.close();
	});
});

describe("status message cadence", () => {
	test("⏳ title · mm:ss is edited in place at most every 15 minutes; a milestone edits at once", async () => {
		const h = harness();
		const lane = await h.manager.start({ title: "cadence", cwd: cwdOf(), channel: "D1" });
		await h.settle();
		const statusTs = lane.meta.statusTs ?? "";

		h.advance(PROGRESS_INTERVAL_MS - 1000);
		await h.manager.tick();
		expect(h.updates(statusTs)).toEqual([]);

		h.advance(1000);
		await h.manager.tick();
		expect(h.updates(statusTs)).toEqual(["⏳ cadence · 15:00"]);
		await h.manager.tick();
		expect(h.updates(statusTs)).toHaveLength(1);

		h.advance(60_000);
		await h.manager.progress(lane.originKey, "tests green");
		expect(h.updates(statusTs).at(-1)).toBe("⏳ cadence · 16:00\n↳ tests green");
		expect(h.store.getLane(lane.name)?.history.at(-1)).toMatchObject({ event: "progress", detail: "tests green" });
		// the milestone restarted the 15-minute window
		h.advance(PROGRESS_INTERVAL_MS - 1000);
		await h.manager.tick();
		expect(h.updates(statusTs)).toHaveLength(2);
		h.close();
	});

	test("a failed Slack edit is retried by the next tick", async () => {
		const repo = makeRepo(repos);
		const h = harness();
		const lane = await h.manager.start({ title: "retry", cwd: repo, channel: "D1" });
		const wt = lane.cwd;
		await h.settle();
		const rootTs = lane.threadRef.slice(lane.threadRef.indexOf(":") + 1);
		h.transport.failNext.updateMessage = [new Error("slack down")];
		commitMore(wt);
		await h.manager.claimDone(lane.originKey, { repo: wt, commit: "HEAD", summary: "s" });
		expect(h.store.getLane(lane.name)?.status).toBe("closed");
		expect(h.store.getLane(lane.name)?.meta.renderedRoot).toBe("🔄 retry");
		await h.manager.tick();
		expect(h.store.getLane(lane.name)?.meta.renderedRoot).toBe("🔍 retry");
		expect(h.updates(rootTs).at(-1)).toBe("🔍 retry");
		h.close();
	});
});

describe("lanes inside the daemon", () => {
	let daemons: Daemon[];
	let drivers: Map<string, FakeOmpDriver>;
	let transport: WaitingTransport;
	let sessions: FakeSessionStore;

	beforeEach(() => {
		daemons = [];
		drivers = new Map();
		transport = new WaitingTransport();
		sessions = new FakeSessionStore();
	});

	afterEach(async () => {
		for (const daemon of daemons) await daemon.stop();
	});

	async function startDaemon(maxLanes?: number): Promise<Daemon> {
		const clock = { now: () => Date.now() };
		const daemon = new Daemon({
			config: home.config,
			channels: [new SlackBinding(new SlackChannel(transport))],
			log: createLogger({ sink: () => undefined, clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			driverFactory: (origin, sessionDir) => {
				const driver = new FakeOmpDriver({ sessionDir, store: sessions });
				drivers.set(origin, driver);
				return driver;
			},
			...(maxLanes === undefined ? {} : { maxLanes }),
		});
		daemons.push(daemon);
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

	test("`작업: <제목> @<경로>` opens a lane thread; thread messages go to the lane's origin; closing and reopening", async () => {
		const repo = makeRepo(repos);
		const daemon = await startDaemon();
		await daemon.inject({ origin: "slack/dm/D1", asOwner: true, text: `작업: demo @${repo}\nREADME에 한 줄 추가` });
		await transport.waitForPosts((text) => text.includes("작업 레인 `demo`을 시작했습니다"));

		const lane = daemon.store.getLane("demo");
		const wt = lane?.meta.worktree ?? "";
		expect(wt).toStartWith(`${repo}-l-`);
		expect(lane).toMatchObject({ status: "working", originKey: "ompbot/work/demo", cwd: wt });
		const root = transport.posts((text) => text === "🔄 demo")[0];
		expect(lane?.threadRef).toBe(`D1:${root?.ts}`);
		// The lane's own omp session got the ulw prompt; the DM conversation's session never saw the trigger text.
		await transport.waitForPosts((text) => text.startsWith("ECHO ulw explore ulw debugging"));
		expect(drivers.get("ompbot/work/demo")?.calls[1]).toContain("README에 한 줄 추가");
		expect(drivers.has("slack/dm/D1")).toBe(false);
		expect(daemon.cwdFor("ompbot/work/demo")).toBe(wt);
		expect(daemon.cwdFor("slack/dm/D1")).toBe(home.config.workspaceDir);

		// Owner message in the lane thread -> lane origin.
		await ownerMessage("keep going", "1900000000.000100", root?.ts ?? "");
		await transport.waitForPosts((text) => text === "ECHO keep going");
		expect(daemon.store.getInbound("D1:1900000000.000100")).toMatchObject({
			originKey: "ompbot/work/demo",
			state: "answered",
		});
		expect(drivers.get("ompbot/work/demo")?.calls).toContain("prompt:keep going");
		expect(drivers.has("slack/dm/D1")).toBe(false);

		// Lane tools exist for the lane origin only; DM origin gets ompbot_work_start.
		const laneTools = daemon.hostToolsFor("ompbot/work/demo").map((tool) => tool.name);
		expect(laneTools).toEqual([
			"slack_send_file",
			"ompbot_request_approval",
			"ompbot_lane_progress",
			"ompbot_claim_done",
		]);
		expect(daemon.hostToolsFor("slack/dm/D1").map((tool) => tool.name)).toContain("ompbot_work_start");
		expect(laneTools).not.toContain("ompbot_work_start");

		// A claim with a clean commit closes the lane through the tool.
		const claim = daemon.hostToolsFor("ompbot/work/demo").find((tool) => tool.name === "ompbot_claim_done");
		const signal = new AbortController().signal;
		commitMore(wt);
		expect(await claim?.execute({ repo: wt, commit: "HEAD", summary: "done" }, { signal })).toContain("검증 통과");
		expect(daemon.store.getLane("demo")?.status).toBe("closed");
		const rootUpdates = () =>
			transport.calls.flatMap((c) => (c.method === "updateMessage" && c.ts === root?.ts ? [c.text] : []));
		expect(rootUpdates().at(-1)).toBe("🔍 demo");

		// `!reopen` in the closed lane's thread reopens it and runs on the same recorded session.
		await ownerMessage("!reopen one more thing", "1900000000.000200", root?.ts ?? "");
		await transport.waitForPosts((text) => text === "ECHO !reopen one more thing");
		expect(daemon.store.getLane("demo")?.status).toBe("working");
		expect(rootUpdates().at(-1)).toBe("🔄 demo");
		expect(daemon.store.getLane("demo")?.history.map((entry) => entry.event)).toContain("reopened");
		expect(drivers.get("ompbot/work/demo")?.calls).toContain("openSession");
		// Lane reports never stamp ✅ on the thread root as a reaction.
		expect(
			transport.calls.filter(
				(c) => c.method === "addReaction" && c.name === "white_check_mark" && c.timestamp === root?.ts,
			),
		).toEqual([]);
	});

	test("a question in a closed lane's thread is a lane-session turn with the closed notice; the lane stays closed and never gates", async () => {
		const repo = makeRepo(repos);
		const daemon = await startDaemon();
		await daemon.inject({ origin: "slack/dm/D1", asOwner: true, text: `작업: ask @${repo}` });
		await transport.waitForPosts((text) => text.startsWith("ECHO ulw explore"));
		const root = transport.posts((text) => text === "🔄 ask")[0];
		const claim = daemon.hostToolsFor("ompbot/work/ask").find((tool) => tool.name === "ompbot_claim_done");
		const wt = daemon.store.getLane("ask")?.cwd ?? "";
		commitMore(wt);
		const signal = new AbortController().signal;
		expect(await claim?.execute({ repo: wt, commit: "HEAD", summary: "done" }, { signal })).toContain("검증 통과");
		expect(daemon.store.getLane("ask")?.status).toBe("closed");

		await ownerMessage("이거 왜 이렇게 했어?", "1900000000.000400", root?.ts ?? "");
		await transport.waitForPosts((text) => text.startsWith("ECHO") && text.includes("이거 왜 이렇게 했어?"));
		const lane = daemon.store.getLane("ask");
		expect(lane?.status).toBe("closed");
		expect(lane?.history.at(-1)?.event).toBe("owner_question");
		expect(lane?.history.map((entry) => entry.event)).not.toContain("reopened");
		expect(daemon.store.getInbound("D1:1900000000.000400")).toMatchObject({
			originKey: "ompbot/work/ask",
			state: "answered",
		});
		expect(drivers.has("slack/dm/D1")).toBe(false);
		// The lane session is told the lane is closed: answer only, `!reopen` for changes.
		const prompt = drivers.get("ompbot/work/ask")?.calls.find((call) => call.includes("이거 왜 이렇게 했어?"));
		expect(prompt).toContain("!reopen");
		expect(prompt).toContain("closed");
		// A day later nothing is stuck: the lane is closed, not an orphan working lane.
		const stuck = collectGates({ homeDir: home.dir, now: Date.now() + 25 * 3_600_000 }).find(
			(gate) => gate.name === "lanes_stuck",
		);
		expect(stuck?.state).toBe("closed");

		// A chat command in the closed lane's thread still runs as a command, never as a prompt.
		await ownerMessage("!queue", "1900000000.000500", root?.ts ?? "");
		await transport.waitForPosts((text) => text.includes("대기열 비어 있음"));
		expect(daemon.store.getInbound("D1:1900000000.000500")?.textRef).toBe("!queue");
		expect(drivers.get("ompbot/work/ask")?.calls.some((call) => call.includes("!queue"))).toBe(false);
		expect(daemon.store.getLane("ask")?.status).toBe("closed");
	});

	test("the host tool ompbot_work_start starts a lane; the cap refuses further lanes with a clear reply", async () => {
		const repo = makeRepo(repos);
		const daemon = await startDaemon(1);
		const start = daemon.hostToolsFor("slack/dm/D1").find((tool) => tool.name === "ompbot_work_start");
		const signal = new AbortController().signal;
		const started = await start?.execute({ title: "tool lane", cwd: repo, brief: "b" }, { signal });
		expect(started).toContain("lane tool-lane started");
		expect(daemon.store.getLane("tool-lane")?.status).toBe("working");
		await expect(start?.execute({ title: "second", cwd: repo }, { signal })).rejects.toThrow("상한(1개)");

		await daemon.inject({ origin: "slack/dm/D1", asOwner: true, text: `작업: third @${repo}` });
		await transport.waitForPosts(
			(text) => text.includes("작업 레인을 시작하지 못했습니다") && text.includes("상한(1개)"),
		);
		expect(daemon.store.listLanes().map((lane) => lane.name)).toEqual(["tool-lane"]);
	});

	test("a lane thread survives a daemon restart (registry is in the ledger)", async () => {
		const repo = makeRepo(repos);
		const first = await startDaemon();
		await first.inject({ origin: "slack/dm/D1", asOwner: true, text: `작업: persist @${repo}` });
		await transport.waitForPosts((text) => text.includes("작업 레인 `persist`"));
		await transport.waitForPosts((text) => text.startsWith("ECHO ulw explore"));
		const root = transport.posts((text) => text === "🔄 persist")[0];
		await first.stop();

		const second = await startDaemon();
		expect(second.store.getLane("persist")?.status).toBe("working");
		await ownerMessage("after restart", "1900000000.000300", root?.ts ?? "");
		await transport.waitForPosts((text) => text === "ECHO after restart");
		expect(second.store.getInbound("D1:1900000000.000300")?.originKey).toBe("ompbot/work/persist");
	});
});
