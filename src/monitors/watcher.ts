import { type FSWatcher, watch } from "node:fs";
import { sep } from "node:path";
import type { Logger } from "../log";
import type { MonitorRow } from "./ledger";
import { MonitorSpecError, resolveWatchRoot } from "./spec";

/** Changed paths listed in one event's payload; the rest is summarized as a count. */
export const MAX_WATCH_PATHS = 50;
/** Distinct paths remembered per pending event (dedupes repeated writes); further new paths only raise `overflow`. */
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

interface Entry {
	root: string;
	handle: WatchHandle;
	paths: Set<string>;
	overflow: number;
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
		for (const [id, entry] of this.#entries) {
			const monitor = wanted.get(id);
			if (
				monitor === undefined ||
				entry.failed ||
				monitor.trigger.kind !== "watcher" ||
				monitor.trigger.root !== entry.root
			) {
				this.#close(id);
			}
		}
		for (const id of this.#lastError.keys()) if (!wanted.has(id)) this.#lastError.delete(id);
		for (const [id, monitor] of wanted) {
			if (!this.#entries.has(id) && monitor.trigger.kind === "watcher") this.#start(id, monitor.trigger.root);
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
		const more = entry.paths.size + entry.overflow - lines.length;
		if (more > 0) lines.push(`… and ${more} more`);
		entry.paths.clear();
		entry.overflow = 0;
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

	#fail(id: string, error: unknown): void {
		const text = error instanceof Error ? error.message : String(error);
		if (this.#lastError.get(id) !== text) {
			this.#lastError.set(id, text);
			this.deps.log.error("monitor_watch_error", { monitor: id, error: text });
		}
	}

	#start(id: string, root: string): void {
		try {
			const real = resolveWatchRoot(root, this.deps.watchRoots());
			const entry: Entry = {
				root,
				handle: { close() {} },
				paths: new Set(),
				overflow: 0,
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
					else entry.overflow += 1;
				},
				(error) => {
					entry.failed = true;
					this.#fail(id, error);
				},
			);
			this.#entries.set(id, entry);
			this.#lastError.delete(id);
		} catch (error) {
			this.#fail(id, error instanceof MonitorSpecError ? error.message : error);
		}
	}
}
