import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePeerInbound } from "../src/core/normalize";
import { OriginRouter, openBotStore, sessionDirFor } from "../src/core/origin";
import { listSavedSessions, pickSession } from "../src/core/sessions";
import { type InboundRecord, parseCommand, promptTextOf } from "../src/core/types";
import { createLogger } from "../src/log";
import { OmpDriverError } from "../src/omp/driver";
import { FakeOmpDriver, type FakeOmpDriverOptions, FakeSessionStore } from "../src/omp/fake-driver";
import { missingRpcMethods, REQUIRED_RPC_METHODS } from "../src/omp/rpc-driver";
import { redact } from "../src/redact";
import type { Store } from "../src/store/db";

const ORIGIN = "slack/dm/D1";
let dir: string;
let sessionsRoot: string;
let now: number;
let store: Store;
let drivers: FakeOmpDriver[];
let driverOptions: FakeOmpDriverOptions;
let sessionStore: FakeSessionStore;
let idleStopMs: number | undefined;
let usageProvider: ((originKey: string) => Promise<string>) | undefined;
let distillProvider: ((originKey: string) => Promise<string>) | undefined;
let router: OriginRouter;

const clock = { now: () => now };

function makeRouter(): OriginRouter {
	return new OriginRouter({
		timezone: "Asia/Seoul",
		store,
		clock,
		sessionsRoot,
		log: createLogger({ sink: () => undefined, clock, redact }),
		statusProvider: () => "status",
		...(idleStopMs === undefined ? {} : { idleStopMs }),
		...(usageProvider === undefined ? {} : { usageProvider }),
		...(distillProvider === undefined ? {} : { distillProvider }),
		driverFactory: (_origin, sessionDir) => {
			const driver = new FakeOmpDriver({ ...driverOptions, sessionDir, store: sessionStore });
			drivers.push(driver);
			return driver;
		},
	});
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-cmd-"));
	sessionsRoot = join(dir, "sessions");
	now = 1_000_000;
	store = openBotStore(join(dir, "ompbot.db"), clock, "Asia/Seoul");
	drivers = [];
	driverOptions = {};
	sessionStore = new FakeSessionStore();
	idleStopMs = undefined;
	usageProvider = undefined;
	distillProvider = undefined;
	router = makeRouter();
});

