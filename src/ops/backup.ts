import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	type Stats,
	statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { parseStampFields, parseStampTs, writeAtomic0600 } from "./stamp";

/** Daily backup files live at `<home>/backups/ompbot-YYYYMMDD-HHMMSS.db`; the stamp sits next to them. */
export const BACKUP_FILE_PATTERN = /^ompbot-\d{8}-\d{6}\.db$/;
/** Daily bundle files live next to the db snapshots with the same timestamp: `ompbot-bundle-YYYYMMDD-HHMMSS.tar.gz`. */
export const BUNDLE_FILE_PATTERN = /^ompbot-bundle-\d{8}-\d{6}\.tar\.gz$/;
export const STAMP_FILE = "last-backup.ok";
export const DEFAULT_KEEP = 14;
/**
 * What the daily bundle carries next to the ledger: the omp session originals (the bot's conversation memory), the
 * config, and the non-git `workspace/` (persona, retros) and `scripts/` (monitor collectors). `<home>/secrets` is deliberately NOT on this list — backups must never grow a copy of the tokens.
 * Exported so `ompbot doctor` can tell "nothing to bundle" (a ledger-only home) from "should have bundled".
 */
export const BUNDLE_SOURCES = ["sessions", "config.json", "workspace", "scripts"] as const;
/** Combined size ceiling of the bundle sources (sessions measured 88MB on 2026-11-03, workspace/ + scripts/ ~120KB; 512MB is two orders of headroom). */
export const DEFAULT_MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

export type BackupErrorCode =
	| "db_missing"
	| "target_exists"
	| "integrity_check_failed"
	| "not_self_contained"
	| "vacuum_failed"
	| "bundle_too_large"
	| "bundle_failed";

export class BackupError extends Error {
	readonly code: BackupErrorCode;

	constructor(code: BackupErrorCode, detail: string) {
		super(`${code}: ${detail}`);
		this.name = "BackupError";
		this.code = code;
	}
}

export interface BackupOptions {
	homeDir: string;
	/**
	 * How many days of daily backups to keep, per kind: every file of this run's day, the latest file of each other
	 * day (see `retentionDoomed`). 0 disables pruning. Default 14.
	 */
	keep?: number;
	/** Timestamp used for the file name (tests inject this). */
	now?: Date;
	/** Combined size ceiling of the bundle sources (tests inject this). Default 512MB. */
	maxBundleBytes?: number;
	/** The tar binary (tests inject this). Default `tar` on PATH. */
	tarBin?: string;
	/**
	 * Snapshot the db only (`apply`'s pre-restart backup): no bundle, and the stamp is left as it is - a stamp without a
	 * bundle would fail doctor's `backup bundle` check, and the daily backup keeps the stamp and its bundle fresh.
	 */
	skipBundle?: boolean;
}

