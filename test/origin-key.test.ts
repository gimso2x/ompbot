import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { platformOfThreadRef } from "../src/core/normalize";
import {
	type ChatOriginRef,
	chatOriginKey,
	chatPlatformOf,
	GRAMMAR,
	parseChatOrigin,
	platformOfConversationId,
} from "../src/core/origin-key";

describe("platformOfConversationId / platformOfThreadRef", () => {
	test.each([
		["C0ESCALATE1", "slack"],
		["D1", "slack"],
		["G0123", "slack"],
		["U1", "slack"],
		["123456789012345678", "discord"],
		["", undefined],
		["-1001", undefined],
		["c1", undefined],
		["C-1", undefined],
	])("%p → %p", (id, platform) => {
		expect(platformOfConversationId(id)).toBe(platform as "slack" | "discord" | undefined);
	});

	test("a thread ref's conversation decides its platform; a ref without a colon has none", () => {
		expect(platformOfThreadRef("C1:1.2")).toBe("slack");
		expect(platformOfThreadRef("D1:-")).toBe("slack");
		expect(platformOfThreadRef("111:222")).toBe("discord");
		expect(platformOfThreadRef("nocolon")).toBeUndefined();
	});

	test("a Slack origin whose conversation starts with a digit is not a Slack key", () => {
		expect(parseChatOrigin("slack/ch/123")).toBeUndefined();
		expect(parseChatOrigin("slack/dm/1D")).toBeUndefined();
	});

	test("the platform answer is GRAMMAR's conversation pattern itself, so parseChatOrigin and it never disagree", () => {
		for (const id of ["C0ESCALATE1", "D1", "U1", "123456789012345678", "", "-1001", "c1", "C-1", "1D"]) {
			const platform = platformOfConversationId(id);
			expect(GRAMMAR.slack.conversation.test(id)).toBe(platform === "slack");
			expect(GRAMMAR.discord.conversation.test(id)).toBe(platform === "discord");
			if (platform !== undefined) expect(parseChatOrigin(`${platform}/dm/${id}`)?.platform).toBe(platform);
		}
	});

	test("no file in src defines its own Slack conversation-id pattern", () => {
		const root = join(import.meta.dir, "..", "src");
		const files = (readdirSync(root, { recursive: true }) as string[]).filter((file) => file.endsWith(".ts"));
		const owners = files.filter((file) => readFileSync(join(root, file), "utf8").includes("/^[A-Z][A-Z0-9]+$/"));
		expect(owners).toEqual(["core/origin-key.ts"]);
	});
});

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
