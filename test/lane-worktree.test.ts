import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { laneLandBlockers } from "../src/lanes/land";
import { LaneInputError } from "../src/lanes/manager";
import { buildWorkStartTool } from "../src/lanes/tools";
import { createTaskHostOps } from "../src/tasks/host";
import { localDay } from "../src/time";
import { makeHome, type TestHome } from "./helpers/bot-home";
import { git, makeRepo } from "./helpers/git-fixtures";
import { LANE_START, laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

const DAY = localDay(LANE_START, "Asia/Seoul");

let home: TestHome;
let repos: string[];

beforeEach(() => {
	home = makeHome("ompbot-lane-wt-home-");
	repos = [];
});

afterEach(() => {
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
});

/** Lane worktrees git knows for `repo` (the main working tree excluded). */
const laneWorktrees = (repo: string): string[] =>
	git(repo, "worktree", "list", "--porcelain")
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length))
		.filter((path) => path !== repo);

/** Directories beside `repo` named like a lane worktree of it. */
const siblingWorktrees = (repo: string): string[] =>
	readdirSync(dirname(repo)).filter((entry) => entry.startsWith(`${basename(repo)}-l-`));

describe("lane start creates its own worktree and branch (AC-1)", () => {
	test("worktree `<repo>-l-<day>-01`, branch `lane/L-<day>-01`, cwd keeps the sub path, meta records the lane; the live tree is untouched", async () => {
		const repo = makeRepo(repos);
		mkdirSync(join(repo, "pkg"));
		writeFileSync(join(repo, "pkg", "index.ts"), "export {};\n");
		git(repo, "add", "pkg/index.ts");
		git(repo, "commit", "-q", "-m", "pkg");
		// The owner's own uncommitted work in the live checkout must survive the start as it was.
		writeFileSync(join(repo, "scratch.txt"), "owner wip\n");
		writeFileSync(join(repo, "README.md"), "hello\nedited by owner\n");
		const statusBefore = git(repo, "status", "--porcelain");
		const baseBranch = git(repo, "branch", "--show-current");
		const baseSha = git(repo, "rev-parse", "HEAD");

		const h = laneHarness(home.dir);
		const lane = await h.manager.start({ title: "worktree lane", cwd: join(repo, "pkg"), channel: "D1" });
		await h.settle();

		const laneId = `L-${DAY}-01`;
		const worktree = `${repo}-l-${DAY}-01`;
		expect(lane.cwd).toBe(join(worktree, "pkg"));
		expect(existsSync(join(worktree, "pkg", "index.ts"))).toBe(true);
		expect(lane.meta).toMatchObject({
			laneId,
			repo,
			worktree,
			branch: `lane/${laneId}`,
			baseBranch,
			acceptance: [],
			baseSha,
		});
		// No risk named: none is stored, and the lane counts as DEFAULT_LANE_RISK (L3) wherever a risk is compared.
		expect(lane.meta.risk).toBeUndefined();
		expect(h.store.getLane(lane.name)?.meta).toMatchObject({ laneId, worktree, branch: `lane/${laneId}` });
		expect(git(worktree, "branch", "--show-current")).toBe(`lane/${laneId}`);
		expect(git(worktree, "rev-parse", "HEAD")).toBe(baseSha);
		expect(laneWorktrees(repo)).toEqual([worktree]);

		expect(git(repo, "status", "--porcelain")).toBe(statusBefore);
		expect(git(repo, "branch", "--show-current")).toBe(baseBranch);
		expect(git(repo, "rev-parse", "HEAD")).toBe(baseSha);

		const prompt = h.prompts(lane.originKey)[0] ?? "";
		expect(prompt.startsWith("prompt:ulw explore ulw debugging set goal and work\n")).toBe(true);
		expect(prompt).toContain(join(worktree, "pkg"));
		expect(prompt).toContain(`lane/${laneId}`);
		expect(prompt).toContain(baseBranch);
		h.close();
	});
});

