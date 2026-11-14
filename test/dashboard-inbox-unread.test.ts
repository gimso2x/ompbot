import { describe, expect, test } from "bun:test";
import type { BoardCard, BoardPanel, BoardView } from "../src/dashboard/board";
import {
	entrySig,
	type InboxEntry,
	inboxAttention,
	inboxEntries,
	markSeen,
	pruneStore,
	readUnread,
	renderDashboardMain,
	renderDashboardPage,
	seedStore,
	tabSignal,
	UNREAD_KEEP_MS,
	UNREAD_MAX,
	type UnreadState,
	type UnreadStorage,
	unreadIds,
} from "../src/dashboard/html";
import type { DashboardSnapshot, TaskInfo } from "../src/dashboard/snapshot";

const NOW = Date.parse("2026-11-04T01:00:00Z");
const DAY = 86_400_000;

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
	herdr: { ok: true, status: "working" },
	progress: { status: "working", updated: "2026-11-04T09:40:00+09:00", current: "S1", blockedReason: "" },
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

const snapshotOf = (tasks: TaskInfo[] | null): DashboardSnapshot => ({
	generatedAt: "2026-11-04T10:00:00+09:00",
	timezone: "Asia/Seoul",
	daemon: RUNNING,
	turns: off,
	tasks: tasks === null ? { ok: false, error: "db locked" } : { ok: true, items: tasks },
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

/** A fake `localStorage[UNREAD_KEY]` that counts its writes. */
const storeOf = (initial: string | null = null): UnreadStorage & { value: string | null; writes: number } => {
	const store = {
		value: initial,
		writes: 0,
		get: () => store.value,
		set: (value: string) => {
			store.value = value;
			store.writes += 1;
		},
	};
	return store;
};

const stateOf = (seeded: boolean, seen: UnreadState["seen"] = {}): string => JSON.stringify({ v: 1, seeded, seen });

/** The one entry with `id` of a snapshot and board. */
const entryOf = (s: DashboardSnapshot, board: BoardView | undefined, id: string): InboxEntry => {
	const found = inboxEntries(s, board).find((entry) => entry.id === id);
	if (found === undefined) throw new Error(`no entry ${id}`);
	return found;
};

/** Reads `before` into a seeded store, then asks whether `after` (same id) is unread. */
const unreadAfter = (before: InboxEntry, after: InboxEntry): boolean => {
	const store = storeOf(stateOf(true));
	markSeen(store, before, NOW);
	return unreadIds([after], store).includes(after.id);
};

const loneTask = (extra: Partial<TaskInfo> = {}): InboxEntry =>
	entryOf(snapshotOf([task("T-20261104-70", extra)]), undefined, "T-20261104-70");

const paneCard = (extra: Partial<BoardCard> = {}, taskExtra?: Partial<TaskInfo>): InboxEntry =>
	entryOf(
		snapshotOf(taskExtra === undefined ? [] : [task("T-20261104-71", taskExtra)]),
		boardOf([
			card("w3:p1", "working", "working", {
				...(taskExtra === undefined ? {} : { taskId: "T-20261104-71" }),
				...extra,
			}),
		]),
		"w3:p1",
	);

describe("AC-1: entrySig and unreadIds", () => {
	test("a lone TASK whose PROGRESS update moves only stays read", () => {
		const before = loneTask();
		const after = loneTask({
			progress: { status: "working", updated: "2026-11-04T09:55:00+09:00", current: "S2", blockedReason: "" },
			updatedAt: "2026-11-04T09:55:00+09:00",
		});
		expect(after.since).not.toBe(before.since);
		expect(entrySig(after)).toBe(entrySig(before));
		expect(unreadAfter(before, after)).toBe(false);
	});

	test("a lone TASK's status, error, worker check and column each make it unread", () => {
		const before = loneTask();
		expect(unreadAfter(before, loneTask({ status: "review", herdr: { ok: true, status: "working" } }))).toBe(true);
		expect(unreadAfter(before, loneTask({ error: "문서 판정 실패" }))).toBe(true);
		expect(unreadAfter(before, loneTask({ herdr: { ok: false, error: "ssh down" } }))).toBe(true);
		expect(unreadAfter(before, loneTask({ herdr: { ok: true, status: "gone" } }))).toBe(true);
		// The same TASK seen while the board is live (no pane for it) sits under 확인 필요: a column change.
		const live = entryOf(snapshotOf([task("T-20261104-70")]), boardOf([]), "T-20261104-70");
		expect(live.col).toBe("attention");
		expect(before.col).toBe("working");
		expect(unreadAfter(before, live)).toBe(true);
	});

	test("a card's pane status, its TASK's status and failure make it unread", () => {
		expect(unreadAfter(paneCard(), paneCard({ status: "blocked", column: "attention" }))).toBe(true);
		expect(unreadAfter(paneCard({}, {}), paneCard({}, { status: "review" }))).toBe(true);
		expect(unreadAfter(paneCard({}, {}), paneCard({}, { error: "outcome.md 없음" }))).toBe(true);
		// The card's TASK writing its PROGRESS is no change.
		expect(
			unreadAfter(
				paneCard({}, {}),
				paneCard(
					{},
					{ progress: { status: "working", updated: "2026-11-04T09:59:00+09:00", current: "S3", blockedReason: "" } },
				),
			),
		).toBe(false);
	});

	test("a card's since: 0 on either side is not compared, two known different values are", () => {
		const known = paneCard({ since: NOW - 60_000 });
		const unknown = paneCard({ since: 0 });
		const later = paneCard({ since: NOW - 10_000 });
		expect(unreadAfter(unknown, known)).toBe(false);
		expect(unreadAfter(known, unknown)).toBe(false);
		expect(unreadAfter(known, paneCard({ since: NOW - 60_000 }))).toBe(false);
		// done → working → done between two looks: the same state, a new since.
		expect(unreadAfter(known, later)).toBe(true);
		// since is no part of the signature.
		expect(entrySig(known)).toBe(entrySig(later));
	});

	test("an entry never seen is unread only once the store is seeded", () => {
		const entry = loneTask();
		expect(unreadIds([entry], storeOf(stateOf(false)))).toEqual([]);
		expect(unreadIds([entry], storeOf(null))).toEqual([]);
		expect(unreadIds([entry], storeOf(stateOf(true)))).toEqual([entry.id]);
	});

	test("a broken stored value is the empty unseeded state, no throw", () => {
		const entry = loneTask();
		for (const raw of [
			"{not json",
			"null",
			"[]",
			"42",
			'{"v":2,"seeded":true,"seen":{}}',
			'{"v":1,"seeded":"yes","seen":{}}',
			'{"v":1,"seeded":true,"seen":[]}',
		]) {
			const store = storeOf(raw);
			expect(readUnread(store)).toEqual({ v: 1, seeded: false, seen: {} });
			expect(unreadIds([entry], store)).toEqual([]);
		}
		// A mark of the wrong shape is dropped, the rest kept.
		const mixed = storeOf(
			JSON.stringify({ v: 1, seeded: true, seen: { a: { sig: 1 }, b: { sig: "x", since: 0, at: 5 } } }),
		);
		expect(readUnread(mixed).seen).toEqual({ b: { sig: "x", since: 0, at: 5 } });
		const throwing: UnreadStorage = {
			get: () => {
				throw new Error("SecurityError");
			},
			set: () => {},
		};
		expect(readUnread(throwing).seeded).toBe(false);
	});
});

describe("AC-2: seedStore, markSeen and pruneStore", () => {
	const TASKS = [task("T-20261104-72"), task("T-20261104-73", { status: "review" })];
	const BOARD = boardOf([card("w3:a", "working", "working"), card("w3:b", "done", "done")]);

	test("a snapshot without the board or the TASK list writes nothing", () => {
		const cut = { ok: false as const, error: "herdr-web-ui down" };
		const cases: Array<[DashboardSnapshot, BoardPanel | null | undefined]> = [
			[snapshotOf(TASKS), cut],
			[snapshotOf(TASKS), null],
			[snapshotOf(null), BOARD],
			[snapshotOf(null), undefined],
		];
		for (const [s, board] of cases) {
			const seed = storeOf();
			expect(seedStore(seed, s, board, NOW)).toBe(false);
			const old = stateOf(true, { gone: { sig: "x", since: 0, at: NOW - 30 * DAY } });
			const prune = storeOf(old);
			expect(pruneStore(prune, s, board, NOW)).toBe(false);
			expect([seed.writes, prune.writes]).toEqual([0, 0]);
			expect(prune.value).toBe(old);
		}
	});

	test("both read: every entry is seeded, whatever the search, and the store is seeded", () => {
		const s = snapshotOf(TASKS);
		const store = storeOf();
		expect(seedStore(store, s, BOARD, NOW)).toBe(true);
		const state = readUnread(store);
		expect(state.seeded).toBe(true);
		expect(Object.keys(state.seen).sort()).toEqual(["T-20261104-72", "T-20261104-73", "w3:a", "w3:b"]);
		expect(state.seen["w3:a"]).toEqual({ sig: entrySig(entryOf(s, BOARD, "w3:a")), since: NOW - 5 * 60_000, at: NOW });
		// Seeded once: a second look writes nothing and nothing is unread.
		expect(seedStore(store, s, BOARD, NOW + 1)).toBe(false);
		expect(store.writes).toBe(1);
		expect(unreadIds(inboxEntries(s, BOARD), store)).toEqual([]);
		// The board off (undefined): the TASK list alone is the whole inbox.
		const tasksOnly = storeOf();
		expect(seedStore(tasksOnly, s, undefined, NOW)).toBe(true);
		expect(Object.keys(readUnread(tasksOnly).seen).sort()).toEqual(["T-20261104-72", "T-20261104-73"]);
		// The seeded store's search is not involved: the rendered page searched for one card still has every entry read.
		const html = renderDashboardMain(s, BOARD, NOW, { q: "w3:a", unread: unreadIds(inboxEntries(s, BOARD), store) });
		expect(html).not.toContain("unread-dot");
	});

	test("markSeen writes the signature, since and the time read", () => {
		const s = snapshotOf(TASKS);
		const entry = entryOf(s, BOARD, "w3:b");
		const store = storeOf(stateOf(false));
		markSeen(store, entry, NOW + 7);
		expect(readUnread(store)).toEqual({
			v: 1,
			seeded: false,
			seen: { "w3:b": { sig: entrySig(entry), since: entry.since, at: NOW + 7 } },
		});
	});

	test("prune drops gone marks older than 14 days, keeps present ones however old, caps at 1,000", () => {
		const s = snapshotOf(TASKS);
		const store = storeOf(
			stateOf(true, {
				"w3:a": { sig: "x", since: 0, at: NOW - 90 * DAY },
				"gone-old": { sig: "x", since: 0, at: NOW - UNREAD_KEEP_MS - 1 },
				"gone-new": { sig: "x", since: 0, at: NOW - UNREAD_KEEP_MS },
			}),
		);
		expect(pruneStore(store, s, BOARD, NOW)).toBe(true);
		expect(Object.keys(readUnread(store).seen).sort()).toEqual(["gone-new", "w3:a"]);
		expect(readUnread(store).seeded).toBe(true);
		// Nothing to drop: no write.
		expect(pruneStore(store, s, BOARD, NOW)).toBe(false);
		expect(store.writes).toBe(1);

		const seen: UnreadState["seen"] = { "w3:a": { sig: "x", since: 0, at: NOW - 10 * DAY } };
		for (let i = 0; i < UNREAD_MAX + 5; i += 1) seen[`gone-${i}`] = { sig: "x", since: 0, at: NOW - i * 60_000 };
		const full = storeOf(stateOf(true, seen));
		expect(pruneStore(full, s, BOARD, NOW)).toBe(true);
		const left = Object.keys(readUnread(full).seen);
		expect(left.length).toBe(UNREAD_MAX);
		// The present entry is the oldest read and stays; the longest-read gone ones went.
		expect(left).toContain("w3:a");
		expect(left).toContain("gone-0");
		expect(left).toContain(`gone-${UNREAD_MAX - 2}`);
		expect(left).not.toContain(`gone-${UNREAD_MAX - 1}`);
	});
});

describe("AC-3: the unread dot and the column's unread line", () => {
	const s = snapshotOf([task("T-20261104-74", { error: "outcome.md 없음" }), task("T-20261104-75")]);
	const BOARD = boardOf([
		card("w3:x", "blocked", "attention", { since: NOW - 30 * 60_000 }),
		card("w3:y", "blocked", "attention", { since: NOW - 10 * 60_000 }),
		card("w3:z", "working", "working", { taskId: "T-20261104-75" }),
		card("w3:d", "done", "done"),
	]);

	const column = (html: string, id: string): string => {
		const start = html.indexOf(`id="col-${id}"`);
		if (start < 0) throw new Error(`no column ${id}`);
		return html.slice(start, html.indexOf("</section>", start));
	};
	const cardHtml = (html: string, key: string): string => {
		const at = html.indexOf(`data-card="${key}"`);
		return html.slice(html.lastIndexOf("<a ", at), html.indexOf("</a>", at));
	};

	test("only the unread cards carry the dot; each column counts its own", () => {
		const html = renderDashboardMain(s, BOARD, NOW, { unread: ["w3:x", "T-20261104-74", "w3:d"] });
		expect(cardHtml(html, "w3:x")).toContain('class="unread-dot"');
		expect(cardHtml(html, "w3:x")).toContain(" is-unread");
		expect(cardHtml(html, "w3:d")).toContain('class="unread-dot"');
		for (const key of ["w3:y", "w3:z"]) expect(cardHtml(html, key)).not.toContain("unread-dot");
		expect(html.split('class="unread-dot"').length - 1).toBe(3);
		expect(column(html, "attention")).toContain(
			'</h2><div class="col-unread"><span>안 읽음 <b>2</b></span><button type="button" class="button is-ghost is-sm" data-mark-read="attention">모두 읽음</button></div>',
		);
		expect(column(html, "wait")).toContain("안 읽음 <b>1</b>");
		expect(column(html, "working")).not.toContain("col-unread");
		// The head itself is the one the inbox tests pin.
		expect(column(html, "attention")).toMatch(
			/<h2 class="col-head"><span>확인 필요<\/span><span class="count-chip">3<\/span><\/h2>/,
		);
	});

	test("the count follows the search: hidden cards are not counted", () => {
		const html = renderDashboardMain(s, BOARD, NOW, { q: "w3:y", unread: ["w3:x", "T-20261104-74"] });
		expect(column(html, "attention")).not.toContain("col-unread");
		expect(html).not.toContain("unread-dot");
	});

	test("the list view puts the dot before the title", () => {
		const html = renderDashboardMain(s, BOARD, NOW, { view: "list", unread: ["w3:z"] });
		expect(html).toContain('<td class="list-title"><span class="unread-dot" title="안 읽음"');
		expect(html.split('class="unread-dot"').length - 1).toBe(1);
	});

	test("order, numbers, the next line and the tab title do not depend on read marks", () => {
		const all = inboxEntries(s, BOARD).map((entry) => entry.id);
		const plain = renderDashboardMain(s, BOARD, NOW);
		const marked = renderDashboardMain(s, BOARD, NOW, { unread: all });
		const strip = (html: string): string =>
			html
				.replace(/<span class="unread-dot"[^>]*><\/span>/g, "")
				.replace(/<div class="col-unread">.*?<\/div>/g, "")
				.replace(/ is-unread/g, "");
		expect(strip(marked)).toBe(plain);
		expect(inboxAttention(s, BOARD).map((entry) => entry.id)).toEqual(["T-20261104-74", "w3:x", "w3:y"]);
		expect(tabSignal(s, BOARD, false).title).toBe("(3) 확인 필요 · ompbot 현황판");
	});

	test("nothing unread: no dot, no unread line", () => {
		const html = renderDashboardMain(s, BOARD, NOW, { unread: [] });
		expect(html).not.toContain("unread-dot");
		expect(html).not.toContain("col-unread");
	});
});

describe("AC-4: the page ships the read-mark functions and constants", () => {
	test("the inline script defines all of them", () => {
		const html = renderDashboardPage(snapshotOf([task("T-20261104-76")]), { board: boardOf([]) });
		for (const name of ["entrySig", "unreadIds", "seedStore", "markSeen", "pruneStore", "readUnread", "unreadReady"]) {
			expect(html).toContain(`const ${name} = function ${name}(`);
		}
		expect(html).toContain('const UNREAD_KEY = "ompbot-inbox-seen";');
		expect(html).toContain(`const UNREAD_KEEP_MS = ${14 * DAY};`);
		expect(html).toContain("const UNREAD_MAX = 1000;");
	});

	test("the shipped functions run on their own with the page's other helpers", () => {
		const html = renderDashboardPage(snapshotOf([task("T-20261104-76")]), { board: boardOf([]) });
		const script = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
		// The script boots only with a window; here it just defines its helpers.
		const run = new Function(`${script}\nreturn { seedStore, unreadIds, inboxEntries };`) as () => {
			seedStore: typeof seedStore;
			unreadIds: typeof unreadIds;
			inboxEntries: typeof inboxEntries;
		};
		const shipped = run();
		const s = snapshotOf([task("T-20261104-77")]);
		const store = storeOf();
		expect(shipped.seedStore(store, s, undefined, NOW)).toBe(true);
		const fresh = snapshotOf([task("T-20261104-77"), task("T-20261104-78")]);
		expect(shipped.unreadIds(shipped.inboxEntries(fresh, undefined), store)).toEqual(["T-20261104-78"]);
	});
});
