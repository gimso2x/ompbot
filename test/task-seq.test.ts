import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { acceptanceItems } from "../src/tasks/docs";
import { TaskLedger } from "../src/tasks/ledger";

const base = {
	title: "번호",
	risk: "L2" as const,
	originKey: "slack/ch/C1",
	threadRef: "C1:100.1",
	host: null,
	repo: "/r/repo",
	acceptance: acceptanceItems(["하나"]),
};

describe("TaskLedger day sequence past 99", () => {
	test("101 tasks on one KST day all register, numbered -99, -100, -101; the next day starts at -01", () => {
		const now = { ms: Date.parse("2026-11-04T01:00:00Z") };
		const ledger = new TaskLedger(new Database(":memory:", { strict: true }), { clock: { now: () => now.ms } });
		const ids = Array.from({ length: 101 }, () => ledger.register(base).taskId);
		expect(ids.slice(-3)).toEqual(["T-20261104-99", "T-20261104-100", "T-20261104-101"]);
		now.ms = Date.parse("2026-11-04T15:00:00Z"); // 00:00 KST of the next day
		expect(ledger.register(base).taskId).toBe("T-20261105-01");
	});

	test("list and listActive order by day, then the numeric tail", () => {
		const now = { ms: Date.parse("2026-11-04T01:00:00Z") };
		const ledger = new TaskLedger(new Database(":memory:", { strict: true }), { clock: { now: () => now.ms } });
		for (let i = 0; i < 101; i++) ledger.register(base);
		now.ms = Date.parse("2026-11-04T15:00:00Z");
		ledger.register(base);
		const expected = [...Array.from({ length: 101 }, (_, i) => i + 1), 1];
		for (const rows of [ledger.list(), ledger.listActive()]) {
			expect(rows.map((row) => Number(row.taskId.split("-")[2]))).toEqual(expected);
		}
		expect(ledger.list().at(-1)?.taskId).toBe("T-20261105-01");
	});
});
