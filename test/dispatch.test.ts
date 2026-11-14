import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	dispatchEnv,
	herdrAgentExists,
	herdrAgentStatus,
	herdrPromptExisting,
	herdrRemoteStart,
	herdrSshArgv,
	herdrStartAgent,
	type ProcessRunner,
	type RunProcessResult,
	realProcessRunner,
	remoteShellQuote,
	runOmpPrint,
	setLocalHerdrBin,
} from "../src/dispatch/omp";
import { buildDispatchTool, type DispatchToolDeps } from "../src/dispatch/tool";
import type { ApprovalResult } from "../src/safety/approval";
import { openStore } from "../src/store/db";

function runner(routes: Array<{ match: (cmd: string[]) => boolean; respond: (cmd: string[]) => RunProcessResult }>) {
	return async (cmd: string[]): Promise<RunProcessResult> => {
		const hit = routes.find((route) => route.match(cmd));
		if (hit === undefined) throw new Error(`unexpected command: ${cmd.join(" ")}`);
		return hit.respond(cmd);
	};
}

/** Rejects when `promise` has not settled within `ms` (a bound on the wait, never a fixed delay). */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	const limit = Promise.withResolvers<never>();
	// Fires only on failure: the bound of the wait, the test never waits for it.
	const timer = setTimeout(() => limit.reject(new Error(`${what} did not happen within ${ms} ms`)), ms);
	return Promise.race([promise, limit.promise]).finally(() => clearTimeout(timer));
}

/** Resolves once `dir/name` exists (watched, not polled). */
function fileAppears(dir: string, name: string): Promise<void> {
	const done = Promise.withResolvers<void>();
	const watcher = watch(dir, () => {
		if (existsSync(join(dir, name))) done.resolve();
	});
	if (existsSync(join(dir, name))) done.resolve();
	return done.promise.finally(() => watcher.close());
}

/** Whether `pid` is a live process (gone or a zombie waiting to be reaped = not alive). */
function alive(pid: number): boolean {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
	} catch {
		return false;
	}
}

/**
 * Resolves once `pid` is gone. The runner returns when the shell exits, right after it sent SIGKILL to the whole
 * group; the kernel finishes killing each member on its own schedule, so a grandchild can still read as alive for a
 * moment. Yields to the event loop (no timer) and fails at `ms`.
 */
async function goneWithin(pid: number, ms: number): Promise<void> {
	const deadline = Date.now() + ms;
	while (alive(pid)) {
		if (Date.now() > deadline) throw new Error(`process ${pid} still alive after ${ms} ms`);
		const tick = Promise.withResolvers<void>();
		setImmediate(tick.resolve);
		await tick.promise;
	}
}

