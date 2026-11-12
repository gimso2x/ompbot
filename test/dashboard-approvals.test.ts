import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { renderDashboardMain, renderItemDetail } from "../src/dashboard/html";
import { startDashboardServer } from "../src/dashboard/server";
import { type ApprovalInfo, buildSnapshot, type DashboardSnapshot, type SnapshotDeps } from "../src/dashboard/snapshot";
import { openStore } from "../src/store/db";
import { makeHome, type TestHome } from "./helpers/bot-home";

const NOW = Date.parse("2026-11-04T05:20:00Z");
const MINUTE = 60_000;
const CARD_URL = "https://example.slack.com/archives/C0123456789/p1793769039558599";
const THREAD_URL = "https://example.slack.com/archives/C0234567890/p1793768647644509";
const FULL = "C0123456789:1793769039.558599";
const BROKEN = "C0123456789:1793769100.000001";
const BARE = "C0123456789:1793769200.000002";
const LANE = "C0123456789:1793769300.000003";
const FULL_SUMMARY =
	"T-20261102-04 워크트리와 브랜치를 정리합니다. 리뷰가 끝난 TASK라 /home/user/work/ompbot-t-20261102-04 워크트리와 task/T-20261102-04 브랜치를 지웁니다.";
const LONG_SUMMARY = `원격 저장소 ${"가나다라마".repeat(40)} 강제 push`;

let home: TestHome;
let dbPath: string;

beforeEach(() => {
	home = makeHome("ompbot-dash-approvals-");
	dbPath = join(home.dir, "ompbot.db");
});
afterEach(() => home.remove());

function deps(): SnapshotDeps {
	return {
		homeDir: home.dir,
		repoDir: home.dir,
		timezone: "Asia/Seoul",
		config: undefined,
		now: () => NOW,
		callDaemon: async () => Promise.reject(new Error("no daemon")),
		run: async () => ({ code: 0, stdout: "", timedOut: false }),
		ompVersion: async () => "omp-stub 0.0.0",
		hostOps: () => {
			throw new Error("no host ops");
		},
	};
}

