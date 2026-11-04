import { accessSync, constants, existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { HostToolDef } from "../safety/host-tools";
import {
	type OmpAskQuestion,
	type OmpCompactResult,
	type OmpDialogAnswerer,
	type OmpDialogRequest,
	type OmpDialogResponse,
	OmpDriverError,
	type OmpEntries,
	type OmpEvent,
	type OmpExitInfo,
	type OmpFinal,
	type OmpOpenResult,
	type OmpSessionDriver,
	type OmpState,
} from "./driver";
import { buildChildEnv } from "./env";
import { checkOmpRuntime } from "./runtime-check";
import { isRecord } from "./type-guards";

/*
 * How the RPC client is imported (decision for todo 2, Q3 "recommended" path):
 * omp is NOT a dependency of ompbot. The pinned `omp` executable (a symlink to
 * `<pkg>/dist/cli.js` inside the global install) is realpath-resolved to the
 * package root, and `<pkg>/src/modes/rpc/rpc-client.ts` plus
 * `@oh-my-pi/pi-utils` (resolved from that root) are loaded with a dynamic
 * `import()` of absolute paths. They are typed here by the minimal structural
 * interfaces below, so `tsc` never type-checks omp's own sources.
 */

interface PromptResultFrame {
	id?: string;
	status: "completed" | "aborted" | "error";
	error?: { message: string };
}

interface RpcStateLike {
	sessionId: string;
	sessionFile?: string;
	isStreaming: boolean;
	isCompacting: boolean;
	isSettled: boolean;
	queuedMessageCount: number;
	messageCount: number;
	model?: { provider?: string; id?: string };
	thinkingLevel?: string;
}

interface RpcClientLike {
	start(): Promise<void>;
	stop(): Promise<void>;
	onEvent(listener: (event: OmpEvent) => void): () => void;
	onSessionEvent(listener: (event: OmpEvent) => void): () => void;
	onPromptResult(listener: (frame: PromptResultFrame) => void): () => void;
	prompt(message: string): Promise<string>;
	steer(message: string): Promise<void>;
	abort(): Promise<void>;
	newSession(): Promise<{ cancelled: boolean }>;
	openSession(sessionDir: string): Promise<{ cancelled: boolean; resumed: boolean; sessionId: string }>;
	getState(): Promise<RpcStateLike>;
	getEntries(since?: string): Promise<OmpEntries>;
	getLastAssistantText(): Promise<string | null>;
	switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;
	getAvailableModels(): Promise<Array<{ provider: string; id: string }>>;
	setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }>;
	getAvailableThinkingLevels(): Promise<string[]>;
	setThinkingLevel(level: string): Promise<void>;
	compact(customInstructions?: string): Promise<{ summary: string; tokensBefore: number }>;
}

/**
 * RpcClient methods ompbot calls. Checked on every start so an omp upgrade that renames or drops one fails fast with
 * `omp_rpc_client_missing` instead of at the first chat command.
 */
export const REQUIRED_RPC_METHODS = [
	"start",
	"stop",
	"onEvent",
	"onSessionEvent",
	"onPromptResult",
	"prompt",
	"steer",
	"abort",
	"newSession",
	"openSession",
	"switchSession",
	"getState",
	"getEntries",
	"getLastAssistantText",
	"getAvailableModels",
	"setModel",
	"getAvailableThinkingLevels",
	"setThinkingLevel",
	"compact",
] as const;

/**
 * Session-only omp events ompbot reads. `auto_retry_end` is here because a retry whose delay exceeds
 * `retry.maxDelayMs` with no fallback ends with `finalError` and no `auto_retry_start` before it.
 */
const FORWARDED_SESSION_EVENTS: ReadonlySet<string> = new Set([
	"auto_retry_start",
	"auto_retry_end",
	"retry_fallback_applied",
]);

/** Names from `REQUIRED_RPC_METHODS` the given RpcClient class does not provide. */
export function missingRpcMethods(ctor: unknown): string[] {
	const proto: unknown = typeof ctor === "function" ? ctor.prototype : undefined;
	return REQUIRED_RPC_METHODS.filter(
		(name) => !isRecord(proto) || typeof (proto as Record<string, unknown>)[name] !== "function",
	);
}

