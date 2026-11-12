// AC-1 of T-20261111-01: the one-page briefing HTML — section titles and summary numbers, 6 lines + `외 N개`,
// `ok: false` sections marked unreadable while the rest still render, HTML escaped, secrets masked.
import { describe, expect, test } from "bun:test";
import { briefingSummaryLine, renderBriefingHtml } from "../src/dashboard/briefing";
import type { DashboardSnapshot, MonitorInfo, TurnInfo } from "../src/dashboard/snapshot";

/** 2026-11-11 07:30 KST. */
const NOW = Date.parse("2026-11-10T22:30:00Z");

const turn = (inboundId: number, extra: Partial<TurnInfo> = {}): TurnInfo => ({
	inboundId,
	originKey: "slack/dm/D1",
	threadRef: "D1:1.0",
	state: "dispatched",
	createdAt: "2026-11-11T07:00:00+09:00",
	ageMs: 30 * 60_000,
	silentMs: 30_000,
	stalled: false,
	kind: "message",
	preview: `turn ${inboundId}`,
	waitReason: null,
	blocksRestart: false,
	topLevel: false,
	slash: false,
	...extra,
});

const monitor = (name: string, extra: Partial<MonitorInfo> = {}): MonitorInfo =>
	({
		id: `m-${name}`,
		name,
		kind: "procedure",
		schedule: "cron",
		cron: "0 8 * * *",
		summary: "",
		destination: "#status",
		copyTo: null,
		model: null,
		thinking: null,
		deliver: "always",
		overlap: "queue",
		files: [],
		nextFireAt: "2026-11-11T17:00:00+09:00",
		lastStage: "delivered",
		lastAt: "2026-11-11T08:00:00+09:00",
		openIncidents: 0,
		recent: [],
		lastRun: null,
		scheduledRun: true,
		originKey: "monitor/x",
		running: false,
		failStreak: 0,
		stats: { days: 30, delivered: 0, quiet: 0, failed: 0, skipped: 0, medianMs: null },
		...extra,
	}) as MonitorInfo;

/** A daemon section that answered: everything else starts out readable-but-empty, so a test only fills what it reads. */
const snapshot = (extra: Partial<DashboardSnapshot> = {}): DashboardSnapshot => ({
	generatedAt: "2026-11-11T07:30:00+09:00",
	timezone: "Asia/Seoul",
	daemon: {
		ok: true,
		running: true,
		ompVersion: "omp 1.0.0",
		origins: 2,
		busy: 1,
		ledger: { pending: 0, inflight: 1, confirmed: 9, ambiguous: 0, expired: 0 },
		inbound: { pending: 0, dispatched: 1, answered: 9, failed_notified: 0, discarded: 0 },
		monitors: { count: 2, next: null },
		openGates: [],
		commit: "abc1234",
		started: { at: "2026-11-11T06:00:00+09:00", ageMs: 90 * 60_000 },
	},
	turns: { ok: true, items: [], threads: [] },
	feedback: { ok: true, days: 7, up: 0, down: 0, recentDown: [], verdicts: {} },
	tasks: { ok: true, items: [] },
	lanes: { ok: true, items: [] },
	herdr: { ok: true, hosts: [] },
	approvals: {
		ok: true,
		items: [],
		recent: [],
		stats: { days: 7, approved: 0, denied: 0, expired: 0, replied: 0, medianAnswerMs: null },
	},
	monitors: { ok: true, items: [] },
	alerts: { ok: true, items: [] },
	gates: { ok: true, items: [] },
	backup: { ok: true, local: { at: "2026-11-11T04:00:00+09:00", ageMs: 3.5 * 3_600_000 } },
	jobs: { ok: true, items: [] },
	...extra,
});

