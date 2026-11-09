import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboardServer } from "../src/dashboard/server";
import type { DashboardSnapshot } from "../src/dashboard/snapshot";
import { readTurnTrace, type TraceError, type TraceSpan, type TurnTrace } from "../src/dashboard/trace";
import { renderTrace, type TraceViewState } from "../src/dashboard/trace-view";
import { openStore } from "../src/store/db";

const T0 = Date.parse("2026-11-05T10:00:00Z");
const NOW = T0 + 60_000;
let home: string;
let sessionFile: string;

const iso = (offset: number): string => new Date(T0 + offset).toISOString();
const put = (file: string, entry: unknown): void => appendFileSync(file, `${JSON.stringify(entry)}\n`);
const assistant = (id: string, start: number, end: number, extra: Record<string, unknown>) => ({
	type: "message",
	id,
	timestamp: iso(end),
	message: { role: "assistant", model: "opus", timestamp: T0 + start, completedAt: T0 + end, ...extra },
});
const call = (id: string, name: string, intent: string) => ({ type: "toolCall", id, name, arguments: { i: intent } });
const result = (callId: string, at: number, isError = false, text = "ok") => ({
	type: "message",
	id: `r-${callId}`,
	timestamp: iso(at),
	message: { role: "toolResult", toolCallId: callId, isError, content: [{ type: "text", text }] },
});

/** One conversation with turn 1 dispatched at T0 (in `state`) and, when given, turn 2 dispatched at `nextAt`. */
function seed(state: string, nextAt?: number): void {
	const dbPath = join(home, "ompbot.db");
	openStore({ path: dbPath, clock: { now: () => NOW }, redact: (text) => text }).close();
	const sessionDir = join(home, "sessions", "o", "e1");
	mkdirSync(sessionDir, { recursive: true });
	sessionFile = join(sessionDir, "s.jsonl");
	const db = new Database(dbPath, { strict: true });
	db.run("INSERT INTO origins (origin_key, epoch, session_dir, updated_at) VALUES ('slack/dm/U1', 1, ?, ?)", [
		sessionDir,
		T0,
	]);
	const add = (id: string, rowState: string, at: number | null) =>
		db.run(
			`INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at)
			 VALUES (?, 'slack/dm/U1', 1, 'x', ?, ?, ?)`,
			[id, rowState, T0 - 1000, at],
		);
	add("m1", state, T0);
	add("m2", "pending", null);
	if (nextAt !== undefined) add("m3", "dispatched", T0 + nextAt);
	db.close();
	put(sessionFile, { type: "session", timestamp: iso(-60_000) });
	put(sessionFile, { type: "model_change", timestamp: iso(-60_000), model: "anthropic/opus" });
	// The turn before: never part of this trace.
	put(sessionFile, assistant("old", -50_000, -40_000, { stopReason: "stop", content: [] }));
	put(sessionFile, { type: "message", id: "u1", timestamp: iso(200), message: { role: "user", content: [] } });
}

const shape = (span: TraceSpan) => [span.id, span.kind, span.status, span.start, span.end];
const traceOf = (now = NOW): Extract<TurnTrace, { ok: true }> => {
	const trace = readTurnTrace(home, 1, now);
	if (!trace.ok) throw new Error(trace.error);
	return trace;
};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ompbot-trace-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("turn trace reader", () => {
	test("a live turn: model calls with tokens and cost, tool waits, a failed tool's masked error, the call being generated now", () => {
		seed("dispatched");
		put(
			sessionFile,
			assistant("a1", 1000, 3000, {
				stopReason: "toolUse",
				usage: { input: 2, cacheRead: 900, cacheWrite: 100, output: 50, cost: { total: 0.25 } },
				content: [call("t1", "read", "Reading the log"), call("t2", "bash", "Using sk-TESTKEY123 to probe")],
			}),
		);
		put(sessionFile, result("t1", 3500));
		put(sessionFile, result("t2", 8000, true, "exit 1 with xoxb-TEST-0\nmore"));
		const trace = traceOf();
		const [model, read, bash, pending] = trace.root.children ?? [];
		expect([trace.live, trace.root.status, trace.root.end]).toEqual([true, "running", undefined]);
		expect((trace.root.children ?? []).map(shape)).toEqual([
			["a1", "llm", "done", 1000, 3000],
			["t1", "tool", "done", 3000, 3500],
			["t2", "tool", "failed", 3000, 8000],
			["pending-model", "llm", "running", 8000, undefined],
		]);
		expect(model).toMatchObject({ tokensIn: 1002, tokensOut: 50, cost: 0.25, detail: "→ read · bash" });
		expect(read?.detail).toBe("Reading the log");
		expect([bash?.detail, bash?.error]).toEqual(["Using [REDACTED] to probe", "exit 1 with [REDACTED] more"]);
		expect(pending?.detail).toBe("응답 생성 중");
	});

	test("a finished turn stops at the next dispatch, fails a tool call never answered and ends with its last span", () => {
		seed("answered", 20_000);
		put(sessionFile, assistant("a1", 1000, 2000, { stopReason: "toolUse", content: [call("t1", "bash", "x")] }));
		put(sessionFile, { type: "custom", timestamp: iso(9000) });
		put(sessionFile, assistant("a2", 21_000, 25_000, { stopReason: "stop", content: [] }));
		const trace = traceOf();
		expect((trace.root.children ?? []).map(shape)).toEqual([
			["a1", "llm", "done", 1000, 2000],
			["t1", "tool", "failed", 2000, 2000],
		]);
		expect([trace.live, trace.root.status, trace.root.end]).toEqual([false, "done", 2000]);
	});

	test("sub-agents beside the session are children with ids of their own; a stopped one ends at its last message", () => {
		seed("dispatched");
		put(sessionFile, assistant("a1", 1000, 2000, { stopReason: "toolUse", content: [call("t1", "task", "Spawning")] }));
		put(sessionFile, result("t1", 2100));
		mkdirSync(sessionFile.replace(/\.jsonl$/, ""));
		const sub = join(sessionFile.replace(/\.jsonl$/, ""), "Scout.jsonl");
		put(sub, { type: "session", timestamp: iso(2050) });
		put(sub, { type: "model_change", timestamp: iso(2050), model: "anthropic/sonnet" });
		put(
			sub,
			assistant("a1", 2100, 5000, { stopReason: "stop", usage: { output: 9, cost: { total: 0.5 } }, content: [] }),
		);
		put(sub, { type: "custom", timestamp: iso(40_000) });
		const scout = (traceOf().root.children ?? []).find((span) => span.kind === "subagent");
		expect(scout && shape(scout)).toEqual(["agent:Scout", "subagent", "done", 2050, 5000]);
		expect(scout?.detail).toBe("anthropic/sonnet");
		expect((scout?.children ?? []).map(shape)).toEqual([["agent:Scout/a1", "llm", "done", 2100, 5000]]);
	});

	test.each<[number, TraceError]>([
		[2, "not_dispatched"],
		[99, "unknown_turn"],
	])("inbound %i has no trace: %s", (id, error) => {
		seed("dispatched");
		expect(readTurnTrace(home, id, NOW)).toEqual({ ok: false, error });
	});
});

