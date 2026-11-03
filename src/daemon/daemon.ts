import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { loadConfig, type OmpbotConfig } from "../config";
import type { DriverFactory, ProviderLimitInfo, TurnFailureEscalation } from "../core/mailbox";
import { parseThreadRef, slackOriginChannel, TOP_LEVEL_TS, threadRefOf } from "../core/normalize";
import { OriginRouter, sessionDirFor } from "../core/origin";
import { COMMAND_OP_REF, COMMAND_TEXT, type MailboxClock } from "../core/types";
import { createDispatchAudit, installProcessAudit } from "../dispatch/audit";
import { boardCardLink } from "../dispatch/board";
import {
	herdrAgentPane,
	herdrAgentStatus,
	herdrPromptExisting,
	type ProcessRunner,
	setLocalHerdrBin,
} from "../dispatch/omp";
import { LaneInputError, LaneManager } from "../lanes/manager";
import { isLaneOrigin } from "../lanes/status";
import { buildLaneTools, buildWorkStartTool } from "../lanes/tools";
import {
	buildClosedLaneQuestion,
	classifyClosedLaneMessage,
	type LaneTrigger,
	parseLaneTrigger,
} from "../lanes/trigger";
import type { ClaimEvidence, VerifyResult } from "../lanes/verify";
import type { Logger } from "../log";
import { MONITOR_ORIGIN_PREFIX } from "../monitors/ledger";
import { MonitorScheduler } from "../monitors/scheduler";
import { buildMonitorTools } from "../monitors/tools";
import { WebhookServer } from "../monitors/webhook";
import type { ClaudeApprovalHook } from "../omp/claude-driver";
import type { OmpSessionDriver } from "../omp/driver";
import { readConfigText, recordLastGoodConfig } from "../ops/apply";
import { createFreezeProbe, type FreezeState } from "../ops/freeze";
import { collectGates, type GateState } from "../ops/gates";
import { pruneMediaFiles } from "../ops/media";
import { allSessionFiles, conversationSessionFiles, renderUsage, summarizeSessionFiles } from "../ops/usage";
import { redact } from "../redact";
import {
	backupSkillRevision,
	readSessionDigest,
	renderSkillFile,
	runSkillReview,
	SKILL_REVIEW_ORIGIN,
	savePendingProposals,
	skillDirOf,
} from "../review/skills";
import { ApprovalBroker } from "../safety/approval";
import { buildHostTools, type HostToolDef } from "../safety/host-tools";
import { type CoreSink, type DeliverySource, SlackAdapter } from "../slack/adapter";
import { type BackfillDeps, BackfillRunner, type ChannelTarget, channelCursorKey } from "../slack/backfill";
import type { SlackTransport } from "../slack/transport";
import { type DeliveryRow, type InboundRow, LOG_COPY_SUFFIX, Store } from "../store/db";
import { evaluateTask } from "../tasks/evaluate";
import { resolveTaskHost } from "../tasks/host";
import { TASK_SWEEP_MS, TaskSweeper } from "../tasks/sweeper";
import type { CrashPoint } from "./crash";
import { DEFAULT_SWEEP_MS, EVENT_LOOP_WARN_MS, SweepHeartbeatWriter } from "./heartbeat";
import { type IpcServer, startIpcServer } from "./ipc";
import {
	formatGateClosedNotice,
	formatGateOpenNotice,
	formatPendingDispatchNotice,
	formatProviderLimitNotice,
	formatStallNotice,
	formatTurnEscalationNotice,
} from "./notices";
import { NamespacedDriver } from "./opref";
import { recoverDispatched } from "./recovery";
import { planReload, type ReloadResult } from "./reload";
import {
	pickRestartThreads,
	RESTART_NOTICE_ACTIVE_MS,
	RESTART_NOTICE_MAX,
	RESTART_NOTICE_STALE_MS,
	RESTART_NOTICE_TEXT,
	takeRestartMarker,
	writeRestartMarker,
} from "./restart-notice";
import {
	buildStatus,
	type DrainCounts,
	frozenField,
	openGateSummary,
	renderStatusText,
	type StatusReport,
} from "./status";

const MEDIA_SWEEP_INTERVAL_MS = 60 * 60_000;
/** Gate sweep cadence of the self-diagnosis loop (0 disables it). */
export const DEFAULT_GATE_SWEEP_MS = 5 * 60_000;
/**
 * Consecutive closed sweeps after an alerted gate's recovery notice before its incident is resolved (15 minutes at
 * the default sweep), so a recurrence after that alerts again. A shorter flap keeps the 24h suppression. Known gap:
 * restarting before the third closed sweep resolves the incident at boot instead, so a flap spanning a restart can
 * re-alert inside 24h — rare, and one extra notice.
 */
export const GATE_RESOLVE_CLOSED_SWEEPS = 3;
/** Owner DM turns between background skill reviews (0 in config disables them). */
export const DEFAULT_SKILL_REVIEW_TURNS = 10;
/**
 * How long stop() waits for running turns to settle before stopping the omp children: a turn that finishes in
 * time records its own answer, so the restart's recovery finds it instead of reporting `interrupted_by_restart`.
 * Budget note: the waits before the drain (adapter stop, pump, monitors idle) are unbounded and the drain itself
 * is 20s. The packaged unit (packaging/ompbot.service) sets TimeoutStopSec=90 with KillMode=mixed: only the main
 * process gets SIGTERM, the daemon stops its omp children itself, and leftover processes get
 * SIGKILL as soon as the main process exits, or together with it once TimeoutStopSec expires. Check a deployed unit with `systemctl --user show ompbot -p TimeoutStopUSec -p KillMode`.
 */
export const STOP_DRAIN_MS = 20_000;

/**
 * Age of a pending inbound row that makes the sweep re-run its origin's `resumePending` — the same number is the
 * per-origin retry interval, so a stranded row is re-drained about once a minute until it moves; 0 disables the
 * retry (a test-only slim, not wired to any production config — the daemon always keeps the default).
 */
export const PENDING_RETRY_MS = 60_000;
/** Consecutive failed sweep retries before the owner is told once (24h repeat suppression via the incident machine). */
export const PENDING_ALERT_AFTER = 3;

/**
 * Gates that close because their evidence window elapsed (`turns_failing` 1h, `monitors_failed` 24h), not because
 * the problem was fixed: the bot may still be broken, so their close is bookkeeping only — never a recovery DM.
 */
const WINDOW_GATES = new Set(["turns_failing", "monitors_failed"]);

export interface DaemonOptions {
	config: OmpbotConfig;
	/**
	 * The config.json text `loadConfig` validated for this boot (read right before it; `undefined` = unreadable). Only
	 * this text can become last-good at ready. Absent (tests) → read when `start()` begins.
	 */
	bootConfigText?: string | undefined;
	transport: SlackTransport;
	/** Builds the raw driver for (origin, sessionDir); the daemon namespaces its opRefs. */
	driverFactory: DriverFactory;
	log: Logger;
	ompVersion: string;
	/** Id of this daemon boot (also written to the lock file). */
	bootId: string;
	clock?: MailboxClock;
	crash?: (point: CrashPoint) => void;
	sweepMs?: number;
	/**
	 * Gate sweep cadence of the self-diagnosis loop (default 5 minutes); 0 disables gate reporting — a test-only
	 * slim, not wired to any production config or env (the daemon always keeps the default).
	 */
	gateSweepMs?: number;
	/** [TASK] sweep cadence (default 5 minutes); 0 disables it (tests call `sweepTasks()` directly). */
	taskSweepMs?: number;
	/**
	 * Sweep retry cadence for stranded pending rows (default {@link PENDING_RETRY_MS}); a pending row older than
	 * this gets its origin's `resumePending` re-run when the origin is idle; 0 disables it.
	 */
	pendingRetryMs?: number;
	/** Approval buttons unanswered for this long count as denied (default 30 minutes). */
	approvalTimeoutMs?: number;
	/** Concurrent work lanes (default 4). */
	maxLanes?: number;
	/**
	 * How long stop() waits for running turns to settle before stopping the omp children (default
	 * {@link STOP_DRAIN_MS}); 0 stops the children immediately.
	 */
	stopDrainMs?: number;
	/** Test seam for done-claim verification; default checks the real git repository. */
	verifyClaim?: (evidence: ClaimEvidence, cwd: string) => Promise<VerifyResult>;
	/** Test seam for the [TASK] sweep's herdr calls (remind, agent status, board pane); default runs the real herdr. */
	herdrRun?: ProcessRunner;
}

