export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_CAP_MS = 5 * 60_000;
export const MAX_DEFINITIVE_FAILURES = 5;
export const FRESHNESS_MS = 24 * 60 * 60_000;

export type InboundState = "pending" | "dispatched" | "answered" | "failed_notified" | "discarded";
export type DeliveryState = "pending" | "inflight" | "confirmed" | "failed_ambiguous" | "expired";

export type StoreErrorCode = "invalid_transition" | "not_found" | "unknown_origin" | "invalid_argument";

export class StoreError extends Error {
	readonly code: StoreErrorCode;

	constructor(code: StoreErrorCode, detail: string) {
		super(`${code}: ${detail}`);
		this.name = "StoreError";
		this.code = code;
	}
}

/** Inbound transitions. answered / failed_notified / discarded are terminal. */
export const INBOUND_TRANSITIONS: Record<InboundState, readonly InboundState[]> = {
	pending: ["dispatched", "discarded"],
	dispatched: ["answered", "failed_notified", "discarded"],
	answered: [],
	failed_notified: [],
	discarded: [],
};

export function assertInboundTransition(from: InboundState, to: InboundState): void {
	if (!INBOUND_TRANSITIONS[from].includes(to)) throw new StoreError("invalid_transition", `inbound ${from} -> ${to}`);
}

/** Delay before the next try after the n-th (1-based) definitive failure: 2s, 4s, 8s ... capped at 5 min. */
export function backoffMs(failures: number): number {
	return Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_CAP_MS);
}

export interface DeliveryFacts {
	state: DeliveryState;
	attempts: number; // definitive failures so far
	nextAt: number;
	redelivered: boolean;
	createdAt: number;
}

export type DeliveryEvent =
	| "claim" // pending -> inflight
	| "confirmed" // inflight -> confirmed
	| "definitive_failure" // inflight -> pending (backoff) | expired
	| "ambiguous" // inflight -> failed_ambiguous
	| "expire_check" // pending past freshness -> expired
	| "recover"; // inflight left over from a dead process -> pending, redelivered

function requireState(f: DeliveryFacts, event: DeliveryEvent, expected: DeliveryState): void {
	if (f.state !== expected) throw new StoreError("invalid_transition", `delivery ${f.state} on ${event}`);
}

/**
 * Pure delivery state machine. `failed_ambiguous` is sticky: the send may have reached Slack, so neither failure
 * counts, backoff, nor the 24h freshness window move it; the row stays visible instead of being resent or dropped.
 */
export function transitionDelivery(f: DeliveryFacts, event: DeliveryEvent, now: number): DeliveryFacts {
	if (f.state === "failed_ambiguous") return f;
	const stale = now - f.createdAt >= FRESHNESS_MS;
	switch (event) {
		case "claim":
			requireState(f, event, "pending");
			return { ...f, state: "inflight" };
		case "confirmed":
			requireState(f, event, "inflight");
			return { ...f, state: "confirmed" };
		case "ambiguous":
			requireState(f, event, "inflight");
			return { ...f, state: "failed_ambiguous" };
		case "definitive_failure": {
			requireState(f, event, "inflight");
			const attempts = f.attempts + 1;
			if (attempts >= MAX_DEFINITIVE_FAILURES || stale) return { ...f, attempts, state: "expired" };
			return { ...f, attempts, state: "pending", nextAt: now + backoffMs(attempts) };
		}
		case "expire_check":
			return f.state === "pending" && stale ? { ...f, state: "expired" } : f;
		case "recover":
			return f.state === "inflight" ? { ...f, state: "pending", redelivered: true, nextAt: now } : f;
	}
}
