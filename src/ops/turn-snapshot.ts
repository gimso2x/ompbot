import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Logger } from "../log";
import type { TurnSnapshotInput, TurnSnapshotRow } from "../store/db";

export type { TurnSnapshotRow };

/**
 * Turn snapshots for `!undo` (doc/plans/turn-undo.md): every conversation turn that changed a configured repository
 * leaves the work tree's before/after git trees in the ledger, so one turn's files can be put back later. Capturing
 * writes a temporary index OUTSIDE the repository (an index file inside it would itself become a new file and make
 * every turn look changed); the real index, HEAD and the work tree are never touched. A failed snapshot is logged and
 * skipped — it never blocks the turn.
 */

export interface GitOutcome {
	code: number;
	stdout: string;
	stderr: string;
}

export interface GitRunOptions {
	/** Extra environment for this call (`GIT_INDEX_FILE`, the `commit-tree` identity). */
	env?: Record<string, string>;
	timeoutMs?: number;
}

export type GitRunner = (repo: string, args: readonly string[], options?: GitRunOptions) => Promise<GitOutcome>;

export interface TreeSnapshot {
	head: string;
	tree: string;
}

/** One repository's before/after state around a turn (`startedAt` before the prompt, `endedAt` after the final). */
export interface TurnCapture {
	startedAt: number;
	endedAt: number;
	before: ReadonlyMap<string, TreeSnapshot>;
	/** Repositories whose snapshot failed are absent here. */
	after: ReadonlyMap<string, TreeSnapshot>;
}

/** What a plan does to one file. */
export interface PlannedFile {
	path: string;
	/**
	 * `revert`: put it back from the turn's before-tree (or delete it when the turn created it); `conflict`: the work
	 * tree no longer matches the turn's after-tree; `overlap`: another conversation's turn changed it too, so which
	 * change is which cannot be told apart.
	 */
	kind: "revert" | "conflict" | "overlap";
	/** `revert` only: the file existed before the turn (restore it); absent when the turn created it (delete it). */
	mode?: string;
	/** `revert` only: blob of the before-tree entry. */
	blob?: string;
}

export interface RepoPlan {
	repo: string;
	/** Tree the `revert` files come from. */
	source: string;
	/** The turn committed: no file is touched, only this advice line is shown. */
	commit?: { before: string; after: string; advice: string };
	files: PlannedFile[];
}

/** The ledger operations `recordTurn` needs (a `Store` satisfies it). */
export interface TurnSnapshotStore {
	recordTurnSnapshot(input: TurnSnapshotInput): { id: number; pruned: TurnSnapshotRow[] };
}

/** How long one repository's capture may take before that repository is skipped. */
export const TURN_SNAPSHOT_TIMEOUT_MS = 5_000;
/** Ledger rows kept per origin; the oldest row and its refs go when one more arrives. */
export const TURN_SNAPSHOT_KEEP = 20;
/** `ompbot gc` removes turn snapshots (rows and their refs) older than this. */
export const TURN_SNAPSHOT_RETENTION_DAYS = 7;

const IDENTITY = {
	GIT_AUTHOR_NAME: "ompbot",
	GIT_AUTHOR_EMAIL: "ompbot@localhost",
	GIT_COMMITTER_NAME: "ompbot",
	GIT_COMMITTER_EMAIL: "ompbot@localhost",
};

/** `refs/ompbot/turns/<id>/before` and `/after`: keeps a turn's trees alive across `git gc` until the row goes. */
export function turnRefName(id: number, which: "before" | "after"): string {
	return `refs/ompbot/turns/${id}/${which}`;
}

/** Runs git in `repo`; a timeout is a non-zero outcome, never a throw (the caller decides what a failure means). */
export const runGit: GitRunner = async (repo, args, options = {}) => {
	const timeoutMs = options.timeoutMs ?? TURN_SNAPSHOT_TIMEOUT_MS;
	try {
		const proc = Bun.spawn(["git", "-C", repo, ...args], {
			env: { ...process.env, ...options.env },
			stdout: "pipe",
			stderr: "pipe",
			signal: AbortSignal.timeout(timeoutMs),
		});
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const code = await proc.exited;
		return { code: code ?? 1, stdout, stderr };
	} catch (error) {
		return { code: 124, stdout: "", stderr: `git ${args[0] ?? ""} failed: ${String(error)}` };
	}
};

