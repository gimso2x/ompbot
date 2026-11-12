// Discord cards (doc/plans/discord-channel.md §10): an OutboundMessage card (title/body/fields) and a ```card fence in
// an answer both go out as one embed, within Discord's embed limits; an invalid fence stays a code block.
import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { CoreSink, DeliveryItem, DeliverySource } from "../src/channel/types";
import { DiscordAdapter } from "../src/discord/adapter";
import * as discordCard from "../src/discord/card";
import { DiscordChannel } from "../src/discord/channel";
import { createLogger } from "../src/log";
import { redact } from "../src/redact";
import { CARD_SKELETONS } from "../src/safety/prompt";
import { type FakeDiscordCall, FakeDiscordTransport } from "./helpers/discord-fake-transport";

const OWNER = "100000000000000001";
const BOT = "500000000000000000";
const GUILD = "300000000000000001";
const CH = "111111111111111111";

const el = (type: string, props: Record<string, unknown> = {}, children: string[] = []) => ({ type, props, children });
const spec = (elements: Record<string, unknown>, root = "c"): string => JSON.stringify({ root, elements });
const fence = (json: string): string => `\`\`\`card\n${json}\n\`\`\``;

interface Embed {
	title?: string;
	description?: string;
	fields?: Array<{ name: string; value: string; inline?: boolean }>;
	image?: { url: string };
	color?: number;
}

type Create = Extract<FakeDiscordCall, { method: "createMessage" }>;

let transport: FakeDiscordTransport;
let channel: DiscordChannel;
let logs: string[];
let queue: DeliveryItem[];
let confirmed: number[];

const embedsOf = (call: { embeds?: readonly unknown[] | undefined } | undefined): Embed[] =>
	(call?.embeds ?? []) as Embed[];
const creates = (): Create[] => transport.calls.filter((c): c is Create => c.method === "createMessage");
const embedLength = (embed: Embed): number =>
	(embed.title ?? "").length +
	(embed.description ?? "").length +
	(embed.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0);

const source: DeliverySource = {
	claimDue: () => queue.splice(0),
	confirm: (id) => void confirmed.push(id),
	fail: () => {},
	defer: () => {},
};
const core: CoreSink = { onInbound: () => undefined, onCommand: () => undefined, onAction: () => {} };

async function deliver(body: string): Promise<Create[]> {
	const adapter = new DiscordAdapter({
		channel,
		core,
		deliveries: source,
		ownerUserId: OWNER,
		clock: { now: () => 1_800_000_000_000 },
		log: createLogger({ sink: (line) => logs.push(line), clock: { now: () => 0 }, redact }),
	});
	await adapter.start();
	queue.push({ deliveryId: 1, originKey: "monitor/x", threadRef: `${CH}:-`, body, redelivered: false });
	expect(await adapter.pumpDeliveries()).toBe(1);
	expect(confirmed).toEqual([1]);
	return creates();
}

beforeEach(() => {
	transport = new FakeDiscordTransport({ botUserId: BOT });
	transport.setChannel({ id: CH, type: 0, guildId: GUILD });
	channel = new DiscordChannel(transport, { ownerUserId: OWNER });
	logs = [];
	queue = [];
	confirmed = [];
});

