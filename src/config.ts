import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { TASK_RISKS, type TaskRisk } from "./tasks/docs";

export type ConfigErrorCode =
	| "home_missing"
	| "home_permissions"
	| "config_missing"
	| "config_invalid_json"
	| "config_invalid"
	| "secret_missing"
	| "secret_permissions"
	| "token_prefix";

/** Messages carry the offending path (and field names / modes) only, never file contents or values. */
export class ConfigError extends Error {
	readonly code: ConfigErrorCode;
	readonly path: string;

	constructor(code: ConfigErrorCode, path: string, detail?: string) {
		super(`${code}: ${path}${detail ? ` (${detail})` : ""}`);
		this.name = "ConfigError";
		this.code = code;
		this.path = path;
	}
}

export interface SlackConfig {
	/** Absolute, resolved against the config directory. */
	botTokenFile: string;
	appTokenFile: string;
	appId?: string;
	teamId?: string;
	botUserId?: string;
}

/** Which child process powers a conversation: omp's RPC child (default) or the Claude Code CLI. */
export type AgentKind = "omp" | "claude";

/** `channels.discord`: present → the daemon also talks on Discord (Gateway + REST with the bot token). */
export interface DiscordChannelConfig {
	/** The owner's Discord user id (snowflake); only this user's messages are taken. */
	ownerUserId: string;
	/** Absolute, resolved against the config directory; one line, mode 0600. */
	botTokenFile: string;
	applicationId: string;
	/** Servers whose messages are taken; absent: every server the bot is in. DMs are not affected. */
	guildIds?: string[];
	/** Channel ids where the owner's root messages are answered without a mention. */
	mentionFreeChannels?: string[];
	/** In a server channel only a mention addresses the bot. Default false. */
	requireMention?: boolean;
}

/** Per-platform chat settings: who the owner is on each platform the bot talks on. Slack is required, Discord optional. */
export interface ChannelsConfig {
	slack: { ownerUserId: string };
	discord?: DiscordChannelConfig;
}

/** Old top-level keys still read, each with the key that replaced it (the daemon warns about them at startup). */
export const DEPRECATED_KEYS = { ownerSlackUserId: "channels.slack.ownerUserId" } as const;

/** One `dispatchHosts` entry: ssh target, remote work directory, remote herdr binary, worker omp extra arguments. */
export interface DispatchHostConfig {
	ssh: string;
	workDir?: string;
	herdrBin?: string;
	ompArgs?: string[];
}

