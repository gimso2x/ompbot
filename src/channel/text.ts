// Platform-neutral text helpers every adapter shares: message chunking, the redelivery mark, the running status line
// and the final marks a finished turn leaves.
import type { TurnProgress } from "../core/mailbox";

export const CHUNK_LIMIT = 3900;
export const REDELIVERED_PREFIX = "(중복 가능: 재전송)";
/** What a non-owner gets back for a command or a button click (ephemeral). */
export const DENIED_TEXT = "권한 없음: 이 봇은 오너만 사용할 수 있습니다.";

/** Room kept in every chunk so a code fence cut by a split can be closed ("\n```") and reopened ("```\n"). */
export const FENCE_RESERVE = 8;

/** Minimum gap between two edits of one running status message. */
export const STATUS_MIN_INTERVAL_MS = 15_000;
/** Longest text of one progress line (a tool call, the current task-list item) in the running status message. */
const ACTIVITY_MAX = 60;

/** Running-status text while the turn has emitted no omp event for the stall window (120 s). */
export const STALL_STATUS_TEXT = "⏸ 응답 없음 2분";

/** The text format of `OutboundMessage.text` escapes only &, < and >; core text quoted into it goes through this. */
export const escapeMrkdwn = (text: string): string =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const mm = String(Math.floor(total / 60)).padStart(2, "0");
	const ss = String(total % 60).padStart(2, "0");
	return `${mm}:${ss}`;
}

function splitAt(text: string, limit: number, keepWhole: (cut: number) => number): [string, string] {
	if (text.length <= limit) return [text, ""];
	let cut = text.lastIndexOf("\n\n", limit);
	if (cut < limit / 2) cut = text.lastIndexOf("\n", limit);
	if (cut < limit / 2) cut = text.lastIndexOf(" ", limit);
	if (cut < limit / 2) {
		cut = limit;
		// never split a surrogate pair
		const code = text.charCodeAt(cut - 1);
		if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
	}
	cut = keepWhole(cut);
	return [text.slice(0, cut), text.slice(cut).replace(/^\n+/, "")];
}

/**
 * Splits into messages of at most `limit` characters, preferring paragraph/line boundaries and keeping code fences
 * balanced. A cut inside one of the `keepWhole` spans (each at most the limit) moves to the line break before it, or
 * past it when the span opens the message.
 */
export function chunkText(
	text: string,
	limit = CHUNK_LIMIT,
	keepWhole: ReadonlyArray<readonly [number, number]> = [],
): string[] {
	const budget = limit - FENCE_RESERVE;
	const raw: string[] = [];
	let rest = text;
	while (rest.length > 0) {
		const base = text.length - rest.length;
		const [head, tail] = splitAt(rest, budget, (cut) => {
			const span = keepWhole.find(([start, end]) => start < base + cut && base + cut < end);
			if (span === undefined) return cut;
			const before = span[0] - base - 1;
			return before > 0 ? before : span[1] - base;
		});
		raw.push(head);
		rest = tail;
	}
	if (raw.length === 0) return [""];
	let open = false;
	return raw.map((chunk) => {
		let out = open ? `\`\`\`\n${chunk}` : chunk;
		const fences = (chunk.match(/```/g) ?? []).length;
		if (fences % 2 === 1) open = !open;
		if (open) out = `${out}\n\`\`\``;
		return out;
	});
}

/** How a thread's ⏳ status message and 👀 reaction end: normal close, failure, or a cancelled wait. */
export type FinalOutcome = "done" | "failed" | "cancelled";

/** One place deciding how each final outcome reads in the status line and which reaction mark it leaves. */
export const FINAL_MARKS: Record<FinalOutcome, { label: string; mark: string }> = {
	done: { label: "✅ 완료", mark: "white_check_mark" },
	cancelled: { label: "🚫 취소됨", mark: "x" },
	failed: { label: "⚠️ 실패", mark: "warning" },
};

/** Collapses control characters and line separators so untrusted text cannot start a new prompt line. */
export function oneLine(text: string, max: number): string {
	return text
		.replace(/[\p{Cc}\u2028\u2029]+/gu, " ")
		.trim()
		.slice(0, max);
}

/** Cuts to at most `limit` UTF-16 units without leaving a lone high surrogate at the end. */
export function cutCodePointSafe(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const last = text.charCodeAt(limit - 1);
	return text.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit);
}

/** One progress line: a single line of at most `ACTIVITY_MAX`, never ending in a lone high surrogate. */
export function progressLine(text: string): string {
	const cut = oneLine(text, ACTIVITY_MAX);
	return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * The running status message: `⏳ 작업 중 · mm:ss · 도구 N회` (or the stalled text and the elapsed time), then the
 * task-list, steer, retry and recent-tool lines; a line whose value is 0 or unknown is left out.
 */
export function runningStatusText(stalled: boolean, elapsedMs: number, progress: TurnProgress | undefined): string {
	const tools = progress?.tools ?? 0;
	const head = stalled
		? `${STALL_STATUS_TEXT} · ${formatElapsed(elapsedMs)}`
		: `⏳ 작업 중 · ${formatElapsed(elapsedMs)}${tools > 0 ? ` · 도구 ${tools}회` : ""}`;
	if (progress === undefined) return head;
	const lines = [head];
	const { todo } = progress;
	if (todo !== undefined && todo.total > 0) {
		const current = todo.current === undefined ? "" : progressLine(todo.current);
		lines.push(`📋 ${todo.done}/${todo.total}${current === "" ? "" : ` · ${current}`}`);
	}
	if (progress.steers > 0) lines.push(`📨 추가 메시지 ${progress.steers}건 반영`);
	if (progress.retries > 0) lines.push(`🔁 모델 재시도 ${progress.retries}회`);
	for (const tool of progress.recentTools) {
		const line = progressLine(tool);
		if (line !== "") lines.push(`· ${line}`);
	}
	return lines.join("\n");
}