afterEach(async () => {
	await router.close();
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
function msg(text: string): InboundRecord {
	const id = `m${++counter}`;
	return { platformMessageId: id, originKey: ORIGIN, ownerVerified: true, text, threadRef: `t-${id}` };
}

/** Routes `text` and returns the reply recorded for its thread. */
async function send(text: string): Promise<string> {
	const record = msg(text);
	await router.route(record);
	return replyIn(record.threadRef);
}

function replyIn(threadRef: string): string {
	return store
		.listDeliveries({ originKey: ORIGIN })
		.filter((d) => d.threadRef === threadRef)
		.map((d) => d.body)
		.join("\n");
}

const lastDriver = (): FakeOmpDriver => {
	const driver = drivers.at(-1);
	if (!driver) throw new Error("no driver started");
	return driver;
};

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

describe("command parsing", () => {
	test("slash form and ! form, arguments only for kinds that take one", () => {
		expect(parseCommand("/model-ompbot fake/beta")).toEqual({ kind: "model", arg: "fake/beta" });
		expect(parseCommand("  !thinking   high ")).toEqual({ kind: "thinking", arg: "high" });
		expect(parseCommand("!followup 다음에\n이것도")).toEqual({ kind: "followup", arg: "다음에\n이것도" });
		expect(parseCommand("/queue-ompbot")).toEqual({ kind: "queue", arg: "" });
		expect(parseCommand("!queue drop 1")).toEqual({ kind: "queue", arg: "drop 1" });
		expect(parseCommand("/queue-ompbot drop 2")).toEqual({ kind: "queue", arg: "drop 2" });
		expect(parseCommand("!queue now")).toEqual({ kind: "queue", arg: "now" });
		expect(parseCommand("/new-ompbot please")).toBeUndefined();
		expect(parseCommand("/model 이거 어때")).toBeUndefined();
		expect(parseCommand("모델 바꿔 !model")).toBeUndefined();
		expect(promptTextOf("/followup-ompbot 테스트 돌려")).toBe("테스트 돌려");
		expect(promptTextOf("그냥 메시지")).toBe("그냥 메시지");
	});

	test("!undo and /undo-ompbot parse as the undo command and take no argument", () => {
		expect(parseCommand("!undo")).toEqual({ kind: "undo", arg: "" });
		expect(parseCommand("/undo-ompbot")).toEqual({ kind: "undo", arg: "" });
		expect(parseCommand("  !undo  ")).toEqual({ kind: "undo", arg: "" });
		expect(parseCommand("/undo-ompbot now")).toBeUndefined();
		expect(parseCommand("undo 해줘")).toBeUndefined();
	});

	test("!brief, /brief-ompbot and !브리핑 parse as the brief command and take no argument", () => {
		expect(parseCommand("!brief")).toEqual({ kind: "brief", arg: "" });
		expect(parseCommand("/brief-ompbot")).toEqual({ kind: "brief", arg: "" });
		expect(parseCommand("!브리핑")).toEqual({ kind: "brief", arg: "" });
		expect(parseCommand("  !brief  ")).toEqual({ kind: "brief", arg: "" });
		// No argument: anything after the word is a prompt, not this command.
		expect(parseCommand("!brief x")).toBeUndefined();
		expect(parseCommand("/brief-ompbot now")).toBeUndefined();
		expect(parseCommand("브리핑 해줘")).toBeUndefined();
	});

	test("!budget and /budget-ompbot take an argument, so off/on reach the command and bare !budget answers totals", () => {
		expect(parseCommand("!budget")).toEqual({ kind: "budget", arg: "" });
		expect(parseCommand("!budget off")).toEqual({ kind: "budget", arg: "off" });
		expect(parseCommand("!budget on")).toEqual({ kind: "budget", arg: "on" });
		expect(parseCommand(" /budget-ompbot off ")).toEqual({ kind: "budget", arg: "off" });
		// A bare `!budget` in the middle of a sentence is a prompt, not a command.
		expect(parseCommand("예산 보려면 !budget")).toBeUndefined();
	});
});

describe("① model and thinking", () => {
	test("list shows the current model; a unique fragment switches it and the choice is stored", async () => {
		const listed = await send("/model-ompbot");
		expect(listed).toContain("현재 모델: fake/alpha");
		expect(listed).toContain("2. fake/beta");
		await send("!model beta");
		expect(lastDriver().calls).toContain("setModel:fake/beta");
		expect(store.getOrigin(ORIGIN)?.model).toBe("fake/beta");
		expect(await send("/model-ompbot")).toContain("현재 모델: fake/beta");
	});

	test("an ambiguous or unknown model changes nothing", async () => {
		const ambiguous = await send("/model-ompbot fake");
		expect(ambiguous).toContain("하나로 고를 수 없습니다");
		expect(ambiguous.split("\n").slice(-2)).toEqual(["fake/alpha", "fake/beta"]);
		expect(await send("/model-ompbot gamma")).toContain("하나로 고를 수 없습니다");
		expect(lastDriver().calls.some((c) => c.startsWith("setModel:"))).toBe(false);
		expect(store.getOrigin(ORIGIN)?.model).toBeNull();
	});

	test("thinking accepts only the model's levels", async () => {
		expect(await send("/thinking-ompbot")).toContain("가능: off, low, medium, high");
		expect(await send("/thinking-ompbot ultra")).toContain("지원하지 않습니다");
		await send("/thinking-ompbot HIGH");
		expect(lastDriver().calls).toContain("setThinking:high");
		expect(store.getOrigin(ORIGIN)?.thinking).toBe("high");
	});

	test("switching is refused while a turn runs", async () => {
		driverOptions = { holdTurns: true };
		await router.route(msg("long job"));
		expect(await send("/model-ompbot fake/beta")).toContain("작업 중에는");
		expect(await send("/thinking-ompbot low")).toContain("작업 중에는");
		expect(lastDriver().calls.filter((c) => c.startsWith("set"))).toEqual([]);
	});
});

describe("② compact and resume", () => {
	test("compact runs while idle and reports the size before", async () => {
		await router.route(msg("hello"));
		await router.mailbox(ORIGIN).sweepIdle();
		const reply = await send("/compact-ompbot 결정 사항만 남겨");
		expect(lastDriver().calls).toContain("compact:결정 사항만 남겨");
		expect(reply).toContain("압축했습니다");
		expect(reply).toContain("400 토큰"); // seed(2) + user + assistant = 4 entries x 100
	});

	test("an agy compact refusal is answered as a notice, not a failed turn (qa50b L-4)", async () => {
		await router.route(msg("hello"));
		await router.mailbox(ORIGIN).sweepIdle();
		lastDriver().compact = () =>
			Promise.reject(new OmpDriverError("rpc_error", "agy 세션은 compact를 지원하지 않습니다"));
		const reply = await send("/compact-ompbot");
		expect(reply).toContain("agy 세션은 compact를 지원하지 않습니다");
		expect(reply).not.toContain("[turn failed]");
	});

	test("resume in an agy session says the list is unsupported instead of 'no saved sessions' (qa50b L-4)", async () => {
		await router.route(msg("hello"));
		await router.mailbox(ORIGIN).sweepIdle();
		const sessionDir = store.getOrigin(ORIGIN)?.sessionDir;
		if (sessionDir === undefined) throw new Error("origin not created");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(join(sessionDir, "agy-conversation.json"), JSON.stringify({ conversationId: "c1" }));
		const reply = await send("/resume-ompbot");
		expect(reply).toContain("agy 세션은 저장된 세션 목록·이어가기를 지원하지 않습니다");
		expect(reply).not.toContain("저장된 세션이 없습니다");
	});

	test("compact is refused while a turn runs", async () => {
		driverOptions = { holdTurns: true };
		await router.route(msg("long job"));
		expect(await send("/compact-ompbot")).toContain("작업 중에는");
		expect(lastDriver().calls.some((c) => c.startsWith("compact"))).toBe(false);
	});

	function writeSession(epochDir: string, id: string, firstUser: string, mtimeSec: number): string {
		const dirPath = join(sessionDirFor(sessionsRoot, ORIGIN, 1), "..", epochDir);
		mkdirSync(dirPath, { recursive: true });
		const file = join(dirPath, `2026_${id}.jsonl`);
		const lines = [
			{ type: "title", v: 1, title: "" },
			{ type: "session", version: 3, id, timestamp: "2026-10-01T00:00:00Z" },
			{ type: "message", id: "a", message: { role: "user", content: [{ type: "text", text: firstUser }] } },
		];
		writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
		utimesSync(file, mtimeSec, mtimeSec);
		return file;
	}

	test("list is newest first; picking one pins its file and the next prompt runs in that session", async () => {
		const old = writeSession("e1", "11111111-aaaa", "옛날 작업", 1_700_000_000);
		writeSession("e2", "22222222-bbbb", "최근 작업", 1_800_000_000);
		const listed = await send("/resume-ompbot");
		expect(listed.split("\n").slice(0, 2)).toEqual([
			expect.stringContaining("1. 22222222"),
			expect.stringContaining("2. 11111111"),
		]);
		expect(listed).toContain("옛날 작업");
		const epochBefore = store.getOrigin(ORIGIN)?.epoch ?? 0;

		expect(await send("/resume-ompbot 1111")).toContain("이어갑니다");
		const origin = store.getOrigin(ORIGIN);
		expect(origin?.sessionFile).toBe(old);
		expect(origin?.epoch).toBe(epochBefore + 1);
		expect(lastDriver().calls).toContain(`switchSession:${old}`);

		await router.route(msg("이어서 해줘"));
		const session = sessionStore.sessions.get(old);
		expect(session?.entries.some((e) => JSON.stringify(e.message ?? "").includes("이어서 해줘"))).toBe(true);
	});

	test("unknown pick changes nothing", async () => {
		writeSession("e1", "11111111-aaaa", "옛날 작업", 1_700_000_000);
		expect(await send("/resume-ompbot 9")).toContain("찾지 못했습니다");
		expect(store.getOrigin(ORIGIN)?.sessionFile).toBeNull();
	});

	test("pickSession: index, unique id prefix of 4+ chars", () => {
		const sessions = [
			{ file: "a", id: "abcd1", epochDir: "e1", modifiedAt: 2, preview: "" },
			{ file: "b", id: "abce2", epochDir: "e1", modifiedAt: 1, preview: "" },
		];
		expect(pickSession(sessions, "2")?.file).toBe("b");
		expect(pickSession(sessions, "abcd")?.file).toBe("a");
		expect(pickSession(sessions, "abc")).toBeUndefined();
		expect(pickSession(sessions, "0")).toBeUndefined();
		expect(listSavedSessions(join(dir, "missing"))).toEqual([]);
	});
});

describe("③ idle release", () => {
	test("an idle child is stopped, the session stays, and chat settings come back with the next child", async () => {
		idleStopMs = 60_000;
		await router.close();
		router = makeRouter();
		await send("/model-ompbot fake/beta");
		await send("/thinking-ompbot low");
		await router.route(msg("first"));
		const first = lastDriver();
		const sessionId = (await first.state()).sessionId;
		now += 60_000;
		expect(await router.mailbox(ORIGIN).sweepIdle()).toBe(true);
		expect(router.mailbox(ORIGIN).state.driverRunning).toBe(false);
		expect(await send("/queue-ompbot")).toContain("쉬는 중");

		await router.route(msg("second"));
		const second = lastDriver();
		expect(second).not.toBe(first);
		expect(second.calls.slice(0, 3)).toEqual(["openSession", "setModel:fake/beta", "setThinking:low"]);
		expect((await second.state()).sessionId).toBe(sessionId);
	});

	test("a quiet child is kept before the timeout and always when the timeout is 0", async () => {
		idleStopMs = 60_000;
		await router.close();
		router = makeRouter();
		await router.route(msg("first"));
		now += 59_999;
		expect(await router.mailbox(ORIGIN).sweepIdle()).toBe(false);
		idleStopMs = 0;
		await router.close();
		router = makeRouter();
		await router.route(msg("again"));
		now += 10 * 24 * 3_600_000;
		expect(await router.mailbox(ORIGIN).sweepIdle()).toBe(false);
	});
});

describe("④ queue and followup", () => {
	test("followup waits for the running turn while plain messages are still steered; queue shows both", async () => {
		driverOptions = { holdTurns: true };
		const a = msg("A 작업");
		await router.route(a);
		const followup = msg("/followup-ompbot B 작업");
		await router.route(followup);
		await router.route(msg("A에 덧붙임"));
		const driver = lastDriver();
		expect(driver.calls.filter((c) => c.startsWith("prompt:") || c.startsWith("steer:"))).toEqual([
			"prompt:A 작업",
			"steer:A에 덧붙임",
		]);
		expect(store.getInbound(followup.platformMessageId)?.state).toBe("pending");

		const queue = await send("/queue-ompbot");
		expect(queue).toContain("▶ 진행 중");
		expect(queue).toContain("1. [다음 작업] B 작업");

		await untilFinal(driver, () => driver.release());
		expect(replyIn(a.threadRef)).toBe("ECHO A 작업 | A에 덧붙임");
		expect(driver.calls.filter((c) => c.startsWith("prompt:"))).toEqual(["prompt:A 작업", "prompt:B 작업"]);
		await untilFinal(driver, () => driver.release());
		expect(replyIn(followup.threadRef)).toBe("ECHO B 작업");
	});

	test("followup while idle starts a turn at once; without text it explains usage", async () => {
		const record = msg("!followup 바로 실행");
		await router.route(record);
		await router.mailbox(ORIGIN).sweepIdle();
		expect(replyIn(record.threadRef)).toBe("ECHO 바로 실행");
		expect(await send("/followup-ompbot")).toContain("사용법");
	});

	test("queue drop cancels one waiting followup; the rest of the queue still runs", async () => {
		driverOptions = { holdTurns: true };
		const a = msg("A 작업");
		await router.route(a);
		const keep = msg("/followup-ompbot 남길 작업");
		await router.route(keep);
		const drop = msg("/followup-ompbot 버릴 작업");
		await router.route(drop);
		const driver = lastDriver();

		const reply = await send("!queue drop 2");
		expect(reply).toContain("🚫 대기 2번을 취소했습니다");
		expect(reply).toContain("[다음 작업] 버릴 작업");
		const dropped = store.getInbound(drop.platformMessageId);
		expect(dropped?.state).toBe("discarded");
		expect(dropped?.opRef).toContain("queue:");
		expect(await send("/queue-ompbot")).toContain("1. [다음 작업] 남길 작업");

		await untilFinal(driver, () => driver.release());
		await untilFinal(driver, () => driver.release());
		expect(driver.calls.filter((c) => c.startsWith("prompt:"))).toEqual(["prompt:A 작업", "prompt:남길 작업"]);
		expect(replyIn(keep.threadRef)).toBe("ECHO 남길 작업");
		expect(replyIn(drop.threadRef)).toBe("");
	});

	test("queue drop with an unknown number or a wrong tail explains itself and drops nothing", async () => {
		driverOptions = { holdTurns: true };
		await router.route(msg("A 작업"));
		await router.route(msg("/followup-ompbot B 작업"));
		expect(await send("!queue drop 5")).toContain("대기 5번이 없습니다");
		expect(await send("!queue drop")).toContain("사용법");
		expect(await send("!queue 지워줘")).toContain("사용법");
		expect(await send("!queue")).toContain("drop <번호>");
		expect(store.listInbound({ originKey: ORIGIN, state: "pending" })).toHaveLength(1);
	});
});

describe("⑤ omp compatibility check", () => {
	test("reports exactly the RpcClient methods ompbot needs but the class lacks", () => {
		class Partial {
			prompt(): void {}
			steer(): void {}
		}
		const missing = missingRpcMethods(Partial);
		expect(missing).not.toContain("prompt");
		expect(missing).toContain("compact");
		expect(missing).toHaveLength(REQUIRED_RPC_METHODS.length - 2);
		class Full {}
		for (const name of REQUIRED_RPC_METHODS) Object.defineProperty(Full.prototype, name, { value: () => undefined });
		expect(missingRpcMethods(Full)).toEqual([]);
		expect(missingRpcMethods(undefined)).toEqual([...REQUIRED_RPC_METHODS]);
	});
});

describe("⑤ usage", () => {
	test("!usage and /usage-ompbot parse without an argument", () => {
		expect(parseCommand("!usage")).toEqual({ kind: "usage", arg: "" });
		expect(parseCommand(" /usage-ompbot ")).toEqual({ kind: "usage", arg: "" });
		expect(parseCommand("!usage 오늘")).toBeUndefined();
	});

	test("answers from the provider while a turn runs, without prompting omp", async () => {
		await router.close();
		const asked: string[] = [];
		usageProvider = async (originKey) => {
			asked.push(originKey);
			return "이 대화: 모델 호출 1회";
		};
		driverOptions = { holdTurns: true };
		router = makeRouter();
		await router.route(msg("long job"));
		const prompts = lastDriver().calls.filter((c) => c.startsWith("prompt:")).length;
		expect(await send("!usage")).toBe("이 대화: 모델 호출 1회");
		expect(await send("/usage-ompbot")).toBe("이 대화: 모델 호출 1회");
		expect(asked).toEqual([ORIGIN, ORIGIN]);
		expect(lastDriver().calls.filter((c) => c.startsWith("prompt:")).length).toBe(prompts);
		expect(lastDriver().calls.filter((c) => c.startsWith("steer:"))).toEqual([]);
	});

	test("without a provider it says the count is not wired", async () => {
		expect(await send("!usage")).toBe("사용량 집계가 연결되지 않았습니다");
	});
});

describe("⑥ distill", () => {
	test("!distill and /distill-ompbot parse without an argument; a peer bot's fenced text never parses as it", () => {
		expect(parseCommand("!distill")).toEqual({ kind: "distill", arg: "" });
		expect(parseCommand(" /distill-ompbot ")).toEqual({ kind: "distill", arg: "" });
		expect(parseCommand("!distill 지금")).toBeUndefined();
		const peer = normalizePeerInbound({
			peer: { userId: "UPEER00001", name: "떡" },
			text: "!distill",
			quoted: [],
			channel: "C1",
			ts: "1.1",
		});
		if (!peer.accept) throw new Error("rejected");
		expect(parseCommand(peer.inbound.text)).toBeUndefined();
	});

	test("answers from the provider with this origin's key, without prompting omp", async () => {
		await router.close();
		const asked: string[] = [];
		distillProvider = async (originKey) => {
			asked.push(originKey);
			return "스킬 리뷰를 시작했습니다";
		};
		router = makeRouter();
		expect(await send("!distill")).toBe("스킬 리뷰를 시작했습니다");
		expect(asked).toEqual([ORIGIN]);
		expect(drivers.flatMap((d) => d.calls).filter((c) => c.startsWith("prompt:"))).toEqual([]);
	});

	test("without a provider it says the review is not wired", async () => {
		expect(await send("!distill")).toBe("스킬 리뷰가 연결되지 않았습니다");
	});
});
