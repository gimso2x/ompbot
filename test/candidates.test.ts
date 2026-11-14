import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../src/config";
import { createLogger } from "../src/log";
import { redact } from "../src/redact";
import {
	appendEvent,
	buildCandidateNote,
	type CandidateGate,
	type CandidateRunDeps,
	type CandidatesSettings,
	DEFAULT_CANDIDATES,
	dueCandidates,
	foldCandidates,
	type LedgerEvent,
	parseLedger,
	resolveCandidates,
	runCandidateProposals,
} from "../src/review/candidates";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-12T00:00:00Z");
const S = DEFAULT_CANDIDATES;

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-cand-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const iso = (ms: number): string => new Date(ms).toISOString();
const dayOf = (ms: number): string => iso(ms).slice(0, 10);

function seen(key: string, day: string, extra: Partial<LedgerEvent> = {}): LedgerEvent {
	return {
		v: 1,
		ts: `${day}T14:30:00Z`,
		key,
		event: "seen",
		day,
		kind: "fix",
		evidence: `reflections/${day}.md#문제1`,
		summary: `${key} 반복`,
		...extra,
	} as LedgerEvent;
}

/** `n` distinct recent days (yesterday backwards) of `key`. */
function seenDays(key: string, n: number): LedgerEvent[] {
	return Array.from({ length: n }, (_, i) => seen(key, dayOf(NOW - (i + 1) * DAY)));
}

const fold = (events: LedgerEvent[], now = NOW, cfg: Partial<CandidatesSettings> = {}) =>
	foldCandidates(events, now, { ...S, ...cfg });
const due = (events: LedgerEvent[], now = NOW, cfg: Partial<CandidatesSettings> = {}) =>
	dueCandidates(fold(events, now, cfg), { ...S, ...cfg }, now).map((c) => c.key);

const silentLog = createLogger({ sink: () => {}, clock: { now: () => NOW }, redact });

interface Harness {
	deps: CandidateRunDeps;
	notes: string[];
	cards: string[];
}

function harness(
	events: LedgerEvent[],
	settings: Partial<CandidatesSettings> = {},
	verdict?: (ledgerAtCard: string) => "approved" | "denied" | "timeout",
): Harness {
	const ledgerPath = join(dir, "candidates.jsonl");
	writeFileSync(ledgerPath, events.map((e) => `${JSON.stringify(e)}\n`).join(""));
	const notes: string[] = [];
	const cards: string[] = [];
	const deps: CandidateRunDeps = {
		ledgerPath,
		experimentsPath: join(dir, "experiments.md"),
		settings: { ...S, ...settings },
		timezone: "Asia/Seoul",
		now: () => NOW,
		postLog: async (text) => {
			notes.push(text);
		},
		requestApproval: async (summary) => {
			cards.push(summary);
			return verdict === undefined ? "timeout" : verdict(readFileSync(ledgerPath, "utf8"));
		},
		log: silentLog,
	};
	return { deps, notes, cards };
}

const OPEN: CandidateGate = { frozen: false, draining: false, openCards: 0 };
const ledger = (h: Harness): LedgerEvent[] => parseLedger(readFileSync(h.deps.ledgerPath, "utf8"));

describe("parse", () => {
	test("parse: empty file, broken lines and other versions are skipped without throwing", () => {
		expect(parseLedger("")).toEqual([]);
		const good = seen("backfill-dead-origin", "2026-11-11");
		const text = [
			"",
			"{not json",
			JSON.stringify({ ...good, v: 2 }),
			JSON.stringify({ ...good, key: "Not Kebab" }),
			JSON.stringify({ ...good, event: "exploded" }),
			JSON.stringify({ ...good, kind: "other" }),
			JSON.stringify({ ...good, day: "11/11" }),
			"[1,2]",
			"null",
			JSON.stringify(good),
			'{"v":1,"ts":"2026-11-12T00:00:00Z","key":"backfill-dead-origin","event":"rejected"}',
			"   ",
		].join("\n");
		expect(() => parseLedger(text)).not.toThrow();
		const events = parseLedger(text);
		expect(events.map((e) => e.event)).toEqual(["seen", "rejected"]);
		expect(events[0]).toEqual(good);
	});
});

