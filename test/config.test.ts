import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig, readSlackTokens } from "../src/config";
import { LIVE_FIELDS } from "../src/daemon/reload";

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
		ownerSlackUserId: "UOWNER0",
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
			ownerSlackUserId: "UOWNER0",
			ompExecutable: "/usr/local/bin/omp",
			workspaceDir: join(home, "workspace"),
			slack: { botTokenFile: join(home, "secrets/bot.token"), appTokenFile: join(home, "secrets/app.token") },
		});
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

	test("mentionFreeChannels is optional and accepts only channel ids", () => {
		expect(loadConfig(home).mentionFreeChannels).toBeUndefined();
		writeConfig(baseConfig({ mentionFreeChannels: ["C0123456789"] }));
		expect(loadConfig(home).mentionFreeChannels).toEqual(["C0123456789"]);
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
		["taskAutoLand without herdr", baseConfig({ taskAutoLand: { repos: ["/srv/a"] } }), "(field=herdr)"],
	])("AC-5: %s is rejected", (_name, cfg, field) => {
		writeConfig(cfg);
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
		expect(loadConfig(home, { checkTokens: false }).ownerSlackUserId).toBe("UOWNER0");
	});
});
