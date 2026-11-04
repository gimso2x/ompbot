import { type ChannelPort, mentionToken, renderMentions } from "../channel/port";
import { parseThreadRef } from "../core/normalize";
import type { TaskJudgement } from "./checker";
import { TASK_STATUSES, type TaskRow, type TaskStatus } from "./ledger";

/** One status reaction lives on the task root: ⏳ working, 🔍 review, 🚧 blocked, ✅ done, ❌ cancelled. */
export const STATUS_REACTIONS: Record<TaskStatus, string> = {
	working: "hourglass_flowing_sand",
	review: "mag",
	blocked: "construction",
	done: "white_check_mark",
	cancelled: "x",
};

/** Every status emoji except `keep`'s: the set a status swap clears so exactly one remains. */
export const otherStatuses = (keep: TaskStatus): TaskStatus[] => TASK_STATUSES.filter((status) => status !== keep);

export interface TaskSlackLog {
	warn(event: string, fields?: Record<string, unknown>): void;
}

/**
 * Makes `to` the single status reaction on the root of `threadRef`: removes the listed other statuses (a missing
 * reaction is not an error), then adds `to`. Slack failures are logged — a reaction never fails a task.
 */
export async function setStatusReaction(
	port: ChannelPort,
	log: TaskSlackLog,
	threadRef: string,
	to: TaskStatus,
	remove: readonly TaskStatus[] = otherStatuses(to),
): Promise<void> {
	const target = parseThreadRef(threadRef);
	if (target === undefined) return;
	const root = { platform: port.platform, conversationId: target.channel, messageId: target.threadTs };
	for (const status of remove) {
		await port.react(root, STATUS_REACTIONS[status], false).catch(() => undefined);
	}
	await port.react(root, STATUS_REACTIONS[to], true).catch((error: unknown) => {
		// `already_reacted` is the expected repeat; anything else is worth a line.
		if (!String(error).includes("already_reacted"))
			log.warn("task_reaction_failed", { thread: threadRef, error: String(error) });
	});
}

/** Posts into the task thread (owner mentions rendered for the port); failures are logged and reported as `false`. */
export async function postToThread(
	port: ChannelPort,
	log: TaskSlackLog,
	threadRef: string,
	text: string,
): Promise<boolean> {
	const target = parseThreadRef(threadRef);
	if (target === undefined) return false;
	try {
		await port.post(
			{ conversationId: target.channel, threadId: target.threadTs },
			{ text: renderMentions(text, port) },
		);
		return true;
	} catch (error) {
		log.warn("task_post_failed", { thread: threadRef, error: String(error) });
		return false;
	}
}

export const hostLabelOf = (row: Pick<TaskRow, "host">): string => row.host ?? "local";

/** `local/t-20261030-01 · T-20261030-01`: where the agent runs and which task it carries. */
const ownerTag = (row: TaskRow): string => `${hostLabelOf(row)}/${row.agent} · ${row.taskId}`;

/** The board link closes a notice on its own lines (gajae-way hub report rule); no link, no footer. */
const boardFooter = (link: string | undefined): string[] => (link === undefined ? [] : ["", "작업 보드", link]);

/**
 * The accepted card posted to the task thread when the agent has started (gajae-way hub "맡았습니다" report): who
 * took it, the board card, then the goal and the session's assumptions so the owner can correct a misreading early.
 */
