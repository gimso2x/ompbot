import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/log";
import { redact } from "../src/redact";
import { SlackAdapter } from "../src/slack/adapter";
import type { SlackMessageEvent } from "../src/slack/transport";
import { FakeSlackTransport } from "./helpers/slack-fake-transport";

const OWNER = "UOWNER";
const BOT = "UBOT";
const CHANNEL = "C0123456789";

/** Media roots made by `makeAdapter`; removed after each test so a failing assertion leaks none. */
const mediaRoots: string[] = [];

afterEach(() => {
	for (const dir of mediaRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeAdapter(channel: string): {
	adapter: SlackAdapter;
	transport: FakeSlackTransport;
	recorded: string[];
	origins: string[];
	mediaRoot: string;
	knownThreads: Set<string>;
} {
	const transport = new FakeSlackTransport(BOT);
	const recorded: string[] = [];
	const origins: string[] = [];
	const knownThreads = new Set<string>();
	const mediaRoot = mkdtempSync(join(tmpdir(), "ompbot-mention-free-"));
	mediaRoots.push(mediaRoot);
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
		},
		deliveries: { claimDue: () => [], confirm: () => undefined, fail: () => undefined, defer: () => undefined },
		ownerUserId: OWNER,
		clock: { now: () => 1_000 },
		log: createLogger({ sink: () => undefined, clock: { now: () => 0 }, redact }),
		mediaRoot,
		mentionFreeChannels: [channel],
	});
	void adapter.start();
	return { adapter, transport, recorded, origins, mediaRoot, knownThreads };
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
