import { describe, expect, test } from "bun:test";
import { OWNER_NAME_PATTERN } from "../src/dispatch/omp";
import { type CommitCheck, checkTask, summarizeJudgement, type TaskJudgement } from "../src/tasks/checker";
import {
	acceptanceItems,
	agentNameOf,
	formatTaskId,
	type NewTaskSpec,
	parseOutcome,
	parseProgress,
	parseSpec,
	parseTaskSpecInput,
	renderContext,
	renderOutcome,
	renderProgress,
	renderSpec,
	TaskSpecError,
	worktreePathOf,
} from "../src/tasks/docs";
import { parseChecks } from "../src/tasks/signals";
import { localDay, localIso } from "../src/time";

const spec: NewTaskSpec = {
	title: "로그 정리",
	risk: "L2",
	goal: "로그 회전을 넣는다",
	scope: ["src/log.ts"],
	exclusions: ["배포"],
	acceptance: ["회전 테스트가 통과한다", "README에   설명이\n있다"],
	repo: "/home/u/repo",
	background: "배경 한 줄",
};
const meta = {
	taskId: "T-20261026-01",
	hostLabel: "wsl",
	repo: spec.repo,
	worktree: worktreePathOf(spec.repo, "T-20261026-01"),
	branch: "task/T-20261026-01",
	agent: agentNameOf("T-20261026-01"),
	threadLink: "C1:1.2",
	registeredAt: Date.parse("2026-10-26T06:04:05Z"),
	timezone: "Asia/Seoul",
};
const snapshot = acceptanceItems(spec.acceptance);

describe("ids and time", () => {
	test("KST day and id/agent shapes", () => {
		expect(localDay(Date.parse("2026-10-25T16:00:00Z"), "Asia/Seoul")).toBe("20261026");
		expect(localIso(Date.parse("2026-10-26T06:04:05Z"), "Asia/Seoul")).toBe("2026-10-26T15:04:05+09:00");
		expect(formatTaskId("20261026", 3)).toBe("T-20261026-03");
		expect(OWNER_NAME_PATTERN.test(agentNameOf("T-20261026-03"))).toBe(true);
	});
});

describe("taskSpec input", () => {
	test("resume takes only an id", () => {
		expect(parseTaskSpecInput({ id: "T-20261026-01" })).toEqual({ kind: "resume", id: "T-20261026-01" });
		expect(() => parseTaskSpecInput({ id: "T-20261026-01", title: "x" })).toThrow(TaskSpecError);
		expect(() => parseTaskSpecInput({ id: "nope" })).toThrow(TaskSpecError);
	});

	test("new spec is validated and normalized to one-line fields", () => {
		const parsed = parseTaskSpecInput({ ...spec, repo: "/home/u/repo/" });
		expect(parsed.kind).toBe("new");
		if (parsed.kind === "new") {
			expect(parsed.spec.acceptance[1]).toBe("README에 설명이 있다");
			expect(parsed.spec.repo).toBe("/home/u/repo");
		}
	});

	test.each([
		["risk", { ...spec, risk: "L9" }],
		["acceptance empty", { ...spec, acceptance: [] }],
		["relative repo", { ...spec, repo: "repo" }],
		["shell in repo", { ...spec, repo: "/a/b;rm -rf /" }],
		["dotdot repo", { ...spec, repo: "/a/../b" }],
		["blank goal", { ...spec, goal: "  " }],
	])("rejects %s", (_name, raw) => {
		expect(() => parseTaskSpecInput(raw)).toThrow(TaskSpecError);
	});
});

