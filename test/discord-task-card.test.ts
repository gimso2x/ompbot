// [TASK] card buttons on Discord (doc/plans/discord-channel.md §9): 머지 and 추천대로 clicks go through the same
// core.onAction → #handleTaskCardButton path as Slack and become an owner message in the task's Discord thread.
// 추천대로 has its recommendation back from the ledger: Discord buttons carry no value.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChannelBinding } from "../src/channel/adapter";
import { Daemon } from "../src/daemon/daemon";
import { DiscordBinding } from "../src/discord/binding";
import { DiscordChannel } from "../src/discord/channel";
import type { FakeDiscordCall } from "../src/discord/fake-transport";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import type { TaskJudgement } from "../src/tasks/checker";
import { acceptanceItems } from "../src/tasks/docs";
import type { TaskRow } from "../src/tasks/ledger";
import {
	buildBlockedCard,
	buildReviewWaitingCard,
	cardMessage,
	taskMergeActionId,
	taskRecommendActionId,
} from "../src/tasks/notify";
import {
	DISCORD_OWNER,
	makeHome,
	type TestHome,
	WaitingDiscordTransport,
	WaitingTransport,
	withDiscord,
} from "./helpers/bot-home";

const GUILD = "300000000000000001";
const CH = "111111111111111111";
const THREAD = "222222222222222222";
const RECOMMEND = "A안: 캐시를 끄고 다시 측정";
const clock = { now: () => Date.now() };

let home: TestHome;
let daemon: Daemon;
let discord: WaitingDiscordTransport;
let port: DiscordChannel;
let logs: string[];

beforeEach(async () => {
	home = makeHome("ompbot-discord-task-card-");
	logs = [];
	discord = new WaitingDiscordTransport();
	discord.setChannel({ id: CH, type: 0, guildId: GUILD });
	discord.setChannel({ id: THREAD, type: 11, parentId: CH, guildId: GUILD });
	port = new DiscordChannel(discord, { ownerUserId: DISCORD_OWNER });
	const sessions = new FakeSessionStore();
	const channels: ChannelBinding[] = [
		new SlackBinding(new SlackChannel(new WaitingTransport())),
		new DiscordBinding(port),
	];
	daemon = new Daemon({
		config: withDiscord(home),
		channels,
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

/** A [TASK] registered from the Discord server thread, moved to `status`. */
function seedTask(status: TaskRow["status"]): TaskRow {
	const tasks = daemon.store.tasks;
	const row = tasks.register({
		title: "로그 회전",
		risk: "L2",
		originKey: `discord/ch/${CH}/t/${THREAD}`,
		threadRef: `${CH}:${THREAD}`,
		host: null,
		repo: "/r/repo",
		acceptance: acceptanceItems(["하나", "둘"]),
	});
	tasks.transition(row.taskId, status, "bot");
	const updated = tasks.get(row.taskId);
	if (updated === undefined) throw new Error("task missing");
	return updated;
}

let seq = 0n;
function click(customId: string, card: string): Promise<void> {
	seq += 1n;
	return discord.emitInteraction({
		id: String(800_000_000_000_000_000n + seq),
		application_id: "600000000000000000",
		type: 3,
		token: `token-${seq}`,
		channel_id: THREAD,
		guild_id: GUILD,
		member: { user: { id: DISCORD_OWNER } },
		data: { custom_id: customId, component_type: 2 },
		message: { id: card, channel_id: THREAD },
	});
}

const inboundTexts = () => daemon.store.listInbound().map((row) => [row.threadRef, row.textRef.trim()]);
const cardCleared = (card: string) =>
	discord.waitForCall(
		(c: FakeDiscordCall) =>
			c.method === "editMessage" &&
			c.messageId === card &&
			c.channelId === THREAD &&
			Array.isArray(c.components) &&
			c.components.length === 0,
	);

describe("Discord [TASK] card buttons", () => {
	test("머지 on a review card: the 🔘 marker and an owner '머지해' in the task thread, the card loses its button", async () => {
		const row = seedTask("review");
		const card = await port.post(
			{ conversationId: CH, threadId: THREAD },
			cardMessage(buildReviewWaitingCard(row, 24, DISCORD_OWNER), port),
		);
		const posted = discord.calls.find((c) => c.method === "createMessage" && c.id === card.messageId);
		expect(JSON.stringify(posted)).toContain(taskMergeActionId(row.taskId));
		await click(taskMergeActionId(row.taskId), card.messageId);
		expect(discord.posts((text) => text === "🔘 머지 (버튼)").map((p) => p.channelId)).toEqual([THREAD]);
		expect(inboundTexts()).toContainEqual([`${CH}:${THREAD}`, "머지해"]);
		expect(logs.some((line) => line.includes("event=task_merge_requested"))).toBe(true);
		await cardCleared(card.messageId);
		expect(logs.some((line) => line.includes("event=action_ignored"))).toBe(false);
	});

	test("추천대로 on a blocked card: the owner text carries the recommendation the ledger kept for the button", async () => {
		const row = seedTask("blocked");
		const judgement = {
			blockedReason: "DB 경로를 정해야 함",
			decision: { question: "어느 경로?", recommend: RECOMMEND, impact: "재시작 필요" },
			current: "S2",
		} as unknown as TaskJudgement;
		const card = await port.post(
			{ conversationId: CH, threadId: THREAD },
			cardMessage(buildBlockedCard(row, judgement, DISCORD_OWNER), port),
		);
		await click(taskRecommendActionId(row.taskId), card.messageId);
		expect(discord.posts((text) => text === "🔘 추천대로 (버튼)").map((p) => p.channelId)).toEqual([THREAD]);
		expect(inboundTexts()).toContainEqual([`${CH}:${THREAD}`, `추천대로 (추천: ${RECOMMEND})`]);
		expect(logs.some((line) => line.includes("event=task_recommend_requested"))).toBe(true);
		await cardCleared(card.messageId);
	});
});
