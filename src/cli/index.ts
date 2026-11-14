import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ConfigError, defaultHomeDir, loadConfig, type OmpbotConfig, timezoneOfHome } from "../config";
import { escapeControl, runDoctor } from "../daemon/doctor";
import { callDaemon } from "../daemon/ipc";
import type { ReloadResult } from "../daemon/reload";
import { runDaemon } from "../daemon/run";
import { readStatusFromDb, renderStatusText, type StatusReport } from "../daemon/status";
import { readVersion } from "../daemon/tools";
import { herdrSshArgv, type ProcessRunner, realProcessRunner } from "../dispatch/omp";
import { readConfigText } from "../ops/apply";
import { BackupError, type BackupResult, DEFAULT_KEEP, runBackup } from "../ops/backup";
import { clearFreeze, readFreeze, writeFreeze } from "../ops/freeze";
import { collectGates, type GatesOptions, gateOptionsFromConfig } from "../ops/gates";
import { DEFAULT_SESSION_RETENTION_DAYS, gcSessions } from "../ops/gc";
import { type HostLoadReader, testHostLoad } from "../ops/host-resources";
import { OffsiteError, type OffsiteResult, runOffsite } from "../ops/offsite";
import { APPLY_USAGE, applyCommand } from "./apply";
import { DASHBOARD_USAGE, dashboardCommand } from "./dashboard";
import { DRAIN_USAGE, drainCommand } from "./drain";
import { INIT_USAGE, initCommand } from "./init";
import { LANES_USAGE, lanesCommand } from "./lanes";
import { MONITORS_USAGE, monitorsCommand } from "./monitors";
import { OMP_USAGE, ompCommand } from "./omp";
import { RESTORE_USAGE, restoreCommand } from "./restore";
import { SKILLS_USAGE, skillsCommand } from "./skills";
import { TASKS_USAGE, tasksCommand } from "./tasks";
import { TEAMS_USAGE, teamsCommand } from "./teams";
import { UNITS_USAGE, unitsCommand } from "./units";

/** ssh's own ConnectTimeout is 5 s; the whole check gets a little more. */
const DISPATCH_HOST_CHECK_MS = 10_000;

const USAGE = `usage: ompbot <command>
${INIT_USAGE}${UNITS_USAGE}  daemon                         run the bot (single instance)
  status [--json]                ledger counts, origins, omp version
  doctor                         check home, secrets, omp, omp runtime, bun, Slack auth, backup bundle; then herdr --version and the herdr omp
                                 integration (herdr on), and ssh reach plus the herdr omp integration per dispatchHosts entry (integration
                                 and host lines are warnings and do not change the exit code)
  gc [--dry-run]                 delete previous-epoch session dirs, idle thread origins and deleted-monitor origins older than sessionRetentionDays (default 30)
  backup [--keep N] [--max-bundle-bytes N]    consistent ompbot.db snapshot (VACUUM INTO), quick_check, retention: 14 days (one per day, all of the run's day) + stamp
                                 + sessions/config.json/workspace/scripts bundle (tar.gz, sha256 in the stamp) when they exist; the
                                 bundle size cap defaults to 512MB (config maxBundleBytes, --max-bundle-bytes overrides)
                                 with config offsite {ssh, remoteDir, keep?}, a good backup is then copied off-site
                                 (exit 4 when only the off-site copy failed; the local backup and its stamp stay)
  freeze [--reason <t>]          write <home>/FROZEN: remote dispatch, monitor fires, new work lanes, running lanes' automatic
                                 re-prompts, task reminders and skill reviews stop within seconds (owner chat turns keep
                                 working); a due 'at' monitor waits and fires once after unfreeze; the 'frozen' gate stays
                                 open until unfreeze
  unfreeze                       remove <home>/FROZEN
  gates [--json] [--strict]      read-only health projection; each gate is open, closed or unknown (nothing to judge: no
                                 heartbeat stamp or no ompbot.db yet); exit 1 if any open, with --strict also if any unknown.
                                 gates: backup_age, offsite_age (only with config offsite), sweep_stalled, slack_disconnected,
                                 discord_disconnected (only with config channels.discord), frozen,
                                 herdr_unreachable (only with a herdr-health stamp), omp_runtime (only with agent omp),
                                 disk_low, host_pressure, inbound_starved, origin_silent, deliveries_overdue, lanes_stuck,
                                 monitors_failed, monitors_stalled, turns_failing, ledger_unreadable,
                                 cost_cap (only with config costCap.dailyUsd)
  inject --origin <slack|discord>/<dm|ch>/ID --as-owner --text <t> [--quoted <q>] [--thread <ts|message id>]
  reload                         running daemon re-reads config.json (also SIGHUP): policy fields apply live,
                                 startup-bound fields are listed as restart_required; an invalid file changes nothing
${DRAIN_USAGE}${APPLY_USAGE}${OMP_USAGE}${RESTORE_USAGE}${MONITORS_USAGE}${TASKS_USAGE}${LANES_USAGE}${SKILLS_USAGE}${DASHBOARD_USAGE}${TEAMS_USAGE}`;