interface ChildLike {
	pid: number;
	stdin: { write(data: string | Uint8Array): unknown };
	stdout: ReadableStream<Uint8Array>;
	peekStderr(): string;
	kill(signal?: NodeJS.Signals | number, graceMs?: number): void;
	exited: Promise<number>;
}

interface SpawnOptionsLike {
	cwd?: string;
	env?: Record<string, string>;
	stdin?: "pipe";
}

type RpcClientCtor = new (options: {
	cliPath: string;
	cwd: string;
	sessionDir: string;
	provider?: string;
	model?: string;
	args: string[];
	customTools?: HostToolDef[];
	spawn: (agentArgs: string[]) => ChildLike;
}) => RpcClientLike;

interface PtreeLike {
	spawn(cmd: string[], options: SpawnOptionsLike): ChildLike;
}

export interface RpcOmpDriverOptions {
	/** Absolute path of the pinned omp executable (`OMPBOT_OMP_EXECUTABLE`). */
	ompExecutable: string;
	cwd: string;
	sessionDir: string;
	provider?: string;
	model?: string;
	thinking?: string;
	/** ompbot-owned `--config` overlay file, only when needed. */
	overlayConfig?: string;
	/** Extra child env, e.g. `{ OMP_WIKI_NOTE_DISABLE: "1" }`. `SLACK_`/`OMPBOT_` keys are rejected. */
	env?: Record<string, string>;
	extraArgs?: string[];
	/** Host tools registered with `set_host_tools` on start (executed by this process). */
	hostTools?: HostToolDef[];
	/** Explicit bun path; default is `Bun.which("bun")` on the PATH the child will see. */
	bunExecutable?: string;
	/** Parent environment source (tests); default `process.env`. */
	baseEnv?: Record<string, string | undefined>;
	/**
	 * Owner answers to omp's select/confirm/input/editor/ask dialogs (Slack cards). With it the driver opts in to the
	 * `ask` dialog (`set_ask_dialog enabled:true`); without it every dialog is cancelled at once.
	 */
	answerDialog?: OmpDialogAnswerer;
}

/**
 * Wire-level `extension_ui_request` frames are not exposed by RpcClient outside `login()`, so tap raw stdout. Exported
 * so the headless boundary (partial frames, dialog answers and cancels) stays unit-testable.
 *
 * Owner dialogs (`DIALOG_METHODS`) go to `answer` when one is given; without it, or when it returns `undefined`,
 * throws, or the frame does not parse, the dialog is answered `cancelled` (fail-closed). omp's `method:"cancel"`
 * (its own timeout or an aborted turn) aborts the waiting answer, and nothing is written for that dialog afterwards.
 */
export async function tapExtensionUi(
	stream: ReadableStream<Uint8Array>,
	emit: (event: OmpEvent) => void,
	reply: (frame: Record<string, unknown>) => void,
	answer?: OmpDialogAnswerer,
): Promise<void> {
	const decoder = new TextDecoder();
	const waiting = new Map<string, AbortController>();
	let buffer = "";
	try {
		for await (const chunk of stream) {
			buffer += decoder.decode(chunk, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line.includes('"extension_ui_request"')) continue;
				let frame: unknown;
				try {
					frame = JSON.parse(line);
				} catch {
					continue; // not a complete JSON frame; ignore
				}
				if (!isRecord(frame) || frame.type !== "extension_ui_request") continue;
				emit({ type: "extension_ui_request", method: frame.method, id: frame.id });
				if (frame.method === "cancel" && typeof frame.targetId === "string") {
					waiting.get(frame.targetId)?.abort();
					waiting.delete(frame.targetId);
					continue;
				}
				if (typeof frame.method !== "string" || !DIALOG_METHODS.has(frame.method)) continue;
				const request = answer === undefined ? undefined : parseDialogRequest(frame);
				if (answer === undefined || request === undefined) {
					reply({ type: "extension_ui_response", id: frame.id, cancelled: true });
					continue;
				}
				const controller = new AbortController();
				waiting.set(request.id, controller);
				void answerDialog(answer, request, controller.signal).then((response) => {
					if (controller.signal.aborted) return; // omp already settled it; a late answer must not land
					waiting.delete(request.id);
					reply({ type: "extension_ui_response", id: request.id, ...response });
				});
			}
		}
	} catch {
		// stream closed with the child
	}
	// The child is gone: nobody reads an answer anymore, so close the cards still waiting.
	for (const controller of waiting.values()) controller.abort();
}

