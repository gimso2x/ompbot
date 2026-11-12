import { randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { assertTimezone, CronError, parseCron, zonedToUtc } from "./cron";

export const MAX_INSTRUCTION_CHARS = 4000;
export const MAX_NAME_CHARS = 80;
export const MIN_SCRIPT_INTERVAL_MS = 60_000;
/** One leap year: past it a next fire time soon leaves what a `Date` can hold. */
export const MAX_SCRIPT_INTERVAL_MS = 366 * 24 * 60 * 60 * 1000;
export const SCRIPT_TIMEOUT_MS = 60_000;
export const MIN_WATCHER_DEBOUNCE_MS = 100;
export const MAX_WATCHER_DEBOUNCE_MS = 60_000;
export const DEFAULT_WATCHER_DEBOUNCE_MS = 1000;
export const MAX_PROCEDURE_FILES = 5;
/** All procedure files of one fire together; the rest is cut and marked as truncated in the prompt. */
export const MAX_PROCEDURE_BYTES = 64 * 1024;

export type ScriptFire = "edge" | "every";

export type MonitorOverlap = "skip" | "queue";

export type MonitorTrigger =
	| { kind: "cron"; schedule: string; timezone: string }
	/** `at` is the normalized UTC ISO instant. */
	| { kind: "at"; at: string }
	/**
	 * `fire`: `edge` (default) fires when the check turns met (exit 0) after not being met; `every` fires on every met
	 * check. `once` disables the monitor after its first fire. Rows stored before these fields exist read as edge/false.
	 * `suppressUnchanged`: with the agent call budgeted like hermes monitor mode, a met check whose stdout hashes
	 * identical to the previous met check is recorded as skipped (`no_change`) instead of waking the agent.
	 */
	| {
			kind: "script";
			command: string[];
			intervalMs: number;
			fire?: ScriptFire;
			once?: boolean;
			suppressUnchanged?: boolean;
	  }
	/**
	 * Fires once changes under `root` (a recursive watch; `.git/` ignored) have been quiet for `debounceMs`; the payload
	 * lists the changed relative paths. `root` is stored as the owner wrote it and re-checked against `watcherRoots`.
	 */
	| { kind: "watcher"; root: string; debounceMs: number }
	/**
	 * Fires when something POSTs to `/hook/<id>` on the loopback webhook listener with `Authorization: Bearer <token>`;
	 * the body becomes the event payload. `id` (128 bit) and `token` (256 bit) are generated when the monitor is
	 * created and kept when the trigger is edited.
	 */
	| { kind: "webhook"; id: string; token: string };

export interface MonitorSpec {
	name: string;
	trigger: MonitorTrigger;
	instruction: string;
	overlap: MonitorOverlap;
	enabled: boolean;
	/** Slack or Discord channel id the answer is posted into as one top-level thread; absent = the owner DM. */
	channel?: string;
	/** Slack or Discord channel id that also gets a top-level copy of every settled event (delivered or silent); absent = none. */
	copyChannel?: string;
	/** omp model id (`provider/id`) this monitor's session is pinned to; absent = the global default / origin choice. */
	model?: string;
	/** omp thinking level this monitor's session is pinned to; absent = the global default / origin choice. */
	thinking?: MonitorThinking;
	/**
	 * `turn` (default): every fire runs an omp turn. `verbatim` (script triggers only): the fired payload is posted as
	 * the answer without a turn; `instruction`, `model` and `thinking` are kept but unused. Absent = `turn`.
	 */
	deliver?: MonitorDeliver;
	/**
	 * Up to 5 files (inside workspaceDir or the scripts root) whose current content is appended to every fire's prompt,
	 * so a long procedure lives on disk instead of in the 4000-character instruction. Absent = none.
	 */
	procedureFiles?: string[];
}

export type MonitorDeliver = "turn" | "verbatim";

export class MonitorSpecError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MonitorSpecError";
	}
}

export interface SpecContext {
	/** `<home>/scripts`: script commands must resolve inside it. */
	scriptsRoot: string;
	/** `config.watcherRoots` (absolute): a watcher trigger's root must resolve inside one of them. */
	watcherRoots?: readonly string[] | undefined;
	/** `config.workspaceDir`: besides the scripts root, a procedure file may live here. */
	workspaceDir?: string | undefined;
	/** `config.webhook`: without it a webhook trigger cannot be created. */
	webhook?: { port: number; bind?: string } | undefined;
	/** `config.timezone`: a cron without `timezone` is stored with it, an `at` without an offset is read in it. */
	defaultTimezone: string;
	/** `config.channels.slack` absent: a Slack channel id names nothing the bot can post to, so it is refused. */
	slackOff?: boolean | undefined;
}

