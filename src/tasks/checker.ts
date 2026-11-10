import { createHash } from "node:crypto";
import { classifyLaneCompletion, type IntegrityRefusal } from "../lanes/integrity";
import {
	type AcceptanceItem,
	oneLine,
	type ProgressStep,
	parseIsoMs,
	parseOutcome,
	parseProgress,
	parseSpec,
	stripAcPrefix,
} from "./docs";
import { checkSignalsOf } from "./signals";

export const COMMIT_HASH = /^[0-9a-f]{7,40}$/;
const TEST_EVIDENCE = /\S.*(?:→|->)\s*\S/;

export interface CheckInput {
	/** Acceptance criteria as registered; the spec file must still say exactly this. */
	snapshot: readonly AcceptanceItem[];
	/** File contents; `undefined` = the file does not exist. */
	spec: string | undefined;
	progress: string | undefined;
	outcome: string | undefined;
	/** Whether a commit is the task's own: on its branch after the docs commit (injected: `commitOnTaskBranch`). */
	commitCheck(hash: string): Promise<CommitCheck>;
	/**
	 * Runs the `[check: …]` signals of the snapshot in the task worktree (injected by the sweep only). Called once all
	 * other conditions are met; absent → checks are not run and the judgement stands on the documents alone.
	 */
	runChecks?(checks: readonly TaskCheckRequest[]): Promise<TaskChecksRun>;
	/**
	 * The task branch's diff since its docs commit, for the lane integrity classifier (injected by the sweep only, like
	 * `runChecks`). Called once all other conditions are met, before the checks; absent → the diff is not read.
	 */
	integrity?(): Promise<{ diff: string } | { error: string }>;
}

/** Integrity refusals that hold a task short of the outcome; the other categories only warn on the card. */
const BLOCKING_INTEGRITY: ReadonlySet<IntegrityRefusal["category"]> = new Set([
	"unfinished_work_marker",
	"skipped_test",
	"stub_implementation",
]);
const INTEGRITY_EXCERPT_MAX = 160;
const INTEGRITY_ERROR_MAX = 120;

/** One signal of one criterion's `[check: …]`, as registered. */
export interface TaskCheckRequest {
	id: string;
	signal: string;
}

export interface TaskCheck extends TaskCheckRequest {
	ok: boolean;
	detail: string;
}

/** `deferred`: the checks were not run (e.g. uncommitted changes) and this is why; otherwise every result at `head`. */
export type TaskChecksRun = { deferred: string } | { head: string; results: TaskCheck[] };

const CHECK_DETAIL_MAX = 120;

/** Every check signal of the registered criteria; a malformed block becomes one signal that fails when run. */
export function taskChecksOf(snapshot: readonly AcceptanceItem[]): TaskCheckRequest[] {
	return snapshot.flatMap((item) => {
		try {
			return checkSignalsOf(item.text).map((signal) => ({ id: item.id, signal }));
		} catch {
			return [{ id: item.id, signal: item.text.slice(item.text.lastIndexOf("[check:")) }];
		}
	});
}

/**
 * `ok`: on the task branch after its docs commit · `missing`: not in the repository · `not_on_branch`: anywhere else
 * (main, another branch, the docs commit itself) · `no_base`: the branch has no docs commit to measure from.
 */
export type CommitCheck = "ok" | "missing" | "not_on_branch" | "no_base";

