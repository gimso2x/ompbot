import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ChannelAdapter, ChannelBinding } from "../channel/adapter";
import { ChannelRegistry } from "../channel/registry";
import { escapeMrkdwn } from "../channel/text";
import type { CoreSink, DeliveryItem, DeliverySource, GuestInboundMessage, IngestOutcome } from "../channel/types";
import {
	DEPRECATED_KEYS,
	LANE_REVIEW_TIMEOUT_MS,
	loadConfig,
	type OmpbotConfig,
	peerSilenceMinutes,
	primaryOwnerUserId,
} from "../config";
import type { DriverFactory, ProviderLimitInfo, ThreadSource, TurnFailureEscalation } from "../core/mailbox";
import { conversationKind, parseThreadRef, platformOfThreadRef, TOP_LEVEL_TS, threadRefOf } from "../core/normalize";
import { OriginRouter, sessionDirFor } from "../core/origin";
import { type ChatPlatform, parseChatOrigin, platformOfConversationId } from "../core/origin-key";
import { stuckStopText } from "../core/stuck";
import {
	COMMAND_OP_REF,
	COMMAND_TEXT,
	isHomeCommand,
	type MailboxClock,
	parseCommand,
	TEAMS_GROUP_HOME_REFUSED_TEXT,
} from "../core/types";
import { briefingFileName, briefingSummaryLine, renderBriefingHtml } from "../dashboard/briefing";
import { snapshotReader } from "../dashboard/snapshot-assembly";
import { escapeDiscordMarkdown } from "../discord/format";
import { createDispatchAudit, installProcessAudit } from "../dispatch/audit";
import { boardCardLink } from "../dispatch/board";
import {
	herdrAgentPane,
	herdrAgentStatus,
	herdrInterruptAgent,
	herdrPromptExisting,
	herdrReadAgent,
	type ProcessRunner,
	readRemoteLastAssistant,
	realProcessRunner,
	setLocalHerdrBin,
} from "../dispatch/omp";
import { boardNoticeFor, buildBoardTools } from "../lanes/board";
import { type LaneAction, parseLaneActionId } from "../lanes/card";
import { classifyLaneControl } from "../lanes/control";
import type { LandLane } from "../lanes/land";
import { DEFAULT_COMPLETION_NUDGES, LaneInputError, LaneManager } from "../lanes/manager";
import { isLaneOrigin, type LaneRow } from "../lanes/status";
import { buildLaneTools, buildWorkStartTool } from "../lanes/tools";
import {
	buildClosedLaneQuestion,
	classifyClosedLaneMessage,
	DISCORD_LANE_CHANNEL_MISSING,
	type LaneTrigger,
	parseLaneTrigger,
} from "../lanes/trigger";
import type { ClaimEvidence, VerifyResult } from "../lanes/verify";
import type { Logger } from "../log";
import { MONITOR_ORIGIN_PREFIX } from "../monitors/ledger";
import { MonitorScheduler } from "../monitors/scheduler";
import { buildMonitorTools, isPersonaOrigin } from "../monitors/tools";
import { WebhookServer } from "../monitors/webhook";
import type { ClaudeApprovalHook } from "../omp/claude-driver";
import type { OmpDialogAnswerer, OmpSessionDriver } from "../omp/driver";
import { lastAnswerOf, readLastAssistant } from "../omp/session-tail";
import {
	applyPathEnv,
	isExecutableFile,
	isReportOrigin,
	readAutoLandHold,
	readConfigText,
	recordLastGoodConfig,
	reportThreadPattern,
	STAMP_PATTERN,
	spawnRunner,
} from "../ops/apply";
import { type BackupOptions, type BackupResult, readStamp, runBackup } from "../ops/backup";
import { formatCacheMissNotice, formatColdCacheNotice } from "../ops/cache-monitor";
import {
	budgetBreach,
	type DailyBudgetState,
	dailyBudgetState,
	dailyCapNotice,
	dailyNoticeKey,
	dailyOffKey,
	ledgerDay,
	renderBudget,
	usd,
} from "../ops/cost-cap";
import { createFreezeProbe, type FreezeState } from "../ops/freeze";
import { collectGates, type GateState, gateOptionsFromConfig } from "../ops/gates";
import { HerdrHealthProbe } from "../ops/herdr-health";
import type { HostLoadReader } from "../ops/host-resources";
import { pruneMediaFiles } from "../ops/media";
import { BRIEFING_TIMEOUT_MS, BRIEFING_WIDTH, renderPng } from "../ops/screenshot";
import { allSessionFiles, conversationSessionFiles, renderUsage, summarizeSessionFiles } from "../ops/usage";
import { redact } from "../redact";
import { resolveCandidates, runCandidateProposals } from "../review/candidates";
import {
	installSkill,
	readSessionDigest,
	runSkillReview,
	SKILL_REVIEW_ORIGIN,
	savePendingProposals,
	skillDirOf,
} from "../review/skills";
import { ApprovalBroker, type ApprovalOutcome, parseApprovalRetryActionId } from "../safety/approval";
import { answerDialogOnSlack } from "../safety/choice";
import { buildHostTools, type HostToolDef, PEER_TOOL_DENIED } from "../safety/host-tools";
import { buildFloorsPrompt, type FloorsSurface, teamsQaSystemPrompt } from "../safety/prompt";
import {
	type DeliveryRow,
	type HerdrPromptInput,
	INTERIM_INFIX,
	type InboundRow,
	LOG_COPY_SUFFIX,
	type LogChannels,
	PEER_SILENCE_OP_PREFIX,
	type PeerCallPolicy,
	Store,
} from "../store/db";
import { notePrompt } from "../tasks/dispatch";
import { evaluateTask } from "../tasks/evaluate";
import { resolveTaskHost } from "../tasks/host";
import type { TaskRow } from "../tasks/ledger";
import {
	type AutoLandPolicy,
	buildBlockedSettledCard,
	buildMergeSettledCard,
	cardMessage,
	parseTaskMergeActionId,
	parseTaskRecommendActionId,
	RECOMMEND_VALUE_MAX,
	type TaskCard,
} from "../tasks/notify";
import { repoMatchesCommonDir } from "../tasks/repo-match";
import { TASK_SWEEP_MS, TaskSweeper, taskChangedPaths } from "../tasks/sweeper";
import { TeamsGraphClient } from "../teams/graph";
import { localIso, offsetLabel } from "../time";
import type { CrashPoint } from "./crash";
import {
	buildGuestPrompt,
	GUEST_BUSY_TEXT,
	GUEST_COMMAND_TEXT,
	GUEST_CONTEXT_PAIRS,
	GUEST_FAILED_TEXT,
	GuestQueue,
	runGuestQuestion,
} from "./guest";
import { DEFAULT_SWEEP_MS, EVENT_LOOP_WARN_MS, SweepHeartbeatWriter } from "./heartbeat";
import { type IpcServer, startIpcServer } from "./ipc";
import { pidAlive } from "./lock";
import {
	formatGateClosedNotice,
	formatGateOpenNotice,
	formatPendingDispatchNotice,
	formatProviderLimitNotice,
	formatSessionMismatchNotice,
	formatStallNotice,
	formatTurnEscalationNotice,
} from "./notices";
import { NamespacedDriver } from "./opref";
import { type RestartCutEntry, recoverDispatched, writeRestartCut } from "./recovery";
import { planReload, type ReloadResult } from "./reload";
import { isSideOpRef, NOTIFY_OP_PREFIX, RestartLauncher, type RestartLauncherDeps } from "./restart";
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
	renderContextLine,
	renderStatusText,
	type StatusReport,
} from "./status";

const MEDIA_SWEEP_INTERVAL_MS = 60 * 60_000;

/** KV-cursor prefixes of a thread's peer hop cap: the last owner message and the notice already posted. */
const PEER_HOP_RESET_CURSOR = "peerhop-reset:";
const PEER_HOP_NOTICE_CURSOR = "peerhop-notice:";

/** A plain message while 2+ choice cards of the conversation wait: it is not taken as an answer (`dialogs.ambiguous`). */
const DIALOG_AMBIGUOUS_NOTICE =
	"❓ 답을 기다리는 질문 카드가 여러 개라 이 메시지는 답으로 쓰지 않았습니다 — 답할 질문 카드의 스레드에 답장해 주세요(또는 버튼)";
/** Gate sweep cadence of the self-diagnosis loop (0 disables it). */
export const DEFAULT_GATE_SWEEP_MS = 5 * 60_000;
/**
 * Consecutive closed sweeps after an alerted gate closes before its incident is resolved (15 minutes at
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

/** Ephemeral answer to a slash command typed during a restart drain (recorded; the next process runs it). */
export const LANE_DRAIN_REFUSED_TEXT =
	"재시작 준비 중이라 작업 레인을 시작하지 않았습니다. 재시작이 끝난 뒤 같은 메시지를 다시 보내 주세요.";
export const DRAIN_DEFERRED_COMMAND_TEXT = "재시작 준비 중이라 재시작 뒤에 처리합니다. 다시 보내지 않아도 됩니다.";

/**
 * Gates that close because their evidence window elapsed (`turns_failing` 1h, `monitors_failed` 24h), not because
 * the problem was fixed: the bot may still be broken, so their close is bookkeeping only — never a recovery DM. The
 * incident row is still resolved like any other gate's, so a recurrence alerts again.
 */
const WINDOW_GATES = new Set(["turns_failing", "monitors_failed"]);

export interface DaemonOptions {
	config: OmpbotConfig;
	/**
	 * The config.json text `loadConfig` validated for this boot (read right before it; `undefined` = unreadable). Only
	 * this text can become last-good at ready. Absent (tests) → read when `start()` begins.
	 */
	bootConfigText?: string | undefined;
	/**
	 * The chat platforms, one binding each: a binding's port carries the core-authored posts of its platform (through
	 * the redacting registry), its adapter the inbound path and delivery pump.
	 */
	channels: readonly ChannelBinding[];
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
	/** Test seam for the `host_pressure` gate in sweeps and status (default this machine's readings). */
	hostLoad?: Partial<HostLoadReader>;
	/**
	 * The backup `start()` runs once when the home has no backup stamp yet (a first install), before the first gate
	 * sweep; default {@link runBackup}. Tests inject a failing one.
	 */
	bootBackup?: (options: BackupOptions) => BackupResult;
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
	/** Test seam: how long a turn waits for the Slack thread read of its context (default 10s in the mailbox). */
	threadContextTimeoutMs?: number;
	/** Test seam for done-claim verification; default checks the real git repository. */
	verifyClaim?: (evidence: ClaimEvidence, cwd: string) => Promise<VerifyResult>;
	/** Test seam for landing a closed work lane; default merges, pushes and cleans up with real git. */
	landLane?: LandLane;
	/** Test seam for the lanes' independent review (`taskAutoLand.review`); default runs the real `omp -p`. */
	laneReviewRun?: ProcessRunner;
	/** Test seam for whether an `ompbot lanes attach` process lives; default signal 0 on this machine. */
	pidAlive?: (pid: number) => boolean;
	/** Test seam for the [TASK] sweep's herdr calls (remind, agent status, board pane); default runs the real herdr. */
	herdrRun?: ProcessRunner;
	/**
	 * Test seam for `!restart`: its git, systemctl and systemd-run runner, bun lookup and lock-holder check; default
	 * the real ones on this machine.
	 */
	restart?: Partial<Pick<RestartLauncherDeps, "run" | "isAlive" | "isExecutable" | "pathEnv" | "repoDir">>;
	/** Test seam for `!brief`'s chromium capture; default runs the real chromium. */
	briefingRun?: ProcessRunner;
	/** Test seam for the Teams guest/qa `omp -p` runs; default runs the real omp. */
	guestRun?: ProcessRunner;
	/** Test seam: the env the guest/qa runs inherit (and find the real omp agent dir in); default `process.env`. */
	guestEnv?: Record<string, string | undefined>;
	/**
	 * Test seam for the Teams Graph chat tools' endpoints (fake Entra and Graph servers); used only when
	 * `channels.teams.graph` is set and `ownerMode` is not `qa`.
	 */
	teamsGraphEndpoints?: { loginBase: string; graphBase: string };
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

/** Card note when a `머지` click could not reach the task thread: the owner answers by hand instead. */
const MERGE_REJECTED_NOTE = '⚠️ 머지 요청을 넣지 못함 — 스레드에 "머지해"라고 답해 주세요';
/** Card note when a `추천대로` click could not reach the task thread. */
const RECOMMEND_REJECTED_NOTE = '⚠️ 추천을 넣지 못함 — 스레드에 "추천대로"라고 답해 주세요';
/** The owner text and marker of an auto-merge (`taskAutoLand`): the landing starts exactly as after a typed "머지해". */
const AUTO_LAND_TEXT = "머지해 (자동: Outcome 도달·재실행 검사 통과)";
const AUTO_LAND_MARKER = "🤖 자동 머지";

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

/** The peer call policy of a config: Discord peer bots with `peerSilenceAlert` on; `undefined` (off) otherwise. */
function peerCallPolicyOf(config: OmpbotConfig): PeerCallPolicy | undefined {
	const discord = config.channels.discord;
	const minutes = peerSilenceMinutes(config);
	if (discord?.peerBots === undefined || discord.peerBots.length === 0 || minutes === 0) return undefined;
	return {
		peers: discord.peerBots,
		skipConversations: [discord.logChannelId].filter((id) => id !== undefined),
		ownerUserId: discord.ownerUserId,
		silenceMs: minutes * 60_000,
	};
}

/** The ledger with the crash hooks and a delivery nudge wired into the state changes that matter. */
class DaemonStore extends Store {
	constructor(
		path: string,
		clock: MailboxClock,
		private readonly crash: (point: CrashPoint) => void,
		private readonly nudge: () => void,
		log: Logger,
		slackOwnerUserId: string | undefined,
		logChannel: LogChannels,
		timezone: string,
	) {
		super({
			path,
			clock,
			timezone,
			redact,
			...(slackOwnerUserId === undefined ? {} : { slackOwnerUserId }),
			logChannel,
			hooks: {
				afterInboundAnswered: () => crash("after_final_before_answered"),
				onDeliveryState: ({ deliveryId, from, to }) => log.info("delivery_state", { id: deliveryId, from, to }),
				onOwnerNoticeUnroutable: ({ originKey, opRef }) =>
					log.warn("owner_notice_unroutable", { origin: originKey, op: opRef }),
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

	/** A running turn's text goes out right away; whether the turn succeeded is judged at its end (no incident reset). */
	override recordInterim(...args: Parameters<Store["recordInterim"]>): DeliveryRow {
		const row = super.recordInterim(...args);
		this.nudge();
		return row;
	}

	override recordGuestAnswer(...args: Parameters<Store["recordGuestAnswer"]>): DeliveryRow {
		const row = super.recordGuestAnswer(...args);
		this.nudge();
		return row;
	}

	override recordTurnFailure(...args: Parameters<Store["recordTurnFailure"]>): DeliveryRow | undefined {
		const row = super.recordTurnFailure(...args);
		if (row) this.nudge();
		return row;
	}
}

/** Wires store, origin router, channel adapters, unix socket and timers; owns recovery on start and graceful stop. */
export class Daemon {
	readonly #options: DaemonOptions;
	readonly #clock: MailboxClock;
	/** `HH:MM` in the bot's zone (`config.timezone`), for a card's result line. */
	readonly #clockFormat: Intl.DateTimeFormat;
	readonly #log: Logger;
	readonly #drivers = new Map<string, NamespacedDriver>();
	/** Unique per Daemon instance; `bootId` is the kernel boot id and repeats across daemon restarts. */
	readonly #incarnation = randomUUID().slice(0, 8);
	#driverCount = 0;
	#store: DaemonStore | undefined;
	#router: OriginRouter | undefined;
	#monitors: MonitorScheduler | undefined;
	#webhook: WebhookServer | undefined;
	/** One adapter per bound platform, built at start. */
	readonly #adapters = new Map<ChatPlatform, ChannelAdapter>();
	/** Teams guest/qa runs: 2 at once, 5 waiting; aborted at shutdown before the ledger closes. */
	readonly #guestQueue = new GuestQueue();
	readonly #guestAbort = new AbortController();
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
	/** `<task>:<reason>` of every overlap check a task was left out of, logged once each (memory only). */
	readonly #overlapSkipped = new Set<string>();
	/** Threads told "재시작 뒤에 처리" for an owner message held by the current drain: once per thread per drain. */
	readonly #drainDeferNoticed = new Set<string>();
	#lastTaskSweepAt = 0;
	#taskSweeping = false;
	/** Local `herdr status server` check on the task sweep cadence (herdr on only); feeds `herdr_unreachable`. */
	#herdrHealth: HerdrHealthProbe | undefined;
	/** Background lane tick / mailbox idle sweep in flight: the sweep never awaits them, and never overlaps them. */
	#laneTicking = false;
	#idleSweeping = false;
	/** The peer silence sweep runs only once the startup Discord recovery pass has fed in the posts missed meanwhile. */
	#peerSilenceArmed = false;
	/** Sweep-retry state per origin with stranded pending rows; progress deletes the entry. */
	readonly #pendingRetries = new Map<string, PendingRetryState>();
	#reviewing = false;
	readonly #reviewedTurns = new Map<string, number>();
	/** A candidate pass (and so its approval cards) is running. */
	#proposingCandidates = false;
	#lastCandidatePassAt = 0;
	#pumping: Promise<void> = Promise.resolve();
	#stopped = false;
	/** The in-flight shutdown; a re-entering stop() awaits it instead of returning immediately. */
	#stopPromise: Promise<void> | undefined;
	#heartbeat: SweepHeartbeatWriter | undefined;
	/** `<home>/FROZEN` re-read within seconds; autonomous paths (dispatch, monitors, lanes, task reminders) consult it. */
	readonly #frozen: () => FreezeState | undefined;
	#broker: ApprovalBroker | undefined;
	#lanes: LaneManager | undefined;
	/** Outbound posts of the core (approval cards, lanes, tasks, uploads, inject markers), redacted on the way. */
	readonly #channels: ChannelRegistry;
	/** Task cards (`<channel>:<ts>`) whose button (`머지`, `추천대로`) was clicked in this process: a second click does nothing. Never cleared. */
	readonly #mergeClicks = new Set<string>();
	/** Approvals (canonical `<channel>:<ts>`) whose `다시 요청` was clicked in this process, on either card. Never cleared. */
	readonly #retryClicks = new Set<string>();
	/** Tasks whose auto-merge "머지해" is being put in right now (a concurrent second call is refused); removed when it settles. */
	readonly #autoLanding = new Set<string>();
	/** The owner's delegated Graph session for the Teams chat tools; set when `channels.teams.graph` is on in `full`. */
	readonly #teamsGraph: TeamsGraphClient | undefined;

	constructor(options: DaemonOptions) {
		this.#options = options;
		const channels = new ChannelRegistry();
		for (const binding of options.channels) channels.register(binding.port);
		this.#channels = channels;
		this.#clock = options.clock ?? { now: () => Date.now() };
		this.#clockFormat = new Intl.DateTimeFormat("en-GB", {
			timeZone: options.config.timezone,
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		});
		this.#log = options.log;
		this.#frozen = createFreezeProbe(options.config.homeDir);
		const teams = options.config.channels.teams;
		if (teams?.graph !== undefined && teams.ownerMode === "qa") {
			// The owner's Teams messages take the read-only guest path under `qa`: no session there to read chats in.
			this.#log.warn("teams_graph_disabled", { reason: "ownerMode_qa" });
		} else if (teams?.graph !== undefined) {
			this.#teamsGraph = new TeamsGraphClient({
				tenantId: teams.tenantId,
				clientId: teams.appId,
				tokenFile: teams.graph.tokenFile,
				ownerAadObjectId: teams.ownerAadObjectId,
				log: this.#log,
				now: () => this.#clock.now(),
				notifyOwner: (text) => {
					const owner = this.#ownerTarget("teams_graph_relogin");
					void owner?.adapter.postNotice(owner.channel, text);
				},
				...options.teamsGraphEndpoints,
			});
		}
	}

