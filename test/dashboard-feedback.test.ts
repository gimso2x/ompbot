import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDashboardMain, renderItemDetail } from "../src/dashboard/html";
import { buildSnapshot, type SnapshotDeps } from "../src/dashboard/snapshot";
import { readTurnTrace } from "../src/dashboard/trace";
import { renderTrace } from "../src/dashboard/trace-view";
import { openStore, type Store } from "../src/store/db";

const NOW = Date.parse("2026-11-09T01:00:00Z");
const DAY = 24 * 3_600_000;

let home: string;
let at: number;
let store: Store;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ompbot-feedback-dash-"));
	at = NOW;
	store = openStore({
		timezone: "Asia/Seoul",
		path: join(home, "ompbot.db"),
		clock: { now: () => at },
		redact: (text) => text,
	});
});
afterEach(() => {
	store.close();
	rmSync(home, { recursive: true, force: true });
});

function deps(): SnapshotDeps {
	return {
		homeDir: home,
		repoDir: "/srv/ompbot",
		timezone: "Asia/Seoul",
		config: undefined,
		now: () => NOW,
		callDaemon: async () => {
			throw new Error("no daemon");
		},
		run: async () => ({ code: 1, stdout: "", timedOut: false }),
		ompVersion: async () => "omp-stub 0.0.0",
		hostOps: () => {
			throw new Error("no hosts");
		},
		collectGates: () => [],
	};
}

/** One answered turn in its own channel thread, with a session file and `posts` Slack messages recorded for it. */
function turn(name: string, request: string, posts: number): { inboundId: number; ts: string[] } {
	const origin = `slack/ch/C${name}/t/1.0`;
	const sessionDir = join(home, "sessions", name);
	mkdirSync(sessionDir, { recursive: true });
	appendFileSync(
		join(sessionDir, "s.jsonl"),
		`${JSON.stringify({ type: "session", timestamp: "2026-11-09T00:00:00Z" })}\n`,
	);
	store.ensureOrigin(origin, sessionDir);
	const threadRef = `C${name}:1.0`;
	store.recordInbound({ originKey: origin, platformMessageId: threadRef, textRef: request, threadRef });
	store.markDispatched(threadRef, { opRef: `op-${name}`, entryCursor: null });
	store.recordAnswer({ originKey: origin, opRef: `op-${name}`, threadRef, parts: ["답"] });
	const [delivery] = store.listDeliveries({ originKey: origin });
	if (delivery === undefined) throw new Error("no delivery");
	const ts = Array.from({ length: posts }, (_, part) => `1800000000.${name.charCodeAt(0)}00${part}`);
	for (const [part, postTs] of ts.entries()) {
		store.feedback.recordPost({ channel: `C${name}`, ts: postTs, deliveryId: delivery.deliveryId, part });
	}
	const db = new Database(join(home, "ompbot.db"), { readonly: true, strict: true });
	const row = db.query("SELECT inbound_id FROM inbound WHERE platform_message_id = ?").get(threadRef) as {
		inbound_id: number;
	};
	db.close();
	return { inboundId: row.inbound_id, ts };
}

function react(name: string, ts: string, verdict: "up" | "down", eventTs: string): void {
	expect(store.feedback.applyReaction({ channel: `C${name}`, ts, verdict, action: "added", eventTs })).toBe("recorded");
}

