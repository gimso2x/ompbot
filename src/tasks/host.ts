import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { dispatchEnv, type ProcessRunner, realProcessRunner, remoteShellQuote } from "../dispatch/omp";
import type { CommitCheck } from "./checker";
import { TASK_PATH_PATTERN } from "./docs";

export type HostResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Process-runner stdout cap (`realProcessRunner`): a document at or past it may be cut, so it counts as unreadable. */
const RUNNER_STDOUT_CAP = 64_000;
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
	/** Commits `docs/tasks/<taskId>` on the worktree's branch as `docs(task): <taskId> 4문서`; the value is the hash. */
	commitDocs(input: { worktree: string; taskId: string }): Promise<HostResult<string>>;
	/**
	 * A `[check: command …]`: `argv` without a shell, cwd `worktree` (ssh: `cd` then each argument single-quoted),
	 * killed after `timeoutMs`. `output` is stdout then stderr. Throws when the host cannot be reached.
	 */
	runCheck(input: { worktree: string; argv: string[]; timeoutMs: number }): Promise<CheckRun>;
	/** The worktree's HEAD commit and whether `git status --porcelain` is empty; throws when git cannot answer. */
	headOf(worktree: string): Promise<{ sha: string; clean: boolean }>;
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

export function sshCommand(sshTarget: string, remote: string[]): string[] {
	return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", sshTarget, "--", ...remote];
}

function assertPath(path: string): void {
	if (!TASK_PATH_PATTERN.test(path)) throw new Error(`unsafe path: ${path}`);
}

function assertBranch(branch: string): void {
	if (!/^task\/T-\d{8}-\d{2,}$/.test(branch)) throw new Error(`unsafe branch: ${branch}`);
}

const fail = (error: unknown): { ok: false; error: string } => ({
	ok: false,
	error: error instanceof Error ? error.message : String(error),
});

export function createTaskHostOps(options: TaskHostOptions = {}): TaskHostOps {
	const run = options.run ?? realProcessRunner;
	const { sshTarget } = options;
	const env = dispatchEnv(options.inheritedEnv ?? process.env);

	/** One command on the host, stderr folded into stdout so a git error reaches the report. */
	const exec = (argv: string[], timeoutMs: number) =>
		sshTarget === undefined
			? run(["sh", "-c", 'exec "$@" 2>&1', "sh", ...argv], { timeoutMs, env })
			: run(sshCommand(sshTarget, [...argv, "2>&1"]), { timeoutMs });
	const unreachable = (result: { code: number | null; timedOut: boolean }): boolean =>
		result.timedOut || result.code === null || (sshTarget !== undefined && result.code === SSH_FAILURE);
	/** ssh writes its own connection errors to stderr; the remote command's output is on stdout. */
	const unreachableReason = (result: { stdout: string; stderr?: string }): string =>
		(result.stderr?.trim() || result.stdout.trim()).slice(0, 120);

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
			if (result.stdout.length >= RUNNER_STDOUT_CAP) return { ok: false, error: `${path} is too large to read` };
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
			const message = docsCommitMessage(taskId);
			const grep = `--grep=${message}`;
			const log = await git(
				"log",
				"--format=%H",
				"--fixed-strings",
				sshTarget === undefined ? grep : `'${grep}'`,
				branch,
			);
			if (log.code !== 0) throw failed("log", log);
			const base = log.stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => FULL_HASH.test(line))
				.at(-1);
			if (base === undefined) return "no_base";
			const parsed = await git("rev-parse", `${hash}^{commit}`);
			const full = parsed.stdout.trim();
			if (parsed.code !== 0 || !FULL_HASH.test(full)) throw failed("rev-parse", parsed);
			if (full === base) return "not_on_branch";
			return (await ancestor(base, full)) && (await ancestor(full, branch)) ? "ok" : "not_on_branch";
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

		async runCheck({ worktree, argv, timeoutMs }) {
			assertPath(worktree);
			// Locally the argv is the process itself; ssh joins its arguments into one remote shell line, so every
			// argument is single-quoted there and the shell only sees `cd <worktree> && <argv>`.
			const result =
				sshTarget === undefined
					? await run(argv, { cwd: worktree, timeoutMs, env })
					: await run(sshCommand(sshTarget, ["cd", remoteShellQuote(worktree), "&&", ...argv.map(remoteShellQuote)]), {
							timeoutMs,
						});
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
	};
}

/** Host ops for a task row's `host` (null = local); an unknown host name is an error, not a fallback to local. */
export function resolveTaskHost(
	host: string | null,
	dispatchHosts: Record<string, { ssh: string }> | undefined,
	options: Omit<TaskHostOptions, "sshTarget"> = {},
): TaskHostOps {
	if (host === null) return createTaskHostOps(options);
	const entry = dispatchHosts?.[host];
	if (entry === undefined) throw new Error(`알 수 없는 호스트: ${host}`);
	return createTaskHostOps({ ...options, sshTarget: entry.ssh });
}
