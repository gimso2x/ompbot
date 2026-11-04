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
	openStore({ path: dbPath, clock: { now: () => NOW }, redact: (text) => text }).close();
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
});
