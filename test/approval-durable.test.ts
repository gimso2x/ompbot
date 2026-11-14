import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/log";
import { redact } from "../src/redact";
import { ApprovalBroker, type ApprovalStore, type ApprovalTimers } from "../src/safety/approval";
import { SlackChannel } from "../src/slack/channel";
import type { SlackTransport } from "../src/slack/transport";
import { openStore, type Store } from "../src/store/db";
import { hasButtons } from "./helpers/bot-home";
import { registryOf } from "./helpers/channels";
import { FakeSlackTransport } from "./helpers/slack-fake-transport";

let dir: string;
let store: Store;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-approval-durable-"));
	store = openStore({ timezone: "Asia/Seoul", path: join(dir, "ompbot.db"), clock: { now: () => 1_000 }, redact });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const quietLog = () => createLogger({ sink: () => undefined, clock: { now: () => 0 }, redact });
const OWNER = "UOWNER";

/** Resolves `shown` when the buttons go up and `finalized` when a card update removes them. */
class CardTransport extends FakeSlackTransport {
	readonly shown = Promise.withResolvers<{ ts: string; blocks: readonly unknown[] }>();
	readonly finalized = Promise.withResolvers<{ text: string; blocks: readonly unknown[] | undefined }>();

	override async updateMessage(args: {
		channel: string;
		ts: string;
		text: string;
		blocks?: readonly unknown[] | undefined;
	}): Promise<void> {
		await super.updateMessage(args);
		if (args.blocks !== undefined && hasButtons(args.blocks)) this.shown.resolve({ ts: args.ts, blocks: args.blocks });
		else this.finalized.resolve({ text: args.text, blocks: args.blocks });
	}
}

class ManualTimers implements ApprovalTimers {
	readonly callbacks = new Map<number, () => void>();
	#next = 1;
	set(fn: () => void): unknown {
		const id = this.#next++;
		this.callbacks.set(id, fn);
		return id;
	}
	clear(handle: unknown): void {
		this.callbacks.delete(handle as number);
	}
	fireAll(): void {
		for (const fn of [...this.callbacks.values()]) fn();
	}
}

function makeBroker(transport: SlackTransport, timers: ApprovalTimers, now: () => number): ApprovalBroker {
	return new ApprovalBroker({
		timezone: "Asia/Seoul",
		channels: registryOf(new SlackChannel(transport)),
		ownerUserId: OWNER,
		log: quietLog(),
		store: store as unknown as ApprovalStore,
		clock: { now },
		timers,
	});
}

