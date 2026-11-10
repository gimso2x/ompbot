import { describe, expect, test } from "bun:test";
import { byteLength, REDACTED, redact, redactToBudget, truncateUtf8 } from "../src/redact";

describe("redact", () => {
	test.each([
		"xoxb-TEST-0",
		"xoxa-TEST-0",
		"xoxp-TEST-0",
		"xoxo-TEST-0",
		"xoxs-TEST-0",
		"xoxr-TEST-0",
		"xoxe-TEST-0",
		"xapp-TEST-0",
		"sk-TEST-0",
		"sk-ant-TEST-0",
		`ghp_${"A".repeat(36)}`,
		`gho_${"b1".repeat(15)}`,
		`ghu_${"C".repeat(20)}`,
		`ghs_${"D".repeat(36)}`,
		`ghr_${"e".repeat(36)}`,
	])("%s is replaced", (token) => {
		expect(redact(`before ${token} after`)).toBe(`before ${REDACTED} after`);
	});

	test("sk-ant- token is one replacement, not two", () => {
		expect(redact("sk-ant-api03-TEST_0")).toBe(REDACTED);
	});

	test("short token shapes are replaced too", () => {
		expect(redact("xoxb-a")).toBe(REDACTED);
	});

	test("multiple tokens and ordinary words", () => {
		expect(redact("xoxb-TEST-0,xapp-TEST-0 task-1 risk-free disk-usage")).toBe(
			`${REDACTED},${REDACTED} task-1 risk-free disk-usage`,
		);
	});

	test("short gh_ lookalikes and plain words survive", () => {
		expect(redact("ghp_short ghx_AAAAAAAAAAAAAAAAAAAAAAAA light_weight")).toBe(
			"ghp_short ghx_AAAAAAAAAAAAAAAAAAAAAAAA light_weight",
		);
	});

	test("text without secrets is unchanged", () => {
		expect(redact("plain text 한글")).toBe("plain text 한글");
	});

	// Not a real token: the bot-token shape (base64url id . 6-char stamp . HMAC) assembled at runtime.
	const discordToken = [`MTA${"x".repeat(21)}`, "Gh_9-k", `${"Ab-_9".repeat(7)}z`].join(".");

	test("a Discord bot token shape is replaced", () => {
		expect(redact(`토큰 ${discordToken} 끝`)).toBe(`토큰 ${REDACTED} 끝`);
		expect(redact(`Bot ${discordToken}`)).toBe(`Bot ${REDACTED}`);
	});

	test("dotted words, versions, hosts and JWT-like headers are not Discord tokens", () => {
		const plain = "v1.2.3 api.discord.com a.b.c ompbot.config.json eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.abc";
		expect(redact(plain)).toBe(plain);
	});
});

describe("byte budget", () => {
	test("truncateUtf8 never splits a code point", () => {
		const s = "가나다"; // 3 bytes each
		expect(truncateUtf8(s, 7)).toBe("가나");
		expect(truncateUtf8(s, 9)).toBe(s);
		expect(truncateUtf8("a😀b", 4)).toBe("a");
		expect(truncateUtf8("abc", 0)).toBe("");
	});

	test("budget is applied after masking: growth from masking cannot exceed it", () => {
		const input = "xoxb-a"; // 6 bytes raw, 10 bytes masked
		expect(byteLength(input)).toBe(6);
		const out = redactToBudget(input, 8);
		expect(byteLength(out)).toBeLessThanOrEqual(8);
		expect(out).not.toContain("xoxb");
	});

	test("shrinking masks leave room for later content", () => {
		const input = `xoxb-${"A".repeat(100)} tail`;
		expect(redactToBudget(input, 30)).toBe(`${REDACTED} tail`);
	});

	test("result in bytes never exceeds the budget for multibyte output", () => {
		const out = redactToBudget(`한글 xapp-TEST-0 ${"가".repeat(50)}`, 40);
		expect(byteLength(out)).toBeLessThanOrEqual(40);
		expect(out).not.toContain("xapp-");
	});
});
