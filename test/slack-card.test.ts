import { describe, expect, test } from "bun:test";
import { CARD_SKELETONS } from "../src/safety/prompt";
import { CARD_MAX_BLOCKS, parseCard } from "../src/slack/card";
import { MAX_CARDS, REDELIVERED_PREFIX, renderMarkdownParts, splitCards } from "../src/slack/format";

const el = (type: string, props: Record<string, unknown> = {}, children: string[] = []) => ({ type, props, children });
const spec = (elements: Record<string, unknown>, root = "c"): string => JSON.stringify({ root, elements });
const fence = (json: string): string => `\`\`\`card\n${json}\n\`\`\``;
const context = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text }] });
const typeOf = (block: unknown): unknown =>
	typeof block === "object" && block !== null && "type" in block ? block.type : undefined;
/** A card of `n` plain Text children: exactly `n` section blocks, no header. */
const textCard = (n: number): string => {
	const elements: Record<string, unknown> = {
		c: el(
			"Card",
			{},
			Array.from({ length: n }, (_, i) => `t${i}`),
		),
	};
	for (let i = 0; i < n; i++) elements[`t${i}`] = el("Text", { content: `줄 ${i}` });
	return spec(elements);
};
const FIELDS = spec({
	c: el("Card", { title: "요약" }, ["f"]),
	f: el("Fields", {}, ["a", "b"]),
	a: el("Field", { label: "성공", value: "12" }),
	b: el("Field", { label: "실패", value: 1 }),
});

describe("parseCard", () => {
	test("the three prompt skeletons (Fields, Table, bar chart) validate with their native blocks", () => {
		const expected = ["section", "data_table", "data_visualization"];
		expect(CARD_SKELETONS).toHaveLength(3);
		CARD_SKELETONS.forEach((json, i) => {
			const parsed = parseCard(json);
			expect(parsed.ok).toBe(true);
			if (parsed.ok) expect(parsed.blocks.map(typeOf)).toContain(expected[i]);
		});
	});

	test("elements without children or props, and a spec without root but one Card, are repaired and validate", () => {
		const bare = JSON.stringify({
			root: "c",
			elements: {
				c: { type: "Card", props: { title: "요약" }, children: ["d", "t"] },
				d: { type: "Divider" },
				t: { type: "Text", props: { content: "본문" } },
			},
		});
		expect(parseCard(bare)).toMatchObject({ ok: true });
		const rootless = JSON.stringify({
			elements: { box: { type: "Card", props: { title: "제목" }, children: ["t"] }, t: el("Text", { content: "x" }) },
		});
		expect(parseCard(rootless)).toMatchObject({ ok: true, card: { title: "제목" } });
		// Two Cards and no root: nothing to pick, so it stays invalid.
		const twoCards = JSON.stringify({ elements: { a: el("Card", { title: "a" }), b: el("Card", { title: "b" }) } });
		expect(parseCard(twoCards).ok).toBe(false);
	});

	test("root Text, unknown component, bad JSON, Button and two tables each fail with issues and never throw", () => {
		const table = el("Table", { headers: ["a"], rows: [["1"]] });
		const cases = {
			rootText: spec({ t: el("Text", { content: "x" }) }, "t"),
			unknown: spec({ c: el("Card", {}, ["x"]), x: el("Gauge", { value: 3 }) }),
			badJson: '{"root":"c","elements":{',
			button: spec({ c: el("Card", {}, ["a"]), a: el("Actions", {}, ["b"]), b: el("Button", { id: "x", label: "y" }) }),
			twoTables: spec({ c: el("Card", {}, ["t1", "t2"]), t1: table, t2: table }),
		};
		for (const json of Object.values(cases)) {
			const parsed = parseCard(json);
			expect(parsed.ok).toBe(false);
			if (!parsed.ok) expect(parsed.issues.length).toBeGreaterThan(0);
		}
	});

	test(`a card of ${CARD_MAX_BLOCKS + 1} blocks is refused; ${CARD_MAX_BLOCKS} blocks pass`, () => {
		const over = parseCard(textCard(CARD_MAX_BLOCKS + 1));
		expect(over.ok).toBe(false);
		if (!over.ok) expect(over.issues.join(" ")).toContain(String(CARD_MAX_BLOCKS));
		const max = parseCard(textCard(CARD_MAX_BLOCKS));
		expect(max.ok && max.blocks.length).toBe(CARD_MAX_BLOCKS);
	});

	test("charts: false draws the chart as an ASCII code block", () => {
		const chart = CARD_SKELETONS[2];
		const ascii = parseCard(chart, { charts: false });
		expect(ascii.ok).toBe(true);
		if (ascii.ok) {
			expect(ascii.blocks.map(typeOf)).not.toContain("data_visualization");
			expect(JSON.stringify(ascii.blocks)).toContain("```\\n일별 턴");
		}
	});
});

