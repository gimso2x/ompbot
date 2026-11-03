import { describe, expect, test } from "bun:test";
import {
	assertTimezone,
	CronError,
	DEFAULT_TIMEZONE,
	firesBetween,
	formatLocal,
	nextFire,
	parseCron,
	zonedToUtc,
} from "../src/monitors/cron";

const utc = (iso: string): number => Date.parse(iso);
const iso = (ms: number | undefined): string | undefined => (ms === undefined ? undefined : new Date(ms).toISOString());

describe("cron: Asia/Seoul (no DST)", () => {
	test("default zone is Asia/Seoul", () => {
		expect(DEFAULT_TIMEZONE).toBe("Asia/Seoul");
	});

	test("daily 09:30 KST is 00:30Z, then exactly 24h later", () => {
		const cron = parseCron("30 9 * * *");
		const first = nextFire(cron, "Asia/Seoul", utc("2026-03-10T00:00:00Z"));
		expect(iso(first)).toBe("2026-03-10T00:30:00.000Z");
		expect(iso(nextFire(cron, "Asia/Seoul", first as number))).toBe("2026-03-11T00:30:00.000Z");
	});

	test("strictly after the given instant, also mid-minute", () => {
		const cron = parseCron("* * * * *");
		expect(iso(nextFire(cron, "Asia/Seoul", utc("2026-03-10T00:00:00Z")))).toBe("2026-03-10T00:01:00.000Z");
		expect(iso(nextFire(cron, "Asia/Seoul", utc("2026-03-10T00:00:30Z")))).toBe("2026-03-10T00:01:00.000Z");
	});

	test("the same wall-clock time across the US DST change days stays 24h apart", () => {
		const cron = parseCron("0 0 * * *");
		const fires = firesBetween(cron, "Asia/Seoul", utc("2026-03-07T00:00:00Z"), utc("2026-03-11T00:00:00Z"), 10);
		const gaps = fires.slice(1).map((at, i) => at - (fires[i] as number));
		expect(gaps.length).toBeGreaterThan(0);
		for (const gap of gaps) expect(gap).toBe(24 * 3_600_000);
	});

	test("formatLocal and zonedToUtc round-trip a Seoul wall clock", () => {
		const at = zonedToUtc({ year: 2026, month: 5, day: 4, hour: 9, minute: 15, second: 0, ms: 0 }, "Asia/Seoul");
		expect(iso(at)).toBe("2026-05-04T00:15:00.000Z");
		expect(formatLocal(at, "Asia/Seoul")).toBe("2026-05-04 09:15:00");
	});
});

describe("cron: America/New_York DST", () => {
	test("spring forward: a 02:30 wall time that does not exist on 2026-03-08 is skipped", () => {
		const cron = parseCron("30 2 * * *");
		const fires = firesBetween(
			cron,
			"America/New_York",
			utc("2026-03-06T12:00:00Z"),
			utc("2026-03-10T12:00:00Z"),
			10,
		).map(iso);
		expect(fires).toEqual([
			"2026-03-07T07:30:00.000Z", // 02:30 EST
			// 2026-03-08 02:30 never happens
			"2026-03-09T06:30:00.000Z", // 02:30 EDT
			"2026-03-10T06:30:00.000Z",
		]);
	});

	test("spring forward: 03:30 fires once on the change day", () => {
		const cron = parseCron("30 3 * * *");
		const fires = firesBetween(
			cron,
			"America/New_York",
			utc("2026-03-07T12:00:00Z"),
			utc("2026-03-08T12:00:00Z"),
			10,
		).map(iso);
		expect(fires).toEqual(["2026-03-08T07:30:00.000Z"]); // 03:30 EDT
	});

	test("fall back: 01:30 happens twice on 2026-11-01 and fires at both distinct instants", () => {
		const cron = parseCron("30 1 * * *");
		const fires = firesBetween(
			cron,
			"America/New_York",
			utc("2026-10-31T12:00:00Z"),
			utc("2026-11-02T12:00:00Z"),
			10,
		).map(iso);
		expect(fires).toEqual([
			"2026-11-01T05:30:00.000Z", // 01:30 EDT
			"2026-11-01T06:30:00.000Z", // 01:30 EST
			"2026-11-02T06:30:00.000Z",
		]);
	});

	test("an `at` wall time inside the spring-forward gap resolves to just after the gap", () => {
		const at = zonedToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0, ms: 0 }, "America/New_York");
		expect(formatLocal(at, "America/New_York")).toMatch(/^2026-03-08 03:/);
	});
});

