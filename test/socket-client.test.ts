import { afterEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { SocketClient, type SocketClientHandlers } from "../src/slack/socket-client";

const WAIT_MS = 5_000;

interface Harness {
	received: Array<Record<string, unknown>>;
	sockets: Array<ServerWebSocket<undefined>>;
	requestUrls: string[];
	opens: number;
	/** Resolves once `cond` holds; re-checked on every server-side event. Bounded by WAIT_MS. */
	until(cond: () => boolean): Promise<void>;
	fetchImpl: typeof fetch;
	stopServer(): void;
}

function startHarness(openResponse?: () => Response): Harness {
	const waiters: Array<() => void> = [];
	const notify = (): void => {
		for (const w of waiters.splice(0)) w();
	};
	const h: Harness = {
		received: [],
		sockets: [],
		requestUrls: [],
		opens: 0,
		until: async (cond) => {
			const deadline = Date.now() + WAIT_MS;
			while (!cond()) {
				const left = deadline - Date.now();
				if (left <= 0) throw new Error("timed out waiting for condition");
				await new Promise<void>((resolve) => {
					// Upper bound only: the wait ends on the next server event; the timer just fails a hung test.
					const t = setTimeout(resolve, left);
					waiters.push(() => {
						clearTimeout(t);
						resolve();
					});
				});
			}
		},
		fetchImpl: undefined as unknown as typeof fetch,
		stopServer: () => {},
	};
	const server = Bun.serve({
		port: 0,
		fetch(req, s) {
			h.requestUrls.push(req.url);
			return s.upgrade(req) ? undefined : new Response("upgrade required", { status: 426 });
		},
		websocket: {
			open(ws) {
				h.sockets.push(ws);
				ws.send(JSON.stringify({ type: "hello", num_connections: 1 }));
				notify();
			},
			message(_ws, m) {
				h.received.push(JSON.parse(String(m)) as Record<string, unknown>);
				notify();
			},
			close() {
				notify();
			},
		},
	});
	// Stand-in for the global fetch: only apps.connections.open is called, and the harness is the whole API surface.
	const fake = async (): Promise<Response> => {
		h.opens++;
		notify();
		return openResponse
			? openResponse()
			: Response.json({ ok: true, url: `ws://localhost:${server.port}/?n=${h.opens}` });
	};
	h.fetchImpl = fake as unknown as typeof fetch;
	h.stopServer = () => {
		void server.stop(true);
	};
	return h;
}

const noopHandlers: SocketClientHandlers = {
	eventsApi: async () => {},
	slashCommand: async () => undefined,
	interactive: async () => {},
};

let harness: Harness | undefined;
let client: SocketClient | undefined;

afterEach(() => {
	client?.stop();
	harness?.stopServer();
	client = undefined;
	harness = undefined;
});

function make(h: Harness, extra: Partial<ConstructorParameters<typeof SocketClient>[0]> = {}): SocketClient {
	client = new SocketClient({
		appToken: "xapp-test",
		handlers: noopHandlers,
		fetchImpl: h.fetchImpl,
		backoffBaseMs: 1,
		backoffMaxMs: 5,
		...extra,
	});
	return client;
}

describe("SocketClient", () => {
	test("start resolves on hello", async () => {
		harness = startHarness();
		await make(harness).start();
		expect(harness.opens).toBe(1);
	});

	test("acks envelopes with envelope_id and dispatches to handlers", async () => {
		const h = startHarness();
		harness = h;
		const events: unknown[] = [];
		const interactions: unknown[] = [];
		const c = make(h, {
			handlers: {
				eventsApi: async (p) => {
					events.push(p);
				},
				slashCommand: async () => ({ response_type: "ephemeral", text: "ok" }),
				interactive: async (p) => {
					interactions.push(p);
				},
			},
		});
		await c.start();
		const ws = h.sockets[0];
		if (!ws) throw new Error("no server socket");
		ws.send(JSON.stringify({ envelope_id: "e1", type: "events_api", payload: { event: { type: "message" } } }));
		ws.send(JSON.stringify({ envelope_id: "s1", type: "slash_commands", payload: { command: "/x" } }));
		ws.send(JSON.stringify({ envelope_id: "i1", type: "interactive", payload: { type: "block_actions" } }));
		await h.until(() => h.received.length === 3);
		expect(h.received).toContainEqual({ envelope_id: "e1" });
		expect(h.received).toContainEqual({ envelope_id: "i1" });
		expect(h.received).toContainEqual({ envelope_id: "s1", payload: { response_type: "ephemeral", text: "ok" } });
		await h.until(() => events.length === 1 && interactions.length === 1);
		expect(events[0]).toEqual({ event: { type: "message" } });
		expect(interactions[0]).toEqual({ type: "block_actions" });
	});

	test("events are acked before a slow handler finishes; handler errors do not break the connection", async () => {
		const h = startHarness();
		harness = h;
		const errors: string[] = [];
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const c = make(h, {
			onError: (e) => errors.push(e.message),
			handlers: {
				...noopHandlers,
				eventsApi: async (p) => {
					if ((p as { fail?: boolean }).fail) throw new Error("handler boom");
					await gate;
				},
			},
		});
		await c.start();
		const ws = h.sockets[0];
		if (!ws) throw new Error("no server socket");
		ws.send(JSON.stringify({ envelope_id: "slow", type: "events_api", payload: {} }));
		await h.until(() => h.received.some((m) => m.envelope_id === "slow"));
		ws.send(JSON.stringify({ envelope_id: "bad", type: "events_api", payload: { fail: true } }));
		await h.until(() => h.received.some((m) => m.envelope_id === "bad") && errors.includes("handler boom"));
		release();
		expect(h.opens).toBe(1);
	});

	test("disconnect envelope reconnects with a fresh url", async () => {
		const h = startHarness();
		harness = h;
		const reasons: string[] = [];
		const c = make(h, { onReconnect: (r) => reasons.push(r) });
		await c.start();
		h.sockets[0]?.send(JSON.stringify({ type: "disconnect", reason: "refresh_requested" }));
		await h.until(() => h.sockets.length === 2);
		expect(h.opens).toBe(2);
		expect(reasons).toEqual(["disconnect:refresh_requested"]);
		expect(h.requestUrls[0]).toContain("n=1");
		expect(h.requestUrls[1]).toContain("n=2");
	});

	test("reconnects with backoff when the server closes the socket", async () => {
		const h = startHarness();
		harness = h;
		const c = make(h);
		await c.start();
		h.sockets[0]?.close();
		await h.until(() => h.sockets.length === 2);
		expect(h.opens).toBe(2);
	});

	test("dead socket (no traffic past deadAfterMs by the injected clock) is replaced", async () => {
		const h = startHarness();
		harness = h;
		let clock = 0;
		const reasons: string[] = [];
		const c = make(h, {
			now: () => clock,
			deadAfterMs: 1_000,
			checkIntervalMs: 5,
			onReconnect: (r) => reasons.push(r),
		});
		await c.start();
		clock += 10_000; // the watchdog sees a long silence on its next tick
		await h.until(() => h.sockets.length === 2);
		expect(reasons).toHaveLength(1);
		expect(reasons[0]).toStartWith("no traffic");
	});

	test("transient open failures retry; the client then connects", async () => {
		let calls = 0;
		const h = startHarness();
		harness = h;
		const good = h.fetchImpl;
		h.fetchImpl = (async (...args: Parameters<typeof fetch>) => {
			if (++calls <= 2) return Response.json({ ok: false, error: "ratelimited_internal" });
			return good(...args);
		}) as unknown as typeof fetch;
		const errors: string[] = [];
		await make(h, { onError: (e) => errors.push(e.message) }).start();
		expect(calls).toBe(3);
		expect(errors).toHaveLength(2);
	});

	test("start rejects when Slack refuses the app token", async () => {
		const h = startHarness(() => Response.json({ ok: false, error: "invalid_auth" }));
		harness = h;
		await expect(make(h).start()).rejects.toThrow("invalid_auth");
		expect(h.sockets).toHaveLength(0);
	});

	test("stop closes the socket and prevents reconnects", async () => {
		const h = startHarness();
		harness = h;
		const c = make(h);
		await c.start();
		c.stop();
		await h.until(() => h.sockets[0]?.readyState !== 1);
		expect(h.opens).toBe(1);
	});
});
