// Owner notice destination without Slack (doc/plans/teams-channel.md TASK A): before the owner has written anywhere a
// daemon-level notice and a channel-less monitor have nowhere to go — they log `owner_notice_unroutable`, write no
// `:-` delivery and the monitor event waits; after the owner's first message (or `!home`) both land in that
// conversation.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OmpbotConfig } from "../src/config";
import { Daemon } from "../src/daemon/daemon";
import { DiscordBinding } from "../src/discord/binding";
import { DiscordChannel } from "../src/discord/channel";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { ledgerDay } from "../src/ops/cost-cap";
import { redact } from "../src/redact";
import { SKILL_REVIEW_ORIGIN } from "../src/review/skills";
import { Store } from "../src/store/db";
import { DISCORD_OWNER, makeHome, type TestHome, WaitingDiscordTransport, withDiscord } from "./helpers/bot-home";

const DISCORD_DM = "123456789012345678"; // gitleaks:allow (fake snowflake)
const DISCORD_CH = "111111111111111111"; // gitleaks:allow (fake snowflake)
const GUILD = "333333333333333333"; // gitleaks:allow (fake snowflake)
const clock = { now: () => Date.now() };

let home: TestHome;
let daemon: Daemon;
let discord: WaitingDiscordTransport;
let logs: string[];
/** Origin of every omp child the daemon started, in order. */
let driverOrigins: string[];

/** `withDiscord` minus every Slack key: Discord is the only platform. */
function discordOnly(extra: Partial<OmpbotConfig> = {}): OmpbotConfig {
	const { slack: _slack, ...rest } = withDiscord(home);
	const discordConfig = rest.channels.discord;
	if (discordConfig === undefined) throw new Error("withDiscord sets channels.discord");
	// The server channel answers the owner without a mention, so `!home` can be typed there as is.
	return { ...rest, channels: { discord: { ...discordConfig, mentionFreeChannels: [DISCORD_CH] } }, ...extra };
}

