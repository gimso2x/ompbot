import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAIM_GRACE_MS } from "../src/lanes/manager";
import { INCONCLUSIVE_APPROVED, INTEGRITY_APPROVED, type LaneRow } from "../src/lanes/status";
import { type CheckRun, createTaskHostOps, type TaskHostOps } from "../src/tasks/host";
import { makeHome, type TestHome } from "./helpers/bot-home";
import { git, makeRepo } from "./helpers/git-fixtures";
import {
	LANE_START,
	type LaneHarness,
	type LaneHarnessExtra,
	laneHarness,
	removeRepoAndWorktrees,
} from "./helpers/lane-harness";

const CHECK_A = 'a.txt가 있다 [check: command ["sh","-c","test -f a.txt"]]';
const CHECK_B = 'b.txt가 있다 [check: command ["sh","-c","test -f b.txt"]]';
const SLOW_ARGV = ["sh", "-c", "exit 0 # slow"];
const CHECK_SLOW = 'bun test가 통과한다 [check: command ["sh","-c","exit 0 # slow"]]';

let home: TestHome;
let repos: string[];

beforeEach(() => {
	home = makeHome("ompbot-lane-checks-home-");
	repos = [];
});

afterEach(() => {
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
});

/**
 * The real host ops, with every `runCheck` recorded: which worktree, which argv, and how many ran at the same time.
 * `overrides` replace single operations (a host that fails, a HEAD that is not clean).
 */
function recordingOps(overrides: Partial<TaskHostOps> = {}) {
	const real = createTaskHostOps();
	const calls: Array<{ worktree: string; argv: string[] }> = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const ops: TaskHostOps = {
		...real,
		async runCheck(input) {
			calls.push({ worktree: input.worktree, argv: input.argv });
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			try {
				return await real.runCheck(input);
			} finally {
				inFlight -= 1;
			}
		},
		...overrides,
	};
	return { ops, calls, maxInFlight: () => maxInFlight };
}

/** Commits `files` in the lane's worktree, as the lane itself would; returns the new HEAD. */
function commitIn(worktree: string, ...files: string[]): string {
	for (const file of files) writeFileSync(join(worktree, file), `${file}\n`);
	git(worktree, "add", "--", ...files);
	git(worktree, "commit", "-q", "-m", `add ${files.join(" ")}`);
	return git(worktree, "rev-parse", "HEAD");
}

async function startLane(h: LaneHarness, acceptance: string[]): Promise<LaneRow> {
	const repo = makeRepo(repos);
	const lane = await h.manager.start({ title: "checked", cwd: repo, channel: "D1", acceptance, risk: "L2" });
	await h.settle();
	return lane;
}