export interface OmpbotConfig {
	schemaVersion: 1;
	homeDir: string;
	configPath: string;
	channels: ChannelsConfig;
	/** Deprecated keys the file still uses (see `DEPRECATED_KEYS`); absent when it uses none. */
	deprecated?: Array<keyof typeof DEPRECATED_KEYS>;
	slack: SlackConfig;
	ompExecutable: string;
	workspaceDir: string;
	/** Child agent behind chat origins: omp (`omp --mode rpc`) or the Claude Code CLI. Default "omp". */
	agent?: AgentKind;
	/** Absolute claude CLI path for `agent: "claude"`; default resolves `claude` on the child PATH. */
	claudeExecutable?: string;
	model?: string;
	thinking?: string;
	sessionRetentionDays?: number;
	/**
	 * Combined size ceiling of the backup bundle sources (sessions + config.json) in bytes; `ompbot backup
	 * --max-bundle-bytes` overrides it per run. A positive integer; unset means the 512MB default.
	 */
	maxBundleBytes?: number;
	/**
	 * Off-site copy of the newest backup + bundle (`ompbot backup` runs it after a good local backup, `ompbot offsite`
	 * retries it). `ssh` is an ssh alias or `user@host` (BatchMode, key auth); `remoteDir` an absolute path or `~/…`
	 * on that host; `keep` the newest daily files per kind kept there (default 14). Unset → no off-site copy.
	 */
	offsite?: { ssh: string; remoteDir: string; keep?: number };
	/** Minutes an idle omp child is kept before it is stopped (the session stays); 0 disables. Default 30. */
	idleTimeoutMinutes?: number;
	/** Owner DM turns between background skill reviews; 0 disables. Default 10 (each review costs tokens). */
	skillReviewTurns?: number;
	/** Slack channel IDs where owner messages are answered without a mention (solo channels). */
	mentionFreeChannels?: string[];
	/**
	 * Other bots in the workspace whose channel messages that mention this bot are accepted as peer requests: no
	 * owner authority, no delegation or monitor tools. `userId` is the peer's Slack user id, `name` how its requests
	 * are labelled in the prompt. Default none (every bot message is dropped).
	 */
	peerBots?: Array<{ userId: string; name: string }>;
	/** In a channel answer only when this bot is mentioned (mentionFreeChannels and thread participation no longer count). Default false. */
	requireMention?: boolean;
	/** Peer input cap per thread: more than `turns` peer messages within `windowMinutes` are dropped. Default 3 per 30. */
	peerHopLimit?: { turns: number; windowMinutes: number };
	/**
	 * herdr switch: present (`{}`) → `ompbot_dispatch` offers herdr/taskSpec and the [TASK] sweep runs; absent → simple
	 * dispatch only. `bin` is the absolute path of the local herdr (default: `herdr` on PATH).
	 */
	herdr?: { bin?: string };
	/**
	 * Extra arguments for the local herdr worker omp (`herdr agent start … -- <args>`), e.g. `["--prewalk"]`. Not
	 * applied to `omp -p` simple dispatch nor to remote hosts (those use `dispatchHosts.<h>.ompArgs`).
	 */
	workerOmpArgs?: string[];
	/**
	 * Remote dispatch targets for `ompbot_dispatch host=…`: herdr runs on that host over ssh. Needs `herdr`.
	 * `ompArgs`: extra arguments for that host's herdr worker omp, resolved by that host's omp settings.
	 */
	dispatchHosts?: Record<string, DispatchHostConfig>;
	/**
	 * herdr-web-ui task board: `url` is the public board page (card links `<url>?card=<key>` go into dispatch reports),
	 * `api` the web UI origin reachable from this host (default `http://127.0.0.1:7317`). Unset → no board links.
	 * Needs `herdr`.
	 */
	herdrBoard?: { url: string; api?: string };
	/**
	 * Auto-merge of [TASK]s and work lanes: a local task (never a `dispatchHosts` one) or a closed lane whose
	 * repository shares its git common directory with one of `repos` (absolute, trailing slash dropped), whose risk is
	 * at most `maxRisk` (default L2), and whose outcome stands on at least one passing re-run check without warnings
	 * is merged without a question — a task gets "머지해" from the bot, a lane is landed by the core
	 * (`src/lanes/land.ts`). Unset → every reached task and closed lane waits for the owner. Works without `herdr`
	 * (lanes); the [TASK] sweep itself only runs with it.
	 */
	taskAutoLand?: { repos: string[]; maxRisk?: TaskRisk };
	/** Slack channel id that receives approval cards (owner mention, link back to the asking thread). Default: the asking conversation. */
	escalationChannel?: string;
	/** Slack channel id of the #log ledger: completion reports are copied there and nothing said there becomes a turn. */
	logChannel?: string;
	/**
	 * Post "재시작 중" / "다시 연결됨" / "재시작 취소" notices to recently active conversations around a drain restart.
	 * Default true.
	 */
	restartNotice?: boolean;
	/** Prepend channel-scoped recall of earlier conversation rows to a turn prompt that points at the past. Default true. */
	recallEnabled?: boolean;
	/** Absolute directories a `watcher` monitor may watch (its root must sit inside one, symlinks resolved). */
	watcherRoots?: string[];
	/**
	 * Loopback listener for `webhook` monitor triggers (POST /hook/<id> with a bearer token). Absent = no server and
	 * webhook triggers cannot be created. `bind` must be a loopback address; the default is 127.0.0.1.
	 */
	webhook?: { port: number; bind?: "127.0.0.1" | "::1" };
	/**
	 * Read-only status page of `ompbot dashboard` (a separate process; `--port`/`--bind` override). `bind` must be a
	 * loopback address; the default is 127.0.0.1. Absent = the command needs `--port`. `herdrWebUrl` is herdr-web-ui's
	 * address for the agent board's "herdr에서 답하기" links (absent = no link).
	 */
	dashboard?: { port: number; bind?: "127.0.0.1" | "::1"; herdrWebUrl?: string };
}

