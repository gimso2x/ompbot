import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Daemon } from "../src/daemon/daemon";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { approvalActionId } from "../src/safety/approval";
import { SlackChannel } from "../src/slack/channel";
import type { FakeCall } from "../src/slack/fake-transport";
import { hasButtons, makeHome, OWNER, type TestHome, WaitingTransport } from "./helpers/bot-home";

const ESCALATION = "C0ESCALATE1";
const DM = "D1";
const ORIGIN = `slack/dm/${DM}`;
const clock = { now: () => Date.now() };

type Post = Extract<FakeCall, { method: "postMessage" }>;
type Update = Extract<FakeCall, { method: "updateMessage" }>;

/** Resolves `shown` when approval buttons go up on a card and `finalized` when a card update removes them. */
class CardTransport extends WaitingTransport {
	shown = Promise.withResolvers<{ channel: string; ts: string }>();
	finalized = Promise.withResolvers<Update>();

	override async updateMessage(args: {
		channel: string;
		ts: string;
		text: string;
		blocks?: readonly unknown[] | undefined;
	}): Promise<void> {
		await super.updateMessage(args);
		if (hasButtons(args.blocks)) this.shown.resolve({ channel: args.channel, ts: args.ts });
		else if (args.text.startsWith("🔐")) this.finalized.resolve({ method: "updateMessage", ...args });
	}
}

let home: TestHome;
let daemon: Daemon;
let transport: CardTransport;
let logs: string[];

