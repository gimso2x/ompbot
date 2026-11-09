import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { FEEDBACK_DAYS, type FeedbackTurn, readFeedbackSummary } from "../dashboard/snapshot";

export const FEEDBACK_USAGE = `  feedback [--days N] [--json]   the owner's 👎 turns of the last N days (default ${FEEDBACK_DAYS}), newest first, one per
                                 turn: time, origin, inbound id, masked request line, waterfall path; read-only
`;

/** `ompbot feedback`: 👎 turns from a read-only handle on the ledger (a home without one has none). */
export function feedbackCommand(args: string[], homeDir: string): number {
	const { values } = parseArgs({ args, options: { days: { type: "string" }, json: { type: "boolean" } } });
	const days = values.days === undefined ? FEEDBACK_DAYS : Number(values.days);
	if (!Number.isInteger(days) || days < 1) {
		process.stderr.write(`feedback: --days takes a whole number of days (1 or more)\n${FEEDBACK_USAGE}`);
		return 2;
	}
	const dbPath = join(homeDir, "ompbot.db");
	let turns: FeedbackTurn[] = [];
	if (existsSync(dbPath)) {
		const db = new Database(dbPath, { readonly: true, strict: true });
		try {
			turns = readFeedbackSummary(db, Date.now(), { days }).recentDown;
		} finally {
			db.close();
		}
	}
	const listed = turns.map((turn) => ({
		at: turn.at,
		originKey: turn.originKey,
		inboundId: turn.inboundId,
		preview: turn.preview,
		// The dashboard page opens this turn's waterfall; `trace` is the same waterfall as JSON.
		waterfall: turn.inboundId === null ? null : `?view=turns&item=${turn.inboundId}`,
		trace: turn.inboundId === null ? null : `api/turn/${turn.inboundId}/trace`,
	}));
	if (values.json === true) {
		process.stdout.write(`${JSON.stringify(listed)}\n`);
	} else if (listed.length === 0) {
		process.stdout.write(`no 👎 turns in the last ${days} days\n`);
	} else {
		for (const turn of listed) {
			process.stdout.write(
				`${turn.at}  ${turn.originKey}  #${turn.inboundId ?? "-"}  ${turn.preview ?? "-"}  ${turn.waterfall ?? "-"}\n`,
			);
		}
	}
	return 0;
}
