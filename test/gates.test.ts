import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GatesCommandDeps, gatesCommand } from "../src/cli/index";
import { readSweepHeartbeat, SweepHeartbeatWriter } from "../src/daemon/heartbeat";
import type { ProcessRunner, RunProcessResult } from "../src/dispatch/omp";
import { STAMP_FILE } from "../src/ops/backup";
import {
	collectGates,
	INBOUND_STARVATION_MS,
	MONITOR_OVERDUE_MS,
	ORIGIN_SILENT_MS,
	SOCKET_DOWN_MS,
	SWEEP_STALLED_MS,
} from "../src/ops/gates";
import { HERDR_HEALTH_FILE, HERDR_HEALTH_STALE_MS, HerdrHealthProbe, readHerdrHealth } from "../src/ops/herdr-health";
import { kstDay } from "../src/tasks/docs";
import { TASK_SWEEP_MS } from "../src/tasks/sweeper";

let home: string;
let now: number;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ompbot-gates-"));
	now = Date.now();
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

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

function seedDb(mutate: (db: Database) => void): void {
	const db = new Database(join(home, "ompbot.db"), { create: true, strict: true });
	db.run(DDL);
	mutate(db);
	db.close();
}

function gateState(name: string): { state: string; detail: string } {
	const gate = collectGates({ homeDir: home, now }).find((g) => g.name === name);
	if (gate === undefined) throw new Error(`gate ${name} not found`);
	return { state: gate.state, detail: gate.detail };
}

/** Writes a stamp whose ts field is `ageMs` in the past. */
function writeStamp(ageMs: number): void {
	mkdirSync(join(home, "backups"), { recursive: true });
	writeFileSync(
		join(home, "backups", STAMP_FILE),
		`ts=${new Date(now - ageMs).toISOString()} file=ompbot-x.db bytes=1 sha256=abc integrity=ok check=quick_check\n`,
	);
}

/** Writes a sweep heartbeat `ageMs` old (fake clock: no waiting), optionally with an observed loop delay. */
function writeHeartbeat(ageMs: number, loopMs = 0): void {
	writeFileSync(join(home, "sweep-heartbeat"), `ts=${new Date(now - ageMs).toISOString()} loop_ms=${loopMs}\n`, {
		mode: 0o600,
	});
}

