/**
 * The pre-resume check of a task: what PROGRESS.md says against where the worktree is. Pure — the caller reads
 * PROGRESS.md and `progressLag` from the task's host. A check never refuses a resume; it only tells the agent.
 */

import { createHash } from "node:crypto";
import type { ParsedProgress } from "./docs";
import type { HostResult, ProgressLag } from "./host";

export interface ResumeCheck {
	/** Defects the agent fixes in PROGRESS.md before it goes on, in a fixed order. */
	findings: string[];
	/** Facts about the worktree to read with, not to fix. */
	notes: string[];
}

const BARE_STEPS_SHOWN = 5;

/** First 8 hex of the sha1 of a PROGRESS `restated` value (`""` for an empty one): its notice-key fingerprint. */
export const restatedHash = (restated: string): string =>
	restated === "" ? "" : createHash("sha1").update(restated).digest("hex").slice(0, 8);

export function checkResume(progress: HostResult<ParsedProgress>, lag: HostResult<ProgressLag>): ResumeCheck {
	const findings: string[] = [];
	const notes: string[] = [];
	if (lag.ok && lag.value.progressCommit !== "" && lag.value.codeCommitsSince >= 1) {
		findings.push(
			`PROGRESS.md 마지막 커밋(${lag.value.progressCommit}) 뒤 코드 커밋 ${lag.value.codeCommitsSince}개가 PROGRESS에 반영되지 않음`,
		);
	}
	if (progress.ok) {
		const { next, current, steps } = progress.value;
		if (next === "") findings.push("next 비어 있음");
		if (!steps.some((step) => step.id === current)) findings.push(`current=${current}이 단계 목록에 없음`);
		const bare = steps.filter((step) => step.done && step.evidence === "").map((step) => step.id);
		if (bare.length > 0) {
			const rest = bare.length - BARE_STEPS_SHOWN;
			findings.push(
				`증거 없는 완료 단계: ${bare.slice(0, BARE_STEPS_SHOWN).join(", ")}${rest > 0 ? ` 외 ${rest}개` : ""}`,
			);
		}
	}
	if (lag.ok && lag.value.progressDirty) notes.push("PROGRESS.md 미커밋 수정 있음(작업 사본 기준으로 읽음)");
	if (lag.ok && lag.value.otherDirty >= 1) notes.push(`미커밋 변경 ${lag.value.otherDirty}개(중간 단계에서 멈춘 상태)`);
	const errors = [progress, lag].flatMap((read) => (read.ok ? [] : [read.error]));
	if (errors.length > 0) notes.push(`점검 읽기 실패: ${errors.join("; ")}`);
	return { findings, notes };
}
