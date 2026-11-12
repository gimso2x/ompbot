import { afterEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { DiscordGateway, type DiscordGatewayOptions, type GatewayTimers } from "../src/discord/gateway";
import { DiscordSocketTransport } from "../src/discord/socket-transport";
import {
	DISCORD_INTENTS,
	DiscordGatewayFatalError,
	type DiscordHandlers,
	type DiscordInteraction,
	type DiscordMessageEvent,
	type DiscordReactionEvent,
} from "../src/discord/transport";

const WAIT_MS = 5_000;
// Not a real token: assembled at runtime so no token-shaped literal sits in the repo.
const TOKEN = ["TEST", "gateway", "token"].join(".");
const BOT = "500000000000000001";
const APP = "600000000000000001";
const INTERVAL = 1_000;

/** Manual clock: callbacks run only inside `advance`, in due order, so the test decides when time passes. */
class FakeTimers implements GatewayTimers {
	now = 0;
	#seq = 0;
	readonly pending = new Map<number, { fn: () => void; due: number; ms: number }>();

	set(fn: () => void, ms: number): unknown {
		this.#seq += 1;
		this.pending.set(this.#seq, { fn, due: this.now + ms, ms });
		return this.#seq;
	}

	clear(handle: unknown): void {
		this.pending.delete(handle as number);
	}

	delays(): number[] {
		return [...this.pending.values()].map((t) => t.ms).sort((a, b) => a - b);
	}

	advance(ms: number): void {
		const target = this.now + ms;
		for (;;) {
			let next: [number, { fn: () => void; due: number }] | undefined;
			for (const entry of this.pending)
				if (entry[1].due <= target && (!next || entry[1].due < next[1].due)) next = entry;
			if (next === undefined) break;
			this.pending.delete(next[0]);
			this.now = next[1].due;
			next[1].fn();
		}
		this.now = target;
	}
}

interface Frame {
	op: number;
	d: Record<string, unknown> | number | null;
}

interface Conn {
	ws: ServerWebSocket<{ path: string; search: string }>;
	path: string;
	search: string;
	received: Frame[];
	closed: boolean;
}

interface Harness {
	port: number;
	conns: Conn[];
	/** When false, heartbeats go unanswered (zombie connection). */
	ack: boolean;
	/** When false, Identify gets no READY (the test answers by hand). */
	autoReady: boolean;
	/** When false, a new connection gets no HELLO. */
	hello: boolean;
	notify(): void;
	until(cond: () => boolean): Promise<void>;
	send(conn: number, payload: unknown): void;
	stop(): void;
}

function startHarness(): Harness {
	const waiters: Array<() => void> = [];
	let sessions = 0;
	const h: Harness = {
		port: 0,
		conns: [],
		ack: true,
		autoReady: true,
		hello: true,
		notify: () => {
			for (const w of waiters.splice(0)) w();
		},
		until: async (cond) => {
			const deadline = Date.now() + WAIT_MS;
			while (!cond()) {
				const left = deadline - Date.now();
				if (left <= 0) throw new Error("timed out waiting for condition");
				const { promise, resolve } = Promise.withResolvers<void>();
				// Upper bound only: the wait ends on the next server or handler event; the timer just fails a hung test.
				const t = setTimeout(resolve, left);
				waiters.push(() => {
					clearTimeout(t);
					resolve();
				});
				await promise;
			}
		},
		send: (conn, payload) => {
			h.conns[conn]?.ws.send(JSON.stringify(payload));
		},
		stop: () => {},
	};
	const server = Bun.serve<{ path: string; search: string }>({
		port: 0,
		fetch(req, s) {
			const url = new URL(req.url);
			return s.upgrade(req, { data: { path: url.pathname, search: url.search } })
				? undefined
				: new Response("upgrade required", { status: 426 });
		},
		websocket: {
			open(ws) {
				h.conns.push({ ws, path: ws.data.path, search: ws.data.search, received: [], closed: false });
				if (h.hello) ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: INTERVAL } }));
				h.notify();
			},
			message(ws, raw) {
				const conn = h.conns.find((c) => c.ws === ws);
				const frame = JSON.parse(String(raw)) as Frame;
				conn?.received.push(frame);
				if (frame.op === 1 && h.ack) ws.send(JSON.stringify({ op: 11 }));
				if (frame.op === 2 && h.autoReady) {
					sessions += 1;
					ws.send(
						JSON.stringify({
							op: 0,
							t: "READY",
							s: 1,
							d: {
								v: 10,
								session_id: `sess-${sessions}`,
								resume_gateway_url: `ws://localhost:${h.port}/resume`,
								user: { id: BOT, bot: true },
								application: { id: APP },
							},
						}),
					);
				}
				if (frame.op === 6) {
					const seq = (frame.d as { seq: number }).seq;
					ws.send(JSON.stringify({ op: 0, t: "RESUMED", s: seq + 1, d: {} }));
				}
				h.notify();
			},
			close(ws) {
				const conn = h.conns.find((c) => c.ws === ws);
				if (conn) conn.closed = true;
				h.notify();
			},
		},
	});
	h.port = server.port ?? 0;
	h.stop = () => {
		void server.stop(true);
	};
	return h;
}

