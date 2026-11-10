import { Database } from "bun:sqlite";
import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { OmpbotConfig } from "../config";
import { TOP_LEVEL_TS } from "../core/normalize";
import { parseChatOrigin } from "../core/origin-key";
import { COMMAND_TEXT, parseCommand } from "../core/types";
import { readSweepHeartbeat } from "../daemon/heartbeat";
import {
	type DrainCounts,
	type MonitorsStatus,
	type OpenGateSummary,
	readStatusFromDb,
	type StatusReport,
} from "../daemon/status";
import { boardCardLink } from "../dispatch/board";
import {
	type HerdrAgentStatus,
	herdrAgentStatus,
	herdrSshArgv,
	type ProcessRunner,
	type RunProcessResult,
} from "../dispatch/omp";
import { type FlowTransition, type TaskStage, taskFlowStatus, taskStage } from "../flow/task-flow";
import { DEFAULT_TIMEZONE } from "../monitors/cron";
import {
	MONITOR_ORIGIN_PREFIX,
	type MonitorRow,
	type MonitorSql,
	monitorOrigin,
	nextFireOf,
	toMonitor,
} from "../monitors/ledger";
import type { MonitorDeliver, MonitorOverlap, MonitorTrigger } from "../monitors/spec";
import { readLockStartedAt } from "../ops/apply";
import { readStamp } from "../ops/backup";
import type { FreezeState } from "../ops/freeze";
import { collectGates, type Gate, type GateState, type GatesOptions, INBOUND_STARVATION_MS } from "../ops/gates";
import { OFFSITE_STAMP_FILE } from "../ops/offsite";
import { redact } from "../redact";
import { type FeedbackVerdict, readTurnVerdicts } from "../store/feedback";
import { formatKst, type TaskRisk } from "../tasks/docs";
import { evaluateTask } from "../tasks/evaluate";
import type { TaskHostOps } from "../tasks/host";
import { parseTaskJson, type TaskRow, type TaskStatus } from "../tasks/ledger";
import { type BoardState, type BoardSummary, type BoardTaskRef, summarizeBoard } from "./board";

/** A snapshot is reused this long: IPC, herdr, ssh and git are not asked again inside it. */
export const SNAPSHOT_TTL_MS = 10_000;
/** A snapshot build still running after this is given up (answered as a failed snapshot). */
export const SNAPSHOT_BUILD_TIMEOUT_MS = 30_000;
const IPC_TIMEOUT_MS = 10_000;
const HERDR_LOCAL_TIMEOUT_MS = 10_000;
const HERDR_SSH_TIMEOUT_MS = 15_000;
const TASK_EVAL_TIMEOUT_MS = 15_000;
const GIT_TIMEOUT_MS = 5_000;
const CLOSED_TASK_DAYS = 7;
const CLOSED_TASK_LIMIT = 20;
const TURN_LIMIT = 200;
const ERROR_CHARS = 200;

/** Every section either carries its data or says why it could not; one failed section never breaks the others. */
export type Section<T> = ({ ok: true } & T) | { ok: false; error: string };

export interface DaemonInfo {
	/** True when the daemon answered over its socket; false = the numbers come from the database file. */
	running: boolean;
	ompVersion: string;
	origins: number;
	busy: number;
	ledger: StatusReport["ledger"];
	inbound: StatusReport["inbound"];
	monitors: MonitorsStatus;
	openGates: OpenGateSummary[];
	frozen?: FreezeState;
	drain?: DrainCounts;
	heartbeat?: {
		at: string;
		ageMs: number;
		loopMs?: number;
		socket?: { state: "up" | "down"; since: string };
		/** Discord gateway; absent on an install without Discord. */
		discord?: { state: "up" | "down"; since: string };
		draining?: boolean;
	};
	/** `git rev-parse --short HEAD` of the checkout this process runs from; absent when git cannot tell. */
	commit?: string;
	/** When the running daemon took `ompbot.lock`; absent while it is down or the lock is unreadable. */
	started?: { at: string; ageMs: number };
}

export interface TurnInfo {
	inboundId: number;
	originKey: string;
	threadRef: string | null;
	state: string;
	createdAt: string;
	ageMs: number;
	/** Dispatched turns: time since the last event, else since dispatch (`inbound_starved`'s measure); null for pending. */
	silentMs: number | null;
	/**
	 * `inbound_starved`'s rule for this turn: dispatched, silent past {@link INBOUND_STARVATION_MS}, and its origin is
	 * not waiting on a live approval card (pending, `expires_at` not passed).
	 */
	stalled: boolean;
	kind: TurnKind;
	/** The request in one masked line of at most {@link PREVIEW_CHARS} chars; null for monitor turns. */
	preview: string | null;
	/** Why a pending row waits; null once dispatched. */
	waitReason: TurnWaitReason | null;
	/** A dispatched turn a restart drain is waiting for. */
	blocksRestart: boolean;
	/** Posted at the top level of its conversation (thread ref `<channel>:-`), not inside a thread. */
	topLevel: boolean;
	/** Typed as a Slack slash command (`slash:` platform message id). */
	slash: boolean;
}

export type TurnKind = "message" | "command" | "auto" | "monitor";
export type TurnWaitReason = "restart" | "frozen" | "followup" | "behind" | "queued";

/** A thread's turn-board column: someone should look · a turn is open · every turn has ended. */
export type ThreadColumn = "attention" | "working" | "done";

/** One turn of a thread as its detail lists it. */
export interface ThreadTurn {
	inboundId: number;
	state: string;
	createdAt: string;
	/** The request in one masked line of at most {@link PREVIEW_CHARS} chars; null for monitor turns. */
	preview: string | null;
}

/**
 * One conversation of the turn board (origin = Slack thread = omp session): open turns or activity in the last
 * {@link THREAD_WINDOW_MS}. Of message bodies only masked one-line previews are here.
 */
export interface ThreadInfo {
	originKey: string;
	threadRef: string | null;
	/** The last turn's kind. */
	kind: TurnKind;
	/** The thread's first turn as one masked line; a monitor's name for monitor threads. */
	title: string;
	/** attention: an open turn is stalled, or none is open and the last failed · working: a turn is open · done. */
	column: ThreadColumn;
	latest: ThreadTurn & Pick<TurnInfo, "ageMs" | "silentMs" | "stalled" | "waitReason">;
	/** Turns open or active within {@link THREAD_WINDOW_MS}. */
	turnCount: number;
	/** pending + dispatched turns. */
	openCount: number;
	/**
	 * omp runs behind the dispatched turns: messages steered into a running turn share its `op_ref`, so three rows
	 * can be one run.
	 */
	runCount: number;
	/** Open turns still pending (not handed to omp yet). */
	pendingCount: number;
	/** Open turns {@link TurnInfo.stalled} marks. */
	stalledCount: number;
	/** Last activity: the newest `COALESCE(last_event_at, dispatched_at, created_at)` of its turns. */
	updatedAt: string;
	/** Newest first, at most {@link THREAD_RECENT}. */
	recent: ThreadTurn[];
}

/** A thread with no open turn stays on the board this long after its last activity. */
export const THREAD_WINDOW_MS = 24 * 3_600_000;
const THREAD_LIMIT = 200;
const THREAD_RECENT = 20;

/** Longest request line a turn shows. */
export const PREVIEW_CHARS = 80;
const AUTO_FOLLOWUP_PREFIX = "[자동 후속";

export type HerdrState = { ok: true; status: HerdrAgentStatus } | { ok: false; error: string };

export interface TaskInfo {
	taskId: string;
	title: string;
	risk: TaskRisk;
	status: TaskStatus;
	/** `local` = the bot's own machine, otherwise the `dispatchHosts` name. */
	host: string;
	agent: string;
	branch: string;
	open: boolean;
	updatedAt: string;
	closedAt?: string;
	acChecked?: number;
	acTotal: number;
	stepsDone?: number;
	stepsTotal?: number;
	progress?: { status: string; updated: string; current: string; blockedReason: string };
	/** Registered acceptance items with their spec.md checkbox; open TASKs whose documents were judged. */
	acceptance?: Array<{ id: string; text: string; checked: boolean }>;
	/** PROGRESS.md steps; open TASKs whose documents were judged. */
	steps?: Array<{ id: string; text: string; done: boolean }>;
	herdr?: HerdrState;
	/** herdr board card of the task's pane (the board root when the card cannot be resolved). */
	link?: string;
	/** Why the task documents could not be judged, and/or which JSON column of the row is damaged (`… 손상`). */
	error?: string;
}

/** Threads in the flow view: a TASK registered in this window, or any open TASK. */
export const FLOW_WINDOW_MS = 7 * 86_400_000;
const FLOW_NOW_MSG_CHARS = 70;

/** One TASK box of a flow, built from the flow's own row (not cut to the snapshot's closed-TASK limit). */
export interface FlowStepInfo {
	taskId: string;
	title: string;
	status: TaskStatus;
	risk: TaskRisk;
	host: string;
	branch: string;
	createdAt: string;
	closedAt?: string;
	acTotal: number;
	stage: TaskStage;
}

