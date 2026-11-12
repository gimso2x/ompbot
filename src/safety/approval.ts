import type { ActionButton, ChannelPort, MessageRef, OutboundMessage } from "../channel/port";
import type { ChannelRegistry } from "../channel/registry";
import { cutCodePointSafe } from "../channel/text";
import { type ChatPlatform, platformOfConversationId } from "../core/origin-key";
import type { Logger } from "../log";
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
	| { kind: "route"; originKey: string }
	/** An injected message (`ompbot inject`) in a card's thread: the card is not answered and nothing is routed. */
	| { kind: "injected_rejected" };

export const APPROVAL_ACTION_PREFIX = "ompbot:approval";
export const CHOICE_ACTION_PREFIX = "ompbot:choice";
/** An unanswered card counts as denied after this long; the deadline is shown under its buttons. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;
const SUMMARY_LIMIT = 2500;
/** Per-section limit for the optional structured fields; the whole card stays under `CARD_LIMIT` for one Slack section. */
const FIELD_LIMIT = 400;
const CARD_LIMIT = 2900;

/** Optional structured sections of an approval card; every one is omitted when empty (summary-only callers unchanged). */
export interface ApprovalDetail {
	/** Where the action publishes outside the owner's own systems and who can see it; puts the card under the 🌐 title. */
	external?: string;
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
	{ key: "external", label: "🌐 외부 공개" },
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

/** `gh` commands that write to GitHub where others can see it (issue/PR/comment/release/gist/repo, mutating `gh api`). */
const GITHUB_PUBLISH =
	/\bgh\s+(?:(?:issue|pr)\s+(?:create|comment|edit|close|reopen|review|merge)|release\s+(?:create|edit|upload)|gist\s+create|repo\s+(?:create|edit|rename)|api\b[^\n]*?(?:-X|--method)[\s=]*(?:POST|PATCH|PUT|DELETE))\b/i;

/**
 * The detail with `external` filled in when the caller left it empty but the action (or summary) publishes to GitHub,
 * so a public post never reaches the owner looking like an ordinary local approval.
 */
function withExposure(summary: string, detail: ApprovalDetail | undefined): ApprovalDetail | undefined {
	if (detail?.external !== undefined && detail.external.trim() !== "") return detail;
	const hit = GITHUB_PUBLISH.exec(`${detail?.action ?? ""}\n${summary}`);
	if (hit === null) return detail;
	return { ...detail, external: `GitHub에 게시합니다. 공개 저장소면 누구나 봅니다(감지: ${hit[0]})` };
}

function cardTitle(detail: ApprovalDetail): string {
	return detail.external === undefined ? "🔐 승인 요청" : "🌐 외부 공개 승인 요청";
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
	const title = cardTitle(detail);
	const header = escalation === undefined ? title : `${title} ${escalation.ownerMention}`;
	const lines = [`${header}\n${shownSummary}`];
	if (escalation !== undefined) lines.push(`요청 위치: ${escalation.where}`);
	for (const { key, label } of DETAIL_SECTIONS) {
		const value = detail[key];
		if (value !== undefined) lines.push(`• ${label}: ${value}`);
	}
	return cutCodePointSafe(lines.join("\n"), CARD_LIMIT);
}

/**
 * `ompbot:approval:<approve|deny|retry>:<channel>:<ts>`; channel ids and message ts contain no colon. The key is always
 * the canonical card's, also on its mirror in the asking thread, so either card settles the same pending request.
 */
export function approvalActionId(decision: ApprovalDecision | "retry", channel: string, ts: string): string {
	return `${APPROVAL_ACTION_PREFIX}:${decision}:${channel}:${ts}`;
}

/** Approve/deny buttons of one card; their action ids carry the card's own message id. */
function approvalButtons(channel: string, ts: string): ActionButton[] {
	return [
		{ actionId: approvalActionId("approve", channel, ts), label: "승인", value: "approve", style: "primary" },
		{ actionId: approvalActionId("deny", channel, ts), label: "거부", value: "deny", style: "danger" },
	];
}

/** The one button of a timed-out card that came from a thread: the daemon asks that thread again (`다시 요청`). */
function retryButton(channel: string, ts: string): ActionButton {
	return { actionId: approvalActionId("retry", channel, ts), label: "다시 요청", value: "retry" };
}

/** The mirror's grey line: buttons only (a thread reply here is an ordinary message), the canonical card, the deadline. */
function mirrorNote(
	cardChannel: string,
	cardUrl: string | undefined,
	expiresAt: number,
	deadline: Intl.DateTimeFormat,
): string {
	const canonical = cardUrl === undefined ? `<#${cardChannel}>` : `<${cardUrl}|#escalation에서 보기>`;
	return `버튼으로 답해 주세요(이 스레드의 글 답장은 승인으로 세지 않음) · 정본 카드: ${canonical} · ⏳ ${deadline.format(expiresAt)}까지 답이 없으면 거부로 처리됩니다`;
}

function deadlineNote(expiresAt: number, timeoutMs: number, deadline: Intl.DateTimeFormat): string {
	return `⏳ ${deadline.format(expiresAt)}까지 버튼이나 이 스레드 답장이 없으면 거부로 처리됩니다(${Math.round(timeoutMs / 60_000)}분)`;
}

/** `ompbot:choice:<n>:<channel>:<ts>`: button `n` of the choice card `<channel>:<ts>` (no colon in either, as above). */
export function choiceActionId(index: number, channel: string, ts: string): string {
	return `${CHOICE_ACTION_PREFIX}:${index}:${channel}:${ts}`;
}

export function parseChoiceActionId(actionId: string): { index: number; channel: string; ts: string } | undefined {
	const parts = actionId.split(":");
	if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== CHOICE_ACTION_PREFIX) return undefined;
	const [, , index, channel, ts] = parts;
	if (index === undefined || !/^\d+$/.test(index) || !channel || !ts) return undefined;
	return { index: Number(index), channel, ts };
}