describe("a lane claim re-runs the acceptance checks in its worktree (AC-4)", () => {
	test("all checks pass: closed; each check ran once, one at a time, in the lane worktree", async () => {
		const rec = recordingOps();
		const h = laneHarness(home.dir, { hostOps: rec.ops });
		const lane = await startLane(h, [CHECK_A, CHECK_B]);
		const sha = commitIn(lane.cwd, "a.txt", "b.txt");

		const text = await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "a b 추가" });
		expect(text).toContain("검증 통과");
		const closed = h.store.getLane(lane.name);
		expect(closed?.status).toBe("closed");
		expect(rec.calls.map((call) => call.argv)).toEqual([
			["sh", "-c", "test -f a.txt"],
			["sh", "-c", "test -f b.txt"],
		]);
		expect(rec.calls.every((call) => call.worktree === lane.meta.worktree)).toBe(true);
		expect(rec.maxInFlight()).toBe(1);
		expect(closed?.meta.checks).toMatchObject({
			head: sha,
			results: [
				{ id: "AC-1", ok: true },
				{ id: "AC-2", ok: true },
			],
		});
		await h.settle();
		h.close();
	});

	test("a failing check: not-done with `check AC-n 실패`, steered once; the same HEAD is not checked again; a new commit is", async () => {
		const rec = recordingOps();
		const h = laneHarness(home.dir, { hostOps: rec.ops });
		const lane = await startLane(h, [CHECK_A, CHECK_B]);
		const first = commitIn(lane.cwd, "a.txt");

		const text = await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "a 추가" });
		await h.settle();
		expect(text).toContain("[not-done]");
		expect(text).toContain("check AC-2 실패");
		expect(text).not.toContain("check AC-1 실패");
		expect(h.store.getLane(lane.name)?.status).toBe("not-done");
		expect(h.store.getLane(lane.name)?.history.at(-1)?.detail).toContain("check AC-2 실패");
		expect(h.steers(lane.originKey)).toHaveLength(1);
		expect(h.steers(lane.originKey)[0]).toContain("check AC-2 실패");
		expect(rec.calls).toHaveLength(2);
		expect(h.store.getLane(lane.name)?.meta.checks).toMatchObject({
			head: first,
			results: [
				{ id: "AC-1", ok: true },
				{ id: "AC-2", ok: false },
			],
		});

		// Claimed again without a new commit: the recorded verdict at this HEAD stands, nothing runs again.
		const again = await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "다시" });
		await h.settle();
		expect(again).toContain("check AC-2 실패");
		expect(h.store.getLane(lane.name)?.status).toBe("not-done");
		expect(rec.calls).toHaveLength(2);

		commitIn(lane.cwd, "b.txt");
		expect(await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "b 추가" })).toContain(
			"검증 통과",
		);
		expect(h.store.getLane(lane.name)?.status).toBe("closed");
		expect(rec.calls).toHaveLength(4);
		await h.settle();
		h.close();
	});

	test("a claimed commit that is not the worktree HEAD: not-done without running any check", async () => {
		const rec = recordingOps();
		const h = laneHarness(home.dir, { hostOps: rec.ops });
		const lane = await startLane(h, [CHECK_A, CHECK_B]);
		const claimed = commitIn(lane.cwd, "a.txt", "b.txt");
		commitIn(lane.cwd, "c.txt");

		const text = await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: claimed, summary: "a b 추가" });
		await h.settle();
		expect(text).toContain("[not-done]");
		expect(text).toContain("HEAD가 클레임 커밋이 아님");
		expect(h.store.getLane(lane.name)?.status).toBe("not-done");
		expect(h.steers(lane.originKey)).toHaveLength(1);
		expect(rec.calls).toHaveLength(0);
		h.close();
	});

	test("uncommitted changes in the worktree: not-done without running any check", async () => {
		const rec = recordingOps();
		const h = laneHarness(home.dir, { hostOps: rec.ops });
		const lane = await startLane(h, [CHECK_A, CHECK_B]);
		commitIn(lane.cwd, "a.txt", "b.txt");
		writeFileSync(join(lane.cwd, "dirty.txt"), "x\n");

		const text = await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "a b 추가" });
		await h.settle();
		expect(text).toContain("[not-done]");
		expect(h.store.getLane(lane.name)?.status).toBe("not-done");
		expect(rec.calls).toHaveLength(0);
		h.close();
	});

	test("a HEAD that turned dirty after git verified the claim: not-done (미커밋) without running any check", async () => {
		let head = "";
		const rec = recordingOps({ headOf: async () => ({ sha: head, clean: false }) });
		const h = laneHarness(home.dir, { hostOps: rec.ops, verify: async () => ({ ok: true, sha: head }) });
		const lane = await startLane(h, [CHECK_A]);
		head = commitIn(lane.cwd, "a.txt");

		const text = await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "a 추가" });
		await h.settle();
		expect(text).toContain("[not-done]");
		expect(text).toContain("미커밋");
		expect(h.store.getLane(lane.name)?.status).toBe("not-done");
		expect(rec.calls).toHaveLength(0);
		h.close();
	});

	test("a commit landing between the HEAD check and the check run: not-done, never closed on the unchecked claim", async () => {
		const real = createTaskHostOps();
		let reads = 0;
		let moved = "";
		const rec = recordingOps({
			async headOf(worktree) {
				reads += 1;
				const head = await real.headOf(worktree);
				// The second read (inside the check run) sees a commit made after the claim.
				if (reads === 2) moved = commitIn(worktree, "late.txt");
				return reads === 2 ? { sha: moved, clean: true } : head;
			},
		});
		const h = laneHarness(home.dir, { hostOps: rec.ops });
		const lane = await startLane(h, [CHECK_A]);
		commitIn(lane.cwd, "a.txt");

		const text = await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "a 추가" });
		await h.settle();
		expect(text).toContain("HEAD가 클레임 커밋이 아님");
		expect(h.store.getLane(lane.name)?.status).toBe("not-done");
		expect(h.store.getLane(lane.name)?.meta.checks?.head).toBe(moved);
		h.close();
	});

	test("acceptance without `[check:]` runs nothing and closes on git alone", async () => {
		const rec = recordingOps();
		const h = laneHarness(home.dir, { hostOps: rec.ops });
		const lane = await startLane(h, ["README를 다듬는다"]);
		commitIn(lane.cwd, "a.txt");
		expect(await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "a 추가" })).toContain(
			"검증 통과",
		);
		expect(rec.calls).toHaveLength(0);
		await h.settle();
		h.close();
	});
});

