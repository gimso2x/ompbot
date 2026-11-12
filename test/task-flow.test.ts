import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkIpcTimeoutMs, type TasksCommandOptions, tasksCommand } from "../src/cli/tasks";
import { taskFlowStatus, taskStage } from "../src/flow/task-flow";
import { type NewTask, openTaskLedger, type TaskActor, type TaskRow, type TaskStatus } from "../src/tasks/ledger";
import { CHECK_TIMEOUT_MS } from "../src/tasks/signals";

const T0 = Date.parse("2026-11-08T00:00:00Z");
const min = (m: number) => T0 + m * 60_000;
type Move = [TaskStatus | null, TaskStatus, TaskActor, string, number];

/** Node → "status msg" of one task whose history is `moves` after registration; minutes are offsets from T0. */
function flow(
	status: TaskStatus,
	notices: Record<string, number>,
	moves: Move[],
	review = true,
): Record<string, string> {
	const transitions = [[null, "working", "bot", "registered", 0] as Move, ...moves].map(
		([fromStatus, toStatus, actor, reason, m]) => ({ taskId: "T-1", fromStatus, toStatus, actor, reason, at: min(m) }),
	);
	const out = taskFlowStatus(
		[{ taskId: "T-1", status, createdAt: min(0), progressAt: min(1), notices }],
		transitions,
		review,
	);
	expect(out.every((s) => s.task === "T-1" && s.at === new Date(s.at).toISOString())).toBe(true);
	return Object.fromEntries(out.map((s) => [s.node, `${s.status} ${s.msg}`.trim()]));
}

const LONG = `무결성 검사용 git diff가 73,481바이트로 스윕 상한 64,000바이트를 넘어 검사가 미뤄짐 ${"·".repeat(120)}`;
const JUDGE = ["ac", "integrity", "signals", "outcome"];

describe("taskFlowStatus", () => {
	test("① review→done: every node passes, landing carries the close reason", () => {
		const n = flow("done", { "reached:abc": min(5) }, [
			["working", "review", "bot", "reached", 5],
			["review", "done", "human", "close --as done", 9],
		]);
		for (const id of ["register", "worktree", "agent", "progress", ...JUDGE]) expect(n[id]).toStartWith("pass");
		for (const id of ["spec", "review", "dispatch"]) expect(n[id]).toBe("pass 등록 전 단계 · 기록 없음");
		expect(n.ownerReview).toBe("pass close --as done");
		expect(n.land).toBe("pass close --as done");
	});

	// doc/plans/first-install-defaults.md AC-3: an install without peer bots has no review step to draw.
	test("without peer bots there is no review node; with them it passes like the other pre-registration steps", () => {
		const moves: Move[] = [["working", "review", "bot", "reached", 5]];
		const without = flow("review", { "reached:abc": min(5) }, moves, false);
		expect(without.review).toBeUndefined();
		for (const id of ["spec", "dispatch"]) expect(without[id]).toBe("pass 등록 전 단계 · 기록 없음");
		expect(flow("review", { "reached:abc": min(5) }, moves, true).review).toBe("pass 등록 전 단계 · 기록 없음");
	});

	test("② blocked on an integrity reason fails integrity with the first 120 characters", () => {
		const n = flow("blocked", { [`blocked:91:${LONG}`]: min(4) }, [["working", "blocked", "bot", LONG, 4]]);
		expect(n.integrity).toBe(`fail ${LONG.slice(0, 120)}`);
		expect(n.build ?? "").not.toStartWith("fail");
	});

	test("③ blocked on any other reason fails build", () => {
		const reason = "AC-5는 제외 파일(snapshot.ts 데이터 계약)을 고쳐야만 맞출 수 있다";
		const n = flow("blocked", { [`blocked:3:${reason}`]: min(4) }, [["working", "blocked", "bot", reason, 4]]);
		expect(n.build).toBe(`fail ${reason}`);
		expect(n.integrity).toBeUndefined();
	});

	test("④ blocked/resume interleaving: the state is the end of the replay", () => {
		const n = flow(
			"blocked",
			{
				"unmet:1a15": min(1),
				"blocked:105:ompbot diff 한도를 넘는다": min(2),
				"resume:1": min(3),
				'blocked:107:무결성 검사가 "diff too large"로 미뤄진다': min(4),
				"resume:2": min(5),
				"blocked:109:워커가 테스트를 끝내지 못했다": min(6),
			},
			[
				["working", "blocked", "bot", "x", 2],
				["blocked", "working", "bot", "resume dispatch", 3],
				["working", "blocked", "bot", "x", 4],
				["blocked", "working", "bot", "resume dispatch", 5],
				["working", "blocked", "bot", "x", 6],
			],
		);
		expect(n.ac).toStartWith("fixed");
		expect(n.integrity).toStartWith("fixed");
		expect(n.build).toBe("fail 워커가 테스트를 끝내지 못했다");
	});

	test("⑤ review rejected, then reviewed again: ownerReview is fixed", () => {
		const n = flow("review", { "reached:a": min(3), "reached:b": min(7) }, [
			["working", "review", "bot", "reached", 3],
			["review", "working", "bot", "resume", 5],
			["working", "review", "bot", "reached", 7],
		]);
		expect(n.ownerReview).toStartWith("fixed");
		for (const id of JUDGE) expect(n[id]).toStartWith("pass");
		expect(n.land).toBeUndefined();
	});

	test("⑤′ review rejected and not yet back: ownerReview fails", () => {
		const n = flow("working", { "reached:a": min(3) }, [
			["working", "review", "bot", "reached", 3],
			["review", "working", "bot", "resume", 5],
		]);
		expect(n.ownerReview).toBe("fail 리뷰 반려");
	});

	test("⑥ cancelled fails land", () => {
		const n = flow("cancelled", {}, [["working", "cancelled", "human", "close --as cancelled", 3]]);
		expect(n.land).toBe("fail 취소");
	});

	test("⑦ blocked→done by the owner fixes the failures and skips the remaining judgement", () => {
		const n = flow("done", { "unmet:1a": min(2), [`blocked:91:${LONG}`]: min(4) }, [
			["working", "blocked", "bot", LONG, 4],
			["blocked", "done", "human", "close --as done", 8],
		]);
		expect(n.ac).toBe("fixed 오너 종료 · close --as done");
		expect(n.integrity).toBe("fixed 오너 종료 · close --as done");
		expect(n.signals).toBe("fixed 오너 종료 · 판정 생략");
		expect(n.outcome).toBe("fixed 오너 종료 · 판정 생략");
		expect(n.ownerReview).toStartWith("pass");
		expect(n.land).toStartWith("pass");
	});

	test("⑧ working→done by the owner skips every judgement", () => {
		const n = flow("done", {}, [["working", "done", "human", "close --as done", 4]]);
		for (const id of JUDGE) expect(n[id]).toBe("fixed 오너 종료 · 판정 생략");
		expect(n.ownerReview).toStartWith("pass");
		expect(n.land).toStartWith("pass");
	});

	test("a working task without judgement is building; lost and stale notices mark agent and progress", () => {
		const n = flow("working", { "lost:1": min(3), "stale2h:1": min(4) }, []);
		expect(n.build).toStartWith("running");
		expect(n.agent).toBe("fail 에이전트 없음");
		expect(n.progress).toBe("pass 2시간 무갱신");
	});
});

