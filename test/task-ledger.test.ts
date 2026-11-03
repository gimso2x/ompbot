import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessRunner } from "../src/dispatch/omp";
import { acceptanceItems, docsDirOf, renderOutcome, renderProgress, renderSpec } from "../src/tasks/docs";
import { evaluateTask } from "../src/tasks/evaluate";
import { createTaskHostOps } from "../src/tasks/host";
import { migrateTaskSchema, openTaskLedger, TASK_SCHEMA, TaskLedger, TaskTransitionError } from "../src/tasks/ledger";
import { makeHome, type TestHome } from "./helpers/bot-home";
import { killSpawned, runMain } from "./helpers/daemon-process";

const base = {
	title: "로그 정리",
	risk: "L2" as const,
	originKey: "slack/ch/C1",
	threadRef: "C1:100.1",
	host: null,
	repo: "/r/repo",
	acceptance: acceptanceItems(["하나", "둘"]),
};

function ledgerAt(now: { ms: number }): TaskLedger {
	return new TaskLedger(new Database(":memory:", { strict: true }), { clock: { now: () => now.ms } });
}

describe("TaskLedger", () => {
	test("ids count per KST day and derive worktree, branch and agent", () => {
		const now = { ms: Date.parse("2026-10-26T01:00:00Z") };
		const ledger = ledgerAt(now);
		const first = ledger.register(base);
		const second = ledger.register({ ...base, host: "wsl" });
		expect([first.taskId, second.taskId]).toEqual(["T-20261026-01", "T-20261026-02"]);
		expect(first).toMatchObject({
			status: "working",
			worktree: "/r/repo-t-20261026-01",
			branch: "task/T-20261026-01",
			agent: "t-20261026-01",
			host: null,
		});
		expect(second.host).toBe("wsl");
		now.ms = Date.parse("2026-10-26T15:00:00Z"); // 00:00 KST of the next day
		expect(ledger.register(base).taskId).toBe("T-20261027-01");
		expect(ledger.getByAgent("t-20261026-02", "wsl")?.taskId).toBe("T-20261026-02");
		expect(ledger.getByAgent("t-20261026-02", null)).toBeUndefined();
		expect(ledger.isTaskRoot("C1:100.1")).toBe(true);
		expect(ledger.isTaskRoot("C1:999.9")).toBe(false);
	});

	test("bot paths can never reach done or cancelled; a human close can, from any open state, once", () => {
		const ledger = ledgerAt({ ms: 1_000 });
		const row = ledger.register(base);
		for (const target of ["done", "cancelled"] as const) {
			expect(() => ledger.transition(row.taskId, target, "bot")).toThrow(TaskTransitionError);
		}
		expect(ledger.transition(row.taskId, "review", "bot").status).toBe("review");
		expect(() => ledger.transition(row.taskId, "blocked", "bot")).toThrow(TaskTransitionError);
		expect(ledger.transition(row.taskId, "working", "bot").status).toBe("working");
		expect(ledger.transition(row.taskId, "blocked", "bot").status).toBe("blocked");
		expect(() => ledger.transition(row.taskId, "review", "bot")).toThrow(TaskTransitionError);
		expect(() => ledger.transition(row.taskId, "review", "human")).toThrow(TaskTransitionError);

		const closed = ledger.transition(row.taskId, "done", "human");
		expect(closed).toMatchObject({ status: "done", closedAt: 1_000 });
		expect(() => ledger.transition(row.taskId, "working", "bot")).toThrow(TaskTransitionError);
		expect(() => ledger.transition(row.taskId, "cancelled", "human")).toThrow(TaskTransitionError);
		expect(ledger.listActive()).toEqual([]);
	});

	test("recordNotice is true once per key; discard only drops a working row", () => {
		const ledger = ledgerAt({ ms: 5 });
		const row = ledger.register(base);
		expect(ledger.recordNotice(row.taskId, "reached:a")).toBe(true);
		expect(ledger.recordNotice(row.taskId, "reached:a")).toBe(false);
		expect(ledger.recordNotice(row.taskId, "reached:b")).toBe(true);
		expect(ledger.require(row.taskId).notices).toEqual({ "reached:a": 5, "reached:b": 5 });
		ledger.setProgressAt(row.taskId, 77);
		ledger.markReminded(row.taskId, 88);
		expect(ledger.require(row.taskId)).toMatchObject({ progressAt: 77, remindedAt: 88 });
		const other = ledger.register(base);
		ledger.transition(other.taskId, "review", "bot");
		ledger.discard(other.taskId);
		expect(ledger.get(other.taskId)).toBeDefined();
		ledger.discard(row.taskId);
		expect(ledger.get(row.taskId)).toBeUndefined();
	});

	test("history: registration line, one line per real move, none for no-ops or refused moves", () => {
		const now = { ms: 10 };
		const ledger = ledgerAt(now);
		const row = ledger.register(base);
		const lines = () => ledger.history(row.taskId).map((h) => [h.fromStatus, h.toStatus, h.actor, h.reason, h.at]);
		expect(lines()).toEqual([[null, "working", "bot", "registered", 10]]);
		now.ms = 20;
		ledger.transition(row.taskId, "working", "bot"); // same state: no-op
		expect(() => ledger.transition(row.taskId, "done", "bot")).toThrow(TaskTransitionError);
		ledger.transition(row.taskId, "review", "bot", "outcome reached AC 2/2");
		now.ms = 30;
		ledger.transition(row.taskId, "done", "human", "close --as done");
		expect(() => ledger.transition(row.taskId, "working", "bot")).toThrow(TaskTransitionError); // closed
		expect(lines()).toEqual([
			[null, "working", "bot", "registered", 10],
			["working", "review", "bot", "outcome reached AC 2/2", 20],
			["review", "done", "human", "close --as done", 30],
		]);
		const ids = ledger.history(row.taskId).map((h) => h.transitionId);
		expect(ids).toEqual([...ids].sort((a, b) => a - b));
		expect(ledger.history("T-19990101-01")).toEqual([]);
	});

	test("a failed history insert rolls the status change back", () => {
		const db = new Database(":memory:", { strict: true });
		const ledger = new TaskLedger(db, { clock: { now: () => 1 } });
		const row = ledger.register(base);
		db.run("CREATE TRIGGER fail_history BEFORE INSERT ON task_transitions BEGIN SELECT RAISE(ABORT, 'injected'); END");
		expect(() => ledger.transition(row.taskId, "review", "bot")).toThrow("injected");
		expect(ledger.require(row.taskId).status).toBe("working");
		expect(ledger.history(row.taskId)).toHaveLength(1);
	});

	test("discard drops the history lines too, with foreign keys on", () => {
		const db = new Database(":memory:", { strict: true });
		db.run("PRAGMA foreign_keys = ON");
		const ledger = new TaskLedger(db, { clock: { now: () => 1 } });
		const row = ledger.register(base);
		ledger.discard(row.taskId);
		expect(ledger.get(row.taskId)).toBeUndefined();
		expect(db.query("SELECT COUNT(*) AS n FROM task_transitions").get()).toEqual({ n: 0 });
	});

	test("migration adds the history table to a database that predates it, leaving task rows alone", () => {
		const db = new Database(":memory:", { strict: true });
		db.run(TASK_SCHEMA.slice(0, TASK_SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS task_transitions")));
		db.run(
			`INSERT INTO tasks (task_id, title, risk, origin_key, thread_ref, host, repo, worktree, branch, agent, status,
				acceptance_json, created_at, updated_at) VALUES ('T-20261001-01', 't', 'L2', 'o', 'C1:1.1', NULL, '/r', '/r-t', 'b', 'a', 'review', '[]', 5, 6)`,
		);
		const before = db.query("SELECT * FROM tasks").all();
		migrateTaskSchema(db);
		expect(db.query("SELECT * FROM tasks").all()).toEqual(before);
		const ledger = new TaskLedger(db, { clock: { now: () => 7 } });
		expect(ledger.history("T-20261001-01")).toEqual([]);
		ledger.transition("T-20261001-01", "working", "bot", "resume dispatch");
		expect(ledger.history("T-20261001-01").map((h) => [h.fromStatus, h.toStatus])).toEqual([["review", "working"]]);
	});
});

describe("host ops (fake runner)", () => {
	function recorder(respond: (cmd: string[]) => { code: number | null; stdout?: string; timedOut?: boolean }) {
		const commands: string[][] = [];
		const run: ProcessRunner = async (cmd) => {
			commands.push(cmd);
			const result = respond(cmd);
			return { code: result.code, stdout: result.stdout ?? "", timedOut: result.timedOut ?? false };
		};
		return { commands, run };
	}

	test("remote: an ssh that cannot connect reports ssh's own stderr as the unreachable reason", async () => {
		const stderr = "ssh: connect to host x port 22: Connection refused";
		const run: ProcessRunner = async () => ({ code: 255, stdout: "", stderr: `${stderr}\n`, timedOut: false });
		const ops = createTaskHostOps({ sshTarget: "x", run });
		expect(await ops.pathExists("/r/wt")).toEqual({ ok: false, error: `host unreachable: ${stderr}` });
		expect(await ops.readFile("/r/wt/spec.md")).toEqual({ ok: false, error: `host unreachable: ${stderr}` });
	});

	test("remote: ssh command lines for worktree add, existence, write, read and commit check", async () => {
		const { commands, run } = recorder(() => ({ code: 0, stdout: "ok" }));
		const ops = createTaskHostOps({ sshTarget: "wsl", run });
		await ops.createWorktree({ repo: "/r/repo", worktree: "/r/repo-t-20261026-01", branch: "task/T-20261026-01" });
		await ops.pathExists("/r/repo-t-20261026-01");
		await ops.writeFile("/r/repo-t-20261026-01/docs/tasks/T/spec.md", "안녕");
		await ops.readFile("/r/x/spec.md");
		await ops.commitExists("/r/wt", "abc1234");
		await ops.removeWorktree({ repo: "/r/repo", worktree: "/r/wt", branch: "task/T-20261026-01" });
		const ssh = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "wsl", "--"];
		expect(commands[0]).toEqual([
			...ssh,
			"git",
			"-C",
			"/r/repo",
			"worktree",
			"add",
			"-b",
			"task/T-20261026-01",
			"/r/repo-t-20261026-01",
			"HEAD",
			"2>&1",
		]);
		expect(commands[1]).toEqual([...ssh, "test", "-e", "/r/repo-t-20261026-01"]);
		const write = commands[2]?.at(-2) ?? "";
		expect(write).toBe(
			`mkdir -p /r/repo-t-20261026-01/docs/tasks/T && test ! -e /r/repo-t-20261026-01/docs/tasks/T/spec.md && echo ${Buffer.from("안녕").toString("base64")} | base64 -d > /r/repo-t-20261026-01/docs/tasks/T/spec.md`,
		);
		expect(commands[3]).toEqual([...ssh, "cat", "/r/x/spec.md"]);
		expect(commands[4]).toEqual([...ssh, "git", "-C", "/r/wt", "cat-file", "-e", "abc1234^{commit}"]);
		expect(commands[5]?.slice(7, 12)).toEqual(["git", "-C", "/r/repo", "worktree", "remove"]);
		expect(commands[6]?.slice(7)).toEqual(["git", "-C", "/r/repo", "branch", "-D", "task/T-20261026-01", "2>&1"]);
	});

	test("remote: the docs commit quotes its fixed message for the remote shell", async () => {
		const { commands, run } = recorder((cmd) => ({ code: 0, stdout: cmd.includes("rev-parse") ? "abc1234def\n" : "" }));
		const ops = createTaskHostOps({ sshTarget: "wsl", run });
		expect(await ops.commitDocs({ worktree: "/r/wt", taskId: "T-20261026-01" })).toEqual({
			ok: true,
			value: "abc1234def",
		});
		expect(commands.map((cmd) => cmd.slice(7))).toEqual([
			["git", "-C", "/r/wt", "add", "--", "docs/tasks/T-20261026-01", "2>&1"],
			[
				"git",
				"-C",
				"/r/wt",
				"commit",
				"-q",
				"-m",
				"'docs(task): T-20261026-01 4문서'",
				"--",
				"docs/tasks/T-20261026-01",
				"2>&1",
			],
			["git", "-C", "/r/wt", "rev-parse", "HEAD", "2>&1"],
		]);
		const refused = createTaskHostOps({
			sshTarget: "wsl",
			run: recorder(() => ({ code: 1, stdout: "nothing to commit" })).run,
		});
		expect(await refused.commitDocs({ worktree: "/r/wt", taskId: "T-20261026-01" })).toEqual({
			ok: false,
			error: "git add failed: nothing to commit",
		});
	});

	test("remote: unreachable hosts are failures, not 'missing' or 'no such commit'", async () => {
		const down = createTaskHostOps({
			sshTarget: "wsl",
			run: recorder(() => ({ code: 255, stdout: "ssh: no route" })).run,
		});
		expect((await down.readFile("/r/a")).ok).toBe(false);
		expect((await down.pathExists("/r/a")).ok).toBe(false);
		await expect(down.commitExists("/r/wt", "abc1234")).rejects.toThrow("unreachable");
		const timedOut = createTaskHostOps({ sshTarget: "wsl", run: recorder(() => ({ code: null, timedOut: true })).run });
		expect((await timedOut.readFile("/r/a")).ok).toBe(false);
		const missing = createTaskHostOps({ sshTarget: "wsl", run: recorder(() => ({ code: 1 })).run });
		expect(await missing.readFile("/r/a")).toEqual({ ok: true, value: undefined });
		expect(await missing.commitExists("/r/wt", "abc1234")).toBe(false);
	});

	test("paths and branches that are not shell-inert are refused before any command runs", async () => {
		const { commands, run } = recorder(() => ({ code: 0 }));
		const ops = createTaskHostOps({ sshTarget: "wsl", run });
		await expect(ops.readFile("/r/a; rm -rf /")).rejects.toThrow("unsafe path");
		await expect(ops.createWorktree({ repo: "/r", worktree: "/r-w", branch: "x;y" })).rejects.toThrow("unsafe branch");
		expect(commands).toEqual([]);
		expect(await ops.commitExists("/r/wt", "HEAD; id")).toBe(false);
	});

	describe("local, real temp git repo", () => {
		let dir: string;
		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "ompbot-task-host-"));
		});
		afterEach(() => rmSync(dir, { recursive: true, force: true }));

		test("worktree add, docs write/read, commit existence, rollback", async () => {
			const repo = join(dir, "repo");
			mkdirSync(repo);
			const git = (...args: string[]) => {
				const result = Bun.spawnSync(["git", "-C", repo, ...args], {
					env: {
						...process.env,
						GIT_AUTHOR_NAME: "t",
						GIT_AUTHOR_EMAIL: "t@t",
						GIT_COMMITTER_NAME: "t",
						GIT_COMMITTER_EMAIL: "t@t",
					},
				});
				if (result.exitCode !== 0) throw new Error(result.stderr.toString());
				return result.stdout.toString().trim();
			};
			git("init", "-q");
			writeFileSync(join(repo, "a.txt"), "a");
			git("add", "a.txt");
			git("commit", "-q", "-m", "init");
			const head = git("rev-parse", "HEAD");
			const ops = createTaskHostOps({});
			const worktree = `${repo}-t-20261026-01`;
			const input = { repo, worktree, branch: "task/T-20261026-01" };
			expect(await ops.pathExists(worktree)).toEqual({ ok: true, value: false });
			expect(await ops.createWorktree(input)).toEqual({ ok: true, value: null });
			expect(await ops.pathExists(worktree)).toEqual({ ok: true, value: true });
			const again = await ops.createWorktree(input);
			expect(again.ok).toBe(false);

			const spec = join(worktree, "docs/tasks/T-20261026-01/spec.md");
			expect(await ops.writeFile(spec, "x")).toEqual({ ok: true, value: null });
			expect((await ops.writeFile(spec, "y")).ok).toBe(false);
			expect(await ops.readFile(spec)).toEqual({ ok: true, value: "x" });
			expect(await ops.readFile(join(worktree, "nope.md"))).toEqual({ ok: true, value: undefined });
			expect(await ops.commitExists(worktree, head.slice(0, 10))).toBe(true);
			expect(await ops.commitExists(worktree, "deadbeefdeadbeef")).toBe(false);

			// The docs become the task branch's first commit; ops strips GIT_* env, so identity comes from repo config.
			git("config", "user.name", "t");
			git("config", "user.email", "t@t");
			const committed = await ops.commitDocs({ worktree, taskId: "T-20261026-01" });
			expect(committed.ok).toBe(true);
			const wt = (...args: string[]) =>
				Bun.spawnSync(["git", "-C", worktree, ...args])
					.stdout.toString()
					.trim();
			expect(committed.ok && committed.value).toBe(wt("rev-parse", "HEAD"));
			expect(wt("log", "-1", "--format=%s")).toBe("docs(task): T-20261026-01 4문서");
			expect(wt("rev-list", "--count", "task/T-20261026-01", `^${head}`)).toBe("1");
			expect(wt("status", "--porcelain")).toBe("");
			await expect(ops.commitDocs({ worktree, taskId: "T-1; id" })).rejects.toThrow("unsafe task id");

			await ops.removeWorktree(input);
			expect(await ops.pathExists(worktree)).toEqual({ ok: true, value: false });
			expect(git("branch", "--list", "task/T-20261026-01")).toBe("");
		});
	});
});

