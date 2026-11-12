import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeliverySource } from "../src/channel/types";
import { Daemon } from "../src/daemon/daemon";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { SlackAdapter } from "../src/slack/adapter";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import type { SlackReactionEvent } from "../src/slack/transport";
import { openStore, type Store } from "../src/store/db";
import { readTurnVerdicts } from "../src/store/feedback";
import { makeHome, OWNER, type TestHome, WaitingTransport } from "./helpers/bot-home";
import { FakeSlackTransport } from "./helpers/slack-fake-transport";

const clock = { now: () => Date.now() };

describe("owner reaction on a bot answer → turn feedback (daemon)", () => {
	let home: TestHome;
	let daemon: Daemon | undefined;

	beforeEach(() => {
		home = makeHome("ompbot-feedback-");
	});

	afterEach(async () => {
		await daemon?.stop();
		daemon = undefined;
		home.remove();
	});

	test("AC-1: +1 on the second message of a two-part answer records one 'up' row for that delivery's turn", async () => {
		const transport = new WaitingTransport();
		const sent = Promise.withResolvers<void>();
		const log = createLogger({
			sink: (line) => {
				if (line.includes("event=delivery_sent")) sent.resolve();
			},
			clock,
			redact,
		});
		const sessions = new FakeSessionStore();
		daemon = new Daemon({
			config: home.config,
			channels: [new SlackBinding(new SlackChannel(transport))],
			log,
			ompVersion: "omp-test 0",
			bootId: "kernel-boot-id",
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		await daemon.start();
		// The echo of this text is over one Slack message: the answer goes out as two parts in the marker's thread.
		const body = Array.from({ length: 1_600 }, (_, i) => `lorem${i}`).join(" ");
		await daemon.inject({ origin: "slack/dm/D1", asOwner: true, text: `feedback test\n${body}` });
		await sent.promise;
		const parts = transport.posts((text) => text.includes("lorem"));
		expect(parts).toHaveLength(2);
		const second = parts[1];
		if (second === undefined) throw new Error("no second part");

		await transport.emitReaction({
			type: "reaction_added",
			user: OWNER,
			reaction: "+1",
			item: { type: "message", channel: "D1", ts: second.ts },
			event_ts: "1800000100.000001",
		});

		const [delivery] = daemon.store.listDeliveries({ originKey: "slack/dm/D1" });
		const db = new Database(join(home.dir, "ompbot.db"), { readonly: true, strict: true });
		try {
			const inbound = db
				.query("SELECT MIN(inbound_id) AS id FROM inbound WHERE origin_key = ? AND op_ref = ?")
				.get("slack/dm/D1", delivery?.opRef ?? "") as { id: number | null };
			expect(inbound.id).not.toBeNull();
			expect(db.query("SELECT * FROM turn_feedback").all()).toEqual([
				{
					channel: "D1",
					ts: second.ts,
					delivery_id: delivery?.deliveryId,
					origin_key: "slack/dm/D1",
					op_ref: delivery?.opRef,
					inbound_id: inbound.id,
					verdict: "up",
					last_event_ts: "1800000100.000001",
					created_at: expect.any(Number),
					removed_at: null,
				},
			]);
		} finally {
			db.close();
		}
	});
});

describe("owner reactions → turn_feedback rows (adapter + store)", () => {
	const TS = "1800000000.000100";
	const ORIGIN = "slack/dm/D1";
	let dir: string;
	let store: Store;
	let transport: FakeSlackTransport;
	let logs: string[];

	/** The daemon's delivery source over the store, `recordPost` included unless `post` replaces or drops it. */
	function deliveries(post?: DeliverySource["recordPost"] | null): DeliverySource {
		return {
			claimDue: () => store.claimDue(),
			confirm: (id) => void store.confirmDelivery(id),
			fail: (id, error) => void store.failDelivery(id, error),
			defer: (id, error, retry) => void store.deferDelivery(id, error, retry),
			...(post === null ? {} : { recordPost: post ?? ((p) => store.feedback.recordPost(p)) }),
			recordFeedback: (feedback) => void store.feedback.applyReaction(feedback),
		};
	}

	async function adapterWith(source: DeliverySource): Promise<SlackAdapter> {
		const adapter = new SlackAdapter({
			transport,
			core: { onInbound: () => undefined, onCommand: () => undefined, onAction: () => undefined },
			deliveries: source,
			ownerUserId: OWNER,
			clock,
			log: createLogger({ sink: (line) => logs.push(line), clock, redact }),
		});
		await adapter.start();
		return adapter;
	}

	/** Sends one answer of `body` for op `op1` and returns the ts of every Slack message it posted. */
	async function deliver(adapter: SlackAdapter, body: string): Promise<string[]> {
		const before = transport.count("postMessage");
		store.ensureOrigin(ORIGIN, join(dir, "sessions"));
		store.recordInbound({ originKey: ORIGIN, platformMessageId: `D1:${TS}`, textRef: "질문", threadRef: `D1:${TS}` });
		store.markDispatched(`D1:${TS}`, { opRef: "op1", entryCursor: null });
		store.recordAnswer({ originKey: ORIGIN, opRef: "op1", threadRef: `D1:${TS}`, parts: [body] });
		expect(await adapter.pumpDeliveries()).toBe(1);
		return transport.calls.slice(before).flatMap((call) => (call.method === "postMessage" ? [call.ts] : []));
	}

	const react = (
		type: SlackReactionEvent["type"],
		reaction: string,
		ts: string,
		eventTs: string,
		user = OWNER,
	): Promise<void> =>
		transport.emitReaction({ type, user, reaction, item: { type: "message", channel: "D1", ts }, event_ts: eventTs });

	function feedbackRows(): Array<{ ts: string; verdict: string; removed_at: number | null }> {
		const db = new Database(join(dir, "bot.db"), { readonly: true, strict: true });
		try {
			return db.query("SELECT ts, verdict, removed_at FROM turn_feedback ORDER BY ts").all() as Array<{
				ts: string;
				verdict: string;
				removed_at: number | null;
			}>;
		} finally {
			db.close();
		}
	}

	function verdicts(): string[] {
		const db = new Database(join(dir, "bot.db"), { readonly: true, strict: true });
		try {
			return readTurnVerdicts(db, 0).map((turn) => turn.verdict);
		} finally {
			db.close();
		}
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ompbot-feedback-adapter-"));
		store = openStore({ timezone: "Asia/Seoul", path: join(dir, "bot.db"), clock, redact });
		transport = new FakeSlackTransport("UBOT");
		logs = [];
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("AC-2: -1 with a skin tone is 'down'; heart, another user and a message no delivery posted add no row", async () => {
		const [posted] = await deliver(await adapterWith(deliveries()), "답");
		if (posted === undefined) throw new Error("nothing posted");
		await react("reaction_added", "heart", posted, "1800000100.000001");
		await react("reaction_added", "+1", posted, "1800000100.000002", "USOMEONE");
		await react("reaction_added", "+1", TS, "1800000100.000003");
		expect(feedbackRows()).toEqual([]);

		await react("reaction_added", "-1::skin-tone-3", posted, "1800000100.000004");
		expect(feedbackRows()).toEqual([{ ts: posted, verdict: "down", removed_at: null }]);
	});

	test("AC-3: a replayed add keeps one row; a remove takes it out of the verdict; a later add brings it back", async () => {
		const [posted] = await deliver(await adapterWith(deliveries()), "답");
		if (posted === undefined) throw new Error("nothing posted");
		await react("reaction_added", "+1", posted, "999999999.000001");
		await react("reaction_added", "+1", posted, "999999999.000001");
		expect(feedbackRows()).toEqual([{ ts: posted, verdict: "up", removed_at: null }]);
		expect(verdicts()).toEqual(["up"]);

		await react("reaction_removed", "+1", posted, "999999999.500000");
		expect(feedbackRows()).toEqual([{ ts: posted, verdict: "up", removed_at: expect.any(Number) }]);
		expect(verdicts()).toEqual([]);

		// Numerically later though it sorts first as text: event_ts compares as a number.
		await react("reaction_added", "thumbsup", posted, "1000000000.000000");
		expect(feedbackRows()).toEqual([{ ts: posted, verdict: "up", removed_at: null }]);
		expect(verdicts()).toEqual(["up"]);
	});

	test("AC-3a: a remove at T2 arriving before the add at T1 < T2 leaves the message removed", async () => {
		const [posted] = await deliver(await adapterWith(deliveries()), "답");
		if (posted === undefined) throw new Error("nothing posted");
		await react("reaction_removed", "+1", posted, "1800000100.000002");
		await react("reaction_added", "+1", posted, "1800000100.000001");
		expect(feedbackRows()).toEqual([{ ts: posted, verdict: "up", removed_at: expect.any(Number) }]);
		expect(verdicts()).toEqual([]);
	});

	test("AC-3b: +1 then -1 on one message is one 'down' row, and removing the old +1 keeps it", async () => {
		const [posted] = await deliver(await adapterWith(deliveries()), "답");
		if (posted === undefined) throw new Error("nothing posted");
		await react("reaction_added", "+1", posted, "1800000100.000001");
		await react("reaction_added", "-1", posted, "1800000100.000002");
		expect(feedbackRows()).toEqual([{ ts: posted, verdict: "down", removed_at: null }]);

		await react("reaction_removed", "+1", posted, "1800000100.000003");
		expect(feedbackRows()).toEqual([{ ts: posted, verdict: "down", removed_at: null }]);
		expect(verdicts()).toEqual(["down"]);
	});

	test("AC-4: every posted message of an answer gets a delivery_posts row with its part index", async () => {
		const body = Array.from({ length: 1_600 }, (_, i) => `lorem${i}`).join(" ");
		const posted = await deliver(await adapterWith(deliveries()), body);
		expect(posted).toHaveLength(2);
		const db = new Database(join(dir, "bot.db"), { readonly: true, strict: true });
		try {
			const [delivery] = store.listDeliveries({ originKey: ORIGIN });
			expect(db.query("SELECT channel, ts, delivery_id, part FROM delivery_posts ORDER BY part").all()).toEqual(
				posted.map((ts, part) => ({ channel: "D1", ts, delivery_id: delivery?.deliveryId, part })),
			);
		} finally {
			db.close();
		}
	});

	test("AC-4: a throwing recordPost logs delivery_post_record_failed once and the answer is still confirmed", async () => {
		const posted = await deliver(
			await adapterWith(
				deliveries(() => {
					throw new Error("disk full");
				}),
			),
			"답",
		);
		expect(posted).toHaveLength(1);
		expect(store.listDeliveries({ originKey: ORIGIN }).map((row) => row.state)).toEqual(["confirmed"]);
		expect(logs.filter((line) => line.includes("event=delivery_post_record_failed"))).toHaveLength(1);
	});

	test("AC-4: a delivery source without recordPost still delivers", async () => {
		expect(await deliver(await adapterWith(deliveries(null)), "답")).toHaveLength(1);
		expect(store.listDeliveries({ originKey: ORIGIN }).map((row) => row.state)).toEqual(["confirmed"]);
	});
});
