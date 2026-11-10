import { TASK_RISKS } from "../tasks/docs";
import type { AutoLandPolicy } from "../tasks/notify";
import { INTEGRITY_APPROVED, type LaneRow } from "./status";
import { defaultGit, type GitResult, type GitRunner, gitRunner } from "./verify";
import { DEFAULT_LANE_RISK } from "./worktree";

/**
 * Landing a closed work lane: fixed-sha fast-forward of the base branch, one push, then the lane's worktree and
 * branch go. The core does it with git itself (no model in between); what needs judgement — a base branch that moved
 * ahead — is handed back to the lane as `not-ff`. Every step can be repeated: a landing cut off anywhere is run again
 * from the top and neither merges nor pushes twice.
 */

/** A push to a remote may take far longer than a local query. */
const PUSH_TIMEOUT_MS = 120_000;
const REASON_MAX = 300;
const DIRTY_SHOWN = 5;

export interface LandRequest {
	/** Top level of the repository the lane started from. */
	repo: string;
	baseBranch: string;
	/** `lane/<laneId>`. */
	branch: string;
	worktree: string;
	/** The verified claim commit: the base branch ends exactly there. */
	sha: string;
	/** Whether this landing may push `origin/<baseBranch>` (an owner request always; an auto-merge inside `repos`). */
	push: boolean;
}

export type LandResult =
	/** Merged, cleaned up, and pushed to `pushed` (absent: no push was asked for, or the repository has no `origin`). */
	| { state: "landed"; preSha: string; pushed?: string }
	/** Merged and cleaned up; `origin` refused the push. */
	| { state: "merged-not-pushed"; preSha: string; reason: string }
	/** Nothing changed; the owner has to look. */
	| { state: "blocked"; reason: string }
	/** Nothing changed; the base branch is no ancestor of the claim any more. */
	| { state: "not-ff"; reason: string };

export interface LandHooks {
	/** Called right after the base branch moved, with what it pointed to before (durable undo information). */
	onMerged?(preSha: string): void;
}

export type LandLane = (request: LandRequest, hooks?: LandHooks) => Promise<LandResult>;

export interface LanderDeps {
	git?: GitRunner;
	/** Runs `ls-remote` and `push` (default: git with a longer timeout). */
	pushGit?: GitRunner;
	/** Removes the lane's worktree and branch; one that is already gone is not an error. */
	removeWorktree(input: { repo: string; worktree: string; branch: string }): Promise<void>;
}

const blocked = (reason: string): LandResult => ({ state: "blocked", reason: reason.slice(0, REASON_MAX) });

/** The line of a failed git call worth showing: the one that says rejected/error/fatal, else the first. */
function failureLine(result: GitResult): string {
	const lines = `${result.stderr}\n${result.stdout}`
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	const telling = lines.find((line) => /rejected|error|fatal|denied/i.test(line));
	return (telling ?? lines[0] ?? `exit ${result.code}`).slice(0, 200);
}

/** The worktree of `repo` (itself included) that has `baseBranch` checked out; `undefined` when none has. */
async function checkoutOf(git: GitRunner, repo: string, baseBranch: string): Promise<string | undefined> {
	const listed = await git(["-C", repo, "worktree", "list", "--porcelain"]);
	if (listed.code !== 0) throw new Error(`git worktree list failed in ${repo}: ${failureLine(listed)}`);
	for (const entry of listed.stdout.split("\n\n")) {
		const lines = entry.split("\n");
		if (!lines.includes(`branch refs/heads/${baseBranch}`)) continue;
		const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
		if (path !== undefined) return path;
	}
	return undefined;
}

/**
 * One push of the claim to `origin/<baseBranch>`, skipped when `origin` already has it. `undefined` = the repository
 * has no `origin` (nothing to push to); `{ refused }` = `origin` could not be read or refused the push.
 */
