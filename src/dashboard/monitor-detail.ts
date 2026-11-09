import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type MonitorSql, toMonitor } from "../monitors/ledger";
import { resolveProcedureFile } from "../monitors/spec";
import { redact } from "../redact";
import { formatKst } from "../tasks/docs";
import { monitorDurationMs } from "./snapshot";

/**
 * `api/monitor/detail?id=<id>`: one monitor's instruction, procedure file heads and last runs, all masked; read-only,
 * per request, never cached. Event answers and payloads are never read.
 */

const INSTRUCTION_CHARS = 4000;
const PROCEDURE_CHARS = 2000;
const ERROR_CHARS = 160;
const RUN_LIMIT = 10;

export interface MonitorDetailRun {
	slotAt: string;
	at: string;
	stage: string;
	manual: boolean;
	attempts: number;
	/** Slot to settle (retry waits included); null while running. */
	durationMs: number | null;
	/** The masked first line of the event's error, at most 160 chars. */
	error: string | null;
}

/** A procedure file by name: its masked head, or `unreadable` when it cannot be resolved or read now. */
export type MonitorProcedure =
	| { name: string; text: string; truncated: boolean }
	| { name: string; error: "unreadable" };

export type MonitorDetail =
	| { ok: true; instruction: string; procedures: MonitorProcedure[]; runs: MonitorDetailRun[] }
	| { ok: false; error: "no_database" | "unknown_monitor" };

/** Where procedure files may live: the daemon's roots (`workspaceDir` and `<home>/scripts`). */
export interface MonitorDetailRoots {
	workspaceDir: string | undefined;
	scriptsRoot: string;
}

/** Masked first, then cut to `limit` characters: a secret is never left half-visible by the cut. */
function head(text: string, limit: number): { text: string; truncated: boolean } {
	const chars = Array.from(redact(text));
	return { text: chars.slice(0, limit).join(""), truncated: chars.length > limit };
}

export function readMonitorDetail(homeDir: string, roots: MonitorDetailRoots, id: string): MonitorDetail {
	const dbPath = join(homeDir, "ompbot.db");
	if (!existsSync(dbPath)) return { ok: false, error: "no_database" };
	const db = new Database(dbPath, { readonly: true, strict: true });
	let sql: MonitorSql | null;
	let events: Array<{
		slot_at: number;
		updated_at: number;
		stage: string;
		manual: number;
		attempts: number;
		error: string | null;
	}>;
	try {
		sql = db.query<MonitorSql, [string]>("SELECT * FROM monitors WHERE id = ?").get(id);
		events =
			sql === null
				? []
				: db
						.query<(typeof events)[number], [string, number]>(
							"SELECT slot_at, updated_at, stage, manual, attempts, error FROM monitor_events WHERE monitor_id = ? ORDER BY event_id DESC LIMIT ?",
						)
						.all(id, RUN_LIMIT);
	} finally {
		db.close();
	}
	if (sql === null) return { ok: false, error: "unknown_monitor" };
	const monitor = toMonitor(sql);
	const instruction = head(monitor.instruction, INSTRUCTION_CHARS);
	return {
		ok: true,
		instruction: instruction.truncated
			? `${Array.from(instruction.text)
					.slice(0, INSTRUCTION_CHARS - 1)
					.join("")}…`
			: instruction.text,
		procedures: monitor.procedureFiles.map((path): MonitorProcedure => {
			const name = redact(path.slice(path.lastIndexOf("/") + 1));
			try {
				const file = resolveProcedureFile(path, roots.workspaceDir, roots.scriptsRoot);
				return { name, ...head(readFileSync(file, "utf8"), PROCEDURE_CHARS) };
			} catch {
				return { name, error: "unreadable" };
			}
		}),
		runs: events.map((event) => ({
			slotAt: formatKst(event.slot_at),
			at: formatKst(event.updated_at),
			stage: event.stage,
			manual: event.manual === 1,
			attempts: event.attempts,
			durationMs: monitorDurationMs(event.stage, event.slot_at, event.updated_at),
			error:
				event.error === null
					? null
					: Array.from(redact(event.error).split("\n")[0] ?? "")
							.slice(0, ERROR_CHARS)
							.join(""),
		})),
	};
}
