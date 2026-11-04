import { parseChatOrigin } from "../core/origin-key";
import type { Logger } from "../log";
import type { HostToolDef } from "../safety/host-tools";
import { DEFAULT_TIMEZONE, formatLocal } from "./cron";
import {
	describeMonitorTrigger,
	type MonitorLedger,
	type MonitorRow,
	monitorOptionSuffixes,
	nextFireOf,
} from "./ledger";
import { MonitorSpecError, parseMonitorSpec } from "./spec";
import { webhookUrl } from "./webhook";

/** Only the owner-DM persona session registers monitors; monitor and lane sessions never get these tools. */
export const isPersonaOrigin = (originKey: string): boolean => {
	const ref = parseChatOrigin(originKey);
	return ref?.kind === "dm" && ref.threadId === undefined;
};

export interface MonitorToolDeps {
	originKey: string;
	ledger: MonitorLedger;
	/** `<home>/scripts`: the only place a script trigger may point to. */
	scriptsRoot: string;
	/** `config.watcherRoots`: where a watcher trigger's root may point. */
	watcherRoots?: readonly string[] | undefined;
	/** `config.workspaceDir`: besides the scripts dir, procedure files may live here. */
	workspaceDir?: string | undefined;
	/** `config.webhook`: without it webhook triggers are refused. */
	webhook?: { port: number; bind?: string } | undefined;
	log: Logger;
}

function describeNext(row: MonitorRow): string {
	const next = nextFireOf(row);
	return next === null ? "none" : `${formatLocal(next, DEFAULT_TIMEZONE)} ${DEFAULT_TIMEZONE}`;
}

/** An `at` trigger's stored ISO instant rendered as Asia/Seoul wall clock; the CLI keeps the stored string raw. */
const atInSeoul = (at: string): string => `${formatLocal(Date.parse(at), DEFAULT_TIMEZONE)} ${DEFAULT_TIMEZONE}`;

function describeRow(row: MonitorRow): string {
	return `${row.id} ${row.enabled ? "on" : "off"} "${row.name}" [${describeMonitorTrigger(row, atInSeoul)}] overlap=${row.overlap}${monitorOptionSuffixes(row, " ")} deliver=${row.deliver} next=${describeNext(row)}`;
}

/** A model sometimes passes the trigger object as JSON text. */
function spec(params: Record<string, unknown>): Record<string, unknown> {
	const { trigger } = params;
	if (typeof trigger !== "string") return params;
	try {
		return { ...params, trigger: JSON.parse(trigger) };
	} catch {
		throw new MonitorSpecError("trigger must be an object like {kind:'at', at:'2026-01-01T09:00:00+09:00'}");
	}
}

