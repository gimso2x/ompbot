import type { Database } from "bun:sqlite";

/**
 * Owner 👍/👎 on the bot's answers, bound to the turn that produced them. `delivery_posts` maps every Slack message a
 * delivery posted (`channel`, `ts`) to its delivery; `turn_feedback` holds one verdict per message, keyed like it.
 * Neither table is pruned, like `deliveries` and `inbound` (one small row per posted part or reacted message).
 */
export const FEEDBACK_DDL = `
CREATE TABLE IF NOT EXISTS delivery_posts (
	channel TEXT NOT NULL,
	ts TEXT NOT NULL,
	delivery_id INTEGER NOT NULL REFERENCES deliveries(delivery_id),
	part INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (channel, ts)
);
CREATE TABLE IF NOT EXISTS turn_feedback (
	channel TEXT NOT NULL,
	ts TEXT NOT NULL,
	delivery_id INTEGER NOT NULL,
	origin_key TEXT NOT NULL,
	op_ref TEXT NOT NULL,
	inbound_id INTEGER,
	verdict TEXT NOT NULL CHECK (verdict IN ('up','down')),
	last_event_ts TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	removed_at INTEGER,
	PRIMARY KEY (channel, ts)
);
CREATE INDEX IF NOT EXISTS turn_feedback_turn ON turn_feedback(origin_key, op_ref);
`;

export type FeedbackVerdict = "up" | "down";

/** One Slack message a delivery posted; `part` is its 0-based index among the messages of that delivery. */
export interface DeliveryPostRecord {
	channel: string;
	ts: string;
	deliveryId: number;
	part: number;
}

/** The owner adding or removing 👍/👎 on one message; `eventTs` is the Slack event's `event_ts`. */
export interface ReactionFeedback {
	channel: string;
	ts: string;
	verdict: FeedbackVerdict;
	action: "added" | "removed";
	eventTs: string;
}

/** `not_a_post`: no delivery posted that message; `stale`: an event at or before the row's last one (replay, late). */
export type FeedbackOutcome = "recorded" | "not_a_post" | "stale" | "invalid_event_ts";

/** The current verdict of one turn: its newest live row. */
export interface TurnVerdict {
	originKey: string;
	opRef: string;
	inboundId: number | null;
	verdict: FeedbackVerdict;
	/** When the verdict was set (epoch ms). */
	at: number;
}

/**
 * A Slack ts (`"1794187218.313639"`) as integer microseconds, which stay exact below 2^53 (a float of the string
 * does not). `undefined` for anything else.
 */
export function slackTsMicros(ts: string): number | undefined {
	const match = /^(\d{1,10})(?:\.(\d{1,6}))?$/.exec(ts);
	if (match === null) return undefined;
	return Number(match[1]) * 1_000_000 + Number((match[2] ?? "").padEnd(6, "0"));
}

/**
 * The op ref of the turn behind a delivery: interim texts (`:interim:<n>`), steered-thread pointers (`:steer:<n>`) and
 * channel copies (`:log-copy`, `:copy`) carry the turn's op ref plus a suffix (see the constants in `db.ts`).
 */
function turnOpRef(opRef: string): string {
	return opRef.replace(/:(?:interim|steer):\d+$|:(?:log-)?copy$/, "");
}

interface FeedbackRowSql {
	verdict: FeedbackVerdict;
	last_event_ts: string;
}

/** Writes delivery posts and feedback rows on the store's connection. */
export class FeedbackLedger {
	readonly #db: Database;
	readonly #clock: { now(): number };

	constructor(db: Database, options: { clock: { now(): number } }) {
		this.#db = db;
		this.#clock = options.clock;
	}

