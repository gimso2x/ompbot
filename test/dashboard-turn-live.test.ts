import { afterEach, describe, expect, test } from "bun:test";
import type { LiveView } from "../src/core/live-turn";
import { renderLiveTurn } from "../src/dashboard/html";
import { renderMarkdown } from "../src/dashboard/markdown";
import { type DashboardServerOptions, startDashboardServer } from "../src/dashboard/server";

const WAIT_MS = 5_000;
const ORIGIN = "slack/ch/CS/t/9.0";

const view = (seq: number, text = `글 ${seq}`): LiveView => ({
	seq,
	updatedAt: 1_000 + seq,
	inboundId: "m1",
	text,
	thinking: "",
	toolCalls: [],
	running: [],
});

/** Bounded wait for a promise; a test never hangs on a missed signal. */
function bounded<T>(promise: Promise<T>, what: string): Promise<T> {
	const { promise: expired, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), WAIT_MS);
	return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/** `liveSchedule` the test runs by hand: jobs pile up until `runNext`. */
class ManualScheduler {
	readonly jobs: Array<() => void> = [];
	#waiters: Array<() => void> = [];

	readonly schedule = (fn: () => void): (() => void) => {
		this.jobs.push(fn);
		for (const wake of this.#waiters.splice(0)) wake();
		return () => {
			const at = this.jobs.indexOf(fn);
			if (at >= 0) this.jobs.splice(at, 1);
		};
	};

	/** Resolves once a job is waiting (at once if one already is). */
	scheduled(): Promise<void> {
		if (this.jobs.length > 0) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#waiters.push(resolve);
		return bounded(promise, "a scheduled live read");
	}

	runNext(): void {
		const job = this.jobs.shift();
		if (job === undefined) throw new Error("no live read is scheduled");
		job();
	}
}

/** Subscriber counts the server reports per change, with a bounded wait for a given count. */
class Subscribers {
	count = 0;
	#waiters: Array<{ n: number; resolve: () => void }> = [];

	readonly hear = (_origin: string, count: number): void => {
		this.count = count;
		this.#waiters = this.#waiters.filter((waiter) => {
			if (waiter.n !== count) return true;
			waiter.resolve();
			return false;
		});
	};

	reach(n: number): Promise<void> {
		if (this.count === n) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#waiters.push({ n, resolve });
		return bounded(promise, `${n} live subscribers`);
	}
}

/** One open `api/thread/live/events` stream. */
class LiveStream {
	#buffer = "";
	readonly #decoder = new TextDecoder();

	private constructor(
		private readonly reader: { read(): Promise<{ value?: Uint8Array; done: boolean }>; cancel(): Promise<void> },
	) {}

