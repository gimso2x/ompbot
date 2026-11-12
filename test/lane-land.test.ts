import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseThreadRef } from "../src/core/normalize";
import { Daemon } from "../src/daemon/daemon";
import { buildLaneOutcomeCard } from "../src/lanes/card";
import type { IntegrityRefusal } from "../src/lanes/integrity";
import { createLaneLander, type LandLane, type LandRequest, laneLandBlockers } from "../src/lanes/land";
import { CLAIM_GRACE_MS } from "../src/lanes/manager";
import { INCONCLUSIVE_APPROVED, type LaneChanges, type LaneRow } from "../src/lanes/status";
import { classifyClosedLaneMessage } from "../src/lanes/trigger";
import { defaultGit, type GitResult, type GitRunner } from "../src/lanes/verify";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import { SlackCallError } from "../src/slack/transport";
import type { Store } from "../src/store/db";
import { createTaskHostOps, type TaskHostOps } from "../src/tasks/host";
import { makeHome, OWNER, type TestHome, WaitingTransport } from "./helpers/bot-home";
import { git, makeRepo } from "./helpers/git-fixtures";
import { type LaneHarness, laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";
import type { FakeCall } from "./helpers/slack-fake-transport";

// Lane landing (doc/plans/lane-task-parity.md C절): every git effect below is a real git repository in a temp
// directory with a local bare repository as `origin`; nothing leaves this machine.

const CHECK_A = 'a.txt가 있다 [check: command ["sh","-c","test -f a.txt"]]';
const NO_CHECK = "README를 다듬는다";

type Post = Extract<FakeCall, { method: "postMessage" }>;

let home: TestHome;
let repos: string[];
let scratch: string[];
let daemons: Daemon[];

beforeEach(() => {
	home = makeHome("ompbot-lane-land-home-");
	repos = [];
	scratch = [];
	daemons = [];
});

afterEach(async () => {
	for (const daemon of daemons) await daemon.stop();
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	scratch.push(dir);
	return dir;
}

const baseOf = (repo: string): string => git(repo, "symbolic-ref", "--short", "HEAD");
const headOf = (repo: string, ref = "HEAD"): string => git(repo, "rev-parse", ref);

/** A local bare repository added to `repo` as `origin`, holding its current branch. */
function addOrigin(repo: string): string {
	const bare = tempDir("ompbot-lane-land-bare-");
	git(bare, "init", "-q", "--bare");
	git(repo, "remote", "add", "origin", bare);
	git(repo, "push", "-q", "origin", baseOf(repo));
	return bare;
}

function repoWithOrigin(): { repo: string; bare: string; base: string } {
	const repo = makeRepo(repos);
	return { repo, bare: addOrigin(repo), base: baseOf(repo) };
}

/** Commits `files` in `dir` (a lane worktree or the repository itself); returns the new HEAD. */
function commitIn(dir: string, ...files: string[]): string {
	for (const file of files) writeFileSync(join(dir, file), `${file}\n`);
	git(dir, "add", "--", ...files);
	git(dir, "commit", "-q", "-m", `add ${files.join(" ")}`);
	return headOf(dir);
}

/** The real landing over `git`; every worktree removal is appended to `removals` (the last step of a landing). */
function realLander(git: GitRunner = defaultGit, removals: string[][] = []): LandLane {
	return createLaneLander({
		git,
		pushGit: git,
		removeWorktree: (input) => {
			removals.push(["removeWorktree", input.branch]);
			return createTaskHostOps().removeWorktree(input);
		},
	});
}

/** The real landing with every call counted. */
function countingLand(git?: GitRunner): { land: LandLane; calls: LandRequest[] } {
	const real = realLander(git);
	const calls: LandRequest[] = [];
	return {
		calls,
		land: (request, hooks) => {
			calls.push(request);
			return real(request, hooks);
		},
	};
}

/** `defaultGit` with every argv recorded; `intercept` may replace one call (to fail after it ran). */
function recordingGit(intercept?: (args: string[], run: () => Promise<GitResult>) => Promise<GitResult>) {
	const calls: string[][] = [];
	const run: GitRunner = (args) => {
		calls.push(args);
		return intercept === undefined ? defaultGit(args) : intercept(args, () => defaultGit(args));
	};
	const count = (...words: string[]) => calls.filter((args) => words.every((word) => args.includes(word))).length;
	return { git: run, calls, count };
}

/** The real host ops with every `runCheck` counted. */
function countingOps(): { ops: TaskHostOps; checks: () => number } {
	const real = createTaskHostOps();
	let checks = 0;
	return {
		checks: () => checks,
		ops: {
			...real,
			runCheck(input) {
				checks += 1;
				return real.runCheck(input);
			},
		},
	};
}

async function closeLane(
	h: LaneHarness,
	repo: string,
	over: { title?: string; acceptance?: string[]; risk?: string; file?: string } = {},
): Promise<{ lane: LaneRow; sha: string }> {
	const started = await h.manager.start({
		title: over.title ?? "land",
		cwd: repo,
		channel: "D1",
		acceptance: over.acceptance ?? [CHECK_A],
		risk: over.risk ?? "L2",
	});
	await h.settle();
	const sha = commitIn(started.cwd, over.file ?? "a.txt");
	expect(
		await h.manager.claimDone(started.originKey, { repo: started.cwd, commit: "HEAD", summary: "a.txt 추가" }),
	).toContain("검증 통과");
	await h.settle();
	return { lane: requireLane(h, started.name), sha };
}

function requireLane(h: LaneHarness, name: string): LaneRow {
	const lane = h.store.getLane(name);
	if (lane === undefined) throw new Error(`no lane ${name}`);
	return lane;
}

const rootTsOf = (lane: LaneRow): string => parseThreadRef(lane.threadRef)?.threadTs ?? "";

/** Everything posted into the lane's thread except its `⏳` status message: the Outcome cards. */
const cardPosts = (transport: WaitingTransport, lane: LaneRow): Post[] =>
	transport.posts().filter((post) => post.threadTs === rootTsOf(lane) && post.ts !== lane.meta.statusTs);

/** What a posted message shows now: its last edit, or the post itself. */
function shownNow(transport: WaitingTransport, ts: string): { text: string; blocks: string } {
	const edit = transport.calls.findLast((call) => call.method === "updateMessage" && call.ts === ts);
	const post = transport.posts().find((call) => call.ts === ts);
	const shown = edit?.method === "updateMessage" ? edit : post;
	return { text: shown?.text ?? "", blocks: JSON.stringify(shown?.blocks ?? []) };
}

/** Resolves once `name`'s Outcome card ts is written to the lane (subscribed before the close that posts it). */
function cardRecorded(store: Store, name: string, timeoutMs = 10_000): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const original = store.patchLane.bind(store);
	const restore = () => {
		clearTimeout(timer);
		store.patchLane = original;
	};
	const timer = setTimeout(() => {
		restore();
		reject(new Error(`lane ${name}: no card recorded`));
	}, timeoutMs);
	store.patchLane = (...args) => {
		const row = original(...args);
		if (row.name === name && row.meta.land?.cardTs !== undefined) {
			restore();
			resolve();
		}
		return row;
	};
	return promise;
}

const mergeId = (lane: LaneRow): string => `ompbot:lane:merge:${lane.name}`;
const discardId = (lane: LaneRow): string => `ompbot:lane:discard:${lane.name}`;
const rootUpdates = (transport: WaitingTransport, lane: LaneRow): string[] =>
	transport.calls.flatMap((call) => (call.method === "updateMessage" && call.ts === rootTsOf(lane) ? [call.text] : []));

describe("landLane: ff merge, push, cleanup (AC-1)", () => {
	test("a closed ff-able lane: the checked-out base branch moves by `merge --ff-only`, preSha is recorded, the worktree and lane branch are gone, state landed", async () => {
		const { repo, bare, base } = repoWithOrigin();
		const before = headOf(repo);
		const rec = recordingGit();
		const h = laneHarness(home.dir, { land: realLander(rec.git) });
		const { lane, sha } = await closeLane(h, repo);
		expect(lane.meta.land).toMatchObject({ state: "pending", attempts: 0 });
		expect(rootUpdates(h.transport, lane).at(-1)).toBe("🔍 land");
		expect(existsSync(lane.meta.worktree ?? "")).toBe(true);

		const outcome = await h.manager.requestLand(lane.name, "owner");
		await h.settle();
		expect(outcome.handled).toBe(true);
		const landed = requireLane(h, lane.name);
		expect(landed.status).toBe("closed");
		expect(landed.meta.land).toMatchObject({ state: "landed", preSha: before, pushed: `origin/${base}` });
		expect(rec.count("merge", "--ff-only", sha)).toBe(1);
		expect(rec.count("update-ref")).toBe(0);
		// The live checkout followed the merge: HEAD is the claim and the file is in the working tree.
		expect(headOf(repo)).toBe(sha);
		expect(baseOf(repo)).toBe(base);
		expect(existsSync(join(repo, "a.txt"))).toBe(true);
		expect(git(repo, "status", "--porcelain")).toBe("");
		expect(headOf(bare, `refs/heads/${base}`)).toBe(sha);
		expect(existsSync(lane.meta.worktree ?? "")).toBe(false);
		expect(git(repo, "branch", "--list", lane.meta.branch ?? "")).toBe("");
		expect(rootUpdates(h.transport, lane).at(-1)).toBe("✅ land");
		h.close();
	});
});

describe("landLane: the live checkout is left alone or refuses (AC-2)", () => {
	test("another branch is checked out: only the base ref moves by `update-ref`; HEAD, index and working tree are untouched", async () => {
		const { repo, bare, base } = repoWithOrigin();
		const before = headOf(repo);
		const rec = recordingGit();
		const h = laneHarness(home.dir, { land: realLander(rec.git) });
		const { lane, sha } = await closeLane(h, repo);
		git(repo, "checkout", "-q", "-b", "other");
		writeFileSync(join(repo, "wip.txt"), "wip\n");
		const statusBefore = git(repo, "status", "--porcelain");

		await h.manager.requestLand(lane.name, "owner");
		await h.settle();
		expect(requireLane(h, lane.name).meta.land).toMatchObject({ state: "landed", preSha: before });
		expect(headOf(repo, `refs/heads/${base}`)).toBe(sha);
		expect(baseOf(repo)).toBe("other");
		expect(headOf(repo)).toBe(before);
		expect(git(repo, "status", "--porcelain")).toBe(statusBefore);
		expect(existsSync(join(repo, "a.txt"))).toBe(false);
		expect(rec.count("update-ref", `refs/heads/${base}`, sha, before)).toBe(1);
		expect(rec.count("merge", "--ff-only")).toBe(0);
		expect(headOf(bare, `refs/heads/${base}`)).toBe(sha);
		h.close();
	});

	test("the checked-out base branch is dirty: nothing changes, state blocked with the reason, the card keeps its buttons", async () => {
		const { repo, bare, base } = repoWithOrigin();
		const before = headOf(repo);
		const h = laneHarness(home.dir);
		const { lane } = await closeLane(h, repo);
		writeFileSync(join(repo, "README.md"), "edited by somebody\n");

		await h.manager.requestLand(lane.name, "owner");
		await h.settle();
		const blocked = requireLane(h, lane.name);
		expect(blocked.meta.land?.state).toBe("blocked");
		expect(blocked.meta.land?.reason).toContain("README.md");
		expect(headOf(repo, `refs/heads/${base}`)).toBe(before);
		expect(headOf(bare, `refs/heads/${base}`)).toBe(before);
		expect(git(repo, "status", "--porcelain")).toContain("README.md");
		expect(existsSync(lane.meta.worktree ?? "")).toBe(true);
		expect(git(repo, "branch", "--list", lane.meta.branch ?? "")).not.toBe("");
		const card = shownNow(h.transport, blocked.meta.land?.cardTs ?? "");
		expect(card.text).toContain("README.md");
		expect(card.blocks).toContain(mergeId(lane));
		expect(card.blocks).toContain(discardId(lane));

		// The owner cleans the checkout and asks again: a blocked lane lands.
		git(repo, "checkout", "-q", "--", "README.md");
		await h.manager.requestLand(lane.name, "owner");
		await h.settle();
		expect(requireLane(h, lane.name).meta.land?.state).toBe("landed");
		h.close();
	});
});

describe("landLane: the base branch moved ahead (AC-3)", () => {
	test("not ff-able: base and remote unchanged, closed → working with a rebase steer; the re-claim runs the checks again; the second refusal is blocked", async () => {
		const { repo, bare, base } = repoWithOrigin();
		const ops = countingOps();
		const h = laneHarness(home.dir, { hostOps: ops.ops });
		const { lane } = await closeLane(h, repo);
		expect(ops.checks()).toBe(1);
		const ahead = commitIn(repo, "elsewhere.txt");
		const remoteBefore = headOf(bare, `refs/heads/${base}`);

		await h.manager.requestLand(lane.name, "owner");
		await h.settle();
		const working = requireLane(h, lane.name);
		expect(working.status).toBe("working");
		expect(working.meta.land).toMatchObject({ attempts: 1 });
		expect(headOf(repo, `refs/heads/${base}`)).toBe(ahead);
		expect(headOf(bare, `refs/heads/${base}`)).toBe(remoteBefore);
		expect(existsSync(lane.meta.worktree ?? "")).toBe(true);
		const steers = h.steers(lane.originKey);
		expect(steers).toHaveLength(1);
		expect(steers[0]).toContain("rebase");
		expect(steers[0]).toContain(base);
		expect(steers[0]).toContain("ompbot_claim_done");
		expect(rootUpdates(h.transport, lane).at(-1)).toBe("🔄 land");

		// The lane rebases and claims again: the claim goes through the checks once more.
		git(lane.cwd, "rebase", "-q", base);
		expect(
			await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "rebase 후 a.txt" }),
		).toContain("검증 통과");
		await h.settle();
		expect(ops.checks()).toBe(2);
		const reclaimed = requireLane(h, lane.name);
		expect(reclaimed.status).toBe("closed");
		expect(reclaimed.meta.land).toMatchObject({ state: "pending", attempts: 1 });

		// The base moved again before this landing: the second refusal goes to the owner instead of the lane.
		const aheadAgain = commitIn(repo, "elsewhere-2.txt");
		await h.manager.requestLand(lane.name, "owner");
		await h.settle();
		const blocked = requireLane(h, lane.name);
		expect(blocked.status).toBe("closed");
		expect(blocked.meta.land).toMatchObject({ state: "blocked", attempts: 2 });
		expect(headOf(repo, `refs/heads/${base}`)).toBe(aheadAgain);
		expect(headOf(bare, `refs/heads/${base}`)).toBe(remoteBefore);
		expect(h.steers(lane.originKey)).toHaveLength(1);
		h.close();
	});

	test("frozen: the owner's not-ff landing sends the lane back to work but holds the rebase steer (qa50b M-2)", async () => {
		const { repo } = repoWithOrigin();
		let frozen = false;
		const h = laneHarness(home.dir, {
			frozen: () => (frozen ? { since: "2027-01-15T00:00:00.000Z", reason: "", by: "test" } : undefined),
		});
		const { lane } = await closeLane(h, repo);
		commitIn(repo, "elsewhere.txt");
		frozen = true;
		const outcome = await h.manager.requestLand(lane.name, "owner");
		await h.settle();
		expect(requireLane(h, lane.name).status).toBe("working");
		expect(h.steers(lane.originKey)).toHaveLength(0);
		expect(h.logs.some((line) => line.includes("event=lane_send_held_frozen"))).toBe(true);
		expect(outcome.text).toContain("동결");
		h.close();
	});

	test("after one rebase the lane lands", async () => {
		const { repo, bare, base } = repoWithOrigin();
		const h = laneHarness(home.dir);
		const { lane } = await closeLane(h, repo);
		commitIn(repo, "elsewhere.txt");
		await h.manager.requestLand(lane.name, "owner");
		await h.settle();
		git(lane.cwd, "rebase", "-q", base);
		const rebased = headOf(lane.cwd);
		await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "rebase 후 a.txt" });
		await h.settle();
		await h.manager.requestLand(lane.name, "owner");
		await h.settle();
		expect(requireLane(h, lane.name).meta.land?.state).toBe("landed");
		expect(headOf(repo)).toBe(rebased);
		expect(headOf(bare, `refs/heads/${base}`)).toBe(rebased);
		h.close();
	});
});

