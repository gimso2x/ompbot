import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Logger } from "../log";
import { redact } from "../redact";
import { classifyPermission, type PermissionDecision } from "./claude-permission";
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
import { buildChildEnv } from "./env";
import { isRecord } from "./type-guards";

/*
 * Boundary between ompbot and one Claude Code CLI child process
 * (`claude -p --input-format stream-json --output-format stream-json --verbose`).
 *
 * Wire protocol (verified against claude 2.1.311, both directions newline-delimited JSON):
 * - out  `{"type":"user","message":{"role":"user","content":"<text>"}}` starts or steers a turn.
 * - out  `{"type":"control_request","request_id","request":{"subtype":…}}` — `interrupt` aborts the
 *        running turn, `set_model`/`set_max_thinking_tokens`/`apply_flag_settings` switch session
 *        settings mid-flight.
 * - in   `system/init` carries `session_id` + `model` at startup (the resume key).
 * - in   `assistant`/`user` frames append to the conversation; `assistant.stop_reason` is always
 *        `null` on the wire — the turn's stop is only known from the `result` frame, so the last
 *        text-bearing assistant entry is marked `stopReason: "stop"` when the result arrives (the
 *        shape `answers.ts` and `recovery.ts` read).
 * - in   `result` (`success` | `error_*`) ends the turn: `onFinal` maps it to
 *        completed/error/aborted (aborted when this driver interrupted the turn).
 * - in   `control_request` with `request.can_use_tool` asks permission for one tool call; the
 *        driver answers `control_response` allow/deny via `claude-permission.ts` policy, and
 *        dangerous Bash escalates through the injected `approval` hook (a Slack approval card).
 *
 * Session continuity: claude stores its own sessions under `~/.claude`; ompbot pins the session per
 * origin epoch with a pointer file (`<sessionDir>/claude-session.json`). `openSession` resumes the
 * pointer's session (`--resume`), `newSession` clears it and restarts fresh, `switchSession` accepts
 * a claude session id (or `<uuid>.jsonl` path) and resumes it.
 */

export const CLAUDE_PROVIDER = "claude";
/** Aliases `claude --model` accepts (claude 2.1.311); reported as `claude/<alias>`. */
export const CLAUDE_MODELS = ["claude/fable", "claude/opus", "claude/sonnet", "claude/haiku"] as const;
/** omp thinking levels mapped onto claude: `off` = no thinking, the rest = `--effort`. */
export const CLAUDE_THINKING_LEVELS = ["off", "low", "medium", "high"] as const;

const MODEL_ALIASES = ["fable", "opus", "sonnet", "haiku"] as const;
/** Flags claude loads settings from; user-only so a workspace's project settings cannot grant permissions behind the bot's back. */
const SETTING_SOURCES = ["--setting-sources", "user"] as const;
/**
 * Real claude sends `system/init` only when the first user message is processed (before that, only
 * SessionStart hook frames may appear), so `start()` cannot wait for init. It waits this long for the
 * child to die instead: an auth/flag failure exits within ~1s with the reason; a healthy child is
 * simply quiet until the first prompt.
 */
const DEFAULT_STARTUP_GRACE_MS = 1_500;
const CONTROL_TIMEOUT_MS = 15_000;
const STDERR_TAIL_BYTES = 4_000;

/** Maps a resolved claude model id (`claude-haiku-5-5`) back to the alias its `claude/<alias>` state key uses. */
function modelAliasOf(raw: string): string | undefined {
	const flat = raw.toLowerCase();
	return MODEL_ALIASES.find((alias) => flat.includes(alias));
}

export type ClaudeApprovalOutcome = "approved" | "denied" | "timeout" | { replied: string };

/**
 * Owner approval surface for dangerous Bash calls. The daemon builds it from the approval broker
 * (Slack card) and the origin's channel; `{replied}` counts as NOT approved — the driver cannot judge
 * whether a free-text reply plainly approves this exact command, so the CLI sees a deny that quotes
 * the owner's words.
 */
export type ClaudeApprovalHook = (request: {
	toolName: string;
	command: string;
	description?: string;
}) => Promise<ClaudeApprovalOutcome>;

