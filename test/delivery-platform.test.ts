import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact } from "../src/redact";
import { openStore, type Store } from "../src/store/db";

const DISCORD_CH = "111111111111111111";
const DISCORD_THREAD = "222222222222222222";

let dir: string;
let now: number;
let store: Store;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-delivery-platform-"));
	now = 1_800_000_000_000;
	store = openStore({ timezone: "Asia/Seoul", path: join(dir, "ompbot.db"), clock: { now: () => now }, redact });
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

/** One owner message on `originKey` in `threadRef`, answered with `body` (a pending delivery). */
function answer(originKey: string, threadRef: string, messageId: string, body: string): void {
	store.ensureOrigin(originKey, join(dir, "sessions", messageId));
	store.recordInbound({ originKey, platformMessageId: messageId, textRef: `질문 ${body}`, threadRef });
	store.markDispatched(messageId, { opRef: `op-${messageId}`, entryCursor: null });
	store.recordAnswer({ originKey, opRef: `op-${messageId}`, threadRef, parts: [body] });
}

describe("claimDue by platform", () => {
	beforeEach(() => {
		answer("slack/ch/C1/t/1.2", "C1:1.2", "C1:1.2", "slack thread");
		answer("slack/dm/D1", "D1:-", "D1:9.9", "slack top level");
		// A monitor answer: its origin is no chat key, its thread ref is the owner's Slack DM.
		store.recordInterim({ originKey: "monitor/x", opRef: "mon-1", threadRef: "D1:-", index: 0, body: "monitor" });
		answer(
			`discord/ch/${DISCORD_CH}/t/${DISCORD_THREAD}`,
			`${DISCORD_CH}:${DISCORD_THREAD}`,
			`${DISCORD_CH}:${DISCORD_THREAD}`,
			"discord thread",
		);
	});

	const bodies = (rows: Array<{ body: string }>) => rows.map((row) => row.body);
	const states = () => Object.fromEntries(store.listDeliveries().map((row) => [row.body, row.state]));

	test("slack takes the Slack thread refs (the monitor delivery included) and leaves the Discord one pending", () => {
		expect(bodies(store.claimDue(20, "slack"))).toEqual(["slack thread", "slack top level", "monitor"]);
		expect(states()).toEqual({
			"slack thread": "inflight",
			"slack top level": "inflight",
			monitor: "inflight",
			"discord thread": "pending",
		});
	});

	test("discord takes only the Discord thread ref", () => {
		expect(bodies(store.claimDue(20, "discord"))).toEqual(["discord thread"]);
		expect(states()).toEqual({
			"slack thread": "pending",
			"slack top level": "pending",
			monitor: "pending",
			"discord thread": "inflight",
		});
	});

	test("the limit counts only the platform's rows; without a platform every due row is claimed as before", () => {
		expect(bodies(store.claimDue(1, "discord"))).toEqual(["discord thread"]);
		expect(bodies(store.claimDue())).toEqual(["slack thread", "slack top level", "monitor"]);
	});

	test("without a platform every due row of every platform is claimed, in delivery order", () => {
		expect(bodies(store.claimDue())).toEqual(["slack thread", "slack top level", "monitor", "discord thread"]);
		expect(states()).toEqual({
			"slack thread": "inflight",
			"slack top level": "inflight",
			monitor: "inflight",
			"discord thread": "inflight",
		});
	});
});

describe("ledger reads by platform", () => {
	beforeEach(() => {
		answer("slack/dm/D1", "D1:1.1", "D1:1.1", "slack dm answer");
		answer("slack/ch/C1/t/1.2", "C1:1.2", "C1:1.2", "slack thread answer");
		answer(`discord/dm/${DISCORD_CH}`, `${DISCORD_CH}:333333333333333333`, `${DISCORD_CH}:333`, "discord dm answer");
		answer(
			`discord/ch/${DISCORD_CH}/t/${DISCORD_THREAD}`,
			`${DISCORD_CH}:${DISCORD_THREAD}`,
			`${DISCORD_CH}:${DISCORD_THREAD}`,
			"discord thread answer",
		);
		for (const row of store.claimDue()) store.confirmDelivery(row.deliveryId);
	});

	test("listOrigins returns the platform's origin keys only", () => {
		expect(store.listOrigins("discord")).toEqual([
			`discord/ch/${DISCORD_CH}/t/${DISCORD_THREAD}`,
			`discord/dm/${DISCORD_CH}`,
		]);
		expect(store.listOrigins("slack")).toEqual(["slack/ch/C1/t/1.2", "slack/dm/D1"]);
	});

	test("listThreadTargets returns the platform's answered threads only", () => {
		const sorted = (targets: Array<{ channel: string; rootTs: string }>) =>
			targets.map((t) => `${t.channel}:${t.rootTs}`).sort();
		expect(sorted(store.listThreadTargets("discord", 0, 50))).toEqual([
			`${DISCORD_CH}:${DISCORD_THREAD}`,
			`${DISCORD_CH}:333333333333333333`,
		]);
		expect(sorted(store.listThreadTargets("slack", 0, 50))).toEqual(["C1:1.2", "D1:1.1"]);
	});

	test("listRecallCandidates of a Discord conversation reads its Discord rows and no Slack row", () => {
		const candidates = store.listRecallCandidates(DISCORD_CH, "none", 50);
		expect(candidates.length).toBeGreaterThan(0);
		for (const candidate of candidates) expect(candidate.originKey.startsWith(`discord/`)).toBe(true);
		expect(new Set(candidates.map((c) => c.originKey))).toEqual(
			new Set([`discord/dm/${DISCORD_CH}`, `discord/ch/${DISCORD_CH}/t/${DISCORD_THREAD}`]),
		);
		expect(candidates.map((c) => c.text)).toContain("discord thread answer");
		const slack = store.listRecallCandidates("D1", "none", 50);
		expect(slack.map((c) => c.originKey)).toEqual(["slack/dm/D1", "slack/dm/D1"]);
	});

	test("ownerDmOrigin reads the platform's DM origin; Slack stays the default", () => {
		expect(store.ownerDmOrigin()).toBe("slack/dm/D1");
		expect(store.ownerDmOrigin("discord")).toBe(`discord/dm/${DISCORD_CH}`);
		expect(store.ownerChannel()).toBe("D1");
	});
});
