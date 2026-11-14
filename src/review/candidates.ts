import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Logger } from "../log";
import { redact } from "../redact";

/**
 * Improvement-candidate ledger (doc/plans/candidate-ledger.md): the self-retro appends one `seen` line per problem to
 * `<workspace>/candidates.jsonl`; the daemon folds it deterministically (no model call), and a problem seen on
 * `minDays` distinct days inside the window becomes a candidate — a #log line in `log` mode, an owner approval card in
 * `card` mode. Approval only registers an experiment skeleton in experiments.md; the fix itself is done separately.
 */

export type CandidateKind = "rule" | "fix" | "persona";
export type CandidateStatus = "open" | "proposed" | "approved" | "rejected";

export type LedgerEvent =
	| {
			v: 1;
			ts: string;
			key: string;
			event: "seen";
			day: string;
			kind: CandidateKind;
			evidence: string;
			summary: string;
	  }
	| { v: 1; ts: string; key: string; event: "proposed"; via: "log" | "card"; ref?: string }
	| { v: 1; ts: string; key: string; event: "approved"; experiment: string }
	| { v: 1; ts: string; key: string; event: "rejected" };

export interface CandidatesSettings {
	enabled: boolean;
	mode: "log" | "card";
	minDays: number;
	windowDays: number;
	maxOpenCards: number;
	snoozeDays: number;
}

export const DEFAULT_CANDIDATES: CandidatesSettings = {
	enabled: true,
	mode: "log",
	minDays: 3,
	windowDays: 14,
	maxOpenCards: 1,
	snoozeDays: 7,
};

/** `config.candidates` with every unset field at its default. */
export function resolveCandidates(raw: Partial<CandidatesSettings> | undefined): CandidatesSettings {
	return { ...DEFAULT_CANDIDATES, ...raw };
}

export interface Candidate {
	key: string;
	/** From the latest `seen`. */
	kind: CandidateKind;
	summary: string;
	evidence: string;
	/** Distinct `day`s of `seen` inside the window, ascending. */
	days: string[];
	distinctDays: number;
	status: CandidateStatus;
	rejections: number;
	lastProposedAt?: number;
	lastRejectedAt?: number;
}

const DAY_MS = 86_400_000;
const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const KINDS: Record<string, true> = { rule: true, fix: true, persona: true };

function str(value: unknown): value is string {
	return typeof value === "string";
}

/** One line to an event, or undefined for anything malformed (wrong `v`, unknown event, missing field). */
function parseLine(line: string): LedgerEvent | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	if (r.v !== 1 || !str(r.ts) || Number.isNaN(Date.parse(r.ts)) || !str(r.key) || !KEY.test(r.key)) return undefined;
	const base = { v: 1 as const, ts: r.ts, key: r.key };
	switch (r.event) {
		case "seen":
			if (!str(r.day) || !DAY.test(r.day) || Number.isNaN(Date.parse(`${r.day}T00:00:00Z`))) return undefined;
			if (!str(r.kind) || KINDS[r.kind] !== true || !str(r.summary)) return undefined;
			if (r.evidence !== undefined && !str(r.evidence)) return undefined;
			return {
				...base,
				event: "seen",
				day: r.day,
				kind: r.kind as CandidateKind,
				evidence: r.evidence ?? "",
				summary: r.summary,
			};
		case "proposed":
			if (r.via !== "log" && r.via !== "card") return undefined;
			return { ...base, event: "proposed", via: r.via, ...(str(r.ref) ? { ref: r.ref } : {}) };
		case "approved":
			if (!str(r.experiment)) return undefined;
			return { ...base, event: "approved", experiment: r.experiment };
		case "rejected":
			return { ...base, event: "rejected" };
		default:
			return undefined;
	}
}

/** The ledger text to events in file order; blank, broken and other-version lines are skipped, never thrown. */
export function parseLedger(text: string): LedgerEvent[] {
	const events: LedgerEvent[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		const event = parseLine(line);
		if (event !== undefined) events.push(event);
	}
	return events;
}

/**
 * Folds events (file order) per key. Only `seen` days inside `now − windowDays` count, a day once. `approved` and
 * `rejected` are not undone by a later `seen`; `approved` is final, `rejected` can be proposed again (`dueCandidates`
 * decides when). A key without any `seen` is not a candidate.
 */
