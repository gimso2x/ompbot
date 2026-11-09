import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tasksCommand } from "../src/cli/tasks";
import { taskFlowStatus } from "../src/flow/task-flow";
import { type NewTask, openTaskLedger, type TaskActor, type TaskStatus } from "../src/tasks/ledger";

const T0 = Date.parse("2026-11-08T00:00:00Z");
const min = (m: number) => T0 + m * 60_000;
type Move = [TaskStatus | null, TaskStatus, TaskActor, string, number];

/** Node → "status msg" of one task whose history is `moves` after registration; minutes are offsets from T0. */
function flow(status: TaskStatus, notices: Record<string, number>, moves: Move[]): Record<string, string> {
	const transitions = [[null, "working", "bot", "registered", 0] as Move, ...moves].map(
		([fromStatus, toStatus, actor, reason, m]) => ({ taskId: "T-1", fromStatus, toStatus, actor, reason, at: min(m) }),
	);
	const out = taskFlowStatus([{ taskId: "T-1", status, createdAt: min(0), progressAt: min(1), notices }], transitions);
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

describe("tasks flow", () => {
	test("writes viewer.html and status.json from a temporary database without touching it", async () => {
		const home = mkdtempSync(join(tmpdir(), "task-flow-"));
		try {
			const dbPath = join(home, "ompbot.db");
			const ledger = openTaskLedger(dbPath, { now: () => T0 });
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

	test("viewer.html loads nothing from outside", () => {
		const html = readFileSync(new URL("../src/flow/viewer.html", import.meta.url), "utf8");
		expect(html).not.toMatch(/\b(?:src|href)\s*=\s*["']?\s*https?:\/\//i);
		expect(html).not.toMatch(/<link\b|url\(\s*["']?https?:/i);
		expect(html).not.toMatch(/(?:^|[\s;{}(])import\b/m);
	});
});
