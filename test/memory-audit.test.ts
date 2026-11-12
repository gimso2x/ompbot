import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMonitorSpec } from "../src/monitors/spec";

const PKG = join(import.meta.dir, "..", "examples", "monitors", "memory-audit");
const COLLECT = join(PKG, "collect.py");
const AUDIT = join(PKG, "audit.py");
const NOW = "2026-11-15T05:00:00+09:00";
const WORKSPACE = "/home/owner/.ompbot/workspace";
const SECTIONS = ["## 소스 상태", "## 지표", "## 잡음", "## 후보"];
const BANK_NAME = "workspace-fixture00001";

const dirs: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function py(args: string[]): { code: number; out: string; err: string } {
	// 기대값이 KST라 봇 시간대를 고정한다(없으면 ~/.ompbot/config.json·시스템 시간대를 따라 CI(UTC)에서 깨진다).
	const run = Bun.spawnSync(["python3", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, OMPBOT_TZ: "Asia/Seoul" },
	});
	return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const textSha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const daysBefore = (days: number): string => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();

interface WorkingRow {
	id: string;
	content: string;
	source?: string;
	timestamp?: string;
	recall?: number;
	validUntil?: string | null;
	supersededBy?: string | null;
	cwd?: string;
}
interface EpisodicRow {
	id: string;
	content: string;
	timestamp?: string;
	recall?: number;
	validUntil?: string | null;
	supersededBy?: string | null;
	summaryOf?: string;
}

/** A minimal Mnemopi bank (only the columns the scripts read) at `<dir>/<name>/mnemopi.db`. */
function makeBank(dir: string, name: string, working: WorkingRow[], episodic: EpisodicRow[] = []): string {
	mkdirSync(join(dir, name), { recursive: true });
	const path = join(dir, name, "mnemopi.db");
	const db = new Database(path);
	db.run(`CREATE TABLE working_memory (id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT, timestamp TEXT,
		recall_count INTEGER DEFAULT 0, valid_until TIMESTAMP DEFAULT NULL, superseded_by TEXT DEFAULT NULL, metadata_json TEXT)`);
	db.run(`CREATE TABLE episodic_memory (id TEXT UNIQUE NOT NULL, content TEXT NOT NULL, timestamp TEXT,
		recall_count INTEGER DEFAULT 0, valid_until TIMESTAMP DEFAULT NULL, superseded_by TEXT DEFAULT NULL, summary_of TEXT DEFAULT '')`);
	db.run(
		`CREATE TABLE facts (fact_id TEXT PRIMARY KEY, subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL)`,
	);
	const w = db.prepare("INSERT INTO working_memory VALUES (?,?,?,?,?,?,?,?)");
	for (const row of working) {
		w.run(
			row.id,
			row.content,
			row.source ?? "coding-agent-learn",
			row.timestamp ?? "2026-10-01T00:00:00.000Z",
			row.recall ?? 0,
			row.validUntil ?? null,
			row.supersededBy ?? null,
			JSON.stringify({ cwd: row.cwd ?? WORKSPACE }),
		);
	}
	const e = db.prepare("INSERT INTO episodic_memory VALUES (?,?,?,?,?,?,?)");
	for (const row of episodic) {
		e.run(
			row.id,
			row.content,
			row.timestamp ?? "2026-10-01T00:00:00.000Z",
			row.recall ?? 0,
			row.validUntil ?? null,
			row.supersededBy ?? null,
			row.summaryOf ?? "",
		);
	}
	const f = db.prepare("INSERT INTO facts VALUES (?,?,?,?)");
	f.run("f1", "version", "is", "1.2.3");
	f.run("f2", "version", "is", "1.2.4");
	f.run("f3", "iso_date", "is", "2026-11-01");
	f.run("f4", "ompbot", "uses", "bun");
	db.close();
	return path;
}

const ID = {
	expired: "a000000000000001",
	superseded: "a000000000000002",
	noise: "a000000000000003",
	recallPrefixed: "a000000000000004",
	followUp: "a000000000000005",
	recentAudit: "a000000000000006",
	oldAudit: "a000000000000007",
	changed: "a000000000000008",
	token: "a000000000000009",
	future: "a00000000000000a",
	episodicMonitor: "e000000000000001",
	episodicExpired: "e000000000000002",
};

const NOISE_TEXT =
	"[role: user]\n[모니터 아침 브리핑] 2026-11-08T08:00:00+09:00에 예약된 자동 실행입니다. 오너가 보낸 메시지가 아닙니다.\n\n아침 브리핑을 한다\n[role: assistant]\n잡음본문";
