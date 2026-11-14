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

/**
 * A Teams question answered read-only (a guest, or the owner under `ownerMode: qa`). Its own type, without
 * `ownerVerified`: it can never be passed where an owner message is expected.
 */
export interface GuestInboundMessage {
	platformMessageId: string;
	/** The conversation's ledger alias. */
	conversationId: string;
	kind: "dm" | "ch";
	/** `<alias>:<Activity id>`: the answer replies to the question. */
	threadRef: string;
	/** The question as typed, mention tags removed. */
	text: string;
	asker: { aadObjectId: string; name?: string | undefined };
	/** The owner writing under `ownerMode: qa` (only then may `!home` act). */
	owner: boolean;
}

/** The adapter's whole view of the core. Owner input arrives through `onInbound`, peer bot input through `onPeerInbound`. */
export interface CoreSink {
	/**
	 * A guest/qa question: answered by a one-shot read-only run, never the owner's session or mailbox. `duplicate`: a
	 * redelivery of a question already taken (no typing indicator).
	 */
	onGuestInbound?(message: GuestInboundMessage): { duplicate?: boolean } | undefined;
	/**
	 * A peer bot's request. The core decides what the adapter cannot see: a duplicate, a work lane's thread
	 * (`peer_in_lane_thread`) and the thread's hop cap (`peer_hop_cap`; `notice` is true exactly once per cap episode,
	 * the adapter then posts the cap notice).
	 */
	onPeerInbound?(message: PeerInboundMessage, hop: { turns: number; windowMs: number }): PeerInboundOutcome;
	/**
	 * A peer bot posted in `threadRef` at `at` (the post's own time), whether or not the bot takes the post (no mention,
	 * muted thread, hop cap): it answers this bot's earlier calls to that peer there (peer silence alert).
	 */
	onPeerSeen?(seen: { threadRef: string; peerUserId: string; at: number }): void;
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
	 * `undefined`: not an approval card thread — the reply takes the normal inbound path. An `injected` message in a
	 * card's thread is `injected_rejected`: the card is neither answered nor routed.
	 */
	onCardReply?(reply: {
		threadRef: string;
		platformMessageId: string;
		text: string;
		injected?: boolean | undefined;
	}):
		| { kind: "settled" }
		| { kind: "duplicate" }
		| { kind: "route"; originKey: string }
		| { kind: "injected_rejected" }
		| undefined;
	/** Whether the bot already takes part in this thread, so an unaddressed owner reply in a channel thread counts. */
	knowsThread?(threadRef: string): boolean;
	/** True while a restart drain holds dispatch: a message taken now waits for the next process (no typing shown). */
	isDraining?(): boolean;
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
	/**
	 * `definitive`: nothing was posted (backoff and retry). `ambiguous`: a message may exist (sticky, never auto-resent).
	 * True when a definitive failure spent the retries (the row expired): the answer will not be sent.
	 */
	fail(
		deliveryId: number,
		error: string,
		outcome: "definitive" | "ambiguous",
	): Promise<boolean | undefined> | boolean | undefined;
	/**
	 * This platform's rows the ledger expired since the last call (past the freshness window while pending), each handed
	 * over once. Absent: expiry finishes nothing.
	 */
	takeExpired?(): Promise<DeliveryItem[]> | DeliveryItem[];
	/** Rate limited (429 or still blocked): nothing more was posted; retry at `retry.at` without counting a failure. */
	defer(deliveryId: number, error: string, retry: DeliveryRetry): Promise<void> | void;
}

export interface AdapterClock {
	now(): number;
}

/** What a single inbound event ended up as (`ingestRecovered`/`ingestOwner` report this). */
export type IngestOutcome =
	| "recorded"
	| "duplicate"
	| "dropped"
	/** An injected owner message in an approval/choice card's thread: refused, the card untouched. */
	| "card_rejected";
