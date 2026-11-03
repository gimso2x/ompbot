import { entryText, type OmpEntry } from "./driver";

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

/** The answer of a turn from the entries after its start cursor: every stop-ended answer joined by a blank line. */
export function turnAnswer(entries: readonly OmpEntry[]): string | undefined {
	const parts = turnAnswerParts(entries);
	return parts.length === 0 ? undefined : parts.join("\n\n");
}
