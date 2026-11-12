import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBotStore } from "../src/core/origin";
import {
	CONTINUE_NOTICE,
	CONTINUE_PROMPT,
	INTERRUPTED_NOTICE,
	RESTART_CUT_FILE,
	RESTART_CUT_MAX_AGE_MS,
	type RestartCutEntry,
	recoverDispatched,
	writeRestartCut,
} from "../src/daemon/recovery";
import { createLogger } from "../src/log";
import { INTERIM_CLOSING } from "../src/omp/answers";
import { OmpDriverError, type OmpFinal, type OmpState } from "../src/omp/driver";
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
	store = openBotStore(join(dir, "ompbot.db"), clock, "Asia/Seoul");
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
	options: {
		finish: boolean;
		cursor?: (leaf: string | null) => string | null;
		script?: () => FakeTurnMessage[];
		/** What omp received instead of the row text (the mailbox puts recall/thread context in front). */
		prompt?: string;
	},
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
	const opRef = await driver.prompt(options.prompt ?? text);
	store.recordInbound({ originKey: ORIGIN, platformMessageId: id, textRef: text, threadRef: `D1:${id}` });
	store.markDispatched(id, { opRef, entryCursor: options.cursor ? options.cursor(leaf) : leaf });
	if (options.finish) await final;
	else driver.crash(137); // the process died before any final
	await driver.stop();
	return { opRef };
}

