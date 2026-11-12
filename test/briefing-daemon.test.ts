// AC-4 of T-20261111-01: `!brief` at the daemon level — one upload and no delivery on success (the inbound row is
// discarded, so a restart settle finds nothing to fail), one failure line when the capture or the upload throws, a
// second request while a capture runs answered at once, the origin's normal messages still starting turns during a
// capture (the render never holds the serial chain), and `!brief` answering while a turn runs.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Daemon } from "../src/daemon/daemon";
import type { ProcessRunner, RunProcessResult } from "../src/dispatch/omp";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import type { InboundRow } from "../src/store/db";
import { makeHome, type TestHome, WaitingTransport } from "./helpers/bot-home";

const ORIGIN = "slack/dm/D1";
const CHANNEL = "D1";

let home: TestHome;
let clock: { t: number; now(): number };
let lines: string[];
let transport: BriefingTransport;
let daemon: Daemon | undefined;
let driver: FakeOmpDriver | undefined;

beforeEach(() => {
	home = makeHome("ompbot-briefing-daemon-");
	clock = { t: Date.parse("2026-11-11T07:00:00+09:00"), now: () => clock.t };
	lines = [];
	transport = new BriefingTransport();
	daemon = undefined;
	driver = undefined;
});

afterEach(async () => {
	// A held turn would keep `stop()` draining until its stopDrain bound; release it first (the test's own event).
	driver?.release();
	await daemon?.stop();
	home.remove();
});

/** A Slack transport that also signals the uploads the briefing ends with (the success path posts no text). */
class BriefingTransport extends WaitingTransport {
	readonly #uploadWaiters = new Set<() => void>();

	override async uploadFile(args: {
		channel: string;
		threadTs?: string | undefined;
		filePath: string;
		title?: string | undefined;
		comment?: string | undefined;
	}): Promise<{ fileId: string }> {
		const result = await super.uploadFile(args);
		for (const waiter of [...this.#uploadWaiters]) waiter();
		return result;
	}

	/** Resolves once `count` uploads happened (bounded; no polling). */
	waitForUploads(count = 1, timeoutMs = 10_000): Promise<void> {
		const waiters = this.#uploadWaiters;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const check = (): void => {
			if (this.calls.filter((call) => call.method === "uploadFile").length < count) return;
			clearTimeout(timer);
			waiters.delete(check);
			resolve();
		};
		const timer = setTimeout(() => {
			waiters.delete(check);
			reject(new Error(`timed out waiting for ${count} upload(s); saw ${this.calls.length} calls`));
		}, timeoutMs);
		waiters.add(check);
		check();
		return promise;
	}
}

/** The PNG bytes a fake chromium writes; only the signature matters here. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The `--screenshot=` path of a capture call. */
const outOf = (cmd: readonly string[]): string | undefined =>
	cmd.find((arg) => arg.startsWith("--screenshot="))?.slice("--screenshot=".length);

/** A chromium stand-in: stage 1 answers `<title>`, stage 2 writes the PNG unless `capture` says otherwise. */
function chromium(stage1: Partial<RunProcessResult> = { code: 0 }, capture: boolean = true): ProcessRunner {
	return async (cmd) => {
		const out = outOf(cmd);
		if (out === undefined) return { code: 0, stdout: "<title>1200</title>", timedOut: false, ...stage1 };
		if (capture) await Bun.write(out, PNG);
		return { code: 0, stdout: "", timedOut: false };
	};
}

/** A chromium hold on a deferred resolver, so a test decides when the capture finishes. */
function heldChromium(): { run: ProcessRunner; release: () => void; started: Promise<void> } {
	const gate = Promise.withResolvers<void>();
	const seen = Promise.withResolvers<void>();
	const run: ProcessRunner = async (cmd) => {
		seen.resolve();
		await gate.promise;
		const out = outOf(cmd);
		if (out !== undefined) await Bun.write(out, PNG);
		return { code: 0, stdout: "<title>1200</title>", timedOut: false };
	};
	return { run, release: () => gate.resolve(), started: seen.promise };
}

/**
 * A fake driver that signals every `prompt`: a turn really reached omp (the mailbox records the row dispatched only
 * after `prompt` resolves, so the row is not yet `dispatched` when this fires).
 */
class SignalingDriver extends FakeOmpDriver {
	readonly #promptWaiters = new Set<() => void>();
	prompts = 0;

