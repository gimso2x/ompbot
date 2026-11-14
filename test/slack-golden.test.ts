// Slack behaviour pinned byte for byte before the platform split (doc/plans/discord-channel.md §15): one daemon on a
// FakeSlackTransport runs scenarios ①–⑪ and the call log plus the delivery ledger must equal the frozen JSON. The JSON
// was written once from the code before the split; a change here is a Slack behaviour change, never a fixture refresh.
import { afterAll, beforeAll, expect, type Mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon/daemon";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore, type FakeTurnMessage } from "../src/omp/fake-driver";
import { IDLE_HOST_LOAD } from "../src/ops/host-resources";
import { redact } from "../src/redact";
import { approvalActionId, choiceActionId } from "../src/safety/approval";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import { SlackRateLimitedError } from "../src/slack/transport";
import type { TaskJudgement } from "../src/tasks/checker";
import { acceptanceItems } from "../src/tasks/docs";
import { buildBlockedCard, buildReviewWaitingCard, cardMessage } from "../src/tasks/notify";
import { hasButtons, makeHome, OWNER, type TestHome, WaitingTransport } from "./helpers/bot-home";

const FIXTURE = join(import.meta.dir, "fixtures", "slack-golden.json");
const DM = "D1";
const DM_ORIGIN = `slack/dm/${DM}`;
const CHANNEL = "C1";
/** The DM whose omp child plays the interim script (⑦): a stop answer, a `wait` note, then the turn-end answer. */
const INTERIM_DM = "D2";
const INTERIM_TURN: FakeTurnMessage[] = [
	{
		role: "assistant",
		text: "먼저 찾은 것: 설정 파일 두 곳이 서로 다릅니다. 나머지를 확인하고 있어요.",
		stopReason: "stop",
	},
	{ role: "developer", text: "<system-reminder> session-stop-continuation" },
	{
		role: "assistant",
		text: "⏳ 빌드가 끝날 때까지 기다리는 중이에요. 끝나면 결과를 이어서 알려 드릴게요.",
		stopReason: "toolUse",
		toolCalls: ["wait"],
	},
	{ role: "toolResult", text: "ok" },
	{ role: "assistant", text: "빌드 통과. 두 설정을 하나로 맞췄습니다.", stopReason: "stop" },
];
const T0 = 1_800_000_000_000;
const WAIT_MS = 10_000;

let now = T0;
const clock = { now: () => now };

let home: TestHome;
let daemon: Daemon;
let transport: GoldenTransport;
let slack: SlackChannel;

/** WaitingTransport that also wakes on message updates, so a test can wait for a card's buttons to appear. */
class GoldenTransport extends WaitingTransport {
	#updateWaiters: Array<() => void> = [];

	override async updateMessage(args: {
		channel: string;
		ts: string;
		text: string;
		blocks?: readonly unknown[] | undefined;
	}): Promise<void> {
		await super.updateMessage(args);
		const waiters = this.#updateWaiters;
		this.#updateWaiters = [];
		for (const waiter of waiters) waiter();
	}

	/** Resolves once the message at `ts` carries buttons (posted with them or updated to them). */
	async buttonsShown(ts: string): Promise<void> {
		const shown = () =>
			this.calls.some(
				(call) =>
					(call.method === "postMessage" || call.method === "updateMessage") &&
					call.ts === ts &&
					hasButtons(call.blocks),
			);
		while (!shown()) {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			const timer = setTimeout(() => reject(new Error(`no buttons on ${ts}`)), WAIT_MS);
			this.#updateWaiters.push(() => {
				clearTimeout(timer);
				resolve();
			});
			await promise;
		}
	}
}

/** Every log line, with event-driven waits on new lines (no polling). */
const logLines: string[] = [];
let lineWaiters: Array<() => void> = [];
function nextLogLine(): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(() => reject(new Error(`no new log line; last: ${logLines.at(-1)}`)), WAIT_MS);
	lineWaiters.push(() => {
		clearTimeout(timer);
		resolve();
	});
	return promise;
}

