// Lane board (doc/plans/lane-board.md): channels, subscriptions and read cursors over the real store, the turn-prompt
// head line through the real mailbox with fake omp drivers, the lane start prompt and the daemon's tool sets.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OriginMailbox } from "../src/core/mailbox";
import { OriginRouter, openBotStore } from "../src/core/origin";
import { CURRENT_REQUEST_MARKER, type InboundRecord, isTurnPromptFor } from "../src/core/types";
import { Daemon } from "../src/daemon/daemon";
import { BOARD_GENERAL, boardNoticeFor, boardRepoChannel, buildBoardTools } from "../src/lanes/board";
import { laneOriginKey } from "../src/lanes/status";
import { createLogger } from "../src/log";
import { OmpDriverError } from "../src/omp/driver";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { PEER_TOOL_DENIED } from "../src/safety/host-tools";
import { buildFloorsPrompt, peerTouchedTurnNotice } from "../src/safety/prompt";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import { LANE_BOARD_TEXT_MAX, type Store } from "../src/store/db";
import { makeHome, type TestHome, WaitingTransport } from "./helpers/bot-home";
import { makeRepo } from "./helpers/git-fixtures";
import { laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

const REPO_1 = "/work/repo-one";
const REPO_2 = "/work/repo-two";
const OWNER_DM = "slack/dm/D0BOARD001";
const FENCE = "f".repeat(16);
const signal = new AbortController().signal;

let dir: string;
let store: Store;
let clockNow: number;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-lane-board-"));
	clockNow = 1_800_000_000_000;
	store = openBotStore(join(dir, "ompbot.db"), { now: () => clockNow }, "Asia/Seoul");
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

/** A working lane row of `repo` (or none: an old lane without `meta.repo`). */
function addLane(name: string, repo: string | undefined): string {
	const originKey = laneOriginKey(name);
	store.insertLane({
		name,
		title: `${name} title`,
		threadRef: `C0BOARD001:${name}`,
		originKey,
		cwd: repo ?? "/work/plain",
		sessionDir: join(dir, "sessions", name),
		meta: { startedAt: clockNow, lastProgressAt: clockNow, steerSeq: 0, ...(repo === undefined ? {} : { repo }) },
	});
	return originKey;
}

function closeLane(name: string): void {
	store.transitionLane(name, "done-claimed", { event: "claim" });
	store.transitionLane(name, "closed", { event: "closed" });
}

/** The two board tools of `originKey` as plain calls. */
function board(originKey: string) {
	const [post, read] = buildBoardTools(store, originKey, () => FENCE);
	if (post === undefined || read === undefined) throw new Error("board tools missing");
	return {
		post: (params: Record<string, unknown>) => post.execute(params, { signal }),
		read: (params: Record<string, unknown> = {}) => read.execute(params, { signal }),
	};
}

/** Post ids a read returned, in order. */
const ids = (text: string): number[] => [...text.matchAll(/^#(\d+) /gm)].map((match) => Number(match[1]));

describe("lane board channels and reads", () => {
	test("AC-1: a lane's repo post reaches the same-repo lane only; general reaches all three", async () => {
		const a = addLane("lane-a", REPO_1);
		const b = addLane("lane-b", REPO_1);
		const c = addLane("lane-c", REPO_2);
		expect(await board(a).post({ text: "src/x.ts 고치는 중" })).toBe(`posted #1 to ${boardRepoChannel(REPO_1)}`);
		await board(a).post({ text: "모두에게", channel: BOARD_GENERAL });

		const readB = await board(b).read();
		expect(ids(readB)).toEqual([1, 2]);
		expect(readB).toContain("src/x.ts 고치는 중");
		const readC = await board(c).read();
		expect(ids(readC)).toEqual([2]);
		expect(readC).not.toContain("src/x.ts");
		// The author does not read its own posts back as new.
		expect(await board(a).read()).toStartWith("no new posts");
	});

	test("AC-2: the owner conversation writes general for the lanes and reads a lane's repo post, all wrapped as quotes", async () => {
		const a = addLane("lane-a", REPO_1);
		const b = addLane("lane-b", REPO_2);
		expect(await board(OWNER_DM).post({ text: "오늘은 배포 금지" })).toBe("posted #1 to general");
		for (const lane of [a, b]) {
			const read = await board(lane).read();
			expect(read).toContain(
				`<<<quoted-${FENCE}>>>\n#1 general · main:${OWNER_DM}\n오늘은 배포 금지\n<<<end-quoted-${FENCE}>>>`,
			);
		}
		await board(a).post({ text: "API 바뀜" });
		const read = await board(OWNER_DM).read();
		expect(ids(read)).toEqual([2]);
		expect(read).toContain(
			`<<<quoted-${FENCE}>>>\n#2 ${boardRepoChannel(REPO_1)} · lane-a\nAPI 바뀜\n<<<end-quoted-${FENCE}>>>`,
		);
	});

	test("AC-3: limit 2 of 5 marks two read; the next default read returns the other three", async () => {
		const a = addLane("lane-a", REPO_1);
		const b = addLane("lane-b", REPO_1);
		for (let i = 1; i <= 5; i++) await board(a).post({ text: `글 ${i}` });
		const first = await board(b).read({ limit: 2 });
		expect(ids(first)).toEqual([1, 2]);
		expect(first).toContain("More remain");
		expect(store.laneBoardCursor(b, boardRepoChannel(REPO_1)).lastRead).toBe(2);
		const rest = await board(b).read();
		expect(ids(rest)).toEqual([3, 4, 5]);
		expect(rest).not.toContain("More remain");
		expect(await board(b).read()).toStartWith("no new posts");
		// `after` reads back what was read already.
		expect(ids(await board(b).read({ after: 3 }))).toEqual([4, 5]);
	});

	test("AC-7: channels outside the open set, bad forms and a replyTo of another channel are tool errors", async () => {
		const a = addLane("lane-a", REPO_1);
		addLane("lane-gone", REPO_2);
		closeLane("lane-gone");
		await expect(board(a).post({ text: "x", channel: "repo:/nope" })).rejects.toThrow(/not open to this session/);
		await expect(board(a).post({ text: "x", channel: boardRepoChannel(REPO_2) })).rejects.toThrow(
			/not open to this session/,
		);
		for (const channel of ["random", "repo:relative/path", "General", ""]) {
			await expect(board(a).post({ text: "x", channel })).rejects.toThrow(/channel must be/);
		}
		await expect(board(a).read({ channel: "repo:/nope" })).rejects.toThrow(/not open to this session/);
		await board(a).post({ text: "in general", channel: BOARD_GENERAL });
		await expect(board(a).post({ text: "reply", replyTo: 1 })).rejects.toThrow(/replyTo #1 is not a post of/);
		await expect(board(a).post({ text: "reply", replyTo: 99, channel: BOARD_GENERAL })).rejects.toThrow(/replyTo #99/);
		expect(await board(a).post({ text: "reply", replyTo: 1, channel: BOARD_GENERAL })).toBe("posted #2 to general");
		expect(store.getLaneBoardPost(2)?.replyTo).toBe(1);
		await expect(board(a).post({ text: "   " })).rejects.toThrow(/text is required/);
		// An old lane without `meta.repo` posts to general by default.
		expect(await board(addLane("lane-old", undefined)).post({ text: "old" })).toBe("posted #3 to general");
	});

	test("AC-7: the body is redacted before the 2,000-character cut, so no token head is left at the end", async () => {
		const a = addLane("lane-a", REPO_1);
		const token = `ghp_${"A".repeat(36)}`;
		const text = `${"가".repeat(LANE_BOARD_TEXT_MAX - 5)}${token}`;
		// Cut first, then redact: the token's head no longer has its shape and survives (the order the store must not use).
		expect(redact(text.slice(0, LANE_BOARD_TEXT_MAX))).toEndWith("ghp_A");
		await board(a).post({ text });
		const stored = store.getLaneBoardPost(1)?.text ?? "";
		expect(stored).toHaveLength(LANE_BOARD_TEXT_MAX);
		expect(stored).not.toContain("ghp_");
		expect(stored).toEndWith("[REDA");
	});
});

class FailOnceDriver extends FakeOmpDriver {
	failNextPrompt = false;
	override async prompt(text: string): Promise<string> {
		if (this.failNextPrompt) {
			this.failNextPrompt = false;
			this.calls.push(`prompt-rejected:${text}`);
			throw new OmpDriverError("rpc_error", "prompt refused");
		}
		return super.prompt(text);
	}
}

describe("lane board notice in the next turn prompt", () => {
	let router: OriginRouter;
	let drivers: Map<string, FailOnceDriver>;
	let counter = 0;

	beforeEach(() => {
		drivers = new Map();
		const sessions = new FakeSessionStore();
		router = new OriginRouter({
			timezone: "Asia/Seoul",
			store,
			clock: { now: () => clockNow },
			sessionsRoot: join(dir, "sessions"),
			log: createLogger({ sink: () => {}, clock: { now: () => clockNow }, redact }),
			statusProvider: () => "",
			boardNotice: (originKey) => boardNoticeFor(store, originKey),
			driverFactory: (origin, sessionDir) => {
				const driver = new FailOnceDriver({ sessionDir, store: sessions });
				drivers.set(origin, driver);
				return driver;
			},
		});
	});

	afterEach(async () => {
		await router.close();
	});

	/** Routes one owner message to `originKey` and waits until its turn was answered. */
	async function turn(originKey: string, text: string): Promise<void> {
		const id = `b${++counter}`;
		const record: InboundRecord = { platformMessageId: id, originKey, ownerVerified: true, text, threadRef: id };
		await router.route(record);
		const mailbox: OriginMailbox = router.mailbox(originKey);
		await mailbox.sweepIdle();
	}

	const prompts = (originKey: string): string[] =>
		(drivers.get(originKey)?.calls ?? []).filter((call) => call.startsWith("prompt:")).map((call) => call.slice(7));

	test("AC-4: one head line with count and channel, no body, once; never the author's own, a closed lane or an idle wake", async () => {
		const a = addLane("lane-a", REPO_1);
		const b = addLane("lane-b", REPO_1);
		const c = addLane("lane-c", REPO_1);
		closeLane("lane-c");
		await board(a).post({ text: "src/x.ts 바꿈 BODY-ONE" });
		await board(a).post({ text: "BODY-TWO", channel: BOARD_GENERAL });
		// Posting wakes nobody: B has no child and no prompt.
		expect(drivers.has(b)).toBe(false);

		await turn(b, "다음 일");
		const [first] = prompts(b);
		const head = `[ompbot 게시판] 새 글 2개 (general, ${boardRepoChannel(REPO_1)}) — 필요하면 ompbot_board_read`;
		expect(first).toBe(`${head}\n\n${CURRENT_REQUEST_MARKER}\n다음 일`);
		expect(first).not.toContain("BODY-");
		// Recovery finds the prompt by its request whatever blocks precede it.
		expect(isTurnPromptFor(first ?? "", "다음 일")).toBe(true);

		await turn(b, "또 다음 일");
		expect(prompts(b)[1]).toBe("또 다음 일");

		await turn(a, "작성자 턴");
		expect(prompts(a)).toEqual(["작성자 턴"]);
		await turn(c, "닫힌 레인 질문");
		expect(prompts(c)).toEqual(["닫힌 레인 질문"]);
	});

	test("AC-4: a prompt the driver refused leaves the line for the next turn", async () => {
		const a = addLane("lane-a", REPO_1);
		const b = addLane("lane-b", REPO_1);
		await turn(b, "시작");
		await board(a).post({ text: "새 소식" });
		const driver = drivers.get(b);
		if (driver === undefined) throw new Error("no driver for lane-b");
		driver.failNextPrompt = true;
		await turn(b, "실패할 턴");
		const head = `[ompbot 게시판] 새 글 1개 (${boardRepoChannel(REPO_1)}) — 필요하면 ompbot_board_read`;
		expect(driver.calls.filter((call) => call.startsWith("prompt-rejected:"))).toEqual([
			`prompt-rejected:${head}\n\n${CURRENT_REQUEST_MARKER}\n실패할 턴`,
		]);
		await turn(b, "다시");
		expect(prompts(b).at(-1)).toBe(`${head}\n\n${CURRENT_REQUEST_MARKER}\n다시`);
		await turn(b, "그다음");
		expect(prompts(b).at(-1)).toBe("그다음");
	});

	test("AC-4: a read post is not announced; the owner conversation hears of open lanes' repo posts", async () => {
		const a = addLane("lane-a", REPO_1);
		const b = addLane("lane-b", REPO_1);
		await board(a).post({ text: "읽힐 글" });
		await board(b).read();
		await turn(b, "읽은 뒤");
		expect(prompts(b)).toEqual(["읽은 뒤"]);
		await turn(OWNER_DM, "대화");
		expect(prompts(OWNER_DM)[0]).toStartWith(
			`[ompbot 게시판] 새 글 1개 (${boardRepoChannel(REPO_1)}) — 필요하면 ompbot_board_read\n\n`,
		);
	});
});

describe("lane start prompt names same-repo lanes", () => {
	let home: TestHome;
	const repos: string[] = [];

	beforeEach(() => {
		home = makeHome("ompbot-lane-board-home-");
	});

	afterEach(() => {
		home.remove();
		for (const repo of repos.splice(0)) removeRepoAndWorktrees(repo);
	});

	test("AC-5: B starting beside open A gets A's name and title and the read-board-first line; a lone lane does not", async () => {
		const h = laneHarness(home.dir);
		try {
			const repo = makeRepo(repos);
			const other = makeRepo(repos);
			const a = await h.manager.start({ title: "결제 리팩터", cwd: repo, channel: "D1" });
			const b = await h.manager.start({ title: "결제 테스트", cwd: repo, channel: "D1" });
			const lone = await h.manager.start({ title: "다른 저장소 일", cwd: other, channel: "D1" });
			await h.settle();
			const [promptA] = h.prompts(a.originKey);
			const [promptB] = h.prompts(b.originKey);
			const [promptLone] = h.prompts(lone.originKey);
			expect(promptB).toContain("같은 저장소에서 열려 있는 다른 레인:");
			expect(promptB).toContain(`- \`${a.name}\`: 결제 리팩터`);
			expect(promptB).toContain("`ompbot_board_read`로 게시판을 먼저 읽고");
			for (const prompt of [promptA, promptLone]) {
				expect(prompt).not.toContain("같은 저장소에서 열려 있는 다른 레인");
				expect(prompt).not.toContain("게시판을 먼저 읽고");
			}
			// Every lane gets the board rule.
			for (const prompt of [promptA, promptB, promptLone])
				expect(prompt).toContain("`ompbot_board_post`로 짧게 올리세요");
		} finally {
			for (const driver of h.drivers.values()) driver.release();
			await h.settle();
			h.close();
		}
	});
});

describe("daemon: who gets the board tools", () => {
	let home: TestHome;
	let daemon: Daemon | undefined;

	beforeEach(() => {
		home = makeHome("ompbot-lane-board-daemon-");
	});

	afterEach(async () => {
		await daemon?.stop();
		home.remove();
	});

	test("AC-6: an untouched DM has them; a peer-touched one and Teams do not, and the peer notices say so", async () => {
		const clock = { now: () => clockNow };
		const started = new Daemon({
			config: home.config,
			channels: [new SlackBinding(new SlackChannel(new WaitingTransport()))],
			clock,
			log: createLogger({ sink: () => {}, clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot-board",
			stopDrainMs: 0,
			sweepMs: 3_600_000,
			gateSweepMs: 0,
			taskSweepMs: 0,
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: new FakeSessionStore() }),
		});
		daemon = started;
		await started.start();
		const names = (origin: string) => started.hostToolsFor(origin).map((tool) => tool.name);

		const clean = started.hostToolsFor(OWNER_DM);
		expect(clean.map((tool) => tool.name)).toEqual(expect.arrayContaining(["ompbot_board_post", "ompbot_board_read"]));
		expect(names("teams/dm/t0123456789abcdef")).not.toContain("ompbot_board_post");
		expect(names("teams/dm/t0123456789abcdef")).not.toContain("ompbot_board_read");

		started.store.ensureOrigin(OWNER_DM, join(home.dir, "sessions", "dm"));
		started.store.recordInbound({
			originKey: OWNER_DM,
			platformMessageId: "D0BOARD001:900.1",
			textRef: "peer",
			threadRef: "D0BOARD001:900.1",
			peerUserId: "UPEER00001",
		});
		expect(names(OWNER_DM)).not.toContain("ompbot_board_post");
		expect(names(OWNER_DM)).not.toContain("ompbot_board_read");
		// A child started before the peer row keeps the tool in its list, refused when called.
		const post = clean.find((tool) => tool.name === "ompbot_board_post");
		await expect(post?.execute({ text: "x" }, { signal })).rejects.toThrow(PEER_TOOL_DENIED);

		expect(peerTouchedTurnNotice(OWNER_DM)).toContain("게시판 도구(`ompbot_board_post`·`ompbot_board_read`)");
		expect(buildFloorsPrompt("/secrets", OWNER_DM, false, false, true)).toContain(
			"게시판 도구(`ompbot_board_post`·`ompbot_board_read`)는 없다",
		);
	});
});
