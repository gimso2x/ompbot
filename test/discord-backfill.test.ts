// Discord missed-message recovery (doc/plans/discord-channel.md §13): `recover()` reads every Discord conversation's
// channel after its `dc:<channel>` watermark, 100 messages a page, feeds the owner's messages through the live ingest
// path (the ledger's duplicate check stops replays) and moves the watermark to the newest handled id.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { CoreSink, DeliverySource } from "../src/channel/types";
import type { OmpbotConfig } from "../src/config";
import { Daemon } from "../src/daemon/daemon";
import type { DiscordAdapter } from "../src/discord/adapter";
import { DiscordBinding } from "../src/discord/binding";
import { DiscordChannel } from "../src/discord/channel";
import { type FakeDiscordCall, FakeDiscordTransport } from "../src/discord/fake-transport";
import { DiscordCallError, type DiscordMessageEvent, DiscordRateLimitedError } from "../src/discord/transport";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import { openStore, type Store } from "../src/store/db";
import {
	DISCORD_OWNER,
	makeHome,
	type TestHome,
	WaitingDiscordTransport,
	WaitingTransport,
	withDiscord,
} from "./helpers/bot-home";

const STRANGER = "100000000000000002";
const BOT = "500000000000000000";
const GUILD = "300000000000000001";
const DM = "123456789012345678";
const CH = "111111111111111111";
const LOCKED = "111111111111111119";
/** 17 digits: a string compare would rank it above every 18-digit id below. */
const WATERMARK = "99999999999999999";

let home: TestHome;
let config: OmpbotConfig;
let store: Store;
let transport: FakeDiscordTransport;
let inbound: string[];
let logs: string[];
/** Errors onInbound throws, one per call, before it starts taking messages. */
let inboundFailures: unknown[];

const noDeliveries: DeliverySource = { claimDue: () => [], confirm: () => {}, fail: () => {}, defer: () => {} };

function core(): CoreSink {
	const seen = new Set<string>();
	return {
		onInbound: (message) => {
			const failure = inboundFailures.shift();
			if (failure !== undefined) throw failure;
			if (seen.has(message.platformMessageId)) return { duplicate: true };
			seen.add(message.platformMessageId);
			inbound.push(message.platformMessageId);
			return undefined;
		},
		onCommand: () => undefined,
		onAction: () => {},
	};
}

/** The adapter the binding builds (store-backed targets and watermarks), started. */
async function boot(options: { maxPages?: number } = {}): Promise<DiscordAdapter> {
	const binding = new DiscordBinding(
		new DiscordChannel(transport, { ownerUserId: DISCORD_OWNER }),
		options.maxPages === undefined ? {} : { backfillMaxPages: options.maxPages },
	);
	const adapter = binding.createAdapter({
		core: core(),
		deliveries: noDeliveries,
		clock: { now: () => Date.now() },
		log: createLogger({ sink: (line) => logs.push(line), clock: { now: () => 0 }, redact }),
		config,
		store,
	}) as DiscordAdapter;
	await adapter.start();
	return adapter;
}

async function recover(adapter: DiscordAdapter): Promise<void> {
	adapter.recover();
	await adapter.recoveryIdle();
}

function dm(id: string, author = DISCORD_OWNER, content = `메시지 ${id}`): DiscordMessageEvent {
	return { id, channel_id: DM, author: { id: author }, content, type: 0 };
}

const calls = <M extends FakeDiscordCall["method"]>(method: M) =>
	transport.calls.filter((c): c is FakeDiscordCall & { method: M } => c.method === method);
const eyes = () => calls("addReaction").filter((c) => c.emoji === "👀");

beforeEach(() => {
	home = makeHome("ompbot-discord-backfill-");
	config = withDiscord(home);
	store = openStore({ path: join(home.dir, "test.db"), clock: { now: () => Date.now() }, redact });
	transport = new FakeDiscordTransport({ botUserId: BOT });
	transport.setChannel({ id: CH, type: 0, guildId: GUILD });
	inbound = [];
	logs = [];
	inboundFailures = [];
});

afterEach(() => {
	store.close();
	home.remove();
});

