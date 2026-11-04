import type { ActionButton, ChannelPort, MessageRef } from "../channel/port";
import type { Logger } from "../log";
import { DEFAULT_TIMEZONE } from "../monitors/cron";
import { redact } from "../redact";

export type ApprovalDecision = "approve" | "deny";
export type ApprovalOutcome = "approved" | "denied" | "timeout";
/** What `ask` resolves to: a click/timeout outcome, or the owner's free-text thread reply on the card. */
export type ApprovalResult = ApprovalOutcome | { replied: string };

/** The conversation an approval request comes from; lets the card point back and a reply find its way home. */
export interface ApprovalOrigin {
	originKey: string;
	/** Slack channel of the conversation. */
	channel: string;
	/** The conversation's current thread (absent: the channel's main view). */
	threadTs?: string | undefined;
}

/** How an owner reply in a card's thread was handled (`handleCardReply`). */
export type CardReplyResult =
	| { kind: "settled" }
	| { kind: "duplicate" }
	/** The card is already settled: deliver the reply as a normal owner message of the asking conversation. */
	| { kind: "route"; originKey: string };

export const APPROVAL_ACTION_PREFIX = "ompbot:approval";
/** An unanswered card counts as denied after this long; the deadline is shown under its buttons. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;
const SUMMARY_LIMIT = 2500;
/** Per-section limit for the optional structured fields; the whole card stays under `CARD_LIMIT` for one Slack section. */
const FIELD_LIMIT = 400;
const CARD_LIMIT = 2900;

/** Optional structured sections of an approval card; every one is omitted when empty (summary-only callers unchanged). */
export interface ApprovalDetail {
	/** What exactly is about to run (command, file paths). */
	action?: string;
	/** Why the action is needed now. */
	why?: string;
	/** What changes or breaks when it runs. */
	impact?: string;
	/** Why this cannot be undone (omit when it can). */
	rollback?: string;
}

const DETAIL_SECTIONS: Array<{ key: keyof ApprovalDetail; label: string }> = [
	{ key: "action", label: "할 일" },
	{ key: "why", label: "이유" },
	{ key: "impact", label: "영향" },
	{ key: "rollback", label: "되돌릴 수 없는 이유" },
];

/** The filled sections, each redacted and cut to `FIELD_LIMIT`: the exact text the card shows and the ledger keeps. */
function shownDetail(detail: ApprovalDetail | undefined): ApprovalDetail {
	const shown: ApprovalDetail = {};
	for (const { key } of DETAIL_SECTIONS) {
		const value = detail?.[key];
		if (value === undefined || value.trim() === "") continue;
		shown[key] = cutCodePointSafe(redact(value), FIELD_LIMIT);
	}
	return shown;
}

/**
 * The card text: header (with the owner mention when the card is escalated, so it notifies) + the already-redacted,
 * already-cut summary, an optional `요청 위치` line, then one `• 라벨: 값` line per filled (already shown) section.
 */
function renderCard(
	shownSummary: string,
	detail: ApprovalDetail,
	escalation: { ownerMention: string; where: string } | undefined,
): string {
	const header = escalation === undefined ? "🔐 승인 요청" : `🔐 승인 요청 ${escalation.ownerMention}`;
	const lines = [`${header}\n${shownSummary}`];
	if (escalation !== undefined) lines.push(`요청 위치: ${escalation.where}`);
	for (const { key, label } of DETAIL_SECTIONS) {
		const value = detail[key];
		if (value !== undefined) lines.push(`• ${label}: ${value}`);
	}
	return cutCodePointSafe(lines.join("\n"), CARD_LIMIT);
}

/** `ompbot:approval:<approve|deny>:<channel>:<ts>`; channel ids and message ts contain no colon. */
export function approvalActionId(decision: ApprovalDecision, channel: string, ts: string): string {
	return `${APPROVAL_ACTION_PREFIX}:${decision}:${channel}:${ts}`;
}

