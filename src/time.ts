// Calendar and clock helpers in the bot's configured IANA time zone (`config.timezone`). Every function is pure and
// takes the zone as an argument: the zone is resolved once from config and passed down as a dependency, never kept
// in module state. Offsets come from Intl, so zones with daylight saving get the offset in force at that instant.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
	let formatter = formatters.get(tz);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
		});
		formatters.set(tz, formatter);
	}
	return formatter;
}

interface Wall {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

function wall(ms: number, tz: string): Wall {
	const out: Record<string, string> = {};
	for (const part of formatterFor(tz).formatToParts(ms)) out[part.type] = part.value;
	return {
		year: Number(out.year),
		month: Number(out.month),
		day: Number(out.day),
		hour: Number(out.hour),
		minute: Number(out.minute),
		second: Number(out.second),
	};
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** The zone's UTC offset at `ms`, in whole minutes (Seoul → 540, New York in winter → -300). */
function offsetMinutes(ms: number, tz: string): number {
	const w = wall(ms, tz);
	const shown = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
	return Math.round((shown - Math.floor(ms / 1000) * 1000) / 60_000);
}

/** True when `tz` is an IANA zone this runtime knows (`Mars/Base` → false). */
export function isTimezone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat(undefined, { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

/** The host's zone (`TZ` / system setting), `UTC` when the runtime reports none. */
export function hostTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** `+05:30` / `-05:00`: the zone's offset at `ms`. */
export function offsetLabel(ms: number, tz: string): string {
	const minutes = offsetMinutes(ms, tz);
	const abs = Math.abs(minutes);
	return `${minutes < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** `2026-10-26T02:04:05-04:00`: second-precision ISO of `ms` with the zone's offset. */
export function localIso(ms: number, tz: string): string {
	const w = wall(ms, tz);
	return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}${offsetLabel(ms, tz)}`;
}

/** `YYYYMMDD` of the calendar day `ms` falls on in the zone. */
export function localDay(ms: number, tz: string): string {
	const w = wall(ms, tz);
	return `${pad(w.year, 4)}${pad(w.month)}${pad(w.day)}`;
}

/** `YYYY-MM-DD HH:MM:SS` wall clock of `ms` in the zone (seconds shown as `00`, minute precision). */
export function formatLocal(ms: number, tz: string): string {
	const w = wall(ms, tz);
	return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)}:00`;
}

/** The first instant of the zone's calendar day after the one `ms` falls on. */
export function nextLocalMidnight(ms: number, tz: string): number {
	const w = wall(ms, tz);
	const target = Date.UTC(w.year, w.month - 1, w.day + 1);
	// Midnight's offset can differ from the one at `ms` (a DST change in between); two rounds settle it.
	let guess = target - offsetMinutes(target, tz) * 60_000;
	guess = target - offsetMinutes(guess, tz) * 60_000;
	// A zone whose clocks skip midnight starts the day later; the first instant whose day changed is still a boundary.
	return guess <= ms ? target - offsetMinutes(ms, tz) * 60_000 : guess;
}
