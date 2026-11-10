import { describe, expect, test } from "bun:test";
import type { ChannelPort, PostTarget } from "../src/channel/port";
import { ChannelRegistry } from "../src/channel/registry";
import type { ChatPlatform } from "../src/core/origin-key";
import { REDACTED } from "../src/redact";
import { SlackChannel } from "../src/slack/channel";
import { FakeSlackTransport } from "../src/slack/fake-transport";

// Assembled at run time so no token-shaped literal sits in the source (gitleaks).
const token = ["xo", "xb-", "1234567890", "-abcdefghijKLMNOP"].join("");

function setup() {
	const transport = new FakeSlackTransport();
	const registry = new ChannelRegistry();
	registry.register(new SlackChannel(transport));
	return { transport, registry, port: registry.get("slack") };
}

describe("ChannelRegistry", () => {
	test("post, edit and an upload comment reach the adapter redacted", async () => {
		const { transport, port } = setup();
		const ref = await port.post({ conversationId: "C1" }, { text: `토큰 ${token}` });
		await port.edit(ref, { text: `고침 ${token}` });
		await port.uploadFile(
			{ conversationId: "C1" },
			{ path: "/tmp/a.txt", title: `제목 ${token}`, comment: `설명 ${token}` },
		);

		const seen = JSON.stringify(transport.calls);
		expect(seen).not.toContain(token);
		expect(
			transport.calls.map((call) => ("text" in call ? call.text : call.method === "uploadFile" ? call.comment : "")),
		).toEqual([`토큰 ${REDACTED}`, `고침 ${REDACTED}`, `설명 ${REDACTED}`]);
		const upload = transport.calls[2];
		expect(upload?.method === "uploadFile" ? upload.title : "").toBe(`제목 ${REDACTED}`);
	});

	test("forOrigin resolves a chat origin to its port and target; other origins have none", () => {
		const { registry, port } = setup();
		const resolved = registry.forOrigin("slack/ch/C1/t/1.2");
		expect(resolved?.port).toBe(port);
		expect(resolved?.port.platform).toBe("slack");
		expect(resolved?.target).toEqual({ conversationId: "C1", threadId: "1.2" });
		expect(registry.forOrigin("monitor/x")).toBeUndefined();
		expect(registry.forOrigin("telegram/dm/42")).toBeUndefined();
	});
});

/** A second platform's port that records what reached it. */
function fakePort(platform: ChatPlatform): ChannelPort & { posts: Array<{ target: PostTarget; text: string }> } {
	const posts: Array<{ target: PostTarget; text: string }> = [];
	return {
		platform,
		capabilities: { permalink: false, reactions: true },
		posts,
		post: async (target, msg) => {
			posts.push({ target, text: msg.text });
			return { platform, conversationId: target.conversationId, messageId: String(posts.length) };
		},
		edit: async () => undefined,
		react: async () => undefined,
		uploadFile: async () => ({ fileId: "F1" }),
		permalink: async () => undefined,
		mentionUser: (userId) => `<@${userId}>`,
	};
}

describe("ChannelRegistry routing by thread ref and conversation id", () => {
	function twoPlatforms() {
		const slack = fakePort("slack");
		const discord = fakePort("discord");
		const registry = new ChannelRegistry();
		registry.register(slack);
		registry.register(discord);
		return { registry, slack, discord };
	}

	test("forThreadRef picks the platform's port and splits the target", () => {
		const { registry } = twoPlatforms();
		const slack = registry.forThreadRef("C1:1.2");
		expect(slack?.port.platform).toBe("slack");
		expect(slack?.target).toEqual({ conversationId: "C1", threadId: "1.2" });
		const discord = registry.forThreadRef("111111111111111111:222222222222222222");
		expect(discord?.port.platform).toBe("discord");
		expect(discord?.target).toEqual({ conversationId: "111111111111111111", threadId: "222222222222222222" });
		const top = registry.forThreadRef("D1:-");
		expect(top?.port.platform).toBe("slack");
		expect(top?.target).toEqual({ conversationId: "D1" });
		expect(top !== undefined && "threadId" in top.target).toBe(false);
	});

	test("an unregistered platform and a malformed ref resolve to nothing", () => {
		const slackOnly = new ChannelRegistry();
		slackOnly.register(fakePort("slack"));
		expect(slackOnly.forThreadRef("111111111111111111:222222222222222222")).toBeUndefined();
		expect(slackOnly.forConversation("111111111111111111")).toBeUndefined();
		const { registry } = twoPlatforms();
		expect(registry.forThreadRef("nocolon")).toBeUndefined();
		expect(registry.forConversation("c-1")).toBeUndefined();
	});

	test("forConversation picks the port by the id's grammar", () => {
		const { registry } = twoPlatforms();
		expect(registry.forConversation("C0ESCALATE1")).toMatchObject({
			port: { platform: "slack" },
			target: { conversationId: "C0ESCALATE1" },
		});
		expect(registry.forConversation("123456789012345678")?.port.platform).toBe("discord");
	});

	test("both ports get a token-shaped string redacted", async () => {
		const { registry, slack, discord } = twoPlatforms();
		const toSlack = registry.forThreadRef("C1:1.2");
		const toDiscord = registry.forThreadRef("111111111111111111:222222222222222222");
		await toSlack?.port.post(toSlack.target, { text: `토큰 ${token}` });
		await toDiscord?.port.post(toDiscord.target, { text: `토큰 ${token}` });
		expect(slack.posts.map((p) => p.text)).toEqual([`토큰 ${REDACTED}`]);
		expect(discord.posts.map((p) => p.text)).toEqual([`토큰 ${REDACTED}`]);
	});
});
