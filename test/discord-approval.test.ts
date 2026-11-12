// Approval and choice cards in a Discord conversation (doc/plans/discord-channel.md §9): the card goes up with buttons
// in that conversation (never Slack's escalation channel), a click settles the waiting tool call through the same
// core.onAction path as Slack, and the card is redrawn without buttons. A reply still settles it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChannelBinding } from "../src/channel/adapter";
import { Daemon } from "../src/daemon/daemon";
import { DiscordBinding } from "../src/discord/binding";
import { DiscordChannel } from "../src/discord/channel";
import type { DiscordInteraction } from "../src/discord/transport";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { approvalActionId, choiceActionId } from "../src/safety/approval";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import {
	DISCORD_OWNER,
	makeHome,
	type TestHome,
	WaitingDiscordTransport,
	WaitingTransport,
	withDiscord,
} from "./helpers/bot-home";
import type { FakeDiscordCall } from "./helpers/discord-fake-transport";

const ESCALATION = "C0ESCALATE1";
const DM = "123456789012345678";
const ORIGIN = `discord/dm/${DM}`;
const clock = { now: () => Date.now() };

type Edit = Extract<FakeDiscordCall, { method: "editMessage" }>;

let home: TestHome;
let daemon: Daemon | undefined;
let slack: WaitingTransport;
let discord: WaitingDiscordTransport;
let seq: bigint;

