import { describe, expect, test } from "bun:test";
import { classifyLaneCompletion } from "../src/lanes/integrity";

const DIFF = (file: string, ...lines: string[]): string =>
	[`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, "@@ -0,0 +1,1 @@", ...lines].join("\n");

function categories(summary: string, diff: string): string[] {
	return classifyLaneCompletion({ summary, diff }).map((refusal) => refusal.category);
}

describe("classifyLaneCompletion", () => {
	test("a clean diff and a claim with a named command pass", () => {
		const diff = DIFF("src/a.ts", "+export const x = 1;");
		expect(categories("bun test 통과, 커밋 완료", diff)).toEqual([]);
	});

	test("TODO markers in added code comments are refused, linked issues exempt", () => {
		expect(categories("done", DIFF("src/a.ts", "+// TODO: later"))).toEqual(["unfinished_work_marker"]);
		expect(categories("done", DIFF("src/a.ts", "+// TODO: later — see #123"))).toEqual([]);
		// Docs paths are exempt entirely.
		expect(categories("done", DIFF("docs/guide.md", "+<!-- TODO: expand -->"))).toEqual([]);
	});

	test("skipped or only-tests are refused", () => {
		expect(categories("done", DIFF("test/a.test.ts", "+test.skip('x', () => {});"))).toEqual(["skipped_test"]);
		expect(categories("done", DIFF("test/a.test.ts", "+it.only('x', () => {});"))).toEqual(["skipped_test"]);
	});

	test("stub bodies are refused", () => {
		expect(categories("done", DIFF("src/a.ts", '+throw new Error("Not implemented");'))).toEqual([
			"stub_implementation",
		]);
	});

	test("guard deletions need an adversarial regression test", () => {
		const removed = DIFF("src/auth.ts", "-if (!allowlist.has(host)) throw new Error('denied');");
		expect(categories("done", removed)).toEqual(["guard_deletion_without_adversarial_regression"]);
		// Re-adding the same line is a move, not a deletion.
		expect(
			categories(
				"done",
				DIFF(
					"src/auth.ts",
					"-if (!allowlist.has(host)) throw new Error('denied');",
					"+if (!allowlist.has(host)) throw new Error('denied');",
				),
			),
		).toEqual([]);
		// A negative-case test added alongside exempts the deletion.
		expect(
			categories(
				"done",
				[
					DIFF("src/auth.ts", "-if (!allowlist.has(host)) throw new Error('denied');"),
					DIFF("test/auth.test.ts", "+test('rejects a foreign host', () => {});"),
				].join("\n"),
			),
		).toEqual([]);
	});

	test("verification words without a command are refused", () => {
		expect(categories("테스트 통과, 수정 완료", "")).toEqual(["unproven_claim_word"]);
		expect(categories("bun test 통과, 수정 완료", "")).toEqual([]);
		expect(categories("평범한 요약", "")).toEqual([]);
	});
});