async function boot(config: OmpbotConfig): Promise<void> {
	discord = new WaitingDiscordTransport();
	discord.setChannel({ id: DISCORD_CH, type: 0, guildId: GUILD });
	const sessions = new FakeSessionStore();
	daemon = new Daemon({
		config,
		channels: [new DiscordBinding(new DiscordChannel(discord, { ownerUserId: DISCORD_OWNER }))],
		log: createLogger({ sink: (line) => logs.push(line), clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot",
		gateSweepMs: 0,
		driverFactory: (origin, sessionDir) => {
			driverOrigins.push(origin);
			return new FakeOmpDriver({ sessionDir, store: sessions });
		},
	});
	await daemon.start();
}

const unroutable = (): string[] => logs.filter((line) => line.includes("event=owner_notice_unroutable"));
const brokenRows = () => daemon.store.listDeliveries().filter((row) => row.threadRef.startsWith(":"));

function addDueMonitor(name: string) {
	return daemon.store.monitors.addMonitor({
		name,
		trigger: { kind: "at", at: new Date(Date.now() - 60_000).toISOString() },
		instruction: `${name} 알려줘`,
		overlap: "queue",
		enabled: true,
	});
}

async function ownerSays(id: string, channelId: string, content: string, guildId?: string): Promise<void> {
	await discord.emitMessage({
		id,
		channel_id: channelId,
		...(guildId === undefined ? {} : { guild_id: guildId }),
		author: { id: DISCORD_OWNER },
		content,
		type: 0,
	});
}

beforeEach(() => {
	home = makeHome("ompbot-owner-home-");
	logs = [];
	driverOrigins = [];
});

afterEach(async () => {
	await daemon?.stop();
	home.remove();
});

describe("ownerHome without Slack", () => {
	test("AC-A3: a monitor waits with owner_notice_unroutable until the owner writes, then reports in that DM", async () => {
		await boot(discordOnly());
		const monitor = addDueMonitor("water");
		await daemon.sweep();
		expect(unroutable().some((line) => line.includes(`monitor=${monitor.id}`))).toBe(true);
		expect(brokenRows()).toEqual([]);
		expect(daemon.store.listDeliveries()).toEqual([]);
		const [waiting] = daemon.store.monitors.listEvents({ monitorId: monitor.id });
		expect(waiting?.stage).toBe("admitted");
		// A second tick keeps waiting without repeating the warning for the same event.
		await daemon.sweep();
		expect(unroutable().filter((line) => line.includes(`monitor=${monitor.id}`))).toHaveLength(1);

		await ownerSays("700000000000000001", DISCORD_DM, "안녕");
		await discord.waitForPosts((text) => text.includes("ECHO 안녕"));
		expect(daemon.store.ownerHome()).toEqual({ platform: "discord", conversationId: DISCORD_DM });

		await daemon.sweep();
		await discord.waitForPosts((text) => text.includes("water 알려줘"));
		await daemon.pump();
		const report = discord.posts((text) => text.startsWith("⏰ water"))[0];
		expect(report?.channelId).toBe(DISCORD_DM);
		expect(daemon.store.listDeliveries().map((row) => row.threadRef)).toContain(`${DISCORD_DM}:-`);
		expect(brokenRows()).toEqual([]);
	});

	test("AC-A3: a daemon notice (daily cost cap) is unroutable before the owner writes and goes to the !home channel after", async () => {
		await boot(discordOnly({ costCap: { dailyUsd: 10 } }));
		daemon.store.addDailyUsage({
			day: ledgerDay(Date.now(), home.config.timezone),
			originKey: "x",
			cost: 12,
			calls: 1,
		});
		await daemon.sweep();
		expect(unroutable().some((line) => line.includes("notice=cost_cap_daily"))).toBe(true);
		expect(discord.posts((text) => text.includes("하루 상한"))).toEqual([]);
		expect(brokenRows()).toEqual([]);

		// The owner writes in a DM first, then makes a server channel the home: `!home` wins over the DM.
		await ownerSays("700000000000000002", DISCORD_DM, "안녕");
		await discord.waitForPosts((text) => text.includes("ECHO 안녕"));
		await ownerSays("700000000000000003", DISCORD_CH, "!home", GUILD);
		await discord.waitForPosts((text) => text.includes("알림 받을 곳으로 정했습니다"));
		expect(daemon.store.ownerHome()).toEqual({ platform: "discord", conversationId: DISCORD_CH });

		await daemon.sweep();
		await discord.waitForPosts((text) => text.includes("하루 상한"));
		expect(discord.posts((text) => text.includes("하루 상한")).map((post) => post.channelId)).toEqual([DISCORD_CH]);
	});

	test("a monitor's final failure notice is not written to ':-' while there is no home", async () => {
		await boot(discordOnly());
		const monitor = addDueMonitor("fails");
		const store = daemon.store;
		// The sweep claims the `at` slot and holds it (no home); the failure path is then driven by hand to its end.
		await daemon.sweep();
		const queued = store.monitors.listEvents({ monitorId: monitor.id })[0];
		if (queued === undefined) throw new Error("expected a queued event");
		let attempts = 0;
		while (store.monitors.markDispatched(queued.eventId, `op-${attempts}`)) {
			attempts += 1;
			expect(store.failMonitorEvent(queued.eventId, "[turn failed] boom")).toBeUndefined();
		}
		expect(attempts).toBeGreaterThan(1);
		expect(store.monitors.listEvents({ monitorId: monitor.id })[0]?.stage).toBe("failed_no_retry");
		expect(unroutable().some((line) => line.includes(`op=monitor-notice:${queued.eventId}`))).toBe(true);
		expect(brokenRows()).toEqual([]);
	});
});

describe("owner DM features without Slack", () => {
	const answer = async (id: string, text: string) => {
		await ownerSays(id, DISCORD_DM, text);
		await discord.waitForPosts((posted) => posted.includes(`ECHO ${text}`));
	};

	test("the periodic skill review counts the Discord owner DM's turns and starts", async () => {
		await boot(discordOnly({ skillReviewTurns: 1 }));
		await answer("700000000000000011", "하나");
		await daemon.sweep(); // first look at the DM: the baseline, no review yet
		expect(driverOrigins).not.toContain(SKILL_REVIEW_ORIGIN);
		await answer("700000000000000012", "둘");
		await daemon.sweep();
		expect(driverOrigins).toContain(SKILL_REVIEW_ORIGIN);
	});

	test("a due improvement candidate in card mode raises its approval card in the Discord owner DM", async () => {
		const day = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
		const seen = (back: number) =>
			JSON.stringify({
				v: 1,
				ts: `${day(back)}T00:00:00Z`,
				key: "cand-discord",
				event: "seen",
				day: day(back),
				kind: "fix",
				evidence: `reflections/${day(back)}.md#1`,
				summary: "디스코드 후보 반복",
			});
		const config = discordOnly({ candidates: { mode: "card" } });
		writeFileSync(join(config.workspaceDir, "candidates.jsonl"), `${[1, 2, 3].map(seen).join("\n")}\n`);
		await boot(config);
		await answer("700000000000000021", "안녕");
		await daemon.sweep();
		await discord.waitForPosts((text) => text.includes("디스코드 후보 반복"));
		expect(discord.posts((text) => text.includes("디스코드 후보 반복")).map((post) => post.channelId)).toEqual([
			DISCORD_DM,
		]);
		expect(logs.filter((line) => line.includes("event=candidate_card_unroutable"))).toEqual([]);
	});
});

describe("Store.ownerHome order", () => {
	let store: Store;
	beforeEach(() => {
		store = new Store({ path: ":memory:", clock, timezone: "UTC", redact });
	});
	afterEach(() => store.close());

	test("undefined with nothing known; then last spoken conversation < any DM < Slack owner < !home", () => {
		expect(store.ownerHome()).toBeUndefined();
		store.ensureOrigin(`discord/ch/${DISCORD_CH}`, "/s/1");
		store.recordInbound({
			originKey: `discord/ch/${DISCORD_CH}`,
			platformMessageId: "m1",
			textRef: "hi",
			threadRef: `${DISCORD_CH}:m1`,
		});
		expect(store.ownerHome()).toEqual({ platform: "discord", conversationId: DISCORD_CH });
		store.ensureOrigin(`discord/dm/${DISCORD_DM}`, "/s/2");
		expect(store.ownerHome()).toEqual({ platform: "discord", conversationId: DISCORD_DM });
		store.setOwnerHome({ platform: "discord", conversationId: DISCORD_CH });
		expect(store.ownerHome()).toEqual({ platform: "discord", conversationId: DISCORD_CH });
	});

	test("with a Slack owner, the Slack DM is the home exactly as before (no !home)", () => {
		const slack = new Store({ path: ":memory:", clock, timezone: "UTC", redact, slackOwnerUserId: "UOWNER0" });
		try {
			slack.ensureOrigin(`discord/dm/${DISCORD_DM}`, "/s/1");
			expect(slack.ownerHome()).toEqual({ platform: "slack", conversationId: "UOWNER0" });
			slack.ensureOrigin("slack/dm/D1", "/s/2");
			expect(slack.ownerHome()).toEqual({ platform: "slack", conversationId: "D1" });
		} finally {
			slack.close();
		}
	});
});
