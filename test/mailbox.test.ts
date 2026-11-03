import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OriginMailbox, TurnFailureEscalation } from "../src/core/mailbox";
import { OriginRouter, openBotStore, sessionDirFor, slackDmOrigin } from "../src/core/origin";
import { IDLE_STOP_MS, type InboundRecord, MONITOR_IDLE_STOP_MS } from "../src/core/types";
import { laneOriginKey } from "../src/lanes/status";
import { createLogger } from "../src/log";
import { monitorOrigin } from "../src/monitors/ledger";
import { OmpDriverError, type OmpEntries, type OmpOpenResult } from "../src/omp/driver";
import {
	FakeOmpDriver,
	type FakeOmpDriverOptions,
	FakeSessionStore,
	type FakeTurnMessage,
} from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import type { Store } from "../src/store/db";

class FakeClock {
	t = 1_000_000;
	now(): number {
		return this.t;
	}
	advance(ms: number): void {
		this.t += ms;
	}
}

/**
 * Rejects the first `failSteers` steer calls, like a child that refuses a steering message, and can simulate the
 * 2026-10-24 outage: `stale` makes every prompt fail with the removed-model sign and hides the model from the list.
 */
class SteerFailingDriver extends FakeOmpDriver {
	failSteers = 0;
	stale = false;
	/** Reject cursor reads like a session whose turn-start cursor is gone (`unknown_since`); `leafId()` still works. */
	failEntriesSince = false;
	override async entriesSince(since?: string): Promise<OmpEntries> {
		if (this.failEntriesSince && since !== undefined) {
			throw new OmpDriverError("unknown_since", `Unknown entries cursor: ${since}`, { rpcCode: "unknown_since" });
		}
		return super.entriesSince(since);
	}
	override async steer(text: string): Promise<void> {
		if (this.failSteers > 0) {
			this.failSteers--;
			this.calls.push(`steer-rejected:${text}`);
			throw new OmpDriverError("rpc_error", "steer refused");
		}
		return super.steer(text);
	}
	override async prompt(text: string): Promise<string> {
		if (this.stale) throw new OmpDriverError("rpc_error", "Could not restore model: fake/alpha");
		return super.prompt(text);
	}
	override async availableModels(): Promise<string[]> {
		return this.stale
			? (await super.availableModels()).filter((model) => model !== "fake/alpha")
			: super.availableModels();
	}
}

/**
 * Simulates the 2026-10-27 outage from the session-restore side, like real omp: resuming a session whose last
 * `model_change` names a model the registry no longer lists throws `Could not restore model <id>` from
 * `openSession`/`switchSession`. `restoreListed` is the registry's model list; undefined disables the gate.
 */
class RestoreFailingDriver extends SteerFailingDriver {
	readonly #sessionDir: string;
	readonly #listed: readonly string[] | undefined;

	constructor(options: FakeOmpDriverOptions & { restoreListed?: readonly string[] }, sessionDir: string) {
		const { restoreListed, ...rest } = options;
		super(rest);
		this.#sessionDir = sessionDir;
		this.#listed = restoreListed;
	}

	async #gate(file: string | undefined): Promise<void> {
		if (this.#listed === undefined || file === undefined) return;
		const model = lastModelChangeOf(file);
		if (model !== undefined && !this.#listed.includes(model)) {
			throw new OmpDriverError("rpc_error", `Could not restore model ${model}`);
		}
	}

	/** omp's `open_session` resume probe: the newest `.jsonl` of the session dir. */
	#newestSession(): string | undefined {
		if (!existsSync(this.#sessionDir)) return undefined; // no dir on disk: a fresh session, nothing to restore
		let newest: { file: string; mtimeMs: number } | undefined;
		for (const name of readdirSync(this.#sessionDir)) {
			if (!name.endsWith(".jsonl")) continue;
			const file = join(this.#sessionDir, name);
			const mtimeMs = statSync(file).mtimeMs;
			if (newest === undefined || mtimeMs > newest.mtimeMs) newest = { file, mtimeMs };
		}
		return newest?.file;
	}

	override async openSession(): Promise<OmpOpenResult> {
		await this.#gate(this.#newestSession());
		return super.openSession();
	}

	override async switchSession(sessionFile: string): Promise<{ cancelled: boolean }> {
		await this.#gate(sessionFile);
		return super.switchSession(sessionFile);
	}
}

/** The model of the last `model_change` record in a session file — the value omp's session restore resolves. */
function lastModelChangeOf(file: string): string | undefined {
	let model: string | undefined;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line === "") continue;
		try {
			const record = JSON.parse(line) as { type?: unknown; model?: unknown } | null;
			if (record?.type === "model_change" && typeof record.model === "string") model = record.model;
		} catch {
			// a torn trailing line: omp skips unparsable records too
		}
	}
	return model;
}

/**
 * A saved omp session of `originKey` epoch 1: header, one user turn, an older `model_change` for a model the
 * provider removed earlier (2026-10-24) and the final `model_change` naming `model` (2026-10-27's dead model).
 */
function writeSavedSession(originKey: string, model: string): string {
	const sessionDir = sessionDirFor(join(dir, "sessions"), originKey, 1);
	mkdirSync(sessionDir, { recursive: true });
	const file = join(sessionDir, "2026-10-27T09-00-00-000Z_5eed0000.jsonl");
	const records = [
		JSON.stringify({ type: "session", version: 1, id: "5eed0000", timestamp: "2026-10-26T00:00:00.000Z", cwd: dir }),
		JSON.stringify({
			type: "model_change",
			id: "e1",
			parentId: null,
			timestamp: "2026-10-24T01:00:00.000Z",
			model: "exampleproxy/glm-5.3-flash",
			role: "default",
		}),
		JSON.stringify({
			type: "message",
			id: "e2",
			parentId: "e1",
			timestamp: "2026-10-27T08:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "이전 턴" }] },
		}),
		JSON.stringify({
			type: "model_change",
			id: "e3",
			parentId: "e2",
			timestamp: "2026-10-27T09:00:00.000Z",
			model,
			role: "default",
		}),
	];
	writeFileSync(file, `${records.join("\n")}\n`);
	return file;
}

const ORIGIN = "slack/dm/D1";
let dir: string;
let clock: FakeClock;
let store: Store;
let router: OriginRouter;
let drivers: SteerFailingDriver[];
let driverOptions: FakeOmpDriverOptions;
let failSteers: number;
let statusCalls: string[];
let logLines: string[];
let sessionStore: FakeSessionStore;
let defaultModel: string | undefined;
let escalations: TurnFailureEscalation[];
let escalateAfter: number | undefined;
let restoreListed: readonly string[] | undefined;
let sessionBackupsRoot: string | undefined;

/** Fresh router over the current test knobs; `defaultModel` is only readable here, so stale-model tests rebuild the router. */
function buildRouter(): OriginRouter {
	return new OriginRouter({
		store,
		clock,
		sessionsRoot: join(dir, "sessions"),
		...(defaultModel === undefined ? {} : { defaultModel }),
		...(escalateAfter === undefined ? {} : { escalateAfter }),
		...(sessionBackupsRoot === undefined ? {} : { sessionBackupsRoot }),
		log: createLogger({ sink: (line) => logLines.push(line), clock, redact }),
		statusProvider: (origin) => {
			statusCalls.push(origin);
			return "status: ok";
		},
		onEscalate: (info) => escalations.push(info),
		driverFactory: (_origin, sessionDir) => {
			const driver = new RestoreFailingDriver(
				{
					...driverOptions,
					sessionDir,
					store: sessionStore,
					...(restoreListed === undefined ? {} : { restoreListed }),
				},
				sessionDir,
			);
			driver.failSteers = failSteers;
			drivers.push(driver);
			return driver;
		},
	});
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-mailbox-"));
	clock = new FakeClock();
	store = openBotStore(join(dir, "ompbot.db"), clock);
	drivers = [];
	driverOptions = {};
	failSteers = 0;
	statusCalls = [];
	logLines = [];
	sessionStore = new FakeSessionStore();
	defaultModel = undefined;
	escalations = [];
	escalateAfter = undefined;
	restoreListed = undefined;
	sessionBackupsRoot = undefined;
	router = buildRouter();
});

