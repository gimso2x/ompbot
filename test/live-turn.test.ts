import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveTurn } from "../src/core/live-turn";
import { OriginMailbox, type TurnProgress } from "../src/core/mailbox";
import { openBotStore, sessionDirFor } from "../src/core/origin";
import type { InboundRecord } from "../src/core/types";
import { Daemon } from "../src/daemon/daemon";
import { callDaemon } from "../src/daemon/ipc";
import { createLogger } from "../src/log";
import type { OmpEvent } from "../src/omp/driver";
import { FakeOmpDriver, type FakeOmpDriverOptions, FakeSessionStore } from "../src/omp/fake-driver";
import { clearSecretIndex, indexSecretValue, redact } from "../src/redact";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import type { Store } from "../src/store/db";
import { makeHome, type TestHome, WaitingTransport } from "./helpers/bot-home";

const clock = {
	t: 1_000_000,
	now(): number {
		return this.t;
	},
};

const update = (content: unknown[]): OmpEvent => ({
	type: "message_update",
	message: { role: "assistant", content },
	assistantMessageEvent: { type: "text_delta", delta: "" },
});
const MESSAGE_END: OmpEvent = { type: "message_end", message: { role: "assistant", content: [] } };

describe("LiveTurn", () => {
	test("AC-1: a message's text, thinking and tool calls show while it streams and leave at message_end", () => {
		const live = new LiveTurn(clock, "m1");
		expect(live.view()).toBeNull();
		live.feed(
			update([
				{ type: "thinking", thinking: "음" },
				{ type: "text", text: "안녕" },
				{ type: "toolCall", id: "c1", name: "bash", arguments: { i: "목록 보기" } },
			]),
		);
		const view = live.view();
		expect(view).toMatchObject({
			inboundId: "m1",
			text: "안녕",
			thinking: "음",
			toolCalls: [{ name: "bash", summary: "목록 보기" }],
		});
		expect(view?.running).toEqual([]);
		live.feed(MESSAGE_END);
		expect(live.view()).toBeNull();
	});

	test("AC-1: a retry drops the failed attempt's text and shows the retry until the next message_update", () => {
		const live = new LiveTurn(clock, "m1");
		live.feed(update([{ type: "text", text: "실패할 글" }]));
		live.feed({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "overloaded" });
		const retrying = live.view();
		expect(retrying?.text).toBe("");
		expect(retrying?.retry).toEqual({ attempt: 1, error: "overloaded" });
		live.feed(update([{ type: "text", text: "다시" }]));
		expect(live.view()?.text).toBe("다시");
		expect(live.view()?.retry).toBeUndefined();
	});

	test("AC-1: event kinds it does not know leave seq alone", () => {
		const live = new LiveTurn(clock, "m1");
		live.feed(update([{ type: "text", text: "a" }]));
		const seq = live.view()?.seq;
		for (const type of ["agent_start", "turn_start", "message_start", "auto_compaction_start", "nope"])
			live.feed({ type });
		expect(live.view()?.seq).toBe(seq);
		live.feed(update([{ type: "text", text: "ab" }]));
		expect(live.view()?.seq).toBe((seq ?? 0) + 1);
	});

	test("AC-2: a running tool shows its intent and the last 2000 chars of its partial output, until it ends", () => {
		const live = new LiveTurn(clock, "m1");
		live.feed({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { i: "빌드", command: "make" },
		});
		const output = `${"a".repeat(1000)}${"b".repeat(2000)}`;
		clock.t += 1500;
		live.feed({
			type: "tool_execution_update",
			toolCallId: "t1",
			toolName: "bash",
			args: {},
			partialResult: { content: [{ type: "text", text: output }] },
		});
		const running = live.view()?.running[0];
		expect(running?.name).toBe("bash");
		expect(running?.summary).toBe("빌드");
		expect(running?.outputTail).toBe("b".repeat(2000));
		expect(running?.ageMs).toBe(1500);
		live.feed({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {}, isError: false });
		expect(live.view()).toBeNull();
	});

	test("omp's intent sent beside the args (i stripped from them) is the summary of running and pending tools", () => {
		const live = new LiveTurn(clock, "m1");
		live.feed({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "make" },
			intent: "빌드",
		});
		live.feed({
			type: "message_update",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "t2", name: "read", arguments: { path: "a.ts" }, intent: "읽기" }],
			},
			assistantMessageEvent: { type: "toolcall_delta" },
		});
		const view = live.view();
		expect(view?.running[0]?.summary).toBe("빌드");
		expect(view?.toolCalls).toEqual([{ name: "read", summary: "읽기" }]);
	});

	test("AC-3: a token in the streamed text never leaves view()", () => {
		const token = ["xoxb", "TEST", "0"].join("-");
		const live = new LiveTurn(clock, "m1");
		live.feed(update([{ type: "text", text: `토큰은 ${token} 이에요` }]));
		live.feed({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { i: `echo ${token}` } });
		live.feed({ type: "tool_execution_update", toolCallId: "t1", partialResult: `${token}\n` });
		const json = JSON.stringify(live.view());
		expect(json).toContain("토큰은");
		expect(json).not.toContain(token);
	});

	test("an indexed secret cut by the 120-char summary limit leaves no fragment in the summaries", () => {
		// 40 chars matching no token pattern: only the secret index can mask it.
		const secret = "QQ7mK2vR9xT4pL8nW3zB6yH1cF5dG0jS2aE7uI4o"; // gitleaks:allow (fake secret)
		expect(indexSecretValue(secret)).toBe(true);
		try {
			for (let pad = 0; pad < 140; pad++) {
				const args = { command: `curl -H "Authorization: Bearer ${"a".repeat(pad)}${secret}" https://example.test` };
				const live = new LiveTurn(clock, "m1");
				live.feed({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args });
				live.feed(update([{ type: "toolCall", id: "c2", name: "bash", arguments: args }]));
				const view = live.view();
				for (const summary of [view?.running[0]?.summary ?? "", view?.toolCalls[0]?.summary ?? ""]) {
					expect(summary.length).toBeLessThanOrEqual(120);
					expect({ pad, leaked: summary.includes(secret.slice(0, 4)) }).toEqual({ pad, leaked: false });
				}
			}
		} finally {
			clearSecretIndex();
		}
	});
});

