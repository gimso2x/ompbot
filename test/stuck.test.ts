import { describe, expect, test } from "bun:test";
import {
	createStuckDetector,
	STUCK_CANCEL_AT,
	STUCK_STEER_AT,
	type StuckDetector,
	type StuckHit,
	toolFingerprint,
} from "../src/core/stuck";
import type { OmpEvent } from "../src/omp/driver";

let seq = 0;
/** One tool call as omp reports it: a start event with the args, an end event with the result. */
function call(
	toolName: string,
	args: unknown,
	text: string,
	{ isError = false, details }: { isError?: boolean; details?: unknown } = {},
): OmpEvent[] {
	const toolCallId = `tc${++seq}`;
	return [
		{ type: "tool_execution_start", toolCallId, toolName, args },
		{
			type: "tool_execution_end",
			toolCallId,
			toolName,
			result: { content: [{ type: "text", text }], details },
			isError,
		},
	];
}

const feed = (detector: StuckDetector, events: OmpEvent[]): StuckHit[] =>
	events.map((event) => detector.observe(event)).filter((hit): hit is StuckHit => hit !== null);

/** Feeds `times` calls built by `make(i)` and returns every hit with the 1-based call number it fired on. */
function run(detector: StuckDetector, times: number, make: (i: number) => OmpEvent[]): (StuckHit & { i: number })[] {
	const hits: (StuckHit & { i: number })[] = [];
	for (let i = 1; i <= times; i++) for (const hit of feed(detector, make(i))) hits.push({ i, ...hit });
	return hits;
}

describe("stuck: loop detection", () => {
	test("same args and result: steer on the 3rd call, cancel on the 6th, nothing after", () => {
		expect(STUCK_STEER_AT).toBe(3);
		expect(STUCK_CANCEL_AT).toBe(6);
		const detector = createStuckDetector();
		const hits = run(detector, 6, () => call("bash", { command: "bun test" }, "1 fail"));
		expect(hits).toEqual([
			{ i: 3, action: "steer", toolName: "bash", count: 3 },
			{ i: 6, action: "cancel", toolName: "bash", count: 6 },
		]);
		expect(feed(detector, call("bash", { command: "bun test" }, "1 fail"))).toEqual([]);
	});

	test("same args with a changing result is progress: no hit in 10 calls", () => {
		const detector = createStuckDetector();
		expect(run(detector, 10, (i) => call("bash", { command: "curl -s status" }, `progress ${i}`))).toEqual([]);
	});

	test("an A,B,A,B loop is caught: two steers after three rounds", () => {
		const detector = createStuckDetector();
		const hits = run(detector, 3, () => [...call("read", { path: "a" }, "A"), ...call("read", { path: "b" }, "B")]);
		expect(hits.map((hit) => hit.action)).toEqual(["steer", "steer"]);
	});

	test("transient errors double the thresholds: steer on the 6th call, cancel on the 12th", () => {
		for (const text of [
			"Request timed out after 30s",
			"HTTP 429 Too Many Requests",
			"502 Bad Gateway",
			"read ECONNRESET",
		]) {
			const hits = run(createStuckDetector(), 12, () => call("fetch", { url: "u" }, text, { isError: true }));
			expect(hits.map(({ i, action }) => ({ i, action }))).toEqual([
				{ i: 6, action: "steer" },
				{ i: 12, action: "cancel" },
			]);
		}
		// The same words in a successful result are not a transient error.
		const hits = run(createStuckDetector(), 6, () => call("read", { path: "log" }, "timeout=30"));
		expect(hits.map(({ i, action }) => ({ i, action }))).toEqual([
			{ i: 3, action: "steer" },
			{ i: 6, action: "cancel" },
		]);
	});

	test("waiting and polling tools never hit; a plain read of the same path still does", () => {
		const detector = createStuckDetector();
		expect(run(detector, 10, () => call("wait", { ids: ["bg_1"] }, "still running"))).toEqual([]);
		expect(run(detector, 10, () => call("read", { path: "proc://bg_1" }, "running"))).toEqual([]);
		expect(run(detector, 10, () => call("read", { path: "agent://Scout" }, "running"))).toEqual([]);
		expect(run(detector, 10, () => call("ompbot_request_approval", { summary: "push" }, "pending"))).toEqual([]);
		expect(run(detector, 3, () => call("read", { path: "src/a.ts" }, "same")).map((hit) => hit.action)).toEqual([
			"steer",
		]);
	});
});

describe("stuck: fingerprint", () => {
	const result = { content: [{ type: "text", text: "x" }] };

	test("key order and details do not matter; isError and the tool name do", () => {
		expect(toolFingerprint("t", { a: 1, b: 2 }, result, false)).toBe(
			toolFingerprint("t", { b: 2, a: 1 }, result, false),
		);
		expect(toolFingerprint("t", {}, { ...result, details: { ms: 1 } }, false)).toBe(
			toolFingerprint("t", {}, { ...result, details: { ms: 99 } }, false),
		);
		expect(toolFingerprint("t", {}, result, false)).not.toBe(toolFingerprint("t", {}, result, true));
		expect(toolFingerprint("t", { a: 1 }, result, false)).not.toBe(toolFingerprint("u", { a: 1 }, result, false));
	});

	test("omp's identical-output counter note is stripped before hashing (omp 18.11.3 wording)", () => {
		const base = "[/data/realtest/proj/x.txt#7E92]\n1:same";
		const note = (n: number): string =>
			`${base}\n\n[You have received this identical output ${n} times. Re-reading '/data/realtest/proj/x.txt' will not change it \u2014 use a narrower selector (path:A-B), or proceed with the edit.]`;
		const fingerprint = (text: string): string =>
			toolFingerprint("read", { path: "x.txt" }, { content: [{ type: "text", text }] }, false);
		expect(fingerprint(note(3))).toBe(fingerprint(base));
		expect(fingerprint(note(4))).toBe(fingerprint(note(5)));
		expect(fingerprint(`${base}\n2:other`)).not.toBe(fingerprint(base));
	});
});
