import { appendFileSync } from "node:fs";
import { byteLength, type Redactor, truncateUtf8 } from "./redact";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogValue = string | number | boolean | null | undefined | object;
export type LogFields = Record<string, LogValue>;

export interface LogClock {
	now(): number;
}

export interface LoggerOptions {
	sink: (line: string) => void;
	clock: LogClock;
	redact: Redactor;
	/** Byte budget for one serialized line including its trailing newline. Applied after redaction. */
	maxLineBytes?: number;
}

export interface Logger {
	debug(event: string, fields?: LogFields): void;
	info(event: string, fields?: LogFields): void;
	warn(event: string, fields?: LogFields): void;
	error(event: string, fields?: LogFields): void;
}

const DEFAULT_MAX_LINE_BYTES = 8192;
const TRUNCATED_SUFFIX = " truncated=1";
const BARE_VALUE = /^[A-Za-z0-9_.:/@+-]+$/;
const RESERVED_KEYS: Record<string, true> = { ts: true, level: true, event: true };

function formatValue(value: Exclude<LogValue, undefined>): string {
	if (value === null) return "null";
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return BARE_VALUE.test(text) ? text : JSON.stringify(text);
}

function formatKey(key: string): string {
	const clean = key.replace(/[^A-Za-z0-9_.-]/g, "_") || "_";
	return RESERVED_KEYS[clean] ? `f_${clean}` : clean;
}

/** One grep-stable line: `ts=<iso> level=<l> event=<e> key=value ...`. The whole line is redacted after formatting. */
export function createLogger(options: LoggerOptions): Logger {
	const maxBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;

	const emit = (level: LogLevel, event: string, fields: LogFields = {}): void => {
		const ts = new Date(options.clock.now()).toISOString();
		const parts = [`ts=${ts}`, `level=${level}`, `event=${formatValue(event)}`];
		for (const [key, value] of Object.entries(fields)) {
			if (value === undefined) continue;
			parts.push(`${formatKey(key)}=${formatValue(value)}`);
		}
		let line: string;
		try {
			line = options.redact(parts.join(" "));
		} catch {
			line = `ts=${ts} level=error event=log_redact_failed`;
		}
		if (byteLength(`${line}\n`) > maxBytes) {
			const room = maxBytes - byteLength(`${TRUNCATED_SUFFIX}\n`);
			line = `${truncateUtf8(line, room)}${TRUNCATED_SUFFIX}`;
		}
		options.sink(line);
	};

	return {
		debug: (event, fields) => emit("debug", event, fields),
		info: (event, fields) => emit("info", event, fields),
		warn: (event, fields) => emit("warn", event, fields),
		error: (event, fields) => emit("error", event, fields),
	};
}

/** Append-only file sink; created 0600. */
export function fileSink(path: string): (line: string) => void {
	return (line) => appendFileSync(path, `${line}\n`, { mode: 0o600 });
}
