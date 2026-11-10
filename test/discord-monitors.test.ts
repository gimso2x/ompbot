// Monitors registered from a Discord owner DM (doc/plans/discord-parity.md stage 1, AC-2): the default delivery is
// that DM, a Discord channel id is a valid `channel`/`copyChannel`, and a fire is posted by the Discord port as a new
// top-level message.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Daemon } from "../src/daemon/daemon";
import { DiscordBinding } from "../src/discord/binding";
import { DiscordChannel } from "../src/discord/channel";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
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

const DISCORD_DM = "123456789012345678"; // gitleaks:allow (fake snowflake)
const DISCORD_CH = "111111111111111111"; // gitleaks:allow (fake snowflake)
const DM_ORIGIN = `discord/dm/${DISCORD_DM}`;

let home: TestHome;
let daemon: Daemon;
let slack: WaitingTransport;
let discord: WaitingDiscordTransport;

beforeEach(async () => {
	home = makeHome("ompbot-discord-monitors-");
	slack = new WaitingTransport();
	discord = new WaitingDiscordTransport();
	const sessions = new FakeSessionStore();
	daemon = new Daemon({
		config: withDiscord(home),
		channels: [
			new SlackBinding(new SlackChannel(slack)),
			new DiscordBinding(new DiscordChannel(discord, { ownerUserId: DISCORD_OWNER })),
		],
		log: createLogger({ sink: () => undefined, clock: { now: () => Date.now() }, redact }),
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

function addTool(originKey = DM_ORIGIN) {
	const tool = daemon.hostToolsFor(originKey).find((candidate) => candidate.name === "ompbot_monitor_add");
	if (!tool) throw new Error(`ompbot_monitor_add missing for ${originKey}`);
	return (params: Record<string, unknown>) => tool.execute(params, { signal: new AbortController().signal });
}

/** An `at` slot already due, so the next sweep fires it. */
const due = () => ({ kind: "at", at: new Date(Date.now() - 60_000).toISOString() });

describe("monitors from a Discord owner DM", () => {
	test("without channel the DM id is stored, and the fire is a top-level Discord message in that DM", async () => {
		await addTool()({ name: "remind", trigger: due(), instruction: "물 마시라고 알려줘" });
		const [row] = daemon.store.monitors.listMonitors();
		expect(row?.channel).toBe(DISCORD_DM);

		await daemon.sweep();
		await discord.waitForPosts((text) => text.includes("물 마시라고 알려줘"));
		await daemon.pump();
		const post = discord.posts((text) => text.includes("물 마시라고 알려줘"))[0];
		expect(post?.channelId).toBe(DISCORD_DM);
		expect(post?.messageReference).toBeUndefined();
		expect(slack.posts((text) => text.includes("물 마시라고 알려줘"))).toHaveLength(0);
		expect(daemon.store.listDeliveries().map((delivery) => delivery.threadRef)).toContain(`${DISCORD_DM}:-`);
	});

	test("a Discord channel id is taken for channel and copyChannel; the copy goes to that channel too", async () => {
		const copy = "222222222222222222"; // gitleaks:allow (fake snowflake)
		await addTool()({
			name: "to-channel",
			trigger: due(),
			instruction: "채널 보고",
			channel: DISCORD_CH,
			copyChannel: copy,
		});
		const [row] = daemon.store.monitors.listMonitors();
		expect(row).toMatchObject({ channel: DISCORD_CH, copyChannel: copy });

		await daemon.sweep();
		await discord.waitForPosts((text) => text.includes("채널 보고"), 2);
		const channels = discord.posts((text) => text.includes("채널 보고")).map((post) => post.channelId);
		expect(channels).toContain(DISCORD_CH);
		expect(channels).toContain(copy);
		expect(slack.posts((text) => text.includes("채널 보고"))).toHaveLength(0);
	});

	test("malformed channel ids are refused and nothing is stored; Slack ids still pass", async () => {
		const add = addTool();
		for (const bad of ["12345", "C1", "c0123456789", "1234567890123456789012", "D0123456789"]) {
			await expect(add({ name: `bad-${bad}`, trigger: due(), instruction: "x", channel: bad })).rejects.toThrow(
				"channel must be a Slack channel id like C0123456789 or a Discord channel id",
			);
			await expect(add({ name: `bad-${bad}`, trigger: due(), instruction: "x", copyChannel: bad })).rejects.toThrow(
				"copyChannel must be a Slack channel id like C0123456789 or a Discord channel id",
			);
		}
		expect(daemon.store.monitors.listMonitors()).toEqual([]);
		await add({ name: "slack-ch", trigger: due(), instruction: "x", channel: "C0123456789" });
		expect(daemon.store.monitors.getMonitor("slack-ch")?.channel).toBe("C0123456789");
	});

	test("a Slack DM registration still stores no channel (the owner DM default)", async () => {
		await addTool("slack/dm/D1")({ name: "slack", trigger: due(), instruction: "x" });
		expect(daemon.store.monitors.getMonitor("slack")?.channel).toBeNull();
	});
});