const SPEC_KEYS = [
	"name",
	"trigger",
	"instruction",
	"overlap",
	"enabled",
	"channel",
	"copyChannel",
	"model",
	"thinking",
	"deliver",
	"procedureFiles",
];
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type MonitorThinking = (typeof THINKING_LEVELS)[number];
const MODEL_ID = /^\S+\/\S+$/;
const CHANNEL_ID = /^[CG][A-Z0-9]{8,}$/;
/** A Discord channel or DM id (snowflake), the grammar `config.ts` takes for Discord ids. */
const DISCORD_CHANNEL_ID = /^[0-9]{17,20}$/;
const isChannelId = (value: unknown): value is string =>
	typeof value === "string" && (CHANNEL_ID.test(value) || DISCORD_CHANNEL_ID.test(value));

function record(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new MonitorSpecError(`${what} must be an object`);
	}
	return value as Record<string, unknown>;
}

function rejectUnknown(obj: Record<string, unknown>, allowed: readonly string[], what: string): void {
	for (const key of Object.keys(obj)) {
		if (!allowed.includes(key)) throw new MonitorSpecError(`${what}: unknown field "${key}"`);
	}
}

const ISO_LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const ISO_WITH_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** ISO instant to epoch ms. A value without an offset is wall-clock time in `timezone`. */
export function parseAt(text: string, timezone: string): number {
	const trimmed = text.trim();
	let ms: number;
	if (ISO_WITH_OFFSET.test(trimmed)) {
		ms = Date.parse(trimmed);
	} else {
		const m = ISO_LOCAL.exec(trimmed);
		if (!m) throw new MonitorSpecError(`trigger.at is not an ISO time: "${text}"`);
		try {
			assertTimezone(timezone);
		} catch (error) {
			throw new MonitorSpecError(error instanceof CronError ? error.message : String(error));
		}
		ms = zonedToUtc(
			{
				year: Number(m[1]),
				month: Number(m[2]),
				day: Number(m[3]),
				hour: Number(m[4]),
				minute: Number(m[5]),
				second: Number(m[6] ?? 0),
				ms: Number((m[7] ?? "0").padEnd(3, "0")),
			},
			timezone,
		);
	}
	if (!Number.isFinite(ms)) throw new MonitorSpecError(`trigger.at is not an ISO time: "${text}"`);
	return ms;
}

/** Resolves `command[0]` and proves it is an executable regular file under the scripts root (symlinks resolved). */
export function resolveScript(command: readonly string[], scriptsRoot: string): string {
	const first = command[0];
	if (first === undefined || !isAbsolute(first))
		throw new MonitorSpecError("script command[0] must be an absolute path");
	let root: string;
	let real: string;
	try {
		root = realpathSync(scriptsRoot);
	} catch {
		throw new MonitorSpecError(`scripts directory does not exist: ${scriptsRoot}`);
	}
	try {
		real = realpathSync(first);
	} catch {
		throw new MonitorSpecError(`script not found: ${first}`);
	}
	if (!real.startsWith(root.endsWith(sep) ? root : root + sep)) {
		throw new MonitorSpecError(`script must live under ${scriptsRoot}: ${first}`);
	}
	const stat = statSync(real);
	if (!stat.isFile() || (stat.mode & 0o111) === 0)
		throw new MonitorSpecError(`script is not an executable file: ${first}`);
	return real;
}

const under = (root: string, path: string): boolean =>
	path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Proves `root` is an absolute existing directory whose realpath lies inside one of `watcherRoots` (realpaths), and
 * returns that realpath. Used at spec time and again by the scheduler before every watch start.
 */
