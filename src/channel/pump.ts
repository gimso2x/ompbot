// The delivery loop every adapter shares: claim → send → confirm/fail/defer → finish the thread's status once sent.
// The platform part (how one delivery is posted, whether its post path is rate limited) is the `DeliverySender`.
import type { Logger } from "../log";
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
}

export interface DeliveryPumpOptions {
	source: DeliverySource;
	sender: DeliverySender;
	clock: AdapterClock;
	log: Logger;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
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
				const error = errorText(err);
				log.warn("delivery_failed", {
					id: delivery.deliveryId,
					sent_parts: delivery.sentParts ?? 0,
					outcome: "ambiguous",
					error,
				});
				await this.#ledger(delivery, "fail", () => source.fail(delivery.deliveryId, error, "ambiguous"));
				continue;
			}
			if (result.kind === "deferred") {
				await this.#defer(delivery, errorText(result.error), result.retry);
				continue;
			}
			if (result.kind === "failed") {
				log.warn("delivery_failed", {
					id: delivery.deliveryId,
					sent_parts: result.sentParts,
					outcome: result.outcome,
					error: result.error,
				});
				await this.#ledger(delivery, "fail", () => source.fail(delivery.deliveryId, result.error, result.outcome));
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
	async #ledger(delivery: DeliveryItem, call: string, write: () => Promise<void> | void): Promise<boolean> {
		try {
			await write();
			return true;
		} catch (err) {
			this.#options.log.error("delivery_ledger_failed", { id: delivery.deliveryId, call, error: errorText(err) });
			return false;
		}
	}
}
