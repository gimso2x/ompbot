import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebClient } from "@slack/web-api";
import {
	ConfigError,
	HOME_MODE,
	loadConfig,
	type OmpbotConfig,
	readDiscordToken,
	readSlackTokens,
	SECRET_MODE,
} from "../config";
import { DiscordRest } from "../discord/rest";
import { checkOmpRuntime } from "../omp/runtime-check";
import { BUNDLE_SOURCES, readStamp } from "../ops/backup";
import { BACKUP_MAX_AGE_MS } from "../ops/gates";
import { readVersion } from "./tools";

/** Whether something accepts TCP connections at `host:port` (the webhook listener answers only when it bound). */
function listening(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ host, port, timeout: 1000 });
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("timeout", () => {
			socket.destroy();
			resolve(false);
		});
		socket.once("error", () => resolve(false));
	});
}

const modeOf = (path: string): number => statSync(path).mode & 0o777;
const octal = (mode: number): string => `0${mode.toString(8)}`;

type Report = (ok: boolean, name: string, detail: string) => void;

/**
 * `channels.discord` set: the token file's mode, then the token against `GET /users/@me` (bot id and name) and
 * `GET /gateway/bot` (gateway URL). Only ids, names and URLs are printed. Off: no line at all.
 */
export async function checkDiscord(
	config: OmpbotConfig,
	report: Report,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	const discord = config.channels.discord;
	if (discord === undefined) return;
	let token: string;
	try {
		const mode = modeOf(discord.botTokenFile);
		report(mode === SECRET_MODE, "discord token", `mode=${octal(mode)} expected=${octal(SECRET_MODE)}`);
		if (mode !== SECRET_MODE) return;
		token = readDiscordToken(config);
	} catch (error) {
		report(false, "discord token", error instanceof ConfigError ? error.code : "missing");
		return;
	}
	const rest = new DiscordRest({ token, fetchImpl });
	try {
		const user = await rest.getCurrentUser();
		report(true, "discord users/@me", `bot_user_id=${user.id} username=${user.username ?? "?"}`);
	} catch (error) {
		report(false, "discord users/@me", error instanceof Error ? error.message : String(error));
	}
	try {
		const gateway = await rest.getGatewayBot();
		report(true, "discord gateway/bot", `url=${gateway.url}`);
	} catch (error) {
		report(false, "discord gateway/bot", error instanceof Error ? error.message : String(error));
	}
}

/**
 * Prints one `ok`/`fail` line per check. Only paths, modes, token *prefixes* and public ids are printed; token values
 * never leave `readSlackTokens`. Returns 0 when every check passed.
 */
