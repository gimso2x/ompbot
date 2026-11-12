import {
	chmodSync,
	copyFileSync,
	existsSync,
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { DrainWaitResult } from "../cli/drain";
import { parseChatOrigin } from "../core/origin-key";
import type { SweepHeartbeat } from "../daemon/heartbeat";
import { RESTART_CUT_FILE } from "../daemon/recovery";
import { type BackupResult, backupStamp } from "./backup";
import type { Gate } from "./gates";

/** How long the restarted daemon gets to answer IPC `status` from a fresh start. */
export const READY_TIMEOUT_MS = 120_000;
/**
 * After `ready`, how long the new daemon gets to write a heartbeat (after the restart) with no chat transport down.
 * Covers the Slack/Discord connect plus one sweep (15 s); a stamp the old daemon wrote never counts.
 */
export const TRANSPORTS_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 1_000;
export const DEFAULT_DRAIN_TIMEOUT_MIN = 60;
/** `apply --cut-after` default: a drain still busy after this many minutes restarts anyway (the cut turns resume). */
export const DEFAULT_DRAIN_CUT_MIN = 5;
/** The `[자동 후속]` report inject is tried this many times while the daemon socket refuses connections. */
export const REPORT_INJECT_ATTEMPTS = 6;
export const REPORT_INJECT_RETRY_MS = 5_000;
export const SYSTEMD_UNIT = "ompbot";

/**
 * The apply report goes to a Slack or Discord DM or channel origin (`slack/ch/<C>`, `slack/dm/<D>`, `discord/ch/<id>`,
 * `discord/dm/<id>`), never a thread origin.
 */
export const isReportOrigin = (originKey: string): boolean => {
	const ref = parseChatOrigin(originKey);
	return (ref?.platform === "slack" || ref?.platform === "discord") && ref.threadId === undefined;
};
/** `--report-thread` of a report origin: a Slack message ts, or a Discord message id (snowflake) — as `inject` checks. */
export const reportThreadPattern = (originKey: string): RegExp =>
	parseChatOrigin(originKey)?.platform === "discord" ? /^\d{17,20}$/ : /^\d+\.\d+$/;
export const STAMP_PATTERN = /^\d{8}-\d{6}$/;
/** The config copies `apply` itself makes (`config.json.bak-<stamp>-apply`); hand-made bak names never match. */
const APPLY_CONFIG_COPY = /^config\.json\.bak-\d{8}-\d{6}-apply$/;
const KEEP_APPLY_CONFIG_COPIES = 10;

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type Runner = (cmd: string[], options?: { cwd?: string; env?: Record<string, string> }) => Promise<RunResult>;

export interface ApplyOptions {
	timeoutMin: number;
	/**
	 * Drain cut limit (min): still busy by then, the daemon records its running turns (`drain_cut`) and the restart
	 * goes ahead. Absent or 0: no cut, the drain waits `timeoutMin` and a timeout cancels it.
	 */
	cutAfterMin?: number;
	/** Receipt/unit stamp; `--detach` fixes it up front so the receipt path can be announced. Default: start time. */
	stamp?: string;
	/** The change was merged at this instant; a daemon started after it already runs the new code. */
	mergedAt?: Date;
	reportOrigin?: string;
	reportThread?: string;
}

/** Everything `runApply` touches outside the home directory; tests replace the external effects with fakes. */
export interface ApplyDeps {
	homeDir: string;
	/** systemd user unit running the daemon of `homeDir` (`ompbot`, `ompbot-<instance>`). */
	unit: string;
	/** Checkout holding `src/main.ts`; the daemon loads its code from here. */
	repoDir: string;
	/** Applies the same code to the other installs running from this checkout, after this one is up. */
	peers?: () => Promise<PeerApply[]>;
	/** PATH (with ~/.local/bin and ~/.bun/bin prepended) for every child process and for finding bun. */
	pathEnv: string;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	run: Runner;
	callDaemon: (request: unknown, timeoutMs: number) => Promise<unknown>;
	/** `cutAfterMin` is passed only when the apply cuts (see `ApplyOptions.cutAfterMin`). */
	drain: (timeoutMin: number, cutAfterMin?: number) => Promise<DrainWaitResult>;
	backup: () => BackupResult;
	gates: () => Gate[];
	doctor: () => Promise<{ code: number; lines: string[] }>;
	/**
	 * `ompbot omp sync` of the bot profile (config `ompProfile`), run before the drain; absent without a profile. A
	 * failure (thrown) ends the apply with nothing drained or restarted.
	 */
	ompSync?: () => { changed: number };
	/** `startedAt` (ms) of the process holding `ompbot.lock`; undefined when there is no readable lock. */
	lockStartedAt: () => number | undefined;
	/** `<home>/sweep-heartbeat` as the daemon last wrote it; undefined when absent or unreadable. */
	heartbeat: () => SweepHeartbeat | undefined;
	/** This process; recorded in `<home>/apply.lock`. */
	pid: number;
	/** Whether the process holding `<home>/apply.lock` still runs; a dead holder's lock is taken over. */
	isAlive: (pid: number) => boolean;
	isExecutable: (path: string) => boolean;
	log: (line: string) => void;
}

export interface PeerApply {
	unit: string;
	status: ApplyStatus;
	exitCode: 0 | 1 | 3;
	receiptPath: string;
}

export interface DaemonUnit {
	unit: string;
	homeDir: string;
}

/**
 * Active user units whose ExecStart runs `<repoDir>/src/main.ts daemon`, with the home each one uses
 * (`Environment=OMPBOT_HOME=`, else `defaultHome`). Second installs (`units render --instance`) share the checkout.
 */
export async function findDaemonUnits(
	run: Runner,
	pathEnv: string,
	repoDir: string,
	defaultHome: string,
): Promise<DaemonUnit[]> {
	const env = { PATH: pathEnv };
	const listed = await run(
		["systemctl", "--user", "list-units", "--type=service", "--state=active", "--no-legend", "--plain", "ompbot*"],
		{ env },
	);
	const names = listed.code === 0 ? listed.stdout.split("\n").flatMap((line) => line.trim().split(/\s+/, 1)) : [];
	const units = names.filter((name) => name.endsWith(".service"));
	if (units.length === 0) return [];
	const shown = await run(
		["systemctl", "--user", "show", "-p", "Id", "-p", "Environment", "-p", "ExecStart", ...units],
		{ env },
	);
	if (shown.code !== 0) return [];
	const daemonArgv = `${join(repoDir, "src", "main.ts")} daemon `;
	const found: DaemonUnit[] = [];
	for (const block of shown.stdout.split(/\n\s*\n/)) {
		const props = new Map<string, string>();
		for (const line of block.split("\n")) {
			const eq = line.indexOf("=");
			if (eq > 0) props.set(line.slice(0, eq), line.slice(eq + 1));
		}
		const id = props.get("Id");
		if (id === undefined || !(props.get("ExecStart") ?? "").includes(daemonArgv)) continue;
		const home = /(?:^|\s)OMPBOT_HOME=(\S+)/.exec(props.get("Environment") ?? "")?.[1];
		found.push({ unit: id.replace(/\.service$/, ""), homeDir: home ?? defaultHome });
	}
	return found;
}

export interface StepRecord {
	name: string;
	ok: boolean;
	detail: string;
	ms: number;
}

export type ApplyStatus = "ok" | "already_applied" | "failed" | "skipped";

export interface ApplyReceipt {
	stamp: string;
	startedAt: string;
	finishedAt: string;
	status: ApplyStatus;
	exitCode: 0 | 1 | 3;
	repoDir: string;
	/** The commit the restarted daemon loads: read again right before the restart, since a merge can land during drain. */
	head: string | undefined;
	/** HEAD at preflight, set only when HEAD moved between preflight and the restart. */
	headAtPreflight?: string;
	/** Where HEAD pointed before the latest checkout/merge move (reflog), the code a revert would go back to. */
	previousHead: string | undefined;
	revertCommand: string | undefined;
	configBackup: string | undefined;
	backupFile: string | undefined;
	steps: StepRecord[];
	gates: { open: number; total: number; opened: string[] } | undefined;
	doctor: { code: number; failed: string[] } | undefined;
	report: { origin: string; thread: string | undefined; ok: boolean; detail: string } | undefined;
	receiptPath: string;
}

export interface ApplyOutcome {
	exitCode: 0 | 1 | 3;
	receipt: ApplyReceipt;
}

type StepResult = { ok: boolean; detail: string };

export function receiptPathFor(homeDir: string, stamp: string): string {
	return join(homeDir, "logs", `apply-${stamp}.json`);
}

/** PATH directories a systemd user unit lacks; `~/.local/bin` and `~/.bun/bin` come first. */
export function applyPathDirs(env: Record<string, string | undefined>): string[] {
	const home = env.HOME ?? homedir();
	return [join(home, ".local", "bin"), join(home, ".bun", "bin")];
}

export function applyPathEnv(env: Record<string, string | undefined>): string {
	return [...applyPathDirs(env), ...(env.PATH ? env.PATH.split(delimiter) : [])].join(delimiter);
}

/** First executable `bun` along the prepended PATH. */
export function findBun(pathEnv: string, isExecutable: (path: string) => boolean): string | undefined {
	for (const dir of pathEnv.split(delimiter)) {
		if (dir === "") continue;
		const candidate = join(dir, "bun");
		if (isExecutable(candidate)) return candidate;
	}
	return undefined;
}

function atomicCopy0600(from: string, to: string): void {
	const tmp = `${to}.tmp-${crypto.randomUUID()}`;
	copyFileSync(from, tmp);
	chmodSync(tmp, 0o600);
	renameSync(tmp, to);
}

/** Restores the tree of `prev` as a new commit; unlike `git revert A..B` it works across merge commits. The 2-way
 * `read-tree -m -u HEAD prev` only touches paths that differ between the two, so unrelated local edits and untracked
 * files survive (and a conflicting local edit makes it refuse instead of overwriting). */
export function revertCommandFor(repoDir: string, prev: string): string {
	// Staged changes would ride along in the revert commit (its tree would no longer be prev's): refuse instead.
	return `git -C ${repoDir} diff --cached --quiet && git -C ${repoDir} read-tree -m -u HEAD ${prev} && git -C ${repoDir} commit -m "revert: restore tree of ${prev}"`;
}

export const LAST_GOOD_SUFFIX = ".last-good";

/** Text of `<home>/config.json`, or undefined when it cannot be read. */
export function readConfigText(homeDir: string): string | undefined {
	try {
		return readFileSync(join(homeDir, "config.json"), "utf8");
	} catch {
		return undefined;
	}
}

/**
 * Records `<home>/config.json` as the rollback target (`config.json.last-good`, atomic 0600). Called by the daemon once
 * it runs on that config (boot ready, successful reload) and by `apply`; failure is reported, never thrown. With
 * `content` it records exactly that text (what the caller validated), never a file edited since.
 */
export function recordLastGoodConfig(
	homeDir: string,
	warn: (error: string) => void = () => {},
	content?: string,
): boolean {
	const configPath = join(homeDir, "config.json");
	const target = `${configPath}${LAST_GOOD_SUFFIX}`;
	try {
		if (content !== undefined) {
			const tmp = `${target}.tmp-${crypto.randomUUID()}`;
			writeFileSync(tmp, content, { mode: 0o600 });
			chmodSync(tmp, 0o600);
			renameSync(tmp, target);
			return true;
		}
		if (!existsSync(configPath)) return false;
		atomicCopy0600(configPath, target);
		return true;
	} catch (error) {
		warn(msg(error));
		return false;
	}
}

const msg = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Parses `systemctl show --timestamp=unix` output (`@<seconds>`) into ms; undefined for empty/unknown. */
export function parseUnixTimestamp(text: string): number | undefined {
	const m = /^@(\d+)$/.exec(text.trim());
	return m ? Number(m[1]) * 1000 : undefined;
}

const errorCode = (error: unknown): string | undefined =>
	typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;

/** One `apply` per home at a time holds `<home>/apply.lock`; other installs on the checkout use their own home's. */
export const APPLY_LOCK_FILE = "apply.lock";

export interface ApplyLockInfo {
	pid: number;
	stamp: string;
	startedAt: string;
}

/** The holder an apply lock names; undefined for anything that is not a complete lock (broken JSON included). */
export function parseApplyLock(text: string): ApplyLockInfo | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"pid" in parsed &&
			typeof parsed.pid === "number" &&
			Number.isInteger(parsed.pid) &&
			parsed.pid > 0 &&
			"stamp" in parsed &&
			typeof parsed.stamp === "string" &&
			STAMP_PATTERN.test(parsed.stamp) &&
			"startedAt" in parsed &&
			typeof parsed.startedAt === "string"
		) {
			return { pid: parsed.pid, stamp: parsed.stamp, startedAt: parsed.startedAt };
		}
	} catch {
		// broken JSON: not a lock anyone can be waited on
	}
	return undefined;
}

