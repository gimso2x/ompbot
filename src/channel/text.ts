// Platform-neutral text helpers every adapter shares: message chunking, the redelivery mark, the running status line
// and the final marks a finished turn leaves.
import type { TurnProgress } from "../core/mailbox";
import { typicalNote } from "../store/turn-duration";

export const CHUNK_LIMIT = 3900;
export const REDELIVERED_PREFIX = "(중복 가능: 재전송)";
/** What a non-owner gets back for a command or a button click (ephemeral). */
export const DENIED_TEXT = "권한 없음: 이 봇은 오너만 사용할 수 있습니다.";

/**
 * Room kept in every chunk so a code fence cut by a split can be closed ("\n```") and reopened ("```\n"); `chunkText`
 * keeps two more characters per extra backtick of the longest fence in the text.
 */
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
	// The fence fix only moves the cut back; it is dropped when nothing would be left before it (the loop of
	// `chunkText` must always advance) or when it lands inside a span kept whole.
	const fenced = fenceSafeCut(text, cut);
	if (fenced > 0 && keepWhole(fenced) === fenced) cut = fenced;
	return [text.slice(0, cut), text.slice(cut).replace(/^\n+/, "")];
}

/**
 * Moves a cut off a code fence mark: a cut inside a line opening with ``` goes to that line's start (the language tag
 * stays on the fence), a cut inside a run of backticks to the run's start, and a cut inside the language tag right
 * after a mid-line ``` run to that run's start.
 */