describe("OutboundMessage card → one embed", () => {
	test("title, body and fields become the embed; text is the content (the notification line)", async () => {
		await channel.post(
			{ conversationId: CH },
			{
				text: "🔐 승인 요청 알림",
				title: "🔐 승인 요청",
				body: "*force push* main",
				fields: [
					{ label: "작업", value: "git push -f" },
					{ label: "영향", value: "이력 덮어씀" },
				],
			},
		);
		const [post] = creates();
		expect(creates()).toHaveLength(1);
		expect(post?.content).toBe("🔐 승인 요청 알림");
		const embeds = embedsOf(post);
		expect(embeds).toHaveLength(1);
		expect(embeds[0]?.title).toBe("🔐 승인 요청");
		expect(embeds[0]?.description).toBe("**force push** main");
		expect(embeds[0]?.fields?.map((f) => [f.name, f.value])).toEqual([
			["작업", "git push -f"],
			["영향", "이력 덮어씀"],
		]);
	});

	test("buttons go with the embed in the same message", async () => {
		await channel.post(
			{ conversationId: CH },
			{
				text: "승인 요청",
				title: "승인 요청",
				body: "x",
				buttons: [
					{ label: "승인", actionId: "ompbot:approval:approve:C1:1", style: "primary" },
					{ label: "거부", actionId: "ompbot:approval:deny:C1:1", style: "danger" },
				],
			},
		);
		expect(creates()).toHaveLength(1);
		const [post] = creates();
		expect(embedsOf(post)).toHaveLength(1);
		expect(post?.components).toHaveLength(1);
	});

	test("an edit of a card sends the embed too", async () => {
		const ref = await channel.post({ conversationId: CH }, { text: "t", title: "제목", body: "본문", buttons: [] });
		await channel.edit(ref, { text: "t\n✅ 승인됨", title: "제목", body: "본문", buttons: [] });
		const edit = transport.calls.find((c) => c.method === "editMessage") as Extract<
			FakeDiscordCall,
			{ method: "editMessage" }
		>;
		expect(edit.content).toContain("✅ 승인됨");
		expect(embedsOf(edit)[0]?.title).toBe("제목");
		expect(edit.components).toEqual([]);
	});

	test("a card redrawn plain with buttons (an expired approval) drops the old embed, like Slack's blocks: []", async () => {
		const ref = await channel.post({ conversationId: CH }, { text: "t", title: "제목", body: "본문", buttons: [] });
		await channel.edit(ref, { text: "⌛ 만료됨", buttons: [] });
		const edit = transport.calls.find((c) => c.method === "editMessage") as Extract<
			FakeDiscordCall,
			{ method: "editMessage" }
		>;
		expect(edit.embeds).toEqual([]);
		expect(edit.components).toEqual([]);
	});

	test("over-limit values are cut, never an error: title 256, description 4096, 25 fields of 256/1024", async () => {
		await channel.post(
			{ conversationId: CH },
			{
				text: "알림",
				title: "제".repeat(300),
				body: "본".repeat(5000),
				fields: Array.from({ length: 30 }, (_, i) => ({ label: `${i}${"이".repeat(300)}`, value: "값".repeat(2000) })),
			},
		);
		const embed = embedsOf(creates()[0])[0];
		expect(embed?.title?.length).toBe(256);
		expect(embed?.description?.length).toBe(4096);
		expect(embed?.fields?.length).toBeGreaterThan(0);
		for (const field of embed?.fields ?? []) {
			expect(field.name.length).toBeLessThanOrEqual(256);
			expect(field.value.length).toBeLessThanOrEqual(1024);
		}
		// The 6000-character total: the last fields give way.
		expect(embedLength(embed ?? {})).toBeLessThanOrEqual(6000);
		await channel.post(
			{ conversationId: CH },
			{ text: "알림", title: "t", fields: Array.from({ length: 30 }, (_, i) => ({ label: `${i}`, value: "v" })) },
		);
		expect(embedsOf(creates()[1])[0]?.fields).toHaveLength(25);
	});
});

