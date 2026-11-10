// Work lanes on Discord (doc/plans/discord-parity.md stage 2): a lane lives in a Discord thread of a server text
// channel — root in the parent, a thread started from it, status and cards inside — and the owner drives it with the
// same words and buttons as on Slack. Everything git-related stays on this machine; Discord is a fake transport.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { OmpbotConfig } from "../src/config";
import { Daemon } from "../src/daemon/daemon";
import { DiscordBinding } from "../src/discord/binding";
import { DiscordChannel } from "../src/discord/channel";
import type { FakeDiscordCall } from "../src/discord/fake-transport";
import { DiscordCallError } from "../src/discord/transport";
import { laneDiscardActionId, laneMergeActionId, lanePauseActionId, laneResumeActionId } from "../src/lanes/card";
import { PROGRESS_INTERVAL_MS } from "../src/lanes/manager";
import type { LaneRow } from "../src/lanes/status";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { floorsArgs } from "../src/safety/prompt";
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
import { git, makeRepo } from "./helpers/git-fixtures";
import { removeRepoAndWorktrees } from "./helpers/lane-harness";

// gitleaks:allow (fake snowflakes below)
const GUILD = "900000000000000000";
const CH = "111111111111111111";
const ASK_THREAD = "222222222222222222";
const LANE_CH = "333333333333333333";
const DM = "123456789012345678";
const THREAD_ORIGIN = `discord/ch/${CH}/t/${ASK_THREAD}`;
const DM_ORIGIN = `discord/dm/${DM}`;
const signal = new AbortController().signal;

type Create = Extract<FakeDiscordCall, { method: "createMessage" }>;
type Edit = Extract<FakeDiscordCall, { method: "editMessage" }>;

let home: TestHome;
let repos: string[];
let daemons: Daemon[];
let slack: WaitingTransport;
let now: number;
let seq: bigint;

beforeEach(() => {
	home = makeHome("ompbot-discord-lanes-");
	repos = [];
	daemons = [];
	now = Date.now();
	seq = 0n;
});

afterEach(async () => {
	for (const daemon of daemons) await daemon.stop();
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
});

/** A Discord transport that knows the server channels (and, after a restart, the lane threads) of the test. */
function discordTransport(threads: Array<{ id: string; parentId: string }> = []): WaitingDiscordTransport {
	const transport = new WaitingDiscordTransport();
	for (const id of [CH, LANE_CH]) transport.setChannel({ id, type: 0, guildId: GUILD });
	transport.setChannel({ id: ASK_THREAD, type: 11, parentId: CH, guildId: GUILD });
	for (const thread of threads) transport.setChannel({ ...thread, type: 11, guildId: GUILD });
	return transport;
}

