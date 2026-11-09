import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { HerdrBoardConfig } from "../src/dispatch/board";
import type { ProcessRunner } from "../src/dispatch/omp";
import { buildDispatchTool } from "../src/dispatch/tool";
import type { ApprovalDetail, ApprovalResult } from "../src/safety/approval";
import type { HostToolDef } from "../src/safety/host-tools";
import { SlackChannel } from "../src/slack/channel";
import { FakeSlackTransport } from "../src/slack/fake-transport";
import { acceptanceItems, docsDirOf } from "../src/tasks/docs";
import type { HostResult, TaskHostOps } from "../src/tasks/host";
import { TaskLedger } from "../src/tasks/ledger";

const NOW = Date.parse("2026-10-26T06:00:00Z");
const noop = { info() {}, warn() {} };
const GOOD_SPEC = {
	title: "로그 회전",
	risk: "L2",
	goal: "로그 회전을 넣는다",
	scope: ["src/log.ts"],
	exclusions: ["배포"],
	acceptance: ["회전 테스트가 통과한다", "README에 설명이 있다"],
	repo: "/r/repo",
	background: "배경",
};

/** Inverse of remoteShellQuote: what the remote POSIX shell makes of one single-quoted word (bare words pass through). */
function unquoteRemote(word: string): string {
	return word.startsWith("'") && word.endsWith("'") ? word.slice(1, -1).replaceAll("'\\''", "'") : word;
}

interface FakeHost extends TaskHostOps {
	files: Map<string, string>;
	existing: Set<string>;
	calls: string[];
	failCreate?: string;
	failCommit?: string;
}

function fakeHost(): FakeHost {
	const host: FakeHost = {
		files: new Map(),
		existing: new Set(),
		calls: [],
		async pathExists(path): Promise<HostResult<boolean>> {
			return { ok: true, value: host.existing.has(path) };
		},
		async createWorktree(input) {
			host.calls.push(`create ${input.worktree} ${input.branch}`);
			if (host.failCreate !== undefined) return { ok: false, error: host.failCreate };
			host.existing.add(input.worktree);
			return { ok: true, value: null };
		},
		async removeWorktree(input) {
			host.calls.push(`remove ${input.worktree}`);
			host.existing.delete(input.worktree);
		},
		async writeFile(path, content) {
			host.files.set(path, content);
			return { ok: true, value: null };
		},
		async readFile(path) {
			return { ok: true, value: host.files.get(path) };
		},
		async commitOnTaskBranch() {
			return "ok" as const;
		},
		async commitDocs(input) {
			host.calls.push(`commit ${input.worktree} ${input.taskId} [${[...host.files.keys()].length} files]`);
			if (host.failCommit !== undefined) return { ok: false, error: host.failCommit };
			return { ok: true, value: "abc1234" };
		},
		async runCheck() {
			throw new Error("dispatch never runs checks");
		},
		async headOf() {
			throw new Error("dispatch never runs checks");
		},
		async branchDiff() {
			throw new Error("dispatch never reads the branch diff");
		},
	};
	return host;
}

interface Harness {
	tool: HostToolDef;
	ledger: TaskLedger;
	transport: FakeSlackTransport;
	host: FakeHost;
	herdr: string[][];
	agents: Set<string>;
	failAgentStart: { value: boolean };
	/** Follow-up prompts (`--wait`) end in herdr's `agent_prompt_stalled`: delivered, start unseen. */
	promptStalled: { value: boolean };
	approvals: Array<{ summary: string; detail: ApprovalDetail }>;
}