function isStatusResponse(value: unknown): value is { ok: true; status: StatusReport } {
	return typeof value === "object" && value !== null && "ok" in value && value.ok === true && "status" in value;
}

function gcCommand(args: string[], homeDir: string): number {
	const { values } = parseArgs({ args, options: { "dry-run": { type: "boolean" } } });
	const dryRun = values["dry-run"] === true;
	const config = loadConfig(homeDir);
	const result = gcSessions({
		homeDir,
		retentionDays: config.sessionRetentionDays ?? DEFAULT_SESSION_RETENTION_DAYS,
		now: Date.now(),
		dryRun,
	});
	const verb = dryRun ? "would_remove" : "removed";
	for (const path of result.removed) process.stdout.write(`gc ${verb} path=${path}\n`);
	for (const key of result.threadOriginsRemoved) {
		process.stdout.write(`gc thread_${verb} origin=${key}\n`);
	}
	for (const key of result.monitorOriginsRemoved) {
		process.stdout.write(`gc monitor_${verb} origin=${key}\n`);
	}
	process.stdout.write(
		`gc_done ${verb}=${result.removed.length} retained=${result.retained.length} threads=${result.threadOriginsRemoved.length} monitors=${result.monitorOriginsRemoved.length} teams_qa=${result.teamsQaRemoved} inbound=${result.ledgerRemoved.inbound} deliveries=${result.ledgerRemoved.deliveries} delivery_posts=${result.ledgerRemoved.deliveryPosts} monitor_events=${result.ledgerRemoved.monitorEvents}\n`,
	);
	return 0;
}

/**
 * Config for the CLI levers (bundle cap, off-site target). A home without a config.json keeps the defaults —
 * `ompbot backup` must work on a db-only home (it is the recovery tool) — while a config that exists but is invalid
 * fails loudly, so a broken `maxBundleBytes` or `offsite` never silently reverts to "off".
 */
function loadConfigIfPresent(homeDir: string, options: { checkTokens?: boolean } = {}): OmpbotConfig | undefined {
	return existsSync(join(homeDir, "config.json")) ? loadConfig(homeDir, options) : undefined;
}

const firstLine = (text: string | undefined): string => text?.trim().split("\n")[0]?.trim() ?? "";

/**
 * Reach check per `dispatchHosts` entry, run together: one `ok`/`fail <ssh's first stderr line>` line each, in config
 * order, each followed by that host's herdr omp integration line.
 */
