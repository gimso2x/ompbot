// The per-method Retry-After blocking the adapters share: a 429 parks its Slack method (or Discord route) until
// Retry-After passes, so later callers fail fast instead of hammering the API; Teams parks its single post path the
// same way. The parking log line (`slack_rate_limited`, `discord_rate_limited`, `teams_rate_limited`) stays with the
// adapter, whose callback writes it.
import type { AdapterClock } from "./types";

export class RetryAfterGate {
	readonly #until = new Map<string, number>();
	/** The adapter clock the blocks are measured against (a deferred sender reads it for its retry time). */
	readonly clock: AdapterClock;
	readonly #park: (key: string, retryAfterMs: number) => void;

	constructor(options: { clock: AdapterClock; park: (key: string, retryAfterMs: number) => void }) {
		this.clock = options.clock;
		this.#park = options.park;
	}

	isBlocked(key: string): boolean {
		const until = this.#until.get(key);
		return until !== undefined && this.clock.now() < until;
	}

	/** When the current block on `key` ends; undefined when it was never blocked. */
	untilOf(key: string): number | undefined {
		return this.#until.get(key);
	}

	/** Parks `key` for `retryAfterMs`, reporting it to the adapter's rate-limited log. */
	park(key: string, retryAfterMs: number): void {
		this.#until.set(key, this.clock.now() + retryAfterMs);
		this.#park(key, retryAfterMs);
	}

	/**
	 * One platform call under the gate. A parked key fails fast with `blocked(remainingMs)`; an error `rateLimited`
	 * recognizes parks the key and rethrows. `blocked` is the platform's own (Slack's private `BlockedError`, Discord
	 * and Teams rethrow their rate-limited error), so the callers' catch blocks keep their meaning.
	 */
	async call<T>(
		key: string,
		fn: () => Promise<T>,
		blocked: (remainingMs: number) => Error,
		rateLimited: (err: unknown) => number | undefined,
	): Promise<T> {
		const until = this.#until.get(key);
		const now = this.clock.now();
		if (until !== undefined && now < until) throw blocked(until - now);
		try {
			return await fn();
		} catch (err) {
			const retryAfterMs = rateLimited(err);
			if (retryAfterMs !== undefined) this.park(key, retryAfterMs);
			throw err;
		}
	}
}
