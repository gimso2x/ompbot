// Timers below are failure bounds only (the awaited signal is a log event or a file change), never fixed waits.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makeHome, type TestHome } from "./helpers/bot-home";
import { expectNoProcessesMentioning, killSpawned, runMain, spawnDaemon, TransportLog } from "./helpers/daemon-process";
import { pickE2eModel } from "./helpers/omp-model";

/**
 * Monitor E2E: a REAL omp persona session behind the real daemon process, file-backed fake Slack and a temp
 * OMPBOT_HOME with FAKE tokens. The owner DM asks for a reminder one minute ahead; the persona registers an `at`
 * monitor through the `ompbot_monitor_add` host tool, the scheduler fires it, and the owner DM gets exactly one
 * top-level `⏰` post. Costs tokens: OMPBOT_E2E_OMP=1 only.
 */
const enabled = process.env.OMPBOT_E2E_OMP === "1";
if (!enabled) console.log("[skip] monitor.e2e.test.ts: set OMPBOT_E2E_OMP=1 to run against a real omp (costs tokens)");

const OMP_EXECUTABLE = process.env.OMPBOT_OMP_EXECUTABLE ?? Bun.which("omp") ?? "omp";
// Model is picked from what the real omp offers (no tokens), so a stale default skips instead of dispatch-failing.
const picked = enabled ? await pickE2eModel(OMP_EXECUTABLE) : undefined;
if (enabled && picked?.model === undefined)
	console.log(`[skip] monitor.e2e.test.ts: ${picked?.reason ?? "no model offered"}`);
const model = picked?.model;
const REAL = model === undefined ? undefined : { ompExecutable: OMP_EXECUTABLE, model };
const ORIGIN = "slack/dm/D1";
/** Failure bound for the whole scenario after the DM was injected. */
const DEADLINE_MS = 240_000;
const SCENARIO_TIMEOUT_MS = 330_000;

let home: TestHome | undefined;

afterEach(async () => {
	killSpawned();
	if (home) await expectNoProcessesMentioning(home.dir);
	home?.remove();
	home = undefined;
});

interface MonitorSnapshot {
	id: string;
	name: string;
	trigger: { kind: string; at?: string };
	enabled: boolean;
	events: number;
}

/** Read-only look at the ledger (never opens a `Store`, which would touch the live daemon's rows). */
function readMonitors(homeDir: string): MonitorSnapshot[] {
	const db = new Database(join(homeDir, "ompbot.db"), { readonly: true, strict: true });
	try {
		const rows = db
			.query<{ id: string; name: string; trigger_json: string; enabled: number }, []>(
				"SELECT id, name, trigger_json, enabled FROM monitors ORDER BY created_at",
			)
			.all();
		const countEvents = db.query<{ n: number }, [string]>(
			"SELECT COUNT(*) AS n FROM monitor_events WHERE monitor_id = ?",
		);
		return rows.map((row) => ({
			id: row.id,
			name: row.name,
			trigger: JSON.parse(row.trigger_json),
			enabled: row.enabled === 1,
			events: countEvents.get(row.id)?.n ?? 0,
		}));
	} finally {
		db.close();
	}
}

describe.skipIf(!enabled || REAL === undefined)("monitor with a real omp", () => {
	test(
		"a DM asking for a reminder in a minute registers an at monitor that posts exactly one top-level ⏰ message",
		async () => {
			home = makeHome("ompbot-e2e-monitor-", REAL);
			const log = new TransportLog(join(home.dir, "transport.jsonl"));
			// A short sweep so a due monitor is claimed within seconds; only honoured with OMPBOT_TEST_HOOKS (set by spawnDaemon).
			const daemon = spawnDaemon(home.dir, log.path, { OMPBOT_SWEEP_MS: "2000" });
			await daemon.waitLog(/event=daemon_ready/);

			const nonce = Math.random().toString(36).slice(2, 10);
			const startedAt = Date.now();
			const remaining = (): number => Math.max(1_000, DEADLINE_MS - (Date.now() - startedAt));
			const injected = await runMain(home.dir, [
				"inject",
				"--origin",
				ORIGIN,
				"--as-owner",
				"--text",
				`1분 뒤에 "모니터 시험 ${nonce}"라고 알려줘`,
			]);
			expect(injected.code, injected.stderr).toBe(0);

			const added = await daemon.waitLog(/event=monitor_added\b/, remaining());
			const id = /\bid=(m[0-9a-f]+)/.exec(added)?.[1];
			expect(id, added).toBeDefined();
			const [monitor] = readMonitors(home.dir).filter((row) => row.id === id);
			expect(monitor?.trigger.kind).toBe("at");
			expect(monitor?.enabled).toBe(true);
			console.log(`monitor row: ${JSON.stringify(monitor)}`);

			await daemon.waitLog(new RegExp(`event=monitor_dispatch monitor=${id}\\b`), remaining());
			await log.waitFor(
				(posts) => posts.some((post) => post.text.startsWith("⏰") && post.text.includes(nonce)),
				"the ⏰ post with the nonce",
				remaining(),
			);

			// Stop waits for the delivery pump, so every post the daemon would make is in the log afterwards.
			daemon.signal("SIGTERM");
			expect(await daemon.exited).toBe(0);

			const alarms = log.posts().filter((post) => post.text.startsWith("⏰"));
			expect(alarms).toHaveLength(1);
			expect(alarms[0]?.threadTs).toBeUndefined();
			expect(alarms[0]?.text).toContain(nonce);
			console.log(`alarm post: ${JSON.stringify(alarms[0])}`);

			const [after] = readMonitors(home.dir).filter((row) => row.id === id);
			expect(after?.enabled).toBe(false);
			expect(after?.events).toBe(1);
		},
		SCENARIO_TIMEOUT_MS,
	);
});