/**
 * Puts the lock in place whole: a fully written temp file is hard-linked to the lock name, so no reader ever sees
 * an empty or half-written lock. false when another lock already holds the name.
 */
export function createApplyLock(lockPath: string, info: ApplyLockInfo): boolean {
	const tmp = `${lockPath}.tmp-${info.pid}-${crypto.randomUUID().slice(0, 8)}`;
	writeFileSync(tmp, `${JSON.stringify(info)}\n`, { mode: 0o600, flag: "wx" });
	try {
		linkSync(tmp, lockPath);
		return true;
	} catch (error) {
		if (errorCode(error) === "EEXIST") return false;
		throw error;
	} finally {
		rmSync(tmp, { force: true });
	}
}

/**
 * Takes a stale lock (dead holder, broken JSON) out of the way. Only the process whose rename succeeds reclaims it;
 * when the moved file is not the one judged stale (another apply locked in between), it goes back under the lock
 * name (`changed`, wait again). A new lock already there by then is `contention`: nothing more is touched.
 */
export function reclaimStaleApplyLock(
	lockPath: string,
	seen: string,
	pid: number,
): { outcome: "taken" | "changed" | "contention"; aside: string } {
	const aside = `${lockPath}.stale-${pid}-${crypto.randomUUID().slice(0, 8)}`;
	try {
		renameSync(lockPath, aside);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { outcome: "changed", aside };
		throw error;
	}
	if (readFileSync(aside, "utf8") === seen) {
		rmSync(aside, { force: true });
		return { outcome: "taken", aside };
	}
	try {
		linkSync(aside, lockPath);
	} catch (error) {
		if (errorCode(error) === "EEXIST") return { outcome: "contention", aside };
		throw error;
	}
	rmSync(aside, { force: true });
	return { outcome: "changed", aside };
}

