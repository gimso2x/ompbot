// What an adapter and the core say to each other, whatever the chat platform: inbound messages, the core's verdicts and
// the delivery ledger view an adapter's pump works on.
import type { CommandKind } from "../core/types";

/** What the core receives for an accepted owner message. Structurally what the store's recordInbound needs, plus the thread. */
export interface InboundMessage {
	platformMessageId: string;
	originKey: string;
	text: string;
	threadRef: string;
	ownerVerified: true;
}

/**
 * What the core receives for an accepted peer bot message. Its own type, without `ownerVerified`: it can never be
 * passed where an owner message is expected.
 */
export interface PeerInboundMessage {
	platformMessageId: string;
	originKey: string;
	/** Header and fenced body (see `normalizePeerInbound`). */
	text: string;
	threadRef: string;
	peer: { userId: string; name: string };
}

/** The core's verdict on a peer message: recorded (empty), a redelivery, or dropped (`notice`: post the cap notice now). */
export interface PeerInboundOutcome {
	duplicate?: true;
	dropped?: "peer_in_lane_thread" | "peer_hop_cap";
	notice?: boolean;
}

/** The adapter's whole view of the core. Owner input arrives through `onInbound`, peer bot input through `onPeerInbound`. */
export interface CoreSink {
	/**
	 * A peer bot's request. The core decides what the adapter cannot see: a duplicate, a work lane's thread
	 * (`peer_in_lane_thread`) and the thread's hop cap (`peer_hop_cap`; `notice` is true exactly once per cap episode,
	 * the adapter then posts the cap notice).
	 */
	onPeerInbound?(message: PeerInboundMessage, hop: { turns: number; windowMs: number }): PeerInboundOutcome;
	/** `duplicate: true` (Slack redelivery of a message already recorded) suppresses the 👀 and the status message. */
	onInbound(
		message: InboundMessage,
	): Promise<{ duplicate?: boolean } | undefined> | { duplicate?: boolean } | undefined;
	/** Ephemeral reply text; `undefined` sends an empty ack because the answer is posted as its own message. */
	onCommand(command: {
		command: CommandKind;
		/** Text after the slash command (`""` when none). */
		arg: string;
		originKey: string;
		channel: string;
		userId: string;
	}): Promise<string | undefined> | string | undefined;
	onAction(action: {
		actionId: string;
		value?: string | undefined;
		userId: string;
		channel?: string | undefined;
		messageTs?: string | undefined;
	}): Promise<void> | void;
	/**
	 * An owner reply in a thread: if that thread is an approval card's, the core settles the card with the reply
	 * (`settled`), recognises a replay (`duplicate`) or names the asking conversation the reply must reach (`route`).
	 * `undefined`: not an approval card thread — the reply takes the normal inbound path.
	 */
	onCardReply?(reply: {
		threadRef: string;
		platformMessageId: string;
		text: string;
	}): { kind: "settled" } | { kind: "duplicate" } | { kind: "route"; originKey: string } | undefined;
	/** Whether the bot already takes part in this thread, so an unaddressed owner reply in a channel thread counts. */
	knowsThread?(threadRef: string): boolean;
	/** Whether the owner muted this thread with `!shutup`: the bot stays quiet there until a mention or `!unshutup`. */
	isThreadMuted?(threadRef: string): boolean;
	/** Records or clears a thread mute (`!shutup` / `!unshutup` / mention release); idempotent. */
	setThreadMute?(threadRef: string, muted: boolean): void;
	/**
	 * Whether this exact mute-command event was already handled. A mute command never becomes an inbound row (it takes
	 * no turn), so without this a backfill replay of the same `!shutup` event would re-post the 🤫/🔊 notice on every
	 * pass. Pure lookup; `rememberMuteCommand` is the recording half.
	 */
	seenMuteCommand?(platformMessageId: string): boolean;
	/** Durably marks a mute-command event handled after it ran, so replays resolve as duplicates. */
	rememberMuteCommand?(platformMessageId: string): void;
}

export interface DeliveryItem {
	deliveryId: number;
	originKey: string;
	threadRef: string;
	body: string;
	redelivered: boolean;
	/** Other threads whose rows were closed by the same op (steered messages): their status is finished too. */
	finishThreadRefs?: readonly string[] | undefined;
	/** Threads of rows the same op discarded (`queue drop`): their ⏳ ends as `🚫 취소됨` instead of ✅/⚠️. */
	cancelThreadRefs?: readonly string[] | undefined;
	/**
	 * False for output nobody asked for in that thread (a work lane's own report): a thread without a running status
	 * entry is then left alone instead of getting the post-restart ✅ reaction. Default true.
	 */
	finishUntracked?: boolean | undefined;
	/**
	 * A text sent while its turn still runs (interim delivery): the thread's status message and progress keep going,
	 * and the answer gets no elapsed-time footer. Default false.
	 */
	keepStatus?: boolean | undefined;
	/** Messages of this answer a rate-limited earlier send already posted: the send resumes after them. */
	sentParts?: number | undefined;
	/** Top-level answer resumed after part 1: the ts parts 2+ reply under. */
	replyTs?: string | null | undefined;
}

/** Where a rate-limited send stopped and when the platform takes posts again. */
export interface DeliveryRetry {
	at: number;
	sentParts: number;
	replyTs?: string | undefined;
}

/** Implemented by the daemon on top of the store; the adapter never imports the mailbox or the store. */
export interface DeliverySource {
	claimDue(): Promise<DeliveryItem[]> | DeliveryItem[];
	confirm(deliveryId: number): Promise<void> | void;
	/** `definitive`: nothing was posted (backoff and retry). `ambiguous`: a message may exist (sticky, never auto-resent). */
	fail(deliveryId: number, error: string, outcome: "definitive" | "ambiguous"): Promise<void> | void;
	/** Rate limited (429 or still blocked): nothing more was posted; retry at `retry.at` without counting a failure. */
	defer(deliveryId: number, error: string, retry: DeliveryRetry): Promise<void> | void;
	/**
	 * One message a delivery posted (`part`: its 0-based index in the answer), so a reaction on it finds the turn.
	 * A throw is logged (`delivery_post_record_failed`) and never stops the delivery. Absent: nothing is recorded.
	 */
	recordPost?(post: { channel: string; ts: string; deliveryId: number; part: number }): Promise<void> | void;
	/**
	 * Whether a delivery posted that message (`recordPost` saw it). A platform whose reaction events do not say who
	 * wrote the message asks this before `recordFeedback`. Absent: every reaction goes on to `recordFeedback`.
	 */
	isPost?(post: { channel: string; ts: string }): Promise<boolean> | boolean;
	/** The owner added or removed 👍/👎 on a message; the source ignores messages no delivery posted. */
	recordFeedback?(feedback: {
		channel: string;
		ts: string;
		verdict: "up" | "down";
		action: "added" | "removed";
		eventTs: string;
	}): Promise<void> | void;
}

export interface AdapterClock {
	now(): number;
}

/** What a single inbound event ended up as (`ingestRecovered`/`ingestOwner` report this). */
export type IngestOutcome = "recorded" | "duplicate" | "dropped";
