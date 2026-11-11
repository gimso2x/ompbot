import { basename } from "node:path";
import type { ProviderLimitInfo, SessionMismatchInfo, StallEscalation, TurnFailureEscalation } from "../core/mailbox";
import { COMMAND_TEXT } from "../core/types";
import type { Gate } from "../ops/gates";
import { redact } from "../redact";

/** Owner-DM texts of the unattended reliability loop (turn-failure escalation, gate self-report). Korean, one glance. */

/** One line, always: Slack collapses whitespace and error text is attacker-influenced. */
const oneLine = (text: string, max = 160): string => text.replace(/\s+/g, " ").trim().slice(0, max);

/**
 * `🚨 [자가보고] … N번 연속 실패`: what a run of failed turns looks like to the owner. `count` is the incident's
 * occurrence count (the 24h-repeat suppression increments it), so a recurring outage names itself.
 */
export function formatTurnEscalationNotice(info: TurnFailureEscalation, count: number): string {
	const repeat = count > 1 ? ` · 같은 사안 반복 ${count}회차` : "";
	const healed = info.modelHealed
		? "\n모델 문제로 판단해 실행 중인 세션의 모델을 자동 교체했습니다. 다음 메시지로 정상 동작을 확인해 주세요."
		: "";
	return [
		`🚨 [자가보고] ${info.originKey} 작업이 ${info.failures}번 연속 실패했습니다${repeat}`,
		`마지막 사인: ${oneLine(info.reason)}${healed}`,
	].join("\n");
}

/**
 * `⚠️ 모델 공급자 한도 소진(…)`: omp's retry events reported a 429/usage limit. `count` is the incident's occurrence
 * count (24h repeat suppression), so a standing limit names its recurrence.
 */
export function formatProviderLimitNotice(info: ProviderLimitInfo, count: number): string {
	const repeat = count > 1 ? ` (처음 감지 뒤 ${count}회)` : "";
	return `⚠️ 모델 공급자 한도 소진(${info.originKey}): ${oneLine(redact(info.errorMessage))} — omp가 재시도·폴백 중이라 응답이 늦어질 수 있습니다.${repeat}`;
}

/**
 * `⚠️ [자가보고] … N분째 응답이 없습니다`: a turn that keeps stalling. A conversation turn is left running — the
 * owner picks between waiting and `/new-ompbot` (which aborts it); an unattended monitor turn was already aborted and
 * recorded as a failed event, which retries on its own backoff.
 */
export function formatStallNotice(info: StallEscalation): string {
	const silent = Math.max(1, Math.round(info.totalSilentMs / 60_000));
	if (info.kind === "abort") {
		return [
			`🚨 [자가보고] ${info.originKey} 모니터 실행이 응답 없이 ${silent}분째라 중단했습니다 (멈춤 ${info.count}회)`,
			"이번 실행은 실패로 기록했고 모니터의 재시도 규칙대로 다시 시도합니다.",
		].join("\n");
	}
	return [
		`⚠️ [자가보고] ${info.originKey} 작업이 응답 없이 ${silent}분째입니다 (멈춤 ${info.count}회 반복)`,
		`자동으로 끊지 않았습니다. 더 기다리거나, 끊고 새로 시작하려면 \`${COMMAND_TEXT.new}\`를 보내세요.`,
	].join("\n");
}

/**
 * `🚨 [자가보고] … 메시지를 N분째 보내지 못하고 있습니다`: the sweep keeps failing to re-dispatch an origin's
 * stranded pending row. `count` is the incident's occurrence count (24h-repeat suppression), `reason` the last
 * raw drain error — redacted by the caller before it reaches Slack.
 */
export function formatPendingDispatchNotice(
	originKey: string,
	waitingMs: number,
	reason: string,
	count: number,
): string {
	const repeat = count > 1 ? ` · 같은 사안 반복 ${count}회차` : "";
	const waiting = Math.max(1, Math.round(waitingMs / 60_000));
	return [
		`🚨 [자가보고] ${originKey}의 메시지를 ${waiting}분째 보내지 못하고 있습니다${repeat}`,
		`마지막 사인: ${oneLine(reason)}`,
		"스위프가 계속 재시도합니다 — 원인이 해소되면 자동으로 전송됩니다.",
		// The queue list only numbers plain and followup rows (mailbox #waitingRows): a stranded chat command
		// (/new-ompbot with a wedged abort) is invisible there, so the hint must not promise it can be cancelled.
		`대기 중인 일반 메시지는 \`${COMMAND_TEXT.queue}\`에서 취소할 수 있습니다.`,
	].join("\n");
}

/** `⚠️ 이전 세션을 잇지 못하고…`: the thread's child opened another session than the one to resume (file names only). */
export function formatSessionMismatchNotice(info: SessionMismatchInfo): string {
	return `⚠️ 이전 세션을 잇지 못하고 다른 세션으로 열었습니다. 앞 대화 맥락이 없을 수 있습니다. (기대 ${basename(info.expected)} · 실제 ${basename(info.actual)})`;
}

/** `🚨 [자가진단] 게이트 … 열림`: a health gate just opened; a gate still open past 24h says how long it has stood. */
export function formatGateOpenNotice(gate: Gate, firstAt: number, now: number): string {
	const hours = Math.floor((now - firstAt) / 3_600_000);
	const persist = hours >= 24 ? ` · ${hours}시간째 지속` : "";
	return [
		`🚨 [자가진단] 게이트 ${gate.name} 열림${persist}`,
		`상태: ${oneLine(gate.detail)}`,
		...(gate.name === "backup_age" && gate.detail === "stamp=missing" ? [NO_BACKUP_YET_HINT] : []),
		"회복되면 다시 알립니다.",
	].join("\n");
}

/**
 * A home that has never been backed up: right after a first install this alert is expected (the backup needs the
 * ledger the daemon has just created), so the notice says what to do instead of reading like a failure.
 */
export const NO_BACKUP_YET_HINT =
	"백업이 아직 한 번도 없습니다. 첫 설치 직후라면 정상입니다 — 서버에서 `ompbot backup`(체크아웃에서는 `bun src/main.ts backup`)을 한 번 돌리고 `ompbot-backup.timer`를 켜 두면 닫힙니다.";

/** `✅ [자가진단] 게이트 … 회복`: sent only when the open period had actually alerted the owner. */
export function formatGateClosedNotice(gate: Gate): string {
	return `✅ [자가진단] 게이트 ${gate.name} 회복 — 이전 문제가 해결되었습니다.`;
}
