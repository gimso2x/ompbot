import { spawn } from "node:child_process";
import { recordProcessCall } from "./audit";

export interface RunProcessResult {
	code: number | null;
	stdout: string;
	/** Tail of stderr; herdr writes its `{"error":{code,message}}` here. Fakes may leave it out. */
	stderr?: string;
	timedOut: boolean;
}

export interface RunProcessOptions {
	cwd?: string;
	timeoutMs?: number;
	/** Collects up to this many stdout characters; a longer tail is cut, the run still succeeds. */
	stdoutCap?: number;
	/** Drops Slack and bot credential prefixes plus inherited git overrides, like every other child ompbot spawns. */
	env?: Record<string, string>;
}

export type ProcessRunner = (cmd: string[], opts: RunProcessOptions) => Promise<RunProcessResult>;

/** Default stdout collection cap; callers that legitimately need more (a whole task-branch diff) pass `stdoutCap`. */
export const DEFAULT_STDOUT_CAP = 64_000;

/** The bot's own child hygiene: no Slack/bot credentials, no inherited git redirects. */
export function dispatchEnv(inherited: Record<string, string | undefined>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(inherited)) {
		if (value === undefined) continue;
		if (key.startsWith("SLACK_") || key.startsWith("OMPBOT_") || key.startsWith("GIT_")) continue;
		env[key] = value;
	}
	env.LC_ALL = env.LC_ALL ?? "C.UTF-8";
	return env;
}

const spawnProcess: ProcessRunner = (cmd, opts) => {
	const child = spawn(cmd[0] as string, cmd.slice(1), {
		cwd: opts.cwd,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
		env: opts.env,
	});
	let stdout = "";
	let timedOut = false;
	const stdoutCap = opts.stdoutCap ?? DEFAULT_STDOUT_CAP;
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		if (stdout.length < stdoutCap) stdout += chunk;
	});
	let stderr = "";
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		stderr = `${stderr}${chunk}`.slice(-4_000);
	});
	const done = Promise.withResolvers<{ code: number | null; spawnError?: string }>();
	child.once("error", (error) => done.resolve({ code: null, spawnError: error.message }));
	child.once("close", (code) => done.resolve({ code }));
	const timer = setTimeout(() => {
		timedOut = true;
		try {
			if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	}, opts.timeoutMs ?? 600_000);
	return done.promise.then(({ code, spawnError }) => {
		clearTimeout(timer);
		if (spawnError !== undefined) return { code: null, stdout: `spawn failed: ${spawnError}`, timedOut };
		return { code, stdout, stderr, timedOut };
	});
};

/**
 * One process with a hard timeout: the whole process group is killed, stdout is capped by the collector. Every
 * external call of the bot passes here (herdr, ssh, task git), so this is where the dispatch audit line is written.
 */
export const realProcessRunner: ProcessRunner = async (cmd, opts) => {
	const startedAt = Date.now();
	const result = await spawnProcess(cmd, opts);
	recordProcessCall(cmd, result, Date.now() - startedAt);
	return result;
};

export interface OmpPrintOptions {
	task: string;
	cwd: string;
	/** Extra system-prompt text (the same safety floors the daemon's children get). */
	systemPromptAppendix: string;
	ompBin: string;
	timeoutMs?: number;
	maxChars?: number;
	inheritedEnv?: Record<string, string | undefined>;
	run?: ProcessRunner;
}

/** `omp -p <task>`: one-shot agent run for simple tasks. Output is capped; timeout kills the process group. */
export async function runOmpPrint(options: OmpPrintOptions): Promise<{ ok: boolean; output: string }> {
	const maxChars = options.maxChars ?? 8_000;
	const result = await (options.run ?? realProcessRunner)(
		[options.ompBin, "-p", options.task, "--append-system-prompt", options.systemPromptAppendix],
		{
			cwd: options.cwd,
			timeoutMs: options.timeoutMs ?? 600_000,
			env: dispatchEnv(options.inheritedEnv ?? process.env),
		},
	);
	const suffix = result.timedOut ? "\n\n[시간 초과로 중단됨 — 출력 일부만 수집]" : "";
	const output = `${result.stdout.trim().slice(0, maxChars)}${suffix}`.trim();
	return { ok: !result.timedOut && result.code === 0, output: output === "" ? "(빈 출력)" : output };
}

