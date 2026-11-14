import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store, StoreError } from "../src/store/db";
import {
	BACKOFF_CAP_MS,
	backoffMs,
	type DeliveryFacts,
	FRESHNESS_MS,
	transitionDelivery,
} from "../src/store/transitions";

class FakeClock {
	constructor(public t = 1_000_000) {}
	now(): number {
		return this.t;
	}
	advance(ms: number): void {
		this.t += ms;
	}
}

let dir: string;
let dbPath: string;
let clock: FakeClock;
const opened: Store[] = [];
const maskTest = (s: string) => s.replace(/xoxb-TEST-0/g, "[REDACTED]");

function open(hooks?: Parameters<typeof openStore>[0]["hooks"]): Store {
	const store = openStore({
		timezone: "Asia/Seoul",
		path: dbPath,
		clock,
		redact: maskTest,
		...(hooks ? { hooks } : {}),
	});
	opened.push(store);
	return store;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-store-"));
	dbPath = join(dir, "ompbot.db");
	clock = new FakeClock();
});

afterEach(() => {
	for (const s of opened.splice(0)) {
		try {
			s.close();
		} catch {}
	}
	rmSync(dir, { recursive: true, force: true });
});

function seedDelivery(store: Store, opRef = "op1"): number {
	store.ensureOrigin("o1", "/s/o1");
	const [row] = store.recordAnswer({ originKey: "o1", opRef, threadRef: "t1", parts: ["hello"] });
	if (!row) throw new Error("no delivery");
	return row.deliveryId;
}

