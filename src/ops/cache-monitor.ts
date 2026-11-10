/**
 * Prompt cache miss classifier for omp calls (after jcode's `kv_cache_monitor.rs`): each assistant call's usage is
 * compared with the previous call's reusable prefix, and a large shortfall is named by its likeliest cause.
 * Pure functions plus one small per-origin state object; the mailbox feeds it and decides who hears about it.
 */

/** A call must have had, and missed, at least this many prefix tokens to count as a miss. */
export const MIN_MISS_TOKENS = 20_000;
/** A `child_restart`/`unexplained` miss this large is told to the owner (once per origin per day). */
export const CACHE_MISS_NOTIFY_TOKENS = 150_000;
/** How long one origin stays quiet after a cache miss notice. */
export const CACHE_MISS_NOTIFY_MS = 24 * 60 * 60_000;
/** A conversation this large resumed past its cache TTL gets a warning line at its new turn. */
export const COLD_CACHE_WARN_TOKENS = 200_000;
/** Anthropic prompt cache lifetime under omp's OAuth "long" cache control (measured: 15-60 min gaps stay warm). */
const ANTHROPIC_CACHE_TTL_MS = 60 * 60_000;

export type CacheMissReason = "model_switch" | "compaction" | "expired" | "child_restart" | "unexplained";

/** One assistant call as the classifier sees it. */
export interface CacheCall {
	at: number;
	provider: string;
	model: string;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	/** Dollar cost of the call's cache write (`usage.cost.cacheWrite`); 0 when unknown. */
	costCacheWrite: number;
}

/** Why a cache could have been dropped since the baseline call. */
export interface CacheFlags {
	/** A new omp child took over the session since the baseline call. */
	childRestarted: boolean;
	/** The session was compacted since the baseline call. */
	compacted: boolean;
}

/** The previous call's reusable prefix. */
export interface CacheBaseline {
	at: number;
	provider: string;
	model: string;
	/** `cacheRead + cacheWrite` of that call. */
	prefix: number;
}

export interface CacheMiss {
	reason: CacheMissReason;
	/** Baseline prefix the call did not read from the cache. */
	missedTokens: number;
	cacheWrite: number;
	costCacheWrite: number;
	gapMs: number;
	/** The baseline prefix. */
	prefixTokens: number;
}

/** Cache lifetime of a provider; `undefined` when unknown (no `expired` verdict, no cold warning). */
export function cacheTtlMs(provider: string): number | undefined {
	return provider === "anthropic" ? ANTHROPIC_CACHE_TTL_MS : undefined;
}

/** A miss when the baseline prefix and the part of it not read are both at least `MIN_MISS_TOKENS`. */
export function classifyCacheMiss(
	baseline: CacheBaseline | undefined,
	call: CacheCall,
	flags: CacheFlags,
): CacheMiss | undefined {
	if (baseline === undefined || baseline.prefix < MIN_MISS_TOKENS) return undefined;
	const missedTokens = baseline.prefix - call.cacheRead;
	if (missedTokens < MIN_MISS_TOKENS) return undefined;
	const gapMs = call.at - baseline.at;
	const ttl = cacheTtlMs(baseline.provider);
	const reason: CacheMissReason =
		call.provider !== baseline.provider || call.model !== baseline.model
			? "model_switch"
			: flags.compacted
				? "compaction"
				: ttl !== undefined && gapMs > ttl
					? "expired"
					: flags.childRestarted
						? "child_restart"
						: "unexplained";
	return {
		reason,
		missedTokens,
		cacheWrite: call.cacheWrite,
		costCacheWrite: call.costCacheWrite,
		gapMs,
		prefixTokens: baseline.prefix,
	};
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** The call an omp assistant message (`message_end` payload or session entry message) reports; else `undefined`. */
export function cacheCallOf(message: unknown, at: number): CacheCall | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const { role, usage, provider, model } = message as Record<string, unknown>;
	if (role !== "assistant" || typeof usage !== "object" || usage === null) return undefined;
	const counts = usage as Record<string, unknown>;
	const cost = typeof counts.cost === "object" && counts.cost !== null ? (counts.cost as Record<string, unknown>) : {};
	return {
		at,
		provider: typeof provider === "string" ? provider : "",
		model: typeof model === "string" ? model : "",
		input: num(counts.input),
		cacheRead: num(counts.cacheRead),
		cacheWrite: num(counts.cacheWrite),
		costCacheWrite: num(cost.cacheWrite),
	};
}

