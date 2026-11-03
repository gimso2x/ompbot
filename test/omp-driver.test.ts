import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OmpDriverError, type OmpEntries, type OmpEvent, type OmpFinal } from "../src/omp/driver";
import { buildChildEnv } from "../src/omp/env";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import {
	leafIdViaCursor,
	missingRpcMethods,
	REQUIRED_RPC_METHODS,
	RpcOmpDriver,
	tapExtensionUi,
} from "../src/omp/rpc-driver";

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function nextFinal(driver: FakeOmpDriver): Promise<OmpFinal> {
	const { promise, resolve } = Promise.withResolvers<OmpFinal>();
	const off = driver.onFinal((final) => {
		off();
		resolve(final);
	});
	return promise;
}

test("buildChildEnv strips SLACK_/OMPBOT_ and adds extras", () => {
	const env = buildChildEnv(
		{ OMP_WIKI_NOTE_DISABLE: "1" },
		{ PATH: "/bin", SLACK_BOT_TOKEN: "x", OMPBOT_HOME: "y", OMPBOT: "keep-not-prefixed", HOME: "/h", GONE: undefined },
	);
	expect(env).toEqual({ PATH: "/bin", OMPBOT: "keep-not-prefixed", HOME: "/h", OMP_WIKI_NOTE_DISABLE: "1" });
	expect(() => buildChildEnv({ SLACK_X: "1" }, {})).toThrow(OmpDriverError);
});

test("RpcOmpDriver fails fast with omp_executable_missing (no spawn, no retry)", async () => {
	const dir = tempDir("ompbot-missing-");
	const driver = new RpcOmpDriver({ ompExecutable: join(dir, "no-such-omp"), cwd: dir, sessionDir: join(dir, "s") });
	const started = performance.now();
	const error = await driver.start().catch((e: unknown) => e);
	expect(error).toBeInstanceOf(OmpDriverError);
	expect(error).toMatchObject({ code: "omp_executable_missing" });
	expect(performance.now() - started).toBeLessThan(1000);
	expect(driver.pid).toBeUndefined();
});

test("RpcOmpDriver fails with bun_missing when bun cannot be found", async () => {
	const dir = tempDir("ompbot-nobun-");
	const driver = new RpcOmpDriver({
		ompExecutable: process.execPath, // exists and is executable; bun lookup fails before any spawn
		cwd: dir,
		sessionDir: join(dir, "s"),
		baseEnv: { PATH: join(dir, "empty") },
	});
	const error = await driver.start().catch((e: unknown) => e);
	expect(error).toBeInstanceOf(OmpDriverError);
	expect(error).toMatchObject({ code: "bun_missing" });
});

/** `<pkg>/dist/cli.js` launcher plus a manifest pinning `engines.bun`, without omp's sources. */
function enginesPackage(bunRange: string): string {
	const root = tempDir("ompbot-pkg-");
	mkdirSync(join(root, "dist"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ engines: { bun: bunRange } }));
	const cli = join(root, "dist", "cli.js");
	writeFileSync(cli, "#!/usr/bin/env bun\n");
	chmodSync(cli, 0o755);
	return cli;
}

test("RpcOmpDriver names a standalone omp binary instead of omp_rpc_client_missing", async () => {
	const dir = tempDir("ompbot-standalone-");
	mkdirSync(join(dir, "bin"));
	const omp = join(dir, "bin", "omp");
	writeFileSync(omp, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]));
	chmodSync(omp, 0o755);
	const driver = new RpcOmpDriver({
		ompExecutable: omp,
		cwd: dir,
		sessionDir: join(dir, "s"),
		bunExecutable: process.execPath,
	});
	const error = await driver.start().catch((e: unknown) => e);
	expect(error).toMatchObject({ code: "omp_launcher_standalone" });
});