describe("dashboard feedback", () => {
	test("AC-3c: -1 on two parts of one turn counts one down turn, listed once", async () => {
		const a = turn("A", "A 요청 sk-ant-api03-SECRETSECRETSECRET", 2);
		react("A", a.ts[0] ?? "", "down", "1800000100.000001");
		react("A", a.ts[1] ?? "", "down", "1800000100.000002");
		const snapshot = await buildSnapshot(deps());
		if (!snapshot.feedback.ok) throw new Error(snapshot.feedback.error);
		expect(snapshot.feedback.down).toBe(1);
		expect(snapshot.feedback.recentDown.map((item) => item.inboundId)).toEqual([a.inboundId]);
	});

	test("AC-6: the feedback section counts 7 days of up/down turns and lists the 👎 ones with a masked request", async () => {
		const a = turn("A", "A 요청 sk-ant-api03-SECRETSECRETSECRET", 1);
		const b = turn("B", "B 요청", 1);
		const old = turn("O", "오래된 요청", 1);
		at = NOW - 8 * DAY;
		react("O", old.ts[0] ?? "", "down", "1799000000.000001");
		at = NOW - DAY;
		react("A", a.ts[0] ?? "", "down", "1800000100.000001");
		react("B", b.ts[0] ?? "", "up", "1800000100.000002");
		const snapshot = await buildSnapshot(deps());
		expect(snapshot.feedback).toMatchObject({ ok: true, days: 7, up: 1, down: 1 });
		if (!snapshot.feedback.ok) throw new Error(snapshot.feedback.error);
		const [listed] = snapshot.feedback.recentDown;
		expect(snapshot.feedback.recentDown).toHaveLength(1);
		expect(listed).toMatchObject({ inboundId: a.inboundId, originKey: "slack/ch/CA/t/1.0" });
		expect(listed?.preview).toStartWith("A 요청 ");
		expect(listed?.preview).not.toContain("SECRETSECRETSECRET");
		// Out of the counts, but its recent-turn line still badges like the waterfall it opens.
		expect(snapshot.feedback.verdicts[String(old.inboundId)]).toBe("down");
	});

	test("AC-6: a failing feedback read is that section's error only; the other sections stay up", async () => {
		turn("A", "A 요청", 1);
		const db = new Database(join(home, "ompbot.db"), { strict: true });
		db.run("DROP TABLE turn_feedback");
		db.run("CREATE TABLE turn_feedback (broken TEXT)");
		db.close();
		const snapshot = await buildSnapshot(deps());
		expect(snapshot.feedback.ok).toBe(false);
		expect(snapshot.turns.ok).toBe(true);
		expect(snapshot.lanes.ok).toBe(true);
		expect(snapshot.approvals.ok).toBe(true);
	});

	test("AC-6a: a judged turn's board row, recent-turn line and waterfall head carry data-feedback; others none", async () => {
		const a = turn("A", "A 요청", 1);
		const b = turn("B", "B 요청", 1);
		const c = turn("C", "C 요청", 1);
		react("A", a.ts[0] ?? "", "down", "1800000100.000001");
		react("B", b.ts[0] ?? "", "up", "1800000100.000002");
		const snapshot = await buildSnapshot(deps());
		const feedbackOf = (html: string, key: string): string[] => {
			const row = new RegExp(`<a class="card[^"]*"[^>]*data-row="${key.replaceAll("/", "\\/")}"[\\s\\S]*?</a>`).exec(
				html,
			);
			return [...(row?.[0] ?? "").matchAll(/data-feedback="(\w+)"/g)].map((match) => match[1] ?? "");
		};
		const board = renderDashboardMain(snapshot, undefined, NOW, { view: "turns" });
		expect(feedbackOf(board, "slack/ch/CA/t/1.0")).toEqual(["down"]);
		expect(feedbackOf(board, "slack/ch/CB/t/1.0")).toEqual(["up"]);
		expect(feedbackOf(board, "slack/ch/CC/t/1.0")).toEqual([]);
		const list = renderDashboardMain(snapshot, undefined, NOW, { view: "turns", layout: "list" });
		expect(list).toMatch(/<tr data-row="slack\/ch\/CA\/t\/1.0"[^>]*>(?:(?!<\/tr>).)*data-feedback="down"/);
		expect(list).not.toMatch(/<tr data-row="slack\/ch\/CC\/t\/1.0"[^>]*>(?:(?!<\/tr>).)*data-feedback/);
		expect(renderItemDetail(snapshot, "turns", "slack/ch/CA/t/1.0")).toContain('data-feedback="down"');
		expect(renderItemDetail(snapshot, "turns", "slack/ch/CC/t/1.0")).not.toContain("data-feedback");

		const state = { now: NOW, fold: {}, focus: null, open: null, title: "" };
		const head = (inboundId: number): string => {
			const trace = readTurnTrace(home, inboundId, NOW);
			return /<div class="tw-head">[\s\S]*?<\/div>/.exec(renderTrace(trace, state))?.[0] ?? "";
		};
		expect(head(a.inboundId)).toContain('data-feedback="down"');
		expect(head(b.inboundId)).toContain('data-feedback="up"');
		expect(head(c.inboundId)).not.toContain("data-feedback");
	});
});
