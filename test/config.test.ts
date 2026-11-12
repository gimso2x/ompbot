import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ConfigError,
	defaultHomeDir,
	isOffsiteDir,
	loadConfig,
	readDiscordToken,
	readSlackTokens,
} from "../src/config";
import { Daemon } from "../src/daemon/daemon";
import { LIVE_FIELDS, RESTART_FIELDS } from "../src/daemon/reload";
import { channelBindings } from "../src/daemon/run";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";

let home: string;

function writeSecret(rel: string, content: string, mode = 0o600): string {
	const p = join(home, rel);
	writeFileSync(p, content);
	chmodSync(p, mode);
	return p;
}

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: 1,
		channels: { slack: { ownerUserId: "UOWNER0" } },
		slack: { botTokenFile: "secrets/bot.token", appTokenFile: "secrets/app.token" },
		ompExecutable: "/usr/local/bin/omp",
		workspaceDir: "workspace",
		...overrides,
	};
}

function writeConfig(obj: unknown): void {
	writeFileSync(join(home, "config.json"), JSON.stringify(obj));
}

function catchError(fn: () => unknown): ConfigError {
	try {
		fn();
	} catch (e) {
		if (e instanceof ConfigError) return e;
		throw e;
	}
	throw new Error("expected ConfigError");
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ompbot-cfg-"));
	chmodSync(home, 0o700);
	mkdirSync(join(home, "secrets"), { mode: 0o700 });
	writeSecret("secrets/bot.token", "xoxb-TEST-0\n");
	writeSecret("secrets/app.token", "xapp-TEST-0\n");
	writeConfig(baseConfig());
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("loadConfig", () => {
	test("loads a valid config and resolves paths relative to the config dir", () => {
		const cfg = loadConfig(home);
		expect(cfg).toMatchObject({
			schemaVersion: 1,
			channels: { slack: { ownerUserId: "UOWNER0" } },
			ompExecutable: "/usr/local/bin/omp",
			workspaceDir: join(home, "workspace"),
			slack: { botTokenFile: join(home, "secrets/bot.token"), appTokenFile: join(home, "secrets/app.token") },
		});
		if (cfg.slack === undefined) throw new Error("expected the Slack token block");
		expect(cfg.slack.appId).toBeUndefined();
		expect(cfg.model).toBeUndefined();
	});

	test("optional fields: slack.appId/teamId/botUserId, model, thinking, sessionRetentionDays, maxBundleBytes", () => {
		writeConfig(
			baseConfig({
				slack: {
					botTokenFile: "secrets/bot.token",
					appTokenFile: "secrets/app.token",
					appId: "A0TEST",
					teamId: "T0TEST",
					botUserId: "U0BOT",
				},
				model: "some/model",
				thinking: "low",
				sessionRetentionDays: 30,
				maxBundleBytes: 268_435_456,
			}),
		);
		const cfg = loadConfig(home);
		expect(cfg.slack).toMatchObject({ appId: "A0TEST", teamId: "T0TEST", botUserId: "U0BOT" });
		expect(cfg).toMatchObject({ model: "some/model", thinking: "low", sessionRetentionDays: 30 });
		expect(cfg.maxBundleBytes).toBe(268_435_456);
	});

	test("timezone: absent → the host zone, given → that zone, unknown name → config error, restart-bound", () => {
		expect(loadConfig(home).timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
		// A fresh process started with TZ set proves "absent" really follows the host zone, not a fixed default.
		const probe = Bun.spawnSync(
			[
				process.execPath,
				"-e",
				`const { loadConfig } = await import(${JSON.stringify(join(import.meta.dir, "../src/config.ts"))}); console.log(loadConfig(${JSON.stringify(home)}).timezone);`,
			],
			{ env: { ...process.env, TZ: "Pacific/Auckland" } },
		);
		expect(probe.stdout.toString().trim()).toBe("Pacific/Auckland");

		writeConfig(baseConfig({ timezone: "America/New_York" }));
		expect(loadConfig(home).timezone).toBe("America/New_York");

		writeConfig(baseConfig({ timezone: "Mars/Base" }));
		const error = catchError(() => loadConfig(home));
		expect(error.code).toBe("config_invalid");
		expect(error.message).toContain("field=timezone");
		expect(RESTART_FIELDS).toContain("timezone");
	});

	test("agent claude with an absolute claudeExecutable is accepted", () => {
		writeConfig(baseConfig({ agent: "claude", claudeExecutable: "/usr/local/bin/claude" }));
		const cfg = loadConfig(home);
		expect(cfg.agent).toBe("claude");
		expect(cfg.claudeExecutable).toBe("/usr/local/bin/claude");
	});

	test("unknown agent value is rejected", () => {
		writeConfig(baseConfig({ agent: "gemini" }));
		const err = catchError(() => loadConfig(home));
		expect(err.message).toContain("field=agent");
	});

	test("relative claudeExecutable is rejected", () => {
		writeConfig(baseConfig({ agent: "claude", claudeExecutable: "claude" }));
		const err = catchError(() => loadConfig(home));
		expect(err.message).toContain("field=claudeExecutable");
	});

	test("agent agy with an absolute agyExecutable is accepted", () => {
		writeConfig(
			baseConfig({ agent: "agy", agyExecutable: "/home/u/.local/bin/agy", model: "agy/gemini-3.8-flash-high" }),
		);
		const cfg = loadConfig(home);
		expect(cfg.agent).toBe("agy");
		expect(cfg.agyExecutable).toBe("/home/u/.local/bin/agy");
		expect(cfg.model).toBe("agy/gemini-3.8-flash-high");
	});

	test("agent agy without agyExecutable leaves it unset (resolved on PATH)", () => {
		writeConfig(baseConfig({ agent: "agy" }));
		const cfg = loadConfig(home);
		expect(cfg.agent).toBe("agy");
		expect(cfg.agyExecutable).toBeUndefined();
	});

	test("relative agyExecutable is rejected", () => {
		writeConfig(baseConfig({ agent: "agy", agyExecutable: "agy" }));
		const err = catchError(() => loadConfig(home));
		expect(err.message).toContain("field=agyExecutable");
	});

	test("readSlackTokens returns trimmed token values", () => {
		expect(readSlackTokens(loadConfig(home))).toEqual({ botToken: "xoxb-TEST-0", appToken: "xapp-TEST-0" });
	});

	test("home 0755 refuses to start", () => {
		chmodSync(home, 0o755);
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("home_permissions");
		expect(err.message).toContain(home);
	});

	test("missing home and missing config", () => {
		expect(catchError(() => loadConfig(join(home, "nope"))).code).toBe("home_missing");
		rmSync(join(home, "config.json"));
		expect(catchError(() => loadConfig(home)).code).toBe("config_missing");
	});

	test("secret file with 0644 is rejected, naming only the path", () => {
		const p = writeSecret("secrets/bot.token", "xoxb-TEST-0", 0o644);
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("secret_permissions");
		expect(err.path).toBe(p);
		expect(err.message).not.toContain("xoxb-TEST-0");
	});

	test("wrong prefix: error names the path and never contains the file content", () => {
		const content = "NOTAKEN-secret-value-123";
		const p = writeSecret("secrets/bot.token", content);
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("token_prefix");
		expect(err.path).toBe(p);
		expect(err.message).toContain(p);
		expect(err.message).not.toContain(content);
		expect(err.message).not.toContain("secret-value");
		expect(String(err.stack)).not.toContain(content);
	});

	test("app token needs xapp- (a bot token in the app slot is rejected)", () => {
		const p = writeSecret("secrets/app.token", "xoxb-TEST-0");
		const err = catchError(() => loadConfig(home));
		expect(err).toMatchObject({ code: "token_prefix", path: p });
		expect(err.message).not.toContain("xoxb-TEST-0");
	});

	test("missing token file", () => {
		rmSync(join(home, "secrets/app.token"));
		expect(catchError(() => loadConfig(home)).code).toBe("secret_missing");
	});

	test("invalid JSON error does not echo file content", () => {
		writeFileSync(join(home, "config.json"), '{"ownerSlackUserId": "UOWNER0", oops xoxb-TEST-0');
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid_json");
		expect(err.message).not.toContain("xoxb-TEST-0");
		expect(err.message).not.toContain("oops");
		expect(err.message).toContain("look for a trailing comma");
		writeFileSync(join(home, "config.json"), '{"schemaVersion": 1, "x": "xoxb-TEST-1" "y": 2}');
		expect(catchError(() => loadConfig(home)).message).not.toContain("xoxb-TEST-1");
	});

	test.each([
		["schemaVersion", baseConfig({ schemaVersion: 2 })],
		["ownerSlackUserId", baseConfig({ ownerSlackUserId: "" })],
		["ompExecutable", baseConfig({ ompExecutable: "omp" })],
		["workspaceDir", baseConfig({ workspaceDir: undefined })],
		["slack.botTokenFile", baseConfig({ slack: { appTokenFile: "secrets/app.token" } })],
		["sessionRetentionDays", baseConfig({ sessionRetentionDays: 0 })],
		["maxBundleBytes", baseConfig({ maxBundleBytes: 0 })],
		["maxBundleBytes", baseConfig({ maxBundleBytes: -1 })],
		["maxBundleBytes", baseConfig({ maxBundleBytes: 1.5 })],
		["maxBundleBytes", baseConfig({ maxBundleBytes: "512MB" })],
		["slack.appId", baseConfig({ slack: { botTokenFile: "a", appTokenFile: "b", appId: 5 } })],
		["model", baseConfig({ model: 3 })],
		["escalationChannel", baseConfig({ escalationChannel: "c0lower123" })],
		["escalationChannel", baseConfig({ escalationChannel: "D0123456789" })],
		["escalationChannel", baseConfig({ escalationChannel: "C012" })],
		["escalationChannel", baseConfig({ escalationChannel: 5 })],
		["logChannel", baseConfig({ logChannel: "c0lower123" })],
		["logChannel", baseConfig({ logChannel: "D0123456789" })],
		["logChannel", baseConfig({ logChannel: 7 })],
		["mentionFreeChannels", baseConfig({ mentionFreeChannels: "C0123456789" })],
		["mentionFreeChannels", baseConfig({ mentionFreeChannels: ["#general"] })],
		["mentionFreeChannels", baseConfig({ mentionFreeChannels: ["C0123456789", "D0123456789"] })],
		["mentionFreeChannels", baseConfig({ mentionFreeChannels: ["C0123456789", ""] })],
		["recallEnabled", baseConfig({ recallEnabled: "false" })],
		["recallEnabled", baseConfig({ recallEnabled: 0 })],
		["peerBots", baseConfig({ peerBots: { userId: "UPEER00001", name: "떡" } })],
		["peerBots.0.userId", baseConfig({ peerBots: [{ userId: "upeer00001", name: "떡" }] })],
		["peerBots.0.userId", baseConfig({ peerBots: [{ userId: "UPEER", name: "떡" }] })],
		["peerBots.0.userId", baseConfig({ peerBots: [{ userId: "UOWNER0", name: "떡" }] })],
		["peerBots.0.name", baseConfig({ peerBots: [{ userId: "UPEER00001", name: "" }] })],
		["peerBots.0.name", baseConfig({ peerBots: [{ userId: "UPEER00001", name: "x".repeat(33) }] })],
		[
			"peerBots.1.token",
			baseConfig({
				peerBots: [
					{ userId: "UPEER00001", name: "a" },
					{ userId: "UPEER00002", name: "b", token: "x" },
				],
			}),
		],
		["requireMention", baseConfig({ requireMention: "true" })],
		["peerHopLimit", baseConfig({ peerHopLimit: 3 })],
		["peerHopLimit.turns", baseConfig({ peerHopLimit: { turns: 0, windowMinutes: 30 } })],
		["peerHopLimit.windowMinutes", baseConfig({ peerHopLimit: { turns: 3, windowMinutes: 1.5 } })],
		["peerHopLimit.windowMinutes", baseConfig({ peerHopLimit: { turns: 3 } })],
		["peerHopLimit.extra", baseConfig({ peerHopLimit: { turns: 3, windowMinutes: 30, extra: 1 } })],
		["costCap", baseConfig({ costCap: 20 })],
		["costCap.turnUsd", baseConfig({ costCap: { turnUsd: 0 } })],
		["costCap.turnUsd", baseConfig({ costCap: { turnUsd: -1 } })],
		["costCap.dailyUsd", baseConfig({ costCap: { dailyUsd: "300" } })],
		["costCap.dailyUsd", baseConfig({ costCap: { dailyUsd: Number.POSITIVE_INFINITY } })],
		["costCap.warnUsd", baseConfig({ costCap: { turnUsd: 20, dailyUsd: 300, warnUsd: 10 } })],
		["lanes", baseConfig({ lanes: 2 })],
		["lanes.completionNudges", baseConfig({ lanes: { completionNudges: -1 } })],
		["lanes.completionNudges", baseConfig({ lanes: { completionNudges: 1.5 } })],
		["lanes.completionNudges", baseConfig({ lanes: { completionNudges: "2" } })],
		["lanes.maxNudges", baseConfig({ lanes: { maxNudges: 2 } })],
	])("invalid field %s is reported by name", (field, cfg) => {
		writeConfig(cfg);
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(`field=${field}`);
	});

	test("escalationChannel is optional and a Slack channel id is accepted", () => {
		expect(loadConfig(home).escalationChannel).toBeUndefined();
		writeConfig(baseConfig({ escalationChannel: "C0ESCALATE1" }));
		expect(loadConfig(home).escalationChannel).toBe("C0ESCALATE1");
	});

	test("logChannel is optional and a Slack channel id is accepted", () => {
		expect(loadConfig(home).logChannel).toBeUndefined();
		writeConfig(baseConfig({ logChannel: "C0LOGCHAN01" }));
		expect(loadConfig(home).logChannel).toBe("C0LOGCHAN01");
	});

	test("recallEnabled is optional and accepts a boolean", () => {
		expect(loadConfig(home).recallEnabled).toBeUndefined();
		writeConfig(baseConfig({ recallEnabled: false }));
		expect(loadConfig(home).recallEnabled).toBe(false);
		writeConfig(baseConfig({ recallEnabled: true }));
		expect(loadConfig(home).recallEnabled).toBe(true);
	});

	test("peerBots, requireMention and peerHopLimit are optional and read as written", () => {
		const loaded = loadConfig(home);
		expect(loaded.peerBots).toBeUndefined();
		expect(loaded.requireMention).toBeUndefined();
		expect(loaded.peerHopLimit).toBeUndefined();
		writeConfig(
			baseConfig({
				peerBots: [{ userId: "U0TESTPEER1", name: "떡" }],
				requireMention: true,
				peerHopLimit: { turns: 2, windowMinutes: 10 },
			}),
		);
		expect(loadConfig(home)).toMatchObject({
			peerBots: [{ userId: "U0TESTPEER1", name: "떡" }],
			requireMention: true,
			peerHopLimit: { turns: 2, windowMinutes: 10 },
		});
	});

	test("costCap is optional, keeps only the ceilings given, and reload treats it as live", () => {
		expect(loadConfig(home).costCap).toBeUndefined();
		writeConfig(baseConfig({ costCap: { turnUsd: 20 } }));
		expect(loadConfig(home).costCap).toEqual({ turnUsd: 20 });
		writeConfig(baseConfig({ costCap: { turnUsd: 20, dailyUsd: 300 } }));
		expect(loadConfig(home).costCap).toEqual({ turnUsd: 20, dailyUsd: 300 });
	});

	test("lanes.completionNudges is optional, takes 0 (off), and reload treats it as live", () => {
		expect(loadConfig(home).lanes).toBeUndefined();
		writeConfig(baseConfig({ lanes: { completionNudges: 0 } }));
		expect(loadConfig(home).lanes).toEqual({ completionNudges: 0 });
		writeConfig(baseConfig({ lanes: { completionNudges: 3 } }));
		expect(loadConfig(home).lanes).toEqual({ completionNudges: 3 });
		expect(LIVE_FIELDS).toContain("lanes");
	});

	test("mentionFreeChannels is optional and accepts only channel ids", () => {
		expect(loadConfig(home).mentionFreeChannels).toBeUndefined();
		writeConfig(baseConfig({ mentionFreeChannels: ["C0123456789"] }));
		expect(loadConfig(home).mentionFreeChannels).toEqual(["C0123456789"]);
	});
});

describe("channels.slack.ownerUserId", () => {
	const legacy = (owner: unknown, extra: Record<string, unknown> = {}) => {
		const { channels: _, ...rest } = baseConfig(extra);
		return { ...rest, ownerSlackUserId: owner };
	};

	test("the new key alone is accepted and nothing is deprecated", () => {
		const cfg = loadConfig(home);
		expect(cfg.channels).toEqual({ slack: { ownerUserId: "UOWNER0" } });
		expect(cfg.deprecated ?? []).toEqual([]);
		expect("ownerSlackUserId" in cfg).toBe(false);
	});

	test("the old ownerSlackUserId alone is read as the Slack owner and reported as deprecated", () => {
		writeConfig(legacy("UOWNER0"));
		const cfg = loadConfig(home);
		if (cfg.channels.slack === undefined) throw new Error("expected channels.slack");
		expect(cfg.channels.slack.ownerUserId).toBe("UOWNER0");
		expect(cfg.deprecated).toEqual(["ownerSlackUserId"]);
	});

	test("both keys with the same value are accepted; different values are rejected under the new key", () => {
		writeConfig(baseConfig({ ownerSlackUserId: "UOWNER0" }));
		expect(loadConfig(home).channels.slack?.ownerUserId).toBe("UOWNER0");
		writeConfig(baseConfig({ ownerSlackUserId: "UOTHER00" }));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain("field=channels.slack.ownerUserId");
	});

	test.each([
		["neither key", legacy(undefined), "field=channels.slack.ownerUserId"],
		["an empty new key", baseConfig({ channels: { slack: { ownerUserId: "" } } }), "field=channels.slack.ownerUserId"],
		[
			"a non-string new key",
			baseConfig({ channels: { slack: { ownerUserId: 7 } } }),
			"field=channels.slack.ownerUserId",
		],
		["an empty old key alone", legacy(""), "field=ownerSlackUserId"],
		["channels not an object", baseConfig({ channels: ["slack"] }), "field=channels"],
		["channels.slack not an object", baseConfig({ channels: { slack: "UOWNER0" } }), "field=channels.slack"],
		[
			"an unknown platform key",
			baseConfig({ channels: { slack: { ownerUserId: "UOWNER0" }, matrix: {} } }),
			"field=channels.matrix",
		],
		[
			"an unknown key under slack",
			baseConfig({ channels: { slack: { ownerUserId: "UOWNER0", botTokenFile: "x" } } }),
			"field=channels.slack.botTokenFile",
		],
	])("%s is config_invalid", (_name, cfg, field) => {
		writeConfig(cfg);
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(field);
	});

	test("the owner can never be a peer bot, whichever key names it", () => {
		writeConfig(legacy("UOWNER0", { peerBots: [{ userId: "UOWNER0", name: "떡" }] }));
		expect(catchError(() => loadConfig(home)).message).toContain("field=peerBots.0.userId");
	});
});

describe("channels.discord", () => {
	const OWNER_ID = "123456789012345678";
	const APP_ID = "234567890123456789";
	// Not a real token: assembled at runtime so no token-shaped literal sits in the repo.
	const TOKEN = ["TEST", "discord", "token"].join("-");
	const discord = (overrides: Record<string, unknown> = {}) => ({
		ownerUserId: OWNER_ID,
		botTokenFile: "secrets/discord.token",
		applicationId: APP_ID,
		...overrides,
	});
	const withDiscord = (overrides: Record<string, unknown> = {}) =>
		baseConfig({ channels: { slack: { ownerUserId: "UOWNER0" }, discord: discord(overrides) } });
	const without = (key: string) => {
		const full: Record<string, unknown> = discord();
		const { [key]: _, ...rest } = full;
		return baseConfig({ channels: { slack: { ownerUserId: "UOWNER0" }, discord: rest } });
	};

	beforeEach(() => {
		writeSecret("secrets/discord.token", `${TOKEN}\n`);
	});

	test("absent: Discord is off", () => {
		expect(loadConfig(home).channels.discord).toBeUndefined();
	});

	test("present: owner, application, absolute token path and the optional policy keys; never the token value", () => {
		writeConfig(
			withDiscord({
				guildIds: ["345678901234567890"],
				mentionFreeChannels: ["456789012345678901"],
				requireMention: true,
				laneChannelId: "567890123456789012",
				displayName: "송박",
			}),
		);
		const cfg = loadConfig(home);
		expect(cfg.channels.discord).toEqual({
			ownerUserId: OWNER_ID,
			botTokenFile: join(home, "secrets/discord.token"),
			applicationId: APP_ID,
			guildIds: ["345678901234567890"],
			mentionFreeChannels: ["456789012345678901"],
			requireMention: true,
			laneChannelId: "567890123456789012",
			displayName: "송박",
		});
		expect(JSON.stringify(cfg)).not.toContain(TOKEN);
		writeConfig(withDiscord());
		expect(loadConfig(home).channels.discord).toEqual({
			ownerUserId: OWNER_ID,
			botTokenFile: join(home, "secrets/discord.token"),
			applicationId: APP_ID,
		});
	});

	test("logChannelId and escalationChannelId: snowflakes are taken; a top-level Slack logChannel stays as it was", () => {
		writeConfig({
			...withDiscord({ logChannelId: "678901234567890123", escalationChannelId: "789012345678901234" }),
			logChannel: "C0LOGCHAN01",
			escalationChannel: "C0ESCALATE1",
		});
		const cfg = loadConfig(home);
		expect(cfg.channels.discord?.logChannelId).toBe("678901234567890123");
		expect(cfg.channels.discord?.escalationChannelId).toBe("789012345678901234");
		expect(cfg.logChannel).toBe("C0LOGCHAN01");
		expect(cfg.escalationChannel).toBe("C0ESCALATE1");
	});

	test.each([
		["a Slack-style logChannelId", { logChannelId: "C0LOGCHAN01" }, "channels.discord.logChannelId"],
		["a numeric logChannelId", { logChannelId: 678901234567890 }, "channels.discord.logChannelId"],
		[
			"a Slack-style escalationChannelId",
			{ escalationChannelId: "C0ESCALATE1" },
			"channels.discord.escalationChannelId",
		],
		[
			"logChannelId equal to escalationChannelId",
			{ logChannelId: "678901234567890123", escalationChannelId: "678901234567890123" },
			"channels.discord.logChannelId",
		],
		[
			"logChannelId equal to laneChannelId",
			{ logChannelId: "678901234567890123", laneChannelId: "678901234567890123" },
			"channels.discord.logChannelId",
		],
		[
			"logChannelId among mentionFreeChannels",
			{ logChannelId: "678901234567890123", mentionFreeChannels: ["456789012345678901", "678901234567890123"] },
			"channels.discord.logChannelId",
		],
	])("%s is config_invalid", (_name, overrides, field) => {
		writeConfig(withDiscord(overrides));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(`field=${field}`);
	});

	test("readDiscordToken returns the one-line value", () => {
		writeConfig(withDiscord());
		expect(readDiscordToken(loadConfig(home))).toBe(TOKEN);
	});

	test.each([
		["no ownerUserId", without("ownerUserId"), "field=channels.discord.ownerUserId"],
		["no botTokenFile", without("botTokenFile"), "field=channels.discord.botTokenFile"],
		["no applicationId", without("applicationId"), "field=channels.discord.applicationId"],
		["a short ownerUserId", withDiscord({ ownerUserId: "1234" }), "field=channels.discord.ownerUserId"],
		["a Slack-style ownerUserId", withDiscord({ ownerUserId: "UOWNER0" }), "field=channels.discord.ownerUserId"],
		["a numeric ownerUserId", withDiscord({ ownerUserId: 12345678901234 }), "field=channels.discord.ownerUserId"],
		[
			"a 21-digit applicationId",
			withDiscord({ applicationId: "123456789012345678901" }),
			"field=channels.discord.applicationId",
		],
		["an empty botTokenFile", withDiscord({ botTokenFile: "" }), "field=channels.discord.botTokenFile"],
		["guildIds not an array", withDiscord({ guildIds: "345678901234567890" }), "field=channels.discord.guildIds"],
		["guildIds with a non-number", withDiscord({ guildIds: ["C0123ABCD"] }), "field=channels.discord.guildIds"],
		[
			"mentionFreeChannels with a number value",
			withDiscord({ mentionFreeChannels: [45678901234567] }),
			"field=channels.discord.mentionFreeChannels",
		],
		["requireMention not a boolean", withDiscord({ requireMention: "yes" }), "field=channels.discord.requireMention"],
		[
			"a Slack-style laneChannelId",
			withDiscord({ laneChannelId: "C0123ABCD" }),
			"field=channels.discord.laneChannelId",
		],
		[
			"a numeric laneChannelId",
			withDiscord({ laneChannelId: 45678901234567890 }),
			"field=channels.discord.laneChannelId",
		],
		["a numeric displayName", withDiscord({ displayName: 123 }), "field=channels.discord.displayName"],
		["an empty displayName", withDiscord({ displayName: "" }), "field=channels.discord.displayName"],
		["a 33-character displayName", withDiscord({ displayName: "가".repeat(33) }), "field=channels.discord.displayName"],
		["an unknown key", withDiscord({ botToken: "x" }), "field=channels.discord.botToken"],
		[
			"discord not an object",
			baseConfig({ channels: { slack: { ownerUserId: "UOWNER0" }, discord: true } }),
			"field=channels.discord",
		],
	])("%s is config_invalid", (_name, cfg, field) => {
		writeConfig(cfg);
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(field);
		expect(err.message).not.toContain(TOKEN);
	});

	test("token file: missing → secret_missing, not 0600 → secret_permissions", () => {
		writeConfig(withDiscord({ botTokenFile: "secrets/none.token" }));
		expect(catchError(() => loadConfig(home)).code).toBe("secret_missing");
		writeSecret("secrets/discord.token", `${TOKEN}\n`, 0o644);
		writeConfig(withDiscord());
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("secret_permissions");
		expect(err.message).not.toContain(TOKEN);
	});

	test.each([
		["empty", "\n"],
		["two lines", `${TOKEN}\n${TOKEN}\n`],
	])("token file %s → config_invalid without the value", (_name, content) => {
		writeSecret("secrets/discord.token", content);
		writeConfig(withDiscord());
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain("field=channels.discord.botTokenFile");
		expect(err.message).not.toContain(TOKEN);
	});

	test("checkTokens: false skips the token file", () => {
		writeConfig(withDiscord({ botTokenFile: "secrets/none.token" }));
		expect(loadConfig(home, { checkTokens: false }).channels.discord?.applicationId).toBe(APP_ID);
	});

	test("channels needs a restart on reload", () => {
		expect(RESTART_FIELDS as readonly string[]).toContain("channels");
	});

	test("peerBots: snowflake ids with a name load as written", () => {
		writeConfig(withDiscord({ peerBots: [{ userId: "678901234567890123", name: "떡" }] }));
		expect(loadConfig(home).channels.discord?.peerBots).toEqual([{ userId: "678901234567890123", name: "떡" }]);
		writeConfig(withDiscord());
		expect(loadConfig(home).channels.discord?.peerBots).toBeUndefined();
	});

	test.each([
		["peerBots not an array", { peerBots: { userId: "678901234567890123", name: "떡" } }, "channels.discord.peerBots"],
		["a Slack peer id", { peerBots: [{ userId: "UPEER00001", name: "떡" }] }, "channels.discord.peerBots.0.userId"],
		["a numeric peer id", { peerBots: [{ userId: 12345678901234, name: "떡" }] }, "channels.discord.peerBots.0.userId"],
		["the owner as peer", { peerBots: [{ userId: OWNER_ID, name: "떡" }] }, "channels.discord.peerBots.0.userId"],
		["an empty name", { peerBots: [{ userId: "678901234567890123", name: "" }] }, "channels.discord.peerBots.0.name"],
		[
			"a 33-character name",
			{ peerBots: [{ userId: "678901234567890123", name: "x".repeat(33) }] },
			"channels.discord.peerBots.0.name",
		],
		[
			"another key",
			{
				peerBots: [
					{ userId: "678901234567890123", name: "a" },
					{ userId: "789012345678901234", name: "b", token: "x" },
				],
			},
			"channels.discord.peerBots.1.token",
		],
	])("peerBots: %s is config_invalid", (_name, overrides, field) => {
		writeConfig(withDiscord(overrides));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(`field=${field})`);
	});
});

describe("offsite", () => {
	test("is optional; ssh alias / user@host and absolute or ~/ remoteDir are accepted, keep defaults off", () => {
		expect(loadConfig(home).offsite).toBeUndefined();
		writeConfig(baseConfig({ offsite: { ssh: "backup-box", remoteDir: "~/ompbot-backups" } }));
		expect(loadConfig(home).offsite).toEqual({ ssh: "backup-box", remoteDir: "~/ompbot-backups" });
		writeConfig(baseConfig({ offsite: { ssh: "ubuntu@10.0.0.5", remoteDir: "/srv/ompbot", keep: 7 } }));
		expect(loadConfig(home).offsite).toEqual({ ssh: "ubuntu@10.0.0.5", remoteDir: "/srv/ompbot", keep: 7 });
	});

	test.each([
		[{ ssh: "-oProxyCommand=x", remoteDir: "/srv/x" }, "offsite.ssh"],
		[{ ssh: "host name", remoteDir: "/srv/x" }, "offsite.ssh"],
		[{ ssh: "host;rm", remoteDir: "/srv/x" }, "offsite.ssh"],
		[{ remoteDir: "/srv/x" }, "offsite.ssh"],
		[{ ssh: "box", remoteDir: "relative/dir" }, "offsite.remoteDir"],
		[{ ssh: "box", remoteDir: "/srv/a b" }, "offsite.remoteDir"],
		[{ ssh: "box", remoteDir: "/srv/$(id)" }, "offsite.remoteDir"],
		[{ ssh: "box", remoteDir: "/srv/../etc" }, "offsite.remoteDir"],
		[{ ssh: "box", remoteDir: "~/" }, "offsite.remoteDir"],
		[{ ssh: "box", remoteDir: "/srv/x", keep: 0 }, "offsite.keep"],
		[{ ssh: "box", remoteDir: "/srv/x", keep: 1.5 }, "offsite.keep"],
	])("rejects %j", (offsite, field) => {
		writeConfig(baseConfig({ offsite }));
		expect(catchError(() => loadConfig(home)).message).toContain(field);
	});
});

describe("herdr", () => {
	const hosts = { wsl: { ssh: "wsl" } };
	const board = { url: "https://board.example.com/task/" };

	test("is optional (absent = off); {} and an absolute bin are accepted", () => {
		expect(loadConfig(home).herdr).toBeUndefined();
		writeConfig(baseConfig({ herdr: {} }));
		expect(loadConfig(home).herdr).toEqual({});
		writeConfig(baseConfig({ herdr: { bin: "/opt/herdr/bin/herdr" }, dispatchHosts: hosts, herdrBoard: board }));
		const cfg = loadConfig(home);
		expect(cfg.herdr).toEqual({ bin: "/opt/herdr/bin/herdr" });
		expect(cfg.dispatchHosts).toEqual(hosts);
		expect(cfg.herdrBoard).toEqual(board);
	});

	test.each([
		["dispatchHosts without herdr", baseConfig({ dispatchHosts: hosts }), "(field=herdr)"],
		["herdrBoard without herdr", baseConfig({ herdrBoard: board }), "(field=herdr)"],
		["relative herdr.bin", baseConfig({ herdr: { bin: "bin/herdr" } }), "(field=herdr.bin)"],
		["bare herdr.bin", baseConfig({ herdr: { bin: "herdr" } }), "(field=herdr.bin)"],
		["non-string herdr.bin", baseConfig({ herdr: { bin: 5 } }), "(field=herdr.bin)"],
		["non-object herdr", baseConfig({ herdr: true }), "(field=herdr)"],
	])("%s is rejected", (_name, cfg, field) => {
		writeConfig(cfg);
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(field);
	});

	test("workerOmpArgs and dispatchHosts.<h>.ompArgs load as given; absent stays absent", () => {
		writeConfig(baseConfig({ herdr: {}, dispatchHosts: hosts }));
		const plain = loadConfig(home);
		expect(plain.workerOmpArgs).toBeUndefined();
		expect(plain.dispatchHosts?.wsl).toEqual({ ssh: "wsl" });
		const withArgs = { wsl: { ssh: "wsl", ompArgs: ["--prewalk", "--thinking", "high"] } };
		writeConfig(baseConfig({ herdr: {}, dispatchHosts: withArgs, workerOmpArgs: ["--prewalk"] }));
		const cfg = loadConfig(home);
		expect(cfg.workerOmpArgs).toEqual(["--prewalk"]);
		expect(cfg.dispatchHosts).toEqual(withArgs);
	});

	test.each([
		["a string workerOmpArgs", { workerOmpArgs: "--prewalk" }, "(field=workerOmpArgs)"],
		["an empty-string workerOmpArgs element", { workerOmpArgs: ["--prewalk", ""] }, "(field=workerOmpArgs)"],
		["a blank workerOmpArgs element", { workerOmpArgs: ["  "] }, "(field=workerOmpArgs)"],
		["a non-string workerOmpArgs element", { workerOmpArgs: [1] }, "(field=workerOmpArgs)"],
		[
			"an object ompArgs",
			{ dispatchHosts: { wsl: { ssh: "wsl", ompArgs: { a: 1 } } } },
			"(field=dispatchHosts.wsl.ompArgs)",
		],
		[
			"an empty-string ompArgs element",
			{ dispatchHosts: { wsl: { ssh: "wsl", ompArgs: [""] } } },
			"(field=dispatchHosts.wsl.ompArgs)",
		],
	])("%s is rejected naming the key", (_name, extra, field) => {
		writeConfig(baseConfig({ herdr: {}, ...extra }));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(field);
	});
});

describe("taskAutoLand", () => {
	const withHerdr = (taskAutoLand: unknown) => baseConfig({ herdr: {}, taskAutoLand });

	test("AC-5: is optional; repos are kept with their trailing slash dropped, maxRisk when given", () => {
		writeConfig(baseConfig({ herdr: {} }));
		expect(loadConfig(home).taskAutoLand).toBeUndefined();
		writeConfig(withHerdr({ repos: ["/home/owner/work/ompbot/", "/home/owner/work/home-bot"] }));
		expect(loadConfig(home).taskAutoLand).toEqual({
			repos: ["/home/owner/work/ompbot", "/home/owner/work/home-bot"],
		});
		writeConfig(withHerdr({ repos: ["/srv/repo//"], maxRisk: "L1" }));
		expect(loadConfig(home).taskAutoLand).toEqual({ repos: ["/srv/repo"], maxRisk: "L1" });
	});

	test.each([
		["empty repos", withHerdr({ repos: [] }), "(field=taskAutoLand.repos)"],
		["repos not an array", withHerdr({ repos: "/srv/repo" }), "(field=taskAutoLand.repos)"],
		["a relative repo", withHerdr({ repos: ["/srv/a", "work/ompbot"] }), "(field=taskAutoLand.repos.1)"],
		["a non-string repo", withHerdr({ repos: [7] }), "(field=taskAutoLand.repos.0)"],
		["maxRisk outside L0~L4", withHerdr({ repos: ["/srv/a"], maxRisk: "L5" }), "(field=taskAutoLand.maxRisk)"],
		["a lower-case maxRisk", withHerdr({ repos: ["/srv/a"], maxRisk: "l2" }), "(field=taskAutoLand.maxRisk)"],
		["an undefined key", withHerdr({ repos: ["/srv/a"], hosts: ["wsl"] }), "(field=taskAutoLand.hosts)"],
		["a non-object", withHerdr(["/srv/a"]), "(field=taskAutoLand)"],
	])("AC-5: %s is rejected", (_name, cfg, field) => {
		writeConfig(cfg);
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(field);
	});

	test("lane parity AC-15: taskAutoLand alone is accepted without herdr (work lanes land without it)", () => {
		writeConfig(baseConfig({ taskAutoLand: { repos: ["/srv/a/"], maxRisk: "L1" } }));
		const cfg = loadConfig(home);
		expect(cfg.herdr).toBeUndefined();
		expect(cfg.taskAutoLand).toEqual({ repos: ["/srv/a"], maxRisk: "L1" });
	});

	test.each([
		["dispatchHosts", { dispatchHosts: { wsl: { ssh: "wsl" } } }],
		["herdrBoard", { herdrBoard: { url: "https://board.example.com/task/" } }],
	])("lane parity AC-15: %s beside taskAutoLand still needs herdr (field=herdr)", (_name, extra) => {
		writeConfig(baseConfig({ taskAutoLand: { repos: ["/srv/a"] }, ...extra }));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain("(field=herdr)");
	});

	test("lane review AC-9: review is kept with its model and timeoutMs (timeoutMs optional)", () => {
		writeConfig(withHerdr({ repos: ["/srv/a"], review: { model: "anthropic/claude-sonnet-5-5:medium" } }));
		expect(loadConfig(home).taskAutoLand).toEqual({
			repos: ["/srv/a"],
			review: { model: "anthropic/claude-sonnet-5-5:medium" },
		});
		writeConfig(withHerdr({ repos: ["/srv/a"], review: { model: "m", timeoutMs: 1_800_000 } }));
		expect(loadConfig(home).taskAutoLand?.review).toEqual({ model: "m", timeoutMs: 1_800_000 });
	});

	test.each([
		["an empty model", { model: "" }, "(field=taskAutoLand.review.model)"],
		["a blank model", { model: "  " }, "(field=taskAutoLand.review.model)"],
		["no model", { timeoutMs: 1000 }, "(field=taskAutoLand.review.model)"],
		// lane review isolation AC-4: the reviewer's overlay disables the `cursor` provider.
		["a cursor/ model", { model: "cursor/gpt-5" }, "(field=taskAutoLand.review.model)"],
		["timeoutMs 0", { model: "m", timeoutMs: 0 }, "(field=taskAutoLand.review.timeoutMs)"],
		["a negative timeoutMs", { model: "m", timeoutMs: -1 }, "(field=taskAutoLand.review.timeoutMs)"],
		["timeoutMs 1800001", { model: "m", timeoutMs: 1_800_001 }, "(field=taskAutoLand.review.timeoutMs)"],
		["a fractional timeoutMs", { model: "m", timeoutMs: 1.5 }, "(field=taskAutoLand.review.timeoutMs)"],
		["an unknown key", { model: "m", tools: "read" }, "(field=taskAutoLand.review.tools)"],
		["a non-object", "m", "(field=taskAutoLand.review)"],
	])("lane review AC-9: %s is rejected", (_name, review, field) => {
		writeConfig(withHerdr({ repos: ["/srv/a"], review }));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(field);
	});

	test("AC-5: taskAutoLand is a live field (ompbot reload applies it without a restart)", () => {
		expect(LIVE_FIELDS).toContain("taskAutoLand");
	});
});

describe("dashboard", () => {
	test("port and loopback bind are accepted; bind defaults to unset", () => {
		writeConfig(baseConfig({ dashboard: { port: 7331 } }));
		expect(loadConfig(home).dashboard).toEqual({ port: 7331 });
		writeConfig(baseConfig({ dashboard: { port: 7331, bind: "::1" } }));
		expect(loadConfig(home).dashboard).toEqual({ port: 7331, bind: "::1" });
		writeConfig(baseConfig({ dashboard: { port: 7331, herdrWebUrl: "https://herdr.example.test/" } }));
		expect(loadConfig(home).dashboard).toEqual({ port: 7331, herdrWebUrl: "https://herdr.example.test/" });
	});

	test.each([
		[{ port: 7331, bind: "0.0.0.0" }, "dashboard.bind"],
		[{ port: 0 }, "dashboard.port"],
		[{ port: 70000 }, "dashboard.port"],
		[{ bind: "127.0.0.1" }, "dashboard.port"],
		[{ port: 7331, token: "x" }, "dashboard.token"],
		[{ port: 7331, herdrWebUrl: "javascript:alert(1)" }, "dashboard.herdrWebUrl"],
		[{ port: 7331, herdrWebUrl: 7317 }, "dashboard.herdrWebUrl"],
		["7331", "field=dashboard"],
	])("AC-8: %j is a ConfigError naming %s", (dashboard, field) => {
		writeConfig(baseConfig({ dashboard }));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(field);
	});

	test("checkTokens: false loads a config whose token files are missing", () => {
		rmSync(join(home, "secrets"), { recursive: true, force: true });
		expect(catchError(() => loadConfig(home)).code).toBe("secret_missing");
		expect(loadConfig(home, { checkTokens: false }).channels.slack?.ownerUserId).toBe("UOWNER0");
	});
});

describe("Slack off: channels.slack absent (teams-channel TASK A)", () => {
	const DISCORD_OWNER_ID = "123456789012345678"; // gitleaks:allow (fake snowflake)
	const discordOnly = (extra: Record<string, unknown> = {}) => {
		const { slack: _slack, ...rest } = baseConfig(extra);
		return {
			...rest,
			channels: {
				discord: {
					ownerUserId: DISCORD_OWNER_ID,
					botTokenFile: "secrets/discord.token",
					applicationId: "234567890123456789",
				},
			},
		};
	};

	beforeEach(() => {
		writeSecret("secrets/discord.token", ["TEST", "discord", "token"].join("-"));
		// No Slack token file exists at all: any attempt to read one fails with secret_missing.
		rmSync(join(home, "secrets/bot.token"));
		rmSync(join(home, "secrets/app.token"));
	});

	test("AC-A1: a Discord-only config loads, binds Discord alone and the daemon starts without Slack tokens", async () => {
		writeConfig(discordOnly());
		const config = loadConfig(home);
		expect(config.channels.slack).toBeUndefined();
		expect(config.slack).toBeUndefined();
		expect(config.channels.discord?.ownerUserId).toBe(DISCORD_OWNER_ID);
		expect(() => readSlackTokens(config)).toThrow("channels.slack is not configured");

		const logs: string[] = [];
		const log = createLogger({ sink: (line) => logs.push(line), clock: { now: () => Date.now() }, redact });
		const env = { OMPBOT_TEST_HOOKS: "1", OMPBOT_TEST_DISCORD_TRANSPORT: join(home, "discord-calls.jsonl") };
		const channels = channelBindings(config, env, log);
		expect(channels.map((binding) => binding.port.platform)).toEqual(["discord"]);

		const sessions = new FakeSessionStore();
		const daemon = new Daemon({
			config,
			channels,
			log,
			ompVersion: "omp-test 0",
			bootId: "boot",
			gateSweepMs: 0,
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		try {
			await daemon.start();
		} finally {
			await daemon.stop();
		}
		const ready = logs.find((line) => line.includes("event=daemon_ready"));
		expect(ready).toContain("slack=off");
		expect(ready).toContain("discord=on");
		expect(logs.some((line) => line.includes("secret_missing"))).toBe(false);
	});

	test("no platform at all is config_invalid field=channels", () => {
		const { slack: _slack, channels: _channels, ...rest } = baseConfig();
		writeConfig(rest);
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain("field=channels");
		writeConfig({ ...rest, channels: {} });
		expect(catchError(() => loadConfig(home)).message).toContain("field=channels");
	});

	test.each([
		["peerBots", { peerBots: [{ userId: "UPEER00001", name: "떡" }] }],
		["logChannel", { logChannel: "C0LOGCHAN01" }],
		["escalationChannel", { escalationChannel: "C0ESCALATE1" }],
		["mentionFreeChannels", { mentionFreeChannels: ["C0123456789"] }],
	])("a Slack id key %s without Slack is config_invalid", (field, extra) => {
		writeConfig(discordOnly(extra));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_invalid");
		expect(err.message).toContain(`field=${field}`);
	});

	test("channels.discord.logChannelId and escalationChannelId load without Slack", () => {
		const config = discordOnly();
		writeConfig({
			...config,
			channels: {
				discord: {
					...config.channels.discord,
					logChannelId: "678901234567890123",
					escalationChannelId: "789012345678901234",
				},
			},
		});
		const loaded = loadConfig(home);
		expect(loaded.channels.slack).toBeUndefined();
		expect(loaded.channels.discord?.logChannelId).toBe("678901234567890123");
		expect(loaded.channels.discord?.escalationChannelId).toBe("789012345678901234");
	});

	test("channels.discord.peerBots and peerHopLimit load without Slack", () => {
		const config = discordOnly({ peerHopLimit: { turns: 2, windowMinutes: 10 } });
		writeConfig({
			...config,
			channels: {
				discord: { ...config.channels.discord, peerBots: [{ userId: "678901234567890123", name: "떡" }] },
			},
		});
		const loaded = loadConfig(home);
		expect(loaded.channels.slack).toBeUndefined();
		expect(loaded.channels.discord?.peerBots).toEqual([{ userId: "678901234567890123", name: "떡" }]);
		expect(loaded.peerHopLimit).toEqual({ turns: 2, windowMinutes: 10 });
		expect(loaded.peerBots).toBeUndefined();
	});

	test("a Slack token block without a Slack owner is still config_invalid under channels.slack.ownerUserId", () => {
		writeConfig({ ...discordOnly(), slack: { botTokenFile: "secrets/bot.token", appTokenFile: "secrets/app.token" } });
		expect(catchError(() => loadConfig(home)).message).toContain("field=channels.slack.ownerUserId");
	});

	test("channels.slack without the top-level slack token block is config_invalid field=slack", () => {
		const { slack: _slack, ...rest } = baseConfig();
		writeConfig(rest);
		expect(catchError(() => loadConfig(home)).message).toContain("(field=slack)");
	});
});

describe("qa50b lane I", () => {
	test("I-1: config.json that is a directory is config_unreadable, not config_missing", () => {
		rmSync(join(home, "config.json"));
		mkdirSync(join(home, "config.json"));
		const err = catchError(() => loadConfig(home));
		expect(err.code).toBe("config_unreadable");
		expect(err.message).toContain("EISDIR");
		rmSync(join(home, "config.json"), { recursive: true });
		expect(catchError(() => loadConfig(home)).code).toBe("config_missing");
	});

	test("I-2: a config.json starting with a UTF-8 BOM loads", () => {
		writeFileSync(join(home, "config.json"), `\ufeff${JSON.stringify(baseConfig())}`);
		expect(loadConfig(home).channels.slack?.ownerUserId).toBe("UOWNER0");
	});

	test("I-3: unknown top-level keys load but are listed as warnings (key name only)", () => {
		writeConfig(baseConfig({ bogusKey: "xoxb-TEST-0", ownerSlackUserId: "UOWNER0" }));
		const cfg = loadConfig(home);
		expect(cfg.warnings).toEqual([{ field: "bogusKey", reason: "unknown_key" }]);
		writeConfig(baseConfig());
		expect(loadConfig(home).warnings).toBeUndefined();
	});

	test("I-5/7/11/13: an empty OMPBOT_HOME means unset", () => {
		const fallback = defaultHomeDir({});
		expect(defaultHomeDir({ OMPBOT_HOME: "" })).toBe(fallback);
		expect(defaultHomeDir({ OMPBOT_HOME: "/x/home" })).toBe("/x/home");
	});

	test("I-6: a dispatchHosts name with control characters loads but is flagged", () => {
		writeConfig(baseConfig({ herdr: {}, dispatchHosts: { "wsl\nfake ok": { ssh: "wsl" }, "oci-2": { ssh: "oci" } } }));
		const cfg = loadConfig(home);
		expect(cfg.warnings).toEqual([{ field: "dispatchHosts", reason: "unsafe_name" }]);
		expect(Object.keys(cfg.dispatchHosts ?? {})).toContain("oci-2");
	});

	test("I-9: remoteDir slashes are collapsed; one that collapses to an empty dir is flagged", () => {
		writeConfig(baseConfig({ offsite: { ssh: "box", remoteDir: "~//backups//x/" } }));
		expect(loadConfig(home).offsite?.remoteDir).toBe("~/backups/x/");
		writeConfig(baseConfig({ offsite: { ssh: "box", remoteDir: "//" } }));
		const cfg = loadConfig(home);
		expect(cfg.warnings).toEqual([{ field: "offsite.remoteDir", reason: "unusable" }]);
		expect(isOffsiteDir(cfg.offsite?.remoteDir ?? "")).toBe(false);
	});

	test("I-10: isOffsiteDir agrees with the config check on `..` (segment only)", () => {
		writeConfig(baseConfig({ offsite: { ssh: "box", remoteDir: "/srv/a..b" } }));
		const dir = loadConfig(home).offsite?.remoteDir ?? "";
		expect(isOffsiteDir(dir)).toBe(true);
		expect(isOffsiteDir("/srv/../etc")).toBe(false);
		expect(isOffsiteDir("~/")).toBe(false);
		expect(isOffsiteDir("/")).toBe(false);
	});
});
