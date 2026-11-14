import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
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
import { dirname, join, relative } from "node:path";
import { parseMonitorSpec } from "../src/monitors/spec";

// doc/plans/weekly-model-review.md 수락기준 AC-1~AC-6.
const PKG = join(import.meta.dir, "..", "examples", "monitors", "model-review");
const COLLECT = join(PKG, "collect.py");
const REVIEW = join(PKG, "review.py");
const NOW = "2026-11-16T08:40:00+09:00"; // 창 = [2026-11-09T08:40 KST, NOW)
const IN = "2026-11-10T00:00:00.000Z";
const OUT = "2026-11-08T00:00:00.000Z";
const SECTIONS = [
	"## 소스 상태",
	"## 모델별 실측",
	"## 용도별",
	"## 한도·폴백",
	"## MCP 호출",
	"## 현행 설정",
	"## 카탈로그 변화",
	"## 규칙 판정",
];

const dirs: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function py(args: string[], env: Record<string, string | undefined> = process.env) {
	// 기대값이 KST라 봇 시간대를 고정한다.
	const run = Bun.spawnSync(["python3", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...env, OMPBOT_TZ: "Asia/Seoul" },
	});
	return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

function write(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

type Tool = { id: string; name: string; arguments?: unknown; failed?: boolean };
type Call = { model: string; cost?: number; ts?: string; error?: boolean; tools?: Tool[] };
function session(calls: Call[]): string {
	// 사용자 글과 assistant text 블록의 MCP 이름 언급은 toolCall이 아니라 세면 안 된다.
	const lines = [JSON.stringify({ type: "session", version: 3, id: "s", timestamp: IN })];
	for (const call of calls) {
		const [provider, model] = call.model.split("/");
		const at = call.ts ?? IN;
		lines.push(
			JSON.stringify({
				type: "message",
				timestamp: at,
				message: { role: "user", content: "assistant: use mcp__wiki_search_wiki or xd://mcp__wiki_read_wiki_page" },
			}),
		);
		const tools = (call.tools ?? []).map((tool) => ({ type: "toolCall", ...tool, failed: undefined }));
		lines.push(
			JSON.stringify({
				type: "message",
				timestamp: at,
				message: {
					role: "assistant",
					provider,
					model,
					content: [{ type: "text", text: "calling mcp__wiki_search_wiki next" }, ...tools],
					usage: { output: 10, cost: { total: call.cost ?? 0 } },
					stopReason: call.error ? "error" : "stop",
				},
			}),
		);
		for (const tool of call.tools ?? []) {
			lines.push(
				JSON.stringify({
					type: "message",
					timestamp: at,
					message: { role: "toolResult", toolCallId: tool.id, toolName: tool.name, isError: tool.failed === true },
				}),
			);
		}
	}
	return `${lines.join("\n")}\n`;
}
const repeat = (n: number, call: Call): Call[] => Array.from({ length: n }, () => call);

type CatalogModel = { selector: string; kind?: string; input: number; output: number };
const CATALOG: CatalogModel[] = [
	{ selector: "pa/big", input: 10, output: 50 },
	{ selector: "pa/small", input: 1, output: 5 },
	{ selector: "pb/mid", input: 2, output: 8 },
];
const snapshotOf = (models: CatalogModel[]) =>
	Object.fromEntries(
		models.map((m) => [
			m.selector,
			{ provider: m.selector.split("/")[0], kind: m.kind ?? "chat", input: m.input, output: m.output },
		]),
	);

type Fixture = {
	sessions?: Record<string, Call[]> | null; // <home>/sessions 기준 상대 경로 → 호출
	ompSessions?: Record<string, Call[]>;
	log?: string[] | null;
	roles?: Record<string, string>;
	chains?: Record<string, string[]>;
	catalog?: CatalogModel[];
	prev?: CatalogModel[] | null;
	ompFails?: boolean;
	mcp?: object | string | null; // MCP 설정 파일 내용(문자열은 그대로), null = 파일 없음
};

const fallback = (ts: string, from: string, to: string, reason = "Request failed: 429 rate_limit_error") =>
	`ts=${ts} level=info event=retry_fallback_applied origin=discord/ch/1 from=${from} to=${to} reason="${reason.replaceAll('"', '\\"')}"`;

/** 기본 fixture: 용도 7종·깊이 3·하위(깊이 2 초과 포함)·창 밖 레코드·로그·가짜 omp·직전 스냅샷. 규칙은 하나도 걸리지 않는다. */
const BASE_SESSIONS: Record<string, Call[]> = {
	"discord%2Fch%2F1%2Ft%2F2/e1/s-discord.jsonl": [
		{
			model: "pa/big",
			cost: 1.25,
			tools: [
				{ id: "t1", name: "mcp__wiki_search_wiki", arguments: { query: "x" }, failed: true },
				{ id: "t2", name: "write", arguments: JSON.stringify({ path: "xd://mcp__my_srv_do_thing", content: "{}" }) },
				{ id: "t3", name: "write", arguments: { path: "local://notes.md", content: "mcp__wiki_search_wiki" } },
				{ id: "t4", name: "read", arguments: { path: "xd://mcp__wiki_search_wiki" } },
			],
		},
		{ model: "pa/big", cost: 0.75 },
		{ model: "pa/big", cost: 100, ts: OUT, tools: [{ id: "t5", name: "mcp__wiki_search_wiki" }] },
	],
	"telegram%2Fdm%2F7/e1/s-tg.jsonl": [{ model: "pa/small", cost: 0.5 }],
	"monitor%2Fm1/e1/s-mon.jsonl": [
		{
			model: "pa/small",
			cost: 0.25,
			tools: [{ id: "t6", name: "write", arguments: { path: "xd://mcp__wiki_read_wiki_page" } }],
		},
		{ model: "pa/small", cost: 0.25 },
	],
	"ompbot%2Fwork%2Flane-x/e1/s-lane.jsonl": [{ model: "pb/mid", cost: 0.4 }],
	"review%2Fskills/e1/s-rev.jsonl": [{ model: "pb/mid", cost: 0.1, error: true }],
	"other%2Fx/e1/s-other.jsonl": [{ model: "pb/mid", cost: 0.2 }],
	"discord%2Fch%2F9/e1/sess-dir/deep.jsonl": [{ model: "pa/big", cost: 1 }],
	"slack%2Fch%2FC1/e1/parent.jsonl": [{ model: "pa/big", cost: 0.3 }],
	"slack%2Fch%2FC1/e1/parent/sub1.jsonl": [
		{ model: "pa/small", cost: 0.2, tools: [{ id: "t7", name: "mcp__wiki_search_wiki" }] },
	],
	"slack%2Fch%2FC1/e1/parent/x/y/sub2.jsonl": [{ model: "pb/mid", cost: 0.15 }],
};
const BASE_OMP: Record<string, Call[]> = {
	"--proj--/s.jsonl": [
		{ model: "pa/big", cost: 0.5 },
		{ model: "pa/big", cost: 0.3 },
	],
	"--proj--/s/child.jsonl": [{ model: "pa/small", cost: 0.05 }],
};
const BASE_LOG = [
	fallback(IN, "pa/big:high", "pb/mid:high", 'Request failed: 429 {"type":"rate_limit_error","code":"1308"}'),
	fallback(IN, "pa/big:medium", "pb/mid", 'Request failed: 429 {"type":"rate_limit_error","code":"1308"}'),
	fallback(OUT, "pa/big:high", "pb/mid:high"),
	"ts=2026-11-10T00:00:00.000Z level=warn event=other_event",
];

function fixture(options: Fixture = {}) {
	const root = tempDir("model-review-");
	const home = join(root, "home");
	const ompSessions = join(root, "omp-sessions");
	const stateDir = join(home, "workspace", "model-review");
	mkdirSync(stateDir, { recursive: true });
	const sessions = options.sessions === undefined ? BASE_SESSIONS : options.sessions;
	if (sessions)
		for (const [path, calls] of Object.entries(sessions)) write(join(home, "sessions", path), session(calls));
	for (const [path, calls] of Object.entries(options.ompSessions ?? BASE_OMP))
		write(join(ompSessions, path), session(calls));
	const log = options.log === undefined ? BASE_LOG : options.log;
	if (log) write(join(home, "logs", "ompbot.log"), `${log.join("\n")}\n`);
	write(join(home, "config.json"), JSON.stringify({ model: "pa/big", thinking: "medium", timezone: "Asia/Seoul" }));

	const db = new Database(join(home, "ompbot.db"));
	db.run("CREATE TABLE monitors (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, model TEXT, thinking TEXT)");
	db.run("INSERT INTO monitors VALUES ('m1','모니터A',NULL,NULL),('m2','모니터B','pb/mid','low')");
	db.close();

	const prev = options.prev === undefined ? CATALOG : options.prev;
	if (prev) write(join(stateDir, "catalog-2026-11-09.json"), JSON.stringify(snapshotOf(prev)));

	const ompDir = join(root, "omp");
	const catalog = (options.catalog ?? CATALOG).map((m) => {
		const [provider, id] = m.selector.split("/");
		return { provider, id, selector: m.selector, kind: m.kind ?? "chat", cost: { input: m.input, output: m.output } };
	});
	write(join(ompDir, "models.json"), JSON.stringify({ models: catalog }));
	write(
		join(ompDir, "config.json"),
		JSON.stringify({
			modelRoles: { value: options.roles ?? { default: "pa/big:medium" }, type: "record" },
			"retry.fallbackChains": { value: options.chains ?? { default: ["pb/mid:high"] }, type: "record" },
		}),
	);
	const omp = join(ompDir, "omp");
	write(
		omp,
		options.ompFails
			? '#!/bin/sh\necho "omp: broken install" >&2\nexit 3\n'
			: `#!/bin/sh\ncase "$1" in\n  models) cat "${ompDir}/models.json";;\n  config) cat "${ompDir}/config.json";;\n  *) exit 1;;\nesac\n`,
	);
	chmodSync(omp, 0o755);
	const mcpConfig = join(ompDir, "mcp.json");
	const mcp = options.mcp === undefined ? { mcpServers: { wiki: {}, my_srv: {}, idle: {} } } : options.mcp;
	if (mcp !== null) write(mcpConfig, typeof mcp === "string" ? mcp : JSON.stringify(mcp));
	const args = ["--home", home, "--omp-sessions", ompSessions, "--omp", omp, "--mcp-config", mcpConfig, "--now", NOW];
	return { root, home, stateDir, args };
}

function section(out: string, heading: string): string {
	const start = out.indexOf(`${heading}\n`);
	if (start < 0) return "";
	const next = out.indexOf("\n## ", start + heading.length);
	return out.slice(start, next < 0 ? undefined : next);
}
const rules = (out: string) =>
	section(out, "## 규칙 판정")
		.split("\n")
		.slice(1)
		.filter((line) => line.trim());

function expectSectionsInOrder(out: string): void {
	const positions = SECTIONS.map((heading) => out.split("\n").indexOf(heading));
	expect(positions.every((at) => at >= 0)).toBe(true);
	expect([...positions].sort((a, b) => a - b)).toEqual(positions);
}

function collect(options: Fixture = {}, extra: string[] = []) {
	const fx = fixture(options);
	const run = py([COLLECT, ...fx.args, "--no-snapshot", ...extra]);
	expect(run.err).toBe("");
	expect(run.code).toBe(0);
	return run.out;
}

describe("model-review collect.py", () => {
	test("AC-1: eight sections in order; per-model and per-use sums match the hand count; out-of-window ignored", () => {
		const out = collect();
		expectSectionsInOrder(out);
		const status = section(out, "## 소스 상태");
		for (const source of ["sessions: ok", "omp-sessions: ok", "log: ok", "config: ok", "catalog: ok"]) {
			expect(status).toContain(source);
		}
		expect(status).toContain("catalog-prev: catalog-2026-11-09.json");

		// 모델별: pa/big 4+2 = 6호출 4.10$ (창 밖 100$ 제외), pa/small 5호출 1.25$, pb/mid 4호출 0.85$(오류 1)
		const models = section(out, "## 모델별 실측");
		expect(models).toContain("| pa/big | 6 | 4.10 | 60 | 0.00 |");
		expect(models).toContain("| pa/small | 5 | 1.25 | 50 | 0.00 |");
		expect(models).toContain("| pb/mid | 4 | 0.85 | 40 | 25.00 |");
		const order = ["| pa/big ", "| pa/small ", "| pb/mid "].map((row) => models.indexOf(row));
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(models).not.toContain("100.00"); // 창 밖 100$ 레코드

		// 용도별(총 6.20$): 대화 = discord 2.00 + 깊이3 1.00 + slack 부모 0.30, 하위 = 깊이2 0.20 + 깊이4 0.15 + omp 하위 0.05
		const uses = section(out, "## 용도별");
		for (const row of [
			"| 대화 | pa/big | 4 | 3.30 | 53.2 | 0.00 |",
			"| 대화 | pa/small | 1 | 0.50 | 8.1 | 0.00 |",
			"| omp직접 | pa/big | 2 | 0.80 | 12.9 | 0.00 |",
			"| 모니터 | pa/small | 2 | 0.50 | 8.1 | 0.00 |",
			"| 레인 | pb/mid | 1 | 0.40 | 6.5 | 0.00 |",
			"| 리뷰 | pb/mid | 1 | 0.10 | 1.6 | 100.00 |",
			"| 기타 | pb/mid | 1 | 0.20 | 3.2 | 0.00 |",
			"| 하위 | pa/small | 2 | 0.25 | 4.0 | 0.00 |",
			"| 하위 | pb/mid | 1 | 0.15 | 2.4 | 0.00 |",
		]) {
			expect(uses).toContain(row);
		}
		expect(uses.split("\n").filter((line) => /^\| [^-|]/.test(line) && !line.startsWith("| 용도"))).toHaveLength(9);

		const fallbacks = section(out, "## 한도·폴백");
		expect(fallbacks).toContain("- pa/big → pb/mid: 2건 (사유: 429 rate_limit code 1308 ×2)");
		expect(fallbacks).toContain("### 합계");
		expect(fallbacks).not.toContain("other_event");

		const settings = section(out, "## 현행 설정");
		for (const row of [
			"| modelRoles.default | pa/big:medium |",
			'| fallbackChains.default | ["pb/mid:high"] |',
			"| ompbot.model | pa/big |",
			"| ompbot.thinking | medium |",
			"| monitor.모니터A | (봇 기본) · (봇 기본) |",
			"| monitor.모니터B | pb/mid · low |",
		]) {
			expect(settings).toContain(row);
		}
		expect(section(out, "## 카탈로그 변화")).toContain("- 신규(현행 공급자): 없음");
		expect(rules(out)).toEqual(["걸린 항목 없음"]);
	});

	test("AC-1: --extra-home sessions and logs are summed, logs listed per home", () => {
		const peer = fixture();
		const out = collect({}, ["--extra-home", peer.home]);
		expect(section(out, "## 모델별 실측")).toContain("| pa/big | 10 | 7.40 |"); // 6 + 피어 4호출 3.30$
		const fallbacks = section(out, "## 한도·폴백");
		expect(fallbacks).toContain(`### ${peer.home}`);
		expect(fallbacks.slice(fallbacks.indexOf("### 합계"))).toContain("- pa/big → pb/mid: 4건");
		expect(section(out, "## 소스 상태")).toContain(`log[${peer.home}]: ok`);
	});

	test("AC-9: MCP calls right after 한도·폴백; both call shapes, errors by toolCallId, zero-call server, per use", () => {
		const out = collect();
		const lines = out.split("\n");
		expect(lines.indexOf("## MCP 호출")).toBeGreaterThan(lines.indexOf("## 한도·폴백"));
		expect(lines.indexOf("## MCP 호출")).toBeLessThan(lines.indexOf("## 현행 설정"));
		expect(section(out, "## 소스 상태")).toContain("- mcp-config: ok (3개 서버)");
		// 창 안 toolCall: t1 대화 mcp__ 이름(오류), t2 대화 write xd://(서버 키 my_srv), t6 모니터 write xd://, t7 하위 mcp__ 이름.
		// t3(local:// write)·t4(read)·t5(창 밖)·사용자 글·text 블록 언급은 세지 않는다.
		const mcp = section(out, "## MCP 호출");
		const table = mcp
			.slice(0, mcp.indexOf("### 서버별 합계"))
			.split("\n")
			.filter((l) => /^\| (?!서버|---)/.test(l));
		expect(table).toEqual([
			"| wiki | search_wiki | 2 | 1 |",
			"| my_srv | do_thing | 1 | 0 |",
			"| wiki | read_wiki_page | 1 | 0 |",
			"| idle | - | 0 | 0 |",
		]);
		const totals = mcp.slice(mcp.indexOf("### 서버별 합계"), mcp.indexOf("### 용도별"));
		expect(totals.split("\n").filter((l) => l.startsWith("- "))).toEqual([
			"- wiki: 호출 3 · 오류 1",
			"- my_srv: 호출 1 · 오류 0",
			"- idle: 호출 0 · 오류 0",
		]);
		const perUse = mcp
			.slice(mcp.indexOf("### 용도별"))
			.split("\n")
			.filter((l) => /^\| (?!용도|---)/.test(l));
		expect(perUse).toEqual([
			"| 대화 | my_srv | 1 | 0 |", // 같은 호출 수는 서버 이름순
			"| 대화 | wiki | 1 | 1 |",
			"| 모니터 | wiki | 1 | 0 |",
			"| 하위 | wiki | 1 | 0 |",
		]);
		expect(rules(out)).toEqual(["걸린 항목 없음"]); // 정보 섹션 — 규칙 없음
	});

	test("AC-9: unreadable MCP config is reported; servers fall back to the name before the first '_'", () => {
		for (const [mcp, status] of [
			[null, "- mcp-config: missing"],
			["{not json", "- mcp-config: error: "],
		] as const) {
			const out = collect({ mcp });
			expectSectionsInOrder(out);
			expect(section(out, "## 소스 상태")).toContain(status);
			const table = section(out, "## MCP 호출");
			expect(table).toContain("| my | srv_do_thing | 1 | 0 |");
			expect(table).toContain("| wiki | search_wiki | 2 | 1 |");
			expect(table).not.toContain("idle");
			expect(section(out, "## 모델별 실측")).toContain("| pa/big | 6 | 4.10 |");
		}
	});

	test("AC-1: output over 20,000 chars is cut from the per-use section on, rule verdicts survive", () => {
		const log = [
			...repeat(10, { model: "x" }).map(() => fallback(IN, "pa/big:high", "pb/mid")),
			...Array.from({ length: 400 }, (_, i) =>
				fallback(IN, `pz/very-long-model-name-for-the-cap-test-${i}`, `pq/another-long-target-model-name-${i}`),
			),
		];
		const out = collect({ log });
		expect(out.length).toBeLessThanOrEqual(20000);
		expect(out).toContain("…(잘림)");
		expect(out).toContain("## 모델별 실측\n");
		expect(out).toContain("## 규칙 판정\n");
		expect(rules(out)).toEqual(["- [R2] pa/big — 폴백 10건 (홈 합산, 창 7일)"]);
	});
});

describe("model-review rules", () => {
	const ruleOut = (options: Fixture, extra: string[] = []) => rules(collect(options, extra));
	const errorSessions = (calls: number, errors: number) => ({
		"other%2Fx/e1/s.jsonl": [
			...repeat(errors, { model: "pe/err", error: true }),
			...repeat(calls - errors, { model: "pe/err" }),
		],
	});
	const noOmp = { ompSessions: {} };

	test("AC-2 R2: 9 fallbacks no; :high 6 + :medium 4 yes", () => {
		const nine = repeat(9, { model: "x" }).map(() => fallback(IN, "pa/big:high", "pb/mid"));
		expect(ruleOut({ log: nine })).toEqual(["걸린 항목 없음"]);
		const ten = [
			...repeat(6, { model: "x" }).map(() => fallback(IN, "pa/big:high", "pb/mid")),
			...repeat(4, { model: "x" }).map(() => fallback(IN, "pa/big:medium", "pb/mid:low")),
		];
		expect(ruleOut({ log: ten })).toEqual(["- [R2] pa/big — 폴백 10건 (홈 합산, 창 7일)"]);
	});

	test("AC-2 R2: error 3%·99 calls no; 2.9%·≥100 calls no; 3%·100 calls yes", () => {
		expect(ruleOut({ sessions: errorSessions(99, 3), ...noOmp, log: [] })).toEqual(["걸린 항목 없음"]);
		// 호출 100에서 2.9%는 정수로 만들 수 없어 29/1000(호출 ≥ 100)으로 경계를 잰다.
		expect(ruleOut({ sessions: errorSessions(1000, 29), ...noOmp, log: [] })).toEqual(["걸린 항목 없음"]);
		expect(ruleOut({ sessions: errorSessions(100, 3), ...noOmp, log: [] })).toEqual([
			"- [R2] pe/err — 오류 3.00% (3/100)",
		]);
	});

	test("AC-2 R3: 하위 9.9% no; 10% yes; omp직접 60% no", () => {
		const shares = (sub: number, chat: number, omp = 0): Fixture => ({
			sessions: {
				"discord%2Fch%2F1/e1/p.jsonl": [{ model: "pa/big", cost: chat }],
				"discord%2Fch%2F1/e1/p/c.jsonl": [{ model: "pa/small", cost: sub }],
			},
			ompSessions: omp ? { "--p--/o.jsonl": [{ model: "pa/big", cost: omp }] } : {},
			log: [],
		});
		expect(ruleOut(shares(9.9, 90.1))).toEqual(["걸린 항목 없음"]);
		expect(ruleOut(shares(10, 90))).toEqual(["- [R3] 하위 — 비중 10.0% (pa/small 10.00$)"]);
		expect(ruleOut(shares(0.01, 39.99, 60))).toEqual(["걸린 항목 없음"]);
	});

	test("AC-2 R4: role keys resolved through modelRoles; effort variant, same provider, allow-list, other provider, undefined role", () => {
		const options: Fixture = {
			roles: { default: "pa/big:medium", plan: "pa/big:high", task: "pa/big", smol: "" },
			chains: {
				default: ["pa/big:high", "pb/mid"],
				plan: ["pa/small:low"],
				task: ["pb/mid:high"],
				ghost: ["pb/mid"],
				smol: ["pb/mid"],
				"pa/small:high": ["pa/big"],
			},
		};
		expect(ruleOut(options)).toEqual([
			"- [R4] default — 같은 모델의 effort 변형 (주 모델 pa/big, 첫 폴백 pa/big:high)",
			"- [R4] ghost — 역할 미정의",
			"- [R4] pa/small:high — 같은 공급자의 다른 모델 (주 모델 pa/small, 첫 폴백 pa/big)",
			"- [R4] plan — 같은 공급자의 다른 모델 (주 모델 pa/big, 첫 폴백 pa/small:low)",
			"- [R4] smol — 역할 미정의",
		]);
		expect(ruleOut(options, ["--allow-same-provider", "pa"])).toEqual([
			"- [R4] default — 같은 모델의 effort 변형 (주 모델 pa/big, 첫 폴백 pa/big:high)",
			"- [R4] ghost — 역할 미정의",
			"- [R4] smol — 역할 미정의",
		]);
	});

	test("AC-2 R5: price +19.9% no, +20% yes (used models only); R1: new chat model of a used provider", () => {
		const base = CATALOG.filter((m) => m.selector !== "pa/big");
		expect(ruleOut({ catalog: [{ selector: "pa/big", input: 11.99, output: 50 }, ...base] })).toEqual([
			"걸린 항목 없음",
		]);
		const out = collect({
			catalog: [
				{ selector: "pa/big", input: 12, output: 50 },
				...base,
				{ selector: "pa/new", input: 1, output: 2 },
				{ selector: "pa/embed", kind: "embedding", input: 1, output: 0 },
				{ selector: "pc/fresh", input: 1, output: 2 },
			],
			prev: [...CATALOG, { selector: "pc/unused", input: 1, output: 1 }],
		});
		expect(rules(out)).toEqual(["- [R1] pa/new — 신규 chat 모델 (공급자 pa)", "- [R5] pa/big — 단가 input 10→12"]);
		const catalog = section(out, "## 카탈로그 변화");
		expect(catalog).toContain("- 신규(현행 공급자): pa/embed, pa/new");
		expect(catalog).toContain("- 사라짐: pc/unused");
		expect(catalog).toContain("  - pa/big: input 10→12");
	});
});

describe("model-review missing sources", () => {
	test("AC-3: each missing source is reported, exit 0, other sections still produced", () => {
		const cases: Array<[Fixture, string[], (out: string) => void]> = [
			[
				{ sessions: null },
				["sessions: missing"],
				(out) => expect(section(out, "## 한도·폴백")).toContain("pa/big → pb/mid: 2건"),
			],
			[
				{ log: null },
				["log: missing"],
				(out) => {
					expect(section(out, "## 한도·폴백")).toContain("(소스 없음)");
					expect(section(out, "## 모델별 실측")).toContain("| pa/big | 6 |");
				},
			],
			[
				{ ompFails: true },
				["config: error: exit 3 omp: broken install", "catalog: error: exit 3 omp: broken install"],
				(out) => {
					expect(section(out, "## 현행 설정")).toContain("| ompbot.model | pa/big |");
					expect(section(out, "## 카탈로그 변화")).toContain("(소스 없음)");
					expect(section(out, "## 모델별 실측")).toContain("| pa/big | 6 |");
				},
			],
			[
				{ prev: null },
				["catalog-prev: missing"],
				(out) => expect(section(out, "## 카탈로그 변화")).toContain("비교 없음"),
			],
		];
		for (const [options, statuses, more] of cases) {
			const fx = fixture(options);
			const run = py([COLLECT, ...fx.args]);
			expect(run.code).toBe(0);
			expectSectionsInOrder(run.out);
			for (const status of statuses) expect(section(run.out, "## 소스 상태")).toContain(`- ${status}`);
			more(run.out);
		}
		const first = fixture({ prev: null });
		expect(section(py([COLLECT, ...first.args]).out, "## 카탈로그 변화")).toContain("- 기준 스냅샷 저장(비교 없음)");
	});

	test("AC-3: no --home and no OMPBOT_HOME exits 2", () => {
		const env = { ...process.env };
		delete env.OMPBOT_HOME;
		const run = py([COLLECT, "--now", NOW], env);
		expect(run.code).toBe(2);
		expect(run.err).toContain("usage:");
		expect(py([COLLECT, "--days", "0", "--home", "x"]).code).toBe(2);
	});
});

describe("model-review writes", () => {
	const listing = (root: string): string[] =>
		readdirSync(root, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => relative(root, join(entry.parentPath, entry.name)))
			.sort();

	test("AC-4: --no-snapshot writes nothing; otherwise only catalog-<date>.json; DB bytes unchanged", () => {
		const fx = fixture();
		const db = join(fx.home, "ompbot.db");
		const before = listing(fx.root);
		const hash = sha256(db);

		expect(py([COLLECT, ...fx.args, "--no-snapshot"]).code).toBe(0);
		expect(listing(fx.root)).toEqual(before);

		expect(py([COLLECT, ...fx.args]).code).toBe(0);
		const added = listing(fx.root).filter((path) => !before.includes(path));
		expect(added).toEqual([join("home", "workspace", "model-review", "catalog-2026-11-16.json")]);
		const saved = JSON.parse(readFileSync(join(fx.stateDir, "catalog-2026-11-16.json"), "utf8"));
		expect(saved["pa/big"]).toEqual({ provider: "pa", kind: "chat", input: 10, output: 50 });

		expect(py([COLLECT, ...fx.args]).code).toBe(0); // 같은 날 재실행은 덮어쓴다
		expect(listing(fx.root).filter((path) => !before.includes(path))).toEqual(added);
		expect(sha256(db)).toBe(hash);
		for (const suffix of ["-wal", "-journal", "-shm"]) expect(existsSync(db + suffix)).toBe(false);
	});
});

describe("model-review review.py check", () => {
	const dir = tempDir("model-review-check-");
	const collectFile = join(dir, "collect.md");
	writeFileSync(
		collectFile,
		[
			"## 소스 상태",
			"- config: ok",
			"",
			"## 규칙 판정",
			"- [R2] anthropic/claude-opus-5-5 — 폴백 20건 (홈 합산, 창 7일)",
			"- [R4] default — 같은 모델의 effort 변형 (주 모델 a/b, 첫 폴백 a/b:high)",
			"",
		].join("\n"),
	);
	const proposal = (n: number, fields: Partial<Record<string, string | null>> = {}) => {
		const values: Record<string, string | null> = {
			근거: "[R2] anthropic/claude-opus-5-5 — 폴백 20건",
			"바꿀 것": "omp config set retry.fallbackChains '{...}'",
			"예상 효과": "추정 폴백 절반",
			반증선: "다음 주 폴백 10건 이상",
			되돌리기: "백업 값으로 set",
			...fields,
		};
		return [
			`### P${n} 제안 ${n}`,
			...Object.entries(values)
				.filter(([, value]) => value !== null)
				.map(([key, value]) => `- ${key}: ${value}`),
		].join("\n");
	};
	const report = (body: string[]) =>
		["# 주간 모델 점검 2026-W47", "기간: 2026-11-09 ~ 2026-11-15 (KST)", "", "## 제안", ...body, ""].join("\n");
	const check = (name: string, text: string, withCollect = true) => {
		const path = join(dir, name);
		writeFileSync(path, text);
		return py([REVIEW, "check", path, ...(withCollect ? ["--collect", collectFile] : [])]);
	};

	test("AC-5: a valid report and a no-proposal report pass", () => {
		const ok = check(
			"ok.md",
			report([proposal(1), proposal(2, { 근거: "[R4] default — effort 변형, [R2] anthropic/claude-opus-5-5 — 20건" })]),
		);
		expect(ok.err).toBe("");
		expect(ok.code).toBe(0);
		const none = check("none.md", report(["제안 없음"]));
		expect(none.err).toBe("");
		expect(none.code).toBe(0);
	});

	const violations: Array<[string, string]> = [
		["skipped number", report([proposal(1), proposal(3)])],
		["six proposals", report([1, 2, 3, 4, 5, 6].map((n) => proposal(n)))],
		["missing field", report([proposal(1, { 반증선: null })])],
		["no 추정", report([proposal(1, { "예상 효과": "폴백 절반" })])],
		["no rule tag", report([proposal(1, { 근거: "느낌상 비쌈" })])],
		["tag not in collect output", report([proposal(1, { 근거: "[R5] anthropic/claude-opus-5-5 — 단가" })])],
		["tag with another target", report([proposal(1, { 근거: "[R2] zai/glm-5.3 — 폴백 9건" })])],
		["bad title", report([proposal(1)]).replace("# 주간 모델 점검 2026-W47", "# 모델 점검")],
		["empty proposals", report([])],
	];
	for (const [name, text] of violations) {
		test(`AC-5: ${name} exits 2 with a line-numbered message`, () => {
			const run = check(`${name.replaceAll(" ", "-")}.md`, text);
			expect(run.code).toBe(2);
			expect(run.err).toMatch(/^줄 \d+: \S/m);
		});
	}

	test("AC-5: the wrong-target message points at the 근거 line", () => {
		const text = report([proposal(1, { 근거: "[R2] zai/glm-5.3 — 폴백 9건" })]);
		const run = check("target-line.md", text);
		const line = text.split("\n").findIndex((l) => l.startsWith("- 근거:")) + 1;
		expect(run.err).toContain(`줄 ${line}: P1의 근거 [R2] zai/glm-5.3`);
		expect(check("target-no-collect.md", text, false).code).toBe(0); // 대조는 --collect가 있을 때만
	});

	test("AC-5: the real collector output is a valid --collect input", () => {
		const out = collect({ log: repeat(10, { model: "x" }).map(() => fallback(IN, "pa/big:high", "pb/mid")) });
		const path = join(dir, "real-collect.md");
		writeFileSync(path, out);
		const report1 = join(dir, "real-report.md");
		writeFileSync(report1, report([proposal(1, { 근거: "[R2] pa/big — 폴백 10건" })]));
		const run = py([REVIEW, "check", report1, "--collect", path]);
		expect(run.err).toBe("");
		expect(run.code).toBe(0);
	});
});

describe("model-review package", () => {
	test("AC-6: monitor.json parses after @OMPBOT_HOME@ substitution; Monday 08:40 cron, no model", () => {
		const home = tempDir("model-review-install-");
		const scriptsRoot = join(home, "scripts");
		mkdirSync(scriptsRoot);
		const installed = join(scriptsRoot, "model-review-procedure.md");
		copyFileSync(join(PKG, "procedure.md"), installed);
		const template = readFileSync(join(PKG, "monitor.json"), "utf8");
		const raw = JSON.parse(template.replaceAll("@OMPBOT_HOME@", home));
		expect(raw.procedureFiles).toEqual([installed]);
		const spec = parseMonitorSpec(raw, { scriptsRoot, defaultTimezone: "Asia/Seoul" });
		expect(spec.trigger).toEqual({ kind: "cron", schedule: "40 8 * * 1", timezone: "Asia/Seoul" });
		expect(spec.model).toBeUndefined();
		expect(spec.thinking).toBe("medium");
		expect(spec.overlap).toBe("skip");
		expect(spec.name).toBe("주간 모델 점검");
	});

	test("AC-6: no model names, model keys or /home/ paths anywhere in the package", () => {
		const files = readdirSync(PKG);
		expect(files.sort()).toEqual(["README.md", "collect.py", "monitor.json", "procedure.md", "review.py"]);
		for (const file of files) {
			const text = readFileSync(join(PKG, file), "utf8");
			for (const banned of ['"model":', "claude-", "glm-", "gemini-", "/home/"]) {
				expect({ file, banned, found: text.includes(banned) }).toEqual({ file, banned, found: false });
			}
		}
	});

	test("procedure.md runs the installed scripts through @OMPBOT_HOME@ and @COLLECT_ARGS@", () => {
		const procedure = readFileSync(join(PKG, "procedure.md"), "utf8");
		expect(procedure).toContain(
			"python3 @OMPBOT_HOME@/scripts/model-review-collect.py --home @OMPBOT_HOME@ @COLLECT_ARGS@ > @OMPBOT_HOME@/workspace/model-review/collect-<날짜>.md",
		);
		expect(procedure).toContain("python3 @OMPBOT_HOME@/scripts/model-review.py check");
		expect(readFileSync(join(PKG, "README.md"), "utf8")).toContain("@COLLECT_ARGS@");
	});
});
