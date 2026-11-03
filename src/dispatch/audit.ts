import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../log";
import { rotatingFileSink } from "../ops/logfile";
import { redact } from "../redact";

/**
 * One finished external call (a local herdr/git/omp child or an ssh command) made through `realProcessRunner` in the
 * daemon process, as the audit file records it. CLI runs (`ompbot offsite`, `backup`, `tasks`) install no audit.
 */
export interface AuditEntry {
	ts: string;
	/** ssh target for remote calls, `local` for children of the bot's own machine. */
	host: string;
	argv0: string;
	/** Redacted, length-capped command: the remote command line for ssh, the argv otherwise. */
	cmd: string;
	/** First 16 hex chars of sha256 over the redacted full command, for correlating lines. */
	cmdSha256: string;
	/** Exit code; null when the process was killed (timeout) or never spawned. */
	rc: number | null;
	ms: number;
	timedOut?: boolean;
	origin?: string;
}

export interface AuditContext {
	origin?: string;
}

/** Who a call is for; set around a tool execution so the single wrapped runner can name the origin. */
export const auditContext = new AsyncLocalStorage<AuditContext>();

export const AUDIT_FILE = "dispatch-audit.jsonl";
export const AUDIT_MAX_BYTES = 5 * 1024 * 1024;
export const AUDIT_FILES = 4;
export const AUDIT_CMD_CHARS = 300;

export interface ProcessAudit {
	record(cmd: readonly string[], outcome: { code: number | null; timedOut: boolean }, ms: number): void;
}

/** Splits an argv into the audited host and command text; `ssh [-o x]… [--] target [--] remote…` names the target. */
export function describeCall(cmd: readonly string[]): { host: string; argv0: string; text: string } {
	const argv0 = cmd[0] ?? "";
	if (argv0 !== "ssh") return { host: "local", argv0, text: cmd.join(" ") };
	let index = 1;
	while (index < cmd.length) {
		const word = cmd[index] as string;
		if (word === "-o" || word === "-p" || word === "-i" || word === "-l") index += 2;
		else if (word === "--") {
			index += 1;
			break;
		} else if (word.startsWith("-")) index += 1;
		else break;
	}
	const host = cmd[index] ?? "unknown";
	let rest = cmd.slice(index + 1);
	if (rest[0] === "--") rest = rest.slice(1);
	return { host, argv0, text: rest.join(" ") };
}

export interface DispatchAuditOptions {
	homeDir: string;
	log: Pick<Logger, "warn">;
	now?: () => number;
	/** Test seam: replaces the rotating file sink. */
	sink?: (line: string) => void;
}

/** `<home>/logs/dispatch-audit.jsonl`: one JSON line per call; a failed write warns once and never blocks the call. */
export function createDispatchAudit(options: DispatchAuditOptions): ProcessAudit {
	const now = options.now ?? Date.now;
	let sink = options.sink;
	let warned = false;
	return {
		record(cmd, outcome, ms) {
			try {
				const { host, argv0, text } = describeCall(cmd);
				const safe = redact(text);
				const context = auditContext.getStore();
				const entry: AuditEntry = {
					ts: new Date(now()).toISOString(),
					host,
					argv0,
					cmd: safe.length > AUDIT_CMD_CHARS ? `${safe.slice(0, AUDIT_CMD_CHARS)}…` : safe,
					cmdSha256: createHash("sha256").update(safe).digest("hex").slice(0, 16),
					rc: outcome.code,
					ms,
					...(outcome.timedOut ? { timedOut: true } : {}),
					...(context?.origin === undefined ? {} : { origin: context.origin }),
				};
				if (sink === undefined) {
					const dir = join(options.homeDir, "logs");
					mkdirSync(dir, { recursive: true, mode: 0o700 });
					sink = rotatingFileSink(join(dir, AUDIT_FILE), { maxBytes: AUDIT_MAX_BYTES, files: AUDIT_FILES });
				}
				sink(JSON.stringify(entry));
			} catch (error) {
				if (warned) return;
				warned = true;
				options.log.warn("dispatch_audit_write_failed", { error: String(error) });
			}
		},
	};
}

let installed: ProcessAudit | undefined;

/**
 * The daemon installs its audit once at start; `realProcessRunner` (the one place the daemon's external calls pass)
 * reports to it. A process that never installs one (the CLI) records nothing.
 */
export function installProcessAudit(audit: ProcessAudit | undefined): void {
	installed = audit;
}

export function recordProcessCall(
	cmd: readonly string[],
	outcome: { code: number | null; timedOut: boolean },
	ms: number,
): void {
	installed?.record(cmd, outcome, ms);
}