/** Removes the lock only while it is still this apply's (same pid and stamp); true when removed. */
export function releaseApplyLock(lockPath: string, info: ApplyLockInfo): boolean {
	let text: string;
	try {
		text = readFileSync(lockPath, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
	const holder = parseApplyLock(text);
	if (holder?.pid !== info.pid || holder.stamp !== info.stamp) return false;
	rmSync(lockPath, { force: true });
	return true;
}

/** `kill(pid, 0)`: EPERM still means a live process owned by someone else. */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
}

/** Why the receipt of the apply waited on does not cover this one; undefined when it does (finished ok, same HEAD). */
function priorReceiptGap(path: string, head: string | undefined): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return `receipt unreadable: ${msg(error)}`;
	}
	if (typeof parsed !== "object" || parsed === null) return "receipt malformed";
	const prior = parsed as Partial<ApplyReceipt>;
	if (prior.status !== "ok" && prior.status !== "already_applied") return `status=${String(prior.status)}`;
	if (head === undefined || prior.head !== head) return `head ${String(prior.head)} is not HEAD ${head ?? "(unknown)"}`;
	if (typeof prior.finishedAt !== "string" || prior.finishedAt === "") return "receipt not finished";
	return undefined;
}

/** Socket-level failures (nothing listening yet); a daemon that answered, even with a refusal, is not one. */
const isConnectFailure = (error: unknown): boolean => {
	const code = errorCode(error);
	return code === "ECONNREFUSED" || code === "ENOENT" || /Failed to connect|ECONNREFUSED|ENOENT/.test(msg(error));
};