	/** The adapter of a thread ref's platform; none for an unbound platform or a malformed ref. */
	#adapterOfThread(threadRef: string): ChannelAdapter | undefined {
		const platform = platformOfThreadRef(threadRef);
		return platform === undefined ? undefined : this.#adapters.get(platform);
	}

	/** The adapter of a conversation id's platform; none for an unbound platform. */
	#adapterOfConversation(conversationId: string): ChannelAdapter | undefined {
		const platform = platformOfConversationId(conversationId);
		return platform === undefined ? undefined : this.#adapters.get(platform);
	}

	/**
	 * The owner's notice conversation (`ownerHome()`) and the adapter that reaches it. No home yet (the owner has not
	 * written anywhere) is logged as `owner_notice_unroutable` with the notice that could not go out; a home on a
	 * platform without a bound adapter as `owner_channel_unbound`.
	 */
	#ownerTarget(notice: string): { adapter: ChannelAdapter; channel: string } | undefined {
		const store = this.#store;
		if (store === undefined) return undefined;
		const home = store.ownerHome();
		if (home === undefined) {
			this.#log.warn("owner_notice_unroutable", { notice });
			return undefined;
		}
		const adapter = this.#adapters.get(home.platform);
		if (adapter === undefined) {
			if (this.#adapters.size > 0) this.#log.warn("owner_channel_unbound", { channel: home.conversationId });
			return undefined;
		}
		return { adapter, channel: home.conversationId };
	}

	/** Per platform with a thread reader: what the mailbox reads a turn's thread context through. */
	#threadSources(): Map<ChatPlatform, ThreadSource> {
		const timeout =
			this.#options.threadContextTimeoutMs === undefined ? {} : { timeoutMs: this.#options.threadContextTimeoutMs };
		const sources = new Map<ChatPlatform, ThreadSource>();
		for (const binding of this.#options.channels) {
			const replies = binding.readThread;
			if (replies === undefined) continue;
			const platform = binding.port.platform;
			sources.set(platform, {
				...timeout,
				botUserId: () => this.#adapters.get(platform)?.botUserId,
				replies,
				mentionUser: (userId) => binding.port.mentionUser(userId),
			});
		}
		return sources;
	}

	/**
	 * A peer bot has written in this origin: a child started from now on gets the reduced host tool set and is told so
	 * in its system prompt (driver factory); a child already running keeps its list, and the call-time guard of
	 * `hostToolsFor` reads this at every call. Judged from the ledger, not memory, so it survives a restart.
	 */
	peerTouched(originKey: string): boolean {
		return this.#store?.originHasPeerInbound(originKey) === true;
	}

	/**
	 * Where a lane asked for from `originKey` opens: its own conversation (`channel`), except that a Discord DM, which
	 * has no threads, opens it in `channels.discord.laneChannelId`; `undefined` when there is none.
	 */
	#laneChannelOf(originKey: string, channel: string | undefined): string | undefined {
		const ref = parseChatOrigin(originKey);
		return ref?.platform === "discord" && ref.kind === "dm"
			? this.#options.config.channels.discord?.laneChannelId
			: channel;
	}

	/**
	 * What the floors prompt of `originKey` must know beyond the key: a lane session's thread platform (its upload
	 * tool), whether a Discord DM is without lanes for want of `channels.discord.laneChannelId`, and the peer bots of a
	 * chat origin's platform with their mention tokens.
	 */
	floorsSurfaceFor(originKey: string): FloorsSurface {
		const lane = isLaneOrigin(originKey) ? this.#store?.getLaneByOrigin(originKey) : undefined;
		const lanePlatform = lane === undefined ? undefined : platformOfThreadRef(lane.threadRef);
		if (lanePlatform !== undefined) return { lanePlatform };
		// A persona session's monitor line quotes the bot's zone and the offset in force when it starts.
		const timezone = isPersonaOrigin(originKey)
			? {
					timezone: {
						name: this.#options.config.timezone,
						offset: offsetLabel(this.#clock.now(), this.#options.config.timezone),
					},
				}
			: {};
		const ref = parseChatOrigin(originKey);
		const noLaneChannel =
			ref?.platform === "discord" &&
			this.#lanes !== undefined &&
			isPersonaOrigin(originKey) &&
			this.#laneChannelOf(originKey, ref.conversationId) === undefined &&
			!this.peerTouched(originKey);
		// The peer bots of the conversation's platform, in that platform's mention syntax: Slack's are the top-level
		// `peerBots`, Discord's `channels.discord.peerBots`; other platforms have none.
		const { config } = this.#options;
		const peerBots =
			ref?.platform === "slack"
				? config.peerBots
				: ref?.platform === "discord"
					? config.channels.discord?.peerBots
					: undefined;
		const port = this.#options.channels.find((binding) => binding.port.platform === ref?.platform)?.port;
		const peers =
			peerBots === undefined || peerBots.length === 0 || port === undefined
				? {}
				: { peers: peerBots.map((peer) => ({ name: peer.name, mention: port.mentionUser(peer.userId) })) };
		return noLaneChannel ? { noLaneChannel, ...timezone, ...peers } : { ...timezone, ...peers };
	}

	/**
	 * Host tools for the omp child of `originKey`, fixed for the child's life. A child started after a peer bot wrote
	 * here gets the reduced set. A child started before keeps the full set (no restart, no prompt-cache rewrite), and
	 * every tool missing from the reduced set re-reads the ledger when it runs: once a peer row exists it throws
	 * instead of running. Each call runs inside the origin's mailbox: no stall alert while the child waits on the host
	 * (an approval click can take minutes), and `drain` counts it as unfinished work.
	 */
	hostToolsFor(originKey: string): HostToolDef[] {
		const reduced = this.#hostToolSet(originKey, true);
		const allowed = new Set(reduced.map((tool) => tool.name));
		const tools = this.peerTouched(originKey)
			? reduced
			: this.#hostToolSet(originKey, false).map((tool) =>
					allowed.has(tool.name) ? tool : this.#peerGuarded(originKey, tool),
				);
		return tools.map((tool) => ({
			...tool,
			execute: (params, context) => {
				const mailbox = this.#router?.mailbox(originKey);
				return mailbox ? mailbox.trackHostTool(() => tool.execute(params, context)) : tool.execute(params, context);
			},
		}));
	}

	/** `tool` refused at call time once a peer bot has written in `originKey`; the ledger is read at every call. */
	#peerGuarded(originKey: string, tool: HostToolDef): HostToolDef {
		return {
			...tool,
			execute: async (params, context) => {
				if (this.peerTouched(originKey)) {
					this.#log.warn("host_tool_denied_peer", { origin: originKey, tool: tool.name });
					throw new Error(PEER_TOOL_DENIED);
				}
				return tool.execute(params, context);
			},
		};
	}

	/**
	 * The host tool set of `originKey` with (`peerTouched`) or without a peer bot in the conversation; `hostToolsFor`
	 * builds both from here so the guarded difference follows any tool added later.
	 */
	#hostToolSet(originKey: string, peerTouched: boolean): HostToolDef[] {
		const { config } = this.#options;
		const lane = isLaneOrigin(originKey) ? this.#store?.getLaneByOrigin(originKey) : undefined;
		const chatOrigin = parseChatOrigin(originKey);
		const channel = lane ? parseThreadRef(lane.threadRef)?.channel : chatOrigin?.conversationId;
		// With a peer bot in the conversation only file upload, approval and dispatch remain (no lane or monitor
		// tools); dispatch there asks the owner only for a high_risk brief, like anywhere else.
		// The Graph chat tools read other people's conversations: the owner's own Teams 1:1 only, never with a peer
		// bot in it (the ledger's alias row must say a 1:1 the owner wrote in).
		const teamsGraph =
			this.#teamsGraph !== undefined &&
			chatOrigin?.platform === "teams" &&
			chatOrigin.kind === "dm" &&
			!peerTouched &&
			this.#store?.isTeamsOwnerDm(chatOrigin.conversationId) === true
				? this.#teamsGraph
				: undefined;
		const base = buildHostTools({
			originKey,
			channels: this.#channels,
			broker: this.#approval,
			log: this.#log,
			homeDir: config.homeDir,
			workspaceDir: config.workspaceDir,
			...(chatOrigin !== undefined ? { ompExecutable: config.ompExecutable } : {}),
			...(config.ompProfile === undefined ? {} : { ompProfile: config.ompProfile }),
			...(channel === undefined ? {} : { channel }),
			...(config.dispatchHosts === undefined ? {} : { dispatchHosts: config.dispatchHosts }),
			...(config.workerOmpArgs === undefined ? {} : { workerOmpArgs: config.workerOmpArgs }),
			...(config.herdrBoard === undefined ? {} : { herdrBoard: config.herdrBoard }),
			...(config.herdr === undefined ? {} : { herdr: config.herdr }),
			...(teamsGraph === undefined ? {} : { teamsGraph }),
			frozen: this.#frozen,
			...(this.#store === undefined
				? {}
				: {
						tasks: {
							ledger: this.#store.tasks,
							threadRef: () =>
								this.#router?.mailbox(originKey).state.threadRef ?? this.#store?.latestInboundThread(originKey),
							rootText: (threadRef: string) => this.#store?.getInbound(threadRef)?.textRef,
							channels: this.#channels,
							now: () => this.#clock.now(),
							timezone: config.timezone,
						},
						recordPrompt: (input: HerdrPromptInput) => this.#store?.recordHerdrPrompt(input),
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
					timezone: config.timezone,
					slackOff: config.channels.slack === undefined,
					now: () => this.#clock.now(),
					log: this.#log,
				})
			: [];
		// Slack and Discord conversations get monitors (and lanes where a lane can open); another platform's the base set.
		const otherPlatform =
			chatOrigin !== undefined && chatOrigin.platform !== "slack" && chatOrigin.platform !== "discord";
		const laneChannel = this.#laneChannelOf(originKey, channel);
		// The lane board: lane sessions and Slack/Discord conversations (doc/plans/lane-board.md).
		const boardTools = store && (lane || chatOrigin) ? buildBoardTools(store, originKey) : [];
		return peerTouched || otherPlatform
			? base
			: !lanes
				? [...base, ...monitorTools, ...boardTools]
				: lane
					? [...base, ...buildLaneTools(lanes, originKey), ...boardTools]
					: channel === undefined
						? base
						: laneChannel === undefined
							? [...base, ...monitorTools, ...boardTools]
							: [...base, buildWorkStartTool(lanes, laneChannel), ...monitorTools, ...boardTools];
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
		const channel = lane ? parseThreadRef(lane.threadRef)?.channel : parseChatOrigin(originKey)?.conversationId;
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

	/**
	 * Owner answers to the omp child's dialogs (select/confirm/input/editor/ask) as choice cards in the thread of the
	 * origin's running turn. Undefined when the origin has no Slack channel (monitors) — the driver then cancels them.
	 */
	answerDialogsFor(originKey: string): OmpDialogAnswerer | undefined {
		const lane = isLaneOrigin(originKey) ? this.#store?.getLaneByOrigin(originKey) : undefined;
		const channel = lane ? parseThreadRef(lane.threadRef)?.channel : parseChatOrigin(originKey)?.conversationId;
		if (channel === undefined) return undefined;
		return (request, signal) => {
			const threadTs = this.#uploadThreadTs(originKey, lane?.threadRef);
			const ask = () =>
				answerDialogOnSlack(
					this.#approval,
					{ originKey, channel, ...(threadTs === undefined ? {} : { threadTs }) },
					request,
					signal,
				);
			// Like host tools: the owner can take minutes, so stall alerts rest and `drain` counts the wait.
			const mailbox = this.#router?.mailbox(originKey);
			return mailbox ? mailbox.trackHostTool(ask) : ask();
		};
	}

	/** Working directory of the omp child: the project of a work lane, the bot workspace otherwise. */
	cwdFor(originKey: string): string {
		const lane = isLaneOrigin(originKey) ? this.#store?.getLaneByOrigin(originKey) : undefined;
		if (lane === undefined) return this.#options.config.workspaceDir;
		if (existsSync(lane.cwd)) return lane.cwd;
		// An open lane without its worktree was damaged by hand: running in the live checkout instead would let the
		// lane change the owner's working copy, so the child is refused.
		if (lane.status !== "closed") throw new Error(`lane_worktree_missing: ${lane.name} ${lane.cwd}`);
		// A landed or discarded lane has no worktree any more: its session answers later questions from the
		// repository it was merged into.
		return lane.meta.repo ?? this.#options.config.workspaceDir;
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
			config.channels.slack?.ownerUserId,
			{ slack: config.logChannel, discord: config.channels.discord?.logChannelId },
			config.timezone,
		);
		store.setPeerCallPolicy(peerCallPolicyOf(config));
		this.#store = store;
		this.#broker = new ApprovalBroker({
			channels: this.#channels,
			ownerUserId: primaryOwnerUserId(config.channels),
			platformOwners: {
				...(config.channels.slack === undefined ? {} : { slack: config.channels.slack.ownerUserId }),
				...(config.channels.discord === undefined ? {} : { discord: config.channels.discord.ownerUserId }),
				...(config.channels.teams === undefined ? {} : { teams: config.channels.teams.ownerAadObjectId }),
			},
			escalationChannel: { slack: config.escalationChannel, discord: config.channels.discord?.escalationChannelId },
			log,
			store,
			clock: this.#clock,
			timezone: config.timezone,
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
		for (const key of config.deprecated ?? []) log.warn("config_deprecated_key", { key, use: DEPRECATED_KEYS[key] });
		for (const { field, reason } of config.warnings ?? []) log.warn("config_warning", { field, reason });
		this.#bootBackup();

		// Rule (2): settle dispatched rows of the dead process before any new child is started.
		const recovered = await recoverDispatched({
			store,
			log,
			driverFactory: (origin, dir) => this.#makeDriver(origin, dir),
			homeDir: config.homeDir,
			now: () => this.#clock.now(),
			lockRepos: (originKey) => {
				const repos = [...(config.turnSnapshot?.repos ?? [])];
				try {
					repos.push(this.cwdFor(originKey));
				} catch {
					// an open lane without its worktree: nothing there to hold a lock
				}
				return repos;
			},
		});
		log.info("recovery_done", {
			answered: recovered.answered,
			interrupted: recovered.interrupted,
			continued: recovered.continued,
		});

		const sessionsRoot = join(config.homeDir, "sessions");
		mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 });
		const restart = new RestartLauncher({
			homeDir: config.homeDir,
			// The checkout holding this file (src/daemon/daemon.ts → repo root): the one the daemon runs and apply loads.
			repoDir: resolve(import.meta.dir, "..", ".."),
			pathEnv: applyPathEnv(process.env),
			// As `apply --detach`: a daemon under a non-default home hands it to the unit.
			...(process.env.OMPBOT_HOME === undefined ? {} : { homeEnv: config.homeDir }),
			run: spawnRunner,
			isAlive: this.#options.pidAlive ?? pidAlive,
			isExecutable: isExecutableFile,
			now: () => this.#clock.now(),
			turnsRunning: () => (this.#router?.busyTurns() ?? 0) > 0,
			log,
			...this.#options.restart,
		});
		this.#router = new OriginRouter({
			store,
			clock: this.#clock,
			timezone: config.timezone,
			log,
			sessionsRoot,
			sessionBackupsRoot: join(config.homeDir, "session-backups"),
			statusProvider: (originKey) => this.#statusText(originKey),
			usageProvider: async (originKey) => {
				const agent = this.#options.config.agent;
				if (agent === "claude" || agent === "agy") return `${agent} 세션은 집계하지 않습니다`;
				const sessionDir = store.getOrigin(originKey)?.sessionDir ?? sessionDirFor(sessionsRoot, originKey, 1);
				const [conversation, overall] = await Promise.all([
					summarizeSessionFiles(conversationSessionFiles(dirname(sessionDir))),
					summarizeSessionFiles(allSessionFiles(sessionsRoot)),
				]);
				return renderUsage(conversation, overall);
			},
			// Read on every turn: a reload replaces this.#options.config, a captured local config would not follow it.
			recallEnabled: () => this.#options.config.recallEnabled !== false,
			// Same test as the driver factory (run.ts): only an omp child gets the host tools.
			hostTools: () => this.#options.config.agent !== "agy" && this.#options.config.agent !== "claude",
			// Only where the board tools are (`#hostToolSet`): an omp child of a lane or a Slack/Discord conversation
			// without a peer bot in it.
			boardNotice: (originKey) =>
				this.#options.config.agent === "agy" || this.#options.config.agent === "claude" || this.peerTouched(originKey)
					? undefined
					: boardNoticeFor(store, originKey),
			costCap: () => this.#options.config.costCap,
			budgetProvider: (arg) => this.#budgetCommand(arg),
			briefingProvider: (originKey, threadRef) => this.#brief(originKey, threadRef),
			restartProvider: (originKey, threadRef) => restart.request(originKey, threadRef),
			distillProvider: (originKey) => this.#distill(originKey),
			// Read on every turn and every `!undo`: a reload changes the repository list without a restart. The real git
			// runs here: no `run` is passed, so the daemon never gains a test seam in production.
			turnUndo: {
				repos: () => this.#options.config.turnSnapshot?.repos ?? [],
				approve: (info) => this.#undoApproval(info.summary, info.threadRef, info.originKey),
			},
			threadSource: this.#threadSources(),
			idleStopMs: config.idleTimeoutMinutes === undefined ? undefined : config.idleTimeoutMinutes * 60_000,
			...(config.model === undefined ? {} : { defaultModel: config.model }),
			onStall: (info) => void this.#adapterOfThread(info.threadRef)?.setStalled(info.threadRef, info.stalled),
			onProgress: ({ threadRef, progress }) =>
				void this.#adapterOfThread(threadRef)?.setProgress(threadRef, {
					...progress,
					recentTools: progress.recentTools.map((tool) => redact(tool)),
					...(progress.todo?.current === undefined
						? {}
						: { todo: { ...progress.todo, current: redact(progress.todo.current) } }),
				}),
			onEscalate: (info) => this.#escalateTurnFailures(info),
			onProviderLimit: (info) => this.#notifyProviderLimit(info),
			onCacheMiss: (info) => this.#postThreadNotices([info.threadRef], formatCacheMissNotice(info)),
			onColdCache: (info) => this.#postThreadNotices([info.threadRef], formatColdCacheNotice(info)),
			onSessionMismatch: (info) => this.#postThreadNotices([info.threadRef], formatSessionMismatchNotice(info)),
			// A monitor's failed turn already retries with backoff through its own failure path: no thread post.
			onStuckLoop: (info) => {
				if (info.originKey.startsWith(MONITOR_ORIGIN_PREFIX)) return;
				this.#postThreadNotices([info.threadRef], redact(stuckStopText(info.toolName, info.count)));
			},
			// The registry row is the single source of a lane's hold: a paused lane's mailbox dispatches nothing; nor
			// does one whose worktree the core is rebasing (a not-ff landing).
			isHeld: (originKey) =>
				this.#store?.getLaneByOrigin(originKey)?.status === "paused" || this.#lanes?.isCoreRebasing(originKey) === true,
			isAttached: (originKey) => this.#store?.getLaneByOrigin(originKey)?.meta.attach !== undefined,
			onHeldWork: (info) => this.#lanes?.onHeldWork(info.originKey),
			// A new lane session starts with its acceptance criteria as omp todos; a lane turn's end may nudge it.
			initialTodos: (originKey) => (isLaneOrigin(originKey) ? this.#lanes?.initialTodos(originKey) : undefined),
			onTurnSettled: (info) => {
				if (isLaneOrigin(info.originKey)) this.#lanes?.onTurnSettled(info);
			},
			onStallEscalate: (info) => {
				const owner = this.#ownerTarget("stall");
				void owner?.adapter.postNotice(owner.channel, formatStallNotice(info));
			},
			dialogs: {
				open: (originKey) => this.#approval.openDialogs(originKey),
				answer: (originKey, text) => this.#approval.answerDialog(originKey, text),
				ambiguous: (info) => this.#postThreadNotices([info.threadRef], DIALOG_AMBIGUOUS_NOTICE),
			},
			driverFactory: (origin, dir) => this.#makeDriver(origin, dir),
		});
		this.#lanes = new LaneManager({
			store,
			channels: this.#channels,
			clock: this.#clock,
			timezone: config.timezone,
			log,
			sessionsRoot,
			route: (record) => this.#router?.route(record) ?? Promise.resolve(),
			stopWhenIdle: (originKey) => this.#router?.mailbox(originKey).stopWhenIdle() ?? Promise.resolve(),
			pauseTurn: (originKey) =>
				this.#router?.mailbox(originKey).pauseTurn() ?? Promise.resolve({ busy: false, settled: true }),
			resumePending: (originKey) => this.#router?.mailbox(originKey).resumePending() ?? Promise.resolve(),
			sessionDirFor: (originKey) => sessionDirFor(sessionsRoot, originKey, 1),
			session: this.#router.sessionOps(),
			...(this.#options.pidAlive === undefined ? {} : { pidAlive: this.#options.pidAlive }),
			frozen: this.#frozen,
			approvals: { request: (channel, summary) => this.#approval.request(channel, summary) },
			// taskAutoLand is a live setting: `ompbot reload` turns lane auto-merge on or off for the next close.
			autoLandPolicy: () => this.#autoLandPolicy(),
			// An apply that reverted the code holds auto-merge until the next ok apply (`<home>/autoland.hold`).
			autoLandHold: () => readAutoLandHold(config.homeDir),
			// Cards mention the owner on the platform of the lane's thread.
			ownerUserId: (platform) =>
				platform === "discord" ? config.channels.discord?.ownerUserId : config.channels.slack?.ownerUserId,
			laneBusy: (originKey) => this.#router?.mailbox(originKey).state.busy ?? false,
			// A live setting: `ompbot reload` changes it for the next lane turn end.
			completionNudges: () => this.#options.config.lanes?.completionNudges ?? DEFAULT_COMPLETION_NUDGES,
			laneModels: () => this.#options.config.lanes?.models,
			// The independent review before a lane's auto-merge: a one-shot `omp -p` under the same safety floors.
			reviewer: {
				ompBin: config.ompExecutable,
				...(config.ompProfile === undefined ? {} : { ompProfile: config.ompProfile }),
				systemPromptAppendix: buildFloorsPrompt(
					join(config.homeDir, "secrets"),
					undefined,
					false,
					false,
					false,
					{},
					false,
				),
				reviewsDir: join(config.homeDir, "reviews"),
				...(this.#options.laneReviewRun === undefined ? {} : { run: this.#options.laneReviewRun }),
			},
			...(this.#options.maxLanes === undefined ? {} : { maxLanes: this.#options.maxLanes }),
			...(this.#options.verifyClaim === undefined ? {} : { verify: this.#options.verifyClaim }),
			...(this.#options.landLane === undefined ? {} : { land: this.#options.landLane }),
		});
		this.#monitors = new MonitorScheduler({
			store,
			router: this.#router,
			clock: this.#clock,
			log,
			scriptsRoot: join(config.homeDir, "scripts"),
			workspaceDir: config.workspaceDir,
			homeDir: config.homeDir,
			watcherRoots: config.watcherRoots,
			frozen: this.#frozen,
			budgetExceeded: () => {
				const state = this.#dailyBudget();
				return state === undefined ? undefined : budgetBreach(state);
			},
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
				// `머지해`/`폐기해` (the whole message, while the landing waits) are the card's buttons in words.
				const closedAs =
					lane?.status === "closed" ? classifyClosedLaneMessage(message.text, lane.meta.land?.state) : undefined;
				const question = closedAs === "question";
				const { inserted, row } = store.recordInbound({
					originKey,
					platformMessageId: message.platformMessageId,
					textRef: question ? buildClosedLaneQuestion(message.text) : message.text,
					threadRef: message.threadRef,
				});
				if (!inserted) return { duplicate: true };
				// An owner message lets a peer-capped thread continue: the cap counts peer rows after this moment.
				if (store.countPeerInboundSince(message.threadRef, 0) > 0) {
					store.setCursor(`${PEER_HOP_RESET_CURSOR}${message.threadRef}`, String(this.#clock.now()));
				}
				if (parseCommand(message.text)?.kind === "restart") {
					// Ahead of every lane, task and drain branch: the mailbox answers `!restart` at once, mid-drain too (held
					// for the next process it would restart again), without a turn or a driver.
					this.#dispatchPending(originKey);
					return {};
				}
				if (lane) {
					// `멈춰`/`계속` (the whole message) are the lane's hold and release: the core settles them itself,
					// before any closed-lane reading — a closed lane's pause holds only its auto-merge.
					const control = classifyLaneControl(message.text);
					if (control !== undefined) {
						void this.#settleLaneControl(row, lane.name, control);
						return {};
					}
					if (lane.status === "paused") this.#heldLaneNotice(lane);
					// The core settles these itself; they never reach the lane's omp session.
					const refusal = closedAs === "reopen" ? this.#lanes?.reopenRefusal(lane) : undefined;
					if (closedAs === "land" || closedAs === "discard") {
						void this.#settleLaneCommand(row, lane.name, { kind: closedAs });
						return {};
					}
					if (refusal !== undefined) {
						void this.#settleLaneCommand(row, lane.name, { kind: "refused", text: refusal });
						return {};
					}
					this.#lanes?.onOwnerMessage(lane, message.text);
				} else {
					// `멈춰`/`계속` (the whole message) in a [TASK] thread hold or release that thread's one active task; the
					// core settles it like a lane control. A thread without an active task keeps the message as it is.
					const control = store.tasks.isTaskRoot(message.threadRef) ? classifyLaneControl(message.text) : undefined;
					if (control !== undefined && this.#activeTasksOf(message.threadRef).length > 0) {
						void this.#settleTaskControl(row, control);
						return {};
					}
					const trigger = parseLaneTrigger(message.text);
					if (trigger && this.#router?.draining === true) {
						// A drain must not create a worktree and branch mid-restart, and a pending trigger row would reach
						// the DM's omp session after it instead of starting the lane: refuse it with a retry hint.
						void this.#settleLaneCommand(row, trigger.title, { kind: "refused", text: LANE_DRAIN_REFUSED_TEXT });
						return {};
					}
					if (trigger) {
						void this.#startLane(row, trigger);
						return {};
					}
				}
				if (this.#router?.draining === true) {
					// Restart drain: the row stays pending for the next process (or the cancel) to dispatch. The owner hears
					// so once per thread, or a held message looks ignored (independent of `restartNotice`). A slash command
					// answers with the same text itself (onCommand).
					log.info("drain_deferred", { origin: originKey, id: row.platformMessageId });
					if (!row.platformMessageId.startsWith("slash:") && !this.#drainDeferNoticed.has(message.threadRef)) {
						this.#drainDeferNoticed.add(message.threadRef);
						this.#postThreadNotices([message.threadRef], DRAIN_DEFERRED_COMMAND_TEXT);
					}
					return {};
				}
				// Recorded durably first; dispatch (which may start omp) must not delay the 👀 acknowledgement.
				this.#dispatchPending(originKey);
				return {};
			},
			onGuestInbound: (message) => this.#onGuestInbound(message),
			onPeerInbound: (message, hop) => {
				// Never the owner paths: no lane routing, no `!reopen`, no lane trigger, no command. A work lane's thread
				// belongs to the owner and its worker; a peer there is dropped before any row exists.
				if (store.getInbound(message.platformMessageId) !== undefined) return { duplicate: true };
				if (store.getLaneByThread(message.threadRef) !== undefined) return { dropped: "peer_in_lane_thread" };
				const resetAt = store.getCursor(`${PEER_HOP_RESET_CURSOR}${message.threadRef}`);
				const since = Math.max(this.#clock.now() - hop.windowMs, resetAt === undefined ? 0 : Number(resetAt) + 1);
				if (store.countPeerInboundSince(message.threadRef, since) >= hop.turns) {
					// One notice per cap episode: the marker is the owner-reset moment it was posted under.
					const marker = resetAt ?? "0";
					const noticeKey = `${PEER_HOP_NOTICE_CURSOR}${message.threadRef}`;
					const notice = store.getCursor(noticeKey) !== marker;
					if (notice) store.setCursor(noticeKey, marker);
					return { dropped: "peer_hop_cap", notice };
				}
				store.ensureOrigin(message.originKey, sessionDirFor(sessionsRoot, message.originKey, 1));
				const { inserted, row } = store.recordInbound({
					originKey: message.originKey,
					platformMessageId: message.platformMessageId,
					textRef: message.text,
					threadRef: message.threadRef,
					peerUserId: message.peer.userId,
				});
				if (!inserted) return { duplicate: true };
				if (this.#router?.draining === true) {
					log.info("drain_deferred", { origin: message.originKey, id: row.platformMessageId });
					return {};
				}
				this.#dispatchPending(message.originKey);
				return {};
			},
			onPeerSeen: (seen) => void store.notePeerSeen(seen),
			onCommand: ({ command, arg, originKey, channel }) => {
				if (command === "status") return this.#statusText(originKey);
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
				// A drain holds the recorded command for the next process; say so, or the owner sees nothing and retypes it.
				// `!restart` is never held: its answer is already on the ledger.
				return this.#router?.draining === true && command !== "restart" ? DRAIN_DEFERRED_COMMAND_TEXT : undefined;
			},
			knowsThread: (threadRef) => store.getLaneByThread(threadRef) !== undefined || store.hasInboundThread(threadRef),
			isDraining: () => this.#router?.draining === true,
			// The thread of an approval card is `<card channel>:<card ts>` — the ledger's approval id.
			onCardReply: ({ threadRef, platformMessageId, text, injected }) => {
				const ts = parseThreadRef(platformMessageId)?.threadTs ?? platformMessageId;
				return this.#approval.handleCardReply({ approvalId: threadRef, ts, text, injected });
			},
			onAction: ({ actionId, value, userId, channel, messageTs }) => {
				if (this.#approval.handleAction({ actionId, userId })) return;
				const retry = parseApprovalRetryActionId(actionId);
				if (retry !== undefined) return this.#handleApprovalRetry(`${retry.channel}:${retry.ts}`, channel, messageTs);
				const taskId = parseTaskMergeActionId(actionId);
				if (taskId !== undefined) return this.#handleTaskMerge(taskId, channel, messageTs);
				const recommended = parseTaskRecommendActionId(actionId);
				if (recommended !== undefined) return this.#handleTaskRecommend(recommended, value, channel, messageTs);
				const laneAction = parseLaneActionId(actionId);
				if (laneAction !== undefined) return this.#handleLaneButton(laneAction, channel, messageTs);
				log.info("action_ignored", { action: actionId, user: userId });
			},
		};
		// Each adapter takes only the deliveries whose thread ref is an id of its own platform.
		const itemOf = (row: DeliveryRow): DeliveryItem => ({
			deliveryId: row.deliveryId,
			originKey: row.originKey,
			threadRef: row.threadRef,
			body: row.body,
			redelivered: row.redelivered,
			finishThreadRefs: store.threadsOfOp(row.originKey, row.opRef),
			// A `queue drop` and a `!stop` re-link their targets (the dropped row; the waiting rows and the stopped
			// turn's rows) to the command op: those threads end 🚫 취소됨, a `/new` keeps finishing its casualties ✅ 완료.
			cancelThreadRefs:
				row.opRef.startsWith("queue:") || row.opRef.startsWith("stop:")
					? store.discardedThreadsOfOp(row.originKey, row.opRef)
					: undefined,
			// A lane's own reports (no owner message behind them) must not stamp ✅ on its thread root, nor may a
			// `!restart` answer or an apply `notify` line (side posts in a thread whose turn may still run).
			finishUntracked:
				!isLaneOrigin(row.originKey) &&
				!row.originKey.startsWith(MONITOR_ORIGIN_PREFIX) &&
				!row.opRef.endsWith(LOG_COPY_SUFFIX) &&
				!isSideOpRef(row.opRef),
			// Sent while its turn runs: the thread's ⏳ status and progress go on until the turn-end delivery. A peer
			// silence alert, a `!restart` answer and an apply `notify` line answer no turn, so they never finish the
			// thread's status either.
			keepStatus:
				row.opRef.includes(INTERIM_INFIX) || row.opRef.startsWith(PEER_SILENCE_OP_PREFIX) || isSideOpRef(row.opRef),
			sentParts: row.sentParts,
			replyTs: row.replyTs,
		});
		const deliveriesOf = (platform: ChatPlatform): DeliverySource => ({
			claimDue: () => store.claimDue(undefined, platform).map(itemOf),
			takeExpired: () => store.takeExpired(platform).map(itemOf),
			confirm: (deliveryId) => {
				crash("after_post_before_confirm");
				store.confirmDelivery(deliveryId);
			},
			fail: (deliveryId, error, outcome) => {
				if (outcome === "ambiguous") {
					store.markAmbiguous(deliveryId, error);
					return true;
				}
				return store.failDelivery(deliveryId, error).state === "expired";
			},
			defer: (deliveryId, error, retry) => void store.deferDelivery(deliveryId, error, retry),
		});
		for (const binding of this.#options.channels) {
			const platform = binding.port.platform;
			const adapter = binding.createAdapter({
				core,
				deliveries: deliveriesOf(platform),
				clock: this.#clock,
				log,
				config,
				store,
			});
			this.#adapters.set(platform, adapter);
		}
		for (const adapter of this.#adapters.values()) await adapter.start();
		this.#announceMarker("back");

		// A waiting click cannot outlive the process: expire every pending card and say so on them.
		void this.#broker.expireStale(false).catch((error) => log.warn("approval_expire_failed", { error: String(error) }));

		// Missed messages since the last run: one recovery pass per platform now (each reconnect runs another).
		for (const adapter of this.#adapters.values()) adapter.recover();
		// A peer answer posted while the daemon was down comes back with that pass (`onPeerSeen`): the silence sweep
		// waits for it, or it would alert a call already answered.
		void (this.#adapters.get("discord")?.recoveryIdle?.() ?? Promise.resolve()).then(() => {
			this.#peerSilenceArmed = true;
			log.info("peer_silence_armed");
		});

		const herdrRun = this.#options.herdrRun;
		setLocalHerdrBin(config.herdr?.bin);
		if (config.herdr === undefined) {
			// herdr off: no sweeper, so [TASK] rows are never read or reminded. Say so once and leave the rows alone.
			const orphaned = store.tasks.listActive().length;
			if (orphaned > 0) log.warn("tasks_orphaned", { count: orphaned });
		} else {
			this.#herdrHealth = new HerdrHealthProbe({
				homeDir: config.homeDir,
				bin: config.herdr.bin ?? "herdr",
				run: herdrRun ?? realProcessRunner,
				now: () => this.#clock.now(),
			});
			this.#taskSweeper = new TaskSweeper({
				ledger: store.tasks,
				// dispatchHosts is a reloadable field: read the live config, not the boot snapshot.
				frozen: this.#frozen,
				evaluate: (row, checks) =>
					evaluateTask(row, resolveTaskHost(row.host, this.#options.config.dispatchHosts), checks),
				remind: async (row, text) => {
					const entry = row.host === null ? undefined : this.#options.config.dispatchHosts?.[row.host];
					const sent = await herdrPromptExisting(row.agent, text, {
						cwd: config.workspaceDir,
						...(entry === undefined ? {} : { sshTarget: entry.ssh }),
						...(entry?.herdrBin === undefined ? {} : { herdrBin: entry.herdrBin }),
						...(herdrRun === undefined ? {} : { run: herdrRun }),
					});
					if (sent.ok || sent.unconfirmed === true) {
						notePrompt(
							{ recordPrompt: (input) => store.recordHerdrPrompt(input), log },
							{ host: row.host, agent: row.agent, kind: "remind", text, originKey: row.originKey },
						);
					}
					return sent;
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
				readAgent: (row) => {
					const entry = row.host === null ? undefined : this.#options.config.dispatchHosts?.[row.host];
					return herdrReadAgent(row.agent, {
						cwd: config.workspaceDir,
						...(entry === undefined ? {} : { sshTarget: entry.ssh }),
						...(entry?.herdrBin === undefined ? {} : { herdrBin: entry.herdrBin }),
						...(herdrRun === undefined ? {} : { run: herdrRun }),
					});
				},
				lastAnswer: async (row, sessionPath) => {
					if (row.host === null) {
						const found = readLastAssistant(sessionPath);
						return found === undefined ? undefined : lastAnswerOf(found);
					}
					const entry = this.#options.config.dispatchHosts?.[row.host];
					if (entry === undefined) throw new Error(`dispatchHosts has no ${row.host}`);
					const found = await readRemoteLastAssistant(entry.ssh, sessionPath, herdrRun ?? realProcessRunner);
					return found === undefined ? undefined : lastAnswerOf(found);
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
				// taskAutoLand is live as well: `ompbot reload` turns auto-merge on or off for the next reach.
				autoLandPolicy: () => this.#autoLandPolicy(),
				repoMatches: (row, repos) => this.repoMatches(row, repos),
				changedPaths: async (row) => {
					const changed = await taskChangedPaths(row.worktree, realProcessRunner);
					if (changed.ok) return changed.paths;
					const key = `${row.taskId}:${changed.reason}`;
					if (!this.#overlapSkipped.has(key)) {
						this.#overlapSkipped.add(key);
						log.info("task_overlap_skipped", { task: row.taskId, reason: changed.reason });
					}
					return undefined;
				},
				autoLand: (row) => this.autoLand(row),
				autoLandHold: () => readAutoLandHold(config.homeDir),
				channels: this.#channels,
				ownerUserId: primaryOwnerUserId(config.channels),
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
		log.info("daemon_ready", {
			socket: this.socketPath,
			driver: config.agent ?? "omp",
			herdr: config.herdr === undefined ? "off" : "on",
			slack: this.#adapters.has("slack") ? "on" : "off",
			discord: this.#adapters.has("discord") ? "on" : "off",
			teams: this.#adapters.has("teams") ? "on" : "off",
		});
		if (bootConfigText === undefined) log.warn("last_good_config_skipped", { reason: "config_unreadable" });
		else if (readConfigText(config.homeDir) === bootConfigText)
			recordLastGoodConfig(config.homeDir, (error) => log.warn("last_good_config_failed", { error }), bootConfigText);
		else log.warn("last_good_config_skipped", { reason: "config_changed_since_boot" });
	}

	/**
	 * `작업: <제목> @<경로>`: the message is settled with its own answer (the lane's thread is the real output), never
	 * sent to the DM conversation's omp session.
	 */
	async #startLane(row: InboundRow, trigger: LaneTrigger): Promise<void> {
		const store = this.store;
		const opRef = `lane:${row.platformMessageId}`;
		store.markDispatched(row.platformMessageId, { opRef, entryCursor: null });
		const channel = this.#laneChannelOf(row.originKey, parseThreadRef(row.threadRef)?.channel);
		let reply: string;
		try {
			if (channel === undefined && parseChatOrigin(row.originKey)?.platform === "discord") {
				throw new LaneInputError(DISCORD_LANE_CHANNEL_MISSING);
			}
			if (!this.#lanes || channel === undefined) throw new Error("lanes unavailable");
			const lane = await this.#lanes.start({ ...trigger, channel });
			const link = await this.#lanes.threadLink(lane);
			reply =
				link === undefined
					? `🔄 작업 레인 \`${lane.name}\`을 시작했습니다. 새 스레드에서 진행 상황을 확인하세요.`
					: `🔄 작업 레인 \`${lane.name}\`을 시작했습니다. 레인 스레드에서 진행 상황을 확인하세요: ${link}`;
			if (lane.startNote !== undefined) reply += `\n${lane.startNote}`;
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

	/**
	 * `머지해` / `폐기해` in a closed lane's thread (or a `!reopen` the lane cannot take: `refusal`): settled with the
	 * core's own answer like a lane start — the lane's omp session never sees it. The answer is recorded once the
	 * landing ended; a landing cut off by a restart is finished by the lane tick and shown on the lane's card.
	 */
	async #settleLaneCommand(
		row: InboundRow,
		name: string,
		command: { kind: "land" | "discard" } | { kind: "refused"; text: string },
	): Promise<void> {
		const store = this.store;
		const opRef = `lane:${row.platformMessageId}`;
		store.markDispatched(row.platformMessageId, { opRef, entryCursor: null });
		let reply: string;
		try {
			const lanes = this.#lanes;
			if (!lanes) throw new Error("lanes unavailable");
			if (command.kind === "refused") reply = `⚠️ ${command.text}`;
			else reply = (command.kind === "land" ? await lanes.requestLand(name, "owner") : await lanes.discard(name)).text;
		} catch (error) {
			this.#log.error("lane_command_failed", { lane: name, command: command.kind, error: String(error) });
			reply = "⚠️ 처리하지 못했습니다. 로그를 확인하세요.";
		}
		store.recordAnswer({ originKey: row.originKey, opRef, threadRef: row.threadRef, parts: [reply] });
	}

	/**
	 * `멈춰` / `계속` in a lane's thread (the whole message, judged by `classifyLaneControl`): settled with the
	 * core's own answer like a lane start — the lane's omp session never sees it. The answer is whatever the
	 * manager re-read after stopping (or resuming) the lane.
	 */
	async #settleLaneControl(row: InboundRow, name: string, control: "pause" | "resume"): Promise<void> {
		const store = this.store;
		const opRef = `lane:${row.platformMessageId}`;
		store.markDispatched(row.platformMessageId, { opRef, entryCursor: null });
		let reply: string;
		try {
			const lanes = this.#lanes;
			if (!lanes) throw new Error("lanes unavailable");
			const outcome =
				control === "pause" ? await lanes.pause(name, "owner-message") : await lanes.resume(name, "owner-message");
			reply = outcome.text;
		} catch (error) {
			this.#log.error("lane_control_failed", { lane: name, control, error: String(error) });
			reply = "⚠️ 처리하지 못했습니다. 로그를 확인하세요.";
		}
		store.recordAnswer({ originKey: row.originKey, opRef, threadRef: row.threadRef, parts: [reply] });
	}

	/** A thread's working or blocked [TASK]s: the ones a `멈춰`/`계속` there can act on. */
	#activeTasksOf(threadRef: string): TaskRow[] {
		return this.store.tasks
			.getByThread(threadRef)
			.filter((task) => task.status === "working" || task.status === "blocked");
	}

	/**
	 * `멈춰`/`계속` in a [TASK] thread: settled with the core's own answer (`task:` op ref), never sent to omp. With
	 * more than one active task in the thread nothing is applied and the answer lists their ids.
	 */
	async #settleTaskControl(row: InboundRow, control: "pause" | "resume"): Promise<void> {
		const store = this.store;
		const opRef = `task:${row.platformMessageId}`;
		store.markDispatched(row.platformMessageId, { opRef, entryCursor: null });
		let reply: string;
		try {
			const active = this.#activeTasksOf(row.threadRef);
			const only = active.length === 1 ? active[0] : undefined;
			reply =
				only === undefined
					? `이 스레드에 활성 TASK가 여럿입니다(${active.map((task) => task.taskId).join(", ")}) — 아무것도 ${control === "pause" ? "멈추지" : "재개하지"} 않았습니다. \`ompbot tasks ${control} <id>\`로 하나를 고르세요.`
					: (await this.controlTask(only.taskId, control)).text;
		} catch (error) {
			this.#log.error("task_control_failed", { thread: row.threadRef, control, error: String(error) });
			reply = "⚠️ 처리하지 못했습니다. 로그를 확인하세요.";
		}
		store.recordAnswer({ originKey: row.originKey, opRef, threadRef: row.threadRef, parts: [reply] });
	}

	/**
	 * Owner pause/resume of one [TASK] (thread phrase or `ompbot tasks pause|resume`). A pause marks the ledger first
	 * (the sweep holds its prompts, stale notice and auto-merge from then on), then sends the worker an Esc and reports
	 * only what herdr re-read. A resume lifts the sweep hold only; it never prompts the worker. `ok: false` = nothing
	 * was applied.
	 */
	async controlTask(taskId: string, control: "pause" | "resume"): Promise<{ ok: boolean; text: string }> {
		const tasks = this.store.tasks;
		const row = tasks.get(taskId);
		if (row === undefined) return { ok: false, text: `TASK를 찾지 못했습니다: ${taskId}` };
		if (control === "resume") {
			if (!tasks.isPaused(row)) return { ok: true, text: `${taskId}는 멈춘 상태가 아닙니다.` };
			const after = tasks.unpauseTask(taskId);
			if (tasks.isPaused(after)) return { ok: false, text: `⚠️ ${taskId} 재개를 확인하지 못했습니다.` };
			this.#log.info("task_resumed", { task: taskId });
			return {
				ok: true,
				text: `▶ ${taskId} 재개했습니다 — 스윕 재촉·stale 알림·자동 머지 보류를 풀었습니다. 워커에 재개 프롬프트는 보내지 않았습니다(필요하면 ompbot_dispatch로 보냅니다).`,
			};
		}
		if (row.status !== "working" && row.status !== "blocked") {
			return { ok: false, text: `${taskId}는 ${row.status} 상태라 멈추지 않았습니다(working·blocked만 멈춥니다).` };
		}
		const after = tasks.pauseTask(taskId);
		if (!tasks.isPaused(after)) return { ok: false, text: `⚠️ ${taskId} 멈춤을 기록하지 못했습니다.` };
		this.#log.info("task_paused", { task: taskId });
		let worker: string;
		let stopped = false;
		if (this.#options.config.herdr === undefined) {
			worker = "herdr가 꺼져 있어 Esc를 보내지 않았습니다";
		} else {
			const entry = row.host === null ? undefined : this.#options.config.dispatchHosts?.[row.host];
			const herdrRun = this.#options.herdrRun;
			const interrupted = await herdrInterruptAgent(row.agent, {
				cwd: this.#options.config.workspaceDir,
				...(entry === undefined ? {} : { sshTarget: entry.ssh }),
				...(entry?.herdrBin === undefined ? {} : { herdrBin: entry.herdrBin }),
				...(herdrRun === undefined ? {} : { run: herdrRun }),
			});
			this.#log.info("task_interrupt", { task: taskId, confirmed: interrupted.confirmed, status: interrupted.status });
			worker = interrupted.text;
			stopped = interrupted.confirmed;
		}
		// Only a re-read stopped worker leads with "멈췄습니다"; otherwise only the sweep hold is certain.
		const lead = stopped ? `⏸ ${taskId} 멈췄습니다` : `⚠️ ${taskId} 스윕만 멈췄습니다(워커 멈춤 미확인)`;
		return {
			ok: true,
			text: `${lead} — 스윕 재촉·stale 알림·자동 머지를 보류합니다. 워커: ${worker}. 재개는 \`계속\` 또는 \`ompbot tasks resume ${taskId}\`.`,
		};
	}

	/**
	 * One notice per pause that the held lane's thread messages wait: the row stays pending, `계속` delivers it.
	 * The key is the lane's `pausedAt`, so a restart (or a second message) stays quiet.
	 */
	#heldLaneNotice(lane: LaneRow): void {
		const store = this.store;
		// A terminal hand-over says so once per attach; a plain pause once per pause.
		const attach = lane.meta.attach;
		const key =
			attach === undefined
				? `lane_held_notice:${lane.name}:${lane.meta.pausedAt ?? 0}`
				: `lane_attach_notice:${lane.name}:${attach.at}`;
		if (store.getCursor(key) !== undefined) return;
		store.setCursor(key, String(this.#clock.now()));
		const route = this.#channels.forThreadRef(lane.threadRef);
		if (route === undefined) return;
		const text =
			attach === undefined
				? "⏸ 멈춘 상태라 전달하지 않았습니다 — `계속`이라고 쓰면 전달합니다."
				: "🖥 오너가 터미널에서 작업 중이라 전달하지 않았습니다 — 터미널 omp를 끝내면 전달합니다.";
		void route.port
			.post(route.target, { text })
			.catch((error: unknown) => this.#log.warn("lane_held_notice_failed", { lane: lane.name, error: String(error) }));
	}

	/**
	 * A `머지` / `폐기` click on a lane's Outcome card: the core lands or discards the lane and redraws the card with
	 * the result. A lane that is not waiting for it (already landed, discarded, working again, or a click while the
	 * first one still runs) takes nothing; a lane that no longer exists loses the buttons with a note.
	 */
	async #handleLaneButton(
		action: LaneAction,
		channel: string | undefined,
		messageTs: string | undefined,
	): Promise<void> {
		const { kind, name } = action;
		const lanes = this.#lanes;
		if (lanes === undefined || this.#store?.getLane(name) === undefined) {
			this.#log.info(`lane_${kind}_ignored`, { lane: name, reason: "not_found" });
			const port = channel === undefined ? undefined : this.#channels.forConversation(channel)?.port;
			if (port === undefined || channel === undefined || messageTs === undefined) return;
			await port
				.edit(
					{ platform: port.platform, conversationId: channel, messageId: messageTs },
					{ text: `⚠️ 이 레인을 찾을 수 없음 (${name})`, buttons: [] },
				)
				.catch((error: unknown) => this.#log.warn("lane_card_edit_failed", { lane: name, error: String(error) }));
			return;
		}
		const outcome =
			action.kind === "session"
				? await lanes.pickSession(name, action.index)
				: kind === "merge"
					? await lanes.requestLand(name, "owner")
					: kind === "discard"
						? await lanes.discard(name)
						: kind === "pause"
							? await lanes.pause(name, "button")
							: await lanes.resume(name, "button");
		this.#log.info(outcome.handled ? `lane_${kind}_requested` : `lane_${kind}_ignored`, { lane: name });
		if (kind === "pause" || kind === "resume" || kind === "session") {
			// The status message changes, but the owner clicked: the answer tells what was re-read.
			const lane = this.#store?.getLane(name);
			const route = lane === undefined ? undefined : this.#channels.forThreadRef(lane.threadRef);
			if (route !== undefined) {
				await route.port
					.post(route.target, { text: outcome.text })
					.catch((error: unknown) => this.#log.warn("lane_button_reply_failed", { lane: name, error: String(error) }));
			}
			return;
		}
		if (outcome.handled) return;
		// A refused click changes no card, so the owner is told why in the lane's thread (a text command gets the same).
		const lane = this.#store?.getLane(name);
		const route = lane === undefined ? undefined : this.#channels.forThreadRef(lane.threadRef);
		if (route === undefined) return;
		await route.port
			.post(route.target, { text: `⚠️ ${outcome.text}` })
			.catch((error: unknown) => this.#log.warn("lane_button_reply_failed", { lane: name, error: String(error) }));
	}

	/** `taskAutoLand` as the [TASK] sweep and the lanes apply it (`maxRisk` defaults to L2); `undefined` = off. */
	#autoLandPolicy(): AutoLandPolicy | undefined {
		const policy = this.#options.config.taskAutoLand;
		if (policy === undefined) return undefined;
		const { review } = policy;
		return {
			repos: policy.repos,
			maxRisk: policy.maxRisk ?? "L2",
			...(review === undefined
				? {}
				: {
						review: {
							model: review.model,
							timeoutMs: review.timeoutMs ?? LANE_REVIEW_TIMEOUT_MS,
							...(review.confident === undefined ? {} : { confident: review.confident }),
						},
					}),
		};
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
			// A paused lane holds its owner messages on purpose until `계속`; a retry would count the wait as a failure.
			if (store.getLaneByOrigin(originKey)?.status === "paused") continue;
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
		if (state.failures < PENDING_ALERT_AFTER) return;
		const owner = this.#ownerTarget("pending_dispatch");
		if (owner === undefined) return;
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
		void owner.adapter.postNotice(
			owner.channel,
			formatPendingDispatchNotice(originKey, now - (oldest?.createdAt ?? now), redact(sign), incident.count),
		);
	}

	/** Rule (3) plus the periodic work: deliver due rows, update status messages, stop quiet omp children. */
	pump(): Promise<void> {
		this.#pumping = this.#pumping.then(async () => {
			if (this.#stopped) return;
			// One platform's failure leaves the others' deliveries and status upkeep running.
			for (const adapter of this.#adapters.values()) {
				try {
					await adapter.pumpDeliveries();
					await adapter.tick();
				} catch (error) {
					this.#log.error("pump_failed", { platform: adapter.platform, error: String(error) });
				}
			}
		});
		return this.#pumping;
	}

	#nudgePump(): void {
		setImmediate(() => void this.pump());
	}

	/**
	 * One sweep of the interval chain; never rejects (a rejection would reach the process-level fatal handler and take
	 * every omp child down with the daemon). A step that throws ends the sweep with `sweep_failed` and skips the beat:
	 * a sweep that keeps failing then ages the stamp until `sweep_stalled` opens for `ompbot gates` outside the daemon.
	 */
	async sweep(): Promise<void> {
		try {
			await this.pump();
			this.#router?.sweepStalls();
			this.#startLaneTick();
			try {
				// A restart drain fires no monitor: due slots are claimed by the next process's catch-up.
				if (this.#router?.draining !== true) await this.#monitors?.tick();
			} catch (error) {
				this.#log.error("monitor_tick_failed", { error: String(error) });
			}
			this.#startIdleSweep();
			this.#maybeSweepTasks();
			this.#sweepPendingDispatch();
			try {
				await this.#sweepGates();
			} catch (error) {
				this.#log.error("gate_sweep_failed", { error: String(error) });
			}
			try {
				this.#sweepCostCap();
			} catch (error) {
				this.#log.warn("cost_cap_sweep_failed", { error: String(error) });
			}
			try {
				this.#sweepPeerSilence();
			} catch (error) {
				this.#log.warn("peer_silence_sweep_failed", { error: String(error) });
			}
			void this.#broker
				?.expireStale()
				.catch((error: unknown) => this.#log.warn("approval_expire_failed", { error: String(error) }));
			this.#sweepMedia();
			this.#maybeReviewSkills();
			this.#maybeProposeCandidates();
			this.#beat();
		} catch (error) {
			this.#log.error("sweep_failed", { error: String(error) });
		}
	}

	/**
	 * A lane verdict can wait on an owner approval card (30 minutes) and a mailbox idle stop queues behind its serial
	 * chain (`/compact-ompbot`, a child start): run each in the background, one at a time, so gates, approval expiry
	 * and the heartbeat keep their cadence. A tick still running when the next sweep comes is skipped, not stacked.
	 */
	#startLaneTick(): void {
		const lanes = this.#lanes;
		if (lanes === undefined || this.#laneTicking || this.#stopped) return;
		this.#laneTicking = true;
		void lanes
			.tick()
			.catch((error: unknown) => this.#log.error("lane_tick_failed", { error: String(error) }))
			.finally(() => {
				this.#laneTicking = false;
			});
	}

	#startIdleSweep(): void {
		const router = this.#router;
		if (router === undefined || this.#idleSweeping || this.#stopped) return;
		this.#idleSweeping = true;
		void router
			.sweepIdle()
			.catch((error: unknown) => this.#log.error("sweep_idle_failed", { error: String(error) }))
			.finally(() => {
				this.#idleSweeping = false;
			});
	}

	/** Records a finished sweep in the heartbeat stamp; a stale stamp opens the `sweep_stalled` gate. */
	#beat(): void {
		const heartbeat = this.#heartbeat;
		if (heartbeat === undefined) return;
		try {
			const loopMs = heartbeat.beat(this.#clock.now(), {
				socket: this.#adapters.get("slack")?.connectionState(),
				discord: this.#adapters.get("discord")?.connectionState(),
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
		if (store === undefined || info.originKey.startsWith(MONITOR_ORIGIN_PREFIX)) return;
		const owner = this.#ownerTarget("turn_failures");
		if (owner === undefined) return;
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
		void owner.adapter.postNotice(
			owner.channel,
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
		if (store === undefined) return;
		const owner = this.#ownerTarget("provider_limit");
		if (owner === undefined) return;
		const now = this.#clock.now();
		let incident = { notify: true, count: 1, firstAt: now };
		try {
			incident = store.recordAlertIncident("provider:limit", "provider-limit", now);
		} catch (error) {
			this.#log.warn("provider_limit_incident_failed", { origin: info.originKey, error: String(error) });
		}
		if (!incident.notify) return;
		this.#log.warn("provider_limit_notified", { origin: info.originKey, count: incident.count });
		void owner.adapter.postNotice(owner.channel, formatProviderLimitNotice(info, incident.count));
	}

	/**
	 * A first install has no backup stamp until somebody runs `ompbot backup`, so `backup_age` would open (and DM the
	 * owner) on the very first gate sweep. `start()` runs the same local backup once instead; a failure is logged and
	 * left to the gate, which then opens and alerts as before.
	 */
	#bootBackup(): void {
		const { homeDir, maxBundleBytes } = this.#options.config;
		if (readStamp(join(homeDir, "backups")) !== undefined) return;
		try {
			// The daemon's clock, so the gates (judged on the same clock) see a fresh stamp.
			const result = (this.#options.bootBackup ?? runBackup)({
				homeDir,
				now: new Date(this.#clock.now()),
				...(maxBundleBytes === undefined ? {} : { maxBundleBytes }),
			});
			this.#log.info("boot_backup_done", { file: result.file, bundle: result.bundle ?? "none" });
		} catch (error) {
			this.#log.warn("boot_backup_failed", { error: String(error) });
		}
	}

	/**
	 * Self-diagnosis loop: every `gateSweepMs` the daemon runs the same gate projection as `ompbot gates` and reports
	 * transitions to the owner DM. An opening gate notifies once and re-alerts daily while it stands (the same gate
	 * within 24h stays quiet), and a close after an alerted open sends the recovery notice — so a flapping gate
	 * cannot spam and a dead backup timer still reaches the only channel the owner watches. Two exceptions: the
	 * window gates (`turns_failing`, `monitors_failed`) close silently, because an aged-out window is not a fix, and
	 * `standing` incidents re-seed `alerted` after a restart, so a real recovery still reports across incarnations.
	 * After an alerted open closes (with the recovery notice, or silently for a window gate) the incident is resolved
	 * once the gate has stayed closed for `GATE_RESOLVE_CLOSED_SWEEPS` sweeps, so a later recurrence alerts again; a
	 * gate first seen closed after a restart, window gates included, resolves its leftover incident immediately.
	 */
	async #sweepGates(): Promise<void> {
		const interval = this.#options.gateSweepMs ?? DEFAULT_GATE_SWEEP_MS;
		const store = this.#store;
		if (interval <= 0 || store === undefined) return;
		const owner = this.#ownerTarget("gate_sweep");
		if (owner === undefined) return;
		const now = this.#clock.now();
		if (now - this.#lastGateSweepAt < interval) return;
		this.#lastGateSweepAt = now;
		const { config } = this.#options;
		for (const gate of collectGates({
			homeDir: config.homeDir,
			now,
			...gateOptionsFromConfig(config),
			...(this.#options.hostLoad === undefined ? {} : { hostLoad: this.#options.hostLoad }),
		})) {
			// Nothing to judge (stamp or ledger missing): keep the previous state untouched — no notice, no incident
			// write or resolve — so a stamp deleted under an open gate never reads as a recovery.
			if (gate.state === "unknown") continue;
			const previous = this.#gateStates.get(gate.name);
			try {
				if (gate.state === "open") {
					const incident = store.recordAlertIncident(`gate:${gate.name}`, "open", now);
					// `standing` rebuilds the alerted flag after a restart (the in-memory map starts empty); a quiet
					// repeat inside 24h still counts as "the owner knows".
					const alerted = incident.notify || incident.standing || (previous?.state === "open" && previous.alerted);
					if (incident.notify) {
						await owner.adapter.postNotice(owner.channel, formatGateOpenNotice(gate, incident.firstAt, now));
					}
					this.#gateStates.set(gate.name, { state: "open", alerted, closedSweeps: 0, pendingResolve: false });
				} else if (previous?.state === "open") {
					// A close after a quiet open stays quiet; a close after an alerted open reports the recovery —
					// except the window gates, whose close only means the evidence aged out. Either way an alerted
					// incident is resolved after the closed sweeps, so a window gate's row does not stay alerted.
					if (previous.alerted && !WINDOW_GATES.has(gate.name)) {
						await owner.adapter.postNotice(owner.channel, formatGateClosedNotice(gate));
					}
					this.#gateStates.set(gate.name, {
						state: "closed",
						alerted: false,
						closedSweeps: 1,
						pendingResolve: previous.alerted,
					});
				} else if (previous?.state === "closed") {
					previous.closedSweeps += 1;
					if (previous.pendingResolve && previous.closedSweeps >= GATE_RESOLVE_CLOSED_SWEEPS) {
						store.resolveAlertIncidents(`gate:${gate.name}`);
						previous.pendingResolve = false;
						this.#log.info("gate_incident_resolved", { gate: gate.name });
					}
				} else {
					// First observation after a restart is already closed: clear any leftover alerted row (no row = no-op).
					// A window gate too: it only closes once its evidence window passed without a recurrence.
					store.resolveAlertIncidents(`gate:${gate.name}`);
					this.#log.info("gate_incident_resolved", { gate: gate.name, reason: "closed_at_boot" });
					this.#gateStates.set(gate.name, { state: "closed", alerted: false, closedSweeps: 1, pendingResolve: false });
				}
			} catch (error) {
				this.#log.warn("gate_report_failed", { gate: gate.name, error: String(error) });
			}
		}
	}

	/**
	 * The day's cost state: ledger total, the configured ceiling and both of today's flags. Read on every monitor tick
	 * and `!budget`, so a `!budget off`, a `ompbot reload` of `costCap.dailyUsd` and the bot zone's midnight all take effect
	 * without a restart. `undefined` before the daemon has a store (a construction-time probe).
	 */
	#dailyBudget(now = this.#clock.now()): DailyBudgetState | undefined {
		const store = this.#store;
		if (store === undefined) return undefined;
		return dailyBudgetState({
			store,
			day: ledgerDay(now, this.#options.config.timezone),
			cap: this.#options.config.costCap?.dailyUsd,
		});
	}

	/** Peer silence alerts (doc/plans/peer-silence-alert.md 설계 4), from the first sweep after the startup recovery. */
	#sweepPeerSilence(): void {
		if (!this.#peerSilenceArmed) return;
		const alerts = this.#store?.alertSilentPeers() ?? 0;
		if (alerts === 0) return;
		this.#log.info("peer_silence_alerted", { count: alerts });
		this.#nudgePump();
	}

	/**
	 * Owner notice of the day's first breach, once a day: the ledger key `cost-cap-daily:<day>` is set before posting,
	 * so a restart (or a second breach the same day) stays quiet. Called from the sweep, not from a monitor tick.
	 */
	#sweepCostCap(): void {
		const store = this.#store;
		const state = this.#dailyBudget();
		if (store === undefined || state === undefined) return;
		const breach = budgetBreach(state);
		if (breach === undefined || state.notified) return;
		// No owner home: the breach is not marked notified, so the next sweep tries again.
		const owner = this.#ownerTarget("cost_cap_daily");
		if (owner === undefined) return;
		store.setCursor(dailyNoticeKey(state.day), String(this.#clock.now()));
		this.#log.warn("cost_cap_daily_stop", { day: state.day, cost: breach.cost, cap: breach.cap });
		void owner.adapter.postNotice(
			owner.channel,
			dailyCapNotice(breach.cap, breach.cost, this.#options.config.timezone),
		);
	}

	/**
	 * The `!undo` card: an approval request in the conversation's own thread, so the owner answers where they asked. A
	 * free-text reply on the card is not an approval (the undo writes files): it counts as denied.
	 */
	async #undoApproval(summary: string, threadRef: string, originKey: string): Promise<ApprovalOutcome> {
		const parsed = parseThreadRef(threadRef);
		if (parsed === undefined) return "denied";
		const result = await this.#approval.ask(parsed.channel, summary, {
			origin: { originKey, channel: parsed.channel, threadTs: parsed.threadTs },
		});
		return typeof result === "string" ? result : "denied";
	}

	/**
	 * `!brief` (doc/plans/briefing-image.md §D): the same status the page shows, drawn as one PNG and uploaded to the
	 * asking thread — no model call. The snapshot is assembled the way the dashboard CLI assembles it, except that the
	 * daemon answers its own `status` op instead of calling its socket, and no herdr board is started here.
	 */
	async #brief(originKey: string, threadRef: string): Promise<void> {
		const store = this.#store;
		if (store === undefined) throw new Error("장부가 아직 열리지 않았습니다");
		const config = this.#options.config;
		const route = this.#channels.forThreadRef(threadRef);
		if (route === undefined) throw new Error("이 대화의 채널을 찾지 못했습니다");
		const now = this.#clock.now();
		// The daemon's own line to itself: the same shape the socket returns, so the snapshot sections read the same.
		const snapshot = await snapshotReader({
			homeDir: config.homeDir,
			config,
			now: () => this.#clock.now(),
			callDaemon: async () => ({ ok: true, status: this.status() }),
			// The snapshot's own herdr/ssh/git calls always use the real runner: `briefingRun` is the capture seam only.
			run: realProcessRunner,
		})();
		const html = renderBriefingHtml(snapshot, now);
		const dir = join(config.homeDir, "media", "briefing");
		mkdirSync(dir, { recursive: true });
		// `<YYYYMMDD-HHmmss in the bot's zone>-<suffix>`: the suffix is per render, so two briefings in the same second never collide.
		const out = join(dir, `${briefingFileName(now, this.#options.config.timezone)}-${randomUUID().slice(0, 8)}.png`);
		const startedAt = Date.now();
		const size = await renderPng(html, out, {
			chromium: config.briefing?.chromium ?? "chromium",
			width: BRIEFING_WIDTH,
			timeoutMs: BRIEFING_TIMEOUT_MS,
			...(this.#options.briefingRun === undefined ? {} : { run: this.#options.briefingRun }),
		});
		await route.port.uploadFile(route.target, {
			path: out,
			title: `ompbot 브리핑 ${localIso(now, this.#options.config.timezone).slice(11, 16)}`,
			comment: briefingSummaryLine(snapshot),
		});
		this.#log.info("briefing_rendered", {
			origin: originKey,
			ms: Date.now() - startedAt,
			height: size.height,
		});
	}

	/**
	 * `!budget`: no argument answers today's totals and both ceilings; `off` lifts the day's daily ceiling
	 * (`cost-cap-off:<day>`, kept in the ledger so a restart keeps it and the bot zone's midnight drops it); `on` removes it
	 * early. Owner turns are never blocked by the daily ceiling — only monitor fires are.
	 */
	async #budgetCommand(arg: string): Promise<string> {
		const store = this.#store;
		if (store === undefined) return "비용 장부가 아직 열리지 않았습니다.";
		const state = this.#dailyBudget();
		if (state === undefined) return "비용 장부가 아직 열리지 않았습니다.";
		if (arg === "off") {
			if (state.cap === undefined) return "하루 상한이 설정되어 있지 않습니다(config.json `costCap.dailyUsd`).";
			store.setCursor(dailyOffKey(state.day), String(this.#clock.now()));
			this.#log.info("cost_cap_daily_off", { day: state.day, cost: state.cost, cap: state.cap });
			return `오늘(${state.day}) 하루 상한을 껐습니다. 자정(${this.#options.config.timezone})에 다시 켜집니다. 지금 켜려면 \`${COMMAND_TEXT.budget} on\`.`;
		}
		if (arg === "on") {
			const wasOff = store.getCursor(dailyOffKey(state.day)) !== undefined;
			store.deleteCursor(dailyOffKey(state.day));
			this.#log.info("cost_cap_daily_on", { day: state.day, was_off: wasOff, cost: state.cost });
			if (state.cap === undefined) return "하루 상한이 설정되어 있지 않습니다(config.json `costCap.dailyUsd`).";
			if (state.cost >= state.cap) {
				return `오늘(${state.day}) 하루 상한을 다시 켰습니다. 이미 ${usd(state.cost)}로 상한 ${usd(state.cap)}를 넘어 모니터가 다시 멈춥니다(알림은 그날 한 번만 갑니다).`;
			}
			return `오늘(${state.day}) 하루 상한을 켰습니다(지금 ${usd(state.cost)} / ${usd(state.cap)}).`;
		}
		if (arg !== "") {
			return `사용법: \`${COMMAND_TEXT.budget}\` (오늘 합계) · \`${COMMAND_TEXT.budget} off\` (오늘 하루만 끄기) · \`${COMMAND_TEXT.budget} on\``;
		}
		return renderBudget({
			day: state.day,
			total: state.cost,
			top: store.topDailyOrigins(state.day, 3),
			turnCap: this.#options.config.costCap?.turnUsd,
			dailyCap: state.cap,
			off: state.off,
		});
	}

	/** Every `taskSweepMs`, in the background: remote reads can take seconds and must not stall the sweep chain. */
	#maybeSweepTasks(): void {
		const interval = this.#options.taskSweepMs ?? TASK_SWEEP_MS;
		const now = this.#clock.now();
		if (interval <= 0 || now - this.#lastTaskSweepAt < interval) return;
		this.#lastTaskSweepAt = now;
		void this.sweepTasks();
		void this.checkHerdrHealth();
	}

	/** One local herdr reachability check (herdr on, with or without tasks): writes the `herdr-health` stamp. */
	async checkHerdrHealth(): Promise<void> {
		if (this.#herdrHealth === undefined || this.#stopped) return;
		try {
			const health = await this.#herdrHealth.check();
			if (!health.ok) this.#log.warn("herdr_health_failed", { fails: health.fails, error: health.error });
		} catch (error) {
			this.#log.warn("herdr_health_check_failed", { error: String(error) });
		}
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

	/** The owner's live DM origin on the platform of `ownerHome()`; undefined before the owner has a home. */
	#ownerDmOrigin(store: Store): string | undefined {
		const platform = store.ownerHome()?.platform;
		return platform === undefined ? undefined : store.ownerDmOrigin(platform);
	}

	/**
	 * Background skill review (hermes learning loop, minimal): every `skillReviewTurns` answered owner DM turns a
	 * separate child reads the recent digest and proposes skills; only an explicit owner click installs them.
	 */
	#maybeReviewSkills(): void {
		const every = this.#options.config.skillReviewTurns ?? DEFAULT_SKILL_REVIEW_TURNS;
		if (every <= 0 || this.#reviewing || this.#router?.draining === true) return;
		const store = this.#store;
		if (store === undefined || this.#adapters.size === 0) return;
		// Same latest-updated_at rule as the escalation/gate notices' ownerChannel(): a stale duplicate DM origin row
		// must not make the answered count (and so the review cadence) follow a dead conversation. The DM is on the
		// platform owner notices go to, so a Discord- or Teams-only install reviews too.
		const dmOrigin = this.#ownerDmOrigin(store);
		const channel = dmOrigin === undefined ? undefined : parseChatOrigin(dmOrigin)?.conversationId;
		if (dmOrigin === undefined || channel === undefined) return;
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
		this.#startSkillReview(dmOrigin, channel);
	}

	/**
	 * Improvement-candidate pass (`src/review/candidates.ts`): every `DEFAULT_GATE_SWEEP_MS` folds
	 * `<workspace>/candidates.jsonl` and raises due candidates as a #log line or owner approval cards. Skipped while
	 * frozen, draining or a previous pass (its cards) is still running. The daemon never edits rules or persona here.
	 */
	#maybeProposeCandidates(): void {
		const config = this.#options.config;
		const settings = resolveCandidates(config.candidates);
		const gate = {
			frozen: this.#frozen() !== undefined,
			draining: this.#router?.draining === true,
			openCards: this.#proposingCandidates ? 1 : 0,
		};
		if (!settings.enabled || gate.frozen || gate.draining || gate.openCards > 0) return;
		const now = this.#clock.now();
		if (now - this.#lastCandidatePassAt < DEFAULT_GATE_SWEEP_MS) return;
		this.#lastCandidatePassAt = now;
		const dmOrigin = this.#store === undefined ? undefined : this.#ownerDmOrigin(this.#store);
		const ownerChannel = dmOrigin === undefined ? undefined : parseChatOrigin(dmOrigin)?.conversationId;
		const logChannel = config.logChannel ?? config.channels.discord?.logChannelId;
		this.#proposingCandidates = true;
		void runCandidateProposals(
			{
				ledgerPath: join(config.workspaceDir, "candidates.jsonl"),
				experimentsPath: join(config.workspaceDir, "experiments.md"),
				settings,
				timezone: config.timezone,
				now: () => this.#clock.now(),
				postLog: async (text) => {
					const adapter = logChannel === undefined ? undefined : this.#adapterOfConversation(logChannel);
					if (logChannel === undefined || adapter === undefined) {
						this.#log.info("candidate_note", { text });
						return;
					}
					await adapter.postNotice(logChannel, text);
				},
				requestApproval:
					ownerChannel === undefined || this.#adapterOfConversation(ownerChannel) === undefined
						? undefined
						: (summary) => this.#approval.request(ownerChannel, summary),
				log: this.#log,
			},
			gate,
		)
			.catch((error) => this.#log.warn("candidate_pass_failed", { error: String(error) }))
			.finally(() => {
				this.#proposingCandidates = false;
			});
	}

	/**
	 * `!distill`: an immediate skill review of this conversation's session, the same function, approval card and
	 * `skills-pending` storage as the periodic review (whose turn baseline stays untouched). Returns the command's
	 * answer; the review itself runs in the background (its approval can wait for the owner's click).
	 */
	async #distill(originKey: string): Promise<string> {
		const channel = parseChatOrigin(originKey)?.conversationId;
		if (this.#store === undefined || channel === undefined || this.#adapterOfConversation(channel) === undefined) {
			return "이 대화에서는 스킬 리뷰를 시작할 수 없습니다.";
		}
		if (this.#reviewing) return "이미 리뷰 중입니다. 끝나면 결과를 알려 드립니다.";
		if (this.#frozen() !== undefined) {
			this.#log.info("skill_review_skipped_frozen", { origin: originKey, trigger: "distill" });
			return "동결 중이라 하지 않았습니다.";
		}
		// A channel top-level `!distill` stays on the channel origin, whose session holds none of the thread talks:
		// refuse an empty digest instead of paying a model turn to review nothing.
		const sessionDir = this.#store.getOrigin(originKey)?.sessionDir;
		const digest = sessionDir === undefined ? "" : await readSessionDigest(sessionDir);
		if (digest.trim() === "") {
			return "이 대화방에는 리뷰할 세션 내용이 없습니다. 대화한 스레드 안에서 `!distill`을 보내 주세요.";
		}
		if (this.#reviewing) return "이미 리뷰 중입니다. 끝나면 결과를 알려 드립니다.";
		// !distill is an explicit ask: a no-proposal ending must still reach the thread, not just the log.
		this.#startSkillReview(originKey, channel, true);
		return "스킬 리뷰를 시작했습니다. 제안이 있으면 승인 카드로 알립니다.";
	}

	/** Background review of `sourceOrigin`'s session digest; the caller has checked `#reviewing` and the freeze. */
	#startSkillReview(sourceOrigin: string, channel: string, announceEmpty = false): void {
		const store = this.#store;
		const adapter = this.#adapterOfConversation(channel);
		if (store === undefined || adapter === undefined) return;
		this.#reviewing = true;
		const origin = store.getOrigin(sourceOrigin);
		void runSkillReview(
			{
				makeDriver: (reviewOrigin, sessionDir) => this.#makeDriver(reviewOrigin, sessionDir),
				readDigest: async () => (origin?.sessionDir === undefined ? "" : await readSessionDigest(origin.sessionDir)),
				savePending: (proposals) => savePendingProposals(this.#options.config.homeDir, proposals, Date.now()),
				install: async (proposal) => {
					const revision = installSkill(skillDirOf(proposal.name), proposal, Date.now());
					if (revision !== undefined)
						this.#log.info("skill_revision_saved", { name: proposal.name, revision: basename(revision) });
				},
				requestApproval: (summary) => this.#approval.request(channel, summary),
				notify: (text) => adapter.postNotice(channel, text),
				log: this.#log,
				now: () => Date.now(),
			},
			{
				sessionDir: sessionDirFor(join(this.#options.config.homeDir, "sessions"), SKILL_REVIEW_ORIGIN, 1),
				announceEmpty,
			},
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
		this.#drainDeferNoticed.clear();
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
	 * `apply` past its drain cut limit, right before its restart: records the op_ref of every dispatched turn (with the
	 * summary of the approval card its origin waits on) in `<home>/restart-cut.json` — the next process resumes those
	 * turns instead of reporting them interrupted — then withdraws the pending approval cards. ok only once the file is
	 * durably in place; a failed write answers an error and touches no card, and the apply then cancels the drain.
	 */
	async drainCut(
		applyStamp: string,
	): Promise<{ ok: true; opRefs: number; approvals: number } | { ok: false; error: string }> {
		const router = this.#router;
		const store = this.#store;
		const broker = this.#broker;
		if (router?.draining !== true || store === undefined || broker === undefined)
			return { ok: false, error: "not draining" };
		const approvals = new Map<string, string>();
		for (const request of broker.pendingRequests()) {
			if (request.originKey !== undefined && !approvals.has(request.originKey))
				approvals.set(request.originKey, request.summary);
		}
		const opRefs: RestartCutEntry[] = [];
		const seen = new Set<string>();
		for (const row of store.listInbound({ state: "dispatched" })) {
			// A command op (lane landing, task bookkeeping, `/compact`) is not an omp turn to resume.
			if (row.opRef === null || COMMAND_OP_REF.test(row.opRef) || seen.has(row.opRef)) continue;
			seen.add(row.opRef);
			const approval = approvals.get(row.originKey);
			opRefs.push({ originKey: row.originKey, opRef: row.opRef, ...(approval === undefined ? {} : { approval }) });
		}
		try {
			writeRestartCut(this.#options.config.homeDir, { at: this.#clock.now(), applyStamp, opRefs });
		} catch (error) {
			this.#log.warn("drain_cut_failed", { apply: applyStamp, error: String(error) });
			return { ok: false, error: String(error) };
		}
		const cancelled = await broker.cancelForRestart();
		this.#log.info("drain_cut", { apply: applyStamp, op_refs: opRefs.length, approvals_cancelled: cancelled });
		return { ok: true, opRefs: opRefs.length, approvals: cancelled };
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
		// `channels` is a restart key, so `plan.next` still carries the Discord values the daemon started with.
		this.#store?.setLogChannel({ slack: plan.next.logChannel, discord: plan.next.channels.discord?.logChannelId });
		if (plan.changed.includes("peerSilenceAlert")) this.#store?.setPeerCallPolicy(peerCallPolicyOf(plan.next));
		this.#broker?.setEscalationChannel({
			slack: plan.next.escalationChannel,
			discord: plan.next.channels.discord?.escalationChannelId,
		});
		// The inbound policy keys are Slack's config fields.
		this.#adapters.get("slack")?.setChannelPolicy({
			...(plan.next.mentionFreeChannels === undefined ? {} : { mentionFreeChannels: plan.next.mentionFreeChannels }),
			...(plan.next.logChannel === undefined ? {} : { logChannel: plan.next.logChannel }),
			...(plan.next.peerBots === undefined ? {} : { peerBots: plan.next.peerBots }),
			...(plan.next.requireMention === undefined ? {} : { requireMention: plan.next.requireMention }),
			...(plan.next.peerHopLimit === undefined ? {} : { peerHopLimit: plan.next.peerHopLimit }),
		});
		// Of the top-level keys only the peer hop cap is Discord's too (its own policy is under `channels.discord`).
		this.#adapters
			.get("discord")
			?.setChannelPolicy(plan.next.peerHopLimit === undefined ? {} : { peerHopLimit: plan.next.peerHopLimit });
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
		const marker = takeRestartMarker(config.homeDir, (reason) =>
			this.#log.info("restart_notice_dropped", { kind, reason }),
		);
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
		for (const ref of threads) {
			const parsed = parseThreadRef(ref);
			const adapter = this.#adapterOfThread(ref);
			if (parsed === undefined || adapter === undefined) continue;
			void adapter.postNotice(parsed.channel, text, parsed.threadTs === TOP_LEVEL_TS ? undefined : parsed.threadTs);
		}
	}

	/** `!status` / `/status-ompbot`: the asking conversation's context line, then the daemon-wide status text. */
	async #statusText(originKey: string): Promise<string> {
		let state: Parameters<typeof renderContextLine>[0];
		try {
			state = (await this.#router?.driverState(originKey)) ?? "idle";
		} catch (error) {
			this.#log.warn("status_context_failed", { origin: originKey, error: String(error) });
			state = "unknown";
		}
		return `${renderContextLine(state)}\n${renderStatusText(this.status())}`;
	}

	status(): StatusReport {
		const router = this.#router;
		const report = buildStatus(
			this.store,
			this.#options.ompVersion,
			this.#options.config.timezone,
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
				gateOptionsFromConfig(this.#options.config),
				this.#options.hostLoad,
			),
		);
		const withFreeze = { ...report, ...frozenField(this.#options.config.homeDir) };
		return router?.draining ? { ...withFreeze, drain: this.drainCounts() } : withFreeze;
	}

	/**
	 * `ompbot inject`: the bot posts a `🧪 inject <nonce>` root message in the conversation and an owner message is fed
	 * through that platform adapter's own message path (same normalizeInbound, same fencing of `quoted`), threaded under
	 * that root. With `thread` the marker is a reply in that existing thread (a Discord DM: a reply to that message) and
	 * the owner message a reply of it.
	 */
	async inject(request: InjectRequest): Promise<InjectResult> {
		if (this.#adapters.size === 0) throw new Error("daemon not started");
		if (request.asOwner !== true) throw new Error("inject requires --as-owner");
		// Owner DM (`slack/dm/D…`, `discord/dm/<id>`) or a channel the bot is in (`slack/ch/C…`, `discord/ch/<id>`); no
		// thread origins.
		const ref = parseChatOrigin(request.origin);
		if (ref === undefined || (ref.platform !== "slack" && ref.platform !== "discord") || ref.threadId !== undefined)
			throw new Error(
				`inject origin must be slack/dm/<id>, slack/ch/<id>, discord/dm/<id> or discord/ch/<id>: ${request.origin}`,
			);
		if (!this.#adapters.has(ref.platform)) throw new Error(`${ref.platform} is not configured`);
		const channel = ref.conversationId;
		// A Slack thread is a message ts, a Discord one a message id (snowflake).
		if (request.thread !== undefined && !(ref.platform === "slack" ? /^\d+\.\d+$/ : /^\d{17,20}$/).test(request.thread))
			throw new Error(`inject thread is not a message id: ${request.thread}`);
		const nonce = randomBytes(6).toString("hex");
		// The marker is all the owner sees of the injected message, so it carries the text's first line — masked before it
		// is cut: a secret cut short no longer matches its pattern and would go out half.
		const firstLine = redact(
			request.text
				.split("\n")
				.find((line) => line.trim() !== "")
				?.replace(/\s+/g, " ")
				.trim() ?? "",
		);
		const preview = firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
		const { outcome, markerTs } = await this.#ingestOwnerText(
			{ channel, threadTs: request.thread, kind: ref.kind, injected: true },
			request.text,
			preview === ""
				? `🧪 inject ${nonce}`
				: `🧪 inject ${nonce}\n> ${ref.platform === "discord" ? escapeDiscordMarkdown(preview) : escapeMrkdwn(preview)}`,
			request.quoted === undefined ? undefined : [request.quoted],
		);
		// The marker stays up either way, so the owner sees what was tried.
		if (outcome === "card_rejected")
			throw new Error("inject_rejected: approval/choice card threads take only the owner's own reply");
		if (outcome === "dropped") throw new Error("inject_rejected: message was not accepted");
		return { nonce, threadRef: threadRefOf(channel, request.thread ?? markerTs) };
	}

	/**
	 * IPC `notify` (`apply --report-plain`, doc/plans/owner-restart-command.md): one bot post in `thread` (or at the top
	 * level) of a report origin, put on the delivery ledger like an answer under `notify:<stamp>` — no inbound row, no
	 * turn, no omp session. The same stamp again is a no-op.
	 */
	notify(request: {
		origin: string;
		text: string;
		thread?: string | undefined;
		stamp?: string | undefined;
	}): { ok: true; opRef: string } | { ok: false; error: string } {
		const store = this.#store;
		if (store === undefined) return { ok: false, error: "daemon not started" };
		const { origin, thread } = request;
		const ref = parseChatOrigin(origin);
		if (ref === undefined || !isReportOrigin(origin))
			return { ok: false, error: `notify origin must be slack|discord/(dm|ch)/<id>: ${origin}` };
		if (thread !== undefined && !reportThreadPattern(origin).test(thread))
			return { ok: false, error: `notify thread is not a message id: ${thread}` };
		if (!this.#adapters.has(ref.platform)) return { ok: false, error: `${ref.platform} is not configured` };
		const text = request.text.trim();
		if (text === "") return { ok: false, error: "notify needs a non-empty text" };
		const opRef = `${NOTIFY_OP_PREFIX}${request.stamp ?? randomBytes(6).toString("hex")}`;
		store.recordAnswer({
			originKey: origin,
			opRef,
			threadRef: threadRefOf(ref.conversationId, thread ?? TOP_LEVEL_TS),
			parts: [text],
		});
		this.#log.info("notify_recorded", { origin, opRef });
		return { ok: true, opRef };
	}

	/**
	 * Feeds `text` (as typed, unescaped) as an owner message through the adapter's own message path: the bot posts
	 * `marker` (in `threadTs`'s thread, or as a root) and the owner message takes the marker's id. `posted.ts` is set as
	 * soon as the marker is up, so a caller still knows it when the ingest throws.
	 */
	async #ingestOwnerText(
		/** `injected`: put in by `ompbot inject`, not by an owner click (`OwnerIngest.injected`). */
		target: { channel: string; threadTs?: string | undefined; kind: "dm" | "ch"; injected?: boolean },
		text: string,
		marker: string,
		quoted?: readonly string[],
		posted: { ts?: string } = {},
	): Promise<{ outcome: IngestOutcome; markerTs: string }> {
		const { channel, threadTs, kind, injected } = target;
		const adapter = this.#adapterOfConversation(channel);
		const route = this.#channels.forConversation(channel);
		if (adapter === undefined || route === undefined) throw new Error("daemon not started");
		const { messageId } = await route.port.post(
			{ conversationId: channel, ...(threadTs === undefined ? {} : { threadId: threadTs }) },
			{ text: marker },
		);
		posted.ts = messageId;
		// A reply in an approval card's thread settles the card without an inbound row, so acceptance comes from the
		// adapter's own verdict, not from the ledger.
		const outcome = await adapter.ingestOwner({
			conversationId: channel,
			kind,
			threadId: threadTs,
			messageId,
			text,
			quoted,
			...(injected === true ? { injected } : {}),
		});
		return { outcome, markerTs: messageId };
	}

	/** A `머지` click on a task card: the same as answering "머지해" in the task thread. Only a task in review takes it. */
	#handleTaskMerge(taskId: string, channel: string | undefined, messageTs: string | undefined): Promise<void> {
		return this.#handleTaskCardButton({
			kind: "merge",
			taskId,
			channel,
			messageTs,
			requiredStatus: "review",
			ownerText: "머지해",
			marker: "🔘 머지 (버튼)",
			notFound: { text: `⚠️ 이 TASK를 찾을 수 없음 (${taskId})`, buttons: [] },
			settledCard: buildMergeSettledCard,
			wrongStatusNote: (status) => `이미 처리됐거나 머지할 상태가 아님 (${status})`,
			requestedNote: (clock) => `▶ 머지 요청됨 · ${clock}`,
			rejectedNote: MERGE_REJECTED_NOTE,
		});
	}

	/** Whether a local task's repository is one of `repos` (`repoMatchesCommonDir`: the same git common directory). */
	repoMatches(row: TaskRow, repos: readonly string[]): Promise<boolean> {
		return repoMatchesCommonDir(row.repo, repos);
	}

	/**
	 * Auto-merge of a reached task (`taskAutoLand`): the bot answers "머지해" in the task thread as the owner, under a
	 * `🤖 자동 머지` marker, so the thread's session runs the usual landing. True only when the message went in. A
	 * draining or unstarted daemon, a top-level or unreadable thread and a call while the same task is still going in
	 * put nothing in. Repeats across sweeps are kept out by the sweep's `reached:<reachKey>` notice key.
	 */
	async autoLand(row: TaskRow): Promise<boolean> {
		const log = this.#log;
		if (this.#router?.draining === true || this.#adapters.size === 0 || this.#store === undefined) {
			log.info("task_autoland_ignored", { task: row.taskId, reason: "not_ready" });
			return false;
		}
		if (this.#autoLanding.has(row.taskId)) {
			log.info("task_autoland_ignored", { task: row.taskId, reason: "in_flight" });
			return false;
		}
		this.#autoLanding.add(row.taskId);
		try {
			const thread = parseThreadRef(row.threadRef);
			if (thread === undefined || thread.threadTs === TOP_LEVEL_TS) {
				log.warn("task_autoland_rejected", { task: row.taskId, reason: "bad_thread", thread: row.threadRef });
				return false;
			}
			const posted: { ts?: string } = {};
			const { outcome } = await this.#ingestOwnerText(
				{ channel: thread.channel, threadTs: thread.threadTs, kind: conversationKind(thread.channel) },
				AUTO_LAND_TEXT,
				AUTO_LAND_MARKER,
				undefined,
				posted,
			);
			if (outcome === "dropped" || outcome === "card_rejected") {
				log.warn("task_autoland_rejected", { task: row.taskId, reason: outcome, marker: posted.ts });
				return false;
			}
			log.info("task_autoland_requested", { task: row.taskId, marker: posted.ts, outcome });
			return true;
		} finally {
			this.#autoLanding.delete(row.taskId);
		}
	}

	/**
	 * A `추천대로` click on a blocked task's card: the same as answering "추천대로" in the task thread, with the
	 * recommendation the button carried (its `value`) quoted in the owner text and the card's note. Only a blocked task
	 * takes it.
	 */
	#handleTaskRecommend(
		taskId: string,
		value: string | undefined,
		channel: string | undefined,
		messageTs: string | undefined,
	): Promise<void> {
		const recommend = (value ?? "").replace(/\s+/g, " ").trim().slice(0, RECOMMEND_VALUE_MAX);
		const short = recommend.length > 120 ? `${recommend.slice(0, 119)}…` : recommend;
		return this.#handleTaskCardButton({
			kind: "recommend",
			taskId,
			channel,
			messageTs,
			requiredStatus: "blocked",
			ownerText: recommend === "" ? "추천대로" : `추천대로 (추천: ${recommend})`,
			marker: "🔘 추천대로 (버튼)",
			notFound: { text: `이미 처리됐거나 막힌 상태가 아님 (TASK 없음: ${taskId})`, buttons: [] },
			settledCard: buildBlockedSettledCard,
			wrongStatusNote: (status) => `이미 처리됐거나 막힌 상태가 아님 (${status})`,
			requestedNote: (clock) => `▶ 추천대로 진행 요청됨 · ${clock}${short === "" ? "" : ` — 추천: ${short}`}`,
			rejectedNote: RECOMMEND_REJECTED_NOTE,
		});
	}

	/**
	 * One button on a task card (`머지`, `추천대로`) is the owner answering `ownerText` in the task thread. Only a task in
	 * `requiredStatus` takes it, and one card takes one click per process — the key goes in before the first await,
	 * so a quick second click finds it. Every outcome redraws the card without its button.
	 */
	async #handleTaskCardButton(button: {
		kind: "merge" | "recommend";
		taskId: string;
		channel: string | undefined;
		messageTs: string | undefined;
		requiredStatus: TaskRow["status"];
		ownerText: string;
		marker: string;
		notFound: { text: string; buttons: [] };
		settledCard: (row: TaskRow, note: string) => TaskCard;
		wrongStatusNote: (status: string) => string;
		requestedNote: (clock: string) => string;
		rejectedNote: string;
	}): Promise<void> {
		const { kind, taskId, channel, messageTs } = button;
		const log = this.#log;
		const key = `${channel ?? "-"}:${messageTs ?? taskId}`;
		if (this.#mergeClicks.has(key)) {
			log.info(`task_${kind}_ignored`, { task: taskId, reason: "duplicate" });
			return;
		}
		this.#mergeClicks.add(key);
		const redraw = async (card: TaskCard | { text: string; buttons: [] }) => {
			if (channel === undefined || messageTs === undefined) return;
			const port = this.#channels.forConversation(channel)?.port;
			if (port === undefined) return;
			const msg = "title" in card ? cardMessage(card, port) : card;
			await port
				.edit({ platform: port.platform, conversationId: channel, messageId: messageTs }, msg)
				.catch((error: unknown) => log.warn(`task_${kind}_card_edit_failed`, { task: taskId, error: String(error) }));
		};
		const row = this.#store?.tasks.get(taskId);
		if (row === undefined || row.status !== button.requiredStatus) {
			log.info(`task_${kind}_ignored`, { task: taskId, reason: row === undefined ? "not_found" : row.status });
			await redraw(row === undefined ? button.notFound : button.settledCard(row, button.wrongStatusNote(row.status)));
			return;
		}
		const rejected = button.settledCard(row, button.rejectedNote);
		const thread = parseThreadRef(row.threadRef);
		if (thread === undefined || thread.threadTs === TOP_LEVEL_TS) {
			log.warn(`task_${kind}_inject_rejected`, { task: taskId, reason: "bad_thread", thread: row.threadRef });
			await redraw(rejected);
			return;
		}
		await redraw(button.settledCard(row, button.requestedNote(this.#clockFormat.format(this.#clock.now()))));
		const posted: { ts?: string } = {};
		try {
			const { outcome } = await this.#ingestOwnerText(
				{ channel: thread.channel, threadTs: thread.threadTs, kind: conversationKind(thread.channel) },
				button.ownerText,
				button.marker,
				undefined,
				posted,
			);
			if (outcome !== "dropped" && outcome !== "card_rejected") {
				log.info(`task_${kind}_requested`, { task: taskId, marker: posted.ts, outcome });
				return;
			}
			log.warn(`task_${kind}_inject_rejected`, { task: taskId, reason: "dropped", marker: posted.ts });
		} catch (error) {
			log.warn(`task_${kind}_inject_rejected`, {
				task: taskId,
				reason: "error",
				...(posted.ts === undefined ? {} : { marker: posted.ts }),
				error: String(error),
			});
		}
		await redraw(rejected);
	}

	/**
	 * A `다시 요청` click on a timed-out approval card (canonical or mirror): the same as the owner asking the requesting
	 * thread to put the request up again. The old tool call is gone, so the click opens a new turn there; approving
	 * still takes a click on the new card. One approval takes one click per process, keyed before the first await.
	 */
	async #handleApprovalRetry(
		approvalId: string,
		channel: string | undefined,
		messageTs: string | undefined,
	): Promise<void> {
		const log = this.#log;
		if (this.#retryClicks.has(approvalId)) {
			log.info("approval_retry_ignored", { id: approvalId, reason: "duplicate" });
			return;
		}
		this.#retryClicks.add(approvalId);
		const clicked = channel === undefined || messageTs === undefined ? undefined : { channel, ts: messageTs };
		const redraw = (note: string) => this.#approval.redrawCards(approvalId, note, clicked);
		const row = this.#store?.getApproval(approvalId);
		const thread = row?.originThreadRef ? parseThreadRef(row.originThreadRef) : undefined;
		const refused =
			row === undefined
				? "승인 기록 없음"
				: row.status !== "expired"
					? `상태 ${row.status}`
					: thread === undefined || thread.threadTs === TOP_LEVEL_TS
						? "요청 스레드를 알 수 없음"
						: undefined;
		if (refused !== undefined || row === undefined || thread === undefined) {
			const reason = row === undefined ? "not_found" : row.status !== "expired" ? row.status : "bad_thread";
			log.info("approval_retry_ignored", { id: approvalId, reason });
			await redraw(`⚠️ 다시 요청할 수 없음 (${refused})`);
			return;
		}
		await redraw(`▶ 다시 요청됨 · ${this.#clockFormat.format(this.#clock.now())}`);
		const firstLine = row.summary.split("\n")[0] ?? "";
		const posted: { ts?: string } = {};
		try {
			const { outcome } = await this.#ingestOwnerText(
				{ channel: thread.channel, threadTs: thread.threadTs, kind: conversationKind(thread.channel) },
				`다시 요청: ${firstLine.slice(0, 200)}\n(방금 시간 초과로 거부된 승인 요청입니다. 같은 요청을 ompbot_request_approval로 다시 올려 주세요.)`,
				"🔘 다시 요청 (버튼)",
				undefined,
				posted,
			);
			if (outcome !== "dropped" && outcome !== "card_rejected") {
				log.info("approval_retry_requested", { id: approvalId, marker: posted.ts, outcome });
				return;
			}
			log.warn("approval_retry_inject_rejected", { id: approvalId, reason: "dropped", marker: posted.ts });
		} catch (error) {
			log.warn("approval_retry_inject_rejected", {
				id: approvalId,
				reason: "error",
				...(posted.ts === undefined ? {} : { marker: posted.ts }),
				error: String(error),
			});
		}
		await redraw("⚠️ 다시 요청을 넣지 못함 — 스레드에 직접 다시 요청해 주세요");
	}

	/**
	 * `ompbot lanes attach`: `lane_attach {lane, pid, wait?, keepPaused?}` hands the lane's session to the CLI's terminal
	 * omp and answers the file to resume; `lane_detach {lane, sessionFile, newFiles}` gives it back. The request is the
	 * signal — nothing is read from marker files or mtimes.
	 */
	async #laneAttachIpc(request: Record<string, unknown>): Promise<unknown> {
		const lanes = this.#lanes;
		if (lanes === undefined) return { ok: false, error: "lanes are not running" };
		const lane = request.lane;
		if (typeof lane !== "string") return { ok: false, error: `${String(request.op)} needs a lane string` };
		if (request.op === "lane_attach") {
			const pid = request.pid;
			if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
				return { ok: false, error: "lane_attach needs a pid" };
			}
			return lanes.attach(lane, { pid, wait: request.wait === true, keepPaused: request.keepPaused === true });
		}
		const { sessionFile, newFiles } = request;
		if (
			typeof sessionFile !== "string" ||
			!Array.isArray(newFiles) ||
			!newFiles.every((file): file is string => typeof file === "string")
		) {
			return { ok: false, error: "lane_detach needs sessionFile and newFiles" };
		}
		const outcome = await lanes.detach(lane, { sessionFile, newFiles, by: "cli" });
		return outcome.handled ? { ok: true, text: outcome.text } : { ok: false, error: outcome.text };
	}

	async #handleIpc(request: unknown): Promise<unknown> {
		if (typeof request !== "object" || request === null || !("op" in request)) {
			return { ok: false, error: "invalid request" };
		}
		if (request.op === "status") return { ok: true, status: this.status() };
		if (request.op === "live") {
			const origin = "origin" in request ? request.origin : undefined;
			return { ok: true, live: typeof origin === "string" ? (this.#router?.liveView(origin) ?? null) : null };
		}
		if (request.op === "session_file") {
			// `ompbot lanes watch`: the file the origin's running child has open; null when no child runs (read-only).
			const origin = "origin" in request ? request.origin : undefined;
			if (typeof origin !== "string") return { ok: false, error: "session_file needs an origin string" };
			return { ok: true, sessionFile: (await this.#router?.openSessionFile(origin)) ?? null };
		}
		if (request.op === "lane_attach" || request.op === "lane_detach") return this.#laneAttachIpc(request);
		if (request.op === "reload") return this.reloadConfig("ipc");
		if (request.op === "drain" || request.op === "drain_status" || request.op === "drain_cancel") {
			if (request.op !== "drain_status") this.setDraining(request.op === "drain");
			return { ok: true, draining: this.#router?.draining ?? false, ...this.drainCounts() };
		}
		if (request.op === "drain_cut") {
			const stamp = "applyStamp" in request && typeof request.applyStamp === "string" ? request.applyStamp : "";
			return this.drainCut(stamp);
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
		if (request.op === "notify") {
			const origin = "origin" in request ? request.origin : undefined;
			const thread = "thread" in request ? request.thread : undefined;
			const text = "text" in request ? request.text : undefined;
			const stamp = "stamp" in request ? request.stamp : undefined;
			if (
				typeof origin !== "string" ||
				typeof text !== "string" ||
				(thread !== undefined && typeof thread !== "string") ||
				(stamp !== undefined && (typeof stamp !== "string" || !STAMP_PATTERN.test(stamp)))
			) {
				return { ok: false, error: "notify needs origin and text strings (thread and stamp optional)" };
			}
			return this.notify({ origin, text, thread, stamp });
		}
		if (request.op === "tasks_pause" || request.op === "tasks_resume") {
			const id = "id" in request ? request.id : undefined;
			if (typeof id !== "string" || this.#store?.tasks.get(id) === undefined)
				return { ok: false, error: "task not found" };
			return this.controlTask(id, request.op === "tasks_pause" ? "pause" : "resume");
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
	 * A Teams guest/qa question (doc/plans/teams-channel.md TASK C): no origin, no inbound row, no mailbox. A `!` command
	 * gets one line (`!home` acts for the owner in a 1:1 only); a question goes to the bounded read-only runner, and its
	 * answer — or the busy line — becomes a plain delivery replying to it.
	 */
	#onGuestInbound(message: GuestInboundMessage): { duplicate?: boolean } | undefined {
		const store = this.#store;
		if (store === undefined) return undefined;
		const seenKey = `guest:${message.platformMessageId}`;
		if (store.getCursor(seenKey) !== undefined) return { duplicate: true };
		store.setCursor(seenKey, "1");
		const alias = message.conversationId;
		const reply = (opRef: string, body: string) =>
			store.recordGuestAnswer({
				alias,
				opRef: `${opRef}:${message.platformMessageId}`,
				threadRef: message.threadRef,
				body,
			});
		const text = message.text.trim();
		if (text.startsWith("!") || parseCommand(text) !== undefined) {
			if (message.owner && isHomeCommand(text)) {
				if (message.kind !== "dm") {
					reply("home", TEAMS_GROUP_HOME_REFUSED_TEXT);
				} else {
					store.setOwnerHome({ platform: "teams", conversationId: alias });
					this.#log.info("owner_home_set", { origin: `teams/dm/${alias}`, platform: "teams", conversation: alias });
					reply("home", "🏠 이 대화를 알림 받을 곳으로 정했습니다. 데몬 알림과 채널 없는 모니터 결과가 여기로 옵니다.");
				}
			} else {
				reply("guest-command", GUEST_COMMAND_TEXT);
			}
			return {};
		}
		const teams = this.#options.config.channels.teams;
		const signal = this.#guestAbort.signal;
		const job = async (): Promise<void> => {
			if (signal.aborted) return;
			const id = store.recordTeamsQuestion({
				alias,
				askerAad: message.asker.aadObjectId,
				askerName: message.asker.name,
				question: text,
			});
			const prompt = buildGuestPrompt({
				context: store.teamsQaContext(alias, GUEST_CONTEXT_PAIRS, id),
				question: text,
				askerName: message.asker.name,
			});
			const answer = await runGuestQuestion(
				{
					ompBin: this.#options.config.ompExecutable,
					homeDir: this.#options.config.homeDir,
					systemPromptAppendix: teamsQaSystemPrompt(),
					model: teams?.guestModel,
					run: this.#options.guestRun,
					inheritedEnv: this.#options.guestEnv,
					log: this.#log,
					signal,
				},
				prompt,
			);
			if (signal.aborted) return;
			if (answer === undefined) {
				this.#log.warn("guest_run_failed", { alias, id: message.platformMessageId });
				reply("guest", GUEST_FAILED_TEXT);
				return;
			}
			store.recordTeamsAnswer(id, answer);
			reply("guest", answer);
		};
		const admitted = this.#guestQueue.submit(() =>
			job().catch((error: unknown) =>
				this.#log.error("guest_run_error", { alias, id: message.platformMessageId, error: String(error) }),
			),
		);
		this.#log.info("guest_question", { alias, id: message.platformMessageId, owner: message.owner, admitted });
		if (admitted === "full") reply("guest-busy", GUEST_BUSY_TEXT);
		return {};
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
			// Right away, before any await: a sweep still in flight must not start a cron command now, and the
			// running ones are killed (their events stay dispatched for the next boot).
			this.#monitors?.stop();
			this.#stopPromise = this.#shutdown();
		}
		return this.#stopPromise;
	}

	async #shutdown(): Promise<void> {
		clearInterval(this.#timer);
		// Running lane checks are killed now; the verdicts are not awaited (the claims stay pending for the next boot).
		this.#lanes?.stop();
		this.#heartbeat?.stop();
		this.#heartbeat = undefined;
		installProcessAudit(undefined);
		this.#ipc?.stop();
		this.#webhook?.stop();
		for (const adapter of this.#adapters.values()) await adapter.stop();
		this.#guestAbort.abort();
		await this.#guestQueue.idle();
		await this.#pumping;
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
