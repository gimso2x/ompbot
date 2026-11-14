import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { codeRollbackMode, defaultHomeDir, loadConfig } from "../config";
import { runDoctor } from "../daemon/doctor";
import { readSweepHeartbeat } from "../daemon/heartbeat";
import { callDaemon } from "../daemon/ipc";
import { pidAlive } from "../daemon/lock";
import {
	type ApplyDeps,
	type ApplyOptions,
	applyPathEnv,
	DEFAULT_DRAIN_CUT_MIN,
	DEFAULT_DRAIN_TIMEOUT_MIN,
	detachedApplyCommand,
	findBun,
	findDaemonUnits,
	isExecutableFile,
	isReportOrigin,
	type PeerApply,
	readLockStartedAt,
	receiptPathFor,
	reportThreadPattern,
	runApply,
	STAMP_PATTERN,
	SYSTEMD_UNIT,
	spawnRunner,
} from "../ops/apply";
import { backupStamp, runBackup } from "../ops/backup";
import { collectGates, gateOptionsFromConfig } from "../ops/gates";
import { socketDrainCall, waitForDrain } from "./drain";
import { runProfileSync } from "./omp";

export const APPLY_USAGE = `  apply [--detach] [--stamp <YYYYMMDD-HHMMSS>] [--timeout <min>] [--cut-after <min>] [--merged-at <iso>] [--report-origin <slack/ch/C|slack/dm/D|discord/ch/<id>|discord/dm/<id>> --report-thread <ts|message id> [--report-plain]] [--no-code-rollback] [--clear-rollback] [--allow-detached] [--json]
                                 precheck (main, HEAD==main, clean src, bun) → backup + config copy → with config ompProfile,
                                 ompbot omp sync (a failure stops here) → drain --wait (default 60 min) → systemctl --user
                                 restart <this home's unit> → wait for a fresh daemon (2 min) → wait for its heartbeat
                                 after the restart with no Slack/Discord transport down (2 min) → gates/doctor summary; ok
                                 with doctor rc=0 and no omp_runtime/turns_failing gate open records the loaded commit in
                                 <home>/head.last-good. On failure restores config and restarts once; if that restart
                                 fails too, the code goes back to head.last-good (main only, no staged or uncommitted
                                 tracked change) as config apply.codeRollback says: detach (default) writes
                                 <git dir>/ompbot-code-rollback.json and checks head.last-good out detached, main
                                 untouched; push makes one revert commit on main with its tree and runs git push origin
                                 main; off reverts nothing and names the revert command. Then bun install
                                 --frozen-lockfile when package.json/bun.lock differ, restarts once more, writes
                                 <home>/autoland.hold (auto-merge stops until the next ok apply on main) and still exits 1.
                                 --no-code-rollback: never revert code (as off).
                                 With the journal, apply runs only on its detached commit (keeping journal, hold and
                                 head.last-good) or on a main past the commit that broke the daemon (which removes it);
                                 HEAD still that commit or anything else SKIPs. --clear-rollback: remove the journal
                                 first. --allow-detached: apply a detached HEAD picked by hand (no journal), recording
                                 no head.last-good and keeping autoland.hold.
                                 --cut-after <min> (default 5): a drain still busy then restarts anyway; the daemon records
                                 the cut turns (<home>/restart-cut.json) and the next process resumes each once in its
                                 session. --cut-after 0: no cut, a --timeout cancels the drain and nothing restarts.
                                 Then the same apply runs for every other active install on this checkout (ompbot-<instance>,
                                 own home and receipt); a failed one makes the exit 1. Receipt:
                                 <home>/logs/apply-<stamp>.json. --detach re-launches it as a systemd-run unit and returns.
                                 --stamp YYYYMMDD-HHMMSS: fix the receipt/backup stamp (--detach passes its own to the unit).
                                 One apply per home at a time (<home>/apply.lock): a second one waits (step wait_apply) and
                                 ends already_applied when the one it waited for finished ok on the same HEAD.
                                 --merged-at: skip when the daemon already started after that time. exit 0 ok/already
                                 applied, 1 failed, 2 usage, 3 precheck SKIP. --report-origin asks the model of that thread
                                 to report (an [자동 후속] turn); with --report-plain the daemon posts the result line
                                 itself (IPC notify, no model turn). The --detach unit is ompbot-apply-<stamp>-<4 hex>.
`;

/** Checkout holding this very file's `src/main.ts` (src/cli/apply.ts → repo root). */
const REPO_DIR = resolve(import.meta.dir, "..", "..");

function usageError(message: string): number {
	process.stderr.write(`apply: ${message}\n${APPLY_USAGE}`);
	return 2;
}

