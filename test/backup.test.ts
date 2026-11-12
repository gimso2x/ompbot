import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUP_FILE_PATTERN, BUNDLE_FILE_PATTERN, readStamp, runBackup, STAMP_FILE } from "../src/ops/backup";
import { dailyBackupNames, seedDb } from "./helpers/backup-fixtures";

const sha256OfFile = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ompbot-backup-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("runBackup", () => {
	test("writes a verified daily backup, a stamp, and keeps WAL mode untouched", () => {
		seedDb(home);
		const result = runBackup({ homeDir: home, now: new Date(2026, 9, 23, 4, 30, 0) });

		expect(result.file.endsWith("ompbot-20261023-043000.db")).toBe(true);
		expect(existsSync(result.file)).toBe(true);
		expect(result.bytes).toBeGreaterThan(0);
		expect(existsSync(`${result.file}-wal`)).toBe(false);
		expect(existsSync(`${result.file}-shm`)).toBe(false);
		expect(result.removed).toEqual([]);
		// The copy holds the seeded row.
		const copy = new Database(result.file, { readonly: true, strict: true });
		const row = copy.query("SELECT epoch FROM origins WHERE origin_key = 'slack/dm/D1'").get() as { epoch: number };
		copy.close();
		expect(row.epoch).toBe(1);

		const stamp = readStamp(join(home, "backups"));
		expect(stamp).toBeDefined();
		expect(stamp?.file).toBe("ompbot-20261023-043000.db");
		expect(stamp?.bytes).toBe(result.bytes);
		expect(stamp?.sha256).toBe(result.sha256);
	});

	test("refuses to overwrite an existing target and cleans up temp files", () => {
		seedDb(home);
		const now = new Date(2026, 9, 23, 4, 30, 0);
		runBackup({ homeDir: home, now });
		expect(() => runBackup({ homeDir: home, now })).toThrow(/target_exists/);
		const leftovers = readdirSync(join(home, "backups")).filter((name) => name.includes(".tmp-"));
		expect(leftovers).toEqual([]);
	});

	test("fails without a stamp when the database is missing", () => {
		expect(() => runBackup({ homeDir: home })).toThrow(/db_missing/);
		expect(existsSync(join(home, "backups", STAMP_FILE))).toBe(false);
	});

	test("prunes only timestamped daily files past --keep, never the stamp or other names", () => {
		seedDb(home);
		const backupsDir = join(home, "backups");
		mkdirSync(backupsDir, { recursive: true });
		// Five old daily backups: names sort chronologically.
		const dailies = [
			"ompbot-20261020-043000.db",
			"ompbot-20261021-043000.db",
			"ompbot-20261022-043000.db",
			"ompbot-20261023-043000.db",
			"ompbot-20261024-043000.db",
		];
		for (const name of dailies) writeFileSync(join(backupsDir, name), "x");
		// Files the prune pattern must never touch.
		writeFileSync(join(backupsDir, "ompbot-pre-upgrade-20261019T000000Z.db"), "x");
		writeFileSync(join(backupsDir, "config.json.bak-20261020"), "x");
		writeFileSync(join(backupsDir, STAMP_FILE), "ts=old\n");

		const result = runBackup({ homeDir: home, keep: 2, now: new Date(2026, 9, 25, 4, 30, 0) });

		// keep=2: the new backup plus the newest old one survive.
		expect(dailyBackupNames(home)).toEqual(["ompbot-20261024-043000.db", "ompbot-20261025-043000.db"]);
		expect(existsSync(join(backupsDir, "ompbot-pre-upgrade-20261019T000000Z.db"))).toBe(true);
		expect(existsSync(join(backupsDir, "config.json.bak-20261020"))).toBe(true);
		expect(result.removed).toHaveLength(4);
		// The stamp was overwritten by the new successful backup, not left at "ts=old".
		expect(readStamp(backupsDir)?.file).toBe("ompbot-20261025-043000.db");
	});

	test("keep=0 disables pruning", () => {
		seedDb(home);
		const backupsDir = join(home, "backups");
		mkdirSync(backupsDir, { recursive: true });
		writeFileSync(join(backupsDir, "ompbot-20260101-000000.db"), "x");
		runBackup({ homeDir: home, keep: 0, now: new Date(2026, 9, 23, 4, 30, 0) });
		expect(dailyBackupNames(home)).toEqual(["ompbot-20260101-000000.db", "ompbot-20261023-043000.db"]);
	});

	test("stamp content is grep-stable and the mtime fallback parses", () => {
		seedDb(home);
		const result = runBackup({ homeDir: home, now: new Date(2026, 9, 23, 4, 30, 0) });
		const text = readFileSync(join(home, "backups", STAMP_FILE), "utf8");
		expect(text).toContain(`file=ompbot-20261023-043000.db`);
		expect(text).toContain(`sha256=${result.sha256}`);
		expect(text).toContain("integrity=ok");
		expect(readStamp(join(home, "backups"))?.ts.getTime()).toBeGreaterThan(0);
	});
});

