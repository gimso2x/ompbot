import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lutimesSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BACKUP_FILE_PATTERN,
	BackupError,
	type BackupResult,
	pruneBackups,
	readStamp,
	runBackup,
	STAMP_FILE,
} from "../src/ops/backup";
import {
	BACKUP_MAX_AGE_MS,
	collectGates,
	DELIVERY_OVERDUE_MS,
	INBOUND_STARVATION_MS,
	LANE_STUCK_MS,
	MONITOR_FAILURE_WINDOW_MS,
} from "../src/ops/gates";
import { MEDIA_MAX_AGE_MS, pruneMediaFiles } from "../src/ops/media";
import { dailyBackupNames, seedDb } from "./helpers/backup-fixtures";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

let home: string;
/** Paths whose permissions the test lowered; restored before the temp dir is removed. */
let lowered: string[];

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ompbot-adv-"));
	lowered = [];
});

afterEach(() => {
	for (const path of lowered) {
		try {
			chmodSync(path, 0o700);
		} catch {
			// already gone
		}
	}
	rmSync(home, { recursive: true, force: true });
});

// --- shared helpers (copied in style from backup.test.ts / gates.test.ts) ---

function tmpLeftovers(homeDir: string): string[] {
	return readdirSync(join(homeDir, "backups")).filter((name) => name.includes(".tmp-"));
}