async function boot(overrides: { escalationChannel?: string } = {}): Promise<void> {
	transport = new CardTransport();
	const sessions = new FakeSessionStore();
	daemon = new Daemon({
		config: { ...home.config, ...overrides },
		slack: new SlackChannel(transport),
		log: createLogger({ sink: (line) => logs.push(line), clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot",
		driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
	});
	await daemon.start();
}

/** An owner DM message first, so the origin has a current thread (`D1:<ts>`) the approval request comes from. */
async function seedThread(): Promise<string> {
	await transport.emitMessage({
		type: "message",
		channel: DM,
		channel_type: "im",
		user: OWNER,
		text: "배포 준비해줘",
		ts: "1700.000001",
	});
	await transport.waitForPosts((text) => text.includes("ECHO 배포 준비해줘"));
	return "1700.000001";
}

function ask(summary = "force push main"): Promise<string> {
	const tool = daemon.hostToolsFor(ORIGIN).find((t) => t.name === "ompbot_request_approval");
	if (!tool) throw new Error("tool missing");
	return tool.execute({ summary }, { signal: new AbortController().signal });
}

function cardPost(channel: string): Post {
	const post = transport
		.posts()
		.find((p) => p.channel === channel && p.text.startsWith("🔐 승인 요청") && p.threadTs === undefined);
	if (!post) throw new Error(`no card in ${channel}`);
	return post;
}

function ownerReply(channel: string, threadTs: string, ts: string, text: string, user = OWNER) {
	return transport.emitMessage({
		type: "message",
		channel,
		channel_type: channel.startsWith("D") ? "im" : "channel",
		user,
		text,
		ts,
		thread_ts: threadTs,
	});
}

beforeEach(() => {
	home = makeHome("ompbot-routing-");
	logs = [];
});

afterEach(async () => {
	await daemon.stop();
	home.remove();
});

describe("escalation channel", () => {
	test("the card goes to the escalation channel with the owner mention and a link; its mirror with the same buttons lands in the asking thread", async () => {
		await boot({ escalationChannel: ESCALATION });
		const thread = await seedThread();
		const result = ask("force push main\n자세히");
		const { channel, ts } = await transport.shown.promise;
		expect(channel).toBe(ESCALATION);
		const card = cardPost(ESCALATION);
		expect(card.text.split("\n")[0]).toBe(`🔐 승인 요청 <@${OWNER}>`);
		expect(card.text).toContain(`요청 위치: DM · <https://slack.test/archives/${DM}/p1700000001|스레드 보기>`);
		// Exactly one mirror card in the requesting thread, its buttons carrying the escalation card's key; no pointer.
		await transport.waitForPosts((text) => text.startsWith("🔐 승인 요청\nforce push main"));
		const mirrors = transport.posts((text) => text.startsWith("🔐 승인 요청\nforce push main"));
		expect(mirrors).toHaveLength(1);
		expect(mirrors[0]).toMatchObject({ channel: DM, threadTs: thread });
		expect(JSON.stringify(mirrors[0]?.blocks)).toContain(approvalActionId("approve", ESCALATION, ts));
		expect(JSON.stringify(mirrors[0]?.blocks)).toContain(
			`<https://slack.test/archives/${ESCALATION}/p${ts.replace(".", "")}|#escalation에서 보기>`,
		);
		expect(transport.posts((text) => text.startsWith("🔐 승인 요청을"))).toHaveLength(0);
		// The ledger row maps the card back to the asking conversation and thread.
		expect(daemon.store.getApproval(`${ESCALATION}:${ts}`)).toMatchObject({
			status: "pending",
			originKey: ORIGIN,
			originThreadRef: `${DM}:${thread}`,
		});
		await transport.emitBlockAction({
			user: { id: OWNER },
			channel: { id: ESCALATION },
			message: { ts },
			actions: [{ action_id: approvalActionId("approve", ESCALATION, ts), value: "approve" }],
		});
		expect(await result).toBe("approved");
	});

	test("the permalink failing falls back to the channel label", async () => {
		await boot({ escalationChannel: ESCALATION });
		await seedThread();
		transport.failNext.getPermalink = [new Error("boom"), new Error("boom")];
		void ask();
		await transport.shown.promise;
		await transport.waitForPosts((text) => text.startsWith("🔐 승인 요청\nforce push main"));
		expect(cardPost(ESCALATION).text.endsWith("요청 위치: DM")).toBe(true);
		const mirror = transport.posts((text) => text.startsWith("🔐 승인 요청\nforce push main"))[0];
		expect(JSON.stringify(mirror?.blocks)).toContain(`정본 카드: <#${ESCALATION}>`);
	});

	test("a pending card's thread reply settles it as replied: the tool returns the text, the card says so, no session starts", async () => {
		await boot({ escalationChannel: ESCALATION });
		await seedThread();
		const result = ask();
		const { ts } = await transport.shown.promise;
		// Not the owner: ignored, the request stays pending.
		await ownerReply(ESCALATION, ts, "1800.000101", "승인!", "UOTHER");
		expect(await Promise.race([result, Promise.resolve("pending")])).toBe("pending");
		// No mention in a channel that is not mention-free: a card-thread reply still counts as addressed.
		await ownerReply(ESCALATION, ts, "1800.000102", "네, 그 브랜치만 진행하세요");
		expect(await result).toBe("replied: 네, 그 브랜치만 진행하세요");
		const final = await transport.finalized.promise;
		expect(hasButtons(final.blocks)).toBe(false);
		expect(final.text).toContain("💬 답장으로 처리됨: 네, 그 브랜치만 진행하세요");
		expect(JSON.stringify(final.blocks)).toContain("💬 답장으로 처리됨: 네, 그 브랜치만 진행하세요");
		expect(daemon.store.getApproval(`${ESCALATION}:${ts}`)).toMatchObject({
			status: "replied",
			replyTs: "1800.000102",
			replyText: "네, 그 브랜치만 진행하세요",
		});
		// Consumed: no inbound row, no thread session in the escalation channel.
		expect(daemon.store.getInbound(`${ESCALATION}:1800.000102`)).toBeUndefined();
		expect(daemon.store.hasInboundThread(`${ESCALATION}:${ts}`)).toBe(false);
		// A backfill replay of the same reply is a no-op duplicate.
		await ownerReply(ESCALATION, ts, "1800.000102", "네, 그 브랜치만 진행하세요");
		expect(logs.filter((line) => line.includes("event=inbound_duplicate"))).toHaveLength(1);
		expect(daemon.store.getInbound(`${ESCALATION}:1800.000102`)).toBeUndefined();
		expect(daemon.store.getApproval(`${ESCALATION}:${ts}`)?.status).toBe("replied");
	});

	test("a reply in an already-settled card's thread reaches the asking session, answered inside the card thread", async () => {
		await boot({ escalationChannel: ESCALATION });
		await seedThread();
		const result = ask();
		const { ts } = await transport.shown.promise;
		await transport.emitBlockAction({
			user: { id: OWNER },
			channel: { id: ESCALATION },
			message: { ts },
			actions: [{ action_id: approvalActionId("deny", ESCALATION, ts), value: "deny" }],
		});
		expect(await result).toBe("denied");
		await ownerReply(ESCALATION, ts, "1800.000201", "그럼 다음에 하자");
		const row = daemon.store.getInbound(`${ESCALATION}:1800.000201`);
		expect(row).toMatchObject({ originKey: ORIGIN, threadRef: `${ESCALATION}:${ts}` });
		await transport.waitForPosts((text) => text.includes("ECHO 그럼 다음에 하자"));
		const answer = transport.posts((text) => text.includes("ECHO 그럼 다음에 하자"))[0];
		expect(answer).toMatchObject({ channel: ESCALATION, threadTs: ts });
		// A second reply keeps flowing to the same session instead of starting a thread session in the channel.
		await ownerReply(ESCALATION, ts, "1800.000202", "고마워");
		expect(daemon.store.getInbound(`${ESCALATION}:1800.000202`)?.originKey).toBe(ORIGIN);
	});

	test("inject --thread posts the marker and the owner message as replies in that thread", async () => {
		await boot({ escalationChannel: ESCALATION });
		await seedThread();
		const result = ask();
		const { ts } = await transport.shown.promise;
		const injected = await daemon.inject({
			origin: `slack/ch/${ESCALATION}`,
			asOwner: true,
			text: "진행해",
			thread: ts,
		});
		expect(injected.threadRef).toBe(`${ESCALATION}:${ts}`);
		expect(transport.posts((text) => text === `🧪 inject ${injected.nonce}\n> 진행해`)[0]).toMatchObject({
			channel: ESCALATION,
			threadTs: ts,
		});
		expect(await result).toBe("replied: 진행해");
	});
});

describe("approval cards without an escalation channel", () => {
	test("the card stays in the asking conversation, no pointer, and a thread reply still settles it", async () => {
		await boot();
		await seedThread();
		const result = ask();
		const { channel, ts } = await transport.shown.promise;
		expect(channel).toBe(DM);
		expect(cardPost(DM).text).toBe("🔐 승인 요청\nforce push main");
		expect(transport.posts((text) => text.startsWith("🔐 승인 요청을"))).toHaveLength(0);
		expect(daemon.store.getApproval(`${DM}:${ts}`)?.originKey).toBe(ORIGIN);
		await ownerReply(DM, ts, "1800.000301", "좋아요 진행");
		expect(await result).toBe("replied: 좋아요 진행");
		expect(daemon.store.getInbound(`${DM}:1800.000301`)).toBeUndefined();
	});
});