async function boot(approvalTimeoutMs?: number): Promise<void> {
	slack = new WaitingTransport();
	discord = new WaitingDiscordTransport();
	discord.setChannel({ id: DM, type: 1 });
	const sessions = new FakeSessionStore();
	const channels: ChannelBinding[] = [
		new SlackBinding(new SlackChannel(slack)),
		new DiscordBinding(new DiscordChannel(discord, { ownerUserId: DISCORD_OWNER })),
	];
	daemon = new Daemon({
		config: { ...withDiscord(home), escalationChannel: ESCALATION },
		channels,
		log: createLogger({ sink: () => undefined, clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot",
		driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		...(approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs }),
	});
	await daemon.start();
}

function ask(summary = "force push main"): Promise<string> {
	const tool = daemon?.hostToolsFor(ORIGIN).find((t) => t.name === "ompbot_request_approval");
	if (!tool) throw new Error("tool missing");
	return tool.execute({ summary }, { signal: new AbortController().signal });
}

const isEdit = (call: FakeDiscordCall): call is Edit => call.method === "editMessage";
const buttonCount = (call: Edit): number =>
	(call.components as ReadonlyArray<{ components: unknown[] }> | undefined)?.reduce(
		(sum, row) => sum + row.components.length,
		0,
	) ?? 0;

/** The message id of the first card that got its buttons. */
async function shownCard(): Promise<string> {
	const call = await discord.waitForCall((c) => isEdit(c) && buttonCount(c) > 0);
	return (call as Edit).messageId;
}

/** The edit that took the card's buttons away. */
async function settledCard(card: string): Promise<Edit> {
	return (await discord.waitForCall(
		(c) => isEdit(c) && c.messageId === card && Array.isArray(c.components) && c.components.length === 0,
	)) as Edit;
}

function click(customId: string, card: string): Promise<void> {
	seq += 1n;
	const interaction: DiscordInteraction = {
		id: String(800_000_000_000_000_000n + seq),
		application_id: "600000000000000000",
		type: 3,
		token: `token-${seq}`,
		channel_id: DM,
		user: { id: DISCORD_OWNER },
		data: { custom_id: customId, component_type: 2 },
		message: { id: card, channel_id: DM },
	};
	return discord.emitInteraction(interaction);
}

/** Nothing about the request reached Slack, the escalation channel included. */
function expectSlackUntouched(): void {
	expect(slack.calls.filter((call) => JSON.stringify(call).includes("승인 요청"))).toHaveLength(0);
	expect(slack.calls.filter((call) => JSON.stringify(call).includes(ESCALATION))).toHaveLength(0);
}

beforeEach(() => {
	home = makeHome("ompbot-discord-approval-");
	seq = 0n;
});

afterEach(async () => {
	await daemon?.stop();
	daemon = undefined;
	home.remove();
});

describe("approval card on Discord", () => {
	test("the card goes up in the Discord DM with 승인·거부 buttons; 승인 resolves `approved` and the card loses its buttons", async () => {
		await boot();
		const result = ask();
		const card = await shownCard();
		const post = discord.posts((text) => text.includes("force push main"))[0];
		expect(post?.channelId).toBe(DM);
		const shown = discord.calls.find((c) => isEdit(c) && buttonCount(c) > 0) as Edit;
		expect(JSON.stringify(shown.components)).toContain(approvalActionId("approve", DM, card));
		expect(JSON.stringify(shown.components)).toContain(approvalActionId("deny", DM, card));
		await click(approvalActionId("approve", DM, card), card);
		expect(await result).toBe("approved");
		expect((await settledCard(card)).content).toContain("✅ 승인됨");
		expectSlackUntouched();
	});

	test("거부 resolves `denied`", async () => {
		await boot();
		const result = ask();
		const card = await shownCard();
		await click(approvalActionId("deny", DM, card), card);
		expect(await result).toBe("denied");
		expect((await settledCard(card)).content).toContain("⛔ 거부됨");
		expectSlackUntouched();
	});

	test("a reply to the card settles it (onCardReply) and the card loses its buttons", async () => {
		await boot();
		const result = ask();
		const card = await shownCard();
		await discord.emitMessage({
			id: "700000000000000009",
			channel_id: DM,
			author: { id: DISCORD_OWNER },
			content: "그래 진행해",
			type: 19,
			message_reference: { message_id: card, channel_id: DM },
		});
		expect(await result).toBe("replied: 그래 진행해");
		expect((await settledCard(card)).content).toContain("💬 답장으로 처리됨");
		expectSlackUntouched();
	});

	test("an unanswered card times out: `denied (timeout)` and the card says so without buttons", async () => {
		await boot(1);
		const result = ask();
		expect(await result).toBe("denied (timeout)");
		const card = await shownCard();
		expect((await settledCard(card)).content).toContain("⌛ 시간 초과: 거부로 처리됨");
		expectSlackUntouched();
	});
});

describe("choice card on Discord", () => {
	test("button n answers the select dialog with option n", async () => {
		await boot();
		const answerer = daemon?.answerDialogsFor(ORIGIN);
		if (answerer === undefined) throw new Error("no dialog answerer");
		const choice = answerer(
			{ method: "select", id: "dlg-1", title: "배포 대상", options: ["staging", "production"] },
			new AbortController().signal,
		);
		const card = await shownCard();
		await click(choiceActionId(1, DM, card), card);
		expect(await choice).toEqual({ value: "production" });
		expect((await settledCard(card)).content).toContain("production");
	});

	test("an ask dialog goes out with buttons (recommended PRIMARY=1, the rest 2) and a click answers with that option", async () => {
		await boot();
		const answerer = daemon?.answerDialogsFor(ORIGIN);
		if (answerer === undefined) throw new Error("no dialog answerer");
		const answer = answerer(
			{
				method: "ask",
				id: "dlg-2",
				questions: [
					{
						id: "q1",
						question: "어디에 배포할까요?",
						options: [{ label: "staging" }, { label: "production" }],
						recommended: 0,
					},
				],
			},
			new AbortController().signal,
		);
		const card = await shownCard();
		const shown = discord.calls.find((c) => isEdit(c) && buttonCount(c) > 0) as Edit;
		// The wire shape of Discord components: Action Rows of buttons.
		const rows = shown.components as ReadonlyArray<{
			components: ReadonlyArray<{ style: number; label: string; custom_id: string }>;
		}>;
		const buttons = rows.flatMap((row) => row.components);
		expect(buttons.map((b) => [b.label, b.style])).toEqual([
			["staging", 1],
			["production", 2],
		]);
		expect(buttons.map((b) => b.custom_id)).toEqual([0, 1].map((n) => choiceActionId(n, DM, card)));
		await click(choiceActionId(1, DM, card), card);
		expect(await answer).toEqual({ answers: [{ id: "q1", selectedOptions: ["production"] }] });
		expect((await settledCard(card)).content).toContain("✅ 답: 1) production");
		expectSlackUntouched();
	});
});
