// Discord inbound (doc/plans/discord-channel.md §7): the owner gate, addressing, thread creation, 👀 and the ⏳ status,
// all on FakeDiscordTransport.
import { beforeEach, describe, expect, test } from "bun:test";
import type { CoreSink, DeliverySource, InboundMessage } from "../src/channel/types";
import { DiscordAdapter, type DiscordAdapterOptions } from "../src/discord/adapter";
import { DiscordChannel } from "../src/discord/channel";
import { DiscordCallError, type DiscordMessageEvent } from "../src/discord/transport";
import { createLogger } from "../src/log";
import { redact } from "../src/redact";
import { type FakeDiscordCall, FakeDiscordTransport } from "./helpers/discord-fake-transport";

const OWNER = "100000000000000001";
const STRANGER = "100000000000000002";
const BOT = "500000000000000000";
const GUILD = "300000000000000001";
const OTHER_GUILD = "300000000000000002";
const CH = "111111111111111111";
const DM = "123456789012345678";

let transport: FakeDiscordTransport;
let inbound: InboundMessage[];
let logs: string[];
let muted: Set<string>;
let failures: number;
let seq: bigint;

const noDeliveries: DeliverySource = {
	claimDue: () => [],
	confirm: () => {},
	fail: () => {},
	defer: () => {},
};

function core(): CoreSink {
	const seen = new Set<string>();
	const mutes = new Set<string>();
	return {
		onInbound: (message) => {
			if (seen.has(message.platformMessageId)) return { duplicate: true };
			seen.add(message.platformMessageId);
			inbound.push(message);
			return undefined;
		},
		onCommand: () => undefined,
		onAction: () => {},
		knowsThread: (threadRef) => inbound.some((m) => m.threadRef === threadRef),
		isThreadMuted: (threadRef) => muted.has(threadRef),
		setThreadMute: (threadRef, on) => void (on ? muted.add(threadRef) : muted.delete(threadRef)),
		seenMuteCommand: (id) => mutes.has(id),
		rememberMuteCommand: (id) => void mutes.add(id),
	};
}

async function adapter(options: Partial<DiscordAdapterOptions> = {}): Promise<DiscordAdapter> {
	const channel = new DiscordChannel(transport, { ownerUserId: OWNER });
	const made = new DiscordAdapter({
		channel,
		core: core(),
		deliveries: noDeliveries,
		ownerUserId: OWNER,
		clock: { now: () => 1_800_000_000_000 },
		log: createLogger({ sink: (line) => logs.push(line), clock: { now: () => 0 }, redact }),
		onInboundFailure: () => {
			failures += 1;
		},
		...options,
	});
	await made.start();
	return made;
}

/** A fresh snowflake-sized message id. */
function nextId(): string {
	seq += 1n;
	return String(700_000_000_000_000_000n + seq);
}

function message(content: string, overrides: Partial<DiscordMessageEvent> = {}): DiscordMessageEvent {
	return { id: nextId(), channel_id: CH, guild_id: GUILD, author: { id: OWNER }, content, type: 0, ...overrides };
}

const calls = <M extends FakeDiscordCall["method"]>(method: M) =>
	transport.calls.filter((c): c is FakeDiscordCall & { method: M } => c.method === method);
const logged = (needle: string) => logs.some((line) => line.includes(needle));

beforeEach(() => {
	transport = new FakeDiscordTransport({ botUserId: BOT });
	transport.setChannel({ id: CH, type: 0, guildId: GUILD });
	inbound = [];
	logs = [];
	muted = new Set();
	failures = 0;
	seq = 0n;
});

describe("owner DM", () => {
	test("① one inbound on discord/dm/<channel>, 👀 on the message and the ⏳ status as a reply to it", async () => {
		await adapter();
		const dm = message("안녕", { channel_id: DM, guild_id: undefined });
		await transport.emitMessage(dm);
		expect(inbound).toEqual([
			{
				platformMessageId: `${DM}:${dm.id}`,
				originKey: `discord/dm/${DM}`,
				text: "안녕",
				threadRef: `${DM}:${dm.id}`,
				ownerVerified: true,
			},
		]);
		expect(calls("addReaction")).toEqual([{ method: "addReaction", channelId: DM, messageId: dm.id, emoji: "👀" }]);
		const [status, ...more] = calls("createMessage");
		expect(more).toHaveLength(0);
		expect(status?.channelId).toBe(DM);
		expect(status?.content?.startsWith("⏳")).toBe(true);
		expect(status?.messageReference).toEqual({ messageId: dm.id });
		expect(status?.allowedMentions).toEqual({ parse: [] });
		expect(calls("startThread")).toHaveLength(0);
	});

	test("⑦ the same message twice (a gateway resume replay): the duplicate gets no second 👀 or status", async () => {
		await adapter();
		const dm = message("한 번만", { channel_id: DM, guild_id: undefined });
		await transport.emitMessage(dm);
		await transport.emitMessage({ ...dm });
		expect(inbound).toHaveLength(1);
		expect(calls("addReaction")).toHaveLength(1);
		expect(calls("createMessage")).toHaveLength(1);
		expect(logged("event=inbound_duplicate")).toBe(true);
	});

	test("ingestOwner on a DM the daemon calls `ch` (its kind comes from Slack id shapes): taken as a DM, no bot mention in the text", async () => {
		const made = await adapter();
		transport.setChannel({ id: DM, type: 1 });
		const marker = nextId();
		expect(
			await made.ingestOwner({
				conversationId: DM,
				kind: "ch",
				threadId: undefined,
				messageId: marker,
				text: "머지해",
			}),
		).toBe("recorded");
		expect(inbound).toEqual([
			{
				platformMessageId: `${DM}:${marker}`,
				originKey: `discord/dm/${DM}`,
				text: "머지해",
				threadRef: `${DM}:${marker}`,
				ownerVerified: true,
			},
		]);
	});
});

