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
import { delimiter, join, resolve } from "node:path";
import type { DrainWaitResult } from "../cli/drain";
import { type CodeRollbackMode, defaultHomeDir } from "../config";
import { parseChatOrigin } from "../core/origin-key";
import type { SweepHeartbeat } from "../daemon/heartbeat";
import { RESTART_CUT_FILE } from "../daemon/recovery";
import { redact } from "../redact";
import { type BackupResult, backupStamp } from "./backup";
import { type EnsureDepsResult, ensureDeps } from "./deps";
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
	/** `--report-plain`: the report is a plain bot post (daemon `notify`), not a `[자동 후속]` model turn (`inject`). */
	reportPlain?: boolean;
	/**
	 * Why this apply never reverts code after a failed config rollback (`--no-code-rollback`, or a peer install: the
	 * first home's apply owns the shared checkout). Absent: the code rollback is on.
	 */
	codeRollbackOff?: string;
	/**
	 * How the code goes back (config `apply.codeRollback`, which the CLI always passes; its default is `detach`).
	 * Absent: `push`, the behaviour from before the setting existed.
	 */
	codeRollback?: CodeRollbackMode;
	/** `--clear-rollback`: the detach journal is removed first, then the ordinary checks run. */
	clearRollback?: boolean;
	/** `--allow-detached`: a detached HEAD picked by hand is applied as is (no journal); head.last-good stays as it was. */
	allowDetached?: boolean;
}

/** Everything `runApply` touches outside the home directory; tests replace the external effects with fakes. */
export interface ApplyDeps {
	homeDir: string;
	/** systemd user unit running the daemon of `homeDir` (`ompbot`, `ompbot-<instance>`). */
	unit: string;
	/** Checkout holding `src/main.ts`; the daemon loads its code from here. */
	repoDir: string;
	/**
	 * Applies the same code to the other installs running from this checkout, after this one is up. `afterCodeRollback`:
	 * the checkout was just reverted, so every peer restarts onto it (no `--merged-at` shortcut).
	 */
	peers?: (afterCodeRollback?: boolean) => Promise<PeerApply[]>;
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
	try {
		const units = await findCheckoutUnits(run, pathEnv, repoDir, defaultHome, "daemon");
		return units.map(({ unit, homeDir }) => ({ unit, homeDir }));
	} catch {
		// no user bus or systemctl failed: no peers to apply to
		return [];
	}
}

/**
 * Active `ompbot*` user units whose ExecStart runs `<repoDir>/src/main.ts <command>`, with their home and when they
 * last became active (ms; undefined when systemd does not say).
 */
