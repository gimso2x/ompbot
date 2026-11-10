import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultHomeDir, loadConfig } from "../config";
import { runDoctor } from "../daemon/doctor";
import { callDaemon } from "../daemon/ipc";
import {
	type ApplyDeps,
	applyPathEnv,
	DEFAULT_DRAIN_TIMEOUT_MIN,
	findBun,
	findDaemonUnits,
	isExecutableFile,
	isReportOrigin,
	type PeerApply,
	REPORT_THREAD_PATTERN,
	readLockStartedAt,
	receiptPathFor,
	runApply,
	STAMP_PATTERN,
	SYSTEMD_UNIT,
	spawnRunner,
} from "../ops/apply";
import { backupStamp, runBackup } from "../ops/backup";
import { collectGates } from "../ops/gates";
import { socketDrainCall, waitForDrain } from "./drain";

export const APPLY_USAGE = `  apply [--detach] [--stamp <YYYYMMDD-HHMMSS>] [--timeout <min>] [--merged-at <iso>] [--report-origin <slack/ch/C|slack/dm/D> --report-thread <ts>] [--json]
                                 precheck (main, HEAD==main, clean src, bun) → backup + config copy → drain --wait (default
                                 60 min) → systemctl --user restart <this home's unit> → wait for a fresh daemon (2 min) →
                                 gates/doctor summary; on failure restores config and restarts once (code is not reverted).
                                 Then the same apply runs for every other active install on this checkout (ompbot-<instance>,
                                 own home and receipt); a failed one makes the exit 1. Receipt:
                                 <home>/logs/apply-<stamp>.json. --detach re-launches it as a systemd-run unit and returns.
                                 --stamp YYYYMMDD-HHMMSS: fix the receipt/backup stamp (--detach passes its own to the unit).
                                 --merged-at: skip when the daemon already started after that time. exit 0 ok/already
                                 applied, 1 failed, 2 usage, 3 precheck SKIP
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
	let mergedAt: Date | undefined;
	if (values["merged-at"] !== undefined) {
		mergedAt = new Date(values["merged-at"]);
		if (Number.isNaN(mergedAt.getTime())) return usageError("--merged-at must be an ISO timestamp");
	}
	const reportOrigin = values["report-origin"];
	const reportThread = values["report-thread"];
	if (reportOrigin !== undefined && !isReportOrigin(reportOrigin)) {
		return usageError("--report-origin must be slack/ch/<channel id> or slack/dm/<dm id>");
	}
	if (reportThread !== undefined && (reportOrigin === undefined || !REPORT_THREAD_PATTERN.test(reportThread))) {
		return usageError("--report-thread <ts> needs --report-origin and a Slack ts like 1793318305.840629");
	}
	if (values.stamp !== undefined && !STAMP_PATTERN.test(values.stamp))
		return usageError("--stamp must be YYYYMMDD-HHMMSS");

	const stamp = values.stamp ?? backupStamp(new Date());
	const pathEnv = applyPathEnv(env);
	if (values.detach === true) return await detach({ values, stamp, pathEnv, homeDir, env });

	const options = {
		timeoutMin,
		stamp,
		...(mergedAt === undefined ? {} : { mergedAt }),
	};
	const units = await findDaemonUnits(spawnRunner, pathEnv, REPO_DIR, defaultHomeDir({}));
	const self = resolve(homeDir);
	const peers = units.filter((u) => resolve(u.homeDir) !== self);
	const deps = homeDeps(homeDir, units.find((u) => resolve(u.homeDir) === self)?.unit ?? SYSTEMD_UNIT, pathEnv);
	deps.peers = async () => {
		const results: PeerApply[] = [];
		for (const peer of peers) {
			const { exitCode, receipt } = await runApply(options, homeDeps(peer.homeDir, peer.unit, pathEnv));
			results.push({ unit: peer.unit, status: receipt.status, exitCode, receiptPath: receipt.receiptPath });
		}
		return results;
	};
	const { exitCode, receipt } = await runApply(
		{
			...options,
			...(reportOrigin === undefined ? {} : { reportOrigin }),
			...(reportThread === undefined ? {} : { reportThread }),
		},
		deps,
	);
	if (values.json === true) process.stdout.write(`${JSON.stringify(receipt)}\n`);
	else {
		for (const step of receipt.steps)
			process.stdout.write(`step ${step.name} ok=${step.ok} ms=${step.ms} ${step.detail}\n`);
		if (receipt.report !== undefined) process.stdout.write(`report ok=${receipt.report.ok} ${receipt.report.detail}\n`);
		process.stdout.write(`apply_done status=${receipt.status} exit=${exitCode} receipt=${receipt.receiptPath}\n`);
	}
	return exitCode;
}

/** Everything `runApply` needs for one install: its home, socket, config-driven backup/gates and its unit. */
function homeDeps(homeDir: string, unit: string, pathEnv: string): ApplyDeps {
	const config = existsSync(join(homeDir, "config.json")) ? loadConfig(homeDir) : undefined;
	const socketPath = join(homeDir, "ompbot.sock");
	const omp = config !== undefined && (config.agent ?? "omp") === "omp" ? { ompExecutable: config.ompExecutable } : {};
	return {
		homeDir,
		unit,
		repoDir: REPO_DIR,
		pathEnv,
		now: () => Date.now(),
		sleep: (ms) => Bun.sleep(ms),
		run: spawnRunner,
		callDaemon: (request, timeoutMs) => callDaemon(socketPath, request, timeoutMs),
		drain: (min) => waitForDrain({ call: socketDrainCall(socketPath), timeoutMin: min }),
		backup: () =>
			runBackup({
				homeDir,
				...(config?.maxBundleBytes === undefined ? {} : { maxBundleBytes: config.maxBundleBytes }),
			}),
		gates: () =>
			collectGates({
				homeDir,
				now: Date.now(),
				offsiteConfigured: config?.offsite !== undefined,
				...(config?.costCap?.dailyUsd === undefined ? {} : { dailyCapUsd: config.costCap.dailyUsd }),
				...omp,
			}),
		doctor: async () => {
			const lines: string[] = [];
			const code = await runDoctor(homeDir, (line) => lines.push(line));
			return { code, lines };
		},
		lockStartedAt: () => readLockStartedAt(homeDir),
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
			"merged-at": { type: "string" },
			"report-origin": { type: "string" },
			"report-thread": { type: "string" },
			json: { type: "boolean" },
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
	const unit = `ompbot-apply-${stamp}`;
	const childArgs = ["apply", "--stamp", stamp];
	for (const key of ["timeout", "merged-at", "report-origin", "report-thread"] as const) {
		const value = values[key];
		if (value !== undefined) childArgs.push(`--${key}`, value);
	}
	if (values.json === true) childArgs.push("--json");
	const setenv = [`--setenv=PATH=${pathEnv}`];
	if (env.OMPBOT_HOME !== undefined) setenv.push(`--setenv=OMPBOT_HOME=${homeDir}`);
	const result = await spawnRunner(
		[
			"systemd-run",
			"--user",
			"--collect",
			`--unit=${unit}`,
			`--working-directory=${REPO_DIR}`,
			...setenv,
			bun,
			join(REPO_DIR, "src", "main.ts"),
			...childArgs,
		],
		{ env: { PATH: pathEnv } },
	);
	if (result.code !== 0) {
		process.stderr.write(`apply: systemd-run failed rc=${result.code}: ${result.stderr.trim()}\n`);
		return 1;
	}
	process.stdout.write(`apply_detached unit=${unit} receipt=${receiptPathFor(homeDir, stamp)}\n`);
	return 0;
}
