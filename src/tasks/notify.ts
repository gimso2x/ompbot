import {
	type ActionButton,
	type ChannelPort,
	mentionToken,
	type OutboundMessage,
	renderMentions,
} from "../channel/port";
import type { ChannelRegistry } from "../channel/registry";
import { parseThreadRef } from "../core/normalize";
import { redact } from "../redact";
import type { TaskCheck, TaskJudgement } from "./checker";
import { TASK_RISKS, type TaskRisk } from "./docs";
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
	channels: ChannelRegistry,
	log: TaskSlackLog,
	threadRef: string,
	to: TaskStatus,
	remove: readonly TaskStatus[] = otherStatuses(to),
): Promise<void> {
	const target = parseThreadRef(threadRef);
	if (target === undefined) return;
	const port = channels.forConversation(target.channel)?.port;
	if (port === undefined) {
		log.warn("task_reaction_failed", { thread: threadRef, error: "no channel for this conversation" });
		return;
	}
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

/**
 * A task notice as a card: `text` is the whole notice as one string (notifications, block-less clients, the dashboard
 * and logs), `title`/`body`/`fields`/`buttons`/`note` what the card shows.
 */
export interface TaskCard {
	text: string;
	title: string;
	body: string;
	fields?: ReadonlyArray<{ label: string; value: string }>;
	buttons?: readonly ActionButton[];
	/** The small grey line under the card. */
	note?: string;
}

/** A Slack section's text holds 3,000 characters: a longer card body is cut there. */
const CARD_BODY_MAX = 3_000;

/** The port message for a card (or a one-string notice), owner mentions rendered for the port. */
export function cardMessage(card: TaskCard | string, port: Pick<ChannelPort, "mentionUser">): OutboundMessage {
	if (typeof card === "string") return { text: renderMentions(card, port) };
	const body = renderMentions(card.body, port);
	return {
		text: renderMentions(card.text, port),
		title: card.title,
		body: body.length > CARD_BODY_MAX ? `${body.slice(0, CARD_BODY_MAX - 1)}…` : body,
		...(card.fields === undefined ? {} : { fields: card.fields }),
		...(card.buttons === undefined ? {} : { buttons: card.buttons }),
		...(card.note === undefined ? {} : { buttonsNote: card.note }),
	};
}

/** Posts into the task thread (owner mentions rendered for the port); failures are logged and reported as `false`. */
export async function postToThread(
	channels: ChannelRegistry,
	log: TaskSlackLog,
	threadRef: string,
	card: TaskCard | string,
): Promise<boolean> {
	const target = parseThreadRef(threadRef);
	if (target === undefined) return false;
	try {
		const port = channels.portFor(target.channel);
		await port.post({ conversationId: target.channel, threadId: target.threadTs }, cardMessage(card, port));
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

/** Button ids of a card's `머지` and `추천대로` buttons; the task id carries no colon. */
const TASK_MERGE_ACTION_PREFIX = "ompbot:task:merge:";
const TASK_RECOMMEND_ACTION_PREFIX = "ompbot:task:recommend:";
const TASK_ID = /^T-\d{8}-\d{2,}$/;

export const taskMergeActionId = (taskId: string): string => `${TASK_MERGE_ACTION_PREFIX}${taskId}`;
export const taskRecommendActionId = (taskId: string): string => `${TASK_RECOMMEND_ACTION_PREFIX}${taskId}`;

/** The task id behind `prefix` in a button click; `undefined` for any other action id. */
function taskIdOf(actionId: string, prefix: string): string | undefined {
	if (!actionId.startsWith(prefix)) return undefined;
	const taskId = actionId.slice(prefix.length);
	return TASK_ID.test(taskId) ? taskId : undefined;
}

/** The task id of a `머지` button click; `undefined` for any other action id. */
export const parseTaskMergeActionId = (actionId: string): string | undefined =>
	taskIdOf(actionId, TASK_MERGE_ACTION_PREFIX);

/** The task id of a `추천대로` button click; `undefined` for any other action id. */
export const parseTaskRecommendActionId = (actionId: string): string | undefined =>
	taskIdOf(actionId, TASK_RECOMMEND_ACTION_PREFIX);

/** What one click on `머지` does: the same as answering "머지해" in the thread. */
export const MERGE_NOTE = "머지 = close → ff merge → push → 정리 · 재시작은 따로 승인";
/** What one click on `추천대로` does: the same as answering "추천대로" in the thread. */
export const RECOMMEND_NOTE = "추천대로 = 위 추천 그대로 진행 · 다른 결정은 이 스레드에 답장";
/** The recommendation a `추천대로` button carries in its `value` (redacted), so the click can say what it approved. */
export const RECOMMEND_VALUE_MAX = 300;

const mergeButton = (row: TaskRow): ActionButton => ({
	actionId: taskMergeActionId(row.taskId),
	label: "머지",
	value: row.taskId,
	style: "primary",
});

const recommendButton = (row: TaskRow, recommend: string): ActionButton => ({
	actionId: taskRecommendActionId(row.taskId),
	label: "추천대로",
	value: redact(recommend).slice(0, RECOMMEND_VALUE_MAX),
	style: "primary",
});

/** The grey line: the button's note on a card with a button, then the board link; nothing when neither applies. */
function cardNote(link: string | undefined, buttonNote?: string): string | undefined {
	const parts = [
		...(buttonNote === undefined ? [] : [buttonNote]),
		...(link === undefined ? [] : [`작업 보드: ${link}`]),
	];
	return parts.length === 0 ? undefined : parts.join(" · ");
}

const branchField = (row: TaskRow) => ({ label: "브랜치", value: `\`${row.branch}\`` });
const workerField = (row: TaskRow) => ({ label: "워커", value: ownerTag(row) });

/**
 * The accepted card posted to the task thread when the agent has started (gajae-way hub "맡았습니다" report): who
 * took it, the board card, then the goal and the session's assumptions so the owner can correct a misreading early.
 */
export function buildAcceptedCard(
	row: TaskRow,
	spec: { goal: string; assumptions?: string | undefined },
	link: string | undefined,
): TaskCard {
	const goal = `[목표] ${spec.goal}`;
	const assumptions = `[가정] ${spec.assumptions ?? "없음"}`;
	const text = [
		`\`${hostLabelOf(row)}\`에서 \`${row.agent}\`(${row.title})가 맡았습니다. 결정이 필요하거나 끝나면 이 스레드로 알려 드립니다.`,
		...(link === undefined ? [] : [`진행 보기: ${link}`]),
		"",
		goal,
		assumptions,
		`[작업] ${row.taskId} · ${row.risk} · 브랜치 \`${row.branch}\` · 수락기준 ${row.acceptance.length}개 · 워크트리 \`${hostLabelOf(row)}:${row.worktree}\``,
	].join("\n");
	const note = link === undefined ? undefined : `진행 보기: ${link}`;
	return {
		text,
		title: `🚀 접수 · ${row.title}`,
		body: [goal, assumptions].join("\n"),
		fields: [
			{ label: "호스트·에이전트", value: `\`${hostLabelOf(row)}\` · \`${row.agent}\`` },
			{ label: "위험", value: row.risk },
			branchField(row),
			{ label: "수락기준", value: `${row.acceptance.length}개` },
		],
		...(note === undefined ? {} : { note }),
	};
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

/** The agent's outcome.md `## 요약` as card bullets (at most three, each clipped), or one warning line in their place. */
function summaryLines(row: TaskRow, judgement: TaskJudgement): string[] {
	return judgement.summary.length === 0
		? [`⚠️ 요약 없음 — docs/tasks/${row.taskId}/outcome.md를 직접 봐 주세요.`]
		: judgement.summary.slice(0, MAX_SUMMARY_LINES).map((line) => `• ${clip(line, 200)}`);
}

const evidenceLine = (row: TaskRow): string =>
	`*근거*: \`docs/tasks/${row.taskId}/outcome.md\` · \`git -C ${row.worktree} log --oneline main..${row.branch}\` (${hostLabelOf(row)})`;

/** `taskAutoLand` as the sweep applies it: the repositories it covers and the highest risk it merges unasked. */
export interface AutoLandPolicy {
	repos: string[];
	maxRisk: TaskRisk;
	/** Lanes only: the independent review a lane's claim commit needs a `CLEAR` receipt from before it merges unasked. */
	review?: { model: string; timeoutMs: number };
}

/** The auto-merge blockers of re-run checks: failed (a violation) and inconclusive (timed out) counted apart. */
export function checkBlockers(checks: readonly TaskCheck[]): string[] {
	const failed = checks.filter((check) => !check.ok && !check.inconclusive).length;
	const inconclusive = checks.filter((check) => check.inconclusive === true).length;
	return [
		...(failed > 0 ? [`재실행 검사 실패 ${failed}/${checks.length}`] : []),
		...(inconclusive > 0 ? [`재실행 검사 확인 불가 ${inconclusive}/${checks.length}`] : []),
	];
}

/**
 * Why a reached task is not merged without asking; `[]` = merge it. `repoMatched` is the sweep's git common-directory
 * comparison (always false for a remote task, which is refused for being remote in the first place).
 */
export function autoLandBlockers(
	row: TaskRow,
	judgement: TaskJudgement,
	policy: AutoLandPolicy,
	repoMatched: boolean,
): string[] {
	const blockers: string[] = [];
	if (row.host !== null) blockers.push(`원격 호스트(${row.host}) TASK`);
	else if (!repoMatched) blockers.push("저장소가 taskAutoLand.repos 밖");
	if (TASK_RISKS.indexOf(row.risk) > TASK_RISKS.indexOf(policy.maxRisk)) {
		blockers.push(`위험 ${row.risk} > ${policy.maxRisk}`);
	}
	if (judgement.checks.length === 0) blockers.push("재실행 검사 없음");
	else blockers.push(...checkBlockers(judgement.checks));
	if (judgement.integrityWarnings.length > 0) blockers.push(`무결성 경고 ${judgement.integrityWarnings.length}건`);
	if (sharedCommitWarnings(row, judgement).length > 0) blockers.push("공유 커밋 증거 경고");
	const unfinished = (judgement.steps ?? []).filter((step) => !step.done);
	if (unfinished.length > 0) {
		const names = unfinished.map((s) => s.id).join(", ");
		blockers.push(`PROGRESS 미완료 단계 ${unfinished.length}개(${names})`);
	}
	return blockers;
}

/** The line a reached card leads with when the bot tried to merge on its own and could not start. */
export const AUTO_LAND_FAILED_LINE = "⚠️ 자동 머지를 시작하지 못해 직접 정해 주세요.";

/** What auto-merge did not do, as one extra line on the reached card: it failed to start, or why it was skipped. */
export type ReachedAutoLandNote = { kind: "failed" } | { kind: "skipped"; reasons: readonly string[] };

/**
 * The owner reads the agent's outcome.md `## 요약` (at most three lines), not the criteria and evidence: those stay in
 * outcome.md, which the `*근거*` line points to. `autoLand` adds one line when `taskAutoLand` is on.
 */
export function buildReachedCard(
	row: TaskRow,
	judgement: TaskJudgement,
	ownerUserId: string,
	link?: string,
	autoLand?: ReachedAutoLandNote,
): TaskCard {
	const summary = summaryLines(row, judgement);
	const lead = autoLand?.kind === "failed" ? [AUTO_LAND_FAILED_LINE] : [];
	const skipped = autoLand?.kind === "skipped" ? [`자동 머지 안 함: ${autoLand.reasons.join(" · ")}`] : [];
	const warnings = sharedCommitWarnings(row, judgement);
	// Judgement calls of the integrity classifier (guard deletion, unproven claim): the owner sees them, nothing is held.
	const integrity =
		judgement.integrityWarnings.length === 0
			? []
			: ["*⚠️ 무결성 경고*", ...judgement.integrityWarnings.map((line) => `• ${clip(line, 200)}`)];
	// The count only: what the commands printed stays out of the card.
	const passed = judgement.checks.filter((check) => check.ok).length;
	const checks =
		judgement.checks.length === 0
			? []
			: [`✅ check ${passed}/${judgement.checks.length} 통과 — 봇이 워크트리에서 직접 다시 실행했습니다.`];
	const text = [
		...lead,
		`🔍 Outcome 도달 · ${row.title} — 수락기준 ${judgement.acChecked}/${row.acceptance.length}에 체크와 증거가 있습니다. 머지할지 정해 주세요. (${ownerTag(row)}) ${mentionToken(ownerUserId)}`,
		"",
		...summary,
		...skipped,
		...integrity,
		...checks,
		...(warnings.length === 0 ? [] : ["", ...warnings]),
		"",
		`*질문*: 브랜치 \`${row.branch}\`를 main에 머지할까요?`,
		'*답하는 법*: 이 스레드에 "머지해"라고 답하면 봇이 close→merge→push·워크트리 정리까지 하고, 서비스 반영(재시작)이 필요하면 그때 승인을 따로 요청합니다. 고칠 점이 있으면 그 내용을 적어 주세요.',
		evidenceLine(row),
		...boardFooter(link),
	].join("\n");
	const note = cardNote(link, MERGE_NOTE);
	return {
		text,
		title: `🔍 머지 대기 · ${row.title}`,
		body: [
			...lead,
			...summary,
			...skipped,
			...integrity,
			...(warnings.length === 0 ? [] : ["", ...warnings]),
			"",
			`${mentionToken(ownerUserId)} 머지할지 정해 주세요. 고칠 점이 있으면 이 스레드에 적어 주세요.`,
		].join("\n"),
		fields: [
			{ label: "수락기준", value: `${judgement.acChecked}/${row.acceptance.length}` },
			...(judgement.checks.length === 0
				? []
				: [{ label: "재실행 검사", value: `${passed}/${judgement.checks.length}` }]),
			branchField(row),
			workerField(row),
		],
		buttons: [mergeButton(row)],
		...(note === undefined ? {} : { note }),
	};
}

export const formatReachedNotice = (
	row: TaskRow,
	judgement: TaskJudgement,
	ownerUserId: string,
	link?: string,
): string => buildReachedCard(row, judgement, ownerUserId, link).text;

/**
 * The reached card when the bot has put "머지해" into the thread itself (`taskAutoLand`): news, not a question — no
 * button, no owner mention. The summary and the `*근거*` line are the reached card's.
 */
export function buildAutoLandCard(row: TaskRow, judgement: TaskJudgement, link?: string): TaskCard {
	const summary = summaryLines(row, judgement);
	const passed = judgement.checks.filter((check) => check.ok).length;
	const lead = `Outcome 도달 · 수락기준 ${judgement.acChecked}/${row.acceptance.length} · 재실행 검사 ${passed}/${judgement.checks.length} 통과 — 개인 저장소라 바로 머지합니다(close→ff 머지→push→정리).`;
	const title = `🚚 자동 머지 · ${row.title}`;
	const note = cardNote(link);
	return {
		text: [`${title} (${ownerTag(row)})`, lead, "", ...summary, "", evidenceLine(row), ...boardFooter(link)].join("\n"),
		title,
		body: [lead, "", ...summary].join("\n"),
		fields: [
			{ label: "수락기준", value: `${judgement.acChecked}/${row.acceptance.length}` },
			{ label: "재실행 검사", value: `${passed}/${judgement.checks.length}` },
			branchField(row),
			workerField(row),
		],
		...(note === undefined ? {} : { note }),
	};
}

/**
 * The card a `머지` click leaves behind, built from the row alone (the click never re-runs the judgement): title,
 * criteria count, branch and worker, no button, and `note` as the result line.
 */
export function buildMergeSettledCard(row: TaskRow, note: string): TaskCard {
	const title = `🔍 머지 대기 · ${row.title}`;
	return {
		text: `${title}\n${note}`,
		title,
		body: row.title,
		fields: [{ label: "수락기준", value: `${row.acceptance.length}개` }, branchField(row), workerField(row)],
		buttons: [],
		note,
	};
}

/**
 * A blocked task is a decision request (hub `[DECISION]`): reason, then the question/recommendation/impact the agent
 * wrote. `retried`: the agent was already sent the retry prompt for this block, said at the end of the reason line.
 */
export function buildBlockedCard(
	row: TaskRow,
	judgement: TaskJudgement,
	ownerUserId: string,
	link?: string,
	retried = false,
): TaskCard {
	const { question, recommend, impact } = judgement.decision;
	const decision = [
		`*사유*: ${judgement.blockedReason === "" ? "(적지 않음)" : judgement.blockedReason}${retried ? " (재도전 1회 뒤)" : ""}`,
		...(question === "" ? [] : [`*질문*: ${question}`]),
		...(recommend === "" ? [] : [`*추천*: ${recommend}`]),
		...(impact === "" ? [] : [`*영향*: ${impact}`]),
	];
	const step = judgement.current === "" ? "-" : judgement.current;
	const howTo = "*답하는 법*: 이 스레드에 결정을 적어 주시면 그 답을 담당 에이전트에 넘겨 재개합니다.";
	// `추천대로` only means something when the agent wrote a recommendation.
	const note = cardNote(link, recommend === "" ? undefined : RECOMMEND_NOTE);
	return {
		text: [
			`🚧 멈춤 · ${row.title} — 결정이 필요합니다. (${ownerTag(row)}) ${mentionToken(ownerUserId)}`,
			"",
			...decision,
			`*지금 단계*: ${step}`,
			howTo,
			...boardFooter(link),
		].join("\n"),
		title: `🚧 막힘 · ${row.title}`,
		body: [...decision, "", `${mentionToken(ownerUserId)} ${howTo}`].join("\n"),
		fields: [{ label: "단계", value: step }, branchField(row)],
		...(recommend === "" ? {} : { buttons: [recommendButton(row, recommend)] }),
		...(note === undefined ? {} : { note }),
	};
}

/**
 * The card a `추천대로` click leaves behind, built from the row alone (the click never re-runs the judgement): title,
 * branch, no button, and `note` as the result line (which carries the recommendation the button held).
 */
export function buildBlockedSettledCard(row: TaskRow, note: string): TaskCard {
	const title = `🚧 막힘 · ${row.title}`;
	return { text: `${title}\n${note}`, title, body: row.title, fields: [branchField(row)], buttons: [], note };
}

export const formatBlockedNotice = (
	row: TaskRow,
	judgement: TaskJudgement,
	ownerUserId: string,
	link?: string,
): string => buildBlockedCard(row, judgement, ownerUserId, link).text;

export const formatSpecChangedNotice = (row: TaskRow): string =>
	`⚠️ ${row.taskId} spec.md 수락기준이 등록 스냅샷과 다릅니다(개수·ID·문구). 고쳐질 때까지 Outcome에 도달하지 않습니다.`;

export const formatStaleNotice = (row: TaskRow, minutes: number, link?: string): string =>
	[
		`⏰ ${row.title}: PROGRESS.md가 ${minutes}분 넘게 갱신되지 않았습니다. (${ownerTag(row)})`,
		...boardFooter(link),
	].join("\n");

/** The task's herdr agent vanished (dori `[LOST]`): the owner hears it once per progress base, with the resume call. */
export function buildLostCard(row: TaskRow, ownerUserId: string, link?: string): TaskCard {
	const missing = `herdr에 \`${row.agent}\` 에이전트가 없습니다.`;
	const resume = `*재개*: \`ompbot_dispatch {mode:"herdr", taskSpec:{id:"${row.taskId}"}}\` — 같은 워크트리에서 에이전트를 다시 띄웁니다.`;
	const note = cardNote(link);
	return {
		text: [
			`👻 에이전트 없음 · ${row.title} — ${missing} (${ownerTag(row)}) ${mentionToken(ownerUserId)}`,
			resume,
			...boardFooter(link),
		].join("\n"),
		title: `👻 에이전트 없음 · ${row.title}`,
		body: [`${missing} ${mentionToken(ownerUserId)}`, resume].join("\n"),
		fields: [branchField(row), workerField(row)],
		...(note === undefined ? {} : { note }),
	};
}

/** Screen lines a wait notice carries (the last non-empty ones), and the length each is cut to. */
const WAIT_SCREEN_LINES = 12;
const WAIT_SCREEN_LINE_MAX = 200;

/**
 * A provider refusal on the screen tail: rate or usage limit, 429, quota, overload. Phrased as errors, so a bare
 * `429` or the word `overloaded` in the work on screen does not count. Gaps are `\s+` because a narrow pane wraps the
 * error line (omp at 80 columns breaks `… will reset at` / `2026-11-09 18:00:46]` over two lines).
 */
const PROVIDER_LIMIT_PATTERN =
	/\b429\b[\s\S]{0,40}(?:error|limit|too\s+many)|rate.?limit(?:ed|_error|\s+exceeded|\s+reached)|usage\s+limit|too\s+many\s+requests|quota\s+exceeded|exceeded\s+(?:your\s+)?(?:current\s+)?quota|overloaded_error|is\s+overloaded/i;
/** The reset time a usage-limit message names (`… will reset at 2026-11-09 18:00:46`). */
const LIMIT_RESET_PATTERN = /reset\s+at\s+(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)/i;

/**
 * The task's herdr agent waits on a question or an approval, or stopped on an error (herdr `blocked`): herdr refuses
 * new prompts to it (`agent_blocked`), so only the owner answering in the herdr pane unblocks it. Carries the screen
 * tail (masked, fences neutralized) so the owner sees what it waits on. A tail that shows a provider limit says so:
 * omp has used up its retries and fallbacks there, and the worker stays stopped until someone types in its pane.
 */
export function buildAgentWaitingCard(
	row: TaskRow,
	screen: { ok: boolean; output?: string; error?: string },
	ownerUserId: string,
	link?: string,
): TaskCard {
	const lines = (screen.output ?? "")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.slice(-WAIT_SCREEN_LINES)
		// Masked before the cut, so a clipped secret never escapes the shape match.
		.map((line) => redact(line).slice(0, WAIT_SCREEN_LINE_MAX).replaceAll("```", "ʼʼʼ"));
	const tail = lines.join("\n");
	const limited = screen.ok && PROVIDER_LIMIT_PATTERN.test(tail);
	const resetAt = limited ? LIMIT_RESET_PATTERN.exec(tail)?.[1] : undefined;
	const waiting = limited
		? `herdr 에이전트 \`${row.agent}\`가 공급자 한도(요청 제한·사용량)로 멈췄습니다. 재시도와 폴백을 다 써서 저절로 이어지지 않습니다.`
		: `herdr 에이전트 \`${row.agent}\`가 입력을 기다리거나 오류로 멈췄습니다.`;
	const howTo = limited
		? `*이어가는 법*: ${resetAt === undefined ? "한도가 풀린 뒤" : `한도가 풀리는 ${resetAt} 뒤`} 작업 보드의 herdr 화면에 \`이어서\`라고 입력합니다. 멈춘 동안은 herdr가 새 프롬프트를 거부합니다(agent_blocked).`
		: "*답하는 법*: 작업 보드의 herdr 화면에서 직접 답합니다. 대기 중인 에이전트는 herdr가 새 프롬프트를 거부합니다(agent_blocked).";
	const details = [
		...(screen.ok
			? ["*화면 끝부분*:", "```", ...lines, "```"]
			: [`*화면*: 읽지 못함 (${redact(screen.error ?? "unknown").slice(0, 120)})`]),
		howTo,
	];
	const note = cardNote(link);
	return {
		text: [
			`⚠️ 워커 대기 · ${row.title} — ${waiting} (${ownerTag(row)}) ${mentionToken(ownerUserId)}`,
			...details,
			...boardFooter(link),
		].join("\n"),
		title: `⏸ 워커 대기 · ${row.title}`,
		body: [`${waiting} ${mentionToken(ownerUserId)}`, ...details].join("\n"),
		fields: [branchField(row), workerField(row)],
		...(note === undefined ? {} : { note }),
	};
}

export const formatAgentWaitingNotice = (
	row: TaskRow,
	screen: { ok: boolean; output?: string; error?: string },
	ownerUserId: string,
	link?: string,
): string => buildAgentWaitingCard(row, screen, ownerUserId, link).text;

/** Unmet-condition nudges one task gets in a row before the owner resumes it (then the count starts over). */
export const NUDGE_MAX = 4;
/** Unmet conditions listed in a prompt or notice, and the length each line is cut to. */
const UNMET_LIST_MAX = 8;
const UNMET_LINE_MAX = 200;

/** `- <problem>` lines: the first eight, each cut at 200 characters, then `- …외 N개`. */
export function unmetLines(problems: readonly string[]): string[] {
	const lines = problems.slice(0, UNMET_LIST_MAX).map((problem) => `- ${problem.slice(0, UNMET_LINE_MAX)}`);
	if (problems.length > UNMET_LIST_MAX) lines.push(`- …외 ${problems.length - UNMET_LIST_MAX}개`);
	return lines;
}

/** The agent was nudged `NUDGE_MAX` times without reaching the outcome: the owner hears it once per resume. */
export function buildNudgeLimitCard(
	row: TaskRow,
	problems: readonly string[],
	ownerUserId: string,
	link?: string,
): TaskCard {
	const unmet = `미충족 조건을 ${NUDGE_MAX}번 알렸지만 Outcome에 닿지 않았습니다.`;
	const details = [
		"*남은 조건*:",
		...unmetLines(problems),
		"*답하는 법*: 이 스레드에 지시를 적으면 담당 에이전트에 넘겨 재개하고, 알림 횟수를 다시 셉니다.",
	];
	const note = cardNote(link);
	return {
		text: [
			`⚠️ nudge 상한 · ${row.title} — ${unmet} (${ownerTag(row)}) ${mentionToken(ownerUserId)}`,
			...details,
			...boardFooter(link),
		].join("\n"),
		title: `🔁 nudge 상한 · ${row.title}`,
		body: [`${unmet} ${mentionToken(ownerUserId)}`, ...details].join("\n"),
		fields: [branchField(row), workerField(row)],
		...(note === undefined ? {} : { note }),
	};
}

/** A task left in review: the owner hears it again every 24 hours until it is closed or resumed. */
export function buildReviewWaitingCard(row: TaskRow, hours: number, ownerUserId: string, link?: string): TaskCard {
	const howTo = `*답하는 법*: "머지해"라고 답하거나 고칠 점을 적어 주세요. 그만두려면 \`tasks close ${row.taskId} --as cancelled\`.`;
	const note = cardNote(link, MERGE_NOTE);
	return {
		text: [
			`🔍 리뷰 대기 ${hours}시간 · ${row.title} — Outcome 도달 뒤 닫히지 않았습니다. (${ownerTag(row)}) ${mentionToken(ownerUserId)}`,
			howTo,
			...boardFooter(link),
		].join("\n"),
		title: `⏳ 리뷰 대기 · ${row.title}`,
		body: [`Outcome 도달 뒤 닫히지 않았습니다. ${mentionToken(ownerUserId)}`, howTo].join("\n"),
		fields: [{ label: "대기 시간", value: `${hours}시간` }, branchField(row)],
		buttons: [mergeButton(row)],
		...(note === undefined ? {} : { note }),
	};
}

export const formatReadFailureNotice = (row: TaskRow, failures: number, error: string): string =>
	`⚠️ ${row.taskId} 상태 문서를 ${failures}회 연속 읽지 못했습니다 (${hostLabelOf(row)}): ${error.slice(0, 160)}`;
