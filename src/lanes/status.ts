import { StoreError } from "../store/transitions";
import type { TaskCheck } from "../tasks/checker";
import type { AcceptanceItem, TaskRisk } from "../tasks/docs";

/**
 * Registry states of a work lane. `closed` is reached only through a verified done claim; `paused` is the owner's
 * hold on an open lane (its turn is aborted, every autonomous action waits) and only the owner lifts it.
 */
export type LaneStatus = "working" | "done-claimed" | "not-done" | "paused" | "closed";

/** Origin keys of lane sessions; the key is built here and never parsed afterwards. */
export const LANE_ORIGIN_PREFIX = "ompbot/work/";

export const laneOriginKey = (name: string): string => `${LANE_ORIGIN_PREFIX}${name}`;
export const isLaneOrigin = (originKey: string): boolean => originKey.startsWith(LANE_ORIGIN_PREFIX);

export interface LaneHistoryEntry {
	at: number;
	event: string;
	detail?: string;
	sha?: string;
}

export interface LaneClaim {
	repo: string;
	commit: string;
	summary: string;
	claimedAt: number;
}

/**
 * Where a closed worktree lane stands with its merge: `pending` waits for the owner's `머지`/`폐기` (or for the
 * landing that already began, `requestedBy`), `blocked` needs the owner (dirty checkout, twice not fast-forward),
 * `landed` is merged and pushed (`cleanup` names what was not cleaned up), `merged-not-pushed` is merged with the push
 * refused, `discarded` dropped
 * the worktree and branch unmerged. Only `pending` and `blocked` take a merge or a discard.
 */
export type LaneLandState = "pending" | "landed" | "merged-not-pushed" | "blocked" | "discarded";

/** `autoLandHeld` of a lane closed past an integrity refusal: auto-merge skips it, the owner's `머지` does not. */
export const INTEGRITY_APPROVED = "무결성 승인";
/** `autoLandHeld` of a lane the owner closed past checks that timed out twice: auto-merge skips it, `머지` does not. */
export const INCONCLUSIVE_APPROVED = "확인 불가 승인";
/** `autoLandHeld` of a closed lane whose auto-merge the owner's pause holds: `머지해`/`머지` still lands it. */
export const OWNER_PAUSE_HELD = "오너 멈춤";

export interface LaneLand {
	state: LaneLandState;
	/** Landings refused because the base branch had moved ahead (not fast-forward); the second one is `blocked`. */
	attempts: number;
	/** The base branch before the merge (how to undo it); `"unknown"` when a restart lost it. */
	preSha?: string;
	/** Why the landing is `blocked` or `merged-not-pushed`. */
	reason?: string;
	/** Why auto-merge leaves this lane to the owner: `INTEGRITY_APPROVED`, `INCONCLUSIVE_APPROVED` or `OWNER_PAUSE_HELD`. */
	autoLandHeld?: string;
	/** A landing has begun and not finished: the tick resumes it (each step is idempotent). */
	requestedBy?: "auto" | "owner";
	/** `origin/<baseBranch>` once the merge was pushed there. */
	pushed?: string;
	/** What of the worktree and branch a `landed`/`merged-not-pushed` landing left behind; absent = both are gone. */
	cleanup?: string;
	/** The Outcome card in the lane thread (edited in place as the landing moves on). */
	cardTs?: string;
	/** Landings that threw (git or host unavailable) in a row; the third is `blocked`. */
	errors?: number;
}

/** Judgements at `head` that ended with timed-out checks only, and when the last one ran. */
export interface LaneChecksInconclusive {
	head: string;
	runs: number;
	lastAt: number;
}

/**
 * The independent review of a closed lane's claim commit (`taskAutoLand.review`): a receipt for `sha` only — a lane
 * whose `meta.sha` moved on has no receipt. Auto-merge needs `CLEAR`; `BLOCK` and `inconclusive` go to the owner.
 */
export interface LaneReview {
	/** The commit reviewed (`meta.sha` at the time). */
	sha: string;
	verdict: "CLEAR" | "BLOCK" | "inconclusive";
	model: string;
	at: number;
	/** What the reviewer wrote before its `VERDICT` line (redacted, at most 1500 characters). */
	notes: string;
	/** Why the review is `inconclusive` (timed out, exit code, no or several VERDICT lines, no diff). */
	reason?: string;
	/** The reviewer's `CONFIDENCE` (0–1) in its verdict; absent when it wrote none or a malformed one (older receipts). */
	confidence?: number;
}

/**
 * What the claim commit changed against the base branch (`computeLaneChanges`), shown on the Outcome card only: never
 * read by the auto-merge. Bound to `sha`: a lane whose `meta.sha` moved on shows none. Overlaps are a snapshot of the
 * moment the card went up (branch commits only, not uncommitted work in other worktrees).
 */
export interface LaneChanges {
	/** The claim commit these numbers are for (ignored when `meta.sha` differs). */
	sha: string;
	files: number;
	insertions: number;
	deletions: number;
	/** Text files with the most changed lines (added + deleted), at most 5. */
	top: { path: string; added: number; deleted: number }[];
	/** Other open lanes of the same repository that changed the same files (at most 3 lanes, 5 files each). */
	overlaps: { lane: string; files: string[] }[];
	/** Files the base branch changed after the merge-base that this lane changed too (at most 5). */
	baseDrift: string[];
	/** Why this lane's own diff could not be read (then the numbers are 0 and the lists empty). */
	error?: string;
	/** Why the base drift or another lane's diff could not be read (that part only is missing). */
	overlapError?: string;
}

