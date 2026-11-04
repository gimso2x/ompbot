import { afterEach, describe, expect, test } from "bun:test";
import { type BoardCard, type BoardPanel, BoardSource, type BoardState } from "../src/dashboard/board";
import { startDashboardServer } from "../src/dashboard/server";

/** How long any awaited event may take before the test fails (a bound, not a sleep). */
const WAIT_MS = 5_000;
const UNREACHABLE = '{"ok":false,"error":"herdr_unreachable"}';

const CARD: BoardCard = {
	key: "w1:p1",
	local: true,
	machineId: "local",
	machineName: "oci",
	paneId: "w1:p1",
	workspaceId: "w1",
	workspaceLabel: "main",
	tabLabel: "t-1",
	paneLabel: "work",
	name: "t-1",
	agent: "omp",
	status: "working",
	column: "working",
	unknown: false,
	since: 0,
	cwd: null,
};

/** A board whose one machine's name tells the test which change it is. */
const boardNamed = (name: string): BoardState => ({
	machines: [{ id: "local", name, connected: true }],
	cards: [CARD],
});

/** A board source the test drives: no herdr stream; `set` changes the board and tells every listener at once. */
class DrivenSource extends BoardSource {
	private board: BoardState | undefined;
	private readonly hearers = new Set<() => void>();
	private readonly silent: Array<() => void> = [];

	override current(): BoardState | undefined {
		return this.board;
	}

	override card(key: string): BoardCard | undefined {
		return this.board?.cards.find((card) => card.key === key);
	}

	override onChange(listener: () => void): () => void {
		this.hearers.add(listener);
		return () => {
			this.hearers.delete(listener);
			if (this.hearers.size === 0) for (const resolve of this.silent.splice(0)) resolve();
		};
	}

	set(board: BoardState | undefined): void {
		this.board = board;
		for (const listener of [...this.hearers]) listener();
	}

	/** Resolves once nothing listens to the board any more (at once if nothing does); rejects after WAIT_MS. */
	unheard(): Promise<void> {
		if (this.hearers.size === 0) return Promise.resolve();
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const timer = setTimeout(() => reject(new Error("timed out waiting for the board listeners to go")), WAIT_MS);
		this.silent.push(() => {
			clearTimeout(timer);
			resolve();
		});
		return promise;
	}
}

/** One open `api/board/events` stream. */
class EventStream {
	private buffer = "";
	private readonly decoder = new TextDecoder();

	private constructor(
		private readonly reader: {
			read(): Promise<{ value?: Uint8Array; done: boolean }>;
			cancel(): Promise<void>;
		},
	) {}

	static async open(base: string): Promise<EventStream> {
		const response = await fetch(`${base}/api/board/events`);
		expect(response.headers.get("content-type")).toStartWith("text/event-stream");
		if (response.body === null) throw new Error("no event stream body");
		return new EventStream(response.body.getReader());
	}

	/** The data line of the next `snapshot` event, as sent; keep-alive comments are skipped. Bounded by WAIT_MS. */
	async next(): Promise<string> {
		const { promise: expired, reject } = Promise.withResolvers<never>();
		const timer = setTimeout(() => reject(new Error("timed out waiting for a snapshot event")), WAIT_MS);
		try {
			for (;;) {
				let end = this.buffer.indexOf("\n\n");
				while (end >= 0) {
					const frame = this.buffer.slice(0, end);
					this.buffer = this.buffer.slice(end + 2);
					const data = /^data: (.*)$/m.exec(frame)?.[1];
					if (/^event: snapshot$/m.test(frame) && data !== undefined) return data;
					end = this.buffer.indexOf("\n\n");
				}
				const { value, done } = await Promise.race([this.reader.read(), expired]);
				if (done) throw new Error("board event stream ended");
				this.buffer += this.decoder.decode(value, { stream: true });
			}
		} finally {
			clearTimeout(timer);
		}
	}

	/** Name of the machine in the next snapshot event (which board change it carries). */
	async nextName(): Promise<string | undefined> {
		const view = JSON.parse(await this.next()) as BoardPanel;
		if (!view.ok) throw new Error(`board event without a board: ${view.error}`);
		return view.machines[0]?.name;
	}

	close(): Promise<void> {
		return this.reader.cancel();
	}
}

const stops: Array<() => void> = [];

afterEach(() => {
	for (const stop of stops.splice(0)) stop();
});

/** herdr-web-ui stand-in for the pane proxy, a driven board source and a dashboard counting its `board.tasks()` calls. */
function setup(options: { debounceMs?: number; keepAliveMs?: number; board?: BoardState | undefined } = {}): {
	base: string;
	source: DrivenSource;
	tasksCalls: () => number;
} {
	const upstream = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: (request) => Response.json({ path: new URL(request.url).pathname, turns: [] }),
	});
	stops.push(() => upstream.stop(true));
	const source = new DrivenSource({ origin: `http://127.0.0.1:${upstream.port}` });
	source.set("board" in options ? options.board : boardNamed("v1"));
	let calls = 0;
	const dashboard = startDashboardServer({
		port: 0,
		hostname: "127.0.0.1",
		snapshot: async () => {
			throw new Error("the page is not under test here");
		},
		board: {
			source,
			tasks: () => {
				calls += 1;
				return [];
			},
			...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
			...(options.keepAliveMs === undefined ? {} : { keepAliveMs: options.keepAliveMs }),
		},
	});
	stops.unshift(() => dashboard.stop(true));
	return { base: `http://127.0.0.1:${dashboard.port}`, source, tasksCalls: () => calls };
}