async function cli(args: string[], homeDir: string): Promise<{ out: string; err: string; code: number }> {
	const proc = Bun.spawn(["bun", MAIN, ...args], {
		env: { ...process.env, OMPBOT_HOME: homeDir },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { out, err, code };
}

const DDL = `
CREATE TABLE inbound (
	inbound_id INTEGER PRIMARY KEY AUTOINCREMENT,
	platform_message_id TEXT NOT NULL UNIQUE,
	origin_key TEXT NOT NULL,
	epoch INTEGER NOT NULL,
	text_ref TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'pending',
	created_at INTEGER NOT NULL,
	dispatched_at INTEGER,
	last_event_at INTEGER
);
CREATE TABLE deliveries (
	delivery_id INTEGER PRIMARY KEY AUTOINCREMENT,
	origin_key TEXT NOT NULL,
	op_ref TEXT NOT NULL,
	part INTEGER NOT NULL,
	thread_ref TEXT NOT NULL,
	body TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'pending',
	attempts INTEGER NOT NULL DEFAULT 0,
	next_at INTEGER NOT NULL,
	redelivered INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	last_error TEXT,
	UNIQUE (origin_key, op_ref, part)
);
CREATE TABLE lanes (
	name TEXT PRIMARY KEY,
	status TEXT NOT NULL DEFAULT 'working',
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE monitors (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	enabled INTEGER NOT NULL DEFAULT 1,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE monitor_events (
	event_id INTEGER PRIMARY KEY AUTOINCREMENT,
	monitor_id TEXT NOT NULL,
	slot_at INTEGER NOT NULL,
	stage TEXT NOT NULL,
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
`;

function seedLedger(dir: string, mutate: (db: Database) => void = () => {}): void {
	const db = new Database(join(dir, "ompbot.db"), { create: true, strict: true });
	db.run(DDL);
	mutate(db);
	db.close();
}

function resetLedger(): void {
	for (const suffix of ["", "-wal", "-shm"]) rmSync(join(home, `ompbot.db${suffix}`), { force: true });
}

function writeStampAt(dir: string, ts: Date, mtime?: Date): void {
	mkdirSync(join(dir, "backups"), { recursive: true });
	const path = join(dir, "backups", STAMP_FILE);
	writeFileSync(path, `ts=${ts.toISOString()} file=ompbot-x.db bytes=1 sha256=abc integrity=ok check=quick_check\n`);
	if (mtime) utimesSync(path, mtime, mtime);
}

function gateOf(dir: string, now: number, name: string): { state: string; detail: string } {
	const found = collectGates({ homeDir: dir, now }).find((g) => g.name === name);
	if (found === undefined) throw new Error(`gate ${name} not found`);
	return { state: found.state, detail: found.detail };
}

// ===================================================================================================
// backup
// ===================================================================================================

describe("runBackup adversarial", () => {
	test("backup taken while another process commits to two tables never tears a transaction", async () => {
		const dbPath = join(home, "ompbot.db");
		const setup = new Database(dbPath, { create: true, strict: true });
		setup.run("PRAGMA journal_mode=WAL");
		setup.run("CREATE TABLE a (n INTEGER PRIMARY KEY)");
		setup.run("CREATE TABLE b (n INTEGER PRIMARY KEY)");
		setup.close();

		const writerPath = join(home, "writer.ts");
		writeFileSync(
			writerPath,
			`import { Database } from "bun:sqlite";
const db = new Database(process.argv[2], { strict: true });
db.run("PRAGMA busy_timeout=5000");
const tx = db.transaction((n) => { db.run("INSERT INTO a VALUES (?)", [n]); db.run("INSERT INTO b VALUES (?)", [n]); });
let n = 0;
for (;;) { n += 1; tx(n); if (n === 1) console.log("ready"); }
`,
		);
		const writer = Bun.spawn(["bun", writerPath, dbPath], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		try {
			const reader = writer.stdout.getReader();
			let seen = "";
			while (!seen.includes("ready")) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error("writer exited early");
				seen += new TextDecoder().decode(chunk.value);
			}
			reader.releaseLock();

			let previous = 0;
			for (let i = 0; i < 6; i++) {
				const result = runBackup({ homeDir: home, keep: 0, now: new Date(2026, 9, 23, 4, 30, i) });
				const copy = new Database(result.file, { readonly: true, strict: true });
				const counts = copy.query("SELECT (SELECT COUNT(*) FROM a) AS a, (SELECT COUNT(*) FROM b) AS b").get() as {
					a: number;
					b: number;
				};
				const check = copy.query("PRAGMA quick_check").get() as { quick_check: string };
				copy.close();
				expect(check.quick_check).toBe("ok");
				expect(counts.a).toBe(counts.b);
				expect(counts.a).toBeGreaterThanOrEqual(previous);
				previous = counts.a;
			}
			expect(previous).toBeGreaterThan(0);
			expect(tmpLeftovers(home)).toEqual([]);
		} finally {
			writer.kill();
			await writer.exited;
		}
	});

	test("a crashed daemon's WAL without -shm is replayed into the backup", () => {
		const src = mkdtempSync(join(tmpdir(), "ompbot-adv-src-"));
		try {
			const live = new Database(join(src, "ompbot.db"), { create: true, strict: true });
			live.run("PRAGMA journal_mode=WAL");
			live.run("PRAGMA wal_autocheckpoint=0");
			live.run("CREATE TABLE t (n INTEGER PRIMARY KEY)");
			for (let i = 1; i <= 50; i++) live.run("INSERT INTO t VALUES (?)", [i]);
			// Snapshot main file + WAL exactly as a SIGKILLed daemon would leave them (no -shm survives a reboot).
			copyFileSync(join(src, "ompbot.db"), join(home, "ompbot.db"));
			copyFileSync(join(src, "ompbot.db-wal"), join(home, "ompbot.db-wal"));
			live.close();
		} finally {
			rmSync(src, { recursive: true, force: true });
		}
		expect(existsSync(join(home, "ompbot.db-wal"))).toBe(true);
		expect(existsSync(join(home, "ompbot.db-shm"))).toBe(false);

		const result = runBackup({ homeDir: home, now: new Date(2026, 9, 23, 4, 30, 0) });
		const copy = new Database(result.file, { readonly: true, strict: true });
		const row = copy.query("SELECT COUNT(*) AS n FROM t").get() as { n: number };
		copy.close();
		expect(row.n).toBe(50);
	});

	test("keep=2 then keep=1 with future-dated names (clock stepped back): the new backup always survives and is reported", () => {
		seedDb(home);
		const backupsDir = join(home, "backups");
		mkdirSync(backupsDir, { recursive: true });
		for (const name of [
			"ompbot-20201010-000000.db",
			"ompbot-20261020-043000.db",
			"ompbot-20290101-000000.db",
			"ompbot-20301010-000000.db",
		]) {
			writeFileSync(join(backupsDir, name), "x");
		}
		const first = runBackup({ homeDir: home, keep: 2, now: new Date(2026, 9, 25, 4, 30, 0) });
		expect(existsSync(first.file)).toBe(true);
		expect(first.kept).toContain(first.file);
		expect(first.kept).toHaveLength(2);
		expect(dailyBackupNames(home)).toEqual(["ompbot-20261025-043000.db", "ompbot-20301010-000000.db"]);

		const second = runBackup({ homeDir: home, keep: 1, now: new Date(2026, 9, 26, 4, 30, 0) });
		expect(dailyBackupNames(home)).toEqual(["ompbot-20261026-043000.db"]);
		expect(second.kept).toEqual([second.file]);
		expect(second.removed).toHaveLength(2);
		// The stamp points at the file that actually exists.
		expect(readStamp(backupsDir)?.file).toBe("ompbot-20261026-043000.db");
	});

	test("prune pattern ignores look-alike names, other dirs and non-ASCII digits", () => {
		seedDb(home);
		const backupsDir = join(home, "backups");
		mkdirSync(backupsDir, { recursive: true });
		const lookalikes = [
			"ompbot-20261020-043000.db.tmp-abc",
			"ompbot-20261020-043000.db-wal",
			"ompbot-2026102-043000.db",
			"ompbot-20261020-04300.db",
			"OMPBOT-20261020-043000.db",
			"ompbot-\u0662\u0660\u0662\u0666\u0661\u0660\u0662\u0660-043000.db",
			"ompbot-20261020-043000.db\n",
			"xompbot-20261020-043000.db",
			"ompbot-20261020-043000.DB",
			"ompbot-20261020-043000.db.gz",
			"ompbot-pre-upgrade-20261019T000000Z.db",
			"백업-20261020.db",
		];
		for (const name of lookalikes) {
			expect(BACKUP_FILE_PATTERN.test(name)).toBe(false);
			writeFileSync(join(backupsDir, name), "x");
		}
		mkdirSync(join(backupsDir, "ompbot-20261020-043000.db.d"));
		writeFileSync(join(backupsDir, "ompbot-20200101-000000.db"), "x");

		const result = runBackup({ homeDir: home, keep: 1, now: new Date(2026, 9, 25, 4, 30, 0) });
		expect(result.removed).toEqual([join(backupsDir, "ompbot-20200101-000000.db")]);
		const left = new Set(readdirSync(backupsDir));
		for (const name of lookalikes) expect(left.has(name)).toBe(true);
		expect(left.has("ompbot-20261020-043000.db.d")).toBe(true);
	});

	test("a directory squatting on a daily name must not turn a finished backup into a failure", () => {
		seedDb(home);
		const backupsDir = join(home, "backups");
		mkdirSync(join(backupsDir, "ompbot-20200101-000000.db"), { recursive: true });
		writeFileSync(join(backupsDir, "ompbot-20200101-000000.db", "inner"), "x");

		let thrown: unknown;
		let result: BackupResult | undefined;
		try {
			result = runBackup({ homeDir: home, keep: 1, now: new Date(2026, 9, 25, 4, 30, 0) });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeUndefined();
		expect(result && existsSync(result.file)).toBe(true);
	});

	test("target_exists leaves the earlier backup bytes and the stamp untouched", () => {
		seedDb(home);
		const now = new Date(2026, 9, 23, 4, 30, 0);
		const first = runBackup({ homeDir: home, now });
		const stampPath = join(home, "backups", STAMP_FILE);
		const stampBefore = readFileSync(stampPath, "utf8");
		const bytesBefore = readFileSync(first.file);

		let error: unknown;
		try {
			runBackup({ homeDir: home, now });
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(BackupError);
		expect((error as BackupError).code).toBe("target_exists");
		expect(readFileSync(stampPath, "utf8")).toBe(stampBefore);
		expect(readFileSync(first.file).equals(bytesBefore)).toBe(true);
		expect(tmpLeftovers(home)).toEqual([]);
	});

	test("an unreadable bundle source fails the whole backup: no stamp, no partial db, no residue", () => {
		seedDb(home);
		mkdirSync(join(home, "sessions"), { recursive: true });
		writeFileSync(join(home, "config.json"), "{}\n", { mode: 0o600 });
		lowered.push(join(home, "config.json"));
		chmodSync(join(home, "config.json"), 0o000);

		let error: unknown;
		try {
			runBackup({ homeDir: home, now: new Date(2026, 9, 23, 4, 30, 0) });
		} catch (e) {
			error = e;
		} finally {
			chmodSync(join(home, "config.json"), 0o600);
		}
		// Fail-closed on purpose: the stamp must never claim a bundle that was not verified.
		expect(error).toBeInstanceOf(BackupError);
		expect((error as BackupError).code).toBe("bundle_failed");
		expect(existsSync(join(home, "backups", STAMP_FILE))).toBe(false);
		expect(dailyBackupNames(home)).toEqual([]);
		expect(tmpLeftovers(home)).toEqual([]);
	});

	test("a symlink inside sessions is archived as a link, never the target outside the home", () => {
		seedDb(home);
		const outside = mkdtempSync(join(tmpdir(), "ompbot-adv-out-"));
		try {
			writeFileSync(join(outside, "bundle-canary.txt"), "xoxb-TEST-0 secret material\n");
			mkdirSync(join(home, "sessions", "e1"), { recursive: true });
			writeFileSync(join(home, "sessions", "e1", "s.jsonl"), '{"message":{"role":"user","content":"hi"}}\n');
			symlinkSync(join(outside, "bundle-canary.txt"), join(home, "sessions", "link-to-outside"));
			writeFileSync(join(home, "config.json"), "{}\n", { mode: 0o600 });

			const result = runBackup({ homeDir: home, now: new Date(2026, 9, 23, 4, 30, 0) });
			expect(result.bundle).toBeDefined();
			const list = Bun.spawnSync(["tar", "-tzf", result.bundle as string]);
			expect(list.exitCode).toBe(0);
			const entries = list.stdout.toString();
			expect(entries).toContain("sessions/link-to-outside");
			expect(entries).not.toContain("bundle-canary");
			// Extracting yields the link itself, not a copy of the outside file.
			const extractDir = join(home, "extract-check");
			mkdirSync(extractDir);
			const extract = Bun.spawnSync(["tar", "-xzf", result.bundle as string, "-C", extractDir, "sessions"]);
			expect(extract.exitCode).toBe(0);
			expect(statSync(join(extractDir, "sessions", "link-to-outside")).size).toBe(
				statSync(join(home, "sessions", "link-to-outside")).size,
			);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("an unwritable backups dir fails as vacuum_failed, keeps the old stamp and leaves no residue", () => {
		seedDb(home);
		const first = runBackup({ homeDir: home, now: new Date(2026, 9, 23, 4, 30, 0) });
		const backupsDir = join(home, "backups");
		const stampBefore = readFileSync(join(backupsDir, STAMP_FILE), "utf8");
		lowered.push(backupsDir);
		chmodSync(backupsDir, 0o500);

		let error: unknown;
		try {
			runBackup({ homeDir: home, now: new Date(2026, 9, 24, 4, 30, 0) });
		} catch (e) {
			error = e;
		} finally {
			chmodSync(backupsDir, 0o700);
		}
		expect(error).toBeInstanceOf(BackupError);
		expect((error as BackupError).code).toBe("vacuum_failed");
		expect(readFileSync(join(backupsDir, STAMP_FILE), "utf8")).toBe(stampBefore);
		expect(dailyBackupNames(home)).toEqual([first.file.split("/").pop() as string]);
		expect(tmpLeftovers(home)).toEqual([]);
	});

	test("unusable inputs (garbage db, db that is a directory, backups that is a file) leave no stamp and no residue", async () => {
		// (a) garbage in place of the database
		writeFileSync(join(home, "ompbot.db"), "this is definitely not a sqlite file\n".repeat(200));
		expect(() => runBackup({ homeDir: home, now: new Date(2026, 9, 23, 4, 30, 0) })).toThrow();
		expect(dailyBackupNames(home)).toEqual([]);
		expect(tmpLeftovers(home)).toEqual([]);
		expect(existsSync(join(home, "backups", STAMP_FILE))).toBe(false);

		// (b) the "database" is a directory
		const homeB = join(home, "b");
		mkdirSync(join(homeB, "ompbot.db"), { recursive: true });
		expect(() => runBackup({ homeDir: homeB })).toThrow();
		expect(existsSync(join(homeB, "backups", STAMP_FILE))).toBe(false);

		// (c) backups is a regular file: the CLI must fail with a non-zero code and never claim success
		const homeC = join(home, "c");
		mkdirSync(homeC);
		seedDb(homeC);
		writeFileSync(join(homeC, "backups"), "i am a file");
		const run = await cli(["backup"], homeC);
		expect(run.code).toBe(1);
		expect(run.out).not.toContain("backup_done");
		expect(readFileSync(join(homeC, "backups"), "utf8")).toBe("i am a file");
	});

	test("a damaged source page never yields a stamped backup that silently lost rows", () => {
		const dbPath = join(home, "ompbot.db");
		const db = new Database(dbPath, { create: true, strict: true });
		db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
		db.run("BEGIN");
		for (let i = 1; i <= 3000; i++) db.run("INSERT INTO t VALUES (?, ?)", [i, `${"x".repeat(100)}-${i}`]);
		db.run("COMMIT");
		const pageSize = (db.query("PRAGMA page_size").get() as { page_size: number }).page_size;
		db.close();
		expect(statSync(dbPath).size).toBeGreaterThan(pageSize * 40);
		// Zero out four pages in the middle of the table b-tree.
		const bytes = readFileSync(dbPath);
		bytes.fill(0, pageSize * 20, pageSize * 24);
		writeFileSync(dbPath, bytes);

		let outcome: "threw" | { rows: number };
		try {
			const result = runBackup({ homeDir: home, now: new Date(2026, 9, 23, 4, 30, 0) });
			const copy = new Database(result.file, { readonly: true, strict: true });
			outcome = { rows: (copy.query("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n };
			copy.close();
		} catch {
			outcome = "threw";
		}
		if (outcome === "threw") {
			expect(existsSync(join(home, "backups", STAMP_FILE))).toBe(false);
			expect(dailyBackupNames(home)).toEqual([]);
		} else {
			expect(outcome.rows).toBe(3000);
		}
	});

	test("a database cut mid-file is rejected or complete, never stamped as a partial success", () => {
		const dbPath = join(home, "ompbot.db");
		const db = new Database(dbPath, { create: true, strict: true });
		db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
		db.run("BEGIN");
		for (let i = 1; i <= 3000; i++) db.run("INSERT INTO t VALUES (?, ?)", [i, `${"y".repeat(100)}-${i}`]);
		db.run("COMMIT");
		const pageSize = (db.query("PRAGMA page_size").get() as { page_size: number }).page_size;
		db.close();
		truncateSync(dbPath, pageSize * 25);

		let outcome: "threw" | number;
		try {
			const result = runBackup({ homeDir: home, now: new Date(2026, 9, 23, 4, 30, 0) });
			const copy = new Database(result.file, { readonly: true, strict: true });
			outcome = (copy.query("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n;
			copy.close();
		} catch {
			outcome = "threw";
		}
		if (outcome === "threw") {
			expect(existsSync(join(home, "backups", STAMP_FILE))).toBe(false);
		} else {
			expect(outcome).toBe(3000);
		}
	});

	test("a snapshot spanning several hash chunks hashes identically to an independent sha256", () => {
		const dbPath = join(home, "ompbot.db");
		const db = new Database(dbPath, { create: true, strict: true });
		db.run("CREATE TABLE t (n INTEGER PRIMARY KEY, v TEXT NOT NULL)");
		db.run("BEGIN");
		for (let i = 1; i <= 25_000; i++) db.run("INSERT INTO t VALUES (?, ?)", [i, `${"c".repeat(120)}-${i}`]);
		db.run("COMMIT");
		db.close();

		const result = runBackup({ homeDir: home, now: new Date(2026, 9, 23, 4, 30, 0) });
		// Larger than one 1 MiB hash chunk and not chunk-aligned, so both a mid-stream boundary and a short final
		// chunk are exercised; the reported and stamped digests must equal a whole-file hash of the snapshot.
		expect(statSync(result.file).size).toBeGreaterThan(2 * 1024 * 1024);
		const independent = createHash("sha256").update(readFileSync(result.file)).digest("hex");
		expect(result.sha256).toBe(independent);
		expect(readStamp(join(home, "backups"))?.sha256).toBe(independent);
	});

	test("CLI --keep rejects empty/blank/negative/fractional/non-numeric values and accepts a plain integer", async () => {
		const bad: string[] = [];
		const values = ["", " ", "-1", "1.5", "abc", "NaN", "Infinity"];
		for (const [i, value] of values.entries()) {
			const dir = join(home, `h${i}`);
			mkdirSync(dir);
			seedDb(dir);
			// "--keep -1" is rejected earlier by parseArgs (exit 1); the "=" form reaches the range check.
			const run = await cli(["backup", `--keep=${value}`], dir);
			if (run.code !== 2) bad.push(`${JSON.stringify(value)} -> exit ${run.code}`);
		}
		expect(bad).toEqual([]);

		const ok = join(home, "ok");
		mkdirSync(ok);
		seedDb(ok);
		const run = await cli(["backup", "--keep=3"], ok);
		expect(run.code).toBe(0);
		expect(run.out).toMatch(/backup_done kept=1 removed=0 stamp=/);
		const missing = await cli(["backup"], join(home, "nowhere"));
		expect(missing.code).toBe(1);
		expect(missing.err).toContain("db_missing");
	});
});

describe("pruneBackups direct", () => {
	test("keep=1 removes every other daily and never the protected path", () => {
		const dir = join(home, "backups");
		mkdirSync(dir);
		for (const name of ["ompbot-20261020-000000.db", "ompbot-20261021-000000.db", "ompbot-20261022-000000.db"]) {
			writeFileSync(join(dir, name), "x");
		}
		const protect = join(dir, "ompbot-20261020-000000.db"); // deliberately the OLDEST name
		const removed = pruneBackups(dir, 1, protect);
		expect(removed.map((p) => p.split("/").pop())).toEqual(["ompbot-20261022-000000.db", "ompbot-20261021-000000.db"]);
		expect(existsSync(protect)).toBe(true);
	});
});

// ===================================================================================================
// stamp + gates
// ===================================================================================================

describe("readStamp adversarial", () => {
	test("hostile stamp contents never throw and always yield a usable Date or undefined", () => {
		const backupsDir = join(home, "backups");
		mkdirSync(backupsDir);
		const stampPath = join(backupsDir, STAMP_FILE);
		const variants: Array<[string, string | Buffer]> = [
			["empty", ""],
			["binary", Buffer.from([0, 255, 254, 0, 61, 61, 0])],
			["crlf", "ts=2026-10-23T04:30:00.000Z\r\nfile=a.db\r\nbytes=12\r\n"],
			["bad-ts", "ts=not-a-date file=x"],
			["dup-ts", "ts=2000-01-01T00:00:00Z ts=2026-10-23T04:30:00Z"],
			["equals-only", "= =x ts"],
			["korean", "ts=2026-10-23T04:30:00.000Z file=백업.db bytes=1"],
			["huge", `ts=2026-10-23T04:30:00.000Z ${"k=v ".repeat(100_000)}`],
		];
		for (const [label, content] of variants) {
			writeFileSync(stampPath, content);
			const info = readStamp(backupsDir);
			expect(info, label).toBeDefined();
			expect(Number.isNaN(info?.ts.getTime()), label).toBe(false);
		}
		writeFileSync(stampPath, "ts=2026-10-23T04:30:00.000Z file=백업.db bytes=12 sha256=ab");
		expect(readStamp(backupsDir)?.file).toBe("백업.db");

		// Not a regular file at all.
		rmSync(stampPath);
		mkdirSync(stampPath);
		expect(readStamp(backupsDir)).toBeUndefined();
		rmSync(stampPath, { recursive: true });
		symlinkSync(join(home, "does-not-exist"), stampPath);
		expect(readStamp(backupsDir)).toBeUndefined();
	});

	test("a stamp dated far in the future cannot keep backup_age closed", () => {
		const now = Math.floor(Date.now() / 1000) * 1000;
		// Real age is 40 days: the stamp's mtime is old, but its ts claims a year ahead (clock jump / corruption).
		writeStampAt(home, new Date(now + 400 * 86_400_000), new Date(now - 40 * 86_400_000));
		seedLedger(home);
		expect(gateOf(home, now, "backup_age").state).toBe("open");
	});
});

describe("collectGates adversarial", () => {
	test("every gate threshold is exact: open at the boundary (or just past it), closed on the other side", () => {
		const now = Math.floor(Date.now() / 1000) * 1000;
		const cases: Array<{
			gate: string;
			seed: (db: Database, at: number) => void;
			openAt: number;
			closedAt: number;
		}> = [
			{
				gate: "inbound_starved",
				seed: (db, at) =>
					db.run(
						"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at, last_event_at) VALUES ('C:1', 'o', 1, 't', 'dispatched', 0, ?, ?)",
						[now - 3_600_000, at],
					),
				openAt: now - INBOUND_STARVATION_MS,
				closedAt: now - INBOUND_STARVATION_MS + 1,
			},
			{
				gate: "deliveries_overdue",
				seed: (db, at) =>
					db.run(
						"INSERT INTO deliveries (origin_key, op_ref, part, thread_ref, body, state, next_at, created_at) VALUES ('o', 'op', 0, 't', 'b', 'inflight', ?, 0)",
						[at],
					),
				openAt: now - DELIVERY_OVERDUE_MS,
				closedAt: now - DELIVERY_OVERDUE_MS + 1,
			},
			{
				gate: "lanes_stuck",
				seed: (db, at) =>
					db.run("INSERT INTO lanes (name, status, created_at, updated_at) VALUES ('l', 'working', 0, ?)", [at]),
				openAt: now - LANE_STUCK_MS,
				closedAt: now - LANE_STUCK_MS + 1,
			},
			{
				// The failure window is exclusive (`updated_at > now - 24h`): the boundary itself is already outside.
				gate: "monitors_failed",
				seed: (db, at) => {
					db.run("INSERT INTO monitors (id, name, enabled, created_at, updated_at) VALUES ('m', 'n', 1, 0, 0)");
					db.run(
						"INSERT INTO monitor_events (monitor_id, slot_at, stage, created_at, updated_at) VALUES ('m', 0, 'failed_no_retry', 0, ?)",
						[at],
					);
				},
				openAt: now - MONITOR_FAILURE_WINDOW_MS + 1,
				closedAt: now - MONITOR_FAILURE_WINDOW_MS,
			},
		];
		const wrong: string[] = [];
		for (const c of cases) {
			resetLedger();
			writeStampAt(home, new Date(now));
			seedLedger(home, (db) => c.seed(db, c.openAt));
			if (gateOf(home, now, c.gate).state !== "open") wrong.push(`${c.gate}@open-edge`);
			resetLedger();
			seedLedger(home, (db) => c.seed(db, c.closedAt));
			if (gateOf(home, now, c.gate).state !== "closed") wrong.push(`${c.gate}@closed-edge`);
		}
		resetLedger();
		writeStampAt(home, new Date(now - BACKUP_MAX_AGE_MS));
		if (gateOf(home, now, "backup_age").state !== "closed") wrong.push("backup_age@exactly-36h");
		writeStampAt(home, new Date(now - BACKUP_MAX_AGE_MS - 1));
		if (gateOf(home, now, "backup_age").state !== "open") wrong.push("backup_age@36h+1ms");
		expect(wrong).toEqual([]);
	});

	test("lanes_stuck ages from the lane's last history event, not from status-message redraws", () => {
		const now = Math.floor(Date.now() / 1000) * 1000;
		const old = now - LANE_STUCK_MS - 1;
		// The shared DDL is the pre-history lanes table; the real ledger has the column.
		const lane = (history: unknown, updatedAt: number) => (db: Database) => {
			db.run("ALTER TABLE lanes ADD COLUMN history TEXT");
			db.run("INSERT INTO lanes (name, status, history, created_at, updated_at) VALUES ('l', 'working', ?, 0, ?)", [
				JSON.stringify(history),
				updatedAt,
			]);
		};
		writeStampAt(home, new Date(now));
		// A redraw just touched updated_at, but nothing happened in the lane for over 24h: stuck.
		const quiet = [
			{ at: 0, event: "created" },
			{ at: old, event: "progress" },
		];
		seedLedger(home, lane(quiet, now));
		expect(gateOf(home, now, "lanes_stuck").state).toBe("open");
		// The newest entry is recent (an owner reply): not stuck, whatever updated_at says.
		resetLedger();
		const active = [
			{ at: old, event: "created" },
			{ at: now - 60_000, event: "owner_reply" },
		];
		seedLedger(home, lane(active, old));
		expect(gateOf(home, now, "lanes_stuck").state).toBe("closed");
		// No history entries: falls back to updated_at.
		resetLedger();
		seedLedger(home, lane([], old));
		expect(gateOf(home, now, "lanes_stuck").state).toBe("open");
	});

	test("NULL columns, disabled/orphan monitors, duplicate failures and pre-migration schemas are handled", () => {
		const now = Math.floor(Date.now() / 1000) * 1000;
		writeStampAt(home, new Date(now));
		const old = now - 3_600_000;
		seedLedger(home, (db) => {
			const ins =
				"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at, last_event_at) VALUES (?, 'o', 1, 't', 'dispatched', 0, ?, ?)";
			db.run(ins, ["null-dispatched", null, old]); // documented exemption: never dispatched, nothing to starve
			db.run(ins, ["null-event", old, null]); // falls back to dispatched_at
			db.run("INSERT INTO monitors (id, name, enabled, created_at, updated_at) VALUES ('off', 'off', 0, 0, 0)");
			db.run("INSERT INTO monitors (id, name, enabled, created_at, updated_at) VALUES ('on', 'on', 1, 0, 0)");
			const ev =
				"INSERT INTO monitor_events (monitor_id, slot_at, stage, created_at, updated_at) VALUES (?, ?, 'failed_no_retry', 0, ?)";
			db.run(ev, ["off", 1, now - 1000]); // disabled monitor
			db.run(ev, ["ghost", 1, now - 1000]); // monitor row deleted (orphan event)
			db.run(ev, ["on", 1, now - 1000]);
			db.run(ev, ["on", 2, now - 2000]); // same monitor twice counts once
			db.run(ev, ["on", 3, now - 3000]);
		});
		expect(gateOf(home, now, "inbound_starved")).toEqual({ state: "open", detail: "silent_old=1" });
		expect(gateOf(home, now, "monitors_failed")).toEqual({ state: "open", detail: "failed_recent=1" });

		// A pre-migration ledger: no last_event_at column, no lanes/monitors tables.
		resetLedger();
		const db = new Database(join(home, "ompbot.db"), { create: true, strict: true });
		db.run("CREATE TABLE inbound (platform_message_id TEXT, state TEXT, dispatched_at INTEGER)");
		db.run("CREATE TABLE deliveries (state TEXT, next_at INTEGER)");
		db.run("INSERT INTO inbound VALUES ('x', 'dispatched', ?)", [old]);
		db.close();
		// Host resources injected calm, so only the ledger decides the states below.
		const calm = { loadavg: () => [0, 0, 0], cpuCount: () => 4, meminfo: () => undefined };
		const byName = Object.fromEntries(
			collectGates({ homeDir: home, now, diskPaths: [], hostLoad: calm }).map((g) => [g.name, g.state]),
		);
		expect(byName).toEqual({
			backup_age: "closed",
			sweep_stalled: "unknown", // no heartbeat stamp: nothing to judge
			inbound_starved: "open",
			origin_silent: "closed", // a pre-migration inbound table has no origin_key/created_at columns
			deliveries_overdue: "closed",
			lanes_stuck: "closed",
			slack_disconnected: "unknown", // no heartbeat stamp: nothing to judge
			frozen: "closed",
			disk_low: "closed", // diskPaths: [] reads statfs=unavailable
			host_pressure: "closed",
			monitors_failed: "closed",
			monitors_stalled: "closed", // no heartbeat stamp: cannot tell a drain from a stall
			turns_failing: "closed", // a pre-migration deliveries table has no body/created_at columns
		});
	});

	test("a ledger that is empty, unmigrated or corrupt is reported, not thrown", () => {
		const now = Math.floor(Date.now() / 1000) * 1000;
		const thrown: string[] = [];
		const variants: Array<[string, (dir: string) => void]> = [
			["zero-byte", (dir) => writeFileSync(join(dir, "ompbot.db"), "")],
			[
				"no-inbound-table",
				(dir) => {
					const db = new Database(join(dir, "ompbot.db"), { create: true, strict: true });
					db.run("CREATE TABLE unrelated (x INTEGER)");
					db.close();
				},
			],
			["garbage", (dir) => writeFileSync(join(dir, "ompbot.db"), "not a database at all\n".repeat(500))],
		];
		for (const [label, make] of variants) {
			const dir = join(home, label);
			mkdirSync(dir);
			writeStampAt(dir, new Date(now));
			make(dir);
			try {
				collectGates({ homeDir: dir, now });
			} catch (error) {
				thrown.push(`${label}: ${String(error).slice(0, 80)}`);
			}
		}
		expect(thrown).toEqual([]);
	});

	test("an uncommitted writer does not block or leak into gates; WAL-only rows of a crashed daemon are visible", () => {
		const now = Math.floor(Date.now() / 1000) * 1000;
		writeStampAt(home, new Date(now));
		const dbPath = join(home, "ompbot.db");
		const writer = new Database(dbPath, { create: true, strict: true });
		writer.run("PRAGMA journal_mode=WAL");
		writer.run("PRAGMA wal_autocheckpoint=0");
		writer.run(DDL);
		const stale =
			"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at) VALUES ('C:1', 'o', 1, 't', 'dispatched', 0, ?)";
		writer.run("BEGIN IMMEDIATE");
		writer.run(stale, [now - 3_600_000]);
		try {
			expect(gateOf(home, now, "inbound_starved")).toEqual({ state: "closed", detail: "silent_old=0" });
		} finally {
			writer.run("COMMIT");
		}
		expect(gateOf(home, now, "inbound_starved")).toEqual({ state: "open", detail: "silent_old=1" });

		// Crash snapshot: main file + WAL copied while the daemon connection is still open, no -shm.
		const crash = join(home, "crash");
		mkdirSync(crash);
		copyFileSync(dbPath, join(crash, "ompbot.db"));
		copyFileSync(`${dbPath}-wal`, join(crash, "ompbot.db-wal"));
		writer.close();
		writeStampAt(crash, new Date(now));
		expect(existsSync(join(crash, "ompbot.db-shm"))).toBe(false);
		expect(gateOf(crash, now, "inbound_starved")).toEqual({ state: "open", detail: "silent_old=1" });
	});

	test("CLI gates: exit code, grep-able last line and --json agree for stale and healthy homes", async () => {
		const now = Date.now();
		writeStampAt(home, new Date(now - 37 * 3_600_000));
		seedLedger(home);
		const stale = await cli(["gates"], home);
		expect(stale.code).toBe(1);
		const lines = stale.out.trimEnd().split("\n");
		expect(lines).toHaveLength(14);
		// No heartbeat stamp in this home: the two heartbeat gates are unknown and named on the last line too.
		expect(lines[lines.length - 1]).toMatch(
			/^gates_done open=1 unknown=2 total=13 opened=backup_age\(hours=3[78]\.\d\) unknown_gates=sweep_stalled,slack_disconnected$/,
		);
		const json = await cli(["gates", "--json"], home);
		expect(json.code).toBe(1);
		const parsed = JSON.parse(json.out) as {
			open: number;
			unknown: number;
			gates: Array<{ name: string; state: string }>;
		};
		expect(parsed.open).toBe(1);
		expect(parsed.unknown).toBe(2);
		expect(parsed.gates.map((g) => g.name)).toEqual([
			"backup_age",
			"sweep_stalled",
			"slack_disconnected",
			"frozen",
			"disk_low",
			"host_pressure",
			"inbound_starved",
			"origin_silent",
			"deliveries_overdue",
			"lanes_stuck",
			"monitors_failed",
			"monitors_stalled",
			"turns_failing",
		]);

		writeStampAt(home, new Date(now));
		const healthy = await cli(["gates"], home);
		expect(healthy.code).toBe(0);
		expect(healthy.out.trimEnd().split("\n").pop()).toBe(
			"gates_done open=0 unknown=2 total=13 unknown_gates=sweep_stalled,slack_disconnected",
		);
	});
});

// ===================================================================================================
// media
// ===================================================================================================

function put(path: string, mtimeMs: number, content = "x"): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
	utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}

describe("pruneMediaFiles adversarial", () => {
	const now = Math.floor(Date.now() / 1000) * 1000;
	const old = now - MEDIA_MAX_AGE_MS - 60_000;

	test("nested tree: stale files go, emptied dirs collapse bottom-up, mixed dirs stay, second pass is a no-op", () => {
		const root = join(home, "media");
		put(join(root, "inbound", "1_1", "old.png"), old);
		put(join(root, "inbound", "1_1", "fresh.png"), now - 1000);
		put(join(root, "inbound", "2_2", "old.txt"), old);
		put(join(root, "inbound", "3_3", "deep", "deeper", "old.bin"), old);
		put(join(root, "top-old.txt"), old);
		put(join(root, "한글 폴더", "사진 🙂.png"), old);
		mkdirSync(join(root, "inbound", "4_4"));
		utimesSync(join(root, "inbound", "4_4"), old / 1000, old / 1000);

		expect(pruneMediaFiles(root, now)).toBe(5);
		expect(existsSync(join(root, "inbound", "1_1", "fresh.png"))).toBe(true);
		expect(existsSync(join(root, "inbound", "1_1", "old.png"))).toBe(false);
		for (const gone of ["2_2", "3_3", "4_4"]) expect(existsSync(join(root, "inbound", gone))).toBe(false);
		expect(existsSync(join(root, "한글 폴더"))).toBe(false);
		expect(existsSync(join(root, "top-old.txt"))).toBe(false);
		expect(existsSync(root)).toBe(true);
		expect(pruneMediaFiles(root, now)).toBe(0);
	});

	test("age boundary is strict, future mtimes are kept, maxAge=0 spares only files not older than now", () => {
		const root = join(home, "media");
		const cutoff = now - MEDIA_MAX_AGE_MS;
		put(join(root, "at-cutoff"), cutoff);
		put(join(root, "one-second-older"), cutoff - 1000);
		put(join(root, "future"), now + 86_400_000);
		expect(pruneMediaFiles(root, now)).toBe(1);
		expect(existsSync(join(root, "at-cutoff"))).toBe(true);
		expect(existsSync(join(root, "one-second-older"))).toBe(false);
		expect(existsSync(join(root, "future"))).toBe(true);

		put(join(root, "just-before"), now - 1000);
		put(join(root, "exactly-now"), now);
		// at-cutoff and just-before are older than now; exactly-now and future are not.
		expect(pruneMediaFiles(root, now, 0)).toBe(2);
		expect(existsSync(join(root, "exactly-now"))).toBe(true);
		expect(existsSync(join(root, "future"))).toBe(true);
		expect(existsSync(join(root, "just-before"))).toBe(false);
	});

	test("missing root, root that is a file and an empty root are all quiet no-ops", () => {
		expect(pruneMediaFiles(join(home, "nope"), now)).toBe(0);
		writeFileSync(join(home, "file-root"), "x");
		expect(pruneMediaFiles(join(home, "file-root"), now)).toBe(0);
		mkdirSync(join(home, "empty-root"));
		expect(pruneMediaFiles(join(home, "empty-root"), now)).toBe(0);
		expect(existsSync(join(home, "empty-root"))).toBe(true);
	});

	test("symlinks are unlinked, never followed: targets outside the media root survive", () => {
		const outside = join(home, "outside");
		put(join(outside, "precious.txt"), old);
		put(join(outside, "nested", "also-precious.txt"), old);
		const root = join(home, "media");
		mkdirSync(root);
		symlinkSync(outside, join(root, "link-to-dir"));
		symlinkSync(join(outside, "precious.txt"), join(root, "link-to-file"));
		symlinkSync(root, join(root, "loop")); // would recurse forever if followed
		pruneMediaFiles(root, now);
		expect(existsSync(join(outside, "precious.txt"))).toBe(true);
		expect(existsSync(join(outside, "nested", "also-precious.txt"))).toBe(true);
	});

	test("an old dangling symlink is eventually removed instead of accumulating forever", () => {
		const root = join(home, "media");
		mkdirSync(root);
		const link = join(root, "dangling");
		symlinkSync(join(home, "gone-target"), link);
		lutimesSync(link, old / 1000, old / 1000);
		pruneMediaFiles(root, now);
		// existsSync follows the link, so list the directory instead.
		expect(readdirSync(root)).not.toContain("dangling");
	});

	test("one unreadable subdirectory must not abort pruning of the rest", () => {
		const root = join(home, "media");
		put(join(root, "good", "old.txt"), old);
		put(join(root, "other", "old.txt"), old);
		const bad = join(root, "bad");
		mkdirSync(bad);
		lowered.push(bad);
		chmodSync(bad, 0o000);
		let removed = -1;
		let thrown: unknown;
		try {
			removed = pruneMediaFiles(root, now);
		} catch (error) {
			thrown = error;
		} finally {
			chmodSync(bad, 0o700);
		}
		expect(thrown).toBeUndefined();
		expect(removed).toBe(2);
		expect(existsSync(join(root, "good"))).toBe(false);
		expect(existsSync(join(root, "other"))).toBe(false);
	});

	test("a just-created empty directory (download about to write into it) is not swept", () => {
		const root = join(home, "media");
		const fresh = join(root, "inbound", "1700000000_000100");
		mkdirSync(fresh, { recursive: true });
		const stale = join(root, "inbound", "1600000000_000100");
		mkdirSync(stale);
		utimesSync(stale, old / 1000, old / 1000);
		pruneMediaFiles(root, Date.now());
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
	});
});
