import {
	type OmpCompactResult,
	OmpDriverError,
	type OmpEntries,
	type OmpEntry,
	type OmpEvent,
	type OmpExitInfo,
	type OmpFinal,
	type OmpOpenResult,
	type OmpSessionDriver,
	type OmpState,
} from "./driver";

/** A fresh real omp session already holds entries (model_change, thinking_level_change, ...), so its leafId is never null. */
function seedEntries(): OmpEntry[] {
	return [
		{ id: "e1", parentId: null, type: "model_change" },
		{ id: "e2", parentId: "e1", type: "thinking_level_change" },
	];
}

/** Conversation storage shared between fake drivers, so stop/start + openSession resumes like a real sessionDir. */
export class FakeSessionStore {
	readonly sessions = new Map<string, { sessionId: string; entries: OmpEntry[]; nextId: number }>();
	/**
	 * Prompt op-ref counter shared by every driver on this store. Real omp op refs (`<child>:req_<n>`) never
	 * repeat across children, so a session change that starts a new child (per-epoch monitor fires, `/new`,
	 * resume) keeps op refs — and the (origin, op_ref) keys built on them — collision-free here too.
	 */
	#prompts = 0;

	nextOpRefNumber(): number {
		return ++this.#prompts;
	}

	open(sessionDir: string): { sessionId: string; entries: OmpEntry[]; nextId: number; resumed: boolean } {
		const existing = this.sessions.get(sessionDir);
		if (existing) return { ...existing, resumed: true };
		const created = { sessionId: `fake-session-${this.sessions.size + 1}`, entries: seedEntries(), nextId: 3 };
		this.sessions.set(sessionDir, created);
		return { ...created, resumed: false };
	}
}

export interface FakeOmpDriverOptions {
	sessionDir?: string;
	store?: FakeSessionStore;
	/** Produces the assistant text for a turn from the prompt and the steer messages received during it. */
	respond?: (prompt: string, steers: readonly string[]) => string;
	/** Keep every turn running until `release()` / `abort()` so tests can steer deterministically. */
	holdTurns?: boolean;
	/** Make `start()` fail (e.g. `omp_executable_missing`). */
	startError?: OmpDriverError;
	/** Models `availableModels` reports and `setModel` accepts; the first is active at start. */
	models?: readonly string[];
	/** Active model at start, overriding `models[0]` — may be absent from `models`, like a session restored with a model the provider removed. */
	restoredModel?: string;
	/** Emitted in order right after each turn starts, before `toolCalls` (omp payload shape, e.g. `auto_retry_start`). */
	events?: readonly OmpEvent[];
	/** Reported as `tool_execution_start` events right after each turn starts (omp payload shape). */
	toolCalls?: readonly { name: string; args?: unknown }[];
	/**
	 * Messages a completed turn appends instead of the single `respond` reply, e.g. stop answer -> developer todo
	 * reminder -> toolUse -> toolResult -> stop answer. `onFinal.text` is the last assistant text, like real omp.
	 */
	script?: (prompt: string, steers: readonly string[]) => readonly FakeTurnMessage[];
}

/** One message of a scripted turn (`FakeOmpDriverOptions.script`). */
export interface FakeTurnMessage {
	role: "assistant" | "developer" | "toolResult";
	text: string;
	/** Assistant messages only: `"stop"` ends the turn's answer, `"toolUse"` precedes a tool call. */
	stopReason?: "stop" | "toolUse";
}

export const FAKE_MODELS = ["fake/alpha", "fake/beta"] as const;
export const FAKE_THINKING_LEVELS = ["off", "low", "medium", "high"] as const;

interface ActiveTurn {
	opRef: string;
	prompt: string;
	steers: string[];
	release: () => void;
	abort: () => void;
}

/**
 * Test double mirroring the real driver's observable semantics: entry ids and
 * `leafId`, `entriesSince` strictness (unknown cursor rejects with
 * `unknown_since`, never "everything"), `onFinal` strictly after `prompt`
 * resolves, one turn at a time, and process exit via `crash()`.
 */
export class FakeOmpDriver implements OmpSessionDriver {
	readonly #options: FakeOmpDriverOptions;
	readonly #store: FakeSessionStore;
	readonly #sessionDir: string;
	#started = false;
	#current: { sessionId: string; entries: OmpEntry[]; nextId: number } | undefined;
	#turn: ActiveTurn | undefined;
	#opCounter = 0;
	#model: string;
	#thinking = "medium";
	readonly #finalListeners = new Set<(final: OmpFinal) => void>();
	readonly #eventListeners = new Set<(event: OmpEvent) => void>();
	readonly #exitListeners = new Set<(info: OmpExitInfo) => void>();