export interface BackupResult {
	/** Absolute path of the verified backup file. */
	file: string;
	bytes: number;
	sha256: string;
	/** Absolute path of the sessions+config bundle, when the home had sources to bundle. */
	bundle: string | undefined;
	bundleBytes: number | undefined;
	bundleSha256: string | undefined;
	/** Path of the success stamp this run wrote; `undefined` with `skipBundle` (the stamp was left alone). */
	stamp: string | undefined;
	kept: string[];
	removed: string[];
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

/** Local-time stamp like `20261023-043000`, so file names sort chronologically. */
export function backupStamp(date: Date): string {
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Bytes per readSync chunk when hashing a backup file: RAM stays at this size regardless of file size. */
const HASH_CHUNK_BYTES = 1024 * 1024;

export function sha256File(path: string): string {
	const hash = createHash("sha256");
	const buf = Buffer.alloc(HASH_CHUNK_BYTES);
	const fd = openSync(path, "r");
	try {
		let position = 0;
		for (;;) {
			const read = readSync(fd, buf, 0, HASH_CHUNK_BYTES, position);
			if (read === 0) break;
			hash.update(read === HASH_CHUNK_BYTES ? buf : buf.subarray(0, read));
			position += read;
		}
	} finally {
		closeSync(fd);
	}
	return hash.digest("hex");
}

function fsyncFile(path: string): void {
	const fd = openSync(path, "r+");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** fsync through a read-only handle: works for a directory and for a file alike. */
export function fsyncPath(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** Atomic 0600 write: temp file + rename, so a half-written stamp is never observable. */
export function writeStampAtomic(backupsDir: string, content: string, name: string = STAMP_FILE): string {
	return writeAtomic0600(join(backupsDir, name), content);
}

/** `dev:ino` of every regular file under `secrets/` (a missing directory has none). */
function secretInodes(secretsReal: string): Set<string> {
	const inodes = new Set<string>();
	if (!existsSync(secretsReal)) return inodes;
	const stack = [secretsReal];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const stat = lstatSync(join(dir, entry.name));
			if (stat.isDirectory()) stack.push(join(dir, entry.name));
			else if (stat.isFile()) inodes.add(`${stat.dev}:${stat.ino}`);
		}
	}
	return inodes;
}

/** A hard-linked regular file that shares its inode with a secret would carry the token's bytes into the tar. */
function refuseSecretHardLink(stat: Stats, name: string, secrets: Set<string>): void {
	if (stat.isFile() && stat.nlink > 1 && secrets.has(`${stat.dev}:${stat.ino}`)) {
		throw new BackupError("bundle_failed", `${name} is a hard link to a secrets/ file`);
	}
}

/** On-disk size of a directory tree (symlinks count as their own link size, never their target). */
function treeBytes(root: string, label: string, secrets: Set<string>): number {
	let total = 0;
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			const stat = lstatSync(path);
			refuseSecretHardLink(stat, `${label}${path.slice(root.length)}`, secrets);
			if (stat.isDirectory()) stack.push(path);
			else total += stat.size;
		}
	}
	return total;
}

interface PendingBundle {
	tmp: string;
	target: string;
}

/** GNU tar's only warning that still leaves a complete archive: a file (a live session log) grew while it was read. */
const FILE_CHANGED_WARNING = /^tar: .+: file changed as we read it$/;

/** `tar -c` exit 0, or exit 1 whose every stderr line is the file-changed warning; anything else is a failure. */
function tarCreateSucceeded(exitCode: number | null, stderr: string): boolean {
	if (exitCode === 0) return true;
	if (exitCode !== 1) return false;
	const lines = stderr.split("\n").filter((line) => line.trim() !== "");
	return lines.length > 0 && lines.every((line) => FILE_CHANGED_WARNING.test(line));
}

/**
 * Tars the bundle sources (`sessions/`, `config.json`, `workspace/`, `scripts/`) of `<homeDir>` into a temp file and verifies the archive
 * lists every source. `undefined` when the home has no sources at all (a ledger-only home has nothing to bundle).
 * Anything that goes wrong fails the whole backup: a stamp must never claim a bundle that was not verified.
 */
