/**
 * Boundary between ompbot and one `omp --mode rpc` child process.
 *
 * One driver instance owns at most one child process and one conversation
 * (`sessionDir`). Implementations: `RpcOmpDriver` (real omp), `ClaudeOmpDriver`
 * (Claude Code CLI as the child) and `FakeOmpDriver` (tests; mirrors the real
 * semantics listed below).
 *
 * Semantics every implementation MUST keep:
 * - `entriesSince(since)` returns the entries strictly after the entry whose id
 *   is `since`, plus the current `leafId`; an unknown `since` rejects with
 *   `OmpDriverError.code === "unknown_since"` (never "all entries").
 * - `entriesSince()` with no cursor returns every entry in append order.
 * - `leafId()` is `null` for a session without entries.
 * - `prompt` resolves with an `opRef` once the prompt is admitted; the turn's
 *   outcome arrives later through `onFinal` carrying the same `opRef`, and
 *   never before `prompt` has resolved.
 */

export type OmpDriverErrorCode =
	| "omp_executable_missing"
	| "bun_missing"
	| "omp_rpc_client_missing"
	| "omp_launcher_standalone"
	| "omp_launcher_unreadable"
	| "bun_too_old"
	| "claude_executable_missing"
	| "claude_not_authenticated"
	| "agy_executable_missing"
	| "invalid_env"
	| "already_started"
	| "not_started"
	| "unknown_since"
	| "rpc_error";

export class OmpDriverError extends Error {
	readonly code: OmpDriverErrorCode;
	/** Machine code reported by omp's RPC server (`error.code`), when the failure came from a command. */
	readonly rpcCode: string | undefined;

	constructor(code: OmpDriverErrorCode, message: string, options?: { rpcCode?: string; cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "OmpDriverError";
		this.code = code;
		this.rpcCode = options?.rpcCode;
	}
}

/** One session entry as returned by `get_entries` (only the fields ompbot relies on are typed). */
export interface OmpEntry {
	id: string;
	parentId?: string | null;
	type: string;
	message?: {
		role?: string;
		content?: unknown;
		stopReason?: string;
		/** Assistant messages: the call's token counts and cost, as omp reports them. */
		usage?: OmpUsage;
		/** Assistant messages: the provider and model that answered. */
		provider?: string;
		model?: string;
	};
	[key: string]: unknown;
}

/** Token counts (and cost in dollars) of one assistant call (omp `Usage`; only the fields ompbot reads are typed). */
export interface OmpUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { cacheWrite?: number; total?: number };
}

export interface OmpEntries {
	entries: OmpEntry[];
	leafId: string | null;
}

/** Plain text of a message entry (text parts joined); `""` for entries without text. */
export function entryText(entry: OmpEntry): string {
	const content = entry.message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const part of content) {
		if (typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part) {
			text += String(part.text ?? "");
		}
	}
	return text;
}

/** Event forwarded from the child: omp agent events plus `extension_ui_request` frames seen on the wire. */
export interface OmpEvent {
	type: string;
	[key: string]: unknown;
}

/** One question of an omp `ask` dialog (`RpcAskDialogQuestion`, omp 18.16 rpc-types.ts). */
export interface OmpAskQuestion {
	id: string;
	question: string;
	header?: string;
	options: Array<{ label: string; description?: string }>;
	multi?: boolean;
	/** Index of the option omp answers with when the dialog times out. */
	recommended?: number;
}

/** A dialog omp asks the host to answer (`extension_ui_request` with an owner-answerable method). */
export type OmpDialogRequest =
	| { method: "select"; id: string; title: string; options: string[]; timeout?: number }
	| { method: "confirm"; id: string; title: string; message: string; timeout?: number }
	| { method: "input"; id: string; title: string; placeholder?: string; timeout?: number; secret?: boolean }
	| { method: "editor"; id: string; title: string; prefill?: string }
	| { method: "ask"; id: string; questions: OmpAskQuestion[]; timeout?: number };