describe("collectGates", () => {
	describe("host resources", () => {
		const GIB = 1024 ** 3;
		/** `statfs` answering `[free, total]` GiB per path (4 KiB blocks); any other path cannot be asked. */
		const statfs =
			(disks: Record<string, [number, number]>) =>
			(path: string): { bavail: number; blocks: number; bsize: number } => {
				const disk = disks[path];
				if (disk === undefined) throw new Error(`ENOENT: ${path}`);
				return { bavail: (disk[0] * GIB) / 4096, blocks: (disk[1] * GIB) / 4096, bsize: 4096 };
			};
		const diskGate = (disks: Record<string, [number, number]>, paths = Object.keys(disks)) =>
			collectGates({ homeDir: home, now, diskPaths: paths, statfs: statfs(disks) }).find((g) => g.name === "disk_low");
		const MEMINFO = (availableKb: number, totalKb = 1_000_000) =>
			`MemTotal:       ${totalKb} kB\nMemFree:          1000 kB\nMemAvailable:   ${availableKb} kB\n`;
		const pressure = (load15: number, cpuCount: number, meminfo: string | undefined) =>
			collectGates({
				homeDir: home,
				now,
				hostLoad: { loadavg: () => [0, 0, load15], cpuCount: () => cpuCount, meminfo: () => meminfo },
			}).find((g) => g.name === "host_pressure");

		test("AC-6: disk_low opens under 5 GiB or under 10% free, whichever trips first", () => {
			expect(diskGate({ "/a": [4, 100] })).toEqual({
				name: "disk_low",
				state: "open",
				detail: "path=/a free_gib=4.0 pct=4",
			});
			expect(diskGate({ "/a": [8, 50] })).toEqual({
				name: "disk_low",
				state: "closed",
				detail: "path=/a free_gib=8.0 pct=16",
			});
			expect(diskGate({ "/a": [20, 400] })).toMatchObject({ state: "open", detail: "path=/a free_gib=20.0 pct=5" });
			// Exactly 5 GiB and exactly 10% are not low.
			expect(diskGate({ "/a": [5, 50] })?.state).toBe("closed");
		});

		test("disk_low: any low path opens it and the detail names the tightest; unreadable paths are skipped", () => {
			expect(diskGate({ "/home": [80, 100], "/agent": [4, 100], "/x": [9, 100] })).toMatchObject({
				state: "open",
				detail: "path=/agent free_gib=4.0 pct=4",
			});
			expect(diskGate({ "/home": [80, 100] }, ["/home", "/gone"])).toMatchObject({
				state: "closed",
				detail: "path=/home free_gib=80.0 pct=80",
			});
			expect(diskGate({}, ["/gone"])).toEqual({ name: "disk_low", state: "closed", detail: "statfs=unavailable" });
		});

		test("AC-6: host_pressure opens at load15 >= 2 x cpus or MemAvailable under 5%, closed otherwise", () => {
			expect(pressure(8, 4, MEMINFO(500_000))).toEqual({
				name: "host_pressure",
				state: "open",
				detail: "load15=8.00 cpus=4 mem_avail_pct=50",
			});
			expect(pressure(7.99, 4, MEMINFO(500_000))?.state).toBe("closed");
			expect(pressure(0.5, 4, MEMINFO(49_999))).toMatchObject({
				state: "open",
				detail: "load15=0.50 cpus=4 mem_avail_pct=4",
			});
			expect(pressure(0.5, 4, MEMINFO(50_000))?.state).toBe("closed");
			expect(pressure(1, 4, undefined)).toMatchObject({
				state: "closed",
				detail: "load15=1.00 cpus=4 mem_avail_pct=unknown",
			});
		});

		test("both gates sit with the filesystem gates, so a missing ledger still reports them", () => {
			const names = collectGates({
				homeDir: home,
				now,
				diskPaths: ["/a"],
				statfs: statfs({ "/a": [50, 100] }),
				hostLoad: { loadavg: () => [0, 0, 0], cpuCount: () => 4, meminfo: () => MEMINFO(500_000) },
			}).map((g) => g.name);
			expect(names.slice(names.indexOf("frozen"), names.indexOf("inbound_starved"))).toEqual([
				"frozen",
				"disk_low",
				"host_pressure",
			]);
		});
	});

	test("all gates close for a freshly backed-up, idle bot", () => {
		writeStamp(0);
		writeHeartbeat(0);
		seedDb((db) => {
			db.run(
				"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at) VALUES ('C:1.1', 'slack/dm/D', 1, 't', 'answered', ?, ?)",
				[now, now],
			);
			db.run(
				"INSERT INTO deliveries (origin_key, op_ref, part, thread_ref, body, state, next_at, created_at) VALUES ('slack/dm/D', 'op1', 0, '1.1', 'b', 'confirmed', ?, ?)",
				[now, now],
			);
			db.run("INSERT INTO lanes (name, status, created_at, updated_at) VALUES ('l1', 'closed', ?, ?)", [now, now]);
		});
		for (const name of [
			"backup_age",
			"sweep_stalled",
			"slack_disconnected",
			"inbound_starved",
			"deliveries_overdue",
			"lanes_stuck",
			"monitors_failed",
			"monitors_stalled",
			"turns_failing",
		]) {
			expect(gateState(name).state).toBe("closed");
		}
	});

	test("backup_age opens without a stamp and after the 36h window", () => {
		expect(gateState("backup_age").state).toBe("open");
		expect(gateState("backup_age").detail).toBe("stamp=missing");
		writeStamp(37 * 3_600_000);
		expect(gateState("backup_age").state).toBe("open");
		writeStamp(1 * 3_600_000);
		expect(gateState("backup_age").state).toBe("closed");
	});

	test("sweep_stalled: missing stamp is unknown (nothing to judge); the gate opens past 3 sweeps", () => {
		writeStamp(0);
		expect(gateState("sweep_stalled")).toEqual({ state: "unknown", detail: "stamp=missing" });
		// The heartbeat ages on the fake clock alone: exactly three sweeps is still alive, one past opens.
		writeHeartbeat(SWEEP_STALLED_MS);
		expect(gateState("sweep_stalled").state).toBe("closed");
		writeHeartbeat(SWEEP_STALLED_MS + 1);
		expect(gateState("sweep_stalled").state).toBe("open");
		// A daemon dated ahead of `now` is corruption, not an immortal heartbeat (same rule as backup_age).
		writeHeartbeat(-2 * 60 * 60_000);
		expect(gateState("sweep_stalled")).toEqual({ state: "open", detail: "ts_in_future" });
	});

	test("readSweepHeartbeat parses the observed loop delay and falls back gracefully", () => {
		expect(readSweepHeartbeat(home)).toBeUndefined();
		writeHeartbeat(0, 137);
		expect(readSweepHeartbeat(home)).toMatchObject({ loopMs: 137 });
		writeFileSync(join(home, "sweep-heartbeat"), "ts=not-a-date loop_ms=x\n");
		const parsed = readSweepHeartbeat(home);
		expect(parsed?.loopMs).toBeUndefined();
		expect(Number.isNaN(parsed?.ts.getTime() ?? NaN)).toBe(false); // mtime fallback
	});

	/** Writes a heartbeat stamped now with extra raw fields (socket, draining). */
	function writeFields(fields: string): void {
		writeFileSync(join(home, "sweep-heartbeat"), `ts=${new Date(now).toISOString()} loop_ms=0 ${fields}\n`, {
			mode: 0o600,
		});
	}

	function resetDb(): void {
		rmSync(join(home, "ompbot.db"), { force: true });
	}

	test("heartbeat round-trip: socket and draining fields parse; malformed or absent fields stay undefined", () => {
		writeFields(`socket=down socket_since=${new Date(now - 5_000).toISOString()} draining=1`);
		const parsed = readSweepHeartbeat(home);
		expect(parsed?.socket).toEqual({ state: "down", since: new Date(now - 5_000) });
		expect(parsed?.draining).toBe(true);
		writeFields(`socket=up socket_since=${new Date(now).toISOString()} draining=0`);
		expect(readSweepHeartbeat(home)).toMatchObject({ socket: { state: "up" }, draining: false });
		writeFields("socket=weird socket_since=nope draining=2");
		const bad = readSweepHeartbeat(home);
		expect(bad?.socket).toBeUndefined();
		expect(bad?.draining).toBeUndefined();
		writeHeartbeat(0);
		expect(readSweepHeartbeat(home)?.socket).toBeUndefined();
		expect(readSweepHeartbeat(home)?.draining).toBeUndefined();
	});

	test("heartbeat round-trip: the Discord gateway state is written beside Slack's and only when given", () => {
		const writer = new SweepHeartbeatWriter(home);
		try {
			writer.beat(now, {
				socket: { state: "up", since: now - 9_000 },
				discord: { state: "down", since: now - 4_000 },
				draining: false,
			});
			expect(readSweepHeartbeat(home)).toMatchObject({
				socket: { state: "up", since: new Date(now - 9_000) },
				discord: { state: "down", since: new Date(now - 4_000) },
				draining: false,
			});
			writer.beat(now, { socket: { state: "up", since: now }, draining: false });
			expect(readSweepHeartbeat(home)?.discord).toBeUndefined();
		} finally {
			writer.stop();
		}
	});

	test("slack_disconnected: exactly 10 minutes down opens, 1 ms less is closed; up and an old stamp are closed; no stamp is unknown", () => {
		writeStamp(0);
		expect(gateState("slack_disconnected")).toEqual({ state: "unknown", detail: "stamp=missing" });
		const down = (ageMs: number) =>
			writeFields(`socket=down socket_since=${new Date(now - ageMs).toISOString()} draining=0`);
		down(SOCKET_DOWN_MS);
		expect(gateState("slack_disconnected")).toEqual({ state: "open", detail: "socket=down minutes=10" });
		down(SOCKET_DOWN_MS - 1);
		expect(gateState("slack_disconnected").state).toBe("closed");
		writeFields(`socket=up socket_since=${new Date(now - 3 * SOCKET_DOWN_MS).toISOString()} draining=0`);
		expect(gateState("slack_disconnected").state).toBe("closed");
		writeHeartbeat(0);
		expect(gateState("slack_disconnected")).toEqual({ state: "closed", detail: "socket=unknown" });
	});

	describe("monitors_stalled", () => {
		const CRON = '{"kind":"cron","schedule":"*/5 * * * *","timezone":"UTC"}';
		const INTERVAL = '{"kind":"interval","intervalMs":300000}';

		/** Interval trigger: next fire = cursor_at + intervalMs, so cursor_at is set to put it `overdueMs` in the past. */
		function seedMonitor(overdueMs: number, trigger = INTERVAL, cursorAt = now - overdueMs - 300_000): void {
			seedDb((db) => {
				db.run("ALTER TABLE monitors ADD COLUMN trigger_json TEXT");
				db.run("ALTER TABLE monitors ADD COLUMN cursor_at INTEGER");
				db.run(
					"INSERT INTO monitors (id, name, enabled, created_at, updated_at, trigger_json, cursor_at) VALUES ('m1', 'n1', 1, ?, ?, ?, ?)",
					[now, now, trigger, cursorAt],
				);
			});
		}

		test("a cron monitor 2h behind opens; draining closes it; a heartbeat without draining is closed heartbeat=old", () => {
			writeStamp(0);
			writeFields("draining=0");
			seedMonitor(0, CRON, now - 2 * 3_600_000);
			expect(gateState("monitors_stalled").state).toBe("open");
			expect(gateState("monitors_stalled").detail).toMatch(/^overdue=1$/);
			writeFields("draining=1");
			expect(gateState("monitors_stalled")).toEqual({ state: "closed", detail: "draining" });
			writeHeartbeat(0);
			expect(gateState("monitors_stalled")).toEqual({ state: "closed", detail: "heartbeat=old" });
		});

		test("boundary: next fire exactly 15 minutes past opens, 1 ms less is closed", () => {
			writeStamp(0);
			writeFields("draining=0");
			seedMonitor(MONITOR_OVERDUE_MS);
			expect(gateState("monitors_stalled")).toEqual({ state: "open", detail: "overdue=1" });
			resetDb();
			seedMonitor(MONITOR_OVERDUE_MS - 1);
			expect(gateState("monitors_stalled")).toEqual({ state: "closed", detail: "overdue=0" });
		});

		test("old schema is closed schema=old; unparsable trigger is skipped; disabled never counts", () => {
			writeStamp(0);
			writeFields("draining=0");
			seedDb(() => {});
			expect(gateState("monitors_stalled")).toEqual({ state: "closed", detail: "schema=old" });
			resetDb();
			seedMonitor(2 * 3_600_000, "not json");
			expect(gateState("monitors_stalled")).toEqual({ state: "closed", detail: "overdue=0" });
			resetDb();
			seedMonitor(2 * 3_600_000);
			const db = new Database(join(home, "ompbot.db"), { strict: true });
			db.run("UPDATE monitors SET enabled = 0");
			db.close();
			expect(gateState("monitors_stalled")).toEqual({ state: "closed", detail: "overdue=0" });
		});

		test("db missing: unknown db=missing", () => {
			writeStamp(0);
			expect(gateState("monitors_stalled")).toEqual({ state: "unknown", detail: "db=missing" });
		});
	});

	test("a hung turn (old dispatched inbound) opens inbound_starved", () => {
		writeStamp(0);
		seedDb((db) => {
			db.run(
				"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at) VALUES ('C:2.1', 'slack/dm/D', 1, 't', 'dispatched', ?, ?)",
				[now - 60_000, now - 11 * 60_000],
			);
		});
		expect(gateState("inbound_starved").state).toBe("open");
	});

	test("inbound_starved measures silence since the last omp event, not the turn's age", () => {
		writeStamp(0);
		seedDb((db) => {
			const insert =
				"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at, last_event_at) VALUES (?, 'slack/dm/D', 1, 't', 'dispatched', ?, ?, ?)";
			db.run(insert, ["C:3.1", now - 36 * 60_000, now - 35 * 60_000, now - 9 * 60_000]);
		});
		expect(gateState("inbound_starved")).toEqual({ state: "closed", detail: "silent_old=0" });

		now += 2 * 60_000;
		expect(gateState("inbound_starved")).toEqual({ state: "open", detail: "silent_old=1" });
	});

	describe("origin_silent", () => {
		const pending = (db: Database, id: string, origin: string, ageMs: number) =>
			db.run(
				"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at) VALUES (?, ?, 1, 't', 'pending', ?)",
				[id, origin, now - ageMs],
			);

		test("a message pending 15 minutes opens it; one minute younger does not; monitor rows never count", () => {
			writeStamp(0);
			seedDb((db) => {
				pending(db, "C:10.1", "slack/dm/D", ORIGIN_SILENT_MS - 60_000);
				pending(db, "C:10.2", "monitor/m1", 2 * ORIGIN_SILENT_MS);
			});
			expect(gateState("origin_silent")).toEqual({ state: "closed", detail: "waiting=0" });
			now += 60_000;
			expect(gateState("origin_silent")).toEqual({ state: "open", detail: "waiting=1 origins=1 oldest_min=15" });
		});

		test("queued behind a turn still emitting events is closed; behind a hung turn it opens", () => {
			writeStamp(0);
			seedDb((db) => {
				pending(db, "C:11.1", "slack/dm/D", 20 * 60_000);
				db.run(
					"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at, last_event_at) VALUES ('C:11.0', 'slack/dm/D', 1, 't', 'dispatched', ?, ?, ?)",
					[now - 30 * 60_000, now - 30 * 60_000, now - 60_000],
				);
			});
			expect(gateState("origin_silent").state).toBe("closed");
			now += INBOUND_STARVATION_MS;
			expect(gateState("origin_silent").state).toBe("open");
		});

		test("a restart drain holds pending rows on purpose: closed while draining", () => {
			writeStamp(0);
			seedDb((db) => pending(db, "C:12.1", "slack/dm/D", 2 * ORIGIN_SILENT_MS));
			writeFields("draining=1");
			expect(gateState("origin_silent")).toEqual({ state: "closed", detail: "draining" });
			writeFields("draining=0");
			expect(gateState("origin_silent").state).toBe("open");
		});
	});

	test("a turn waiting on a pending approval card is not starved; once the card is decided it is", () => {
		writeStamp(0);
		seedDb((db) => {
			db.run(
				"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at, last_event_at) VALUES ('C:4.1', 'slack/ch/C/t/1.1', 1, 't', 'dispatched', ?, ?, ?)",
				[now - 21 * 60_000, now - 20 * 60_000, now - 20 * 60_000],
			);
			db.run(
				"CREATE TABLE approvals (approval_id TEXT PRIMARY KEY, status TEXT NOT NULL, origin_key TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
			);
			db.run(
				"INSERT INTO approvals VALUES ('E:5.5', 'pending', 'slack/ch/C/t/1.1', ?, ?), ('E:6.6', 'pending', NULL, ?, ?)",
				[now - 20 * 60_000, now + 10 * 60_000, now - 20 * 60_000, now + 10 * 60_000],
			);
		});
		expect(gateState("inbound_starved")).toEqual({ state: "closed", detail: "silent_old=0" });

		const db = new Database(join(home, "ompbot.db"), { strict: true });
		db.run("UPDATE approvals SET status = 'approved' WHERE approval_id = 'E:5.5'");
		db.close();
		expect(gateState("inbound_starved")).toEqual({ state: "open", detail: "silent_old=1" });
	});

	test("stuck delivery pump opens deliveries_overdue but sticky ambiguous does not", () => {
		writeStamp(0);
		seedDb((db) => {
			db.run(
				"INSERT INTO deliveries (origin_key, op_ref, part, thread_ref, body, state, next_at, created_at) VALUES ('o', 'op1', 0, 't', 'b', 'pending', ?, ?)",
				[now - 11 * 60_000, now - 3_600_000],
			);
			db.run(
				"INSERT INTO deliveries (origin_key, op_ref, part, thread_ref, body, state, next_at, created_at) VALUES ('o', 'op2', 0, 't', 'b', 'failed_ambiguous', ?, ?)",
				[now - 3_600_000, now - 3_600_000],
			);
		});
		expect(gateState("deliveries_overdue").state).toBe("open");
		expect(gateState("deliveries_overdue").detail).toBe("overdue=1");
		// Only the pending row gates; the ambiguous row is visible in status instead.
		const db = new Database(join(home, "ompbot.db"), { strict: true });
		db.run("UPDATE deliveries SET state = 'confirmed' WHERE op_ref = 'op1'");
		db.close();
		expect(gateState("deliveries_overdue").state).toBe("closed");
	});

	test("an old working lane opens lanes_stuck", () => {
		writeStamp(0);
		seedDb((db) => {
			db.run("INSERT INTO lanes (name, status, created_at, updated_at) VALUES ('l1', 'working', ?, ?)", [
				now - 25 * 3_600_000,
				now - 25 * 3_600_000,
			]);
		});
		expect(gateState("lanes_stuck").state).toBe("open");
	});

	describe("lanes_stuck: orphan, running and approval-wait lanes", () => {
		const old = () => now - 25 * 3_600_000;

		/**
		 * The real ledger's columns on top of the shared DDL (pre-history lanes table, no approvals): lanes get
		 * origin_key and history, approvals the schema's status/origin_key/created_at/expires_at (ms epoch, like
		 * `ApprovalBroker`'s `now + timeoutMs`). Returns a working lane inserter whose last activity is `at`.
		 */
		function laneLedger(db: Database): (name: string, at: number) => void {
			db.run("ALTER TABLE lanes ADD COLUMN origin_key TEXT");
			db.run("ALTER TABLE lanes ADD COLUMN history TEXT");
			db.run(
				"CREATE TABLE approvals (approval_id TEXT PRIMARY KEY, status TEXT NOT NULL, origin_key TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
			);
			return (name, at) =>
				db.run(
					"INSERT INTO lanes (name, status, origin_key, history, created_at, updated_at) VALUES (?, 'working', ?, ?, ?, ?)",
					[name, `ompbot/work/${name}`, JSON.stringify([{ at, event: "created" }]), at, at],
				);
		}

		function turn(db: Database, origin: string, dispatchedAt: number, lastEventAt: number): void {
			db.run(
				"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at, last_event_at) VALUES (?, ?, 1, 't', 'dispatched', ?, ?, ?)",
				[`${origin}:${dispatchedAt}`, origin, dispatchedAt, dispatchedAt, lastEventAt],
			);
		}

		function pendingApproval(db: Database, origin: string, expiresAt: number): void {
			db.run(
				"INSERT INTO approvals (approval_id, status, origin_key, created_at, expires_at) VALUES (?, 'pending', ?, ?, ?)",
				[`E:${origin}`, origin, expiresAt - 30 * 60_000, expiresAt],
			);
		}

		test("lanes_stuck counts only orphan working lanes: a running turn or a pending approval keeps it closed", () => {
			writeStamp(0);
			const seedLanes = (withOrphan: boolean) =>
				seedDb((db) => {
					const lane = laneLedger(db);
					lane("running", old());
					turn(db, "ompbot/work/running", now - 60_000, now - 60_000);
					lane("approval", old());
					pendingApproval(db, "ompbot/work/approval", now + 10 * 60_000);
					if (withOrphan) lane("orphan", old());
				});
			seedLanes(true);
			expect(gateState("lanes_stuck")).toEqual({ state: "open", detail: "working_old=1 running=1 approval_wait=1" });
			rmSync(join(home, "ompbot.db"), { force: true });
			seedLanes(false);
			expect(gateState("lanes_stuck")).toEqual({ state: "closed", detail: "working_old=0 running=1 approval_wait=1" });
		});

		test("an expired card still marked pending (expireStale failing, sweep alive) waits on nobody: the lane is an orphan, the turn starved", () => {
			writeStamp(0);
			writeHeartbeat(0);
			seedDb((db) => {
				laneLedger(db)("approval", old());
				pendingApproval(db, "ompbot/work/approval", now - 60_000);
				// A chat turn hung behind the same kind of stale card.
				turn(db, "slack/ch/C/t/1.1", now - 20 * 60_000, now - 20 * 60_000);
				pendingApproval(db, "slack/ch/C/t/1.1", now - 60_000);
			});
			expect(gateState("sweep_stalled").state).toBe("closed");
			expect(gateState("lanes_stuck")).toEqual({ state: "open", detail: "working_old=1 running=0 approval_wait=0" });
			expect(gateState("inbound_starved")).toEqual({ state: "open", detail: "silent_old=1" });
		});

		test("a turn that keeps emitting events but was dispatched before the lane's 24h silence does not exempt the lane", () => {
			writeStamp(0);
			seedDb((db) => {
				laneLedger(db)("busy", old());
				turn(db, "ompbot/work/busy", old(), now - 60_000);
			});
			expect(gateState("lanes_stuck")).toEqual({ state: "open", detail: "working_old=1 running=0 approval_wait=0" });
		});
	});

	test("recent failed_no_retry on an enabled monitor opens monitors_failed", () => {
		writeStamp(0);
		seedDb((db) => {
			db.run("INSERT INTO monitors (id, name, enabled, created_at, updated_at) VALUES ('m1', '아침', 1, ?, ?)", [
				now,
				now,
			]);
			db.run(
				"INSERT INTO monitor_events (monitor_id, slot_at, stage, created_at, updated_at) VALUES ('m1', ?, 'failed_no_retry', ?, ?)",
				[now - 3_600_000, now - 3_600_000, now - 3_600_000],
			);
		});
		expect(gateState("monitors_failed").state).toBe("open");
		// Old failures do not gate: they already notified once.
		const db = new Database(join(home, "ompbot.db"), { strict: true });
		db.run("UPDATE monitor_events SET updated_at = ?", [now - 48 * 3_600_000]);
		db.close();
		expect(gateState("monitors_failed").state).toBe("closed");
	});

	test("three recent [turn failed] notices open turns_failing; fewer or older ones do not", () => {
		writeStamp(0);
		seedDb((db) => {
			const insert =
				"INSERT INTO deliveries (origin_key, op_ref, part, thread_ref, body, state, next_at, created_at) VALUES ('slack/dm/D', ?, 0, 't', ?, 'confirmed', ?, ?)";
			db.run(insert, ["op0", "ECHO fine", now, now - 5 * 60_000]);
			db.run(insert, ["op1", "[turn failed] rpc_error — 다시 보내 주세요", now, now - 10 * 60_000]);
			db.run(insert, ["op2", "[turn failed] rpc_error — 다시 보내 주세요", now, now - 20 * 60_000]);
			db.run(insert, ["op3", "[turn failed] omp_exited code=137 — 다시 보내 주세요", now, now - 30 * 60_000]);
		});
		expect(gateState("turns_failing")).toEqual({ state: "open", detail: "recent=3" });

		const db = new Database(join(home, "ompbot.db"), { strict: true });
		db.run("UPDATE deliveries SET created_at = ? WHERE op_ref = 'op3'", [now - 2 * 3_600_000]);
		db.close();
		expect(gateState("turns_failing")).toEqual({ state: "closed", detail: "recent=2" });
	});

	test("cost_cap exists only with a daily ceiling: open at the day's total, closed under it", () => {
		const day = kstDay(now);
		seedDb((db) => {
			db.run(
				"CREATE TABLE usage_daily (day TEXT NOT NULL, origin_key TEXT NOT NULL, cost REAL NOT NULL, calls INTEGER NOT NULL, PRIMARY KEY(day, origin_key))",
			);
			db.run("INSERT INTO usage_daily (day, origin_key, cost, calls) VALUES (?, 'slack/dm/D', 12.5, 3)", [day]);
			db.run("INSERT INTO usage_daily (day, origin_key, cost, calls) VALUES ('20200101', 'slack/dm/D', 99, 1)");
		});
		const capGate = (dailyCapUsd: number | undefined) =>
			collectGates({ homeDir: home, now, ...(dailyCapUsd === undefined ? {} : { dailyCapUsd }) }).find(
				(g) => g.name === "cost_cap",
			);
		expect(capGate(undefined)).toBeUndefined();
		expect(capGate(10)).toEqual({ name: "cost_cap", state: "open", detail: "today=12.50 cap=10.00" });
		expect(capGate(12.5)?.state).toBe("open");
		expect(capGate(12.51)).toMatchObject({ state: "closed", detail: "today=12.50 cap=12.51" });
	});

	test("cost_cap closes for a day the owner switched off with !budget off", () => {
		const day = kstDay(now);
		seedDb((db) => {
			db.run(
				"CREATE TABLE usage_daily (day TEXT NOT NULL, origin_key TEXT NOT NULL, cost REAL NOT NULL, calls INTEGER NOT NULL, PRIMARY KEY(day, origin_key))",
			);
			db.run(
				"CREATE TABLE slack_cursors (cursor_key TEXT PRIMARY KEY, last_ts TEXT NOT NULL, updated_at INTEGER NOT NULL)",
			);
			db.run("INSERT INTO usage_daily (day, origin_key, cost, calls) VALUES (?, 'slack/dm/D', 12.5, 3)", [day]);
			db.run("INSERT INTO slack_cursors (cursor_key, last_ts, updated_at) VALUES (?, '0', 0)", [`cost-cap-off:${day}`]);
		});
		const gate = collectGates({ homeDir: home, now, dailyCapUsd: 10 }).find((g) => g.name === "cost_cap");
		expect(gate).toEqual({ name: "cost_cap", state: "closed", detail: "today=12.50 cap=10.00 off=today" });
	});

	test("cost_cap reads zero spend on a ledger without usage_daily (an older bot) instead of judging unknown", () => {
		seedDb(() => undefined);
		const gate = collectGates({ homeDir: home, now, dailyCapUsd: 10 }).find((g) => g.name === "cost_cap");
		expect(gate).toEqual({ name: "cost_cap", state: "closed", detail: "today=0.00 cap=10.00" });
	});

	test("no database file leaves the db gates unknown while backup_age still reports", () => {
		expect(gateState("inbound_starved").detail).toBe("db=missing");
		expect(gateState("inbound_starved").state).toBe("unknown");
		expect(gateState("backup_age").state).toBe("open");
	});

	test("omp_runtime opens for a too-old bun or a missing omp, closes for a usable install, and is omitted without omp", () => {
		const runtimeGate = (ompExecutable: string) =>
			collectGates({ homeDir: home, now, ompExecutable }).find((g) => g.name === "omp_runtime");
		const launcher = (bunRange: string) => {
			const root = mkdtempSync(join(home, "pkg-"));
			mkdirSync(join(root, "dist"));
			writeFileSync(join(root, "package.json"), JSON.stringify({ engines: { bun: bunRange } }));
			writeFileSync(join(root, "dist", "cli.js"), "#!/usr/bin/env bun\n");
			return join(root, "dist", "cli.js");
		};
		expect(runtimeGate(launcher(">=999.0.0"))).toMatchObject({ state: "open" });
		expect(runtimeGate(launcher(">=999.0.0"))?.detail).toStartWith("bun_too_old ");
		expect(runtimeGate(launcher(`>=${Bun.version}`))).toMatchObject({ state: "closed", detail: "ok" });
		expect(runtimeGate(join(home, "no-such-omp"))).toMatchObject({ state: "open" });
		expect(collectGates({ homeDir: home, now }).some((g) => g.name === "omp_runtime")).toBe(false);
	});
});

