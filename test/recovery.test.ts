import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBotStore } from "../src/core/origin";
import { INTERRUPTED_NOTICE, recoverDispatched } from "../src/daemon/recovery";
import { createLogger } from "../src/log";
import { OmpDriverError, type OmpFinal } from "../src/omp/driver";
import { FakeOmpDriver, FakeSessionStore, type FakeTurnMessage } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import type { Store } from "../src/store/db";

const ORIGIN = "slack/dm/D1";
const SESSION_DIR = "sess/e1";
const clock = { now: () => 1_000_000 };

let dir: string;
let store: Store;
let sessions: FakeSessionStore;
let logLines: string[];
let drivers: FakeOmpDriver[];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-recovery-"));
	store = openBotStore(join(dir, "ompbot.db"), clock);
	store.ensureOrigin(ORIGIN, SESSION_DIR);
	sessions = new FakeSessionStore();
	logLines = [];
	drivers = [];
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

const log = () => createLogger({ sink: (line) => logLines.push(line), clock, redact });

function factory(startError?: OmpDriverError) {
	return (_origin: string, sessionDir: string) => {
		const driver = new FakeOmpDriver({ sessionDir, store: sessions, ...(startError ? { startError } : {}) });
		drivers.push(driver);
		return driver;
	};
}

function nextFinal(driver: FakeOmpDriver): Promise<OmpFinal> {
	const { promise, resolve } = Promise.withResolvers<OmpFinal>();
	const off = driver.onFinal((final) => {
		off();
		resolve(final);
	});
	return promise;
}

/** Runs a turn in a "previous process" and records the inbound row the way the mailbox would have. */
async function dispatchedTurn(
	id: string,
	text: string,
	options: { finish: boolean; cursor?: (leaf: string | null) => string | null; script?: () => FakeTurnMessage[] },
): Promise<{ opRef: string }> {
	const driver = new FakeOmpDriver({
		sessionDir: SESSION_DIR,
		store: sessions,
		holdTurns: !options.finish,
		...(options.script ? { script: options.script } : {}),
	});
	await driver.start();
	await driver.openSession();
	const leaf = await driver.leafId();
	const final = nextFinal(driver);
	const opRef = await driver.prompt(text);
	store.recordInbound({ originKey: ORIGIN, platformMessageId: id, textRef: text, threadRef: `D1:${id}` });
	store.markDispatched(id, { opRef, entryCursor: options.cursor ? options.cursor(leaf) : leaf });
	if (options.finish) await final;
	else driver.crash(137); // the process died before any final
	await driver.stop();
	return { opRef };
}

