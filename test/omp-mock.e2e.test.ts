import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { OriginRouter, openBotStore } from "../src/core/origin";
import type { InboundRecord } from "../src/core/types";
import { createLogger } from "../src/log";
import type { OmpEvent, OmpFinal } from "../src/omp/driver";
import { RpcOmpDriver } from "../src/omp/rpc-driver";
import { redact } from "../src/redact";
import type { Store } from "../src/store/db";
import { MOCK_DONE_PREFIX, MOCK_PLAIN_REPLY, type MockLlm, startMockLlm, textOf } from "./helpers/mock-llm";
import { createOmpMockEnv, MOCK_MODEL, type OmpMockEnv } from "./helpers/omp-mock-env";

/**
 * Real `omp --mode rpc` behind the real mailbox, answered by the scripted mock model (test/helpers/mock-llm.ts): zero
 * tokens, deterministic, so an omp upgrade that changes event shapes, steer or abort fails here. Runs only with
 * OMPBOT_E2E_OMP_MOCK=1 (`bun run test:omp-mock`); pick the binary with OMPBOT_OMP_EXECUTABLE. A missing omp skips;
 * an omp that rejects the mock provider config fails (that is the regression signal).
 */
const enabled = process.env.OMPBOT_E2E_OMP_MOCK === "1";
const OMP_EXECUTABLE = process.env.OMPBOT_OMP_EXECUTABLE ?? Bun.which("omp") ?? undefined;
if (!enabled)
	console.log("[skip] omp-mock.e2e.test.ts: set OMPBOT_E2E_OMP_MOCK=1 to run against a real omp (no tokens)");
else if (OMP_EXECUTABLE === undefined) console.log("[skip] omp-mock.e2e.test.ts: omp executable not found");
const runnable = enabled && OMP_EXECUTABLE !== undefined;
const OMP_VERSION = runnable
	? new TextDecoder().decode(Bun.spawnSync([OMP_EXECUTABLE ?? "omp", "--version"]).stdout).trim()
	: "";
if (runnable) console.log(`[omp-mock] ${OMP_EXECUTABLE} --version: ${OMP_VERSION}`);

const ORIGIN = "slack/dm/DMOCK";
/** Failure deadline on an awaited signal, never a wait for time to pass. */
const DEADLINE_MS = 60_000;
/** Mock model latency for the interrupt scenarios; the steer/abort is sent while this request is held open. */
const SLEEP_MS = 5_000;

let llm: MockLlm;
let env: OmpMockEnv;
let store: Store;
let router: OriginRouter;
const now = 1_000_000;
const drivers: RpcOmpDriver[] = [];
const finals: OmpFinal[] = [];
const events: OmpEvent[] = [];
const finalWaiters = new Set<() => void>();

/** Resolves with final #`seen`+1 once the mailbox settled it (armed before the triggering message). */
function nextFinal(seen: number): Promise<OmpFinal> {
	const { promise, resolve, reject } = Promise.withResolvers<OmpFinal>();
	const timer = setTimeout(() => {
		finalWaiters.delete(check);
		reject(new Error(`timeout waiting for final #${seen + 1} (${OMP_VERSION})`));
	}, DEADLINE_MS);
	const check = () => {
		const final = finals[seen];
		if (final === undefined) return;
		clearTimeout(timer);
		finalWaiters.delete(check);
		resolve(final);
	};
	finalWaiters.add(check);
	check();
	// The mailbox settles the final (delivery, turn reset) on its serial queue after this listener ran; an idle sweep
	// (a no-op: the fake clock never advances) queues behind it, so resolving after it means the turn is settled.
	return promise.then(async (final) => {
		await router.mailbox(ORIGIN).sweepIdle();
		return final;
	});
}

let counter = 0;
function msg(text: string): InboundRecord {
	const id = `m${++counter}`;
	return { platformMessageId: id, originKey: ORIGIN, ownerVerified: true, text, threadRef: `t-${id}` };
}

function replyIn(threadRef: string): string {
	return store
		.listDeliveries({ originKey: ORIGIN })
		.filter((d) => d.threadRef === threadRef)
		.map((d) => d.body)
		.join("\n");
}

function userTexts(index: number): string[] {
	return (llm.requests[index]?.messages ?? []).filter((m) => m.role === "user").map((m) => textOf(m.content));
}