describe("realProcessRunner signal", () => {
	test("an aborted signal kills the child's process group, grandchild included, and the run returns", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ompbot-abort-"));
		let grandchild: number | undefined;
		try {
			const ready = fileAppears(dir, "pid");
			const abort = new AbortController();
			const run = realProcessRunner(["sh", "-c", "sleep 300 & echo $! > pid.tmp && mv pid.tmp pid; wait"], {
				cwd: dir,
				timeoutMs: 600_000,
				signal: abort.signal,
			});
			await within(ready, 4_000, "the grandchild pid file");
			grandchild = Number(readFileSync(join(dir, "pid"), "utf8").trim());
			expect(alive(grandchild)).toBe(true);
			abort.abort();
			const result = await within(run, 4_000, "the aborted run returning");
			expect(result.timedOut).toBe(false);
			expect(result.code).toBeNull();
			await goneWithin(grandchild, 4_000);
		} finally {
			// A runner that ignored the signal leaves the sleep behind: clean it up so the failure is the only effect.
			if (grandchild !== undefined && alive(grandchild)) process.kill(grandchild, "SIGKILL");
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("dispatchEnv", () => {
	test("drops Slack/bot/git prefixes, keeps the rest", () => {
		const env = dispatchEnv({
			PATH: "/usr/bin",
			SLACK_BOT_TOKEN: "x",
			OMPBOT_HOME: "/x",
			GIT_DIR: "/x",
			HOME: "/home/u",
		});
		expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/u", LC_ALL: "C.UTF-8", OMP_NONINTERACTIVE: "1" });
	});
});

describe("runOmpPrint (simple mode)", () => {
	test("runs omp -p with the floors appendix, hygiene env, and capped output", async () => {
		let seen: string[] = [];
		const output = "x".repeat(9_000);
		const result = await runOmpPrint({
			task: "빌드 상태 요약",
			cwd: "/ws",
			systemPromptAppendix: "FLOORS",
			ompBin: "/usr/local/bin/omp",
			maxChars: 8_000,
			inheritedEnv: { PATH: "/usr/bin", SLACK_BOT_TOKEN: "xoxb-x" },
			run: async (cmd) => {
				seen = cmd;
				return { code: 0, stdout: output, timedOut: false };
			},
		});
		expect(seen[0]).toBe("/usr/local/bin/omp");
		expect(seen[1]).toBe("-p");
		expect(seen.slice(-2)).toEqual(["--", "빌드 상태 요약"]);
		expect(seen).toContain("FLOORS");
		expect(seen).toContain("--no-session");
		expect(result.ok).toBe(true);
		expect(result.output.length).toBeLessThanOrEqual(8_000);
	});

	test("a task that starts with '-' goes after `--`, so omp reads it as the prompt, not a flag (B-3)", async () => {
		for (const task of ["- 빌드", "--version"]) {
			let seen: string[] = [];
			await runOmpPrint({
				task,
				cwd: "/ws",
				systemPromptAppendix: "FLOORS",
				ompBin: "/bin/omp",
				run: async (cmd) => {
					seen = cmd;
					return { code: 0, stdout: "ok", timedOut: false };
				},
			});
			expect(seen).toEqual(["/bin/omp", "-p", "--no-session", "--append-system-prompt", "FLOORS", "--", task]);
		}
	});

	test("timeout and non-zero exit are reported, not thrown", async () => {
		const timedOut = await runOmpPrint({
			task: "t",
			cwd: "/ws",
			systemPromptAppendix: "f",
			ompBin: "omp",
			run: async () => ({ code: null, stdout: "partial", timedOut: true }),
		});
		expect(timedOut.ok).toBe(false);
		expect(timedOut.output).toContain("[시간 초과로 중단됨");
		const failed = await runOmpPrint({
			task: "t",
			cwd: "/ws",
			systemPromptAppendix: "f",
			ompBin: "omp",
			run: async () => ({ code: 1, stdout: "boom", timedOut: false }),
		});
		expect(failed.ok).toBe(false);
		expect(failed.output).toBe("boom");
		expect(failed).toMatchObject({ code: 1, timedOut: false });
		expect(timedOut).toMatchObject({ code: null, timedOut: true });
	});

	test("lane review: model, tools and signal reach the runner; without them the argv is unchanged", async () => {
		const seen: { cmd: string[]; signal?: AbortSignal | undefined }[] = [];
		const run = async (cmd: string[], opts: { signal?: AbortSignal }) => {
			seen.push({ cmd, signal: opts.signal });
			return { code: 0, stdout: "ok", timedOut: false };
		};
		const abort = new AbortController();
		await runOmpPrint({
			task: "t",
			cwd: "/ws",
			systemPromptAppendix: "F",
			ompBin: "/bin/omp",
			model: "anthropic/claude-sonnet-5-5:medium",
			tools: "read,grep,glob",
			signal: abort.signal,
			run,
		});
		await runOmpPrint({ task: "t", cwd: "/ws", systemPromptAppendix: "F", ompBin: "/bin/omp", run });
		expect(seen[0]?.cmd).toEqual([
			"/bin/omp",
			"-p",
			"--no-session",
			"--append-system-prompt",
			"F",
			"--model",
			"anthropic/claude-sonnet-5-5:medium",
			"--tools",
			"read,grep,glob",
			"--",
			"t",
		]);
		expect(seen[0]?.signal).toBe(abort.signal);
		expect(seen[1]?.cmd).toEqual(["/bin/omp", "-p", "--no-session", "--append-system-prompt", "F", "--", "t"]);
		expect(seen[1]?.signal).toBeUndefined();
	});

	test("lane review isolation AC-1: --config <overlay> and the four --no-* flags follow --no-session; absent, the argv is unchanged", async () => {
		const seen: string[][] = [];
		const run = async (cmd: string[]) => {
			seen.push(cmd);
			return { code: 0, stdout: "ok", timedOut: false };
		};
		const base = { task: "-t", cwd: "/ws", systemPromptAppendix: "F", ompBin: "/bin/omp", run };
		await runOmpPrint({ ...base, tools: "read,grep,glob", isolation: { configPath: "/r/L-1.omp.yml" } });
		await runOmpPrint(base);
		expect(seen[0]).toEqual([
			"/bin/omp",
			"-p",
			"--no-session",
			"--config",
			"/r/L-1.omp.yml",
			"--no-extensions",
			"--no-skills",
			"--no-rules",
			"--no-context-files",
			"--append-system-prompt",
			"F",
			"--tools",
			"read,grep,glob",
			"--",
			"-t",
		]);
		expect(seen[0]?.at(-1)).toBe("-t");
		expect(seen[1]).toEqual(["/bin/omp", "-p", "--no-session", "--append-system-prompt", "F", "--", "-t"]);
	});
});

describe("simple mode risk gate", () => {
	const signal = new AbortController().signal;
	const HIGH = "git push --force origin main 로 맞춰";
	function simpleTool(approval?: ApprovalResult) {
		const runs: string[][] = [];
		const approvals: string[] = [];
		const built = buildDispatchTool({
			originKey: "slack/dm/D0123456789",
			ompExecutable: "omp",
			homeDir: "/h",
			workspaceDir: "/h/workspace",
			log: { info() {}, warn() {} },
			run: async (cmd) => {
				runs.push(cmd);
				return { code: 0, stdout: "결과 요약\n", timedOut: false };
			},
			...(approval === undefined
				? {}
				: {
						approve: async (summary: string) => {
							approvals.push(summary);
							return approval;
						},
					}),
		});
		return { built, runs, approvals };
	}

	const REFUSALS: Array<[string, ApprovalResult | undefined, string]> = [
		["denied", "denied", "denied"],
		["timeout", "timeout", "timeout"],
		["a thread reply", { replied: "응" }, "replied"],
		["no approver", undefined, "no_approver"],
	];
	for (const [label, approval, outcome] of REFUSALS) {
		test(`high_risk + ${label} is refused and omp -p never runs`, async () => {
			const { built, runs, approvals } = simpleTool(approval);
			await expect(built.execute({ task: HIGH }, { signal })).rejects.toThrow(
				`위험 검사에서 막혔습니다(${outcome}): git_push_force, git_push_protected.`,
			);
			expect(runs).toEqual([]);
			expect(approvals).toHaveLength(approval === undefined ? 0 : 1);
		});
	}

	test("high_risk + approved runs omp -p and ends with the approval line", async () => {
		const { built, runs, approvals } = simpleTool("approved");
		const out = await built.execute({ task: HIGH }, { signal });
		expect(runs.map((cmd) => [...cmd.slice(0, 2), ...cmd.slice(-2)])).toEqual([["omp", "-p", "--", HIGH]]);
		expect(approvals).toEqual(["herdr 위임 지시문에 고위험 명령이 있습니다"]);
		expect(out).toBe("결과 요약\n위험 검사: high_risk 승인됨 (git_push_force, git_push_protected)");
	});

	test("a clear task never asks and returns the unchanged output", async () => {
		const { built, runs, approvals } = simpleTool("denied");
		expect(await built.execute({ task: "빌드 상태 요약" }, { signal })).toBe("결과 요약");
		expect(runs).toHaveLength(1);
		expect(approvals).toEqual([]);
	});

	test("omp -p has nobody to answer a dialog: its floors forbid `ask` even for a chat origin", async () => {
		const { built, runs } = simpleTool();
		await built.execute({ task: "빌드 상태 요약" }, { signal });
		const appendix = runs[0]?.[runs[0].indexOf("--append-system-prompt") + 1] ?? "";
		expect(appendix).toContain("never use the `ask` tool");
		expect(appendix).not.toContain("may use the `ask` tool");
	});
});

describe("remote dispatch (host qualifier)", () => {
	const log: string[] = [];
	const remoteRun: ProcessRunner = async (cmd) => {
		log.push(cmd.join(" "));
		// workspace create / tab create / agent start / agent prompt all answer with ok JSON.
		return {
			code: 0,
			stdout: JSON.stringify({
				result: { workspace: { workspace_id: "WS1" }, tab: { tab_id: "T1" }, root_pane: { pane_id: "PN1" } },
			}),
			timedOut: false,
		};
	};

	test("host=wsl runs the whole herdr chain over ssh with the host workDir", async () => {
		const result = await herdrRemoteStart({
			sshTarget: "wsl",
			name: "ompbot-refactor-1",
			task: "복잡한 리팩터링",
			cwd: "/home/dev/work",
			options: { run: remoteRun },
		});
		expect(result.ok).toBe(true);
		const ssh = "ssh -o BatchMode=yes -o ConnectTimeout=8 -- wsl";
		expect(log.some((line) => line.startsWith(`${ssh} 'herdr' 'agent' 'list'`))).toBe(true);
		expect(log.some((line) => line.includes("'workspace' 'create'") && line.includes("'--cwd' '/home/dev/work'"))).toBe(
			true,
		);
		expect(log.some((line) => line.startsWith(`${ssh} 'herdr' 'agent' 'start'`))).toBe(true);
		expect(log.some((line) => line.includes("'agent' 'prompt'") && line.includes("'복잡한 리팩터링'"))).toBe(true);
	});

	test("every remote herdr word is single-quoted so ssh delivers it verbatim", async () => {
		const seen: string[][] = [];
		const run: ProcessRunner = async (cmd) => {
			seen.push(cmd);
			return remoteRun(cmd, {});
		};
		const task = "a b it's $(x) (괄호) `y`; z\nw";
		await herdrRemoteStart({ sshTarget: "wsl", name: "ompbot-q-1", task, cwd: "~/x", options: { run } });
		const prompt = seen.find((cmd) => cmd.includes("'prompt'"));
		expect(prompt).toEqual([
			"ssh",
			"-o",
			"BatchMode=yes",
			"-o",
			"ConnectTimeout=8",
			"--",
			"wsl",
			"'herdr'",
			"'agent'",
			"'prompt'",
			"'ompbot-q-1'",
			`'a b it'\\''s $(x) (괄호) \`y\`; z\nw'`,
		]);
		const create = seen.find((cmd) => cmd.includes("'create'"));
		expect(create?.slice(create.indexOf("'--cwd'"), create.indexOf("'--cwd'") + 2)).toEqual(["'--cwd'", "'~/x'"]);
	});

	test("the host herdrBin is used for every remote herdr call (non-login ssh PATH lacks ~/.local/bin)", async () => {
		const seen: string[][] = [];
		const run: ProcessRunner = async (cmd) => {
			seen.push(cmd);
			return remoteRun(cmd, {});
		};
		const herdrBin = "/home/dev/.local/bin/herdr";
		const result = await herdrRemoteStart({
			sshTarget: "wsl",
			name: "ompbot-b-1",
			task: "t",
			cwd: "~",
			options: { run, herdrBin },
		});
		expect(result.ok).toBe(true);
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every((cmd) => cmd[cmd.indexOf("--") + 2] === `'${herdrBin}'`)).toBe(true);
	});

	test("round trip: a POSIX shell given the ssh-joined words recovers the original argv", () => {
		const args = [
			"a b",
			"it's",
			"$(x)",
			"`y`",
			"; z",
			"line1\nline2",
			"한글 (괄호)",
			"back\\slash",
			"--cwd",
			"~",
			"~/x",
		];
		const argv = herdrSshArgv("host", "herdr", args);
		const remoteWords = argv.slice(argv.indexOf("--") + 2);
		// ssh joins the remote argv with spaces and hands the line to the login shell.
		const proc = Bun.spawnSync(["sh", "-c", `printf '%s\\0' ${remoteWords.join(" ")}`], {
			env: { ...process.env, HOME: "/tmp/round-trip-home" },
		});
		expect(proc.exitCode).toBe(0);
		const got = proc.stdout.toString().split("\0");
		expect(got.pop()).toBe("");
		// The bare `~` after `--cwd` is the one value the remote shell expands.
		const want = ["herdr", ...args].map((word, i, all) =>
			word === "~" && all[i - 1] === "--cwd" ? "/tmp/round-trip-home" : word,
		);
		expect(got).toEqual(want);
	});

	test("remoteShellQuote escapes single quotes; herdrSshArgv leaves only a bare --cwd ~ unquoted", () => {
		expect(remoteShellQuote("it's")).toBe("'it'\\''s'");
		expect(herdrSshArgv("wsl", "herdr", ["x", "--cwd", "~", "--cwd", "~/x"]).slice(7)).toEqual([
			"'herdr'",
			"'x'",
			"'--cwd'",
			"~",
			"'--cwd'",
			"'~/x'",
		]);
		expect(herdrSshArgv("wsl", "herdr", ["~"]).slice(7)).toEqual(["'herdr'", "'~'"]);
	});
});

describe("herdr dispatch", () => {
	test("start creates a workspace, starts kind=omp, and delivers the prompt", async () => {
		const commands: string[] = [];
		const run = runner([
			{
				match: (cmd) => cmd[1] === "workspace" && cmd[2] === "create",
				respond: () => ({
					code: 0,
					stdout: JSON.stringify({ result: { root_pane: { pane_id: "P1" } } }),
					timedOut: false,
				}),
			},
			{
				match: (cmd) => cmd[1] === "agent" && cmd[2] === "start",
				respond: (cmd) => {
					commands.push(`start:${cmd[3]}:${cmd[5]}:${cmd[7]}`);
					return { code: 0, stdout: "ok", timedOut: false };
				},
			},
			{
				match: (cmd) => cmd[1] === "agent" && cmd[2] === "prompt",
				respond: (cmd) => {
					commands.push(`prompt:${cmd[3]}:${cmd[4]}`);
					return { code: 0, stdout: "ok", timedOut: false };
				},
			},
		]);
		const result = await herdrStartAgent({
			name: "ompbot-refactor-12345",
			task: "리팩터링 지시",
			cwd: "/ws",
			options: { run },
		});
		expect(result).toMatchObject({ ok: true, agentName: "ompbot-refactor-12345", paneId: "P1" });
		expect(commands).toEqual(["start:ompbot-refactor-12345:omp:P1", "prompt:ompbot-refactor-12345:리팩터링 지시"]);
	});

	test("workspace create failure is a clean error", async () => {
		const result = await herdrStartAgent({
			name: "x",
			task: "t",
			cwd: "/ws",
			options: { run: runner([{ match: () => true, respond: () => ({ code: 1, stdout: "", timedOut: false }) }]) },
		});
		expect(result.ok).toBe(false);
	});
});

describe("herdr local start cleanup", () => {
	/** A local start whose argv is recorded; `fail` names the step that exits 1. */
	async function startWith(fail: "start" | "prompt", closeOnPromptFailure?: boolean) {
		const calls: string[][] = [];
		const run: ProcessRunner = async (cmd) => {
			calls.push(cmd);
			if (cmd[1] === "workspace" && cmd[2] === "create") {
				const created = { workspace: { workspace_id: "W7" }, tab: { tab_id: "T7" }, root_pane: { pane_id: "P7" } };
				return { code: 0, stdout: JSON.stringify({ result: created }), timedOut: false };
			}
			if (cmd[1] === "agent" && cmd[2] === fail) return { code: 1, stdout: "", stderr: "boom", timedOut: false };
			return { code: 0, stdout: "{}", timedOut: false };
		};
		const extra = closeOnPromptFailure === undefined ? {} : { closeOnPromptFailure };
		const result = await herdrStartAgent({ name: "t-1", task: "지시", cwd: "/ws", ...extra, options: { run } });
		return { result, calls, closes: calls.filter((cmd) => cmd[2] === "close") };
	}

	test("workspace create passes --no-focus; a failed agent start closes that workspace exactly once", async () => {
		const { result, calls, closes } = await startWith("start");
		expect(calls[0]).toEqual(["herdr", "workspace", "create", "--cwd", "/ws", "--label", "ompbot · t-1", "--no-focus"]);
		expect(result).toEqual({ ok: false, error: "agent start failed: boom" });
		expect(closes).toEqual([["herdr", "workspace", "close", "W7"]]);
		expect(calls.some((cmd) => cmd[2] === "prompt")).toBe(false);
	});

	test("a failed first prompt leaves the started agent and its workspace alone", async () => {
		for (const flag of [undefined, false]) {
			const { result, closes } = await startWith("prompt", flag);
			expect(result).toEqual({ ok: false, error: "agent prompt failed: boom" });
			expect(closes).toEqual([]);
		}
	});

	test("closeOnPromptFailure: a failed first prompt closes the workspace this call created (B-4)", async () => {
		const { result, closes } = await startWith("prompt", true);
		expect(result).toEqual({ ok: false, error: "agent prompt failed: boom" });
		expect(closes).toEqual([["herdr", "workspace", "close", "W7"]]);
	});
});

describe("herdr remote start cleanup on a failed first prompt (B-4)", () => {
	/** A remote start whose first prompt exits 1; `shared` = the owners workspace already exists on the host. */
	async function remoteWith(shared: boolean, closeOnPromptFailure?: boolean) {
		const words: string[][] = [];
		const run: ProcessRunner = async (cmd) => {
			const args = cmd.slice(cmd.indexOf("--") + 3).map((word) => word.slice(1, -1));
			words.push(args);
			const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ result }), timedOut: false });
			if (args[0] === "agent" && args[1] === "list") return ok({ agents: [] });
			if (args[0] === "workspace" && args[1] === "list") {
				return ok({ workspaces: shared ? [{ workspace_id: "WS-OWNERS", label: "ompbot-owners" }] : [] });
			}
			if (args[0] === "workspace" && args[1] === "create") {
				return ok({ workspace: { workspace_id: "WS-NEW" }, tab: { tab_id: "T-NEW" }, root_pane: { pane_id: "P1" } });
			}
			if (args[0] === "tab" && args[1] === "create")
				return ok({ tab: { tab_id: "T-MINE" }, root_pane: { pane_id: "P2" } });
			if (args[0] === "agent" && args[1] === "prompt") return { code: 1, stdout: "", stderr: "boom", timedOut: false };
			return ok({});
		};
		const extra = closeOnPromptFailure === undefined ? {} : { closeOnPromptFailure };
		const result = await herdrRemoteStart({
			sshTarget: "wsl",
			name: "t-2",
			task: "지시",
			cwd: "/r",
			...extra,
			options: { run },
		});
		return { result, closes: words.filter((args) => args[1] === "close") };
	}

	test("shared owners workspace: only this call's tab is closed, the workspace never", async () => {
		const { result, closes } = await remoteWith(true, true);
		expect(result).toEqual({ ok: false, error: "agent prompt failed: boom" });
		expect(closes).toEqual([["tab", "close", "T-MINE"]]);
	});

	test("a workspace this call created is closed whole", async () => {
		const { closes } = await remoteWith(false, true);
		expect(closes).toEqual([["workspace", "close", "WS-NEW"]]);
	});

	test("without the flag (default) nothing is closed", async () => {
		for (const shared of [true, false]) {
			for (const flag of [undefined, false]) {
				const { result, closes } = await remoteWith(shared, flag);
				expect(result).toEqual({ ok: false, error: "agent prompt failed: boom" });
				expect(closes).toEqual([]);
			}
		}
	});
});

