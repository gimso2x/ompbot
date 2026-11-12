import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ActionButton, MessageRef } from "../channel/port";
import type { ChannelRegistry } from "../channel/registry";
import { escapeMrkdwn, formatElapsed } from "../channel/text";
import type { PauseCheck } from "../core/mailbox";
import { parseThreadRef, platformOfThreadRef } from "../core/normalize";
import type { IdPlatform } from "../core/origin-key";
import type { InboundRecord, MailboxClock } from "../core/types";
import type { Logger } from "../log";
import { type FreezeState, frozenMessage } from "../ops/freeze";
import { redact } from "../redact";
import type { Store } from "../store/db";
import { type TaskCheck, type TaskChecksRun, taskChecksOf } from "../tasks/checker";
import { worktreePathOf } from "../tasks/docs";
import { runWorktreeChecks } from "../tasks/evaluate";
import { createTaskHostOps, type TaskHostOps } from "../tasks/host";
import { type AutoLandPolicy, cardMessage } from "../tasks/notify";
import { repoMatchesCommonDir } from "../tasks/repo-match";
import { CHECK_TIMEOUT_MS, type SignalCheck } from "../tasks/signals";
import { localDay } from "../time";
import { buildLaneOutcomeCard, type LaneCardView, lanePauseActionId, laneResumeActionId } from "./card";
import { computeLaneChanges } from "./changes";
import {
	classifyLaneCompletion,
	collectLaneDiff,
	type IntegrityInput,
	type IntegrityRefusal,
	type LaneDiffRange,
	LaneDiffUnavailable,
	laneDiffUnavailableRefusal,
} from "./integrity";
import { createLaneLander, externallyLanded, type LandLane, type LandResult, laneLandBlockers } from "./land";
import { type LaneReviewDeps, reviewLane } from "./review";
import {
	INCONCLUSIVE_APPROVED,
	INTEGRITY_APPROVED,
	type LaneChanges,
	type LaneChecksInconclusive,
	type LaneClaim,
	type LaneLand,
	type LaneMeta,
	type LaneReview,
	type LaneRow,
	type LaneStatus,
	laneOriginKey,
	OWNER_PAUSE_HELD,
} from "./status";
import { buildLanePrompt, buildNotDonePrompt, buildRebasePrompt, classifyClosedLaneMessage } from "./trigger";
import {
	type ClaimEvidence,
	defaultGit,
	type GitRunner,
	resolveBaseSha,
	type VerifyResult,
	verifyClaim,
} from "./verify";
import {
	laneBranchOf,
	laneIdsOnBranches,
	nextLaneId,
	parseLaneAcceptance,
	parseLaneRisk,
	resolveLaneRepo,
} from "./worktree";

export const DEFAULT_MAX_LANES = 4;
/** The thread status message is edited at most this often (milestones excepted). */
export const PROGRESS_INTERVAL_MS = 15 * 60_000;
/** A claim whose check could not finish is judged again after this long: closed when it passes, `not-done` when not. */
export const CLAIM_GRACE_MS = 5 * 60_000;

/** Judgements at one HEAD whose checks may time out; the last one asks the owner instead of running them again. */
export const INCONCLUSIVE_RUNS_MAX = 2;

/** A landing refused as not fast-forward goes back to the lane once; the second refusal is the owner's (`blocked`). */
export const LAND_ATTEMPTS_MAX = 2;
/** A landing that threw (git or the host unavailable) is run again by the tick; the third throw in a row is `blocked`. */
export const LAND_ERRORS_MAX = 3;

/** Root mark and status-message suffix of a closed lane, by where its landing stands. */
const CLOSED_MARKS: Record<LaneLand["state"], readonly [mark: string, waiting: string]> = {
	pending: ["🔍", "머지 대기"],
	blocked: ["🔍", "머지 막힘"],
	landed: ["✅", ""],
	"merged-not-pushed": ["⚠️", "머지됨 · push 안 됨"],
	discarded: ["🗑", "폐기"],
};

const pauseButton = (name: string): ActionButton => ({
	actionId: lanePauseActionId(name),
	label: "⏸ 멈춤",
	value: name,
});

const resumeButton = (name: string): ActionButton => ({
	actionId: laneResumeActionId(name),
	label: "▶ 재개",
	value: name,
	style: "primary",
});

const MAX_TITLE_CHARS = 120;
/** A lane's review files: the diff, the reviewer's `--config` overlay and its empty cwd directory. */
const REVIEW_FILE_SUFFIXES = [".diff", ".omp.yml", ".cwd"] as const;
const MAX_MILESTONE_CHARS = 300;
const MAX_BRIEF_CHARS = 16_000;

/** The request itself is wrong (bad title or path); the message is shown to the owner. */
export class LaneInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LaneInputError";
	}
}

export class LaneCapError extends LaneInputError {
	constructor(max: number) {
		super(`동시 작업 레인 상한(${max}개)에 도달했습니다. 진행 중인 레인이 완료·종료된 뒤 다시 시작하세요.`);
		this.name = "LaneCapError";
	}
}

/** What settling a claim reports: the owner-facing text, plus the registry's row when the settle transitioned the lane. */
interface SettleOutcome {
	text: string;
	/** The post-transition row; absent when the settle left the registry as it found it. */
	row?: LaneRow;
}

/** What a merge or discard request did: `handled` false = the lane was not in a state that takes it (nothing changed). */
export interface LaneRequestOutcome {
	handled: boolean;
	/** One owner-facing line. */
	text: string;
}

/** What the lane tools answer on a closed lane: nothing changed, and the owner's `!reopen` is the way back to work. */
const CLOSED_LANE_REPLY =
	"is closed: nothing was recorded. Answer only; if changes are needed, ask the owner to write `!reopen <지시>` in this lane's thread.";

/** What the lane tools answer while the owner holds the lane: nothing is recorded until the owner resumes it. */
const PAUSED_LANE_REPLY =
	"is paused: nothing was recorded. The owner resumes this lane (`계속` here or the ▶ button) before it works again.";

/** A verdict git or the check host could not finish now: the claim stays pending for the tick after the grace. */
const DEFERRED_REPLY = "검증을 지금 끝내지 못했습니다. 코어가 5분 안에 다시 확인합니다.";
/** A claim that arrived while the lane's verdict ran: judged the moment that verdict ends. */
const OVERLAP_REPLY = "검증이 돌고 있어 끝나는 대로 새 클레임을 바로 판정합니다.";
/** The core stopped while the checks ran: nothing is recorded; the tick after the restart judges the claim again. */
const STOPPED_REPLY = "코어가 멈춰 검사를 중단했습니다. 다시 시작한 뒤 코어가 다시 판정합니다.";
const CHECK_DETAIL_MAX = 120;

export interface LaneManagerDeps {
	store: Store;
	channels: ChannelRegistry;
	clock: MailboxClock;
	/** The bot's zone (`config.timezone`): a lane id carries the date of this zone's calendar day. */
	timezone: string;
	log: Logger;
	sessionsRoot: string;
	/** Hands a record to the mailbox of `record.originKey`; resolves once it has been dispatched. */
	route(record: InboundRecord): Promise<void>;
	/** Stops the lane's omp child after its running turn (the lane is closed). */
	stopWhenIdle(originKey: string): Promise<void>;
	/** Stops the lane's running turn for a pause: aborts and settles it; resolves with the re-read state. */
	pauseTurn(originKey: string): Promise<PauseCheck>;
	/** Dispatches the rows that piled up while the lane was held (the owner resumed it). */
	resumePending(originKey: string): Promise<void>;
	maxLanes?: number;
	/** Freeze switch (`<home>/FROZEN`): while it returns a state no lane starts. */
	frozen?: () => FreezeState | undefined;
	/** Test seam; default checks the real git repository. */
	verify?: (evidence: ClaimEvidence, cwd: string, baseSha?: string, baseBranch?: string) => Promise<VerifyResult>;
	/** Test seam; default reads the lane's `git diff` from the merge-base with its base branch (`collectLaneDiff`). */
	collectDiff?: (laneCwd: string, range: LaneDiffRange, sha: string) => Promise<string>;
	/** Test seam; default judges the claim's summary + diff (hermes completion_integrity). */
	integrity?: (input: IntegrityInput) => IntegrityRefusal[];
	/** Worktree creation and `[check: …]` runs on this machine (test seam; default `createTaskHostOps()`). */
	hostOps?: TaskHostOps;
	/** Owner approval surface: an integrity refusal can be overridden by an explicit click. */
	approvals?: { request(channel: string, summary: string): Promise<"approved" | "denied" | "timeout"> };
	/** Joins `<sessionsRoot>/<origin>/e1` the way `sessionDirFor` does (injected to keep this module free of origin.ts). */
	sessionDirFor: (originKey: string) => string;
	/** `taskAutoLand`, read at each close (a live setting); `undefined` → every closed lane waits for the owner. */
	autoLandPolicy?: () => AutoLandPolicy | undefined;
	/** Whether the repository at `path` is one of `repos` (test seam; default the git common-directory comparison). */
	repoMatches?: (path: string, repos: readonly string[]) => Promise<boolean>;
	/** Lands a closed lane (test seam; default `createLaneLander` over real git and `hostOps.removeWorktree`). */
	land?: LandLane;
	/** Mentioned on cards that need the owner's decision: one id, or the owner's id on the lane's platform. */
	ownerUserId?: string | ((platform: IdPlatform) => string | undefined);
	/**
	 * Whether the lane's session is in a turn right now (the one that made the claim still writes its closing report).
	 * A landing or discard removes the worktree that turn runs in, so it waits for the turn to end. Default: never busy.
	 */
	laneBusy?: (originKey: string) => boolean;
	/**
	 * How the independent review (`taskAutoLand.review`) runs `omp -p`: the omp binary, the safety floors, and
	 * `<ompbot home>/reviews` for the diff files. Absent: a review policy finds no reviewer (`inconclusive`).
	 */
	reviewer?: Omit<LaneReviewDeps, "headOf" | "now">;
	/** Git for the Outcome card's change summary (test seam; default 10 seconds per call, `computeLaneChanges`). */
	changesGit?: GitRunner;
}

function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9가-힣]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
	return slug === "" ? "lane" : slug;
}

/**
 * Work lanes: one omp session per long task with its own Slack thread, a registry row and a verified end.
 * The Slack root message reads `🔄 title` while the lane is open and `✅ title` once a done claim passed the
 * core's own git check; `⏳ title · mm:ss` in the thread is the status message edited in place.
 */