describe("a host error during the checks defers the verdict (AC-5)", () => {
	test("runCheck throws: the lane stays done-claimed, and the tick after CLAIM_GRACE_MS judges it again", async () => {
		let failures = 1;
		const real = createTaskHostOps();
		const rec = recordingOps({
			async runCheck(input) {
				if (failures > 0) {
					failures -= 1;
					throw new Error("cannot run check: host unreachable");
				}
				return real.runCheck(input);
			},
		});
		const h = laneHarness(home.dir, { hostOps: rec.ops });
		const lane = await startLane(h, [CHECK_A]);
		commitIn(lane.cwd, "a.txt");

		const text = await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "a 추가" });
		expect(text).toContain("5분");
		expect(h.store.getLane(lane.name)?.status).toBe("done-claimed");
		expect(h.steers(lane.originKey)).toHaveLength(0);

		h.advance(CLAIM_GRACE_MS - 1);
		await h.manager.tick();
		await h.manager.settledInBackground();
		expect(h.store.getLane(lane.name)?.status).toBe("done-claimed");

		h.advance(1);
		await h.manager.tick();
		await h.manager.settledInBackground();
		expect(h.store.getLane(lane.name)?.status).toBe("closed");
		expect(h.store.getLane(lane.name)?.meta.checks?.results).toMatchObject([{ id: "AC-1", ok: true }]);
		await h.settle();
		h.close();
	});

	test("headOf throws: same deferral, no check runs until the later verdict", async () => {
		let failures = 1;
		const real = createTaskHostOps();
		const rec = recordingOps({
			async headOf(worktree) {
				if (failures > 0) {
					failures -= 1;
					throw new Error(`cannot read HEAD of ${worktree}: host unreachable`);
				}
				return real.headOf(worktree);
			},
		});
		const h = laneHarness(home.dir, { hostOps: rec.ops });
		const lane = await startLane(h, [CHECK_A]);
		commitIn(lane.cwd, "a.txt");

		expect(await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "a 추가" })).toContain(
			"5분",
		);
		expect(h.store.getLane(lane.name)?.status).toBe("done-claimed");
		expect(rec.calls).toHaveLength(0);

		h.advance(CLAIM_GRACE_MS);
		await h.manager.tick();
		await h.manager.settledInBackground();
		expect(h.store.getLane(lane.name)?.status).toBe("closed");
		expect(rec.calls).toHaveLength(1);
		await h.settle();
		h.close();
	});
});

/**
 * Host ops whose `SLOW_ARGV` check times out while `slow.timedOut` is set (no process runs for it); every other check
 * runs for real. `slowRuns()` counts the slow check's runs.
 */
function slowOps() {
	const real = createTaskHostOps();
	const slow = { timedOut: true };
	const runs: string[][] = [];
	const isSlow = (argv: string[]) => argv.join(" ") === SLOW_ARGV.join(" ");
	const ops: TaskHostOps = {
		...real,
		async runCheck(input) {
			runs.push(input.argv);
			if (!isSlow(input.argv)) return real.runCheck(input);
			return slow.timedOut ? { code: null, output: "", timedOut: true } : { code: 0, output: "", timedOut: false };
		},
	};
	return { ops, slow, runs, slowRuns: () => runs.filter(isSlow).length };
}

/** An approval surface that answers `verdict` and records every summary it was asked. */
function fakeApprovals(verdict: "approved" | "denied" | "timeout") {
	const asked: string[] = [];
	return {
		asked,
		approvals: {
			request: async (_channel: string, summary: string) => {
				asked.push(summary);
				return verdict;
			},
		},
	};
}