describe("herdr follow-up delivery check", () => {
	const fail = (code: string): RunProcessResult => ({
		code: 1,
		stdout: "",
		stderr: JSON.stringify({ error: { code, message: code } }),
		timedOut: false,
	});
	async function follow(...answers: RunProcessResult[]) {
		const calls: string[][] = [];
		const run: ProcessRunner = async (cmd) => {
			calls.push(cmd);
			return answers[calls.length - 1] ?? { code: 0, stdout: "", timedOut: false };
		};
		return { result: await herdrPromptExisting("t-1", "재개", { run }), calls };
	}

	test("waits for working or blocked for 15 s; a seen start is ok", async () => {
		const { result, calls } = await follow({ code: 0, stdout: "", timedOut: false });
		expect(calls).toEqual([
			[
				"herdr",
				"agent",
				"prompt",
				"t-1",
				"재개",
				"--wait",
				"--until",
				"working",
				"--until",
				"blocked",
				"--timeout",
				"15000",
			],
		]);
		expect(result).toEqual({ ok: true });
	});

	test("a stall or herdr's own timeout is unconfirmed; agent_blocked stays a plain failure", async () => {
		expect((await follow(fail("agent_prompt_stalled"))).result).toEqual({
			ok: false,
			unconfirmed: true,
			error: "agent prompt unconfirmed: agent_prompt_stalled",
		});
		expect((await follow(fail("timeout"))).result).toEqual({
			ok: false,
			unconfirmed: true,
			error: "agent prompt unconfirmed: timeout",
		});
		const blocked = await follow(fail("agent_blocked"));
		expect(blocked.result).toEqual({ ok: false, error: "agent prompt failed: agent_blocked: agent_blocked" });
		expect(blocked.calls).toHaveLength(1);
	});

	test("a herdr that does not know --wait gets the plain prompt exactly once more", async () => {
		const usage: RunProcessResult = {
			code: 2,
			stdout: "",
			stderr: "error: unexpected argument '--wait' found\n\nUsage: herdr agent prompt <NAME> <TEXT>\n",
			timedOut: false,
		};
		const retried = await follow(usage, { code: 0, stdout: "", timedOut: false });
		expect(retried.calls).toHaveLength(2);
		expect(retried.calls[1]).toEqual(["herdr", "agent", "prompt", "t-1", "재개"]);
		expect(retried.result).toEqual({ ok: true });
		const stillFailing = await follow(usage, fail("agent_not_found"));
		expect(stillFailing.calls).toHaveLength(2);
		expect(stillFailing.result).toEqual({ ok: false, error: "agent prompt failed: agent_not_found: agent_not_found" });
	});
});