describe("recover()", () => {
	test("the owner's messages after the watermark are taken; the watermark moves to the largest id by BigInt", async () => {
		store.ensureOrigin(`discord/dm/${DM}`, join(home.dir, "s1"));
		store.setCursor(`dc:${DM}`, WATERMARK);
		transport.history.set(DM, [
			dm("100000000000000005"),
			dm("100000000000000003", STRANGER),
			dm("100000000000000001"),
			dm("99999999999999990"),
		]);
		const adapter = await boot();
		await recover(adapter);
		expect(inbound).toEqual([`${DM}:100000000000000001`, `${DM}:100000000000000005`]);
		expect(calls("listMessages")[0]).toMatchObject({ channelId: DM, after: WATERMARK, limit: 100 });
		expect(store.getCursor(`dc:${DM}`)).toBe("100000000000000005");
		expect(eyes()).toHaveLength(2);
	});

	test("a rescan of the same messages is a duplicate: one inbound and one 👀 per message", async () => {
		store.ensureOrigin(`discord/dm/${DM}`, join(home.dir, "s1"));
		store.setCursor(`dc:${DM}`, WATERMARK);
		transport.history.set(DM, [dm("100000000000000001"), dm("100000000000000002")]);
		const adapter = await boot();
		await recover(adapter);
		store.setCursor(`dc:${DM}`, WATERMARK);
		await recover(adapter);
		expect(calls("listMessages")).toHaveLength(2);
		expect(inbound).toHaveLength(2);
		expect(eyes()).toHaveLength(2);
		expect(store.getCursor(`dc:${DM}`)).toBe("100000000000000002");
	});

	test("pages of 100 follow `after`; a pass stops at maxPages and the next pass goes on from its watermark", async () => {
		store.ensureOrigin(`discord/dm/${DM}`, join(home.dir, "s1"));
		store.setCursor(`dc:${DM}`, WATERMARK);
		const ids = Array.from({ length: 250 }, (_, i) => String(100_000_000_000_000_000n + BigInt(i + 1)));
		transport.history.set(
			DM,
			ids.map((id) => dm(id)),
		);
		const adapter = await boot({ maxPages: 2 });
		await recover(adapter);
		expect(calls("listMessages").map((c) => [c.after, c.limit])).toEqual([
			[WATERMARK, 100],
			[ids[99], 100],
		]);
		expect(inbound).toHaveLength(200);
		expect(store.getCursor(`dc:${DM}`)).toBe(ids[199]);
		await recover(adapter);
		expect(calls("listMessages").map((c) => c.after)).toEqual([WATERMARK, ids[99], ids[199]]);
		expect(inbound).toHaveLength(250);
		expect(store.getCursor(`dc:${DM}`)).toBe(ids[249]);
	});

	test("an unreadable channel (50001) is quarantined: the next pass skips it, the others go on", async () => {
		transport.setChannel({ id: LOCKED, type: 0, guildId: GUILD });
		store.ensureOrigin(`discord/ch/${LOCKED}`, join(home.dir, "s1"));
		store.ensureOrigin(`discord/dm/${DM}`, join(home.dir, "s2"));
		store.setCursor(`dc:${DM}`, WATERMARK);
		store.setCursor(`dc:${LOCKED}`, WATERMARK);
		transport.history.set(DM, [dm("100000000000000001")]);
		const adapter = await boot();
		const realList = transport.listMessages.bind(transport);
		transport.listMessages = async (args) => {
			if (args.channelId === LOCKED) {
				transport.calls.push({ method: "listMessages", ...args });
				throw new DiscordCallError("definitive", "discord_http_403:50001 Missing Access", 403, 50001);
			}
			return realList(args);
		};
		await recover(adapter);
		expect(logs.some((line) => line.includes("event=backfill_quarantined") && line.includes(LOCKED))).toBe(true);
		expect(inbound).toEqual([`${DM}:100000000000000001`]);
		await recover(adapter);
		expect(calls("listMessages").filter((c) => c.channelId === LOCKED)).toHaveLength(1);
		expect(calls("listMessages").filter((c) => c.channelId === DM)).toHaveLength(2);
		expect(store.getCursor(`dc:${LOCKED}`)).toBe(WATERMARK);
	});

	test("after a restart (empty channel cache) a 403 on the channel lookup quarantines it too", async () => {
		store.ensureOrigin(`discord/ch/${LOCKED}`, join(home.dir, "s1"));
		store.setCursor(`dc:${LOCKED}`, WATERMARK);
		const adapter = await boot();
		transport.failNext.getChannel = [
			new DiscordCallError("definitive", "discord_http_403:50001 Missing Access", 403, 50001),
		];
		await recover(adapter);
		expect(logs.some((line) => line.includes("event=backfill_quarantined") && line.includes(LOCKED))).toBe(true);
		await recover(adapter);
		expect(calls("getChannel").filter((c) => c.channelId === LOCKED)).toHaveLength(1);
		expect(calls("listMessages").filter((c) => c.channelId === LOCKED)).toHaveLength(0);
	});

	test("transient ingest failures (rate limit, 5xx, busy ledger) never count toward the dead letter", async () => {
		store.ensureOrigin(`discord/dm/${DM}`, join(home.dir, "s1"));
		store.setCursor(`dc:${DM}`, WATERMARK);
		transport.history.set(DM, [dm("100000000000000001")]);
		const adapter = await boot();
		inboundFailures = [
			new DiscordRateLimitedError(1000),
			new DiscordCallError("ambiguous", "discord_http_502"),
			new Error("SQLITE_BUSY: database is locked"),
		];
		for (let pass = 0; pass < 3; pass++) await recover(adapter);
		expect(inbound).toEqual([]);
		expect(logs.some((line) => line.includes("event=backfill_dead_letter"))).toBe(false);
		expect(logs.filter((line) => line.includes("event=backfill_message_retryable"))).toHaveLength(3);
		expect(store.getCursor(`dc:${DM}`)).toBe(WATERMARK);
		await recover(adapter);
		expect(inbound).toEqual([`${DM}:100000000000000001`]);
		expect(store.getCursor(`dc:${DM}`)).toBe("100000000000000001");
	});

	test("Slack's ch:/thr: watermarks are neither Discord targets nor touched; Discord keeps dc:<id> only", async () => {
		store.setCursor("ch:C0SLACK001", "1700000000.000100");
		store.setCursor("thr:C0SLACK001:1700000000.000100", "1700000000.000200");
		store.ensureOrigin("slack/dm/D0SLACK001", join(home.dir, "s0"));
		store.ensureOrigin(`discord/dm/${DM}`, join(home.dir, "s1"));
		store.setCursor(`dc:${DM}`, WATERMARK);
		transport.history.set(DM, [dm("100000000000000001")]);
		const adapter = await boot();
		await recover(adapter);
		expect(calls("listMessages").map((c) => c.channelId)).toEqual([DM]);
		expect(store.getCursor("ch:C0SLACK001")).toBe("1700000000.000100");
		expect(store.getCursor("thr:C0SLACK001:1700000000.000100")).toBe("1700000000.000200");
		expect(store.listCursorKeys("dc:")).toEqual([`dc:${DM}`]);
		expect(store.listCursorKeys("ch:")).toEqual(["ch:C0SLACK001"]);
	});

	test("a server thread origin scans the parent channel and the thread channel", async () => {
		const thread = "222222222222222222";
		transport.setChannel({ id: thread, type: 11, parentId: CH, guildId: GUILD });
		store.ensureOrigin(`discord/ch/${CH}/t/${thread}`, join(home.dir, "s1"));
		store.setCursor(`dc:${thread}`, WATERMARK);
		transport.history.set(thread, [
			{
				id: "100000000000000001",
				channel_id: thread,
				author: { id: DISCORD_OWNER },
				content: `<@${BOT}> 스레드 답`,
				type: 0,
			},
		]);
		const adapter = await boot();
		await recover(adapter);
		expect(
			calls("listMessages")
				.map((c) => c.channelId)
				.sort(),
		).toEqual([CH, thread].sort());
		expect(inbound).toEqual([`${CH}:100000000000000001`]);
	});
});