describe("backup bundle (sessions + config.json)", () => {
	/** A home that looks lived-in: a session file, a config, and a secret that must never be bundled. */
	function seedSources(): void {
		mkdirSync(join(home, "sessions", "slack-dm-D1", "e1"), { recursive: true });
		writeFileSync(
			join(home, "sessions", "slack-dm-D1", "e1", "s.jsonl"),
			'{"message":{"role":"user","content":"안녕"}}\n',
		);
		writeFileSync(join(home, "config.json"), '{"schemaVersion":1}\n', { mode: 0o600 });
		mkdirSync(join(home, "secrets"), { recursive: true });
		writeFileSync(join(home, "secrets", "slack-bot-token"), "xoxb-TEST-0\n", { mode: 0o600 });
	}

	/**
	 * A `tar` that does the real work, then — for the create call only — prints `stderr` and exits 1, like GNU tar
	 * does when a session file grows while it is archived.
	 */
	function warningTar(stderr: string): string {
		const realTar = Bun.which("tar");
		if (realTar === null) throw new Error("tar not on PATH");
		const bin = join(home, "fake-bin");
		mkdirSync(bin);
		const script = join(bin, "tar");
		writeFileSync(
			script,
			`#!/bin/sh\n"${realTar}" "$@" || exit $?\nif [ "$1" = "-czf" ]; then printf '%s\\n' '${stderr}' >&2; exit 1; fi\n`,
			{ mode: 0o755 },
		);
		return script;
	}

	test("tar exit 1 with only 'file changed as we read it' still yields a verified bundle", () => {
		seedDb(home);
		seedSources();
		const result = runBackup({
			homeDir: home,
			now: new Date(2026, 9, 23, 4, 30, 0),
			tarBin: warningTar("tar: sessions/slack-dm-D1/e1/s.jsonl: file changed as we read it"),
		});
		expect(existsSync(result.bundle as string)).toBe(true);
		expect(readStamp(join(home, "backups"))?.bundle).toBe("ompbot-bundle-20261023-043000.tar.gz");
	});

	test("tar exit 1 with any other message fails the whole backup", () => {
		seedDb(home);
		seedSources();
		const tarBin = warningTar("tar: sessions/slack-dm-D1/e1/s.jsonl: Cannot open: Permission denied");
		expect(() => runBackup({ homeDir: home, now: new Date(2026, 9, 23, 4, 30, 0), tarBin })).toThrow(/bundle_failed/);
		expect(readStamp(join(home, "backups"))).toBeUndefined();
	});

	test("a verified tar.gz lands next to the db and the stamp records its name and sha256", () => {
		seedDb(home);
		seedSources();
		const result = runBackup({ homeDir: home, now: new Date(2026, 9, 23, 4, 30, 0) });

		expect(result.bundle?.endsWith("ompbot-bundle-20261023-043000.tar.gz")).toBe(true);
		expect(existsSync(result.bundle as string)).toBe(true);
		expect(result.bundleBytes).toBeGreaterThan(0);
		expect(result.bundleSha256).toBe(sha256OfFile(result.bundle as string));

		const stamp = readStamp(join(home, "backups"));
		expect(stamp?.bundle).toBe("ompbot-bundle-20261023-043000.tar.gz");
		expect(stamp?.bundleSha256).toBe(result.bundleSha256);
		expect(readFileSync(join(home, "backups", STAMP_FILE), "utf8")).toContain("bundle=");

		// The archive holds the session original and the config, and never the secrets directory.
		const list = Bun.spawnSync(["tar", "-tzf", result.bundle as string]);
		expect(list.exitCode).toBe(0);
		const entries = list.stdout.toString().split("\n");
		expect(entries.some((e) => e === "config.json")).toBe(true);
		expect(entries.some((e) => e.startsWith("sessions/") && e.endsWith("s.jsonl"))).toBe(true);
		expect(entries.some((e) => e.startsWith("secrets"))).toBe(false);
	});

	test("workspace/ and scripts/ are bundled; secrets/ is not; a home without scripts/ still backs up", () => {
		seedDb(home);
		seedSources();
		mkdirSync(join(home, "workspace"), { recursive: true });
		writeFileSync(join(home, "workspace", "persona.md"), "persona\n");
		mkdirSync(join(home, "scripts"), { recursive: true });
		writeFileSync(join(home, "scripts", "x.py"), "print(1)\n");
		const result = runBackup({ homeDir: home, now: new Date(2026, 9, 23, 4, 30, 0) });
		const list = Bun.spawnSync(["tar", "-tzf", result.bundle as string]);
		expect(list.exitCode).toBe(0);
		const entries = list.stdout.toString().split("\n");
		expect(entries).toContain("workspace/persona.md");
		expect(entries).toContain("scripts/x.py");
		expect(entries.some((e) => e.startsWith("secrets"))).toBe(false);

		// Same home minus scripts/: only existing sources are bundled and the backup succeeds.
		rmSync(join(home, "scripts"), { recursive: true });
		const second = runBackup({ homeDir: home, now: new Date(2026, 9, 24, 4, 30, 0) });
		const entries2 = Bun.spawnSync(["tar", "-tzf", second.bundle as string])
			.stdout.toString()
			.split("\n");
		expect(entries2).toContain("workspace/persona.md");
		expect(entries2.some((e) => e.startsWith("scripts"))).toBe(false);
	});

	describe("sessions as a symlink (B-1)", () => {
		const now = new Date(2026, 10, 11, 4, 30, 0);

		test("the link target's contents are bundled under sessions/, inner links stay links", () => {
			seedDb(home);
			writeFileSync(join(home, "config.json"), "{}\n");
			mkdirSync(join(home, "secrets"));
			writeFileSync(join(home, "secrets", "slack-bot-token"), "xoxb-TEST-0\n");
			const real = join(home, "elsewhere", "real-sessions");
			mkdirSync(join(real, "slack-dm-D1"), { recursive: true });
			writeFileSync(join(real, "slack-dm-D1", "s.jsonl"), '{"memory":true}\n');
			nodeFs.symlinkSync(join(home, "secrets", "slack-bot-token"), join(real, "inner-link"));
			nodeFs.symlinkSync(real, join(home, "sessions"));

			const result = runBackup({ homeDir: home, now });
			const entries = Bun.spawnSync(["tar", "-tzf", result.bundle as string])
				.stdout.toString()
				.split("\n");
			expect(entries).toContain("sessions/slack-dm-D1/s.jsonl");
			expect(entries).toContain("config.json");
			expect(entries.some((e) => e.includes("real-sessions") || e.startsWith("elsewhere"))).toBe(false);
			// Only the top-level link is followed: the inner link is archived as a link, never as the secret's bytes.
			const verbose = Bun.spawnSync(["tar", "-tvzf", result.bundle as string]).stdout.toString();
			const inner = verbose.split("\n").find((line) => line.includes("sessions/inner-link"));
			expect(inner?.startsWith("l")).toBe(true);
			expect(readStamp(join(home, "backups"))?.bundle).toBe("ompbot-bundle-20261111-043000.tar.gz");
		});

		test("the size cap measures the link target", () => {
			seedDb(home);
			const real = join(home, "elsewhere");
			mkdirSync(real);
			writeFileSync(join(real, "big.bin"), Buffer.alloc(64 * 1024));
			nodeFs.symlinkSync(real, join(home, "sessions"));
			expect(() => runBackup({ homeDir: home, now, maxBundleBytes: 1024 })).toThrow(/bundle_too_large/);
			expect(readStamp(join(home, "backups"))).toBeUndefined();
		});

		test("a link into secrets/, to a file, dangling or cyclic fails as bundle_failed without a stamp", () => {
			const cases: Array<[string, (link: string) => void]> = [
				[
					"secrets",
					(link) => {
						mkdirSync(join(home, "secrets", "sub"), { recursive: true });
						writeFileSync(join(home, "secrets", "sub", "t"), "xoxb-TEST-0\n");
						nodeFs.symlinkSync(join(home, "secrets", "sub"), link);
					},
				],
				[
					"file",
					(link) => {
						writeFileSync(join(home, "a-file"), "x\n");
						nodeFs.symlinkSync(join(home, "a-file"), link);
					},
				],
				[
					"around-secrets",
					(link) => {
						mkdirSync(join(home, "secrets"));
						nodeFs.symlinkSync(home, link);
					},
				],
				["dangling", (link) => nodeFs.symlinkSync(join(home, "nowhere"), link)],
				[
					"cyclic",
					(link) => {
						nodeFs.symlinkSync(join(home, "loop-b"), join(home, "loop-a"));
						nodeFs.symlinkSync(join(home, "loop-a"), join(home, "loop-b"));
						nodeFs.symlinkSync(join(home, "loop-a"), link);
					},
				],
			];
			for (const [name, setup] of cases) {
				rmSync(home, { recursive: true, force: true });
				mkdirSync(home);
				seedDb(home);
				setup(join(home, "sessions"));
				let error: unknown;
				try {
					runBackup({ homeDir: home, now });
				} catch (caught) {
					error = caught;
				}
				expect(`${name}: ${String(error)}`).toContain("bundle_failed");
				expect(readStamp(join(home, "backups"))).toBeUndefined();
				expect(readdirSync(join(home, "backups")).some((n) => BUNDLE_FILE_PATTERN.test(n))).toBe(false);
			}
		});

		test("a link to an empty directory (fresh install) still backs up", () => {
			seedDb(home);
			mkdirSync(join(home, "empty-sessions"));
			nodeFs.symlinkSync(join(home, "empty-sessions"), join(home, "sessions"));
			const result = runBackup({ homeDir: home, now });
			expect(
				Bun.spawnSync(["tar", "-tzf", result.bundle as string])
					.stdout.toString()
					.split("\n"),
			).toContain("sessions/");
		});
	});

	test("a ledger-only home (no sessions, no config.json) writes no bundle and no bundle fields", () => {
		seedDb(home);
		const result = runBackup({ homeDir: home, now: new Date(2026, 9, 23, 4, 30, 0) });
		expect(result.bundle).toBeUndefined();
		expect(readStamp(join(home, "backups"))?.bundle).toBeUndefined();
		expect(readFileSync(join(home, "backups", STAMP_FILE), "utf8")).not.toContain("bundle=");
	});

	test("sources past the size cap fail the whole backup: no stamp, no db file, no residue", () => {
		seedDb(home);
		seedSources();
		expect(() => runBackup({ homeDir: home, now: new Date(2026, 9, 23, 4, 30, 0), maxBundleBytes: 10 })).toThrow(
			/bundle_too_large/,
		);
		const backupsDir = join(home, "backups");
		expect(existsSync(join(backupsDir, STAMP_FILE))).toBe(false);
		expect(readdirSync(backupsDir).filter((name) => name.includes(".tmp-"))).toEqual([]);
		expect(readdirSync(backupsDir).some((name) => BUNDLE_FILE_PATTERN.test(name))).toBe(false);
	});

	test("a bundle rename failure after the db rename leaves no newest-mtime file behind", async () => {
		seedDb(home);
		seedSources();
		// The db rename (call 1) lands, the bundle rename (call 2) fails: the catch must remove both targets or a
		// newest-mtime db survives that a freshness check could mistake for a good backup.
		const original = { ...nodeFs };
		let renames = 0;
		await mock.module("node:fs", () => ({
			...original,
			renameSync: (from: string, to: string) => {
				renames += 1;
				if (renames === 2) throw new Error(`rename #2 failed (injected): ${from} -> ${to}`);
				return original.renameSync(from, to);
			},
		}));
		try {
			expect(() => runBackup({ homeDir: home, now: new Date(2026, 9, 23, 4, 30, 0) })).toThrow(/rename #2 failed/);
		} finally {
			await mock.module("node:fs", () => original);
		}
		const backupsDir = join(home, "backups");
		expect(existsSync(join(backupsDir, STAMP_FILE))).toBe(false);
		expect(readdirSync(backupsDir).filter((name) => name.includes(".tmp-"))).toEqual([]);
		expect(readdirSync(backupsDir).some((name) => BACKUP_FILE_PATTERN.test(name))).toBe(false);
		expect(readdirSync(backupsDir).some((name) => BUNDLE_FILE_PATTERN.test(name))).toBe(false);
	});

	test("bundles prune with the same keep policy as the db snapshots", () => {
		seedDb(home);
		seedSources();
		const backupsDir = join(home, "backups");
		mkdirSync(backupsDir, { recursive: true });
		writeFileSync(join(backupsDir, "ompbot-bundle-20200101-000000.tar.gz"), "old");
		writeFileSync(join(backupsDir, "ompbot-bundle-pre-upgrade.tar.gz"), "manual"); // not a daily name

		const result = runBackup({ homeDir: home, keep: 1, now: new Date(2026, 9, 25, 4, 30, 0) });
		const bundles = readdirSync(backupsDir)
			.filter((name) => BUNDLE_FILE_PATTERN.test(name))
			.sort();
		expect(bundles).toEqual(["ompbot-bundle-20261025-043000.tar.gz"]);
		expect(result.removed).toContain(join(backupsDir, "ompbot-bundle-20200101-000000.tar.gz"));
		expect(existsSync(join(backupsDir, "ompbot-bundle-pre-upgrade.tar.gz"))).toBe(true);
		// The daily db file of the same run is kept too.
		expect(readdirSync(backupsDir).some((name) => name === "ompbot-20261025-043000.db")).toBe(true);
	});

	test("a hard link to a secrets/ file inside a bundle source fails the backup (J-1/J-5)", () => {
		seedDb(home);
		seedSources();
		mkdirSync(join(home, "workspace"), { recursive: true });
		nodeFs.linkSync(join(home, "secrets", "slack-bot-token"), join(home, "workspace", "notes.md"));
		expect(() => runBackup({ homeDir: home, now: new Date(2026, 9, 26, 4, 30, 0) })).toThrow(
			/bundle_failed: workspace\/notes\.md is a hard link to a secrets\/ file/,
		);
		expect(readStamp(join(home, "backups"))).toBeUndefined();
		expect(readdirSync(join(home, "backups")).some((n) => BUNDLE_FILE_PATTERN.test(n))).toBe(false);

		// config.json itself hard-linked to a secret is refused too; an unrelated hard link is fine.
		rmSync(join(home, "workspace", "notes.md"));
		rmSync(join(home, "config.json"));
		nodeFs.linkSync(join(home, "secrets", "slack-bot-token"), join(home, "config.json"));
		expect(() => runBackup({ homeDir: home, now: new Date(2026, 9, 26, 4, 31, 0) })).toThrow(
			/config\.json is a hard link to a secrets\/ file/,
		);
		rmSync(join(home, "config.json"));
		writeFileSync(join(home, "workspace", "a.md"), "plain\n");
		nodeFs.linkSync(join(home, "workspace", "a.md"), join(home, "workspace", "b.md"));
		expect(runBackup({ homeDir: home, now: new Date(2026, 9, 26, 4, 32, 0) }).bundle).toBeDefined();
	});
});