export async function runDoctor(homeDir: string, write: (line: string) => void): Promise<number> {
	let failures = 0;
	const report = (ok: boolean, name: string, detail: string): void => {
		if (!ok) failures += 1;
		write(`${ok ? "ok" : "fail"} ${name}: ${detail}`);
	};

	let config: OmpbotConfig | undefined;
	try {
		const homeMode = modeOf(homeDir);
		report(homeMode === HOME_MODE, "home", `${homeDir} mode=${octal(homeMode)} expected=${octal(HOME_MODE)}`);
	} catch {
		report(false, "home", `${homeDir} missing`);
	}
	try {
		config = loadConfig(homeDir);
		report(true, "config", config.configPath);
	} catch (error) {
		report(false, "config", error instanceof ConfigError ? error.message : "unreadable");
	}
	if (config) {
		for (const [name, path, prefix] of [
			["slack-bot-token", config.slack.botTokenFile, "xoxb-"],
			["slack-app-token", config.slack.appTokenFile, "xapp-"],
		] as const) {
			try {
				const mode = modeOf(path);
				report(
					mode === SECRET_MODE,
					`secret ${name}`,
					`mode=${octal(mode)} expected=${octal(SECRET_MODE)} prefix=${prefix}`,
				);
			} catch {
				report(false, `secret ${name}`, "missing");
			}
		}

		try {
			accessSync(config.ompExecutable, constants.X_OK);
			const version = await readVersion([config.ompExecutable, "--version"]);
			report(version !== "unknown", "omp", `${config.ompExecutable} ${version}`);
		} catch {
			report(false, "omp", `${config.ompExecutable} not executable`);
		}

		// The same check the RPC driver runs before every spawn, so a fresh install with the standalone binary or a
		// too-old bun fails here instead of on the first DM. Skipped when omp or bun is missing (reported elsewhere)
		// and for agent "claude", which never spawns omp; an unreadable launcher (a directory, no permission) is a
		// failed line, not an exception that ends the whole report.
		const runtimeBun = Bun.which("bun");
		if (config.agent !== "claude" && runtimeBun !== null && existsSync(config.ompExecutable)) {
			try {
				const cliPath = realpathSync(config.ompExecutable);
				const problem = checkOmpRuntime(cliPath, runtimeBun);
				report(
					problem === undefined,
					"omp runtime",
					problem === undefined ? `launcher=${cliPath}` : `${problem.code} ${problem.message}`,
				);
			} catch (error) {
				report(
					false,
					"omp runtime",
					`${config.ompExecutable} unreadable (${(error as NodeJS.ErrnoException).code ?? String(error)})`,
				);
			}
		}

		if (config.webhook !== undefined) {
			const { port, bind = "127.0.0.1" } = config.webhook;
			const up = await listening(bind, port);
			report(
				up,
				"webhook",
				up
					? `${bind}:${port} listening`
					: `${bind}:${port} not listening (daemon down or webhook_bind_failed in the log)`,
			);
		}

		// agent "claude": the CLI must exist, and auth must come from ~/.claude credentials or a key env
		// (names only — values are never read here).
		if (config.agent === "claude") {
			const given = config.claudeExecutable ?? "claude";
			try {
				const executable = given.includes("/") ? given : (Bun.which(given) ?? "");
				if (executable === "") throw new Error("not on PATH");
				accessSync(executable, constants.X_OK);
				const version = await readVersion([executable, "--version"]);
				report(version !== "unknown", "claude", `${executable} ${version}`);
			} catch {
				report(false, "claude", `${given} not executable`);
			}
			const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
			const credentials = join(configDir, ".credentials.json");
			if (existsSync(credentials)) {
				report(true, "claude auth", `${credentials} present`);
			} else if (process.env.ANTHROPIC_API_KEY !== undefined || process.env.CLAUDE_CODE_OAUTH_TOKEN !== undefined) {
				report(true, "claude auth", "key env present");
			} else {
				report(
					false,
					"claude auth",
					`no ${credentials} and no ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN (run: claude /login)`,
				);
			}
		}
	}
	const bunPath = Bun.which("bun");
	report(bunPath !== null, "bun", `${bunPath ?? "not on PATH"} ${Bun.version}`);

	// The bundle carries the conversation memory and operator files (sessions/, config.json, workspace/, scripts/); a home that only backs up the ledger
	// is half protected, so the stamp must name a bundle that still exists and is fresh. A ledger-only home has
	// no bundle sources at all — `runBackup` correctly writes no bundle there, so that stamp passes.
	const stamp = readStamp(join(homeDir, "backups"));
	const bundleSources = BUNDLE_SOURCES.filter((name) => existsSync(join(homeDir, name)));
	if (stamp === undefined) {
		report(false, "backup bundle", "stamp=missing");
	} else if (stamp.bundle === undefined && bundleSources.length > 0) {
		report(false, "backup bundle", "bundle=none (run ompbot backup again)");
	} else if (stamp.bundle === undefined) {
		report(true, "backup bundle", "sources=none (ledger-only home)");
	} else if (!existsSync(join(homeDir, "backups", stamp.bundle))) {
		report(false, "backup bundle", `bundle=${stamp.bundle} missing`);
	} else {
		const hours = (Date.now() - stamp.ts.getTime()) / 3_600_000;
		report(hours <= BACKUP_MAX_AGE_MS / 3_600_000, "backup bundle", `bundle=${stamp.bundle} hours=${hours.toFixed(1)}`);
	}

	if (config) {
		try {
			const { botToken } = readSlackTokens(config);
			const auth = await new WebClient(botToken).auth.test();
			const idMatches = config.slack.botUserId === undefined || config.slack.botUserId === auth.user_id;
			report(
				auth.ok === true && idMatches,
				"slack auth.test",
				`bot_user_id=${auth.user_id ?? "?"} team_id=${auth.team_id ?? "?"}`,
			);
		} catch (error) {
			const code =
				error instanceof Error &&
				"data" in error &&
				typeof error.data === "object" &&
				error.data !== null &&
				"error" in error.data
					? String(error.data.error)
					: "request_failed";
			report(false, "slack auth.test", code);
		}
		await checkDiscord(config, report);
	}
	return failures === 0 ? 0 : 1;
}
