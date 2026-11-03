// `/usage-ompbot`: token and cost totals read straight from the omp session JSONL files ompbot keeps — no ledger
// table, no omp call. Assistant messages carry `message.usage`; extension model calls are `model_usage` records with
// a top-level `usage` (same fields). Sessions gc already removed are not counted, and the answer says so.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface UsageTotals {
	/** Model calls counted (records carrying usage). */
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costTotal: number;
	/** Files read (missing paths are skipped). */
	files: number;
	/** Non-empty lines that were not JSON. */
	badLines: number;
}

interface UsageFields {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	cost?: { total?: unknown };
}

const EPOCH_FILE = /^e[1-9][0-9]*\//;

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** The usage block of one session record, if it is a model call: an assistant message or a `model_usage` record. */
function usageOf(record: unknown): UsageFields | undefined {
	if (typeof record !== "object" || record === null) return undefined;
	const r = record as { type?: unknown; message?: { role?: unknown; usage?: unknown }; usage?: unknown };
	const usage =
		r.type === "message" && r.message?.role === "assistant"
			? r.message.usage
			: r.type === "model_usage"
				? r.usage
				: undefined;
	return typeof usage === "object" && usage !== null ? (usage as UsageFields) : undefined;
}

export async function summarizeSessionFiles(paths: readonly string[]): Promise<UsageTotals> {
	const totals: UsageTotals = {
		calls: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		costTotal: 0,
		files: 0,
		badLines: 0,
	};
	for (const path of paths) {
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch {
			continue; // gone between listing and reading (gc, a rotated session)
		}
		totals.files += 1;
		for (const line of text.split("\n")) {
			if (line.trim() === "") continue;
			let record: unknown;
			try {
				record = JSON.parse(line);
			} catch {
				totals.badLines += 1;
				continue;
			}
			const usage = usageOf(record);
			if (usage === undefined) continue;
			totals.calls += 1;
			totals.input += num(usage.input);
			totals.output += num(usage.output);
			totals.cacheRead += num(usage.cacheRead);
			totals.cacheWrite += num(usage.cacheWrite);
			totals.costTotal += num(usage.cost?.total);
		}
	}
	return totals;
}

/** One conversation: every epoch directory (`e<N>/`) of the origin directory, sub-agent transcripts included. */
export function conversationSessionFiles(originDir: string): string[] {
	if (!existsSync(originDir)) return [];
	return [...new Bun.Glob("**/*.jsonl").scanSync({ cwd: originDir })]
		.filter((rel) => EPOCH_FILE.test(rel))
		.map((rel) => join(originDir, rel));
}

/** Every kept session file of the host: `<home>/sessions/**\/*.jsonl`. */
export function allSessionFiles(sessionsRoot: string): string[] {
	if (!existsSync(sessionsRoot)) return [];
	return [...new Bun.Glob("**/*.jsonl").scanSync({ cwd: sessionsRoot })].map((rel) => join(sessionsRoot, rel));
}

function usageLine(totals: UsageTotals): string {
	const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
	const cachePct = prompt === 0 ? 0 : Math.round((totals.cacheRead / prompt) * 100);
	const n = (value: number): string => value.toLocaleString("en-US");
	return `모델 호출 ${n(totals.calls)}회 · 입력 ${n(totals.input)} (캐시 읽기 ${cachePct}%) · 출력 ${n(totals.output)} · 비용 $${totals.costTotal.toFixed(2)}`;
}

export function renderUsage(conversation: UsageTotals, overall: UsageTotals): string {
	return [
		`이 대화: ${usageLine(conversation)}`,
		`전체(보관 중인 세션 파일 ${overall.files.toLocaleString("en-US")}개): ${usageLine(overall)}`,
		"보관 중인 세션 기준이라 gc로 지운 옛 세션은 빠집니다.",
	].join("\n");
}
