import type { ActionButton } from "../channel/port";
import { mentionToken } from "../channel/port";
import { redact } from "../redact";
import type { TaskCard } from "../tasks/notify";
import { CHECK_TIMEOUT_MS } from "../tasks/signals";
import { REVIEW_BLOCK } from "./land";
import { INCONCLUSIVE_APPROVED, INTEGRITY_APPROVED, type LaneChanges, type LaneRow } from "./status";

/**
 * The Outcome card of a closed work lane, in the lane's thread: what the lane claimed, what the core re-ran, and the
 * `머지`/`폐기` buttons — then, edited in place, how the landing went. Laid out like the [TASK] reached card
 * (`buildReachedCard`); `text` is the whole card as one string for notifications and clients without cards.
 */

const LANE_MERGE_ACTION_PREFIX = "ompbot:lane:merge:";
const LANE_DISCARD_ACTION_PREFIX = "ompbot:lane:discard:";
const LANE_PAUSE_ACTION_PREFIX = "ompbot:lane:pause:";
const LANE_RESUME_ACTION_PREFIX = "ompbot:lane:resume:";
/** Lane names are slugs (`slugify` in the manager) with an optional `-n` suffix. */
const LANE_NAME = /^[a-z0-9가-힣-]{1,64}$/;
const SUMMARY_MAX = 300;
/** Characters of the reviewer's findings quoted on an ask card. */
const REVIEW_NOTES_SHOWN = 600;

export const laneMergeActionId = (name: string): string => `${LANE_MERGE_ACTION_PREFIX}${name}`;
export const laneDiscardActionId = (name: string): string => `${LANE_DISCARD_ACTION_PREFIX}${name}`;
export const lanePauseActionId = (name: string): string => `${LANE_PAUSE_ACTION_PREFIX}${name}`;
export const laneResumeActionId = (name: string): string => `${LANE_RESUME_ACTION_PREFIX}${name}`;

/** What a lane card/status button click does to the lane; `undefined` for any other action id. */
export type LaneAction = { kind: "merge" | "discard" | "pause" | "resume"; name: string };

export function parseLaneActionId(actionId: string): LaneAction | undefined {
	for (const [prefix, kind] of [
		[LANE_MERGE_ACTION_PREFIX, "merge"],
		[LANE_DISCARD_ACTION_PREFIX, "discard"],
		[LANE_PAUSE_ACTION_PREFIX, "pause"],
		[LANE_RESUME_ACTION_PREFIX, "resume"],
	] as const) {
		if (!actionId.startsWith(prefix)) continue;
		const name = actionId.slice(prefix.length);
		return LANE_NAME.test(name) ? { kind, name } : undefined;
	}
	return undefined;
}

export type LaneCardView =
	/** The owner decides: both buttons. `skipped` = why `taskAutoLand` did not merge it (absent: no policy). */
	| { kind: "ask"; ownerUserId?: string | undefined; skipped?: readonly string[] | undefined }
	/** The core is merging it now (`taskAutoLand`): news, no button, no mention. */
	| { kind: "auto" }
	/** How the landing ended, read from `lane.meta.land` (landed, merged-not-pushed, blocked, discarded). */
	| { kind: "result"; ownerUserId?: string | undefined }
	/** The owner asked for the merge: it runs now, or (`queued`) as soon as the lane's closing turn ends. No button. */
	| { kind: "merging"; queued: boolean }
	/** The lane is working again (base branch moved ahead, or the owner reopened it): no button. */
	| { kind: "rework"; reason: string }
	/** An older card whose content moved to a newer one: title and a pointer, no button. */
	| { kind: "superseded" };

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const buttonsOf = (lane: LaneRow): ActionButton[] => [
	{ actionId: laneMergeActionId(lane.name), label: "머지", value: lane.name, style: "primary" },
	{ actionId: laneDiscardActionId(lane.name), label: "폐기", value: lane.name, style: "danger" },
];

/** What the two buttons do, as the grey line of a card that has them. */
const buttonNote = (lane: LaneRow): string =>
	`머지 = ff 머지 → push origin/${lane.meta.baseBranch ?? "?"} → worktree 정리 · 폐기 = worktree·브랜치 삭제 · 재시작은 따로 승인`;

/** How to get the base branch back to where it was before the merge. */
function undoLine(lane: LaneRow): string {
	const base = lane.meta.baseBranch ?? "?";
	const preSha = lane.meta.land?.preSha;
	return preSha === undefined || preSha === "unknown"
		? `되돌리기: 머지 전 커밋을 기록하지 못했습니다 — \`git -C ${lane.meta.repo ?? "<repo>"} reflog show ${base}\`에서 찾으세요.`
		: `되돌리기: 머지 전 \`${base}\`는 \`${preSha.slice(0, 12)}\`였습니다.`;
}

