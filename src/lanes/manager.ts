import { realpathSync, statSync } from "node:fs";
import { isAbsolute, sep } from "node:path";
import { parseThreadRef } from "../core/normalize";
import type { InboundRecord, MailboxClock } from "../core/types";
import type { Logger } from "../log";
import { type FreezeState, frozenMessage } from "../ops/freeze";
import { redact } from "../redact";
import { formatElapsed } from "../slack/format";
import type { SlackTransport } from "../slack/transport";
import type { Store } from "../store/db";
import { classifyLaneCompletion, collectLaneDiff, type IntegrityInput, type IntegrityRefusal } from "./integrity";
import { type LaneClaim, type LaneMeta, type LaneRow, laneOriginKey } from "./status";
import { buildLanePrompt, buildNotDonePrompt, classifyClosedLaneMessage } from "./trigger";
import { type ClaimEvidence, resolveBaseSha, type VerifyResult, verifyClaim } from "./verify";

export const DEFAULT_MAX_LANES = 4;
/** The thread status message is edited at most this often (milestones excepted). */
export const PROGRESS_INTERVAL_MS = 15 * 60_000;
/** A claim whose check could not finish is judged again after this long: closed when it passes, `not-done` when not. */
export const CLAIM_GRACE_MS = 5 * 60_000;

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

/** What the lane tools answer on a closed lane: nothing changed, and the owner's `!reopen` is the way back to work. */
const CLOSED_LANE_REPLY =
	"is closed: nothing was recorded. Answer only; if changes are needed, ask the owner to write `!reopen <지시>` in this lane's thread.";

/** True when two normalized cwds name the same repository: the same path, or one containing the other. */
function cwdOverlaps(a: string, b: string): boolean {
	return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
}

export interface LaneManagerDeps {
	store: Store;
	transport: SlackTransport;
	clock: MailboxClock;
	log: Logger;
	sessionsRoot: string;
	/** Hands a record to the mailbox of `record.originKey`; resolves once it has been dispatched. */
	route(record: InboundRecord): Promise<void>;
	/** Stops the lane's omp child after its running turn (the lane is closed). */
	stopWhenIdle(originKey: string): Promise<void>;
	maxLanes?: number;
	/** Freeze switch (`<home>/FROZEN`): while it returns a state no lane starts. */
	frozen?: () => FreezeState | undefined;
	/** Test seam; default checks the real git repository. */
	verify?: (evidence: ClaimEvidence, cwd: string, baseSha?: string) => Promise<VerifyResult>;
	/** Test seam; default reads `git diff base..sha` from the lane's repository. */
	collectDiff?: (laneCwd: string, baseSha: string, sha: string) => Promise<string>;
	/** Test seam; default judges the claim's summary + diff (hermes completion_integrity). */
	integrity?: (input: IntegrityInput) => IntegrityRefusal[];
	/** Owner approval surface: an integrity refusal can be overridden by an explicit click. */
	approvals?: { request(channel: string, summary: string): Promise<"approved" | "denied" | "timeout"> };
	/** Joins `<sessionsRoot>/<origin>/e1` the way `sessionDirFor` does (injected to keep this module free of origin.ts). */
	sessionDirFor: (originKey: string) => string;
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
	/** Realpath-normalized cwds of starts that passed validation but have no registry row yet. */
	readonly #startingCwds = new Set<string>();
	readonly #settling = new Set<string>();

	constructor(deps: LaneManagerDeps) {
		this.#deps = deps;
		this.#max = deps.maxLanes ?? DEFAULT_MAX_LANES;
	}

	get store(): Store {
		return this.#deps.store;
	}