beforeAll(() => {
	if (!runnable) return;
	llm = startMockLlm();
	env = createOmpMockEnv(llm.baseUrl);
	store = openBotStore(join(env.root, "ompbot.db"), { now: () => now });
	const slash = MOCK_MODEL.indexOf("/");
	router = new OriginRouter({
		store,
		clock: { now: () => now },
		sessionsRoot: env.sessionsRoot,
		idleStopMs: 60_000,
		log: createLogger({ sink: () => undefined, clock: { now: () => now }, redact }),
		statusProvider: () => "status",
		driverFactory: (_origin, sessionDir) => {
			const driver = new RpcOmpDriver({
				ompExecutable: OMP_EXECUTABLE ?? "omp",
				cwd: env.workspace,
				sessionDir,
				provider: MOCK_MODEL.slice(0, slash),
				model: MOCK_MODEL.slice(slash + 1),
				env: env.env,
			});
			driver.onEvent((event) => events.push(event));
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
	if (!runnable) return;
	await router.close();
	store.close();
	await llm.close();
	env.close();
});

describe.skipIf(!runnable)(`omp + scripted mock model (${OMP_VERSION})`, () => {
	test(
		"1: a text-only reply comes back as the turn's final and the delivered answer",
		async () => {
			const before = llm.requests.length;
			const record = msg("hello mock");
			const final = nextFinal(finals.length);
			await router.route(record);
			expect(await final).toMatchObject({ status: "completed", text: MOCK_PLAIN_REPLY });
			expect(llm.requests.length - before).toBe(1);
			expect((await drivers.at(-1)?.state())?.model).toBe(MOCK_MODEL);
			expect(replyIn(record.threadRef)).toContain(MOCK_PLAIN_REPLY);
		},
		DEADLINE_MS * 2,
	);

	test(
		"2: a scripted bash call emits tool_execution_start then _end with the real result",
		async () => {
			const before = llm.requests.length;
			const firstEvent = events.length;
			const record = msg('[[tool:bash {"command":"echo hi"}]]');
			const final = nextFinal(finals.length);
			await router.route(record);
			expect(await final).toMatchObject({ status: "completed", text: `${MOCK_DONE_PREFIX}hi` });
			expect(llm.requests.length - before).toBe(2);

			const tools = events
				.slice(firstEvent)
				.filter((e) => e.type === "tool_execution_start" || e.type === "tool_execution_end");
			expect(tools.map((e) => [e.type, e.toolName])).toEqual([
				["tool_execution_start", "bash"],
				["tool_execution_end", "bash"],
			]);
			expect(tools[0]?.args).toEqual({ command: "echo hi" });
			expect(tools[1]).toMatchObject({ isError: false, result: { content: [{ type: "text", text: "hi\n" }] } });
			// The tool result reached the model on the follow-up request.
			const toolMessages = llm.requests[before + 1]?.messages.filter((m) => m.role === "tool") ?? [];
			expect(toolMessages.map((m) => textOf(m.content).trim()).at(-1)).toBe("hi");
			expect(replyIn(record.threadRef)).toContain(`${MOCK_DONE_PREFIX}hi`);
		},
		DEADLINE_MS * 2,
	);

	test(
		"3: a message routed while the model is sleeping is steered into the next request of the same turn",
		async () => {
			const before = llm.requests.length;
			const steerText = "STEER-MARK-e2e please also mention this";
			const record = msg(`[[sleep:${SLEEP_MS}]] long answer`);
			const final = nextFinal(finals.length);
			const finalsBefore = finals.length;
			await router.route(record);
			await llm.untilRequests(before + 1, DEADLINE_MS);
			expect(llm.requests[before]?.plan.sleepMs).toBe(SLEEP_MS);
			expect(userTexts(before).some((t) => t.includes(steerText))).toBe(false);

			await router.route(msg(steerText)); // the turn is running: the mailbox steers instead of starting a turn
			expect(await final).toMatchObject({ status: "completed", text: MOCK_PLAIN_REPLY });
			expect(llm.requests.length - before).toBe(2);
			expect(userTexts(before + 1).some((t) => t.includes(steerText))).toBe(true);
			expect(llm.requests[before + 1]?.plan.sleepMs).toBe(0);
			expect(finals.length - finalsBefore).toBe(1);
		},
		DEADLINE_MS * 2,
	);

	test(
		"4: abort while the model is sleeping settles the turn as aborted and the child keeps serving",
		async () => {
			const before = llm.requests.length;
			const record = msg(`[[sleep:${SLEEP_MS}]] abort me`);
			const aborted = nextFinal(finals.length);
			await router.route(record);
			await llm.untilRequests(before + 1, DEADLINE_MS);
			const driver = drivers.at(-1);
			const pid = driver?.pid;
			await driver?.abort();
			expect(await aborted).toMatchObject({ status: "aborted" });
			expect(llm.requests.length - before).toBe(1);
			expect(llm.requests[before]?.aborted).toBe(true);

			expect(pid).toBeDefined();
			expect(driver?.pid).toBe(pid);
			expect(() => process.kill(pid ?? 0, 0)).not.toThrow();
			const after = msg("still there?");
			const final = nextFinal(finals.length);
			await router.route(after);
			expect(await final).toMatchObject({ status: "completed", text: MOCK_PLAIN_REPLY });
			expect(llm.requests.length - before).toBe(2);
			expect(drivers.at(-1)).toBe(driver);
		},
		DEADLINE_MS * 2,
	);
});