describe("inbound", () => {
	test("same platform_message_id twice yields one row", () => {
		const store = open();
		store.ensureOrigin("o1", "/s/o1");
		const a = store.recordInbound({ originKey: "o1", platformMessageId: "m1", textRef: "hi" });
		const b = store.recordInbound({ originKey: "o1", platformMessageId: "m1", textRef: "hi again" });
		expect(a.inserted).toBe(true);
		expect(b.inserted).toBe(false);
		expect(b.row.textRef).toBe("hi");
		expect(store.listInbound()).toHaveLength(1);
	});

	test("unknown origin is rejected", () => {
		const store = open();
		expect(() => store.recordInbound({ originKey: "nope", platformMessageId: "m1", textRef: "x" })).toThrow(StoreError);
	});

	test("pending -> dispatched stores op_ref, entry_cursor (leafId string) and clock time", () => {
		const store = open();
		store.ensureOrigin("o1", "/s/o1");
		store.recordInbound({ originKey: "o1", platformMessageId: "m1", textRef: "x" });
		clock.advance(5);
		const row = store.markDispatched("m1", { opRef: "op1", entryCursor: "leaf-abc" });
		expect(row).toMatchObject({ state: "dispatched", opRef: "op1", entryCursor: "leaf-abc", dispatchedAt: clock.t });
	});

	test("entry_cursor may be null for an empty session", () => {
		const store = open();
		store.ensureOrigin("o1", "/s/o1");
		store.recordInbound({ originKey: "o1", platformMessageId: "m1", textRef: "x" });
		expect(store.markDispatched("m1", { opRef: "op1", entryCursor: null }).entryCursor).toBeNull();
	});

	test("full transition table: invalid moves throw", () => {
		const store = open();
		store.ensureOrigin("o1", "/s/o1");
		const mk = (id: string) => store.recordInbound({ originKey: "o1", platformMessageId: id, textRef: "x" });
		const dispatch = (id: string, op: string) => store.markDispatched(id, { opRef: op, entryCursor: null });

		mk("a");
		expect(() => store.markDispatched("a", { opRef: "x", entryCursor: null })).not.toThrow();
		expect(() => dispatch("a", "again")).toThrow(StoreError); // dispatched -> dispatched

		mk("b");
		expect(store.discard("b").state).toBe("discarded"); // pending -> discarded
		expect(() => dispatch("b", "x")).toThrow(StoreError); // discarded is terminal
		expect(() => store.discard("b")).toThrow(StoreError);

		mk("c");
		dispatch("c", "opc");
		expect(store.discard("c").state).toBe("discarded"); // dispatched -> discarded

		mk("d");
		dispatch("d", "opd");
		store.recordAnswer({ originKey: "o1", opRef: "opd", threadRef: "t", parts: ["r"] });
		expect(store.getInbound("d")?.state).toBe("answered");
		expect(() => store.discard("d")).toThrow(StoreError); // answered terminal

		mk("e");
		dispatch("e", "ope");
		store.recordTurnFailure({ originKey: "o1", opRef: "ope", threadRef: "t", notice: "[turn failed]" });
		expect(store.getInbound("e")?.state).toBe("failed_notified");
		expect(() => store.discard("e")).toThrow(StoreError);
	});

	test("a pending row is not answered by recordAnswer", () => {
		const store = open();
		store.ensureOrigin("o1", "/s/o1");
		store.recordInbound({ originKey: "o1", platformMessageId: "m1", textRef: "x" });
		store.recordAnswer({ originKey: "o1", opRef: "op1", threadRef: "t", parts: ["r"] });
		expect(store.getInbound("m1")?.state).toBe("pending");
	});

	test("one op answers every steered inbound row and creates one delivery per part", () => {
		const store = open();
		store.ensureOrigin("o1", "/s/o1");
		for (const id of ["m1", "m2"]) {
			store.recordInbound({ originKey: "o1", platformMessageId: id, textRef: id });
			store.markDispatched(id, { opRef: "op1", entryCursor: null });
		}
		const rows = store.recordAnswer({ originKey: "o1", opRef: "op1", threadRef: "t1", parts: ["p0", "p1"] });
		expect(rows.map((r) => [r.part, r.body, r.state])).toEqual([
			[0, "p0", "pending"],
			[1, "p1", "pending"],
		]);
		expect(store.listInbound({ state: "answered" })).toHaveLength(2);
	});

	test("turn failure creates exactly one notice delivery for several dispatched rows", () => {
		const store = open();
		store.ensureOrigin("o1", "/s/o1");
		for (const id of ["m1", "m2"]) {
			store.recordInbound({ originKey: "o1", platformMessageId: id, textRef: id });
			store.markDispatched(id, { opRef: "op1", entryCursor: null });
		}
		store.recordTurnFailure({
			originKey: "o1",
			opRef: "op1",
			threadRef: "t1",
			notice: "[turn failed] omp_exited code=1",
		});
		expect(store.listInbound({ state: "failed_notified" })).toHaveLength(2);
		expect(store.listDeliveries()).toHaveLength(1);
	});

	test("newEpoch bumps epoch, switches dir, discards pending of the old epoch only", () => {
		const store = open();
		store.ensureOrigin("o1", "/s/o1");
		store.recordInbound({ originKey: "o1", platformMessageId: "p", textRef: "x" });
		store.recordInbound({ originKey: "o1", platformMessageId: "d", textRef: "x" });
		store.markDispatched("d", { opRef: "op1", entryCursor: null });
		const origin = store.newEpoch("o1", "/s/o1-2");
		expect(origin).toMatchObject({ epoch: 2, sessionDir: "/s/o1-2" });
		expect(store.getInbound("p")?.state).toBe("discarded");
		expect(store.getInbound("d")?.state).toBe("dispatched");
		expect(store.recordInbound({ originKey: "o1", platformMessageId: "n", textRef: "x" }).row.epoch).toBe(2);
	});
});

describe("owner DM origin", () => {
	test("undefined before the owner ever DM'd (channel origins don't count)", () => {
		const store = open();
		store.ensureOrigin("slack/ch/C1", "/s/c1");
		expect(store.ownerDmOrigin()).toBeUndefined();
		expect(store.ownerChannel()).toBe("");
	});

	test("picks the DM origin with the latest updated_at, not the alphabetically first", () => {
		const store = open();
		store.ensureOrigin("slack/dm/AOLD", "/s/old");
		clock.advance(10);
		store.ensureOrigin("slack/dm/BNEW", "/s/new");
		expect(store.ownerDmOrigin()).toBe("slack/dm/BNEW");
		// A /new on the older origin makes it the live one again.
		clock.advance(10);
		store.newEpoch("slack/dm/AOLD", "/s/old-2");
		expect(store.ownerDmOrigin()).toBe("slack/dm/AOLD");
	});

	test("ownerChannel() resolves from the same origin (one selection rule)", () => {
		const store = open();
		store.ensureOrigin("slack/dm/AOLD", "/s/old");
		clock.advance(10);
		store.ensureOrigin("slack/dm/BNEW", "/s/new");
		expect(store.ownerChannel()).toBe("BNEW");
	});
});