export function resolveWatchRoot(root: string, watcherRoots: readonly string[] | undefined): string {
	if (!isAbsolute(root)) throw new MonitorSpecError("trigger.root must be an absolute path");
	if (watcherRoots === undefined || watcherRoots.length === 0) {
		throw new MonitorSpecError(
			"watcher triggers are disabled: set watcherRoots in config.json to the allowed directories",
		);
	}
	let real: string;
	try {
		real = realpathSync(root);
		if (!statSync(real).isDirectory()) throw new Error("not a directory");
	} catch {
		throw new MonitorSpecError(`trigger.root is not an existing directory: ${root}`);
	}
	const allowed = watcherRoots.flatMap((r) => {
		try {
			return [realpathSync(r)];
		} catch {
			return [];
		}
	});
	if (!allowed.some((r) => under(r, real))) {
		throw new MonitorSpecError(`trigger.root must live under one of watcherRoots: ${root}`);
	}
	return real;
}

/** The directories a procedure file may live in (realpaths of the ones that exist). */
function procedureRoots(workspaceDir: string | undefined, scriptsRoot: string): string[] {
	return [workspaceDir, scriptsRoot].flatMap((root) => {
		if (root === undefined) return [];
		try {
			return [realpathSync(root)];
		} catch {
			return [];
		}
	});
}

/**
 * Resolves a procedure file (relative paths are relative to `workspaceDir`) and proves it is a regular file whose
 * realpath lies inside workspaceDir or the scripts root. Runs at spec time and again before every fire.
 */
export function resolveProcedureFile(path: string, workspaceDir: string | undefined, scriptsRoot: string): string {
	const absolute = isAbsolute(path) ? path : workspaceDir === undefined ? undefined : resolve(workspaceDir, path);
	if (absolute === undefined) throw new MonitorSpecError(`procedure file must be an absolute path: ${path}`);
	let real: string;
	try {
		real = realpathSync(absolute);
	} catch {
		throw new MonitorSpecError(`procedure file not found: ${path}`);
	}
	if (!procedureRoots(workspaceDir, scriptsRoot).some((root) => under(root, real))) {
		throw new MonitorSpecError(`procedure file must live under the workspace or ${scriptsRoot}: ${path}`);
	}
	if (!statSync(real).isFile()) throw new MonitorSpecError(`procedure file is not a regular file: ${path}`);
	return real;
}

function parseProcedureFiles(value: unknown, ctx: SpecContext): string[] {
	if (
		!Array.isArray(value) ||
		value.some((item) => typeof item !== "string" || item.trim() === "") ||
		value.length > MAX_PROCEDURE_FILES
	) {
		throw new MonitorSpecError(`procedureFiles must be an array of at most ${MAX_PROCEDURE_FILES} file paths`);
	}
	for (const path of value as string[]) resolveProcedureFile(path, ctx.workspaceDir, ctx.scriptsRoot);
	return value as string[];
}