describe("distinct days", () => {
	test("distinct days: same day twice is 1, three days are 3, days outside windowDays are not counted", () => {
		const [cand] = fold([seen("a", "2026-11-11"), seen("a", "2026-11-11")]);
		expect(cand?.distinctDays).toBe(1);
		const [three] = fold(seenDays("a", 3));
		expect(three?.distinctDays).toBe(3);
		const old = [seen("a", dayOf(NOW - 20 * DAY)), seen("a", dayOf(NOW - 21 * DAY)), seen("a", dayOf(NOW - DAY))];
		const [windowed] = fold(old);
		expect(windowed?.distinctDays).toBe(1);
		expect(windowed?.days).toEqual([dayOf(NOW - DAY)]);
	});
});

describe("due", () => {
	const proposed = (key: string, at: number, via: "log" | "card" = "log"): LedgerEvent => ({
		v: 1,
		ts: iso(at),
		key,
		event: "proposed",
		via,
	});
	const rejected = (key: string, at: number): LedgerEvent => ({ v: 1, ts: iso(at), key, event: "rejected" });

	test("due: below minDays, approved, snoozed proposed/rejected and twice-rejected keys are left out", () => {
		expect(due(seenDays("a", 2))).toEqual([]);
		expect(due([...seenDays("a", 3)])).toEqual(["a"]);
		expect(
			due([...seenDays("a", 3), { v: 1, ts: iso(NOW - DAY), key: "a", event: "approved", experiment: "E-1" }]),
		).toEqual([]);
		expect(due([...seenDays("a", 3), proposed("a", NOW - 6 * DAY)])).toEqual([]);
		expect(due([...seenDays("a", 3), rejected("a", NOW - 6 * DAY)])).toEqual([]);
		const twice = [
			...seenDays("a", 3),
			rejected("a", NOW - 30 * DAY),
			proposed("a", NOW - 20 * DAY, "card"),
			rejected("a", NOW - 19 * DAY),
		];
		expect(due(twice)).toEqual([]);
	});

	test("due: snoozed-out proposed (after a log note or a timed-out card) and once-rejected come back", () => {
		expect(due([...seenDays("a", 3), proposed("a", NOW - 7 * DAY, "log")])).toEqual(["a"]);
		expect(due([...seenDays("a", 3), proposed("a", NOW - 8 * DAY, "card")])).toEqual(["a"]);
		expect(due([...seenDays("a", 3), rejected("a", NOW - 7 * DAY)])).toEqual(["a"]);
	});

	test("due: most days first, at most maxOpenCards", () => {
		const events = [...seenDays("three", 3), ...seenDays("five", 5), ...seenDays("four", 4)];
		expect(due(events)).toEqual(["five"]);
		expect(due(events, NOW, { maxOpenCards: 2 })).toEqual(["five", "four"]);
	});
});

describe("status sticks", () => {
	test("status sticks: a seen after approved leaves it approved", () => {
		const events: LedgerEvent[] = [
			...seenDays("a", 3),
			{ v: 1, ts: iso(NOW - DAY), key: "a", event: "approved", experiment: "E-20261111-01" },
			seen("a", dayOf(NOW)),
			{ v: 1, ts: iso(NOW), key: "a", event: "proposed", via: "log" },
		];
		const [cand] = fold(events, NOW + DAY);
		expect(cand?.status).toBe("approved");
		expect(due(events, NOW + 30 * DAY)).toEqual([]);
	});

	test("status sticks: a seen after rejected leaves it rejected", () => {
		const events: LedgerEvent[] = [
			...seenDays("a", 3),
			{ v: 1, ts: iso(NOW - DAY), key: "a", event: "rejected" },
			seen("a", dayOf(NOW)),
		];
		expect(fold(events, NOW + DAY)[0]?.status).toBe("rejected");
	});
});