async function findCheckoutUnits(
	run: Runner,
	pathEnv: string,
	repoDir: string,
	defaultHome: string,
	command: "daemon" | "dashboard",
): Promise<Array<DaemonUnit & { activeSince: number | undefined }>> {
	const env = { PATH: pathEnv };
	const listed = await run(
		["systemctl", "--user", "list-units", "--type=service", "--state=active", "--no-legend", "--plain", "ompbot*"],
		{ env },
	);
	if (listed.code !== 0) throw new Error(`systemctl list-units rc=${listed.code}: ${listed.stderr.trim()}`);
	const names = listed.stdout.split("\n").flatMap((line) => line.trim().split(/\s+/, 1));
	const units = names.filter((name) => name.endsWith(".service"));
	if (units.length === 0) return [];
	const shown = await run(
		[
			"systemctl",
			"--user",
			"show",
			"-p",
			"Id",
			"-p",
			"Environment",
			"-p",
			"ExecStart",
			"-p",
			"ActiveEnterTimestamp",
			"--timestamp=unix",
			...units,
		],
		{ env },
	);
	if (shown.code !== 0) throw new Error(`systemctl show rc=${shown.code}: ${shown.stderr.trim()}`);
	const argv = `${join(repoDir, "src", "main.ts")} ${command} `;
	const found: Array<DaemonUnit & { activeSince: number | undefined }> = [];
	for (const block of shown.stdout.split(/\n\s*\n/)) {
		const props = new Map<string, string>();
		for (const line of block.split("\n")) {
			const eq = line.indexOf("=");
			if (eq > 0) props.set(line.slice(0, eq), line.slice(eq + 1));
		}
		const id = props.get("Id");
		if (id === undefined || !(props.get("ExecStart") ?? "").includes(argv)) continue;
		const home = /(?:^|\s)OMPBOT_HOME=(\S+)/.exec(props.get("Environment") ?? "")?.[1];
		found.push({
			unit: id.replace(/\.service$/, ""),
			homeDir: home ?? defaultHome,
			activeSince: parseUnixTimestamp(props.get("ActiveEnterTimestamp") ?? ""),
		});
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
	/** `<home>/head.last-good` at preflight: the commit the last verified apply loaded. */
	lastGoodHead: string | undefined;
	/**
	 * The code a revert goes back to: `lastGoodHead` when recorded, else where HEAD pointed before the latest
	 * checkout/merge move (reflog `HEAD@{1}`).
	 */
	previousHead: string | undefined;
	revertCommand: string | undefined;
	/** The code rollback mode this apply ran with. */
	codeRollback: CodeRollbackMode;
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

/** Text of `<home>/config.json`, or undefined when it cannot be read (or is no regular file: a FIFO would block). */
export function readConfigText(homeDir: string): string | undefined {
	try {
		const path = join(homeDir, "config.json");
		if (!statSync(path).isFile()) return undefined;
		return readFileSync(path, "utf8");
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

function atomicWrite0600(target: string, content: string): void {
	const tmp = `${target}.tmp-${crypto.randomUUID()}`;
	writeFileSync(tmp, content, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, target);
}

/**
 * `<git dir>/ompbot-code-rollback.json`: written by a `detach` code rollback before it checks out head.last-good. It
 * belongs to the checkout, so every home on it sees it: while it exists, apply runs only on that detached commit
 * (the peers too) or on a main that moved past the commit that broke the daemon (which removes it).
 */
export const CODE_ROLLBACK_JOURNAL = "ompbot-code-rollback.json";

export interface CodeRollbackJournal {
	/** The commit checked out detached (head.last-good). */
	lastGood: string;
	/** HEAD (main) when the daemon failed to start: the commit that broke it. */
	head: string;
	stamp: string;
	home: string;
}

/** The journal in `gitDir`; undefined when there is none. Throws when it exists but is not a complete journal. */
export function readCodeRollbackJournal(gitDir: string): CodeRollbackJournal | undefined {
	let text: string;
	try {
		text = readFileSync(join(gitDir, CODE_ROLLBACK_JOURNAL), "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
	const parsed: unknown = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null) throw new Error("not a JSON object");
	const fields = parsed as Record<string, unknown>;
	for (const key of ["lastGood", "head", "stamp", "home"] as const) {
		if (typeof fields[key] !== "string" || fields[key] === "") throw new Error(`no ${key}`);
	}
	return parsed as CodeRollbackJournal;
}

/** `<home>/head.last-good`: the commit the last apply that passed every check loaded (the code rollback target). */
export const HEAD_LAST_GOOD_FILE = "head.last-good";
/** Gates that, open after the restart, keep the loaded commit from becoming `head.last-good`. */
const LAST_GOOD_BLOCKING_GATES: readonly string[] = ["omp_runtime", "turns_failing"];

/** The commit in `<home>/head.last-good`; undefined when absent or not a full commit id. */
export function readHeadLastGood(homeDir: string): string | undefined {
	try {
		const text = readFileSync(join(homeDir, HEAD_LAST_GOOD_FILE), "utf8").trim();
		return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(text) ? text : undefined;
	} catch {
		return undefined;
	}
}

/**
 * `<home>/autoland.hold`: written by an apply that reverted the code, so the commit that broke the daemon is not merged
 * again unasked. Auto-merge (tasks and lanes) skips while it exists; the owner's own 머지 does not; the next apply
 * that ends ok removes it.
 */
export const AUTOLAND_HOLD_FILE = "autoland.hold";

/** Why auto-merge is held (`<reason> (<at>)`); undefined when there is no hold file. */
export function readAutoLandHold(homeDir: string): string | undefined {
	let text: string;
	try {
		text = readFileSync(join(homeDir, AUTOLAND_HOLD_FILE), "utf8");
	} catch (error) {
		return errorCode(error) === "ENOENT" ? undefined : `${AUTOLAND_HOLD_FILE} unreadable: ${msg(error)}`;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null && "reason" in parsed && typeof parsed.reason === "string") {
			const at = "at" in parsed && typeof parsed.at === "string" ? ` (${parsed.at})` : "";
			return `${parsed.reason}${at}`;
		}
	} catch {
		// a hand-written or broken hold still holds
	}
	return text.trim() || AUTOLAND_HOLD_FILE;
}

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

/** What apply's preflight reads off the checkout: branch, HEAD against main, the code rollback journal, `src` changes. */
export interface CheckoutCheck {
	/** Why an apply SKIPs here; empty when the checkout may be applied. */
	skipReasons: string[];
	/** Informational preflight notes (`--clear-rollback` removing the journal). */
	notes: string[];
	head: string | undefined;
	/** `<git dir>/ompbot-code-rollback.json`; "" when the git dir is unknown. */
	journalPath: string;
	/** A journal while HEAD is a main past the commit that broke the daemon: the apply that comes up removes it. */
	journalOnMain: boolean;
	/**
	 * Passes on a detached HEAD (the journal's commit, or `--allow-detached`): not main, so no head.last-good is
	 * recorded and neither the hold nor the journal is removed.
	 */
	detached: boolean;
	/** How a passing non-plain checkout is described in the preflight detail; "" for a plain main. */
	checkout: string;
}

/**
 * The checkout half of apply's preflight, shared with `!restart` (which refuses up front rather than launch an apply
 * that would SKIP). `clearRollback` removes the journal first, so only an apply passes it.
 */
export async function checkCheckout(
	git: (...args: string[]) => Promise<RunResult>,
	options: Pick<ApplyOptions, "clearRollback" | "allowDetached">,
): Promise<CheckoutCheck> {
	const result: CheckoutCheck = {
		skipReasons: [],
		notes: [],
		head: undefined,
		journalPath: "",
		journalOnMain: false,
		detached: false,
		checkout: "",
	};
	const { skipReasons } = result;
	const branch = (await git("branch", "--show-current")).stdout.trim();
	const head = await git("rev-parse", "HEAD");
	const main = await git("rev-parse", "main");
	result.head = head.code === 0 ? head.stdout.trim() : undefined;
	const current = result.head;
	const onMain = branch === "main" && head.code === 0 && main.code === 0 && current === main.stdout.trim();
	let journal: CodeRollbackJournal | undefined;
	const gitDir = await git("rev-parse", "--absolute-git-dir");
	if (gitDir.code !== 0) {
		skipReasons.push(`git rev-parse --absolute-git-dir rc=${gitDir.code}: ${gitDir.stderr.trim()}`);
	} else {
		const journalPath = join(gitDir.stdout.trim(), CODE_ROLLBACK_JOURNAL);
		result.journalPath = journalPath;
		if (options.clearRollback === true && existsSync(journalPath)) {
			rmSync(journalPath, { force: true });
			result.notes.push(`${journalPath} cleared (--clear-rollback)`);
		}
		try {
			journal = readCodeRollbackJournal(gitDir.stdout.trim());
		} catch (error) {
			skipReasons.push(`${journalPath} unreadable (${msg(error)}); remove it with apply --clear-rollback`);
		}
	}
	if (journal !== undefined) {
		const short = (sha: string | undefined): string => sha?.slice(0, 7) ?? "(unknown)";
		if (branch === "" && current === journal.lastGood) {
			result.detached = true;
			result.checkout = `detached@${current} (code rollback of apply ${journal.stamp}, cause ${short(journal.head)})`;
		} else if (onMain && current === journal.head) {
			skipReasons.push(
				`원인 커밋 ${short(journal.head)}가 아직 HEAD — 고친 커밋을 받은 뒤 apply, 환경만 고쳤으면 \`apply --clear-rollback\``,
			);
		} else if (onMain) {
			result.journalOnMain = true;
			result.checkout = `main@${current} past the cause ${short(journal.head)} of code rollback ${journal.stamp}`;
		} else {
			skipReasons.push(
				`${result.journalPath}: HEAD ${short(current)} (branch "${branch || "(detached)"}") is neither the rolled-back ${short(journal.lastGood)} nor main past the cause ${short(journal.head)}; check the checkout, then apply --clear-rollback`,
			);
		}
	} else if (branch === "" && options.allowDetached === true && current !== undefined) {
		result.detached = true;
		result.checkout = `detached@${current} (--allow-detached)`;
	} else if (branch !== "main") skipReasons.push(`checkout is on branch "${branch || "(detached)"}", not main`);
	else if (!onMain) skipReasons.push("HEAD differs from main");
	const dirty = await git("status", "--porcelain", "--", "src");
	if (dirty.code !== 0) skipReasons.push(`git status failed: ${dirty.stderr.trim()}`);
	else if (dirty.stdout.trim() !== "") {
		skipReasons.push(`uncommitted changes under src: ${dirty.stdout.trim().split("\n").length} file(s)`);
	}
	return result;
}

/** Prefix of every unit `apply --detach` (and `!restart`) starts; `ompbot-apply-<stamp>-<4 hex>`. */
export const APPLY_UNIT_PREFIX = "ompbot-apply-";

/**
 * The `systemd-run` command that runs `apply <childArgs>` as a transient user unit, for `apply --detach` and
 * `!restart` alike. The unit name carries a random suffix so two launches in the same second never collide; the
 * receipt keeps the bare stamp. `homeEnv`: pass `OMPBOT_HOME` (the caller runs under a non-default home).
 */
export function detachedApplyCommand(input: {
	bun: string;
	repoDir: string;
	pathEnv: string;
	stamp: string;
	childArgs: readonly string[];
	homeEnv?: string;
}): { unit: string; argv: string[] } {
	const unit = `${APPLY_UNIT_PREFIX}${input.stamp}-${crypto.randomUUID().slice(0, 4)}`;
	const setenv = [`--setenv=PATH=${input.pathEnv}`];
	if (input.homeEnv !== undefined) setenv.push(`--setenv=OMPBOT_HOME=${input.homeEnv}`);
	return {
		unit,
		argv: [
			"systemd-run",
			"--user",
			"--collect",
			`--unit=${unit}`,
			`--working-directory=${input.repoDir}`,
			...setenv,
			input.bun,
			join(input.repoDir, "src", "main.ts"),
			...input.childArgs,
		],
	};
}

/**
 * The model-free apply report (`--report-plain`, `!restart`): one line with the outcome and the loaded commit, the
 * failed steps, the code rollback line of the model report, then the receipt path. Redacted: it is posted as is.
 */
export function plainReportText(input: {
	status: ApplyStatus;
	head: string | undefined;
	steps: readonly StepRecord[];
	gates: ApplyReceipt["gates"];
	reverted: string;
	receiptPath: string;
}): string {
	const head = input.head?.slice(0, 7) ?? "(head unknown)";
	const failed = input.steps.filter((s) => !s.ok).map((s) => `${s.name}: ${s.detail}`);
	let first: string;
	if (input.status === "ok" || input.status === "already_applied") {
		const gates = input.gates;
		const health =
			gates === undefined || gates.open === 0
				? "gates 이상 없음"
				: `gates 열림 ${gates.open}/${gates.total} (${gates.opened.join(", ")})`;
		first = `✅ 재시작 ${input.status === "ok" ? "완료" : "이미 반영됨"} · ${head} · ${health}`;
	} else {
		first = `⚠️ 재시작 ${input.status} · ${head}${failed.length > 0 ? ` · ${failed.join("; ")}` : ""}`;
	}
	return redact(`${first}${input.reverted}\n영수증 ${input.receiptPath}`);
}

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
 * When that restart fails too, the code goes back once to `head.last-good` (`apply.codeRollback`: a revert commit on
 * main, pushed, or a detached checkout with main untouched) with one more restart; otherwise (`off`, or no safe
 * target) the receipt carries the previous HEAD and the revert command.
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
	const mode: CodeRollbackMode = options.codeRollback ?? "push";
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
		lastGoodHead: undefined,
		previousHead: undefined,
		revertCommand: undefined,
		codeRollback: mode,
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
	// The revert commit a code rollback made on main; the report names it so the owner fixes the cause and merges again.
	let codeRevert: string | undefined;
	// The commit a `detach` code rollback checked out (main untouched); the report says how to come back.
	let codeDetached: string | undefined;
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
			const reverted =
				codeRevert !== undefined
					? ` 코드 롤백함: main에 revert 커밋 ${codeRevert.slice(0, 7)}, 원인 수정 뒤 다시 머지.`
					: codeDetached !== undefined
						? ` 코드 롤백함: ${codeDetached.slice(0, 7)}로 detached checkout(main 그대로), 고친 커밋을 받은 뒤 git checkout main && apply.`
						: "";
			// `--report-plain` (`!restart`): no model turn — the daemon posts the line itself (`notify`), so the report
			// still arrives when the model is what is down.
			const request =
				options.reportPlain === true
					? {
							op: "notify",
							origin: options.reportOrigin,
							thread: options.reportThread,
							stamp,
							text: plainReportText({
								status,
								head: receipt.head,
								steps,
								gates: receipt.gates,
								reverted,
								receiptPath,
							}),
						}
					: {
							op: "inject",
							origin: options.reportOrigin,
							asOwner: true,
							text:
								`[자동 후속] apply 결과 ${status}${summary ? ` (${summary})` : ""}.${reverted} 영수증 ${receiptPath}를 읽고 ` +
								"증거와 함께 이 스레드에 짧게 보고해줘(새 수정·재시작 금지).",
							thread: options.reportThread,
						};
			const [done, verb] = options.reportPlain === true ? ["notified", "notify"] : ["injected", "inject"];
			// A daemon restarting under someone else's apply (or by hand) refuses connections for a few seconds:
			// retry those. A daemon that answered, even with a refusal, is not asked again.
			let ok = false;
			let detail = "";
			for (let attempt = 1; ; attempt += 1) {
				try {
					const response = await deps.callDaemon(request, 30_000);
					ok = typeof response === "object" && response !== null && "ok" in response && response.ok === true;
					detail = ok
						? `${done} attempts=${attempt}`
						: `${verb} refused attempts=${attempt}: ${JSON.stringify(response)}`;
					break;
				} catch (error) {
					if (isConnectFailure(error) && attempt < REPORT_INJECT_ATTEMPTS) {
						await deps.sleep(REPORT_INJECT_RETRY_MS);
						continue;
					}
					detail = `${verb} failed attempts=${attempt}: ${msg(error)}`;
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
	// `<git dir>/ompbot-code-rollback.json`, known once preflight passed.
	let journalPath = "";
	// A journal while HEAD is a main past the commit that broke the daemon: the apply that comes up removes it.
	let journalOnMain = false;
	// Passed on a detached HEAD (the journal's commit, or `--allow-detached`): not main, so no head.last-good is
	// recorded and neither the hold nor the journal is removed.
	let detached = false;
	let checkout = "";
	const preflightNotes: string[] = [];
	await step("preflight", async () => {
		const exists = existsSync(join(repoDir, "src", "main.ts"));
		if (!exists) skipReasons.push(`src/main.ts not found in ${repoDir}`);
		else {
			const check = await checkCheckout(git, options);
			skipReasons.push(...check.skipReasons);
			preflightNotes.push(...check.notes);
			receipt.head = check.head;
			({ journalPath, journalOnMain, detached, checkout } = check);
			const active = await deps.run(["systemctl", "--user", "is-active", unit], {
				env: { PATH: deps.pathEnv },
			});
			if (active.code !== 0) {
				skipReasons.push(`systemctl --user is-active ${unit} rc=${active.code} (daemon not active or no user bus)`);
			}
			// The last verified commit is the revert target; without one, the reflog's previous position.
			receipt.lastGoodHead = readHeadLastGood(homeDir);
			let prev = receipt.lastGoodHead;
			if (prev === undefined) {
				const reflog = await git("rev-parse", "--verify", "-q", "HEAD@{1}");
				if (reflog.code === 0) prev = reflog.stdout.trim();
			}
			if (prev !== undefined && receipt.head !== undefined && prev !== receipt.head) {
				receipt.previousHead = prev;
				receipt.revertCommand = revertCommandFor(repoDir, prev);
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
		if (skipReasons.length > 0) return { ok: false, detail: [...skipReasons, ...preflightNotes].join("; ") };
		const ready = alreadyApplied ?? `${checkout || `main@${receipt.head}`} clean, bun=${bun}`;
		return { ok: true, detail: [`${ready} codeRollback=${mode}`, ...preflightNotes].join("; ") };
	});
	if (skipReasons.length > 0) return finish("skipped", 3);

	// Once this daemon runs the code, the other installs on the same checkout get it too. A peer that fails turns
	// the whole apply into a failure (exit 1) so a caller does not mistake a half-applied checkout for done.
	// true when every peer applied (or there is none).
	const runPeers = async (afterCodeRollback: boolean): Promise<boolean> => {
		const peers = deps.peers;
		if (peers === undefined) return true;
		let allOk = true;
		await step("peers", async () => {
			const results = await peers(afterCodeRollback);
			allOk = results.every((p) => p.exitCode === 0);
			const detail = results.map((p) => `${p.unit}=${p.status}(${p.receiptPath})`).join(" ");
			return { ok: allOk, detail: detail || "no other install on this checkout" };
		});
		return allOk;
	};
	const finishWithPeers = async (status: "ok" | "already_applied"): Promise<ApplyOutcome> =>
		(await runPeers(false)) ? finish(status, 0) : finish("failed", 1);
	// The status page is its own process on this checkout: one up since before this daemon still draws the old code
	// (11-13 it missed a gate merged after it started). Only this home's page; whatever happens here is a detail, never
	// the apply's status or exit code.
	const restartDashboard = (): Promise<boolean> =>
		step("dashboard", async () => {
			try {
				const env = { PATH: deps.pathEnv };
				const pages = (
					await findCheckoutUnits(deps.run, deps.pathEnv, repoDir, defaultHomeDir({}), "dashboard")
				).filter((page) => resolve(page.homeDir) === resolve(homeDir));
				if (pages.length === 0) return { ok: true, detail: "skipped: no active dashboard unit of this home" };
				const show = await deps.run(
					["systemctl", "--user", "show", "-p", "ActiveEnterTimestamp", "--value", "--timestamp=unix", unit],
					{ env },
				);
				const daemonSince = show.code === 0 ? parseUnixTimestamp(show.stdout) : undefined;
				if (daemonSince === undefined) return { ok: true, detail: `skipped: ${unit} start time unknown` };
				const details: string[] = [];
				for (const page of pages) {
					if (page.activeSince === undefined || page.activeSince > daemonSince) {
						const why = page.activeSince === undefined ? "start time unknown" : "dashboard newer";
						details.push(`skipped: ${why} (${page.unit})`);
						continue;
					}
					const restarted = await deps.run(["systemctl", "--user", "restart", page.unit], { env });
					details.push(
						restarted.code === 0
							? `restarted ${page.unit}`
							: `failed: systemctl restart ${page.unit} rc=${restarted.code}: ${restarted.stderr.trim()}`,
					);
				}
				return { ok: true, detail: details.join("; ") };
			} catch (error) {
				return { ok: true, detail: `failed: ${msg(error)}` };
			}
		});
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
	if (alreadyApplied !== undefined) {
		await restartDashboard();
		return finishWithPeers("already_applied");
	}

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

	const installDeps = async (): Promise<EnsureDepsResult> => {
		try {
			return await ensureDeps(repoDir, { ...deps, bun: bun ?? "bun", stamp });
		} catch (error) {
			return { ok: false, detail: msg(error), noted: true };
		}
	};

	// 3b. dependencies: the restarted daemon loads node_modules as the checkout holds it. Recorded as a step only when
	// the marker was not up to date; a failed install restarts nothing and lets the old daemon take turns again.
	const depsT0 = deps.now();
	const ensured = await installDeps();
	if (ensured.noted) {
		const detail = ensured.ok
			? ensured.detail
			: `${ensured.detail}\nnot restarted; by hand: cd ${repoDir} && bun install --frozen-lockfile && bun src/main.ts apply; ${await cancelDrain()}`;
		steps.push({ name: "deps", ok: ensured.ok, detail, ms: deps.now() - depsT0 });
		deps.log(`apply step=deps ok=${ensured.ok} detail=${detail}`);
	} else deps.log(`apply deps ${ensured.detail}`);
	if (!ensured.ok) return finish("failed", 1);

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

	// Why the checkout may not be reverted to head.last-good now (a reason), or what to revert from and to. Never mixes
	// in someone's work: main only, nothing staged, no tracked file edited.
	const codeRollbackTarget = async (): Promise<string | { lastGood: string; head: string }> => {
		if (options.codeRollbackOff !== undefined) return options.codeRollbackOff;
		if (mode === "off") return "apply.codeRollback=off";
		const lastGood = receipt.lastGoodHead;
		if (lastGood === undefined) return `${HEAD_LAST_GOOD_FILE} 없음`;
		const head = await git("rev-parse", "HEAD");
		if (head.code !== 0) return `git rev-parse HEAD rc=${head.code}: ${head.stderr.trim()}`;
		const current = head.stdout.trim();
		if (current === lastGood) return `${HEAD_LAST_GOOD_FILE} ${lastGood.slice(0, 7)}가 HEAD와 같음`;
		const ancestor = await git("merge-base", "--is-ancestor", lastGood, current);
		if (ancestor.code !== 0)
			return `${HEAD_LAST_GOOD_FILE} ${lastGood.slice(0, 7)}가 HEAD ${current.slice(0, 7)}의 조상이 아님`;
		const branch = (await git("branch", "--show-current")).stdout.trim();
		if (branch !== "main") return `브랜치가 main이 아님 (${branch || "(detached)"})`;
		const staged = await git("diff", "--cached", "--quiet");
		if (staged.code !== 0) return "staged 변경 있음";
		const dirty = await git("status", "--porcelain", "--untracked-files=no");
		if (dirty.code !== 0) return `git status failed: ${dirty.stderr.trim()}`;
		if (dirty.stdout.trim() !== "") return `추적 파일 미커밋 변경 ${dirty.stdout.trim().split("\n").length}개`;
		return { lastGood, head: current };
	};

	// 8. code rollback, once. `push`: a new commit on main with the tree of head.last-good (the 2-way read-tree of
	// `revertCommandFor`), pushed. `detach`: the journal, then head.last-good checked out detached, main untouched.
	// Then `ensureDeps` (installs when the deps marker differs) and one more restart.
	const rollbackCode = async (target: { lastGood: string; head: string }): Promise<StepResult> => {
		const details: string[] = [];
		const failed = async (detail: string): Promise<StepResult> => {
			details.push(detail, await cancelDrain());
			return { ok: false, detail: details.join("; ") };
		};
		const moved = mode === "detach" ? await detachToLastGood(target, details) : await revertOnMain(target, details);
		if (typeof moved === "string") return failed(moved);
		try {
			atomicWrite0600(join(homeDir, AUTOLAND_HOLD_FILE), `${JSON.stringify(moved)}\n`);
			details.push(`${AUTOLAND_HOLD_FILE} written`);
		} catch (error) {
			details.push(`${AUTOLAND_HOLD_FILE} write failed: ${msg(error)}`);
		}
		const installed = await installDeps();
		if (!installed.ok) {
			return failed(
				`${installed.detail}\nnot restarted; by hand: cd ${repoDir} && bun install --frozen-lockfile && systemctl --user restart ${unit}`,
			);
		}
		details.push(installed.detail);
		const r = await restartAndWait();
		if (!r.ok) return failed(r.detail);
		const w = await waitReady(r.restartAt);
		if (!w.ok) return failed(`restart failed: ${w.detail}`);
		const t = await waitTransports(r.restartAt);
		if (!t.ok) return failed(`restart failed: ${t.detail}`);
		details.push(`restart ok: ${w.detail}, ${t.detail}`);
		return { ok: true, detail: details.join("; ") };
	};

	// `detach`: the journal goes first, so a crash after the checkout still leaves the checkout explained. A failed
	// checkout removes it again (HEAD stays on main). The autoland hold to write, or why it failed.
	async function detachToLastGood(
		target: { lastGood: string; head: string },
		details: string[],
	): Promise<Record<string, string> | string> {
		const { lastGood, head } = target;
		const journal: CodeRollbackJournal = { lastGood, head, stamp, home: homeDir };
		try {
			atomicWrite0600(journalPath, `${JSON.stringify(journal)}\n`);
		} catch (error) {
			return `${journalPath} write failed: ${msg(error)}`;
		}
		const checkout = await git("checkout", "-q", "--detach", lastGood);
		if (checkout.code !== 0) {
			rmSync(journalPath, { force: true });
			return `git checkout --detach ${lastGood} rc=${checkout.code}: ${checkout.stderr.trim()} (journal removed, HEAD stays at ${head})`;
		}
		codeDetached = lastGood;
		details.push(`HEAD detached at ${lastGood}, main stays at ${head}; journal ${journalPath}`);
		return {
			reason: `코드 롤백(apply ${stamp}): detach → ${lastGood.slice(0, 7)} (main ${head.slice(0, 7)} 그대로)`,
			at: new Date(deps.now()).toISOString(),
			lastGood,
			receipt: receiptPath,
		};
	}

	// `push`: the revert commit on main, pushed (a failed push is recorded and the rollback goes on).
	async function revertOnMain(
		target: { lastGood: string; head: string },
		details: string[],
	): Promise<Record<string, string> | string> {
		const { lastGood, head } = target;
		const read = await git("read-tree", "-m", "-u", "HEAD", lastGood);
		if (read.code !== 0) return `git read-tree rc=${read.code}: ${read.stderr.trim()}`;
		const title = `revert(apply): ${stamp} 기동 실패로 ${lastGood.slice(0, 7)} 트리로 복원`;
		const body = `되돌린 범위: ${lastGood}..${head}\n영수증: ${receiptPath}`;
		// Hooks are skipped: the tree is one that already ran, and a hook must not keep the bot down.
		const commit = await git("commit", "-q", "--no-verify", "-m", title, "-m", body);
		if (commit.code !== 0) {
			const back = await git("read-tree", "-m", "-u", lastGood, "HEAD");
			return `git commit rc=${commit.code}: ${commit.stderr.trim()} (worktree ${back.code === 0 ? "restored to HEAD" : `restore failed: ${back.stderr.trim()}`})`;
		}
		const revert = (await git("rev-parse", "HEAD")).stdout.trim();
		codeRevert = revert;
		details.push(`revert ${revert} = tree of ${lastGood} (reverted ${lastGood}..${head})`);
		const push = await git("push", "origin", "main");
		const pushFailure =
			push.code === 0 ? undefined : `push 실패: rc=${push.code} ${push.stderr.trim().split("\n").at(-1) ?? ""}`.trim();
		details.push(pushFailure ?? "pushed origin main");
		return {
			reason: `코드 롤백(apply ${stamp}): revert ${revert.slice(0, 7)} → ${lastGood.slice(0, 7)} 트리${pushFailure === undefined ? "" : `; ${pushFailure}`}`,
			at: new Date(deps.now()).toISOString(),
			revert,
			lastGood,
			receipt: receiptPath,
		};
	}

	// 7. rollback on failure: last known-good config back, one more restart. Only when that fails too, the code goes
	// back to head.last-good (8); otherwise the code stays and the receipt describes how to revert it.
	if (!ready) {
		let codeTarget: { lastGood: string; head: string } | undefined;
		const recovered = await step("rollback", async () => {
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
				// Answering IPC with every chat transport down is not a recovery: same bar as the apply restart.
				if (w.ok) {
					const t = await waitTransports(r.restartAt);
					ok = t.ok;
					details.push(`transports ${t.ok ? "ok" : "failed"}: ${t.detail}`);
				}
			}
			if (!ok) {
				const target = await codeRollbackTarget();
				if (typeof target === "string") details.push(await cancelDrain(), `code rollback skipped: ${target}`);
				else {
					codeTarget = target;
					details.push(`code rollback to ${target.lastGood} follows`);
					return { ok, detail: details.join("; ") };
				}
			}
			if (receipt.revertCommand !== undefined) details.push(`code not reverted; to revert: ${receipt.revertCommand}`);
			else details.push("code not reverted (previous HEAD unknown)");
			return { ok, detail: details.join("; ") };
		});
		if (recovered || codeTarget === undefined) return finish("failed", 1);
		const target = codeTarget;
		const cameUp = await step("code_rollback", () => rollbackCode(target));
		// The peers share the checkout: they restart onto the reverted code too. The apply still failed.
		if (cameUp) await runPeers(true);
		return finish("failed", 1);
	}

	// 6. record health; open gates or doctor failures are reported, they do not undo the apply.
	const unverified: string[] = [];
	let verified = false;
	await step("verify", async () => {
		const gates = deps.gates();
		const open = gates.filter((g) => g.state === "open");
		receipt.gates = { open: open.length, total: gates.length, opened: open.map((g) => `${g.name}(${g.detail})`) };
		const doctor = await deps.doctor();
		receipt.doctor = { code: doctor.code, failed: doctor.lines.filter((l) => l.startsWith("fail ")) };
		if (doctor.code !== 0) unverified.push(`doctor rc=${doctor.code}`);
		for (const g of open) if (LAST_GOOD_BLOCKING_GATES.includes(g.name)) unverified.push(`gate ${g.name} open`);
		verified = true;
		return {
			ok: true,
			detail: `gates open=${open.length}/${gates.length} doctor rc=${doctor.code} failed=${receipt.doctor.failed.length}`,
		};
	});
	// The daemon came up on this config: remember it as the rollback target of the next failed apply. Its code becomes
	// the code rollback target only when doctor and the runtime gates agree. An auto-merge hold (and a detach journal)
	// ends here only on main: a detached apply (a peer or a retry after a code rollback, `--allow-detached`) runs code
	// that is not main, so it keeps both and records no head.last-good.
	await step("last_good", () => {
		const details = [
			recordLastGoodConfig(homeDir) ? `${configPath}${LAST_GOOD_SUFFIX}` : "no config.json or copy failed",
		];
		if (detached) {
			details.push(`${HEAD_LAST_GOOD_FILE}, ${AUTOLAND_HOLD_FILE} and journal kept (detached HEAD)`);
			return { ok: true, detail: details.join("; ") };
		}
		if (!verified) unverified.push("verify did not finish");
		if (receipt.head === undefined) unverified.push("HEAD unknown");
		if (unverified.length > 0) details.push(`${HEAD_LAST_GOOD_FILE} not recorded (${unverified.join(", ")})`);
		else {
			try {
				atomicWrite0600(join(homeDir, HEAD_LAST_GOOD_FILE), `${receipt.head}\n`);
				details.push(`${HEAD_LAST_GOOD_FILE}=${receipt.head}`);
			} catch (error) {
				details.push(`${HEAD_LAST_GOOD_FILE} write failed: ${msg(error)}`);
			}
		}
		const holdPath = join(homeDir, AUTOLAND_HOLD_FILE);
		if (existsSync(holdPath)) {
			rmSync(holdPath, { force: true });
			details.push(`${AUTOLAND_HOLD_FILE} removed`);
		}
		if (journalOnMain) {
			rmSync(journalPath, { force: true });
			details.push(`${journalPath} removed`);
		}
		return { ok: true, detail: details.join("; ") };
	});
	await restartDashboard();
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
