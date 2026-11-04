import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessRunner, RunProcessResult } from "../src/dispatch/omp";
import { SlackChannel } from "../src/slack/channel";
import { FakeSlackTransport } from "../src/slack/fake-transport";
import { checkTask, digest } from "../src/tasks/checker";
import { acceptanceItems, docsDirOf, parseSpec, renderProgress, renderSpec } from "../src/tasks/docs";
import { evaluateTask, type TaskCheckCache } from "../src/tasks/evaluate";
import { createTaskHostOps, type TaskHostOps } from "../src/tasks/host";
import { TaskLedger, type TaskRow } from "../src/tasks/ledger";
import { TaskSweeper } from "../src/tasks/sweeper";

const T0 = Date.parse("2026-11-04T01:00:00Z");
/** The sweeper's in-memory check results; a fresh one per evaluation unless a test shares it. */
const cache = (): TaskCheckCache => new Map();
const BUN_TEST = '[check: command ["bun","test"] stdout~" 0 fail"]';
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

interface Task {
	ledger: TaskLedger;
	row: TaskRow;
	files: Record<string, string>;
}

/** A registered task whose three documents are complete: every AC checked with `test:` evidence. */
function task(acceptance: string[]): Task {
	const ledger = new TaskLedger(new Database(":memory:", { strict: true }), { clock: { now: () => T0 } });
	const row = ledger.register({
		title: "check",
		risk: "L2",
		originKey: "slack/ch/C1/t/100.1",
		threadRef: "C1:100.1",
		host: null,
		repo: "/r/repo",
		acceptance: acceptanceItems(acceptance),
	});
	const meta = {
		taskId: row.taskId,
		hostLabel: "local",
		repo: row.repo,
		worktree: row.worktree,
		branch: row.branch,
		agent: row.agent,
		threadLink: "x",
		registeredAt: T0,
	};
	const spec = renderSpec(
		meta,
		{ title: "t", risk: "L2", goal: "g", scope: [], exclusions: [], acceptance: [], repo: row.repo },
		row.acceptance,
	).replaceAll("- [ ] AC-", "- [x] AC-");
	const outcome = [
		`# ${row.taskId} Outcome 증거`,
		"## 요약",
		"바뀌었습니다.",
		...row.acceptance.flatMap((item) => [`## ${item.id}`, "- test: bun test → 5 pass 0 fail"]),
		"",
	].join("\n");
	const dir = docsDirOf(row.worktree, row.taskId);
	return {
		ledger,
		row,
		files: {
			[`${dir}/spec.md`]: spec,
			[`${dir}/PROGRESS.md`]: renderProgress(row.taskId, T0),
			[`${dir}/outcome.md`]: outcome,
		},
	};
}

interface FakeHost {
	ops: TaskHostOps;
	runs: { argv: string[]; worktree: string; timeoutMs: number }[];
	heads: { count: number };
}

function fakeHost(
	files: Record<string, string>,
	over: {
		run?: (argv: string[]) => { code: number | null; output: string; timedOut?: boolean };
		head?: () => { sha: string; clean: boolean };
	} = {},
): FakeHost {
	const runs: FakeHost["runs"] = [];
	const heads = { count: 0 };
	const unused = () => {
		throw new Error("not used");
	};
	const ops: TaskHostOps = {
		pathExists: unused,
		createWorktree: unused,
		removeWorktree: unused,
		writeFile: unused,
		commitDocs: unused,
		commitOnTaskBranch: unused,
		readFile: async (path) => ({ ok: true, value: files[path] }),
		runCheck: async ({ worktree, argv, timeoutMs }) => {
			runs.push({ worktree, argv, timeoutMs });
			const result = over.run?.(argv) ?? { code: 0, output: "5 pass\n 0 fail\n" };
			return { timedOut: false, ...result };
		},
		headOf: async () => {
			heads.count += 1;
			return over.head?.() ?? { sha: HEAD_A, clean: true };
		},
	};
	return { ops, runs, heads };
}

/** A sweeper over the real `evaluateTask` and `host`; the agent is idle, Slack is a fake. */
function sweeperFor(t: Task, host: FakeHost): { sweeper: TaskSweeper; transport: FakeSlackTransport } {
	const transport = new FakeSlackTransport();
	const sweeper = new TaskSweeper({
		ledger: t.ledger,
		evaluate: (row, checks) => evaluateTask(row, host.ops, checks),
		remind: async () => ({ ok: true }),
		agentStatus: async () => ({ ok: true, status: "idle" }),
		transport: new SlackChannel(transport),
		ownerUserId: "UOWN",
		now: () => T0,
		log: { info() {}, warn() {} },
	});
	return { sweeper, transport };
}

