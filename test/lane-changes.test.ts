import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeLaneChanges } from "../src/lanes/changes";
import type { LaneLandState, LaneRow, LaneStatus } from "../src/lanes/status";
import { defaultGit, type GitRunner } from "../src/lanes/verify";
import { git, makeRepo } from "./helpers/git-fixtures";

// computeLaneChanges (doc/plans/lane-card-changes.md 설계 2): real git repositories in temp directories; the lane
// branches are made in the repository itself (the computation reads refs only, never a worktree).

let repos: string[] = [];

afterEach(() => {
	for (const repo of repos) rmSync(repo, { recursive: true, force: true });
	repos = [];
});

const baseOf = (repo: string): string => git(repo, "symbolic-ref", "--short", "HEAD");

/** Writes `files` (path → content) in `repo` and commits them on the checked-out branch; returns the new HEAD. */
function commit(repo: string, files: Record<string, string | Uint8Array>): string {
	for (const [path, content] of Object.entries(files)) writeFileSync(join(repo, path), content);
	git(repo, "add", "--", ...Object.keys(files));
	git(repo, "commit", "-q", "-m", "change");
	return git(repo, "rev-parse", "HEAD");
}

/** Makes `branch` off `base`, commits `files` on it and returns to `base`; returns the branch tip. */
function branchWith(repo: string, base: string, branch: string, files: Record<string, string | Uint8Array>): string {
	git(repo, "checkout", "-q", "-b", branch, base);
	const tip = commit(repo, files);
	git(repo, "checkout", "-q", base);
	return tip;
}

function laneRow(
	name: string,
	repo: string,
	baseBranch: string,
	over: { sha?: string; status?: LaneStatus; land?: LaneLandState } = {},
): LaneRow {
	return {
		name,
		title: name,
		threadRef: "D1:1.1",
		originKey: `ompbot/work/${name}`,
		cwd: repo,
		sessionDir: "/tmp/none",
		status: over.status ?? "closed",
		history: [],
		meta: {
			startedAt: 0,
			lastProgressAt: 0,
			steerSeq: 0,
			repo,
			branch: `lane/${name}`,
			baseBranch,
			...(over.sha === undefined ? {} : { sha: over.sha }),
			...(over.land === undefined ? {} : { land: { state: over.land, attempts: 0 } }),
		},
		createdAt: 0,
		updatedAt: 0,
	};
}

const lines = (n: number, word = "line"): string => Array.from({ length: n }, (_, i) => `${word} ${i}\n`).join("");
const BINARY = new Uint8Array([0, 1, 2, 3, 0, 255, 0, 7]);

/** A repository whose base holds `old.ts` (3 lines) and a lane `me` changing 3 files: +10 −2, one binary. */
function laneRepo(): { repo: string; base: string; sha: string } {
	const repo = makeRepo(repos, "ompbot-lane-changes-");
	const base = baseOf(repo);
	commit(repo, { "old.ts": "a\nb\nc\n" });
	const sha = branchWith(repo, base, "lane/me", {
		"old.ts": "a\nx\ny\nz\n", // −b −c +x +y +z: +3 −2
		"new.ts": lines(7), // +7
		"image.bin": BINARY,
	});
	return { repo, base, sha };
}