/** Trimmed stdout of a call that must succeed; a non-zero exit throws with git's own words. */
async function required(
	run: GitRunner,
	repo: string,
	args: readonly string[],
	options?: GitRunOptions,
): Promise<string> {
	const outcome = await run(repo, args, options);
	if (outcome.code !== 0) throw new Error(`git ${args.join(" ")}: ${outcome.stderr.trim() || `exit ${outcome.code}`}`);
	return outcome.stdout.trim();
}

/** A path that is not inside `repo` (an index there would show up as a new file and change every turn's tree). */
function temporaryIndexPath(repo: string): string {
	const base = realpathSync(tmpdir());
	const root = realpathSync(repo);
	const chosen = base.startsWith(`${root}/`) ? "/tmp" : base;
	return join(chosen, `ompbot-turn-index-${randomUUID()}`);
}

/** Head and tree of the work tree as it is now, through a temporary index outside the repository. */
export async function captureTree(repo: string, options: { run?: GitRunner } = {}): Promise<TreeSnapshot> {
	const run = options.run ?? runGit;
	const deadline = Date.now() + TURN_SNAPSHOT_TIMEOUT_MS;
	const left = (): number => Math.max(1, deadline - Date.now());
	const indexFile = temporaryIndexPath(repo);
	const env = { GIT_INDEX_FILE: indexFile };
	try {
		const head = await required(run, repo, ["rev-parse", "HEAD"], { timeoutMs: left() });
		// Seeded from HEAD so files deleted since the commit are known to the throwaway index; `add -A` then picks up
		// every tracked change and every untracked file `.gitignore` does not exclude.
		await required(run, repo, ["read-tree", "HEAD"], { env, timeoutMs: left() });
		await required(run, repo, ["add", "-A", "--", "."], { env, timeoutMs: left() });
		const tree = await required(run, repo, ["write-tree"], { env, timeoutMs: left() });
		return { head, tree };
	} finally {
		rmSync(indexFile, { force: true });
		rmSync(`${indexFile}.lock`, { force: true });
	}
}

/**
 * `captureTree` for several repositories in parallel. A repository that fails (not a git work tree, git too slow) is
 * logged as `turn_snapshot_failed` and missing from the result; the turn goes on with the others.
 */
export async function captureTrees(
	repos: readonly string[],
	options: { run?: GitRunner; log?: Logger } = {},
): Promise<Map<string, TreeSnapshot>> {
	const captured = await Promise.all(
		repos.map(async (repo) => {
			try {
				return [repo, await captureTree(repo, options)] as const;
			} catch (error) {
				options.log?.warn("turn_snapshot_failed", { repo, error: String(error) });
				return undefined;
			}
		}),
	);
	return new Map(captured.filter((entry) => entry !== undefined));
}

/** Wraps a tree in a commit and points `refs/ompbot/turns/<id>/<which>` at it, so `git gc` keeps it. */
async function preserveTree(
	run: GitRunner,
	repo: string,
	id: number,
	which: "before" | "after",
	tree: string,
): Promise<void> {
	const commit = await required(run, repo, ["commit-tree", tree, "-m", `ompbot turn ${id} ${which}`], {
		env: IDENTITY,
	});
	await required(run, repo, ["update-ref", turnRefName(id, which), commit]);
}

/**
 * Writes one ledger row per repository the turn changed (its refs included) and drops the refs of the rows the ledger
 * pruned; returns how many rows it wrote. A repository whose snapshot failed on either side is skipped.
 */