function harness(
	options: {
		threadRef?: string | undefined;
		withTasks?: boolean;
		board?: HerdrBoardConfig;
		/** What the owner's approval card answers; absent → the tool has no approver. */
		approval?: ApprovalResult;
		/** Free space the start sees under the repo's parent; absent → the real filesystem (`/r` does not exist). */
		disk?: { freeBytes: number; totalBytes: number; asked: string[] };
	} = {},
): Harness {
	const ledger = new TaskLedger(new Database(":memory:", { strict: true }), { clock: { now: () => NOW } });
	const transport = new FakeSlackTransport();
	const host = fakeHost();
	const approvals: Harness["approvals"] = [];
	const herdr: string[][] = [];
	const agents = new Set<string>();
	const failAgentStart = { value: false };
	const promptStalled = { value: false };
	const run: ProcessRunner = async (cmd) => {
		// Over ssh every remote word is single-quoted (or a bare `~`); record the words the remote shell would see.
		const sshAt = cmd[0] === "ssh" ? cmd.indexOf("--") : -1;
		const args = sshAt >= 0 ? cmd.slice(sshAt + 1).map(unquoteRemote) : cmd;
		herdr.push(sshAt >= 0 ? [...cmd.slice(0, sshAt + 1), ...args] : cmd);
		const ok = (stdout = "{}") => ({ code: 0, stdout, timedOut: false });
		if (args[1] === "agent" && args[2] === "list") {
			return ok(JSON.stringify({ result: { agents: [...agents].map((name) => ({ name })) } }));
		}
		if (args[1] === "workspace" && args[2] === "list") return ok(JSON.stringify({ result: { workspaces: [] } }));
		if ((args[1] === "workspace" || args[1] === "tab") && args[2] === "create") {
			return ok(
				JSON.stringify({
					result: { workspace: { workspace_id: "W1" }, tab: { tab_id: "T1" }, root_pane: { pane_id: "P1" } },
				}),
			);
		}
		if (args[1] === "agent" && args[2] === "prompt" && args.includes("--wait") && promptStalled.value) {
			const stderr = JSON.stringify({ error: { code: "agent_prompt_stalled", message: "no start seen" } });
			return { code: 1, stdout: "", stderr, timedOut: false };
		}
		if (args[1] === "agent" && args[2] === "start") {
			if (failAgentStart.value) return { code: 1, stdout: "boom", timedOut: false };
			agents.add(args[3] as string);
		}
		return ok();
	};
	const tool = buildDispatchTool({
		originKey: "slack/ch/C1/t/100.1",
		ompExecutable: "omp",
		homeDir: "/home",
		workspaceDir: "/ws",
		herdr: {},
		dispatchHosts: { wsl: { ssh: "wsl-ssh", workDir: "/r" } },
		run,
		log: noop,
		...(options.board === undefined ? {} : { herdrBoard: options.board }),
		...(options.approval === undefined
			? {}
			: {
					approve: async (summary: string, detail: ApprovalDetail) => {
						approvals.push({ summary, detail });
						return options.approval as ApprovalResult;
					},
				}),
		...(options.withTasks === false
			? {}
			: {
					tasks: {
						ledger,
						threadRef: () => ("threadRef" in options ? options.threadRef : "C1:100.1"),
						rootText: () => "[TASK] L2 로그 회전\n목표: 회전",
						port: new SlackChannel(transport),
						now: () => NOW,
						hostOps: () => host,
						...(options.disk === undefined
							? {}
							: {
									diskHeadroom: (path: string) => {
										const disk = options.disk as NonNullable<typeof options.disk>;
										disk.asked.push(path);
										return { path, freeBytes: disk.freeBytes, totalBytes: disk.totalBytes };
									},
								}),
					},
				}),
	});
	return { tool, ledger, transport, host, herdr, agents, failAgentStart, promptStalled, approvals };
}

const call = (h: Harness, params: Record<string, unknown>) =>
	h.tool.execute(params, { signal: new AbortController().signal });