describe("landLane: push policy, refusal, serial landings, resume (AC-4)", () => {
	test("an auto-merge in taskAutoLand.repos pushes; the same lane outside repos is not merged and not pushed", async () => {
		const inside = repoWithOrigin();
		const outside = repoWithOrigin();
		const counted = countingLand();
		const h = laneHarness(home.dir, {
			land: counted.land,
			autoLandPolicy: () => ({ repos: [inside.repo], maxRisk: "L2" }),
		});
		const a = await closeLane(h, inside.repo, { title: "inside" });
		expect(requireLane(h, a.lane.name).meta.land?.state).toBe("landed");
		expect(headOf(inside.bare, `refs/heads/${inside.base}`)).toBe(a.sha);
		expect(counted.calls).toHaveLength(1);
		expect(counted.calls[0]?.push).toBe(true);

		const before = headOf(outside.bare, `refs/heads/${outside.base}`);
		const b = await closeLane(h, outside.repo, { title: "outside" });
		expect(requireLane(h, b.lane.name).meta.land?.state).toBe("pending");
		expect(counted.calls).toHaveLength(1);
		expect(headOf(outside.repo, `refs/heads/${outside.base}`)).toBe(before);
		expect(headOf(outside.bare, `refs/heads/${outside.base}`)).toBe(before);
		h.close();
	});

	test("an owner-requested landing outside repos pushes once and the card names origin/<baseBranch>", async () => {
		const elsewhere = makeRepo(repos);
		const { repo, bare, base } = repoWithOrigin();
		const rec = recordingGit();
		const h = laneHarness(home.dir, {
			land: realLander(rec.git),
			autoLandPolicy: () => ({ repos: [elsewhere], maxRisk: "L2" }),
		});
		const { lane, sha } = await closeLane(h, repo);
		expect(requireLane(h, lane.name).meta.land?.state).toBe("pending");
		expect(rec.count("push")).toBe(0);

		await h.manager.requestLand(lane.name, "owner");
		await h.settle();
		const landed = requireLane(h, lane.name);
		expect(landed.meta.land).toMatchObject({ state: "landed", pushed: `origin/${base}` });
		expect(rec.count("push")).toBe(1);
		expect(headOf(bare, `refs/heads/${base}`)).toBe(sha);
		expect(shownNow(h.transport, landed.meta.land?.cardTs ?? "").text).toContain(`origin/${base}`);
		h.close();
	});

	test("a refused push: merged locally, state merged-not-pushed with the reason, the remote unchanged", async () => {
		const { repo, bare, base } = repoWithOrigin();
		const h = laneHarness(home.dir);
		const { lane, sha } = await closeLane(h, repo);
		// Somebody else pushed to origin meanwhile: this push is not a fast-forward there.
		const other = tempDir("ompbot-lane-land-clone-");
		git(other, "clone", "-q", bare, ".");
		const theirs = commitIn(other, "theirs.txt");
		git(other, "push", "-q", "origin", `HEAD:refs/heads/${base}`);

		await h.manager.requestLand(lane.name, "owner");
		await h.settle();
		const after = requireLane(h, lane.name);
		expect(after.meta.land?.state).toBe("merged-not-pushed");
		expect(after.meta.land?.reason).toBeTruthy();
		expect(headOf(repo)).toBe(sha);
		expect(headOf(bare, `refs/heads/${base}`)).toBe(theirs);
		const cards = cardPosts(h.transport, lane);
		const last = shownNow(h.transport, cards.at(-1)?.ts ?? "");
		expect(last.text).toContain("push");
		expect(last.blocks).not.toContain(mergeId(lane));
		h.close();
	});

	test("commits made on the lane branch after the claim: nothing is merged or removed, state blocked", async () => {
		const { repo, bare, base } = repoWithOrigin();
		const before = headOf(repo);
		const h = laneHarness(home.dir);
		const { lane, sha } = await closeLane(h, repo);
		const worktree = lane.meta.worktree ?? "";
		const late = commitIn(worktree, "late.txt");

		await h.manager.requestLand(lane.name, "owner");
		await h.settle();
		const after = requireLane(h, lane.name);
		expect(after.meta.land?.state).toBe("blocked");
		expect(after.meta.land?.reason).toContain(sha.slice(0, 12));
		expect(after.meta.land?.reason).toContain(`${base}는 바뀌지 않았습니다`);
		expect(headOf(repo)).toBe(before);
		expect(headOf(bare, `refs/heads/${base}`)).toBe(before);
		// The later commit is still there: the cleanup never ran.
		expect(headOf(worktree)).toBe(late);
		expect(headOf(repo, `refs/heads/${lane.meta.branch}`)).toBe(late);
		h.close();
	});

	test("an auto-merge whose push is refused tells it on a new card; the first card points to it", async () => {
		const { repo, bare, base } = repoWithOrigin();
		const other = tempDir("ompbot-lane-land-clone-");
		git(other, "clone", "-q", bare, ".");
		const theirs = commitIn(other, "theirs.txt");
		git(other, "push", "-q", "origin", `HEAD:refs/heads/${base}`);
		const h = laneHarness(home.dir, {
			autoLandPolicy: () => ({ repos: [repo], maxRisk: "L2" }),
			ownerUserId: "U_OWNER",
		});
		const { lane, sha } = await closeLane(h, repo);

		const after = requireLane(h, lane.name);
		expect(after.meta.land?.state).toBe("merged-not-pushed");
		expect(headOf(repo)).toBe(sha);
		expect(headOf(bare, `refs/heads/${base}`)).toBe(theirs);
		const cards = cardPosts(h.transport, lane);
		expect(cards).toHaveLength(2);
		expect(after.meta.land?.cardTs).toBe(cards[1]?.ts);
		expect(cards[1]?.text).toContain("push");
		expect(cards[1]?.text).toContain("<@U_OWNER>");
		expect(shownNow(h.transport, cards[0]?.ts ?? "").text).toContain("새 카드");
		expect(rootUpdates(h.transport, lane).at(-1)).toStartWith("⚠️");
		h.close();
	});

	test("a landing that keeps throwing is retried by the tick and blocked at the third throw", async () => {
		const { repo } = repoWithOrigin();
		let calls = 0;
		const land: LandLane = () => {
			calls += 1;
			return Promise.reject(new Error("git host unavailable"));
		};
		const h = laneHarness(home.dir, { land });
		const { lane } = await closeLane(h, repo);

		expect((await h.manager.requestLand(lane.name, "owner")).handled).toBe(true);
		expect(requireLane(h, lane.name).meta.land).toMatchObject({ state: "pending", requestedBy: "owner", errors: 1 });
		await h.manager.tick();
		await h.settle();
		expect(requireLane(h, lane.name).meta.land).toMatchObject({ state: "pending", errors: 2 });
		await h.manager.tick();
		await h.settle();
		const after = requireLane(h, lane.name);
		expect(calls).toBe(3);
		expect(after.meta.land?.state).toBe("blocked");
		expect(after.meta.land?.reason).toContain("3번");
		expect(after.meta.land?.requestedBy).toBeUndefined();
		// Blocked is the owner's call again: the tick leaves it alone.
		await h.manager.tick();
		await h.settle();
		expect(calls).toBe(3);
		expect(existsSync(lane.meta.worktree ?? "")).toBe(true);
		h.close();
	});

	test("a tick that listed the lane before it was landed does not land it again", async () => {
		const { repo } = repoWithOrigin();
		const counted = countingLand();
		let busy = true;
		const h = laneHarness(home.dir, {
			land: counted.land,
			autoLandPolicy: () => ({ repos: [repo], maxRisk: "L2" }),
			laneBusy: () => busy,
		});
		const { lane } = await closeLane(h, repo);
		// What a slow tick still holds: the lane as it waited for its turn to end.
		const stale = h.store.listLanes();
		expect(stale.find((row) => row.name === lane.name)?.meta.land).toMatchObject({
			state: "pending",
			requestedBy: "auto",
		});
		busy = false;
		await h.manager.tick();
		await h.settle();
		expect(counted.calls).toHaveLength(1);
		const posts = cardPosts(h.transport, lane).length;

		h.store.listLanes = () => stale;
		await h.manager.tick();
		await h.settle();
		expect(counted.calls).toHaveLength(1);
		expect(cardPosts(h.transport, lane)).toHaveLength(posts);
		expect(requireLane(h, lane.name).meta.land?.state).toBe("landed");
		h.close();
	});

	test("two landings on one repository run one after the other", async () => {
		const { repo, base } = repoWithOrigin();
		const rec = recordingGit();
		const h = laneHarness(home.dir, { land: realLander(rec.git, rec.calls) });
		const a = await closeLane(h, repo, { title: "first", file: "a.txt" });
		const b = await closeLane(h, repo, { title: "second", acceptance: [NO_CHECK], file: "b.txt" });

		await Promise.all([h.manager.requestLand(a.lane.name, "owner"), h.manager.requestLand(b.lane.name, "owner")]);
		await h.settle();
		const mentions = (word: string) => rec.calls.flatMap((args, index) => (args.includes(word) ? [index] : []));
		const [first, second] = [mentions(a.sha), mentions(b.sha)];
		expect(first.length).toBeGreaterThan(1);
		expect(second.length).toBeGreaterThan(0);
		// The first landing was over (its worktree removal is its last step) before the second made its first call.
		const cleanup = rec.calls.findIndex((args) => args[0] === "removeWorktree" && args[1] === a.lane.meta.branch);
		expect(cleanup).toBeGreaterThan(Math.max(...first));
		expect(cleanup).toBeLessThan(Math.min(...second));
		expect(requireLane(h, a.lane.name).meta.land?.state).toBe("landed");
		// The second lane started from the same commit: after the first landed it is no longer ff-able.
		expect(requireLane(h, b.lane.name).status).toBe("working");
		expect(headOf(repo, `refs/heads/${base}`)).toBe(a.sha);
		h.close();
	});

	test("cut off right after the merge: the next tick finishes without merging or pushing twice (preSha unknown)", async () => {
		const { repo, bare, base } = repoWithOrigin();
		let fail = true;
		const rec = recordingGit(async (args, run) => {
			const result = await run();
			if (fail && args.includes("merge") && args.includes("--ff-only")) {
				fail = false;
				throw new Error("killed after the merge");
			}
			return result;
		});
		const h = laneHarness(home.dir, { land: realLander(rec.git) });
		const { lane, sha } = await closeLane(h, repo);

		await h.manager.requestLand(lane.name, "owner");
		await h.settle();
		expect(requireLane(h, lane.name).meta.land).toMatchObject({ state: "pending", requestedBy: "owner" });
		expect(headOf(repo)).toBe(sha);
		expect(rec.count("push")).toBe(0);

		await h.manager.tick();
		await h.settle();
		expect(requireLane(h, lane.name).meta.land).toMatchObject({ state: "landed", preSha: "unknown" });
		expect(rec.count("merge", "--ff-only")).toBe(1);
		expect(rec.count("push")).toBe(1);
		expect(headOf(bare, `refs/heads/${base}`)).toBe(sha);
		expect(existsSync(lane.meta.worktree ?? "")).toBe(false);
		const card = shownNow(h.transport, requireLane(h, lane.name).meta.land?.cardTs ?? "");
		expect(card.text).toContain("reflog");
		h.close();
	});

	test("cut off right after the push: the next tick finishes without a second merge or push", async () => {
		const { repo, bare, base } = repoWithOrigin();
		const before = headOf(repo);
		let fail = true;
		const rec = recordingGit(async (args, run) => {
			const result = await run();
			if (fail && args.includes("push")) {
				fail = false;
				throw new Error("killed after the push");
			}
			return result;
		});
		const h = laneHarness(home.dir, { land: realLander(rec.git) });
		const { lane, sha } = await closeLane(h, repo);

		await h.manager.requestLand(lane.name, "owner");
		await h.settle();
		expect(requireLane(h, lane.name).meta.land?.state).toBe("pending");
		expect(headOf(bare, `refs/heads/${base}`)).toBe(sha);

		await h.manager.tick();
		await h.settle();
		expect(requireLane(h, lane.name).meta.land).toMatchObject({ state: "landed", preSha: before });
		expect(rec.count("merge", "--ff-only")).toBe(1);
		expect(rec.count("push")).toBe(1);
		expect(existsSync(lane.meta.worktree ?? "")).toBe(false);
		h.close();
	});
});

