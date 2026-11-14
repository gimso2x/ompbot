import { describe, expect, test } from "bun:test";
import { CARD_TONE_COLORS, MAX_CARDS, splitCards, tableToAscii, validateCard } from "../src/channel/card";
import { REDELIVERED_PREFIX } from "../src/channel/text";
import { CARD_SKELETONS } from "../src/safety/prompt";
import { CARD_MAX_BLOCKS, parseCard } from "../src/slack/card";
import { renderMarkdownParts, toMrkdwn } from "../src/slack/format";

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
/** A bar chart card: the Chart renderers are still supported though the prompt no longer offers a skeleton. */
const BAR_CHART = JSON.stringify({
	root: "c",
	elements: {
		c: { type: "Card", props: { title: "일별 턴 수" }, children: ["g"] },
		g: {
			type: "Chart",
			props: {
				title: "일별 턴",
				chart: { type: "bar", categories: ["월", "화", "수"], series: [{ name: "턴", values: [3, 5, 4] }] },
			},
			children: [],
		},
	},
});
const FIELDS = spec({
	c: el("Card", { title: "요약" }, ["f"]),
	f: el("Fields", {}, ["a", "b"]),
	a: el("Field", { label: "성공", value: "12" }),
	b: el("Field", { label: "실패", value: 1 }),
});