/** `ompbot apply`; resolves with the exit code. */
export async function applyCommand(
	args: string[],
	homeDir: string,
	env: Record<string, string | undefined> = process.env,
): Promise<number> {
	let values: ReturnType<typeof parseValues>;
	try {
		values = parseValues(args);
	} catch (error) {
		return usageError(error instanceof Error ? error.message : String(error));
	}
	if (values.help === true) {
		process.stdout.write(`usage:\n${APPLY_USAGE}`);
		return 0;
	}
	const timeoutMin = values.timeout === undefined ? DEFAULT_DRAIN_TIMEOUT_MIN : Number(values.timeout);
	if (values.timeout !== undefined && (!/^\d+(\.\d+)?$/.test(values.timeout) || !Number.isFinite(timeoutMin))) {
		return usageError("--timeout must be a non-negative number of minutes");
	}
	const cutAfterMin = values["cut-after"] === undefined ? DEFAULT_DRAIN_CUT_MIN : Number(values["cut-after"]);
	if (
		values["cut-after"] !== undefined &&
		(!/^\d+(\.\d+)?$/.test(values["cut-after"]) || !Number.isFinite(cutAfterMin))
	) {
		return usageError("--cut-after must be a non-negative number of minutes");
	}
	let mergedAt: Date | undefined;
	if (values["merged-at"] !== undefined) {
		mergedAt = new Date(values["merged-at"]);
		if (Number.isNaN(mergedAt.getTime())) return usageError("--merged-at must be an ISO timestamp");
	}
	const reportOrigin = values["report-origin"];
	const reportThread = values["report-thread"];
	if (reportOrigin !== undefined && !isReportOrigin(reportOrigin)) {
		return usageError(
			"--report-origin must be slack/ch/<channel id>, slack/dm/<dm id>, discord/ch/<channel id> or discord/dm/<dm id>",
		);
	}
	if (
		reportThread !== undefined &&
		(reportOrigin === undefined || !reportThreadPattern(reportOrigin).test(reportThread))
	) {
		return usageError(
			"--report-thread needs --report-origin and a Slack ts like 1793318305.840629 (slack/...) or a Discord message id (discord/...)",
		);
	}
	if (values["report-plain"] === true && reportOrigin === undefined)
		return usageError("--report-plain needs --report-origin");
	if (values.stamp !== undefined && !STAMP_PATTERN.test(values.stamp))
		return usageError("--stamp must be YYYYMMDD-HHMMSS");

	const stamp = values.stamp ?? backupStamp(new Date());
	const pathEnv = applyPathEnv(env);
	if (values.detach === true) return await detach({ values, stamp, pathEnv, homeDir, env });

	const options: ApplyOptions = {
		timeoutMin,
		cutAfterMin,
		stamp,
		...(mergedAt === undefined ? {} : { mergedAt }),
		codeRollback: codeRollbackMode(
			existsSync(join(homeDir, "config.json")) ? loadConfig(homeDir, { checkTokens: false }) : undefined,
		),
		...(values["clear-rollback"] === true ? { clearRollback: true } : {}),
		...(values["allow-detached"] === true ? { allowDetached: true } : {}),
		...(values["no-code-rollback"] === true ? { codeRollbackOff: "--no-code-rollback" } : {}),
		...(reportOrigin === undefined ? {} : { reportOrigin }),
		...(reportThread === undefined ? {} : { reportThread }),
		...(values["report-plain"] === true ? { reportPlain: true } : {}),
	};
	const units = await findDaemonUnits(spawnRunner, pathEnv, REPO_DIR, defaultHomeDir({}));
	const self = resolve(homeDir);
	const peers = units.filter((u) => resolve(u.homeDir) !== self);
	const deps = homeDeps(homeDir, units.find((u) => resolve(u.homeDir) === self)?.unit ?? SYSTEMD_UNIT, pathEnv);
	deps.peers = async (afterCodeRollback = false) => {
		const results: PeerApply[] = [];
		for (const peer of peers) {
			const { exitCode, receipt } = await runApply(
				peerApplyOptions(options, afterCodeRollback),
				homeDeps(peer.homeDir, peer.unit, pathEnv),
			);
			results.push({ unit: peer.unit, status: receipt.status, exitCode, receiptPath: receipt.receiptPath });
		}
		return results;
	};
	const { exitCode, receipt } = await runApply(options, deps);
	if (values.json === true) process.stdout.write(`${JSON.stringify(receipt)}\n`);
	else {
		for (const step of receipt.steps)
			process.stdout.write(`step ${step.name} ok=${step.ok} ms=${step.ms} ${step.detail}\n`);
		if (receipt.report !== undefined) process.stdout.write(`report ok=${receipt.report.ok} ${receipt.report.detail}\n`);
		process.stdout.write(`apply_done status=${receipt.status} exit=${exitCode} receipt=${receipt.receiptPath}\n`);
	}
	return exitCode;
}

/**
 * What the apply of every other install on the checkout runs with. The checkout is shared: only this (first) home's
 * apply reverts code, clears the journal and reports. After a code rollback every peer restarts onto the reverted
 * code, even one that started after --merged-at. `--allow-detached` goes along: the peers load the same detached HEAD
 * and would SKIP without it.
 */