describe("landLane: the lane worktree is checked before the merge and the cleanup is reported (qa-fixes 1·2)", () => {
	/** A lander over real git whose worktree removal is `remove` (a fake that may leave things behind). */
	const landerWith = (remove: (input: { repo: string; worktree: string; branch: string }) => Promise<void>) =>
		createLaneLander({ git: defaultGit, pushGit: defaultGit, removeWorktree: remove });

	test("(a) uncommitted changes in the lane worktree after the claim: blocked naming both files; base, origin and worktree untouched", async () => {
		const { repo, bare, base } = repoWithOrigin();
		const before = headOf(repo);
		const h = laneHarness(home.dir);
		const { lane, sha } = await closeLane(h, repo);
		const worktree = lane.meta.worktree ?? "";
		writeFileSync(join(worktree, "README.md"), "edited after the claim\n");
		writeFileSync(join(worktree, "late-wip.txt"), "wip\n");

		const outcome = await h.manager.requestLand(lane.name, "owner");
		await h.settle();
		const after = requireLane(h, lane.name);
		expect(after.meta.land?.state).toBe("blocked");
		expect(after.meta.land?.reason).toContain("README.md");
		expect(after.meta.land?.reason).toContain("late-wip.txt");
		expect(after.meta.land?.reason).toContain(`${base}는 바뀌지 않았습니다`);
		expect(outcome.text).toContain("late-wip.txt");
		expect(headOf(repo, `refs/heads/${base}`)).toBe(before);
		expect(headOf(bare, `refs/heads/${base}`)).toBe(before);
		expect(headOf(worktree)).toBe(sha);
		const status = git(worktree, "status", "--porcelain");
		expect(status).toContain("README.md");
		expect(status).toContain("late-wip.txt");
		expect(git(repo, "branch", "--list", lane.meta.branch ?? "")).not.toBe("");
		h.close();
	});

	test("(b) a commit on a detached HEAD in the lane worktree: blocked; base unchanged; the worktree and the commit stay", async () => {
		const { repo, bare, base } = repoWithOrigin();
		const before = headOf(repo);
		const h = laneHarness(home.dir);
		const { lane, sha } = await closeLane(h, repo);
		const worktree = lane.meta.worktree ?? "";
		git(worktree, "checkout", "-q", "--detach");
		const late = commitIn(worktree, "late.txt");
		// The branch tip is still the claim: only the worktree's HEAD tells.
		expect(headOf(repo, `refs/heads/${lane.meta.branch}`)).toBe(sha);

		await h.manager.requestLand(lane.name, "owner");
		await h.settle();
		const after = requireLane(h, lane.name);
		expect(after.meta.land?.state).toBe("blocked");
		expect(after.meta.land?.reason).toContain(late.slice(0, 12));
		expect(after.meta.land?.reason).toContain(sha.slice(0, 12));
		expect(after.meta.land?.reason).toContain(`${base}는 바뀌지 않았습니다`);
		expect(headOf(repo, `refs/heads/${base}`)).toBe(before);
		expect(headOf(bare, `refs/heads/${base}`)).toBe(before);
		expect(existsSync(worktree)).toBe(true);
		expect(headOf(worktree)).toBe(late);
		h.close();
	});

	test("(c) a clean worktree at the claim lands as before: no cleanup note, the card and the reply say it was cleaned up", async () => {
		const { repo, bare, base } = repoWithOrigin();
		const h = laneHarness(home.dir);
		const { lane, sha } = await closeLane(h, repo);

		const outcome = await h.manager.requestLand(lane.name, "owner");
		await h.settle();
		const after = requireLane(h, lane.name);
		expect(after.meta.land?.state).toBe("landed");
		expect(after.meta.land?.cleanup).toBeUndefined();
		expect(headOf(bare, `refs/heads/${base}`)).toBe(sha);
		expect(existsSync(lane.meta.worktree ?? "")).toBe(false);
		expect(outcome.text).toContain("· worktree 정리");
		expect(outcome.text).not.toContain("⚠️");
		expect(shownNow(h.transport, after.meta.land?.cardTs ?? "").text).toContain("worktree·브랜치 정리");
		h.close();
	});

	test("(d) the worktree path is gone before the merge: the lane still lands and its branch is removed", async () => {
		const { repo, bare, base } = repoWithOrigin();
		const h = laneHarness(home.dir);
		const { lane, sha } = await closeLane(h, repo);
		const worktree = lane.meta.worktree ?? "";
		git(repo, "worktree", "remove", "--force", worktree);

		await h.manager.requestLand(lane.name, "owner");
		await h.settle();
		const after = requireLane(h, lane.name);
		expect(after.meta.land?.state).toBe("landed");
		expect(after.meta.land?.cleanup).toBeUndefined();
		expect(headOf(repo, `refs/heads/${base}`)).toBe(sha);
		expect(headOf(bare, `refs/heads/${base}`)).toBe(sha);
		expect(git(repo, "branch", "--list", lane.meta.branch ?? "")).toBe("");
		h.close();
	});

	test("(e) a removal that leaves the worktree and branch: landed with a ⚠️ cleanup note on the lane, the card and the reply", async () => {
		const { repo, bare, base } = repoWithOrigin();
		const h = laneHarness(home.dir, { land: landerWith(() => Promise.resolve()) });
		const { lane, sha } = await closeLane(h, repo);
		const worktree = lane.meta.worktree ?? "";

		const outcome = await h.manager.requestLand(lane.name, "owner");
		await h.settle();
		const after = requireLane(h, lane.name);
		expect(after.meta.land?.state).toBe("landed");
		expect(headOf(bare, `refs/heads/${base}`)).toBe(sha);
		const cleanup = after.meta.land?.cleanup ?? "";
		expect(cleanup).toContain("정리 실패");
		expect(cleanup).toContain(worktree);
		expect(cleanup).toContain(lane.meta.branch ?? "?");
		const card = shownNow(h.transport, after.meta.land?.cardTs ?? "").text;
		expect(card).toContain(`⚠️ ${cleanup}`);
		// The "cleaned up" segment is gone; the cleanup note itself says "정리 실패".
		expect(card).not.toMatch(/· worktree·브랜치 정리(?! 실패)/);
		expect(outcome.text).toContain(`⚠️ ${cleanup}`);
		expect(outcome.text).not.toContain("· worktree 정리");
		h.close();
	});

	test("(e) a removal that leaves only the branch: landed with a ⚠️ cleanup note naming the branch", async () => {
		const { repo } = repoWithOrigin();
		const h = laneHarness(home.dir, {
			land: landerWith(async (input) => {
				git(input.repo, "worktree", "remove", "--force", input.worktree);
			}),
		});
		const { lane } = await closeLane(h, repo);

		const outcome = await h.manager.requestLand(lane.name, "owner");
		await h.settle();
		const after = requireLane(h, lane.name);
		expect(after.meta.land?.state).toBe("landed");
		expect(existsSync(lane.meta.worktree ?? "")).toBe(false);
		const cleanup = after.meta.land?.cleanup ?? "";
		expect(cleanup).toContain(`브랜치 ${lane.meta.branch}`);
		expect(cleanup).not.toContain(`worktree ${lane.meta.worktree}`);
		const card = shownNow(h.transport, after.meta.land?.cardTs ?? "").text;
		expect(card).toContain(`⚠️ ${cleanup}`);
		// The "cleaned up" segment is gone; the cleanup note itself says "정리 실패".
		expect(card).not.toMatch(/· worktree·브랜치 정리(?! 실패)/);
		expect(outcome.text).toContain(`⚠️ ${cleanup}`);
		expect(outcome.text).not.toContain("· worktree 정리");
		h.close();
	});

	test("(f) already merged, then uncommitted changes in the worktree: the retry pushes, keeps the worktree and its changes, and says so", async () => {
		const { repo, bare, base } = repoWithOrigin();
		let fail = true;
		const rec = recordingGit(async (args, run) => {
			const result = await run();
			if (fail && args.includes("merge") && args.includes("--ff-only")) {
				fail = false;
				throw new Error("killed after the merge");
			}
			return result;
		});
		const h = laneHarness(home.dir, { land: realLander(rec.git) });
		const { lane, sha } = await closeLane(h, repo);
		const worktree = lane.meta.worktree ?? "";
		await h.manager.requestLand(lane.name, "owner");
		await h.settle();
		expect(headOf(repo)).toBe(sha);
		expect(rec.count("push")).toBe(0);
		writeFileSync(join(worktree, "README.md"), "edited after the merge\n");
		writeFileSync(join(worktree, "late-wip.txt"), "wip\n");

		await h.manager.tick();
		await h.settle();
		const after = requireLane(h, lane.name);
		expect(after.meta.land?.state).toBe("landed");
		expect(headOf(bare, `refs/heads/${base}`)).toBe(sha);
		expect(existsSync(worktree)).toBe(true);
		const status = git(worktree, "status", "--porcelain");
		expect(status).toContain("README.md");
		expect(status).toContain("late-wip.txt");
		const cleanup = after.meta.land?.cleanup ?? "";
		expect(cleanup).toContain("미커밋 변경 2건");
		expect(cleanup).toContain(worktree);
		expect(cleanup).not.toContain(`${base}는 바뀌지 않았습니다`);
		expect(shownNow(h.transport, after.meta.land?.cardTs ?? "").text).toContain(`⚠️ ${cleanup}`);
		h.close();
	});

	test("(g) already merged and the worktree already removed: the retry lands with no cleanup note", async () => {
		const { repo, bare, base } = repoWithOrigin();
		let fail = true;
		const h = laneHarness(home.dir, {
			land: landerWith(async (input) => {
				await createTaskHostOps().removeWorktree(input);
				if (fail) {
					fail = false;
					throw new Error("killed after the cleanup");
				}
			}),
		});
		const { lane, sha } = await closeLane(h, repo);
		await h.manager.requestLand(lane.name, "owner");
		await h.settle();
		expect(requireLane(h, lane.name).meta.land?.state).toBe("pending");
		expect(existsSync(lane.meta.worktree ?? "")).toBe(false);

		await h.manager.tick();
		await h.settle();
		const after = requireLane(h, lane.name);
		expect(after.meta.land?.state).toBe("landed");
		expect(after.meta.land?.cleanup).toBeUndefined();
		expect(headOf(bare, `refs/heads/${base}`)).toBe(sha);
		expect(git(repo, "branch", "--list", lane.meta.branch ?? "")).toBe("");
		h.close();
	});
});