/**
 * One apply per home at a time: takes `<home>/apply.lock` (waiting for a live holder, taking over a stale one), runs
 * the apply and removes its own lock after the final receipt, so a waiter always finds that receipt complete.
 */
export async function runApply(options: ApplyOptions, deps: ApplyDeps): Promise<ApplyOutcome> {
	const stamp = options.stamp ?? backupStamp(new Date(deps.now()));
	const lockPath = join(deps.homeDir, APPLY_LOCK_FILE);
	const lock = {
		info: { pid: deps.pid, stamp, startedAt: new Date(deps.now()).toISOString() },
		held: false,
	};
	try {
		return await applyUnderLock({ ...options, stamp }, deps, lockPath, lock);
	} finally {
		if (lock.held) {
			try {
				if (releaseApplyLock(lockPath, lock.info)) deps.log(`apply lock released ${lockPath}`);
			} catch (error) {
				deps.log(`apply lock release failed ${lockPath}: ${msg(error)}`);
			}
		}
	}
}

/**
 * Applies a merged change to the running daemon in one auditable pass: precheck → backup (db + config copy) →
 * drain → restart → wait for a fresh daemon and its chat transports → record gates/doctor → roll back config and restart once on failure.
 * Code is never reverted automatically; the receipt carries the previous HEAD and the revert command instead.
 */
