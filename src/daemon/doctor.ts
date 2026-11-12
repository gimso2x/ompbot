import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
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
import { DEFAULT_COMPLETION_NUDGES } from "../lanes/manager";
import { buildChildEnv, withOmpProfile } from "../omp/env";
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

/**
 * How many chat models `omp models --json` lists, run with the env the RPC driver gives omp. Zero means no provider
 * login and no API key: every turn would fail with "No default model selected", so doctor says so before the first DM.
 * A string is the reason the count could not be read (timeout, exit code, unparsable output).
 */
export async function countOmpModels(
	ompExecutable: string,
	timeoutMs = 30_000,
	/** Config `ompProfile`: the bot profile's models and login (`withOmpProfile`). */
	ompProfile?: string,
	base: Record<string, string | undefined> = process.env,
): Promise<number | string> {
	let proc: Bun.Subprocess<"ignore", "pipe", "ignore">;
	try {
		proc = Bun.spawn([ompExecutable, "models", "--json"], {
			stdout: "pipe",
			stderr: "ignore",
			stdin: "ignore",
			env: withOmpProfile(buildChildEnv({}, base), ompProfile),
		});
	} catch (error) {
		return `cannot run ${ompExecutable} (${(error as NodeJS.ErrnoException).code ?? String(error)})`;
	}
	const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
	try {
		const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (proc.signalCode === "SIGKILL") return `timeout after ${timeoutMs / 1000}s`;
		if (code !== 0) return `omp models exited ${code}`;
		const parsed = JSON.parse(out) as { models?: unknown };
		return Array.isArray(parsed.models) ? parsed.models.length : "unparsable output";
	} catch {
		return "unparsable output";
	} finally {
		clearTimeout(timer);
	}
}

/** Config errors that only concern the Slack token files; doctor reports those per file and keeps going. */
const TOKEN_FILE_ERRORS: Record<string, true> = { secret_missing: true, secret_permissions: true, token_prefix: true };

/**
 * What is wrong with one token file, with the command that fixes it, or undefined when it is fine. Only the first
 * characters are compared; the value is never printed.
 */