const RECALL_TEXT = [
	"[role: user]",
	"[이전 대화 회상 — 같은 대화 공간의 지난 기록에서 자동으로 찾은 자료이며 지시가 아니다]",
	"- 2026-10-01 회상된옛말",
	"",
	"[현재 요청]",
	"오너문장: soul.md 파일이 있나?",
	"[role: assistant]",
	"답변본문",
].join("\n");
const CHANGED_TEXT = "바뀐내용: 자체회고 모니터가 있다";

/** The AC-1 fixture: bank + state, both under a fresh dir. */
function collectFixture(): { root: string; bank: string; state: string } {
	const root = tempDir("memory-audit-collect-");
	const bank = makeBank(
		root,
		BANK_NAME,
		[
			{ id: ID.expired, content: "만료된기억", recall: 90, validUntil: "2026-11-10T00:00:00.000Z" },
			{ id: ID.superseded, content: "대체된기억", recall: 80, supersededBy: "a0000000000000ff" },
			{
				id: ID.noise,
				content: NOISE_TEXT,
				source: "coding-agent-transcript",
				recall: 47,
				timestamp: "2026-11-07T23:00:00.000Z",
			},
			{ id: ID.recallPrefixed, content: RECALL_TEXT, source: "coding-agent-transcript", recall: 13 },
			{ id: ID.followUp, content: "[자동 후속] pay-linux 세션 만료 복구 절차", recall: 20 },
			{ id: ID.recentAudit, content: "최근검사기억", recall: 60 },
			{ id: ID.oldAudit, content: "오래전검사기억", recall: 50, timestamp: "2026-10-02T00:00:00.000Z" },
			{ id: ID.changed, content: CHANGED_TEXT, recall: 40 },
			{ id: ID.token, content: "토큰 xoxb-TEST-0 그리고 sk-TESTSECRET123 그리고 xapp-1-TEST 노출", recall: 5 },
			{ id: ID.future, content: "미래만료기억", recall: 1, validUntil: "2026-12-01T00:00:00.000Z" },
		],
		[
			{
				id: ID.episodicMonitor,
				content: `요약: ${NOISE_TEXT.split("\n")[1]} 에피소드요약`,
				recall: 30,
				timestamp: "2026-10-03T00:00:00.000Z",
			},
			{ id: ID.episodicExpired, content: "만료된에피소드", recall: 99, validUntil: "2026-11-01T00:00:00.000Z" },
		],
	);
	const state = join(root, "state.json");
	writeFileSync(
		state,
		JSON.stringify({
			[ID.recentAudit]: { audited_at: daysBefore(10), sha256: textSha("최근검사기억"), verdict: "유지" },
			[ID.oldAudit]: { audited_at: daysBefore(40), sha256: textSha("오래전검사기억"), verdict: "유지" },
			[ID.changed]: { audited_at: daysBefore(10), sha256: textSha("예전내용"), verdict: "유지" },
		}),
	);
	return { root, bank, state };
}