describe("computeLaneChanges", () => {
	test("AC-1: file count, line sums and top (most changed first); the binary counts as a file only", async () => {
		const { repo, base, sha } = laneRepo();
		const changes = await computeLaneChanges(laneRow("me", repo, base, { sha }), []);
		expect(changes).toEqual({
			sha,
			files: 3,
			insertions: 10,
			deletions: 2,
			top: [
				{ path: "new.ts", added: 7, deleted: 0 },
				{ path: "old.ts", added: 3, deleted: 2 },
			],
			overlaps: [],
			baseDrift: [],
		});
	});

	test("AC-2: base drift and overlaps with unmerged lanes of the same repository only", async () => {
		const { repo, base, sha } = laneRepo();
		// The base changes old.ts and README.md after the merge-base: only old.ts is this lane's file too.
		commit(repo, { "old.ts": "a\nb\nc\nd\n", "README.md": "changed\n" });
		branchWith(repo, base, "lane/open", { "new.ts": "other\n", "solo.ts": "x\n" });
		branchWith(repo, base, "lane/held", { "old.ts": "held\n" });
		branchWith(repo, base, "lane/done", { "new.ts": "landed\n" });
		branchWith(repo, base, "lane/gone", { "new.ts": "discarded\n" });
		branchWith(repo, base, "lane/apart", { "solo.ts": "only\n" });
		const elsewhere = makeRepo(repos, "ompbot-lane-changes-other-");
		branchWith(elsewhere, baseOf(elsewhere), "lane/far", { "new.ts": "far\n" });
		const me = laneRow("me", repo, base, { sha });
		const others = [
			me,
			laneRow("open", repo, base, { status: "working" }),
			laneRow("held", repo, base, { status: "closed", land: "blocked" }),
			laneRow("done", repo, base, { status: "closed", land: "landed" }),
			laneRow("gone", repo, base, { status: "closed", land: "discarded" }),
			laneRow("apart", repo, base, { status: "not-done" }),
			laneRow("far", elsewhere, baseOf(elsewhere), { status: "working" }),
			laneRow("nobranch", repo, base, { status: "paused" }),
		];
		const changes = await computeLaneChanges(me, others);
		expect(changes.baseDrift).toEqual(["old.ts"]);
		expect(changes.overlaps).toEqual([
			{ lane: "open", files: ["new.ts"] },
			{ lane: "held", files: ["old.ts"] },
		]);
		expect(changes.overlapError).toBeUndefined();
		expect(changes.files).toBe(3);
	});

	test("AC-3: this lane's own diff failing is `error` without a throw; another lane failing is `overlapError` only", async () => {
		const { repo, base, sha } = laneRepo();
		commit(repo, { "old.ts": "a\nb\nc\nd\n" });
		branchWith(repo, base, "lane/broken", { "new.ts": "broken\n" });
		branchWith(repo, base, "lane/fine", { "new.ts": "fine\n" });
		const me = laneRow("me", repo, base, { sha });
		const failNumstat: GitRunner = (args) =>
			args.includes("--numstat")
				? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: bad object\n" })
				: defaultGit(args);
		const own = await computeLaneChanges(me, [], failNumstat);
		expect(own).toMatchObject({ sha, files: 0, insertions: 0, deletions: 0, top: [], overlaps: [], baseDrift: [] });
		expect(own.error).toContain("diff --numstat 실패");
		const throwing: GitRunner = () => Promise.reject(new Error("git missing"));
		expect((await computeLaneChanges(me, [], throwing)).error).toContain("git missing");

		const failBroken: GitRunner = (args) =>
			args.some((arg) => arg.includes("lane/broken") && arg.includes(".."))
				? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: broken\n" })
				: defaultGit(args);
		const others = [
			laneRow("broken", repo, base, { status: "working" }),
			laneRow("fine", repo, base, { status: "working" }),
		];
		const partial = await computeLaneChanges(me, others, failBroken);
		expect(partial.error).toBeUndefined();
		expect(partial.files).toBe(3);
		expect(partial.top.map((entry) => entry.path)).toEqual(["new.ts", "old.ts"]);
		expect(partial.baseDrift).toEqual(["old.ts"]);
		expect(partial.overlaps).toEqual([{ lane: "fine", files: ["new.ts"] }]);
		expect(partial.overlapError).toContain("레인 broken");
	});

	test("AC-3b: a renamed file reads as a delete and an add even with rename detection configured", async () => {
		const repo = makeRepo(repos, "ompbot-lane-changes-rename-");
		const base = baseOf(repo);
		git(repo, "config", "diff.renames", "copies");
		commit(repo, { "keep.ts": lines(20, "same") });
		git(repo, "checkout", "-q", "-b", "lane/mv", base);
		git(repo, "mv", "keep.ts", "moved.ts");
		const sha = commit(repo, { "moved.ts": `${lines(20, "same")}extra\n` });
		git(repo, "checkout", "-q", base);
		const changes = await computeLaneChanges(laneRow("mv", repo, base, { sha }), []);
		expect(changes.error).toBeUndefined();
		expect(changes).toMatchObject({ files: 2, insertions: 21, deletions: 20 });
		expect(changes.top).toEqual([
			{ path: "moved.ts", added: 21, deleted: 0 },
			{ path: "keep.ts", added: 0, deleted: 20 },
		]);
	});
});