function fenceSafeCut(text: string, cut: number): number {
	if (cut <= 0 || cut >= text.length) return cut;
	const lineStart = text.lastIndexOf("\n", cut - 1) + 1;
	const newline = text.indexOf("\n", lineStart);
	const lineEnd = newline === -1 ? text.length : newline;
	if (cut < lineEnd && /^[ \t]*```/.test(text.slice(lineStart, lineEnd))) return lineStart;
	const runStart = (end: number): number => {
		let start = end;
		while (start > 0 && text[start - 1] === "`") start -= 1;
		return start;
	};
	if (text[cut - 1] === "`" && text[cut] === "`") return runStart(cut - 1);
	if (/\s/.test(text[cut] ?? " ")) return cut;
	let tag = cut;
	while (tag > lineStart && !/[\s`]/.test(text[tag - 1] ?? " ")) tag -= 1;
	if (text[tag - 1] !== "`") return cut;
	const start = runStart(tag);
	return tag - start >= 3 ? start : cut;
}

/**
 * Splits into messages of at most `limit` characters, preferring paragraph/line boundaries and keeping code fences
 * balanced; a fence mark and a line opening a fence are never cut in two. A cut inside one of the `keepWhole` spans
 * (each at most the limit) moves to the line break before it, or past it when the span opens the message.
 */
export function chunkText(
	text: string,
	limit = CHUNK_LIMIT,
	keepWhole: ReadonlyArray<readonly [number, number]> = [],
): string[] {
	let longest = 3;
	for (const line of text.split("\n")) {
		const run = fenceRun(line);
		if (run !== undefined && run > longest) longest = run;
	}
	const budget = limit - FENCE_RESERVE - 2 * (longest - 3);
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
	// The backtick count of the fence open at a chunk's end: 0 when none. A fence opened at a line's head closes only on
	// a line of at least as many backticks alone; any other ``` (mid-line, or a run too long to track) toggles a
	// three-backtick fence as before.
	let open = 0;
	let lineHead = false;
	return raw.map((chunk) => {
		const mark = "`".repeat(open);
		let out = open > 0 ? `${mark}\n${chunk}` : chunk;
		for (const line of chunk.split("\n")) {
			if (lineHead) {
				const close = /^ {0,3}(`+)[ \t]*\r?$/.exec(line);
				if (close !== null && (close[1]?.length ?? 0) >= open) {
					open = 0;
					lineHead = false;
				}
				continue;
			}
			const run = open === 0 ? fenceRun(line) : undefined;
			if (run !== undefined) {
				open = run;
				lineHead = true;
				continue;
			}
			if ((line.match(/```/g) ?? []).length % 2 === 1) open = open > 0 ? 0 : 3;
		}
		if (open > 0) out = `${out}\n${"`".repeat(open)}`;
		return out;
	});
}

/** Longest fence `chunkText` closes and reopens with as many backticks; a longer run is treated as plain ```. */
const MAX_FENCE_RUN = 16;

/** The backtick count of a line opening a fence (up to 3 spaces, 3+ backticks, an info string without backticks). */
function fenceRun(line: string): number | undefined {
	const run = /^ {0,3}(`{3,})[^`]*$/.exec(line)?.[1]?.length;
	return run !== undefined && run <= MAX_FENCE_RUN ? run : undefined;
}

/**
 * How a thread's ⏳ status message and 👀 reaction end: normal close, failure, a cancelled wait, or an answer the
 * delivery ledger gave up on (ambiguous send, retries spent, expired).
 */
export type FinalOutcome = "done" | "failed" | "cancelled" | "undelivered";

/** One place deciding how each final outcome reads in the status line and which reaction mark it leaves. */
export const FINAL_MARKS: Record<FinalOutcome, { label: string; mark: string }> = {
	done: { label: "✅ 완료", mark: "white_check_mark" },
	cancelled: { label: "🚫 취소됨", mark: "x" },
	failed: { label: "⚠️ 실패", mark: "warning" },
	undelivered: { label: "⚠️ 답을 보내지 못했습니다", mark: "warning" },
};

/**
 * The footer an answer carries when it takes the place of the thread's deleted `⏳` status: `✅ 00:42 · 도구 6회`
 * (the outcome's mark and elapsed time, then the tool count when the turn ran any). Slack, Discord and Teams share
 * the string; each decides from its own status entry whether the answer gets one at all.
 */
export function formatFooter(outcome: "done" | "failed", elapsedMs: number, tools: number): string {
	const mark = FINAL_MARKS[outcome].label.split(" ")[0];
	return `${mark} ${formatElapsed(elapsedMs)}${tools > 0 ? ` · 도구 ${tools}회` : ""}`;
}

/** A thrown value as one log field: its message, or the value itself when it is not an Error. */
export function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

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
	const note = typicalNote(elapsedMs, progress?.typical);
	const usual = note === undefined ? "" : ` · ${note}`;
	const head = stalled
		? `${STALL_STATUS_TEXT} · ${formatElapsed(elapsedMs)}`
		: `⏳ 작업 중 · ${formatElapsed(elapsedMs)}${tools > 0 ? ` · 도구 ${tools}회` : ""}${usual}`;
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

/** Terminal-style width: East Asian wide/fullwidth and emoji count as 2 columns, everything else as 1. */
export function displayWidth(text: string): number {
	let width = 0;
	for (const ch of text) {
		const cp = ch.codePointAt(0) ?? 0;
		const wide =
			(cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
			(cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals and symbols
			(cp >= 0x3041 && cp <= 0x33ff) || // Kana, CJK compatibility
			(cp >= 0x3400 && cp <= 0x4dbf) || // CJK extension A
			(cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
			(cp >= 0xa960 && cp <= 0xa97f) || // Hangul Jamo extended-A
			(cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
			(cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
			(cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
			(cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
			(cp >= 0xffe0 && cp <= 0xffe6) ||
			(cp >= 0x1f300 && cp <= 0x1f9ff) || // emoji
			(cp >= 0x20000 && cp <= 0x3fffd); // CJK extension B and beyond
		width += wide ? 2 : 1;
	}
	return width;
}

/** Splits one GFM table row into trimmed cells; `\|` is a literal pipe inside a cell. */
export function splitRowCells(line: string): string[] {
	let trimmed = line.trim();
	if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
	if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) trimmed = trimmed.slice(0, -1);
	const cells: string[] = [];
	let cell = "";
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (ch === "\\" && trimmed[i + 1] === "|") {
			cell += "|";
			i++;
			continue;
		}
		if (ch === "|") {
			cells.push(cell.trim());
			cell = "";
			continue;
		}
		cell += ch;
	}
	cells.push(cell.trim());
	return cells;
}

/**
 * When a GFM table starts at line `i`, the index of the first line after it: a row of 2+ cells, a delimiter row of the
 * same count (hyphens, at least `minDashes` per cell, optional colons) and the rows after it holding an unescaped pipe.
 */
export function tableEndAt(lines: readonly string[], i: number, minDashes = 1): number | undefined {
	const header = splitRowCells(lines[i] ?? "");
	const delimiter = i + 1 < lines.length ? splitRowCells(lines[i + 1] ?? "") : undefined;
	if (delimiter === undefined || header.length < 2 || header.length !== delimiter.length) return undefined;
	const rule = new RegExp(`^\\s*:?-{${minDashes},}:?\\s*$`);
	if (!delimiter.every((cell) => rule.test(cell))) return undefined;
	let j = i + 2;
	while (j < lines.length && /(?<!\\)\|/.test(lines[j] ?? "")) j++;
	return j;
}

/** `[start, end)` character spans of the GFM tables outside code fences: a chunk cut must not fall inside one. */
export function tableSpans(text: string): Array<readonly [number, number]> {
	const lines = text.split("\n");
	const starts: number[] = [];
	let offset = 0;
	for (const line of lines) {
		starts.push(offset);
		offset += line.length + 1;
	}
	const spans: Array<readonly [number, number]> = [];
	let inFence = false;
	let i = 0;
	while (i < lines.length) {
		const end = inFence ? undefined : tableEndAt(lines, i);
		if (end !== undefined) {
			spans.push([starts[i] ?? 0, (starts[end - 1] ?? 0) + (lines[end - 1] ?? "").length]);
			i = end;
			continue;
		}
		if (((lines[i] ?? "").match(/```/g) ?? []).length % 2 === 1) inFence = !inFence;
		i++;
	}
	return spans;
}
