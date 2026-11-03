import { StoreError } from "../store/transitions";

/** Registry states of a work lane. `closed` is reached only through a verified done claim. */
export type LaneStatus = "working" | "done-claimed" | "not-done" | "closed";

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
	working: ["done-claimed"],
	"done-claimed": ["closed", "not-done", "working"],
	"not-done": ["done-claimed", "working"],
	closed: ["working"],
};

export function assertLaneTransition(from: LaneStatus, to: LaneStatus): void {
	if (!ALLOWED[from].includes(to)) throw new StoreError("invalid_transition", `lane ${from} -> ${to}`);
}
