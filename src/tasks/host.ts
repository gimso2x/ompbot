import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	DEFAULT_STDOUT_CAP,
	dispatchEnv,
	type ProcessRunner,
	realProcessRunner,
	remoteShellQuote,
} from "../dispatch/omp";
import type { CommitCheck } from "./checker";
import { TASK_PATH_PATTERN } from "./docs";

export type HostResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Task-branch diffs are collected whole (still `--unified=0`, still without `docs/tasks`): the integrity classifier
 * is local string work with no model context, and a real task branch (T-20261109-04) measured ~150 KB. Past this a
 * task keeps the commit-unit review hand-off instead of an ever-larger read.
 */
const DIFF_STDOUT_CAP = 512_000;
const GIT_TIMEOUT_MS = 60_000;
const IO_TIMEOUT_MS = 20_000;
const HEX_HASH = /^[0-9a-f]{7,40}$/;
/** A full object name (sha1 or sha256) as `rev-parse` and `log --format=%H` print it. */
const FULL_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TASK_ID = /^T-\d{8}-\d{2,}$/;

/** The task branch's first commit (`commitDocs`); `commitOnTaskBranch` finds the branch base by it. */
const docsCommitMessage = (taskId: string): string => `docs(task): ${taskId} 4문서`;
/** ssh's own failure code (connection, auth); a remote command's code never is 255 here. */
const SSH_FAILURE = 255;

/** File and git operations of a task on one machine (the bot's own, or a `dispatchHosts` entry over ssh). */
export interface TaskHostOps {
	pathExists(path: string): Promise<HostResult<boolean>>;
	/** `git -C <repo> worktree add -b <branch> <worktree> HEAD`; fails when the branch or path already exists. */
	createWorktree(input: { repo: string; worktree: string; branch: string }): Promise<HostResult<null>>;
	/** Best-effort rollback of a worktree this call created (a failed registration). */
	removeWorktree(input: { repo: string; worktree: string; branch: string }): Promise<void>;
	/** Creates parent directories; refuses to overwrite an existing file. */
	writeFile(path: string, content: string): Promise<HostResult<null>>;
	/** `value: undefined` = the file does not exist; an unreachable host is a failure, never "missing". */
	readFile(path: string): Promise<HostResult<string | undefined>>;
	/**
	 * Whether `hash` is a commit on `branch` after the branch's `docs(task): <taskId> 4문서` commit; throws when the host
	 * cannot be asked or git fails unexpectedly (never answers "no" for "unknown").
	 */
	commitOnTaskBranch(input: { worktree: string; branch: string; taskId: string; hash: string }): Promise<CommitCheck>;
	/**
	 * `git diff <base>..<branch> --unified=0` from the branch's docs commit (the base `commitOnTaskBranch` measures
	 * from). `no_base` without a docs commit, `diff too large` at its own (raised) stdout cap, any git or host failure
	 * as its error — never an empty diff for "unknown".
	 */
	branchDiff(input: { worktree: string; branch: string; taskId: string }): Promise<HostResult<string>>;
	/** Commits `docs/tasks/<taskId>` on the worktree's branch as `docs(task): <taskId> 4문서`; the value is the hash. */
	commitDocs(input: { worktree: string; taskId: string }): Promise<HostResult<string>>;
	/**
	 * A `[check: command …]`: `argv` without a shell, cwd `worktree` (ssh: `cd` then each argument single-quoted),
	 * killed after `timeoutMs` or when `signal` aborts. `output` is stdout then stderr. Throws when the host cannot be
	 * reached.
	 */
	runCheck(input: { worktree: string; argv: string[]; timeoutMs: number; signal?: AbortSignal }): Promise<CheckRun>;
	/** The worktree's HEAD commit and whether `git status --porcelain` is empty; throws when git cannot answer. */
	headOf(worktree: string): Promise<{ sha: string; clean: boolean }>;
}

/**
 * Resume-time reads of a task worktree (`resumeTask` only), apart from `TaskHostOps` so its read-only fakes elsewhere
 * (the dashboard's) need not answer them.
 */
