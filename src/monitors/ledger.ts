import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { type CronSchedule, nextFire, parseCron } from "./cron";
import { countIncident, resolveIncidents } from "./incidents";
import {
	type MonitorDeliver,
	type MonitorOverlap,
	type MonitorSpec,
	type MonitorThinking,
	type MonitorTrigger,
	parseAt,
} from "./spec";

export const NO_REPORT = "NO_REPORT";
/** Entire-response / first-line / last-line answer that skips the Slack delivery (hermes monitor mode). */
export const SILENT = "[SILENT]";
export const MONITOR_ORIGIN_PREFIX = "monitor/";
/** The same monitor failing with the same normalized error re-alerts after this long, not on every fire. */
export const MONITOR_INCIDENT_REPEAT_MS = 24 * 60 * 60_000;

export const monitorOrigin = (monitorId: string): string => `${MONITOR_ORIGIN_PREFIX}${monitorId}`;

/** The whole-response / first-line / last-line markers that keep a monitor answer off the Slack delivery. */
const SILENT_MARKERS: ReadonlySet<string> = new Set([NO_REPORT, SILENT]);

const isMarkerLine = (line: string | undefined): boolean => SILENT_MARKERS.has(line?.trim() ?? "");

/** Whether the first or last line of the answer is `NO_REPORT` / `[SILENT]` (the monitor has nothing to deliver). */
export const isSilentAnswer = (answer: string): boolean => {
	const lines = answer.trim().split("\n");
	return isMarkerLine(lines[0]) || isMarkerLine(lines[lines.length - 1]);
};

/** The answer without its leading / trailing `NO_REPORT` / `[SILENT]` marker lines (what a silent copy keeps). */
export const withoutMarkerLines = (answer: string): string => {
	const lines = answer.trim().split("\n");
	if (isMarkerLine(lines[0])) lines.shift();
	if (isMarkerLine(lines[lines.length - 1])) lines.pop();
	return lines.join("\n").trim();
};

/** Delay before retry n (1-based) of a failed event: 10 minutes, 1 hour, 4 hours. A 4th failure is final. */
export const RETRY_BACKOFF_MS: readonly number[] = [10 * 60_000, 60 * 60_000, 4 * 60 * 60_000];

export type EventStage =
	| "admitted"
	| "dispatched"
	| "authored"
	| "delivered"
	| "failed"
	| "failed_no_retry"
	| "skipped"
	| "no_report";

export interface MonitorClock {
	now(): number;
}

export type ScriptState = "met" | "unmet";

export interface MonitorRow {
	id: string;
	name: string;
	trigger: MonitorTrigger;
	instruction: string;
	overlap: MonitorOverlap;
	enabled: boolean;
	/** Slack or Discord channel the answer goes to (top level); null = the Slack owner DM. */
	channel: string | null;
	/** Slack or Discord channel that also gets a top-level copy of every settled event; null = no copy. */
	copyChannel: string | null;
	/** omp model id pinned to this monitor's session; null = no pin. */
	model: string | null;
	/** omp thinking level pinned to this monitor's session; null = no pin. */
	thinking: MonitorThinking | null;
	/** `turn`: each fire runs an omp turn; `verbatim` (script only): the payload is posted as the answer, no turn. */
	deliver: MonitorDeliver;
	/** Files (inside workspaceDir or the scripts root) re-read into every fire's prompt. */
	procedureFiles: string[];
	/** Every cron slot at or before the cursor has been claimed or skipped; for scripts, the start of the last check. */
	cursorAt: number;
	/** Script monitors: the result of the last definitive check (exit 0 = met), or null before the first one. */
	lastScriptState: ScriptState | null;
	/** Script monitors: sha256 of the last met check's stdout — `suppressUnchanged` compares against it. */
	lastOutputHash: string | null;
	/** Script and watcher monitors: the last check (or watch) error, cleared by the next good one. */
	lastCheckError: string | null;
	lastCheckErrorAt: number | null;
	/** Check errors in a row; the owner is told once when it reaches `CHECK_ERROR_ALERT_STREAK`. */
	checkErrorStreak: number;
	createdAt: number;
	updatedAt: number;
}

export interface MonitorEventRow {
	eventId: number;
	monitorId: string;
	slotAt: number;
	stage: EventStage;
	payload: string | null;
	/** Failed attempts so far. */
	attempts: number;
	nextAttemptAt: number | null;
	inboundId: string | null;
	answer: string | null;
	error: string | null;
	deliveryId: number | null;
	skippedBy: number | null;
	manual: boolean;
	createdAt: number;
	updatedAt: number;
}

export type ClaimResult =
	| { status: "admitted" | "skipped_overlap"; event: MonitorEventRow }
	| { status: "duplicate" | "missing" };