export class LaneManager {
	readonly #deps: LaneManagerDeps;
	readonly #max: number;
	#starting = 0;
	/** Lane ids of starts that picked an id but have no registry row yet (two starts never take the same id). */
	readonly #reservedLaneIds = new Set<string>();
	/** Lane names a start picked before its row exists (the status message is posted in between). */
	readonly #reservedNames = new Set<string>();
	readonly #settling = new Set<string>();
	/** Lanes that claimed again while their verdict ran: judged again as soon as it ends. */
	readonly #resettle = new Set<string>();
	/** Verdicts started without awaiting them (by the tick, or a claim that overlapped a verdict). */
	readonly #settlesInBackground = new Set<Promise<void>>();
	/** A tick verdict that was deferred judges the same claim (`claimedAt`) again only from `at` (memory only). */
	readonly #nextSettleAt = new Map<string, { claimedAt: number; at: number }>();
	/** One `[check: …]` run at a time across all lanes: the tail of the queue for the check slot. */
	#checkSlotTail: Promise<void> = Promise.resolve();
	/** The running checks' abort switches (`stop()` pulls them). */
	readonly #checkAborts = new Set<AbortController>();
	#stopped = false;
	readonly #ops: TaskHostOps;
	readonly #land: LandLane;
	/** Lanes whose merge or discard is running in this process: a second request (a double click) does nothing. */
	readonly #landing = new Set<string>();
	/** Lanes whose Outcome card is being posted (a close and a tick never post two). */
	readonly #announcing = new Set<string>();
	/** Work started without awaiting it (the card and auto-merge after a close); `idle()` waits for it. */
	readonly #background = new Set<Promise<void>>();
	/** Lanes whose independent review is running (in the background: a tick never waits for one). */
	readonly #reviewing = new Set<string>();
	/** One review at a time across all lanes: the tail of the queue for the review slot. */
	#reviewSlotTail: Promise<void> = Promise.resolve();

	constructor(deps: LaneManagerDeps) {
		this.#deps = deps;
		this.#max = deps.maxLanes ?? DEFAULT_MAX_LANES;
		this.#ops = deps.hostOps ?? createTaskHostOps();
		const ops = this.#ops;
		this.#land = deps.land ?? createLaneLander({ removeWorktree: (input) => ops.removeWorktree(input) });
	}

	/** Resolves once the background work started so far (Outcome cards, auto-merges) has finished. */
	async idle(): Promise<void> {
		while (this.#background.size > 0) await Promise.all([...this.#background]);
	}

	/** Tests only: resolves once the verdicts running in the background (and those they started) have ended. */
	async settledInBackground(): Promise<void> {
		while (this.#settlesInBackground.size > 0) await Promise.all([...this.#settlesInBackground]);
	}

	/**
	 * The core is stopping: running checks and reviews are killed (their results are not recorded) and no new one starts. The
	 * verdicts themselves are not awaited — the claim stays in the registry and the tick after the restart judges it.
	 */
	stop(): void {
		this.#stopped = true;
		for (const abort of this.#checkAborts) abort.abort();
	}

	/**
	 * Starts `#settle` without awaiting it. A tick verdict that ended deferred on the same claim is not started by the
	 * tick again before `CLAIM_GRACE_MS`; a throw is logged, never left unhandled.
	 */
	#settleInBackground(name: string, fromTick: boolean): void {
		const { store, clock, log } = this.#deps;
		const claimedAt = store.getLane(name)?.meta.claim?.claimedAt;
		const run: Promise<void> = this.#settle(name, fromTick)
			.then((outcome) => {
				if (!fromTick || outcome.text !== DEFERRED_REPLY || claimedAt === undefined) return;
				const lane = store.getLane(name);
				if (lane?.status === "done-claimed" && lane.meta.claim?.claimedAt === claimedAt) {
					this.#nextSettleAt.set(name, { claimedAt, at: clock.now() + CLAIM_GRACE_MS });
				}
			})
			.catch((error: unknown) => log.error("lane_tick_failed", { lane: name, error: String(error) }))
			.finally(() => this.#settlesInBackground.delete(run));
		this.#settlesInBackground.add(run);
	}

	/** Waits for the check slot (one check run at a time across lanes); the returned function frees it. */
	async #checkSlot(): Promise<() => void> {
		const previous = this.#checkSlotTail;
		const freed = Promise.withResolvers<void>();
		this.#checkSlotTail = previous.then(() => freed.promise);
		await previous;
		return freed.resolve;
	}

	/** Waits for the review slot (one independent review at a time across lanes); the returned function frees it. */
	async #reviewSlot(): Promise<() => void> {
		const previous = this.#reviewSlotTail;
		const freed = Promise.withResolvers<void>();
		this.#reviewSlotTail = previous.then(() => freed.promise);
		await previous;
		return freed.resolve;
	}

	/** The claim `lane` was read with is no longer the lane's pending claim (the owner answered, or it claimed again). */
	#claimSuperseded(lane: LaneRow): SettleOutcome | undefined {
		const current = this.#deps.store.getLane(lane.name);
		if (current?.status === "done-claimed" && current.meta.claim?.claimedAt === lane.meta.claim?.claimedAt) {
			return undefined;
		}
		return { text: "claim superseded by the owner" };
	}