describe("herdr failure reasons", () => {
	const prompt = (answer: RunProcessResult) =>
		herdrPromptExisting("t-1", "재개", { run: runner([{ match: () => true, respond: () => answer }]) });

	test("a follow-up herdr refuses because the agent waits on an approval names agent_blocked", async () => {
		const stderr = JSON.stringify({
			error: { code: "agent_blocked", message: "agent t-1 is blocked" },
			id: "cli:agent:prompt",
		});
		expect(await prompt({ code: 1, stdout: "", stderr, timedOut: false })).toEqual({
			ok: false,
			error: "agent prompt failed: agent_blocked: agent t-1 is blocked",
		});
	});

	test("non-JSON stderr is shown as is; with nothing to show the exit code remains", async () => {
		expect(
			await prompt({ code: 255, stdout: "", stderr: "ssh: connect to host wsl: timed out\n", timedOut: false }),
		).toEqual({
			ok: false,
			error: "agent prompt failed: ssh: connect to host wsl: timed out",
		});
		expect(await prompt({ code: 1, stdout: "", timedOut: false })).toEqual({
			ok: false,
			error: "agent prompt failed: exit 1",
		});
	});

	test("a start whose agent start fails carries herdr's error code", async () => {
		const result = await herdrStartAgent({
			name: "x",
			task: "t",
			cwd: "/ws",
			options: {
				run: runner([
					{
						match: (cmd) => cmd[1] === "workspace",
						respond: () => ({
							code: 0,
							stdout: JSON.stringify({ result: { root_pane: { pane_id: "P1" } } }),
							timedOut: false,
						}),
					},
					{
						match: (cmd) => cmd[1] === "agent" && cmd[2] === "start",
						respond: () => ({
							code: 1,
							stdout: "",
							stderr: JSON.stringify({ error: { code: "agent_exists", message: "agent x already exists" } }),
							timedOut: false,
						}),
					},
				]),
			},
		});
		expect(result).toEqual({ ok: false, error: "agent start failed: agent_exists: agent x already exists" });
	});

	test("a remote start whose workspace list, workspace create or tab create fails carries ssh's stderr", async () => {
		const refused: RunProcessResult = {
			code: 255,
			stdout: "",
			stderr: "ssh: connect to host x port 22: Connection refused\n",
			timedOut: false,
		};
		const ok = (result: unknown): RunProcessResult => ({
			code: 0,
			stdout: JSON.stringify({ result }),
			timedOut: false,
		});
		const has = (cmd: string[], ...words: string[]) => words.every((word) => cmd.includes(`'${word}'`));
		const start = (routes: Parameters<typeof runner>[0]) =>
			herdrRemoteStart({
				sshTarget: "x",
				name: "t-1",
				task: "t",
				cwd: "~/w",
				options: {
					run: runner([{ match: (cmd) => has(cmd, "agent", "list"), respond: () => ok({ agents: [] }) }, ...routes]),
				},
			});
		const listed = ok({ workspaces: [{ workspace_id: "W1", label: "ompbot-owners" }] });
		const cases = [
			[{ match: (cmd: string[]) => has(cmd, "workspace", "list"), respond: () => refused }],
			[
				{ match: (cmd: string[]) => has(cmd, "workspace", "list"), respond: () => ok({ workspaces: [] }) },
				{ match: (cmd: string[]) => has(cmd, "workspace", "create"), respond: () => refused },
			],
			[
				{ match: (cmd: string[]) => has(cmd, "workspace", "list"), respond: () => listed },
				{ match: (cmd: string[]) => has(cmd, "tab", "create"), respond: () => refused },
			],
		];
		const errors: string[] = [];
		for (const routes of cases) {
			const result = await start(routes);
			errors.push(result.ok ? "ok" : result.error);
		}
		expect(errors).toEqual([
			"workspace list failed: ssh: connect to host x port 22: Connection refused",
			"workspace create failed: ssh: connect to host x port 22: Connection refused",
			"tab create failed: ssh: connect to host x port 22: Connection refused",
		]);
	});
});

