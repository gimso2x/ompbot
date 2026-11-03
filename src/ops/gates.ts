import { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SWEEP_MS, readSweepHeartbeat } from "../daemon/heartbeat";
import { nextFireOf, toMonitor } from "../monitors/ledger";
import { checkOmpRuntime } from "../omp/runtime-check";
import { readStamp } from "./backup";
import { readFreeze } from "./freeze";
import { OFFSITE_STAMP_FILE } from "./offsite";

/** A stale backup is the first thing to catch; the hub uses the same 36h window for its file-age check. */
export const BACKUP_MAX_AGE_MS = 36 * 60 * 60_000;
/** A stamp dated further ahead than this is a clock jump or corruption, not a fresh backup. */
export const BACKUP_FUTURE_TOLERANCE_MS = 60 * 60_000;
/**
 * The sweep heartbeat may age at most three sweeps before the sweep chain counts as dead: the loop is blocked or
 * the timer is gone, and with it every origin's stall marking (they all run on that one loop).
 */
export const SWEEP_STALLED_MS = 3 * DEFAULT_SWEEP_MS;
/**
 * A dispatched turn with no omp event for this long is hung (upstream cycle: INBOUND_STARVATION_MS). Measured from
 * `last_event_at`, falling back to `dispatched_at`, so a long turn that keeps working does not open the gate. A turn
 * whose origin waits on a pending approval card is waiting on the owner, not hung (the card has its own timeout).
 */
export const INBOUND_STARVATION_MS = 10 * 60_000;
/**
 * An owner message still `pending` (never handed to omp) this long means the conversation went silent on it
 * (gajae-way `origin_silent`). Rows queued behind a turn that is still producing omp events are normal queueing
 * and stay out; a hung turn ahead of them does not exempt them.
 */
export const ORIGIN_SILENT_MS = 15 * 60_000;
/** Deliveries whose next attempt is this far overdue mean the delivery pump is stuck. */
export const DELIVERY_OVERDUE_MS = 10 * 60_000;
/** A lane that has not progressed for a day needs attention. */
export const LANE_STUCK_MS = 24 * 60 * 60_000;
/** Only fresh monitor failures gate; an old `failed_no_retry` already notified once and must not alarm forever. */
export const MONITOR_FAILURE_WINDOW_MS = 24 * 60 * 60_000;
/**
 * Chat turns failing repeatedly: `[turn failed]` notice deliveries are the only ledger trace of a broken bot (the
 * 2026-10-24 stale-model outage showed up as four of them and nothing else). The window and threshold mirror the
 * mailbox escalation, so what the owner was DM'd about also fails `ompbot gates`.
 */
export const TURNS_FAILING_WINDOW_MS = 60 * 60_000;
export const TURNS_FAILING_THRESHOLD = 3;

/** The Slack socket stays down this long before `slack_disconnected` opens (shorter blips reconnect by themselves). */
export const SOCKET_DOWN_MS = 10 * 60_000;
/** An enabled monitor whose next fire is this far in the past means the monitor tick is not firing it. */
export const MONITOR_OVERDUE_MS = 15 * 60_000;

export type GateState = "open" | "closed";

export interface Gate {
	name: string;
	state: GateState;
	detail: string;
}

export interface GatesOptions {
	homeDir: string;
	now: number;
	/** Configured omp executable; when set, the `omp_runtime` gate checks it can still host an RPC child. */
	ompExecutable?: string;
	/** True when config.json has an `offsite` target; only then does the `offsite_age` gate exist. */
	offsiteConfigured?: boolean;
}

function gate(name: string, open: boolean, detail: string): Gate {
	return { name, state: open ? "open" : "closed", detail };
}

function tableExists(db: Database, name: string): boolean {
	return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null;
}

/** The ledger is opened read-only, so a database the daemon has not migrated yet may lack newer columns. */
function columnExists(db: Database, table: string, column: string): boolean {
	return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
}

function scalar(db: Database, sql: string): number {
	const row = db.query(sql).get() as Record<string, number> | null;
	return row == null ? 0 : Number(Object.values(row)[0] ?? 0);
}

/**
 * Enabled monitors whose next fire is 15+ minutes past. Closed while draining (drain stops monitor ticks) and for a
 * heartbeat without the `draining` field (a daemon older than this gate: ops-check runs the new CLI against it).
 */