export async function recordTurn(options: {
	store: TurnSnapshotStore;
	originKey: string;
	opRef: string;
	capture: TurnCapture;
	run?: GitRunner;
	log?: Logger;
}): Promise<number> {
	const run = options.run ?? runGit;
	let written = 0;
	for (const [repo, after] of options.capture.after) {
		const before = options.capture.before.get(repo);
		if (before === undefined) continue;
		if (before.head === after.head && before.tree === after.tree) continue;
		let recorded: { id: number; pruned: TurnSnapshotRow[] };
		try {
			recorded = options.store.recordTurnSnapshot({
				originKey: options.originKey,
				opRef: options.opRef,
				repo,
				headBefore: before.head,
				treeBefore: before.tree,
				headAfter: after.head,
				treeAfter: after.tree,
				startedAt: options.capture.startedAt,
				endedAt: options.capture.endedAt,
			});
		} catch (error) {
			options.log?.warn("turn_snapshot_record_failed", { repo, error: String(error) });
			continue;
		}
		written += 1;
		for (const [which, snapshot] of [
			["before", before],
			["after", after],
		] as const) {
			try {
				await preserveTree(run, repo, recorded.id, which, snapshot.tree);
			} catch (error) {
				options.log?.warn("turn_snapshot_ref_failed", { repo, id: recorded.id, which, error: String(error) });
			}
		}
		if (recorded.pruned.length > 0) await removeTurnRefs(recorded.pruned, { run, log: options.log });
	}
	return written;
}

/** Paths of one tree: mode and blob of every file (`ls-tree -r -z`, so no path is quoted or split). */
async function treeEntries(
	run: GitRunner,
	repo: string,
	tree: string,
): Promise<Map<string, { mode: string; blob: string }>> {
	const listing = await required(run, repo, ["ls-tree", "-r", "-z", tree]);
	const entries = new Map<string, { mode: string; blob: string }>();
	for (const record of listing.split("\0")) {
		if (record === "") continue;
		const tab = record.indexOf("\t");
		if (tab < 0) continue;
		const [mode, type, blob] = record.slice(0, tab).split(" ");
		if (mode === undefined || type !== "blob" || blob === undefined) continue;
		entries.set(record.slice(tab + 1), { mode, blob });
	}
	return entries;
}

/** Paths whose content or mode differ between two trees (`git diff --name-status -z`, renames kept as add+delete). */
async function changedPaths(run: GitRunner, repo: string, from: string, to: string): Promise<string[]> {
	const listing = await required(run, repo, ["diff", "--name-status", "--no-renames", "-z", from, to]);
	const parts = listing.split("\0");
	const paths: string[] = [];
	// Pairs of `<status>` and `<path>`; an empty trailing part is the split's own artifact.
	for (let i = 0; i + 1 < parts.length; i += 2) {
		const path = parts[i + 1];
		if (path !== undefined && path !== "") paths.push(path);
	}
	return paths;
}

/** The git mode of a path in the work tree, or undefined when nothing (or a directory) is there. */
function workTreeMode(full: string): string | undefined {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(full);
	} catch {
		return undefined;
	}
	if (stat.isSymbolicLink()) return "120000";
	if (!stat.isFile()) return undefined;
	return (stat.mode & 0o111) === 0 ? "100644" : "100755";
}

/**
 * Whether the work tree still holds exactly the tree's entry for `path`. A turn-created file must be gone, a
 * turn-deleted file must not be back, and everything else must match blob and mode.
 */
async function stillMatches(
	run: GitRunner,
	repo: string,
	entries: Map<string, { mode: string; blob: string }>,
	path: string,
): Promise<boolean> {
	const entry = entries.get(path);
	const full = join(repo, path);
	const mode = workTreeMode(full);
	if (entry === undefined) return mode === undefined;
	if (mode !== entry.mode) return false;
	const hash = await required(run, repo, ["hash-object", "--", path]);
	return hash === entry.blob;
}

/** Files another turn changed too while its window overlapped this one's. */
async function overlapPaths(
	run: GitRunner,
	row: TurnSnapshotRow,
	others: readonly TurnSnapshotRow[],
): Promise<Set<string>> {
	const overlapping = others.filter(
		(other) =>
			other.id !== row.id &&
			other.repo === row.repo &&
			// Half-open windows: a turn that started exactly when another ended is sequential, not overlapping.
			other.startedAt < row.endedAt &&
			row.startedAt < other.endedAt,
	);
	const sets = await Promise.all(
		overlapping.map((other) => changedPaths(run, row.repo, other.treeBefore, other.treeAfter).catch(() => [])),
	);
	return new Set(sets.flat());
}