interface Recorded {
	messages: DiscordMessageEvent[];
	reactions: DiscordReactionEvent[];
	interactions: DiscordInteraction[];
	ready: Array<{ resumed: boolean }>;
	fatal: DiscordGatewayFatalError[];
	reconnects: string[];
	errors: string[];
}

let harness: Harness | undefined;
let gateway: DiscordGateway | undefined;
let transport: DiscordSocketTransport | undefined;

afterEach(async () => {
	gateway?.stop();
	await transport?.stop();
	harness?.stop();
	gateway = undefined;
	transport = undefined;
	harness = undefined;
});

function make(
	h: Harness,
	timers: FakeTimers,
	extra: Partial<DiscordGatewayOptions> = {},
): { gw: DiscordGateway; rec: Recorded } {
	const rec: Recorded = {
		messages: [],
		reactions: [],
		interactions: [],
		ready: [],
		fatal: [],
		reconnects: [],
		errors: [],
	};
	const handlers: DiscordHandlers = {
		message: async (event) => {
			rec.messages.push(event);
			h.notify();
		},
		reaction: async (event) => {
			rec.reactions.push(event);
			h.notify();
		},
		interaction: async (interaction) => {
			rec.interactions.push(interaction);
			h.notify();
		},
	};
	gateway = new DiscordGateway({
		token: TOKEN,
		url: `ws://localhost:${h.port}/gateway`,
		handlers,
		timers,
		now: () => timers.now,
		random: () => 0.25,
		backoffBaseMs: 100,
		backoffMaxMs: 1_000,
		onReady: (info) => {
			rec.ready.push(info);
			h.notify();
		},
		onFatal: (error) => {
			rec.fatal.push(error);
			h.notify();
		},
		onReconnect: (reason) => {
			rec.reconnects.push(reason);
			h.notify();
		},
		onError: (error) => {
			rec.errors.push(error.message);
			h.notify();
		},
		...extra,
	});
	return { gw: gateway, rec };
}

const opsOf = (conn: Conn | undefined): number[] => (conn?.received ?? []).map((f) => f.op);
const heartbeats = (conn: Conn | undefined): Frame[] => (conn?.received ?? []).filter((f) => f.op === 1);

