import { describe, expect, test } from "bun:test";
import type { BoardCard, BoardView } from "../src/dashboard/board";
import {
	byAttention,
	type InboxEntry,
	orderKeyTarget,
	renderDashboardMain,
	renderDashboardPage,
	renderDetailHead,
	replyKeyTarget,
	tabSignal,
} from "../src/dashboard/html";
import type { DashboardSnapshot, TaskInfo } from "../src/dashboard/snapshot";

const NOW = Date.parse("2026-11-04T01:00:00Z");

const card = (key: string, status: string, column: BoardCard["column"], extra: Partial<BoardCard> = {}): BoardCard => ({
	key,
	local: true,
	machineId: "local",
	machineName: "oci",
	paneId: key,
	workspaceId: "w2",
	workspaceLabel: "main",
	tabLabel: "tab",
	paneLabel: `pane ${key}`,
	name: `agent-${key}`,
	agent: "omp",
	status,
	column,
	unknown: false,
	since: NOW - 5 * 60_000,
	cwd: "/srv/work",
	...extra,
});

const task = (taskId: string, extra: Partial<TaskInfo>): TaskInfo => ({
	taskId,
	title: `title ${taskId}`,
	risk: "L2",
	status: "working",
	host: "local",
	agent: taskId.toLowerCase(),
	branch: `task/${taskId}`,
	open: true,
	updatedAt: "2026-11-04T09:30:00+09:00",
	acTotal: 3,
	herdr: { ok: true, status: "working" },
	...extra,
});

const RUNNING = {
	ok: true as const,
	running: true,
	ompVersion: "1",
	timezone: "Asia/Seoul",
	origins: 1,
	busy: 0,
	ledger: { pending: 0, inflight: 0, confirmed: 0, ambiguous: 0, expired: 0 },
	inbound: { pending: 0, dispatched: 0, answered: 0, failed_notified: 0, discarded: 0 },
	monitors: { count: 0, next: null },
	openGates: [],
};

const off = { ok: false as const, error: "not in this test" };

const snapshotOf = (tasks: TaskInfo[], daemon: DashboardSnapshot["daemon"] = RUNNING): DashboardSnapshot => ({
	generatedAt: "2026-11-04T10:00:00+09:00",
	timezone: "Asia/Seoul",
	daemon,
	feedback: off,
	turns: off,
	tasks: { ok: true, items: tasks },
	lanes: off,
	herdr: { ok: true, hosts: [] },
	approvals: off,
	monitors: off,
	alerts: off,
	gates: off,
	backup: off,
	jobs: off,
});

const boardOf = (cards: BoardCard[]): BoardView => ({
	ok: true,
	generatedAt: NOW,
	machines: [{ id: "local", name: "oci", connected: true }],
	cards,
});

/** The AC-1 input: a failed TASK 2 minutes old (with a blocker too), blocked cards 30 and 10 minutes old, a TASK with no card 60. */
const AC1 = snapshotOf([
	task("T-20261104-60", {
		error: "문서 판정 실패: outcome.md 없음",
		progress: { status: "blocked", updated: "2026-11-04T09:58:00+09:00", current: "S2", blockedReason: "오너 결정" },
	}),
	task("T-20261104-61", {
		progress: { status: "working", updated: "2026-11-04T09:00:00+09:00", current: "S1", blockedReason: "" },
	}),
]);
const AC1_BOARD = boardOf([
	card("w2:b10", "blocked", "attention", { since: NOW - 10 * 60_000 }),
	card("w2:b30", "blocked", "attention", { since: NOW - 30 * 60_000 }),
]);
const AC1_ORDER = ["T-20261104-60", "w2:b30", "w2:b10", "T-20261104-61"];

/** The next line's `<a class="next-up">…</a>`, or "" without one. */
const nextUp = (html: string): string => {
	const start = html.indexOf('<a class="next-up"');
	return start < 0 ? "" : html.slice(start, html.indexOf("</a>", start) + 4);
};
const column = (html: string, id: string): string => {
	const start = html.indexOf(`id="col-${id}"`);
	if (start < 0) throw new Error(`no column ${id}`);
	return html.slice(start, html.indexOf("</section>", start));
};
const rowIds = (html: string): string[] => [...html.matchAll(/data-row="([^"]+)"/g)].map((match) => match[1] ?? "");
const titleOf = (page: string): string => /<title>([^<]*)<\/title>/.exec(page)?.[1] ?? "";
const faviconOf = (page: string): string => /<link rel="icon" id="favicon" href="([^"]+)">/.exec(page)?.[1] ?? "";
const scriptOf = (page: string): string => /<script>([\s\S]*)<\/script>/.exec(page)?.[1] ?? "";

