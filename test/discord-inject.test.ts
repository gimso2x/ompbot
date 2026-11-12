// `ompbot inject` into a Discord conversation (doc/plans/discord-parity.md stage 1, AC-3): the marker goes up on the
// Discord port and the owner message is taken through the Discord adapter's own message path.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { OmpbotConfig } from "../src/config";
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
const GUILD = "900000000000000000"; // gitleaks:allow (fake snowflake)
const DM_ORIGIN = `discord/dm/${DISCORD_DM}`;

let home: TestHome;
let daemon: Daemon;
let slack: WaitingTransport;
let discord: WaitingDiscordTransport;

beforeEach(async () => {
	home = makeHome("ompbot-discord-inject-");
	slack = new WaitingTransport();
	discord = new WaitingDiscordTransport();
	discord.setChannel({ id: DISCORD_CH, type: 0, guildId: GUILD });
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

describe("inject into Discord", () => {
	test("--origin discord/dm/<id> posts the marker on Discord and records the message on the DM origin", async () => {
		const { nonce, threadRef } = await daemon.inject({ origin: DM_ORIGIN, asOwner: true, text: "*굵게* 이어서 해줘" });
		const marker = discord.posts((text) => text.startsWith(`🧪 inject ${nonce}`))[0];
		expect(marker?.channelId).toBe(DISCORD_DM);
		expect(marker?.messageReference).toBeUndefined();
		// The preview is escaped for Discord markdown: the owner's asterisks stay literal.
		expect(marker?.content).toBe(`🧪 inject ${nonce}\n> \\*굵게\\* 이어서 해줘`);
		expect(threadRef).toBe(`${DISCORD_DM}:${marker?.id}`);
		const row = daemon.store.getInbound(`${DISCORD_DM}:${marker?.id}`);
		expect(row?.originKey).toBe(DM_ORIGIN);
		expect(row?.textRef).toBe("*굵게* 이어서 해줘");
		await discord.waitForPosts((text) => text.includes("ECHO *굵게* 이어서 해줘"));
		expect(slack.calls.filter((call) => call.method === "postMessage")).toHaveLength(0);
	});

	test("--thread <message id> in a DM makes the marker a reply to it; the message stays on the DM origin", async () => {
		const earlier = "700000000000000001"; // gitleaks:allow (fake snowflake)
		const { nonce, threadRef } = await daemon.inject({
			origin: DM_ORIGIN,
			asOwner: true,
			text: "후속",
			thread: earlier,
		});
		const marker = discord.posts((text) => text.startsWith(`🧪 inject ${nonce}`))[0];
		expect(marker?.channelId).toBe(DISCORD_DM);
		expect(marker?.messageReference).toEqual({ messageId: earlier });
		expect(threadRef).toBe(`${DISCORD_DM}:${earlier}`);
		const rows = daemon.store.listInbound().filter((row) => row.textRef === "후속");
		expect(rows.map((row) => row.originKey)).toEqual([DM_ORIGIN]);
		await discord.waitForPosts((text) => text.includes("ECHO 후속"));
	});

	test("--origin discord/ch/<id> posts the marker in the channel and takes the message there", async () => {
		const { nonce } = await daemon.inject({ origin: `discord/ch/${DISCORD_CH}`, asOwner: true, text: "채널 후속" });
		const marker = discord.posts((text) => text.startsWith(`🧪 inject ${nonce}`))[0];
		expect(marker?.channelId).toBe(DISCORD_CH);
		const rows = daemon.store.listInbound().filter((row) => row.textRef === "채널 후속");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.originKey.startsWith(`discord/ch/${DISCORD_CH}`)).toBe(true);
	});

	test("thread origins and platforms other than Slack and Discord are refused before anything is posted", async () => {
		for (const origin of [
			`discord/ch/${DISCORD_CH}/t/222222222222222222`,
			"slack/ch/C1/t/100.1",
			"telegram/dm/1",
			"ompbot/work/a",
		]) {
			await expect(daemon.inject({ origin, asOwner: true, text: "x" })).rejects.toThrow("inject origin must be");
		}
		expect(discord.posts()).toHaveLength(0);
		expect(slack.posts()).toHaveLength(0);
	});

	// AC-2 of T-20261111-03: an inject replying to a pending approval card is refused like on Slack; the owner's own
	// Discord reply still settles the card.
	test("an inject replying to a pending approval card is refused; the card stays pending until the owner replies", async () => {
		const tool = daemon.hostToolsFor(DM_ORIGIN).find((candidate) => candidate.name === "ompbot_request_approval");
		if (tool === undefined) throw new Error("ompbot_request_approval missing");
		let finished = false;
		const result = tool
			.execute({ summary: "force push main" }, { signal: new AbortController().signal })
			.finally(() => {
				finished = true;
			});
		// The buttons go up after the ledger row and the waiting request exist.
		const shown = await discord.waitForCall(
			(call) => call.method === "editMessage" && Array.isArray(call.components) && call.components.length > 0,
		);
		const card = shown.method === "editMessage" ? shown.messageId : "";

		await expect(daemon.inject({ origin: DM_ORIGIN, asOwner: true, thread: card, text: "진행" })).rejects.toThrow(
			"approval/choice card",
		);
		expect(daemon.store.getApproval(`${DISCORD_DM}:${card}`)?.status).toBe("pending");
		expect(finished).toBe(false);

		await discord.emitMessage({
			id: "700000000000000009", // gitleaks:allow (fake snowflake)
			channel_id: DISCORD_DM,
			author: { id: DISCORD_OWNER },
			content: "진행",
			type: 19,
			message_reference: { message_id: card, channel_id: DISCORD_DM },
		});
		expect(await result).toBe("replied: 진행");
	});
});

// T-20261112-36 AC-1: the inject guard asks for the origin's own adapter, not for Slack.
describe("inject with one platform configured", () => {
	function startWith(binding: SlackBinding | DiscordBinding, config: OmpbotConfig = home.config): Promise<Daemon> {
		const sessions = new FakeSessionStore();
		const only = new Daemon({
			config,
			channels: [binding],
			log: createLogger({ sink: () => undefined, clock: { now: () => Date.now() }, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		return only.start().then(() => only);
	}

	test("a Discord-only daemon takes an inject into discord/dm/<id>", async () => {
		await daemon.stop();
		const onlyDiscord = new WaitingDiscordTransport();
		daemon = await startWith(
			new DiscordBinding(new DiscordChannel(onlyDiscord, { ownerUserId: DISCORD_OWNER })),
			withDiscord(home),
		);
		const { nonce, threadRef } = await daemon.inject({ origin: DM_ORIGIN, asOwner: true, text: "디스코드만" });
		const marker = onlyDiscord.posts((text) => text.startsWith(`🧪 inject ${nonce}`))[0];
		expect(marker?.channelId).toBe(DISCORD_DM);
		expect(threadRef).toBe(`${DISCORD_DM}:${marker?.id}`);
		expect(daemon.store.getInbound(threadRef)?.originKey).toBe(DM_ORIGIN);
		await onlyDiscord.waitForPosts((text) => text.includes("ECHO 디스코드만"));
	});

	test("a Slack-only daemon refuses discord/... with `discord is not configured`", async () => {
		await daemon.stop();
		const onlySlack = new WaitingTransport();
		daemon = await startWith(new SlackBinding(new SlackChannel(onlySlack)));
		await expect(daemon.inject({ origin: DM_ORIGIN, asOwner: true, text: "x" })).rejects.toThrow(
			"discord is not configured",
		);
		expect(onlySlack.posts()).toHaveLength(0);
	});
});
