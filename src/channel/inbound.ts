// Inbound steps the Slack and Discord adapters share: addressing, card replies, the core records and
// thread-link tokens. Platform work (ids, posting, the status message) comes in as callbacks.
import { parseThreadRef, THREAD_LINK_PREFIX } from "../core/normalize";
import { parseCommand } from "../core/types";
import type { Logger } from "../log";
import { errorText } from "./text";
import type { CoreSink, InboundMessage, IngestOutcome, PeerInboundMessage } from "./types";

/** Logs a redelivery and reports it. */
export function duplicate(log: Logger, id: string): IngestOutcome {
	log.info("inbound_duplicate", { id });
	return "duplicate";
}

/** `handleMessage`: a failed message is logged and reported (the backfill re-reaches it), never thrown. */
export async function guardInbound(
	log: Logger,
	where: Record<string, string>,
	onFailure: (() => void) | undefined,
	run: () => Promise<unknown>,
): Promise<void> {
	try {
		await run();
	} catch (err) {
		log.error("inbound_failed", { ...where, error: errorText(err) });
		try {
			onFailure?.();
		} catch (cbErr) {
			log.warn("inbound_failure_callback_failed", { error: errorText(cbErr) });
		}
	}
}

/**
 * Addressing in a channel: a mention, a mention-free channel or a thread the bot knows (only the mention under
 * `requireMention`). A message meant only for a peer bot is not addressed.
 */
export function isChannelMessageAddressed(
	core: CoreSink,
	input: {
		mentioned: boolean;
		forPeer: boolean;
		threadRef: string | undefined;
		requireMention: boolean;
		mentionFree: boolean;
	},
): boolean {
	const { mentioned, threadRef } = input;
	const audible = input.requireMention
		? mentioned
		: input.mentionFree || mentioned || (threadRef !== undefined && core.knowsThread?.(threadRef) === true);
	return audible && !input.forPeer;
}

/**
 * An owner reply in a card's thread: a pending card is settled by it, a settled card's reply goes to the asking
 * conversation (`begin` starts its status). `undefined`: no card behind the thread.
 */
export async function settleCardReply(
	core: CoreSink,
	log: Logger,
	reply: { threadRef: string; platformMessageId: string; text: string; injected: boolean },
	begin: (originKey: string) => Promise<void>,
): Promise<IngestOutcome | undefined> {
	const result = core.onCardReply?.(reply);
	if (result === undefined) return undefined;
	if (result.kind === "injected_rejected") return "card_rejected";
	if (result.kind === "duplicate") return duplicate(log, reply.platformMessageId);
	if (result.kind === "settled") return "recorded";
	const { threadRef, platformMessageId, text } = reply;
	const outcome = await core.onInbound({
		platformMessageId,
		originKey: result.originKey,
		text,
		threadRef,
		ownerVerified: true,
	});
	if (outcome?.duplicate) return duplicate(log, platformMessageId);
	await begin(result.originKey);
	return "recorded";
}

/** Records an owner message; a new one gets its status, shown unless it is a command other than a follow-up. */
export async function recordInbound(
	core: CoreSink,
	log: Logger,
	inbound: InboundMessage,
	begin: (thread: { channel: string; threadTs: string }, showStatus: boolean) => Promise<void>,
): Promise<IngestOutcome> {
	const outcome = await core.onInbound(inbound);
	if (outcome?.duplicate) return duplicate(log, inbound.platformMessageId);
	const parsed = parseThreadRef(inbound.threadRef);
	if (parsed !== undefined) {
		const command = parseCommand(inbound.text);
		await begin(parsed, command === undefined || command.kind === "followup");
	}
	return "recorded";
}

/**
 * Records a peer bot message under the thread's hop cap; `notice` posts the cap notice once per cap episode.
 * `undefined`: recorded, the caller starts its status.
 */
export async function recordPeerInbound(
	core: CoreSink,
	log: Logger,
	inbound: PeerInboundMessage,
	limit: { turns: number; windowMinutes: number },
	drop: (reason: string) => IngestOutcome,
	notice: () => Promise<void>,
): Promise<IngestOutcome | undefined> {
	const outcome = core.onPeerInbound?.(inbound, { turns: limit.turns, windowMs: limit.windowMinutes * 60_000 });
	if (outcome === undefined) return drop("peer_unsupported");
	if (outcome.duplicate) return duplicate(log, inbound.platformMessageId);
	if (outcome.dropped === undefined) return undefined;
	drop(outcome.dropped);
	// No bot mention in the notice: it must not invite another peer reply.
	if (outcome.dropped === "peer_hop_cap" && outcome.notice === true) await notice();
	return "dropped";
}

/**
 * Swaps each `{{thread-link:<conversation>:<id>}}` the ledger left (log copy, steered-thread pointer) for
 * ` · [스레드 보기](<permalink>)`; none when the permalink fails.
 */
export async function resolveThreadLinks(
	body: string,
	pattern: RegExp,
	log: Logger,
	permalink: (conversationId: string, id: string) => Promise<string | undefined>,
): Promise<string> {
	if (!body.includes(THREAD_LINK_PREFIX)) return body;
	let out = "";
	let last = 0;
	for (const match of body.matchAll(pattern)) {
		out += body.slice(last, match.index);
		last = match.index + match[0].length;
		const [, conversationId = "", id = ""] = match;
		try {
			const url = await permalink(conversationId, id);
			if (url !== undefined) out += ` · [스레드 보기](${url})`;
		} catch (err) {
			log.warn("permalink_failed", { channel: conversationId, error: errorText(err) });
		}
	}
	return out + body.slice(last);
}