export function parseApprovalActionId(
	actionId: string,
): { decision: ApprovalDecision | "retry"; channel: string; ts: string } | undefined {
	const parts = actionId.split(":");
	if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== APPROVAL_ACTION_PREFIX) return undefined;
	const [, , decision, channel, ts] = parts;
	if ((decision !== "approve" && decision !== "deny" && decision !== "retry") || !channel || !ts) return undefined;
	return { decision, channel, ts };
}

/** The canonical card of a `다시 요청` click; `undefined` for any other action id. */
export function parseApprovalRetryActionId(actionId: string): { channel: string; ts: string } | undefined {
	const parsed = parseApprovalActionId(actionId);
	return parsed?.decision === "retry" ? { channel: parsed.channel, ts: parsed.ts } : undefined;
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
				originThreadRef: string | null;
				replyTs: string | null;
				summary: string;
				mirrorRef: string | null;
		  }
		| undefined;
	/** Records the mirror card (`<channel>:<ts>`) of a pending approval; false when it is no longer pending. */
	setApprovalMirrorRef(approvalId: string, mirrorRef: string): boolean;
	/** Settles a pending approval as `replied`; false when it was no longer pending (or already due). */
	replyApproval(approvalId: string, replyTs: string, text: string, now: number): boolean;
	decideApproval(approvalId: string, status: "approved" | "denied" | "expired", now: number): boolean;
	/** Expires due (or, with `due = false`, ALL) pending approvals and returns them for card updates. */
	expirePendingApprovals(
		now: number,
		due?: boolean,
	): Array<{
		approvalId: string;
		channel: string;
		messageTs: string;
		summary: string;
		originThreadRef: string | null;
		mirrorRef: string | null;
	}>;
}