/** `taskStage` of one task whose history is `moves` after registration (progress at minute 1, KST = T0 + 9h). */
function stageOf(status: TaskStatus, notices: Record<string, number>, moves: Move[], closedAt: number | null = null) {
	const transitions = [[null, "working", "bot", "registered", 0] as Move, ...moves].map(
		([fromStatus, toStatus, actor, reason, m]) => ({ taskId: "T-1", fromStatus, toStatus, actor, reason, at: min(m) }),
	);
	const task = { taskId: "T-1", status, createdAt: min(0), progressAt: min(1), notices, closedAt };
	// A status line of another task must not leak into this one's stage.
	const other = taskFlowStatus(
		[{ taskId: "T-2", status: "blocked", createdAt: min(0), progressAt: null, notices: { "unmet:x": min(1) } }],
		[],
		true,
	);
	return taskStage(task, [...other, ...taskFlowStatus([task], transitions, true)], "Asia/Seoul");
}

describe("taskStage", () => {
	test("done: 완료 with the close time in KST", () => {
		const stage = stageOf(
			"done",
			{ "reached:a": min(5) },
			[
				["working", "review", "bot", "reached", 5],
				["review", "done", "human", "close --as done", 9],
			],
			min(9),
		);
		expect(stage).toEqual({ label: "완료", msg: "close 11-08 09:09", tone: "done" });
	});

	test("cancelled: 취소, off", () => {
		const stage = stageOf("cancelled", {}, [["working", "cancelled", "human", "close --as cancelled", 3]], min(3));
		expect(stage).toEqual({ label: "취소", msg: "", tone: "off" });
	});

	test("review: 오너 리뷰 차례, wait", () => {
		const stage = stageOf("review", { "reached:a": min(3) }, [["working", "review", "bot", "reached", 3]]);
		expect(stage).toEqual({ label: "오너 리뷰 차례", msg: "Outcome 도달 · 머지 대기", tone: "wait" });
	});

	test("working with a running node: <node> 중 with the progress time", () => {
		expect(stageOf("working", {}, [])).toEqual({ label: "구현 중", msg: "진행 기록 11-08 09:01", tone: "run" });
	});

	test("blocked on an integrity reason: 무결성에서 막힘 with the reason", () => {
		const stage = stageOf("blocked", { [`blocked:91:${LONG}`]: min(4) }, [["working", "blocked", "bot", LONG, 4]]);
		expect(stage).toEqual({ label: "무결성에서 막힘", msg: LONG.slice(0, 120), tone: "fail" });
	});

	test("two unresolved failures: the one earlier in the flow wins", () => {
		const stage = stageOf("blocked", { "unmet:1": min(2), [`blocked:91:${LONG}`]: min(4) }, [
			["working", "blocked", "bot", LONG, 4],
		]);
		expect(stage.label).toBe("수락기준에서 막힘");
		expect(stage.tone).toBe("fail");
	});

	test("blocked then resumed: the fixed node is no block; past a judged node no node runs, so 진행 중", () => {
		const stage = stageOf("working", { [`blocked:91:${LONG}`]: min(4), "resume:1": min(5) }, [
			["working", "blocked", "bot", LONG, 4],
			["blocked", "working", "bot", "resume dispatch", 5],
		]);
		expect(stage).toEqual({ label: "진행 중", msg: "진행 기록 11-08 09:01", tone: "run" });
	});
});