export interface ClaudeOmpDriverOptions {
	/** Path or name of the claude CLI; names resolve on the child PATH. */
	claudeExecutable: string;
	cwd: string;
	/** ompbot-owned per-origin-epoch directory; holds the `claude-session.json` resume pointer. */
	sessionDir: string;
	/** Model id without provider prefix (`opus`); passed as `--model` at spawn. */
	model?: string;
	thinking?: string;
	/** Extra child env; `SLACK_`/`OMPBOT_` keys are rejected like every driver. */
	env?: Record<string, string>;
	extraArgs?: string[];
	/** Floors + persona text, sent as `--append-system-prompt`. */
	systemPrompt?: string;
	/** Bot secrets directory; Bash touching it is denied without a card. */
	secretsDir?: string;
	/** Owner approval bridge for dangerous Bash; absent → dangerous Bash is denied outright. */
	approval?: ClaudeApprovalHook;
	/** Where a failed permission decision is reported; absent → stderr. */
	log?: Logger;
	/** Parent environment source (tests); default `process.env`. */
	baseEnv?: Record<string, string | undefined>;
	/** How long `start()` waits for an immediate child death before assuming a healthy quiet child. */
	startupGraceMs?: number;
}

interface ClaudeChild {
	pid: number;
	stdin: { write(data: string): unknown };
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	kill(signal?: NodeJS.Signals): void;
	exited: Promise<number>;
}

/** `Promise.withResolvers()` result under this tsconfig's lib (no `Promise.WithResolvers` namespace). */
interface Pending<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

