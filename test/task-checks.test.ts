import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProcessRunner, RunProcessResult } from "../src/dispatch/omp";
import { SlackChannel } from "../src/slack/channel";
import { FakeSlackTransport } from "../src/slack/fake-transport";
import { checkTask, digest } from "../src/tasks/checker";
import { acceptanceItems, docsDirOf, parseSpec, renderProgress, renderSpec } from "../src/tasks/docs";
import { evaluateTask, type TaskCheckCache } from "../src/tasks/evaluate";
import { createTaskHostOps, type TaskHostOps } from "../src/tasks/host";
import { TaskLedger, type TaskRow } from "../src/tasks/ledger";
import { formatReachedNotice } from "../src/tasks/notify";
import { TaskSweeper } from "../src/tasks/sweeper";
import { registryOf } from "./helpers/channels";

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
function task(acceptance: string[], repo = "/r/repo"): Task {
	const ledger = new TaskLedger(new Database(":memory:", { strict: true }), { clock: { now: () => T0 } });
	const row = ledger.register({
		title: "check",
		risk: "L2",
		originKey: "slack/ch/C1/t/100.1",
		threadRef: "C1:100.1",
		host: null,
		repo,
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
	diffs: { count: number };
}

function fakeHost(
	files: Record<string, string>,
	over: {
		run?: (argv: string[]) => { code: number | null; output: string; timedOut?: boolean };
		head?: () => { sha: string; clean: boolean };
		/** The task branch's diff since its docs commit (default: empty); a string error is a failed read. */
		diff?: { ok: true; value: string } | { ok: false; error: string };
	} = {},
): FakeHost {
	const runs: FakeHost["runs"] = [];
	const heads = { count: 0 };
	const diffs = { count: 0 };
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
		branchDiff: async () => {
			diffs.count += 1;
			return over.diff ?? { ok: true, value: "" };
		},
	};
	return { ops, runs, heads, diffs };
}

/** A sweeper over the real `evaluateTask` and `host`; the agent is idle, Slack is a fake. */
function sweeperFor(t: Task, host: Pick<FakeHost, "ops">): { sweeper: TaskSweeper; transport: FakeSlackTransport } {
	const transport = new FakeSlackTransport();
	const sweeper = new TaskSweeper({
		ledger: t.ledger,
		evaluate: (row, checks) => evaluateTask(row, host.ops, checks),
		remind: async () => ({ ok: true }),
		agentStatus: async () => ({ ok: true, status: "idle" }),
		readAgent: async () => ({ ok: true, output: "" }),
		channels: registryOf(new SlackChannel(transport)),
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

interface GitTask extends Task {
	ops: TaskHostOps;
	/** The temp directory holding the repository and its task worktree. */
	root: string;
	/** Writes (or with `null` deletes) one file in the worktree and commits it on the task branch. */
	commit(path: string, content: string | null, message: string): void;
}

const gitAt =
	(cwd: string) =>
	(...args: string[]): string => {
		const result = Bun.spawnSync(["git", "-C", cwd, ...args]);
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		return result.stdout.toString().trim();
	};

/**
 * A real task worktree in a temp repository: `main` holds `mainFiles`, the task branch opens with the docs commit
 * (complete documents: every AC checked with `test:` evidence), as `startTask` leaves it.
 */
async function gitTask(mainFiles: Record<string, string> = {}, docsMessage?: string): Promise<GitTask> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ompbot-integrity-")));
	const repo = join(root, "repo");
	mkdirSync(repo);
	const git = gitAt(repo);
	git("init", "-q", "-b", "main");
	git("config", "user.name", "t");
	git("config", "user.email", "t@t");
	const seed = { "README.md": "# repo\n", ...mainFiles };
	for (const [path, content] of Object.entries(seed)) {
		mkdirSync(dirname(join(repo, path)), { recursive: true });
		writeFileSync(join(repo, path), content);
	}
	git("add", "--", ...Object.keys(seed));
	git("commit", "-q", "-m", "init");
	const t = task(["하나"], repo);
	const ops = createTaskHostOps({});
	const { worktree, branch, taskId } = t.row;
	expect(await ops.createWorktree({ repo, worktree, branch })).toEqual({ ok: true, value: null });
	for (const [path, content] of Object.entries(t.files)) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	const wt = gitAt(worktree);
	if (docsMessage === undefined) expect((await ops.commitDocs({ worktree, taskId })).ok).toBe(true);
	else {
		wt("add", "--", `docs/tasks/${taskId}`);
		wt("commit", "-q", "-m", docsMessage);
	}
	const commit = (path: string, content: string | null, message: string) => {
		if (content === null) wt("rm", "-q", "--", path);
		else {
			mkdirSync(dirname(join(worktree, path)), { recursive: true });
			writeFileSync(join(worktree, path), content);
			wt("add", "--", path);
		}
		wt("commit", "-q", "-m", message);
	};
	return { ...t, ops, root, commit };
}

describe("diff integrity of the task branch", () => {
	test("AC-1: an it.skip( added to a .test.ts holds the sweep short of the outcome; the commit removing it reaches", async () => {
		const g = await gitTask();
		try {
			g.commit("test/rotate.test.ts", 'it.skip("rotates", () => {});\n', "test: rotate (skipped)");
			const { sweeper, transport } = sweeperFor(g, g);
			const held = await sweeper.check(g.row);
			expect(held.status).toBe("working");
			expect(held.judgement?.reached).toBe(false);
			expect(held.judgement?.problems).toContainEqual(
				expect.stringMatching(/^무결성 skipped_test: test\/rotate\.test\.ts: it\.skip\(/),
			);
			expect(posted(transport).some((text) => text.includes("Outcome 도달"))).toBe(false);

			g.commit("test/rotate.test.ts", 'it("rotates", () => {});\n', "test: rotate");
			const reached = await sweeper.check(g.ledger.require(g.row.taskId));
			expect(reached.judgement).toMatchObject({ reached: true, problems: [] });
			expect(reached.status).toBe("review");
		} finally {
			rmSync(g.root, { recursive: true, force: true });
		}
	});

	test("AC-2: TODO markers and stub bodies hold the outcome too, one problem line per refusal", async () => {
		const t = task(["하나"]);
		const diff = [
			"diff --git a/src/rotate.ts b/src/rotate.ts",
			"--- a/src/rotate.ts",
			"+++ b/src/rotate.ts",
			"@@ -1,0 +1,2 @@",
			"+const size = 10; // TODO pick the real limit",
			'+export function rotate(): never { throw new Error("not implemented"); }',
		].join("\n");
		const judged = await evaluateTask(t.row, fakeHost(t.files, { diff: { ok: true, value: diff } }).ops, cache());
		expect(judged.ok && judged.judgement).toMatchObject({
			reached: false,
			integrityWarnings: [],
			problems: [
				"무결성 unfinished_work_marker: src/rotate.ts: const size = 10; // TODO pick the real limit",
				'무결성 stub_implementation: src/rotate.ts: export function rotate(): never { throw new Error("not implemented"); }',
			],
		});
	});

	test("AC-2: guard deletions and unproven claims do not hold the outcome; the card shows them under 무결성 경고", async () => {
		const t = task(["하나"]);
		const dir = docsDirOf(t.row.worktree, t.row.taskId);
		const files = {
			...t.files,
			[`${dir}/outcome.md`]: (t.files[`${dir}/outcome.md`] as string).replace(
				"바뀌었습니다.",
				"회전을 고쳤고 모두 통과했습니다.",
			),
		};
		const diff = [
			"--- a/src/rotate.ts",
			"+++ b/src/rotate.ts",
			"@@ -3 +2,0 @@",
			'-\tif (size < 0) throw new Error("refuse negative size");',
		].join("\n");
		const { sweeper, transport } = sweeperFor(t, fakeHost(files, { diff: { ok: true, value: diff } }));
		const result = await sweeper.check(t.row);
		expect(result.status).toBe("review");
		const warnings = [
			'무결성 guard_deletion_without_adversarial_regression: src/rotate.ts: if (size < 0) throw new Error("refuse negative size");',
			"무결성 unproven_claim_word: summary: 회전을 고쳤고 모두 통과했습니다.",
		];
		expect(result.judgement).toMatchObject({ reached: true, problems: [], integrityWarnings: warnings });
		const card = posted(transport).find((text) => text.includes("Outcome 도달")) ?? "";
		const lines = card.split("\n");
		const head = lines.indexOf("*⚠️ 무결성 경고*");
		// Right after the summary line, one bullet per warning.
		expect(lines[head - 1]).toBe("• 회전을 고쳤고 모두 통과했습니다.");
		expect(lines.slice(head + 1, head + 3)).toEqual(warnings.map((line) => `• ${line}`));
	});

	test("AC-2: a clean diff leaves the judgement and the card exactly as without the integrity read", async () => {
		const t = task(["하나"]);
		const dir = docsDirOf(t.row.worktree, t.row.taskId);
		const clean = [
			"--- /dev/null",
			"+++ b/src/rotate.ts",
			"@@ -0,0 +1 @@",
			"+export const rotate = (size: number): number => size;",
		].join("\n");
		const host = fakeHost(t.files, { diff: { ok: true, value: clean } });
		const withDiff = await evaluateTask(t.row, host.ops, cache());
		expect(host.diffs.count).toBe(1);
		const without = await checkTask({
			snapshot: t.row.acceptance,
			spec: t.files[`${dir}/spec.md`],
			progress: t.files[`${dir}/PROGRESS.md`],
			outcome: t.files[`${dir}/outcome.md`],
			commitCheck: async () => "ok",
		});
		expect(withDiff.ok && withDiff.judgement).toEqual(without);
		const { sweeper, transport } = sweeperFor(t, host);
		await sweeper.check(t.row);
		const card = posted(transport).find((text) => text.includes("Outcome 도달")) ?? "";
		expect(card).toBe(formatReachedNotice(t.row, without, "UOWN").replace("{{mention:UOWN}}", "<@UOWN>"));
		expect(card).not.toContain("무결성");
	});

	test("AC-3: the diff starts at the docs commit — a TODO main committed before it is not judged", async () => {
		const g = await gitTask({ "src/old.ts": "export const old = 1; // TODO from main\n" });
		try {
			g.commit("src/rotate.ts", "export const rotate = (size: number): number => size;\n", "feat: rotate");
			const diff = await g.ops.branchDiff({ worktree: g.row.worktree, branch: g.row.branch, taskId: g.row.taskId });
			expect(diff.ok).toBe(true);
			const text = diff.ok ? diff.value : "";
			expect(text).toContain("+export const rotate");
			expect(text).not.toContain("TODO from main");
			expect(text).not.toContain("docs/tasks/");
			const judged = await evaluateTask(g.row, g.ops, cache());
			expect(judged.ok && judged.judgement).toMatchObject({ reached: true, problems: [] });
		} finally {
			rmSync(g.root, { recursive: true, force: true });
		}
	});

	test("the integrity diff leaves out the worker's own task documents updated after the docs commit", async () => {
		const g = await gitTask({});
		try {
			g.commit("src/rotate.ts", "export const rotate = (size: number): number => size;\n", "feat: rotate");
			g.commit(`docs/tasks/${g.row.taskId}/PROGRESS.md`, "status: done\n", "docs(task): progress");
			const diff = await g.ops.branchDiff({ worktree: g.row.worktree, branch: g.row.branch, taskId: g.row.taskId });
			const text = diff.ok ? diff.value : "";
			expect(text).toContain("+export const rotate");
			expect(text).not.toContain("docs/tasks/");
		} finally {
			rmSync(g.root, { recursive: true, force: true });
		}
	});

	test("AC-3: a diff past the default 64 K cap but under the diff cap is read whole; past the diff cap it is refused", async () => {
		const g = await gitTask();
		try {
			g.commit("src/big.ts", `export const big = "${"x".repeat(70_000)}";\n`, "feat: big");
			const input = { worktree: g.row.worktree, branch: g.row.branch, taskId: g.row.taskId };
			const under = await g.ops.branchDiff(input);
			expect(under.ok).toBe(true);
			// Read whole through the real process runner, not cut at the default 64 K collector cap.
			expect(under.ok && under.value.length).toBeGreaterThan(70_000);

			g.commit("src/huge.ts", `export const huge = "${"y".repeat(520_000)}";\n`, "feat: huge");
			const over = await g.ops.branchDiff(input);
			expect(over).toEqual({ ok: false, error: "diff too large" });
		} finally {
			rmSync(g.root, { recursive: true, force: true });
		}
	});

	test("AC-3: no docs commit or a failing git defers the integrity check and holds the outcome", async () => {
		const g = await gitTask({}, "docs: task documents");
		try {
			const input = { worktree: g.row.worktree, branch: g.row.branch, taskId: g.row.taskId };
			expect(await g.ops.branchDiff(input)).toEqual({ ok: false, error: "no_base" });
			const noBase = await evaluateTask(g.row, g.ops, cache());
			expect(noBase.ok && noBase.judgement).toMatchObject({
				reached: false,
				problems: ["diff를 읽지 못해 무결성 검사를 미룹니다: no_base"],
			});

			// git answers the base, then fails the diff itself.
			const failing = createTaskHostOps({
				run: async (cmd) =>
					cmd.includes("log")
						? { code: 0, stdout: `${"d".repeat(40)}\n`, timedOut: false }
						: { code: 128, stdout: "fatal: bad revision", timedOut: false },
			});
			expect(await failing.branchDiff(input)).toEqual({ ok: false, error: "git diff failed: fatal: bad revision" });
			const failed = await evaluateTask(g.row, failing, cache());
			expect(failed.ok && failed.judgement).toMatchObject({
				reached: false,
				problems: ["diff를 읽지 못해 무결성 검사를 미룹니다: git diff failed: fatal: bad revision"],
			});
		} finally {
			rmSync(g.root, { recursive: true, force: true });
		}
	});

	test("AC-3: evaluateTask without the sweep's checks (CLI, dashboard) never reads the diff", async () => {
		const g = await gitTask();
		try {
			g.commit("test/rotate.test.ts", 'it.skip("rotates", () => {});\n', "test: rotate (skipped)");
			let reads = 0;
			const counted: TaskHostOps = {
				...g.ops,
				branchDiff: (input) => {
					reads += 1;
					return g.ops.branchDiff(input);
				},
			};
			const judged = await evaluateTask(g.row, counted);
			expect(judged.ok && judged.judgement).toMatchObject({ reached: true, integrityWarnings: [] });
			expect(reads).toBe(0);
			const swept = await evaluateTask(g.row, counted, cache());
			expect(swept.ok && swept.judgement.reached).toBe(false);
			expect(reads).toBe(1);
		} finally {
			rmSync(g.root, { recursive: true, force: true });
		}
	});
});