export function foldCandidates(
	events: LedgerEvent[],
	now: number,
	cfg: Pick<CandidatesSettings, "windowDays">,
): Candidate[] {
	const cutoff = now - cfg.windowDays * DAY_MS;
	const byKey = new Map<string, Candidate & { daySet: Set<string>; hasSeen: boolean }>();
	for (const event of events) {
		let cand = byKey.get(event.key);
		if (cand === undefined) {
			cand = {
				key: event.key,
				kind: "fix",
				summary: "",
				evidence: "",
				days: [],
				distinctDays: 0,
				status: "open",
				rejections: 0,
				daySet: new Set(),
				hasSeen: false,
			};
			byKey.set(event.key, cand);
		}
		if (cand.status === "approved") continue;
		const at = Date.parse(event.ts);
		switch (event.event) {
			case "seen":
				cand.hasSeen = true;
				cand.kind = event.kind;
				cand.summary = event.summary;
				cand.evidence = event.evidence;
				if (Date.parse(`${event.day}T00:00:00Z`) >= cutoff) cand.daySet.add(event.day);
				break;
			case "proposed":
				cand.status = "proposed";
				cand.lastProposedAt = at;
				break;
			case "approved":
				cand.status = "approved";
				break;
			case "rejected":
				cand.status = "rejected";
				cand.rejections += 1;
				cand.lastRejectedAt = at;
				break;
		}
	}
	const out: Candidate[] = [];
	for (const { daySet, hasSeen, ...cand } of byKey.values()) {
		if (!hasSeen) continue;
		cand.days = [...daySet].sort();
		cand.distinctDays = cand.days.length;
		out.push(cand);
	}
	return out;
}

/**
 * Candidates to raise now: open, or proposed with `snoozeDays` passed since the last proposal (a log notice or a
 * timed-out card), or rejected once with `snoozeDays` passed since the rejection — each with `distinctDays >= minDays`.
 * Approved and twice-rejected keys never return. Most days first, at most `maxOpenCards`. The caller guarantees no
 * candidate card is open.
 */
export function dueCandidates(
	folded: Candidate[],
	cfg: Pick<CandidatesSettings, "minDays" | "snoozeDays" | "maxOpenCards">,
	now: number,
): Candidate[] {
	const snooze = cfg.snoozeDays * DAY_MS;
	const eligible = folded.filter((cand) => {
		if (cand.distinctDays < cfg.minDays) return false;
		switch (cand.status) {
			case "open":
				return true;
			case "proposed":
				return cand.lastProposedAt !== undefined && now - cand.lastProposedAt >= snooze;
			case "rejected":
				return cand.rejections === 1 && cand.lastRejectedAt !== undefined && now - cand.lastRejectedAt >= snooze;
			default:
				return false;
		}
	});
	eligible.sort((a, b) => b.distinctDays - a.distinctDays || a.key.localeCompare(b.key));
	return eligible.slice(0, cfg.maxOpenCards);
}