test("RpcOmpDriver refuses a bun older than omp's engines.bun, and passes one that satisfies it", async () => {
	const dir = tempDir("ompbot-engines-");
	const options = { cwd: dir, sessionDir: join(dir, "s"), bunExecutable: process.execPath };
	const tooOld = await new RpcOmpDriver({ ...options, ompExecutable: enginesPackage(">=999.0.0") })
		.start()
		.catch((e: unknown) => e);
	expect(tooOld).toMatchObject({ code: "bun_too_old" });
	// A satisfied engine moves on to the RPC client lookup, which this fake package lacks.
	const satisfied = await new RpcOmpDriver({ ...options, ompExecutable: enginesPackage(`>=${Bun.version}`) })
		.start()
		.catch((e: unknown) => e);
	expect(satisfied).toMatchObject({ code: "omp_rpc_client_missing" });
});

test("FakeOmpDriver: entriesSince is strict and returns leafId", async () => {
	const driver = new FakeOmpDriver();
	await driver.start();
	const seeded = await driver.entriesSince();
	expect(seeded.entries.length).toBeGreaterThan(0); // like real omp, a fresh session already has entries
	expect(seeded.leafId).toBe(seeded.entries.at(-1)?.id ?? null);

	const before = await driver.leafId();
	const done = nextFinal(driver);
	await driver.prompt("hello");
	const final = await done;
	expect(final.status).toBe("completed");

	const since = await driver.entriesSince(before ?? undefined);
	expect(since.entries.map((e) => e.message?.role)).toEqual(["user", "assistant"]);
	expect(since.leafId).toBe(since.entries.at(-1)?.id ?? null);

	const leaf = await driver.leafId();
	expect((await driver.entriesSince(leaf ?? undefined)).entries).toEqual([]);
	const rejection = await driver.entriesSince("nope").catch((e: unknown) => e);
	expect(rejection).toBeInstanceOf(OmpDriverError);
	expect(rejection).toMatchObject({ code: "unknown_since" });
});

test("FakeOmpDriver: onFinal never precedes prompt resolution; prompt while busy rejects", async () => {
	const driver = new FakeOmpDriver({ holdTurns: true });
	await driver.start();
	const order: string[] = [];
	driver.onFinal(() => order.push("final"));
	const opRef = await driver.prompt("a");
	order.push(`prompt:${opRef}`);
	await driver.steer("b");
	await expect(driver.prompt("overlap")).rejects.toMatchObject({ code: "rpc_error" });
	const done = nextFinal(driver);
	driver.release();
	const final = await done;
	expect(order).toEqual([`prompt:${opRef}`, "final"]);
	expect(final.text).toContain("b");
});

test("FakeOmpDriver: sessions persist across stop/start through a shared store", async () => {
	const store = new FakeSessionStore();
	const first = new FakeOmpDriver({ store, sessionDir: "d" });
	await first.start();
	const done = nextFinal(first);
	await first.prompt("one");
	await done;
	const leaf = await first.leafId();
	await first.stop();

	const second = new FakeOmpDriver({ store, sessionDir: "d" });
	await second.start();
	expect((await second.openSession()).resumed).toBe(true);
	expect(await second.leafId()).toBe(leaf);
});

/** In-memory get_entries mirroring omp's selectRpcEntries: delta after `since`, unknown cursor rejects. */
function fakeGetEntries(session: OmpEntries["entries"], calls: Array<string | undefined>) {
	return async (since?: string): Promise<OmpEntries> => {
		calls.push(since);
		const index = since === undefined ? -1 : session.findIndex((entry) => entry.id === since);
		if (since !== undefined && index === -1) {
			throw new OmpDriverError("unknown_since", `Unknown entries cursor: ${since}`);
		}
		return { entries: session.slice(index + 1), leafId: session.at(-1)?.id ?? null };
	};
}