describe("a timed-out check is inconclusive, not a violation", () => {
	test("(a)(b)(c) inconclusive only: done-claimed, nothing steered; not judged again before the grace; after it only the timed-out check runs, and passing closes", async () => {
		const host = slowOps();
		const asked = fakeApprovals("approved");
		const h = laneHarness(home.dir, { hostOps: host.ops, approvals: asked.approvals });
		const lane = await startLane(h, [CHECK_A, CHECK_SLOW]);
		const sha = commitIn(lane.cwd, "a.txt");

		const text = await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "a 추가" });
		await h.settle();
		expect(text).toContain("확인 불가");
		expect(text).not.toContain("[not-done]");
		const held = h.store.getLane(lane.name);
		expect(held?.status).toBe("done-claimed");
		expect(h.steers(lane.originKey)).toHaveLength(0);
		expect(held?.history.some((entry) => entry.event === "not_done")).toBe(false);
		expect(held?.meta.checks).toMatchObject({
			head: sha,
			results: [
				{ id: "AC-1", ok: true },
				{ id: "AC-2", ok: false, inconclusive: true, detail: "300초 안에 끝나지 않았습니다(확인 불가)" },
			],
			inconclusive: { head: sha, runs: 1 },
		});
		expect(host.runs).toHaveLength(2);

		h.advance(CLAIM_GRACE_MS - 1);
		await h.manager.tick();
		await h.manager.settledInBackground();
		expect(host.runs).toHaveLength(2);
		expect(h.store.getLane(lane.name)?.status).toBe("done-claimed");

		host.slow.timedOut = false;
		h.advance(1);
		await h.manager.tick();
		await h.settle();
		expect(host.runs).toHaveLength(3);
		expect(host.runs.at(-1)).toEqual(SLOW_ARGV);
		const closed = h.store.getLane(lane.name);
		expect(closed?.status).toBe("closed");
		expect(closed?.meta.checks).toEqual({
			head: sha,
			results: [
				{ id: "AC-1", signal: 'command ["sh","-c","test -f a.txt"]', ok: true, detail: "exit 0" },
				{ id: "AC-2", signal: 'command ["sh","-c","exit 0 # slow"]', ok: true, detail: "exit 0" },
			],
		});
		expect(closed?.meta.land?.autoLandHeld).toBeUndefined();
		expect(asked.asked).toHaveLength(0);
		expect(h.steers(lane.originKey)).toHaveLength(0);
		h.close();
	});

	test("(d) inconclusive twice: one approval card; approved closes with the 확인 불가 승인 mark, nothing runs again", async () => {
		const host = slowOps();
		const asked = fakeApprovals("approved");
		const h = laneHarness(home.dir, { hostOps: host.ops, approvals: asked.approvals });
		const lane = await startLane(h, [CHECK_SLOW]);
		commitIn(lane.cwd, "a.txt");

		await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "a 추가" });
		expect(asked.asked).toHaveLength(0);
		h.advance(CLAIM_GRACE_MS);
		await h.manager.tick();
		await h.settle();
		expect(host.slowRuns()).toBe(2);
		expect(asked.asked).toEqual([
			`레인 ${lane.name} 재실행 검사 확인 불가(300초 초과 2회) — 승인하면 이 검사 없이 닫습니다.\n- check AC-1: command ["sh","-c","exit 0 # slow"]`,
		]);
		const closed = h.store.getLane(lane.name);
		expect(closed?.status).toBe("closed");
		expect(closed?.meta.land?.autoLandHeld).toBe(INCONCLUSIVE_APPROVED);
		expect(closed?.meta.checks?.inconclusive).toEqual({
			head: closed?.meta.sha ?? "",
			runs: 2,
			lastAt: expect.any(Number),
		});
		expect(h.steers(lane.originKey)).toHaveLength(0);

		h.advance(CLAIM_GRACE_MS);
		await h.manager.tick();
		await h.settle();
		expect(host.slowRuns()).toBe(2);
		expect(asked.asked).toHaveLength(1);
		h.close();
	});

	for (const verdict of ["denied", "timeout"] as const) {
		test(`(d) inconclusive twice, approval ${verdict}: not-done with the owner's refusal; the same HEAD never asks or runs again`, async () => {
			const host = slowOps();
			const asked = fakeApprovals(verdict);
			const h = laneHarness(home.dir, { hostOps: host.ops, approvals: asked.approvals });
			const lane = await startLane(h, [CHECK_SLOW]);
			commitIn(lane.cwd, "a.txt");

			await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "a 추가" });
			h.advance(CLAIM_GRACE_MS);
			await h.manager.tick();
			await h.settle();
			expect(asked.asked).toHaveLength(1);
			expect(h.store.getLane(lane.name)?.status).toBe("not-done");
			const reason =
				"check AC-1 300초 초과 2회 — 오너가 닫지 않음. 검사를 빠르게 할 수 있으면 고쳐 새 커밋으로 다시 주장";
			expect(h.store.getLane(lane.name)?.history.at(-1)?.detail).toBe(reason);
			expect(h.steers(lane.originKey)).toHaveLength(1);
			expect(h.steers(lane.originKey)[0]).toContain(reason);

			// Claimed again at the same HEAD: not run, not asked again — the same refusal.
			const again = await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "다시" });
			await h.settle();
			expect(again).toContain(reason);
			expect(h.store.getLane(lane.name)?.status).toBe("not-done");
			expect(host.slowRuns()).toBe(2);
			expect(asked.asked).toHaveLength(1);
			h.close();
		});
	}

	test("(d) inconclusive twice without an approval surface: not-done", async () => {
		const host = slowOps();
		const h = laneHarness(home.dir, { hostOps: host.ops });
		const lane = await startLane(h, [CHECK_SLOW]);
		commitIn(lane.cwd, "a.txt");
		await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "a 추가" });
		h.advance(CLAIM_GRACE_MS);
		await h.manager.tick();
		await h.settle();
		expect(h.store.getLane(lane.name)?.status).toBe("not-done");
		expect(h.store.getLane(lane.name)?.history.at(-1)?.detail).toContain("오너가 닫지 않음");
		h.close();
	});

	test("(e) a violation beside a timed-out check: not-done as before, the reasons name the violation only", async () => {
		const host = slowOps();
		const asked = fakeApprovals("approved");
		const h = laneHarness(home.dir, { hostOps: host.ops, approvals: asked.approvals });
		const lane = await startLane(h, [CHECK_B, CHECK_SLOW]);
		commitIn(lane.cwd, "a.txt");

		const text = await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "a 추가" });
		await h.settle();
		expect(text).toContain("[not-done]");
		expect(text).toContain("check AC-1 실패");
		expect(text).not.toContain("AC-2");
		expect(text).not.toContain("확인 불가");
		expect(h.store.getLane(lane.name)?.status).toBe("not-done");
		expect(h.store.getLane(lane.name)?.history.at(-1)?.detail).toBe("check AC-1 실패: exit 1: (출력 없음)");
		expect(h.steers(lane.originKey)).toHaveLength(1);
		expect(h.steers(lane.originKey)[0]).not.toContain("확인 불가");
		expect(asked.asked).toHaveLength(0);
		h.close();
	});

	test("(f) a claim at a new HEAD starts the count again", async () => {
		const host = slowOps();
		const asked = fakeApprovals("approved");
		const h = laneHarness(home.dir, { hostOps: host.ops, approvals: asked.approvals });
		const lane = await startLane(h, [CHECK_SLOW]);
		const first = commitIn(lane.cwd, "a.txt");
		await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "a 추가" });
		expect(h.store.getLane(lane.name)?.meta.checks?.inconclusive).toMatchObject({ head: first, runs: 1 });

		const second = commitIn(lane.cwd, "b.txt");
		h.advance(1_000);
		const text = await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "b 추가" });
		expect(text).toContain("확인 불가");
		expect(h.store.getLane(lane.name)?.status).toBe("done-claimed");
		expect(h.store.getLane(lane.name)?.meta.checks?.inconclusive).toEqual({
			head: second,
			runs: 1,
			lastAt: expect.any(Number),
		});
		expect(asked.asked).toHaveLength(0);
		expect(host.slowRuns()).toBe(2);
		h.close();
	});
});

