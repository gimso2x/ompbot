import { Database } from "bun:sqlite";
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isThreadOrigin } from "../core/normalize";
import { sessionDirFor } from "../core/origin";
import { MONITOR_ORIGIN_PREFIX } from "../monitors/ledger";

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
}

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
 * newest file mtime (the ledger's `updated_at` is not bumped on turns); a missing directory counts as expired.
 */
export function gcSessions(options: GcOptions): GcResult {
	const result: GcResult = { removed: [], retained: [], threadOriginsRemoved: [], monitorOriginsRemoved: [] };
	const dbPath = join(options.homeDir, "ompbot.db");
	if (!existsSync(dbPath)) return result;
	const sessionsRoot = join(options.homeDir, "sessions");
	const db = new Database(dbPath, { readonly: true, strict: true });
	let origins: Array<{ origin_key: string; epoch: number; session_dir: string }>;
	// A home without a `monitors` table has no monitor ids, so the deleted-monitor rule is skipped entirely.
	let monitorIds: Set<string> | undefined;
	try {
		origins = db
			.query("SELECT origin_key, epoch, session_dir FROM origins ORDER BY origin_key")
			.all() as typeof origins;
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
		if (existsSync(originDir)) originActivity.set(origin.origin_key, newestMtimeMs(originDir));
	}
	for (const origin of origins) {
		const originDir = dirname(sessionDirFor(sessionsRoot, origin.origin_key, 1));
		if (!existsSync(originDir)) continue;
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
	// everything else stays read-only.
	const write = options.dryRun ? undefined : new Database(dbPath, { strict: true });
	write?.run("PRAGMA busy_timeout = 5000");
	const removeRow = write?.query("DELETE FROM origins WHERE origin_key = ?");
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
			if (!options.dryRun) {
				if (existsSync(originDir)) rmSync(originDir, { recursive: true, force: true });
				removeRow?.run(origin.origin_key);
			}
			(orphanMonitor ? result.monitorOriginsRemoved : result.threadOriginsRemoved).push(origin.origin_key);
		}
	} finally {
		write?.close();
	}
	return result;
}