describe("teams_qa", () => {
	test("a guest question and its answer are stored masked, and read back masked", () => {
		const store = open();
		const id = store.recordTeamsQuestion({ alias: "t1", askerAad: "aad-1", question: "토큰 xoxb-TEST-0 왜 안 돼?" });
		store.recordTeamsAnswer(id, "xoxb-TEST-0 는 붙여 넣지 마세요");
		expect(store.teamsQaContext("t1", 5)).toEqual([
			{ askerName: undefined, question: "토큰 [REDACTED] 왜 안 돼?", answer: "[REDACTED] 는 붙여 넣지 마세요" },
		]);
	});
});

describe("answer transaction", () => {
	test("exception between answered and delivery rows rolls both back", () => {
		const store = open({
			afterInboundAnswered: () => {
				throw new Error("boom");
			},
		});
		store.ensureOrigin("o1", "/s/o1");
		store.recordInbound({ originKey: "o1", platformMessageId: "m1", textRef: "x" });
		store.markDispatched("m1", { opRef: "op1", entryCursor: null });
		expect(() => store.recordAnswer({ originKey: "o1", opRef: "op1", threadRef: "t", parts: ["a"] })).toThrow("boom");
		expect(store.getInbound("m1")?.state).toBe("dispatched");
		expect(store.listDeliveries()).toHaveLength(0);
	});

	test("exception while storing a later part rolls back earlier parts and the answered state", () => {
		let calls = 0;
		const store = openStore({
			timezone: "Asia/Seoul",
			path: dbPath,
			clock,
			redact: (s) => {
				if (++calls > 2) throw new Error("redact failed");
				return s;
			},
		});
		opened.push(store);
		store.ensureOrigin("o1", "/s/o1");
		store.recordInbound({ originKey: "o1", platformMessageId: "m1", textRef: "x" }); // redact call 1
		store.markDispatched("m1", { opRef: "op1", entryCursor: null });
		// part 0 consumes redact call 2, part 1 throws
		expect(() => store.recordAnswer({ originKey: "o1", opRef: "op1", threadRef: "t", parts: ["a", "b"] })).toThrow(
			"redact failed",
		);
		expect(store.getInbound("m1")?.state).toBe("dispatched");
		expect(store.listDeliveries()).toHaveLength(0);
	});

	test("re-recording the same op/part is idempotent (UNIQUE origin_key, op_ref, part)", () => {
		const store = open();
		store.ensureOrigin("o1", "/s/o1");
		const first = store.recordAnswer({ originKey: "o1", opRef: "op1", threadRef: "t", parts: ["a"] });
		const second = store.recordAnswer({ originKey: "o1", opRef: "op1", threadRef: "t", parts: ["changed"] });
		expect(store.listDeliveries()).toHaveLength(1);
		expect(second[0]?.deliveryId).toBe(first[0]?.deliveryId);
		expect(second[0]?.body).toBe("a");
	});

	test("bodies and error strings pass through the injected redactor", () => {
		const store = open();
		store.ensureOrigin("o1", "/s/o1");
		const [row] = store.recordAnswer({ originKey: "o1", opRef: "op1", threadRef: "t", parts: ["tok xoxb-TEST-0 end"] });
		expect(row?.body).toBe("tok [REDACTED] end");
		const [claimed] = store.claimDue();
		if (!claimed) throw new Error("not claimed");
		expect(store.failDelivery(claimed.deliveryId, "failed with xoxb-TEST-0").lastError).toBe("failed with [REDACTED]");
	});
});

