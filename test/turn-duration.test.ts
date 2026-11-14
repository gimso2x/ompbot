import { describe, expect, test } from "bun:test";
import { runningStatusText } from "../src/channel/text";
import { formatTypicalRange, typicalDuration, typicalNote } from "../src/store/turn-duration";

const minutes = (values: number[]): number[] => values.map((m) => m * 60_000);

describe("typicalNote", () => {
	test("AC-1: 9 samples give no note", () => {
		expect(typicalNote(60_000, typicalDuration(minutes([1, 2, 3, 4, 5, 6, 7, 8, 9])))).toBeUndefined();
	});

	test("AC-1: up to p90 it reads 보통 a~b분, past p90 평소보다 길어짐(보통 a~b분)", () => {
		const typical = typicalDuration(minutes([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
		expect(typical).toEqual({ medianMs: 300_000, p90Ms: 540_000 });
		expect(typicalNote(60_000, typical)).toBe("보통 5~9분");
		expect(typicalNote(540_000, typical)).toBe("보통 5~9분");
		expect(typicalNote(540_001, typical)).toBe("평소보다 길어짐(보통 5~9분)");
	});

	test("AC-1: the range rounds up to whole minutes, at least 1, and collapses to ~a분", () => {
		expect(formatTypicalRange({ medianMs: 81_000, p90Ms: 474_000 })).toBe("2~8분");
		expect(formatTypicalRange({ medianMs: 20_000, p90Ms: 60_000 })).toBe("~1분");
		expect(formatTypicalRange({ medianMs: 0, p90Ms: 0 })).toBe("~1분");
	});

	test("AC-1: the chat status line carries the same note after ' · '", () => {
		const typical = { medianMs: 81_000, p90Ms: 474_000 };
		const base = { tools: 0, recentTools: [], steers: 0, retries: 0, typical };
		for (const elapsed of [30_000, 474_000, 474_001]) {
			expect(runningStatusText(false, elapsed, base).endsWith(` · ${typicalNote(elapsed, typical)}`)).toBe(true);
		}
	});
});
