import { parseCommand, promptTextOf } from "../core/types";
import type { TodoPhase } from "../omp/driver";
import type { AcceptanceItem } from "../tasks/docs";
import { withoutCheckTail } from "../tasks/signals";
import type { LaneLandState } from "./status";

export interface LaneTrigger {
	title: string;
	cwd: string;
	/** Everything after the path (may be empty). */
	brief: string;
}

/** `작업: <제목> @<절대경로>` optionally followed by the task description on the same or the following lines. */
const TRIGGER = /^작업:[ \t]*(.+?)[ \t]+@(\/\S*)(?:[ \t]+|\n|$)([\s\S]*)$/;

export function parseLaneTrigger(text: string): LaneTrigger | undefined {
	const match = TRIGGER.exec(text.trim());
	const title = match?.[1]?.trim();
	const cwd = match?.[2];
	if (title === undefined || title === "" || cwd === undefined) return undefined;
	return { title, cwd, brief: (match?.[3] ?? "").trim() };
}

/** Why a Discord DM opens no lane: a lane lives in a server-channel thread, and the DM has none to name. */
export const DISCORD_LANE_CHANNEL_MISSING =
	"Discord DM에서 레인을 열려면 config `channels.discord.laneChannelId`(레인을 열 서버 텍스트 채널 id)가 필요합니다. 서버 채널·스레드에서 요청하면 그 채널에 열립니다.";

/** `!reopen` alone or followed by an instruction: the only owner message that reopens a closed lane. */
export function isReopenCommand(text: string): boolean {
	return /^!reopen(?:\s|$)/.test(text.trim());
}

/** What an owner message does in a closed lane's thread (`classifyClosedLaneMessage`). */
export type ClosedLaneMessage = "reopen" | "control" | "question" | "land" | "discard";

/**
 * What an owner message does in a closed lane's thread: `!reopen` reopens it; a chat command without work in it
 * (`!model`, `!new`, `!queue`, `!thinking`…) keeps its meaning; `머지해` / `폐기해` as the whole message land or
 * discard the lane — only while its landing is `pending` or `blocked` (`landState`), and never as part of a longer
 * sentence (the code decides, not a model: `머지해 줘`, `머지해야 하나?` are questions); anything else that would
 * reach omp as a prompt — plain text or a `!followup <message>` payload — is a question the lane answers while it
 * stays closed.
 */
export function classifyClosedLaneMessage(text: string, landState?: LaneLandState): ClosedLaneMessage {
	if (isReopenCommand(text)) return "reopen";
	if (landState === "pending" || landState === "blocked") {
		const whole = text.trim();
		if (whole === "머지해") return "land";
		if (whole === "폐기해") return "discard";
	}
	const command = parseCommand(text);
	return command === undefined || (command.kind === "followup" && command.arg !== "") ? "question" : "control";
}

/**
 * The recorded text of a closed-lane question: the answer-only notice goes in front of what omp will receive. A
 * `!followup` keeps its queueing meaning, so the notice wraps its payload (the mailbox prompts the argument).
 */
export function buildClosedLaneQuestion(text: string): string {
	const question = [
		"[ompbot] 이 레인은 closed(완료)입니다. 아래 오너 메시지에 답만 하고 파일 수정·커밋·`ompbot_claim_done`·`ompbot_lane_progress`는 하지 마세요. 수정이 필요하면 오너에게 이 스레드에 `!reopen <지시>`를 쓰라고 안내하세요.",
		"",
		promptTextOf(text),
	].join("\n");
	return parseCommand(text)?.kind === "followup" ? `!followup ${question}` : question;
}

/**
 * First line is the ulw keyword line (Dori rule 17), then the task, the lane's own worktree and branch, the
 * acceptance criteria and the lane rules.
 */
