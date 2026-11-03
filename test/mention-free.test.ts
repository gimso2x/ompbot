import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/log";
import { redact } from "../src/redact";
import { SlackAdapter } from "../src/slack/adapter";
import { FakeSlackTransport } from "../src/slack/fake-transport";
import type { SlackMessageEvent } from "../src/slack/transport";

const OWNER = "UOWNER";
const BOT = "UBOT";
const CHANNEL = "C0123456789";

function makeAdapter(channel: string): {
	adapter: SlackAdapter;
	transport: FakeSlackTransport;
	recorded: string[];
	origins: string[];
	mediaRoot: string;
	mutes: Set<string>;
	knownThreads: Set<string>;
} {
	const transport = new FakeSlackTransport(BOT);
	const recorded: string[] = [];
	const origins: string[] = [];
	const mutes = new Set<string>();
	const knownThreads = new Set<string>();
	/** Stand-in for the daemon's ledger KV markers (`mute:<platformMessageId>`). */
	const handledMuteCommands = new Set<string>();
	const mediaRoot = mkdtempSync(join(tmpdir(), "ompbot-mention-free-"));
	const adapter = new SlackAdapter({
		transport,
		core: {
			onInbound: (message) => {
				recorded.push(message.text);
				origins.push(message.originKey);
				return { duplicate: false };
			},
			onCommand: () => "",
			onAction: () => undefined,
			knowsThread: (threadRef) => knownThreads.has(threadRef),
			isThreadMuted: (threadRef) => mutes.has(threadRef),
			setThreadMute: (threadRef, muted) => {
				if (muted) mutes.add(threadRef);
				else mutes.delete(threadRef);
			},
			seenMuteCommand: (platformMessageId) => handledMuteCommands.has(platformMessageId),
			rememberMuteCommand: (platformMessageId) => handledMuteCommands.add(platformMessageId),
		},
		deliveries: { claimDue: () => [], confirm: () => undefined, fail: () => undefined },
		ownerUserId: OWNER,
		clock: { now: () => 1_000 },
		log: createLogger({ sink: () => undefined, clock: { now: () => 0 }, redact }),
		mediaRoot,
		mentionFreeChannels: [channel],
	});
	void adapter.start();
	return { adapter, transport, recorded, origins, mediaRoot, mutes, knownThreads };
}

function channelMessage(text: string, user = OWNER): SlackMessageEvent {
	return { type: "message", channel: CHANNEL, channel_type: "channel", user, text, ts: "1000.000100" };
}