describe("closed → Outcome card and auto-merge (AC-5)", () => {
	const reasonTask = (reason: string): string => `자동 머지 안 함: ${reason}`;

	/** A closed lane whose auto-merge was skipped: no landing, one card with the reason line and both buttons. */
	function expectAsked(h: LaneHarness, lane: LaneRow, calls: LandRequest[], reason: string): void {
		expect(calls).toHaveLength(0);
		expect(requireLane(h, lane.name).meta.land?.state).toBe("pending");
		const cards = cardPosts(h.transport, lane);
		expect(cards).toHaveLength(1);
		expect(cards[0]?.text).toContain("자동 머지 안 함: ");
		expect(cards[0]?.text).toContain(reason);
		const blocks = JSON.stringify(cards[0]?.blocks ?? []);
		expect(blocks).toContain(mergeId(lane));
		expect(blocks).toContain(discardId(lane));
		expect(existsSync(lane.meta.worktree ?? "")).toBe(true);
	}

	test("no blockers: landLane runs exactly once and one card without buttons goes up", async () => {
		const { repo, bare, base } = repoWithOrigin();
		const counted = countingLand();
		const h = laneHarness(home.dir, {
			land: counted.land,
			autoLandPolicy: () => ({ repos: [repo], maxRisk: "L2" }),
		});
		const { lane, sha } = await closeLane(h, repo);
		expect(counted.calls).toHaveLength(1);
		expect(counted.calls[0]).toMatchObject({ repo, baseBranch: base, sha, push: true });
		expect(requireLane(h, lane.name).meta.land).toMatchObject({ state: "landed", requestedBy: "auto" });
		expect(headOf(bare, `refs/heads/${base}`)).toBe(sha);
		const cards = cardPosts(h.transport, lane);
		expect(cards).toHaveLength(1);
		expect(cards[0]?.text).toContain("자동 머지");
		expect(JSON.stringify(cards[0]?.blocks ?? [])).not.toContain("ompbot:lane:");
		const shown = shownNow(h.transport, cards[0]?.ts ?? "");
		expect(shown.blocks).not.toContain("ompbot:lane:");
		expect(shown.text).toContain(`origin/${base}`);
		// A later tick neither lands nor posts again.
		await h.manager.tick();
		await h.settle();
		expect(counted.calls).toHaveLength(1);
		expect(cardPosts(h.transport, lane)).toHaveLength(1);
		h.close();
	});

	test("the lane's own turn is still running at the close: the card goes up, the landing waits for the turn to end", async () => {
		const { repo, bare, base } = repoWithOrigin();
		const counted = countingLand();
		let busy = true;
		const h = laneHarness(home.dir, {
			land: counted.land,
			autoLandPolicy: () => ({ repos: [repo], maxRisk: "L2" }),
			laneBusy: () => busy,
		});
		const { lane, sha } = await closeLane(h, repo);
		// Nothing removes the worktree under the turn that is writing the closing report.
		expect(counted.calls).toHaveLength(0);
		expect(requireLane(h, lane.name).meta.land).toMatchObject({ state: "pending", requestedBy: "auto" });
		expect(cardPosts(h.transport, lane)).toHaveLength(1);
		expect(cardPosts(h.transport, lane)[0]?.text).toContain("자동 머지");
		expect(existsSync(lane.meta.worktree ?? "")).toBe(true);
		expect((await h.manager.discard(lane.name)).handled).toBe(false);
		await h.manager.tick();
		await h.settle();
		expect(counted.calls).toHaveLength(0);

		busy = false;
		await h.manager.tick();
		await h.settle();
		expect(counted.calls).toHaveLength(1);
		expect(requireLane(h, lane.name).meta.land?.state).toBe("landed");
		expect(headOf(bare, `refs/heads/${base}`)).toBe(sha);
		expect(cardPosts(h.transport, lane)).toHaveLength(1);
		h.close();
	});

	test("`멈춰` while the auto-merge waits for the lane's turn: the tick after the turn lands nothing, the card asks again", async () => {
		const { repo, bare, base } = repoWithOrigin();
		const counted = countingLand();
		let busy = true;
		const h = laneHarness(home.dir, {
			land: counted.land,
			autoLandPolicy: () => ({ repos: [repo], maxRisk: "L2" }),
			laneBusy: () => busy,
		});
		const { lane, sha } = await closeLane(h, repo);
		expect(requireLane(h, lane.name).meta.land).toMatchObject({ state: "pending", requestedBy: "auto" });
		const before = headOf(bare, `refs/heads/${base}`);

		const outcome = await h.manager.pause(lane.name, "owner-message");
		await h.settle();
		expect(outcome.text).toContain("자동 머지");
		busy = false;
		await h.manager.tick();
		await h.settle();
		expect(counted.calls).toHaveLength(0);
		expect(headOf(bare, `refs/heads/${base}`)).toBe(before);
		const held = requireLane(h, lane.name);
		expect(held.meta.land).toMatchObject({ state: "pending", autoLandHeld: "오너 멈춤" });
		expect(held.meta.land?.requestedBy).toBeUndefined();
		// The card offers the buttons again, and the owner's own merge still lands.
		const shown = shownNow(h.transport, held.meta.land?.cardTs ?? "");
		expect(shown.blocks).toContain(mergeId(lane));
		expect((await h.manager.requestLand(lane.name, "owner")).handled).toBe(true);
		await h.settle();
		expect(counted.calls).toHaveLength(1);
		expect(headOf(bare, `refs/heads/${base}`)).toBe(sha);
		h.close();
	});

	test("`멈춰` while the auto-merge card is going up: nothing lands and the card asks instead", async () => {
		const { repo, bare, base } = repoWithOrigin();
		const counted = countingLand();
		const h = laneHarness(home.dir, {
			land: counted.land,
			autoLandPolicy: () => ({ repos: [repo], maxRisk: "L2" }),
		});
		// The owner's pause arrives exactly while the "auto-merge" card is being posted.
		const post = h.transport.postMessage.bind(h.transport);
		let pausedDuringPost = false;
		h.transport.postMessage = async (args) => {
			if (!pausedDuringPost && args.text.includes("자동 머지")) {
				pausedDuringPost = true;
				const name = h.store.listLanes()[0]?.name ?? "";
				expect((await h.manager.pause(name, "owner-message")).handled).toBe(true);
			}
			return post(args);
		};
		const before = headOf(bare, `refs/heads/${base}`);
		const { lane } = await closeLane(h, repo);
		await h.manager.tick();
		await h.settle();
		expect(pausedDuringPost).toBe(true);
		expect(counted.calls).toHaveLength(0);
		expect(headOf(bare, `refs/heads/${base}`)).toBe(before);
		const held = requireLane(h, lane.name);
		expect(held.meta.land).toMatchObject({ state: "pending", autoLandHeld: "오너 멈춤" });
		expect(held.meta.land?.requestedBy).toBeUndefined();
		const shown = shownNow(h.transport, held.meta.land?.cardTs ?? "");
		expect(shown.blocks).toContain(mergeId(lane));
		expect(shown.text).toContain("오너 멈춤");
		h.close();
	});

	test("the owner's request while the lane's turn still runs: accepted, landed by the tick after the turn", async () => {
		const { repo } = repoWithOrigin();
		const counted = countingLand();
		let busy = true;
		const h = laneHarness(home.dir, { land: counted.land, laneBusy: () => busy });
		const { lane } = await closeLane(h, repo);
		const outcome = await h.manager.requestLand(lane.name, "owner");
		expect(outcome.handled).toBe(true);
		expect(outcome.text).toContain("끝나는 대로");
		expect(counted.calls).toHaveLength(0);
		const queued = shownNow(h.transport, requireLane(h, lane.name).meta.land?.cardTs ?? "");
		expect(queued.text).toContain("머지 중");
		expect(queued.blocks).not.toContain("ompbot:lane:");
		// A second request while it waits changes nothing.
		expect((await h.manager.requestLand(lane.name, "owner")).handled).toBe(true);
		busy = false;
		await h.manager.tick();
		await h.settle();
		expect(counted.calls).toHaveLength(1);
		expect(requireLane(h, lane.name).meta.land?.state).toBe("landed");
		h.close();
	});

	test("no taskAutoLand at all: a card with both buttons and no auto-merge line", async () => {
		const { repo } = repoWithOrigin();
		const counted = countingLand();
		const h = laneHarness(home.dir, { land: counted.land });
		const { lane } = await closeLane(h, repo);
		expect(counted.calls).toHaveLength(0);
		const cards = cardPosts(h.transport, lane);
		expect(cards).toHaveLength(1);
		expect(cards[0]?.text).not.toContain("자동 머지 안 함");
		expect(JSON.stringify(cards[0]?.blocks ?? [])).toContain(mergeId(lane));
		expect(JSON.stringify(cards[0]?.blocks ?? [])).toContain(discardId(lane));
		h.close();
	});

	test("outside repos: asked", async () => {
		const { repo } = repoWithOrigin();
		const counted = countingLand();
		const h = laneHarness(home.dir, {
			land: counted.land,
			autoLandPolicy: () => ({ repos: [makeRepo(repos)], maxRisk: "L2" }),
		});
		const { lane } = await closeLane(h, repo);
		expectAsked(h, lane, counted.calls, "taskAutoLand.repos 밖");
		h.close();
	});

	test("risk above maxRisk: asked", async () => {
		const { repo } = repoWithOrigin();
		const counted = countingLand();
		const h = laneHarness(home.dir, { land: counted.land, autoLandPolicy: () => ({ repos: [repo], maxRisk: "L2" }) });
		const { lane } = await closeLane(h, repo, { risk: "L3" });
		expectAsked(h, lane, counted.calls, "위험 L3 > L2");
		h.close();
	});

	test("no re-run check: asked", async () => {
		const { repo } = repoWithOrigin();
		const counted = countingLand();
		const h = laneHarness(home.dir, { land: counted.land, autoLandPolicy: () => ({ repos: [repo], maxRisk: "L2" }) });
		const { lane } = await closeLane(h, repo, { acceptance: [NO_CHECK] });
		expectAsked(h, lane, counted.calls, "재실행 검사 없음");
		h.close();
	});

	test("closed through an owner-approved integrity refusal: asked", async () => {
		const { repo } = repoWithOrigin();
		const counted = countingLand();
		const refusal: IntegrityRefusal = {
			category: "unfinished_work_marker",
			excerpt: "a.txt: 나중에",
			remedy: "끝내세요",
		};
		const h = laneHarness(home.dir, {
			land: counted.land,
			autoLandPolicy: () => ({ repos: [repo], maxRisk: "L2" }),
			integrity: () => [refusal],
			approvals: { request: async () => "approved" },
		});
		const { lane } = await closeLane(h, repo);
		expect(requireLane(h, lane.name).meta.land?.autoLandHeld).toBe("무결성 승인");
		expectAsked(h, lane, counted.calls, "무결성 승인");
		h.close();
	});

	test("frozen: asked, and the owner's request still lands while frozen (AC-6)", async () => {
		const { repo } = repoWithOrigin();
		const counted = countingLand();
		let frozen = false;
		const h = laneHarness(home.dir, {
			land: counted.land,
			autoLandPolicy: () => ({ repos: [repo], maxRisk: "L2" }),
			frozen: () => (frozen ? { since: "2027-01-15T00:00:00.000Z", reason: "", by: "test" } : undefined),
		});
		const started = await h.manager.start({
			title: "land",
			cwd: repo,
			channel: "D1",
			acceptance: [CHECK_A],
			risk: "L2",
		});
		await h.settle();
		commitIn(started.cwd, "a.txt");
		frozen = true;
		await h.manager.claimDone(started.originKey, { repo: started.cwd, commit: "HEAD", summary: "a.txt 추가" });
		await h.settle();
		const lane = requireLane(h, started.name);
		expect(lane.status).toBe("closed");
		expectAsked(h, lane, counted.calls, "동결 중");

		await h.manager.requestLand(lane.name, "owner");
		await h.settle();
		expect(counted.calls).toHaveLength(1);
		expect(requireLane(h, lane.name).meta.land?.state).toBe("landed");
		h.close();
	});

	test("a failed re-run check on record: asked (the card is posted by the tick after a failed first post)", async () => {
		const { repo } = repoWithOrigin();
		const counted = countingLand();
		const h = laneHarness(home.dir, { land: counted.land, autoLandPolicy: () => ({ repos: [repo], maxRisk: "L2" }) });
		const started = await h.manager.start({
			title: "land",
			cwd: repo,
			channel: "D1",
			acceptance: [CHECK_A],
			risk: "L2",
		});
		await h.settle();
		const sha = commitIn(started.cwd, "a.txt");
		// The auto-merge card cannot be posted: nothing lands on an announcement the owner never saw.
		h.transport.failNext.postMessage = [new SlackCallError("definitive", "slack_platform_error:channel_not_found")];
		await h.manager.claimDone(started.originKey, { repo: started.cwd, commit: "HEAD", summary: "a.txt 추가" });
		await h.settle();
		expect(counted.calls).toHaveLength(0);
		expect(requireLane(h, started.name).meta.land).toEqual({ state: "pending", attempts: 0 });
		h.store.patchLane(started.name, undefined, {
			checks: { head: sha, results: [{ id: "AC-1", signal: 'command ["false"]', ok: false, detail: "exit 1" }] },
		});

		await h.manager.tick();
		await h.settle();
		// The fake transport records the failed post too: the card is the one the lane row points to.
		const lane = requireLane(h, started.name);
		expect(counted.calls).toHaveLength(0);
		expect(lane.meta.land).toMatchObject({ state: "pending", attempts: 0 });
		const card = shownNow(h.transport, lane.meta.land?.cardTs ?? "");
		expect(card.text).toContain("자동 머지 안 함: 재실행 검사 실패 1/1");
		expect(card.blocks).toContain(mergeId(lane));
		expect(card.blocks).toContain(discardId(lane));
		expect(existsSync(lane.meta.worktree ?? "")).toBe(true);
		h.close();
	});

	test("a lane closed past timed-out checks (확인 불가 승인): never auto-merged; the card asks with the ⚠️ and ⏳ lines", async () => {
		const { repo } = repoWithOrigin();
		const counted = countingLand();
		const slow = 'bun test [check: command ["sh","-c","exit 0 # slow"]]';
		const real = createTaskHostOps();
		const h = laneHarness(home.dir, {
			land: counted.land,
			autoLandPolicy: () => ({ repos: [repo], maxRisk: "L2" }),
			approvals: { request: async () => "approved" },
			hostOps: {
				...real,
				runCheck: async (input) =>
					input.argv.at(-1) === "exit 0 # slow" ? { code: null, output: "", timedOut: true } : real.runCheck(input),
			},
		});
		const started = await h.manager.start({
			title: "land",
			cwd: repo,
			channel: "D1",
			acceptance: [CHECK_A, slow],
			risk: "L2",
		});
		await h.settle();
		commitIn(started.cwd, "a.txt");
		await h.manager.claimDone(started.originKey, { repo: started.cwd, commit: "HEAD", summary: "a.txt 추가" });
		h.advance(CLAIM_GRACE_MS);
		await h.manager.tick();
		await h.settle();

		const lane = requireLane(h, started.name);
		expect(lane.status).toBe("closed");
		expect(lane.meta.land?.autoLandHeld).toBe(INCONCLUSIVE_APPROVED);
		expectAsked(h, lane, counted.calls, "재실행 검사 확인 불가 1/2 · 확인 불가 승인으로 통과");
		const card = cardPosts(h.transport, lane)[0]?.text ?? "";
		expect(card).toContain("⚠️ 확인 불가 승인으로 닫힌 레인입니다(재실행 검사 300초 초과를 오너가 승인).");
		expect(card).toContain("✅ check 1/2 통과 · ⏳ 1 확인 불가");
		expect(card).not.toContain("❌");
		expect(card).not.toContain("재실행 검사 실패");

		// A later tick does not merge it either.
		await h.manager.tick();
		await h.settle();
		expect(counted.calls).toHaveLength(0);
		h.close();
	});

	test("laneLandBlockers names every reason; [] only when none applies", async () => {
		const { repo } = repoWithOrigin();
		const h = laneHarness(home.dir);
		const { lane, sha } = await closeLane(h, repo);
		const policy = { repos: [repo], maxRisk: "L2" as const };
		expect(laneLandBlockers(lane, policy, true, false)).toEqual([]);
		expect(laneLandBlockers(lane, policy, false, false)).toEqual(["저장소가 taskAutoLand.repos 밖"]);
		expect(laneLandBlockers(lane, { ...policy, maxRisk: "L1" }, true, false)).toEqual(["위험 L2 > L1"]);
		expect(laneLandBlockers(lane, policy, true, true)).toEqual(["동결 중"]);
		const noChecks = { ...lane, meta: { ...lane.meta, checks: undefined } };
		expect(laneLandBlockers(noChecks, policy, true, false)).toEqual(["재실행 검사 없음"]);
		// Checks of another commit prove nothing about the claim.
		const stale = { ...lane, meta: { ...lane.meta, checks: { head: "0".repeat(40), results: [] } } };
		expect(laneLandBlockers(stale, policy, true, false)).toEqual(["재실행 검사 없음"]);
		const failed = {
			...lane,
			meta: {
				...lane.meta,
				checks: { head: sha, results: [{ id: "AC-1", signal: "s", ok: false, detail: "exit 1" }] },
			},
		};
		expect(laneLandBlockers(failed, policy, true, false)).toEqual(["재실행 검사 실패 1/1"]);
		const timedOut = { id: "AC-2", signal: "t", ok: false, detail: "300초 안에 끝나지 않았습니다(확인 불가)" };
		const inconclusive = {
			...lane,
			meta: {
				...lane.meta,
				checks: {
					head: sha,
					results: [
						{ id: "AC-1", signal: "s", ok: true, detail: "exit 0" },
						{ ...timedOut, inconclusive: true as const },
					],
				},
			},
		};
		expect(laneLandBlockers(inconclusive, policy, true, false)).toEqual(["재실행 검사 확인 불가 1/2"]);
		const both = {
			...lane,
			meta: {
				...lane.meta,
				checks: {
					head: sha,
					results: [
						{ id: "AC-1", signal: "s", ok: false, detail: "exit 1" },
						{ ...timedOut, inconclusive: true as const },
					],
				},
			},
		};
		expect(laneLandBlockers(both, policy, true, false)).toEqual(["재실행 검사 실패 1/2", "재실행 검사 확인 불가 1/2"]);
		const approved = {
			...inconclusive,
			meta: {
				...inconclusive.meta,
				land: { state: "pending" as const, attempts: 0, autoLandHeld: INCONCLUSIVE_APPROVED },
			},
		};
		expect(laneLandBlockers(approved, policy, true, false)).toEqual([
			"재실행 검사 확인 불가 1/2",
			"확인 불가 승인으로 통과",
		]);
		const approvedCard = buildLaneOutcomeCard(approved, { kind: "ask", ownerUserId: OWNER });
		expect(approvedCard.text).toContain("⚠️ 확인 불가 승인으로 닫힌 레인입니다(재실행 검사 300초 초과를 오너가 승인).");
		expect(approvedCard.text).toContain("✅ check 1/2 통과 · ⏳ 1 확인 불가 — ");
		expect(approvedCard.text).not.toContain("❌");
		expect(approvedCard.fields).toContainEqual({ label: "재실행 검사", value: "1/2 · ⏳ 1 확인 불가" });
		// Without timed-out checks the card reads exactly as before.
		expect(buildLaneOutcomeCard(lane, { kind: "ask" }).text).not.toContain("확인 불가");
		const held = {
			...lane,
			meta: { ...lane.meta, land: { state: "pending" as const, attempts: 0, autoLandHeld: "무결성 승인" } },
		};
		expect(laneLandBlockers(held, policy, true, false)).toEqual(["무결성 승인으로 통과"]);
		const all = laneLandBlockers({ ...failed, meta: { ...failed.meta, risk: "L4" } }, policy, false, true);
		expect(all).toEqual(["저장소가 taskAutoLand.repos 밖", "위험 L4 > L2", "재실행 검사 실패 1/1", "동결 중"]);

		const card = buildLaneOutcomeCard(lane, { kind: "ask", ownerUserId: OWNER, skipped: all });
		expect(card.text).toContain(reasonTask(all.join(" · ")));
		expect(card.buttons?.map((button) => button.actionId)).toEqual([mergeId(lane), discardId(lane)]);
		expect(card.buttons?.map((button) => button.label)).toEqual(["머지", "폐기"]);
		h.close();
	});
});