async function applyUnderLock(
	options: ApplyOptions & { stamp: string },
	deps: ApplyDeps,
	lockPath: string,
	lock: { info: ApplyLockInfo; held: boolean },
): Promise<ApplyOutcome> {
	const { homeDir, repoDir, unit } = deps;
	const startedMs = deps.now();
	const { stamp } = options;
	const receiptPath = receiptPathFor(homeDir, stamp);
	const steps: StepRecord[] = [];
	const receipt: ApplyReceipt = {
		stamp,
		startedAt: new Date(startedMs).toISOString(),
		finishedAt: "",
		status: "failed",
		exitCode: 1,
		repoDir,
		head: undefined,
		previousHead: undefined,
		revertCommand: undefined,
		configBackup: undefined,
		backupFile: undefined,
		steps,
		gates: undefined,
		doctor: undefined,
		report: undefined,
		receiptPath,
	};

	const step = async (name: string, fn: () => Promise<StepResult> | StepResult): Promise<boolean> => {
		const t0 = deps.now();
		let result: StepResult;
		try {
			result = await fn();
		} catch (error) {
			result = { ok: false, detail: msg(error) };
		}
		steps.push({ name, ok: result.ok, detail: result.detail, ms: deps.now() - t0 });
		deps.log(`apply step=${name} ok=${result.ok} detail=${result.detail}`);
		return result.ok;
	};

	const writeReceipt = (): void => {
		receipt.finishedAt = new Date(deps.now()).toISOString();
		mkdirSync(join(homeDir, "logs"), { recursive: true, mode: 0o700 });
		const tmp = `${receiptPath}.tmp-${crypto.randomUUID()}`;
		writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, receiptPath);
	};

	const git = async (...args: string[]): Promise<RunResult> =>
		deps.run(["git", "-C", repoDir, ...args], { env: { PATH: deps.pathEnv } });

	// Set once the daemon confirmed `drain_cut`: every end of this apply (ok, failed, rolled back) removes the file
	// then, after the restarts it covers. A dead apply leaves it to the 3-hour expiry of recovery.
	let cutRecorded = false;
	const finish = async (status: ApplyStatus, exitCode: 0 | 1 | 3): Promise<ApplyOutcome> => {
		if (cutRecorded) {
			const cutPath = join(homeDir, RESTART_CUT_FILE);
			try {
				rmSync(cutPath, { force: true });
				deps.log(`apply restart cut removed ${cutPath}`);
			} catch (error) {
				deps.log(`apply restart cut remove failed ${cutPath}: ${msg(error)}`);
			}
		}
		receipt.status = status;
		receipt.exitCode = exitCode;
		writeReceipt();
		if (options.reportOrigin !== undefined) {
			const summary = steps
				.filter((s) => !s.ok)
				.map((s) => `${s.name}: ${s.detail}`)
				.join("; ");
			const text =
				`[자동 후속] apply 결과 ${status}${summary ? ` (${summary})` : ""}. 영수증 ${receiptPath}를 읽고 ` +
				"증거와 함께 이 스레드에 짧게 보고해줘(새 수정·재시작 금지).";
			// A daemon restarting under someone else's apply (or by hand) refuses connections for a few seconds:
			// retry those. A daemon that answered, even with a refusal, is not asked again.
			let ok = false;
			let detail = "";
			for (let attempt = 1; ; attempt += 1) {
				try {
					const response = await deps.callDaemon(
						{
							op: "inject",
							origin: options.reportOrigin,
							asOwner: true,
							text,
							thread: options.reportThread,
						},
						30_000,
					);
					ok = typeof response === "object" && response !== null && "ok" in response && response.ok === true;
					detail = ok
						? `injected attempts=${attempt}`
						: `inject refused attempts=${attempt}: ${JSON.stringify(response)}`;
					break;
				} catch (error) {
					if (isConnectFailure(error) && attempt < REPORT_INJECT_ATTEMPTS) {
						await deps.sleep(REPORT_INJECT_RETRY_MS);
						continue;
					}
					detail = `inject failed attempts=${attempt}: ${msg(error)}`;
					break;
				}
			}
			receipt.report = { origin: options.reportOrigin, thread: options.reportThread, ok, detail };
			writeReceipt();
		}
		return { exitCode, receipt };
	};

	// 0. apply lock: a live holder is waited for (no drain, no restart meanwhile), a stale one taken over. Running
	// past the limit changes nothing and fails, leaving the holder's lock alone.
	let waitedFor: string | undefined;
	const acquire = async (): Promise<StepResult & { noted: boolean }> => {
		const limitMs = options.timeoutMin * 60_000 + READY_TIMEOUT_MS;
		const deadline = deps.now() + limitMs;
		const notes: string[] = [];
		for (;;) {
			if (createApplyLock(lockPath, lock.info)) {
				lock.held = true;
				deps.log(`apply lock taken ${lockPath}`);
				if (waitedFor !== undefined) notes.push(`waited for apply ${waitedFor}`);
				return { ok: true, detail: notes.join("; "), noted: notes.length > 0 };
			}
			let seen: string;
			try {
				seen = readFileSync(lockPath, "utf8");
			} catch (error) {
				if (errorCode(error) === "ENOENT") continue; // released between our link and read: try again
				throw error;
			}
			const holder = parseApplyLock(seen);
			// The outer apply of this very process (same stamp) already holds this home: waiting would wait on itself.
			if (holder?.pid === deps.pid && holder.stamp === stamp) {
				return { ok: false, detail: `${lockPath} is held by this apply ${stamp} itself`, noted: true };
			}
			// A dead holder, broken JSON, or this pid left by an earlier process (another stamp) is stale.
			if (holder === undefined || holder.pid === deps.pid || !deps.isAlive(holder.pid)) {
				const reclaim = reclaimStaleApplyLock(lockPath, seen, deps.pid);
				if (reclaim.outcome === "contention") {
					return { ok: false, detail: `lock contention (moved-aside lock left at ${reclaim.aside})`, noted: true };
				}
				if (reclaim.outcome === "taken") notes.push(`stale lock ${holder?.stamp ?? "(unreadable)"} taken over`);
				continue;
			}
			if (waitedFor !== holder.stamp) deps.log(`apply wait_apply waiting for apply ${holder.stamp} pid=${holder.pid}`);
			waitedFor = holder.stamp;
			if (deps.now() >= deadline) {
				return {
					ok: false,
					detail: `apply ${holder.stamp} still running after ${limitMs / 60_000} min`,
					noted: true,
				};
			}
			await deps.sleep(READY_POLL_MS);
		}
	};
	// Recorded as a step only when there was someone to wait for or take over (or it failed).
	const lockStartedMs = deps.now();
	let acquired: StepResult & { noted: boolean };
	try {
		acquired = await acquire();
	} catch (error) {
		acquired = { ok: false, detail: msg(error), noted: true };
	}
	if (acquired.noted) {
		steps.push({ name: "wait_apply", ok: acquired.ok, detail: acquired.detail, ms: deps.now() - lockStartedMs });
		deps.log(`apply step=wait_apply ok=${acquired.ok} detail=${acquired.detail}`);
	}
	if (!acquired.ok) return finish("failed", 1);

	// 1. precheck: anything wrong here changes nothing and ends as SKIP.
	const skipReasons: string[] = [];
	let bun: string | undefined;
	let alreadyApplied: string | undefined;
	await step("preflight", async () => {
		const exists = existsSync(join(repoDir, "src", "main.ts"));
		if (!exists) skipReasons.push(`src/main.ts not found in ${repoDir}`);
		else {
			const branch = (await git("branch", "--show-current")).stdout.trim();
			const head = await git("rev-parse", "HEAD");
			const main = await git("rev-parse", "main");
			receipt.head = head.code === 0 ? head.stdout.trim() : undefined;
			if (branch !== "main") skipReasons.push(`checkout is on branch "${branch || "(detached)"}", not main`);
			else if (head.code !== 0 || main.code !== 0 || head.stdout.trim() !== main.stdout.trim()) {
				skipReasons.push("HEAD differs from main");
			}
			const active = await deps.run(["systemctl", "--user", "is-active", unit], {
				env: { PATH: deps.pathEnv },
			});
			if (active.code !== 0) {
				skipReasons.push(`systemctl --user is-active ${unit} rc=${active.code} (daemon not active or no user bus)`);
			}
			const dirty = await git("status", "--porcelain", "--", "src");
			if (dirty.code !== 0) skipReasons.push(`git status failed: ${dirty.stderr.trim()}`);
			else if (dirty.stdout.trim() !== "") {
				skipReasons.push(`uncommitted changes under src: ${dirty.stdout.trim().split("\n").length} file(s)`);
			}
			const prev = await git("rev-parse", "--verify", "-q", "HEAD@{1}");
			if (prev.code === 0 && receipt.head !== undefined && prev.stdout.trim() !== receipt.head) {
				receipt.previousHead = prev.stdout.trim();
				receipt.revertCommand = revertCommandFor(repoDir, receipt.previousHead);
			}
		}
		bun = findBun(deps.pathEnv, deps.isExecutable);
		if (bun === undefined) skipReasons.push(`bun not found on PATH (${deps.pathEnv})`);
		if (skipReasons.length === 0 && options.mergedAt !== undefined) {
			const show = await deps.run(
				["systemctl", "--user", "show", "-p", "ActiveEnterTimestamp", "--value", "--timestamp=unix", unit],
				{ env: { PATH: deps.pathEnv } },
			);
			const enteredAt = show.code === 0 ? parseUnixTimestamp(show.stdout) : undefined;
			if (enteredAt !== undefined && enteredAt > options.mergedAt.getTime()) {
				alreadyApplied = `daemon active since ${new Date(enteredAt).toISOString()} is after merge ${options.mergedAt.toISOString()}`;
			}
		}
		if (skipReasons.length > 0) return { ok: false, detail: skipReasons.join("; ") };
		return { ok: true, detail: alreadyApplied ?? `main@${receipt.head} clean, bun=${bun}` };
	});
	if (skipReasons.length > 0) return finish("skipped", 3);

	// Once this daemon runs the code, the other installs on the same checkout get it too. A peer that fails turns
	// the whole apply into a failure (exit 1) so a caller does not mistake a half-applied checkout for done.
	const finishWithPeers = async (status: "ok" | "already_applied"): Promise<ApplyOutcome> => {
		const peers = deps.peers;
		if (peers === undefined) return finish(status, 0);
		let allOk = true;
		await step("peers", async () => {
			const results = await peers();
			allOk = results.every((p) => p.exitCode === 0);
			const detail = results.map((p) => `${p.unit}=${p.status}(${p.receiptPath})`).join(" ");
			return { ok: allOk, detail: detail || "no other install on this checkout" };
		});
		return allOk ? finish(status, 0) : finish("failed", 1);
	};
	// After waiting, the apply waited for may already have put this HEAD in place (here and on the peers): its receipt
	// decides. Anything short of a finished ok/already_applied receipt on this HEAD runs the full apply below.
	if (waitedFor !== undefined) {
		const prior = waitedFor;
		let covered = false;
		await step("prior_apply", () => {
			const gap = priorReceiptGap(receiptPathFor(homeDir, prior), receipt.head);
			covered = gap === undefined;
			return {
				ok: true,
				detail: covered ? `applied by apply-${prior}` : `apply-${prior} not reused (${gap}): full apply`,
			};
		});
		if (covered) return finish("already_applied", 0);
	}
	if (alreadyApplied !== undefined) return finishWithPeers("already_applied");

	// 2. backup: ledger/bundle snapshot plus a config copy to roll back to.
	const configPath = join(homeDir, "config.json");
	const backedUp = await step("backup", () => {
		const result = deps.backup();
		receipt.backupFile = result.file;
		let detail = `db=${result.file}`;
		if (existsSync(configPath)) {
			// Stamps sort by time. A config unchanged since the newest copy reuses it instead of piling up duplicates.
			const copies = readdirSync(homeDir)
				.filter((name) => APPLY_CONFIG_COPY.test(name))
				.sort();
			const newest = copies.at(-1);
			if (newest !== undefined && readFileSync(join(homeDir, newest)).equals(readFileSync(configPath))) {
				receipt.configBackup = join(homeDir, newest);
				detail += ` config=${receipt.configBackup} (unchanged, reused)`;
			} else {
				const target = `${configPath}.bak-${stamp}-apply`;
				atomicCopy0600(configPath, target);
				receipt.configBackup = target;
				detail += ` config=${target}`;
				const made = `config.json.bak-${stamp}-apply`;
				const all = [...new Set([...copies, made])].sort();
				// The receipt names the copy just made, so it stays even when an older --stamp sorts it low.
				for (const old of all.slice(0, -KEEP_APPLY_CONFIG_COPIES))
					if (old !== made) rmSync(join(homeDir, old), { force: true });
			}
		}
		return { ok: true, detail };
	});
	if (!backedUp) return finish("failed", 1);

	// 2b. bot omp profile: the restarted daemon reads the synced settings; a failed sync leaves the running bot alone.
	const { ompSync } = deps;
	if (ompSync !== undefined) {
		const synced = await step("omp_sync", () => ({
			ok: true,
			detail: `omp_profile_sync changed=${ompSync().changed}`,
		}));
		if (!synced) return finish("failed", 1);
	}

	// A path that ends without a verified new daemon leaves the old one draining: cancel it and record it.
	const cancelDrain = async (): Promise<string> => {
		try {
			const response = await deps.callDaemon({ op: "drain_cancel" }, 10_000);
			const ok = typeof response === "object" && response !== null && "ok" in response && response.ok === true;
			return ok ? "drain cancelled" : `drain cancel refused: ${JSON.stringify(response)}`;
		} catch (error) {
			return `drain cancel failed: ${msg(error)}`;
		}
	};

	// 3. drain: a timeout cancels the drain itself, so nothing was changed and no restart follows. An unreachable
	// daemon may still have taken the drain (a lost answer): cancel it too, best effort, so no restart leaves it held.
	// With a cut limit, a drain still busy then restarts anyway once the daemon confirmed `drain_cut` (its running
	// turns are on disk for the next process to resume); without that confirmation it ends like a timeout.
	const cutAfterMin = options.cutAfterMin !== undefined && options.cutAfterMin > 0 ? options.cutAfterMin : undefined;
	const drained = await step("drain", async () => {
		const result = await deps.drain(options.timeoutMin, cutAfterMin);
		if (result.ok) {
			const counts = `turns=${result.counts.turns} hostTools=${result.counts.hostTools} approvals=${result.counts.approvals}`;
			if (result.cut !== true) return { ok: true, detail: counts };
			let refused: string;
			try {
				const response = await deps.callDaemon({ op: "drain_cut", applyStamp: stamp }, 30_000);
				if (typeof response === "object" && response !== null && "ok" in response && response.ok === true) {
					cutRecorded = true;
					return { ok: true, detail: `cut=true ${counts}` };
				}
				refused = `drain_cut refused: ${JSON.stringify(response)}`;
			} catch (error) {
				refused = `drain_cut failed: ${msg(error)}`;
			}
			return { ok: false, detail: `timeout after ${cutAfterMin} min (${refused}; ${await cancelDrain()})` };
		}
		if (result.reason === "unreachable")
			return { ok: false, detail: `daemon not reachable: ${result.error}; ${await cancelDrain()}` };
		return { ok: false, detail: `${result.reason} after ${options.timeoutMin} min (drain cancelled)` };
	});
	if (!drained) return finish("failed", 1);

	// 4+5. restart and wait for a daemon that started after the restart request.
	const restartAndWait = async (): Promise<StepResult & { restartAt: number }> => {
		// The daemon loads whatever the checkout holds at restart; a merge landing during drain moves HEAD past preflight.
		const head = await git("rev-parse", "HEAD");
		const current = head.code === 0 ? head.stdout.trim() : undefined;
		const moved = current !== undefined && receipt.head !== undefined && current !== receipt.head;
		if (moved) {
			receipt.headAtPreflight ??= receipt.head;
			receipt.head = current;
		}
		const restartAt = deps.now();
		const restart = await deps.run(["systemctl", "--user", "restart", unit], { env: { PATH: deps.pathEnv } });
		if (restart.code !== 0)
			return { ok: false, detail: `systemctl restart rc=${restart.code}: ${restart.stderr.trim()}`, restartAt };
		const note = moved
			? ` (HEAD moved after preflight: ${receipt.headAtPreflight?.slice(0, 7)}→${current.slice(0, 7)})`
			: "";
		return { ok: true, detail: `restart requested${note}`, restartAt };
	};
	const waitReady = async (restartAt: number): Promise<StepResult> => {
		const deadline = deps.now() + READY_TIMEOUT_MS;
		let last = "no answer";
		for (;;) {
			try {
				const response = await deps.callDaemon({ op: "status" }, 5_000);
				const answered = typeof response === "object" && response !== null && "ok" in response && response.ok === true;
				const startedAt = deps.lockStartedAt();
				if (answered && startedAt !== undefined && startedAt > restartAt) {
					return { ok: true, detail: `daemon started ${new Date(startedAt).toISOString()}` };
				}
				last = answered
					? `answering but started ${startedAt === undefined ? "unknown" : new Date(startedAt).toISOString()}, not after restart`
					: "status not ok";
			} catch (error) {
				last = msg(error);
			}
			if (deps.now() >= deadline) return { ok: false, detail: `not ready within ${READY_TIMEOUT_MS / 1000}s: ${last}` };
			await deps.sleep(READY_POLL_MS);
		}
	};

	// Answering IPC is not taking messages: the new daemon's own heartbeat must show every chat transport it runs up.
	const waitTransports = async (restartAt: number): Promise<StepResult> => {
		const deadline = deps.now() + TRANSPORTS_TIMEOUT_MS;
		let last = "no heartbeat";
		for (;;) {
			const beat = deps.heartbeat();
			if (beat === undefined) last = "no heartbeat";
			else if (beat.ts.getTime() <= restartAt) last = `heartbeat ${beat.ts.toISOString()} is from before the restart`;
			else {
				const down = [
					beat.socket?.state === "down" ? "slack" : undefined,
					beat.discord?.state === "down" ? "discord" : undefined,
				].filter((name) => name !== undefined);
				const states = `slack=${beat.socket?.state ?? "off"} discord=${beat.discord?.state ?? "off"}`;
				if (down.length === 0) return { ok: true, detail: states };
				last = `down: ${down.join(",")} (${states})`;
			}
			if (deps.now() >= deadline)
				return { ok: false, detail: `transports not up within ${TRANSPORTS_TIMEOUT_MS / 1000}s: ${last}` };
			await deps.sleep(READY_POLL_MS);
		}
	};

	let restartAt = 0;
	const restarted = await step("restart", async () => {
		const r = await restartAndWait();
		restartAt = r.restartAt;
		return r;
	});
	const ready =
		restarted &&
		(await step("ready", () => waitReady(restartAt))) &&
		(await step("transports", () => waitTransports(restartAt)));

	// 7. rollback on failure: last known-good config back, one more restart; the code stays and is described in the receipt.
	if (!ready) {
		await step("rollback", async () => {
			const details: string[] = [];
			const lastGood = `${configPath}${LAST_GOOD_SUFFIX}`;
			if (existsSync(lastGood)) {
				atomicCopy0600(lastGood, configPath);
				details.push(`config restored from ${lastGood}`);
			} else details.push("복원할 정상 config 없음 (config untouched)");
			const r = await restartAndWait();
			let ok = r.ok;
			if (!r.ok) details.push(r.detail);
			else {
				const w = await waitReady(r.restartAt);
				ok = w.ok;
				details.push(`restart ${w.ok ? "ok" : "failed"}: ${w.detail}`);
			}
			if (!ok) details.push(await cancelDrain());
			if (receipt.revertCommand !== undefined) details.push(`code not reverted; to revert: ${receipt.revertCommand}`);
			else details.push("code not reverted (previous HEAD unknown)");
			return { ok, detail: details.join("; ") };
		});
		return finish("failed", 1);
	}

	// 6. record health; open gates or doctor failures are reported, they do not undo the apply.
	await step("verify", async () => {
		const gates = deps.gates();
		const open = gates.filter((g) => g.state === "open");
		receipt.gates = { open: open.length, total: gates.length, opened: open.map((g) => `${g.name}(${g.detail})`) };
		const doctor = await deps.doctor();
		receipt.doctor = { code: doctor.code, failed: doctor.lines.filter((l) => l.startsWith("fail ")) };
		return {
			ok: true,
			detail: `gates open=${open.length}/${gates.length} doctor rc=${doctor.code} failed=${receipt.doctor.failed.length}`,
		};
	});
	// The daemon came up on this config: remember it as the rollback target of the next failed apply.
	await step("last_good", () => {
		const ok = recordLastGoodConfig(homeDir);
		return { ok: true, detail: ok ? `${configPath}${LAST_GOOD_SUFFIX}` : "no config.json or copy failed" };
	});
	return finishWithPeers("ok");
}

/** Reads the daemon lock `startedAt` (ms); undefined when absent or malformed. */
export function readLockStartedAt(homeDir: string): number | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(homeDir, "ompbot.lock"), "utf8"));
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"startedAt" in parsed &&
			typeof parsed.startedAt === "number"
		) {
			return parsed.startedAt;
		}
	} catch {
		// no lock yet: the daemon has not started
	}
	return undefined;
}

export function isExecutableFile(path: string): boolean {
	try {
		return statSync(path).isFile() && (statSync(path).mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

export async function spawnRunner(
	cmd: string[],
	options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<RunResult> {
	const proc = Bun.spawn(cmd, {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}