describe("DiscordGateway", () => {
	test("Hello → Identify (token, intents 46593) → Ready keeps session_id, resume url and the bot ids", async () => {
		const h = startHarness();
		harness = h;
		const timers = new FakeTimers();
		const { gw, rec } = make(h, timers);
		expect(gw.connectionState()).toEqual({ state: "down", since: 0 });
		expect(await gw.start()).toEqual({ botUserId: BOT, applicationId: APP });
		const conn = h.conns[0];
		expect(conn?.search).toContain("v=10");
		expect(conn?.search).toContain("encoding=json");
		const identify = conn?.received.find((f) => f.op === 2)?.d as Record<string, unknown>;
		expect(DISCORD_INTENTS).toBe(46593);
		expect(identify.token).toBe(TOKEN);
		expect(identify.intents).toBe(46593);
		expect(identify.properties).toMatchObject({ browser: "ompbot", device: "ompbot" });
		expect(identify.presence).toEqual({ status: "online", since: null, activities: [], afk: false });
		expect(gw.session()).toEqual({
			sessionId: "sess-1",
			resumeUrl: `ws://localhost:${h.port}/resume`,
			seq: 1,
		});
		expect(rec.ready).toEqual([{ resumed: false }]);
		timers.now = 42;
		h.send(0, {
			op: 0,
			t: "MESSAGE_CREATE",
			s: 2,
			d: { id: "1", channel_id: "2", author: { id: "3" }, content: "", type: 0 },
		});
		await h.until(() => rec.messages.length === 1);
		expect(gw.connectionState()).toEqual({ state: "up", since: 0 });
	});

	test("the first heartbeat waits interval × jitter, then one per interval carrying the last sequence", async () => {
		const h = startHarness();
		harness = h;
		const timers = new FakeTimers();
		const { gw } = make(h, timers);
		await gw.start();
		expect(timers.delays()).toEqual([250]);
		timers.advance(249);
		expect(timers.delays()).toEqual([250]);
		timers.advance(1);
		await h.until(() => heartbeats(h.conns[0]).length === 1);
		expect(heartbeats(h.conns[0])[0]?.d).toBe(1);
		expect(timers.delays()).toEqual([INTERVAL]);
		h.send(0, { op: 0, t: "TYPING_START", s: 7, d: {} });
		// Wait until the client has seen s=7: answer it with a server heartbeat request (op 1), which is answered at once.
		h.send(0, { op: 1, d: null });
		await h.until(() => heartbeats(h.conns[0]).length === 2);
		timers.advance(INTERVAL);
		await h.until(() => heartbeats(h.conns[0]).length === 3);
		expect(heartbeats(h.conns[0])[2]?.d).toBe(7);
		expect(h.conns).toHaveLength(1);
	});

	test("a heartbeat with no ACK within one interval closes the socket and resumes with session_id and the last s", async () => {
		const h = startHarness();
		harness = h;
		h.ack = false;
		const timers = new FakeTimers();
		const { gw, rec } = make(h, timers);
		await gw.start();
		h.send(0, {
			op: 0,
			t: "MESSAGE_CREATE",
			s: 5,
			d: { id: "10", channel_id: "20", author: { id: "30" }, content: "hi", type: 0 },
		});
		await h.until(() => rec.messages.length === 1);
		timers.advance(250);
		await h.until(() => heartbeats(h.conns[0]).length === 1);
		timers.advance(INTERVAL);
		await h.until(() => h.conns[0]?.closed === true && opsOf(h.conns[1]).includes(6));
		expect(h.conns[1]?.path).toBe("/resume");
		expect(h.conns[1]?.received.find((f) => f.op === 6)?.d).toEqual({ token: TOKEN, session_id: "sess-1", seq: 5 });
		expect(h.conns[1]?.received.find((f) => f.op === 6)?.d).not.toHaveProperty("presence");
		expect(opsOf(h.conns[1])).not.toContain(2);
		await h.until(() => rec.ready.length === 2);
		expect(rec.ready[1]).toEqual({ resumed: true });
		expect(rec.reconnects).toHaveLength(1);
	});

	test("Reconnect (op 7) resumes at once", async () => {
		const h = startHarness();
		harness = h;
		const timers = new FakeTimers();
		const { gw } = make(h, timers);
		await gw.start();
		h.send(0, { op: 7, d: null });
		await h.until(() => opsOf(h.conns[1]).includes(6));
		expect(h.conns[1]?.path).toBe("/resume");
		expect(h.conns[1]?.received.find((f) => f.op === 6)?.d).toEqual({ token: TOKEN, session_id: "sess-1", seq: 1 });
	});

	test("Invalid Session d:true resumes; d:false identifies anew after a 1–5 s wait", async () => {
		const h = startHarness();
		harness = h;
		const timers = new FakeTimers();
		const { gw } = make(h, timers);
		await gw.start();
		h.send(0, { op: 9, d: true });
		await h.until(() => opsOf(h.conns[1]).includes(6));
		expect(h.conns[1]?.path).toBe("/resume");

		h.send(1, { op: 9, d: false });
		await h.until(() => h.conns[1]?.closed === true);
		const waits = timers.delays().filter((ms) => ms !== 250 && ms !== INTERVAL);
		expect(waits).toHaveLength(1);
		const wait = waits[0] ?? 0;
		expect(wait).toBeGreaterThanOrEqual(1_000);
		expect(wait).toBeLessThanOrEqual(5_000);
		expect(h.conns).toHaveLength(2);
		timers.advance(wait);
		await h.until(() => gw.session().sessionId === "sess-2");
		expect(h.conns[2]?.path).toBe("/gateway");
		expect(opsOf(h.conns[2])).toContain(2);
		expect(opsOf(h.conns[2])).not.toContain(6);
	});

	test("close 4004 before Ready rejects start and never reconnects", async () => {
		const h = startHarness();
		harness = h;
		h.autoReady = false;
		const timers = new FakeTimers();
		const { gw, rec } = make(h, timers);
		const started = gw.start();
		await h.until(() => opsOf(h.conns[0]).includes(2));
		h.conns[0]?.ws.close(4004, "Authentication failed.");
		const error = await started.then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(DiscordGatewayFatalError);
		expect((error as DiscordGatewayFatalError).code).toBe(4004);
		expect(rec.fatal).toHaveLength(1);
		expect(rec.reconnects).toEqual([]);
		expect(timers.delays()).toEqual([]);
		timers.advance(60_000);
		expect(h.conns).toHaveLength(1);
		expect(gw.connectionState().state).toBe("down");
	});

	for (const code of [4013, 4014]) {
		test(`close ${code} after Ready is fatal: onFatal, state down, no reconnect`, async () => {
			const h = startHarness();
			harness = h;
			const timers = new FakeTimers();
			const { gw, rec } = make(h, timers);
			await gw.start();
			timers.now = 900;
			h.conns[0]?.ws.close(code, "fatal");
			await h.until(() => rec.fatal.length === 1);
			expect(rec.fatal[0]?.code).toBe(code);
			expect(gw.connectionState()).toEqual({ state: "down", since: 900 });
			expect(rec.reconnects).toEqual([]);
			expect(timers.delays()).toEqual([]);
			timers.advance(60_000);
			expect(h.conns).toHaveLength(1);
		});
	}

	test("close 4000 reconnects after the backoff and resumes; 4009 reconnects with a new Identify", async () => {
		const h = startHarness();
		harness = h;
		const timers = new FakeTimers();
		const { gw, rec } = make(h, timers);
		await gw.start();
		timers.now = 500;
		h.conns[0]?.ws.close(4000, "Unknown error");
		await h.until(() => rec.reconnects.length === 1);
		expect(gw.connectionState()).toEqual({ state: "down", since: 500 });
		expect(timers.delays()).toEqual([100]);
		timers.advance(100);
		await h.until(() => opsOf(h.conns[1]).includes(6));
		expect(h.conns[1]?.path).toBe("/resume");
		await h.until(() => rec.ready.length === 2);
		expect(gw.connectionState().state).toBe("up");

		h.conns[1]?.ws.close(4009, "Session timed out");
		await h.until(() => rec.reconnects.length === 2);
		const backoff = timers.delays().filter((ms) => ms !== 250 && ms !== INTERVAL);
		expect(backoff).toEqual([100]);
		timers.advance(100);
		await h.until(() => opsOf(h.conns[2]).includes(2));
		expect(h.conns[2]?.path).toBe("/gateway");
		expect(opsOf(h.conns[2])).not.toContain(6);
	});

	test("a gateway url that is no URL is reported and looked up again after the backoff; start still resolves", async () => {
		const h = startHarness();
		harness = h;
		const timers = new FakeTimers();
		let lookups = 0;
		const { gw, rec } = make(h, timers, {
			url: async () => {
				lookups += 1;
				return lookups === 1 ? "::not a gateway url::" : `ws://localhost:${h.port}/gateway`;
			},
		});
		const started = gw.start();
		await h.until(() => rec.errors.length === 1);
		expect(h.conns).toHaveLength(0);
		expect(timers.delays()).toEqual([100]);
		timers.advance(100);
		expect(await started).toEqual({ botUserId: BOT, applicationId: APP });
		expect(lookups).toBe(2);
		expect(h.conns[0]?.path).toBe("/gateway");
	});

	test("a resume url that is no URL drops the session: reported, then a new Identify on the gateway url", async () => {
		const h = startHarness();
		harness = h;
		h.autoReady = false;
		const timers = new FakeTimers();
		const { gw, rec } = make(h, timers);
		const started = gw.start();
		await h.until(() => opsOf(h.conns[0]).includes(2));
		h.send(0, {
			op: 0,
			t: "READY",
			s: 1,
			d: { session_id: "sess-x", resume_gateway_url: "::not a url::", user: { id: BOT }, application: { id: APP } },
		});
		await started;
		h.send(0, { op: 7, d: null });
		await h.until(() => rec.errors.length === 1);
		expect(gw.session().sessionId).toBeUndefined();
		const backoff = timers.delays().filter((ms) => ms !== 250 && ms !== INTERVAL);
		expect(backoff).toEqual([100]);
		timers.advance(100);
		await h.until(() => opsOf(h.conns[1]).includes(2));
		expect(h.conns[1]?.path).toBe("/gateway");
		expect(opsOf(h.conns[1])).not.toContain(6);
	});

	test("no HELLO within 30 s: the socket is closed and reconnected after the backoff; start does not reject", async () => {
		const h = startHarness();
		harness = h;
		h.hello = false;
		const timers = new FakeTimers();
		const { gw, rec } = make(h, timers);
		let rejected: unknown;
		const started = gw.start().catch((e: unknown) => {
			rejected = e;
			return undefined;
		});
		await h.until(() => h.conns.length === 1);
		expect(timers.delays()).toEqual([30_000]);
		timers.advance(29_999);
		expect(rec.reconnects).toEqual([]);
		timers.advance(1);
		await h.until(() => h.conns[0]?.closed === true);
		expect(rec.reconnects).toEqual(["hello timeout"]);
		expect(timers.delays()).toEqual([100]);
		h.hello = true;
		timers.advance(100);
		expect(await started).toEqual({ botUserId: BOT, applicationId: APP });
		expect(rejected).toBeUndefined();
		expect(h.conns).toHaveLength(2);
	});

	test("a READY without resume_gateway_url is reported, closed and identified anew after the backoff", async () => {
		const h = startHarness();
		harness = h;
		h.autoReady = false;
		const timers = new FakeTimers();
		const { gw, rec } = make(h, timers);
		let rejected: unknown;
		const started = gw.start().catch((e: unknown) => {
			rejected = e;
			return undefined;
		});
		await h.until(() => opsOf(h.conns[0]).includes(2));
		h.send(0, { op: 0, t: "READY", s: 1, d: { session_id: "sess-bad", user: { id: BOT }, application: { id: APP } } });
		await h.until(() => rec.reconnects.length === 1 && h.conns[0]?.closed === true);
		expect(rec.errors).toEqual(["discord ready without session or ids"]);
		expect(gw.session().sessionId).toBeUndefined();
		expect(timers.delays()).toEqual([100]);
		timers.advance(100);
		await h.until(() => opsOf(h.conns[1]).includes(2));
		expect(h.conns[1]?.path).toBe("/gateway");
		h.send(1, {
			op: 0,
			t: "READY",
			s: 1,
			d: {
				session_id: "sess-ok",
				resume_gateway_url: `ws://localhost:${h.port}/resume`,
				user: { id: BOT },
				application: { id: APP },
			},
		});
		expect(await started).toEqual({ botUserId: BOT, applicationId: APP });
		expect(rejected).toBeUndefined();
	});

	test("Dispatch events reach the message, reaction and interaction handlers; other events are ignored", async () => {
		const h = startHarness();
		harness = h;
		const timers = new FakeTimers();
		const { gw, rec } = make(h, timers);
		await gw.start();
		const message = { id: "10", channel_id: "20", guild_id: "40", author: { id: "30" }, content: "hi", type: 0 };
		const reaction = { user_id: "30", channel_id: "20", message_id: "10", emoji: { id: null, name: "👍" } };
		const interaction = { id: "77", application_id: APP, type: 3, token: "itok", data: { custom_id: "x" } };
		h.send(0, { op: 0, t: "GUILD_CREATE", s: 2, d: { id: "40" } });
		h.send(0, { op: 0, t: "MESSAGE_CREATE", s: 3, d: message });
		h.send(0, { op: 0, t: "MESSAGE_REACTION_ADD", s: 4, d: reaction });
		h.send(0, { op: 0, t: "MESSAGE_REACTION_REMOVE", s: 5, d: reaction });
		h.send(0, { op: 0, t: "INTERACTION_CREATE", s: 6, d: interaction });
		await h.until(() => rec.interactions.length === 1 && rec.reactions.length === 2);
		expect(rec.messages).toEqual([message as DiscordMessageEvent]);
		expect(rec.reactions).toEqual([
			{ type: "add", ...reaction },
			{ type: "remove", ...reaction },
		]);
		expect(rec.interactions).toEqual([interaction as DiscordInteraction]);
		expect(gw.session().seq).toBe(6);
	});

	test("a throwing handler is reported and the connection stays", async () => {
		const h = startHarness();
		harness = h;
		const timers = new FakeTimers();
		const errors: string[] = [];
		const { gw } = make(h, timers, {
			handlers: {
				message: async () => {
					throw new Error("handler boom");
				},
				reaction: async () => {},
				interaction: async () => {},
			},
			onError: (error) => {
				errors.push(error.message);
				h.notify();
			},
		});
		await gw.start();
		h.send(0, {
			op: 0,
			t: "MESSAGE_CREATE",
			s: 2,
			d: { id: "1", channel_id: "2", author: { id: "3" }, content: "", type: 0 },
		});
		await h.until(() => errors.includes("handler boom"));
		expect(gw.connectionState().state).toBe("up");
		expect(h.conns[0]?.closed).toBe(false);
		expect(h.conns).toHaveLength(1);
	});

	test("null, array and number frames are reported once each and dropped; the next dispatch still arrives", async () => {
		const h = startHarness();
		harness = h;
		const timers = new FakeTimers();
		const errors: string[] = [];
		const { gw, rec } = make(h, timers, {
			onError: (error) => {
				errors.push(error.message);
				h.notify();
			},
		});
		await gw.start();
		let seq = 1;
		for (const frame of ["null", "[]", "1"]) {
			const before = errors.length;
			h.conns[0]?.ws.send(frame);
			seq += 1;
			h.send(0, {
				op: 0,
				t: "MESSAGE_CREATE",
				s: seq,
				d: { id: String(seq), channel_id: "2", author: { id: "3" }, content: "", type: 0 },
			});
			await h.until(() => rec.messages.length === seq - 1);
			expect(errors.slice(before)).toEqual(["non-object discord gateway frame"]);
		}
		expect(gw.session().seq).toBe(seq);
		expect(gw.connectionState().state).toBe("up");
		expect(h.conns).toHaveLength(1);
	});

	test("stop closes the socket and prevents reconnects", async () => {
		const h = startHarness();
		harness = h;
		const timers = new FakeTimers();
		const { gw } = make(h, timers);
		await gw.start();
		gw.stop();
		await h.until(() => h.conns[0]?.closed === true);
		expect(timers.delays()).toEqual([]);
		timers.advance(60_000);
		expect(h.conns).toHaveLength(1);
		expect(gw.connectionState().state).toBe("down");
	});
});

