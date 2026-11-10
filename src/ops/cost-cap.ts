// Cost ceiling (`costCap` in config): the ledger day totals and the texts of the brake, its owner notice and `!budget`.
// The numbers are omp's own price conversion (`usage.cost.total`), never the provider's bill — an OAuth subscription
// turn is still priced here, so the ceiling is a runaway brake, not an accounting figure.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Store } from "../store/db";
import { kstDay } from "../tasks/docs";
import { usageOf } from "./usage";

/** Sub-agents of sub-agents are read this deep for a turn's transcript cost (the dashboard trace uses the same). */
const SUB_AGENT_DEPTH = 2;

/** One turn's priced model calls, read from the session files the turn wrote. */
export interface WindowCost {
	cost: number;
	calls: number;
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** `$12.34` — every owner-facing cost text of this module. */
export function usd(value: number): string {
	return `$${value.toFixed(2)}`;
}

/**
 * The `usage_daily` key of `ms`: the KST calendar day (`YYYYMMDD`). The daily ceiling and its `!budget off` flag both
 * key on it, so midnight KST clears the day's spend and any off flag together.
 */
export function ledgerDay(ms: number): string {
	return kstDay(ms);
}

/**
 * The cost of one turn, from the session files it wrote (`src/ops/usage.ts` rules: assistant `message.usage` plus
 * `model_usage` records). The turn's own session counts the entries after `afterEntryId` (the leaf read right before
 * the prompt), so an earlier turn's spend never repeats; sub-agent transcripts (`<stem>/<name>.jsonl`, the files omp
 * writes beside a session) count the records whose `timestamp` falls inside the turn window. Without a cursor (an
 * empty session) the turn's own records are windowed by `timestamp` too.
 *
 * Rejects when the session file is gone or holds no such entry: the caller answers with the live turn total and logs
 * `usage_daily_failed` rather than counting a guess.
 */
export async function sessionWindowCost(input: {
	sessionFile: string;
	afterEntryId: string | null;
	from: number;
	to: number;
}): Promise<WindowCost> {
	const text = await readFile(input.sessionFile, "utf8");
	const records = text.split("\n").flatMap((line) => {
		if (line.trim() === "") return [];
		try {
			return [JSON.parse(line) as unknown];
		} catch {
			return [];
		}
	});
	const inWindow = (record: unknown): boolean => {
		if (typeof record !== "object" || record === null || !("timestamp" in record)) return false;
		const at: unknown = record.timestamp;
		if (typeof at !== "string") return false;
		const ms = Date.parse(at);
		return Number.isFinite(ms) && ms >= input.from && ms <= input.to;
	};
	let start = 0;
	if (input.afterEntryId !== null) {
		const index = records.findIndex((record) => {
			if (typeof record !== "object" || record === null || !("id" in record)) return false;
			return record.id === input.afterEntryId;
		});
		if (index === -1) throw new Error(`entry ${input.afterEntryId} not in ${input.sessionFile}`);
		start = index + 1;
	}
	const totals: WindowCost = { cost: 0, calls: 0 };
	for (const [index, record] of records.entries()) {
		const usage = usageOf(record);
		if (usage === undefined) continue;
		if (index < start) continue;
		if (input.afterEntryId === null && !inWindow(record)) continue;
		totals.calls += 1;
		totals.cost += num(usage.cost?.total);
	}

	const stem = input.sessionFile.replace(/\.jsonl$/, "");
	if (stem === input.sessionFile || !existsSync(stem)) return totals;
	for (const sub of subAgentFiles(stem, 0)) {
		for (const usage of await subAgentUsage(sub, inWindow)) {
			totals.calls += 1;
			totals.cost += usage;
		}
	}
	return totals;
}

/** The `<stem>/<name>.jsonl` files of a session, down to `SUB_AGENT_DEPTH`. */
function subAgentFiles(dir: string, depth: number): string[] {
	if (depth >= SUB_AGENT_DEPTH || !existsSync(dir)) return [];
	const out: string[] = [];
	for (const rel of new Bun.Glob("**/*.jsonl").scanSync({ cwd: dir })) {
		const file = join(dir, rel);
		out.push(file);
		const nested = file.replace(/\.jsonl$/, "");
		if (existsSync(nested)) out.push(...subAgentFiles(nested, depth + 1));
	}
	return out;
}

/** The costs of one sub-agent transcript's model calls whose `timestamp` is inside the turn window. */
async function subAgentUsage(file: string, inWindow: (record: unknown) => boolean): Promise<number[]> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch {
		return []; // gone between listing and reading (gc, a rotated transcript)
	}
	const costs: number[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (!inWindow(record)) continue;
		const usage = usageOf(record);
		if (usage !== undefined) costs.push(num(usage.cost?.total));
	}
	return costs;
}

/** The priced cost of one assistant message (`usage.cost.total`); 0 for anything else. */
export function messageCost(message: unknown): number {
	if (typeof message !== "object" || message === null) return 0;
	const { role, usage } = message as { role?: unknown; usage?: unknown };
	if (role !== "assistant" || typeof usage !== "object" || usage === null) return 0;
	const costs: unknown = "cost" in usage ? usage.cost : undefined;
	if (typeof costs !== "object" || costs === null || !("total" in costs)) return 0;
	return num(costs.total);
}

