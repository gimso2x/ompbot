// The Teams long-turn status line (adapter-owned lifecycle): nothing is posted before `longTurnMs`, one `⏳` line after
// it, the answer of a turn without a line carries the `✅ mm:ss` footer, and an answer the pump gives up on ends the
// posted line as undelivered.
import { beforeEach, describe, expect, test } from "bun:test";
import type { CoreSink, DeliveryItem, DeliverySource, InboundMessage } from "../../src/channel/types";
import { createLogger } from "../../src/log";
import { redact } from "../../src/redact";
import type { TeamsConversation } from "../../src/store/db";
import { TeamsAdapter } from "../../src/teams/adapter";
import { TeamsChannel } from "../../src/teams/channel";
import { TeamsCallError, type TeamsConnector } from "../../src/teams/transport";
import { teamsAlias } from "../../src/teams/types";
import { PERSONAL_CHAT } from "./harness";

const SERVICE = "https://smba.example.test/";
const ALIAS = teamsAlias(PERSONAL_CHAT);
const T0 = 1_800_000_000_000;

interface Sent {
	method: "send" | "update";
	activityId?: string;
	body: Record<string, unknown>;
}

let now: number;
let sent: Sent[];
let inbound: InboundMessage[];
let queue: DeliveryItem[];
let ledger: string[];
let sendFailure: Error | undefined;
let adapter: TeamsAdapter;
let next: number;

function build(): TeamsAdapter {
	const connector = {
		botId: "28:bot",
		sendActivity: async (_serviceUrl: string, _conversationId: string, body: Record<string, unknown>) => {
			if (body.type === "message" && sendFailure !== undefined) {
				const err = sendFailure;
				sendFailure = undefined;
				throw err;
			}
			next += 1;
			sent.push({ method: "send", body });
			return { id: `act-${next}` };
		},
		updateActivity: async (
			_serviceUrl: string,
			_conversationId: string,
			activityId: string,
			body: Record<string, unknown>,
		) => {
			sent.push({ method: "update", activityId, body });
		},
	} as unknown as TeamsConnector;
	const conversation: TeamsConversation = {
		alias: ALIAS,
		conversationId: PERSONAL_CHAT,
		serviceUrl: SERVICE,
		tenantId: "tenant",
		kind: "dm",
	};
	const conversations = {
		teamsConversation: (alias: string) => (alias === ALIAS ? conversation : undefined),
		upsertTeamsConversation: () => {},
		markTeamsOwnerSpoke: () => {},
	};
	const channel = new TeamsChannel(connector);
	channel.useConversations(conversations);
	const core: CoreSink = {
		onInbound: (message) => {
			inbound.push(message);
			return undefined;
		},
		onCommand: () => undefined,
		onAction: () => {},
	};
	const deliveries: DeliverySource = {
		claimDue: () => queue.splice(0),
		confirm: (id) => void ledger.push(`confirm ${id}`),
		fail: (id, _error, outcome) => void ledger.push(`fail ${id} ${outcome}`),
		defer: (id) => void ledger.push(`defer ${id}`),
	};
	return new TeamsAdapter({
		channel,
		conversations,
		core,
		deliveries,
		tenantId: "tenant",
		ownerAadObjectId: "owner",
		clock: { now: () => now },
		log: createLogger({ sink: () => {}, clock: { now: () => now }, redact }),
	});
}

async function ownerMessage(id: string): Promise<string> {
	expect(await adapter.ingestOwner({ conversationId: ALIAS, kind: "dm", messageId: id, text: "해줘" })).toBe(
		"recorded",
	);
	await adapter.idle();
	const threadRef = inbound.at(-1)?.threadRef;
	if (threadRef === undefined) throw new Error("no inbound");
	return threadRef;
}

function deliver(threadRef: string, body: string): void {
	queue.push({ deliveryId: queue.length + 1, originKey: `teams/dm/${ALIAS}`, threadRef, body, redelivered: false });
}

const messages = () => sent.filter((s) => s.method === "send" && s.body.type === "message");
const updates = () => sent.filter((s) => s.method === "update");

beforeEach(() => {
	now = T0;
	sent = [];
	inbound = [];
	queue = [];
	ledger = [];
	sendFailure = undefined;
	next = 0;
	adapter = build();
});

describe("Teams long-turn status line", () => {
	test("nothing is posted before 60 s; the first tick at 60 s posts one ⏳ line replying to the owner message", async () => {
		await ownerMessage("m-1");
		expect(sent.filter((s) => s.body.type === "typing")).toHaveLength(1);
		now += 59_999;
		await adapter.tick();
		expect(messages()).toEqual([]);
		now += 1;
		await adapter.tick();
		expect(messages()).toEqual([
			{
				method: "send",
				body: { type: "message", text: "⏳ 작업 중 · 01:00", textFormat: "markdown", replyToId: "m-1" },
			},
		]);
		await adapter.tick();
		expect(messages()).toHaveLength(1);
		expect(updates()).toEqual([]);
	});

	test("an answer before the line carries the ✅ footer and posts no status line afterwards", async () => {
		const threadRef = await ownerMessage("m-1");
		now += 42_000;
		deliver(threadRef, "답입니다");
		expect(await adapter.pumpDeliveries()).toBe(1);
		expect(messages().map((m) => m.body.text)).toEqual(["답입니다\n\n*✅ 00:42*"]);
		expect(ledger).toEqual(["confirm 1"]);
		now += 60_000;
		await adapter.tick();
		expect(messages()).toHaveLength(1);
		expect(updates()).toEqual([]);
	});

	test("an answer after the line has no footer; the line becomes ✅ 완료 with the elapsed time", async () => {
		const threadRef = await ownerMessage("m-1");
		now += 60_000;
		await adapter.tick();
		now += 10_000;
		deliver(threadRef, "답입니다");
		expect(await adapter.pumpDeliveries()).toBe(1);
		expect(messages().map((m) => m.body.text)).toEqual(["⏳ 작업 중 · 01:00", "답입니다"]);
		expect(updates()).toEqual([
			{
				method: "update",
				activityId: "act-2",
				body: { type: "message", text: "✅ 완료 · 01:10", textFormat: "markdown" },
			},
		]);
		now += 60_000;
		await adapter.tick();
		expect(updates()).toHaveLength(1);
	});

	test("an answer the pump gives up on (ambiguous send) ends the posted line as undelivered", async () => {
		const threadRef = await ownerMessage("m-1");
		now += 60_000;
		await adapter.tick();
		now += 5_000;
		sendFailure = new TeamsCallError("connector 502", 502, "ambiguous");
		deliver(threadRef, "답입니다");
		expect(await adapter.pumpDeliveries()).toBe(0);
		expect(ledger).toEqual(["fail 1 ambiguous"]);
		expect(updates()).toEqual([
			{
				method: "update",
				activityId: "act-2",
				body: { type: "message", text: "⚠️ 답을 보내지 못했습니다 · 01:05", textFormat: "markdown" },
			},
		]);
		now += 60_000;
		await adapter.tick();
		expect(updates()).toHaveLength(1);
	});
});
