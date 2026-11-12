// Discord outbound (doc/plans/discord-channel.md §8): the delivery pump on the real ledger, splitting, replies, rate
// limits, failure kinds, the status finish and allowed_mentions.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoreSink, DeliverySource } from "../src/channel/types";
import { DiscordAdapter } from "../src/discord/adapter";
import { DiscordChannel } from "../src/discord/channel";
import {
	type CreateMessageArgs,
	DiscordCallError,
	type DiscordMessageEvent,
	DiscordRateLimitedError,
} from "../src/discord/transport";
import { createLogger } from "../src/log";
import { redact } from "../src/redact";
import { openStore, type Store } from "../src/store/db";
import { type FakeDiscordCall, FakeDiscordTransport } from "./helpers/discord-fake-transport";

const OWNER = "100000000000000001";
const BOT = "500000000000000000";
const GUILD = "300000000000000001";
const CH = "111111111111111111";
const DM = "123456789012345678";
const QUESTION = "700000000000000001";

/** FakeDiscordTransport whose n-th createMessage (1-based) throws instead of posting. */
class ScriptedTransport extends FakeDiscordTransport {
	readonly createFailures = new Map<number, Error>();
	#attempts = 0;

	override async createMessage(args: CreateMessageArgs): Promise<{ id: string }> {
		this.#attempts += 1;
		const error = this.createFailures.get(this.#attempts);
		if (error !== undefined) throw error;
		return super.createMessage(args);
	}
}

let dir: string;
let now: number;
let store: Store;
let transport: ScriptedTransport;
let adapter: DiscordAdapter;
let failed: Array<{ id: number; outcome: string }>;

function source(): DeliverySource {
	return {
		claimDue: () =>
			store.claimDue(undefined, "discord").map((row) => ({
				deliveryId: row.deliveryId,
				originKey: row.originKey,
				threadRef: row.threadRef,
				body: row.body,
				redelivered: row.redelivered,
				sentParts: row.sentParts,
				replyTs: row.replyTs,
			})),
		confirm: (id) => void store.confirmDelivery(id),
		fail: (id, error, outcome) => {
			failed.push({ id, outcome });
			if (outcome === "definitive") store.failDelivery(id, error);
			else store.markAmbiguous(id, error);
		},
		defer: (id, error, retry) => void store.deferDelivery(id, error, retry),
	};
}

const core: CoreSink = { onInbound: () => undefined, onCommand: () => undefined, onAction: () => {} };

/** An answer row in the ledger for `threadRef`. */
function deliver(threadRef: string, body: string, originKey = `discord/dm/${DM}`): number {
	const row = store.recordInterim({ originKey, opRef: `op-${threadRef}`, threadRef, index: 0, body });
	return row.deliveryId;
}

const posts = (): Array<Extract<FakeDiscordCall, { method: "createMessage" }>> =>
	transport.calls.filter(
		(c): c is Extract<FakeDiscordCall, { method: "createMessage" }> => c.method === "createMessage",
	);
const answers = () => posts().filter((p) => !p.content?.startsWith("⏳"));
const row = (id: number) => store.listDeliveries().find((r) => r.deliveryId === id);
const longBody = (n: number): string =>
	Array.from({ length: Math.ceil(n / 50) }, (_, i) => `${String(i).padStart(3, "0")} ${"가".repeat(44)}`)
		.join("\n")
		.slice(0, n);

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-discord-delivery-"));
	now = 1_800_000_000_000;
	store = openStore({ timezone: "Asia/Seoul", path: join(dir, "ompbot.db"), clock: { now: () => now }, redact });
	transport = new ScriptedTransport({ botUserId: BOT });
	transport.setChannel({ id: CH, type: 0, guildId: GUILD });
	failed = [];
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

async function ownerDm(id = QUESTION): Promise<void> {
	const event: DiscordMessageEvent = {
		id,
		channel_id: DM,
		author: { id: OWNER },
		content: "질문",
		type: 0,
	};
	await transport.emitMessage(event);
}

describe("splitting and destinations", () => {
	test("a 2500-character answer goes as two messages of at most 2000, both as replies in the DM", async () => {
		await ownerDm();
		const id = deliver(`${DM}:${QUESTION}`, longBody(2500));
		expect(await adapter.pumpDeliveries()).toBe(1);
		const sent = answers();
		expect(sent).toHaveLength(2);
		for (const post of sent) {
			expect(post.content?.length ?? 0).toBeLessThanOrEqual(2000);
			expect(post.channelId).toBe(DM);
			expect(post.messageReference).toEqual({ messageId: QUESTION });
		}
		expect(row(id)?.state).toBe("confirmed");
	});

	test("a thread answer goes into the thread channel", async () => {
		const thread = "222222222222222222";
		transport.setChannel({ id: thread, type: 11, parentId: CH, guildId: GUILD });
		deliver(`${CH}:${thread}`, longBody(2500), `discord/ch/${CH}/t/${thread}`);
		await adapter.pumpDeliveries();
		expect(answers().map((p) => [p.channelId, p.messageReference])).toEqual([
			[thread, undefined],
			[thread, undefined],
		]);
	});

	test("a top-level answer: part 2 replies to part 1", async () => {
		deliver(`${CH}:-`, longBody(2500), "monitor/x");
		await adapter.pumpDeliveries();
		const [first, second] = answers();
		expect(first?.channelId).toBe(CH);
		expect(first?.messageReference).toBeUndefined();
		expect(second?.channelId).toBe(CH);
		expect(second?.messageReference).toEqual({ messageId: first?.id ?? "" });
	});
});

describe("rate limits and failures", () => {
	test("a 429 on part 2 defers with one part sent and the reply id stored; the retry posts only the rest", async () => {
		const id = deliver(`${CH}:-`, longBody(2500), "monitor/x");
		transport.createFailures.set(2, new DiscordRateLimitedError(5_000));
		expect(await adapter.pumpDeliveries()).toBe(0);
		const first = answers()[0];
		expect(answers()).toHaveLength(1);
		expect(row(id)).toMatchObject({ state: "pending", sentParts: 1, replyTs: first?.id });
		// Still blocked: nothing is posted before the retry time.
		expect(await adapter.pumpDeliveries()).toBe(0);
		expect(answers()).toHaveLength(1);
		now += 5_001;
		expect(await adapter.pumpDeliveries()).toBe(1);
		const sent = answers();
		expect(sent).toHaveLength(2);
		expect(sent[1]?.messageReference).toEqual({ messageId: first?.id ?? "" });
		expect(row(id)?.state).toBe("confirmed");
		expect(failed).toHaveLength(0);
	});

	test("a 4xx before anything was posted is a definitive failure (failDelivery)", async () => {
		const id = deliver(`${CH}:-`, "짧은 답", "monitor/x");
		transport.createFailures.set(1, new DiscordCallError("definitive", "discord_http_403:50013", 403, 50013));
		await adapter.pumpDeliveries();
		expect(failed).toEqual([{ id, outcome: "definitive" }]);
		expect(row(id)?.state).toBe("pending");
		expect(row(id)?.lastError).toContain("50013");
	});

	test("a 5xx is ambiguous (markAmbiguous), never resent", async () => {
		const id = deliver(`${CH}:-`, "짧은 답", "monitor/x");
		transport.createFailures.set(1, new DiscordCallError("ambiguous", "discord_http_500", 500));
		await adapter.pumpDeliveries();
		expect(failed).toEqual([{ id, outcome: "ambiguous" }]);
		expect(row(id)?.state).toBe("failed_ambiguous");
	});
});

describe("status finish", () => {
	test("after the answer: the ⏳ status is deleted, 👀 removed and ✅ added on the question", async () => {
		await ownerDm();
		const status = posts().find((p) => p.content?.startsWith("⏳"));
		expect(status).toBeDefined();
		deliver(`${DM}:${QUESTION}`, "답입니다");
		await adapter.pumpDeliveries();
		expect(answers()[0]?.content).toMatch(/^답입니다\n_✅ 00:00_$/);
		expect(transport.calls.filter((c) => c.method === "deleteMessage")).toEqual([
			{ method: "deleteMessage", channelId: DM, messageId: status?.id ?? "" },
		]);
		const reactions = transport.calls.filter((c) => c.method === "addReaction" || c.method === "removeReaction");
		expect(reactions).toEqual([
			{ method: "addReaction", channelId: DM, messageId: QUESTION, emoji: "👀" },
			{ method: "removeReaction", channelId: DM, messageId: QUESTION, emoji: "👀" },
			{ method: "addReaction", channelId: DM, messageId: QUESTION, emoji: "✅" },
		]);
	});

	test("a refused delete turns the status into ✅ 완료 · mm:ss", async () => {
		await ownerDm();
		const status = posts().find((p) => p.content?.startsWith("⏳"));
		transport.failNext.deleteMessage = [new DiscordCallError("definitive", "discord_http_403:50013", 403, 50013)];
		deliver(`${DM}:${QUESTION}`, "답");
		await adapter.pumpDeliveries();
		const edits = transport.calls.filter(
			(c): c is Extract<FakeDiscordCall, { method: "editMessage" }> => c.method === "editMessage",
		);
		expect(edits).toHaveLength(1);
		expect(edits[0]).toMatchObject({ channelId: DM, messageId: status?.id });
		expect(edits[0]?.content).toMatch(/^✅ 완료 · \d\d:\d\d$/);
	});
});

describe("allowed_mentions", () => {
	test("every post carries parse: []; only a post that mentions the owner adds users: [owner]; @everyone never pings", async () => {
		await ownerDm();
		deliver(`${DM}:${QUESTION}`, `@everyone @here 확인 부탁 <@${OWNER}>`);
		deliver(`${CH}:-`, "@everyone 공지처럼 보이는 글", "monitor/x");
		await adapter.pumpDeliveries();
		const all = posts();
		expect(all.length).toBeGreaterThanOrEqual(3);
		for (const post of all) {
			expect(post.allowedMentions?.parse).toEqual([]);
			const mentionsOwner = post.content?.includes(`<@${OWNER}>`) === true;
			expect(post.allowedMentions?.users).toEqual(mentionsOwner ? [OWNER] : undefined);
		}
		expect(all.filter((p) => p.allowedMentions?.users !== undefined)).toHaveLength(1);
	});

	test("the port's own posts follow the same rule", async () => {
		const port = new DiscordChannel(transport, { ownerUserId: OWNER });
		await port.post({ conversationId: CH }, { text: `*승인* 요청 <@${OWNER}> <!here>` });
		await port.post({ conversationId: CH }, { text: "@everyone" });
		const [first, second] = posts();
		expect(first?.content).toBe(`**승인** 요청 <@${OWNER}> here`);
		expect(first?.allowedMentions).toEqual({ parse: [], users: [OWNER] });
		expect(second?.allowedMentions).toEqual({ parse: [] });
	});
});