afterEach(async () => {
	await router.close();
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
function msg(text: string, extra: Partial<InboundRecord> = {}): InboundRecord {
	const id = `m${++counter}`;
	return { platformMessageId: id, originKey: ORIGIN, ownerVerified: true, text, threadRef: id, ...extra };
}

/** Run `action`, then wait for the driver's next final and for the mailbox to process it. */
async function untilFinal(mailbox: OriginMailbox, driver: FakeOmpDriver, action: () => void): Promise<void> {
	const seen = new Promise<void>((resolve) => {
		const off = driver.onFinal(() => {
			off();
			resolve();
		});
	});
	action();
	await seen;
	await mailbox.sweepIdle(); // runs behind the final handler on the actor's chain
}

describe("mailbox: prompt vs steer", () => {
	test("idle -> prompt once; answer + delivery recorded; entry_cursor is the leaf read right before the prompt", async () => {
		const mailbox = router.mailbox(ORIGIN);
		const first = msg("hello");
		await router.route(first);
		const driver = drivers[0] as SteerFailingDriver;
		expect(driver.calls.filter((c) => c.startsWith("prompt:"))).toEqual(["prompt:hello"]);
		const row = store.getInbound(first.platformMessageId);
		expect(row?.state).toBe("dispatched");
		// Fresh fake session holds e1,e2 (seed); the prompt appends e3, so the cursor taken before it is e2.
		expect(row?.entryCursor).toBe("e2");
		expect(row?.opRef).toBe("fake_req_1");
		await mailbox.sweepIdle();
		expect(store.getInbound(first.platformMessageId)?.state).toBe("answered");
		const deliveries = store.listDeliveries({ originKey: ORIGIN });
		expect(deliveries.map((d) => [d.body, d.threadRef])).toEqual([["ECHO hello", first.threadRef]]);
	});

	test("busy -> steer once (never prompt); same op_ref and cursor read right before the steer", async () => {
		driverOptions = { holdTurns: true };
		const mailbox = router.mailbox(ORIGIN);
		const a = msg("first");
		const b = msg("second");
		await router.route(a);
		await router.route(b);
		const driver = drivers[0] as SteerFailingDriver;
		expect(driver.calls.filter((c) => c.startsWith("prompt:"))).toEqual(["prompt:first"]);
		expect(driver.calls.filter((c) => c.startsWith("steer:"))).toEqual(["steer:second"]);
		const rowA = store.getInbound(a.platformMessageId);
		const rowB = store.getInbound(b.platformMessageId);
		expect(rowB?.state).toBe("dispatched");
		expect(rowB?.opRef).toBe(rowA?.opRef ?? "missing");
		expect(rowA?.entryCursor).toBe("e2");
		expect(rowB?.entryCursor).toBe("e3"); // after the first prompt's user entry
		await untilFinal(mailbox, driver, () => driver.release());
		expect(store.getInbound(a.platformMessageId)?.state).toBe("answered");
		expect(store.getInbound(b.platformMessageId)?.state).toBe("answered");
		const deliveries = store.listDeliveries({ originKey: ORIGIN });
		expect(deliveries.filter((d) => d.threadRef === a.threadRef).map((d) => d.body)).toEqual(["ECHO first | second"]);
		// `second` came from its own thread: it gets the steered-thread pointer, not the answer.
		expect(deliveries.filter((d) => d.threadRef === b.threadRef)).toHaveLength(1);
	});

	test("steer failure leaves the row pending and sends it as the next turn (no session replacement)", async () => {
		driverOptions = { holdTurns: true };
		failSteers = 1;
		const mailbox = router.mailbox(ORIGIN);
		const a = msg("first");
		const b = msg("second");
		await router.route(a);
		await router.route(b);
		const driver = drivers[0] as SteerFailingDriver;
		expect(store.getInbound(b.platformMessageId)?.state).toBe("pending");
		await untilFinal(mailbox, driver, () => driver.release());
		expect(store.getInbound(a.platformMessageId)?.state).toBe("answered");
		expect(driver.calls.filter((c) => c.startsWith("prompt:"))).toEqual(["prompt:first", "prompt:second"]);
		expect(store.getInbound(b.platformMessageId)?.state).toBe("dispatched");
		await untilFinal(mailbox, driver, () => driver.release());
		expect(store.getInbound(b.platformMessageId)?.state).toBe("answered");
		expect(store.listDeliveries({ originKey: ORIGIN }).map((d) => d.body)).toEqual(["ECHO first", "ECHO second"]);
		expect(driver.calls).not.toContain("newSession");
		expect(drivers).toHaveLength(1);
	});

	test("a duplicate platform message is prompted once", async () => {
		const mailbox = router.mailbox(ORIGIN);
		const a = msg("once");
		await router.route(a);
		await router.route(a);
		await mailbox.sweepIdle();
		expect((drivers[0] as SteerFailingDriver).calls.filter((c) => c.startsWith("prompt:"))).toHaveLength(1);
		expect(store.listInbound({ originKey: ORIGIN })).toHaveLength(1);
		expect(store.listDeliveries({ originKey: ORIGIN })).toHaveLength(1);
	});
});

describe("mailbox: /new, /status, failures", () => {
	test("/new discards pending rows and drops the old epoch's output", async () => {
		driverOptions = { holdTurns: true };
		failSteers = 1;
		const mailbox = router.mailbox(ORIGIN);
		await router.route(msg("old turn"));
		const pending = msg("never reached the turn");
		await router.route(pending);
		const old = drivers[0] as SteerFailingDriver;
		expect(store.getInbound(pending.platformMessageId)?.state).toBe("pending");
		const command = msg("/new-ompbot");
		await router.route(command);
		await mailbox.sweepIdle(); // lets any (ignored) aborted final settle
		expect(old.calls).toContain("abort");
		expect(old.calls).toContain("newSession");
		expect(store.getInbound(pending.platformMessageId)?.state).toBe("discarded");
		expect(store.listInbound({ originKey: ORIGIN, state: "dispatched" })).toHaveLength(0);
		expect(store.listInbound({ originKey: ORIGIN, state: "answered" })).toHaveLength(0);
		const origin = store.getOrigin(ORIGIN);
		expect(origin?.epoch).toBe(2);
		expect(origin?.sessionDir).toBe(sessionDirFor(join(dir, "sessions"), ORIGIN, 2));
		// Only the /new acknowledgement may be delivered; nothing of the old turn.
		expect(store.listDeliveries({ originKey: ORIGIN }).map((d) => d.body)).toEqual(["🆕 새 대화를 시작했습니다."]);
		// Next message opens a fresh driver on the new epoch's directory.
		await router.route(msg("fresh"));
		expect(drivers).toHaveLength(2);
		expect(drivers[1]?.calls).toEqual(["openSession", "prompt:fresh"]);
	});

	test("/status-ompbot is response-only: provider text becomes a delivery, omp is never touched", async () => {
		const command = msg("/status-ompbot");
		await router.route(command);
		expect(statusCalls).toEqual([ORIGIN]);
		expect(drivers).toHaveLength(0);
		expect(store.listDeliveries({ originKey: ORIGIN }).map((d) => [d.body, d.threadRef])).toEqual([
			["status: ok", command.threadRef],
		]);
		expect(store.getInbound(command.platformMessageId)?.state).toBe("answered");
	});

	test("omp exiting mid-turn -> failed_notified, one failure delivery, prompt never resent", async () => {
		driverOptions = { holdTurns: true };
		const mailbox = router.mailbox(ORIGIN);
		const a = msg("long job");
		const b = msg("extra");
		await router.route(a);
		await router.route(b);
		const driver = drivers[0] as SteerFailingDriver;
		driver.crash(137);
		await mailbox.sweepIdle();
		expect(store.getInbound(a.platformMessageId)?.state).toBe("failed_notified");
		expect(store.getInbound(b.platformMessageId)?.state).toBe("failed_notified");
		expect(
			store
				.listDeliveries({ originKey: ORIGIN })
				.filter((d) => d.threadRef === a.threadRef)
				.map((d) => d.body),
		).toEqual(["[turn failed] omp_exited code=137 — 다시 보내 주세요"]);
		expect(driver.calls.filter((c) => c.startsWith("prompt:"))).toHaveLength(1);
		expect(drivers).toHaveLength(1);
		expect(mailbox.state.driverRunning).toBe(false);
	});

	test("a driver that cannot start yields a [turn failed] notice and the actor survives", async () => {
		driverOptions = { startError: new OmpDriverError("omp_executable_missing", "no omp") };
		const a = msg("hi");
		await router.route(a);
		expect(store.getInbound(a.platformMessageId)?.state).toBe("failed_notified");
		expect(store.listDeliveries({ originKey: ORIGIN }).map((d) => d.body)).toEqual([
			"[turn failed] omp_executable_missing — 다시 보내 주세요",
		]);
		driverOptions = {};
		await router.route(msg("again"));
		expect(drivers.at(-1)?.calls).toContain("prompt:again");
	});
});

describe("mailbox: queue drop", () => {
	test("a steer-blocked plain message (끼워넣기 대기) is dropped without touching the running turn", async () => {
		driverOptions = { holdTurns: true };
		failSteers = 1;
		const mailbox = router.mailbox(ORIGIN);
		await router.route(msg("first"));
		const blocked = msg("끼워넣기 거부된 메시지");
		await router.route(blocked);
		const driver = drivers[0] as SteerFailingDriver;
		expect(store.getInbound(blocked.platformMessageId)?.state).toBe("pending");

		const command = msg("!queue drop 1");
		await router.route(command);
		const dropped = store.getInbound(blocked.platformMessageId);
		expect(dropped?.state).toBe("discarded");
		expect(dropped?.opRef).toBe(`queue:${command.platformMessageId}`);
		expect(store.listDeliveries({ originKey: ORIGIN }).map((d) => d.body)).toEqual([
			`🚫 대기 1번을 취소했습니다: [끼워넣기 대기] ${blocked.text}`,
		]);
		expect(logLines.some((line) => line.includes("queue_dropped"))).toBe(true);

		await untilFinal(mailbox, driver, () => driver.release());
		// The queue behind the dropped row is empty: no second turn is started.
		expect(driver.calls.filter((c) => c.startsWith("prompt:"))).toEqual(["prompt:first"]);
		expect(store.getInbound(blocked.platformMessageId)?.state).toBe("discarded");
	});
});

describe("mailbox: stale model self-heal", () => {
	test("a session restored with a removed model is switched to the config default and the turn still runs", async () => {
		driverOptions = { models: ["zai/glm-5.3-flash"], restoredModel: "exampleproxy/glm-5.3-flash" };
		defaultModel = "zai/glm-5.3-flash";
		router = buildRouter();
		const a = msg("hello");
		await router.route(a);
		const driver = drivers[0] as SteerFailingDriver;
		expect(driver.calls).toContain("setModel:zai/glm-5.3-flash");
		expect(logLines.some((line) => line.includes("model_stale_replaced"))).toBe(true);
		expect(driver.calls.filter((c) => c.startsWith("prompt:"))).toEqual(["prompt:hello"]);
		await router.mailbox(ORIGIN).sweepIdle();
		expect(store.getInbound(a.platformMessageId)?.state).toBe("answered");
	});

	test("a chat-chosen model that still exists wins over the default and heals silently", async () => {
		driverOptions = {
			models: ["anthropic/claude-opus-5-5", "zai/glm-5.3-flash"],
			restoredModel: "exampleproxy/glm-5.3-flash",
		};
		defaultModel = "zai/glm-5.3-flash";
		router = buildRouter();
		store.ensureOrigin(ORIGIN, sessionDirFor(join(dir, "sessions"), ORIGIN, 1));
		store.setOriginSettings(ORIGIN, { model: "anthropic/claude-opus-5-5" });
		const a = msg("hello");
		await router.route(a);
		const driver = drivers[0] as SteerFailingDriver;
		// The origin override is applied by #applySettings and the heal then sees a valid model: no extra switch.
		expect(driver.calls.filter((c) => c.startsWith("setModel:"))).toEqual(["setModel:anthropic/claude-opus-5-5"]);
		expect(logLines.some((line) => line.includes("model_stale"))).toBe(false);
		expect(driver.calls.filter((c) => c.startsWith("prompt:"))).toEqual(["prompt:hello"]);
	});

	test("a chat-chosen model the provider removed is skipped and kept; the heal still repairs the session", async () => {
		driverOptions = { models: ["zai/glm-5.3-flash"], restoredModel: "exampleproxy/glm-5.3-flash" };
		defaultModel = "zai/glm-5.3-flash";
		router = buildRouter();
		store.ensureOrigin(ORIGIN, sessionDirFor(join(dir, "sessions"), ORIGIN, 1));
		store.setOriginSettings(ORIGIN, { model: "exampleproxy/glm-5.3-flash" });
		const a = msg("hello");
		await router.route(a);
		const driver = drivers[0] as SteerFailingDriver;
		// The removed chat choice is never re-applied (no doomed setModel per child open)...
		expect(logLines.some((line) => line.includes("model_apply_unavailable"))).toBe(true);
		expect(driver.calls.filter((c) => c.startsWith("setModel:"))).toEqual(["setModel:zai/glm-5.3-flash"]);
		// ...it stays in origin settings so it applies again once the model returns...
		expect(store.getOrigin(ORIGIN)?.model).toBe("exampleproxy/glm-5.3-flash");
		// ...and the session's stale active model is still healed to the config default.
		expect(logLines.some((line) => line.includes("model_stale_replaced"))).toBe(true);
		expect(driver.calls.filter((c) => c.startsWith("prompt:"))).toEqual(["prompt:hello"]);
	});

	test("no valid fallback -> model_stale_no_fallback warn, never fatal", async () => {
		driverOptions = { models: ["zai/other"], restoredModel: "exampleproxy/glm-5.3-flash" };
		defaultModel = "zai/glm-5.3-flash"; // not in the driver's list either
		router = buildRouter();
		const a = msg("hello");
		await router.route(a);
		const driver = drivers[0] as SteerFailingDriver;
		expect(logLines.some((line) => line.includes("model_stale_no_fallback"))).toBe(true);
		expect(driver.calls.filter((c) => c.startsWith("prompt:"))).toEqual(["prompt:hello"]);
	});
});

describe("mailbox: session restore model heal (2026-10-27 사고)", () => {
	test("restore fails on the removed model -> the file's last model_change is healed and the same dispatch retries once", async () => {
		const file = writeSavedSession(ORIGIN, "anthropic/claude-opus-5-5");
		defaultModel = "zai/glm-5.3";
		restoreListed = ["zai/glm-5.3"];
		sessionBackupsRoot = join(dir, "session-backups");
		router = buildRouter();
		const a = msg("다시 가자");
		await router.route(a);
		// (a) the session file's last model_change now names the fallback; the older record is untouched.
		expect(lastModelChangeOf(file)).toBe("zai/glm-5.3");
		expect(readFileSync(file, "utf8")).toContain('"model":"exampleproxy/glm-5.3-flash"');
		expect(logLines.some((line) => line.includes("model_file_healed"))).toBe(true);
		// (b) the retried dispatch prompted in a fresh child and the turn ran.
		const retry = drivers[1] as RestoreFailingDriver;
		expect(drivers.length).toBe(2);
		expect(retry.calls.filter((c) => c.startsWith("prompt:"))).toEqual(["prompt:다시 가자"]);
		expect(logLines.some((line) => line.includes("turn_start"))).toBe(true);
		expect(logLines.filter((line) => line.includes("dispatch_failed")).length).toBe(0);
		await router.mailbox(ORIGIN).sweepIdle();
		expect(store.getInbound(a.platformMessageId)?.state).toBe("answered");
	});

	test("the retry failing too (fallback also removed) runs the failure path exactly once", async () => {
		const file = writeSavedSession(ORIGIN, "anthropic/claude-opus-5-5");
		defaultModel = "zai/glm-5.3";
		restoreListed = ["zai/other"]; // neither the dead model nor the fallback is listed
		sessionBackupsRoot = join(dir, "session-backups");
		router = buildRouter();
		const a = msg("다시 가자");
		await router.route(a);
		expect(logLines.filter((line) => line.includes("dispatch_failed")).length).toBe(1);
		expect(store.getInbound(a.platformMessageId)?.state).toBe("failed_notified");
		// The file was corrected and backed up exactly once — the retry's failure heals nothing new.
		expect(lastModelChangeOf(file)).toBe("zai/glm-5.3");
		const backups = readdirSync(join(sessionBackupsRoot, encodeURIComponent(ORIGIN)));
		expect(backups).toHaveLength(1);
		expect(readFileSync(join(sessionBackupsRoot, encodeURIComponent(ORIGIN), backups[0] ?? ""), "utf8")).toContain(
			'"model":"anthropic/claude-opus-5-5"',
		);
		expect(drivers).toHaveLength(2); // the failed child and the retry child
		expect(drivers.flatMap((driver) => driver.calls).filter((call) => call.startsWith("prompt:"))).toEqual([]);
	});

	test("a non-model start failure never touches the session file", async () => {
		const file = writeSavedSession(ORIGIN, "anthropic/claude-opus-5-5");
		const before = readFileSync(file, "utf8");
		driverOptions = { startError: new OmpDriverError("omp_executable_missing", "no omp") };
		sessionBackupsRoot = join(dir, "session-backups");
		router = buildRouter();
		const a = msg("hi");
		await router.route(a);
		expect(store.getInbound(a.platformMessageId)?.state).toBe("failed_notified");
		expect(logLines.filter((line) => line.includes("dispatch_failed")).length).toBe(1);
		expect(readFileSync(file, "utf8")).toBe(before);
		expect(existsSync(join(dir, "session-backups"))).toBe(false);
	});

	test("no fallback at all (no origin model, no defaultModel) -> file untouched, failure path as before", async () => {
		const file = writeSavedSession(ORIGIN, "anthropic/claude-opus-5-5");
		const before = readFileSync(file, "utf8");
		restoreListed = ["zai/glm-5.3"]; // a live model exists, but nothing points at it
		sessionBackupsRoot = join(dir, "session-backups");
		router = buildRouter();
		const a = msg("다시 가자");
		await router.route(a);
		expect(logLines.filter((line) => line.includes("dispatch_failed")).length).toBe(1);
		expect(store.getInbound(a.platformMessageId)?.state).toBe("failed_notified");
		expect(readFileSync(file, "utf8")).toBe(before);
		expect(existsSync(join(dir, "session-backups"))).toBe(false);
		expect(drivers).toHaveLength(1); // no retry child was spawned
	});

	test("the pre-heal original is backed up under a timestamp name and the session dir gains no new *.jsonl", async () => {
		const sessionDir = sessionDirFor(join(dir, "sessions"), ORIGIN, 1);
		const file = writeSavedSession(ORIGIN, "anthropic/claude-opus-5-5");
		const before = readFileSync(file, "utf8");
		defaultModel = "zai/glm-5.3";
		restoreListed = ["zai/glm-5.3"];
		sessionBackupsRoot = join(dir, "session-backups");
		router = buildRouter();
		await router.route(msg("다시 가자"));
		// The healed text replaced the original in place; no temp file or extra session is left behind.
		expect(readdirSync(sessionDir)).toEqual(["2026-10-27T09-00-00-000Z_5eed0000.jsonl"]);
		const backupDir = join(sessionBackupsRoot, encodeURIComponent(ORIGIN));
		const backups = readdirSync(backupDir);
		expect(backups).toHaveLength(1);
		expect(/^\d{4}-\d{2}-\d{2}T\d{9}Z\.jsonl$/.test(backups[0] ?? "")).toBe(true); // <UTC timestamp>.jsonl
		expect(readFileSync(join(backupDir, backups[0] ?? ""), "utf8")).toBe(before); // the pristine original
	});

	test("the last model_change already naming the fallback -> no file change, no retry, failure path once", async () => {
		const file = writeSavedSession(ORIGIN, "zai/glm-5.3"); // already the fallback model
		const before = readFileSync(file, "utf8");
		defaultModel = "zai/glm-5.3";
		restoreListed = ["zai/other"]; // the fallback is not listed either: restore fails naming it
		sessionBackupsRoot = join(dir, "session-backups");
		router = buildRouter();
		const a = msg("다시 가자");
		await router.route(a);
		expect(logLines.filter((line) => line.includes("dispatch_failed")).length).toBe(1);
		expect(store.getInbound(a.platformMessageId)?.state).toBe("failed_notified");
		expect(readFileSync(file, "utf8")).toBe(before);
		expect(existsSync(join(dir, "session-backups"))).toBe(false);
		expect(drivers).toHaveLength(1);
		expect(drivers.flatMap((driver) => driver.calls).filter((call) => call.startsWith("prompt:"))).toEqual([]);
	});

	test("a live driver's mid-turn model failure heals via setModel and never touches the session file", async () => {
		const file = writeSavedSession(ORIGIN, "anthropic/claude-opus-5-5");
		const before = readFileSync(file, "utf8");
		defaultModel = "fake/beta";
		sessionBackupsRoot = join(dir, "session-backups");
		router = buildRouter();
		await router.route(msg("fine first"));
		await router.mailbox(ORIGIN).sweepIdle();
		const driver = drivers[0] as SteerFailingDriver;
		driver.stale = true; // the provider removed fake/alpha while the child was running
		await router.route(msg("failing one"));
		// The existing #healStaleModel path switched the live child; the session file stayed as it was.
		expect(driver.calls).toContain("setModel:fake/beta");
		expect(readFileSync(file, "utf8")).toBe(before);
		expect(existsSync(join(dir, "session-backups"))).toBe(false);
		expect(drivers).toHaveLength(1);
	});
});

describe("mailbox: consecutive failure escalation (무인 신뢰성 루프)", () => {
	test("a model-sign failure re-heals the live driver at once: the next messages succeed, no escalation", async () => {
		defaultModel = "fake/beta";
		router = buildRouter();
		await router.route(msg("fine first"));
		await router.mailbox(ORIGIN).sweepIdle(); // first turn completes (success resets the count)
		const driver = drivers[0] as SteerFailingDriver;
		expect(escalations).toHaveLength(0);

		driver.stale = true; // the provider removed fake/alpha while the child was running
		await router.route(msg("failing one"));
		// The message that met the failure is lost, but the heal no longer waits for the escalation threshold.
		expect(driver.calls).toContain("setModel:fake/beta");
		expect(escalations).toHaveLength(0);

		driver.stale = false; // the healed session answers the following messages without a restart
		for (const text of ["failing two", "failing three"]) {
			const healed = msg(text);
			await router.route(healed);
			await router.mailbox(ORIGIN).sweepIdle();
			expect(store.getInbound(healed.platformMessageId)?.state).toBe("answered");
		}
		expect(escalations).toHaveLength(0);
		expect(drivers).toHaveLength(1); // the child itself was never restarted, nor the session reopened
	});

	test("model-sign failures without any fallback escalate at the default threshold", async () => {
		await router.route(msg("fine first"));
		await router.mailbox(ORIGIN).sweepIdle();
		const driver = drivers[0] as SteerFailingDriver;

		driver.stale = true; // no defaultModel configured: the heal has nothing to switch to
		await router.route(msg("failing one"));
		await router.route(msg("failing two"));
		expect(escalations).toHaveLength(0);
		await router.route(msg("failing three"));
		expect(escalations).toHaveLength(1);
		expect(escalations[0]).toMatchObject({
			originKey: ORIGIN,
			failures: 3,
			reason: "Could not restore model: fake/alpha",
			modelHealed: false,
		});
		expect(driver.calls.filter((c) => c.startsWith("setModel:"))).toEqual([]);
		expect(drivers).toHaveLength(1); // a re-heal, never a session reopen, is the recovery path
		expect(logLines.some((line) => line.includes("event=turn_failures_escalated"))).toBe(true);
		// A failure past the threshold keeps reporting; repeat suppression is the daemon's job.
		await router.route(msg("failing four"));
		expect(escalations.at(-1)?.failures).toBe(4);
	});

	test("escalateAfter: 1 heals and reports the very first failed turn", async () => {
		escalateAfter = 1;
		defaultModel = "fake/beta";
		router = buildRouter();
		await router.route(msg("fine first"));
		await router.mailbox(ORIGIN).sweepIdle();
		const driver = drivers[0] as SteerFailingDriver;

		driver.stale = true;
		await router.route(msg("failing one"));
		expect(escalations).toHaveLength(1);
		expect(escalations[0]).toMatchObject({
			originKey: ORIGIN,
			failures: 1,
			reason: "Could not restore model: fake/alpha",
			modelHealed: true,
		});
		expect(driver.calls).toContain("setModel:fake/beta");
	});

	test("escalateAfter: 0 silences the owner report, not the first-failure heal", async () => {
		escalateAfter = 0;
		defaultModel = "fake/beta";
		router = buildRouter();
		await router.route(msg("fine first"));
		await router.mailbox(ORIGIN).sweepIdle();
		const driver = drivers[0] as SteerFailingDriver;

		driver.stale = true;
		for (const text of ["failing one", "failing two", "failing three"]) {
			await router.route(msg(text));
		}
		expect(escalations).toHaveLength(0);
		expect(logLines.some((line) => line.includes("turn_failures_escalated"))).toBe(false);
		// The heal itself is threshold-independent: the live driver was still repaired.
		expect(driver.calls).toContain("setModel:fake/beta");
	});

	test("a completed turn resets the run: 2 failures + success + 2 failures never escalates", async () => {
		const mailbox = router.mailbox(ORIGIN);
		await router.route(msg("ok first"));
		await mailbox.sweepIdle();
		const driver = drivers[0] as SteerFailingDriver;

		driver.stale = true;
		await router.route(msg("fail a"));
		await router.route(msg("fail b"));
		expect(escalations).toHaveLength(0);

		driver.stale = false;
		const recovered = msg("ok second");
		await router.route(recovered);
		await mailbox.sweepIdle(); // answered -> the run reset
		expect(store.getInbound(recovered.platformMessageId)?.state).toBe("answered");

		driver.stale = true;
		await router.route(msg("fail c"));
		await router.route(msg("fail d"));
		expect(escalations).toHaveLength(0);
		await router.route(msg("fail e")); // 3rd of the new run
		expect(escalations).toHaveLength(1);
		expect(escalations[0]?.failures).toBe(3);
	});

	test("a child dying mid-turn counts too (omp_exited sign, no live driver to re-heal)", async () => {
		driverOptions = { holdTurns: true };
		for (const text of ["job one", "job two", "job three"]) {
			await router.route(msg(text));
			const driver = drivers.at(-1);
			if (!driver) throw new Error("no driver was started");
			driver.crash(137);
			await router.mailbox(ORIGIN).sweepIdle(); // runs behind the exit handler on the actor's chain
		}
		expect(escalations).toHaveLength(1);
		expect(escalations[0]).toMatchObject({ failures: 3, reason: "omp_exited code=137", modelHealed: false });
		expect(drivers).toHaveLength(3); // each crash was followed by a fresh child, never a re-heal of the dead one
	});
});

describe("origin routing and idle stop", () => {
	test("a DM thread reply has the same origin as the top-level message and shares one conversation", async () => {
		driverOptions = { holdTurns: true };
		const top = slackDmOrigin({ channelId: "D9" });
		const reply = slackDmOrigin({ channelId: "D9", threadTs: "1700000000.000100" });
		expect(reply).toBe(top);
		expect(top).toBe("slack/dm/D9");
		await router.route(msg("top", { originKey: top }));
		await router.route(msg("in thread", { originKey: reply, threadRef: "1700000000.000100" }));
		expect(drivers).toHaveLength(1);
		expect(drivers[0]?.calls.filter((c) => c.startsWith("prompt:") || c.startsWith("steer:"))).toEqual([
			"prompt:top",
			"steer:in thread",
		]);
	});

	test("30 minutes idle stops omp; the next message re-opens the session", async () => {
		const mailbox = router.mailbox(ORIGIN);
		await router.route(msg("one"));
		await mailbox.sweepIdle();
		expect(mailbox.state.driverRunning).toBe(true);
		clock.advance(29 * 60 * 1000);
		expect(await router.sweepIdle()).toBe(0);
		expect(mailbox.state.driverRunning).toBe(true);
		clock.advance(60 * 1000);
		expect(await router.sweepIdle()).toBe(1);
		expect(mailbox.state.driverRunning).toBe(false);
		await router.route(msg("two"));
		expect(drivers).toHaveLength(2);
		expect(drivers[1]?.calls[0]).toBe("openSession");
		expect(drivers[1]?.calls).toContain("prompt:two");
	});

	test("a running turn is never idle-stopped", async () => {
		driverOptions = { holdTurns: true };
		const mailbox = router.mailbox(ORIGIN);
		await router.route(msg("busy"));
		clock.advance(60 * 60 * 1000);
		expect(await router.sweepIdle()).toBe(0);
		expect(mailbox.state.busy).toBe(true);
	});
});

describe("mailbox: thread inherits channel model settings", () => {
	const CHANNEL = "slack/ch/C1";
	const THREAD = "slack/ch/C1/t/123";

	test("a thread with no choice of its own applies the parent channel's model and thinking", async () => {
		store.ensureOrigin(CHANNEL, sessionDirFor(join(dir, "sessions"), CHANNEL, 1));
		store.setOriginSettings(CHANNEL, { model: "fake/beta", thinking: "high" });
		await router.route(msg("hello", { originKey: THREAD }));
		const driver = drivers[0] as SteerFailingDriver;
		expect(driver.calls.filter((c) => c.startsWith("setModel:"))).toEqual(["setModel:fake/beta"]);
		expect(driver.calls.filter((c) => c.startsWith("setThinking:"))).toEqual(["setThinking:high"]);
		// Inheritance is read-time, not copied: the thread row stays unset until it chooses for itself.
		expect(store.getOrigin(THREAD)?.model).toBeNull();
		expect(store.getOrigin(THREAD)?.thinking).toBeNull();
	});

	test("a thread's own choice wins field-by-field over the inherited one", async () => {
		store.ensureOrigin(CHANNEL, sessionDirFor(join(dir, "sessions"), CHANNEL, 1));
		store.setOriginSettings(CHANNEL, { model: "fake/beta", thinking: "high" });
		store.ensureOrigin(THREAD, sessionDirFor(join(dir, "sessions"), THREAD, 1));
		store.setOriginSettings(THREAD, { model: "fake/alpha" });
		await router.route(msg("hello", { originKey: THREAD }));
		const driver = drivers[0] as SteerFailingDriver;
		expect(driver.calls.filter((c) => c.startsWith("setModel:"))).toEqual(["setModel:fake/alpha"]);
		// Thinking was never chosen in the thread: it still follows the channel.
		expect(driver.calls.filter((c) => c.startsWith("setThinking:"))).toEqual(["setThinking:high"]);
	});

	test("a thread whose parent channel is unknown falls back to the omp default with no setModel call", async () => {
		await router.route(msg("hello", { originKey: "slack/ch/C2/t/456" }));
		const driver = drivers[0] as SteerFailingDriver;
		expect(driver.calls.filter((c) => c.startsWith("setModel:"))).toEqual([]);
		expect(driver.calls.filter((c) => c.startsWith("setThinking:"))).toEqual([]);
		expect(driver.calls.filter((c) => c.startsWith("prompt:"))).toEqual(["prompt:hello"]);
	});
});

describe("mailbox: monitor-pinned model settings", () => {
	const addMonitor = (pins: { model?: "fake/alpha" | "fake/beta"; thinking?: "off" | "high" }) =>
		store.monitors.addMonitor({
			name: "brief",
			trigger: { kind: "cron", schedule: "0 9 * * *", timezone: "UTC" },
			instruction: "x",
			overlap: "queue",
			enabled: true,
			...pins,
		});
	const calls = (prefix: string) => (drivers[0] as SteerFailingDriver).calls.filter((c) => c.startsWith(prefix));

	test("a monitor's model and thinking are applied when its child opens", async () => {
		const origin = monitorOrigin(addMonitor({ model: "fake/beta", thinking: "high" }).id);
		await router.route(msg("go", { originKey: origin }));
		expect(calls("setModel:")).toEqual(["setModel:fake/beta"]);
		expect(calls("setThinking:")).toEqual(["setThinking:high"]);
	});

	test("a monitor pin beats a conflicting origin-row value", async () => {
		const origin = monitorOrigin(addMonitor({ model: "fake/beta", thinking: "high" }).id);
		store.ensureOrigin(origin, sessionDirFor(join(dir, "sessions"), origin, 1));
		store.setOriginSettings(origin, { model: "fake/alpha", thinking: "off" });
		await router.route(msg("go", { originKey: origin }));
		expect(calls("setModel:")).toEqual(["setModel:fake/beta"]);
		expect(calls("setThinking:")).toEqual(["setThinking:high"]);
	});

	test("a null monitor field falls back to the origin row", async () => {
		const origin = monitorOrigin(addMonitor({ model: "fake/beta" }).id);
		store.ensureOrigin(origin, sessionDirFor(join(dir, "sessions"), origin, 1));
		store.setOriginSettings(origin, { model: "fake/alpha", thinking: "off" });
		await router.route(msg("go", { originKey: origin }));
		expect(calls("setModel:")).toEqual(["setModel:fake/beta"]);
		expect(calls("setThinking:")).toEqual(["setThinking:off"]);
	});

	test("a removed monitor behaves like a plain origin", async () => {
		const origin = "monitor/mgone0000";
		store.ensureOrigin(origin, sessionDirFor(join(dir, "sessions"), origin, 1));
		store.setOriginSettings(origin, { model: "fake/alpha", thinking: "off" });
		await router.route(msg("go", { originKey: origin }));
		expect(calls("setModel:")).toEqual(["setModel:fake/alpha"]);
		expect(calls("setThinking:")).toEqual(["setThinking:off"]);
	});

	test("a non-monitor origin ignores monitor pins", async () => {
		addMonitor({ model: "fake/beta", thinking: "high" });
		await router.route(msg("hello"));
		expect(calls("setModel:")).toEqual([]);
		expect(calls("setThinking:")).toEqual([]);
	});
});

describe("mailbox: every stop-ended answer of a turn is delivered", () => {
	const LONG = "✅ 완료 — 상세 보고\npersona.md 갱신, 브리핑 모니터 등록, wiki 토큰 확인.";
	const SHORT = "보고는 앞 답변에서 끝났어.";
	/** 2026-10-26 13:23 shape: long stop answer, todo reminder continues the turn, tool call, short stop answer. */
	const reminderTurn: FakeTurnMessage[] = [
		{ role: "assistant", text: LONG, stopReason: "stop" },
		{ role: "developer", text: "<system-reminder> You stopped with 1 incomplete todo item(s)" },
		{ role: "assistant", text: "todo를 정리할게.", stopReason: "toolUse" },
		{ role: "toolResult", text: "ok" },
		{ role: "assistant", text: SHORT, stopReason: "stop" },
	];
	const bodies = () => store.listDeliveries({ originKey: ORIGIN }).map((d) => d.body);

	test("a reminder-continued turn delivers both answers in order in one delivery", async () => {
		driverOptions = { script: () => reminderTurn };
		const mailbox = router.mailbox(ORIGIN);
		await router.route(msg("report"));
		await mailbox.sweepIdle();
		expect(bodies()).toEqual([`${LONG}\n\n${SHORT}`]);
	});

	test("an answer repeated right after itself is delivered once", async () => {
		driverOptions = {
			script: () => [
				{ role: "assistant", text: "same", stopReason: "stop" },
				{ role: "developer", text: "<system-reminder>" },
				{ role: "assistant", text: " same ", stopReason: "stop" },
			],
		};
		const mailbox = router.mailbox(ORIGIN);
		await router.route(msg("x"));
		await mailbox.sweepIdle();
		expect(bodies()).toEqual([" same "]);
	});

	/** 2026-10-26 17:02 pay-linux shape: a 1497-char report, a todo reminder, then the same report re-written at 1507. */
	const REPORT = Array.from(
		{ length: 30 },
		(_, i) => `${i + 1}. pay-linux 배포 단계 ${i + 1} 확인: crontab·세션·적립 로그 정상, 경로 /home/dev/pay-linux.`,
	).join("\n");

	test("a report nearly re-written after a reminder is delivered once, as the later wording", async () => {
		const first = REPORT.slice(0, 1497);
		const second = `${first.slice(0, 700)} (재확인: OK)${first.slice(700)}`;
		expect([first.length, second.length]).toEqual([1497, 1507]);
		driverOptions = {
			script: () => [
				{ role: "assistant", text: first, stopReason: "stop" },
				{ role: "developer", text: "<system-reminder> You stopped with 1 incomplete todo item(s)" },
				{ role: "assistant", text: "todo를 정리할게.", stopReason: "toolUse" },
				{ role: "toolResult", text: "ok" },
				{ role: "assistant", text: second, stopReason: "stop" },
			],
		};
		const mailbox = router.mailbox(ORIGIN);
		await router.route(msg("deploy"));
		await mailbox.sweepIdle();
		expect(bodies()).toEqual([second]);
	});

	test("two different reports of similar shape are both delivered", async () => {
		const other = Array.from(
			{ length: 30 },
			(_, i) => `${i + 1}) wiki 토큰 점검 ${30 - i}: mcp.json 헤더·Bearer 응답 코드 기록, 재로그인 주기 메모.`,
		).join("\n");
		driverOptions = {
			script: () => [
				{ role: "assistant", text: REPORT, stopReason: "stop" },
				{ role: "developer", text: "<system-reminder>" },
				{ role: "assistant", text: other, stopReason: "stop" },
			],
		};
		const mailbox = router.mailbox(ORIGIN);
		await router.route(msg("x"));
		await mailbox.sweepIdle();
		expect(bodies()).toEqual([`${REPORT}\n\n${other}`]);
	});

	test("a single stop answer is delivered as before", async () => {
		driverOptions = { script: () => [{ role: "assistant", text: "only answer", stopReason: "stop" }] };
		const mailbox = router.mailbox(ORIGIN);
		await router.route(msg("x"));
		await mailbox.sweepIdle();
		expect(bodies()).toEqual(["only answer"]);
	});

	test("text between tool calls (toolUse) is not delivered", async () => {
		driverOptions = {
			script: () => [
				{ role: "assistant", text: "파일을 볼게.", stopReason: "toolUse" },
				{ role: "toolResult", text: "contents" },
				{ role: "assistant", text: "done", stopReason: "stop" },
			],
		};
		const mailbox = router.mailbox(ORIGIN);
		await router.route(msg("x"));
		await mailbox.sweepIdle();
		expect(bodies()).toEqual(["done"]);
	});

	test("a monitor origin answers with the last text only", async () => {
		driverOptions = { script: () => reminderTurn };
		const answered: string[][] = [];
		const recordAnswer = store.recordAnswer.bind(store);
		store.recordAnswer = (input) => {
			answered.push([...input.parts]);
			return recordAnswer(input);
		};
		const id = store.monitors.addMonitor({
			name: "brief",
			trigger: { kind: "cron", schedule: "0 9 * * *", timezone: "UTC" },
			instruction: "x",
			overlap: "queue",
			enabled: true,
		}).id;
		const origin = monitorOrigin(id);
		await router.route(msg("go", { originKey: origin }));
		await router.mailbox(origin).sweepIdle();
		expect(answered).toEqual([[SHORT]]);
	});

	test("an unreadable turn-start cursor (unknown_since) falls back to the last text and warns", async () => {
		driverOptions = { script: () => reminderTurn, holdTurns: true };
		const mailbox = router.mailbox(ORIGIN);
		await router.route(msg("report"));
		const driver = drivers[0] as SteerFailingDriver;
		driver.failEntriesSince = true;
		await untilFinal(mailbox, driver, () => driver.release());
		expect(bodies()).toEqual([SHORT]);
		expect(logLines.some((line) => line.includes("level=warn event=answer_entries_failed"))).toBe(true);
	});
});

describe("mailbox: steered messages from another thread get a pointer notice", () => {
	const LEAD = "D1:100.000001";
	const OTHER = "D1:200.000002";
	const notices = () =>
		store
			.listDeliveries({ originKey: ORIGIN })
			.filter((d) => d.threadRef !== LEAD)
			.map((d) => ({ thread: d.threadRef, body: d.body }));

	async function steeredTurn(end: (driver: SteerFailingDriver) => void): Promise<void> {
		driverOptions = { holdTurns: true, respond: () => "첫 줄 요약\n둘째 줄" };
		const mailbox = router.mailbox(ORIGIN);
		await router.route(msg("lead", { threadRef: LEAD }));
		await router.route(msg("also this", { threadRef: OTHER }));
		await router.route(msg("and this", { threadRef: OTHER }));
		await router.route(msg("same thread", { threadRef: LEAD }));
		const driver = drivers[0] as SteerFailingDriver;
		await untilFinal(mailbox, driver, () => end(driver));
	}

	test("an answer posts exactly one notice per other thread, with the first line and a link", async () => {
		await steeredTurn((driver) => driver.release());
		expect(notices()).toEqual([
			{
				thread: OTHER,
				body: "↪ 이 요청은 진행 중이던 작업에 합쳐져서 답을 다른 스레드에 올렸어\n> 첫 줄 요약{{thread-link:D1:100.000001}}",
			},
		]);
		expect(store.listDeliveries({ originKey: ORIGIN }).filter((d) => d.threadRef === LEAD)).toHaveLength(1);
		// A replayed answer (recovery, retry) finds the rows already answered and notifies nothing again.
		const opRef = store.listDeliveries({ originKey: ORIGIN }).find((d) => d.threadRef === LEAD)?.opRef ?? "missing";
		store.recordAnswer({ originKey: ORIGIN, opRef, threadRef: LEAD, parts: ["첫 줄 요약\n둘째 줄"] });
		expect(notices()).toHaveLength(1);
	});

	test("a failed turn posts the same pointer with the failure line", async () => {
		await steeredTurn((driver) => driver.abort());
		const [notice, ...rest] = notices();
		expect(rest).toEqual([]);
		expect(notice?.thread).toBe(OTHER);
		expect(
			notice?.body.startsWith("↪ 이 요청은 진행 중이던 작업에 합쳐져서 답을 다른 스레드에 올렸어\n> [turn failed]"),
		).toBe(true);
		expect(notice?.body.endsWith("{{thread-link:D1:100.000001}}")).toBe(true);
	});

	test("steered messages of the turn's own thread get no notice", async () => {
		driverOptions = { holdTurns: true };
		const mailbox = router.mailbox(ORIGIN);
		await router.route(msg("lead", { threadRef: LEAD }));
		await router.route(msg("more", { threadRef: LEAD }));
		const driver = drivers[0] as SteerFailingDriver;
		await untilFinal(mailbox, driver, () => driver.release());
		expect(notices()).toEqual([]);
	});
});

describe("mailbox: idle stop per origin kind", () => {
	const monitorId = () =>
		store.monitors.addMonitor({
			name: "retro",
			trigger: { kind: "cron", schedule: "0 23 * * *", timezone: "UTC" },
			instruction: "x",
			overlap: "queue",
			enabled: true,
		}).id;

	/** Runs one finished turn on `origin`, then reports whether the child is stopped `afterMs` later. */
	async function stoppedAfter(origin: string, afterMs: number): Promise<boolean> {
		await router.route(msg("work", { originKey: origin }));
		const mailbox = router.mailbox(origin);
		await mailbox.sweepIdle(); // behind the final: the turn has settled
		expect(mailbox.state.driverRunning).toBe(true);
		clock.advance(afterMs);
		await mailbox.sweepIdle();
		return !mailbox.state.driverRunning;
	}

	test("a monitor origin's child stops 2 minutes after its work, not before", async () => {
		const origin = monitorOrigin(monitorId());
		expect(await stoppedAfter(origin, MONITOR_IDLE_STOP_MS - 1)).toBe(false);
		clock.advance(1);
		expect(await router.mailbox(origin).sweepIdle()).toBe(true);
	});

	test("a monitor run arriving within the 2 minutes reuses the child", async () => {
		const origin = monitorOrigin(monitorId());
		expect(await stoppedAfter(origin, MONITOR_IDLE_STOP_MS - 1)).toBe(false);
		await router.route(msg("next run", { originKey: origin }));
		clock.advance(MONITOR_IDLE_STOP_MS - 1);
		expect(await router.mailbox(origin).sweepIdle()).toBe(false);
		expect(drivers).toHaveLength(1);
	});

	test("chat and lane origins keep the 30-minute idle stop", async () => {
		expect(await stoppedAfter(ORIGIN, IDLE_STOP_MS - 1)).toBe(false);
		clock.advance(1);
		expect(await router.mailbox(ORIGIN).sweepIdle()).toBe(true);
		const lane = laneOriginKey("work");
		expect(await stoppedAfter(lane, IDLE_STOP_MS - 1)).toBe(false);
		clock.advance(1);
		expect(await router.mailbox(lane).sweepIdle()).toBe(true);
	});
});