/** The answerer's response, or `cancelled` when it has none or throws (fail-closed). */
async function answerDialog(
	answer: OmpDialogAnswerer,
	request: OmpDialogRequest,
	signal: AbortSignal,
): Promise<OmpDialogResponse> {
	try {
		return (await answer(request, signal)) ?? { cancelled: true };
	} catch {
		return { cancelled: true };
	}
}

const optionalString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** One `ask` question from the wire, or undefined when its shape is not omp's. */
function parseAskQuestion(value: unknown): OmpAskQuestion | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.question !== "string") return undefined;
	if (!Array.isArray(value.options)) return undefined;
	const options: OmpAskQuestion["options"] = [];
	for (const option of value.options) {
		if (!isRecord(option) || typeof option.label !== "string") return undefined;
		const description = optionalString(option.description);
		options.push(description === undefined ? { label: option.label } : { label: option.label, description });
	}
	const header = optionalString(value.header);
	const recommended = typeof value.recommended === "number" ? value.recommended : undefined;
	return {
		id: value.id,
		question: value.question,
		options,
		...(header === undefined ? {} : { header }),
		...(value.multi === true ? { multi: true } : {}),
		...(recommended === undefined ? {} : { recommended }),
	};
}

/** A dialog frame as an `OmpDialogRequest`; undefined when a required field is missing (it is then cancelled). */
function parseDialogRequest(frame: Record<string, unknown>): OmpDialogRequest | undefined {
	const { id, title } = frame;
	if (typeof id !== "string") return undefined;
	const timeout = typeof frame.timeout === "number" ? frame.timeout : undefined;
	const withTimeout = timeout === undefined ? {} : { timeout };
	switch (frame.method) {
		case "select":
			if (typeof title !== "string" || !Array.isArray(frame.options)) return undefined;
			if (!frame.options.every((option) => typeof option === "string")) return undefined;
			return { method: "select", id, title, options: frame.options as string[], ...withTimeout };
		case "confirm":
			if (typeof title !== "string" || typeof frame.message !== "string") return undefined;
			return { method: "confirm", id, title, message: frame.message, ...withTimeout };
		case "input": {
			if (typeof title !== "string") return undefined;
			const placeholder = optionalString(frame.placeholder);
			return {
				method: "input",
				id,
				title,
				...(placeholder === undefined ? {} : { placeholder }),
				...withTimeout,
				...(frame.secret === true ? { secret: true } : {}),
			};
		}
		case "editor": {
			if (typeof title !== "string") return undefined;
			const prefill = optionalString(frame.prefill);
			return { method: "editor", id, title, ...(prefill === undefined ? {} : { prefill }) };
		}
		case "ask": {
			if (!Array.isArray(frame.questions) || frame.questions.length === 0) return undefined;
			const questions = frame.questions.map(parseAskQuestion);
			if (questions.some((question) => question === undefined)) return undefined;
			return { method: "ask", id, questions: questions as OmpAskQuestion[], ...withTimeout };
		}
		default:
			return undefined;
	}
}

function toDriverError(error: unknown): unknown {
	if (!(error instanceof Error) || error.name !== "RpcCommandError") return error;
	const rpcCode = "code" in error && typeof error.code === "string" ? error.code : undefined;
	return new OmpDriverError(rpcCode === "unknown_since" ? "unknown_since" : "rpc_error", error.message, {
		rpcCode,
		cause: error,
	});
}