describe("recovery rule (2): dispatched rows of a dead process", () => {
	test("a child that opened another session than the pinned one: a warn line, no extra notice in the thread", async () => {
		const pinned = "sess/e1/old-session.jsonl";
		store.newEpoch(ORIGIN, "sess/e1", undefined, pinned);
		const previous = new FakeOmpDriver({ sessionDir: "sess/e1", store: sessions });
		await previous.start();
		await previous.switchSession(pinned);
		const leaf = await previous.leafId();
		const final = nextFinal(previous);
		const opRef = await previous.prompt("이어서");
		store.recordInbound({ originKey: ORIGIN, platformMessageId: "m1", textRef: "이어서", threadRef: "D1:m1" });
		store.markDispatched("m1", { opRef, entryCursor: leaf });
		await final;
		await previous.stop();

		/** Binds the pinned session like omp, but reports another file as open. */
		class ReportingDriver extends FakeOmpDriver {
			override async state(): Promise<OmpState> {
				return { ...(await super.state()), sessionFile: "sess/e1/other-session.jsonl" };
			}
		}
		const result = await recoverDispatched({
			store,
			driverFactory: (_origin, sessionDir) => new ReportingDriver({ sessionDir, store: sessions }),
			log: log(),
		});
		expect(result).toEqual({ answered: 1, interrupted: 0, continued: 0 });
		const mismatch = logLines.filter((line) => line.includes("event=session_resume_mismatch"));
		expect(mismatch).toHaveLength(1);
		expect(mismatch[0]).toContain("level=warn");
		// Only the recovered answer reaches the thread: recovery has no notice hook for the mismatch.
		expect(store.listDeliveries({ originKey: ORIGIN }).map((d) => d.body)).toEqual(["ECHO 이어서"]);
	});

	test("final assistant body after the cursor -> answered + exactly one delivery", async () => {
		const { opRef } = await dispatchedTurn("m1", "ECHO abc", { finish: true });
		const result = await recoverDispatched({ store, driverFactory: factory(), log: log() });
		expect(result).toEqual({ answered: 1, interrupted: 0, continued: 0 });
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
		expect(result).toEqual({ answered: 1, interrupted: 0, continued: 0 });
		expect(store.listDeliveries({ originKey: ORIGIN }).map((d) => d.body)).toEqual(["LONG REPORT\n\nshort follow-up"]);
	});

	test("a recovered turn leaves out what the dead process already sent as interim deliveries", async () => {
		const note = "지도 생성 중이에요. 브라우저는 절반만 됩니다(헤드리스만).";
		const script = (last: string) => () =>
			[
				{ role: "assistant", text: "LONG REPORT", stopReason: "stop" },
				{ role: "developer", text: "<system-reminder>" },
				{ role: "assistant", text: note, stopReason: "toolUse", toolCalls: ["wait"] },
				{ role: "toolResult", text: "ok" },
				{ role: "assistant", text: last, stopReason: "stop" },
			] satisfies FakeTurnMessage[];
		const first = await dispatchedTurn("m1", "report", { finish: true, script: script("short follow-up") });
		const second = await dispatchedTurn("m2", "again", { finish: true, script: script(" LONG REPORT\n") });
		for (const [id, { opRef }] of [
			["m1", first],
			["m2", second],
		] as const) {
			const threadRef = `D1:${id}`;
			store.recordInterim({ originKey: ORIGIN, opRef, threadRef, index: 0, body: "LONG REPORT" });
			store.recordInterim({ originKey: ORIGIN, opRef, threadRef, index: 1, body: note });
		}
		const result = await recoverDispatched({ store, driverFactory: factory(), log: log() });
		expect(result).toEqual({ answered: 2, interrupted: 0, continued: 0 });
		const turnEnd = store
			.listDeliveries({ originKey: ORIGIN })
			.filter((d) => !d.opRef.includes(":interim:"))
			.map((d) => [d.opRef, d.body]);
		expect(turnEnd).toEqual([
			[first.opRef, "short follow-up"],
			[second.opRef, INTERIM_CLOSING],
		]);
		expect([store.getInbound("m1")?.state, store.getInbound("m2")?.state]).toEqual(["answered", "answered"]);
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
		expect(result).toEqual({ answered: 1, interrupted: 0, continued: 0 });
		expect(store.listDeliveries({ originKey: ORIGIN }).map((d) => d.body)).toEqual(["ECHO B 작업"]);
		expect(drivers[0]?.calls).toEqual([`switchSession:${pinned}`]);
	});

	test("a turn whose prompt carries context blocks before [현재 요청] is answered", async () => {
		const prompt = "[이전 대화 회상]\n- 오너: 백업 경로\n\n[현재 요청]\n백업 경로 뭐였지";
		await dispatchedTurn("m1", "백업 경로 뭐였지", { finish: true, prompt });
		const result = await recoverDispatched({ store, driverFactory: factory(), log: log() });
		expect(result).toEqual({ answered: 1, interrupted: 0, continued: 0 });
		expect(store.getInbound("m1")?.state).toBe("answered");
		expect(store.listDeliveries({ originKey: ORIGIN }).map((d) => d.body)).toEqual([`ECHO ${prompt}`]);
	});

	test("a context-block prompt for another request, or an unfinished one, is interrupted", async () => {
		await dispatchedTurn("m1", "백업 경로 뭐였지", {
			finish: true,
			prompt: "[이전 대화 회상]\n- 오너: 백업 경로\n\n[현재 요청]\n다른 질문",
		});
		expect(await recoverDispatched({ store, driverFactory: factory(), log: log() })).toEqual({
			answered: 0,
			interrupted: 1,
			continued: 0,
		});
		await dispatchedTurn("m2", "백업 경로 뭐였지", {
			finish: false,
			prompt: "[이전 대화 회상]\n- 오너: 백업 경로\n\n[현재 요청]\n백업 경로 뭐였지",
		});
		expect(await recoverDispatched({ store, driverFactory: factory(), log: log() })).toEqual({
			answered: 0,
			interrupted: 1,
			continued: 0,
		});
		expect(store.listDeliveries().map((d) => d.body)).toEqual([INTERRUPTED_NOTICE, INTERRUPTED_NOTICE]);
	});

	test("no assistant body after the prompt -> one interrupted notice, failed_notified, prompt never resent", async () => {
		await dispatchedTurn("m1", "lost", { finish: false });
		const result = await recoverDispatched({ store, driverFactory: factory(), log: log() });
		expect(result).toEqual({ answered: 0, interrupted: 1, continued: 0 });
		expect(store.getInbound("m1")?.state).toBe("failed_notified");
		expect(store.listDeliveries().map((d) => d.body)).toEqual([INTERRUPTED_NOTICE]);
		expect(drivers.flatMap((d) => d.calls).filter((call) => call.startsWith("prompt:"))).toEqual([]);
	});

	test("unknown_since from omp -> interrupted notice, recovery itself does not throw", async () => {
		await dispatchedTurn("m1", "hello", { finish: true, cursor: () => "e-does-not-exist" });
		const result = await recoverDispatched({ store, driverFactory: factory(), log: log() });
		expect(result).toEqual({ answered: 0, interrupted: 1, continued: 0 });
		expect(store.listDeliveries().map((d) => d.body)).toEqual([INTERRUPTED_NOTICE]);
		expect(logLines.some((line) => line.includes("recovery_cursor_failed"))).toBe(true);
	});

	test("empty entry_cursor -> interrupted notice even though an answer exists in the session", async () => {
		await dispatchedTurn("m1", "hello", { finish: true, cursor: () => null });
		expect(store.getInbound("m1")?.entryCursor).toBeNull();
		const result = await recoverDispatched({ store, driverFactory: factory(), log: log() });
		expect(result).toEqual({ answered: 0, interrupted: 1, continued: 0 });
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
		expect(mutated).toEqual({ answered: 0, interrupted: 1, continued: 0 });
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
		expect(result).toEqual({ answered: 0, interrupted: 1, continued: 0 });
		expect(logLines.some((line) => line.includes("recovery_open_failed"))).toBe(true);
	});

	test("nothing dispatched -> no driver is created", async () => {
		const result = await recoverDispatched({ store, driverFactory: factory(), log: log() });
		expect(result).toEqual({ answered: 0, interrupted: 0, continued: 0 });
		expect(drivers).toHaveLength(0);
	});
});