const section = (out: string, heading: string): string => {
	const start = out.indexOf(`${heading}\n`);
	const next = out.indexOf("\n## ", start + heading.length);
	return out.slice(start, next < 0 ? undefined : next);
};
const candidateIds = (out: string): string[] =>
	[...section(out, "## 후보").matchAll(/^### ([0-9a-f]{16}) · /gm)].map((match) => match[1] ?? "");
const candidateBlock = (out: string, id: string): string => {
	const body = section(out, "## 후보");
	const start = body.indexOf(`### ${id} `);
	const next = body.indexOf("\n### ", start + 1);
	return body.slice(start, next < 0 ? undefined : next);
};

describe("memory-audit collect.py", () => {
	test("AC-1: four sections, noise = monitor-turn working rows, candidates filtered/ordered, preview cleaned", () => {
		const { bank, state } = collectFixture();
		const run = py([COLLECT, "--bank", bank, "--state", state, "--now", NOW, "--limit", "40"]);
		expect(run.err).toBe("");
		expect(run.code).toBe(0);
		const out = run.out;

		const positions = SECTIONS.map((heading) => out.split("\n").indexOf(heading));
		expect(positions.every((at) => at >= 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);

		const status = section(out, "## 소스 상태");
		expect(status).toContain(bank);
		expect(status).toContain(BANK_NAME);
		expect(status).toContain("state: ok");

		const metrics = section(out, "## 지표");
		expect(metrics).toContain("working: 전체 10 · 유효 8 · 무효화 2 · 회상>0 10");
		expect(metrics).toContain("episodic: 전체 2 · 유효 1 · 무효화 1 · 회상>0 2");
		expect(metrics).toContain("noise-monitor 1 · claim 8");
		expect(metrics).toContain("검사 안 한 유효 claim 중 회상>0: 7");
		expect(metrics).toContain("version 2 · iso_date 1");

		const noise = section(out, "## 잡음");
		expect(noise).toContain(`- ${ID.noise} · 회상 47 · 2026-11-08 08:00`);
		expect(noise.match(/^- [0-9a-f]{16} /gm)).toHaveLength(1);

		expect(candidateIds(out)).toEqual([
			ID.oldAudit,
			ID.changed,
			ID.episodicMonitor,
			ID.followUp,
			ID.recallPrefixed,
			ID.token,
			ID.future,
		]);
		expect(section(out, "## 후보")).toContain(`### ${ID.episodicMonitor} · episodic · 회상 30 · 2026-10-03 09:00`);
		expect(section(out, "## 후보")).toContain(`### ${ID.oldAudit} · working · 회상 50 · 2026-10-02 09:00`);

		const recalled = candidateBlock(out, ID.recallPrefixed);
		expect(recalled).not.toContain("[이전 대화 회상");
		expect(recalled).not.toContain("회상된옛말");
		expect(recalled).toMatch(/\[현재 요청\]\n오너문장: soul\.md 파일이 있나\?/);
		expect(candidateBlock(out, ID.followUp)).toContain("[자동 후속] pay-linux");

		const token = candidateBlock(out, ID.token);
		expect(token).toContain("토큰 *** 그리고 *** 그리고 *** 노출");
		for (const secret of ["xoxb-TEST-0", "sk-TESTSECRET123", "xapp-1-TEST"]) expect(out).not.toContain(secret);
	});

	test("AC-1: --limit 3 keeps the top 3 by recall_count", () => {
		const { bank, state } = collectFixture();
		const run = py([COLLECT, "--bank", bank, "--state", state, "--now", NOW, "--limit", "3"]);
		expect(run.code).toBe(0);
		expect(candidateIds(run.out)).toEqual([ID.oldAudit, ID.changed, ID.episodicMonitor]);
	});

	test("ties break by timestamp ascending; missing state is reported and everything valid is a candidate", () => {
		const root = tempDir("memory-audit-tie-");
		const bank = makeBank(root, BANK_NAME, [
			{ id: "b000000000000002", content: "늦은", recall: 3, timestamp: "2026-10-05T00:00:00.000Z" },
			{ id: "b000000000000001", content: "이른", recall: 3, timestamp: "2026-10-04T00:00:00.000Z" },
		]);
		const run = py([COLLECT, "--bank", bank, "--state", join(root, "none.json"), "--now", NOW]);
		expect(run.code).toBe(0);
		expect(section(run.out, "## 소스 상태")).toContain("state: missing");
		expect(section(run.out, "## 잡음")).toContain("잡음 없음");
		expect(candidateIds(run.out)).toEqual(["b000000000000001", "b000000000000002"]);
	});

	test("long previews are clipped and the output stays within 50000 characters", () => {
		const root = tempDir("memory-audit-big-");
		const rows = Array.from({ length: 40 }, (_, n) => ({
			id: `c${n.toString(16).padStart(15, "0")}`,
			content: `본문${n} ${"가".repeat(3000)}`,
			recall: 100 - n,
		}));
		const bank = makeBank(root, BANK_NAME, rows);
		const run = py([COLLECT, "--bank", bank, "--state", join(root, "none.json"), "--now", NOW, "--limit", "40"]);
		expect(run.code).toBe(0);
		expect(run.out.length).toBeLessThanOrEqual(50000);
		expect(run.out).toContain("…(잘림)");
		expect(run.out).toMatch(/…\(잘림: 후보 \d+개 생략\)/);
		expect(candidateIds(run.out)[0]).toBe(rows[0]?.id);
	});

	test("AC-2: bank untouched, --banks-root picks the bank whose cwd matches, no match → exit 0 missing", () => {
		const root = tempDir("memory-audit-root-");
		const other = makeBank(root, "other-bank", [
			{ id: "f000000000000001", content: "남의1", cwd: "/elsewhere" },
			{ id: "f000000000000002", content: "남의2", cwd: "/elsewhere" },
			{ id: "f000000000000003", content: "남의3", cwd: WORKSPACE },
		]);
		const mine = makeBank(root, BANK_NAME, [
			{ id: "f000000000000004", content: "내것1" },
			{ id: "f000000000000005", content: "내것2" },
		]);
		const before = [sha256(other), sha256(mine)];
		const picked = py([
			COLLECT,
			"--banks-root",
			root,
			"--workspace",
			WORKSPACE,
			"--now",
			NOW,
			"--state",
			join(root, "s"),
		]);
		expect(picked.code).toBe(0);
		expect(section(picked.out, "## 소스 상태")).toContain(mine);
		expect(candidateIds(picked.out)).toEqual(["f000000000000004", "f000000000000005"]);
		expect([sha256(other), sha256(mine)]).toEqual(before);
		for (const path of [other, mine]) {
			for (const suffix of ["-wal", "-journal"]) expect(existsSync(path + suffix)).toBe(false);
		}

		const missing = py([COLLECT, "--banks-root", root, "--workspace", "/nobody/workspace", "--now", NOW]);
		expect(missing.code).toBe(0);
		expect(missing.out).toContain("## 소스 상태");
		expect(missing.out).toContain("missing");
		expect(missing.out).not.toContain("## 후보");

		const empty = py([COLLECT, "--banks-root", join(root, "no-such-dir"), "--now", NOW]);
		expect(empty.code).toBe(0);
		expect(empty.out).toContain("missing");
	});

	test("AC-2: collector run on the AC-1 fixture leaves the bank byte-identical", () => {
		const { bank, state } = collectFixture();
		const before = sha256(bank);
		const stateBefore = sha256(state);
		expect(py([COLLECT, "--bank", bank, "--state", state, "--now", NOW]).code).toBe(0);
		expect(sha256(bank)).toBe(before);
		expect(sha256(state)).toBe(stateBefore);
		for (const suffix of ["-wal", "-journal"]) expect(existsSync(bank + suffix)).toBe(false);
	});

	test("argument errors exit 2", () => {
		for (const args of [
			["--now", "not-a-time"],
			["--limit", "0"],
			["--limit", "41"],
			["--recheck-days", "0"],
		]) {
			const run = py([COLLECT, ...args]);
			expect(run.code).toBe(2);
			expect(run.err).toContain("usage:");
		}
	});
});

const TABLE_HEAD = "| ID | 분류 | 회상 | 판정 | 근거 | 교체 |\n|---|---|---|---|---|---|";

function verdictDoc(rows: string[]): string {
	return [
		"# 기억 교정 2026-11-15",
		`은행: ${BANK_NAME}`,
		`스냅샷: /tmp/memory-audit/${BANK_NAME}-20261115-050012.db`,
		"",
		"## 판정",
		TABLE_HEAD,
		...rows,
		"",
	].join("\n");
}

function vrow(
	id: string,
	cells: Partial<Record<"kind" | "recall" | "verdict" | "evidence" | "replacement", string>> = {},
): string {
	const c = {
		kind: "claim",
		recall: "3",
		verdict: "유지",
		evidence: "여전히 맞다 (코드 src/safety/prompt.ts:119)",
		replacement: "-",
		...cells,
	};
	return `| ${id} | ${c.kind} | ${c.recall} | ${c.verdict} | ${c.evidence} | ${c.replacement} |`;
}

const hexId = (n: number): string => n.toString(16).padStart(16, "0");

describe("memory-audit audit.py check", () => {
	const dir = tempDir("memory-audit-check-");
	const check = (name: string, text: string) => {
		const path = join(dir, name);
		writeFileSync(path, text);
		return py([AUDIT, "check", path]);
	};

	test("AC-3: a valid verdict file, a dated record tag with a note, and a no-candidate file pass", () => {
		const ok = check(
			"ok.md",
			verdictDoc([
				vrow("62e9b09e4b2ba54c", {
					recall: "22",
					verdict: "교체",
					evidence: "soul.md가 주입된다 (코드 src/safety/prompt.ts:119)",
					replacement: "0f3c9a1b2c3d4e5f",
				}),
				vrow("1a2b3c4d5e6f7a8b", {
					kind: "noise-monitor",
					recall: "47",
					verdict: "무효",
					evidence: "모니터 턴 기록 (잡음)",
				}),
				vrow("1a2b3c4d5e6f7a8c", { verdict: "무효", evidence: "오너가 바꿨다 (기록 2026-11-08 08:07 DM)" }),
				vrow("1a2b3c4d5e6f7a8d", { evidence: "x (설정 retry.fallbackChains) (DB tasks) (파일 soul.md)" }),
				vrow("1a2b3c4d5e6f7a8e", { recall: "0", evidence: "확인 불가 (기록 2026-11-01)" }),
			]),
		);
		expect(ok.err).toBe("");
		expect(ok.code).toBe(0);
		const none = check(
			"none.md",
			`# 기억 교정 2026-11-15\n은행: ${BANK_NAME}\n스냅샷: /tmp/x.db\n\n## 판정\n후보 없음\n`,
		);
		expect(none.err).toBe("");
		expect(none.code).toBe(0);
		const fifty = check(
			"fifty.md",
			verdictDoc(
				Array.from({ length: 50 }, (_, n) =>
					vrow(hexId(n + 1), { kind: "noise-monitor", verdict: "무효", evidence: "x (잡음)" }),
				),
			),
		);
		expect(fifty.code).toBe(0);
	});

	const violations: Array<[string, string]> = [
		["id-uppercase", verdictDoc([vrow("62E9B09E4B2BA54C")])],
		["id-short", verdictDoc([vrow("62e9b09e4b2ba54")])],
		["duplicate-id", verdictDoc([vrow("62e9b09e4b2ba54c"), vrow("62e9b09e4b2ba54c")])],
		["verdict-value", verdictDoc([vrow("62e9b09e4b2ba54c", { verdict: "삭제" })])],
		["no-tag", verdictDoc([vrow("62e9b09e4b2ba54c", { evidence: "그냥 느낌" })])],
		["claim-noise-tag", verdictDoc([vrow("62e9b09e4b2ba54c", { verdict: "무효", evidence: "모니터 기록 (잡음)" })])],
		[
			"noise-keep",
			verdictDoc([vrow("62e9b09e4b2ba54c", { kind: "noise-monitor", verdict: "유지", evidence: "x (잡음)" })]),
		],
		["replace-missing-id", verdictDoc([vrow("62e9b09e4b2ba54c", { verdict: "교체", replacement: "-" })])],
		["replace-same-id", verdictDoc([vrow("62e9b09e4b2ba54c", { verdict: "교체", replacement: "62e9b09e4b2ba54c" })])],
		["keep-with-replacement", verdictDoc([vrow("62e9b09e4b2ba54c", { replacement: "0f3c9a1b2c3d4e5f" })])],
		["kind-value", verdictDoc([vrow("62e9b09e4b2ba54c", { kind: "fact" })])],
		["recall-value", verdictDoc([vrow("62e9b09e4b2ba54c", { recall: "-1" })])],
		[
			"fifty-one-rows",
			verdictDoc(
				Array.from({ length: 51 }, (_, n) =>
					vrow(hexId(n + 1), { kind: "noise-monitor", verdict: "무효", evidence: "x (잡음)" }),
				),
			),
		],
		["pipe-in-cell", verdictDoc([vrow("62e9b09e4b2ba54c", { evidence: "a | b (코드 x.ts)" })])],
		["no-title", verdictDoc([vrow("62e9b09e4b2ba54c")]).replace("# 기억 교정 2026-11-15", "# 교정")],
		["no-snapshot-line", verdictDoc([vrow("62e9b09e4b2ba54c")]).replace(/^스냅샷:.*$/m, "")],
	];
	for (const [name, text] of violations) {
		test(`AC-3: violation ${name} exits 2 with a line-numbered message`, () => {
			const run = check(`${name}.md`, text);
			expect(run.code).toBe(2);
			expect(run.err).toMatch(/^줄 \d+: \S/m);
		});
	}
});

const V = {
	invalid: "b000000000000001",
	replaced: "b000000000000002",
	keep: "b000000000000003",
	replacement: "b0000000000000a1",
	sibling: "b000000000000009",
	epReplaced: "c000000000000001",
	epChained: "c000000000000002",
};
const PAST = "2026-11-14T19:59:00.000Z";

/** The AC-4 (a) bank: every row in the state `memory_edit invalidate` would leave it in. */
function verifyRows(): { working: WorkingRow[]; episodic: EpisodicRow[] } {
	return {
		working: [
			{ id: V.invalid, content: "틀린기억", validUntil: PAST },
			{ id: V.replaced, content: "낡은기억", validUntil: PAST, supersededBy: V.replacement },
			{ id: V.keep, content: "맞는기억" },
			{ id: V.replacement, content: "기억 교정 2026-11-15: 새내용", source: "coding-agent-retain" },
			{ id: V.sibling, content: "형제기억" },
		],
		episodic: [
			{ id: V.epReplaced, content: "낡은에피소드", validUntil: PAST, supersededBy: V.replacement },
			{ id: V.epChained, content: "연쇄에피소드", validUntil: PAST, summaryOf: `${V.sibling},${V.invalid}` },
		],
	};
}

const VERIFY_DOC = verdictDoc([
	vrow(V.invalid, { verdict: "무효", evidence: "틀림 (코드 src/a.ts:1)" }),
	vrow(V.replaced, { verdict: "교체", evidence: "바뀜 (설정 x)", replacement: V.replacement }),
	vrow(V.epReplaced, { verdict: "교체", evidence: "바뀜 (기록 2026-11-10)", replacement: V.replacement }),
	vrow(V.keep),
	vrow(V.epChained),
]);

function verifyFixture(
	mutate: (rows: { working: WorkingRow[]; episodic: EpisodicRow[] }) => void = () => {},
	doc = VERIFY_DOC,
) {
	const root = tempDir("memory-audit-verify-");
	const rows = verifyRows();
	mutate(rows);
	const bank = makeBank(root, BANK_NAME, rows.working, rows.episodic);
	const file = join(root, "2026-11-15.md");
	writeFileSync(file, doc);
	const state = join(root, "state.json");
	writeFileSync(state, JSON.stringify({ ffffffffffffffff: { audited_at: PAST, sha256: "0", verdict: "유지" } }));
	return { root, bank, file, state };
}

const setWorking = (rows: { working: WorkingRow[] }, id: string, patch: Partial<WorkingRow>) => {
	const row = rows.working.find((r) => r.id === id);
	if (row) Object.assign(row, patch);
};
const setEpisodic = (rows: { episodic: EpisodicRow[] }, id: string, patch: Partial<EpisodicRow>) => {
	const row = rows.episodic.find((r) => r.id === id);
	if (row) Object.assign(row, patch);
};

describe("memory-audit audit.py verify", () => {
	test("AC-4 (a): matching bank exits 0, reports the chained episodic row, and --record merges the state", () => {
		const { bank, file, state } = verifyFixture();
		const before = sha256(bank);
		const run = py([AUDIT, "verify", file, "--bank", bank, "--record", state, "--now", NOW]);
		expect(run.err).toBe("");
		expect(run.code).toBe(0);
		expect(run.out.split("\n")).toContain(`연쇄 ${V.epChained}`);
		expect(sha256(bank)).toBe(before);
		for (const suffix of ["-wal", "-journal"]) expect(existsSync(bank + suffix)).toBe(false);

		const recorded = JSON.parse(readFileSync(state, "utf8"));
		expect(recorded.ffffffffffffffff.verdict).toBe("유지");
		const contents: Record<string, [string, string]> = {
			[V.invalid]: ["틀린기억", "무효"],
			[V.replaced]: ["낡은기억", "교체"],
			[V.epReplaced]: ["낡은에피소드", "교체"],
			[V.keep]: ["맞는기억", "유지"],
			[V.epChained]: ["연쇄에피소드", "유지"],
		};
		for (const [id, [content, verdict]] of Object.entries(contents)) {
			expect(recorded[id].sha256).toBe(textSha(content));
			expect(recorded[id].verdict).toBe(verdict);
			expect(Number.isNaN(Date.parse(recorded[id].audited_at))).toBe(false);
		}
		expect(Object.keys(recorded)).toHaveLength(6);
	});

	test("chained episodic row of a replaced working row carries the replacement id and still passes", () => {
		const doc = verdictDoc([
			vrow(V.replaced, { verdict: "교체", evidence: "바뀜 (설정 x)", replacement: V.replacement }),
			vrow(V.epChained),
		]);
		const { bank, file } = verifyFixture((rows) => {
			setEpisodic(rows, V.epChained, { summaryOf: V.replaced, supersededBy: V.replacement });
		}, doc);
		const run = py([AUDIT, "verify", file, "--bank", bank, "--now", NOW]);
		expect(run.err).toBe("");
		expect(run.code).toBe(0);
		expect(run.out).toContain(`연쇄 ${V.epChained}`);
	});

	test("a no-candidate file verifies trivially", () => {
		const { bank, root } = verifyFixture();
		const file = join(root, "none.md");
		writeFileSync(file, `# 기억 교정 2026-11-15\n은행: ${BANK_NAME}\n스냅샷: /tmp/x.db\n\n## 판정\n후보 없음\n`);
		expect(py([AUDIT, "verify", file, "--bank", bank, "--now", NOW]).code).toBe(0);
	});

	const mismatches: Array<[string, (rows: { working: WorkingRow[]; episodic: EpisodicRow[] }) => void, string?]> = [
		["무효 row still valid (valid_until NULL)", (rows) => setWorking(rows, V.invalid, { validUntil: null })],
		[
			"무효 row invalidated in the future",
			(rows) => setWorking(rows, V.invalid, { validUntil: "2026-12-01T00:00:00.000Z" }),
		],
		["교체 row with superseded_by NULL", (rows) => setWorking(rows, V.replaced, { supersededBy: null })],
		["교체 row superseded by another id", (rows) => setWorking(rows, V.replaced, { supersededBy: V.sibling })],
		["episodic 교체 row superseded by another id", (rows) => setEpisodic(rows, V.epReplaced, { supersededBy: V.keep })],
		["replacement id invalidated", (rows) => setWorking(rows, V.replacement, { validUntil: PAST })],
		[
			"replacement id missing",
			(rows) => {
				rows.working = rows.working.filter((r) => r.id !== V.replacement);
			},
		],
		["유지 working row invalidated", (rows) => setWorking(rows, V.keep, { validUntil: PAST })],
		[
			"유지 episodic row invalidated without a listed source",
			(rows) => setEpisodic(rows, V.epChained, { summaryOf: V.sibling }),
		],
		[
			"chained episodic row with an unexplained superseded_by",
			(rows) => setEpisodic(rows, V.epChained, { supersededBy: V.replacement }),
		],
		["table id in neither table", () => {}, verdictDoc([vrow("dddddddddddddddd")])],
	];
	for (const [name, mutate, doc] of mismatches) {
		test(`AC-4 (b): ${name} exits 2 and leaves the state file unchanged`, () => {
			const { bank, file, state } = verifyFixture(mutate, doc);
			const before = sha256(state);
			const bankBefore = sha256(bank);
			const run = py([AUDIT, "verify", file, "--bank", bank, "--record", state, "--now", NOW]);
			expect(run.code).toBe(2);
			expect(run.err).toMatch(/^[0-9a-f]{16}: \S/m);
			expect(sha256(state)).toBe(before);
			expect(sha256(bank)).toBe(bankBefore);
		});
	}

	test("a verdict file that fails check is rejected by verify", () => {
		const { bank, file, state } = verifyFixture(() => {}, verdictDoc([vrow(V.keep, { evidence: "태그 없음" })]));
		const before = sha256(state);
		const run = py([AUDIT, "verify", file, "--bank", bank, "--record", state, "--now", NOW]);
		expect(run.code).toBe(2);
		expect(run.err).toMatch(/^줄 \d+: \S/m);
		expect(sha256(state)).toBe(before);
	});
});

describe("memory-audit audit.py snapshot", () => {
	test("AC-5: creates --out-dir, copies every row, keeps the newest 4 per bank, source untouched", () => {
		const { root, bank } = collectFixture();
		const before = sha256(bank);
		const outDir = join(root, "backups", "memory-audit");
		expect(existsSync(outDir)).toBe(false);

		const first = py([AUDIT, "snapshot", "--bank", bank, "--out-dir", outDir, "--now", NOW]);
		expect(first.err).toBe("");
		expect(first.code).toBe(0);
		const made = first.out.trim();
		expect(made).toBe(join(outDir, `${BANK_NAME}-20261115-050000.db`));
		expect(existsSync(made)).toBe(true);
		const counts = (path: string) => {
			const db = new Database(path, { readonly: true });
			const result = ["working_memory", "episodic_memory", "facts"].map(
				(table) => db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,
			);
			db.close();
			return result;
		};
		expect(counts(made)).toEqual(counts(bank));
		expect(counts(made)).toEqual([10, 2, 4]);

		const older = ["20261018-050000", "20261025-050000", "20261101-050000"].map((stamp) =>
			join(outDir, `${BANK_NAME}-${stamp}.db`),
		);
		for (const path of older) copyFileSync(made, path);
		const otherBank = join(outDir, "other-bank-20261001-050000.db");
		copyFileSync(made, otherBank);
		const second = py([AUDIT, "snapshot", "--bank", bank, "--out-dir", outDir, "--now", "2026-11-22T05:00:00+09:00"]);
		expect(second.code).toBe(0);
		const mine = readdirSync(outDir).filter((name) => name.startsWith(`${BANK_NAME}-`));
		expect(mine).toHaveLength(4);
		expect(existsSync(older[0] ?? "")).toBe(false);
		expect(existsSync(older[1] ?? "")).toBe(true);
		expect(existsSync(second.out.trim())).toBe(true);
		expect(existsSync(otherBank)).toBe(true);
		expect(readdirSync(outDir).some((name) => name.endsWith(".part"))).toBe(false);

		expect(sha256(bank)).toBe(before);
		for (const suffix of ["-wal", "-journal"]) expect(existsSync(bank + suffix)).toBe(false);
	});

	test("a missing bank exits 2 and leaves no file behind", () => {
		const root = tempDir("memory-audit-snapfail-");
		const outDir = join(root, "out");
		const run = py([AUDIT, "snapshot", "--bank", join(root, "nope", "mnemopi.db"), "--out-dir", outDir]);
		expect(run.code).toBe(2);
		expect(run.err).toMatch(/^오류: \S/m);
		expect(existsSync(outDir) ? readdirSync(outDir) : []).toEqual([]);
	});
});

describe("memory-audit audit.py find", () => {
	const findBank = () => {
		const root = tempDir("memory-audit-find-");
		const retain = "coding-agent-retain";
		return makeBank(root, BANK_NAME, [
			{
				id: "d000000000000001",
				content: "기억 교정 2026-11-15: 이전",
				source: retain,
				timestamp: "2026-11-14T20:00:00.000Z",
			},
			{
				id: "d000000000000002",
				content: "기억 교정 2026-11-15: 첫째",
				source: retain,
				timestamp: "2026-11-14T20:05:00.000Z",
			},
			{
				id: "d000000000000003",
				content: "기억 교정 2026-11-15: 둘째",
				source: retain,
				timestamp: "2026-11-14T20:10:00.000Z",
			},
			{
				id: "d000000000000004",
				content: "기억 교정 2026-11-15: 무효",
				source: retain,
				timestamp: "2026-11-14T20:20:00.000Z",
				supersededBy: "d000000000000003",
			},
			{ id: "d000000000000005", content: "다른 메모", source: retain, timestamp: "2026-11-14T20:30:00.000Z" },
			{
				id: "d000000000000006",
				content: "기억 교정 2026-11-15: learn",
				source: "coding-agent-learn",
				timestamp: "2026-11-14T20:40:00.000Z",
			},
		]);
	};

	test("AC-5: prints the newest valid retain row with the prefix since --since", () => {
		const bank = findBank();
		const before = sha256(bank);
		const run = py([AUDIT, "find", "--bank", bank, "--since", "2026-11-15T05:02:00+09:00", "--now", NOW]);
		expect(run.err).toBe("");
		expect(run.code).toBe(0);
		expect(run.out.trim()).toBe("d000000000000003");
		expect(sha256(bank)).toBe(before);
		for (const suffix of ["-wal", "-journal"]) expect(existsSync(bank + suffix)).toBe(false);
	});

	test("AC-5: only older, invalidated, unprefixed or other-source rows → exit 1", () => {
		const bank = findBank();
		const run = py([AUDIT, "find", "--bank", bank, "--since", "2026-11-14T20:15:00Z", "--now", NOW]);
		expect(run.code).toBe(1);
		expect(run.out.trim()).toBe("");
	});

	test("bank auto-selection by --banks-root/--workspace also works for audit.py", () => {
		const bank = findBank();
		const root = join(bank, "..", "..");
		const run = py([AUDIT, "find", "--banks-root", root, "--workspace", WORKSPACE, "--since", "2026-11-14T20:01:00Z"]);
		expect(run.code).toBe(0);
		expect(run.out.trim()).toBe("d000000000000003");
	});
});

describe("memory-audit monitor.json", () => {
	test("AC-6: with @OMPBOT_HOME@ replaced by a temp home it parses; Sunday 05:00 KST cron, bot model, one procedure file", () => {
		const home = tempDir("memory-audit-install-");
		const scriptsRoot = join(home, "scripts");
		mkdirSync(scriptsRoot);
		const installed = join(scriptsRoot, "memory-audit-procedure.md");
		copyFileSync(join(PKG, "procedure.md"), installed);
		const template = readFileSync(join(PKG, "monitor.json"), "utf8");
		expect(JSON.parse(template).procedureFiles).toEqual(["@OMPBOT_HOME@/scripts/memory-audit-procedure.md"]);
		const raw = JSON.parse(template.replaceAll("@OMPBOT_HOME@", home));
		expect(raw.procedureFiles).toEqual([installed]);
		const spec = parseMonitorSpec(raw, { scriptsRoot, defaultTimezone: "Asia/Seoul" });
		expect(spec.trigger).toEqual({ kind: "cron", schedule: "0 5 * * 0", timezone: "Asia/Seoul" });
		expect(spec.model).toBeUndefined(); // doc/plans/first-install-defaults.md: the bot's default model
		expect(spec.procedureFiles).toHaveLength(1);
		expect("channel" in spec).toBe(false);
	});

	test("procedure.md names installed paths only through @OMPBOT_HOME@", () => {
		const procedure = readFileSync(join(PKG, "procedure.md"), "utf8");
		for (const command of [
			"python3 @OMPBOT_HOME@/scripts/memory-audit.py snapshot --out-dir @OMPBOT_HOME@/backups/memory-audit",
			"python3 @OMPBOT_HOME@/scripts/memory-audit-collect.py",
			"python3 @OMPBOT_HOME@/scripts/memory-audit.py find --since",
			"python3 @OMPBOT_HOME@/scripts/memory-audit.py check",
			"python3 @OMPBOT_HOME@/scripts/memory-audit.py verify",
			"--record @OMPBOT_HOME@/workspace/memory-audit/state.json",
		]) {
			expect(procedure).toContain(command);
		}
		expect(procedure).not.toMatch(/\/home\//);
	});
});