const SHA = "c".repeat(40);
const OVERLAP_REPLY = "검증이 돌고 있어 끝나는 대로 새 클레임을 바로 판정합니다.";

/** Rejects when `promise` has not settled within `ms` (a bound on the wait, never a fixed delay). */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	const limit = Promise.withResolvers<never>();
	// Fires only on failure: the bound of the wait, the test never waits for it.
	const timer = setTimeout(() => limit.reject(new Error(`${what} did not happen within ${ms} ms`)), ms);
	return Promise.race([promise, limit.promise]).finally(() => clearTimeout(timer));
}

/** Lets every queued promise continuation run (one event-loop turn, no clock involved). */
async function drain(): Promise<void> {
	const turn = Promise.withResolvers<void>();
	setImmediate(turn.resolve);
	await turn.promise;
}

interface HeldCheck {
	worktree: string;
	signal: AbortSignal | undefined;
	/** Lets the check finish with exit 0. */
	pass(): void;
}

interface HeldOps {
	ops: TaskHostOps;
	runs: HeldCheck[];
	mode: { failNext: number; autoPass: boolean };
	started(index: number): Promise<HeldCheck>;
	maxInFlight(): number;
}

/**
 * Host ops whose `runCheck` is held until the test passes it (an abort ends it as a kill would, exit null), and whose
 * HEAD is `SHA`, clean, for every worktree. `started(i)` resolves when the i-th check began; `maxInFlight()` is the
 * most checks that ran at once. `failNext` makes that many next checks throw (host unreachable); `autoPass` passes
 * them at once.
 */
