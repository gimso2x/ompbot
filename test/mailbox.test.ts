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
import {
	type CacheMissInfo,
	type ColdCacheInfo,
	NO_MODEL_NOTICE,
	OriginMailbox,
	type SessionMismatchInfo,
	STEER_BEFORE_ANSWER_SEEN_NOTE,
	type StuckLoopInfo,
	type TurnFailureEscalation,
	type TurnSettledInfo,
} from "../src/core/mailbox";
import { OriginRouter, openBotStore, sessionDirFor, slackDmOrigin } from "../src/core/origin";
import { IDLE_STOP_MS, type InboundRecord, MONITOR_IDLE_STOP_MS } from "../src/core/types";
import { laneOriginKey } from "../src/lanes/status";
import { createLogger } from "../src/log";
import { monitorOrigin } from "../src/monitors/ledger";
import { INTERIM_CLOSING, NO_ANSWER } from "../src/omp/answers";
import {
	OmpDriverError,
	type OmpEntries,
	type OmpEvent,
	type OmpFinal,
	type OmpOpenResult,
	type OmpState,
	type TodoPhase,
} from "../src/omp/driver";
import {
	FakeOmpDriver,
	type FakeOmpDriverOptions,
	FakeSessionStore,
	type FakeTurnMessage,
} from "../src/omp/fake-driver";
import { healSessionModelFile } from "../src/omp/session-heal";
import { redact } from "../src/redact";
import { openStore, type Store } from "../src/store/db";

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
	/** Holds the next `leafId()` / `steer()` until resolved, like a slow RPC round trip inside the mailbox's dispatch. */
	leafGate: PromiseWithResolvers<void> | undefined;
	steerGate: PromiseWithResolvers<void> | undefined;
	/** Resolves when a held `leafId()` / `steer()` is waiting on its gate. */
	gateEntered = Promise.withResolvers<void>();
	override async leafId(): Promise<string | null> {
		const gate = this.leafGate;
		if (gate !== undefined) {
			this.leafGate = undefined;
			this.gateEntered.resolve();
			await gate.promise;
		}
		return super.leafId();
	}
	override async steer(text: string): Promise<void> {
		const gate = this.steerGate;
		if (gate !== undefined) {
			this.steerGate = undefined;
			this.gateEntered.resolve();
			await gate.promise;
		}
		if (this.failSteers > 0) {
			this.failSteers--;
			this.calls.push(`steer-rejected:${text}`);
			throw new OmpDriverError("rpc_error", "steer refused");
		}
		return super.steer(text);
	}
	override async prompt(text: string): Promise<string> {
		if (this.stale) throw new OmpDriverError("rpc_error", "Could not restore model: fake/alpha");
		this.lastOpRef = await super.prompt(text);
		return this.lastOpRef;
	}
	lastOpRef: string | undefined;
	readonly #finals = new Set<(final: OmpFinal) => void>();
	override onFinal(listener: (final: OmpFinal) => void): () => void {
		this.#finals.add(listener);
		const off = super.onFinal(listener);
		return () => {
			this.#finals.delete(listener);
			off();
		};
	}
	/** Ends the running turn like omp's `agent_end` with an error (a provider stream that broke off). */
	failTurn(error: string): void {
		for (const listener of [...this.#finals])
			listener({ opRef: this.lastOpRef ?? "", status: "error", text: "", error });
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
let cacheMisses: CacheMissInfo[];
let coldCaches: ColdCacheInfo[];
let escalateAfter: number | undefined;
let restoreListed: readonly string[] | undefined;
let sessionBackupsRoot: string | undefined;
/** Set: the router gets a Slack thread source whose `botUserId()` returns `id` (peer failure notices mention it). */
let threadBot: { id: string | undefined } | undefined;

/** Fresh router over the current test knobs; `defaultModel` is only readable here, so stale-model tests rebuild the router. */
function buildRouter(): OriginRouter {
	return new OriginRouter({
		timezone: "Asia/Seoul",
		store,
		clock,
		sessionsRoot: join(dir, "sessions"),
		...(defaultModel === undefined ? {} : { defaultModel }),
		...(escalateAfter === undefined ? {} : { escalateAfter }),
		...(sessionBackupsRoot === undefined ? {} : { sessionBackupsRoot }),
		...(threadBot === undefined
			? {}
			: {
					threadSource: new Map([
						[
							"slack" as const,
							{
								botUserId: () => threadBot?.id,
								replies: async () => [],
								mentionUser: (userId: string) => `<@${userId}>`,
							},
						],
					]),
				}),
		log: createLogger({ sink: (line) => logLines.push(line), clock, redact }),
		statusProvider: (origin) => {
			statusCalls.push(origin);
			return "status: ok";
		},
		onEscalate: (info) => escalations.push(info),
		onCacheMiss: (info) => cacheMisses.push(info),
		onColdCache: (info) => coldCaches.push(info),
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
	store = openBotStore(join(dir, "ompbot.db"), clock, "Asia/Seoul");
	drivers = [];
	driverOptions = {};
	failSteers = 0;
	statusCalls = [];
	logLines = [];
	sessionStore = new FakeSessionStore();
	defaultModel = undefined;
	escalations = [];
	cacheMisses = [];
	coldCaches = [];
	escalateAfter = undefined;
	restoreListed = undefined;
	sessionBackupsRoot = undefined;
	threadBot = undefined;
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

	for (const held of ["leafId", "steer"] as const) {
		test(`the turn ending while a steer's ${held} call is in flight: the message runs as a new turn (#61)`, async () => {
			driverOptions = { holdTurns: true };
			const mailbox = router.mailbox(ORIGIN);
			const a = msg("long job");
			await router.route(a);
			const driver = drivers[0] as SteerFailingDriver;
			const gate = Promise.withResolvers<void>();
			if (held === "leafId") driver.leafGate = gate;
			else driver.steerGate = gate;
			const b = msg("추가 지시");
			const routed = router.route(b);
			await driver.gateEntered.promise;
			// The final arrives while the dispatch still awaits the call; its handler queues behind the dispatch.
			const finalSeen = Promise.withResolvers<void>();
			const off = driver.onFinal(() => {
				off();
				finalSeen.resolve();
			});
			driver.release();
			await finalSeen.promise;
			gate.resolve();
			await routed;
			await mailbox.sweepIdle();
			expect(driver.calls.filter((c) => c.startsWith("prompt:"))).toEqual(["prompt:long job", "prompt:추가 지시"]);
			const rowA = store.getInbound(a.platformMessageId);
			const rowB = store.getInbound(b.platformMessageId);
			expect(rowB?.opRef).not.toBe(rowA?.opRef ?? "missing");
			await untilFinal(mailbox, driver, () => driver.release());
			expect(store.getInbound(b.platformMessageId)?.state).toBe("answered");
			const replies = store.listDeliveries({ originKey: ORIGIN }).filter((d) => d.threadRef === b.threadRef);
			expect(replies.map((d) => d.body)).toEqual(["ECHO 추가 지시"]);
		});
	}

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

	test("omp without any model (no login, no API key) tells the owner to run omp login instead of just resending", async () => {
		driverOptions = {
			startError: new OmpDriverError(
				"not_started",
				"Agent process exited with code 1. Stderr: No default model selected. Use /login, set an API key environment variable, or select a local model",
			),
		};
		const a = msg("hi");
		await router.route(a);
		expect(store.getInbound(a.platformMessageId)?.state).toBe("failed_notified");
		expect(store.listDeliveries({ originKey: ORIGIN }).map((d) => d.body)).toEqual([NO_MODEL_NOTICE]);
		expect(NO_MODEL_NOTICE).toStartWith("[turn failed] omp_no_model");
		const command = msg("!model");
		await router.route(command);
		expect(store.listDeliveries({ originKey: ORIGIN }).map((d) => d.body)).toEqual([NO_MODEL_NOTICE, NO_MODEL_NOTICE]);
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

describe("mailbox: finished answers and wait notes reach the thread before the turn ends", () => {
	const FIRST = "분석 결과: wap 데몬은 CDP 9222 게이트 중계기로 붙고, 세션 쿠키는 매 실행마다 새로 받는다.";
	const NOTE = "⏳ 코드 지도는 아직 생성 중이에요. OCI에서 브라우저는 절반만 됩니다(헤드리스만).";
	const LAST = "지도 완료: 파일 412개, 진입점 3곳.";
	/** 2026-11-08 wap shape: stop answer, rule-guards continuation, status note next to `wait`, final stop answer. */
	const waitTurn: FakeTurnMessage[] = [
		{ role: "assistant", text: FIRST, stopReason: "stop" },
		{ role: "developer", text: "<system-reminder> session-stop-continuation" },
		{ role: "assistant", text: NOTE, stopReason: "toolUse", toolCalls: ["wait"] },
		{ role: "toolResult", text: "map done" },
		{ role: "assistant", text: LAST, stopReason: "stop" },
	];
	const rows = () => store.listDeliveries({ originKey: ORIGIN }).map((d) => [d.opRef, d.body]);

	async function heldTurn(script: readonly FakeTurnMessage[], text = "wap 분석") {
		driverOptions = { script: () => script, messageEvents: true, holdTurns: true };
		const mailbox = router.mailbox(ORIGIN);
		const message = msg(text);
		await router.route(message);
		const driver = drivers[0] as SteerFailingDriver;
		await driver.untilScripted();
		const opRef = store.getInbound(message.platformMessageId)?.opRef ?? "";
		const finish = () => untilFinal(mailbox, driver, () => driver.release());
		return { message, opRef, finish };
	}

	test("AC-1: the first stop answer and the wait note are recorded as :interim:0/:1 while the row stays dispatched", async () => {
		const { message, opRef } = await heldTurn(waitTurn);
		expect(rows()).toEqual([
			[`${opRef}:interim:0`, FIRST],
			[`${opRef}:interim:1`, NOTE],
		]);
		expect(store.getInbound(message.platformMessageId)?.state).toBe("dispatched");
	});

	test("AC-2: the turn end sends only the last stop answer under the turn op ref; every row is answered", async () => {
		const { message, opRef, finish } = await heldTurn(waitTurn);
		await finish();
		expect(rows()).toEqual([
			[`${opRef}:interim:0`, FIRST],
			[`${opRef}:interim:1`, NOTE],
			[opRef, LAST],
		]);
		expect(store.getInbound(message.platformMessageId)?.state).toBe("answered");
	});

	test("AC-2: an already sent answer re-written (trim-equal or nearly the same) is left out of the turn end body", async () => {
		const rewritten = `${FIRST.replace("새로", "다시")}  `;
		const { opRef, finish } = await heldTurn([
			{ role: "assistant", text: FIRST, stopReason: "stop" },
			{ role: "developer", text: "<system-reminder>" },
			{ role: "assistant", text: NOTE, stopReason: "toolUse", toolCalls: ["wait"] },
			{ role: "toolResult", text: "ok" },
			{ role: "assistant", text: `\n${FIRST}\n`, stopReason: "stop" },
			{ role: "developer", text: "<system-reminder>" },
			{ role: "assistant", text: rewritten, stopReason: "stop" },
			{ role: "developer", text: "<system-reminder>" },
			{ role: "assistant", text: LAST, stopReason: "stop" },
		]);
		// The re-written copies never go out a second time, early or at the turn end.
		await finish();
		expect(rows()).toEqual([
			[`${opRef}:interim:0`, FIRST],
			[`${opRef}:interim:1`, NOTE],
			[opRef, LAST],
		]);
	});

	test("AC-2: a turn whose answers all went out early closes with the closing mark, not (응답 없음)", async () => {
		const { message, opRef, finish } = await heldTurn([
			{ role: "assistant", text: FIRST, stopReason: "stop" },
			{ role: "developer", text: "<system-reminder>" },
			{ role: "assistant", text: NOTE, stopReason: "toolUse", toolCalls: ["wait"] },
			{ role: "toolResult", text: "ok" },
			{ role: "assistant", text: FIRST.replace("새로", "다시"), stopReason: "stop" },
		]);
		await finish();
		expect(rows()).toEqual([
			[`${opRef}:interim:0`, FIRST],
			[`${opRef}:interim:1`, NOTE],
			[opRef, INTERIM_CLOSING],
		]);
		expect(INTERIM_CLOSING).not.toBe(NO_ANSWER);
		expect(store.getInbound(message.platformMessageId)?.state).toBe("answered");
	});

	test("AC-2: a turn without interim deliveries and without an answer still sends (응답 없음)", async () => {
		const { opRef, finish } = await heldTurn([
			{ role: "assistant", text: "", stopReason: "toolUse", toolCalls: ["bash"] },
			{ role: "toolResult", text: "ok" },
			{ role: "assistant", text: "", stopReason: "stop" },
		]);
		await finish();
		expect(rows()).toEqual([[opRef, NO_ANSWER]]);
	});

	test("an early answer with a secret-shaped token is not sent again at the turn end (stored bodies are masked)", async () => {
		const keyed = `키는 xoxb-TEST-0-${"0".repeat(30)} 입니다.`;
		const { opRef, finish } = await heldTurn([
			{ role: "assistant", text: keyed, stopReason: "stop" },
			{ role: "developer", text: "<system-reminder>" },
			{ role: "assistant", text: NOTE, stopReason: "toolUse", toolCalls: ["wait"] },
			{ role: "toolResult", text: "ok" },
			{ role: "assistant", text: keyed, stopReason: "stop" },
		]);
		await finish();
		expect(rows()).toEqual([
			[`${opRef}:interim:0`, redact(keyed)],
			[`${opRef}:interim:1`, NOTE],
			[opRef, INTERIM_CLOSING],
		]);
	});

	test("a turn without answer text still quotes (응답 없음) in a steered thread's pointer", async () => {
		const { finish } = await heldTurn([{ role: "assistant", text: "", stopReason: "stop" }]);
		await router.route(msg("이것도", { threadRef: "D1:900.000009" }));
		await finish();
		const notices = store.listDeliveries({ originKey: ORIGIN }).filter((d) => d.opRef.includes(":steer:"));
		expect(notices.map((d) => d.body.split("\n")[1])).toEqual([`> ${NO_ANSWER}`]);
	});

	test("AC-4: toolUse text without wait and a wait note under 20 characters make no interim delivery", async () => {
		const shortNote = "⏳ 기다리는 중이에요.";
		expect(Array.from(shortNote).length).toBeLessThan(20);
		const { opRef, finish } = await heldTurn([
			{
				role: "assistant",
				text: "로그 파일을 열어서 원인 후보를 좁혀 볼게요. 먼저 최근 실패부터.",
				stopReason: "toolUse",
				toolCalls: ["read"],
			},
			{ role: "toolResult", text: "contents" },
			{ role: "assistant", text: shortNote, stopReason: "toolUse", toolCalls: ["wait"] },
			{ role: "toolResult", text: "done" },
			{ role: "assistant", text: LAST, stopReason: "stop" },
		]);
		expect(rows()).toEqual([]);
		await finish();
		expect(rows()).toEqual([[opRef, LAST]]);
	});

	test("AC-4: a monitor turn makes no interim delivery and answers with its last text", async () => {
		driverOptions = { script: () => waitTurn, messageEvents: true, holdTurns: true };
		const id = store.monitors.addMonitor({
			name: "brief",
			trigger: { kind: "cron", schedule: "0 9 * * *", timezone: "UTC" },
			instruction: "x",
			overlap: "queue",
			enabled: true,
		}).id;
		const origin = monitorOrigin(id);
		const answered: string[][] = [];
		const recordAnswer = store.recordAnswer.bind(store);
		store.recordAnswer = (input) => {
			answered.push([...input.parts]);
			return recordAnswer(input);
		};
		await router.route(msg("go", { originKey: origin }));
		const driver = drivers[0] as SteerFailingDriver;
		await driver.untilScripted();
		expect(store.listDeliveries().filter((d) => d.opRef.includes(":interim:"))).toEqual([]);
		await untilFinal(router.mailbox(origin), driver, () => driver.release());
		expect(answered).toEqual([[LAST]]);
		expect(store.listDeliveries().filter((d) => d.opRef.includes(":interim:"))).toEqual([]);
	});

	test("AC-5: a `✅ 완료` answer that went out early is copied to the log channel exactly once at the turn end", async () => {
		await router.close();
		store.close();
		store = openStore({ timezone: "Asia/Seoul", path: join(dir, "log.db"), clock, redact, logChannel: "C0LOGCHAN01" });
		router = buildRouter();
		const report = "✅ 완료 — wap 분석\n게이트 중계기 확인, 세션 쿠키 갱신 경로 정리.";
		const { opRef, finish } = await heldTurn([
			{ role: "assistant", text: report, stopReason: "stop" },
			{ role: "developer", text: "<system-reminder>" },
			{ role: "assistant", text: NOTE, stopReason: "toolUse", toolCalls: ["wait"] },
			{ role: "toolResult", text: "ok" },
			{ role: "assistant", text: LAST, stopReason: "stop" },
		]);
		const copies = () => store.listDeliveries().filter((d) => d.opRef.endsWith(":log-copy"));
		expect(copies()).toEqual([]);
		await finish();
		expect(copies().map((d) => [d.opRef, d.body.split("\n").slice(1).join("\n")])).toEqual([
			[`${opRef}:log-copy`, `${report}\n\n${LAST}`],
		]);
	});

	test("AC-5: a row steered in from another thread gets its pointer notice once, at the turn end", async () => {
		const { opRef, finish } = await heldTurn(waitTurn);
		await router.route(msg("이것도", { threadRef: "D1:900.000009" }));
		const notices = () => store.listDeliveries({ originKey: ORIGIN }).filter((d) => d.opRef.includes(":steer:"));
		expect(notices()).toEqual([]);
		await finish();
		expect(notices().map((d) => [d.opRef, d.threadRef])).toEqual([[`${opRef}:steer:0`, "D1:900.000009"]]);
		expect(notices()[0]?.body).toContain(FIRST.slice(0, 20));
	});
});

describe("mailbox: an owner steer written before the turn's answer reached the owner gets a note", () => {
	const ANSWER = "네, 다 확인했습니다. safe-care-web은 배포 대기 중이고 남은 일은 없습니다.";
	const steers = (driver: FakeOmpDriver) => driver.calls.filter((c) => c.startsWith("steer:"));

	test("AC-1: a steer while the stop answer is still pending starts with the note; the inbound row keeps the text", async () => {
		driverOptions = {
			script: () => [{ role: "assistant", text: ANSWER, stopReason: "stop" }],
			messageEvents: true,
			holdTurns: true,
		};
		await router.route(msg("상태 확인해"));
		const driver = drivers[0] as SteerFailingDriver;
		await driver.untilScripted();
		const asked = msg("어디갔어 쑥");
		await router.route(asked);
		const [steered] = steers(driver);
		expect(steered?.startsWith(`steer:${STEER_BEFORE_ANSWER_SEEN_NOTE}\n`)).toBe(true);
		expect(steered?.endsWith("\n어디갔어 쑥")).toBe(true);
		expect(store.getInbound(asked.platformMessageId)?.textRef).toBe("어디갔어 쑥");
		expect(store.getInbound(asked.platformMessageId)?.state).toBe("dispatched");
	});

	test("AC-2: a row written before the interim answer went out gets the note; one written 1s after it does not", async () => {
		driverOptions = { holdTurns: true };
		const mailbox = router.mailbox(ORIGIN);
		await router.route(msg("상태 확인해"));
		const driver = drivers[0] as SteerFailingDriver;
		// Written (recorded) first, dispatched only after the interim answer was delivered.
		const early = msg("어디갔어 쑥");
		store.recordInbound({ originKey: ORIGIN, platformMessageId: early.platformMessageId, textRef: early.text });
		clock.advance(500);
		const message = { role: "assistant", content: [{ type: "text", text: ANSWER }], stopReason: "stop" };
		driver.emitTestEvent({ type: "message_end", message });
		driver.emitTestEvent({ type: "message_start", message: { role: "developer" } });
		expect(store.listDeliveries({ originKey: ORIGIN }).map((d) => d.body)).toEqual([ANSWER]);
		await mailbox.resumePending();
		expect(steers(driver)).toEqual([`steer:${STEER_BEFORE_ANSWER_SEEN_NOTE}\n\n[현재 요청]\n어디갔어 쑥`]);
		clock.advance(1000);
		await router.route(msg("취소해"));
		expect(steers(driver).at(-1)).toBe("steer:취소해");
	});

	test("AC-2: a turn without an answer steers the text as is", async () => {
		driverOptions = { holdTurns: true };
		await router.route(msg("상태 확인해"));
		const driver = drivers[0] as SteerFailingDriver;
		const message = { role: "assistant", content: [{ type: "toolCall", name: "bash" }], stopReason: "toolUse" };
		driver.emitTestEvent({ type: "message_end", message });
		driver.emitTestEvent({ type: "tool_execution_start", toolCallId: "c0", toolName: "bash" });
		await router.route(msg("어디갔어 쑥"));
		expect(steers(driver)).toEqual(["steer:어디갔어 쑥"]);
	});

	test("AC-2: the note tells the model to handle a new question, instruction or command", () => {
		expect(STEER_BEFORE_ANSWER_SEEN_NOTE).toContain("질문·지시·명령");
		expect(STEER_BEFORE_ANSWER_SEEN_NOTE).toContain("그대로 처리");
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

/** Reports `reported` as the session file it opened, like an omp child that bound some other session. */
class ReportingDriver extends FakeOmpDriver {
	readonly #reported: string | undefined;

	constructor(options: FakeOmpDriverOptions, reported: string | undefined) {
		super(options);
		this.#reported = reported;
	}

	override async state(): Promise<OmpState> {
		const state = await super.state();
		return this.#reported === undefined ? state : { ...state, sessionFile: this.#reported };
	}
}

describe("mailbox: session resume check", () => {
	const RESUME_ORIGIN = "slack/dm/DRESUME";
	let mismatches: SessionMismatchInfo[];
	let opened: ReportingDriver[];

	/** A mailbox built directly (no router) whose children report `reported(sessionDir)` as their session file. */
	function resumeMailbox(reported: (sessionDir: string) => string | undefined): OriginMailbox {
		return new OriginMailbox({
			timezone: "Asia/Seoul",
			originKey: RESUME_ORIGIN,
			store,
			clock,
			log: createLogger({ sink: (line) => logLines.push(line), clock, redact }),
			statusProvider: () => "status: ok",
			sessionDirFor: (key, epoch) => sessionDirFor(join(dir, "sessions"), key, epoch),
			driverFactory: (_origin, sessionDir) => {
				const driver = new ReportingDriver({ sessionDir, store: sessionStore }, reported(sessionDir));
				opened.push(driver);
				return driver;
			},
			onSessionMismatch: (info) => mismatches.push(info),
		});
	}

	/** A saved session of the origin's epoch 1: what the next open is expected to resume. */
	function savedSession(): string {
		const sessionDir = sessionDirFor(join(dir, "sessions"), RESUME_ORIGIN, 1);
		mkdirSync(sessionDir, { recursive: true });
		const file = join(sessionDir, "2026-11-03T00-00-00-000Z_aaaa0000.jsonl");
		writeFileSync(file, `${JSON.stringify({ type: "session", version: 1, id: "aaaa0000", cwd: dir })}\n`);
		return file;
	}

	const mismatchLogs = () => logLines.filter((line) => line.includes("event=session_resume_mismatch"));

	beforeEach(() => {
		mismatches = [];
		opened = [];
	});

	test("a child that opened another file than the one to resume: one warn line and one notice per epoch", async () => {
		const expected = savedSession();
		const other = join(dir, "elsewhere", "2026-11-03T01-00-00-000Z_bbbb0000.jsonl");
		const mailbox = resumeMailbox(() => other);
		try {
			const first = msg("이어서", { originKey: RESUME_ORIGIN });
			await mailbox.enqueue(first);
			await mailbox.sweepIdle();
			expect(mismatchLogs()).toHaveLength(1);
			expect(mismatchLogs()[0]).toContain("level=warn");
			expect(mismatches).toEqual([{ originKey: RESUME_ORIGIN, threadRef: first.threadRef, expected, actual: other }]);
			// The turn still ran in the opened session.
			expect(store.getInbound(first.platformMessageId)?.state).toBe("answered");

			// Same (origin, epoch) opened again after an idle stop: logged again, never noticed twice.
			clock.advance(IDLE_STOP_MS);
			expect(await mailbox.sweepIdle()).toBe(true);
			await mailbox.enqueue(msg("또", { originKey: RESUME_ORIGIN }));
			expect(opened).toHaveLength(2);
			expect(mismatchLogs()).toHaveLength(2);
			expect(mismatches).toHaveLength(1);
		} finally {
			await mailbox.close();
		}
	});

	/** Runs one turn on a fresh mailbox and returns its child's calls; nothing about the resume may be signalled. */
	async function quietTurn(reported: (sessionDir: string) => string | undefined): Promise<string[]> {
		const mailbox = resumeMailbox(reported);
		try {
			const row = msg("안녕", { originKey: RESUME_ORIGIN });
			await mailbox.enqueue(row);
			await mailbox.sweepIdle();
			expect(store.getInbound(row.platformMessageId)?.state).toBe("answered");
			expect(mismatchLogs()).toEqual([]);
			expect(mismatches).toEqual([]);
			return opened[0]?.calls ?? [];
		} finally {
			await mailbox.close();
		}
	}

	test("the child opened the file to resume: no line, no notice, the turn runs as before", async () => {
		const expected = savedSession();
		expect(await quietTurn(() => expected)).toEqual(["openSession", "prompt:안녕"]);
	});

	test("an empty epoch dir (nothing to resume): no line, no notice, the turn runs as before", async () => {
		const elsewhere = join(dir, "x.jsonl");
		expect(await quietTurn(() => elsewhere)).toEqual(["openSession", "prompt:안녕"]);
	});

	test("a child that does not report its session file: no line, no notice, the turn runs as before", async () => {
		savedSession();
		expect(await quietTurn(() => undefined)).toEqual(["openSession", "prompt:안녕"]);
	});
});

/** Can deliver an event at a moment the test picks, e.g. from inside a final listener. */
class LoopDriver extends FakeOmpDriver {
	readonly #listeners = new Set<(event: OmpEvent) => void>();

	override onEvent(listener: (event: OmpEvent) => void): () => void {
		this.#listeners.add(listener);
		const off = super.onEvent(listener);
		return () => {
			this.#listeners.delete(listener);
			off();
		};
	}

	/** Test control: the child reports `event` now. */
	emitEvent(event: OmpEvent): void {
		for (const listener of this.#listeners) listener(event);
	}
}

describe("mailbox: tool repeat loop (stuck-loop)", () => {
	const LOOP_ORIGIN = "slack/dm/DLOOP";
	let loops: StuckLoopInfo[];
	let opened: LoopDriver[];

	/** `bun test` failing the same way: the i-th identical start/end pair. */
	const start = (i: number): OmpEvent => ({
		type: "tool_execution_start",
		toolCallId: `loop-${i}`,
		toolName: "bash",
		args: { command: "bun test" },
	});
	const end = (i: number): OmpEvent => ({
		type: "tool_execution_end",
		toolCallId: `loop-${i}`,
		toolName: "bash",
		result: { content: [{ type: "text", text: "1 fail" }], details: { durationMs: i } },
		isError: true,
	});
	const pairs = (n: number): OmpEvent[] => Array.from({ length: n }, (_, k) => [start(k + 1), end(k + 1)]).flat();

	function loopMailbox(options: FakeOmpDriverOptions): OriginMailbox {
		return new OriginMailbox({
			timezone: "Asia/Seoul",
			originKey: LOOP_ORIGIN,
			store,
			clock,
			log: createLogger({ sink: (line) => logLines.push(line), clock, redact }),
			statusProvider: () => "status: ok",
			sessionDirFor: (key, epoch) => sessionDirFor(join(dir, "sessions"), key, epoch),
			driverFactory: (_origin, sessionDir) => {
				const driver = new LoopDriver({ ...options, sessionDir, store: sessionStore });
				opened.push(driver);
				return driver;
			},
			onStuckLoop: (info) => loops.push(info),
		});
	}

	beforeEach(() => {
		loops = [];
		opened = [];
	});

	test("the same call six times: one steer at the 3rd, then abort and a stuck-loop failure at the 6th", async () => {
		const mailbox = loopMailbox({ holdTurns: true, events: pairs(6) });
		try {
			const row = msg("테스트 고쳐", { originKey: LOOP_ORIGIN });
			await mailbox.enqueue(row);
			const driver = opened[0] as LoopDriver;
			await untilFinal(mailbox, driver, () => {});
			expect(driver.calls.filter((c) => c.startsWith("steer:"))).toHaveLength(1);
			expect(driver.calls).toContain("abort");
			expect(loops).toEqual([
				{
					originKey: LOOP_ORIGIN,
					threadRef: row.threadRef,
					opRef: store.getInbound(row.platformMessageId)?.opRef ?? "missing",
					toolName: "bash",
					count: 6,
				},
			]);
			expect(store.getInbound(row.platformMessageId)?.state).toBe("failed_notified");
			const bodies = store.listDeliveries({ originKey: LOOP_ORIGIN }).map((d) => d.body);
			expect(bodies).toHaveLength(1);
			expect(bodies[0]).toStartWith("[turn failed] stuck-loop: ");
		} finally {
			await mailbox.close();
		}
	});

	test("a normal final that lands before the loop abort settles the turn once, as answered", async () => {
		const mailbox = loopMailbox({ events: [...pairs(5), start(6)] });
		try {
			const row = msg("테스트 고쳐", { originKey: LOOP_ORIGIN });
			await mailbox.enqueue(row);
			const driver = opened[0] as LoopDriver;
			// The 6th end arrives right behind the final: the mailbox has queued the final's settlement first.
			await untilFinal(mailbox, driver, () => {
				driver.onFinal(() => driver.emitEvent(end(6)));
			});
			expect(driver.calls).not.toContain("abort");
			expect(loops).toEqual([]);
			expect(store.getInbound(row.platformMessageId)?.state).toBe("answered");
			const bodies = store.listDeliveries({ originKey: LOOP_ORIGIN }).map((d) => d.body);
			expect(bodies).toEqual(["ECHO 테스트 고쳐"]);
		} finally {
			await mailbox.close();
		}
	});

	test("qa50b K-2: an abort that throws stops the child before the turn is settled as failed", async () => {
		const stopped = Promise.withResolvers<void>();
		class AbortFailingDriver extends LoopDriver {
			override async abort(): Promise<void> {
				this.calls.push("abort");
				throw new Error("abort rpc timed out");
			}
			override async stop(): Promise<void> {
				stopped.resolve();
				await super.stop();
			}
		}
		const mailbox = new OriginMailbox({
			timezone: "Asia/Seoul",
			originKey: LOOP_ORIGIN,
			store,
			clock,
			log: createLogger({ sink: (line) => logLines.push(line), clock, redact }),
			statusProvider: () => "status: ok",
			sessionDirFor: (key, epoch) => sessionDirFor(join(dir, "sessions"), key, epoch),
			driverFactory: (_origin, sessionDir) =>
				new AbortFailingDriver({ holdTurns: true, events: pairs(6), sessionDir, store: sessionStore }),
			onStuckLoop: (info) => loops.push(info),
		});
		try {
			const row = msg("테스트 고쳐", { originKey: LOOP_ORIGIN });
			await mailbox.enqueue(row);
			const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2000));
			expect(await Promise.race([stopped.promise.then(() => "stopped"), timeout])).toBe("stopped");
			await mailbox.sweepIdle();
			expect(store.getInbound(row.platformMessageId)?.state).toBe("failed_notified");
		} finally {
			await mailbox.close();
		}
	});
});

describe("mailbox: an owner message answers the origin's one open omp dialog", () => {
	const DIALOG_ORIGIN = "slack/dm/D7";
	let answers: string[];
	let ambiguous: Array<{ originKey: string; threadRef: string }>;
	let open: number;
	/** False: the open card closes before reading the message (a click got there first). */
	let reads: boolean;
	let opened: FakeOmpDriver[];

	function dialogMailbox(): OriginMailbox {
		return new OriginMailbox({
			timezone: "Asia/Seoul",
			originKey: DIALOG_ORIGIN,
			store,
			clock,
			log: createLogger({ sink: (line) => logLines.push(line), clock, redact }),
			statusProvider: () => "status: ok",
			sessionDirFor: (key, epoch) => sessionDirFor(join(dir, "sessions"), key, epoch),
			driverFactory: (_origin, sessionDir) => {
				const driver = new FakeOmpDriver({ holdTurns: true, sessionDir, store: sessionStore });
				opened.push(driver);
				return driver;
			},
			dialogs: {
				open: (originKey) => (originKey === DIALOG_ORIGIN ? open : 0),
				answer: async (originKey, text) => {
					if (originKey !== DIALOG_ORIGIN || open !== 1) return false;
					open = 0;
					if (!reads) return false;
					answers.push(text);
					return true;
				},
				ambiguous: (info) => ambiguous.push(info),
			},
		});
	}

	beforeEach(() => {
		answers = [];
		ambiguous = [];
		open = 0;
		reads = true;
		opened = [];
	});

	test("one open dialog: the message becomes its answer, is not steered, and is answered with the turn", async () => {
		const mailbox = dialogMailbox();
		try {
			const lead = msg("배포 준비해", { originKey: DIALOG_ORIGIN });
			await mailbox.enqueue(lead);
			const driver = opened[0] as FakeOmpDriver;
			open = 1;
			const reply = msg("B로 가자", { originKey: DIALOG_ORIGIN, threadRef: lead.threadRef });
			await mailbox.enqueue(reply);
			expect(answers).toEqual(["B로 가자"]);
			expect(driver.calls.filter((c) => c.startsWith("steer:"))).toEqual([]);
			const row = store.getInbound(reply.platformMessageId);
			expect(row?.state).toBe("dispatched");
			expect(row?.opRef).toBe(store.getInbound(lead.platformMessageId)?.opRef ?? "missing");
			await untilFinal(mailbox, driver, () => driver.release());
			expect(store.getInbound(reply.platformMessageId)?.state).toBe("answered");
		} finally {
			await mailbox.close();
		}
	});

	test("the daemon's path (recordInbound, then resumePending) answers the one open dialog instead of steering", async () => {
		const mailbox = dialogMailbox();
		try {
			const lead = msg("배포 준비해", { originKey: DIALOG_ORIGIN });
			await mailbox.enqueue(lead);
			const driver = opened[0] as FakeOmpDriver;
			open = 1;
			const reply = msg("B로 가자", { originKey: DIALOG_ORIGIN, threadRef: lead.threadRef });
			store.recordInbound({
				originKey: DIALOG_ORIGIN,
				platformMessageId: reply.platformMessageId,
				textRef: reply.text,
				threadRef: reply.threadRef,
			});
			await mailbox.resumePending();
			expect(answers).toEqual(["B로 가자"]);
			expect(driver.calls.filter((c) => c.startsWith("steer:"))).toEqual([]);
			const row = store.getInbound(reply.platformMessageId);
			expect(row?.state).toBe("dispatched");
			expect(row?.opRef).toBe(store.getInbound(lead.platformMessageId)?.opRef ?? "missing");
		} finally {
			await mailbox.close();
		}
	});

	test("a message the closing card never read is steered into the turn, not dropped", async () => {
		const mailbox = dialogMailbox();
		try {
			const lead = msg("배포 준비해", { originKey: DIALOG_ORIGIN });
			await mailbox.enqueue(lead);
			const driver = opened[0] as FakeOmpDriver;
			open = 1;
			reads = false;
			const reply = msg("그리고 테스트도", { originKey: DIALOG_ORIGIN, threadRef: lead.threadRef });
			await mailbox.enqueue(reply);
			expect(answers).toEqual([]);
			expect(driver.calls.filter((c) => c.startsWith("steer:"))).toEqual(["steer:그리고 테스트도"]);
			expect(store.getInbound(reply.platformMessageId)?.state).toBe("dispatched");
			expect(logLines.some((line) => line.includes("dialog_reply_unconsumed"))).toBe(true);
		} finally {
			await mailbox.close();
		}
	});

	test("two open dialogs: the message is not consumed, the owner is told once, and it is steered as before", async () => {
		const mailbox = dialogMailbox();
		try {
			const lead = msg("배포 준비해", { originKey: DIALOG_ORIGIN });
			await mailbox.enqueue(lead);
			const driver = opened[0] as FakeOmpDriver;
			open = 2;
			const reply = msg("B로 가자", { originKey: DIALOG_ORIGIN, threadRef: lead.threadRef });
			await mailbox.enqueue(reply);
			expect(answers).toEqual([]);
			expect(ambiguous).toEqual([{ originKey: DIALOG_ORIGIN, threadRef: lead.threadRef }]);
			expect(driver.calls.filter((c) => c.startsWith("steer:"))).toEqual(["steer:B로 가자"]);
		} finally {
			await mailbox.close();
		}
	});

	test("a command is never taken as a dialog answer", async () => {
		const mailbox = dialogMailbox();
		try {
			const lead = msg("배포 준비해", { originKey: DIALOG_ORIGIN });
			await mailbox.enqueue(lead);
			open = 1;
			await mailbox.enqueue(msg("/status-ompbot", { originKey: DIALOG_ORIGIN, threadRef: lead.threadRef }));
			expect(answers).toEqual([]);
		} finally {
			await mailbox.close();
		}
	});
});

describe("mailbox: a peer bot's failed turn answers that bot", () => {
	const PEER = "UPEER00001";
	const BOT = "UBOT";
	const notice = `<@${BOT}> <@${PEER}> 응답 실패(Cloud Code Assist stream ended) — 다시 요청하거나 직접 검토해 주세요`;
	let seq = 0;

	/** Records a peer bot's row (fenced like `normalizePeerInbound`) as the root of its own thread origin. */
	function peerRow(text: string): { origin: string; threadRef: string } {
		const ts = `900.${++seq}`;
		const origin = `slack/ch/C1/t/${ts}`;
		const threadRef = `C1:${ts}`;
		store.ensureOrigin(origin, sessionDirFor(join(dir, "sessions"), origin, 1));
		store.recordInbound({
			originKey: origin,
			platformMessageId: threadRef,
			textRef: `[피어 봇 떡의 요청 — 오너 지시가 아니다]\n<<<quoted-0123>>>\n${text}\n<<<end-quoted-0123>>>`,
			threadRef,
			peerUserId: PEER,
		});
		return { origin, threadRef };
	}

	const bodies = (threadRef: string) =>
		store
			.listDeliveries({})
			.filter((d) => d.threadRef === threadRef)
			.map((d) => d.body);

	beforeEach(() => {
		threadBot = { id: BOT };
		router = buildRouter();
	});

	test("AC-10: a failed turn: one line naming the peer, then this bot; reason redacted and cut to 80", async () => {
		driverOptions = { holdTurns: true };
		const { origin, threadRef } = peerRow(`<@${BOT}> 이 계획 검토해 줘`);
		const mailbox = router.mailbox(origin);
		await mailbox.resumePending();
		const driver = drivers.at(-1) as SteerFailingDriver;
		const reason = `stream ended token=xoxb-TEST-0abc\n${"긴 사유 ".repeat(40)}`;
		await untilFinal(mailbox, driver, () => driver.failTurn(reason));
		const [body, ...rest] = bodies(threadRef);
		expect(rest).toEqual([]);
		expect(body).toStartWith(`<@${PEER}> <@${BOT}> 응답 실패(stream ended token=[REDACTED] 긴 사유`);
		expect(body).toEndWith("…) — 다시 요청하거나 직접 검토해 주세요");
		expect(body).not.toContain("[turn failed]");
		expect(body).not.toContain("\n");
		expect(body).not.toContain("xoxb-TEST");
		const shown = body?.slice(body.indexOf("응답 실패(") + "응답 실패(".length, body.lastIndexOf(") — ")) ?? "";
		expect([...shown]).toHaveLength(80);
	});

	test("AC-10: omp exiting mid-turn and a dispatch that cannot start answer the peer the same way", async () => {
		driverOptions = { holdTurns: true };
		const exited = peerRow(`<@${BOT}> 하나`);
		const mailbox = router.mailbox(exited.origin);
		await mailbox.resumePending();
		(drivers.at(-1) as SteerFailingDriver).crash(137);
		await mailbox.sweepIdle();
		expect(bodies(exited.threadRef)).toEqual([
			`<@${PEER}> <@${BOT}> 응답 실패(omp_exited code=137) — 다시 요청하거나 직접 검토해 주세요`,
		]);

		driverOptions = { startError: new OmpDriverError("omp_executable_missing", "no omp") };
		const refused = peerRow(`<@${BOT}> 둘`);
		await router.mailbox(refused.origin).resumePending();
		expect(bodies(refused.threadRef)).toEqual([
			`<@${PEER}> <@${BOT}> 응답 실패(omp_executable_missing) — 다시 요청하거나 직접 검토해 주세요`,
		]);
	});

	test("AC-10: before the bot id is known the notice names the peer alone", async () => {
		threadBot = { id: undefined };
		driverOptions = { startError: new OmpDriverError("omp_executable_missing", "no omp") };
		const { origin, threadRef } = peerRow(`<@${BOT}> 셋`);
		await router.mailbox(origin).resumePending();
		expect(bodies(threadRef)).toEqual([
			`<@${PEER}> 응답 실패(omp_executable_missing) — 다시 요청하거나 직접 검토해 주세요`,
		]);
	});

	test("AC-12: a peer turn opened by a failure notice fails without a mention; a text with only one half still mentions", async () => {
		driverOptions = { startError: new OmpDriverError("omp_executable_missing", "no omp") };
		const looped = peerRow(notice);
		await router.mailbox(looped.origin).resumePending();
		expect(bodies(looped.threadRef)).toEqual(["[turn failed] omp_executable_missing — 다시 보내 주세요"]);

		for (const half of [`<@${BOT}> 응답 실패(어제 건) 다시 볼래?`, `<@${BOT}> 이건 직접 검토해 주세요`]) {
			const { origin, threadRef } = peerRow(half);
			await router.mailbox(origin).resumePending();
			expect(bodies(threadRef)).toEqual([
				`<@${PEER}> <@${BOT}> 응답 실패(omp_executable_missing) — 다시 요청하거나 직접 검토해 주세요`,
			]);
		}
	});

	test("AC-11: the owner's failed turn keeps the plain notice even with a thread source", async () => {
		driverOptions = { startError: new OmpDriverError("omp_executable_missing", "no omp") };
		await router.route(msg("owner ask"));
		expect(store.listDeliveries({ originKey: ORIGIN }).map((d) => d.body)).toEqual([
			"[turn failed] omp_executable_missing — 다시 보내 주세요",
		]);
	});
});

describe("mailbox: prompt cache monitor", () => {
	const MIN = 60_000;
	const MODEL = "claude-opus-5-5";
	/** omp's `message_end` of an assistant call with its usage (cache write priced like Opus: $6.25 per million). */
	const usageEvent = (cacheRead: number, cacheWrite: number): OmpEvent => ({
		type: "message_end",
		message: {
			role: "assistant",
			content: [],
			provider: "anthropic",
			model: MODEL,
			usage: { input: 3, output: 5, cacheRead, cacheWrite, cost: { cacheWrite: cacheWrite * 6.25e-6 } },
		},
	});
	let events: OmpEvent[];
	const cacheMissLogs = () => logLines.filter((line) => line.includes("event=cache_miss"));
	const monitorId = () =>
		store.monitors.addMonitor({
			name: "retro",
			trigger: { kind: "cron", schedule: "0 23 * * *", timezone: "UTC" },
			instruction: "x",
			overlap: "queue",
			enabled: true,
		}).id;

	beforeEach(() => {
		events = [];
		driverOptions = { holdTurns: true, events };
	});

	/** One finished turn on `origin`: its usage events and its final have been handled. */
	async function turn(text: string, origin = ORIGIN): Promise<InboundRecord> {
		const record = msg(text, { originKey: origin });
		await router.route(record);
		const driver = drivers.at(-1);
		if (driver === undefined) throw new Error("no driver");
		await untilFinal(router.mailbox(origin), driver, () => driver.release());
		return record;
	}

	/** Stops the origin's child by the idle sweep, so the next turn starts a new one. */
	async function restartChild(origin = ORIGIN, idleMs = IDLE_STOP_MS): Promise<void> {
		clock.advance(idleMs);
		expect(await router.mailbox(origin).sweepIdle()).toBe(true);
	}

	/** A saved session of `origin` epoch 1 whose last entry is an assistant message (with `usage`, if given) at `at`. */
	function seedSession(origin: string, at: number, usage?: { cacheRead: number; cacheWrite: number }): void {
		const sessionDir = sessionDirFor(join(dir, "sessions"), origin, 1);
		sessionStore.open(sessionDir);
		const session = sessionStore.sessions.get(sessionDir);
		if (session === undefined) throw new Error("no session");
		session.entries.push({
			id: "e3",
			parentId: "e2",
			type: "message",
			timestamp: new Date(at).toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "이전 답" }],
				stopReason: "stop",
				...(usage === undefined
					? {}
					: {
							provider: "anthropic",
							model: MODEL,
							usage: { input: 3, output: 5, ...usage, cost: { cacheWrite: usage.cacheWrite * 6.25e-6 } },
						}),
			},
		});
		session.nextId = 4;
	}

	test("AC-2: a restarted child's big miss logs reason=child_restart once and calls onCacheMiss once; a second within 24h does not", async () => {
		events.push(usageEvent(300_000, 30_000));
		await turn("one");
		expect(cacheMissLogs()).toHaveLength(0);
		await restartChild();
		events.splice(0, events.length, usageEvent(28_000, 302_000));
		const second = await turn("two");
		expect(cacheMissLogs().filter((line) => line.includes("reason=child_restart"))).toHaveLength(1);
		expect(cacheMisses).toHaveLength(1);
		expect(cacheMisses[0]).toMatchObject({
			originKey: ORIGIN,
			threadRef: second.threadRef,
			reason: "child_restart",
			missedTokens: 302_000,
			cacheWrite: 302_000,
			model: MODEL,
		});
		await restartChild();
		await turn("three");
		expect(cacheMissLogs().filter((line) => line.includes("reason=child_restart"))).toHaveLength(2);
		expect(cacheMisses).toHaveLength(1);
	});

	test("AC-2: a monitor origin logs its miss but never calls onCacheMiss", async () => {
		const origin = monitorOrigin(monitorId());
		events.push(usageEvent(300_000, 30_000));
		await turn("run", origin);
		await restartChild(origin, MONITOR_IDLE_STOP_MS);
		events.splice(0, events.length, usageEvent(28_000, 302_000));
		await turn("run again", origin);
		expect(cacheMissLogs().filter((line) => line.includes("reason=child_restart"))).toHaveLength(1);
		expect(cacheMisses).toHaveLength(0);
	});

	test("AC-2b: a new mailbox seeds its baseline from the session's last assistant usage", async () => {
		seedSession(ORIGIN, clock.now() - 10 * MIN, { cacheRead: 300_000, cacheWrite: 30_000 });
		events.push(usageEvent(28_000, 302_000));
		await turn("after the daemon restart");
		expect(cacheMissLogs().filter((line) => line.includes("reason=child_restart"))).toHaveLength(1);
		expect(cacheMisses.map((miss) => [miss.reason, miss.missedTokens])).toEqual([["child_restart", 302_000]]);
	});

	test("AC-2b: a session without assistant usage seeds nothing: the first call is no miss", async () => {
		seedSession(ORIGIN, clock.now() - 10 * MIN);
		events.push(usageEvent(28_000, 302_000));
		await turn("first");
		expect(cacheMissLogs()).toHaveLength(0);
		expect(cacheMisses).toHaveLength(0);
	});

	test("a /new-ompbot session is judged on its own prefix, not the old session's", async () => {
		events.push(usageEvent(300_000, 30_000));
		await turn("one");
		await router.route(msg("/new-ompbot"));
		events.splice(0, events.length, usageEvent(0, 25_000));
		await turn("fresh");
		expect(cacheMissLogs()).toHaveLength(0);
		expect(cacheMisses).toHaveLength(0);
	});

	test("AC-3: a 250k conversation idle for 2 hours warns its new turn's thread once per baseline", async () => {
		seedSession(ORIGIN, clock.now() - 120 * MIN, { cacheRead: 240_000, cacheWrite: 10_000 });
		const first = await turn("돌아왔어");
		expect(coldCaches).toHaveLength(1);
		expect(coldCaches[0]).toMatchObject({
			originKey: ORIGIN,
			threadRef: first.threadRef,
			prefixTokens: 250_000,
			idleMs: 120 * MIN,
		});
		expect(coldCaches[0]?.estimatedCost).toBeCloseTo(250_000 * 6.25e-6, 9);
		await turn("하나 더");
		expect(coldCaches).toHaveLength(1);
	});

	test("AC-3: a 150k conversation idle for 2 hours is not warned", async () => {
		seedSession(ORIGIN, clock.now() - 120 * MIN, { cacheRead: 140_000, cacheWrite: 10_000 });
		await turn("돌아왔어");
		expect(coldCaches).toHaveLength(0);
	});

	test("AC-3: a monitor origin is never warned", async () => {
		const origin = monitorOrigin(monitorId());
		seedSession(origin, clock.now() - 120 * MIN, { cacheRead: 240_000, cacheWrite: 10_000 });
		await turn("run", origin);
		expect(coldCaches).toHaveLength(0);
	});
});

describe("session file heal picks the record omp restores (role fallback)", () => {
	const record = (id: string, model: string, role?: string) =>
		JSON.stringify({
			type: "model_change",
			id,
			timestamp: "2026-11-10T00:00:01.000Z",
			model,
			...(role ? { role } : {}),
		});
	const message = (id: string) =>
		JSON.stringify({
			type: "message",
			id,
			timestamp: "2026-11-10T00:01:00.000Z",
			message: { role: "user", content: [] },
		});
	/** omp's restore candidate: after a `role: "fallback"` last record, the last record whose role is none or default. */
	const restoreTarget = (file: string): string | undefined => {
		const changes = readFileSync(file, "utf8")
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as { type?: string; model?: string; role?: string })
			.filter((entry) => entry.type === "model_change");
		const last = changes.at(-1);
		if (last?.role !== "fallback") return last?.model;
		return changes.findLast((entry) => (entry.role ?? "default") === "default")?.model;
	};
	const temps: string[] = [];
	afterEach(() => {
		for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true });
	});
	const sessionFile = (lines: string[]): string => {
		const temp = mkdtempSync(join(tmpdir(), "ompbot-heal-"));
		temps.push(temp);
		const file = join(temp, "s.jsonl");
		writeFileSync(file, `${lines.join("\n")}\n`);
		return file;
	};

	test("E-5: a role fallback last record -> the last role-less/default record is healed; a second heal is undefined", () => {
		const file = sessionFile([
			JSON.stringify({ type: "session", version: 1, id: "s1", timestamp: "2026-11-10T00:00:00.000Z", cwd: "/w" }),
			record("e1", "dead/primary"),
			message("e2"),
			record("e3", "dead/fallback", "fallback"),
		]);
		const backups = join(file, "..", "backups");
		expect(healSessionModelFile(file, "live/new", backups)).toEqual({ file, from: "dead/primary", to: "live/new" });
		expect(restoreTarget(file)).toBe("live/new");
		expect(readFileSync(file, "utf8")).toContain('"model":"dead/fallback"');
		expect(healSessionModelFile(file, "live/new", backups)).toBeUndefined();
		expect(readdirSync(backups)).toHaveLength(1);
	});

	test("E-5: a single role-less record is healed as before", () => {
		const file = sessionFile([record("e1", "dead/primary")]);
		expect(healSessionModelFile(file, "live/new", join(file, "..", "backups"))?.from).toBe("dead/primary");
		expect(restoreTarget(file)).toBe("live/new");
	});
});

describe("mailbox: lane todos and turn-end report (doc/plans/lane-todos-nudge.md)", () => {
	const LANE = laneOriginKey("plant-lane");
	const PHASES: TodoPhase[] = [{ name: "마무리", tasks: [{ content: "변경 모두 커밋", status: "pending" }] }];
	let settled: TurnSettledInfo[];
	let opened: FakeOmpDriver[];
	let openDialogs: number;

	function laneMailbox(options: FakeOmpDriverOptions = {}): OriginMailbox {
		return new OriginMailbox({
			timezone: "Asia/Seoul",
			originKey: LANE,
			store,
			clock,
			log: createLogger({ sink: (line) => logLines.push(line), clock, redact }),
			statusProvider: () => "status: ok",
			sessionDirFor: (key, epoch) => sessionDirFor(join(dir, "sessions"), key, epoch),
			driverFactory: (_origin, sessionDir) => {
				const driver = new FakeOmpDriver({ holdTurns: true, sessionDir, store: sessionStore, ...options });
				opened.push(driver);
				return driver;
			},
			initialTodos: () => PHASES,
			onTurnSettled: (info) => settled.push(info),
			dialogs: { open: () => openDialogs, answer: async () => false, ambiguous: () => undefined },
		});
	}

	beforeEach(() => {
		settled = [];
		opened = [];
		openDialogs = 0;
	});

	test("AC-1: a fresh session gets set_todos once, right before its first prompt; the next turn gets none", async () => {
		const mailbox = laneMailbox();
		try {
			const first = msg("첫 턴", { originKey: LANE });
			await mailbox.enqueue(first);
			const driver = opened[0] as FakeOmpDriver;
			expect(driver.calls).toEqual(["openSession", "setTodos", "prompt:첫 턴"]);
			expect(driver.todos).toEqual([PHASES]);
			await untilFinal(mailbox, driver, () => driver.release());
			await mailbox.enqueue(msg("둘째 턴", { originKey: LANE, threadRef: first.threadRef }));
			expect(driver.calls.filter((call) => call === "setTodos")).toHaveLength(1);
		} finally {
			await mailbox.close();
		}
	});

	test("AC-1: a continued session (its session file exists) gets no set_todos", async () => {
		const sessionDir = sessionDirFor(join(dir, "sessions"), LANE, 1);
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(join(sessionDir, "2026-11-13T00-00-00-000Z_0000aaaa.jsonl"), "");
		const mailbox = laneMailbox();
		try {
			await mailbox.enqueue(msg("이어서", { originKey: LANE }));
			expect(opened[0]?.calls).not.toContain("setTodos");
			expect(opened[0]?.calls.some((call) => call.startsWith("prompt:"))).toBe(true);
		} finally {
			await mailbox.close();
		}
	});

	test("AC-4: a refused set_todos is logged and the turn goes on", async () => {
		const mailbox = laneMailbox({ setTodosError: new OmpDriverError("rpc_error", "no set_todos") });
		try {
			await mailbox.enqueue(msg("첫 턴", { originKey: LANE }));
			expect(opened[0]?.calls).toEqual(["openSession", "setTodos", "prompt:첫 턴"]);
			expect(logLines.some((line) => line.includes("lane_set_todos_failed"))).toBe(true);
		} finally {
			await mailbox.close();
		}
	});

	test("AC-2/AC-3: every turn end reports its error (none when completed), final text and open dialogs", async () => {
		const mailbox = laneMailbox({ respond: () => "끝났나요?" });
		try {
			const first = msg("첫 턴", { originKey: LANE });
			await mailbox.enqueue(first);
			const driver = opened[0] as FakeOmpDriver;
			openDialogs = 1;
			await untilFinal(mailbox, driver, () => driver.release());
			expect(settled).toEqual([{ originKey: LANE, text: "끝났나요?", openDialogs: 1 }]);

			openDialogs = 0;
			await mailbox.enqueue(msg("둘째 턴", { originKey: LANE, threadRef: first.threadRef }));
			await untilFinal(mailbox, driver, () => void driver.abort());
			expect(settled[1]).toEqual({ originKey: LANE, text: "", openDialogs: 0, error: "aborted" });

			await mailbox.enqueue(msg("셋째 턴", { originKey: LANE, threadRef: first.threadRef }));
			await mailbox.pauseTurn();
			expect(settled[2]?.error).toBe("lane_paused");
		} finally {
			await mailbox.close();
		}
	});
});
