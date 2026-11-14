import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCards } from "../src/dashboard/board";
import { readSessionConversation } from "../src/dashboard/thread-conversation";
import { classifyLaneCompletion } from "../src/lanes/integrity";
import type { GitRunner } from "../src/lanes/verify";
import { resolveLaneRepo } from "../src/lanes/worktree";
import { openMonitorLedger } from "../src/monitors/ledger";
import { exportMonitors, PortableUsageError } from "../src/monitors/portable";
import { parseMonitorSpec } from "../src/monitors/spec";
import { parseTaskSpecInput, TaskSpecError } from "../src/tasks/docs";
import { resolveTaskHost } from "../src/tasks/host";
import { runSignal } from "../src/tasks/signals";
import { makeHome, type TestHome } from "./helpers/bot-home";
import { makeRepo } from "./helpers/git-fixtures";
import { laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

// 2차 딥시크 QA low 레인 M(doc/plans/qa50b-low-fixes.md) 회귀 테스트. 토큰은 가짜 모양만 쓴다.
const FAKE_SLACK = ["xoxb", "TEST", "0", "lanem"].join("-");
const FAKE_GH = `ghp_${"T".repeat(36)}`;

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function home(): TestHome {
	const h = makeHome("ompbot-lane-m-home-");
	cleanups.push(h.remove);
	return h;
}

describe("M-1: dispatchHosts lookups take only the config's own keys", () => {
	test("constructor, __proto__ and toString are unknown hosts, a configured one resolves", () => {
		const hosts = { wsl: { ssh: "wsl-host" } };
		for (const name of ["constructor", "__proto__", "toString", "nope"]) {
			expect(() => resolveTaskHost(name, hosts)).toThrow("알 수 없는 호스트");
		}
		expect(() => resolveTaskHost("wsl", hosts)).not.toThrow();
	});
});

describe("M-3·M-5: lane root and status messages", () => {
	test("M-3: a title with Slack mention syntax is escaped in the root and the status", async () => {
		const h = laneHarness(home().dir);
		const repos: string[] = [];
		cleanups.push(() => {
			h.close();
			for (const repo of repos) removeRepoAndWorktrees(repo);
		});
		const lane = await h.manager.start({ title: "<!channel> <@U1> 알림", cwd: makeRepo(repos), channel: "D1" });
		await h.settle();
		const texts = [
			...h.transport.posts().map((post) => post.text),
			...h.transport.calls.flatMap((call) => (call.method === "updateMessage" ? [call.text] : [])),
		];
		expect(texts.some((text) => text.includes("&lt;!channel&gt;"))).toBe(true);
		expect(texts.some((text) => text.includes("<!channel>") || text.includes("<@U1>"))).toBe(false);
		// The stored title stays as the model wrote it (the lane prompt and the dashboard read it).
		expect(lane.title).toBe("<!channel> <@U1> 알림");
	});

	test("M-5: a failed status post leaves the root reading ❌, not 🔄", async () => {
		const h = laneHarness(home().dir);
		const repos: string[] = [];
		cleanups.push(() => {
			h.close();
			for (const repo of repos) removeRepoAndWorktrees(repo);
		});
		const original = h.transport.postMessage.bind(h.transport);
		let posted = 0;
		h.transport.postMessage = async (args) => {
			posted += 1;
			if (posted === 2) throw new Error("status post failed");
			return original(args);
		};
		await expect(h.manager.start({ title: "root-left", cwd: makeRepo(repos), channel: "D1" })).rejects.toThrow(
			"status post failed",
		);
		const rootTs = h.transport.posts()[0]?.ts;
		expect(h.transport.posts()[0]?.text).toBe("🔄 root-left");
		const edits = h.transport.calls.flatMap((call) =>
			call.method === "updateMessage" && call.ts === rootTs ? [call.text] : [],
		);
		expect(edits.at(-1)).toBe("❌ root-left");
		expect(h.store.listLanes()).toHaveLength(0);
	});
});

describe("M-4: a lane does not start inside a submodule", () => {
	test("resolveLaneRepo refuses a work tree that has a superproject", async () => {
		const top = tempDir("ompbot-lane-m-sub-");
		const git: GitRunner = async (args) => {
			const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
			if (args.includes("--show-toplevel")) return ok(`${top}\n`);
			if (args.includes("--show-superproject-working-tree")) return ok("/srv/parent\n");
			if (args.includes("symbolic-ref")) return ok("main\n");
			if (args.includes("--verify")) return ok(`${"a".repeat(40)}\n`);
			return { code: 1, stdout: "", stderr: "unexpected" };
		};
		const found = await resolveLaneRepo(top, git);
		expect(found.ok).toBe(false);
		expect(found.ok === false && found.problem).toContain("서브모듈");
	});
});

describe("M-6: a guard removed by a rename to a non-code name is still judged", () => {
	test("guard.ts → guard.ts.bak dropping a throw line is a guard deletion", () => {
		const diff = [
			"diff --git a/src/guard.ts b/src/guard.ts.bak",
			"similarity index 80%",
			"rename from src/guard.ts",
			"rename to src/guard.ts.bak",
			"--- a/src/guard.ts",
			"+++ b/src/guard.ts.bak",
			"@@ -2 +1,0 @@",
			'-\tif (!allowed) throw new Error("permission denied");',
			"",
		].join("\n");
		const refusals = classifyLaneCompletion({ summary: "", diff });
		expect(refusals.map((r) => r.category)).toContain("guard_deletion_without_adversarial_regression");
	});

	test("lines added to the non-code new name are still exempt", () => {
		const diff = [
			"diff --git a/notes.ts b/notes.md",
			"rename from notes.ts",
			"rename to notes.md",
			"--- a/notes.ts",
			"+++ b/notes.md",
			"@@ -1,0 +2 @@",
			"+TODO: write more",
			"",
		].join("\n");
		expect(classifyLaneCompletion({ summary: "", diff })).toEqual([]);
	});
});

describe("M-7: a check block's secret is refused also when JSON-escaped", () => {
	const spec = {
		title: "t",
		risk: "L2",
		goal: "g",
		scope: ["s"],
		exclusions: ["e"],
		repo: "/home/u/repo",
		background: "b",
	};
	test("\\u escapes decoding to a token are refused like the literal token", () => {
		const literal = `확인 [check: command ["echo","${FAKE_SLACK}"]]`;
		const escaped = `확인 [check: command ["echo","\\u0078${FAKE_SLACK.slice(1)}"]]`;
		expect(() => parseTaskSpecInput({ ...spec, acceptance: [literal] })).toThrow(TaskSpecError);
		expect(() => parseTaskSpecInput({ ...spec, acceptance: [escaped] })).toThrow(TaskSpecError);
		expect(() =>
			parseTaskSpecInput({ ...spec, acceptance: ['확인 [check: command ["echo","\\u0068i"]]'] }),
		).not.toThrow();
	});
});

describe("M-8: json: signals see only the file's own fields", () => {
	test("__proto__ and constructor are missing fields, a real field still matches", async () => {
		const io = {
			runCheck: async () => {
				throw new Error("not run");
			},
			readBytes: async () => Buffer.from('{"a": {"b": 1}}'),
		};
		expect(await runSignal("file x.json json:.__proto__={}", io)).toMatchObject({ ok: false });
		expect(await runSignal("file x.json json:.a.constructor={}", io)).toMatchObject({ ok: false });
		expect(await runSignal("file x.json json:.a.b=1", io)).toMatchObject({ ok: true });
	});
});

describe("M-11·M-12: monitors export directory", () => {
	function ledgerWithOne() {
		const dir = tempDir("ompbot-lane-m-mon-");
		const ledger = openMonitorLedger(join(dir, "ompbot.db"));
		cleanups.push(() => ledger.close());
		const ctx = { scriptsRoot: join(dir, "scripts"), workspaceDir: dir, defaultTimezone: "Asia/Seoul" };
		ledger.addMonitor(
			parseMonitorSpec(
				{
					name: "daily",
					trigger: { kind: "cron", schedule: "0 9 * * *", timezone: "Asia/Seoul" },
					instruction: "x",
					overlap: "skip",
				},
				ctx,
			),
		);
		return { dir, ledger, ctx };
	}

	test("M-11: --dir naming a regular file is a usage error, the file untouched", () => {
		const { dir, ledger, ctx } = ledgerWithOne();
		const file = join(dir, "not-a-dir");
		writeFileSync(file, "keep\n");
		expect(() => exportMonitors(ledger, file, ctx)).toThrow(PortableUsageError);
		expect(() => exportMonitors(ledger, join(file, "below"), ctx)).toThrow(PortableUsageError);
		expect(readFileSync(file, "utf8")).toBe("keep\n");
	});

	test("M-12: a directory named *.json is left alone by the stale-file cleanup", () => {
		const { dir, ledger, ctx } = ledgerWithOne();
		const out = join(dir, "out");
		mkdirSync(join(out, "keep.json"), { recursive: true });
		writeFileSync(join(out, "stale.json"), "{}\n");
		const result = exportMonitors(ledger, out, ctx);
		expect(result).toMatchObject({ written: 1, removed: 1 });
		expect(readdirSync(out).sort()).toEqual(["daily.json", "keep.json"]);
	});
});

describe("M-16·M-17: dashboard masking", () => {
	test("M-16: a tool call name holding a token is masked in the conversation", () => {
		const dir = tempDir("ompbot-lane-m-conv-");
		const file = join(dir, "s.jsonl");
		const at = (n: number) => new Date(1_800_000_000_000 + n * 1000).toISOString();
		const records = [
			{
				type: "message",
				id: "u1",
				timestamp: at(0),
				message: { role: "user", content: [{ type: "text", text: "q" }] },
			},
			{
				type: "message",
				id: "a1",
				timestamp: at(1),
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "c1", name: `run_${FAKE_GH}`, arguments: { i: "x" } },
						{ type: "toolCall", id: "c2", name: `pending_${FAKE_GH}`, arguments: { i: "y" } },
					],
				},
			},
			{
				type: "message",
				id: "r1",
				timestamp: at(2),
				message: { role: "toolResult", toolCallId: "c1", toolName: "x", content: [{ type: "text", text: "ok" }] },
			},
		];
		writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
		const json = JSON.stringify(readSessionConversation(file));
		expect(json).toContain('"kind":"tool"');
		expect(json).not.toContain(FAKE_GH);
	});

	test("M-17: machine name, pane name and cwd of a board card are masked", () => {
		const cards = buildCards(
			{
				id: "m1",
				name: `host-${FAKE_GH}`,
				kind: "remote",
				snapshot: {
					panes: [
						{
							pane_id: "p1",
							agent: "omp",
							agent_status: "working",
							name: `agent-${FAKE_GH}`,
							cwd: `/srv/${FAKE_GH}`,
						},
					],
				},
			} as never,
			1_000,
			new Map(),
		);
		expect(cards).toHaveLength(1);
		const json = JSON.stringify(cards);
		expect(json).not.toContain(FAKE_GH);
		expect(json).toContain("[REDACTED]");
	});
});
