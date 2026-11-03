import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** What `healSessionModelFile` changed: the patched file and the model swap it made. */
export interface HealedSessionModel {
	file: string;
	/** The dead model the session's last `model_change` named. */
	from: string;
	/** The live fallback the record was rewritten to. */
	to: string;
}

/**
 * The session file omp resumes for a session dir: the newest `*.jsonl` by omp's own listing order — mtime
 * descending, then creation time descending, then path ascending (pi-coding-agent dist session listing sort;
 * its `open_session` resumes the first non-empty session of that order). ompbot keeps one active session per
 * epoch dir, so the newest file is the resumed one.
 */
export function newestSessionFile(sessionDir: string): string | undefined {
	let newest: { file: string; mtimeMs: number; createdMs: number; name: string } | undefined;
	for (const name of readdirSync(sessionDir)) {
		if (!name.endsWith(".jsonl")) continue;
		const file = join(sessionDir, name);
		const { mtimeMs, birthtimeMs } = statSync(file);
		if (
			newest === undefined ||
			mtimeMs > newest.mtimeMs ||
			(mtimeMs === newest.mtimeMs &&
				(birthtimeMs > newest.createdMs || (birthtimeMs === newest.createdMs && name.localeCompare(newest.name) < 0)))
		) {
			newest = { file, mtimeMs, createdMs: birthtimeMs, name };
		}
	}
	return newest?.file;
}

/** The model of the last `model_change` record of a session file: the value omp's session restore resolves first. */
export function lastModelChange(file: string): string | undefined {
	let model: string | undefined;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line === "") continue;
		try {
			const record = JSON.parse(line) as { type?: unknown; model?: unknown } | null;
			if (record?.type === "model_change" && typeof record.model === "string") model = record.model;
		} catch {
			// a torn trailing line: omp skips unparsable records too
		}
	}
	return model;
}

/** `line` with its `"model"` value swapped; a full re-stringify only when the exact needle is not unique. */
function rewriteModel(line: string, from: string, to: string): string {
	const needle = `"model":${JSON.stringify(from)}`;
	if (line.includes(needle) && line.indexOf(needle) === line.lastIndexOf(needle)) {
		return line.replace(needle, `"model":${JSON.stringify(to)}`);
	}
	const record = JSON.parse(line) as { model?: unknown };
	return JSON.stringify({ ...record, model: to });
}

/**
 * Rewrites a session file's last `model_change` to `fallback`, so omp's restore — which resolves `model_change`
 * records newest-first and uses the first model it knows — succeeds again. Every other byte stays as it was:
 * the pristine original is copied to `<backupDir>/<UTC timestamp>.jsonl` first, and the corrected text lands
 * through a temp file + rename, leaving no new `*.jsonl` in the session dir. Returns `undefined` (touching
 * nothing) when the file has no `model_change` record or its last one already names `fallback`.
 */
export function healSessionModelFile(
	file: string,
	fallback: string,
	backupDir: string,
	now = new Date(),
): HealedSessionModel | undefined {
	const lines = readFileSync(file, "utf8").split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i] ?? ""; // split output is dense; "" also skips a missing slot
		if (line === "") continue;
		let record: { type?: unknown; model?: unknown };
		try {
			record = JSON.parse(line) as { type?: unknown; model?: unknown };
		} catch {
			continue;
		}
		if (record?.type !== "model_change" || typeof record.model !== "string") continue;
		if (record.model === fallback) return undefined;
		const stamp = now.toISOString().replaceAll(":", "").replaceAll(".", "");
		lines[i] = rewriteModel(line, record.model, fallback);
		mkdirSync(backupDir, { recursive: true });
		copyFileSync(file, join(backupDir, `${stamp}.jsonl`));
		const temp = join(dirname(file), `.${stamp}.heal.tmp`);
		writeFileSync(temp, lines.join("\n"));
		renameSync(temp, file);
		return { file, from: record.model, to: fallback };
	}
	return undefined;
}