describe("Outcome card: the claim commit's changes and overlaps (doc/plans/lane-card-changes.md)", () => {
	const changesOf = (sha: string, over: Partial<LaneChanges> = {}): LaneChanges => ({
		sha,
		files: 7,
		insertions: 40,
		deletions: 3,
		top: [
			{ path: "src/a.ts", added: 30, deleted: 1 },
			{ path: "src/b.ts", added: 5, deleted: 2 },
		],
		overlaps: [],
		baseDrift: [],
		...over,
	});
	const withChanges = (lane: LaneRow, changes: LaneChanges): LaneRow => ({ ...lane, meta: { ...lane.meta, changes } });
	const bodyLines = (lane: LaneRow): string[] => (buildLaneOutcomeCard(lane, { kind: "ask" }).body ?? "").split("\n");
	const askIndex = (lines: string[]): number => lines.findIndex((line) => line.includes("머지할까요?"));

	test("AC-6b: the first ask card is posted with the 변경 field and the top line, computed at the close", async () => {
		const { repo } = repoWithOrigin();
		const h = laneHarness(home.dir);
		const { lane, sha } = await closeLane(h, repo);
		expect(lane.meta.changes).toMatchObject({
			sha,
			files: 1,
			insertions: 1,
			deletions: 0,
			overlaps: [],
			baseDrift: [],
		});
		const cards = cardPosts(h.transport, lane);
		expect(cards).toHaveLength(1);
		expect(JSON.stringify(cards[0]?.blocks ?? [])).toContain("1개 파일 · +1 −0");
		expect(cards[0]?.text).toContain("변경: a.txt (+1 −0)");
		expect(cards[0]?.text).not.toContain("겹침");
		h.close();
	});

	test("AC-3: this lane's own diff failed: 변경 reads 확인 실패 and no 변경 line", async () => {
		const { repo } = repoWithOrigin();
		const failing: GitRunner = (args) =>
			args.includes("merge-base")
				? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: no base\n" })
				: defaultGit(args);
		const h = laneHarness(home.dir, { changesGit: failing });
		const { lane, sha } = await closeLane(h, repo);
		expect(lane.meta.changes).toMatchObject({ sha, files: 0, top: [] });
		expect(lane.meta.changes?.error).toContain("merge-base 실패");
		expect(h.logs.some((line) => line.includes("lane_changes_failed"))).toBe(true);
		const card = buildLaneOutcomeCard(lane, { kind: "ask" });
		expect(card.fields).toContainEqual({ label: "변경", value: "확인 실패" });
		expect(card.text).not.toContain("변경:");
		const cards = cardPosts(h.transport, lane);
		expect(cards).toHaveLength(1);
		expect(JSON.stringify(cards[0]?.blocks ?? [])).toContain("확인 실패");
		h.close();
	});

	test("AC-4: without changes, or with changes of another commit, the card is exactly as before", async () => {
		const { repo } = repoWithOrigin();
		const h = laneHarness(home.dir);
		const { lane } = await closeLane(h, repo);
		const without: LaneRow = { ...lane, meta: { ...lane.meta, changes: undefined } };
		const stale = withChanges(lane, changesOf("0".repeat(40), { overlaps: [{ lane: "x", files: ["src/a.ts"] }] }));
		for (const view of [
			{ kind: "ask" },
			{ kind: "auto" },
			{ kind: "merging", queued: false },
			{ kind: "result" },
		] as const) {
			const before = buildLaneOutcomeCard(without, view);
			expect(buildLaneOutcomeCard(stale, view)).toEqual(before);
			expect(before.fields?.map((field) => field.label)).toEqual([
				"수락기준(봇 확인/전체)",
				"재실행 검사",
				"브랜치",
				"커밋",
			]);
			expect(before.text).not.toContain("변경");
		}
		h.close();
	});

	test("AC-5: the top and overlap lines come before the merge question; no overlap, no overlap line", async () => {
		const { repo } = repoWithOrigin();
		const h = laneHarness(home.dir);
		const { lane, sha } = await closeLane(h, repo);
		const plain = withChanges(lane, changesOf(sha));
		const plainLines = bodyLines(plain);
		const top = plainLines.findIndex((line) => line.startsWith("변경: "));
		expect(plainLines[top]).toBe("변경: src/a.ts (+30 −1), src/b.ts (+5 −2) 외 5개");
		expect(top).toBeGreaterThan(plainLines.findIndex((line) => line.startsWith("✅ check")));
		expect(top).toBeLessThan(askIndex(plainLines));
		expect(plainLines.some((line) => line.includes("겹침"))).toBe(false);
		expect(buildLaneOutcomeCard(plain, { kind: "ask" }).fields).toContainEqual({
			label: "변경",
			value: "7개 파일 · +40 −3",
		});

		const overlapping = withChanges(
			lane,
			changesOf(sha, { overlaps: [{ lane: "other", files: ["src/a.ts", "src/b.ts"] }], baseDrift: ["src/c.ts"] }),
		);
		const lines = bodyLines(overlapping);
		const overlap = lines.findIndex((line) => line.startsWith("⚠️ 겹침: "));
		expect(lines[overlap]).toBe("⚠️ 겹침: 레인 `other` — src/a.ts, src/b.ts · base가 그새 바꾼 파일 — src/c.ts");
		expect(overlap).toBeGreaterThan(top - 1);
		expect(overlap).toBeLessThan(askIndex(lines));
		expect(buildLaneOutcomeCard(overlapping, { kind: "ask" }).text).toContain(lines[overlap] ?? "?");

		const partial = withChanges(lane, changesOf(sha, { baseDrift: ["src/c.ts"], overlapError: "레인 x diff 실패" }));
		expect(bodyLines(partial)).toContain("⚠️ 겹침: base가 그새 바꾼 파일 — src/c.ts (일부 확인 실패)");
		const failedOnly = withChanges(lane, changesOf(sha, { overlapError: "base 변경 조회 실패" }));
		expect(bodyLines(failedOnly).filter((line) => line.includes("겹침"))).toEqual(["⚠️ 겹침: 일부 확인 실패"]);

		// Auto, merging and result cards gain the field only.
		for (const view of [{ kind: "auto" }, { kind: "merging", queued: true }] as const) {
			const card = buildLaneOutcomeCard(overlapping, view);
			expect(card.fields).toContainEqual({ label: "변경", value: "7개 파일 · +40 −3" });
			expect(card.text).not.toContain("겹침");
			expect(card.text).not.toContain("변경:");
		}
		h.close();
	});

	test("AC-6: `!reopen` and a not-ff landing sent back to work drop the changes", async () => {
		const { repo } = repoWithOrigin();
		const h = laneHarness(home.dir);
		const { lane } = await closeLane(h, repo);
		expect(requireLane(h, lane.name).meta.changes).toBeDefined();
		h.manager.onOwnerMessage(requireLane(h, lane.name), "!reopen 하나만 더");
		await h.settle();
		const reopened = requireLane(h, lane.name);
		expect(reopened.status).toBe("working");
		expect(reopened.meta.changes).toBeUndefined();

		const other = repoWithOrigin();
		const closed = await closeLane(h, other.repo, { title: "notff" });
		expect(requireLane(h, closed.lane.name).meta.changes).toBeDefined();
		commitIn(other.repo, "elsewhere.txt");
		await h.manager.requestLand(closed.lane.name, "owner");
		await h.settle();
		const working = requireLane(h, closed.lane.name);
		expect(working.status).toBe("working");
		expect(working.meta.changes).toBeUndefined();
		h.close();
	});
});

