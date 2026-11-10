import { docsDirOf } from "./docs";

export interface TaskPromptInput {
	mode: "new" | "resume";
	taskId: string;
	worktree: string;
	branch: string;
	/** The session's `task` text: the instruction itself (new) or an optional addition (resume). */
	instruction?: string;
	/** Resume only: `checkResume` findings (fix PROGRESS.md first) and notes (read with), each in its own line. */
	resumeFindings?: readonly string[];
	resumeNotes?: readonly string[];
}

/** The pre-resume check as prompt and result lines: findings with the instruction to fix first, notes without one. */
export function resumeCheckLines(findings: readonly string[] = [], notes: readonly string[] = []): string[] {
	return [
		...(findings.length === 0
			? []
			: [`재개 전 점검: ${findings.join("; ")}. 저장소 상태를 믿고 PROGRESS.md를 먼저 고친 뒤 잇는다.`]),
		...(notes.length === 0 ? [] : [`참고: ${notes.join("; ")}.`]),
	];
}

/** The prompt a task agent starts or resumes with: ompbot's rules header, then the session's instruction. */
export function buildTaskPrompt(input: TaskPromptInput): string {
	const docs = `docs/tasks/${input.taskId}/`;
	const header = [
		`너는 ${input.taskId} 담당이다. 작업 디렉터리는 ${input.worktree} (branch ${input.branch}), 기준 문서는 ${docs} (${docsDirOf(input.worktree, input.taskId)})다.`,
		...(input.mode === "new"
			? ["시작: spec.md를 읽고 PROGRESS.md의 단계 목록부터 채운다. 단계마다 확인할 수 있는 완료 조건을 붙인다."]
			: [
					"재개: PROGRESS.md만 읽고 `current`부터 잇는다. 재개하면 다른 일보다 먼저 PROGRESS.md `restated`에 `과제 / 첫 next / 완료 조건`을 한 줄로 쓰고 `updated`를 고친다. 못 쓰면 `status: blocked`로 바꾸고 `blocked_reason`에 PROGRESS.md에서 빠진 것을 적는다.",
					...resumeCheckLines(input.resumeFindings, input.resumeNotes),
				]),
		"규칙:",
		"1. 단계 전환·커밋·막힘 때마다 PROGRESS.md의 `updated`(ISO8601, +09:00)·`current`·`next`를 고친다. `updated`에는 그때 `date -Iseconds`로 얻은 실제 시각을 그대로 쓴다(어림하거나 앞당겨 쓰지 않는다). 한 단계가 30분을 넘으면 30분마다 중간 갱신한다. `status`는 working이나 blocked만 쓴다.",
		`2. 단계를 마치면 \`[x]\`로 체크하고 \`증거:\`에 \`commit <hash>\` 또는 \`test <명령> → <결과 줄>\`을 붙인다. 단계 커밋에는 ${docs} 갱신을 함께 넣는다(문서를 미커밋으로 남기지 않는다).`,
		"3. 수락기준을 채우면 outcome.md에 AC별 절(`## AC-1`)을 만들어 `- commit: <hash> <커밋 제목>`, `- test: <명령> → <결과 줄>`, `- file: <산출물 경로>`로 증거를 적고, spec.md의 그 AC를 `[x]`로 체크한다. 수락기준 문구는 고치지 않는다. outcome.md 맨 위 `## 요약`에는 오너가 읽을 한국어 2~3줄(① 무엇이 바뀌었나를 사용자 관점에서 ② 검증 결과 숫자 ③ 스펙 밖 예외·남은 위험, 없으면 생략)을 쓴다. Outcome 카드에는 이 요약만 나가므로 코드 식별자 나열·AC 번호 나열은 하지 않는다.",
		"4. 오너 결정이 꼭 필요할 때만 멈추고, 결정 없이 할 수 있는 일은 그 전에 모두 끝낸다. 멈출 때는 PROGRESS.md에 `status: blocked`, `blocked_reason`(한 줄 사유), `question`(오너에게 물을 것 한 문장), `recommend`(추천과 이유 한 줄), `impact`(영향·되돌리는 법 한 줄)를 적고 멈춘다. ompbot이 이 값을 그대로 오너 결정 요청으로 보낸다. 재개되면 `status: working`으로 돌리고 이 네 칸을 비운다.",
		"5. 완료 선언·merge·push·배포를 하지 않는다. Outcome 판정은 ompbot이 한다.",
		"6. `[check: …]`가 붙은 수락기준은 ompbot이 직접 다시 실행한다. 커밋한 뒤 같은 명령으로 직접 확인하라.",
		"7. 컨텍스트 예산: 단일 세션 컨텍스트가 200k 토큰을 넘기 전에 단계를 3~5개 안쪽으로 마무리한다(300k 초과 금지). 작업이 커지면 남은 단계를 후속 작업으로 분할할 수 있게 정리한다.",
	].join("\n");
	const instruction = input.instruction?.trim();
	return instruction === undefined || instruction === "" ? header : `${header}\n\n---\n${instruction}`;
}
