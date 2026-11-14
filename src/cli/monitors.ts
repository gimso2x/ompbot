import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { oneLine } from "../channel/text";
import { loadConfig, type OmpbotConfig } from "../config";
import {
	describeMonitorTrigger,
	type MonitorLedger,
	type MonitorRow,
	monitorOptionSuffixes,
	nextFireOf,
	openMonitorLedger,
} from "../monitors/ledger";
import { applyMonitors, exportMonitors, PortableApplyError, type PortableContext } from "../monitors/portable";
import { runScript } from "../monitors/script";
import { MonitorSpecError, mergeMonitorSpec, parseMonitorSpec } from "../monitors/spec";
import { webhookUrl } from "../monitors/webhook";
import { readFreeze } from "../ops/freeze";
import { formatLocal, hostTimezone } from "../time";

export const MONITORS_USAGE = `  monitors add --json <spec>     create a monitor ({name, trigger (cron|at|script|watcher|webhook; a cron with command [+timeoutMs] runs that script per slot and needs deliver "verbatim"), instruction, overlap?, enabled?, channel?, copyChannel?, model?, thinking?, deliver?, procedureFiles? (<=5 files in the workspace or scripts dir, re-read on every fire)}; trigger webhook needs "webhook" in config.json
  monitors list [--json]         monitors with effective time zone and next fire
  monitors update <id|name> --json <patch>   change fields (a new trigger restarts its schedule)
  monitors show <id|name>        one monitor as JSON; a webhook monitor also prints its URL and bearer token
  monitors remove <id|name>      delete a monitor with its slots and events
  monitors test <id|name>        fire once now (a script monitor runs its check first; a watcher monitor fires with no payload)
  monitors export --dir <d> [--with-files]   write one portable <name>.json per monitor (paths as @SCRIPTS@/ and @WORKSPACE@/, no ids or webhook tokens) and delete stale *.json there; --with-files also copies the referenced scripts and procedure files to <d>/files/
  monitors apply --dir <d> [--prune] [--dry-run]   add or update monitors from <d>/*.json by name (equal ones untouched); --prune removes monitors without a file; any invalid file changes nothing (exit 2)
`;

interface Schedule {
	effectiveTimezone: string;
	nextFireAt: string | null;
}

function scheduleOf(row: MonitorRow, timezone: string): Schedule {
	const next = nextFireOf(row);
	return {
		effectiveTimezone: row.trigger.kind === "cron" ? row.trigger.timezone : timezone,
		nextFireAt: next === null ? null : new Date(next).toISOString(),
	};
}