describe("inbox next line", () => {
	test("AC-2: the next line opens the first 확인 필요 item, with task.error as the reason even beside a blocker", () => {
		const html = renderDashboardMain(AC1, AC1_BOARD, NOW);
		const link = nextUp(html);
		expect(link).toContain('href="?task=T-20261104-60"');
		expect(link).toContain("문서 판정 실패: outcome.md 없음");
		expect(link).not.toContain("오너 결정");
	});

	test("AC-2: no 확인 필요 item, no next-up link", () => {
		const html = renderDashboardMain(snapshotOf([]), boardOf([card("w2:run", "working", "working")]), NOW);
		expect(html).not.toContain("next-up");
	});

	test("AC-2: a search that matches another item keeps the same next line", () => {
		const searched = renderDashboardMain(AC1, AC1_BOARD, NOW, { q: "pane w2:b10" });
		expect(rowIds(column(searched, "attention"))).toEqual(["w2:b10"]);
		expect(nextUp(searched)).toBe(nextUp(renderDashboardMain(AC1, AC1_BOARD, NOW)));
		expect(nextUp(searched)).toContain('href="?task=T-20261104-60"');
	});
});

describe("inbox tab signal", () => {
	test("AC-3: the title counts 확인 필요, says (!) when the daemon is down, and the tab icon differs for each", () => {
		const two = renderDashboardPage(snapshotOf([]), {
			board: boardOf([card("w2:a", "blocked", "attention"), card("w2:b", "blocked", "attention")]),
		});
		const none = renderDashboardPage(snapshotOf([]), { board: boardOf([card("w2:run", "working", "working")]) });
		const down = renderDashboardPage(snapshotOf([], { ...RUNNING, running: false }), {
			board: boardOf([card("w2:a", "blocked", "attention")]),
		});
		expect(titleOf(two)).toBe("(2) 확인 필요 · ompbot 현황판");
		expect(titleOf(none)).toBe("ompbot 현황판");
		expect(titleOf(down)).toBe("(!) ompbot 현황판");
		const icons = [two, none, down].map(faviconOf);
		expect(icons.every((href) => href.startsWith("data:image/svg+xml,"))).toBe(true);
		expect(new Set(icons).size).toBe(3);
		// A cut-off board and a failed refresh are 이상 too.
		expect(tabSignal(snapshotOf([]), { ok: false, error: "herdr_unreachable" }, false).title).toBe("(!) ompbot 현황판");
		expect(tabSignal(snapshotOf([]), boardOf([]), true).bad).toBe(true);
	});
});

