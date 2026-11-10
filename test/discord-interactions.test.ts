// Discord button clicks (doc/plans/discord-channel.md §9): INTERACTION_CREATE type 3 is acknowledged (type 6) before
// the core's onAction runs, strangers get an ephemeral denial, a replayed interaction counts once, and a button's
// `value` lives in the ledger (survives a restart, goes away with the buttons).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DENIED_TEXT } from "../src/channel/text";
import type { CoreSink, DeliverySource } from "../src/channel/types";
import { DiscordAdapter } from "../src/discord/adapter";
import { DiscordChannel } from "../src/discord/channel";
import { FakeDiscordTransport } from "../src/discord/fake-transport";
import type { DiscordInteraction } from "../src/discord/transport";
import { lanePauseActionId } from "../src/lanes/card";
import { createLogger } from "../src/log";
import { redact } from "../src/redact";
import { openStore, type Store } from "../src/store/db";
import { taskRecommendActionId } from "../src/tasks/notify";

const OWNER = "100000000000000001";
const STRANGER = "100000000000000002";
const BOT = "500000000000000000";
const APP = "600000000000000000";
const GUILD = "300000000000000001";
const CH = "111111111111111111";
const THREAD = "222222222222222222";
const DM = "123456789012345678";
const RECOMMEND = "A안: 캐시를 끄고 다시 측정";
const RECOMMEND_ID = taskRecommendActionId("T-20261110-08");

type Action = Parameters<CoreSink["onAction"]>[0];

let dir: string;
let store: Store;
let transport: FakeDiscordTransport;
let actions: Action[];
let logs: string[];
let onAction: (action: Action) => Promise<void> | void;
let seq: bigint;

const noDeliveries: DeliverySource = { claimDue: () => [], confirm: () => {}, fail: () => {}, defer: () => {} };

function core(): CoreSink {
	return {
		onInbound: () => undefined,
		onCommand: () => undefined,
		onAction: (action) => {
			actions.push(action);
			return onAction(action);
		},
	};
}

/** A port wired to the ledger and an adapter over it, the way the binding builds them. */
async function boot(): Promise<{ port: DiscordChannel; adapter: DiscordAdapter }> {
	const port = new DiscordChannel(transport, { ownerUserId: OWNER });
	port.useButtonValues(store);
	const adapter = new DiscordAdapter({
		channel: port,
		core: core(),
		deliveries: noDeliveries,
		ownerUserId: OWNER,
		clock: { now: () => 1_800_000_000_000 },
		log: createLogger({ sink: (line) => logs.push(line), clock: { now: () => 0 }, redact }),
	});
	await adapter.start();
	return { port, adapter };
}

function click(
	customId: string,
	message: { id: string; channelId: string },
	options: { user?: string; guild?: boolean; id?: string } = {},
): DiscordInteraction {
	seq += 1n;
	const user = { id: options.user ?? OWNER };
	const guild = options.guild ?? true;
	return {
		id: options.id ?? String(800_000_000_000_000_000n + seq),
		application_id: APP,
		type: 3,
		token: `token-${seq}`,
		channel_id: message.channelId,
		...(guild ? { guild_id: GUILD, member: { user } } : { user }),
		data: { custom_id: customId, component_type: 2 },
		message: { id: message.id, channel_id: message.channelId },
	};
}

const responses = () => transport.calls.filter((c) => c.method === "respondInteraction");

