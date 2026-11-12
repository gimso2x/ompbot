import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Daemon } from "../src/daemon/daemon";
import { planReload, RESTART_FIELDS } from "../src/daemon/reload";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import { makeHome, OWNER, type TestHome, WaitingTransport } from "./helpers/bot-home";
import { killSpawned, runMain, spawnDaemon } from "./helpers/daemon-process";

const CHANNEL = "C0SOLO00001";

let home: TestHome;
let daemon: Daemon | undefined;

beforeEach(() => {
	home = makeHome("ompbot-reload-");
	daemon = undefined;
});

afterEach(async () => {
	killSpawned();
	await daemon?.stop();
	home.remove();
});

/** Rewrites config.json with `patch` merged over what makeHome wrote. */
function patchConfig(patch: Record<string, unknown>): void {
	const path = join(home.dir, "config.json");
	writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...patch }), { mode: 0o600 });
}

describe("planReload", () => {
	test("live fields follow the file (a removed one is removed); restart-bound and CLI fields are only reported", () => {
		const current = { ...home.config, logChannel: "C0LOG000001", skillReviewTurns: 10 };
		const fresh = {
			...home.config,
			mentionFreeChannels: [CHANNEL],
			skillReviewTurns: 10,
			model: "p/m",
			sessionRetentionDays: 7,
		};
		const plan = planReload(current, fresh);
		expect(plan.changed).toEqual(["mentionFreeChannels", "logChannel"]);
		expect(plan.restartRequired).toEqual(["model"]);
		expect(plan.cli).toEqual(["sessionRetentionDays"]);
		expect(plan.next.mentionFreeChannels).toEqual([CHANNEL]);
		expect("logChannel" in plan.next).toBe(false);
		expect(plan.next.model).toBeUndefined();
	});

	test("herdr is restart-bound: reported, never applied live", () => {
		const plan = planReload({ ...home.config }, { ...home.config, herdr: {} });
		expect(plan.changed).toEqual([]);
		expect(plan.restartRequired).toEqual(["herdr"]);
		expect(plan.next.herdr).toBeUndefined();
	});

	test("channels is restart-bound and the old ownerSlackUserId is no field of its own", () => {
		expect(RESTART_FIELDS).toContain("channels");
		expect(RESTART_FIELDS as readonly string[]).not.toContain("ownerSlackUserId");
		const moved = planReload({ ...home.config, deprecated: ["ownerSlackUserId"] }, { ...home.config });
		expect(moved.restartRequired).toEqual([]);
		const changed = planReload(
			{ ...home.config },
			{ ...home.config, channels: { slack: { ownerUserId: "UNEW0000" } } },
		);
		expect(changed.restartRequired).toEqual(["channels"]);
		if (changed.next.channels.slack === undefined) throw new Error("expected channels.slack");
		expect(changed.next.channels.slack.ownerUserId).toBe(OWNER);
	});

	test("recallEnabled applies live", () => {
		const plan = planReload({ ...home.config }, { ...home.config, recallEnabled: false });
		expect(plan.changed).toEqual(["recallEnabled"]);
		expect(plan.restartRequired).toEqual([]);
		expect(plan.next.recallEnabled).toBe(false);
	});

	test("costCap applies live: a new ceiling is taken without a restart, a removed one is dropped", () => {
		const added = planReload({ ...home.config }, { ...home.config, costCap: { turnUsd: 20, dailyUsd: 300 } });
		expect(added.changed).toEqual(["costCap"]);
		expect(added.restartRequired).toEqual([]);
		expect(added.next.costCap).toEqual({ turnUsd: 20, dailyUsd: 300 });
		const removed = planReload({ ...home.config, costCap: { dailyUsd: 300 } }, { ...home.config });
		expect(removed.changed).toEqual(["costCap"]);
		expect(removed.next.costCap).toBeUndefined();
	});
});

