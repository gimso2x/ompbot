import { describe, expect, test } from "bun:test";
import { RetryAfterGate } from "../src/channel/retry";

const START = 1_800_000_000_000;

/** A clock the test moves by hand, so a block's end is a number the test set, never wall time. */
function clockAt(start = START) {
	let now = start;
	return {
		now: () => now,
		advance(ms: number) {
			now += ms;
		},
	};
}

/** A gate whose parking log goes to `parks`, so the adapter-facing half of `park` is covered too. */
function gateWith(clock: { now: () => number }) {
	const parks: Array<[string, number]> = [];
	const gate = new RetryAfterGate({ clock, park: (key, ms) => parks.push([key, ms]) });
	return { gate, parks };
}

describe("RetryAfterGate", () => {
	test("a 429 parks its own key only, and the block ends when Retry-After passes", () => {
		const clock = clockAt();
		const { gate, parks } = gateWith(clock);
		gate.park("chat.postMessage", 2_000);
		expect(gate.isBlocked("chat.postMessage")).toBe(true);
		expect(gate.isBlocked("chat.update")).toBe(false);
		expect(gate.untilOf("chat.postMessage")).toBe(START + 2_000);
		expect(parks).toEqual([["chat.postMessage", 2_000]]);
		clock.advance(2_000);
		expect(gate.isBlocked("chat.postMessage")).toBe(false);
		expect(gate.untilOf("chat.postMessage")).toBe(START + 2_000);
	});

	test("an unblocked key has no end time (a sender falls back to its own now)", () => {
		const { gate } = gateWith(clockAt());
		expect(gate.untilOf("post")).toBeUndefined();
	});

	test("call rejects a parked key without running the request, passing the remaining time to the platform's error", async () => {
		const clock = clockAt();
		const { gate } = gateWith(clock);
		gate.park("post", 5_000);
		clock.advance(2_000);
		let ran = false;
		const remaining = await gate
			.call(
				"post",
				async () => {
					ran = true;
					return "sent";
				},
				(ms) => new Error(`blocked ${ms}`),
				() => undefined,
			)
			.catch((err: Error) => err.message);
		expect(remaining).toBe("blocked 3000");
		expect(ran).toBe(false);
	});

	test("call runs the request and leaves the key alone without a rate-limit error", async () => {
		const clock = clockAt();
		const { gate, parks } = gateWith(clock);
		expect(
			await gate.call(
				"post",
				async () => "sent",
				() => new Error("blocked"),
				() => undefined,
			),
		).toBe("sent");
		expect(gate.isBlocked("post")).toBe(false);
		expect(parks).toEqual([]);
	});

	test("call parks the key when the request answers a rate limit, then rethrows the platform error", async () => {
		const clock = clockAt();
		const { gate, parks } = gateWith(clock);
		const failure = new Error("429");
		const thrown = await gate
			.call(
				"post",
				async () => {
					throw failure;
				},
				() => new Error("blocked"),
				() => 1_500,
			)
			.catch((err: Error) => err);
		expect(thrown).toBe(failure);
		expect(gate.isBlocked("post")).toBe(true);
		expect(gate.untilOf("post")).toBe(START + 1_500);
		expect(parks).toEqual([["post", 1_500]]);
	});

	test("call rejects an error that is no rate limit, parking nothing", async () => {
		const clock = clockAt();
		const { gate, parks } = gateWith(clock);
		const failure = new Error("500 internal");
		const thrown = await gate
			.call(
				"typing",
				async () => {
					throw failure;
				},
				() => new Error("blocked"),
				() => undefined,
			)
			.catch((err: Error) => err);
		expect(thrown).toBe(failure);
		expect(gate.isBlocked("typing")).toBe(false);
		expect(parks).toEqual([]);
	});
});