describe("ompbot gates: open, closed and unknown (판정불가)", () => {
	/** Disk and host load injected calm, so the exit code never depends on this machine. */
	const calm: GatesCommandDeps = {
		now: () => now,
		statfs: () => ({ bavail: 50 * 262_144, blocks: 100 * 262_144, bsize: 4096 }), // 50 of 100 GiB free
		hostLoad: { loadavg: () => [0, 0, 0], cpuCount: () => 4, meminfo: () => undefined },
	};

	function runGates(args: string[]): { code: number; out: string } {
		const out: string[] = [];
		const write = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string) => {
			out.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		try {
			return { code: gatesCommand(args, home, calm), out: out.join("") };
		} finally {
			process.stdout.write = write;
		}
	}
	const lastLine = (out: string) => out.trimEnd().split("\n").pop();

	test("a home no daemon ever ran in (fresh backup stamp only): exit 0, unknown=9; --strict exits 1; --json counts unknown", () => {
		writeStamp(0);
		const plain = runGates([]);
		expect(plain.code).toBe(0);
		expect(lastLine(plain.out)).toBe(
			"gates_done open=0 unknown=9 total=13 unknown_gates=sweep_stalled,slack_disconnected,inbound_starved,origin_silent,deliveries_overdue,lanes_stuck,monitors_failed,monitors_stalled,turns_failing",
		);
		expect(runGates(["--strict"]).code).toBe(1);
		const json = runGates(["--json"]);
		expect(json.code).toBe(0);
		const parsed = JSON.parse(json.out) as { open: number; unknown: number; gates: Array<{ state: string }> };
		expect(parsed).toMatchObject({ open: 0, unknown: 9 });
		expect(parsed.gates.filter((gate) => gate.state === "unknown")).toHaveLength(9);
		expect(runGates(["--json", "--strict"]).code).toBe(1);
	});

	test("a healthy home passes --strict; a corrupt ledger still opens ledger_unreadable with exit 1", () => {
		writeStamp(0);
		writeFileSync(
			join(home, "sweep-heartbeat"),
			`ts=${new Date(now).toISOString()} loop_ms=0 socket=up socket_since=${new Date(now).toISOString()} draining=0\n`,
		);
		seedDb(() => {});
		const strict = runGates(["--strict"]);
		expect(lastLine(strict.out)).toBe("gates_done open=0 unknown=0 total=13");
		expect(strict.code).toBe(0);

		writeFileSync(join(home, "ompbot.db"), "not a database at all\n".repeat(500));
		const corrupt = runGates([]);
		expect(corrupt.code).toBe(1);
		expect(corrupt.out).toContain("gate=ledger_unreadable state=open");
		expect(lastLine(corrupt.out)).toStartWith("gates_done open=1 unknown=0 total=7 opened=ledger_unreadable(");
		expect(runGates(["--strict"]).code).toBe(1);
	});
});