describe("ompbot_dispatch taskSpec: new task", () => {
	test("one call creates worktree, four docs, registry row, agent, card and ⏳", async () => {
		const h = harness();
		const result = await call(h, { taskSpec: GOOD_SPEC, task: "회전을 구현해" });
		expect(result).toContain("T-20261026-01 등록·시작했습니다");

		const row = h.ledger.require("T-20261026-01");
		expect(row).toMatchObject({
			status: "working",
			threadRef: "C1:100.1",
			host: null,
			repo: "/r/repo",
			worktree: "/r/repo-t-20261026-01",
			branch: "task/T-20261026-01",
			agent: "t-20261026-01",
			originKey: "slack/ch/C1/t/100.1",
		});
		expect(row.acceptance).toEqual(acceptanceItems(GOOD_SPEC.acceptance));
		// The four docs are committed on the task branch right after they are written, before the agent starts.
		expect(h.host.calls).toEqual([
			"create /r/repo-t-20261026-01 task/T-20261026-01",
			"commit /r/repo-t-20261026-01 T-20261026-01 [4 files]",
		]);

		const dir = docsDirOf(row.worktree, row.taskId);
		expect([...h.host.files.keys()]).toEqual(
			["context.md", "spec.md", "PROGRESS.md", "outcome.md"].map((n) => `${dir}/${n}`),
		);
		expect(h.host.files.get(`${dir}/context.md`)).toContain("[TASK] L2 로그 회전\n목표: 회전");
		expect(h.host.files.get(`${dir}/spec.md`)).toContain("- [ ] AC-2: README에 설명이 있다");
		expect(h.host.files.get(`${dir}/PROGRESS.md`)).toContain("status: working");

		// Local herdr: workspace in the worktree, agent named from the TASKID, prompt = rules header + instruction.
		const create = h.herdr.find((cmd) => cmd[1] === "workspace" && cmd[2] === "create");
		expect(create).toContain("/r/repo-t-20261026-01");
		const start = h.herdr.find((cmd) => cmd[1] === "agent" && cmd[2] === "start");
		expect(start?.[3]).toBe("t-20261026-01");
		const prompt = h.herdr.find((cmd) => cmd[1] === "agent" && cmd[2] === "prompt");
		expect(prompt?.[3]).toBe("t-20261026-01");
		expect(prompt?.[4]).toContain("너는 T-20261026-01 담당이다");
		expect(prompt?.[4]).toContain("spec.md를 읽고 PROGRESS.md의 단계 목록부터");
		expect(prompt?.[4]).toContain("`date -Iseconds`로 얻은 실제 시각");
		expect(prompt?.[4]).toContain("단계 커밋에는 docs/tasks/T-20261026-01/ 갱신을 함께 넣는다");
		expect(prompt?.[4]).toEndWith("회전을 구현해");

		const post = h.transport.calls.find((c) => c.method === "postMessage");
		expect(post).toMatchObject({ channel: "C1", threadTs: "100.1" });
		const card = (post && "text" in post ? post.text : "").split("\n");
		expect(card[0]).toStartWith("`local`에서 `t-20261026-01`(로그 회전)가 맡았습니다.");
		expect(card).toContain("[목표] 로그 회전을 넣는다");
		expect(card).toContain("[가정] 없음");
		expect(card.some((line) => line.startsWith("진행 보기"))).toBe(false); // no board configured
		expect(result).toContain("접수 카드");
		expect(h.transport.calls.filter((c) => c.method === "addReaction")).toEqual([
			{ method: "addReaction", channel: "C1", timestamp: "100.1", name: "hourglass_flowing_sand" },
		]);
	});

	test("with a board: the card and the tool result carry the card link of the started pane", async () => {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () =>
				Response.json({
					machines: [
						{ id: "local", name: "oci", kind: "local" },
						{ id: "m-wsl", name: "wsl", kind: "ssh" },
					],
				}),
		});
		try {
			const board = { url: "https://board.test/task/", api: `http://127.0.0.1:${server.port}` };
			const local = harness({ board });
			const result = await call(local, {
				taskSpec: { ...GOOD_SPEC, assumptions: "로그는 앱 로그만으로 봤다" },
				task: "go",
			});
			const post = local.transport.calls.find((c) => c.method === "postMessage");
			const card = (post && "text" in post ? post.text : "").split("\n");
			expect(card[1]).toBe("진행 보기: https://board.test/task/?card=P1");
			expect(card).toContain("[가정] 로그는 앱 로그만으로 봤다");
			expect(result).toContain("진행 보기: https://board.test/task/?card=P1");

			const remote = harness({ board });
			await call(remote, { taskSpec: GOOD_SPEC, task: "go", host: "wsl" });
			const remotePost = remote.transport.calls.find((c) => c.method === "postMessage");
			expect(remotePost && "text" in remotePost ? remotePost.text : "").toContain(
				"진행 보기: https://board.test/task/?card=m-wsl:P1",
			);
		} finally {
			server.stop(true);
		}
	});

	test("AC-7: a local start on a low disk is refused before anything is registered, created or started", async () => {
		const GIB = 1024 ** 3;
		const disk = { freeBytes: 4 * GIB, totalBytes: 100 * GIB, asked: [] as string[] };
		const h = harness({ disk });
		const out = await call(h, { taskSpec: GOOD_SPEC, task: "회전을 구현해" });
		expect(out).toBe("시작 거부: 디스크 여유 부족 (/r free_gib=4.0, 기준 5GiB·10%)");
		expect(disk.asked).toEqual(["/r"]);
		expect(h.ledger.list()).toEqual([]);
		expect([h.host.calls, [...h.host.files.keys()], h.herdr]).toEqual([[], [], []]);
		expect(h.transport.calls).toEqual([]);

		// 8 GiB of 50 is 16%: neither under 5 GiB nor under 10%, so the start goes on.
		const roomy = harness({ disk: { freeBytes: 8 * GIB, totalBytes: 50 * GIB, asked: [] } });
		expect(await call(roomy, { taskSpec: GOOD_SPEC, task: "회전을 구현해" })).toContain(
			"T-20261026-01 등록·시작했습니다",
		);
	});

	test("AC-7: a remote host start never looks at the local disk", async () => {
		const disk = { freeBytes: 1024, totalBytes: 100 * 1024 ** 3, asked: [] as string[] };
		const h = harness({ disk });
		expect(await call(h, { taskSpec: GOOD_SPEC, task: "go", host: "wsl" })).toContain(
			"T-20261026-01 등록·시작했습니다",
		);
		expect(disk.asked).toEqual([]);
		expect(h.ledger.require("T-20261026-01").host).toBe("wsl");
	});

	test("host=wsl starts the agent through ssh herdr and records the host", async () => {
		const h = harness();
		await call(h, { taskSpec: GOOD_SPEC, task: "go", host: "wsl" });
		expect(h.ledger.require("T-20261026-01").host).toBe("wsl");
		const start = h.herdr.find((cmd) => cmd.includes("start") && cmd[0] === "ssh");
		expect(start?.slice(0, 6)).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "wsl-ssh"]);
		expect(h.herdr.some((cmd) => cmd.includes("--cwd") && cmd.includes("/r/repo-t-20261026-01"))).toBe(true);
	});

	test("failures undo only what this call created", async () => {
		const createFails = harness();
		createFails.host.failCreate = "branch exists";
		expect(await call(createFails, { taskSpec: GOOD_SPEC, task: "go" })).toContain("시작 실패: branch exists");
		expect(createFails.ledger.list()).toEqual([]);
		expect(createFails.host.calls).toEqual(["create /r/repo-t-20261026-01 task/T-20261026-01"]);
		expect(createFails.herdr).toEqual([]);
		expect(createFails.transport.calls).toEqual([]);

		const agentFails = harness();
		agentFails.failAgentStart.value = true;
		expect(await call(agentFails, { taskSpec: GOOD_SPEC, task: "go" })).toContain("시작 실패");
		expect(agentFails.host.calls).toEqual([
			"create /r/repo-t-20261026-01 task/T-20261026-01",
			"commit /r/repo-t-20261026-01 T-20261026-01 [4 files]",
			"remove /r/repo-t-20261026-01",
		]);

		// A docs commit that fails rolls the registration back before any agent starts.
		const commitFails = harness();
		commitFails.host.failCommit = "git commit failed: Author identity unknown";
		expect(await call(commitFails, { taskSpec: GOOD_SPEC, task: "go" })).toContain(
			"시작 실패: git commit failed: Author identity unknown",
		);
		expect(commitFails.host.calls.at(-1)).toBe("remove /r/repo-t-20261026-01");
		expect(commitFails.ledger.list()).toEqual([]);
		expect(commitFails.herdr).toEqual([]);
		expect(agentFails.ledger.list()).toEqual([]);
		// Only the read-only permalink lookup for context.md ran; nothing was posted or reacted.
		expect(agentFails.transport.calls.filter((call) => call.method !== "getPermalink")).toEqual([]);

		const occupied = harness();
		occupied.host.existing.add("/r/repo-t-20261026-01");
		expect(await call(occupied, { taskSpec: GOOD_SPEC, task: "go" })).toContain("이미 있습니다");
		expect(occupied.host.calls).toEqual([]);
		expect(occupied.ledger.list()).toEqual([]);
	});

	test("refuses name, missing task, bad spec, unknown host, no thread and unsupported sessions", async () => {
		const h = harness();
		await expect(call(h, { taskSpec: GOOD_SPEC, task: "go", name: "x" })).rejects.toThrow("name");
		await expect(call(h, { taskSpec: GOOD_SPEC })).rejects.toThrow("task(지시문)");
		await expect(call(h, { taskSpec: { ...GOOD_SPEC, acceptance: [] }, task: "go" })).rejects.toThrow("acceptance");
		await expect(call(h, { taskSpec: GOOD_SPEC, task: "go", host: "nope" })).rejects.toThrow("알 수 없는 호스트");
		await expect(call(harness({ threadRef: undefined }), { taskSpec: GOOD_SPEC, task: "go" })).rejects.toThrow(
			"스레드",
		);
		await expect(call(harness({ threadRef: "C1:-" }), { taskSpec: GOOD_SPEC, task: "go" })).rejects.toThrow("스레드");
		await expect(call(harness({ withTasks: false }), { taskSpec: GOOD_SPEC, task: "go" })).rejects.toThrow(
			"쓸 수 없습니다",
		);
		expect(h.ledger.list()).toEqual([]);
		expect(h.herdr).toEqual([]);
	});

	test("without taskSpec nothing task-related happens", async () => {
		const h = harness();
		const out = await call(h, { mode: "herdr", name: "plain", task: "후속" });
		expect(out).toContain("후속 지시를 plain에 전달했습니다");
		expect(h.ledger.list()).toEqual([]);
		expect(h.host.calls).toEqual([]);
		expect(h.transport.calls).toEqual([]);
		const read = await call(h, { mode: "herdr", name: "plain" });
		expect(read).toBe("▸ plain 최근 출력:\n{}");
	});
});