describe("splitCards", () => {
	test("segments join back to the body; fences elsewhere, unclosed fences and cards past the cap stay text", () => {
		const bodies = [
			`앞\n${fence(FIELDS)}\n뒤`,
			`\`\`\`md\n${fence(FIELDS)}\n\`\`\`\n끝`,
			`앞\n\`\`\`card\n{"root":"c"`,
			Array.from({ length: MAX_CARDS + 1 }, () => fence(FIELDS)).join("\n\n"),
		];
		for (const body of bodies) {
			const segments = splitCards(body);
			expect(segments.map((s) => (s.kind === "text" ? s.text : s.raw)).join("\n")).toBe(body);
		}
		expect(splitCards(bodies[0] ?? "").map((s) => s.kind)).toEqual(["text", "card", "text"]);
		expect(splitCards(bodies[1] ?? "").map((s) => s.kind)).toEqual(["text"]);
		expect(splitCards(bodies[2] ?? "").map((s) => s.kind)).toEqual(["text"]);
		expect(splitCards(bodies[3] ?? "").filter((s) => s.kind === "card")).toHaveLength(MAX_CARDS);
	});
});

describe("renderMarkdownParts with cards", () => {
	const names = { ownerUserId: "U0OWNER", peerBots: [] };

	test("no card, a card fence inside another fence, and an unclosed card fence render exactly as with cards off", () => {
		const bodies = [
			"**답** 표:\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n<@U0OWNER> 확인",
			`예시:\n\`\`\`md\n${fence(FIELDS)}\n\`\`\`\n끝`,
			`앞 글\n\n\`\`\`card\n${FIELDS}\n`,
		];
		for (const body of bodies) {
			const plain = renderMarkdownParts(body, true, "✅ 00:01", { names });
			const cards = renderMarkdownParts(body, true, "✅ 00:01", { names, cards: true });
			expect(cards).toEqual(plain);
			expect(cards?.some((part) => part.card !== undefined)).toBe(false);
		}
	});

	test("four card fences: the first three become card parts, the fourth stays a text part", () => {
		const body = [1, 2, 3, 4].map((n) => `글 ${n}\n\n${fence(FIELDS)}`).join("\n\n");
		const parts = renderMarkdownParts(body, false, undefined, { cards: true }) ?? [];
		expect(parts.map((part) => (part.card === undefined ? "text" : "card"))).toEqual([
			"text",
			"card",
			"text",
			"card",
			"text",
			"card",
			"text",
		]);
		expect(parts.at(-1)?.blocks).toEqual([{ type: "markdown", text: `글 4\n\n${fence(FIELDS)}` }]);
	});

	test("an ASCII fallback is offered only for a card that drew a native chart", () => {
		const chart = (categories: string[]) =>
			fence(
				spec({
					c: el("Card", { title: "추이" }, ["g"]),
					g: el("Chart", {
						title: "일별",
						chart: { type: "bar", categories, series: [{ name: "턴", values: categories.map((_, i) => i) }] },
					}),
				}),
			);
		const days = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}일`);
		const [native] = renderMarkdownParts(chart(days(20)), false, undefined, { cards: true }) ?? [];
		expect(native?.card?.asciiBlocks).toBeDefined();
		// Over 20 categories Slack's chart block cannot hold it: the converter already drew ASCII.
		const [ascii] = renderMarkdownParts(chart(days(21)), false, undefined, { cards: true }) ?? [];
		expect(ascii?.blocks.map(typeOf)).not.toContain("data_visualization");
		expect(ascii?.card).toBeDefined();
		expect(ascii?.card?.asciiBlocks).toBeUndefined();
	});

	test("redelivered marks the first part and the footer closes the last part even when that part is a card", () => {
		const parts = renderMarkdownParts(`앞 글\n\n${fence(FIELDS)}`, true, "✅ 00:42", { cards: true }) ?? [];
		expect(parts).toHaveLength(2);
		expect(parts[0]?.blocks[0]).toEqual(context(REDELIVERED_PREFIX));
		expect(parts[0]?.text.startsWith(REDELIVERED_PREFIX)).toBe(true);
		expect(parts[1]?.card).toBeDefined();
		expect(parts[1]?.blocks.at(-1)).toEqual(context("✅ 00:42"));
		expect(parts[1]?.blocks.map(typeOf)).not.toContain("markdown");
		expect(parts[1]?.card?.text.endsWith("_✅ 00:42_")).toBe(true);
	});

	test("a card first part carries the redelivered block first and the 🔔 line before the footer", () => {
		const parts =
			renderMarkdownParts(`${fence(FIELDS)}\n\n<@U0OWNER> 확인`, true, "✅ 00:42", { names, cards: true }) ?? [];
		expect(parts).toHaveLength(2);
		const blocks = parts[0]?.blocks ?? [];
		expect(blocks[0]).toEqual(context(REDELIVERED_PREFIX));
		expect(blocks.at(-1)).toEqual(context("🔔 <@U0OWNER>"));
		expect(parts[1]?.blocks).toEqual([{ type: "markdown", text: "@오너 확인" }, context("✅ 00:42")]);
	});

	test(`a ${CARD_MAX_BLOCKS}-block card stays within 50 blocks with every block it can carry; ${CARD_MAX_BLOCKS + 1} blocks stay text`, () => {
		const max = fence(textCard(CARD_MAX_BLOCKS));
		// First part: redelivered + card + 🔔 (the footer goes to the text part after it).
		const first = renderMarkdownParts(`${max}\n\n<@U0OWNER> 확인`, true, "✅ 00:42", { names, cards: true }) ?? [];
		// Only part: redelivered + card + footer.
		const only = renderMarkdownParts(max, true, "✅ 00:42", { names, cards: true }) ?? [];
		// Monitor title with a mention over a card-only answer: header + redelivered + card + 🔔 + footer.
		const titled = (n: number) =>
			renderMarkdownParts(`⏰ 브리핑 <@U0OWNER>\n${fence(textCard(n))}`, true, "✅ 00:42", {
				names,
				cards: true,
				monitorHeader: true,
			}) ?? [];
		for (const part of [first[0], only[0], titled(CARD_MAX_BLOCKS - 1)[0]]) {
			expect(part?.card).toBeDefined();
			expect(part?.blocks.length).toBeLessThanOrEqual(50);
		}
		expect(titled(CARD_MAX_BLOCKS - 1)[0]?.blocks).toHaveLength(50);
		expect(titled(CARD_MAX_BLOCKS).some((part) => part.card !== undefined)).toBe(false);
		const over = renderMarkdownParts(fence(textCard(CARD_MAX_BLOCKS + 1)), true, "✅", { cards: true });
		expect(over?.some((part) => part.card !== undefined)).toBe(false);
		expect(over?.cardIssues?.length).toBeGreaterThan(0);
	});
});
