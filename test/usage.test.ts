import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	allSessionFiles,
	conversationSessionFiles,
	renderUsage,
	summarizeSessionFiles,
	type UsageTotals,
} from "../src/ops/usage";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-usage-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) => ({
	input,
	output,
	cacheRead,
	cacheWrite,
	totalTokens: input + output + cacheRead + cacheWrite,
	cost: { input: 0, output: 0, total: cost },
});

function writeJsonl(path: string, lines: Array<unknown | string>): string {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"));
	return path;
}

const ZERO: UsageTotals = {
	calls: 0,
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	costTotal: 0,
	files: 0,
	badLines: 0,
};

describe("summarizeSessionFiles", () => {
	test("(1)(2) sums assistant message usage and model_usage records, counts broken lines, ignores the rest", async () => {
		const file = writeJsonl(join(dir, "a.jsonl"), [
			{ type: "session", id: "s1" },
			{ type: "message", message: { role: "user", content: "hi", usage: usage(999, 999, 999, 999, 9) } },
			{ type: "message", message: { role: "assistant", content: [], usage: usage(100, 10, 1000, 50, 0.5) } },
			{ type: "message", message: { role: "assistant", content: [] } },
			"{ broken json",
			"",
			{ type: "message", message: { role: "assistant", content: [], usage: usage(200, 20, 0, 0, 0.25) } },
			{ type: "model_usage", model: "x/y", usage: usage(816, 39, 0, 0, 0) },
			{ type: "model_usage" },
			{ type: "custom", usage: usage(5, 5, 5, 5, 5) },
		]);
		expect(await summarizeSessionFiles([file])).toEqual({
			calls: 3,
			input: 1116,
			output: 69,
			cacheRead: 1000,
			cacheWrite: 50,
			costTotal: 0.75,
			files: 1,
			badLines: 1,
		});
	});

	test("(4) no files, a missing path and an empty file all give zero without throwing", async () => {
		expect(await summarizeSessionFiles([])).toEqual(ZERO);
		const empty = join(dir, "empty.jsonl");
		writeFileSync(empty, "");
		expect(await summarizeSessionFiles([join(dir, "nope.jsonl"), empty])).toEqual({ ...ZERO, files: 1 });
	});
});

describe("session file discovery", () => {
	test("a conversation is every epoch of its origin directory, sub-agent transcripts included", () => {
		const origin = join(dir, "sessions", encodeURIComponent("slack/dm/D1"));
		const a = writeJsonl(join(origin, "e1", "2026-11-01_a.jsonl"), []);
		const b = writeJsonl(join(origin, "e2", "2026-11-02_b.jsonl"), []);
		const nested = writeJsonl(join(origin, "e2", "2026-11-02_b", "Scout.jsonl"), []);
		writeJsonl(join(origin, "notes", "x.jsonl"), []);
		const other = writeJsonl(join(dir, "sessions", encodeURIComponent("slack/dm/D2"), "e1", "c.jsonl"), []);
		expect(conversationSessionFiles(origin).sort()).toEqual([a, b, nested].sort());
		expect(allSessionFiles(join(dir, "sessions")).length).toBe(5);
		expect(allSessionFiles(join(dir, "sessions"))).toContain(other);
		expect(conversationSessionFiles(join(dir, "sessions", "missing"))).toEqual([]);
		expect(allSessionFiles(join(dir, "missing"))).toEqual([]);
	});
});

describe("renderUsage", () => {
	test("two total lines and the gc caveat", () => {
		const conversation: UsageTotals = {
			calls: 3,
			input: 1116,
			output: 69,
			cacheRead: 1000,
			cacheWrite: 50,
			costTotal: 0.754,
			files: 1,
			badLines: 0,
		};
		const overall: UsageTotals = { ...conversation, calls: 4548, input: 12345678, files: 120, costTotal: 12.3 };
		expect(renderUsage(conversation, overall)).toBe(
			[
				"이 대화: 모델 호출 3회 · 입력 1,116 (캐시 읽기 46%) · 출력 69 · 비용 $0.75",
				"전체(보관 중인 세션 파일 120개): 모델 호출 4,548회 · 입력 12,345,678 (캐시 읽기 0%) · 출력 69 · 비용 $12.30",
				"보관 중인 세션 기준이라 gc로 지운 옛 세션은 빠집니다.",
			].join("\n"),
		);
		expect(renderUsage(ZERO, ZERO).split("\n")[0]).toBe(
			"이 대화: 모델 호출 0회 · 입력 0 (캐시 읽기 0%) · 출력 0 · 비용 $0.00",
		);
	});
});
