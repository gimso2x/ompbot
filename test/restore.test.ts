import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreCommand } from "../src/cli/restore";
import { acquireLock } from "../src/daemon/lock";
import { runBackup } from "../src/ops/backup";
import { RestoreError, runRestore } from "../src/ops/restore";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ompbot-restore-"));
	chmodSync(home, 0o700);
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

function seed(marker: string): void {
	const db = new Database(join(home, "ompbot.db"), { create: true, strict: true });
	db.run("PRAGMA journal_mode=WAL");
	db.run("CREATE TABLE IF NOT EXISTS marker (v TEXT)");
	db.run("DELETE FROM marker");
	db.query("INSERT INTO marker VALUES (?)").run(marker);
	db.close();
}

function markerOf(path: string): string | undefined {
	const db = new Database(path, { readonly: true });
	try {
		return (db.query("SELECT v FROM marker").get() as { v: string } | null)?.v;
	} finally {
		db.close();
	}
}

const noDaemon = (): Promise<unknown> => Promise.reject(new Error("ENOENT"));

/** A backup of the "good" ledger, then a live ledger that drifted on. */
function goodBackupThenDrift(): string {
	seed("good");
	const { file } = runBackup({ homeDir: home });
	seed("drifted");
	writeFileSync(join(home, "ompbot.db-wal"), "stale-wal");
	return file;
}

describe("runRestore", () => {
	test("replaces the ledger with the backup and parks the old db and sidecars in pre-restore-<stamp>", async () => {
		const file = goodBackupThenDrift();
		const result = await runRestore({ homeDir: home, source: file, yes: true, probeDaemon: noDaemon });
		expect(result.applied).toBe(true);
		expect(markerOf(join(home, "ompbot.db"))).toBe("good");
		expect(existsSync(join(home, "ompbot.db-wal"))).toBe(false);
		expect(readdirSync(result.plan.preRestoreDir).sort()).toEqual(["ompbot.db", "ompbot.db-wal"]);
		expect(markerOf(join(result.plan.preRestoreDir, "ompbot.db"))).toBe("drifted");
		expect(existsSync(join(home, "ompbot.lock"))).toBe(false); // lock released
		expect(readdirSync(home).filter((n) => n.includes(".tmp"))).toEqual([]);
	});

	test("a bare daily backup name resolves inside backups/", async () => {
		const file = goodBackupThenDrift();
		const name = file.split("/").pop() as string;
		const result = await runRestore({ homeDir: home, source: name, yes: true, probeDaemon: noDaemon });
		expect(result.plan.source).toBe(file);
		expect(markerOf(join(home, "ompbot.db"))).toBe("good");
	});

	test("without --yes nothing changes", async () => {
		const file = goodBackupThenDrift();
		const result = await runRestore({ homeDir: home, source: file, yes: false, probeDaemon: noDaemon });
		expect(result.applied).toBe(false);
		expect(markerOf(join(home, "ompbot.db"))).toBe("drifted");
		expect(existsSync(result.plan.preRestoreDir)).toBe(false);
	});

	test("refuses while a daemon answers on the socket and while the lock is held", async () => {
		const file = goodBackupThenDrift();
		await expect(
			runRestore({ homeDir: home, source: file, yes: true, probeDaemon: async () => ({ ok: true }) }),
		).rejects.toMatchObject({ code: "daemon_running" });
		const lock = acquireLock(join(home, "ompbot.lock"));
		try {
			await expect(runRestore({ homeDir: home, source: file, yes: true, probeDaemon: noDaemon })).rejects.toMatchObject(
				{
					code: "daemon_running",
				},
			);
		} finally {
			lock.release();
		}
		expect(markerOf(join(home, "ompbot.db"))).toBe("drifted");
	});

	test("a backup failing quick_check or not being a database leaves the live ledger untouched", async () => {
		goodBackupThenDrift();
		const corrupt = join(home, "corrupt.db");
		writeFileSync(corrupt, Buffer.alloc(8192, 7));
		const error = await runRestore({ homeDir: home, source: corrupt, yes: true, probeDaemon: noDaemon }).catch(
			(e) => e,
		);
		expect(error).toBeInstanceOf(RestoreError);
		expect(error.code).toBe("integrity_check_failed");
		expect(markerOf(join(home, "ompbot.db"))).toBe("drifted");
		expect(existsSync(join(home, "ompbot.db-wal"))).toBe(true);
		expect(readdirSync(home).filter((n) => n.includes(".tmp") || n.startsWith("pre-restore"))).toEqual([]);
		expect(
			existsSync(join(home, "backups"))
				? readdirSync(join(home, "backups")).some((n) => n.startsWith("pre-restore"))
				: false,
		).toBe(false);
	});

	test("a failure while installing puts the original files back", async () => {
		const file = goodBackupThenDrift();
		let renames = 0;
		const error = await runRestore({
			homeDir: home,
			source: file,
			yes: true,
			probeDaemon: noDaemon,
			rename: (from, to) => {
				renames += 1;
				if (renames === 3) throw new Error("EXDEV simulated"); // db and -wal moved, the install rename fails
				renameSync(from, to);
			},
		}).catch((e) => e);
		expect(error.code).toBe("restore_failed");
		expect(markerOf(join(home, "ompbot.db"))).toBe("drifted");
		expect(existsSync(join(home, "ompbot.db-wal"))).toBe(true);
		expect(readdirSync(home).filter((n) => n.includes(".tmp"))).toEqual([]);
	});

	test("rejects sources that are neither a daily backup name nor an absolute file", async () => {
		goodBackupThenDrift();
		for (const source of [
			"../ompbot.db",
			"ompbot.db",
			"backups/nope.db",
			"ompbot-20260101-000000.db",
			join(home, "missing.db"),
		]) {
			const error = await runRestore({ homeDir: home, source, yes: true, probeDaemon: noDaemon }).catch((e) => e);
			expect(error.code).toBe("bad_source");
		}
	});

	test("a source with a -wal beside it is refused and nothing changes", async () => {
		const file = goodBackupThenDrift();
		writeFileSync(`${file}-wal`, "pending pages");
		const error = await runRestore({ homeDir: home, source: file, yes: true, probeDaemon: noDaemon }).catch((e) => e);
		expect(error.code).toBe("bad_source");
		expect(error.message).toContain("-wal");
		expect(markerOf(join(home, "ompbot.db"))).toBe("drifted");
	});

	test("restores into a home that has no ledger yet", async () => {
		seed("good");
		const { file } = runBackup({ homeDir: home });
		rmSync(join(home, "ompbot.db"));
		rmSync(join(home, "ompbot.db-wal"), { force: true });
		rmSync(join(home, "ompbot.db-shm"), { force: true });
		mkdirSync(join(home, "backups"), { recursive: true });
		const result = await runRestore({ homeDir: home, source: file, yes: true, probeDaemon: noDaemon });
		expect(result.plan.moves).toEqual([]);
		expect(markerOf(join(home, "ompbot.db"))).toBe("good");
	});
});

describe("ompbot restore (CLI)", () => {
	test("exit codes: 2 without a path, 3 without --yes, 0 with --yes", async () => {
		const file = goodBackupThenDrift();
		expect(await restoreCommand([], home)).toBe(2);
		expect(await restoreCommand([file], home)).toBe(3);
		expect(markerOf(join(home, "ompbot.db"))).toBe("drifted");
		expect(await restoreCommand([file, "--yes"], home)).toBe(0);
		expect(markerOf(join(home, "ompbot.db"))).toBe("good");
	});
});