describe("evaluateTask", () => {
	test("reads the three docs through the host; an unreadable host is a failed evaluation", async () => {
		const row = new TaskLedger(new Database(":memory:", { strict: true }), { clock: { now: () => 1 } }).register(base);
		const dir = docsDirOf(row.worktree, row.taskId);
		const meta = {
			taskId: row.taskId,
			hostLabel: "local",
			repo: row.repo,
			worktree: row.worktree,
			branch: row.branch,
			agent: row.agent,
			threadLink: "x",
			registeredAt: 1,
		};
		const files: Record<string, string> = {
			[`${dir}/spec.md`]: renderSpec(
				meta,
				{ title: "t", risk: "L2", goal: "g", scope: [], exclusions: [], acceptance: [], repo: row.repo },
				row.acceptance,
			),
			[`${dir}/PROGRESS.md`]: renderProgress(row.taskId, 1),
			[`${dir}/outcome.md`]: renderOutcome(row.taskId),
		};
		const ops = createTaskHostOps({
			sshTarget: "h",
			run: async (cmd) => ({ code: 0, stdout: files[cmd.at(-1) ?? ""] ?? "", timedOut: false }),
		});
		const result = await evaluateTask(row, ops);
		expect(result.ok && result.judgement).toMatchObject({ reached: false, acChecked: 0, acTotal: 2, stepsTotal: 1 });
		const down = createTaskHostOps({
			sshTarget: "h",
			run: async () => ({ code: 255, stdout: "no route", timedOut: false }),
		});
		expect(await evaluateTask(row, down)).toMatchObject({ ok: false });
	});
});

