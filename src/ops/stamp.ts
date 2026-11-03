import { closeSync, fsyncSync, openSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

/**
 * Shared k=v stamp plumbing: the sweep heartbeat (`daemon/heartbeat.ts`) and the backup stamp (`ops/backup.ts`)
 * write and read the same `k=v k=v` one-liner format, so the parser and the atomic 0600 write live here once.
 */

/** Parses whitespace-separated `k=v` stamp fields into a map (a part without `=` past position 0 is ignored). */
export function parseStampFields(text: string): Map<string, string> {
	const fields = new Map<string, string>();
	for (const part of text.trim().split(/\s+/)) {
		const eq = part.indexOf("=");
		if (eq > 0) fields.set(part.slice(0, eq), part.slice(eq + 1));
	}
	return fields;
}

/**
 * The stamp's `ts=` field as a `Date`, falling back to the file mtime when the field is absent or unparseable;
 * `undefined` when the file itself is unreadable.
 */
export function parseStampTs(fields: Map<string, string>, path: string): Date | undefined {
	let ts: Date | undefined;
	const rawTs = fields.get("ts");
	if (rawTs !== undefined) {
		const parsed = new Date(rawTs);
		if (!Number.isNaN(parsed.getTime())) ts = parsed;
	}
	if (ts === undefined) {
		try {
			ts = statSync(path).mtime;
		} catch {
			return undefined;
		}
	}
	return ts;
}

/** Atomic 0600 write (temp + fsync + rename), so a half-written stamp is never observable; returns the final path. */
export function writeAtomic0600(path: string, content: string): string {
	const tmp = `${path}.tmp-${crypto.randomUUID()}`;
	try {
		writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
		const fd = openSync(tmp, "r+");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, path);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
	return path;
}
