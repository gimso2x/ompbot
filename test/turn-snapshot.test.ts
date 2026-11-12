// Turn snapshots and `!undo` plans (doc/plans/turn-undo.md §B–D): the work tree of a configured repository is captured
// into git trees without touching the real index, a turn's plan puts exactly its own files back, and the ledger keeps
// the newest rows per origin.
import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gcSessions } from "../src/ops/gc";
import {
	applyUndo,
	captureTree,
	type GitRunner,
	planUndo,
	recordTurn,
	removeTurnRefs,
	runGit,
	type TurnSnapshotRow,
	undoPlanNotes,
} from "../src/ops/turn-snapshot";
import { openStore, type Store } from "../src/store/db";
import { git, makeRepo } from "./helpers/git-fixtures";

const repos: string[] = [];
const stores: Store[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

const clock = { now: () => 1_000_000 };

function newStore(): Store {
	const dir = mkdtempSync(join(tmpdir(), "ompbot-turn-store-"));
	const store = openStore({ timezone: "Asia/Seoul", path: join(dir, "ompbot.db"), clock, redact: (text) => text });
	stores.push(store);
	return store;
}

/** A ledger row of one repository's turn, as `recordTurn` would leave it. */
function rowOf(
	snapshots: { before: { head: string; tree: string }; after: { head: string; tree: string } },
	extra: Partial<TurnSnapshotRow> = {},
): TurnSnapshotRow {
	return {
		id: 1,
		originKey: "slack/dm/D1",
		opRef: "fake_req_1",
		repo: repos[0] ?? "",
		headBefore: snapshots.before.head,
		treeBefore: snapshots.before.tree,
		headAfter: snapshots.after.head,
		treeAfter: snapshots.after.tree,
		startedAt: 1000,
		endedAt: 2000,
		revertedAt: null,
		...extra,
	};
}

const execBit = (path: string): boolean => (statSync(path).mode & 0o111) !== 0;

describe("captureTree (AC-1)", () => {
	test("captures a tracked modification and a new file, skips ignored ones, and leaves index and work tree alone", async () => {
		const repo = makeRepo(repos);
		writeFileSync(join(repo, ".gitignore"), "ignored/\n");
		git(repo, "add", "--", ".gitignore");
		git(repo, "commit", "-q", "-m", "ignore");
		mkdirSync(join(repo, "ignored"));
		writeFileSync(join(repo, "ignored", "junk.txt"), "junk\n");
		writeFileSync(join(repo, "README.md"), "changed\n");
		writeFileSync(join(repo, "fresh.txt"), "new\n");
		const statusBefore = git(repo, "status", "--porcelain");
		const cachedBefore = git(repo, "diff", "--cached");

		const snapshot = await captureTree(repo);

		const listed = git(repo, "ls-tree", "-r", "--name-only", snapshot.tree).split("\n").filter(Boolean);
		expect(listed).toContain("README.md");
		expect(listed).toContain("fresh.txt");
		expect(listed).not.toContain("ignored/junk.txt");
		expect(snapshot.head).toBe(git(repo, "rev-parse", "HEAD"));
		expect(git(repo, "status", "--porcelain")).toBe(statusBefore);
		expect(git(repo, "diff", "--cached")).toBe(cachedBefore);
		expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("changed\n");

		const again = await captureTree(repo);
		expect(again.tree).toBe(snapshot.tree);
		expect(git(repo, "status", "--porcelain")).toBe(statusBefore);
	});

	test("keeps the executable bit and leaves a deleted file out of the tree", async () => {
		const repo = makeRepo(repos);
		writeFileSync(join(repo, "run.sh"), "#!/bin/sh\n");
		git(repo, "add", "--", "run.sh");
		git(repo, "commit", "-q", "-m", "run");
		git(repo, "update-index", "--chmod=+x", "run.sh");
		git(repo, "commit", "-q", "-m", "exec");
		Bun.spawnSync(["chmod", "+x", join(repo, "run.sh")]);
		rmSync(join(repo, "README.md"));

		const snapshot = await captureTree(repo);
		const listing = git(repo, "ls-tree", "-r", snapshot.tree);
		expect(listing).toContain("100755 ");
		expect(listing).toContain("run.sh");
		expect(listing).not.toContain("README.md");
	});

	test("TMPDIR equal to the repository root keeps the temporary index outside it (J-14)", async () => {
		const repo = makeRepo(repos);
		const saved = process.env.TMPDIR;
		process.env.TMPDIR = repo;
		try {
			const first = await captureTree(repo);
			const second = await captureTree(repo);
			expect(second.tree).toBe(first.tree);
			expect(git(repo, "ls-tree", "-r", "--name-only", first.tree)).not.toContain("ompbot-turn-index-");
		} finally {
			if (saved === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = saved;
		}
	});
});

describe("symlink undo (J-15)", () => {
	test("a turn that only retargets a symlink reverts it instead of calling it a conflict", async () => {
		const repo = makeRepo(repos);
		writeFileSync(join(repo, "a.txt"), "a\n");
		writeFileSync(join(repo, "b.txt"), "b\n");
		symlinkSync("a.txt", join(repo, "link"));
		git(repo, "add", "--", "a.txt", "b.txt", "link");
		git(repo, "commit", "-q", "-m", "link");
		const before = await captureTree(repo);
		rmSync(join(repo, "link"));
		symlinkSync("b.txt", join(repo, "link"));
		const after = await captureTree(repo);

		const plan = await planUndo({ row: rowOf({ before, after }) });
		expect(plan.files.map((file) => [file.path, file.kind])).toEqual([["link", "revert"]]);
		await applyUndo(plan);
		expect(readlinkSync(join(repo, "link"))).toBe("a.txt");
	});
});

describe("planUndo / applyUndo (AC-2)", () => {
	test("restores a modification, a creation and a deletion (with the executable bit)", async () => {
		const repo = makeRepo(repos);
		writeFileSync(join(repo, "mod.txt"), "one\n");
		writeFileSync(join(repo, "gone.sh"), "#!/bin/sh\n");
		git(repo, "add", "--", "mod.txt", "gone.sh");
		git(repo, "commit", "-q", "-m", "files");
		git(repo, "update-index", "--chmod=+x", "gone.sh");
		git(repo, "commit", "-q", "-m", "exec");
		Bun.spawnSync(["chmod", "+x", join(repo, "gone.sh")]);
		const before = await captureTree(repo);

		writeFileSync(join(repo, "mod.txt"), "two\n");
		writeFileSync(join(repo, "created.txt"), "new\n");
		rmSync(join(repo, "gone.sh"));
		const after = await captureTree(repo);

		const plan = await planUndo({ row: rowOf({ before, after }) });
		expect(plan.commit).toBeUndefined();
		expect(plan.files.map((file) => [file.path, file.kind]).sort()).toEqual([
			["created.txt", "revert"],
			["gone.sh", "revert"],
			["mod.txt", "revert"],
		]);

		await applyUndo(plan);
		expect(readFileSync(join(repo, "mod.txt"), "utf8")).toBe("one\n");
		expect(existsSync(join(repo, "created.txt"))).toBe(false);
		expect(readFileSync(join(repo, "gone.sh"), "utf8")).toBe("#!/bin/sh\n");
		expect(execBit(join(repo, "gone.sh"))).toBe(true);
		// HEAD and the real index were never touched.
		expect(git(repo, "diff", "--cached")).toBe("");
	});

	test("a file edited again after the turn, or one the turn deleted and someone recreated, is a conflict", async () => {
		const repo = makeRepo(repos);
		writeFileSync(join(repo, "mod.txt"), "one\n");
		writeFileSync(join(repo, "gone.txt"), "gone\n");
		git(repo, "add", "--", "mod.txt", "gone.txt");
		git(repo, "commit", "-q", "-m", "files");
		const before = await captureTree(repo);

		writeFileSync(join(repo, "mod.txt"), "two\n");
		rmSync(join(repo, "gone.txt"));
		const after = await captureTree(repo);
		writeFileSync(join(repo, "mod.txt"), "edited later\n");
		writeFileSync(join(repo, "gone.txt"), "recreated\n");

		const plan = await planUndo({ row: rowOf({ before, after }) });
		expect(plan.files.map((file) => [file.path, file.kind]).sort()).toEqual([
			["gone.txt", "conflict"],
			["mod.txt", "conflict"],
		]);
		await applyUndo(plan);
		expect(readFileSync(join(repo, "mod.txt"), "utf8")).toBe("edited later\n");
		expect(readFileSync(join(repo, "gone.txt"), "utf8")).toBe("recreated\n");
	});

	test("overlapping turns: B's undo restores only its own file and leaves the shared one as overlap", async () => {
		const repo = makeRepo(repos);
		// B's window opens before A's turn ends, so B's own before/after diff also carries A's file.
		const base = await captureTree(repo);
		writeFileSync(join(repo, "foo.txt"), "foo\n");
		const aAfter = await captureTree(repo);
		writeFileSync(join(repo, "bar.txt"), "bar\n");
		const bAfter = await captureTree(repo);

		const a = rowOf(
			{ before: base, after: aAfter },
			{ id: 1, originKey: "slack/dm/DA", startedAt: 1000, endedAt: 2000 },
		);
		const b = rowOf(
			{ before: base, after: bAfter },
			{ id: 2, originKey: "slack/dm/DB", startedAt: 1500, endedAt: 3000 },
		);

		const plan = await planUndo({ row: b, others: [a] });
		expect(plan.files.map((file) => [file.path, file.kind]).sort()).toEqual([
			["bar.txt", "revert"],
			["foo.txt", "overlap"],
		]);
		await applyUndo(plan);
		expect(existsSync(join(repo, "bar.txt"))).toBe(false);
		expect(readFileSync(join(repo, "foo.txt"), "utf8")).toBe("foo\n");

		// A's own file was never ambiguous, so A's undo puts it away.
		// The rule is symmetric: while B's window is open, A's file is ambiguous for A's undo too.
		const aPlan = await planUndo({ row: a, others: [b] });
		expect(aPlan.files.map((file) => [file.path, file.kind])).toEqual([["foo.txt", "overlap"]]);
	});

	test("an overlapping turn whose paths cannot be read makes every file of the repository an overlap (#94)", async () => {
		const repo = makeRepo(repos);
		const base = await captureTree(repo);
		writeFileSync(join(repo, "foo.txt"), "foo\n");
		const aAfter = await captureTree(repo);
		writeFileSync(join(repo, "bar.txt"), "bar\n");
		const bAfter = await captureTree(repo);
		const a = rowOf(
			{ before: base, after: aAfter },
			{ id: 1, originKey: "slack/dm/DA", startedAt: 1000, endedAt: 2000 },
		);
		const b = rowOf(
			{ before: base, after: bAfter },
			{ id: 2, originKey: "slack/dm/DB", startedAt: 1500, endedAt: 3000 },
		);
		// Only the other row's diff fails; the row's own diff and tree listings still work.
		const failing: GitRunner = async (dir, args, options) => {
			if (args[0] === "diff" && args.includes(aAfter.tree))
				return { code: 128, stdout: "", stderr: "fatal: bad object" };
			return runGit(dir, args, options);
		};

		const plan = await planUndo({ row: b, others: [a], run: failing });
		expect(plan.files.map((file) => [file.path, file.kind]).sort()).toEqual([
			["bar.txt", "overlap"],
			["foo.txt", "overlap"],
		]);
		expect(plan.files.filter((file) => file.kind === "revert")).toHaveLength(0);
		await applyUndo(plan);
		expect(readFileSync(join(repo, "bar.txt"), "utf8")).toBe("bar\n");

		expect(plan.overlapFailed).toContain("bad object");
		expect(undoPlanNotes(plan).join("\n")).toContain(`겹침 확인 실패: ${repo}`);
	});

	test("sequential turns (A then B) do not mix: B's plan holds only B's file", async () => {
		const repo = makeRepo(repos);
		const base = await captureTree(repo);
		writeFileSync(join(repo, "foo.txt"), "foo\n");
		const aAfter = await captureTree(repo);
		writeFileSync(join(repo, "bar.txt"), "bar\n");
		const bAfter = await captureTree(repo);

		const a = rowOf(
			{ before: base, after: aAfter },
			{ id: 1, originKey: "slack/dm/DA", startedAt: 1000, endedAt: 2000 },
		);
		const b = rowOf(
			{ before: aAfter, after: bAfter },
			{ id: 2, originKey: "slack/dm/DA", startedAt: 2500, endedAt: 3000 },
		);

		const plan = await planUndo({ row: b, others: [a] });
		expect(plan.files.map((file) => [file.path, file.kind])).toEqual([["bar.txt", "revert"]]);
	});

	test("a nested repository (gitlink) the turn moved is a conflict; the undo finishes and keeps it (#46)", async () => {
		const repo = makeRepo(repos);
		const inner = join(repo, "vendor", "dep");
		mkdirSync(inner, { recursive: true });
		git(inner, "init", "-q");
		writeFileSync(join(inner, "f.txt"), "one\n");
		git(inner, "add", "f.txt");
		git(inner, "commit", "-q", "-m", "one");
		writeFileSync(join(repo, "mod.txt"), "one\n");
		const before = await captureTree(repo);

		writeFileSync(join(inner, "f.txt"), "two\n");
		git(inner, "commit", "-qam", "two");
		writeFileSync(join(repo, "mod.txt"), "two\n");
		const after = await captureTree(repo);

		const plan = await planUndo({ row: rowOf({ before, after }) });
		expect(plan.files.map((file) => [file.path, file.kind]).sort()).toEqual([
			["mod.txt", "revert"],
			["vendor/dep", "conflict"],
		]);
		expect(await applyUndo(plan)).toEqual({ reverted: 1, conflicts: [] });
		expect(readFileSync(join(repo, "mod.txt"), "utf8")).toBe("one\n");
		expect(readFileSync(join(inner, "f.txt"), "utf8")).toBe("two\n");
	});

	test("a revert that would delete a directory leaves it and reports it as a conflict instead of throwing", async () => {
		const repo = makeRepo(repos);
		const before = await captureTree(repo);
		mkdirSync(join(repo, "dir"));
		writeFileSync(join(repo, "dir", "keep.txt"), "keep\n");
		writeFileSync(join(repo, "made.txt"), "made\n");
		const result = await applyUndo({
			repo,
			source: before.tree,
			files: [
				{ path: "dir", kind: "revert" },
				{ path: "made.txt", kind: "revert" },
			],
		});
		expect(result).toEqual({ reverted: 1, conflicts: ["dir"] });
		expect(readFileSync(join(repo, "dir", "keep.txt"), "utf8")).toBe("keep\n");
		expect(existsSync(join(repo, "made.txt"))).toBe(false);
	});

	test("a turn that committed touches no file and answers with the revert advice", async () => {
		const repo = makeRepo(repos);
		const before = await captureTree(repo);
		writeFileSync(join(repo, "committed.txt"), "x\n");
		git(repo, "add", "--", "committed.txt");
		git(repo, "commit", "-q", "-m", "turn commit");
		const after = await captureTree(repo);

		const plan = await planUndo({ row: rowOf({ before, after }) });
		expect(plan.commit?.before).toBe(before.head);
		expect(plan.commit?.after).toBe(after.head);
		expect(plan.commit?.advice).toContain(`git -C ${repo} revert --no-edit ${before.head}..${after.head}`);
		expect(plan.files).toEqual([]);
		await applyUndo(plan);
		expect(readFileSync(join(repo, "committed.txt"), "utf8")).toBe("x\n");
	});

	test("a file named like pathspec magic is restored alone; other uncommitted changes stay (qa-d M-1)", async () => {
		const repo = makeRepo(repos);
		const magic = ":(glob)**";
		writeFileSync(join(repo, "a.txt"), "base-a\n");
		writeFileSync(join(repo, magic), "base-magic\n");
		git(repo, "--literal-pathspecs", "add", "--", "a.txt", magic);
		git(repo, "commit", "-q", "-m", "magic name");
		const before = await captureTree(repo);
		writeFileSync(join(repo, magic), "turn\n");
		const after = await captureTree(repo);
		writeFileSync(join(repo, "a.txt"), "USER\n");

		const plan = await planUndo({ row: rowOf({ before, after }) });
		expect(plan.files.map((file) => [file.path, file.kind])).toEqual([[magic, "revert"]]);
		await applyUndo(plan);
		expect(readFileSync(join(repo, magic), "utf8")).toBe("base-magic\n");
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("USER\n");
	});
});

describe("ledger retention and refs (AC-4)", () => {
	test("the 21st row drops the oldest row of that origin and returns it for ref cleanup", () => {
		const store = newStore();
		const repo = makeRepo(repos);
		let pruned: TurnSnapshotRow[] = [];
		for (let i = 0; i < 21; i++) {
			const recorded = store.recordTurnSnapshot({
				originKey: "slack/dm/D1",
				opRef: `op_${i}`,
				repo,
				headBefore: "h0",
				treeBefore: "t0",
				headAfter: "h1",
				treeAfter: "t1",
				startedAt: i,
				endedAt: i + 1,
			});
			pruned = recorded.pruned;
		}
		expect(pruned.map((row) => row.opRef)).toEqual(["op_0"]);
		const kept = store.listTurnSnapshots({ originKey: "slack/dm/D1" });
		expect(kept).toHaveLength(20);
		expect(kept.map((row) => row.opRef)).not.toContain("op_0");
		// Another origin keeps its own rows.
		store.recordTurnSnapshot({
			originKey: "slack/dm/D2",
			opRef: "other",
			repo,
			headBefore: "h0",
			treeBefore: "t0",
			headAfter: "h1",
			treeAfter: "t1",
			startedAt: 1,
			endedAt: 2,
		});
		expect(store.listTurnSnapshots({ originKey: "slack/dm/D2" })).toHaveLength(1);
	});

	test("recordTurn keeps the turn's before/after trees under refs/ompbot/turns/<id>, and removeTurnRefs drops them", async () => {
		const store = newStore();
		const repo = makeRepo(repos);
		const base = await captureTree(repo);
		writeFileSync(join(repo, "x.txt"), "x\n");
		const after = await captureTree(repo);

		const written = await recordTurn({
			store,
			originKey: "slack/dm/D1",
			opRef: "op",
			capture: { startedAt: 1, endedAt: 2, before: new Map([[repo, base]]), after: new Map([[repo, after]]) },
		});
		expect(written).toBe(1);
		const rows = store.listTurnSnapshots({ originKey: "slack/dm/D1" });
		expect(rows).toHaveLength(1);
		const id = rows[0]?.id as number;
		expect(git(repo, "rev-parse", `refs/ompbot/turns/${id}/before^{tree}`)).toBe(base.tree);
		expect(git(repo, "rev-parse", `refs/ompbot/turns/${id}/after^{tree}`)).toBe(after.tree);

		expect((await removeTurnRefs(rows)).length).toBe(2);
		expect(git(repo, "for-each-ref", "refs/ompbot/turns")).toBe("");
	});

	test("gc removes rows older than 7 days (and only those) and drops their refs", async () => {
		const home = mkdtempSync(join(tmpdir(), "ompbot-turn-gc-"));
		const repo = makeRepo(repos);
		const dbPath = join(home, "ompbot.db");
		const now = 1_700_000_000_000;
		const day = 24 * 60 * 60 * 1000;
		const store = openStore({
			timezone: "Asia/Seoul",
			path: dbPath,
			clock: { now: () => now },
			redact: (text) => text,
		});
		const base = await captureTree(repo);
		writeFileSync(join(repo, "x.txt"), "x\n");
		const after = await captureTree(repo);

		/** One recorded turn (with its refs) whose end sits `daysAgo` days before `now`. */
		async function record(daysAgo: number): Promise<number> {
			const endedAt = now - daysAgo * day;
			const opRef = `op_${daysAgo}`;
			await recordTurn({
				store,
				originKey: "slack/dm/D1",
				opRef,
				capture: { startedAt: endedAt - 1, endedAt, before: new Map([[repo, base]]), after: new Map([[repo, after]]) },
			});
			const rows = store.listTurnSnapshots({ originKey: "slack/dm/D1" });
			const row = rows.find((candidate) => candidate.opRef === opRef);
			if (row === undefined) throw new Error(`row ${opRef} was not recorded`);
			return row.id;
		}

		const oldId = await record(8);
		const freshId = await record(1);
		store.close();

		// A dry run counts what a real run would release and changes nothing (J-12).
		const dry = gcSessions({ homeDir: home, retentionDays: 30, now, dryRun: true });
		expect(dry.turnSnapshotsRemoved).toBe(1);
		expect(git(repo, "for-each-ref", "--format=%(refname)", "refs/ompbot/turns").split("\n")).toHaveLength(4);

		const result = gcSessions({ homeDir: home, retentionDays: 30, now });
		expect(result.turnSnapshotsRemoved).toBe(1);
		const reopened = openStore({
			timezone: "Asia/Seoul",
			path: dbPath,
			clock: { now: () => now },
			redact: (text) => text,
		});
		stores.push(reopened);
		const kept = reopened.listTurnSnapshots({ originKey: "slack/dm/D1" });
		expect(kept.map((row) => row.id)).toEqual([freshId]);
		expect(git(repo, "for-each-ref", "--format=%(refname)", "refs/ompbot/turns")).toBe(
			`refs/ompbot/turns/${freshId}/after\nrefs/ompbot/turns/${freshId}/before`,
		);
		expect(oldId).toBeGreaterThan(0);
		rmSync(home, { recursive: true, force: true });
	});

	test("recordTurn writes nothing for a turn that changed nothing", async () => {
		const store = newStore();
		const repo = makeRepo(repos);
		const base = await captureTree(repo);
		const written = await recordTurn({
			store,
			originKey: "slack/dm/D1",
			opRef: "op",
			capture: { startedAt: 1, endedAt: 2, before: new Map([[repo, base]]), after: new Map([[repo, base]]) },
		});
		expect(written).toBe(0);
		expect(store.listTurnSnapshots({ originKey: "slack/dm/D1" })).toEqual([]);
	});
});
