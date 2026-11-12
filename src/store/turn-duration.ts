import { chatPlatformOf } from "../core/origin-key";
import type { Logger } from "../log";

/** How long a conversation turn usually takes (nearest-rank over past turns); the running status compares against it. */
export interface TypicalDuration {
	medianMs: number;
	p90Ms: number;
}

/** Fewer past turns than this give no typical duration. */
export const TYPICAL_MIN_SAMPLES = 10;

/** Median and p90 (nearest rank) of `samplesMs`; undefined under {@link TYPICAL_MIN_SAMPLES} samples. */
export function typicalDuration(samplesMs: readonly number[]): TypicalDuration | undefined {
	const n = samplesMs.length;
	if (n < TYPICAL_MIN_SAMPLES) return undefined;
	const s = [...samplesMs].sort((a, b) => a - b);
	return { medianMs: s[Math.ceil(0.5 * n) - 1] as number, p90Ms: s[Math.ceil(0.9 * n) - 1] as number };
}

/**
 * Typical duration of a turn of `originKey`: only chat origins get one. Its own recent turns when there are enough,
 * else those of every chat origin. A failing query is logged (`typical_duration_query_failed`) and gives undefined:
 * the turn goes on without it.
 */
export function typicalTurnDuration(
	store: { turnDurationSamples(originKey?: string): number[] },
	originKey: string,
	log: Logger,
): TypicalDuration | undefined {
	if (chatPlatformOf(originKey) === undefined) return undefined;
	try {
		const own = store.turnDurationSamples(originKey);
		return typicalDuration(own.length >= TYPICAL_MIN_SAMPLES ? own : store.turnDurationSamples());
	} catch (error) {
		log.warn("typical_duration_query_failed", { origin: originKey, error: String(error) });
		return undefined;
	}
}