describe("DiscordSocketTransport", () => {
	test("reads the gateway url over REST, connects, and routes REST calls and gateway events", async () => {
		const h = startHarness();
		harness = h;
		const restCalls: string[] = [];
		const api = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				restCalls.push(`${req.method} ${url.pathname}`);
				if (url.pathname.endsWith("/gateway/bot")) return Response.json({ url: `ws://localhost:${h.port}/gateway` });
				return Response.json({ id: "901" });
			},
		});
		try {
			const messages: DiscordMessageEvent[] = [];
			const ready: Array<{ resumed: boolean }> = [];
			transport = new DiscordSocketTransport(
				{ botToken: TOKEN },
				{ baseUrl: `http://localhost:${api.port}/api/v10`, onReady: (info) => ready.push(info) },
			);
			expect(transport.connectionState().state).toBe("down");
			const started = await transport.start({
				message: async (event) => {
					messages.push(event);
					h.notify();
				},
				reaction: async () => {},
				interaction: async () => {},
			});
			expect(started).toEqual({ botUserId: BOT, applicationId: APP });
			expect(ready).toEqual([{ resumed: false }]);
			expect(transport.connectionState().state).toBe("up");
			expect(await transport.createMessage({ channelId: "20", content: "hi" })).toEqual({ id: "901" });
			expect(restCalls).toEqual(["GET /api/v10/gateway/bot", "POST /api/v10/channels/20/messages"]);
			h.send(0, {
				op: 0,
				t: "MESSAGE_CREATE",
				s: 2,
				d: { id: "1", channel_id: "2", author: { id: "3" }, content: "x", type: 0 },
			});
			await h.until(() => messages.length === 1);
		} finally {
			void api.stop(true);
		}
	});

	test("applies the configured display name once at start; a refused patch is logged, not fatal", async () => {
		const h = startHarness();
		harness = h;
		const patches: Array<{ name: string | undefined }> = [];
		const api = Bun.serve({
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				if (url.pathname.endsWith("/gateway/bot")) return Response.json({ url: `ws://localhost:${h.port}/gateway` });
				if (req.method === "PATCH") {
					patches.push({
						name: (JSON.parse(await req.text()) as { display_name?: unknown }).display_name as string,
					});
					return Response.json({ message: "Invalid Form Body" }, { status: 400 });
				}
				return Response.json({ id: BOT });
			},
		});
		const errors: string[] = [];
		const original = console.error;
		console.error = (line: string) => errors.push(String(line));
		try {
			transport = new DiscordSocketTransport(
				{ botToken: TOKEN },
				{ baseUrl: `http://localhost:${api.port}/api/v10`, displayName: "송박" },
			);
			const started = await transport.start({
				message: async () => {},
				reaction: async () => {},
				interaction: async () => {},
			});
			expect(started).toEqual({ botUserId: BOT, applicationId: APP });
			expect(transport.connectionState().state).toBe("up");
			expect(patches).toEqual([{ name: "송박" }]);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toContain("discord display_name");
		} finally {
			console.error = original;
			void api.stop(true);
		}
	});
});