export function peerApplyOptions(options: ApplyOptions, afterCodeRollback: boolean): ApplyOptions {
	return {
		timeoutMin: options.timeoutMin,
		...(options.cutAfterMin === undefined ? {} : { cutAfterMin: options.cutAfterMin }),
		...(options.stamp === undefined ? {} : { stamp: options.stamp }),
		...(options.mergedAt === undefined || afterCodeRollback ? {} : { mergedAt: options.mergedAt }),
		...(options.allowDetached === true ? { allowDetached: true } : {}),
		...(options.codeRollback === undefined ? {} : { codeRollback: options.codeRollback }),
		codeRollbackOff: "peer install (the first home's apply owns the code rollback)",
	};
}

/**
 * Everything `runApply` needs for one install: its home, socket, config-driven backup/gates, its unit and, with config
 * `ompProfile`, the profile sync.
 */
export function homeDeps(homeDir: string, unit: string, pathEnv: string): ApplyDeps {
	const config = existsSync(join(homeDir, "config.json")) ? loadConfig(homeDir) : undefined;
	const socketPath = join(homeDir, "ompbot.sock");
	return {
		homeDir,
		unit,
		repoDir: REPO_DIR,
		pathEnv,
		now: () => Date.now(),
		sleep: (ms) => Bun.sleep(ms),
		run: spawnRunner,
		callDaemon: (request, timeoutMs) => callDaemon(socketPath, request, timeoutMs),
		drain: (min, cutAfterMin) =>
			waitForDrain({
				call: socketDrainCall(socketPath),
				timeoutMin: min,
				...(cutAfterMin === undefined ? {} : { cutAfterMin }),
			}),
		// The db snapshot is what an apply rolls back to; the session bundle is the daily backup's job.
		backup: () => runBackup({ homeDir, skipBundle: true }),
		gates: () =>
			collectGates({
				homeDir,
				now: Date.now(),
				...gateOptionsFromConfig(config),
			}),
		doctor: async () => {
			const lines: string[] = [];
			const code = await runDoctor(homeDir, (line) => lines.push(line), REPO_DIR);
			return { code, lines };
		},
		...(config?.ompProfile === undefined
			? {}
			: {
					ompSync: () => ({
						changed: runProfileSync({
							homeDir,
							profile: config.ompProfile,
							env: process.env,
							out: (line) => process.stderr.write(`omp sync: ${line}\n`),
							now: () => Date.now(),
						}),
					}),
				}),
		lockStartedAt: () => readLockStartedAt(homeDir),
		heartbeat: () => readSweepHeartbeat(homeDir),
		pid: process.pid,
		isAlive: pidAlive,
		isExecutable: isExecutableFile,
		log: (line) => process.stderr.write(`${line}\n`),
	};
}

function parseValues(args: string[]) {
	return parseArgs({
		args,
		options: {
			detach: { type: "boolean" },
			timeout: { type: "string" },
			"cut-after": { type: "string" },
			"merged-at": { type: "string" },
			"report-origin": { type: "string" },
			"report-thread": { type: "string" },
			"report-plain": { type: "boolean" },
			json: { type: "boolean" },
			"no-code-rollback": { type: "boolean" },
			"clear-rollback": { type: "boolean" },
			"allow-detached": { type: "boolean" },
			stamp: { type: "string" },
			help: { type: "boolean" },
		},
		strict: true,
	}).values;
}

/** Re-launches `apply` (same arguments, plus a fixed stamp) as a transient user unit and returns immediately. */
async function detach(input: {
	values: ReturnType<typeof parseValues>;
	stamp: string;
	pathEnv: string;
	homeDir: string;
	env: Record<string, string | undefined>;
}): Promise<number> {
	const { values, stamp, pathEnv, homeDir, env } = input;
	const bun = findBun(pathEnv, isExecutableFile);
	if (bun === undefined) {
		process.stderr.write(`apply: bun not found on PATH (${pathEnv})\n`);
		return 3;
	}
	const childArgs = ["apply", "--stamp", stamp];
	for (const key of ["timeout", "cut-after", "merged-at", "report-origin", "report-thread"] as const) {
		const value = values[key];
		if (value !== undefined) childArgs.push(`--${key}`, value);
	}
	if (values.json === true) childArgs.push("--json");
	for (const key of ["no-code-rollback", "clear-rollback", "allow-detached", "report-plain"] as const) {
		if (values[key] === true) childArgs.push(`--${key}`);
	}
	const { unit, argv } = detachedApplyCommand({
		bun,
		repoDir: REPO_DIR,
		pathEnv,
		stamp,
		childArgs,
		...(env.OMPBOT_HOME === undefined ? {} : { homeEnv: homeDir }),
	});
	const result = await spawnRunner(argv, { env: { PATH: pathEnv } });
	if (result.code !== 0) {
		process.stderr.write(`apply: systemd-run failed rc=${result.code}: ${result.stderr.trim()}\n`);
		return 1;
	}
	process.stdout.write(`apply_detached unit=${unit} receipt=${receiptPathFor(homeDir, stamp)}\n`);
	return 0;
}