	#spawn(lane: string, work: () => Promise<void>): void {
		const run: Promise<void> = work()
			.catch((error: unknown) => this.#deps.log.error("lane_background_failed", { lane, error: String(error) }))
			.finally(() => this.#background.delete(run));
		this.#background.add(run);
	}

	get store(): Store {
		return this.#deps.store;
	}

	/**
	 * Creates the lane's worktree and branch, the thread, the registry row and starts the lane's first turn. The lane
	 * works in `<repo>-l-yyyymmdd-nn` on `lane/L-YYYYMMDD-NN`, at the same sub path `cwd` had in its repository; the
	 * repository's own checkout is never touched, so several lanes can run on one repository. `acceptance` and `risk`
	 * arrive as the tool received them and are validated here. Throws `LaneInputError` for a refusal (nothing created).
	 */
	async start(input: {
		title: string;
		cwd: string;
		brief?: string | undefined;
		channel: string;
		acceptance?: unknown;
		risk?: unknown;
	}): Promise<LaneRow> {
		const { store, channels, clock, log } = this.#deps;
		const frozen = this.#deps.frozen?.();
		if (frozen !== undefined) {
			log.warn("lane_refused_frozen", { channel: input.channel });
			throw new LaneInputError(frozenMessage(frozen));
		}
		const title = redact(input.title.replace(/\s+/g, " ").trim()).slice(0, MAX_TITLE_CHARS);
		if (title === "") throw new LaneInputError("작업 제목이 비어 있습니다.");
		const risk = parseLaneRisk(input.risk);
		if (!risk.ok) throw new LaneInputError(risk.problem);
		const acceptance = parseLaneAcceptance(input.acceptance);
		if (!acceptance.ok) throw new LaneInputError(acceptance.problem);
		// Kept for the independent review: the spec it reads first.
		const brief = redact(input.brief?.trim() ?? "").slice(0, MAX_BRIEF_CHARS);
		if (!isAbsolute(input.cwd)) throw new LaneInputError(`프로젝트 경로는 절대경로여야 합니다: ${input.cwd}`);
		let cwd: string;
		try {
			cwd = realpathSync(input.cwd);
			if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
		} catch {
			throw new LaneInputError(`프로젝트 경로가 디렉터리가 아니거나 없습니다: ${input.cwd}`);
		}
		const found = await resolveLaneRepo(cwd);
		if (!found.ok) throw new LaneInputError(found.problem);
		const { repo, baseBranch, sub } = found.value;
		const branchIds = await laneIdsOnBranches(repo);
		if (store.countOpenLanes() + this.#starting >= this.#max) throw new LaneCapError(this.#max);

		// No await between picking the id and reserving it: a concurrent start sees the reservation.
		const rowIds = new Set(
			store.listLanes().flatMap((lane) => (lane.meta.laneId === undefined ? [] : [lane.meta.laneId])),
		);
		const laneId = nextLaneId(
			localDay(clock.now(), this.#deps.timezone),
			(id) =>
				rowIds.has(id) || branchIds.has(id) || this.#reservedLaneIds.has(id) || existsSync(worktreePathOf(repo, id)),
		);
		const worktree = worktreePathOf(repo, laneId);
		const branch = laneBranchOf(laneId);
		// Root and status are mrkdwn: the model's title must not mention anyone (`<!channel>` stays text).
		const shown = escapeMrkdwn(title);
		this.#starting += 1;
		this.#reservedLaneIds.add(laneId);
		let created = false;
		let reservedName: string | undefined;
		// Set once the root is up: a later failure turns it into ❌ so no 🔄 root is left behind.
		let rootRef: MessageRef | undefined;
		let lane: LaneRow;
		try {
			const made = await this.#ops.createWorktree({ repo, worktree, branch });
			if (!made.ok) throw new LaneInputError(`레인 worktree를 만들지 못했습니다: ${made.error}`);
			created = true;
			const baseSha = await resolveBaseSha(worktree);
			if (baseSha === undefined) throw new Error(`cannot read HEAD of the new worktree ${worktree}`);
			const laneCwd = sub === "" ? worktree : join(worktree, sub);
			// An untracked sub directory of the repository is not in the worktree; an empty one changes no git status.
			mkdirSync(laneCwd, { recursive: true });
			const port = channels.portFor(input.channel);
			const root = await port.post({ conversationId: input.channel }, { text: `🔄 ${shown}` });
			rootRef = { platform: port.platform, conversationId: input.channel, messageId: root.messageId };
			// Discord: the lane thread is started from the root (its id is the root's), so the status goes inside it.
			if (port.openThread !== undefined) await port.openThread(rootRef, title);
			// No await between picking the name and reserving it (like the lane id above).
			const name = this.#uniqueName(slugify(title));
			this.#reservedNames.add(name);
			reservedName = name;
			// The status message carries the ⏸ button from the very first draw; `#sync` keeps it on every edit.
			const status = await port.post(
				{ conversationId: input.channel, threadId: root.messageId },
				{ text: `⏳ ${shown} · ${formatElapsed(0)}`, buttons: [pauseButton(name)] },
			);
			const originKey = laneOriginKey(name);
			const now = clock.now();
			lane = store.insertLane({
				name,
				title,
				threadRef: `${input.channel}:${root.messageId}`,
				originKey,
				cwd: laneCwd,
				sessionDir: this.#deps.sessionDirFor(originKey),
				meta: {
					statusTs: status.messageId,
					startedAt: now,
					lastProgressAt: now,
					renderedRoot: `🔄 ${shown}`,
					renderedStatus: `⏳ ${shown} · ${formatElapsed(0)}`,
					steerSeq: 0,
					baseSha,
					laneId,
					repo,
					worktree,
					branch,
					baseBranch,
					risk: risk.value,
					acceptance: acceptance.value,
					...(brief === "" ? {} : { brief }),
				},
			});
		} catch (error) {
			// The root stays in the channel and says the lane never started.
			if (rootRef !== undefined) {
				await channels
					.portFor(input.channel)
					.edit(rootRef, { text: `❌ ${shown}` })
					.catch((editError: unknown) =>
						log.warn("lane_root_edit_failed", { channel: input.channel, error: String(editError) }),
					);
			}
			// A refused or failed start leaves no worktree and no branch behind.
			if (created) await this.#ops.removeWorktree({ repo, worktree, branch });
			throw error;
		} finally {
			this.#starting -= 1;
			this.#reservedLaneIds.delete(laneId);
			if (reservedName !== undefined) this.#reservedNames.delete(reservedName);
		}
		log.info("lane_started", { lane: lane.name, origin: lane.originKey, cwd: lane.cwd, branch });
		// The first turn runs in the background: the owner's reply must not wait for omp to start.
		this.#send(
			lane.name,
			"start",
			buildLanePrompt({
				name: lane.name,
				title,
				cwd: lane.cwd,
				brief: input.brief,
				branch,
				baseBranch,
				acceptance: acceptance.value,
			}),
		);
		return lane;
	}

	#uniqueName(base: string): string {
		let name = base;
		for (let n = 2; this.#deps.store.getLane(name) || this.#reservedNames.has(name); n += 1) name = `${base}-${n}`;
		return name;
	}

	/** Feeds a core-authored message (first prompt, not-done reasons) into the lane's mailbox without awaiting it. */
	#send(name: string, kind: string, text: string): void {
		const lane = this.#deps.store.getLane(name);
		if (!lane) return;
		// Held: nothing is steered into a paused lane (the resume word goes after the transition back).
		if (lane.status === "paused") {
			this.#deps.log.warn("lane_send_held_paused", { lane: name, kind });
			return;
		}
		const seq = lane.meta.steerSeq + 1;
		this.#deps.store.patchLane(name, undefined, { steerSeq: seq });
		this.#deps
			.route({
				platformMessageId: `lane:${name}:${kind}:${seq}`,
				originKey: lane.originKey,
				ownerVerified: true,
				text,
				threadRef: lane.threadRef,
			})
			.catch((error: unknown) => this.#deps.log.error("lane_send_failed", { lane: name, kind, error: String(error) }));
	}

	/**
	 * The owner wrote in the lane's thread. On a closed lane only `!reopen` reopens it (same recorded session, root 🔄
	 * again); a question is answered by the lane session while the lane stays closed — an answer-only turn makes no
	 * commit, so a reopened lane could never leave `working` again — and a control command (`!model`, `!new`…) is
	 * neither. A pending claim is answered by the message, so it no longer auto-closes.
	 */
	onOwnerMessage(lane: LaneRow, text = ""): void {
		const { store, clock } = this.#deps;
		const closedAs = lane.status === "closed" ? classifyClosedLaneMessage(text, lane.meta.land?.state) : undefined;
		// `머지해`/`폐기해` are settled by the caller (`requestLand`, `discard`), and a lane whose worktree is gone
		// (`reopenRefusal`) cannot be reopened: neither changes the lane here.
		if (closedAs === "land" || closedAs === "discard") return;
		if (closedAs === "question") {
			store.patchLane(lane.name, { event: "owner_question" }, {});
		} else if (closedAs === "reopen") {
			if (this.reopenRefusal(lane) !== undefined) return;
			const now = clock.now();
			const reopened = store.transitionLane(
				lane.name,
				"working",
				{ event: "reopened" },
				{
					startedAt: now,
					lastProgressAt: now,
					milestone: undefined,
					claim: undefined,
					sha: undefined,
					baseSha: lane.meta.sha ?? lane.meta.baseSha,
					land: undefined,
					review: undefined,
					changes: undefined,
				},
			);
			this.#deps.log.info("lane_reopened", { lane: lane.name });
			this.#dropReviewFiles(reopened);
			void this.#sync(reopened, "transition");
			const cardTs = lane.meta.land?.cardTs;
			if (cardTs !== undefined) {
				this.#spawn(lane.name, () =>
					this.#editCard(reopened, cardTs, { kind: "rework", reason: "오너가 레인을 다시 열었습니다." }),
				);
			}
		} else if (lane.status === "done-claimed") {
			store.transitionLane(lane.name, "working", { event: "owner_reply" }, { claim: undefined });
		}
	}

	/**
	 * The owner stops this one lane (`멈춰` in the thread or the ⏸ button). The registry goes to `paused` first —
	 * everything downstream (steers, verdicts, the mailbox's dispatch hold) reads the row, so a restart keeps it —
	 * then the running turn is aborted. The answer is written only from state re-read after the stop: registry
	 * `paused`, no turn, the driver settled; anything still off is named, and the owner asking again retries the stop.
	 */
	async pause(name: string, by: "owner-message" | "button"): Promise<LaneRequestOutcome> {
		const { store, clock, log } = this.#deps;
		const lane = store.getLane(name);
		if (lane === undefined) return { handled: false, text: `레인을 찾지 못했습니다: ${name}` };
		// A closed lane has no turn to stop: only its auto-merge is held; `머지해` and the buttons keep working.
		if (lane.status === "closed") {
			const land = lane.meta.land;
			if (land === undefined || (land.state !== "pending" && land.state !== "blocked")) {
				return { handled: false, text: "이 레인은 이미 완료(closed)되어 멈출 턴이 없습니다." };
			}
			if (this.#landing.has(name)) {
				return { handled: false, text: "머지가 이미 진행 중이라 보류하지 못했습니다." };
			}
			// An auto-merge that already began and waits for the lane's turn is withdrawn with it: the card asks again.
			const withdrawn = land.requestedBy === "auto";
			if (land.autoLandHeld === undefined || withdrawn) {
				const held = this.#patchLand(
					name,
					{ autoLandHeld: land.autoLandHeld ?? OWNER_PAUSE_HELD, ...(withdrawn ? { requestedBy: undefined } : {}) },
					{ event: "auto_land_held", detail: OWNER_PAUSE_HELD },
				);
				const cardTs = held.meta.land?.cardTs;
				if (withdrawn && cardTs !== undefined) {
					await this.#editCard(held, cardTs, {
						kind: "ask",
						ownerUserId: this.#ownerOf(held),
						skipped: [OWNER_PAUSE_HELD],
					});
				}
			}
			return {
				handled: true,
				text: "⏸ 레인이 이미 완료되어 멈출 턴이 없습니다. 자동 머지만 보류합니다 — `머지해`·`머지` 버튼은 계속 동작합니다.",
			};
		}
		if (lane.status !== "paused") {
			const paused = store.transitionLane(
				name,
				"paused",
				{ event: "paused", detail: by },
				{ pausedFrom: lane.status, pausedAt: clock.now(), pausedBy: by },
			);
			log.info("lane_paused", { lane: name, from: lane.status, by });
			await this.#sync(paused, "transition");
		}
		// An owner asking again retries the stop itself: a first abort may not have taken.
		const check = await this.#deps.pauseTurn(lane.originKey);
		const wrong: string[] = [];
		if (store.getLane(name)?.status !== "paused") wrong.push("레인 paused 아님");
		if (check.busy) wrong.push("턴이 아직 있음");
		if (!check.settled) wrong.push("omp settled 아님");
		if (wrong.length > 0) {
			log.warn("lane_pause_unconfirmed", { lane: name, wrong: wrong.join(",") });
			return {
				handled: true,
				text: `⚠️ 멈추지 못했습니다: ${wrong.join(" · ")} — 레인은 paused로 두었습니다. 다시 말하면 다시 끊습니다.`,
			};
		}
		return { handled: true, text: "⏸ 멈췄습니다 (확인: 레인 paused · 턴 없음 · omp settled)" };
	}

	/**
	 * The owner gives the lane back (`계속` or the ▶ button) — the only path out of `paused`. The lane returns to
	 * where it was (`not-done` as `working`), a resumed claim gets its grace anew, what piled up while held is
	 * dispatched now, and the answer rests only on the re-read registry.
	 */
	async resume(name: string, by: "owner-message" | "button"): Promise<LaneRequestOutcome> {
		const { store, clock, log } = this.#deps;
		const lane = store.getLane(name);
		if (lane?.status !== "paused") {
			return { handled: false, text: `멈춘 레인이 아닙니다 (${lane?.status ?? "레인 없음"}).` };
		}
		// An owner message held under the pause answers a pending claim exactly like one sent while it was pending
		// (`onOwnerMessage`): the lane comes back working and the claim no longer closes it.
		const answered = store.listInbound({ originKey: lane.originKey, state: "pending" }).length > 0;
		const back: LaneStatus = lane.meta.pausedFrom === "done-claimed" && !answered ? "done-claimed" : "working";
		const patch: Partial<LaneMeta> = { pausedFrom: undefined, pausedAt: undefined, pausedBy: undefined };
		if (back === "done-claimed" && lane.meta.claim !== undefined) {
			patch.claim = { ...lane.meta.claim, claimedAt: clock.now() };
		} else if (lane.meta.pausedFrom === "done-claimed") {
			patch.claim = undefined;
		}
		const resumed = store.transitionLane(name, back, { event: "resumed", detail: by }, patch);
		log.info("lane_resumed", { lane: name, to: back, by });
		await this.#sync(resumed, "transition");
		await this.#deps.resumePending(lane.originKey);
		// The resume word itself follows the held messages; a freeze holds it like any other steer.
		const frozen = this.#deps.frozen?.() !== undefined;
		if (frozen) log.warn("lane_send_held_frozen", { lane: name });
		else this.#send(name, "resume", "[ompbot] 오너가 재개했습니다. 멈추기 전 작업을 이어 하세요.");
		if (store.getLane(name)?.status === "paused") {
			return { handled: true, text: "⚠️ 재개하지 못했습니다: 레인이 여전히 paused입니다." };
		}
		return {
			handled: true,
			text: `▶ 재개했습니다${frozen ? " — 동결 중이라 재개 안내는 보내지 않았습니다. 동결이 풀린 뒤 이 스레드에 지시를 쓰세요" : ""}`,
		};
	}

	/**
	 * The mailbox reports a held lane's driver working on its own (a queued message omp started without a turn).
	 * The thread is warned once per pause (`pausedAt` is the key, so a restart stays quiet too) and the stop is
	 * retried once more.
	 */
	onHeldWork(originKey: string): void {
		const { store, clock, log } = this.#deps;
		const lane = store.getLaneByOrigin(originKey);
		if (lane?.status !== "paused") return;
		const key = `lane_paused_work:${lane.name}:${lane.meta.pausedAt ?? 0}`;
		const warned = store.getCursor(key) !== undefined;
		if (!warned) store.setCursor(key, String(clock.now()));
		log.warn("lane_paused_working", { lane: lane.name, warned });
		this.#spawn(lane.name, async () => {
			if (!warned) await this.#postInThread(lane, "⚠️ 멈춘 레인이 다시 작업을 시작했습니다 — 다시 멈췄습니다");
			await this.pause(lane.name, "owner-message");
		});
	}

	/** One plain line in the lane's thread (warnings); a failure is logged, never thrown. */
	async #postInThread(lane: LaneRow, text: string): Promise<void> {
		const route = this.#deps.channels.forThreadRef(lane.threadRef);
		if (route === undefined) return;
		try {
			await route.port.post(route.target, { text });
		} catch (error) {
			this.#deps.log.warn("lane_thread_post_failed", { lane: lane.name, error: String(error) });
		}
	}

	/** Milestone report from the lane (`ompbot_lane_progress`): recorded and shown in the status message at once. */
	async progress(originKey: string, text: string): Promise<string> {
		const lane = this.#requireLane(originKey);
		if (lane.status === "closed") return `lane ${lane.name} ${CLOSED_LANE_REPLY}`;
		if (lane.status === "paused") return `lane ${lane.name} ${PAUSED_LANE_REPLY}`;
		const milestone = redact(text.replace(/\s+/g, " ").trim()).slice(0, MAX_MILESTONE_CHARS);
		if (milestone === "") throw new Error("text is required");
		const patched = this.#deps.store.patchLane(lane.name, { event: "progress", detail: milestone }, { milestone });
		await this.#sync(patched, "milestone");
		return "progress recorded";
	}

	/** The lane says it is done. The core decides with git, not with the lane's word. */
	async claimDone(originKey: string, evidence: ClaimEvidence): Promise<string> {
		const { store, clock } = this.#deps;
		const lane = this.#requireLane(originKey);
		if (lane.status === "closed") return `lane ${lane.name} ${CLOSED_LANE_REPLY}`;
		if (lane.status === "paused") return `lane ${lane.name} ${PAUSED_LANE_REPLY}`;
		const claim = { ...evidence, claimedAt: clock.now() };
		const entry = { event: "claim", detail: `${evidence.repo}@${evidence.commit}: ${evidence.summary}` };
		if (lane.status === "done-claimed") store.patchLane(lane.name, entry, { claim });
		else store.transitionLane(lane.name, "done-claimed", entry, { claim });
		return (await this.#settle(lane.name)).text;
	}

	/**
	 * Verifies the pending claim. Closed when git agrees, `not-done` with reasons when not, still pending when git cannot
	 * run. `fromTick`: the core's own deferred verdict — when a freeze began while it ran, a not-done stays pending
	 * (could not be steered now) so the first tick after unfreeze judges it again. A claim made while the lane's verdict
	 * runs is judged right after that verdict ends (not after the grace).
	 */
	async #settle(name: string, fromTick = false): Promise<SettleOutcome> {
		const { store, log } = this.#deps;
		if (this.#settling.has(name)) {
			this.#resettle.add(name);
			return { text: OVERLAP_REPLY };
		}
		const lane = store.getLane(name);
		const claim = lane?.meta.claim;
		this.#settling.add(name);
		try {
			if (lane?.status !== "done-claimed" || !claim) return { text: "no pending claim" };
			let result: VerifyResult;
			try {
				result = await (this.#deps.verify ?? verifyClaim)(claim, lane.cwd, lane.meta.baseSha, lane.meta.baseBranch);
			} catch (error) {
				log.warn("lane_verify_unavailable", { lane: name, error: String(error) });
				store.patchLane(name, { event: "verify_unavailable", detail: String(error) }, {});
				return { text: DEFERRED_REPLY };
			}
			// The owner may have answered (back to working) while git ran: that claim is void.
			if (store.getLane(name)?.status !== "done-claimed") return { text: "claim superseded by the owner" };
			if (!result.ok) return this.#heldByFreeze(name, fromTick) ?? this.#notDone(lane, result.reasons);
			// Git proved the commit; the claim's own text and diff still have to read as finished work.
			const refusals = await this.#integrityRefusals(lane, claim, result.sha);
			// Awaited here: the `finally` must not clear `#settling` while the checks or the approval card still run.
			if (refusals.length === 0) return await this.#closeIfChecksPass(lane, result.sha, fromTick, false);
			return await this.#refusedByIntegrity(lane, result.sha, refusals, fromTick);
		} finally {
			this.#settling.delete(name);
			if (this.#resettle.delete(name)) {
				const current = store.getLane(name);
				if (current?.status === "done-claimed" && current.meta.claim?.claimedAt !== claim?.claimedAt) {
					this.#settleInBackground(name, false);
				}
			}
		}
	}

	/**
	 * Collects the lane's diff (from the merge-base with its base branch) and judges the claim text + diff. A base branch
	 * that cannot be read is a refusal of its own; any other unreadable diff degrades to text-only.
	 */
	async #integrityRefusals(lane: LaneRow, claim: LaneClaim, sha: string): Promise<IntegrityRefusal[]> {
		const classify = this.#deps.integrity ?? classifyLaneCompletion;
		const { baseSha, baseBranch } = lane.meta;
		let diff = "";
		if (baseSha !== undefined || baseBranch !== undefined) {
			try {
				diff = await (this.#deps.collectDiff ?? collectLaneDiff)(lane.cwd, { baseSha, baseBranch }, sha);
			} catch (error) {
				this.#deps.log.warn("lane_diff_unavailable", { lane: lane.name, error: String(error) });
				if (error instanceof LaneDiffUnavailable) {
					return [laneDiffUnavailableRefusal(error), ...classify({ summary: claim.summary, diff: "" })];
				}
			}
		}
		return classify({ summary: claim.summary, diff });
	}

	/**
	 * The claim reads unfinished: ask the owner (the final judge) with an approve button. Approved closes the lane
	 * anyway; denied, timed out, or no approval surface steers the remedies back as not-done.
	 */
	async #refusedByIntegrity(
		lane: LaneRow,
		sha: string,
		refusals: IntegrityRefusal[],
		fromTick: boolean,
	): Promise<SettleOutcome> {
		const { log, approvals } = this.#deps;
		const lines = refusals.map((r) => `- ${r.category}: ${r.excerpt}`);
		const channel = parseThreadRef(lane.threadRef)?.channel;
		let verdict: "approved" | "denied" | "timeout" = "timeout";
		if (approvals !== undefined && channel !== undefined) {
			try {
				verdict = await approvals.request(
					channel,
					`레인 ${lane.name} 완료 무결성 거부 — 승인하면 그대로 닫습니다.\n${lines.join("\n")}`,
				);
			} catch (error) {
				log.warn("lane_integrity_approval_failed", { lane: lane.name, error: String(error) });
			}
		}
		// The owner may have paused the lane, answered (back to working) or it claimed again while the card waited.
		const superseded = this.#claimSuperseded(lane);
		if (superseded !== undefined) return superseded;
		if (verdict === "approved") {
			log.warn("lane_integrity_overridden", { lane: lane.name, sha, refusals: refusals.length });
			return this.#closeIfChecksPass(lane, sha, fromTick, true);
		}
		log.info("lane_integrity_refused", { lane: lane.name, categories: refusals.map((r) => r.category).join(",") });
		const held = this.#heldByFreeze(lane.name, fromTick);
		if (held !== undefined) return held;
		return this.#notDone(
			lane,
			refusals.map((r) => `${r.category}: ${r.remedy}`),
		);
	}

	/**
	 * The last gate before `closed`: the `[check: …]` signals of the lane's acceptance run in its worktree, one at a
	 * time — and one lane's checks at a time across all lanes (the check slot) — at the claimed commit only (HEAD must
	 * be it, the tree clean). A failed check is not-done; a host that
	 * cannot run them leaves the claim pending for the tick after the grace. The results are recorded per HEAD, so the
	 * same commit is never checked twice — except a timed-out (inconclusive) one, which `#inconclusive` handles: run
	 * again once after the grace, then the owner decides. Lanes without a worktree (older rows) or without checks close
	 * on git alone.
	 */
	async #closeIfChecksPass(
		lane: LaneRow,
		sha: string,
		fromTick: boolean,
		integrityApproved: boolean,
	): Promise<SettleOutcome> {
		const { store, log, clock } = this.#deps;
		const held = integrityApproved ? INTEGRITY_APPROVED : undefined;
		const worktree = lane.meta.worktree;
		const requests = worktree === undefined ? [] : taskChecksOf(lane.meta.acceptance ?? []);
		if (worktree === undefined || requests.length === 0) return this.#close(lane, sha, held);
		const reasons: string[] = [];
		let inconclusive: TaskCheck[] = [];
		let tries: LaneChecksInconclusive | undefined;
		let capped = false;
		const abort = new AbortController();
		const notClaimedHead = (head: string) =>
			`HEAD가 클레임 커밋이 아님: worktree HEAD ${head}, 클레임 ${sha} — 클레임 커밋을 HEAD로 두고 다시 주장하세요`;
		try {
			const head = await this.#ops.headOf(worktree);
			if (head.sha !== sha) {
				reasons.push(notClaimedHead(head.sha));
			} else if (!head.clean) {
				reasons.push("미커밋 변경이 있어 check를 돌리지 않았습니다 — 모두 커밋한 뒤 다시 주장하세요");
			} else {
				const known = new Map<string, SignalCheck>();
				const recorded = lane.meta.checks;
				const prior = recorded?.inconclusive;
				// The HEAD whose timed-out checks had their last run: they are not run there again.
				const cappedAt = prior !== undefined && prior.runs >= INCONCLUSIVE_RUNS_MAX ? prior.head : undefined;
				// One check run at a time across lanes; git, the integrity read and approval cards stay outside the slot.
				const free = await this.#checkSlot();
				let run: TaskChecksRun;
				try {
					// The wait may have outlived the claim, a freeze may have begun, or the core may be stopping.
					const skip = this.#stopped
						? { text: STOPPED_REPLY }
						: (this.#claimSuperseded(lane) ?? this.#heldByFreeze(lane.name, fromTick));
					if (skip !== undefined) return skip;
					this.#checkAborts.add(abort);
					run = await runWorktreeChecks(
						this.#ops,
						worktree,
						(at) => {
							if (recorded?.head === at) {
								for (const r of recorded.results) {
									if (r.inconclusive && cappedAt !== at) continue;
									known.set(r.signal, {
										signal: r.signal,
										ok: r.ok,
										detail: r.detail,
										...(r.inconclusive ? { inconclusive: true as const } : {}),
									});
								}
							}
							return known;
						},
						requests,
						abort.signal,
					);
				} finally {
					this.#checkAborts.delete(abort);
					free();
				}
				if (abort.signal.aborted) return { text: STOPPED_REPLY };
				if ("deferred" in run) {
					reasons.push(run.deferred);
				} else {
					const failed = run.results.filter((result) => !result.ok && !result.inconclusive);
					inconclusive = run.results.filter((result) => result.inconclusive === true);
					capped = cappedAt === run.head;
					if (inconclusive.length > 0) {
						tries =
							capped && prior !== undefined
								? prior
								: { head: run.head, runs: (prior?.head === run.head ? prior.runs : 0) + 1, lastAt: clock.now() };
					}
					const passed = run.results.length - failed.length - inconclusive.length;
					store.patchLane(
						lane.name,
						{
							event: "checks",
							detail: `${passed}/${run.results.length} 통과${inconclusive.length > 0 ? ` · ${inconclusive.length} 확인 불가` : ""}`,
							sha: run.head,
						},
						{
							checks: { head: run.head, results: run.results, ...(tries === undefined ? {} : { inconclusive: tries }) },
						},
					);
					// A commit that landed between the two HEAD reads was checked instead of the claim: the claim is unproven.
					if (run.head !== sha) reasons.push(notClaimedHead(run.head));
					for (const check of failed) {
						reasons.push(`check ${check.id} 실패: ${check.detail.slice(0, CHECK_DETAIL_MAX)}`);
					}
				}
			}
		} catch (error) {
			// A check killed by `stop()` is no host failure: nothing is recorded.
			if (abort.signal.aborted) return { text: STOPPED_REPLY };
			log.warn("lane_checks_unavailable", { lane: lane.name, error: String(error) });
			store.patchLane(lane.name, { event: "checks_unavailable", detail: String(error) }, {});
			return { text: DEFERRED_REPLY };
		}
		// The owner may have answered (back to working) while the checks ran, and the lane may even have claimed again:
		// either way this claim is void.
		const superseded = this.#claimSuperseded(lane);
		if (superseded !== undefined) return superseded;
		if (reasons.length > 0) return this.#heldByFreeze(lane.name, fromTick) ?? this.#notDone(lane, reasons);
		if (tries !== undefined) return this.#inconclusive(lane, sha, inconclusive, tries.runs, capped, fromTick, held);
		return this.#close(lane, sha, held);
	}

	/**
	 * Only timed-out checks stand between the claim and `closed` (no violation): nothing is steered into the lane, which
	 * has nothing to fix. After the first such judgement at a HEAD the claim stays `done-claimed` and the tick runs the
	 * timed-out checks again after `CLAIM_GRACE_MS`; after the second the owner decides once with an approve button
	 * (as for an integrity refusal) — approved closes the lane, held from auto-merge; denied, timed out, or no approval
	 * surface is not-done. A HEAD whose card was already asked (`capped`) is not-done without asking again.
	 */
	async #inconclusive(
		lane: LaneRow,
		sha: string,
		checks: TaskCheck[],
		runs: number,
		capped: boolean,
		fromTick: boolean,
		held: string | undefined,
	): Promise<SettleOutcome> {
		const { log, approvals } = this.#deps;
		const limit = `${CHECK_TIMEOUT_MS / 1000}초 초과`;
		const refused = () =>
			this.#heldByFreeze(lane.name, fromTick) ??
			this.#notDone(
				lane,
				checks.map(
					(check) =>
						`check ${check.id} ${limit} ${INCONCLUSIVE_RUNS_MAX}회 — 오너가 닫지 않음. 검사를 빠르게 할 수 있으면 고쳐 새 커밋으로 다시 주장`,
				),
			);
		if (capped) return refused();
		const ids = checks.map((check) => check.id).join(", ");
		if (runs < INCONCLUSIVE_RUNS_MAX) {
			log.info("lane_checks_inconclusive", { lane: lane.name, sha, runs, checks: ids });
			return {
				text: `재실행 검사 확인 불가(${limit}): ${ids} — 위반은 없습니다. 코어가 ${CLAIM_GRACE_MS / 60_000}분 뒤 이 검사만 다시 돌립니다(같은 커밋에서 최대 ${INCONCLUSIVE_RUNS_MAX}회).`,
			};
		}
		const channel = parseThreadRef(lane.threadRef)?.channel;
		let verdict: "approved" | "denied" | "timeout" = "timeout";
		if (approvals !== undefined && channel !== undefined) {
			try {
				verdict = await approvals.request(
					channel,
					`레인 ${lane.name} 재실행 검사 확인 불가(${limit} ${INCONCLUSIVE_RUNS_MAX}회) — 승인하면 이 검사 없이 닫습니다.\n${checks
						.map((check) => `- check ${check.id}: ${check.signal}`)
						.join("\n")}`,
				);
			} catch (error) {
				log.warn("lane_inconclusive_approval_failed", { lane: lane.name, error: String(error) });
			}
		}
		// The owner may have answered (back to working) or the lane claimed again while the card waited.
		const superseded = this.#claimSuperseded(lane);
		if (superseded !== undefined) return superseded;
		if (verdict === "approved") {
			log.warn("lane_inconclusive_approved", { lane: lane.name, sha, checks: ids });
			return this.#close(lane, sha, held ?? INCONCLUSIVE_APPROVED);
		}
		log.info("lane_inconclusive_refused", { lane: lane.name, verdict, checks: ids });
		return refused();
	}

	/**
	 * `closed`: the claim is proven (`held`: the owner let it through, `INTEGRITY_APPROVED` or `INCONCLUSIVE_APPROVED`). A worktree lane now waits for its merge (`meta.land` pending): the Outcome card
	 * goes up in the background and, when `taskAutoLand` has no objection, the core lands it. A lane without a
	 * worktree (an older row) is simply done.
	 */
	async #close(lane: LaneRow, sha: string, held: string | undefined): Promise<SettleOutcome> {
		const { repo, worktree, branch, baseBranch } = lane.meta;
		const lands = repo !== undefined && worktree !== undefined && branch !== undefined && baseBranch !== undefined;
		const land: LaneLand = {
			state: "pending",
			// Refusals survive the trip back to `working`: the second not-ff landing goes to the owner.
			attempts: this.#deps.store.getLane(lane.name)?.meta.land?.attempts ?? 0,
			...(held === undefined ? {} : { autoLandHeld: held }),
		};
		const closed = this.#deps.store.transitionLane(
			lane.name,
			"closed",
			{ event: "closed", sha },
			{ sha, milestone: undefined, ...(lands ? { land } : {}) },
		);
		this.#deps.log.info("lane_closed", { lane: lane.name, sha });
		const rendered = await this.#sync(closed, "transition");
		// The turn that made the claim still delivers its closing report before the child stops.
		void this.#deps
			.stopWhenIdle(lane.originKey)
			.catch((error: unknown) => this.#deps.log.error("lane_stop_failed", { lane: lane.name, error: String(error) }));
		if (lands) this.#spawn(lane.name, () => this.#announce(lane.name));
		return {
			text: `검증 통과: 커밋 ${sha}. 레인 ${lane.name}을 닫았습니다.${lands ? ` ${branch}를 ${baseBranch}에 합치는 일은 코어와 오너가 합니다(스레드의 Outcome 카드).` : ""}`,
			row: rendered,
		};
	}

	/**
	 * The Outcome card of a closed lane whose landing nobody asked for yet. With `taskAutoLand` and no blocker the card
	 * is news and the core lands the lane at once; otherwise the card asks (`머지`·`폐기`), naming why it was not
	 * merged unasked. A card that could not be posted leaves the lane as it is: the next tick tries again, so nothing
	 * is merged under an announcement the owner never saw.
	 */
	async #announce(name: string): Promise<void> {
		const { store, log } = this.#deps;
		// A running review announces the lane itself when it ends.
		if (this.#announcing.has(name) || this.#landing.has(name) || this.#reviewing.has(name)) return;
		this.#announcing.add(name);
		try {
			const lane = store.getLane(name);
			const waiting = (row: LaneRow | undefined): row is LaneRow =>
				row?.status === "closed" &&
				row.meta.land?.state === "pending" &&
				row.meta.land.cardTs === undefined &&
				row.meta.land.requestedBy === undefined;
			if (!waiting(lane)) return;
			const policy = this.#deps.autoLandPolicy?.();
			let skipped: string[] | undefined;
			if (policy !== undefined) {
				const matched = await this.#repoMatches(lane.meta.repo ?? lane.cwd, policy.repos);
				const frozen = this.#deps.frozen?.() !== undefined;
				const { review, ...withoutReview } = policy;
				// Only a lane the review alone holds back is reviewed, and one commit only once (a restart keeps the receipt).
				if (
					review !== undefined &&
					lane.meta.review?.sha !== lane.meta.sha &&
					laneLandBlockers(lane, withoutReview, matched, frozen).length === 0
				) {
					// Up to 30 minutes: in the background, so the tick that announces never waits for it.
					this.#reviewing.add(name);
					this.#spawn(name, () => this.#review(name, review));
					return;
				}
				skipped = laneLandBlockers(lane, policy, matched, frozen);
			}
			const auto = skipped !== undefined && skipped.length === 0;
			// Once per claim commit (a restart keeps it): the row returned by the patch is what the first card shows.
			const shown = lane.meta.changes?.sha === lane.meta.sha ? lane : await this.#recordChanges(lane);
			const cardTs = await this.#postCard(
				shown,
				auto ? { kind: "auto" } : { kind: "ask", ownerUserId: this.#ownerOf(lane), skipped },
			);
			if (cardTs === undefined) return;
			// The owner may have reopened the lane while the card went up: then the card is already stale.
			const current = store.getLane(name);
			if (!waiting(current)) return;
			this.#patchLand(name, { cardTs });
			if (skipped !== undefined && !auto)
				log.info("lane_autoland_skipped", { lane: name, reasons: skipped.join(" | ") });
			if (!auto) return;
			// The owner's `멈춰` may have landed while the card went up: the merge then stays with the owner, and the
			// card that promised an auto-merge asks instead.
			const held = current.meta.land?.autoLandHeld;
			if (held === undefined) await this.requestLand(name, "auto");
			else await this.#editCard(current, cardTs, { kind: "ask", ownerUserId: this.#ownerOf(current), skipped: [held] });
		} finally {
			this.#announcing.delete(name);
		}
	}

	/**
	 * Records what the lane's claim commit changed and which unmerged lanes or base commits touched the same files, for
	 * the Outcome card only (nothing decides on it). A computation that throws is recorded as its `error`.
	 */
	async #recordChanges(lane: LaneRow): Promise<LaneRow> {
		const { store, log } = this.#deps;
		let changes: LaneChanges;
		try {
			changes = await computeLaneChanges(lane, store.listLanes(), this.#deps.changesGit);
		} catch (error) {
			changes = {
				sha: lane.meta.sha ?? "",
				files: 0,
				insertions: 0,
				deletions: 0,
				top: [],
				overlaps: [],
				baseDrift: [],
				error: String(error).slice(0, 200),
			};
		}
		if (changes.error !== undefined) log.warn("lane_changes_failed", { lane: lane.name, error: changes.error });
		// The owner may have reopened the lane while git ran: a reopened lane keeps no changes of its old commit.
		if (store.getLane(lane.name)?.meta.sha !== lane.meta.sha) return lane;
		return store.patchLane(lane.name, undefined, { changes });
	}

	/**
	 * Runs the independent review of the closed lane's claim commit (one review at a time across lanes) and records
	 * its receipt, then announces the lane again with it. A review killed by `stop()` records nothing (the tick after
	 * the restart reviews again); one whose lane moved on meanwhile (reopened) is not recorded either.
	 */
	async #review(name: string, review: { model: string; timeoutMs: number }): Promise<void> {
		const { store, log, clock } = this.#deps;
		const abort = new AbortController();
		let recorded = false;
		try {
			let receipt: LaneReview;
			const free = await this.#reviewSlot();
			try {
				const lane = store.getLane(name);
				if (this.#stopped || lane?.status !== "closed" || lane.meta.sha === undefined) return;
				this.#checkAborts.add(abort);
				const reviewer = this.#deps.reviewer;
				log.info("lane_review_started", { lane: name, sha: lane.meta.sha, model: review.model });
				receipt =
					reviewer === undefined
						? {
								sha: lane.meta.sha,
								verdict: "inconclusive",
								model: review.model,
								at: clock.now(),
								notes: "",
								reason: "리뷰 실행기 없음",
							}
						: await reviewLane(
								{ lane, model: review.model, timeoutMs: review.timeoutMs, signal: abort.signal },
								{ ...reviewer, headOf: (worktree) => this.#ops.headOf(worktree), now: () => clock.now(), log },
							);
			} finally {
				this.#checkAborts.delete(abort);
				free();
			}
			if (abort.signal.aborted) {
				log.info("lane_review_stopped", { lane: name });
				return;
			}
			const current = store.getLane(name);
			if (current?.meta.sha !== receipt.sha) {
				log.info("lane_review_stale", { lane: name, sha: receipt.sha });
				if (current !== undefined) this.#dropReviewFiles(current);
				return;
			}
			const label = receipt.verdict === "inconclusive" ? "확인 불가" : receipt.verdict;
			const row = store.patchLane(
				name,
				{ event: "review", detail: `${label} · ${receipt.model}`, sha: receipt.sha },
				{ review: receipt },
			);
			log.info("lane_reviewed", {
				lane: name,
				sha: receipt.sha,
				verdict: receipt.verdict,
				reason: receipt.reason ?? "",
			});
			// The owner merged or discarded it while the review ran: that landing's cleanup may have come first.
			const state = row.meta.land?.state;
			if (state !== "pending" && state !== "blocked") this.#dropReviewFiles(row);
			recorded = true;
		} finally {
			this.#reviewing.delete(name);
		}
		if (recorded) await this.#announce(name);
	}

	/**
	 * Removes the lane's review files (`<reviewsDir>/<laneId>-*.diff`, `-*.omp.yml` and the `-*.cwd` directories); a missing
	 * one is no error, a failure is logged.
	 */
	#dropReviewFiles(lane: LaneRow): void {
		const dir = this.#deps.reviewer?.reviewsDir;
		if (dir === undefined) return;
		const prefix = `${lane.meta.laneId ?? lane.name}-`;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				this.#deps.log.warn("lane_review_files_unreadable", { lane: lane.name, error: String(error) });
			}
			return;
		}
		for (const entry of entries) {
			if (!entry.startsWith(prefix) || !REVIEW_FILE_SUFFIXES.some((suffix) => entry.endsWith(suffix))) continue;
			try {
				rmSync(join(dir, entry), { force: true, recursive: true });
			} catch (error) {
				this.#deps.log.warn("lane_review_file_remove_failed", { lane: lane.name, file: entry, error: String(error) });
			}
		}
	}

	#repoMatches(path: string, repos: readonly string[]): Promise<boolean> {
		return (this.#deps.repoMatches ?? repoMatchesCommonDir)(path, repos);
	}

	/** Merges `patch` into the lane's `meta.land` (one history entry when given); the row as written. */
	#patchLand(
		name: string,
		patch: Partial<LaneLand>,
		entry?: { event: string; detail?: string; sha?: string },
	): LaneRow {
		const { store } = this.#deps;
		const current = store.getLane(name)?.meta.land ?? { state: "pending", attempts: 0 };
		return store.patchLane(name, entry, { land: { ...current, ...patch } });
	}

	/**
	 * Why `!reopen` cannot reopen this closed lane; `undefined` = it can. A landed, pushed-or-not, or discarded lane
	 * has no worktree left to work in, and a landing that is running must not lose its lane.
	 */
	reopenRefusal(lane: LaneRow): string | undefined {
		const land = lane.meta.land;
		if (lane.status !== "closed" || land === undefined) return undefined;
		if (this.#landing.has(lane.name)) return "머지가 진행 중이라 다시 열 수 없습니다. 끝난 뒤 다시 시도하세요.";
		if (land.state === "pending" || land.state === "blocked") return undefined;
		const done = land.state === "discarded" ? "폐기" : "머지";
		return `이 레인은 이미 ${done}되어 worktree가 없습니다. 이어서 할 일은 새 레인(\`작업: <제목> @<경로>\`)으로 시작하세요.`;
	}

	/**
	 * Lands a closed lane: the owner's `머지` button or `머지해` (`owner`, allowed while frozen — a freeze holds only
	 * what the bot does on its own), or `taskAutoLand` (`auto`). Only a `pending` or `blocked` landing takes it, and
	 * one lane lands once at a time. The owner's request always pushes `origin/<baseBranch>`; an auto-merge pushes
	 * because it only happens inside `taskAutoLand.repos`.
	 */
	async requestLand(name: string, by: "owner" | "auto"): Promise<LaneRequestOutcome> {
		const { store } = this.#deps;
		const lane = store.getLane(name);
		const land = lane?.meta.land;
		if (lane?.status !== "closed" || land === undefined || (land.state !== "pending" && land.state !== "blocked")) {
			return { handled: false, text: `머지할 상태가 아닙니다 (${land?.state ?? lane?.status ?? "레인 없음"}).` };
		}
		if (this.#landing.has(name)) return { handled: false, text: "이미 머지가 진행 중입니다." };
		this.#landing.add(name);
		try {
			// Recorded before any git runs: a restart finds the landing begun and the tick finishes it.
			this.#patchLand(
				name,
				{ state: "pending", requestedBy: by, reason: undefined },
				{ event: "land_requested", detail: by },
			);
			const queued = this.#deps.laneBusy?.(lane.originKey) === true;
			// The owner's click is answered on the card at once (the buttons go); an auto-merge card already says so.
			if (by === "owner" && land.cardTs !== undefined) {
				await this.#editCard(lane, land.cardTs, { kind: "merging", queued });
			}
			if (queued) {
				// The lane's own turn is still running in the worktree this landing removes: the tick lands it afterwards.
				this.#deps.log.info("lane_land_deferred", { lane: name, by, reason: "lane_turn_running" });
				return {
					handled: true,
					text: "⏳ 레인이 마무리 보고를 쓰는 중이라, 끝나는 대로 머지합니다. 결과는 이 스레드의 카드에 표시됩니다.",
				};
			}
			return { handled: true, text: await this.#runLanding(name, false) };
		} finally {
			this.#landing.delete(name);
		}
	}

	/**
	 * One run of a begun landing (`meta.land.requestedBy`), from the top: `landLane` skips what an earlier run already
	 * did. `resumed`: the tick picked it up after a restart or a failed run — nobody is watching the card, so a result
	 * that needs the owner goes up as a new card. Returns the owner-facing result line.
	 */
	async #runLanding(name: string, resumed: boolean): Promise<string> {
		const { store, log } = this.#deps;
		const lane = store.getLane(name);
		const land = lane?.meta.land;
		const { repo, worktree, branch, baseBranch, sha } = lane?.meta ?? {};
		if (
			lane === undefined ||
			land === undefined ||
			repo === undefined ||
			worktree === undefined ||
			branch === undefined ||
			baseBranch === undefined ||
			sha === undefined
		) {
			throw new Error(`lane ${name} has nothing to land`);
		}
		// Only a closed lane whose landing is still open is landed, whatever the caller read before.
		if (lane.status !== "closed" || land.state !== "pending") return "이 레인은 머지 대기 상태가 아닙니다.";
		const by = land.requestedBy ?? "owner";
		const policy = this.#deps.autoLandPolicy?.();
		const matched = policy !== undefined && (await this.#repoMatches(repo, policy.repos));
		// An auto-merge is judged once more right before git runs (the receipt, a hold or a freeze may have changed);
		// the owner's request is not — the owner is the reviewer then.
		if (by === "auto" && policy !== undefined) {
			const blockers = laneLandBlockers(lane, policy, matched, this.#deps.frozen?.() !== undefined);
			if (blockers.length > 0) {
				const row = this.#patchLand(
					name,
					{ requestedBy: undefined },
					{ event: "auto_land_withdrawn", detail: blockers.join(" | ") },
				);
				log.info("lane_autoland_skipped", { lane: name, reasons: blockers.join(" | ") });
				if (land.cardTs !== undefined) {
					await this.#editCard(row, land.cardTs, { kind: "ask", ownerUserId: this.#ownerOf(row), skipped: blockers });
				}
				return `자동 머지 안 함: ${blockers.join(" · ")}`;
			}
		}
		const push = by === "owner" || matched;
		// An auto-merge speaks up when it fails (nobody clicked anything); so does a landing the tick resumed.
		const unattended = by === "auto" || resumed;
		log.info("lane_land_started", { lane: name, by, push, resumed });
		let result: LandResult;
		try {
			// An idle child of this lane (it answered a question after closing) still has the worktree as its cwd.
			await this.#deps.stopWhenIdle(lane.originKey);
			result = await this.#land(
				{ repo, baseBranch, branch, worktree, sha, push },
				{ onMerged: (preSha) => void this.#patchLand(name, { preSha }) },
			);
		} catch (error) {
			const errors = (store.getLane(name)?.meta.land?.errors ?? 0) + 1;
			log.warn("lane_land_unavailable", { lane: name, errors, error: String(error) });
			if (errors < LAND_ERRORS_MAX) {
				this.#patchLand(name, { errors }, { event: "land_unavailable", detail: String(error).slice(0, 200) });
				return "⚠️ 머지를 끝내지 못했습니다(git 또는 호스트 오류). 코어가 곧 이어서 다시 시도합니다.";
			}
			result = { state: "blocked", reason: `머지를 ${errors}번 끝내지 못함: ${String(error).slice(0, 200)}` };
		}
		const short = sha.slice(0, 12);
		if (result.state === "not-ff") {
			const attempts = land.attempts + 1;
			if (attempts < LAND_ATTEMPTS_MAX) return this.#backToWork(lane, attempts, result.reason);
			result = {
				state: "blocked",
				reason: `${result.reason} — ${attempts}번째라 레인에 다시 맡기지 않았습니다. 직접 rebase하거나 \`!reopen\`·\`폐기\`로 정해 주세요.`,
			};
			this.#patchLand(name, { attempts });
		}
		if (result.state === "blocked") {
			const row = this.#patchLand(
				name,
				{ state: "blocked", reason: result.reason, requestedBy: undefined, errors: undefined },
				{ event: "land_blocked", detail: result.reason },
			);
			log.warn("lane_land_blocked", { lane: name, reason: result.reason });
			await this.#showResult(await this.#sync(row, "transition"), unattended);
			return `🚧 머지하지 못했습니다: ${result.reason}`;
		}
		// Merged. `"unknown"` only means this run found the merge done: keep what the run that merged recorded.
		const recorded = store.getLane(name)?.meta.land?.preSha;
		const preSha = result.preSha === "unknown" ? (recorded ?? "unknown") : result.preSha;
		const { cleanup } = result;
		if (cleanup !== undefined) log.warn("lane_cleanup_failed", { lane: name, sha, cleanup });
		const cleaned = cleanup === undefined ? "worktree 정리" : `⚠️ ${cleanup}`;
		if (result.state === "merged-not-pushed") {
			const row = this.#patchLand(
				name,
				{ state: "merged-not-pushed", preSha, reason: result.reason, errors: undefined, cleanup },
				{ event: "merged_not_pushed", detail: result.reason, sha },
			);
			log.warn("lane_merged_not_pushed", { lane: name, sha, reason: result.reason });
			this.#dropReviewFiles(row);
			await this.#showResult(await this.#sync(row, "transition"), unattended);
			return `⚠️ ${baseBranch}에 머지했지만 push origin/${baseBranch}는 되지 않았습니다: ${result.reason}${
				cleanup === undefined ? "" : ` · ${cleaned}`
			}`;
		}
		const row = this.#patchLand(
			name,
			{
				state: "landed",
				preSha,
				reason: undefined,
				errors: undefined,
				cleanup,
				...(result.pushed === undefined ? {} : { pushed: result.pushed }),
			},
			{ event: "landed", sha, ...(result.pushed === undefined ? {} : { detail: `push ${result.pushed}` }) },
		);
		log.info("lane_landed", { lane: name, sha, pushed: result.pushed ?? "none", by });
		this.#dropReviewFiles(row);
		await this.#showResult(await this.#sync(row, "transition"), false);
		return `✅ 머지했습니다: ${baseBranch} ← ${short} · ${result.pushed === undefined ? "push 없음(origin 원격 없음)" : `push ${result.pushed}`} · ${cleaned}`;
	}

	/**
	 * The base branch moved ahead of the claim: only the lane can rebase and resolve conflicts, so it goes back to
	 * `working` with that instruction. Its next claim runs the whole verdict (checks included) again.
	 */
	async #backToWork(lane: LaneRow, attempts: number, reason: string): Promise<string> {
		const { store, clock, log } = this.#deps;
		const now = clock.now();
		const cardTs = lane.meta.land?.cardTs;
		const working = store.transitionLane(
			lane.name,
			"working",
			{ event: "land_not_ff", detail: reason },
			{
				startedAt: now,
				lastProgressAt: now,
				milestone: undefined,
				claim: undefined,
				sha: undefined,
				changes: undefined,
				land: { state: "pending", attempts },
			},
		);
		log.info("lane_land_not_ff", { lane: lane.name, attempts });
		await this.#sync(working, "transition");
		// Frozen (only the owner's landing gets here then): no autonomous re-prompt into the lane, like resume.
		const frozen = this.#deps.frozen?.() !== undefined;
		if (cardTs !== undefined) {
			await this.#editCard(working, cardTs, {
				kind: "rework",
				reason: frozen
					? `${reason} — 동결 중이라 레인에 rebase 안내를 보내지 않았습니다.`
					: `${reason} — 레인이 \`${lane.meta.baseBranch}\` 위로 rebase하고 있습니다.`,
			});
		}
		if (frozen) {
			log.warn("lane_send_held_frozen", { lane: lane.name });
			return `🔄 머지하지 못했습니다: ${reason}. 동결 중이라 rebase 안내는 보내지 않았습니다 — 동결이 풀린 뒤 이 스레드에 rebase를 지시하세요.`;
		}
		this.#send(
			lane.name,
			"rebase",
			buildRebasePrompt({ branch: lane.meta.branch ?? "", baseBranch: lane.meta.baseBranch ?? "" }),
		);
		return `🔄 머지하지 못했습니다: ${reason}. 레인이 rebase한 뒤 다시 완료를 주장합니다.`;
	}

	/**
	 * Discards a closed lane unmerged (the owner's `폐기` button or `폐기해`): its worktree and branch go, the claim
	 * commit stays in the repository's object store until git prunes it. Only a `pending` or `blocked` landing takes it.
	 */
	async discard(name: string): Promise<LaneRequestOutcome> {
		const { store, log } = this.#deps;
		const lane = store.getLane(name);
		const land = lane?.meta.land;
		const { repo, worktree, branch } = lane?.meta ?? {};
		if (
			lane?.status !== "closed" ||
			land === undefined ||
			(land.state !== "pending" && land.state !== "blocked") ||
			repo === undefined ||
			worktree === undefined ||
			branch === undefined
		) {
			return { handled: false, text: `폐기할 상태가 아닙니다 (${land?.state ?? lane?.status ?? "레인 없음"}).` };
		}
		if (this.#landing.has(name)) return { handled: false, text: "머지가 진행 중이라 폐기할 수 없습니다." };
		if (land.requestedBy !== undefined) return { handled: false, text: "머지가 예약돼 있어 폐기할 수 없습니다." };
		if (this.#deps.laneBusy?.(lane.originKey) === true) {
			return { handled: false, text: "레인이 아직 마무리 보고를 쓰는 중입니다. 끝난 뒤 다시 시도해 주세요." };
		}
		this.#landing.add(name);
		try {
			// An idle child of this lane still has the worktree as its cwd.
			await this.#deps.stopWhenIdle(lane.originKey);
			await this.#ops.removeWorktree({ repo, worktree, branch });
			if (existsSync(worktree)) {
				log.warn("lane_discard_failed", { lane: name, worktree });
				return { handled: false, text: `worktree를 지우지 못했습니다: ${worktree}` };
			}
			const row = this.#patchLand(
				name,
				{ state: "discarded", reason: undefined, requestedBy: undefined },
				{ event: "discarded", ...(lane.meta.sha === undefined ? {} : { sha: lane.meta.sha }) },
			);
			log.info("lane_discarded", { lane: name });
			this.#dropReviewFiles(row);
			await this.#showResult(await this.#sync(row, "transition"), false);
			return {
				handled: true,
				text: `🗑 폐기했습니다: worktree와 브랜치 ${branch}를 지웠습니다(머지하지 않음). 커밋 ${(lane.meta.sha ?? "").slice(0, 12)}는 reflog에 남습니다.`,
			};
		} finally {
			this.#landing.delete(name);
		}
	}

	/** The owner to mention on the lane's cards: the one configured for the platform of the lane's thread. */
	#ownerOf(lane: LaneRow): string | undefined {
		const owner = this.#deps.ownerUserId;
		if (typeof owner !== "function") return owner;
		const platform = platformOfThreadRef(lane.threadRef);
		return platform === undefined ? undefined : owner(platform);
	}

	/**
	 * Link to the lane's thread where it is not the conversation the lane was asked from (a platform whose threads are
	 * opened apart, Discord); `undefined` on Slack or when the lookup fails (logged).
	 */
	async threadLink(lane: LaneRow): Promise<string | undefined> {
		const parsed = parseThreadRef(lane.threadRef);
		const route = parsed === undefined ? undefined : this.#deps.channels.forConversation(parsed.channel);
		if (parsed === undefined || route?.port.openThread === undefined) return undefined;
		try {
			return await route.port.permalink({
				platform: route.port.platform,
				conversationId: parsed.channel,
				messageId: parsed.threadTs,
				threadId: parsed.threadTs,
			});
		} catch (error) {
			this.#deps.log.warn("lane_permalink_failed", { lane: lane.name, error: String(error) });
			return undefined;
		}
	}

	/** Posts a card into the lane's thread; the message id, or `undefined` when the post failed (logged). */
	async #postCard(lane: LaneRow, view: LaneCardView): Promise<string | undefined> {
		const route = this.#deps.channels.forThreadRef(lane.threadRef);
		if (route === undefined) return undefined;
		try {
			const card = buildLaneOutcomeCard(lane, view);
			return (await route.port.post(route.target, cardMessage(card, route.port))).messageId;
		} catch (error) {
			this.#deps.log.warn("lane_card_post_failed", { lane: lane.name, error: String(error) });
			return undefined;
		}
	}

	/** Redraws a posted card in place (an edit without buttons removes the ones it had). Failures are logged. */
	async #editCard(lane: LaneRow, cardTs: string, view: LaneCardView): Promise<void> {
		const route = this.#deps.channels.forThreadRef(lane.threadRef);
		if (route === undefined) return;
		try {
			const card = buildLaneOutcomeCard(lane, view);
			await route.port.edit(
				{
					platform: route.port.platform,
					conversationId: route.target.conversationId,
					messageId: cardTs,
					...(route.target.threadId === undefined ? {} : { threadId: route.target.threadId }),
				},
				cardMessage({ ...card, buttons: card.buttons ?? [] }, route.port),
			);
		} catch (error) {
			this.#deps.log.warn("lane_card_edit_failed", { lane: lane.name, error: String(error) });
		}
	}

	/**
	 * Shows how the landing ended (`meta.land`). In place on the lane's card when somebody is watching it; as a new
	 * card (a notification, with the owner mention) when `fresh` — the old card then only points to the new one.
	 */
	async #showResult(lane: LaneRow, fresh: boolean): Promise<void> {
		const view: LaneCardView = { kind: "result", ownerUserId: this.#ownerOf(lane) };
		const old = lane.meta.land?.cardTs;
		if (old !== undefined && !fresh) return this.#editCard(lane, old, view);
		const cardTs = await this.#postCard(lane, view);
		if (cardTs === undefined) {
			if (old !== undefined) await this.#editCard(lane, old, view);
			return;
		}
		this.#patchLand(lane.name, { cardTs });
		if (old !== undefined) await this.#editCard(lane, old, { kind: "superseded" });
	}

	/** A tick's not-done verdict reached while frozen: the claim stays `done-claimed` for the first tick after unfreeze. */
	#heldByFreeze(name: string, fromTick: boolean): SettleOutcome | undefined {
		if (!fromTick || this.#deps.frozen?.() === undefined) return undefined;
		this.#deps.log.warn("lane_verdict_held_frozen", { lane: name });
		return { text: "held while frozen" };
	}

	#notDone(lane: LaneRow, reasons: string[]): SettleOutcome {
		// The owner paused while the verdict ran: not-done cannot land now (paused takes no transition, no steer).
		if (this.#deps.store.getLane(lane.name)?.status === "paused") {
			this.#deps.log.warn("lane_notdone_held_paused", { lane: lane.name });
			return { text: "held while paused" };
		}
		const row = this.#deps.store.transitionLane(
			lane.name,
			"not-done",
			{ event: "not_done", detail: reasons.join(" | ") },
			{},
		);
		this.#deps.log.info("lane_not_done", { lane: lane.name, reasons: reasons.length });
		// Frozen: no autonomous re-prompt into a running lane. The lane stays not-done; the next verdict after unfreeze steers.
		if (this.#deps.frozen?.() !== undefined) this.#deps.log.warn("lane_send_held_frozen", { lane: lane.name });
		else this.#send(lane.name, "not-done", buildNotDonePrompt(reasons));
		return {
			text: `[not-done] 완료 주장이 검증을 통과하지 못했습니다:\n${reasons.map((r) => `- ${r}`).join("\n")}`,
			row,
		};
	}

	/**
	 * Periodic work: start the verdict of claims older than the grace period (not awaited — a check or an approval card
	 * of one lane never holds the others), then reconcile the Slack messages of every lane not being judged. The rows
	 * `listLanes` parsed are reused for the reconcile, so one sweep parses each lane's history once. A lane being judged
	 * is left alone this tick: its verdict draws its own transition, and the next tick reconciles the rest.
	 */
	async tick(): Promise<void> {
		const now = this.#deps.clock.now();
		for (const lane of this.#deps.store.listLanes()) {
			try {
				if (this.#settling.has(lane.name)) continue;
				const claim = lane.meta.claim;
				const next = this.#nextSettleAt.get(lane.name);
				if (next !== undefined && (lane.status !== "done-claimed" || claim?.claimedAt !== next.claimedAt)) {
					this.#nextSettleAt.delete(lane.name);
				}
				// Timed-out checks are run again only a grace after their last run (one 300 s run per tick would stall it).
				const timedOut = lane.meta.checks?.inconclusive;
				// Frozen: the deferred verdict waits. A not-done now could not be steered and would never be judged again.
				if (
					lane.status === "done-claimed" &&
					claim &&
					now - claim.claimedAt >= CLAIM_GRACE_MS &&
					(timedOut === undefined || now - timedOut.lastAt >= CLAIM_GRACE_MS) &&
					(this.#nextSettleAt.get(lane.name)?.at ?? now) <= now &&
					this.#deps.frozen?.() === undefined
				) {
					this.#nextSettleAt.delete(lane.name);
					this.#settleInBackground(lane.name, true);
					continue;
				}
				await this.#sync(lane, "tick");
				await this.#tickLanding(lane);
				if (lane.status === "not-done") await this.#closeIfLandedOutside(lane.name);
			} catch (error) {
				this.#deps.log.error("lane_tick_failed", { lane: lane.name, error: String(error) });
			}
		}
	}

	/**
	 * A closed lane whose landing is still `pending`: one that began (`requestedBy`) and is not running in this process
	 * was cut off or waited for the lane's turn to end — run it from the top; one without a card gets its card (the
	 * earlier post failed). A begun auto-merge waits while frozen; the owner's does not.
	 */
	async #tickLanding(listed: LaneRow): Promise<void> {
		// Read again: the tick's list is as old as the lanes settled before this one (an approval wait, a push), and the
		// owner may have landed, discarded or reopened the lane meanwhile.
		const lane = this.#deps.store.getLane(listed.name);
		const land = lane?.meta.land;
		if (lane?.status !== "closed" || land?.state !== "pending") return;
		if (land.requestedBy === undefined) {
			if (land.cardTs === undefined) await this.#announce(lane.name);
			return;
		}
		if (this.#landing.has(lane.name) || this.#deps.laneBusy?.(lane.originKey) === true) return;
		if (land.requestedBy === "auto" && this.#deps.frozen?.() !== undefined) return;
		this.#landing.add(lane.name);
		try {
			await this.#runLanding(lane.name, true);
		} finally {
			this.#landing.delete(lane.name);
		}
	}

	/**
	 * A `not-done` worktree lane whose work someone merged into the base branch outside the lane (doc/plans/
	 * lane-rebase-external-land.md 설계 2): closed as `landed`, its worktree and branch removed. Only a lane whose last
	 * claim carries work made on the lane branch, whose work is in the base branch (`externallyLanded`), with a clean
	 * worktree and no running turn. A git call that fails changes nothing and is logged.
	 */
	async #closeIfLandedOutside(name: string): Promise<void> {
		const { store, log } = this.#deps;
		const lane = store.getLane(name);
		const claim = lane?.meta.claim;
		const { repo, worktree, branch, baseBranch, baseSha } = lane?.meta ?? {};
		if (
			lane?.status !== "not-done" ||
			claim === undefined ||
			repo === undefined ||
			worktree === undefined ||
			branch === undefined ||
			baseBranch === undefined ||
			baseSha === undefined ||
			this.#settling.has(name) ||
			this.#landing.has(name) ||
			this.#deps.laneBusy?.(lane.originKey) === true
		) {
			return;
		}
		let found: { sha: string; pushed: boolean } | undefined;
		try {
			found = await externallyLanded(defaultGit, { repo, worktree, branch, baseBranch, baseSha, claim: claim.commit });
		} catch (error) {
			log.warn("lane_external_land_check_failed", { lane: name, error: String(error).slice(0, 300) });
			return;
		}
		if (found === undefined) return;
		// Read again: the owner may have written in the thread (back to working) or the lane claimed again meanwhile.
		const current = store.getLane(name);
		if (current?.status !== "not-done" || current.meta.claim?.claimedAt !== claim.claimedAt) return;
		if (this.#deps.laneBusy?.(lane.originKey) === true) return;
		const { sha, pushed } = found;
		const land: LaneLand = { state: "landed", attempts: 0, ...(pushed ? { pushed: `origin/${baseBranch}` } : {}) };
		store.transitionLane(
			name,
			"closed",
			{ event: "landed", sha, detail: `레인 밖에서 머지됨 · claim ${sha.slice(0, 12)}` },
			{ sha, milestone: undefined, land },
		);
		log.info("lane_landed_outside", { lane: name, sha, pushed: pushed ? `origin/${baseBranch}` : "none" });
		// An idle child of this lane still has the worktree as its cwd.
		await this.#deps.stopWhenIdle(lane.originKey);
		await this.#ops.removeWorktree({ repo, worktree, branch });
		const left: string[] = [];
		if (existsSync(worktree)) left.push(`worktree ${worktree}`);
		if ((await defaultGit(["-C", repo, "rev-parse", "--verify", "-q", `refs/heads/${branch}`])).code === 0) {
			left.push(`브랜치 ${branch}`);
		}
		const row =
			left.length === 0
				? store.getLane(name)
				: this.#patchLand(name, { cleanup: `worktree·브랜치 정리 실패: ${left.join(", ")} — 손으로 지우세요` });
		if (left.length > 0) log.warn("lane_external_land_cleanup_left", { lane: name, left: left.join(", ") });
		this.#dropReviewFiles(row ?? lane);
		if (row !== undefined) await this.#sync(row, "transition");
	}

	#requireLane(originKey: string): LaneRow {
		const lane = this.#deps.store.getLaneByOrigin(originKey);
		if (!lane) throw new Error(`no work lane for origin ${originKey}`);
		return lane;
	}

	/**
	 * Brings the root and status messages to what the registry says. `meta.rendered*` remembers what Slack shows, so a
	 * failed edit is simply retried by the next tick. Working status edits follow the 15-minute cadence unless the
	 * reason is a milestone or a transition. Callers pass the row they already hold (the tick reuses its `listLanes`
	 * read; a transition passes the row its write returned) so no lane row is parsed a second time; the row as Slack
	 * now shows it is returned for the caller to keep using.
	 */
	async #sync(lane: LaneRow, reason: "transition" | "milestone" | "tick"): Promise<LaneRow> {
		const { store, channels, clock, log } = this.#deps;
		const name = lane.name;
		const parsed = parseThreadRef(lane.threadRef);
		if (parsed === undefined) return lane;
		const { channel, threadTs: rootTs } = parsed;
		const closed = lane.status === "closed";
		const paused = lane.status === "paused";
		const now = clock.now();
		// A closed lane is ✅ only once its work is in the base branch (or it never had a branch of its own).
		const [mark, waiting] = !closed ? ["🔄", ""] : CLOSED_MARKS[lane.meta.land?.state ?? "landed"];
		// The title and milestone are the model's words: Slack mention syntax in them stays text.
		const title = escapeMrkdwn(lane.title);
		const rootText = `${mark} ${title}`;
		const milestone = lane.meta.milestone === undefined ? "" : `\n↳ ${escapeMrkdwn(lane.meta.milestone)}`;
		// Paused pins its status (no elapsed clock) and is drawn at the transition, never on the 15-minute tick.
		const statusText = closed
			? `${mark} ${title}${waiting === "" ? "" : ` · ${waiting}`}`
			: paused
				? `⏸ ${title} · 멈춤`
				: `⏳ ${title} · ${formatElapsed(now - lane.meta.startedAt)}${milestone}`;
		const statusDue = closed
			? lane.meta.renderedStatus !== statusText
			: paused
				? lane.meta.renderedStatus !== statusText // drawn once; a tick only retries a draw that failed
				: reason !== "tick" || now - lane.meta.lastProgressAt >= PROGRESS_INTERVAL_MS;
		// The owner holds or resumes the lane from the status message itself (closed lanes have their Outcome card).
		const statusButtons: readonly ActionButton[] = closed ? [] : [paused ? resumeButton(name) : pauseButton(name)];
		const patch: Partial<LaneMeta> = {};
		try {
			const port = channels.portFor(channel);
			if (lane.meta.renderedRoot !== rootText) {
				await port.edit({ platform: port.platform, conversationId: channel, messageId: rootTs }, { text: rootText });
				patch.renderedRoot = rootText;
			}
			if (lane.meta.statusTs !== undefined && statusDue) {
				// The status is inside the lane thread: on Discord the thread id tells the port where, even after a
				// restart emptied its message cache.
				await port.edit(
					{ platform: port.platform, conversationId: channel, messageId: lane.meta.statusTs, threadId: rootTs },
					{ text: statusText, buttons: statusButtons },
				);
				patch.renderedStatus = statusText;
				patch.lastProgressAt = now;
			}
		} catch (error) {
			log.warn("lane_render_failed", { lane: name, error: String(error) });
		}
		if (patch.renderedRoot !== undefined) log.info("lane_rendered", { lane: name, root: patch.renderedRoot });
		if (Object.keys(patch).length === 0) return lane;
		return store.patchLane(name, undefined, patch);
	}
}