/** Turns started by the omp doubles, handed out in order to whoever waits for the next one. */
class GoldenDriver extends FakeOmpDriver {
	override async prompt(text: string): Promise<string> {
		const opRef = await super.prompt(text);
		startedTurns.push(this);
		for (const waiter of turnWaiters.splice(0)) waiter();
		return opRef;
	}
}
const startedTurns: GoldenDriver[] = [];
const turnWaiters: Array<() => void> = [];
async function nextTurn(): Promise<GoldenDriver> {
	while (startedTurns.length === 0) {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const timer = setTimeout(() => reject(new Error("no omp turn started")), WAIT_MS);
		turnWaiters.push(() => {
			clearTimeout(timer);
			resolve();
		});
		await promise;
	}
	return startedTurns.shift() as GoldenDriver;
}

/** Pumps until `done` holds, re-checking on every new log line. */
async function until(done: () => boolean): Promise<void> {
	for (;;) {
		await daemon.pump();
		if (done()) return;
		await nextLogLine();
	}
}

/** Pumps until no inbound row is still running and no delivery is due or in flight. */
function settle(): Promise<void> {
	return until(
		() =>
			!daemon.store.listInbound().some((row) => row.state === "pending" || row.state === "dispatched") &&
			!daemon.store
				.listDeliveries()
				.some((row) => row.state === "inflight" || (row.state === "pending" && row.nextAt <= now)),
	);
}

/** Releases the next held turn and waits until its answer is delivered. */
async function answerNextTurn(): Promise<void> {
	(await nextTurn()).release();
	await settle();
}

function ownerMessage(channel: string, ts: string, text: string, threadTs?: string): Promise<void> {
	return transport.emitMessage({
		type: "message",
		channel,
		channel_type: channel.startsWith("D") ? "im" : "channel",
		user: OWNER,
		text,
		ts,
		...(threadTs === undefined ? {} : { thread_ts: threadTs }),
	});
}

function click(channel: string, messageTs: string, actionId: string, value: string): Promise<void> {
	return transport.emitBlockAction({
		user: { id: OWNER },
		channel: { id: channel },
		message: { ts: messageTs },
		actions: [{ action_id: actionId, value }],
	});
}

function hostTool(originKey: string, name: string) {
	const tool = daemon.hostToolsFor(originKey).find((t) => t.name === name);
	if (tool === undefined) throw new Error(`no ${name} for ${originKey}`);
	return tool;
}

/** Waits for the next post that starts with `prefix` and returns its ts. */
async function postStartingWith(prefix: string, count = 1): Promise<string> {
	await transport.waitForPosts((text) => text.startsWith(prefix), count, WAIT_MS);
	const post = transport.posts((text) => text.startsWith(prefix))[count - 1];
	if (post === undefined) throw new Error(`no post starting with ${prefix}`);
	return post.ts;
}

/**
 * Stable JSON of a value: the temp home becomes `<HOME>`, the per-process daemon incarnation in op refs becomes
 * `INC`, and a string over 400 characters becomes its length and sha256 (long answers stay exact without bloating
 * the fixture).
 */
function normalize(value: unknown): unknown {
	if (typeof value === "string") {
		const text = value.replaceAll(home.dir, "<HOME>").replace(/^[0-9a-f]{8}-(\d+):/, "INC-$1:");
		if (text.length <= 400) return text;
		return `<${text.length} chars sha256=${createHash("sha256").update(text).digest("hex")}>`;
	}
	if (Array.isArray(value)) return value.map(normalize);
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, normalize(inner)]));
	}
	return value;
}

const steps: Array<{ step: string; calls: unknown[]; result?: unknown }> = [];
let mark = 0;
/** Closes a scenario: the Slack calls it made since the previous one (and what it returned, if anything). */
function record(step: string, result?: unknown): void {
	const calls = transport.calls.slice(mark);
	mark = transport.calls.length;
	steps.push({ step, calls: calls.map(normalize), ...(result === undefined ? {} : { result: normalize(result) }) });
}

/** The host's real load would open `host_pressure` in the status lines on a busy machine: the golden pins it idle. */
let loadavgSpy: Mock<typeof os.loadavg> | undefined;