/** Multiple of `turnUsd` at which the turn is stopped instead of steered. */
export const TURN_STOP_RATIO = 1.5;

/** Failure-reason prefix of that stop; `#onFinal` reads it as a spend brake, not a broken turn. */
export const COST_CAP_STOP_PREFIX = "cost_cap: ";

/** The steer omp receives when a turn reaches the turn ceiling: wrap up and answer now. */
export function turnCapSteerText(cap: number): string {
	return `비용 상한(${usd(cap)})에 닿았습니다. 지금까지 한 일과 남은 일을 정리해 바로 답하고 끝내세요.`;
}

/** The failure reason of a turn stopped at 1.5x the ceiling (`cost_cap`, beside `stuck-loop`). */
export function turnCapStopReason(cap: number, spent: number): string {
	return `${COST_CAP_STOP_PREFIX}비용 상한 ${usd(cap)}의 ${TURN_STOP_RATIO}배를 넘어 턴을 멈췄습니다(이번 턴 ${usd(spent)})`;
}

/** The owner notice of the first daily-cap breach; the key `cost-cap-daily:<day>` keeps it to one a day. */
export function dailyCapNotice(cap: number, cost: number): string {
	return [
		`⛔ 오늘 비용(정가 환산) ${usd(cost)}가 하루 상한 ${usd(cap)}를 넘어 모니터를 멈췄습니다.`,
		"자정(KST)에 풀립니다. 지금 풀려면 `!budget off`.",
	].join("\n");
}

/** Ledger key of the day's breach notice (set once, so the owner hears it once a day). */
export function dailyNoticeKey(day: string): string {
	return `cost-cap-daily:${day}`;
}

/** Ledger key of the day's `!budget off` flag; the day inside the key is why KST midnight lifts it by itself. */
export function dailyOffKey(day: string): string {
	return `cost-cap-off:${day}`;
}

/** The day's ceiling and what the ledger says about it: the one state both the scheduler hook and `!budget` read. */
export interface DailyBudgetState {
	day: string;
	cost: number;
	/** `costCap.dailyUsd`; undefined = no daily ceiling configured. */
	cap: number | undefined;
	/** `!budget off` for this day. */
	off: boolean;
	/** The day's breach notice already went out. */
	notified: boolean;
}

/**
 * Reads the day's total and both flags from the ledger alone, so a restarted daemon sees the same state (and a
 * `!budget off` typed before the restart still holds).
 */
export function dailyBudgetState(input: {
	store: Pick<Store, "getCursor" | "dailyCost">;
	day: string;
	cap: number | undefined;
}): DailyBudgetState {
	return {
		day: input.day,
		cost: input.store.dailyCost(input.day),
		cap: input.cap,
		off: input.store.getCursor(dailyOffKey(input.day)) !== undefined,
		notified: input.store.getCursor(dailyNoticeKey(input.day)) !== undefined,
	};
}

/**
 * The scheduler's `budgetExceeded` value: set while the day's total has reached the ceiling and the day is not
 * switched off. `undefined` (no ceiling, still under it, or `!budget off`) lets monitors fire as usual.
 */
export function budgetBreach(state: DailyBudgetState): { day: string; cost: number; cap: number } | undefined {
	if (state.cap === undefined || state.off) return undefined;
	return state.cost >= state.cap ? { day: state.day, cost: state.cost, cap: state.cap } : undefined;
}

/** `!budget` with no argument: today's total, its top origins and both ceilings. */
export function renderBudget(input: {
	day: string;
	total: number;
	top: ReadonlyArray<{ originKey: string; cost: number }>;
	turnCap: number | undefined;
	dailyCap: number | undefined;
	off: boolean;
}): string {
	const cap = (value: number | undefined): string => (value === undefined ? "꺼짐" : usd(value));
	const lines = [
		`오늘(${input.day}) 비용(정가 환산) ${usd(input.total)} · 상한 턴 ${cap(input.turnCap)} / 하루 ${cap(input.dailyCap)}`,
	];
	if (input.top.length > 0) {
		lines.push(`상위 오리진: ${input.top.map((row) => `${row.originKey} ${usd(row.cost)}`).join(" · ")}`);
	} else {
		lines.push("상위 오리진: 오늘 집계된 턴이 없습니다");
	}
	if (input.dailyCap === undefined) {
		lines.push("하루 상한이 꺼져 있어 모니터를 멈추지 않습니다.");
	} else if (input.off) {
		lines.push("오늘은 하루 상한을 껐습니다(자정에 풀립니다). 다시 켜려면 `!budget on`.");
	} else if (input.total >= input.dailyCap) {
		lines.push("하루 상한을 넘어 모니터가 멈춰 있습니다. 지금 풀려면 `!budget off`.");
	} else {
		lines.push(`하루 상한까지 ${usd(input.dailyCap - input.total)} 남았습니다. 하루 상한을 끄려면 \`!budget off\`.`);
	}
	return lines.join("\n");
}