	static async open(base: string, origin = ORIGIN): Promise<LiveStream> {
		const response = await fetch(`${base}/api/thread/live/events?origin=${encodeURIComponent(origin)}`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toStartWith("text/event-stream");
		if (response.body === null) throw new Error("no event stream body");
		return new LiveStream(response.body.getReader());
	}

	/** The next `live` event's data, parsed; keep-alive comments are skipped. */
	async next(): Promise<{ live: LiveView | null; error?: string }> {
		const read = async () => {
			for (;;) {
				const end = this.#buffer.indexOf("\n\n");
				if (end >= 0) {
					const frame = this.#buffer.slice(0, end);
					this.#buffer = this.#buffer.slice(end + 2);
					const data = /^data: (.*)$/m.exec(frame)?.[1];
					if (/^event: live$/m.test(frame) && data !== undefined) return JSON.parse(data);
					continue;
				}
				const { value, done } = await this.reader.read();
				if (done) throw new Error("live event stream ended");
				this.#buffer += this.#decoder.decode(value, { stream: true });
			}
		};
		return bounded(read(), "a live event");
	}

	close(): Promise<void> {
		return this.reader.cancel();
	}
}

const stops: Array<() => void> = [];
afterEach(() => {
	for (const stop of stops.splice(0)) stop();
});

function serve(extra: Partial<DashboardServerOptions>): string {
	const server = startDashboardServer({
		port: 0,
		hostname: "127.0.0.1",
		snapshot: async () => {
			throw new Error("the page is not under test here");
		},
		...extra,
	});
	stops.push(() => server.stop(true));
	return `http://127.0.0.1:${server.port}`;
}

/** A dashboard whose `live` answers come from `answers` in order (a function answer runs per call). */
function setup(answers: Array<LiveView | null | (() => Promise<LiveView | null>)>) {
	const scheduler = new ManualScheduler();
	const subscribers = new Subscribers();
	const calls: string[] = [];
	const base = serve({
		live: async (origin) => {
			calls.push(origin);
			const next = answers.shift();
			if (next === undefined) throw new Error("no answer left");
			return typeof next === "function" ? next() : next;
		},
		liveSchedule: scheduler.schedule,
		onLiveSubscribers: subscribers.hear,
	});
	return { base, scheduler, subscribers, calls };
}

/** Lets every pending promise continuation of the server run (one macrotask hop; no timing involved). */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("live event stream", () => {
	test("AC-6: two subscribers share one read per tick and hear only seq changes", async () => {
		const { base, scheduler, subscribers, calls } = setup([view(1), view(1), view(2), null]);
		const clients = [await LiveStream.open(base), await LiveStream.open(base)];
		await subscribers.reach(2);
		expect(scheduler.jobs).toHaveLength(1);

		scheduler.runNext();
		for (const client of clients) expect((await client.next()).live?.seq).toBe(1);
		expect(calls).toEqual([ORIGIN]);

		await scheduler.scheduled();
		scheduler.runNext(); // seq 1 again: nobody hears it
		await scheduler.scheduled();
		expect(calls).toHaveLength(2);
		scheduler.runNext();
		for (const client of clients) expect((await client.next()).live?.seq).toBe(2);
		await scheduler.scheduled();
		scheduler.runNext();
		for (const client of clients) expect((await client.next()).live).toBeNull();
		expect(calls).toHaveLength(4);
		await Promise.all(clients.map((client) => client.close()));
	});

	test("AC-6: no read is scheduled while one runs; one is once it ends", async () => {
		const held = Promise.withResolvers<LiveView | null>();
		const { base, scheduler, subscribers } = setup([() => held.promise]);
		const client = await LiveStream.open(base);
		await subscribers.reach(1);
		scheduler.runNext();
		await settle();
		expect(scheduler.jobs).toHaveLength(0);
		held.resolve(view(7));
		expect((await client.next()).live?.seq).toBe(7);
		expect(scheduler.jobs).toHaveLength(1);
		await client.close();
	});

	test("AC-6: once every subscriber is gone nothing is scheduled, even after the running read ends", async () => {
		const held = Promise.withResolvers<LiveView | null>();
		const { base, scheduler, subscribers } = setup([view(1), () => held.promise]);
		const clients = [await LiveStream.open(base), await LiveStream.open(base)];
		await subscribers.reach(2);
		scheduler.runNext();
		for (const client of clients) expect((await client.next()).live?.seq).toBe(1);
		await scheduler.scheduled();
		scheduler.runNext(); // this read stays open past the last subscriber
		await Promise.all(clients.map((client) => client.close()));
		await subscribers.reach(0);
		expect(scheduler.jobs).toHaveLength(0);
		held.resolve(view(2));
		await settle();
		expect(scheduler.jobs).toHaveLength(0);

		// A pending (not running) read is cancelled when the last subscriber goes.
		const again = await LiveStream.open(base);
		await subscribers.reach(1);
		expect(scheduler.jobs).toHaveLength(1);
		await again.close();
		await subscribers.reach(0);
		expect(scheduler.jobs).toHaveLength(0);
	});

	test("AC-7: a failing read is told once as daemon_unreachable, and the next answer comes through", async () => {
		const fail = async (): Promise<LiveView | null> => {
			throw new Error("ENOENT ompbot.sock");
		};
		const { base, scheduler, subscribers } = setup([fail, fail, view(3)]);
		const client = await LiveStream.open(base);
		await subscribers.reach(1);
		scheduler.runNext();
		expect(await client.next()).toEqual({ live: null, error: "daemon_unreachable" });
		await scheduler.scheduled();
		scheduler.runNext();
		await scheduler.scheduled();
		scheduler.runNext();
		expect((await client.next()).live?.seq).toBe(3);
		await client.close();
	});
});

describe("live routes", () => {
	test("AC-7: one-shot read, daemon failure 503, bad origin 400, no live option 404", async () => {
		let fail = false;
		const base = serve({
			live: async (origin) => {
				if (fail) throw new Error("ipc timeout after 800ms");
				return origin === ORIGIN ? view(4) : null;
			},
		});
		const once = await fetch(`${base}/api/thread/live?origin=${encodeURIComponent(ORIGIN)}`);
		expect(once.status).toBe(200);
		expect(await once.json()).toMatchObject({ live: { seq: 4 } });
		expect(await (await fetch(`${base}/api/thread/live?origin=other`)).json()).toEqual({ live: null });
		fail = true;
		const down = await fetch(`${base}/api/thread/live?origin=${encodeURIComponent(ORIGIN)}`);
		expect(down.status).toBe(503);
		expect(await down.json()).toEqual({ error: "daemon_unreachable" });

		for (const path of ["api/thread/live", "api/thread/live/events"]) {
			for (const query of ["", "?origin=", "?origin=%20%20"]) {
				const bad = await fetch(`${base}/${path}${query}`);
				expect(bad.status).toBe(400);
				expect(await bad.json()).toEqual({ error: "invalid_origin" });
			}
		}

		const bare = serve({});
		for (const path of ["api/thread/live", "api/thread/live/events"]) {
			const disabled = await fetch(`${bare}/${path}?origin=${encodeURIComponent(ORIGIN)}`);
			expect(disabled.status).toBe(404);
			expect(await disabled.json()).toEqual({ error: "live_disabled" });
		}
	});
});

describe("live block renderer", () => {
	test("AC-8: script and image markdown in the streamed text render as text, never as elements", () => {
		const html = renderLiveTurn(
			{
				...view(1, "<script>alert(1)</script>\n\n![x](https://evil/x.png)"),
				thinking: "<img src=x onerror=alert(1)>",
				toolCalls: [{ name: "<script>", summary: "<img src=y>" }],
				running: [{ name: "bash", summary: "<b>빌드</b>", ageMs: 3000, outputTail: "<script>x</script>" }],
				retry: { attempt: 1, error: "<img src=z>" },
			},
			renderMarkdown,
			{ settling: false },
		);
		expect(html).toContain("is-live");
		expect(html).not.toMatch(/<script/i);
		expect(html).not.toMatch(/<img/i);
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).toContain("재시도 1회");
	});
});