export const MONITOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS monitors (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	trigger_json TEXT NOT NULL,
	instruction TEXT NOT NULL,
	overlap TEXT NOT NULL DEFAULT 'queue' CHECK (overlap IN ('skip','queue')),
	enabled INTEGER NOT NULL DEFAULT 1,
	channel TEXT,
	copy_channel TEXT,
	model TEXT,
	thinking TEXT,
	deliver TEXT NOT NULL DEFAULT 'turn' CHECK (deliver IN ('turn','verbatim')),
	procedure_files TEXT,
	cursor_at INTEGER NOT NULL,
	last_script_state TEXT CHECK (last_script_state IN ('met','unmet')),
	last_check_error TEXT,
	last_check_error_at INTEGER,
	check_error_streak INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS monitor_slots (
	slot_id INTEGER PRIMARY KEY AUTOINCREMENT,
	monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
	slot_at INTEGER NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('claimed','skipped')),
	reason TEXT,
	created_at INTEGER NOT NULL,
	UNIQUE (monitor_id, slot_at)
);
CREATE TABLE IF NOT EXISTS monitor_events (
	event_id INTEGER PRIMARY KEY AUTOINCREMENT,
	monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
	slot_at INTEGER NOT NULL,
	stage TEXT NOT NULL CHECK (stage IN ('admitted','dispatched','authored','delivered','failed','failed_no_retry','skipped','no_report')),
	payload TEXT,
	attempts INTEGER NOT NULL DEFAULT 0,
	next_attempt_at INTEGER,
	inbound_id TEXT,
	answer TEXT,
	error TEXT,
	delivery_id INTEGER,
	skipped_by INTEGER,
	manual INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS monitor_events_monitor_stage ON monitor_events(monitor_id, stage);
CREATE INDEX IF NOT EXISTS monitor_events_stage ON monitor_events(stage);
CREATE INDEX IF NOT EXISTS monitor_events_monitor_event ON monitor_events(monitor_id, event_id);
CREATE TABLE IF NOT EXISTS monitor_incidents (
	incident_id INTEGER PRIMARY KEY AUTOINCREMENT,
	monitor_id TEXT NOT NULL,
	signature TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'alerted' CHECK (status IN ('alerted','resolved')),
	count INTEGER NOT NULL DEFAULT 1,
	first_at INTEGER NOT NULL,
	last_at INTEGER NOT NULL,
	alerted_at INTEGER NOT NULL,
	UNIQUE (monitor_id, signature)
);
`;

/**
 * Creates the monitor tables in a database that may predate them (every statement is idempotent, so opening an old
 * ledger only adds what is missing and never touches its rows).
 */
export function migrateMonitorSchema(db: Database): void {
	db.run(MONITOR_SCHEMA);
	const columns = db.query("PRAGMA table_info(monitors)").all() as Array<{ name: string }>;
	// Rows that predate edge triggering start with no observation (null).
	if (!columns.some((column) => column.name === "last_script_state")) {
		db.run("ALTER TABLE monitors ADD COLUMN last_script_state TEXT CHECK (last_script_state IN ('met','unmet'))");
	}
	if (!columns.some((column) => column.name === "last_output_hash")) {
		db.run("ALTER TABLE monitors ADD COLUMN last_output_hash TEXT");
	}
	if (!columns.some((column) => column.name === "channel")) {
		db.run("ALTER TABLE monitors ADD COLUMN channel TEXT");
	}
	if (!columns.some((column) => column.name === "copy_channel")) {
		db.run("ALTER TABLE monitors ADD COLUMN copy_channel TEXT");
	}
	if (!columns.some((column) => column.name === "model")) {
		db.run("ALTER TABLE monitors ADD COLUMN model TEXT");
	}
	if (!columns.some((column) => column.name === "thinking")) {
		db.run("ALTER TABLE monitors ADD COLUMN thinking TEXT");
	}
	// Monitors that predate verbatim delivery keep running turns.
	if (!columns.some((column) => column.name === "deliver")) {
		db.run(
			"ALTER TABLE monitors ADD COLUMN deliver TEXT NOT NULL DEFAULT 'turn' CHECK (deliver IN ('turn','verbatim'))",
		);
	}
	if (!columns.some((column) => column.name === "procedure_files")) {
		db.run("ALTER TABLE monitors ADD COLUMN procedure_files TEXT");
	}
	if (!columns.some((column) => column.name === "last_check_error")) {
		db.run("ALTER TABLE monitors ADD COLUMN last_check_error TEXT");
	}
	if (!columns.some((column) => column.name === "last_check_error_at")) {
		db.run("ALTER TABLE monitors ADD COLUMN last_check_error_at INTEGER");
	}
	if (!columns.some((column) => column.name === "check_error_streak")) {
		db.run("ALTER TABLE monitors ADD COLUMN check_error_streak INTEGER NOT NULL DEFAULT 0");
	}
}

export interface MonitorSql {
	id: string;
	name: string;
	trigger_json: string;
	instruction: string;
	overlap: MonitorOverlap;
	enabled: number;
	channel: string | null;
	copy_channel: string | null;
	model: string | null;
	thinking: MonitorThinking | null;
	deliver: MonitorDeliver;
	procedure_files: string | null;
	cursor_at: number;
	created_at: number;
	last_script_state: ScriptState | null;
	last_output_hash: string | null;
	last_check_error: string | null;
	last_check_error_at: number | null;
	check_error_streak: number;
	updated_at: number;
}

interface EventSql {
	event_id: number;
	monitor_id: string;
	slot_at: number;
	stage: EventStage;
	payload: string | null;
	attempts: number;
	next_attempt_at: number | null;
	inbound_id: string | null;
	answer: string | null;
	error: string | null;
	delivery_id: number | null;
	skipped_by: number | null;
	manual: number;
	created_at: number;
	updated_at: number;
}

export const toMonitor = (r: MonitorSql): MonitorRow => ({
	id: r.id,
	name: r.name,
	trigger: JSON.parse(r.trigger_json) as MonitorTrigger,
	instruction: r.instruction,
	overlap: r.overlap,
	enabled: r.enabled === 1,
	channel: r.channel,
	copyChannel: r.copy_channel,
	model: r.model,
	thinking: r.thinking,
	deliver: r.deliver,
	procedureFiles: r.procedure_files ? (JSON.parse(r.procedure_files) as string[]) : [],
	cursorAt: r.cursor_at,
	lastScriptState: r.last_script_state,
	lastOutputHash: r.last_output_hash,
	lastCheckError: r.last_check_error,
	lastCheckErrorAt: r.last_check_error_at,
	checkErrorStreak: r.check_error_streak,
	createdAt: r.created_at,
	updatedAt: r.updated_at,
});

const toEvent = (r: EventSql): MonitorEventRow => ({
	eventId: r.event_id,
	monitorId: r.monitor_id,
	slotAt: r.slot_at,
	stage: r.stage,
	payload: r.payload,
	attempts: r.attempts,
	nextAttemptAt: r.next_attempt_at,
	inboundId: r.inbound_id,
	answer: r.answer,
	error: r.error,
	deliveryId: r.delivery_id,
	skippedBy: r.skipped_by,
	manual: r.manual === 1,
	createdAt: r.created_at,
	updatedAt: r.updated_at,
});

/** Events that still owe an authoring turn: a new fire behind them is queued (or skipped, per `overlap`). */
const OWING = "('admitted','dispatched','failed')";

/** The next time `row` can fire, or `null` (disabled, finished one-shot, no match, past the `Date` range). */
export function nextFireOf(row: MonitorRow): number | null {
	if (!row.enabled) return null;
	const { trigger } = row;
	if (trigger.kind === "cron") return nextFire(parseCron(trigger.schedule), trigger.timezone, row.cursorAt) ?? null;
	// A stored `at` is always a UTC ISO string (`…Z`), so the fallback zone is never consulted.
	if (trigger.kind === "at") return parseAt(trigger.at, "UTC");
	if (trigger.kind === "watcher" || trigger.kind === "webhook") return null;
	const next = row.cursorAt + trigger.intervalMs;
	// A row stored before `intervalMs` had an upper bound may point past what a `Date` can hold.
	return Number.isFinite(new Date(next).getTime()) ? next : null;
}

/**
 * The `[...]` trigger text of a monitor row, shared by the CLI `monitors list` and the `ompbot_monitor_list` tool —
 * the single place a trigger kind is described. `formatAt` renders an `at` trigger's stored ISO instant (the CLI
 * keeps it raw; the tool shows the bot zone's wall clock) and a script monitor with fire=edge shows its last check state.
 */
export function describeMonitorTrigger(row: MonitorRow, formatAt: (at: string) => string): string {
	const { trigger } = row;
	if (trigger.kind === "cron") {
		const command =
			trigger.command === undefined
				? ""
				: ` command=${trigger.command.join(" ")}${trigger.timeoutMs === undefined ? "" : ` timeout=${trigger.timeoutMs / 1000}s`}`;
		return `cron "${trigger.schedule}" ${trigger.timezone}${command}`;
	}
	if (trigger.kind === "at") return `at ${formatAt(trigger.at)}`;
	if (trigger.kind === "watcher") return `watcher ${trigger.root} debounce=${trigger.debounceMs}ms`;
	if (trigger.kind === "webhook") return `webhook /hook/${trigger.id}`;
	const { fire = "edge", once = false } = trigger;
	return `script ${trigger.command.join(" ")} every ${trigger.intervalMs / 1000}s fire=${fire}${once ? " once" : ""}${fire === "every" ? "" : ` state=${row.lastScriptState ?? "-"}`}`;
}

/** The `channel=` / `copyChannel=` / `model=` / `thinking=` tail of a monitor row, each part prefixed by `sep`. */
export function monitorOptionSuffixes(
	row: Pick<MonitorRow, "channel" | "copyChannel" | "model" | "thinking" | "procedureFiles">,
	sep: string,
): string {
	return (
		(row.channel === null ? "" : `${sep}channel=${row.channel}`) +
		(row.copyChannel === null ? "" : `${sep}copyChannel=${row.copyChannel}`) +
		(row.model === null ? "" : `${sep}model=${row.model}`) +
		(row.thinking === null ? "" : `${sep}thinking=${row.thinking}`) +
		(row.procedureFiles.length === 0 ? "" : `${sep}procedureFiles=${row.procedureFiles.length}`)
	);
}

const procedureJson = (spec: MonitorSpec): string | null =>
	spec.procedureFiles === undefined || spec.procedureFiles.length === 0 ? null : JSON.stringify(spec.procedureFiles);

export interface SettleFailure {
	event: MonitorEventRow;
	monitorName: string;
	/** The retry budget is spent: the owner gets one notice. */
	terminal: boolean;
}

/** Check errors in a row that tell the owner (once per streak; a good check ends the streak). */
export const CHECK_ERROR_ALERT_STREAK = 3;

/** A script check or watch that kept failing (`CHECK_ERROR_ALERT_STREAK` in a row). */
export interface CheckErrorAlert {
	monitorId: string;
	monitorName: string;
	/** The latest error, redacted. */
	error: string;
	streak: number;
	/** How often this incident alerted (>1: it came back after its repeat window). */
	count: number;
}

export interface SettleAnswer {
	event: MonitorEventRow;
	monitorName: string;
	/** True when the answer is a report that must be delivered. */
	report: boolean;
}

/**
 * Durable state of monitors: definitions, claimed slots and the event pipeline. It works on any database handle, so
 * the CLI can use it on its own connection without opening the full bot `Store`.
 */
export class MonitorLedger {
	readonly #db: Database;
	readonly #clock: MonitorClock;
	readonly #redact: (text: string) => string;
	readonly #listeners = new Set<(event: MonitorEventRow) => void>();
	readonly #cronCache = new Map<string, CronSchedule>();
	readonly #onCheckErrorAlert: ((alert: CheckErrorAlert) => void) | undefined;

	constructor(
		db: Database,
		options: {
			clock: MonitorClock;
			redact?: (text: string) => string;
			/** Called inside the recording transaction when a check error streak should reach the owner. */
			onCheckErrorAlert?: (alert: CheckErrorAlert) => void;
		},
	) {
		this.#db = db;
		this.#clock = options.clock;
		this.#redact = options.redact ?? ((text) => text);
		this.#onCheckErrorAlert = options.onCheckErrorAlert;
		migrateMonitorSchema(db);
	}

	/** Observes every event row after it changed (tests await stages through this; never throws into the ledger). */
	subscribe(listener: (event: MonitorEventRow) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	cron(schedule: string): CronSchedule {
		let parsed = this.#cronCache.get(schedule);
		if (!parsed) {
			parsed = parseCron(schedule);
			this.#cronCache.set(schedule, parsed);
		}
		return parsed;
	}

	#emit(eventId: number): void {
		const event = this.getEvent(eventId);
		if (!event) return;
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch {
				// observers only
			}
		}
	}

	// ---- monitors ----

	addMonitor(spec: MonitorSpec): MonitorRow {
		const now = this.#clock.now();
		const id = `m${randomBytes(4).toString("hex")}`;
		this.#db
			.query(
				"INSERT INTO monitors (id, name, trigger_json, instruction, overlap, enabled, channel, copy_channel, model, thinking, deliver, procedure_files, cursor_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				id,
				spec.name,
				JSON.stringify(spec.trigger),
				spec.instruction,
				spec.overlap,
				spec.enabled ? 1 : 0,
				spec.channel ?? null,
				spec.copyChannel ?? null,
				spec.model ?? null,
				spec.thinking ?? null,
				spec.deliver ?? "turn",
				procedureJson(spec),
				now,
				now,
				now,
			);
		return this.requireMonitor(id);
	}

	/** By id or exact name. */
	getMonitor(idOrName: string): MonitorRow | undefined {
		const row = this.#db
			.query("SELECT * FROM monitors WHERE id = ?1 OR name = ?1 ORDER BY id = ?1 DESC LIMIT 1")
			.get(idOrName) as MonitorSql | null;
		return row ? toMonitor(row) : undefined;
	}

	listMonitors(): MonitorRow[] {
		return (this.#db.query("SELECT * FROM monitors ORDER BY created_at, id").all() as MonitorSql[]).map(toMonitor);
	}

	/**
	 * Replaces the stored spec. The cursor moves to now when the trigger changed or the monitor was just re-enabled,
	 * so a schedule edit or a pause never replays the time in between.
	 */
	updateMonitor(id: string, spec: MonitorSpec): MonitorRow {
		const current = this.requireMonitor(id);
		const now = this.#clock.now();
		const triggerJson = JSON.stringify(spec.trigger);
		const triggerChanged = triggerJson !== JSON.stringify(current.trigger);
		const resetCursor = triggerChanged || (spec.enabled && !current.enabled);
		this.#db
			.query(
				"UPDATE monitors SET name = ?, trigger_json = ?, instruction = ?, overlap = ?, enabled = ?, channel = ?, copy_channel = ?, model = ?, thinking = ?, deliver = ?, procedure_files = ?, cursor_at = ?, last_script_state = ?, last_output_hash = ?, updated_at = ? WHERE id = ?",
			)
			.run(
				spec.name,
				triggerJson,
				spec.instruction,
				spec.overlap,
				spec.enabled ? 1 : 0,
				spec.channel ?? null,
				spec.copyChannel ?? null,
				spec.model ?? null,
				spec.thinking ?? null,
				spec.deliver ?? "turn",
				procedureJson(spec),
				resetCursor ? now : current.cursorAt,
				resetCursor ? null : current.lastScriptState,
				resetCursor ? null : current.lastOutputHash,
				now,
				id,
			);
		// A disabled monitor's open incidents and check error streak are over: re-enabled, the same failure alerts again.
		if (!spec.enabled) {
			this.#closeIncidents(id);
			// Fires already queued for an owner-disabled monitor must not run later (one-shot disables go through setEnabled).
			const queued = this.#db
				.query("SELECT event_id FROM monitor_events WHERE monitor_id = ? AND stage IN ('admitted','failed')")
				.all(id) as Array<{ event_id: number }>;
			for (const { event_id } of queued) this.skipEvent(event_id, "disabled");
		}
		return this.requireMonitor(id);
	}

	/** Deletes the monitor with its slots, events and incidents. */
	removeMonitor(id: string): boolean {
		return this.#db.transaction((): boolean => {
			// `changes` also counts cascaded slot/event rows, so the deleted monitor row itself is what is counted.
			const removed = this.#db.query("DELETE FROM monitors WHERE id = ? RETURNING id").all(id).length === 1;
			// monitor_incidents has no FK (the table predates cascades), so it is cleaned here.
			if (removed) this.#db.query("DELETE FROM monitor_incidents WHERE monitor_id = ?").run(id);
			return removed;
		})();
	}

	setCursor(id: string, at: number): void {
		this.#db.query("UPDATE monitors SET cursor_at = ? WHERE id = ?").run(at, id);
	}

	setEnabled(id: string, enabled: boolean): void {
		this.#db
			.query("UPDATE monitors SET enabled = ?, updated_at = ? WHERE id = ?")
			.run(enabled ? 1 : 0, this.#clock.now(), id);
		// Like `updateMonitor`: disabling closes the monitor's open incidents.
		if (!enabled) this.#closeIncidents(id);
	}

	#closeIncidents(id: string): void {
		this.#db
			.query(
				"UPDATE monitors SET last_check_error = NULL, last_check_error_at = NULL, check_error_streak = 0 WHERE id = ?",
			)
			.run(id);
		resolveIncidents(this.#db, "monitor_incidents", id);
	}

	private requireMonitor(id: string): MonitorRow {
		const row = this.getMonitor(id);
		if (!row) throw new Error(`monitor not found: ${id}`);
		return row;
	}

	// ---- slots ----

	/**
	 * Claims `(monitorId, slotAt)` exactly once. The slot row, its event and the overlap decision are one
	 * transaction; the UNIQUE slot key makes a second claim (a rewound cursor, a second process) a `duplicate`.
	 */
	claimSlot(input: {
		monitorId: string;
		slotAt: number;
		payload?: string | undefined;
		manual?: boolean;
		/** Records the event as skipped with this reason prefix — a fired check that must not wake the agent. */
		forceSkipReason?: string | undefined;
	}): ClaimResult {
		const eventId = this.#db.transaction((): ClaimResult | number => {
			const monitor = this.getMonitor(input.monitorId);
			if (!monitor) return { status: "missing" };
			const now = this.#clock.now();
			const inserted = this.#db
				.query(
					"INSERT INTO monitor_slots (monitor_id, slot_at, state, created_at) VALUES (?, ?, 'claimed', ?) ON CONFLICT DO NOTHING",
				)
				.run(monitor.id, input.slotAt, now);
			if (inserted.changes === 0) return { status: "duplicate" };
			const predecessor = this.#db
				.query(
					`SELECT event_id FROM monitor_events WHERE monitor_id = ? AND stage IN ${OWING} ORDER BY event_id LIMIT 1`,
				)
				.get(monitor.id) as { event_id: number } | null;
			const skip =
				input.forceSkipReason !== undefined ||
				(monitor.overlap === "skip" && predecessor !== null && input.manual !== true);
			const rawPayload =
				input.forceSkipReason === undefined ? input.payload : `${input.forceSkipReason}\n${input.payload ?? ""}`;
			const payload = rawPayload === undefined ? null : this.#redact(rawPayload);
			const result = this.#db
				.query(
					"INSERT INTO monitor_events (monitor_id, slot_at, stage, payload, skipped_by, manual, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					monitor.id,
					input.slotAt,
					skip ? "skipped" : "admitted",
					payload,
					skip ? (predecessor?.event_id ?? null) : null,
					input.manual === true ? 1 : 0,
					now,
					now,
				);
			return Number(result.lastInsertRowid);
		})();
		if (typeof eventId !== "number") return eventId;
		const event = this.requireEvent(eventId);
		this.#emit(eventId);
		return { status: event.stage === "skipped" ? "skipped_overlap" : "admitted", event };
	}

	/**
	 * Applies one finished script check. The state change, the fire (a claimed slot with its event) and the `once`
	 * disable are one transaction, so a crash can neither refire a met condition nor lose the fire. `error` (timeout,
	 * spawn or path failure) says nothing about the condition and leaves the state alone; it only counts in the check
	 * error streak (`recordCheckError`), which a definitive check ends. Returns the claim when it fired.
	 */
	recordScriptCheck(input: {
		monitorId: string;
		outcome: ScriptState | "error";
		/** Why an `error` check could not decide (spawn failure, timeout, killed). */
		error?: string | undefined;
		slotAt: number;
		payload?: string | undefined;
		/** sha256 of the met check's stdout; persisted and compared for `suppressUnchanged`. */
		hash?: string | undefined;
		/** A fired check that must not wake the agent (`wake_gate` from the script itself, or `no_change`). */
		suppressReason?: string | undefined;
	}): ClaimResult | undefined {
		if (input.outcome === "error") {
			this.recordCheckError(input.monitorId, input.error ?? "script check failed");
			return undefined;
		}
		return this.#db.transaction((): ClaimResult | undefined => {
			const monitor = this.getMonitor(input.monitorId);
			if (monitor?.trigger.kind !== "script" || !monitor.enabled) return undefined;
			this.clearCheckError(monitor.id);
			const { fire = "edge", once = false } = monitor.trigger;
			const suppressUnchanged = monitor.trigger.kind === "script" && monitor.trigger.suppressUnchanged === true;
			let suppressReason = input.suppressReason;
			if (
				suppressReason === undefined &&
				suppressUnchanged &&
				input.outcome === "met" &&
				input.hash !== undefined &&
				monitor.lastOutputHash === input.hash
			) {
				suppressReason = `no_change:${input.hash.slice(0, 8)}`;
			}
			// The hash persists in the same transaction as the state (hermes: state before the agent), so an agent
			// failure never turns one change into endless repeat alerts, and a failed source never refreshes it.
			this.#db
				.query("UPDATE monitors SET last_script_state = ?, last_output_hash = ? WHERE id = ?")
				.run(
					input.outcome,
					input.outcome === "met"
						? (input.hash ?? monitor.lastOutputHash)
						: input.outcome === "unmet"
							? null
							: monitor.lastOutputHash,
					monitor.id,
				);
			if (input.outcome !== "met" || (fire === "edge" && monitor.lastScriptState === "met")) return undefined;
			const claim = this.claimSlot({
				monitorId: monitor.id,
				slotAt: input.slotAt,
				payload: input.payload,
				...(suppressReason === undefined ? {} : { forceSkipReason: suppressReason }),
			});
			if (once && (claim.status === "admitted" || claim.status === "skipped_overlap"))
				this.setEnabled(monitor.id, false);
			return claim;
		})();
	}

	// ---- incidents (failure repeat suppression, hermes monitor mode) ----

	/**
	 * Counts one terminal monitor failure and decides whether the owner should be told (the shared incident state
	 * machine — see `monitors/incidents`): the first occurrence alerts, the same (monitor, normalized error) within
	 * `repeatMs` stays quiet, a re-alert refreshes the window, and a resolved incident that comes back reopens loudly.
	 */
	recordMonitorIncident(
		monitorId: string,
		error: string,
		now: number,
		repeatMs = MONITOR_INCIDENT_REPEAT_MS,
	): { notify: boolean; count: number } {
		const { notify, count } = countIncident(this.#db, "monitor_incidents", monitorId, error, now, repeatMs);
		return { notify, count };
	}

	/**
	 * One script check or watch that failed: the error and its time are kept and the streak grows. The moment the streak
	 * reaches `CHECK_ERROR_ALERT_STREAK` it counts as a monitor incident, and an incident that alerts goes to the owner
	 * through `onCheckErrorAlert` in the same transaction; later errors of the same streak stay quiet. Returns the streak.
	 */
	recordCheckError(monitorId: string, error: string): number {
		return this.#db.transaction((): number => {
			const now = this.#clock.now();
			const text = this.#redact(error);
			const row = this.#db
				.query(
					"UPDATE monitors SET last_check_error = ?, last_check_error_at = ?, check_error_streak = check_error_streak + 1 WHERE id = ? RETURNING name, check_error_streak",
				)
				.get(text, now, monitorId) as { name: string; check_error_streak: number } | null;
			if (row === null) return 0;
			if (row.check_error_streak === CHECK_ERROR_ALERT_STREAK) {
				const incident = this.recordMonitorIncident(monitorId, `check_error: ${text}`, now);
				if (incident.notify) {
					this.#onCheckErrorAlert?.({
						monitorId,
						monitorName: row.name,
						error: text,
						streak: row.check_error_streak,
						count: incident.count,
					});
				}
			}
			return row.check_error_streak;
		})();
	}

	/** A good check or a started watch: an error streak ends (columns cleared) and the monitor's open incidents resolve. */
	clearCheckError(monitorId: string): void {
		const cleared = this.#db
			.query(
				"UPDATE monitors SET last_check_error = NULL, last_check_error_at = NULL, check_error_streak = 0 WHERE id = ? AND check_error_streak > 0",
			)
			.run(monitorId).changes;
		if (cleared > 0) this.resolveMonitorIncidents(monitorId);
	}

	/** A successful run (delivered or deliberately silent) resolves the monitor's open incidents. */
	resolveMonitorIncidents(monitorId: string): void {
		resolveIncidents(this.#db, "monitor_incidents", monitorId);
	}

	/** Records a slot that is deliberately not run (catch-up bounds). Returns false when it was already claimed. */
	recordSkippedSlot(monitorId: string, slotAt: number, reason: string): boolean {
		return (
			this.#db
				.query(
					"INSERT INTO monitor_slots (monitor_id, slot_at, state, reason, created_at) VALUES (?, ?, 'skipped', ?, ?) ON CONFLICT DO NOTHING",
				)
				.run(monitorId, slotAt, reason, this.#clock.now()).changes === 1
		);
	}

	/** Manual fire (`monitors test`): never skipped by overlap and never collides with a real slot. */
	admitManual(monitorId: string, payload?: string): MonitorEventRow {
		for (let slotAt = this.#clock.now(); ; slotAt += 1) {
			const claim = this.claimSlot({ monitorId, slotAt, payload, manual: true });
			if ("event" in claim) return claim.event;
			if (claim.status === "missing") throw new Error(`monitor not found: ${monitorId}`);
		}
	}

	listSlots(monitorId: string): Array<{ slotAt: number; state: "claimed" | "skipped"; reason: string | null }> {
		return (
			this.#db
				.query("SELECT slot_at, state, reason FROM monitor_slots WHERE monitor_id = ? ORDER BY slot_at")
				.all(monitorId) as Array<{ slot_at: number; state: "claimed" | "skipped"; reason: string | null }>
		).map((r) => ({ slotAt: r.slot_at, state: r.state, reason: r.reason }));
	}

	// ---- events ----

	getEvent(eventId: number): MonitorEventRow | undefined {
		const row = this.#db.query("SELECT * FROM monitor_events WHERE event_id = ?").get(eventId) as EventSql | null;
		return row ? toEvent(row) : undefined;
	}

	private requireEvent(eventId: number): MonitorEventRow {
		const event = this.getEvent(eventId);
		if (!event) throw new Error(`event not found: ${eventId}`);
		return event;
	}

	listEvents(filter: { monitorId?: string; stage?: EventStage } = {}): MonitorEventRow[] {
		return (
			this.#db
				.query(
					"SELECT * FROM monitor_events WHERE (?1 IS NULL OR monitor_id = ?1) AND (?2 IS NULL OR stage = ?2) ORDER BY event_id",
				)
				.all(filter.monitorId ?? null, filter.stage ?? null) as EventSql[]
		).map(toEvent);
	}

	eventCounts(monitorId: string): Partial<Record<EventStage, number>> {
		const out: Partial<Record<EventStage, number>> = {};
		for (const row of this.#db
			.query("SELECT stage, COUNT(*) AS n FROM monitor_events WHERE monitor_id = ? GROUP BY stage")
			.all(monitorId) as Array<{ stage: EventStage; n: number }>) {
			out[row.stage] = row.n;
		}
		return out;
	}

	/**
	 * The event each monitor should dispatch now: the oldest one that still owes a turn, if it is admitted or a failed
	 * one whose backoff has passed. A running or backing-off head holds back everything behind it (queue order).
	 */
	dispatchable(now: number): MonitorEventRow[] {
		const heads = this.#db
			.query(
				`SELECT * FROM monitor_events e WHERE stage IN ${OWING} AND event_id = (SELECT MIN(event_id) FROM monitor_events WHERE monitor_id = e.monitor_id AND stage IN ${OWING}) ORDER BY event_id`,
			)
			.all() as EventSql[];
		return heads
			.map(toEvent)
			.filter((e) => e.stage === "admitted" || (e.stage === "failed" && (e.nextAttemptAt ?? 0) <= now));
	}

	/** admitted|failed -> skipped with a reason in `error` (a fire the freeze switch held back); false when it moved on. */
	skipEvent(eventId: number, reason: string): boolean {
		const changed = this.#db
			.query(
				"UPDATE monitor_events SET stage = 'skipped', next_attempt_at = NULL, error = ?, updated_at = ? WHERE event_id = ? AND stage IN ('admitted','failed')",
			)
			.run(reason, this.#clock.now(), eventId).changes;
		if (changed === 1) this.#emit(eventId);
		return changed === 1;
	}

	/** admitted|failed -> dispatched, remembering the inbound message id of this attempt. */
	markDispatched(eventId: number, inboundId: string): boolean {
		const changed = this.#db
			.query(
				"UPDATE monitor_events SET stage = 'dispatched', inbound_id = ?, next_attempt_at = NULL, updated_at = ? WHERE event_id = ? AND stage IN ('admitted','failed')",
			)
			.run(inboundId, this.#clock.now(), eventId).changes;
		if (changed === 1) this.#emit(eventId);
		return changed === 1;
	}

	/**
	 * dispatched -> authored, and straight on to `no_report` when the first or last line of the answer is `NO_REPORT` or `[SILENT]`. Returns
	 * `undefined` when the event is gone or no longer waiting for an answer.
	 */
	settleAnswered(eventId: number, answer: string): SettleAnswer | undefined {
		const settled = this.#db.transaction((): SettleAnswer | undefined => {
			const event = this.getEvent(eventId);
			if (event?.stage !== "dispatched") return undefined;
			const report = !isSilentAnswer(answer);
			this.#db
				.query("UPDATE monitor_events SET stage = ?, answer = ?, error = NULL, updated_at = ? WHERE event_id = ?")
				.run(report ? "authored" : "no_report", this.#redact(answer), this.#clock.now(), eventId);
			const monitor = this.getMonitor(event.monitorId);
			return { event: this.requireEvent(eventId), monitorName: monitor?.name ?? event.monitorId, report };
		})();
		if (settled) this.#emit(eventId);
		return settled;
	}

	/**
	 * admitted|failed -> authored, the stored payload being the answer, for a `verbatim` monitor (no turn, no marker
	 * parsing); an empty payload goes to `no_report`. `opRef` is kept as this attempt's id. With `output` (a cron
	 * command's stdout) the event must instead be `dispatched` under `opRef`, and `output` becomes its payload and answer.
	 * Returns `undefined` when the event is gone or not waiting to run.
	 */
	settleVerbatim(eventId: number, opRef: string, output?: string): SettleAnswer | undefined {
		const settled = this.#db.transaction((): SettleAnswer | undefined => {
			const event = this.getEvent(eventId);
			if (!event) return undefined;
			if (
				output === undefined
					? event.stage !== "admitted" && event.stage !== "failed"
					: event.stage !== "dispatched" || event.inboundId !== opRef
			)
				return undefined;
			const payload = output === undefined ? (event.payload ?? "") : this.#redact(output);
			const report = payload.trim() !== "";
			this.#db
				.query(
					"UPDATE monitor_events SET stage = ?, inbound_id = ?, next_attempt_at = NULL, payload = ?, answer = ?, error = NULL, updated_at = ? WHERE event_id = ?",
				)
				.run(report ? "authored" : "no_report", opRef, payload, payload, this.#clock.now(), eventId);
			const monitor = this.getMonitor(event.monitorId);
			return { event: this.requireEvent(eventId), monitorName: monitor?.name ?? event.monitorId, report };
		})();
		if (settled) this.#emit(eventId);
		return settled;
	}

	/**
	 * dispatched -> failed (retry after the backoff) or failed_no_retry once the retries are spent; `retry: false` (a
	 * cron command) ends it as failed_no_retry on the first failure.
	 */
	settleFailed(eventId: number, error: string, options: { retry?: boolean } = {}): SettleFailure | undefined {
		const settled = this.#db.transaction((): SettleFailure | undefined => {
			const event = this.getEvent(eventId);
			if (event?.stage !== "dispatched") return undefined;
			const now = this.#clock.now();
			const attempts = event.attempts + 1;
			const backoff = options.retry === false ? undefined : RETRY_BACKOFF_MS[attempts - 1];
			this.#db
				.query(
					"UPDATE monitor_events SET stage = ?, attempts = ?, next_attempt_at = ?, error = ?, updated_at = ? WHERE event_id = ?",
				)
				.run(
					backoff === undefined ? "failed_no_retry" : "failed",
					attempts,
					backoff === undefined ? null : now + backoff,
					this.#redact(error),
					now,
					eventId,
				);
			const monitor = this.getMonitor(event.monitorId);
			return {
				event: this.requireEvent(eventId),
				monitorName: monitor?.name ?? event.monitorId,
				terminal: backoff === undefined,
			};
		})();
		if (settled) this.#emit(eventId);
		return settled;
	}

	attachDelivery(eventId: number, deliveryId: number): void {
		this.#db.query("UPDATE monitor_events SET delivery_id = ? WHERE event_id = ?").run(deliveryId, eventId);
	}

	/** authored -> delivered once the ledger delivery was confirmed; an expired delivery ends the event as failed. */
	reconcileDeliveries(): number {
		const rows = this.#db
			.query(
				"SELECT e.event_id AS event_id, d.state AS state FROM monitor_events e JOIN deliveries d ON d.delivery_id = e.delivery_id WHERE e.stage = 'authored' AND d.state IN ('confirmed','failed_ambiguous','expired')",
			)
			.all() as Array<{ event_id: number; state: string }>;
		for (const row of rows) {
			const [stage, error] =
				row.state === "confirmed"
					? ["delivered", null]
					: row.state === "failed_ambiguous"
						? ["delivered", "delivery_ambiguous"]
						: ["failed_no_retry", "delivery_expired"];
			this.#db
				.query(
					"UPDATE monitor_events SET stage = ?, error = ?, updated_at = ? WHERE event_id = ? AND stage = 'authored'",
				)
				.run(stage, error, this.#clock.now(), row.event_id);
			this.#emit(row.event_id);
		}
		return rows.length;
	}

	/**
	 * Startup: an event marked dispatched whose inbound message was never recorded (the process died in between) goes
	 * back to admitted. Events whose inbound row exists are settled by the daemon's own inbound recovery.
	 */
	reconcileDispatched(): number {
		const rows = this.#db
			.query(
				"SELECT event_id FROM monitor_events WHERE stage = 'dispatched' AND (inbound_id IS NULL OR inbound_id NOT IN (SELECT platform_message_id FROM inbound))",
			)
			.all() as Array<{ event_id: number }>;
		for (const row of rows) {
			this.#db
				.query("UPDATE monitor_events SET stage = 'admitted', inbound_id = NULL, updated_at = ? WHERE event_id = ?")
				.run(this.#clock.now(), row.event_id);
			this.#emit(row.event_id);
		}
		return rows.length;
	}

	close(): void {
		this.#db.close();
	}
}

/** Standalone connection for the CLI. Unlike `Store` it never touches deliveries or inbound rows. */
export function openMonitorLedger(path: string, clock: MonitorClock = { now: () => Date.now() }): MonitorLedger {
	const db = new Database(path, { create: true, strict: true });
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA foreign_keys = ON");
	db.run("PRAGMA busy_timeout = 5000");
	return new MonitorLedger(db, { clock });
}
