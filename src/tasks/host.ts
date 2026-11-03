import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { dispatchEnv, type ProcessRunner, realProcessRunner } from "../dispatch/omp";
import { TASK_PATH_PATTERN } from "./docs";

export type HostResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Process-runner stdout cap (`realProcessRunner`): a document at or past it may be cut, so it counts as unreadable. */
const RUNNER_STDOUT_CAP = 64_000;
const GIT_TIMEOUT_MS = 60_000;
const IO_TIMEOUT_MS = 20_000;
const HEX_HASH = /^[0-9a-f]{7,40}$/;
const TASK_ID = /^T-\d{8}-\d{2,}$/;
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
	/** `git cat-file -e <hash>^{commit}`; throws when the host cannot be asked (never answers "no" for "unknown"). */
	commitExists(worktree: string, hash: string): Promise<boolean>;
	/** Commits `docs/tasks/<taskId>` on the worktree's branch as `docs(task): <taskId> 4문서`; the value is the hash. */
	commitDocs(input: { worktree: string; taskId: string }): Promise<HostResult<string>>;
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

		async commitExists(worktree, hash) {
			assertPath(worktree);
			if (!HEX_HASH.test(hash)) return false;
			const result =
				sshTarget === undefined
					? await run(["git", "-C", worktree, "cat-file", "-e", `${hash}^{commit}`], { timeoutMs: GIT_TIMEOUT_MS, env })
					: await run(sshCommand(sshTarget, ["git", "-C", worktree, "cat-file", "-e", `${hash}^{commit}`]), {
							timeoutMs: GIT_TIMEOUT_MS,
						});
			if (unreachable(result)) throw new Error(`cannot check commit ${hash}: host unreachable`);
			return result.code === 0;
		},

		async commitDocs({ worktree, taskId }) {
			assertPath(worktree);
			if (!TASK_ID.test(taskId)) throw new Error(`unsafe task id: ${taskId}`);
			const dir = `docs/tasks/${taskId}`;
			const message = `docs(task): ${taskId} 4문서`;
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