describe("secret masking at the document boundaries", () => {
	// Fake token shapes only, built at run time.
	const SLACK = ["xoxb", "TEST", "0", "docs"].join("-");
	const GH = `ghp_${"T".repeat(36)}`;

	test("AC-5: a spec without secrets parses exactly as written (check block included)", () => {
		const acceptance = ['회전 테스트가 통과한다 [check: command ["bun","test"]]', "README에 설명이 있다"];
		const parsed = parseTaskSpecInput({ ...spec, acceptance, assumptions: "가정 한 줄" });
		expect(parsed).toEqual({ kind: "new", spec: { ...spec, acceptance, assumptions: "가정 한 줄" } });
	});

	test("B-5: two spaces inside a check argv survive registration, the snapshot and the spec.md round trip", () => {
		const block = '[check: command ["bun", "test",  "-t", "a  b"]]';
		const criterion = `회전   테스트가\n통과한다 ${block}`;
		const parsed = parseTaskSpecInput({ ...spec, acceptance: [criterion] });
		if (parsed.kind !== "new") throw new Error("expected a new spec");
		expect(parsed.spec.acceptance).toEqual([`회전 테스트가 통과한다 ${block}`]);
		const items = acceptanceItems(parsed.spec.acceptance);
		expect(items[0]?.text).toBe(`회전 테스트가 통과한다 ${block}`);
		const back = parseSpec(renderSpec(meta, parsed.spec, items));
		expect(back.acceptance[0]?.text).toBe(`회전 테스트가 통과한다 ${block}`);
		expect(parseChecks(back.acceptance[0]?.text ?? "")).toEqual([
			expect.objectContaining({ argv: ["bun", "test", "-t", "a  b"] }),
		]);
	});

	test("AC-2b: PROGRESS prose fields and the outcome summary are masked as they are read", () => {
		const progress = parseProgress(
			[
				"---",
				"task: T-20261026-01",
				"status: blocked",
				"updated: 2026-10-26T15:04:05+09:00",
				`current: S2 ${SLACK}`,
				`next: ${GH} 기다린다`,
				`restated: 과제 ${SLACK} / S2 / 테스트`,
				`blocked_reason: 토큰 ${GH} 만료`,
				`question: ${SLACK}를 바꿀까요?`,
				`recommend: ${GH} 회전`,
				`impact: ${SLACK} 무효`,
				"---",
				"# 단계",
				"- [ ] S2: 구현 | 완료 조건: 테스트 | 증거:",
			].join("\n"),
		);
		expect(progress).toMatchObject({
			status: "blocked",
			current: "S2 [REDACTED]",
			next: "[REDACTED] 기다린다",
			restated: "과제 [REDACTED] / S2 / 테스트",
			blockedReason: "토큰 [REDACTED] 만료",
			question: "[REDACTED]를 바꿀까요?",
			recommend: "[REDACTED] 회전",
			impact: "[REDACTED] 무효",
		});
		const outcome = parseOutcome(`## 요약\n- 토큰 ${GH} 회전 완료\n## AC-1\n- commit: abc1234 feat\n`);
		expect(outcome.summary).toEqual(["토큰 [REDACTED] 회전 완료"]);
		expect(outcome.sections.get("AC-1")?.commits).toEqual(["abc1234 feat"]);
	});
});