describe("parseCard", () => {
	test("the three prompt skeletons (Fields, Table, decision) validate with their native blocks", () => {
		const expected = ["section", "data_table", "section"];
		expect(CARD_SKELETONS).toHaveLength(3);
		CARD_SKELETONS.forEach((json, i) => {
			const parsed = parseCard(json);
			expect(parsed.ok).toBe(true);
			if (parsed.ok) expect(parsed.blocks.map(typeOf)).toContain(expected[i]);
		});
	});

	test("the decision skeleton passes validateCard and parseCard with its tone: a header and one fields section", () => {
		const json = CARD_SKELETONS[2];
		const validated = validateCard(json);
		expect(validated.ok && validated.tone).toBe("warn");
		const parsed = parseCard(json);
		expect(parsed.ok && parsed.tone).toBe("warn");
		if (!parsed.ok) throw new Error(parsed.issues.join("; "));
		expect(parsed.blocks.map(typeOf)).toEqual(["header", "section"]);
		expect(parsed.blocks[1]?.fields).toEqual([
			{ text: "*✅ 추천*\n1번: 스테이징에서 먼저 확인", type: "mrkdwn" },
			{ text: "*선택지*\n1. 스테이징 먼저\n2. 바로 배포", type: "mrkdwn" },
		]);
	});

	test("root Card tone: validateCard and parseCard keep a palette value; an unknown one is ignored without an issue", () => {
		const toned = (tone: unknown) =>
			spec({
				c: el("Card", { title: "요약", tone }, ["f"]),
				f: el("Fields", {}, ["a"]),
				a: el("Field", { label: "x", value: "1" }),
			});
		for (const tone of ["ok", "warn", "danger", "info"] as const) {
			const validated = validateCard(toned(tone));
			expect(validated.ok && validated.tone).toBe(tone);
			const parsed = parseCard(toned(tone));
			expect(parsed.ok && parsed.tone).toBe(tone);
		}
		expect(CARD_TONE_COLORS).toEqual({ ok: "#2EB67D", warn: "#ECB22E", danger: "#E01E5A", info: "#36C5F0" });
		for (const tone of ["purple", 3, null]) {
			const validated = validateCard(toned(tone));
			expect(validated.ok).toBe(true);
			expect(validated.ok && "tone" in validated).toBe(false);
		}
		// Without tone the result is what it was: no tone key.
		expect(validateCard(FIELDS)).toEqual({ ok: true, card: expect.anything() });
		expect("tone" in validateCard(FIELDS)).toBe(false);
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

	test("one closing bracket too many after a whole spec is dropped; other trailing text still fails", () => {
		expect(parseCard(`${FIELDS}}`)).toMatchObject({ ok: true, card: { title: "요약" } });
		expect(parseCard(`${FIELDS} }\n]`)).toMatchObject({ ok: true });
		const braceInString = spec({ c: el("Card", { title: "a}b" }, ["t"]), t: el("Text", { content: "{" }) });
		expect(parseCard(`${braceInString}}`)).toMatchObject({ ok: true, card: { title: "a}b" } });
		expect(parseCard(`${FIELDS} 끝`).ok).toBe(false);
		expect(parseCard(`${FIELDS}{}`).ok).toBe(false);
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

	test("an element id __proto__, constructor or prototype is refused with an issue naming it", () => {
		// Raw JSON: an object literal's `__proto__` key would set the prototype instead of making an element.
		for (const id of ["__proto__", "constructor", "prototype"]) {
			const json = `{"root":"c","elements":{"c":{"type":"Card","props":{"title":"오염"},"children":["${id}"]},"${id}":{"type":"Text","props":{"content":"x"},"children":[]}}}`;
			const parsed = parseCard(json);
			expect(parsed.ok).toBe(false);
			if (!parsed.ok) expect(parsed.issues.join(" ")).toContain(id);
		}
		const asRoot = `{"root":"constructor","elements":{"constructor":{"type":"Card","props":{"title":"x"},"children":[]}}}`;
		expect(parseCard(asRoot).ok).toBe(false);
	});

	test(`a card of ${CARD_MAX_BLOCKS + 1} blocks is refused; ${CARD_MAX_BLOCKS} blocks pass`, () => {
		const over = parseCard(textCard(CARD_MAX_BLOCKS + 1));
		expect(over.ok).toBe(false);
		if (!over.ok) expect(over.issues.join(" ")).toContain(String(CARD_MAX_BLOCKS));
		const max = parseCard(textCard(CARD_MAX_BLOCKS));
		expect(max.ok && max.blocks.length).toBe(CARD_MAX_BLOCKS);
	});

	test("charts: false draws the chart as an ASCII code block", () => {
		const ascii = parseCard(BAR_CHART, { charts: false });
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

	test("a chart with a repeated category is refused by validation and stays text on both chart paths (#83)", () => {
		const dup = spec({
			c: el("Card", { title: "추이" }, ["s"]),
			s: el("Section", {}, ["g"]),
			g: el("Chart", {
				title: "일별",
				chart: { type: "bar", categories: ["A", "A", "B"], series: [{ name: "턴", values: [1, 2, 3] }] },
			}),
		});
		const checked = validateCard(dup);
		expect(checked.ok).toBe(false);
		expect(checked.ok ? [] : checked.issues).toEqual([expect.stringContaining('category "A"')]);
		for (const charts of [true, false]) {
			const parts = renderMarkdownParts(fence(dup), false, undefined, { cards: true, charts }) ?? [];
			expect(parts.some((part) => part.card !== undefined)).toBe(false);
			expect(parts.cardIssues).toEqual([expect.stringContaining('category "A"')]);
			expect(parts.map((part) => part.text).join("\n")).toContain("```card");
		}
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

describe("code fences by backtick run length", () => {
	const names = { ownerUserId: "U0OWNER", peerBots: [] };
	const four = "````md\n```js\n**bold** <@U0OWNER> <!here>\n```\n````";

	test("a 4-backtick fence holding a 3-backtick fence is code to its own closing run: no 🔔 line, bytes kept", () => {
		const parts = renderMarkdownParts(four, false, undefined, { names }) ?? [];
		expect(parts).toHaveLength(1);
		expect(parts[0]?.blocks).toEqual([{ type: "markdown", text: four }]);
		expect(parts[0]?.text).toBe(four);
		expect(toMrkdwn(four)).toBe(four);
		// Prose after the outer fence is still converted.
		const after = `${four}\n**끝** <@U0OWNER>`;
		expect(toMrkdwn(after)).toBe(`${four}\n*끝* <@U0OWNER>`);
		expect(renderMarkdownParts(after, false, undefined, { names })?.[0]?.blocks).toEqual([
			{ type: "markdown", text: `${four}\n**끝** @오너` },
			context("🔔 <@U0OWNER>"),
		]);
	});

	test("3-backtick fences, mid-line triple backticks and inline code keep their behaviour", () => {
		const body = "```\n<@U0CODE> **x**\n```\n예: ```<!here>``` 와 `<@U0SPAN>` 표시, <@U0OWNER> **굵게**";
		expect(renderMarkdownParts(body, false, undefined, { names })?.[0]?.blocks).toEqual([
			{
				type: "markdown",
				text: "```\n<@U0CODE> **x**\n```\n예: ```<!here>``` 와 `<@U0SPAN>` 표시, @오너 **굵게**",
			},
			context("🔔 <@U0OWNER>"),
		]);
		expect(toMrkdwn(body)).toBe("```\n<@U0CODE> **x**\n```\n예: ```<!here>``` 와 `<@U0SPAN>` 표시, <@U0OWNER> *굵게*");
		// An unclosed 3-backtick fence is code to the end.
		expect(toMrkdwn("앞 **a**\n```\n**b** <!here>")).toBe("앞 *a*\n```\n**b** <!here>");
	});
});

describe("qa50b lane K: mrkdwn links and sentinels, card fences and limits", () => {
	test("K-4: a link URL holding | < > is percent-encoded so the Slack token stays whole", () => {
		expect(toMrkdwn("[위키](https://x.y/a|b)")).toBe("<https://x.y/a%7Cb|위키>");
		expect(toMrkdwn("[위키](https://x.y/a>b<c)")).toBe("<https://x.y/a%3Eb%3Cc|위키>");
	});

	test("K-5: private-use sentinel characters in the input never delete or swap text", () => {
		expect(toMrkdwn("앞 \uE0009\uE000 뒤")).toContain("9");
		const out = toMrkdwn("[a](https://a.b) \uE0000\uE000 \uE0010\uE001 `c`");
		expect(out.match(/<https:\/\/a\.b\|a>/g)).toHaveLength(1);
		expect(out.match(/`c`/g)).toHaveLength(1);
	});

	test("K-10: a 4-backtick fence closes only on 4+ backticks, so a card fence after it is a card", () => {
		const kinds = splitCards("````md\nhello\n````\n```card\n{}\n```\n").map((s) => s.kind);
		expect(kinds).toEqual(["text", "card", "text"]);
		const inside = splitCards("````md\n```card\n{}\n```\n````").map((s) => s.kind);
		expect(inside).toEqual(["text"]);
	});

	test("K-11: tableToAscii pads by display width, so Hangul columns line up", () => {
		const lines = tableToAscii({
			headers: ["이름", "n"],
			rows: [
				["가나다라", "1"],
				["ab", "2"],
			],
		}).split("\n");
		const bar = (line: string): number => {
			let width = 0;
			for (const ch of line.slice(0, line.indexOf(" | "))) width += /[\uac00-\ud7a3]/.test(ch) ? 2 : 1;
			return width;
		};
		expect(lines.map(bar)).toEqual([8, 8, 8]);
	});

	test("K-15: a header cut at its limit never splits a surrogate pair", () => {
		const parsed = parseCard(spec({ c: el("Card", { title: `${"a".repeat(149)}😀` }) }));
		expect(parsed.ok).toBe(true);
		const header = parsed.ok ? (parsed.blocks[0] as { text: { text: string } }).text.text : "";
		expect(header).toBe("a".repeat(149));
	});

	test("K-16: a too-long chart label is reported in UTF-16 units, not characters", () => {
		const label = "😀".repeat(11);
		const result = validateCard(
			spec({
				c: el("Card", {}, ["p"]),
				p: el("Chart", { title: "t", chart: { type: "pie", segments: [{ label, value: 1 }] } }),
			}),
		);
		expect(result.ok).toBe(false);
		const issues = result.ok ? [] : result.issues;
		expect(issues.some((issue) => issue.includes("UTF-16"))).toBe(true);
		expect(issues.some((issue) => /\bcharacters\b/.test(issue))).toBe(false);
	});

	test("K-17: more than 10 fields go out as several sections, none dropped", () => {
		const elements: Record<string, unknown> = {
			c: el("Card", {}, ["f"]),
			f: el(
				"Fields",
				{},
				Array.from({ length: 13 }, (_, i) => `x${i}`),
			),
		};
		for (let i = 0; i < 13; i++) elements[`x${i}`] = el("Field", { label: `칸${i}`, value: String(i) });
		const parsed = parseCard(spec(elements));
		expect(parsed.ok).toBe(true);
		const fields = parsed.ok ? parsed.blocks.flatMap((b) => (b as { fields?: unknown[] }).fields ?? []) : [];
		expect(fields).toHaveLength(13);
		for (const block of parsed.ok ? parsed.blocks : [])
			expect(((block as { fields?: unknown[] }).fields ?? []).length).toBeLessThanOrEqual(10);
	});
});