function parseTrigger(raw: unknown, ctx: SpecContext, base?: MonitorTrigger): MonitorTrigger {
	const obj = record(raw, "trigger");
	const kind = obj.kind ?? base?.kind;
	if (kind === "cron") {
		rejectUnknown(obj, ["kind", "schedule", "timezone"], "trigger");
		const prev = base?.kind === "cron" ? base : undefined;
		const schedule = obj.schedule ?? prev?.schedule;
		// Filled at parse time, so every stored cron row names its zone and a later config change leaves it alone.
		const timezone = obj.timezone ?? prev?.timezone ?? ctx.defaultTimezone;
		if (typeof schedule !== "string") throw new MonitorSpecError("trigger.schedule must be a string");
		if (typeof timezone !== "string") throw new MonitorSpecError("trigger.timezone must be a string");
		try {
			const parsed = parseCron(schedule);
			assertTimezone(timezone);
			return { kind: "cron", schedule: parsed.source, timezone };
		} catch (error) {
			if (error instanceof CronError) throw new MonitorSpecError(`trigger: ${error.message}`);
			throw error;
		}
	}
	if (kind === "at") {
		rejectUnknown(obj, ["kind", "at", "timezone"], "trigger");
		const at = obj.at ?? (base?.kind === "at" ? base.at : undefined);
		if (typeof at !== "string") throw new MonitorSpecError("trigger.at must be an ISO time string");
		if (obj.timezone !== undefined && typeof obj.timezone !== "string") {
			throw new MonitorSpecError("trigger.timezone must be a string");
		}
		return {
			kind: "at",
			at: new Date(parseAt(at, (obj.timezone as string | undefined) ?? ctx.defaultTimezone)).toISOString(),
		};
	}
	if (kind === "script") {
		rejectUnknown(obj, ["kind", "command", "intervalMs", "fire", "once", "suppressUnchanged"], "trigger");
		const prev = base?.kind === "script" ? base : undefined;
		const rawCommand = obj.command ?? prev?.command;
		const command = typeof rawCommand === "string" ? [rawCommand] : rawCommand;
		if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string")) {
			throw new MonitorSpecError("trigger.command must be a non-empty array of strings");
		}
		const intervalMs = obj.intervalMs ?? prev?.intervalMs;
		if (
			typeof intervalMs !== "number" ||
			!Number.isInteger(intervalMs) ||
			intervalMs < MIN_SCRIPT_INTERVAL_MS ||
			intervalMs > MAX_SCRIPT_INTERVAL_MS
		) {
			throw new MonitorSpecError(
				`trigger.intervalMs must be an integer between ${MIN_SCRIPT_INTERVAL_MS} and ${MAX_SCRIPT_INTERVAL_MS}`,
			);
		}
		resolveScript(command as string[], ctx.scriptsRoot);
		const fire = obj.fire ?? prev?.fire ?? "edge";
		if (fire !== "edge" && fire !== "every") throw new MonitorSpecError('trigger.fire must be "edge" or "every"');
		const once = obj.once ?? prev?.once ?? false;
		if (typeof once !== "boolean") throw new MonitorSpecError("trigger.once must be true or false");
		const suppressUnchanged = obj.suppressUnchanged ?? prev?.suppressUnchanged ?? false;
		if (typeof suppressUnchanged !== "boolean") {
			throw new MonitorSpecError("trigger.suppressUnchanged must be true or false");
		}
		return { kind: "script", command: command as string[], intervalMs, fire, once, suppressUnchanged };
	}
	if (kind === "watcher") {
		rejectUnknown(obj, ["kind", "root", "debounceMs"], "trigger");
		const prev = base?.kind === "watcher" ? base : undefined;
		const root = obj.root ?? prev?.root;
		if (typeof root !== "string") throw new MonitorSpecError("trigger.root must be an absolute path string");
		const debounceMs = obj.debounceMs ?? prev?.debounceMs ?? DEFAULT_WATCHER_DEBOUNCE_MS;
		if (
			typeof debounceMs !== "number" ||
			!Number.isInteger(debounceMs) ||
			debounceMs < MIN_WATCHER_DEBOUNCE_MS ||
			debounceMs > MAX_WATCHER_DEBOUNCE_MS
		) {
			throw new MonitorSpecError(
				`trigger.debounceMs must be an integer ${MIN_WATCHER_DEBOUNCE_MS}-${MAX_WATCHER_DEBOUNCE_MS}`,
			);
		}
		resolveWatchRoot(root, ctx.watcherRoots);
		return { kind: "watcher", root, debounceMs };
	}
	if (kind === "webhook") {
		rejectUnknown(obj, ["kind"], "trigger");
		if (ctx.webhook === undefined) {
			throw new MonitorSpecError("webhook triggers are disabled: set webhook {port} in config.json");
		}
		// An edit keeps the URL and token the caller already hooked up; only a new monitor draws fresh ones.
		if (base?.kind === "webhook") return { kind: "webhook", id: base.id, token: base.token };
		return { kind: "webhook", id: randomBytes(16).toString("hex"), token: randomBytes(32).toString("hex") };
	}
	throw new MonitorSpecError('trigger.kind must be "cron", "at", "script", "watcher" or "webhook"');
}

/** Validates a full spec (`monitors add`). Defaults: overlap queue, enabled true, cron timezone `ctx.defaultTimezone`. */
export function parseMonitorSpec(input: unknown, ctx: SpecContext): MonitorSpec {
	return mergeMonitorSpec(undefined, input, ctx);
}

/**
 * Applies a partial spec to `current` (`monitors update`). Only supplied fields change; a supplied trigger may omit
 * `kind` and fields to inherit them from the current trigger of the same kind.
 */
