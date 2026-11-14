// Peer silence alert end to end (doc/plans/peer-silence-alert.md): a thread answer that mentions a Discord peer goes
// out through the real DeliveryPump, its confirm records the call, and the sweep alerts the owner in that thread once —
// unless the peer posted there meanwhile, even without mentioning this bot. Waits are on log lines and posts (bounded).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChannelBinding } from "../src/channel/adapter";
import type { OmpbotConfig } from "../src/config";
import { Daemon } from "../src/daemon/daemon";
import { snowflakeAt } from "../src/discord/backfill";
import { DiscordBinding } from "../src/discord/binding";
import { DiscordChannel } from "../src/discord/channel";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { PEER_SILENCE_OP_PREFIX } from "../src/store/db";
import { DISCORD_OWNER, makeHome, type TestHome, WaitingDiscordTransport, withDiscord } from "./helpers/bot-home";

const PEER = "200000000000000001";
const GUILD = "300000000000000001";
const CH = "111111111111111111";
const THREAD = "711111111111111111";
const ORIGIN = `discord/ch/${CH}/t/${THREAD}`;
const MINUTE = 60_000;
const WAIT_MS = 4_000;
const ALERT = "무응답";

let home: TestHome;
let daemon: Daemon | undefined;
let lines: string[];
let waiters: Set<() => void>;
let now: number;

function waitForLog(needle: string): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const check = () => {
		if (!lines.some((line) => line.includes(needle))) return;
		clearTimeout(timer);
		waiters.delete(check);
		resolve();
	};
	const timer = setTimeout(() => {
		waiters.delete(check);
		reject(new Error(`timed out waiting for ${needle}`));
	}, WAIT_MS);
	waiters.add(check);
	check();
	return promise;
}

function withPeer(minutes?: number): OmpbotConfig {
	const config = withDiscord(home);
	const discord = config.channels.discord;
	if (discord === undefined) throw new Error("withDiscord without channels.discord");
	return {
		...config,
		...(minutes === undefined ? {} : { peerSilenceAlert: { minutes } }),
		channels: { ...config.channels, discord: { ...discord, peerBots: [{ userId: PEER, name: "뮤즈" }] } },
	};
}

async function boot(config: OmpbotConfig, discord: WaitingDiscordTransport): Promise<Daemon> {
	const sessions = new FakeSessionStore();
	const channels: ChannelBinding[] = [
		new DiscordBinding(
			new DiscordChannel(discord, { ownerUserId: DISCORD_OWNER, peerBots: config.channels.discord?.peerBots }),
		),
	];
	const clock = { now: () => now };
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
		bootId: "boot-peer-silence",
		stopDrainMs: 0,
		gateSweepMs: 0,
		taskSweepMs: 0,
		driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
	});
	daemon = started;
	await started.start();
	await waitForLog("event=peer_silence_armed");
	return started;
}

/** The bot's thread answer mentioning the peer, sent and confirmed by the Discord pump. */
async function callPeer(made: Daemon, discord: WaitingDiscordTransport, opRef: string): Promise<void> {
	made.store.ensureOrigin(ORIGIN, `${home.dir}/sessions/peer`);
	const posted = discord.waitForPosts((text) => text.includes(opRef), 1, WAIT_MS);
	made.store.recordAnswer({ originKey: ORIGIN, opRef, threadRef: `${CH}:${THREAD}`, parts: [`<@${PEER}> ${opRef}`] });
	await posted;
	await waitForLog("to=confirmed");
}

beforeEach(() => {
	home = makeHome("ompbot-peer-silence-");
	lines = [];
	waiters = new Set();
	daemon = undefined;
	now = Date.now();
});

afterEach(async () => {
	await daemon?.stop();
	daemon = undefined;
	home.remove();
});

/** Alert deliveries in the ledger: the sweep records them synchronously, before the pump posts anything. */
const alertRows = (made: Daemon) =>
	made.store.listDeliveries().filter((row) => row.opRef.startsWith(PEER_SILENCE_OP_PREFIX));

function discordWithThread(): WaitingDiscordTransport {
	const discord = new WaitingDiscordTransport();
	discord.setChannel({ id: CH, type: 0, guildId: GUILD });
	discord.setChannel({ id: THREAD, type: 11, parentId: CH, guildId: GUILD });
	return discord;
}

describe("daemon: peer silence alert", () => {
	test("AC-2: a confirmed peer call left silent for 10 minutes alerts the owner in the thread once", async () => {
		const discord = discordWithThread();
		const made = await boot(withPeer(), discord);
		await callPeer(made, discord, "call-1");
		now += 9 * MINUTE;
		await made.sweep();
		expect(alertRows(made)).toEqual([]);
		now += MINUTE;
		const alerted = discord.waitForPosts((text) => text.includes(ALERT), 1, WAIT_MS);
		await made.sweep();
		await alerted;
		const [alert, ...more] = discord.posts((text) => text.includes(ALERT));
		expect(more).toEqual([]);
		expect(alert?.channelId).toBe(THREAD);
		expect(alert?.content).toContain(`<@${DISCORD_OWNER}> ⚠️ 뮤즈 무응답 10분`);
		expect(alert?.allowedMentions).toEqual({ parse: [], users: [DISCORD_OWNER] });
		now += 30 * MINUTE;
		await made.sweep();
		expect(alertRows(made)).toHaveLength(1);
	});

	test("AC-1: a peer post without a bot mention after the call answers it", async () => {
		const discord = discordWithThread();
		const made = await boot(withPeer(), discord);
		await callPeer(made, discord, "call-2");
		now += 2 * MINUTE;
		await discord.emitMessage({
			id: snowflakeAt(now),
			channel_id: THREAD,
			guild_id: GUILD,
			author: { id: PEER, bot: true },
			content: "확인했어, 진행할게",
			type: 0,
		});
		await waitForLog("reason=peer_not_mentioned");
		now += 30 * MINUTE;
		await made.sweep();
		expect(alertRows(made)).toEqual([]);
	});

	test("AC-5: peerSilenceAlert.minutes 0 records no call and never alerts", async () => {
		const discord = discordWithThread();
		const made = await boot(withPeer(0), discord);
		await callPeer(made, discord, "call-3");
		now += 60 * MINUTE;
		await made.sweep();
		expect(alertRows(made)).toEqual([]);
	});
});
