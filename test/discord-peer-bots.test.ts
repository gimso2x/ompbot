// Discord peer bots (doc/plans/discord-peer-bots.md C, D, AC-5): a peer mention notifies the peer, the floors name the
// conversation platform's peers in its mention syntax, and a Discord peer request runs a turn end to end on the real
// ledger with the fake omp driver. Waits are on log lines and posts (bounded), never sleeps.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ChannelBinding } from "../src/channel/adapter";
import type { OmpbotConfig } from "../src/config";
import { Daemon } from "../src/daemon/daemon";
import { DiscordBinding } from "../src/discord/binding";
import { DiscordChannel } from "../src/discord/channel";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { type FloorsSurface, spawnSystemPrompt } from "../src/safety/prompt";
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

const PEER = "200000000000000001";
const STRANGER = "200000000000000009";
const BOT = "500000000000000000";
const GUILD = "300000000000000001";
const CH = "111111111111111111";
const SLACK_PEER = "UPEER00001";
const WAIT_MS = 4_000;

describe("allowedMentions (C)", () => {
	test("only the owner and peer bots named in the content are notified; parse stays empty", () => {
		const channel = new DiscordChannel(new WaitingDiscordTransport(), {
			ownerUserId: DISCORD_OWNER,
			peerBots: [{ userId: PEER }],
		});
		expect(channel.allowedMentions(`<@${PEER}> <@!${DISCORD_OWNER}> <@${STRANGER}> @everyone 검토`)).toEqual({
			parse: [],
			users: [DISCORD_OWNER, PEER],
		});
		expect(channel.allowedMentions(`<@${STRANGER}> 만`)).toEqual({ parse: [] });
	});
});

let home: TestHome;
let daemon: Daemon | undefined;
let lines: string[];
let waiters: Set<() => void>;
let built: Array<{ origin: string; tools: string[]; driver: FakeOmpDriver }>;

function waitForLog(done: () => boolean, what: string): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const check = () => {
		if (!done()) return;
		clearTimeout(timer);
		waiters.delete(check);
		resolve();
	};
	const timer = setTimeout(() => {
		waiters.delete(check);
		reject(new Error(`timed out waiting for ${what}`));
	}, WAIT_MS);
	waiters.add(check);
	check();
	return promise;
}

async function boot(config: OmpbotConfig, discord: WaitingDiscordTransport, hold = false): Promise<Daemon> {
	const sessions = new FakeSessionStore();
	const discordConfig = config.channels.discord;
	const channels: ChannelBinding[] = [
		new SlackBinding(new SlackChannel(new WaitingTransport())),
		new DiscordBinding(new DiscordChannel(discord, { ownerUserId: DISCORD_OWNER, peerBots: discordConfig?.peerBots })),
	];
	const clock = { now: () => Date.now() };
	const started = new Daemon({
		config,
		channels,
		clock,
		log: createLogger({
			sink: (line) => {
				lines.push(line);
				for (const waiter of [...waiters]) waiter();
			},
			clock,
			redact,
		}),
		ompVersion: "omp-test 0",
		bootId: "boot-discord-peer",
		stopDrainMs: 0,
		gateSweepMs: 0,
		taskSweepMs: 0,
		driverFactory: (origin, sessionDir) => {
			const driver = new FakeOmpDriver({ sessionDir, store: sessions, holdTurns: hold });
			built.push({ origin, tools: (daemon ?? started).hostToolsFor(origin).map((t) => t.name), driver });
			return driver;
		},
	});
	daemon = started;
	await started.start();
	return started;
}

function withPeers(): OmpbotConfig {
	const config = withDiscord(home);
	const discord = config.channels.discord;
	if (discord === undefined) throw new Error("withDiscord without channels.discord");
	return {
		...config,
		peerBots: [{ userId: SLACK_PEER, name: "떡" }],
		channels: { ...config.channels, discord: { ...discord, peerBots: [{ userId: PEER, name: "떡" }] } },
	};
}

beforeEach(() => {
	home = makeHome("ompbot-discord-peer-");
	lines = [];
	waiters = new Set();
	built = [];
	daemon = undefined;
});

afterEach(async () => {
	for (const b of built) b.driver.release();
	await daemon?.stop();
	daemon = undefined;
	home.remove();
});

