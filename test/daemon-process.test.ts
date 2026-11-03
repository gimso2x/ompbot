import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeHome, type TestHome } from "./helpers/bot-home";
import { killSpawned, runMain, spawnDaemon } from "./helpers/daemon-process";

let home: TestHome;

beforeEach(() => {
	home = makeHome("ompbot-proc-");
});

afterEach(() => {
	killSpawned();
	home.remove();
});

test("real daemon process: status --json schema, second instance refused, SIGTERM stops gracefully (exit 0, lock and socket gone)", async () => {
	const transportFile = join(home.dir, "transport.jsonl");
	const daemon = spawnDaemon(home.dir, transportFile);
	await daemon.waitLog(/event=daemon_ready/);

	const status = await runMain(home.dir, ["status", "--json"]);
	expect(status.code).toBe(0);
	expect(JSON.parse(status.stdout)).toEqual({
		ompVersion: "omp-stub 0.0.0",
		daemonRunning: true,
		origins: [],
		ledger: { pending: 0, inflight: 0, confirmed: 0, ambiguous: 0, expired: 0 },
		inbound: { pending: 0, dispatched: 0, answered: 0, failed_notified: 0, discarded: 0 },
		monitors: { count: 0, next: null },
		openGates: [{ name: "backup_age", detail: "stamp=missing" }], // makeHome writes no backup stamp
	});

	const second = spawnDaemon(home.dir, transportFile);
	expect(await second.exited).toBe(1);
	await second.waitLog(/already_running/);
	expect(daemon.logs()).not.toContain("daemon_stop");

	const badInject = await runMain(home.dir, ["inject", "--origin", "ompbot/work/x", "--as-owner", "--text", "hi"]);
	expect(badInject.code).toBe(1);
	expect(badInject.stderr).toContain("inject failed");
	const noOwner = await runMain(home.dir, ["inject", "--origin", "slack/dm/D1", "--text", "hi"]);
	expect(noOwner.code).toBe(2);

	daemon.signal("SIGTERM");
	expect(await daemon.exited).toBe(0);
	await daemon.waitLog(/event=daemon_stop/);
	expect(existsSync(join(home.dir, "ompbot.lock"))).toBe(false);
	expect(existsSync(join(home.dir, "ompbot.sock"))).toBe(false);

	const after = await runMain(home.dir, ["status", "--json"]);
	expect(after.code).toBe(0);
	expect(JSON.parse(after.stdout)).toMatchObject({ daemonRunning: false });
});
