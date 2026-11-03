import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

export interface LockInfo {
	pid: number;
	bootId: string;
	startedAt: number;
}

export class LockHeldError extends Error {
	readonly holder: LockInfo;
	constructor(path: string, holder: LockInfo) {
		super(`already_running: lock ${path} is held by pid ${holder.pid}`);
		this.name = "LockHeldError";
		this.holder = holder;
	}
}

/** Kernel boot id: a pid recorded before a reboot must never look alive just because the number was reused. */
export function currentBootId(): string {
	try {
		return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
	} catch {
		return "unknown";
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

function readLock(path: string): LockInfo | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"pid" in parsed &&
			typeof parsed.pid === "number" &&
			"bootId" in parsed &&
			typeof parsed.bootId === "string" &&
			"startedAt" in parsed &&
			typeof parsed.startedAt === "number"
		) {
			return { pid: parsed.pid, bootId: parsed.bootId, startedAt: parsed.startedAt };
		}
		return undefined;
	} catch {
		return undefined;
	}
}

export interface Lock {
	info: LockInfo;
	release(): void;
}

/**
 * Exclusive create of `path` holding `{pid, bootId, startedAt}`. An existing lock is stale (and replaced) when its
 * process is dead, its boot id differs from this boot, or the file is unreadable; otherwise acquisition is refused.
 */
export function acquireLock(path: string, now: number = Date.now()): Lock {
	const info: LockInfo = { pid: process.pid, bootId: currentBootId(), startedAt: now };
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const fd = openSync(path, "wx", 0o600);
			try {
				writeSync(fd, JSON.stringify(info));
			} finally {
				closeSync(fd);
			}
			return {
				info,
				release() {
					const held = readLock(path);
					if (held?.pid === info.pid && held.bootId === info.bootId) unlinkSync(path);
				},
			};
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		}
		const holder = readLock(path);
		if (holder && holder.bootId === info.bootId && isAlive(holder.pid)) throw new LockHeldError(path, holder);
		try {
			unlinkSync(path);
		} catch {
			// another starter removed it first; retry the exclusive create
		}
	}
	throw new Error(`lock_unavailable: ${path}`);
}