export function buildLanePrompt(input: {
	name: string;
	title: string;
	/** The lane's working directory inside its own worktree. */
	cwd: string;
	brief?: string | undefined;
	branch: string;
	baseBranch: string;
	acceptance: readonly AcceptanceItem[];
}): string {
	const brief = input.brief?.trim();
	const acceptance =
		input.acceptance.length === 0
			? []
			: [
					"",
					"수락기준:",
					...input.acceptance.map((item) => `- ${item.id}: ${item.text}`),
					"- `[check: …]`가 붙은 수락기준은 코어가 이 worktree에서 직접 다시 실행합니다. 하나라도 실패하면 not-done입니다.",
				];
	return [
		"ulw explore ulw debugging set goal and work",
		"",
		`작업: ${input.title}`,
		`프로젝트 디렉터리: ${input.cwd} (이 레인 전용 git worktree)`,
		`브랜치: ${input.branch} (기준 브랜치 ${input.baseBranch}에서 시작)`,
		...(brief ? ["", brief] : []),
		...acceptance,
		"",
		`당신은 ompbot 작업 레인 \`${input.name}\`입니다. 규칙:`,
		"- 이 worktree 안에서만 고치고 커밋하세요. 원래 저장소 체크아웃은 건드리지 마세요.",
		`- 머지·push·브랜치 전환은 하지 마세요. ${input.branch}를 ${input.baseBranch}에 합치는 일은 코어와 오너가 합니다.`,
		"- 중요한 단계(마일스톤)를 끝낼 때마다 host tool `ompbot_lane_progress`({text})로 한 줄 보고하세요.",
		"- 오너 결정이 필요하면 `ompbot_lane_progress`를 `needsOwner: true`와 함께 부르고 질문을 적은 뒤 턴을 끝내세요. 완료 주장 없이 끝난 턴에는 코어가 자동 재촉을 보내지만, 이 경우에는 보내지 않습니다.",
		"- 작업을 마치면 변경을 모두 커밋한 뒤 host tool `ompbot_claim_done`({repo, commit, summary})을 호출하세요. repo는 위 프로젝트 디렉터리의 절대경로, commit은 커밋 sha(worktree HEAD)입니다.",
		"- 완료는 이 도구로만 주장합니다. 코어가 `git status --porcelain`이 비어 있는지, 그 커밋이 존재하고 HEAD인지를 직접 확인하며, 커밋하지 않은 변경이 있으면 not-done입니다.",
		"- 증거 없이 '완료'라고 말하지 마세요. not-done 사유가 오면 고친 뒤 다시 주장하세요.",
	].join("\n");
}

export function buildNotDonePrompt(reasons: readonly string[]): string {
	return [
		"[ompbot] 완료 주장이 검증을 통과하지 못했습니다 (not-done). 사유:",
		...reasons.map((reason) => `- ${reason}`),
		"변경을 커밋하고 문제를 해결한 뒤 `ompbot_claim_done`을 다시 호출하세요.",
	].join("\n");
}

/** Steered into a lane whose landing was refused because the base branch moved ahead: the lane is working again. */
export function buildRebasePrompt(input: { branch: string; baseBranch: string }): string {
	return [
		`[ompbot] 머지하지 못했습니다: 그 사이 기준 브랜치 \`${input.baseBranch}\`가 앞서 나가 fast-forward가 안 됩니다. 레인을 다시 working으로 돌렸습니다.`,
		`- 이 worktree에서 \`git rebase ${input.baseBranch}\`로 \`${input.branch}\`를 \`${input.baseBranch}\` 위로 rebase하고, 충돌이 나면 풀어 다시 커밋하세요.`,
		"- 머지·push는 하지 마세요. 끝나면 `ompbot_claim_done`을 다시 호출하세요. 코어가 검사를 다시 돌린 뒤 머지합니다.",
	].join("\n");
}

/**
 * The task list a new lane session starts with (omp `set_todos`): one task per acceptance criterion (its `[check: …]`
 * tail left out), then the wrap-up. Without criteria only the wrap-up phase. Every task starts `pending`.
 */
export function buildLaneTodos(acceptance: readonly AcceptanceItem[]): TodoPhase[] {
	const wrapUp: TodoPhase = {
		name: "마무리",
		tasks: [
			{ content: "변경 모두 커밋", status: "pending" },
			{ content: "ompbot_claim_done 호출", status: "pending" },
		],
	};
	if (acceptance.length === 0) return [wrapUp];
	const criteria: TodoPhase = {
		name: "수락기준",
		tasks: acceptance.map((item) => ({ content: `${item.id}: ${withoutCheckTail(item.text)}`, status: "pending" })),
	};
	return [criteria, wrapUp];
}

/** What a nudge says about the lane's worktree: counts read with git, or why they could not be read. */
export type LaneWorktreeState = { uncommitted: number; commits: number } | { error: string };

/** The core's nudge into a lane whose turn ended with no done claim (`n` of `max` since the owner last wrote). */
export function buildNudgePrompt(input: {
	n: number;
	max: number;
	worktree: LaneWorktreeState;
	/** The last not-done reasons, when the lane is `not-done`. */
	notDone?: string | undefined;
}): string {
	const state =
		"error" in input.worktree
			? `worktree 상태 확인 실패: ${input.worktree.error}`
			: `worktree 상태: 미커밋 경로 ${input.worktree.uncommitted}개, 레인 시작 이후 커밋 ${input.worktree.commits}개`;
	return [
		`[자동 재촉 ${input.n}/${input.max}] 턴이 완료 주장 없이 끝났습니다.`,
		state,
		...(input.notDone === undefined ? [] : [`마지막 거절 사유(not-done): ${input.notDone}`]),
		"- 할 일 목록과 앞선 도구 호출을 보고 멈춘 곳부터 이어 가세요.",
		"- 끝났으면 변경을 모두 커밋하고 `ompbot_claim_done`을 호출하세요.",
		"- 오너 결정이 필요하면 `ompbot_lane_progress`를 `needsOwner: true`와 함께 불러 무엇이 필요한지 적고 턴을 끝내세요(이 경우 다음 턴 끝에서는 재촉하지 않습니다).",
	].join("\n");
}