describe("merge and discard by the owner (AC-6)", () => {
	test("`머지해`·`폐기해` count only as the whole message and only while the landing is pending or blocked", () => {
		expect(classifyClosedLaneMessage("머지해", "pending")).toBe("land");
		expect(classifyClosedLaneMessage("  머지해\n", "blocked")).toBe("land");
		expect(classifyClosedLaneMessage("폐기해", "pending")).toBe("discard");
		expect(classifyClosedLaneMessage("폐기해", "blocked")).toBe("discard");
		for (const state of ["landed", "merged-not-pushed", "discarded", undefined] as const) {
			expect(classifyClosedLaneMessage("머지해", state)).toBe("question");
			expect(classifyClosedLaneMessage("폐기해", state)).toBe("question");
		}
		expect(classifyClosedLaneMessage("머지해 줘 제발", "pending")).toBe("question");
		expect(classifyClosedLaneMessage("머지해야 하나?", "pending")).toBe("question");
		expect(classifyClosedLaneMessage("머지해.", "pending")).toBe("question");
		expect(classifyClosedLaneMessage("이거 왜 이렇게 했어?", "pending")).toBe("question");
		expect(classifyClosedLaneMessage("!reopen 고쳐", "pending")).toBe("reopen");
		expect(classifyClosedLaneMessage("!queue", "pending")).toBe("control");
	});

	test("discard removes the worktree and the branch: state discarded, nothing merged", async () => {
		const { repo, bare, base } = repoWithOrigin();
		const before = headOf(repo);
		const counted = countingLand();
		const h = laneHarness(home.dir, { land: counted.land });
		const { lane, sha } = await closeLane(h, repo);

		const outcome = await h.manager.discard(lane.name);
		await h.settle();
		expect(outcome.handled).toBe(true);
		const discarded = requireLane(h, lane.name);
		expect(discarded.status).toBe("closed");
		expect(discarded.meta.land?.state).toBe("discarded");
		expect(discarded.meta.sha).toBe(sha);
		expect(existsSync(lane.meta.worktree ?? "")).toBe(false);
		expect(git(repo, "branch", "--list", lane.meta.branch ?? "")).toBe("");
		expect(headOf(repo)).toBe(before);
		expect(headOf(bare, `refs/heads/${base}`)).toBe(before);
		expect(counted.calls).toHaveLength(0);
		expect(shownNow(h.transport, discarded.meta.land?.cardTs ?? "").blocks).not.toContain("ompbot:lane:");
		// Nothing is left to merge or discard.
		expect((await h.manager.requestLand(lane.name, "owner")).handled).toBe(false);
		expect((await h.manager.discard(lane.name)).handled).toBe(false);
		expect(counted.calls).toHaveLength(0);
		h.close();
	});

	test("requests for one lane at the same time, and after it landed: landLane runs once", async () => {
		const { repo } = repoWithOrigin();
		const counted = countingLand();
		const h = laneHarness(home.dir, { land: counted.land });
		const { lane } = await closeLane(h, repo);
		const both = await Promise.all([
			h.manager.requestLand(lane.name, "owner"),
			h.manager.requestLand(lane.name, "owner"),
		]);
		await h.settle();
		expect(both.map((outcome) => outcome.handled).sort()).toEqual([false, true]);
		expect((await h.manager.requestLand(lane.name, "owner")).handled).toBe(false);
		expect(counted.calls).toHaveLength(1);
		expect(requireLane(h, lane.name).meta.land?.state).toBe("landed");
		h.close();
	});

	test("a working lane takes neither a merge nor a discard", async () => {
		const { repo } = repoWithOrigin();
		const counted = countingLand();
		const h = laneHarness(home.dir, { land: counted.land });
		const lane = await h.manager.start({ title: "land", cwd: repo, channel: "D1" });
		await h.settle();
		expect((await h.manager.requestLand(lane.name, "owner")).handled).toBe(false);
		expect((await h.manager.discard(lane.name)).handled).toBe(false);
		expect(counted.calls).toHaveLength(0);
		expect(existsSync(lane.meta.worktree ?? "")).toBe(true);
		h.close();
	});

	describe("through the daemon: thread messages and card buttons", () => {
		let transport: WaitingTransport;
		let drivers: Map<string, FakeOmpDriver>;
		let counted: { land: LandLane; calls: LandRequest[] };
		let logs: string[];

		beforeEach(() => {
			transport = new WaitingTransport();
			drivers = new Map();
			counted = countingLand();
			logs = [];
		});

		/** A daemon with one closed lane `ask` waiting for the owner's merge decision. */
		async function pendingLane(): Promise<{
			daemon: Daemon;
			repo: string;
			bare: string;
			base: string;
			rootTs: string;
			cardTs: string;
			sha: string;
		}> {
			const { repo, bare, base } = repoWithOrigin();
			const sessions = new FakeSessionStore();
			const clock = { now: () => Date.now() };
			const daemon = new Daemon({
				config: home.config,
				channels: [new SlackBinding(new SlackChannel(transport))],
				log: createLogger({ sink: (line) => logs.push(line), clock, redact }),
				ompVersion: "omp-test 0",
				bootId: "boot",
				landLane: counted.land,
				driverFactory: (origin, sessionDir) => {
					const driver = new FakeOmpDriver({ sessionDir, store: sessions });
					drivers.set(origin, driver);
					return driver;
				},
			});
			daemons.push(daemon);
			await daemon.start();
			await daemon.inject({ origin: "slack/dm/D1", asOwner: true, text: `작업: ask @${repo}` });
			await transport.waitForPosts((text) => text.startsWith("ECHO ulw explore"));
			const rootTs = transport.posts((text) => text === "🔄 ask")[0]?.ts ?? "";
			const claim = daemon.hostToolsFor("ompbot/work/ask").find((tool) => tool.name === "ompbot_claim_done");
			const worktree = daemon.store.getLane("ask")?.cwd ?? "";
			const sha = commitIn(worktree, "a.txt");
			const signal = new AbortController().signal;
			// The card is answerable once the lane recorded it (its ts), not as soon as it shows in the thread.
			const recorded = cardRecorded(daemon.store, "ask");
			expect(await claim?.execute({ repo: worktree, commit: "HEAD", summary: "a.txt 추가" }, { signal })).toContain(
				"검증 통과",
			);
			await transport.waitForPosts((text) => text.startsWith("🔍 머지 대기"));
			await recorded;
			const cardTs = transport.posts((text) => text.startsWith("🔍 머지 대기"))[0]?.ts ?? "";
			expect(daemon.store.getLane("ask")?.meta.land?.state).toBe("pending");
			return { daemon, repo, bare, base, rootTs, cardTs, sha };
		}

		const send = (text: string, ts: string, rootTs: string) =>
			transport.emitMessage({
				type: "message",
				channel: "D1",
				channel_type: "im",
				user: OWNER,
				text,
				ts,
				thread_ts: rootTs,
			});
		const click = (actionId: string, cardTs: string) =>
			transport.emitBlockAction({
				user: { id: OWNER },
				channel: { id: "D1" },
				message: { ts: cardTs },
				actions: [{ action_id: actionId, value: "ask" }],
			});
		const lanePrompts = () => drivers.get("ompbot/work/ask")?.calls.filter((call) => call.startsWith("prompt:")) ?? [];
		const landState = (daemon: Daemon) => daemon.store.getLane("ask")?.meta.land?.state;

		test("`머지해` (the whole message) lands the lane without reaching omp; a later `머지해` is an ordinary question", async () => {
			const { daemon, bare, base, rootTs, sha } = await pendingLane();
			await send("머지해", "1900000000.000100", rootTs);
			await transport.waitForPosts((text) => text.includes("머지했습니다"));
			expect(counted.calls).toHaveLength(1);
			expect(landState(daemon)).toBe("landed");
			expect(headOf(bare, `refs/heads/${base}`)).toBe(sha);
			expect(transport.posts((text) => text.includes("머지했습니다"))[0]?.text).toContain(`origin/${base}`);
			expect(lanePrompts().some((call) => call.includes("머지해"))).toBe(false);
			expect(daemon.store.getInbound("D1:1900000000.000100")).toMatchObject({
				originKey: "ompbot/work/ask",
				state: "answered",
			});

			await send("머지해", "1900000000.000200", rootTs);
			await transport.waitForPosts((text) => text.startsWith("ECHO") && text.includes("머지해"));
			expect(counted.calls).toHaveLength(1);
			expect(landState(daemon)).toBe("landed");
		});

		test("after the landing the lane session works from the repository, and `!reopen` is refused by the core", async () => {
			const { daemon, repo, rootTs } = await pendingLane();
			const worktree = daemon.store.getLane("ask")?.cwd ?? "";
			expect(daemon.cwdFor("ompbot/work/ask")).toBe(worktree);
			await send("머지해", "1900000000.000100", rootTs);
			await transport.waitForPosts((text) => text.includes("머지했습니다"));
			expect(existsSync(worktree)).toBe(false);
			expect(daemon.cwdFor("ompbot/work/ask")).toBe(repo);

			await send("!reopen 하나만 더", "1900000000.000200", rootTs);
			await transport.waitForPosts((text) => text.includes("worktree가 없습니다"));
			const lane = daemon.store.getLane("ask");
			expect(lane?.status).toBe("closed");
			expect(lane?.meta.land?.state).toBe("landed");
			expect(lane?.history.map((entry) => entry.event)).not.toContain("reopened");
			expect(lanePrompts().some((call) => call.includes("!reopen"))).toBe(false);
		});

		test("`!reopen` while the merge is still waiting reopens the lane and drops the landing", async () => {
			const { daemon, rootTs, cardTs } = await pendingLane();
			await send("!reopen 하나만 더", "1900000000.000200", rootTs);
			await transport.waitForPosts((text) => text === "ECHO !reopen 하나만 더");
			const lane = daemon.store.getLane("ask");
			expect(lane?.status).toBe("working");
			expect(lane?.meta.land).toBeUndefined();
			expect(existsSync(lane?.meta.worktree ?? "")).toBe(true);
			// The stale card's button no longer lands anything.
			await click("ompbot:lane:merge:ask", cardTs);
			expect(counted.calls).toHaveLength(0);
			expect(daemon.store.getLane("ask")?.status).toBe("working");
		});

		test("`머지해 줘 제발`, `머지해야 하나?` and a plain question are answered by the lane session; nothing lands", async () => {
			const { daemon, rootTs } = await pendingLane();
			for (const [index, text] of ["머지해 줘 제발", "머지해야 하나?", "이거 왜 이렇게 했어?"].entries()) {
				await send(text, `1900000000.00030${index}`, rootTs);
				await transport.waitForPosts((post) => post.startsWith("ECHO") && post.includes(text));
				expect(lanePrompts().at(-1)).toContain(text);
			}
			expect(counted.calls).toHaveLength(0);
			expect(landState(daemon)).toBe("pending");
			expect(daemon.store.getLane("ask")?.status).toBe("closed");
			expect(daemon.store.getLane("ask")?.history.at(-1)?.event).toBe("owner_question");
		});

		test("the `머지` button lands once however often it is clicked, and the card loses its buttons", async () => {
			const { daemon, bare, base, cardTs, sha } = await pendingLane();
			expect(JSON.stringify(transport.posts().find((post) => post.ts === cardTs)?.blocks)).toContain(
				"ompbot:lane:merge:ask",
			);
			await Promise.all([click("ompbot:lane:merge:ask", cardTs), click("ompbot:lane:merge:ask", cardTs)]);
			await click("ompbot:lane:merge:ask", cardTs);
			expect(counted.calls).toHaveLength(1);
			expect(landState(daemon)).toBe("landed");
			expect(headOf(bare, `refs/heads/${base}`)).toBe(sha);
			const shown = shownNow(transport, cardTs);
			expect(shown.blocks).not.toContain("ompbot:lane:");
			expect(shown.text).toContain(`origin/${base}`);
			expect(logs.some((line) => line.includes("event=action_ignored"))).toBe(false);
		});

		test("the `폐기` button discards: worktree and branch gone, nothing merged", async () => {
			const { daemon, repo, cardTs } = await pendingLane();
			const lane = daemon.store.getLane("ask");
			const before = headOf(repo);
			await click("ompbot:lane:discard:ask", cardTs);
			expect(landState(daemon)).toBe("discarded");
			expect(existsSync(lane?.meta.worktree ?? "")).toBe(false);
			expect(git(repo, "branch", "--list", lane?.meta.branch ?? "")).toBe("");
			expect(headOf(repo)).toBe(before);
			expect(counted.calls).toHaveLength(0);
			expect(shownNow(transport, cardTs).blocks).not.toContain("ompbot:lane:");
			// A merge click on the discarded lane lands nothing, and the owner is told why in the lane's thread.
			await click("ompbot:lane:merge:ask", cardTs);
			expect(counted.calls).toHaveLength(0);
			expect(transport.posts().some((post) => post.text.startsWith("⚠️ 머지할 상태가 아닙니다"))).toBe(true);
		});

		test("`폐기해` (the whole message) discards without reaching omp", async () => {
			const { daemon, repo, rootTs } = await pendingLane();
			const lane = daemon.store.getLane("ask");
			await send("폐기해", "1900000000.000400", rootTs);
			await transport.waitForPosts((text) => text.includes("폐기했습니다"));
			expect(landState(daemon)).toBe("discarded");
			expect(existsSync(lane?.meta.worktree ?? "")).toBe(false);
			expect(git(repo, "branch", "--list", lane?.meta.branch ?? "")).toBe("");
			expect(counted.calls).toHaveLength(0);
			expect(lanePrompts().some((call) => call.includes("폐기해"))).toBe(false);
		});

		test("a button of a lane that does not exist is settled on the card, not ignored silently", async () => {
			const { cardTs } = await pendingLane();
			await click("ompbot:lane:merge:nope", cardTs);
			expect(counted.calls).toHaveLength(0);
			expect(shownNow(transport, cardTs).text).toContain("찾을 수 없");
		});
	});
});

