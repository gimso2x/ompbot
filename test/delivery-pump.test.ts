import { describe, expect, test } from "bun:test";
import { DeliveryPump, type DeliverySender, type DeliverySendResult } from "../src/channel/pump";
import type { DeliveryItem, DeliveryRetry, DeliverySource } from "../src/channel/types";
import { createLogger } from "../src/log";
import { redact } from "../src/redact";

const NOW = 1_800_000_000_000;
const clock = { now: () => NOW };

function item(deliveryId: number, extra: Partial<DeliveryItem> = {}): DeliveryItem {
	return {
		deliveryId,
		originKey: "slack/dm/D1",
		threadRef: "D1:1.1",
		body: `답 ${deliveryId}`,
		redelivered: false,
		...extra,
	};
}

/** One shared call log across the fake source and sender, so the order of their calls is visible. */
function harness(items: DeliveryItem[], results: Map<number, DeliverySendResult>) {
	const calls: string[] = [];
	const lines: string[] = [];
	let blocked = false;
	const source: DeliverySource = {
		claimDue: () => {
			calls.push("claimDue");
			return items;
		},
		confirm: (id) => void calls.push(`confirm:${id}`),
		fail: (id, error, outcome) => void calls.push(`fail:${id}:${error}:${outcome}`),
		defer: (id, error, retry: DeliveryRetry) => void calls.push(`defer:${id}:${error}:${JSON.stringify(retry)}`),
	};
	const sender: DeliverySender = {
		isBlocked: () => blocked,
		blockedUntil: () => NOW + 30_000,
		blockedReason: () => "chat.postMessage",
		send: async (d) => {
			calls.push(`send:${d.deliveryId}`);
			const result = results.get(d.deliveryId) ?? { kind: "sent", parts: 1 };
			if (result.kind === "deferred") blocked = true;
			return result;
		},
		afterSent: async (d) => void calls.push(`afterSent:${d.deliveryId}`),
	};
	const pump = new DeliveryPump({
		source,
		sender,
		clock,
		log: createLogger({ sink: (line) => lines.push(line), clock, redact }),
	});
	return {
		pump,
		calls,
		lines,
		block: () => {
			blocked = true;
		},
	};
}

describe("DeliveryPump", () => {
	test("a sent delivery is confirmed, then finished by the sender; the count is the confirmed ones", async () => {
		const { pump, calls, lines } = harness([item(1)], new Map([[1, { kind: "sent", parts: 2, path: "markdown" }]]));
		expect(await pump.pump()).toBe(1);
		expect(calls).toEqual(["claimDue", "send:1", "confirm:1", "afterSent:1"]);
		expect(lines.filter((line) => line.includes("event=delivery_sent"))).toHaveLength(1);
		expect(lines.find((line) => line.includes("event=delivery_sent"))).toContain("parts=2");
	});

	test("deferred: only defer(id, error, retry) — no confirm, no fail, no afterSent", async () => {
		const retry = { at: NOW + 5_000, sentParts: 1, replyTs: "9.9" };
		const { pump, calls, lines } = harness(
			[item(2)],
			new Map([[2, { kind: "deferred", error: new Error("ratelimited"), retry }]]),
		);
		expect(await pump.pump()).toBe(0);
		expect(calls).toEqual(["claimDue", "send:2", `defer:2:ratelimited:${JSON.stringify(retry)}`]);
		expect(lines.filter((line) => line.includes("event=delivery_deferred"))).toHaveLength(1);
	});

	test("failed definitive and failed ambiguous: only fail(id, error, outcome)", async () => {
		const { pump, calls, lines } = harness(
			[item(3), item(4)],
			new Map<number, DeliverySendResult>([
				[3, { kind: "failed", error: "channel_not_found", outcome: "definitive", sentParts: 0 }],
				[4, { kind: "failed", error: "socket hang up", outcome: "ambiguous", sentParts: 1 }],
			]),
		);
		expect(await pump.pump()).toBe(0);
		expect(calls).toEqual([
			"claimDue",
			"send:3",
			"fail:3:channel_not_found:definitive",
			"send:4",
			"fail:4:socket hang up:ambiguous",
		]);
		expect(lines.filter((line) => line.includes("event=delivery_failed"))).toHaveLength(2);
	});

	test("blocked before the claim: nothing is claimed, nothing is sent", async () => {
		const { pump, calls, block } = harness([item(5), item(6)], new Map());
		block();
		expect(await pump.pump()).toBe(0);
		expect(calls).toEqual([]);
	});

	test("isBlocked true for claimed deliveries: none is sent, all are deferred to blockedUntil", async () => {
		const calls: string[] = [];
		let blocked = false;
		const items = [item(7, { sentParts: 2 }), item(8)];
		const pump = new DeliveryPump({
			source: {
				claimDue: () => {
					calls.push("claimDue");
					blocked = true;
					return items;
				},
				confirm: (id) => void calls.push(`confirm:${id}`),
				fail: (id) => void calls.push(`fail:${id}`),
				defer: (id, error, retry) => void calls.push(`defer:${id}:${error}:${JSON.stringify(retry)}`),
			},
			sender: {
				isBlocked: () => blocked,
				blockedUntil: () => NOW + 30_000,
				blockedReason: () => "chat.postMessage",
				send: async (d) => {
					calls.push(`send:${d.deliveryId}`);
					return { kind: "sent", parts: 1 };
				},
				afterSent: async (d) => void calls.push(`afterSent:${d.deliveryId}`),
			},
			clock,
			log: createLogger({ sink: () => undefined, clock, redact }),
		});
		expect(await pump.pump()).toBe(0);
		expect(calls).toEqual([
			"claimDue",
			`defer:7:chat.postMessage:${JSON.stringify({ at: NOW + 30_000, sentParts: 2 })}`,
			`defer:8:chat.postMessage:${JSON.stringify({ at: NOW + 30_000, sentParts: 0 })}`,
		]);
	});

	test("a deferred send blocks the rest of the batch: they go back unsent", async () => {
		const retry = { at: NOW + 1_000, sentParts: 0 };
		const { pump, calls } = harness(
			[item(9), item(10)],
			new Map([[9, { kind: "deferred", error: new Error("ratelimited"), retry }]]),
		);
		expect(await pump.pump()).toBe(0);
		expect(calls).toEqual([
			"claimDue",
			"send:9",
			`defer:9:ratelimited:${JSON.stringify(retry)}`,
			`defer:10:chat.postMessage:${JSON.stringify({ at: NOW + 30_000, sentParts: 0 })}`,
		]);
	});
});