describe("recovery triggers", () => {
	beforeEach(() => {
		store.ensureOrigin(`discord/dm/${DM}`, join(home.dir, "s1"));
		store.setCursor(`dc:${DM}`, WATERMARK);
	});

	test("a new gateway session (Ready) runs a pass; a resumed one does not", async () => {
		const adapter = await boot();
		transport.emitReady({ resumed: true });
		await adapter.recoveryIdle();
		expect(calls("listMessages")).toHaveLength(0);
		transport.emitReady({ resumed: false });
		await adapter.recoveryIdle();
		expect(calls("listMessages").map((c) => c.channelId)).toEqual([DM]);
	});

	test("a live message that fails as inbound_failed runs a pass", async () => {
		const adapter = await boot();
		transport.failNext.getChannel = [new Error("network down")];
		await transport.emitMessage({
			id: "100000000000000009",
			channel_id: "111111111111111112",
			guild_id: GUILD,
			author: { id: DISCORD_OWNER },
			content: `<@${BOT}> 질문`,
			type: 0,
		});
		expect(logs.some((line) => line.includes("event=inbound_failed"))).toBe(true);
		await adapter.recoveryIdle();
		expect(calls("listMessages").map((c) => c.channelId)).toEqual([DM]);
	});
});

describe("daemon start", () => {
	let daemon: Daemon | undefined;
	afterEach(async () => {
		await daemon?.stop();
		daemon = undefined;
	});

	test("a DM sent while the daemon was down is answered after the start", async () => {
		store.ensureOrigin(`discord/dm/${DM}`, join(home.dir, "s1"));
		store.close();
		const ledger = openStore({ path: join(home.dir, "ompbot.db"), clock: { now: () => Date.now() }, redact });
		ledger.ensureOrigin(`discord/dm/${DM}`, join(home.dir, "sessions", "dm"));
		ledger.setCursor(`dc:${DM}`, WATERMARK);
		ledger.close();
		store = openStore({ path: join(home.dir, "test.db"), clock: { now: () => Date.now() }, redact });

		const discord = new WaitingDiscordTransport();
		discord.history.set(DM, [dm("100000000000000001", DISCORD_OWNER, "자는 동안 보낸 질문")]);
		const sessions = new FakeSessionStore();
		const clock = { now: () => Date.now() };
		daemon = new Daemon({
			config,
			channels: [
				new SlackBinding(new SlackChannel(new WaitingTransport())),
				new DiscordBinding(new DiscordChannel(discord, { ownerUserId: DISCORD_OWNER })),
			],
			clock,
			log: createLogger({ sink: (line) => logs.push(line), clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot-backfill",
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		await daemon.start();
		await discord.waitForPosts((text) => text.includes("ECHO 자는 동안 보낸 질문"));
		expect(daemon.store.getCursor(`dc:${DM}`)).toBe("100000000000000001");
	});
});
