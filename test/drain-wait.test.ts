import { describe, expect, test } from "bun:test";
import { waitForDrain } from "../src/cli/drain";

const BUSY = { ok: true as const, draining: true, turns: 1, hostTools: 0, approvals: 0 };

describe("waitForDrain", () => {
	test("a status read that throws after the drain was accepted cancels the drain", async () => {
		const ops: string[] = [];
		const result = await waitForDrain({
			call: async (op) => {
				ops.push(op);
				if (op === "drain_status") throw new Error("ipc timeout after 10000ms");
				return op === "drain_cancel" ? { ...BUSY, draining: false } : BUSY;
			},
			timeoutMin: 60,
			now: () => 0,
			sleep: async () => undefined,
		});
		expect(ops).toEqual(["drain", "drain_status", "drain_cancel"]);
		expect(result).toEqual({
			ok: false,
			reason: "unreachable",
			error: "ipc timeout after 10000ms; drain cancelled",
		});
	});

	test("a failing cancel is reported with the original error", async () => {
		const result = await waitForDrain({
			call: async (op) => {
				if (op === "drain") return BUSY;
				throw new Error(op === "drain_status" ? "socket gone" : "still gone");
			},
			timeoutMin: 60,
			now: () => 0,
			sleep: async () => undefined,
		});
		expect(result).toEqual({
			ok: false,
			reason: "unreachable",
			error: "socket gone; drain cancel failed: still gone",
		});
	});

	test("a drain request that itself fails sends no cancel", async () => {
		const ops: string[] = [];
		const result = await waitForDrain({
			call: async (op) => {
				ops.push(op);
				throw new Error("ENOENT");
			},
			timeoutMin: 60,
		});
		expect(ops).toEqual(["drain"]);
		expect(result).toEqual({ ok: false, reason: "unreachable", error: "ENOENT" });
	});
});