describe("redact", () => {
	test("redact: token-shaped text in summary or evidence is masked in the note and the card", async () => {
		const token = ["xoxb", "TEST", "0"].join("-");
		const gh = `ghp_${"A".repeat(30)}`;
		const events = seenDays("leak", 3).map((e) => ({ ...e, summary: `토큰 ${token} 노출`, evidence: `log ${gh}` }));
		const [cand] = fold(events as LedgerEvent[]);
		if (cand === undefined) throw new Error("no candidate");
		const note = buildCandidateNote(cand);
		expect(note).not.toContain(token);
		expect(note).not.toContain(gh);
		expect(note).toContain("[개선 후보] leak fix 3일 반복");

		const logRun = harness(events as LedgerEvent[]);
		await runCandidateProposals(logRun.deps, OPEN);
		expect(logRun.notes).toHaveLength(1);
		expect(logRun.notes[0]).not.toContain(token);

		const cardRun = harness(events as LedgerEvent[], { mode: "card" }, () => "approved");
		await runCandidateProposals(cardRun.deps, OPEN);
		expect(cardRun.cards).toHaveLength(1);
		expect(cardRun.cards[0]).not.toContain(token);
		expect(cardRun.cards[0]).not.toContain(gh);
		const experiments = readFileSync(cardRun.deps.experimentsPath, "utf8");
		expect(experiments).not.toContain(token);
	});
});

describe("approval flow", () => {
	const PRIOR = "# 실험 장부\n\n## E-20261112-01 기존 항목\n- 판정: 효과\n";

	test("approval flow: approved writes approved and appends an experiment; prior bytes unchanged", async () => {
		const h = harness(seenDays("backfill-dead-origin", 3), { mode: "card" }, () => "approved");
		writeFileSync(h.deps.experimentsPath, PRIOR);
		expect(await runCandidateProposals(h.deps, OPEN)).toEqual(["backfill-dead-origin"]);
		const events = ledger(h).slice(3);
		expect(events.map((e) => e.event)).toEqual(["proposed", "approved"]);
		expect(events[0]).toMatchObject({ event: "proposed", via: "card" });
		const after = readFileSync(h.deps.experimentsPath);
		expect(after.subarray(0, Buffer.byteLength(PRIOR)).equals(Buffer.from(PRIOR))).toBe(true);
		const added = after.subarray(Buffer.byteLength(PRIOR)).toString("utf8");
		// NOW is 2026-11-12 09:00 KST: the id is that date's next free number, the verdict a week later.
		expect(added).toContain("## E-20261112-02 ");
		expect(added).toContain("- 판정: 대기");
		expect(added).toContain("- 판정일: 2026-11-19");
		expect(events[1]).toMatchObject({ event: "approved", experiment: "E-20261112-02" });
	});

	test("approval flow: denied writes rejected only", async () => {
		const h = harness(seenDays("a", 3), { mode: "card" }, () => "denied");
		writeFileSync(h.deps.experimentsPath, PRIOR);
		await runCandidateProposals(h.deps, OPEN);
		expect(
			ledger(h)
				.slice(3)
				.map((e) => e.event),
		).toEqual(["proposed", "rejected"]);
		expect(readFileSync(h.deps.experimentsPath, "utf8")).toBe(PRIOR);
	});

	test("approval flow: a timeout leaves the ledger as it was when the card went out", async () => {
		let atCard = "";
		const h = harness(seenDays("a", 3), { mode: "card" }, (text) => {
			atCard = text;
			return "timeout";
		});
		await runCandidateProposals(h.deps, OPEN);
		expect(atCard).toContain('"event":"proposed"');
		expect(readFileSync(h.deps.ledgerPath, "utf8")).toBe(atCard);
		expect(existsSync(h.deps.experimentsPath)).toBe(false);
		expect(fold(ledger(h))[0]?.status).toBe("proposed");
	});
});