describe("recovery rule (2): dispatched rows of a dead process", () => {
	test("final assistant body after the cursor -> answered + exactly one delivery", async () => {
		const { opRef } = await dispatchedTurn("m1", "ECHO abc", { finish: true });
		const result = await recoverDispatched({ store, driverFactory: factory(), log: log() });
		expect(result).toEqual({ answered: 1, interrupted: 0 });
		expect(store.getInbound("m1")?.state).toBe("answered");
		const deliveries = store.listDeliveries({ originKey: ORIGIN });
		expect(deliveries.map((d) => [d.body, d.threadRef, d.opRef])).toEqual([["ECHO ECHO abc", "D1:m1", opRef]]);
	});

	test("a reminder-continued turn is answered with every stop answer, like the live mailbox", async () => {
		await dispatchedTurn("m1", "report", {
			finish: true,
			script: () => [
				{ role: "assistant", text: "LONG REPORT", stopReason: "stop" },
				{ role: "developer", text: "<system-reminder> You stopped with 1 incomplete todo item(s)" },
				{ role: "assistant", text: "todo를 정리할게.", stopReason: "toolUse" },
				{ role: "toolResult", text: "ok" },
				{ role: "assistant", text: "short follow-up", stopReason: "stop" },
			],
		});
		const result = await recoverDispatched({ store, driverFactory: factory(), log: log() });
		expect(result).toEqual({ answered: 1, interrupted: 0 });
		expect(store.listDeliveries({ originKey: ORIGIN }).map((d) => d.body)).toEqual(["LONG REPORT\n\nshort follow-up"]);
	});

	test("a followup row in a resumed (pinned) session is answered from that session file", async () => {
		const pinned = "sess/e1/old-session.jsonl";
		store.newEpoch(ORIGIN, "sess/e1", undefined, pinned);
		const driver = new FakeOmpDriver({ sessionDir: "sess/e2", store: sessions });
		await driver.start();
		await driver.switchSession(pinned);
		const leaf = await driver.leafId();
		const final = nextFinal(driver);
		const opRef = await driver.prompt("B 작업");
		store.recordInbound({
			originKey: ORIGIN,
			platformMessageId: "m1",
			textRef: "/followup-ompbot B 작업",
			threadRef: "D1:m1",
		});
		store.markDispatched("m1", { opRef, entryCursor: leaf });
		await final;
		await driver.stop();
		const result = await recoverDispatched({ store, driverFactory: factory(), log: log() });
		expect(result).toEqual({ answered: 1, interrupted: 0 });
		expect(store.listDeliveries({ originKey: ORIGIN }).map((d) => d.body)).toEqual(["ECHO B 작업"]);
		expect(drivers[0]?.calls).toEqual([`switchSession:${pinned}`]);
	});

	test("no assistant body after the prompt -> one interrupted notice, failed_notified, prompt never resent", async () => {
		await dispatchedTurn("m1", "lost", { finish: false });
		const result = await recoverDispatched({ store, driverFactory: factory(), log: log() });
		expect(result).toEqual({ answered: 0, interrupted: 1 });
		expect(store.getInbound("m1")?.state).toBe("failed_notified");
		expect(store.listDeliveries().map((d) => d.body)).toEqual([INTERRUPTED_NOTICE]);
		expect(drivers.flatMap((d) => d.calls).filter((call) => call.startsWith("prompt:"))).toEqual([]);
	});

	test("unknown_since from omp -> interrupted notice, recovery itself does not throw", async () => {
		await dispatchedTurn("m1", "hello", { finish: true, cursor: () => "e-does-not-exist" });
		const result = await recoverDispatched({ store, driverFactory: factory(), log: log() });
		expect(result).toEqual({ answered: 0, interrupted: 1 });
		expect(store.listDeliveries().map((d) => d.body)).toEqual([INTERRUPTED_NOTICE]);
		expect(logLines.some((line) => line.includes("recovery_cursor_failed"))).toBe(true);
	});

	test("empty entry_cursor -> interrupted notice even though an answer exists in the session", async () => {
		await dispatchedTurn("m1", "hello", { finish: true, cursor: () => null });
		expect(store.getInbound("m1")?.entryCursor).toBeNull();
		const result = await recoverDispatched({ store, driverFactory: factory(), log: log() });
		expect(result).toEqual({ answered: 0, interrupted: 1 });
		expect(store.getInbound("m1")?.state).toBe("failed_notified");
	});

	test("mutation: looking the row up by timestamp instead of entry_cursor loses the answer", async () => {
		await dispatchedTurn("m1", "hello", { finish: true });
		const mutated = await recoverDispatched({
			store,
			driverFactory: factory(),
			log: log(),
			cursorOf: (row) => String(row.dispatchedAt),
		});
		// The first test's expectation (answered 1) fails under this variant.
		expect(mutated).toEqual({ answered: 0, interrupted: 1 });
	});

	test("rows steered into one turn share an op_ref and get a single settlement", async () => {
		const { opRef } = await dispatchedTurn("m1", "first", { finish: true });
		store.recordInbound({ originKey: ORIGIN, platformMessageId: "m2", textRef: "second", threadRef: "D1:m2" });
		store.markDispatched("m2", { opRef, entryCursor: store.getInbound("m1")?.entryCursor ?? null });
		const result = await recoverDispatched({ store, driverFactory: factory(), log: log() });
		expect(result.answered + result.interrupted).toBe(1);
		// One settlement in the lead's thread; m2's own thread gets only the steered-thread pointer.
		expect(store.listDeliveries().map((d) => d.threadRef)).toEqual([
			store.getInbound("m1")?.threadRef ?? "missing",
			"D1:m2",
		]);
		expect(store.listInbound({ state: "dispatched" })).toEqual([]);
	});

	test("omp cannot be started -> interrupted notice and the failure is logged", async () => {
		await dispatchedTurn("m1", "hello", { finish: true });
		const startError = new OmpDriverError("omp_executable_missing", "no omp");
		const result = await recoverDispatched({ store, driverFactory: factory(startError), log: log() });
		expect(result).toEqual({ answered: 0, interrupted: 1 });
		expect(logLines.some((line) => line.includes("recovery_open_failed"))).toBe(true);
	});

	test("nothing dispatched -> no driver is created", async () => {
		const result = await recoverDispatched({ store, driverFactory: factory(), log: log() });
		expect(result).toEqual({ answered: 0, interrupted: 0 });
		expect(drivers).toHaveLength(0);
	});
});

describe("inbound.thread_ref migration", () => {
	test("recordInbound persists threadRef and defaults it to the platform message id", () => {
		store.recordInbound({ originKey: ORIGIN, platformMessageId: "D1:1.1", textRef: "a", threadRef: "D1:0.5" });
		store.recordInbound({ originKey: ORIGIN, platformMessageId: "D1:2.2", textRef: "b" });
		expect(store.getInbound("D1:1.1")?.threadRef).toBe("D1:0.5");
		expect(store.getInbound("D1:2.2")?.threadRef).toBe("D1:2.2");
	});

	test("a database created before the column existed gets it added and backfilled", () => {
		const path = join(dir, "old.db");
		const old = new Database(path, { create: true, strict: true });
		old.run(`
			CREATE TABLE origins (origin_key TEXT PRIMARY KEY, epoch INTEGER NOT NULL, session_dir TEXT NOT NULL, updated_at INTEGER NOT NULL);
			CREATE TABLE inbound (
				inbound_id INTEGER PRIMARY KEY AUTOINCREMENT,
				platform_message_id TEXT NOT NULL UNIQUE,
				origin_key TEXT NOT NULL REFERENCES origins(origin_key),
				epoch INTEGER NOT NULL,
				text_ref TEXT NOT NULL,
				state TEXT NOT NULL DEFAULT 'pending',
				created_at INTEGER NOT NULL,
				dispatched_at INTEGER,
				op_ref TEXT,
				entry_cursor TEXT
			);
			INSERT INTO origins VALUES ('${ORIGIN}', 1, 'sess/e1', 1);
			INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, created_at) VALUES ('D1:9.9', '${ORIGIN}', 1, 'old', 1);
		`);
		old.close();
		const migrated = openBotStore(path, clock);
		try {
			expect(migrated.getInbound("D1:9.9")?.threadRef).toBe("D1:9.9");
			migrated.recordInbound({ originKey: ORIGIN, platformMessageId: "D1:10.1", textRef: "new", threadRef: "D1:9.9" });
			expect(migrated.getInbound("D1:10.1")?.threadRef).toBe("D1:9.9");
		} finally {
			migrated.close();
		}
	});
});