/** One request thread: its request line and its TASKs in registration order. */
export interface FlowChainInfo {
	threadRef: string;
	originKey: string;
	/** `DM`, `채널 <C> 스레드`, … of the origin key. */
	place: string | null;
	/** The thread's first inbound as one masked line, or `(원문 없음)`. */
	title: string;
	requestedAt: string | null;
	/** Newest TASK `updated_at`. */
	updatedAt: string;
	done: number;
	total: number;
	/** The TASK to look at next: the first blocked open one, else the earliest open one; null when all are closed. */
	here: string | null;
	now: string;
	tasks: FlowStepInfo[];
}

export interface LaneInfo {
	name: string;
	title: string;
	status: string;
	cwd: string;
	updatedAt: string;
}

export interface HerdrAgentInfo {
	name: string;
	agent: string;
	agentStatus: string;
	cwd: string;
	paneId: string;
	terminalTitle: string;
	taskId?: string;
}

export type HerdrHostInfo = { host: string } & Section<{ agents: HerdrAgentInfo[] }>;

export interface ApprovalInfo {
	approvalId: string;
	summary: string;
	createdAt: string;
	expiresAt: string;
	originKey: string | null;
	/** The summary's first sentence (of its first line), at most 80 characters. */
	title: string;
	/** The card's sections (할 일·이유·영향·되돌릴 수 없는 이유); null for rows without them or with a broken value. */
	detail: { action?: string; why?: string; impact?: string; rollback?: string } | null;
	/** `https://` permalinks of the card and of the asking thread; anything else is null. */
	cardUrl: string | null;
	originUrl: string | null;
	/** Until the card times out (counts as denied); never below 0. */
	remainingMs: number;
	/** `DM`, `채널 <C> 스레드`, `채널 <C> 메인` or the raw origin key. */
	originLabel: string | null;
}

export type ApprovalOutcomeStatus = "approved" | "denied" | "expired" | "replied";

/** A settled approval, as the 최근 결정 list shows it; the fields it shares with {@link ApprovalInfo} read the same. */
export interface ApprovalDecision {
	approvalId: string;
	summary: string;
	title: string;
	status: ApprovalOutcomeStatus;
	createdAt: string;
	/** null on a row settled without a time. */
	decidedAt: string | null;
	/** Card up to its settling (`decided_at − created_at`, ≥ 0); null without `decidedAt`. */
	tookMs: number | null;
	originKey: string | null;
	originLabel: string | null;
	detail: ApprovalInfo["detail"];
	cardUrl: string | null;
	originUrl: string | null;
}

/** Approvals settled in the last {@link APPROVAL_STATS_DAYS} days, by outcome. */
export interface ApprovalStats {
	days: number;
	approved: number;
	denied: number;
	expired: number;
	replied: number;
	/** Median card-to-answer time of the owner's answers (approved, denied, replied); null without any. */
	medianAnswerMs: number | null;
}

/** A monitor's ended events of the last {@link MONITOR_STATS_DAYS} days, by outcome. */
export interface MonitorStats {
	days: number;
	delivered: number;
	quiet: number;
	failed: number;
	skipped: number;
	/** Median slot-to-settle time (retry waits included) of the delivered and quiet scheduled runs; null without any. */
	medianMs: number | null;
}

/** A file a monitor uses, by name only (never its directory). */
export interface MonitorFile {
	kind: "procedure" | "script";
	name: string;
}

/** One monitor event as the list shows its last run. */
export interface MonitorRun {
	stage: string;
	at: string;
	slotAt: string;
	/** {@link monitorDurationMs}: slot to settle for an ended event; null while it runs. */
	durationMs: number | null;
	attempts: number;
	manual: boolean;
}

/** One enabled monitor. Of its instruction only {@link MonitorInfo.summary}; event answers and payloads never. */
export interface MonitorInfo {
	/** The detail key (`?item=`, `api/monitor/detail?id=`). */
	id: string;
	name: string;
	kind: string;
	/** When it fires in words (`매일 07:30`, `평일 09:00`, `한 번 · 11-07 09:30`, …); an odd cron stays `cron <expr>`. */
	schedule: string;
	/** A cron's expression and time zone (`30 7 * * * (Asia/Seoul)`); null for other triggers. */
	cron: string | null;
	/** The instruction's first sentence as one masked line of at most {@link PREVIEW_CHARS} chars. */
	summary: string;
	/** Where the answer goes: `오너 DM`, `로그 채널`, `에스컬레이션 채널` or `채널 <ID>`. */
	destination: string;
	/** Where the copy goes, named like `destination`; null without a copy channel. */
	copyTo: string | null;
	/** null = the default model. */
	model: string | null;
	thinking: string | null;
	deliver: MonitorDeliver;
	overlap: MonitorOverlap;
	/** Its procedure files and the scripts its instruction names, at most {@link MONITOR_FILES}. */
	files: MonitorFile[];
	nextFireAt: string | null;
	lastStage: string | null;
	lastAt: string | null;
	openIncidents: number;
	/** The last {@link MONITOR_RECENT} events, oldest first. */
	recent: Array<{ stage: string; manual: boolean; at: string }>;
	/** The newest event; null before the first. */
	lastRun: MonitorRun | null;
	/** Whether any scheduled (not manual) event exists, beyond {@link recent} too. */
	scheduledRun: boolean;
	/** Its conversation's origin key (`monitor/<id>`), as the turn board lists it. */
	originKey: string;
	/** Whether the newest event is still on its way (not in {@link ENDED_STAGES}). */
	running: boolean;
	/** How many of the newest events in a row failed (`failed`, `failed_no_retry`), counted over {@link recent}. */
	failStreak: number;
	stats: MonitorStats;
}

const MONITOR_RECENT = 7;
const MONITOR_STATS_DAYS = 30;
const APPROVAL_STATS_DAYS = 7;
const APPROVAL_RECENT = 20;
const MONITOR_FILES = 4;
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토", "일"];
/** Stages after which an event is over (the rest are still on their way). */
const ENDED_STAGES: Record<string, true> = {
	delivered: true,
	no_report: true,
	failed: true,
	failed_no_retry: true,
	skipped: true,
};
/** A script path in an instruction; no backtick, quote or Hangul in the set, so `` `…/x.py`를 `` gives `…/x.py`. */
const SCRIPT_PATH = /[A-Za-z0-9_.~/-]+\.(?:py|sh|ts|js)(?![A-Za-z0-9_])/g;
/** A Korean sentence end: a syllable, then `.`/`?`/`!` before a space or the line end (`README.md 의` is not one). */
const SENTENCE_END = /[가-힣][.?!](?=\s|$)/;

/** Slot to settle (`updated_at − slot_at`, ≥ 0, retry waits included) of an ended event; null while running. */
export function monitorDurationMs(stage: string, slotAt: number, updatedAt: number): number | null {
	return ENDED_STAGES[stage] === true ? Math.max(0, updatedAt - slotAt) : null;
}

/** The middle value (the mean of the two middle ones for an even count), rounded; null for none. */
function median(values: number[]): number | null {
	const sorted = values.slice().sort((a, b) => a - b);
	const upper = sorted[sorted.length >> 1];
	if (upper === undefined) return null;
	return sorted.length % 2 === 1 ? upper : Math.round(((sorted[(sorted.length >> 1) - 1] ?? upper) + upper) / 2);
}

/** One monitor's ended events slotted since `now − MONITOR_STATS_DAYS`, by outcome. */
function monitorStats(db: Database, monitorId: string, now: number): MonitorStats {
	const stats: MonitorStats = {
		days: MONITOR_STATS_DAYS,
		delivered: 0,
		quiet: 0,
		failed: 0,
		skipped: 0,
		medianMs: null,
	};
	const events = rows<{ stage: string; manual: number; slot_at: number; updated_at: number }>(
		db,
		"SELECT stage, manual, slot_at, updated_at FROM monitor_events WHERE monitor_id = ? AND slot_at >= ?",
		monitorId,
		now - MONITOR_STATS_DAYS * 86_400_000,
	);
	const took: number[] = [];
	for (const event of events) {
		if (event.stage === "failed" || event.stage === "failed_no_retry") stats.failed++;
		else if (event.stage === "skipped") stats.skipped++;
		else if (event.stage === "delivered" || event.stage === "no_report") {
			if (event.stage === "delivered") stats.delivered++;
			else stats.quiet++;
			if (event.manual === 0) took.push(Math.max(0, event.updated_at - event.slot_at));
		}
	}
	stats.medianMs = median(took);
	return stats;
}

/** A cron expression in words, in the monitor's own time zone (named when not Asia/Seoul); else `cron <expr>`. */
function cronWords(schedule: string, timezone: string): string {
	const fields = schedule.trim().split(/\s+/);
	const [minute = "", hour = "", dom, month, dow = ""] = fields;
	const upTo = (field: string, max: number): boolean => /^\d{1,2}$/.test(field) && Number(field) <= max;
	const pad = (field: string): string => field.padStart(2, "0");
	let words: string | undefined;
	if (fields.length === 5 && dom === "*" && month === "*") {
		if (upTo(minute, 59) && upTo(hour, 23)) {
			const time = `${pad(hour)}:${pad(minute)}`;
			if (dow === "*") words = `매일 ${time}`;
			else if (dow === "1-5") words = `평일 ${time}`;
			else if (/^[0-7](?:,[0-7])*$/.test(dow)) {
				words = `매주 ${[...new Set(dow.split(",").map((day) => WEEKDAYS[Number(day)]))].join("·")} ${time}`;
			}
		} else if (hour === "*" && dow === "*") {
			if (upTo(minute, 59)) words = `매시 ${pad(minute)}분`;
			else if (/^\*\/[1-9]\d?$/.test(minute)) words = `${Number(minute.slice(2))}분마다`;
		}
	}
	const label = words ?? `cron ${schedule}`;
	return timezone === DEFAULT_TIMEZONE ? label : `${label} (${timezone})`;
}