describe("herdrAgentStatus", () => {
	const listing = (agents: unknown[]): RunProcessResult => ({
		code: 0,
		stdout: JSON.stringify({ result: { agents } }),
		timedOut: false,
	});
	const ask = (answer: RunProcessResult, name = "t-1") =>
		herdrAgentStatus(name, { run: runner([{ match: () => true, respond: () => answer }]) });

	test("reads each herdr status of the named agent; a strange or missing value is unknown", async () => {
		for (const status of ["idle", "working", "blocked", "done", "unknown"] as const) {
			const answer = listing([
				{ name: "other", agent_status: "working" },
				{ name: "t-1", pane_id: "P1", agent_status: status },
			]);
			expect(await ask(answer)).toEqual({ ok: true, status });
		}
		expect(await ask(listing([{ name: "t-1", agent_status: "napping" }]))).toEqual({ ok: true, status: "unknown" });
		expect(await ask(listing([{ name: "t-1", agent_status: "constructor" }]))).toEqual({
			ok: true,
			status: "unknown",
		});
		expect(await ask(listing([{ name: "t-1" }]))).toEqual({ ok: true, status: "unknown" });
	});

	test("a name the list does not have is gone; a herdr that cannot be asked is not", async () => {
		expect(await ask(listing([{ name: "other", agent_status: "idle" }]))).toEqual({ ok: true, status: "gone" });
		expect(await ask(listing([]))).toEqual({ ok: true, status: "gone" });
		const failed = await ask({ code: 1, stdout: "server not running", timedOut: false });
		expect(failed).toEqual({ ok: false, error: "agent list failed: server not running" });
		expect((await ask({ code: 0, stdout: "not json", timedOut: false })).ok).toBe(false);
	});

	test("L-13 herdr printing JSON that is not an object (null, a number) is a failure, not a TypeError", async () => {
		for (const stdout of ["null", "3", '"x"']) {
			const answer: RunProcessResult = { code: 0, stdout, timedOut: false };
			expect(await ask(answer)).toMatchObject({ ok: false });
			const exists = await herdrAgentExists("t-1", { run: runner([{ match: () => true, respond: () => answer }]) });
			expect(exists).toMatchObject({ ok: false });
		}
	});

	test("with sshTarget the list runs as the herdrSshArgv ssh command", async () => {
		const seen: string[][] = [];
		const result = await herdrAgentStatus("t-1", {
			sshTarget: "wsl",
			herdrBin: "/home/dev/.local/bin/herdr",
			run: async (cmd) => {
				seen.push(cmd);
				return listing([{ name: "t-1", agent_status: "blocked" }]);
			},
		});
		expect(result).toEqual({ ok: true, status: "blocked" });
		expect(seen).toEqual([herdrSshArgv("wsl", "/home/dev/.local/bin/herdr", ["agent", "list"])]);
		expect(seen[0]?.slice(0, 7)).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "--", "wsl"]);
	});
});

/** `ompbot_dispatch` as base 1ad1bbc built it (herdr always on), extracted before this change and frozen. */
const BASE = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "herdr-on-base.json"), "utf8")) as {
	tool: { name: string; description: string; parameters: unknown };
};

