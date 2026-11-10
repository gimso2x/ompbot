import { accessSync, constants, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
	type OmpUsage,
} from "./driver";
import { buildChildEnv } from "./env";
import { isRecord } from "./type-guards";

/*
 * Boundary between ompbot and one Antigravity CLI child process
 * (`agy --input-format stream-json --output-format stream-json -p '' --dangerously-skip-permissions`).
 *
 * Wire protocol (verified against agy 1.5.4/1.5.5, both directions newline-delimited JSON):
 * - out  `{"event":"user","message":{"role":"user","content":"<text>"}}` — one line, one turn. A line written while a
 *        turn runs is queued by agy and answered as a separate turn afterwards (no mid-turn steering).
 * - in   `{"event":"init","conversation_id",…,"init":{"model","cwd",…}}` ~5s after spawn, input or not.
 * - in   `{"event":"step_update","step_update":{"step_index","state":"ACTIVE|DONE","step_type":"user_input|
 *        agent_response|tool","text_delta"?,"tool_name"?,"tool_info"?:{"name","parameters","output"?},"usage"?}}`
 * - in   `{"event":"result","result":{"conversation_id","status":"SUCCESS|ERROR","response","error"?,"usage"}}` ends
 *        the turn.
 * - SIGINT during a turn: agy writes a `status:"ERROR","error":"interrupted"` result and EXITS. The driver reports
 *   the turn `aborted`, swallows that exit, and the next prompt respawns with `--conversation <id>`.
 *
 * `-p ''` is required: a bare `-p` would take the next flag as the prompt. Tools run with
 * `--dangerously-skip-permissions`: headless agy auto-denies any tool that needs a permission prompt, and its allow
 * rules match by prefix only (`command(rm -f)` allows every `rm -f`), so no narrow allow-list exists
 * (doc/plans/agy-agent-driver.md). agy has no `--append-system-prompt`: the system prompt is prepended to the first
 * user message each child process receives.
 *
 * Session continuity: agy stores conversations itself; ompbot pins the conversation per origin epoch with a pointer
 * file (`<sessionDir>/agy-conversation.json`). An unknown `--conversation` id makes agy warn and start a new one.
 */

export const AGY_PROVIDER = "agy";
/** Effort is part of the agy model id (`gemini-3.8-flash-high`); thinking levels swap that suffix. */
export const AGY_THINKING_LEVELS = ["low", "medium", "high"] as const;

const EFFORT_SUFFIX = /-(low|medium|high)$/;
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const ABORT_EXIT_TIMEOUT_MS = 5_000;
const MODELS_TIMEOUT_MS = 30_000;
const STDERR_TAIL_BYTES = 4_000;

export interface AgyOmpDriverOptions {
	/** Path or name of the agy CLI; names resolve on the child PATH. */
	agyExecutable: string;
	cwd: string;
	/** ompbot-owned per-origin-epoch directory; holds the `agy-conversation.json` resume pointer. */
	sessionDir: string;
	/** agy model id without provider prefix (`gemini-3.8-flash-high`); passed as `--model` at spawn. */
	model?: string;
	/** `low|medium|high` replaces the model id's effort suffix; other values are ignored. */
	thinking?: string;
	/** Extra child env; `SLACK_`/`OMPBOT_` keys are rejected like every driver. */
	env?: Record<string, string>;
	/** Floors + persona text, prepended to the first user message of every child process. */
	systemPrompt?: string;
	/** Parent environment source (tests); default `process.env`. */
	baseEnv?: Record<string, string | undefined>;
	/** How long a spawn waits for agy's `init` event. */
	startupTimeoutMs?: number;
}

interface AgyChild {
	pid: number;
	stdin: { write(data: string): unknown };
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	kill(signal?: NodeJS.Signals): void;
	/** Resolves once the exit was handled (stdout drained, turn and listeners settled). */
	gone: Promise<void>;
}