beforeAll(async () => {
	loadavgSpy = spyOn(os, "loadavg").mockReturnValue([0, 0, 0]);
	home = makeHome("ompbot-golden-");
	transport = new GoldenTransport();
	slack = new SlackChannel(transport);
	const sessions = new FakeSessionStore();
	daemon = new Daemon({
		config: home.config,
		channels: [new SlackBinding(slack)],
		log: createLogger({
			sink: (line) => {
				logLines.push(line);
				const waiters = lineWaiters;
				lineWaiters = [];
				for (const waiter of waiters) waiter();
			},
			clock,
			redact,
		}),
		ompVersion: "omp-test 0",
		bootId: "golden-boot",
		clock,
		hostLoad: IDLE_HOST_LOAD, // the frozen status lines never depend on this machine's load
		sweepMs: 3_600_000,
		gateSweepMs: 0,
		taskSweepMs: 0,
		pendingRetryMs: 0,
		driverFactory: (originKey, sessionDir) =>
			new GoldenDriver({
				sessionDir,
				store: sessions,
				holdTurns: true,
				...(originKey === `slack/dm/${INTERIM_DM}` ? { script: () => INTERIM_TURN, messageEvents: true } : {}),
			}),
	});
	await daemon.start();
	await settle();
	record("boot");
});

afterAll(async () => {
	await daemon.stop();
	home.remove();
	loadavgSpy?.mockRestore();
});

