// `!undo` in the mailbox (doc/plans/turn-undo.md §C·E): a conversation turn snapshots the configured repositories before
// and after itself, and `!undo` restores the newest changed turn only after the owner approves — never while a turn
// runs, never after the files changed again, and never for a turn that committed.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnUndoDeps } from "../src/core/mailbox";
import { OriginRouter } from "../src/core/origin";
import type { InboundRecord } from "../src/core/types";
import { createLogger } from "../src/log";
import { FakeOmpDriver, type FakeOmpDriverOptions, FakeSessionStore } from "../src/omp/fake-driver";
import { captureTree, type GitRunner } from "../src/ops/turn-snapshot";
import { redact } from "../src/redact";
import { type DeliveryRow, openStore, type Store } from "../src/store/db";
import { git, makeRepo } from "./helpers/git-fixtures";

class FakeClock {
	t = 1_000_000;
	now(): number {
		return this.t;
	}
}

const ORIGIN = "slack/dm/D1";
let dir: string;
let home: string;
let clock: FakeClock;
let store: Store;
let router: OriginRouter;
let drivers: FakeOmpDriver[];
let driverOptions: FakeOmpDriverOptions;
let repos: string[];
let gitCalls: string[];
let gitFails: boolean;
let gitFailRepos: Set<string>;
/** A git subcommand (`restore`) that fails while every other call runs. */
let gitFailCommand: string | undefined;
interface ApprovalCard {
	summary: string;
	settle: (approval: "approved" | "denied" | "timeout") => void;
}
let approvals: ApprovalCard[];
let cardWaiter: (() => void) | undefined;
let deliveries: DeliveryRow[];
let deliveryWaiter: (() => void) | undefined;
/** Sees every log line; a test waits on `event=turn_snapshot` for a turn's ledger row. */
let logWaiter: ((line: string) => void) | undefined;

/** Counts every git call and can fail them all or one repository, so "no git when off" and "a failed snapshot" are visible. */
const countingGit =
	(real: GitRunner): GitRunner =>
	async (repo, args, options) => {
		gitCalls.push(args[0] ?? "");
		if (gitFails || gitFailRepos.has(repo) || args[0] === gitFailCommand) throw new Error("git exploded");
		return real(repo, args, options);
	};

/** The real git in a temp repo, run synchronously for the tests' own setup and checks. */
const realGit: GitRunner = async (repo, args) => {
	const run = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
	return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
};

/** A real tree capture of a repository, outside the counted runner (the ledger rows of a test's own setup). */
const captureTreeForTest = (repo: string) => captureTree(repo, { run: realGit });

let sessionStore: FakeSessionStore;

function buildRouter(): OriginRouter {
	const turnUndo: TurnUndoDeps = {
		repos: () => repos,
		approve: (info) => {
			const { promise, resolve } = Promise.withResolvers<"approved" | "denied" | "timeout">();
			approvals.push({ summary: info.summary, settle: resolve });
			cardWaiter?.();
			return promise;
		},
		run: countingGit(realGit),
	};
	return new OriginRouter({
		timezone: "Asia/Seoul",
		store,
		clock,
		sessionsRoot: join(home, "sessions"),
		log: createLogger({ sink: (line) => logWaiter?.(line), clock, redact }),
		statusProvider: () => "status: ok",
		turnUndo,
		driverFactory: (_origin, sessionDir) => {
			const driver = new FakeOmpDriver({ ...driverOptions, sessionDir, store: sessionStore });
			drivers.push(driver);
			return driver;
		},
	});
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-undo-"));
	home = join(dir, "home");
	Bun.spawnSync(["mkdir", "-p", home]);
	clock = new FakeClock();
	deliveries = [];
	deliveryWaiter = undefined;
	logWaiter = undefined;
	cardWaiter = undefined;
	store = openStore({
		timezone: "Asia/Seoul",
		path: join(home, "ompbot.db"),
		clock,
		redact,
		hooks: {
			onDeliveryState: (change) => {
				if (change.from !== "new") return;
				const row = store.getDelivery(change.deliveryId);
				if (row !== undefined) deliveries.push(row);
				deliveryWaiter?.();
			},
		},
	});
	drivers = [];
	driverOptions = {};
	repos = [];
	gitCalls = [];
	gitFails = false;
	gitFailRepos = new Set();
	gitFailCommand = undefined;
	approvals = [];
	sessionStore = new FakeSessionStore();
	router = buildRouter();
});

