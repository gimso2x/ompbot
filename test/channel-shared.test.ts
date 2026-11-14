// Shared channel pieces the Slack and Discord adapters call (T-20261113-25): addressing, peer records,
// thread-link tokens, card runs, table detection, the dead-letter verdict and the single-flight backfill runner.
import { describe, expect, test } from "bun:test";
import { countsTowardDeadLetter, SingleFlightBackfill } from "../src/channel/backfill";
import { cardRuns } from "../src/channel/card";
import { isChannelMessageAddressed, recordPeerInbound, resolveThreadLinks } from "../src/channel/inbound";
import { tableEndAt } from "../src/channel/text";
import type { CoreSink, IngestOutcome, PeerInboundOutcome } from "../src/channel/types";
import type { Logger } from "../src/log";

function recordingLog(): Logger & { lines: Array<[string, Record<string, unknown> | undefined]> } {
	const lines: Array<[string, Record<string, unknown> | undefined]> = [];
	const push = (event: string, fields?: Record<string, unknown>) => {
		lines.push([event, fields]);
	};
	return { lines, debug: push, info: push, warn: push, error: push };
}

function core(extra: Partial<CoreSink> = {}): CoreSink {
	return { onInbound: () => undefined, onCommand: () => undefined, onAction: () => undefined, ...extra };
}

const channelInput = {
	mentioned: false,
	forPeer: false,
	threadRef: undefined,
	requireMention: false,
	mentionFree: false,
};

describe("isChannelMessageAddressed", () => {
	test("a mention-free channel addresses; a mention addresses; neither does nothing", () => {
		expect(isChannelMessageAddressed(core(), { ...channelInput, mentionFree: true })).toBe(true);
		expect(isChannelMessageAddressed(core(), { ...channelInput, mentioned: true })).toBe(true);
		expect(isChannelMessageAddressed(core(), channelInput)).toBe(false);
	});

	test("requireMention ignores known threads; a message for a peer is never addressed", () => {
		const known = core({ knowsThread: () => true });
		expect(isChannelMessageAddressed(known, { ...channelInput, threadRef: "C1:1.0" })).toBe(true);
		expect(isChannelMessageAddressed(known, { ...channelInput, threadRef: "C1:1.0", requireMention: true })).toBe(
			false,
		);
		expect(isChannelMessageAddressed(core(), { ...channelInput, mentionFree: true, forPeer: true })).toBe(false);
	});
});

describe("recordPeerInbound", () => {
	const inbound = {
		platformMessageId: "C1:1.0",
		originKey: "o",
		text: "t",
		threadRef: "C1:1.0",
		peer: { userId: "U", name: "p" },
	};
	const run = async (outcome: PeerInboundOutcome) => {
		const drops: string[] = [];
		let notices = 0;
		const hops: Array<{ turns: number; windowMs: number }> = [];
		const sink = core({
			onPeerInbound: (_m, hop) => {
				hops.push(hop);
				return outcome;
			},
		});
		const drop = (reason: string): IngestOutcome => {
			drops.push(reason);
			return "dropped";
		};
		const result = await recordPeerInbound(
			sink,
			recordingLog(),
			inbound,
			{ turns: 3, windowMinutes: 30 },
			drop,
			async () => {
				notices += 1;
			},
		);
		return { result, drops, notices, hops };
	};

	test("recorded, duplicate and the cap notice once per episode", async () => {
		expect(await run({})).toEqual({
			result: undefined,
			drops: [],
			notices: 0,
			hops: [{ turns: 3, windowMs: 1_800_000 }],
		});
		expect((await run({ duplicate: true })).result).toBe("duplicate");
		expect(await run({ dropped: "peer_hop_cap", notice: true })).toMatchObject({
			result: "dropped",
			drops: ["peer_hop_cap"],
			notices: 1,
		});
		expect(await run({ dropped: "peer_hop_cap" })).toMatchObject({ notices: 0 });
	});
});

test("resolveThreadLinks swaps each token for a link and drops one whose permalink fails", async () => {
	const log = recordingLog();
	const body = "a{{thread-link:C1:1.5}}b{{thread-link:C2:2.5}}c";
	const out = await resolveThreadLinks(body, /\{\{thread-link:([A-Z0-9]+):([0-9.]+)\}\}/g, log, async (channel, ts) => {
		if (channel === "C2") throw new Error("nope");
		return `https://x/${channel}/${ts}`;
	});
	expect(out).toBe("a · [스레드 보기](https://x/C1/1.5)bc");
	expect(log.lines).toEqual([["permalink_failed", { channel: "C2", error: "nope" }]]);
	expect(await resolveThreadLinks("plain", /x/g, log, async () => "u")).toBe("plain");
});

test("cardRuns keeps a refused card as text and numbers its issues", () => {
	const issues: string[] = [];
	const body = "intro\n```card\nbad\n```\n```card\ngood\n```\nend";
	const runs = cardRuns<{ ok: true }>(body, issues, (json, first) =>
		json === "good" && !first ? { ok: true } : ["no"],
	);
	expect(runs).toEqual([
		{ kind: "text", text: "intro\n```card\nbad\n```" },
		{ kind: "card", raw: "```card\ngood\n```", ok: true },
		{ kind: "text", text: "end" },
	]);
	expect(issues).toEqual(["card 1: no"]);
});

test("tableEndAt: Slack takes one hyphen per delimiter cell, Discord three", () => {
	const lines = ["| a | b |", "| - | - |", "| 1 | 2 |", "after"];
	expect(tableEndAt(lines, 0)).toBe(3);
	expect(tableEndAt(lines, 0, 3)).toBeUndefined();
	expect(tableEndAt(["a | b", "---|---", "x \\| y"], 0, 3)).toBe(2);
});

test("countsTowardDeadLetter: the platform verdict wins, a busy ledger never counts", () => {
	expect(countsTowardDeadLetter(new Error("x"), false)).toBe(false);
	expect(countsTowardDeadLetter(new Error("SQLITE_BUSY: locked"), undefined)).toBe(false);
	expect(countsTowardDeadLetter(Object.assign(new Error("x"), { code: "SQLITE_FULL" }), undefined)).toBe(false);
	expect(countsTowardDeadLetter(new Error("bad row"), undefined)).toBe(true);
});

test("SingleFlightBackfill coalesces triggers during a pass into one follow-up and reports a throw", async () => {
	const failures: unknown[] = [];
	class Runner extends SingleFlightBackfill {
		passes = 0;
		readonly gates: Array<PromiseWithResolvers<void>> = [];
		started = Promise.withResolvers<void>();
		protected pass(): Promise<void> {
			this.passes += 1;
			this.started.resolve();
			if (this.passes === 3) return Promise.reject(new Error("boom"));
			const gate = Promise.withResolvers<void>();
			this.gates.push(gate);
			return gate.promise;
		}
		protected failed(err: unknown): void {
			failures.push(err);
		}
	}
	const runner = new Runner();
	runner.trigger();
	runner.trigger();
	runner.trigger();
	expect(runner.passes).toBe(1);
	runner.started = Promise.withResolvers<void>();
	runner.gates[0]?.resolve();
	await runner.started.promise;
	expect(runner.passes).toBe(2);
	runner.gates[1]?.resolve();
	await runner.waitForIdle();
	expect(runner.passes).toBe(2);
	runner.trigger();
	await runner.waitForIdle();
	expect(runner.passes).toBe(3);
	expect(failures).toHaveLength(1);
});