describe("tasks flow", () => {
	test("writes viewer.html and status.json from a temporary database without touching it", async () => {
		const home = mkdtempSync(join(tmpdir(), "task-flow-"));
		try {
			const dbPath = join(home, "ompbot.db");
			const ledger = openTaskLedger(dbPath, "Asia/Seoul", { now: () => T0 });
			const input: Omit<NewTask, "title"> = {
				risk: "L1",
				originKey: "o",
				threadRef: "t",
				host: null,
				repo: "local:/r",
				acceptance: [],
			};
			const a = ledger.register({ ...input, title: "a" });
			const b = ledger.register({ ...input, title: "b" });
			ledger.recordNotice(a.taskId, "blocked:1:무결성 diff too large");
			ledger.transition(a.taskId, "blocked", "bot", "무결성 diff too large");
			ledger.close();
			const snapshot = () => ({
				mtime: statSync(dbPath).mtimeMs,
				sha: createHash("sha256").update(readFileSync(dbPath)).digest("hex"),
			});
			const before = snapshot();

			expect(await tasksCommand(["flow", "--out", join(home, "out")], home)).toBe(0);
			const status = JSON.parse(readFileSync(join(home, "out", "status.json"), "utf8"));
			const html = readFileSync(join(home, "out", "viewer.html"), "utf8");
			const block = (id: string) => JSON.parse(new RegExp(`id="${id}">([\\s\\S]*?)</script>`).exec(html)?.[1] ?? "");
			expect(block("flow-status")).toEqual(status);
			expect(status).toContainEqual(expect.objectContaining({ task: a.taskId, node: "integrity", status: "fail" }));
			const graph = block("flow-data");
			expect(graph.items.map((i: { id: string; status: string }) => `${i.id} ${i.status}`)).toEqual([
				`${a.taskId} blocked`,
				`${b.taskId} working`,
			]);
			expect(graph.version).toBe(JSON.parse(readFileSync("package.json", "utf8")).version);
			expect(snapshot()).toEqual(before);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	// doc/plans/first-install-defaults.md AC-3: the exported graph follows config `peerBots`.
	test("the exported graph has the 검토 node only when config names peer bots", async () => {
		const home = mkdtempSync(join(tmpdir(), "task-flow-peers-"));
		try {
			const ledger = openTaskLedger(join(home, "ompbot.db"), "Asia/Seoul", { now: () => T0 });
			ledger.register({
				title: "a",
				risk: "L1",
				originKey: "o",
				threadRef: "t",
				host: null,
				repo: "local:/r",
				acceptance: [],
			});
			ledger.close();
			const graphOf = async (out: string) => {
				expect(await tasksCommand(["flow", "--out", join(home, out)], home)).toBe(0);
				const html = readFileSync(join(home, out, "viewer.html"), "utf8");
				const block = (id: string) => JSON.parse(new RegExp(`id="${id}">([\\s\\S]*?)</script>`).exec(html)?.[1] ?? "");
				return { graph: block("flow-data"), status: block("flow-status") as { node: string }[] };
			};

			const bare = await graphOf("bare");
			expect(bare.graph.nodes.map((n: { id: string }) => n.id)).not.toContain("review");
			const edges = bare.graph.edges.map((e: { from: string; to: string }) => `${e.from}>${e.to}`);
			expect(edges).toContain("spec>dispatch");
			expect(edges.filter((e: string) => e.includes("review"))).toEqual([]);
			expect(bare.status.map((s) => s.node)).not.toContain("review");

			writeFileSync(
				join(home, "config.json"),
				JSON.stringify({
					schemaVersion: 1,
					channels: { slack: { ownerUserId: "UOWNER0001" } },
					slack: { botTokenFile: "secrets/slack-bot-token", appTokenFile: "secrets/slack-app-token" },
					ompExecutable: process.execPath,
					workspaceDir: "workspace",
					peerBots: [{ userId: "UPEER00001", name: "peer" }],
				}),
				{ mode: 0o600 },
			);
			const peers = await graphOf("peers");
			expect(peers.graph.nodes.find((n: { id: string }) => n.id === "review")).toMatchObject({ name: "검토" });
			expect(peers.status.map((s) => s.node)).toContain("review");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("the flow code and viewer carry no bot nicknames or provider model ids", () => {
		for (const file of ["task-flow.ts", "viewer.html"]) {
			const text = readFileSync(new URL(`../src/flow/${file}`, import.meta.url), "utf8");
			expect(text).not.toMatch(/떡|쑥|anthropic\/|google-antigravity\//);
		}
	});

	test("viewer.html loads nothing from outside", () => {
		const html = readFileSync(new URL("../src/flow/viewer.html", import.meta.url), "utf8");
		expect(html).not.toMatch(/\b(?:src|href)\s*=\s*["']?\s*https?:\/\//i);
		expect(html).not.toMatch(/<link\b|url\(\s*["']?https?:/i);
		expect(html).not.toMatch(/(?:^|[\s;{}(])import\b/m);
	});
});

describe("tasks check against a slow daemon (qa50b H-6)", () => {
	/** One registered task in a fresh home whose acceptance carries `checks` `[check: …]` signals. */
	function homeWithTask(checks: number): { home: string; taskId: string; row: TaskRow } {
		const home = mkdtempSync(join(tmpdir(), "task-check-"));
		const ledger = openTaskLedger(join(home, "ompbot.db"), "Asia/Seoul", { now: () => T0 });
		const acceptance = Array.from({ length: checks }, (_, i) => ({
			id: `AC-${i + 1}`,
			text: `기준 ${i + 1} [check: command ["true"]]`,
		}));
		const row = ledger.register({
			title: "slow",
			risk: "L1",
			originKey: "o",
			threadRef: "t",
			host: null,
			repo: "local:/r",
			acceptance,
		});
		ledger.close();
		return { home, taskId: row.taskId, row };
	}
	/** Runs the CLI with its stdout/stderr captured. */
	async function runCli(args: string[], home: string, options?: TasksCommandOptions) {
		const out: string[] = [];
		const err: string[] = [];
		const write = { out: process.stdout.write, err: process.stderr.write };
		process.stdout.write = ((chunk: string) => out.push(String(chunk)) > 0) as typeof process.stdout.write;
		process.stderr.write = ((chunk: string) => err.push(String(chunk)) > 0) as typeof process.stderr.write;
		try {
			const code = await tasksCommand(args, home, options);
			return { code, stdout: out.join(""), stderr: err.join("") };
		} finally {
			process.stdout.write = write.out;
			process.stderr.write = write.err;
		}
	}

	test("the check wait covers every signal's check bound, so a check past 60 s is still waited for", () => {
		const none = homeWithTask(0);
		const three = homeWithTask(3);
		expect(checkIpcTimeoutMs(none.row)).toBeGreaterThanOrEqual(60_000);
		expect(checkIpcTimeoutMs(three.row)).toBeGreaterThan(3 * CHECK_TIMEOUT_MS);
		rmSync(none.home, { recursive: true, force: true });
		rmSync(three.home, { recursive: true, force: true });
	});

	test("a daemon that takes the request but does not answer in time is a delay, not 'not reachable', and nothing is judged locally", async () => {
		const { home, taskId } = homeWithTask(1);
		const received = Promise.withResolvers<void>();
		const server = Bun.listen<undefined>({
			unix: join(home, "ompbot.sock"),
			socket: {
				data() {
					// Holds the request like a check that runs past the CLI's wait.
					received.resolve();
				},
			},
		});
		try {
			const result = await runCli(["check", taskId], home, { checkTimeoutMs: 200 });
			await received.promise;
			expect(result.stderr).not.toContain("not reachable");
			expect(result.stderr).toContain("응답 지연 — 게시 여부 모름");
			expect(result.stdout).not.toContain("judgement");
			expect(result.code).toBe(1);
		} finally {
			server.stop(true);
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("no daemon socket at all is still 'not reachable' and judged locally", async () => {
		const { home, taskId } = homeWithTask(1);
		try {
			const result = await runCli(["check", taskId], home);
			expect(result.stderr).toContain("daemon not reachable — judging only, nothing posted");
			expect(result.stderr).not.toContain("응답 지연");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
