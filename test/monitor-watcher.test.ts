import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundRecord } from "../src/core/types";
import { createLogger } from "../src/log";
import { MonitorScheduler } from "../src/monitors/scheduler";
import { MonitorSpecError, mergeMonitorSpec, parseMonitorSpec } from "../src/monitors/spec";
import { fsWatchStarter, MAX_WATCH_PATHS, type WatchStarter } from "../src/monitors/watcher";
import { redact } from "../src/redact";
import { openStore, type Store } from "../src/store/db";

const T0 = Date.UTC(2026, 5, 1, 0, 0, 0);

class FakeClock {
	t = T0;
	now(): number {
		return this.t;
	}
	advance(ms: number): void {
		this.t += ms;
	}
}

let dir: string;
let allowed: string;
let clock: FakeClock;
let store: Store;
let routed: InboundRecord[];
let logLines: string[];
let scheduler: MonitorScheduler;
/** Wraps the real recursive fs.watch so a test can await the callback instead of sleeping. */
let seen: Array<{ rel: string | null }>;
let waiters: Array<() => void>;
let closed: number;
let watchFails: Error | undefined;

const trigger = (root: string, extra: Record<string, unknown> = {}) => ({ kind: "watcher", root, ...extra });
const ctx = () => ({ scriptsRoot: join(dir, "scripts"), watcherRoots: [allowed] });

/** Resolves once `seen` satisfies `done` (bounded wait; no polling interval). */
function waitSeen(done: (rels: Array<string | null>) => boolean): Promise<void> {
	return new Promise((resolve, reject) => {
		const check = () => {
			if (done(seen.map((s) => s.rel))) {
				clearTimeout(timer);
				resolve();
				return true;
			}
			return false;
		};
		const timer = setTimeout(() => reject(new Error(`watch event never arrived: ${JSON.stringify(seen)}`)), 5000);
		if (!check()) waiters.push(() => check());
	});
}

const starter: WatchStarter = (root, onChange, onError) => {
	if (watchFails) throw watchFails;
	const handle = fsWatchStarter(
		root,
		(rel) => {
			seen.push({ rel });
			onChange(rel);
			for (const w of [...waiters]) w();
		},
		onError,
	);
	return {
		close() {
			closed += 1;
			handle.close();
		},
	};
};

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "ompbot-watcher-")));
	mkdirSync(join(dir, "scripts"));
	allowed = join(dir, "allowed");
	mkdirSync(join(allowed, "proj", ".git"), { recursive: true });
	clock = new FakeClock();
	logLines = [];
	routed = [];
	seen = [];
	waiters = [];
	closed = 0;
	watchFails = undefined;
	const log = createLogger({ sink: (line) => logLines.push(line), clock, redact });
	store = openStore({ path: join(dir, "ompbot.db"), clock, redact, ownerSlackUserId: "UOWNER" });
	scheduler = new MonitorScheduler({
		store,
		router: {
			async route(record) {
				routed.push(record);
			},
			async newEpochIfIdle() {
				return false;
			},
		},
		clock,
		log,
		scriptsRoot: join(dir, "scripts"),
		workspaceDir: dir,
		watcherRoots: [allowed],
		watch: starter,
	});
});

