import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { newestSessionFile } from "../omp/session-heal";
import { isRecord } from "../omp/type-guards";
import { redact } from "../redact";
import { readJsonlRecords } from "./trace-transcript";

/**
 * One conversation's omp session for the dashboard's 대화 tab, in the shape `renderConversation` draws: the user's
 * messages, the model's text and thinking, and each tool call with its result. Every string is masked. Read-only (one
 * `readonly` database handle, the session files read whole on every request, nothing cached).
 */

/** Dialog turns (a user message up to the next one) per page. */
export const CONVERSATION_PAGE = 20;
const OUTPUT_CHARS = 4000;
const SUMMARY_CHARS = 120;
/** A sub-agent's last answer, appended to its `task` call's output, is cut to this. */
const SUB_AGENT_CHARS = 1000;

export type ConversationPart =
	| { kind: "text" | "thinking"; text: string }
	| { kind: "tool"; name: string; summary: string; output: string; error: boolean; running?: true };

export interface ConversationTurn {
	role: "user" | "assistant";
	/** Epoch ms of the turn's first record. */
	ts: number;
	parts: ConversationPart[];
}

export type ConversationError = "no_database" | "unknown_origin" | "no_session";

export type ThreadConversation =
	| { ok: true; turns: ConversationTurn[]; cursor?: string }
	| { ok: false; error: ConversationError };

type Json = Record<string, unknown>;

const timeOf = (entry: Json): number => Date.parse(typeof entry.timestamp === "string" ? entry.timestamp : "");
const messageOf = (entry: Json): Json | undefined =>
	entry.type === "message" && isRecord(entry.message) ? entry.message : undefined;
/** Masked first, then cut: a secret is never left half-visible by the cut. */
const cut = (text: string, limit: number): string => {
	const masked = redact(text);
	return masked.length > limit ? masked.slice(0, limit) : masked;
};
const contentOf = (message: Json): unknown[] =>
	Array.isArray(message.content)
		? message.content
		: typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: [];