function heldOps(): HeldOps {
	const real = createTaskHostOps();
	const runs: HeldCheck[] = [];
	const arrivals: PromiseWithResolvers<HeldCheck>[] = [];
	const arrival = (index: number) => {
		arrivals[index] ??= Promise.withResolvers<HeldCheck>();
		return arrivals[index];
	};
	const mode = { failNext: 0, autoPass: false };
	let inFlight = 0;
	let maxInFlight = 0;
	const ops: TaskHostOps = {
		...real,
		headOf: async () => ({ sha: SHA, clean: true }),
		async runCheck(input) {
			if (mode.failNext > 0) {
				mode.failNext -= 1;
				throw new Error("cannot run check: host unreachable");
			}
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			const done = Promise.withResolvers<CheckRun>();
			const run: HeldCheck = {
				worktree: input.worktree,
				signal: input.signal,
				pass: () => done.resolve({ code: 0, output: "", timedOut: false }),
			};
			input.signal?.addEventListener("abort", () => done.resolve({ code: null, output: "", timedOut: false }));
			runs.push(run);
			arrival(runs.length - 1).resolve(run);
			if (mode.autoPass) run.pass();
			try {
				return await done.promise;
			} finally {
				inFlight -= 1;
			}
		},
	};
	return { ops, runs, mode, started: (index: number) => arrival(index).promise, maxInFlight: () => maxInFlight };
}

/** A harness whose git verdict is `SHA` without git; `refuse` claims read unfinished (`integrity`), others pass. */
function offTickHarness(held: HeldOps, extra: LaneHarnessExtra = {}) {
	const verified: string[] = [];
	const h = laneHarness(home.dir, {
		hostOps: held.ops,
		verify: async (evidence) => {
			verified.push(evidence.summary);
			return { ok: true, sha: SHA };
		},
		collectDiff: async () => "",
		integrity: ({ summary }) =>
			summary === "refuse" ? [{ category: "unfinished_work_marker", excerpt: "TODO", remedy: "끝내세요" }] : [],
		...extra,
	});
	return { h, verified };
}

/** Puts a claim on the lane as the claim tool records it, without judging it (the tick judges it). */
function pendingClaim(h: LaneHarness, lane: LaneRow, summary = "완료"): void {
	h.store.transitionLane(
		lane.name,
		"done-claimed",
		{ event: "claim", detail: summary },
		{ claim: { repo: lane.cwd, commit: "HEAD", summary, claimedAt: LANE_START } },
	);
}

const rootTsOf = (lane: LaneRow): string => lane.threadRef.slice(lane.threadRef.indexOf(":") + 1);
const rootEdits = (h: LaneHarness, lane: LaneRow): string[] =>
	h.transport.calls.flatMap((call) =>
		call.method === "updateMessage" && call.ts === rootTsOf(lane) ? [call.text] : [],
	);

