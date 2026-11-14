import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseThreadRef } from "../src/core/normalize";
import { Daemon } from "../src/daemon/daemon";
import { GUEST_OVERLAY_YAML } from "../src/daemon/guest";
import type { ProcessRunner, RunProcessOptions, RunProcessResult } from "../src/dispatch/omp";
import { createLaneLander, type LandLane, type LandRequest, laneLandBlockers } from "../src/lanes/land";
import {
	buildReviewPrompt,
	parseReviewVerdict,
	REVIEW_DIFF_PROMPT_MAX,
	REVIEW_DISABLED_DISCOVERY,
	REVIEW_OVERLAY_YAML,
	REVIEW_SECTIONS,
	reviewIsolationPaths,
	reviewLane,
} from "../src/lanes/review";
import type { LaneRow } from "../src/lanes/status";
import { defaultGit, type GitRunner } from "../src/lanes/verify";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import { createTaskHostOps } from "../src/tasks/host";
import type { AutoLandPolicy } from "../src/tasks/notify";
import { makeHome, type TestHome, WaitingTransport } from "./helpers/bot-home";
import { git, makeRepo } from "./helpers/git-fixtures";
import { type LaneHarness, laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";
import type { FakeCall } from "./helpers/slack-fake-transport";

// The independent review before a lane's auto-merge (doc/plans/lane-review-receipt.md). Git is real (temp
// repositories); the reviewer's `omp -p` is a fake process runner.

const CHECK_A = 'a.txt가 있다 [check: command ["sh","-c","test -f a.txt"]]';
const MODEL = "test/reviewer";
const REVIEW = { model: MODEL, timeoutMs: 60_000 };

type Post = Extract<FakeCall, { method: "postMessage" }>;

let home: TestHome;
let repos: string[];
let daemons: Daemon[];

beforeEach(() => {
	home = makeHome("ompbot-lane-review-home-");
	repos = [];
	daemons = [];
});

afterEach(async () => {
	for (const daemon of daemons) await daemon.stop();
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
});

interface ReviewCall {
	cmd: string[];
	opts: RunProcessOptions;
}

/** A fake `omp -p`: every call is recorded and answered by `answer`. */
function fakeRunner(answer: (call: ReviewCall) => RunProcessResult | Promise<RunProcessResult>): {
	run: ProcessRunner;
	calls: ReviewCall[];
} {
	const calls: ReviewCall[] = [];
	return {
		calls,
		run: async (cmd, opts) => {
			const call = { cmd, opts };
			calls.push(call);
			return answer(call);
		},
	};
}

const says = (stdout: string, over: Partial<RunProcessResult> = {}) =>
	fakeRunner(() => ({ code: 0, stdout, timedOut: false, ...over }));

/** The real landing, every call counted. */
function countingLand(): { land: LandLane; calls: LandRequest[] } {
	const real = createLaneLander({ removeWorktree: (input) => createTaskHostOps().removeWorktree(input) });
	const calls: LandRequest[] = [];
	return {
		calls,
		land: (request, hooks) => {
			calls.push(request);
			return real(request, hooks);
		},
	};
}

const reviewsDir = (): string => join(home.dir, "reviews");

function harness(
	run: ProcessRunner,
	policy: AutoLandPolicy | undefined,
	extra: { git?: GitRunner; land?: LandLane } = {},
): LaneHarness {
	return laneHarness(home.dir, {
		...(extra.land === undefined ? {} : { land: extra.land }),
		...(policy === undefined ? {} : { autoLandPolicy: () => policy }),
		reviewer: {
			ompBin: "/bin/omp-fake",
			systemPromptAppendix: "FLOORS",
			reviewsDir: reviewsDir(),
			run,
			...(extra.git === undefined ? {} : { git: extra.git }),
		},
	});
}

function commitIn(dir: string, file: string): string {
	writeFileSync(join(dir, file), `${file}\n`);
	git(dir, "add", "--", file);
	git(dir, "commit", "-q", "-m", `add ${file}`);
	return git(dir, "rev-parse", "HEAD");
}

function requireLane(h: LaneHarness, name: string): LaneRow {
	const lane = h.store.getLane(name);
	if (lane === undefined) throw new Error(`no lane ${name}`);
	return lane;
}

/** Starts a lane, commits `a.txt` and claims it; `settle` false leaves the background work (the review) running. */
async function closeLane(h: LaneHarness, repo: string, settle = true): Promise<{ lane: LaneRow; sha: string }> {
	const started = await h.manager.start({
		title: "review",
		cwd: repo,
		channel: "D1",
		brief: "a.txt를 만든다",
		acceptance: [CHECK_A],
		risk: "L2",
	});
	await h.settle();
	const sha = commitIn(started.cwd, "a.txt");
	expect(
		await h.manager.claimDone(started.originKey, { repo: started.cwd, commit: "HEAD", summary: "a.txt 추가" }),
	).toContain("검증 통과");
	if (settle) await h.settle();
	return { lane: requireLane(h, started.name), sha };
}

const rootTsOf = (lane: LaneRow): string => parseThreadRef(lane.threadRef)?.threadTs ?? "";
const cardPosts = (transport: WaitingTransport, lane: LaneRow): Post[] =>
	transport.posts().filter((post) => post.threadTs === rootTsOf(lane) && post.ts !== lane.meta.statusTs);
const diffFiles = (lane: LaneRow): string[] =>
	existsSync(reviewsDir()) ? readdirSync(reviewsDir()).filter((entry) => entry.startsWith(`${lane.meta.laneId}-`)) : [];
/** The argument after `flag` in an argv. */
const argOf = (cmd: string[], flag: string): string | undefined => cmd[cmd.indexOf(flag) + 1];
const ISOLATION_FLAGS = ["--no-extensions", "--no-skills", "--no-rules", "--no-context-files"];

/** What the reviewer's isolation looked like when the runner was called (lane-review-isolation AC-2·AC-3). */
interface IsolationSeen {
	cwd: string;
	cwdEntries: string[];
	cwdMode: number;
	configPath: string;
	configMode: number;
	config: unknown;
}

function seeIsolation(call: ReviewCall): IsolationSeen {
	const cwd = call.opts.cwd ?? "";
	const configPath = argOf(call.cmd, "--config") ?? "";
	return {
		cwd,
		cwdEntries: readdirSync(cwd),
		cwdMode: statSync(cwd).mode & 0o777,
		configPath,
		configMode: statSync(configPath).mode & 0o777,
		config: Bun.YAML.parse(readFileSync(configPath, "utf8")),
	};
}

describe("without taskAutoLand.review nothing changes (AC-1)", () => {
	test.each([
		["no review key", { repos: [] as string[], maxRisk: "L2" as const }],
		["no taskAutoLand at all", undefined],
	])("%s: the reviewer is never run", async (_name, policyShape) => {
		const repo = makeRepo(repos);
		const fake = says("VERDICT: CLEAR");
		const counted = countingLand();
		const policy = policyShape === undefined ? undefined : { ...policyShape, repos: [repo] };
		const h = harness(fake.run, policy, { land: counted.land });
		const { lane } = await closeLane(h, repo);
		await h.manager.tick();
		await h.settle();
		expect(fake.calls).toHaveLength(0);
		expect(requireLane(h, lane.name).meta.review).toBeUndefined();
		// With the policy the lane lands as before; without it the card asks.
		expect(counted.calls).toHaveLength(policy === undefined ? 0 : 1);
		expect(cardPosts(h.transport, lane)).toHaveLength(1);
		h.close();
	});
});

describe("review before auto-merge", () => {
	test("AC-2: CLEAR — one run in the worktree with --model and read-only tools, the receipt is stored, the lane lands once", async () => {
		const repo = makeRepo(repos);
		const seen: IsolationSeen[] = [];
		const fake = fakeRunner((call) => {
			seen.push(seeIsolation(call));
			return { code: 0, stdout: "diff가 스펙을 충족한다.\nVERDICT: CLEAR\n", timedOut: false };
		});
		const counted = countingLand();
		const h = harness(fake.run, { repos: [repo], maxRisk: "L2", review: REVIEW }, { land: counted.land });
		const { lane, sha } = await closeLane(h, repo);
		expect(fake.calls).toHaveLength(1);
		const call = fake.calls[0] as ReviewCall;
		// lane-review-isolation AC-2: the cwd is an empty directory under reviewsDir, never the worktree.
		const isolation = reviewIsolationPaths(reviewsDir(), lane, sha);
		expect(call.opts.cwd).not.toBe(lane.meta.worktree);
		expect(call.opts.cwd).toBe(isolation.cwd);
		expect(call.opts.cwd?.startsWith(`${reviewsDir()}/`)).toBe(true);
		expect(seen[0]).toMatchObject({ cwdEntries: [], cwdMode: 0o700, configPath: isolation.configPath });
		const at = call.cmd.indexOf("--no-session");
		expect(call.cmd.slice(at + 1, at + 7)).toEqual(["--config", isolation.configPath, ...ISOLATION_FLAGS]);
		expect(argOf(call.cmd, "--model")).toBe(MODEL);
		expect(argOf(call.cmd, "--tools")).toBe("read,grep,glob");
		expect(call.opts.timeoutMs).toBe(REVIEW.timeoutMs);
		const after = requireLane(h, lane.name);
		expect(after.meta.review).toMatchObject({ sha, verdict: "CLEAR", model: MODEL, notes: "diff가 스펙을 충족한다." });
		expect(after.history.some((entry) => entry.event === "review" && entry.detail === `CLEAR · ${MODEL}`)).toBe(true);
		expect(counted.calls).toHaveLength(1);
		expect(after.meta.land?.state).toBe("landed");
		const cards = cardPosts(h.transport, lane);
		expect(cards).toHaveLength(1);
		expect(cards[0]?.text).toContain(`🔎 독립 리뷰 CLEAR · ${MODEL}`);
		// AC-12: the landing removed the review's diff file.
		expect(diffFiles(lane)).toEqual([]);
		await h.manager.tick();
		await h.settle();
		expect(fake.calls).toHaveLength(1);
		h.close();
	});

	test("AC-3·AC-7·AC-12: BLOCK — no landing, the card asks and quotes the findings; the owner's 머지 still lands and the diff file goes", async () => {
		const repo = makeRepo(repos);
		const fake = says("src/a.ts:3 — 테스트를 지웠다\nVERDICT: BLOCK");
		const counted = countingLand();
		const h = harness(fake.run, { repos: [repo], maxRisk: "L2", review: REVIEW }, { land: counted.land });
		const { lane, sha } = await closeLane(h, repo);
		expect(fake.calls).toHaveLength(1);
		expect(counted.calls).toHaveLength(0);
		const blocked = requireLane(h, lane.name);
		expect(blocked.meta.review).toMatchObject({ sha, verdict: "BLOCK" });
		expect(blocked.meta.land?.state).toBe("pending");
		const cards = cardPosts(h.transport, lane);
		expect(cards).toHaveLength(1);
		expect(cards[0]?.text).toContain("자동 머지 안 함: 독립 리뷰 BLOCK");
		expect(cards[0]?.text).toContain("*리뷰 지적*");
		expect(cards[0]?.text).toContain("테스트를 지웠다");
		expect(JSON.stringify(cards[0]?.blocks ?? [])).toContain(`ompbot:lane:merge:${lane.name}`);
		const files = diffFiles(lane);
		expect(files).toEqual([`${lane.meta.laneId}-${sha.slice(0, 12)}.diff`]);

		const outcome = await h.manager.requestLand(lane.name, "owner");
		await h.settle();
		expect(outcome.handled).toBe(true);
		expect(counted.calls).toHaveLength(1);
		expect(requireLane(h, lane.name).meta.land?.state).toBe("landed");
		expect(diffFiles(lane)).toEqual([]);
		h.close();
	});

	test.each([
		["timed out", { code: null, stdout: "절반", timedOut: true }, "시간 초과"],
		["exit code 1", { code: 1, stdout: "boom\nVERDICT: CLEAR", timedOut: false }, "종료 코드 1"],
		["no VERDICT line", { code: 0, stdout: "다 좋아 보입니다", timedOut: false }, "VERDICT 없음"],
		[
			"two VERDICT lines",
			{ code: 0, stdout: "VERDICT: BLOCK\n다시 보니\nVERDICT: CLEAR", timedOut: false },
			"VERDICT 여러 줄",
		],
	])("AC-4: %s is inconclusive and nothing lands", async (_name, result, reason) => {
		const repo = makeRepo(repos);
		const fake = fakeRunner(() => result);
		const counted = countingLand();
		const h = harness(fake.run, { repos: [repo], maxRisk: "L2", review: REVIEW }, { land: counted.land });
		const { lane, sha } = await closeLane(h, repo);
		expect(fake.calls).toHaveLength(1);
		expect(requireLane(h, lane.name).meta.review).toMatchObject({ sha, verdict: "inconclusive", reason });
		expect(counted.calls).toHaveLength(0);
		expect(requireLane(h, lane.name).meta.land?.state).toBe("pending");
		expect(cardPosts(h.transport, lane)[0]?.text).toContain(`독립 리뷰 확인 불가(${reason})`);
		h.close();
	});

	test("AC-5: a receipt for the same commit is not reviewed again when the lane is announced again after a restart", async () => {
		const repo = makeRepo(repos);
		const fake = says("src/a.ts:1 — 범위 밖\nVERDICT: BLOCK");
		const policy = { repos: [repo], maxRisk: "L2" as const, review: REVIEW };
		const first = harness(fake.run, policy);
		// The Outcome card cannot be posted: the lane stays without a card for the next announce.
		const post = first.transport.postMessage.bind(first.transport);
		first.transport.postMessage = async (args) => {
			if (args.text.includes("머지 대기")) throw new Error("slack down");
			return post(args);
		};
		const { lane, sha } = await closeLane(first, repo);
		expect(fake.calls).toHaveLength(1);
		expect(requireLane(first, lane.name).meta.review).toMatchObject({ sha, verdict: "BLOCK" });
		expect(requireLane(first, lane.name).meta.land?.cardTs).toBeUndefined();
		first.close();

		const second = harness(fake.run, policy);
		await second.manager.tick();
		await second.settle();
		expect(fake.calls).toHaveLength(1);
		const shown = requireLane(second, lane.name);
		expect(shown.meta.land?.cardTs).toBeDefined();
		expect(cardPosts(second.transport, shown)[0]?.text).toContain("독립 리뷰 BLOCK");
		await second.manager.tick();
		await second.settle();
		expect(fake.calls).toHaveLength(1);
		second.close();
	});

	test("AC-6: a receipt of another commit is no receipt; the auto request re-checks right before landing", async () => {
		const repo = makeRepo(repos);
		const fake = says("VERDICT: BLOCK");
		const counted = countingLand();
		const policy = { repos: [repo], maxRisk: "L2" as const, review: REVIEW };
		const h = harness(fake.run, policy, { land: counted.land });
		const { lane, sha } = await closeLane(h, repo);
		const clear = { sha, verdict: "CLEAR" as const, model: MODEL, at: 0, notes: "" };
		const cleared = { ...lane, meta: { ...lane.meta, review: clear } };
		expect(laneLandBlockers(cleared, policy, true, false)).toEqual([]);
		const stale = { ...lane, meta: { ...lane.meta, review: { ...clear, sha: "0".repeat(40) } } };
		expect(laneLandBlockers(stale, policy, true, false)).toEqual(["독립 리뷰 없음"]);
		const none = { ...lane, meta: { ...lane.meta, review: undefined } };
		expect(laneLandBlockers(none, policy, true, false)).toEqual(["독립 리뷰 없음"]);
		expect(laneLandBlockers(none, { repos: [repo], maxRisk: "L2" }, true, false)).toEqual([]);

		// The BLOCK receipt stands: an auto request lands nothing and the card keeps asking with the reason.
		const outcome = await h.manager.requestLand(lane.name, "auto");
		await h.settle();
		expect(outcome.text).toContain("독립 리뷰 BLOCK");
		expect(counted.calls).toHaveLength(0);
		const after = requireLane(h, lane.name);
		expect(after.meta.land).toMatchObject({ state: "pending" });
		expect(after.meta.land?.requestedBy).toBeUndefined();
		h.close();
	});

	test("AC-10: stop() aborts the running review and no receipt is stored", async () => {
		const repo = makeRepo(repos);
		const started = Promise.withResolvers<AbortSignal>();
		const fake = fakeRunner(({ opts }) => {
			const signal = opts.signal as AbortSignal;
			started.resolve(signal);
			const ended = Promise.withResolvers<RunProcessResult>();
			signal.addEventListener("abort", () => ended.resolve({ code: null, stdout: "", timedOut: false }));
			return ended.promise;
		});
		const counted = countingLand();
		const h = harness(fake.run, { repos: [repo], maxRisk: "L2", review: REVIEW }, { land: counted.land });
		const { lane } = await closeLane(h, repo, false);
		const signal = await started.promise;
		expect(signal.aborted).toBe(false);
		h.manager.stop();
		expect(signal.aborted).toBe(true);
		await h.settle();
		const after = requireLane(h, lane.name);
		expect(after.meta.review).toBeUndefined();
		expect(after.history.some((entry) => entry.event === "review")).toBe(false);
		expect(counted.calls).toHaveLength(0);
		expect(cardPosts(h.transport, lane)).toHaveLength(0);
		h.close();
	});

	test("AC-11: the tick returns while the review runs; the result then lands the lane", async () => {
		const repo = makeRepo(repos);
		const called = Promise.withResolvers<void>();
		const answer = Promise.withResolvers<RunProcessResult>();
		const fake = fakeRunner(() => {
			called.resolve();
			return answer.promise;
		});
		const counted = countingLand();
		const h = harness(fake.run, { repos: [repo], maxRisk: "L2", review: REVIEW }, { land: counted.land });
		const { lane } = await closeLane(h, repo, false);
		await called.promise;
		await h.manager.tick();
		await h.manager.tick();
		expect(fake.calls).toHaveLength(1);
		expect(cardPosts(h.transport, lane)).toHaveLength(0);
		expect(counted.calls).toHaveLength(0);

		answer.resolve({ code: 0, stdout: "VERDICT: CLEAR", timedOut: false });
		await h.settle();
		expect(counted.calls).toHaveLength(1);
		expect(requireLane(h, lane.name).meta.land?.state).toBe("landed");
		h.close();
	});

	test("AC-11·AC-12: after !reopen the second review diffs from merge-base <baseBranch> <sha>, not from the old claim; reopen drops the receipt and diff file", async () => {
		const repo = makeRepo(repos);
		const base = git(repo, "symbolic-ref", "--short", "HEAD");
		const forkPoint = git(repo, "rev-parse", "HEAD");
		const calls: string[][] = [];
		const recording: GitRunner = (args) => {
			calls.push(args);
			return defaultGit(args);
		};
		let verdict = "VERDICT: BLOCK";
		const fake = fakeRunner(() => ({ code: 0, stdout: verdict, timedOut: false }));
		const counted = countingLand();
		const h = harness(
			fake.run,
			{ repos: [repo], maxRisk: "L2", review: REVIEW },
			{ git: recording, land: counted.land },
		);
		const { lane, sha: first } = await closeLane(h, repo);
		expect(diffFiles(lane)).toHaveLength(1);

		h.manager.onOwnerMessage(requireLane(h, lane.name), "!reopen b.txt도 추가");
		await h.settle();
		const reopened = requireLane(h, lane.name);
		expect(reopened.status).toBe("working");
		expect(reopened.meta.baseSha).toBe(first);
		expect(reopened.meta.review).toBeUndefined();
		expect(diffFiles(lane)).toEqual([]);

		verdict = "VERDICT: CLEAR";
		calls.length = 0;
		const second = commitIn(reopened.cwd, "b.txt");
		await h.manager.claimDone(reopened.originKey, { repo: reopened.cwd, commit: "HEAD", summary: "b.txt 추가" });
		await h.settle();
		expect(fake.calls).toHaveLength(2);
		const mergeBase = calls.filter((args) => args.includes("merge-base"));
		expect(mergeBase).toEqual([["-C", lane.meta.repo ?? "", "merge-base", `refs/heads/${base}`, second]]);
		const diffs = calls.filter((args) => args.includes("diff"));
		expect(diffs).toHaveLength(2);
		for (const args of diffs) expect(args.at(-1)).toBe(`${forkPoint}..${second}`);
		expect(calls.flat().some((arg) => arg.includes(first))).toBe(false);
		// The prompt holds both commits' work.
		const prompt = fake.calls[1]?.cmd.at(-1) ?? "";
		expect(prompt).toContain("a.txt");
		expect(prompt).toContain("b.txt");
		expect(counted.calls).toHaveLength(1);
		h.close();
	});

	test("AC-12: a discarded lane's diff file is gone", async () => {
		const repo = makeRepo(repos);
		const fake = says("VERDICT: BLOCK");
		const h = harness(fake.run, { repos: [repo], maxRisk: "L2", review: REVIEW });
		const { lane, sha } = await closeLane(h, repo);
		expect(diffFiles(lane)).toHaveLength(1);
		// lane-review-isolation AC-6: a leftover overlay and cwd (a killed daemon's) go with it, the cwd recursively.
		const leftover = reviewIsolationPaths(reviewsDir(), lane, sha);
		writeFileSync(leftover.configPath, "x");
		mkdirSync(join(leftover.cwd, "sub"), { recursive: true });
		writeFileSync(join(leftover.cwd, "sub", "f"), "x");
		expect(diffFiles(lane)).toHaveLength(3);
		expect((await h.manager.discard(lane.name)).handled).toBe(true);
		expect(requireLane(h, lane.name).meta.land?.state).toBe("discarded");
		expect(diffFiles(lane)).toEqual([]);
		h.close();
	});
});

describe("reviewLane: the prompt and the diff file (AC-8)", () => {
	const SHA = "c".repeat(40);
	const lane = (over: Partial<LaneRow["meta"]> = {}): LaneRow => ({
		name: "review",
		title: "리뷰 제목",
		threadRef: "D1:1.0",
		originKey: "ompbot/work/review",
		cwd: "/wt",
		sessionDir: "/s",
		status: "closed",
		history: [],
		createdAt: 0,
		updatedAt: 0,
		meta: {
			startedAt: 0,
			lastProgressAt: 0,
			steerSeq: 0,
			sha: SHA,
			baseSha: "b".repeat(40),
			laneId: "L-20270115-01",
			repo: "/repo",
			worktree: "/wt",
			baseBranch: "main",
			brief: "브리프 본문",
			acceptance: [{ id: "AC-1", text: "수락기준 하나" }],
			checks: { head: SHA, results: [{ id: "AC-1", signal: "s", ok: true, detail: "통과 상세" }] },
			claim: { repo: "/wt", commit: SHA, summary: "구현자 요약", claimedAt: 0 },
			...over,
		},
	});

	function fakeGit(diff: string): { git: GitRunner; calls: string[][] } {
		const calls: string[][] = [];
		return {
			calls,
			git: async (args) => {
				calls.push(args);
				if (args.includes("merge-base")) return { code: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
				if (args.includes("--stat")) return { code: 0, stdout: " a.ts | 1 +\n", stderr: "" };
				return { code: 0, stdout: diff, stderr: "" };
			},
		};
	}

	const deps = (git: GitRunner, run: ProcessRunner) => ({
		ompBin: "/bin/omp-fake",
		systemPromptAppendix: "FLOORS",
		reviewsDir: reviewsDir(),
		headOf: async () => ({ sha: SHA, clean: true }),
		now: () => 1,
		git,
		run,
	});

	test("omp-isolation AC-2: the reviewer runs in the bot's ompProfile, without the inherited agent dir", async () => {
		const fake = says("VERDICT: CLEAR");
		await reviewLane(
			{ lane: lane(), model: MODEL, timeoutMs: 1000 },
			{
				...deps(fakeGit("+x\n").git, fake.run),
				ompProfile: "ompbot",
				inheritedEnv: { PATH: "/usr/bin", PI_CODING_AGENT_DIR: "/custom/agent" },
			},
		);
		expect(fake.calls[0]?.opts.env?.OMP_PROFILE).toBe("ompbot");
		expect(fake.calls[0]?.opts.env).not.toHaveProperty("PI_CODING_AGENT_DIR");
	});

	test("the four sections come in order: spec → diff → checks → the lane's report", async () => {
		const fake = says("VERDICT: CLEAR");
		const receipt = await reviewLane(
			{ lane: lane(), model: MODEL, timeoutMs: 1000 },
			deps(fakeGit("+marker-line\n").git, fake.run),
		);
		expect(receipt.verdict).toBe("CLEAR");
		const prompt = fake.calls[0]?.cmd.at(-1) ?? "";
		const at = [
			prompt.indexOf(REVIEW_SECTIONS.spec),
			prompt.indexOf("브리프 본문"),
			prompt.indexOf("수락기준 하나"),
			prompt.indexOf(REVIEW_SECTIONS.diff),
			prompt.indexOf("+marker-line"),
			prompt.indexOf(REVIEW_SECTIONS.checks),
			prompt.indexOf("통과 상세"),
			prompt.indexOf(REVIEW_SECTIONS.claim),
			prompt.indexOf("구현자 요약"),
		];
		expect(at.every((index) => index >= 0)).toBe(true);
		expect([...at].sort((a, b) => a - b)).toEqual(at);
		// A short diff is whole in the prompt: no pointer to the file.
		expect(prompt).not.toContain(reviewsDir());
	});

	test("a diff over 60000 characters is cut, the prompt names the diff file, and the file is 0600 in a 0700 directory", async () => {
		const fake = says("VERDICT: CLEAR");
		const big = `${"+x\n".repeat(30_000)}+tail-marker\n`;
		await reviewLane({ lane: lane(), model: MODEL, timeoutMs: 1000 }, deps(fakeGit(big).git, fake.run));
		const prompt = fake.calls[0]?.cmd.at(-1) ?? "";
		const path = join(reviewsDir(), `L-20270115-01-${SHA.slice(0, 12)}.diff`);
		expect(prompt).toContain(path);
		expect(prompt).not.toContain("tail-marker");
		expect(prompt.length).toBeLessThan(big.length);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(reviewsDir()).mode & 0o777).toBe(0o700);
		expect(await Bun.file(path).text()).toContain("tail-marker");
		// The prompt's diff block holds at most REVIEW_DIFF_PROMPT_MAX characters.
		const block = buildReviewPrompt({ lane: lane(), diff: big, diffPath: path });
		const diffPart = block.slice(block.indexOf("```diff\n") + 8, block.indexOf("\n```", block.indexOf("```diff\n")));
		expect(diffPart.length).toBeLessThanOrEqual(REVIEW_DIFF_PROMPT_MAX);
	});

	test("lane-review-isolation AC-3: the overlay is 0600 at the call, disables discovery and persistent state; one run", async () => {
		const seen: IsolationSeen[] = [];
		const fake = fakeRunner((call) => {
			seen.push(seeIsolation(call));
			return { code: 0, stdout: "VERDICT: CLEAR", timedOut: false };
		});
		await reviewLane({ lane: lane(), model: MODEL, timeoutMs: 1000 }, deps(fakeGit("+x\n").git, fake.run));
		expect(fake.calls).toHaveLength(1);
		const path = join(reviewsDir(), `L-20270115-01-${SHA.slice(0, 12)}.omp.yml`);
		expect(seen[0]?.configPath).toBe(path);
		expect(seen[0]?.configMode).toBe(0o600);
		expect(seen[0]?.config).toMatchObject({
			disabledProviders: [...REVIEW_DISABLED_DISCOVERY],
			mcp: { enableProjectConfig: false },
			autolearn: { enabled: false },
			memory: { backend: "off" },
			// review confidence AC-4: the reviewer answers with its --model only.
			retry: { modelFallback: false },
		});
		expect(seen[0]?.config).toHaveProperty("disabledProviders", [...REVIEW_DISABLED_DISCOVERY]);
	});

	test("lane-review-isolation AC-5: the prompt names the worktree's absolute path and tells grep·glob to pass it as path", async () => {
		const fake = says("VERDICT: CLEAR");
		await reviewLane(
			{ lane: lane({ worktree: "/abs/work/tree-1" }), model: MODEL, timeoutMs: 1000 },
			deps(fakeGit("+x\n").git, fake.run),
		);
		const prompt = fake.calls[0]?.cmd.at(-1) ?? "";
		expect(prompt).toContain("/abs/work/tree-1의 파일을 read·grep·glob으로 확인");
		expect(prompt).toContain("grep·glob을 부를 때는 path에 반드시 위 worktree 절대경로(/abs/work/tree-1)를 넘겨라");
		const at = Object.values(REVIEW_SECTIONS).map((section) => prompt.indexOf(section));
		expect(at.every((index) => index >= 0)).toBe(true);
		expect([...at].sort((a, b) => a - b)).toEqual(at);
	});

	test.each([
		["CLEAR", () => ({ code: 0, stdout: "VERDICT: CLEAR", timedOut: false }), "CLEAR"],
		["BLOCK", () => ({ code: 0, stdout: "VERDICT: BLOCK", timedOut: false }), "BLOCK"],
		["timeout", () => ({ code: null, stdout: "절반", timedOut: true }), "inconclusive"],
		["abort", "abort", "inconclusive"],
		["a runner that throws", "throw", "inconclusive"],
	] as const)("lane-review-isolation AC-6: after %s the overlay and the cwd are gone", async (_name, end, verdict) => {
		const abort = new AbortController();
		const isolation = reviewIsolationPaths(reviewsDir(), lane(), SHA);
		const fake = fakeRunner((call) => {
			expect(existsSync(isolation.configPath)).toBe(true);
			expect(call.opts.cwd).toBe(isolation.cwd);
			// Something the reviewer left in its cwd is removed with it.
			writeFileSync(join(isolation.cwd, "left.txt"), "x");
			if (end === "throw") throw new Error("spawn boom");
			if (end === "abort") {
				abort.abort();
				return { code: null, stdout: "", timedOut: false };
			}
			return end();
		});
		const receipt = await reviewLane(
			{ lane: lane(), model: MODEL, timeoutMs: 1000, signal: abort.signal },
			deps(fakeGit("+x\n").git, fake.run),
		);
		expect(fake.calls).toHaveLength(1);
		expect(receipt.verdict).toBe(verdict);
		expect(existsSync(isolation.configPath)).toBe(false);
		expect(existsSync(isolation.cwd)).toBe(false);
		expect(readdirSync(reviewsDir())).toEqual([`L-20270115-01-${SHA.slice(0, 12)}.diff`]);
	});

	test("no merge-base and a worktree off the claim are inconclusive without running the reviewer", async () => {
		const fake = says("VERDICT: CLEAR");
		const noBase: GitRunner = async () => ({ code: 1, stdout: "", stderr: "fatal" });
		const lost = await reviewLane({ lane: lane(), model: MODEL, timeoutMs: 1000 }, deps(noBase, fake.run));
		expect(lost).toMatchObject({ verdict: "inconclusive", reason: "diff 기준점 없음", sha: SHA });
		const moved = await reviewLane(
			{ lane: lane(), model: MODEL, timeoutMs: 1000 },
			{ ...deps(fakeGit("").git, fake.run), headOf: async () => ({ sha: "d".repeat(40), clean: true }) },
		);
		expect(moved.verdict).toBe("inconclusive");
		expect(fake.calls).toHaveLength(0);
	});
});

describe("review confidence (doc/plans/lane-review-confidence.md)", () => {
	test.each([
		["present", "지적 하나\nCONFIDENCE: 0.92\nVERDICT: CLEAR", "CLEAR", 0.92, "지적 하나"],
		["present after a blank line", "지적\nCONFIDENCE: 0.9 \n\nVERDICT: BLOCK\n", "BLOCK", 0.9, "지적"],
		["1", "CONFIDENCE: 1\nVERDICT: CLEAR", "CLEAR", 1, ""],
		["1.00", "CONFIDENCE:1.00\nVERDICT: CLEAR", "CLEAR", 1, ""],
		["0", "CONFIDENCE: 0\nVERDICT: BLOCK", "BLOCK", 0, ""],
		["absent", "지적 하나\nVERDICT: BLOCK", "BLOCK", undefined, "지적 하나"],
		["a percentage", "지적\nCONFIDENCE: 92%\nVERDICT: CLEAR", "CLEAR", undefined, "지적"],
		["above 1", "지적\nCONFIDENCE: 1.5\nVERDICT: CLEAR", "CLEAR", undefined, "지적"],
		["no leading digit", "지적\nCONFIDENCE: .9\nVERDICT: CLEAR", "CLEAR", undefined, "지적"],
		["a word", "지적\nCONFIDENCE: high\nVERDICT: CLEAR", "CLEAR", undefined, "지적"],
		["two lines", "CONFIDENCE: 0.5\n지적\nCONFIDENCE: 0.9\nVERDICT: CLEAR", "CLEAR", undefined, "지적"],
		["not right above VERDICT", "CONFIDENCE: 0.9\n지적\nVERDICT: CLEAR", "CLEAR", undefined, "지적"],
	] as const)("AC-3: CONFIDENCE %s", (_name, output, verdict, confidence, notes) => {
		const parsed = parseReviewVerdict(output);
		expect(parsed).toEqual({ verdict, notes, ...(confidence === undefined ? {} : { confidence }) });
	});

	test("AC-3: a malformed CONFIDENCE never makes the verdict inconclusive, and VERDICT rules stay", () => {
		expect(parseReviewVerdict("CONFIDENCE: 0.9\nVERDICT: CLEAR\nCONFIDENCE: 0.9")).toEqual({ reason: "VERDICT 없음" });
		expect(parseReviewVerdict("CONFIDENCE: x\nCONFIDENCE: y\nVERDICT: BLOCK")).toEqual({ verdict: "BLOCK", notes: "" });
	});

	test("AC-3: the prompt asks for the CONFIDENCE line; the receipt keeps its value and notes drop the line", async () => {
		const repo = makeRepo(repos);
		const fake = says("지적 없음\nCONFIDENCE: 0.8\nVERDICT: BLOCK");
		const h = harness(fake.run, { repos: [repo], maxRisk: "L2", review: REVIEW });
		const { lane, sha } = await closeLane(h, repo);
		expect(fake.calls[0]?.cmd.at(-1)).toContain("마지막 줄 바로 위에는 `CONFIDENCE: <0.00~1.00>` 한 줄을 쓴다.");
		const after = requireLane(h, lane.name);
		expect(after.meta.review).toMatchObject({ sha, verdict: "BLOCK", confidence: 0.8, notes: "지적 없음" });
		expect(after.history.some((entry) => entry.event === "review" && entry.detail === `BLOCK 0.80 · ${MODEL}`)).toBe(
			true,
		);
		h.close();
	});

	test("AC-4: only the reviewer's overlay turns the model fallback off; the guest/qa overlay keeps it", () => {
		expect(Bun.YAML.parse(REVIEW_OVERLAY_YAML)).toMatchObject({ retry: { modelFallback: false } });
		expect(REVIEW_OVERLAY_YAML).toContain("modelFallback: false");
		expect(GUEST_OVERLAY_YAML).not.toContain("modelFallback");
		expect(Bun.YAML.parse(GUEST_OVERLAY_YAML)).not.toHaveProperty("retry");
		expect(REVIEW_OVERLAY_YAML.startsWith(GUEST_OVERLAY_YAML)).toBe(true);
	});
});

describe("through the daemon: #autoLandPolicy hands taskAutoLand.review to the lanes (AC-12)", () => {
	test("the configured model and the default timeout reach the reviewer", async () => {
		const repo = makeRepo(repos);
		const transport = new WaitingTransport();
		const called = Promise.withResolvers<ReviewCall>();
		const fake = fakeRunner((call) => {
			called.resolve(call);
			return { code: 0, stdout: "VERDICT: CLEAR", timedOut: false };
		});
		const sessions = new FakeSessionStore();
		const clock = { now: () => Date.now() };
		const daemon = new Daemon({
			config: { ...home.config, taskAutoLand: { repos: [repo], review: { model: "daemon/model" } } },
			channels: [new SlackBinding(new SlackChannel(transport))],
			log: createLogger({ sink: () => {}, clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			landLane: async () => ({ state: "landed", preSha: "unknown" }),
			laneReviewRun: fake.run,
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		daemons.push(daemon);
		await daemon.start();
		const signal = new AbortController().signal;
		const start = daemon.hostToolsFor("slack/dm/D1").find((tool) => tool.name === "ompbot_work_start");
		await start?.execute(
			{ title: "daemon-review", cwd: repo, brief: "데몬 브리프", acceptance: [CHECK_A], risk: "L2" },
			{ signal },
		);
		const lane = daemon.store.getLane("daemon-review");
		if (lane === undefined) throw new Error("no lane");
		expect(lane.meta.brief).toBe("데몬 브리프");
		commitIn(lane.cwd, "a.txt");
		const claim = daemon.hostToolsFor(lane.originKey).find((tool) => tool.name === "ompbot_claim_done");
		expect(await claim?.execute({ repo: lane.cwd, commit: "HEAD", summary: "a.txt 추가" }, { signal })).toContain(
			"검증 통과",
		);
		const call = await called.promise;
		expect(argOf(call.cmd, "--model")).toBe("daemon/model");
		expect(call.opts.timeoutMs).toBe(600_000);
		expect(call.cmd.at(-1)).toContain("데몬 브리프");
		// The CLEAR receipt makes the card the auto-merge one (the landing itself is lane-land's subject).
		await transport.waitForPosts((text) => text.includes("독립 리뷰 CLEAR"));
		expect(transport.posts((text) => text.includes("자동 머지 ·"))).toHaveLength(1);
		expect(daemon.store.getLane("daemon-review")?.meta.review).toMatchObject({
			verdict: "CLEAR",
			model: "daemon/model",
		});
	});

	test("review confidence AC-7: review.confident reaches the lanes — explicit L3 is reviewed and auto-merged on CLEAR 0.90; no risk and L4 ask unreviewed", async () => {
		const repo = makeRepo(repos);
		const transport = new WaitingTransport();
		const fake = fakeRunner(() => ({ code: 0, stdout: "확인함\nCONFIDENCE: 0.90\nVERDICT: CLEAR", timedOut: false }));
		const sessions = new FakeSessionStore();
		const clock = { now: () => Date.now() };
		const landed: string[] = [];
		const daemon = new Daemon({
			config: {
				...home.config,
				taskAutoLand: {
					repos: [repo],
					review: { model: "daemon/model", confident: { maxRisk: "L3", minConfidence: 0.85 } },
				},
			},
			channels: [new SlackBinding(new SlackChannel(transport))],
			log: createLogger({ sink: () => {}, clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			landLane: async (request) => {
				landed.push(request.branch);
				return { state: "landed", preSha: "unknown" };
			},
			laneReviewRun: fake.run,
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		daemons.push(daemon);
		await daemon.start();
		const signal = new AbortController().signal;
		const start = daemon.hostToolsFor("slack/dm/D1").find((tool) => tool.name === "ompbot_work_start");
		const closeWith = async (title: string, risk: string | undefined): Promise<LaneRow> => {
			await start?.execute(
				{ title, cwd: repo, brief: `${title} 브리프`, acceptance: [CHECK_A], ...(risk === undefined ? {} : { risk }) },
				{ signal },
			);
			const lane = daemon.store.getLane(title);
			if (lane === undefined) throw new Error(`no lane ${title}`);
			commitIn(lane.cwd, "a.txt");
			const claim = daemon.hostToolsFor(lane.originKey).find((tool) => tool.name === "ompbot_claim_done");
			expect(await claim?.execute({ repo: lane.cwd, commit: "HEAD", summary: "a.txt 추가" }, { signal })).toContain(
				"검증 통과",
			);
			return lane;
		};

		const unrated = await closeWith("confident-none", undefined);
		expect(unrated.meta.risk).toBeUndefined();
		await transport.waitForPosts((text) => text.includes("머지 대기 · confident-none"));
		const l4 = await closeWith("confident-l4", "L4");
		await transport.waitForPosts((text) => text.includes("머지 대기 · confident-l4"));
		expect(fake.calls).toHaveLength(0);
		for (const [title, risk] of [
			["confident-none", "L3"],
			["confident-l4", "L4"],
		] as const) {
			const [card] = transport.posts((text) => text.includes(`머지 대기 · ${title}`));
			expect(card?.text).toContain(`자동 머지 안 함: 위험 ${risk} > L2`);
			expect(card?.text).not.toContain("독립 리뷰");
			expect(daemon.store.getLane(title)?.meta.review).toBeUndefined();
		}
		expect(l4.meta.risk).toBe("L4");

		await closeWith("confident-l3", "L3");
		await transport.waitForPosts((text) => text.includes("자동 머지 · confident-l3"));
		expect(fake.calls).toHaveLength(1);
		expect(argOf(fake.calls[0]?.cmd ?? [], "--model")).toBe("daemon/model");
		expect(fake.calls[0]?.cmd.at(-1)).toContain("confident-l3 브리프");
		const [auto] = transport.posts((text) => text.includes("자동 머지 · confident-l3"));
		expect(auto?.text).toContain("🔎 독립 리뷰 CLEAR 0.90 · daemon/model");
		expect(daemon.store.getLane("confident-l3")?.meta.review).toMatchObject({ verdict: "CLEAR", confidence: 0.9 });
		expect(transport.posts((text) => text.includes("머지 대기 · confident-l3"))).toHaveLength(0);
		expect(fake.calls).toHaveLength(1);
	});
});