export interface HerdrRunnerOptions {
	herdrBin?: string;
	cwd?: string;
	timeoutMs?: number;
	run?: ProcessRunner;
	/** Run herdr on a remote host over ssh (hub fleet pattern); args are appended after the ssh command. */
	sshTarget?: string;
}

/** POSIX single-quote one argument so the remote login shell (ssh joins argv with spaces) sees it verbatim. */
export function remoteShellQuote(arg: string): string {
	return `'${arg.replaceAll("'", "'\\''")}'`;
}

/**
 * The ssh argv for running `bin args…` on a remote host. Every remote word is quoted; the only exception is a
 * `--cwd` value of exactly `~`, left bare so the remote shell expands it (the `workDir ?? "~"` fallback).
 */
export function herdrSshArgv(sshTarget: string, bin: string, args: string[]): string[] {
	const remote = [remoteShellQuote(bin)];
	args.forEach((arg, index) => {
		remote.push(arg === "~" && args[index - 1] === "--cwd" ? arg : remoteShellQuote(arg));
	});
	return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", sshTarget, "--", ...remote];
}

/** Local herdr binary (config `herdr.bin`); restart-bound, so the daemon sets it once at start. */
let localHerdrBin: string | undefined;

/** Sets the binary local herdr calls run (no `sshTarget`, no per-call `herdrBin`); `undefined` → `herdr` on PATH. */
export function setLocalHerdrBin(bin: string | undefined): void {
	localHerdrBin = bin;
}

async function herdrRun(args: string[], options: HerdrRunnerOptions): Promise<RunProcessResult> {
	const bin = options.herdrBin ?? (options.sshTarget === undefined ? localHerdrBin : undefined) ?? "herdr";
	const cmd = options.sshTarget === undefined ? [bin, ...args] : herdrSshArgv(options.sshTarget, bin, args);
	return (options.run ?? realProcessRunner)(cmd, {
		timeoutMs: options.timeoutMs ?? 120_000,
		cwd: options.cwd,
	});
}

/** Owner agent names: short, lowercase, no surprises — they become herdr agent names and tab labels. */
export const OWNER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Shapes of herdr's JSON outputs (outside-controlled data, read at one boundary). */
type HerdrAgentList = {
	result?: { agents?: Array<{ name?: string; pane_id?: string; agent_status?: string }> };
};
type HerdrWorkspaceList = { result?: { workspaces?: Array<{ workspace_id?: string; label?: string }> } };
type HerdrWorkspaceCreated = {
	result?: { workspace?: { workspace_id?: string }; tab?: { tab_id?: string }; root_pane?: { pane_id?: string } };
};
type HerdrTabCreated = { result?: { tab?: { tab_id?: string }; root_pane?: { pane_id?: string } } };

/** JSON.parse at the herdr output boundary: unparseable output reads as `undefined`, never throws. */
function parseHerdrJson<T>(stdout: string): T | undefined {
	try {
		return JSON.parse(stdout) as T;
	} catch {
		return undefined;
	}
}

/**
 * Why a herdr call failed, at most `max` chars: herdr's stderr `{"error":{code,message}}` as `code: message`
 * (e.g. `agent_blocked` when the agent waits on an approval), else the raw stderr/stdout, else the exit code.
 */
function herdrFailure(result: RunProcessResult, max = 160): string {
	if (result.timedOut) return "timed out";
	const stderr = result.stderr?.trim() ?? "";
	const error = parseHerdrJson<{ error?: { code?: unknown; message?: unknown } }>(stderr)?.error;
	const detail =
		typeof error?.code === "string"
			? `${error.code}${typeof error.message === "string" ? `: ${error.message}` : ""}`
			: stderr || result.stdout.trim() || `exit ${result.code}`;
	return detail.slice(0, max);
}

