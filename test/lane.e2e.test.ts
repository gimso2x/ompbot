// Timers below are failure bounds only (the awaited signal is a file change or a log event), never fixed waits.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaneHistoryEntry, LaneMeta, LaneStatus } from "../src/lanes/status";
import { localDay } from "../src/time";
import { makeHome, type TestHome } from "./helpers/bot-home";
import {
	expectNoProcessesMentioning,
	killSpawned,
	runMain,
	type SpawnedDaemon,
	spawnDaemon,
	TransportLog,
} from "./helpers/daemon-process";
import { pickE2eModel } from "./helpers/omp-model";

/**
 * Work-lane E2E: a REAL omp lane behind the real daemon process, file-backed fake Slack, temp OMPBOT_HOME with FAKE
 * tokens and a throwaway git repository (the lane works in its own worktree beside it). Costs tokens: OMPBOT_E2E_OMP=1 only. Judged by the registry, git and the
 * delivered Slack calls; waits are on daemon log events and file changes, never fixed sleeps.
 */
const enabled = process.env.OMPBOT_E2E_OMP === "1";
if (!enabled) console.log("[skip] lane.e2e.test.ts: set OMPBOT_E2E_OMP=1 to run against a real omp (costs tokens)");

const OMP_EXECUTABLE = process.env.OMPBOT_OMP_EXECUTABLE ?? Bun.which("omp") ?? "omp";
// Model is picked from what the real omp offers (no tokens), so a stale default skips instead of dispatch-failing.
const picked = enabled ? await pickE2eModel(OMP_EXECUTABLE) : undefined;
if (enabled && picked?.model === undefined)
	console.log(`[skip] lane.e2e.test.ts: ${picked?.reason ?? "no model offered"}`);
const model = picked?.model;
const REAL = model === undefined ? undefined : { ompExecutable: OMP_EXECUTABLE, model };
const ORIGIN = "slack/dm/D1";
const CHANNEL = "D1";
const SCENARIO_TIMEOUT_MS = 480_000;
const EVENT_TIMEOUT_MS = 300_000;

let home: TestHome | undefined;
let repoParent: string | undefined;

afterEach(async () => {
	killSpawned();
	if (home) await expectNoProcessesMentioning(home.dir);
	home?.remove();
	home = undefined;
	if (repoParent) rmSync(repoParent, { recursive: true, force: true });
	repoParent = undefined;
});

async function git(repo: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
	return stdout.trim();
}

/** `<tmp>/lane-repo` with one initial commit. `blockCommits` installs a pre-commit hook that always refuses. */
async function makeRepo(blockCommits: boolean): Promise<string> {
	repoParent = mkdtempSync(join(tmpdir(), "ompbot-lane-"));
	const repo = join(repoParent, "lane-repo");
	mkdirSync(repo);
	await git(repo, "init", "-q");
	await git(repo, "config", "user.name", "ompbot test");
	await git(repo, "config", "user.email", "ompbot-test@example.invalid");
	writeFileSync(join(repo, "README.md"), "# lane repo\n");
	await git(repo, "add", "README.md");
	await git(repo, "commit", "-q", "-m", "initial");
	if (blockCommits) {
		const hook = join(repo, ".git", "hooks", "pre-commit");
		writeFileSync(hook, "#!/bin/sh\necho 'commits are disabled in this repository' >&2\nexit 1\n", { mode: 0o755 });
	}
	return realRepoPath(repo);
}

const realRepoPath = (path: string): string => Bun.spawnSync(["realpath", path]).stdout.toString().trim();

/** The worktree the first lane of a fresh bot home gets beside `repo` (`<repo>-l-<today KST>-01`). */
const firstLaneWorktree = (repo: string): string => `${repo}-l-${localDay(Date.now(), "Asia/Seoul")}-01`;

