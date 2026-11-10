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
 * `landed` is merged, pushed and cleaned up, `merged-not-pushed` is merged with the push refused, `discarded` dropped
 * the worktree and branch unmerged. Only `pending` and `blocked` take a merge or a discard.
 */
export type LaneLandState = "pending" | "landed" | "merged-not-pushed" | "blocked" | "discarded";

/** `autoLandHeld` of a lane closed past an integrity refusal: auto-merge skips it, the owner's `머지` does not. */
export const INTEGRITY_APPROVED = "무결성 승인";
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
	/** Why auto-merge leaves this lane to the owner: `INTEGRITY_APPROVED` or `OWNER_PAUSE_HELD`. */
	autoLandHeld?: string;
	/** A landing has begun and not finished: the tick resumes it (each step is idempotent). */
	requestedBy?: "auto" | "owner";
	/** `origin/<baseBranch>` once the merge was pushed there. */
	pushed?: string;
	/** The Outcome card in the lane thread (edited in place as the landing moves on). */
	cardTs?: string;
	/** Landings that threw (git or host unavailable) in a row; the third is `blocked`. */
	errors?: number;
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
	risk?: TaskRisk;
	/** Acceptance criteria as given at the start; a trailing `[check: …]` is re-run by the core before closing. */
	acceptance?: AcceptanceItem[];
	/** The last `[check: …]` run, at worktree HEAD `head`; the same HEAD is never checked again. */
	checks?: { head: string; results: TaskCheck[] };
	/**
	 * The merge of a closed worktree lane; absent on lanes without a worktree and before the first close. A lane sent
	 * back to work by a non-ff landing keeps it (`attempts`) until it closes again; `!reopen` drops it.
	 */
	land?: LaneLand;
	/** The state the lane was in when the owner paused it; `paused` only, cleared at resume. */
	pausedFrom?: Exclude<LaneStatus, "paused" | "closed">;
	/** When the pause began; the key that keeps the held-work warning and the held-message notice to one each. */
	pausedAt?: number;
	/** How the pause was asked: an owner message in the lane thread or the ⏸ button. */
	pausedBy?: "owner-message" | "button";
}

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
	"not-done": ["done-claimed", "working", "paused"],
	paused: ["working", "done-claimed"],
	closed: ["working"],
};

export function assertLaneTransition(from: LaneStatus, to: LaneStatus): void {
	if (!ALLOWED[from].includes(to)) throw new StoreError("invalid_transition", `lane ${from} -> ${to}`);
}
