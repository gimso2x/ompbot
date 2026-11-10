// Channel root isolation: every new channel root is its own origin
// `slack/ch/<C>/t/<rootTs>` — its own omp session and mailbox — so a second root never steers into the first root's
// running turn and answers, taskSpec threads and approval rows stay on their own root thread. Waits are on log lines,
// posts and finals (bounded), never fixed sleeps.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { THREAD_CONTEXT_HEADER } from "../src/core/mailbox";
import { normalizeInbound } from "../src/core/normalize";
import { OriginRouter, openBotStore, sessionDirFor } from "../src/core/origin";
import type { InboundRecord } from "../src/core/types";
import { Daemon } from "../src/daemon/daemon";
import { INTERRUPTED_NOTICE, recoverDispatched } from "../src/daemon/recovery";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { gcSessions } from "../src/ops/gc";
import { redact } from "../src/redact";
import { approvalActionId } from "../src/safety/approval";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import { SlackCallError, type SlackTransport } from "../src/slack/transport";
import type { Store } from "../src/store/db";
import { makeHome, OWNER, type TestHome, WaitingTransport } from "./helpers/bot-home";
import { makeRepo } from "./helpers/git-fixtures";
import { removeRepoAndWorktrees } from "./helpers/lane-harness";

const CH = "C0ROOTS01";
const CHANNEL_ORIGIN = `slack/ch/${CH}`;
const STEER_POINTER = "↪ 이 요청은 진행 중이던 작업에 합쳐져서 답을 다른 스레드에 올렸어";
/** Failure bound of every wait, below bun's 5 s test timeout so a miss names what it waited for. */
const WAIT_MS = 4_000;

/** Slack-shaped ts strings near now (backfill only reads messages newer than its bootstrap floor). */
const NOW_S = Math.floor(Date.now() / 1000);
const tsAt = (n: number) => `${NOW_S}.${String(n).padStart(6, "0")}`;
const rootOrigin = (ts: string) => `${CHANNEL_ORIGIN}/t/${ts}`;
const ref = (ts: string) => `${CH}:${ts}`;

/** Resolves when approval buttons go up on a card. */
class CardTransport extends WaitingTransport {
	shown = Promise.withResolvers<{ channel: string; ts: string }>();
	/** Channels whose history a backfill pass read, one entry per `conversations.history` page (= per channel target). */
	readonly historyReads: string[] = [];

	override conversationsHistory(args: Parameters<WaitingTransport["conversationsHistory"]>[0]) {
		this.historyReads.push(args.channel);
		return super.conversationsHistory(args);
	}

	override async updateMessage(args: {
		channel: string;
		ts: string;
		text: string;
		blocks?: readonly unknown[] | undefined;
	}): Promise<void> {
		await super.updateMessage(args);
		if (args.blocks !== undefined && args.blocks.length > 0) this.shown.resolve({ channel: args.channel, ts: args.ts });
	}
}

/** Daemon log sink whose waiters resolve on the line set that satisfies them (bounded, no polling). */
class LogLines {
	readonly lines: string[] = [];
	readonly #waiters = new Set<() => void>();