function newHome(): TestHome {
	const made = makeHome("ompbot-e2e-lane-", REAL);
	writeFileSync(join(made.dir, "secrets", "slack-bot-token"), "xoxb-TEST-SECRET-0\n", { mode: 0o600 });
	writeFileSync(join(made.dir, "secrets", "slack-app-token"), "xapp-TEST-SECRET-0\n", { mode: 0o600 });
	return made;
}

interface LaneSnapshot {
	status: LaneStatus;
	threadRef: string;
	history: LaneHistoryEntry[];
	meta: LaneMeta;
}

/** Read-only look at the registry (never opens a `Store`, which would touch the live daemon's rows). */
function readLane(homeDir: string, name: string): LaneSnapshot {
	const db = new Database(join(homeDir, "ompbot.db"), { readonly: true, strict: true });
	try {
		const row = db.query("SELECT status, thread_ref, history, meta FROM lanes WHERE name = ?").get(name) as {
			status: LaneStatus;
			thread_ref: string;
			history: string;
			meta: string;
		} | null;
		if (!row) throw new Error(`lane ${name} is not in the registry`);
		return {
			status: row.status,
			threadRef: row.thread_ref,
			history: JSON.parse(row.history) as LaneHistoryEntry[],
			meta: JSON.parse(row.meta) as LaneMeta,
		};
	} finally {
		db.close();
	}
}

function sessionLines(homeDir: string): string[] {
	const lines: string[] = [];
	const walk = (dir: string): void => {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith(".jsonl")) lines.push(...readFileSync(path, "utf8").split("\n"));
		}
	};
	walk(join(homeDir, "sessions"));
	return lines;
}

/** Resolves when some omp session line satisfies `match`; re-evaluated on every file change under the sessions dir. */
function waitSessionLine(homeDir: string, match: (line: string) => boolean, what: string): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const root = join(homeDir, "sessions");
	mkdirSync(root, { recursive: true });
	const check = (): void => {
		if (!sessionLines(homeDir).some(match)) return;
		clearTimeout(timer);
		watcher.close();
		resolve();
	};
	const watcher = watch(root, { recursive: true }, check);
	const timer = setTimeout(() => {
		watcher.close();
		reject(new Error(`timed out waiting for ${what}`));
	}, EVENT_TIMEOUT_MS);
	check();
	return promise;
}

async function startLane(
	title: string,
	repo: string,
	brief: string,
): Promise<{ daemon: SpawnedDaemon; log: TransportLog; stop: () => Promise<void> }> {
	if (!home) throw new Error("home not created");
	const log = new TransportLog(join(home.dir, "transport.jsonl"));
	const daemon = spawnDaemon(home.dir, log.path);
	await daemon.waitLog(/event=daemon_ready/);
	const injected = await runMain(home.dir, [
		"inject",
		"--origin",
		ORIGIN,
		"--as-owner",
		"--text",
		`작업: ${title} @${repo}\n${brief}`,
	]);
	expect(injected.code, injected.stderr).toBe(0);
	await daemon.waitLog(new RegExp(`event=lane_started lane=${title}\\b`));
	return {
		daemon,
		log,
		stop: async () => {
			daemon.signal("SIGTERM");
			expect(await daemon.exited).toBe(0);
		},
	};
}

/** Every text shown for the lane's root message: its first post and every later edit. */
function rootTexts(log: TransportLog, rootTs: string): string[] {
	const posted = log
		.posts()
		.filter((post) => post.ts === rootTs)
		.map((post) => post.text);
	const edited = log
		.calls("updateMessage")
		.filter((call) => call.ts === rootTs)
		.map((call) => String(call.text));
	return [...posted, ...edited];
}