describe("recovery of turns a planned restart cut (restart-cut.json)", () => {
	const cutAt = (age = 60_000) => clock.now() - age;
	const writeCut = (opRefs: RestartCutEntry[], age?: number) =>
		writeRestartCut(dir, { at: cutAt(age), applyStamp: "20261112-210000", opRefs });
	const recover = (lockRepos?: (originKey: string) => readonly string[]) =>
		recoverDispatched({
			store,
			driverFactory: factory(),
			log: log(),
			homeDir: dir,
			now: clock.now,
			...(lockRepos === undefined ? {} : { lockRepos }),
		});
	const resumeRows = () => store.listInbound().filter((row) => row.platformMessageId.startsWith("cut-"));
	const bodies = () => store.listDeliveries().map((d) => d.body);

	test("a cut conversation turn gets one cut-<id> resume row and one notice, no interrupted notice; a second run adds nothing", async () => {
		const { opRef } = await dispatchedTurn("m1", "긴 작업", { finish: false });
		writeCut([{ originKey: ORIGIN, opRef }]);
		expect(await recover()).toEqual({ answered: 0, interrupted: 0, continued: 1 });
		expect(store.getInbound("m1")?.state).toBe("failed_notified");
		expect(bodies()).toEqual([CONTINUE_NOTICE]);
		expect(store.listDeliveries().map((d) => d.threadRef)).toEqual(["D1:m1"]);
		const [resume] = resumeRows();
		expect(resume).toMatchObject({
			platformMessageId: "cut-m1",
			originKey: ORIGIN,
			threadRef: "D1:m1",
			state: "pending",
			textRef: CONTINUE_PROMPT,
			peerUserId: null,
		});
		expect(logLines.filter((line) => line.includes("event=recovery_continued"))).toHaveLength(1);
		// No prompt is sent by recovery itself: the resume row waits for the normal pending dispatch.
		expect(drivers.flatMap((d) => d.calls).filter((call) => call.startsWith("prompt:"))).toEqual([]);

		expect(await recover()).toEqual({ answered: 0, interrupted: 0, continued: 0 });
		expect(resumeRows()).toHaveLength(1);
		expect(bodies()).toEqual([CONTINUE_NOTICE]);
	});

	test("a turn not in the record, a monitor origin, a turn of a resume row and a stale record keep the interrupted notice", async () => {
		const notListed = await dispatchedTurn("m1", "a", { finish: false });
		writeCut([{ originKey: ORIGIN, opRef: "some-other-op" }]);
		expect(await recover()).toEqual({ answered: 0, interrupted: 1, continued: 0 });
		expect(notListed.opRef).not.toBe("some-other-op");

		const monitor = "monitor/7";
		store.ensureOrigin(monitor, "sess/mon");
		store.recordInbound({ originKey: monitor, platformMessageId: "mon1", textRef: "check", threadRef: "D1:mon1" });
		store.markDispatched("mon1", { opRef: "op-mon", entryCursor: null });
		writeCut([{ originKey: monitor, opRef: "op-mon" }]);
		expect(await recover()).toEqual({ answered: 0, interrupted: 1, continued: 0 });

		store.recordInbound({ originKey: ORIGIN, platformMessageId: "cut-m0", textRef: "resume", threadRef: "D1:m0" });
		store.markDispatched("cut-m0", { opRef: "op-resume", entryCursor: null });
		writeCut([{ originKey: ORIGIN, opRef: "op-resume" }]);
		expect(await recover()).toEqual({ answered: 0, interrupted: 1, continued: 0 });

		const stale = await dispatchedTurn("m2", "b", { finish: false });
		writeCut([{ originKey: ORIGIN, opRef: stale.opRef }], RESTART_CUT_MAX_AGE_MS + 1);
		expect(await recover()).toEqual({ answered: 0, interrupted: 1, continued: 0 });
		expect(logLines.filter((line) => line.includes("event=restart_cut_stale"))).toHaveLength(1);

		expect(resumeRows().map((row) => row.platformMessageId)).toEqual(["cut-m0"]);
		expect(bodies()).toEqual([INTERRUPTED_NOTICE, INTERRUPTED_NOTICE, INTERRUPTED_NOTICE]);
	});

	test("a cut turn whose final answer is already in the session is answered, not resumed (AC-4)", async () => {
		const { opRef } = await dispatchedTurn("m1", "done already", { finish: true });
		writeCut([{ originKey: ORIGIN, opRef }]);
		expect(await recover()).toEqual({ answered: 1, interrupted: 0, continued: 0 });
		expect(store.getInbound("m1")?.state).toBe("answered");
		expect(resumeRows()).toEqual([]);
		expect(bodies()).toEqual(["ECHO done already"]);
	});

	test("an unreadable record warns restart_cut_unreadable and the turn is interrupted as before (AC-7)", async () => {
		await dispatchedTurn("m1", "lost", { finish: false });
		writeFileSync(join(dir, RESTART_CUT_FILE), '{"at": 1, "opRefs": [');
		expect(await recover()).toEqual({ answered: 0, interrupted: 1, continued: 0 });
		const warned = logLines.filter((line) => line.includes("event=restart_cut_unreadable"));
		expect(warned).toHaveLength(1);
		expect(warned[0]).toContain("level=warn");
		expect(bodies()).toEqual([INTERRUPTED_NOTICE]);
		expect(resumeRows()).toEqual([]);
	});

	test("rollback restart: the same record twice still gives one resume row per cut turn, and recovery never deletes it (AC-8)", async () => {
		const first = await dispatchedTurn("m1", "x", { finish: false });
		const other = "slack/dm/D2";
		store.ensureOrigin(other, "sess/d2");
		store.recordInbound({ originKey: other, platformMessageId: "n1", textRef: "y", threadRef: "D2:n1" });
		store.markDispatched("n1", { opRef: "op-d2", entryCursor: null });
		writeCut([
			{ originKey: ORIGIN, opRef: first.opRef },
			{ originKey: other, opRef: "op-d2" },
		]);
		expect(await recover()).toEqual({ answered: 0, interrupted: 0, continued: 2 });
		// The first restarted process dispatched one resume row and was restarted again by the config rollback.
		store.markDispatched("cut-m1", { opRef: "op-resumed", entryCursor: null });
		expect(await recover()).toEqual({ answered: 0, interrupted: 1, continued: 0 });
		expect(resumeRows().map((row) => row.platformMessageId)).toEqual(["cut-m1", "cut-n1"]);
		expect(store.getInbound("cut-m1")?.state).toBe("failed_notified");
		expect(store.getInbound("cut-n1")?.state).toBe("pending");
		expect(existsSync(join(dir, RESTART_CUT_FILE))).toBe(true);
	});

	test("the resume prompt names a cancelled approval card and each repository with a .git/index.lock", async () => {
		const locked = join(dir, "repo-locked");
		const clean = join(dir, "repo-clean");
		mkdirSync(join(locked, ".git"), { recursive: true });
		mkdirSync(join(clean, ".git"), { recursive: true });
		writeFileSync(join(locked, ".git", "index.lock"), "");
		const { opRef } = await dispatchedTurn("m1", "push it", { finish: false });
		writeCut([{ originKey: ORIGIN, opRef, approval: "force push main" }]);
		expect(await recover(() => [locked, clean, locked])).toEqual({ answered: 0, interrupted: 0, continued: 1 });
		const lines = (store.getInbound("cut-m1")?.textRef ?? "").split("\n");
		expect(lines).toEqual([
			CONTINUE_PROMPT,
			"직전 승인 카드(force push main)는 취소됐습니다",
			`잠금 파일 있음: ${join(locked, ".git", "index.lock")} — 다른 git 프로세스가 없는지 확인한 뒤 처리하세요`,
		]);
		// The lock is reported, never removed.
		expect(existsSync(join(locked, ".git", "index.lock"))).toBe(true);
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
		const migrated = openBotStore(path, clock, "Asia/Seoul");
		try {
			expect(migrated.getInbound("D1:9.9")?.threadRef).toBe("D1:9.9");
			migrated.recordInbound({ originKey: ORIGIN, platformMessageId: "D1:10.1", textRef: "new", threadRef: "D1:9.9" });
			expect(migrated.getInbound("D1:10.1")?.threadRef).toBe("D1:9.9");
		} finally {
			migrated.close();
		}
	});
});