describe("herdr optional (config herdr)", () => {
	const signal = new AbortController().signal;
	function dispatchTool(over: Partial<DispatchToolDeps> = {}) {
		const calls: string[][] = [];
		const built = buildDispatchTool({
			originKey: "slack/dm/D0123456789",
			ompExecutable: "omp",
			homeDir: "/h",
			workspaceDir: "/h/workspace",
			log: { info() {}, warn() {} },
			run: async (cmd) => {
				calls.push(cmd);
				return { code: 0, stdout: JSON.stringify({ result: { agents: [] } }), timedOut: false };
			},
			...over,
		});
		return { built, calls };
	}

	test("off: the schema and description never mention herdr, taskSpec, name or host", () => {
		const { built } = dispatchTool();
		const parameters = JSON.stringify(built.parameters);
		for (const word of ["herdr", "taskSpec", '"name"', '"host"']) expect(parameters).not.toContain(word);
		expect(built.description).not.toContain("herdr");
		expect(built.name).toBe("ompbot_dispatch");
	});

	test("on (herdr: {}): name, description and parameters are byte-identical to base", () => {
		const { built } = dispatchTool({ herdr: {} });
		expect(built.name).toBe(BASE.tool.name);
		expect(built.description).toBe(BASE.tool.description);
		expect(JSON.stringify(built.parameters)).toBe(JSON.stringify(BASE.tool.parameters));
	});

	test("off: herdr, taskSpec and host arguments are refused before any process runs", async () => {
		const { built, calls } = dispatchTool({
			dispatchHosts: { wsl: { ssh: "wsl" } },
			tasks: {} as NonNullable<DispatchToolDeps["tasks"]>,
		});
		for (const params of [
			{ mode: "herdr", name: "x", task: "t" },
			{ taskSpec: { id: "T-1" } },
			{ host: "wsl", task: "t" },
		]) {
			await expect(built.execute(params, { signal })).rejects.toThrow("herdr가 꺼져 있어 simple만 쓸 수 있습니다");
		}
		expect(calls).toEqual([]);
	});

	test("off: simple mode still runs omp -p, and its floors carry no herdr line", async () => {
		const { built, calls } = dispatchTool();
		await built.execute({ task: "빌드 상태 요약" }, { signal });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.[0]).toBe("omp");
		expect(calls[0]?.join("\n")).not.toContain("herdr");
	});

	test("local herdr bin (config herdr.bin, set at daemon start): local calls run it, remote ones keep the host's", async () => {
		setLocalHerdrBin("/opt/herdr/bin/herdr");
		try {
			const { built, calls } = dispatchTool({ herdr: {}, dispatchHosts: { wsl: { ssh: "wsl" } } });
			await built.execute({ mode: "herdr", name: "x" }, { signal });
			expect(calls[0]?.[0]).toBe("/opt/herdr/bin/herdr");
			await built.execute({ host: "wsl", name: "x" }, { signal });
			expect(calls[1]?.[0]).toBe("ssh");
			expect(calls[1]).toContain("'herdr'");
		} finally {
			setLocalHerdrBin(undefined);
		}
		const { built, calls } = dispatchTool({ herdr: {} });
		await built.execute({ mode: "herdr", name: "x" }, { signal });
		expect(calls[0]?.[0]).toBe("herdr");
	});

	test("L-12 a host named like an Object.prototype member is unknown, and nothing runs", async () => {
		const { built, calls } = dispatchTool({ herdr: {}, dispatchHosts: { wsl: { ssh: "wsl" } } });
		for (const host of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
			await expect(built.execute({ host, name: "x", task: "t" }, { signal })).rejects.toThrow(
				`알 수 없는 호스트: ${host} (등록된 호스트: wsl)`,
			);
		}
		expect(calls).toEqual([]);
	});

	test("a task to a name the remote host already runs is a follow-up prompt, not a second start", async () => {
		const calls: string[][] = [];
		const { built } = dispatchTool({
			herdr: {},
			dispatchHosts: { wsl: { ssh: "wsl" } },
			run: async (cmd) => {
				calls.push(cmd);
				return { code: 0, stdout: JSON.stringify({ result: { agents: [{ name: "worker-1" }] } }), timedOut: false };
			},
		});
		const text = String(await built.execute({ host: "wsl", name: "worker-1", task: "다음 단계 진행" }, { signal }));
		expect(text).toContain("후속 지시");
		const words = calls.map((cmd) => cmd.join(" "));
		expect(words.some((line) => line.includes("'agent' 'prompt' 'worker-1' '다음 단계 진행'"))).toBe(true);
		// None of herdrRemoteStart's steps after its name check ran.
		expect(words.some((line) => /'(workspace|tab)'|'agent' 'start'/.test(line))).toBe(false);
	});
});

describe("worker omp arguments (agentArgs)", () => {
	/** Records every argv; workspace/tab creates answer with ids, everything else with `{}`. */
	function recorder() {
		const seen: string[][] = [];
		const run: ProcessRunner = async (cmd) => {
			seen.push(cmd);
			const created = { workspace: { workspace_id: "W1" }, tab: { tab_id: "T1" }, root_pane: { pane_id: "P1" } };
			const isCreate = cmd.some((word) => word === "create" || word === "'create'");
			return { code: 0, stdout: JSON.stringify(isCreate ? { result: created } : {}), timedOut: false };
		};
		return { seen, run };
	}
	const SSH = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "--", "wsl"];
	const LOCAL_START = ["herdr", "agent", "start", "w-1", "--kind", "omp", "--pane", "P1", "--timeout", "60000"];
	const REMOTE_START = [...SSH, ...LOCAL_START.map(remoteShellQuote)];
	const local = (agentArgs?: string[]) => {
		const r = recorder();
		const extra = agentArgs === undefined ? {} : { agentArgs };
		return herdrStartAgent({ name: "w-1", task: "t", cwd: "/ws", ...extra, options: { run: r.run } }).then(
			() => r.seen,
		);
	};
	const remote = (agentArgs?: string[]) => {
		const r = recorder();
		const extra = agentArgs === undefined ? {} : { agentArgs };
		return herdrRemoteStart({
			sshTarget: "wsl",
			name: "w-1",
			task: "t",
			cwd: "/r",
			...extra,
			options: { run: r.run },
		}).then(() => r.seen);
	};

	test("without agentArgs (or with none) every argv is exactly today's", async () => {
		for (const args of [undefined, []]) {
			expect(await local(args)).toEqual([
				["herdr", "workspace", "create", "--cwd", "/ws", "--label", "ompbot · w-1", "--no-focus"],
				LOCAL_START,
				["herdr", "agent", "prompt", "w-1", "t"],
			]);
			expect(await remote(args)).toEqual(
				[
					["agent", "list"],
					["workspace", "list"],
					["workspace", "create", "--label", "ompbot-owners", "--cwd", "/r", "--no-focus"],
					["tab", "rename", "T1", "w-1"],
					LOCAL_START.slice(1),
					["agent", "prompt", "w-1", "t"],
				].map((words) => [...SSH, ...["herdr", ...words].map(remoteShellQuote)]),
			);
		}
		const r = recorder();
		await runOmpPrint({ task: "t", cwd: "/ws", systemPromptAppendix: "F", ompBin: "/bin/omp", run: r.run });
		expect(r.seen).toEqual([["/bin/omp", "-p", "--no-session", "--append-system-prompt", "F", "--", "t"]]);
	});

	test("local agentArgs end the agent start argv after `--`; nothing else changes", async () => {
		const seen = await local(["--prewalk"]);
		expect(seen[1]).toEqual([...LOCAL_START, "--", "--prewalk"]);
		expect(seen.filter((cmd) => cmd.includes("--prewalk"))).toHaveLength(1);
	});

	test("remote agentArgs go over ssh quoted like every other word: '--' '--prewalk'", async () => {
		const seen = await remote(["--prewalk", "--model=it's"]);
		const start = seen.find((cmd) => cmd.includes("'start'"));
		expect(start).toEqual([...REMOTE_START, "'--'", "'--prewalk'", "'--model=it'\\''s'"]);
		expect(seen.filter((cmd) => cmd.includes("'--prewalk'"))).toHaveLength(1);
	});
});

