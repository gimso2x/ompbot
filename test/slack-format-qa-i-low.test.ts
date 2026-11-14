import { describe, expect, test } from "bun:test";
import { MARKDOWN_CHUNK_LIMIT, renderMarkdownParts, toMrkdwn } from "../src/slack/format";

describe("toMrkdwn qa-i low", () => {
	test("a link URL with balanced parentheses stays one link", () => {
		expect(toMrkdwn("[위키](https://ko.wikipedia.org/wiki/Foo_(bar))")).toBe(
			"<https://ko.wikipedia.org/wiki/Foo_(bar)|위키>",
		);
		expect(toMrkdwn("see [doc](https://x.test/a_(b)) now")).toBe("see <https://x.test/a_(b)|doc> now");
		expect(toMrkdwn("[a](https://x.test/p) (b)")).toBe("<https://x.test/p|a> (b)");
	});

	test("a table cell with a triple-backtick span still renders as one table", () => {
		const out = toMrkdwn("| a | b |\n| --- | --- |\n| ```x``` | y |");
		expect(out).toBe("```\n| a       | b   |\n| ------- | --- |\n| ```x``` | y   |\n```");
	});

	test("an unpaired triple backtick in a table cell does not break the table", () => {
		const out = toMrkdwn("| 문법 | 뜻 |\n| --- | --- |\n| ```js | js 코드 |\n\n뒤 본문");
		expect(out.startsWith("```\n| 문법")).toBe(true);
		expect(out).toContain("| ```js");
		expect(out).toContain("```\n\n뒤 본문");
	});
});

describe("renderMarkdownParts qa-i low", () => {
	test("mention expansion after chunking keeps every markdown block within Slack's 12,000", () => {
		const names = { ownerUserId: "", peerBots: [{ userId: "U0123ABCD", name: "아주아주긴피어이름봇".repeat(3) }] };
		const body = Array.from({ length: 2_000 }, () => "<@U0123ABCD> 확인").join("\n");
		const parts = renderMarkdownParts(body, false, undefined, { names });
		expect(parts).toBeDefined();
		expect(MARKDOWN_CHUNK_LIMIT).toBeLessThan(12_000);
		for (const part of parts ?? []) {
			const block = part.blocks.find((b) => b.type === "markdown") as { text: string } | undefined;
			expect(block?.text.length).toBeLessThanOrEqual(12_000);
		}
	});
});