describe("mention-free channels", () => {
	test("the owner's plain message in a mention-free channel is recorded without a mention", async () => {
		const { adapter, recorded } = makeAdapter(CHANNEL);
		const outcome = await adapter.ingestRecovered(channelMessage("빌드 상태 어때"));
		expect(outcome).toBe("recorded");
		expect(recorded).toEqual(["빌드 상태 어때"]);
	});

	test("another channel still requires addressing", async () => {
		const { adapter } = makeAdapter(CHANNEL);
		const outcome = await adapter.ingestRecovered({ ...channelMessage("다른 채널"), channel: "COTHER" });
		expect(outcome).toBe("dropped");
	});

	test("a non-owner's message in the mention-free channel is still dropped", async () => {
		const { adapter, recorded } = makeAdapter(CHANNEL);
		const outcome = await adapter.ingestRecovered(channelMessage("침투", "UINTRUDER"));
		expect(outcome).toBe("dropped");
		expect(recorded).toEqual([]);
	});

	test("attachments in the mention-free channel are downloaded like anywhere else", async () => {
		const { adapter, transport, recorded } = makeAdapter(CHANNEL);
		transport.downloads.set("https://files.slack.com/files-pri/F1/log.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
		const event: SlackMessageEvent = {
			...channelMessage(""),
			subtype: "file_share",
			files: [
				{
					id: "F1",
					name: "log.png",
					mimetype: "image/png",
					url_private_download: "https://files.slack.com/files-pri/F1/log.png",
				},
			],
		};
		const outcome = await adapter.ingestRecovered(event);
		expect(outcome).toBe("recorded");
		expect(recorded[0]).toContain("[첨부:");
	});
});

describe("thread mutes (!shutup / !unshutup)", () => {
	test("!shutup in a mention-free channel thread mutes only that thread, confirms in-thread and takes no turn", async () => {
		const { adapter, transport, recorded, mutes } = makeAdapter(CHANNEL);
		const outcome = await adapter.ingestRecovered({ ...channelMessage("!shutup"), thread_ts: "1000.000200" });
		expect(outcome).toBe("recorded");
		expect(recorded).toEqual([]);
		expect(mutes.has(`${CHANNEL}:1000.000200`)).toBe(true);
		expect(transport.calls.find((c) => c.method === "postMessage")).toMatchObject({
			channel: CHANNEL,
			threadTs: "1000.000200",
		});
	});

	test("messages in the muted thread are dropped; other threads of the same channel still answer", async () => {
		const { adapter, recorded } = makeAdapter(CHANNEL);
		await adapter.ingestRecovered({ ...channelMessage("!shutup"), thread_ts: "1000.000200" });
		expect(
			await adapter.ingestRecovered({ ...channelMessage("메모"), thread_ts: "1000.000200", ts: "1000.000300" }),
		).toBe("dropped");
		expect(recorded).toEqual([]);
		expect(
			await adapter.ingestRecovered({ ...channelMessage("다른 스레드"), thread_ts: "1000.000900", ts: "1000.000901" }),
		).toBe("recorded");
		expect(recorded).toEqual(["다른 스레드"]);
	});

	test("a top-level !shutup mutes its own thread, so replies under it are quiet", async () => {
		const { adapter, recorded, mutes } = makeAdapter(CHANNEL);
		await adapter.ingestRecovered({ ...channelMessage("!shutup"), ts: "1000.000400" });
		expect(mutes.has(`${CHANNEL}:1000.000400`)).toBe(true);
		expect(
			await adapter.ingestRecovered({
				...channelMessage("이어지는 메모"),
				thread_ts: "1000.000400",
				ts: "1000.000500",
			}),
		).toBe("dropped");
		expect(recorded).toEqual([]);
	});

	test("mentioning the bot in the muted thread releases the mute and the message becomes a normal turn", async () => {
		const { adapter, recorded, mutes } = makeAdapter(CHANNEL);
		await adapter.ingestRecovered({ ...channelMessage("!shutup"), thread_ts: "1000.000200" });
		const outcome = await adapter.ingestRecovered({
			...channelMessage(`<@${BOT}> 이제 다시 말해줘`),
			thread_ts: "1000.000200",
			ts: "1000.000600",
		});
		expect(outcome).toBe("recorded");
		expect(recorded).toEqual(["이제 다시 말해줘"]);
		expect(mutes.has(`${CHANNEL}:1000.000200`)).toBe(false);
	});

	test("!unshutup works from inside the muted thread", async () => {
		const { adapter, transport, recorded, mutes } = makeAdapter(CHANNEL);
		await adapter.ingestRecovered({ ...channelMessage("!shutup"), thread_ts: "1000.000200" });
		expect(
			await adapter.ingestRecovered({ ...channelMessage("!unshutup"), thread_ts: "1000.000200", ts: "1000.000700" }),
		).toBe("recorded");
		expect(mutes.has(`${CHANNEL}:1000.000200`)).toBe(false);
		const notices = transport.calls.filter((c) => c.method === "postMessage");
		expect(notices.at(-1)).toMatchObject({ channel: CHANNEL, threadTs: "1000.000200" });
		expect(notices.at(-1)?.text).toContain("해제");
		expect(
			await adapter.ingestRecovered({ ...channelMessage("돌아왔나"), thread_ts: "1000.000200", ts: "1000.000800" }),
		).toBe("recorded");
		expect(recorded).toEqual(["돌아왔나"]);
	});

	test("!unshutup on a thread that is not muted only says so", async () => {
		const { adapter, transport, mutes } = makeAdapter(CHANNEL);
		expect(await adapter.ingestRecovered({ ...channelMessage("!unshutup"), thread_ts: "1000.000200" })).toBe(
			"recorded",
		);
		expect(mutes.size).toBe(0);
		expect(transport.calls.find((c) => c.method === "postMessage")?.text).toContain("뮤트되어 있지 않습니다");
	});

	test("a non-owner cannot mute: !shutup from another user is dropped", async () => {
		const { adapter, recorded, mutes, transport } = makeAdapter(CHANNEL);
		const outcome = await adapter.ingestRecovered({
			...channelMessage("!shutup", "UINTRUDER"),
			thread_ts: "1000.000200",
		});
		expect(outcome).toBe("dropped");
		expect(mutes.size).toBe(0);
		expect(recorded).toEqual([]);
		expect(transport.count("postMessage")).toBe(0);
	});

	test("a bot-participated thread in a regular (non mention-free) channel can be muted too", async () => {
		const { adapter, recorded, mutes, knownThreads } = makeAdapter(CHANNEL);
		knownThreads.add("COTHER:1000.000800");
		const reply = (text: string, ts: string): SlackMessageEvent => ({
			type: "message",
			channel: "COTHER",
			channel_type: "channel",
			user: OWNER,
			text,
			ts,
			thread_ts: "1000.000800",
		});
		expect(await adapter.ingestRecovered(reply("!shutup", "1000.000801"))).toBe("recorded");
		expect(mutes.has("COTHER:1000.000800")).toBe(true);
		expect(await adapter.ingestRecovered(reply("계속 작업", "1000.000802"))).toBe("dropped");
		expect(recorded).toEqual([]);
	});

	test("!shutup in an unaddressed thread of a regular channel stays ignored (no mute, no reply)", async () => {
		const { adapter, recorded, mutes, transport } = makeAdapter(CHANNEL);
		const outcome = await adapter.ingestRecovered({
			...channelMessage("!shutup"),
			channel: "COTHER",
			thread_ts: "1000.000800",
		});
		expect(outcome).toBe("dropped");
		expect(mutes.size).toBe(0);
		expect(recorded).toEqual([]);
		expect(transport.count("postMessage")).toBe(0);
	});

	test("!shutup with trailing words is an ordinary prompt, not a command", async () => {
		const { adapter, recorded, mutes } = makeAdapter(CHANNEL);
		const outcome = await adapter.ingestRecovered({ ...channelMessage("!shutup 지금 당장"), thread_ts: "1000.000200" });
		expect(outcome).toBe("recorded");
		expect(recorded).toEqual(["!shutup 지금 당장"]);
		expect(mutes.size).toBe(0);
	});

	test("a backfill replay of the same !shutup event posts the notice exactly once", async () => {
		const { adapter, transport, mutes } = makeAdapter(CHANNEL);
		const event = { ...channelMessage("!shutup"), thread_ts: "1000.000200" };
		expect(await adapter.ingestRecovered(event)).toBe("recorded");
		expect(await adapter.ingestRecovered({ ...event })).toBe("duplicate");
		expect(mutes.has(`${CHANNEL}:1000.000200`)).toBe(true);
		expect(transport.count("postMessage")).toBe(1);
	});

	test("!shutup in the DM gets a hint instead of a mute", async () => {
		const { adapter, transport, recorded, mutes } = makeAdapter(CHANNEL);
		const outcome = await adapter.ingestRecovered({
			type: "message",
			channel: "D1",
			channel_type: "im",
			user: OWNER,
			text: "!shutup",
			ts: "1000.000700",
		});
		expect(outcome).toBe("recorded");
		expect(recorded).toEqual([]);
		expect(mutes.size).toBe(0);
		expect(transport.calls.find((c) => c.method === "postMessage")).toMatchObject({
			channel: "D1",
			threadTs: "1000.000700",
		});
	});
});

describe("thread-scoped sessions in a mention-free channel", () => {
	test("unaddressed thread replies route to the thread's own origin and continue that session", async () => {
		const { adapter, recorded, origins } = makeAdapter(CHANNEL);
		await adapter.ingestRecovered({
			...channelMessage("첫 질문"),
			thread_ts: "1000.000200",
			ts: "1000.000201",
		});
		await adapter.ingestRecovered({
			...channelMessage("후속 질문"),
			thread_ts: "1000.000200",
			ts: "1000.000300",
		});
		// Both replies are audible (mention-free) and both land in the SAME thread session.
		expect(recorded).toEqual(["첫 질문", "후속 질문"]);
		expect(origins).toEqual([`slack/ch/${CHANNEL}/t/1000.000200`, `slack/ch/${CHANNEL}/t/1000.000200`]);
	});
});