function monitorSchedule(trigger: MonitorTrigger): string {
	switch (trigger.kind) {
		case "cron":
			return cronWords(trigger.schedule, trigger.timezone);
		case "at":
			return `한 번 · ${formatKst(Date.parse(trigger.at)).slice(5, 16).replace("T", " ")}`;
		case "script": {
			const every = trigger.intervalMs;
			return `조건 감시 · ${every % 60_000 === 0 ? `${every / 60_000}분` : `${every / 1000}초`}마다`;
		}
		case "webhook":
			return "외부 호출 때";
		case "watcher":
			return "파일 바뀔 때";
	}
}

/** The first sentence ({@link SENTENCE_END}) of the masked instruction's first line, as a {@link previewLine}. */
function monitorSummary(instruction: string): string {
	const line = redact(instruction).trim().split("\n")[0] ?? "";
	const end = SENTENCE_END.exec(line);
	return previewLine(end === null ? line : line.slice(0, end.index + 2));
}

/** File names of the procedure files, then of the scripts the instruction names; no directories, no repeats. */
function monitorFiles(row: MonitorRow): MonitorFile[] {
	const files: MonitorFile[] = [];
	const paths: Array<[MonitorFile["kind"], string]> = [
		...row.procedureFiles.map((path): [MonitorFile["kind"], string] => ["procedure", path]),
		...Array.from(row.instruction.matchAll(SCRIPT_PATH), (match): [MonitorFile["kind"], string] => [
			"script",
			match[0],
		]),
	];
	for (const [kind, path] of paths) {
		const name = redact(path.slice(path.lastIndexOf("/") + 1));
		if (name !== "" && !files.some((file) => file.name === name)) files.push({ kind, name });
	}
	return files.slice(0, MONITOR_FILES);
}

/** A Slack channel as the owner knows it: the DM, the config's log or escalation channel, else its id. */
function channelName(channel: string | null, config: DashboardConfig | undefined): string {
	if (channel === null) return "오너 DM";
	if (channel === config?.logChannel) return "로그 채널";
	if (channel === config?.escalationChannel) return "에스컬레이션 채널";
	return `채널 ${channel}`;
}

export interface AlertInfo {
	scope: string;
	signature: string;
	count: number;
	lastAt: string;
	incidentId: number;
	firstAt: string;
	status: string;
	/** `gate:<name>` rows only: that gate in this snapshot's `gates`; `unknown` when gates failed or lack it. */
	gateState?: GateState | "unknown";
}

/** A backup stamp's time and age. */
export interface StampAge {
	at: string;
	ageMs: number;
}

export interface BackupInfo {
	/** `<home>/backups/last-backup.ok`; absent when no backup has stamped yet. */
	local?: StampAge;
	/** `null` when config has no `offsite`; absent when it has one but no `offsite.ok` stamp exists. */
	offsite?: StampAge | null;
}

/** `<home>/jobs/<name>.json` names the dashboard reads; any other entry of the directory is skipped unread. */
const JOB_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const JOB_LIMIT = 50;
/** A running job whose `updatedAt` is older than this reads as `stale`. */
export const JOB_STALE_MS = 10 * 60_000;
/** A `done` or `stopped` job leaves the list once its `updatedAt` is older than this. */
export const JOB_DONE_KEEP_MS = 24 * 3_600_000;
const JOB_TITLE_CHARS = 120;
const JOB_DETAIL_CHARS = 200;
const JOB_FIELD_CHARS = 200;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

export type JobState = "running" | "done" | "stopped" | "failed";
/**
 * ok: running and updated within {@link JOB_STALE_MS}, or done, or stopped on purpose · stale: running, not updated since · dead: running, its
 * `pid` is gone · failed: `state: "failed"` · invalid: the file is not JSON or lacks `state`/`updatedAt`.
 */
export type JobHealth = "ok" | "stale" | "dead" | "failed" | "invalid";

/** One long-running job's progress file (`<home>/jobs/<name>.json`), read and never written by the dashboard. */
export interface JobInfo {
	name: string;
	/** Masked, at most 120 chars; the file name for an `invalid` file. */
	title: string;
	/** null for an `invalid` file. */
	state: JobState | null;
	/** `done`/`total` only when both are integers ≥ 0 with `done ≤ total`. */
	done?: number;
	total?: number;
	unit?: string;
	/** `done/total` in percent, one decimal; absent when `total` is 0 or the counts are absent. */
	percent?: number;
	startedAt?: string;
	/** The file's `updatedAt` (its modification time for an `invalid` file), KST. */
	updatedAt: string;
	ageMs: number;
	pid?: number;
	/** Conversation the job was started from (`<channel>:<ts>`); shown as text only. */
	thread?: string;
	/** Masked, at most 200 chars; what was wrong for an `invalid` file. */
	detail?: string;
	/** Log path as text; the file is never opened. */
	log?: string;
	health: JobHealth;
}

/** Days the dashboard's feedback counts cover, and the 👎 turns it lists. */
export const FEEDBACK_DAYS = 7;
const FEEDBACK_RECENT = 20;

/** One turn whose current verdict is 👎. */
export interface FeedbackTurn {
	/** The turn's first inbound row (opens its waterfall); null when the row is gone. */
	inboundId: number | null;
	originKey: string;
	/** When the verdict was set (KST). */
	at: string;
	/** The request in one masked line of at most {@link PREVIEW_CHARS} chars; null for monitor turns or no row. */
	preview: string | null;
}

/** The owner's 👍/👎 per turn (a turn with reactions on several parts counts once) over the last `days`. */
export interface FeedbackInfo {
	days: number;
	up: number;
	down: number;
	/** 👎 turns, newest verdict first. */
	recentDown: FeedbackTurn[];
	/** Verdict by inbound id (as text) for every row of a judged turn: the turn board's and waterfall's badges. */
	verdicts: Record<string, FeedbackVerdict>;
}

export interface DashboardSnapshot {
	generatedAt: string;
	daemon: Section<DaemonInfo>;
	turns: Section<{ items: TurnInfo[]; threads: ThreadInfo[] }>;
	feedback: Section<FeedbackInfo>;
	tasks: Section<{ items: TaskInfo[] }>;
	/** Always built; optional only so snapshots made before the flow view still type. */
	flows?: Section<{ items: FlowChainInfo[] }>;
	lanes: Section<{ items: LaneInfo[] }>;
	/** `herdr agent list` per host; while the agent board is live, its column counts instead (`hosts` empty). */
	herdr: Section<{ hosts: HerdrHostInfo[]; board?: BoardSummary }>;
	/** `items`: the pending ones, oldest first; `recent`: the last settled ones, newest first. */
	approvals: Section<{ items: ApprovalInfo[]; recent: ApprovalDecision[]; stats: ApprovalStats }>;
	monitors: Section<{ items: MonitorInfo[] }>;
	alerts: Section<{ items: AlertInfo[] }>;
	/** Every health gate, as `ompbot gates` lists them. */
	gates: Section<{ items: Gate[] }>;
	backup: Section<BackupInfo>;
	/** Progress files of long-running jobs outside the bot (`<home>/jobs/*.json`), newest update first. */
	jobs: Section<{ items: JobInfo[] }>;
	/**
	 * The Slack workspace id (config `slack.teamId`) the turn panels' 슬랙 스레드에서 답하기 link needs; null without
	 * it. Always built; optional only so hand-made snapshots still type.
	 */
	slackTeam?: string | null;
}

export type DashboardConfig = Partial<
	Pick<OmpbotConfig, "agent" | "ompExecutable" | "offsite" | "herdr" | "dispatchHosts" | "herdrBoard" | "costCap">
> &
	Partial<Pick<OmpbotConfig, "logChannel" | "escalationChannel">> & {
		/** Only the workspace id is read, for the `slack://` links of the turn panels. */
		slack?: { teamId?: string };
	};

export interface SnapshotDeps {
	homeDir: string;
	/** Checkout whose short HEAD is shown. */
	repoDir: string;
	/** Absent for a home without config.json: no herdr, no board, local tasks only. */
	config: DashboardConfig | undefined;
	now(): number;
	callDaemon(socketPath: string, request: unknown, timeoutMs: number): Promise<unknown>;
	/** herdr, ssh and git calls. */
	run: ProcessRunner;
	/** omp version line for the database fallback (the daemon reports its own). */
	ompVersion(): Promise<string>;
	/** File and git access of a task's host (`null` = local); throws for an unknown host. */
	hostOps(host: string | null): TaskHostOps;
	/** fetch used to resolve board card links. */
	fetch?: typeof fetch;
	/** The live agent board (config has `herdrBoard`); undefined before its first list or while it is down. */
	board?: () => BoardState | undefined;
	/** The health gates; default {@link collectGates}. */
	collectGates?: (options: GatesOptions) => Gate[];
	/** Whether a job's `pid` still runs; default {@link processAlive}. */
	isAlive?: (pid: number) => boolean;
}