	override async prompt(text: string): Promise<string> {
		const answer = await super.prompt(text);
		this.prompts += 1;
		for (const waiter of [...this.#promptWaiters]) waiter();
		return answer;
	}

	/** Resolves once `count` prompts were accepted (bounded wait on the event, never on a clock). */
	waitForPrompt(count = 1, timeoutMs = 10_000): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const check = (): void => {
			if (this.prompts < count) return;
			clearTimeout(timer);
			this.#promptWaiters.delete(check);
			resolve();
		};
		const timer = setTimeout(() => {
			this.#promptWaiters.delete(check);
			reject(new Error(`timed out waiting for ${count} prompt(s); saw ${this.prompts}`));
		}, timeoutMs);
		this.#promptWaiters.add(check);
		check();
		return promise;
	}
}

async function boot(options: { holdTurns?: boolean; briefingRun?: ProcessRunner } = {}): Promise<Daemon> {
	const sessions = new FakeSessionStore();
	const made = new SignalingDriver({ sessionDir: join(home.dir, "s"), store: sessions, holdTurns: options.holdTurns });
	driver = made;
	const d = new Daemon({
		config: home.config,
		channels: [new SlackBinding(new SlackChannel(transport))],
		clock,
		log: createLogger({ sink: (line) => lines.push(line), clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot",
		sweepMs: 3_600_000,
		gateSweepMs: 0,
		taskSweepMs: 0,
		// No boot backup: backup_age stays open, so the briefing always has a 주의 line (a boot stamp on the fixed
		// clock would close it only until the real date passes 36h after that clock).
		bootBackup: () => {
			throw new Error("boot backup off in this test");
		},
		driverFactory: () => made,
		...(options.briefingRun === undefined ? {} : { briefingRun: options.briefingRun }),
	});
	daemon = d;
	await d.start();
	return d;
}

/**
 * Waits for a row of this origin to reach `state`: the mailbox writes it in the promise chain that follows the
 * prompt, so the check hops one macrotask at a time until the row matches (bounded, no clock polling).
 */
async function waitForRow(d: Daemon, textRef: string, state: string, hops = 200): Promise<InboundRow | undefined> {
	const find = () => d.store.listInbound({ originKey: ORIGIN }).find((candidate) => candidate.textRef === textRef);
	for (let hop = 0; hop < hops; hop += 1) {
		const row = find();
		if (row?.state === state) return row;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	return find();
}

/**
 * Waits for the briefing row to reach `state`. The settle happens right after the upload in the same promise chain, so
 * the transport's own upload signal (plus one macrotask) is the event to hang the check on.
 */
async function waitForRowState(d: Daemon, state: string): Promise<void> {
	const row = () => d.store.listInbound({ originKey: ORIGIN }).find((candidate) => candidate.textRef === "!brief");
	if (row()?.state === state) return;
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	if (row()?.state !== state) throw new Error(`briefing row stayed ${row()?.state ?? "(none)"}, expected ${state}`);
}

const uploads = () => transport.calls.filter((call) => call.method === "uploadFile");
const failurePosts = () => transport.posts((text) => text.includes("브리핑 이미지를 만들지 못했습니다:"));

describe("AC-4: !brief", () => {
	test("uploads one image, records no delivery, discards the row, and a restart settle stays quiet", async () => {
		const d = await boot({ briefingRun: chromium({ code: 0 }) });
		await d.inject({ origin: ORIGIN, asOwner: true, text: "!brief" });
		await transport.waitForUploads();
		await waitForRowState(d, "discarded");
		const [upload] = uploads();
		expect(uploads()).toHaveLength(1);
		expect(upload?.channel).toBe(CHANNEL);
		expect(upload?.filePath).toContain(join("media", "briefing"));
		expect(upload?.title).toContain("ompbot 브리핑");
		expect(upload?.comment).toContain("주의");
		// Only the injected marker was posted as text: the image is the answer, no extra line.
		expect(transport.posts().filter((post) => !post.text.startsWith("🧪 inject"))).toHaveLength(0);
		const row = d.store.listInbound({ originKey: ORIGIN })[0];
		expect(row?.state).toBe("discarded");
		expect(d.store.listDeliveries({ originKey: ORIGIN })).toHaveLength(0);
		// A restart settles the rows the dead process left dispatched: nothing is dispatched here, so no failure notice.
		clock.t += 60_000;
		const restarted = await boot({ briefingRun: chromium() });
		await restarted.sweep();
		expect(failurePosts()).toHaveLength(0);
	});

	test("a failed capture posts one failure line and uploads nothing", async () => {
		const d = await boot({
			briefingRun: async () => ({ code: 1, stdout: "", stderr: "Fatal: no display\n", timedOut: false }),
		});
		await d.inject({ origin: ORIGIN, asOwner: true, text: "!brief" });
		await transport.waitForPosts((text) => text.includes("브리핑 이미지를 만들지 못했습니다:"));
		expect(failurePosts()).toHaveLength(1);
		expect(failurePosts()[0]?.text).toContain("Fatal: no display");
		expect(uploads()).toHaveLength(0);
	});

	test("an upload that throws is the same failure line", async () => {
		const d = await boot({ briefingRun: chromium() });
		transport.failNext.uploadFile = [new Error("slack down")];
		await d.inject({ origin: ORIGIN, asOwner: true, text: "!brief" });
		await transport.waitForPosts((text) => text.includes("브리핑 이미지를 만들지 못했습니다:"));
		expect(failurePosts()).toHaveLength(1);
		expect(failurePosts()[0]?.text).toContain("slack down");
	});

	test("a second !brief while a capture runs is answered at once and starts no second capture", async () => {
		const held = heldChromium();
		const d = await boot({ briefingRun: held.run });
		await d.inject({ origin: ORIGIN, asOwner: true, text: "!brief" });
		await held.started; // the first capture is inside chromium now
		await d.inject({ origin: ORIGIN, asOwner: true, text: "!brief" });
		await transport.waitForPosts((text) => text.includes("다른 브리핑을 그리는 중입니다"));
		expect(transport.posts((text) => text.includes("다른 브리핑을 그리는 중입니다"))).toHaveLength(1);
		expect(uploads()).toHaveLength(0);
		held.release();
		await transport.waitForUploads();
		// Only the first capture uploaded; the rejected one wrote nothing.
		expect(uploads()).toHaveLength(1);
	});

	test("a normal message of the same origin starts a turn while the capture runs", async () => {
		const held = heldChromium();
		const d = await boot({ briefingRun: held.run, holdTurns: true });
		await d.inject({ origin: ORIGIN, asOwner: true, text: "!brief" });
		await held.started;
		const started = (driver as SignalingDriver).waitForPrompt();
		await d.inject({ origin: ORIGIN, asOwner: true, text: "그냥 작업 하나" });
		// The turn started even though the render has not finished: it never holds the origin's serial chain.
		await started;
		const row = await waitForRow(d, "그냥 작업 하나", "dispatched");
		expect(row?.state).toBe("dispatched");
		expect(row?.opRef?.startsWith("brief:") ?? false).toBe(false);
		held.release();
		await transport.waitForUploads();
		expect(uploads()).toHaveLength(1);
	});

	test("!brief answers while a turn of the same origin runs", async () => {
		const d = await boot({ briefingRun: chromium(), holdTurns: true });
		const running = (driver as SignalingDriver).waitForPrompt();
		await d.inject({ origin: ORIGIN, asOwner: true, text: "오래 걸리는 작업" });
		await running;
		await d.inject({ origin: ORIGIN, asOwner: true, text: "!brief" });
		await transport.waitForUploads();
		expect(uploads()).toHaveLength(1);
		expect(failurePosts()).toHaveLength(0);
	});
});
