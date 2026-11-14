import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { TASK_RISKS, type TaskRisk } from "./tasks/docs";
import type { LaneReviewConfident } from "./tasks/notify";
import { hostTimezone, isTimezone } from "./time";

export type ConfigErrorCode =
	| "home_missing"
	| "home_permissions"
	| "config_missing"
	| "config_unreadable"
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

/** Which child process powers a conversation: omp's RPC child (default), the Claude Code CLI or the Antigravity CLI (`agy`). */
export type AgentKind = "omp" | "claude" | "agy";

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
	/** Server text channel where lanes asked for from the Discord DM open (a DM has no threads); absent: no DM lanes. */
	laneChannelId?: string;
	/**
	 * Server text channel of the Discord #log ledger: completion reports of Discord conversations and lanes are copied
	 * there and nothing said there (or in its threads) becomes a turn. Never a lane, escalation or mention-free channel.
	 */
	logChannelId?: string;
	/** Server text channel that receives the approval cards of Discord requests; absent: the asking conversation. */
	escalationChannelId?: string;
	/**
	 * Applied once at daemon start as the bot's global display name (`PATCH /users/@me`): what DMs and nickname-less
	 * servers show instead of the ASCII username. 1-32 characters. A server nickname still wins over it.
	 */
	displayName?: string;
	/**
	 * Peer bots (other ompbot instances) whose server channel messages that mention this bot are taken as review
	 * requests, the way the top-level Slack `peerBots` are. Changing it needs a restart (`channels` is a restart key).
	 */
	peerBots?: Array<{ userId: string; name: string }>;
}

/** `channels.teams`: present → the daemon also takes Bot Framework messages from Microsoft Teams (owner only). */
export interface TeamsChannelConfig {
	/** The bot's Microsoft App ID (Entra client id); the `aud` every inbound token must carry. */
	appId: string;
	/** The owner's Entra tenant: Activities and Entra-issued tokens of any other tenant are refused. */
	tenantId: string;
	/** Absolute, resolved against the config directory; one line, mode 0600. */
	clientSecretFile: string;
	/** The owner's Entra object id (`from.aadObjectId`); only this user's messages are taken. */
	ownerAadObjectId: string;
	/** `host:port` the Bot Framework endpoint (`/api/messages`) listens on. Default `127.0.0.1:3978`. */
	listen: string;
	/** Tenant the outbound Bot Connector token is asked from. Default `tenantId`; `botframework.com` for a multi-tenant bot. */
	tokenTenant?: string;
	/** Entra object ids whose mentions get a read-only answer (web search only), never the owner's session. */
	guestAadObjectIds?: string[];
	/** `qa`: the owner's Teams messages take the guests' read-only one-shot path too. Default `full`. */
	ownerMode?: "full" | "qa";
	/** `--model` of the guest/qa runs; absent: omp's default. */
	guestModel?: string;
	/**
	 * Present → the owner's Teams 1:1 (`ownerMode: full`) gets the Graph chat reading tools (delegated `Chat.Read`,
	 * `ompbot teams login`). Absent: no tools, Teams behaves as before.
	 */
	graph?: TeamsGraphConfig;
}

/** `channels.teams.graph`. */
export interface TeamsGraphConfig {
	/** Absolute, resolved against the config directory; default `secrets/teams-graph-token`. Written by `teams login`. */
	tokenFile: string;
}

/** `channels.teams.graph.tokenFile` when the key is left out (config directory relative). */
export const TEAMS_GRAPH_DEFAULT_TOKEN_FILE = "secrets/teams-graph-token";

/**
 * Per-platform chat settings: who the owner is on each platform the bot talks on. Each platform is optional, but at
 * least one is set; Slack is on exactly when `slack` is here (then the top-level `slack` token block is too).
 */
export interface ChannelsConfig {
	slack?: { ownerUserId: string };
	discord?: DiscordChannelConfig;
	teams?: TeamsChannelConfig;
}

/**
 * The owner id core-authored mentions use when no platform is implied: the Slack owner, else the Discord owner, else the Teams owner. A
 * loaded config always has one of them (`config_invalid field=channels` otherwise).
 */
export function primaryOwnerUserId(channels: ChannelsConfig): string {
	const owner = channels.slack?.ownerUserId ?? channels.discord?.ownerUserId ?? channels.teams?.ownerAadObjectId;
	if (owner === undefined) throw new Error("no chat channel is configured");
	return owner;
}

/** `peerSilenceAlert.minutes` when the key is left out, and the largest value it takes (one day). */
export const PEER_SILENCE_DEFAULT_MINUTES = 10;
const PEER_SILENCE_MAX_MINUTES = 1440;

/** Minutes a peer may stay silent after a call before the owner hears of it; 0: the alert is off. */
export function peerSilenceMinutes(config: Pick<OmpbotConfig, "peerSilenceAlert">): number {
	return config.peerSilenceAlert?.minutes ?? PEER_SILENCE_DEFAULT_MINUTES;
}

/** Old top-level keys still read, each with the key that replaced it (the daemon warns about them at startup). */
export const DEPRECATED_KEYS = { ownerSlackUserId: "channels.slack.ownerUserId" } as const;

export interface ConfigWarning {
	field: string;
	reason: "unknown_key" | "unsafe_name" | "unusable";
}