function monitorsStalled(db: Database, heartbeat: ReturnType<typeof readSweepHeartbeat>, now: number): Gate {
	const name = "monitors_stalled";
	if (heartbeat?.draining === undefined) return gate(name, false, "heartbeat=old");
	if (heartbeat.draining) return gate(name, false, "draining");
	if (
		!tableExists(db, "monitors") ||
		!["trigger_json", "cursor_at", "enabled"].every((c) => columnExists(db, "monitors", c))
	) {
		return gate(name, false, "schema=old");
	}
	let overdue = 0;
	for (const raw of db.query("SELECT * FROM monitors WHERE enabled = 1").all()) {
		let next: number | null;
		try {
			next = nextFireOf(toMonitor(raw as Parameters<typeof toMonitor>[0]));
		} catch {
			continue;
		}
		if (next !== null && next <= now - MONITOR_OVERDUE_MS) overdue++;
	}
	return gate(name, overdue > 0, `overdue=${overdue}`);
}

/**
 * Opens as soon as an omp upgrade leaves an install the RPC driver will refuse (standalone launcher, too-old bun),
 * so the owner hears about it before chat turns start failing. Uses the bun on this process's PATH, as the driver does.
 */
function ompRuntimeGate(ompExecutable: string): Gate {
	const name = "omp_runtime";
	const bun = Bun.which("bun");
	if (!bun) return gate(name, true, "bun=missing");
	let cliPath: string;
	try {
		cliPath = realpathSync(ompExecutable);
	} catch {
		return gate(name, true, `omp=missing path=${ompExecutable}`);
	}
	const problem = checkOmpRuntime(cliPath, bun);
	return gate(name, problem !== undefined, problem === undefined ? "ok" : `${problem.code} ${problem.detail}`);
}

/**
 * Read-only health projection over `<homeDir>`: opens the ledger read-only (never re-queues inflight deliveries,
 * unlike `openStore`) plus the backup stamp, and answers "does anything need a human?". Follows the upstream
 * `ops cycle` contract: any open gate means exit 1, so automation cannot mistake a sick bot for a healthy one.
 *
 * `failed_ambiguous` deliveries are intentionally NOT a gate: the state is sticky by design, already surfaced in
 * `ompbot status`, and has no CLI resolution path yet - gating on it would alert forever.
 */
