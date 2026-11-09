import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../omp/type-guards";
import { redact } from "../redact";
import type { TraceSpan } from "./trace";

/**
 * An omp session transcript (`<session>.jsonl`, sub-agents in `<session>/<name>.jsonl`) as spans on a turn's clock.
 * Of its text only the tool's intent line (`i`), a failed tool's first output and a failed model call's error leave,
 * masked and cut.
 */

/** Spans kept per transcript (the newest ones); a longer turn says `truncated`. */
const SPAN_LIMIT = 400;
/** Sub-agents of sub-agents are read this deep. */
const DEPTH_LIMIT = 2;
const DETAIL_CHARS = 60;
const ERROR_CHARS = 160;

type Json = Record<string, unknown>;
const num = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;
const text = (value: unknown, limit: number): string | undefined => {
	if (typeof value !== "string") return undefined;
	const line = redact(value).replace(/\s+/g, " ").trim();
	if (line === "") return undefined;
	return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};

/** The part of the session that belongs to the turn. */
export interface TranscriptWindow {
	from: number;
	to: number;
	/** The turn is still dispatched: open spans run into "now". */
	live: boolean;
	/** The turn's dispatch: every span time counts from here. */
	origin: number;
}

/** Where a transcript sits: 0 = the turn's own session; `prefix` keeps a sub-agent's entry ids apart from its parent's. */
interface Scope {
	depth: number;
	prefix: string;
}

export interface Transcript {
	spans: TraceSpan[];
	first?: number;
	/** The last message inside the window. */
	lastIn?: number | undefined;
	model?: string;
	/** Its last model call ended the conversation (`stop`) or failed (`error`/`aborted`). */
	ending?: "stop" | "failed";
	truncated: boolean;
}

function lines(file: string): Json[] {
	const out: Json[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line === "") continue;
		try {
			const entry: unknown = JSON.parse(line);
			if (isRecord(entry)) out.push(entry);
		} catch (error) {
			// The line omp is writing right now; the next read has it whole.
			if (error instanceof SyntaxError) continue;
			throw error;
		}
	}
	return out;
}

/** A model call: from its request to its `completedAt` (the record's own time when that is missing). */
function modelSpan(message: Json, at: number, origin: number): Omit<TraceSpan, "id"> {
	const usage = isRecord(message.usage) ? message.usage : {};
	const calls = Array.isArray(message.content)
		? message.content.filter((part) => isRecord(part) && part.type === "toolCall").map((part) => String(part.name))
		: [];
	const failed = message.stopReason === "error" || message.stopReason === "aborted";
	const end = num(message.completedAt) ?? at;
	const model = typeof message.model === "string" ? message.model : "model";
	const tokensIn = (num(usage.input) ?? 0) + (num(usage.cacheRead) ?? 0) + (num(usage.cacheWrite) ?? 0);
	const cost = isRecord(usage.cost) ? num(usage.cost.total) : undefined;
	const error = failed ? text(message.errorMessage, ERROR_CHARS) : undefined;
	return {
		name: model,
		kind: "llm",
		status: failed ? "failed" : "done",
		start: (num(message.timestamp) ?? end - (num(message.duration) ?? 0)) - origin,
		end: end - origin,
		model,
		...(calls.length > 0
			? { detail: `→ ${calls.join(" · ")}` }
			: message.stopReason === "stop"
				? { detail: "답변" }
				: {}),
		...(tokensIn > 0 ? { tokensIn } : {}),
		...(num(usage.output) === undefined ? {} : { tokensOut: num(usage.output) }),
		...(cost === undefined ? {} : { cost }),
		...(error === undefined ? {} : { error }),
	};
}