/** Appends one event line; a ledger whose last line lacks its newline gets one first so the lines do not fuse. */
export function appendEvent(path: string, event: LedgerEvent): void {
	let prefix = "";
	if (existsSync(path)) {
		const text = readFileSync(path, "utf8");
		if (text.length > 0 && !text.endsWith("\n")) prefix = "\n";
	}
	appendFileSync(path, `${prefix}${JSON.stringify(event)}\n`);
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The #log line / card headline, redacted: `[개선 후보] <key> <kind> N일 반복 · 근거 … · <summary>`. */
export function buildCandidateNote(cand: Candidate): string {
	const evidence = cand.evidence === "" ? "" : ` · 근거 ${oneLine(cand.evidence)}`;
	return redact(
		`[개선 후보] ${cand.key} ${cand.kind} ${cand.distinctDays}일 반복 (${cand.days.join(", ")})${evidence} · ${oneLine(cand.summary)}`,
	);
}

/** `YYYY-MM-DD` of `ms` in `timeZone`. */
function dateIn(ms: number, timeZone: string): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

/** The next free `E-YYYYMMDD-NN` of that date in experiments.md text. */
export function nextExperimentId(text: string, date: string): string {
	const compact = date.replaceAll("-", "");
	let max = 0;
	for (const match of text.matchAll(new RegExp(`^## E-${compact}-(\\d+)`, "gm"))) {
		max = Math.max(max, Number(match[1]));
	}
	return `E-${compact}-${String(max + 1).padStart(2, "0")}`;
}

/**
 * Appends an experiment skeleton for an approved candidate; the existing bytes stay as they are (a missing final
 * newline is added after them, never inside). Returns the id used.
 */
export function appendExperiment(path: string, cand: Candidate, now: number, timeZone: string): string {
	const text = existsSync(path) ? readFileSync(path, "utf8") : "";
	const today = dateIn(now, timeZone);
	const id = nextExperimentId(text, today);
	const verdictDay = dateIn(now + 7 * DAY_MS, timeZone);
	const lead = text === "" ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
	const entry = [
		`## ${id} 개선 후보 ${cand.key} (${cand.kind})`,
		`- 바꾼 것: ${today}, 후보 승인·착수 전 (candidates.jsonl \`${cand.key}\`, ${cand.distinctDays}일 반복: ${cand.days.join(", ")})`,
		`- 가설: ${redact(oneLine(cand.summary))}`,
		`- 지표: candidates.jsonl 같은 key(\`${cand.key}\`) \`seen\` 재발 일수`,
		"- 반증선: 판정일까지 재발",
		"- 되돌리기: 착수 시 기입",
		`- 판정일: ${verdictDay}`,
		"- 판정: 대기",
		"",
	].join("\n");
	appendFileSync(path, `${lead}${entry}`);
	return id;
}

export interface CandidateRunDeps {
	ledgerPath: string;
	experimentsPath: string;
	settings: CandidatesSettings;
	timezone: string;
	now(): number;
	/** The #log channel line (the daemon log alone when there is no #log channel). */
	postLog(text: string): Promise<void>;
	/** Owner approval card (`ApprovalBroker.request`); undefined when no owner channel is known. */
	requestApproval?: ((summary: string) => Promise<"approved" | "denied" | "timeout">) | undefined;
	log: Logger;
}

export interface CandidateGate {
	frozen: boolean;
	draining: boolean;
	/** Candidate cards still waiting for the owner. */
	openCards: number;
}

/**
 * One pass: gates, fold, due, then a #log line (`log` mode) or approval cards (`card` mode, all awaited). Returns the
 * keys raised. A card's `proposed` line is written before it is shown, so a timeout leaves the ledger as it was.
 */
export async function runCandidateProposals(deps: CandidateRunDeps, gate: CandidateGate): Promise<string[]> {
	const { settings, log } = deps;
	if (!settings.enabled || gate.frozen || gate.draining || gate.openCards > 0) return [];
	if (!existsSync(deps.ledgerPath)) return [];
	const now = deps.now();
	const due = dueCandidates(
		foldCandidates(parseLedger(readFileSync(deps.ledgerPath, "utf8")), now, settings),
		settings,
		now,
	);
	if (due.length === 0) return [];
	const ts = (): string => new Date(deps.now()).toISOString();

	if (settings.mode === "log") {
		for (const cand of due) {
			await deps.postLog(buildCandidateNote(cand));
			appendEvent(deps.ledgerPath, { v: 1, ts: ts(), key: cand.key, event: "proposed", via: "log" });
			log.info("candidate_proposed", { key: cand.key, via: "log", days: cand.distinctDays });
		}
		return due.map((cand) => cand.key);
	}

	const request = deps.requestApproval;
	if (request === undefined) {
		log.warn("candidate_card_unroutable", { keys: due.map((cand) => cand.key).join(",") });
		return [];
	}
	await Promise.all(
		due.map(async (cand) => {
			appendEvent(deps.ledgerPath, { v: 1, ts: ts(), key: cand.key, event: "proposed", via: "card" });
			log.info("candidate_proposed", { key: cand.key, via: "card", days: cand.distinctDays });
			let verdict: "approved" | "denied" | "timeout";
			try {
				verdict = await request(
					`${buildCandidateNote(cand)}\n승인하면 experiments.md에 실험으로 등록합니다(등록만, 수선은 따로 합니다).`,
				);
			} catch (error) {
				log.warn("candidate_card_failed", { key: cand.key, error: String(error) });
				return;
			}
			if (verdict === "approved") {
				const experiment = appendExperiment(deps.experimentsPath, cand, deps.now(), deps.timezone);
				appendEvent(deps.ledgerPath, { v: 1, ts: ts(), key: cand.key, event: "approved", experiment });
				log.info("candidate_approved", { key: cand.key, experiment });
			} else if (verdict === "denied") {
				appendEvent(deps.ledgerPath, { v: 1, ts: ts(), key: cand.key, event: "rejected" });
				log.info("candidate_rejected", { key: cand.key });
			} else {
				log.info("candidate_card_timeout", { key: cand.key });
			}
		}),
	);
	return due.map((cand) => cand.key);
}