describe("ompbot_dispatch taskSpec: resume and read", () => {
	async function started(): Promise<Harness> {
		const h = harness();
		await call(h, { taskSpec: GOOD_SPEC, task: "go" });
		h.herdr.length = 0;
		h.transport.calls.length = 0;
		return h;
	}

	test("a live agent gets the PROGRESS-based prompt; review/blocked go back to working with ⏳", async () => {
		const h = await started();
		h.ledger.transition("T-20261026-01", "review", "bot");
		const out = await call(h, { taskSpec: { id: "T-20261026-01" }, task: "리뷰 반영해" });
		expect(out).toContain("살아 있는 에이전트에 재개 프롬프트를 보냈습니다 (review → working)");
		const prompt = h.herdr.find((cmd) => cmd[2] === "prompt");
		expect(prompt?.[3]).toBe("t-20261026-01");
		expect(prompt?.[4]).toContain("PROGRESS.md만 읽고 `current`부터 잇는다");
		expect(prompt?.[4]).toEndWith("리뷰 반영해");
		expect(h.herdr.some((cmd) => cmd[2] === "start")).toBe(false);
		expect(h.ledger.require("T-20261026-01").status).toBe("working");
		expect(h.ledger.history("T-20261026-01").at(-1)).toMatchObject({
			fromStatus: "review",
			toStatus: "working",
			actor: "bot",
			reason: "resume dispatch",
		});
		const reactions = h.transport.calls.filter((c) => c.method === "addReaction" || c.method === "removeReaction");
		expect(reactions.at(-1)).toMatchObject({ method: "addReaction", name: "hourglass_flowing_sand" });
		expect(reactions.some((c) => c.method === "removeReaction" && c.name === "mag")).toBe(true);
	});

	test("an unconfirmed resume prompt still resumes, saying the start was not seen", async () => {
		const h = await started();
		h.ledger.transition("T-20261026-01", "review", "bot");
		h.promptStalled.value = true;
		const out = await call(h, { taskSpec: { id: "T-20261026-01" }, task: "리뷰 반영해" });
		expect(out).toContain("살아 있는 에이전트에 재개 프롬프트를 보냈습니다(시작 확인 안 됨) (review → working)");
		expect(h.ledger.require("T-20261026-01").status).toBe("working");
	});

	test("an unconfirmed follow-up (local or remote) says it was delivered without a seen start", async () => {
		const h = harness();
		h.promptStalled.value = true;
		expect(await call(h, { mode: "herdr", name: "plain", task: "후속" })).toBe(
			'전달은 했지만 작업 시작이 확인되지 않았습니다(agent_prompt_stalled). 진행 확인: ompbot_dispatch {mode:"herdr", name:"plain"}',
		);
		h.agents.add("remote1");
		expect(await call(h, { host: "wsl", name: "remote1", task: "후속" })).toBe(
			'전달은 했지만 작업 시작이 확인되지 않았습니다(agent_prompt_stalled). 진행 확인: ompbot_dispatch {host:"wsl", name:"remote1"}',
		);
	});

	test("a missing agent is started again in the same worktree", async () => {
		const h = await started();
		h.agents.clear();
		const out = await call(h, { taskSpec: { id: "T-20261026-01" } });
		expect(out).toContain("같은 워크트리에서 새 에이전트를 시작했습니다");
		expect(h.herdr.find((cmd) => cmd[1] === "workspace" && cmd[2] === "create")).toContain("/r/repo-t-20261026-01");
		expect(h.herdr.find((cmd) => cmd[2] === "prompt")?.[4]).toContain("재개:");
		h.host.existing.clear();
		h.agents.clear();
		expect(await call(h, { taskSpec: { id: "T-20261026-01" } })).toContain("워크트리가 없습니다");
	});

	test("unknown, closed and host-mismatched ids are refused", async () => {
		const h = await started();
		await expect(call(h, { taskSpec: { id: "T-19990101-01" } })).rejects.toThrow("등록된 작업이 아닙니다");
		await expect(call(h, { taskSpec: { id: "T-20261026-01" }, host: "wsl" })).rejects.toThrow("host 불일치");
		h.ledger.transition("T-20261026-01", "done", "human");
		await expect(call(h, { taskSpec: { id: "T-20261026-01" } })).rejects.toThrow("닫힌 작업");
	});

	test("reading an agent bound to a task appends the judgement summary line", async () => {
		const h = await started();
		const out = await call(h, { mode: "herdr", name: "t-20261026-01" });
		expect(out).toContain("▸ T-20261026-01 AC 0/2 · 단계 0/1 · working · 2026-10-26T15:00:00+09:00");
	});
});

