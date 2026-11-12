import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OriginMailbox, THREAD_CONTEXT_HEADER } from "../src/core/mailbox";
import { threadRefOfOrigin } from "../src/core/normalize";
import { OriginRouter, openBotStore } from "../src/core/origin";
import type { InboundRecord } from "../src/core/types";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import type { DeliveryRow, Store } from "../src/store/db";

class FakeClock {
	t = 1_000_000;
	now(): number {
		return this.t;
	}
}

const CHANNEL = "slack/ch/C1";
const THREAD = `${CHANNEL}/t/111.222`;
const REF = "C1:111.222";

function msg(originKey: string, threadRef: string, platformMessageId: string, text: string): InboundRecord {
	return { platformMessageId, originKey, ownerVerified: true, text, threadRef };
}

let dir: string;
let clock: FakeClock;
let store: Store;
let router: OriginRouter;
let drivers: FakeOmpDriver[];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-thread-context-"));
	clock = new FakeClock();
	store = openBotStore(join(dir, "ompbot.db"), clock, "Asia/Seoul");
	drivers = [];
	const sessionStore = new FakeSessionStore();
	router = new OriginRouter({
		timezone: "Asia/Seoul",
		store,
		clock,
		sessionsRoot: join(dir, "sessions"),
		log: createLogger({ sink: () => undefined, clock, redact }),
		statusProvider: () => "status: ok",
		driverFactory: (_origin, sessionDir) => {
			const driver = new FakeOmpDriver({ sessionDir, store: sessionStore, holdTurns: true });
			drivers.push(driver);
			return driver;
		},
	});
});

afterEach(async () => {
	await router.close();
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

/** One held turn: route the record, then release the driver's turn and let the mailbox settle it. */
async function turn(mailbox: OriginMailbox, driverIndex: number, route: () => Promise<void>): Promise<void> {
	await route();
	const driver = driverAt(driverIndex);
	const { promise, resolve } = Promise.withResolvers<void>();
	const off = driver.onFinal(() => {
		off();
		resolve();
	});
	driver.release();
	await promise;
	await mailbox.sweepIdle();
}

function driverAt(index: number): FakeOmpDriver {
	const driver = drivers[index];
	if (driver === undefined) throw new Error(`driver ${index} missing`);
	return driver;
}

/** Walk a pending delivery through the send state machine to `confirmed` (claim → confirm). */
function confirmDelivery(row: DeliveryRow | undefined): void {
	if (row === undefined) throw new Error("delivery row missing");
	store.claimDue();
	store.confirmDelivery(row.deliveryId);
}

const promptsOf = (driver: FakeOmpDriver): string[] => driver.calls.filter((c) => c.startsWith("prompt:"));

describe("thread context injection", () => {
	test("a fresh thread session's first prompt carries the root message and foreign answers", async () => {
		const rootText = "카톡 대화 내용 첨부했어\n[첨부: /home/dev/.ompbot/media/inbound/111_222/doc_1.txt]";
		const channelMailbox = router.mailbox(CHANNEL);
		await turn(channelMailbox, 0, () => router.route(msg(CHANNEL, REF, "C1:111.222", rootText)));
		// The channel session itself gets no context block: its origin is not a thread session.
		expect(promptsOf(driverAt(0))).toEqual([`prompt:${rootText}`]);

		confirmDelivery(store.listDeliveries({ originKey: CHANNEL }).find((d) => d.threadRef === REF));

		const threadMailbox = router.mailbox(THREAD);
		await turn(threadMailbox, 1, () => router.route(msg(THREAD, REF, "C1:111.333", "이번 주 내용 정리해서줘")));
		const prompt = promptsOf(driverAt(1))[0] ?? "";
		expect(prompt).toContain(THREAD_CONTEXT_HEADER);
		expect(prompt).toContain("카톡 대화 내용 첨부했어");
		expect(prompt).toContain("doc_1.txt");
		expect(prompt).toContain("ECHO 카톡 대화 내용 첨부했어");
		expect(prompt.endsWith("\n\n[현재 요청]\n이번 주 내용 정리해서줘")).toBe(true);
	});

	test("only the first prompt of the session carries the context", async () => {
		await turn(router.mailbox(CHANNEL), 0, () => router.route(msg(CHANNEL, REF, "C1:111.222", "스레드 시작")));
		confirmDelivery(store.listDeliveries({ originKey: CHANNEL }).find((d) => d.threadRef === REF));

		const threadMailbox = router.mailbox(THREAD);
		await turn(threadMailbox, 1, () => router.route(msg(THREAD, REF, "C1:111.333", "첫 메시지")));
		await turn(threadMailbox, 1, () => router.route(msg(THREAD, REF, "C1:111.444", "두번째 메시지")));
		expect(promptsOf(driverAt(1))[0] ?? "").toContain(THREAD_CONTEXT_HEADER);
		expect(promptsOf(driverAt(1))[1] ?? "").toBe("prompt:두번째 메시지");
	});

	test("a thread whose root is a bot post injects only the foreign answers", async () => {
		store.recordAnswer({ originKey: CHANNEL, opRef: "op-retro", threadRef: REF, parts: ["10월 회고 완료"] });
		confirmDelivery(store.listDeliveries({ originKey: CHANNEL }).find((d) => d.threadRef === REF));

		const threadMailbox = router.mailbox(THREAD);
		await turn(threadMailbox, 0, () => router.route(msg(THREAD, REF, "C1:111.999", "이어서 설명해줘")));
		const prompt = promptsOf(driverAt(0))[0] ?? "";
		expect(prompt).toContain("10월 회고 완료");
		expect(prompt).toContain("이 스레드에 이미 올린 봇 답");
		expect(prompt).not.toContain("스레드 시작 메시지");
	});

	test("a thread with nothing to inject keeps the prompt untouched", async () => {
		const threadMailbox = router.mailbox(THREAD);
		await turn(threadMailbox, 0, () => router.route(msg(THREAD, REF, "C1:111.777", "그냥 질문")));
		expect(promptsOf(driverAt(0))).toEqual(["prompt:그냥 질문"]);
	});

	test("an over-long root is truncated to the context budget", async () => {
		const longRoot = `매우 긴 첨부 본문\n[첨부: /x/doc.txt]\n${"x".repeat(6000)}`;
		await turn(router.mailbox(CHANNEL), 0, () => router.route(msg(CHANNEL, REF, "C1:111.222", longRoot)));

		const threadMailbox = router.mailbox(THREAD);
		await turn(threadMailbox, 1, () => router.route(msg(THREAD, REF, "C1:111.333", "요약해줘")));
		const prompt = promptsOf(driverAt(1))[0] ?? "";
		const rootLine = prompt.split("\n").find((line) => line.startsWith("- 스레드 시작 메시지"));
		expect(rootLine).toBeDefined();
		expect((rootLine ?? "").length).toBeLessThan(4100);
	});

	test("threadRefOfOrigin maps only thread-session origins", () => {
		expect(threadRefOfOrigin(THREAD)).toBe(REF);
		expect(threadRefOfOrigin(CHANNEL)).toBeUndefined();
		expect(threadRefOfOrigin("slack/dm/D1")).toBeUndefined();
		expect(threadRefOfOrigin("monitor/abc12345")).toBeUndefined();
	});
});