/** Approve/deny buttons of one card; their action ids carry the card's own message id. */
function approvalButtons(channel: string, ts: string): ActionButton[] {
	return [
		{ actionId: approvalActionId("approve", channel, ts), label: "승인", value: "approve", style: "primary" },
		{ actionId: approvalActionId("deny", channel, ts), label: "거부", value: "deny", style: "danger" },
	];
}

function deadlineNote(expiresAt: number, timeoutMs: number): string {
	return `⏳ ${DEADLINE_FORMAT.format(expiresAt)}까지 버튼이나 이 스레드 답장이 없으면 거부로 처리됩니다(${Math.round(timeoutMs / 60_000)}분)`;
}

export function parseApprovalActionId(
	actionId: string,
): { decision: ApprovalDecision; channel: string; ts: string } | undefined {
	const parts = actionId.split(":");
	if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== APPROVAL_ACTION_PREFIX) return undefined;
	const [, , decision, channel, ts] = parts;
	if ((decision !== "approve" && decision !== "deny") || !channel || !ts) return undefined;
	return { decision, channel, ts };
}

export interface ApprovalTimers {
	set(fn: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

const realTimers: ApprovalTimers = {
	set: (fn, ms) => setTimeout(fn, ms),
	clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface ApprovalStore {
	createApproval(input: {
		approvalId: string;
		channel: string;
		messageTs: string;
		summary: string;
		createdAt: number;
		expiresAt: number;
		originKey?: string | undefined;
		originThreadRef?: string | undefined;
		/** The card's sections as shown (redacted, cut); the dashboard reads them back. */
		detail?: ApprovalDetail | undefined;
		/** Card and asking-thread permalinks; absent when the platform has none or the lookup failed. */
		cardUrl?: string | undefined;
		originUrl?: string | undefined;
	}): void;
	getApproval(approvalId: string):
		| {
				status: string;
				originKey: string | null;
				replyTs: string | null;
		  }
		| undefined;
	/** Settles a pending approval as `replied`; false when it was no longer pending (or already due). */
	replyApproval(approvalId: string, replyTs: string, text: string, now: number): boolean;
	decideApproval(approvalId: string, status: "approved" | "denied" | "expired", now: number): boolean;
	/** Expires due (or, with `due = false`, ALL) pending approvals and returns them for card updates. */
	expirePendingApprovals(now: number, due?: boolean): Array<{ approvalId: string; channel: string; messageTs: string }>;
}

export interface ApprovalBrokerOptions {
	port: ChannelPort;
	ownerUserId: string;
	/** Slack channel that receives the cards of requests that carry an origin (`ask` with `origin`); absent: the origin's own channel. */
	escalationChannel?: string | undefined;
	log: Logger;
	/** Durable ledger for approvals: survives restarts, double-click safe, expired rows are swept into cards. */
	store: ApprovalStore;
	clock?: { now(): number };
	timeoutMs?: number;
	/** Injected so tests drive the timeout without waiting. */
	timers?: ApprovalTimers;
}

interface Pending {
	/** Settles once; returns false when the request was already decided (click, timeout or abort). */
	settle: (outcome: ApprovalResult) => boolean;
	isSettled: () => boolean;
	/** False when the ledger row could not be created, so there is no durable row to arbitrate against. */
	recorded: boolean;
}

/** Cuts to at most `limit` UTF-16 units without leaving a lone high surrogate at the end. */
function cutCodePointSafe(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const last = text.charCodeAt(limit - 1);
	return text.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit);
}

/** One short line of the owner's reply for the settled card. */
function replyLine(text: string): string {
	return cutCodePointSafe(redact(text).replace(/\s+/g, " ").trim(), 200);
}

const FINAL_TEXT: Record<ApprovalOutcome, string> = {
	approved: "✅ 승인됨",
	denied: "⛔ 거부됨",
	timeout: "⌛ 시간 초과: 거부로 처리됨",
};

/** The waiting tool call was aborted (daemon restart, stopped turn): nobody pressed anything, so it is not a denial. */
const ABORTED_TEXT = "⌛ 기다리던 작업이 중단돼 만료됨(데몬 재시작 등) — 필요하면 다시 요청해 주세요";

/** `HH:MM` in the owner's time zone for the deadline line under the buttons. */
const DEADLINE_FORMAT = new Intl.DateTimeFormat("en-GB", {
	timeZone: DEFAULT_TIMEZONE,
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
});

/**
 * Posts approve/deny buttons in the owner's DM and resolves when the owner clicks. Only the owner's click counts; any
 * other user, an unknown message or a repeated click is ignored. No click within `timeoutMs` resolves as `timeout`
 * (callers treat it as denied).
 */
export class ApprovalBroker {
	readonly #options: ApprovalBrokerOptions;
	readonly #timers: ApprovalTimers;
	readonly #clock: { now(): number };
	readonly #pending = new Map<string, Pending>();

	constructor(options: ApprovalBrokerOptions) {
		this.#options = options;
		this.#timers = options.timers ?? realTimers;
		this.#clock = options.clock ?? { now: () => Date.now() };
	}

	get pendingCount(): number {
		return this.#pending.size;
	}

	/** Config reload: cards requested from now on go to the new escalation channel. */
	setEscalationChannel(channel: string | undefined): void {
		this.#options.escalationChannel = channel;
	}

	/** Like `ask`, for callers with no use for a free-text reply (a reply counts as not approved). */
	async request(
		channel: string,
		summary: string,
		signal?: AbortSignal,
		detail?: ApprovalDetail,
	): Promise<ApprovalOutcome> {
		const result = await this.ask(channel, summary, { signal, detail });
		return typeof result === "string" ? result : "denied";
	}

	/** `채널·스레드 링크` text of the requesting conversation; without a thread link it is the channel alone. */
	#whereOf(origin: ApprovalOrigin, threadUrl: string | undefined): string {
		const label = origin.channel.startsWith("D") ? "DM" : `<#${origin.channel}>`;
		return threadUrl === undefined ? label : `${label} · <${threadUrl}|스레드 보기>`;
	}

	/** Best-effort link to one message; a failed lookup is logged and reads as no link. */
	async #permalink(channel: string, ts: string): Promise<string | undefined> {
		try {
			return await this.#options.port.permalink(this.#ref(channel, ts));
		} catch (error) {
			this.#options.log.warn("approval_permalink_failed", { channel, error: String(error) });
			return undefined;
		}
	}