async function checkDispatchHosts(config: OmpbotConfig, run: ProcessRunner): Promise<string[]> {
	const perHost = await Promise.all(
		Object.entries(config.dispatchHosts ?? {}).map(async ([key, host]) => {
			// config only warns about a control character in a host name; on a doctor line it must not start a new line.
			const name = escapeControl(key);
			const [result, integration] = await Promise.all([
				run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", host.ssh, "true"], {
					timeoutMs: DISPATCH_HOST_CHECK_MS,
				}),
				checkHerdrIntegration(herdrSshArgv(host.ssh, host.herdrBin ?? "herdr", ["integration", "status"]), run),
			]);
			const integrationLine = `${integration.ok ? "ok" : "fail"} herdr omp integration on ${name}: ${integration.detail}`;
			if (result.code === 0 && !result.timedOut) return [`ok dispatch host ${name}: ssh ${host.ssh}`, integrationLine];
			const reason = result.timedOut
				? "timed out"
				: firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.code}`;
			return [`fail dispatch host ${name}: ${reason} (warning only)`, integrationLine];
		}),
	);
	return perHost.flat();
}

/**
 * `herdr integration status` (one `<agent>: <state> (…)` line per agent): the `omp:` line must say `current`, or the
 * agent_status herdr reports for omp workers (blocked, idle…) never changes. A miss is a warning: the detail ends in
 * the install command and `(warning only)`.
 */
async function checkHerdrIntegration(cmd: string[], run: ProcessRunner): Promise<{ ok: boolean; detail: string }> {
	const result = await run(cmd, { timeoutMs: DISPATCH_HOST_CHECK_MS });
	const fix = "— herdr integration install omp (warning only)";
	if (result.code !== 0 || result.timedOut) {
		const reason = result.timedOut
			? "timed out"
			: firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.code}`;
		return { ok: false, detail: `integration status failed: ${reason} ${fix}` };
	}
	const omp = result.stdout
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.startsWith("omp:"));
	if (omp === undefined) return { ok: false, detail: `no omp line ${fix}` };
	// The extension path in the trailing parentheses is noise on a doctor line.
	const summary = omp.replace(/\s*\([/~][^)]*\)\s*$/, "");
	return /^omp:\s*current\b/.test(omp) ? { ok: true, detail: summary } : { ok: false, detail: `${summary} ${fix}` };
}

