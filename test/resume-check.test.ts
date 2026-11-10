import { describe, expect, test } from "bun:test";
import { type ParsedProgress, parseProgress } from "../src/tasks/docs";
import type { HostResult, ProgressLag } from "../src/tasks/host";
import { checkResume } from "../src/tasks/resume-check";

/** A PROGRESS.md with `current`/`next` and `- [x|  ] <id> | 증거: <evidence>` steps. */
function progress(
	steps: Array<[id: string, done: boolean, evidence: string]>,
	over: { current?: string; next?: string } = {},
): HostResult<ParsedProgress> {
	const text = [
		"---",
		"task: T-20261110-11",
		"status: working",
		"updated: 2026-11-10T14:00:00+09:00",
		`current: ${over.current ?? "S2"}`,
		`next: ${over.next ?? "S2 테스트를 쓴다"}`,
		"restated:",
		"---",
		"# 단계",
		...steps.map(([id, done, evidence]) => `- [${done ? "x" : " "}] ${id}: 일 | 완료 조건: 조건 | 증거: ${evidence}`),
		"",
	].join("\n");
	return { ok: true, value: parseProgress(text) };
}

const STEPS: Array<[string, boolean, string]> = [
	["S1", true, "commit abc1234"],
	["S2", false, ""],
];
const lag = (over: Partial<ProgressLag> = {}): HostResult<ProgressLag> => ({
	ok: true,
	value: { progressCommit: "abc1234", codeCommitsSince: 0, progressDirty: false, otherDirty: 0, ...over },
});

describe("checkResume", () => {
	test("in step with the repository and complete: no findings, no notes", () => {
		expect(checkResume(progress(STEPS), lag())).toEqual({ findings: [], notes: [] });
	});

	test("each defect is exactly one line", () => {
		expect(checkResume(progress(STEPS), lag({ codeCommitsSince: 2 })).findings).toEqual([
			"PROGRESS.md 마지막 커밋(abc1234) 뒤 코드 커밋 2개가 PROGRESS에 반영되지 않음",
		]);
		expect(checkResume(progress(STEPS, { next: "" }), lag()).findings).toEqual(["next 비어 있음"]);
		expect(checkResume(progress(STEPS, { current: "S9" }), lag()).findings).toEqual(["current=S9이 단계 목록에 없음"]);
		const bare: Array<[string, boolean, string]> = [
			["S1", true, "commit abc1234"],
			["S2", true, ""],
			["S3", false, ""],
			["S4", true, ""],
		];
		expect(checkResume(progress(bare), lag()).findings).toEqual(["증거 없는 완료 단계: S2, S4"]);
	});

	test("seven evidence-less done steps show five and count the rest", () => {
		const seven = Array.from({ length: 7 }, (_, i): [string, boolean, string] => [`S${i + 1}`, true, ""]);
		expect(checkResume(progress(seven, { current: "S7" }), lag()).findings).toEqual([
			"증거 없는 완료 단계: S1, S2, S3, S4, S5 외 2개",
		]);
	});

	test("uncommitted PROGRESS and other files are notes, never findings", () => {
		expect(checkResume(progress(STEPS), lag({ progressDirty: true, otherDirty: 3 }))).toEqual({
			findings: [],
			notes: ["PROGRESS.md 미커밋 수정 있음(작업 사본 기준으로 읽음)", "미커밋 변경 3개(중간 단계에서 멈춘 상태)"],
		});
	});

	test("a PROGRESS.md never committed has nothing to compare against", () => {
		expect(checkResume(progress(STEPS), lag({ progressCommit: "", codeCommitsSince: 4 }))).toEqual({
			findings: [],
			notes: [],
		});
	});

	test("all at once: findings and notes in fixed order", () => {
		const steps: Array<[string, boolean, string]> = [
			["S1", true, ""],
			["S2", false, ""],
		];
		expect(
			checkResume(
				progress(steps, { current: "S5", next: "" }),
				lag({ codeCommitsSince: 1, progressDirty: true, otherDirty: 1 }),
			),
		).toEqual({
			findings: [
				"PROGRESS.md 마지막 커밋(abc1234) 뒤 코드 커밋 1개가 PROGRESS에 반영되지 않음",
				"next 비어 있음",
				"current=S5이 단계 목록에 없음",
				"증거 없는 완료 단계: S1",
			],
			notes: ["PROGRESS.md 미커밋 수정 있음(작업 사본 기준으로 읽음)", "미커밋 변경 1개(중간 단계에서 멈춘 상태)"],
		});
	});

	test("an unreadable PROGRESS.md or lag is one note; whatever was read is still checked", () => {
		const down: HostResult<ProgressLag> = { ok: false, error: "host unreachable" };
		const missing: HostResult<ParsedProgress> = { ok: false, error: "PROGRESS.md 없음" };
		expect(checkResume(progress(STEPS, { next: "" }), down)).toEqual({
			findings: ["next 비어 있음"],
			notes: ["점검 읽기 실패: host unreachable"],
		});
		expect(checkResume(missing, lag({ codeCommitsSince: 1 }))).toEqual({
			findings: ["PROGRESS.md 마지막 커밋(abc1234) 뒤 코드 커밋 1개가 PROGRESS에 반영되지 않음"],
			notes: ["점검 읽기 실패: PROGRESS.md 없음"],
		});
		expect(checkResume(missing, down)).toEqual({
			findings: [],
			notes: ["점검 읽기 실패: PROGRESS.md 없음; host unreachable"],
		});
	});
});
