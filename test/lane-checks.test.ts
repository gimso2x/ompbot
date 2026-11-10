import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAIM_GRACE_MS } from "../src/lanes/manager";
import type { LaneRow } from "../src/lanes/status";
import { createTaskHostOps, type TaskHostOps } from "../src/tasks/host";
import { makeHome, type TestHome } from "./helpers/bot-home";
import { git, makeRepo } from "./helpers/git-fixtures";
import { type LaneHarness, laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

const CHECK_A = 'a.txt가 있다 [check: command ["sh","-c","test -f a.txt"]]';
const CHECK_B = 'b.txt가 있다 [check: command ["sh","-c","test -f b.txt"]]';

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
		expect(h.store.getLane(lane.name)?.status).toBe("done-claimed");

		h.advance(1);
		await h.manager.tick();
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
		expect(h.store.getLane(lane.name)?.status).toBe("closed");
		expect(rec.calls).toHaveLength(1);
		await h.settle();
		h.close();
	});
});
