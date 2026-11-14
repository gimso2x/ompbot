// The delivery loop every adapter shares: claim → send → confirm/fail/defer → finish the thread's status once sent,
// or once the ledger gave up on it (ambiguous, retries spent, expired). The platform part (how one delivery is posted,
// whether its post path is rate limited) is the `DeliverySender`; `finishDeliveryStatus` is the status finish they share.
import type { Logger } from "../log";
import type { RetryAfterGate } from "./retry";
import { errorText, type FinalOutcome } from "./text";
import type { AdapterClock, DeliveryItem, DeliveryRetry, DeliverySource } from "./types";

export type DeliverySendResult =
	| { kind: "sent"; parts: number; path?: string }
	| { kind: "deferred"; error: unknown; retry: DeliveryRetry }
	/** `sentParts`: messages of the answer already posted before the failure (logged). */
	| { kind: "failed"; error: string; outcome: "definitive" | "ambiguous"; sentParts: number };

export interface DeliverySender {
	/** Whether this platform's post path is rate limited right now. */
	isBlocked(): boolean;
	/** When the current block ends (the retry time of a delivery deferred by it). */
	blockedUntil(): number;
	/** The error text a delivery deferred by the block carries. */
	blockedReason(): string;
	send(delivery: DeliveryItem): Promise<DeliverySendResult>;
	/** After the confirm: the thread's status message and reactions are finished. */
	afterSent(delivery: DeliveryItem): Promise<void>;
	/** The answer will not be sent (ambiguous, retries spent, expired): the status ends as undelivered. Never for a defer. */
	afterUndelivered(delivery: DeliveryItem): Promise<void>;
}

/** An adapter's status finish (`finishStatus`), and whether it tracks a running status in a thread. */
export interface StatusFinisher {
	finishStatus(threadRef: string, outcome: FinalOutcome, action: "delete" | "update"): Promise<void>;
	/** Absent: every thread of the delivery is finished, tracked or not. */
	tracks?(threadRef: string): boolean;
}

/**
 * The status finish every adapter's `afterSent`/`afterUndelivered` runs: the answer's thread and every thread its op
 * closed (steered messages sit in their own threads) end ✅/⚠️ (`sent`) or `⚠️ 답을 보내지 못했습니다` (`undelivered`);
 * threads of rows the op discarded end 🚫 취소됨. Only the thread holding a sent answer (and its footer) drops the status
 * message; the others keep the label. An interim delivery leaves the running status alone.
 */
export async function finishDeliveryStatus(
	delivery: DeliveryItem,
	result: "sent" | "undelivered",
	finisher: StatusFinisher,
): Promise<void> {
	if (delivery.keepStatus) return;
	const outcome: FinalOutcome =
		result === "undelivered" ? "undelivered" : delivery.body.startsWith("[turn failed]") ? "failed" : "done";
	const cancelled = new Set(delivery.cancelThreadRefs ?? []);
	for (const threadRef of new Set([delivery.threadRef, ...(delivery.finishThreadRefs ?? [])])) {
		if (delivery.finishUntracked === false && finisher.tracks?.(threadRef) === false) continue;
		const final = cancelled.has(threadRef) ? "cancelled" : outcome;
		const holdsAnswer = threadRef === delivery.threadRef && (final === "done" || final === "failed");
		await finisher.finishStatus(threadRef, final, holdsAnswer ? "delete" : "update");
	}
}

/**
 * The sender half every adapter shares around its own `send`: the post route's block (one `RetryAfterGate` key) and
 * the status finish after a confirm or once the answer is given up.
 */
export function deliverySender(options: {
	gate: RetryAfterGate;
	/** The gate key the post path is parked under (`chat.postMessage`, `post`). */
	key: string;
	/** The error text a delivery deferred by the block carries (the platform's own wording). */
	blockedReason: string;
	send(delivery: DeliveryItem): Promise<DeliverySendResult>;
	/** `sent`: the answer is out; `undelivered`: the ledger gave up on it. */
	finish(delivery: DeliveryItem, result: "sent" | "undelivered"): Promise<void>;
}): DeliverySender {
	const { gate, key, send, finish } = options;
	return {
		isBlocked: () => gate.isBlocked(key),
		blockedUntil: () => gate.untilOf(key) ?? gate.clock.now(),
		blockedReason: () => options.blockedReason,
		send,
		afterSent: (delivery) => finish(delivery, "sent"),
		afterUndelivered: (delivery) => finish(delivery, "undelivered"),
	};
}

/**
 * The footer an answer carries in place of its thread's `⏳` status message: none for an interim delivery (the status
 * keeps running) or a thread the same op cancelled, otherwise the platform's own `footerOf` for the answer's thread.
 */
export function answerFooter(
	delivery: DeliveryItem,
	footerOf: (threadRef: string, outcome: "done" | "failed") => string | undefined,
): string | undefined {
	if (delivery.keepStatus === true || (delivery.cancelThreadRefs ?? []).includes(delivery.threadRef)) return undefined;
	return footerOf(delivery.threadRef, delivery.body.startsWith("[turn failed]") ? "failed" : "done");
}

export interface DeliveryPumpOptions {
	source: DeliverySource;
	sender: DeliverySender;
	clock: AdapterClock;
	log: Logger;
}

