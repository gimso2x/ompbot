import { join } from "node:path";
import type { LaneSessionOps } from "../lanes/manager";
import type { Logger } from "../log";
import type { OmpState, TodoPhase } from "../omp/driver";
import { redact } from "../redact";
import { openStore, type Store } from "../store/db";
import type { LiveView } from "./live-turn";
import { type BoardNotice, type DriverFactory, type MailboxDeps, OriginMailbox } from "./mailbox";
import { isThreadOrigin } from "./normalize";
import { chatOriginKey } from "./origin-key";
import type { InboundRecord, MailboxClock, StatusProvider } from "./types";

/**
 * Origin of a Slack DM message: one conversation per DM channel. Top-level messages and thread replies share
 * the key, so `threadTs` is deliberately ignored. Keys are only built here, never parsed afterwards.
 */
export function slackDmOrigin(message: { channelId: string; threadTs?: string }): string {
	return chatOriginKey({ platform: "slack", kind: "dm", conversationId: message.channelId });
}

/** One session directory per origin epoch (`/new` starts a new one, so old epochs can be garbage collected). */
export function sessionDirFor(sessionsRoot: string, originKey: string, epoch: number): string {
	return join(sessionsRoot, encodeURIComponent(originKey), `e${epoch}`);
}

/** The store with the todo 4 redactor wired in: every stored body, text and error is masked. */
export function openBotStore(path: string, clock: MailboxClock, timezone: string): Store {
	return openStore({ path, clock, timezone, redact });
}

export interface OriginRouterDeps {
	store: Store;
	driverFactory: DriverFactory;
	clock: MailboxClock;
	/** Passed to every mailbox: the bot's zone (`config.timezone`); see `MailboxDeps.timezone`. */
	timezone: string;
	statusProvider: StatusProvider;
	/** Passed to every mailbox: the `/usage-ompbot` answer; see `MailboxDeps`. */
	usageProvider?: MailboxDeps["usageProvider"];
	/** Passed to every mailbox: the `!distill` answer; see `MailboxDeps`. */
	distillProvider?: MailboxDeps["distillProvider"];
	/** Passed to every mailbox: whether a turn prompt may carry channel-scoped recall; see `MailboxDeps`. */
	recallEnabled?: MailboxDeps["recallEnabled"];
	/** Passed to every mailbox: whether a child gets ompbot host tools; see `MailboxDeps.hostTools`. */
	hostTools?: MailboxDeps["hostTools"];
	/** Passed to every mailbox: live `costCap` for the per-turn brake; see `MailboxDeps.costCap`. */
	costCap?: MailboxDeps["costCap"];
	/** Passed to every mailbox: the `!budget` answer; see `MailboxDeps.budgetProvider`. */
	budgetProvider?: MailboxDeps["budgetProvider"];
	/** Passed to every mailbox: Slack thread reader for turn context; see `MailboxDeps.threadSource`. */
	threadSource?: MailboxDeps["threadSource"];
	log: Logger;
	sessionsRoot: string;
	/** Config default model (`provider/id`); fallback when a restored session's model no longer exists. */
	defaultModel?: string;
	/** Root of pre-heal session backups; passed to every mailbox (`MailboxDeps.sessionBackupsRoot`). */
	sessionBackupsRoot?: string;
	idleStopMs?: number;
	/** Passed to every mailbox: consecutive failed turns that escalate to the owner; see `MailboxDeps`. */
	escalateAfter?: number;
	onStall?: MailboxDeps["onStall"];
	/** Owner escalation of a stalled turn (DM once per turn); see `MailboxDeps`. */
	onStallEscalate?: MailboxDeps["onStallEscalate"];
	onProgress?: MailboxDeps["onProgress"];
	/** Owner escalation for a run of failed turns (the bot's own "나 망가짐" report); see `MailboxDeps`. */
	onEscalate?: MailboxDeps["onEscalate"];
	/** Owner notice for a provider usage limit seen in a turn's omp retry events; see `MailboxDeps`. */
	onProviderLimit?: MailboxDeps["onProviderLimit"];
	/** Thread notice for a large unexpected prompt cache miss; see `MailboxDeps`. */
	onCacheMiss?: MailboxDeps["onCacheMiss"];
	/** Thread notice for a large conversation resumed on a cold cache; see `MailboxDeps`. */
	onColdCache?: MailboxDeps["onColdCache"];
	onSessionMismatch?: MailboxDeps["onSessionMismatch"];
	/** Thread notice for a turn aborted on a tool repeat loop; see `MailboxDeps`. */
	onStuckLoop?: MailboxDeps["onStuckLoop"];
	/** Owner dialogs a plain message may answer; see `MailboxDeps.dialogs`. */
	dialogs?: MailboxDeps["dialogs"];
	/** Turn snapshots and `!undo`; passed to every mailbox (`MailboxDeps.turnUndo`). */
	turnUndo?: MailboxDeps["turnUndo"];
	/** `!brief` renderer; passed to every mailbox (`MailboxDeps.briefingProvider`). */
	briefingProvider?: MailboxDeps["briefingProvider"];
	/** `!restart` launcher; passed to every mailbox (`MailboxDeps.restartProvider`). */
	restartProvider?: MailboxDeps["restartProvider"];
	/** Whether an origin's work is held (a paused lane); passed per mailbox (`MailboxDeps.isHeld`). */
	isHeld?: (originKey: string) => boolean;
	/** A held origin's driver started working on its own; passed per mailbox (`MailboxDeps.onHeldWork`). */
	onHeldWork?: MailboxDeps["onHeldWork"];
	/** Task-list phases a fresh session of an origin starts with; passed per mailbox (`MailboxDeps.initialTodos`). */
	initialTodos?: (originKey: string) => TodoPhase[] | undefined;
	/** The lane board's new-post line of an origin's next turn prompt; passed per mailbox (`MailboxDeps.boardNotice`). */
	boardNotice?: (originKey: string) => BoardNotice | undefined;
	/** Every turn that ended through the final path; passed to every mailbox (`MailboxDeps.onTurnSettled`). */
	onTurnSettled?: MailboxDeps["onTurnSettled"];
	/** Whether an origin's session is handed to a terminal omp; passed per mailbox (`MailboxDeps.isAttached`). */
	isAttached?: (originKey: string) => boolean;
}