describe("delivery backoff, expiry, ambiguity", () => {
	test("backoff doubles from 2s and caps at 5 minutes", () => {
		expect([1, 2, 3, 4].map(backoffMs)).toEqual([2000, 4000, 8000, 16000]);
		expect(backoffMs(8)).toBe(256_000);
		expect(backoffMs(9)).toBe(BACKOFF_CAP_MS);
		expect(backoffMs(30)).toBe(BACKOFF_CAP_MS);
	});

	test("definitive failures schedule next_at by backoff; claimDue honours next_at; 5th failure expires", () => {
		const store = open();
		const id = seedDelivery(store);
		for (const [i, delay] of [2000, 4000, 8000, 16000].entries()) {
			expect(store.claimDue().map((r) => r.deliveryId)).toEqual([id]);
			const row = store.failDelivery(id, "e");
			expect(row).toMatchObject({ state: "pending", attempts: i + 1, nextAt: clock.t + delay });
			clock.advance(delay - 1);
			expect(store.claimDue()).toHaveLength(0); // not due yet
			clock.advance(1);
		}
		expect(store.claimDue()).toHaveLength(1);
		expect(store.failDelivery(id, "e")).toMatchObject({ state: "expired", attempts: 5 });
		clock.advance(BACKOFF_CAP_MS);
		expect(store.claimDue()).toHaveLength(0);
	});

	test("confirmed is terminal", () => {
		const store = open();
		const id = seedDelivery(store);
		store.claimDue();
		expect(store.confirmDelivery(id).state).toBe("confirmed");
		expect(() => store.failDelivery(id, "e")).toThrow(StoreError);
		expect(() => store.confirmDelivery(id)).toThrow(StoreError);
	});

	test("pending rows expire at exactly 24h and are never claimed after", () => {
		const store = open();
		const id = seedDelivery(store);
		clock.advance(FRESHNESS_MS - 1);
		expect(store.sweepExpired()).toBe(0);
		clock.advance(1);
		expect(store.claimDue()).toHaveLength(0);
		expect(store.getDelivery(id)?.state).toBe("expired");
	});

	test("a definitive failure after 24h expires instead of retrying", () => {
		const store = open();
		const id = seedDelivery(store);
		store.claimDue();
		clock.advance(FRESHNESS_MS);
		expect(store.failDelivery(id, "e")).toMatchObject({ state: "expired", attempts: 1 });
	});

	test("a rate-limit deferral keeps attempts and waits for the block; past 24h it expires", () => {
		const store = open();
		const id = seedDelivery(store);
		for (let i = 0; i < 7; i++) {
			expect(store.claimDue().map((r) => r.deliveryId)).toEqual([id]);
			const row = store.deferDelivery(id, "429", { at: clock.t + 30_000, sentParts: 1, replyTs: "1.1" });
			expect(row).toMatchObject({
				state: "pending",
				attempts: 0,
				nextAt: clock.t + 30_000,
				sentParts: 1,
				replyTs: "1.1",
			});
			clock.advance(29_999);
			expect(store.claimDue()).toHaveLength(0);
			clock.advance(1);
		}
		store.claimDue();
		clock.advance(FRESHNESS_MS);
		expect(store.deferDelivery(id, "429", { at: clock.t + 30_000, sentParts: 1 })).toMatchObject({
			state: "expired",
			attempts: 0,
		});
	});

	test("failed_ambiguous is sticky: more failures, claims, sweeps and 48h do not move it", () => {
		const store = open();
		const id = seedDelivery(store);
		store.claimDue();
		expect(store.markAmbiguous(id, "timeout").state).toBe("failed_ambiguous");
		for (let i = 0; i < 7; i++) {
			expect(store.failDelivery(id, "again").state).toBe("failed_ambiguous");
		}
		clock.advance(2 * FRESHNESS_MS);
		expect(store.sweepExpired()).toBe(0);
		expect(store.claimDue()).toHaveLength(0);
		expect(store.getDelivery(id)).toMatchObject({ state: "failed_ambiguous", attempts: 0 });
		expect(store.confirmDelivery(id).state).toBe("failed_ambiguous");
	});

	test("transitionDelivery is pure and keeps ambiguous for every event", () => {
		const base: DeliveryFacts = {
			state: "failed_ambiguous",
			attempts: 99,
			nextAt: 0,
			redelivered: false,
			createdAt: 0,
		};
		for (const event of ["claim", "confirmed", "definitive_failure", "ambiguous", "expire_check", "recover"] as const) {
			expect(transitionDelivery(base, event, 10 * FRESHNESS_MS)).toBe(base);
		}
	});

	test("invalid delivery transitions throw", () => {
		const pending: DeliveryFacts = { state: "pending", attempts: 0, nextAt: 0, redelivered: false, createdAt: 0 };
		expect(() => transitionDelivery(pending, "confirmed", 0)).toThrow(StoreError);
		expect(() => transitionDelivery(pending, "ambiguous", 0)).toThrow(StoreError);
		expect(() => transitionDelivery(pending, "definitive_failure", 0)).toThrow(StoreError);
		expect(() => transitionDelivery({ ...pending, state: "inflight" }, "claim", 0)).toThrow(StoreError);
	});
});

