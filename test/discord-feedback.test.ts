// Discord owner feedback (doc/plans/discord-channel.md TASK 6): 👍/👎 on a message a delivery posted reaches
// recordFeedback like a Slack reaction; anything else never does. Gateway reactions carry no time, so the adapter
// stamps arrival order: of two events on one message, the one that came later wins.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoreSink, DeliverySource } from "../src/channel/types";
import { DiscordAdapter } from "../src/discord/adapter";
import { DiscordChannel } from "../src/discord/channel";
import type { DiscordReactionEvent } from "../src/discord/transport";
import { createLogger } from "../src/log";
import { redact } from "../src/redact";
import { openStore, type Store } from "../src/store/db";
import { readTurnVerdicts, slackTsMicros } from "../src/store/feedback";
import { type FakeDiscordCall, FakeDiscordTransport } from "./helpers/discord-fake-transport";

const OWNER = "100000000000000001";
const STRANGER = "100000000000000002";
const BOT = "500000000000000000";
const GUILD = "300000000000000001";
const CH = "111111111111111111";

type Feedback = Parameters<NonNullable<DeliverySource["recordFeedback"]>>[0];

let dir: string;
let now: number;
let store: Store;
let transport: FakeDiscordTransport;
let adapter: DiscordAdapter;
let feedback: Feedback[];

function source(): DeliverySource {
	return {
		claimDue: () =>
			store.claimDue(undefined, "discord").map((row) => ({
				deliveryId: row.deliveryId,
				originKey: row.originKey,
				threadRef: row.threadRef,
				body: row.body,
				redelivered: row.redelivered,
			})),
		confirm: (id) => void store.confirmDelivery(id),
		fail: () => {},
		defer: () => {},
		recordPost: (post) => store.feedback.recordPost(post),
		isPost: (post) => store.feedback.isPost(post),
		recordFeedback: (event) => {
			feedback.push(event);
			store.feedback.applyReaction(event);
		},
	};
}

const core: CoreSink = { onInbound: () => undefined, onCommand: () => undefined, onAction: () => {} };

/** Delivers one answer at the channel's top level and returns the id of the message it posted. */
async function postedAnswer(): Promise<string> {
	store.recordInterim({ originKey: "monitor/x", opRef: "op-1", threadRef: `${CH}:-`, index: 0, body: "답" });
	expect(await adapter.pumpDeliveries()).toBe(1);
	const post = transport.calls.find(
		(c): c is Extract<FakeDiscordCall, { method: "createMessage" }> => c.method === "createMessage",
	);
	if (post === undefined) throw new Error("nothing posted");
	return post.id;
}

function verdicts(): string[] {
	const db = new Database(join(dir, "ompbot.db"), { readonly: true, strict: true });
	try {
		return readTurnVerdicts(db, 0).map((turn) => turn.verdict);
	} finally {
		db.close();
	}
}

function reaction(type: "add" | "remove", messageId: string, emoji: string, userId = OWNER): DiscordReactionEvent {
	return {
		type,
		user_id: userId,
		channel_id: CH,
		message_id: messageId,
		guild_id: GUILD,
		emoji: { id: null, name: emoji },
	};
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-discord-feedback-"));
	now = 1_800_000_000_000;
	store = openStore({ timezone: "Asia/Seoul", path: join(dir, "ompbot.db"), clock: { now: () => now }, redact });
	transport = new FakeDiscordTransport({ botUserId: BOT });
	transport.setChannel({ id: CH, type: 0, guildId: GUILD });
	feedback = [];
	adapter = new DiscordAdapter({
		channel: new DiscordChannel(transport, { ownerUserId: OWNER }),
		core,
		deliveries: source(),
		ownerUserId: OWNER,
		clock: { now: () => now },
		log: createLogger({ sink: () => {}, clock: { now: () => now }, redact }),
	});
	await adapter.start();
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("owner 👍/👎 on a bot answer", () => {
	test("👍 added → verdict up / added; removed → removed; 👎 → down", async () => {
		const answer = await postedAnswer();
		await transport.emitReaction(reaction("add", answer, "👍"));
		now += 1_000;
		await transport.emitReaction(reaction("remove", answer, "👍"));
		now += 1_000;
		await transport.emitReaction(reaction("add", answer, "👎🏻"));
		expect(feedback.map((f) => [f.channel, f.ts, f.verdict, f.action])).toEqual([
			[CH, answer, "up", "added"],
			[CH, answer, "up", "removed"],
			[CH, answer, "down", "added"],
		]);
		for (const event of feedback) expect(slackTsMicros(event.eventTs)).toBeDefined();
	});

	test("a message the bot did not post, a stranger and other emoji never reach recordFeedback", async () => {
		const answer = await postedAnswer();
		await transport.emitReaction(reaction("add", "700000000000000099", "👍"));
		await transport.emitReaction(reaction("add", answer, "👍", STRANGER));
		await transport.emitReaction(reaction("add", answer, "😀"));
		await transport.emitReaction(reaction("add", answer, "✅"));
		await transport.emitReaction({ ...reaction("add", answer, "👍"), emoji: { id: "1", name: null } });
		expect(feedback).toHaveLength(0);
	});

	test("two events in the same millisecond: the later one wins", async () => {
		const answer = await postedAnswer();
		await transport.emitReaction(reaction("add", answer, "👎"));
		await transport.emitReaction(reaction("add", answer, "👍"));
		expect(feedback).toHaveLength(2);
		const [first, second] = feedback;
		expect(slackTsMicros(second?.eventTs ?? "") ?? 0).toBeGreaterThan(slackTsMicros(first?.eventTs ?? "") ?? 0);
		expect(verdicts()).toEqual(["up"]);
		// A removal arriving after the add in the same millisecond still counts: the 👍 is gone.
		await transport.emitReaction(reaction("remove", answer, "👍"));
		expect(verdicts()).toEqual([]);
	});
});