export function formatAcceptedCard(
	row: TaskRow,
	spec: { goal: string; assumptions?: string | undefined },
	link: string | undefined,
): string {
	return [
		`\`${hostLabelOf(row)}\`에서 \`${row.agent}\`(${row.title})가 맡았습니다. 결정이 필요하거나 끝나면 이 스레드로 알려 드립니다.`,
		...(link === undefined ? [] : [`진행 보기: ${link}`]),
		"",
		`[목표] ${spec.goal}`,
		`[가정] ${spec.assumptions ?? "없음"}`,
		`[작업] ${row.taskId} · ${row.risk} · 브랜치 \`${row.branch}\` · 수락기준 ${row.acceptance.length}개 · 워크트리 \`${hostLabelOf(row)}:${row.worktree}\``,
	].join("\n");
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const MAX_SUMMARY_LINES = 3;

/**
 * Criteria that cite the very same commit-only evidence are flagged: the bot checks that the commit exists, not that
 * it meets them.
 */
function sharedCommitWarnings(row: TaskRow, judgement: TaskJudgement): string[] {
	const shared = new Map<string, string[]>();
	for (const item of row.acceptance) {
		const lines = judgement.evidence[item.id] ?? [];
		if (lines.length > 0 && lines.every((line) => line.startsWith("commit "))) {
			const key = lines.join("\n");
			shared.set(key, [...(shared.get(key) ?? []), item.id]);
		}
	}
	return [...shared.values()]
		.filter((ids) => ids.length >= 2)
		.map(
			(ids) =>
				`⚠️ 증거 약함: ${ids.join("·")}가 같은 커밋 증거만 댔습니다. 커밋이 각 기준을 채우는지는 봇이 판정하지 않습니다.`,
		);
}

/**
 * The owner reads the agent's outcome.md `## 요약` (at most three lines), not the criteria and evidence: those stay in
 * outcome.md, which the `*근거*` line points to.
 */
export function formatReachedNotice(
	row: TaskRow,
	judgement: TaskJudgement,
	ownerUserId: string,
	link?: string,
): string {
	const outcomePath = `docs/tasks/${row.taskId}/outcome.md`;
	const summary =
		judgement.summary.length === 0
			? [`⚠️ 요약 없음 — ${outcomePath}를 직접 봐 주세요.`]
			: judgement.summary.slice(0, MAX_SUMMARY_LINES).map((line) => `• ${clip(line, 200)}`);
	const warnings = sharedCommitWarnings(row, judgement);
	return [
		`🔍 Outcome 도달 · ${row.title} — 수락기준 ${judgement.acChecked}/${row.acceptance.length}에 체크와 증거가 있습니다. 머지할지 정해 주세요. (${ownerTag(row)}) ${mentionToken(ownerUserId)}`,
		"",
		...summary,
		...(warnings.length === 0 ? [] : ["", ...warnings]),
		"",
		`*질문*: 브랜치 \`${row.branch}\`를 main에 머지할까요?`,
		'*답하는 법*: 이 스레드에 "머지해"라고 답하면 봇이 close→merge→push·워크트리 정리까지 하고, 서비스 반영(재시작)이 필요하면 그때 승인을 따로 요청합니다. 고칠 점이 있으면 그 내용을 적어 주세요.',
		`*근거*: \`${outcomePath}\` · \`git -C ${row.worktree} log --oneline main..${row.branch}\` (${hostLabelOf(row)})`,
		...boardFooter(link),
	].join("\n");
}

/** A blocked task is a decision request (hub `[DECISION]`): reason, then the question/recommendation/impact the agent wrote. */
export function formatBlockedNotice(
	row: TaskRow,
	judgement: TaskJudgement,
	ownerUserId: string,
	link?: string,
): string {
	const { question, recommend, impact } = judgement.decision;
	return [
		`🚧 멈춤 · ${row.title} — 결정이 필요합니다. (${ownerTag(row)}) ${mentionToken(ownerUserId)}`,
		"",
		`*사유*: ${judgement.blockedReason === "" ? "(적지 않음)" : judgement.blockedReason}`,
		...(question === "" ? [] : [`*질문*: ${question}`]),
		...(recommend === "" ? [] : [`*추천*: ${recommend}`]),
		...(impact === "" ? [] : [`*영향*: ${impact}`]),
		`*지금 단계*: ${judgement.current === "" ? "-" : judgement.current}`,
		"*답하는 법*: 이 스레드에 결정을 적어 주시면 그 답을 담당 에이전트에 넘겨 재개합니다.",
		...boardFooter(link),
	].join("\n");
}

export const formatSpecChangedNotice = (row: TaskRow): string =>
	`⚠️ ${row.taskId} spec.md 수락기준이 등록 스냅샷과 다릅니다(개수·ID·문구). 고쳐질 때까지 Outcome에 도달하지 않습니다.`;

export const formatStaleNotice = (row: TaskRow, minutes: number, link?: string): string =>
	[
		`⏰ ${row.title}: PROGRESS.md가 ${minutes}분 넘게 갱신되지 않았습니다. (${ownerTag(row)})`,
		...boardFooter(link),
	].join("\n");

/** The task's herdr agent vanished (dori `[LOST]`): the owner hears it once per progress base, with the resume call. */
export function formatLostNotice(row: TaskRow, ownerUserId: string, link?: string): string {
	return [
		`👻 에이전트 없음 · ${row.title} — herdr에 \`${row.agent}\` 에이전트가 없습니다. (${ownerTag(row)}) ${mentionToken(ownerUserId)}`,
		`*재개*: \`ompbot_dispatch {mode:"herdr", taskSpec:{id:"${row.taskId}"}}\` — 같은 워크트리에서 에이전트를 다시 띄웁니다.`,
		...boardFooter(link),
	].join("\n");
}

export const formatReadFailureNotice = (row: TaskRow, failures: number, error: string): string =>
	`⚠️ ${row.taskId} 상태 문서를 ${failures}회 연속 읽지 못했습니다 (${hostLabelOf(row)}): ${error.slice(0, 160)}`;