export class DeliveryPump {
	readonly #options: DeliveryPumpOptions;

	constructor(options: DeliveryPumpOptions) {
		this.#options = options;
	}

	/**
	 * Claims due deliveries and sends them. Does nothing while the post path is blocked; a block that starts mid-batch
	 * (a 429) sends the rest of the batch back unsent to wait for it. Returns how many were confirmed.
	 */
	async pump(): Promise<number> {
		const { source, sender, log } = this.#options;
		// Finishing a status does not post an answer, so expired rows are finished even while posting is blocked.
		await this.#finishExpired();
		if (sender.isBlocked()) return 0;
		let confirmed = 0;
		for (const delivery of await source.claimDue()) {
			if (sender.isBlocked()) {
				await this.#defer(delivery, sender.blockedReason(), {
					at: sender.blockedUntil(),
					sentParts: delivery.sentParts ?? 0,
				});
				continue;
			}
			let result: DeliverySendResult;
			try {
				result = await sender.send(delivery);
			} catch (err) {
				// The claim already holds it in flight. A send that throws instead of answering may have posted any number
				// of parts, so it is ambiguous (never resent blindly); the rest of the batch still goes out.
				await this.#fail(delivery, errorText(err), "ambiguous", delivery.sentParts ?? 0);
				continue;
			}
			if (result.kind === "deferred") {
				await this.#defer(delivery, errorText(result.error), result.retry);
				continue;
			}
			if (result.kind === "failed") {
				await this.#fail(delivery, result.error, result.outcome, result.sentParts);
				continue;
			}
			// The answer is out either way: a confirm that throws is logged, never resent, and the status still finishes.
			if (await this.#ledger(delivery, "confirm", () => source.confirm(delivery.deliveryId))) {
				log.info("delivery_sent", {
					id: delivery.deliveryId,
					parts: result.parts,
					...(result.path === undefined ? {} : { path: result.path }),
					redelivered: delivery.redelivered,
				});
				confirmed += 1;
			}
			try {
				await sender.afterSent(delivery);
			} catch (err) {
				// The answer is out and confirmed with its parts; only the status finish failed.
				log.warn("delivery_after_sent_failed", { id: delivery.deliveryId, parts: result.parts, error: errorText(err) });
			}
		}
		return confirmed;
	}

	/**
	 * A failed send: an ambiguous one is never resent, and a definitive one whose ledger write says the retries are spent
	 * is not either — both end the thread's status as undelivered. A definitive failure with retries left waits for them.
	 */
	async #fail(
		delivery: DeliveryItem,
		error: string,
		outcome: "definitive" | "ambiguous",
		sentParts: number,
	): Promise<void> {
		const { source, log } = this.#options;
		log.warn("delivery_failed", { id: delivery.deliveryId, sent_parts: sentParts, outcome, error });
		let gaveUp = outcome === "ambiguous";
		const written = await this.#ledger(delivery, "fail", async () => {
			if ((await source.fail(delivery.deliveryId, error, outcome)) === true) gaveUp = true;
		});
		if (written && gaveUp) await this.#undelivered(delivery);
	}

	/** Rows the ledger expired since the last pump: their threads' statuses end as undelivered. */
	async #finishExpired(): Promise<void> {
		const { source, log } = this.#options;
		if (source.takeExpired === undefined) return;
		let expired: DeliveryItem[];
		try {
			expired = await source.takeExpired();
		} catch (err) {
			log.error("delivery_take_expired_failed", { error: errorText(err) });
			return;
		}
		for (const delivery of expired) {
			log.warn("delivery_expired", { id: delivery.deliveryId });
			await this.#undelivered(delivery);
		}
	}

	/** The answer is not going out: a status finish that throws is one warn line, never a stop of the batch. */
	async #undelivered(delivery: DeliveryItem): Promise<void> {
		try {
			await this.#options.sender.afterUndelivered(delivery);
		} catch (err) {
			this.#options.log.warn("delivery_undelivered_finish_failed", { id: delivery.deliveryId, error: errorText(err) });
		}
	}

	/** Back to pending until the block ends; `retry.sentParts` messages of it are already posted. */
	async #defer(delivery: DeliveryItem, error: string, retry: DeliveryRetry): Promise<void> {
		const { source, clock, log } = this.#options;
		log.warn("delivery_deferred", {
			id: delivery.deliveryId,
			sent_parts: retry.sentParts,
			retry_in_ms: Math.max(0, retry.at - clock.now()),
			error,
		});
		await this.#ledger(delivery, "defer", () => source.defer(delivery.deliveryId, error, retry));
	}

	/**
	 * One ledger write (confirm/fail/defer). A throw (SQLITE_FULL/BUSY) is logged and the batch goes on; the row stays
	 * in flight as claimed, which the next start recovers. False when it threw.
	 */
	async #ledger(delivery: DeliveryItem, call: string, write: () => Promise<unknown> | unknown): Promise<boolean> {
		try {
			await write();
			return true;
		} catch (err) {
			this.#options.log.error("delivery_ledger_failed", { id: delivery.deliveryId, call, error: errorText(err) });
			return false;
		}
	}
}