	recordPost(post: DeliveryPostRecord): void {
		this.#db
			.query(
				"INSERT INTO delivery_posts (channel, ts, delivery_id, part, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(channel, ts) DO NOTHING",
			)
			.run(post.channel, post.ts, post.deliveryId, post.part, this.#clock.now());
	}

	/** Whether a delivery posted the message `channel`/`ts`. */
	isPost(post: { channel: string; ts: string }): boolean {
		return (
			this.#db.query("SELECT 1 FROM delivery_posts WHERE channel = ? AND ts = ?").get(post.channel, post.ts) !== null
		);
	}

	/**
	 * One verdict per message, newest event wins: an event at or before the row's `last_event_ts` changes nothing.
	 * Added: the row takes the verdict (live). Removed: the matching verdict is marked removed, a different one only
	 * moves `last_event_ts`, and with no row a removed tombstone is written so an earlier add arriving late stays out.
	 */
	applyReaction(event: ReactionFeedback): FeedbackOutcome {
		const eventMicros = slackTsMicros(event.eventTs);
		if (eventMicros === undefined) return "invalid_event_ts";
		return this.#db.transaction((): FeedbackOutcome => {
			const post = this.#db
				.query(
					`SELECT p.delivery_id, d.origin_key, d.op_ref FROM delivery_posts p JOIN deliveries d ON d.delivery_id = p.delivery_id
						WHERE p.channel = ? AND p.ts = ?`,
				)
				.get(event.channel, event.ts) as { delivery_id: number; origin_key: string; op_ref: string } | null;
			if (post === null) return "not_a_post";
			const row = this.#db
				.query("SELECT verdict, last_event_ts FROM turn_feedback WHERE channel = ? AND ts = ?")
				.get(event.channel, event.ts) as FeedbackRowSql | null;
			if (row !== null && (slackTsMicros(row.last_event_ts) ?? 0) >= eventMicros) return "stale";
			const now = this.#clock.now();
			if (row === null) {
				const opRef = turnOpRef(post.op_ref);
				const { id } = this.#db
					.query("SELECT MIN(inbound_id) AS id FROM inbound WHERE origin_key = ? AND op_ref = ?")
					.get(post.origin_key, opRef) as { id: number | null };
				this.#db
					.query(
						`INSERT INTO turn_feedback (channel, ts, delivery_id, origin_key, op_ref, inbound_id, verdict, last_event_ts,
							created_at, removed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						event.channel,
						event.ts,
						post.delivery_id,
						post.origin_key,
						opRef,
						id,
						event.verdict,
						event.eventTs,
						now,
						event.action === "removed" ? now : null,
					);
				return "recorded";
			}
			const key = [event.channel, event.ts] as const;
			if (event.action === "added") {
				this.#db
					.query(
						"UPDATE turn_feedback SET verdict = ?, removed_at = NULL, created_at = ?, last_event_ts = ? WHERE channel = ? AND ts = ?",
					)
					.run(event.verdict, now, event.eventTs, ...key);
			} else if (row.verdict === event.verdict) {
				this.#db
					.query("UPDATE turn_feedback SET removed_at = ?, last_event_ts = ? WHERE channel = ? AND ts = ?")
					.run(now, event.eventTs, ...key);
			} else {
				this.#db
					.query("UPDATE turn_feedback SET last_event_ts = ? WHERE channel = ? AND ts = ?")
					.run(event.eventTs, ...key);
			}
			return "recorded";
		})();
	}
}

/**
 * The current verdict of every turn set at or after `sinceMs`, newest first: per turn (`origin_key`, `op_ref`) the
 * live row (`removed_at IS NULL`) with the greatest `last_event_ts`, so reactions on several parts count once. Works
 * on a read-only handle; a database without the table has none.
 */
export function readTurnVerdicts(db: Database, sinceMs: number): TurnVerdict[] {
	const table = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'turn_feedback'").get();
	if (table === null) return [];
	const live = db
		.query(
			`SELECT origin_key, op_ref, inbound_id, verdict, last_event_ts, created_at FROM turn_feedback
				WHERE removed_at IS NULL AND (origin_key, op_ref) IN
					(SELECT origin_key, op_ref FROM turn_feedback WHERE removed_at IS NULL AND created_at >= ?)`,
		)
		.all(sinceMs) as Array<{
		origin_key: string;
		op_ref: string;
		inbound_id: number | null;
		verdict: FeedbackVerdict;
		last_event_ts: string;
		created_at: number;
	}>;
	const newest = new Map<string, (typeof live)[number]>();
	for (const row of live) {
		const key = JSON.stringify([row.origin_key, row.op_ref]);
		const held = newest.get(key);
		if (held === undefined || (slackTsMicros(row.last_event_ts) ?? 0) > (slackTsMicros(held.last_event_ts) ?? 0)) {
			newest.set(key, row);
		}
	}
	return [...newest.values()]
		.filter((row) => row.created_at >= sinceMs)
		.sort((a, b) => b.created_at - a.created_at)
		.map((row) => ({
			originKey: row.origin_key,
			opRef: row.op_ref,
			inboundId: row.inbound_id,
			verdict: row.verdict,
			at: row.created_at,
		}));
}