describe("api/turn/<id>/trace", () => {
	test("answers the reader under a prefix, 404 for a turn without a trace and trace_disabled without a reader", async () => {
		seed("dispatched");
		const snapshot = async (): Promise<DashboardSnapshot> => {
			throw new Error("not asked");
		};
		const server = startDashboardServer({
			port: 0,
			hostname: "127.0.0.1",
			snapshot,
			trace: (id) => readTurnTrace(home, id, NOW),
		});
		const bare = startDashboardServer({ port: 0, hostname: "127.0.0.1", snapshot });
		try {
			const ok = await fetch(`http://127.0.0.1:${server.port}/x/api/turn/1/trace`);
			expect(ok.status).toBe(200);
			expect(await ok.json()).toMatchObject({ ok: true, inboundId: 1, live: true });
			const pending = await fetch(`http://127.0.0.1:${server.port}/api/turn/2/trace`);
			expect([pending.status, await pending.json()]).toEqual([404, { ok: false, error: "not_dispatched" }]);
			const off = await fetch(`http://127.0.0.1:${bare.port}/api/turn/1/trace`);
			expect([off.status, await off.json()]).toEqual([404, { error: "trace_disabled" }]);
		} finally {
			server.stop(true);
			bare.stop(true);
		}
	});
});

describe("waterfall renderer", () => {
	const span = (
		id: string,
		kind: TraceSpan["kind"],
		start: number,
		end: number | undefined,
		extra: Partial<TraceSpan> = {},
	) =>
		({
			id,
			name: id,
			kind,
			status: end === undefined ? "running" : "done",
			start,
			...(end === undefined ? {} : { end }),
			...extra,
		}) satisfies TraceSpan;
	const answer = (children: TraceSpan[]): TurnTrace => ({
		ok: true,
		inboundId: 1,
		startedAt: T0,
		now: NOW,
		live: true,
		truncated: false,
		root: { id: "turn", name: "턴", kind: "agent", status: "running", start: 0, children },
	});
	const base = [
		span("m1", "llm", 0, 4000, { cost: 0.5 }),
		span("t1", "tool", 4000, 9000),
		span("agent:S", "subagent", 5000, 8000, { children: [span("agent:S/m1", "llm", 5000, 8000, { cost: 1.25 })] }),
	];
	const view = (state: Partial<TraceViewState> = {}): TraceViewState => ({
		now: NOW,
		fold: {},
		focus: null,
		open: null,
		title: "요청",
		...state,
	});
	const rows = (html: string): string[] => [...html.matchAll(/data-span="([^"]+)"/g)].map((match) => match[1] ?? "");
	const sig = (html: string): string | undefined => /data-sig="([^"]+)"/.exec(html)?.[1];

	test("a finished sub-agent starts folded with its cost rolled into the root, and the slowest finished call is tagged", () => {
		const html = renderTrace(answer(base), view());
		expect(rows(html)).toEqual(["turn", "m1", "t1", "agent:S"]);
		expect(html).toMatch(/data-span="turn"[^>]*aria-label="턴, 턴, 실행 중, 1분, \$1\.75"/);
		expect(html).toMatch(/data-span="t1"(?:(?!data-span=).)*class="tw-tag"/);
		expect(rows(renderTrace(answer(base), view({ fold: { "agent:S": false } })))).toContain("agent:S/m1");
	});

	test("data-sig holds while only the clock moves and changes when a span arrives or a fold opens", () => {
		const first = renderTrace(answer(base), view());
		const later = renderTrace(answer(base), view({ now: NOW + 3000 }));
		expect(later).not.toBe(first);
		expect(sig(later)).toBe(sig(first));
		expect(sig(renderTrace(answer([...base, span("t2", "tool", 9000, undefined)]), view()))).not.toBe(sig(first));
		expect(sig(renderTrace(answer(base), view({ fold: { "agent:S": false } })))).not.toBe(sig(first));
	});
});
