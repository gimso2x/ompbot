import { Database } from "bun:sqlite";
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isThreadOrigin } from "../core/normalize";
import { sessionDirFor } from "../core/origin";
import { MONITOR_ORIGIN_PREFIX } from "../monitors/ledger";
import { removeTurnRefsSync, TURN_SNAPSHOT_RETENTION_DAYS } from "./turn-snapshot";

export const DEFAULT_SESSION_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const EPOCH_DIR = /^e([1-9][0-9]*)$/;

export interface GcOptions {
	homeDir: string;
	retentionDays: number;
	now: number;
	/** Report what would be removed without deleting. */
	dryRun?: boolean;
}

export interface GcResult {
	removed: string[];
	/** Previous-epoch directories still inside the retention window. */
	retained: string[];
	/** Thread-session origins (`slack/ch/<C>/t/<R>`) removed whole (directory + ledger row) past retention. */
	threadOriginsRemoved: string[];
	/** Origins of deleted monitors (`monitor/<id>` with no row in `monitors`) removed whole past retention. */
	monitorOriginsRemoved: string[];
	/** `!undo` turn snapshots past retention: rows deleted and their refs released. */
	turnSnapshotsRemoved: number;
	/** Teams guest/qa context rows (`teams_qa`) older than `TEAMS_QA_RETENTION_DAYS` deleted. */
	teamsQaRemoved: number;
}

/** How long a Teams guest/qa question and answer stay as conversation context. */
export const TEAMS_QA_RETENTION_DAYS = 30;

/** Newest modification time of a directory tree (symlinks are not followed). */
function newestMtimeMs(path: string): number {
	const stat = lstatSync(path);
	let newest = stat.mtimeMs;
	if (stat.isDirectory()) {
		for (const name of readdirSync(path)) newest = Math.max(newest, newestMtimeMs(join(path, name)));
	}
	return newest;
}

/**
 * Deletes only session directories of PREVIOUS epochs (`sessions/<origin>/e<N>` with N below the origin's current
 * epoch in the ledger) whose newest file is older than the retention window. The current epoch, unknown origins,
 * and anything not named `e<N>` are never touched. The ledger is opened read-only.
 *
 * Thread-session origins (`slack/ch/<C>/t/<R>`) never churn epochs (`!new` is their only epoch path), so their
 * sessions would pile up forever. Once the origin's newest activity is past the retention window the whole
 * directory goes, together with the ledger row — a later message simply opens a fresh origin. Activity is the
 * newest file mtime (the ledger's `updated_at` is not bumped on turns); a missing directory ages by `updated_at`.
 * An origin with pending or dispatched inbound is never removed, and a symlinked origin directory is never followed.
 */
