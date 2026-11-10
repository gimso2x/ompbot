import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { fromDiscordEmoji, toDiscordEmoji, UnknownEmojiError } from "../src/discord/emoji";
import { FakeDiscordTransport } from "../src/discord/fake-transport";
import { FileFakeDiscordTransport } from "../src/discord/test-transport";
import type {
	DiscordHandlers,
	DiscordInteraction,
	DiscordMessageEvent,
	DiscordReactionEvent,
} from "../src/discord/transport";
import { DiscordCallError } from "../src/discord/transport";
import { STATUS_REACTIONS } from "../src/tasks/notify";

const CHANNEL = "111111111111111111";

function recordingHandlers(): {
	handlers: DiscordHandlers;
	messages: DiscordMessageEvent[];
	reactions: DiscordReactionEvent[];
	interactions: DiscordInteraction[];
} {
	const messages: DiscordMessageEvent[] = [];
	const reactions: DiscordReactionEvent[] = [];
	const interactions: DiscordInteraction[] = [];
	return {
		messages,
		reactions,
		interactions,
		handlers: {
			message: async (event) => {
				messages.push(event);
			},
			reaction: async (event) => {
				reactions.push(event);
			},
			interaction: async (interaction) => {
				interactions.push(interaction);
			},
		},
	};
}

describe("FakeDiscordTransport contract", () => {
	test("start resolves the bot and application ids; posted message ids are numeric and strictly increasing", async () => {
		const fake = new FakeDiscordTransport({ botUserId: "500000000000000001", applicationId: "600000000000000001" });
		const started = await fake.start(recordingHandlers().handlers);
		expect(started).toEqual({ botUserId: "500000000000000001", applicationId: "600000000000000001" });
		const a = await fake.createMessage({ channelId: CHANNEL, content: "one" });
		const b = await fake.createMessage({ channelId: CHANNEL, content: "two" });
		const c = await fake.uploadFile({ channelId: CHANNEL, filePath: "/tmp/x.txt", content: "file" });
		for (const id of [a.id, b.id, c.id]) expect(id).toMatch(/^[0-9]+$/);
		expect(a.id).toBe("900000000000000001");
		expect(BigInt(b.id)).toBeGreaterThan(BigInt(a.id));
		expect(BigInt(c.id)).toBeGreaterThan(BigInt(b.id));
	});

	test("edit, delete, reactions, thread creation, upload and interaction replies land in the call log", async () => {
		const fake = new FakeDiscordTransport();
		await fake.start(recordingHandlers().handlers);
		const posted = await fake.createMessage({
			channelId: CHANNEL,
			content: "hi",
			messageReference: { messageId: "222222222222222222" },
			allowedMentions: { parse: [] },
		});
		await fake.editMessage({ channelId: CHANNEL, messageId: posted.id, content: "edited", components: [] });
		await fake.addReaction({ channelId: CHANNEL, messageId: posted.id, emoji: "👀" });
		await fake.removeReaction({ channelId: CHANNEL, messageId: posted.id, emoji: "👀" });
		const thread = await fake.startThread({ channelId: CHANNEL, messageId: posted.id, name: "질문" });
		await fake.uploadFile({ channelId: thread.id, filePath: "/tmp/report.md", content: "보고서" });
		await fake.deleteMessage({ channelId: CHANNEL, messageId: posted.id });
		await fake.respondInteraction({ interactionId: "1", token: "tok", response: { type: 6 } });
		await fake.editInteractionResponse({ token: "tok", content: "done" });
		await fake.deleteInteractionResponse({ token: "tok" });

		expect(fake.calls.map((call) => call.method)).toEqual([
			"createMessage",
			"editMessage",
			"addReaction",
			"removeReaction",
			"startThread",
			"uploadFile",
			"deleteMessage",
			"respondInteraction",
			"editInteractionResponse",
			"deleteInteractionResponse",
		]);
		expect(fake.calls[0]).toMatchObject({
			method: "createMessage",
			channelId: CHANNEL,
			content: "hi",
			messageReference: { messageId: "222222222222222222" },
			allowedMentions: { parse: [] },
			id: posted.id,
		});
		expect(fake.calls[1]).toMatchObject({
			method: "editMessage",
			messageId: posted.id,
			content: "edited",
			components: [],
		});
		expect(fake.calls[2]).toMatchObject({ method: "addReaction", messageId: posted.id, emoji: "👀" });
		expect(fake.calls[5]).toMatchObject({ method: "uploadFile", channelId: thread.id, filePath: "/tmp/report.md" });
		expect(fake.count("createMessage")).toBe(1);
	});

	test("a thread started from a message has the message's id and is a thread channel under the parent", async () => {
		const fake = new FakeDiscordTransport();
		fake.setChannel({ id: CHANNEL, type: 0, guildId: "333333333333333333" });
		const thread = await fake.startThread({ channelId: CHANNEL, messageId: "444444444444444444", name: "t" });
		expect(thread.id).toBe("444444444444444444");
		expect(await fake.getChannel(thread.id)).toEqual({
			id: "444444444444444444",
			type: 11,
			parentId: CHANNEL,
			guildId: "333333333333333333",
		});
		expect(await fake.getChannel(CHANNEL)).toEqual({ id: CHANNEL, type: 0, guildId: "333333333333333333" });
	});

	test("an unknown channel is a definitive error; failNext queues one error for the method's next call", async () => {
		const fake = new FakeDiscordTransport();
		await expect(fake.getChannel("999")).rejects.toBeInstanceOf(DiscordCallError);
		fake.failNext.createMessage = [new DiscordCallError("ambiguous", "boom")];
		await expect(fake.createMessage({ channelId: CHANNEL, content: "x" })).rejects.toThrow("boom");
		expect((await fake.createMessage({ channelId: CHANNEL, content: "y" })).id).toMatch(/^[0-9]+$/);
		// Like FakeSlackTransport, a failed call is still in the log.
		expect(fake.count("createMessage")).toBe(2);
	});

	test("listMessages pages a canned history after a snowflake watermark, oldest first", async () => {
		const fake = new FakeDiscordTransport();
		const message = (id: string): DiscordMessageEvent => ({
			id,
			channel_id: CHANNEL,
			author: { id: "1" },
			content: id,
			type: 0,
		});
		fake.history.set(CHANNEL, [message("98"), message("100"), message("1000")]);
		const page = await fake.listMessages({ channelId: CHANNEL, after: "99", limit: 1 });
		expect(page.map((m) => m.id)).toEqual(["100"]);
		const rest = await fake.listMessages({ channelId: CHANNEL, after: "100" });
		expect(rest.map((m) => m.id)).toEqual(["1000"]);
	});

	test("emitMessage, emitReaction and emitInteraction reach the handlers registered at start", async () => {
		const fake = new FakeDiscordTransport();
		const rec = recordingHandlers();
		await fake.start(rec.handlers);
		const message: DiscordMessageEvent = {
			id: "700000000000000001",
			channel_id: CHANNEL,
			author: { id: "800000000000000001" },
			content: "안녕",
			type: 0,
		};
		const reaction: DiscordReactionEvent = {
			type: "add",
			user_id: "800000000000000001",
			channel_id: CHANNEL,
			message_id: "700000000000000001",
			emoji: { id: null, name: "👍" },
		};
		const interaction: DiscordInteraction = {
			id: "1",
			application_id: "2",
			type: 3,
			token: "tok",
			channel_id: CHANNEL,
			data: { custom_id: "ompbot:approval:approve:C:1", component_type: 2 },
		};
		await fake.emitMessage(message);
		await fake.emitReaction(reaction);
		await fake.emitInteraction(interaction);
		expect(rec.messages).toEqual([message]);
		expect(rec.reactions).toEqual([reaction]);
		expect(rec.interactions).toEqual([interaction]);
		await fake.stop();
		await fake.emitMessage(message);
		expect(rec.messages).toHaveLength(1);
	});
});

