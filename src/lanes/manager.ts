import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ActionButton } from "../channel/port";
import type { ChannelRegistry } from "../channel/registry";
import { formatElapsed } from "../channel/text";
import type { PauseCheck } from "../core/mailbox";
import { parseThreadRef, platformOfThreadRef } from "../core/normalize";
import type { IdPlatform } from "../core/origin-key";
import type { InboundRecord, MailboxClock } from "../core/types";
import type { Logger } from "../log";
import { type FreezeState, frozenMessage } from "../ops/freeze";
import { redact } from "../redact";
import type { Store } from "../store/db";
import { taskChecksOf } from "../tasks/checker";
import { kstDay, worktreePathOf } from "../tasks/docs";
import { runWorktreeChecks } from "../tasks/evaluate";
import { createTaskHostOps, type TaskHostOps } from "../tasks/host";
import { type AutoLandPolicy, cardMessage } from "../tasks/notify";
import { repoMatchesCommonDir } from "../tasks/repo-match";
import type { SignalCheck } from "../tasks/signals";
import { buildLaneOutcomeCard, type LaneCardView, lanePauseActionId, laneResumeActionId } from "./card";
import { classifyLaneCompletion, collectLaneDiff, type IntegrityInput, type IntegrityRefusal } from "./integrity";
import { createLaneLander, type LandLane, type LandResult, laneLandBlockers } from "./land";
import {
	INTEGRITY_APPROVED,
	type LaneClaim,
	type LaneLand,
	type LaneMeta,
	type LaneRow,
	type LaneStatus,
	laneOriginKey,
	OWNER_PAUSE_HELD,
} from "./status";
import { buildLanePrompt, buildNotDonePrompt, buildRebasePrompt, classifyClosedLaneMessage } from "./trigger";
import { type ClaimEvidence, resolveBaseSha, type VerifyResult, verifyClaim } from "./verify";
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
const MAX_MILESTONE_CHARS = 300;

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
const CHECK_DETAIL_MAX = 120;

