import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** What `healSessionModelFile` changed: the patched file and the model swap it made. */
export interface HealedSessionModel {
	file: string;
	/** The dead model of the `model_change` omp restores from. */
	from: string;
	/** The live fallback the record was rewritten to. */
	to: string;
}

/** A session file as omp's listing sorts it. */
export interface ListedSession {
	mtimeMs: number;
	createdMs: number;
	name: string;
}

/**
 * Whether `a` lists before `b` in omp's own session listing order — mtime descending, then creation time descending,
 * then path descending (pi-coding-agent dist session listing sort `t.path.localeCompare(e.path)`; its `open_session`
 * resumes the first non-empty session of that order).
 */
export function listsBefore(a: ListedSession, b: ListedSession): boolean {
	if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs > b.mtimeMs;
	if (a.createdMs !== b.createdMs) return a.createdMs > b.createdMs;
	return a.name.localeCompare(b.name) > 0;
}

/**
 * The session file omp resumes for a session dir: the first `*.jsonl` of {@link listsBefore}. ompbot keeps one active
 * session per epoch dir, so the newest file is the resumed one.
 */
export function newestSessionFile(sessionDir: string): string | undefined {
	let newest: (ListedSession & { file: string }) | undefined;
	for (const name of readdirSync(sessionDir)) {
		if (!name.endsWith(".jsonl")) continue;
		const file = join(sessionDir, name);
		const { mtimeMs, birthtimeMs } = statSync(file);
		const listed = { file, mtimeMs, createdMs: birthtimeMs, name };
		if (newest === undefined || listsBefore(listed, newest)) newest = listed;
	}
	return newest?.file;
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
 * Rewrites the `model_change` omp's restore reads to `fallback`, so the restore — which resolves those records
 * newest-first and uses the first model it knows — succeeds again. The record is picked by omp's rule (a record's role
 * is `role ?? "default"`): when the last `model_change` has role `"fallback"` (a retry hop) omp restores only the
 * default model, so the last record whose role is default is rewritten; otherwise the last record is. Every other byte
 * stays as it was: the pristine original is copied to `<backupDir>/<UTC timestamp>.jsonl` first, and the corrected
 * text lands through a temp file + rename, leaving no new `*.jsonl` in the session dir. Returns `undefined` (touching
 * nothing) when there is no such record or it already names `fallback`.
 */
export function healSessionModelFile(
	file: string,
	fallback: string,
	backupDir: string,
	now = new Date(),
): HealedSessionModel | undefined {
	const lines = readFileSync(file, "utf8").split("\n");
	const changes: Array<{ index: number; model: string; role: string }> = [];
	for (const [index, line] of lines.entries()) {
		if (line === "") continue;
		let record: { type?: unknown; model?: unknown; role?: unknown };
		try {
			record = JSON.parse(line) as { type?: unknown; model?: unknown; role?: unknown };
		} catch {
			continue;
		}
		if (record?.type !== "model_change" || typeof record.model !== "string") continue;
		changes.push({ index, model: record.model, role: typeof record.role === "string" ? record.role : "default" });
	}
	const target =
		changes.at(-1)?.role === "fallback" ? changes.findLast((change) => change.role === "default") : changes.at(-1);
	if (target === undefined || target.model === fallback) return undefined;
	const stamp = now.toISOString().replaceAll(":", "").replaceAll(".", "");
	lines[target.index] = rewriteModel(lines[target.index] ?? "", target.model, fallback);
	mkdirSync(backupDir, { recursive: true });
	copyFileSync(file, join(backupDir, `${stamp}.jsonl`));
	const temp = join(dirname(file), `.${stamp}.heal.tmp`);
	writeFileSync(temp, lines.join("\n"));
	renameSync(temp, file);
	return { file, from: target.model, to: fallback };
}