export interface ApprovalBrokerOptions {
	/** Each card goes out on the port of its conversation's platform. */
	channels: ChannelRegistry;
	ownerUserId: string;
	/** The owner on each platform, for clicks on that platform's cards; a platform not listed uses `ownerUserId`. */
	platformOwners?: Partial<Record<ChatPlatform, string>> | undefined;
	/** Slack channel that receives the cards of requests that carry an origin (`ask` with `origin`); absent: the origin's own channel. */
	escalationChannel?: string | undefined;
	log: Logger;
	/** Durable ledger for approvals: survives restarts, double-click safe, expired rows are swept into cards. */
	store: ApprovalStore;
	clock?: { now(): number };
	/** The bot's zone (`config.timezone`): card deadlines and result times are `HH:MM` in it. */
	timezone: string;
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

/** A choice card (`ApprovalBroker.choose`): an omp dialog put to the owner in the asking conversation. */
export interface ChoiceCard {
	/** Card body; redacted and cut by the broker. */
	text: string;
	/** Button labels; button `n` carries `ompbot:choice:<n>:<channel>:<ts>`. Empty: the owner answers by reply only. */
	buttons: readonly string[];
	/** Indexes of the recommended buttons (one per `ask` question at most): drawn `primary`, the rest unstyled. */
	recommended?: readonly number[] | undefined;
	/** What an unanswered card turns into, for the deadline line (`…까지 답이 없으면 <fallback>로 처리됩니다`). */
	fallback: string;
	/** Deadline of this card; default: the broker's `timeoutMs`. */
	timeoutMs?: number | undefined;
}

/** One owner input on a choice card: a button click or a text answer (card-thread or conversation reply). */
export type ChoiceEvent = { kind: "choice"; index: number } | { kind: "text"; text: string };
/** What waiting on a choice card yields: owner input, or the end of the wait (deadline, withdrawn by the caller). */
export type ChoiceResult = ChoiceEvent | { kind: "timeout" } | { kind: "cancelled" };

/** An open choice card. Inputs queue up until read; `timeout`/`cancelled` end it and are returned from then on. */
export interface ChoiceCardHandle {
	next(): Promise<ChoiceResult>;
	/** Rewrites the open card (a partly answered `ask`); no-op once closed. */
	update(text: string, buttons: readonly string[]): Promise<void>;
	/** Final card text: the body plus `finalLine`, buttons removed. `answer` (what was chosen) settles the ledger row as replied. */
	close(finalLine: string, answer?: string): Promise<void>;
}

/** Where a queued choice input came from: a card-thread reply's ts, and who waits to learn whether it was read. */
interface ChoiceSource {
	replyTs?: string;
	/** Called once: true when the card read the input, false when the card closed with it still unread. */
	onRead?: (read: boolean) => void;
}

interface ChoicePending {
	originKey: string;
	buttons: number;
	/** Queues one owner input; false once the card is closed or ended. */
	push: (event: ChoiceEvent, source?: ChoiceSource) => boolean;
	isOpen: () => boolean;
	/** Card-thread reply ts already taken (a backfill replay is a duplicate). */
	replies: Set<string>;
}

/**
 * Choice-card ledger rows expire this long after the card's own deadline: the card's timer settles it first and
 * writes the real outcome, so the approval sweeper never races it to an approval-worded card.
 */
const CHOICE_LEDGER_GRACE_MS = 60_000;
/** First characters of every choice card body (choice.ts): how a ledger row tells a choice card from an approval. */
const CHOICE_HEADS = ["❓", "🔒"];
/** Slack: at most 75 characters per button label. */
const BUTTON_LABEL_LIMIT = 75;

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

/** The longest delay `setTimeout` keeps (2^31-1 ms, about 24.8 days); a longer one fires at once. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * Posts approve/deny buttons in the owner's DM and resolves when the owner clicks. Only the owner's click counts; any
 * other user, an unknown message or a repeated click is ignored. No click within `timeoutMs` resolves as `timeout`
 * (callers treat it as denied).
 */
export class ApprovalBroker {
	readonly #options: ApprovalBrokerOptions;
	readonly #timers: ApprovalTimers;
	readonly #clock: { now(): number };
	/** `HH:MM` in the bot's zone for the deadline line under the buttons and the result line. */
	readonly #deadline: Intl.DateTimeFormat;
	readonly #pending = new Map<string, Pending>();
	readonly #choices = new Map<string, ChoicePending>();