describe("```card fence in an answer → embed", () => {
	test("a valid Fields card goes as its own message with one embed; the text around it stays text", async () => {
		const posts = await deliver(`앞 문장\n${fence(CARD_SKELETONS[0])}\n뒤 문장`);
		expect(posts.map((p) => embedsOf(p).length)).toEqual([0, 1, 0]);
		expect(posts[0]?.content).toBe("앞 문장");
		expect(posts[2]?.content).toBe("뒤 문장");
		const embed = embedsOf(posts[1])[0];
		expect(embed?.title).toBe("요약");
		expect(embed?.fields?.map((f) => [f.name, f.value])).toEqual([
			["성공", "12"],
			["실패", "1"],
		]);
		expect(posts.every((p) => !(p.content ?? "").includes("```card"))).toBe(true);
		expect(logs.some((line) => line.includes("card_spec_invalid"))).toBe(false);
	});

	test("tone: a card without one is the same embed as before; danger colours it 0xE01E5A; an unknown one is ignored", async () => {
		const decision = (props: Record<string, unknown>) =>
			fence(
				spec({
					c: el("Card", { title: "요약", ...props }, ["f"]),
					f: el("Fields", {}, ["a", "b"]),
					a: el("Field", { label: "성공", value: "12" }),
					b: el("Field", { label: "실패", value: "1" }),
				}),
			);
		const before = {
			title: "요약",
			fields: [
				{ name: "성공", value: "12", inline: true },
				{ name: "실패", value: "1", inline: true },
			],
		};
		const posts = await deliver([decision({}), decision({ tone: "danger" }), decision({ tone: "purple" })].join("\n"));
		expect(posts.map((p) => embedsOf(p))).toEqual([[before], [{ ...before, color: 0xe01e5a }], [before]]);
		expect(logs.some((line) => line.includes("card_spec_invalid"))).toBe(false);
	});

	test("a card with only a tone still has nothing to show and stays a code block", async () => {
		const posts = await deliver(`설명\n${fence(spec({ c: el("Card", { tone: "ok" }, ["d"]), d: el("Divider") }))}`);
		expect(posts.flatMap((p) => embedsOf(p))).toHaveLength(0);
		expect(logs.some((line) => line.includes("card_spec_invalid"))).toBe(true);
	});

	test("Table and Chart become ASCII code blocks in the description", async () => {
		const posts = await deliver(`${fence(CARD_SKELETONS[1])}\n${fence(CARD_SKELETONS[2])}`);
		const embeds = posts.flatMap((p) => embedsOf(p));
		expect(embeds).toHaveLength(2);
		const [table, chart] = embeds;
		expect(table?.title).toBe("도구별 호출");
		expect(table?.description).toMatch(/^```\n[\s\S]*bash[\s\S]*\n```$/);
		expect(table?.description).toContain("도구");
		expect(chart?.description).toContain("```");
		expect(chart?.description).toContain("일별 턴");
	});

	test("an invalid card stays a code block and logs card_spec_invalid", async () => {
		const posts = await deliver(`설명\n${fence('{"root":"c","elements":{')}`);
		expect(posts.flatMap((p) => embedsOf(p))).toHaveLength(0);
		expect(posts.map((p) => p.content ?? "").join("\n")).toContain("```card");
		expect(logs.some((line) => line.includes("card_spec_invalid"))).toBe(true);
	});

	test("a chart with a repeated category stays a code block instead of an ASCII table with wrong values (#83)", async () => {
		const dup = spec({
			c: el("Card", { title: "추이" }, ["g"]),
			g: el("Chart", {
				title: "일별",
				chart: { type: "line", categories: ["A", "B", "A"], series: [{ name: "턴", values: [1, 2, 3] }] },
			}),
		});
		const posts = await deliver(`설명\n${fence(dup)}`);
		expect(posts.flatMap((p) => embedsOf(p))).toHaveLength(0);
		expect(posts.map((p) => p.content ?? "").join("\n")).toContain("```card");
		expect(logs.some((line) => line.includes("card_spec_invalid"))).toBe(true);
	});

	test("a valid card with nothing to show stays a code block instead of an empty message", async () => {
		const posts = await deliver(`설명\n${fence(spec({ c: el("Card", {}, ["d"]), d: el("Divider") }))}`);
		expect(posts.flatMap((p) => embedsOf(p))).toHaveLength(0);
		expect(posts.map((p) => p.content ?? "").join("\n")).toContain("```card");
		expect(logs.some((line) => line.includes("card_spec_invalid"))).toBe(true);
	});

	test("a __proto__ element id is refused: the card stays a code block and the answer is still posted", async () => {
		const json = `{"root":"c","elements":{"c":{"type":"Card","props":{"title":"오염"},"children":["__proto__"]},"__proto__":{"type":"Table","props":{},"children":[]}}}`;
		const posts = await deliver(`답 시작\n${fence(json)}\n답 끝`);
		expect(posts.length).toBeGreaterThanOrEqual(1);
		expect(posts.flatMap((p) => embedsOf(p))).toHaveLength(0);
		const content = posts.map((p) => p.content ?? "").join("\n");
		expect(content).toContain("답 시작");
		expect(content).toContain("```card");
		expect(content).toContain("답 끝");
		expect(logs.some((line) => line.includes("card_spec_invalid"))).toBe(true);
	});

	test("a card whose embed rendering throws falls back to its code block; the answer is still posted", async () => {
		const spy = spyOn(discordCard, "cardToEmbed").mockImplementation(() => {
			throw new Error("render boom");
		});
		try {
			const posts = await deliver(`앞 문장\n${fence(CARD_SKELETONS[0])}\n뒤 문장`);
			expect(posts.length).toBeGreaterThanOrEqual(1);
			expect(posts.flatMap((p) => embedsOf(p))).toHaveLength(0);
			const content = posts.map((p) => p.content ?? "").join("\n");
			expect(content).toContain("앞 문장");
			expect(content).toContain("```card");
			expect(content).toContain("뒤 문장");
			expect(logs.some((line) => line.includes("card_spec_invalid"))).toBe(true);
		} finally {
			spy.mockRestore();
		}
	});

	test("at most three cards per answer: the fourth stays text", async () => {
		const posts = await deliver([1, 2, 3, 4].map(() => fence(CARD_SKELETONS[0])).join("\n"));
		expect(posts.flatMap((p) => embedsOf(p))).toHaveLength(3);
		expect(posts.map((p) => p.content ?? "").join("\n")).toContain("```card");
	});

	test("over-limit card values are cut and the card still goes as an embed", async () => {
		const fields = Array.from({ length: 30 }, (_, i) => `f${i}`);
		const elements: Record<string, unknown> = {
			c: el("Card", { title: "카".repeat(300) }, ["t", "fs"]),
			t: el("Text", { content: "글".repeat(5000) }),
			fs: el("Fields", {}, fields),
		};
		for (const id of fields)
			elements[id] = el("Field", { label: `${id}${"이".repeat(300)}`, value: "값".repeat(2000) });
		const posts = await deliver(fence(spec(elements)));
		const embeds = posts.flatMap((p) => embedsOf(p));
		expect(embeds).toHaveLength(1);
		const [embed] = embeds;
		expect(embed?.title?.length).toBeLessThanOrEqual(256);
		expect(embed?.description?.length).toBeLessThanOrEqual(4096);
		expect(embed?.fields?.length).toBeLessThanOrEqual(25);
		for (const field of embed?.fields ?? []) {
			expect(field.name.length).toBeLessThanOrEqual(256);
			expect(field.value.length).toBeLessThanOrEqual(1024);
		}
		expect(embedLength(embed ?? {})).toBeLessThanOrEqual(6000);
		expect(logs.some((line) => line.includes("card_spec_invalid"))).toBe(false);
	});
});
