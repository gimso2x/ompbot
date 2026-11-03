// Five-field cron (`minute hour day-of-month month day-of-week`) evaluated in an IANA time zone. The matcher walks
// absolute UTC minutes and compares them with the zone's wall-clock fields (Intl), so a nonexistent spring-forward
// minute never fires and a repeated fall-back minute fires once per distinct UTC instant.

export const DEFAULT_TIMEZONE = "Asia/Seoul";

const MINUTE_MS = 60_000;
/** A schedule that never matches (e.g. `0 0 31 2 *`) stops searching after this long. */
const SEARCH_LIMIT_MS = 5 * 366 * 24 * 60 * MINUTE_MS;

export class CronError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CronError";
	}
}

export interface CronSchedule {
	readonly source: string;
	readonly minutes: ReadonlySet<number>;
	readonly hours: ReadonlySet<number>;
	readonly daysOfMonth: ReadonlySet<number>;
	readonly months: ReadonlySet<number>;
	/** 0 = Sunday .. 6 = Saturday (a written 7 is folded onto 0). */
	readonly daysOfWeek: ReadonlySet<number>;
	/** The field was `*` (or a step of 1 over `*`): standard cron ORs day-of-month and day-of-week only when both are restricted. */
	readonly domWild: boolean;
	readonly dowWild: boolean;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface FieldSpec {
	label: string;
	min: number;
	max: number;
	names?: readonly string[];
	/** Value of the first name (month names start at 1). */
	nameBase?: number;
}

function parseValue(token: string, field: FieldSpec): number {
	const lower = token.toLowerCase();
	const named = field.names?.indexOf(lower) ?? -1;
	if (named !== -1) return named + (field.nameBase ?? 0);
	if (!/^\d+$/.test(token)) throw new CronError(`${field.label}: invalid value "${token}"`);
	return Number(token);
}

function parseField(text: string, field: FieldSpec): { values: Set<number>; wild: boolean } {
	const values = new Set<number>();
	let wild = false;
	for (const item of text.split(",")) {
		if (item === "") throw new CronError(`${field.label}: empty list item`);
		const [range = "", stepText, extra] = item.split("/");
		if (extra !== undefined) throw new CronError(`${field.label}: invalid step in "${item}"`);
		let step = 1;
		if (stepText !== undefined) {
			if (!/^\d+$/.test(stepText) || Number(stepText) < 1)
				throw new CronError(`${field.label}: invalid step "${stepText}"`);
			step = Number(stepText);
		}
		let from: number;
		let to: number;
		if (range === "*") {
			from = field.min;
			to = field.max;
			if (stepText === undefined || step === 1) wild = true;
		} else if (range.includes("-")) {
			const [a = "", b = "", more] = range.split("-");
			if (more !== undefined) throw new CronError(`${field.label}: invalid range "${range}"`);
			from = parseValue(a, field);
			to = parseValue(b, field);
			if (from > to) throw new CronError(`${field.label}: range "${range}" runs backwards`);
		} else {
			from = parseValue(range, field);
			// `5/10` means "from 5, every 10" up to the field maximum.
			to = stepText === undefined ? from : field.max;
		}
		// Day-of-week accepts 7 as Sunday; the range check below uses 7 as the ceiling for it.
		if (from < field.min || to > field.max) {
			throw new CronError(`${field.label}: "${item}" is outside ${field.min}-${field.max}`);
		}
		for (let v = from; v <= to; v += step) values.add(v);
	}
	return { values, wild };
}

export function parseCron(source: string): CronSchedule {
	const fields = source.trim().split(/\s+/);
	if (fields.length !== 5)
		throw new CronError(`cron needs 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`);
	const [min, hour, dom, month, dow] = fields as [string, string, string, string, string];
	const minutes = parseField(min, { label: "minute", min: 0, max: 59 });
	const hours = parseField(hour, { label: "hour", min: 0, max: 23 });
	const days = parseField(dom, { label: "day-of-month", min: 1, max: 31 });
	const months = parseField(month, { label: "month", min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 });
	const weekdays = parseField(dow, { label: "day-of-week", min: 0, max: 7, names: DOW_NAMES });
	if (weekdays.values.has(7)) {
		weekdays.values.delete(7);
		weekdays.values.add(0);
	}
	return {
		source: fields.join(" "),
		minutes: minutes.values,
		hours: hours.values,
		daysOfMonth: days.values,
		months: months.values,
		daysOfWeek: weekdays.values,
		domWild: days.wild,
		dowWild: weekdays.wild,
	};
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Throws `CronError` for a name Intl does not know. */
export function assertTimezone(timezone: string): void {
	formatterFor(timezone);
}

function formatterFor(timezone: string): Intl.DateTimeFormat {
	let formatter = formatters.get(timezone);
	if (!formatter) {
		try {
			formatter = new Intl.DateTimeFormat("en-US", {
				timeZone: timezone,
				hourCycle: "h23",
				year: "numeric",
				month: "numeric",
				day: "numeric",
				hour: "numeric",
				minute: "numeric",
				weekday: "short",
			});
		} catch {
			throw new CronError(`unknown time zone "${timezone}"`);
		}
		formatters.set(timezone, formatter);
	}
	return formatter;
}

export interface WallClock {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	/** 0 = Sunday. */
	weekday: number;
}

export function wallClock(ms: number, timezone: string): WallClock {
	const out: Record<string, string> = {};
	for (const part of formatterFor(timezone).formatToParts(ms)) out[part.type] = part.value;
	return {
		year: Number(out.year),
		month: Number(out.month),
		day: Number(out.day),
		hour: Number(out.hour),
		minute: Number(out.minute),
		weekday: Math.max(0, DOW_NAMES.indexOf((out.weekday ?? "").toLowerCase())),
	};
}

function dayMatches(cron: CronSchedule, w: WallClock): boolean {
	const dom = cron.daysOfMonth.has(w.day);
	const dow = cron.daysOfWeek.has(w.weekday);
	if (cron.domWild || cron.dowWild) return dom && dow;
	return dom || dow;
}

/**
 * First matching minute strictly after `afterMs` (a UTC epoch in ms), or `undefined` when none exists within five
 * years. Returned values are always whole UTC minutes.
 */
export function nextFire(cron: CronSchedule, timezone: string, afterMs: number): number | undefined {
	let t = (Math.floor(afterMs / MINUTE_MS) + 1) * MINUTE_MS;
	const limit = t + SEARCH_LIMIT_MS;
	while (t < limit) {
		const w = wallClock(t, timezone);
		if (!cron.months.has(w.month) || !dayMatches(cron, w)) {
			// Jump to the next local midnight; DST days that land an hour off are corrected by the next round.
			t += ((23 - w.hour) * 60 + (60 - w.minute)) * MINUTE_MS;
		} else if (!cron.hours.has(w.hour)) {
			t += (60 - w.minute) * MINUTE_MS;
		} else if (!cron.minutes.has(w.minute)) {
			t += MINUTE_MS;
		} else {
			return t;
		}
	}
	return undefined;
}

/** Every match in `(fromMs, toMs]`, oldest first, at most `cap` of them. */
export function firesBetween(
	cron: CronSchedule,
	timezone: string,
	fromMs: number,
	toMs: number,
	cap: number,
): number[] {
	const out: number[] = [];
	let at = fromMs;
	while (out.length < cap) {
		const next = nextFire(cron, timezone, at);
		if (next === undefined || next > toMs) break;
		out.push(next);
		at = next;
	}
	return out;
}

/** `YYYY-MM-DD HH:MM:SS` wall clock of an instant in a zone (for list output). */
export function formatLocal(ms: number, timezone: string): string {
	const w = wallClock(ms, timezone);
	const p = (n: number, width = 2) => String(n).padStart(width, "0");
	return `${p(w.year, 4)}-${p(w.month)}-${p(w.day)} ${p(w.hour)}:${p(w.minute)}:00`;
}

/**
 * UTC instant of a local wall-clock time in `timezone` (used for `at` values written without an offset). A local
 * time that does not exist (spring-forward gap) resolves to the instant just after the gap; an ambiguous one takes
 * the earlier instant.
 */
export function zonedToUtc(
	local: { year: number; month: number; day: number; hour: number; minute: number; second: number; ms: number },
	timezone: string,
): number {
	const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second, local.ms);
	// Offsets are whole minutes; two refinement rounds settle every real zone including DST edges.
	let guess = asUtc;
	for (let round = 0; round < 3; round += 1) {
		const w = wallClock(guess, timezone);
		const shown = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, 0, 0);
		const wanted = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0, 0);
		const delta = wanted - shown;
		if (delta === 0) break;
		guess += delta;
	}
	return guess;
}