async function pushOnce(
	git: GitRunner,
	pushGit: GitRunner,
	request: LandRequest,
): Promise<{ pushed: string } | { refused: string } | undefined> {
	const { repo, baseBranch, sha } = request;
	if ((await git(["-C", repo, "remote", "get-url", "origin"])).code !== 0) return undefined;
	const pushed = `origin/${baseBranch}`;
	const listed = await pushGit(["-C", repo, "ls-remote", "origin", `refs/heads/${baseBranch}`]);
	if (listed.code !== 0) return { refused: `origin을 읽지 못함: ${failureLine(listed)}` };
	const remoteSha = listed.stdout.trim().split(/\s+/)[0] ?? "";
	if (remoteSha === sha) return { pushed };
	// `origin` already past the claim (a landing that pushed and was cut off, then more work landed): nothing to push.
	if (remoteSha !== "" && (await git(["-C", repo, "merge-base", "--is-ancestor", sha, remoteSha])).code === 0) {
		return { pushed };
	}
	const result = await pushGit(["-C", repo, "push", "origin", `${sha}:refs/heads/${baseBranch}`]);
	return result.code === 0 ? { pushed } : { refused: failureLine(result) };
}

/**
 * Lands one lane (callers serialize per repository: `createLaneLander`). Rejects only when git or the host cannot
 * run; the caller keeps the landing pending and runs it again.
 */
