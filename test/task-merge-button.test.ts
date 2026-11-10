import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Daemon } from "../src/daemon/daemon";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import type { FakeCall } from "../src/slack/fake-transport";
import { SlackCallError } from "../src/slack/transport";
import type { TaskJudgement } from "../src/tasks/checker";
import { acceptanceItems } from "../src/tasks/docs";
import type { TaskRow } from "../src/tasks/ledger";
import { buildBlockedCard, formatBlockedNotice, parseTaskRecommendActionId } from "../src/tasks/notify";
import { makeHome, OWNER, type TestHome, WaitingTransport } from "./helpers/bot-home";

const CHANNEL = "C1";
const THREAD = "1700.000100";
const clock = { now: () => Date.now() };

type Update = Extract<FakeCall, { method: "updateMessage" }>;

let home: TestHome;
let daemon: Daemon;
let transport: WaitingTransport;
let logs: string[];

beforeEach(async () => {
	home = makeHome("ompbot-merge-button-");
	logs = [];
	transport = new WaitingTransport();
	const sessions = new FakeSessionStore();
	daemon = new Daemon({
		config: home.config,
		channels: [new SlackBinding(new SlackChannel(transport))],
		log: createLogger({ sink: (line) => logs.push(line), clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot",
		driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
	});
	await daemon.start();
});

afterEach(async () => {
	await daemon.stop();
	home.remove();
});

/** A registered [TASK] in `status`, its thread `threadRef`, and the ts of a card posted in that thread. */
async function seedTask(status: TaskRow["status"], threadRef = `${CHANNEL}:${THREAD}`) {
	const tasks = daemon.store.tasks;
	const row = tasks.register({
		title: "로그 회전",
		risk: "L2",
		originKey: `slack/ch/${CHANNEL}/t/${THREAD}`,
		threadRef,
		host: null,
		repo: "/r/repo",
		acceptance: acceptanceItems(["하나", "둘"]),
	});
	if (status !== "working") tasks.transition(row.taskId, status, "bot");
	const card = await transport.postMessage({ channel: CHANNEL, threadTs: THREAD, text: "🔍 머지 대기 카드" });
	return { taskId: row.taskId, cardTs: card.ts };
}

function click(taskId: string, cardTs: string, user = OWNER): Promise<void> {
	return transport.emitBlockAction({
		user: { id: user },
		channel: { id: CHANNEL },
		message: { ts: cardTs },
		actions: [{ action_id: `ompbot:task:merge:${taskId}`, value: taskId }],
	});
}

const markers = () => transport.posts((text) => text === "🔘 머지 (버튼)");
const mergeInbounds = () => daemon.store.listInbound().filter((row) => row.textRef.trim() === "머지해");
const cardEdits = (ts: string): Update[] =>
	transport.calls.filter((c): c is Update => c.method === "updateMessage" && c.ts === ts);
const typeOf = (block: unknown): unknown =>
	typeof block === "object" && block !== null && "type" in block ? block.type : undefined;
const contextText = (blocks: readonly unknown[] | undefined): string => {
	const last = blocks?.at(-1);
	if (typeOf(last) !== "context" || typeof last !== "object" || last === null || !("elements" in last)) return "";
	return JSON.stringify(last.elements);
};

describe("TASK merge button", () => {
	test("a click on a review task's card: one 🔘 marker and one owner '머지해' in the task thread; the card keeps header and fields, loses the button", async () => {
		const { taskId, cardTs } = await seedTask("review");
		await click(taskId, cardTs);
		expect(markers()).toHaveLength(1);
		expect(markers()[0]).toMatchObject({ channel: CHANNEL, threadTs: THREAD });
		const inbound = mergeInbounds();
		expect(inbound).toHaveLength(1);
		expect(inbound[0]).toMatchObject({ threadRef: `${CHANNEL}:${THREAD}` });
		const blocks = cardEdits(cardTs).at(-1)?.blocks;
		expect(blocks?.[0]).toEqual({
			type: "header",
			text: { type: "plain_text", text: "🔍 머지 대기 · 로그 회전", emoji: true },
		});
		expect(blocks?.some((b) => typeof b === "object" && b !== null && "fields" in b)).toBe(true);
		expect(blocks?.some((b) => typeOf(b) === "actions")).toBe(false);
		expect(contextText(blocks)).toMatch(/"text":"▶ 머지 요청됨 · \d\d:\d\d"/);
		expect(logs.some((l) => l.includes("event=action_ignored"))).toBe(false);
	});

	test("two clicks on the same card without awaiting the first: one inbound, the second is a logged duplicate", async () => {
		const { taskId, cardTs } = await seedTask("review");
		await Promise.all([click(taskId, cardTs), click(taskId, cardTs)]);
		expect(markers()).toHaveLength(1);
		expect(mergeInbounds()).toHaveLength(1);
		expect(logs.filter((l) => l.includes("event=task_merge_ignored") && l.includes("reason=duplicate"))).toHaveLength(
			1,
		);
	});

	test("a task not in review and a task that does not exist: no inbound, task_merge_ignored, the card loses its button", async () => {
		const working = await seedTask("working");
		await click(working.taskId, working.cardTs);
		expect(contextText(cardEdits(working.cardTs).at(-1)?.blocks)).toContain(
			"이미 처리됐거나 머지할 상태가 아님 (working)",
		);
		await click("T-20991231-99", working.cardTs.replace(/\d$/, "9"));
		expect(transport.calls.filter((c) => c.method === "updateMessage").at(-1)).toMatchObject({
			text: "⚠️ 이 TASK를 찾을 수 없음 (T-20991231-99)",
			blocks: [],
		});
		expect(markers()).toHaveLength(0);
		expect(mergeInbounds()).toHaveLength(0);
		expect(logs.filter((l) => l.includes("event=task_merge_ignored"))).toHaveLength(2);
	});

	test("a thread ref that does not parse: no inbound, task_merge_inject_rejected, the card says the request did not go in", async () => {
		const { taskId, cardTs } = await seedTask("review", "not-a-thread");
		await click(taskId, cardTs);
		expect(markers()).toHaveLength(0);
		expect(mergeInbounds()).toHaveLength(0);
		expect(logs.some((l) => l.includes("event=task_merge_inject_rejected") && l.includes("reason=bad_thread"))).toBe(
			true,
		);
		expect(contextText(cardEdits(cardTs).at(-1)?.blocks)).toContain("⚠️ 머지 요청을 넣지 못함");
	});

	test("the marker post fails: no inbound, task_merge_inject_rejected, the card note turns into the reply hint", async () => {
		const { taskId, cardTs } = await seedTask("review");
		transport.failNext.postMessage = [new SlackCallError("definitive", "slack_platform_error:channel_not_found")];
		await click(taskId, cardTs);
		expect(mergeInbounds()).toHaveLength(0);
		const rejected = logs.filter((l) => l.includes("event=task_merge_inject_rejected"));
		expect(rejected).toHaveLength(1);
		expect(rejected[0]).toContain("reason=error");
		expect(rejected[0]).not.toContain("marker=");
		const edits = cardEdits(cardTs);
		expect(contextText(edits[0]?.blocks)).toMatch(/▶ 머지 요청됨/);
		expect(contextText(edits.at(-1)?.blocks)).toContain("⚠️ 머지 요청을 넣지 못함");
	});
});

describe("blocked card: 추천대로 button", () => {
	const row = {
		taskId: "T-20261109-07",
		title: "로그 회전",
		agent: "t-20261109-07",
		host: null,
		branch: "task/T-20261109-07",
	} as unknown as TaskRow;
	const judged = (recommend: string) =>
		({
			blockedReason: "DB 경로를 정해야 함",
			decision: { question: "어느 경로?", recommend, impact: "재시작 필요" },
			current: "S2",
		}) as unknown as TaskJudgement;

	test("a recommendation gives one primary 추천대로 button carrying it; none without one", () => {
		const card = buildBlockedCard(row, judged("A안: /var/lib xoxb-TEST-0"), OWNER, "https://board/x");
		expect(card.buttons).toEqual([
			{
				actionId: "ompbot:task:recommend:T-20261109-07",
				label: "추천대로",
				value: "A안: /var/lib [REDACTED]",
				style: "primary",
			},
		]);
		expect(card.note).toBe(
			"추천대로 = 위 추천 그대로 진행 · 다른 결정은 이 스레드에 답장 · 작업 보드: https://board/x",
		);
		expect(parseTaskRecommendActionId("ompbot:task:recommend:T-20261109-07")).toBe("T-20261109-07");
		expect(parseTaskRecommendActionId("ompbot:task:merge:T-20261109-07")).toBeUndefined();
		const without = buildBlockedCard(row, judged(""), OWNER);
		expect(without.buttons).toBeUndefined();
		expect(without.note).toBeUndefined();
	});

	test("formatBlockedNotice is byte for byte what it was before the button", () => {
		expect(formatBlockedNotice(row, judged("A안: /var/lib"), OWNER, "https://board/x")).toBe(
			`🚧 멈춤 · 로그 회전 — 결정이 필요합니다. (local/t-20261109-07 · T-20261109-07) {{mention:${OWNER}}}\n\n*사유*: DB 경로를 정해야 함\n*질문*: 어느 경로?\n*추천*: A안: /var/lib\n*영향*: 재시작 필요\n*지금 단계*: S2\n*답하는 법*: 이 스레드에 결정을 적어 주시면 그 답을 담당 에이전트에 넘겨 재개합니다.\n\n작업 보드\nhttps://board/x`,
		);
		expect(formatBlockedNotice(row, judged(""), OWNER)).toBe(
			`🚧 멈춤 · 로그 회전 — 결정이 필요합니다. (local/t-20261109-07 · T-20261109-07) {{mention:${OWNER}}}\n\n*사유*: DB 경로를 정해야 함\n*질문*: 어느 경로?\n*영향*: 재시작 필요\n*지금 단계*: S2\n*답하는 법*: 이 스레드에 결정을 적어 주시면 그 답을 담당 에이전트에 넘겨 재개합니다.`,
		);
	});
});

describe("TASK recommend button (막힘 카드 추천대로)", () => {
	const RECOMMEND = "A안: 캐시를 끄고 다시 측정";
	const recommendClick = (taskId: string, cardTs: string, value = RECOMMEND): Promise<void> =>
		transport.emitBlockAction({
			user: { id: OWNER },
			channel: { id: CHANNEL },
			message: { ts: cardTs },
			actions: [{ action_id: `ompbot:task:recommend:${taskId}`, value }],
		});
	const recommendMarkers = () => transport.posts((text) => text === "🔘 추천대로 (버튼)");
	const recommendInbounds = () => daemon.store.listInbound().filter((row) => row.textRef.trim().startsWith("추천대로"));

	test("a click on a blocked task's card: one 🔘 marker and one owner '추천대로 (추천: …)' in the task thread; the card loses its button and keeps the recommendation in its note", async () => {
		const { taskId, cardTs } = await seedTask("blocked");
		await recommendClick(taskId, cardTs);
		expect(recommendMarkers()).toHaveLength(1);
		expect(recommendMarkers()[0]).toMatchObject({ channel: CHANNEL, threadTs: THREAD });
		const inbound = recommendInbounds();
		expect(inbound).toHaveLength(1);
		expect(inbound[0]?.textRef.trim().startsWith(`추천대로 (추천: ${RECOMMEND})`)).toBe(true);
		expect(inbound[0]).toMatchObject({ threadRef: `${CHANNEL}:${THREAD}` });
		const blocks = cardEdits(cardTs).at(-1)?.blocks;
		expect(blocks?.[0]).toEqual({
			type: "header",
			text: { type: "plain_text", text: "🚧 막힘 · 로그 회전", emoji: true },
		});
		expect(blocks?.some((b) => typeOf(b) === "actions")).toBe(false);
		expect(contextText(blocks)).toMatch(
			/"text":"▶ 추천대로 진행 요청됨 · \d\d:\d\d — 추천: A안: 캐시를 끄고 다시 측정"/,
		);
		expect(logs.some((l) => l.includes("event=action_ignored"))).toBe(false);
	});

	test("two clicks on the same card without awaiting the first: one inbound, the second is a logged duplicate", async () => {
		const { taskId, cardTs } = await seedTask("blocked");
		await Promise.all([recommendClick(taskId, cardTs), recommendClick(taskId, cardTs)]);
		expect(recommendMarkers()).toHaveLength(1);
		expect(recommendInbounds()).toHaveLength(1);
		expect(
			logs.filter((l) => l.includes("event=task_recommend_ignored") && l.includes("reason=duplicate")),
		).toHaveLength(1);
	});

	test("a task that is not blocked and a task that does not exist: no inbound, the card note says it is already handled", async () => {
		const working = await seedTask("working");
		await recommendClick(working.taskId, working.cardTs);
		expect(contextText(cardEdits(working.cardTs).at(-1)?.blocks)).toContain(
			"이미 처리됐거나 막힌 상태가 아님 (working)",
		);
		const missingTs = working.cardTs.replace(/\d$/, "9");
		await recommendClick("T-20991231-99", missingTs);
		const missingEdit = cardEdits(missingTs).at(-1);
		expect(missingEdit?.text).toStartWith("이미 처리됐거나");
		expect(missingEdit?.blocks).toEqual([]);
		expect(recommendMarkers()).toHaveLength(0);
		expect(recommendInbounds()).toHaveLength(0);
		expect(logs.filter((l) => l.includes("event=task_recommend_ignored"))).toHaveLength(2);
	});

	test("a thread ref that does not parse: no inbound, task_recommend_inject_rejected, the card says the recommendation did not go in", async () => {
		const { taskId, cardTs } = await seedTask("blocked", "not-a-thread");
		await recommendClick(taskId, cardTs);
		expect(recommendMarkers()).toHaveLength(0);
		expect(recommendInbounds()).toHaveLength(0);
		expect(
			logs.some((l) => l.includes("event=task_recommend_inject_rejected") && l.includes("reason=bad_thread")),
		).toBe(true);
		expect(contextText(cardEdits(cardTs).at(-1)?.blocks)).toContain("⚠️ 추천을 넣지 못함");
	});

	test("the marker post fails: no inbound, task_recommend_inject_rejected, the card note turns into the reply hint", async () => {
		const { taskId, cardTs } = await seedTask("blocked");
		transport.failNext.postMessage = [new SlackCallError("definitive", "slack_platform_error:channel_not_found")];
		await recommendClick(taskId, cardTs);
		expect(recommendInbounds()).toHaveLength(0);
		const rejected = logs.filter((l) => l.includes("event=task_recommend_inject_rejected"));
		expect(rejected).toHaveLength(1);
		expect(rejected[0]).toContain("reason=error");
		const edits = cardEdits(cardTs);
		expect(contextText(edits[0]?.blocks)).toMatch(/▶ 추천대로 진행 요청됨/);
		expect(contextText(edits.at(-1)?.blocks)).toContain("⚠️ 추천을 넣지 못함");
	});
});
