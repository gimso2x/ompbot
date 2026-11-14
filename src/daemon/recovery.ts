import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { type DriverFactory, openOriginSession, sessionToResume } from "../core/mailbox";
import { COMMAND_OP_REF, isTurnPromptFor, promptTextOf } from "../core/types";
import type { Logger } from "../log";
import { MONITOR_ORIGIN_PREFIX } from "../monitors/ledger";
import { closingAnswer, turnAnswerParts } from "../omp/answers";
import { entryText, type OmpEntry, type OmpSessionDriver } from "../omp/driver";
import type { InboundRow, Store } from "../store/db";

export const INTERRUPTED_NOTICE = "[turn failed] interrupted_by_restart — 다시 보내 주세요";

/** `<home>/restart-cut.json`: the turns a planned restart (`apply` past its drain cut limit) cut off. */
export const RESTART_CUT_FILE = "restart-cut.json";
/** A cut record older than this belongs to an apply that died long ago: recovery ignores it. */
export const RESTART_CUT_MAX_AGE_MS = 3 * 60 * 60 * 1000;
/** `platformMessageId` prefix of a resume row (`cut-<original id>`); a turn of such a row is never resumed again. */
export const CONTINUE_ID_PREFIX = "cut-";
/** The one line the thread of a resumed turn gets instead of the interrupted notice. */
export const CONTINUE_NOTICE = "⏳ 재시작으로 끊긴 턴을 이어서 진행합니다.";
export const CONTINUE_PROMPT =
	"[자동 이어가기] ompbot 재시작으로 직전 턴이 중간에 끊겼습니다. 같은 요청을 이어서 끝내세요. 끊기기 직전 도구 호출은 " +
	"결과가 없거나 반쯤 실행됐을 수 있으니, 다시 하기 전에 상태(파일·프로세스·git)를 먼저 확인하세요. 외부로 나가는 " +
	"동작(push·게시·메일·API 쓰기)은 이미 됐는지 먼저 확인하고 확인할 수 없으면 오너에게 묻습니다. 승인 카드를 기다리던 " +
	"중이었다면 다시 요청하세요.";

/** One cut turn: its origin and op_ref, and the summary of the approval card it was waiting on (cancelled by the cut). */
export interface RestartCutEntry {
	originKey: string;
	opRef: string;
	approval?: string;
}

export interface RestartCut {
	/** When the daemon wrote it (ms). */
	at: number;
	applyStamp: string;
	opRefs: RestartCutEntry[];
}

/**
 * Writes the cut record whole: temp file (0600) → fsync → rename → fsync of the home directory. Throws on any
 * failure (the temp file is removed); the daemon answers `drain_cut` ok only after this returned.
 */