describe("lane verdicts run off the tick", () => {
	test("(a)(b) a held verdict does not hold the tick: the other lane syncs and lands; the judged lane is not synced", async () => {
		const held = heldOps();
		const { h } = offTickHarness(held);
		const a = await startLane(h, [CHECK_A]);
		const b = await startLane(h, []);
		expect(await h.manager.claimDone(b.originKey, { repo: b.cwd, commit: "HEAD", summary: "완료" })).toContain(
			"검증 통과",
		);
		await h.settle();
		// B lost its card and shows a stale root: the tick's landing step posts the card, its sync redraws the root.
		h.store.patchLane(b.name, undefined, { land: { state: "pending", attempts: 0 }, renderedRoot: "stale" });
		h.store.patchLane(a.name, undefined, { renderedRoot: "stale" });
		pendingClaim(h, a);
		const posts = h.transport.posts().length;
		h.advance(CLAIM_GRACE_MS);

		await within(h.manager.tick(), 3_000, "the tick finishing while lane A is judged");
		await held.started(0);
		expect(rootEdits(h, b)).toContain(`🔍 ${b.title}`);
		expect(h.transport.posts().length).toBe(posts + 1);
		expect(h.store.getLane(b.name)?.meta.land?.cardTs).toBeDefined();
		expect(rootEdits(h, a)).toEqual([]);
		expect(h.store.getLane(a.name)?.status).toBe("done-claimed");

		held.runs[0]?.pass();
		await h.manager.settledInBackground();
		expect(h.store.getLane(a.name)?.status).toBe("closed");
		await h.settle();
		h.close();
	});

	test("(c) one check at a time across lanes: B's check starts only after A's is released", async () => {
		const held = heldOps();
		const { h } = offTickHarness(held);
		const a = await startLane(h, [CHECK_A]);
		const b = await startLane(h, [CHECK_A]);
		pendingClaim(h, a);
		pendingClaim(h, b);
		h.advance(CLAIM_GRACE_MS);
		await h.manager.tick();
		const first = await held.started(0);
		await drain();
		expect(held.runs).toHaveLength(1);

		first.pass();
		const second = await held.started(1);
		expect(second.worktree).not.toBe(first.worktree);
		second.pass();
		await h.manager.settledInBackground();
		expect(held.maxInFlight()).toBe(1);
		expect(h.store.getLane(a.name)?.status).toBe("closed");
		expect(h.store.getLane(b.name)?.status).toBe("closed");
		await h.settle();
		h.close();
	});

	test("(c) the agent's own claim waits for the check slot too", async () => {
		const held = heldOps();
		const { h } = offTickHarness(held);
		const a = await startLane(h, [CHECK_A]);
		const b = await startLane(h, [CHECK_A]);
		pendingClaim(h, a);
		h.advance(CLAIM_GRACE_MS);
		await h.manager.tick();
		const first = await held.started(0);
		expect(first.worktree).toBe(a.meta.worktree ?? "");

		const reply = h.manager.claimDone(b.originKey, { repo: b.cwd, commit: "HEAD", summary: "완료" });
		await drain();
		expect(held.runs).toHaveLength(1);
		first.pass();
		const second = await held.started(1);
		expect(second.worktree).toBe(b.meta.worktree ?? "");
		second.pass();
		expect(await reply).toContain("검증 통과");
		await h.manager.settledInBackground();
		expect(held.maxInFlight()).toBe(1);
		await h.settle();
		h.close();
	});

	test("(d) while A waits for the owner's approval card, B is checked and judged to the end", async () => {
		const held = heldOps();
		const asked = Promise.withResolvers<void>();
		const answer = Promise.withResolvers<"approved" | "denied" | "timeout">();
		const { h } = offTickHarness(held, {
			approvals: {
				request: () => {
					asked.resolve();
					return answer.promise;
				},
			},
		});
		const a = await startLane(h, []);
		const b = await startLane(h, [CHECK_A]);
		pendingClaim(h, a, "refuse");
		pendingClaim(h, b);
		const posts = h.transport.posts().length;
		h.advance(CLAIM_GRACE_MS);
		await h.manager.tick();
		await asked.promise;
		(await held.started(0)).pass();
		// B's Outcome card is the next post: B closed while A's card still waits.
		await h.transport.waitForPosts(() => true, posts + 1, 3_000);
		expect(h.store.getLane(b.name)?.status).toBe("closed");
		expect(h.store.getLane(a.name)?.status).toBe("done-claimed");

		answer.resolve("approved");
		await h.manager.settledInBackground();
		expect(h.store.getLane(a.name)).toMatchObject({
			status: "closed",
			meta: { land: { autoLandHeld: INTEGRITY_APPROVED } },
		});
		await h.settle();
		h.close();
	});

	// doc/plans/qa-c-fixes.md I-2: the owner moved the lane while its integrity card waited; the approval closes nothing.
	test.each(["paused", "working"] as const)(
		"an integrity approval after the owner moved the lane to %s ends without error and leaves it there",
		async (moved) => {
			const held = heldOps();
			const asked = Promise.withResolvers<void>();
			const answer = Promise.withResolvers<"approved" | "denied" | "timeout">();
			const { h } = offTickHarness(held, {
				approvals: {
					request: () => {
						asked.resolve();
						return answer.promise;
					},
				},
			});
			const a = await startLane(h, []);
			pendingClaim(h, a, "refuse");
			h.advance(CLAIM_GRACE_MS);
			await h.manager.tick();
			await asked.promise;
			if (moved === "paused") await h.manager.pause(a.name, "owner-message");
			else h.store.transitionLane(a.name, "working", { event: "owner_reply" }, { claim: undefined });

			answer.resolve("approved");
			await h.manager.settledInBackground();
			expect(h.logs.filter((line) => line.includes("level=error"))).toEqual([]);
			expect(h.store.getLane(a.name)?.status).toBe(moved);
			await h.settle();
			h.close();
		},
	);

	test("(e) a claim during a verdict is answered at once and judged as soon as that verdict ends", async () => {
		const held = heldOps();
		const { h, verified } = offTickHarness(held);
		const a = await startLane(h, [CHECK_A]);
		const first = h.manager.claimDone(a.originKey, { repo: a.cwd, commit: "HEAD", summary: "첫 클레임" });
		const check = await held.started(0);

		h.advance(1_000);
		expect(await h.manager.claimDone(a.originKey, { repo: a.cwd, commit: "HEAD", summary: "새 클레임" })).toBe(
			OVERLAP_REPLY,
		);
		expect(verified).toEqual(["첫 클레임"]);
		check.pass();
		expect(await first).toBe("claim superseded by the owner");
		await h.manager.settledInBackground();
		expect(verified).toEqual(["첫 클레임", "새 클레임"]);
		expect(h.store.getLane(a.name)?.status).toBe("closed");
		await h.settle();
		h.close();
	});

	test("(f) a tick verdict deferred by the host is not judged again before CLAIM_GRACE_MS", async () => {
		const held = heldOps();
		held.mode.failNext = 1;
		held.mode.autoPass = true;
		const { h, verified } = offTickHarness(held);
		const a = await startLane(h, [CHECK_A]);
		pendingClaim(h, a);
		h.advance(CLAIM_GRACE_MS);
		await h.manager.tick();
		await h.manager.settledInBackground();
		expect(verified).toHaveLength(1);
		expect(h.store.getLane(a.name)?.status).toBe("done-claimed");

		h.advance(60_000);
		await h.manager.tick();
		await h.manager.settledInBackground();
		h.advance(CLAIM_GRACE_MS - 60_000 - 1);
		await h.manager.tick();
		await h.manager.settledInBackground();
		expect(verified).toHaveLength(1);

		h.advance(1);
		await h.manager.tick();
		await h.manager.settledInBackground();
		expect(verified).toHaveLength(2);
		expect(h.store.getLane(a.name)?.status).toBe("closed");
		await h.settle();
		h.close();
	});

	test("(g) a background verdict that throws is one lane_tick_failed error, never an unhandled rejection", async () => {
		const held = heldOps();
		const { h } = offTickHarness(held, {
			integrity: () => {
				throw new Error("classifier exploded");
			},
		});
		const a = await startLane(h, []);
		pendingClaim(h, a);
		h.advance(CLAIM_GRACE_MS);
		await h.manager.tick();
		await h.manager.settledInBackground();
		const failures = h.logs.filter((line) => line.includes("lane_tick_failed"));
		expect(failures).toHaveLength(1);
		expect(failures[0]).toContain("classifier exploded");
		expect(h.store.getLane(a.name)?.status).toBe("done-claimed");
		await h.settle();
		h.close();
	});

	test("(h) stop() aborts the running check; its result is not recorded", async () => {
		const held = heldOps();
		const { h } = offTickHarness(held);
		const a = await startLane(h, [CHECK_A]);
		pendingClaim(h, a);
		h.advance(CLAIM_GRACE_MS);
		await h.manager.tick();
		const check = await held.started(0);
		expect(check.signal?.aborted).toBe(false);

		h.manager.stop();
		expect(check.signal?.aborted).toBe(true);
		await h.manager.settledInBackground();
		const lane = h.store.getLane(a.name);
		expect(lane?.meta.checks).toBeUndefined();
		expect(lane?.status).toBe("done-claimed");
		expect(lane?.history.some((entry) => entry.event === "not_done" || entry.event === "checks")).toBe(false);
		await h.settle();
		h.close();
	});
});

