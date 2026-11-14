/*
 * The model and thinking level an origin's omp session runs with, read from its session jsonl for the turn board's
 * chip (doc/plans/dashboard-model-and-last-prompt.md §A). Display only: any failure is `undefined`, never a throw.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { newestSessionFile } from "../omp/session-heal";

/** What the chip shows; `fallback` only when the last seen `model_change` says omp resolved a fallback model. */
export interface SessionModel {
	model: string;
	thinking: string | null;
	fallback: boolean;
}

/** The `origins` columns the reader needs. */
export interface SessionModelOrigin {
	sessionDir: string;
	sessionFile: string | null;
	/** The origin's `!model` / `!thinking` settings (null = none). */
	model: string | null;
	thinking: string | null;
}

/** Bytes read from the start of a large session file (the first `model_change`/`thinking_level_change`). */
export const HEAD_BYTES = 64 * 1024;
/** Bytes read from the end of a session file; a file this size or smaller is read whole once. */
export const TAIL_BYTES = 256 * 1024;

/** Session files the reader remembers (the board shows at most 200 threads). */
const CACHE_ENTRIES = 1000;

/** Reads `length` bytes of `file` from `offset` as UTF-8 text. */
export type ChunkReader = (file: string, offset: number, length: number) => string;

const readChunk: ChunkReader = (file, offset, length) => {
	const fd = openSync(file, "r");
	try {
		const buffer = Buffer.alloc(length);
		const read = readSync(fd, buffer, 0, length, offset);
		return buffer.subarray(0, read).toString("utf8");
	} finally {
		closeSync(fd);
	}
};

interface Seen {
	modelChange?: { model: string | null; fallback: boolean };
	thinking?: string | null;
	assistant?: string;
}

/** Folds the complete lines of `text` into `seen`, later lines overriding earlier ones; unparseable lines are skipped. */
function scan(text: string, seen: Seen): void {
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		if (record.type === "model_change") {
			seen.modelChange = {
				model: typeof record.model === "string" && record.model !== "" ? record.model : null,
				fallback: record.resolvedModelIsFallback === true,
			};
		} else if (record.type === "thinking_level_change") {
			seen.thinking = typeof record.thinkingLevel === "string" ? record.thinkingLevel : null;
		} else if (record.type === "message") {
			const message = record.message as Record<string, unknown> | undefined;
			if (
				message?.role === "assistant" &&
				typeof message.provider === "string" &&
				typeof message.model === "string" &&
				message.model !== ""
			) {
				seen.assistant = message.provider === "" ? message.model : `${message.provider}/${message.model}`;
			}
		}
	}
}

/**
 * The session file of an origin: `session_file` when it exists, else the newest `*.jsonl` directly in its current
 * `session_dir` (sub-agent directories are not looked into).
 */
function sessionFileOf(origin: SessionModelOrigin): string | undefined {
	if (origin.sessionFile !== null && existsSync(origin.sessionFile)) return origin.sessionFile;
	return existsSync(origin.sessionDir) ? newestSessionFile(origin.sessionDir) : undefined;
}

/** Model and thinking of one session file of `size` bytes; `undefined` when it names no model. */
function readSessionModel(
	file: string,
	size: number,
	origin: Pick<SessionModelOrigin, "model" | "thinking">,
	read: ChunkReader = readChunk,
): SessionModel | undefined {
	const seen: Seen = {};
	if (size <= TAIL_BYTES) {
		scan(read(file, 0, size), seen);
	} else {
		scan(read(file, 0, HEAD_BYTES), seen);
		// The tail starts mid-line: its first (partial) line is dropped.
		const tail = read(file, size - TAIL_BYTES, TAIL_BYTES);
		const cut = tail.indexOf("\n");
		scan(cut < 0 ? "" : tail.slice(cut + 1), seen);
	}
	const fallback = seen.modelChange?.fallback === true;
	// `!model`/`!thinking` changes in the unread middle are covered by the origin's own settings, unless on a fallback.
	const model = (!fallback ? origin.model : null) ?? seen.assistant ?? seen.modelChange?.model ?? null;
	if (model === null) return undefined;
	const thinking = (!fallback ? origin.thinking : null) ?? seen.thinking ?? null;
	return { model, thinking, fallback };
}

/**
 * A reader of origins' session models that reads a session file again only when its (path, size, mtime) changed.
 * Never throws: a missing file or directory, or an unreadable one, is `undefined`.
 */
export function createSessionModelReader(
	read: ChunkReader = readChunk,
): (origin: SessionModelOrigin) => SessionModel | undefined {
	const cache = new Map<string, { size: number; mtimeMs: number; settings: string; value: SessionModel | undefined }>();
	return (origin) => {
		try {
			const file = sessionFileOf(origin);
			if (file === undefined) return undefined;
			const { size, mtimeMs } = statSync(file);
			const settings = `${origin.model ?? ""}\n${origin.thinking ?? ""}`;
			const hit = cache.get(file);
			if (hit !== undefined && hit.size === size && hit.mtimeMs === mtimeMs && hit.settings === settings) {
				return hit.value;
			}
			const value = readSessionModel(file, size, origin, read);
			// Old sessions are never asked for again: past a board's worth of entries the cache starts over.
			if (hit === undefined && cache.size >= CACHE_ENTRIES) cache.clear();
			cache.set(file, { size, mtimeMs, settings, value });
			return value;
		} catch {
			return undefined;
		}
	};
}