const textOf = (message: Json): string =>
	contentOf(message)
		.filter((part): part is Json => isRecord(part) && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n");

/** A `task` call's agent names in `tasks` order. */
const taskNames = (call: Json): string[] =>
	isRecord(call.arguments) && Array.isArray(call.arguments.tasks)
		? call.arguments.tasks.flatMap((task) => (isRecord(task) && typeof task.name === "string" ? [task.name] : []))
		: [];

interface TaskCall {
	id: string;
	at: number;
	names: string[];
}

/**
 * Sub-agents of the session (`<stem>/<name>.jsonl`) each matched to one `task` call: of the calls naming it, the
 * latest one started no later than the sub-agent's first record. Only the sub-agent's last assistant text is kept;
 * files no call names are left out.
 */
function subAgentAnswers(stem: string, calls: TaskCall[]): Map<string, Array<{ name: string; text: string }>> {
	const answers = new Map<string, Array<{ name: string; text: string }>>();
	if (calls.length === 0 || !existsSync(stem)) return answers;
	const named = new Set(calls.flatMap((call) => call.names));
	for (const file of readdirSync(stem)) {
		if (!file.endsWith(".jsonl")) continue;
		const name = file.slice(0, -".jsonl".length);
		if (!named.has(name)) continue;
		const entries = readJsonlRecords(join(stem, file));
		const start = entries.map(timeOf).find((at) => !Number.isNaN(at));
		if (start === undefined) continue;
		let owner: TaskCall | undefined;
		for (const call of calls) {
			if (call.names.includes(name) && call.at <= start && (owner === undefined || call.at >= owner.at)) owner = call;
		}
		if (owner === undefined) continue;
		let last = "";
		for (const entry of entries) {
			const message = messageOf(entry);
			if (message?.role !== "assistant") continue;
			const text = textOf(message);
			if (text.trim() !== "") last = text;
		}
		if (last === "") continue;
		const list = answers.get(owner.id) ?? [];
		list.push({ name, text: last });
		answers.set(owner.id, list);
	}
	// `tasks` order within each call.
	for (const call of calls) {
		answers.get(call.id)?.sort((a, b) => call.names.indexOf(a.name) - call.names.indexOf(b.name));
	}
	return answers;
}

/** A dialog turn: the user message that opened it (absent for what precedes the first one) and what followed. */
interface Dialog {
	firstId: string;
	user?: { at: number; message: Json };
	rest: Array<{ at: number; message: Json }>;
}

/** One session file as dialog turns, a page of {@link CONVERSATION_PAGE} ending before entry `before` (or at the end). */
export function readSessionConversation(file: string, before?: string): Extract<ThreadConversation, { ok: true }> {
	const entries = readJsonlRecords(file);
	const dialogs: Dialog[] = [];
	const results = new Map<string, Json>();
	const calls: TaskCall[] = [];
	entries.forEach((entry, index) => {
		const message = messageOf(entry);
		const at = timeOf(entry);
		if (message === undefined || Number.isNaN(at)) return;
		const id = typeof entry.id === "string" ? entry.id : `#${index}`;
		if (message.role === "user") {
			dialogs.push({ firstId: id, user: { at, message }, rest: [] });
			return;
		}
		if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			results.set(message.toolCallId, message);
			return;
		}
		if (message.role !== "assistant") return;
		if (dialogs.length === 0) dialogs.push({ firstId: id, rest: [] });
		dialogs[dialogs.length - 1]?.rest.push({ at, message });
		for (const part of contentOf(message)) {
			if (isRecord(part) && part.type === "toolCall" && part.name === "task" && typeof part.id === "string") {
				calls.push({ id: part.id, at, names: taskNames(part) });
			}
		}
	});
	const end = before === undefined ? dialogs.length : dialogs.findIndex((dialog) => dialog.firstId === before);
	const stop = end < 0 ? 0 : end;
	const startAt = Math.max(0, stop - CONVERSATION_PAGE);
	const page = dialogs.slice(startAt, stop);
	const pageCalls = new Set(
		page.flatMap((dialog) =>
			dialog.rest.flatMap(({ message }) =>
				contentOf(message).flatMap((part) => (isRecord(part) && typeof part.id === "string" ? [part.id] : [])),
			),
		),
	);
	const subs = subAgentAnswers(
		file.replace(/\.jsonl$/, ""),
		calls.filter((call) => pageCalls.has(call.id)),
	);

	const toolPart = (call: Json): ConversationPart => {
		const name = typeof call.name === "string" ? call.name : "tool";
		const args = isRecord(call.arguments) ? call.arguments : {};
		// omp records the intent beside the args (`intent`); older records only have it as the `i` argument.
		const intent =
			typeof call.intent === "string" && call.intent.trim() !== ""
				? call.intent
				: typeof args.i === "string" && args.i.trim() !== ""
					? args.i
					: undefined;
		const summary = cut(intent ?? JSON.stringify(args).replace(/\s+/g, " "), SUMMARY_CHARS);
		const result = typeof call.id === "string" ? results.get(call.id) : undefined;
		if (result === undefined) return { kind: "tool", name, summary, output: "", error: false, running: true };
		const appended = (typeof call.id === "string" ? (subs.get(call.id) ?? []) : [])
			.map(({ name: agent, text }) => `\n\n— ${agent}\n${cut(text, SUB_AGENT_CHARS)}`)
			.join("");
		return {
			kind: "tool",
			name,
			summary,
			output: `${cut(textOf(result), Math.max(0, OUTPUT_CHARS - appended.length))}${appended}`,
			error: result.isError === true,
		};
	};
	const turns: ConversationTurn[] = [];
	for (const dialog of page) {
		if (dialog.user !== undefined) {
			const text = textOf(dialog.user.message);
			turns.push({
				role: "user",
				ts: dialog.user.at,
				parts: text === "" ? [] : [{ kind: "text", text: redact(text) }],
			});
		}
		const parts: ConversationPart[] = [];
		for (const { message } of dialog.rest) {
			for (const part of contentOf(message)) {
				if (!isRecord(part)) continue;
				if (part.type === "text" && typeof part.text === "string" && part.text.trim() !== "") {
					parts.push({ kind: "text", text: redact(part.text) });
				} else if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim() !== "") {
					parts.push({ kind: "thinking", text: redact(part.thinking) });
				} else if (part.type === "toolCall") {
					parts.push(toolPart(part));
				}
			}
		}
		const first = dialog.rest[0];
		if (first !== undefined && parts.length > 0) turns.push({ role: "assistant", ts: first.at, parts });
	}
	const cursor = startAt > 0 ? page[0]?.firstId : undefined;
	return { ok: true, turns, ...(cursor === undefined ? {} : { cursor }) };
}

/**
 * The conversation of origin `originKey`: its current session file (`origins.session_file`, else the newest
 * `*.jsonl` of its `session_dir`, as the trace finds it), a page ending before entry `before`.
 */
export function readThreadConversation(homeDir: string, originKey: string, before?: string): ThreadConversation {
	const dbPath = join(homeDir, "ompbot.db");
	if (!existsSync(dbPath)) return { ok: false, error: "no_database" };
	const db = new Database(dbPath, { readonly: true, strict: true });
	let origin: { session_dir: string; session_file: string | null } | null;
	try {
		origin = db
			.query<{ session_dir: string; session_file: string | null }, [string]>(
				"SELECT session_dir, session_file FROM origins WHERE origin_key = ?",
			)
			.get(originKey);
	} finally {
		db.close();
	}
	if (origin === null) return { ok: false, error: "unknown_origin" };
	const file =
		origin.session_file ?? (existsSync(origin.session_dir) ? newestSessionFile(origin.session_dir) : undefined);
	if (file === undefined || !existsSync(file)) return { ok: false, error: "no_session" };
	return readSessionConversation(file, before);
}
