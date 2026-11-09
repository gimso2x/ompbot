import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDashboardMain, renderItemDetail, renderMonitorDetail } from "../src/dashboard/html";
import { readMonitorDetail } from "../src/dashboard/monitor-detail";
import { startDashboardServer } from "../src/dashboard/server";
import { buildSnapshot, type DashboardSnapshot, type MonitorInfo, type SnapshotDeps } from "../src/dashboard/snapshot";
import { openStore } from "../src/store/db";
import { formatKst } from "../src/tasks/docs";

/** 2026-11-06 01:00 KST (a Friday). */
const NOW = Date.parse("2026-11-05T16:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A Slack bot token shape `redact` masks, put together here so no token literal sits in the file. */
const TOKEN = ["xox", "b-", "1234567890-abcdefABCDEF"].join("");

/** The production instructions' opening and script sentences as the owner wrote them (2026-11-06). */
const MORNING_BRIEF =
	"아침 브리핑을 쓴다.\n1) `python3 /home/owner/.ompbot/scripts/morning-brief-collect.py`를 한 번만 실행한다.";
const LEDGER_SUMMARY =
	"전달 장부 요약을 올린다. `python3 /home/owner/.ompbot/scripts/ledger-summary.py`를 한 번 실행하고, 그 출력을 그대로 답한다.";
const cron = (schedule: string, timezone = "Asia/Seoul") => ({ kind: "cron", schedule, timezone });

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ompbot-dash-monitors-"));
	openStore({ path: join(home, "ompbot.db"), clock: { now: () => NOW }, redact: (text) => text }).close();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

interface Mon {
	id: string;
	name: string;
	trigger: unknown;
	instruction?: string;
	channel?: string;
	copyChannel?: string;
	model?: string;
	thinking?: string;
	procedureFiles?: string[];
}

interface Ev {
	slotAt: number;
	updatedAt: number;
	stage: string;
	attempts?: number;
	manual?: boolean;
	answer?: string;
	payload?: string;
	error?: string;
}

function insert(table: string, rows: Array<Record<string, string | number | null>>): void {
	const db = new Database(join(home, "ompbot.db"), { strict: true });
	for (const row of rows) {
		const keys = Object.keys(row);
		db.run(`INSERT INTO ${table} (${keys}) VALUES (${keys.map(() => "?")})`, Object.values(row));
	}
	db.close();
}

function addMonitors(monitors: Mon[]): void {
	insert(
		"monitors",
		monitors.map((m, index) => ({
			id: m.id,
			name: m.name,
			trigger_json: JSON.stringify(m.trigger),
			instruction: m.instruction ?? `${m.name}을 한다.`,
			channel: m.channel ?? null,
			copy_channel: m.copyChannel ?? null,
			model: m.model ?? null,
			thinking: m.thinking ?? null,
			procedure_files: m.procedureFiles === undefined ? null : JSON.stringify(m.procedureFiles),
			cursor_at: NOW,
			created_at: NOW - 1_000 * (monitors.length - index),
			updated_at: NOW,
		})),
	);
}

function addEvents(monitorId: string, events: Ev[]): void {
	insert(
		"monitor_events",
		events.map((e) => ({
			monitor_id: monitorId,
			slot_at: e.slotAt,
			stage: e.stage,
			payload: e.payload ?? null,
			attempts: e.attempts ?? 0,
			answer: e.answer ?? null,
			error: e.error ?? null,
			manual: e.manual ? 1 : 0,
			created_at: e.slotAt,
			updated_at: e.updatedAt,
		})),
	);
}

/** A home with only a database (and config channels): the monitors section is under test. */
function deps(): SnapshotDeps {
	return {
		homeDir: home,
		repoDir: "/srv/ompbot",
		config: { logChannel: "C0LOG", escalationChannel: "C0ESC" },
		now: () => NOW,
		callDaemon: async () => {
			throw new Error("no daemon");
		},
		run: async () => ({ code: 1, stdout: "", timedOut: false }),
		ompVersion: async () => "omp-stub 0.0.0",
		hostOps: () => {
			throw new Error("no hosts");
		},
		collectGates: () => [],
	};
}

async function monitorsOf(): Promise<{ snapshot: DashboardSnapshot; items: MonitorInfo[]; json: string }> {
	const snapshot = await buildSnapshot(deps());
	if (!snapshot.monitors.ok) throw new Error(snapshot.monitors.error);
	return { snapshot, items: snapshot.monitors.items, json: JSON.stringify(snapshot) };
}

const byName = (items: MonitorInfo[], name: string): MonitorInfo => {
	const found = items.find((item) => item.name === name);
	if (found === undefined) throw new Error(`no monitor ${name}`);
	return found;
};

const monitorsHtml = (snapshot: DashboardSnapshot): string =>
	renderDashboardMain(snapshot, undefined, NOW, { view: "monitors" });

/** The `<a class="row …">` of one monitor in the monitors view. */
function rowHtml(html: string, id: string): string {
	const start = html.indexOf(`data-row="${id}"`);
	if (start < 0) throw new Error(`no row ${id}`);
	const from = html.lastIndexOf("<a ", start);
	return html.slice(from, html.indexOf("</a>", start) + 4);
}

const textOf = (html: string): string => html.replace(/<[^>]*>/g, "");

describe("dashboard monitors snapshot", () => {
	test("AC-1: cron in words in its time zone; at, script and webhook lines", async () => {
		addMonitors([
			{ id: "c1", name: "매일", trigger: cron("30 7 * * *") },
			{ id: "c2", name: "평일", trigger: cron("0 9 * * 1-5") },
			{ id: "c3", name: "요일", trigger: cron("0 9 * * 1,3") },
			{ id: "c4", name: "매시", trigger: cron("15 * * * *") },
			{ id: "c5", name: "분마다", trigger: cron("*/10 * * * *") },
			{ id: "c6", name: "그밖", trigger: cron("0 */6 * * *") },
			{ id: "c7", name: "UTC", trigger: cron("30 22 * * *", "UTC") },
			{ id: "a1", name: "한번", trigger: { kind: "at", at: "2026-11-07T00:30:00.000Z" } },
			{
				id: "s1",
				name: "조건",
				trigger: { kind: "script", command: ["/srv/scripts/check.sh", "--secret-arg"], intervalMs: 5 * MINUTE },
			},
			{ id: "w1", name: "훅", trigger: { kind: "webhook", id: "hook-id", token: "hook-token-value" } },
		]);
		const { items, json } = await monitorsOf();
		expect(Object.fromEntries(items.map((item) => [item.name, item.schedule]))).toEqual({
			매일: "매일 07:30",
			평일: "평일 09:00",
			요일: "매주 월·수 09:00",
			매시: "매시 15분",
			분마다: "10분마다",
			그밖: "cron 0 */6 * * *",
			UTC: "매일 22:30 (UTC)",
			한번: "한 번 · 11-07 09:30",
			조건: "조건 감시 · 5분마다",
			훅: "외부 호출 때",
		});
		expect(byName(items, "매일").cron).toBe("30 7 * * * (Asia/Seoul)");
		expect(byName(items, "UTC").cron).toBe("30 22 * * * (UTC)");
		expect(byName(items, "한번").cron).toBeNull();
		// The script command and the webhook secret stay out of the snapshot.
		for (const leak of ["--secret-arg", "hook-token-value"]) expect(json).not.toContain(leak);
	});

	test("AC-2: summary is the masked first sentence (80 chars); the rest and event bodies stay out", async () => {
		const longFirst = `${"가".repeat(90)}를 정리한다. TAIL-MARKER-AFTER-80 ${"나".repeat(40)}`;
		addMonitors([
			{ id: "long", name: "긴 지시", trigger: { kind: "at", at: "2026-11-07T00:00:00.000Z" }, instruction: longFirst },
			{
				id: "latin",
				name: "라틴",
				trigger: { kind: "at", at: "2026-11-07T00:00:00.000Z" },
				instruction: "README.md 의 내용을 본다. 다음 줄은 SECOND-SENTENCE-MARKER 를 담는다.",
			},
			{
				id: "token",
				name: "토큰",
				trigger: { kind: "at", at: "2026-11-07T00:00:00.000Z" },
				instruction: `토큰 ${TOKEN} 으로 v1.0 을 확인한다? 그 뒤 AFTER-QUESTION-MARKER`,
			},
		]);
		addEvents("long", [
			{
				slotAt: NOW - HOUR,
				updatedAt: NOW - HOUR + MINUTE,
				stage: "failed",
				answer: "ANSWER-MUST-NOT-LEAK",
				payload: "PAYLOAD-MUST-NOT-LEAK",
				error: "ERROR-MUST-NOT-LEAK",
			},
		]);
		const { items, json } = await monitorsOf();
		expect(longFirst.length).toBeGreaterThan(120);
		const long = byName(items, "긴 지시");
		expect(Array.from(long.summary)).toHaveLength(80);
		expect(long.summary).toBe(`${"가".repeat(79)}…`);
		expect(byName(items, "라틴").summary).toBe("README.md 의 내용을 본다.");
		expect(byName(items, "토큰").summary).toBe("토큰 [REDACTED] 으로 v1.0 을 확인한다?");
		for (const leak of [
			longFirst.slice(80),
			"TAIL-MARKER-AFTER-80",
			"SECOND-SENTENCE-MARKER",
			"AFTER-QUESTION-MARKER",
			TOKEN,
			"ANSWER-MUST-NOT-LEAK",
			"PAYLOAD-MUST-NOT-LEAK",
			"ERROR-MUST-NOT-LEAK",
		]) {
			expect(json).not.toContain(leak);
		}
	});

	test("AC-3: next-fire order, destination and copy names, bare file names", async () => {
		addMonitors([
			{
				id: "late",
				name: "늦게",
				trigger: cron("0 23 * * *"),
				channel: "C0OTHER",
				copyChannel: "C0LOG",
				procedureFiles: ["procedures/owner-distill.md", "/srv/elsewhere/scripts/a.md"],
				instruction: "절차를 따른다. `bash ~/.ompbot/scripts/check-disk.sh`와 run.ts 를 본다.",
			},
			{ id: "hook", name: "훅", trigger: { kind: "webhook", id: "h", token: "t" }, channel: "C0ESC" },
			{ id: "early", name: "아침 브리핑", trigger: cron("0 2 * * *"), instruction: MORNING_BRIEF },
			{
				id: "mid",
				name: "전달 장부 요약",
				trigger: { kind: "at", at: "2026-11-05T18:00:00.000Z" },
				channel: "C0LOG",
				copyChannel: "C0ESC",
				instruction: LEDGER_SUMMARY,
			},
		]);
		const { snapshot, items, json } = await monitorsOf();
		expect(items.map((item) => [item.id, item.nextFireAt])).toEqual([
			["early", "2026-11-06T02:00:00+09:00"],
			["mid", "2026-11-06T03:00:00+09:00"],
			["late", "2026-11-06T23:00:00+09:00"],
			["hook", null],
		]);
		expect(items.map((item) => [item.destination, item.copyTo])).toEqual([
			["오너 DM", null],
			["로그 채널", "에스컬레이션 채널"],
			["채널 C0OTHER", "로그 채널"],
			["에스컬레이션 채널", null],
		]);
		expect(byName(items, "아침 브리핑").files).toEqual([{ kind: "script", name: "morning-brief-collect.py" }]);
		expect(byName(items, "전달 장부 요약").files).toEqual([{ kind: "script", name: "ledger-summary.py" }]);
		expect(byName(items, "늦게").files).toEqual([
			{ kind: "procedure", name: "owner-distill.md" },
			{ kind: "procedure", name: "a.md" },
			{ kind: "script", name: "check-disk.sh" },
			{ kind: "script", name: "run.ts" },
		]);
		for (const item of items) for (const file of item.files) expect(file.name).not.toContain("/");
		for (const leak of ["/home/owner/.ompbot/scripts", "/srv/elsewhere", "procedures/owner-distill.md"]) {
			expect(json).not.toContain(leak);
		}
		const html = monitorsHtml(snapshot);
		expect(rowHtml(html, "late")).toContain("+ 사본 로그 채널");
		expect(rowHtml(html, "mid")).toContain("+ 사본 에스컬레이션 채널");
		expect(rowHtml(html, "early")).not.toContain("+ 사본");
	});

	test("AC-4: last 7 events oldest first; lastRun duration and attempts; 지연 포함", async () => {
		addMonitors([
			{ id: "mon", name: "재시도", trigger: cron("55 23 * * *") },
			{ id: "run", name: "도는 중", trigger: cron("0 1 * * *") },
			{ id: "wait", name: "대기 중", trigger: cron("0 1 * * *") },
			{ id: "skew", name: "시계", trigger: cron("0 1 * * *") },
		]);
		const day = 24 * HOUR;
		const stages = "failed delivered no_report delivered skipped failed_no_retry no_report authored".split(" ");
		const events: Ev[] = stages.map((stage, index) => ({
			slotAt: NOW - (9 - index) * day,
			updatedAt: NOW - (9 - index) * day + 5 * MINUTE,
			stage,
			manual: index === 6,
		}));
		// The last one: three retries, the 23:55 slot delivered the next morning.
		events.push({ slotAt: NOW - 7 * HOUR, updatedAt: NOW - 45 * MINUTE, stage: "delivered", attempts: 3 });
		addEvents("mon", events);
		addEvents("run", [{ slotAt: NOW - 5 * MINUTE, updatedAt: NOW - 4 * MINUTE, stage: "dispatched", attempts: 1 }]);
		addEvents("wait", [{ slotAt: NOW - MINUTE, updatedAt: NOW - MINUTE, stage: "admitted" }]);
		addEvents("skew", [{ slotAt: NOW, updatedAt: NOW - 1_000, stage: "no_report", manual: true }]);
		const { snapshot, items } = await monitorsOf();
		const mon = byName(items, "재시도");
		expect(mon.recent).toEqual(
			events.slice(2).map((e) => ({ stage: e.stage, manual: e.manual === true, at: formatKst(e.updatedAt) })),
		);
		expect(mon.lastRun).toEqual({
			stage: "delivered",
			at: formatKst(NOW - 45 * MINUTE),
			slotAt: formatKst(NOW - 7 * HOUR),
			durationMs: 6 * HOUR + 15 * MINUTE,
			attempts: 3,
			manual: false,
		});
		expect(byName(items, "도는 중").lastRun).toMatchObject({ stage: "dispatched", durationMs: null, attempts: 1 });
		expect(byName(items, "대기 중").lastRun).toMatchObject({ stage: "admitted", durationMs: null, attempts: 0 });
		expect(byName(items, "시계").lastRun).toMatchObject({ stage: "no_report", durationMs: 0, manual: true });
		const html = monitorsHtml(snapshot);
		const retried = textOf(rowHtml(html, "mon"));
		expect(retried).toContain("재시도 3회");
		expect(retried).toContain("지연 포함 6시간 15분");
		expect(textOf(rowHtml(html, "run"))).toContain("진행 중 · 시작 후 5분");
		expect(textOf(rowHtml(html, "skew"))).not.toContain("재시도");
	});
});

describe("dashboard monitors view", () => {
	test("AC-5: rows show summary, schedule, destination; 조용히 끝남, 수동, labelled dots", async () => {
		addMonitors([
			{
				id: "quiet",
				name: "관찰지 증류",
				trigger: cron("40 23 * * *"),
				instruction: "오너 관찰지를 증류한다. 큰 변화가 없으면 정확히 [SILENT] 한 줄로만 답한다.",
				model: "anthropic/claude-sonnet-5-5",
				procedureFiles: ["procedures/owner-distill.md"],
			},
			{
				id: "greet",
				name: "아침 인사",
				trigger: cron("30 7 * * *"),
				instruction: "오너에게 아침 인사를 한다. 절차를 따른다.",
				channel: "C0LOG",
			},
			{ id: "busy", name: "수동 잦음", trigger: cron("0 9 * * *") },
		]);
		// The one scheduled run sits behind 8 manual ones, outside the 7 recent dots.
		addEvents("busy", [
			{ slotAt: NOW - 30 * HOUR, updatedAt: NOW - 30 * HOUR + MINUTE, stage: "delivered" },
			...Array.from({ length: 8 }, (_, i) => ({
				slotAt: NOW - (9 - i) * HOUR,
				updatedAt: NOW - (9 - i) * HOUR + MINUTE,
				stage: "delivered",
				manual: true,
			})),
		]);
		addEvents("quiet", [
			{ slotAt: NOW - 26 * HOUR, updatedAt: NOW - 26 * HOUR + MINUTE, stage: "no_report" },
			{ slotAt: NOW - 2 * HOUR, updatedAt: NOW - 2 * HOUR + 30_000, stage: "no_report" },
		]);
		addEvents("greet", [
			{ slotAt: NOW - 15 * HOUR, updatedAt: NOW - 15 * HOUR + 59_000, stage: "delivered", manual: true },
		]);
		const { snapshot } = await monitorsOf();
		const html = monitorsHtml(snapshot);
		const quiet = rowHtml(html, "quiet");
		const words = {
			quiet: [
				"오너 관찰지를 증류한다.",
				"매일 23:40",
				"→ 오너 DM",
				"claude-sonnet-5-5",
				"절차 owner-distill.md",
				"조용히 끝남",
			],
			greet: ["오너에게 아침 인사를 한다.", "매일 07:30", "→ 로그 채널", "기본 모델", "수동", "정기 실행 아직 없음"],
		};
		for (const [id, list] of Object.entries(words))
			for (const word of list) expect(textOf(rowHtml(html, id))).toContain(word);
		const greet = rowHtml(html, "greet");
		const busy = textOf(rowHtml(html, "busy"));
		expect(busy).toContain("수동");
		expect(busy).not.toContain("정기 실행 아직 없음");
		expect(textOf(html)).not.toContain("no_report");
		for (const row of [quiet, greet]) {
			const dots = row.match(/<span class="mon-dot[ "][^>]*>/g) ?? [];
			expect(dots).toHaveLength(7);
			for (const dot of dots) expect(dot).toMatch(/aria-label="[^"]+"/);
		}
		expect(quiet).toContain(
			`aria-label="${formatKst(NOW - 2 * HOUR + 30_000)
				.slice(5, 16)
				.replace("T", " ")} 조용히 끝남"`,
		);
		expect(greet).toMatch(/aria-label="[^"]*전달 · 수동"/);
	});

	test("AC-6: api/monitor/detail: masked instruction, procedure heads, last 10 runs, errors", async () => {
		const workspaceDir = join(home, "workspace");
		const scriptsRoot = join(home, "scripts");
		mkdirSync(join(workspaceDir, "procedures"), { recursive: true });
		mkdirSync(scriptsRoot);
		writeFileSync(join(workspaceDir, "procedures", "guide.md"), `# 절차\n토큰 ${TOKEN}\n${"나".repeat(2500)}`);
		const instruction = `점검한다. 토큰 ${TOKEN}\n둘째 줄 ${"다".repeat(5000)}`;
		addMonitors([
			{
				id: "mon-a",
				name: "점검",
				trigger: cron("0 9 * * *"),
				instruction,
				procedureFiles: ["procedures/guide.md", "procedures/missing.md"],
			},
		]);
		const events: Ev[] = Array.from({ length: 12 }, (_, index) => ({
			slotAt: NOW - (12 - index) * HOUR,
			updatedAt: NOW - (12 - index) * HOUR + 2 * MINUTE,
			stage: index === 11 ? "failed" : "delivered",
			attempts: index === 11 ? 2 : 0,
			manual: index === 10,
			answer: `ANSWER-LEAK-${index}`,
			payload: `PAYLOAD-LEAK-${index}`,
			...(index === 11 ? { error: `boom ${TOKEN} ${"x".repeat(200)}\nsecond line` } : {}),
		}));
		addEvents("mon-a", events);
		const roots = { workspaceDir, scriptsRoot };
		const detail = readMonitorDetail(home, roots, "mon-a");
		if (!detail.ok) throw new Error(detail.error);
		expect(detail.instruction.startsWith("점검한다. 토큰 [REDACTED]\n둘째 줄 ")).toBe(true);
		expect(Array.from(detail.instruction)).toHaveLength(4000);
		expect(detail.instruction.endsWith("…")).toBe(true);
		expect(detail.procedures).toHaveLength(2);
		const guide = detail.procedures[0];
		if (guide === undefined || !("text" in guide)) throw new Error("guide.md was not read");
		expect(guide).toMatchObject({ name: "guide.md", truncated: true });
		expect(guide.text.startsWith("# 절차\n토큰 [REDACTED]\n")).toBe(true);
		expect(Array.from(guide.text)).toHaveLength(2000);
		expect(detail.procedures[1]).toEqual({ name: "missing.md", error: "unreadable" });
		expect(detail.runs).toHaveLength(10);
		expect(detail.runs[0]).toEqual({
			slotAt: formatKst(NOW - HOUR),
			at: formatKst(NOW - HOUR + 2 * MINUTE),
			stage: "failed",
			manual: false,
			attempts: 2,
			durationMs: 2 * MINUTE,
			error: `boom [REDACTED] ${"x".repeat(200)}`.slice(0, 160),
		});
		expect(detail.runs[1]).toMatchObject({ manual: true, error: null });
		expect(detail.runs.map((run) => run.slotAt)).toEqual(
			events
				.slice(2)
				.reverse()
				.map((e) => formatKst(e.slotAt)),
		);
		const json = JSON.stringify(detail);
		for (const leak of [TOKEN, "ANSWER-LEAK", "PAYLOAD-LEAK", "second line", join(workspaceDir, "procedures")]) {
			expect(json).not.toContain(leak);
		}

		const { snapshot } = await monitorsOf();
		const errors: unknown[] = [];
		const server = startDashboardServer({
			port: 0,
			hostname: "127.0.0.1",
			snapshot: async () => snapshot,
			monitorDetail: (id) => {
				if (id === "explode") throw new Error("boom");
				return readMonitorDetail(id === "no-db" ? join(home, "absent") : home, roots, id);
			},
			onError: (error) => errors.push(error),
		});
		const bare = startDashboardServer({ port: 0, hostname: "127.0.0.1", snapshot: async () => snapshot });
		try {
			const base = `http://127.0.0.1:${server.port}`;
			const get = async (path: string, init?: RequestInit) => {
				const response = await fetch(`${base}${path}`, init);
				return { status: response.status, body: await response.text() };
			};
			const ok = await get("/api/monitor/detail?id=mon-a");
			expect(ok.status).toBe(200);
			expect(JSON.parse(ok.body)).toEqual(JSON.parse(JSON.stringify(detail)));
			for (const leak of ["ANSWER-LEAK", "PAYLOAD-LEAK", TOKEN]) expect(ok.body).not.toContain(leak);
			expect((await get("/task/api/monitor/detail?id=mon-a")).status).toBe(200);
			for (const [id, status, error] of [
				["", 400, "invalid_id"],
				["nope", 404, "unknown_monitor"],
				["no-db", 404, "no_database"],
				["explode", 500, "monitor_detail_failed"],
			] as const) {
				expect(await get(`/api/monitor/detail?id=${id}`)).toEqual({ status, body: JSON.stringify({ error }) });
			}
			expect(errors).toHaveLength(1);
			expect((await get("/api/monitor/detail?id=mon-a", { method: "POST" })).status).toBe(405);
			const disabled = await fetch(`http://127.0.0.1:${bare.port}/api/monitor/detail?id=mon-a`);
			expect(disabled.status).toBe(404);
			expect(await disabled.text()).toBe('{"error":"monitor_detail_disabled"}');
		} finally {
			server.stop(true);
			bare.stop(true);
		}

		// The row links by id; an old link by name opens the same panel.
		const html = monitorsHtml(snapshot);
		expect(rowHtml(html, "mon-a")).toContain('href="?view=monitors&amp;item=mon-a"');
		const byId = renderItemDetail(snapshot, "monitors", "mon-a");
		expect(byId).toContain("점검");
		expect(byId).toContain("하는 일");
		expect(renderItemDetail(snapshot, "monitors", "점검")).toBe(byId);
		const filled = renderItemDetail(snapshot, "monitors", "mon-a", renderMonitorDetail(detail));
		expect(filled).toContain("토큰 [REDACTED]");
		expect(filled).toContain("guide.md");
		expect(filled).toContain("지연 포함");
		expect(filled).toContain("재시도 2회");
	});

	test("AC-7: a <script> in the instruction or a procedure file stays text", async () => {
		const workspaceDir = join(home, "workspace");
		mkdirSync(join(workspaceDir, "procedures"), { recursive: true });
		writeFileSync(join(workspaceDir, "procedures", "x.md"), "<script>alert(2)</script> 절차");
		addMonitors([
			{
				id: "xss",
				name: "<img src=x onerror=alert(3)>",
				trigger: cron("0 9 * * *"),
				instruction: "<script>alert(1)</script> 를 본다. 다음",
				procedureFiles: ["procedures/x.md"],
			},
		]);
		addEvents("xss", [
			{ slotAt: NOW - HOUR, updatedAt: NOW - HOUR, stage: "failed", error: "<script>alert(4)</script>" },
		]);
		const { snapshot, items } = await monitorsOf();
		expect(byName(items, "<img src=x onerror=alert(3)>").summary).toBe("<script>alert(1)</script> 를 본다.");
		const detail = readMonitorDetail(home, { workspaceDir, scriptsRoot: join(home, "scripts") }, "xss");
		if (!detail.ok) throw new Error(detail.error);
		const loading = renderItemDetail(snapshot, "monitors", "xss");
		expect(loading).not.toContain("<script");
		expect(loading).toContain("&lt;img src=x onerror=alert(3)&gt;");
		for (const html of [
			monitorsHtml(snapshot),
			renderItemDetail(snapshot, "monitors", "xss", renderMonitorDetail(detail)),
		]) {
			expect(html).not.toContain("<script");
			expect(html).not.toContain("<img");
			expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		}
		const loaded = renderMonitorDetail(detail);
		expect(loaded).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
		expect(loaded).toContain("&lt;script&gt;alert(4)&lt;/script&gt;");
	});
});
