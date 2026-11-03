import {
	chmodSync,
	copyFileSync,
	existsSync,
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
import { type BackupResult, backupStamp } from "./backup";
import type { Gate } from "./gates";

/** How long the restarted daemon gets to answer IPC `status` from a fresh start. */
export const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 1_000;
export const DEFAULT_DRAIN_TIMEOUT_MIN = 60;
export const SYSTEMD_UNIT = "ompbot";

export const REPORT_ORIGIN_PATTERN = /^slack\/(ch|dm)\/[A-Z0-9]+$/;
export const REPORT_THREAD_PATTERN = /^\d+\.\d+$/;
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
	/** Checkout holding `src/main.ts`; the daemon loads its code from here. */
	repoDir: string;
	/** PATH (with ~/.local/bin and ~/.bun/bin prepended) for every child process and for finding bun. */
	pathEnv: string;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	run: Runner;
	callDaemon: (request: unknown, timeoutMs: number) => Promise<unknown>;
	drain: (timeoutMin: number) => Promise<DrainWaitResult>;
	backup: () => BackupResult;
	gates: () => Gate[];
	doctor: () => Promise<{ code: number; lines: string[] }>;
	/** `startedAt` (ms) of the process holding `ompbot.lock`; undefined when there is no readable lock. */
	lockStartedAt: () => number | undefined;
	isExecutable: (path: string) => boolean;
	log: (line: string) => void;
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
	head: string | undefined;
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

/**
 * Applies a merged change to the running daemon in one auditable pass: precheck → backup (db + config copy) →
 * drain → restart → wait for a fresh daemon → record gates/doctor → roll back config and restart once on failure.
 * Code is never reverted automatically; the receipt carries the previous HEAD and the revert command instead.
 */
export async function runApply(options: ApplyOptions, deps: ApplyDeps): Promise<ApplyOutcome> {
	const { homeDir, repoDir } = deps;
	const startedMs = deps.now();
	const stamp = options.stamp ?? backupStamp(new Date(startedMs));
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

	const finish = async (status: ApplyStatus, exitCode: 0 | 1 | 3): Promise<ApplyOutcome> => {
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
			let ok = false;
			let detail: string;
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
				detail = ok ? "injected" : `inject refused: ${JSON.stringify(response)}`;
			} catch (error) {
				detail = `inject failed: ${msg(error)}`;
			}
			receipt.report = { origin: options.reportOrigin, thread: options.reportThread, ok, detail };
			writeReceipt();
		}
		return { exitCode, receipt };
	};

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
			const active = await deps.run(["systemctl", "--user", "is-active", SYSTEMD_UNIT], {
				env: { PATH: deps.pathEnv },
			});
			if (active.code !== 0) {
				skipReasons.push(
					`systemctl --user is-active ${SYSTEMD_UNIT} rc=${active.code} (daemon not active or no user bus)`,
				);
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
				["systemctl", "--user", "show", "-p", "ActiveEnterTimestamp", "--value", "--timestamp=unix", SYSTEMD_UNIT],
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
	if (alreadyApplied !== undefined) return finish("already_applied", 0);

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

	// 3. drain: a timeout cancels the drain itself, so nothing was changed and no restart follows.
	const drained = await step("drain", async () => {
		const result = await deps.drain(options.timeoutMin);
		if (result.ok)
			return {
				ok: true,
				detail: `turns=${result.counts.turns} hostTools=${result.counts.hostTools} approvals=${result.counts.approvals}`,
			};
		if (result.reason === "unreachable") return { ok: false, detail: `daemon not reachable: ${result.error}` };
		return { ok: false, detail: `${result.reason} after ${options.timeoutMin} min (drain cancelled)` };
	});
	if (!drained) return finish("failed", 1);

	// 4+5. restart and wait for a daemon that started after the restart request.
	const restartAndWait = async (): Promise<StepResult & { restartAt: number }> => {
		const restartAt = deps.now();
		const restart = await deps.run(["systemctl", "--user", "restart", SYSTEMD_UNIT], { env: { PATH: deps.pathEnv } });
		if (restart.code !== 0)
			return { ok: false, detail: `systemctl restart rc=${restart.code}: ${restart.stderr.trim()}`, restartAt };
		return { ok: true, detail: "restart requested", restartAt };
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

	let restartAt = 0;
	const restarted = await step("restart", async () => {
		const r = await restartAndWait();
		restartAt = r.restartAt;
		return r;
	});
	const ready = restarted && (await step("ready", () => waitReady(restartAt)));

	// A restart path that ends without a verified new daemon leaves the old one draining: cancel it and record it.
	const cancelDrain = async (): Promise<string> => {
		try {
			const response = await deps.callDaemon({ op: "drain_cancel" }, 10_000);
			const ok = typeof response === "object" && response !== null && "ok" in response && response.ok === true;
			return ok ? "drain cancelled" : `drain cancel refused: ${JSON.stringify(response)}`;
		} catch (error) {
			return `drain cancel failed: ${msg(error)}`;
		}
	};

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
	return finish("ok", 0);
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