/**
 * `herdr workspace create --no-focus` (the owner's view stays where it is): returns the workspace's root pane id (the
 * agent needs a shell prompt pane) and the workspace id, so a failed start can close what it created.
 */
export async function herdrCreateWorkspace(
	cwd: string,
	label: string,
	options: HerdrRunnerOptions = {},
): Promise<{ paneId: string; workspaceId: string | undefined } | { error: string }> {
	const result = await herdrRun(["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"], options);
	if (result.code !== 0) return { error: `workspace create failed: ${herdrFailure(result)}` };
	const parsed = parseHerdrJson<HerdrWorkspaceCreated>(result.stdout);
	if (parsed === undefined) return { error: "workspace create output is not JSON" };
	const paneId = parsed.result?.root_pane?.pane_id;
	const workspaceId = parsed.result?.workspace?.workspace_id;
	return paneId
		? { paneId, workspaceId: workspaceId === "" ? undefined : workspaceId }
		: { error: "workspace create returned no root pane" };
}

/**
 * Starts a herdr-managed omp agent in a fresh workspace and hands it the task. The agent keeps running in its
 * pane after this returns — progress lives in the pane, readable with `herdr agent read <name>`.
 */
export async function herdrStartAgent(input: {
	name: string;
	task: string;
	cwd: string;
	options?: HerdrRunnerOptions;
}): Promise<{ ok: true; agentName: string; paneId: string } | { ok: false; error: string }> {
	const { name, task, cwd } = input;
	const options = input.options ?? {};
	const label = `ompbot · ${name}`;
	const ws = await herdrCreateWorkspace(cwd, label, options);
	if ("error" in ws) return { ok: false, error: ws.error };
	const started = await herdrRun(
		["agent", "start", name, "--kind", "omp", "--pane", ws.paneId, "--timeout", "60000"],
		options,
	);
	if (started.code !== 0) {
		// Like the remote start: close only the workspace this call created. A failed prompt leaves the agent up.
		if (ws.workspaceId !== undefined) await herdrRun(["workspace", "close", ws.workspaceId], options);
		return { ok: false, error: `agent start failed: ${herdrFailure(started)}` };
	}
	const prompted = await herdrRun(["agent", "prompt", name, task], options);
	if (prompted.code !== 0) return { ok: false, error: `agent prompt failed: ${herdrFailure(prompted)}` };
	return { ok: true, agentName: name, paneId: ws.paneId };
}

export interface RemoteHerdrStartInput {
	sshTarget: string;
	name: string;
	task: string;
	cwd: string;
	/** Shared owners-workspace label per host (hub fleet OWNER_WS_LABEL pattern). Default "ompbot-owners". */
	workspacesLabel?: string;
	options?: HerdrRunnerOptions;
}

export interface RemoteHerdrStartResult {
	ok: true;
	agentName: string;
	paneId: string;
	tabId: string;
	workspaceId: string;
	createdWorkspace: boolean;
}

/**
 * One remote agent start, following the hub fleet owner-start flow: reuse the shared owners workspace, create a
 * tab in it, rename, `agent start --kind omp`, then deliver the prompt. On a failed start the tab/workspace this
 * call created is closed again. Not concurrency-safe per host: nothing serializes remote starts, so two starts of
 * one name at once can both pass the name check.
 */