describe("a not-done lane merged into the base branch outside the lane (doc/plans/lane-rebase-external-land.md)", () => {
	/** A worktree lane whose claim of `b.txt` failed its check (`a.txt`): not-done with the real claim sha. */
	async function notDoneLane(h: LaneHarness, repo: string): Promise<{ lane: LaneRow; sha: string; base: string }> {
		const base = baseOf(repo);
		const started = await h.manager.start({ title: "outside", cwd: repo, channel: "D1", acceptance: [CHECK_A] });
		await h.settle();
		const sha = commitIn(started.cwd, "b.txt");
		const text = await h.manager.claimDone(started.originKey, { repo: started.cwd, commit: sha, summary: "b.txt" });
		await h.settle();
		expect(text).toContain("[not-done]");
		const lane = requireLane(h, started.name);
		expect(lane.status).toBe("not-done");
		return { lane, sha, base };
	}

	function expectLandedOutside(h: LaneHarness, lane: LaneRow, sha: string): void {
		const row = requireLane(h, lane.name);
		expect(row.status).toBe("closed");
		expect(row.meta.land?.state).toBe("landed");
		expect(row.meta.land?.cleanup).toBeUndefined();
		expect(row.meta.sha).toBe(sha);
		expect(row.history.at(-1)).toMatchObject({
			event: "landed",
			sha,
			detail: `레인 밖에서 머지됨 · claim ${sha.slice(0, 12)}`,
		});
		expect(existsSync(lane.meta.worktree ?? "")).toBe(false);
		expect(git(lane.meta.repo ?? "", "branch", "--list", lane.meta.branch ?? "")).toBe("");
		expect(rootUpdates(h.transport, lane).at(-1)).toBe("✅ outside");
	}

	function expectUntouched(h: LaneHarness, lane: LaneRow, status: LaneRow["status"]): void {
		const row = requireLane(h, lane.name);
		expect(row.status).toBe(status);
		expect(row.meta.land).toBeUndefined();
		expect(existsSync(lane.meta.worktree ?? "")).toBe(true);
		expect(git(lane.meta.repo ?? "", "branch", "--list", lane.meta.branch ?? "")).not.toBe("");
	}

	async function tick(h: LaneHarness): Promise<void> {
		await h.manager.tick();
		await h.settle();
	}

	test("the verdict hands the lane's base branch to verify", async () => {
		const repo = makeRepo(repos);
		const seen: (string | undefined)[] = [];
		const h = laneHarness(home.dir, {
			verify: async (_evidence, _cwd, _baseSha, baseBranch) => {
				seen.push(baseBranch);
				return { ok: false, reasons: ["x"] };
			},
		});
		const started = await h.manager.start({ title: "outside", cwd: repo, channel: "D1" });
		await h.settle();
		await h.manager.claimDone(started.originKey, { repo: started.cwd, commit: "HEAD", summary: "s" });
		await h.settle();
		expect(seen).toEqual([baseOf(repo)]);
		h.close();
	});

	test("(A) fast-forward merge of the claim: the next tick closes it landed, worktree and branch gone", async () => {
		const { repo, bare, base } = repoWithOrigin();
		const h = laneHarness(home.dir);
		const { lane, sha } = await notDoneLane(h, repo);
		git(repo, "merge", "-q", "--ff-only", lane.meta.branch ?? "");
		await tick(h);
		expectLandedOutside(h, lane, sha);
		// origin was not pushed to: nothing recorded as pushed, and nothing pushed by the core.
		expect(requireLane(h, lane.name).meta.land?.pushed).toBeUndefined();
		expect(headOf(bare, `refs/heads/${base}`)).not.toBe(sha);
		h.close();
	});

	test("(A) the claim rebased with the same patch onto a moved base branch: closed landed; origin having it is recorded as pushed", async () => {
		const { repo, base } = repoWithOrigin();
		const h = laneHarness(home.dir);
		const { lane, sha } = await notDoneLane(h, repo);
		commitIn(repo, "c.txt");
		git(repo, "cherry-pick", sha);
		expect(headOf(repo)).not.toBe(sha);
		git(repo, "push", "-q", "origin", base);
		git(repo, "fetch", "-q", "origin");
		await tick(h);
		expectLandedOutside(h, lane, sha);
		expect(requireLane(h, lane.name).meta.land?.pushed).toBe(`origin/${base}`);
		h.close();
	});

	test("(B) 11-12: the branch rebased with the claim's patch changed, then its tip fast-forward merged: closed landed", async () => {
		const repo = makeRepo(repos);
		const h = laneHarness(home.dir);
		const { lane, sha, base } = await notDoneLane(h, repo);
		const worktree = lane.meta.worktree ?? "";
		commitIn(repo, "c.txt");
		// Another session rebases the lane branch, resolving it into a different patch, and commits on top.
		git(worktree, "rebase", "-q", base);
		writeFileSync(join(worktree, "b.txt"), "b.txt resolved\n");
		git(worktree, "commit", "-q", "-a", "--amend", "--no-edit");
		const tip = commitIn(worktree, "d.txt");
		expect(git(repo, "cherry", base, sha)).toStartWith("+ ");
		git(repo, "merge", "-q", "--ff-only", tip);
		await tick(h);
		expectLandedOutside(h, lane, sha);
		h.close();
	});

	test("working and paused lanes, and a not-done lane without a claim, stay as they are", async () => {
		const repo = makeRepo(repos);
		const h = laneHarness(home.dir);
		const { lane } = await notDoneLane(h, repo);
		git(repo, "merge", "-q", "--ff-only", lane.meta.branch ?? "");
		h.store.transitionLane(lane.name, "working", { event: "x" });
		await tick(h);
		expectUntouched(h, lane, "working");
		h.store.transitionLane(lane.name, "paused", { event: "x" }, { pausedFrom: "not-done" });
		await tick(h);
		expectUntouched(h, lane, "paused");
		h.store.transitionLane(lane.name, "done-claimed", { event: "x" });
		h.store.transitionLane(lane.name, "not-done", { event: "x" }, { claim: undefined });
		await tick(h);
		expectUntouched(h, lane, "not-done");
		h.close();
	});

	test("reset --hard to the base branch after the refused claim: stays not-done", async () => {
		const repo = makeRepo(repos);
		const h = laneHarness(home.dir);
		const { lane, base } = await notDoneLane(h, repo);
		commitIn(repo, "c.txt");
		git(lane.meta.worktree ?? "", "reset", "-q", "--hard", base);
		await tick(h);
		expectUntouched(h, lane, "not-done");
		h.close();
	});

	test("a dirty worktree, then a running turn, keep the lane; once clean and idle it closes", async () => {
		const repo = makeRepo(repos);
		let busy = false;
		const h = laneHarness(home.dir, { laneBusy: () => busy });
		const { lane, sha } = await notDoneLane(h, repo);
		git(repo, "merge", "-q", "--ff-only", lane.meta.branch ?? "");
		const scratchFile = join(lane.meta.worktree ?? "", "scratch.txt");
		writeFileSync(scratchFile, "x\n");
		await tick(h);
		expectUntouched(h, lane, "not-done");
		rmSync(scratchFile);
		busy = true;
		await tick(h);
		expectUntouched(h, lane, "not-done");
		busy = false;
		await tick(h);
		expectLandedOutside(h, lane, sha);
		h.close();
	});

	test("a commit after the claim that the base branch lacks keeps the lane", async () => {
		const repo = makeRepo(repos);
		const h = laneHarness(home.dir);
		const { lane } = await notDoneLane(h, repo);
		git(repo, "merge", "-q", "--ff-only", lane.meta.branch ?? "");
		commitIn(lane.meta.worktree ?? "", "e.txt");
		await tick(h);
		expectUntouched(h, lane, "not-done");
		h.close();
	});

	test("a git call that fails changes nothing and logs lane_external_land_check_failed", async () => {
		const repo = makeRepo(repos);
		const h = laneHarness(home.dir);
		const { lane } = await notDoneLane(h, repo);
		git(repo, "merge", "-q", "--ff-only", lane.meta.branch ?? "");
		h.store.patchLane(lane.name, undefined, { baseBranch: "no-such-branch" });
		await tick(h);
		expectUntouched(h, lane, "not-done");
		expect(h.logs.some((line) => line.includes("lane_external_land_check_failed"))).toBe(true);
		h.close();
	});
});
