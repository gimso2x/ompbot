import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { BACKUP_FILE_PATTERN } from "../../src/ops/backup";

/** Creates `<home>/ompbot.db` in WAL mode with one table and one row, like the daemon leaves it. */
export function seedDb(homeDir: string): void {
	const db = new Database(join(homeDir, "ompbot.db"), { create: true, strict: true });
	db.run("PRAGMA journal_mode=WAL");
	db.run("CREATE TABLE origins (origin_key TEXT PRIMARY KEY, epoch INTEGER NOT NULL)");
	db.run("INSERT INTO origins VALUES ('slack/dm/D1', 1)");
	db.close();
}

/** Sorted names of the daily backup files in `<home>/backups`. */
export function dailyBackupNames(homeDir: string): string[] {
	return readdirSync(join(homeDir, "backups"))
		.filter((name) => BACKUP_FILE_PATTERN.test(name))
		.sort();
}