/** Owns one `OriginMailbox` per origin key. */
export class OriginRouter {
	readonly #deps: OriginRouterDeps;
	readonly #mailboxes = new Map<string, OriginMailbox>();
	/** Restart drain (memory only, so a restart always ends it); see `MailboxDeps.isDraining`. */
	draining = false;
	/** Set at shutdown (`stopDispatching`): every mailbox — existing and later-created — stops dispatching. */
	#dispatchStopped = false;

	constructor(deps: OriginRouterDeps) {
		this.#deps = deps;
	}

	mailbox(originKey: string): OriginMailbox {
		let mailbox = this.#mailboxes.get(originKey);
		if (!mailbox) {
			const { sessionsRoot, isHeld, onHeldWork, initialTodos, isAttached, boardNotice, ...rest } = this.#deps;
			mailbox = new OriginMailbox({
				...rest,
				originKey,
				sessionDirFor: (key, epoch) => sessionDirFor(sessionsRoot, key, epoch),
				isDraining: () => this.draining,
				...(isHeld === undefined ? {} : { isHeld: () => isHeld(originKey) }),
				...(onHeldWork === undefined ? {} : { onHeldWork }),
				...(initialTodos === undefined ? {} : { initialTodos: () => initialTodos(originKey) }),
				...(isAttached === undefined ? {} : { isAttached: () => isAttached(originKey) }),
				...(boardNotice === undefined ? {} : { boardNotice: () => boardNotice(originKey) }),
			});
			if (this.#dispatchStopped) mailbox.stopDispatching();
			this.#mailboxes.set(originKey, mailbox);
		}
		return mailbox;
	}

	route(record: InboundRecord): Promise<void> {
		const known = this.#mailboxes.has(record.originKey);
		const mailbox = this.mailbox(record.originKey);
		// One line per thread-session lifetime: the first routed message opens `slack/ch/<C>/t/<rootTs>`.
		if (!known && isThreadOrigin(record.originKey)) {
			this.#deps.log.info("thread_session_started", {
				origin: record.originKey,
				root: record.originKey.slice(record.originKey.lastIndexOf("/") + 1),
			});
		}
		return mailbox.enqueue(record);
	}

	/**
	 * Monitor fires: bump the origin's epoch so its next turn opens a fresh session — only when no turn runs (see
	 * `OriginMailbox.newEpochIfIdle`). Resolves false when the fire must stay in the current session.
	 */
	newEpochIfIdle(originKey: string): Promise<boolean> {
		return this.mailbox(originKey).newEpochIfIdle();
	}

	/** Stops omp children of quiet origins; returns how many stopped. */
	async sweepIdle(): Promise<number> {
		const results = await Promise.all([...this.#mailboxes.values()].map((mailbox) => mailbox.sweepIdle()));
		return results.filter(Boolean).length;
	}

	/** Alerts origins whose running turn has gone silent; returns how many alerted now. */
	sweepStalls(): number {
		return [...this.#mailboxes.values()].filter((mailbox) => mailbox.checkStall()).length;
	}

	/** What the origin's running turn is writing now; null for an origin with no mailbox (never creates one). */
	liveView(originKey: string): LiveView | null {
		return this.#mailboxes.get(originKey)?.liveView() ?? null;
	}

	/** The session file the origin's running child has open; undefined without a mailbox or child (never creates one). */
	openSessionFile(originKey: string): Promise<string | undefined> {
		return this.#mailboxes.get(originKey)?.openSessionFile() ?? Promise.resolve(undefined);
	}

	/** The origin's live child state (`!status` context line); undefined without a mailbox or child (never creates one). */
	driverState(originKey: string): Promise<OmpState | undefined> {
		return this.#mailboxes.get(originKey)?.driverState() ?? Promise.resolve(undefined);
	}

	/** The mailbox calls the terminal hand-over of a lane uses (`LaneManagerDeps.session`). */
	sessionOps(): LaneSessionOps {
		return {
			openFile: (originKey) => this.openSessionFile(originKey),
			whenTurnEnds: (originKey) => this.mailbox(originKey).whenTurnEnds(),
			release: (originKey) => this.mailbox(originKey).close(),
			childRunning: (originKey) => this.#mailboxes.get(originKey)?.state.driverRunning ?? false,
		};
	}

	/** Origins with a running turn. */
	busyTurns(): number {
		return [...this.#mailboxes.values()].filter((mailbox) => mailbox.state.busy).length;
	}

	/** Host tool calls running across every origin. */
	hostToolsRunning(): number {
		return [...this.#mailboxes.values()].reduce((sum, mailbox) => sum + mailbox.hostToolsRunning, 0);
	}

	/**
	 * Shutdown drain mode: no mailbox dispatches pending rows anymore, so the drain below awaits already-running
	 * turns only. A mailbox created later (a lane route racing the drain) inherits the mode.
	 */
	stopDispatching(): void {
		this.#dispatchStopped = true;
		for (const mailbox of this.#mailboxes.values()) mailbox.stopDispatching();
	}

	/** Origins whose mailbox currently has a turn running. */
	busyOrigins(): string[] {
		return [...this.#mailboxes.entries()].filter(([, mailbox]) => mailbox.state.busy).map(([originKey]) => originKey);
	}

	/**
	 * Shutdown drain: wait bounded for every running turn to settle — a turn that finishes in time records its own
	 * answer in the ledger, so the next boot's recovery finds it instead of reporting `interrupted_by_restart`.
	 * Returns the origins still busy when the bound expired (empty when everything settled); reading `state.busy`
	 * from outside the mailboxes' actor chains can never deadlock them.
	 */
	async drainRunning(boundMs: number): Promise<string[]> {
		const deadline = Date.now() + boundMs;
		for (;;) {
			const busy = this.busyOrigins();
			if (busy.length === 0 || Date.now() >= deadline) return busy;
			await new Promise<void>((resolve) => setTimeout(resolve, 50));
		}
	}

	async close(): Promise<void> {
		await Promise.all([...this.#mailboxes.values()].map((mailbox) => mailbox.close()));
	}
}