describe("document round trip", () => {
	test("spec renders and parses back to the same acceptance list, unchecked", () => {
		const parsed = parseSpec(renderSpec(meta, spec, snapshot));
		expect(parsed.task).toBe(meta.taskId);
		expect(parsed.malformed).toEqual([]);
		expect(parsed.acceptance).toEqual(snapshot.map((item) => ({ ...item, checked: false })));
	});

	test("context carries the original request and metadata", () => {
		const text = renderContext(meta, spec, "원문 그대로\n두 줄");
		expect(text).toContain("## 요청 원문\n원문 그대로\n두 줄");
		expect(text).toContain("위험등급: L2");
		expect(text).toContain("branch task/T-20261026-01");
	});

	test("PROGRESS starts working with one placeholder step; steps and fields parse", () => {
		const initial = parseProgress(renderProgress(meta.taskId, meta.registeredAt, "Asia/Seoul"));
		expect(initial).toMatchObject({ task: meta.taskId, status: "working", current: "S1", blockedReason: "" });
		expect(initial.steps).toHaveLength(1);
		const parsed = parseProgress(
			[
				"---",
				"task: T-20261026-01",
				"status: blocked",
				"updated: 2026-10-26T15:04:05+09:00",
				"current: S2",
				"next: 기다린다",
				"blocked_reason: 토큰 없음",
				"---",
				"# 단계",
				"- [x] S1: 설계 | 완료 조건: 문서 | 증거: commit abc1234",
				"- [ ] S2: 구현 | 완료 조건: 테스트 | 증거:",
			].join("\n"),
		);
		expect(parsed.status).toBe("blocked");
		expect(parsed.blockedReason).toBe("토큰 없음");
		expect(parsed.steps.map((step) => [step.id, step.done, step.evidence])).toEqual([
			["S1", true, "commit abc1234"],
			["S2", false, ""],
		]);
		expect(parsed.steps[0]?.condition).toBe("문서");
	});

	test("PROGRESS carries an empty `restated:` key; a file without the key reads it as empty", () => {
		const rendered = renderProgress(meta.taskId, meta.registeredAt, "Asia/Seoul");
		expect(rendered.split("\n")).toContain("restated:");
		expect(parseProgress(rendered).restated).toBe("");
		const legacy = "---\ntask: T-20261026-01\nstatus: working\ncurrent: S1\nnext: 잇는다\n---\n# 단계\n";
		expect(parseProgress(legacy).restated).toBe("");
		const written = legacy.replace("next: 잇는다", "next: 잇는다\nrestated: 로그 회전 / S2 구현 / bun test 통과");
		expect(parseProgress(written).restated).toBe("로그 회전 / S2 구현 / bun test 통과");
	});

	test("PROGRESS ends with an empty `# 결정` section; decision lines there are not read as steps", () => {
		const rendered = renderProgress(meta.taskId, meta.registeredAt, meta.timezone);
		expect(rendered.trimEnd().split("\n").at(-1)).toBe("# 결정");
		const decided = `${rendered}- 파일 잠금 / 큐 / 의존성 없음\n`;
		expect(parseProgress(decided).steps).toEqual(parseProgress(rendered).steps);
		expect(parseProgress(decided).steps).toHaveLength(1);
	});

	test("PROGRESS carries an empty `needs_owner:` key before blocked_reason; yes/true in any case is true", () => {
		const rendered = renderProgress(meta.taskId, meta.registeredAt, "Asia/Seoul").split("\n");
		expect(rendered).toContain("needs_owner:");
		expect(rendered.indexOf("needs_owner:")).toBe(rendered.indexOf("blocked_reason:") - 1);
		const legacy = "---\ntask: T-20261026-01\nstatus: blocked\ncurrent: S1\nnext: 잇는다\n---\n# 단계\n";
		const withValue = (value: string) => legacy.replace("next: 잇는다", `next: 잇는다\nneeds_owner:${value}`);
		for (const value of [" yes", " YES", " true", " True"])
			expect(parseProgress(withValue(value)).needsOwner).toBe(true);
		for (const value of ["", " no", " 네", " 1"]) expect(parseProgress(withValue(value)).needsOwner).toBe(false);
		expect(parseProgress(legacy).needsOwner).toBe(false);
		expect(parseProgress(rendered.join("\n")).needsOwner).toBe(false);
	});

	test("outcome sections collect commit/test/file evidence per AC", () => {
		const parsed = parseOutcome(
			"# T Outcome 증거\n## AC-1\n- commit: abc1234 feat\n- test: bun test → 5 pass\n## AC-2\n- file: README.md\n",
		);
		expect(parsed.sections.get("AC-1")).toEqual({ commits: ["abc1234 feat"], tests: ["bun test → 5 pass"], files: [] });
		expect(parsed.sections.get("AC-2")?.files).toEqual(["README.md"]);
		expect(parseOutcome(renderOutcome(meta.taskId))).toEqual({ sections: new Map(), summary: [] });
	});

	test("the 요약 section is the summary wherever it sits, and never leaks into or out of AC evidence", () => {
		const acs = "## AC-1\n- commit: abc1234 feat\n- test: bun test → 5 pass\n## AC-2\n- file: README.md\n";
		const summary = "## 요약\n- 로그가 회전합니다.\n\n• bun test 5 pass\n* 남은 위험 없음\n- commit: def5678 x\n";
		const alone = parseOutcome(`# T Outcome 증거\n${acs}`);
		const before = parseOutcome(`# T Outcome 증거\n${summary}${acs}`);
		const after = parseOutcome(`# T Outcome 증거\n${acs}${summary}`);
		const lines = ["로그가 회전합니다.", "bun test 5 pass", "남은 위험 없음", "commit: def5678 x"];
		expect(before.summary).toEqual(lines);
		expect(after.summary).toEqual(lines);
		expect(alone.summary).toEqual([]);
		expect(before.sections).toEqual(alone.sections);
		expect(after.sections).toEqual(alone.sections);
		// A later top-level heading ends the summary.
		expect(parseOutcome("## 요약\n하나\n# 메모\n둘\n").summary).toEqual(["하나"]);
	});
});