describe("latestInboundThread", () => {
	test("latestInboundThread returns the origin's newest recorded thread", () => {
		const store = open();
		store.ensureOrigin("slack/dm/D1", "/s/d1");
		store.recordInbound({ originKey: "slack/dm/D1", platformMessageId: "D1:1", textRef: "x", threadRef: "D1:1" });
		store.recordInbound({ originKey: "slack/dm/D1", platformMessageId: "D1:2", textRef: "y", threadRef: "D1:9" });
		expect(store.latestInboundThread("slack/dm/D1")).toBe("D1:9");
		expect(store.latestInboundThread("slack/dm/DX")).toBeUndefined();
	});
});

describe("backfill thread targets", () => {
	test("top-level posts (`<C>:-`: slash answers, log copies) are never thread targets", () => {
		const store = openStore({ timezone: "Asia/Seoul", path: dbPath, clock, redact: maskTest, logChannel: "CLOG" });
		opened.push(store);
		store.ensureOrigin("slack/ch/C1", "/s/c1");
		// A completion answer in a thread also writes its log-channel copy on `CLOG:-`.
		store.recordAnswer({ originKey: "slack/ch/C1", opRef: "op1", threadRef: "C1:1.1", parts: ["✅ 완료 · done"] });
		store.recordAnswer({ originKey: "slack/ch/C1", opRef: "new:slash:C1:x", threadRef: "C1:-", parts: ["🆕"] });
		expect(store.listSlackThreadTargets(0, 200)).toEqual([{ channel: "C1", rootTs: "1.1" }]);
	});
});

describe("reopen", () => {
	test("inflight rows are re-queued with redelivered=1 when the DB file is reopened", () => {
		const first = open();
		const id = seedDelivery(first);
		expect(first.claimDue()).toHaveLength(1);
		expect(first.getDelivery(id)).toMatchObject({ state: "inflight", redelivered: false });
		first.close();

		const second = open();
		expect(second.recoveredInflight).toBe(1);
		const [again] = second.claimDue();
		expect(again).toMatchObject({ deliveryId: id, state: "inflight", redelivered: true });
	});

	test("reopen leaves pending, confirmed and ambiguous rows alone", () => {
		const first = open();
		const a = seedDelivery(first, "a");
		const b = seedDelivery(first, "b");
		const c = seedDelivery(first, "c");
		first.claimDue();
		first.confirmDelivery(a);
		first.markAmbiguous(b, "t");
		first.close();
		const second = open();
		expect(second.recoveredInflight).toBe(1); // only c
		expect(second.getDelivery(a)?.state).toBe("confirmed");
		expect(second.getDelivery(b)).toMatchObject({ state: "failed_ambiguous", redelivered: false });
		expect(second.getDelivery(c)).toMatchObject({ state: "pending", redelivered: true });
	});

	test("data survives reopen and WAL is enabled", () => {
		const first = open();
		first.ensureOrigin("o1", "/s/o1");
		first.recordInbound({ originKey: "o1", platformMessageId: "m1", textRef: "x" });
		first.close();
		const second = open();
		expect(second.getInbound("m1")?.state).toBe("pending");
		expect(second.getOrigin("o1")?.epoch).toBe(1);
	});
});

/**
 * Fable audit batch 2 (OPT-04·05·06·30·35): each hot query is judged by its EXPLAIN QUERY PLAN, and its rows by a
 * fixed fixture. The store's own statements are captured as they run (SQL and bound parameters), so the plan judged
 * is the one the code really executes; the dashboard's queries are quoted verbatim from `dashboard/snapshot.ts`.
 */
