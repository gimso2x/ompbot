import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type ApplyLockInfo,
	createApplyLock,
	parseApplyLock,
	type Runner,
	reclaimStaleApplyLock,
	releaseApplyLock,
} from "./apply";

/** The install marker: the deps hash of the package.json/bun.lock that `node_modules` was last installed from. */
export const DEPS_MARKER = join("node_modules", ".ompbot-deps");
/** Per checkout (git dir): installs of the homes sharing it run one at a time. */
export const INSTALL_LOCK_FILE = "ompbot-install.lock";
export const INSTALL_TIMEOUT_S = 300;
/** A live install holder is waited for this long: its install timeout plus a minute. */
export const INSTALL_LOCK_WAIT_MS = (INSTALL_TIMEOUT_S + 60) * 1_000;
const LOCK_POLL_MS = 1_000;

export interface EnsureDepsDeps {
	run: Runner;
	pathEnv: string;
	bun: string;
	/** Apply stamp and pid recorded in the install lock. */
	stamp: string;
	pid: number;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	isAlive: (pid: number) => boolean;
	log: (line: string) => void;
}

export interface EnsureDepsResult {
	ok: boolean;
	detail: string;
	/** false only when the marker matched at the first look (nothing waited for, nothing installed). */
	noted: boolean;
}

/** sha256 of package.json bytes + NUL + bun.lock bytes in the working tree. */
export function depsHash(repoDir: string): string {
	return createHash("sha256")
		.update(readFileSync(join(repoDir, "package.json")))
		.update("\0")
		.update(readFileSync(join(repoDir, "bun.lock")))
		.digest("hex");
}

function readMarker(repoDir: string): string | undefined {
	try {
		return readFileSync(join(repoDir, DEPS_MARKER), "utf8").trim();
	} catch {
		return undefined; // no marker: never installed through ensureDeps (or an install was cut short)
	}
}

/**
 * Installs the checkout's dependencies when `node_modules/.ompbot-deps` does not hold the working tree's deps hash:
 * the old marker goes first (an interrupted install installs again next time), then `bun install --frozen-lockfile`,
 * and only a successful install writes the new marker. The install runs under `<git dir>/ompbot-install.lock`
 * (the apply-lock rules: a live holder is waited for, a dead one taken over) and checks the marker again once held.
 */
export async function ensureDeps(repoDir: string, deps: EnsureDepsDeps): Promise<EnsureDepsResult> {
	const first = depsHash(repoDir);
	if (readMarker(repoDir) === first) return { ok: true, detail: `deps up to date ${first.slice(0, 8)}`, noted: false };

	const gitDir = await deps.run(["git", "-C", repoDir, "rev-parse", "--absolute-git-dir"], {
		env: { PATH: deps.pathEnv },
	});
	if (gitDir.code !== 0)
		return {
			ok: false,
			detail: `git rev-parse --absolute-git-dir rc=${gitDir.code}: ${gitDir.stderr.trim()}`,
			noted: true,
		};
	const lockPath = join(gitDir.stdout.trim(), INSTALL_LOCK_FILE);
	const info: ApplyLockInfo = { pid: deps.pid, stamp: deps.stamp, startedAt: new Date(deps.now()).toISOString() };
	const notes: string[] = [];
	const deadline = deps.now() + INSTALL_LOCK_WAIT_MS;
	let waitedFor: string | undefined;
	for (;;) {
		if (createApplyLock(lockPath, info)) break;
		let seen: string;
		try {
			seen = readFileSync(lockPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // released between our link and read
			throw error;
		}
		const holder = parseApplyLock(seen);
		if (holder === undefined || holder.pid === deps.pid || !deps.isAlive(holder.pid)) {
			const reclaim = reclaimStaleApplyLock(lockPath, seen, deps.pid);
			if (reclaim.outcome === "contention")
				return {
					ok: false,
					detail: `install lock contention (moved-aside lock left at ${reclaim.aside})`,
					noted: true,
				};
			if (reclaim.outcome === "taken") notes.push(`stale install lock ${holder?.stamp ?? "(unreadable)"} taken over`);
			continue;
		}
		if (waitedFor !== holder.stamp)
			deps.log(`apply deps waiting for install lock of apply ${holder.stamp} pid=${holder.pid}`);
		waitedFor = holder.stamp;
		if (deps.now() >= deadline)
			return {
				ok: false,
				detail: `install lock held by apply ${holder.stamp} after ${INSTALL_LOCK_WAIT_MS / 1000}s`,
				noted: true,
			};
		await deps.sleep(LOCK_POLL_MS);
	}
	if (waitedFor !== undefined) notes.push(`waited for install of apply ${waitedFor}`);
	try {
		const hash = depsHash(repoDir);
		if (readMarker(repoDir) === hash) {
			return { ok: true, detail: [...notes, `deps up to date ${hash.slice(0, 8)}`].join("; "), noted: true };
		}
		const marker = join(repoDir, DEPS_MARKER);
		rmSync(marker, { force: true });
		const install = await deps.run(["timeout", String(INSTALL_TIMEOUT_S), deps.bun, "install", "--frozen-lockfile"], {
			cwd: repoDir,
			env: { PATH: deps.pathEnv },
		});
		if (install.code !== 0) {
			const tail = `${install.stdout}\n${install.stderr}`.trim().split("\n").slice(-20).join("\n");
			return {
				ok: false,
				detail: [...notes, `bun install --frozen-lockfile rc=${install.code}:\n${tail}`].join("; "),
				noted: true,
			};
		}
		mkdirSync(join(repoDir, "node_modules"), { recursive: true });
		const tmp = `${marker}.tmp-${deps.pid}-${crypto.randomUUID().slice(0, 8)}`;
		writeFileSync(tmp, `${hash}\n`);
		renameSync(tmp, marker);
		return {
			ok: true,
			detail: [...notes, `bun install --frozen-lockfile ok, deps ${hash.slice(0, 8)}`].join("; "),
			noted: true,
		};
	} finally {
		releaseApplyLock(lockPath, info);
	}
}
