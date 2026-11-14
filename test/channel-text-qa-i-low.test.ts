import { describe, expect, test } from "bun:test";
import { chunkText } from "../src/channel/text";

describe("chunkText qa-i low", () => {
	test("a CRLF body's closing fence is recognised, so prose after it is not wrapped as code", () => {
		const body = ["```js", "a();", "```", ...Array.from({ length: 30 }, (_, i) => `산문 ${i} ${"가".repeat(20)}`)].join(
			"\r\n",
		);
		const chunks = chunkText(body, 200);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks.slice(1)) {
			expect(chunk.startsWith("```")).toBe(false);
			expect(chunk.endsWith("```")).toBe(false);
		}
	});
});