export function mergeMonitorSpec(current: MonitorSpec | undefined, patch: unknown, ctx: SpecContext): MonitorSpec {
	const obj = record(patch, "monitor spec");
	rejectUnknown(obj, SPEC_KEYS, "monitor spec");
	const name = obj.name ?? current?.name;
	if (typeof name !== "string" || name.trim() === "" || name.length > MAX_NAME_CHARS) {
		throw new MonitorSpecError(`name must be 1-${MAX_NAME_CHARS} characters`);
	}
	const instruction = obj.instruction ?? current?.instruction;
	if (typeof instruction !== "string" || instruction.trim() === "") {
		throw new MonitorSpecError("instruction is required");
	}
	if (instruction.length > MAX_INSTRUCTION_CHARS) {
		throw new MonitorSpecError(`instruction is longer than ${MAX_INSTRUCTION_CHARS} characters`);
	}
	const overlap = obj.overlap ?? current?.overlap ?? "queue";
	if (overlap !== "skip" && overlap !== "queue") throw new MonitorSpecError('overlap must be "skip" or "queue"');
	const enabled = obj.enabled ?? current?.enabled ?? true;
	if (typeof enabled !== "boolean") throw new MonitorSpecError("enabled must be true or false");
	// `channel: null` clears it back to the owner DM.
	const channel = obj.channel === null ? undefined : (obj.channel ?? current?.channel);
	if (channel !== undefined && !isChannelId(channel)) {
		throw new MonitorSpecError("channel must be a Slack channel id like C0123456789 or a Discord channel id");
	}
	// `copyChannel: null` stops the copies.
	const copyChannel = obj.copyChannel === null ? undefined : (obj.copyChannel ?? current?.copyChannel);
	if (copyChannel !== undefined && !isChannelId(copyChannel)) {
		throw new MonitorSpecError("copyChannel must be a Slack channel id like C0123456789 or a Discord channel id");
	}
	if (ctx.slackOff === true) {
		for (const [key, value] of [
			["channel", channel],
			["copyChannel", copyChannel],
		] as const) {
			if (typeof value === "string" && CHANNEL_ID.test(value)) {
				throw new MonitorSpecError(`${key} is a Slack channel id but Slack is not configured (channels.slack)`);
			}
		}
	}
	// `model: null` / `thinking: null` unpin the field.
	const model = obj.model === null ? undefined : (obj.model ?? current?.model);
	if (model !== undefined && (typeof model !== "string" || !MODEL_ID.test(model))) {
		throw new MonitorSpecError("model must be an omp model id like provider/model-id (no spaces)");
	}
	const thinking = obj.thinking === null ? undefined : (obj.thinking ?? current?.thinking);
	if (thinking !== undefined && !THINKING_LEVELS.includes(thinking as MonitorThinking)) {
		throw new MonitorSpecError(`thinking must be one of ${THINKING_LEVELS.join(", ")}`);
	}
	if (obj.trigger === undefined && current === undefined) throw new MonitorSpecError("trigger is required");
	const trigger =
		obj.trigger === undefined ? (current as MonitorSpec).trigger : parseTrigger(obj.trigger, ctx, current?.trigger);
	const deliver = obj.deliver ?? current?.deliver ?? "turn";
	if (deliver !== "turn" && deliver !== "verbatim") throw new MonitorSpecError('deliver must be "turn" or "verbatim"');
	if (deliver === "verbatim" && trigger.kind !== "script") {
		throw new MonitorSpecError('deliver "verbatim" needs a script trigger');
	}
	// `procedureFiles: null` (or an empty list) detaches them all.
	// Only a supplied list is checked: an unrelated edit must not fail because a kept file has since moved.
	let procedureFiles: string[] | undefined = current?.procedureFiles;
	if (obj.procedureFiles === null) procedureFiles = undefined;
	else if (obj.procedureFiles !== undefined) {
		procedureFiles =
			Array.isArray(obj.procedureFiles) && obj.procedureFiles.length === 0
				? undefined
				: parseProcedureFiles(obj.procedureFiles, ctx);
	}
	if (procedureFiles?.length === 0) procedureFiles = undefined;
	return {
		name: name.trim(),
		trigger,
		instruction,
		overlap,
		enabled,
		...(channel === undefined ? {} : { channel }),
		...(copyChannel === undefined ? {} : { copyChannel }),
		...(model === undefined ? {} : { model: model as string }),
		...(thinking === undefined ? {} : { thinking: thinking as MonitorThinking }),
		...(deliver === "turn" ? {} : { deliver }),
		...(procedureFiles === undefined ? {} : { procedureFiles }),
	};
}
