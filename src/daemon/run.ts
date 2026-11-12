import { readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { ChannelBinding } from "../channel/adapter";
import { type OmpbotConfig, readDiscordToken, readSlackTokens, readTeamsClientSecret } from "../config";
import { parseChatOrigin } from "../core/origin-key";
import { DiscordBinding } from "../discord/binding";
import { DiscordChannel } from "../discord/channel";
import { DiscordSocketTransport } from "../discord/socket-transport";
import { FileFakeDiscordTransport } from "../discord/test-transport";
import type { DiscordTransport } from "../discord/transport";
import { createLogger, type Logger } from "../log";
import { AgyOmpDriver } from "../omp/agy-driver";
import { ClaudeOmpDriver } from "../omp/claude-driver";
import { withOmpProfile } from "../omp/env";
import { RpcOmpDriver } from "../omp/rpc-driver";
import { testHostLoad } from "../ops/host-resources";
import { type AggregatingLogger, createAggregatingLogger, startServiceAlive } from "../ops/log-hygiene";
import { LogDirError, openLogSink } from "../ops/logfile";
import { redact } from "../redact";
import { spawnSystemPrompt } from "../safety/prompt";
import { indexRuntimeSecrets } from "../safety/secret-index";
import { SlackBinding } from "../slack/binding";
import { SlackChannel } from "../slack/channel";
import { SocketModeTransport } from "../slack/socket-transport";
import { FileFakeTransport } from "../slack/test-transport";
import type { SlackTransport } from "../slack/transport";
import { TeamsBinding } from "../teams/binding";
import { TeamsChannel } from "../teams/channel";
import { TeamsConnector } from "../teams/transport";
import { crashHook } from "./crash";
import { Daemon } from "./daemon";
import { acquireLock, type Lock, LockHeldError } from "./lock";
import { readVersion } from "./tools";
import { startWatchdog, watchdogStallMs } from "./watchdog";

/** `provider/model` in config.json becomes the two RpcClient options. */
export function splitModel(model: string | undefined): { provider?: string; model?: string } {
	if (model === undefined) return {};
	const slash = model.indexOf("/");
	return slash === -1 ? { model } : { provider: model.slice(0, slash), model: model.slice(slash + 1) };
}

/**
 * `env` and `baseEnv` of every bot RPC child (chat, lane and monitor turns share the daemon's driver factory). With
 * `ompProfile` the parent env loses `PI_CODING_AGENT_DIR` and gains `OMP_PROFILE`; without it `baseEnv` stays
 * unset, so the driver reads `process.env` exactly as before.
 */
export function botRpcEnv(
	ompProfile: string | undefined,
	base: Record<string, string | undefined> = process.env,
): { env: Record<string, string>; baseEnv?: Record<string, string | undefined> } {
	const env = { OMP_WIKI_NOTE_DISABLE: "1" };
	return ompProfile === undefined ? { env } : { env, baseEnv: withOmpProfile(base, ompProfile) };
}

/**
 * The `--config` overlay of a Teams group chat's omp child while the Graph chat tools are on: memory off, so what the
 * owner's 1:1 read out of other people's chats (kept in the shared memory) is never recalled into a group answer.
 */
export const TEAMS_GROUP_OVERLAY_YAML = 'memory:\n  backend: "off"\n';

/** Where `runDaemon` writes {@link TEAMS_GROUP_OVERLAY_YAML}. */
export const teamsGroupOverlayPath = (homeDir: string): string => join(homeDir, "teams-group.omp.yml");

/**
 * The overlay file of the RPC child of `origin`: {@link teamsGroupOverlayPath} for a `teams/ch/*` origin when
 * `channels.teams.graph` is set, `undefined` for every other origin and config (no `--config` as before).
 */
export function rpcOverlayFor(config: OmpbotConfig, origin: string): string | undefined {
	if (config.channels.teams?.graph === undefined) return undefined;
	const ref = parseChatOrigin(origin);
	return ref?.platform === "teams" && ref.kind === "ch" ? teamsGroupOverlayPath(config.homeDir) : undefined;
}

function pickTransport(config: OmpbotConfig, env: Record<string, string | undefined>, log: Logger): SlackTransport {
	if (env.OMPBOT_TEST_HOOKS === "1" && env.OMPBOT_TEST_TRANSPORT)
		return new FileFakeTransport(env.OMPBOT_TEST_TRANSPORT);
	return new SocketModeTransport(readSlackTokens(config), {
		onLifecycle: (event) => {
			if (event.type === "connected") log.info("slack_socket_connected");
			else if (event.type === "reconnecting") log.warn("slack_socket_reconnecting", { reason: event.detail });
			else log.warn("slack_socket_error", { error: event.detail });
		},
	});
}

/**
 * The Discord binding when `channels.discord` is set: the real gateway + REST, or the file-logging fake for test
 * runs (`OMPBOT_TEST_DISCORD_TRANSPORT`). A non-retryable gateway close stops Discord alone and is logged.
 */
function discordBindings(config: OmpbotConfig, env: Record<string, string | undefined>, log: Logger): ChannelBinding[] {
	const discord = config.channels.discord;
	if (discord === undefined) return [];
	const transport: DiscordTransport =
		env.OMPBOT_TEST_HOOKS === "1" && env.OMPBOT_TEST_DISCORD_TRANSPORT
			? new FileFakeDiscordTransport(env.OMPBOT_TEST_DISCORD_TRANSPORT)
			: new DiscordSocketTransport(
					{ botToken: readDiscordToken(config) },
					{
						...(discord.displayName === undefined ? {} : { displayName: discord.displayName }),
						onLifecycle: (event) => {
							if (event.type === "connected") log.info("discord_gateway_connected", { detail: event.detail });
							else if (event.type === "reconnecting")
								log.warn("discord_gateway_reconnecting", { reason: event.detail });
							else log.warn("discord_gateway_error", { error: event.detail });
						},
						onFatal: (error) => log.error("discord_gateway_fatal", { code: error.code, error: error.message }),
					},
				);
	return [
		new DiscordBinding(new DiscordChannel(transport, { ownerUserId: discord.ownerUserId, peerBots: discord.peerBots })),
	];
}

/**
 * The Teams binding when `channels.teams` is set: the Bot Framework endpoint on its loopback listener and the Bot
 * Connector with the client secret, read again at every token request.
 */
function teamsBindings(config: OmpbotConfig): ChannelBinding[] {
	const teams = config.channels.teams;
	if (teams === undefined) return [];
	const connector = new TeamsConnector({
		appId: teams.appId,
		clientSecret: () => readTeamsClientSecret(config),
		tokenTenant: teams.tokenTenant ?? teams.tenantId,
	});
	return [new TeamsBinding(new TeamsChannel(connector))];
}

/**
 * One binding per configured platform: Slack only when `channels.slack` is set (its tokens are read only then),
 * Discord only when `channels.discord` is, Teams only when `channels.teams` is.
 */
export function channelBindings(
	config: OmpbotConfig,
	env: Record<string, string | undefined>,
	log: Logger,
): ChannelBinding[] {
	const slack =
		config.channels.slack === undefined ? [] : [new SlackBinding(new SlackChannel(pickTransport(config, env, log)))];
	return [...slack, ...discordBindings(config, env, log), ...teamsBindings(config)];
}

/** Logs the omp version on every start and warns when it differs from the one recorded by the previous start. */
async function checkOmpVersion(config: OmpbotConfig, log: Logger): Promise<string> {
	const version = await readVersion([config.ompExecutable, "--version"]);
	const recorded = join(config.homeDir, "omp-version");
	let previous: string | undefined;
	try {
		previous = readFileSync(recorded, "utf8").trim();
	} catch {
		previous = undefined;
	}
	if (previous !== undefined && previous !== version) {
		log.warn("omp_version_changed", { from: previous, to: version });
	}
	writeFileSync(recorded, `${version}\n`, { mode: 0o600 });
	return version;
}

/**
 * Test-only fatal error once the daemon runs: `OMPBOT_TEST_FATAL=rejection|exception`, read only when
 * `OMPBOT_TEST_HOOKS=1` (like `OMPBOT_TEST_CRASH_AT`), so the `daemon_fatal` record can be proven on a real process.
 */
function testFatal(env: Record<string, string | undefined>): void {
	const kind = env.OMPBOT_TEST_HOOKS === "1" ? env.OMPBOT_TEST_FATAL : undefined;
	if (kind === "rejection") setTimeout(() => void Promise.reject(new Error("test_fatal")), 0);
	if (kind === "exception") {
		setTimeout(() => {
			throw new Error("test_fatal");
		}, 0);
	}
}

/**
 * The crash exit: one synchronous `daemon_fatal` line, then the folded counts (`log_summary`) the hourly flush would
 * have written, then exit 1 — the code Bun itself exits with on an uncaught error or an unhandled rejection.
 */
export function fatalHandler(
	lastWords: Logger,
	log: AggregatingLogger,
	exit: (code: number) => void,
): (kind: string, error: unknown) => void {
	return (kind, error) => {
		lastWords.error("daemon_fatal", {
			kind,
			error: String(error).slice(0, 500),
			stack: error instanceof Error ? error.stack?.split("\n").slice(0, 5).join("\n") : undefined,
		});
		try {
			log.stop();
		} catch {
			// best effort: the fatal line above is already written
		}
		exit(1);
	};
}

/**
 * `ompbot daemon`: holds the single-instance lock, runs until SIGTERM/SIGINT, then stops gracefully.
 * Resolves with the process exit code.
 */
export async function runDaemon(
	config: OmpbotConfig,
	env: Record<string, string | undefined> = process.env,
	/** The config.json text read right before `loadConfig` produced `config` (the only text last-good may record). */
	bootConfigText?: string,
): Promise<number> {
	let logFile: (line: string) => void;
	let logPath: string;
	try {
		({ sink: logFile, path: logPath } = openLogSink(config.homeDir));
	} catch (error) {
		if (error instanceof LogDirError) {
			process.stderr.write(`ompbot daemon: refusing to start: ${error.message}\n`);
			return 1;
		}
		throw error;
	}
	const lockPath = join(config.homeDir, "ompbot.lock");
	let lock: Lock;
	try {
		lock = acquireLock(lockPath);
	} catch (error) {
		if (error instanceof LockHeldError) {
			process.stderr.write(`${error.message}\n`);
			return 1;
		}
		throw error;
	}

	const clock = { now: () => Date.now() };
	let logWriteFailed = false;
	// Routine drops (bot chatter, messages not for the bot) fold into one hourly `log_summary`; warn/error never fold.
	const log = createAggregatingLogger(
		createLogger({
			clock,
			redact,
			sink: (line) => {
				try {
					logFile(line);
				} catch (error) {
					// The file is gone or full: keep the daemon alive on stderr (journal) and say so once.
					if (!logWriteFailed) process.stderr.write(`log_write_failed: ${String(error)}\n`);
					logWriteFailed = true;
				}
				process.stderr.write(`${line}\n`);
			},
		}),
		{ clock },
	);
	// Why the process ended, in ompbot.log too (not only Bun's journal output). Both lines are written synchronously:
	// the process is gone right after them.
	const lastWords = createLogger({
		clock,
		redact,
		sink: (line) => {
			try {
				logFile(line);
			} catch {
				// stderr below still reaches the journal
			}
			try {
				writeSync(2, `${line}\n`);
			} catch {
				// nothing left to report to
			}
		},
	});
	const fatal = fatalHandler(lastWords, log, (code) => process.exit(code));
	process.on("uncaughtException", (error) => fatal("uncaughtException", error));
	process.on("unhandledRejection", (reason) => fatal("unhandledRejection", reason));
	process.on("exit", (code) => lastWords.info("daemon_exit", { code }));

	const model = splitModel(config.model);
	// claude children take a bare model id; a `model` naming another provider is an omp-only setting.
	const claudeModel = model.provider === undefined || model.provider === "claude" ? model.model : undefined;
	// agy children take a bare agy model id (`agy/gemini-3.8-flash-high` → `gemini-3.8-flash-high`).
	const agyModel = model.provider === undefined || model.provider === "agy" ? model.model : undefined;
	const secretsDir = join(config.homeDir, "secrets");
	const personaFiles = {
		persona: join(config.homeDir, "workspace", "persona.md"),
		soul: join(config.homeDir, "workspace", "soul.md"),
		owner: join(config.homeDir, "workspace", "owner.md"),
	};
	const onPersonaError = (error: unknown, path: string) =>
		log.warn("persona_unreadable", { path, error: String(error) });
	// Seed the known-secret value index before anything can answer: masking sits below the agent.
	indexRuntimeSecrets(config, env, log);
	if (config.channels.teams?.graph !== undefined) {
		writeFileSync(teamsGroupOverlayPath(config.homeDir), TEAMS_GROUP_OVERLAY_YAML, { mode: 0o600 });
	}
	const exited = Promise.withResolvers<number>();
	const shutdown = (signal: string) => {
		log.info("signal", { signal });
		daemon.stop().then(
			() => exited.resolve(0),
			(error: unknown) => {
				log.error("stop_failed", { error: String(error) });
				exited.resolve(1);
			},
		);
	};
	// Loading omp's RPC client imports @oh-my-pi/pi-utils, whose postmortem hook adds its own SIGTERM/SIGINT/SIGHUP
	// handlers that exit(143) at once. The daemon must stop its children and settle the ledger first, so it
	// takes the handlers back at boot and again after every driver start (the first start loads that module).
	// SIGHUP re-reads config.json (`ompbot reload` does the same over the socket) instead of stopping the daemon.
	const claimSignals = () => {
		for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
			process.removeAllListeners(signal);
			process.on(signal, () => {
				if (signal !== "SIGHUP") return shutdown(signal);
				log.info("signal", { signal });
				daemon.reloadConfig("sighup");
			});
		}
	};
	class DaemonRpcDriver extends RpcOmpDriver {
		override async start(): Promise<void> {
			await super.start();
			claimSignals();
		}
	}
	const hostLoad = testHostLoad(env); // test-only idle host, behind OMPBOT_TEST_HOOKS=1
	const daemon = new Daemon({
		config,
		bootConfigText,
		log,
		clock,
		bootId: lock.info.bootId,
		ompVersion: await checkOmpVersion(config, log),
		channels: channelBindings(config, env, log),
		crash: crashHook(env),
		...(hostLoad === undefined ? {} : { hostLoad }),
		sweepMs: env.OMPBOT_TEST_HOOKS === "1" && env.OMPBOT_SWEEP_MS ? Number(env.OMPBOT_SWEEP_MS) : undefined,
		driverFactory: (origin, sessionDir) => {
			// Only the omp driver answers dialogs and narrows host tools for a peer-touched conversation.
			const omp = config.agent !== "agy" && config.agent !== "claude";
			const overlayConfig = rpcOverlayFor(config, origin);
			const answerDialog = omp ? daemon.answerDialogsFor(origin) : undefined;
			const systemPrompt = spawnSystemPrompt({
				secretsDir,
				originKey: origin,
				sessionDir,
				files: personaFiles,
				onPersonaError,
				herdr: config.herdr !== undefined,
				// `ask` is allowed only where the owner can answer it: the same answerer the omp driver gets below.
				ownerDialogs: answerDialog !== undefined,
				peerTouched: omp && daemon.peerTouched(origin),
				surface: daemon.floorsSurfaceFor(origin),
				// agy and claude children get no ompbot host tools, so their floors name none.
				hostTools: omp,
				now: clock.now(),
				log,
			});
			return config.agent === "agy"
				? new AgyOmpDriver({
						agyExecutable: config.agyExecutable ?? "agy",
						cwd: daemon.cwdFor(origin),
						sessionDir,
						...(agyModel === undefined ? {} : { model: agyModel }),
						...(config.thinking === undefined ? {} : { thinking: config.thinking }),
						// No --append-system-prompt in agy: the driver prepends this to the first message of each child.
						systemPrompt,
						log,
					})
				: config.agent === "claude"
					? new ClaudeOmpDriver({
							claudeExecutable: config.claudeExecutable ?? "claude",
							cwd: daemon.cwdFor(origin),
							sessionDir,
							...(claudeModel === undefined ? {} : { model: claudeModel }),
							...(config.thinking === undefined ? {} : { thinking: config.thinking }),
							secretsDir,
							systemPrompt,
							approval: daemon.requestApprovalFor(origin),
							log,
						})
					: new DaemonRpcDriver({
							ompExecutable: config.ompExecutable,
							cwd: daemon.cwdFor(origin),
							sessionDir,
							...model,
							...(config.thinking === undefined ? {} : { thinking: config.thinking }),
							...botRpcEnv(config.ompProfile),
							...(overlayConfig === undefined ? {} : { overlayConfig }),
							extraArgs: ["--append-system-prompt", systemPrompt],
							hostTools: daemon.hostToolsFor(origin),
							answerDialog,
							log,
						});
		},
	});
	claimSignals();
	try {
		await daemon.start();
	} catch (error) {
		log.error("daemon_start_failed", { error: String(error) });
		await daemon.stop().catch(() => undefined);
		log.stop();
		lock.release();
		return 1;
	}
	// From here a main thread stuck for minutes ends the process (SIGKILL) and systemd starts a fresh one.
	const watchdog = startWatchdog({ stallMs: watchdogStallMs(env), logPath });
	const stopAlive = startServiceAlive({ log, clock, snapshot: () => daemon.aliveFields() });
	testFatal(env);
	const code = await exited.promise;
	stopAlive();
	watchdog.stop();
	log.stop();
	lock.release();
	return code;
}