export interface SlackTokens {
	botToken: string;
	appToken: string;
}

/** An ssh alias or `user@host`: never starts with `-` (no option injection), no spaces or shell characters. */
export const OFFSITE_SSH = /^([A-Za-z0-9_][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Absolute or `~/` path of plain characters, so it can sit unquoted in the remote shell command. */
export const OFFSITE_DIR = /^(\/|~\/)[A-Za-z0-9._+=@%:/-]+$/;

export const HOME_MODE = 0o700;
export const SECRET_MODE = 0o600;

export function defaultHomeDir(env: Record<string, string | undefined> = process.env): string {
	return env.OMPBOT_HOME ?? join(homedir(), ".ompbot");
}

function modeString(mode: number): string {
	return `0${(mode & 0o777).toString(8)}`;
}

function invalid(path: string, field: string): never {
	throw new ConfigError("config_invalid", path, `field=${field}`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function requiredString(configPath: string, obj: Record<string, unknown>, key: string, field = key): string {
	const value = obj[key];
	if (typeof value !== "string" || value.trim() === "") invalid(configPath, field);
	return value;
}

function optionalString(
	configPath: string,
	obj: Record<string, unknown>,
	key: string,
	field = key,
): string | undefined {
	const value = obj[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "") invalid(configPath, field);
	return value;
}

const CHANNEL_ID = /^[CG][A-Z0-9]{8,}$/;
const SLACK_USER_ID = /^U[A-Z0-9]{8,}$/;

/**
 * `channels` plus the old `ownerSlackUserId`: either names the Slack owner, both must agree, and one of them must
 * be there. Only known platforms and keys are accepted under `channels`.
 */
function parseChannels(
	configPath: string,
	root: Record<string, unknown>,
	home: string,
): { channels: ChannelsConfig; deprecated: Array<keyof typeof DEPRECATED_KEYS> } {
	const legacy = optionalString(configPath, root, "ownerSlackUserId");
	let owner: string | undefined;
	let discord: DiscordChannelConfig | undefined;
	if (root.channels !== undefined) {
		const channels = asRecord(root.channels);
		if (channels === undefined) invalid(configPath, "channels");
		for (const key of Object.keys(channels)) {
			if (key !== "slack" && key !== "discord") invalid(configPath, `channels.${key}`);
		}
		if (channels.discord !== undefined) discord = parseDiscordChannel(configPath, channels.discord, home);
		if (channels.slack !== undefined) {
			const slack = asRecord(channels.slack);
			if (slack === undefined) invalid(configPath, "channels.slack");
			for (const key of Object.keys(slack)) {
				if (key !== "ownerUserId") invalid(configPath, `channels.slack.${key}`);
			}
			owner = requiredString(configPath, slack, "ownerUserId", "channels.slack.ownerUserId");
		}
	}
	if (owner !== undefined && legacy !== undefined && owner !== legacy) {
		invalid(configPath, "channels.slack.ownerUserId");
	}
	const ownerUserId = owner ?? legacy;
	if (ownerUserId === undefined) invalid(configPath, "channels.slack.ownerUserId");
	return {
		channels: { slack: { ownerUserId }, ...(discord === undefined ? {} : { discord }) },
		deprecated: legacy === undefined ? [] : ["ownerSlackUserId"],
	};
}

/** A Discord id (snowflake): 17–20 digits. */
const SNOWFLAKE = /^[0-9]{17,20}$/;
const DISCORD_KEYS: Record<string, true> = {
	ownerUserId: true,
	botTokenFile: true,
	applicationId: true,
	guildIds: true,
	mentionFreeChannels: true,
	requireMention: true,
};

function parseDiscordChannel(configPath: string, value: unknown, home: string): DiscordChannelConfig {
	const record = asRecord(value);
	if (record === undefined) invalid(configPath, "channels.discord");
	for (const key of Object.keys(record)) {
		if (!Object.hasOwn(DISCORD_KEYS, key)) invalid(configPath, `channels.discord.${key}`);
	}
	const snowflake = (key: string): string => {
		const id = record[key];
		if (typeof id !== "string" || !SNOWFLAKE.test(id)) invalid(configPath, `channels.discord.${key}`);
		return id;
	};
	const snowflakes = (key: string): string[] | undefined => {
		const ids = record[key];
		if (ids === undefined) return undefined;
		if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !SNOWFLAKE.test(id))) {
			invalid(configPath, `channels.discord.${key}`);
		}
		return [...(ids as string[])];
	};
	const ownerUserId = snowflake("ownerUserId");
	const botTokenFile = resolve(
		home,
		requiredString(configPath, record, "botTokenFile", "channels.discord.botTokenFile"),
	);
	const applicationId = snowflake("applicationId");
	const guildIds = snowflakes("guildIds");
	const mentionFreeChannels = snowflakes("mentionFreeChannels");
	const requireMention = record.requireMention;
	if (requireMention !== undefined && typeof requireMention !== "boolean") {
		invalid(configPath, "channels.discord.requireMention");
	}
	return {
		ownerUserId,
		botTokenFile,
		applicationId,
		...(guildIds === undefined ? {} : { guildIds }),
		...(mentionFreeChannels === undefined ? {} : { mentionFreeChannels }),
		...(requireMention === undefined ? {} : { requireMention }),
	};
}

/** An optional integer no smaller than `min`. */
function optionalInt(configPath: string, obj: Record<string, unknown>, key: string, min: number): number | undefined {
	const value = obj[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min) invalid(configPath, key);
	return value;
}

/** An optional argument list: an array of non-empty strings (copied), else `field` is invalid. */
function optionalArgList(
	configPath: string,
	obj: Record<string, unknown>,
	key: string,
	field: string = key,
): string[] | undefined {
	const value = obj[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((arg) => typeof arg !== "string" || arg.trim() === "")) {
		invalid(configPath, field);
	}
	return [...(value as string[])];
}

/** An optional Slack channel id (`C…`/`G…`). */
function optionalChannelId(configPath: string, obj: Record<string, unknown>, key: string): string | undefined {
	const value = obj[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !CHANNEL_ID.test(value)) invalid(configPath, key);
	return value;
}

function checkHome(homeDir: string): void {
	let mode: number;
	try {
		mode = statSync(homeDir).mode;
	} catch {
		throw new ConfigError("home_missing", homeDir);
	}
	if ((mode & 0o777) !== HOME_MODE) {
		throw new ConfigError("home_permissions", homeDir, `mode=${modeString(mode)} expected=${modeString(HOME_MODE)}`);
	}
}

function readSecret(path: string, prefix: string): string {
	const value = readSecretFile(path);
	if (!value.startsWith(prefix)) throw new ConfigError("token_prefix", path, `expected prefix ${prefix}`);
	return value;
}

/** A 0600 secret file's trimmed content (`secret_missing` / `secret_permissions` otherwise). */
function readSecretFile(path: string): string {
	let mode: number;
	try {
		mode = statSync(path).mode;
	} catch {
		throw new ConfigError("secret_missing", path);
	}
	if ((mode & 0o777) !== SECRET_MODE) {
		throw new ConfigError("secret_permissions", path, `mode=${modeString(mode)} expected=${modeString(SECRET_MODE)}`);
	}
	let value: string;
	try {
		value = readFileSync(path, "utf8").trim();
	} catch {
		throw new ConfigError("secret_missing", path);
	}
	return value;
}

/** Reads the token files again (permission and prefix checks included) and returns the values. */
export function readSlackTokens(config: OmpbotConfig): SlackTokens {
	return {
		botToken: readSecret(config.slack.botTokenFile, "xoxb-"),
		appToken: readSecret(config.slack.appTokenFile, "xapp-"),
	};
}

/**
 * Reads the Discord bot token file again (permission check included). Discord tokens carry no fixed prefix, so the
 * only shape check is one non-empty line; a wrong token shows up as gateway close 4004.
 */
export function readDiscordToken(config: OmpbotConfig): string {
	const discord = config.channels.discord;
	if (discord === undefined) throw new Error("channels.discord is not configured");
	const value = readSecretFile(discord.botTokenFile);
	if (value === "" || /[\r\n]/.test(value)) {
		throw new ConfigError("config_invalid", discord.botTokenFile, "field=channels.discord.botTokenFile");
	}
	return value;
}

/**
 * Loads and validates `<homeDir>/config.json`. Credential-file and workspace paths resolve against the config dir.
 * `checkTokens: false` skips reading the token files — for processes that never talk to Slack (`ompbot dashboard`).
 */
export function loadConfig(homeDir: string = defaultHomeDir(), options: { checkTokens?: boolean } = {}): OmpbotConfig {
	const home = resolve(homeDir);
	checkHome(home);

	const configPath = join(home, "config.json");
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf8");
	} catch {
		throw new ConfigError("config_missing", configPath);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new ConfigError("config_invalid_json", configPath);
	}

	const root = asRecord(parsed);
	if (!root) invalid(configPath, "<root>");
	if (root.schemaVersion !== 1) invalid(configPath, "schemaVersion");
	const slack = asRecord(root.slack);
	if (!slack) invalid(configPath, "slack");

	const ompExecutable = requiredString(configPath, root, "ompExecutable");
	if (!isAbsolute(ompExecutable)) invalid(configPath, "ompExecutable");

	const agent = root.agent;
	if (agent !== undefined && agent !== "omp" && agent !== "claude") invalid(configPath, "agent");
	const claudeExecutable = optionalString(configPath, root, "claudeExecutable");
	if (claudeExecutable !== undefined && !isAbsolute(claudeExecutable)) invalid(configPath, "claudeExecutable");

	const sessionRetentionDays = optionalInt(configPath, root, "sessionRetentionDays", 1);
	const maxBundleBytes = optionalInt(configPath, root, "maxBundleBytes", 1);
	const idleTimeoutMinutes = optionalInt(configPath, root, "idleTimeoutMinutes", 0);
	const skillReviewTurns = optionalInt(configPath, root, "skillReviewTurns", 0);

	const { channels, deprecated } = parseChannels(configPath, root, home);

	const mentionFreeChannels = root.mentionFreeChannels;
	if (
		mentionFreeChannels !== undefined &&
		(!Array.isArray(mentionFreeChannels) ||
			mentionFreeChannels.some((c) => typeof c !== "string" || !CHANNEL_ID.test(c)))
	) {
		invalid(configPath, "mentionFreeChannels");
	}

	const peerBotsRaw = root.peerBots;
	if (peerBotsRaw !== undefined) {
		if (!Array.isArray(peerBotsRaw)) invalid(configPath, "peerBots");
		peerBotsRaw.forEach((entry, i) => {
			const record = asRecord(entry);
			if (record === undefined || typeof record.userId !== "string" || !SLACK_USER_ID.test(record.userId)) {
				invalid(configPath, `peerBots.${i}.userId`);
			}
			// The owner is never a peer: a peer message carries no owner authority, so listing the owner would only shadow it.
			if (record.userId === channels.slack.ownerUserId) invalid(configPath, `peerBots.${i}.userId`);
			if (typeof record.name !== "string" || record.name.length < 1 || record.name.length > 32) {
				invalid(configPath, `peerBots.${i}.name`);
			}
			for (const key of Object.keys(record))
				if (key !== "userId" && key !== "name") invalid(configPath, `peerBots.${i}.${key}`);
		});
	}
	const requireMention = root.requireMention;
	if (requireMention !== undefined && typeof requireMention !== "boolean") invalid(configPath, "requireMention");
	const peerHopLimit = root.peerHopLimit;
	if (peerHopLimit !== undefined) {
		const record = asRecord(peerHopLimit);
		if (record === undefined) invalid(configPath, "peerHopLimit");
		for (const key of ["turns", "windowMinutes"]) {
			const value = record[key];
			if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(configPath, `peerHopLimit.${key}`);
		}
		for (const key of Object.keys(record)) {
			if (key !== "turns" && key !== "windowMinutes") invalid(configPath, `peerHopLimit.${key}`);
		}
	}

	const dispatchHosts = root.dispatchHosts;
	if (dispatchHosts !== undefined) {
		const hosts = asRecord(dispatchHosts);
		if (hosts === undefined) invalid(configPath, "dispatchHosts");
		for (const [name, entry] of Object.entries(hosts ?? {})) {
			const record = asRecord(entry);
			if (record === undefined || typeof record.ssh !== "string" || record.ssh.trim() === "") {
				invalid(configPath, `dispatchHosts.${name}.ssh`);
			}
			if (record.workDir !== undefined && typeof record.workDir !== "string") {
				invalid(configPath, `dispatchHosts.${name}.workDir`);
			}
			if (record.herdrBin !== undefined && typeof record.herdrBin !== "string") {
				invalid(configPath, `dispatchHosts.${name}.herdrBin`);
			}
			optionalArgList(configPath, record, "ompArgs", `dispatchHosts.${name}.ompArgs`);
		}
	}
	const workerOmpArgs = optionalArgList(configPath, root, "workerOmpArgs");

	const offsiteRaw = root.offsite;
	let offsite: OmpbotConfig["offsite"];
	if (offsiteRaw !== undefined) {
		const record = asRecord(offsiteRaw);
		if (record === undefined || typeof record.ssh !== "string" || !OFFSITE_SSH.test(record.ssh)) {
			invalid(configPath, "offsite.ssh");
		}
		if (
			typeof record?.remoteDir !== "string" ||
			!OFFSITE_DIR.test(record.remoteDir) ||
			record.remoteDir.split("/").some((part) => part === "..")
		) {
			invalid(configPath, "offsite.remoteDir");
		}
		if (record?.keep !== undefined && (!Number.isSafeInteger(record.keep) || (record.keep as number) < 1)) {
			invalid(configPath, "offsite.keep");
		}
		offsite = {
			ssh: record?.ssh as string,
			remoteDir: record?.remoteDir as string,
			...(record?.keep === undefined ? {} : { keep: record.keep as number }),
		};
	}

	const herdrBoard = root.herdrBoard;
	if (herdrBoard !== undefined) {
		const record = asRecord(herdrBoard);
		if (record === undefined || typeof record.url !== "string" || !/^https?:\/\/\S+$/.test(record.url)) {
			invalid(configPath, "herdrBoard.url");
		}
		if (record?.api !== undefined && (typeof record.api !== "string" || !/^https?:\/\/\S+$/.test(record.api))) {
			invalid(configPath, "herdrBoard.api");
		}
	}

	let taskAutoLand: OmpbotConfig["taskAutoLand"];
	if (root.taskAutoLand !== undefined) {
		const record = asRecord(root.taskAutoLand);
		if (record === undefined) invalid(configPath, "taskAutoLand");
		const repos = record.repos;
		if (!Array.isArray(repos) || repos.length === 0) invalid(configPath, "taskAutoLand.repos");
		repos.forEach((repo, i) => {
			if (typeof repo !== "string" || !isAbsolute(repo)) invalid(configPath, `taskAutoLand.repos.${i}`);
		});
		const maxRisk = record.maxRisk;
		if (maxRisk !== undefined && !(TASK_RISKS as readonly unknown[]).includes(maxRisk)) {
			invalid(configPath, "taskAutoLand.maxRisk");
		}
		for (const key of Object.keys(record)) {
			if (key !== "repos" && key !== "maxRisk") invalid(configPath, `taskAutoLand.${key}`);
		}
		taskAutoLand = {
			repos: (repos as string[]).map((repo) => repo.replace(/(?<=.)\/+$/, "")),
			...(maxRisk === undefined ? {} : { maxRisk: maxRisk as TaskRisk }),
		};
	}

	const herdrRaw = root.herdr;
	let herdr: OmpbotConfig["herdr"];
	if (herdrRaw !== undefined) {
		const record = asRecord(herdrRaw);
		if (record === undefined) invalid(configPath, "herdr");
		const bin = optionalString(configPath, record, "bin", "herdr.bin");
		if (bin !== undefined && !isAbsolute(bin)) invalid(configPath, "herdr.bin");
		herdr = bin === undefined ? {} : { bin };
	} else if (dispatchHosts !== undefined || herdrBoard !== undefined) {
		// Both are herdr features: without the switch they would be silently dead, so refuse the file instead.
		// `taskAutoLand` is not one of them: work lanes land without herdr.
		invalid(configPath, "herdr");
	}

	const escalationChannel = optionalChannelId(configPath, root, "escalationChannel");
	const logChannel = optionalChannelId(configPath, root, "logChannel");

	const restartNotice = root.restartNotice;
	if (restartNotice !== undefined && typeof restartNotice !== "boolean") invalid(configPath, "restartNotice");
	const recallEnabled = root.recallEnabled;
	if (recallEnabled !== undefined && typeof recallEnabled !== "boolean") invalid(configPath, "recallEnabled");
	const watcherRoots = root.watcherRoots;
	if (
		watcherRoots !== undefined &&
		(!Array.isArray(watcherRoots) || watcherRoots.some((r) => typeof r !== "string" || !isAbsolute(r)))
	) {
		invalid(configPath, "watcherRoots");
	}

	const webhook = root.webhook;
	if (webhook !== undefined) {
		const record = asRecord(webhook);
		if (record === undefined) invalid(configPath, "webhook");
		if (!Number.isInteger(record.port) || (record.port as number) < 1 || (record.port as number) > 65535) {
			invalid(configPath, "webhook.port");
		}
		if (record.bind !== undefined && record.bind !== "127.0.0.1" && record.bind !== "::1") {
			invalid(configPath, "webhook.bind");
		}
		for (const key of Object.keys(record)) if (key !== "port" && key !== "bind") invalid(configPath, `webhook.${key}`);
	}

	const dashboard = root.dashboard;
	if (dashboard !== undefined) {
		const record = asRecord(dashboard);
		if (record === undefined) invalid(configPath, "dashboard");
		if (!Number.isInteger(record.port) || (record.port as number) < 1 || (record.port as number) > 65535) {
			invalid(configPath, "dashboard.port");
		}
		if (record.bind !== undefined && record.bind !== "127.0.0.1" && record.bind !== "::1") {
			invalid(configPath, "dashboard.bind");
		}
		if (
			record.herdrWebUrl !== undefined &&
			(typeof record.herdrWebUrl !== "string" || !/^https?:\/\/\S+$/.test(record.herdrWebUrl))
		) {
			invalid(configPath, "dashboard.herdrWebUrl");
		}
		for (const key of Object.keys(record)) {
			if (key !== "port" && key !== "bind" && key !== "herdrWebUrl") invalid(configPath, `dashboard.${key}`);
		}
	}

	const config: OmpbotConfig = {
		schemaVersion: 1,
		homeDir: home,
		configPath,
		channels,
		slack: {
			botTokenFile: resolve(home, requiredString(configPath, slack, "botTokenFile", "slack.botTokenFile")),
			appTokenFile: resolve(home, requiredString(configPath, slack, "appTokenFile", "slack.appTokenFile")),
		},
		ompExecutable,
		workspaceDir: resolve(home, requiredString(configPath, root, "workspaceDir")),
	};
	if (deprecated.length > 0) config.deprecated = deprecated;
	const appId = optionalString(configPath, slack, "appId", "slack.appId");
	const teamId = optionalString(configPath, slack, "teamId", "slack.teamId");
	const botUserId = optionalString(configPath, slack, "botUserId", "slack.botUserId");
	if (appId !== undefined) config.slack.appId = appId;
	if (teamId !== undefined) config.slack.teamId = teamId;
	if (botUserId !== undefined) config.slack.botUserId = botUserId;
	const model = optionalString(configPath, root, "model");
	const thinking = optionalString(configPath, root, "thinking");
	if (model !== undefined) config.model = model;
	if (thinking !== undefined) config.thinking = thinking;
	if (agent !== undefined) config.agent = agent;
	if (claudeExecutable !== undefined) config.claudeExecutable = claudeExecutable;
	if (sessionRetentionDays !== undefined) config.sessionRetentionDays = sessionRetentionDays;
	if (maxBundleBytes !== undefined) config.maxBundleBytes = maxBundleBytes;
	if (offsite !== undefined) config.offsite = offsite;
	if (idleTimeoutMinutes !== undefined) config.idleTimeoutMinutes = idleTimeoutMinutes;
	if (skillReviewTurns !== undefined) config.skillReviewTurns = skillReviewTurns;
	if (mentionFreeChannels !== undefined) config.mentionFreeChannels = mentionFreeChannels as string[];
	if (peerBotsRaw !== undefined) {
		config.peerBots = (peerBotsRaw as Array<{ userId: string; name: string }>).map(({ userId, name }) => ({
			userId,
			name,
		}));
	}
	if (requireMention !== undefined) config.requireMention = requireMention;
	if (peerHopLimit !== undefined) config.peerHopLimit = peerHopLimit as { turns: number; windowMinutes: number };
	if (escalationChannel !== undefined) config.escalationChannel = escalationChannel;
	if (logChannel !== undefined) config.logChannel = logChannel;
	if (restartNotice !== undefined) config.restartNotice = restartNotice;
	if (recallEnabled !== undefined) config.recallEnabled = recallEnabled;
	if (watcherRoots !== undefined) config.watcherRoots = (watcherRoots as string[]).map((r) => resolve(r));
	if (webhook !== undefined) config.webhook = webhook as { port: number; bind?: "127.0.0.1" | "::1" };
	if (dashboard !== undefined) config.dashboard = dashboard as NonNullable<OmpbotConfig["dashboard"]>;
	if (herdr !== undefined) config.herdr = herdr;
	if (dispatchHosts !== undefined) config.dispatchHosts = dispatchHosts as Record<string, DispatchHostConfig>;
	if (workerOmpArgs !== undefined) config.workerOmpArgs = workerOmpArgs;

	if (herdrBoard !== undefined) config.herdrBoard = herdrBoard as { url: string; api?: string };
	if (taskAutoLand !== undefined) config.taskAutoLand = taskAutoLand;

	if (options.checkTokens !== false) {
		// Fail at startup on permissions/prefix/shape; values are discarded here.
		readSlackTokens(config);
		if (config.channels.discord !== undefined) readDiscordToken(config);
	}
	return config;
}