function createPendingBundle(
	homeDir: string,
	backupsDir: string,
	stamp: string,
	maxBytes: number,
	tarBin: string,
): PendingBundle | undefined {
	// lstat, not existsSync: a dangling or cyclic top-level link is a source that must fail, not one to skip.
	const sources = BUNDLE_SOURCES.filter((name) => lstatSync(join(homeDir, name), { throwIfNoEntry: false }));
	if (sources.length === 0) return undefined;
	let tmp: string | undefined;
	try {
		const secretsDir = join(homeDir, "secrets");
		const secretsReal = existsSync(secretsDir) ? realpathSync(secretsDir) : secretsDir;
		const secrets = secretInodes(secretsReal);
		/** Top-level symlinked sources and their real targets: only that one link is followed, never links inside it. */
		const linked = new Map<string, string>();
		/** Real path of every source seen so far, plain ones included: a link into a plain source would archive it twice. */
		const reals = new Map<string, string>();
		const homeReal = realpathSync(homeDir);
		/** Directory sources that had entries before tar ran: their archive must carry at least one member below them. */
		const nonEmpty = new Set<string>();
		let bytes = 0;
		for (const source of sources) {
			const path = join(homeDir, source);
			let stat = lstatSync(path);
			let real = path;
			if (stat.isSymbolicLink()) {
				try {
					real = realpathSync(path);
				} catch (error) {
					throw new BackupError("bundle_failed", `${source} link does not resolve: ${(error as Error).message}`);
				}
				const insideSecrets = real === secretsReal || real.startsWith(`${secretsReal}/`);
				if (insideSecrets || secretsReal.startsWith(`${real}/`)) {
					throw new BackupError("bundle_failed", `${source} links to or around secrets/`);
				}
				stat = statSync(real);
				// A linked source must be what the plain one would be: config.json a file, the rest directories.
				if (stat.isDirectory() !== (source !== "config.json")) {
					throw new BackupError("bundle_failed", `${source} links to the wrong kind of file`);
				}
				linked.set(source, real);
			}
			const here = linked.get(source) ?? join(homeReal, source);
			for (const [other, otherReal] of reals) {
				if (here === otherReal || here.startsWith(`${otherReal}/`) || otherReal.startsWith(`${here}/`)) {
					throw new BackupError("bundle_failed", `${source} and ${other} link to overlapping paths`);
				}
			}
			reals.set(source, here);
			if (stat.isDirectory()) {
				bytes += treeBytes(real, source, secrets);
				if (readdirSync(real).length > 0) nonEmpty.add(source);
			} else {
				refuseSecretHardLink(stat, source, secrets);
				bytes += stat.size;
			}
		}
		if (bytes > maxBytes) throw new BackupError("bundle_too_large", `${bytes} > ${maxBytes}`);

		const target = join(backupsDir, `ompbot-bundle-${stamp}.tar.gz`);
		if (existsSync(target)) throw new BackupError("target_exists", target);
		tmp = `${target}.tmp-${crypto.randomUUID()}`;
		// No global -h: that would follow links inside the sources too (out of home, into secrets/). A linked source is
		// archived from / as `./<real path>` - a name no plain source under -C home can carry - and GNU tar's
		// --transform (global, not positional) renames it back to the source name; S leaves symlink targets alone.
		const transforms = [...linked].map(
			([source, real]) =>
				`--transform=s,^\\./${real.slice(1).replace(/[\\.[\]*^$,]/g, "\\$&")}\\(/\\|$\\),${source}\\1,S`,
		);
		const plain = sources.filter((source) => !linked.has(source));
		const create = Bun.spawnSync([
			tarBin,
			"-czf",
			tmp,
			...transforms,
			...(plain.length > 0 ? ["-C", homeDir, ...plain] : []),
			...(linked.size > 0 ? ["-C", "/", ...[...linked.values()].map((real) => `.${real}`)] : []),
		]);
		if (!tarCreateSucceeded(create.exitCode, create.stderr.toString())) {
			throw new BackupError("bundle_failed", create.stderr.toString().trim().slice(0, 200));
		}
		const list = Bun.spawnSync([tarBin, "-tzf", tmp]);
		if (list.exitCode !== 0) {
			throw new BackupError("bundle_failed", list.stderr.toString().trim().slice(0, 200));
		}
		const entries = list.stdout.toString().split("\n");
		for (const source of sources) {
			const listed = entries.some((line) => line === source || line.startsWith(`${source}/`));
			if (!listed) throw new BackupError("bundle_failed", `archive is missing ${source}`);
			if (
				nonEmpty.has(source) &&
				!entries.some((line) => line.startsWith(`${source}/`) && line.length > source.length + 1)
			) {
				throw new BackupError("bundle_failed", `archive is missing the contents of ${source}`);
			}
		}
		chmodSync(tmp, 0o600);
		return { tmp, target };
	} catch (error) {
		if (tmp !== undefined) rmSync(tmp, { force: true });
		if (error instanceof BackupError) throw error;
		throw new BackupError("bundle_failed", error instanceof Error ? error.message : String(error));
	}
}

/**
 * Creates a consistent single-file snapshot of `<homeDir>/ompbot.db` and verifies it before it counts, then bundles
 * `sessions/`, `config.json`, `workspace/` and `scripts/` (conversation memory, persona, collectors) into a verified tar.gz next to it.
 *
 * The snapshot is made with SQLite `VACUUM INTO` from a read-only connection, so the live WAL/SHM sidecars are never
 * copied and the daemon does not have to be involved (or even running). The copy is written to a temp name, checked
 * with `PRAGMA quick_check`, and only then renamed into place - a failed backup never leaves a newest-mtime file
 * behind that a freshness check could mistake for a good one. The bundle is built and listed before either rename,
 * so a bundle failure leaves no partial backup at all. The success stamp (`last-backup.ok`, including the bundle's
 * name and sha256) is written last, and pruning runs only after the new backup is on disk. `skipBundle` makes and
 * verifies the db snapshot alone and writes no stamp.
 */
