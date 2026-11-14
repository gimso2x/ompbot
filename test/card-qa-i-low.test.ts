import { describe, expect, test } from "bun:test";
import { CARD_LIMITS, chartToAscii, validateCard } from "../src/channel/card";

const el = (type: string, props: Record<string, unknown> = {}, children: string[] = []) => ({ type, props, children });
const spec = (elements: Record<string, unknown>, root = "c"): string => JSON.stringify({ root, elements });
const issues = (json: string): string[] => {
	const checked = validateCard(json);
	return checked.ok ? [] : checked.issues;
};

describe("validateCard reference graph (qa-i 34, 78, 79)", () => {
	test("a cycle is refused", () => {
		const json = spec({
			c: el("Card", { title: "t" }, ["a"]),
			a: el("Section", {}, ["b"]),
			b: el("Section", {}, ["a"]),
		});
		expect(issues(json)).toEqual([expect.stringContaining('"a" is referenced more than once')]);
	});

	test("a root self reference is refused", () => {
		expect(issues(spec({ c: el("Card", { title: "t" }, ["c"]) }))).toEqual([
			expect.stringContaining('"c" is referenced more than once'),
		]);
	});

	test("a child referenced twice is refused", () => {
		const json = spec({
			c: el("Card", { title: "t" }, ["s", "s"]),
			s: el("Section", {}, []),
		});
		expect(issues(json)).toEqual([expect.stringContaining('"s" is referenced more than once')]);
	});

	test("a tree passes", () => {
		const json = spec({
			c: el("Card", { title: "t" }, ["a", "b"]),
			a: el("Section", {}, []),
			b: el("Section", {}, []),
		});
		expect(validateCard(json).ok).toBe(true);
	});

	test("an element id with # is refused", () => {
		const json = spec({
			c: el("Card", { title: "t" }, ["leaf#0"]),
			"leaf#0": el("Text", { text: "고유 항목" }),
		});
		expect(issues(json)).toEqual([expect.stringContaining('"leaf#0" must not contain "#"')]);
	});
});

describe("chart category limit (qa-i 80)", () => {
	const chart = (count: number): string =>
		spec({
			c: el("Card", { title: "t" }, ["g"]),
			g: el("Chart", {
				title: "일별",
				chart: {
					type: "bar",
					categories: Array.from({ length: count }, (_, i) => `d${i}`),
					series: [{ name: "n", values: Array.from({ length: count }, (_, i) => i) }],
				},
			}),
		});

	test("more categories than CARD_LIMITS.chartPoints are refused", () => {
		expect(validateCard(chart(CARD_LIMITS.chartPoints)).ok).toBe(true);
		expect(issues(chart(CARD_LIMITS.chartPoints + 1))).toEqual([expect.stringContaining("categories")]);
	});

	test("chartToAscii draws each category with its series value", () => {
		const checked = validateCard(chart(2));
		if (!checked.ok) throw new Error("expected a card");
		const child = checked.card.children[0];
		if (child?.type !== "chart" || child.chart.type === "pie") throw new Error("expected a chart");
		expect(chartToAscii(child).split("\n").slice(1)).toEqual(["   | n", "d0 | 0", "d1 | 1"]);
	});
});