describe("integrity diff of a rebased lane (qa50b H-5)", () => {
	test("a lane rebased onto a base that gained a skipped test is not refused for the base's commit", async () => {
		const h = laneHarness(home.dir, { hostOps: recordingOps().ops });
		const lane = await startLane(h, []);
		const repo = lane.meta.repo as string;
		const baseBranch = lane.meta.baseBranch as string;
		commitIn(lane.cwd, "feature.ts");
		writeFileSync(join(repo, "basework.test.ts"), "test.skip('later', () => {});\n"); // base-side fixture, qa50b #116
		git(repo, "add", "basework.test.ts");
		git(repo, "commit", "-q", "-m", "base moved");
		git(lane.cwd, "rebase", "-q", baseBranch);
		const text = await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "feature 추가" });
		expect(text).toContain("검증 통과");
		expect(h.store.getLane(lane.name)?.status).toBe("closed");
		await h.settle();
		h.close();
	});

	test("a base branch that cannot be read refuses the claim with the reason instead of passing it", async () => {
		const h = laneHarness(home.dir, { hostOps: recordingOps().ops });
		const lane = await startLane(h, []);
		const repo = lane.meta.repo as string;
		commitIn(lane.cwd, "feature.ts");
		git(repo, "branch", "-m", lane.meta.baseBranch as string, "renamed-away");
		const text = await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "feature 추가" });
		expect(text).toContain("[not-done]");
		expect(text).toContain("lane_diff_unavailable");
		expect(h.store.getLane(lane.name)?.status).toBe("not-done");
		await h.settle();
		h.close();
	});
});