describe("durable approvals", () => {
	test("the ledger row is the double-click authority", () => {
		store.createApproval({
			approvalId: "D1:1.1",
			channel: "D1",
			messageTs: "1.1",
			summary: "s",
			createdAt: 1_000,
			expiresAt: 61_000,
		});
		expect(store.decideApproval("D1:1.1", "approved", 2_000)).toBe(true);
		expect(store.decideApproval("D1:1.1", "denied", 2_001)).toBe(false);
	});

	test("the origin mapping is stored and a reply settles a pending row once, never a due or decided one", () => {
		store.createApproval({
			approvalId: "C1:1.1",
			channel: "C1",
			messageTs: "1.1",
			summary: "s",
			createdAt: 1_000,
			expiresAt: 61_000,
			originKey: "slack/dm/D1",
			originThreadRef: "D1:9.9",
		});
		expect(store.getApproval("C1:1.1")).toMatchObject({
			originKey: "slack/dm/D1",
			originThreadRef: "D1:9.9",
			status: "pending",
		});
		expect(store.replyApproval("C1:1.1", "2.2", "go", 2_000)).toBe(true);
		expect(store.replyApproval("C1:1.1", "3.3", "again", 2_001)).toBe(false);
		expect(store.decideApproval("C1:1.1", "approved", 2_002)).toBe(false);
		expect(store.getApproval("C1:1.1")).toMatchObject({ status: "replied", replyTs: "2.2", replyText: "go" });
		store.createApproval({
			approvalId: "C1:4.4",
			channel: "C1",
			messageTs: "4.4",
			summary: "s",
			createdAt: 1_000,
			expiresAt: 5_000,
		});
		expect(store.replyApproval("C1:4.4", "5.5", "late", 5_000)).toBe(false);
	});

	test("an approvals table from before the mapping is rebuilt in place; old rows keep working", () => {
		const path = join(dir, "old.db");
		const old = new Database(path);
		old.run(
			`CREATE TABLE approvals (approval_id TEXT PRIMARY KEY, channel TEXT NOT NULL, message_ts TEXT NOT NULL, summary TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','expired')),
				created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_at INTEGER)`,
		);
		old.run("INSERT INTO approvals VALUES ('D1:1.1','D1','1.1','old card','approved',1000,2000,1500)");
		old.run("INSERT INTO approvals VALUES ('D1:2.2','D1','2.2','pending card','pending',1000,90000,NULL)");
		old.close();
		const migrated = openStore({ timezone: "Asia/Seoul", path, clock: { now: () => 1_000 }, redact });
		expect(migrated.getApproval("D1:1.1")).toMatchObject({ status: "approved", originKey: null, replyTs: null });
		expect(migrated.replyApproval("D1:2.2", "3.3", "ok", 2_000)).toBe(true);
		expect(migrated.getApproval("D1:2.2")?.status).toBe("replied");
		migrated.close();
		// Opening again is a no-op (the CHECK already allows `replied`).
		const again = openStore({ timezone: "Asia/Seoul", path, clock: { now: () => 1_000 }, redact });
		expect(again.getApproval("D1:2.2")?.status).toBe("replied");
		again.close();
	});

	test("expirePendingApprovals only expires due rows unless forced", () => {
		store.createApproval({
			approvalId: "D1:1.1",
			channel: "D1",
			messageTs: "1.1",
			summary: "s",
			createdAt: 1_000,
			expiresAt: 2_000,
		});
		store.createApproval({
			approvalId: "D1:2.2",
			channel: "D1",
			messageTs: "2.2",
			summary: "s",
			createdAt: 1_000,
			expiresAt: 90_000,
		});
		expect(store.expirePendingApprovals(5_000).map((row) => row.approvalId)).toEqual(["D1:1.1"]);
		const forced = store.expirePendingApprovals(5_000, false);
		// The due sweep already expired 1.1; the forced pass takes the remaining pending row.
		expect(forced.map((row) => row.approvalId)).toEqual(["D1:2.2"]);
		expect(store.decideApproval("D1:2.2", "approved", 5_001)).toBe(false);
	});

	test("a restart expires every pending card and says so on them", async () => {
		const transport = new CardTransport();
		const timers = new ManualTimers();
		const broker1 = makeBroker(transport, timers, () => 1_000);
		void broker1.request("D1", "git push --force");
		const { ts } = await transport.shown.promise;

		// New broker over the same ledger (the old process is gone): the boot sweep expires and relabels the card.
		const expired = await makeBroker(transport, timers, () => 2_000).expireStale(false);
		expect(expired).toBe(1);
		const final = await transport.finalized.promise;
		expect(final.text).toContain("재시작으로 만료됨");
		expect(final.blocks).toEqual([]);
		// The stale waiter cannot be granted anything anymore.
		expect(store.decideApproval(`D1:${ts}`, "approved", 3_000)).toBe(false);
	});

	test("a timed-out request lands as expired in the ledger", async () => {
		const transport = new CardTransport();
		const timers = new ManualTimers();
		const broker = makeBroker(transport, timers, () => 1_000);
		const done = broker.request("D1", "s");
		const { ts } = await transport.shown.promise;
		timers.fireAll();
		expect(await done).toBe("timeout");
		await transport.finalized.promise;
		expect(store.decideApproval(`D1:${ts}`, "approved", 2_000)).toBe(false);
	});

	test("an aborted wait (daemon restart, stopped turn) lands as expired and its card does not read as a denial", async () => {
		const transport = new CardTransport();
		const timers = new ManualTimers();
		const abort = new AbortController();
		const done = makeBroker(transport, timers, () => 1_000).ask("D1", "git push", { signal: abort.signal });
		const { ts } = await transport.shown.promise;
		abort.abort();
		expect(await done).toBe("denied");
		expect(store.getApproval(`D1:${ts}`)?.status).toBe("expired");
		const final = await transport.finalized.promise;
		expect(final.text).not.toContain("⛔ 거부됨");
		// The buttons are gone; the card keeps its title and shows the abort as its result line.
		expect(hasButtons(final.blocks)).toBe(false);
		expect(JSON.stringify(final.blocks)).toContain("기다리던 작업이 중단돼 만료됨");
	});

	test("a ledger without the detail and link columns gains them; old rows stay and a second open is a no-op", () => {
		const path = join(dir, "pre-detail.db");
		const old = new Database(path);
		old.run(
			`CREATE TABLE approvals (approval_id TEXT PRIMARY KEY, channel TEXT NOT NULL, message_ts TEXT NOT NULL, summary TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','expired','replied')),
				created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_at INTEGER, origin_key TEXT,
				origin_thread_ref TEXT, reply_ts TEXT, reply_text TEXT)`,
		);
		old.run(
			"INSERT INTO approvals (approval_id, channel, message_ts, summary, status, created_at, expires_at, origin_key) VALUES ('C1:1.1','C1','1.1','old card','pending',1000,90000,'slack/dm/D1')",
		);
		old.close();
		for (let open = 0; open < 2; open++) {
			const migrated = openStore({ timezone: "Asia/Seoul", path, clock: { now: () => 1_000 }, redact });
			expect(migrated.getApproval("C1:1.1")).toMatchObject({ status: "pending", originKey: "slack/dm/D1" });
			migrated.close();
		}
		const check = new Database(path, { readonly: true });
		const names = (check.query("PRAGMA table_info(approvals)").all() as Array<{ name: string }>).map((c) => c.name);
		expect(names).toEqual(expect.arrayContaining(["detail_json", "card_url", "origin_url"]));
		expect(check.query("SELECT summary, detail_json, card_url, origin_url FROM approvals").all()).toEqual([
			{ summary: "old card", detail_json: null, card_url: null, origin_url: null },
		]);
		check.close();
	});

	/** The raw ledger row of one card: what the dashboard reads. */
	const rawRow = (id: string): { detail_json: string | null; card_url: string | null; origin_url: string | null } => {
		const db = new Database(join(dir, "ompbot.db"), { readonly: true });
		try {
			return db.query("SELECT detail_json, card_url, origin_url FROM approvals WHERE approval_id = ?").get(id) as {
				detail_json: string | null;
				card_url: string | null;
				origin_url: string | null;
			};
		} finally {
			db.close();
		}
	};

	test("ask stores the card's own redacted, cut detail; detail-less ask and request store NULL", async () => {
		const transport = new CardTransport();
		const timers = new ManualTimers();
		const long = `rm -rf /srv/build ${"x".repeat(500)}`;
		const done = makeBroker(transport, timers, () => 1_000).ask("D1", "clean build", {
			detail: {
				action: long,
				why: "token xoxb-TEST-0 leaked",
				impact: "key sk-TESTKEY123 rotates",
				rollback: "deleted files are gone",
			},
		});
		const { ts } = await transport.shown.promise;
		const stored = JSON.parse(rawRow(`D1:${ts}`).detail_json ?? "null") as Record<string, string>;
		expect(Object.keys(stored)).toEqual(["action", "why", "impact", "rollback"]);
		expect(stored.action).toBe(long.slice(0, 400));
		expect(stored.why).toBe("token [REDACTED] leaked");
		expect(stored.impact).toBe("key [REDACTED] rotates");
		const card = transport.calls.find((call) => call.method === "postMessage");
		const cardText = card?.method === "postMessage" ? card.text : "";
		for (const [label, key] of [
			["할 일", "action"],
			["이유", "why"],
			["영향", "impact"],
			["되돌릴 수 없는 이유", "rollback"],
		] as const) {
			expect(cardText).toContain(`• ${label}: ${stored[key]}`);
		}
		timers.fireAll();
		expect(await done).toBe("timeout");
		const raw = new Database(join(dir, "ompbot.db"), { readonly: true });
		const dump = JSON.stringify(raw.query("SELECT * FROM approvals").all());
		raw.close();
		expect(dump).not.toContain("xoxb-");
		expect(dump).not.toContain("sk-");

		for (const [channel, start] of [
			["D2", (broker: ApprovalBroker) => broker.ask("D2", "plain ask", { detail: { action: "  " } })],
			["D3", (broker: ApprovalBroker) => broker.request("D3", "plain request")],
		] as const) {
			const next = new CardTransport();
			const nextTimers = new ManualTimers();
			const pending = start(makeBroker(next, nextTimers, () => 1_000));
			const shown = await next.shown.promise;
			expect(rawRow(`${channel}:${shown.ts}`).detail_json).toBeNull();
			nextTimers.fireAll();
			await pending;
		}
	});

	test("ask stores the card and asking-thread permalinks; a throwing permalink leaves NULLs and the decision intact", async () => {
		const transport = new CardTransport();
		const timers = new ManualTimers();
		const broker = makeBroker(transport, timers, () => 1_000);
		const done = broker.ask("C9", "deploy", {
			origin: { originKey: "slack/ch/C9/t/7.7", channel: "C9", threadTs: "7.7" },
		});
		const { ts } = await transport.shown.promise;
		expect(rawRow(`C9:${ts}`)).toEqual({
			detail_json: null,
			card_url: `https://slack.test/archives/C9/p${ts.replace(".", "")}`,
			origin_url: "https://slack.test/archives/C9/p77",
		});
		expect(broker.handleAction({ actionId: `ompbot:approval:approve:C9:${ts}`, userId: OWNER })).toBe(true);
		expect(await done).toBe("approved");

		// A fresh fake transport restarts its ts sequence, so each round asks in its own channel.
		for (const [channel, decision, outcome] of [
			["C7", "approve", "approved"],
			["C8", "deny", "denied"],
		] as const) {
			const failing = new CardTransport();
			failing.failNext.getPermalink = [new Error("slack down"), new Error("slack down")];
			const failingBroker = makeBroker(failing, new ManualTimers(), () => 1_000);
			const pending = failingBroker.ask(channel, "deploy", {
				origin: { originKey: `slack/ch/${channel}/t/7.7`, channel, threadTs: "7.7" },
			});
			const shown = await failing.shown.promise;
			expect(failing.count("getPermalink")).toBe(2);
			expect(rawRow(`${channel}:${shown.ts}`)).toEqual({ detail_json: null, card_url: null, origin_url: null });
			expect(
				failingBroker.handleAction({ actionId: `ompbot:approval:${decision}:${channel}:${shown.ts}`, userId: OWNER }),
			).toBe(true);
			expect(await pending).toBe(outcome);
			expect(store.getApproval(`${channel}:${shown.ts}`)?.status).toBe(outcome);
		}
	});

	test("a ledger that throws on the click fails closed: approve is refused, deny still settles", async () => {
		const transport = new CardTransport();
		const broker = makeBroker(transport, new ManualTimers(), () => 1_000);
		const done = broker.request("D1", "git push --force");
		const { ts } = await transport.shown.promise;
		store.decideApproval = () => {
			throw new Error("database is locked");
		};
		expect(broker.handleAction({ actionId: `ompbot:approval:approve:D1:${ts}`, userId: OWNER })).toBe(false);
		expect(broker.handleAction({ actionId: `ompbot:approval:deny:D1:${ts}`, userId: OWNER })).toBe(true);
		expect(await done).toBe("denied");
	});

	test("the buttons show the default 30-minute deadline in the owner's time zone", async () => {
		const transport = new CardTransport();
		const timers = new ManualTimers();
		const askedAt = Date.parse("2026-10-27T00:03:00+09:00");
		const done = makeBroker(transport, timers, () => askedAt).request("D1", "git push");
		const { blocks } = await transport.shown.promise;
		expect(JSON.stringify(blocks)).toContain("00:33");
		timers.fireAll();
		expect(await done).toBe("timeout");
	});
});
