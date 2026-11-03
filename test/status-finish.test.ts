import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Daemon } from "../src/daemon/daemon";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
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

	override async addReaction(args: { channel: string; timestamp: string; name: string }): Promise<void> {
		await super.addReaction(args);
		this.#notify();
	}

	override async removeReaction(args: { channel: string; timestamp: string; name: string }): Promise<void> {
		await super.removeReaction(args);
		this.#notify();
	}

	/** Status messages (`⏳` posts) whose last text is still `⏳`. */
	stuckStatuses(): string[] {
		const stuck: string[] = [];
		for (const call of this.calls) {
			if (call.method !== "postMessage" || !call.text.startsWith("⏳")) continue;
			const updates = this.calls.filter((c) => c.method === "updateMessage" && c.ts === call.ts);
			const last = updates.at(-1);
			if (last?.method !== "updateMessage" || last.text.startsWith("⏳")) stuck.push(call.ts);
		}
		return stuck;
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

async function boot(transport: SettlingTransport, holdTurns: boolean): Promise<Daemon> {
	const d = new Daemon({
		config: home.config,
		transport,
		log: createLogger({ sink: () => undefined, clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot",
		driverFactory: (_origin, sessionDir) => {
			const driver = new SteerSignalDriver({
				sessionDir,
				store: sessions,
				holdTurns,
				respond: (prompt, steers) => `ANSWER ${[prompt, ...steers].join("+")}`,
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
		await transport.settled(() => transport.calls.filter((c) => c.method === "updateMessage").length >= 2);
		const finals = transport.calls.filter((c) => c.method === "updateMessage" && c.text.startsWith("✅"));
		expect(finals).toHaveLength(2);
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
		await transport.settled(() => transport.calls.filter((c) => c.method === "updateMessage").length >= 2);
		expect(transport.calls.some((c) => c.method === "updateMessage" && c.text.startsWith("🚫 취소됨"))).toBe(true);
		// The cancelled followup never reaches omp; the running turn answers normally.
		expect(driver.calls.filter((c) => c.startsWith("prompt:"))).toEqual(["prompt:long job"]);
		expect(transport.posts((t) => t.startsWith("ANSWER")).map((c) => c.text)).toEqual(["ANSWER long job"]);
		expect(transport.stuckStatuses()).toEqual([]);
		expect(transport.eyesLeft()).toEqual([]);
	});
});