async function boot(discord: WaitingDiscordTransport, laneChannelId?: string): Promise<Daemon> {
	slack = new WaitingTransport();
	const config = withDiscord(home);
	const discordConfig = config.channels.discord as NonNullable<OmpbotConfig["channels"]["discord"]>;
	const sessions = new FakeSessionStore();
	const daemon = new Daemon({
		config: {
			...config,
			channels: {
				...config.channels,
				discord: { ...discordConfig, ...(laneChannelId === undefined ? {} : { laneChannelId }) },
			},
		},
		channels: [
			new SlackBinding(new SlackChannel(slack)),
			new DiscordBinding(new DiscordChannel(discord, { ownerUserId: DISCORD_OWNER })),
		],
		log: createLogger({ sink: () => undefined, clock: { now: () => now }, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot",
		clock: { now: () => now },
		stopDrainMs: 10,
		driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
	});
	daemons.push(daemon);
	await daemon.start();
	return daemon;
}

const nextId = (): string => {
	seq += 1n;
	return String(710_000_000_000_000_000n + seq);
};

const creates = (discord: WaitingDiscordTransport, match: (call: Create) => boolean): Create[] =>
	discord.calls.filter((call): call is Create => call.method === "createMessage" && match(call));

const edits = (discord: WaitingDiscordTransport, match: (call: Edit) => boolean): Edit[] =>
	discord.calls.filter((call): call is Edit => call.method === "editMessage" && match(call));

const customIds = (components: unknown): string[] =>
	((components as Array<{ components: Array<{ custom_id: string }> }> | undefined) ?? []).flatMap((row) =>
		row.components.map((button) => button.custom_id),
	);

async function workStart(daemon: Daemon, origin: string, title: string, repo: string): Promise<unknown> {
	const tool = daemon.hostToolsFor(origin).find((candidate) => candidate.name === "ompbot_work_start");
	if (!tool) throw new Error(`ompbot_work_start missing for ${origin}`);
	return tool.execute({ title, cwd: repo }, { signal });
}

/** Starts a lane from the owner's server thread and waits for its first turn's answer in the lane thread. */
async function startLane(
	daemon: Daemon,
	discord: WaitingDiscordTransport,
	title: string,
): Promise<{ lane: LaneRow; root: Create; result: unknown }> {
	const repo = makeRepo(repos);
	const result = await workStart(daemon, THREAD_ORIGIN, title, repo);
	const root = creates(discord, (call) => call.content === `🔄 ${title}`)[0];
	if (root === undefined) throw new Error("no lane root posted");
	await discord.waitForPosts((text) => text.includes("ECHO ulw explore"));
	const lane = daemon.store.getLane(title);
	if (lane === undefined) throw new Error("no lane row");
	return { lane, root, result };
}

function ownerInThread(discord: WaitingDiscordTransport, thread: string, content: string): Promise<void> {
	return discord.emitMessage({
		id: nextId(),
		channel_id: thread,
		guild_id: GUILD,
		author: { id: DISCORD_OWNER },
		content,
		type: 0,
	});
}

function click(discord: WaitingDiscordTransport, customId: string, message: { id: string; channelId: string }) {
	const id = nextId();
	return discord.emitInteraction({
		id,
		application_id: "600000000000000000",
		type: 3,
		token: `token-${id}`,
		channel_id: message.channelId,
		guild_id: GUILD,
		member: { user: { id: DISCORD_OWNER } },
		data: { custom_id: customId, component_type: 2 },
		message: { id: message.id, channel_id: message.channelId },
	});
}

/** Commits a file in the lane worktree and claims it done; resolves once the Outcome card is in the lane thread. */
async function claim(daemon: Daemon, discord: WaitingDiscordTransport, lane: LaneRow, file: string): Promise<Create> {
	const cards = () => creates(discord, (call) => (call.content ?? "").includes("머지 대기"));
	const before = cards().length;
	writeFileSync(join(lane.cwd, file), `${file}\n`);
	git(lane.cwd, "add", "--", file);
	git(lane.cwd, "commit", "-q", "-m", `add ${file}`);
	const tool = daemon.hostToolsFor(lane.originKey).find((candidate) => candidate.name === "ompbot_claim_done");
	await tool?.execute({ repo: lane.cwd, commit: "HEAD", summary: `${file} 추가` }, { signal });
	await discord.waitForPosts((text) => text.includes("머지 대기"), before + 1);
	const card = cards()[before];
	if (card === undefined) throw new Error("no Outcome card");
	return card;
}

describe("a lane started from a Discord server thread", () => {
	test("root in the parent channel, a thread started from it, status with ⏸ inside; threadRef is <parent>:<root>", async () => {
		const discord = discordTransport();
		const daemon = await boot(discord);
		const { lane, root, result } = await startLane(daemon, discord, "d-lane");

		expect(root.channelId).toBe(CH);
		expect(root.messageReference).toBeUndefined();
		const started = discord.calls.findIndex((call) => call.method === "startThread");
		expect(discord.calls[started]).toMatchObject({
			method: "startThread",
			channelId: CH,
			messageId: root.id,
			name: "d-lane",
		});
		const status = creates(discord, (call) => (call.content ?? "").startsWith("⏳ d-lane"))[0];
		expect(status?.channelId).toBe(root.id);
		expect(customIds(status?.components)).toEqual([lanePauseActionId("d-lane")]);
		expect(discord.calls.indexOf(root)).toBeLessThan(started);
		expect(started).toBeLessThan(discord.calls.indexOf(status as Create));
		expect(lane.threadRef).toBe(`${CH}:${root.id}`);
		expect(lane.meta.statusTs).toBe(status?.id);
		// The tool's answer carries the lane thread's link, which the session passes on to the owner.
		expect(String(result)).toContain(`https://discord.com/channels/${GUILD}/${root.id}`);
		// The first turn's answer is in the lane thread; Slack saw nothing.
		expect(creates(discord, (call) => (call.content ?? "").includes("ECHO ulw explore"))[0]?.channelId).toBe(root.id);
		expect(slack.posts()).toHaveLength(0);
		// The lane session uploads and is told to upload with the Discord tool.
		const names = daemon.hostToolsFor(lane.originKey).map((tool) => tool.name);
		expect(names).toContain("discord_send_file");
		expect(names).not.toContain("slack_send_file");
		const prompt = floorsArgs(
			"/s",
			lane.originKey,
			undefined,
			undefined,
			false,
			false,
			false,
			daemon.floorsSurfaceFor(lane.originKey),
		)[1];
		expect(prompt).toContain("discord_send_file");
		expect(prompt).not.toContain("slack_send_file");
	});

	test("unmentioned owner messages in the lane thread reach the lane; 멈춰·계속·!reopen·폐기해 act as on Slack", async () => {
		const discord = discordTransport();
		const daemon = await boot(discord);
		const { lane, root } = await startLane(daemon, discord, "t-lane");
		const thread = root.id;

		await ownerInThread(discord, thread, "멈춰");
		await discord.waitForPosts((text) => text.includes("멈췄습니다"));
		expect(daemon.store.getLane("t-lane")?.status).toBe("paused");
		expect(creates(discord, (call) => (call.content ?? "").includes("멈췄습니다"))[0]?.channelId).toBe(thread);
		await ownerInThread(discord, thread, "계속");
		await discord.waitForPosts((text) => text.includes("재개했습니다"));
		expect(daemon.store.getLane("t-lane")?.status).toBe("working");

		await ownerInThread(discord, thread, "지금 어디까지 했어?");
		await discord.waitForPosts((text) => text.includes("ECHO 지금 어디까지 했어?"));
		const asked = daemon.store.listInbound().find((row) => row.textRef === "지금 어디까지 했어?");
		expect(asked?.originKey).toBe(lane.originKey);
		expect(asked?.threadRef).toBe(lane.threadRef);

		await claim(daemon, discord, lane, "a.txt");
		expect(daemon.store.getLane("t-lane")?.status).toBe("closed");
		await ownerInThread(discord, thread, "!reopen b.txt도 추가해");
		await discord.waitForPosts((text) => text.includes("b.txt도 추가해"));
		expect(daemon.store.getLane("t-lane")?.status).toBe("working");

		await claim(daemon, discord, lane, "b.txt");
		await ownerInThread(discord, thread, "폐기해");
		await discord.waitForPosts((text) => text.includes("폐기했습니다"));
		expect(daemon.store.getLane("t-lane")?.meta.land?.state).toBe("discarded");
	});

	test("머지해 lands the lane; #sync edits the root to ✅ in the parent channel", async () => {
		const discord = discordTransport();
		const daemon = await boot(discord);
		const { lane, root } = await startLane(daemon, discord, "m-lane");
		await claim(daemon, discord, lane, "m.txt");
		await ownerInThread(discord, root.id, "머지해");
		await discord.waitForCall((call) => call.method === "editMessage" && call.content === "✅ m-lane");
		expect(daemon.store.getLane("m-lane")?.meta.land?.state).toBe("landed");
		expect(
			edits(discord, (call) => call.content === "✅ m-lane").map((call) => [call.channelId, call.messageId]),
		).toEqual([[CH, root.id]]);
	});
});

describe("lane buttons clicked on Discord", () => {
	test("⏸ and ▶ on the status message inside the thread hold and release the lane; the status is redrawn there", async () => {
		const discord = discordTransport();
		const daemon = await boot(discord);
		const { lane, root } = await startLane(daemon, discord, "b-lane");
		const status = { id: lane.meta.statusTs ?? "", channelId: root.id };

		await click(discord, lanePauseActionId("b-lane"), status);
		await discord.waitForPosts((text) => text.includes("멈췄습니다"));
		expect(daemon.store.getLane("b-lane")?.status).toBe("paused");
		const paused = edits(discord, (call) => call.content === "⏸ b-lane · 멈춤")[0];
		expect(paused).toMatchObject({ channelId: root.id, messageId: status.id });
		expect(customIds(paused?.components)).toEqual([laneResumeActionId("b-lane")]);

		await click(discord, laneResumeActionId("b-lane"), status);
		await discord.waitForPosts((text) => text.includes("재개했습니다"));
		expect(daemon.store.getLane("b-lane")?.status).toBe("working");
	});

	test("머지 and 폐기 on the Outcome card in the thread land and discard", async () => {
		const discord = discordTransport();
		const daemon = await boot(discord);
		const merged = await startLane(daemon, discord, "merge-lane");
		const mergeCard = await claim(daemon, discord, merged.lane, "x.txt");
		expect(mergeCard.channelId).toBe(merged.root.id);
		expect(customIds(mergeCard.components)).toEqual([
			laneMergeActionId("merge-lane"),
			laneDiscardActionId("merge-lane"),
		]);
		await click(discord, laneMergeActionId("merge-lane"), { id: mergeCard.id, channelId: merged.root.id });
		await discord.waitForCall((call) => call.method === "editMessage" && call.content === "✅ merge-lane");
		expect(daemon.store.getLane("merge-lane")?.meta.land?.state).toBe("landed");

		const dropped = await startLane(daemon, discord, "drop-lane");
		const dropCard = await claim(daemon, discord, dropped.lane, "y.txt");
		await click(discord, laneDiscardActionId("drop-lane"), { id: dropCard.id, channelId: dropped.root.id });
		expect(daemon.store.getLane("drop-lane")?.meta.land?.state).toBe("discarded");
		// The card is redrawn in place inside the thread, without its buttons.
		const redrawn = edits(discord, (call) => call.messageId === dropCard.id).at(-1);
		expect(redrawn?.channelId).toBe(dropped.root.id);
		expect(redrawn?.components).toEqual([]);
	});
});

describe("#sync after a restart", () => {
	test("a fresh port with empty caches still edits the status message in the thread channel", async () => {
		const first = discordTransport();
		const daemon = await boot(first);
		const { lane, root } = await startLane(daemon, first, "r-lane");
		await daemon.stop();

		const discord = discordTransport([{ id: root.id, parentId: CH }]);
		const second = await boot(discord);
		now += PROGRESS_INTERVAL_MS + 60_000;
		await second.sweep();
		const edit = await discord.waitForCall(
			(call) => call.method === "editMessage" && call.messageId === lane.meta.statusTs,
		);
		expect(edit).toMatchObject({ channelId: root.id });
		expect((edit as Edit).content).toStartWith("⏳ r-lane");
	});
});

describe("lanes asked for from a Discord DM", () => {
	test("with laneChannelId: the lane opens in that channel and the DM gets the lane thread's link", async () => {
		const discord = discordTransport();
		const daemon = await boot(discord, LANE_CH);
		expect(daemon.hostToolsFor(DM_ORIGIN).map((tool) => tool.name)).toContain("ompbot_work_start");
		const repo = makeRepo(repos);
		const ask = nextId();
		await discord.emitMessage({
			id: ask,
			channel_id: DM,
			author: { id: DISCORD_OWNER },
			content: `작업: dm-lane @${repo}`,
			type: 0,
		});
		await discord.waitForPosts((text) => text.includes("작업 레인 `dm-lane`을 시작했습니다"));
		const root = creates(discord, (call) => call.content === "🔄 dm-lane")[0];
		expect(root?.channelId).toBe(LANE_CH);
		expect(discord.calls).toContainEqual(
			expect.objectContaining({ method: "startThread", channelId: LANE_CH, messageId: root?.id }),
		);
		const reply = creates(discord, (call) => (call.content ?? "").includes("작업 레인 `dm-lane`을 시작했습니다"))[0];
		expect(reply?.channelId).toBe(DM);
		expect(reply?.content).toContain(`https://discord.com/channels/${GUILD}/${root?.id}`);
		expect(daemon.store.getLane("dm-lane")?.threadRef).toBe(`${LANE_CH}:${root?.id}`);
	});

	test("without laneChannelId: no ompbot_work_start, the prompt and the 작업: answer name the setting", async () => {
		const discord = discordTransport();
		const daemon = await boot(discord);
		const names = daemon.hostToolsFor(DM_ORIGIN).map((tool) => tool.name);
		expect(names).not.toContain("ompbot_work_start");
		expect(names).toContain("ompbot_monitor_add");
		// A server thread needs no setting: the lane opens in its own channel.
		expect(daemon.hostToolsFor(THREAD_ORIGIN).map((tool) => tool.name)).toContain("ompbot_work_start");
		const prompt = floorsArgs(
			"/s",
			DM_ORIGIN,
			undefined,
			undefined,
			false,
			false,
			false,
			daemon.floorsSurfaceFor(DM_ORIGIN),
		)[1];
		expect(prompt).toContain("channels.discord.laneChannelId");
		expect(
			floorsArgs(
				"/s",
				"slack/dm/D1",
				undefined,
				undefined,
				false,
				false,
				false,
				daemon.floorsSurfaceFor("slack/dm/D1"),
			)[1],
		).not.toContain("laneChannelId");

		const repo = makeRepo(repos);
		await discord.emitMessage({
			id: nextId(),
			channel_id: DM,
			author: { id: DISCORD_OWNER },
			content: `작업: no-lane @${repo}`,
			type: 0,
		});
		await discord.waitForPosts((text) => text.includes("channels.discord.laneChannelId"));
		const reply = creates(discord, (call) => (call.content ?? "").includes("channels.discord.laneChannelId"))[0];
		expect(reply?.channelId).toBe(DM);
		expect(reply?.content).toContain("작업 레인을 시작하지 못했습니다");
		expect(daemon.store.getLane("no-lane")).toBeUndefined();
		expect(creates(discord, (call) => call.content === "🔄 no-lane")).toHaveLength(0);
	});
});

describe("a thread Discord refuses", () => {
	test("a failed openThread marks the root ❌ and leaves no lane, worktree or branch", async () => {
		const discord = discordTransport();
		const daemon = await boot(discord);
		const repo = makeRepo(repos);
		discord.failNext.startThread = [
			new DiscordCallError("definitive", "discord_http_403:50001 Missing Access", 403, 50001),
		];
		await expect(workStart(daemon, THREAD_ORIGIN, "f-lane", repo)).rejects.toThrow("Missing Access");
		const root = creates(discord, (call) => call.content === "🔄 f-lane")[0];
		expect(edits(discord, (call) => call.messageId === root?.id).map((call) => [call.channelId, call.content])).toEqual(
			[[CH, "❌ f-lane"]],
		);
		expect(daemon.store.getLane("f-lane")).toBeUndefined();
		expect(creates(discord, (call) => (call.content ?? "").startsWith("⏳ f-lane"))).toHaveLength(0);
		expect(readdirSync(dirname(repo)).filter((entry) => entry.startsWith(`${basename(repo)}-l-`))).toEqual([]);
		expect(git(repo, "branch", "--list", "lane/*")).toBe("");
	});
});
