import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OriginRouter, openBotStore } from "../src/core/origin";
import type { InboundRecord } from "../src/core/types";
import { createLogger } from "../src/log";
import type { OmpFinal } from "../src/omp/driver";
import { RpcOmpDriver } from "../src/omp/rpc-driver";
import { redact } from "../src/redact";
import type { Store } from "../src/store/db";
import { pickE2eModel } from "./helpers/omp-model";

/**
 * omp version compatibility smoke: the chat commands (model, thinking, compact, resume, queue/followup) and idle release
 * run through the real mailbox against a REAL `omp --mode rpc` child in an isolated temp session root. Costs tokens, so it
 * only runs with OMPBOT_E2E_OMP=1 (`bun run smoke-omp`); pick the binary with OMPBOT_OMP_EXECUTABLE.
 */
const enabled = process.env.OMPBOT_E2E_OMP === "1";
if (!enabled)
	console.log("[skip] omp-smoke.e2e.test.ts: set OMPBOT_E2E_OMP=1 to run against a real omp (costs tokens)");

const OMP_EXECUTABLE = process.env.OMPBOT_OMP_EXECUTABLE ?? Bun.which("omp") ?? "omp";
// Model is picked from what the real omp offers (no tokens), so a stale default skips instead of dispatch-failing.
const picked = enabled ? await pickE2eModel(OMP_EXECUTABLE) : undefined;
if (enabled && picked?.model === undefined)
	console.log(`[skip] omp-smoke.e2e.test.ts: ${picked?.reason ?? "no model offered"}`);
const MODEL = picked?.model ?? "";
const ORIGIN = "slack/dm/DSMOKE";
// Failure deadline on an awaited final, never a wait for time to pass.
const TURN_TIMEOUT_MS = 180_000;

let dir: string;
let store: Store;
let router: OriginRouter;
let now = 1_000_000;
const drivers: RpcOmpDriver[] = [];
const finals: OmpFinal[] = [];
const finalWaiters: Array<() => void> = [];

/** Resolves once `count` finals have been seen in total (armed before the triggering message). */
function untilFinals(count: number): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(() => reject(new Error(`timeout waiting for final #${count}`)), TURN_TIMEOUT_MS);
	const check = () => {
		if (finals.length < count) return;
		clearTimeout(timer);
		resolve();
	};
	finalWaiters.push(check);
	check();
	return promise.then(() =>
		router
			.mailbox(ORIGIN)
			.sweepIdle()
			.then(() => undefined),
	);
}

let counter = 0;
function msg(text: string): InboundRecord {
	const id = `s${++counter}`;
	return { platformMessageId: id, originKey: ORIGIN, ownerVerified: true, text, threadRef: `t-${id}` };
}

function replyIn(threadRef: string): string {
	return store
		.listDeliveries({ originKey: ORIGIN })
		.filter((d) => d.threadRef === threadRef)
		.map((d) => d.body)
		.join("\n");
}

async function command(text: string): Promise<string> {
	const record = msg(text);
	await router.route(record);
	return replyIn(record.threadRef);
}

beforeAll(() => {
	if (!enabled) return;
	dir = mkdtempSync(join(tmpdir(), "ompbot-smoke-"));
	store = openBotStore(join(dir, "ompbot.db"), { now: () => now });
	router = new OriginRouter({
		store,
		clock: { now: () => now },
		sessionsRoot: join(dir, "sessions"),
		idleStopMs: 60_000,
		log: createLogger({ sink: () => undefined, clock: { now: () => now }, redact }),
		statusProvider: () => "status",
		driverFactory: (_origin, sessionDir) => {
			const driver = new RpcOmpDriver({
				ompExecutable: OMP_EXECUTABLE,
				cwd: join(dir, "workspace"),
				sessionDir,
				env: { OMP_WIKI_NOTE_DISABLE: "1" },
			});
			driver.onFinal((final) => {
				finals.push(final);
				for (const check of finalWaiters) check();
			});
			drivers.push(driver);
			return driver;
		},
	});
});

afterAll(async () => {
	if (!enabled) return;
	await router.close();
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!enabled || picked?.model === undefined)(`omp smoke (${OMP_EXECUTABLE})`, () => {
	test(
		"model, thinking, prompt, compact, followup, queue, idle release and resume against the real omp",
		async () => {
			// ① model and thinking
			expect(await command("/model-ompbot")).toContain("현재 모델: ");
			expect(await command(`/model-ompbot ${MODEL.split("/")[0]}`)).toContain(MODEL); // ambiguous fragment lists candidates
			expect(await command(`/model-ompbot ${MODEL}`)).toContain(`${MODEL}(으)로 바꿨습니다`);
			const thinking = await command("/thinking-ompbot");
			expect(thinking).toContain("가능:");
			expect(await command("/thinking-ompbot off")).toContain("off(으)로 바꿨습니다");
			expect(store.getOrigin(ORIGIN)).toMatchObject({ model: MODEL, thinking: "off" });

			// ④ followup waits for the running turn; the queue shows it meanwhile
			const first = msg("Reply with exactly the word ALPHA and nothing else.");
			const followup = msg("/followup-ompbot Reply with exactly the word BRAVO and nothing else.");
			const twoFinals = untilFinals(2);
			await router.route(first);
			await router.route(followup);
			const queue = await command("/queue-ompbot");
			expect(queue).toContain("[다음 작업] Reply with exactly the word BRAVO");
			await twoFinals;
			expect(replyIn(first.threadRef)).toContain("ALPHA");
			expect(replyIn(followup.threadRef)).toContain("BRAVO");

			// ② compact
			// Two short turns may be below omp's compaction threshold; either answer proves the RPC round trip.
			expect(await command("/compact-ompbot")).toMatch(/압축했습니다|압축할 만큼 대화가 길지 않습니다/);

			// ③ idle release keeps the session and re-applies the chat settings on the next child
			const sessionId = (await drivers.at(-1)?.state())?.sessionId;
			const pid = drivers.at(-1)?.pid;
			now += 60_000;
			expect(await router.mailbox(ORIGIN).sweepIdle()).toBe(true);
			expect(drivers.at(-1)?.pid).toBeUndefined();
			expect(pid).toBeDefined();
			expect(await command("/model-ompbot")).toContain(`현재 모델: ${MODEL}`);
			expect(drivers).toHaveLength(2);
			expect((await drivers[1]?.state())?.sessionId).toBe(sessionId);

			// ② resume lists the session and re-selecting it is a no-op
			const listed = await command("/resume-ompbot");
			expect(listed).toContain("◀ 현재");
			expect(await command("/resume-ompbot 1")).toContain("이미 이 세션입니다");
		},
		TURN_TIMEOUT_MS * 3,
	);
});
