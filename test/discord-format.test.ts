import { describe, expect, test } from "bun:test";
import { REDELIVERED_PREFIX } from "../src/channel/text";
import { mrkdwnToDiscord, renderDiscordParts } from "../src/discord/format";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("mrkdwnToDiscord", () => {
	test.each([
		["*a*", "**a**"],
		["앞 *굵게 쓴 말* 뒤", "앞 **굵게 쓴 말** 뒤"],
		["~a~", "~~a~~"],
		["_기울임_", "_기울임_"],
		["<https://x.y|라벨>", "[라벨](https://x.y)"],
		["<https://x.y>", "https://x.y"],
		["보기: <https://x.y/a?b=1&amp;c=2|링크>", "보기: [링크](https://x.y/a?b=1&c=2)"],
		["&lt;a&gt;", "<a>"],
		["a &amp;&amp; b", "a && b"],
		["<@123>", "<@123>"],
		["<#456>", "<#456>"],
		["<#456|일반>", "<#456>"],
		["2*3*4는 곱", "2*3*4는 곱"],
		["`*a*`", "`*a*`"],
		["```\n*a* <https://x.y|l> &lt;\n```", "```\n*a* <https://x.y|l> &lt;\n```"],
		["앞 *a* `~b~` 뒤 ~c~", "앞 **a** `~b~` 뒤 ~~c~~"],
	])("%p → %p", (input, output) => {
		expect(mrkdwnToDiscord(input)).toBe(output);
	});

	test.each(["<!here>", "<!channel>", "<!everyone>", "<!here|@here>"])("%p is plain text, never a ping", (input) => {
		const out = mrkdwnToDiscord(`알림 ${input} 끝`);
		expect(out).not.toMatch(/@(here|channel|everyone)/);
		expect(out).not.toContain("<!");
		expect(out.startsWith("알림 ")).toBe(true);
	});
});

describe("renderDiscordParts", () => {
	test("a markdown table is wrapped in a code fence; text around it is kept", () => {
		const body = "표입니다\n\n| 도구 | 횟수 |\n|---|---|\n| bash | 10 |\n\n끝";
		const [part, ...rest] = renderDiscordParts(body, false);
		expect(rest).toHaveLength(0);
		expect(part).toBe("표입니다\n\n```\n| 도구 | 횟수 |\n|---|---|\n| bash | 10 |\n```\n\n끝");
	});

	test("a table already inside a code fence is not wrapped twice", () => {
		const body = "```\n| a | b |\n|---|---|\n```";
		expect(renderDiscordParts(body, false)).toEqual([body]);
	});

	test("a long answer splits into parts of at most 2000 characters", () => {
		const paragraph = "가나다라마바사 아자차카타파하 ".repeat(20).trim();
		const body = Array.from({ length: 30 }, (_, i) => `${i}. ${paragraph}`).join("\n\n");
		const parts = renderDiscordParts(body, true, "✅ 01:02 · 도구 3회");
		expect(parts.length).toBeGreaterThan(2);
		for (const part of parts) expect(part.length).toBeLessThanOrEqual(2000);
	});

	test("a code fence cut by a split is closed in every part", () => {
		const code = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
		const parts = renderDiscordParts(`앞\n\n\`\`\`ts\n${code}\n\`\`\`\n\n뒤`, false);
		expect(parts.length).toBeGreaterThan(1);
		for (const part of parts) {
			expect(part.length).toBeLessThanOrEqual(2000);
			expect((part.match(/```/g) ?? []).length % 2).toBe(0);
		}
	});

	test("emoji (surrogate pairs) are never cut in half", () => {
		const parts = renderDiscordParts("😀".repeat(3000), false);
		expect(parts.length).toBeGreaterThan(1);
		for (const part of parts) {
			expect(part.length).toBeLessThanOrEqual(2000);
			expect(LONE_SURROGATE.test(part)).toBe(false);
		}
		expect(parts.join("")).toBe("😀".repeat(3000));
	});

	test("the redelivery mark opens only the first part and the footer closes only the last", () => {
		const body = Array.from({ length: 12 }, (_, i) => `${i} ${"내용 ".repeat(100)}`).join("\n\n");
		const parts = renderDiscordParts(body, true, "✅ 00:42");
		expect(parts.length).toBeGreaterThan(1);
		parts.forEach((part, i) => {
			expect(part.startsWith(REDELIVERED_PREFIX)).toBe(i === 0);
			expect(part.endsWith("_✅ 00:42_")).toBe(i === parts.length - 1);
			expect(part.length).toBeLessThanOrEqual(2000);
		});
		const single = renderDiscordParts("짧은 답", false, "✅ 00:01");
		expect(single).toEqual(["짧은 답\n_✅ 00:01_"]);
	});
});