export function gcSessions(options: GcOptions): GcResult {
	const result: GcResult = {
		removed: [],
		retained: [],
		threadOriginsRemoved: [],
		monitorOriginsRemoved: [],
		turnSnapshotsRemoved: 0,
		teamsQaRemoved: 0,
	};
	const dbPath = join(options.homeDir, "ompbot.db");
	if (!existsSync(dbPath)) return result;
	const sessionsRoot = join(options.homeDir, "sessions");
	const db = new Database(dbPath, { readonly: true, strict: true });
	let origins: Array<{ origin_key: string; epoch: number; session_dir: string; updated_at: number }>;
	/** Origins with inbound still waiting for a turn: their directory and row stay whatever their age. */
	let waiting: Set<string>;
	// A home without a `monitors` table has no monitor ids, so the deleted-monitor rule is skipped entirely.
	let monitorIds: Set<string> | undefined;
	try {
		origins = db
			.query("SELECT origin_key, epoch, session_dir, updated_at FROM origins ORDER BY origin_key")
			.all() as typeof origins;
		waiting = new Set(
			(
				db.query("SELECT DISTINCT origin_key FROM inbound WHERE state IN ('pending', 'dispatched')").all() as Array<{
					origin_key: string;
				}>
			).map((row) => row.origin_key),
		);
		const hasMonitors = db.query("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'monitors'").get();
		if (hasMonitors) {
			monitorIds = new Set((db.query("SELECT id FROM monitors").all() as Array<{ id: string }>).map((row) => row.id));
		}
	} finally {
		db.close();
	}
	const cutoff = options.now - options.retentionDays * DAY_MS;
	const isOrphanMonitor = (key: string) =>
		monitorIds !== undefined &&
		key.startsWith(MONITOR_ORIGIN_PREFIX) &&
		!monitorIds.has(key.slice(MONITOR_ORIGIN_PREFIX.length));
	// Whole-origin activity is measured BEFORE pass 1: pruning an old epoch dir bumps the origin dir's own mtime
	// to now, which would otherwise make every origin with a pruned epoch look freshly active.
	const originActivity = new Map<string, number>();
	for (const origin of origins) {
		if (!isOrphanMonitor(origin.origin_key) && !isThreadOrigin(origin.origin_key)) continue;
		const originDir = dirname(sessionDirFor(sessionsRoot, origin.origin_key, 1));
		// A missing directory (the row was made, the first turn has not written yet) ages by the row's updated_at.
		const exists = lstatSync(originDir, { throwIfNoEntry: false }) !== undefined;
		originActivity.set(origin.origin_key, exists ? newestMtimeMs(originDir) : origin.updated_at);
	}
	for (const origin of origins) {
		const originDir = dirname(sessionDirFor(sessionsRoot, origin.origin_key, 1));
		// An origin directory that is not a plain directory (a link swapped in) is skipped whole: gc never reaches past it.
		if (lstatSync(originDir, { throwIfNoEntry: false })?.isDirectory() !== true) continue;
		for (const name of readdirSync(originDir)) {
			const epoch = EPOCH_DIR.exec(name)?.[1];
			if (epoch === undefined || Number(epoch) >= origin.epoch) continue;
			const path = join(originDir, name);
			// `/resume-ompbot` can make an older epoch's directory the live one again.
			if (resolve(path) === resolve(origin.session_dir)) continue;
			if (!lstatSync(path).isDirectory()) continue;
			if (newestMtimeMs(path) >= cutoff) {
				result.retained.push(path);
				continue;
			}
			if (!options.dryRun) rmSync(path, { recursive: true, force: true });
			result.removed.push(path);
		}
	}
	// The read-only handle is closed before the cleanup pass opens, so the writable short-lived connection
	// never fights a lock. busy_timeout mirrors the ledger's open options: a turn committing at the same
	// moment must not fail the gc with an immediate SQLITE_BUSY. Only expired thread origins delete rows;
	// everything else stays read-only. A dry run opens it read-only, only to count the turn snapshots.
	const write = new Database(dbPath, options.dryRun ? { readonly: true, strict: true } : { strict: true });
	write.run("PRAGMA busy_timeout = 5000");
	const removeRow = options.dryRun ? undefined : write.query("DELETE FROM origins WHERE origin_key = ?");
	try {
		for (const origin of origins) {
			const orphanMonitor = isOrphanMonitor(origin.origin_key);
			if (!orphanMonitor && !isThreadOrigin(origin.origin_key)) continue;
			const originDir = dirname(sessionDirFor(sessionsRoot, origin.origin_key, 1));
			const activity = originActivity.get(origin.origin_key);
			if (activity !== undefined && activity >= cutoff) {
				result.retained.push(originDir);
				continue;
			}
			const present = lstatSync(originDir, { throwIfNoEntry: false });
			// Inbound still waiting for a turn keeps its origin whole; a link in place of the directory is never followed.
			if (waiting.has(origin.origin_key)) {
				result.retained.push(originDir);
				continue;
			}
			if (present !== undefined && !present.isDirectory()) continue;
			if (!options.dryRun) {
				if (present !== undefined) rmSync(originDir, { recursive: true, force: true });
				removeRow?.run(origin.origin_key);
			}
			(orphanMonitor ? result.monitorOriginsRemoved : result.threadOriginsRemoved).push(origin.origin_key);
		}
		result.turnSnapshotsRemoved = gcTurnSnapshots(write, options);
		result.teamsQaRemoved = gcTeamsQa(write, options);
	} finally {
		write.close();
	}
	return result;
}

/** Teams guest/qa context rows past `TEAMS_QA_RETENTION_DAYS` leave the ledger; a dry run only counts them. */
function gcTeamsQa(db: Database, options: GcOptions): number {
	const table = db.query("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'teams_qa'").get();
	if (table === null) return 0;
	const cutoff = options.now - TEAMS_QA_RETENTION_DAYS * DAY_MS;
	const row = db.query("SELECT COUNT(*) AS n FROM teams_qa WHERE at < ?").get(cutoff) as { n: number };
	if (row.n > 0 && options.dryRun !== true) db.query("DELETE FROM teams_qa WHERE at < ?").run(cutoff);
	return row.n;
}

/**
 * `!undo` rows past the turn-snapshot retention (7 days, independent of the session window) leave the ledger, and the
 * `refs/ompbot/turns/<id>/…` that kept their trees alive go with them. Runs on the writable handle `gcSessions` already
 * opened; a dry run reads the count and writes nothing.
 */
function gcTurnSnapshots(db: Database, options: GcOptions): number {
	const cutoff = options.now - TURN_SNAPSHOT_RETENTION_DAYS * DAY_MS;
	const rows = db.query("SELECT id, repo FROM turn_snapshots WHERE ended_at < ?").all(cutoff) as Array<{
		id: number;
		repo: string;
	}>;
	if (rows.length === 0 || options.dryRun === true) return rows.length;
	db.query("DELETE FROM turn_snapshots WHERE ended_at < ?").run(cutoff);
	removeTurnRefsSync(rows.map((row) => ({ id: row.id, repo: row.repo })));
	return rows.length;
}