interface PendingTurn {
	opRef: string;
	abortRequested: boolean;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function blockArray(value: unknown): Array<Record<string, unknown>> {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

const AUTH_FAILURE_SIGN =
	/invalid api key|not logged ?in|run \/login|unauthenticated|authentication|no api key|oauth token|credentials/i;
const RESUME_GONE_SIGN =
	/no conversation|not found|does not exist|unable to (resume|find)|cannot resume|unknown session|no session/i;

export class ClaudeOmpDriver implements OmpSessionDriver {
	readonly #options: ClaudeOmpDriverOptions;
	readonly #pointerPath: string;
	#started = false;
	#stopping = false;
	#child: ClaudeChild | undefined;
	#stderrTail = "";
	/** Startup-failure text a zeroed `result` frame carried before the child exited. */
	#startupFailure: string | undefined;
	/** Frames of the CURRENT child only: cleared on every (re)spawn, cursors before it become `unknown_since`. */
	#entries: OmpEntry[] = [];
	#entrySeq = 0;
	#turn: PendingTurn | undefined;
	#sessionId: string | undefined;
	/** True while the live child was spawned with `--resume` (what `openSession().resumed` reports). */
	#resumedCurrent = false;
	#modelAlias: string | undefined;
	#thinking: string | undefined;
	#lastUsageInputTokens: number | undefined;
	readonly #finalListeners = new Set<(final: OmpFinal) => void>();
	readonly #eventListeners = new Set<(event: OmpEvent) => void>();
	readonly #exitListeners = new Set<(info: OmpExitInfo) => void>();
	readonly #pendingControl = new Map<string, Pending<Record<string, unknown>>>();
	readonly #finalWaiters = new Map<string, Pending<OmpFinal>>();
	#initWait: Pending<void> | undefined;
	#initTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: ClaudeOmpDriverOptions) {
		this.#options = options;
		this.#pointerPath = join(resolve(options.sessionDir), "claude-session.json");
		this.#thinking = options.thinking;
	}

	/** Pid of the live child (for leftover-process checks); undefined when not running. */
	get pid(): number | undefined {
		return this.#child?.pid;
	}

	async start(): Promise<void> {
		if (this.#started) throw new OmpDriverError("already_started", "driver already started");
		const env = buildChildEnv(this.#options.env, this.#options.baseEnv);
		// Fail fast here (like the omp driver): executable and auth are checked before any spawn.
		this.#resolveExecutable(env);
		this.#assertAuthenticated(env);
		mkdirSync(resolve(this.#options.cwd), { recursive: true });
		mkdirSync(resolve(this.#options.sessionDir), { recursive: true });
		this.#started = true;
		// The pinned session is resumed right here: a fresh child's init would otherwise re-pin the
		// pointer to a brand-new session and the old conversation would be lost.
		await this.#bindPinnedSession();
	}

	async prompt(text: string): Promise<string> {
		this.#requireStarted();
		await this.#ensureChild();
		if (this.#turn) throw new OmpDriverError("rpc_error", "a turn is already running");
		const opRef = `claude-${Date.now().toString(36)}-${++this.#entrySeq}`;
		this.#turn = { opRef, abortRequested: false };
		this.#writeUserMessage(text);
		return opRef;
	}

	/** Mid-turn steering: an extra user message on stdin while the child is generating. */
	async steer(text: string): Promise<void> {
		this.#requireStarted();
		await this.#ensureChild();
		this.#writeUserMessage(text);
	}

	async abort(): Promise<void> {
		this.#requireStarted();
		const turn = this.#turn;
		if (!turn || !this.#child) return;
		turn.abortRequested = true;
		await this.#sendControl("interrupt", {});
	}

	/** `/new`: drop the resume pointer and restart without `--resume`; the next conversation is fresh. */
	async newSession(): Promise<{ cancelled: boolean }> {
		this.#requireStarted();
		this.#clearPointer();
		this.#sessionId = undefined;
		// A stopped child is already "restarted": the next open spawns fresh without a resume.
		if (this.#child) await this.#respawn({});
		return { cancelled: false };
	}

	async openSession(): Promise<OmpOpenResult> {
		this.#requireStarted();
		await this.#bindPinnedSession();
		return { resumed: this.#resumedCurrent, sessionId: this.#sessionId ?? "" };
	}

	/**
	 * Binds the conversation the resume pointer names: respawns with `--resume` when the live child is
	 * a different session, spawns fresh when nothing is pinned. A pinned session the CLI no longer knows
	 * (purged) falls back to a fresh conversation with the pointer cleared.
	 */
	async #bindPinnedSession(): Promise<void> {
		const pointer = this.#readPointer();
		if (pointer !== undefined && pointer.sessionId !== this.#sessionId) {
			try {
				await this.#respawn({ resume: pointer.sessionId });
				return;
			} catch (error) {
				if (!(error instanceof Error) || !RESUME_GONE_SIGN.test(error.message)) throw error;
				this.#clearPointer();
			}
		}
		await this.#ensureChild();
	}

	/** Resumes the claude session named by `sessionFile` (a bare session id or `<uuid>.jsonl` path). */
	async switchSession(sessionFile: string): Promise<{ cancelled: boolean }> {
		this.#requireStarted();
		const stem =
			sessionFile
				.replace(/\.jsonl$/, "")
				.split(/[/\\]/)
				.at(-1) ?? "";
		if (!/^[\w-]{8,}$/.test(stem)) {
			throw new OmpDriverError("rpc_error", `not a claude session id: ${sessionFile}`);
		}
		this.#writePointer(stem);
		await this.#respawn({ resume: stem });
		return { cancelled: false };
	}

	availableModels(): Promise<string[]> {
		return Promise.resolve([...CLAUDE_MODELS]);
	}

	async setModel(model: string): Promise<string> {
		this.#requireStarted();
		const slash = model.indexOf("/");
		if (slash <= 0 || slash === model.length - 1) {
			throw new OmpDriverError("rpc_error", `model must be provider/id: ${model}`);
		}
		const provider = model.slice(0, slash);
		const id = model.slice(slash + 1);
		if (provider !== CLAUDE_PROVIDER || !MODEL_ALIASES.includes(id as (typeof MODEL_ALIASES)[number])) {
			throw new OmpDriverError("rpc_error", `Model not found: ${model}`);
		}
		await this.#sendControl("set_model", { model: id });
		this.#modelAlias = id;
		return `${CLAUDE_PROVIDER}/${id}`;
	}

	thinkingLevels(): Promise<string[]> {
		return Promise.resolve([...CLAUDE_THINKING_LEVELS]);
	}

	async setThinking(level: string): Promise<void> {
		this.#requireStarted();
		if (!CLAUDE_THINKING_LEVELS.includes(level as (typeof CLAUDE_THINKING_LEVELS)[number])) {
			throw new OmpDriverError("rpc_error", `Model not found: thinking ${level}`);
		}
		await this.#ensureChild();
		await this.#applyThinking(level);
	}

	/** `/compact` as a slash-command turn; `tokensBefore` is the compact call's input tokens (best effort). */
	async compact(instructions?: string): Promise<OmpCompactResult> {
		this.#requireStarted();
		await this.#ensureChild();
		if (this.#turn) throw new OmpDriverError("rpc_error", "a turn is already running");
		const opRef = `claude-${Date.now().toString(36)}-${++this.#entrySeq}`;
		this.#turn = { opRef, abortRequested: false };
		const waiter = Promise.withResolvers<OmpFinal>();
		this.#finalWaiters.set(opRef, waiter);
		const command = instructions === undefined || instructions === "" ? "/compact" : `/compact ${instructions}`;
		this.#writeUserMessage(command);
		const final = await waiter.promise;
		if (final.status !== "completed") {
			throw new OmpDriverError("rpc_error", final.error ?? `compact ended with ${final.status}`);
		}
		return { tokensBefore: this.#lastUsageInputTokens ?? 0, summary: final.text };
	}

	async state(): Promise<OmpState> {
		return {
			sessionId: this.#sessionId ?? "",
			idle: this.#turn === undefined,
			settled: this.#turn === undefined,
			queuedMessageCount: 0,
			messageCount: this.#entries.length,
			...(this.#modelAlias === undefined ? {} : { model: `${CLAUDE_PROVIDER}/${this.#modelAlias}` }),
			...(this.#thinking === undefined ? {} : { thinking: this.#thinking }),
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
		this.#child = undefined;
		this.#rejectPending("driver stopped");
		this.#initWait?.reject(new OmpDriverError("rpc_error", "driver stopped while starting"));
		this.#initWait = undefined;
		clearTimeout(this.#initTimer);
		this.#initTimer = undefined;
		if (!child) return;
		child.kill("SIGTERM");
		const killer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				// already gone
			}
		}, 5_000);
		void child.exited.then(
			() => clearTimeout(killer),
			() => clearTimeout(killer),
		);
		await child.exited.catch(() => undefined);
	}

	// ---- child lifecycle ----

	#requireStarted(): void {
		if (!this.#started) throw new OmpDriverError("not_started", "driver not started");
	}

	async #ensureChild(): Promise<void> {
		if (this.#child) return;
		const env = buildChildEnv(this.#options.env, this.#options.baseEnv);
		await this.#spawn(this.#resolveExecutable(env), env, {});
	}

	/** Kills the current child (if any) and spawns a fresh one, waiting for its `system/init`. */
	async #respawn(opts: { resume?: string }): Promise<void> {
		const env = buildChildEnv(this.#options.env, this.#options.baseEnv);
		await this.#spawn(this.#resolveExecutable(env), env, opts);
	}

	#resolveExecutable(env: Record<string, string>): string {
		const given = this.#options.claudeExecutable;
		if (given.includes("/")) {
			try {
				accessSync(given, constants.X_OK);
				return given;
			} catch (cause) {
				throw new OmpDriverError(
					"claude_executable_missing",
					`claude executable not found or not executable: ${given}`,
					{
						cause,
					},
				);
			}
		}
		const found = Bun.which(given, { PATH: env.PATH ?? "" });
		if (!found) throw new OmpDriverError("claude_executable_missing", `claude executable not found on PATH: ${given}`);
		return found;
	}

	/**
	 * Auth lives in `~/.claude` (or the env); ompbot never touches the values. A missing credential
	 * file AND missing key env fails `start()` the same way a missing omp binary does.
	 */
	#assertAuthenticated(env: Record<string, string>): void {
		if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN) return;
		const configDir = env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude");
		if (existsSync(join(configDir, ".credentials.json"))) return;
		throw new OmpDriverError(
			"claude_not_authenticated",
			`claude CLI is not authenticated: no ${join(configDir, ".credentials.json")} and no ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN (run: claude /login)`,
		);
	}

	async #spawn(executable: string, env: Record<string, string>, opts: { resume?: string }): Promise<void> {
		const options = this.#options;
		const previous = this.#child;
		if (previous) {
			// A rebound conversation starts a clean log: cursors of the old one turn `unknown_since`.
			this.#child = undefined;
			previous.kill("SIGTERM");
		}
		this.#entries = [];
		this.#stderrTail = "";
		this.#startupFailure = undefined;
		this.#turn = undefined;
		this.#rejectPending("child restarted");

		const args = [
			"-p",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
			"--replay-user-messages",
			...SETTING_SOURCES,
		];
		if (opts.resume !== undefined) args.push("--resume", opts.resume);
		if (options.model !== undefined && options.model !== "") args.push("--model", options.model);
		if (options.systemPrompt !== undefined && options.systemPrompt !== "") {
			args.push("--append-system-prompt", options.systemPrompt);
		}
		args.push(...(options.extraArgs ?? []));

		const proc = Bun.spawn([executable, ...args], {
			cwd: resolve(options.cwd),
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const child: ClaudeChild = {
			pid: proc.pid,
			stdin: { write: (data) => proc.stdin.write(data) },
			stdout: proc.stdout as ReadableStream<Uint8Array>,
			stderr: proc.stderr as ReadableStream<Uint8Array>,
			kill: (signal) => proc.kill(signal ?? "SIGTERM"),
			exited: proc.exited as Promise<number>,
		};
		this.#stopping = false;
		this.#resumedCurrent = opts.resume !== undefined;
		this.#child = child;
		// The exit handler reads `#startupFailure` from the stdout pump; drain stdout before judging a death.
		const stdoutClosed = Promise.withResolvers<void>();
		this.#pump(child, () => stdoutClosed.resolve());

		const startup = Promise.withResolvers<void>();
		this.#initWait = startup;
		// A healthy child stays quiet until the first prompt: the grace elapsing IS a good startup.
		this.#initTimer = setTimeout(() => this.#settleInit(undefined), options.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS);
		void child.exited.then((code) => {
			void stdoutClosed.promise.then(() => {
				if (this.#child !== child) return;
				const stderr = this.#stderrTail || this.#startupFailure || "";
				if (this.#initWait !== undefined) {
					const authFailed = AUTH_FAILURE_SIGN.test(stderr);
					this.#settleInit(
						authFailed
							? new OmpDriverError("claude_not_authenticated", `claude is not authenticated: ${stderr.slice(0, 400)}`)
							: new OmpDriverError(
									"rpc_error",
									`claude exited right after spawn (code=${code}): ${stderr.slice(0, 400)}`,
								),
					);
				}
				this.#child = undefined;
				if (!this.#stopping) {
					const info: OmpExitInfo = { code, expected: false, stderr };
					for (const listener of this.#exitListeners) listener(info);
				}
			});
		});
		try {
			await startup.promise;
		} finally {
			clearTimeout(this.#initTimer);
			this.#initTimer = undefined;
			this.#initWait = undefined;
		}
		if (options.thinking !== undefined) await this.#applyThinking(options.thinking).catch(() => undefined);
	}

	#settleInit(error: unknown): void {
		const init = this.#initWait;
		if (init === undefined) return;
		this.#initWait = undefined;
		clearTimeout(this.#initTimer);
		this.#initTimer = undefined;
		if (error !== undefined) init.reject(error);
		else init.resolve();
	}

	#pump(child: ClaudeChild, onStdoutClosed: () => void): void {
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
			} finally {
				onStdoutClosed();
			}
			// Anything still buffered after the last newline (a frame without trailing newline) still counts.
			if (buffer.trim() !== "") this.#handleLine(child, buffer);
		})();
		void (async () => {
			const decoder = new TextDecoder();
			try {
				for await (const chunk of child.stderr) {
					this.#stderrTail = (this.#stderrTail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_BYTES);
				}
			} catch {
				// stream closed with the child
			}
		})();
	}

	// ---- wire frames ----

	#handleLine(child: ClaudeChild, line: string): void {
		if (child !== this.#child || line.trim() === "") return;
		let frame: unknown;
		try {
			frame = JSON.parse(line);
		} catch {
			return; // not a JSON frame; ignore
		}
		if (!isRecord(frame)) return;
		const type = str(frame.type);
		if (type === "control_request") {
			this.#onControlRequest(frame);
			return;
		}
		if (type === "control_response") {
			this.#onControlResponse(frame);
			return;
		}
		if (type === "system" && frame.subtype === "init") {
			this.#onInit(frame);
			return;
		}
		if (type === "assistant") {
			this.#onAssistant(frame);
		} else if (type === "user") {
			this.#onUserMessage(frame);
		} else if (type === "result") {
			this.#onResult(frame);
		}
		this.#emit({ type: type ?? "unknown", ...frame });
	}

	#onInit(frame: Record<string, unknown>): void {
		const sessionId = str(frame.session_id);
		if (sessionId === undefined) {
			this.#settleInit(new OmpDriverError("rpc_error", "claude init without a session_id"));
			return;
		}
		this.#sessionId = sessionId;
		this.#writePointer(sessionId);
		const model = str(frame.model);
		const alias = model === undefined ? undefined : modelAliasOf(model);
		if (alias !== undefined) this.#modelAlias = alias;
		this.#settleInit(undefined);
	}

	#onAssistant(frame: Record<string, unknown>): void {
		const message = recordOf(frame.message);
		if (message === undefined) return;
		const blocks = blockArray(message.content);
		const id = str(frame.uuid) ?? `cl-${++this.#entrySeq}`;
		// `stopReason` stays unset (never "stop"): the turn's stop arrives with the result frame.
		this.#entries.push({
			id,
			type: "message",
			message: { role: "assistant", content: blocks },
		});
		// Synthetic omp-style activity events keep the mailbox status/stall logic working.
		for (const block of blocks) {
			if (block.type === "tool_use") {
				this.#emit({ type: "tool_execution_start", toolName: block.name, args: block.input });
			}
		}
	}

	#onUserMessage(frame: Record<string, unknown>): void {
		const message = recordOf(frame.message);
		if (message === undefined) return;
		const id = str(frame.uuid) ?? `cl-${++this.#entrySeq}`;
		this.#entries.push({ id, type: "message", message: { role: "user", content: message.content } });
	}

	#onResult(frame: Record<string, unknown>): void {
		const usage = recordOf(frame.usage);
		const inputTokens = usage?.input_tokens;
		if (typeof inputTokens === "number") this.#lastUsageInputTokens = inputTokens;
		const errors = Array.isArray(frame.errors) ? frame.errors.map(String).join("; ") : undefined;
		const turn = this.#turn;
		if (turn === undefined) {
			// No prompt admitted: a startup failure writes a zeroed result before the child exits.
			if (errors !== undefined && errors !== "") this.#startupFailure = errors;
			return;
		}
		this.#turn = undefined;
		this.#markStopOnLastTextEntry();
		const subtype = str(frame.subtype);
		const status: OmpFinal["status"] = subtype === "success" ? "completed" : turn.abortRequested ? "aborted" : "error";
		const error =
			status === "completed"
				? undefined
				: errors !== undefined && errors !== ""
					? errors
					: `claude turn ended with ${subtype ?? "unknown result"}`;
		const final: OmpFinal = {
			opRef: turn.opRef,
			status,
			text: str(frame.result) ?? "",
			...(error === undefined ? {} : { error }),
		};
		this.#settleFinal(final);
	}

	/** `answers.ts`/`recovery.ts` read stop-ended assistant messages; claude only says stop on the result frame. */
	#markStopOnLastTextEntry(): void {
		const index = this.#entries.findLastIndex((entry) => {
			const message = recordOf(entry.message);
			return (
				message !== undefined &&
				message.role === "assistant" &&
				blockArray(message.content).some(
					(block) => block.type === "text" && typeof block.text === "string" && block.text.trim() !== "",
				)
			);
		});
		if (index === -1) return;
		const message = recordOf(this.#entries[index]?.message);
		if (message !== undefined) message.stopReason = "stop";
	}

	#onControlRequest(frame: Record<string, unknown>): void {
		const requestId = str(frame.request_id);
		const request = recordOf(frame.request);
		if (requestId === undefined || request === undefined) return;
		if (request.subtype === "can_use_tool") {
			void this.#answerPermission(requestId, request);
			return;
		}
		this.#writeRaw({ type: "control_cancel_request", request_id: requestId });
	}

	async #answerPermission(requestId: string, request: Record<string, unknown>): Promise<void> {
		const toolName = str(request.tool_name) ?? "";
		const input = recordOf(request.input) ?? {};
		const approval = this.#options.approval;
		let decision: PermissionDecision;
		try {
			decision = await classifyPermission({
				toolName,
				input,
				cwd: resolve(this.#options.cwd),
				secretsDir: this.#options.secretsDir === undefined ? undefined : resolve(this.#options.secretsDir),
				// `{replied}` (a free-text owner answer) is NOT an approval: the deny quotes it instead.
				ask: approval === undefined ? undefined : async (asked) => (await approval(asked)) === "approved",
			});
		} catch (error) {
			// The CLI blocks until it gets an answer: a failed approval post (429, network) must still answer it.
			if (this.#options.log === undefined)
				console.error(redact(`[ompbot] claude_permission_failed: tool=${toolName} ${String(error)}`));
			else this.#options.log.warn("claude_permission_failed", { tool: toolName, error: String(error) });
			decision = {
				behavior: "deny",
				message: `승인 요청을 올리지 못해 거부했습니다: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		this.#writeRaw({
			type: "control_response",
			response: { subtype: "success", request_id: requestId, response: decision },
		});
	}

	#onControlResponse(frame: Record<string, unknown>): void {
		const response = recordOf(frame.response);
		const requestId = str(response?.request_id);
		if (requestId === undefined) return;
		const pending = this.#pendingControl.get(requestId);
		if (pending === undefined) return;
		this.#pendingControl.delete(requestId);
		pending.resolve(response ?? {});
	}

	#settleFinal(final: OmpFinal): void {
		const waiter = this.#finalWaiters.get(final.opRef);
		if (waiter !== undefined) {
			this.#finalWaiters.delete(final.opRef);
			waiter.resolve(final);
		}
		for (const listener of this.#finalListeners) listener(final);
	}

	#emit(event: OmpEvent): void {
		for (const listener of this.#eventListeners) listener(event);
	}

	// ---- stdin writes ----

	#writeUserMessage(text: string): void {
		this.#writeFrame({ type: "user", message: { role: "user", content: text } });
	}

	/** stdin write that fails loudly (prompt paths turn it into a dispatch failure). */
	#writeFrame(frame: Record<string, unknown>): void {
		const child = this.#child;
		if (!child) throw new OmpDriverError("rpc_error", "claude child is not running");
		try {
			child.stdin.write(`${JSON.stringify(frame)}\n`);
		} catch (cause) {
			throw new OmpDriverError("rpc_error", "claude stdin is closed", { cause });
		}
	}

	/** stdin write from pump-driven paths (control answers): a dead child's exit reports itself. */
	#writeRaw(frame: Record<string, unknown>): void {
		try {
			this.#writeFrame(frame);
		} catch {
			// the child is gone; its exit is reported through onExit
		}
	}

	/** One `control_request` → awaited `control_response` (success payload or error). */
	async #sendControl(subtype: string, extra: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (!this.#child) throw new OmpDriverError("not_started", "driver not started");
		const requestId = `ompbot-${++this.#entrySeq}`;
		const pending = Promise.withResolvers<Record<string, unknown>>();
		this.#pendingControl.set(requestId, pending);
		const timer = setTimeout(() => {
			if (this.#pendingControl.delete(requestId)) {
				pending.reject(
					new OmpDriverError("rpc_error", `claude did not answer ${subtype} within ${CONTROL_TIMEOUT_MS}ms`),
				);
			}
		}, CONTROL_TIMEOUT_MS);
		this.#writeRaw({ type: "control_request", request_id: requestId, request: { subtype, ...extra } });
		try {
			const response = await pending.promise;
			if (response.subtype !== "success") {
				throw new OmpDriverError("rpc_error", `claude rejected ${subtype}`, { rpcCode: str(response.subtype) });
			}
			return response;
		} finally {
			clearTimeout(timer);
			this.#pendingControl.delete(requestId);
		}
	}

	async #applyThinking(level: string): Promise<void> {
		if (level === "off") {
			await this.#sendControl("set_max_thinking_tokens", { max_thinking_tokens: 0 });
		} else {
			await this.#sendControl("apply_flag_settings", { settings: { effort: level } });
		}
		this.#thinking = level;
	}

	// ---- session pointer ----

	#readPointer(): { sessionId: string } | undefined {
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.#pointerPath, "utf8"));
			const sessionId = isRecord(parsed) ? str(parsed.sessionId) : undefined;
			return sessionId === undefined ? undefined : { sessionId };
		} catch {
			return undefined;
		}
	}

	#writePointer(sessionId: string): void {
		mkdirSync(resolve(this.#options.sessionDir), { recursive: true });
		writeFileSync(this.#pointerPath, `${JSON.stringify({ sessionId })}\n`);
	}

	#clearPointer(): void {
		try {
			rmSync(this.#pointerPath, { force: true });
		} catch {
			// nothing to clear
		}
	}

	#rejectPending(reason: string): void {
		const error = new OmpDriverError("rpc_error", reason);
		for (const [, pending] of this.#pendingControl) pending.reject(error);
		this.#pendingControl.clear();
		for (const [, waiter] of this.#finalWaiters) waiter.reject(error);
		this.#finalWaiters.clear();
	}
}