interface PendingTurn {
	opRef: string;
	abortRequested: boolean;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

/** agy `usage` → omp `Usage`; agy reports no cost, so `cost` stays unset. */
function usageOf(value: unknown): OmpUsage | undefined {
	const usage = recordOf(value);
	if (usage === undefined) return undefined;
	const mapped: OmpUsage = {};
	const input = num(usage.input_tokens);
	const output = num(usage.output_tokens);
	const cacheRead = num(usage.cache_read_tokens);
	if (input !== undefined) mapped.input = input;
	if (output !== undefined) mapped.output = output;
	if (cacheRead !== undefined) mapped.cacheRead = cacheRead;
	return mapped;
}

/** `agy models` lines are `<id>\t<label>`; the "Fetching…" banner and blank lines carry no tab. */
export function parseAgyModels(stdout: string): string[] {
	const ids: string[] = [];
	for (const line of stdout.split("\n")) {
		const match = /^([A-Za-z0-9][\w.-]*)\t/.exec(line);
		if (match?.[1] !== undefined) ids.push(match[1]);
	}
	return ids;
}

/** `gemini-3.8-flash-high` + `low` → `gemini-3.8-flash-low`; an id without an effort suffix gains one. */
function withEffort(modelId: string, level: string): string {
	return `${modelId.replace(EFFORT_SUFFIX, "")}-${level}`;
}

function isThinkingLevel(level: string): boolean {
	return (AGY_THINKING_LEVELS as readonly string[]).includes(level);
}

export class AgyOmpDriver implements OmpSessionDriver {
	readonly #options: AgyOmpDriverOptions;
	readonly #pointerPath: string;
	#started = false;
	#stopping = false;
	#child: AgyChild | undefined;
	/** The child this driver interrupted (SIGINT): its exit is the abort, not a crash. */
	#interrupted: AgyChild | undefined;
	#stderrTail = "";
	/** Entries of the CURRENT child only: cleared on every (re)spawn, cursors before it become `unknown_since`. */
	#entries: OmpEntry[] = [];
	#entrySeq = 0;
	#turn: PendingTurn | undefined;
	/** Steered texts held until the running turn's result; sent together as the turn's next user message. */
	#queued: string[] = [];
	#conversationId: string | undefined;
	/** True while the live child resumed the `--conversation` it was given (what `openSession().resumed` reports). */
	#resumedCurrent = false;
	/** Whether the live child already got the system prompt. */
	#systemPromptSent = false;
	/** Model chosen by config or `/model` (`--model` on every spawn); unset = agy's own default. */
	#modelId: string | undefined;
	/** Model the live child reported in `init` (what agy actually runs when `#modelId` is unset). */
	#initModel: string | undefined;
	#models: string[] | undefined;
	readonly #finalListeners = new Set<(final: OmpFinal) => void>();
	readonly #eventListeners = new Set<(event: OmpEvent) => void>();
	readonly #exitListeners = new Set<(info: OmpExitInfo) => void>();
	#initWait: { pending: PromiseWithResolvers<void>; resume: string | undefined } | undefined;
	/** Set while `#spawn` replaces the child: a prompt meanwhile waits for the new child instead of spawning its own. */
	#respawning: Promise<void> | undefined;

	constructor(options: AgyOmpDriverOptions) {
		this.#options = options;
		this.#pointerPath = join(resolve(options.sessionDir), "agy-conversation.json");
		const model = options.model === "" ? undefined : options.model;
		const thinking = options.thinking;
		this.#modelId =
			model !== undefined && thinking !== undefined && isThinkingLevel(thinking) ? withEffort(model, thinking) : model;
	}

	/** Pid of the live child (for leftover-process checks); undefined when not running. */
	get pid(): number | undefined {
		return this.#child?.pid;
	}

