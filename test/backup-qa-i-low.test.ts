import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBackup, STAMP_FILE } from "../src/ops/backup";
import { dailyBackupNames, seedDb } from "./helpers/backup-fixtures";
import { runBounded } from "./helpers/bounded-child";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ompbot-backup-qa-i-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("backup (qa-i low)", () => {
	test("a FIFO in the place of the stamp reads as no stamp instead of blocking", async () => {
		mkdirSync(join(home, "backups"));
		expect(Bun.spawnSync(["mkfifo", join(home, "backups", STAMP_FILE)]).exitCode).toBe(0);
		const backupModule = join(import.meta.dir, "..", "src", "ops", "backup");
		const result = await runBounded(
			`const { readStamp } = await import(${JSON.stringify(backupModule)});
			 console.log(String(readStamp(${JSON.stringify(join(home, "backups"))})));`,
		);
		expect(result.timedOut).toBe(false);
		expect(result.stdout.trim()).toBe("undefined");
	});

	test("a failed stamp write leaves no database copy behind", () => {
		seedDb(home);
		mkdirSync(join(home, "backups", STAMP_FILE), { recursive: true });
		expect(() => runBackup({ homeDir: home, now: new Date(2026, 9, 23, 4, 30, 0) })).toThrow();
		expect(dailyBackupNames(home)).toEqual([]);
	});

	test("a source link into another plain source is refused, not archived under two names", () => {
		seedDb(home);
		mkdirSync(join(home, "workspace"));
		writeFileSync(join(home, "workspace", "note.md"), "x\n");
		symlinkSync(join(home, "workspace"), join(home, "sessions"));
		expect(() => runBackup({ homeDir: home, now: new Date(2026, 9, 23, 4, 30, 0) })).toThrow(/overlapping/);
		expect(dailyBackupNames(home)).toEqual([]);
	});
});