function parseJson(text: string | undefined, what: string): unknown {
	if (text === undefined) throw new MonitorSpecError(`${what} needs --json <object>`);
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new MonitorSpecError(`--json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function describe(row: MonitorRow, schedule: Schedule): string {
	const next =
		schedule.nextFireAt === null
			? "-"
			: `${formatLocal(Date.parse(schedule.nextFireAt), schedule.effectiveTimezone)} ${schedule.effectiveTimezone}`;
	// The last script check or watch error, with how many came in a row (cleared by the next good check).
	const checkError =
		row.lastCheckError === null || row.lastCheckErrorAt === null
			? ""
			: `  checkError(x${row.checkErrorStreak})=${oneLine(row.lastCheckError, 120)} @ ${formatLocal(row.lastCheckErrorAt, schedule.effectiveTimezone)} ${schedule.effectiveTimezone}`;
	// The CLI keeps an `at` trigger's stored ISO string raw and separates fields with two spaces; the trigger text and
	// option suffixes come from the shared ledger helpers (the host tool uses the same rules with its own parameters).
	return `${row.id}  ${row.enabled ? "on " : "off"}  ${row.name}  [${describeMonitorTrigger(row, (at) => at)}]  overlap=${row.overlap}${monitorOptionSuffixes(row, "  ")}${row.deliver === "verbatim" ? "  deliver=verbatim" : ""}  next=${next}${checkError}`;
}

/** A row for output without the webhook bearer token (only `add` and `show` print it). */
function masked(row: MonitorRow): MonitorRow {
	return row.trigger.kind === "webhook" ? { ...row, trigger: { ...row.trigger, token: "***" } } : row;
}

function need(ledger: MonitorLedger, idOrName: string | undefined): MonitorRow {
	if (idOrName === undefined) throw new MonitorSpecError("monitor id or name required");
	const row = ledger.getMonitor(idOrName);
	if (!row) throw new MonitorSpecError(`monitor not found: ${idOrName}`);
	return row;
}

/** The config the checks below validate against; a home without a usable config (missing, broken, wrong
 * permissions) has none and the ledger commands still work there. */
function configOf(homeDir: string): OmpbotConfig | undefined {
	try {
		return loadConfig(homeDir);
	} catch {
		return undefined;
	}
}

/** `monitors export|apply`: portable monitor files for an instance repository. Usage errors and invalid files exit 2. */
function portableCommand(sub: "export" | "apply", args: string[], homeDir: string, ctx: PortableContext): number {
	let values: { dir?: string; "with-files"?: boolean; prune?: boolean; "dry-run"?: boolean };
	try {
		({ values } = parseArgs({
			args,
			options:
				sub === "export"
					? { dir: { type: "string" }, "with-files": { type: "boolean" } }
					: { dir: { type: "string" }, prune: { type: "boolean" }, "dry-run": { type: "boolean" } },
		}));
	} catch (error) {
		process.stderr.write(
			`monitors ${sub}: ${error instanceof Error ? error.message : String(error)}\n${MONITORS_USAGE}`,
		);
		return 2;
	}
	if (values.dir === undefined || values.dir === "") {
		process.stderr.write(`monitors ${sub}: --dir <dir> is required\n${MONITORS_USAGE}`);
		return 2;
	}
	const dir = resolve(values.dir);
	const ledger = openMonitorLedger(join(homeDir, "ompbot.db"));
	try {
		if (sub === "export") {
			const result = exportMonitors(ledger, dir, ctx, { withFiles: values["with-files"] === true });
			for (const warning of result.warnings) process.stderr.write(`monitors export: warning: ${warning}\n`);
			process.stdout.write(`exported=${result.written} removed=${result.removed}\n`);
			return 0;
		}
		const result = applyMonitors(ledger, dir, ctx, {
			prune: values.prune === true,
			dryRun: values["dry-run"] === true,
		});
		for (const warning of result.warnings) process.stderr.write(`monitors apply: warning: ${warning}\n`);
		process.stdout.write(
			`added=${result.added} updated=${result.updated} unchanged=${result.unchanged} removed=${result.removed}\n`,
		);
		return 0;
	} catch (error) {
		if (!(error instanceof PortableApplyError)) throw error;
		for (const problem of error.problems) process.stderr.write(`monitors apply: ${problem}\n`);
		process.stderr.write(`monitors apply: ${error.message}; nothing was changed\n`);
		return 2;
	} finally {
		ledger.close();
	}
}

/** `ompbot monitors ...` against the ledger file directly; the running daemon picks changes up on its next sweep. */
export async function monitorsCommand(args: string[], homeDir: string): Promise<number> {
	const [sub, ...rest] = args;
	const scriptsRoot = join(homeDir, "scripts");
	const config = configOf(homeDir);
	// The sweep runs script checks with cwd = config.workspaceDir (monitors/scheduler.ts); `test` must verify the same
	// conditions, so a home without a usable config falls back to the home itself.
	const workspaceDir = config?.workspaceDir ?? homeDir;
	const ctx = {
		scriptsRoot,
		watcherRoots: config?.watcherRoots,
		workspaceDir,
		webhook: config?.webhook,
		// A home without a usable config takes the zone a config without `timezone` gets.
		defaultTimezone: config?.timezone ?? hostTimezone(),
		slackOff: config !== undefined && config.channels.slack === undefined,
	};
	if (sub === "export" || sub === "apply") return portableCommand(sub, rest, homeDir, ctx);
	if (sub !== "add" && sub !== "list" && sub !== "show" && sub !== "update" && sub !== "remove" && sub !== "test") {
		process.stderr.write(`usage: ompbot monitors <add|list|show|update|remove|test|export|apply>\n${MONITORS_USAGE}`);
		return 2;
	}
	// `list --json` is a flag, every other subcommand takes the JSON text.
	const listJson = sub === "list" && rest.includes("--json");
	const { values, positionals } = parseArgs({
		args: sub === "list" ? rest.filter((arg) => arg !== "--json") : rest,
		allowPositionals: true,
		options: { json: { type: "string" } },
	});
	const ledger = openMonitorLedger(join(homeDir, "ompbot.db"));
	try {
		const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
		if (sub === "add") {
			const row = ledger.addMonitor(parseMonitorSpec(parseJson(values.json, "monitors add"), ctx));
			out({ monitor: row, schedule: scheduleOf(row, ctx.defaultTimezone) });
			return 0;
		}
		if (sub === "list") {
			const monitors = ledger.listMonitors();
			const schedules = Object.fromEntries(monitors.map((row) => [row.id, scheduleOf(row, ctx.defaultTimezone)]));
			if (listJson) out({ monitors: monitors.map(masked), schedules });
			else if (monitors.length === 0) process.stdout.write("no monitors\n");
			else for (const row of monitors) process.stdout.write(`${describe(row, schedules[row.id] as Schedule)}\n`);
			return 0;
		}
		const row = need(ledger, positionals[0]);
		if (sub === "show") {
			const { trigger } = row;
			out({
				monitor: row,
				schedule: scheduleOf(row, ctx.defaultTimezone),
				...(trigger.kind === "webhook"
					? { webhook: { url: webhookUrl(config?.webhook, trigger.id), token: trigger.token } }
					: {}),
			});
			return 0;
		}
		if (sub === "update") {
			const current = {
				name: row.name,
				trigger: row.trigger,
				instruction: row.instruction,
				overlap: row.overlap,
				enabled: row.enabled,
				...(row.channel === null ? {} : { channel: row.channel }),
				...(row.copyChannel === null ? {} : { copyChannel: row.copyChannel }),
				...(row.model === null ? {} : { model: row.model }),
				...(row.thinking === null ? {} : { thinking: row.thinking }),
				deliver: row.deliver,
				...(row.procedureFiles.length === 0 ? {} : { procedureFiles: row.procedureFiles }),
			};
			const next = mergeMonitorSpec(current, parseJson(values.json, "monitors update"), ctx);
			const updated = ledger.updateMonitor(row.id, next);
			out({ monitor: masked(updated), schedule: scheduleOf(updated, ctx.defaultTimezone) });
			return 0;
		}
		if (sub === "remove") {
			out({ removed: ledger.removeMonitor(row.id), id: row.id });
			return 0;
		}
		let payload: string | undefined;
		if (row.trigger.kind === "script") {
			const result = await runScript(row.trigger.command, {
				scriptsRoot,
				cwd: workspaceDir,
				monitorId: row.id,
				homeDir,
			});
			if (!result.fired) {
				out({
					fired: false,
					exitCode: result.exitCode,
					timedOut: result.timedOut,
					...(result.error ? { error: result.error } : {}),
					...(result.stderr ? { stderr: result.stderr } : {}),
				});
				return 1;
			}
			payload = result.stdout;
		}
		const event = ledger.admitManual(row.id, payload);
		// While frozen the daemon skips this event instead of prompting it; say so (the exit code stays 0).
		out({
			fired: true,
			eventId: event.eventId,
			stage: event.stage,
			...(readFreeze(homeDir) === undefined ? {} : { frozen: true }),
		});
		return 0;
	} catch (error) {
		if (!(error instanceof MonitorSpecError)) throw error;
		process.stderr.write(`monitors ${sub}: ${error.message}\n`);
		return 1;
	} finally {
		ledger.close();
	}
}