/** omp's own profile name rule (`OMP_PROFILE`); `ompProfile` must match it. */
export const OMP_PROFILE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Top-level keys `loadConfig` reads; any other one is reported as a `ConfigWarning`, not refused. */
const ROOT_KEYS = new Set([
	"schemaVersion",
	"channels",
	"ownerSlackUserId",
	"slack",
	"ompExecutable",
	"ompProfile",
	"workspaceDir",
	"agent",
	"claudeExecutable",
	"agyExecutable",
	"model",
	"thinking",
	"sessionRetentionDays",
	"maxBundleBytes",
	"offsite",
	"idleTimeoutMinutes",
	"skillReviewTurns",
	"mentionFreeChannels",
	"peerBots",
	"requireMention",
	"peerHopLimit",
	"peerSilenceAlert",
	"costCap",
	"herdr",
	"workerOmpArgs",
	"dispatchHosts",
	"herdrBoard",
	"taskAutoLand",
	"escalationChannel",
	"logChannel",
	"restartNotice",
	"recallEnabled",
	"watcherRoots",
	"turnSnapshot",
	"webhook",
	"dashboard",
	"briefing",
	"lanes",
	"candidates",
	"timezone",
	"apply",
]);

/**
 * `apply.codeRollback`: `push` makes a revert commit with the head.last-good tree on main and pushes it (the owner's
 * repository); `detach` leaves main alone and checks out head.last-good detached (a checkout following a public main);
 * `off` reverts nothing and only names the revert command.
 */
export const CODE_ROLLBACK_MODES = ["push", "detach", "off"] as const;
export type CodeRollbackMode = (typeof CODE_ROLLBACK_MODES)[number];
export const DEFAULT_CODE_ROLLBACK: CodeRollbackMode = "detach";

/** The code rollback mode of a home's config (`DEFAULT_CODE_ROLLBACK` without config or setting). */
export function codeRollbackMode(config: Pick<OmpbotConfig, "apply"> | undefined): CodeRollbackMode {
	return config?.apply?.codeRollback ?? DEFAULT_CODE_ROLLBACK;
}

/** The model tiers a lane may start on (`lanes.models`). */
export const LANE_MODEL_TIERS = ["high", "middle", "low"] as const;
export type LaneModelTier = (typeof LANE_MODEL_TIERS)[number];
export type LaneModelTiers = Partial<Record<LaneModelTier, string>>;

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
	/**
	 * Settings the file has that load but do nothing or cannot work (the daemon warns about them at startup, field
	 * names only): an unknown top-level key, a `dispatchHosts` name with control characters, an `offsite.remoteDir`
	 * that is only slashes. Absent when there are none.
	 */
	warnings?: ConfigWarning[];
	/** Deprecated keys the file still uses (see `DEPRECATED_KEYS`); absent when it uses none. */
	deprecated?: Array<keyof typeof DEPRECATED_KEYS>;
	/** Slack app tokens; present exactly when `channels.slack` is. */
	slack?: SlackConfig;
	ompExecutable: string;
	/**
	 * omp profile of the bot's own omp children (`OMP_PROFILE`): their agent dir becomes
	 * `~/.omp/profiles/<name>/agent`, filled by `ompbot omp sync`. Unset → the inherited agent dir, as before.
	 */
	ompProfile?: string;
	workspaceDir: string;
	/**
	 * IANA time zone of every day boundary, displayed time and default monitor zone (`Europe/Berlin`). Always set on a
	 * loaded config: the file's value, else the host zone (`UTC` when the host reports none).
	 */
	timezone: string;
	/** Child agent behind chat origins: omp (`omp --mode rpc`), the Claude Code CLI or the Antigravity CLI. Default "omp". */
	agent?: AgentKind;
	/** Absolute claude CLI path for `agent: "claude"`; default resolves `claude` on the child PATH. */
	claudeExecutable?: string;
	/** Absolute agy CLI path for `agent: "agy"`; default resolves `agy` on the child PATH. */
	agyExecutable?: string;
	model?: string;
	thinking?: string;
	sessionRetentionDays?: number;
	/**
	 * Combined size ceiling of the backup bundle sources (sessions + config.json) in bytes; `ompbot backup
	 * --max-bundle-bytes` overrides it per run. A positive integer; unset means the 512MB default.
	 */
	maxBundleBytes?: number;
	/**
	 * Off-site copy of the newest backup + bundle (`ompbot backup` runs it after a good local backup; running
	 * `ompbot backup` again retries it). `ssh` is an ssh alias or `user@host` (BatchMode, key auth); `remoteDir` an
	 * absolute path or `~/…` on that host; `keep` the days of daily files per kind kept there - every file of the
	 * uploaded day, the latest of each other day (default 14). Unset → no off-site copy.
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
	 * Peer silence alert: a confirmed post in a Discord thread that mentions a `channels.discord.peerBots` entry, left
	 * without any post of that peer in the thread for `minutes`, gets one owner-mentioning notice there. 0 disables
	 * (no call is recorded). Default {@link PEER_SILENCE_DEFAULT_MINUTES}.
	 */
	peerSilenceAlert?: { minutes: number };
	/**
	 * Cost ceiling in dollars as omp prices it (`usage.cost.total`, not the real bill): a turn that reaches `turnUsd`
	 * is steered to wrap up and one that reaches 1.5x is stopped; a day (in `timezone`) whose session-file total passes
	 * `dailyUsd` stops monitor fires until midnight or `!budget off`. Each key off when absent or not positive.
	 */
	costCap?: { turnUsd?: number; dailyUsd?: number };
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
	 * (lanes); the [TASK] sweep itself only runs with it. `review` (lanes only): before an auto-merge a fresh read-only
	 * `omp -p --model <model>` reviews the claim commit's diff against the lane's spec, and only its `CLEAR` receipt
	 * for that commit lets the lane merge unasked (`timeoutMs` default 600000, at most 1800000). Unset → no review.
	 * `review.confident` (`{ maxRisk, minConfidence }`): a lane whose explicit risk is above `maxRisk` and at most
	 * `confident.maxRisk` (which must be above `maxRisk`) is reviewed too, and merges unasked when its `CLEAR` receipt
	 * carries a confidence of at least `minConfidence` (0 < x ≤ 1). A lane without a risk is never in that band.
	 * Turn `review` on alone first and watch the confidences for two weeks, then add `confident`.
	 */
	taskAutoLand?: {
		repos: string[];
		maxRisk?: TaskRisk;
		review?: { model: string; timeoutMs?: number; confident?: LaneReviewConfident };
	};
	/**
	 * Work lanes. `completionNudges`: after a lane turn ends with no done claim the core nudges the lane this many
	 * times per owner message (default 2; 0 turns nudges off). `models`: the model (`provider/id`) of each tier the
	 * session may pick when it starts a lane (`ompbot_work_start` `model`); a tier left out cannot be picked.
	 */
	lanes?: { completionNudges?: number; models?: LaneModelTiers };
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
	 * Git work trees whose changes a conversation turn snapshots for `!undo` (absolute paths; each must be a git work
	 * tree). Absent or empty = the feature is off and no git is ever run.
	 */
	turnSnapshot?: { repos: string[] };
	/**
	 * Loopback listener for `webhook` monitor triggers (POST /hook/<id> with a bearer token). Absent = no server and
	 * webhook triggers cannot be created. `bind` must be a loopback address; the default is 127.0.0.1.
	 */
	webhook?: { port: number; bind?: "127.0.0.1" | "::1" };
	/**
	 * Read-only status page of `ompbot dashboard` (a separate process; `--port`/`--bind` override). `bind` must be a
	 * loopback address; the default is 127.0.0.1. Absent = the command needs `--port`. `herdrWebUrl` is herdr-web-ui's
	 * address for the agent board's "herdr에서 답하기" links (absent = no link). `opsStatus` is a command printing the
	 * ops-status JSON for the system view's "호스트 점검" card and a `!brief` line (absent = no card, no command run);
	 * `url` links the card head.
	 */
	dashboard?: {
		port: number;
		bind?: "127.0.0.1" | "::1";
		herdrWebUrl?: string;
		opsStatus?: { command: string[]; url?: string };
	};
	/**
	 * `ompbot apply` (read on every run, never by the daemon). `codeRollback`: what a failed apply whose config rollback
	 * also failed does with the code — see `CodeRollbackMode`; absent = `DEFAULT_CODE_ROLLBACK`.
	 */
	apply?: { codeRollback?: CodeRollbackMode };
	/**
	 * `!brief`: the chromium that draws the picture. `chromium` is a name on PATH or an absolute path
	 * (default `chromium`). No existence check at load: a missing browser is reported by the briefing's failure line.
	 */
	briefing?: { chromium?: string };
	/**
	 * Improvement-candidate ledger (`<workspace>/candidates.jsonl`): a problem the self-retro saw on `minDays` distinct
	 * days within `windowDays` is raised as a #log line (`mode` "log", default) or an owner approval card ("card", at
	 * most `maxOpenCards` at once); a candidate noticed or rejected once comes back after `snoozeDays`. Unset fields
	 * take the defaults in `src/review/candidates.ts` (enabled, log, 3, 14, 1, 7).
	 */
	candidates?: {
		enabled?: boolean;
		mode?: "log" | "card";
		minDays?: number;
		windowDays?: number;
		maxOpenCards?: number;
		snoozeDays?: number;
	};
}

