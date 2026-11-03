import { createHash } from "node:crypto";
import {
	type AcceptanceItem,
	oneLine,
	type ProgressStep,
	parseIsoMs,
	parseOutcome,
	parseProgress,
	parseSpec,
} from "./docs";

export const COMMIT_HASH = /^[0-9a-f]{7,40}$/;
const TEST_EVIDENCE = /\S.*(?:→|->)\s*\S/;

export interface CheckInput {
	/** Acceptance criteria as registered; the spec file must still say exactly this. */
	snapshot: readonly AcceptanceItem[];
	/** File contents; `undefined` = the file does not exist. */
	spec: string | undefined;
	progress: string | undefined;
	outcome: string | undefined;
	/** Whether a commit exists in the task's worktree repository (injected: `git cat-file -e <hash>^{commit}`). */
	commitExists(hash: string): Promise<boolean>;
}

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
	/** Per-AC evidence lines (`commit …`, `test …`, `file …`) as written, for the report. */
	evidence: Record<string, string[]>;
	/** Fingerprint of everything the judgement stands on — the dedup key of the "reached" notice. */
	reachKey: string;
	/** Human-readable unmet conditions; empty exactly when `reached`. */
	problems: string[];
}

const digest = (value: unknown): string =>
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
		// A failed existence probe is an unmet condition, never a pass.
		if (!(await input.commitExists(hash))) problems.push(`commit ${hash}가 워크트리 저장소에 없습니다`);
	}

	const status = progress?.status ?? "";
	const blocked = status === "blocked";
	if (blocked)
		problems.push(`PROGRESS.md status가 blocked입니다${progress?.blockedReason ? `: ${progress.blockedReason}` : ""}`);

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
		evidence,
		reachKey: digest({ spec: specDoc?.acceptance, evidence, updatedAt }),
		problems,
	};
}

/** `AC n/m · 단계 n/m · status · 마지막 갱신` — the one-line summary for output reads and the CLI. */
export function summarizeJudgement(judgement: TaskJudgement, taskStatus: string): string {
	return `AC ${judgement.acChecked}/${judgement.acTotal} · 단계 ${judgement.stepsDone}/${judgement.stepsTotal} · ${taskStatus} · ${judgement.updatedAt === "" ? "갱신 없음" : judgement.updatedAt}`;
}