export interface TaskResumeOps {
	/**
	 * Where PROGRESS.md was last committed and what came after it: `git log -1 -- docs/tasks/<id>/PROGRESS.md`, the
	 * commits since then outside `docs/tasks/`, and `git status --porcelain`. Any git or host failure is `ok: false`.
	 */
	progressLag(input: { worktree: string; taskId: string }): Promise<HostResult<ProgressLag>>;
}

/** How far PROGRESS.md trails the worktree, measured from its last commit (`progressLag`). */
export interface ProgressLag {
	/** Short hash of the last commit touching `docs/tasks/<id>/PROGRESS.md`; `""` when it was never committed. */
	progressCommit: string;
	/** Commits in `progressCommit..HEAD` touching anything outside `docs/tasks/`; 0 without a `progressCommit`. */
	codeCommitsSince: number;
	/** PROGRESS.md has uncommitted changes. */
	progressDirty: boolean;
	/** Other uncommitted paths (`git status --porcelain` entries besides PROGRESS.md). */
	otherDirty: number;
}

export interface CheckRun {
	code: number | null;
	output: string;
	timedOut: boolean;
}

export interface TaskHostOptions {
	/** ssh target; absent = the bot's own machine. */
	sshTarget?: string;
	run?: ProcessRunner;
	inheritedEnv?: Record<string, string | undefined>;
}

/** PATH assignment a remote `[check:]` line exports first; double quotes so the remote shell expands `$HOME`/`$PATH`. */
const REMOTE_CHECK_PATH = 'PATH="$HOME/.local/bin:$PATH"';

export function sshCommand(sshTarget: string, remote: string[]): string[] {
	return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", sshTarget, "--", ...remote];
}

function assertPath(path: string): void {
	if (!TASK_PATH_PATTERN.test(path)) throw new Error(`unsafe path: ${path}`);
}

/** A task branch (`task/T-YYYYMMDD-NN`) or a work lane's branch (`lane/L-YYYYMMDD-NN`); nothing else reaches git. */
function assertBranch(branch: string): void {
	if (!/^(?:task\/T|lane\/L)-\d{8}-\d{2,}$/.test(branch)) throw new Error(`unsafe branch: ${branch}`);
}

const fail = (error: unknown): { ok: false; error: string } => ({
	ok: false,
	error: error instanceof Error ? error.message : String(error),
});