describe("checkTask table", () => {
	const checked = (ac: string[]): string =>
		renderSpec(meta, spec, snapshot).replace(/- \[ \] (AC-\d+)/g, (line, id: string) =>
			ac.includes(id) ? `- [x] ${id}` : line,
		);
	const progress = (status = "working", extra = ""): string =>
		`---\ntask: ${meta.taskId}\nstatus: ${status}\nupdated: 2026-10-26T15:04:05+09:00\ncurrent: S1\nnext: x\nblocked_reason: ${extra}\n---\n# 단계\n- [x] S1: a | 완료 조건: b | 증거: commit abc1234\n`;
	const outcome = "## AC-1\n- commit: abc1234 feat\n## AC-2\n- test: bun test → 5 pass\n";
	const commitCheck = async (hash: string): Promise<CommitCheck> => (hash === "abc1234" ? "ok" : "missing");
	const base = { snapshot, spec: checked(["AC-1", "AC-2"]), progress: progress(), outcome, commitCheck };

	test("everything in order is reached", async () => {
		const result = await checkTask(base);
		expect(result).toMatchObject({
			reached: true,
			acChecked: 2,
			acTotal: 2,
			stepsDone: 1,
			stepsTotal: 1,
			status: "working",
			problems: [],
		});
		expect(result.evidence["AC-1"]).toEqual(["commit abc1234 feat"]);
		expect(summarizeJudgement(result, "working")).toBe("AC 2/2 · 단계 1/1 · working · 2026-10-26T15:04:05+09:00");
	});

	test("the summary is carried but never judged: missing, empty or written, reached and problems stay the same", async () => {
		const verdict = ({ reached, problems, reachKey }: TaskJudgement) => ({
			reached,
			problems,
			reachKey,
		});
		const none = await checkTask(base);
		const empty = await checkTask({ ...base, outcome: `${renderOutcome(meta.taskId)}${outcome}` });
		const written = await checkTask({ ...base, outcome: `## 요약\n- 하나\n- 둘\n${outcome}` });
		expect(none.summary).toEqual([]);
		expect(empty.summary).toEqual([]);
		expect(written.summary).toEqual(["하나", "둘"]);
		expect(verdict(empty)).toEqual(verdict(none));
		expect(verdict(written)).toEqual(verdict(none));
		expect(none.reached).toBe(true);
		const notReached = { ...base, spec: checked(["AC-1"]) };
		expect(verdict(await checkTask({ ...notReached, outcome: `## 요약\n- 하나\n${outcome}` }))).toEqual(
			verdict(await checkTask(notReached)),
		);
		expect((await checkTask({ ...base, outcome: undefined })).summary).toEqual([]);
	});

	test("the judgement carries PROGRESS `restated` as written, outside the reach key", async () => {
		const plain = await checkTask(base);
		const restated = await checkTask({ ...base, progress: `restated: 과제 / S2 / 완료 조건\n${progress()}` });
		expect(plain.restated).toBe("");
		expect(restated.restated).toBe("");
		const front = progress().replace("---\n", "---\nrestated: 과제 / S2 / 완료 조건\n");
		const written = await checkTask({ ...base, progress: front });
		expect(written.restated).toBe("과제 / S2 / 완료 조건");
		expect(written.reachKey).toBe(plain.reachKey);
	});

	test("the judgement carries PROGRESS `needs_owner`", async () => {
		expect((await checkTask(base)).needsOwner).toBe(false);
		const owner = progress("blocked").replace("---\n#", "needs_owner: yes\n---\n#");
		const judged = await checkTask({ ...base, progress: owner });
		expect(judged).toMatchObject({ blocked: true, needsOwner: true });
	});

	test("the reach key changes when evidence changes", async () => {
		const first = await checkTask(base);
		const second = await checkTask({ ...base, outcome: `${outcome}- file: x\n` });
		expect(second.reachKey).not.toBe(first.reachKey);
	});

	test.each([
		["missing checkbox", { spec: checked(["AC-1"]) }, "AC-2: spec.md 체크박스"],
		["missing outcome section", { outcome: "## AC-1\n- commit: abc1234 feat\n" }, "AC-2: outcome.md에 절이 없습니다"],
		[
			"section without commit/test",
			{ outcome: "## AC-1\n- commit: abc1234 feat\n## AC-2\n- file: x\n" },
			"AC-2: commit 또는 test 증거가 없습니다",
		],
		[
			"test without result",
			{ outcome: "## AC-1\n- commit: abc1234 feat\n## AC-2\n- test: bun test\n" },
			"AC-2: test 증거는",
		],
		[
			"commit that does not exist",
			{ outcome: "## AC-1\n- commit: deadbee feat\n## AC-2\n- test: a → b\n" },
			"deadbee가 워크트리 저장소에 없습니다",
		],
		[
			"commit that is not the task's own",
			{ commitCheck: async (): Promise<CommitCheck> => "not_on_branch" },
			"commit abc1234는 task 브랜치(<4문서 커밋 이후)의 새 커밋이 아닙니다",
		],
		[
			"task branch without its docs commit",
			{ commitCheck: async (): Promise<CommitCheck> => "no_base" },
			"task 브랜치에서 4문서 커밋을 찾지 못해 commit abc1234를 확인할 수 없습니다",
		],
		["bad hash", { outcome: "## AC-1\n- commit: HEAD\n## AC-2\n- test: a → b\n" }, "해시 형식이 아닙니다"],
		["blocked", { progress: progress("blocked", "토큰 없음") }, "blocked"],
		["no outcome file", { outcome: undefined }, "outcome.md를 읽을 수 없습니다"],
		["no progress file", { progress: undefined }, "PROGRESS.md를 읽을 수 없습니다"],
	] as const)("%s → not reached", async (_name, override, problem) => {
		const result = await checkTask({ ...base, ...override });
		expect(result.reached).toBe(false);
		expect(result.problems.join("\n")).toContain(problem);
	});

	test("an edited, dropped, reworded or added criterion is a spec change", async () => {
		const original = checked(["AC-1", "AC-2"]);
		for (const edited of [
			original.replace("회전 테스트가 통과한다", "회전 테스트가 있다"),
			original.replace(/- \[x\] AC-2: .*\n/, ""),
			original.replace("AC-1", "AC-9"),
			`${original}- [x] AC-3: 새 기준\n`,
			original.replace("# 수락기준", "# 수락기준\n- 메모"),
		]) {
			const result = await checkTask({ ...base, spec: edited });
			expect(result.specChanged).toBe(true);
			expect(result.reached).toBe(false);
		}
		expect((await checkTask(base)).specChanged).toBe(false);
	});

	test("self-declared review/done in PROGRESS and prose never make a task reached", async () => {
		const result = await checkTask({
			...base,
			spec: checked([]),
			outcome: "완료했습니다",
			progress: `${progress("done")}\n완료\n`,
		});
		expect(result.reached).toBe(false);
		expect(result.status).toBe("done");
		// ... and a self-declared status does not block a genuinely complete one either.
		expect((await checkTask({ ...base, progress: progress("review") })).reached).toBe(true);
	});
});
