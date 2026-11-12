import { Database } from "bun:sqlite";
import { parseThreadRef, platformOfThreadRef, THREAD_LINK_PREFIX, TOP_LEVEL_TS, threadRefOf } from "../core/normalize";
import {
	type ChatPlatform,
	chatPlatformOf,
	type IdPlatform,
	parseChatOrigin,
	platformOfConversationId,
} from "../core/origin-key";
import { COMMAND_OP_REF, parseCommand } from "../core/types";
import { previewLine } from "../dashboard/snapshot";
import {
	assertLaneTransition,
	LANE_ORIGIN_PREFIX,
	type LaneHistoryEntry,
	type LaneMeta,
	type LaneRow,
	type LaneStatus,
} from "../lanes/status";
import { countIncident, resolveIncidents } from "../monitors/incidents";
import {
	MONITOR_ORIGIN_PREFIX,
	MonitorLedger,
	type MonitorRow,
	monitorOrigin,
	withoutMarkerLines,
} from "../monitors/ledger";
import type { ApprovalDetail } from "../safety/approval";
import { TaskLedger } from "../tasks/ledger";
import { FEEDBACK_DDL, FeedbackLedger } from "./feedback";
import {
	assertInboundTransition,
	type DeliveryEvent,
	type DeliveryFacts,
	type DeliveryState,
	FRESHNESS_MS,
	type InboundState,
	StoreError,
	transitionDelivery,
} from "./transitions";

/** Words a placeholder answer uses when omp returned no text (mailbox writes it); a monitor treats it as a failure. */
const EMPTY_ANSWER = "(응답 없음)";

/** Op ref suffix of the copy delivery of a completion report / monitor event (same origin, distinct unique key). */
export const LOG_COPY_SUFFIX = ":log-copy";
const MONITOR_COPY_SUFFIX = ":copy";
/** Op ref infix of the pointer a steered message's own thread gets (`<opRef>:steer:<n>`). */
const STEER_NOTICE_SUFFIX = ":steer:";
const STEER_NOTICE_HEAD = "↪ 이 요청은 진행 중이던 작업에 합쳐져서 답을 다른 스레드에 올렸어";
/** Op ref infix of a text a running turn sent before its end (`<opRef>:interim:<n>`); it never finishes the status. */
export const INTERIM_INFIX = ":interim:";
/** Origin key prefix of Teams guest/qa deliveries (`teams-qa/<alias>`): no session, no inbound row behind them. */
export const TEAMS_QA_ORIGIN_PREFIX = "teams-qa/";
/** Head of a failed-turn notice delivery (`failedNotice` in the mailbox); never recall material. */
const TURN_FAILED_HEAD = "[turn failed]";
/** How far back recall candidates reach. */
const RECALL_WINDOW_MS = 90 * 24 * 60 * 60_000;
/** First line of a chat answer that closes a task: only these are copied to the log channel. */
const COMPLETION_MARKER = /^(?:✅|:white_check_mark:) 완료/;

/** The same alert scope+sign stays quiet for this long after an owner notice (monitor incident cadence). */
export const ALERT_INCIDENT_REPEAT_MS = 24 * 60 * 60_000;

/** Outcome of counting one alert occurrence: whether to notify the owner now, and how the condition has stood. */
export interface AlertIncident {
	notify: boolean;
	/** Occurrences counted in this alert period (first alert included). */
	count: number;
	/** When this alert period started; `now - firstAt` is how long the condition has stood. */
	firstAt: number;
	/**
	 * True when this same condition had already alerted the owner and never resolved — the row's standing state
	 * before this occurrence. A daemon restart reads it to keep "an alerted open must report its recovery" true
	 * across processes (the in-memory gate bookkeeping starts empty).
	 */
	standing: boolean;
}

export type { DeliveryState, InboundState } from "./transitions";
export { StoreError } from "./transitions";

export interface StoreClock {
	now(): number;
}

export interface StoreOptions {
	path: string;
	clock: StoreClock;
	/** The bot's zone (`config.timezone`): task ids are dated in it. */
	timezone: string;
	/** Applied to every body / text / error string before it is stored. */
	redact: (text: string) => string;
	/** Fallback Slack channel for monitor output before any owner DM is known. */
	slackOwnerUserId?: string;
	/** Slack channel (the #log ledger) that gets a copy of every completion report; absent = no copies. */
	logChannel?: string | undefined;
	hooks?: {
		/** Runs inside the answer transaction after inbound rows became `answered`, before delivery rows exist. */
		afterInboundAnswered?: () => void;
		/** Observes every delivery state change (`from` is "new" for a freshly inserted row). Must not throw. */
		onDeliveryState?: (change: { deliveryId: number; from: DeliveryState | "new"; to: DeliveryState }) => void;
		/** A notice for the owner had no destination (`ownerHome()` undefined) and was not recorded. Must not throw. */
		onOwnerNoticeUnroutable?: (info: { originKey: string; opRef: string }) => void;
	};
}

/** A Teams conversation behind its ledger alias (`teams_conversations`). */
export interface TeamsConversation {
	alias: string;
	conversationId: string;
	serviceUrl: string;
	tenantId: string;
	kind: "dm" | "ch";
}

/** Where owner notices go when nothing else names a conversation (`Store.ownerHome()`). */
export interface OwnerHome {
	platform: ChatPlatform;
	conversationId: string;
}

export interface OriginRow {
	originKey: string;
	epoch: number;
	sessionDir: string;
	updatedAt: number;
	/** Session file pinned by `/resume-ompbot`; opened instead of the newest session of `sessionDir`. */
	sessionFile: string | null;
	/** `provider/model` chosen with `/model-ompbot`; applied every time the omp child opens the session. */
	model: string | null;
	/** Thinking level chosen with `/thinking-ompbot`; applied like `model`. */
	thinking: string | null;
}

/** Per-origin runtime settings kept across idle release, restarts and `/new-ompbot`. */
export type OriginSettings = Pick<OriginRow, "model" | "thinking">;

export interface InboundRow {
	platformMessageId: string;
	originKey: string;
	epoch: number;
	textRef: string;
	state: InboundState;
	createdAt: number;
	dispatchedAt: number | null;
	opRef: string | null;
	/** omp session `leafId` (entry-id string) read right before dispatch; null when the session had no entries. */
	entryCursor: string | null;
	/** Slack thread the reply goes to (`<channel>:<thread_ts>`); backfilled from platform_message_id for pre-migration rows. */
	threadRef: string;
	/** Slack user id of the peer bot that wrote this row; null for every owner row (and rows from before the column). */
	peerUserId: string | null;
}

export interface DeliveryRow {
	deliveryId: number;
	originKey: string;
	opRef: string;
	part: number;
	threadRef: string;
	body: string;
	state: DeliveryState;
	attempts: number;
	nextAt: number;
	redelivered: boolean;
	createdAt: number;
	lastError: string | null;
	/** Slack messages of this row already posted before a rate limit cut the send (resume skips them); 0 when none. */
	sentParts: number;
	/** Top-level answer cut after part 1: the ts parts 2+ reply under. */
	replyTs: string | null;
}

/** One ledger row a recall search may quote: an owner message (`inbound`) or a confirmed bot answer (`delivery`). */
export interface RecallCandidate {
	kind: "inbound" | "delivery";
	originKey: string;
	threadRef: string;
	createdAt: number;
	/** First 1200 characters of the message or answer. */
	text: string;
	opRef: string | null;
}

/** A pending approval the sweep just expired, for its card rewrite (the mirror too, and `다시 요청` with a thread). */
type ExpiredApproval = {
	approvalId: string;
	channel: string;
	messageTs: string;
	summary: string;
	originThreadRef: string | null;
	mirrorRef: string | null;
};

/**
 * Approval card ledger. `origin_key`/`origin_thread_ref` map a card back to the conversation that asked (NULL on rows
 * from before the mapping existed), `reply_ts`/`reply_text` hold the owner's thread reply that settled it as `replied`.
 * `detail_json` holds the card's redacted, cut structured sections and `card_url`/`origin_url` the card and asking-thread
 * permalinks, for the dashboard (all NULL on older rows, when absent or when the permalink lookup failed).
 * `mirror_ref` (`<channel>:<ts>`, added by `migrate`) is the card's copy in the asking thread, NULL without one.
 */
const APPROVALS_DDL = `CREATE TABLE IF NOT EXISTS approvals (
	approval_id TEXT PRIMARY KEY,
	channel TEXT NOT NULL,
	message_ts TEXT NOT NULL,
	summary TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending'
		CHECK (status IN ('pending','approved','denied','expired','replied')),
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	decided_at INTEGER,
	origin_key TEXT,
	origin_thread_ref TEXT,
	reply_ts TEXT,
	reply_text TEXT,
	detail_json TEXT,
	card_url TEXT,
	origin_url TEXT
);`;

export const LANES_DDL = `CREATE TABLE IF NOT EXISTS lanes (
	name TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	thread_ref TEXT NOT NULL UNIQUE,
	origin_key TEXT NOT NULL UNIQUE,
	cwd TEXT NOT NULL,
	session_dir TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'working'
		CHECK (status IN ('working','done-claimed','not-done','paused','closed')),
	history TEXT NOT NULL DEFAULT '[]',
	meta TEXT NOT NULL DEFAULT '{}',
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);`;

/**
 * Turn snapshot ledger for `!undo` (doc/plans/turn-undo.md §D): one row per repository a conversation turn changed, with
 * the git trees before and after it. `reverted_at` marks a turn already put back (NULL = still undoable).
 */
export const TURN_SNAPSHOTS_DDL = `CREATE TABLE IF NOT EXISTS turn_snapshots (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	origin_key TEXT NOT NULL,
	op_ref TEXT NOT NULL,
	repo TEXT NOT NULL,
	head_before TEXT NOT NULL,
	tree_before TEXT NOT NULL,
	head_after TEXT NOT NULL,
	tree_after TEXT NOT NULL,
	started_at INTEGER NOT NULL,
	ended_at INTEGER NOT NULL,
	reverted_at INTEGER
);
CREATE INDEX IF NOT EXISTS turn_snapshots_origin ON turn_snapshots(origin_key, id);
CREATE INDEX IF NOT EXISTS turn_snapshots_ended ON turn_snapshots(ended_at);`;

export interface TurnSnapshotRow {
	id: number;
	originKey: string;
	opRef: string;
	repo: string;
	headBefore: string;
	treeBefore: string;
	headAfter: string;
	treeAfter: string;
	startedAt: number;
	endedAt: number;
	/** Undo happened at this time; NULL while the turn is still undoable. */
	revertedAt: number | null;
}

export interface TurnSnapshotInput {
	originKey: string;
	opRef: string;
	repo: string;
	headBefore: string;
	treeBefore: string;
	headAfter: string;
	treeAfter: string;
	startedAt: number;
	endedAt: number;
}

interface TurnSnapshotSql {
	id: number;
	origin_key: string;
	op_ref: string;
	repo: string;
	head_before: string;
	tree_before: string;
	head_after: string;
	tree_after: string;
	started_at: number;
	ended_at: number;
	reverted_at: number | null;
}

const toTurnSnapshot = (r: TurnSnapshotSql): TurnSnapshotRow => ({
	id: r.id,
	originKey: r.origin_key,
	opRef: r.op_ref,
	repo: r.repo,
	headBefore: r.head_before,
	treeBefore: r.tree_before,
	headAfter: r.head_after,
	treeAfter: r.tree_after,
	startedAt: r.started_at,
	endedAt: r.ended_at,
	revertedAt: r.reverted_at,
});

/** Rows kept per origin: an old turn's `!undo` target stops being reachable long before `gc` runs. */
export const TURN_SNAPSHOT_ROWS_KEPT = 20;

