import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isOffsiteDir, OFFSITE_SSH } from "../config";
import { dispatchEnv, type ProcessRunner, realProcessRunner } from "../dispatch/omp";
import {
	BACKUP_FILE_PATTERN,
	BUNDLE_FILE_PATTERN,
	DEFAULT_KEEP,
	readStamp,
	sha256File,
	writeStampAtomic,
} from "./backup";

/** Success stamp next to `last-backup.ok`: `ts=… file=… sha256=… bundle=… bundle_sha256=… ssh=… dir=…`. */
export const OFFSITE_STAMP_FILE = "offsite.ok";
/** The ssh/scp options every remote step runs with: key auth only, so a missing key fails fast instead of prompting. */
const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];
/** Short remote commands (mkdir, ls, sha256sum of one file, mv, rm). */
const STEP_TIMEOUT_MS = 120_000;
/** One scp of the bundle (sessions grow; 512MB default cap). */
const COPY_TIMEOUT_MS = 20 * 60_000;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type OffsiteErrorCode =
	| "not_configured"
	| "no_local_backup"
	| "ssh_failed"
	| "copy_failed"
	| "sha_mismatch"
	| "stamp_failed";

export class OffsiteError extends Error {
	readonly code: OffsiteErrorCode;

	constructor(code: OffsiteErrorCode, detail: string) {
		super(`${code}: ${detail}`);
		this.name = "OffsiteError";
		this.code = code;
	}
}

export interface OffsiteTarget {
	ssh: string;
	remoteDir: string;
	keep?: number;
}

export interface OffsiteOptions {
	homeDir: string;
	target: OffsiteTarget;
	/** Process runner (tests inject a fake; the default is the bot's real runner with the credential-free env). */
	run?: ProcessRunner;
	/** Env of the ssh/scp children (default: this process's, minus Slack/bot credentials). */
	env?: Record<string, string>;
	now?: Date;
}

export interface OffsiteFileResult {
	name: string;
	sha256: string;
	/** `uploaded` this run, or `present` when the remote already held the same bytes. */
	status: "uploaded" | "present";
}

export interface OffsiteResult {
	files: OffsiteFileResult[];
	/** Remote file names removed by the retention pass. */
	removed: string[];
	stamp: string;
}

function newest(names: string[], pattern: RegExp): string | undefined {
	return names
		.filter((name) => pattern.test(name))
		.sort()
		.at(-1);
}

/**
 * Copies the newest local db snapshot and bundle to `<ssh>:<remoteDir>`. Each file goes to `<name>.part`, is hashed
 * on the remote with `sha256sum`, and is renamed to its final name only when that hash equals the local one (the
 * backup stamp's for the stamped file, a fresh hash otherwise). The retention pass then touches only names matching
 * the strict daily patterns. The local `offsite.ok` stamp is written last and atomically, so it never claims a copy
 * that was not verified. Throws `OffsiteError`; a failed run leaves the previous stamp untouched.
 */
