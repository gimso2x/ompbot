// `!undo` in the mailbox (doc/plans/turn-undo.md §C·E): a conversation turn snapshots the configured repositories before
// and after itself, and `!undo` restores the newest changed turn only after the owner approves — never while a turn
// runs, never after the files changed again, and never for a turn that committed.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnUndoDeps } from "../src/core/mailbox";
import { OriginRouter } from "../src/core/origin";
import type { InboundRecord } from "../src/core/types";
import { createLogger } from "../src/log";
import { FakeOmpDriver, type FakeOmpDriverOptions, FakeSessionStore } from "../src/omp/fake-driver";
import type { GitRunner } from "../src/ops/turn-snapshot";
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
interface ApprovalCard {
	summary: string;
	settle: (approval: "approved" | "denied" | "timeout") => void;
}
let approvals: ApprovalCard[];
let cardWaiter: (() => void) | undefined;
let deliveries: DeliveryRow[];
let deliveryWaiter: (() => void) | undefined;

/** Counts every git call and can fail them all, so "no git when off" and "a failed snapshot never blocks a turn" are visible. */
const countingGit =
	(real: GitRunner): GitRunner =>
	async (repo, args, options) => {
		gitCalls.push(args[0] ?? "");
		if (gitFails) throw new Error("git exploded");
		return real(repo, args, options);
	};

/** The real git in a temp repo, run synchronously for the tests' own setup and checks. */
const realGit: GitRunner = async (repo, args) => {
	const run = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
	return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
};

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
		store,
		clock,
		sessionsRoot: join(home, "sessions"),
		log: createLogger({ sink: () => undefined, clock, redact }),
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
	cardWaiter = undefined;
	store = openStore({
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