	async start(): Promise<void> {
		if (this.#started) throw new OmpDriverError("already_started", "driver already started");
		this.#resolveExecutable(buildChildEnv(this.#options.env, this.#options.baseEnv));
		mkdirSync(resolve(this.#options.cwd), { recursive: true });
		mkdirSync(resolve(this.#options.sessionDir), { recursive: true });
		this.#started = true;
		await this.#bindPinnedConversation();
	}

	async prompt(text: string): Promise<string> {
		this.#requireStarted();
		await this.#ensureChild();
		if (this.#turn) throw new OmpDriverError("rpc_error", "a turn is already running");
		const opRef = `agy-${Date.now().toString(36)}-${++this.#entrySeq}`;
		this.#turn = { opRef, abortRequested: false };
		try {
			this.#sendUserMessage(text);
		} catch (error) {
			this.#turn = undefined;
			throw error;
		}
		return opRef;
	}

	/**
	 * agy answers a message written mid-turn only after the turn ends, as its own turn. The driver holds steered text
	 * and sends it when the running turn's result arrives, keeping the same `opRef` open until that answer too.
	 */
	async steer(text: string): Promise<void> {
		this.#requireStarted();
		if (this.#turn === undefined) throw new OmpDriverError("rpc_error", "no turn is running to steer");
		this.#queued.push(text);
	}

	/** SIGINT ends the turn with an `interrupted` result and the child exits; the next prompt resumes the conversation. */
	async abort(): Promise<void> {
		this.#requireStarted();
		const turn = this.#turn;
		const child = this.#child;
		if (!turn || !child) return;
		turn.abortRequested = true;
		this.#queued = [];
		this.#interrupted = child;
		child.kill("SIGINT");
		const killer = setTimeout(() => child.kill("SIGKILL"), ABORT_EXIT_TIMEOUT_MS);
		await child.gone;
		clearTimeout(killer);
	}

	/** `/new`: drop the resume pointer and restart without `--conversation`; the next conversation is fresh. */
	async newSession(): Promise<{ cancelled: boolean }> {
		this.#requireStarted();
		this.#clearPointer();
		this.#conversationId = undefined;
		if (this.#child) await this.#spawn({}, "new session");
		return { cancelled: false };
	}

	async openSession(): Promise<OmpOpenResult> {
		this.#requireStarted();
		await this.#bindPinnedConversation();
		return { resumed: this.#resumedCurrent, sessionId: this.#conversationId ?? "" };
	}

	/** Binds the conversation the pointer names: respawns with `--conversation` when the live child is another one. */
	async #bindPinnedConversation(): Promise<void> {
		const pointer = this.#readPointer();
		if (pointer !== undefined && (pointer !== this.#conversationId || !this.#child)) {
			await this.#spawn({ resume: pointer }, "conversation rebind");
			return;
		}
		await this.#ensureChild();
	}

	/** Resumes the agy conversation named by `sessionFile` (a conversation id, or a path ending in one). */
	async switchSession(sessionFile: string): Promise<{ cancelled: boolean }> {
		this.#requireStarted();
		const stem =
			sessionFile
				.replace(/\.(jsonl?|pb)$/, "")
				.split(/[/\\]/)
				.at(-1) ?? "";
		if (!/^[\w-]{8,}$/.test(stem)) {
			throw new OmpDriverError("rpc_error", `not an agy conversation id: ${sessionFile}`);
		}
		this.#writePointer(stem);
		await this.#spawn({ resume: stem }, "session switch");
		return { cancelled: false };
	}

	/** `agy models`, run once per driver; reported as `agy/<id>`. */
	async availableModels(): Promise<string[]> {
		if (this.#models === undefined) this.#models = await this.#listModels();
		return this.#models.map((id) => `${AGY_PROVIDER}/${id}`);
	}

	async setModel(model: string): Promise<string> {
		this.#requireStarted();
		const slash = model.indexOf("/");
		if (slash <= 0 || slash === model.length - 1) {
			throw new OmpDriverError("rpc_error", `model must be provider/id: ${model}`);
		}
		if (model.slice(0, slash) !== AGY_PROVIDER || !(await this.availableModels()).includes(model)) {
			throw new OmpDriverError("rpc_error", `Model not found: ${model}`);
		}
		const id = model.slice(slash + 1);
		await this.#switchModel(id);
		return `${AGY_PROVIDER}/${id}`;
	}

	thinkingLevels(): Promise<string[]> {
		return Promise.resolve([...AGY_THINKING_LEVELS]);
	}

	async setThinking(level: string): Promise<void> {
		this.#requireStarted();
		if (!isThinkingLevel(level)) throw new OmpDriverError("rpc_error", `Model not found: thinking ${level}`);
		const current = this.#modelId ?? this.#initModel;
		if (current === undefined) {
			throw new OmpDriverError("rpc_error", "agy 모델이 정해지지 않아 thinking을 바꿀 수 없습니다 (model을 먼저 지정)");
		}
		const next = withEffort(current, level);
		if (!(await this.availableModels()).includes(`${AGY_PROVIDER}/${next}`)) {
			throw new OmpDriverError("rpc_error", `Model not found: ${AGY_PROVIDER}/${next}`);
		}
		await this.#switchModel(next);
	}

	compact(): Promise<OmpCompactResult> {
		return Promise.reject(new OmpDriverError("rpc_error", "agy 세션은 compact를 지원하지 않습니다"));
	}

	async state(): Promise<OmpState> {
		const model = this.#modelId ?? this.#initModel;
		const thinking = model === undefined ? undefined : EFFORT_SUFFIX.exec(model)?.[1];
		return {
			sessionId: this.#conversationId ?? "",
			idle: this.#turn === undefined,
			settled: this.#turn === undefined,
			queuedMessageCount: this.#queued.length,
			messageCount: this.#entries.length,
			...(model === undefined ? {} : { model: `${AGY_PROVIDER}/${model}` }),
			...(thinking === undefined ? {} : { thinking }),
		};
	}

	async leafId(): Promise<string | null> {
		return this.#entries.at(-1)?.id ?? null;
	}

	async entriesSince(since?: string): Promise<OmpEntries> {
		const leafId = this.#entries.at(-1)?.id ?? null;
		if (since === undefined) return { entries: [...this.#entries], leafId };
		const index = this.#entries.findIndex((entry) => entry.id === since);
		if (index === -1) throw new OmpDriverError("unknown_since", `no such entry: ${since}`);
		return { entries: this.#entries.slice(index + 1), leafId };
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

	async stop(): Promise<void> {
		const child = this.#child;
		this.#started = false;
		this.#stopping = true;
		this.#turn = undefined;
		this.#queued = [];
		this.#child = undefined;
		this.#settleInit(new OmpDriverError("rpc_error", "driver stopped while starting"));
		if (!child) return;
		child.kill("SIGTERM");
		const killer = setTimeout(() => child.kill("SIGKILL"), 5_000);
		await child.gone;
		clearTimeout(killer);
	}

	// ---- child lifecycle ----

	#requireStarted(): void {
		if (!this.#started) throw new OmpDriverError("not_started", "driver not started");
	}

	/** Spawns a child when none is live, continuing the current conversation (after an abort or idle exit). */
	async #ensureChild(): Promise<void> {
		while (this.#respawning) await this.#respawning;
		if (this.#child) return;
		await this.#spawn(this.#conversationId === undefined ? {} : { resume: this.#conversationId }, "child restart");
	}

	/** A model change needs a new child (agy has no in-flight model switch); the conversation carries over. */
	async #switchModel(id: string): Promise<void> {
		this.#modelId = id;
		if (this.#child) {
			await this.#spawn(this.#conversationId === undefined ? {} : { resume: this.#conversationId }, "model change");
		}
	}

	#resolveExecutable(env: Record<string, string>): string {
		const given = this.#options.agyExecutable;
		if (given.includes("/")) {
			try {
				accessSync(given, constants.X_OK);
				return given;
			} catch (cause) {
				throw new OmpDriverError("agy_executable_missing", `agy executable not found or not executable: ${given}`, {
					cause,
				});
			}
		}
		const found = Bun.which(given, { PATH: env.PATH ?? "" });
		if (!found) throw new OmpDriverError("agy_executable_missing", `agy executable not found on PATH: ${given}`);
		return found;
	}

	async #listModels(): Promise<string[]> {
		const env = buildChildEnv(this.#options.env, this.#options.baseEnv);
		const proc = Bun.spawn([this.#resolveExecutable(env), "models"], {
			cwd: resolve(this.#options.cwd),
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const killer = setTimeout(() => proc.kill("SIGKILL"), MODELS_TIMEOUT_MS);
		try {
			const [stdout, stderr, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			const ids = parseAgyModels(stdout);
			if (code !== 0 || ids.length === 0) {
				throw new OmpDriverError(
					"rpc_error",
					`agy models failed (code=${code}): ${(stderr || stdout).trim().slice(0, 400)}`,
				);
			}
			return ids;
		} finally {
			clearTimeout(killer);
		}
	}

	/**
	 * Stops the current child (if any) and waits for its exit, so two agy processes never hold one `--conversation`,
	 * then spawns a new one and waits for its `init` event. A turn still running ends `aborted` (`reason` in the
	 * error) once the new child is up or failed to start, so a prompt sent on that final reaches the new child.
	 */
	async #spawn(opts: { resume?: string }, reason: string): Promise<void> {
		// One replacement at a time: a second one started meanwhile would launch beside the first one's new child.
		while (this.#respawning) await this.#respawning;
		const env = buildChildEnv(this.#options.env, this.#options.baseEnv);
		const executable = this.#resolveExecutable(env);
		const previous = this.#child;
		const cut = this.#turn;
		this.#turn = undefined;
		this.#queued = [];
		const done = Promise.withResolvers<void>();
		this.#respawning = done.promise;
		try {
			if (previous) {
				// A rebound conversation starts a clean log: cursors of the old child turn `unknown_since`.
				this.#child = undefined;
				previous.kill("SIGTERM");
				const killer = setTimeout(() => previous.kill("SIGKILL"), ABORT_EXIT_TIMEOUT_MS);
				await previous.gone;
				clearTimeout(killer);
				if (!this.#started) throw new OmpDriverError("not_started", "driver stopped while agy restarted");
			}
			await this.#launch(executable, env, opts);
		} finally {
			if (this.#respawning === done.promise) this.#respawning = undefined;
			done.resolve();
			if (cut !== undefined) {
				this.#settleFinal({ opRef: cut.opRef, status: "aborted", text: "", error: `agy restarted (${reason})` });
			}
		}
	}

	async #launch(executable: string, env: Record<string, string>, opts: { resume?: string }): Promise<void> {
		const options = this.#options;
		this.#entries = [];
		this.#stderrTail = "";
		this.#systemPromptSent = false;

		const args = ["--input-format", "stream-json", "--output-format", "stream-json", "-p", ""];
		if (opts.resume !== undefined) args.push("--conversation", opts.resume);
		if (this.#modelId !== undefined) args.push("--model", this.#modelId);
		args.push("--dangerously-skip-permissions");

		const proc = Bun.spawn([executable, ...args], {
			cwd: resolve(options.cwd),
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const gone = Promise.withResolvers<void>();
		const child: AgyChild = {
			pid: proc.pid,
			stdin: { write: (data) => proc.stdin.write(data) },
			stdout: proc.stdout as ReadableStream<Uint8Array>,
			stderr: proc.stderr as ReadableStream<Uint8Array>,
			kill: (signal) => {
				try {
					proc.kill(signal ?? "SIGTERM");
				} catch {
					// already gone
				}
			},
			gone: gone.promise,
		};
		this.#stopping = false;
		this.#resumedCurrent = false;
		this.#child = child;
		// The exit handler must see every frame: drain stdout before judging the death.
		const stdoutClosed = Promise.withResolvers<void>();
		this.#pump(child, () => stdoutClosed.resolve());

		const startup = Promise.withResolvers<void>();
		this.#initWait = { pending: startup, resume: opts.resume };
		const timeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
		const timer = setTimeout(() => {
			if (this.#initWait?.pending !== startup) return;
			this.#settleInit(new OmpDriverError("rpc_error", `agy sent no init within ${timeoutMs}ms`));
			if (this.#child === child) this.#child = undefined;
			child.kill("SIGKILL");
		}, timeoutMs);
		void Promise.all([proc.exited, stdoutClosed.promise]).then(([code]) => {
			this.#onChildExit(child, code);
			gone.resolve();
		});
		try {
			await startup.promise;
		} finally {
			clearTimeout(timer);
		}
	}

	#onChildExit(child: AgyChild, code: number): void {
		const stderr = this.#stderrTail;
		if (this.#interrupted === child) {
			// The abort's own exit: the turn ends aborted unless the `interrupted` result already ended it.
			this.#interrupted = undefined;
			if (this.#child === child) this.#child = undefined;
			const turn = this.#turn;
			if (turn !== undefined) {
				this.#turn = undefined;
				this.#settleFinal({ opRef: turn.opRef, status: "aborted", text: "", error: "interrupted" });
			}
			return;
		}
		if (this.#child !== child) return;
		this.#child = undefined;
		if (this.#initWait !== undefined) {
			this.#settleInit(
				new OmpDriverError("rpc_error", `agy exited right after spawn (code=${code}): ${stderr.slice(0, 400)}`),
			);
			return;
		}
		this.#turn = undefined;
		this.#queued = [];
		if (!this.#stopping) {
			const info: OmpExitInfo = { code, expected: false, stderr };
			for (const listener of this.#exitListeners) listener(info);
		}
	}

	#settleInit(error: unknown): void {
		const init = this.#initWait;
		if (init === undefined) return;
		this.#initWait = undefined;
		if (error !== undefined) init.pending.reject(error);
		else init.pending.resolve();
	}

	#pump(child: AgyChild, onStdoutClosed: () => void): void {
		void (async () => {
			const decoder = new TextDecoder();
			let buffer = "";
			try {
				for await (const chunk of child.stdout) {
					buffer += decoder.decode(chunk, { stream: true });
					let newline = buffer.indexOf("\n");
					while (newline !== -1) {
						const line = buffer.slice(0, newline);
						buffer = buffer.slice(newline + 1);
						newline = buffer.indexOf("\n");
						this.#handleLine(child, line);
					}
				}
			} catch {
				// stream closed with the child
			}
			if (buffer.trim() !== "") this.#handleLine(child, buffer);
			onStdoutClosed();
		})();
		void (async () => {
			const decoder = new TextDecoder();
			try {
				for await (const chunk of child.stderr) {
					const text = decoder.decode(chunk, { stream: true });
					// A replaced child's last words must not land in the tail of the child that followed it.
					if (child === this.#child) this.#stderrTail = (this.#stderrTail + text).slice(-STDERR_TAIL_BYTES);
				}
			} catch {
				// stream closed with the child
			}
		})();
	}

	// ---- wire frames ----

	#handleLine(child: AgyChild, line: string): void {
		if (child !== this.#child || line.trim() === "") return;
		let frame: unknown;
		try {
			frame = JSON.parse(line);
		} catch {
			return; // agy prints plain warnings (e.g. an unknown --conversation) between frames
		}
		if (!isRecord(frame)) return;
		const event = str(frame.event);
		if (event === "init") this.#onInit(frame);
		else if (event === "step_update") this.#onStep(recordOf(frame.step_update) ?? {});
		else if (event === "result") this.#onResult(recordOf(frame.result) ?? {});
		this.#emit({ type: event ?? "unknown", ...frame });
	}

	#onInit(frame: Record<string, unknown>): void {
		const conversationId = str(frame.conversation_id);
		if (conversationId === undefined) {
			this.#settleInit(new OmpDriverError("rpc_error", "agy init without a conversation_id"));
			return;
		}
		// agy answers an unknown `--conversation` with a warning and a brand-new id: that is not a resume.
		const requested = this.#initWait?.resume;
		this.#resumedCurrent = requested !== undefined && requested === conversationId;
		this.#conversationId = conversationId;
		this.#writePointer(conversationId);
		const model = str(recordOf(frame.init)?.model);
		this.#initModel = model === "" ? undefined : model;
		this.#settleInit(undefined);
	}

	/** Tool steps become omp-style toolCall/toolResult entries and tool events (the mailbox's status lines). */
	#onStep(step: Record<string, unknown>): void {
		if (step.step_type !== "tool") return;
		const info = recordOf(step.tool_info);
		const name = str(step.tool_name) ?? str(info?.name) ?? "tool";
		const callId = `agy-tool-${String(step.step_index ?? this.#entrySeq)}`;
		const args = info?.parameters ?? {};
		if (step.state === "ACTIVE") {
			this.#entries.push({
				id: `ag-${++this.#entrySeq}`,
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: callId, name, arguments: args }],
					stopReason: "toolUse",
					provider: AGY_PROVIDER,
					...(this.#initModel === undefined ? {} : { model: this.#initModel }),
				},
			});
			this.#emit({ type: "tool_execution_start", toolCallId: callId, toolName: name, args });
		} else if (step.state === "DONE") {
			const output = info?.output === undefined ? "" : String(info.output);
			this.#entries.push({
				id: `ag-${++this.#entrySeq}`,
				type: "message",
				toolCallId: callId,
				toolName: name,
				message: { role: "toolResult", content: [{ type: "text", text: output }] },
			});
			this.#emit({ type: "tool_execution_end", toolCallId: callId, toolName: name, result: output });
		}
	}

	#onResult(result: Record<string, unknown>): void {
		const turn = this.#turn;
		if (turn === undefined) return;
		const response = str(result.response) ?? "";
		const usage = usageOf(result.usage);
		const succeeded = result.status === "SUCCESS";
		if (response.trim() !== "" || usage !== undefined) {
			this.#entries.push({
				id: `ag-${++this.#entrySeq}`,
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: response }],
					stopReason: succeeded ? "stop" : "error",
					provider: AGY_PROVIDER,
					...(this.#initModel === undefined ? {} : { model: this.#initModel }),
					...(usage === undefined ? {} : { usage }),
				},
			});
		}
		// Steered text is answered as part of the same turn: the opRef stays open until that answer arrives.
		let sendFailure: string | undefined;
		if (succeeded && !turn.abortRequested && this.#queued.length > 0) {
			const queued = this.#queued.join("\n\n");
			this.#queued = [];
			try {
				this.#sendUserMessage(queued);
				return;
			} catch (cause) {
				// The steered text never reached agy: the turn did not do what was asked of it.
				sendFailure = `steer 전송 실패: ${cause instanceof Error ? cause.message : String(cause)}`;
			}
		}
		const dropped = this.#queued.length;
		this.#turn = undefined;
		this.#queued = [];
		const status: OmpFinal["status"] = turn.abortRequested
			? "aborted"
			: succeeded && sendFailure === undefined
				? "completed"
				: "error";
		let error =
			status === "completed"
				? undefined
				: (sendFailure ?? str(result.error) ?? `agy turn ended with ${String(result.status)}`);
		if (error !== undefined && dropped > 0) error = `${error} (steer ${dropped}건 미전달)`;
		this.#settleFinal({ opRef: turn.opRef, status, text: response, ...(error === undefined ? {} : { error }) });
	}

	#settleFinal(final: OmpFinal): void {
		for (const listener of this.#finalListeners) listener(final);
	}

	#emit(event: OmpEvent): void {
		for (const listener of this.#eventListeners) listener(event);
	}

	// ---- stdin writes ----

	/** Records the user entry and writes one turn line; the first line of each child carries the system prompt. */
	#sendUserMessage(text: string): void {
		const child = this.#child;
		if (!child) throw new OmpDriverError("rpc_error", "agy child is not running");
		const system = this.#options.systemPrompt;
		const content =
			!this.#systemPromptSent && system !== undefined && system !== "" ? `${system}\n\n---\n\n${text}` : text;
		try {
			child.stdin.write(`${JSON.stringify({ event: "user", message: { role: "user", content } })}\n`);
		} catch (cause) {
			throw new OmpDriverError("rpc_error", "agy stdin is closed", { cause });
		}
		this.#systemPromptSent = true;
		this.#entries.push({ id: `ag-${++this.#entrySeq}`, type: "message", message: { role: "user", content: text } });
	}

	// ---- conversation pointer ----

	#readPointer(): string | undefined {
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.#pointerPath, "utf8"));
			return isRecord(parsed) ? str(parsed.conversationId) : undefined;
		} catch {
			return undefined;
		}
	}

	#writePointer(conversationId: string): void {
		mkdirSync(resolve(this.#options.sessionDir), { recursive: true });
		writeFileSync(this.#pointerPath, `${JSON.stringify({ conversationId })}\n`);
	}

	#clearPointer(): void {
		rmSync(this.#pointerPath, { force: true });
	}
}
