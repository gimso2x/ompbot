import { accessSync, appendFileSync, constants, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** `logs/ompbot.log` is capped at 10 MB per file and 5 files in total (the live file plus `.1` .. `.4`). */
export const LOG_MAX_BYTES = 10 * 1024 * 1024;
export const LOG_FILES = 5;

export interface RotationOptions {
	maxBytes?: number;
	/** Total number of files kept, the live one included. */
	files?: number;
}

/** The log directory cannot be created or written; the message names the path and the OS error code only. */
export class LogDirError extends Error {
	constructor(path: string, cause: unknown) {
		const code = typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : String(cause);
		super(`log_dir_unwritable: ${path} (${code})`);
		this.name = "LogDirError";
	}
}

/** Shifts `path.N-1` to `path.N` (the oldest falls off) and moves the live file to `path.1`. */
function rotate(path: string, files: number): void {
	if (files <= 1) {
		rmSync(path, { force: true });
		return;
	}
	rmSync(`${path}.${files - 1}`, { force: true });
	for (let index = files - 2; index >= 1; index--) {
		if (existsSync(`${path}.${index}`)) renameSync(`${path}.${index}`, `${path}.${index + 1}`);
	}
	renameSync(path, `${path}.1`);
}

/** Append-only sink (files created 0600) that rotates before a write would push the live file past `maxBytes`. */
export function rotatingFileSink(path: string, options: RotationOptions = {}): (line: string) => void {
	const maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
	const files = options.files ?? LOG_FILES;
	let size = existsSync(path) ? statSync(path).size : 0;
	return (line) => {
		const bytes = Buffer.byteLength(line) + 1;
		if (size > 0 && size + bytes > maxBytes) {
			rotate(path, files);
			size = 0;
		}
		appendFileSync(path, `${line}\n`, { mode: 0o600 });
		size += bytes;
	};
}

/**
 * Creates `<homeDir>/logs` and proves the live log file is appendable before the daemon takes the lock or starts
 * anything, so an unwritable log directory is a refusal to start rather than a daemon that cannot report.
 */
export function openLogSink(
	homeDir: string,
	options: RotationOptions = {},
): { path: string; sink: (line: string) => void } {
	const dir = join(homeDir, "logs");
	const path = join(dir, "ompbot.log");
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		accessSync(dir, constants.W_OK | constants.X_OK);
		appendFileSync(path, "", { mode: 0o600 });
	} catch (error) {
		throw new LogDirError(dir, error);
	}
	return { path, sink: rotatingFileSink(path, options) };
}
