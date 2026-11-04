import { describe, expect, test } from "bun:test";
import { type ChatOriginRef, chatOriginKey, chatPlatformOf, parseChatOrigin } from "../src/core/origin-key";

describe("parseChatOrigin / chatOriginKey", () => {
	const valid: Array<[string, ChatOriginRef]> = [
		["slack/dm/D1", { platform: "slack", kind: "dm", conversationId: "D1" }],
		["slack/ch/C1", { platform: "slack", kind: "ch", conversationId: "C1" }],
		[
			"slack/ch/C1/t/1793316153.495899",
			{ platform: "slack", kind: "ch", conversationId: "C1", threadId: "1793316153.495899" },
		],
		["telegram/dm/42", { platform: "telegram", kind: "dm", conversationId: "42" }],
		["telegram/ch/-1001234/t/5", { platform: "telegram", kind: "ch", conversationId: "-1001234", threadId: "5" }],
		["discord/ch/111/t/222", { platform: "discord", kind: "ch", conversationId: "111", threadId: "222" }],
	];

	test.each(valid)("%s parses and round-trips", (key, ref) => {
		expect(parseChatOrigin(key)).toEqual(ref);
		expect(chatOriginKey(ref)).toBe(key);
		const parsed = parseChatOrigin(key);
		expect(parsed === undefined ? undefined : chatOriginKey(parsed)).toBe(key);
	});

	test.each(["monitor/x", "ompbot/work/a", "slack/ch/", "slack/xx/C1", "slack/ch/C1/t/", "line/dm/1"])(
		"%s is not a chat origin",
		(key) => {
			expect(parseChatOrigin(key)).toBeUndefined();
		},
	);

	test("conversationId is the channel of DM, channel and thread origins; non-chat origins have none", () => {
		expect(parseChatOrigin("slack/ch/C1/t/100.1")?.conversationId).toBe("C1");
		expect(parseChatOrigin("slack/ch/C1")?.conversationId).toBe("C1");
		expect(parseChatOrigin("slack/dm/D1")?.conversationId).toBe("D1");
		expect(parseChatOrigin("ompbot/work/lane")?.conversationId).toBeUndefined();
	});

	test("chatPlatformOf names the namespace even of keys outside the id grammar", () => {
		expect(chatPlatformOf("slack/channel/C1")).toBe("slack");
		expect(chatPlatformOf("telegram/dm/42")).toBe("telegram");
		expect(chatPlatformOf("monitor/3")).toBeUndefined();
		expect(chatPlatformOf("slack")).toBeUndefined();
	});
});