	push(line: string): void {
		this.lines.push(line);
		for (const waiter of [...this.#waiters]) waiter();
	}

	count(re: RegExp): number {
		return this.lines.filter((line) => re.test(line)).length;
	}

	waitFor(done: () => boolean, what: string): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const check = () => {
			if (!done()) return;
			clearTimeout(timer);
			this.#waiters.delete(check);
			resolve();
		};
		const timer = setTimeout(() => {
			this.#waiters.delete(check);
			reject(new Error(`timed out waiting for ${what}`));
		}, WAIT_MS);
		this.#waiters.add(check);
		check();
		return promise;
	}
}

function channelMessage(ts: string, text: string, threadTs?: string) {
	return {
		type: "message" as const,
		channel: CH,
		channel_type: "channel",
		user: OWNER,
		text,
		ts,
		...(threadTs === undefined ? {} : { thread_ts: threadTs }),
	};
}

describe("daemon: channel roots are isolated sessions", () => {
	let home: TestHome;
	let daemon: Daemon;
	let transport: CardTransport;
	let logs: LogLines;
	let drivers: Map<string, FakeOmpDriver>;

	/** `sessions` is the omp session storage; a restart test passes the dead daemon's so the new one resumes it. */
	async function boot(hold: (origin: string) => boolean, sessions = new FakeSessionStore()): Promise<void> {
		transport = new CardTransport();
		const clock = { now: () => Date.now() };
		daemon = new Daemon({
			config: { ...home.config, mentionFreeChannels: [CH], herdr: {} },
			channels: [new SlackBinding(new SlackChannel(transport))],
			log: createLogger({ sink: (line) => logs.push(line), clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			stopDrainMs: 0,
			driverFactory: (origin, sessionDir) => {
				const driver = new FakeOmpDriver({ sessionDir, store: sessions, holdTurns: hold(origin) });
				drivers.set(origin, driver);
				return driver;
			},
		});
		await daemon.start();
	}

	function driverOf(origin: string): FakeOmpDriver {
		const driver = drivers.get(origin);
		if (driver === undefined) throw new Error(`no driver for ${origin}`);
		return driver;
	}

	/** Prompts and steers an origin's omp child received (session bookkeeping calls left out). */
	const turnCalls = (origin: string) =>
		driverOf(origin).calls.filter((call) => call.startsWith("prompt:") || call.startsWith("steer:"));
	const turnStarts = () => logs.count(/event=turn_start /);
	const steers = () => logs.lines.filter((line) => /event=steer_delivered /.test(line));

	/** Root A's turn is running (held) when root B arrives; resolves once B is either prompted or steered. */
	async function twoRootsInFlight(a: string, b: string, textB = "ego 질문"): Promise<void> {
		await boot(() => true);
		await transport.emitMessage(channelMessage(a, "inferhub 질문"));
		await logs.waitFor(() => turnStarts() >= 1, "root A turn_start");
		await transport.emitMessage(channelMessage(b, textB));
		await logs.waitFor(() => turnStarts() >= 2 || steers().length >= 1, "root B prompted or steered");
	}

	function answersByThread(): Array<[string, string]> {
		return daemon.store
			.listDeliveries()
			.filter((d) => d.body.startsWith("ECHO"))
			.map((d): [string, string] => [d.threadRef, d.body]);
	}

	beforeEach(() => {
		home = makeHome("ompbot-root-iso-");
		logs = new LogLines();
		drivers = new Map();
	});

	afterEach(async () => {
		for (const driver of drivers.values()) driver.release();
		await daemon.stop();
		home.remove();
	});

	test("AC-1: root B arriving while root A's turn runs is its own turn; each answer stays on its own root", async () => {
		const a = tsAt(100);
		const b = tsAt(200);
		await twoRootsInFlight(a, b);
		expect(steers()).toEqual([]);
		expect(daemon.store.getInbound(ref(b))?.originKey).toBe(rootOrigin(b));
		expect(daemon.store.getInbound(ref(a))?.originKey).toBe(rootOrigin(a));
		expect(turnCalls(rootOrigin(b))).toEqual(["prompt:ego 질문"]);
		expect(turnCalls(rootOrigin(a))).toEqual(["prompt:inferhub 질문"]);

		driverOf(rootOrigin(a)).release();
		driverOf(rootOrigin(b)).release();
		await transport.waitForPosts((text) => text.startsWith("ECHO"), 2);
		expect(answersByThread().sort()).toEqual([
			[ref(a), "ECHO inferhub 질문"],
			[ref(b), "ECHO ego 질문"],
		]);
		const posted = transport.posts((text) => text.startsWith("ECHO"));
		expect(posted.map((p) => [p.threadTs, p.text]).sort()).toEqual([
			[a, "ECHO inferhub 질문"],
			[b, "ECHO ego 질문"],
		]);
		expect(daemon.store.listDeliveries().filter((d) => d.body.startsWith(STEER_POINTER))).toEqual([]);
		expect(transport.posts((text) => text.startsWith(STEER_POINTER))).toEqual([]);
	});

	test("AC-2: B finishing first and A finishing later still answers each root in its own thread", async () => {
		const a = tsAt(100);
		const b = tsAt(200);
		await twoRootsInFlight(a, b);
		driverOf(rootOrigin(b)).release();
		await transport.waitForPosts((text) => text === "ECHO ego 질문");
		expect(answersByThread()).toEqual([[ref(b), "ECHO ego 질문"]]);
		expect(daemon.store.getInbound(ref(a))?.state).toBe("dispatched");

		driverOf(rootOrigin(a)).release();
		await transport.waitForPosts((text) => text === "ECHO inferhub 질문");
		expect(answersByThread()).toEqual([
			[ref(b), "ECHO ego 질문"],
			[ref(a), "ECHO inferhub 질문"],
		]);
		expect(transport.posts((text) => text.startsWith("ECHO")).map((p) => [p.threadTs, p.text])).toEqual([
			[b, "ECHO ego 질문"],
			[a, "ECHO inferhub 질문"],
		]);
		expect(daemon.store.listDeliveries().filter((d) => d.body.startsWith(STEER_POINTER))).toEqual([]);
	});

	test("AC-4: a reply in root A's thread joins A's session (steered into A's running turn); A's approval row points at A", async () => {
		const a = tsAt(100);
		const reply = tsAt(150);
		await boot(() => true);
		await transport.emitMessage(channelMessage(a, "배포 준비해줘"));
		await logs.waitFor(() => turnStarts() >= 1, "root A turn_start");
		const opRef = daemon.store.getInbound(ref(a))?.opRef;

		await transport.emitMessage(channelMessage(reply, "main 브랜치로", a));
		await logs.waitFor(() => steers().length >= 1, "reply steered");
		expect(daemon.store.getInbound(`${CH}:${reply}`)).toMatchObject({
			originKey: rootOrigin(a),
			threadRef: ref(a),
			opRef,
		});
		expect(turnCalls(rootOrigin(a))).toEqual(["prompt:배포 준비해줘", "steer:main 브랜치로"]);

		const tool = daemon.hostToolsFor(rootOrigin(a)).find((t) => t.name === "ompbot_request_approval");
		if (!tool) throw new Error("approval tool missing");
		const result = tool.execute({ summary: "force push main" }, { signal: new AbortController().signal });
		const card = await transport.shown.promise;
		expect(daemon.store.getApproval(`${card.channel}:${card.ts}`)).toMatchObject({
			status: "pending",
			originKey: rootOrigin(a),
			originThreadRef: ref(a),
		});
		await transport.emitBlockAction({
			user: { id: OWNER },
			channel: { id: card.channel },
			message: { ts: card.ts },
			actions: [{ action_id: approvalActionId("approve", card.channel, card.ts), value: "approve" }],
		});
		expect(await result).toBe("approved");

		driverOf(rootOrigin(a)).release();
		await transport.waitForPosts((text) => text.startsWith("ECHO"));
		expect(answersByThread()).toEqual([[ref(a), "ECHO 배포 준비해줘 | main 브랜치로"]]);
	});

	test("AC-5: the same root event twice live and once more from backfill is one row, one origin, one turn, one answer", async () => {
		await boot(() => false);
		// A channel-level command first: it keeps the channel origin, which is the channel's backfill target.
		const command = channelMessage(tsAt(50), "!thinking high");
		await transport.emitMessage(command);
		await transport.waitForPosts((text) => text.includes("high"));
		const x = tsAt(100);
		const root = channelMessage(x, "중복 테스트");
		await transport.emitMessage(root);
		await transport.waitForPosts((text) => text === "ECHO 중복 테스트");
		await transport.emitMessage(root);
		const rootDuplicate = new RegExp(`event=inbound_duplicate id=${CH}:${x.replace(".", "\\.")}\\b`);
		await logs.waitFor(() => logs.count(rootDuplicate) >= 1, "live duplicate");

		const passes = logs.count(/event=slack_backfill /);
		transport.history.set(CH, [
			{ ts: x, text: root.text, user: OWNER },
			{ ts: command.ts, text: command.text, user: OWNER },
		]);
		// The daemon wires the socket's (re)connect hook to a backfill pass; fire it like a reconnect would.
		(transport as SlackTransport).onReady?.();
		await logs.waitFor(() => logs.count(/event=slack_backfill /) > passes, "backfill pass");
		// The pass really re-read both channel messages, and the root came back as a duplicate, not a new row.
		expect(logs.lines.filter((line) => /event=slack_backfill /.test(line)).at(-1)).toMatch(/ scanned=2 recovered=0 /);
		expect(logs.count(rootDuplicate)).toBe(2);
		// An existing channel (channel origin row + a root origin) is still one channel target: one history read.
		expect(transport.historyReads.filter((channel) => channel === CH)).toHaveLength(1);

		expect(daemon.store.listInbound().filter((row) => row.platformMessageId === ref(x))).toHaveLength(1);
		expect(daemon.store.listSlackOrigins().filter((origin) => origin.endsWith(x))).toEqual([rootOrigin(x)]);
		expect(driverOf(rootOrigin(x)).calls.filter((call) => call.startsWith("prompt:"))).toEqual(["prompt:중복 테스트"]);
		expect(daemon.store.listDeliveries({ originKey: rootOrigin(x) }).map((d) => [d.threadRef, d.body])).toEqual([
			[ref(x), "ECHO 중복 테스트"],
		]);
		expect(transport.posts((text) => text === "ECHO 중복 테스트")).toHaveLength(1);
	});

	test("AC-7: root commands and slash commands stay on the channel origin; a lane trigger root starts a lane", async () => {
		await boot(() => false);
		const model = channelMessage(tsAt(10), "!model fake/beta");
		await transport.emitMessage(model);
		await transport.waitForPosts((text) => text.includes("fake/beta"));
		expect(daemon.store.getInbound(ref(model.ts))?.originKey).toBe(CHANNEL_ORIGIN);

		await transport.emitSlash({ command: "/model-ompbot", user_id: OWNER, channel_id: CH, text: "" });
		const slash = daemon.store.listInbound().find((row) => row.platformMessageId.startsWith(`slash:${CH}:`));
		expect(slash).toMatchObject({ originKey: CHANNEL_ORIGIN, threadRef: `${CH}:-` });

		// A lane starts only inside a git repository (it works in its own worktree beside it).
		const repo = makeRepo([], "ompbot-root-iso-lane-");
		try {
			const lane = channelMessage(tsAt(20), `작업: 루트 격리 레인 @${repo}`);
			await transport.emitMessage(lane);
			await transport.waitForPosts((text) => text.startsWith("🔄 작업 레인"));
			const row = daemon.store.getInbound(ref(lane.ts));
			expect(row?.opRef).toBe(`lane:${ref(lane.ts)}`);
			expect(
				daemon.store.listDeliveries({ originKey: row?.originKey ?? "" }).map((d) => [d.threadRef, d.opRef]),
			).toEqual([[ref(lane.ts), `lane:${ref(lane.ts)}`]]);
			// The trigger text is never an omp prompt of a conversation session.
			for (const [origin, driver] of drivers) {
				if (origin.startsWith("slack/"))
					expect(driver.calls.some((c) => c.includes("작업: 루트 격리 레인"))).toBe(false);
			}
		} finally {
			removeRepoAndWorktrees(repo);
		}
	});

	test("AC-8: a root session inherits the channel's model and thinking; its first prompt carries no context block", async () => {
		await boot(() => false);
		await transport.emitMessage(channelMessage(tsAt(10), "!model fake/beta"));
		await transport.waitForPosts((text) => text.includes("fake/beta"));
		await transport.emitMessage(channelMessage(tsAt(20), "!thinking high"));
		await transport.waitForPosts((text) => text.includes("high"));

		const x = tsAt(100);
		await transport.emitMessage(channelMessage(x, "새 루트 질문"));
		await transport.waitForPosts((text) => text === "ECHO 새 루트 질문");
		const origin = daemon.store.getOrigin(rootOrigin(x));
		expect(origin).toMatchObject({ model: null, thinking: null });
		const calls = driverOf(rootOrigin(x)).calls;
		expect(calls).toContain("setModel:fake/beta");
		expect(calls).toContain("setThinking:high");
		const prompts = calls.filter((call) => call.startsWith("prompt:"));
		expect(prompts).toEqual(["prompt:새 루트 질문"]);
		expect(prompts[0]).not.toContain(THREAD_CONTEXT_HEADER);
	});

	test("D1-4 (AC-3): the daemon's own dispatch tool binds a [TASK] root's taskSpec to that root's thread and origin", async () => {
		const a = tsAt(100);
		const b = tsAt(200);
		await twoRootsInFlight(a, b, "[TASK] 새 작업 등록해줘");
		// Fixture: the ledger's register records what the real tool path hands it. The repo is a plain directory, so
		// the run stops at `git worktree add` — before any herdr agent or Slack post — and the registration is undone.
		const ledger = daemon.store.tasks;
		const register = ledger.register.bind(ledger);
		const registered: Array<{ originKey: string; threadRef: string }> = [];
		ledger.register = (input) => {
			registered.push({ originKey: input.originKey, threadRef: input.threadRef });
			return register(input);
		};
		const repo = mkdtempSync(join(tmpdir(), "ompbot-root-iso-task-"));
		try {
			const dispatch = (origin: string) => {
				const tool = daemon.hostToolsFor(origin).find((t) => t.name === "ompbot_dispatch");
				if (!tool) throw new Error(`dispatch tool missing for ${origin}`);
				const taskSpec = { title: "루트 격리", risk: "L1", goal: "g", acceptance: ["a"], repo };
				return tool.execute({ task: "구현", taskSpec }, { signal: new AbortController().signal });
			};
			// Both turns are still running: the supplier answers from each origin's own running turn.
			expect(daemon.store.getInbound(ref(b))?.state).toBe("dispatched");
			expect(await dispatch(rootOrigin(b))).toStartWith("시작 실패: git worktree add failed");
			expect(await dispatch(rootOrigin(a))).toStartWith("시작 실패: git worktree add failed");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
		expect(registered).toEqual([
			{ originKey: rootOrigin(b), threadRef: ref(b) },
			{ originKey: rootOrigin(a), threadRef: ref(a) },
		]);
		// Stopped before the task card: no permalink lookup, no registration post.
		expect(transport.count("getPermalink")).toBe(0);
	});

	test("D1-5 (AC-6): a daemon restart (stop → new Daemon.start on the same home) notifies each in-flight root's own thread", async () => {
		const a = tsAt(100);
		const b = tsAt(200);
		const sessions = new FakeSessionStore();
		await boot(() => true, sessions);
		await transport.emitMessage(channelMessage(a, "inferhub 질문"));
		await transport.emitMessage(channelMessage(b, "ego 질문"));
		await logs.waitFor(() => turnStarts() >= 2, "both root turns running");
		// The process goes down mid-turn: the children stop without a final, the ledger keeps both rows `dispatched`.
		await daemon.stop();
		const dead = transport;
		expect(dead.posts((text) => text === INTERRUPTED_NOTICE)).toEqual([]);

		const recoveries = logs.count(/event=recovery_done /);
		await boot(() => false, sessions);
		await logs.waitFor(() => logs.count(/event=recovery_done /) > recoveries, "restart recovery");
		expect(logs.lines.filter((line) => /event=recovery_done /.test(line)).at(-1)).toMatch(/ answered=0 interrupted=2$/);
		await transport.waitForPosts((text) => text === INTERRUPTED_NOTICE, 2);
		expect(
			daemon.store
				.listDeliveries()
				.filter((d) => d.body === INTERRUPTED_NOTICE)
				.map((d) => [d.originKey, d.threadRef]),
		).toEqual([
			[rootOrigin(a), ref(a)],
			[rootOrigin(b), ref(b)],
		]);
		expect(
			transport
				.posts((text) => text === INTERRUPTED_NOTICE)
				.map((p) => [p.channel, p.threadTs])
				.sort(),
		).toEqual([
			[CH, a],
			[CH, b],
		]);
		expect(daemon.store.getInbound(ref(a))?.state).toBe("failed_notified");
		expect(daemon.store.getInbound(ref(b))?.state).toBe("failed_notified");
	});

	const backfillLines = () => logs.lines.filter((line) => /event=slack_backfill /.test(line));

	/**
	 * One reconnect: the daemon's `onReady` hook runs a backfill pass. Resolves with the pass's summary line and how
	 * many times it read CH's channel history (one per channel target of CH; thread targets read replies instead).
	 */
	async function reconnectPass(): Promise<{ summary: string; channelReads: number }> {
		const before = backfillLines().length;
		const reads = transport.historyReads.length;
		(transport as SlackTransport).onReady?.();
		await logs.waitFor(() => backfillLines().length > before, "backfill pass");
		const channelReads = transport.historyReads.slice(reads).filter((channel) => channel === CH).length;
		return { summary: backfillLines().at(-1) ?? "", channelReads };
	}

	/** Booted with no channel origin row for CH: the startup pass has run (with nothing of CH to scan). */
	async function bootNewChannel(): Promise<void> {
		await boot(() => false);
		await logs.waitFor(() => backfillLines().length >= 1, "startup backfill pass");
		expect(daemon.store.getOrigin(CHANNEL_ORIGIN)).toBeUndefined();
	}

	function rowsOf(ts: string) {
		return daemon.store.listInbound().filter((row) => row.platformMessageId === ref(ts));
	}

	test("D1-1/D1-3: a new channel's missed root — older than the live one — is recovered on reconnect as its own root", async () => {
		await bootNewChannel();
		const missed = tsAt(200);
		const live = tsAt(300);
		await transport.emitMessage(channelMessage(live, "라이브 루트"));
		await transport.waitForPosts((text) => text === "ECHO 라이브 루트");
		expect(daemon.store.getOrigin(CHANNEL_ORIGIN)).toBeUndefined();

		// The missed root B never reached the socket: it is only in the channel history (newest first).
		transport.history.set(CH, [
			{ ts: live, text: "라이브 루트", user: OWNER },
			{ ts: missed, text: "놓친 루트", user: OWNER },
		]);
		const pass = await reconnectPass();
		expect(pass.summary).toMatch(/ scanned=2 recovered=1 /);
		expect(pass.channelReads).toBe(1);
		await transport.waitForPosts((text) => text === "ECHO 놓친 루트");

		expect(rowsOf(missed).map((row) => [row.originKey, row.threadRef])).toEqual([[rootOrigin(missed), ref(missed)]]);
		expect(turnCalls(rootOrigin(missed))).toEqual(["prompt:놓친 루트"]);
		expect(daemon.store.listDeliveries({ originKey: rootOrigin(missed) }).map((d) => [d.threadRef, d.body])).toEqual([
			[ref(missed), "ECHO 놓친 루트"],
		]);
		expect(transport.posts((text) => text === "ECHO 놓친 루트").map((p) => p.threadTs)).toEqual([missed]);
		// Root isolation holds: recovery made no channel-wide origin row and the live root kept its own answer.
		expect(daemon.store.getOrigin(CHANNEL_ORIGIN)).toBeUndefined();
		expect(rowsOf(live).map((row) => row.originKey)).toEqual([rootOrigin(live)]);
		expect(turnCalls(rootOrigin(live))).toEqual(["prompt:라이브 루트"]);
	});

	test("D1-2: several root origins make one channel target; re-delivery and a second reconnect add nothing", async () => {
		await bootNewChannel();
		const first = tsAt(100);
		const missed = tsAt(200);
		const second = tsAt(300);
		await transport.emitMessage(channelMessage(first, "첫 루트"));
		await transport.emitMessage(channelMessage(second, "둘째 루트"));
		await transport.waitForPosts((text) => text === "ECHO 첫 루트" || text === "ECHO 둘째 루트", 2);
		transport.history.set(CH, [
			{ ts: second, text: "둘째 루트", user: OWNER },
			{ ts: missed, text: "놓친 루트", user: OWNER },
			{ ts: first, text: "첫 루트", user: OWNER },
		]);
		// Two root origins of CH, one channel target: the pass reads CH's history once.
		const pass = await reconnectPass();
		expect(pass.summary).toMatch(/ scanned=3 recovered=1 /);
		expect(pass.channelReads).toBe(1);
		await transport.waitForPosts((text) => text === "ECHO 놓친 루트");

		const inboundRows = daemon.store.listInbound().length;
		const deliveries = daemon.store.listDeliveries().length;
		await transport.emitMessage(channelMessage(missed, "놓친 루트"));
		await logs.waitFor(() => logs.count(/event=inbound_duplicate /) >= 1, "live re-delivery duplicate");
		// History is unchanged, so this pass scans nothing new above the watermark — and three root origins still read once.
		const again = await reconnectPass();
		expect(again.channelReads).toBe(1);
		expect(again.summary).toMatch(/ recovered=0 /);

		expect(daemon.store.listInbound()).toHaveLength(inboundRows);
		expect(daemon.store.listDeliveries()).toHaveLength(deliveries);
		expect(rowsOf(missed)).toHaveLength(1);
		expect(turnCalls(rootOrigin(missed))).toEqual(["prompt:놓친 루트"]);
		expect(transport.posts((text) => text === "ECHO 놓친 루트")).toHaveLength(1);
		expect(daemon.store.getOrigin(CHANNEL_ORIGIN)).toBeUndefined();
	});

	test("A-M1-1: after gc removes a quiet channel's only root origin, a reconnect still recovers its missed root", async () => {
		await bootNewChannel();
		const old = tsAt(100);
		await transport.emitMessage(channelMessage(old, "오래된 루트"));
		await transport.waitForPosts((text) => text === "ECHO 오래된 루트");
		transport.history.set(CH, [{ ts: old, text: "오래된 루트", user: OWNER }]);
		// A reconnect while the root origin exists scans CH and stores its channel watermark.
		expect((await reconnectPass()).channelReads).toBe(1);
		expect(daemon.store.getCursor(`ch:${CH}`)).toBe(old);
		await daemon.stop();

		// The root's session directory (the fake omp writes no files, so the session file is laid down here) is fresh:
		// the real gc keeps it inside the 30-day window. Once it is 40 days quiet, gc removes directory and ledger row.
		const sessionDir = sessionDirFor(join(home.dir, "sessions"), rootOrigin(old), 1);
		const originDir = dirname(sessionDir);
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(join(sessionDir, "session.jsonl"), "{}\n");
		const fresh = gcSessions({ homeDir: home.dir, retentionDays: 30, now: Date.now(), dryRun: true });
		expect(fresh.threadOriginsRemoved).toEqual([]);
		expect(fresh.retained).toContain(originDir);
		ageTree(originDir, (Date.now() - 40 * DAY_MS) / 1000);
		const gc = gcSessions({ homeDir: home.dir, retentionDays: 30, now: Date.now() });
		expect(gc.threadOriginsRemoved).toEqual([rootOrigin(old)]);
		expect(existsSync(originDir)).toBe(false);

		const passes = backfillLines().length;
		await boot(() => false);
		await logs.waitFor(() => backfillLines().length > passes, "startup backfill pass");
		expect(daemon.store.listSlackOrigins().filter((origin) => origin.startsWith(CHANNEL_ORIGIN))).toEqual([]);

		// While the bot was down, root B arrived in the now origin-less channel.
		const missed = tsAt(200);
		transport.history.set(CH, [
			{ ts: missed, text: "놓친 루트", user: OWNER },
			{ ts: old, text: "오래된 루트", user: OWNER },
		]);
		const pass = await reconnectPass();
		expect(pass.summary).toMatch(/ recovered=1 /);
		expect(pass.channelReads).toBe(1);
		await transport.waitForPosts((text) => text === "ECHO 놓친 루트");
		expect(rowsOf(missed).map((row) => [row.originKey, row.threadRef])).toEqual([[rootOrigin(missed), ref(missed)]]);
		expect(turnCalls(rootOrigin(missed))).toEqual(["prompt:놓친 루트"]);
		expect(daemon.store.listDeliveries({ originKey: rootOrigin(missed) }).map((d) => [d.threadRef, d.body])).toEqual([
			[ref(missed), "ECHO 놓친 루트"],
		]);
		// No channel-wide origin was made to get there, and the gc'd root stays gone.
		expect(daemon.store.getOrigin(CHANNEL_ORIGIN)).toBeUndefined();
		expect(daemon.store.getOrigin(rootOrigin(old))).toBeUndefined();
	});

	test("A-M1-2: a watermark-only channel the bot left is quarantined after three unreadable passes; others keep recovering", async () => {
		await bootNewChannel();
		// A channel scanned once long ago whose origins gc removed since, and which the bot has left.
		const gone = "C0GONE001";
		daemon.store.setCursor(`ch:${gone}`, tsAt(1));
		const live = tsAt(100);
		await transport.emitMessage(channelMessage(live, "라이브 루트"));
		await transport.waitForPosts((text) => text === "ECHO 라이브 루트");

		const goneReads = () => transport.historyReads.filter((channel) => channel === gone).length;
		for (const strike of [1, 2, 3]) {
			transport.failHistoryNext.set(gone, new SlackCallError("definitive", "slack_platform_error:not_in_channel"));
			const pass = await reconnectPass();
			expect(goneReads()).toBe(strike);
			expect(pass.channelReads).toBe(1);
		}
		expect(logs.count(new RegExp(`event=backfill_read_failed target=ch:${gone} strikes=`))).toBe(2);
		expect(logs.count(new RegExp(`event=backfill_quarantined target=ch:${gone} strikes=3`))).toBe(1);

		// Quarantined: no more reads of the gone channel, while CH still recovers a missed root in the same pass.
		const missed = tsAt(200);
		transport.history.set(CH, [
			{ ts: missed, text: "놓친 루트", user: OWNER },
			{ ts: live, text: "라이브 루트", user: OWNER },
		]);
		const pass = await reconnectPass();
		expect(goneReads()).toBe(3);
		expect(pass.summary).toMatch(/ recovered=1 failed=1 /);
		await transport.waitForPosts((text) => text === "ECHO 놓친 루트");
		expect(rowsOf(missed).map((row) => row.originKey)).toEqual([rootOrigin(missed)]);
	});
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** Sets the access and modification time of a directory tree (gc measures origin activity by newest mtime). */
function ageTree(path: string, seconds: number): void {
	if (statSync(path).isDirectory()) for (const name of readdirSync(path)) ageTree(join(path, name), seconds);
	utimesSync(path, seconds, seconds);
}

describe("router: taskSpec thread binding and restart recovery of two roots", () => {
	let dir: string;
	let store: Store;
	let router: OriginRouter;
	let sessions: FakeSessionStore;
	const clock = { now: () => 1_000_000 };
	const log = createLogger({ sink: () => undefined, clock, redact });

	/** The record the Slack adapter hands the daemon for an owner root message in channel CH. */
	function rootRecord(ts: string, text: string): InboundRecord {
		const result = normalizeInbound({
			userId: OWNER,
			botUserId: "UBOT",
			ownerUserId: OWNER,
			text,
			quoted: [],
			channel: CH,
			ts,
			channelType: "channel",
		});
		if (!result.accept) throw new Error(`root ${ts} rejected: ${result.reason}`);
		return result.inbound;
	}

	/** Same expression as the daemon's taskSpec `threadRef` provider (daemon.ts hostToolsFor). */
	const taskThreadRef = (originKey: string) =>
		router.mailbox(originKey).state.threadRef ?? store.latestInboundThread(originKey);

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ompbot-root-iso-router-"));
		store = openBotStore(join(dir, "ompbot.db"), clock);
		sessions = new FakeSessionStore();
		router = new OriginRouter({
			store,
			clock,
			sessionsRoot: join(dir, "sessions"),
			log,
			statusProvider: () => "status: ok",
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions, holdTurns: true }),
		});
	});

	afterEach(async () => {
		await router.close();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("AC-3: a [TASK] root arriving during root A's turn binds its taskSpec to its own thread", async () => {
		const a = tsAt(100);
		const b = tsAt(200);
		const recordA = rootRecord(a, "inferhub 질문");
		const recordB = rootRecord(b, "[TASK] 새 작업 등록해줘");
		await router.route(recordA);
		await router.route(recordB);
		expect(router.mailbox(recordB.originKey).state.busy).toBe(true);
		expect(taskThreadRef(recordB.originKey)).toBe(ref(b));
		expect(taskThreadRef(recordA.originKey)).toBe(ref(a));
	});

	test("AC-6: restart recovery of two in-flight roots notifies each root's own thread", async () => {
		const a = tsAt(100);
		const b = tsAt(200);
		const recordA = rootRecord(a, "inferhub 질문");
		const recordB = rootRecord(b, "ego 질문");
		await router.route(recordA);
		await router.route(recordB);
		expect(store.listInbound({ state: "dispatched" }).map((row) => row.platformMessageId)).toEqual([ref(a), ref(b)]);
		// The process dies: children stop without a final; the ledger keeps both rows `dispatched`.
		await router.close();

		const result = await recoverDispatched({
			store,
			log,
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		expect(result).toEqual({ answered: 0, interrupted: 2 });
		const notices = store
			.listDeliveries()
			.filter((d) => d.body === INTERRUPTED_NOTICE)
			.map((d) => [d.originKey, d.threadRef]);
		expect(notices).toEqual([
			[recordA.originKey, ref(a)],
			[recordB.originKey, ref(b)],
		]);
		expect(recordA.originKey).not.toBe(recordB.originKey);
	});
});