test("leafIdViaCursor reads get_entries(since=cursor) and re-seeds the cache on unknown_since", async () => {
	const calls: Array<string | undefined> = [];
	const session: OmpEntries["entries"] = [{ id: "e1", type: "message" }];
	const getEntries = fakeGetEntries(session, calls);
	const cache: { since?: string } = {};

	// First read has no cursor yet: one full read, leafId cached.
	expect(await leafIdViaCursor(getEntries, cache)).toBe("e1");
	expect(calls).toEqual([undefined]);
	expect(cache.since).toBe("e1");

	// Growth between reads: only the delta moves through the pipe.
	session.push({ id: "e2", type: "message" }, { id: "e3", type: "message" });
	expect(await leafIdViaCursor(getEntries, cache)).toBe("e3");
	expect(calls).toEqual([undefined, "e1"]);

	// Cursor gone (session switch / compaction): one full read, cache re-seeded from it.
	session.length = 0;
	session.push({ id: "x1", type: "message" });
	expect(await leafIdViaCursor(getEntries, cache)).toBe("x1");
	expect(calls).toEqual([undefined, "e1", "e3", undefined]);

	// Empty session: leafId null is never fed back as a cursor (omp treats only an absent since as "everything").
	session.length = 0;
	expect(await leafIdViaCursor(getEntries, cache)).toBeNull();
	expect(calls).toEqual([undefined, "e1", "e3", undefined, "x1", undefined]);
	expect(cache.since).toBeUndefined();
});

test("leafIdViaCursor propagates other errors and leaves the cache untouched", async () => {
	const calls: Array<string | undefined> = [];
	const cache: { since?: string } = { since: "e1" };
	const getEntries = async (since?: string): Promise<OmpEntries> => {
		calls.push(since);
		throw new OmpDriverError("rpc_error", "child died");
	};
	const error = await leafIdViaCursor(getEntries, cache).catch((e: unknown) => e);
	expect(error).toBeInstanceOf(OmpDriverError);
	expect(error).toMatchObject({ code: "rpc_error" });
	expect(calls).toEqual(["e1"]);
	expect(cache.since).toBe("e1");
});

/** Feed a fully-buffered stdout stand-in to `tapExtensionUi`; both callbacks collect synchronously. */
function lineStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

async function tapped(stream: ReadableStream<Uint8Array>): Promise<{
	events: OmpEvent[];
	replies: Array<Record<string, unknown>>;
}> {
	const events: OmpEvent[] = [];
	const replies: Array<Record<string, unknown>> = [];
	await tapExtensionUi(
		stream,
		(event) => events.push(event),
		(frame) => replies.push(frame),
	);
	return { events, replies };
}

async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (!condition()) {
		if (performance.now() > deadline) throw new Error("condition not met before timeout");
		await Bun.sleep(1);
	}
}

test("tapExtensionUi emits events from chunk-split lines and instantly cancels unanswerable dialogs", async () => {
	const encoder = new TextEncoder();
	const dialogs = ["select", "confirm", "input", "editor", "ask"];
	const payload = [
		...dialogs.map((method, index) => JSON.stringify({ type: "extension_ui_request", method, id: `u${index + 1}` })),
		JSON.stringify({ type: "extension_ui_request", method: "status_widget", id: "u9" }), // answerable: no cancel
		JSON.stringify({ type: "message.update", seq: 3 }), // not a UI request: no event
		"",
	].join("\n");
	const bytes = encoder.encode(payload);
	// Irregular slices so JSON tokens are cut mid-way across chunk boundaries.
	const { events, replies } = await tapped(
		lineStream([bytes.slice(0, 5), bytes.slice(5, 6), bytes.slice(6, 31), bytes.slice(31)]),
	);
	expect(events).toEqual([
		...dialogs.map((method, index) => ({ type: "extension_ui_request", method, id: `u${index + 1}` })),
		{ type: "extension_ui_request", method: "status_widget", id: "u9" },
	]);
	expect(replies).toEqual(
		dialogs.map((_method, index) => ({ type: "extension_ui_response", id: `u${index + 1}`, cancelled: true })),
	);
});