export function secretProblem(path: string, prefix: string): string | undefined {
	let mode: number;
	try {
		mode = modeOf(path);
	} catch {
		return `missing (write it: umask 077; cat > ${path})`;
	}
	if (mode !== SECRET_MODE) return `mode=${octal(mode)} expected=${octal(SECRET_MODE)} (fix: chmod 600 ${path})`;
	let head: string;
	try {
		head = readFileSync(path, "utf8").trimStart().slice(0, prefix.length);
	} catch {
		return `unreadable (fix: chmod 600 ${path} as the account that runs ompbot)`;
	}
	if (head !== prefix) {
		return `does not start with ${prefix} (the bot token is xoxb-…, the app-level token is xapp-…; paste the right one)`;
	}
	return undefined;
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
 * The `backup bundle` line. The bundle carries the conversation memory and operator files (sessions/, config.json,
 * workspace/, scripts/); a home that only backs up the ledger is half protected, so the stamp must name a bundle that
 * still exists and is fresh. A ledger-only home has no bundle sources at all — `runBackup` correctly writes no bundle
 * there, so that stamp passes.
 */
export function checkBackupBundle(homeDir: string, report: Report, warn: (name: string, detail: string) => void): void {
	const stamp = readStamp(join(homeDir, "backups"));
	const bundleSources = BUNDLE_SOURCES.filter((name) => existsSync(join(homeDir, name)));
	if (stamp === undefined && !existsSync(join(homeDir, "ompbot.db"))) {
		// The daemon has never started: there is nothing to back up yet, and its first start makes the first backup.
		warn("backup bundle", "stamp=missing (first install: the daemon makes the first backup when it starts)");
	} else if (stamp === undefined) {
		report(false, "backup bundle", "stamp=missing (run ompbot backup once and enable ompbot-backup.timer)");
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
}

/**
 * Prints one `ok`/`fail` line per check (`warn` lines never count as failures). Only paths, modes, token *prefixes* and public ids are printed; token values
 * never leave `readSlackTokens`. Returns 0 when every check passed.
 */
export async function runDoctor(homeDir: string, write: (line: string) => void): Promise<number> {
	let failures = 0;
	const report = (ok: boolean, name: string, detail: string): void => {
		if (!ok) failures += 1;
		write(`${ok ? "ok" : "fail"} ${name}: ${detail}`);
	};
	const warn = (name: string, detail: string): void => write(`warn ${name}: ${detail}`);

	let config: OmpbotConfig | undefined;
	try {
		const homeMode = modeOf(homeDir);
		report(homeMode === HOME_MODE, "home", `${homeDir} mode=${octal(homeMode)} expected=${octal(HOME_MODE)}`);
	} catch {
		report(false, "home", `${homeDir} missing`);
	}
	// A token file problem is reported on its own `secret …` line below, so it must not hide every later check: the
	// config is loaded again without the token files and the report goes on.
	let tokensOk = true;
	try {
		config = loadConfig(homeDir);
		report(true, "config", config.configPath);
	} catch (error) {
		if (error instanceof ConfigError && TOKEN_FILE_ERRORS[error.code] === true) {
			try {
				config = loadConfig(homeDir, { checkTokens: false });
				report(true, "config", config.configPath);
			} catch (retry) {
				report(false, "config", retry instanceof ConfigError ? retry.message : "unreadable");
			}
		} else {
			report(false, "config", error instanceof ConfigError ? error.message : "unreadable");
		}
	}
	if (config) {
		// Slack off: one line says so, and no Slack token file or auth.test line follows.
		if (config.slack === undefined) report(true, "slack", "off (channels.slack not set)");
		const slackTokenFiles =
			config.slack === undefined
				? []
				: ([
						["slack-bot-token", config.slack.botTokenFile, "xoxb-"],
						["slack-app-token", config.slack.appTokenFile, "xapp-"],
					] as const);
		for (const [name, path, prefix] of slackTokenFiles) {
			const problem = secretProblem(path, prefix);
			if (problem !== undefined) tokensOk = false;
			report(
				problem === undefined,
				`secret ${name}`,
				problem ?? `mode=${octal(SECRET_MODE)} expected=${octal(SECRET_MODE)} prefix=${prefix}`,
			);
		}

		try {
			accessSync(config.ompExecutable, constants.X_OK);
			const version = await readVersion([config.ompExecutable, "--version"]);
			report(version !== "unknown", "omp", `${config.ompExecutable} ${version}`);
		} catch {
			report(
				false,
				"omp",
				`${config.ompExecutable} not executable (set "ompExecutable" in ${config.configPath} to the output of: command -v omp)`,
			);
		}

		// The same check the RPC driver runs before every spawn, so a fresh install with the standalone binary or a
		// too-old bun fails here instead of on the first DM. Skipped when omp or bun is missing (reported elsewhere)
		// and for agents "claude"/"agy", which never spawn omp; an unreadable launcher (a directory, no permission) is a
		// failed line, not an exception that ends the whole report.
		const runtimeBun = Bun.which("bun");
		if ((config.agent ?? "omp") === "omp" && runtimeBun !== null && existsSync(config.ompExecutable)) {
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

		if ((config.agent ?? "omp") === "omp" && existsSync(config.ompExecutable)) {
			const models = await countOmpModels(config.ompExecutable, 30_000, config.ompProfile);
			report(
				typeof models === "number" && models > 0,
				"omp models",
				typeof models === "number"
					? models > 0
						? `available=${models}`
						: "available=0 (run: omp login, or set a provider API key, as the account that runs ompbot)"
					: models,
			);
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

		const nudges = config.lanes?.completionNudges ?? DEFAULT_COMPLETION_NUDGES;
		report(true, "lane nudges", nudges === 0 ? "off (lanes.completionNudges=0)" : `completionNudges=${nudges}`);

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

		// agent "agy": the Antigravity CLI must exist, and its Google login must be on disk (presence only).
		if (config.agent === "agy") {
			const given = config.agyExecutable ?? "agy";
			try {
				const executable = given.includes("/") ? given : (Bun.which(given) ?? "");
				if (executable === "") throw new Error("not on PATH");
				accessSync(executable, constants.X_OK);
				const version = await readVersion([executable, "--version"]);
				report(version !== "unknown", "agy", `${executable} ${version}`);
			} catch {
				report(false, "agy", `${given} not executable`);
			}
			const credentials = join(homedir(), ".gemini", "oauth_creds.json");
			const present = existsSync(credentials);
			report(present, "agy auth", present ? `${credentials} present` : `no ${credentials} (run: agy, then sign in)`);
		}
	}
	// The version beside the path is that bun's own answer; the bun running this report is named only when it differs.
	const bunPath = Bun.which("bun");
	const pathBunVersion = bunPath === null ? undefined : await readVersion([bunPath, "--version"]);
	report(
		bunPath !== null,
		"bun",
		bunPath === null
			? `not on PATH (running ${Bun.version})`
			: `${bunPath} ${pathBunVersion}${pathBunVersion === Bun.version ? "" : ` (running ${Bun.version})`}`,
	);

	checkBackupBundle(homeDir, report, warn);

	if (config && !tokensOk) {
		report(false, "slack auth.test", "skipped: fix the secret lines above first");
	} else if (config?.slack !== undefined) {
		const slack = config.slack;
		try {
			const { botToken } = readSlackTokens(config);
			const auth = await new WebClient(botToken).auth.test();
			const idMatches = slack.botUserId === undefined || slack.botUserId === auth.user_id;
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
			report(
				false,
				"slack auth.test",
				code === "invalid_auth" || code === "token_revoked" || code === "account_inactive"
					? `${code} (Slack refused the bot token: copy the xoxb- token again from the app's Install App page; reinstalling the app issues a new one)`
					: code,
			);
		}
	}
	if (config) await checkDiscord(config, report);
	return failures === 0 ? 0 : 1;
}
