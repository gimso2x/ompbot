// The lifecycle of a thread's ⏳ status message and 👀 reaction shared by the Slack and Discord adapters. Teams keeps
// its own (its status line posts only after a long turn, there are no reactions to swap and no delete), so only the
// footer string is shared with it. The state machine — begin, cadenced running updates, the final delete/relabell and
// the reaction swap with its rate-limit retries — lives here; the platform side of each step (post/edit/delete/
// reaction calls, error classes, log fields) is `StatusPlatform` callbacks, which answer `true` when the step hit a
// Retry-After and must be retried by a later tick.
import type { TurnProgress } from "../core/mailbox";
import { parseThreadRef, threadRefOf } from "../core/normalize";
import type { FinalOutcome } from "./text";
import { FINAL_MARKS, formatElapsed, formatFooter, runningStatusText } from "./text";
import type { AdapterClock } from "./types";

/** One message the turn's 👀 sits on (and the final mark lands on): channel + message id. */
export interface StatusTarget {
	channelId: string;
	messageId: string;
}

/** One thread's running status: what the tracker tracks and the platform callbacks read and fill in. */
export interface StatusEntry {
	/** Where the thread's messages (reactions, the status) live: Slack channel, Discord conversation. */
	channel: string;
	root: string;
	/** Set by `create` when the ⏳ message is out (Slack: `channel`; Discord: the thread channel it landed in). */
	statusChannel: string | undefined;
	statusId: string | undefined;
	startedAt: number;
	lastUpdateAt: number;
	/** Messages carrying our 👀 in this thread: message id → channel. */
	reactions: Map<string, string>;
	/** Settles when the 👀 and the status message creation are done (never rejects). */
	setup: Promise<void>;
	/** False for command threads: they get no `⏳` message. */
	showStatus: boolean;
	final: FinalOutcome | undefined;
	/** The turn has emitted no omp event for the stall window; the status shows `STALL_STATUS_TEXT`. */
	stalled: boolean;
	/** The turn's progress summary (`setProgress`), shown under the first status line. */
	progress: TurnProgress | undefined;
	/** How the status message ends: `delete` once the answer carries its footer, `update` to the final label. */
	finalAction: "delete" | "update";
	statusDone: boolean;
	reactionsDone: boolean;
}

export interface StatusPlatform {
	create(entry: StatusEntry, text: string): Promise<void>;
	/**
	 * `true`: rate limited, retried by a later tick. Other errors are logged by the platform and final. `final`:
	 * the label that replaces the finished turn's ⏳ (`status_final_failed`), not a running update.
	 */
	edit(entry: StatusEntry, text: string, final: boolean): Promise<boolean>;
	/** `true`: rate limited, retried by a later tick. A refusal the platform logs turns `finalAction` to `update`. */
	remove(entry: StatusEntry): Promise<boolean>;
	/** Removes the 👀 from `target`; `true` when rate limited and the swap must be retried. */
	removeEyes(target: StatusTarget): Promise<boolean>;
	/** Adds the turn's final mark to `target`; `true` when rate limited. */
	addMark(target: StatusTarget, mark: string): Promise<boolean>;
	/** A registered [TASK] root keeps the task sweep's status reaction; the turn mark would fight it. */
	isTaskRoot?(threadRef: string): boolean | undefined;
}

export class StatusTracker {
	readonly #platform: StatusPlatform;
	readonly #clock: AdapterClock;
	readonly #intervalMs: number;
	readonly #statuses = new Map<string, StatusEntry>();
	/** Entries a newer turn in the same thread displaced while their rate-limited cleanup was still pending. */
	readonly #retiring: Array<{ threadRef: string; entry: StatusEntry }> = [];

	constructor(options: { platform: StatusPlatform; clock: AdapterClock; intervalMs: number }) {
		this.#platform = options.platform;
		this.#clock = options.clock;
		this.#intervalMs = options.intervalMs;
	}

	/**
	 * Registers the thread synchronously (before any await) so a delivery that finishes it while the 👀 / status
	 * message are still in flight finds the entry and waits for `setup`. A previous turn still finishing its cleanup
	 * keeps retrying on its own (tick): its entry retires instead of being lost under the new one.
	 */
	begin(
		threadRef: string,
		input: { channel: string; root: string; reaction: StatusTarget; showStatus: boolean; setup: Promise<void> },
	): Promise<void> {
		const existing = this.#statuses.get(threadRef);
		if (existing !== undefined && existing.final === undefined) {
			existing.reactions.set(input.reaction.messageId, input.reaction.channelId);
			existing.setup = Promise.all([existing.setup, input.setup]).then(() => undefined);
			return existing.setup;
		}
		if (existing !== undefined) this.#retiring.push({ threadRef, entry: existing });
		const now = this.#clock.now();
		const entry: StatusEntry = {
			channel: input.channel,
			root: input.root,
			statusChannel: undefined,
			statusId: undefined,
			startedAt: now,
			lastUpdateAt: now,
			reactions: new Map([[input.reaction.messageId, input.reaction.channelId]]),
			setup: Promise.resolve(),
			showStatus: input.showStatus,
			final: undefined,
			stalled: false,
			progress: undefined,
			finalAction: "update",
			statusDone: false,
			reactionsDone: false,
		};
		this.#statuses.set(threadRef, entry);
		const created = input.showStatus
			? this.#platform.create(entry, `⏳ 작업 중 · ${formatElapsed(0)}`)
			: Promise.resolve();
		entry.setup = Promise.all([input.setup, created]).then(() => undefined);
		return entry.setup;
	}