afterEach(async () => {
	scheduler.stop();
	await scheduler.idle();
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

const add = (root: string, extra: Record<string, unknown> = {}, name = "w") =>
	store.monitors.addMonitor(
		parseMonitorSpec({ name, trigger: trigger(root, extra), instruction: "look", ...{} }, ctx()),
	);

describe("watcher trigger spec", () => {
	test("accepts a directory inside watcherRoots and defaults debounceMs to 1000", () => {
		const spec = parseMonitorSpec({ name: "w", trigger: trigger(join(allowed, "proj")), instruction: "x" }, ctx());
		expect(spec.trigger).toEqual({ kind: "watcher", root: join(allowed, "proj"), debounceMs: 1000 });
	});

	test("rejects a root outside watcherRoots, a relative path, a file and a missing directory", () => {
		const outside = join(dir, "outside");
		mkdirSync(outside);
		writeFileSync(join(allowed, "file.txt"), "x");
		for (const [root, message] of [
			[outside, /under one of watcherRoots/],
			["proj", /absolute/],
			[join(allowed, "file.txt"), /existing directory/],
			[join(allowed, "nope"), /existing directory/],
		] as const) {
			expect(() => parseMonitorSpec({ name: "w", trigger: trigger(root), instruction: "x" }, ctx())).toThrow(message);
		}
	});

	test("rejects a symlink that escapes watcherRoots", () => {
		const outside = join(dir, "outside");
		mkdirSync(outside);
		symlinkSync(outside, join(allowed, "link"));
		expect(() =>
			parseMonitorSpec({ name: "w", trigger: trigger(join(allowed, "link")), instruction: "x" }, ctx()),
		).toThrow(MonitorSpecError);
	});

	test("rejects every root when no watcherRoots are configured, naming the key", () => {
		for (const watcherRoots of [undefined, []]) {
			expect(() =>
				parseMonitorSpec(
					{ name: "w", trigger: trigger(join(allowed, "proj")), instruction: "x" },
					{ scriptsRoot: join(dir, "scripts"), watcherRoots },
				),
			).toThrow(/watcherRoots/);
		}
	});

	test("debounceMs is an integer 100..60000", () => {
		const root = join(allowed, "proj");
		for (const ok of [100, 60_000]) {
			expect(
				parseMonitorSpec({ name: "w", trigger: trigger(root, { debounceMs: ok }), instruction: "x" }, ctx()),
			).toBeTruthy();
		}
		for (const bad of [99, 60_001, 1.5, "1000"]) {
			expect(() =>
				parseMonitorSpec({ name: "w", trigger: trigger(root, { debounceMs: bad }), instruction: "x" }, ctx()),
			).toThrow(/debounceMs/);
		}
	});

	test("unknown trigger fields and verbatim delivery are rejected; update inherits root and debounce", () => {
		const root = join(allowed, "proj");
		expect(() =>
			parseMonitorSpec({ name: "w", trigger: trigger(root, { intervalMs: 1 }), instruction: "x" }, ctx()),
		).toThrow(/unknown field/);
		expect(() =>
			parseMonitorSpec({ name: "w", trigger: trigger(root), instruction: "x", deliver: "verbatim" }, ctx()),
		).toThrow(/script trigger/);
		const current = parseMonitorSpec(
			{ name: "w", trigger: trigger(root, { debounceMs: 300 }), instruction: "x" },
			ctx(),
		);
		const next = mergeMonitorSpec(current, { trigger: { debounceMs: 500 } }, ctx());
		expect(next.trigger).toEqual({ kind: "watcher", root, debounceMs: 500 });
	});
});

describe("watcher runtime", () => {
	test("a new file fires one event after the debounce, with its relative path as payload", async () => {
		const root = join(allowed, "proj");
		const monitor = add(root, { debounceMs: 200 });
		await scheduler.tick(); // starts the watch
		writeFileSync(join(root, "a.txt"), "hello");
		await waitSeen((rels) => rels.includes("a.txt"));

		clock.advance(199);
		expect((await scheduler.tick()).claimed).toBe(0);
		clock.advance(1);
		const summary = await scheduler.tick();
		expect(summary).toMatchObject({ claimed: 1, dispatched: 1 });
		await scheduler.idle();
		const [event] = store.monitors.listEvents({ monitorId: monitor.id });
		expect(event?.payload).toContain("a.txt");
		expect(routed).toHaveLength(1);
		expect(routed[0]?.text).toContain("a.txt");
		expect(routed[0]?.originKey).toBe(`monitor/${monitor.id}`);
		// Settled changes fire once.
		clock.advance(10_000);
		expect((await scheduler.tick()).claimed).toBe(0);
	});

	test("changes in quick succession restart the debounce and produce one event listing both paths", async () => {
		const root = join(allowed, "proj");
		const monitor = add(root, { debounceMs: 1000 });
		await scheduler.tick();
		writeFileSync(join(root, "one.txt"), "1");
		await waitSeen((rels) => rels.includes("one.txt"));
		clock.advance(900);
		writeFileSync(join(root, "two.txt"), "2");
		await waitSeen((rels) => rels.includes("two.txt"));
		clock.advance(900); // 900 after the last change, 1800 after the first
		expect((await scheduler.tick()).claimed).toBe(0);
		clock.advance(100);
		expect((await scheduler.tick()).claimed).toBe(1);
		const events = store.monitors.listEvents({ monitorId: monitor.id });
		expect(events).toHaveLength(1);
		expect(events[0]?.payload).toContain("one.txt");
		expect(events[0]?.payload).toContain("two.txt");
	});

	test("changes inside .git are ignored", async () => {
		const root = join(allowed, "proj");
		add(root, { debounceMs: 100 });
		await scheduler.tick();
		writeFileSync(join(root, ".git", "HEAD"), "ref");
		await waitSeen((rels) => rels.some((rel) => rel?.startsWith(".git")));
		// A later real change proves the watch is alive while the .git one was dropped.
		writeFileSync(join(root, "real.txt"), "x");
		await waitSeen((rels) => rels.includes("real.txt"));
		clock.advance(100);
		await scheduler.tick();
		const [event] = store.monitors.listEvents();
		expect(event?.payload).toContain("real.txt");
		expect(event?.payload).not.toContain(".git");
	});

	test("a .git-only change never fires", async () => {
		const root = join(allowed, "proj");
		add(root, { debounceMs: 100 });
		await scheduler.tick();
		writeFileSync(join(root, ".git", "index"), "x");
		await waitSeen((rels) => rels.some((rel) => rel?.startsWith(".git")));
		clock.advance(60_000);
		expect((await scheduler.tick()).claimed).toBe(0);
	});

	test("the payload is bounded: at most MAX_WATCH_PATHS paths plus a count of the rest", async () => {
		const root = join(allowed, "proj");
		const monitor = add(root, { debounceMs: 100 });
		await scheduler.tick();
		for (let i = 0; i < MAX_WATCH_PATHS + 7; i++) writeFileSync(join(root, `f${i}.txt`), "x");
		await waitSeen((rels) => new Set(rels).size >= MAX_WATCH_PATHS + 7);
		clock.advance(100);
		await scheduler.tick();
		const lines = (store.monitors.listEvents({ monitorId: monitor.id })[0]?.payload ?? "").split("\n");
		expect(lines).toHaveLength(MAX_WATCH_PATHS + 1);
		expect(lines.at(-1)).toBe("… and 7 more");
	});

	test("a removed, disabled or retargeted monitor stops its watch on the next tick", async () => {
		const root = join(allowed, "proj");
		const monitor = add(root);
		await scheduler.tick();
		expect(closed).toBe(0);
		store.monitors.removeMonitor(monitor.id);
		await scheduler.tick();
		expect(closed).toBe(1);

		const again = add(root, {}, "w2");
		await scheduler.tick();
		store.monitors.updateMonitor(again.id, {
			...parseMonitorSpec({ name: "w2", trigger: trigger(root), instruction: "look" }, ctx()),
			enabled: false,
		});
		await scheduler.tick();
		expect(closed).toBe(2);
	});

	test("a watch that cannot start logs monitor_watch_error once and retries on a later tick", async () => {
		const root = join(allowed, "proj");
		const monitor = add(root, { debounceMs: 100 });
		watchFails = new Error("EMFILE: too many open files");
		await scheduler.tick();
		await scheduler.tick();
		expect(logLines.filter((line) => line.includes("monitor_watch_error"))).toHaveLength(1);
		watchFails = undefined;
		await scheduler.tick();
		writeFileSync(join(root, "late.txt"), "x");
		await waitSeen((rels) => rels.includes("late.txt"));
		clock.advance(100);
		expect((await scheduler.tick()).claimed).toBe(1);
		expect(store.monitors.listEvents({ monitorId: monitor.id })).toHaveLength(1);
	});

	test("a monitor whose root left watcherRoots never starts a watch", async () => {
		const root = join(allowed, "proj");
		add(root);
		const strict = new MonitorScheduler({
			store,
			router: { route: async () => {}, newEpochIfIdle: async () => false },
			clock,
			log: createLogger({ sink: (line) => logLines.push(line), clock, redact }),
			scriptsRoot: join(dir, "scripts"),
			workspaceDir: dir,
			watcherRoots: [],
			watch: starter,
		});
		await strict.tick();
		expect(closed).toBe(0);
		expect(logLines.some((line) => line.includes("monitor_watch_error") && line.includes("watcherRoots"))).toBe(true);
		strict.stop();
	});

	test("a second burst after the first settled fires a second event", async () => {
		const root = join(allowed, "proj");
		const monitor = add(root, { debounceMs: 100 });
		await scheduler.tick();
		writeFileSync(join(root, "a.txt"), "x");
		await waitSeen((rels) => rels.includes("a.txt"));
		clock.advance(100);
		await scheduler.tick();
		expect(store.monitors.listEvents({ monitorId: monitor.id })).toHaveLength(1);
		await scheduler.idle();
		const before = seen.length;
		unlinkSync(join(root, "a.txt"));
		await waitSeen((rels) => rels.length > before);
		clock.advance(100);
		await scheduler.tick();
		expect(store.monitors.listEvents({ monitorId: monitor.id })).toHaveLength(2);
	});
});