/** `ompbot_monitor_add/list/remove`; empty for any origin that is not an owner-DM persona session. */
export function buildMonitorTools(deps: MonitorToolDeps): HostToolDef[] {
	if (!isPersonaOrigin(deps.originKey)) return [];
	const { ledger, scriptsRoot, watcherRoots, workspaceDir, webhook, log, originKey } = deps;
	return [
		{
			name: "ompbot_monitor_add",
			label: "Add monitor",
			description:
				"Register a monitor: at the given time(s) the bot runs `instruction` in its own session and posts the result to the owner DM as a top-level message starting with ⏰. Use it for '알려줘', '매일 …', '…되면 알려줘' requests. trigger is one of {kind:'at', at:<ISO time, Asia/Seoul unless an offset is given>} (once), {kind:'cron', schedule:<5 fields>, timezone?:<default Asia/Seoul>} (recurring), {kind:'script', command:[<absolute path under the bot scripts dir>, ...args], intervalMs:>=60000, fire?:'edge'|'every', once?:boolean} (the script exits 0 while the condition holds; its stdout is passed to the run), {kind:'webhook'} (runs when an external system POSTs to the loopback URL returned on creation with the returned bearer token; the request body, cut to 16 KiB, is passed to the run as untrusted outside input; needs webhook in the bot config), {kind:'watcher', root:<absolute directory inside the configured watcherRoots>, debounceMs?:100-60000, default 1000} (runs when files under root changed and stayed quiet for debounceMs; the changed paths are passed to the run; .git is ignored; needs watcherRoots in the bot config). For a script trigger, by default (fire:'edge') it fires once when the condition turns true and re-arms only after the script has failed again; fire:'every' fires on every check that passes. Set once:true for a one-off watch so the monitor turns itself off after its first fire. Compute `at` from the current time in Asia/Seoul (check with `date`). Returns the monitor id and the next fire time (Asia/Seoul).",
			parameters: {
				type: "object",
				properties: {
					name: { type: "string", description: "Unique short name" },
					trigger: {
						type: "object",
						description: "{kind:'at'|'cron'|'script'|'watcher'|'webhook', ...} as described",
						properties: {
							kind: { type: "string", enum: ["at", "cron", "script", "watcher", "webhook"] },
							at: { type: "string", description: "kind=at: ISO time, e.g. 2026-10-19T15:04:00+09:00" },
							schedule: { type: "string", description: "kind=cron: 5-field cron, e.g. 0 9 * * *" },
							timezone: { type: "string", description: "IANA zone; default Asia/Seoul" },
							command: { type: "array", items: { type: "string" }, description: "kind=script: argv" },
							intervalMs: { type: "number", description: "kind=script: check interval, at least 60000" },
							fire: {
								type: "string",
								enum: ["edge", "every"],
								description:
									"kind=script: edge (default) fires once when the check turns met (exit 0) and re-arms after it fails; every fires on every met check",
							},
							root: {
								type: "string",
								description:
									"kind=watcher: absolute directory to watch recursively (.git ignored); must be inside the configured watcherRoots",
							},
							debounceMs: {
								type: "number",
								description: "kind=watcher: quiet time after the last change before the run, 100-60000; default 1000",
							},
							once: {
								type: "boolean",
								description:
									"kind=script: disable the monitor after its first fire; set true for one-off '…되면 알려줘' watches",
							},
						},
						required: ["kind"],
					},
					instruction: {
						type: "string",
						description:
							"What the monitor session must do and say when it fires (max 4000 chars). Answer exactly NO_REPORT to stay silent.",
					},
					overlap: {
						type: "string",
						enum: ["skip", "queue"],
						description: "When a run is still active; default queue",
					},
					channel: {
						type: "string",
						description:
							"Slack channel id (C…/G…) to post the result into as one top-level thread instead of the owner DM; the answer may mention the owner as <@U…>",
					},
					copyChannel: {
						type: "string",
						description:
							"Slack channel id (C…/G…) that also gets a top-level copy of every run's result, including runs that stayed silent; the primary delivery is unchanged",
					},
					model: {
						type: "string",
						description:
							"omp model id (provider/id, e.g. anthropic/claude-opus-5-5) this monitor's session always runs on; omit to use the default",
					},
					thinking: {
						type: "string",
						enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
						description: "Thinking level this monitor's session always runs with; omit to use the default",
					},
					procedureFiles: {
						type: "array",
						items: { type: "string" },
						description:
							"Up to 5 file paths (absolute, or relative to the bot workspace; inside the workspace or the bot scripts dir) whose current content is appended to the prompt of every run — put a long procedure in a file instead of the 4000-char instruction",
					},
					deliver: {
						type: "string",
						enum: ["turn", "verbatim"],
						description:
							"turn (default) runs a session on every fire; verbatim (script trigger only) posts the script's stdout as the result word for word without running a session, so instruction/model/thinking are not used",
					},
				},
				required: ["name", "trigger", "instruction"],
				additionalProperties: false,
			},
			async execute(params) {
				const parsed = parseMonitorSpec(spec(params), { scriptsRoot, watcherRoots, workspaceDir, webhook });
				let row: MonitorRow;
				try {
					row = ledger.addMonitor(parsed);
				} catch (error) {
					if (error instanceof Error && /UNIQUE/.test(error.message)) {
						throw new MonitorSpecError(`a monitor named "${parsed.name}" already exists`);
					}
					throw error;
				}
				log.info("monitor_added", { origin: originKey, id: row.id, name: row.name, kind: row.trigger.kind });
				if (row.trigger.kind === "webhook") {
					// The only time the token is shown to the model; the list tool never repeats it.
					const url = webhookUrl(webhook, row.trigger.id);
					return `monitor ${row.id} "${row.name}" created; POST ${url} with header "Authorization: Bearer ${row.trigger.token}" (token is shown only now; owner can read it with \`ompbot monitors show\`)`;
				}
				return `monitor ${row.id} "${row.name}" created; next fire ${describeNext(row)}`;
			},
		},
		{
			name: "ompbot_monitor_list",
			label: "List monitors",
			description: "List the registered monitors with trigger and next fire time (Asia/Seoul).",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			async execute() {
				const rows = ledger.listMonitors();
				return rows.length === 0 ? "no monitors" : rows.map(describeRow).join("\n");
			},
		},
		{
			name: "ompbot_monitor_remove",
			label: "Remove monitor",
			description: "Delete a monitor (with its history) by id or name.",
			parameters: {
				type: "object",
				properties: {
					id: { type: "string", description: "Monitor id" },
					name: { type: "string", description: "Monitor name" },
				},
				additionalProperties: false,
			},
			async execute(params) {
				const key = typeof params.id === "string" && params.id !== "" ? params.id : params.name;
				if (typeof key !== "string" || key === "") throw new MonitorSpecError("id or name is required");
				const row = ledger.getMonitor(key);
				if (!row) throw new MonitorSpecError(`monitor not found: ${key}`);
				ledger.removeMonitor(row.id);
				log.info("monitor_removed", { origin: originKey, id: row.id, name: row.name });
				return `monitor ${row.id} "${row.name}" removed`;
			},
		},
	];
}