test("ompbot reload applies a new mention-free channel to the next message; an invalid file keeps the running config", async () => {
	const transport = new WaitingTransport();
	const clock = { now: () => Date.now() };
	const sessions = new FakeSessionStore();
	daemon = new Daemon({
		config: home.config,
		channels: [new SlackBinding(new SlackChannel(transport))],
		clock,
		log: createLogger({ sink: () => undefined, clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot-reload",
		sweepMs: 3_600_000,
		gateSweepMs: 0,
		taskSweepMs: 0,
		driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
	});
	await daemon.start();
	// boot: daemon_ready recorded the config it started with
	expect(JSON.parse(readFileSync(join(home.dir, "config.json.last-good"), "utf8")).channels.slack.ownerUserId).toBe(
		OWNER,
	);
	const plain = (ts: string) =>
		transport.emitMessage({ type: "message", channel: CHANNEL, channel_type: "channel", user: OWNER, text: "hi", ts });

	await plain("1000.000001");
	expect(daemon.store.getInbound(`${CHANNEL}:1000.000001`)).toBeUndefined();

	patchConfig({ mentionFreeChannels: [CHANNEL], model: "p/m" });
	const reloaded = await runMain(home.dir, ["reload"]);
	expect(reloaded.code).toBe(0);
	expect(reloaded.stdout).toBe("config_reloaded changed=mentionFreeChannels restart_required=model cli=-\n");
	await plain("1000.000002");
	expect(daemon.store.getInbound(`${CHANNEL}:1000.000002`)).toBeDefined();

	const lastGood = join(home.dir, "config.json.last-good");
	// model is restart-bound and was never booted on: this file is not a rollback target yet
	expect(JSON.parse(readFileSync(lastGood, "utf8")).model).toBeUndefined();
	patchConfig({ model: undefined });
	const liveOnly = await runMain(home.dir, ["reload"]);
	expect(liveOnly.stdout).toContain("restart_required=-");
	expect(JSON.parse(readFileSync(lastGood, "utf8")).mentionFreeChannels).toEqual([CHANNEL]); // fully applied: refreshed
	expect(statSync(lastGood).mode & 0o777).toBe(0o600);
	writeFileSync(join(home.dir, "config.json"), "{ not json", { mode: 0o600 });
	const broken = await runMain(home.dir, ["reload"]);
	expect(broken.code).toBe(1);
	expect(broken.stderr).toContain("reload failed, config unchanged: config_invalid_json");
	expect(readFileSync(lastGood, "utf8")).not.toContain("not json"); // a failed reload never becomes the rollback target
	await plain("1000.000003");
	expect(daemon.store.getInbound(`${CHANNEL}:1000.000003`)).toBeDefined();
});

describe("peer bot policy reload", () => {
	const PEER = "UPEER00001";
	const peerMessage = (ts: string, threadTs?: string) => ({
		type: "message" as const,
		channel: CHANNEL,
		channel_type: "channel",
		user: PEER,
		bot_id: "B0PEER0001",
		text: "<@UBOT> 검토 부탁",
		ts,
		...(threadTs === undefined ? {} : { thread_ts: threadTs }),
	});

	test("peerBots, requireMention and peerHopLimit are live fields", () => {
		const plan = planReload(
			{ ...home.config },
			{
				...home.config,
				peerBots: [{ userId: PEER, name: "떡" }],
				requireMention: true,
				peerHopLimit: { turns: 1, windowMinutes: 5 },
			},
		);
		expect(plan.changed).toEqual(["peerBots", "requireMention", "peerHopLimit"]);
		expect(plan.restartRequired).toEqual([]);
		expect(plan.next.peerBots).toEqual([{ userId: PEER, name: "떡" }]);
	});

	test("a reload reaches the running adapter: peers, requireMention and the hop limit apply to the next message", async () => {
		const transport = new WaitingTransport();
		const clock = { now: () => Date.now() };
		const sessions = new FakeSessionStore();
		daemon = new Daemon({
			config: { ...home.config, mentionFreeChannels: [CHANNEL] },
			channels: [new SlackBinding(new SlackChannel(transport))],
			clock,
			log: createLogger({ sink: () => undefined, clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot-reload-peer",
			sweepMs: 3_600_000,
			gateSweepMs: 0,
			taskSweepMs: 0,
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		await daemon.start();
		const owner = (ts: string) =>
			transport.emitMessage({
				type: "message",
				channel: CHANNEL,
				channel_type: "channel",
				user: OWNER,
				text: "hi",
				ts,
			});
		const row = (ts: string) => daemon?.store.getInbound(`${CHANNEL}:${ts}`);

		await transport.emitMessage(peerMessage("1000.000001"));
		expect(row("1000.000001")).toBeUndefined(); // no peerBots yet: any bot message is dropped

		// The file is the source of truth for every live field: the mention-free channel stays in each patch.
		const solo = { mentionFreeChannels: [CHANNEL] };
		patchConfig({ ...solo, peerBots: [{ userId: PEER, name: "떡" }], peerHopLimit: { turns: 1, windowMinutes: 30 } });
		expect(daemon.reloadConfig("ipc")).toMatchObject({ ok: true, changed: ["peerBots", "peerHopLimit"] });
		await transport.emitMessage(peerMessage("1000.000002"));
		expect(row("1000.000002")?.peerUserId).toBe(PEER);
		await transport.emitMessage(peerMessage("1000.000003", "1000.000002"));
		expect(row("1000.000003")).toBeUndefined(); // the reloaded limit (1 turn) caps the thread

		patchConfig({
			...solo,
			peerBots: [{ userId: PEER, name: "떡" }],
			peerHopLimit: { turns: 1, windowMinutes: 30 },
			requireMention: true,
		});
		expect(daemon.reloadConfig("ipc")).toMatchObject({ ok: true, changed: ["requireMention"] });
		await owner("1000.000004"); // mention-free channel, but requireMention wins
		expect(row("1000.000004")).toBeUndefined();

		patchConfig({ ...solo, peerBots: undefined, peerHopLimit: undefined, requireMention: undefined });
		expect(daemon.reloadConfig("ipc")).toMatchObject({ ok: true });
		await transport.emitMessage(peerMessage("1000.000005"));
		expect(row("1000.000005")).toBeUndefined(); // peers removed again
		await owner("1000.000006");
		expect(row("1000.000006")).toBeDefined(); // requireMention removed again
	});
});

test("reloading a config that turns herdr on answers restartRequired with herdr", async () => {
	const clock = { now: () => Date.now() };
	const sessions = new FakeSessionStore();
	daemon = new Daemon({
		config: home.config,
		channels: [new SlackBinding(new SlackChannel(new WaitingTransport()))],
		clock,
		log: createLogger({ sink: () => undefined, clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot-reload-herdr",
		sweepMs: 3_600_000,
		gateSweepMs: 0,
		taskSweepMs: 0,
		driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
	});
	await daemon.start();
	patchConfig({ herdr: {} });
	const result = daemon.reloadConfig("ipc");
	expect(result).toMatchObject({ ok: true, restartRequired: ["herdr"] });
});

describe("boot last-good", () => {
	async function boot(bootConfigText: string | undefined): Promise<string[]> {
		const lines: string[] = [];
		const clock = { now: () => Date.now() };
		const sessions = new FakeSessionStore();
		daemon = new Daemon({
			config: home.config,
			bootConfigText,
			channels: [new SlackBinding(new SlackChannel(new WaitingTransport()))],
			clock,
			log: createLogger({ sink: (line) => void lines.push(line), clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot-last-good",
			sweepMs: 3_600_000,
			gateSweepMs: 0,
			taskSweepMs: 0,
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		await daemon.start();
		return lines;
	}
	const lastGood = () => join(home.dir, "config.json.last-good");

	test("records exactly the text loadConfig read; a file changed after loadConfig is never recorded", async () => {
		const loaded = readFileSync(join(home.dir, "config.json"), "utf8");
		patchConfig({ model: "p/unvalidated" }); // edited between loadConfig and Daemon.start
		const lines = await boot(loaded);
		expect(existsSync(lastGood())).toBe(false);
		expect(lines.some((l) => l.includes("event=last_good_config_skipped reason=config_changed_since_boot"))).toBe(true);
		await daemon?.stop();
		writeFileSync(join(home.dir, "config.json"), loaded, { mode: 0o600 });
		await boot(loaded);
		expect(readFileSync(lastGood(), "utf8")).toBe(loaded);
	});

	test("a config still on ownerSlackUserId logs config_deprecated_key once at boot; the new key logs nothing", async () => {
		const deprecatedLines = (lines: string[]) => lines.filter((l) => l.includes("event=config_deprecated_key"));
		const current = await boot(readFileSync(join(home.dir, "config.json"), "utf8"));
		expect(deprecatedLines(current)).toEqual([]);
		await daemon?.stop();
		home.config = { ...home.config, deprecated: ["ownerSlackUserId"] };
		const legacy = deprecatedLines(await boot(undefined));
		expect(legacy).toHaveLength(1);
		expect(legacy[0]).toContain("key=ownerSlackUserId");
		expect(legacy[0]).toContain("use=channels.slack.ownerUserId");
	});

	test("without the text loadConfig read the reason is config_unreadable and nothing is recorded", async () => {
		const lines = await boot(undefined);
		expect(existsSync(lastGood())).toBe(false);
		expect(lines.some((l) => l.includes("event=last_good_config_skipped reason=config_unreadable"))).toBe(true);
	});
});

test("real daemon process: SIGHUP reloads config.json instead of stopping", async () => {
	const spawned = spawnDaemon(home.dir, join(home.dir, "transport.jsonl"));
	await spawned.waitLog(/event=daemon_ready/);
	patchConfig({ escalationChannel: "C0ESC000001", watcherRoots: [home.dir] });
	spawned.signal("SIGHUP");
	const line = await spawned.waitLog(/event=config_reloaded/);
	expect(line).toContain("trigger=sighup");
	expect(line).toContain("changed=escalationChannel");
	expect(line).toContain("restart_required=watcherRoots");
	expect(JSON.parse((await runMain(home.dir, ["status", "--json"])).stdout)).toMatchObject({ daemonRunning: true });
	spawned.signal("SIGTERM");
	expect(await spawned.exited).toBe(0);
});