export function writeRestartCut(homeDir: string, cut: RestartCut): void {
	const target = join(homeDir, RESTART_CUT_FILE);
	const tmp = `${target}.tmp-${crypto.randomUUID()}`;
	try {
		const fd = openSync(tmp, "wx", 0o600);
		try {
			writeSync(fd, `${JSON.stringify(cut)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, target);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
	const dir = openSync(homeDir, "r");
	try {
		fsyncSync(dir);
	} finally {
		closeSync(dir);
	}
}

function parseRestartCut(text: string): RestartCut | undefined {
	const parsed: unknown = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const { at, applyStamp, opRefs } = parsed as Record<string, unknown>;
	if (typeof at !== "number" || !Number.isFinite(at) || typeof applyStamp !== "string" || !Array.isArray(opRefs))
		return undefined;
	const entries: RestartCutEntry[] = [];
	for (const item of opRefs) {
		if (typeof item !== "object" || item === null) return undefined;
		const { originKey, opRef, approval } = item as Record<string, unknown>;
		if (typeof originKey !== "string" || typeof opRef !== "string") return undefined;
		if (approval !== undefined && typeof approval !== "string") return undefined;
		entries.push({ originKey, opRef, ...(approval === undefined ? {} : { approval }) });
	}
	return { at, applyStamp, opRefs: entries };
}

/**
 * The cut turns by op_ref; empty without a file (crash, OOM, manual restart), for a file past
 * {@link RESTART_CUT_MAX_AGE_MS}, and for one that cannot be parsed (`restart_cut_unreadable`). Never deletes it: the
 * apply that wrote it does, so a rollback restart judges its cut turns by the same record.
 */
function readRestartCut(homeDir: string, now: number, log: Logger): Map<string, RestartCutEntry> {
	const byOpRef = new Map<string, RestartCutEntry>();
	const path = join(homeDir, RESTART_CUT_FILE);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as { code?: unknown }).code !== "ENOENT")
			log.warn("restart_cut_unreadable", { path, error: String(error) });
		return byOpRef;
	}
	let cut: RestartCut | undefined;
	try {
		cut = parseRestartCut(text);
	} catch (error) {
		log.warn("restart_cut_unreadable", { path, error: String(error) });
		return byOpRef;
	}
	if (cut === undefined) {
		log.warn("restart_cut_unreadable", { path, error: "unexpected shape" });
		return byOpRef;
	}
	if (now - cut.at > RESTART_CUT_MAX_AGE_MS) {
		log.info("restart_cut_stale", { path, age_ms: now - cut.at, apply: cut.applyStamp });
		return byOpRef;
	}
	for (const entry of cut.opRefs) byOpRef.set(entry.opRef, entry);
	return byOpRef;
}

/** The resume prompt: the fixed text, the cancelled approval card, then one line per git index lock left behind. */
export function continuePrompt(approval: string | undefined, lockFiles: readonly string[]): string {
	const lines = [CONTINUE_PROMPT];
	if (approval !== undefined) {
		const summary = approval.replace(/\s+/g, " ").trim().slice(0, 120);
		lines.push(`직전 승인 카드(${summary})는 취소됐습니다`);
	}
	for (const lock of lockFiles) lines.push(`잠금 파일 있음: ${lock} — 다른 git 프로세스가 없는지 확인한 뒤 처리하세요`);
	return lines.join("\n");
}

export interface RecoveryDeps {
	store: Store;
	driverFactory: DriverFactory;
	log: Logger;
	/** Test seam for the mutation check: which `get_entries.since` value a row is looked up with. Default: its `entry_cursor`. */
	cursorOf?: (row: InboundRow) => string | null | undefined;
	/** Home holding {@link RESTART_CUT_FILE}; absent, no turn is resumed (every unfinished one is interrupted). */
	homeDir?: string;
	now?: () => number;
	/** Repositories whose `.git/index.lock` a resumed turn of this origin is told about (turnSnapshot repos, its cwd). */
	lockRepos?: (originKey: string) => readonly string[];
}

export interface RecoveryResult {
	answered: number;
	interrupted: number;
	/** Cut turns resumed with a `cut-<id>` row instead of the interrupted notice. */
	continued: number;
}

/**
 * Answer parts of a finished turn after the prompt's user entry, or undefined when the turn did not finish (its last
 * message is not an assistant stop) or has no answer text. Same rule as the live mailbox: every stop-ended answer of
 * the turn, or only the last text for a monitor origin.
 */
function finalAnswerParts(entries: readonly OmpEntry[], promptText: string, lastOnly: boolean): string[] | undefined {
	const promptAt = entries.findIndex(
		(entry) =>
			entry.type === "message" && entry.message?.role === "user" && isTurnPromptFor(entryText(entry), promptText),
	);
	if (promptAt === -1) return undefined;
	const turn = entries.slice(promptAt + 1);
	const last = turn.filter((entry) => entry.type === "message").at(-1);
	if (last?.message?.role !== "assistant" || last.message.stopReason !== "stop") return undefined;
	if (lastOnly) {
		const text = entryText(last);
		return text === "" ? undefined : [text];
	}
	const parts = turnAnswerParts(turn);
	return parts.length === 0 ? undefined : parts;
}

/**
 * Startup rule (2): every `dispatched` row of the dead process either has its final answer in the omp session after
 * the row's `entry_cursor` (-> answered + delivery) or gets exactly one interrupted notice. Prompts are never resent.
 * Exception: a conversation turn the planned restart cut (its op_ref is in {@link RESTART_CUT_FILE}) gets one resume
 * row `cut-<id>` in the same thread and {@link CONTINUE_NOTICE} instead — once: a turn of a resume row, a monitor
 * origin, a command op (`COMMAND_OP_REF`: lane, task, chat command) or an op_ref not in a fresh record is interrupted
 * as before.
 * Rows that were steered into the same turn share an `op_ref` and are settled together by the first row's lookup.
 */
export async function recoverDispatched(deps: RecoveryDeps): Promise<RecoveryResult> {
	const { store, log } = deps;
	const result: RecoveryResult = { answered: 0, interrupted: 0, continued: 0 };
	// Read on the first unfinished turn only: a boot with nothing to settle never looks at (or warns about) the file.
	let cutTurns: Map<string, RestartCutEntry> | undefined;
	const cutTurnsOf = (): Map<string, RestartCutEntry> => {
		const { homeDir } = deps;
		if (homeDir === undefined) return new Map();
		cutTurns ??= readRestartCut(homeDir, (deps.now ?? Date.now)(), log);
		return cutTurns;
	};
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
				const expected = sessionToResume(origin);
				driver = deps.driverFactory(originKey, origin.sessionDir);
				await driver.start();
				const check = await openOriginSession(driver, origin, expected);
				// Log only: every settled row below already gets its own answer or interrupted notice in the thread.
				if (check.mismatch) {
					log.warn("session_resume_mismatch", { origin: originKey, expected: check.expected, actual: check.actual });
				}
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
				let parts: string[] | undefined;
				const cursor = (deps.cursorOf ?? ((row) => row.entryCursor))(lead);
				const monitor = originKey.startsWith(MONITOR_ORIGIN_PREFIX);
				if (driver && cursor) {
					try {
						parts = finalAnswerParts((await driver.entriesSince(cursor)).entries, promptTextOf(lead.textRef), monitor);
					} catch (error) {
						log.warn("recovery_cursor_failed", { origin: originKey, id: lead.platformMessageId, error: String(error) });
					}
				} else if (openError !== undefined) {
					log.warn("recovery_open_failed", { origin: originKey, error: String(openError) });
				}
				const resumed =
					parts === undefined &&
					!monitor &&
					!COMMAND_OP_REF.test(opRef) &&
					!group.some((row) => row.platformMessageId.startsWith(CONTINUE_ID_PREFIX))
						? cutTurnsOf().get(opRef)
						: undefined;
				if (parts === undefined && resumed !== undefined) {
					const id = `${CONTINUE_ID_PREFIX}${lead.platformMessageId}`;
					const locks = [...new Set(deps.lockRepos?.(originKey) ?? [])]
						.map((repo) => join(repo, ".git", "index.lock"))
						.filter((lock) => existsSync(lock));
					store.recordContinuation({
						originKey,
						opRef,
						threadRef: lead.threadRef,
						notice: CONTINUE_NOTICE,
						platformMessageId: id,
						textRef: continuePrompt(resumed.approval, locks),
					});
					result.continued += 1;
					log.info("recovery_continued", { origin: originKey, opRef, id });
				} else if (parts === undefined) {
					store.recordTurnFailure({ originKey, opRef, threadRef: lead.threadRef, notice: INTERRUPTED_NOTICE });
					result.interrupted += 1;
					log.info("recovery_interrupted", { origin: originKey, id: lead.platformMessageId, opRef });
				} else {
					// Like the live turn end: what the dead process already sent as interim deliveries is not sent again.
					const answer = monitor
						? { body: parts.join("\n\n"), whole: parts.join("\n\n") }
						: closingAnswer(parts, store.interimBodies(originKey, opRef));
					store.recordAnswer({
						originKey,
						opRef,
						threadRef: lead.threadRef,
						parts: [answer.body],
						answer: answer.whole,
					});
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