export interface TaskJudgement {
	reached: boolean;
	acChecked: number;
	acTotal: number;
	stepsDone: number;
	stepsTotal: number;
	/** PROGRESS.md `status` as written (`working`, `blocked`, or something the agent should not write). */
	status: string;
	/** PROGRESS.md `updated` as written. */
	updatedAt: string;
	/** `updatedAt` as epoch ms, `undefined` when missing or unparsable. */
	updatedAtMs: number | undefined;
	specChanged: boolean;
	/** Fingerprint of the spec's acceptance section — the dedup key of the spec-change notice. */
	specKey: string;
	blocked: boolean;
	blockedReason: string;
	/** The decision request written beside `status: blocked` (each part `""` when not written). */
	decision: { question: string; recommend: string; impact: string };
	current: string;
	/** PROGRESS.md `restated` as written (`""` when absent); posted once per value, never part of the judgement. */
	restated: string;
	/** Per-AC evidence lines (`commit …`, `test …`, `file …`) as written, for the report. */
	evidence: Record<string, string[]>;
	/** outcome.md `## 요약` lines as parsed (`[]` without the file); shown on the card, never part of the judgement. */
	summary: string[];
	/** `[check: …]` results the sweep ran for this judgement; `[]` when the task has none or they were not run. */
	checks: TaskCheck[];
	/** `무결성 <category>: <excerpt>` lines that do not hold the outcome but go on the card; `[]` without a diff read. */
	integrityWarnings: string[];
	/** Fingerprint of everything the judgement stands on — the dedup key of the "reached" notice. */
	reachKey: string;
	/** The registered acceptance items with their spec.md checkbox, for display (not part of the judgement). */
	acceptance: Array<{ id: string; text: string; checked: boolean }>;
	/** PROGRESS.md steps as written, for display (not part of the judgement). */
	steps: Array<{ id: string; text: string; done: boolean }>;
	/** Human-readable unmet conditions; empty exactly when `reached`. */
	problems: string[];
}

/** sha256 of the JSON form, first 12 hex characters: the dedup key of a notice. */
export const digest = (value: unknown): string =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);

/**
 * The only place a task's outcome is decided: registered acceptance snapshot × spec checkboxes × outcome evidence ×
 * commit existence. PROGRESS.md contributes the blocked flag and bookkeeping only — its own `review`/`done` status
 * and any prose never count as completion.
 */