afterEach(async () => {
	await router.close();
	store.close();
	for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
	rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
function msg(text: string): InboundRecord {
	const id = `m${++counter}`;
	return { platformMessageId: id, originKey: ORIGIN, ownerVerified: true, text, threadRef: id };
}

/** Resolves on the next recorded delivery (event-driven: no polling, no sleeps). */
async function nextDeliveryEvent(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	deliveryWaiter = resolve;
	await promise;
}

/** The reply of a `!undo` (its opRef is `undo:<message id>`), not some turn answer recorded around the same time. */
async function undoReply(start = 0): Promise<DeliveryRow> {
	for (;;) {
		const found = deliveries.slice(start).find((row) => row.opRef.startsWith("undo:"));
		if (found !== undefined) return found;
		await nextDeliveryEvent();
	}
}

interface UndoRun {
	card: ApprovalCard;
	/** Settles the card and resolves on the `!undo` reply it produces. */
	settle: (approval: "approved" | "denied" | "timeout") => Promise<DeliveryRow>;
}

/** Routes `!undo` and waits for the card the owner would see. */
async function undoStart(): Promise<UndoRun> {
	const cardIndex = approvals.length;
	const seen = Promise.withResolvers<void>();
	cardWaiter = seen.resolve;
	await router.route(msg("!undo"));
	await seen.promise;
	const card = approvals[cardIndex];
	if (card === undefined) throw new Error("undo card never opened");
	return {
		card,
		settle: (approval) => {
			card.settle(approval);
			return undoReply();
		},
	};
}

/** Routes one message and waits for the turn it starts to settle. */
async function runTurn(text: string): Promise<void> {
	const mailbox = router.mailbox(ORIGIN);
	const driverCount = drivers.length;
	await router.route(msg(text));
	const driver = drivers[driverCount];
	if (driver === undefined) return;
	if (driverOptions.holdTurns === true) driver.release();
	await mailbox.sweepIdle();
}

/** `runTurn` that also waits for the turn's ledger row: it is written after the answer, past the turn's own settle. */
async function runRecordedTurn(text: string): Promise<void> {
	const recorded = Promise.withResolvers<void>();
	logWaiter = (line) => {
		if (line.includes("event=turn_snapshot ")) recorded.resolve();
	};
	await runTurn(text);
	await recorded.promise;
	logWaiter = undefined;
}

describe("turn snapshots around a turn (AC-3)", () => {
	test("with no repository configured git is never called", async () => {
		await runTurn("hello");
		expect(gitCalls).toEqual([]);
		expect(store.listTurnSnapshots({ originKey: ORIGIN })).toEqual([]);
	});

	test("a turn that changed nothing leaves no row", async () => {
		const repo = makeRepo(repos);
		await runTurn("hello");
		expect(gitCalls.length).toBeGreaterThan(0);
		expect(store.listTurnSnapshots({ originKey: ORIGIN })).toEqual([]);
		expect(git(repo, "status", "--porcelain")).toBe("");
	});

	test("a turn that changed a file leaves one row, and reverted_at stays null", async () => {
		const repo = makeRepo(repos);
		driverOptions = {
			respond: () => {
				writeFileSync(join(repo, "touched.txt"), "by the turn\n");
				return "고쳤습니다";
			},
		};
		await runTurn("고쳐줘");
		const rows = store.listTurnSnapshots({ originKey: ORIGIN });
		expect(rows).toHaveLength(1);
		expect(rows[0]?.repo).toBe(repo);
		expect(rows[0]?.revertedAt).toBeNull();
		expect(rows[0]?.endedAt as number).toBeGreaterThanOrEqual(rows[0]?.startedAt as number);
	});

	test("a failed snapshot never blocks the turn", async () => {
		makeRepo(repos);
		gitFails = true;
		driverOptions = { respond: () => "그냥 답" };
		await runTurn("hello");
		expect(deliveries.map((row) => row.body)).toEqual(["그냥 답"]);
		expect(store.listTurnSnapshots({ originKey: ORIGIN })).toEqual([]);
	});
});

describe("!undo (AC-3)", () => {
	/** One completed turn that created `touched.txt`; returns its repo. */
	async function turnThatWrites(name = "touched.txt"): Promise<string> {
		const repo = makeRepo(repos);
		driverOptions = {
			respond: () => {
				writeFileSync(join(repo, name), "by the turn\n");
				return "고쳤습니다";
			},
		};
		await runTurn("고쳐줘");
		driverOptions = {};
		return repo;
	}

	test("denied or timed out: the file stays exactly as it was", async () => {
		const repo = await turnThatWrites();
		for (const approval of ["denied", "timeout"] as const) {
			const run = await undoStart();
			expect(run.card.summary).toContain(repo);
			const answer = await run.settle(approval);
			expect(answer.body).toContain("되돌리지 않았습니다");
			expect(readFileSync(join(repo, "touched.txt"), "utf8")).toBe("by the turn\n");
			expect(store.listTurnSnapshots({ originKey: ORIGIN }).every((row) => row.revertedAt === null)).toBe(true);
		}
	});

	test("approved: the turn's file goes away and reverted_at is recorded", async () => {
		const repo = await turnThatWrites();
		const run = await undoStart();
		const answer = await run.settle("approved");
		expect(answer.body).toContain("되돌림");
		expect(existsSync(join(repo, "touched.txt"))).toBe(false);
		expect(store.listTurnSnapshots({ originKey: ORIGIN }).every((row) => row.revertedAt !== null)).toBe(true);
	});

	test("a second !undo has nothing left to revert", async () => {
		await turnThatWrites();
		const run = await undoStart();
		await run.settle("approved");
		const cardsBefore = approvals.length;
		const start = deliveries.length;
		await router.route(msg("!undo"));
		const answer = await undoReply(start);
		expect(answer.body).toContain("되돌릴 턴 변경이 없습니다");
		expect(approvals).toHaveLength(cardsBefore);
		expect(approvals).toHaveLength(1);
	});

	test("!undo during a running turn is refused and touches nothing", async () => {
		const repo = makeRepo(repos);
		driverOptions = {
			holdTurns: true,
			respond: () => {
				writeFileSync(join(repo, "during.txt"), "during\n");
				return "끝";
			},
		};
		await router.route(msg("긴 작업"));
		const start = deliveries.length;
		await router.route(msg("!undo"));
		const answer = await undoReply(start);
		expect(answer.body).toContain("턴이 끝난 뒤 다시 시도하세요");
		expect(approvals).toEqual([]);
		expect(existsSync(join(repo, "during.txt"))).toBe(false);
		(drivers[0] as FakeOmpDriver).release();
		await router.mailbox(ORIGIN).sweepIdle();
	});

	test("a new turn started while the card waits: the approval writes nothing", async () => {
		const repo = await turnThatWrites();
		const run = await undoStart();
		await runTurn("다른 일");
		const answer = await run.settle("approved");
		expect(answer.body).toContain("승인 사이에 새 턴이 시작돼");
		expect(readFileSync(join(repo, "touched.txt"), "utf8")).toBe("by the turn\n");
	});

	test("files changed while the card waits fall out of the plan", async () => {
		const repo = await turnThatWrites();
		const run = await undoStart();
		// A hand edit (no turn): the file no longer matches what the card promised.
		writeFileSync(join(repo, "touched.txt"), "hand edited\n");
		const answer = await run.settle("approved");
		expect(answer.body).not.toContain("되돌림:");
		expect(readFileSync(join(repo, "touched.txt"), "utf8")).toBe("hand edited\n");
		expect(store.listTurnSnapshots({ originKey: ORIGIN }).every((row) => row.revertedAt === null)).toBe(true);
	});
});

describe("!undo of a turn that moved a nested repository or failed midway (#46)", () => {
	test("a gitlink the turn moved is a conflict: the undo answers, keeps the nested checkout and reverts the rest", async () => {
		const repo = makeRepo(repos);
		const inner = join(repo, "vendor", "dep");
		mkdirSync(inner, { recursive: true });
		git(inner, "init", "-q");
		writeFileSync(join(inner, "f.txt"), "one\n");
		git(inner, "add", "f.txt");
		git(inner, "commit", "-q", "-m", "one");
		driverOptions = {
			respond: () => {
				writeFileSync(join(inner, "f.txt"), "two\n");
				git(inner, "commit", "-qam", "two");
				writeFileSync(join(repo, "touched.txt"), "by the turn\n");
				return "고쳤습니다";
			},
		};
		await runTurn("고쳐줘");
		driverOptions = {};
		const run = await undoStart();
		expect(run.card.summary).toContain("conflict: vendor/dep");
		const answer = await run.settle("approved");
		expect(answer.body).toContain(`되돌림: ${repo} 파일 1개, 충돌 1개, 겹침 0개`);
		expect(existsSync(join(repo, "touched.txt"))).toBe(false);
		expect(readFileSync(join(inner, "f.txt"), "utf8")).toBe("two\n");
		expect(store.listTurnSnapshots({ originKey: ORIGIN }).every((row) => row.revertedAt !== null)).toBe(true);
	});

	test("a revert failing midway answers how many files went back and why, and the turn stays undoable", async () => {
		const repo = makeRepo(repos);
		writeFileSync(join(repo, "b.txt"), "one\n");
		git(repo, "add", "b.txt");
		git(repo, "commit", "-q", "-m", "b");
		driverOptions = {
			respond: () => {
				writeFileSync(join(repo, "a.txt"), "new\n");
				writeFileSync(join(repo, "b.txt"), "two\n");
				return "고쳤습니다";
			},
		};
		await runTurn("고쳐줘");
		driverOptions = {};
		const run = await undoStart();
		gitFailCommand = "restore";
		const answer = await run.settle("approved");
		expect(answer.body).toContain(`되돌림: ${repo} 파일 1개`);
		expect(answer.body).toContain(`되돌리다 멈춤: ${repo} b.txt — Error: git exploded`);
		expect(existsSync(join(repo, "a.txt"))).toBe(false);
		expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("two\n");
		expect(store.listTurnSnapshots({ originKey: ORIGIN }).every((row) => row.revertedAt === null)).toBe(true);
	});
});

describe("!undo never pins the ledger to a turn it cannot revert (qa-i #22)", () => {
	test("a turn that turned a file into a directory is reverted and closed; the next !undo goes to the turn before", async () => {
		const repo = makeRepo(repos);
		writeFileSync(join(repo, "pkg"), "module\n");
		git(repo, "add", "pkg");
		git(repo, "commit", "-q", "-m", "pkg");
		// One driver serves both turns (its options are read once), so the reply depends on the prompt.
		driverOptions = {
			respond: (text) => {
				if (text.includes("첫 일")) {
					writeFileSync(join(repo, "first.txt"), "first\n");
					return "첫 턴";
				}
				rmSync(join(repo, "pkg"));
				mkdirSync(join(repo, "pkg"));
				writeFileSync(join(repo, "pkg", "inner.txt"), "inner\n");
				return "둘째 턴";
			},
		};
		await runRecordedTurn("첫 일");
		await runRecordedTurn("둘째 일");
		const second = await (await undoStart()).settle("approved");
		expect(second.body).toContain(`되돌림: ${repo} 파일 2개, 충돌 0개, 겹침 0개`);
		expect(second.body).not.toContain("ENOTDIR");
		expect(readFileSync(join(repo, "pkg"), "utf8")).toBe("module\n");
		const run = await undoStart();
		expect(run.card.summary).toContain("revert: first.txt");
		const start = deliveries.length;
		run.card.settle("approved");
		expect((await undoReply(start)).body).toContain(`되돌림: ${repo} 파일 1개`);
		expect(existsSync(join(repo, "first.txt"))).toBe(false);
	});

	test("a newest turn left with nothing to revert is closed, and the same !undo offers the turn before it", async () => {
		const repo = makeRepo(repos);
		driverOptions = {
			respond: (text) => {
				const name = text.includes("첫 일") ? "first.txt" : "second.txt";
				writeFileSync(join(repo, name), `${name}\n`);
				return "고쳤습니다";
			},
		};
		await runRecordedTurn("첫 일");
		await runRecordedTurn("둘째 일");
		// A hand edit after the second turn: its only file is a conflict, so that turn can never be reverted.
		writeFileSync(join(repo, "second.txt"), "hand edited\n");
		const run = await undoStart();
		expect(run.card.summary).toContain("revert: first.txt");
		expect(run.card.summary).toContain("되돌릴 파일이 없어 닫은 턴");
		const answer = await run.settle("approved");
		expect(answer.body).toContain(`되돌림: ${repo} 파일 1개`);
		expect(existsSync(join(repo, "first.txt"))).toBe(false);
		expect(readFileSync(join(repo, "second.txt"), "utf8")).toBe("hand edited\n");
		expect(store.listTurnSnapshots({ originKey: ORIGIN }).every((row) => row.revertedAt !== null)).toBe(true);
	});
});

describe("a repository without a snapshot is named, never silently skipped (#92)", () => {
	test("one of two repositories failing to capture: the answer names it and the other is reverted", async () => {
		const good = makeRepo(repos);
		const bad = makeRepo(repos);
		// The bad repository cannot be captured at all, so the turn leaves a row only for the good one.
		gitFailRepos = new Set([bad]);
		driverOptions = {
			respond: () => {
				writeFileSync(join(good, "good.txt"), "by the turn\n");
				writeFileSync(join(bad, "bad.txt"), "by the turn\n");
				return "고쳤습니다";
			},
		};
		await runTurn("고쳐줘");
		gitFailRepos = new Set();
		driverOptions = {};
		expect(store.listTurnSnapshots({ originKey: ORIGIN }).map((row) => row.repo)).toEqual([good]);

		const run = await undoStart();
		expect(run.card.summary).toContain(`스냅샷 없음: ${bad}`);
		expect(run.card.summary).toContain("직전 턴을 기록하지 못해 이 저장소는 되돌리지 않음");
		const answer = await run.settle("approved");
		expect(answer.body).toContain(`스냅샷 없음: ${bad}`);
		expect(existsSync(join(good, "good.txt"))).toBe(false);
		expect(readFileSync(join(bad, "bad.txt"), "utf8")).toBe("by the turn\n");
	});

	test("the newest turn's snapshot failed: an older turn of that repository is not reverted (AC-6b)", async () => {
		const repo = makeRepo(repos);
		driverOptions = {
			respond: () => {
				writeFileSync(join(repo, "a.txt"), "turn one\n");
				return "첫 턴";
			},
		};
		await runTurn("a를 만들어줘");
		// Turn two changes b, but its capture fails: `!undo` must not walk back to turn one's a.
		gitFails = true;
		driverOptions = {
			respond: () => {
				writeFileSync(join(repo, "b.txt"), "turn two\n");
				return "둘째 턴";
			},
		};
		await runTurn("b를 만들어줘");
		gitFails = false;
		driverOptions = {};

		const start = deliveries.length;
		await router.route(msg("!undo"));
		const answer = await undoReply(start);
		expect(answer.body).toContain(`스냅샷 없음: ${repo}`);
		expect(existsSync(join(repo, "a.txt"))).toBe(true);
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("turn one\n");
		expect(approvals).toEqual([]);
	});
});

describe("overlap with another conversation (AC-6c)", () => {
	test("a file two overlapping conversations changed stays put; the one only this conversation changed comes back", async () => {
		const repo = makeRepo(repos);
		const other = "slack/dm/D2";
		// The ledger rows of both turns are real captures of this work tree: A's window overlaps B's.
		const before = await captureTreeForTest(repo);
		writeFileSync(join(repo, "x.txt"), "by A\n");
		writeFileSync(join(repo, "y.txt"), "by A\n");
		const aAfter = await captureTreeForTest(repo);
		writeFileSync(join(repo, "x.txt"), "by B\n");
		const bAfter = await captureTreeForTest(repo);
		const a = store.recordTurnSnapshot({
			originKey: ORIGIN,
			opRef: "a_req_1",
			repo,
			headBefore: before.head,
			treeBefore: before.tree,
			headAfter: aAfter.head,
			treeAfter: aAfter.tree,
			startedAt: 1_000_000,
			endedAt: 1_000_100,
		});
		store.recordTurnSnapshot({
			originKey: other,
			opRef: "b_req_1",
			repo,
			headBefore: before.head,
			treeBefore: aAfter.tree,
			headAfter: bAfter.head,
			treeAfter: bAfter.tree,
			startedAt: 1_000_050,
			endedAt: 1_000_200,
		});
		expect(a.id).toBeGreaterThan(0);

		const run = await undoStart();
		expect(run.card.summary).toContain(`· ${repo}: 되돌림 1개, 충돌 0개, 겹침 1개`);
		const answer = await run.settle("approved");
		expect(answer.body).toContain("겹침 1개");
		expect(readFileSync(join(repo, "x.txt"), "utf8")).toBe("by B\n");
		expect(existsSync(join(repo, "y.txt"))).toBe(false);
	});
});
