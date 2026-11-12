import { describe, expect, test } from "bun:test";
import { formatLocal, localDay, localIso, nextLocalMidnight, offsetLabel } from "../src/time";

const at = (iso: string): number => Date.parse(iso);

describe("localDay", () => {
	test("Asia/Seoul gives the old fixed +9h day key across midnight", () => {
		expect(localDay(at("2026-11-11T15:00:00Z"), "Asia/Seoul")).toBe("20261112");
		expect(localDay(at("2026-11-11T14:59:59Z"), "Asia/Seoul")).toBe("20261111");
	});

	test("America/New_York changes at New York midnight, also on the DST-end day 2026-11-01", () => {
		// EDT (-04:00) midnight that starts Nov 1.
		expect(localDay(at("2026-11-01T03:59:59Z"), "America/New_York")).toBe("20261031");
		expect(localDay(at("2026-11-01T04:00:00Z"), "America/New_York")).toBe("20261101");
		// Clocks fall back at 06:00Z; the next midnight is EST (-05:00) = 05:00Z on Nov 2.
		expect(localDay(at("2026-11-02T04:59:59Z"), "America/New_York")).toBe("20261101");
		expect(localDay(at("2026-11-02T05:00:00Z"), "America/New_York")).toBe("20261102");
	});
});

describe("nextLocalMidnight", () => {
	test("is the instant the day key changes, across the DST change", () => {
		expect(nextLocalMidnight(at("2026-10-31T12:00:00Z"), "America/New_York")).toBe(at("2026-11-01T04:00:00Z"));
		expect(nextLocalMidnight(at("2026-11-01T12:00:00Z"), "America/New_York")).toBe(at("2026-11-02T05:00:00Z"));
		expect(nextLocalMidnight(at("2026-11-11T14:59:59Z"), "Asia/Seoul")).toBe(at("2026-11-11T15:00:00Z"));
		expect(nextLocalMidnight(at("2026-11-11T15:00:00Z"), "Asia/Seoul")).toBe(at("2026-11-12T15:00:00Z"));
	});
});

describe("localIso / offsetLabel / formatLocal", () => {
	test("carry the zone's offset in force at the instant", () => {
		expect(localIso(at("2026-10-26T06:04:05.900Z"), "Asia/Seoul")).toBe("2026-10-26T15:04:05+09:00");
		expect(localIso(at("2026-11-12T00:00:00Z"), "America/New_York")).toBe("2026-11-11T19:00:00-05:00");
		expect(localIso(at("2026-07-01T12:00:00Z"), "America/New_York")).toBe("2026-07-01T08:00:00-04:00");
		expect(offsetLabel(at("2026-11-12T00:00:00Z"), "America/New_York")).toBe("-05:00");
		expect(offsetLabel(at("2026-11-12T00:00:00Z"), "Asia/Kolkata")).toBe("+05:30");
		expect(offsetLabel(at("2026-11-12T00:00:00Z"), "UTC")).toBe("+00:00");
		expect(formatLocal(at("2026-11-12T00:00:00Z"), "Asia/Seoul")).toBe("2026-11-12 09:00:00");
	});
});