describe("qa50b lane H: local herdr start and pipe-holding children", () => {
	const signal = new AbortController().signal;
	/** A fake local herdr: `agent list` shows `agents`, a start adds one, a prompt to an unknown name fails. */
	function fakeHerdr(agents: string[]) {
		const calls: string[][] = [];
		const run: ProcessRunner = async (cmd) => {
			calls.push(cmd);
			const [, group, verb, name] = cmd;
			if (group === "agent" && verb === "list") {
				return {
					code: 0,
					stdout: JSON.stringify({ result: { agents: agents.map((agent) => ({ name: agent })) } }),
					timedOut: false,
				};
			}
			if (group === "workspace" && verb === "create") {
				return {
					code: 0,
					stdout: JSON.stringify({ result: { workspace: { workspace_id: "W9" }, root_pane: { pane_id: "P9" } } }),
					timedOut: false,
				};
			}
			if (group === "agent" && verb === "start") {
				agents.push(name as string);
				return { code: 0, stdout: "{}", timedOut: false };
			}
			if (group === "agent" && verb === "prompt" && !agents.includes(name as string)) {
				return {
					code: 1,
					stdout: "",
					stderr: JSON.stringify({ error: { code: "agent_not_found", message: `no agent named ${name}` } }),
					timedOut: false,
				};
			}
			return { code: 0, stdout: "{}", timedOut: false };
		};
		const built = buildDispatchTool({
			originKey: "slack/dm/D0123456789",
			ompExecutable: "omp",
			homeDir: "/h",
			workspaceDir: "/h/workspace",
			herdr: {},
			log: { info() {}, warn() {} },
			run,
		});
		return { built, calls };
	}
	const verbs = (calls: string[][]) => calls.map((cmd) => cmd.slice(1, 3).join(" "));

	test("H-3 a name local herdr does not run is started in the main workspace, with the notice", async () => {
		const { built, calls } = fakeHerdr([]);
		const text = String(
			await built.execute({ mode: "herdr", name: "brand-new", task: "긴 작업을 시작하라" }, { signal }),
		);
		expect(text).toContain("brand-new 에이전트를 시작했습니다 (cwd /h/workspace, pane P9)");
		expect(text).toContain("메인 작업 디렉터리에서 작업합니다 — 저장소 작업은 taskSpec이나 cwd를 주세요");
		expect(text).toContain('ompbot_dispatch {mode:"herdr", name:"brand-new"}');
		expect(text).not.toContain("전달 실패");
		expect(verbs(calls)).toEqual(["agent list", "workspace create", "agent start", "agent prompt"]);
		expect(calls[1]).toContain("/h/workspace");
		expect(calls[3]?.slice(1, 5)).toEqual(["agent", "prompt", "brand-new", "긴 작업을 시작하라"]);
	});

	test("H-3 a given cwd is where the new agent works, without the main-workspace notice", async () => {
		const { built, calls } = fakeHerdr([]);
		const text = String(
			await built.execute({ mode: "herdr", name: "repo-work", task: "작업", cwd: "/h/work/repo" }, { signal }),
		);
		expect(text).toContain("repo-work 에이전트를 시작했습니다 (cwd /h/work/repo, pane P9)");
		expect(text).not.toContain("메인 작업 디렉터리");
		expect(calls[1]?.slice(1)).toEqual([
			"workspace",
			"create",
			"--cwd",
			"/h/work/repo",
			"--label",
			"ompbot · repo-work",
			"--no-focus",
		]);
	});

	test("H-3 a name local herdr already runs gets the task as a follow-up, TASKID names included", async () => {
		for (const name of ["worker-1", "t-20261112-01"]) {
			const { built, calls } = fakeHerdr([name]);
			const text = String(await built.execute({ mode: "herdr", name, task: "다음 단계 진행" }, { signal }));
			expect(text).toContain(`후속 지시를 ${name}에 전달했습니다`);
			expect(verbs(calls)).toEqual(["agent list", "agent prompt"]);
		}
	});

	test("H-3 a TASKID-shaped or malformed new name is refused before anything starts", async () => {
		for (const [name, message] of [
			["t-20261112-01", "TASKID"],
			["T-20261112-01", "TASKID"],
			["Bad Name", "name은 소문자"],
		] as const) {
			const { built, calls } = fakeHerdr([]);
			await expect(built.execute({ mode: "herdr", name, task: "시작" }, { signal })).rejects.toThrow(message);
			expect(verbs(calls)).toEqual(["agent list"]);
		}
	});

	test("H-4 a child that leaves a setsid grandchild holding stdout still ends at the timeout", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ompbot-setsid-"));
		let grandchild: number | undefined;
		try {
			const startedAt = Date.now();
			const result = await within(
				realProcessRunner(["sh", "-c", "setsid sleep 30 & echo $! > pid"], { cwd: dir, timeoutMs: 1_000 }),
				3_000,
				"the timed-out run returning",
			);
			expect(result.timedOut).toBe(true);
			expect(Date.now() - startedAt).toBeLessThan(3_000);
		} finally {
			// The setsid grandchild is in its own session: the runner cannot kill it, so the test does (its own pid).
			if (existsSync(join(dir, "pid"))) grandchild = Number(readFileSync(join(dir, "pid"), "utf8").trim());
			if (grandchild !== undefined && alive(grandchild)) process.kill(grandchild, "SIGKILL");
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("herdr prompts kept for the dashboard (herdr_prompts)", () => {
	const signal = new AbortController().signal;
	const TOKEN = ["xox" + "b", "TEST", "0", "fakefake"].join("-");
	/** A tool on fake herdr whose prompts go into a real store; `agents` already run, `promptFails` refuses prompts. */
	function recorded(agents: string[], options: { promptFails?: boolean; host?: boolean } = {}) {
		const dir = mkdtempSync(join(tmpdir(), "ompbot-herdr-prompts-"));
		const path = join(dir, "ompbot.db");
		const store = openStore({ timezone: "Asia/Seoul", path, clock: { now: () => 1_000 }, redact: (text) => text });
		const run: ProcessRunner = async (cmd) => {
			const words = cmd.join(" ");
			if (words.includes("agent") && words.includes("list")) {
				return {
					code: 0,
					stdout: JSON.stringify({ result: { agents: agents.map((name) => ({ name })) } }),
					timedOut: false,
				};
			}
			if (options.promptFails === true && words.includes("prompt")) {
				return {
					code: 1,
					stdout: "",
					stderr: JSON.stringify({ error: { code: "agent_blocked", message: "waiting on approval" } }),
					timedOut: false,
				};
			}
			return {
				code: 0,
				stdout: JSON.stringify({
					result: { workspace: { workspace_id: "W1" }, tab: { tab_id: "T1" }, root_pane: { pane_id: "P1" } },
				}),
				timedOut: false,
			};
		};
		const built = buildDispatchTool({
			originKey: "slack/dm/D0123456789",
			ompExecutable: "omp",
			homeDir: dir,
			workspaceDir: dir,
			herdr: {},
			dispatchHosts: { wsl: { ssh: "wsl" } },
			log: { info() {}, warn() {} },
			run,
			recordPrompt: (input) => store.recordHerdrPrompt(input),
		});
		const rows = () => {
			const db = new Database(path, { readonly: true });
			try {
				return db
					.query("SELECT host, agent, kind, preview, origin_key AS originKey FROM herdr_prompts ORDER BY id")
					.all();
			} finally {
				db.close();
			}
		};
		const done = (): void => {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		};
		return { built, rows, done };
	}

	test("AC-4: a local follow-up keeps a masked followup row; a failed one keeps none; a new start is start", async () => {
		const ok = recorded(["worker-1"]);
		await ok.built.execute({ mode: "herdr", name: "worker-1", task: `토큰 ${TOKEN} 로 다음 단계 진행` }, { signal });
		const [row] = ok.rows() as Array<{ preview: string }>;
		expect(ok.rows()).toEqual([
			{ host: "", agent: "worker-1", kind: "followup", preview: row?.preview ?? "", originKey: "slack/dm/D0123456789" },
		]);
		expect(row?.preview).toContain("다음 단계 진행");
		expect(row?.preview).not.toContain(TOKEN);
		ok.done();

		const failed = recorded(["worker-1"], { promptFails: true });
		expect(String(await failed.built.execute({ mode: "herdr", name: "worker-1", task: "진행" }, { signal }))).toContain(
			"전달 실패",
		);
		expect(failed.rows()).toEqual([]);
		failed.done();

		const fresh = recorded([]);
		await fresh.built.execute({ mode: "herdr", name: "brand-new", task: "새 일 시작" }, { signal });
		expect(fresh.rows()).toEqual([
			{ host: "", agent: "brand-new", kind: "start", preview: "새 일 시작", originKey: "slack/dm/D0123456789" },
		]);
		fresh.done();
	});

	test("AC-5: a remote new start and a remote follow-up are kept under the host", async () => {
		const start = recorded([]);
		expect(
			String(await start.built.execute({ host: "wsl", name: "remote-1", task: "원격 시작" }, { signal })),
		).toContain("에이전트를 시작했습니다");
		expect(start.rows()).toEqual([
			{ host: "wsl", agent: "remote-1", kind: "start", preview: "원격 시작", originKey: "slack/dm/D0123456789" },
		]);
		start.done();

		const follow = recorded(["remote-1"]);
		await follow.built.execute({ host: "wsl", name: "remote-1", task: "원격 후속" }, { signal });
		expect(follow.rows()).toEqual([
			{ host: "wsl", agent: "remote-1", kind: "followup", preview: "원격 후속", originKey: "slack/dm/D0123456789" },
		]);
		follow.done();
	});

	test("AC-6: past 20 rows an agent keeps its newest 20; rows past 30 days go; a throwing recorder changes nothing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ompbot-herdr-prompts-"));
		let now = 1_000;
		const store = openStore({
			timezone: "Asia/Seoul",
			path: join(dir, "ompbot.db"),
			clock: { now: () => now },
			redact: (text) => text,
		});
		for (let index = 1; index <= 21; index += 1) {
			store.recordHerdrPrompt({ host: null, agent: "a", kind: "followup", text: `지시 ${index}`, originKey: null });
		}
		store.recordHerdrPrompt({ host: null, agent: "b", kind: "start", text: "b 시작", originKey: null });
		const db = new Database(join(dir, "ompbot.db"), { readonly: true });
		const previews = (agent: string) =>
			(
				db.query("SELECT preview FROM herdr_prompts WHERE agent = ? ORDER BY id").all(agent) as Array<{
					preview: string;
				}>
			).map((row) => row.preview);
		expect(previews("a")).toHaveLength(20);
		expect(previews("a")[0]).toBe("지시 2");
		expect(previews("b")).toEqual(["b 시작"]);
		now += 31 * 24 * 60 * 60_000;
		store.recordHerdrPrompt({ host: null, agent: "c", kind: "start", text: "c 시작", originKey: null });
		expect([previews("a"), previews("b"), previews("c")]).toEqual([[], [], ["c 시작"]]);
		db.close();
		store.close();
		rmSync(dir, { recursive: true, force: true });

		const warned: string[] = [];
		const built = buildDispatchTool({
			originKey: "slack/dm/D0123456789",
			ompExecutable: "omp",
			homeDir: "/h",
			workspaceDir: "/h/workspace",
			herdr: {},
			log: { info() {}, warn: (event) => warned.push(event) },
			run: async (cmd) => ({
				code: 0,
				stdout: cmd.includes("list") ? JSON.stringify({ result: { agents: [{ name: "w" }] } }) : "{}",
				timedOut: false,
			}),
			recordPrompt: () => {
				throw new Error("disk full");
			},
		});
		expect(String(await built.execute({ mode: "herdr", name: "w", task: "진행" }, { signal }))).toContain(
			"후속 지시를 w에 전달했습니다",
		);
		expect(warned).toEqual(["herdr_prompt_record_failed"]);
	});
});
