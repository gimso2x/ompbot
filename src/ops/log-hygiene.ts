import type { LogClock, LogFields, Logger } from "../log";

/** How often the folded noise is written out as one `log_summary` line, and how often `service_alive` is written. */
export const LOG_HYGIENE_INTERVAL_MS = 60 * 60_000;

/** Repeats a callback until the returned function cancels it. Tests inject a manual one instead of real time. */
export type Schedule = (fn: () => void, ms: number) => () => void;

export const realSchedule: Schedule = (fn, ms) => {
	const timer = setInterval(fn, ms);
	timer.unref();
	return () => clearInterval(timer);
};

/** `inbound_dropped` reasons that are routine traffic (bots talking, messages not meant for the bot), not signals. */
const NOISY_DROP_REASONS: Record<string, true> = { bot_message: true, not_addressed: true };

/**
 * The counter key of a log call that is steady-state noise, `undefined` for everything else. Only `info` lines can
 * be folded: a warning or an error is always a line of its own.
 */
export function noiseKey(event: string, fields: LogFields | undefined): string | undefined {
	if (event !== "inbound_dropped") return undefined;
	const reason = fields?.reason;
	return typeof reason === "string" && NOISY_DROP_REASONS[reason] === true ? `${event}_${reason}` : undefined;
}

export interface AggregatingLogger extends Logger {
	/** Writes the pending counts as one `log_summary` line now (no line when nothing was folded). */
	flush(): void;
	/** Stops the hourly timer and flushes what is left, so a shutdown loses no count. */
	stop(): void;
}

export interface AggregatingOptions {
	clock: LogClock;
	intervalMs?: number;
	schedule?: Schedule;
}

/**
 * Wraps a logger: noisy `info` events (see `noiseKey`) are counted instead of written, and every interval one
 * `log_summary window_s=… total=… <key>=<count> …` line carries the counts. `debug`, `warn` and `error` pass through
 * untouched, as does every other `info` event.
 */
export function createAggregatingLogger(inner: Logger, options: AggregatingOptions): AggregatingLogger {
	const counts = new Map<string, number>();
	let windowStart = options.clock.now();

	const flush = (): void => {
		const now = options.clock.now();
		if (counts.size === 0) {
			windowStart = now;
			return;
		}
		const fields: LogFields = { window_s: Math.max(0, Math.round((now - windowStart) / 1000)) };
		let total = 0;
		for (const count of counts.values()) total += count;
		fields.total = total;
		for (const [key, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) fields[key] = count;
		counts.clear();
		windowStart = now;
		inner.info("log_summary", fields);
	};
	const cancel = (options.schedule ?? realSchedule)(flush, options.intervalMs ?? LOG_HYGIENE_INTERVAL_MS);

	return {
		debug: (event, fields) => inner.debug(event, fields),
		info: (event, fields) => {
			const key = noiseKey(event, fields);
			if (key === undefined) inner.info(event, fields);
			else counts.set(key, (counts.get(key) ?? 0) + 1);
		},
		warn: (event, fields) => inner.warn(event, fields),
		error: (event, fields) => inner.error(event, fields),
		flush,
		stop: () => {
			cancel();
			flush();
		},
	};
}

export interface ServiceAliveOptions {
	log: Logger;
	clock: LogClock;
	/** Cheap facts the daemon already has (origins, busy, pending/dispatched); `uptime_s` is added here. */
	snapshot: () => LogFields;
	intervalMs?: number;
	schedule?: Schedule;
}

/** Writes an `info` `service_alive uptime_s=… …` line every interval; returns the stop function (daemon shutdown). */
export function startServiceAlive(options: ServiceAliveOptions): () => void {
	const startedAt = options.clock.now();
	return (options.schedule ?? realSchedule)(() => {
		let fields: LogFields;
		try {
			fields = options.snapshot();
		} catch (error) {
			// The liveness line itself must keep coming even when a count cannot be read.
			fields = { snapshot_error: String(error) };
		}
		options.log.info("service_alive", {
			uptime_s: Math.max(0, Math.round((options.clock.now() - startedAt) / 1000)),
			...fields,
		});
	}, options.intervalMs ?? LOG_HYGIENE_INTERVAL_MS);
}
