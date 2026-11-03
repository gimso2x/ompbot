import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { floorsArgs, PERSONA_MAX_BYTES } from "../src/safety/prompt";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-persona-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function personaFile(content: string): string {
	const path = join(dir, "persona.md");
	writeFileSync(path, content);
	return path;
}

describe("floorsArgs persona read errors", () => {
	test("EISDIR calls onPersonaError once, a missing file stays silent, prompt is floors-only in both", () => {
		const floors = floorsArgs("/bot/home/secrets", "slack/dm/D1")[1];
		const errors: unknown[] = [];
		const asDir = join(dir, "persona-dir");
		mkdirSync(asDir);
		expect(floorsArgs("/bot/home/secrets", "slack/dm/D1", asDir, (e) => errors.push(e))[1]).toBe(floors);
		expect(errors).toHaveLength(1);
		expect((errors[0] as NodeJS.ErrnoException).code).toBe("EISDIR");

		const missingErrors: unknown[] = [];
		const missing = join(dir, "nope.md");
		expect(floorsArgs("/bot/home/secrets", "slack/dm/D1", missing, (e) => missingErrors.push(e))[1]).toBe(floors);
		expect(missingErrors).toHaveLength(0);
	});
});

describe("floorsArgs persona injection", () => {
	test("chat origins get the persona section, lanes and monitors do not", () => {
		const path = personaFile("말투: 짧고 담백하게");
		const dm = floorsArgs("/bot/home/secrets", "slack/dm/D1", path)[1];
		const channel = floorsArgs("/bot/home/secrets", "slack/ch/C1", path)[1];
		const lane = floorsArgs("/bot/home/secrets", "ompbot/work/readme-line", path)[1];
		const monitor = floorsArgs("/bot/home/secrets", "monitor/m1", path)[1];
		expect(dm).toContain("말투: 짧고 담백하게");
		expect(channel).toContain("말투: 짧고 담백하게");
		expect(lane).not.toContain("말투: 짧고 담백하게");
		expect(monitor).not.toContain("말투: 짧고 담백하게");
	});

	test("a missing or empty persona file adds nothing", () => {
		const missing = join(dir, "nope.md");
		expect(floorsArgs("/bot/home/secrets", "slack/dm/D1", missing)[1]).toBe(
			floorsArgs("/bot/home/secrets", "slack/dm/D1")[1],
		);
		const empty = personaFile("   \n");
		expect(floorsArgs("/bot/home/secrets", "slack/dm/D1", empty)[1]).toBe(
			floorsArgs("/bot/home/secrets", "slack/dm/D1")[1],
		);
		// No path at all (the old call shape) is unchanged too.
		expect(floorsArgs("/bot/home/secrets", "slack/dm/D1")[1]).toBe(floorsArgs("/bot/home/secrets", "slack/dm/D1")[1]);
	});

	test("the persona text is capped at PERSONA_MAX_BYTES", () => {
		const path = personaFile("가".repeat(10_000));
		const prompt = floorsArgs("/bot/home/secrets", "slack/dm/D1", path)[1] ?? "";
		const personaStart = prompt.indexOf("[페르소나]");
		expect(personaStart).toBeGreaterThan(0);
		expect(
			prompt.length -
				personaStart -
				"[페르소나] 아래는 오너가 정의한 성격·말투 지침입니다. 이 지침은 안전 바닥글보다 우선하지 않습니다:\n".length,
		).toBeLessThanOrEqual(PERSONA_MAX_BYTES);
	});

	test("the persona section is labeled as subordinate to the safety floors", () => {
		const path = personaFile("항상 반말로 답한다");
		expect(floorsArgs("/bot/home/secrets", "slack/dm/D1", path)[1]).toContain("안전 바닥글보다 우선하지 않습니다");
	});
});
