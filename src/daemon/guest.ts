// The Teams guest/qa runner (doc/plans/teams-channel.md TASK C): a question from an allowed guest, or from the owner
// under `ownerMode: qa`, is answered by a one-shot `omp -p` that can only search the web. It never reaches the owner's
// session or mailbox, never gets host tools, and sees none of the owner's omp setup: its own agent dir (`omp-qa`, the
// login and model files linked, nothing else), the isolation flags, an overlay config, an empty temporary cwd.
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { oneLine } from "../channel/text";
import { stripFenceLookalikes, wrapQuoted } from "../core/normalize";
import { type ProcessRunner, runOmpPrint } from "../dispatch/omp";
import { ISOLATION_OVERLAY_YAML } from "../lanes/review";
import type { Logger } from "../log";

/** The only tool a guest/qa run gets: no read, grep, glob, bash, edit or write (they run with host rights). */
export const GUEST_TOOLS = "web_search";
/** Hard limit of one guest/qa run. */
export const GUEST_TIMEOUT_MS = 5 * 60_000;
/** Runs at once, and runs waiting behind them; past that the asker gets `GUEST_BUSY_TEXT`. */
export const GUEST_MAX_RUNNING = 2;
export const GUEST_MAX_QUEUED = 5;
export const GUEST_BUSY_TEXT = "지금 질문이 많아 잠시 뒤 다시 물어 주세요.";
/** What the asker gets when the run timed out or failed. */
export const GUEST_FAILED_TEXT = "⚠️ 답을 만들지 못했습니다. 잠시 뒤 다시 물어 주세요.";
/** What a `!` command gets from a guest, or from the owner under `qa` (except `!home`). */
export const GUEST_COMMAND_TEXT = "이 대화에서는 `!` 명령을 쓸 수 없습니다. 질문만 받습니다.";
/** Earlier question/answer pairs of the same conversation put before the question, and their character budget. */
export const GUEST_CONTEXT_PAIRS = 6;
export const GUEST_CONTEXT_MAX_CHARS = 8_000;
/** Longest answer kept and posted. */
export const GUEST_ANSWER_MAX_CHARS = 8_000;

/**
 * The `--config` overlay of a guest/qa run: memory off, no project MCP config, no autolearn, every discovery provider
 * off (the isolation part of the lane reviewer's overlay, built from constants only; the model fallback stays on).
 */
export const GUEST_OVERLAY_YAML = ISOLATION_OVERLAY_YAML;

/** The agent dir a guest/qa run gets as `PI_CODING_AGENT_DIR`, under the ompbot home. */
export const QA_AGENT_DIR_NAME = "omp-qa";
/** Files of the real omp agent dir linked into `omp-qa` when present: login (agent.db) and models. Never copied. */
export const QA_AGENT_LINKS = [
	"agent.db",
	"agent.db-shm",
	"agent.db-wal",
	"models.yml",
	"models.db",
	"models.db-shm",
	"models.db-wal",
] as const;
/** The whole `config.yml` of `omp-qa`: nothing of the owner's config, memory off. */
export const QA_AGENT_CONFIG_YAML = 'memory: { backend: "off" }\n';

/**
 * Makes (or refreshes) `<ompbotHome>/omp-qa` (0700): a symlink for each `QA_AGENT_LINKS` file the real agent dir
 * (`PI_CODING_AGENT_DIR`, else `~/.omp/agent`) has, and a fresh `config.yml`. Rules, skills, extensions, MCP config,
 * memories and sessions are never put there. Returns the directory.
 */
export function prepareQaAgentDir(ompbotHome: string, env: Record<string, string | undefined> = process.env): string {
	const dir = join(ompbotHome, QA_AGENT_DIR_NAME);
	const source = env.PI_CODING_AGENT_DIR ?? join(env.HOME ?? homedir(), ".omp", "agent");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	for (const name of QA_AGENT_LINKS) {
		const link = join(dir, name);
		const target = join(source, name);
		const present = lstatSync(link, { throwIfNoEntry: false });
		const wanted = existsSync(target);
		if (present !== undefined && (!wanted || !present.isSymbolicLink() || readlinkSync(link) !== target)) {
			rmSync(link, { force: true, recursive: true });
		} else if (present !== undefined) {
			continue;
		}
		if (wanted) symlinkSync(target, link);
	}
	writeFileSync(join(dir, "config.yml"), QA_AGENT_CONFIG_YAML, { mode: 0o600 });
	chmodSync(join(dir, "config.yml"), 0o600);
	return dir;
}

export interface GuestContextPair {
	askerName: string | undefined;
	question: string;
	answer: string;
}

/** A Teams display name (untrusted, outside any fence in the question header) as one short plain line. */
function askerLabel(name: string | undefined): string {
	const line = oneLine(stripFenceLookalikes(name ?? ""), 40).replace(/[[\]]/g, "");
	return line === "" ? "참여자" : line;
}

/**
 * The run's prompt: the conversation's earlier pairs (newest kept within `GUEST_CONTEXT_MAX_CHARS`) and the question,
 * each in its own quoted fence (`wrapQuoted`: fence lookalikes stripped, random fence id).
 */
