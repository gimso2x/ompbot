import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type OmpbotConfig, readSlackTokens } from "../config";
import { createLogger, type Logger } from "../log";
import { ClaudeOmpDriver } from "../omp/claude-driver";
import { RpcOmpDriver } from "../omp/rpc-driver";
import { createAggregatingLogger, startServiceAlive } from "../ops/log-hygiene";
import { LogDirError, openLogSink } from "../ops/logfile";
import { redact } from "../redact";
import { floorsArgs, floorsSystemPrompt } from "../safety/prompt";
import { indexRuntimeSecrets } from "../safety/secret-index";
import { SlackChannel } from "../slack/channel";
import { SocketModeTransport } from "../slack/socket-transport";
import { FileFakeTransport } from "../slack/test-transport";
import type { SlackTransport } from "../slack/transport";
import { crashHook } from "./crash";
import { Daemon } from "./daemon";
import { acquireLock, type Lock, LockHeldError } from "./lock";
import { readVersion } from "./tools";

/** `provider/model` in config.json becomes the two RpcClient options. */
function splitModel(model: string | undefined): { provider?: string; model?: string } {
	if (model === undefined) return {};
	const slash = model.indexOf("/");
	return slash === -1 ? { model } : { provider: model.slice(0, slash), model: model.slice(slash + 1) };
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
	try {
		logFile = openLogSink(config.homeDir).sink;
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

	const model = splitModel(config.model);
	// claude children take a bare model id; a `model` naming another provider is an omp-only setting.
	const claudeModel = model.provider === undefined || model.provider === "claude" ? model.model : undefined;
	const secretsDir = join(config.homeDir, "secrets");
	const personaPath = join(config.homeDir, "workspace", "persona.md");
	// Seed the known-secret value index before anything can answer: masking sits below the agent.
	indexRuntimeSecrets(config, env, log);
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
	const daemon = new Daemon({
		config,
		bootConfigText,
		log,
		clock,
		bootId: lock.info.bootId,
		ompVersion: await checkOmpVersion(config, log),
		slack: new SlackChannel(pickTransport(config, env, log)),
		crash: crashHook(env),
		sweepMs: env.OMPBOT_TEST_HOOKS === "1" && env.OMPBOT_SWEEP_MS ? Number(env.OMPBOT_SWEEP_MS) : undefined,
		driverFactory: (origin, sessionDir) =>
			config.agent === "claude"
				? new ClaudeOmpDriver({
						claudeExecutable: config.claudeExecutable ?? "claude",
						cwd: daemon.cwdFor(origin),
						sessionDir,
						...(claudeModel === undefined ? {} : { model: claudeModel }),
						...(config.thinking === undefined ? {} : { thinking: config.thinking }),
						secretsDir,
						systemPrompt: floorsSystemPrompt(
							secretsDir,
							origin,
							personaPath,
							(error) => log.warn("persona_unreadable", { path: personaPath, error: String(error) }),
							config.herdr !== undefined,
						),
						approval: daemon.requestApprovalFor(origin),
					})
				: new DaemonRpcDriver({
						ompExecutable: config.ompExecutable,
						cwd: daemon.cwdFor(origin),
						sessionDir,
						...model,
						...(config.thinking === undefined ? {} : { thinking: config.thinking }),
						env: { OMP_WIKI_NOTE_DISABLE: "1" },
						extraArgs: floorsArgs(
							secretsDir,
							origin,
							personaPath,
							(error) => log.warn("persona_unreadable", { path: personaPath, error: String(error) }),
							config.herdr !== undefined,
						),
						hostTools: daemon.hostToolsFor(origin),
					}),
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
	const stopAlive = startServiceAlive({ log, clock, snapshot: () => daemon.aliveFields() });
	const code = await exited.promise;
	stopAlive();
	log.stop();
	lock.release();
	return code;
}