const posted = (transport: FakeSlackTransport): string[] =>
	transport.calls.flatMap((call) => (call.method === "postMessage" && "text" in call ? [call.text] : []));

describe("[check: …] signals in the judgement", () => {
	test("AC-3: a check that exits 1 or whose stdout misses the regex keeps the task short of the outcome", async () => {
		const { row, files } = task([`bun test가 통과한다 ${BUN_TEST}`, "README가 있다"]);

		const exit1 = fakeHost(files, { run: () => ({ code: 1, output: "3 pass\n 2 fail\n" }) });
		const failed = await evaluateTask(row, exit1.ops, cache());
		expect(failed.ok && failed.judgement.reached).toBe(false);
		const failedProblems = failed.ok ? failed.judgement.problems : [];
		expect(failedProblems).toHaveLength(1);
		expect(failedProblems[0]).toStartWith("check AC-1 실패: ");
		expect(exit1.runs).toEqual([{ worktree: row.worktree, argv: ["bun", "test"], timeoutMs: 120_000 }]);

		const mismatch = fakeHost(files, { run: () => ({ code: 0, output: "3 pass\n 2 fail\n" }) });
		const unmatched = await evaluateTask(row, mismatch.ops, cache());
		expect(unmatched.ok && unmatched.judgement.reached).toBe(false);
		expect(unmatched.ok ? unmatched.judgement.problems : []).toEqual([expect.stringMatching(/^check AC-1 실패: /)]);

		const passing = fakeHost(files);
		const passed = await evaluateTask(row, passing.ops, cache());
		expect(passed.ok && passed.judgement).toMatchObject({
			reached: true,
			problems: [],
			checks: [{ id: "AC-1", signal: 'command ["bun","test"] stdout~" 0 fail"', ok: true }],
		});
	});

	test("AC-2: a task without checks is judged exactly as before, and the runner is never asked", async () => {
		const { row, files } = task(["하나", "둘"]);
		const dir = docsDirOf(row.worktree, row.taskId);
		const spec = files[`${dir}/spec.md`] as string;
		let asked = 0;
		const judge = (specText: string, withRunner: boolean) =>
			checkTask({
				snapshot: row.acceptance,
				spec: specText,
				progress: files[`${dir}/PROGRESS.md`],
				outcome: files[`${dir}/outcome.md`],
				commitCheck: async () => "ok",
				...(withRunner
					? {
							runChecks: async () => {
								asked += 1;
								return { deferred: "never" };
							},
						}
					: {}),
			});

		const complete = await judge(spec, true);
		expect(complete).toMatchObject({ reached: true, problems: [], checks: [] });
		expect(complete).toEqual(await judge(spec, false));
		// The reached-notice key is the pre-check fingerprint, so a deploy does not re-post an old Outcome.
		expect(complete.reachKey).toBe(
			digest({
				spec: parseSpec(spec).acceptance,
				evidence: complete.evidence,
				updatedAt: complete.updatedAt,
			}),
		);

		const unchecked = spec.replace("- [x] AC-2", "- [ ] AC-2");
		const short = await judge(unchecked, true);
		expect(short).toMatchObject({ reached: false, problems: ["AC-2: spec.md 체크박스가 [x]가 아닙니다"] });
		expect(short).toEqual(await judge(unchecked, false));
		expect(asked).toBe(0);
	});

	test("AC-4: another unmet condition skips the checks; two sweeps at one HEAD run the command once", async () => {
		const t = task([`bun test가 통과한다 ${BUN_TEST}`]);
		const dir = docsDirOf(t.row.worktree, t.row.taskId);
		const unchecked = { ...t.files, [`${dir}/spec.md`]: t.files[`${dir}/spec.md`]?.replace("- [x]", "- [ ]") ?? "" };
		const early = fakeHost(unchecked);
		const judged = await evaluateTask(t.row, early.ops, cache());
		expect(judged.ok ? judged.judgement.problems : []).toEqual(["AC-1: spec.md 체크박스가 [x]가 아닙니다"]);
		expect([early.runs.length, early.heads.count]).toEqual([0, 0]);

		let head = HEAD_A;
		const host = fakeHost(t.files, {
			run: () => ({ code: 1, output: "1 fail" }),
			head: () => ({ sha: head, clean: true }),
		});
		const { sweeper } = sweeperFor(t, host);
		const first = await sweeper.check(t.row);
		const second = await sweeper.check(t.ledger.require(t.row.taskId));
		expect(host.runs).toHaveLength(1);
		expect(host.heads.count).toBe(2);
		expect([first.status, second.status]).toEqual(["working", "working"]);
		expect(second.judgement?.problems).toEqual([expect.stringMatching(/^check AC-1 실패: exit 1: 1 fail$/)]);

		head = HEAD_B;
		await sweeper.check(t.ledger.require(t.row.taskId));
		expect(host.runs).toHaveLength(2);
	});

	test("AC-5: uncommitted changes in the worktree defer the checks and hold the outcome", async () => {
		const t = task([`bun test가 통과한다 ${BUN_TEST}`]);
		const host = fakeHost(t.files, { head: () => ({ sha: HEAD_A, clean: false }) });
		const { sweeper, transport } = sweeperFor(t, host);
		const result = await sweeper.check(t.row);
		expect(host.runs).toHaveLength(0);
		expect(result.status).toBe("working");
		expect(result.judgement).toMatchObject({
			reached: false,
			checks: [],
			problems: ["미커밋 변경이 있어 check를 미룹니다"],
		});
		expect(posted(transport).some((text) => text.includes("Outcome 도달"))).toBe(false);
	});

	test("AC-7: file checks compare sha256 and a JSON field against the worktree file", async () => {
		const body = '{"version":"1.2.0","nested":{"list":[1,{"ok":true}]}}';
		const sha = createHash("sha256").update(body).digest("hex");
		const judge = async (signal: string, content: string | undefined) => {
			const t = task([`패키지 버전 [check: ${signal}]`]);
			const files = { ...t.files, ...(content === undefined ? {} : { [`${t.row.worktree}/pkg/a.json`]: content }) };
			const result = await evaluateTask(t.row, fakeHost(files).ops, cache());
			if (!result.ok) throw new Error(result.error);
			return result.judgement;
		};
		const pass = await judge(`file pkg/a.json sha256=${sha} json:.nested.list.1.ok=true`, body);
		expect(pass).toMatchObject({ reached: true, checks: [{ id: "AC-1", ok: true }] });
		expect((await judge('file pkg/a.json json:.version="1.2.0"', body)).reached).toBe(true);

		const wrongSha = await judge(`file pkg/a.json sha256=${"0".repeat(64)}`, body);
		expect(wrongSha.reached).toBe(false);
		expect(wrongSha.problems).toEqual([expect.stringMatching(/^check AC-1 실패: sha256 /)]);
		const wrongField = await judge('file pkg/a.json json:.version="2.0.0"', body);
		expect(wrongField.problems).toEqual(['check AC-1 실패: .version가 "1.2.0"입니다(기대 "2.0.0")']);
		const noField = await judge("file pkg/a.json json:.missing=1", body);
		expect(noField.problems).toEqual(["check AC-1 실패: .missing 필드가 없습니다"]);
		const notJson = await judge("file pkg/a.json json:.version=1", "not json");
		expect(notJson.problems).toEqual(["check AC-1 실패: JSON이 아닙니다: pkg/a.json"]);
		const missing = await judge("file pkg/a.json", undefined);
		expect(missing.problems).toEqual(["check AC-1 실패: 파일이 없습니다: pkg/a.json"]);
	});

	test("AC-8: the Outcome card says check n/n passed and carries none of the command output", async () => {
		const t = task([`bun test가 통과한다 ${BUN_TEST}`, 'README [check: file README.md; command ["true"]]']);
		const files = { ...t.files, [`${t.row.worktree}/README.md`]: "# readme\n" };
		const host = fakeHost(files, { run: () => ({ code: 0, output: "OUTPUT-MARKER 12 pass\n 0 fail\n" }) });
		const { sweeper, transport } = sweeperFor(t, host);
		const result = await sweeper.check(t.row);
		expect(result.status).toBe("review");
		const card = posted(transport).find((text) => text.includes("Outcome 도달")) ?? "";
		expect(card).toContain("check 3/3 통과");
		expect(card).not.toContain("OUTPUT-MARKER");
		expect(card).not.toContain("0 fail");
		expect(card).not.toContain("exit 0");
	});
});