/** Dialogs only a person can answer: the owner through `answerDialog`, else cancelled at once instead of hanging the turn. */
const DIALOG_METHODS: ReadonlySet<string> = new Set(["select", "confirm", "input", "editor", "ask"]);

/**
 * `leafId()` without moving the whole session through the pipe: reads `get_entries(since=cache.since)` so only the
 * entries after the last-seen cursor are serialized, and remembers the returned `leafId`. An `unknown_since` error
 * (cursor gone after a session switch or compaction) falls back to one full read and re-seeds the cache. A `null`
 * leafId (empty session) is never fed back as a cursor: omp only treats an absent `since` as "everything".
 */
export async function leafIdViaCursor(
	getEntries: (since?: string) => Promise<OmpEntries>,
	cache: { since?: string },
): Promise<string | null> {
	try {
		const slice = await getEntries(cache.since);
		cache.since = slice.leafId ?? undefined;
		return slice.leafId;
	} catch (error) {
		if (!(error instanceof OmpDriverError) || error.code !== "unknown_since") throw error;
		const full = await getEntries(undefined);
		cache.since = full.leafId ?? undefined;
		return full.leafId;
	}
}

export class RpcOmpDriver implements OmpSessionDriver {
	readonly #options: RpcOmpDriverOptions;
	#client: RpcClientLike | undefined;
	#child: ChildLike | undefined;
	#stopping = false;
	readonly #finalListeners = new Set<(final: OmpFinal) => void>();
	readonly #eventListeners = new Set<(event: OmpEvent) => void>();
	readonly #exitListeners = new Set<(info: OmpExitInfo) => void>();
	readonly #admitted = new Set<string>();
	readonly #early = new Map<string, PromptResultFrame>();
	/** Last leafId this driver saw from a `leafId()` read; seed for the delta read in `leafIdViaCursor`. */
	readonly #leafCursor: { since?: string } = {};
	#unsubscribers: Array<() => void> = [];

	constructor(options: RpcOmpDriverOptions) {
		this.#options = options;
	}

	/** Pid of the live child (for leftover-process checks); undefined when not running. */
	get pid(): number | undefined {
		return this.#child?.pid;
	}