describe("lane start refusals and concurrency (AC-2)", () => {
	test("a path outside any git repository is refused: no row, no thread, no worktree", async () => {
		const plain = realpathSync(mkdtempSync(join(tmpdir(), "ompbot-lane-plain-")));
		repos.push(plain);
		const h = laneHarness(home.dir);
		const refused = await h.manager.start({ title: "plain", cwd: plain, channel: "D1" }).catch((e: unknown) => e);
		expect(refused).toBeInstanceOf(LaneInputError);
		expect(String((refused as Error).message)).toContain("git");
		expect(h.store.listLanes()).toHaveLength(0);
		expect(h.transport.posts()).toEqual([]);
		expect(siblingWorktrees(plain)).toEqual([]);
		h.close();
	});

	test("a repository with a detached HEAD is refused: no row, no worktree", async () => {
		const repo = makeRepo(repos);
		git(repo, "checkout", "-q", "--detach");
		const h = laneHarness(home.dir);
		const refused = await h.manager.start({ title: "detached", cwd: repo, channel: "D1" }).catch((e: unknown) => e);
		expect(refused).toBeInstanceOf(LaneInputError);
		expect(String((refused as Error).message)).toContain("HEAD");
		expect(h.store.listLanes()).toHaveLength(0);
		expect(h.transport.posts()).toEqual([]);
		expect(laneWorktrees(repo)).toEqual([]);
		expect(siblingWorktrees(repo)).toEqual([]);
		h.close();
	});

	test("a repository path outside TASK_PATH_PATTERN (space, Hangul) is refused: no row, no worktree", async () => {
		const repo = makeRepo(repos, "ompbot 레인 repo-");
		const h = laneHarness(home.dir);
		const refused = await h.manager.start({ title: "unsafe", cwd: repo, channel: "D1" }).catch((e: unknown) => e);
		expect(refused).toBeInstanceOf(LaneInputError);
		expect(h.store.listLanes()).toHaveLength(0);
		expect(h.transport.posts()).toEqual([]);
		expect(laneWorktrees(repo)).toEqual([]);
		expect(siblingWorktrees(repo)).toEqual([]);
		h.close();
	});

	test("two lanes started at once on one repository both start, each in its own worktree and branch (no lease)", async () => {
		const repo = makeRepo(repos);
		const h = laneHarness(home.dir);
		const [a, b] = await Promise.all([
			h.manager.start({ title: "first", cwd: repo, channel: "D1" }),
			h.manager.start({ title: "second", cwd: repo, channel: "D1" }),
		]);
		await h.settle();
		expect(h.store.listLanes().map((lane) => lane.status)).toEqual(["working", "working"]);
		const worktrees = [`${repo}-l-${DAY}-01`, `${repo}-l-${DAY}-02`];
		expect([a.meta.worktree, b.meta.worktree].sort()).toEqual(worktrees);
		expect(a.meta.branch).not.toBe(b.meta.branch);
		expect(a.cwd).not.toBe(b.cwd);
		expect(laneWorktrees(repo).sort()).toEqual(worktrees);
		// A third start on the same repository, while both run, takes the next free id.
		const c = await h.manager.start({ title: "third", cwd: repo, channel: "D1" });
		expect(c.meta.laneId).toBe(`L-${DAY}-03`);
		await h.settle();
		h.close();
	});

	test("a lane id already taken by a `lane/*` branch is skipped", async () => {
		const repo = makeRepo(repos);
		git(repo, "branch", `lane/L-${DAY}-01`);
		const h = laneHarness(home.dir);
		const lane = await h.manager.start({ title: "skip", cwd: repo, channel: "D1" });
		await h.settle();
		expect(lane.meta.laneId).toBe(`L-${DAY}-02`);
		h.close();
	});
});