test("tapExtensionUi ignores noise, malformed JSON lines, and frames without the request type", async () => {
	const encoder = new TextEncoder();
	const payload = [
		"plain child log line",
		JSON.stringify({ type: "other", note: 'mentions "extension_ui_request" but is not one' }),
		'{"type":"extension_ui_request","method":"select","id":"truncated', // complete line, incomplete JSON
		JSON.stringify({ type: "extension_ui_request" }), // no method/id: emitted once, never answered
		'{"type":"extension_ui_request","method":"confirm","id":"tail"', // no trailing newline: never parsed
	].join("\n");
	const { events, replies } = await tapped(lineStream([encoder.encode(payload)]));
	expect(events).toEqual([{ type: "extension_ui_request", method: undefined, id: undefined }]);
	expect(replies).toEqual([]);
});

test("tapExtensionUi reassembles UTF-8 sequences split across chunks", async () => {
	const encoder = new TextEncoder();
	const line = `${JSON.stringify({ type: "extension_ui_request", method: "ask", id: "물음표" })}\n`;
	const bytes = encoder.encode(line);
	// Split one byte into the 3-byte "물" sequence: the streaming decoder must hold the partial character.
	const split = encoder.encode('{"type":"extension_ui_request","method":"ask","id":"').length + 1;
	const { events, replies } = await tapped(lineStream([bytes.slice(0, split), bytes.slice(split)]));
	expect(events).toEqual([{ type: "extension_ui_request", method: "ask", id: "물음표" }]);
	expect(replies).toEqual([{ type: "extension_ui_response", id: "물음표", cancelled: true }]);
});

test("tapExtensionUi swallows stream errors after processing earlier chunks", async () => {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	const events: OmpEvent[] = [];
	const replies: Array<Record<string, unknown>> = [];
	const tap = tapExtensionUi(
		stream,
		(event) => events.push(event),
		(frame) => replies.push(frame),
	);
	controller.enqueue(new TextEncoder().encode('{"type":"extension_ui_request","method":"select","id":"u1"}\n'));
	await Bun.sleep(5); // let the chunk drain before the child's stdout dies
	controller.error(new Error("child died"));
	await expect(tap).resolves.toBeUndefined();
	expect(events).toEqual([{ type: "extension_ui_request", method: "select", id: "u1" }]);
	expect(replies).toEqual([{ type: "extension_ui_response", id: "u1", cancelled: true }]);
});

/**
 * Source of the RpcClient stand-in written into a fake omp package tree: `RpcOmpDriver.start()` imports
 * `<packageRoot>/src/modes/rpc/rpc-client.ts` resolved from the realpath of `ompExecutable`, so the fixture must
 * provide the full method surface `missingRpcMethods()` checks. Tests reach the live instance through the static
 * `instances` list and drive prompt resolution by hand to reproduce the wire races.
 */