/** What `!undo` would do to one row's repository. Never writes: the card and the re-check both read this. */
export async function planUndo(options: {
	row: TurnSnapshotRow;
	others?: readonly TurnSnapshotRow[];
	run?: GitRunner;
}): Promise<RepoPlan> {
	const run = options.run ?? runGit;
	const { row } = options;
	// The turn committed: its files are already in history, so no work-tree file is touched.
	if (row.headBefore !== row.headAfter) {
		return {
			repo: row.repo,
			source: row.treeBefore,
			commit: {
				before: row.headBefore,
				after: row.headAfter,
				advice: `git -C ${row.repo} revert --no-edit ${row.headBefore}..${row.headAfter}`,
			},
			files: [],
		};
	}
	const [paths, before, after, overlap] = await Promise.all([
		changedPaths(run, row.repo, row.treeBefore, row.treeAfter),
		treeEntries(run, row.repo, row.treeBefore),
		treeEntries(run, row.repo, row.treeAfter),
		overlapPaths(run, row, options.others ?? []),
	]);
	const files: PlannedFile[] = [];
	for (const path of paths) {
		if (overlap.has(path)) {
			files.push({ path, kind: "overlap" });
			continue;
		}
		if (!(await stillMatches(run, row.repo, after, path))) {
			files.push({ path, kind: "conflict" });
			continue;
		}
		const entry = before.get(path);
		files.push(entry === undefined ? { path, kind: "revert" } : { path, kind: "revert", ...entry });
	}
	return { repo: row.repo, source: row.treeBefore, files };
}

/**
 * Performs a plan's `revert` files: `git restore --source=<before-tree> --worktree` (mode and executable bit come from
 * the tree, the real index is untouched) or, for a file the turn created, a plain delete. Conflicts and overlaps are
 * left exactly as they are.
 */
export async function applyUndo(plan: RepoPlan, options: { run?: GitRunner } = {}): Promise<void> {
	const run = options.run ?? runGit;
	for (const file of plan.files) {
		if (file.kind !== "revert") continue;
		if (file.mode === undefined) {
			rmSync(join(plan.repo, file.path), { force: true });
			continue;
		}
		await required(run, plan.repo, ["restore", `--source=${plan.source}`, "--worktree", "--", file.path]);
	}
}

/** Deletes the refs of rows that are leaving the ledger; returns the ref names it removed. */
export async function removeTurnRefs(
	rows: readonly TurnSnapshotRow[],
	options: { run?: GitRunner; log?: Logger } = {},
): Promise<string[]> {
	const run = options.run ?? runGit;
	const removed: string[] = [];
	for (const row of rows) {
		for (const which of ["before", "after"] as const) {
			const ref = turnRefName(row.id, which);
			const outcome = await run(row.repo, ["update-ref", "-d", ref]);
			if (outcome.code === 0) removed.push(ref);
			else options.log?.debug("turn_snapshot_ref_absent", { repo: row.repo, ref });
		}
	}
	return removed;
}

/**
 * `removeTurnRefs` for `ompbot gc`, which runs synchronously: same refs, one `git update-ref -d` each. Rows whose
 * repository is gone are skipped silently (nothing left to release).
 */
export function removeTurnRefsSync(rows: readonly Pick<TurnSnapshotRow, "id" | "repo">[]): string[] {
	const removed: string[] = [];
	for (const row of rows) {
		for (const which of ["before", "after"] as const) {
			const ref = turnRefName(row.id, which);
			const outcome = Bun.spawnSync(["git", "-C", row.repo, "update-ref", "-d", ref], {
				stdout: "pipe",
				stderr: "pipe",
			});
			if (outcome.exitCode === 0) removed.push(ref);
		}
	}
	return removed;
}

/** Whether `repos` names a git work tree: absolute and holding a `.git` (a directory, or a file in a linked worktree). */
export function isGitWorkTree(repo: string): boolean {
	if (!isAbsolute(repo)) return false;
	const root = resolve(repo);
	const rel = relative(root, resolve(root, ".git"));
	if (rel === "" || rel.startsWith("..")) return false;
	try {
		return lstatSync(join(root, ".git")).isDirectory() || lstatSync(join(root, ".git")).isFile();
	} catch {
		return false;
	}
}