/** The HTML without tags, one line per element: assertions read the words, not the markup. */
const text = (html: string): string =>
	html
		.replace(/<script[\s\S]*?<\/script>/g, "")
		.replace(/<style[\s\S]*?<\/style>/g, "")
		.replace(/<[^>]+>/g, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.join("\n");

describe("briefingSummaryLine (qa50b N-12, 레인 M 이관)", () => {
	test("counts the same six numbers as the page summary: an open lane and a failing monitor alone are not 이상 없음", () => {
		const shot = snapshot({
			lanes: { ok: true, items: [{ name: "l1", status: "working" }] } as never,
			monitors: { ok: true, items: [monitor("broken", { failStreak: 2 })] },
		});
		const line = briefingSummaryLine(shot);
		expect(line).toContain("레인 1");
		expect(line).toContain("모니터 실패 1");
		// Every non-zero number of the page summary is in the line, in the page's order.
		const page = /주의 \d+ · 진행 TASK \d+ · 레인 \d+ · 승인 대기 \d+ · 게이트 열림 \d+ · 모니터 실패 \d+/.exec(
			text(renderBriefingHtml(shot, NOW)),
		)?.[0];
		const nonZero = (page ?? "").split(" · ").filter((part) => !part.endsWith(" 0"));
		expect(line).toBe(nonZero.join(" · "));
		expect(briefingSummaryLine(snapshot())).toBe("이상 없음");
	});
});

describe("AC-1: briefing render", () => {
	test("head, summary numbers and every section title with an empty state", () => {
		const html = renderBriefingHtml(snapshot(), NOW);
		const body = text(html);
		expect(body).toContain("ompbot 브리핑 · 2026-11-11 07:30");
		expect(body).toContain("데몬 실행 중 · abc1234 · 1시간 30분째");
		expect(body).toContain("주의 0 · 진행 TASK 0 · 레인 0 · 승인 대기 0 · 게이트 열림 0 · 모니터 실패 0");
		for (const title of ["주의", "진행 중", "모니터", "바닥"]) expect(body).toContain(title);
		// Local backup stamp and the snapshot time are the last line.
		expect(body).toContain("백업 2026-11-11 04:00 (3시간 전)");
		expect(html).toContain("width:1080px");
		expect(html).toContain('"NanumBarunGothic","NanumGothic",sans-serif');
		// No external resource: the fonts are named, not fetched.
		expect(html).not.toContain("http://");
		expect(html).not.toContain("https://");
		expect(html).toContain(
			'window.addEventListener("load",()=>{document.title=String(document.documentElement.scrollHeight)})',
		);
	});

	test("the summary counts what the attention section lists, and a non-zero attention is emphasized", () => {
		const html = renderBriefingHtml(
			snapshot({
				gates: {
					ok: true,
					items: [
						{ name: "backup_age", state: "open", detail: "백업 40시간 없음" },
						{ name: "turns_failing", state: "closed", detail: "ok" },
					],
				},
				approvals: {
					ok: true,
					items: [
						{
							approvalId: "a1",
							summary: "레인 L-1 머지",
							createdAt: "2026-11-11T07:20:00+09:00",
							expiresAt: "2026-11-11T07:35:00+09:00",
							originKey: null,
							title: "레인 L-1 머지",
							detail: null,
							cardUrl: null,
							originUrl: null,
							remainingMs: 5 * 60_000,
							originLabel: null,
						},
					],
					recent: [],
					stats: { days: 7, approved: 1, denied: 0, expired: 0, replied: 0, medianAnswerMs: 1000 },
				},
				tasks: {
					ok: true,
					items: [
						{
							taskId: "T-20261111-02",
							title: "멈춘 작업",
							risk: "L2",
							status: "blocked",
							host: "local",
							agent: "t-2",
							branch: "task/T-2",
							open: true,
							updatedAt: "2026-11-11T07:00:00+09:00",
							acTotal: 3,
						},
					],
				},
				turns: { ok: true, items: [turn(5, { stalled: true })], threads: [] },
			}),
			NOW,
		);
		const body = text(html);
		expect(body).toContain("주의 4 · 진행 TASK 1 · 레인 0 · 승인 대기 1 · 게이트 열림 1 · 모니터 실패 0");
		// The attention section names each of them.
		expect(body).toContain("게이트 backup_age");
		expect(body).toContain("승인 대기 레인 L-1 머지");
		expect(body).toContain("TASK T-20261111-02 멈춘 작업 · blocked");
		expect(body).toContain("턴 5 정체");
		// Emphasis colour only when there is something to look at.
		expect(html).toMatch(/class="[^"]*warn[^"]*"[^>]*>주의 4/);
		expect(text(renderBriefingHtml(snapshot(), NOW))).toContain("주의 0");
	});

	test("a section with seven lines shows six and `외 1개`", () => {
		const items = Array.from({ length: 7 }, (_, index) => monitor(`m${index + 1}`));
		const body = text(
			renderBriefingHtml(
				snapshot({ monitors: { ok: true, items: [...items, monitor("failed", { failStreak: 2 })] } }),
				NOW,
			),
		);
		// Seven monitors fire again today: six named, then the count of the rest.
		expect(body).toContain("m6");
		expect(body).not.toContain("m7");
		expect(body).toContain("외 1개");
		// The failure line is its own part of the monitor section and is never dropped by the line cap.
		expect(body).toContain("실패 failed");
	});

	test("an unreadable section says why and the others still render", () => {
		const body = text(
			renderBriefingHtml(
				snapshot({
					daemon: { ok: false, error: `no database at /tmp/x/ompbot.db ${"z".repeat(200)}` },
					gates: { ok: false, error: "ledger unreadable" },
					monitors: { ok: true, items: [monitor("아침 브리핑")] },
				}),
				NOW,
			),
		);
		expect(body).toContain("읽지 못함: no database at /tmp/x/ompbot.db");
		expect(body).toContain("읽지 못함: ledger unreadable");
		// The reason is cut at 120 characters.
		expect(body).not.toContain("z".repeat(150));
		expect(body).toContain("아침 브리핑");
	});

	test("previews are escaped and secret-shaped text is masked", () => {
		const token = ["xoxb", "1234", "abcd"].join("-");
		const body = text(
			renderBriefingHtml(
				snapshot({
					tasks: {
						ok: true,
						items: [
							{
								taskId: "T-1",
								title: `<script>alert(1)</script> ${token}`,
								risk: "L1",
								status: "working",
								host: "local",
								agent: "t-1",
								branch: "task/T-1",
								open: true,
								updatedAt: "2026-11-11T07:00:00+09:00",
								acTotal: 1,
							},
						],
					},
				}),
				NOW,
			),
		);
		expect(body).not.toContain("<script>alert(1)</script>");
		expect(body).toContain("&lt;script&gt;");
		expect(body).not.toContain(token);
		expect(body).toContain("[REDACTED]");
	});
});