export function createTaskHostOps(options: TaskHostOptions = {}): TaskHostOps & TaskResumeOps {
	const run = options.run ?? realProcessRunner;
	const { sshTarget } = options;
	const env = dispatchEnv(options.inheritedEnv ?? process.env);

	/** One command on the host, stderr folded into stdout so a git error reaches the report. */
	const exec = (argv: string[], timeoutMs: number, stdoutCap?: number) =>
		sshTarget === undefined
			? run(["sh", "-c", 'exec "$@" 2>&1', "sh", ...argv], { timeoutMs, env, stdoutCap })
			: run(sshCommand(sshTarget, [...argv, "2>&1"]), { timeoutMs, stdoutCap });
	const unreachable = (result: { code: number | null; timedOut: boolean }): boolean =>
		result.timedOut || result.code === null || (sshTarget !== undefined && result.code === SSH_FAILURE);
	/** ssh writes its own connection errors to stderr; the remote command's output is on stdout. */
	const unreachableReason = (result: { stdout: string; stderr?: string }): string =>
		(result.stderr?.trim() || result.stdout.trim()).slice(0, 120);
	/** The task branch's base: the oldest commit carrying its docs-commit message; `undefined` when it has none. */
	const docsBase = async (
		worktree: string,
		taskId: string,
		branch: string,
	): Promise<HostResult<string | undefined>> => {
		const grep = `--grep=${docsCommitMessage(taskId)}`;
		const log = await exec(
			[
				"git",
				"-C",
				worktree,
				"log",
				"--format=%H",
				"--fixed-strings",
				sshTarget === undefined ? grep : `'${grep}'`,
				branch,
			],
			GIT_TIMEOUT_MS,
		);
		if (unreachable(log)) return { ok: false, error: "host unreachable" };
		if (log.code !== 0) return { ok: false, error: `git log failed: ${log.stdout.trim().slice(0, 160)}` };
		const base = log.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => FULL_HASH.test(line))
			.at(-1);
		return { ok: true, value: base };
	};

	return {
		async pathExists(path) {
			assertPath(path);
			if (sshTarget === undefined) return { ok: true, value: existsSync(path) };
			const result = await run(sshCommand(sshTarget, ["test", "-e", path]), { timeoutMs: IO_TIMEOUT_MS });
			if (unreachable(result)) return { ok: false, error: `host unreachable: ${unreachableReason(result)}` };
			return { ok: true, value: result.code === 0 };
		},

		async createWorktree({ repo, worktree, branch }) {
			assertPath(repo);
			assertPath(worktree);
			assertBranch(branch);
			const result = await exec(["git", "-C", repo, "worktree", "add", "-b", branch, worktree, "HEAD"], GIT_TIMEOUT_MS);
			if (result.code === 0 && !result.timedOut) return { ok: true, value: null };
			return { ok: false, error: `git worktree add failed: ${result.stdout.trim().slice(0, 200)}` };
		},

		async removeWorktree({ repo, worktree, branch }) {
			assertPath(repo);
			assertPath(worktree);
			assertBranch(branch);
			await exec(["git", "-C", repo, "worktree", "remove", "--force", worktree], GIT_TIMEOUT_MS);
			await exec(["git", "-C", repo, "branch", "-D", branch], GIT_TIMEOUT_MS);
		},

		async writeFile(path, content) {
			assertPath(path);
			if (sshTarget === undefined) {
				try {
					await mkdir(dirname(path), { recursive: true });
					await writeFile(path, content, { flag: "wx" });
					return { ok: true, value: null };
				} catch (error) {
					return fail(error);
				}
			}
			const encoded = Buffer.from(content, "utf8").toString("base64");
			// One shell command line: every interpolated piece is a validated path or base64.
			const command = `mkdir -p ${dirname(path)} && test ! -e ${path} && echo ${encoded} | base64 -d > ${path}`;
			const result = await run(sshCommand(sshTarget, [command, "2>&1"]), { timeoutMs: IO_TIMEOUT_MS });
			if (result.code === 0 && !result.timedOut) return { ok: true, value: null };
			return { ok: false, error: `write ${path} failed: ${result.stdout.trim().slice(0, 160)}` };
		},

		async readFile(path) {
			assertPath(path);
			if (sshTarget === undefined) {
				try {
					return { ok: true, value: await readFile(path, "utf8") };
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: undefined };
					return fail(error);
				}
			}
			const result = await run(sshCommand(sshTarget, ["cat", path]), { timeoutMs: IO_TIMEOUT_MS });
			if (unreachable(result)) return { ok: false, error: `host unreachable: ${unreachableReason(result)}` };
			if (result.code !== 0) return { ok: true, value: undefined };
			if (result.stdout.length >= DEFAULT_STDOUT_CAP) return { ok: false, error: `${path} is too large to read` };
			return { ok: true, value: result.stdout };
		},

		async commitOnTaskBranch({ worktree, branch, taskId, hash }) {
			assertPath(worktree);
			assertBranch(branch);
			if (!TASK_ID.test(taskId)) throw new Error(`unsafe task id: ${taskId}`);
			if (!HEX_HASH.test(hash)) return "missing";
			const git = async (...args: string[]) => {
				const result = await exec(["git", "-C", worktree, ...args], GIT_TIMEOUT_MS);
				if (unreachable(result)) throw new Error(`cannot check commit ${hash}: host unreachable`);
				return result;
			};
			const failed = (step: string, result: { stdout: string }) =>
				new Error(`cannot check commit ${hash}: git ${step} failed: ${result.stdout.trim().slice(0, 160)}`);
			/** `merge-base --is-ancestor`: 0 yes, 1 no, anything else is git failing, not an answer. */
			const ancestor = async (older: string, newer: string): Promise<boolean> => {
				const result = await git("merge-base", "--is-ancestor", older, newer);
				if (result.code !== 0 && result.code !== 1) throw failed("merge-base", result);
				return result.code === 0;
			};

			if ((await git("cat-file", "-e", `${hash}^{commit}`)).code !== 0) return "missing";
			// The docs commit opens the task branch; the oldest one carrying its message is the base.
			const found = await docsBase(worktree, taskId, branch);
			if (!found.ok) throw new Error(`cannot check commit ${hash}: ${found.error}`);
			const base = found.value;
			if (base === undefined) return "no_base";
			const parsed = await git("rev-parse", `${hash}^{commit}`);
			const full = parsed.stdout.trim();
			if (parsed.code !== 0 || !FULL_HASH.test(full)) throw failed("rev-parse", parsed);
			if (full === base) return "not_on_branch";
			return (await ancestor(base, full)) && (await ancestor(full, branch)) ? "ok" : "not_on_branch";
		},

		async branchDiff({ worktree, branch, taskId }) {
			assertPath(worktree);
			assertBranch(branch);
			if (!TASK_ID.test(taskId)) throw new Error(`unsafe task id: ${taskId}`);
			const base = await docsBase(worktree, taskId, branch);
			if (!base.ok) return base;
			if (base.value === undefined) return { ok: false, error: "no_base" };
			const diff = await exec(
				[
					"git",
					"-C",
					worktree,
					"-c",
					"core.quotepath=false",
					"diff",
					"--no-ext-diff",
					"--no-textconv",
					`${base.value}..${branch}`,
					"--no-color",
					"--unified=0",
					// The worker's own status documents are not judged and only eat into the runner's stdout cap.
					// `:!` rather than `:(exclude)`: the argv crosses a remote shell unquoted over ssh.
					"--",
					".",
					":!docs/tasks",
				],
				GIT_TIMEOUT_MS,
				DIFF_STDOUT_CAP,
			);
			if (unreachable(diff)) return { ok: false, error: `host unreachable: ${unreachableReason(diff)}` };
			if (diff.code !== 0) return { ok: false, error: `git diff failed: ${diff.stdout.trim().slice(0, 160)}` };
			if (diff.stdout.length >= DIFF_STDOUT_CAP) return { ok: false, error: "diff too large" };
			return { ok: true, value: diff.stdout };
		},

		async commitDocs({ worktree, taskId }) {
			assertPath(worktree);
			if (!TASK_ID.test(taskId)) throw new Error(`unsafe task id: ${taskId}`);
			const dir = `docs/tasks/${taskId}`;
			const message = docsCommitMessage(taskId);
			// ssh joins its arguments into one remote shell line: the fixed message is quoted there, passed bare locally.
			const steps = [
				["git", "-C", worktree, "add", "--", dir],
				["git", "-C", worktree, "commit", "-q", "-m", sshTarget === undefined ? message : `'${message}'`, "--", dir],
			];
			for (const argv of steps) {
				const result = await exec(argv, GIT_TIMEOUT_MS);
				if (result.code !== 0 || result.timedOut) {
					return { ok: false, error: `git ${argv[3]} failed: ${result.stdout.trim().slice(0, 200)}` };
				}
			}
			const head = await exec(["git", "-C", worktree, "rev-parse", "HEAD"], GIT_TIMEOUT_MS);
			const hash = head.stdout.trim();
			if (head.code !== 0 || head.timedOut || !HEX_HASH.test(hash)) {
				return { ok: false, error: `git rev-parse failed: ${hash.slice(0, 200)}` };
			}
			return { ok: true, value: hash };
		},

		async runCheck({ worktree, argv, timeoutMs, signal }) {
			assertPath(worktree);
			const stop = signal === undefined ? {} : { signal };
			// Locally the argv is the process itself; ssh joins its arguments into one remote shell line, so every
			// argument is single-quoted there and the shell only sees `cd <worktree> && <argv>`. A non-interactive ssh
			// shell skips the profile that puts `~/.local/bin` (npm, node, bun shims) on PATH, so the line adds it first.
			const result =
				sshTarget === undefined
					? await run(argv, { cwd: worktree, timeoutMs, env, ...stop })
					: await run(
							sshCommand(sshTarget, [
								"export",
								REMOTE_CHECK_PATH,
								"&&",
								"cd",
								remoteShellQuote(worktree),
								"&&",
								...argv.map(remoteShellQuote),
							]),
							{ timeoutMs, ...stop },
						);
			if (sshTarget !== undefined && !result.timedOut && (result.code === null || result.code === SSH_FAILURE))
				throw new Error(`cannot run check: host unreachable: ${unreachableReason(result)}`);
			const output = [result.stdout, result.stderr ?? ""].filter((part) => part.trim() !== "").join("\n");
			return { code: result.code, output, timedOut: result.timedOut };
		},

		async headOf(worktree) {
			assertPath(worktree);
			const git = async (...args: string[]) => {
				const result = await exec(["git", "-C", worktree, ...args], GIT_TIMEOUT_MS);
				if (unreachable(result)) throw new Error(`cannot read HEAD of ${worktree}: host unreachable`);
				if (result.code !== 0)
					throw new Error(
						`cannot read HEAD of ${worktree}: git ${args[0]} failed: ${result.stdout.trim().slice(0, 160)}`,
					);
				return result.stdout.trim();
			};
			const sha = await git("rev-parse", "HEAD");
			if (!FULL_HASH.test(sha)) throw new Error(`cannot read HEAD of ${worktree}: ${sha.slice(0, 80)}`);
			return { sha, clean: (await git("status", "--porcelain")) === "" };
		},

		async progressLag({ worktree, taskId }) {
			assertPath(worktree);
			if (!TASK_ID.test(taskId)) throw new Error(`unsafe task id: ${taskId}`);
			const progressPath = `docs/tasks/${taskId}/PROGRESS.md`;
			const git = async (...args: string[]): Promise<HostResult<string>> => {
				const result = await exec(["git", "-C", worktree, ...args], GIT_TIMEOUT_MS);
				if (unreachable(result)) return { ok: false, error: `host unreachable: ${unreachableReason(result)}` };
				if (result.code !== 0)
					return { ok: false, error: `git ${args[0]} failed: ${result.stdout.trim().slice(0, 160)}` };
				return { ok: true, value: result.stdout };
			};
			const log = await git("log", "-1", "--format=%h", "--", progressPath);
			if (!log.ok) return log;
			const progressCommit = log.value.trim();
			if (progressCommit !== "" && !HEX_HASH.test(progressCommit))
				return { ok: false, error: `git log: ${progressCommit.slice(0, 80)}` };
			let codeCommitsSince = 0;
			if (progressCommit !== "") {
				// Every task's documents are left out, not only this one's: a docs-only commit is never a code commit.
				// `:!` rather than `:(exclude)`: the argv crosses a remote shell unquoted over ssh.
				const count = await git("rev-list", "--count", `${progressCommit}..HEAD`, "--", ".", ":!docs/tasks");
				if (!count.ok) return count;
				codeCommitsSince = Number.parseInt(count.value.trim(), 10);
				if (!Number.isInteger(codeCommitsSince))
					return { ok: false, error: `git rev-list: ${count.value.trim().slice(0, 80)}` };
			}
			const status = await git("status", "--porcelain");
			if (!status.ok) return status;
			const entries = status.value.split("\n").filter((line) => line.trim() !== "");
			const progressDirty = entries.some((line) => line.slice(3) === progressPath);
			return {
				ok: true,
				value: {
					progressCommit,
					codeCommitsSince,
					progressDirty,
					otherDirty: entries.length - (progressDirty ? 1 : 0),
				},
			};
		},
	};
}

/** Host ops for a task row's `host` (null = local); an unknown host name is an error, not a fallback to local. */
export function resolveTaskHost(
	host: string | null,
	dispatchHosts: Record<string, { ssh: string }> | undefined,
	options: Omit<TaskHostOptions, "sshTarget"> = {},
): TaskHostOps & TaskResumeOps {
	if (host === null) return createTaskHostOps(options);
	// Own keys only: `constructor`/`__proto__` are not configured hosts.
	const entry = dispatchHosts !== undefined && Object.hasOwn(dispatchHosts, host) ? dispatchHosts[host] : undefined;
	if (entry === undefined) throw new Error(`알 수 없는 호스트: ${host}`);
	return createTaskHostOps({ ...options, sshTarget: entry.ssh });
}