describe("ompbot tasks (CLI)", () => {
	let home: TestHome;
	beforeEach(() => {
		home = makeHome("ompbot-tasks-cli-");
	});
	afterEach(() => {
		killSpawned();
		home.remove();
	});

	test("list / show / close round trip; close is the only way to done", async () => {
		const ledger = openTaskLedger(join(home.dir, "ompbot.db"));
		const row = ledger.register({ ...base, repo: join(home.dir, "repo") });
		ledger.close();

		const list = await runMain(home.dir, ["tasks", "list", "--json"]);
		expect(list.code).toBe(0);
		expect((JSON.parse(list.stdout) as { tasks: Array<{ taskId: string }> }).tasks.map((t) => t.taskId)).toEqual([
			row.taskId,
		]);
		expect((await runMain(home.dir, ["tasks", "list"])).stdout).toContain(`${row.taskId}  working`);

		// Local worktree docs do not exist: show reports a judgement with problems, never "reached".
		const show = await runMain(home.dir, ["tasks", "show", row.taskId]);
		expect(show.code).toBe(0);
		const shown = JSON.parse(show.stdout) as {
			judgement: { reached: boolean; problems: string[] };
			summary: string;
			history: Array<{ fromStatus: string | null; toStatus: string; actor: string; reason: string | null }>;
		};
		expect(shown.judgement.reached).toBe(false);
		expect(shown.summary).toContain("AC 0/2");
		expect(shown.history).toMatchObject([
			{ fromStatus: null, toStatus: "working", actor: "bot", reason: "registered" },
		]);

		expect((await runMain(home.dir, ["tasks", "close", row.taskId])).code).toBe(2);
		expect((await runMain(home.dir, ["tasks", "close", "T-19990101-01", "--as", "done"])).code).toBe(1);
		const closed = await runMain(home.dir, ["tasks", "close", row.taskId, "--as", "cancelled"]);
		expect(closed.code).toBe(0);
		expect(JSON.parse(closed.stdout)).toMatchObject({ closed: row.taskId, status: "cancelled" });
		expect(closed.stderr).toContain("daemon not reachable");
		const again = await runMain(home.dir, ["tasks", "close", row.taskId, "--as", "done"]);
		expect(again.code).toBe(1);
		expect(again.stderr).toContain("이미 cancelled");
		const history = JSON.parse((await runMain(home.dir, ["tasks", "show", row.taskId])).stdout).history as Array<{
			transitionId: number;
			fromStatus: string | null;
			toStatus: string;
			actor: string;
			reason: string | null;
		}>;
		expect(history.map((h) => [h.fromStatus, h.toStatus, h.actor, h.reason])).toEqual([
			[null, "working", "bot", "registered"],
			["working", "cancelled", "human", "close --as cancelled"],
		]);
		expect(history[0]?.transitionId).toBeLessThan(history[1]?.transitionId ?? 0);
	});
});
