import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProcessRunner, realProcessRunner } from "../src/dispatch/omp";
import {
	classifyLaneCompletion,
	collectLaneDiff,
	LaneDiffUnavailable,
	laneDiffUnavailableRefusal,
} from "../src/lanes/integrity";
import { gitRunner } from "../src/lanes/verify";
import { taskChangedPaths } from "../src/tasks/sweeper";

const DIFF = (file: string, ...lines: string[]): string =>
	[`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, "@@ -0,0 +1,1 @@", ...lines].join("\n");

function categories(summary: string, diff: string): string[] {
	return classifyLaneCompletion({ summary, diff }).map((refusal) => refusal.category);
}

describe("classifyLaneCompletion", () => {
	test("a clean diff and a claim with a named command pass", () => {
		const diff = DIFF("src/a.ts", "+export const x = 1;");
		expect(categories("bun test 통과, 커밋 완료", diff)).toEqual([]);
	});

	test("TODO markers in added code comments are refused, linked issues exempt", () => {
		expect(categories("done", DIFF("src/a.ts", "+// TODO: later"))).toEqual(["unfinished_work_marker"]);
		expect(categories("done", DIFF("src/a.ts", "+// TODO: later — see #123"))).toEqual([]);
		// Docs paths are exempt entirely.
		expect(categories("done", DIFF("docs/guide.md", "+<!-- TODO: expand -->"))).toEqual([]);
	});

	test("skipped or only-tests are refused", () => {
		expect(categories("done", DIFF("test/a.test.ts", "+test.skip('x', () => {});"))).toEqual(["skipped_test"]);
		expect(categories("done", DIFF("test/a.test.ts", "+it.only('x', () => {});"))).toEqual(["skipped_test"]);
	});

	test("stub bodies are refused", () => {
		expect(categories("done", DIFF("src/a.ts", '+throw new Error("Not implemented");'))).toEqual([
			"stub_implementation",
		]);
	});

	test("guard deletions need an adversarial regression test", () => {
		const removed = DIFF("src/auth.ts", "-if (!allowlist.has(host)) throw new Error('denied');");
		expect(categories("done", removed)).toEqual(["guard_deletion_without_adversarial_regression"]);
		// Re-adding the same line is a move, not a deletion.
		expect(
			categories(
				"done",
				DIFF(
					"src/auth.ts",
					"-if (!allowlist.has(host)) throw new Error('denied');",
					"+if (!allowlist.has(host)) throw new Error('denied');",
				),
			),
		).toEqual([]);
		// A negative-case test added alongside exempts the deletion.
		expect(
			categories(
				"done",
				[
					DIFF("src/auth.ts", "-if (!allowlist.has(host)) throw new Error('denied');"),
					DIFF("test/auth.test.ts", "+test('rejects a foreign host', () => {});"),
				].join("\n"),
			),
		).toEqual([]);
	});

	test("removed `-- x` / added `++ x` lines inside a hunk are not file headers; later lines are still judged (#121)", () => {
		// run-42/scratch/realhdr.diff (`git diff --unified=0` of `-- counter;` -> `++ counter;`) plus one skipped test.
		const diff = [
			"diff --git a/x.ts b/x.ts",
			"index 741c314..38bbba3 100644",
			"--- a/x.ts",
			"+++ b/x.ts",
			"@@ -3 +3,4 @@ let other = 0;",
			"--- counter;",
			"+++ counter;",
			"+// TODO unfinished",
			"+let sk = test.skip;",
			'+test.skip("later", () => {});', // #121 fixture text for the classifier, not a skipped test
		].join("\n");
		expect(categories("done", diff)).toEqual(["unfinished_work_marker", "skipped_test"]);
		// The next file's real header after such a hunk still switches files.
		const next = [diff, "diff --git a/b.md b/b.md", "--- a/b.md", "+++ b/b.md", "@@ -0,0 +1 @@", "+TODO: write"].join(
			"\n",
		);
		expect(categories("done", next)).toEqual(["unfinished_work_marker", "skipped_test"]);
	});

	test("verification words without a command are refused", () => {
		expect(categories("테스트 통과, 수정 완료", "")).toEqual(["unproven_claim_word"]);
		expect(categories("bun test 통과, 수정 완료", "")).toEqual([]);
		expect(categories("평범한 요약", "")).toEqual([]);
	});
});

describe("collectLaneDiff after a rebase (qa50b H-5)", () => {
	const roots: string[] = [];
	afterAll(() => {
		for (const dir of roots) rmSync(dir, { recursive: true, force: true });
	});
	const git = (cwd: string, ...args: string[]): string =>
		execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], {
			cwd,
			encoding: "utf8",
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" },
		}).trim();
	const commit = (dir: string, file: string, text: string, message: string): string => {
		writeFileSync(join(dir, file), text);
		git(dir, "add", file);
		git(dir, "commit", "-q", "-m", message);
		return git(dir, "rev-parse", "HEAD");
	};
	/** main with one commit, a lane branch with `feature.ts`, then main gains a skipped test and the lane rebases. */
	function rebasedLane(): { dir: string; base0: string; head: string } {
		const dir = mkdtempSync(join(tmpdir(), "ompbot-integrity-"));
		roots.push(dir);
		git(dir, "init", "-q", "-b", "main");
		const base0 = commit(dir, "README.md", "base\n", "base");
		git(dir, "checkout", "-q", "-b", "lane/L-20260101-01");
		commit(dir, "feature.ts", "export const feature = 1;\n", "lane work");
		git(dir, "checkout", "-q", "main");
		commit(dir, "basework.test.ts", "import { test } from 'bun:test';\ntest.skip('later', () => {});\n", "main moved");
		git(dir, "checkout", "-q", "lane/L-20260101-01");
		git(dir, "rebase", "-q", "main");
		return { dir, base0, head: git(dir, "rev-parse", "HEAD") };
	}

	test("the range starts at the merge-base with the base branch tip: base commits are not judged", async () => {
		const { dir, base0, head } = rebasedLane();
		const diff = await collectLaneDiff(dir, { baseSha: base0, baseBranch: "main" }, head);
		expect(diff).toContain("+++ b/feature.ts");
		expect(diff).not.toContain("basework.test.ts");
		expect(classifyLaneCompletion({ summary: "feature added", diff })).toEqual([]);
	});

	test("the lane's own skipped test, even in a base-side file, is still judged", async () => {
		const { dir, base0 } = rebasedLane();
		const head = commit(
			dir,
			"basework.test.ts",
			"import { test } from 'bun:test';\ntest.skip('later', () => {});\ntest.only('mine', () => {});\n",
			"lane touches a base file",
		);
		const diff = await collectLaneDiff(dir, { baseSha: base0, baseBranch: "main" }, head);
		expect(classifyLaneCompletion({ summary: "x", diff }).map((r) => r.category)).toEqual(["skipped_test"]);
	});

	test("a reopened lane (baseSha = its previous claim, still in history) judges only the work after it", async () => {
		const { dir, head: previous } = rebasedLane();
		const head = commit(dir, "more.ts", "export const more = 2;\n", "after reopen");
		const diff = await collectLaneDiff(dir, { baseSha: previous, baseBranch: "main" }, head);
		expect(diff).toContain("+++ b/more.ts");
		expect(diff).not.toContain("feature.ts");
	});

	test("a base branch whose tip cannot be read fails closed with the reason", async () => {
		const { dir, base0, head } = rebasedLane();
		const refused = collectLaneDiff(dir, { baseSha: base0, baseBranch: "gone" }, head);
		await expect(refused).rejects.toBeInstanceOf(LaneDiffUnavailable);
		await expect(refused).rejects.toThrow("gone");
	});

	test("an unreadable base is a lane_diff_unavailable refusal, not a silent pass", () => {
		const refusal = laneDiffUnavailableRefusal(new LaneDiffUnavailable("base 브랜치 gone의 tip을 읽지 못했습니다"));
		expect(refusal).toMatchObject({ category: "lane_diff_unavailable" });
		expect(refusal.excerpt).toContain("gone");
	});
});

describe("lane and task diffs never run diff.external (qa-d M-3)", () => {
	const roots: string[] = [];
	afterAll(() => {
		for (const dir of roots) rmSync(dir, { recursive: true, force: true });
	});
	const git = (cwd: string, ...args: string[]): string =>
		execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], {
			cwd,
			encoding: "utf8",
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" },
		}).trim();
	/** A repository on `main` with two commits of `f.txt` whose `diff.external` runs `script` (written executable). */
	function externalDiffRepo(script: (root: string) => string): { root: string; dir: string; first: string } {
		const root = mkdtempSync(join(tmpdir(), "ompbot-extdiff-"));
		roots.push(root);
		const dir = join(root, "repo");
		mkdirSync(dir);
		git(dir, "init", "-q", "-b", "main");
		writeFileSync(join(dir, "f.txt"), "one\n");
		git(dir, "add", "f.txt");
		git(dir, "commit", "-q", "-m", "one");
		const first = git(dir, "rev-parse", "HEAD");
		writeFileSync(join(dir, "f.txt"), "two\n");
		git(dir, "commit", "-q", "-am", "two");
		const ext = join(root, "ext.sh");
		writeFileSync(ext, script(root));
		chmodSync(ext, 0o755);
		git(dir, "config", "diff.external", ext);
		return { root, dir, first };
	}
	const markerScript = (root: string): string => `#!/bin/sh\ntouch '${join(root, "ran")}'\n`;
	/**
	 * Resolves with "settled"/"rejected", or "hung" when `promise` is still pending after `ms`. Real time on purpose: the
	 * bound is the acceptance itself (real git and its external program in their own process group), and a hang must
	 * fail the test instead of stalling it; nothing waits on it when the awaited signal comes first.
	 */
	const within = async (promise: Promise<unknown>, ms: number): Promise<string> => {
		const deadline = Promise.withResolvers<string>();
		const timer = setTimeout(() => deadline.resolve("hung"), ms);
		try {
			return await Promise.race([
				promise.then(
					() => "settled",
					() => "rejected",
				),
				deadline.promise,
			]);
		} finally {
			clearTimeout(timer);
		}
	};

	test("collectLaneDiff reads the patch without the external program", async () => {
		const { root, dir, first } = externalDiffRepo(markerScript);
		const diff = await collectLaneDiff(dir, { baseSha: first }, git(dir, "rev-parse", "HEAD"));
		expect(diff).toContain("+two");
		expect(existsSync(join(root, "ran"))).toBe(false);
	});

	test("taskChangedPaths lists the files without the external program", async () => {
		const { root, dir } = externalDiffRepo(markerScript);
		writeFileSync(join(dir, "f.txt"), "three\n");
		const commands: string[][] = [];
		const run: ProcessRunner = (cmd, opts) => {
			commands.push(cmd);
			return realProcessRunner(cmd, opts);
		};
		expect(await taskChangedPaths(dir, run)).toEqual({ ok: true, paths: ["f.txt"] });
		expect(existsSync(join(root, "ran"))).toBe(false);
		const diffs = commands.filter((cmd) => cmd.includes("diff"));
		expect(diffs.length).toBeGreaterThan(0);
		for (const cmd of diffs) expect(cmd).toEqual(expect.arrayContaining(["--no-ext-diff", "--no-textconv"]));
	});

	test("gitRunner's timeout ends the whole process group, a grandchild holding the pipe included", async () => {
		const { root, dir } = externalDiffRepo((at) => `#!/bin/sh\nexec 3>'${join(at, "held")}'\nexec sleep 120\n`);
		const held = join(root, "held");
		execFileSync("mkfifo", [held]);
		// `cat` sees end of file only when the last writer (the external program) is gone.
		const reader = Bun.spawn(["cat", held], { stdout: "ignore", stderr: "ignore" });
		try {
			expect(await within(gitRunner(1_000)(["-C", dir, "diff", "HEAD~1", "HEAD"]), 3_000)).toBe("rejected");
			expect(await within(reader.exited, 3_000)).toBe("settled");
		} finally {
			reader.kill("SIGKILL");
		}
	});
});