/** Four pending rows: full detail and links, a broken row, a bare channel row and a lane row. */
function seed(): void {
	openStore({ timezone: "Asia/Seoul", path: dbPath, clock: { now: () => NOW }, redact: (text) => text }).close();
	const db = new Database(dbPath, { strict: true });
	const insert = db.query(
		`INSERT INTO approvals (approval_id, channel, message_ts, summary, status, created_at, expires_at, origin_key, detail_json, card_url, origin_url)
		 VALUES (?, 'C0123456789', ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
	);
	insert.run(
		FULL,
		"1793769039.558599",
		FULL_SUMMARY,
		NOW - MINUTE,
		NOW + 29 * MINUTE,
		"slack/ch/C0234567890/t/1793768647.644509",
		JSON.stringify({
			action: "git worktree remove /home/user/work/ompbot-t-20261102-04",
			why: "리뷰 끝 · 토큰 xoxb-TEST-0 은 가려져야 함",
			impact: "브랜치 task/T-20261102-04 삭제",
			rollback: "지운 브랜치는 reflog로만 살릴 수 있음",
		}),
		CARD_URL,
		THREAD_URL,
	);
	insert.run(
		BROKEN,
		"1793769100.000001",
		LONG_SUMMARY,
		NOW - 40 * MINUTE,
		NOW - 1_000,
		"slack/dm/D0BOTDM",
		"{not json",
		"javascript:alert(1)",
		"http://insecure.example/thread",
	);
	insert.run(BARE, "1793769200.000002", "배포", NOW - MINUTE, NOW + 5 * MINUTE, "slack/ch/C0CHAN", null, null, null);
	insert.run(LANE, "1793769300.000003", "레인 작업", NOW - MINUTE, NOW + 20 * MINUTE, "lane/a", null, null, null);
	db.close();
}

function approvalsOf(snapshot: DashboardSnapshot): ApprovalInfo[] {
	if (!snapshot.approvals.ok) throw new Error(`approvals failed: ${snapshot.approvals.error}`);
	return snapshot.approvals.items;
}

const byId = (items: ApprovalInfo[], id: string): ApprovalInfo => {
	const item = items.find((candidate) => candidate.approvalId === id);
	if (item === undefined) throw new Error(`no ${id}`);
	return item;
};

describe("dashboard approvals", () => {
	test("AC-4: each row carries title, detail, safe links, remaining time and a readable origin", async () => {
		seed();
		const items = approvalsOf(await buildSnapshot(deps()));
		for (const item of items) {
			expect(Object.keys(item)).toEqual(
				expect.arrayContaining([
					"approvalId",
					"summary",
					"createdAt",
					"expiresAt",
					"originKey",
					"title",
					"detail",
					"cardUrl",
					"originUrl",
					"remainingMs",
					"originLabel",
				]),
			);
		}
		const full = byId(items, FULL);
		expect(full).toMatchObject({
			summary: FULL_SUMMARY,
			createdAt: "2026-11-04T14:19:00+09:00",
			expiresAt: "2026-11-04T14:49:00+09:00",
			originKey: "slack/ch/C0234567890/t/1793768647.644509",
			title: "T-20261102-04 워크트리와 브랜치를 정리합니다.",
			cardUrl: CARD_URL,
			originUrl: THREAD_URL,
			remainingMs: 29 * MINUTE,
			originLabel: "채널 C0234567890 스레드",
		});
		expect(full.detail).toEqual({
			action: "git worktree remove /home/user/work/ompbot-t-20261102-04",
			why: "리뷰 끝 · 토큰 [REDACTED] 은 가려져야 함",
			impact: "브랜치 task/T-20261102-04 삭제",
			rollback: "지운 브랜치는 reflog로만 살릴 수 있음",
		});
		const broken = byId(items, BROKEN);
		expect(broken).toMatchObject({
			detail: null,
			cardUrl: null,
			originUrl: null,
			remainingMs: 0,
			originLabel: "DM",
			summary: LONG_SUMMARY,
		});
		expect(broken.title.length).toBeLessThanOrEqual(80);
		expect(broken.title).toBe(`${LONG_SUMMARY.slice(0, 79)}…`);
		expect(byId(items, BARE)).toMatchObject({ originLabel: "채널 C0CHAN 메인", detail: null, cardUrl: null });
		expect(byId(items, LANE).originLabel).toBe("lane/a");
	});

	test("AC-5: a ledger without the new columns still answers 200 with null detail and links", async () => {
		const db = new Database(dbPath, { strict: true });
		db.run(
			`CREATE TABLE approvals (approval_id TEXT PRIMARY KEY, channel TEXT NOT NULL, message_ts TEXT NOT NULL, summary TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','expired','replied')),
				created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_at INTEGER, origin_key TEXT,
				origin_thread_ref TEXT, reply_ts TEXT, reply_text TEXT)`,
		);
		db.run(
			"INSERT INTO approvals (approval_id, channel, message_ts, summary, created_at, expires_at, origin_key) VALUES (?, 'C1', '1.1', 'push to main', ?, ?, 'slack/dm/D1')",
			[FULL, NOW - MINUTE, NOW + 3 * MINUTE],
		);
		db.close();
		const server = startDashboardServer({ port: 0, hostname: "127.0.0.1", snapshot: () => buildSnapshot(deps()) });
		try {
			const response = await fetch(`http://127.0.0.1:${server.port}/api/snapshot`);
			expect(response.status).toBe(200);
			const snapshot = (await response.json()) as DashboardSnapshot;
			expect(snapshot.approvals.ok).toBe(true);
			expect(approvalsOf(snapshot)).toEqual([
				expect.objectContaining({
					approvalId: FULL,
					title: "push to main",
					detail: null,
					cardUrl: null,
					originUrl: null,
					remainingMs: 3 * MINUTE,
					originLabel: "DM",
				}),
			]);
		} finally {
			server.stop(true);
		}
	});

	test("AC-6: the list shows the short title, remaining time and the irreversible badge, never the approval id", async () => {
		seed();
		const snapshot = await buildSnapshot(deps());
		const html = renderDashboardMain(snapshot, undefined, NOW, { view: "approvals" });
		const rows = html.slice(html.indexOf('<div class="rows">'));
		const rowOf = (id: string): string => {
			const start = rows.indexOf(`data-item="${id}"`);
			if (start < 0) throw new Error(`no row ${id}`);
			return rows.slice(rows.lastIndexOf("<a ", start), rows.indexOf("</a>", start));
		};
		const full = rowOf(FULL);
		expect(full).toContain('<p class="row-title">T-20261102-04 워크트리와 브랜치를 정리합니다.</p>');
		expect(full).not.toContain("/home/user/work/ompbot-t-20261102-04");
		expect(full).toContain("29분 남음");
		expect(full).toContain("되돌릴 수 없음");
		expect(full).toContain("채널 C0234567890 스레드");
		const broken = rowOf(BROKEN);
		const title = /<p class="row-title">([^<]*)<\/p>/.exec(broken)?.[1] ?? "";
		expect(title.length).toBeLessThanOrEqual(80);
		expect(broken).toContain("만료 처리 중");
		expect(broken).not.toContain("되돌릴 수 없음");
		expect(rowOf(BARE)).toMatch(/is-warning[^>]*>[\s\S]*5분 남음/);
		// Visible text only: tags and attributes (row ids in hrefs and data-item) dropped.
		const text = html.replace(/<[^>]*>/g, " ");
		for (const id of [FULL, BROKEN, BARE, LANE]) expect(text).not.toContain(id);
		expect(text).not.toContain("slack/ch/C0234567890/t/1793768647.644509");
	});

	test("AC-7: the detail lists what, why, impact and rollback with card and thread links; ids sit in <details>", async () => {
		seed();
		const snapshot = await buildSnapshot(deps());
		const full = renderItemDetail(snapshot, "approvals", FULL);
		for (const [label, value] of [
			["할 일", "git worktree remove /home/user/work/ompbot-t-20261102-04"],
			["이유", "리뷰 끝 · 토큰 [REDACTED] 은 가려져야 함"],
			["영향", "브랜치 task/T-20261102-04 삭제"],
			["되돌릴 수 없는 이유", "지운 브랜치는 reflog로만 살릴 수 있음"],
		] as const) {
			expect(full).toContain(`<dt>${label}</dt><dd>${value}</dd>`);
		}
		expect(full).toMatch(new RegExp(`<a [^>]*href="${CARD_URL}"[^>]*rel="noopener[^"]*"[^>]*>슬랙 카드 열기</a>`));
		expect(full).toMatch(new RegExp(`<a [^>]*href="${THREAD_URL}"[^>]*>요청 스레드 열기</a>`));
		expect(full).not.toContain("슬랙의 승인 메시지에서");
		const details = /<details[^>]*>([\s\S]*)<\/details>/.exec(full)?.[1] ?? "";
		expect(details).toContain("<summary>내부 정보</summary>");
		expect(details).toContain(FULL);
		expect(details).toContain("slack/ch/C0234567890/t/1793768647.644509");
		expect(full.slice(0, full.indexOf("<details"))).not.toContain(FULL);
		expect(full).toContain("<dt>남은 시간</dt><dd>29분</dd>");
		expect(full).toContain("<dt>요청한 곳</dt><dd>채널 C0234567890 스레드</dd>");
		expect(full).toContain(FULL_SUMMARY);

		const broken = renderItemDetail(snapshot, "approvals", BROKEN);
		expect(broken).toContain("세부 내용 없음");
		expect(broken).toContain("슬랙의 승인 메시지에서");
		expect(broken).not.toContain("<dt>할 일</dt>");
		expect(broken).not.toContain("javascript:");
		expect(broken).not.toContain("http://insecure");
		expect(broken).not.toContain("슬랙 카드 열기");
	});

	test("AC-8: settled approvals list newest first with outcome and answer time; 7-day counts and median; their panel", async () => {
		openStore({ timezone: "Asia/Seoul", path: dbPath, clock: { now: () => NOW }, redact: (text) => text }).close();
		const db = new Database(dbPath, { strict: true });
		const insert = db.query(
			`INSERT INTO approvals (approval_id, channel, message_ts, summary, status, created_at, expires_at, decided_at, origin_key, detail_json, card_url)
			 VALUES (?, 'C0123456789', ?, ?, ?, ?, ?, ?, 'slack/dm/D0BOTDM', ?, ?)`,
		);
		const HOUR = 60 * MINUTE;
		const settle = (ts: string, summary: string, status: string, createdAt: number, tookMs: number, card = false) =>
			insert.run(
				`C0123456789:${ts}`,
				ts,
				summary,
				status,
				createdAt,
				createdAt + 30 * MINUTE,
				createdAt + tookMs,
				card ? JSON.stringify({ action: "git push origin main" }) : null,
				card ? CARD_URL : null,
			);
		settle("1.1", "main을 push합니다. 토큰 xoxb-TEST-0 포함", "approved", NOW - 2 * HOUR, 40_000, true);
		settle("1.2", "서비스 재시작", "denied", NOW - HOUR, 6 * MINUTE);
		settle("1.3", "브랜치 삭제", "expired", NOW - 3 * HOUR, 30 * MINUTE);
		settle("1.4", "배포 방식 확인", "replied", NOW - 26 * HOUR, 2 * MINUTE);
		settle("1.5", "지난주 배포", "approved", NOW - 8 * 24 * HOUR, 10_000);
		db.close();

		const snapshot = await buildSnapshot(deps());
		if (!snapshot.approvals.ok) throw new Error(snapshot.approvals.error);
		expect(snapshot.approvals.items).toEqual([]);
		expect(snapshot.approvals.recent.map((item) => [item.approvalId, item.status, item.tookMs])).toEqual([
			["C0123456789:1.2", "denied", 6 * MINUTE],
			["C0123456789:1.1", "approved", 40_000],
			["C0123456789:1.3", "expired", 30 * MINUTE],
			["C0123456789:1.4", "replied", 2 * MINUTE],
			["C0123456789:1.5", "approved", 10_000],
		]);
		expect(snapshot.approvals.recent[1]).toMatchObject({
			summary: "main을 push합니다. 토큰 [REDACTED] 포함",
			title: "main을 push합니다.",
			createdAt: "2026-11-04T12:20:00+09:00",
			decidedAt: "2026-11-04T12:20:40+09:00",
			detail: { action: "git push origin main" },
			cardUrl: CARD_URL,
			originLabel: "DM",
		});
		// The week: the 8-day-old row is out; the median is of the owner's three answers, the timeout aside.
		expect(snapshot.approvals.stats).toEqual({
			days: 7,
			approved: 1,
			denied: 1,
			expired: 1,
			replied: 1,
			medianAnswerMs: 2 * MINUTE,
		});

		const html = renderDashboardMain(snapshot, undefined, NOW, { view: "approvals" });
		const text = html.replace(/<[^>]*>/g, " ");
		expect(text).toContain("기다리는 승인이 없어요");
		for (const word of ["최근 7일", "승인 1", "거절 1", "답장 1", "만료 1", "답까지 중앙값 2분 0초", "최근 결정"]) {
			expect(text).toContain(word);
		}
		const decided = html.slice(html.indexOf('data-list="decided"'));
		expect(decided.match(/data-row="/g)).toHaveLength(5);
		expect(decided.indexOf('data-row="C0123456789:1.2"')).toBeLessThan(decided.indexOf('data-row="C0123456789:1.1"'));
		expect(decided).toContain("요청 11-04 12:20 · 40초 뒤 승인");
		expect(decided).toContain("요청 11-04 13:20 · 6분 0초 뒤 거절");
		expect(text).not.toContain("C0123456789:1.1");
		expect(text).not.toContain("xoxb-TEST-0");
		const none = renderDashboardMain(snapshot, undefined, NOW, { view: "approvals", q: "재시작" });
		expect(none.match(/data-row="/g)).toHaveLength(1);

		const panel = renderItemDetail(snapshot, "approvals", "C0123456789:1.1");
		expect(panel).toContain('<p class="eyebrow">승인 결정</p>');
		expect(panel).toContain("<dt>할 일</dt><dd>git push origin main</dd>");
		expect(panel).toContain("<dt>결과</dt><dd>승인 · 요청 40초 뒤</dd>");
		expect(panel).toContain("<dt>결정</dt><dd>2026-11-04 12:20</dd>");
		expect(panel).toContain("슬랙 카드 열기");
		expect(panel).not.toContain("남은 시간");
		const bare = renderItemDetail(snapshot, "approvals", "C0123456789:1.3");
		expect(bare).toContain("<dt>결과</dt><dd>만료 · 요청 30분 0초 뒤</dd>");
		expect(bare).not.toContain("슬랙의 승인 메시지에서");
	});
});
