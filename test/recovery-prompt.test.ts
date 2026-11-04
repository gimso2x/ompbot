import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { THREAD_CONTEXT_HEADER } from "../src/core/mailbox";
import { OriginRouter, openBotStore } from "../src/core/origin";
import { RECALL_HEADER } from "../src/core/recall";
import { recoverDispatched } from "../src/daemon/recovery";
import { createLogger } from "../src/log";
import type { OmpFinal } from "../src/omp/driver";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import type { Store } from "../src/store/db";

/**
 * A child whose final never reaches the mailbox: the turn finishes in the session, the daemon dies before it
 * records the answer. `finished()` lets the test wait for that final without the mailbox seeing it.
 */
class DyingDaemonDriver extends FakeOmpDriver {
	override onFinal(_listener: (final: OmpFinal) => void): () => void {
		return () => undefined;
	}

	finished(): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const off = super.onFinal(() => {
			off();
			resolve();
		});
		return promise;
	}
}

const clock = { now: () => Date.UTC(2026, 10, 1) };
let dir: string;
let store: Store;
let sessions: FakeSessionStore;
let router: OriginRouter;
let drivers: Map<string, DyingDaemonDriver>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-recovery-prompt-"));
	store = openBotStore(join(dir, "ompbot.db"), clock);
	sessions = new FakeSessionStore();
	drivers = new Map();
	router = new OriginRouter({
		store,
		clock,
		sessionsRoot: join(dir, "sessions"),
		log: createLogger({ sink: () => undefined, clock, redact }),
		statusProvider: () => "status: ok",
		recallEnabled: () => true,
		driverFactory: (origin, sessionDir) => {
			const driver = new DyingDaemonDriver({
				sessionDir,
				store: sessions,
				holdTurns: true,
				respond: () => "끝난 답",
			});
			drivers.set(origin, driver);
			return driver;
		},
	});
});

afterEach(async () => {
	await router.close();
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

/** Routes the owner message through the real mailbox, lets omp finish the turn unseen, then "restarts". */
async function finishedUnseen(originKey: string, threadRef: string, id: string, text: string): Promise<string> {
	await router.route({ platformMessageId: id, originKey, ownerVerified: true, text, threadRef });
	const driver = drivers.get(originKey);
	if (driver === undefined) throw new Error(`no driver for ${originKey}`);
	const prompt = driver.calls.find((call) => call.startsWith("prompt:"))?.slice("prompt:".length) ?? "";
	const finished = driver.finished();
	driver.release();
	await finished;
	await router.close();
	expect(store.getInbound(id)?.state).toBe("dispatched");
	return prompt;
}

const recover = () =>
	recoverDispatched({
		store,
		driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		log: createLogger({ sink: () => undefined, clock, redact }),
	});

describe("restart recovery of a turn whose prompt the mailbox composed", () => {
	test("a recall-prefixed turn that finished before the restart is answered", async () => {
		store.ensureOrigin("slack/ch/C1/t/1000.1", join(dir, "seed"));
		store.recordInbound({
			originKey: "slack/ch/C1/t/1000.1",
			platformMessageId: "C1:1000.1#seed",
			textRef: "백업 경로는 /srv/backup 으로 정했어",
			threadRef: "C1:1000.1",
		});
		const prompt = await finishedUnseen(
			"slack/ch/C1/t/5000.1",
			"C1:5000.1",
			"C1:5000.2",
			"저번에 정한 백업 경로 뭐였지",
		);
		expect(prompt.startsWith(`${RECALL_HEADER}\n`)).toBe(true);

		expect(await recover()).toEqual({ answered: 1, interrupted: 0 });
		expect(store.getInbound("C1:5000.2")?.state).toBe("answered");
		expect(store.listDeliveries({ originKey: "slack/ch/C1/t/5000.1" }).map((d) => d.body)).toEqual(["끝난 답"]);
	});

	test("a fresh thread session's context-prefixed first turn is answered", async () => {
		store.ensureOrigin("slack/ch/C1", join(dir, "seed"));
		store.recordInbound({
			originKey: "slack/ch/C1",
			platformMessageId: "C1:6000.1",
			textRef: "스레드 시작 메시지 내용",
			threadRef: "C1:6000.1",
		});
		const prompt = await finishedUnseen("slack/ch/C1/t/6000.1", "C1:6000.1", "C1:6000.2", "이어서 정리해줘");
		expect(prompt.startsWith(THREAD_CONTEXT_HEADER)).toBe(true);

		expect(await recover()).toEqual({ answered: 1, interrupted: 0 });
		expect(store.listDeliveries({ originKey: "slack/ch/C1/t/6000.1" }).map((d) => d.body)).toEqual(["끝난 답"]);
	});
});