describe("inbox number keys", () => {
	const ids = ["T-20261104-60", "w2:b30"];
	const inbox = { view: "inbox" };

	test("AC-4: 1 opens the first numbered card; typing, a modal, a modifier, another view or an unused number do not", () => {
		expect(orderKeyTarget({ key: "1", ...inbox }, ids)).toBe("T-20261104-60");
		expect(orderKeyTarget({ key: "2", ...inbox }, ids)).toBe("w2:b30");
		expect(orderKeyTarget({ key: "1", typing: true, ...inbox }, ids)).toBeNull();
		expect(orderKeyTarget({ key: "1", modalOpen: true, ...inbox }, ids)).toBeNull();
		expect(orderKeyTarget({ key: "1", meta: true, ...inbox }, ids)).toBeNull();
		expect(orderKeyTarget({ key: "1", ctrl: true, ...inbox }, ids)).toBeNull();
		expect(orderKeyTarget({ key: "1", alt: true, ...inbox }, ids)).toBeNull();
		expect(orderKeyTarget({ key: "1", view: "list" }, ids)).toBeNull();
		expect(orderKeyTarget({ key: "3", ...inbox }, ids)).toBeNull();
		expect(orderKeyTarget({ key: "0", ...inbox }, ids)).toBeNull();
	});

	test("AC-4: when the search hides item 1 the numbers on screen start again at 1", () => {
		const attention = column(renderDashboardMain(AC1, AC1_BOARD, NOW, { q: "pane w2" }), "attention");
		expect([...attention.matchAll(/data-row="([^"]+)" data-order="(\d)"/g)].map((m) => `${m[2]}:${m[1]}`)).toEqual([
			"1:w2:b30",
			"2:w2:b10",
		]);
		expect([...attention.matchAll(/<span class="order-no">(\d)<\/span>/g)].map((match) => match[1])).toEqual([
			"1",
			"2",
		]);
	});

	test("AC-4: refresh, the hidden tab's 60-second read and the board stream all call updateTabSignal", () => {
		const script = scriptOf(renderDashboardPage(AC1, { board: AC1_BOARD }));
		const refreshStart = script.indexOf("async function refresh()");
		const refresh = script.slice(refreshStart, script.indexOf("\n\t}\n", refreshStart));
		expect(refresh.match(/updateTabSignal\(/g)?.length).toBe(2);
		const hiddenEnd = script.indexOf("}, 60000);");
		const hidden = script.slice(script.lastIndexOf("setInterval(", hiddenEnd), hiddenEnd);
		expect(hidden).toContain('document.visibilityState === "visible"');
		expect(hidden).toContain("updateTabSignal(");
		const streamStart = script.indexOf('events.addEventListener("snapshot"');
		expect(script.slice(streamStart, script.indexOf("});", streamStart))).toContain("updateTabSignal(");
	});
});

