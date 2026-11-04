import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	dispatchEnv,
	herdrAgentStatus,
	herdrPromptExisting,
	herdrRemoteStart,
	herdrSshArgv,
	herdrStartAgent,
	type ProcessRunner,
	type RunProcessResult,
	remoteShellQuote,
	runOmpPrint,
	setLocalHerdrBin,
} from "../src/dispatch/omp";
import { buildDispatchTool, type DispatchToolDeps } from "../src/dispatch/tool";
import type { ApprovalResult } from "../src/safety/approval";

function runner(routes: Array<{ match: (cmd: string[]) => boolean; respond: (cmd: string[]) => RunProcessResult }>) {
	return async (cmd: string[]): Promise<RunProcessResult> => {
		const hit = routes.find((route) => route.match(cmd));
		if (hit === undefined) throw new Error(`unexpected command: ${cmd.join(" ")}`);
		return hit.respond(cmd);
	};
}

describe("dispatchEnv", () => {
	test("drops Slack/bot/git prefixes, keeps the rest", () => {
		const env = dispatchEnv({
			PATH: "/usr/bin",
			SLACK_BOT_TOKEN: "x",
			OMPBOT_HOME: "/x",
			GIT_DIR: "/x",
			HOME: "/home/u",
		});
		expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/u", LC_ALL: "C.UTF-8" });
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
		expect(seen[2]).toBe("빌드 상태 요약");
		expect(seen).toContain("FLOORS");
		expect(result.ok).toBe(true);
		expect(result.output.length).toBeLessThanOrEqual(8_000);
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
		expect(runs.map((cmd) => cmd.slice(0, 3))).toEqual([["omp", "-p", HIGH]]);
		expect(approvals).toEqual(["herdr 위임 지시문에 고위험 명령이 있습니다"]);
		expect(out).toBe("결과 요약\n위험 검사: high_risk 승인됨 (git_push_force, git_push_protected)");
	});

	test("a clear task never asks and returns the unchanged output", async () => {
		const { built, runs, approvals } = simpleTool("denied");
		expect(await built.execute({ task: "빌드 상태 요약" }, { signal })).toBe("결과 요약");
		expect(runs).toHaveLength(1);
		expect(approvals).toEqual([]);
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
		const ssh = "ssh -o BatchMode=yes -o ConnectTimeout=8 wsl --";
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
			"wsl",
			"--",
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
		expect(seen.every((cmd) => cmd[cmd.indexOf("--") + 1] === `'${herdrBin}'`)).toBe(true);
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
		const remoteWords = argv.slice(argv.indexOf("--") + 1);
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
		expect(seen[0]?.slice(0, 7)).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "wsl", "--"]);
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
});