const message = (error: unknown): string =>
	redact(error instanceof Error ? error.message : String(error)).slice(0, ERROR_CHARS);

async function section<T>(build: () => T | Promise<T>): Promise<Section<T>> {
	try {
		return { ok: true, ...(await build()) };
	} catch (error) {
		return { ok: false, error: message(error) };
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	const { promise: timeout, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Rows of a read-only query; a database that predates the table simply has none. */
function rows<T>(db: Database, sql: string, ...params: Array<string | number>): T[] {
	try {
		return db.query(sql).all(...params) as T[];
	} catch (error) {
		if (error instanceof Error && /no such table/.test(error.message)) return [];
		throw error;
	}
}

const APPROVAL_TITLE_CHARS = 80;

/** First sentence (`.`/`!`/`?` before a space, or `。`) of the first line, cut to 80 characters with `…`. */
function approvalTitle(summary: string): string {
	const line = summary.split("\n")[0]?.trim() ?? "";
	const sentence = (/^.*?(?:[.!?](?=\s)|。)/.exec(line)?.[0] ?? line).trim();
	const title = sentence === "" ? summary.trim() : sentence;
	if (title.length <= APPROVAL_TITLE_CHARS) return title;
	const last = title.charCodeAt(APPROVAL_TITLE_CHARS - 2);
	const cut = last >= 0xd800 && last <= 0xdbff ? APPROVAL_TITLE_CHARS - 2 : APPROVAL_TITLE_CHARS - 1;
	return `${title.slice(0, cut)}…`;
}

/** The stored card sections, masked again; null when absent, unparsable or empty. */
function approvalDetail(json: string | null): ApprovalInfo["detail"] {
	if (json === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const fields = new Map<string, unknown>(Object.entries(parsed));
	const detail: NonNullable<ApprovalInfo["detail"]> = {};
	for (const key of ["action", "why", "impact", "rollback"] as const) {
		const value = fields.get(key);
		if (typeof value === "string" && value.trim() !== "") detail[key] = redact(value);
	}
	return Object.keys(detail).length === 0 ? null : detail;
}

/** The approvals settled since `now − APPROVAL_STATS_DAYS` (by `decided_at`, else `created_at`), by outcome. */
function approvalStats(db: Database, now: number): ApprovalStats {
	const settled = rows<{ status: ApprovalOutcomeStatus; created_at: number; decided_at: number | null }>(
		db,
		"SELECT status, created_at, decided_at FROM approvals WHERE status != 'pending' AND COALESCE(decided_at, created_at) >= ?",
		now - APPROVAL_STATS_DAYS * 86_400_000,
	);
	const stats: ApprovalStats = {
		days: APPROVAL_STATS_DAYS,
		approved: 0,
		denied: 0,
		expired: 0,
		replied: 0,
		medianAnswerMs: null,
	};
	const answers: number[] = [];
	for (const row of settled) {
		stats[row.status]++;
		if (row.status !== "expired" && row.decided_at !== null) answers.push(Math.max(0, row.decided_at - row.created_at));
	}
	stats.medianAnswerMs = median(answers);
	return stats;
}

/** `DM` for any platform's owner DM; a channel by its id, named after its platform when that is not Slack. */
function originLabel(originKey: string | null): string | null {
	if (originKey === null) return null;
	if (parseChatOrigin(originKey)?.kind === "dm") return "DM";
	const channel = /^(slack|discord)\/ch\/([^/]+)(\/t\/[^/]+)?$/.exec(originKey);
	if (channel === null) return originKey;
	const platform = channel[1] === "discord" ? "Discord " : "";
	return `${platform}채널 ${channel[2]} ${channel[3] === undefined ? "메인" : "스레드"}`;
}

/** Identical commands inside one snapshot share one process (one `herdr agent list` per host). */
function sharedRunner(run: ProcessRunner): ProcessRunner {
	const calls = new Map<string, Promise<RunProcessResult>>();
	return (cmd, opts) => {
		const key = JSON.stringify(cmd);
		let call = calls.get(key);
		if (call === undefined) {
			call = run(cmd, opts);
			calls.set(key, call);
		}
		return call;
	};
}

/** GETs of one URL inside one snapshot share one request (the board's `/api/machines` once for every TASK link). */
function sharedFetch(fetcher: typeof fetch): typeof fetch {
	const calls = new Map<string, Promise<Response>>();
	return ((input: string | URL | Request, init?: RequestInit) => {
		const key = input instanceof Request ? input.url : String(input);
		let call = calls.get(key);
		if (call === undefined) {
			call = fetcher(input, init);
			calls.set(key, call);
		}
		return call.then((response) => response.clone());
	}) as typeof fetch;
}

function isStatusResponse(value: unknown): value is { ok: true; status: StatusReport } {
	return typeof value === "object" && value !== null && "ok" in value && value.ok === true && "status" in value;
}

function summarizeStatus(report: StatusReport): Omit<DaemonInfo, "heartbeat" | "commit"> {
	return {
		running: report.daemonRunning,
		ompVersion: report.ompVersion,
		origins: report.origins.length,
		busy: report.origins.filter((origin) => origin.busy).length,
		ledger: report.ledger,
		inbound: report.inbound,
		monitors: report.monitors,
		openGates: report.openGates,
		...(report.frozen === undefined ? {} : { frozen: { ...report.frozen, reason: redact(report.frozen.reason) } }),
		...(report.drain === undefined ? {} : { drain: report.drain }),
	};
}

interface TaskSql {
	task_id: string;
	title: string;
	risk: TaskRisk;
	origin_key: string;
	thread_ref: string;
	host: string | null;
	repo: string;
	worktree: string;
	branch: string;
	agent: string;
	status: TaskStatus;
	acceptance_json: string;
	created_at: number;
	updated_at: number;
	progress_at: number | null;
	reminded_at: number | null;
	notices_json: string;
	closed_at: number | null;
}

/** A task row and the JSON columns that were damaged in the database (read as `[]`/`{}`). */
interface ReadTask {
	row: TaskRow;
	broken: string[];
}

const toTaskRow = (r: TaskSql): ReadTask => {
	const { acceptance, notices, broken } = parseTaskJson(r.acceptance_json, r.notices_json);
	return {
		row: {
			taskId: r.task_id,
			title: r.title,
			risk: r.risk,
			originKey: r.origin_key,
			threadRef: r.thread_ref,
			host: r.host,
			repo: r.repo,
			worktree: r.worktree,
			branch: r.branch,
			agent: r.agent,
			status: r.status,
			acceptance,
			createdAt: r.created_at,
			updatedAt: r.updated_at,
			progressAt: r.progress_at,
			remindedAt: r.reminded_at,
			notices,
			closedAt: r.closed_at,
		},
		broken,
	};
};

interface HerdrTarget {
	/** `local` or the `dispatchHosts` name. */
	host: string;
	herdrBin: string;
	sshTarget?: string;
	timeoutMs: number;
}

type HerdrListing = { ok: true; agents: HerdrAgentInfo[] } | { ok: false; error: string };

function herdrTargets(config: DashboardConfig | undefined): HerdrTarget[] {
	if (config?.herdr === undefined) return [];
	const targets: HerdrTarget[] = [
		{ host: "local", herdrBin: config.herdr.bin ?? "herdr", timeoutMs: HERDR_LOCAL_TIMEOUT_MS },
	];
	for (const [host, entry] of Object.entries(config.dispatchHosts ?? {})) {
		targets.push({ host, herdrBin: entry.herdrBin ?? "herdr", sshTarget: entry.ssh, timeoutMs: HERDR_SSH_TIMEOUT_MS });
	}
	return targets;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** One `herdr agent list` of a host, parsed at this boundary (outside-controlled JSON). */
async function listHerdrAgents(target: HerdrTarget, run: ProcessRunner): Promise<HerdrListing> {
	const args = ["agent", "list"];
	const cmd =
		target.sshTarget === undefined ? [target.herdrBin, ...args] : herdrSshArgv(target.sshTarget, target.herdrBin, args);
	const result = await run(cmd, { timeoutMs: target.timeoutMs });
	if (result.code !== 0 || result.timedOut) {
		const detail = result.timedOut
			? "timed out"
			: result.stderr?.trim() || result.stdout.trim() || `exit ${result.code}`;
		return { ok: false, error: `agent list failed: ${message(detail)}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		return { ok: false, error: "agent list output is not JSON" };
	}
	const agents = (parsed as { result?: { agents?: unknown } } | null)?.result?.agents;
	if (!Array.isArray(agents)) return { ok: false, error: "agent list output has no agents" };
	return {
		ok: true,
		agents: agents.map((entry: Record<string, unknown>) => ({
			name: str(entry?.name),
			agent: str(entry?.agent),
			agentStatus: str(entry?.agent_status),
			cwd: str(entry?.cwd),
			paneId: str(entry?.pane_id),
			terminalTitle: redact(str(entry?.terminal_title)),
		})),
	};
}

/** A request as one masked line: secrets masked, Slack links and attachment notes folded, whitespace collapsed, cut to the limit. */
function previewLine(text: string): string {
	const line = redact(text)
		.replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
		.replace(/<https?:\/\/([^>]+)>/g, "$1")
		.replace(/\[첨부: [^\]]*\]/g, "[첨부]")
		.replace(/\s+/g, " ")
		.trim();
	const chars = Array.from(line);
	return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS - 1).join("")}…` : line;
}

/**
 * Turn feedback of the last `days` through a read-only handle: up/down turn counts, the 👎 turns (newest first, at
 * most `limit`) with their masked request line, and the verdict of every inbound row of any judged turn (not cut to
 * `days`: a recent-turn line must badge like the waterfall it opens).
 */
export function readFeedbackSummary(db: Database, now: number, window: { days: number; limit?: number }): FeedbackInfo {
	const since = now - window.days * 24 * 3_600_000;
	const judged = readTurnVerdicts(db, 0);
	const turns = judged.filter((turn) => turn.at >= since);
	const rowsOf = db.query<{ inbound_id: number }, [string, string]>(
		"SELECT inbound_id FROM inbound WHERE origin_key = ? AND op_ref = ?",
	);
	const textOf = db.query<{ text_ref: string }, [number]>("SELECT text_ref FROM inbound WHERE inbound_id = ?");
	const verdicts: Record<string, FeedbackVerdict> = {};
	for (const turn of judged) {
		for (const row of rowsOf.all(turn.originKey, turn.opRef)) verdicts[String(row.inbound_id)] = turn.verdict;
	}
	const down = turns.filter((turn) => turn.verdict === "down");
	return {
		days: window.days,
		up: turns.length - down.length,
		down: down.length,
		recentDown: down.slice(0, window.limit).map((turn) => {
			const text =
				turn.inboundId === null || turn.originKey.startsWith(MONITOR_ORIGIN_PREFIX) ? null : textOf.get(turn.inboundId);
			return {
				inboundId: turn.inboundId,
				originKey: turn.originKey,
				at: formatKst(turn.at),
				preview: text === null ? null : previewLine(text.text_ref),
			};
		}),
		verdicts,
	};
}

/** `kill(pid, 0)`: no such process (ESRCH) is dead; any other answer (EPERM: someone else's process) is alive. */
export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** Masked and cut to `limit` chars (the last one `…` when cut); undefined for a missing or blank value. */
function jobText(value: unknown, limit: number): string | undefined {
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const chars = Array.from(redact(value));
	return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : chars.join("");
}

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** One job file; a file that cannot be read as a job comes back `invalid` instead of failing the section. */
function readJob(dir: string, file: string, now: number, isAlive: (pid: number) => boolean): JobInfo {
	const name = file.slice(0, -".json".length);
	const path = join(dir, file);
	const invalid = (why: string): JobInfo => {
		let modified = now;
		try {
			modified = statSync(path).mtimeMs;
		} catch {
			modified = now; // removed since the listing: its age is unknown
		}
		return {
			name,
			title: file,
			state: null,
			updatedAt: formatKst(modified),
			ageMs: now - modified,
			detail: jobText(why, JOB_DETAIL_CHARS) ?? "",
			health: "invalid",
		};
	};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return invalid(`읽기 실패: ${message(error)}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return invalid("JSON 객체가 아님");
	const fields = parsed as Record<string, unknown>;
	const state = fields.state;
	if (state !== "running" && state !== "done" && state !== "stopped" && state !== "failed") {
		return invalid("state가 없거나 running·done·stopped·failed가 아님");
	}
	const updatedMs =
		typeof fields.updatedAt === "string" && ISO_8601.test(fields.updatedAt) ? Date.parse(fields.updatedAt) : Number.NaN;
	if (Number.isNaN(updatedMs)) return invalid("updatedAt이 없거나 ISO 8601 시각이 아님");
	const startedMs =
		typeof fields.startedAt === "string" && ISO_8601.test(fields.startedAt) ? Date.parse(fields.startedAt) : Number.NaN;
	const { done, total } = fields;
	const counts = isCount(done) && isCount(total) && done <= total;
	const pid = Number.isSafeInteger(fields.pid) && (fields.pid as number) > 0 ? (fields.pid as number) : undefined;
	const ageMs = now - updatedMs;
	const health: JobHealth =
		state === "failed"
			? "failed"
			: state === "done" || state === "stopped"
				? "ok"
				: pid !== undefined && !isAlive(pid)
					? "dead"
					: ageMs > JOB_STALE_MS
						? "stale"
						: "ok";
	const unit = jobText(fields.unit, JOB_FIELD_CHARS);
	const thread = jobText(fields.thread, JOB_FIELD_CHARS);
	const detail = jobText(fields.detail, JOB_DETAIL_CHARS);
	const log = jobText(fields.log, JOB_FIELD_CHARS);
	return {
		name,
		title: jobText(fields.title, JOB_TITLE_CHARS) ?? name,
		state,
		...(counts ? { done, total } : {}),
		...(counts && total > 0 ? { percent: Math.round((done / total) * 1000) / 10 } : {}),
		...(unit === undefined ? {} : { unit }),
		...(Number.isNaN(startedMs) ? {} : { startedAt: formatKst(startedMs) }),
		updatedAt: formatKst(updatedMs),
		ageMs,
		...(pid === undefined ? {} : { pid }),
		...(thread === undefined ? {} : { thread }),
		...(detail === undefined ? {} : { detail }),
		...(log === undefined ? {} : { log }),
		health,
	};
}

/**
 * `<home>/jobs/<name>.json` files whose name passes {@link JOB_NAME}: newest update first, at most {@link JOB_LIMIT},
 * `done` and `stopped` jobs only for {@link JOB_DONE_KEEP_MS}. No directory means no jobs. Reads only; never creates or removes.
 */
function readJobs(homeDir: string, now: number, isAlive: (pid: number) => boolean): JobInfo[] {
	const dir = join(homeDir, "jobs");
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json") && JOB_NAME.test(entry.name.slice(0, -5)))
		.map((entry) => readJob(dir, entry.name, now, isAlive))
		.filter((job) => !((job.state === "done" || job.state === "stopped") && job.ageMs > JOB_DONE_KEEP_MS))
		.sort((a, b) => a.ageMs - b.ageMs)
		.slice(0, JOB_LIMIT);
}

/** The inbound columns a turn row is read with. */
interface TurnSql {
	inbound_id: number;
	platform_message_id: string;
	origin_key: string;
	text_ref: string;
	thread_ref: string | null;
	state: string;
	created_at: number;
	dispatched_at: number | null;
	last_event_at: number | null;
}

/**
 * One read-only picture of the bot. Never opens a `Store` or the task ledger (both write on open: the store re-queues
 * inflight deliveries); every table is read through a `readonly` handle. Of message bodies only the turns of the board's
 * threads are read (open ones, and the last {@link THREAD_WINDOW_MS}'s), and only their masked one-line preview leaves
 * this function.
 */
export async function buildSnapshot(deps: SnapshotDeps): Promise<DashboardSnapshot> {
	const now = deps.now();
	const run = sharedRunner(deps.run);
	const machinesFetch = sharedFetch(deps.fetch ?? fetch);
	const { config } = deps;
	const dbPath = join(deps.homeDir, "ompbot.db");
	const db = existsSync(dbPath) ? new Database(dbPath, { readonly: true, strict: true }) : undefined;
	try {
		const needDb = (): Database => {
			if (db === undefined) throw new Error(`no database at ${dbPath}`);
			return db;
		};

		const targets = herdrTargets(config);
		// Run on first use only: with a live board and no open TASK on a host, that host's `herdr agent list` is not needed.
		const listings = new Map<string, Promise<HerdrListing>>();
		const listingOf = (host: string): Promise<HerdrListing> | undefined => {
			const target = targets.find((candidate) => candidate.host === host);
			if (target === undefined) return undefined;
			let listing = listings.get(host);
			if (listing === undefined) {
				listing = listHerdrAgents(target, run).catch((error: unknown) => ({
					ok: false as const,
					error: message(error),
				}));
				listings.set(host, listing);
			}
			return listing;
		};

		const daemon = section(async (): Promise<DaemonInfo> => {
			let report: StatusReport | undefined;
			try {
				const response = await deps.callDaemon(join(deps.homeDir, "ompbot.sock"), { op: "status" }, IPC_TIMEOUT_MS);
				if (isStatusResponse(response)) report = { ...response.status, daemonRunning: true };
			} catch {
				report = undefined; // no daemon answering: the database file tells the rest
			}
			if (report === undefined) {
				needDb();
				report = readStatusFromDb(
					dbPath,
					await deps.ompVersion(),
					config?.offsite !== undefined,
					config?.costCap?.dailyUsd,
				);
			}
			const info: DaemonInfo = summarizeStatus(report);
			const beat = readSweepHeartbeat(deps.homeDir);
			if (beat !== undefined) {
				info.heartbeat = {
					at: formatKst(beat.ts.getTime()),
					ageMs: now - beat.ts.getTime(),
					...(beat.loopMs === undefined ? {} : { loopMs: beat.loopMs }),
					...(beat.socket === undefined
						? {}
						: { socket: { state: beat.socket.state, since: formatKst(beat.socket.since.getTime()) } }),
					...(beat.discord === undefined
						? {}
						: { discord: { state: beat.discord.state, since: formatKst(beat.discord.since.getTime()) } }),
					...(beat.draining === undefined ? {} : { draining: beat.draining }),
				};
			}
			const head = await run(["git", "-C", deps.repoDir, "rev-parse", "--short", "HEAD"], {
				timeoutMs: GIT_TIMEOUT_MS,
			});
			const commit = head.stdout.trim();
			if (head.code === 0 && !head.timedOut && /^[0-9a-f]{4,40}$/.test(commit)) info.commit = commit;
			const startedAt = info.running ? readLockStartedAt(deps.homeDir) : undefined;
			if (startedAt !== undefined) info.started = { at: formatKst(startedAt), ageMs: now - startedAt };
			return info;
		});

		const turns = section(async () => {
			const handle = needDb();
			const TURN_COLUMNS = `inbound_id, platform_message_id, origin_key, text_ref, thread_ref, state, created_at,
				dispatched_at, last_event_at`;
			const open = rows<TurnSql>(
				handle,
				`SELECT ${TURN_COLUMNS} FROM inbound WHERE state IN ('pending','dispatched') ORDER BY created_at, inbound_id LIMIT ?`,
				TURN_LIMIT,
			);
			// Origins waiting on a live approval card, as `inbound_starved` counts them: a card past `expires_at` waits
			// on nobody even while its row still reads `pending`.
			const approvalColumns = new Set(
				rows<{ name: string }>(handle, "PRAGMA table_info(approvals)").map((column) => column.name),
			);
			const waitingOnOwner = new Set(
				approvalColumns.has("origin_key")
					? rows<{ origin_key: string }>(
							handle,
							`SELECT DISTINCT origin_key FROM approvals WHERE status = 'pending' AND origin_key IS NOT NULL${
								approvalColumns.has("expires_at") ? " AND expires_at > ?" : ""
							}`,
							...(approvalColumns.has("expires_at") ? [now] : []),
						).map((r) => r.origin_key)
					: [],
			);
			// A failed daemon section leaves drain and freeze unknown: the other wait reasons still apply.
			const status = await daemon;
			const draining = status.ok && (status.drain !== undefined || status.heartbeat?.draining === true);
			const frozen = status.ok && status.frozen !== undefined;
			const running = new Set(open.filter((r) => r.state === "dispatched").map((r) => r.origin_key));
			const turnOf = (r: TurnSql): TurnInfo => {
				const slash = r.platform_message_id.startsWith("slash:");
				const command = parseCommand(r.text_ref);
				const kind: TurnKind = r.origin_key.startsWith(MONITOR_ORIGIN_PREFIX)
					? "monitor"
					: command !== undefined || slash
						? "command"
						: r.text_ref.trimStart().startsWith(AUTO_FOLLOWUP_PREFIX)
							? "auto"
							: "message";
				const request =
					command === undefined
						? r.text_ref
						: `${COMMAND_TEXT[command.kind]}${command.arg === "" ? "" : ` ${command.arg}`}`;
				let waitReason: TurnWaitReason | null = null;
				if (r.state === "pending") {
					if (draining) waitReason = "restart";
					else if (frozen) waitReason = "frozen";
					else if (command?.kind === "followup") waitReason = "followup";
					else if (running.has(r.origin_key)) waitReason = "behind";
					else waitReason = "queued";
				}
				const lastSign = r.state === "dispatched" ? (r.last_event_at ?? r.dispatched_at) : null;
				const silentMs = lastSign === null ? null : now - lastSign;
				return {
					inboundId: r.inbound_id,
					originKey: r.origin_key,
					threadRef: r.thread_ref,
					state: r.state,
					createdAt: formatKst(r.created_at),
					ageMs: now - r.created_at,
					silentMs,
					stalled:
						r.dispatched_at !== null &&
						silentMs !== null &&
						silentMs > INBOUND_STARVATION_MS &&
						!waitingOnOwner.has(r.origin_key),
					kind,
					preview: kind === "monitor" ? null : previewLine(request),
					waitReason,
					blocksRestart: draining && r.state === "dispatched",
					topLevel: r.thread_ref?.endsWith(`:${TOP_LEVEL_TS}`) === true,
					slash,
				};
			};
			const brief = (turn: TurnInfo): ThreadTurn => ({
				inboundId: turn.inboundId,
				state: turn.state,
				createdAt: turn.createdAt,
				preview: turn.preview,
			});
			// Every conversation with an open turn, then the ones active in the window: newest activity first.
			const since = now - THREAD_WINDOW_MS;
			const ACTIVE = "COALESCE(last_event_at, dispatched_at, created_at)";
			const OPEN = "state IN ('pending','dispatched')";
			const monitorNames = new Map(
				rows<{ id: string; name: string }>(handle, "SELECT id, name FROM monitors").map((m) => [m.id, m.name]),
			);
			const threads = rows<{ origin_key: string; active: number }>(
				handle,
				`SELECT origin_key, MAX(${ACTIVE}) AS active, SUM(CASE WHEN ${OPEN} THEN 1 ELSE 0 END) AS open FROM inbound
					GROUP BY origin_key HAVING open > 0 OR active >= ? ORDER BY open > 0 DESC, active DESC LIMIT ?`,
				since,
				THREAD_LIMIT,
			).flatMap((thread): ThreadInfo[] => {
				const key = thread.origin_key;
				const recent = rows<TurnSql>(
					handle,
					`SELECT ${TURN_COLUMNS} FROM inbound WHERE origin_key = ? ORDER BY created_at DESC, inbound_id DESC LIMIT ?`,
					key,
					THREAD_RECENT,
				).map(turnOf);
				const [first] = rows<TurnSql>(
					handle,
					`SELECT ${TURN_COLUMNS} FROM inbound WHERE origin_key = ? ORDER BY created_at, inbound_id LIMIT 1`,
					key,
				).map(turnOf);
				const latest = recent[0];
				if (latest === undefined || first === undefined) return [];
				const openTurns = rows<TurnSql>(
					handle,
					`SELECT ${TURN_COLUMNS} FROM inbound WHERE origin_key = ? AND ${OPEN}`,
					key,
				).map(turnOf);
				const [count] = rows<{ n: number }>(
					handle,
					`SELECT COUNT(*) AS n FROM inbound WHERE origin_key = ? AND (${OPEN} OR ${ACTIVE} >= ?)`,
					key,
					since,
				);
				const [runs] = rows<{ n: number }>(
					handle,
					`SELECT COUNT(DISTINCT COALESCE(op_ref, 'row:' || inbound_id)) AS n FROM inbound
						WHERE origin_key = ? AND state = 'dispatched'`,
					key,
				);
				const stalledCount = openTurns.filter((turn) => turn.stalled).length;
				const column: ThreadColumn =
					stalledCount > 0 || (openTurns.length === 0 && latest.state === "failed_notified")
						? "attention"
						: openTurns.length > 0
							? "working"
							: "done";
				const monitor = key.startsWith(MONITOR_ORIGIN_PREFIX)
					? (monitorNames.get(key.slice(MONITOR_ORIGIN_PREFIX.length)) ?? key)
					: undefined;
				return [
					{
						originKey: key,
						threadRef: latest.threadRef ?? first.threadRef,
						kind: latest.kind,
						title: monitor ?? first.preview ?? key,
						column,
						latest: {
							...brief(latest),
							ageMs: latest.ageMs,
							silentMs: latest.silentMs,
							stalled: latest.stalled,
							waitReason: latest.waitReason,
						},
						turnCount: count?.n ?? 0,
						openCount: openTurns.length,
						runCount: runs?.n ?? 0,
						pendingCount: openTurns.filter((turn) => turn.state === "pending").length,
						stalledCount,
						updatedAt: formatKst(thread.active),
						recent: recent.map(brief),
					},
				];
			});
			return { items: open.map(turnOf), threads };
		});

		const herdrStateOf = async (row: TaskRow): Promise<HerdrState> => {
			if (config?.herdr === undefined) return { ok: false, error: "herdr is not configured" };
			const target = targets.find((candidate) => candidate.host === (row.host ?? "local"));
			if (target === undefined) return { ok: false, error: `unknown host: ${row.host}` };
			return herdrAgentStatus(row.agent, {
				herdrBin: target.herdrBin,
				timeoutMs: target.timeoutMs,
				run,
				...(target.sshTarget === undefined ? {} : { sshTarget: target.sshTarget }),
			});
		};

		const linkOf = async (row: TaskRow): Promise<string | undefined> => {
			const board = config?.herdrBoard;
			if (board === undefined) return undefined;
			const listing = await listingOf(row.host ?? "local");
			const paneId =
				listing?.ok === true ? listing.agents.find((agent) => agent.name === row.agent)?.paneId : undefined;
			return boardCardLink(board, row.host, paneId, { fetch: machinesFetch });
		};

		const describeOpen = async ({ row, broken }: ReadTask): Promise<TaskInfo> => {
			const info = baseTask({ row, broken });
			const [evaluation, herdr, link] = await Promise.all([
				withTimeout(
					(async () => evaluateTask(row, deps.hostOps(row.host)))(),
					TASK_EVAL_TIMEOUT_MS,
					`${row.taskId} evaluation`,
				).catch((error: unknown) => ({ ok: false as const, error: message(error) })),
				herdrStateOf(row),
				linkOf(row),
			]);
			if (evaluation.ok) {
				const j = evaluation.judgement;
				info.acChecked = j.acChecked;
				info.stepsDone = j.stepsDone;
				info.stepsTotal = j.stepsTotal;
				info.progress = {
					status: j.status,
					updated: j.updatedAt,
					current: redact(j.current),
					blockedReason: redact(j.blockedReason),
				};
				info.acceptance = j.acceptance.map((item) => ({ ...item, text: redact(item.text) }));
				info.steps = j.steps.map((step) => ({ ...step, text: redact(step.text) }));
			} else {
				const failure = message(evaluation.error);
				info.error = info.error === undefined ? failure : `${info.error} · ${failure}`;
			}
			info.herdr = herdr.ok ? herdr : { ok: false, error: message(herdr.error) };
			if (link !== undefined) info.link = link;
			return info;
		};

		const tasks = section(async () => {
			const handle = needDb();
			const open = rows<TaskSql>(
				handle,
				"SELECT * FROM tasks WHERE status IN ('working','blocked','review') ORDER BY task_id",
			).map(toTaskRow);
			const closed = rows<TaskSql>(
				handle,
				"SELECT * FROM tasks WHERE status IN ('done','cancelled') AND closed_at >= ? ORDER BY closed_at DESC LIMIT ?",
				now - CLOSED_TASK_DAYS * 86_400_000,
				CLOSED_TASK_LIMIT,
			).map(toTaskRow);
			return { items: [...(await Promise.all(open.map(describeOpen))), ...closed.map(baseTask)] };
		});

		const flows = section(() => {
			const handle = needDb();
			const since = now - FLOW_WINDOW_MS;
			const scope =
				"thread_ref IN (SELECT thread_ref FROM tasks WHERE created_at >= ? OR status IN ('working','blocked','review'))";
			const read = rows<TaskSql>(handle, `SELECT * FROM tasks WHERE ${scope} ORDER BY created_at, task_id`, since).map(
				(r) => toTaskRow(r).row,
			);
			const transitions = rows<FlowTransition>(
				handle,
				`SELECT task_id AS taskId, from_status AS fromStatus, to_status AS toStatus, actor, reason, at
				FROM task_transitions WHERE task_id IN (SELECT task_id FROM tasks WHERE ${scope}) ORDER BY transition_id`,
				since,
			);
			const statuses = taskFlowStatus(read, transitions);
			const threads = new Map<string, TaskRow[]>();
			for (const row of read) threads.set(row.threadRef, [...(threads.get(row.threadRef) ?? []), row]);
			const chains = [...threads].map(([threadRef, list]) => {
				const steps = list.map((row): FlowStepInfo => {
					const stage = taskStage(row, statuses);
					return {
						taskId: row.taskId,
						title: redact(row.title),
						status: row.status,
						risk: row.risk,
						host: row.host ?? "local",
						branch: row.branch,
						createdAt: formatKst(row.createdAt),
						...(row.closedAt === null ? {} : { closedAt: formatKst(row.closedAt) }),
						acTotal: row.acceptance.length,
						stage: { ...stage, msg: redact(stage.msg) },
					};
				});
				const open = list.filter((row) => row.status !== "done" && row.status !== "cancelled");
				const here = open.find((row) => row.status === "blocked") ?? open[0];
				const updatedAt = Math.max(...list.map((row) => row.updatedAt));
				let line: string;
				if (here === undefined) {
					const closedAt = Math.max(...list.map((row) => row.closedAt ?? row.updatedAt));
					line = `모두 끝남 · 마지막 close ${formatKst(closedAt).slice(5, 16).replace("T", " ")}`;
				} else {
					const stage = steps.find((step) => step.taskId === here.taskId)?.stage;
					const msg = Array.from((stage?.msg ?? "").replace(/\s+/g, " ").trim());
					const cut =
						msg.length > FLOW_NOW_MSG_CHARS ? `${msg.slice(0, FLOW_NOW_MSG_CHARS - 1).join("")}…` : msg.join("");
					line = `${here.taskId} ${stage?.label ?? ""}${cut === "" ? "" : ` · ${cut}`}${
						open.length > 1 ? ` · 외 열림 ${open.length - 1}` : ""
					}`;
				}
				const request = rows<{ text_ref: string; created_at: number }>(
					handle,
					"SELECT text_ref, created_at FROM inbound WHERE thread_ref = ? ORDER BY inbound_id LIMIT 1",
					threadRef,
				)[0];
				// Slack link markup: `<url|label>` reads as the label, `<url>` as host/path.
				const text = request?.text_ref
					.replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
					.replace(/<https?:\/\/([^>]+)>/g, "$1");
				const originKey = list[0]?.originKey ?? "";
				const info: FlowChainInfo = {
					threadRef,
					originKey,
					place: originLabel(originKey),
					title: text === undefined ? "(원문 없음)" : previewLine(text),
					requestedAt: request === undefined ? null : formatKst(request.created_at),
					updatedAt: formatKst(updatedAt),
					done: list.filter((row) => row.status === "done").length,
					total: list.length,
					here: here?.taskId ?? null,
					now: line,
					tasks: steps,
				};
				return { open: open.length > 0, updatedAt, info };
			});
			chains.sort((a, b) => Number(b.open) - Number(a.open) || b.updatedAt - a.updatedAt);
			return { items: chains.map((chain) => chain.info) };
		});

		const lanes = section(() => ({
			items: rows<{ name: string; title: string; status: string; cwd: string; updated_at: number }>(
				needDb(),
				"SELECT name, title, status, cwd, updated_at FROM lanes WHERE status != 'closed' ORDER BY updated_at DESC",
			).map((r) => ({
				name: r.name,
				title: redact(r.title),
				status: r.status,
				cwd: r.cwd,
				updatedAt: formatKst(r.updated_at),
			})),
		}));

		const herdr = section(async () => {
			const live = deps.board?.();
			if (live !== undefined) return { hosts: [] as HerdrHostInfo[], board: summarizeBoard(live) };
			const owners =
				db === undefined
					? []
					: rows<{ task_id: string; agent: string; host: string | null }>(db, "SELECT task_id, agent, host FROM tasks");
			if (targets.length === 0) {
				return { hosts: [{ host: "local", ok: false as const, error: "herdr is not configured" }] };
			}
			const hosts = await Promise.all(
				targets.map(async (target): Promise<HerdrHostInfo> => {
					const listing = (await listingOf(target.host)) as HerdrListing;
					if (!listing.ok) return { host: target.host, ok: false, error: listing.error };
					return {
						host: target.host,
						ok: true,
						agents: listing.agents.map((agent) => {
							const owner = owners.find((task) => task.agent === agent.name && (task.host ?? "local") === target.host);
							return owner === undefined ? agent : { ...agent, taskId: owner.task_id };
						}),
					};
				}),
			);
			return { hosts };
		});

		const approvals = section(() => {
			const handle = needDb();
			// A daemon still on the old code has not added the dashboard columns yet: read them as NULL.
			const present = new Set(rows<{ name: string }>(handle, "PRAGMA table_info(approvals)").map((c) => c.name));
			const optional = ["detail_json", "card_url", "origin_url"]
				.map((column) => (present.has(column) ? column : `NULL AS ${column}`))
				.join(", ");
			return {
				items: rows<{
					approval_id: string;
					summary: string;
					created_at: number;
					expires_at: number;
					origin_key: string | null;
					detail_json: string | null;
					card_url: string | null;
					origin_url: string | null;
				}>(
					handle,
					`SELECT approval_id, summary, created_at, expires_at, origin_key, ${optional} FROM approvals WHERE status = 'pending' ORDER BY created_at`,
				).map((r): ApprovalInfo => {
					const summary = redact(r.summary);
					return {
						approvalId: r.approval_id,
						summary,
						createdAt: formatKst(r.created_at),
						expiresAt: formatKst(r.expires_at),
						originKey: r.origin_key,
						title: approvalTitle(summary),
						detail: approvalDetail(r.detail_json),
						cardUrl: r.card_url?.startsWith("https://") ? r.card_url : null,
						originUrl: r.origin_url?.startsWith("https://") ? r.origin_url : null,
						remainingMs: Math.max(0, r.expires_at - now),
						originLabel: originLabel(r.origin_key),
					};
				}),
				recent: rows<{
					approval_id: string;
					summary: string;
					status: ApprovalOutcomeStatus;
					created_at: number;
					decided_at: number | null;
					origin_key: string | null;
					detail_json: string | null;
					card_url: string | null;
					origin_url: string | null;
				}>(
					handle,
					`SELECT approval_id, summary, status, created_at, decided_at, origin_key, ${optional} FROM approvals
					WHERE status != 'pending' ORDER BY COALESCE(decided_at, created_at) DESC, created_at DESC LIMIT ?`,
					APPROVAL_RECENT,
				).map((r): ApprovalDecision => {
					const summary = redact(r.summary);
					return {
						approvalId: r.approval_id,
						summary,
						title: approvalTitle(summary),
						status: r.status,
						createdAt: formatKst(r.created_at),
						decidedAt: r.decided_at === null ? null : formatKst(r.decided_at),
						tookMs: r.decided_at === null ? null : Math.max(0, r.decided_at - r.created_at),
						originKey: r.origin_key,
						originLabel: originLabel(r.origin_key),
						detail: approvalDetail(r.detail_json),
						cardUrl: r.card_url?.startsWith("https://") ? r.card_url : null,
						originUrl: r.origin_url?.startsWith("https://") ? r.origin_url : null,
					};
				}),
				stats: approvalStats(handle, now),
			};
		});

		const monitors = section(() => {
			const handle = needDb();
			const listed = rows<MonitorSql>(handle, "SELECT * FROM monitors WHERE enabled = 1").map((sql) => {
				const monitor = toMonitor(sql);
				const next = nextFireOf(monitor);
				// Newest first; `recent` turns them around.
				const events = rows<{ stage: string; slot_at: number; updated_at: number; attempts: number; manual: number }>(
					handle,
					"SELECT stage, slot_at, updated_at, attempts, manual FROM monitor_events WHERE monitor_id = ? ORDER BY event_id DESC LIMIT ?",
					monitor.id,
					MONITOR_RECENT,
				);
				const last = events[0];
				const firstNotFailed = events.findIndex(
					(event) => event.stage !== "failed" && event.stage !== "failed_no_retry",
				);
				const incidents = rows<{ n: number }>(
					handle,
					"SELECT COUNT(*) AS n FROM monitor_incidents WHERE monitor_id = ? AND status = 'alerted'",
					monitor.id,
				)[0];
				const { trigger } = monitor;
				const info: MonitorInfo = {
					id: monitor.id,
					name: redact(monitor.name),
					kind: trigger.kind,
					schedule: monitorSchedule(trigger),
					cron: trigger.kind === "cron" ? `${trigger.schedule} (${trigger.timezone})` : null,
					summary: monitorSummary(monitor.instruction),
					destination: channelName(monitor.channel, config),
					copyTo: monitor.copyChannel === null ? null : channelName(monitor.copyChannel, config),
					model: monitor.model,
					thinking: monitor.thinking,
					deliver: monitor.deliver,
					overlap: monitor.overlap,
					files: monitorFiles(monitor),
					nextFireAt: next === null ? null : formatKst(next),
					lastStage: last?.stage ?? null,
					lastAt: last === undefined ? null : formatKst(last.updated_at),
					openIncidents: incidents?.n ?? 0,
					recent: events
						.map((event) => ({ stage: event.stage, manual: event.manual === 1, at: formatKst(event.updated_at) }))
						.reverse(),
					lastRun:
						last === undefined
							? null
							: {
									stage: last.stage,
									at: formatKst(last.updated_at),
									slotAt: formatKst(last.slot_at),
									durationMs: monitorDurationMs(last.stage, last.slot_at, last.updated_at),
									attempts: last.attempts,
									manual: last.manual === 1,
								},
					scheduledRun:
						rows<{ n: number }>(
							handle,
							"SELECT EXISTS(SELECT 1 FROM monitor_events WHERE monitor_id = ? AND manual = 0) AS n",
							monitor.id,
						)[0]?.n === 1,
					originKey: monitorOrigin(monitor.id),
					running: last !== undefined && ENDED_STAGES[last.stage] !== true,
					failStreak: firstNotFailed < 0 ? events.length : firstNotFailed,
					stats: monitorStats(handle, monitor.id, now),
				};
				return { next, info };
			});
			// Next to fire first, monitors with no next fire last, then by name.
			listed.sort(
				(a, b) =>
					(a.next ?? Number.POSITIVE_INFINITY) - (b.next ?? Number.POSITIVE_INFINITY) ||
					a.info.name.localeCompare(b.info.name, "ko"),
			);
			return { items: listed.map(({ info }) => info) };
		});

		const gates = await section(() => ({
			items: (deps.collectGates ?? collectGates)({
				homeDir: deps.homeDir,
				now,
				...((config?.agent ?? "omp") === "omp" && config?.ompExecutable !== undefined
					? { ompExecutable: config.ompExecutable }
					: {}),
				offsiteConfigured: config?.offsite !== undefined,
				...(config?.costCap?.dailyUsd === undefined ? {} : { dailyCapUsd: config.costCap.dailyUsd }),
			}).map((gate) => ({ ...gate, detail: redact(gate.detail) })),
		}));

		const backup = section((): BackupInfo => {
			const dir = join(deps.homeDir, "backups");
			const age = (name?: string): StampAge | undefined => {
				const ts = readStamp(dir, name)?.ts.getTime();
				return ts === undefined ? undefined : { at: formatKst(ts), ageMs: now - ts };
			};
			const local = age();
			const offsite = config?.offsite === undefined ? null : age(OFFSITE_STAMP_FILE);
			return { ...(local === undefined ? {} : { local }), ...(offsite === undefined ? {} : { offsite }) };
		});

		const alerts = section(() => ({
			items: rows<{
				incident_id: number;
				scope: string;
				signature: string;
				status: string;
				count: number;
				first_at: number;
				last_at: number;
			}>(
				needDb(),
				"SELECT incident_id, scope, signature, status, count, first_at, last_at FROM alert_incidents WHERE status = 'alerted' ORDER BY last_at DESC",
			).map((r): AlertInfo => {
				const info: AlertInfo = {
					scope: r.scope,
					signature: redact(r.signature),
					count: r.count,
					lastAt: formatKst(r.last_at),
					incidentId: r.incident_id,
					firstAt: formatKst(r.first_at),
					status: r.status,
				};
				if (r.scope.startsWith("gate:")) {
					const name = r.scope.slice("gate:".length);
					info.gateState = (gates.ok ? gates.items.find((gate) => gate.name === name)?.state : undefined) ?? "unknown";
				}
				return info;
			}),
		}));

		const jobs = section(() => ({ items: readJobs(deps.homeDir, now, deps.isAlive ?? processAlive) }));

		const feedback = section(() => readFeedbackSummary(needDb(), now, { days: FEEDBACK_DAYS, limit: FEEDBACK_RECENT }));

		return {
			generatedAt: formatKst(now),
			daemon: await daemon,
			turns: await turns,
			feedback: await feedback,
			tasks: await tasks,
			flows: await flows,
			lanes: await lanes,
			herdr: await herdr,
			approvals: await approvals,
			monitors: await monitors,
			alerts: await alerts,
			gates,
			backup: await backup,
			jobs: await jobs,
			slackTeam: deps.config?.slack?.teamId ?? null,
		};
	} finally {
		db?.close();
	}
}

/**
 * Open TASKs (working, blocked, review) the board cards are matched against, through a read-only handle. A home
 * without a database or a tasks table has none.
 */
export function readBoardTasks(homeDir: string): BoardTaskRef[] {
	const dbPath = join(homeDir, "ompbot.db");
	if (!existsSync(dbPath)) return [];
	const db = new Database(dbPath, { readonly: true, strict: true });
	try {
		return rows<{ task_id: string; agent: string; worktree: string }>(
			db,
			"SELECT task_id, agent, worktree FROM tasks WHERE status IN ('working','blocked','review') ORDER BY task_id",
		).map((r) => ({ taskId: r.task_id, agent: r.agent, worktree: r.worktree }));
	} finally {
		db.close();
	}
}

function baseTask({ row, broken }: ReadTask): TaskInfo {
	const open = row.status !== "done" && row.status !== "cancelled";
	return {
		taskId: row.taskId,
		title: redact(row.title),
		risk: row.risk,
		status: row.status,
		host: row.host ?? "local",
		agent: row.agent,
		branch: row.branch,
		open,
		updatedAt: formatKst(row.updatedAt),
		...(row.closedAt === null ? {} : { closedAt: formatKst(row.closedAt) }),
		acTotal: row.acceptance.length,
		...(broken.length === 0 ? {} : { error: `${broken.join("·")} 손상` }),
	};
}

/**
 * The snapshot behind every request: reused for `ttlMs` after it was built, and requests that arrive while one is
 * being built wait for that same build. A failed build is not kept, and neither is one still running after
 * `buildTimeoutMs`: its waiters are rejected and the next request starts a new build.
 */
export function createSnapshotCache(
	build: () => Promise<DashboardSnapshot>,
	now: () => number,
	ttlMs: number = SNAPSHOT_TTL_MS,
	buildTimeoutMs: number = SNAPSHOT_BUILD_TIMEOUT_MS,
): () => Promise<DashboardSnapshot> {
	let cached: { at: number; snapshot: DashboardSnapshot } | undefined;
	let pending: Promise<DashboardSnapshot> | undefined;
	return () => {
		if (cached !== undefined) {
			const age = now() - cached.at;
			if (age >= 0 && age < ttlMs) return Promise.resolve(cached.snapshot);
		}
		if (pending === undefined) {
			pending = withTimeout(build(), buildTimeoutMs, "snapshot build")
				.then((snapshot) => {
					cached = { at: now(), snapshot };
					return snapshot;
				})
				.finally(() => {
					pending = undefined;
				});
		}
		return pending;
	};
}
