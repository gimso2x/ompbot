import { redact } from "../redact";
import type { LaneChanges, LaneRow } from "./status";
import { type GitResult, type GitRunner, gitRunner } from "./verify";

/**
 * What a closed lane's claim commit changed against its base branch, for the Outcome card (doc/plans/lane-card-changes.md):
 * file and line counts, the most changed files, and the files other open lanes of the same repository or the base
 * branch (since the merge-base) changed too. Git calls only; nothing here throws on a git failure — this lane's own
 * failure is `error`, a failure reading the base or another lane is `overlapError`, and the rest is still reported.
 */

/** Each git call of the computation gets 10 seconds. */
export const CHANGES_GIT_TIMEOUT_MS = 10_000;
const changesGit: GitRunner = gitRunner(CHANGES_GIT_TIMEOUT_MS);

const TOP_MAX = 5;
const OVERLAP_LANES_MAX = 3;
const OVERLAP_FILES_MAX = 5;
const DRIFT_MAX = 5;
const REASON_MAX = 200;

/** Why a git call failed, as one short redacted line. */
const reasonOf = (what: string, detail: string): string =>
	redact(`${what}: ${detail.trim().split("\n")[0] ?? ""}`.trim()).slice(0, REASON_MAX);

class ChangesGitError extends Error {}

/** Runs `git <args>`; a non-zero exit or a git that could not run is a `ChangesGitError` naming `what`. */
async function run(git: GitRunner, what: string, args: string[]): Promise<string> {
	let result: GitResult;
	try {
		result = await git(args);
	} catch (error) {
		throw new ChangesGitError(reasonOf(what, error instanceof Error ? error.message : String(error)));
	}
	if (result.code !== 0) throw new ChangesGitError(reasonOf(what, result.stderr || `exit ${result.code}`));
	return result.stdout;
}

const messageOf = (error: unknown): string =>
	error instanceof ChangesGitError ? error.message : reasonOf("git", String(error));

/** `diff -z --no-renames` output: one NUL-terminated record per file (a rename is a delete and an add). */
const nulRecords = (stdout: string): string[] => stdout.split("\0").filter((record) => record !== "");

async function mergeBase(git: GitRunner, repo: string, baseBranch: string, tip: string): Promise<string> {
	const mb = (await run(git, "merge-base 실패", ["-C", repo, "merge-base", `refs/heads/${baseBranch}`, tip])).trim();
	if (mb === "") throw new ChangesGitError("merge-base 없음");
	return mb;
}

async function namesChanged(git: GitRunner, repo: string, what: string, range: string): Promise<string[]> {
	const stdout = await run(git, what, [
		"-C",
		repo,
		"-c",
		"core.quotepath=false",
		"diff",
		"--no-ext-diff",
		"--no-textconv",
		"--no-color",
		"--name-only",
		"-z",
		"--no-renames",
		range,
	]);
	return nulRecords(stdout);
}

/** Whether another lane can still be merged: open, or closed with its landing `pending` or `blocked`. */
const stillUnmerged = (lane: LaneRow): boolean =>
	lane.status !== "closed" || lane.meta.land?.state === "pending" || lane.meta.land?.state === "blocked";

/**
 * Computes `lane`'s changes at its claim commit `meta.sha`. `others` may hold every lane: only unmerged lanes of the
 * same repository other than `lane` are compared, at their branch tip (a missing branch is skipped).
 */
export async function computeLaneChanges(
	lane: LaneRow,
	others: readonly LaneRow[],
	git: GitRunner = changesGit,
): Promise<LaneChanges> {
	const { repo, baseBranch } = lane.meta;
	const sha = lane.meta.sha ?? "";
	const empty: LaneChanges = { sha, files: 0, insertions: 0, deletions: 0, top: [], overlaps: [], baseDrift: [] };
	if (sha === "" || repo === undefined || baseBranch === undefined) {
		return { ...empty, error: "레인에 worktree나 클레임 커밋이 없음" };
	}

	let mb: string;
	const entries: { path: string; added: number; deleted: number; binary: boolean }[] = [];
	try {
		mb = await mergeBase(git, repo, baseBranch, sha);
		const numstat = await run(git, "diff --numstat 실패", [
			"-C",
			repo,
			"-c",
			"core.quotepath=false",
			"diff",
			"--no-ext-diff",
			"--no-textconv",
			"--no-color",
			"--numstat",
			"-z",
			"--no-renames",
			`${mb}..${sha}`,
		]);
		for (const record of nulRecords(numstat)) {
			const [added = "", deleted = "", ...rest] = record.split("\t");
			const path = rest.join("\t");
			if (path === "") throw new ChangesGitError(reasonOf("diff --numstat 해석 실패", record));
			const binary = added === "-" && deleted === "-";
			entries.push({ path, added: binary ? 0 : Number(added), deleted: binary ? 0 : Number(deleted), binary });
		}
	} catch (error) {
		return { ...empty, error: messageOf(error) };
	}

	const mine = new Set(entries.map((entry) => entry.path));
	const shared = (paths: readonly string[]): string[] => [...new Set(paths.filter((path) => mine.has(path)))].sort();
	const failures: string[] = [];

	let baseDrift: string[] = [];
	try {
		baseDrift = shared(await namesChanged(git, repo, "base 변경 조회 실패", `${mb}..refs/heads/${baseBranch}`))
			.slice(0, DRIFT_MAX)
			.map((path) => redact(path));
	} catch (error) {
		failures.push(messageOf(error));
	}

	const overlaps: LaneChanges["overlaps"] = [];
	for (const other of others) {
		if (overlaps.length >= OVERLAP_LANES_MAX) break;
		const { branch, baseBranch: otherBase } = other.meta;
		if (other.name === lane.name || other.meta.repo !== repo || !stillUnmerged(other)) continue;
		if (branch === undefined || otherBase === undefined) continue;
		try {
			const tip = await git(["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
			// `--quiet` exits 1 with no output when the branch does not exist (landed or removed meanwhile).
			if (tip.code === 1 && tip.stdout.trim() === "") continue;
			if (tip.code !== 0) throw new ChangesGitError(reasonOf(`레인 ${other.name} 브랜치 조회 실패`, tip.stderr));
			const otherMb = await mergeBase(git, repo, otherBase, `refs/heads/${branch}`);
			const files = shared(
				await namesChanged(git, repo, `레인 ${other.name} diff 실패`, `${otherMb}..refs/heads/${branch}`),
			);
			if (files.length > 0) {
				overlaps.push({ lane: other.name, files: files.slice(0, OVERLAP_FILES_MAX).map((path) => redact(path)) });
			}
		} catch (error) {
			failures.push(error instanceof ChangesGitError ? error.message : reasonOf(`레인 ${other.name}`, String(error)));
		}
	}

	const top = entries
		.filter((entry) => !entry.binary)
		.sort((a, b) => b.added + b.deleted - (a.added + a.deleted) || a.path.localeCompare(b.path))
		.slice(0, TOP_MAX)
		.map(({ path, added, deleted }) => ({ path: redact(path), added, deleted }));
	return {
		sha,
		files: entries.length,
		insertions: entries.reduce((sum, entry) => sum + entry.added, 0),
		deletions: entries.reduce((sum, entry) => sum + entry.deleted, 0),
		top,
		overlaps,
		baseDrift,
		...(failures.length === 0 ? {} : { overlapError: failures.join(" · ").slice(0, REASON_MAX) }),
	};
}