describe("floors peer line (D)", () => {
	function floors(originKey: string, surface: FloorsSurface): { text: string; dynamic: string[] } {
		const sessionDir = join(home.dir, "sessions", "e1");
		mkdirSync(sessionDir, { recursive: true });
		const logged: string[] = [];
		const text = spawnSystemPrompt({
			secretsDir: join(home.dir, "secrets"),
			originKey,
			sessionDir,
			surface,
			now: Date.now(),
			log: createLogger({ sink: (line) => logged.push(line), clock: { now: () => 0 }, redact }),
		});
		const dynamic = /floors_dynamic="?([^"\s]*)/.exec(
			logged.find((line) => line.includes("omp_spawn_prompt")) ?? "",
		)?.[1];
		return { text, dynamic: (dynamic ?? "").split(",").filter((name) => name !== "") };
	}

	test("Discord origins name channels.discord.peerBots as <@snowflake>, Slack origins the top-level peerBots", async () => {
		const made = await boot(withPeers(), new WaitingDiscordTransport());
		const discord = floors(
			`discord/ch/${CH}/t/700000000000000001`,
			made.floorsSurfaceFor(`discord/ch/${CH}/t/700000000000000001`),
		);
		expect(discord.text).toContain(`- 이 대화의 피어 봇: 떡 = <@${PEER}>`);
		expect(discord.dynamic).toContain("peers");
		const slack = floors("slack/ch/C0PEER0001/t/1.1", made.floorsSurfaceFor("slack/ch/C0PEER0001/t/1.1"));
		expect(slack.text).toContain(`- 이 대화의 피어 봇: 떡 = <@${SLACK_PEER}>`);
		expect(slack.text).not.toContain(PEER);
		expect(slack.dynamic).toContain("peers");
	});

	test("a platform without peers gets no line and no tag", async () => {
		const made = await boot(withDiscord(home), new WaitingDiscordTransport());
		const origin = `discord/ch/${CH}/t/700000000000000001`;
		expect(made.floorsSurfaceFor(origin).peers).toBeUndefined();
		const out = floors(origin, made.floorsSurfaceFor(origin));
		expect(out.text).not.toContain("이 대화의 피어 봇");
		expect(out.dynamic).not.toContain("peers");
		const teams = floors("teams/dm/a:1", { peers: [] });
		expect(teams.text).not.toContain("이 대화의 피어 봇");
	});
});

describe("daemon: a Discord peer request (AC-5)", () => {
	test("opens a turn; a failed turn answers the peer in the same thread in Discord syntax; the origin is peerTouched", async () => {
		const discord = new WaitingDiscordTransport();
		discord.setChannel({ id: CH, type: 0, guildId: GUILD });
		const made = await boot(withPeers(), discord, true);
		const root = "700000000000000001";
		await discord.emitMessage({
			id: root,
			channel_id: CH,
			guild_id: GUILD,
			author: { id: PEER, bot: true },
			content: `<@${BOT}> 이 스펙 검토해 줘`,
			type: 0,
		});
		const origin = `discord/ch/${CH}/t/${root}`;
		await waitForLog(() => lines.some((line) => line.includes("event=turn_start")), "peer turn_start");
		expect(made.store.getInbound(`${CH}:${root}`)).toMatchObject({ peerUserId: PEER, originKey: origin });
		expect(discord.calls.filter((call) => call.method === "startThread")).toHaveLength(1);

		const failed = (text: string) => text.includes("응답 실패(");
		const posted = discord.waitForPosts(failed, 1, WAIT_MS);
		built[0]?.driver.abort();
		await posted;
		const [notice, ...rest] = discord.posts(failed);
		expect(rest).toEqual([]);
		expect(notice?.channelId).toBe(root);
		expect(notice?.content).toStartWith(`<@${PEER}> <@${BOT}> 응답 실패(aborted)`);
		expect(notice?.allowedMentions).toEqual({ parse: [], users: [PEER] });

		expect(made.peerTouched(origin)).toBe(true);
		expect(built[0]?.origin).toBe(origin);
		// The reduced set: no lane tool, which an untouched thread of the same channel has.
		expect(built[0]?.tools).not.toContain("ompbot_work_start");
		expect(made.hostToolsFor(`discord/ch/${CH}/t/700000000000000099`).map((t) => t.name)).toContain(
			"ompbot_work_start",
		);
	});

	test("a peer reply in a thread the owner's clean child already runs in reuses that child: no restart (AC-1)", async () => {
		const discord = new WaitingDiscordTransport();
		discord.setChannel({ id: CH, type: 0, guildId: GUILD });
		await boot(withPeers(), discord);
		const root = "700000000000000002";
		await discord.emitMessage({
			id: root,
			channel_id: CH,
			guild_id: GUILD,
			author: { id: DISCORD_OWNER },
			content: `<@${BOT}> 오너 질문`,
			type: 0,
		});
		const origin = `discord/ch/${CH}/t/${root}`;
		await waitForLog(() => lines.some((line) => line.includes("event=turn_start")), "owner turn_start");
		expect(built.map((b) => b.origin)).toEqual([origin]);
		expect(built[0]?.tools).toContain("ompbot_work_start");
		await discord.waitForPosts((text) => text.startsWith("ECHO "), 1, WAIT_MS);

		discord.setChannel({ id: root, type: 11, parentId: CH, guildId: GUILD });
		await discord.emitMessage({
			id: "700000000000000003",
			channel_id: root,
			guild_id: GUILD,
			author: { id: PEER, bot: true },
			content: `<@${BOT}> 검토`,
			type: 0,
		});
		await waitForLog(
			() => lines.filter((line) => line.includes("event=turn_start")).length >= 2,
			"peer turn_start on the same child",
		);
		expect(daemon?.peerTouched(origin)).toBe(true);
		expect(built.map((b) => b.origin)).toEqual([origin]);
		expect(lines.filter((line) => line.includes("event=driver_restart_peer_touched"))).toEqual([]);
	});
});