/** Runtime facts of a lane that are not registry columns (kept as one JSON column). */
export interface LaneMeta {
	/** `⏳ title · mm:ss` message in the lane thread. */
	statusTs?: string;
	/** Start of the current working period (reset when a closed lane is reopened). */
	startedAt: number;
	/** Last time the status message was edited. */
	lastProgressAt: number;
	/** HEAD of the lane cwd's repository when the lane started (or was reopened); a claim must be a newer commit. */
	baseSha?: string;
	milestone?: string;
	claim?: LaneClaim;
	/** Full sha recorded when the claim was verified and the lane closed. */
	sha?: string;
	/** What the Slack root / status messages currently show (reconciled on every tick). */
	renderedRoot?: string;
	renderedStatus?: string;
	/** Counter for synthetic inbound ids of messages the core steers into the lane. */
	steerSeq: number;
	/**
	 * Worktree lanes (absent on lanes that worked in `cwd` directly, which keep closing as before): `L-YYYYMMDD-NN`,
	 * the repository top level the lane started from, its own worktree and branch `lane/<laneId>`, and the branch that
	 * was checked out in `repo` at the start.
	 */
	laneId?: string;
	repo?: string;
	worktree?: string;
	branch?: string;
	baseBranch?: string;
	/** The risk the starter named (or a keyword floor raised it to); absent = unrated, compared as `DEFAULT_LANE_RISK`. */
	risk?: TaskRisk;
	/** Acceptance criteria as given at the start; a trailing `[check: …]` is re-run by the core before closing. */
	acceptance?: AcceptanceItem[];
	/** The start's brief (redacted, at most 16000 characters): the spec the independent review reads. */
	brief?: string;
	/** The independent review of the claim commit (`taskAutoLand.review`); `!reopen` drops it. */
	review?: LaneReview;
	/** What the claim commit changed, computed once per claim commit when its card goes up; `!reopen` drops it. */
	changes?: LaneChanges;
	/**
	 * The last `[check: …]` run, at worktree HEAD `head`; the same HEAD is never checked again, except its timed-out
	 * (inconclusive) results — `inconclusive` counts those judgements at one HEAD (absent when the run had none).
	 */
	checks?: { head: string; results: TaskCheck[]; inconclusive?: LaneChecksInconclusive };
	/**
	 * The merge of a closed worktree lane; absent on lanes without a worktree and before the first close. A lane sent
	 * back to work by a non-ff landing keeps it (`attempts`) until it closes again; `!reopen` drops it.
	 */
	land?: LaneLand;
	/** The state the lane was in when the owner paused it; `paused` only, cleared at resume. */
	pausedFrom?: Exclude<LaneStatus, "paused" | "closed">;
	/** When the pause began; the key that keeps the held-work warning and the held-message notice to one each. */
	pausedAt?: number;
	/** How the pause was asked: an owner message in the lane thread, the ⏸ button, or a terminal attach. */
	pausedBy?: "owner-message" | "button" | "attach";
	/**
	 * Automatic nudges after turns that ended with no done claim (`lanes.completionNudges`), counted since the owner
	 * last wrote in the thread or `!reopen` (only those reset it — a nudge never does). `warned`: the cap's one thread
	 * line was posted; `ownerAsked`: the running turn called `ompbot_lane_progress` with `needsOwner` (cleared when
	 * that turn ends).
	 */
	nudges?: { sent: number; warned?: boolean; ownerAsked?: boolean };
	/** The lane's session is handed to a terminal omp (`ompbot lanes attach`); absent otherwise. */
	attach?: LaneAttach;
	/**
	 * A terminal hand-back left new session files: the files the owner picks the one to continue from (index 0 is the
	 * attached file, already pinned) and whether the pick resumes the lane. Cleared by the pick or a resume.
	 */
	sessionChoices?: { files: string[]; resume: boolean };
}

/** A lane session handed to a terminal omp: who holds it and what to compare the hand-back with. */
export interface LaneAttach {
	/** The `ompbot lanes attach` process; when it is gone the lane is taken back (`LaneManager.tick`). */
	pid: number;
	at: number;
	/** The file the lane's child had open (else the one it would resume): the terminal omp resumes exactly this. */
	sessionFile: string;
	/** Its size at the hand-over: what the terminal appended starts here. */
	size: number;
	/** The worktree HEAD at the hand-over (absent when git could not say): the summary counts files changed since. */
	head?: string;
	/** The lane was paused already: the hand-back leaves it paused. */
	wasPaused: boolean;
	/** `--keep-paused`: the hand-back leaves the lane paused. */
	keepPaused: boolean;
}

/** Inbound ids of messages the core itself steers into a lane (first prompt, not-done, nudge): never the owner's. */
export const isCoreSteerId = (platformMessageId: string): boolean => platformMessageId.startsWith("lane:");

export interface LaneRow {
	name: string;
	title: string;
	threadRef: string;
	originKey: string;
	cwd: string;
	sessionDir: string;
	status: LaneStatus;
	history: LaneHistoryEntry[];
	meta: LaneMeta;
	createdAt: number;
	updatedAt: number;
}

const ALLOWED: Record<LaneStatus, readonly LaneStatus[]> = {
	working: ["done-claimed", "paused"],
	"done-claimed": ["closed", "not-done", "working", "paused"],
	// `closed`: work merged into the base branch outside the lane (`#closeIfLandedOutside`).
	"not-done": ["done-claimed", "working", "paused", "closed"],
	paused: ["working", "done-claimed"],
	closed: ["working"],
};

export function assertLaneTransition(from: LaneStatus, to: LaneStatus): void {
	if (!ALLOWED[from].includes(to)) throw new StoreError("invalid_transition", `lane ${from} -> ${to}`);
}