export function runBackup(options: BackupOptions): BackupResult {
	const keep = options.keep ?? DEFAULT_KEEP;
	const homeDir = options.homeDir;
	const dbPath = join(homeDir, "ompbot.db");
	if (!existsSync(dbPath)) throw new BackupError("db_missing", dbPath);

	const backupsDir = join(homeDir, "backups");
	mkdirSync(backupsDir, { recursive: true, mode: 0o700 });

	const now = options.now ?? new Date();
	const stamp = backupStamp(now);
	const target = join(backupsDir, `ompbot-${stamp}.db`);
	if (existsSync(target)) throw new BackupError("target_exists", target);
	const tmp = `${target}.tmp-${crypto.randomUUID()}`;

	let bundle: PendingBundle | undefined;
	try {
		const source = new Database(dbPath, { readonly: true, strict: true });
		try {
			source.run("PRAGMA busy_timeout=5000");
			try {
				source.query("VACUUM INTO ?").run(tmp);
			} catch (error) {
				throw new BackupError("vacuum_failed", error instanceof Error ? error.message : String(error));
			}
		} finally {
			source.close();
		}
		chmodSync(tmp, 0o600);
		fsyncFile(tmp);

		const sidecar = ["-wal", "-shm"].map((suffix) => `${tmp}${suffix}`).find((path) => existsSync(path));
		if (sidecar !== undefined) throw new BackupError("not_self_contained", sidecar);

		const copy = new Database(tmp, { readonly: true, strict: true });
		let check: string;
		try {
			const row = copy.query("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
			check = row?.quick_check ?? "";
		} finally {
			copy.close();
		}
		if (check !== "ok") throw new BackupError("integrity_check_failed", `quick_check=${check}`);

		bundle =
			options.skipBundle === true
				? undefined
				: createPendingBundle(
						homeDir,
						backupsDir,
						stamp,
						options.maxBundleBytes ?? DEFAULT_MAX_BUNDLE_BYTES,
						options.tarBin ?? "tar",
					);
		renameSync(tmp, target);
		if (bundle !== undefined) renameSync(bundle.tmp, bundle.target);
		fsyncPath(backupsDir);
	} catch (error) {
		rmSync(tmp, { force: true });
		rmSync(`${tmp}-wal`, { force: true });
		rmSync(`${tmp}-shm`, { force: true });
		if (bundle !== undefined) rmSync(bundle.tmp, { force: true });
		// The db rename may already have landed when a later step (the bundle rename) failed: a newest-mtime file
		// behind would fake a good backup for the freshness check, so it goes too. Both targets were checked absent
		// before the run, so deleting them cannot destroy a previous good backup.
		rmSync(target, { force: true });
		if (bundle !== undefined) rmSync(bundle.target, { force: true });
		throw error;
	}

	const bytes = statSync(target).size;
	const sha256 = sha256File(target);
	const bundleBytes = bundle === undefined ? undefined : statSync(bundle.target).size;
	const bundleSha256 = bundle === undefined ? undefined : sha256File(bundle.target);
	const bundleName = bundle === undefined ? undefined : bundle.target.split("/").pop();
	let stampPath: string | undefined;
	if (options.skipBundle !== true) {
		try {
			stampPath = writeStampAtomic(
				backupsDir,
				`ts=${now.toISOString()} file=${target.split("/").pop()} bytes=${bytes} sha256=${sha256} integrity=ok check=quick_check${
					bundle === undefined ? "" : ` bundle=${bundleName} bundle_bytes=${bundleBytes} bundle_sha256=${bundleSha256}`
				}\n`,
			);
		} catch (error) {
			// Both targets were checked absent before the run: without their stamp they are leftovers, not a backup.
			rmSync(target, { force: true });
			if (bundle !== undefined) rmSync(bundle.target, { force: true });
			throw error;
		}
	}

	const removed =
		keep > 0 ? pruneBackups(backupsDir, keep, bundle === undefined ? target : [target, bundle.target]) : [];
	const kept = readdirSync(backupsDir)
		.filter((name) => BACKUP_FILE_PATTERN.test(name))
		.sort()
		.reverse()
		.map((name) => join(backupsDir, name));

	return {
		file: target,
		bytes,
		sha256,
		bundle: bundle?.target,
		bundleBytes,
		bundleSha256,
		stamp: stampPath,
		kept,
		removed,
	};
}

/**
 * Day retention for one kind of daily file (`pattern`), shared by the local prune and the off-site pass. A day is
 * the `YYYYMMDD` of the name's stamp (no time zone conversion). The base day is the day of the `protect` names (the
 * files this run made) - or, without one, the newest stamp's day - and every file of it stays; the other `keep - 1`
 * newest days keep only their latest file, so a clock that stepped back (future-dated names) cannot shrink the run's
 * own day. Returns the names to delete, newest name first; names outside `pattern` and `protect` are never in it.
 */
export function retentionDoomed(
	names: readonly string[],
	keep: number,
	protect: readonly string[],
	pattern: RegExp,
): string[] {
	const daily = names
		.filter((name) => pattern.test(name))
		.sort()
		.reverse();
	const dayOf = (name: string) => name.match(/(\d{8})-\d{6}/)?.[1] ?? "";
	const baseDays = new Set(protect.filter((name) => pattern.test(name)).map(dayOf));
	if (baseDays.size === 0 && daily[0] !== undefined) baseDays.add(dayOf(daily[0]));
	const otherDays = [...new Set(daily.map(dayOf))].filter((day) => !baseDays.has(day));
	const keptDays = new Set(otherDays.slice(0, Math.max(0, keep - baseDays.size)));
	const doomed: string[] = [];
	for (const name of daily) {
		const day = dayOf(name);
		// a protected name's day is a base day, so protect is never doomed
		if (baseDays.has(day)) continue;
		// daily is newest-first, so the first name seen of a kept day is its latest
		if (keptDays.delete(day)) continue;
		doomed.push(name);
	}
	return doomed;
}

/**
 * Applies `retentionDoomed` to the db snapshots and the bundles separately (`keep` days per kind, `protect` = the
 * absolute paths this run made), deleting newest-first by name. The patterns only match the timestamped daily
 * names, so manual copies (`ompbot-pre-upgrade-…db`, `.bak-…`) and the stamp are never touched.
 */
export function pruneBackups(backupsDir: string, keep: number, protect: string | readonly string[]): string[] {
	const guarded = (typeof protect === "string" ? [protect] : protect).map((path) => basename(path));
	const names = readdirSync(backupsDir, { withFileTypes: true })
		.filter((e) => e.isFile())
		.map((e) => e.name);
	const removed: string[] = [];
	for (const kind of [BACKUP_FILE_PATTERN, BUNDLE_FILE_PATTERN]) {
		for (const name of retentionDoomed(names, keep, guarded, kind)) {
			const path = join(backupsDir, name);
			try {
				rmSync(path, { force: true });
				removed.push(path);
			} catch {
				// retention is best effort: the new backup is already verified and stamped
			}
		}
	}
	return removed;
}

export interface StampInfo {
	/** ISO timestamp parsed from the stamp content; falls back to the file mtime. */
	ts: Date;
	file: string | undefined;
	bytes: number | undefined;
	sha256: string | undefined;
	/** Bundle fields (present once a backup also wrote a verified sessions+config bundle). */
	bundle: string | undefined;
	bundleBytes: number | undefined;
	bundleSha256: string | undefined;
}

/** Reads the success stamp written by `runBackup`; `undefined` when it does not exist or is unreadable. */
export function readStamp(backupsDir: string, name: string = STAMP_FILE): StampInfo | undefined {
	const stampPath = join(backupsDir, name);
	let text: string;
	try {
		// A FIFO in the stamp's place would block the read forever.
		if (!statSync(stampPath).isFile()) return undefined;
		text = readFileSync(stampPath, "utf8");
	} catch {
		return undefined;
	}
	const fields = parseStampFields(text);
	const ts = parseStampTs(fields, stampPath);
	if (ts === undefined) return undefined;
	return {
		ts,
		file: fields.get("file"),
		bytes: fields.get("bytes") === undefined ? undefined : Number(fields.get("bytes")),
		sha256: fields.get("sha256"),
		bundle: fields.get("bundle"),
		bundleBytes: fields.get("bundle_bytes") === undefined ? undefined : Number(fields.get("bundle_bytes")),
		bundleSha256: fields.get("bundle_sha256"),
	};
}