/** Local herdr (config `herdr` on): `<bin> --version` must answer; the line carries its first output line or why not. */
async function checkLocalHerdr(herdr: { bin?: string }, run: ProcessRunner): Promise<{ ok: boolean; line: string }> {
	const bin = herdr.bin ?? "herdr";
	const result = await run([bin, "--version"], { timeoutMs: DISPATCH_HOST_CHECK_MS });
	if (result.code === 0 && !result.timedOut)
		return { ok: true, line: `ok herdr: ${bin} ${firstLine(result.stdout)}`.trim() };
	const reason = result.timedOut
		? "timed out"
		: firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.code}`;
	return { ok: false, line: `fail herdr: ${bin} ${reason}` };
}

/**
 * `ompbot doctor`: the doctor checks, then (herdr on) the local herdr version and its omp integration, then per dispatch
 * host one reach line and one omp integration line. A host may be switched off on purpose (a laptop), so its lines are
 * warnings and never change the exit code; an unreadable config was reported above. A local herdr that does not answer
 * while `herdr` is on is a failure (exit 1): dispatch and the [TASK] sweep need it. A missing omp integration is a
 * warning everywhere: herdr still runs the agents, only their waiting state goes unseen.
 */
export async function doctorCommand(
	homeDir: string,
	write: (line: string) => void,
	deps: { doctor?: typeof runDoctor; run?: ProcessRunner } = {},
): Promise<number> {
	// This checkout (src/cli/index.ts → repo root) holds the daemon's code and any code rollback journal.
	const code = await (deps.doctor ?? runDoctor)(homeDir, write, resolve(import.meta.dir, "..", ".."));
	let config: OmpbotConfig | undefined;
	try {
		config = loadConfigIfPresent(homeDir);
	} catch {
		return code;
	}
	if (config === undefined) return code;
	const run = deps.run ?? realProcessRunner;
	let exit = code;
	if (config.herdr !== undefined) {
		const herdr = await checkLocalHerdr(config.herdr, run);
		write(herdr.line);
		if (!herdr.ok && exit === 0) exit = 1;
		const integration = await checkHerdrIntegration([config.herdr.bin ?? "herdr", "integration", "status"], run);
		write(`${integration.ok ? "ok" : "fail"} herdr omp integration: ${integration.detail}`);
	}
	for (const line of await checkDispatchHosts(config, run)) write(line);
	return exit;
}

/** Runs the off-site copy and prints its lines; 0 on success, 4 on any off-site failure. */
async function offsiteRun(config: OmpbotConfig, homeDir: string, json: boolean): Promise<number> {
	if (config.offsite === undefined) {
		process.stderr.write("offsite: config.json has no offsite {ssh, remoteDir} section\n");
		return 2;
	}
	let result: OffsiteResult;
	try {
		result = await runOffsite({ homeDir, target: config.offsite });
	} catch (error) {
		if (error instanceof OffsiteError) {
			process.stderr.write(`offsite failed: ${error.message}\n`);
			return 4;
		}
		throw error;
	}
	if (json) {
		process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
		return 0;
	}
	for (const file of result.files) {
		process.stdout.write(`offsite ${file.status} file=${file.name} sha256=${file.sha256}\n`);
	}
	for (const name of result.removed) process.stdout.write(`offsite pruned file=${name}\n`);
	process.stdout.write(
		`offsite_done files=${result.files.length} removed=${result.removed.length} stamp=${result.stamp}\n`,
	);
	return 0;
}

async function backupCommand(args: string[], homeDir: string): Promise<number> {
	const { values } = parseArgs({ args, options: { keep: { type: "string" }, "max-bundle-bytes": { type: "string" } } });
	let keep = DEFAULT_KEEP;
	if (values.keep !== undefined) {
		keep = /^\d+$/.test(values.keep) ? Number(values.keep) : Number.NaN;
		if (!Number.isSafeInteger(keep)) {
			process.stderr.write("backup: --keep must be a non-negative integer\n");
			return 2;
		}
	}
	let flagBytes: number | undefined;
	if (values["max-bundle-bytes"] !== undefined) {
		const raw = values["max-bundle-bytes"];
		const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
		if (!Number.isSafeInteger(parsed) || parsed < 1) {
			process.stderr.write("backup: --max-bundle-bytes must be a positive integer\n");
			return 2;
		}
		flagBytes = parsed;
	}
	// The operator lever for homes whose sessions outgrew the 512MB default: config sets it, the flag overrides.
	const config = loadConfigIfPresent(homeDir);
	const maxBundleBytes = flagBytes ?? config?.maxBundleBytes;
	let result: BackupResult;
	try {
		result = runBackup({ homeDir, keep, ...(maxBundleBytes === undefined ? {} : { maxBundleBytes }) });
	} catch (error) {
		if (error instanceof BackupError) {
			process.stderr.write(`backup failed: ${error.message}\n`);
			return 1;
		}
		throw error;
	}
	for (const path of result.removed) process.stdout.write(`backup pruned path=${path}\n`);
	process.stdout.write(
		`backup written file=${result.file} bytes=${result.bytes} sha256=${result.sha256} integrity=ok\n`,
	);
	if (result.bundle !== undefined) {
		process.stdout.write(
			`backup bundle file=${result.bundle} bytes=${result.bundleBytes} sha256=${result.bundleSha256}\n`,
		);
	}
	process.stdout.write(
		`backup_done kept=${result.kept.length} removed=${result.removed.length} stamp=${result.stamp}\n`,
	);
	return config?.offsite === undefined ? 0 : offsiteRun(config, homeDir, false);
}

/** Test seam of `ompbot gates`: the clock and the host readers `collectGates` would otherwise take from this machine. */
export type GatesCommandDeps = Pick<GatesOptions, "statfs" | "hostLoad"> & { now?: () => number };

/** The `OMPBOT_TEST_HOOKS=1` host readers as gates deps; none in production. */
function hostLoadDeps(env: Record<string, string | undefined>): GatesCommandDeps {
	const hostLoad = testHostLoad(env);
	return hostLoad === undefined ? {} : { hostLoad };
}

/** `ompbot gates`: exit 1 when a gate is open, or with `--strict` also when one cannot be judged (`unknown`). */
export function gatesCommand(args: string[], homeDir: string, deps: GatesCommandDeps = {}): number {
	const { values } = parseArgs({ args, options: { json: { type: "boolean" }, strict: { type: "boolean" } } });
	// A db-only home (no config.json) has no omp to check; the omp_runtime gate is then omitted.
	const config = loadConfigIfPresent(homeDir);
	const gates = collectGates({
		homeDir,
		now: (deps.now ?? Date.now)(),
		...gateOptionsFromConfig(config),
		...(deps.statfs === undefined ? {} : { statfs: deps.statfs }),
		...(deps.hostLoad === undefined ? {} : { hostLoad: deps.hostLoad }),
	});
	const open = gates.filter((gate) => gate.state === "open");
	const unknown = gates.filter((gate) => gate.state === "unknown");
	if (values.json === true) {
		process.stdout.write(`${JSON.stringify({ open: open.length, unknown: unknown.length, gates })}\n`);
	} else {
		for (const gate of gates) process.stdout.write(`gate=${gate.name} state=${gate.state} detail=${gate.detail}\n`);
		// Alerting tools show only the last line, so it names the open and the unjudgeable gates.
		const opened = open.map((gate) => `${gate.name}(${gate.detail})`).join(",");
		const unjudged = unknown.map((gate) => gate.name).join(",");
		process.stdout.write(
			`gates_done open=${open.length} unknown=${unknown.length} total=${gates.length}${opened ? ` opened=${opened}` : ""}${
				unjudged ? ` unknown_gates=${unjudged}` : ""
			}\n`,
		);
	}
	return open.length > 0 || (values.strict === true && unknown.length > 0) ? 1 : 0;
}

async function statusCommand(args: string[], homeDir: string, hostLoad?: Partial<HostLoadReader>): Promise<number> {
	const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
	const socketPath = join(homeDir, "ompbot.sock");
	let report: StatusReport | undefined;
	try {
		const response = await callDaemon(socketPath, { op: "status" }, 10_000);
		if (isStatusResponse(response)) report = response.status;
	} catch {
		report = undefined; // no daemon answering: fall back to the database file
	}
	if (!report) {
		const dbPath = join(homeDir, "ompbot.db");
		if (!existsSync(dbPath)) {
			process.stderr.write(`status: no daemon at ${socketPath} and no database at ${dbPath}\n`);
			return 1;
		}
		// The database is the report; a db-only (recovery) home or broken token files must not hide it.
		let config: ReturnType<typeof loadConfigIfPresent>;
		try {
			config = loadConfigIfPresent(homeDir, { checkTokens: false });
		} catch (error) {
			// A broken config.json hides nothing the ledger can say; `doctor` names the same cause.
			process.stderr.write(`status: config unreadable, version and gate settings unknown: ${String(error)}\n`);
			config = undefined;
		}
		report = readStatusFromDb(
			dbPath,
			config === undefined ? "unknown" : await readVersion([config.ompExecutable, "--version"]),
			config?.timezone ?? timezoneOfHome(homeDir),
			gateOptionsFromConfig(config),
			hostLoad,
		);
	}
	process.stdout.write(`${values.json ? JSON.stringify(report) : renderStatusText(report)}\n`);
	return 0;
}

function freezeCommand(args: string[], homeDir: string): number {
	const { values } = parseArgs({ args, options: { reason: { type: "string" } } });
	if (!existsSync(homeDir)) {
		process.stderr.write(`freeze: no home at ${homeDir}\n`);
		return 1;
	}
	const state = writeFreeze(homeDir, {
		...(values.reason === undefined ? {} : { reason: values.reason }),
		by: "cli",
		now: Date.now(),
	});
	process.stdout.write(
		`frozen since=${state.since} by=${state.by}${state.reason === "" ? "" : ` reason=${JSON.stringify(state.reason)}`}\n`,
	);
	return 0;
}

function unfreezeCommand(homeDir: string): number {
	const was = readFreeze(homeDir) !== undefined;
	clearFreeze(homeDir);
	process.stdout.write(was ? "unfrozen\n" : "not frozen\n");
	return 0;
}

async function injectCommand(args: string[], homeDir: string): Promise<number> {
	const { values } = parseArgs({
		args,
		options: {
			origin: { type: "string" },
			"as-owner": { type: "boolean" },
			text: { type: "string" },
			quoted: { type: "string" },
			thread: { type: "string" },
		},
	});
	if (!values["as-owner"] || values.origin === undefined || values.text === undefined) {
		process.stderr.write(`inject needs --origin, --as-owner and --text\n${USAGE}`);
		return 2;
	}
	// The daemon posts its marker before it judges the text: a blank text would leave an empty marker behind.
	if (values.text.trim() === "") {
		process.stderr.write("inject: --text is empty; give the message text\n");
		return 2;
	}
	let response: unknown;
	try {
		response = await callDaemon(join(homeDir, "ompbot.sock"), {
			op: "inject",
			origin: values.origin,
			asOwner: true,
			text: values.text,
			quoted: values.quoted,
			thread: values.thread,
		});
	} catch (error) {
		process.stderr.write(`inject: daemon not reachable (${error instanceof Error ? error.message : String(error)})\n`);
		return 1;
	}
	if (
		typeof response === "object" &&
		response !== null &&
		"ok" in response &&
		response.ok === true &&
		"nonce" in response &&
		"threadRef" in response
	) {
		process.stdout.write(`${JSON.stringify({ nonce: response.nonce, threadRef: response.threadRef })}\n`);
		return 0;
	}
	const reason =
		typeof response === "object" && response !== null && "error" in response ? String(response.error) : "unknown";
	process.stderr.write(`inject failed: ${reason}\n`);
	return 1;
}

/** `ompbot reload`: the running daemon re-reads config.json (same as SIGHUP); exit 1 when it kept the old config. */
async function reloadCommand(homeDir: string): Promise<number> {
	let response: ReloadResult;
	try {
		response = (await callDaemon(join(homeDir, "ompbot.sock"), { op: "reload" }, 10_000)) as ReloadResult;
	} catch (error) {
		process.stderr.write(`reload: daemon not reachable (${error instanceof Error ? error.message : String(error)})\n`);
		return 1;
	}
	if (response.ok !== true) {
		process.stderr.write(`reload failed, config unchanged: ${response.error}\n`);
		return 1;
	}
	const list = (fields: string[]) => (fields.length === 0 ? "-" : fields.join(","));
	process.stdout.write(
		`config_reloaded changed=${list(response.changed)} restart_required=${list(response.restartRequired)} cli=${list(response.cli)}\n`,
	);
	return 0;
}

/** Entry point of `ompbot`; resolves with the process exit code. */
export async function runCli(argv: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
	const [command, ...rest] = argv;
	const homeDir = resolve(defaultHomeDir(env));
	try {
		switch (command) {
			case "init":
				return initCommand(rest, env);
			case "units":
				return unitsCommand(rest, env);
			case "daemon": {
				// Read right before loadConfig validates it: only this text may become config.json.last-good at ready.
				const bootConfigText = readConfigText(homeDir);
				return await runDaemon(loadConfig(homeDir), env, bootConfigText);
			}
			case "status":
				return await statusCommand(rest, homeDir, testHostLoad(env));
			case "doctor":
				return await doctorCommand(homeDir, (line) => process.stdout.write(`${line}\n`));
			case "gc":
				return gcCommand(rest, homeDir);
			case "backup":
				return await backupCommand(rest, homeDir);
			case "freeze":
				return freezeCommand(rest, homeDir);
			case "unfreeze":
				return unfreezeCommand(homeDir);
			case "gates":
				return gatesCommand(rest, homeDir, hostLoadDeps(env));
			case "inject":
				return await injectCommand(rest, homeDir);
			case "drain":
				return await drainCommand(rest, homeDir);
			case "apply":
				return await applyCommand(rest, homeDir, env);
			case "omp":
				return await ompCommand(rest, homeDir, env);
			case "restore":
				return await restoreCommand(rest, homeDir);
			case "reload":
				return await reloadCommand(homeDir);
			case "monitors":
				return await monitorsCommand(rest, homeDir);
			case "tasks":
				return await tasksCommand(rest, homeDir);
			case "lanes":
				return await lanesCommand(rest, homeDir);
			case "skills":
				return skillsCommand(rest, env);
			case "dashboard":
				return await dashboardCommand(rest, homeDir);
			case "teams":
				return await teamsCommand(rest, homeDir);
			default:
				process.stderr.write(USAGE);
				return command === undefined || command === "--help" || command === "help" ? 0 : 2;
		}
	} catch (error) {
		// node:util parseArgs (unknown option, missing value, `--days -1`): an argument mistake, so a usage error.
		if (isParseArgsError(error)) {
			process.stderr.write(`${command}: ${error.message.replace(/\s*\n\s*/g, " ")} (ompbot --help)\n`);
			return 2;
		}
		process.stderr.write(`${command}: ${error instanceof ConfigError ? error.message : String(error)}\n`);
		return 1;
	}
}

function isParseArgsError(error: unknown): error is Error {
	return error instanceof Error && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS_");
}