describe("cron: day-of-month / day-of-week", () => {
	const days = (schedule: string): number[] =>
		firesBetween(parseCron(schedule), "UTC", utc("2026-10-01T00:00:00Z"), utc("2026-10-31T23:59:00Z"), 100).map((at) =>
			new Date(at).getUTCDate(),
		);

	test("both restricted: either one matches (OR)", () => {
		// 2026-10-15 is a Thursday; Mondays are 5, 12, 19, 26.
		expect(days("0 0 15 * 1")).toEqual([5, 12, 15, 19, 26]);
	});

	test("only day-of-month restricted", () => {
		expect(days("0 0 15 * *")).toEqual([15]);
	});

	test("only day-of-week restricted", () => {
		expect(days("0 0 * * 1")).toEqual([5, 12, 19, 26]);
	});

	test("7 means Sunday, names work", () => {
		expect(days("0 0 * * 7")).toEqual(days("0 0 * * sun"));
		expect(days("0 0 * * 7")).toEqual([4, 11, 18, 25]);
	});

	test("lists, ranges and steps", () => {
		const cron = parseCron("0,30 8-9 * * *");
		const fires = firesBetween(cron, "UTC", utc("2026-10-01T00:00:00Z"), utc("2026-10-01T23:59:00Z"), 10).map(iso);
		expect(fires).toEqual([
			"2026-10-01T08:00:00.000Z",
			"2026-10-01T08:30:00.000Z",
			"2026-10-01T09:00:00.000Z",
			"2026-10-01T09:30:00.000Z",
		]);
		const stepped = firesBetween(
			parseCron("*/20 * * * *"),
			"UTC",
			utc("2026-10-01T00:00:00Z"),
			utc("2026-10-01T01:00:00Z"),
			10,
		);
		expect(stepped).toHaveLength(3);
	});

	test("a schedule that never matches gives up", () => {
		expect(nextFire(parseCron("0 0 31 2 *"), "UTC", utc("2026-01-01T00:00:00Z"))).toBeUndefined();
	});

	test("the cap bounds firesBetween", () => {
		const fires = firesBetween(
			parseCron("* * * * *"),
			"UTC",
			utc("2026-10-01T00:00:00Z"),
			utc("2026-10-02T00:00:00Z"),
			5,
		);
		expect(fires).toHaveLength(5);
	});
});

describe("cron: parse errors", () => {
	test.each([
		["wrong field count", "* * * *"],
		["too many fields", "* * * * * *"],
		["minute out of range", "60 * * * *"],
		["hour out of range", "0 24 * * *"],
		["day of month zero", "0 0 0 * *"],
		["month 13", "0 0 1 13 *"],
		["day of week 8", "0 0 * * 8"],
		["zero step", "*/0 * * * *"],
		["backwards range", "5-1 * * * *"],
		["garbage token", "a * * * *"],
		["empty list item", "1,,2 * * * *"],
		["double step", "*/2/3 * * * *"],
		["empty string", ""],
	])("%s is rejected", (_label, source) => {
		expect(() => parseCron(source)).toThrow(CronError);
	});

	test("unknown time zone is rejected", () => {
		expect(() => assertTimezone("Mars/Olympus")).toThrow(CronError);
		expect(() => assertTimezone("Asia/Seoul")).not.toThrow();
	});
});