describe("host runCheck / headOf", () => {
	function recorder(answer: Partial<RunProcessResult> = {}) {
		const calls: { cmd: string[]; cwd: string | undefined; timeoutMs: number | undefined }[] = [];
		const run: ProcessRunner = async (cmd, opts) => {
			calls.push({ cmd, cwd: opts.cwd, timeoutMs: opts.timeoutMs });
			return { code: 0, stdout: "", timedOut: false, ...answer };
		};
		return { calls, run };
	}

	test("AC-6: local argv runs as the process itself in the worktree, 120 s; output is stdout then stderr", async () => {
		const { calls, run } = recorder({ code: 1, stdout: "out\n", stderr: "err\n" });
		const ops = createTaskHostOps({ run });
		const result = await ops.runCheck({ worktree: "/r/wt", argv: ["bun", "test", "$HOME; id"], timeoutMs: 120_000 });
		expect(calls).toEqual([{ cmd: ["bun", "test", "$HOME; id"], cwd: "/r/wt", timeoutMs: 120_000 }]);
		expect(result).toEqual({ code: 1, output: "out\n\nerr\n", timedOut: false });
		await expect(ops.runCheck({ worktree: "/r/wt; id", argv: ["x"], timeoutMs: 1 })).rejects.toThrow("unsafe path");
	});

	test("AC-6: a real local run sees the worktree as cwd and its arguments verbatim (no shell)", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "ompbot-check-")));
		try {
			const ops = createTaskHostOps({});
			const pwd = await ops.runCheck({ worktree: dir, argv: ["pwd"], timeoutMs: 120_000 });
			expect(pwd).toEqual({ code: 0, output: `${dir}\n`, timedOut: false });
			const echo = await ops.runCheck({ worktree: dir, argv: ["echo", "$HOME;", "`id`"], timeoutMs: 120_000 });
			expect(echo.output).toBe("$HOME; `id`\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("AC-6: over ssh every argument is single-quoted after a cd into the worktree; ssh failure throws", async () => {
		const { calls, run } = recorder({ stdout: " 0 fail\n" });
		const ops = createTaskHostOps({ sshTarget: "wsl", run });
		const result = await ops.runCheck({
			worktree: "/r/wt",
			argv: ["bun", "test", "it's here", "a;b"],
			timeoutMs: 120_000,
		});
		expect(calls).toEqual([
			{
				cmd: [
					"ssh",
					"-o",
					"BatchMode=yes",
					"-o",
					"ConnectTimeout=8",
					"wsl",
					"--",
					"cd",
					"'/r/wt'",
					"&&",
					"'bun'",
					"'test'",
					"'it'\\''s here'",
					"'a;b'",
				],
				cwd: undefined,
				timeoutMs: 120_000,
			},
		]);
		expect(result).toEqual({ code: 0, output: " 0 fail\n", timedOut: false });
		const down = createTaskHostOps({ sshTarget: "wsl", run: recorder({ code: 255, stderr: "no route" }).run });
		await expect(down.runCheck({ worktree: "/r/wt", argv: ["true"], timeoutMs: 1 })).rejects.toThrow(
			"host unreachable",
		);
		const slow = createTaskHostOps({ sshTarget: "wsl", run: recorder({ code: null, timedOut: true }).run });
		expect(await slow.runCheck({ worktree: "/r/wt", argv: ["sleep"], timeoutMs: 1 })).toMatchObject({ timedOut: true });
	});

	test("headOf: HEAD sha plus whether git status --porcelain is empty; git failure throws", async () => {
		const sha = "c".repeat(40);
		const answers =
			(porcelain: string, revParse = { code: 0, stdout: `${sha}\n` }): ProcessRunner =>
			async (cmd) => ({
				...(cmd.includes("rev-parse") ? revParse : { code: 0, stdout: porcelain }),
				timedOut: false,
			});
		expect(await createTaskHostOps({ run: answers("") }).headOf("/r/wt")).toEqual({ sha, clean: true });
		expect(await createTaskHostOps({ run: answers("?? new.ts\n") }).headOf("/r/wt")).toEqual({ sha, clean: false });
		await expect(
			createTaskHostOps({ run: answers("", { code: 128, stdout: "fatal: not a git repository" }) }).headOf("/r/wt"),
		).rejects.toThrow("git rev-parse failed");
	});
});