describe("board event fan-out", () => {
	test("AC-1: one board change reads the TASKs once and reaches all three event streams", async () => {
		const { base, source, tasksCalls } = setup({ debounceMs: 20 });
		const clients = await Promise.all([1, 2, 3].map(() => EventStream.open(base)));
		for (const client of clients) expect(await client.nextName()).toBe("v1");
		const before = tasksCalls();

		source.set(boardNamed("v2"));
		for (const client of clients) expect(await client.nextName()).toBe("v2");
		expect(tasksCalls()).toBe(before + 1);
		await Promise.all(clients.map((client) => client.close()));
	});

	test("AC-2: pane reads and the events HEAD never read the TASKs; 404s stay as they were", async () => {
		const { base, tasksCalls } = setup();
		for (const kind of ["conversation", "plan"]) {
			const known = await fetch(`${base}/api/pane/${kind}?card=${encodeURIComponent("w1:p1")}`);
			expect(known.status).toBe(200);
			expect(await known.json()).toMatchObject({ path: `/api/pane/${kind}` });
			expect((await fetch(`${base}/api/pane/${kind}?card=w1:p1`, { method: "HEAD" })).status).toBe(200);
			const unknown = await fetch(`${base}/api/pane/${kind}?card=nope:p1`);
			expect(unknown.status).toBe(404);
			expect(await unknown.json()).toEqual({ error: "unknown_pane" });
		}
		const head = await fetch(`${base}/api/board/events`, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(head.headers.get("content-type")).toStartWith("text/event-stream");
		expect(await head.text()).toBe("");
		expect(tasksCalls()).toBe(0);

		const bare = startDashboardServer({
			port: 0,
			hostname: "127.0.0.1",
			snapshot: async () => {
				throw new Error("unused");
			},
		});
		stops.push(() => bare.stop(true));
		const bareBase = `http://127.0.0.1:${bare.port}`;
		for (const path of ["api/pane/conversation?card=w1:p1", "api/pane/plan?card=w1:p1", "api/board/events"]) {
			const disabled = await fetch(`${bareBase}/${path}`);
			expect(disabled.status).toBe(404);
			expect(await disabled.json()).toEqual({ error: "board_disabled" });
			expect((await fetch(`${bareBase}/${path}`, { method: "HEAD" })).status).toBe(404);
		}
	});

	test("AC-3: changes inside the debounce window reach each stream as one event with the last board", async () => {
		const { base, source, tasksCalls } = setup({ debounceMs: 50 });
		const clients = await Promise.all([1, 2].map(() => EventStream.open(base)));
		for (const client of clients) expect(await client.nextName()).toBe("v1");
		const before = tasksCalls();

		source.set(boardNamed("a"));
		source.set(boardNamed("b"));
		source.set(boardNamed("c"));
		for (const client of clients) expect(await client.nextName()).toBe("c");
		expect(tasksCalls()).toBe(before + 1);

		// Nothing was left over from the burst: the next event is the next change.
		source.set(boardNamed("d"));
		for (const client of clients) expect(await client.nextName()).toBe("d");
		expect(tasksCalls()).toBe(before + 2);
		await Promise.all(clients.map((client) => client.close()));
	});

	test("AC-4: the first event comes at once, and herdr_unreachable while the board stream is down", async () => {
		// A debounce far beyond WAIT_MS: the first event can only arrive if it is not debounced.
		const slow = setup({ debounceMs: 60_000 });
		const first = await EventStream.open(slow.base);
		expect(await first.nextName()).toBe("v1");
		await first.close();

		const down = setup({ board: undefined, debounceMs: 0 });
		const client = await EventStream.open(down.base);
		expect(await client.next()).toBe(UNREACHABLE);
		down.source.set(boardNamed("up"));
		expect(await client.nextName()).toBe("up");
		down.source.set(undefined);
		expect(await client.next()).toBe(UNREACHABLE);
		await client.close();
	});

	test("AC-5: once every stream is gone a board change reads nothing; a new stream hears changes again", async () => {
		const { base, source, tasksCalls } = setup({ debounceMs: 0, keepAliveMs: 10 });
		const clients = await Promise.all([1, 2].map(() => EventStream.open(base)));
		for (const client of clients) expect(await client.nextName()).toBe("v1");
		const gone = source.unheard();
		await Promise.all(clients.map((client) => client.close()));
		await gone;

		const before = tasksCalls();
		source.set(boardNamed("v2"));
		expect(tasksCalls()).toBe(before);

		const again = await EventStream.open(base);
		expect(await again.nextName()).toBe("v2");
		source.set(boardNamed("v3"));
		expect(await again.nextName()).toBe("v3");
		await again.close();
	});
});