	/** Creates the thread, the registry row and starts the lane's first turn. Throws `LaneInputError` for a refusal. */
	async start(input: { title: string; cwd: string; brief?: string | undefined; channel: string }): Promise<LaneRow> {
		const { store, transport, clock, log } = this.#deps;
		const frozen = this.#deps.frozen?.();
		if (frozen !== undefined) {
			log.warn("lane_refused_frozen", { channel: input.channel });
			throw new LaneInputError(frozenMessage(frozen));
		}
		const title = redact(input.title.replace(/\s+/g, " ").trim()).slice(0, MAX_TITLE_CHARS);
		if (title === "") throw new LaneInputError("작업 제목이 비어 있습니다.");
		if (!isAbsolute(input.cwd)) throw new LaneInputError(`프로젝트 경로는 절대경로여야 합니다: ${input.cwd}`);
		let cwd: string;
		try {
			cwd = realpathSync(input.cwd);
			if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
		} catch {
			throw new LaneInputError(`프로젝트 경로가 디렉터리가 아니거나 없습니다: ${input.cwd}`);
		}
		let baseSha: string | undefined;
		try {
			baseSha = await resolveBaseSha(cwd);
		} catch (error) {
			log.warn("lane_base_unavailable", { cwd, error: String(error) });
		}
		if (store.countOpenLanes() + this.#starting >= this.#max) throw new LaneCapError(this.#max);
		const busy = this.#busyLaneOn(cwd);
		if (busy) {
			throw new LaneInputError(
				`이 저장소에서 진행 중인 레인이 있습니다: ${busy.name} — 레인이 끝난 뒤 다시 시작하세요.`,
			);
		}
		// A start that passed validation but has no registry row yet still holds the workspace.
		if ([...this.#startingCwds].some((other) => cwdOverlaps(cwd, other))) {
			throw new LaneInputError("이 저장소로 레인이 방금 시작되었습니다. 잠시 뒤 다시 시도하세요.");
		}

		this.#starting += 1;
		this.#startingCwds.add(cwd);
		let lane: LaneRow;
		try {
			const root = await transport.postMessage({ channel: input.channel, text: `🔄 ${title}` });
			const status = await transport.postMessage({
				channel: input.channel,
				threadTs: root.ts,
				text: `⏳ ${title} · ${formatElapsed(0)}`,
			});
			const name = this.#uniqueName(slugify(title));
			const originKey = laneOriginKey(name);
			const now = clock.now();
			lane = store.insertLane({
				name,
				title,
				threadRef: `${input.channel}:${root.ts}`,
				originKey,
				cwd,
				sessionDir: this.#deps.sessionDirFor(originKey),
				meta: {
					statusTs: status.ts,
					startedAt: now,
					lastProgressAt: now,
					renderedRoot: `🔄 ${title}`,
					renderedStatus: `⏳ ${title} · ${formatElapsed(0)}`,
					steerSeq: 0,
					...(baseSha === undefined ? {} : { baseSha }),
				},
			});
		} finally {
			this.#starting -= 1;
			this.#startingCwds.delete(cwd);
		}
		log.info("lane_started", { lane: lane.name, origin: lane.originKey, cwd: lane.cwd });
		// The first turn runs in the background: the owner's reply must not wait for omp to start.
		this.#send(lane.name, "start", buildLanePrompt({ name: lane.name, title, cwd, brief: input.brief }));
		return lane;
	}

	#uniqueName(base: string): string {
		let name = base;
		for (let n = 2; this.#deps.store.getLane(name); n += 1) name = `${base}-${n}`;
		return name;
	}

	/**
	 * The open lane already working in `cwd`: two lanes on one repository would step on each other's commits — the
	 * clean-tree check of one rejects the other's uncommitted work, and a `baseSha` diff picks up the neighbour's
	 * commits. One repository, one lane at a time (workspace lease).
	 */
	#busyLaneOn(cwd: string): LaneRow | undefined {
		return this.#deps.store.listLanes().find((lane) => lane.status !== "closed" && cwdOverlaps(cwd, lane.cwd));
	}

	/** Feeds a core-authored message (first prompt, not-done reasons) into the lane's mailbox without awaiting it. */
	#send(name: string, kind: string, text: string): void {
		const lane = this.#deps.store.getLane(name);
		if (!lane) return;
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
		const closedAs = lane.status === "closed" ? classifyClosedLaneMessage(text) : undefined;
		if (closedAs === "question") {
			store.patchLane(lane.name, { event: "owner_question" }, {});
		} else if (closedAs === "reopen") {
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
				},
			);
			this.#deps.log.info("lane_reopened", { lane: lane.name });
			void this.#sync(reopened, "transition");
		} else if (lane.status === "done-claimed") {
			store.transitionLane(lane.name, "working", { event: "owner_reply" }, { claim: undefined });
		}
	}

	/** Milestone report from the lane (`ompbot_lane_progress`): recorded and shown in the status message at once. */
	async progress(originKey: string, text: string): Promise<string> {
		const lane = this.#requireLane(originKey);
		if (lane.status === "closed") return `lane ${lane.name} ${CLOSED_LANE_REPLY}`;
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
				return { text: "검증을 지금 끝내지 못했습니다. 코어가 5분 안에 다시 확인합니다." };
			}
			// The owner may have answered (back to working) while git ran: that claim is void.
			if (store.getLane(name)?.status !== "done-claimed") return { text: "claim superseded by the owner" };
			if (!result.ok) return this.#heldByFreeze(name, fromTick) ?? this.#notDone(lane, result.reasons);
			// Git proved the commit; the claim's own text and diff still have to read as finished work.
			const refusals = await this.#integrityRefusals(lane, claim, result.sha);
			if (refusals.length === 0) return this.#close(lane, result.sha);
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
			return this.#close(lane, sha);
		}
		log.info("lane_integrity_refused", { lane: lane.name, categories: refusals.map((r) => r.category).join(",") });
		const held = this.#heldByFreeze(lane.name, fromTick);
		if (held !== undefined) return held;
		return this.#notDone(
			lane,
			refusals.map((r) => `${r.category}: ${r.remedy}`),
		);
	}

	async #close(lane: LaneRow, sha: string): Promise<SettleOutcome> {
		const closed = this.#deps.store.transitionLane(
			lane.name,
			"closed",
			{ event: "closed", sha },
			{ sha, milestone: undefined },
		);
		this.#deps.log.info("lane_closed", { lane: lane.name, sha });
		const rendered = await this.#sync(closed, "transition");
		// The turn that made the claim still delivers its closing report before the child stops.
		void this.#deps
			.stopWhenIdle(lane.originKey)
			.catch((error: unknown) => this.#deps.log.error("lane_stop_failed", { lane: lane.name, error: String(error) }));
		return { text: `검증 통과: 커밋 ${sha}. 레인 ${lane.name}을 닫았습니다.`, row: rendered };
	}

	/** A tick's not-done verdict reached while frozen: the claim stays `done-claimed` for the first tick after unfreeze. */
	#heldByFreeze(name: string, fromTick: boolean): SettleOutcome | undefined {
		if (!fromTick || this.#deps.frozen?.() === undefined) return undefined;
		this.#deps.log.warn("lane_verdict_held_frozen", { lane: name });
		return { text: "held while frozen" };
	}

	#notDone(lane: LaneRow, reasons: string[]): SettleOutcome {
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
			} catch (error) {
				this.#deps.log.error("lane_tick_failed", { lane: lane.name, error: String(error) });
			}
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
		const { store, transport, clock, log } = this.#deps;
		const name = lane.name;
		const parsed = parseThreadRef(lane.threadRef);
		if (parsed === undefined) return lane;
		const { channel, threadTs: rootTs } = parsed;
		const closed = lane.status === "closed";
		const now = clock.now();
		const rootText = `${closed ? "✅" : "🔄"} ${lane.title}`;
		const milestone = lane.meta.milestone === undefined ? "" : `\n↳ ${lane.meta.milestone}`;
		const statusText = closed
			? `✅ ${lane.title}`
			: `⏳ ${lane.title} · ${formatElapsed(now - lane.meta.startedAt)}${milestone}`;
		const statusDue = closed
			? lane.meta.renderedStatus !== statusText
			: reason !== "tick" || now - lane.meta.lastProgressAt >= PROGRESS_INTERVAL_MS;
		const patch: Partial<LaneMeta> = {};
		try {
			if (lane.meta.renderedRoot !== rootText) {
				await transport.updateMessage({ channel, ts: rootTs, text: rootText });
				patch.renderedRoot = rootText;
			}
			if (lane.meta.statusTs !== undefined && statusDue) {
				await transport.updateMessage({ channel, ts: lane.meta.statusTs, text: statusText });
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