/** The body of the `extension_ui_response` frame that answers an `OmpDialogRequest`. */
export type OmpDialogResponse =
	| { value: string }
	| { confirmed: boolean }
	| { cancelled: true; timedOut?: boolean }
	| { answers: Array<{ id: string; selectedOptions: string[]; customInput?: string }> };

/**
 * Answers one omp dialog for the owner. `signal` aborts when omp withdraws the dialog (its own timeout or an aborted
 * turn); the answer is then dropped. `undefined` or a throw is answered `cancelled` (fail-closed).
 */
export type OmpDialogAnswerer = (
	request: OmpDialogRequest,
	signal: AbortSignal,
) => Promise<OmpDialogResponse | undefined>;

export interface OmpFinal {
	/** Id returned by the `prompt` call that started the turn. */
	opRef: string;
	status: "completed" | "aborted" | "error";
	/** Final assistant text of the session at turn end; `""` when there is none. */
	text: string;
	error?: string;
}

export interface OmpState {
	sessionId: string;
	sessionFile?: string;
	/** Nothing is streaming or compacting. */
	idle: boolean;
	/** Idle and nothing queued or pending (omp `isSettled`). */
	settled: boolean;
	queuedMessageCount: number;
	messageCount: number;
	/** `provider/id` of the active model. */
	model?: string;
	thinking?: string;
}

export interface OmpCompactResult {
	tokensBefore: number;
	summary: string;
}

export interface OmpOpenResult {
	resumed: boolean;
	sessionId: string;
}

/** One task of an omp task list (omp wire `TodoItem`: `content` and `status` are both required). */
export interface TodoItem {
	content: string;
	status: "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
}

/** One phase of an omp task list (omp wire `TodoPhase`, the `set_todos` RPC payload). */
export interface TodoPhase {
	name: string;
	tasks: TodoItem[];
}

export interface OmpExitInfo {
	code: number | null;
	/** True when `stop()` was requested; false means the child died on its own. */
	expected: boolean;
	stderr: string;
}

export interface OmpSessionDriver {
	/** Spawn the child. Fails fast with `omp_executable_missing` / `bun_missing`. */
	start(): Promise<void>;
	/** Admit a prompt while idle. Returns the `opRef` that `onFinal` will carry. */
	prompt(text: string): Promise<string>;
	/** Queue a steering message into the running turn. */
	steer(text: string): Promise<void>;
	abort(): Promise<void>;
	newSession(): Promise<{ cancelled: boolean }>;
	/** Continue the newest session in this driver's `sessionDir` (or start a fresh one). */
	openSession(): Promise<OmpOpenResult>;
	/** Open a specific session file (`/resume-ompbot`). */
	switchSession(sessionFile: string): Promise<{ cancelled: boolean }>;
	/** Models omp can use (`provider/id`). */
	availableModels(): Promise<string[]>;
	/** Switch the session's model (not persisted to omp settings). Rejects for an unknown model. Returns `provider/id`. */
	setModel(model: string): Promise<string>;
	/** Thinking levels the active model accepts. */
	thinkingLevels(): Promise<string[]>;
	setThinking(level: string): Promise<void>;
	/**
	 * Replaces the session's task list (omp RPC `set_todos`). Drivers without omp todos (Claude, agy) resolve without
	 * doing anything and log `set_todos_unsupported`; the caller never treats that as a failure.
	 */
	setTodos(phases: TodoPhase[]): Promise<void>;
	/** Summarize older context while idle. */
	compact(instructions?: string): Promise<OmpCompactResult>;
	state(): Promise<OmpState>;
	/** Current cursor (`get_entries.leafId`); `null` for an empty session. */
	leafId(): Promise<string | null>;
	entriesSince(since?: string): Promise<OmpEntries>;
	onFinal(listener: (final: OmpFinal) => void): () => void;
	onEvent(listener: (event: OmpEvent) => void): () => void;
	onExit(listener: (info: OmpExitInfo) => void): () => void;
	stop(): Promise<void>;
	/**
	 * Ask a side question against the current conversation without touching the running turn or the session
	 * history; resolves with the answer text. Absent on drivers that cannot (the mailbox then says so).
	 */
	btw?(question: string): Promise<string>;
}
