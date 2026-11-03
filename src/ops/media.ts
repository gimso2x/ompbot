import { type Dirent, lstatSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Inbound attachments are context for one turn, not an archive; hermes-agent uses the same 24h retention. */
export const MEDIA_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * Deletes downloaded attachments older than `maxAgeMs` and the directories they empty out. Idempotent.
 *
 * Best effort per entry: a file or directory that cannot be listed, stat'ed or removed is skipped, so one bad entry
 * never aborts the sweep (or the backup run that triggers it). Only regular files and symlinks are unlinked, and
 * symlinks are judged by their own mtime (lstat), never followed. An empty directory is removed only when this pass
 * emptied it or its own mtime is already past the cutoff - a directory a download is about to write into survives.
 */
export function pruneMediaFiles(mediaRoot: string, now: number, maxAgeMs = MEDIA_MAX_AGE_MS): number {
	return prune(mediaRoot, now - maxAgeMs);
}

function prune(dir: string, cutoff: number): number {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return 0; // missing, not a directory, or unreadable
	}
	let removed = 0;
	for (const entry of entries) {
		const child = join(dir, entry.name);
		try {
			if (entry.isDirectory()) {
				removed += pruneDirectory(child, cutoff);
			} else if ((entry.isFile() || entry.isSymbolicLink()) && lstatSync(child).mtimeMs < cutoff) {
				unlinkSync(child);
				removed += 1;
			}
		} catch {
			// vanished, permission denied, ...: leave it for the next sweep
		}
	}
	return removed;
}

function pruneDirectory(dir: string, cutoff: number): number {
	const mtimeBefore = lstatSync(dir).mtimeMs;
	const removed = prune(dir, cutoff);
	if ((removed > 0 || mtimeBefore < cutoff) && readdirSync(dir).length === 0) rmdirSync(dir);
	return removed;
}
