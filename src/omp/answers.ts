import { redact } from "../redact";
import { entryText, type OmpEntry } from "./driver";

/** Turn-end body when the turn had no answer at all. */
export const NO_ANSWER = "(응답 없음)";
/** Turn-end body when every answer of the turn already went out as an interim delivery: it only closes the status. */
export const INTERIM_CLOSING = "✅ 위 답으로 마칩니다";

/**
 * Texts of the turn's stop-ended assistant messages, in order. A todo reminder or a steered message can continue a
 * turn that already ended with an answer, so one turn may hold several; text before a tool call (`toolUse`) and
 * non-assistant messages are left out, and an answer that nearly repeats the one right before it replaces it (the later
 * one is the latest wording), so a reminder-continued turn that re-writes its report sends it once.
 */
export function turnAnswerParts(entries: readonly OmpEntry[]): string[] {
	const parts: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "assistant" || entry.message.stopReason !== "stop")
			continue;
		const text = entryText(entry);
		if (text.trim() === "") continue;
		const previous = parts.at(-1);
		if (previous !== undefined && nearlySame(previous, text)) parts.pop();
		parts.push(text);
	}
	return parts;
}

/** Shortest status note (characters of the trimmed text) next to a `wait` call that is sent while the turn runs. */
export const WAIT_NOTE_MIN_CHARS = 20;

/**
 * What a finished assistant message (omp `message_end` payload) of a running turn has for the owner: a stop-ended
 * answer (`answer`), or a note of at least {@link WAIT_NOTE_MIN_CHARS} characters written in the same message as a
 * `wait` call (`waitNote`: status while blocking, answers to owner messages steered in meanwhile). Text is extracted
 * like `entryText`: text blocks only, verbatim.
 */
export function interimOf(message: unknown): { kind: "answer" | "waitNote"; text: string } | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const { role, content, stopReason } = message as { role?: unknown; content?: unknown; stopReason?: unknown };
	if (role !== "assistant") return undefined;
	const text = entryText({ id: "", type: "message", message: { content } });
	if (stopReason === "stop") return text.trim() === "" ? undefined : { kind: "answer", text };
	if (stopReason !== "toolUse" || !Array.isArray(content)) return undefined;
	const waits = content.some(
		(part) => typeof part === "object" && part !== null && part.type === "toolCall" && part.name === "wait",
	);
	return waits && Array.from(text.trim()).length >= WAIT_NOTE_MIN_CHARS ? { kind: "waitNote", text } : undefined;
}

/** Whether `text` already went out as one of `sent`: equal up to whitespace, or {@link nearlySame}. */
export function alreadySent(text: string, sent: readonly string[]): boolean {
	return sent.some((body) => nearlySame(body, text));
}

/**
 * Turn-end delivery of a turn whose answer parts are `parts` and whose interim deliveries carried `sent`: the parts
 * not already sent joined by a blank line; {@link INTERIM_CLOSING} when everything went out early (that delivery
 * finishes the thread's status); {@link NO_ANSWER} for a turn with neither. `sent` holds stored (masked) bodies, so a
 * part is also compared masked. `whole` is every part (the body when there is none), for the decisions that look at
 * the turn's full answer (log-channel copy, steered-thread pointers).
 */
export function closingAnswer(parts: readonly string[], sent: readonly string[]): { body: string; whole: string } {
	const left = parts.filter((part) => !alreadySent(part, sent) && !alreadySent(redact(part), sent));
	const body = left.length > 0 ? left.join("\n\n") : sent.length > 0 ? INTERIM_CLOSING : NO_ANSWER;
	return { body, whole: parts.length > 0 ? parts.join("\n\n") : body };
}

/** Dice coefficient of character bigrams at or above which two answers count as the same answer re-written. */
const NEAR_DUPLICATE_DICE = 0.9;

/** Whether two answers are the same up to whitespace or a small edit (bigram Dice ≥ {@link NEAR_DUPLICATE_DICE}). */
function nearlySame(a: string, b: string): boolean {
	const x = a.replace(/\s+/g, " ").trim();
	const y = b.replace(/\s+/g, " ").trim();
	if (x === y) return true;
	if (x.length < 2 || y.length < 2) return false;
	const counts = new Map<string, number>();
	for (let i = 0; i < x.length - 1; i++) {
		const bigram = x.slice(i, i + 2);
		counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
	}
	let shared = 0;
	for (let i = 0; i < y.length - 1; i++) {
		const bigram = y.slice(i, i + 2);
		const left = counts.get(bigram) ?? 0;
		if (left > 0) {
			shared++;
			counts.set(bigram, left - 1);
		}
	}
	return (2 * shared) / (x.length - 1 + (y.length - 1)) >= NEAR_DUPLICATE_DICE;
}
