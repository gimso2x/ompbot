import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { seedDb } from "./helpers/backup-fixtures";
import { makeHome, type TestHome } from "./helpers/bot-home";
import { runBounded } from "./helpers/bounded-child";
import { killSpawned, runMain } from "./helpers/daemon-process";

const homes: TestHome[] = [];
afterEach(() => {
	killSpawned();
	for (const h of homes.splice(0)) h.remove();
});

function home(): TestHome {
	const h = makeHome("status-qa-i-");
	homes.push(h);
	return h;
}

describe("status (qa-i low)", () => {
	test("a FIFO in the place of ompbot.db reports ledger_unreadable instead of blocking", async () => {
		const h = home();
		const db = join(h.dir, "ompbot.db");
		expect(Bun.spawnSync(["mkfifo", db]).exitCode).toBe(0);
		const src = join(import.meta.dir, "..", "src");
		const result = await runBounded(
			`const { readStatusFromDb } = await import(${JSON.stringify(join(src, "daemon", "status"))});
			 const { IDLE_HOST_LOAD } = await import(${JSON.stringify(join(src, "ops", "host-resources"))});
			 const report = readStatusFromDb(${JSON.stringify(db)}, "v", "Asia/Seoul", {}, IDLE_HOST_LOAD);
			 console.log(JSON.stringify(report.openGates.map((g) => g.name)));`,
		);
		expect(result.timedOut).toBe(false);
		expect(JSON.parse(result.stdout.trim().split("\n").pop() as string)).toContain("ledger_unreadable");
	});

	test("a broken config.json still lets the database report come out", async () => {
		const h = home();
		seedDb(h.dir);
		writeFileSync(h.config.configPath, "{ not json", { mode: 0o600 });
		const result = await runMain(h.dir, ["status", "--json"]);
		expect(result.code).toBe(0);
		const report = JSON.parse(result.stdout) as { daemonRunning: boolean; ompVersion: string };
		expect(report.daemonRunning).toBe(false);
		expect(report.ompVersion).toBe("unknown");
		expect(result.stderr).toContain("config unreadable");
	});
});
