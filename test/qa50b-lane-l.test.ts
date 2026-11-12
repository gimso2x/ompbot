import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStatusFromDb, renderStatusText } from "../src/daemon/status";
import { checkOmpRuntime } from "../src/omp/runtime-check";
import { listsBefore } from "../src/omp/session-heal";
import { IDLE_HOST_LOAD } from "../src/ops/host-resources";

const root = mkdtempSync(join(tmpdir(), "ompbot-qa50b-lane-l-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("qa50b-low lane L", () => {
	test("L-6 an ompExecutable that is a directory is a runtime problem, not an exception", () => {
		const dir = join(root, "omp-dir");
		mkdirSync(dir);
		expect(checkOmpRuntime(dir, process.execPath)).toMatchObject({
			code: "omp_launcher_unreadable",
			detail: expect.stringContaining("EISDIR"),
		});
	});

	test("L-7 a full tie lists the later path first, as omp's own listing does", () => {
		const at = { mtimeMs: 1000, createdMs: 900 };
		const a = { ...at, name: "2026-11-12_a.jsonl" };
		const b = { ...at, name: "2026-11-12_b.jsonl" };
		expect(listsBefore(b, a)).toBe(true);
		expect(listsBefore(a, b)).toBe(false);
		// mtime, then creation time, still decide first.
		expect(listsBefore({ ...a, mtimeMs: 1001 }, b)).toBe(true);
		expect(listsBefore({ ...a, createdMs: 901 }, b)).toBe(true);
	});

	test("L-이관2 a 0-byte or non-database ompbot.db gives a status report with ledger_unreadable, not an SQLiteError", () => {
		for (const [name, bytes] of [
			["empty", ""],
			["garbage", "this is not a sqlite database at all, just text padding the header out. ".repeat(4)],
		] as const) {
			const home = join(root, `status-${name}`);
			mkdirSync(home);
			const dbPath = join(home, "ompbot.db");
			writeFileSync(dbPath, bytes);
			const report = readStatusFromDb(dbPath, "omp-test 0", "Asia/Seoul", false, undefined, IDLE_HOST_LOAD);
			expect(report.daemonRunning).toBe(false);
			expect(report.origins).toEqual([]);
			expect(report.openGates.map((gate) => gate.name)).toContain("ledger_unreadable");
			expect(JSON.parse(JSON.stringify(report))).toMatchObject({ openGates: expect.any(Array) });
			expect(renderStatusText(report)).toContain("ledger_unreadable");
		}
	});
});