export async function herdrRemoteStart(
	input: RemoteHerdrStartInput,
): Promise<RemoteHerdrStartResult | { ok: false; error: string }> {
	const { sshTarget, name, task, cwd } = input;
	const run = input.options?.run;
	const herdrBin = input.options?.herdrBin;
	const runner: HerdrRunnerOptions = {
		sshTarget,
		...(run === undefined ? {} : { run }),
		...(herdrBin === undefined ? {} : { herdrBin }),
	};

	const list = await herdrRun(["agent", "list"], runner);
	if (list.code !== 0) return { ok: false, error: `agent list failed: ${herdrFailure(list, 120)}` };
	const agentList = parseHerdrJson<HerdrAgentList>(list.stdout);
	if (agentList?.result?.agents?.some((agent) => agent.name === name) === true) {
		return { ok: false, error: `herdr already has an agent named ${name}` };
	}

	const label = input.workspacesLabel ?? "ompbot-owners";
	const wsList = await herdrRun(["workspace", "list"], runner);
	if (wsList.code !== 0) return { ok: false, error: `workspace list failed: ${herdrFailure(wsList)}` };
	const listedWorkspaces = parseHerdrJson<HerdrWorkspaceList>(wsList.stdout);
	let workspaceId =
		listedWorkspaces?.result?.workspaces?.find((workspace) => workspace.label === label)?.workspace_id ?? "";

	let createdWorkspace = false;
	let tabId = "";
	let paneId = "";
	if (workspaceId === "") {
		const created = await herdrRun(["workspace", "create", "--label", label, "--cwd", cwd, "--no-focus"], runner);
		if (created.code !== 0) return { ok: false, error: `workspace create failed: ${herdrFailure(created)}` };
		const createdWs = parseHerdrJson<HerdrWorkspaceCreated>(created.stdout);
		workspaceId = createdWs?.result?.workspace?.workspace_id ?? "";
		tabId = createdWs?.result?.tab?.tab_id ?? "";
		paneId = createdWs?.result?.root_pane?.pane_id ?? "";
		createdWorkspace = true;
		if (workspaceId === "" || paneId === "") return { ok: false, error: "workspace create returned no ids" };
	} else {
		const tab = await herdrRun(
			["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", name, "--no-focus"],
			runner,
		);
		if (tab.code !== 0) return { ok: false, error: `tab create failed: ${herdrFailure(tab)}` };
		const createdTab = parseHerdrJson<HerdrTabCreated>(tab.stdout);
		tabId = createdTab?.result?.tab?.tab_id ?? "";
		paneId = createdTab?.result?.root_pane?.pane_id ?? "";
		if (tabId === "" || paneId === "") return { ok: false, error: "tab create returned no ids" };
	}
	if (workspaceId === "" || tabId === "") {
		return { ok: false, error: createdWorkspace ? "workspace create returned no ids" : "tab create returned no ids" };
	}

	await herdrRun(["tab", "rename", tabId, name], runner);
	const start = await herdrRun(
		["agent", "start", name, "--kind", "omp", "--pane", paneId, "--timeout", "60000"],
		runner,
	);
	if (start.code !== 0) {
		// Hub fleet cleanup: close only what this call created above.
		await herdrRun(createdWorkspace ? ["workspace", "close", workspaceId] : ["tab", "close", tabId], runner);
		return { ok: false, error: `agent start failed: ${herdrFailure(start, 140)}` };
	}
	const prompted = await herdrRun(["agent", "prompt", name, task], runner);
	if (prompted.code !== 0) return { ok: false, error: `agent prompt failed: ${herdrFailure(prompted, 140)}` };
	return { ok: true, agentName: name, paneId, tabId, workspaceId, createdWorkspace };
}

/** Whether herdr has an agent of that name; a herdr that cannot be asked is an error, not "no". */
export async function herdrAgentExists(
	name: string,
	options: HerdrRunnerOptions = {},
): Promise<{ ok: true; exists: boolean } | { ok: false; error: string }> {
	const list = await herdrRun(["agent", "list"], options);
	if (list.code !== 0) return { ok: false, error: `agent list failed: ${herdrFailure(list, 120)}` };
	const parsed = parseHerdrJson<HerdrAgentList>(list.stdout);
	if (parsed === undefined) return { ok: false, error: "agent list output is not JSON" };
	return { ok: true, exists: parsed.result?.agents?.some((agent) => agent.name === name) === true };
}

/** The pane an agent runs in (its board card key); `undefined` when herdr cannot be asked or has no such agent. */
export async function herdrAgentPane(name: string, options: HerdrRunnerOptions = {}): Promise<string | undefined> {
	const list = await herdrRun(["agent", "list"], options);
	if (list.code !== 0) return undefined;
	const pane = parseHerdrJson<HerdrAgentList>(list.stdout)?.result?.agents?.find(
		(agent) => agent.name === name,
	)?.pane_id;
	return typeof pane === "string" && pane !== "" ? pane : undefined;
}