/** The card in the server thread with one `추천대로` button carrying the recommendation. */
async function threadCard(port: DiscordChannel): Promise<string> {
	const ref = await port.post(
		{ conversationId: CH, threadId: THREAD },
		{ text: "🚧 막힘", buttons: [{ actionId: RECOMMEND_ID, label: "추천대로", value: RECOMMEND, style: "primary" }] },
	);
	return ref.messageId;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-discord-interactions-"));
	store = openStore({ path: join(dir, "ompbot.db"), clock: { now: () => 1_000 }, redact });
	transport = new FakeDiscordTransport({ botUserId: BOT, applicationId: APP });
	transport.setChannel({ id: CH, type: 0, guildId: GUILD });
	transport.setChannel({ id: THREAD, type: 11, parentId: CH, guildId: GUILD });
	actions = [];
	logs = [];
	onAction = () => {};
	seq = 0n;
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("owner clicks", () => {
	test("a click in a server thread: type 6 first, then onAction once with the parent channel, the message id and the stored value", async () => {
		const { port } = await boot();
		const card = await threadCard(port);
		let respondedBeforeAction = -1;
		onAction = () => {
			respondedBeforeAction = responses().length;
		};
		const interaction = click(RECOMMEND_ID, { id: card, channelId: THREAD });
		await transport.emitInteraction(interaction);
		expect(responses()).toEqual([
			{
				method: "respondInteraction",
				interactionId: interaction.id,
				token: interaction.token,
				response: { type: 6 },
			},
		]);
		expect(respondedBeforeAction).toBe(1);
		expect(actions).toEqual([
			{ actionId: RECOMMEND_ID, value: RECOMMEND, userId: OWNER, channel: CH, messageTs: card },
		]);
	});

	test("a slow onAction: the type 6 response is out before onAction finishes", async () => {
		const { port } = await boot();
		const card = await threadCard(port);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		onAction = () => {
			entered.resolve();
			return release.promise;
		};
		const handled = transport.emitInteraction(click(RECOMMEND_ID, { id: card, channelId: THREAD }));
		await entered.promise;
		expect(responses().map((c) => c.method === "respondInteraction" && c.response)).toEqual([{ type: 6 }]);
		release.resolve();
		await handled;
		expect(actions).toHaveLength(1);
	});

	test("a lane status button inside its thread: onAction gets the parent channel, not the thread id", async () => {
		const { port } = await boot();
		// A lane's status message: posted into the lane thread (thread id = root id) with the ⏸ button.
		const status = await port.post(
			{ conversationId: CH, threadId: THREAD },
			{ text: "⏳ 레인 · 0분", buttons: [{ actionId: lanePauseActionId("lane"), label: "⏸ 멈춤" }] },
		);
		expect(transport.calls.find((c) => c.method === "createMessage")).toMatchObject({ channelId: THREAD });
		await transport.emitInteraction(click(lanePauseActionId("lane"), { id: status.messageId, channelId: THREAD }));
		expect(actions).toEqual([
			{
				actionId: lanePauseActionId("lane"),
				value: undefined,
				userId: OWNER,
				channel: CH,
				messageTs: status.messageId,
			},
		]);
	});

	test("a click in a DM: the channel is the DM itself", async () => {
		const { port } = await boot();
		transport.setChannel({ id: DM, type: 1 });
		const ref = await port.post(
			{ conversationId: DM },
			{ text: "카드", buttons: [{ actionId: "ompbot:x:1", label: "예" }] },
		);
		await transport.emitInteraction(click("ompbot:x:1", { id: ref.messageId, channelId: DM }, { guild: false }));
		expect(actions).toEqual([
			{ actionId: "ompbot:x:1", value: undefined, userId: OWNER, channel: DM, messageTs: ref.messageId },
		]);
	});

	test("the same interaction id twice: onAction runs once and Discord gets one response", async () => {
		const { port } = await boot();
		const card = await threadCard(port);
		const interaction = click(RECOMMEND_ID, { id: card, channelId: THREAD });
		await transport.emitInteraction(interaction);
		await transport.emitInteraction(interaction);
		expect(actions).toHaveLength(1);
		expect(responses()).toHaveLength(1);
	});
});

describe("strangers", () => {
	test("a click by someone else: no onAction, an ephemeral DENIED_TEXT response", async () => {
		const { port } = await boot();
		const card = await threadCard(port);
		const interaction = click(RECOMMEND_ID, { id: card, channelId: THREAD }, { user: STRANGER });
		await transport.emitInteraction(interaction);
		expect(actions).toHaveLength(0);
		expect(responses()).toEqual([
			{
				method: "respondInteraction",
				interactionId: interaction.id,
				token: interaction.token,
				response: { type: 4, data: { content: DENIED_TEXT, flags: 64 } },
			},
		]);
		expect(logs.some((line) => line.includes("event=action_denied"))).toBe(true);
	});
});

describe("button values in the ledger", () => {
	test("posted with the card, read back on the click after a restart, gone once an edit removes the buttons", async () => {
		const first = await boot();
		const card = await threadCard(first.port);
		expect(store.getCursor(`btn:${card}:${RECOMMEND_ID}`)).toBe(RECOMMEND);
		await first.adapter.stop();

		// A new process: a new port and adapter over the same ledger.
		const second = await boot();
		await transport.emitInteraction(click(RECOMMEND_ID, { id: card, channelId: THREAD }));
		expect(actions.at(-1)).toMatchObject({ actionId: RECOMMEND_ID, value: RECOMMEND, channel: CH, messageTs: card });

		await second.port.edit(
			{ platform: "discord", conversationId: CH, messageId: card },
			{ text: "처리됨", buttons: [] },
		);
		expect(store.getCursor(`btn:${card}:${RECOMMEND_ID}`)).toBeUndefined();
		// The edit went to the thread the card lives in, learnt from the click.
		expect(transport.calls.at(-1)).toMatchObject({
			method: "editMessage",
			channelId: THREAD,
			messageId: card,
			components: [],
		});
	});
});
