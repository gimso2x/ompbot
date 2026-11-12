import { realpathSync } from "node:fs";
import { relative } from "node:path";
import {
	type AcceptanceItem,
	acceptanceItems,
	oneLine,
	TASK_PATH_PATTERN,
	TASK_RISKS,
	type TaskRisk,
} from "../tasks/docs";
import { assertCheckPlacement, parseChecks, SignalSyntaxError } from "../tasks/signals";
import { defaultGit, type GitRunner } from "./verify";

/**
 * Lane ids, branches and the checks a start passes before anything is created. A lane works in its own worktree
 * `<repo>-l-yyyymmdd-nn` (`worktreePathOf`) on branch `lane/L-YYYYMMDD-NN`; the lane's display name may be Hangul,
 * so it never reaches a path or a branch.
 */

/** Without an explicit risk a lane is L3: only a risk the caller named can fall under an auto-land ceiling. */
export const DEFAULT_LANE_RISK: TaskRisk = "L3";

export const laneBranchOf = (laneId: string): string => `lane/${laneId}`;

/** A start refused for the owner to read (raised as `LaneInputError` by the manager), or the checked value. */
export type LaneCheck<T> = { ok: true; value: T } | { ok: false; problem: string };

export function parseLaneRisk(raw: unknown): LaneCheck<TaskRisk> {
	if (raw === undefined) return { ok: true, value: DEFAULT_LANE_RISK };
	if (typeof raw === "string" && (TASK_RISKS as readonly string[]).includes(raw)) {
		return { ok: true, value: raw as TaskRisk };
	}
	return { ok: false, problem: "risk는 L0~L4 중 하나여야 합니다" };
}

/** Acceptance criteria as `AC-n` items; a malformed trailing `[check: …]` is refused now, not at the claim. */
export function parseLaneAcceptance(raw: unknown): LaneCheck<AcceptanceItem[]> {
	if (raw === undefined) return { ok: true, value: [] };
	if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string" || oneLine(item) === "")) {
		return { ok: false, problem: "acceptance는 비어 있지 않은 문자열 배열이어야 합니다" };
	}
	const texts = raw as string[];
	for (const [index, text] of texts.entries()) {
		try {
			// The stored text is the one-line form; that is the one the claim will run.
			const stored = oneLine(text);
			assertCheckPlacement(stored);
			parseChecks(stored);
		} catch (error) {
			if (!(error instanceof SignalSyntaxError)) throw error;
			return { ok: false, problem: `acceptance[${index}]의 check 형식 오류: ${error.message}` };
		}
	}
	return { ok: true, value: acceptanceItems(texts) };
}

export interface LaneRepo {
	/** Real path of the repository top level containing the requested cwd. */
	repo: string;
	/** Branch checked out in `repo`: the lane branch starts from it. */
	baseBranch: string;
	/** The requested cwd relative to `repo` (`""` for the top level); the lane works in the same place of its worktree. */
	sub: string;
}

/**
 * The repository a lane starts from: `cwd` (a real directory path) must be inside a git work tree whose top level is
 * a shell-inert path (`TASK_PATH_PATTERN`, the worktree path is built from it), with a branch checked out and at
 * least one commit. Git that cannot run at all rejects (`VerifyUnavailableError`).
 */
export async function resolveLaneRepo(cwd: string, git: GitRunner = defaultGit): Promise<LaneCheck<LaneRepo>> {
	const top = await git(["-C", cwd, "rev-parse", "--show-toplevel"]);
	if (top.code !== 0) {
		return { ok: false, problem: `git 저장소가 아닙니다: ${cwd} — 레인은 git 저장소 안에서만 시작합니다.` };
	}
	let repo: string;
	try {
		repo = realpathSync(top.stdout.trim());
	} catch {
		return { ok: false, problem: `저장소 경로를 확인하지 못했습니다: ${top.stdout.trim()}` };
	}
	// A submodule's sibling worktree path would land inside the superproject's work tree.
	const superproject = await git(["-C", repo, "rev-parse", "--show-superproject-working-tree"]);
	if (superproject.code === 0 && superproject.stdout.trim() !== "") {
		return {
			ok: false,
			problem: `서브모듈 안에서는 레인을 시작할 수 없습니다: ${repo} (상위 저장소 ${superproject.stdout.trim()}) — 상위 저장소나 따로 clone한 경로에서 시작하세요.`,
		};
	}
	if (!TASK_PATH_PATTERN.test(repo) || repo.includes("..")) {
		return {
			ok: false,
			problem: `저장소 경로에 영숫자·_ . / - 밖의 문자가 있어 레인 worktree를 만들 수 없습니다: ${repo}`,
		};
	}
	const branch = await git(["-C", repo, "symbolic-ref", "--short", "-q", "HEAD"]);
	const baseBranch = branch.stdout.trim();
	if (branch.code !== 0 || baseBranch === "") {
		return {
			ok: false,
			problem: `HEAD가 분리돼 있습니다(체크아웃된 브랜치 없음): ${repo} — 브랜치를 체크아웃한 뒤 시작하세요.`,
		};
	}
	const head = await git(["-C", repo, "rev-parse", "--verify", "-q", "HEAD^{commit}"]);
	if (head.code !== 0) return { ok: false, problem: `커밋이 없는 저장소입니다: ${repo}` };
	return { ok: true, value: { repo, baseBranch, sub: relative(repo, cwd) } };
}

/** Lane ids that already have a `lane/*` branch in `repo`. */
export async function laneIdsOnBranches(repo: string, git: GitRunner = defaultGit): Promise<Set<string>> {
	const listed = await git(["-C", repo, "branch", "--list", "lane/*", "--format=%(refname:short)"]);
	if (listed.code !== 0) throw new Error(`git branch --list failed in ${repo}: ${listed.stderr.trim().slice(0, 160)}`);
	return new Set(
		listed.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.startsWith("lane/"))
			.map((line) => line.slice("lane/".length)),
	);
}

/** The smallest `L-<day>-NN` (NN from 01) that `taken` does not claim. */
export function nextLaneId(day: string, taken: (laneId: string) => boolean): string {
	for (let seq = 1; ; seq += 1) {
		const laneId = `L-${day}-${String(seq).padStart(2, "0")}`;
		if (!taken(laneId)) return laneId;
	}
}