/** One origin's cache state: the baseline, the pending causes and the last known cache write price. */
export class CacheMonitor {
	#baseline: CacheBaseline | undefined;
	#flags: CacheFlags = { childRestarted: false, compacted: false };
	#writeCostPerToken: number | undefined;

	get baseline(): CacheBaseline | undefined {
		return this.#baseline;
	}

	/** Dollars per cache-write token from the latest call that reported both; `undefined` before one. */
	get writeCostPerToken(): number | undefined {
		return this.#writeCostPerToken;
	}

	/** A new child took the session over: the next call is judged with `childRestarted`. */
	markChildRestart(): void {
		this.#flags.childRestarted = true;
	}

	/** The session was compacted: the next call is judged with `compacted`. */
	markCompacted(): void {
		this.#flags.compacted = true;
	}

	/** Sets the baseline from a call read back from the session, only while none is known. */
	seed(call: CacheCall): void {
		if (this.#baseline !== undefined) return;
		this.#learnPrice(call);
		this.#setBaseline(call);
	}

	/** Classifies one call, clears the pending causes and moves the baseline (a zero-prefix call leaves it). */
	observe(call: CacheCall): CacheMiss | undefined {
		const miss = classifyCacheMiss(this.#baseline, call, this.#flags);
		this.#flags = { childRestarted: false, compacted: false };
		this.#learnPrice(call);
		this.#setBaseline(call);
		return miss;
	}

	#setBaseline(call: CacheCall): void {
		const prefix = call.cacheRead + call.cacheWrite;
		if (prefix > 0) this.#baseline = { at: call.at, provider: call.provider, model: call.model, prefix };
	}

	#learnPrice(call: CacheCall): void {
		if (call.cacheWrite > 0 && call.costCacheWrite > 0) this.#writeCostPerToken = call.costCacheWrite / call.cacheWrite;
	}
}

/** Whether a new turn on this baseline starts with a cold cache worth a warning. */
export function isColdCache(baseline: CacheBaseline | undefined, now: number): boolean {
	if (baseline === undefined || baseline.prefix < COLD_CACHE_WARN_TOKENS) return false;
	const ttl = cacheTtlMs(baseline.provider);
	return ttl !== undefined && now - baseline.at > ttl;
}

const kTokens = (tokens: number): string => `${Math.round(tokens / 1000)}k`;

/** Thread line for a large unexpected miss. */
export function formatCacheMissNotice(
	miss: Pick<CacheMiss, "reason" | "missedTokens" | "cacheWrite" | "costCacheWrite">,
): string {
	const tokens = miss.cacheWrite > 0 ? miss.cacheWrite : miss.missedTokens;
	const cost = miss.costCacheWrite > 0 ? `(≈$${miss.costCacheWrite.toFixed(2)})` : "";
	return `⚠️ 프롬프트 캐시 재작성 ${kTokens(tokens)} 토큰${cost} — 원인 ${miss.reason}`;
}

/** Thread line for a new turn on a cold cache; the cost part is left out when the price is unknown. */
export function formatColdCacheNotice(info: { prefixTokens: number; idleMs: number; estimatedCost?: number }): string {
	const hours = Math.floor(info.idleMs / 3_600_000);
	const cost = info.estimatedCost === undefined ? "" : `이번 턴에 약 $${info.estimatedCost.toFixed(2)} 재작성 — `;
	return `ℹ️ 캐시가 식은 대화입니다(컨텍스트 ${kTokens(info.prefixTokens)}, 마지막 호출 ${hours}시간 전). ${cost}새로 시작하려면 /new-ompbot`;
}