	/**
	 * Posts the card and waits for the owner. With an `origin` and an `escalationChannel` the card goes to the
	 * escalation channel (owner mention + `요청 위치`) and one pointer line lands in the asking thread; the origin is
	 * also stored on the ledger row, so a reply in the card's thread can find its way back to the asking session.
	 */
	async ask(
		requestChannel: string,
		summary: string,
		options: {
			signal?: AbortSignal | undefined;
			detail?: ApprovalDetail | undefined;
			origin?: ApprovalOrigin | undefined;
		} = {},
	): Promise<ApprovalResult> {
		const { signal, detail, origin } = options;
		const { port, log, store } = this.#options;
		const escalation = this.#options.escalationChannel;
		const escalated = origin !== undefined && escalation !== undefined && escalation !== requestChannel;
		const channel = escalated ? escalation : requestChannel;
		// Computed once: the card header and the ledger summary (and sections) must show the exact same text.
		const shown = cutCodePointSafe(redact(summary), SUMMARY_LIMIT);
		const sections = shownDetail(detail);
		const originUrl =
			origin?.threadTs === undefined ? undefined : await this.#permalink(origin.channel, origin.threadTs);
		const header = renderCard(
			shown,
			sections,
			escalated
				? { ownerMention: port.mentionUser(this.#options.ownerUserId), where: this.#whereOf(origin, originUrl) }
				: undefined,
		);
		const card = await port.post({ conversationId: channel }, { text: header });
		const key = `${channel}:${card.messageId}`;
		// Before the buttons go up (no click can arrive yet); a failed lookup only leaves the dashboard without a link.
		const cardUrl = await this.#permalink(channel, card.messageId);
		const now = this.#clock.now();
		const timeoutMs = this.#options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
		let recorded = true;
		try {
			store.createApproval({
				approvalId: key,
				channel,
				messageTs: card.messageId,
				summary: shown,
				createdAt: now,
				expiresAt: now + timeoutMs,
				detail: sections,
				cardUrl,
				originUrl,
				...(origin === undefined
					? {}
					: {
							originKey: origin.originKey,
							...(origin.threadTs === undefined ? {} : { originThreadRef: `${origin.channel}:${origin.threadTs}` }),
						}),
			});
		} catch (error) {
			recorded = false;
			log.warn("approval_record_failed", { channel, ts: card.messageId, error: String(error) });
		}
		const decision = Promise.withResolvers<ApprovalResult>();
		let settled = false;
		const settle = (outcome: ApprovalResult): boolean => {
			if (settled) return false;
			settled = true;
			decision.resolve(outcome);
			return true;
		};
		const timer = this.#timers.set(() => settle("timeout"), timeoutMs);
		// The tool call itself still returns `denied`; only the ledger and the card tell an abort from the owner's no.
		let aborted = false;
		const onAbort = () => {
			if (settle("denied")) aborted = true;
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		this.#pending.set(key, { settle, isSettled: () => settled, recorded });
		let result: ApprovalResult = "denied";
		try {
			// The action ids carry the message's own ts, which exists only after the post.
			await port.edit(card, {
				text: header,
				buttons: approvalButtons(channel, card.messageId),
				buttonsNote: deadlineNote(now + timeoutMs, timeoutMs),
			});
			log.info("approval_requested", { channel, ts: card.messageId });
			if (escalated) await this.#postPointer(origin, channel, cardUrl, shown);
			if (signal?.aborted) onAbort();
			result = await decision.promise;
			log.info("approval_resolved", {
				channel,
				ts: card.messageId,
				outcome: typeof result === "string" ? result : "replied",
			});
		} catch (error) {
			log.warn("approval_failed", { channel, ts: card.messageId, error: String(error) });
		} finally {
			this.#timers.clear(timer);
			signal?.removeEventListener("abort", onAbort);
			this.#pending.delete(key);
		}
		// The ledger row is the authority: a racing click or sweeper already flipped it, and this no-ops then.
		// A reply already settled its own ledger row (`handleCardReply`); only click/timeout/abort outcomes land here.
		if (typeof result === "string") {
			try {
				store.decideApproval(
					key,
					result === "approved" ? "approved" : result === "denied" && !aborted ? "denied" : "expired",
					this.#clock.now(),
				);
			} catch (error) {
				log.warn("approval_decide_failed", { channel, ts: card.messageId, error: String(error) });
			}
		}
		try {
			await port.edit(card, {
				text: `${header}\n${aborted ? ABORTED_TEXT : typeof result === "string" ? FINAL_TEXT[result] : `💬 답장으로 처리됨: ${replyLine(result.replied)}`}`,
				buttons: [],
			});
		} catch (error) {
			log.warn("approval_final_update_failed", { channel, ts: card.messageId, error: String(error) });
		}
		return result;
	}

	/** One pointer line in the asking thread (or the channel's main view) naming the escalation card; best effort. */
	async #postPointer(
		origin: ApprovalOrigin,
		cardChannel: string,
		cardUrl: string | undefined,
		shown: string,
	): Promise<void> {
		const { port, log } = this.#options;
		try {
			const link = cardUrl === undefined ? "" : ` (<${cardUrl}|카드 보기>)`;
			const firstLine = cutCodePointSafe(shown.split("\n")[0] ?? "", 200);
			await port.post(
				{
					conversationId: origin.channel,
					...(origin.threadTs === undefined ? {} : { threadId: origin.threadTs }),
				},
				{ text: `🔐 승인 요청을 <#${cardChannel}>에 올렸습니다 — ${firstLine}${link}` },
			);
		} catch (error) {
			log.warn("approval_pointer_failed", { channel: origin.channel, error: String(error) });
		}
	}

	/**
	 * The owner's reply in the thread of an approval card (`approvalId` = `<card channel>:<card ts>`). A still-pending
	 * card is settled as `replied` (the waiting tool call returns the text); a settled one hands the reply back as a
	 * `route` to the asking conversation. `undefined`: not a card this ledger knows (or nowhere to route a late reply).
	 */
	handleCardReply(reply: { approvalId: string; ts: string; text: string }): CardReplyResult | undefined {
		const { store, log } = this.#options;
		const row = store.getApproval(reply.approvalId);
		if (row === undefined) return undefined;
		// A backfill replay of the reply that settled the card: consumed already.
		if (row.replyTs === reply.ts) return { kind: "duplicate" };
		const pending = this.#pending.get(reply.approvalId);
		if (row.status === "pending" && pending?.isSettled() !== true) {
			if (store.replyApproval(reply.approvalId, reply.ts, reply.text, this.#clock.now())) {
				log.info("approval_reply", { id: reply.approvalId, ts: reply.ts });
				pending?.settle({ replied: reply.text });
				return { kind: "settled" };
			}
		}
		return row.originKey === null ? undefined : { kind: "route", originKey: row.originKey };
	}

	/**
	 * Boot + sweep: expires due pending rows (or ALL pending rows after a restart — a waiting click cannot outlive
	 * the process) and rewrites their cards to say so, instead of leaving buttons that resolve to nothing.
	 */
	async expireStale(due = true): Promise<number> {
		const { store, port, log } = this.#options;
		const expired = store.expirePendingApprovals(this.#clock.now(), due);
		for (const row of expired) {
			try {
				await port.edit(this.#ref(row.channel, row.messageTs), {
					text: `🔐 승인 요청\n${due ? FINAL_TEXT.timeout : "⌛ 데몬 재시작으로 만료됨 — 다시 요청해 주세요"}`,
					buttons: [],
				});
			} catch (error) {
				log.warn("approval_expire_card_failed", { channel: row.channel, ts: row.messageTs, error: String(error) });
			}
		}
		return expired.length;
	}

	/** A message of the approval conversation (card or asking thread) on the broker's port. */
	#ref(conversationId: string, messageId: string): MessageRef {
		return { platform: this.#options.port.platform, conversationId, messageId };
	}

	/** Returns true when the click settled a pending request. */
	handleAction(action: { actionId: string; userId: string }): boolean {
		const { log, ownerUserId } = this.#options;
		const parsed = parseApprovalActionId(action.actionId);
		if (!parsed) return false;
		if (action.userId !== ownerUserId) {
			log.warn("approval_click_ignored", { user: action.userId, reason: "not_owner" });
			return false;
		}
		const pending = this.#pending.get(`${parsed.channel}:${parsed.ts}`);
		if (!pending) {
			log.info("approval_click_ignored", { user: action.userId, reason: "no_pending_request" });
			return false;
		}
		if (pending.isSettled()) {
			log.info("approval_click_ignored", { user: action.userId, reason: "already_decided" });
			return false;
		}
		const outcome: ApprovalOutcome = parsed.decision === "approve" ? "approved" : "denied";
		// The ledger row is the authority: a sweeper-expired or otherwise decided row must not grant anything.
		if (pending.recorded) {
			try {
				if (!this.#options.store.decideApproval(`${parsed.channel}:${parsed.ts}`, outcome, this.#clock.now())) {
					log.info("approval_click_ignored", { user: action.userId, reason: "ledger_not_pending" });
					return false;
				}
			} catch (error) {
				log.warn("approval_click_ledger_failed", { user: action.userId, error: String(error) });
			}
		}
		log.info("approval_click", { user: action.userId, action: parsed.decision });
		return pending.settle(outcome);
	}
}