export interface InjectRequest {
	origin: string;
	asOwner: boolean;
	text: string;
	quoted?: string | undefined;
	/** Thread root ts: the marker and the owner message become replies in that thread (exercises a thread reply). */
	thread?: string | undefined;
}

export interface InjectResult {
	nonce: string;
	threadRef: string;
}

/** Slack escapes only &, < and > in text; the adapter unescapes, so injected text is escaped to survive the round trip. */
const escapeSlack = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Owner DM (`slack/dm/D…`) or a channel the bot was invited to (`slack/ch/C…`). */
const SLACK_ORIGIN = /^slack\/(dm|ch)\/([A-Z0-9]+)$/;

/** Sweep-retry state of one origin with stranded pending rows (see `#sweepPendingDispatch`). */
interface PendingRetryState {
	/** Clock time of the last retry attempt (the per-origin cadence gate). */
	at: number;
	/** Platform message id of the oldest stale pending row: progress is measured on it leaving pending. */
	oldestId: string;
	/** Failed retries in a row; progress clears the whole state. */
	failures: number;
	/** Last drain error text (the alert incident's sign); empty while no retry has rejected. */
	sign: string;
}

/** The ledger with the crash hooks and a delivery nudge wired into the state changes that matter. */
class DaemonStore extends Store {
	constructor(
		path: string,
		clock: MailboxClock,
		private readonly crash: (point: CrashPoint) => void,
		private readonly nudge: () => void,
		log: Logger,
		ownerSlackUserId: string,
		logChannel: string | undefined,
	) {
		super({
			path,
			clock,
			redact,
			ownerSlackUserId,
			logChannel,
			hooks: {
				afterInboundAnswered: () => crash("after_final_before_answered"),
				onDeliveryState: ({ deliveryId, from, to }) => log.info("delivery_state", { id: deliveryId, from, to }),
			},
		});
	}

	override markDispatched(...args: Parameters<Store["markDispatched"]>): InboundRow {
		const row = super.markDispatched(...args);
		// Only a real prompt/steer counts; command and failure bookkeeping uses synthetic op refs.
		if (!COMMAND_OP_REF.test(args[1].opRef)) this.crash("after_dispatch");
		return row;
	}

	override recordAnswer(...args: Parameters<Store["recordAnswer"]>): DeliveryRow[] {
		const rows = super.recordAnswer(...args);
		// A completed real turn ends the origin's failure run (chat commands and monitor events are not turn
		// successes), so the next run of failures alerts as a fresh incident.
		if (!COMMAND_OP_REF.test(args[0].opRef) && !args[0].originKey.startsWith(MONITOR_ORIGIN_PREFIX)) {
			this.resolveAlertIncidents(`turns:${args[0].originKey}`);
		}
		this.crash("after_answered");
		this.nudge();
		return rows;
	}

	override recordTurnFailure(...args: Parameters<Store["recordTurnFailure"]>): DeliveryRow | undefined {
		const row = super.recordTurnFailure(...args);
		if (row) this.nudge();
		return row;
	}
}

/** Wires store, origin router, Slack adapter, unix socket and timers; owns recovery on start and graceful stop. */
export class Daemon {
	readonly #options: DaemonOptions;
	readonly #clock: MailboxClock;
	readonly #log: Logger;
	readonly #drivers = new Map<string, NamespacedDriver>();
	/** Unique per Daemon instance; `bootId` is the kernel boot id and repeats across daemon restarts. */
	readonly #incarnation = randomUUID().slice(0, 8);
	#driverCount = 0;
	#store: DaemonStore | undefined;
	#router: OriginRouter | undefined;
	#monitors: MonitorScheduler | undefined;
	#webhook: WebhookServer | undefined;
	#adapter: SlackAdapter | undefined;
	#ipc: IpcServer | undefined;
	#timer: NodeJS.Timeout | undefined;
	#lastMediaSweep = 0;
	/** Gate states of the previous gate sweep (closed→open transitions and per-open "did we alert" bookkeeping). */
	readonly #gateStates = new Map<
		string,
		{ state: GateState; alerted: boolean; closedSweeps: number; pendingResolve: boolean }
	>();
	#lastGateSweepAt = 0;
	#taskSweeper: TaskSweeper | undefined;
	#lastTaskSweepAt = 0;
	#taskSweeping = false;
	/** Sweep-retry state per origin with stranded pending rows; progress deletes the entry. */
	readonly #pendingRetries = new Map<string, PendingRetryState>();
	#reviewing = false;
	readonly #reviewedTurns = new Map<string, number>();
	#pumping: Promise<void> = Promise.resolve();
	#stopped = false;
	/** The in-flight shutdown; a re-entering stop() awaits it instead of returning immediately. */
	#stopPromise: Promise<void> | undefined;
	#heartbeat: SweepHeartbeatWriter | undefined;
	/** `<home>/FROZEN` re-read within seconds; autonomous paths (dispatch, monitors, lanes, task reminders) consult it. */
	readonly #frozen: () => FreezeState | undefined;
	#broker: ApprovalBroker | undefined;
	#lanes: LaneManager | undefined;

	constructor(options: DaemonOptions) {
		this.#options = options;
		this.#clock = options.clock ?? { now: () => Date.now() };
		this.#log = options.log;
		this.#frozen = createFreezeProbe(options.config.homeDir);
	}

	/** Host tools for the omp child of `originKey`: file upload, owner approval, and the lane tools of its kind. */
	hostToolsFor(originKey: string): HostToolDef[] {
		const { config, transport } = this.#options;
		const lane = isLaneOrigin(originKey) ? this.#store?.getLaneByOrigin(originKey) : undefined;
		const channel = lane ? parseThreadRef(lane.threadRef)?.channel : slackOriginChannel(originKey);
		const base = buildHostTools({
			originKey,
			transport,
			broker: this.#approval,
			log: this.#log,
			homeDir: config.homeDir,
			workspaceDir: config.workspaceDir,
			...(slackOriginChannel(originKey) !== undefined ? { ompExecutable: config.ompExecutable } : {}),
			...(channel === undefined ? {} : { channel }),
			...(config.dispatchHosts === undefined ? {} : { dispatchHosts: config.dispatchHosts }),
			...(config.herdrBoard === undefined ? {} : { herdrBoard: config.herdrBoard }),
			...(config.herdr === undefined ? {} : { herdr: config.herdr }),
			frozen: this.#frozen,
			...(this.#store === undefined
				? {}
				: {
						tasks: {
							ledger: this.#store.tasks,
							threadRef: () =>
								this.#router?.mailbox(originKey).state.threadRef ?? this.#store?.latestInboundThread(originKey),
							rootText: (threadRef: string) => this.#store?.getInbound(threadRef)?.textRef,
							transport,
							now: () => this.#clock.now(),
						},
					}),
			// Resolved when the tool runs: the upload thread follows the origin's current conversation, not driver start.
			threadTs: () => this.#uploadThreadTs(originKey, lane?.threadRef),
		});
		const lanes = this.#lanes;
		const store = this.#store;
		const monitorTools = store
			? buildMonitorTools({
					originKey,
					ledger: store.monitors,
					scriptsRoot: join(config.homeDir, "scripts"),
					watcherRoots: config.watcherRoots,
					workspaceDir: config.workspaceDir,
					webhook: config.webhook,
					log: this.#log,
				})
			: [];
		const tools = !lanes
			? [...base, ...monitorTools]
			: lane
				? [...base, ...buildLaneTools(lanes, originKey)]
				: channel === undefined
					? base
					: [...base, buildWorkStartTool(lanes, channel), ...monitorTools];
		// Each call runs inside the origin's mailbox: no stall alert while the child waits on the host (an approval
		// click can take minutes), and `drain` counts it as unfinished work.
		return tools.map((tool) => ({
			...tool,
			execute: (params, context) => {
				const mailbox = this.#router?.mailbox(originKey);
				return mailbox ? mailbox.trackHostTool(() => tool.execute(params, context)) : tool.execute(params, context);
			},
		}));
	}

