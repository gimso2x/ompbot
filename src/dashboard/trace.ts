import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { newestSessionFile } from "../omp/session-heal";
import { readTranscript } from "./trace-transcript";

/**
 * Trace of one turn for the dashboard's waterfall: every model call, tool call and sub-agent of the turn's omp
 * session as a span on the turn's clock. Read-only (one `readonly` database handle, the session files read whole).
 */

export type SpanKind = "agent" | "subagent" | "llm" | "tool";
export type SpanStatus = "running" | "done" | "failed";

export interface TraceSpan {
	id: string;
	name: string;
	kind: SpanKind;
	status: SpanStatus;
	/** Ms from the turn's dispatch; `end` is absent while the span runs. */
	start: number;
	end?: number;
	/** A few muted words after the name: the tool's intent, the tools a model call asked for, a sub-agent's model. */
	detail?: string;
	model?: string;
	/** The span's own numbers; agents add up their children on the page. */
	tokensIn?: number;
	tokensOut?: number;
	cost?: number;
	error?: string;
	children?: TraceSpan[];
}

export type TraceError = "no_database" | "unknown_turn" | "not_dispatched" | "no_session";

export type TurnTrace =
	| {
			ok: true;
			inboundId: number;
			startedAt: number;
			now: number;
			live: boolean;
			truncated: boolean;
			root: TraceSpan;
	  }
	| { ok: false; error: TraceError };

/**
 * The trace of inbound row `inboundId`: its origin's current session file, from the row's dispatch to the next
 * dispatch of the same conversation (or now). A pending row has no trace yet.
 */
export function readTurnTrace(homeDir: string, inboundId: number, now: number): TurnTrace {
	const dbPath = join(homeDir, "ompbot.db");
	if (!existsSync(dbPath)) return { ok: false, error: "no_database" };
	const db = new Database(dbPath, { readonly: true, strict: true });
	try {
		const turn = db
			.query<{ origin_key: string; state: string; dispatched_at: number | null; op_ref: string | null }, [number]>(
				"SELECT origin_key, state, dispatched_at, op_ref FROM inbound WHERE inbound_id = ?",
			)
			.get(inboundId);
		if (turn === null) return { ok: false, error: "unknown_turn" };
		if (turn.dispatched_at === null) return { ok: false, error: "not_dispatched" };
		const next = db
			.query<{ at: number | null }, [string, number, number]>(
				"SELECT MIN(dispatched_at) AS at FROM inbound WHERE origin_key = ? AND dispatched_at > ? AND inbound_id != ?",
			)
			.get(turn.origin_key, turn.dispatched_at, inboundId);
		const origin = db
			.query<{ session_dir: string; session_file: string | null }, [string]>(
				"SELECT session_dir, session_file FROM origins WHERE origin_key = ?",
			)
			.get(turn.origin_key);
		const file =
			origin === null
				? undefined
				: (origin.session_file ?? (existsSync(origin.session_dir) ? newestSessionFile(origin.session_dir) : undefined));
		if (file === undefined || !existsSync(file)) return { ok: false, error: "no_session" };
		const live = turn.state === "dispatched";
		const startedAt = turn.dispatched_at;
		const main = readTranscript(file, {
			from: startedAt,
			to: next?.at ?? Number.POSITIVE_INFINITY,
			live,
			origin: startedAt,
		});
		const failed = turn.state === "failed_notified";
		// The session goes on past the turn (memory notes, the next request): a finished turn ends with its last span.
		const lastEnd = Math.max(0, ...main.spans.map((span) => span.end ?? span.start));
		return {
			ok: true,
			inboundId,
			startedAt,
			now,
			live,
			truncated: main.truncated,
			root: {
				id: "turn",
				name: "턴",
				kind: "agent",
				status: live ? "running" : failed ? "failed" : "done",
				start: 0,
				...(live ? {} : { end: lastEnd }),
				...(main.model === undefined ? {} : { model: main.model }),
				children: main.spans,
			},
		};
	} finally {
		db.close();
	}
}