describe("ompbot_dispatch handoff risk scan", () => {
	const HIGH = "정리 후 git push --force origin main 해";
	const HIGH_RULES = "git_push_force, git_push_protected";
	/** A herdr call that hands `text` to an agent (start+prompt, resume prompt, follow-up prompt, ssh prompt). */
	const delivered = (h: Harness, text: string) =>
		h.herdr.some((cmd) => cmd.includes("prompt") && cmd.some((word) => word.endsWith(text)));
	const BRANCHES: Array<{
		name: string;
		setup?: (h: Harness) => Promise<void>;
		params: (task: string) => Record<string, unknown>;
	}> = [
		{ name: "taskSpec new", params: (task) => ({ taskSpec: GOOD_SPEC, task }) },
		{
			name: "taskSpec resume",
			setup: async (h) => {
				await call(h, { taskSpec: GOOD_SPEC, task: "go" });
				h.herdr.length = 0;
				h.transport.calls.length = 0;
			},
			params: (task) => ({ taskSpec: { id: "T-20261026-01" }, task }),
		},
		{ name: "host remote start", params: (task) => ({ host: "wsl", name: "remote-x", task }) },
		{ name: "herdr follow-up", params: (task) => ({ mode: "herdr", name: "plain", task }) },
	];
	const REFUSALS: Array<[string, ApprovalResult | undefined, string]> = [
		["denied", "denied", "denied"],
		["timeout", "timeout", "timeout"],
		["a thread reply", { replied: "응" }, "replied"],
		["no approver", undefined, "no_approver"],
	];

	for (const branch of BRANCHES) {
		for (const [label, approval, outcome] of REFUSALS) {
			test(`${branch.name}: high_risk + ${label} is refused before any herdr call`, async () => {
				const h = harness(approval === undefined ? {} : { approval });
				await branch.setup?.(h);
				const rows = h.ledger.list().length;
				await expect(call(h, branch.params(HIGH))).rejects.toThrow(
					`위험 검사에서 막혔습니다(${outcome}): ${HIGH_RULES}.`,
				);
				expect(h.herdr).toEqual([]);
				expect(h.approvals).toHaveLength(approval === undefined ? 0 : 1);
				// No worktree, docs or registry row for a refused new task; a resumed one is left as it was.
				expect(h.ledger.list()).toHaveLength(rows);
				if (branch.setup === undefined) expect(h.host.calls).toEqual([]);
			});
		}

		test(`${branch.name}: high_risk + approved delivers the brief and says so`, async () => {
			const h = harness({ approval: "approved" });
			await branch.setup?.(h);
			const out = await call(h, branch.params(HIGH));
			expect(delivered(h, HIGH)).toBe(true);
			expect(out.split("\n").at(-1)).toBe(`위험 검사: high_risk 승인됨 (${HIGH_RULES})`);
			expect(h.approvals).toEqual([
				{
					summary: "herdr 위임 지시문에 고위험 명령이 있습니다",
					detail: {
						action: [`L1 git_push_force: ${HIGH}`, `L1 git_push_protected: ${HIGH}`].join("\n"),
						impact: "승인하면 이 지시문이 사람 없이 워커에서 실행됩니다",
					},
				},
			]);
		});
	}

	test("an approved high_risk new task is registered at L3 at least", async () => {
		const raised = harness({ approval: "approved" });
		await call(raised, { taskSpec: GOOD_SPEC, task: HIGH });
		expect(raised.ledger.require("T-20261026-01").risk).toBe("L3");
		const kept = harness({ approval: "approved" });
		await call(kept, { taskSpec: { ...GOOD_SPEC, risk: "L4" }, task: HIGH });
		expect(kept.ledger.require("T-20261026-01").risk).toBe("L4");
	});

	test("a new task is scanned on task, title, goal, scope and background, not exclusions or acceptance", async () => {
		const inGoal = harness({ approval: "denied" });
		await expect(
			call(inGoal, { taskSpec: { ...GOOD_SPEC, goal: "운영 DB에서 DROP TABLE logs 실행" }, task: "go" }),
		).rejects.toThrow("sql_destructive");
		const inExclusions = harness({ approval: "denied" });
		const out = await call(inExclusions, {
			taskSpec: { ...GOOD_SPEC, exclusions: ["git reset --hard"], acceptance: ["git push --force 없이 끝난다"] },
			task: "go",
		});
		expect(out).toContain("T-20261026-01 등록·시작했습니다");
		expect(inExclusions.approvals).toEqual([]);
	});

	test("clear briefs never ask and return the unchanged result", async () => {
		const h = harness({ approval: "denied" });
		const out = await call(h, { mode: "herdr", name: "plain", task: "로그 회전을 구현해" });
		expect(out).toBe('후속 지시를 plain에 전달했습니다. 진행 확인: ompbot_dispatch {mode:"herdr", name:"plain"}');
		expect(h.approvals).toEqual([]);
	});

	test("advisory briefs go out without asking and end with the advisory line", async () => {
		const h = harness({ approval: "denied" });
		const out = await call(h, {
			mode: "herdr",
			name: "plain",
			task: "bun install 뒤 테스트를 돌린다\n머지·push·데몬 재시작(systemctl --user restart ompbot)은 하지 않는다",
		});
		expect(delivered(h, "하지 않는다")).toBe(true);
		expect(out.split("\n").at(-1)).toBe("위험 검사: advisory (package_install, service_control)");
		expect(h.approvals).toEqual([]);
	});
});