/** `변경: path (+x −y), …` with the most changed files; none when the diff failed or changed only binaries. */
function topLine(changes: LaneChanges): string[] {
	if (changes.error !== undefined || changes.top.length === 0) return [];
	const listed = changes.top.map((entry) => `${entry.path} (+${entry.added} −${entry.deleted})`).join(", ");
	const rest = changes.files - changes.top.length;
	return [`변경: ${listed}${rest > 0 ? ` 외 ${rest}개` : ""}`];
}

/** `⚠️ 겹침: …` naming other lanes and the base branch that changed the same files; none when nothing overlaps. */
function overlapLine(changes: LaneChanges): string[] {
	const parts = [
		...changes.overlaps.map((overlap) => `레인 \`${overlap.lane}\` — ${overlap.files.join(", ")}`),
		...(changes.baseDrift.length === 0 ? [] : [`base가 그새 바꾼 파일 — ${changes.baseDrift.join(", ")}`]),
	];
	if (parts.length > 0) {
		return [`⚠️ 겹침: ${parts.join(" · ")}${changes.overlapError === undefined ? "" : " (일부 확인 실패)"}`];
	}
	return changes.overlapError === undefined ? [] : ["⚠️ 겹침: 일부 확인 실패"];
}

export function buildLaneOutcomeCard(lane: LaneRow, view: LaneCardView): TaskCard {
	const { meta } = lane;
	const base = meta.baseBranch ?? "?";
	const sha = (meta.sha ?? "").slice(0, 12);
	const acceptance = meta.acceptance ?? [];
	const checks = meta.checks !== undefined && meta.checks.head === meta.sha ? meta.checks.results : [];
	const passed = checks.filter((check) => check.ok).length;
	// Timed-out checks the owner let through: shown as waiting (⏳), never as failed.
	const inconclusive = checks.filter((check) => check.inconclusive === true).length;
	const pending = inconclusive === 0 ? "" : ` · ⏳ ${inconclusive} 확인 불가`;
	// A criterion counts as confirmed by the bot when it has a `[check: …]` and every one of them passed.
	const confirmed = acceptance.filter((item) => {
		const own = checks.filter((check) => check.id === item.id);
		return own.length > 0 && own.every((check) => check.ok);
	}).length;
	const summary =
		meta.claim === undefined ? [] : [`• ${clip(redact(meta.claim.summary).replace(/\s+/g, " ").trim(), SUMMARY_MAX)}`];
	const checkLine =
		checks.length === 0
			? ["재실행 검사 없음 — 봇이 직접 확인한 수락기준이 없습니다."]
			: [`✅ check ${passed}/${checks.length} 통과${pending} — 봇이 레인 worktree에서 직접 다시 실행했습니다.`];
	// What the claim commit changed (`computeLaneChanges`): only the record of this very commit is shown.
	const changes = meta.changes !== undefined && meta.changes.sha === meta.sha ? meta.changes : undefined;
	const changeLines = changes === undefined ? [] : [...topLine(changes), ...overlapLine(changes)];
	const held = meta.land?.autoLandHeld;
	const integrity =
		held === INTEGRITY_APPROVED
			? [`⚠️ ${held}으로 닫힌 레인입니다(무결성 거부를 오너가 승인).`]
			: held === INCONCLUSIVE_APPROVED
				? [`⚠️ ${held}으로 닫힌 레인입니다(재실행 검사 ${CHECK_TIMEOUT_MS / 1000}초 초과를 오너가 승인).`]
				: [];
	const fields = [
		{ label: "수락기준(봇 확인/전체)", value: `${confirmed}/${acceptance.length}` },
		{ label: "재실행 검사", value: `${passed}/${checks.length}${pending}` },
		{ label: "브랜치", value: `\`${meta.branch ?? "?"}\` → \`${base}\`` },
		{ label: "커밋", value: `\`${sha}\`` },
		...(changes === undefined
			? []
			: [
					{
						label: "변경",
						value:
							changes.error === undefined
								? `${changes.files}개 파일 · +${changes.insertions} −${changes.deletions}`
								: "확인 실패",
					},
				]),
	];
	const mention = (ownerUserId: string | undefined): string =>
		ownerUserId === undefined ? "" : ` ${mentionToken(ownerUserId)}`;
	const card = (title: string, lines: string[], extra: Pick<TaskCard, "buttons" | "note"> = {}): TaskCard => ({
		text: [title, ...lines].join("\n"),
		title,
		body: lines.join("\n"),
		fields,
		...extra,
	});

	// The receipt of the independent review (`taskAutoLand.review`) for this claim commit, if there is one.
	const review = meta.review !== undefined && meta.review.sha === meta.sha ? meta.review : undefined;
	if (view.kind === "ask") {
		const skipped =
			view.skipped === undefined || view.skipped.length === 0 ? [] : [`자동 머지 안 함: ${view.skipped.join(" · ")}`];
		// A BLOCK shows what the reviewer found; an inconclusive review's reason is already in the skipped line.
		const findings =
			view.skipped?.includes(REVIEW_BLOCK) === true && review?.verdict === "BLOCK" && review.notes !== ""
				? [
						"*리뷰 지적*",
						...clip(redact(review.notes), REVIEW_NOTES_SHOWN)
							.split("\n")
							.map((line) => `> ${line}`),
					]
				: [];
		return card(
			`🔍 머지 대기 · ${lane.title}`,
			[
				...summary,
				...skipped,
				...findings,
				...integrity,
				...checkLine,
				...changeLines,
				`브랜치 \`${meta.branch ?? "?"}\`를 \`${base}\`에 머지할까요?${mention(view.ownerUserId)}`,
				'버튼을 누르거나 이 스레드에 "머지해" 또는 "폐기해"라고만 답해 주세요. 고칠 점이 있으면 `!reopen <지시>`로 적어 주세요.',
			],
			{ buttons: buttonsOf(lane), note: buttonNote(lane) },
		);
	}
	if (view.kind === "auto") {
		return card(`🚚 자동 머지 · ${lane.title}`, [
			`레인 완료 · 재실행 검사 ${passed}/${checks.length} 통과 — 개인 저장소라 바로 머지합니다(ff 머지 → push origin/${base} → worktree 정리).`,
			...(review?.verdict === "CLEAR" ? [`🔎 독립 리뷰 CLEAR · ${review.model}`] : []),
			...summary,
		]);
	}
	if (view.kind === "merging") {
		return card(`⏳ 머지 중 · ${lane.title}`, [
			view.queued
				? `레인이 마무리 보고를 끝내는 대로 \`${base}\`에 머지합니다(ff 머지 → push origin/${base} → worktree 정리).`
				: `\`${base}\`에 머지하고 있습니다(ff 머지 → push origin/${base} → worktree 정리).`,
			"결과는 이 카드에 표시됩니다.",
		]);
	}
	if (view.kind === "rework") {
		return card(`🔄 다시 작업 중 · ${lane.title}`, [view.reason, "끝나면 새 카드로 다시 알려 드립니다."]);
	}
	if (view.kind === "superseded") {
		return card(`🔍 머지 대기 · ${lane.title}`, ["이 카드는 지난 것입니다. 아래 새 카드를 봐 주세요."]);
	}

	const land = meta.land;
	const how = land?.requestedBy === "auto" ? "자동 머지" : "오너 요청";
	if (land?.state === "landed") {
		const push =
			land.pushed === undefined ? "push 없음(origin 원격이 없거나 push 대상이 아님)" : `push \`${land.pushed}\``;
		return card(`✅ 머지 완료 · ${lane.title}`, [
			`\`${base}\` ← \`${sha}\` (${how}) · ${push} · ${land.cleanup === undefined ? "worktree·브랜치 정리" : `⚠️ ${redact(land.cleanup)}`}`,
			...summary,
			undoLine(lane),
			"서비스 반영(재시작)이 필요하면 따로 승인해 주세요.",
		]);
	}
	if (land?.state === "merged-not-pushed") {
		return card(`⚠️ 머지됨 · push 안 됨 · ${lane.title}`, [
			`\`${base}\` ← \`${sha}\` (${how}) ${land.cleanup === undefined ? "머지와 worktree 정리는" : "머지는"} 끝났지만 push origin/${base}가 되지 않았습니다.${mention(view.ownerUserId)}`,
			`사유: ${redact(land.reason ?? "(알 수 없음)")}`,
			...(land.cleanup === undefined ? [] : [`⚠️ ${redact(land.cleanup)}`]),
			`직접 확인한 뒤 \`git -C ${meta.repo ?? "<repo>"} push origin ${base}\`로 올려 주세요.`,
			undoLine(lane),
		]);
	}
	if (land?.state === "discarded") {
		return card(`🗑 폐기 · ${lane.title}`, [
			`worktree와 브랜치 \`${meta.branch ?? "?"}\`를 지웠습니다. 머지하지 않았습니다.`,
			`커밋 \`${sha}\`는 \`git -C ${meta.repo ?? "<repo>"} branch <이름> ${sha}\`로 되살릴 수 있습니다(reflog에 남아 있는 동안).`,
		]);
	}
	// blocked (and anything unexpected): the owner decides again.
	return card(
		`🚧 머지 막힘 · ${lane.title}`,
		[
			`머지를 끝내지 못했습니다.${mention(view.ownerUserId)}`,
			`사유: ${redact(land?.reason ?? "(알 수 없음)")}`,
			...summary,
			'원인을 치운 뒤 `머지`를 다시 누르거나 "머지해"라고 답해 주세요. 버리려면 `폐기`입니다.',
		],
		{ buttons: buttonsOf(lane), note: buttonNote(lane) },
	);
}