export async function runOffsite(options: OffsiteOptions): Promise<OffsiteResult> {
	const { homeDir, target } = options;
	// Validated again here: this runs from the CLI with a config object, and these strings reach a remote shell.
	// Same predicate as config load: a `..` segment is refused, `a..b` is a plain name.
	if (!OFFSITE_SSH.test(target.ssh) || !isOffsiteDir(target.remoteDir)) {
		throw new OffsiteError("not_configured", "invalid ssh or remoteDir");
	}
	const keep = target.keep ?? DEFAULT_KEEP;
	const run = options.run ?? realProcessRunner;
	const env = options.env ?? dispatchEnv(process.env);
	const backupsDir = join(homeDir, "backups");

	let localNames: string[];
	try {
		localNames = readdirSync(backupsDir);
	} catch {
		throw new OffsiteError("no_local_backup", backupsDir);
	}
	const dbName = newest(localNames, BACKUP_FILE_PATTERN);
	if (dbName === undefined) throw new OffsiteError("no_local_backup", `no ompbot-*.db in ${backupsDir}`);
	const bundleName = newest(localNames, BUNDLE_FILE_PATTERN);

	const stamp = readStamp(backupsDir);
	const items = [{ name: dbName, sha256: stamp?.file === dbName ? stamp.sha256 : undefined }];
	if (bundleName !== undefined) {
		items.push({ name: bundleName, sha256: stamp?.bundle === bundleName ? stamp.bundleSha256 : undefined });
	}
	const files = items.map((item) => ({
		name: item.name,
		sha256:
			item.sha256 !== undefined && SHA256_HEX.test(item.sha256) ? item.sha256 : sha256File(join(backupsDir, item.name)),
	}));

	// `~/x` stays unquoted so the remote shell expands it (the charset is safe); scp has no tilde, so its path is
	// the same place relative to the login directory.
	// Repeated slashes collapse first (isOffsiteDir judged the collapsed path), so `~//x` stays relative for scp.
	const dir = target.remoteDir.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
	const scpBase = dir.replace(/^~\//, "");
	const remote = (command: string, timeoutMs = STEP_TIMEOUT_MS) =>
		run(["ssh", ...SSH_OPTIONS, "--", target.ssh, command], { env, timeoutMs });
	const fail = (
		code: OffsiteErrorCode,
		what: string,
		result: { code: number | null; stdout: string; stderr?: string; timedOut: boolean },
	) =>
		new OffsiteError(
			code,
			// ssh/scp write their own connection errors to stderr; stdout carries only the remote command's output.
			`${what} ${result.timedOut ? "timed out" : `exit=${result.code}`} ${(result.stderr?.trim() || result.stdout.trim()).slice(0, 200)}`.trim(),
		);
	/** sha256 of a remote file; `undefined` when it does not exist. */
	const remoteSha = async (path: string): Promise<string | undefined> => {
		const result = await remote(`sha256sum -- ${path}`);
		if (result.timedOut) throw fail("ssh_failed", "sha256sum", result);
		if (result.code !== 0) return undefined;
		const sha = result.stdout.trim().split(/\s+/)[0] ?? "";
		return SHA256_HEX.test(sha) ? sha : undefined;
	};

	const made = await remote(`mkdir -p -m 700 ${dir}`);
	if (made.code !== 0) throw fail("ssh_failed", "mkdir", made);

	const results: OffsiteFileResult[] = [];
	for (const file of files) {
		const final = `${dir}/${file.name}`;
		if ((await remoteSha(final)) === file.sha256) {
			results.push({ ...file, status: "present" });
			continue;
		}
		const part = `${final}.part`;
		const copy = await run(
			[
				"scp",
				"-B",
				"-p",
				"-q",
				...SSH_OPTIONS,
				"--",
				join(backupsDir, file.name),
				`${target.ssh}:${scpBase}/${file.name}.part`,
			],
			{ env, timeoutMs: COPY_TIMEOUT_MS },
		);
		if (copy.code !== 0) {
			await remote(`rm -f -- ${part}`);
			throw fail("copy_failed", `scp ${file.name}`, copy);
		}
		const got = await remoteSha(part);
		if (got !== file.sha256) {
			await remote(`rm -f -- ${part}`);
			throw new OffsiteError("sha_mismatch", `${file.name} local=${file.sha256} remote=${got ?? "unreadable"}`);
		}
		const moved = await remote(`mv -f -- ${part} ${final}`);
		if (moved.code !== 0) throw fail("ssh_failed", `rename ${file.name}`, moved);
		results.push({ ...file, status: "uploaded" });
	}

	// Retention: only strict daily names, newest `keep` per kind, never the files this run just verified.
	const removed: string[] = [];
	const listing = await remote(`ls -1 -- ${dir}`);
	if (listing.code === 0) {
		const names = listing.stdout.split("\n").map((line) => line.trim());
		const guarded = new Set(files.map((file) => file.name));
		const doomed: string[] = [];
		for (const kind of [BACKUP_FILE_PATTERN, BUNDLE_FILE_PATTERN]) {
			const daily = names
				.filter((name) => kind.test(name))
				.sort()
				.reverse();
			for (const name of daily.slice(keep)) if (!guarded.has(name)) doomed.push(name);
		}
		if (doomed.length > 0) {
			const pruned = await remote(`rm -f -- ${doomed.map((name) => `${dir}/${name}`).join(" ")}`);
			if (pruned.code === 0) removed.push(...doomed);
		}
	}

	const [db, bundle] = results;
	const now = options.now ?? new Date();
	let stampPath: string;
	try {
		stampPath = writeStampAtomic(
			backupsDir,
			`ts=${now.toISOString()} file=${db?.name} sha256=${db?.sha256}${
				bundle === undefined ? "" : ` bundle=${bundle.name} bundle_sha256=${bundle.sha256}`
			} ssh=${target.ssh} dir=${target.remoteDir}\n`,
			OFFSITE_STAMP_FILE,
		);
	} catch (error) {
		throw new OffsiteError("stamp_failed", error instanceof Error ? error.message : String(error));
	}
	return { files: results, removed, stamp: stampPath };
}