const FAKE_RPC_CLIENT_SOURCE = `
// Unit-test stand-in for omp's RpcClient. The full method surface is required because missingRpcMethods()
// checks the prototype before the driver accepts the module.
type Listener = (payload: unknown) => void;

export class RpcClient {
	static instances: RpcClient[] = [];
	options: unknown;
	eventListener: Listener | undefined;
	sessionListener: Listener | undefined;
	promptResultListener: Listener | undefined;
	promptCounter = 0;
	promptDeferred = new Map<string, { resolve: (value: string) => void; reject: (error: unknown) => void }>();
	autoResolvePrompts = true;
	lastAssistantText = "fake assistant text";

	constructor(options: unknown) {
		RpcClient.instances.push(this);
		this.options = options;
	}

	async start(): Promise<void> {}
	async stop(): Promise<void> {}

	onEvent(listener: Listener): () => void {
		this.eventListener = listener;
		return () => {
			this.eventListener = undefined;
		};
	}

	// Like omp's RpcClient, the session listener receives every frame (agent events included), not only session-only ones.
	onSessionEvent(listener: Listener): () => void {
		this.sessionListener = listener;
		return () => {
			this.sessionListener = undefined;
		};
	}

	emitSessionEvent(event: unknown): void {
		this.sessionListener?.(event);
	}

	onPromptResult(listener: Listener): () => void {
		this.promptResultListener = listener;
		return () => {
			this.promptResultListener = undefined;
		};
	}

	prompt(_message: string): Promise<string> {
		this.promptCounter += 1;
		const opRef = "op-" + String(this.promptCounter);
		return new Promise<string>((resolve, reject) => {
			this.promptDeferred.set(opRef, { resolve, reject });
			if (this.autoResolvePrompts) resolve(opRef);
		});
	}

	emitPromptResult(frame: unknown): void {
		this.promptResultListener?.(frame);
	}

	resolvePrompt(opRef: string): void {
		this.promptDeferred.get(opRef)?.resolve(opRef);
	}

	async steer(_message: string): Promise<void> {}
	async abort(): Promise<void> {}
	async newSession(): Promise<{ cancelled: boolean }> {
		return { cancelled: false };
	}
	async openSession(_sessionDir: string): Promise<{ cancelled: boolean; resumed: boolean; sessionId: string }> {
		return { cancelled: false, resumed: false, sessionId: "fake-session" };
	}
	async getState(): Promise<Record<string, unknown>> {
		return {
			sessionId: "fake-session",
			isStreaming: false,
			isCompacting: false,
			isSettled: true,
			queuedMessageCount: 0,
			messageCount: 0,
		};
	}
	async getEntries(_since?: string): Promise<Record<string, unknown>> {
		return { entries: [], leafId: null };
	}
	async getLastAssistantText(): Promise<string | null> {
		return this.lastAssistantText;
	}
	async switchSession(_sessionPath: string): Promise<{ cancelled: boolean }> {
		return { cancelled: false };
	}
	async getAvailableModels(): Promise<Array<{ provider: string; id: string }>> {
		return [];
	}
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		return { provider, id: modelId };
	}
	async getAvailableThinkingLevels(): Promise<string[]> {
		return [];
	}
	async setThinkingLevel(_level: string): Promise<void> {}
	async compact(_customInstructions?: string): Promise<{ summary: string; tokensBefore: number }> {
		return { summary: "", tokensBefore: 0 };
	}
}
`;

interface FakeRpcClient {
	autoResolvePrompts: boolean;
	emitSessionEvent(event: unknown): void;
	emitPromptResult(frame: unknown): void;
	resolvePrompt(opRef: string): void;
}

interface FakeRpcClientModule {
	RpcClient: { instances: FakeRpcClient[] };
}

/**
 * Minimal omp install layout that satisfies `RpcOmpDriver.start()` without spawning anything: an executable at
 * `<root>/bin/omp` (only realpath'ed and stat'ed), the fixture rpc-client module, and a stub `@oh-my-pi/pi-utils`
 * for `Bun.resolveSync`. Paths are derived from the realpath so the test imports the exact module the driver does.
 */
function fakeOmpPackage(dir: string): { ompExecutable: string; clientModule: string } {
	const bin = join(dir, "fake-omp-pkg", "bin");
	mkdirSync(bin, { recursive: true });
	const ompExecutable = join(bin, "omp");
	writeFileSync(ompExecutable, "#!/bin/sh\nexit 1\n"); // never executed; only realpath'ed and stat'ed
	chmodSync(ompExecutable, 0o755);
	const root = dirname(dirname(realpathSync(ompExecutable)));
	const clientModule = join(root, "src/modes/rpc/rpc-client.ts");
	mkdirSync(dirname(clientModule), { recursive: true });
	writeFileSync(clientModule, FAKE_RPC_CLIENT_SOURCE);
	const utilsDir = join(root, "node_modules/@oh-my-pi/pi-utils");
	mkdirSync(utilsDir, { recursive: true });
	writeFileSync(
		join(utilsDir, "package.json"),
		JSON.stringify({ name: "@oh-my-pi/pi-utils", version: "0.0.0-fake", type: "module", main: "index.js" }),
	);
	writeFileSync(
		join(utilsDir, "index.js"),
		"export const ptree = { spawn() { throw new Error('ptree.spawn is not expected in unit tests'); } };\n",
	);
	return { ompExecutable, clientModule };
}

