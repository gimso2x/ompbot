import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openStore, type Store } from "../src/store/db";
import { makeHome, type TestHome } from "./helpers/bot-home";
import { killSpawned, runMain } from "./helpers/daemon-process";

const DAY = 24 * 3_600_000;

let home: TestHome;
let at: number;
let store: Store;

beforeEach(() => {
	home = makeHome("ompbot-cli-feedback-");
	at = Date.now();
	store = openStore({
		timezone: "Asia/Seoul",
		path: join(home.dir, "ompbot.db"),
		clock: { now: () => at },
		redact: (text) => text,
	});
});

afterEach(() => {
	killSpawned();
	store.close();
	home.remove();
});

/** One answered DM turn whose answer posted `posts` messages; returns the message ts values. */
function turn(name: string, posts: number): string[] {
	const origin = "slack/dm/D1";
	store.ensureOrigin(origin, join(home.dir, "sessions"));
	const threadRef = `D1:${name}`;
	store.recordInbound({ originKey: origin, platformMessageId: threadRef, textRef: `${name} 요청`, threadRef });
	store.markDispatched(threadRef, { opRef: `op-${name}`, entryCursor: null });
	store.recordAnswer({ originKey: origin, opRef: `op-${name}`, threadRef, parts: ["답"] });
	const delivery = store.listDeliveries({ originKey: origin }).find((row) => row.opRef === `op-${name}`);
	if (delivery === undefined) throw new Error("no delivery");
	return Array.from({ length: posts }, (_, part) => {
		const ts = `${name}.00000${part}`;
		store.feedback.recordPost({ channel: "D1", ts, deliveryId: delivery.deliveryId, part });
		return ts;
	});
}

const react = (ts: string, verdict: "up" | "down", eventTs: string) =>
	expect(store.feedback.applyReaction({ channel: "D1", ts, verdict, action: "added", eventTs })).toBe("recorded");

describe("ompbot feedback", () => {
	test("AC-7: --json lists only the 👎 turns of the last 7 days, one element per turn", async () => {
		const [old] = turn("1700000000", 1);
		at = Date.now() - 8 * DAY;
		react(old ?? "", "down", "1700000000.100000");
		at = Date.now() - DAY;
		const twoParts = turn("1800000000", 2);
		const [liked] = turn("1800000100", 1);
		for (const ts of twoParts) react(ts, "down", `${ts.slice(0, 10)}.20000${ts.at(-1)}`);
		react(liked ?? "", "up", "1800000100.300000");

		const run = await runMain(home.dir, ["feedback", "--json"]);
		expect(run.stderr).toBe("");
		expect(run.code).toBe(0);
		const listed = JSON.parse(run.stdout) as Array<{ originKey: string; inboundId: number; preview: string }>;
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({ originKey: "slack/dm/D1", preview: "1800000000 요청" });
		expect(listed[0]?.inboundId).toBeNumber();

		const wider = JSON.parse((await runMain(home.dir, ["feedback", "--json", "--days", "10"])).stdout) as unknown[];
		expect(wider).toHaveLength(2);
	});
});
