import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProcessRunner } from "../src/dispatch/omp";
import { createTaskHostOps } from "../src/tasks/host";

const TASK = "T-20261110-11";
const PROGRESS = `docs/tasks/${TASK}/PROGRESS.md`;

describe("progressLag, local, real temp git repo", () => {
	let repo: string;
	beforeEach(() => {
		repo = join(realpathSync(mkdtempSync(join(tmpdir(), "ompbot-progress-lag-"))), "repo");
		mkdirSync(repo);
		git("init", "-q", "-b", "main");
		git("config", "user.name", "t");
		git("config", "user.email", "t@t");
		write("a.txt", "a");
		commit("init", "a.txt");
	});
	afterEach(() => rmSync(dirname(repo), { recursive: true, force: true }));

	function git(...args: string[]): string {
		const result = Bun.spawnSync(["git", "-C", repo, ...args]);
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		return result.stdout.toString().trim();
	}
	function write(path: string, content: string): void {
		mkdirSync(dirname(join(repo, path)), { recursive: true });
		writeFileSync(join(repo, path), content);
	}
	function commit(message: string, ...paths: string[]): string {
		git("add", "--", ...paths);
		git("commit", "-q", "-m", message);
		return git("rev-parse", "--short", "HEAD");
	}
	const lag = () => createTaskHostOps({}).progressLag({ worktree: repo, taskId: TASK });

	test("normal cycle [code commit → PROGRESS edit → docs commit]: nothing trails", async () => {
		write(PROGRESS, "S1");
		commit("docs", PROGRESS);
		write("src/x.ts", "1");
		commit("feat", "src/x.ts");
		write(PROGRESS, "S1 done");
		const docs = commit("docs: S1", PROGRESS);
		expect(await lag()).toEqual({
			ok: true,
			value: { progressCommit: docs, codeCommitsSince: 0, progressDirty: false, otherDirty: 0 },
		});
	});

	test("rule 2 broken [PROGRESS commit → two code commits, PROGRESS left uncommitted]: two commits trail", async () => {
		write(PROGRESS, "S1");
		const docs = commit("docs", PROGRESS);
		write("src/x.ts", "1");
		commit("feat 1", "src/x.ts");
		write("src/y.ts", "2");
		commit("feat 2", "src/y.ts");
		write(PROGRESS, "S1 done, S2 done");
		expect(await lag()).toEqual({
			ok: true,
			value: { progressCommit: docs, codeCommitsSince: 2, progressDirty: true, otherDirty: 0 },
		});
	});

	test("commits that only touch docs/tasks are not code commits", async () => {
		write(PROGRESS, "S1");
		const docs = commit("docs", PROGRESS);
		write(`docs/tasks/${TASK}/outcome.md`, "## 요약");
		commit("docs: outcome", `docs/tasks/${TASK}/outcome.md`);
		write("docs/tasks/T-20261110-01/PROGRESS.md", "other");
		commit("docs: other task", "docs/tasks/T-20261110-01/PROGRESS.md");
		write("src/x.ts", "1");
		write(`docs/tasks/${TASK}/spec.md`, "spec");
		commit("feat with docs", "src/x.ts", `docs/tasks/${TASK}/spec.md`);
		const result = await lag();
		expect(result).toEqual({
			ok: true,
			value: { progressCommit: docs, codeCommitsSince: 1, progressDirty: false, otherDirty: 0 },
		});
	});

	test("other uncommitted paths are counted apart from PROGRESS.md", async () => {
		write(PROGRESS, "S1");
		commit("docs", PROGRESS);
		write("a.txt", "changed");
		write("new.ts", "untracked");
		const result = await lag();
		expect(result.ok && result.value).toMatchObject({ codeCommitsSince: 0, progressDirty: false, otherDirty: 2 });
	});

	test("a PROGRESS.md never committed has no commit to measure from", async () => {
		write("src/x.ts", "1");
		commit("feat", "src/x.ts");
		write(PROGRESS, "S1");
		expect(await lag()).toEqual({
			ok: true,
			value: { progressCommit: "", codeCommitsSince: 0, progressDirty: false, otherDirty: 1 },
		});
	});

	test("a directory that is not a repository is a failure, not a clean answer", async () => {
		const outside = join(dirname(repo), "plain");
		mkdirSync(outside);
		const result = await createTaskHostOps({}).progressLag({ worktree: outside, taskId: TASK });
		expect(result.ok).toBe(false);
	});
});

describe("progressLag over ssh", () => {
	test("the same git commands go through ssh; an unreachable host is a failure", async () => {
		const commands: string[][] = [];
		const run: ProcessRunner = async (cmd) => {
			commands.push(cmd);
			const args = cmd.slice(cmd.indexOf("--") + 1);
			if (args[3] === "log") return { code: 0, stdout: "abc1234\n", timedOut: false };
			if (args[3] === "rev-list") return { code: 0, stdout: "3\n", timedOut: false };
			return { code: 0, stdout: ` M ${PROGRESS}\n?? x.ts\n`, timedOut: false };
		};
		const ops = createTaskHostOps({ sshTarget: "wsl", run });
		expect(await ops.progressLag({ worktree: "/r/wt", taskId: TASK })).toEqual({
			ok: true,
			value: { progressCommit: "abc1234", codeCommitsSince: 3, progressDirty: true, otherDirty: 1 },
		});
		const ssh = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "wsl", "--", "git", "-C", "/r/wt"];
		expect(commands).toEqual([
			[...ssh, "log", "-1", "--format=%h", "--", PROGRESS, "2>&1"],
			[...ssh, "rev-list", "--count", "abc1234..HEAD", "--", ".", ":!docs/tasks", "2>&1"],
			[...ssh, "status", "--porcelain", "2>&1"],
		]);

		const down = createTaskHostOps({
			sshTarget: "wsl",
			run: async () => ({ code: 255, stdout: "", stderr: "ssh: no route\n", timedOut: false }),
		});
		expect(await down.progressLag({ worktree: "/r/wt", taskId: TASK })).toEqual({
			ok: false,
			error: "host unreachable: ssh: no route",
		});
		await expect(ops.progressLag({ worktree: "/r/wt; id", taskId: TASK })).rejects.toThrow("unsafe path");
		await expect(ops.progressLag({ worktree: "/r/wt", taskId: "T-1; id" })).rejects.toThrow("unsafe task id");
	});
});