export function collectGates(options: GatesOptions): Gate[] {
	const { homeDir, now } = options;
	const gates: Gate[] = [];

	const stamp = readStamp(join(homeDir, "backups"));
	if (stamp === undefined) {
		gates.push(gate("backup_age", true, "stamp=missing"));
	} else {
		const age = now - stamp.ts.getTime();
		if (age < -BACKUP_FUTURE_TOLERANCE_MS) {
			gates.push(gate("backup_age", true, "ts_in_future"));
		} else {
			gates.push(gate("backup_age", age > BACKUP_MAX_AGE_MS, `hours=${(age / 3_600_000).toFixed(1)}`));
		}
	}

	if (options.offsiteConfigured === true) {
		const offsite = readStamp(join(homeDir, "backups"), OFFSITE_STAMP_FILE);
		if (offsite === undefined) {
			gates.push(gate("offsite_age", true, "stamp=missing"));
		} else {
			const age = now - offsite.ts.getTime();
			if (age < -BACKUP_FUTURE_TOLERANCE_MS) gates.push(gate("offsite_age", true, "ts_in_future"));
			else gates.push(gate("offsite_age", age > BACKUP_MAX_AGE_MS, `hours=${(age / 3_600_000).toFixed(1)}`));
		}
	}

	// Filesystem-based like backup_age, so it reports even when the ledger is unreadable. No stamp at all means no
	// daemon has ever swept here (fresh install) — the same "cannot judge" stance as db=missing, not health.
	const heartbeat = readSweepHeartbeat(homeDir);
	if (heartbeat === undefined) {
		gates.push(gate("sweep_stalled", false, "stamp=missing"));
	} else {
		const beatAge = now - heartbeat.ts.getTime();
		if (beatAge < -BACKUP_FUTURE_TOLERANCE_MS) {
			gates.push(gate("sweep_stalled", true, "ts_in_future"));
		} else {
			gates.push(
				gate("sweep_stalled", beatAge > SWEEP_STALLED_MS, `seconds=${Math.max(0, Math.round(beatAge / 1000))}`),
			);
		}
	}

	if (heartbeat?.socket?.state === "down") {
		const downMs = now - heartbeat.socket.since.getTime();
		gates.push(
			gate(
				"slack_disconnected",
				downMs >= SOCKET_DOWN_MS,
				`socket=down minutes=${Math.max(0, Math.floor(downMs / 60_000))}`,
			),
		);
	} else {
		gates.push(gate("slack_disconnected", false, heartbeat?.socket === undefined ? "socket=unknown" : "socket=up"));
	}

	// Open for as long as FROZEN exists, so a freeze the owner forgot keeps showing in `gates` and the gate alerts.
	const freeze = readFreeze(homeDir);
	gates.push(
		gate(
			"frozen",
			freeze !== undefined,
			freeze === undefined
				? "off"
				: `since=${freeze.since}${freeze.reason === "" ? "" : ` reason=${freeze.reason.replace(/\s+/g, "_")}`}`,
		),
	);

	if (options.ompExecutable !== undefined) gates.push(ompRuntimeGate(options.ompExecutable));

	const dbPath = join(homeDir, "ompbot.db");
	if (!existsSync(dbPath)) {
		gates.push(gate("inbound_starved", false, "db=missing"));
		gates.push(gate("origin_silent", false, "db=missing"));
		gates.push(gate("deliveries_overdue", false, "db=missing"));
		gates.push(gate("lanes_stuck", false, "db=missing"));
		gates.push(gate("monitors_failed", false, "db=missing"));
		gates.push(gate("monitors_stalled", false, "db=missing"));
		gates.push(gate("turns_failing", false, "db=missing"));
		return gates;
	}

	let db: Database | undefined;
	const ledger: Gate[] = [];
	try {
		db = new Database(dbPath, { readonly: true, strict: true });
		if (!tableExists(db, "inbound") || !tableExists(db, "deliveries")) throw new Error("ledger tables missing");
		const lastSign = columnExists(db, "inbound", "last_event_at")
			? "COALESCE(last_event_at, dispatched_at)"
			: "dispatched_at";
		// Origins waiting on a live approval card. A card past `expires_at` (ms epoch) waits on nobody even while its
		// row still reads `pending` (`expireStale` failing), so it exempts nothing.
		const pendingApprovals =
			tableExists(db, "approvals") && columnExists(db, "approvals", "origin_key")
				? `SELECT origin_key FROM approvals WHERE status = 'pending' AND origin_key IS NOT NULL${
						columnExists(db, "approvals", "expires_at") ? ` AND expires_at > ${now}` : ""
					}`
				: undefined;
		const waitingOnOwner = pendingApprovals === undefined ? "" : ` AND origin_key NOT IN (${pendingApprovals})`;
		const starved = scalar(
			db,
			`SELECT COUNT(*) AS n FROM inbound WHERE state = 'dispatched' AND dispatched_at IS NOT NULL AND ${lastSign} <= ${now - INBOUND_STARVATION_MS}${waitingOnOwner}`,
		);
		ledger.push(gate("inbound_starved", starved > 0, `silent_old=${starved}`));

		if (heartbeat?.draining === true) {
			// A restart drain holds pending rows on purpose; the next process dispatches them.
			ledger.push(gate("origin_silent", false, "draining"));
		} else if (!["origin_key", "created_at"].every((c) => columnExists(db as Database, "inbound", c))) {
			// A pre-migration ledger must stay readable, never throw (same stance as the other column guards).
			ledger.push(gate("origin_silent", false, "schema=old"));
		} else {
			const silent = db
				.query(
					`SELECT COUNT(*) AS n, COUNT(DISTINCT origin_key) AS origins, MIN(created_at) AS oldest FROM inbound
					 WHERE state = 'pending' AND created_at <= ${now - ORIGIN_SILENT_MS} AND origin_key NOT LIKE 'monitor/%'${waitingOnOwner}
					 AND origin_key NOT IN (SELECT origin_key FROM inbound WHERE state = 'dispatched' AND ${lastSign} > ${now - INBOUND_STARVATION_MS})`,
				)
				.get() as { n: number; origins: number; oldest: number | null };
			const minutes = silent.oldest === null ? 0 : Math.floor((now - silent.oldest) / 60_000);
			ledger.push(
				gate(
					"origin_silent",
					silent.n > 0,
					silent.n > 0 ? `waiting=${silent.n} origins=${silent.origins} oldest_min=${minutes}` : "waiting=0",
				),
			);
		}

		const overdue = scalar(
			db,
			`SELECT COUNT(*) AS n FROM deliveries WHERE state IN ('pending','inflight') AND next_at <= ${now - DELIVERY_OVERDUE_MS}`,
		);
		ledger.push(gate("deliveries_overdue", overdue > 0, `overdue=${overdue}`));

		// `updated_at` moves on every 15-minute status-message redraw, so it never ages while the daemon runs; the
		// newest history entry (created, progress, owner_reply, claim, not_done, reopened…) is the lane's real activity.
		const laneActivity = columnExists(db, "lanes", "history")
			? "COALESCE(json_extract(history, '$[#-1].at'), updated_at)"
			: "updated_at";
		// A quiet working lane is not stuck while a turn dispatched inside the same 24h window still runs on its origin,
		// or while it waits on the owner (a live approval card for that origin); only the rest are orphans. A turn
		// dispatched before the window has itself gone a day without lane progress, however many events it emits.
		const laneOrigin = tableExists(db, "lanes") && columnExists(db, "lanes", "origin_key");
		const laneRunning =
			laneOrigin && columnExists(db, "inbound", "origin_key")
				? `origin_key IN (SELECT origin_key FROM inbound WHERE state = 'dispatched' AND dispatched_at > ${now - LANE_STUCK_MS})`
				: "0";
		const laneApproval = laneOrigin && pendingApprovals !== undefined ? `origin_key IN (${pendingApprovals})` : "0";
		const quietLanes = (
			tableExists(db, "lanes")
				? db
						.query(
							`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN ${laneRunning} THEN 1 ELSE 0 END), 0) AS running,
							 COALESCE(SUM(CASE WHEN NOT (${laneRunning}) AND ${laneApproval} THEN 1 ELSE 0 END), 0) AS approval
							 FROM lanes WHERE status = 'working' AND ${laneActivity} <= ${now - LANE_STUCK_MS}`,
						)
						.get()
				: { total: 0, running: 0, approval: 0 }
		) as { total: number; running: number; approval: number };
		const orphanLanes = quietLanes.total - quietLanes.running - quietLanes.approval;
		ledger.push(
			gate(
				"lanes_stuck",
				orphanLanes > 0,
				`working_old=${orphanLanes} running=${quietLanes.running} approval_wait=${quietLanes.approval}`,
			),
		);

		const failedMonitors =
			tableExists(db, "monitor_events") && tableExists(db, "monitors")
				? scalar(
						db,
						`SELECT COUNT(DISTINCT e.monitor_id) AS n FROM monitor_events e JOIN monitors m ON m.id = e.monitor_id
						 WHERE e.stage = 'failed_no_retry' AND e.updated_at > ${now - MONITOR_FAILURE_WINDOW_MS} AND m.enabled = 1`,
					)
				: 0;
		ledger.push(gate("monitors_failed", failedMonitors > 0, `failed_recent=${failedMonitors}`));

		ledger.push(monitorsStalled(db, heartbeat, now));

		// Monitor failures never write a `[turn failed]` delivery (their notices are `⏰ …`), so this counts chat turns
		// only. The columns are guarded like `last_event_at`: a pre-migration ledger must stay readable, never throw.
		const failedTurns =
			columnExists(db, "deliveries", "body") && columnExists(db, "deliveries", "created_at")
				? scalar(
						db,
						`SELECT COUNT(*) AS n FROM deliveries WHERE body LIKE '[turn failed]%' AND created_at > ${now - TURNS_FAILING_WINDOW_MS}`,
					)
				: 0;
		ledger.push(gate("turns_failing", failedTurns >= TURNS_FAILING_THRESHOLD, `recent=${failedTurns}`));
		gates.push(...ledger);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		gates.push(gate("ledger_unreadable", true, `error=${reason.replace(/\s+/g, " ").slice(0, 120)}`));
	} finally {
		try {
			db?.close();
		} catch {
			// a handle that never opened has nothing to close
		}
	}

	return gates;
}