export interface LaneManagerDeps {
	store: Store;
	channels: ChannelRegistry;
	clock: MailboxClock;
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
	verify?: (evidence: ClaimEvidence, cwd: string, baseSha?: string) => Promise<VerifyResult>;
	/** Test seam; default reads `git diff base..sha` from the lane's repository. */
	collectDiff?: (laneCwd: string, baseSha: string, sha: string) => Promise<string>;
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
	readonly #ops: TaskHostOps;
	readonly #land: LandLane;
	/** Lanes whose merge or discard is running in this process: a second request (a double click) does nothing. */
	readonly #landing = new Set<string>();
	/** Lanes whose Outcome card is being posted (a close and a tick never post two). */
	readonly #announcing = new Set<string>();
	/** Work started without awaiting it (the card and auto-merge after a close); `idle()` waits for it. */
	readonly #background = new Set<Promise<void>>();

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
			kstDay(clock.now()),
			(id) =>
				rowIds.has(id) || branchIds.has(id) || this.#reservedLaneIds.has(id) || existsSync(worktreePathOf(repo, id)),
		);
		const worktree = worktreePathOf(repo, laneId);
		const branch = laneBranchOf(laneId);
		this.#starting += 1;
		this.#reservedLaneIds.add(laneId);
		let created = false;
		let reservedName: string | undefined;
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
			const root = await port.post({ conversationId: input.channel }, { text: `🔄 ${title}` });
			// Discord: the lane thread is started from the root (its id is the root's), so the status goes inside it.
			if (port.openThread !== undefined) {
				const rootRef = { platform: port.platform, conversationId: input.channel, messageId: root.messageId };
				try {
					await port.openThread(rootRef, title);
				} catch (error) {
					// The root stays in the channel and says the lane never started.
					await port
						.edit(rootRef, { text: `❌ ${title}` })
						.catch((editError: unknown) =>
							log.warn("lane_root_edit_failed", { channel: input.channel, error: String(editError) }),
						);
					throw error;
				}
			}
			// No await between picking the name and reserving it (like the lane id above).
			const name = this.#uniqueName(slugify(title));
			this.#reservedNames.add(name);
			reservedName = name;
			// The status message carries the ⏸ button from the very first draw; `#sync` keeps it on every edit.
			const status = await port.post(
				{ conversationId: input.channel, threadId: root.messageId },
				{ text: `⏳ ${title} · ${formatElapsed(0)}`, buttons: [pauseButton(name)] },
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
					renderedRoot: `🔄 ${title}`,
					renderedStatus: `⏳ ${title} · ${formatElapsed(0)}`,
					steerSeq: 0,
					baseSha,
					laneId,
					repo,
					worktree,
					branch,
					baseBranch,
					risk: risk.value,
					acceptance: acceptance.value,
				},
			});
		} catch (error) {
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
				},
			);
			this.#deps.log.info("lane_reopened", { lane: lane.name });
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
	 * (could not be steered now) so the first tick after unfreeze judges it again.
	 */
	async #settle(name: string, fromTick = false): Promise<SettleOutcome> {
		const { store, log } = this.#deps;
		if (this.#settling.has(name)) return { text: "verification already running" };
		this.#settling.add(name);
		try {
			const lane = store.getLane(name);
			const claim = lane?.meta.claim;
			if (lane?.status !== "done-claimed" || !claim) return { text: "no pending claim" };
			let result: VerifyResult;
			try {
				result = await (this.#deps.verify ?? verifyClaim)(claim, lane.cwd, lane.meta.baseSha);
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
			if (refusals.length === 0) return this.#closeIfChecksPass(lane, result.sha, fromTick, false);
			return this.#refusedByIntegrity(lane, result.sha, refusals, fromTick);
		} finally {
			this.#settling.delete(name);
		}
	}

	/** Collects the lane's diff and judges the claim text + diff; an unreadable diff degrades to text-only. */
	async #integrityRefusals(lane: LaneRow, claim: LaneClaim, sha: string): Promise<IntegrityRefusal[]> {
		const classify = this.#deps.integrity ?? classifyLaneCompletion;
		let diff = "";
		if (lane.meta.baseSha !== undefined) {
			try {
				diff = await (this.#deps.collectDiff ?? collectLaneDiff)(lane.cwd, lane.meta.baseSha, sha);
			} catch (error) {
				this.#deps.log.warn("lane_diff_unavailable", { lane: lane.name, error: String(error) });
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
	 * time, at the claimed commit only (HEAD must be it, the tree clean). A failed check is not-done; a host that
	 * cannot run them leaves the claim pending for the tick after the grace. The results are recorded per HEAD, so the
	 * same commit is never checked twice. Lanes without a worktree (older rows) or without checks close on git alone.
	 */
	async #closeIfChecksPass(
		lane: LaneRow,
		sha: string,
		fromTick: boolean,
		integrityApproved: boolean,
	): Promise<SettleOutcome> {
		const { store, log } = this.#deps;
		const worktree = lane.meta.worktree;
		const requests = worktree === undefined ? [] : taskChecksOf(lane.meta.acceptance ?? []);
		if (worktree === undefined || requests.length === 0) return this.#close(lane, sha, integrityApproved);
		const reasons: string[] = [];
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
				const run = await runWorktreeChecks(
					this.#ops,
					worktree,
					(at) => {
						if (recorded?.head === at) {
							for (const r of recorded.results) known.set(r.signal, { signal: r.signal, ok: r.ok, detail: r.detail });
						}
						return known;
					},
					requests,
				);
				if ("deferred" in run) {
					reasons.push(run.deferred);
				} else {
					const failed = run.results.filter((result) => !result.ok);
					store.patchLane(
						lane.name,
						{
							event: "checks",
							detail: `${run.results.length - failed.length}/${run.results.length} 통과`,
							sha: run.head,
						},
						{ checks: { head: run.head, results: run.results } },
					);
					// A commit that landed between the two HEAD reads was checked instead of the claim: the claim is unproven.
					if (run.head !== sha) reasons.push(notClaimedHead(run.head));
					for (const check of failed) {
						reasons.push(`check ${check.id} 실패: ${check.detail.slice(0, CHECK_DETAIL_MAX)}`);
					}
				}
			}
		} catch (error) {
			log.warn("lane_checks_unavailable", { lane: lane.name, error: String(error) });
			store.patchLane(lane.name, { event: "checks_unavailable", detail: String(error) }, {});
			return { text: DEFERRED_REPLY };
		}
		// The owner may have answered (back to working) while the checks ran, and the lane may even have claimed again:
		// either way this claim is void.
		const current = store.getLane(lane.name);
		if (current?.status !== "done-claimed" || current.meta.claim?.claimedAt !== lane.meta.claim?.claimedAt) {
			return { text: "claim superseded by the owner" };
		}
		if (reasons.length > 0) return this.#heldByFreeze(lane.name, fromTick) ?? this.#notDone(lane, reasons);
		return this.#close(lane, sha, integrityApproved);
	}

	/**
	 * `closed`: the claim is proven. A worktree lane now waits for its merge (`meta.land` pending): the Outcome card
	 * goes up in the background and, when `taskAutoLand` has no objection, the core lands it. A lane without a
	 * worktree (an older row) is simply done.
	 */
	async #close(lane: LaneRow, sha: string, integrityApproved: boolean): Promise<SettleOutcome> {
		const { repo, worktree, branch, baseBranch } = lane.meta;
		const lands = repo !== undefined && worktree !== undefined && branch !== undefined && baseBranch !== undefined;
		const land: LaneLand = {
			state: "pending",
			// Refusals survive the trip back to `working`: the second not-ff landing goes to the owner.
			attempts: this.#deps.store.getLane(lane.name)?.meta.land?.attempts ?? 0,
			...(integrityApproved ? { autoLandHeld: INTEGRITY_APPROVED } : {}),
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
		if (this.#announcing.has(name) || this.#landing.has(name)) return;
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
				skipped = laneLandBlockers(lane, policy, matched, this.#deps.frozen?.() !== undefined);
			}
			const auto = skipped !== undefined && skipped.length === 0;
			const cardTs = await this.#postCard(
				lane,
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
		const push = by === "owner" || (policy !== undefined && (await this.#repoMatches(repo, policy.repos)));
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
		if (result.state === "merged-not-pushed") {
			const row = this.#patchLand(
				name,
				{ state: "merged-not-pushed", preSha, reason: result.reason, errors: undefined },
				{ event: "merged_not_pushed", detail: result.reason, sha },
			);
			log.warn("lane_merged_not_pushed", { lane: name, sha, reason: result.reason });
			await this.#showResult(await this.#sync(row, "transition"), unattended);
			return `⚠️ ${baseBranch}에 머지했지만 push origin/${baseBranch}는 되지 않았습니다: ${result.reason}`;
		}
		const row = this.#patchLand(
			name,
			{
				state: "landed",
				preSha,
				reason: undefined,
				errors: undefined,
				...(result.pushed === undefined ? {} : { pushed: result.pushed }),
			},
			{ event: "landed", sha, ...(result.pushed === undefined ? {} : { detail: `push ${result.pushed}` }) },
		);
		log.info("lane_landed", { lane: name, sha, pushed: result.pushed ?? "none", by });
		await this.#showResult(await this.#sync(row, "transition"), false);
		return `✅ 머지했습니다: ${baseBranch} ← ${short} · ${result.pushed === undefined ? "push 없음(origin 원격 없음)" : `push ${result.pushed}`} · worktree 정리`;
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
				land: { state: "pending", attempts },
			},
		);
		log.info("lane_land_not_ff", { lane: lane.name, attempts });
		await this.#sync(working, "transition");
		if (cardTs !== undefined) {
			await this.#editCard(working, cardTs, {
				kind: "rework",
				reason: `${reason} — 레인이 \`${lane.meta.baseBranch}\` 위로 rebase하고 있습니다.`,
			});
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
	 * Periodic work: judge claims older than the grace period, then reconcile the Slack messages of every lane. The
	 * rows `listLanes` parsed are reused for the reconcile; only a settle that transitioned the lane replaces the row
	 * (with the one its transition returned), so one sweep parses each lane's history once.
	 */
	async tick(): Promise<void> {
		const now = this.#deps.clock.now();
		for (const lane of this.#deps.store.listLanes()) {
			try {
				let row = lane;
				const claim = lane.meta.claim;
				// Frozen: the deferred verdict waits. A not-done now could not be steered and would never be judged again.
				if (
					lane.status === "done-claimed" &&
					claim &&
					now - claim.claimedAt >= CLAIM_GRACE_MS &&
					this.#deps.frozen?.() === undefined
				) {
					// The settle may have transitioned the lane; only then is the row from `listLanes` stale.
					row = (await this.#settle(lane.name, true)).row ?? lane;
				}
				await this.#sync(row, "tick");
				await this.#tickLanding(lane);
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
		const rootText = `${mark} ${lane.title}`;
		const milestone = lane.meta.milestone === undefined ? "" : `\n↳ ${lane.meta.milestone}`;
		// Paused pins its status (no elapsed clock) and is drawn at the transition, never on the 15-minute tick.
		const statusText = closed
			? `${mark} ${lane.title}${waiting === "" ? "" : ` · ${waiting}`}`
			: paused
				? `⏸ ${lane.title} · 멈춤`
				: `⏳ ${lane.title} · ${formatElapsed(now - lane.meta.startedAt)}${milestone}`;
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
