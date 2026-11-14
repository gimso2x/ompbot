import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Daemon } from "../src/daemon/daemon";
import { createLogger } from "../src/log";
import { FakeOmpDriver, type FakeOmpDriverOptions, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import { makeHome, type TestHome, WaitingTransport } from "./helpers/bot-home";

const ORIGIN = "slack/dm/D1";
const clock = { now: () => Date.now() };

/** Transport that lets a test await "the Slack state satisfies X" without polling or sleeping. */
class SettlingTransport extends WaitingTransport {
	readonly #waiters = new Set<() => void>();

	#notify(): void {
		for (const waiter of [...this.#waiters]) waiter();
	}

	override async updateMessage(args: { channel: string; ts: string; text: string }): Promise<void> {
		await super.updateMessage(args);
		this.#notify();
	}

	override async deleteMessage(args: { channel: string; ts: string }): Promise<void> {
		await super.deleteMessage(args);
		this.#notify();
	}

	override async addReaction(args: { channel: string; timestamp: string; name: string }): Promise<void> {
		await super.addReaction(args);
		this.#notify();
	}

	override async removeReaction(args: { channel: string; timestamp: string; name: string }): Promise<void> {
		await super.removeReaction(args);
		this.#notify();
	}

	/** Status messages (`⏳` posts) neither deleted nor relabelled: their last text is still `⏳`. */
	stuckStatuses(): string[] {
		const stuck: string[] = [];
		for (const call of this.calls) {
			if (call.method !== "postMessage" || !call.text.startsWith("⏳")) continue;
			if (this.deleted().includes(call.ts)) continue;
			const updates = this.calls.filter((c) => c.method === "updateMessage" && c.ts === call.ts);
			const last = updates.at(-1);
			if (last?.method !== "updateMessage" || last.text.startsWith("⏳")) stuck.push(call.ts);
		}
		return stuck;
	}

	deleted(): string[] {
		return this.calls.flatMap((c) => (c.method === "deleteMessage" ? [c.ts] : []));
	}

	/** Messages that still carry our 👀. */
	eyesLeft(): string[] {
		const eyes = new Map<string, number>();
		for (const call of this.calls) {
			if ((call.method === "addReaction" || call.method === "removeReaction") && call.name === "eyes") {
				eyes.set(call.timestamp, (eyes.get(call.timestamp) ?? 0) + (call.method === "addReaction" ? 1 : -1));
			}
		}
		return [...eyes].filter(([, n]) => n > 0).map(([ts]) => ts);
	}

	settled(extra: () => boolean, timeoutMs = 5_000): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const check = () => {
			if (!extra() || this.stuckStatuses().length > 0 || this.eyesLeft().length > 0) return;
			clearTimeout(timer);
			this.#waiters.delete(check);
			resolve();
		};
		const timer = setTimeout(() => {
			this.#waiters.delete(check);
			reject(new Error(`not settled: stuck=${this.stuckStatuses().join(",")} eyes=${this.eyesLeft().join(",")}`));
		}, timeoutMs);
		this.#waiters.add(check);
		check();
		return promise;
	}
}

class SteerSignalDriver extends FakeOmpDriver {
	readonly steered = Promise.withResolvers<void>();
	readonly prompted = Promise.withResolvers<void>();
	override async prompt(text: string): Promise<string> {
		const opRef = await super.prompt(text);
		this.prompted.resolve();
		return opRef;
	}
	override async steer(text: string): Promise<void> {
		await super.steer(text);
		this.steered.resolve();
	}
}

let home: TestHome;
let sessions: FakeSessionStore;
let daemon: Daemon | undefined;
let drivers: SteerSignalDriver[];

beforeEach(() => {
	home = makeHome("ompbot-statusfinish-");
	sessions = new FakeSessionStore();
	drivers = [];
	daemon = undefined;
});
afterEach(async () => {
	await daemon?.stop();
	home.remove();
});

async function boot(
	transport: SettlingTransport,
	holdTurns: boolean,
	extra: Pick<FakeOmpDriverOptions, "script" | "messageEvents"> & { sweepMs?: number } = {},
): Promise<Daemon> {
	const { sweepMs, ...driverExtra } = extra;
	const d = new Daemon({
		config: home.config,
		channels: [new SlackBinding(new SlackChannel(transport))],
		log: createLogger({ sink: () => undefined, clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot",
		...(sweepMs === undefined ? {} : { sweepMs }),
		driverFactory: (_origin, sessionDir) => {
			const driver = new SteerSignalDriver({
				sessionDir,
				store: sessions,
				holdTurns,
				respond: (prompt, steers) => `ANSWER ${[prompt, ...steers].join("+")}`,
				...driverExtra,
			});
			drivers.push(driver);
			return driver;
		},
	});
	daemon = d;
	await d.start();
	return d;
}

describe("status messages are finished for every row of a turn and for commands", () => {
	test("a steered message's thread ends ✅ together with the lead message's thread", async () => {
		const transport = new SettlingTransport();
		const d = await boot(transport, true);
		await d.inject({ origin: ORIGIN, asOwner: true, text: "first" });
		await transport.waitForPosts((t) => t.startsWith("⏳"), 1);
		await d.inject({ origin: ORIGIN, asOwner: true, text: "second" });
		await transport.waitForPosts((t) => t.startsWith("⏳"), 2);
		const driver = drivers[0];
		if (!driver) throw new Error("driver not created");
		await driver.steered.promise;
		driver.release();
		await transport.waitForPosts((t) => t.startsWith("ANSWER"));
		await transport.settled(() => transport.deleted().length >= 1);
		// The lead thread holds the answer, so its status goes away; the steered thread's status ends as ✅.
		const [lead, steered] = transport.posts((t) => t.startsWith("⏳")).map((c) => c.ts);
		expect(transport.deleted()).toEqual([lead ?? ""]);
		const finals = transport.calls.filter((c) => c.method === "updateMessage" && c.text.startsWith("✅"));
		expect(finals.map((c) => (c.method === "updateMessage" ? c.ts : ""))).toEqual([steered ?? ""]);
		expect(transport.stuckStatuses()).toEqual([]);
		expect(transport.eyesLeft()).toEqual([]);
		// Exactly one answer even though two threads were finished.
		expect(transport.posts((t) => t.startsWith("ANSWER"))).toHaveLength(1);
	});

	test("/status-ompbot and /new-ompbot leave no ⏳ message and no 👀 behind", async () => {
		const transport = new SettlingTransport();
		const d = await boot(transport, false);
		await d.inject({ origin: ORIGIN, asOwner: true, text: "/status-ompbot" });
		await d.inject({ origin: ORIGIN, asOwner: true, text: "/new-ompbot" });
		await transport.waitForPosts((t) => t.startsWith("🆕"));
		await transport.settled(() => transport.eyesLeft().length === 0);
		expect(transport.posts((t) => t.startsWith("⏳"))).toHaveLength(0);
		expect(transport.stuckStatuses()).toEqual([]);
		expect(transport.eyesLeft()).toEqual([]);
	});

	test("/new during a running turn also finishes the aborted and the steered threads", async () => {
		const transport = new SettlingTransport();
		const d = await boot(transport, true);
		await d.inject({ origin: ORIGIN, asOwner: true, text: "long job" });
		await transport.waitForPosts((t) => t.startsWith("⏳"), 1);
		await d.inject({ origin: ORIGIN, asOwner: true, text: "steer me" });
		await transport.waitForPosts((t) => t.startsWith("⏳"), 2);
		const driver = drivers[0];
		if (!driver) throw new Error("driver not created");
		await driver.steered.promise;
		await d.inject({ origin: ORIGIN, asOwner: true, text: "/new-ompbot" });
		await transport.waitForPosts((t) => t.startsWith("🆕"));
		await transport.settled(() => transport.calls.filter((c) => c.method === "updateMessage").length >= 2);
		expect(transport.stuckStatuses()).toEqual([]);
		expect(transport.eyesLeft()).toEqual([]);
	});

	test("!queue drop finishes the dropped followup's ⏳ as 🚫 취소됨 and never prompts it", async () => {
		const transport = new SettlingTransport();
		const d = await boot(transport, true);
		await d.inject({ origin: ORIGIN, asOwner: true, text: "long job" });
		await transport.waitForPosts((t) => t.startsWith("⏳"), 1);
		await d.inject({ origin: ORIGIN, asOwner: true, text: "/followup-ompbot next job" });
		await transport.waitForPosts((t) => t.startsWith("⏳"), 2);
		await d.inject({ origin: ORIGIN, asOwner: true, text: "!queue drop 1" });
		await transport.waitForPosts((t) => t.startsWith("🚫"));
		const driver = drivers[0];
		if (!driver) throw new Error("driver not created");
		driver.release();
		await transport.waitForPosts((t) => t.startsWith("ANSWER"));
		await transport.settled(() => transport.deleted().length >= 1);
		expect(transport.calls.some((c) => c.method === "updateMessage" && c.text.startsWith("🚫 취소됨"))).toBe(true);
		// The cancelled followup never reaches omp; the running turn answers normally.
		expect(driver.calls.filter((c) => c.startsWith("prompt:"))).toEqual(["prompt:long job"]);
		expect(transport.posts((t) => t.startsWith("ANSWER")).map((c) => c.text)).toEqual(["ANSWER long job"]);
		expect(transport.stuckStatuses()).toEqual([]);
		expect(transport.eyesLeft()).toEqual([]);
	});

	test("!stop: its one answer finishes the stopped turn's and the waiting followup's ⏳ as 🚫 취소됨", async () => {
		const transport = new SettlingTransport();
		const d = await boot(transport, true);
		await d.inject({ origin: ORIGIN, asOwner: true, text: "long job" });
		await transport.waitForPosts((t) => t.startsWith("⏳"), 1);
		await d.inject({ origin: ORIGIN, asOwner: true, text: "/followup-ompbot next job" });
		await transport.waitForPosts((t) => t.startsWith("⏳"), 2);
		const statuses = transport.posts((t) => t.startsWith("⏳")).map((c) => c.ts);
		await d.inject({ origin: ORIGIN, asOwner: true, text: "!stop" });
		await transport.waitForPosts((t) => t.startsWith("⏹"));
		const cancelled = () =>
			transport.calls.flatMap((c) => (c.method === "updateMessage" && c.text.startsWith("🚫 취소됨") ? [c.ts] : []));
		await transport.settled(() => statuses.every((ts) => cancelled().includes(ts)));
		const driver = drivers[0];
		if (!driver) throw new Error("driver not created");
		expect(driver.calls.filter((c) => c.startsWith("prompt:"))).toEqual(["prompt:long job"]);
		expect(transport.posts((t) => t.startsWith("⏹")).map((c) => c.text)).toEqual([
			"⏹ 멈췄습니다. 세션은 그대로라 이어서 말하면 됩니다. 대기 1개를 취소했습니다.",
		]);
		expect(transport.posts((t) => t.startsWith("ANSWER") || t.startsWith("[turn failed]"))).toEqual([]);
		expect(transport.stuckStatuses()).toEqual([]);
		expect(transport.eyesLeft()).toEqual([]);
	});
});

describe("interim deliveries go out while the turn runs", () => {
	test("an interim record wakes the delivery pump; the ⏳ status stays until the turn-end delivery", async () => {
		const transport = new SettlingTransport();
		// No periodic sweep within the test: only the nudge after recording can post the interim texts.
		const d = await boot(transport, true, {
			sweepMs: 3_600_000,
			messageEvents: true,
			script: () => [
				{ role: "assistant", text: "EARLY 분석 답", stopReason: "stop" },
				{ role: "developer", text: "<system-reminder>" },
				{
					role: "assistant",
					text: "NOTE 지도 생성 중, 브라우저는 절반만 됩니다.",
					stopReason: "toolUse",
					toolCalls: ["wait"],
				},
				{ role: "toolResult", text: "ok" },
				{ role: "assistant", text: "ANSWER 지도 완료", stopReason: "stop" },
			],
		});
		await d.inject({ origin: ORIGIN, asOwner: true, text: "wap 분석" });
		await transport.waitForPosts((t) => t.startsWith("NOTE"));
		expect(transport.posts((t) => t.startsWith("EARLY") || t.startsWith("NOTE")).map((c) => c.text)).toEqual([
			"EARLY 분석 답",
			"NOTE 지도 생성 중, 브라우저는 절반만 됩니다.",
		]);
		// The turn still runs: its ⏳ message is neither deleted nor relabelled, and no answer went out yet.
		expect(transport.stuckStatuses()).toHaveLength(1);
		expect(transport.posts((t) => t.startsWith("ANSWER"))).toEqual([]);
		const driver = drivers[0];
		if (!driver) throw new Error("driver not created");
		driver.release();
		await transport.waitForPosts((t) => t.startsWith("ANSWER"));
		await transport.settled(() => transport.deleted().length >= 1);
		expect(transport.posts((t) => t.startsWith("ANSWER")).map((c) => c.text)).toEqual(["ANSWER 지도 완료"]);
		expect(transport.stuckStatuses()).toEqual([]);
		expect(transport.eyesLeft()).toEqual([]);
	});
});

/** Every answer post fails like a dropped connection (ambiguous: it may have reached Slack). */
class LosingTransport extends SettlingTransport {
	override async postMessage(args: {
		channel: string;
		text: string;
		threadTs?: string | undefined;
		blocks?: readonly unknown[] | undefined;
	}): Promise<{ ts: string }> {
		if (args.text.startsWith("ANSWER")) throw new Error("socket hang up");
		return super.postMessage(args);
	}
}

describe("an answer that could not be sent", () => {
	test("an ambiguous send failure ends the ⏳ as ⚠️ 답을 보내지 못했습니다 and removes the 👀", async () => {
		const transport = new LosingTransport();
		const d = await boot(transport, true);
		await d.inject({ origin: ORIGIN, asOwner: true, text: "lost answer" });
		await transport.waitForPosts((t) => t.startsWith("⏳"), 1);
		const driver = drivers[0];
		if (!driver) throw new Error("driver not created");
		await driver.prompted.promise;
		driver.release();
		await transport.settled(() =>
			transport.calls.some((c) => c.method === "updateMessage" && c.text.startsWith("⚠️ 답을 보내지 못했습니다")),
		);
		expect(transport.posts((t) => t.startsWith("ANSWER"))).toEqual([]);
		expect(transport.stuckStatuses()).toEqual([]);
		expect(transport.eyesLeft()).toEqual([]);
	});
});
