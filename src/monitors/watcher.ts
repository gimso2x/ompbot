import { type FSWatcher, statSync, watch } from "node:fs";
import { sep } from "node:path";
import type { Logger } from "../log";
import type { MonitorRow } from "./ledger";
import { MonitorSpecError, resolveWatchRoot } from "./spec";

/** Changed paths listed in one event's payload; the rest is summarized as a count. */
export const MAX_WATCH_PATHS = 50;
/** Distinct paths remembered per pending event (dedupes repeated writes); further new paths only join `overflow` (still deduped, so the count stays distinct paths). */
const MAX_TRACKED_PATHS = 1000;

/** What a watch hands back; the test seam replaces `fs.watch`. */
export interface WatchHandle {
	close(): void;
}

/** Starts one recursive watch on `root`. `rel` is the changed path relative to root (null when the OS gave none). */
export type WatchStarter = (
	root: string,
	onChange: (rel: string | null) => void,
	onError: (error: Error) => void,
) => WatchHandle;

export const fsWatchStarter: WatchStarter = (root, onChange, onError) => {
	const watcher: FSWatcher = watch(root, { recursive: true }, (_event, name) =>
		onChange(name === null ? null : String(name)),
	);
	watcher.on("error", onError);
	return watcher;
};

/**
 * Which directory `real` is: dev and inode, plus the birth time because a deleted tree's inode is often handed
 * straight to the next `mkdir` of the same name (birth time is 0 where the filesystem does not keep it).
 */
function rootIdentity(real: string): string {
	const stat = statSync(real);
	return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

interface Entry {
	root: string;
	/** `rootIdentity` of the resolved root when the watch started: a deleted or replaced root no longer matches it. */
	identity: string;
	handle: WatchHandle;
	paths: Set<string>;
	overflow: Set<string>;
	lastChangeAt: number;
	/** Bumped when the watch died; the next reconcile starts a fresh one. */
	failed: boolean;
}

/**
 * One recursive watch per enabled watcher monitor, reconciled from ledger rows on every scheduler tick. A watch
 * callback only records the relative path in memory; the scheduler turns settled changes into an event via `take`.
 */
export class WatcherSet {
	readonly #entries = new Map<string, Entry>();
	readonly #lastError = new Map<string, string>();

	constructor(
		private readonly deps: {
			log: Logger;
			clock: { now(): number };
			watchRoots: () => readonly string[] | undefined;
			starter?: WatchStarter | undefined;
			/** Every failed start or dead watch (the ledger's check error streak); a started watch calls `onStarted`. */
			onError?: ((id: string, error: string) => void) | undefined;
			onStarted?: ((id: string) => void) | undefined;
		},
	) {}

	/** Ids that currently have a live watch. */
	get active(): string[] {
		return [...this.#entries.keys()];
	}

	/** Starts, restarts and stops watches so they match `monitors` (all rows; only enabled watchers keep one). */
	reconcile(monitors: readonly MonitorRow[]): void {
		const wanted = new Map<string, MonitorRow>();
		for (const monitor of monitors) {
			if (monitor.enabled && monitor.trigger.kind === "watcher") wanted.set(monitor.id, monitor);
		}
		/** Closed this round because the root died; reopened on the next reconcile, not right away. */
		const deadRoots = new Set<string>();
		for (const [id, entry] of this.#entries) {
			const monitor = wanted.get(id);
			if (
				monitor === undefined ||
				entry.failed ||
				monitor.trigger.kind !== "watcher" ||
				monitor.trigger.root !== entry.root
			) {
				this.#close(id);
				continue;
			}
			// fs.watch emits no error when its root is deleted or replaced, so the root is checked here.
			const dead = this.#rootDeath(entry);
			if (dead !== undefined) {
				this.#fail(id, dead);
				this.#close(id);
				deadRoots.add(id);
			}
		}
		for (const id of this.#lastError.keys()) if (!wanted.has(id)) this.#lastError.delete(id);
		for (const [id, monitor] of wanted) {
			if (!this.#entries.has(id) && !deadRoots.has(id) && monitor.trigger.kind === "watcher") {
				this.#start(id, monitor.trigger.root);
			}
		}
	}

	/**
	 * The settled change text of `id` (and clears it), or undefined while nothing changed or changes are still within
	 * `debounceMs` of the last one.
	 */
	take(id: string, debounceMs: number, now: number): string | undefined {
		const entry = this.#entries.get(id);
		if (entry === undefined || entry.paths.size === 0 || now - entry.lastChangeAt < debounceMs) return undefined;
		const lines = [...entry.paths].slice(0, MAX_WATCH_PATHS);
		const more = entry.paths.size + entry.overflow.size - lines.length;
		if (more > 0) lines.push(`… and ${more} more`);
		entry.paths.clear();
		entry.overflow.clear();
		return lines.join("\n");
	}

	stop(): void {
		for (const id of [...this.#entries.keys()]) this.#close(id);
	}

	#close(id: string): void {
		const entry = this.#entries.get(id);
		this.#entries.delete(id);
		try {
			entry?.handle.close();
		} catch {
			// already closed
		}
	}

	/** Why the watched root is no longer the one the watch started on; `undefined` while it still is. */
	#rootDeath(entry: Entry): string | undefined {
		let identity: string;
		try {
			identity = rootIdentity(resolveWatchRoot(entry.root, this.deps.watchRoots()));
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		return identity === entry.identity ? undefined : `trigger.root was replaced: ${entry.root}`;
	}

	#fail(id: string, error: unknown): void {
		const text = error instanceof Error ? error.message : String(error);
		if (this.#lastError.get(id) !== text) {
			this.#lastError.set(id, text);
			this.deps.log.error("monitor_watch_error", { monitor: id, error: text });
		}
		// The fs error callback has no caller to throw to: a failed record is a log line.
		try {
			this.deps.onError?.(id, text);
		} catch (err) {
			this.deps.log.error("monitor_watch_record_failed", { monitor: id, error: String(err) });
		}
	}

	#start(id: string, root: string): void {
		try {
			const real = resolveWatchRoot(root, this.deps.watchRoots());
			const entry: Entry = {
				root,
				identity: rootIdentity(real),
				handle: { close() {} },
				paths: new Set(),
				overflow: new Set(),
				lastChangeAt: 0,
				failed: false,
			};
			entry.handle = (this.deps.starter ?? fsWatchStarter)(
				real,
				(rel) => {
					const path = rel === null || rel === "" ? "." : rel.split(sep).join("/");
					if (path.split("/").includes(".git")) return;
					entry.lastChangeAt = this.deps.clock.now();
					if (entry.paths.has(path)) return;
					if (entry.paths.size < MAX_TRACKED_PATHS) entry.paths.add(path);
					else entry.overflow.add(path);
				},
				(error) => {
					entry.failed = true;
					this.#fail(id, error);
				},
			);
			this.#entries.set(id, entry);
			this.#lastError.delete(id);
			this.deps.onStarted?.(id);
		} catch (error) {
			this.#fail(id, error instanceof MonitorSpecError ? error.message : error);
		}
	}
}