/** herdr's `agent_status` values (`herdr agent wait --until`), plus `gone` for a name the list does not have. */
export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown" | "gone";

export type HerdrAgentStatusResult = { ok: true; status: HerdrAgentStatus } | { ok: false; error: string };

const HERDR_REPORTED_STATUSES: Record<Exclude<HerdrAgentStatus, "gone">, true> = {
	idle: true,
	working: true,
	blocked: true,
	done: true,
	unknown: true,
};

const isReportedStatus = (value: unknown): value is Exclude<HerdrAgentStatus, "gone"> =>
	typeof value === "string" && Object.hasOwn(HERDR_REPORTED_STATUSES, value);

/** What herdr says an agent is doing; a herdr that cannot be asked is an error, a missing name is `gone`. */
export async function herdrAgentStatus(
	name: string,
	options: HerdrRunnerOptions = {},
): Promise<HerdrAgentStatusResult> {
	const list = await herdrRun(["agent", "list"], options);
	if (list.code !== 0) return { ok: false, error: `agent list failed: ${herdrFailure(list, 120)}` };
	const parsed = parseHerdrJson<HerdrAgentList>(list.stdout);
	if (parsed === undefined) return { ok: false, error: "agent list output is not JSON" };
	const agent = parsed.result?.agents?.find((entry) => entry.name === name);
	if (agent === undefined) return { ok: true, status: "gone" };
	return { ok: true, status: isReportedStatus(agent.agent_status) ? agent.agent_status : "unknown" };
}

/** How long a follow-up waits for herdr to see the agent start (working) or stop on a question (blocked). */
const PROMPT_CONFIRM_TIMEOUT_MS = 15_000;

/** herdr error codes after which the prompt may have landed although no start was seen. */
const UNCONFIRMED_CODES: Record<string, true> = { agent_prompt_stalled: true, timeout: true };

export interface HerdrPromptResult {
	ok: boolean;
	error?: string;
	/** Delivered as far as herdr knows, but the agent was not seen to start: the text may or may not be in. */
	unconfirmed?: true;
}

/**
 * Delivers a follow-up prompt to an already-running herdr agent and waits (bounded) until herdr sees it working or
 * blocked. A herdr without `--wait` (usage error naming it) gets the plain prompt once instead.
 */
export async function herdrPromptExisting(
	name: string,
	task: string,
	options: HerdrRunnerOptions = {},
): Promise<HerdrPromptResult> {
	const waited = await herdrRun(
		[
			"agent",
			"prompt",
			name,
			task,
			"--wait",
			"--until",
			"working",
			"--until",
			"blocked",
			"--timeout",
			String(PROMPT_CONFIRM_TIMEOUT_MS),
		],
		options,
	);
	if (waited.code === 0) return { ok: true };
	const code = parseHerdrJson<{ error?: { code?: unknown } }>(waited.stderr?.trim() ?? "")?.error?.code;
	if (typeof code === "string" && Object.hasOwn(UNCONFIRMED_CODES, code)) {
		return { ok: false, unconfirmed: true, error: `agent prompt unconfirmed: ${code}` };
	}
	if (code === undefined && !waited.timedOut && waited.stderr?.includes("--wait") === true) {
		const plain = await herdrRun(["agent", "prompt", name, task], options);
		return plain.code === 0 ? { ok: true } : { ok: false, error: `agent prompt failed: ${herdrFailure(plain)}` };
	}
	return { ok: false, error: `agent prompt failed: ${herdrFailure(waited)}` };
}

/** Tails an agent's terminal output (bounded) — how the owner checks on a dispatched herdr agent. */
export async function herdrReadAgent(
	name: string,
	options: HerdrRunnerOptions = {},
): Promise<{ ok: boolean; output?: string; error?: string }> {
	const result = await herdrRun(["agent", "read", name], options);
	return result.code === 0
		? { ok: true, output: result.stdout.trim().slice(-4_000) }
		: { ok: false, error: herdrFailure(result) };
}