	/** Recorded calls, for mailbox tests: "prompt:<text>", "steer:<text>", "abort", "newSession", "openSession". */
	readonly calls: string[] = [];

	constructor(options: FakeOmpDriverOptions = {}) {
		this.#options = options;
		this.#store = options.store ?? new FakeSessionStore();
		this.#sessionDir = options.sessionDir ?? "fake-session-dir";
		this.#model = options.restoredModel ?? (options.models ?? FAKE_MODELS)[0] ?? "fake/alpha";
	}

	async start(): Promise<void> {
		if (this.#options.startError) throw this.#options.startError;
		if (this.#started) throw new OmpDriverError("already_started", "driver already started");
		this.#started = true;
		// Like real omp: `--session-dir` binds the newest session of the directory at startup.
		this.#store.open(this.#sessionDir);
		this.#current = this.#store.sessions.get(this.#sessionDir);
	}

	#require(): { sessionId: string; entries: OmpEntry[]; nextId: number } {
		if (!this.#started || !this.#current) throw new OmpDriverError("not_started", "driver not started");
		return this.#current;
	}

	#append(entry: Pick<OmpEntry, "type" | "message">): OmpEntry {
		const session = this.#require();
		const parent = session.entries.at(-1);
		const full: OmpEntry = { ...entry, id: `e${session.nextId++}`, parentId: parent?.id ?? null };
		session.entries.push(full);
		return full;
	}

	#emit(event: OmpEvent): void {
		for (const listener of this.#eventListeners) listener(event);
	}

	#emitFinal(final: OmpFinal): void {
		for (const listener of this.#finalListeners) listener(final);
	}

	async prompt(text: string): Promise<string> {
		this.#require();
		if (this.#turn) throw new OmpDriverError("rpc_error", "agent is already processing a prompt", { rpcCode: "busy" });
		this.calls.push(`prompt:${text}`);
		this.#opCounter += 1;
		const opRef = `fake_req_${this.#store.nextOpRefNumber()}`;
		this.#append({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
		const gate = Promise.withResolvers<"release" | "abort">();
		const turn: ActiveTurn = {
			opRef,
			prompt: text,
			steers: [],
			release: () => gate.resolve("release"),
			abort: () => gate.resolve("abort"),
		};
		this.#turn = turn;
		void (async () => {
			// Never settle before `prompt()` has resolved (same guarantee as the real driver).
			await Promise.resolve();
			this.#emit({ type: "agent_start" });
			if (this.#options.events?.length) {
				// Same macrotask hop as the tool calls: the mailbox records the turn after `prompt()` resolves.
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				for (const event of this.#options.events) this.#emit(event);
			}
			for (const [i, call] of (this.#options.toolCalls ?? []).entries()) {
				// The real child reports tool calls over the socket only after the prompt RPC round trip (and any
				// driver-wrapper continuations) has settled; a macrotask hop guarantees the mailbox recorded the turn.
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				this.#emit({
					type: "tool_execution_start",
					toolCallId: `${opRef}-call-${i}`,
					toolName: call.name,
					...(call.args === undefined ? {} : { args: call.args }),
				});
			}
			const outcome = this.#options.holdTurns ? await gate.promise : "release";
			if (this.#turn !== turn) return;
			this.#turn = undefined;
			this.#emit({ type: "agent_end" });
			if (outcome === "abort") {
				this.#emitFinal({ opRef, status: "aborted", text: "" });
				return;
			}
			if (this.#options.script) {
				let last = "";
				for (const step of this.#options.script(text, turn.steers)) {
					const content = [{ type: "text", text: step.text }];
					this.#append({
						type: "message",
						message: step.stopReason
							? { role: step.role, content, stopReason: step.stopReason }
							: { role: step.role, content },
					});
					if (step.role === "assistant" && step.text !== "") last = step.text;
				}
				this.#emitFinal({ opRef, status: "completed", text: last });
				return;
			}
			const reply = this.#options.respond
				? this.#options.respond(text, turn.steers)
				: `ECHO ${[text, ...turn.steers].join(" | ")}`;
			this.#append({
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: reply }], stopReason: "stop" },
			});
			this.#emitFinal({ opRef, status: "completed", text: reply });
		})();
		return opRef;
	}

	async steer(text: string): Promise<void> {
		this.#require();
		this.calls.push(`steer:${text}`);
		// Real omp accepts steer while idle without error (probed 2026-10-19: it then starts a run that
		// makes the next `prompt` fail with "already processing"). The fake only records the message.
		this.#turn?.steers.push(text);
		this.#append({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
	}

	async abort(): Promise<void> {
		this.#require();
		this.calls.push("abort");
		this.#turn?.abort();
	}

	/** Test control: finish a held turn normally. */
	release(): void {
		this.#turn?.release();
	}

	async newSession(): Promise<{ cancelled: boolean }> {
		this.#require();
		this.calls.push("newSession");
		const created = {
			sessionId: `fake-session-${this.#store.sessions.size + 1}-${this.#opCounter}`,
			entries: seedEntries(),
			nextId: 3,
		};
		this.#store.sessions.set(this.#sessionDir, created);
		this.#current = created;
		return { cancelled: false };
	}

	async openSession(): Promise<OmpOpenResult> {
		this.#require();
		this.calls.push("openSession");
		const opened = this.#store.open(this.#sessionDir);
		this.#current = this.#store.sessions.get(this.#sessionDir);
		return { resumed: opened.resumed, sessionId: opened.sessionId };
	}

	/** Like omp's `switch_session`: binds the session stored under that file path (created on first use). */
	async switchSession(sessionFile: string): Promise<{ cancelled: boolean }> {
		this.#require();
		this.calls.push(`switchSession:${sessionFile}`);
		this.#store.open(sessionFile);
		this.#current = this.#store.sessions.get(sessionFile);
		return { cancelled: false };
	}

	async availableModels(): Promise<string[]> {
		this.#require();
		return [...(this.#options.models ?? FAKE_MODELS)];
	}

	async setModel(model: string): Promise<string> {
		this.#require();
		if (!(this.#options.models ?? FAKE_MODELS).includes(model)) {
			throw new OmpDriverError("rpc_error", `Model not found: ${model}`);
		}
		this.calls.push(`setModel:${model}`);
		this.#model = model;
		this.#append({ type: "model_change" });
		return model;
	}

	async thinkingLevels(): Promise<string[]> {
		this.#require();
		return [...FAKE_THINKING_LEVELS];
	}

	async setThinking(level: string): Promise<void> {
		this.#require();
		this.calls.push(`setThinking:${level}`);
		this.#thinking = level;
		this.#append({ type: "thinking_level_change" });
	}

	async compact(instructions?: string): Promise<OmpCompactResult> {
		const session = this.#require();
		if (this.#turn) throw new OmpDriverError("rpc_error", "cannot compact while streaming");
		this.calls.push(instructions === undefined ? "compact" : `compact:${instructions}`);
		const tokensBefore = session.entries.length * 100;
		this.#append({ type: "compaction" });
		return { tokensBefore, summary: `summary of ${session.entries.length - 1} entries` };
	}

	async state(): Promise<OmpState> {
		const session = this.#require();
		const busy = this.#turn !== undefined;
		return {
			sessionId: session.sessionId,
			idle: !busy,
			settled: !busy,
			queuedMessageCount: 0,
			messageCount: session.entries.length,
			model: this.#model,
			thinking: this.#thinking,
		};
	}

	async leafId(): Promise<string | null> {
		return (await this.entriesSince(undefined)).leafId;
	}

	async entriesSince(since?: string): Promise<OmpEntries> {
		const session = this.#require();
		const leafId = session.entries.at(-1)?.id ?? null;
		if (since === undefined) return { entries: [...session.entries], leafId };
		const index = session.entries.findIndex((entry) => entry.id === since);
		if (index === -1)
			throw new OmpDriverError("unknown_since", `Unknown entries cursor: ${since}`, { rpcCode: "unknown_since" });
		return { entries: session.entries.slice(index + 1), leafId };
	}

	onFinal(listener: (final: OmpFinal) => void): () => void {
		this.#finalListeners.add(listener);
		return () => this.#finalListeners.delete(listener);
	}

	onEvent(listener: (event: OmpEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	onExit(listener: (info: OmpExitInfo) => void): () => void {
		this.#exitListeners.add(listener);
		return () => this.#exitListeners.delete(listener);
	}

	/** Test control: the child dies mid-turn; no final is ever emitted for the running turn. */
	crash(code = 1): void {
		this.#turn = undefined;
		this.#started = false;
		for (const listener of this.#exitListeners) listener({ code, expected: false, stderr: "fake crash" });
	}

	async stop(): Promise<void> {
		if (!this.#started) return;
		this.#started = false;
		this.#turn = undefined;
		for (const listener of this.#exitListeners) listener({ code: 0, expected: true, stderr: "" });
	}
}