describe("ompbot_work_start acceptance and risk (AC-3)", () => {
	test("the tool schema offers acceptance and risk", () => {
		const h = laneHarness(home.dir);
		const tool = buildWorkStartTool(h.manager, "D1");
		expect(tool.parameters).toMatchObject({ properties: { acceptance: { type: "array" }, risk: { type: "string" } } });
		h.close();
	});

	test("acceptance items are stored with AC ids and the given risk", async () => {
		const repo = makeRepo(repos);
		const h = laneHarness(home.dir);
		const tool = buildWorkStartTool(h.manager, "D1");
		const signal = new AbortController().signal;
		const reply = await tool.execute(
			{
				title: "accepted",
				cwd: repo,
				risk: "L1",
				acceptance: ['README에 한 줄 [check: command ["bun","run","check"]]', "AC-2: 문서를 고친다"],
			},
			{ signal },
		);
		expect(reply).toContain("lane accepted started");
		expect(h.store.getLane("accepted")?.meta).toMatchObject({
			risk: "L1",
			acceptance: [
				{ id: "AC-1", text: 'README에 한 줄 [check: command ["bun","run","check"]]' },
				{ id: "AC-2", text: "문서를 고친다" },
			],
		});
		await h.settle();
		const prompt = h.prompts("ompbot/work/accepted")[0] ?? "";
		expect(prompt).toContain("AC-1");
		expect(prompt).toContain("문서를 고친다");
		h.close();
	});

	test("omitted: risk L3 and acceptance []", async () => {
		const repo = makeRepo(repos);
		const h = laneHarness(home.dir);
		const tool = buildWorkStartTool(h.manager, "D1");
		await tool.execute({ title: "defaults", cwd: repo }, { signal: new AbortController().signal });
		const lane = h.store.getLane("defaults");
		if (lane === undefined) throw new Error("no lane defaults");
		expect(lane.meta).toMatchObject({ acceptance: [] });
		// Unrated: no risk is stored (lane-review-confidence E), and the auto-merge compares it as L3.
		expect(lane.meta.risk).toBeUndefined();
		expect(laneLandBlockers(lane, { repos: [repo], maxRisk: "L2" }, true, false)).toContain("위험 L3 > L2");
		const atL3 = laneLandBlockers(lane, { repos: [repo], maxRisk: "L3" }, true, false);
		expect(atL3.some((reason) => reason.startsWith("위험"))).toBe(false);
		await h.settle();
		h.close();
	});

	test("a malformed `[check: …]`, an out-of-range risk or a non-list acceptance is refused before anything is created", async () => {
		const repo = makeRepo(repos);
		const h = laneHarness(home.dir);
		const tool = buildWorkStartTool(h.manager, "D1");
		const signal = new AbortController().signal;
		const cases: Record<string, unknown>[] = [
			{ title: "bad-check", cwd: repo, acceptance: ["테스트가 통과한다 [check: bun test]"] },
			{ title: "unclosed", cwd: repo, acceptance: ['열림 [check: command ["true"]'] },
			{ title: "two-checks", cwd: repo, acceptance: ['x [check: command ["true"]] [check: command ["echo","ok"]]'] },
			{ title: "text-after", cwd: repo, acceptance: ['통과 [check: command ["true"]] (근거는 outcome.md)'] },
			{ title: "bad-risk", cwd: repo, risk: "L5" },
			{ title: "numeric-risk", cwd: repo, risk: 2 },
			{ title: "not-list", cwd: repo, acceptance: "README 고치기" },
			{ title: "empty-item", cwd: repo, acceptance: ["  "] },
		];
		for (const params of cases) {
			const refused = await tool.execute(params, { signal }).catch((e: unknown) => e);
			expect(refused, String(params.title)).toBeInstanceOf(LaneInputError);
		}
		expect(h.store.listLanes()).toHaveLength(0);
		expect(h.transport.posts()).toEqual([]);
		expect(laneWorktrees(repo)).toEqual([]);
		h.close();
	});
});

describe("host assertBranch accepts lane branches (AC-7)", () => {
	const okRunner = async () => ({ code: 0, stdout: "", timedOut: false });

	test("`lane/L-20261110-01` passes; `lane/x`, `task/../x`, `lane/L-20261110-01 ;x` are unsafe", async () => {
		const ops = createTaskHostOps({ run: okRunner });
		const input = (branch: string) => ({ repo: "/srv/repo", worktree: "/srv/repo-l-20261110-01", branch });
		expect(await ops.createWorktree(input("lane/L-20261110-01"))).toEqual({ ok: true, value: null });
		await ops.removeWorktree(input("lane/L-20261110-01"));
		expect(await ops.createWorktree(input("task/T-20261110-01"))).toEqual({ ok: true, value: null });
		for (const bad of ["lane/x", "task/../x", "lane/L-20261110-01 ;x"]) {
			await expect(ops.createWorktree(input(bad))).rejects.toThrow("unsafe branch");
			await expect(ops.removeWorktree(input(bad))).rejects.toThrow("unsafe branch");
		}
	});
});