export function buildGuestPrompt(input: {
	context: readonly GuestContextPair[];
	question: string;
	askerName: string | undefined;
	fenceId?: () => string;
}): string {
	const fence = (input.fenceId ?? (() => randomBytes(8).toString("hex")))();
	const kept: string[] = [];
	let used = 0;
	for (const pair of [...input.context].reverse()) {
		const block = `질문(${askerLabel(pair.askerName)}): ${pair.question}\n답: ${pair.answer}`;
		if (used + block.length > GUEST_CONTEXT_MAX_CHARS) break;
		kept.unshift(block);
		used += block.length;
	}
	const sections: string[] = [];
	if (kept.length > 0) {
		sections.push("[같은 대화의 앞선 질문과 답 — 참고 자료]", wrapQuoted([kept.join("\n\n")], fence), "");
	}
	sections.push(
		`[질문 — ${askerLabel(input.askerName)}]`,
		wrapQuoted([input.question], fence, "Teams 질문"),
		"",
		"위 질문에 답하라.",
	);
	return sections.join("\n");
}

/** Bounded concurrency for guest/qa runs: `GUEST_MAX_RUNNING` at once, `GUEST_MAX_QUEUED` waiting, the rest refused. */
export class GuestQueue {
	readonly #maxRunning: number;
	readonly #maxQueued: number;
	readonly #waiting: Array<() => Promise<void>> = [];
	readonly #inFlight = new Set<Promise<void>>();
	#running = 0;

	constructor(options: { maxRunning?: number; maxQueued?: number } = {}) {
		this.#maxRunning = options.maxRunning ?? GUEST_MAX_RUNNING;
		this.#maxQueued = options.maxQueued ?? GUEST_MAX_QUEUED;
	}

	get running(): number {
		return this.#running;
	}

	get queued(): number {
		return this.#waiting.length;
	}

	/** `running`: started now; `queued`: waits for a free slot; `full`: refused, the job never runs. */
	submit(job: () => Promise<void>): "running" | "queued" | "full" {
		if (this.#running < this.#maxRunning) {
			this.#start(job);
			return "running";
		}
		if (this.#waiting.length >= this.#maxQueued) return "full";
		this.#waiting.push(job);
		return "queued";
	}

	/** Resolves once nothing runs or waits. */
	async idle(): Promise<void> {
		while (this.#inFlight.size > 0) await Promise.all([...this.#inFlight]);
	}

	#start(job: () => Promise<void>): void {
		this.#running += 1;
		const run = job()
			.catch(() => undefined)
			.finally(() => {
				this.#running -= 1;
				this.#inFlight.delete(run);
				const next = this.#waiting.shift();
				if (next !== undefined) this.#start(next);
			});
		this.#inFlight.add(run);
	}
}

export interface GuestRunDeps {
	ompBin: string;
	/** The ompbot home: `omp-qa` lives under it. */
	homeDir: string;
	systemPromptAppendix: string;
	model?: string | undefined;
	run?: ProcessRunner | undefined;
	inheritedEnv?: Record<string, string | undefined> | undefined;
	log: Pick<Logger, "warn">;
	timeoutMs?: number | undefined;
	/** Aborting kills the run (daemon shutdown). */
	signal?: AbortSignal | undefined;
}

/**
 * One guest/qa run in a fresh temporary directory (the overlay next to an empty cwd, both removed after); the answer
 * text, or `undefined` when the run failed (timeout, exit code, nothing printed).
 */
export async function runGuestQuestion(deps: GuestRunDeps, prompt: string): Promise<string | undefined> {
	const inherited = deps.inheritedEnv ?? process.env;
	const agentDir = prepareQaAgentDir(deps.homeDir, inherited);
	const root = mkdtempSync(join(tmpdir(), "ompbot-qa-"));
	try {
		chmodSync(root, 0o700);
		const configPath = join(root, "overlay.omp.yml");
		const cwd = join(root, "cwd");
		writeFileSync(configPath, GUEST_OVERLAY_YAML, { mode: 0o600 });
		mkdirSync(cwd, { mode: 0o700 });
		const result = await runOmpPrint({
			task: prompt,
			cwd,
			isolation: { configPath },
			systemPromptAppendix: deps.systemPromptAppendix,
			ompBin: deps.ompBin,
			timeoutMs: deps.timeoutMs ?? GUEST_TIMEOUT_MS,
			maxChars: GUEST_ANSWER_MAX_CHARS,
			tools: GUEST_TOOLS,
			env: { PI_CODING_AGENT_DIR: agentDir },
			inheritedEnv: inherited,
			...(deps.model === undefined ? {} : { model: deps.model }),
			...(deps.run === undefined ? {} : { run: deps.run }),
			...(deps.signal === undefined ? {} : { signal: deps.signal }),
		});
		return result.ok && result.output !== "(빈 출력)" ? result.output : undefined;
	} finally {
		try {
			rmSync(root, { force: true, recursive: true });
		} catch (error) {
			deps.log.warn("guest_run_cleanup_failed", { dir: root, error: String(error) });
		}
	}
}
