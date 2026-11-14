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

/** The median-to-p90 range rounded up to whole minutes (at least 1): `a~b분`, or `~a분` when both round alike. */
export function formatTypicalRange(typical: TypicalDuration): string {
	const low = Math.max(1, Math.ceil(typical.medianMs / 60_000));
	const high = Math.max(low, Math.ceil(typical.p90Ms / 60_000));
	return low === high ? `~${low}분` : `${low}~${high}분`;
}

/**
 * `보통 a~b분`, or `평소보다 길어짐(보통 a~b분)` once `elapsedMs` passes p90; undefined without a typical duration.
 * A median-to-p90 range, so a run already past the median does not read as late until it passes p90.
 */
export function typicalNote(elapsedMs: number, typical: TypicalDuration | undefined): string | undefined {
	if (typical === undefined) return undefined;
	const range = formatTypicalRange(typical);
	return elapsedMs > typical.p90Ms ? `평소보다 길어짐(보통 ${range})` : `보통 ${range}`;
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