describe("FileFakeDiscordTransport", () => {
	test("logs every call as JSONL and resumes message ids across instances", async () => {
		const dir = mkdtempSync(join(tmpdir(), "discord-file-transport-"));
		try {
			const path = join(dir, "calls.jsonl");
			const first = new FileFakeDiscordTransport(path);
			const a = await first.createMessage({ channelId: CHANNEL, content: "a" });
			await first.addReaction({ channelId: CHANNEL, messageId: a.id, emoji: "👀" });
			const second = new FileFakeDiscordTransport(path);
			const b = await second.createMessage({ channelId: CHANNEL, content: "b" });
			expect(BigInt(b.id)).toBeGreaterThan(BigInt(a.id));
			const lines = readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { method: string });
			expect(lines.map((line) => line.method)).toEqual(["createMessage", "addReaction", "createMessage"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/** Every Slack reaction name the code outside src/discord/ sends: literal reaction names, final marks, task statuses. */
async function slackEmojiNamesInSrc(): Promise<Set<string>> {
	const names = new Set<string>(Object.values(STATUS_REACTIONS));
	const patterns = [/(?:addReaction|removeReaction)\(\{[^)]*?name: "([^"]+)"/g, /\bmark: "([^"]+)"/g];
	for await (const file of new Glob("src/**/*.ts").scan(".")) {
		if (file.startsWith("src/discord/")) continue;
		const source = await Bun.file(file).text();
		for (const pattern of patterns) for (const match of source.matchAll(pattern)) if (match[1]) names.add(match[1]);
	}
	return names;
}

describe("emoji table", () => {
	test("every Slack emoji name used in src maps to a unicode emoji", async () => {
		const names = await slackEmojiNamesInSrc();
		for (const known of ["eyes", "white_check_mark", "x", "warning", "hourglass_flowing_sand", "mag", "construction"]) {
			expect(names.has(known)).toBe(true);
		}
		for (const name of names) {
			const unicode = toDiscordEmoji(name);
			expect(unicode).not.toBe(name);
			expect(unicode).not.toMatch(/[a-z_]/);
		}
		expect(toDiscordEmoji("eyes")).toBe("👀");
		expect(toDiscordEmoji("white_check_mark")).toBe("✅");
		expect(toDiscordEmoji("hourglass_flowing_sand")).toBe("⏳");
	});

	test("a name missing from the table is an error, not a silent skip", () => {
		expect(() => toDiscordEmoji("tada")).toThrow(UnknownEmojiError);
		expect(() => toDiscordEmoji("")).toThrow(UnknownEmojiError);
	});

	test("inbound reaction emoji map back to Slack names; 👍/👎 (any skin tone) become +1/-1", () => {
		expect(fromDiscordEmoji("👍")).toBe("+1");
		expect(fromDiscordEmoji("👎")).toBe("-1");
		expect(fromDiscordEmoji("👍🏽")).toBe("+1");
		expect(fromDiscordEmoji("⚠️")).toBe("warning");
		expect(fromDiscordEmoji("⚠")).toBe("warning");
		expect(fromDiscordEmoji("🦀")).toBeUndefined();
		expect(fromDiscordEmoji(null)).toBeUndefined();
	});
});