export interface SlackTokens {
	botToken: string;
	appToken: string;
}

/** A `dispatchHosts.<h>.ssh` target: not an ssh option (no leading `-`), no whitespace or control character (NUL throws in spawn). */
export const DISPATCH_SSH = /^[^\s-][^\s\p{Cc}]*$/u;
/** An ssh alias or `user@host`: never starts with `-` (no option injection), no spaces or shell characters. */
export const OFFSITE_SSH = /^([A-Za-z0-9_][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Absolute or `~/` path of plain characters, so it can sit unquoted in the remote shell command. */
export const OFFSITE_DIR = /^(\/|~\/)[A-Za-z0-9._+=@%:/-]+$/;

/**
 * The one `offsite.remoteDir` predicate for config load and the off-site run: `OFFSITE_DIR`, no `..` segment
 * (`a..b` is a plain name), and something left besides `/` or `~` once repeated and trailing slashes go.
 */
export function isOffsiteDir(dir: string): boolean {
	if (!OFFSITE_DIR.test(dir) || dir.split("/").some((part) => part === "..")) return false;
	const collapsed = dir.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
	return collapsed !== "" && collapsed !== "~";
}

export const HOME_MODE = 0o700;
export const SECRET_MODE = 0o600;
/** `taskAutoLand.review.timeoutMs`: default and upper bound of one lane review run. */
export const LANE_REVIEW_TIMEOUT_MS = 600_000;
export const LANE_REVIEW_TIMEOUT_MAX_MS = 1_800_000;

export function defaultHomeDir(env: Record<string, string | undefined> = process.env): string {
	// An empty value is "unset", never "" (which `resolve` would turn into the current directory).
	return env.OMPBOT_HOME || join(homedir(), ".ompbot");
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
	let teams: TeamsChannelConfig | undefined;
	if (root.channels !== undefined) {
		const channels = asRecord(root.channels);
		if (channels === undefined) invalid(configPath, "channels");
		for (const key of Object.keys(channels)) {
			if (key !== "slack" && key !== "discord" && key !== "teams") invalid(configPath, `channels.${key}`);
		}
		if (channels.discord !== undefined) discord = parseDiscordChannel(configPath, channels.discord, home);
		if (channels.teams !== undefined) teams = parseTeamsChannel(configPath, channels.teams, home);
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
	// A Slack token block without a Slack owner is a half-configured Slack, not "Slack off".
	if (ownerUserId === undefined && (root.slack !== undefined || (discord === undefined && teams === undefined))) {
		invalid(configPath, root.slack !== undefined ? "channels.slack.ownerUserId" : "channels");
	}
	return {
		channels: {
			...(ownerUserId === undefined ? {} : { slack: { ownerUserId } }),
			...(discord === undefined ? {} : { discord }),
			...(teams === undefined ? {} : { teams }),
		},
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
	laneChannelId: true,
	logChannelId: true,
	escalationChannelId: true,
	displayName: true,
	peerBots: true,
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
	const laneChannelId = record.laneChannelId === undefined ? undefined : snowflake("laneChannelId");
	const logChannelId = record.logChannelId === undefined ? undefined : snowflake("logChannelId");
	const escalationChannelId = record.escalationChannelId === undefined ? undefined : snowflake("escalationChannelId");
	// Inbound in the log channel is dropped, so it cannot also be where cards are answered, lanes open or chats run.
	if (
		logChannelId !== undefined &&
		(logChannelId === escalationChannelId ||
			logChannelId === laneChannelId ||
			mentionFreeChannels?.includes(logChannelId) === true)
	) {
		invalid(configPath, "channels.discord.logChannelId");
	}
	const requireMention = record.requireMention;
	if (requireMention !== undefined && typeof requireMention !== "boolean") {
		invalid(configPath, "channels.discord.requireMention");
	}
	const displayName = record.displayName;
	if (
		displayName !== undefined &&
		(typeof displayName !== "string" || displayName.length < 1 || displayName.length > 32)
	) {
		invalid(configPath, "channels.discord.displayName");
	}
	const peerBotsRaw = record.peerBots;
	let peerBots: Array<{ userId: string; name: string }> | undefined;
	if (peerBotsRaw !== undefined) {
		if (!Array.isArray(peerBotsRaw)) invalid(configPath, "channels.discord.peerBots");
		peerBots = peerBotsRaw.map((entry, i) => {
			const peer = asRecord(entry);
			const field = `channels.discord.peerBots.${i}`;
			// The owner is never a peer: a peer message carries no owner authority, so listing the owner would only shadow it.
			if (
				peer === undefined ||
				typeof peer.userId !== "string" ||
				!SNOWFLAKE.test(peer.userId) ||
				peer.userId === ownerUserId
			) {
				invalid(configPath, `${field}.userId`);
			}
			if (typeof peer.name !== "string" || peer.name.length < 1 || peer.name.length > 32) {
				invalid(configPath, `${field}.name`);
			}
			for (const key of Object.keys(peer))
				if (key !== "userId" && key !== "name") invalid(configPath, `${field}.${key}`);
			return { userId: peer.userId, name: peer.name };
		});
	}
	return {
		ownerUserId,
		botTokenFile,
		applicationId,
		...(guildIds === undefined ? {} : { guildIds }),
		...(mentionFreeChannels === undefined ? {} : { mentionFreeChannels }),
		...(requireMention === undefined ? {} : { requireMention }),
		...(laneChannelId === undefined ? {} : { laneChannelId }),
		...(logChannelId === undefined ? {} : { logChannelId }),
		...(escalationChannelId === undefined ? {} : { escalationChannelId }),
		...(displayName === undefined ? {} : { displayName }),
		...(peerBots === undefined ? {} : { peerBots }),
	};
}

/** An Entra id (app, tenant, user object): a GUID. */
const ENTRA_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEAMS_KEYS: Record<string, true> = {
	appId: true,
	tenantId: true,
	clientSecretFile: true,
	ownerAadObjectId: true,
	listen: true,
	tokenTenant: true,
	guestAadObjectIds: true,
	ownerMode: true,
	guestModel: true,
	graph: true,
};
export const TEAMS_DEFAULT_LISTEN = "127.0.0.1:3978";

/**
 * `host:port` of a loopback listener (`127.0.0.1`, `[::1]`, `localhost`): the public HTTPS in front of it is a tunnel
 * outside the daemon. `undefined` for anything else.
 */
export function parseLoopbackListen(listen: string): { hostname: string; port: number } | undefined {
	const match = /^(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})$/.exec(listen);
	const port = Number(match?.[2]);
	if (match === null || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
	return { hostname: match[1] === "[::1]" ? "::1" : (match[1] ?? ""), port };
}

function parseTeamsChannel(configPath: string, value: unknown, home: string): TeamsChannelConfig {
	const record = asRecord(value);
	if (record === undefined) invalid(configPath, "channels.teams");
	for (const key of Object.keys(record)) {
		if (!Object.hasOwn(TEAMS_KEYS, key)) invalid(configPath, `channels.teams.${key}`);
	}
	const guid = (key: string): string => {
		const id = record[key];
		if (typeof id !== "string" || !ENTRA_GUID.test(id)) invalid(configPath, `channels.teams.${key}`);
		return id.toLowerCase();
	};
	const listen = optionalString(configPath, record, "listen", "channels.teams.listen") ?? TEAMS_DEFAULT_LISTEN;
	if (parseLoopbackListen(listen) === undefined) invalid(configPath, "channels.teams.listen");
	const tokenTenant = optionalString(configPath, record, "tokenTenant", "channels.teams.tokenTenant");
	if (tokenTenant !== undefined && !/^[A-Za-z0-9.-]+$/.test(tokenTenant)) {
		invalid(configPath, "channels.teams.tokenTenant");
	}
	const guestsRaw = record.guestAadObjectIds;
	let guestAadObjectIds: string[] | undefined;
	if (guestsRaw !== undefined) {
		if (!Array.isArray(guestsRaw)) invalid(configPath, "channels.teams.guestAadObjectIds");
		guestAadObjectIds = guestsRaw.map((id) => {
			if (typeof id !== "string" || !ENTRA_GUID.test(id)) invalid(configPath, "channels.teams.guestAadObjectIds");
			return id.toLowerCase();
		});
	}
	const ownerMode = record.ownerMode;
	if (ownerMode !== undefined && ownerMode !== "full" && ownerMode !== "qa") {
		invalid(configPath, "channels.teams.ownerMode");
	}
	const guestModel = optionalString(configPath, record, "guestModel", "channels.teams.guestModel");
	let graph: TeamsGraphConfig | undefined;
	if (record.graph !== undefined) {
		const graphRecord = asRecord(record.graph);
		if (graphRecord === undefined) invalid(configPath, "channels.teams.graph");
		for (const key of Object.keys(graphRecord)) {
			if (key !== "tokenFile") invalid(configPath, `channels.teams.graph.${key}`);
		}
		const tokenFile =
			optionalString(configPath, graphRecord, "tokenFile", "channels.teams.graph.tokenFile") ??
			TEAMS_GRAPH_DEFAULT_TOKEN_FILE;
		graph = { tokenFile: resolve(home, tokenFile) };
	}
	return {
		appId: guid("appId"),
		tenantId: guid("tenantId"),
		clientSecretFile: resolve(
			home,
			requiredString(configPath, record, "clientSecretFile", "channels.teams.clientSecretFile"),
		),
		ownerAadObjectId: guid("ownerAadObjectId"),
		listen,
		...(tokenTenant === undefined ? {} : { tokenTenant }),
		...(guestAadObjectIds === undefined ? {} : { guestAadObjectIds }),
		...(ownerMode === undefined ? {} : { ownerMode }),
		...(guestModel === undefined ? {} : { guestModel }),
		...(graph === undefined ? {} : { graph }),
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

/**
 * Whether `workspaceDir` is the home, `config.json` or `secrets/` (or inside one): the workspace root would then hold
 * the config or the token files (a procedure file under it could be a secret), or `mkdir` would collide with config.json.
 */
export function workspaceOverlapsHome(homeDir: string, workspaceDir: string): boolean {
	const inside = (parent: string): boolean => {
		const rel = relative(parent, workspaceDir);
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
	};
	return workspaceDir === resolve(homeDir) || inside(join(homeDir, "config.json")) || inside(join(homeDir, "secrets"));
}

function checkHome(homeDir: string): void {
	let mode: number;
	try {
		const stat = statSync(homeDir);
		if (!stat.isDirectory()) throw new ConfigError("home_missing", homeDir, "not a directory");
		mode = stat.mode;
	} catch (error) {
		if (error instanceof ConfigError) throw error;
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
	const slack = config.slack;
	if (slack === undefined) throw new Error("channels.slack is not configured");
	return {
		botToken: readSecret(slack.botTokenFile, "xoxb-"),
		appToken: readSecret(slack.appTokenFile, "xapp-"),
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

/** Reads the Teams client secret file again (0600, one non-empty line); the value never leaves memory. */
export function readTeamsClientSecret(config: OmpbotConfig): string {
	const teams = config.channels.teams;
	if (teams === undefined) throw new Error("channels.teams is not configured");
	const value = readSecretFile(teams.clientSecretFile);
	if (value === "" || /[\r\n]/.test(value)) {
		throw new ConfigError("config_invalid", teams.clientSecretFile, "field=channels.teams.clientSecretFile");
	}
	return value;
}

/**
 * Loads and validates `<homeDir>/config.json`. Credential-file and workspace paths resolve against the config dir.
 * `checkTokens: false` skips reading the token files — for processes that never talk to Slack (`ompbot dashboard`).
 */
/** A CLI's zone: the home's `config.timezone`, or the zone a config without the key gets when there is no usable one. */
export function timezoneOfHome(homeDir: string): string {
	try {
		return loadConfig(homeDir, { checkTokens: false }).timezone;
	} catch {
		return hostTimezone();
	}
}

export function loadConfig(homeDir: string = defaultHomeDir(), options: { checkTokens?: boolean } = {}): OmpbotConfig {
	const home = resolve(homeDir);
	checkHome(home);

	const configPath = join(home, "config.json");
	let raw: string;
	try {
		// A FIFO or device would block this synchronous read (the daemon's event loop on a reload) for good.
		const kind = statSync(configPath);
		if (!kind.isFile() && !kind.isDirectory()) {
			throw Object.assign(new Error("not a regular file"), { code: "ENOTREG" });
		}
		raw = readFileSync(configPath, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") throw new ConfigError("config_missing", configPath);
		throw new ConfigError("config_unreadable", configPath, code ?? "read failed");
	}
	let parsed: unknown;
	try {
		// A Windows editor may save a byte-order mark first; JSON.parse refuses it as an unnamed token.
		parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
	} catch (error) {
		// The parser names what it expected but not where; the usual culprits are named so the file can be scanned.
		// Quoted text in its message can be file content (a token pasted into the wrong place), so it is masked.
		const reason = (error instanceof Error ? error.message : String(error)).replace(/(["'])[^"']{2,}\1/g, "…");
		throw new ConfigError(
			"config_invalid_json",
			configPath,
			`${reason}; look for a trailing comma, a missing comma between keys, or unquoted keys`,
		);
	}

	const root = asRecord(parsed);
	if (!root) invalid(configPath, "<root>");
	if (root.schemaVersion !== 1) invalid(configPath, "schemaVersion");
	const warnings: ConfigWarning[] = [];
	for (const key of Object.keys(root)) if (!ROOT_KEYS.has(key)) warnings.push({ field: key, reason: "unknown_key" });
	const slack = root.slack === undefined ? undefined : asRecord(root.slack);
	if (root.slack !== undefined && slack === undefined) invalid(configPath, "slack");

	const ompExecutable = requiredString(configPath, root, "ompExecutable");
	if (!isAbsolute(ompExecutable)) invalid(configPath, "ompExecutable");
	const workspaceDir = resolve(home, requiredString(configPath, root, "workspaceDir"));
	if (workspaceOverlapsHome(home, workspaceDir)) invalid(configPath, "workspaceDir");
	const ompProfile = optionalString(configPath, root, "ompProfile");
	if (ompProfile !== undefined && !OMP_PROFILE_PATTERN.test(ompProfile)) invalid(configPath, "ompProfile");

	const agent = root.agent;
	if (agent !== undefined && agent !== "omp" && agent !== "claude" && agent !== "agy") invalid(configPath, "agent");
	const claudeExecutable = optionalString(configPath, root, "claudeExecutable");
	if (claudeExecutable !== undefined && !isAbsolute(claudeExecutable)) invalid(configPath, "claudeExecutable");
	const agyExecutable = optionalString(configPath, root, "agyExecutable");
	if (agyExecutable !== undefined && !isAbsolute(agyExecutable)) invalid(configPath, "agyExecutable");

	const timezoneRaw = optionalString(configPath, root, "timezone");
	if (timezoneRaw !== undefined && !isTimezone(timezoneRaw)) invalid(configPath, "timezone");

	const sessionRetentionDays = optionalInt(configPath, root, "sessionRetentionDays", 1);
	const maxBundleBytes = optionalInt(configPath, root, "maxBundleBytes", 1);
	const idleTimeoutMinutes = optionalInt(configPath, root, "idleTimeoutMinutes", 0);
	const skillReviewTurns = optionalInt(configPath, root, "skillReviewTurns", 0);

	const { channels, deprecated } = parseChannels(configPath, root, home);
	if (channels.slack !== undefined && slack === undefined) invalid(configPath, "slack");
	const slackOff = channels.slack === undefined;

	const mentionFreeChannels = root.mentionFreeChannels;
	if (
		mentionFreeChannels !== undefined &&
		(!Array.isArray(mentionFreeChannels) ||
			mentionFreeChannels.some((c) => typeof c !== "string" || !CHANNEL_ID.test(c)))
	) {
		invalid(configPath, "mentionFreeChannels");
	}
	// Top-level channel and user ids are Slack ids: without Slack they would name nothing the bot can reach.
	if (slackOff && mentionFreeChannels !== undefined) invalid(configPath, "mentionFreeChannels");

	const peerBotsRaw = root.peerBots;
	if (peerBotsRaw !== undefined) {
		if (!Array.isArray(peerBotsRaw) || slackOff) invalid(configPath, "peerBots");
		peerBotsRaw.forEach((entry, i) => {
			const record = asRecord(entry);
			if (record === undefined || typeof record.userId !== "string" || !SLACK_USER_ID.test(record.userId)) {
				invalid(configPath, `peerBots.${i}.userId`);
			}
			// The owner is never a peer: a peer message carries no owner authority, so listing the owner would only shadow it.
			if (record.userId === channels.slack?.ownerUserId) invalid(configPath, `peerBots.${i}.userId`);
			if (typeof record.name !== "string" || record.name.length < 1 || record.name.length > 32) {
				invalid(configPath, `peerBots.${i}.name`);
			}
			for (const key of Object.keys(record))
				if (key !== "userId" && key !== "name") invalid(configPath, `peerBots.${i}.${key}`);
		});
	}
	const costCap = root.costCap;
	if (costCap !== undefined) {
		const record = asRecord(costCap);
		if (record === undefined) invalid(configPath, "costCap");
		for (const key of Object.keys(record)) {
			if (key !== "turnUsd" && key !== "dailyUsd") invalid(configPath, `costCap.${key}`);
			const value = record[key];
			if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
				invalid(configPath, `costCap.${key}`);
			}
		}
	}

	const lanes = root.lanes;
	if (lanes !== undefined) {
		const record = asRecord(lanes);
		if (record === undefined) invalid(configPath, "lanes");
		for (const key of Object.keys(record)) {
			const value = record[key];
			if (key === "completionNudges") {
				if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(configPath, `lanes.${key}`);
			} else if (key === "models") {
				const models = asRecord(value);
				if (models === undefined) invalid(configPath, "lanes.models");
				for (const [tier, model] of Object.entries(models)) {
					if (!(LANE_MODEL_TIERS as readonly string[]).includes(tier)) invalid(configPath, `lanes.models.${tier}`);
					if (typeof model !== "string" || !/^[^/\s]+\/\S+$/.test(model)) invalid(configPath, `lanes.models.${tier}`);
				}
			} else {
				invalid(configPath, `lanes.${key}`);
			}
		}
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
	let peerSilenceAlert: { minutes: number } | undefined;
	if (root.peerSilenceAlert !== undefined) {
		const record = asRecord(root.peerSilenceAlert);
		if (record === undefined) invalid(configPath, "peerSilenceAlert");
		for (const key of Object.keys(record)) {
			if (key !== "minutes") invalid(configPath, `peerSilenceAlert.${key}`);
		}
		const minutes = record.minutes;
		if (
			typeof minutes !== "number" ||
			!Number.isInteger(minutes) ||
			minutes < 0 ||
			minutes > PEER_SILENCE_MAX_MINUTES
		) {
			invalid(configPath, "peerSilenceAlert.minutes");
		}
		peerSilenceAlert = { minutes };
	}

	const dispatchHosts = root.dispatchHosts;
	if (dispatchHosts !== undefined) {
		const hosts = asRecord(dispatchHosts);
		if (hosts === undefined) invalid(configPath, "dispatchHosts");
		for (const [name, entry] of Object.entries(hosts ?? {})) {
			const record = asRecord(entry);
			if (record === undefined || typeof record.ssh !== "string" || !DISPATCH_SSH.test(record.ssh)) {
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
		// A name is printed into doctor lines and reports; a control character in it could forge a line there.
		if (Object.keys(hosts ?? {}).some((name) => /[\p{Cc}\p{Cf}]/u.test(name))) {
			warnings.push({ field: "dispatchHosts", reason: "unsafe_name" });
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
		// `~//x` would make scp's path absolute and `//` leave no directory: repeated slashes collapse here, and a
		// value that is only slashes still loads (it always did) but is flagged, and the off-site run refuses it.
		const remoteDir = (record.remoteDir as string).replace(/\/{2,}/g, "/");
		if (!isOffsiteDir(remoteDir)) warnings.push({ field: "offsite.remoteDir", reason: "unusable" });
		if (record?.keep !== undefined && (!Number.isSafeInteger(record.keep) || (record.keep as number) < 1)) {
			invalid(configPath, "offsite.keep");
		}
		offsite = {
			ssh: record?.ssh as string,
			remoteDir,
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
			if (key !== "repos" && key !== "maxRisk" && key !== "review") invalid(configPath, `taskAutoLand.${key}`);
		}
		let review: NonNullable<OmpbotConfig["taskAutoLand"]>["review"];
		if (record.review !== undefined) {
			const reviewRecord = asRecord(record.review);
			if (reviewRecord === undefined) invalid(configPath, "taskAutoLand.review");
			const model = reviewRecord.model;
			// `cursor` is in the reviewer's disabledProviders overlay (its discovery), which also disables that model provider.
			if (typeof model !== "string" || model.trim() === "" || model.trim().startsWith("cursor/")) {
				invalid(configPath, "taskAutoLand.review.model");
			}
			const timeoutMs = reviewRecord.timeoutMs;
			if (
				timeoutMs !== undefined &&
				(typeof timeoutMs !== "number" ||
					!Number.isInteger(timeoutMs) ||
					timeoutMs <= 0 ||
					timeoutMs > LANE_REVIEW_TIMEOUT_MAX_MS)
			) {
				invalid(configPath, "taskAutoLand.review.timeoutMs");
			}
			for (const key of Object.keys(reviewRecord)) {
				if (key !== "model" && key !== "timeoutMs" && key !== "confident") {
					invalid(configPath, `taskAutoLand.review.${key}`);
				}
			}
			let confident: LaneReviewConfident | undefined;
			if (reviewRecord.confident !== undefined) {
				const confidentRecord = asRecord(reviewRecord.confident);
				if (confidentRecord === undefined) invalid(configPath, "taskAutoLand.review.confident");
				const confidentRisk = confidentRecord.maxRisk;
				// The band starts above `maxRisk`: at or below it the lane already merges on a plain CLEAR.
				if (
					!(TASK_RISKS as readonly unknown[]).includes(confidentRisk) ||
					TASK_RISKS.indexOf(confidentRisk as TaskRisk) <= TASK_RISKS.indexOf((maxRisk ?? "L2") as TaskRisk)
				) {
					invalid(configPath, "taskAutoLand.review.confident.maxRisk");
				}
				const minConfidence = confidentRecord.minConfidence;
				if (
					typeof minConfidence !== "number" ||
					!Number.isFinite(minConfidence) ||
					minConfidence <= 0 ||
					minConfidence > 1
				) {
					invalid(configPath, "taskAutoLand.review.confident.minConfidence");
				}
				for (const key of Object.keys(confidentRecord)) {
					if (key !== "maxRisk" && key !== "minConfidence") invalid(configPath, `taskAutoLand.review.confident.${key}`);
				}
				confident = { maxRisk: confidentRisk as TaskRisk, minConfidence };
			}
			review = {
				model,
				...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
				...(confident === undefined ? {} : { confident }),
			};
		}
		taskAutoLand = {
			repos: (repos as string[]).map((repo) => repo.replace(/(?<=.)\/+$/, "")),
			...(maxRisk === undefined ? {} : { maxRisk: maxRisk as TaskRisk }),
			...(review === undefined ? {} : { review }),
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
	if (slackOff && escalationChannel !== undefined) invalid(configPath, "escalationChannel");
	if (slackOff && logChannel !== undefined) invalid(configPath, "logChannel");

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

	const turnSnapshotRaw = root.turnSnapshot;
	let turnSnapshot: { repos: string[] } | undefined;
	if (turnSnapshotRaw !== undefined) {
		const record = asRecord(turnSnapshotRaw);
		if (record === undefined) invalid(configPath, "turnSnapshot");
		const repos = record.repos;
		if (
			repos !== undefined &&
			(!Array.isArray(repos) || repos.some((repo) => typeof repo !== "string" || !isAbsolute(repo)))
		) {
			invalid(configPath, "turnSnapshot.repos");
		}
		for (const key of Object.keys(record)) if (key !== "repos") invalid(configPath, `turnSnapshot.${key}`);
		for (const repo of (repos as string[] | undefined) ?? []) {
			// Each entry must be a git work tree now: a wrong path would otherwise fail mid-turn, long after startup.
			let workTree = false;
			try {
				workTree = statSync(join(repo, ".git")).isDirectory() || statSync(join(repo, ".git")).isFile();
			} catch {
				workTree = false;
			}
			if (!workTree) invalid(configPath, "turnSnapshot.repos");
		}
		turnSnapshot = { repos: (repos as string[] | undefined) ?? [] };
	}

	const briefingRaw = root.briefing;
	let briefing: { chromium?: string } | undefined;
	if (briefingRaw !== undefined) {
		const record = asRecord(briefingRaw);
		if (record === undefined) invalid(configPath, "briefing");
		for (const key of Object.keys(record)) if (key !== "chromium") invalid(configPath, `briefing.${key}`);
		const chromium = optionalString(configPath, record, "chromium", "briefing.chromium");
		briefing = chromium === undefined ? {} : { chromium };
	}

	const applyRaw = root.apply;
	let apply: NonNullable<OmpbotConfig["apply"]> | undefined;
	if (applyRaw !== undefined) {
		const record = asRecord(applyRaw);
		if (record === undefined) invalid(configPath, "apply");
		for (const key of Object.keys(record)) if (key !== "codeRollback") invalid(configPath, `apply.${key}`);
		const mode = record.codeRollback;
		if (mode !== undefined && !CODE_ROLLBACK_MODES.some((known) => known === mode)) {
			invalid(configPath, "apply.codeRollback");
		}
		apply = mode === undefined ? {} : { codeRollback: mode as CodeRollbackMode };
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
		if (record.opsStatus !== undefined) {
			const ops = asRecord(record.opsStatus);
			if (ops === undefined) invalid(configPath, "dashboard.opsStatus");
			if (
				!Array.isArray(ops.command) ||
				ops.command.length === 0 ||
				!ops.command.every((part) => typeof part === "string" && part !== "")
			) {
				invalid(configPath, "dashboard.opsStatus.command");
			}
			if (ops.url !== undefined && (typeof ops.url !== "string" || !/^https?:\/\/\S+$/.test(ops.url))) {
				invalid(configPath, "dashboard.opsStatus.url");
			}
			for (const key of Object.keys(ops)) {
				if (key !== "command" && key !== "url") invalid(configPath, `dashboard.opsStatus.${key}`);
			}
		}
		for (const key of Object.keys(record)) {
			if (key !== "port" && key !== "bind" && key !== "herdrWebUrl" && key !== "opsStatus") {
				invalid(configPath, `dashboard.${key}`);
			}
		}
	}

	const candidatesRaw = root.candidates;
	let candidates: NonNullable<OmpbotConfig["candidates"]> | undefined;
	if (candidatesRaw !== undefined) {
		const record = asRecord(candidatesRaw);
		if (record === undefined) invalid(configPath, "candidates");
		candidates = {};
		for (const key of Object.keys(record)) {
			const value = record[key];
			if (key === "enabled") {
				if (typeof value !== "boolean") invalid(configPath, "candidates.enabled");
				candidates.enabled = value;
			} else if (key === "mode") {
				if (value !== "log" && value !== "card") invalid(configPath, "candidates.mode");
				candidates.mode = value;
			} else if (key === "minDays" || key === "windowDays" || key === "maxOpenCards" || key === "snoozeDays") {
				if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
					invalid(configPath, `candidates.${key}`);
				candidates[key] = value;
			} else {
				invalid(configPath, `candidates.${key}`);
			}
		}
	}

	const config: OmpbotConfig = {
		schemaVersion: 1,
		homeDir: home,
		configPath,
		channels,
		ompExecutable,
		workspaceDir,
		timezone: timezoneRaw ?? hostTimezone(),
	};
	if (deprecated.length > 0) config.deprecated = deprecated;
	if (warnings.length > 0) config.warnings = warnings;
	if (slack !== undefined) {
		const slackConfig: SlackConfig = {
			botTokenFile: resolve(home, requiredString(configPath, slack, "botTokenFile", "slack.botTokenFile")),
			appTokenFile: resolve(home, requiredString(configPath, slack, "appTokenFile", "slack.appTokenFile")),
		};
		const appId = optionalString(configPath, slack, "appId", "slack.appId");
		const teamId = optionalString(configPath, slack, "teamId", "slack.teamId");
		const botUserId = optionalString(configPath, slack, "botUserId", "slack.botUserId");
		if (appId !== undefined) slackConfig.appId = appId;
		if (teamId !== undefined) slackConfig.teamId = teamId;
		if (botUserId !== undefined) slackConfig.botUserId = botUserId;
		config.slack = slackConfig;
	}
	const model = optionalString(configPath, root, "model");
	const thinking = optionalString(configPath, root, "thinking");
	if (model !== undefined) config.model = model;
	if (thinking !== undefined) config.thinking = thinking;
	if (agent !== undefined) config.agent = agent;
	if (claudeExecutable !== undefined) config.claudeExecutable = claudeExecutable;
	if (agyExecutable !== undefined) config.agyExecutable = agyExecutable;
	if (ompProfile !== undefined) config.ompProfile = ompProfile;
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
	if (peerSilenceAlert !== undefined) config.peerSilenceAlert = peerSilenceAlert;
	if (costCap !== undefined) {
		const record = costCap as { turnUsd?: number; dailyUsd?: number };
		const capped: { turnUsd?: number; dailyUsd?: number } = {};
		if (record.turnUsd !== undefined) capped.turnUsd = record.turnUsd;
		if (record.dailyUsd !== undefined) capped.dailyUsd = record.dailyUsd;
		config.costCap = capped;
	}
	if (escalationChannel !== undefined) config.escalationChannel = escalationChannel;
	if (logChannel !== undefined) config.logChannel = logChannel;
	if (restartNotice !== undefined) config.restartNotice = restartNotice;
	if (recallEnabled !== undefined) config.recallEnabled = recallEnabled;
	if (watcherRoots !== undefined) config.watcherRoots = (watcherRoots as string[]).map((r) => resolve(r));
	if (turnSnapshot !== undefined) config.turnSnapshot = { repos: turnSnapshot.repos.map((repo) => resolve(repo)) };
	if (briefing !== undefined) config.briefing = briefing;
	if (candidates !== undefined) config.candidates = candidates;
	if (apply !== undefined) config.apply = apply;
	if (webhook !== undefined) config.webhook = webhook as { port: number; bind?: "127.0.0.1" | "::1" };
	if (dashboard !== undefined) config.dashboard = dashboard as NonNullable<OmpbotConfig["dashboard"]>;
	if (herdr !== undefined) config.herdr = herdr;
	if (dispatchHosts !== undefined) config.dispatchHosts = dispatchHosts as Record<string, DispatchHostConfig>;
	if (workerOmpArgs !== undefined) config.workerOmpArgs = workerOmpArgs;

	if (herdrBoard !== undefined) config.herdrBoard = herdrBoard as { url: string; api?: string };
	if (taskAutoLand !== undefined) config.taskAutoLand = taskAutoLand;
	if (lanes !== undefined) config.lanes = lanes as NonNullable<OmpbotConfig["lanes"]>;

	if (options.checkTokens !== false) {
		// Fail at startup on permissions/prefix/shape; values are discarded here.
		if (config.slack !== undefined) readSlackTokens(config);
		if (config.channels.discord !== undefined) readDiscordToken(config);
		if (config.channels.teams !== undefined) readTeamsClientSecret(config);
	}
	return config;
}