	/** Called by the daemon on a timer. Updates each running status at most once per interval; finishes pending finals. */
	async tick(): Promise<void> {
		for (const [threadRef, entry] of [...this.#statuses]) {
			if (entry.final !== undefined) await this.#flushFinal(threadRef, entry);
			else if (this.#clock.now() - entry.lastUpdateAt >= this.#intervalMs) await this.#updateRunning(entry);
		}
		for (const { threadRef, entry } of [...this.#retiring]) await this.#flushFinal(threadRef, entry);
	}

	/** The daemon reports a silent (or resumed) turn: the running status text switches at once, outside the cadence. */
	async setStalled(threadRef: string, stalled: boolean): Promise<void> {
		const entry = this.#statuses.get(threadRef);
		if (entry === undefined || entry.final !== undefined) return;
		entry.stalled = stalled;
		await entry.setup;
		if (entry.final === undefined) await this.#updateRunning(entry);
	}

	/**
	 * The daemon reports the turn's progress (tool calls, to-do list, steers, retries). It is stored at once (the next
	 * cadence update shows it); an extra update is coaxed out only when the cadence already allows one.
	 */
	async setProgress(threadRef: string, progress: TurnProgress): Promise<void> {
		const entry = this.#statuses.get(threadRef);
		if (entry === undefined || entry.final !== undefined) return;
		entry.progress = progress;
		await entry.setup;
		if (entry.final === undefined && this.#clock.now() - entry.lastUpdateAt >= this.#intervalMs) {
			await this.#updateRunning(entry);
		}
	}

	/**
	 * Marks the turn finished: the status message is deleted (`delete`: the answer carries the footer) or becomes
	 * ✅/⚠️ (`update`), 👀 is removed, the result mark added. Retried by tick() under a rate limit.
	 */
	async finish(threadRef: string, outcome: FinalOutcome, action: "delete" | "update" = "update"): Promise<void> {
		let entry = this.#statuses.get(threadRef);
		if (entry === undefined) {
			const parsed = parseThreadRef(threadRef);
			if (parsed === undefined) return;
			// After a restart nothing is tracked; the thread root is where the first 👀 lives.
			const now = this.#clock.now();
			entry = {
				channel: parsed.channel,
				root: parsed.threadTs,
				statusChannel: undefined,
				statusId: undefined,
				startedAt: now,
				lastUpdateAt: now,
				reactions: new Map([[parsed.threadTs, parsed.channel]]),
				setup: Promise.resolve(),
				showStatus: false,
				final: undefined,
				stalled: false,
				progress: undefined,
				finalAction: "update",
				statusDone: false,
				reactionsDone: false,
			};
			this.#statuses.set(threadRef, entry);
		}
		entry.final = outcome;
		entry.finalAction = action;
		await this.#flushFinal(threadRef, entry);
	}

	/** `✅ 00:42 · 도구 6회` for a thread whose running status this answer replaces; none without a running status
	 * (monitor, post-restart) or for a command thread, which never showed a `⏳` message. */
	footer(threadRef: string, outcome: "done" | "failed"): string | undefined {
		const entry = this.#statuses.get(threadRef);
		if (entry === undefined || entry.final !== undefined || !entry.showStatus) return undefined;
		return formatFooter(outcome, this.#clock.now() - entry.startedAt, entry.progress?.tools ?? 0);
	}

	/** Whether a running (or finishing) status is tracked for the thread (`finishDeliveryStatus`'s `tracks`). */
	tracks(threadRef: string): boolean {
		return this.#statuses.has(threadRef);
	}

	async #updateRunning(entry: StatusEntry): Promise<void> {
		if (entry.statusId === undefined) return;
		const text = runningStatusText(entry.stalled, this.#clock.now() - entry.startedAt, entry.progress);
		if (!(await this.#platform.edit(entry, text, false))) entry.lastUpdateAt = this.#clock.now();
	}

	async #flushFinal(threadRef: string, entry: StatusEntry): Promise<void> {
		const outcome = entry.final;
		if (outcome === undefined) return;
		await entry.setup;
		if (!entry.statusDone) {
			if (entry.statusId === undefined) entry.statusDone = true;
			else if (entry.finalAction === "delete") {
				// Rate limited: tick() deletes again. Refused: the platform turns it into an update of the final label.
				if (!(await this.#platform.remove(entry)) && entry.finalAction === "delete") entry.statusDone = true;
			}
			if (!entry.statusDone && entry.finalAction === "update") {
				const text = `${FINAL_MARKS[outcome].label} · ${formatElapsed(this.#clock.now() - entry.startedAt)}`;
				if (!(await this.#platform.edit(entry, text, true))) entry.statusDone = true;
			}
		}
		if (!entry.reactionsDone) {
			const mark = FINAL_MARKS[outcome].mark;
			let pending = false;
			for (const [messageId, channelId] of entry.reactions) {
				const target = { channelId, messageId };
				pending = (await this.#platform.removeEyes(target)) || pending;
				if (messageId === entry.root && this.#platform.isTaskRoot?.(threadRefOf(entry.channel, messageId)) === true) {
					continue;
				}
				pending = (await this.#platform.addMark(target, mark)) || pending;
			}
			entry.reactionsDone = !pending;
		}
		if (entry.statusDone && entry.reactionsDone) {
			// A newer turn may already own the key; only our own entry leaves.
			if (this.#statuses.get(threadRef) === entry) this.#statuses.delete(threadRef);
			const retiring = this.#retiring.findIndex((r) => r.entry === entry);
			if (retiring >= 0) this.#retiring.splice(retiring, 1);
		}
	}
}