/** A fake child whose events the test sends at the moment it picks. */
class LiveDriver extends FakeOmpDriver {
	readonly #listeners = new Set<(event: OmpEvent) => void>();

	override onEvent(listener: (event: OmpEvent) => void): () => void {
		this.#listeners.add(listener);
		const off = super.onEvent(listener);
		return () => {
			this.#listeners.delete(listener);
			off();
		};
	}

	emitEvent(event: OmpEvent): void {
		for (const listener of this.#listeners) listener(event);
	}
}

describe("OriginMailbox live view", () => {
	const ORIGIN = "slack/dm/DLIVE";
	let dir: string;
	let store: Store;
	let drivers: LiveDriver[];
	let progress: TurnProgress[];
	let logLines: string[];
	let counter = 0;

	const msg = (text: string): InboundRecord => {
		const id = `live${++counter}`;
		return { platformMessageId: id, originKey: ORIGIN, ownerVerified: true, text, threadRef: id };
	};

	function liveMailbox(options: FakeOmpDriverOptions = { holdTurns: true }): OriginMailbox {
		const sessions = new FakeSessionStore();
		return new OriginMailbox({
			timezone: "Asia/Seoul",
			originKey: ORIGIN,
			store,
			clock,
			log: createLogger({ sink: (line) => logLines.push(line), clock, redact }),
			statusProvider: () => "status: ok",
			sessionDirFor: (key, epoch) => sessionDirFor(join(dir, "sessions"), key, epoch),
			driverFactory: (_origin, sessionDir) => {
				const driver = new LiveDriver({ ...options, sessionDir, store: sessions });
				drivers.push(driver);
				return driver;
			},
			onProgress: (info) => progress.push(info.progress),
		});
	}

	/** Starts a held turn and streams one message into it. */
	async function streaming(mailbox: OriginMailbox): Promise<LiveDriver> {
		await mailbox.enqueue(msg("일해"));
		const driver = drivers[0] as LiveDriver;
		driver.emitEvent(update([{ type: "text", text: "생성 중" }]));
		expect(mailbox.liveView()?.text).toBe("생성 중");
		return driver;
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ompbot-live-"));
		store = openBotStore(join(dir, "ompbot.db"), clock, "Asia/Seoul");
		drivers = [];
		progress = [];
		logLines = [];
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("AC-4 ①: the live view goes when the turn answers", async () => {
		const mailbox = liveMailbox();
		try {
			expect(mailbox.liveView()).toBeNull();
			const driver = await streaming(mailbox);
			const final = Promise.withResolvers<void>();
			driver.onFinal(() => final.resolve());
			driver.release();
			await final.promise;
			await mailbox.sweepIdle(); // behind the final handler on the actor chain
			expect(mailbox.liveView()).toBeNull();
		} finally {
			await mailbox.close();
		}
	});

	test("AC-4 ②: the live view goes when the child exits mid-turn", async () => {
		const mailbox = liveMailbox();
		try {
			const driver = await streaming(mailbox);
			driver.crash();
			await mailbox.sweepIdle();
			expect(mailbox.liveView()).toBeNull();
		} finally {
			await mailbox.close();
		}
	});

	test("AC-4 ③: the live view goes on /new mid-turn", async () => {
		const mailbox = liveMailbox();
		try {
			await streaming(mailbox);
			await mailbox.enqueue(msg("/new-ompbot"));
			expect(mailbox.liveView()).toBeNull();
		} finally {
			await mailbox.close();
		}
	});

	test("AC-4: a retry shows in the live view while the retry log and the status-line progress stay as before", async () => {
		const mailbox = liveMailbox();
		try {
			const driver = await streaming(mailbox);
			driver.emitEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
			driver.emitEvent(update([{ type: "text", text: "더" }]));
			driver.emitEvent({ type: "tool_execution_start", toolCallId: "t2", toolName: "read", args: { path: "a.ts" } });
			driver.emitEvent({
				type: "auto_retry_start",
				attempt: 1,
				maxAttempts: 5,
				delayMs: 10,
				errorMessage: "429 rate_limit_error",
			});
			expect(mailbox.liveView()?.retry?.attempt).toBe(1);
			expect(mailbox.liveView()?.text).toBe("");
			expect(logLines.filter((line) => line.includes("event=provider_limit_hit"))).toHaveLength(1);
			expect(progress).toEqual([
				{ tools: 1, recentTools: ["bash command=ls"], steers: 0, retries: 0 },
				{ tools: 2, recentTools: ["bash command=ls", "read path=a.ts"], steers: 0, retries: 0 },
				{ tools: 2, recentTools: ["bash command=ls", "read path=a.ts"], steers: 0, retries: 1 },
			]);
		} finally {
			await mailbox.close();
		}
	});
});

describe("daemon live op", () => {
	const ORIGIN = "slack/dm/D1";
	let home: TestHome;
	let daemon: Daemon | undefined;

	beforeEach(() => {
		home = makeHome("ompbot-live-daemon-");
	});

	afterEach(async () => {
		await daemon?.stop();
		home.remove();
	});

	test("AC-5: {op:live} answers the running turn's view over the socket, and null for an unknown origin", async () => {
		const drivers: LiveDriver[] = [];
		const started = Promise.withResolvers<void>();
		const sessions = new FakeSessionStore();
		daemon = new Daemon({
			config: home.config,
			channels: [new SlackBinding(new SlackChannel(new WaitingTransport()))],
			log: createLogger({
				sink: (line) => {
					if (line.includes("event=turn_start")) started.resolve();
				},
				clock: { now: () => Date.now() },
				redact,
			}),
			ompVersion: "omp-test 0",
			bootId: "kernel-boot-id",
			driverFactory: (_origin, sessionDir) => {
				const driver = new LiveDriver({ sessionDir, store: sessions, holdTurns: true });
				drivers.push(driver);
				return driver;
			},
		});
		await daemon.start();
		await daemon.inject({ origin: ORIGIN, asOwner: true, text: "일해" });
		await started.promise;
		drivers[0]?.emitEvent(update([{ type: "text", text: "소켓으로 본다" }]));

		const running = await callDaemon(daemon.socketPath, { op: "live", origin: ORIGIN });
		expect(running).toMatchObject({ ok: true, live: { text: "소켓으로 본다", seq: 1 } });
		expect(await callDaemon(daemon.socketPath, { op: "live", origin: "slack/dm/NOPE" })).toEqual({
			ok: true,
			live: null,
		});
		expect(await callDaemon(daemon.socketPath, { op: "live" })).toEqual({ ok: true, live: null });
		drivers[0]?.release();
	});
});

describe("LiveTurn summary cap (qa50b K-1)", () => {
	test("a long intent is cut to 120 chars in both the running tool and the streaming tool call", () => {
		const live = new LiveTurn(clock, "m1");
		const intent = "가".repeat(300);
		live.feed({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {}, intent });
		live.feed(update([{ type: "toolCall", id: "c1", name: "bash", arguments: { i: intent }, intent }]));
		const view = live.view();
		expect(view?.running[0]?.summary).toHaveLength(120);
		expect(view?.toolCalls[0]?.summary).toHaveLength(120);
	});
});
