import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OriginRouter, openBotStore } from "../src/core/origin";
import { type InboundRecord, parseCommand, promptTextOf } from "../src/core/types";
import { NamespacedDriver } from "../src/daemon/opref";
import { createLogger } from "../src/log";
import { OmpDriverError } from "../src/omp/driver";
import { FakeOmpDriver, type FakeOmpDriverOptions, FakeSessionStore } from "../src/omp/fake-driver";
import { REQUIRED_RPC_METHODS, RpcOmpDriver } from "../src/omp/rpc-driver";
import { redact } from "../src/redact";
import type { Store } from "../src/store/db";

const ORIGIN = "slack/dm/D1";
const clock = { now: () => 1_000_000 };

/** A fake driver that supports side questions: every `btw` call stays open until the test settles it. */
class BtwFakeDriver extends FakeOmpDriver {
	readonly btwCalls: string[] = [];
	readonly asked: Array<PromiseWithResolvers<string>> = [];

	btw(question: string): Promise<string> {
		this.btwCalls.push(question);
		const answer = Promise.withResolvers<string>();
		this.asked.push(answer);
		return answer.promise;
	}
}

let dir: string;
let store: Store;
let router: OriginRouter;
let drivers: FakeOmpDriver[];
let driverOptions: FakeOmpDriverOptions;
let supportsBtw: boolean;
let counter = 0;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-btw-"));
	store = openBotStore(join(dir, "ompbot.db"), clock);
	drivers = [];
	driverOptions = { holdTurns: true };
	supportsBtw = true;
	const sessionStore = new FakeSessionStore();
	router = new OriginRouter({
		store,
		clock,
		sessionsRoot: join(dir, "sessions"),
		log: createLogger({ sink: () => undefined, clock, redact }),
		statusProvider: () => "status",
		driverFactory: (_origin, sessionDir) => {
			const options = { ...driverOptions, sessionDir, store: sessionStore };
			const driver = supportsBtw ? new BtwFakeDriver(options) : new FakeOmpDriver(options);
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

function msg(text: string): InboundRecord {
	const id = `b${++counter}`;
	return { platformMessageId: id, originKey: ORIGIN, ownerVerified: true, text, threadRef: `t-${id}` };
}

function replyIn(threadRef: string): string {
	return store
		.listDeliveries({ originKey: ORIGIN })
		.filter((d) => d.threadRef === threadRef)
		.map((d) => d.body)
		.join("\n");
}

function btwDriver(): BtwFakeDriver {
	const driver = drivers.at(-1);
	if (!(driver instanceof BtwFakeDriver)) throw new Error("no btw driver started");
	return driver;
}

function plainDriver(): FakeOmpDriver {
	const driver = drivers.at(-1);
	if (!driver) throw new Error("no driver started");
	return driver;
}

/** Run `action` and wait until the driver's next final has been handled by the mailbox. */
async function untilFinal(driver: FakeOmpDriver, action: () => void): Promise<void> {
	const seen = Promise.withResolvers<void>();
	const off = driver.onFinal(() => {
		off();
		seen.resolve();
	});
	action();
	await seen.promise;
	await router.mailbox(ORIGIN).sweepIdle(); // queued behind the final handler on the actor chain
}

const steers = (driver: FakeOmpDriver): string[] => driver.calls.filter((call) => call.startsWith("steer:"));
const prompts = (driver: FakeOmpDriver): string[] => driver.calls.filter((call) => call.startsWith("prompt:"));

describe("AC-1 btw command parsing", () => {
	test("!btw and /btw-ompbot parse as the btw command and carry the question", () => {
		expect(parseCommand("!btw 왜 멈췄어?")).toEqual({ kind: "btw", arg: "왜 멈췄어?" });
		expect(parseCommand("/btw-ompbot 왜")?.kind).toBe("btw");
		expect(parseCommand("!btw")).toEqual({ kind: "btw", arg: "" });
		expect(promptTextOf("!btw 왜 멈췄어?")).toBe("왜 멈췄어?");
	});

	test("NamespacedDriver forwards btw only when the wrapped driver has it", async () => {
		const inner = new BtwFakeDriver();
		const wrapped = new NamespacedDriver(inner, "p1");
		const answer = wrapped.btw?.("질문");
		expect(inner.btwCalls).toEqual(["질문"]);
		inner.asked[0]?.resolve("답");
		expect(await answer).toBe("답");
		expect(new NamespacedDriver(new FakeOmpDriver(), "p2").btw).toBeUndefined();
	});
});

describe("AC-2 side question during a turn", () => {
	test("asks the driver once, never steers, answers in the question's thread and leaves the turn running", async () => {
		const first = msg("long job");
		await router.route(first);
		const question = msg("!btw 질문");
		await router.route(question);
		const driver = btwDriver();
		expect(driver.btwCalls).toEqual(["질문"]);
		expect(steers(driver)).toEqual([]);
		expect(store.getInbound(question.platformMessageId)?.opRef).toBe(`btw:${question.platformMessageId}`);

		const asked = driver.asked[0];
		if (!asked) throw new Error("btw was not asked");
		asked.resolve("지금 테스트를 돌리는 중");
		await asked.promise;
		expect(replyIn(question.threadRef)).toBe("💬 곁질문: 지금 테스트를 돌리는 중");
		expect(replyIn(first.threadRef)).toBe("");
		expect(router.mailbox(ORIGIN).state.busy).toBe(true);

		await untilFinal(driver, () => driver.release());
		expect(replyIn(first.threadRef)).toBe("ECHO long job");
		expect(prompts(driver)).toEqual(["prompt:long job"]);
	});

	test("a failed side question leaves a failure notice in its thread and the turn keeps running", async () => {
		const first = msg("long job");
		await router.route(first);
		const question = msg("!btw 질문");
		await router.route(question);
		const driver = btwDriver();
		const asked = driver.asked[0];
		if (!asked) throw new Error("btw was not asked");
		asked.reject(new OmpDriverError("rpc_error", "A /btw question is still running; cancel it first"));
		await asked.promise.catch(() => undefined);
		expect(replyIn(question.threadRef)).toContain("[turn failed] btw: A /btw question is still running");
		expect(router.mailbox(ORIGIN).state.busy).toBe(true);
		await untilFinal(driver, () => driver.release());
		expect(replyIn(first.threadRef)).toBe("ECHO long job");
	});
});

describe("AC-3 a pending side question does not hold the mailbox chain", () => {
	test("a later message is steered and the turn's final is handled while btw is still open", async () => {
		const first = msg("long job");
		await router.route(first);
		const question = msg("!btw 질문");
		await router.route(question);
		const driver = btwDriver();
		const asked = driver.asked[0];
		if (!asked) throw new Error("btw was not asked");

		// The side question is still open: the next message's enqueue resolves and it is steered.
		const extra = msg("추가 지시");
		await router.route(extra);
		expect(steers(driver)).toEqual(["steer:추가 지시"]);

		// Still open: the turn's final is handled and its answer recorded.
		await untilFinal(driver, () => driver.release());
		expect(replyIn(first.threadRef)).toBe("ECHO long job | 추가 지시");
		expect(router.mailbox(ORIGIN).state.busy).toBe(false);
		expect(replyIn(question.threadRef)).toBe("");

		// Only now does the side question finish; its answer lands in its own thread.
		asked.resolve("답");
		await asked.promise;
		expect(replyIn(question.threadRef)).toBe("💬 곁질문: 답");
		expect(driver.btwCalls).toEqual(["질문"]);
	});
});

describe("AC-4 no turn, unsupported driver, missing question", () => {
	test("without a running turn the question starts a normal turn, without the !btw word", async () => {
		driverOptions = {};
		const question = msg("!btw 질문");
		await router.route(question);
		const driver = btwDriver();
		expect(driver.btwCalls).toEqual([]);
		expect(prompts(driver)).toEqual(["prompt:질문"]);
		await router.mailbox(ORIGIN).sweepIdle();
		expect(replyIn(question.threadRef)).toBe("ECHO 질문");
	});

	test("a driver without btw answers that side questions are unsupported and nothing is steered", async () => {
		supportsBtw = false;
		await router.route(msg("long job"));
		const question = msg("!btw 질문");
		await router.route(question);
		expect(replyIn(question.threadRef)).toBe("이 대화의 에이전트는 곁질문을 지원하지 않습니다.");
		expect(steers(plainDriver())).toEqual([]);
		expect(prompts(plainDriver())).toEqual(["prompt:long job"]);
	});

	test("!btw without a question answers with the usage, with or without a turn", async () => {
		driverOptions = {};
		const idle = msg("!btw");
		await router.route(idle);
		expect(replyIn(idle.threadRef)).toContain("사용법: `!btw <질문>`");
		expect(drivers).toEqual([]);

		driverOptions = { holdTurns: true };
		await router.route(msg("long job"));
		const busy = msg("/btw-ompbot");
		await router.route(busy);
		expect(replyIn(busy.threadRef)).toContain("사용법: `!btw <질문>`");
		expect(btwDriver().btwCalls).toEqual([]);
		expect(steers(btwDriver())).toEqual([]);
	});
});

/**
 * RpcClient stand-in for `RpcOmpDriver.start()` (it imports `<packageRoot>/src/modes/rpc/rpc-client.ts`): every
 * required method is a no-op, and the side-question surface is driven by hand — `btw()` stays open until
 * `answerBtw`/`failBtw`, `emitBtwRecord` plays a `btw_record` frame.
 */
const FAKE_RPC_CLIENT_SOURCE = `
export class RpcClient {
	static instances = [];
	btwCalls = [];
	cancelCalls = [];
	listeners = new Set();
	listenersAtBtwCall = -1;
	response = Promise.withResolvers();
	constructor() {
		RpcClient.instances.push(this);
	}
	onBtwRecord(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	emitBtwRecord(record) {
		for (const listener of [...this.listeners]) listener(record);
	}
	btw(...args) {
		this.btwCalls.push(args);
		this.listenersAtBtwCall = this.listeners.size;
		return this.response.promise;
	}
	answerBtw(record) {
		this.response.resolve(record);
	}
	failBtw(message) {
		this.response.reject(Object.assign(new Error(message), { name: "RpcCommandError" }));
	}
	async cancelBtw(...args) {
		this.cancelCalls.push(args);
		return true;
	}
}
for (const name of ${JSON.stringify(REQUIRED_RPC_METHODS)}) {
	RpcClient.prototype[name] = name.startsWith("on") ? () => () => undefined : async () => undefined;
}
`;

interface BtwRecord {
	id: string;
	status: string;
	answer: string;
	error?: string;
}

interface FakeRpcClient {
	btwCalls: unknown[][];
	cancelCalls: unknown[][];
	listeners: Set<unknown>;
	listenersAtBtwCall: number;
	emitBtwRecord(record: BtwRecord): void;
	answerBtw(record: BtwRecord): void;
	failBtw(message: string): void;
}

const record = (id: string, status: string, answer = "", error?: string): BtwRecord =>
	error === undefined ? { id, status, answer } : { id, status, answer, error };

describe("AC-5 RpcOmpDriver.btw", () => {
	let root: string;
	let driver: RpcOmpDriver;
	let client: FakeRpcClient;

	async function startDriver(btwTimeoutMs?: number): Promise<void> {
		root = mkdtempSync(join(tmpdir(), "ompbot-btw-rpc-"));
		const bin = join(root, "pkg", "bin");
		mkdirSync(bin, { recursive: true });
		const ompExecutable = join(bin, "omp");
		writeFileSync(ompExecutable, "#!/bin/sh\nexit 1\n"); // never executed; only realpath'ed and stat'ed
		chmodSync(ompExecutable, 0o755);
		const packageRoot = dirname(dirname(realpathSync(ompExecutable)));
		const clientModule = join(packageRoot, "src/modes/rpc/rpc-client.ts");
		mkdirSync(dirname(clientModule), { recursive: true });
		writeFileSync(clientModule, FAKE_RPC_CLIENT_SOURCE);
		const utilsDir = join(packageRoot, "node_modules/@oh-my-pi/pi-utils");
		mkdirSync(utilsDir, { recursive: true });
		writeFileSync(join(utilsDir, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-utils", main: "index.js" }));
		writeFileSync(join(utilsDir, "index.js"), "export const ptree = { spawn() { throw new Error('no spawn'); } };\n");
		driver = new RpcOmpDriver({
			ompExecutable,
			cwd: root,
			sessionDir: join(root, "s"),
			bunExecutable: process.execPath,
			...(btwTimeoutMs === undefined ? {} : { btwTimeoutMs }),
		});
		await driver.start();
		// Dynamic import: the fixture module is written to a temp dir above, the same instance the driver loaded.
		const fixture = (await import(clientModule)) as { RpcClient: { instances: FakeRpcClient[] } };
		const instance = fixture.RpcClient.instances.at(-1);
		if (!instance) throw new Error("fake RpcClient was not constructed");
		client = instance;
	}

	afterEach(async () => {
		await driver.stop();
		rmSync(root, { recursive: true, force: true });
	});

	test("subscribes before asking and returns the trimmed answer of the complete record", async () => {
		await startDriver();
		const answer = driver.btw("질문");
		expect(client.btwCalls).toEqual([["질문"]]);
		expect(client.listenersAtBtwCall).toBe(1);
		client.emitBtwRecord(record("r1", "running"));
		client.answerBtw(record("r1", "running"));
		await Promise.resolve(); // the response continuation runs before the next frame, as on the wire
		client.emitBtwRecord(record("r2", "complete", "다른 곁질문"));
		client.emitBtwRecord(record("r1", "running", "부분"));
		client.emitBtwRecord(record("r1", "complete", "  답입니다\n"));
		expect(await answer).toBe("답입니다");
		expect(client.listeners.size).toBe(0);
		expect(client.cancelCalls).toEqual([]);
	});

	test("frames that arrive before the btw() response: running is ignored, the terminal one is kept", async () => {
		await startDriver();
		const answer = driver.btw("질문");
		client.emitBtwRecord(record("r0", "complete", "남의 답"));
		client.emitBtwRecord(record("r1", "running"));
		client.emitBtwRecord(record("r1", "complete", "먼저 온 답"));
		client.answerBtw(record("r1", "running"));
		expect(await answer).toBe("먼저 온 답");
		expect(client.listeners.size).toBe(0);
	});

	test("an empty answer becomes (빈 답)", async () => {
		await startDriver();
		const answer = driver.btw("질문");
		client.answerBtw(record("r1", "running"));
		await Promise.resolve();
		client.emitBtwRecord(record("r1", "complete", "  \n"));
		expect(await answer).toBe("(빈 답)");
	});

	for (const status of ["error", "cancelled", "interrupted"]) {
		test(`a ${status} record rejects with OmpDriverError naming the status and reason`, async () => {
			await startDriver();
			const answer = driver.btw("질문");
			client.emitBtwRecord(record("r1", "running"));
			client.emitBtwRecord(record("r1", status, "", "모델 호출 실패"));
			client.answerBtw(record("r1", "running"));
			const error = await answer.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(OmpDriverError);
			expect(String(error)).toContain(status);
			expect(String(error)).toContain("모델 호출 실패");
			expect(client.listeners.size).toBe(0);
		});
	}

	test("a rejected btw() command rejects with OmpDriverError", async () => {
		await startDriver();
		const answer = driver.btw("질문");
		client.failBtw("A /btw question is still running; cancel it first");
		const error = await answer.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(OmpDriverError);
		expect(String(error)).toContain("still running");
		expect(client.cancelCalls).toEqual([]);
		expect(client.listeners.size).toBe(0);
	});

	test("a timeout after the id is known cancels that record", async () => {
		await startDriver(5);
		const answer = driver.btw("질문");
		client.answerBtw(record("r1", "running"));
		const error = await answer.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(OmpDriverError);
		expect(String(error)).toContain("btw timeout");
		expect(client.cancelCalls).toEqual([["r1"]]);
		expect(client.listeners.size).toBe(0);
	});

	test("a timeout before the btw() response cancels without an id", async () => {
		await startDriver(5);
		const error = await driver.btw("질문").catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(OmpDriverError);
		expect(String(error)).toContain("btw timeout");
		expect(client.cancelCalls).toEqual([[]]);
		expect(client.listeners.size).toBe(0);
	});
});