describe("gate", () => {
	const blocked: Array<[string, Partial<CandidatesSettings>, CandidateGate]> = [
		["disabled", { enabled: false }, OPEN],
		["frozen", {}, { ...OPEN, frozen: true }],
		["draining", {}, { ...OPEN, draining: true }],
		["card open", {}, { ...OPEN, openCards: 1 }],
	];
	for (const [name, settings, gate] of blocked) {
		for (const mode of ["log", "card"] as const) {
			test(`gate: ${name} (${mode}) raises nothing and leaves the ledger alone`, async () => {
				const h = harness(seenDays("a", 3), { ...settings, mode }, () => "approved");
				const before = readFileSync(h.deps.ledgerPath, "utf8");
				expect(await runCandidateProposals(h.deps, gate)).toEqual([]);
				expect(h.notes).toEqual([]);
				expect(h.cards).toEqual([]);
				expect(readFileSync(h.deps.ledgerPath, "utf8")).toBe(before);
			});
		}
	}

	test("gate: log mode posts one line and records proposed(via=log) without asking for approval", async () => {
		const h = harness(seenDays("a", 3), {}, () => "approved");
		expect(h.deps.settings.mode).toBe("log");
		await runCandidateProposals(h.deps, OPEN);
		expect(h.cards).toEqual([]);
		expect(h.notes).toHaveLength(1);
		expect(h.notes[0]).toStartWith("[개선 후보] a fix 3일 반복");
		expect(ledger(h).at(-1)).toMatchObject({ event: "proposed", via: "log" });
		// The next pass within snoozeDays raises nothing again.
		await runCandidateProposals(h.deps, OPEN);
		expect(h.notes).toHaveLength(1);
	});

	test("gate: a missing ledger raises nothing", async () => {
		const h = harness([]);
		rmSync(h.deps.ledgerPath);
		expect(await runCandidateProposals(h.deps, OPEN)).toEqual([]);
		expect(existsSync(h.deps.ledgerPath)).toBe(false);
	});
});

describe("real fixture", () => {
	test("real fixture: retros of 11-09..11-11 yield exactly backfill-dead-origin", () => {
		const text = readFileSync(join(import.meta.dir, "fixtures", "candidates-2026-11-09_11.jsonl"), "utf8");
		const events = parseLedger(text);
		expect(events).toHaveLength(text.trim().split("\n").length);
		const picked = dueCandidates(foldCandidates(events, NOW, S), S, NOW);
		expect(picked.map((c) => c.key)).toEqual(["backfill-dead-origin"]);
		expect(picked[0]?.distinctDays).toBe(3);
	});
});

describe("ledger append and config", () => {
	test("appendEvent keeps a line without its final newline separate", () => {
		const path = join(dir, "candidates.jsonl");
		writeFileSync(path, JSON.stringify(seen("a", "2026-11-10")));
		appendEvent(path, seen("a", "2026-11-11"));
		expect(parseLedger(readFileSync(path, "utf8"))).toHaveLength(2);
	});

	function writeHome(candidates: unknown): string {
		const home = join(dir, "home");
		rmSync(home, { recursive: true, force: true });
		mkdirSync(home, { mode: 0o700 });
		chmodSync(home, 0o700);
		writeFileSync(
			join(home, "config.json"),
			JSON.stringify({
				schemaVersion: 1,
				channels: { slack: { ownerUserId: "UOWNER0" } },
				slack: { botTokenFile: "secrets/bot.token", appTokenFile: "secrets/app.token" },
				ompExecutable: "/usr/local/bin/omp",
				workspaceDir: "workspace",
				...(candidates === undefined ? {} : { candidates }),
			}),
		);
		return home;
	}

	test("config candidates: defaults to log mode, accepts valid values, rejects unknown keys and bad values", () => {
		expect(loadConfig(writeHome(undefined), { checkTokens: false }).candidates).toBeUndefined();
		expect(resolveCandidates(undefined)).toEqual({
			enabled: true,
			mode: "log",
			minDays: 3,
			windowDays: 14,
			maxOpenCards: 1,
			snoozeDays: 7,
		});
		const ok = loadConfig(writeHome({ mode: "card", minDays: 2, enabled: false }), { checkTokens: false });
		expect(resolveCandidates(ok.candidates)).toMatchObject({
			mode: "card",
			minDays: 2,
			enabled: false,
			windowDays: 14,
		});
		for (const bad of [{ mode: "loud" }, { minDays: 0 }, { windowDays: 1.5 }, { enabled: "yes" }, { extra: 1 }, []]) {
			expect(() => loadConfig(writeHome(bad), { checkTokens: false })).toThrow(ConfigError);
		}
	});
});