	async start(): Promise<void> {
		if (this.#client) throw new OmpDriverError("already_started", "driver already started");
		const options = this.#options;
		const env = buildChildEnv(options.env, options.baseEnv);

		let packageRoot: string;
		let cliPath: string;
		try {
			cliPath = realpathSync(options.ompExecutable);
			accessSync(cliPath, constants.X_OK | constants.R_OK);
			packageRoot = dirname(dirname(cliPath));
		} catch (cause) {
			throw new OmpDriverError(
				"omp_executable_missing",
				`omp executable not found or not executable: ${options.ompExecutable}`,
				{
					cause,
				},
			);
		}
		const bun = options.bunExecutable ?? Bun.which("bun", { PATH: env.PATH ?? "" });
		if (!bun || !existsSync(bun)) throw new OmpDriverError("bun_missing", "bun executable not found on PATH");
		const runtimeProblem = checkOmpRuntime(cliPath, bun);
		if (runtimeProblem) throw new OmpDriverError(runtimeProblem.code, runtimeProblem.message);

		const clientModule = join(packageRoot, "src/modes/rpc/rpc-client.ts");
		if (!existsSync(clientModule)) {
			throw new OmpDriverError("omp_rpc_client_missing", `omp RPC client source not found: ${clientModule}`);
		}
		// Dynamic import: the specifiers are runtime-resolved paths inside the user's global omp install.
		const utilsModule: unknown = await import(Bun.resolveSync("@oh-my-pi/pi-utils", packageRoot));
		const clientExports: unknown = await import(clientModule);
		if (
			!isRecord(utilsModule) ||
			!isRecord(utilsModule.ptree) ||
			!isRecord(clientExports) ||
			typeof clientExports.RpcClient !== "function"
		) {
			throw new OmpDriverError("omp_rpc_client_missing", "omp RPC client exports not recognized");
		}
		const missing = missingRpcMethods(clientExports.RpcClient);
		if (missing.length > 0) {
			throw new OmpDriverError("omp_rpc_client_missing", `omp RPC client lacks methods: ${missing.join(", ")}`);
		}
		// Boundary casts: the shapes are verified structurally above and pinned by the contract test.
		const ptree = utilsModule.ptree as unknown as PtreeLike;
		const RpcClient = clientExports.RpcClient as unknown as RpcClientCtor;

		mkdirSync(resolve(options.cwd), { recursive: true });
		mkdirSync(resolve(options.sessionDir), { recursive: true });

		const args = ["--no-title"];
		if (options.overlayConfig) args.push("--config", options.overlayConfig);
		if (options.thinking) args.push("--thinking", options.thinking);
		args.push(...(options.extraArgs ?? []));

		this.#stopping = false;
		const client = new RpcClient({
			cliPath,
			cwd: options.cwd,
			sessionDir: options.sessionDir,
			provider: options.provider,
			model: options.model,
			args,
			...(options.hostTools === undefined ? {} : { customTools: options.hostTools }),
			spawn: (agentArgs) => {
				// ptree.spawn with an explicit env replaces the environment (RpcClient's own spawn would re-merge Bun.env).
				const child = ptree.spawn([bun, cliPath, ...agentArgs], { cwd: options.cwd, env, stdin: "pipe" });
				const [forClient, forTap] = child.stdout.tee();
				void tapExtensionUi(
					forTap,
					(event) => this.#emit(event),
					(frame) => this.#writeRaw(frame),
					options.answerDialog,
				);
				this.#child = child;
				void child.exited.then(
					(code) => this.#emitExit(code, child),
					() => this.#emitExit(null, child),
				);
				return {
					pid: child.pid,
					stdin: child.stdin,
					stdout: forClient,
					peekStderr: () => child.peekStderr(),
					kill: (signal, grace) => child.kill(signal, grace),
					exited: child.exited,
				};
			},
		});
		this.#unsubscribers = [
			client.onEvent((event) => this.#emit(event)),
			// Session events never reach `onEvent`; the listener also receives agent events, so only the session-only types pass.
			client.onSessionEvent((event) => {
				if (FORWARDED_SESSION_EVENTS.has(event.type)) this.#emit(event);
			}),
			client.onPromptResult((frame) => this.#onPromptResult(frame)),
		];
		try {
			await client.start();
		} catch (error) {
			for (const off of this.#unsubscribers) off();
			this.#unsubscribers = [];
			throw error;
		}
		this.#client = client;
		// `ask` arrives as one dialog only when someone answers it; otherwise explicit false, so a default change cannot
		// enable a dialog nobody answers.
		const askDialog = options.answerDialog !== undefined;
		this.#writeRaw({ type: "set_ask_dialog", id: `ompbot-ask-dialog-${askDialog ? "on" : "off"}`, enabled: askDialog });
	}

	#emit(event: OmpEvent): void {
		for (const listener of this.#eventListeners) listener(event);
	}

	/** One JSON line to the child's stdin outside RpcClient's request tracking (replies to UI requests, `set_ask_dialog`). */
	#writeRaw(frame: Record<string, unknown>): void {
		try {
			this.#child?.stdin.write(`${JSON.stringify(frame)}\n`);
		} catch {
			// the child is gone; its exit is reported through onExit
		}
	}

	#emitExit(code: number | null, child: ChildLike): void {
		if (this.#child !== child) return;
		const info: OmpExitInfo = { code, expected: this.#stopping, stderr: child.peekStderr() };
		for (const listener of this.#exitListeners) listener(info);
	}

	#onPromptResult(frame: PromptResultFrame): void {
		const id = frame.id;
		if (id === undefined) return;
		if (!this.#admitted.has(id)) {
			// `prompt()` has not resolved yet; hold the result so onFinal never precedes it.
			this.#early.set(id, frame);
			return;
		}
		void this.#finalize(id, frame);
	}

	async #finalize(opRef: string, frame: PromptResultFrame): Promise<void> {
		this.#admitted.delete(opRef);
		const final: OmpFinal = { opRef, status: frame.status, text: "" };
		if (frame.error) final.error = frame.error.message;
		if (frame.status === "completed" && this.#client) {
			try {
				final.text = (await this.#client.getLastAssistantText()) ?? "";
			} catch (error) {
				final.status = "error";
				final.error = `get_last_assistant_text failed: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		for (const listener of this.#finalListeners) listener(final);
	}

	#require(): RpcClientLike {
		if (!this.#client) throw new OmpDriverError("not_started", "driver not started");
		return this.#client;
	}

	async #call<T>(run: (client: RpcClientLike) => Promise<T>): Promise<T> {
		try {
			return await run(this.#require());
		} catch (error) {
			throw toDriverError(error);
		}
	}

	async prompt(text: string): Promise<string> {
		const opRef = await this.#call((client) => client.prompt(text));
		this.#admitted.add(opRef);
		const early = this.#early.get(opRef);
		if (early) {
			this.#early.delete(opRef);
			void this.#finalize(opRef, early);
		}
		return opRef;
	}

	steer(text: string): Promise<void> {
		return this.#call((client) => client.steer(text));
	}

	abort(): Promise<void> {
		return this.#call((client) => client.abort());
	}

	newSession(): Promise<{ cancelled: boolean }> {
		return this.#call((client) => client.newSession());
	}

	async openSession(): Promise<OmpOpenResult> {
		const result = await this.#call((client) => client.openSession(resolve(this.#options.sessionDir)));
		return { resumed: result.resumed, sessionId: result.sessionId };
	}

	async state(): Promise<OmpState> {
		const raw = await this.#call((client) => client.getState());
		return {
			sessionId: raw.sessionId,
			sessionFile: raw.sessionFile,
			idle: !raw.isStreaming && !raw.isCompacting,
			settled: raw.isSettled,
			queuedMessageCount: raw.queuedMessageCount,
			messageCount: raw.messageCount,
			model: raw.model?.id === undefined ? undefined : `${raw.model.provider ?? "?"}/${raw.model.id}`,
			...(raw.thinkingLevel === undefined ? {} : { thinking: raw.thinkingLevel }),
		};
	}

	switchSession(sessionFile: string): Promise<{ cancelled: boolean }> {
		return this.#call((client) => client.switchSession(resolve(sessionFile)));
	}

	async availableModels(): Promise<string[]> {
		const models = await this.#call((client) => client.getAvailableModels());
		return models.map((model) => `${model.provider}/${model.id}`);
	}

	async setModel(model: string): Promise<string> {
		const slash = model.indexOf("/");
		if (slash <= 0 || slash === model.length - 1) {
			throw new OmpDriverError("rpc_error", `model must be provider/id: ${model}`);
		}
		const set = await this.#call((client) => client.setModel(model.slice(0, slash), model.slice(slash + 1)));
		return `${set.provider}/${set.id}`;
	}

	thinkingLevels(): Promise<string[]> {
		return this.#call((client) => client.getAvailableThinkingLevels());
	}

	setThinking(level: string): Promise<void> {
		return this.#call((client) => client.setThinkingLevel(level));
	}

	async compact(instructions?: string): Promise<OmpCompactResult> {
		const result = await this.#call((client) => client.compact(instructions));
		return { tokensBefore: result.tokensBefore, summary: result.summary };
	}

	async leafId(): Promise<string | null> {
		// mailbox.ts reads the cursor per message/per steer; keep it a delta read instead of a whole-session one.
		return leafIdViaCursor((since) => this.entriesSince(since), this.#leafCursor);
	}

	entriesSince(since?: string): Promise<OmpEntries> {
		return this.#call((client) => client.getEntries(since));
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
		const client = this.#client;
		if (!client) return;
		this.#stopping = true;
		this.#client = undefined;
		for (const off of this.#unsubscribers) off();
		this.#unsubscribers = [];
		await client.stop();
		this.#admitted.clear();
		this.#early.clear();
		this.#child = undefined;
	}
}