test("RpcOmpDriver buffers a final that arrives before prompt() resolves, then delivers it on admission", async () => {
	const dir = tempDir("ompbot-fakeomp-");
	const tree = fakeOmpPackage(dir);
	const driver = new RpcOmpDriver({
		ompExecutable: tree.ompExecutable,
		cwd: dir,
		sessionDir: join(dir, "s"),
		bunExecutable: process.execPath, // tests already run under bun
	});
	await driver.start();
	try {
		const fixture = (await import(tree.clientModule)) as FakeRpcClientModule;
		const client = fixture.RpcClient.instances.at(-1);
		if (!client) throw new Error("fake RpcClient was not constructed");
		client.autoResolvePrompts = false;
		const finals: OmpFinal[] = [];
		driver.onFinal((final) => finals.push(final));
		let promptSettled = false;
		const promptPromise = driver.prompt("hello");
		void promptPromise.then(
			() => (promptSettled = true),
			() => (promptSettled = true),
		);

		// The wire result lands before client.prompt() resolves: it must be buffered, not delivered.
		client.emitPromptResult({ id: "op-1", status: "completed" });
		await Bun.sleep(10);
		expect(promptSettled).toBe(false);
		expect(finals).toEqual([]);

		client.resolvePrompt("op-1");
		expect(await promptPromise).toBe("op-1");
		await until(() => finals.length > 0);
		expect(finals[0]).toEqual({ opRef: "op-1", status: "completed", text: "fake assistant text" });

		// Same race with an error result: buffered, then delivered with the mapped error message.
		const promptPromise2 = driver.prompt("second");
		client.emitPromptResult({ id: "op-2", status: "error", error: { message: "boom" } });
		client.resolvePrompt("op-2");
		expect(await promptPromise2).toBe("op-2");
		await until(() => finals.length > 1);
		expect(finals[1]).toEqual({ opRef: "op-2", status: "error", text: "", error: "boom" });
	} finally {
		await driver.stop();
	}
});

test("RpcOmpDriver session event: forwards retry/fallback session events once and drops agent events the agent listener already delivers", async () => {
	const dir = tempDir("ompbot-fakeomp-");
	const tree = fakeOmpPackage(dir);
	const driver = new RpcOmpDriver({
		ompExecutable: tree.ompExecutable,
		cwd: dir,
		sessionDir: join(dir, "s"),
		bunExecutable: process.execPath,
	});
	const received: OmpEvent[] = [];
	driver.onEvent((event) => received.push(event));
	await driver.start();
	try {
		const fixture = (await import(tree.clientModule)) as FakeRpcClientModule;
		const client = fixture.RpcClient.instances.at(-1);
		if (!client) throw new Error("fake RpcClient was not constructed");

		const retry = {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 10,
			delayMs: 500,
			errorMessage: "429 rate_limit_error",
		};
		client.emitSessionEvent(retry);
		expect(received).toEqual([retry]);

		// omp's session listener also sees agent events; forwarding them would double every tool_execution_start.
		client.emitSessionEvent({ type: "tool_execution_start", toolName: "bash" });
		client.emitSessionEvent({ type: "message_update" });
		expect(received).toEqual([retry]);

		const end = { type: "auto_retry_end", success: false, attempt: 3 }; // malformed on purpose: no finalError
		const fallback = { type: "retry_fallback_applied", from: "zai/a", to: "zai/b", role: "default", reason: "429" };
		client.emitSessionEvent(end);
		client.emitSessionEvent(fallback);
		expect(received).toEqual([retry, end, fallback]);
	} finally {
		await driver.stop();
	}
});

test("missingRpcMethods names onSessionEvent when the RpcClient class lacks it", () => {
	class Old {}
	for (const name of REQUIRED_RPC_METHODS) {
		if (name !== "onSessionEvent") Object.defineProperty(Old.prototype, name, { value: () => undefined });
	}
	expect(missingRpcMethods(Old)).toEqual(["onSessionEvent"]);
});
