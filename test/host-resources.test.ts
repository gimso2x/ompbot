import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { DISK_MIN_FREE_BYTES, diskHeadroom, diskLow, formatHeadroom, hostPressure } from "../src/ops/host-resources";

const GIB = 1024 ** 3;
const view = (freeGib: number, totalGib: number) => ({
	path: "/d",
	freeBytes: freeGib * GIB,
	totalBytes: totalGib * GIB,
});

describe("diskHeadroom / diskLow", () => {
	test("statfs blocks times block size; an unaskable path is null and never low", () => {
		const real = diskHeadroom(tmpdir());
		expect(real.freeBytes).toBeGreaterThan(0);
		expect(real.totalBytes).toBeGreaterThanOrEqual(real.freeBytes ?? 0);
		expect(diskHeadroom("/d", () => ({ bavail: 3n, blocks: 10n, bsize: 4096n }))).toEqual({
			path: "/d",
			freeBytes: 3 * 4096,
			totalBytes: 10 * 4096,
		});
		const missing = diskHeadroom("/no/such/path/for/ompbot");
		expect(missing).toEqual({ path: "/no/such/path/for/ompbot", freeBytes: null, totalBytes: null });
		expect(diskLow(missing)).toBe(false);
	});

	test("low under 5 GiB or under 10%: the boundaries themselves are not low", () => {
		expect(diskLow({ path: "/d", freeBytes: DISK_MIN_FREE_BYTES - 1, totalBytes: 1000 * GIB })).toBe(true);
		expect(diskLow(view(5, 50))).toBe(false);
		expect(diskLow(view(9.9, 100))).toBe(true);
		expect(diskLow(view(10, 100))).toBe(false);
		expect(formatHeadroom(view(9.96, 100))).toBe("free_gib=10.0 pct=9");
	});
});

describe("hostPressure", () => {
	test("reads the 15-minute load and MemAvailable / MemTotal; an unreadable meminfo only drops that condition", () => {
		const meminfo = "MemTotal:       2000 kB\nMemAvailable:     99 kB\n";
		expect(hostPressure({ loadavg: () => [9, 9, 1], cpuCount: () => 2, meminfo: () => meminfo })).toEqual({
			load15: 1,
			cpus: 2,
			memAvailableRatio: 99 / 2000,
			open: true,
		});
		expect(hostPressure({ loadavg: () => [9, 9, 3.99], cpuCount: () => 2, meminfo: () => undefined })).toEqual({
			load15: 3.99,
			cpus: 2,
			memAvailableRatio: null,
			open: false,
		});
		expect(hostPressure({ loadavg: () => [0, 0, 4], cpuCount: () => 2, meminfo: () => "MemTotal: 10 kB\n" }).open).toBe(
			true,
		);
		const here = hostPressure();
		expect(here.cpus).toBeGreaterThan(0);
		expect(here.memAvailableRatio).not.toBeNull();
	});
});