	/**
	 * Owner approval bridge for the claude driver's dangerous-Bash asks: a Slack approval card on the
	 * origin's channel. Undefined when the origin has no channel (or the daemon is not started) — the
	 * driver then denies those commands outright.
	 */
	requestApprovalFor(originKey: string): ClaudeApprovalHook | undefined {
		const broker = this.#broker;
		if (broker === undefined) return undefined;
		const lane = isLaneOrigin(originKey) ? this.#store?.getLaneByOrigin(originKey) : undefined;
		const channel = lane ? parseThreadRef(lane.threadRef)?.channel : slackOriginChannel(originKey);
		if (channel === undefined) return undefined;
		return (request) => {
			const ask = () =>
				broker.ask(channel, request.description ?? request.command, {
					detail: { action: request.command },
					origin: { originKey, channel },
				});
			// Like host tools: the click can take minutes, so stall alerts rest and `drain` counts the wait.
			const mailbox = this.#router?.mailbox(originKey);
			return mailbox ? mailbox.trackHostTool(ask) : ask();
		};
	}

	/** Working directory of the omp child: the project of a work lane, the bot workspace otherwise. */
	cwdFor(originKey: string): string {
		return (
			(isLaneOrigin(originKey) ? this.#store?.getLaneByOrigin(originKey)?.cwd : undefined) ??
			this.#options.config.workspaceDir
		);
	}

	/**
	 * Where an uploaded file lands: the lane's own thread, else the thread of the origin's running turn (the newest
	 * inbound may already be a steered message of another thread), else the origin's newest inbound thread. Undefined →
	 * the channel's main view (the previous behaviour).
	 */
	#uploadThreadTs(originKey: string, laneThreadRef: string | undefined): string | undefined {
		const turnRef = this.#router?.mailbox(originKey).state.threadRef;
		const ref = laneThreadRef ?? turnRef ?? this.#store?.latestInboundThread(originKey);
		const parsed = ref === undefined ? undefined : parseThreadRef(ref);
		return parsed !== undefined && parsed.threadTs !== TOP_LEVEL_TS ? parsed.threadTs : undefined;
	}