describe("message edits carry no mentions", () => {
	test("the running status, its final label and a slash command answer are edited with allowedMentions parse []", async () => {
		const made = await adapter({
			core: { ...core(), onCommand: () => "@everyone 확인 <@&999>" },
		});
		await made.commandsReady();
		const dm = message("todo @everyone", { channel_id: DM, guild_id: undefined });
		await transport.emitMessage(dm);
		const threadRef = `${DM}:${dm.id}`;
		await made.setStalled(threadRef, true);
		await made.finishStatus(threadRef, "done", "update");
		await transport.emitInteraction({
			id: "810000000000000001",
			application_id: "600000000000000000",
			type: 2,
			token: "tok-1",
			channel_id: DM,
			channel: { id: DM, type: 1 },
			user: { id: OWNER },
			data: { name: "status-ompbot" },
		});
		const edits = [...calls("editMessage"), ...calls("editInteractionResponse")];
		expect(edits.map((c) => c.method)).toEqual(["editMessage", "editMessage", "editInteractionResponse"]);
		for (const edit of edits) expect(edit.allowedMentions).toEqual({ parse: [] });
	});
});

describe("server channel", () => {
	test("② a mention at the root starts a thread once and takes the message on the thread origin, mention removed", async () => {
		await adapter();
		const root = message(`<@${BOT}> 배포 순서 정리해줘`);
		await transport.emitMessage(root);
		expect(calls("startThread")).toEqual([
			{ method: "startThread", channelId: CH, messageId: root.id, name: "배포 순서 정리해줘", id: root.id },
		]);
		expect(inbound).toHaveLength(1);
		expect(inbound[0]?.originKey).toBe(`discord/ch/${CH}/t/${root.id}`);
		expect(inbound[0]?.threadRef).toBe(`${CH}:${root.id}`);
		expect(inbound[0]?.text).toBe("배포 순서 정리해줘");
		// 👀 on the root message (in the channel), the status in the new thread.
		expect(calls("addReaction")[0]).toMatchObject({ channelId: CH, messageId: root.id, emoji: "👀" });
		const status = calls("createMessage")[0];
		expect(status?.channelId).toBe(root.id);
		expect(status?.messageReference).toBeUndefined();
	});

	test("the <@!id> nickname mention form addresses the bot too", async () => {
		await adapter();
		await transport.emitMessage(message(`<@!${BOT}> 안녕`));
		expect(inbound.map((m) => m.text)).toEqual(["안녕"]);
	});

	test("③ an unmentioned owner reply inside a thread the bot takes part in is taken on the same thread", async () => {
		await adapter();
		const root = message(`<@${BOT}> 시작`);
		await transport.emitMessage(root);
		const reply = message("이어서 하나 더", { channel_id: root.id });
		await transport.emitMessage(reply);
		expect(calls("startThread")).toHaveLength(1);
		expect(inbound.map((m) => [m.originKey, m.threadRef, m.platformMessageId])).toEqual([
			[`discord/ch/${CH}/t/${root.id}`, `${CH}:${root.id}`, `${CH}:${root.id}`],
			[`discord/ch/${CH}/t/${root.id}`, `${CH}:${root.id}`, `${CH}:${reply.id}`],
		]);
		expect(calls("addReaction")[1]).toMatchObject({ channelId: root.id, messageId: reply.id });
	});

	test("④ an unmentioned root is dropped as not_addressed", async () => {
		await adapter();
		await transport.emitMessage(message("혼잣말"));
		expect(inbound).toHaveLength(0);
		expect(transport.calls.filter((c) => c.method !== "getChannel")).toHaveLength(0);
		expect(logged("reason=not_addressed")).toBe(true);
	});

	test("④ a mention-free channel takes an unmentioned root", async () => {
		await adapter({ mentionFreeChannels: [CH] });
		const root = message("멘션 없이");
		await transport.emitMessage(root);
		expect(inbound.map((m) => m.originKey)).toEqual([`discord/ch/${CH}/t/${root.id}`]);
	});

	test("④ requireMention: only a mention addresses, in a mention-free channel and in a known thread alike", async () => {
		await adapter({ mentionFreeChannels: [CH], requireMention: true });
		await transport.emitMessage(message("멘션 없이"));
		expect(inbound).toHaveLength(0);
		const root = message(`<@${BOT}> 멘션`);
		await transport.emitMessage(root);
		await transport.emitMessage(message("스레드 안 멘션 없이", { channel_id: root.id }));
		expect(inbound.map((m) => m.text)).toEqual(["멘션"]);
	});

	test("⑤ strangers, bots and servers outside guildIds are never taken", async () => {
		await adapter({ guildIds: [GUILD] });
		await transport.emitMessage(message(`<@${BOT}> 나도`, { author: { id: STRANGER } }));
		await transport.emitMessage(message(`<@${BOT}> 봇 글`, { author: { id: STRANGER, bot: true } }));
		await transport.emitMessage(message(`<@${BOT}> 오너 봇?`, { author: { id: OWNER, bot: true } }));
		await transport.emitMessage(message(`<@${BOT}> 남의 서버`, { guild_id: OTHER_GUILD }));
		await transport.emitMessage(
			message("DM이지만 남", { channel_id: DM, guild_id: undefined, author: { id: STRANGER } }),
		);
		await transport.emitMessage(message(`<@${BOT}> 시스템 글`, { type: 7 }));
		expect(inbound).toHaveLength(0);
		expect(calls("startThread")).toHaveLength(0);
		expect(calls("addReaction")).toHaveLength(0);
		expect(calls("createMessage")).toHaveLength(0);
	});

	test("⑥ a root command stays on the channel origin without a thread and gets 👀 but no status", async () => {
		await adapter();
		const command = message(`<@${BOT}> !model x`);
		await transport.emitMessage(command);
		expect(calls("startThread")).toHaveLength(0);
		expect(inbound.map((m) => [m.originKey, m.threadRef, m.text])).toEqual([
			[`discord/ch/${CH}`, `${CH}:${command.id}`, "!model x"],
		]);
		expect(calls("addReaction")).toHaveLength(1);
		expect(calls("createMessage")).toHaveLength(0);
	});

	test("⑧ !shutup mutes the thread; unmentioned replies stay quiet until a mention releases it", async () => {
		await adapter();
		const root = message(`<@${BOT}> 시작`);
		await transport.emitMessage(root);
		const ref = `${CH}:${root.id}`;
		await transport.emitMessage(message("!shutup", { channel_id: root.id }));
		expect(muted.has(ref)).toBe(true);
		expect(calls("createMessage").some((c) => c.channelId === root.id && c.content?.startsWith("🤫"))).toBe(true);
		await transport.emitMessage(message("조용히 해도 이건?", { channel_id: root.id }));
		expect(inbound).toHaveLength(1);
		expect(logged("reason=thread_muted")).toBe(true);
		await transport.emitMessage(message(`<@${BOT}> 다시 말해`, { channel_id: root.id }));
		expect(muted.has(ref)).toBe(false);
		expect(inbound.map((m) => m.text)).toEqual(["시작", "다시 말해"]);
	});

	test("⑨ a refused thread start takes nothing, logs inbound_failed and leaves a notice in the channel", async () => {
		await adapter();
		transport.failNext.startThread = [
			new DiscordCallError("definitive", "discord_http_403:50013 Missing Permissions", 403, 50013),
		];
		const root = message(`<@${BOT}> 스레드 못 만듦`);
		await transport.emitMessage(root);
		expect(inbound).toHaveLength(0);
		expect(logged("event=inbound_failed")).toBe(true);
		expect(failures).toBe(1);
		const notice = calls("createMessage");
		expect(notice).toHaveLength(1);
		expect(notice[0]?.channelId).toBe(CH);
		expect(notice[0]?.messageReference).toEqual({ messageId: root.id });
	});

	test("a thread Discord already has for the message (160004) is used as is", async () => {
		await adapter();
		transport.failNext.startThread = [
			new DiscordCallError("definitive", "discord_http_400:160004 thread already created", 400, 160004),
		];
		const root = message(`<@${BOT}> 이미 스레드`);
		await transport.emitMessage(root);
		expect(inbound.map((m) => m.threadRef)).toEqual([`${CH}:${root.id}`]);
	});
});

describe("qa50b K-12: a refused thread start retried", () => {
	test("the channel notice is posted once per message, not on every retry", async () => {
		await adapter();
		const refused = () => new DiscordCallError("definitive", "discord_http_403:50013 Missing Permissions", 403, 50013);
		transport.failNext.startThread = [refused(), refused(), refused()];
		const root = message(`<@${BOT}> 스레드 못 만듦`);
		await transport.emitMessage(root);
		await transport.emitMessage(root);
		await transport.emitMessage(root);
		expect(failures).toBe(3);
		expect(calls("createMessage")).toHaveLength(1);
	});
});