export async function landLane(request: LandRequest, deps: LanderDeps, hooks: LandHooks = {}): Promise<LandResult> {
	const git = deps.git ?? defaultGit;
	const { repo, baseBranch, sha } = request;
	const baseRef = `refs/heads/${baseBranch}`;
	if ((await git(["-C", repo, "cat-file", "-e", sha])).code !== 0) {
		return blocked(`클레임 커밋 ${sha.slice(0, 12)}이 ${repo}에 없습니다`);
	}
	const base = await git(["-C", repo, "rev-parse", "--verify", "-q", `${baseRef}^{commit}`]);
	if (base.code !== 0) return blocked(`기준 브랜치 ${baseBranch}가 ${repo}에 없습니다`);
	const oldSha = base.stdout.trim();

	// The cleanup force-deletes the lane branch: commits made on it after the claim would be lost with it.
	const tip = await git(["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${request.branch}^{commit}`]);
	const tipSha = tip.stdout.trim();
	if (tip.code === 0 && tipSha !== sha) {
		// A landing cut off after its merge may find the branch moved: say that the claim is already in.
		const merged = (await git(["-C", repo, "merge-base", "--is-ancestor", sha, baseRef])).code === 0;
		return blocked(
			`레인 브랜치 ${request.branch}(${tipSha.slice(0, 12)})가 클레임 커밋 ${sha.slice(0, 12)}과 다릅니다 — ${
				merged
					? `클레임 커밋은 이미 ${baseBranch}에 머지됐고 push·정리만 멈췄습니다. `
					: `${baseBranch}는 바뀌지 않았습니다. `
			}클레임 뒤 커밋을 살리려면 \`!reopen\`으로 다시 클레임하게 하세요`,
		);
	}

	let preSha = "unknown";
	const already = await git(["-C", repo, "merge-base", "--is-ancestor", sha, baseRef]);
	if (already.code !== 0 && already.code !== 1) return blocked(`머지 여부를 확인하지 못함: ${failureLine(already)}`);
	// Already an ancestor: an earlier run of this landing merged and was cut off — go on with the push.
	if (already.code === 1) {
		const checkout = await checkoutOf(git, repo, baseBranch);
		if (checkout !== undefined) {
			const status = await git(["-C", checkout, "status", "--porcelain"]);
			if (status.code !== 0) return blocked(`git status 실패(${checkout}): ${failureLine(status)}`);
			const dirty = status.stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line !== "");
			if (dirty.length > 0) {
				const shown = dirty.slice(0, DIRTY_SHOWN).join("; ");
				return blocked(
					`${baseBranch}가 체크아웃된 ${checkout}에 커밋되지 않은 변경 ${dirty.length}건: ${shown}${dirty.length > DIRTY_SHOWN ? "; …" : ""}`,
				);
			}
		}
		const ff = await git(["-C", repo, "merge-base", "--is-ancestor", baseRef, sha]);
		if (ff.code === 1) {
			return { state: "not-ff", reason: `${baseBranch}(${oldSha.slice(0, 12)})가 레인 커밋보다 앞서 있어 ff 불가` };
		}
		if (ff.code !== 0) return blocked(`ff 가능 여부를 확인하지 못함: ${failureLine(ff)}`);
		// A checked-out base branch follows with its index and working tree; any other is moved as a bare ref.
		const moved =
			checkout !== undefined
				? await git(["-C", checkout, "merge", "--ff-only", sha])
				: await git(["-C", repo, "update-ref", baseRef, sha, oldSha]);
		if (moved.code !== 0) return blocked(`머지 실패: ${failureLine(moved)}`);
		preSha = oldSha;
		hooks.onMerged?.(preSha);
	}
	// Nothing is pushed or removed unless the claim is in the base branch now.
	if ((await git(["-C", repo, "merge-base", "--is-ancestor", sha, baseRef])).code !== 0) {
		return blocked(`머지 뒤 ${baseBranch}에 ${sha.slice(0, 12)}이 없습니다`);
	}
	const push = request.push ? await pushOnce(git, deps.pushGit ?? gitRunner(PUSH_TIMEOUT_MS), request) : undefined;
	await deps.removeWorktree({ repo, worktree: request.worktree, branch: request.branch });
	if (push !== undefined && "refused" in push) {
		return { state: "merged-not-pushed", preSha, reason: push.refused.slice(0, REASON_MAX) };
	}
	return { state: "landed", preSha, ...(push === undefined ? {} : { pushed: push.pushed }) };
}

/** `landLane` with the landings of one repository run one after the other (two lanes never race for a base branch). */
export function createLaneLander(deps: LanderDeps): LandLane {
	const tails = new Map<string, Promise<void>>();
	return (request, hooks) => {
		const run = (tails.get(request.repo) ?? Promise.resolve()).then(() => landLane(request, deps, hooks));
		const tail = run.then(
			() => undefined,
			() => undefined,
		);
		tails.set(request.repo, tail);
		void tail.then(() => {
			if (tails.get(request.repo) === tail) tails.delete(request.repo);
		});
		return run;
	};
}

/**
 * Why a closed lane is not merged without asking; `[]` = merge it. The rules are `autoLandBlockers`' (tasks), as far
 * as they apply to a lane: `repoMatched` is the git common-directory comparison against `taskAutoLand.repos`, the
 * checks are the ones the core re-ran at the claim commit, and a lane the owner let through an integrity refusal is
 * never merged unasked. `frozen`: auto-merge is autonomous, so a freeze holds it.
 */
export function laneLandBlockers(
	lane: LaneRow,
	policy: AutoLandPolicy,
	repoMatched: boolean,
	frozen: boolean,
): string[] {
	const blockers: string[] = [];
	if (!repoMatched) blockers.push("저장소가 taskAutoLand.repos 밖");
	const risk = lane.meta.risk ?? DEFAULT_LANE_RISK;
	if (TASK_RISKS.indexOf(risk) > TASK_RISKS.indexOf(policy.maxRisk)) blockers.push(`위험 ${risk} > ${policy.maxRisk}`);
	const recorded = lane.meta.checks;
	const checks = recorded !== undefined && recorded.head === lane.meta.sha ? recorded.results : [];
	const failed = checks.filter((check) => !check.ok).length;
	if (checks.length === 0) blockers.push("재실행 검사 없음");
	else if (failed > 0) blockers.push(`재실행 검사 실패 ${failed}/${checks.length}`);
	const held = lane.meta.land?.autoLandHeld;
	if (held !== undefined) blockers.push(held === INTEGRITY_APPROVED ? `${held}으로 통과` : held);
	if (frozen) blockers.push("동결 중");
	return blockers;
}
