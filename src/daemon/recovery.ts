import { type DriverFactory, openOriginSession } from "../core/mailbox";
import { promptTextOf } from "../core/types";
import type { Logger } from "../log";
import { MONITOR_ORIGIN_PREFIX } from "../monitors/ledger";
import { turnAnswer } from "../omp/answers";
import { entryText, type OmpEntry, type OmpSessionDriver } from "../omp/driver";
import type { InboundRow, Store } from "../store/db";

export const INTERRUPTED_NOTICE = "[turn failed] interrupted_by_restart — 다시 보내 주세요";

export interface RecoveryDeps {
	store: Store;
	driverFactory: DriverFactory;
	log: Logger;
	/** Test seam for the mutation check: which `get_entries.since` value a row is looked up with. Default: its `entry_cursor`. */
	cursorOf?: (row: InboundRow) => string | null | undefined;
}

export interface RecoveryResult {
	answered: number;
	interrupted: number;
}

/**
 * Answer of a finished turn after the prompt's user entry, or undefined when the turn did not finish (its last message
 * is not an assistant stop). Same rule as the live mailbox: every stop-ended answer of the turn, or only the last text
 * for a monitor origin.
 */
function finalAnswer(entries: readonly OmpEntry[], promptText: string, lastOnly: boolean): string | undefined {
	const promptAt = entries.findIndex(
		(entry) => entry.type === "message" && entry.message?.role === "user" && entryText(entry) === promptText,
	);
	if (promptAt === -1) return undefined;
	const turn = entries.slice(promptAt + 1);
	const last = turn.filter((entry) => entry.type === "message").at(-1);
	if (last?.message?.role !== "assistant" || last.message.stopReason !== "stop") return undefined;
	if (lastOnly) {
		const text = entryText(last);
		return text === "" ? undefined : text;
	}
	return turnAnswer(turn);
}

/**
 * Startup rule (2): every `dispatched` row of the dead process either has its final answer in the omp session after
 * the row's `entry_cursor` (-> answered + delivery) or gets exactly one interrupted notice. Prompts are never resent.
 * Rows that were steered into the same turn share an `op_ref` and are settled together by the first row's lookup.
 */
export async function recoverDispatched(deps: RecoveryDeps): Promise<RecoveryResult> {
	const { store, log } = deps;
	const result: RecoveryResult = { answered: 0, interrupted: 0 };
	const byOrigin = new Map<string, Map<string, InboundRow[]>>();
	for (const row of store.listInbound({ state: "dispatched" })) {
		const ops = byOrigin.get(row.originKey) ?? new Map<string, InboundRow[]>();
		const group = ops.get(row.opRef ?? `row:${row.platformMessageId}`) ?? [];
		group.push(row);
		ops.set(row.opRef ?? `row:${row.platformMessageId}`, group);
		byOrigin.set(row.originKey, ops);
	}

	for (const [originKey, ops] of byOrigin) {
		const origin = store.getOrigin(originKey);
		let driver: OmpSessionDriver | undefined;
		let openError: unknown;
		if (origin) {
			try {
				driver = deps.driverFactory(originKey, origin.sessionDir);
				await driver.start();
				await openOriginSession(driver, origin);
			} catch (error) {
				openError = error;
				await driver?.stop().catch(() => undefined);
				driver = undefined;
			}
		}
		try {
			for (const group of ops.values()) {
				const lead = group[0];
				if (!lead) continue;
				const opRef = lead.opRef ?? `row:${lead.platformMessageId}`;
				let text: string | undefined;
				const cursor = (deps.cursorOf ?? ((row) => row.entryCursor))(lead);
				if (driver && cursor) {
					try {
						text = finalAnswer(
							(await driver.entriesSince(cursor)).entries,
							promptTextOf(lead.textRef),
							originKey.startsWith(MONITOR_ORIGIN_PREFIX),
						);
					} catch (error) {
						log.warn("recovery_cursor_failed", { origin: originKey, id: lead.platformMessageId, error: String(error) });
					}
				} else if (openError !== undefined) {
					log.warn("recovery_open_failed", { origin: originKey, error: String(openError) });
				}
				if (text === undefined) {
					store.recordTurnFailure({ originKey, opRef, threadRef: lead.threadRef, notice: INTERRUPTED_NOTICE });
					result.interrupted += 1;
					log.info("recovery_interrupted", { origin: originKey, id: lead.platformMessageId, opRef });
				} else {
					store.recordAnswer({ originKey, opRef, threadRef: lead.threadRef, parts: [text] });
					result.answered += 1;
					log.info("recovery_answered", { origin: originKey, id: lead.platformMessageId, opRef });
				}
			}
		} finally {
			await driver?.stop().catch(() => undefined);
		}
	}
	return result;
}