/**
 * The last instructions given to herdr agents, for the dashboard card's 마지막 지시 line
 * (doc/plans/dashboard-model-and-last-prompt.md §B): one masked one-line preview per prompt, never the text itself.
 * `host` is '' for local herdr.
 */
export const HERDR_PROMPTS_DDL = `CREATE TABLE IF NOT EXISTS herdr_prompts (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	host TEXT NOT NULL,
	agent TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('start','followup','remind')),
	preview TEXT NOT NULL,
	origin_key TEXT,
	at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS herdr_prompts_agent ON herdr_prompts(agent, id);`;

/** start: a new agent (a resume that starts one too) · followup: a prompt to a running one · remind: the sweep's nudge. */
export type HerdrPromptKind = "start" | "followup" | "remind";

/** One prompt herdr took; `host` null = local herdr. */
export interface HerdrPromptInput {
	host: string | null;
	agent: string;
	kind: HerdrPromptKind;
	/** The prompt as sent; only its masked preview is stored. */
	text: string;
	originKey: string | null;
}

/** Rows kept per agent. */
export const HERDR_PROMPT_ROWS_KEPT = 20;
/** Rows older than this are dropped on the next record. */
export const HERDR_PROMPT_KEEP_MS = 30 * 24 * 60 * 60_000;
/** Longest stored preview. */
export const HERDR_PROMPT_PREVIEW_CHARS = 120;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS origins (
	origin_key TEXT PRIMARY KEY,
	epoch INTEGER NOT NULL,
	session_dir TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS inbound (
	inbound_id INTEGER PRIMARY KEY AUTOINCREMENT,
	platform_message_id TEXT NOT NULL UNIQUE,
	origin_key TEXT NOT NULL REFERENCES origins(origin_key),
	epoch INTEGER NOT NULL,
	text_ref TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'pending'
		CHECK (state IN ('pending','dispatched','answered','failed_notified','discarded')),
	created_at INTEGER NOT NULL,
	dispatched_at INTEGER,
	op_ref TEXT,
	entry_cursor TEXT,
	thread_ref TEXT,
	last_event_at INTEGER,
	peer_user_id TEXT
);
CREATE INDEX IF NOT EXISTS inbound_origin_state ON inbound(origin_key, state);
CREATE INDEX IF NOT EXISTS inbound_state ON inbound(state);
CREATE INDEX IF NOT EXISTS inbound_origin_op ON inbound(origin_key, op_ref);
CREATE TABLE IF NOT EXISTS deliveries (
	delivery_id INTEGER PRIMARY KEY AUTOINCREMENT,
	origin_key TEXT NOT NULL,
	op_ref TEXT NOT NULL,
	part INTEGER NOT NULL,
	thread_ref TEXT NOT NULL,
	body TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'pending'
		CHECK (state IN ('pending','inflight','confirmed','failed_ambiguous','expired')),
	attempts INTEGER NOT NULL DEFAULT 0,
	next_at INTEGER NOT NULL,
	redelivered INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	last_error TEXT,
	sent_parts INTEGER,
	reply_ts TEXT,
	UNIQUE (origin_key, op_ref, part)
);
CREATE INDEX IF NOT EXISTS deliveries_state_next ON deliveries(state, next_at);
CREATE INDEX IF NOT EXISTS deliveries_created ON deliveries(created_at);
CREATE INDEX IF NOT EXISTS deliveries_thread ON deliveries(thread_ref);
${LANES_DDL}
CREATE TABLE IF NOT EXISTS slack_cursors (
	cursor_key TEXT PRIMARY KEY,
	last_ts TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
${APPROVALS_DDL}
CREATE TABLE IF NOT EXISTS alert_incidents (
	incident_id INTEGER PRIMARY KEY AUTOINCREMENT,
	scope TEXT NOT NULL,
	signature TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'alerted' CHECK (status IN ('alerted','resolved')),
	count INTEGER NOT NULL DEFAULT 1,
	first_at INTEGER NOT NULL,
	last_at INTEGER NOT NULL,
	alerted_at INTEGER NOT NULL,
	UNIQUE (scope, signature)
);
CREATE TABLE IF NOT EXISTS owner_home (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	platform TEXT NOT NULL,
	conversation_id TEXT NOT NULL,
	set_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS teams_conversations (
	alias TEXT PRIMARY KEY,
	conversation_id TEXT NOT NULL,
	service_url TEXT NOT NULL,
	tenant_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('dm','ch')),
	updated_at INTEGER NOT NULL,
	owner_at INTEGER
);
CREATE TABLE IF NOT EXISTS teams_qa (
	id INTEGER PRIMARY KEY,
	alias TEXT NOT NULL,
	asker_aad TEXT NOT NULL,
	asker_name TEXT,
	question TEXT NOT NULL,
	answer TEXT,
	at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS teams_qa_alias_at ON teams_qa(alias, at);
CREATE TABLE IF NOT EXISTS thread_mutes (
	thread_ref TEXT PRIMARY KEY,
	muted_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_daily (
	day TEXT NOT NULL,
	origin_key TEXT NOT NULL,
	cost REAL NOT NULL,
	calls INTEGER NOT NULL,
	PRIMARY KEY(day, origin_key)
);
${FEEDBACK_DDL}
${TURN_SNAPSHOTS_DDL}
${HERDR_PROMPTS_DDL}
`;

interface LaneSql {
	name: string;
	title: string;
	thread_ref: string;
	origin_key: string;
	cwd: string;
	session_dir: string;
	status: LaneStatus;
	history: string;
	meta: string;
	created_at: number;
	updated_at: number;
}

const toLane = (r: LaneSql): LaneRow => ({
	name: r.name,
	title: r.title,
	threadRef: r.thread_ref,
	originKey: r.origin_key,
	cwd: r.cwd,
	sessionDir: r.session_dir,
	status: r.status,
	history: JSON.parse(r.history) as LaneHistoryEntry[],
	meta: JSON.parse(r.meta) as LaneMeta,
	createdAt: r.created_at,
	updatedAt: r.updated_at,
});

/** The registry keeps the newest entries only; a lane that lives for weeks must not grow without bound. */
const MAX_LANE_HISTORY = 200;

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "replied";

export interface ApprovalRow {
	approvalId: string;
	channel: string;
	messageTs: string;
	status: ApprovalStatus;
	originKey: string | null;
	originThreadRef: string | null;
	replyTs: string | null;
	replyText: string | null;
	/** The request text as the card shows it (redacted, cut). */
	summary: string;
	/** `<channel>:<ts>` of the card's mirror in the asking thread; null without one (and on older rows). */
	mirrorRef: string | null;
}

interface ApprovalSql {
	approval_id: string;
	channel: string;
	message_ts: string;
	status: ApprovalStatus;
	origin_key: string | null;
	origin_thread_ref: string | null;
	reply_ts: string | null;
	reply_text: string | null;
	summary: string;
	mirror_ref: string | null;
}

interface OriginSql {
	origin_key: string;
	epoch: number;
	session_dir: string;
	updated_at: number;
	session_file: string | null;
	model: string | null;
	thinking: string | null;
}
interface InboundSql {
	platform_message_id: string;
	origin_key: string;
	epoch: number;
	text_ref: string;
	state: InboundState;
	created_at: number;
	dispatched_at: number | null;
	op_ref: string | null;
	entry_cursor: string | null;
	thread_ref: string | null;
	peer_user_id: string | null;
}
interface DeliverySql {
	delivery_id: number;
	origin_key: string;
	op_ref: string;
	part: number;
	thread_ref: string;
	body: string;
	state: DeliveryState;
	attempts: number;
	next_at: number;
	redelivered: number;
	created_at: number;
	last_error: string | null;
	sent_parts: number | null;
	reply_ts: string | null;
}

const toOrigin = (r: OriginSql): OriginRow => ({
	originKey: r.origin_key,
	epoch: r.epoch,
	sessionDir: r.session_dir,
	updatedAt: r.updated_at,
	sessionFile: r.session_file,
	model: r.model,
	thinking: r.thinking,
});

const toInbound = (r: InboundSql): InboundRow => ({
	platformMessageId: r.platform_message_id,
	originKey: r.origin_key,
	epoch: r.epoch,
	textRef: r.text_ref,
	state: r.state,
	createdAt: r.created_at,
	dispatchedAt: r.dispatched_at,
	opRef: r.op_ref,
	entryCursor: r.entry_cursor,
	threadRef: r.thread_ref ?? r.platform_message_id,
	peerUserId: r.peer_user_id ?? null,
});

const toDelivery = (r: DeliverySql): DeliveryRow => ({
	deliveryId: r.delivery_id,
	originKey: r.origin_key,
	opRef: r.op_ref,
	part: r.part,
	threadRef: r.thread_ref,
	body: r.body,
	state: r.state,
	attempts: r.attempts,
	nextAt: r.next_at,
	redelivered: r.redelivered === 1,
	createdAt: r.created_at,
	lastError: r.last_error,
	sentParts: r.sent_parts ?? 0,
	replyTs: r.reply_ts,
});

export class Store {
	private readonly db: Database;
	private readonly clock: StoreClock;
	private readonly redact: (text: string) => string;
	private readonly hooks: NonNullable<StoreOptions["hooks"]>;
	/** Deliveries that were inflight when the previous process died; re-queued with redelivered=1 at open. */
	readonly recoveredInflight: number;
	/** Monitor definitions, slots and events; shares this connection so answers settle in the same transaction. */
	readonly monitors: MonitorLedger;
	/** [TASK] registry; shares this connection. */
	readonly tasks: TaskLedger;
	/** Posted delivery messages and the owner's 👍/👎 on them; shares this connection. */
	readonly feedback: FeedbackLedger;
	private readonly slackOwnerUserId: string | undefined;
	private logChannel: string | undefined;

	/** Config reload: answers recorded from now on copy to the new #log channel (none when undefined). */
	setLogChannel(channel: string | undefined): void {
		this.logChannel = channel;
	}

	constructor(options: StoreOptions) {
		this.clock = options.clock;
		this.slackOwnerUserId = options.slackOwnerUserId;
		this.logChannel = options.logChannel;
		this.redact = options.redact;
		this.hooks = options.hooks ?? {};
		this.db = new Database(options.path, { create: true, strict: true });
		this.db.run("PRAGMA journal_mode = WAL");
		this.db.run("PRAGMA synchronous = NORMAL");
		this.db.run("PRAGMA foreign_keys = ON");
		this.db.run("PRAGMA busy_timeout = 5000");
		this.db.run(SCHEMA);
		this.migrate();
		this.monitors = new MonitorLedger(this.db, { clock: options.clock, redact: options.redact });
		this.tasks = new TaskLedger(this.db, { clock: options.clock, timezone: options.timezone });
		this.feedback = new FeedbackLedger(this.db, { clock: options.clock });
		this.recoveredInflight = this.db
			.query("UPDATE deliveries SET state = 'pending', redelivered = 1, next_at = ? WHERE state = 'inflight'")
			.run(this.clock.now()).changes;
	}

	close(): void {
		this.db.close();
	}

	// ---- origins ----

	ensureOrigin(originKey: string, sessionDir: string): OriginRow {
		const now = this.clock.now();
		this.db
			.query(
				"INSERT INTO origins (origin_key, epoch, session_dir, updated_at) VALUES (?, 1, ?, ?) ON CONFLICT DO NOTHING",
			)
			.run(originKey, sessionDir, now);
		return this.requireOrigin(originKey);
	}

	getOrigin(originKey: string): OriginRow | undefined {
		const row = this.db.query("SELECT * FROM origins WHERE origin_key = ?").get(originKey) as OriginSql | null;
		return row ? toOrigin(row) : undefined;
	}

	/** Backfill watermark for a target (`ch:<channel>` / `thr:<channel>:<rootTs>`); undefined before the first pass. */
	getCursor(cursorKey: string): string | undefined {
		const row = this.db.query("SELECT last_ts FROM slack_cursors WHERE cursor_key = ?").get(cursorKey) as
			| { last_ts: string }
			| undefined;
		return row?.last_ts;
	}

	/** Advances a backfill watermark (INSERT OR REPLACE); callers only move it forward. */
	setCursor(cursorKey: string, lastTs: string): void {
		this.db
			.query(
				"INSERT INTO slack_cursors (cursor_key, last_ts, updated_at) VALUES (?, ?, ?) ON CONFLICT(cursor_key) DO UPDATE SET last_ts = excluded.last_ts, updated_at = excluded.updated_at",
			)
			.run(cursorKey, lastTs, this.clock.now());
	}

	deleteCursor(cursorKey: string): void {
		this.db.query("DELETE FROM slack_cursors WHERE cursor_key = ?").run(cursorKey);
	}

	/** Stored backfill cursor keys starting with `prefix` (compared literally, no LIKE wildcards), sorted. */
	listCursorKeys(prefix: string): string[] {
		const rows = this.db
			.query("SELECT cursor_key FROM slack_cursors WHERE substr(cursor_key, 1, length(?1)) = ?1 ORDER BY cursor_key")
			.all(prefix) as Array<{ cursor_key: string }>;
		return rows.map((row) => row.cursor_key);
	}

	createApproval(input: {
		approvalId: string;
		channel: string;
		messageTs: string;
		summary: string;
		createdAt: number;
		expiresAt: number;
		/** The conversation that asked and the thread the request came from (absent for lane/legacy callers). */
		originKey?: string | undefined;
		originThreadRef?: string | undefined;
		/** The card's structured sections as shown (already redacted and cut); only filled fields are stored. */
		detail?: ApprovalDetail | undefined;
		/** Permalinks of the card and of the asking thread (best effort; absent when the lookup failed). */
		cardUrl?: string | undefined;
		originUrl?: string | undefined;
	}): void {
		const detail: ApprovalDetail = {};
		for (const key of ["action", "why", "impact", "rollback"] as const) {
			const value = input.detail?.[key];
			if (value !== undefined && value.trim() !== "") detail[key] = this.redact(value);
		}
		this.db
			.query(
				"INSERT INTO approvals (approval_id, channel, message_ts, summary, status, created_at, expires_at, origin_key, origin_thread_ref, detail_json, card_url, origin_url) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				input.approvalId,
				input.channel,
				input.messageTs,
				this.redact(input.summary),
				input.createdAt,
				input.expiresAt,
				input.originKey ?? null,
				input.originThreadRef ?? null,
				Object.keys(detail).length === 0 ? null : JSON.stringify(detail),
				input.cardUrl ?? null,
				input.originUrl ?? null,
			);
	}

	getApproval(approvalId: string): ApprovalRow | undefined {
		const row = this.db.query("SELECT * FROM approvals WHERE approval_id = ?").get(approvalId) as ApprovalSql | null;
		return row === null
			? undefined
			: {
					approvalId: row.approval_id,
					channel: row.channel,
					messageTs: row.message_ts,
					status: row.status,
					originKey: row.origin_key,
					originThreadRef: row.origin_thread_ref,
					replyTs: row.reply_ts,
					replyText: row.reply_text,
					summary: row.summary,
					mirrorRef: row.mirror_ref ?? null,
				};
	}

	/** Records the mirror card of a still-pending approval; false when the row is gone or already settled. */
	setApprovalMirrorRef(approvalId: string, mirrorRef: string): boolean {
		return (
			this.db
				.query("UPDATE approvals SET mirror_ref = ? WHERE approval_id = ? AND status = 'pending'")
				.run(mirrorRef, approvalId).changes === 1
		);
	}

	/**
	 * Settles a pending, not-yet-due approval as `replied` with the owner's thread reply. Same `status = 'pending'`
	 * guard as a click, so a reply racing a click, the sweeper or a timeout reports `false`.
	 */
	replyApproval(approvalId: string, replyTs: string, text: string, now: number): boolean {
		return (
			this.db
				.query(
					"UPDATE approvals SET status = 'replied', decided_at = ?, reply_ts = ?, reply_text = ? WHERE approval_id = ? AND status = 'pending' AND expires_at > ?",
				)
				.run(now, replyTs, this.redact(text), approvalId, now).changes === 1
		);
	}

	/**
	 * Resolves a pending approval; the `WHERE status = 'pending'` guard makes the second click (or a click racing the
	 * sweeper) a no-op that reports `false`, replacing the in-memory map's atomic pop.
	 */
	decideApproval(approvalId: string, status: "approved" | "denied" | "expired", now: number): boolean {
		// A due-but-unswept row is expired by contract: a late click must not approve it (the sweeper would have
		// refused). Marking it `expired` is always allowed — that is the sweeper's own honest outcome.
		const guard = status === "expired" ? "" : " AND expires_at > ?";
		const params = status === "expired" ? [status, now, approvalId] : [status, now, approvalId, now];
		return (
			this.db
				.query(`UPDATE approvals SET status = ?, decided_at = ? WHERE approval_id = ? AND status = 'pending'${guard}`)
				.run(...params).changes === 1
		);
	}

	/**
	 * Expires every still-pending approval that is due (or all of them when `due` is false — the boot sweep). The
	 * summary comes back so the broker can tell a choice card (its body) from an approval when rewriting the card.
	 */
	expirePendingApprovals(now: number, due = true): ExpiredApproval[] {
		return this.db.transaction((): ExpiredApproval[] => {
			const rows = this.db
				.query(
					`SELECT approval_id, channel, message_ts, summary, origin_thread_ref, mirror_ref FROM approvals
					 WHERE status = 'pending' AND (${due ? "expires_at <= ?" : "1 = 1"})`,
				)
				.all(...(due ? [now] : [])) as Array<{
				approval_id: string;
				channel: string;
				message_ts: string;
				summary: string;
				origin_thread_ref: string | null;
				mirror_ref: string | null;
			}>;
			if (rows.length === 0) return [];
			this.db
				.query(
					`UPDATE approvals SET status = 'expired', decided_at = ?
					 WHERE status = 'pending' AND (${due ? "expires_at <= ?" : "1 = 1"})`,
				)
				.run(...(due ? [now, now] : [now]));
			return rows.map((row) => ({
				approvalId: row.approval_id,
				channel: row.channel,
				messageTs: row.message_ts,
				summary: row.summary,
				originThreadRef: row.origin_thread_ref,
				mirrorRef: row.mirror_ref,
			}));
		})();
	}

	/** Answered owner turns on one origin (the skill-review cadence counts these). */
	countAnswered(originKey: string): number {
		const row = this.db
			.query("SELECT COUNT(*) AS n FROM inbound WHERE origin_key = ? AND state = 'answered'")
			.get(originKey) as { n: number } | null;
		return row?.n ?? 0;
	}

	/** Origin keys of one chat platform (`<platform>/dm/<id>`, `<platform>/ch/<id>[/t/<id>]`) — backfill targets. */
	listOrigins(platform: ChatPlatform): string[] {
		const rows = this.db
			.query("SELECT origin_key FROM origins WHERE origin_key LIKE ? ORDER BY origin_key")
			.all(`${platform}/%`) as Array<{ origin_key: string }>;
		return rows.map((row) => row.origin_key);
	}

	/** `listOrigins("slack")`: the Slack backfill's channel targets. */
	listSlackOrigins(): string[] {
		return this.listOrigins("slack");
	}

	/**
	 * Threads the bot answered in recently on one chat platform's origins (deliveries carry `<channel>:<rootTs>`),
	 * newest first — backfill thread targets. The 7-day window and cap mirror the upstream participated-thread
	 * tracking. Top-level posts (`<channel>:-`: slash-command answers, log-channel copies) have no thread to read, so
	 * they are never targets.
	 */
	listThreadTargets(platform: ChatPlatform, since: number, limit: number): Array<{ channel: string; rootTs: string }> {
		const rows = this.db
			.query(
				`SELECT origin_key, thread_ref, MAX(created_at) AS last FROM deliveries
				 WHERE thread_ref IS NOT NULL AND thread_ref NOT LIKE ? AND origin_key LIKE ? AND created_at >= ?
				 GROUP BY origin_key, thread_ref ORDER BY last DESC LIMIT ?`,
			)
			.all(`%:${TOP_LEVEL_TS}`, `${platform}/%`, since, limit) as Array<{ origin_key: string; thread_ref: string }>;
		const targets: Array<{ channel: string; rootTs: string }> = [];
		for (const row of rows) {
			const parsed = parseThreadRef(row.thread_ref);
			if (parsed === undefined) continue;
			targets.push({ channel: parsed.channel, rootTs: parsed.threadTs });
		}
		return targets;
	}

	/** `listThreadTargets("slack", …)`: the Slack backfill's thread targets. */
	listSlackThreadTargets(since: number, limit: number): Array<{ channel: string; rootTs: string }> {
		return this.listThreadTargets("slack", since, limit);
	}

	/**
	 * `/new`: bump the epoch, switch session dir, discard still-pending inbound of the old epoch. With `opRef` the
	 * discarded rows are linked to that op, so the command's delivery also finishes their thread status messages.
	 */
	newEpoch(originKey: string, sessionDir: string, opRef?: string, sessionFile?: string): OriginRow {
		this.db.transaction(() => {
			this.requireOrigin(originKey);
			this.db
				.query(
					"UPDATE origins SET epoch = epoch + 1, session_dir = ?, session_file = ?, updated_at = ? WHERE origin_key = ?",
				)
				.run(sessionDir, sessionFile ?? null, this.clock.now(), originKey);
			this.db
				.query(
					"UPDATE inbound SET state = 'discarded', op_ref = COALESCE(?, op_ref) WHERE origin_key = ? AND state = 'pending'",
				)
				.run(opRef ?? null, originKey);
		})();
		return this.requireOrigin(originKey);
	}

	/** `null` clears a setting (back to the omp default); `undefined` leaves it unchanged. */
	setOriginSettings(originKey: string, settings: Partial<OriginSettings>): OriginRow {
		const origin = this.requireOrigin(originKey);
		this.db
			.query("UPDATE origins SET model = ?, thinking = ?, updated_at = ? WHERE origin_key = ?")
			.run(
				settings.model === undefined ? origin.model : settings.model,
				settings.thinking === undefined ? origin.thinking : settings.thinking,
				this.clock.now(),
				originKey,
			);
		return this.requireOrigin(originKey);
	}

	// ---- inbound ----

	/** Whether an owner message was recorded in this thread (a channel thread the bot is already part of). */
	hasInboundThread(threadRef: string): boolean {
		return this.db.query("SELECT 1 FROM inbound WHERE thread_ref = ? LIMIT 1").get(threadRef) !== null;
	}

	/** Whether the thread has an inbound row recorded before the given one (any origin, owner or peer). */
	hasInboundThreadBefore(threadRef: string, platformMessageId: string): boolean {
		return (
			this.db
				.query(
					"SELECT 1 FROM inbound WHERE thread_ref = ? AND inbound_id < (SELECT inbound_id FROM inbound WHERE platform_message_id = ?) LIMIT 1",
				)
				.get(threadRef, platformMessageId) !== null
		);
	}

	/** Whether any peer bot's message was recorded for this origin: its omp child runs with the reduced host tools. */
	originHasPeerInbound(originKey: string): boolean {
		return (
			this.db
				.query("SELECT 1 FROM inbound WHERE origin_key = ? AND peer_user_id IS NOT NULL LIMIT 1")
				.get(originKey) !== null
		);
	}

	/** Peer rows recorded in a thread at or after `sinceMs` (the hop cap's window). */
	countPeerInboundSince(threadRef: string, sinceMs: number): number {
		const row = this.db
			.query("SELECT COUNT(*) AS n FROM inbound WHERE thread_ref = ? AND peer_user_id IS NOT NULL AND created_at >= ?")
			.get(threadRef, sinceMs) as { n: number };
		return row.n;
	}

	/** Idempotent on platform_message_id: a second insert of the same id returns the existing row. */
	recordInbound(input: {
		originKey: string;
		platformMessageId: string;
		textRef: string;
		threadRef?: string;
		/** Set only for a peer bot's row (taints the origin: see `originHasPeerInbound`). */
		peerUserId?: string;
	}): {
		inserted: boolean;
		row: InboundRow;
	} {
		const origin = this.requireOrigin(input.originKey);
		const result = this.db
			.query(
				"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, created_at, thread_ref, peer_user_id) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(platform_message_id) DO NOTHING",
			)
			.run(
				input.platformMessageId,
				input.originKey,
				origin.epoch,
				this.redact(input.textRef),
				this.clock.now(),
				input.threadRef ?? input.platformMessageId,
				input.peerUserId ?? null,
			);
		return { inserted: result.changes === 1, row: this.requireInbound(input.platformMessageId) };
	}

	getInbound(platformMessageId: string): InboundRow | undefined {
		const row = this.db
			.query("SELECT * FROM inbound WHERE platform_message_id = ?")
			.get(platformMessageId) as InboundSql | null;
		return row ? toInbound(row) : undefined;
	}

	listInbound(filter: { originKey?: string; state?: InboundState } = {}): InboundRow[] {
		const rows = this.db
			.query(
				"SELECT * FROM inbound WHERE (?1 IS NULL OR origin_key = ?1) AND (?2 IS NULL OR state = ?2) ORDER BY inbound_id",
			)
			.all(filter.originKey ?? null, filter.state ?? null) as InboundSql[];
		return rows.map(toInbound);
	}

	/** Per-state inbound row counts (`GROUP BY`); lets /status count without loading every row. */
	countInboundByState(): Partial<Record<InboundState, number>> {
		const counts: Partial<Record<InboundState, number>> = {};
		for (const row of this.db.query("SELECT state, COUNT(*) AS n FROM inbound GROUP BY state").all() as Array<{
			state: InboundState;
			n: number;
		}>) {
			counts[row.state] = row.n;
		}
		return counts;
	}

	/**
	 * Distinct origin keys of inbound rows, in first-appearance order (`MIN(inbound_id)`) — the /status origin list,
	 * computed in SQL so the ledger can grow without the report growing with it.
	 */
	distinctInboundOrigins(): string[] {
		const rows = this.db
			.query("SELECT origin_key FROM inbound GROUP BY origin_key ORDER BY MIN(inbound_id)")
			.all() as Array<{ origin_key: string }>;
		return rows.map((row) => row.origin_key);
	}

	/** pending -> dispatched. Records the op_ref and the omp leafId cursor taken just before dispatch. */
	markDispatched(platformMessageId: string, input: { opRef: string; entryCursor: string | null }): InboundRow {
		const current = this.requireInbound(platformMessageId);
		assertInboundTransition(current.state, "dispatched");
		this.db
			.query(
				"UPDATE inbound SET state = 'dispatched', dispatched_at = ?, op_ref = ?, entry_cursor = ? WHERE platform_message_id = ?",
			)
			.run(this.clock.now(), input.opRef, input.entryCursor, platformMessageId);
		return this.requireInbound(platformMessageId);
	}

	/** pending|dispatched -> discarded. With `opRef` the row is re-linked to that op (see `newEpoch`). */
	discard(platformMessageId: string, opRef?: string): InboundRow {
		const current = this.requireInbound(platformMessageId);
		assertInboundTransition(current.state, "discarded");
		this.db
			.query("UPDATE inbound SET state = 'discarded', op_ref = COALESCE(?, op_ref) WHERE platform_message_id = ?")
			.run(opRef ?? null, platformMessageId);
		return this.requireInbound(platformMessageId);
	}

	/** The op's running turn just emitted an omp event: stamps every still-dispatched row of it (steered rows too). */
	touchDispatched(originKey: string, opRef: string): void {
		this.db
			.query("UPDATE inbound SET last_event_at = ? WHERE origin_key = ? AND op_ref = ? AND state = 'dispatched'")
			.run(this.clock.now(), originKey, opRef);
	}

	/** Distinct Slack threads of every inbound row that belongs to the op (the whole steered batch, not only the lead). */
	threadsOfOp(originKey: string, opRef: string): string[] {
		const rows = this.db
			.query("SELECT DISTINCT thread_ref FROM inbound WHERE origin_key = ? AND op_ref = ? ORDER BY thread_ref")
			.all(originKey, opRef) as Array<{ thread_ref: string }>;
		return rows.map((row) => row.thread_ref);
	}

	/**
	 * Earliest inbound row of a Slack thread other than the given message — normally the thread root, which was
	 * dispatched to the parent channel's origin and is therefore invisible to the thread-reply session.
	 */
	getThreadRootInbound(threadRef: string, excludeMessageId: string): InboundRow | undefined {
		const row = this.db
			.query("SELECT * FROM inbound WHERE thread_ref = ? AND platform_message_id != ? ORDER BY inbound_id LIMIT 1")
			.get(threadRef, excludeMessageId) as InboundSql | null;
		return row === null ? undefined : toInbound(row);
	}

	/**
	 * Recall candidates of one conversation space (its platform read from the id), newest first: owner messages and confirmed first-part bot
	 * answers of the last 90 days whose origin AND thread both belong to `channel` (a DM origin's steer pointer into
	 * a channel thread is excluded by the origin test), other than the `excludeThreadRef` thread and top-level posts.
	 * Chat commands, command answers, failure notices and steer pointers are dropped after the query.
	 */
	listRecallCandidates(channel: string, excludeThreadRef: string, limit: number): RecallCandidate[] {
		const platform = platformOfConversationId(channel);
		if (platform === undefined) return [];
		const chEsc = channel.replace(/[\\%_]/g, (c) => `\\${c}`);
		const scope = `(origin_key = $dm OR origin_key = $chKey OR origin_key LIKE $threads ESCAPE '\\')
			AND thread_ref LIKE $chEsc || ':%' ESCAPE '\\' AND thread_ref <> $ch || ':-' AND thread_ref <> $exclude
			AND created_at >= $since`;
		const rows = this.db
			.query(
				`SELECT 'inbound' AS kind, origin_key, thread_ref, created_at, substr(text_ref, 1, 1200) AS text, op_ref
				 FROM inbound WHERE ${scope} AND state <> 'discarded' AND peer_user_id IS NULL
				 UNION ALL
				 SELECT 'delivery' AS kind, origin_key, thread_ref, created_at, substr(body, 1, 1200) AS text, op_ref
				 FROM deliveries WHERE ${scope} AND state = 'confirmed' AND part = 0
				 ORDER BY created_at DESC LIMIT $limit`,
			)
			.all({
				$dm: `${platform}/dm/${channel}`,
				$chKey: `${platform}/ch/${channel}`,
				$threads: `${platform}/ch/${chEsc}/t/%`,
				$ch: channel,
				$chEsc: chEsc,
				$exclude: excludeThreadRef,
				$since: this.clock.now() - RECALL_WINDOW_MS,
				$limit: limit,
			}) as Array<{
			kind: RecallCandidate["kind"];
			origin_key: string;
			thread_ref: string;
			created_at: number;
			text: string;
			op_ref: string | null;
		}>;
		const candidates: RecallCandidate[] = [];
		for (const row of rows) {
			const bookkeeping =
				row.kind === "inbound"
					? parseCommand(row.text) !== undefined
					: (row.op_ref !== null && COMMAND_OP_REF.test(row.op_ref)) ||
						row.text.startsWith(STEER_NOTICE_HEAD) ||
						row.text.startsWith(TURN_FAILED_HEAD);
			if (bookkeeping) continue;
			candidates.push({
				kind: row.kind,
				originKey: row.origin_key,
				threadRef: row.thread_ref,
				createdAt: row.created_at,
				text: row.text,
				opRef: row.op_ref,
			});
		}
		return candidates;
	}

	/**
	 * Distinct threads of the op's `discarded` rows — a `/queue-ompbot drop` target, re-linked to the command's op
	 * by `discard()`. The delivery carrying the op finishes these threads' ⏳ status as `🚫 취소됨` instead of ✅/⚠️.
	 */
	discardedThreadsOfOp(originKey: string, opRef: string): string[] {
		const rows = this.db
			.query(
				"SELECT DISTINCT thread_ref FROM inbound WHERE origin_key = ? AND op_ref = ? AND state = 'discarded' ORDER BY thread_ref",
			)
			.all(originKey, opRef) as Array<{ thread_ref: string }>;
		return rows.map((row) => row.thread_ref);
	}

	/**
	 * Slack conversations with an inbound message since `since`, each with the thread of its newest message (newest
	 * first, at most `limit`) — the restart notice targets. Monitor origins never take inbound from people.
	 */
	recentConversations(since: number, limit: number): Array<{ originKey: string; threadRef: string }> {
		const rows = this.db
			.query(
				`SELECT i.origin_key, i.thread_ref FROM inbound i
				 JOIN (SELECT origin_key, MAX(inbound_id) AS last FROM inbound WHERE created_at >= ? AND thread_ref IS NOT NULL
				       AND origin_key NOT LIKE 'monitor/%' GROUP BY origin_key) r ON r.last = i.inbound_id
				 ORDER BY i.inbound_id DESC LIMIT ?`,
			)
			.all(since, limit) as Array<{ origin_key: string; thread_ref: string }>;
		return rows.map((row) => ({ originKey: row.origin_key, threadRef: row.thread_ref }));
	}

	/** Newest recorded thread of an origin (its current conversation); where a file upload lands by default. */
	latestInboundThread(originKey: string): string | undefined {
		const row = this.db
			.query("SELECT thread_ref FROM inbound WHERE origin_key = ? ORDER BY inbound_id DESC LIMIT 1")
			.get(originKey) as { thread_ref: string } | undefined;
		return row?.thread_ref;
	}

	/**
	 * One transaction: every dispatched inbound row of the op becomes `answered` and the delivery rows are created.
	 * Any throw in between rolls both back. Re-recording the same (origin, op_ref, part) is a no-op. `answer` is the
	 * turn's whole answer when `parts` leave out what interim deliveries already sent: the log-channel copy and the
	 * steered-thread pointers are judged on it (default: `parts`).
	 */
	recordAnswer(input: {
		originKey: string;
		opRef: string;
		threadRef: string;
		parts: readonly string[];
		answer?: string;
	}): DeliveryRow[] {
		if (input.parts.length === 0) throw new StoreError("invalid_argument", "recordAnswer needs at least one part");
		if (input.originKey.startsWith(MONITOR_ORIGIN_PREFIX)) return this.recordMonitorAnswer(input);
		return this.db.transaction(() => {
			const steered = this.steeredThreads(input);
			this.closeDispatched(input.originKey, input.opRef, "answered");
			this.hooks.afterInboundAnswered?.();
			const rows = input.parts.map((body, part) => this.insertDelivery(input, part, body));
			const whole = input.answer ?? input.parts.join("\n");
			this.notifySteeredThreads(input, steered, whole);
			this.copyCompletion(input, whole);
			return rows;
		})();
	}

	/**
	 * A text a still-running turn sends right away (a finished answer, a note next to `wait`): one delivery under
	 * `<opRef>:interim:<index>`. Inbound rows stay `dispatched`, and no log-channel copy or steered-thread pointer is
	 * made — the turn end does those. Re-recording the same index is a no-op.
	 */
	recordInterim(input: {
		originKey: string;
		opRef: string;
		threadRef: string;
		index: number;
		body: string;
	}): DeliveryRow {
		return this.insertDelivery({ ...input, opRef: `${input.opRef}${INTERIM_INFIX}${input.index}` }, 0, input.body);
	}

	/** Bodies of the op's interim deliveries in the order they were recorded (stored, so redacted). */
	interimBodies(originKey: string, opRef: string): string[] {
		const prefix = `${opRef}${INTERIM_INFIX}`;
		const rows = this.db
			.query("SELECT body FROM deliveries WHERE origin_key = ? AND substr(op_ref, 1, ?) = ? ORDER BY delivery_id")
			.all(originKey, prefix.length, prefix) as Array<{ body: string }>;
		return rows.map((row) => row.body);
	}

	/**
	 * Other threads of a chat turn's still-dispatched rows: messages steered into a turn another thread started. Read
	 * before the rows close, so a replayed answer (rows already answered) finds none and notifies nothing twice.
	 */
	private steeredThreads(input: { originKey: string; opRef: string; threadRef: string }): string[] {
		if (chatPlatformOf(input.originKey) === undefined) return [];
		const rows = this.db
			.query(
				"SELECT DISTINCT thread_ref FROM inbound WHERE origin_key = ? AND op_ref = ? AND state = 'dispatched' AND thread_ref != ? ORDER BY thread_ref",
			)
			.all(input.originKey, input.opRef, input.threadRef) as Array<{ thread_ref: string }>;
		return rows.map((row) => row.thread_ref);
	}

	/**
	 * One pointer per steered thread: the answer (or failure notice) went to the turn's thread, so the other thread
	 * gets its first line and a `{{thread-link:…}}` the adapter turns into a permalink. Op ref `<opRef>:steer:<n>`.
	 */
	private notifySteeredThreads(
		input: { originKey: string; opRef: string; threadRef: string },
		threads: readonly string[],
		body: string,
	): void {
		if (threads.length === 0) return;
		const first = (body.split("\n").find((line) => line.trim() !== "") ?? "").trim().slice(0, 200);
		const answered = parseThreadRef(input.threadRef);
		const link =
			answered === undefined || answered.threadTs === TOP_LEVEL_TS
				? ""
				: `${THREAD_LINK_PREFIX}${answered.channel}:${answered.threadTs}}}`;
		threads.forEach((threadRef, n) => {
			this.insertDelivery(
				{ originKey: input.originKey, opRef: `${input.opRef}${STEER_NOTICE_SUFFIX}${n}`, threadRef },
				0,
				`${STEER_NOTICE_HEAD}\n> ${first}${link}`,
			);
		});
	}

	/**
	 * The single choke point where chat answers become deliveries also writes the log-channel copy of a completion
	 * report: a Slack chat or work-lane answer (never commands) whose first non-empty line starts with `✅ 완료`.
	 * The copy is one delivery on `<logChannel>:-` under `<opRef>:log-copy`, so a replayed answer inserts nothing new.
	 */
	private copyCompletion(input: { originKey: string; opRef: string; threadRef: string }, body: string): void {
		if (this.logChannel === undefined || COMMAND_OP_REF.test(input.opRef)) return;
		// Slack chats only: the #log channel is a Slack channel.
		if (chatPlatformOf(input.originKey) !== "slack" && !input.originKey.startsWith(LANE_ORIGIN_PREFIX)) return;
		const first = body.split("\n").find((line) => line.trim() !== "");
		if (first === undefined || !COMPLETION_MARKER.test(first.trim())) return;
		const requested = parseThreadRef(input.threadRef);
		const channel = requested?.channel ?? "";
		const where = input.originKey.startsWith(LANE_ORIGIN_PREFIX)
			? `작업 레인 ${input.originKey.slice(LANE_ORIGIN_PREFIX.length)}`
			: channel.startsWith("D")
				? "DM"
				: `<#${channel}>`;
		const link =
			requested === undefined || requested.threadTs === TOP_LEVEL_TS
				? ""
				: `${THREAD_LINK_PREFIX}${requested.channel}:${requested.threadTs}}}`;
		this.insertDelivery(
			{
				originKey: input.originKey,
				opRef: `${input.opRef}${LOG_COPY_SUFFIX}`,
				threadRef: threadRefOf(this.logChannel, TOP_LEVEL_TS),
			},
			0,
			`📒 완료 보고 사본 · ${where}${link}\n${body}`,
		);
	}

	/**
	 * One transaction: dispatched inbound of the op -> `failed_notified` plus a single notice delivery (part 0).
	 * A monitor origin has no notice: the event retries with backoff, and only the final failure notifies the owner,
	 * so this returns `undefined` for it until then.
	 */
	recordTurnFailure(input: {
		originKey: string;
		opRef: string;
		threadRef: string;
		notice: string;
	}): DeliveryRow | undefined {
		if (input.originKey.startsWith(MONITOR_ORIGIN_PREFIX)) return this.recordMonitorFailure(input);
		return this.db.transaction(() => {
			const steered = this.steeredThreads(input);
			this.closeDispatched(input.originKey, input.opRef, "failed_notified");
			const row = this.insertDelivery(input, 0, input.notice);
			this.notifySteeredThreads(input, steered, input.notice);
			return row;
		})();
	}

	// ---- monitors ----

	/**
	 * The owner's live DM origin key on `platform` (`<platform>/dm/<id>`), newest by updated_at — undefined before the
	 * owner ever DM'd there.
	 */
	ownerDmOrigin(platform: ChatPlatform = "slack"): string | undefined {
		const row = this.db
			.query("SELECT origin_key FROM origins WHERE origin_key LIKE ? ORDER BY updated_at DESC LIMIT 1")
			.get(`${platform}/dm/%`) as { origin_key: string } | null;
		return row?.origin_key;
	}

	/**
	 * Slack only: the owner's known Slack DM, else the Slack owner user id (Slack opens that DM), else `""`. Owner
	 * notices route through `ownerHome()` instead, which never yields an empty conversation.
	 */
	ownerChannel(): string {
		const origin = this.ownerDmOrigin();
		const dm = origin === undefined ? undefined : parseChatOrigin(origin)?.conversationId;
		return dm ?? this.slackOwnerUserId ?? "";
	}

	/** Slack only: thread ref of a top-level post in the Slack owner DM (`ownerChannel()`). */
	topLevelThreadRef(): string {
		return `${this.ownerChannel()}:${TOP_LEVEL_TS}`;
	}

	/** `!home`: the conversation owner notices go to from now on, ahead of every fallback of `ownerHome()`. */
	setOwnerHome(home: OwnerHome): void {
		this.db
			.query(
				`INSERT INTO owner_home (id, platform, conversation_id, set_at) VALUES (1, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET platform = excluded.platform, conversation_id = excluded.conversation_id,
				 set_at = excluded.set_at`,
			)
			.run(home.platform, home.conversationId, this.clock.now());
	}

	/**
	 * Where daemon-level owner notices and channel-less monitor reports go: ① the home registered with `!home`, ② the
	 * Slack owner DM when Slack is on (its known DM, else the owner user id — the long-standing behavior), ③ the
	 * owner's newest 1:1 conversation on any platform, ④ the conversation the owner last wrote in. `undefined` before
	 * any of them exists (a fresh install whose owner has not written yet): callers warn and never post to an empty id.
	 */
	ownerHome(): OwnerHome | undefined {
		const registered = this.db.query("SELECT platform, conversation_id FROM owner_home WHERE id = 1").get() as {
			platform: string;
			conversation_id: string;
		} | null;
		if (registered !== null) {
			const ref = parseChatOrigin(`${registered.platform}/ch/${registered.conversation_id}`);
			if (ref !== undefined) return { platform: ref.platform, conversationId: ref.conversationId };
		}
		const slackDm = this.ownerDmOrigin("slack");
		const slackDmId = slackDm === undefined ? undefined : parseChatOrigin(slackDm)?.conversationId;
		if (slackDmId !== undefined) return { platform: "slack", conversationId: slackDmId };
		if (this.slackOwnerUserId !== undefined) return { platform: "slack", conversationId: this.slackOwnerUserId };
		// A Teams 1:1 the owner wrote in counts even when no session came of it (`ownerMode: qa`), by `owner_at`.
		const dms = this.db
			.query(
				`SELECT origin_key, updated_at AS at FROM origins WHERE origin_key LIKE '%/dm/%'
				 UNION ALL
				 SELECT 'teams/dm/' || alias, owner_at FROM teams_conversations WHERE kind = 'dm' AND owner_at IS NOT NULL
				 ORDER BY at DESC`,
			)
			.all() as Array<{ origin_key: string }>;
		for (const { origin_key } of dms) {
			const ref = parseChatOrigin(origin_key);
			if (ref?.kind === "dm") return { platform: ref.platform, conversationId: ref.conversationId };
		}
		// Owner rows only (a peer bot's request carries its user id); monitor and lane origins are not conversations.
		// A Teams group chat has other people in it: a daemon notice must never land there.
		const spoken = this.db
			.query(
				`SELECT origin_key FROM inbound WHERE peer_user_id IS NULL
				 AND (origin_key LIKE 'slack/%' OR origin_key LIKE 'discord/%' OR origin_key LIKE 'telegram/%'
				      OR origin_key LIKE 'teams/dm/%')
				 ORDER BY inbound_id DESC LIMIT 50`,
			)
			.all() as Array<{ origin_key: string }>;
		for (const { origin_key } of spoken) {
			const ref = parseChatOrigin(origin_key);
			if (ref !== undefined) return { platform: ref.platform, conversationId: ref.conversationId };
		}
		return undefined;
	}

	/**
	 * Records (or refreshes) the Teams conversation behind `alias`: where the Bot Connector takes posts for it. Its
	 * `serviceUrl` can move, so the newest Activity's wins.
	 */
	upsertTeamsConversation(conversation: TeamsConversation): void {
		this.db
			.query(
				`INSERT INTO teams_conversations (alias, conversation_id, service_url, tenant_id, kind, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(alias) DO UPDATE SET conversation_id = excluded.conversation_id,
				 service_url = excluded.service_url, tenant_id = excluded.tenant_id, kind = excluded.kind,
				 updated_at = excluded.updated_at`,
			)
			.run(
				conversation.alias,
				conversation.conversationId,
				conversation.serviceUrl,
				conversation.tenantId,
				conversation.kind,
				this.clock.now(),
			);
	}

	/** The Teams conversation an alias stands for; `undefined` before an Activity of it was taken. */
	teamsConversation(alias: string): TeamsConversation | undefined {
		const row = this.db
			.query("SELECT alias, conversation_id, service_url, tenant_id, kind FROM teams_conversations WHERE alias = ?")
			.get(alias) as {
			alias: string;
			conversation_id: string;
			service_url: string;
			tenant_id: string;
			kind: "dm" | "ch";
		} | null;
		return row === null
			? undefined
			: {
					alias: row.alias,
					conversationId: row.conversation_id,
					serviceUrl: row.service_url,
					tenantId: row.tenant_id,
					kind: row.kind,
				};
	}

	/** The owner just wrote in this Teams conversation: a 1:1 then stays an `ownerHome()` candidate. */
	markTeamsOwnerSpoke(alias: string): void {
		this.db.query("UPDATE teams_conversations SET owner_at = ? WHERE alias = ?").run(this.clock.now(), alias);
	}

	/** Whether `alias` is a Teams 1:1 the owner has written in (`kind = 'dm'`, `owner_at` set): the owner's own 1:1. */
	isTeamsOwnerDm(alias: string): boolean {
		return (
			this.db
				.query("SELECT 1 FROM teams_conversations WHERE alias = ? AND kind = 'dm' AND owner_at IS NOT NULL")
				.get(alias) !== null
		);
	}

	/** One guest/qa question of a Teams conversation (`teams_qa`, context copy only); returns its row id. */
	recordTeamsQuestion(input: {
		alias: string;
		askerAad: string;
		askerName?: string | undefined;
		question: string;
	}): number {
		const row = this.db
			.query("INSERT INTO teams_qa (alias, asker_aad, asker_name, question, at) VALUES (?, ?, ?, ?, ?) RETURNING id")
			.get(input.alias, input.askerAad, input.askerName ?? null, input.question, this.clock.now()) as { id: number };
		return row.id;
	}

	/** The answer the guest/qa run gave to `recordTeamsQuestion`'s row. */
	recordTeamsAnswer(id: number, answer: string): void {
		this.db.query("UPDATE teams_qa SET answer = ? WHERE id = ?").run(answer, id);
	}

	/**
	 * A Teams guest/qa answer (or its one-line notice) as a plain delivery under `teams-qa/<alias>`: no inbound row is
	 * closed, no origin is touched, no log-channel copy is made. Re-recording the same op is a no-op.
	 */
	recordGuestAnswer(input: { alias: string; opRef: string; threadRef: string; body: string }): DeliveryRow {
		return this.insertDelivery(
			{ originKey: `${TEAMS_QA_ORIGIN_PREFIX}${input.alias}`, opRef: input.opRef, threadRef: input.threadRef },
			0,
			input.body,
		);
	}

	/** The newest answered question/answer pairs of one Teams conversation, oldest first; `before` excludes that row on. */
	teamsQaContext(
		alias: string,
		limit: number,
		before?: number,
	): Array<{ askerName: string | undefined; question: string; answer: string }> {
		const rows = this.db
			.query(
				`SELECT asker_name, question, answer FROM teams_qa
				 WHERE alias = ? AND answer IS NOT NULL AND id < ? ORDER BY at DESC, id DESC LIMIT ?`,
			)
			.all(alias, before ?? Number.MAX_SAFE_INTEGER, limit) as Array<{
			asker_name: string | null;
			question: string;
			answer: string;
		}>;
		return rows.reverse().map((row) => ({
			askerName: row.asker_name ?? undefined,
			question: row.question,
			answer: row.answer,
		}));
	}

	/** Top-level thread ref in `ownerHome()`; `undefined` (and the unroutable hook) when there is none. */
	private ownerTopLevelThreadRef(input: { originKey: string; opRef: string }): string | undefined {
		const home = this.ownerHome();
		if (home !== undefined) return threadRefOf(home.conversationId, TOP_LEVEL_TS);
		this.hooks.onOwnerNoticeUnroutable?.(input);
		return undefined;
	}

	/** Monitor event ids of the dispatched inbound rows of an op (message ids are `monitor:<id>:<event>:<attempt>`). */
	private monitorEventsOfOp(originKey: string, opRef: string): number[] {
		const rows = this.db
			.query("SELECT platform_message_id FROM inbound WHERE origin_key = ? AND op_ref = ? AND state = 'dispatched'")
			.all(originKey, opRef) as Array<{ platform_message_id: string }>;
		const ids: number[] = [];
		for (const row of rows) {
			const match = /^monitor:[^:]+:(\d+):\d+$/.exec(row.platform_message_id);
			if (match?.[1] !== undefined) ids.push(Number(match[1]));
		}
		return ids;
	}

	private recordMonitorAnswer(input: { originKey: string; opRef: string; parts: readonly string[] }): DeliveryRow[] {
		return this.db.transaction(() => {
			const eventIds = this.monitorEventsOfOp(input.originKey, input.opRef);
			this.closeDispatched(input.originKey, input.opRef, "answered");
			this.hooks.afterInboundAnswered?.();
			const text = input.parts.join("\n");
			const delivered: DeliveryRow[] = [];
			for (const [part, eventId] of eventIds.entries()) {
				if (text.trim() === EMPTY_ANSWER) {
					this.failMonitorEvent(eventId, "[turn failed] empty_answer");
					continue;
				}
				const settled = this.monitors.settleAnswered(eventId, text);
				if (settled === undefined) continue;
				// A monitor that ran to a normal answer is healthy: its open incidents resolve.
				this.monitors.resolveMonitorIncidents(settled.event.monitorId);
				const monitor = this.monitors.getMonitor(settled.event.monitorId);
				if (!settled.report) {
					// Every settled event of a copy-channel monitor also lands there once, whether or not it was reported.
					this.insertMonitorCopy(
						input,
						part,
						monitor,
						`⏰ ${settled.monitorName}\n${withoutMarkerLines(text) || "알릴 내용 없음"}`,
					);
					continue;
				}
				const report = this.postMonitorReport(input, part, eventId, settled.monitorName, monitor, text);
				if (report !== undefined) delivered.push(report);
			}
			return delivered;
		})();
	}

	/**
	 * Settles one waiting event of a `verbatim` monitor in one transaction, without a turn or an inbound row: its stored
	 * payload is the answer and is posted exactly like a turn's report; an empty payload ends as `no_report` with no
	 * post and no copy. Returns false when the event was not waiting to run.
	 */
	deliverMonitorVerbatim(eventId: number, opRef: string): boolean {
		return this.db.transaction((): boolean => {
			const settled = this.monitors.settleVerbatim(eventId, opRef);
			if (settled === undefined) return false;
			this.monitors.resolveMonitorIncidents(settled.event.monitorId);
			if (!settled.report) return true;
			const originKey = monitorOrigin(settled.event.monitorId);
			const monitor = this.monitors.getMonitor(settled.event.monitorId);
			this.postMonitorReport(
				{ originKey, opRef },
				0,
				eventId,
				settled.monitorName,
				monitor,
				settled.event.answer ?? "",
			);
			return true;
		})();
	}

	/**
	 * The report of one settled monitor event, shared by the turn and verbatim paths: `⏰ <name>\n<text>` at the top
	 * level of the monitor's channel (the owner DM when it has none), linked to the event, plus its copy.
	 */
	private postMonitorReport(
		input: { originKey: string; opRef: string },
		part: number,
		eventId: number,
		monitorName: string,
		monitor: MonitorRow | undefined,
		text: string,
	): DeliveryRow | undefined {
		const channel = monitor?.channel;
		const body = `⏰ ${monitorName}\n${text}`;
		// The scheduler holds channel-less events while there is no owner home, so this is only a home lost meanwhile.
		const threadRef = channel ? threadRefOf(channel, TOP_LEVEL_TS) : this.ownerTopLevelThreadRef(input);
		const row =
			threadRef === undefined
				? undefined
				: this.insertDelivery({ originKey: input.originKey, opRef: input.opRef, threadRef }, part, body);
		if (row !== undefined) this.monitors.attachDelivery(eventId, row.deliveryId);
		this.insertMonitorCopy(input, part, monitor, body);
		return row;
	}

	/** A top-level copy (`<opRef>:copy`) of a settled monitor event in the monitor's copy channel, if it has one. */
	private insertMonitorCopy(
		input: { originKey: string; opRef: string },
		part: number,
		monitor: MonitorRow | undefined,
		body: string,
	): void {
		if (!monitor?.copyChannel) return;
		this.insertDelivery(
			{
				originKey: input.originKey,
				opRef: `${input.opRef}${MONITOR_COPY_SUFFIX}`,
				threadRef: threadRefOf(monitor.copyChannel, TOP_LEVEL_TS),
			},
			part,
			body,
		);
	}

	private recordMonitorFailure(input: { originKey: string; opRef: string; notice: string }): DeliveryRow | undefined {
		return this.db.transaction(() => {
			const eventIds = this.monitorEventsOfOp(input.originKey, input.opRef);
			this.closeDispatched(input.originKey, input.opRef, "failed_notified");
			let notice: DeliveryRow | undefined;
			for (const eventId of eventIds) notice = this.failMonitorEvent(eventId, input.notice) ?? notice;
			return notice;
		})();
	}

	/** Counts one failed attempt; the final failure (retries spent) posts a single notice to the owner DM. */
	failMonitorEvent(eventId: number, error: string): DeliveryRow | undefined {
		return this.db.transaction(() => {
			const settled = this.monitors.settleFailed(eventId, error);
			if (!settled?.terminal) return undefined;
			// Same monitor + same normalized error inside the repeat window stays quiet (hermes incident dedup).
			const incident = this.monitors.recordMonitorIncident(settled.event.monitorId, error, this.clock.now());
			if (!incident.notify) return undefined;
			const reason = error.replace(/^\[turn failed\]\s*/, "").replace(/\s+—.*$/, "");
			const repeat = incident.count > 1 ? ` · 반복 ${incident.count}회차` : "";
			const target = { originKey: monitorOrigin(settled.event.monitorId), opRef: `monitor-notice:${eventId}` };
			const threadRef = this.ownerTopLevelThreadRef(target);
			if (threadRef === undefined) return undefined;
			return this.insertDelivery(
				{ ...target, threadRef },
				0,
				`⏰ ${settled.monitorName}\n⚠️ 모니터 실행이 ${settled.event.attempts}번 실패해 재시도를 멈췄습니다 (failed_no_retry${repeat}): ${reason}`,
			);
		})();
	}

	// ---- daily cost ledger (`costCap`, src/ops/cost-cap.ts) ----

	/** Adds one finished turn's priced cost to the day's row of its origin (`day` keyed in the bot's zone). */
	addDailyUsage(input: { day: string; originKey: string; cost: number; calls: number }): void {
		this.db
			.query(
				`INSERT INTO usage_daily (day, origin_key, cost, calls) VALUES (?, ?, ?, ?)
				 ON CONFLICT(day, origin_key) DO UPDATE SET cost = cost + excluded.cost, calls = calls + excluded.calls`,
			)
			.run(input.day, input.originKey, input.cost, input.calls);
	}

	/** The day's total cost, or the sum of its rows when `originKey` is given. */
	dailyCost(day: string, originKey?: string): number {
		const row = (
			originKey === undefined
				? this.db.query("SELECT COALESCE(SUM(cost), 0) AS cost FROM usage_daily WHERE day = ?").get(day)
				: this.db
						.query("SELECT COALESCE(SUM(cost), 0) AS cost FROM usage_daily WHERE day = ? AND origin_key = ?")
						.get(day, originKey)
		) as { cost: number } | null;
		return row?.cost ?? 0;
	}

	/** The day's biggest spenders, largest first. */
	topDailyOrigins(day: string, limit: number): Array<{ originKey: string; cost: number }> {
		const rows = this.db
			.query("SELECT origin_key, cost FROM usage_daily WHERE day = ? ORDER BY cost DESC, origin_key LIMIT ?")
			.all(day, limit) as Array<{ origin_key: string; cost: number }>;
		return rows.map((row) => ({ originKey: row.origin_key, cost: row.cost }));
	}

	// ---- alert incidents (owner-notice repeat suppression) ----

	/**
	 * Counts one occurrence of an alert condition and decides whether the owner should be told (the shared incident
	 * state machine — see `monitors/incidents`): the first occurrence alerts, the same (scope, normalized sign) within
	 * `repeatMs` stays quiet, a still-standing condition re-alerts after `repeatMs`, and a resolved condition that
	 * comes back reopens loudly (monitor incident semantics, used by the turn-failure escalation and the daemon's
	 * gate sweep). `standing` reports the row's pre-call state, so a restarting daemon can rebuild "the owner was
	 * already alerted" from the ledger alone.
	 */
	recordAlertIncident(scope: string, sign: string, now: number, repeatMs = ALERT_INCIDENT_REPEAT_MS): AlertIncident {
		return countIncident(this.db, "alert_incidents", scope, sign, now, repeatMs);
	}

	/** Marks the scope's open incidents resolved, so the same condition re-alerts when it comes back. */
	resolveAlertIncidents(scope: string): void {
		resolveIncidents(this.db, "alert_incidents", scope);
	}

	// ---- thread mutes ----

	/** Whether the owner muted this thread with `!shutup` (channel threads): addressed messages there stay quiet. */
	isThreadMuted(threadRef: string): boolean {
		return this.db.query("SELECT 1 FROM thread_mutes WHERE thread_ref = ? LIMIT 1").get(threadRef) !== null;
	}

	/** Records or clears a thread mute (`!shutup`, `!unshutup`, or the owner mentioning the bot); idempotent. */
	setThreadMute(threadRef: string, muted: boolean): void {
		if (muted) {
			this.db
				.query("INSERT INTO thread_mutes (thread_ref, muted_at) VALUES (?, ?) ON CONFLICT(thread_ref) DO NOTHING")
				.run(threadRef, this.clock.now());
		} else {
			this.db.query("DELETE FROM thread_mutes WHERE thread_ref = ?").run(threadRef);
		}
	}

	// ---- herdr prompts (dashboard 마지막 지시) ----

	/**
	 * Records one prompt herdr took as a masked one-line preview, then keeps the agent's newest
	 * `HERDR_PROMPT_ROWS_KEPT` rows and drops every row older than `HERDR_PROMPT_KEEP_MS`.
	 */
	recordHerdrPrompt(input: HerdrPromptInput): void {
		const now = this.clock.now();
		this.db.transaction(() => {
			this.db
				.query("INSERT INTO herdr_prompts (host, agent, kind, preview, origin_key, at) VALUES (?, ?, ?, ?, ?, ?)")
				.run(
					input.host ?? "",
					input.agent,
					input.kind,
					previewLine(input.text, undefined, HERDR_PROMPT_PREVIEW_CHARS),
					input.originKey,
					now,
				);
			this.db
				.query(
					"DELETE FROM herdr_prompts WHERE agent = ? AND id NOT IN (SELECT id FROM herdr_prompts WHERE agent = ? ORDER BY id DESC LIMIT ?)",
				)
				.run(input.agent, input.agent, HERDR_PROMPT_ROWS_KEPT);
			this.db.query("DELETE FROM herdr_prompts WHERE at < ?").run(now - HERDR_PROMPT_KEEP_MS);
		})();
	}

	// ---- turn snapshots (`!undo`) ----

	/**
	 * Appends one turn snapshot and keeps only the newest `TURN_SNAPSHOT_ROWS_KEPT` rows of that origin. The rows dropped
	 * by that bound come back as `pruned` so the caller can delete their refs.
	 */
	recordTurnSnapshot(input: TurnSnapshotInput): { id: number; pruned: TurnSnapshotRow[] } {
		const inserted = this.db
			.query(
				`INSERT INTO turn_snapshots (origin_key, op_ref, repo, head_before, tree_before, head_after, tree_after, started_at, ended_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.originKey,
				input.opRef,
				input.repo,
				input.headBefore,
				input.treeBefore,
				input.headAfter,
				input.treeAfter,
				input.startedAt,
				input.endedAt,
			);
		const id = Number(inserted.lastInsertRowid);
		const overflow = this.db
			.query(
				`SELECT * FROM turn_snapshots WHERE origin_key = ?
				 ORDER BY id DESC LIMIT -1 OFFSET ?`,
			)
			.all(input.originKey, TURN_SNAPSHOT_ROWS_KEPT) as TurnSnapshotSql[];
		const pruned = overflow.map(toTurnSnapshot);
		const drop = this.db.query("DELETE FROM turn_snapshots WHERE id = ?");
		for (const row of pruned) drop.run(row.id);
		return { id, pruned };
	}

	/** Rows newest first; every filter is optional and compared literally. */
	listTurnSnapshots(
		filter: { originKey?: string; repo?: string; opRef?: string; undoable?: boolean } = {},
	): TurnSnapshotRow[] {
		const rows = this.db
			.query(
				`SELECT * FROM turn_snapshots
				 WHERE (?1 IS NULL OR origin_key = ?1) AND (?2 IS NULL OR repo = ?2) AND (?3 IS NULL OR op_ref = ?3)
				   AND (?4 = 0 OR reverted_at IS NULL)
				 ORDER BY id DESC`,
			)
			.all(
				filter.originKey ?? null,
				filter.repo ?? null,
				filter.opRef ?? null,
				filter.undoable === true ? 1 : 0,
			) as TurnSnapshotSql[];
		return rows.map(toTurnSnapshot);
	}

	/**
	 * The origin's most recent turn that can still be undone: its newest `op_ref` among rows with no `reverted_at`.
	 * Returns every repository row of that turn (oldest first), or `[]` when nothing changed or all was undone.
	 */
	latestUndoableTurn(originKey: string): TurnSnapshotRow[] {
		const newest = this.listTurnSnapshots({ originKey, undoable: true })[0];
		if (newest === undefined) return [];
		const rows = this.listTurnSnapshots({ originKey, opRef: newest.opRef, undoable: true });
		return rows.reverse();
	}

	/** Marks a turn's rows as undone at `at`; returns how many rows changed. */
	markTurnReverted(originKey: string, opRef: string, at: number): number {
		return this.db
			.query("UPDATE turn_snapshots SET reverted_at = ? WHERE origin_key = ? AND op_ref = ? AND reverted_at IS NULL")
			.run(at, originKey, opRef).changes;
	}

	/** Deletes the rows older than `cutoff` (by `ended_at`) and returns them, so `ompbot gc` can drop their refs. */
	deleteTurnSnapshotsBefore(cutoff: number): TurnSnapshotRow[] {
		const rows = this.db
			.query("SELECT * FROM turn_snapshots WHERE ended_at < ? ORDER BY id")
			.all(cutoff) as TurnSnapshotSql[];
		if (rows.length === 0) return [];
		this.db.query("DELETE FROM turn_snapshots WHERE ended_at < ?").run(cutoff);
		return rows.map(toTurnSnapshot);
	}

	// ---- deliveries ----

	getDelivery(deliveryId: number): DeliveryRow | undefined {
		const row = this.db.query("SELECT * FROM deliveries WHERE delivery_id = ?").get(deliveryId) as DeliverySql | null;
		return row ? toDelivery(row) : undefined;
	}

	listDeliveries(filter: { originKey?: string; state?: DeliveryState } = {}): DeliveryRow[] {
		const rows = this.db
			.query(
				"SELECT * FROM deliveries WHERE (?1 IS NULL OR origin_key = ?1) AND (?2 IS NULL OR state = ?2) ORDER BY delivery_id",
			)
			.all(filter.originKey ?? null, filter.state ?? null) as DeliverySql[];
		return rows.map(toDelivery);
	}

	/**
	 * Confirmed first-part deliveries other origins posted into a Slack thread, oldest first — answers the
	 * thread's own session has never seen (the root's answers come from the parent channel's origin).
	 */
	listThreadForeignDeliveries(threadRef: string, excludeOriginKey: string, limit: number): DeliveryRow[] {
		const rows = this.db
			.query(
				`SELECT * FROM deliveries
				 WHERE thread_ref = ? AND origin_key != ? AND state = 'confirmed' AND part = 0
				 ORDER BY delivery_id DESC LIMIT ?`,
			)
			.all(threadRef, excludeOriginKey, limit) as DeliverySql[];
		return rows.map(toDelivery).reverse();
	}

	/** Per-state delivery row counts (`GROUP BY`); lets /status count without loading every body. */
	countDeliveriesByState(): Partial<Record<DeliveryState, number>> {
		const counts: Partial<Record<DeliveryState, number>> = {};
		for (const row of this.db.query("SELECT state, COUNT(*) AS n FROM deliveries GROUP BY state").all() as Array<{
			state: DeliveryState;
			n: number;
		}>) {
			counts[row.state] = row.n;
		}
		return counts;
	}

	/** Expires pending rows older than 24h. failed_ambiguous rows are never touched. Returns how many expired. */
	sweepExpired(): number {
		const now = this.clock.now();
		return this.db.transaction(() => {
			let expired = 0;
			for (const row of this.selectDeliveries("state = 'pending' AND created_at <= ?", [now - FRESHNESS_MS])) {
				if (this.applyEvent(row, "expire_check", now).state === "expired") expired++;
			}
			return expired;
		})();
	}

	/**
	 * Sweeps stale rows, then moves up to `limit` due pending deliveries (next_at <= now) to inflight and returns them.
	 * With `platform` only the rows whose thread ref posts to that platform are taken (monitor and lane answers
	 * included: their thread ref is a chat conversation like any other); the rest stay pending for their adapter.
	 */
	claimDue(limit = 20, platform?: IdPlatform): DeliveryRow[] {
		const now = this.clock.now();
		this.sweepExpired();
		return this.db.transaction(() =>
			this.selectDeliveries("state = 'pending' AND next_at <= ? ORDER BY delivery_id", [now])
				.filter((row) => platform === undefined || platformOfThreadRef(row.threadRef) === platform)
				.slice(0, limit)
				.map((row) => this.applyEvent(row, "claim", now)),
		)();
	}

	confirmDelivery(deliveryId: number): DeliveryRow {
		return this.applyEvent(this.requireDelivery(deliveryId), "confirmed", this.clock.now());
	}

	/** A send that definitely did not happen: backoff, or expired after 5 failures / 24h. */
	failDelivery(deliveryId: number, error: string): DeliveryRow {
		return this.applyEvent(this.requireDelivery(deliveryId), "definitive_failure", this.clock.now(), error);
	}

	/**
	 * Slack refused the send for now (429, or the method still blocked): back to `pending` at `retry.at` without
	 * counting an attempt; `sentParts`/`replyTs` record how far a multi-message answer got, so the resume posts only
	 * the rest. Still expires past the freshness window.
	 */
	deferDelivery(
		deliveryId: number,
		error: string,
		retry: { at: number; sentParts: number; replyTs?: string | undefined },
	): DeliveryRow {
		return this.db.transaction(() => {
			const row = this.applyEvent(this.requireDelivery(deliveryId), "rate_limited", this.clock.now(), error, retry.at);
			if (row.state !== "pending") return row;
			this.db
				.query("UPDATE deliveries SET sent_parts = ?, reply_ts = COALESCE(?, reply_ts) WHERE delivery_id = ?")
				.run(retry.sentParts, retry.replyTs ?? null, deliveryId);
			return this.requireDelivery(deliveryId);
		})();
	}

	/** A send whose outcome is unknown. Sticky; never resent or expired automatically. */
	markAmbiguous(deliveryId: number, error: string): DeliveryRow {
		return this.applyEvent(this.requireDelivery(deliveryId), "ambiguous", this.clock.now(), error);
	}

	/**
	 * Startup recovery only: a `failed_ambiguous` delivery younger than the freshness window goes back to `pending`
	 * with redelivered=1, so the owner gets it again with the "중복 가능" header. Returns how many were requeued.
	 */
	requeueAmbiguous(): number {
		const now = this.clock.now();
		return this.db
			.query(
				"UPDATE deliveries SET state = 'pending', redelivered = 1, next_at = ? WHERE state = 'failed_ambiguous' AND ? - created_at < ?",
			)
			.run(now, now, FRESHNESS_MS).changes;
	}

	// ---- lanes (work lane registry) ----

	/** New lane in `working`; its origin row is created in the same transaction. Name, thread and origin are unique. */
	insertLane(input: {
		name: string;
		title: string;
		threadRef: string;
		originKey: string;
		cwd: string;
		sessionDir: string;
		meta: LaneMeta;
	}): LaneRow {
		const now = this.clock.now();
		const history: LaneHistoryEntry[] = [{ at: now, event: "created" }];
		this.db.transaction(() => {
			this.ensureOrigin(input.originKey, input.sessionDir);
			this.db
				.query(
					"INSERT INTO lanes (name, title, thread_ref, origin_key, cwd, session_dir, history, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					input.name,
					this.redact(input.title),
					input.threadRef,
					input.originKey,
					input.cwd,
					input.sessionDir,
					JSON.stringify(history),
					JSON.stringify(input.meta),
					now,
					now,
				);
		})();
		return this.requireLane(input.name);
	}

	getLane(name: string): LaneRow | undefined {
		const row = this.db.query("SELECT * FROM lanes WHERE name = ?").get(name) as LaneSql | null;
		return row ? toLane(row) : undefined;
	}

	getLaneByThread(threadRef: string): LaneRow | undefined {
		const row = this.db.query("SELECT * FROM lanes WHERE thread_ref = ?").get(threadRef) as LaneSql | null;
		return row ? toLane(row) : undefined;
	}

	getLaneByOrigin(originKey: string): LaneRow | undefined {
		const row = this.db.query("SELECT * FROM lanes WHERE origin_key = ?").get(originKey) as LaneSql | null;
		return row ? toLane(row) : undefined;
	}

	listLanes(filter: { status?: LaneStatus } = {}): LaneRow[] {
		const rows = this.db
			.query("SELECT * FROM lanes WHERE (?1 IS NULL OR status = ?1) ORDER BY created_at, name")
			.all(filter.status ?? null) as LaneSql[];
		return rows.map(toLane);
	}

	/** Lanes that still occupy a slot of the concurrency cap (everything but `closed`). */
	countOpenLanes(): number {
		const row = this.db.query("SELECT COUNT(*) AS n FROM lanes WHERE status != 'closed'").get() as { n: number };
		return row.n;
	}

	/** Changes the status (validated against the lane state machine) and appends a history entry in one write. */
	transitionLane(
		name: string,
		to: LaneStatus,
		entry: Omit<LaneHistoryEntry, "at">,
		metaPatch: Partial<LaneMeta> = {},
	): LaneRow {
		const current = this.requireLane(name);
		assertLaneTransition(current.status, to);
		return this.writeLane(current, to, entry, metaPatch);
	}

	/** Appends history and/or merges meta without a status change. */
	patchLane(name: string, entry: Omit<LaneHistoryEntry, "at"> | undefined, metaPatch: Partial<LaneMeta>): LaneRow {
		const current = this.requireLane(name);
		return this.writeLane(current, current.status, entry, metaPatch);
	}

	private writeLane(
		current: LaneRow,
		status: LaneStatus,
		entry: Omit<LaneHistoryEntry, "at"> | undefined,
		metaPatch: Partial<LaneMeta>,
	): LaneRow {
		const now = this.clock.now();
		const history = entry
			? [
					...current.history,
					{ ...entry, ...(entry.detail === undefined ? {} : { detail: this.redact(entry.detail) }), at: now },
				].slice(-MAX_LANE_HISTORY)
			: current.history;
		const meta = { ...current.meta, ...metaPatch };
		this.db
			.query("UPDATE lanes SET status = ?, history = ?, meta = ?, updated_at = ? WHERE name = ?")
			.run(status, JSON.stringify(history), JSON.stringify(meta), now, current.name);
		return this.requireLane(current.name);
	}

	private requireLane(name: string): LaneRow {
		const lane = this.getLane(name);
		if (!lane) throw new StoreError("not_found", `lane ${name}`);
		return lane;
	}

	// ---- internals ----

	/**
	 * Adds `inbound.thread_ref` (backfilled from platform_message_id), `inbound.last_event_at` and the `origins`
	 * session/model columns to databases created before they existed. The `inbound_thread` index lives here too:
	 * it must be created after the `thread_ref` column may have been added above, so a pre-migration ledger can
	 * still be opened. The `approvals_status` index lives here for the same reason: it must be created after the
	 * approvals rebuild may have replaced the table.
	 */
	private migrate(): void {
		const originColumns = this.db.query("PRAGMA table_info(origins)").all() as Array<{ name: string }>;
		for (const column of ["session_file", "model", "thinking"]) {
			if (!originColumns.some((existing) => existing.name === column)) {
				this.db.run(`ALTER TABLE origins ADD COLUMN ${column} TEXT`);
			}
		}
		const columns = this.db.query("PRAGMA table_info(inbound)").all() as Array<{ name: string }>;
		if (!columns.some((column) => column.name === "thread_ref")) {
			this.db.run("ALTER TABLE inbound ADD COLUMN thread_ref TEXT");
		}
		if (!columns.some((column) => column.name === "last_event_at")) {
			this.db.run("ALTER TABLE inbound ADD COLUMN last_event_at INTEGER");
		}
		if (!columns.some((column) => column.name === "peer_user_id")) {
			this.db.run("ALTER TABLE inbound ADD COLUMN peer_user_id TEXT");
		}
		const deliveryColumns = this.db.query("PRAGMA table_info(deliveries)").all() as Array<{ name: string }>;
		if (!deliveryColumns.some((column) => column.name === "sent_parts")) {
			this.db.run("ALTER TABLE deliveries ADD COLUMN sent_parts INTEGER");
		}
		if (!deliveryColumns.some((column) => column.name === "reply_ts")) {
			this.db.run("ALTER TABLE deliveries ADD COLUMN reply_ts TEXT");
		}
		const teamsColumns = this.db.query("PRAGMA table_info(teams_conversations)").all() as Array<{ name: string }>;
		if (!teamsColumns.some((column) => column.name === "owner_at")) {
			this.db.run("ALTER TABLE teams_conversations ADD COLUMN owner_at INTEGER");
		}
		this.db.run("UPDATE inbound SET thread_ref = platform_message_id WHERE thread_ref IS NULL");
		this.db.run("CREATE INDEX IF NOT EXISTS inbound_thread ON inbound(thread_ref)");
		this.migrateApprovals();
		this.migrateLanes();
		// After the rebuild (which already creates the dashboard columns): a 'replied'-era table lacks them, and every
		// table lacks `mirror_ref` until this adds it.
		const approvalColumns = this.db.query("PRAGMA table_info(approvals)").all() as Array<{ name: string }>;
		for (const column of ["detail_json", "card_url", "origin_url", "mirror_ref"]) {
			if (!approvalColumns.some((existing) => existing.name === column)) {
				this.db.run(`ALTER TABLE approvals ADD COLUMN ${column} TEXT`);
			}
		}
		// The approvals status index lives here, not in SCHEMA: the rebuild above drops whatever index the old
		// table carried (a RENAME follows the table, the DROP kills it), so a pre-'replied' ledger would end this
		// open without it. This runs after every open, so the sweep's status = 'pending' scan stays indexed.
		this.db.run("CREATE INDEX IF NOT EXISTS approvals_status ON approvals(status)");
	}

	/**
	 * The `replied` status widens a CHECK constraint, which SQLite cannot ALTER: an approvals table without it is
	 * rebuilt (rename, create, copy, drop) in one transaction. Old rows keep their data; the new columns are NULL.
	 */
	private migrateApprovals(): void {
		const current = this.db
			.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'approvals'")
			.get() as {
			sql: string;
		} | null;
		if (current === null || current.sql.includes("'replied'")) return;
		this.db.transaction(() => {
			this.db.run("ALTER TABLE approvals RENAME TO approvals_old");
			this.db.run(APPROVALS_DDL);
			this.db.run(
				"INSERT INTO approvals (approval_id, channel, message_ts, summary, status, created_at, expires_at, decided_at) SELECT approval_id, channel, message_ts, summary, status, created_at, expires_at, decided_at FROM approvals_old",
			);
			this.db.run("DROP TABLE approvals_old");
		})();
	}

	/**
	 * The `paused` status widens a CHECK constraint, which SQLite cannot ALTER: a lanes table without it is
	 * rebuilt (rename, create, copy, drop) in one transaction. Existing rows keep their data.
	 */
	private migrateLanes(): void {
		const current = this.db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'lanes'").get() as {
			sql: string;
		} | null;
		if (current === null || current.sql.includes("'paused'")) return;
		this.db.transaction(() => {
			this.db.run("ALTER TABLE lanes RENAME TO lanes_old");
			this.db.run(LANES_DDL);
			this.db.run(
				"INSERT INTO lanes (name, title, thread_ref, origin_key, cwd, session_dir, status, history, meta, created_at, updated_at) SELECT name, title, thread_ref, origin_key, cwd, session_dir, status, history, meta, created_at, updated_at FROM lanes_old",
			);
			this.db.run("DROP TABLE lanes_old");
		})();
	}

	private requireOrigin(originKey: string): OriginRow {
		const origin = this.getOrigin(originKey);
		if (!origin) throw new StoreError("unknown_origin", originKey);
		return origin;
	}

	private requireInbound(platformMessageId: string): InboundRow {
		const row = this.getInbound(platformMessageId);
		if (!row) throw new StoreError("not_found", `inbound ${platformMessageId}`);
		return row;
	}

	private requireDelivery(deliveryId: number): DeliveryRow {
		const row = this.getDelivery(deliveryId);
		if (!row) throw new StoreError("not_found", `delivery ${deliveryId}`);
		return row;
	}

	private selectDeliveries(where: string, params: (string | number)[]): DeliveryRow[] {
		return (this.db.query(`SELECT * FROM deliveries WHERE ${where}`).all(...params) as DeliverySql[]).map(toDelivery);
	}

	private closeDispatched(originKey: string, opRef: string, to: "answered" | "failed_notified"): void {
		assertInboundTransition("dispatched", to);
		this.db
			.query("UPDATE inbound SET state = ? WHERE origin_key = ? AND op_ref = ? AND state = 'dispatched'")
			.run(to, originKey, opRef);
	}

	private insertDelivery(
		input: { originKey: string; opRef: string; threadRef: string },
		part: number,
		body: string,
	): DeliveryRow {
		const now = this.clock.now();
		const inserted = this.db
			.query(
				"INSERT INTO deliveries (origin_key, op_ref, part, thread_ref, body, next_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(origin_key, op_ref, part) DO NOTHING",
			)
			.run(input.originKey, input.opRef, part, input.threadRef, this.redact(body), now, now);
		const row = toDelivery(
			this.db
				.query("SELECT * FROM deliveries WHERE origin_key = ? AND op_ref = ? AND part = ?")
				.get(input.originKey, input.opRef, part) as DeliverySql,
		);
		if (inserted.changes === 1) this.emitDeliveryState(row.deliveryId, "new", row.state);
		return row;
	}

	private applyEvent(
		row: DeliveryRow,
		event: DeliveryEvent,
		now: number,
		error?: string,
		retryAt?: number,
	): DeliveryRow {
		const facts: DeliveryFacts = {
			state: row.state,
			attempts: row.attempts,
			nextAt: row.nextAt,
			redelivered: row.redelivered,
			createdAt: row.createdAt,
		};
		const next = transitionDelivery(facts, event, now, retryAt);
		if (next === facts) return row;
		this.db
			.query(
				"UPDATE deliveries SET state = ?, attempts = ?, next_at = ?, redelivered = ?, last_error = COALESCE(?, last_error) WHERE delivery_id = ?",
			)
			.run(
				next.state,
				next.attempts,
				next.nextAt,
				next.redelivered ? 1 : 0,
				error === undefined ? null : this.redact(error),
				row.deliveryId,
			);
		this.emitDeliveryState(row.deliveryId, row.state, next.state);
		return this.requireDelivery(row.deliveryId);
	}

	/** A failing observer (e.g. a full disk under the logger) must never abort or roll back a ledger transition. */
	private emitDeliveryState(deliveryId: number, from: DeliveryState | "new", to: DeliveryState): void {
		try {
			this.hooks.onDeliveryState?.({ deliveryId, from, to });
		} catch {
			// observers only; the transition itself is already durable
		}
	}
}

export function openStore(options: StoreOptions): Store {
	return new Store(options);
}