/** One transcript's spans inside the window, with its sub-agents (the `<stem>/*.jsonl` beside it) as children. */
export function readTranscript(
	file: string,
	window: TranscriptWindow,
	scope: Scope = { depth: 0, prefix: "" },
): Transcript {
	const { origin } = window;
	const result: Transcript = { spans: [], truncated: false };
	const calls = new Map<string, TraceSpan>();
	let tail: "model" | "other" = "other";
	/** The last message inside the window: where an unanswered tool call stops and the next model call starts. */
	let lastIn: number | undefined;
	for (const entry of lines(file)) {
		const at = Date.parse(typeof entry.timestamp === "string" ? entry.timestamp : "");
		if (Number.isNaN(at)) continue;
		result.first ??= at;
		if (entry.type === "model_change" && typeof entry.model === "string") result.model = entry.model;
		if (at < window.from || at > window.to) continue;
		const message = entry.type === "message" && isRecord(entry.message) ? entry.message : undefined;
		if (message === undefined) continue;
		lastIn = at;
		if (message.role === "assistant") {
			const span: TraceSpan = {
				id: `${scope.prefix}${typeof entry.id === "string" ? entry.id : `m${result.spans.length}`}`,
				...modelSpan(message, at, origin),
			};
			result.spans.push(span);
			result.ending = message.stopReason === "stop" ? "stop" : span.status === "failed" ? "failed" : undefined;
			tail = "model";
			for (const part of Array.isArray(message.content) ? message.content : []) {
				if (!isRecord(part) || part.type !== "toolCall" || typeof part.id !== "string") continue;
				const intent = isRecord(part.arguments) ? text(part.arguments.i, DETAIL_CHARS) : undefined;
				const tool: TraceSpan = {
					id: `${scope.prefix}${part.id}`,
					name: typeof part.name === "string" ? part.name : "tool",
					kind: "tool",
					status: "running",
					start: span.end ?? span.start,
					...(intent === undefined ? {} : { detail: intent }),
				};
				calls.set(part.id, tool);
				result.spans.push(tool);
			}
		} else if (message.role === "toolResult" || message.role === "user") {
			tail = "other";
			const tool = typeof message.toolCallId === "string" ? calls.get(message.toolCallId) : undefined;
			if (tool === undefined) continue;
			tool.end = at - origin;
			tool.status = message.isError === true ? "failed" : "done";
			const first = Array.isArray(message.content) ? message.content.find(isRecord) : undefined;
			const error = tool.status === "failed" ? text(first?.text, ERROR_CHARS) : undefined;
			if (error !== undefined) tool.error = error;
		}
	}
	// A tool call never answered ran out with the turn (an abort, a restart); only a live turn keeps it running.
	for (const tool of calls.values()) {
		if (tool.status === "running" && !window.live) {
			tool.status = "failed";
			tool.end = Math.max(tool.start, (lastIn ?? origin) - origin);
		}
	}
	// omp writes a model call when it ends: after a tool result the next one is being generated right now.
	const waiting = [...calls.values()].some((tool) => tool.status === "running");
	if (window.live && scope.depth === 0 && tail === "other" && !waiting && lastIn !== undefined) {
		const name = result.model ?? "model";
		result.spans.push({
			id: "pending-model",
			name,
			kind: "llm",
			status: "running",
			start: lastIn - origin,
			detail: "응답 생성 중",
		});
	}
	result.lastIn = lastIn;
	if (scope.depth < DEPTH_LIMIT) result.spans.push(...subAgents(file.replace(/\.jsonl$/, ""), window, scope));
	result.spans.sort((a, b) => a.start - b.start);
	if (result.spans.length > SPAN_LIMIT) {
		result.spans = result.spans.slice(-SPAN_LIMIT);
		result.truncated = true;
	}
	return result;
}

/** The sub-agents a transcript started (`<stem>/<name>.jsonl`) that wrote a message inside the window. */
function subAgents(dir: string, window: TranscriptWindow, parent: Scope): TraceSpan[] {
	if (!existsSync(dir)) return [];
	const out: TraceSpan[] = [];
	for (const file of readdirSync(dir).sort()) {
		if (!file.endsWith(".jsonl")) continue;
		const name = file.slice(0, -".jsonl".length);
		const id = `${parent.prefix}agent:${name}`;
		const sub = readTranscript(join(dir, file), window, { depth: parent.depth + 1, prefix: `${id}/` });
		if (sub.first === undefined || sub.lastIn === undefined) continue;
		const running = window.live && sub.ending === undefined;
		out.push({
			id,
			name,
			kind: "subagent",
			status: sub.ending === "failed" ? "failed" : running ? "running" : "done",
			start: Math.max(sub.first, window.from) - window.origin,
			...(running ? {} : { end: sub.lastIn - window.origin }),
			...(sub.model === undefined ? {} : { detail: sub.model, model: sub.model }),
			children: sub.spans,
		});
	}
	return out;
}