test("Slack scenarios ①–⑪ produce the frozen call log and delivery ledger", async () => {
	// ① DM question → 👀, ⏳ status, answer, ✅.
	await ownerMessage(DM, "1700000000.000100", "안녕, 오늘 할 일 정리해줘");
	await answerNextTurn();
	record("① dm question");

	// ② Channel mention → the answer goes into the root's thread.
	await ownerMessage(CHANNEL, "1700000000.000200", "<@UBOT> 채널에서 묻는 질문");
	await answerNextTurn();
	record("② channel mention");

	// ③ Approval card in the asking DM thread → 승인 click → card rewritten without buttons.
	await ownerMessage(DM, "1700000000.000300", "배포 준비해줘");
	const held = await nextTurn();
	const approval = hostTool(DM_ORIGIN, "ompbot_request_approval").execute(
		{ summary: "force push main" },
		{ signal: new AbortController().signal },
	);
	const cardTs = await postStartingWith("🔐 승인 요청");
	await transport.buttonsShown(cardTs);
	await click(DM, cardTs, approvalActionId("approve", DM, cardTs), "approve");
	const approved = await approval;
	held.release();
	await settle();
	record("③ approval card", approved);

	// ④ Choice card for an omp select dialog → the second button answers it.
	await ownerMessage(DM, "1700000000.000400", "어느 쪽으로 할까");
	const choosing = await nextTurn();
	const answerer = daemon.answerDialogsFor(DM_ORIGIN);
	if (answerer === undefined) throw new Error("no dialog answerer");
	const choice = answerer(
		{ method: "select", id: "dlg-1", title: "배포 대상", options: ["staging", "production"] },
		new AbortController().signal,
	);
	const choiceTs = await postStartingWith("❓");
	await transport.buttonsShown(choiceTs);
	await click(DM, choiceTs, choiceActionId(1, DM, choiceTs), "1");
	const chosen = await choice;
	choosing.release();
	await settle();
	record("④ choice card", chosen);

	// ⑤ [TASK] cards: 머지 on a review card and 추천대로 on a blocked card each become an owner message in the thread.
	const taskThread = "1700000000.000500";
	const tasks = daemon.store.tasks;
	const review = tasks.register({
		title: "로그 회전",
		risk: "L2",
		originKey: `slack/ch/${CHANNEL}/t/${taskThread}`,
		threadRef: `${CHANNEL}:${taskThread}`,
		host: null,
		repo: "/r/repo",
		acceptance: acceptanceItems(["하나", "둘"]),
	});
	tasks.transition(review.taskId, "review", "bot");
	const reviewRow = tasks.get(review.taskId);
	if (reviewRow === undefined) throw new Error("task missing");
	const mergeCard = await slack.post(
		{ conversationId: CHANNEL, threadId: taskThread },
		cardMessage(buildReviewWaitingCard(reviewRow, 24, OWNER), slack),
	);
	await click(CHANNEL, mergeCard.messageId, `ompbot:task:merge:${review.taskId}`, review.taskId);
	await answerNextTurn();
	const blockedThread = "1700000000.000510";
	const blocked = tasks.register({
		title: "캐시 정리",
		risk: "L2",
		originKey: `slack/ch/${CHANNEL}/t/${blockedThread}`,
		threadRef: `${CHANNEL}:${blockedThread}`,
		host: null,
		repo: "/r/repo",
		acceptance: acceptanceItems(["셋"]),
	});
	tasks.transition(blocked.taskId, "blocked", "bot");
	const blockedRow = tasks.get(blocked.taskId);
	if (blockedRow === undefined) throw new Error("task missing");
	const judgement = {
		blockedReason: "DB 경로를 정해야 함",
		decision: { question: "어느 경로?", recommend: "A안: 캐시를 끄고 다시 측정", impact: "재시작 필요" },
		current: "S2",
	} as unknown as TaskJudgement;
	const blockedCard = await slack.post(
		{ conversationId: CHANNEL, threadId: blockedThread },
		cardMessage(buildBlockedCard(blockedRow, judgement, OWNER), slack),
	);
	await click(CHANNEL, blockedCard.messageId, `ompbot:task:recommend:${blocked.taskId}`, "A안: 캐시를 끄고 다시 측정");
	await answerNextTurn();
	record("⑤ task cards");

	// ⑥ `!status` typed in the DM and `/status-ompbot` as a slash command.
	await ownerMessage(DM, "1700000000.000600", "!status");
	await settle();
	const ack = await transport.emitSlash({ command: "/status-ompbot", user_id: OWNER, channel_id: DM });
	await settle();
	record("⑥ status commands", ack);

	// ⑦ Interim answer sent while the turn runs, then the turn-end answer.
	await ownerMessage(INTERIM_DM, "1700000000.000700", "설정 점검해줘");
	const interim = await nextTurn();
	await interim.untilScripted();
	await until(
		() =>
			daemon.store.listDeliveries().filter((row) => row.opRef.includes(":interim:") && row.state === "confirmed")
				.length === 2,
	);
	interim.release();
	await settle();
	record("⑦ interim and turn end");

	// ⑧ A long answer in parts inside the thread, then a top-level (monitor) answer: parts 2+ reply under part 1.
	const longBody = Array.from({ length: 2_400 }, (_, i) => `단어${i}`).join(" ");
	await ownerMessage(DM, "1700000000.000800", `긴 답 시험\n${longBody}`);
	await answerNextTurn();
	daemon.store.recordAnswer({
		originKey: DM_ORIGIN,
		opRef: "golden-top",
		threadRef: `${DM}:-`,
		parts: [Array.from({ length: 2_400 }, (_, i) => `줄${i}`).join(" ")],
	});
	await settle();
	record("⑧ long and top-level answers");

	// ⑨ slack_send_file uploads a workspace file into the conversation's current thread.
	const report = join(home.config.workspaceDir, "report.txt");
	writeFileSync(report, "all green\n");
	const uploaded = await hostTool(DM_ORIGIN, "slack_send_file").execute(
		{ path: report, title: "Report", comment: "결과 파일" },
		{ signal: new AbortController().signal },
	);
	record("⑨ slack_send_file", uploaded);

	// ⑪ A 429 on the answer defers it (nothing counted against attempts); after Retry-After it goes out.
	await ownerMessage(DM, "1700000000.001100", "레이트 리밋 시험");
	const limited = await nextTurn();
	transport.failNext.postMessage = [new SlackRateLimitedError(30_000)];
	limited.release();
	await settle();
	const deferred = daemon.store
		.listDeliveries()
		.filter((row) => row.state === "pending")
		.map((row) => ({ threadRef: row.threadRef, attempts: row.attempts, waitMs: row.nextAt - now }));
	now += 30_000;
	await settle();
	record("⑪ rate limit", { deferred });

	const actual = normalize({
		steps,
		deliveries: daemon.store.listDeliveries().map((row) => ({
			deliveryId: row.deliveryId,
			originKey: row.originKey,
			opRef: row.opRef,
			part: row.part,
			threadRef: row.threadRef,
			body: row.body,
			state: row.state,
			attempts: row.attempts,
			redelivered: row.redelivered,
			lastError: row.lastError,
			sentParts: row.sentParts,
			replyTs: row.replyTs,
		})),
	});
	expect(actual).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
});