describe.skipIf(!enabled || REAL === undefined)("work lane with a real omp", () => {
	test(
		"a commit plus a verified done claim closes the lane and turns the root message into ✅",
		async () => {
			home = newHome();
			const repo = await makeRepo(false);
			const worktree = firstLaneWorktree(repo);
			const lane = await startLane(
				"readme-line",
				repo,
				[
					`Work only in ${worktree}. Append exactly one line "lane was here" to README.md, then run`,
					'`git add README.md` and `git commit -m "add lane line"` (never use `git add -A`, `git add .` or `git commit -a`).',
					`Then call the host tool ompbot_claim_done with repo=${worktree}, commit=<the sha printed by \`git rev-parse HEAD\`> and a one-line summary.`,
				].join("\n"),
			);
			await lane.daemon.waitLog(/event=lane_closed lane=readme-line\b/, EVENT_TIMEOUT_MS);
			await lane.daemon.waitLog(/event=lane_rendered lane=readme-line root="✅/, EVENT_TIMEOUT_MS);
			await lane.stop();

			const head = await git(worktree, "rev-parse", "HEAD");
			const snapshot = readLane(home.dir, "readme-line");
			expect(snapshot.status).toBe("closed");
			expect(snapshot.meta.worktree).toBe(worktree);
			const closed = snapshot.history.filter((entry) => entry.event === "closed");
			expect(closed.map((entry) => entry.sha)).toEqual([head]);
			expect(snapshot.meta.sha).toBe(head);
			expect(await git(worktree, "status", "--porcelain")).toBe("");
			expect(readFileSync(join(worktree, "README.md"), "utf8")).toContain("lane was here");
			// The repository's own checkout is untouched: the work is on the lane branch only.
			expect(await git(repo, "status", "--porcelain")).toBe("");
			expect(readFileSync(join(repo, "README.md"), "utf8")).not.toContain("lane was here");

			const rootTs = snapshot.threadRef.slice(snapshot.threadRef.indexOf(":") + 1);
			const texts = rootTexts(lane.log, rootTs);
			expect(texts[0]?.startsWith("🔄")).toBe(true);
			expect(texts.at(-1)?.startsWith("✅")).toBe(true);
		},
		SCENARIO_TIMEOUT_MS,
	);

	test(
		"an uncommitted change with a done claim is not-done: reasons are recorded and steered into the lane, the root stays 🔄",
		async () => {
			home = newHome();
			// Commits are refused by a hook, so the lane cannot repair the claim and close itself while the test looks.
			const repo = await makeRepo(true);
			const worktree = firstLaneWorktree(repo);
			const lane = await startLane(
				"readme-dirty",
				repo,
				[
					`Work only in ${worktree}. Append exactly one line "dirty line" to README.md. Do NOT commit anything.`,
					`Then immediately call the host tool ompbot_claim_done with repo=${worktree}, commit=<the sha printed by \`git rev-parse HEAD\`> and the summary "edited README".`,
					"If the claim is rejected, do not change anything else: just report the rejection.",
				].join("\n"),
			);
			await lane.daemon.waitLog(/event=lane_not_done lane=readme-dirty\b/, EVENT_TIMEOUT_MS);
			await waitSessionLine(
				home.dir,
				(line) => line.includes('"role":"user"') && line.includes("[ompbot]") && line.includes("not-done"),
				"the not-done reasons steered into the lane session",
			);
			await lane.stop();

			const snapshot = readLane(home.dir, "readme-dirty");
			expect(snapshot.status).not.toBe("closed");
			const rejected = snapshot.history.filter((entry) => entry.event === "not_done");
			expect(rejected.length).toBeGreaterThanOrEqual(1);
			expect(rejected[0]?.detail?.length ?? 0).toBeGreaterThan(0);
			expect(await git(worktree, "status", "--porcelain")).toContain("README.md");

			const rootTs = snapshot.threadRef.slice(snapshot.threadRef.indexOf(":") + 1);
			const texts = rootTexts(lane.log, rootTs);
			expect(texts.length).toBeGreaterThan(0);
			expect(texts.every((text) => text.startsWith("🔄"))).toBe(true);
			expect(snapshot.threadRef.startsWith(`${CHANNEL}:`)).toBe(true);
		},
		SCENARIO_TIMEOUT_MS,
	);
});
