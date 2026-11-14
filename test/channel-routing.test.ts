import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AdapterDeps, ChannelAdapter, ChannelBinding } from "../src/channel/adapter";
import type { ChannelPort, MessageRef, OutboundMessage, PostTarget } from "../src/channel/port";
import type { IngestOutcome } from "../src/channel/types";
import { Daemon } from "../src/daemon/daemon";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { approvalActionId } from "../src/safety/approval";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import { hasButtons, makeHome, OWNER, type TestHome, WaitingTransport } from "./helpers/bot-home";
import type { FakeCall } from "./helpers/slack-fake-transport";

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
		channels: [new SlackBinding(new SlackChannel(transport))],
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

	// T-20261111-03: an inject may not answer a card (doc/plans/inject-card-guard-turn-undo-wiring.md §A). The marker
	// still goes up as a reply in the card's thread; only the owner's own reply settles the card.
	test("inject --thread into a card's thread posts the marker there but cannot answer the card", async () => {
		await boot({ escalationChannel: ESCALATION });
		await seedThread();
		const result = ask();
		const { ts } = await transport.shown.promise;
		await expect(
			daemon.inject({ origin: `slack/ch/${ESCALATION}`, asOwner: true, text: "진행해", thread: ts }),
		).rejects.toThrow("approval/choice card");
		expect(transport.posts((text) => text.startsWith("🧪 inject ") && text.endsWith("\n> 진행해"))[0]).toMatchObject({
			channel: ESCALATION,
			threadTs: ts,
		});
		expect(daemon.store.getApproval(`${ESCALATION}:${ts}`)?.status).toBe("pending");
		await ownerReply(ESCALATION, ts, "1800.000302", "진행해");
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

const DISCORD_CH = "111111111111111111";
const DISCORD_DM = "123456789012345678"; // gitleaks:allow (fake snowflake)

/** A second platform's port: records posts and wakes a waiter on each one. */
class SecondPort implements ChannelPort {
	readonly platform = "discord" as const;
	readonly posts: Array<{ target: PostTarget; msg: OutboundMessage }> = [];
	#waiters: Array<() => void> = [];

	async post(target: PostTarget, msg: OutboundMessage): Promise<MessageRef> {
		this.posts.push({ target, msg });
		for (const waiter of this.#waiters.splice(0)) waiter();
		return { platform: "discord", conversationId: target.conversationId, messageId: `9000${this.posts.length}` };
	}
	async edit(): Promise<void> {}
	async react(): Promise<void> {}
	async uploadFile(): Promise<{ fileId: string }> {
		return { fileId: "F1" };
	}
	async permalink(): Promise<string | undefined> {
		return undefined;
	}
	mentionUser(userId: string): string {
		return `<@${userId}>`;
	}

	/** Resolves once a post satisfying `match` arrived (bounded). */
	waitForPost(match: (text: string) => boolean, timeoutMs = 10_000): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const check = () => {
			if (!this.posts.some((p) => match(p.msg.text))) return void this.#waiters.push(check);
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => reject(new Error("timed out waiting for a second-platform post")), timeoutMs);
		check();
		return promise;
	}
}

/** A second platform's adapter: its pump takes what the daemon's delivery source hands it and confirms it. */
class SecondAdapter implements ChannelAdapter {
	readonly platform = "discord" as const;
	readonly botUserId = "999999999999999999";
	readonly pumped: string[] = [];
	constructor(private readonly deps: AdapterDeps) {}
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async pumpDeliveries(): Promise<number> {
		const items = await this.deps.deliveries.claimDue();
		for (const item of items) {
			this.pumped.push(item.body);
			await this.deps.deliveries.confirm(item.deliveryId);
		}
		return items.length;
	}
	async tick(): Promise<void> {}
	async setStalled(): Promise<void> {}
	async setProgress(): Promise<void> {}
	async postNotice(): Promise<void> {}
	async ingestOwner(): Promise<IngestOutcome> {
		return "dropped";
	}
	setChannelPolicy(): void {}
	connectionState(): undefined {
		return undefined;
	}
	recover(): void {}
}

describe("a second platform beside Slack", () => {
	let port: SecondPort;
	let adapter: SecondAdapter | undefined;

	async function bootTwo(overrides: { escalationChannel?: string } = {}): Promise<void> {
		transport = new CardTransport();
		port = new SecondPort();
		const second: ChannelBinding = {
			port,
			createAdapter: (deps) => {
				adapter = new SecondAdapter(deps);
				return adapter;
			},
		};
		const sessions = new FakeSessionStore();
		daemon = new Daemon({
			config: { ...home.config, ...overrides },
			channels: [new SlackBinding(new SlackChannel(transport)), second],
			log: createLogger({ sink: (line) => logs.push(line), clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		await daemon.start();
	}

	test("each delivery goes through the adapter of its thread ref's platform only", async () => {
		await bootTwo();
		daemon.store.recordInterim({
			originKey: `discord/dm/${DISCORD_DM}`,
			opRef: "op-d",
			threadRef: `${DISCORD_CH}:-`,
			index: 0,
			body: "디스코드로 갈 답",
		});
		daemon.store.recordInterim({
			originKey: ORIGIN,
			opRef: "op-s",
			threadRef: `${DM}:-`,
			index: 0,
			body: "슬랙으로 갈 답",
		});
		await transport.waitForPosts((text) => text.includes("슬랙으로 갈 답"));
		await daemon.pump();
		expect(adapter?.pumped).toEqual(["디스코드로 갈 답"]);
		expect(transport.posts((text) => text.includes("디스코드로 갈 답"))).toHaveLength(0);
		expect(transport.posts((text) => text.includes("슬랙으로 갈 답"))).toHaveLength(1);
		expect(daemon.store.listDeliveries().map((row) => [row.body, row.state])).toEqual([
			["디스코드로 갈 답", "confirmed"],
			["슬랙으로 갈 답", "confirmed"],
		]);
	});

	test("a Discord DM origin gets its own upload tool and the monitor tools, no Slack upload and no lane tools", async () => {
		await bootTwo();
		const names = daemon.hostToolsFor(`discord/dm/${DISCORD_DM}`).map((t) => t.name);
		expect(names).toContain("discord_send_file");
		expect(names).toContain("ompbot_request_approval");
		for (const absent of ["slack_send_file", "ompbot_work_start", "ompbot_lane_progress", "ompbot_claim_done"]) {
			expect(names).not.toContain(absent);
		}
		for (const present of ["ompbot_monitor_add", "ompbot_monitor_list", "ompbot_monitor_remove"]) {
			expect(names).toContain(present);
		}
		// The Slack origin keeps its full set.
		const slackNames = daemon.hostToolsFor(ORIGIN).map((t) => t.name);
		expect(slackNames).toContain("slack_send_file");
		expect(slackNames).toContain("ompbot_work_start");
		expect(slackNames).toContain("ompbot_monitor_add");
	});

	test("a second-platform conversation's approval card goes to that conversation even with an escalation channel", async () => {
		await bootTwo({ escalationChannel: ESCALATION });
		const tool = daemon.hostToolsFor(`discord/dm/${DISCORD_DM}`).find((t) => t.name === "ompbot_request_approval");
		if (!tool) throw new Error("tool missing");
		const abort = new AbortController();
		const result = tool.execute({ summary: "force push main" }, { signal: abort.signal });
		await port.waitForPost((text) => text.startsWith("🔐 승인 요청"));
		expect(port.posts[0]?.target).toEqual({ conversationId: DISCORD_DM });
		expect(port.posts[0]?.msg.text).toBe("🔐 승인 요청\nforce push main");
		abort.abort();
		await result.catch(() => undefined);
		expect(transport.posts((text) => text.includes("승인 요청"))).toHaveLength(0);
	});
});