describe("herdr_unreachable (herdr-health stamp)", () => {
	const herdrGate = () => collectGates({ homeDir: home, now }).find((g) => g.name === "herdr_unreachable");
	const stamp = (ageMs: number, fails: number) =>
		writeFileSync(
			join(home, HERDR_HEALTH_FILE),
			`ts=${new Date(now - ageMs).toISOString()} ok=${fails === 0 ? 1 : 0} fails=${fails} since=2026-11-05T00:00:00.000Z\n`,
		);

	test("no stamp: no gate; two failures closed, three open; a stamp older than three task sweeps is stale", () => {
		expect(herdrGate()).toBeUndefined();
		stamp(60_000, 2);
		expect(herdrGate()).toMatchObject({ state: "closed", detail: "ok" });
		stamp(60_000, 3);
		expect(herdrGate()).toEqual({
			name: "herdr_unreachable",
			state: "open",
			detail: "fails=3 since=2026-11-05T00:00:00.000Z",
		});
		stamp(HERDR_HEALTH_STALE_MS + 1_000, 5);
		expect(herdrGate()).toMatchObject({ state: "closed", detail: "stamp=stale" });
		expect(HERDR_HEALTH_STALE_MS).toBe(3 * TASK_SWEEP_MS);
	});

	test("the probe counts consecutive failed status checks, resets on success, and continues the streak after a restart", async () => {
		const answers: RunProcessResult[] = [];
		const calls: string[][] = [];
		const run: ProcessRunner = async (cmd, opts) => {
			calls.push(cmd);
			expect(opts.timeoutMs).toBe(10_000);
			return answers.shift() ?? { code: 0, stdout: "", timedOut: false };
		};
		const running: RunProcessResult = {
			code: 0,
			stdout: "status: running\nversion: 0.9.5\nsocket: /tmp/h.sock\n",
			timedOut: false,
		};
		const down: RunProcessResult = { code: 1, stdout: "", stderr: "server not running\n", timedOut: false };
		const probe = () => new HerdrHealthProbe({ homeDir: home, bin: "/opt/herdr", run, now: () => now });

		const first = probe();
		answers.push(down, down);
		expect((await first.check()).fails).toBe(1);
		expect(await first.check()).toMatchObject({ ok: false, fails: 2, error: "server_not_running" });
		expect(calls[0]).toEqual(["/opt/herdr", "status", "server"]);
		expect(herdrGate()?.state).toBe("closed");

		const restarted = probe();
		answers.push(down);
		expect((await restarted.check()).fails).toBe(3);
		expect(herdrGate()?.state).toBe("open");
		expect(readHerdrHealth(home)?.since).toBe(new Date(now).toISOString());

		answers.push(running);
		expect(await restarted.check()).toMatchObject({ ok: true, fails: 0, since: "-" });
		expect(herdrGate()).toMatchObject({ state: "closed", detail: "ok" });
		// exit 0 without a running line still counts as a failure
		answers.push({ code: 0, stdout: "status: stopped\n", timedOut: false });
		expect((await restarted.check()).fails).toBe(1);
	});
});