	get socketPath(): string {
		return join(this.#options.config.homeDir, "ompbot.sock");
	}

	get store(): Store {
		if (!this.#store) throw new Error("daemon not started");
		return this.#store;
	}

	get #approval(): ApprovalBroker {
		if (this.#broker === undefined) throw new Error("daemon not started");
		return this.#broker;
	}

	/** Raw factory output wrapped so opRefs are unique across driver instances (see `NamespacedDriver`). */
	#makeDriver(originKey: string, sessionDir: string): OmpSessionDriver {
		this.#driverCount += 1;
		const driver = new NamespacedDriver(
			this.#options.driverFactory(originKey, sessionDir),
			`${this.#incarnation}-${this.#driverCount}`,
		);
		this.#drivers.set(originKey, driver);
		return driver;
	}

	async start(): Promise<void> {
		const config = this.#options.config;
		// The text this boot runs on: recorded as last-good at ready only if nobody edited the file meanwhile.
		const bootConfigText =
			"bootConfigText" in this.#options ? this.#options.bootConfigText : readConfigText(config.homeDir);
		const log = this.#log;
		const crash = this.#options.crash ?? (() => undefined);
		this.#heartbeat = new SweepHeartbeatWriter(config.homeDir);
		installProcessAudit(createDispatchAudit({ homeDir: config.homeDir, log, now: () => this.#clock.now() }));
		const store = new DaemonStore(
			join(config.homeDir, "ompbot.db"),
			this.#clock,
			crash,
			() => this.#nudgePump(),
			log,
			config.ownerSlackUserId,
			config.logChannel,
		);
		this.#store = store;
		this.#broker = new ApprovalBroker({
			transport: this.#options.transport,
			ownerUserId: config.ownerSlackUserId,
			escalationChannel: config.escalationChannel,
			log,
			store,
			clock: this.#clock,
			...(this.#options.approvalTimeoutMs === undefined ? {} : { timeoutMs: this.#options.approvalTimeoutMs }),
		});
		const requeued = store.requeueAmbiguous();
		log.info("daemon_start", {
			boot: this.#options.bootId,
			pid: process.pid,
			omp_version: this.#options.ompVersion,
			recovered_inflight: store.recoveredInflight,
			requeued_ambiguous: requeued,
		});

		// Rule (2): settle dispatched rows of the dead process before any new child is started.
		const recovered = await recoverDispatched({
			store,
			log,
			driverFactory: (origin, dir) => this.#makeDriver(origin, dir),
		});
		log.info("recovery_done", { answered: recovered.answered, interrupted: recovered.interrupted });

		const sessionsRoot = join(config.homeDir, "sessions");
		mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 });
		this.#router = new OriginRouter({
			store,
			clock: this.#clock,
			log,
			sessionsRoot,
			sessionBackupsRoot: join(config.homeDir, "session-backups"),
			statusProvider: () => renderStatusText(this.status()),
			usageProvider: async (originKey) => {
				if (this.#options.config.agent === "claude") return "claude 세션은 집계하지 않습니다";
				const sessionDir = store.getOrigin(originKey)?.sessionDir ?? sessionDirFor(sessionsRoot, originKey, 1);
				const [conversation, overall] = await Promise.all([
					summarizeSessionFiles(conversationSessionFiles(dirname(sessionDir))),
					summarizeSessionFiles(allSessionFiles(sessionsRoot)),
				]);
				return renderUsage(conversation, overall);
			},
			// Read on every turn: a reload replaces this.#options.config, a captured local config would not follow it.
			recallEnabled: () => this.#options.config.recallEnabled !== false,
			idleStopMs: config.idleTimeoutMinutes === undefined ? undefined : config.idleTimeoutMinutes * 60_000,
			...(config.model === undefined ? {} : { defaultModel: config.model }),
			onStall: (info) => void this.#adapter?.setStalled(info.threadRef, info.stalled),
			onActivity: (info) => void this.#adapter?.setActivity(info.threadRef, redact(info.activity)),
			onEscalate: (info) => this.#escalateTurnFailures(info),
			onProviderLimit: (info) => this.#notifyProviderLimit(info),
			onStallEscalate: (info) => {
				const target = this.#store;
				if (target === undefined) return;
				void this.#adapter?.postNotice(target.ownerChannel(), formatStallNotice(info));
			},
			driverFactory: (origin, dir) => this.#makeDriver(origin, dir),
		});
		this.#lanes = new LaneManager({
			store,
			transport: this.#options.transport,
			clock: this.#clock,
			log,
			sessionsRoot,
			route: (record) => this.#router?.route(record) ?? Promise.resolve(),
			stopWhenIdle: (originKey) => this.#router?.mailbox(originKey).stopWhenIdle() ?? Promise.resolve(),
			sessionDirFor: (originKey) => sessionDirFor(sessionsRoot, originKey, 1),
			frozen: this.#frozen,
			approvals: { request: (channel, summary) => this.#approval.request(channel, summary) },
			...(this.#options.maxLanes === undefined ? {} : { maxLanes: this.#options.maxLanes }),
			...(this.#options.verifyClaim === undefined ? {} : { verify: this.#options.verifyClaim }),
		});
		this.#monitors = new MonitorScheduler({
			store,
			router: this.#router,
			clock: this.#clock,
			log,
			scriptsRoot: join(config.homeDir, "scripts"),
			workspaceDir: config.workspaceDir,
			watcherRoots: config.watcherRoots,
			frozen: this.#frozen,
		});
		this.#monitors.start();
		if (config.webhook !== undefined) {
			// A port that cannot be bound is logged (`webhook_bind_failed`) and shown by `ompbot doctor`; it never stops the bot.
			this.#webhook = new WebhookServer({
				ledger: store.monitors,
				log,
				clock: this.#clock,
				config: config.webhook,
				frozen: this.#frozen,
				// A restart drain fires no monitor: the admitted event waits in the ledger for the next process.
				onFired: () => {
					if (this.#router?.draining !== true) this.#monitors?.kick();
				},
			});
			this.#webhook.start();
		}

		const core: CoreSink = {
			onInbound: (message) => {
				// A message in a work lane's thread belongs to that lane's origin, not to the DM conversation.
				const lane = store.getLaneByThread(message.threadRef);
				const originKey = lane?.originKey ?? message.originKey;
				store.ensureOrigin(originKey, lane?.sessionDir ?? sessionDirFor(sessionsRoot, originKey, 1));
				// A closed lane stays closed for anything but `!reopen`: a question (or a `!followup` payload) reaches its
				// session behind the answer-only notice; control commands stay as typed — the mailbox reads the recorded text.
				const question = lane?.status === "closed" && classifyClosedLaneMessage(message.text) === "question";
				const { inserted, row } = store.recordInbound({
					originKey,
					platformMessageId: message.platformMessageId,
					textRef: question ? buildClosedLaneQuestion(message.text) : message.text,
					threadRef: message.threadRef,
				});
				if (!inserted) return { duplicate: true };
				if (lane) {
					this.#lanes?.onOwnerMessage(lane, message.text);
				} else {
					const trigger = parseLaneTrigger(message.text);
					if (trigger) {
						void this.#startLane(row, trigger);
						return {};
					}
				}
				if (this.#router?.draining === true) {
					// Restart drain: the row stays pending for the next process (or the cancel) to dispatch.
					log.info("drain_deferred", { origin: originKey, id: row.platformMessageId });
					return {};
				}
				// Recorded durably first; dispatch (which may start omp) must not delay the 👀 acknowledgement.
				this.#dispatchPending(originKey);
				return {};
			},
			onCommand: ({ command, arg, originKey, channel }) => {
				if (command === "status") return renderStatusText(this.status());
				// A slash command leaves no Slack message to thread under, so it is recorded as an owner message at the
				// top level of the conversation it was typed in: the answer lands right there as the only trace (empty
				// ack — no placeholder root post, no "see the thread" redirect).
				core.onInbound({
					platformMessageId: `slash:${channel}:${randomBytes(6).toString("hex")}`,
					originKey,
					ownerVerified: true,
					text: arg === "" ? COMMAND_TEXT[command] : `${COMMAND_TEXT[command]} ${arg}`,
					threadRef: threadRefOf(channel, TOP_LEVEL_TS),
				});
				return undefined;
			},
			knowsThread: (threadRef) => store.getLaneByThread(threadRef) !== undefined || store.hasInboundThread(threadRef),
			isThreadMuted: (threadRef) => store.isThreadMuted(threadRef),
			setThreadMute: (threadRef, muted) => store.setThreadMute(threadRef, muted),
			// Mute commands never become inbound rows, so handled ones are remembered in the ledger's KV store
			// (namespaced like the backfill cursors) — a backfill replay of the same event is a duplicate,
			// not a re-toggle and a second 🤫/🔊 notice.
			seenMuteCommand: (platformMessageId) => store.getCursor(`mute:${platformMessageId}`) !== undefined,
			rememberMuteCommand: (platformMessageId) => store.setCursor(`mute:${platformMessageId}`, "1"),
			// The thread of an approval card is `<card channel>:<card ts>` — the ledger's approval id.
			onCardReply: ({ threadRef, platformMessageId, text }) => {
				const ts = parseThreadRef(platformMessageId)?.threadTs ?? platformMessageId;
				return this.#approval.handleCardReply({ approvalId: threadRef, ts, text });
			},
			onAction: ({ actionId, userId }) => {
				if (this.#approval.handleAction({ actionId, userId })) return;
				log.info("action_ignored", { action: actionId, user: userId });
			},
		};
		const deliveries: DeliverySource = {
			claimDue: () =>
				store.claimDue().map((row) => ({
					deliveryId: row.deliveryId,
					originKey: row.originKey,
					threadRef: row.threadRef,
					body: row.body,
					redelivered: row.redelivered,
					finishThreadRefs: store.threadsOfOp(row.originKey, row.opRef),
					// Only a `queue drop` re-links its target to the command op: those threads end 🚫 취소됨, a
					// `/new` keeps finishing its casualties ✅ 완료 as before.
					cancelThreadRefs: row.opRef.startsWith("queue:")
						? store.discardedThreadsOfOp(row.originKey, row.opRef)
						: undefined,
					// A lane's own reports (no owner message behind them) must not stamp ✅ on its thread root.
					finishUntracked:
						!isLaneOrigin(row.originKey) &&
						!row.originKey.startsWith(MONITOR_ORIGIN_PREFIX) &&
						!row.opRef.endsWith(LOG_COPY_SUFFIX),
				})),
			confirm: (deliveryId) => {
				crash("after_post_before_confirm");
				store.confirmDelivery(deliveryId);
			},
			fail: (deliveryId, error, outcome) => {
				if (outcome === "definitive") store.failDelivery(deliveryId, error);
				else store.markAmbiguous(deliveryId, error);
			},
		};
		// Missed-message backfill: once at startup, then on every socket (re)connect (upstream adapter semantics).
		// The adapter's live ingest failures trigger it too: they never advance the watermark, so without this a
		// transiently failed message would sit unanswered until the next reconnect. `buildDeps` is lazy per pass,
		// so creating the runner before the adapter exists is fine.
		const backfill = new BackfillRunner(() => this.#backfillDeps());
		this.#adapter = new SlackAdapter({
			transport: this.#options.transport,
			core,
			deliveries,
			ownerUserId: config.ownerSlackUserId,
			clock: this.#clock,
			log,
			mediaRoot: join(config.homeDir, "media"),
			...(config.mentionFreeChannels === undefined ? {} : { mentionFreeChannels: config.mentionFreeChannels }),
			...(config.logChannel === undefined ? {} : { logChannel: config.logChannel }),
			isTaskRoot: (threadRef) => store.tasks.isTaskRoot(threadRef),
			onInboundFailure: () => backfill.trigger(),
			...(config.dispatchHosts === undefined ? {} : { dispatchHosts: config.dispatchHosts }),
		});
		await this.#adapter.start();
		this.#announceMarker("back");

		// A waiting click cannot outlive the process: expire every pending card and say so on them.
		void this.#broker.expireStale(false).catch((error) => log.warn("approval_expire_failed", { error: String(error) }));

		this.#options.transport.onReady = () => backfill.trigger();
		backfill.trigger();

		const herdrRun = this.#options.herdrRun;
		setLocalHerdrBin(config.herdr?.bin);
		if (config.herdr === undefined) {
			// herdr off: no sweeper, so [TASK] rows are never read or reminded. Say so once and leave the rows alone.
			const orphaned = store.tasks.listActive().length;
			if (orphaned > 0) log.warn("tasks_orphaned", { count: orphaned });
		} else {
			this.#taskSweeper = new TaskSweeper({
				ledger: store.tasks,
				// dispatchHosts is a reloadable field: read the live config, not the boot snapshot.
				frozen: this.#frozen,
				evaluate: (row) => evaluateTask(row, resolveTaskHost(row.host, this.#options.config.dispatchHosts)),
				remind: (row, text) => {
					const entry = row.host === null ? undefined : this.#options.config.dispatchHosts?.[row.host];
					return herdrPromptExisting(row.agent, text, {
						cwd: config.workspaceDir,
						...(entry === undefined ? {} : { sshTarget: entry.ssh }),
						...(entry?.herdrBin === undefined ? {} : { herdrBin: entry.herdrBin }),
						...(herdrRun === undefined ? {} : { run: herdrRun }),
					});
				},
				agentStatus: (row) => {
					const entry = row.host === null ? undefined : this.#options.config.dispatchHosts?.[row.host];
					return herdrAgentStatus(row.agent, {
						cwd: config.workspaceDir,
						...(entry === undefined ? {} : { sshTarget: entry.ssh }),
						...(entry?.herdrBin === undefined ? {} : { herdrBin: entry.herdrBin }),
						...(herdrRun === undefined ? {} : { run: herdrRun }),
					});
				},
				// herdrBoard is live too: a board added by `ompbot reload` links the next notice.
				boardLink: async (row) => {
					const board = this.#options.config.herdrBoard;
					if (board === undefined) return undefined;
					const entry = row.host === null ? undefined : this.#options.config.dispatchHosts?.[row.host];
					const pane = await herdrAgentPane(row.agent, {
						cwd: config.workspaceDir,
						...(entry === undefined ? {} : { sshTarget: entry.ssh }),
						...(entry?.herdrBin === undefined ? {} : { herdrBin: entry.herdrBin }),
						...(herdrRun === undefined ? {} : { run: herdrRun }),
					});
					return boardCardLink(board, row.host, pane, {
						onError: (error) => log.warn("task_board_link_failed", { task: row.taskId, error }),
					});
				},
				transport: this.#options.transport,
				ownerUserId: config.ownerSlackUserId,
				now: () => this.#clock.now(),
				log,
			});
		}
		this.#ipc = startIpcServer(this.socketPath, (request) => this.#handleIpc(request));

		// Rule (1): rows still pending in the ledger are dispatched again.
		for (const originKey of new Set(store.listInbound({ state: "pending" }).map((row) => row.originKey))) {
			this.#dispatchPending(originKey);
		}
		this.#timer = setInterval(() => void this.sweep(), this.#options.sweepMs ?? DEFAULT_SWEEP_MS);
		this.#nudgePump();
		// Proof of life from the very first moment: a fresh stamp means the sweep_stalled gate starts closed.
		this.#beat();
		log.info("daemon_ready", { socket: this.socketPath, herdr: config.herdr === undefined ? "off" : "on" });
		if (bootConfigText === undefined) log.warn("last_good_config_skipped", { reason: "config_unreadable" });
		else if (readConfigText(config.homeDir) === bootConfigText)
			recordLastGoodConfig(config.homeDir, (error) => log.warn("last_good_config_failed", { error }), bootConfigText);
		else log.warn("last_good_config_skipped", { reason: "config_changed_since_boot" });
	}

	/** Backfill deps resolved fresh per pass: targets follow the ledger as channels and threads appear. */
	#backfillDeps(): BackfillDeps {
		const store = this.store;
		const adapter = this.#adapter;
		if (adapter === undefined) throw new Error("backfill before adapter start");
		const channelCursorPrefix = channelCursorKey("");
		return {
			transport: this.#options.transport,
			ingest: (event) => adapter.ingestRecovered(event),
			notifier: (channel, text) => adapter.postNotice(channel, text),
			cursors: store,
			log: this.#log,
			now: Date.now(),
			botUserId: adapter.botUserId ?? "",
			// A channel is a target once any conversation of it exists: the channel origin, or a root/thread origin
			// (`slack/ch/<C>/t/<R>`) — a plain channel root opens only its own root origin, never the channel one — or
			// once it has a stored channel watermark: `ompbot gc` removes quiet root origins but never cursors, so a
			// channel scanned before stays a target like its channel origin row used to keep it. One target per
			// channel: the `ch:<C>` watermark spans every root and reply, and replies of answered threads also come
			// back as thread targets. An unreadable (left/deleted) channel is quarantined by the backfill itself.
			channels: [
				...new Map([
					...store.listCursorKeys(channelCursorPrefix).map((key): [string, ChannelTarget] => {
						const channel = key.slice(channelCursorPrefix.length);
						return [channel, { channel, kind: channel.startsWith("D") ? "im" : "channel" }];
					}),
					...store.listSlackOrigins().flatMap((originKey): Array<[string, ChannelTarget]> => {
						const channel = slackOriginChannel(originKey);
						if (channel === undefined) return [];
						return [[channel, { channel, kind: originKey.startsWith("slack/dm/") ? "im" : "channel" }]];
					}),
				]).values(),
			],
			threads: store.listSlackThreadTargets(Date.now() - 7 * 24 * 3_600_000, 200),
		};
	}

	/**
	 * `작업: <제목> @<경로>`: the message is settled with its own answer (the lane's thread is the real output), never
	 * sent to the DM conversation's omp session.
	 */
	async #startLane(row: InboundRow, trigger: LaneTrigger): Promise<void> {
		const store = this.store;
		const opRef = `lane:${row.platformMessageId}`;
		store.markDispatched(row.platformMessageId, { opRef, entryCursor: null });
		const channel = parseThreadRef(row.threadRef)?.channel;
		let reply: string;
		try {
			if (!this.#lanes || channel === undefined) throw new Error("lanes unavailable");
			const lane = await this.#lanes.start({ ...trigger, channel });
			reply = `🔄 작업 레인 \`${lane.name}\`을 시작했습니다. 새 스레드에서 진행 상황을 확인하세요.`;
		} catch (error) {
			if (error instanceof LaneInputError) {
				reply = `⚠️ 작업 레인을 시작하지 못했습니다: ${error.message}`;
			} else {
				this.#log.error("lane_start_failed", { id: row.platformMessageId, error: String(error) });
				reply = "⚠️ 작업 레인을 시작하지 못했습니다. 로그를 확인하세요.";
			}
		}
		store.recordAnswer({ originKey: row.originKey, opRef, threadRef: row.threadRef, parts: [reply] });
	}

	#dispatchPending(originKey: string): void {
		const router = this.#router;
		if (!router) return;
		router
			.mailbox(originKey)
			.resumePending()
			.catch((error: unknown) =>
				this.#log.error("dispatch_pending_failed", { origin: originKey, error: String(error) }),
			);
	}

	/**
	 * A pending row stranded by a `dispatch_pending_failed` drain throw or a failed steer has no retry path but the
	 * origin's next message or a restart, and a stuck row blocks the rows behind it (`#drain` breaks). Every sweep,
	 * origins whose oldest pending row is at least `pendingRetryMs` old get one `resumePending` re-run — the same
	 * drain the origin's next message runs, so the semantics are identical — gated on the origin being idle: a busy
	 * origin's pending rows are its normal queue and drain when the turn settles. `PENDING_ALERT_AFTER` failed
	 * retries in a row alert the owner once through the shared `recordAlertIncident` machine (24h repeat
	 * suppression), so a message cannot sit for hours unnoticed like in the 2026-10-24 outage.
	 */
	#sweepPendingDispatch(): void {
		const interval = this.#options.pendingRetryMs ?? PENDING_RETRY_MS;
		const store = this.#store;
		const router = this.#router;
		if (interval <= 0 || store === undefined || router === undefined) return;
		// A restart drain holds pending rows on purpose (`resumePending` returns at once), so a retry would count a
		// deliberate wait as a failure and alert the owner; `setDraining(false)` dispatches them itself.
		if (router.draining) return;
		const now = this.#clock.now();
		const stale = store.listInbound({ state: "pending" }).filter((row) => now - row.createdAt >= interval);
		for (const originKey of new Set(stale.map((row) => row.originKey))) {
			if (router.mailbox(originKey).state.busy) continue;
			const previous = this.#pendingRetries.get(originKey);
			if (previous !== undefined && now - previous.at < interval) continue;
			const oldest = stale
				.filter((row) => row.originKey === originKey)
				.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
			const state: PendingRetryState = {
				at: now,
				oldestId: oldest.platformMessageId,
				failures: previous?.failures ?? 0,
				sign: previous?.sign ?? "",
			};
			this.#pendingRetries.set(originKey, state);
			router
				.mailbox(originKey)
				.resumePending()
				.catch((error: unknown) => {
					state.sign = String(error);
					this.#log.warn("pending_retry_failed", { origin: originKey, error: String(error) });
				})
				.then(() => this.#settlePendingRetry(originKey, state));
		}
	}

	/**
	 * Counts one retry outcome on the oldest stuck row: it leaving pending (answered, dispatched, discarded) is
	 * progress — the streak clears and a standing incident resolves — while a row still pending increments the
	 * streak and, from `PENDING_ALERT_AFTER`, records an owner incident (a notice only on its first occurrence or
	 * after the 24h repeat window).
	 */
	#settlePendingRetry(originKey: string, state: PendingRetryState): void {
		const store = this.#store;
		if (store === undefined) return;
		if (store.getInbound(state.oldestId)?.state !== "pending") {
			if (state.failures > 0) store.resolveAlertIncidents(`dispatch:${originKey}`);
			if (this.#pendingRetries.get(originKey) === state) this.#pendingRetries.delete(originKey);
			return;
		}
		state.failures += 1;
		const adapter = this.#adapter;
		if (state.failures < PENDING_ALERT_AFTER || adapter === undefined) return;
		const now = this.#clock.now();
		const sign = state.sign === "" ? "resume_pending_stuck" : state.sign;
		let incident = { notify: true, count: 1, firstAt: now };
		try {
			incident = store.recordAlertIncident(`dispatch:${originKey}`, sign, now);
		} catch (error) {
			this.#log.warn("pending_retry_incident_failed", { origin: originKey, error: String(error) });
			return;
		}
		if (!incident.notify) return;
		this.#log.warn("pending_dispatch_notified", {
			origin: originKey,
			failures: state.failures,
			count: incident.count,
		});
		const oldest = store.getInbound(state.oldestId);
		void adapter.postNotice(
			store.ownerChannel(),
			formatPendingDispatchNotice(originKey, now - (oldest?.createdAt ?? now), redact(sign), incident.count),
		);
	}

	/** Rule (3) plus the periodic work: deliver due rows, update status messages, stop quiet omp children. */
	pump(): Promise<void> {
		this.#pumping = this.#pumping.then(async () => {
			const adapter = this.#adapter;
			if (!adapter || this.#stopped) return;
			try {
				await adapter.pumpDeliveries();
				await adapter.tick();
			} catch (error) {
				this.#log.error("pump_failed", { error: String(error) });
			}
		});
		return this.#pumping;
	}

	#nudgePump(): void {
		setImmediate(() => void this.pump());
	}

	async sweep(): Promise<void> {
		await this.pump();
		this.#router?.sweepStalls();
		await this.#lanes?.tick();
		try {
			// A restart drain fires no monitor: due slots are claimed by the next process's catch-up.
			if (this.#router?.draining !== true) await this.#monitors?.tick();
		} catch (error) {
			this.#log.error("monitor_tick_failed", { error: String(error) });
		}
		try {
			await this.#router?.sweepIdle();
		} catch (error) {
			this.#log.error("sweep_idle_failed", { error: String(error) });
		}
		this.#maybeSweepTasks();
		this.#sweepPendingDispatch();
		try {
			await this.#sweepGates();
		} catch (error) {
			this.#log.error("gate_sweep_failed", { error: String(error) });
		}
		void this.#broker
			?.expireStale()
			.catch((error: unknown) => this.#log.warn("approval_expire_failed", { error: String(error) }));
		this.#sweepMedia();
		this.#maybeReviewSkills();
		this.#beat();
	}

	/** Records a finished sweep in the heartbeat stamp; a stale stamp opens the `sweep_stalled` gate. */
	#beat(): void {
		const heartbeat = this.#heartbeat;
		if (heartbeat === undefined) return;
		try {
			const loopMs = heartbeat.beat(this.#clock.now(), {
				socket: this.#options.transport.connectionState?.(),
				draining: this.#router?.draining === true,
			});
			if (loopMs > EVENT_LOOP_WARN_MS) this.#log.warn("event_loop_blocked", { loop_ms: loopMs });
		} catch (error) {
			this.#log.warn("heartbeat_failed", { error: String(error) });
		}
	}

	/**
	 * Owner DM for a run of failed turns — the bot reporting "나 망가짐" by itself, the missing half of the 2026-10-24
	 * outage. The same failure sign notifies once per 24h (monitor incident cadence); monitor origins are skipped
	 * because their failures already retry with backoff and get their own terminal notice.
	 */
	#escalateTurnFailures(info: TurnFailureEscalation): void {
		const store = this.#store;
		const adapter = this.#adapter;
		if (store === undefined || adapter === undefined) return;
		if (info.originKey.startsWith(MONITOR_ORIGIN_PREFIX)) return;
		const now = this.#clock.now();
		let incident = { notify: true, count: 1, firstAt: now };
		try {
			incident = store.recordAlertIncident(`turns:${info.originKey}`, info.reason, now);
		} catch (error) {
			this.#log.warn("escalation_incident_failed", { origin: info.originKey, error: String(error) });
		}
		if (!incident.notify) return;
		this.#log.warn("turn_failures_notified", {
			origin: info.originKey,
			failures: info.failures,
			count: incident.count,
			modelHealed: info.modelHealed,
		});
		void adapter.postNotice(
			store.ownerChannel(),
			formatTurnEscalationNotice({ ...info, reason: redact(info.reason) }, incident.count),
		);
	}

	/**
	 * Owner DM for a provider usage limit seen in omp's retry events (429 / weekly limit). One incident sign for every
	 * wording, so the owner hears about it once per 24h; monitor origins are not skipped (their limit hit is exactly
	 * what 2026-11-02 hid for six hours). The incident is never resolved automatically.
	 */
	#notifyProviderLimit(info: ProviderLimitInfo): void {
		const store = this.#store;
		const adapter = this.#adapter;
		if (store === undefined || adapter === undefined) return;
		const now = this.#clock.now();
		let incident = { notify: true, count: 1, firstAt: now };
		try {
			incident = store.recordAlertIncident("provider:limit", "provider-limit", now);
		} catch (error) {
			this.#log.warn("provider_limit_incident_failed", { origin: info.originKey, error: String(error) });
		}
		if (!incident.notify) return;
		this.#log.warn("provider_limit_notified", { origin: info.originKey, count: incident.count });
		void adapter.postNotice(store.ownerChannel(), formatProviderLimitNotice(info, incident.count));
	}

	/**
	 * Self-diagnosis loop: every `gateSweepMs` the daemon runs the same gate projection as `ompbot gates` and reports
	 * transitions to the owner DM. An opening gate notifies once and re-alerts daily while it stands (the same gate
	 * within 24h stays quiet), and a close after an alerted open sends the recovery notice — so a flapping gate
	 * cannot spam and a dead backup timer still reaches the only channel the owner watches. Two exceptions: the
	 * window gates (`turns_failing`, `monitors_failed`) close silently, because an aged-out window is not a fix, and
	 * `standing` incidents re-seed `alerted` after a restart, so a real recovery still reports across incarnations.
	 * After a recovery notice the incident is resolved once the gate has stayed closed for
	 * `GATE_RESOLVE_CLOSED_SWEEPS` sweeps, so a later recurrence alerts again; a gate first seen closed after a
	 * restart resolves its leftover incident immediately.
	 */
	async #sweepGates(): Promise<void> {
		const interval = this.#options.gateSweepMs ?? DEFAULT_GATE_SWEEP_MS;
		const store = this.#store;
		const adapter = this.#adapter;
		if (interval <= 0 || store === undefined || adapter === undefined) return;
		const now = this.#clock.now();
		if (now - this.#lastGateSweepAt < interval) return;
		this.#lastGateSweepAt = now;
		const { config } = this.#options;
		const omp = (config.agent ?? "omp") === "omp" ? { ompExecutable: config.ompExecutable } : {};
		for (const gate of collectGates({
			homeDir: config.homeDir,
			now,
			offsiteConfigured: config.offsite !== undefined,
			...omp,
		})) {
			const previous = this.#gateStates.get(gate.name);
			try {
				if (gate.state === "open") {
					const incident = store.recordAlertIncident(`gate:${gate.name}`, "open", now);
					// `standing` rebuilds the alerted flag after a restart (the in-memory map starts empty); a quiet
					// repeat inside 24h still counts as "the owner knows".
					const alerted = incident.notify || incident.standing || (previous?.state === "open" && previous.alerted);
					if (incident.notify) {
						await adapter.postNotice(store.ownerChannel(), formatGateOpenNotice(gate, incident.firstAt, now));
					}
					this.#gateStates.set(gate.name, { state: "open", alerted, closedSweeps: 0, pendingResolve: false });
				} else if (previous?.state === "open") {
					// A close after a quiet open stays quiet; a close after an alerted open reports the recovery —
					// except the window gates, whose close only means the evidence aged out.
					const reportRecovery = previous.alerted && !WINDOW_GATES.has(gate.name);
					if (reportRecovery) await adapter.postNotice(store.ownerChannel(), formatGateClosedNotice(gate));
					this.#gateStates.set(gate.name, {
						state: "closed",
						alerted: false,
						closedSweeps: 1,
						pendingResolve: reportRecovery,
					});
				} else if (previous?.state === "closed") {
					previous.closedSweeps += 1;
					if (previous.pendingResolve && previous.closedSweeps >= GATE_RESOLVE_CLOSED_SWEEPS) {
						store.resolveAlertIncidents(`gate:${gate.name}`);
						previous.pendingResolve = false;
						this.#log.info("gate_incident_resolved", { gate: gate.name });
					}
				} else if (!WINDOW_GATES.has(gate.name)) {
					// First observation after a restart is already closed: clear any leftover alerted row (no row = no-op).
					store.resolveAlertIncidents(`gate:${gate.name}`);
					this.#log.info("gate_incident_resolved", { gate: gate.name, reason: "closed_at_boot" });
					this.#gateStates.set(gate.name, { state: "closed", alerted: false, closedSweeps: 1, pendingResolve: false });
				}
			} catch (error) {
				this.#log.warn("gate_report_failed", { gate: gate.name, error: String(error) });
			}
		}
	}

	/** Every `taskSweepMs`, in the background: remote reads can take seconds and must not stall the sweep chain. */
	#maybeSweepTasks(): void {
		const interval = this.#options.taskSweepMs ?? TASK_SWEEP_MS;
		const now = this.#clock.now();
		if (interval <= 0 || now - this.#lastTaskSweepAt < interval) return;
		this.#lastTaskSweepAt = now;
		void this.sweepTasks();
	}

	/** One [TASK] sweep (files and git only); overlapping calls collapse into the running one. */
	async sweepTasks(): Promise<void> {
		if (this.#taskSweeping || this.#taskSweeper === undefined || this.#stopped) return;
		this.#taskSweeping = true;
		try {
			await this.#taskSweeper.sweep();
		} catch (error) {
			this.#log.error("task_sweep_failed", { error: String(error) });
		} finally {
			this.#taskSweeping = false;
		}
	}

	/** Hourly, not per-sweep: inbound attachments are context for one turn, kept 24h, then deleted. */
	#sweepMedia(): void {
		const now = Date.now();
		if (now - this.#lastMediaSweep < MEDIA_SWEEP_INTERVAL_MS) return;
		this.#lastMediaSweep = now;
		try {
			const removed = pruneMediaFiles(join(this.#options.config.homeDir, "media"), now);
			if (removed > 0) this.#log.info("media_pruned", { removed });
		} catch (error) {
			this.#log.warn("media_prune_failed", { error: String(error) });
		}
	}

	/**
	 * Background skill review (hermes learning loop, minimal): every `skillReviewTurns` answered owner DM turns a
	 * separate child reads the recent digest and proposes skills; only an explicit owner click installs them.
	 */
	#maybeReviewSkills(): void {
		const every = this.#options.config.skillReviewTurns ?? DEFAULT_SKILL_REVIEW_TURNS;
		if (every <= 0 || this.#reviewing || this.#router?.draining === true) return;
		const store = this.#store;
		const adapter = this.#adapter;
		if (store === undefined || adapter === undefined) return;
		// Same latest-updated_at rule as the escalation/gate notices' ownerChannel(): a stale duplicate DM origin row
		// must not make the answered count (and so the review cadence) follow a dead conversation.
		const dmOrigin = store.ownerDmOrigin();
		if (dmOrigin === undefined) return;
		const answered = store.countAnswered(dmOrigin);
		const seen = this.#reviewedTurns.get(dmOrigin);
		// First look at this DM since boot: its count is the baseline, so the cadence counts turns from here on.
		if (seen === undefined) {
			this.#reviewedTurns.set(dmOrigin, answered);
			return;
		}
		if (answered - seen < every) return;
		this.#reviewedTurns.set(dmOrigin, answered);
		// Frozen: no autonomous omp turn. This due review is skipped (not queued); the next one follows `every` turns.
		if (this.#frozen() !== undefined) {
			this.#log.info("skill_review_skipped_frozen", { origin: dmOrigin, answered });
			return;
		}
		this.#reviewing = true;
		const channel = dmOrigin.slice("slack/dm/".length);
		const origin = store.getOrigin(dmOrigin);
		void runSkillReview(
			{
				makeDriver: (reviewOrigin, sessionDir) => this.#makeDriver(reviewOrigin, sessionDir),
				readDigest: async () => (origin?.sessionDir === undefined ? "" : await readSessionDigest(origin.sessionDir)),
				savePending: (proposals) => savePendingProposals(this.#options.config.homeDir, proposals, Date.now()),
				install: async (proposal) => {
					const dir = skillDirOf(proposal.name);
					mkdirSync(dir, { recursive: true, mode: 0o700 });
					// The previous SKILL.md becomes a revision first: an approved patch must stay reversible.
					const revision = backupSkillRevision(dir, Date.now());
					if (revision !== undefined)
						this.#log.info("skill_revision_saved", { name: proposal.name, revision: basename(revision) });
					writeFileSync(join(dir, "SKILL.md"), renderSkillFile(proposal), { mode: 0o600 });
				},
				requestApproval: (summary) => this.#approval.request(channel, summary),
				notify: (text) => adapter.postNotice(channel, text),
				log: this.#log,
				now: () => Date.now(),
			},
			{ sessionDir: sessionDirFor(join(this.#options.config.homeDir, "sessions"), SKILL_REVIEW_ORIGIN, 1) },
		)
			.catch((error) => this.#log.warn("skill_review_failed", { error: String(error) }))
			.finally(() => {
				this.#reviewing = false;
			});
	}

	/** The cheap counts the hourly `service_alive` log line carries. */
	aliveFields(): Record<string, number> {
		const store = this.#store;
		const inbound = store?.countInboundByState();
		return {
			origins: store?.distinctInboundOrigins().length ?? 0,
			busy: this.#router?.busyOrigins().length ?? 0,
			pending: inbound?.pending ?? 0,
			dispatched: inbound?.dispatched ?? 0,
		};
	}

	/** Unfinished work a restart drain waits for (a running skill review counts as a turn). */
	drainCounts(): DrainCounts {
		return {
			turns: (this.#router?.busyTurns() ?? 0) + (this.#reviewing ? 1 : 0),
			hostTools: this.#router?.hostToolsRunning() ?? 0,
			approvals: this.#broker?.pendingCount ?? 0,
		};
	}

	/**
	 * `ompbot drain`: hold new turns, steers, monitor fires and skill reviews back so a restart cuts nothing; inbound
	 * stays `pending`. Memory only — the restart itself ends it. Ending it early dispatches what waited.
	 */
	setDraining(on: boolean): void {
		const router = this.#router;
		if (router === undefined || router.draining === on) return;
		router.draining = on;
		this.#log.info(on ? "drain_started" : "drain_cancelled", { ...this.drainCounts() });
		if (on) {
			this.#announceDrain();
			return;
		}
		this.#announceMarker("cancelled");
		for (const originKey of new Set(this.store.listInbound({ state: "pending" }).map((row) => row.originKey))) {
			this.#dispatchPending(originKey);
		}
	}

	/**
	 * `ompbot reload` / SIGHUP: re-reads config.json and applies the live fields (see `LIVE_FIELDS`); restart-bound
	 * fields are reported, not applied. An unreadable or invalid file keeps the running config untouched.
	 */
	reloadConfig(trigger: "ipc" | "sighup"): ReloadResult {
		const current = this.#options.config;
		let fresh: OmpbotConfig;
		const text = readConfigText(current.homeDir);
		try {
			fresh = loadConfig(current.homeDir);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#log.warn("config_reload_failed", { trigger, error: message });
			return { ok: false, error: message };
		}
		const plan = planReload(current, fresh);
		this.#options.config = plan.next;
		this.#store?.setLogChannel(plan.next.logChannel);
		this.#broker?.setEscalationChannel(plan.next.escalationChannel);
		this.#adapter?.setChannelPolicy({
			...(plan.next.mentionFreeChannels === undefined ? {} : { mentionFreeChannels: plan.next.mentionFreeChannels }),
			...(plan.next.logChannel === undefined ? {} : { logChannel: plan.next.logChannel }),
		});
		this.#log.info("config_reloaded", {
			trigger,
			changed: plan.changed.join(",") || "-",
			restart_required: plan.restartRequired.join(",") || "-",
			cli: plan.cli.join(",") || "-",
		});
		// Only a file the running daemon fully applies is a rollback target: restart-bound fields were never booted on.
		if (plan.restartRequired.length > 0)
			this.#log.info("last_good_config_skipped", {
				reason: "restart_required",
				fields: plan.restartRequired.join(","),
			});
		else if (text === undefined || readConfigText(current.homeDir) !== text)
			this.#log.warn("last_good_config_skipped", { reason: "config_changed_during_reload" });
		else recordLastGoodConfig(current.homeDir, (error) => this.#log.warn("last_good_config_failed", { error }), text);
		return { ok: true, changed: plan.changed, restartRequired: plan.restartRequired, cli: plan.cli };
	}

	/** Drain start: tell the active conversations a restart is coming and remember them for the "back" notice. */
	#announceDrain(): void {
		const { config } = this.#options;
		const router = this.#router;
		const store = this.#store;
		if (config.restartNotice === false || router === undefined || store === undefined) return;
		const now = this.#clock.now();
		const threads = pickRestartThreads(
			router.busyOrigins().map((originKey) => router.mailbox(originKey).state.threadRef),
			store.recentConversations(now - RESTART_NOTICE_ACTIVE_MS, RESTART_NOTICE_MAX).map((c) => c.threadRef),
		);
		if (threads.length === 0) return;
		try {
			writeRestartMarker(config.homeDir, { at: now, threads });
		} catch (error) {
			this.#log.warn("restart_notice_marker_failed", { error: String(error) });
		}
		this.#log.info("restart_notice", { kind: "draining", threads: threads.length });
		this.#postThreadNotices(threads, RESTART_NOTICE_TEXT.draining);
	}

	/**
	 * Consumes the drain marker: "back" at the next start (a marker older than {@link RESTART_NOTICE_STALE_MS} is an
	 * unrelated leftover and is dropped silently), "cancelled" when the drain ends without a restart.
	 */
	#announceMarker(kind: "back" | "cancelled"): void {
		const { config } = this.#options;
		const marker = takeRestartMarker(config.homeDir);
		if (marker === undefined) return;
		const age = this.#clock.now() - marker.at;
		if (config.restartNotice === false || age > RESTART_NOTICE_STALE_MS) {
			this.#log.info("restart_notice_dropped", { kind, age_ms: age });
			return;
		}
		this.#log.info("restart_notice", { kind, threads: marker.threads.length });
		this.#postThreadNotices(marker.threads, RESTART_NOTICE_TEXT[kind]);
	}

	#postThreadNotices(threads: string[], text: string): void {
		const adapter = this.#adapter;
		if (adapter === undefined) return;
		for (const ref of threads) {
			const parsed = parseThreadRef(ref);
			if (parsed === undefined) continue;
			void adapter.postNotice(parsed.channel, text, parsed.threadTs === TOP_LEVEL_TS ? undefined : parsed.threadTs);
		}
	}

	status(): StatusReport {
		const router = this.#router;
		const report = buildStatus(
			this.store,
			this.#options.ompVersion,
			(originKey) => {
				const state = router?.mailbox(originKey).state;
				return {
					ompPid: state?.driverRunning ? (this.#drivers.get(originKey)?.pid ?? null) : null,
					busy: state?.busy ?? false,
				};
			},
			openGateSummary(
				join(this.#options.config.homeDir, "ompbot.db"),
				this.#clock.now(),
				this.#options.config.offsite !== undefined,
			),
		);
		const withFreeze = { ...report, ...frozenField(this.#options.config.homeDir) };
		return router?.draining ? { ...withFreeze, drain: this.drainCounts() } : withFreeze;
	}

	/**
	 * `ompbot inject`: the bot posts a `🧪 inject <nonce>` root message in the DM and an owner message is fed through the
	 * Slack adapter's own message path (same normalizeInbound, same fencing of `quoted`), threaded under that root.
	 * With `thread` the marker is a reply in that existing thread and the owner message a reply of it.
	 */
	async inject(request: InjectRequest): Promise<InjectResult> {
		const adapter = this.#adapter;
		if (!adapter) throw new Error("daemon not started");
		if (request.asOwner !== true) throw new Error("inject requires --as-owner");
		const match = SLACK_ORIGIN.exec(request.origin);
		const channel = match?.[2];
		if (channel === undefined)
			throw new Error(`inject origin must be slack/dm/<id> or slack/ch/<id>: ${request.origin}`);
		const inChannel = match?.[1] === "ch";
		// In a channel the bot only answers when addressed, exactly like a real owner message there.
		const mention = inChannel && adapter.botUserId !== undefined ? `<@${adapter.botUserId}> ` : "";
		const nonce = randomBytes(6).toString("hex");
		const root = await this.#options.transport.postMessage({
			channel,
			text: `🧪 inject ${nonce}`,
			...(request.thread === undefined ? {} : { threadTs: request.thread }),
		});
		const attachments = request.quoted === undefined ? undefined : [{ text: escapeSlack(request.quoted) }];
		// A reply in an approval card's thread settles the card without an inbound row, so acceptance comes from the
		// adapter's own verdict, not from the ledger.
		const outcome = await adapter.ingestRecovered({
			type: "message",
			channel,
			channel_type: inChannel ? "channel" : "im",
			user: this.#options.config.ownerSlackUserId,
			text: `${mention}${escapeSlack(request.text)}`,
			ts: root.ts,
			...(request.thread === undefined ? {} : { thread_ts: request.thread }),
			attachments,
		});
		if (outcome === "dropped") throw new Error("inject_rejected: message was not accepted");
		return { nonce, threadRef: threadRefOf(channel, request.thread ?? root.ts) };
	}

	async #handleIpc(request: unknown): Promise<unknown> {
		if (typeof request !== "object" || request === null || !("op" in request)) {
			return { ok: false, error: "invalid request" };
		}
		if (request.op === "status") return { ok: true, status: this.status() };
		if (request.op === "reload") return this.reloadConfig("ipc");
		if (request.op === "drain" || request.op === "drain_status" || request.op === "drain_cancel") {
			if (request.op !== "drain_status") this.setDraining(request.op === "drain");
			return { ok: true, draining: this.#router?.draining ?? false, ...this.drainCounts() };
		}
		if (request.op === "inject") {
			const text = "text" in request ? request.text : undefined;
			const origin = "origin" in request ? request.origin : undefined;
			const quoted = "quoted" in request ? request.quoted : undefined;
			const thread = "thread" in request ? request.thread : undefined;
			if (
				typeof text !== "string" ||
				typeof origin !== "string" ||
				(quoted !== undefined && typeof quoted !== "string") ||
				(thread !== undefined && typeof thread !== "string")
			) {
				return { ok: false, error: "inject needs origin and text strings" };
			}
			const asOwner = "asOwner" in request && request.asOwner === true;
			return { ok: true, ...(await this.inject({ origin, asOwner, text, quoted, thread })) };
		}
		if (request.op === "tasks_check" || request.op === "tasks_sync") {
			const id = "id" in request ? request.id : undefined;
			const row = typeof id === "string" ? this.#store?.tasks.get(id) : undefined;
			if (row === undefined || this.#taskSweeper === undefined) return { ok: false, error: "task not found" };
			if (request.op === "tasks_sync") return { ok: await this.#taskSweeper.syncReaction(row.taskId) };
			return { ok: true, ...(await this.#taskSweeper.check(row)) };
		}
		return { ok: false, error: `unknown op` };
	}

	/**
	 * SIGTERM path: stop dispatching pending rows (they stay pending for the next boot's rule (1)), stop intake,
	 * wait bounded for running turns to settle (their answers land in the ledger for the next boot's recovery),
	 * stop the omp children, close the ledger. A turn that outlives the drain bound is stopped mid-flight exactly
	 * as before. A second signal re-enters here: it awaits the in-flight shutdown instead of resolving at once,
	 * which would let runDaemon exit and abandon the drain mid-wait.
	 */
	async stop(): Promise<void> {
		if (this.#stopPromise === undefined) {
			this.#stopped = true;
			this.#router?.stopDispatching();
			this.#stopPromise = this.#shutdown();
		}
		return this.#stopPromise;
	}

	async #shutdown(): Promise<void> {
		clearInterval(this.#timer);
		this.#heartbeat?.stop();
		this.#heartbeat = undefined;
		installProcessAudit(undefined);
		this.#ipc?.stop();
		this.#webhook?.stop();
		await this.#adapter?.stop();
		await this.#pumping;
		this.#monitors?.stop();
		await this.#monitors?.idle();
		await this.#drainRunningTurns();
		await this.#router?.close();
		this.#store?.close();
		this.#log.info("daemon_stop", { boot: this.#options.bootId });
	}

	/** The bounded wait between intake stop and child stop; a no-op when nothing runs or the bound is 0. */
	async #drainRunningTurns(): Promise<void> {
		const router = this.#router;
		const boundMs = this.#options.stopDrainMs ?? STOP_DRAIN_MS;
		if (router === undefined || boundMs <= 0) return;
		const busy = router.busyOrigins();
		if (busy.length === 0) return;
		const startedAt = this.#clock.now();
		const stillBusy = await router.drainRunning(boundMs);
		if (stillBusy.length > 0) {
			this.#log.warn("stop_drain_timeout", { origins: stillBusy, boundMs });
		} else {
			this.#log.info("stop_drained", { origins: busy, drainMs: this.#clock.now() - startedAt });
		}
	}
}
