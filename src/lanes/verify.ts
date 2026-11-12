import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { buildChildEnv } from "../omp/env";

export interface ClaimEvidence {
	repo: string;
	commit: string;
	summary: string;
}

export type VerifyResult = { ok: true; sha: string } | { ok: false; reasons: string[] };

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Runs `git <args>`; rejects only when git itself cannot run (missing binary, timeout). */
export type GitRunner = (args: string[]) => Promise<GitResult>;

/** The check could not be completed (git missing, timeout): the claim stays pending instead of being judged. */
export class VerifyUnavailableError extends Error {
	constructor(detail: string) {
		super(`verification unavailable: ${detail}`);
		this.name = "VerifyUnavailableError";
	}
}

const GIT_TIMEOUT_MS = 30_000;
/** Commit ids and refs only: never an option (`--upload-pack=...`) or a path. */
const COMMIT_ARG = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** Parent env minus bot secrets (`buildChildEnv`) and any `GIT_*` that could redirect git to another repository. */
function gitEnv(): Record<string, string> {
	const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
	return buildChildEnv({ GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }, inherited);
}

/** A `GitRunner` that gives each git call `timeoutMs` (a push to a remote needs longer than a local query). */
export const gitRunner =
	(timeoutMs: number): GitRunner =>
	async (args) => {
		let timer: Timer | undefined;
		try {
			const proc = Bun.spawn(["git", "-c", "core.fsmonitor=false", ...args], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				// Its own process group: a timeout ends git and what it started (an external diff, a textconv, a hook) too,
				// which would otherwise hold the pipes open past the deadline (qa-d M-3).
				detached: true,
				// `git status` must not rewrite the index of a repository somebody is working in.
				env: gitEnv(),
			});
			const out = proc.stdout.getReader();
			const err = proc.stderr.getReader();
			const timedOut = Promise.withResolvers<never>();
			timer = setTimeout(() => {
				try {
					process.kill(-proc.pid, "SIGKILL");
				} catch {
					proc.kill("SIGKILL");
				}
				for (const reader of [out, err]) reader.cancel().catch(() => undefined);
				timedOut.reject(new Error(`git timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			const [stdout, stderr, code] = await Promise.race([
				Promise.all([readText(out), readText(err), proc.exited]),
				timedOut.promise,
			]);
			if (proc.signalCode !== null) throw new Error(`git killed by ${proc.signalCode}`);
			return { code, stdout, stderr };
		} catch (error) {
			throw new VerifyUnavailableError(error instanceof Error ? error.message : String(error));
		} finally {
			clearTimeout(timer);
		}
	};

/** All of a pipe as text; a cancelled reader ends it early with what was read. */
async function readText(reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> }): Promise<string> {
	const decoder = new TextDecoder();
	let text = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return text + decoder.decode();
		text += decoder.decode(value, { stream: true });
	}
}

export const defaultGit: GitRunner = gitRunner(GIT_TIMEOUT_MS);

const SHA_PATTERN = /^[0-9a-f]{40,64}$/;

/** A claim names its repository by absolute path; only an existing directory is worth asking git about. */
function checkRepoPath(repo: string): { real: string } | { problem: string } {
	if (!isAbsolute(repo)) return { problem: `repo must be an absolute path: ${repo}` };
	try {
		const real = realpathSync(repo);
		if (!statSync(real).isDirectory()) return { problem: `repo is not a directory: ${repo}` };
		return { real };
	} catch {
		return { problem: `repo does not exist: ${repo}` };
	}
}

/** Real path of the repository top level containing `dir`; undefined when `dir` is not inside a work tree. */
async function topLevel(dir: string, git: GitRunner): Promise<string | undefined> {
	const result = await git(["-C", dir, "rev-parse", "--show-toplevel"]);
	if (result.code !== 0) return undefined;
	try {
		return realpathSync(result.stdout.trim());
	} catch {
		return undefined;
	}
}

/** HEAD of the lane cwd's repository when the lane starts; undefined when there is no repository or no commit yet. */
export async function resolveBaseSha(laneCwd: string, git: GitRunner = defaultGit): Promise<string | undefined> {
	const top = await topLevel(laneCwd, git);
	if (top === undefined) return undefined;
	const head = await git(["-C", top, "rev-parse", "--verify", "HEAD^{commit}"]);
	const sha = head.stdout.trim();
	return head.code === 0 && SHA_PATTERN.test(sha) ? sha : undefined;
}

/**
 * Checks a done claim with git itself, never with the lane's word. Only the top-level repository of the lane cwd is
 * ever inspected: a claimed `repo` whose top level differs (a nested repository, a repository above a nested cwd, a
 * foreign path) is refused as `repo_mismatch`. On that top level the working tree must be clean
 * (`status --porcelain` prints nothing) and `commit` must exist, be reachable from HEAD and be new since the lane
 * started (`baseSha`): the starting commit itself, or one that does not descend from it, is `no_new_commit`.
 * Every failed check contributes one reason. Returns the full sha on success.
 */
export async function verifyClaim(
	evidence: ClaimEvidence,
	laneCwd: string,
	baseSha?: string,
	git: GitRunner = defaultGit,
): Promise<VerifyResult> {
	const claimed = checkRepoPath(evidence.repo);
	if ("problem" in claimed) return { ok: false, reasons: [claimed.problem] };
	if (!COMMIT_ARG.test(evidence.commit)) {
		return { ok: false, reasons: [`commit is not a valid commit id: ${evidence.commit.slice(0, 80)}`] };
	}
	const top = await topLevel(laneCwd, git);
	if (top === undefined) return { ok: false, reasons: [`lane project ${laneCwd} is not inside a git repository`] };
	if ((await topLevel(claimed.real, git)) !== top) {
		return {
			ok: false,
			reasons: [`repo_mismatch: ${evidence.repo} is not the lane project's repository (${top})`],
		};
	}
	const reasons: string[] = [];

	const status = await git(["-C", top, "status", "--porcelain"]);
	if (status.code !== 0) {
		reasons.push(`git status failed in ${top}: ${status.stderr.trim().split("\n")[0] || `exit ${status.code}`}`);
	} else if (status.stdout.trim() !== "") {
		const files = status.stdout.trim().split("\n");
		const shown = files.slice(0, 10).join("; ");
		reasons.push(
			`uncommitted changes in ${top} (${files.length} path${files.length === 1 ? "" : "s"}): ${shown}${files.length > 10 ? "; ..." : ""}`,
		);
	}

	const exists = await git(["-C", top, "cat-file", "-e", `${evidence.commit}^{commit}`]);
	if (exists.code !== 0) reasons.push(`commit ${evidence.commit} does not exist in ${top}`);

	if (reasons.length > 0) return { ok: false, reasons };
	const resolved = await git(["-C", top, "rev-parse", `${evidence.commit}^{commit}`]);
	const sha = resolved.stdout.trim();
	if (resolved.code !== 0 || !SHA_PATTERN.test(sha)) {
		return { ok: false, reasons: [`cannot resolve commit ${evidence.commit} in ${top}`] };
	}

	const reachable = await git(["-C", top, "merge-base", "--is-ancestor", sha, "HEAD"]);
	if (reachable.code === 1) reasons.push(`no_new_commit: commit ${sha} is not reachable from HEAD of ${top}`);
	else if (reachable.code !== 0) reasons.push(`cannot check that commit ${sha} is reachable from HEAD of ${top}`);
	else if (baseSha !== undefined) {
		if (sha === baseSha) {
			reasons.push(`no_new_commit: commit ${sha} is the commit the lane started from; commit your work first`);
		} else if ((await git(["-C", top, "merge-base", "--is-ancestor", baseSha, sha])).code === 1) {
			reasons.push(`no_new_commit: commit ${sha} does not descend from the lane's starting commit ${baseSha}`);
		}
	}
	if (reasons.length > 0) return { ok: false, reasons };
	return { ok: true, sha };
}
