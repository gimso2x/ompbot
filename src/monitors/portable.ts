import {
	chmodSync,
	copyFileSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { MonitorLedger, MonitorRow } from "./ledger";
import { type MonitorSpec, MonitorSpecError, parseMonitorSpec, type SpecContext } from "./spec";

/**
 * Host-independent monitor files (`ompbot monitors export|apply`): one JSON file per monitor holding only the spec
 * fields, with paths under the scripts root and the workspace written as `@SCRIPTS@/…` and `@WORKSPACE@/…`, so the
 * same file applies on a home with other paths. Webhook triggers carry no id or token; ids, cursors, state and
 * timestamps stay in the database.
 */
export const SCRIPTS_PLACEHOLDER = "@SCRIPTS@";
export const WORKSPACE_PLACEHOLDER = "@WORKSPACE@";

/** The spec context of one home; export and apply need the workspace to map paths against. */
export type PortableContext = SpecContext & { workspaceDir: string };

/** The stored spec of a row, in the shape `parseMonitorSpec` returns. */
export function specOfRow(row: MonitorRow): MonitorSpec {
	return {
		name: row.name,
		trigger: row.trigger,
		instruction: row.instruction,
		overlap: row.overlap,
		enabled: row.enabled,
		...(row.channel === null ? {} : { channel: row.channel }),
		...(row.copyChannel === null ? {} : { copyChannel: row.copyChannel }),
		...(row.model === null ? {} : { model: row.model }),
		...(row.thinking === null ? {} : { thinking: row.thinking }),
		...(row.deliver === "turn" ? {} : { deliver: row.deliver }),
		...(row.procedureFiles.length === 0 ? {} : { procedureFiles: row.procedureFiles }),
	};
}

interface PlaceholderRoot {
	root: string;
	placeholder: string;
}

/** Placeholder roots, longest first, so a workspace inside the home never captures `<home>/scripts`. */
function rootsOf(ctx: PortableContext): PlaceholderRoot[] {
	return [
		{ root: resolve(ctx.scriptsRoot), placeholder: SCRIPTS_PLACEHOLDER },
		{ root: resolve(ctx.workspaceDir), placeholder: WORKSPACE_PLACEHOLDER },
	].sort((a, b) => b.root.length - a.root.length);
}

/**
 * An absolute path inside a placeholder root as `{placeholder, rest}` (`rest` empty for the root itself), judged after
 * `..` and `.` are resolved: `<scripts>/../../x` is outside, whatever its spelling starts with.
 */
function underRoot(path: string, roots: readonly PlaceholderRoot[]): { placeholder: string; rest: string } | undefined {
	const normal = resolve(path);
	for (const { root, placeholder } of roots) {
		const rest = relative(root, normal);
		if (!isOutside(rest)) return { placeholder, rest };
	}
	return undefined;
}

/** A `relative()` result that leaves its base: `..` first, or absolute (another drive). */
function isOutside(rest: string): boolean {
	return rest === ".." || rest.startsWith(`..${sep}`) || isAbsolute(rest);
}

/**
 * The portable spec with a fixed key order (stable diffs). `onOutside` hears about absolute paths outside both roots,
 * which are kept as they are.
 */
export function portableSpec(
	spec: MonitorSpec,
	ctx: PortableContext,
	onOutside: (path: string) => void = () => {},
): Record<string, unknown> {
	const roots = rootsOf(ctx);
	const toPortable = (path: string): string => {
		if (!isAbsolute(path)) return path;
		const inside = underRoot(path, roots);
		if (inside === undefined) {
			onOutside(path);
			return path;
		}
		return inside.rest === "" ? inside.placeholder : `${inside.placeholder}/${inside.rest}`;
	};
	const { trigger } = spec;
	let portableTrigger: Record<string, unknown>;
	if (trigger.kind === "cron") {
		portableTrigger = { kind: "cron", schedule: trigger.schedule, timezone: trigger.timezone };
	} else if (trigger.kind === "at") {
		portableTrigger = { kind: "at", at: trigger.at };
	} else if (trigger.kind === "script") {
		// Rows stored before fire/once/suppressUnchanged existed read as their defaults.
		portableTrigger = {
			kind: "script",
			command: trigger.command.map(toPortable),
			intervalMs: trigger.intervalMs,
			fire: trigger.fire ?? "edge",
			once: trigger.once ?? false,
			suppressUnchanged: trigger.suppressUnchanged ?? false,
		};
	} else if (trigger.kind === "watcher") {
		portableTrigger = { kind: "watcher", root: toPortable(trigger.root), debounceMs: trigger.debounceMs };
	} else {
		portableTrigger = { kind: "webhook" };
	}
	return {
		name: spec.name,
		trigger: portableTrigger,
		instruction: spec.instruction,
		overlap: spec.overlap,
		enabled: spec.enabled,
		...(spec.channel === undefined ? {} : { channel: spec.channel }),
		...(spec.copyChannel === undefined ? {} : { copyChannel: spec.copyChannel }),
		...(spec.model === undefined ? {} : { model: spec.model }),
		...(spec.thinking === undefined ? {} : { thinking: spec.thinking }),
		...(spec.deliver === undefined || spec.deliver === "turn" ? {} : { deliver: spec.deliver }),
		...(spec.procedureFiles === undefined ? {} : { procedureFiles: spec.procedureFiles.map(toPortable) }),
	};
}

export interface ExportResult {
	written: number;
	/** Stale `*.json` files of monitors no longer in the database. */
	removed: number;
	warnings: string[];
}

/**
 * Writes `<dir>/<stem>.json` for every monitor and deletes the other `*.json` files there, so the directory mirrors
 * the database. `withFiles` also copies the referenced script and procedure files under the placeholder roots to
 * `<dir>/files/scripts/` and `<dir>/files/workspace/`, keeping their mode bits.
 */
export function exportMonitors(
	ledger: MonitorLedger,
	dir: string,
	ctx: PortableContext,
	options: { withFiles?: boolean } = {},
): ExportResult {
	try {
		mkdirSync(dir, { recursive: true });
		if (!statSync(dir).isDirectory()) throw new Error("not a directory");
	} catch (error) {
		throw new PortableUsageError(
			`--dir is not a directory: ${dir} (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	const warnings: string[] = [];
	const written = new Set<string>();
	const copies = new Map<string, string>();
	const roots = rootsOf(ctx);
	const filesRoots: Record<string, string> = {
		[SCRIPTS_PLACEHOLDER]: join(dir, "files", "scripts"),
		[WORKSPACE_PLACEHOLDER]: join(dir, "files", "workspace"),
	};
	// Sorted by name so a stem collision gets the same suffix on every host whatever the creation order.
	const rows = ledger.listMonitors().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const row of rows) {
		const spec = specOfRow(row);
		const portable = portableSpec(spec, ctx, (path) =>
			warnings.push(`${row.name}: path outside the scripts dir and the workspace kept as is: ${path}`),
		);
		// `/`, whitespace and control characters become `-`; the `name` inside the file is what apply matches on.
		const stem = row.name.replace(/[/\s\p{Cc}]/gu, "-");
		let file = `${stem}.json`;
		for (let n = 2; written.has(file); n++) file = `${stem}-${n}.json`;
		written.add(file);
		writeFileSync(join(dir, file), `${JSON.stringify(portable, null, 2)}\n`);
		if (!options.withFiles) continue;
		const referenced = [
			...(spec.trigger.kind === "script" ? spec.trigger.command : []),
			...(spec.procedureFiles ?? []).map((path) => resolve(ctx.workspaceDir, path)),
		];
		for (const path of referenced) {
			const inside = isAbsolute(path) ? underRoot(path, roots) : undefined;
			if (inside === undefined || inside.rest === "") continue;
			const filesRoot = filesRoots[inside.placeholder] as string;
			const target = join(filesRoot, inside.rest);
			if (isOutside(relative(filesRoot, target))) {
				warnings.push(`${row.name}: referenced file would land outside ${filesRoot}, not copied: ${path}`);
				continue;
			}
			copies.set(path, target);
		}
	}
	for (const [source, target] of copies) {
		let mode: number;
		try {
			const stat = statSync(source);
			if (!stat.isFile()) continue;
			mode = stat.mode & 0o7777;
		} catch {
			warnings.push(`referenced file not found, not copied: ${source}`);
			continue;
		}
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(source, target);
		chmodSync(target, mode);
	}
	let removed = 0;
	for (const file of readdirSync(dir)) {
		// A directory named `*.json` is not a stale monitor file.
		if (!file.endsWith(".json") || written.has(file) || lstatSync(join(dir, file)).isDirectory()) continue;
		rmSync(join(dir, file), { force: true });
		removed++;
	}
	return { written: written.size, removed, warnings };
}

/** `export --dir` cannot be a directory (a file stands there or below its parent); nothing was written. */
export class PortableUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PortableUsageError";
	}
}

/** Some files of an `apply` directory did not validate; nothing was changed. */
export class PortableApplyError extends Error {
	constructor(readonly problems: string[]) {
		super(`${problems.length} monitor file(s) failed validation`);
		this.name = "PortableApplyError";
	}
}

export interface ApplyResult {
	added: number;
	updated: number;
	unchanged: number;
	removed: number;
}

/** Replaces `@SCRIPTS@`/`@WORKSPACE@` in the path fields of a parsed file; anything malformed is left to validation. */
function resolvePlaceholders(input: Record<string, unknown>, ctx: PortableContext): Record<string, unknown> {
	const roots = rootsOf(ctx);
	const toLocal = (value: unknown): unknown => {
		if (typeof value !== "string") return value;
		for (const { root, placeholder } of roots) {
			if (value === placeholder) return root;
			if (value.startsWith(`${placeholder}/`)) return join(root, value.slice(placeholder.length + 1));
		}
		return value;
	};
	const out = { ...input };
	const trigger = input.trigger;
	if (typeof trigger === "object" && trigger !== null && !Array.isArray(trigger)) {
		const t = { ...(trigger as Record<string, unknown>) };
		if (Array.isArray(t.command)) t.command = t.command.map(toLocal);
		else if (t.command !== undefined) t.command = toLocal(t.command);
		if (t.root !== undefined) t.root = toLocal(t.root);
		out.trigger = t;
	}
	if (Array.isArray(input.procedureFiles)) out.procedureFiles = input.procedureFiles.map(toLocal);
	return out;
}

/**
 * Applies every `<dir>/*.json` by monitor name: a missing monitor is added, a different one updated, an equal one left
 * untouched (its `updated_at` too). With `prune`, monitors without a file are removed. Every file is validated first;
 * one failure throws `PortableApplyError` before anything changes. `dryRun` returns the counts without writing.
 */
export function applyMonitors(
	ledger: MonitorLedger,
	dir: string,
	ctx: PortableContext,
	options: { prune?: boolean; dryRun?: boolean } = {},
): ApplyResult {
	let files: string[];
	try {
		files = readdirSync(dir)
			.filter((file) => file.endsWith(".json"))
			.sort();
	} catch (error) {
		throw new PortableApplyError([`${dir}: ${error instanceof Error ? error.message : String(error)}`]);
	}
	const existing = new Map(ledger.listMonitors().map((row) => [row.name, row]));
	const problems: string[] = [];
	const seen = new Map<string, string>();
	const adds: MonitorSpec[] = [];
	const updates: Array<{ id: string; spec: MonitorSpec }> = [];
	let unchanged = 0;
	for (const file of files) {
		try {
			let input: unknown;
			try {
				input = JSON.parse(readFileSync(join(dir, file), "utf8"));
			} catch (error) {
				throw new MonitorSpecError(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (typeof input !== "object" || input === null || Array.isArray(input)) {
				throw new MonitorSpecError("monitor spec must be an object");
			}
			const parsed = parseMonitorSpec(resolvePlaceholders(input as Record<string, unknown>, ctx), ctx);
			const other = seen.get(parsed.name);
			if (other !== undefined) throw new MonitorSpecError(`name "${parsed.name}" is also used by ${other}`);
			seen.set(parsed.name, file);
			const current = existing.get(parsed.name);
			if (current === undefined) {
				adds.push(parsed);
				continue;
			}
			// Like `mergeMonitorSpec`, an edit keeps the webhook id and token the caller already hooked up.
			const spec =
				parsed.trigger.kind === "webhook" && current.trigger.kind === "webhook"
					? { ...parsed, trigger: current.trigger }
					: parsed;
			const same = JSON.stringify(portableSpec(spec, ctx)) === JSON.stringify(portableSpec(specOfRow(current), ctx));
			if (same) unchanged++;
			else updates.push({ id: current.id, spec });
		} catch (error) {
			if (!(error instanceof MonitorSpecError)) throw error;
			problems.push(`${file}: ${error.message}`);
		}
	}
	if (problems.length > 0) throw new PortableApplyError(problems);
	const removals = options.prune ? [...existing.values()].filter((row) => !seen.has(row.name)) : [];
	if (!options.dryRun) {
		for (const spec of adds) ledger.addMonitor(spec);
		for (const { id, spec } of updates) ledger.updateMonitor(id, spec);
		for (const row of removals) ledger.removeMonitor(row.id);
	}
	return { added: adds.length, updated: updates.length, unchanged, removed: removals.length };
}