export async function checkTask(input: CheckInput): Promise<TaskJudgement> {
	const problems: string[] = [];
	const specDoc = input.spec === undefined ? undefined : parseSpec(input.spec);
	const progress = input.progress === undefined ? undefined : parseProgress(input.progress);
	const outcome = input.outcome === undefined ? undefined : parseOutcome(input.outcome);
	if (specDoc === undefined) problems.push("spec.md를 읽을 수 없습니다");
	if (progress === undefined) problems.push("PROGRESS.md를 읽을 수 없습니다");
	if (outcome === undefined) problems.push("outcome.md를 읽을 수 없습니다");

	let specChanged = false;
	if (specDoc !== undefined) {
		const same =
			specDoc.hasAcceptanceSection &&
			specDoc.malformed.length === 0 &&
			specDoc.acceptance.length === input.snapshot.length &&
			specDoc.acceptance.every((item, index) => {
				const registered = input.snapshot[index] as AcceptanceItem;
				return item.id === registered.id && oneLine(item.text) === oneLine(registered.text);
			});
		if (!same) {
			specChanged = true;
			problems.push("spec.md 수락기준이 등록 스냅샷과 다릅니다(개수·ID·문구)");
		}
	}

	const checkedIds = new Set(specDoc?.acceptance.filter((item) => item.checked).map((item) => item.id));
	const evidence: Record<string, string[]> = {};
	const commits = new Set<string>();
	for (const item of input.snapshot) {
		if (specDoc !== undefined && !checkedIds.has(item.id))
			problems.push(`${item.id}: spec.md 체크박스가 [x]가 아닙니다`);
		if (outcome === undefined) continue;
		const section = outcome.sections.get(item.id);
		if (section === undefined) {
			problems.push(`${item.id}: outcome.md에 절이 없습니다`);
			continue;
		}
		const lines: string[] = [];
		let proofs = 0;
		for (const entry of section.commits) {
			const hash = entry.split(/\s+/, 1)[0] ?? "";
			if (COMMIT_HASH.test(hash)) {
				commits.add(hash);
				proofs += 1;
			} else {
				problems.push(`${item.id}: commit 해시 형식이 아닙니다: ${entry.slice(0, 40)}`);
			}
			lines.push(`commit ${entry}`);
		}
		for (const entry of section.tests) {
			if (TEST_EVIDENCE.test(entry)) proofs += 1;
			else problems.push(`${item.id}: test 증거는 '<명령> → <결과 줄>' 형식이어야 합니다`);
			lines.push(`test ${entry}`);
		}
		for (const entry of section.files) lines.push(`file ${entry}`);
		if (proofs === 0) problems.push(`${item.id}: commit 또는 test 증거가 없습니다`);
		evidence[item.id] = lines;
	}

	for (const hash of commits) {
		// Anything but a commit the task itself made is an unmet condition, never a pass.
		const found = await input.commitCheck(hash);
		if (found === "missing") problems.push(`commit ${hash}가 워크트리 저장소에 없습니다`);
		else if (found === "not_on_branch")
			problems.push(`commit ${hash}는 task 브랜치(<4문서 커밋 이후)의 새 커밋이 아닙니다`);
		else if (found === "no_base")
			problems.push(`task 브랜치에서 4문서 커밋을 찾지 못해 commit ${hash}를 확인할 수 없습니다`);
	}

	const status = progress?.status ?? "";
	const blocked = status === "blocked";
	if (blocked)
		problems.push(`PROGRESS.md status가 blocked입니다${progress?.blockedReason ? `: ${progress.blockedReason}` : ""}`);

	// The diff is read only for an otherwise complete task, before any check process runs.
	const integrityWarnings: string[] = [];
	if (problems.length === 0 && input.integrity !== undefined) {
		const read = await input.integrity();
		if ("error" in read) {
			problems.push(`diff를 읽지 못해 무결성 검사를 미룹니다: ${read.error.slice(0, INTEGRITY_ERROR_MAX)}`);
		} else {
			const refusals = classifyLaneCompletion({ summary: (outcome?.summary ?? []).join("\n"), diff: read.diff });
			for (const refusal of refusals) {
				const line = `무결성 ${refusal.category}: ${refusal.excerpt.slice(0, INTEGRITY_EXCERPT_MAX)}`;
				if (BLOCKING_INTEGRITY.has(refusal.category)) problems.push(line);
				else integrityWarnings.push(line);
			}
		}
	}

	// The checks run last and only on an otherwise complete task: a run is a real process in the worktree.
	const requests = taskChecksOf(input.snapshot);
	let checkRun: { head: string; results: TaskCheck[] } | undefined;
	if (requests.length > 0 && problems.length === 0 && input.runChecks !== undefined) {
		const run = await input.runChecks(requests);
		if ("deferred" in run) problems.push(run.deferred);
		else {
			checkRun = run;
			for (const check of run.results.filter((result) => !result.ok))
				problems.push(`check ${check.id} 실패: ${check.detail.slice(0, CHECK_DETAIL_MAX)}`);
		}
	}

	const steps: ProgressStep[] = progress?.steps ?? [];
	const updatedAt = progress?.updated ?? "";
	const reached = problems.length === 0;
	return {
		reached,
		acChecked: input.snapshot.filter((item) => checkedIds.has(item.id)).length,
		acTotal: input.snapshot.length,
		stepsDone: steps.filter((step) => step.done).length,
		stepsTotal: steps.length,
		status,
		updatedAt,
		updatedAtMs: updatedAt === "" ? undefined : parseIsoMs(updatedAt),
		specChanged,
		specKey: digest(specDoc?.acceptance ?? null),
		blocked,
		blockedReason: progress?.blockedReason ?? "",
		decision: {
			question: progress?.question ?? "",
			recommend: progress?.recommend ?? "",
			impact: progress?.impact ?? "",
		},
		current: progress?.current ?? "",
		restated: progress?.restated ?? "",
		evidence,
		summary: outcome?.summary ?? [],
		checks: checkRun?.results ?? [],
		integrityWarnings,
		// `head`/`checks`/`integrityWarnings` are absent (dropped by JSON) without a check run or a warning, so such a
		// task keeps its former key.
		reachKey: digest({
			spec: specDoc?.acceptance,
			evidence,
			updatedAt,
			head: checkRun?.head,
			checks: checkRun?.results,
			integrityWarnings: integrityWarnings.length === 0 ? undefined : integrityWarnings,
		}),
		acceptance: input.snapshot.map((item) => ({
			id: item.id,
			text: stripAcPrefix(item.text),
			checked: checkedIds.has(item.id),
		})),
		steps: steps.map((step) => ({ id: step.id, text: step.text, done: step.done })),
		problems,
	};
}

/** `AC n/m · 단계 n/m · status · 마지막 갱신` — the one-line summary for output reads and the CLI. */
export function summarizeJudgement(judgement: TaskJudgement, taskStatus: string): string {
	return `AC ${judgement.acChecked}/${judgement.acTotal} · 단계 ${judgement.stepsDone}/${judgement.stepsTotal} · ${taskStatus} · ${judgement.updatedAt === "" ? "갱신 없음" : judgement.updatedAt}`;
}
