import { afterEach, describe, expect, test } from "bun:test";
import type { BoardCard, BoardView } from "../src/dashboard/board";
import {
	type InboxEntry,
	inboxEntries,
	isStale,
	renderDashboardMain,
	renderDashboardPage,
} from "../src/dashboard/html";
import { startDashboardServer } from "../src/dashboard/server";
import type { DashboardSnapshot, TaskInfo } from "../src/dashboard/snapshot";

const NOW = Date.parse("2026-11-04T01:00:00Z");
const HOUR = 3_600_000;

const card = (key: string, status: string, column: BoardCard["column"], extra: Partial<BoardCard> = {}): BoardCard => ({
	key,
	local: true,
	machineId: "local",
	machineName: "oci",
	paneId: key,
	workspaceId: "w3",
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

const task = (taskId: string, extra: Partial<TaskInfo> = {}): TaskInfo => ({
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
	herdr: { ok: true, status: "idle" },
	...extra,
});

const off = { ok: false as const, error: "not in this test" };

const snapshotOf = (tasks: DashboardSnapshot["tasks"] = { ok: true, items: [] }): DashboardSnapshot => ({
	generatedAt: "2026-11-04T10:00:00+09:00",
	timezone: "Asia/Seoul",
	daemon: off,
	turns: off,
	tasks,
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

/** Two 방치 panes (unknown since, 25 hours idle) and three that are not (working, blocked, idle for 5 minutes). */
const MIXED = boardOf([
	card("s1", "idle", "idle", { since: 0 }),
	card("s2", "done", "done", { since: NOW - 25 * HOUR }),
	card("n1", "working", "working"),
	card("n2", "blocked", "attention"),
	card("n3", "idle", "idle"),
]);
const CALM = boardOf([card("n1", "working", "working"), card("n3", "idle", "idle")]);
const SNAP = snapshotOf();

const cardsOf = (html: string): string[] =>
	[...html.matchAll(/<a class="card[ "][^>]*data-row="([^"]+)"/g)].map((m) => m[1] ?? "");
const rowsOf = (html: string): string[] => [...html.matchAll(/<tr data-row="([^"]+)"/g)].map((m) => m[1] ?? "");
/** The server-drawn `#main` of a page, without the inline script. */
const mainOf = (page: string): string => /<div id="main"[^>]*>([\s\S]*?)<div class="search">/.exec(page)?.[1] ?? "";
/** The shared head row of the inbox: from the view head to the next line under it. */
const headOf = (html: string): string => html.slice(html.indexOf('class="view-head"'), html.indexOf('class="next-'));

describe("방치 herdr 패널 필터", () => {
	test("AC-1: isStale draws the line at 24 hours, counts an unknown since, and leaves TASK panes, other columns and TASK entries out", () => {
		const entry = (extra: Partial<InboxEntry>): InboxEntry => ({
			id: "p",
			kind: "card",
			col: "wait",
			since: NOW - 24 * HOUR,
			title: "pane",
			machine: "oci",
			taskId: "",
			card: card("p", "idle", "idle"),
			...extra,
		});
		const rows: Array<[string, InboxEntry, boolean]> = [
			["24h 정각", entry({}), true],
			["23h59m", entry({ since: NOW - 24 * HOUR + 60_000 }), false],
			["since 0", entry({ since: 0 }), true],
			["TASK 묶임", entry({ since: 0, taskId: "T-1", task: task("T-1") }), false],
			["TASK 목록 실패라 taskId만", entry({ since: 0, taskId: "T-1" }), false],
			["확인 필요 열", entry({ since: 0, col: "attention" }), false],
			["진행 중 열", entry({ since: 0, col: "working" }), false],
			["TASK 항목", entry({ since: 0, kind: "task", card: undefined }), false],
		];
		expect(rows.map(([name, item]) => [name, isStale(item, NOW)])).toEqual(rows.map(([name, , want]) => [name, want]));

		// With the TASK list unreadable the pane still carries its taskId, so it stays out.
		const failed = snapshotOf({ ok: false, error: "tasks db locked" });
		const entries = inboxEntries(failed, boardOf([card("t1", "idle", "idle", { since: 0, taskId: "T-9" })]));
		expect(entries.map((item) => [item.id, item.task === undefined, isStale(item, NOW)])).toEqual([
			["t1", true, false],
		]);
	});

	test("AC-2: the 방치 chip sits in the shared head outside the column chips; on, only 방치 panes remain with an off button", () => {
		const offHtml = renderDashboardMain(SNAP, MIXED, NOW);
		const chipOff = '<button type="button" class="chip" data-stale aria-pressed="false">방치 <b>2</b></button>';
		expect(headOf(offHtml)).toContain(chipOff);
		expect(offHtml.indexOf(chipOff)).toBeLessThan(offHtml.indexOf('<nav class="col-chips"'));
		const colChips = /<nav class="col-chips"[^>]*>([\s\S]*?)<\/nav>/.exec(offHtml)?.[1] ?? "";
		expect(colChips).not.toContain("data-stale");
		expect(cardsOf(offHtml).sort()).toEqual(["n1", "n2", "n3", "s1", "s2"]);
		expect(offHtml).not.toContain("방치 필터 끄기");

		const onHtml = renderDashboardMain(SNAP, MIXED, NOW, { stale: true });
		expect(cardsOf(onHtml).sort()).toEqual(["s1", "s2"]);
		expect(headOf(onHtml)).toContain(
			'<button type="button" class="chip" data-stale aria-pressed="true">방치 <b>2</b></button><button type="button" class="button is-ghost is-sm" data-stale-off>방치 필터 끄기</button>',
		);
	});

	test("AC-3: no 방치 pane and the filter off draws no chip; the filter on shows the empty box in the inbox and the list", () => {
		expect(renderDashboardMain(SNAP, CALM, NOW)).not.toContain("data-stale");
		for (const view of ["inbox", "list"]) {
			const html = renderDashboardMain(SNAP, CALM, NOW, { view, stale: true });
			expect([view, html.includes("방치된 패널이 없어요"), html.includes('aria-pressed="true">방치 <b>0</b>')]).toEqual(
				[view, true, true],
			);
			expect(cardsOf(html).concat(rowsOf(html))).toEqual([]);
		}
	});

	test("AC-4: the filter and the search both apply, the chip keeps the count before the search, and the list filters the same", () => {
		const one = renderDashboardMain(SNAP, MIXED, NOW, { stale: true, q: "pane s1" });
		expect(cardsOf(one)).toEqual(["s1"]);
		expect(one).toContain('aria-pressed="true">방치 <b>2</b>');

		const none = renderDashboardMain(SNAP, MIXED, NOW, { stale: true, q: "pane n1" });
		expect(cardsOf(none)).toEqual([]);
		expect(none).toContain("검색어와 방치 필터를 모두 만족하는 항목이 없어요");
		expect(none).not.toContain("와 맞는 항목이 없어요");
		expect(none).toContain('aria-pressed="true">방치 <b>2</b>');

		const list = renderDashboardMain(SNAP, MIXED, NOW, { view: "list", stale: true });
		expect(rowsOf(list).sort()).toEqual(["s1", "s2"]);
		expect(list).toContain('aria-pressed="true">방치 <b>2</b>');
		expect(rowsOf(renderDashboardMain(SNAP, MIXED, NOW, { view: "list", stale: true, q: "pane s2" }))).toEqual(["s2"]);
		const listNone = renderDashboardMain(SNAP, MIXED, NOW, { view: "list", stale: true, q: "pane n3" });
		expect(listNone).toContain("검색어와 방치 필터를 모두 만족하는 항목이 없어요");
		// Other views ignore the flag.
		expect(renderDashboardMain(SNAP, MIXED, NOW, { view: "approvals", stale: true })).not.toContain("data-stale");
	});

	test("AC-5: a 방치 card carries the 방치 badge and an unknown since still reads '-'", () => {
		const html = renderDashboardMain(SNAP, MIXED, NOW);
		const cardHtml = (id: string): string => {
			const start = html.indexOf(`data-row="${id}"`);
			return html.slice(start, html.indexOf("</a>", start));
		};
		expect(cardHtml("s1")).toContain('<span class="badge ">방치</span>');
		expect(cardHtml("s1")).toContain('<span class="card-time">-</span>');
		expect(cardHtml("s2")).toContain('<span class="badge ">방치</span>');
		expect(cardHtml("s2")).toContain('<span class="card-time">1일 전</span>');
		for (const id of ["n1", "n2", "n3"]) expect([id, cardHtml(id).includes(">방치<")]).toEqual([id, false]);
	});

	test("AC-6: the shipped renderer draws the same filtered inbox, and ?stale=1 starts the page with the filter on", () => {
		const html = renderDashboardMain(SNAP, MIXED, NOW, { stale: true });
		const page = renderDashboardPage(SNAP, { board: MIXED, stale: "1" });
		const script = /<script>([\s\S]*)<\/script>/.exec(page)?.[1] ?? "";
		const clientRender = new Function("document", "setInterval", `${script}\nreturn renderDashboardMain;`)(
			{ getElementById: () => ({}) },
			() => 0,
		) as typeof renderDashboardMain;
		expect(clientRender(SNAP, MIXED, NOW, { stale: true })).toBe(html);

		const main = mainOf(page);
		expect(cardsOf(main).sort()).toEqual(["s1", "s2"]);
		expect(main).toContain('aria-pressed="true">방치 <b>2</b>');
		expect(cardsOf(mainOf(renderDashboardPage(SNAP, { board: MIXED }))).length).toBe(5);
		// A view that has no 방치 filter drops it.
		expect(mainOf(renderDashboardPage(SNAP, { board: MIXED, view: "approvals", stale: "1" }))).not.toContain(
			"data-stale",
		);
	});
});

describe("방치 필터 서버 주소", () => {
	let stop: (() => void) | undefined;
	afterEach(() => stop?.());

	test("AC-6: the server passes ?stale=1 to the first render", async () => {
		const server = startDashboardServer({ port: 0, hostname: "127.0.0.1", snapshot: async () => SNAP });
		stop = () => server.stop(true);
		const base = `http://127.0.0.1:${server.port}`;
		expect(mainOf(await (await fetch(`${base}/?stale=1`)).text())).toContain('aria-pressed="true">방치 <b>0</b>');
		expect(mainOf(await (await fetch(`${base}/`)).text())).not.toContain("data-stale");
	});
});
