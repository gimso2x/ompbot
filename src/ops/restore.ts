import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { acquireLock, LockHeldError } from "../daemon/lock";
import { BACKUP_FILE_PATTERN, backupStamp, fsyncPath } from "./backup";

export type RestoreErrorCode = "bad_source" | "daemon_running" | "integrity_check_failed" | "restore_failed";

export class RestoreError extends Error {
	readonly code: RestoreErrorCode;

	constructor(code: RestoreErrorCode, detail: string) {
		super(`${code}: ${detail}`);
		this.name = "RestoreError";
		this.code = code;
	}
}

export interface RestoreOptions {
	homeDir: string;
	/** A daily backup name/path under `<home>/backups`, or an absolute path to any file. */
	source: string;
	/** Without `yes` nothing changes and the plan is returned. */
	yes: boolean;
	now?: Date;
	/** IPC probe: resolves when a daemon answers on the socket, rejects when nothing listens. */
	probeDaemon: () => Promise<unknown>;
	/** Rename seam (tests inject failures); defaults to `renameSync`. */
	rename?: (from: string, to: string) => void;
}

export interface RestorePlan {
	source: string;
	target: string;
	preRestoreDir: string;
	/** Files of the current ledger that move to `preRestoreDir`. */
	moves: string[];
}

export interface RestoreResult {
	applied: boolean;
	plan: RestorePlan;
}

const SIDECARS = ["", "-wal", "-shm"] as const;
/** Core ledger tables every ompbot db has: a restore source without them is not an ompbot ledger. */
const REQUIRED_TABLES = ["origins", "inbound", "deliveries"] as const;

/** `backups/pre-restore-<stamp>`, or `-2`, `-3`… when a restore in the same second already used that name. */
function freshPreRestoreDir(homeDir: string, stamp: string): string {
	const base = join(homeDir, "backups", `pre-restore-${stamp}`);
	let dir = base;
	for (let n = 2; existsSync(dir); n += 1) dir = `${base}-${n}`;
	return dir;
}

/** Maps the CLI argument to the backup file: a daily name (or `backups/<name>`) inside the home, or an absolute file. */
export function resolveRestoreSource(homeDir: string, source: string): string {
	const backupsDir = join(homeDir, "backups");
	let path: string;
	if (isAbsolute(source)) path = resolve(source);
	else {
		const name = source.startsWith("backups/") ? source.slice("backups/".length) : source;
		if (name !== basename(name) || !BACKUP_FILE_PATTERN.test(name)) {
			throw new RestoreError(
				"bad_source",
				`${source} is neither an ompbot-YYYYMMDD-HHMMSS.db in backups/ nor an absolute path`,
			);
		}
		path = join(backupsDir, name);
	}
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(path);
	} catch {
		throw new RestoreError("bad_source", `${path} does not exist`);
	}
	if (!stat.isFile()) throw new RestoreError("bad_source", `${path} is not a regular file`);
	// A hard link hides where its other names live, and a live ledger's -wal sits beside one of those: refuse it.
	if (stat.nlink > 1) {
		throw new RestoreError("bad_source", `${path} is a hard link (${stat.nlink} names): copy the backup file first`);
	}
	// A -wal next to the source means the file is a live or crashed ledger, not a self-contained backup: copying only
	// the main file would silently drop its newest pages. A symlink is checked at its real path too.
	for (const candidate of new Set([path, realpathSync(path)])) {
		if (existsSync(`${candidate}-wal`)) {
			throw new RestoreError(
				"bad_source",
				`${candidate}-wal exists: the source is not a self-contained backup (checkpoint it or use a backup file)`,
			);
		}
	}
	return path;
}

/**
 * Replaces `<home>/ompbot.db` with a verified backup while no daemon runs. The copy is made next to the target,
 * checked with `PRAGMA quick_check`, the current db (+wal/shm) moves to `backups/pre-restore-<stamp>/`, and a rename
 * installs the copy. Any failure after the first move puts the previous files back. The single-instance lock is held
 * throughout so a daemon cannot start halfway.
 */
export async function runRestore(options: RestoreOptions): Promise<RestoreResult> {
	const { homeDir } = options;
	const rename = options.rename ?? renameSync;
	const source = resolveRestoreSource(homeDir, options.source);
	const target = join(homeDir, "ompbot.db");
	const stamp = backupStamp(options.now ?? new Date());
	const preRestoreDir = freshPreRestoreDir(homeDir, stamp);
	const plan: RestorePlan = {
		source,
		target,
		preRestoreDir,
		moves: SIDECARS.map((suffix) => `${target}${suffix}`).filter((path) => existsSync(path)),
	};

	let answered = false;
	try {
		await options.probeDaemon();
		answered = true;
	} catch {
		// nothing listening: fine
	}
	if (answered)
		throw new RestoreError(
			"daemon_running",
			"a daemon answers on ompbot.sock; stop it first (systemctl --user stop ompbot)",
		);
	let lock: ReturnType<typeof acquireLock>;
	try {
		lock = acquireLock(join(homeDir, "ompbot.lock"));
	} catch (error) {
		if (error instanceof LockHeldError) throw new RestoreError("daemon_running", error.message);
		throw error;
	}
	try {
		if (!options.yes) return { applied: false, plan };
		install(plan, rename);
		return { applied: true, plan };
	} finally {
		lock.release();
	}
}

function install(plan: RestorePlan, rename: (from: string, to: string) => void): void {
	const { source, target, preRestoreDir } = plan;
	const tmp = join(dirname(target), `ompbot.db.restore-${crypto.randomUUID()}.tmp`);
	const moved: Array<{ from: string; to: string }> = [];
	let placed = false;
	try {
		copyFileSync(source, tmp);
		chmodSync(tmp, 0o600);
		const copy = new Database(tmp, { readonly: true, strict: true });
		let check: string;
		let missing: string[];
		try {
			check = (copy.query("PRAGMA quick_check").get() as { quick_check?: string } | undefined)?.quick_check ?? "";
			// quick_check passes an empty file and any foreign sqlite db alike; the daemon would not start on either.
			const tables = new Set(
				(copy.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
					(row) => row.name,
				),
			);
			missing = REQUIRED_TABLES.filter((table) => !tables.has(table));
		} catch (error) {
			throw new RestoreError("integrity_check_failed", error instanceof Error ? error.message : String(error));
		} finally {
			copy.close();
		}
		if (check !== "ok") throw new RestoreError("integrity_check_failed", `quick_check=${check}`);
		if (missing.length > 0) {
			throw new RestoreError(
				"integrity_check_failed",
				`not an ompbot ledger: missing table${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`,
			);
		}
		rmSync(`${tmp}-wal`, { force: true });
		rmSync(`${tmp}-shm`, { force: true });
		fsyncPath(tmp);

		if (plan.moves.length > 0) mkdirSync(preRestoreDir, { recursive: true, mode: 0o700 });
		for (const from of plan.moves) {
			const to = join(preRestoreDir, basename(from));
			rename(from, to);
			moved.push({ from, to });
		}
		rename(tmp, target);
		placed = true;
		fsyncPath(target);
		fsyncPath(dirname(target));
	} catch (error) {
		rmSync(tmp, { force: true });
		if (placed || moved.length > 0) {
			// The replaced ledger must be exactly what it was: drop the half-installed copy, move the old files back.
			rmSync(target, { force: true });
			for (const { from, to } of moved.reverse()) renameSync(to, from);
		}
		if (error instanceof RestoreError) throw error;
		throw new RestoreError("restore_failed", error instanceof Error ? error.message : String(error));
	}
}