describe("inbox list view order", () => {
	test("AC-8: the list view's default order keeps the AC-1 확인 필요 order", () => {
		const html = renderDashboardMain(AC1, AC1_BOARD, NOW, { view: "list" });
		expect([...html.matchAll(/<tr[^>]*data-row="([^"]+)"/g)].map((match) => match[1])).toEqual(AC1_ORDER);
	});
});

describe("inbox next line, 7·8절 (AC-9)", () => {
	test("a quiet line with nothing to look at, 상태 모름 when the daemon is down", () => {
		const quiet = renderDashboardMain(snapshotOf([]), boardOf([]), NOW);
		expect(quiet).toContain('<p class="next-quiet">다음 · 기다리는 항목 없음</p>');
		const down = renderDashboardMain(snapshotOf([], { ...RUNNING, running: false }), boardOf([]), NOW);
		expect(down).toMatch(/<p class="next-quiet">[^<]*상태 모름[^<]*<\/p>/);
	});

	test("only the next line's card is marked is-next; the snapshot read has an 8-second AbortController", () => {
		const html = renderDashboardMain(AC1, AC1_BOARD, NOW);
		const marked = [...html.matchAll(/<a class="card[^"]*\bis-next\b[^"]*"[^>]*data-row="([^"]+)"/g)].map((m) => m[1]);
		expect(marked).toEqual(["T-20261104-60"]);
		const script = scriptOf(renderDashboardPage(AC1, { board: AC1_BOARD }));
		const read = script.slice(script.indexOf("async function getSnapshot()"));
		expect(read.slice(0, read.indexOf("\n\t}\n"))).toMatch(/new AbortController\(\)[\s\S]*8000[\s\S]*signal/);
	});

	test("the next line has the first item's herdr reply link beside (not inside) the next-up link; r opens it", () => {
		const reply = "https://herdr.example.test/?ws=w2&pane=w2%3Au&view=chat";
		const board = boardOf([
			card("w2:u", "mystery", "attention", { unknown: true, replyUrl: reply, since: NOW - 3 * 60_000 }),
			card("w2:b30", "blocked", "attention", { since: NOW - 30 * 60_000 }),
		]);
		const html = renderDashboardMain(snapshotOf([]), board, NOW);
		const link = nextUp(html);
		expect(link).toContain('href="?card=w2%3Au"');
		expect(link).toContain("알 수 없는 상태 mystery");
		expect(link).not.toContain("herdr에서 답하기");
		const after = html.slice(html.indexOf(link) + link.length);
		expect(after).toStartWith(
			'<a class="next-reply" href="https://herdr.example.test/?ws=w2&amp;pane=w2%3Au&amp;view=chat" target="_blank"',
		);
		expect(after).toContain("herdr에서 답하기");
		const without = renderDashboardMain(AC1, AC1_BOARD, NOW);
		expect(without).not.toContain("next-reply");

		expect(replyKeyTarget({ key: "r", view: "inbox" }, reply)).toBe(reply);
		expect(replyKeyTarget({ key: "r", view: "inbox" }, null)).toBeNull();
		expect(replyKeyTarget({ key: "r", view: "inbox", typing: true }, reply)).toBeNull();
		expect(replyKeyTarget({ key: "r", view: "inbox", modalOpen: true }, reply)).toBeNull();
		expect(replyKeyTarget({ key: "r", view: "inbox", meta: true }, reply)).toBeNull();
		expect(replyKeyTarget({ key: "r", view: "turns" }, reply)).toBeNull();
		expect(replyKeyTarget({ key: "1", view: "inbox" }, reply)).toBeNull();
	});

	test("a done pane goes to 완료·대기 with or without a TASK; only the blocked pane is under 확인 필요", () => {
		const snapshot = snapshotOf([task("T-20261104-70", {})]);
		const board = boardOf([
			card("w2:answered", "done", "done", { since: NOW - 90 * 60_000 }),
			card("w2:blocked", "blocked", "attention", { since: NOW - 5 * 60_000 }),
			card("w2:tasked", "done", "done", { taskId: "T-20261104-70" }),
		]);
		const html = renderDashboardMain(snapshot, board, NOW);
		expect(rowIds(column(html, "attention"))).toEqual(["w2:blocked"]);
		expect(rowIds(column(html, "wait")).sort()).toEqual(["w2:answered", "w2:tasked"]);
		const only = renderDashboardMain(snapshotOf([]), boardOf([card("w2:answered", "done", "done")]), NOW);
		expect(rowIds(column(only, "attention"))).toEqual([]);
	});
});

describe("cards whose since is unknown (0)", () => {
	const HOUR = 3_600_000;
	const entryOf = (c: BoardCard): InboxEntry => ({
		id: c.key,
		kind: "card",
		col: "attention",
		since: c.since,
		title: c.paneLabel,
		machine: c.machineName,
		taskId: "",
		card: c,
	});
	/** The `<a class="card…">` markup of one inbox card. */
	const cardHtml = (html: string, key: string): string => {
		const at = html.indexOf(`data-row="${key}"`);
		return html.slice(html.lastIndexOf("<a ", at), html.indexOf("</a>", at) + 4);
	};

	test("AC-1: byAttention puts an hour-old card before a since-0 card of the same group", () => {
		const unknown = entryOf(card("w2:zero", "blocked", "attention", { since: 0 }));
		const hour = entryOf(card("w2:hour", "blocked", "attention", { since: NOW - HOUR }));
		expect([unknown, hour].sort(byAttention).map((entry) => entry.id)).toEqual(["w2:hour", "w2:zero"]);
		expect([hour, unknown].sort(byAttention).map((entry) => entry.id)).toEqual(["w2:hour", "w2:zero"]);
	});

	test("AC-1: a since-0 card shows '-' on its card and detail, and is not 다음 beside a known-time card", () => {
		const zero = card("w2:zero", "blocked", "attention", { since: 0 });
		const html = renderDashboardMain(
			snapshotOf([]),
			boardOf([zero, card("w2:hour", "blocked", "attention", { since: NOW - HOUR })]),
			NOW,
		);
		expect(nextUp(html)).toContain('href="?card=w2%3Ahour"');
		const own = cardHtml(html, "w2:zero");
		expect(own).toContain('<span class="card-time">-</span>');
		expect(own).not.toContain("next-tag");
		expect(own).not.toContain("is-next");
		expect(cardHtml(html, "w2:hour")).toContain('<span class="card-time">1시간 전</span>');
		const detail = renderDetailHead("w2:zero", zero, undefined, NOW);
		expect(detail).toContain("이 상태가 된 시각 -");
		expect(detail).not.toContain("방금");

		const alone = renderDashboardMain(snapshotOf([]), boardOf([zero]), NOW);
		expect(nextUp(alone)).toContain('<span class="next-wait"><b>-</b></span>');
	});
});
