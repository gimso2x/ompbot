// Slack-side thread context (plan teo-style-companion todo 3): a peer bot's request carries the thread root plus what
// followed this bot's last post; the owner's first reply to a thread this bot opened carries the root post (DM and
// channel alike); a Slack failure only costs the context. The daemon runs for real with the fake omp driver and the
// fake transport's canned `conversations.replies`; waits are on posts and log lines (bounded), never sleeps.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { THREAD_CONTEXT_HEADER } from "../src/core/mailbox";
import { Daemon } from "../src/daemon/daemon";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { SlackChannel } from "../src/slack/channel";
import type { HistoryMessage, SlackMessageEvent } from "../src/slack/transport";
import { makeHome, OWNER, type TestHome, WaitingTransport } from "./helpers/bot-home";

const BOT = "UBOT";
const PEER = "UPEER00001";
const CH = "C0CTX00001";
const DM = "D0CTX00001";

describe("daemon: Slack thread context", () => {
	let home: TestHome;
	let daemon: Daemon | undefined;
	let transport: WaitingTransport;
	let drivers: FakeOmpDriver[];
	let lines: string[];

	async function boot(hold = false, threadContextTimeoutMs?: number): Promise<void> {
		transport = new WaitingTransport(BOT);
		const sessions = new FakeSessionStore();
		const clock = { now: () => Date.now() };
		daemon = new Daemon({
			config: {
				...home.config,
				mentionFreeChannels: [CH],
				peerBots: [{ userId: PEER, name: "떡" }],
			},
			slack: new SlackChannel(transport),
			clock,
			log: createLogger({
				sink: (line) => {
					lines.push(line);
					for (const wake of waiters) wake();
				},
				clock,
				redact,
			}),
			ompVersion: "omp-test 0",
			bootId: "boot-ctx",
			...(threadContextTimeoutMs === undefined ? {} : { threadContextTimeoutMs }),
			stopDrainMs: 0,
			sweepMs: 3_600_000,
			gateSweepMs: 0,
			taskSweepMs: 0,
			driverFactory: (_origin, sessionDir) => {
				const driver = new FakeOmpDriver({ sessionDir, store: sessions, holdTurns: hold });
				drivers.push(driver);
				return driver;
			},
		});
		await daemon.start();
	}

	const waiters = new Set<() => void>();
	/** Resolves once `done()` holds, re-checked on every daemon log line (bounded, no polling). */
	const waitUntil = (done: () => boolean, what: string, timeoutMs = 5_000): Promise<void> => {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const check = () => {
			if (!done()) return;
			waiters.delete(check);
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			waiters.delete(check);
			reject(new Error(`timed out waiting for ${what}`));
		}, timeoutMs);
		waiters.add(check);
		check();
		return promise;
	};
	const prompts = (): string[] =>
		drivers.flatMap((d) => d.calls.filter((c) => c.startsWith("prompt:")).map((c) => c.slice("prompt:".length)));
	const msg = (ts: string, user: string, text: string): HistoryMessage => ({ ts, user, text });
	const owner = (channel: string, type: string, ts: string, text: string, thread: string): SlackMessageEvent => ({
		type: "message",
		channel,
		channel_type: type,
		user: OWNER,
		text,
		ts,
		thread_ts: thread,
	});

	beforeEach(() => {
		home = makeHome("ompbot-ctx-");
		drivers = [];
		lines = [];
		daemon = undefined;
	});

	afterEach(async () => {
		await daemon?.stop();
		home.remove();
	});

	test("(a) a peer request carries the root and the messages after this bot's last post, fenced, minus this bot's own", async () => {
		await boot();
		transport.threads.set(`${CH}:100.1`, [
			msg("100.1", OWNER, "ROOT 계획 초안 써 줘"),
			msg("100.2", BOT, "BOTONE 초안입니다"),
			msg("100.3", OWNER, "BEFORELAST 보완해 줘"),
			msg("100.4", BOT, "BOTTWO 수정본입니다"),
			msg("100.5", "U0HUMAN0001", "AFTERLAST 이 부분이 약해요"),
			msg("100.6", PEER, `<@${BOT}> PEERASK 검토해 줘`),
		]);
		await transport.emitMessage({
			type: "message",
			channel: CH,
			channel_type: "channel",
			user: PEER,
			bot_id: "B0PEER0001",
			text: `<@${BOT}> PEERASK 검토해 줘`,
			ts: "100.6",
			thread_ts: "100.1",
		});
		await transport.waitForPosts((text) => text.includes("ECHO"));
		const prompt = prompts()[0] ?? "";
		expect(prompt).toContain(THREAD_CONTEXT_HEADER);
		expect(prompt).toContain("ROOT 계획 초안 써 줘");
		expect(prompt).toContain("AFTERLAST 이 부분이 약해요");
		expect(prompt).not.toContain("BOTONE");
		expect(prompt).not.toContain("BOTTWO");
		expect(prompt).not.toContain("BEFORELAST");
		// Every thread message is inside a quoted fence, and the context comes before the request marker.
		const context = prompt.slice(0, prompt.indexOf("[현재 요청]"));
		expect(context).toMatch(/<<<quoted-[0-9a-f]{16}>>>\n\[UOWNER [^\]]+\]\nROOT 계획 초안 써 줘\n<<<end-quoted-/);
		expect(context).toMatch(/<<<quoted-[0-9a-f]{16}>>>\n\[U0HUMAN0001 [^\]]+\]\nAFTERLAST/);
		expect(transport.replyCalls).toEqual([{ channel: CH, ts: "100.1", limit: undefined }]);
	});

	test("(a) a peer request that opens the thread fetches nothing", async () => {
		await boot();
		await transport.emitMessage({
			type: "message",
			channel: CH,
			channel_type: "channel",
			user: PEER,
			bot_id: "B0PEER0001",
			text: `<@${BOT}> 새 스레드 요청`,
			ts: "110.1",
		});
		await transport.waitForPosts((text) => text.includes("ECHO"));
		expect(prompts()[0] ?? "").not.toContain(THREAD_CONTEXT_HEADER);
		expect(transport.replyCalls).toEqual([]);
	});

	test("(b) DM: the first owner reply under a bot-posted root carries the root; the second does not", async () => {
		await boot();
		transport.threads.set(`${DM}:200.1`, [msg("200.1", BOT, "⏰ ROOTPOST 오늘 무엇을 하실 건가요?")]);
		await transport.emitMessage(owner(DM, "im", "200.2", "FIRSTREPLY 회의요", "200.1"));
		await transport.waitForPosts((text) => text.includes("ECHO"), 1);
		await transport.emitMessage(owner(DM, "im", "200.3", "SECONDREPLY 그리고 점심", "200.1"));
		await transport.waitForPosts((text) => text.includes("ECHO"), 2);
		const [first, second] = prompts();
		expect(first).toContain(THREAD_CONTEXT_HEADER);
		expect(first).toContain("ROOTPOST 오늘 무엇을 하실 건가요?");
		expect(first?.endsWith("\n\n[현재 요청]\nFIRSTREPLY 회의요")).toBe(true);
		expect(second).toBe("SECONDREPLY 그리고 점심");
		expect(transport.replyCalls).toEqual([{ channel: DM, ts: "200.1", limit: 1 }]);
	});

	test("(b) channel thread: the same rule", async () => {
		await boot();
		transport.threads.set(`${CH}:300.1`, [msg("300.1", BOT, "ROOTPOST 채널 질문입니다")]);
		await transport.emitMessage(owner(CH, "channel", "300.2", "FIRSTREPLY 답입니다", "300.1"));
		await transport.waitForPosts((text) => text.includes("ECHO"), 1);
		await transport.emitMessage(owner(CH, "channel", "300.3", "SECONDREPLY 또 답", "300.1"));
		await transport.waitForPosts((text) => text.includes("ECHO"), 2);
		const [first, second] = prompts();
		expect(first).toContain("ROOTPOST 채널 질문입니다");
		expect(second).toBe("SECONDREPLY 또 답");
		expect(transport.replyCalls).toHaveLength(1);
	});

	test("(c) a thread the owner opened gets no context", async () => {
		await boot();
		transport.threads.set(`${DM}:400.1`, [msg("400.1", OWNER, "OWNERROOT 내가 연 스레드")]);
		await transport.emitMessage(owner(DM, "im", "400.2", "REPLY 이어서", "400.1"));
		await transport.waitForPosts((text) => text.includes("ECHO"));
		expect(prompts()[0]).toBe("REPLY 이어서");
	});

	test("(c) a top-level owner message fetches nothing", async () => {
		await boot();
		await transport.emitMessage({
			type: "message",
			channel: DM,
			channel_type: "im",
			user: OWNER,
			text: "TOP 그냥 말해요",
			ts: "500.1",
		});
		await transport.waitForPosts((text) => text.includes("ECHO"));
		expect(prompts()[0]).toBe("TOP 그냥 말해요");
		expect(transport.replyCalls).toEqual([]);
	});

	test("(d) a failing conversations.replies delivers the text alone and logs thread_context_failed", async () => {
		await boot();
		transport.threads.set(`${DM}:600.1`, [msg("600.1", BOT, "ROOTPOST 질문")]);
		transport.failRepliesNext = new Error("ratelimited");
		await transport.emitMessage(owner(DM, "im", "600.2", "REPLY 답", "600.1"));
		await transport.waitForPosts((text) => text.includes("ECHO"));
		expect(prompts()[0]).toBe("REPLY 답");
		expect(lines.filter((line) => line.includes("event=thread_context_failed"))).toHaveLength(1);
	});

	test("a first owner reply steered into a running turn still carries the bot-posted root", async () => {
		await boot(true);
		transport.threads.set(`${DM}:800.1`, [msg("800.1", BOT, "⏰ ROOTPOST 오늘의 질문은 무엇인가요?")]);
		await transport.emitMessage(owner(DM, "im", "800.0", "LONGTASK 긴 작업", "800.0"));
		await waitUntil(() => prompts().length === 1, "first turn");
		await transport.emitMessage(owner(DM, "im", "800.2", "STEERREPLY 답입니다", "800.1"));
		const driver = drivers[0];
		await waitUntil(() => driver?.calls.some((c) => c.startsWith("steer:")) ?? false, "steer");
		const steer = driver?.calls.find((c) => c.startsWith("steer:")) ?? "";
		expect(steer).toContain(THREAD_CONTEXT_HEADER);
		expect(steer).toContain("ROOTPOST 오늘의 질문은 무엇인가요?");
		expect(steer.endsWith("[현재 요청]\nSTEERREPLY 답입니다")).toBe(true);
		for (const d of drivers) d.release();
	});

	test("a Slack read that never answers gives up after the deadline and the turn goes on without context", async () => {
		await boot(false, 50);
		transport.conversationsReplies = () => Promise.withResolvers<never>().promise;
		await transport.emitMessage(owner(DM, "im", "900.2", "HANGREPLY 답", "900.1"));
		await transport.waitForPosts((text) => text.includes("ECHO"));
		expect(prompts()[0]).toBe("HANGREPLY 답");
		expect(
			lines.filter((line) => line.includes("event=thread_context_failed") && line.includes("timeout")),
		).toHaveLength(1);
	});

	test("a secret-shaped token in the root is redacted before it reaches the prompt", async () => {
		await boot();
		const token = ["xoxb", "1234567890", "abcdefABCDEF"].join("-");
		transport.threads.set(`${DM}:700.1`, [msg("700.1", BOT, `키는 ${token} 입니다`)]);
		await transport.emitMessage(owner(DM, "im", "700.2", "REPLY 답", "700.1"));
		await transport.waitForPosts((text) => text.includes("ECHO"));
		expect(prompts()[0]).toContain("키는");
		expect(prompts()[0]).not.toContain(token);
	});
});
