import { parseCommand, promptTextOf } from "../core/types";

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

/** `!reopen` alone or followed by an instruction: the only owner message that reopens a closed lane. */
export function isReopenCommand(text: string): boolean {
	return /^!reopen(?:\s|$)/.test(text.trim());
}

/**
 * What an owner message does in a closed lane's thread: `!reopen` reopens it; a chat command without work in it
 * (`!model`, `!new`, `!queue`, `!thinking`…) keeps its meaning; anything that would reach omp as a prompt — plain
 * text or a `!followup <message>` payload — is a question the lane answers while it stays closed.
 */
export function classifyClosedLaneMessage(text: string): "reopen" | "control" | "question" {
	if (isReopenCommand(text)) return "reopen";
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

/** First line is the ulw keyword line (Dori rule 17), then the task and the lane rules. */
export function buildLanePrompt(input: {
	name: string;
	title: string;
	cwd: string;
	brief?: string | undefined;
}): string {
	const brief = input.brief?.trim();
	return [
		"ulw explore ulw debugging set goal and work",
		"",
		`작업: ${input.title}`,
		`프로젝트 디렉터리: ${input.cwd}`,
		...(brief ? ["", brief] : []),
		"",
		`당신은 ompbot 작업 레인 \`${input.name}\`입니다. 규칙:`,
		"- 중요한 단계(마일스톤)를 끝낼 때마다 host tool `ompbot_lane_progress`({text})로 한 줄 보고하세요.",
		"- 작업을 마치면 변경을 모두 커밋한 뒤 host tool `ompbot_claim_done`({repo, commit, summary})을 호출하세요. repo는 프로젝트의 절대경로, commit은 커밋 sha입니다.",
		"- 완료는 이 도구로만 주장합니다. 코어가 `git status --porcelain`이 비어 있는지와 그 커밋이 존재하는지를 직접 확인하며, 커밋하지 않은 변경이 있으면 not-done입니다.",
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