	constructor(options: ApprovalBrokerOptions) {
		this.#options = options;
		this.#timers = options.timers ?? realTimers;
		this.#clock = options.clock ?? { now: () => Date.now() };
		this.#deadline = new Intl.DateTimeFormat("en-GB", {
			timeZone: options.timezone,
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		});
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
			return await this.#port(channel).permalink(this.#ref(channel, ts));
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
		const { log, store } = this.#options;
		const escalation = this.#options.escalationChannel;
		// The escalation channel is one platform's value: a request from another platform's conversation stays there.
		const escalated =
			origin !== undefined &&
			escalation !== undefined &&
			escalation !== requestChannel &&
			platformOfConversationId(escalation) === platformOfConversationId(requestChannel);
		const channel = escalated ? escalation : requestChannel;
		const port = this.#port(channel);
		// Computed once: the card header and the ledger summary (and sections) must show the exact same text.
		const shown = cutCodePointSafe(redact(summary), SUMMARY_LIMIT);
		const sections = shownDetail(withExposure(summary, detail));
		const originUrl =
			origin?.threadTs === undefined ? undefined : await this.#permalink(origin.channel, origin.threadTs);
		const escalationLine = escalated
			? { ownerMention: port.mentionUser(this.#options.ownerUserId), where: this.#whereOf(origin, originUrl) }
			: undefined;
		// `header` stays the notification/fallback text; the card itself shows the sections as fields, not as lines.
		const header = renderCard(shown, sections, escalationLine);
		const fields = DETAIL_SECTIONS.flatMap(({ key, label }) => {
			const value = sections[key];
			return value === undefined ? [] : [{ label, value }];
		});
		const cardShape = {
			title: cardTitle(sections),
			body:
				escalationLine === undefined
					? shown
					: `${escalationLine.ownerMention}\n${shown}\n요청 위치: ${escalationLine.where}`,
			...(fields.length === 0 ? {} : { fields }),
		};
		// The mirror in the asking thread: same title and fields, no owner mention (one notification is enough).
		const mirrorShape = { ...cardShape, body: shown };
		let mirror: MessageRef | undefined;
		const card = await port.post({ conversationId: channel }, { text: header, ...cardShape });
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
				...cardShape,
				buttons: approvalButtons(channel, card.messageId),
				buttonsNote: deadlineNote(now + timeoutMs, timeoutMs, this.#deadline),
			});
			log.info("approval_requested", { channel, ts: card.messageId });
			if (escalated) {
				mirror =
					origin.threadTs === undefined
						? undefined
						: await this.#postMirror(origin.channel, origin.threadTs, {
								text: renderCard(shown, sections, undefined),
								...mirrorShape,
								buttons: approvalButtons(channel, card.messageId),
								buttonsNote: mirrorNote(channel, cardUrl, now + timeoutMs, this.#deadline),
							});
				if (mirror === undefined) await this.#postPointer(origin, channel, cardUrl, shown);
				else {
					if (recorded) this.#recordMirror(key, mirror);
					log.info("approval_mirrored", { channel, ts: card.messageId, mirror: mirror.messageId });
				}
			}
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
		const outcomeText = aborted
			? ABORTED_TEXT
			: typeof result === "string"
				? FINAL_TEXT[result]
				: `💬 답장으로 처리됨: ${replyLine(result.replied)}`;
		// The buttons give way to the result line; title and fields stay so the card still says what was decided.
		const resultLine = `${outcomeText} · ${this.#deadline.format(this.#clock.now())}`;
		// A timed-out request from a thread offers one `다시 요청` (the daemon asks that thread again); no other outcome does.
		const buttons =
			result === "timeout" && recorded && origin?.threadTs !== undefined ? [retryButton(channel, card.messageId)] : [];
		try {
			await port.edit(card, { text: `${header}\n${resultLine}`, ...cardShape, buttons, buttonsNote: resultLine });
		} catch (error) {
			log.warn("approval_final_update_failed", { channel, ts: card.messageId, error: String(error) });
		}
		if (mirror !== undefined) {
			try {
				await port.edit(mirror, {
					text: `${renderCard(shown, sections, undefined)}\n${resultLine}`,
					...mirrorShape,
					buttons,
					buttonsNote: resultLine,
				});
			} catch (error) {
				log.warn("approval_mirror_update_failed", { channel: mirror.conversationId, error: String(error) });
			}
		}
		return result;
	}

	/**
	 * Posts a choice card in the asking conversation (`origin`'s thread) and returns it open: button clicks, replies
	 * in the card's thread and the conversation's own replies (`answerDialog`) queue up as `ChoiceEvent`s. The card
	 * ends at its deadline (`timeout`) or when `signal` aborts (`cancelled`). The ledger keeps one approval row per
	 * card, so a daemon restart expires a card left open, exactly like an approval card.
	 */
	async choose(
		origin: ApprovalOrigin,
		card: ChoiceCard,
		options: { signal?: AbortSignal | undefined } = {},
	): Promise<ChoiceCardHandle> {
		const { signal } = options;
		const { log, store } = this.#options;
		const port = this.#port(origin.channel);
		const now = this.#clock.now();
		// omp's dialog timeout is any number; past the timer limit setTimeout would fire at once and the deadline
		// line could not format the date (RangeError), so the card is held open at most that long.
		const timeoutMs = Math.min(
			card.timeoutMs ?? this.#options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
			MAX_TIMER_DELAY_MS,
		);
		let body = cutCodePointSafe(redact(card.text), CARD_LIMIT);
		const note = `⏳ ${this.#deadline.format(now + timeoutMs)}까지 답이 없으면 ${card.fallback}로 처리됩니다`;
		const target = {
			conversationId: origin.channel,
			...(origin.threadTs === undefined ? {} : { threadId: origin.threadTs }),
		};
		// Reply-only cards carry the deadline in the text: the port shows `buttonsNote` only under buttons.
		const posted = await port.post(target, { text: card.buttons.length === 0 ? `${body}\n${note}` : body });
		const channel = posted.conversationId;
		const ts = posted.messageId;
		const key = `${channel}:${ts}`;
		const render = (text: string, labels: readonly string[]) =>
			labels.length === 0
				? { text: `${text}\n${note}` }
				: {
						text,
						buttons: labels.map((label, index) => ({
							actionId: choiceActionId(index, channel, ts),
							label: cutCodePointSafe(redact(label), BUTTON_LABEL_LIMIT),
							value: String(index),
							...(card.recommended?.includes(index) ? { style: "primary" as const } : {}),
						})),
						buttonsNote: note,
					};
		try {
			store.createApproval({
				approvalId: key,
				channel,
				messageTs: ts,
				summary: cutCodePointSafe(body, SUMMARY_LIMIT),
				createdAt: now,
				expiresAt: now + timeoutMs + CHOICE_LEDGER_GRACE_MS,
				originKey: origin.originKey,
				...(origin.threadTs === undefined ? {} : { originThreadRef: `${origin.channel}:${origin.threadTs}` }),
			});
		} catch (error) {
			log.warn("choice_record_failed", { channel, ts, error: String(error) });
		}
		const queue: Array<{ result: ChoiceResult; source?: ChoiceSource | undefined }> = [];
		let wake: (() => void) | undefined;
		let ended: ChoiceResult | undefined;
		let closed = false;
		/** The latest card-thread reply the card read: the ledger's `reply_ts`, so its backfill replay is a duplicate. */
		let replyTs: string | undefined;
		const enqueue = (result: ChoiceResult, source?: ChoiceSource): void => {
			queue.push({ result, source });
			wake?.();
		};
		const end = (result: { kind: "timeout" } | { kind: "cancelled" }): void => {
			if (ended !== undefined || closed) return;
			ended = result;
			enqueue(result);
		};
		const timer = this.#timers.set(() => end({ kind: "timeout" }), timeoutMs);
		const onAbort = () => end({ kind: "cancelled" });
		signal?.addEventListener("abort", onAbort, { once: true });
		const pending: ChoicePending = {
			originKey: origin.originKey,
			buttons: card.buttons.length,
			push: (event, source) => {
				if (closed || ended !== undefined) return false;
				enqueue(event, source);
				return true;
			},
			isOpen: () => !closed && ended === undefined,
			replies: new Set(),
		};
		this.#choices.set(key, pending);
		const release = (): void => {
			closed = true;
			this.#timers.clear(timer);
			signal?.removeEventListener("abort", onAbort);
			this.#choices.delete(key);
			// Inputs the card never read (a reply right behind the click that closed a select) go back to their sender.
			const unread = queue.filter((entry) => entry.source?.onRead !== undefined);
			queue.splice(0, queue.length, ...queue.filter((entry) => entry.source?.onRead === undefined));
			if (unread.length > 0) log.info("choice_reply_unread", { channel, ts, count: unread.length });
			for (const entry of unread) entry.source?.onRead?.(false);
		};
		try {
			if (card.buttons.length > 0) await port.edit(posted, render(body, card.buttons));
		} catch (error) {
			log.warn("choice_buttons_failed", { channel, ts, error: String(error) });
		}
		log.info("choice_requested", { channel, ts, origin: origin.originKey, buttons: card.buttons.length });
		if (signal?.aborted) onAbort();
		return {
			next: async () => {
				for (;;) {
					const head = queue.shift();
					if (head !== undefined) {
						const { result, source } = head;
						// A terminal result stays readable: every later read returns it too.
						if (result.kind === "timeout" || result.kind === "cancelled") queue.unshift(head);
						if (source?.replyTs !== undefined) replyTs = source.replyTs;
						source?.onRead?.(true);
						return result;
					}
					const arrived = Promise.withResolvers<void>();
					wake = arrived.resolve;
					await arrived.promise;
					wake = undefined;
				}
			},
			update: async (text, labels) => {
				if (closed) return;
				body = cutCodePointSafe(redact(text), CARD_LIMIT);
				pending.buttons = labels.length;
				try {
					await port.edit(
						posted,
						labels.length === 0 ? { ...render(body, labels), buttons: [] } : render(body, labels),
					);
				} catch (error) {
					log.warn("choice_update_failed", { channel, ts, error: String(error) });
				}
			},
			close: async (finalLine, answer) => {
				if (closed) return;
				release();
				try {
					if (answer === undefined) store.decideApproval(key, "expired", this.#clock.now());
					else store.replyApproval(key, replyTs ?? `choice:${ts}`, answer, this.#clock.now());
				} catch (error) {
					log.warn("choice_decide_failed", { channel, ts, error: String(error) });
				}
				log.info("choice_resolved", {
					channel,
					ts,
					outcome: ended?.kind ?? (answer === undefined ? "closed" : "answered"),
				});
				try {
					await port.edit(posted, { text: `${body}\n${cutCodePointSafe(redact(finalLine), 400)}`, buttons: [] });
				} catch (error) {
					log.warn("choice_final_update_failed", { channel, ts, error: String(error) });
				}
			},
		};
	}

	/** Choice cards of `originKey` still waiting for the owner. */
	openDialogs(originKey: string): number {
		let open = 0;
		for (const choice of this.#choices.values()) if (choice.originKey === originKey && choice.isOpen()) open += 1;
		return open;
	}

	/**
	 * The owner's plain message in the asking conversation answers its one open choice card. Resolves true once the
	 * card has read it; false when there is no single open card or the card closed before reading it (a select
	 * answered by a click a moment earlier) — the caller then delivers the message the normal way.
	 */
	answerDialog(originKey: string, text: string): Promise<boolean> {
		const open = [...this.#choices.values()].filter((choice) => choice.originKey === originKey && choice.isOpen());
		const only = open.length === 1 ? open[0] : undefined;
		const read = Promise.withResolvers<boolean>();
		return only?.push({ kind: "text", text }, { onRead: read.resolve }) === true
			? read.promise
			: Promise.resolve(false);
	}

	/**
	 * The mirror card in the asking thread, its buttons carrying the canonical card's key; `undefined` when the post
	 * failed (the caller falls back to the pointer line).
	 */
	async #postMirror(channel: string, threadTs: string, card: OutboundMessage): Promise<MessageRef | undefined> {
		try {
			return await this.#port(channel).post({ conversationId: channel, threadId: threadTs }, card);
		} catch (error) {
			this.#options.log.warn("approval_mirror_failed", { channel, error: String(error) });
			return undefined;
		}
	}

	/** The mirror goes on the ledger row, so a restart expiry can rewrite it too; a failure only loses that rewrite. */
	#recordMirror(approvalId: string, mirror: MessageRef): void {
		try {
			this.#options.store.setApprovalMirrorRef(approvalId, `${mirror.conversationId}:${mirror.messageId}`);
		} catch (error) {
			this.#options.log.warn("approval_mirror_record_failed", { id: approvalId, error: String(error) });
		}
	}

	/** One pointer line in the asking thread (or the channel's main view) naming the escalation card; best effort. */
	async #postPointer(
		origin: ApprovalOrigin,
		cardChannel: string,
		cardUrl: string | undefined,
		shown: string,
	): Promise<void> {
		const { log } = this.#options;
		try {
			const port = this.#port(origin.channel);
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
	 * An `injected` message (`ompbot inject`, which anyone with the socket can send) never answers a card: in the thread
	 * of a real choice card or of any approval row (pending or settled) it is `injected_rejected`, the card untouched.
	 */
	handleCardReply(reply: {
		approvalId: string;
		ts: string;
		text: string;
		injected?: boolean | undefined;
	}): CardReplyResult | undefined {
		const { store, log } = this.#options;
		if (
			reply.injected === true &&
			(this.#choices.has(reply.approvalId) || store.getApproval(reply.approvalId) !== undefined)
		) {
			log.warn("inject_card_reply_refused", { id: reply.approvalId, ts: reply.ts });
			return { kind: "injected_rejected" };
		}
		// An open choice card takes every reply in its thread as one more answer (an `ask` card may need several).
		const choice = this.#choices.get(reply.approvalId);
		if (choice?.replies.has(reply.ts)) return { kind: "duplicate" };
		if (choice?.push({ kind: "text", text: reply.text }, { replyTs: reply.ts })) {
			choice.replies.add(reply.ts);
			log.info("choice_reply", { id: reply.approvalId, ts: reply.ts });
			return { kind: "settled" };
		}
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
		const { store, log } = this.#options;
		const expired = store.expirePendingApprovals(this.#clock.now(), due);
		for (const row of expired) {
			// A choice card's ledger summary is its own body, which always opens with its ❓/🔒 head (`choose`);
			// an approval's summary is the request text under the separate 🔐 header.
			const choice = CHOICE_HEADS.some((head) => row.summary.startsWith(head));
			const reason = due
				? choice
					? "⌛ 시간 초과로 만료됨"
					: FINAL_TEXT.timeout
				: "⌛ 데몬 재시작으로 만료됨 — 다시 요청해 주세요";
			// An approval from a thread offers `다시 요청` on the card and on its mirror; a choice card never does.
			const message = {
				text: `${choice ? "❓ 질문" : "🔐 승인 요청"}\n${reason}`,
				buttons: !choice && row.originThreadRef !== null ? [retryButton(row.channel, row.messageTs)] : [],
			};
			for (const ref of [`${row.channel}:${row.messageTs}`, ...(row.mirrorRef === null ? [] : [row.mirrorRef])]) {
				const [channel = "", ts = ""] = ref.split(":");
				try {
					await this.#port(channel).edit(this.#ref(channel, ts), message);
				} catch (error) {
					log.warn("approval_expire_card_failed", { channel, ts, error: String(error) });
				}
			}
		}
		return expired.length;
	}

	/**
	 * Rewrites a settled approval's cards (canonical, mirror, and the clicked message when it is neither) to `note`
	 * with no buttons: the result of a `다시 요청` click. Without a ledger row only the canonical and clicked cards
	 * are known.
	 */
	async redrawCards(approvalId: string, note: string, clicked?: { channel: string; ts: string }): Promise<void> {
		const { store, log } = this.#options;
		const row = store.getApproval(approvalId);
		const message =
			row === undefined
				? { text: `🔐 승인 요청\n${note}`, buttons: [] }
				: {
						text: `🔐 승인 요청\n${row.summary}\n${note}`,
						title: "🔐 승인 요청",
						body: row.summary,
						buttons: [],
						buttonsNote: note,
					};
		const refs = new Set([approvalId, ...(row === undefined || row.mirrorRef === null ? [] : [row.mirrorRef])]);
		if (clicked !== undefined) refs.add(`${clicked.channel}:${clicked.ts}`);
		for (const ref of refs) {
			const [channel = "", ts = ""] = ref.split(":");
			try {
				await this.#port(channel).edit(this.#ref(channel, ts), message);
			} catch (error) {
				log.warn("approval_redraw_failed", { channel, ts, error: String(error) });
			}
		}
	}

	/** A message of the approval conversation (card or asking thread) on its platform's port. */
	#ref(conversationId: string, messageId: string): MessageRef {
		return { platform: this.#port(conversationId).platform, conversationId, messageId };
	}

	/** The port of a conversation's platform; throws for a conversation no registered platform owns. */
	#port(conversationId: string): ChannelPort {
		return this.#options.channels.portFor(conversationId);
	}

	/** The owner who may click a card in `conversationId`: that platform's owner. */
	#ownerOf(conversationId: string): string {
		const platform = platformOfConversationId(conversationId);
		return (platform === undefined ? undefined : this.#options.platformOwners?.[platform]) ?? this.#options.ownerUserId;
	}

	/** Returns true when the click settled a pending request (or was taken by an open choice card). */
	handleAction(action: { actionId: string; userId: string }): boolean {
		const { log } = this.#options;
		const choice = parseChoiceActionId(action.actionId);
		if (choice !== undefined) {
			if (action.userId !== this.#ownerOf(choice.channel)) {
				log.warn("choice_click_ignored", { user: action.userId, reason: "not_owner" });
				return false;
			}
			const pending = this.#choices.get(`${choice.channel}:${choice.ts}`);
			if (
				pending === undefined ||
				choice.index >= pending.buttons ||
				!pending.push({ kind: "choice", index: choice.index })
			) {
				log.info("choice_click_ignored", { user: action.userId, reason: "not_open" });
				return false;
			}
			log.info("choice_click", { user: action.userId, index: choice.index });
			return true;
		}
		const parsed = parseApprovalActionId(action.actionId);
		// `다시 요청` belongs to the daemon (it feeds the asking thread), not to a pending request.
		if (!parsed || parsed.decision === "retry") return false;
		if (action.userId !== this.#ownerOf(parsed.channel)) {
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