describe("ledger query plans", () => {
	const DAY = 24 * 60 * 60_000;

	/** Plans (EXPLAIN QUERY PLAN `detail` lines joined) of every statement `call` ran through `store`'s connection. */
	function plansOf(store: Store, call: () => unknown): string[] {
		// The connection is private to Store; the judge must watch that very connection, not a second one.
		const live = store as unknown as { db: Database };
		const db = live.db;
		const original = db.query.bind(db);
		const seen: Array<{ sql: string; args: unknown[] }> = [];
		Object.assign(db, {
			query: (sql: string) => {
				const statement = original(sql);
				return new Proxy(statement, {
					get(target, property) {
						const value = Reflect.get(target, property);
						if (property !== "all" && property !== "get") {
							return typeof value === "function" ? value.bind(target) : value;
						}
						return (...args: unknown[]) => {
							seen.push({ sql, args });
							return (value as (...a: unknown[]) => unknown).apply(target, args);
						};
					},
				});
			},
		});
		try {
			call();
		} finally {
			delete (db as unknown as Record<string, unknown>).query;
		}
		return seen.map(({ sql, args }) => planOf(db, sql, args));
	}

	function planOf(db: Database, sql: string, args: unknown[] = []): string {
		const rows = db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as [])) as Array<{ detail: string }>;
		return rows.map((row) => row.detail).join("\n");
	}

	function rawDb(): Database {
		const db = new Database(dbPath, { strict: true });
		opened.push({ close: () => db.close() } as unknown as Store);
		return db;
	}

	test("OPT-04 listInbound: filtered reads search an index, only the unfiltered read scans", () => {
		const store = open();
		store.ensureOrigin("o1", "/s/o1");
		store.ensureOrigin("o2", "/s/o2");
		store.recordInbound({ originKey: "o1", platformMessageId: "m1", textRef: "a" });
		store.recordInbound({ originKey: "o1", platformMessageId: "m2", textRef: "b" });
		store.recordInbound({ originKey: "o2", platformMessageId: "m3", textRef: "c" });
		store.markDispatched("m2", { opRef: "op1", entryCursor: null });
		const ids = (filter: Parameters<Store["listInbound"]>[0]) =>
			store.listInbound(filter).map((row) => row.platformMessageId);
		expect(ids({})).toEqual(["m1", "m2", "m3"]);
		expect(ids({ state: "pending" })).toEqual(["m1", "m3"]);
		expect(ids({ originKey: "o1" })).toEqual(["m1", "m2"]);
		expect(ids({ originKey: "o1", state: "pending" })).toEqual(["m1"]);
		expect(ids({ originKey: "o2", state: "dispatched" })).toEqual([]);
		const filters: Array<Parameters<Store["listInbound"]>[0]> = [
			{ state: "pending" },
			{ originKey: "o1" },
			{ originKey: "o1", state: "pending" },
		];
		for (const filter of filters) {
			const plans = plansOf(store, () => store.listInbound(filter));
			expect(plans).toHaveLength(1);
			expect(plans[0]).not.toContain("SCAN inbound");
		}
	});

	test("OPT-05 turnDurationSamples: the 30-day window is a WHERE bound on dispatched_at, same samples at the edge", () => {
		clock.t = 200 * DAY;
		const store = open();
		const raw = rawDb();
		const key = "slack/dm/D1";
		store.ensureOrigin(key, "/s/d1");
		let seq = 0;
		const turn = (dispatchedAt: number, ms: number) => {
			const opRef = `op${++seq}`;
			raw
				.query(
					"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at, op_ref) VALUES (?, ?, 1, 'x', 'answered', ?, ?, ?)",
				)
				.run(`m${seq}`, key, dispatchedAt - 10, dispatchedAt, opRef);
			raw
				.query(
					"INSERT INTO deliveries (origin_key, op_ref, part, thread_ref, body, state, next_at, created_at) VALUES (?, ?, 0, 'T', 'b', 'confirmed', 0, ?)",
				)
				.run(key, opRef, dispatchedAt + ms);
		};
		turn(clock.t - 31 * DAY, 1000);
		turn(clock.t - 29 * DAY, 7000);
		turn(clock.t - DAY, 3000);
		expect(store.turnDurationSamples(key)).toEqual([3000, 7000]);
		expect(store.turnDurationSamples()).toEqual([3000, 7000]);
		const [plan] = plansOf(store, () => store.turnDurationSamples());
		expect(plan).toMatch(/SEARCH i USING INDEX \S+ \([^)]*dispatched_at>\?\)/);
	});

	test("OPT-06 turn board: a thread's newest and oldest rows come off an index, no temp sort", () => {
		const store = open();
		store.ensureOrigin("slack/ch/C1/t/1.1", "/s/t");
		for (let i = 0; i < 5; i += 1) {
			clock.advance(1000);
			store.recordInbound({ originKey: "slack/ch/C1/t/1.1", platformMessageId: `m${i}`, textRef: "x" });
		}
		const raw = rawDb();
		const columns = `inbound_id, platform_message_id, origin_key, text_ref, thread_ref, state, created_at,
				dispatched_at, last_event_at`;
		// dashboard/snapshot.ts: the board thread's `recent` and `first` reads.
		const recent = `SELECT ${columns} FROM inbound WHERE origin_key = ? ORDER BY created_at DESC, inbound_id DESC LIMIT ?`;
		const first = `SELECT ${columns} FROM inbound WHERE origin_key = ? ORDER BY created_at, inbound_id LIMIT 1`;
		expect(planOf(raw, recent, ["slack/ch/C1/t/1.1", 3])).not.toContain("USE TEMP B-TREE FOR ORDER BY");
		expect(planOf(raw, first, ["slack/ch/C1/t/1.1"])).not.toContain("USE TEMP B-TREE FOR ORDER BY");
		const rows = raw.query(recent).all("slack/ch/C1/t/1.1", 3) as Array<{ platform_message_id: string }>;
		expect(rows.map((row) => row.platform_message_id)).toEqual(["m4", "m3", "m2"]);
	});

	test("OPT-30 recall candidates: the 90-day window reads inbound through an index, same rows", () => {
		clock.t = 200 * DAY;
		const store = open();
		const raw = rawDb();
		store.ensureOrigin("slack/ch/C1/t/1.1", "/s/t1");
		store.ensureOrigin("slack/ch/C1/t/2.2", "/s/t2");
		raw
			.query(
				"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, created_at, thread_ref) VALUES ('old', 'slack/ch/C1/t/1.1', 1, '오래된 질문', ?, 'C1:1.1')",
			)
			.run(clock.t - 91 * DAY);
		raw
			.query(
				"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, created_at, thread_ref) VALUES ('new', 'slack/ch/C1/t/2.2', 1, '최근 질문', ?, 'C1:2.2')",
			)
			.run(clock.t - 89 * DAY);
		expect(store.listRecallCandidates("C1", "C1:9.9", 50).map((c) => c.text)).toEqual(["최근 질문"]);
		const [plan] = plansOf(store, () => store.listRecallCandidates("C1", "C1:9.9", 50));
		expect(plan).toContain("inbound");
		expect(plan).not.toContain("SCAN inbound");
	});

	test("interimBodies: the op prefix is an index range on op_ref, only that op's interims", () => {
		const store = open();
		store.ensureOrigin("o1", "/s/o1");
		store.recordInterim({ originKey: "o1", opRef: "op1", threadRef: "t", index: 0, body: "first" });
		store.recordInterim({ originKey: "o1", opRef: "op10", threadRef: "t", index: 0, body: "other op" });
		store.recordInterim({ originKey: "o1", opRef: "op1", threadRef: "t", index: 1, body: "second" });
		store.recordAnswer({ originKey: "o1", opRef: "op1", threadRef: "t", parts: ["final"] });
		expect(store.interimBodies("o1", "op1")).toEqual(["first", "second"]);
		expect(store.interimBodies("o1", "op10")).toEqual(["other op"]);
		const [plan] = plansOf(store, () => store.interimBodies("o1", "op1"));
		expect(plan).toMatch(/SEARCH deliveries USING INDEX \S+ \(origin_key=\? AND op_ref>\? AND op_ref<\?\)/);
	});

	test("OPT-35 monitor_events: a monitor's newest events come off an index, no temp sort", () => {
		open();
		const raw = rawDb();
		// dashboard/snapshot.ts and dashboard/monitor-detail.ts: a monitor's latest-events strip.
		const sql =
			"SELECT stage, slot_at, updated_at, attempts, manual FROM monitor_events WHERE monitor_id = ? ORDER BY event_id DESC LIMIT ?";
		expect(planOf(raw, sql, ["m1", 7])).not.toContain("TEMP B-TREE");
	});
});
