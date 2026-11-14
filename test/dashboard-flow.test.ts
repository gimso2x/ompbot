import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { QUOTED_HEADER } from "../src/core/normalize";
import {
	discordThreadHref,
	renderDashboardPage,
	renderFlowChain,
	renderTaskFacts,
	slackThreadHref,
} from "../src/dashboard/html";
import {
	buildSnapshot,
	type DashboardSnapshot,
	type FlowChainInfo,
	previewLine,
	type SnapshotDeps,
	type TaskInfo,
} from "../src/dashboard/snapshot";
import { INJECTION_WARNING_HEAD } from "../src/safety/injection";
import { openStore } from "../src/store/db";
import { formatTypicalRange, typicalNote } from "../src/store/turn-duration";
import type { TaskHostOps } from "../src/tasks/host";
import { makeHome, type TestHome } from "./helpers/bot-home";

const NOW = Date.parse("2026-11-10T01:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** The fake bot token every dashboard test uses; `redact` masks its shape. */
const TOKEN = "xoxb-TEST-0";
const REQUEST_A = `<https://example.test/pr/1|PR 1> 고쳐 줘 ${TOKEN}\n둘째 줄`;
const INTEGRITY = "무결성 검사용 git diff가 스윕 상한을 넘음";

let home: TestHome;
let dbPath: string;

interface Seed {
	id: string;
	thread: string;
	status: "working" | "blocked" | "review" | "done" | "cancelled";
	created: number;
	updated: number;
	closed?: number;
	progress?: number;
	notices?: Record<string, number>;
	moves?: Array<[string | null, string, number]>;
}

/** Tasks (and their transitions) through raw SQL after the schema exists; the first move is the registration. */
function seed(db: Database, tasks: Seed[]): void {
	for (const t of tasks) {
		db.run(
			`INSERT INTO tasks (task_id, title, risk, origin_key, thread_ref, host, repo, worktree, branch, agent, status,
				acceptance_json, created_at, updated_at, progress_at, notices_json, closed_at)
			 VALUES (?, ?, 'L2', ?, ?, NULL, '/srv/work/repo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				t.id,
				`title ${t.id}`,
				`slack/ch/C1/t/${t.thread}`,
				t.thread,
				`/srv/work/repo-${t.id.toLowerCase()}`,
				`task/${t.id}`,
				t.id.toLowerCase(),
				t.status,
				JSON.stringify([
					{ id: "AC-1", text: "one" },
					{ id: "AC-2", text: "two" },
				]),
				t.created,
				t.updated,
				t.progress ?? null,
				JSON.stringify(t.notices ?? {}),
				t.closed ?? null,
			],
		);
		for (const [from, to, at] of [
			[null, "working", t.created] as [string | null, string, number],
			...(t.moves ?? []),
		]) {
			db.run(
				"INSERT INTO task_transitions (task_id, from_status, to_status, actor, reason, at) VALUES (?, ?, ?, 'bot', ?, ?)",
				[t.id, from, to, to === "blocked" ? INTEGRITY : to, at],
			);
		}
	}
}

/**
 * A: done → working → review (registration order); B: blocked; C: done 8 days ago; D: registered 8 days ago, still
 * open; E: the oldest of the 21 TASKs closed in the last 7 days plus an open TASK. The other 20 closed TASKs (thread F)
 * were registered 10 days ago, so F is no flow and they push E's closed TASK out of the snapshot's closed TASKs.
 */
function seedDatabase(): void {
	openStore({ timezone: "Asia/Seoul", path: dbPath, clock: { now: () => NOW }, redact: (text) => text }).close();
	const db = new Database(dbPath, { strict: true });
	for (const thread of ["A", "B"]) {
		db.run("INSERT INTO origins (origin_key, epoch, session_dir, updated_at) VALUES (?, 1, '/s', ?)", [
			`slack/ch/C1/t/${thread}`,
			NOW,
		]);
	}
	db.run(
		`INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, thread_ref)
		 VALUES ('a1', 'slack/ch/C1/t/A', 1, ?, 'answered', ?, 'A'), ('a2', 'slack/ch/C1/t/A', 1, '나중 말', 'answered', ?, 'A'),
		        ('b1', 'slack/ch/C1/t/B', 1, '<https://example.test/docs/x> 봐 줘', 'answered', ?, 'B')`,
		[REQUEST_A, NOW - 4 * HOUR, NOW - 3 * HOUR, NOW - 6 * HOUR],
	);
	seed(db, [
		{
			id: "T-A1",
			thread: "A",
			status: "done",
			created: NOW - 3 * HOUR,
			updated: NOW - 170 * MIN,
			closed: NOW - 170 * MIN,
			notices: { "reached:a": NOW - 175 * MIN },
			moves: [
				["working", "review", NOW - 175 * MIN],
				["review", "done", NOW - 170 * MIN],
			],
		},
		{
			id: "T-A2",
			thread: "A",
			status: "working",
			created: NOW - 2 * HOUR,
			updated: NOW - 40 * MIN,
			progress: NOW - 40 * MIN,
		},
		{
			id: "T-A3",
			thread: "A",
			status: "review",
			created: NOW - HOUR,
			updated: NOW - 20 * MIN,
			notices: { "reached:b": NOW - 20 * MIN },
			moves: [["working", "review", NOW - 20 * MIN]],
		},
		{
			id: "T-B1",
			thread: "B",
			status: "blocked",
			created: NOW - 5 * HOUR,
			updated: NOW - 10 * MIN,
			notices: { [`blocked:1:${INTEGRITY}`]: NOW - 10 * MIN },
			moves: [["working", "blocked", NOW - 10 * MIN]],
		},
		{
			id: "T-C1",
			thread: "C",
			status: "done",
			created: NOW - 8 * DAY,
			updated: NOW - 8 * DAY + HOUR,
			closed: NOW - 8 * DAY + HOUR,
			moves: [["working", "done", NOW - 8 * DAY + HOUR]],
		},
		{ id: "T-D1", thread: "D", status: "working", created: NOW - 8 * DAY, updated: NOW - 4 * HOUR },
		{
			id: "T-E1",
			thread: "E",
			status: "done",
			created: NOW - 7 * DAY + 30 * MIN,
			updated: NOW - 7 * DAY + HOUR,
			closed: NOW - 7 * DAY + HOUR,
			moves: [["working", "done", NOW - 7 * DAY + HOUR]],
		},
		{ id: "T-E2", thread: "E", status: "working", created: NOW - DAY, updated: NOW - HOUR },
		...Array.from(
			{ length: 20 },
			(_, i): Seed => ({
				id: `T-F${String(i).padStart(2, "0")}`,
				thread: "F",
				status: "done",
				created: NOW - 10 * DAY,
				updated: NOW - 6 * DAY + i * HOUR,
				closed: NOW - 6 * DAY + i * HOUR,
				moves: [["working", "done", NOW - 6 * DAY + i * HOUR]],
			}),
		),
	]);
	db.close();
}

const hostOps = (): TaskHostOps => ({
	readFile: async () => ({ ok: true, value: undefined }),
	readBytes: async () => ({ ok: true, value: undefined }),
	commitOnTaskBranch: async () => "ok",
	pathExists: async () => ({ ok: true, value: true }),
	createWorktree: async () => ({ ok: false, error: "read-only" }),
	removeWorktree: async () => undefined,
	writeFile: async () => ({ ok: false, error: "read-only" }),
	commitDocs: async () => ({ ok: false, error: "read-only" }),
	runCheck: async () => {
		throw new Error("the dashboard never runs checks");
	},
	headOf: async () => {
		throw new Error("the dashboard never runs checks");
	},
	branchDiff: async () => {
		throw new Error("the dashboard never reads the branch diff");
	},
});

const deps = (): SnapshotDeps => ({
	homeDir: home.dir,
	repoDir: "/srv/ompbot",
	timezone: "Asia/Seoul",
	config: undefined,
	now: () => NOW,
	callDaemon: async () => Promise.reject(new Error("no daemon")),
	run: async () => ({ code: 0, stdout: "abc1234\n", timedOut: false }),
	ompVersion: async () => "omp-stub 0.0.0",
	hostOps,
	collectGates: () => [],
});

const flowsOf = (snapshot: DashboardSnapshot): FlowChainInfo[] => {
	if (snapshot.flows === undefined || !snapshot.flows.ok) throw new Error(`flows: ${JSON.stringify(snapshot.flows)}`);
	return snapshot.flows.items;
};
const chain = (flows: FlowChainInfo[], thread: string): FlowChainInfo => {
	const found = flows.find((item) => item.threadRef === thread);
	if (found === undefined) throw new Error(`no flow ${thread}`);
	return found;
};

beforeEach(() => {
	home = makeHome("ompbot-flow-");
	dbPath = join(home.dir, "ompbot.db");
	seedDatabase();
});
afterEach(() => home.remove());

describe("flows snapshot", () => {
	test("AC-2: threads with a TASK in 7 days or an open TASK, open first, here/now/done from the flow's own rows", async () => {
		const snapshot = await buildSnapshot(deps());
		const flows = flowsOf(snapshot);
		// Open cards first, then by the newest TASK update: B (10 min) · A (20 min) · E (1 h) · D (4 h).
		expect(flows.map((item) => item.threadRef)).toEqual(["B", "A", "E", "D"]);

		const a = chain(flows, "A");
		expect(a.tasks.map((t) => t.taskId)).toEqual(["T-A1", "T-A2", "T-A3"]);
		expect(a.here).toBe("T-A2");
		expect(a.now).toStartWith("T-A2 구현 중");
		expect(a.now).toEndWith(" · 외 열림 1");
		expect([a.done, a.total]).toEqual([1, 3]);
		expect(a.title).toBe("PR 1 고쳐 줘 [REDACTED] 둘째 줄");
		expect(a.originKey).toBe("slack/ch/C1/t/A");
		expect(a.place).toBe("채널 C1 스레드");
		expect(a.tasks[2]?.stage).toEqual({ label: "오너 리뷰 차례", msg: "Outcome 도달 · 머지 대기", tone: "wait" });

		const b = chain(flows, "B");
		expect(b.here).toBe("T-B1");
		expect(b.tasks[0]?.stage.label).toBe("무결성에서 막힘");
		expect(b.tasks[0]?.stage.tone).toBe("fail");
		expect(b.title).toBe("example.test/docs/x 봐 줘");
		expect(b.now).not.toContain("외 열림");

		const d = chain(flows, "D");
		expect(d.here).toBe("T-D1");
		expect(d.title).toBe("(원문 없음)");

		// E's closed TASK is past the snapshot's 20 closed TASKs, yet its step carries every fact of its own row.
		if (!snapshot.tasks.ok) throw new Error(snapshot.tasks.error);
		expect(snapshot.tasks.items.some((t: TaskInfo) => t.taskId === "T-E1")).toBe(false);
		const e1 = chain(flows, "E").tasks.find((t) => t.taskId === "T-E1");
		expect(e1?.title).toBe("title T-E1");
		expect(e1?.branch).toBe("task/T-E1");
		expect(e1?.closedAt).toBe("2026-11-03T11:00:00+09:00");
		expect(e1?.acTotal).toBe(2);
		expect(e1?.stage.tone).toBe("done");
		expect(chain(flows, "E").here).toBe("T-E2");
	});

	test("a thread whose TASKs are all closed: here null, now names the last close", async () => {
		const db = new Database(dbPath, { strict: true });
		seed(db, [
			{
				id: "T-G1",
				thread: "G",
				status: "done",
				created: NOW - 2 * HOUR,
				updated: NOW - MIN,
				closed: NOW - MIN,
				moves: [["working", "done", NOW - MIN]],
			},
		]);
		db.close();
		const flows = flowsOf(await buildSnapshot(deps()));
		// Newest update of all, still after every open card.
		expect(flows.map((item) => item.threadRef)).toEqual(["B", "A", "E", "D", "G"]);
		const g = chain(flows, "G");
		expect(g.here).toBeNull();
		expect(g.now).toBe("모두 끝남 · 마지막 close 11-10 09:59");
	});
});

describe("flow view", () => {
	test("AC-3: one chain card per flow, no filter buttons, one 지금 여기 per open card, masked request lines", async () => {
		const db = new Database(dbPath, { strict: true });
		seed(db, [
			{
				id: "T-G1",
				thread: "G",
				status: "done",
				created: NOW - 2 * HOUR,
				updated: NOW - MIN,
				closed: NOW - MIN,
				moves: [["working", "done", NOW - MIN]],
			},
		]);
		db.close();
		const snapshot = await buildSnapshot(deps());
		const flows = flowsOf(snapshot);
		const page = renderDashboardPage(snapshot, { view: "flow" });
		// The server-drawn view, not the shipped renderer source in the inline script.
		const html = /<div id="main"[^>]*>([\s\S]*?)<\/div>\n<div class="search">/.exec(page)?.[1] ?? "";

		const cards = html.split('<section class="flow-card').slice(1);
		expect(cards.length).toBe(flows.length);
		const heres = (card: string) => card.split('class="flow-here-chip"').length - 1;
		expect(cards.map(heres)).toEqual([1, 1, 1, 1, 0]);
		expect(cards[4]).toContain("is-closed");
		for (const word of ["진행 중 먼저", 'class="filters"', 'aria-pressed="true">7일']) expect(html).not.toContain(word);

		expect(html).toContain("PR 1 고쳐 줘 [REDACTED] 둘째 줄");
		expect(page).not.toContain(TOKEN);
		expect(JSON.stringify(snapshot)).not.toContain(TOKEN);
		expect(html).not.toContain("https://example.test/pr/1");
		expect(html).toContain("1/3 끝남");
		// The flow view is in the side nav, current on its own page.
		expect(html).toContain('data-view="flow" aria-current="page"');
		// The request box opens its conversation in the turns view; a TASK box opens its panel here.
		expect(html).toContain('href="?view=turns&amp;item=slack%2Fch%2FC1%2Ft%2FA"');
		expect(html).toContain('href="?view=flow&amp;item=T-A2" data-item="T-A2"');
	});

	test("a conversation's and a TASK's detail panels carry the request's chain", async () => {
		const snapshot = await buildSnapshot(deps());
		const headOf = (page: string) =>
			/<div id="detail-head"[^>]*>([\s\S]*?)<\/div>\n<section id="detail-plan"/.exec(page)?.[1] ?? "";
		const chainOf = (head: string) => /<section class="detail-flow"[\s\S]*?<\/section>/.exec(head)?.[0] ?? "";

		// The turns panel of thread A: its three TASKs, 1/3 끝남, 지금 여기 on the working one, no box selected.
		const turn = chainOf(headOf(renderDashboardPage(snapshot, { view: "turns", item: "slack/ch/C1/t/A" })));
		expect(turn).toContain("1/3 끝남");
		for (const id of ["T-A1", "T-A2", "T-A3"]) expect(turn).toContain(`<b>${id}</b>`);
		expect(turn.split('class="flow-here-chip"').length - 1).toBe(1);
		expect(turn).toMatch(/class="flow-box t-run is-here" href="\?view=flow&amp;item=T-A2"/);
		expect(turn).not.toContain("is-selected");
		// Inside a panel the boxes go to the flow view's page, not to an item of the turns view.
		expect(turn).not.toContain("data-item=");

		// The TASK panel of the review TASK: the same chain with its own box selected.
		const task = chainOf(headOf(renderDashboardPage(snapshot, { task: "T-A3" })));
		expect(task).toContain("1/3 끝남");
		expect(task).toMatch(
			/class="flow-box t-wait is-selected" href="\?view=flow&amp;item=T-A3"[^>]*aria-current="true"/,
		);

		// A conversation with no TASK has no chain section.
		const lone = renderDashboardPage(
			{ ...snapshot, flows: { ok: true, items: [] } },
			{ view: "turns", item: "slack/ch/C1/t/A" },
		);
		expect(headOf(lone)).not.toContain("detail-flow");
	});

	test("a conversation's panel bar links to its Slack thread on every tab, only with the workspace id", async () => {
		expect(slackThreadHref("T1", "C0123456789:1794271582.056679")).toBe(
			"slack://channel?team=T1&id=C0123456789&message=1794271582.056679&thread_ts=1794271582.056679",
		);
		expect(slackThreadHref("T1", "D0123456789:1794271582.056679")).toContain("id=D0123456789&message=");
		expect(slackThreadHref("T1", "C1ABC:-")).toBe("slack://channel?team=T1&id=C1ABC");
		expect(slackThreadHref(null, "C1ABC:1.2")).toBe("");
		expect(slackThreadHref("T1", "A")).toBe("");

		const built = await buildSnapshot(deps());
		if (!built.turns.ok) throw new Error(built.turns.error);
		const turns = {
			...built.turns,
			threads: built.turns.threads.map((thread) =>
				thread.originKey === "slack/ch/C1/t/A" ? { ...thread, threadRef: "C1ABC:1794271582.056679" } : thread,
			),
		};
		const barOf = (page: string) => /<div class="detail-bar">([\s\S]*?)<\/div>/.exec(page)?.[1] ?? "";
		const bar = barOf(
			renderDashboardPage({ ...built, turns, slackTeam: "T1" }, { view: "turns", item: "slack/ch/C1/t/A" }),
		);
		expect(bar).toContain(
			'id="detail-slack" class="button is-ghost detail-slack" href="slack://channel?team=T1&amp;id=C1ABC&amp;message=1794271582.056679&amp;thread_ts=1794271582.056679">',
		);
		// Without the workspace id, or on a panel that is not a conversation, the link is there but hidden.
		expect(barOf(renderDashboardPage({ ...built, turns }, { view: "turns", item: "slack/ch/C1/t/A" }))).toMatch(
			/id="detail-slack"[^>]* hidden>/,
		);
		expect(barOf(renderDashboardPage({ ...built, turns, slackTeam: "T1" }, { task: "T-A3" }))).toMatch(
			/id="detail-slack"[^>]* hidden>/,
		);
	});

	test("a Discord conversation's panel bar links to Discord: DMs always, server threads and lanes with the one server id", async () => {
		const guild = "100000000000000001"; // gitleaks:allow (fake snowflake)
		const ch = "100000000000000002"; // gitleaks:allow (fake snowflake)
		const msg = "100000000000000003"; // gitleaks:allow (fake snowflake)
		const web = "https://discord.com/channels";
		expect(discordThreadHref(null, `discord/dm/${ch}`, `${ch}:${msg}`)).toBe(`${web}/@me/${ch}/${msg}`);
		expect(discordThreadHref(guild, `discord/ch/${ch}/t/${msg}`, `${ch}:${msg}`)).toBe(`${web}/${guild}/${msg}`);
		expect(discordThreadHref(guild, "ompbot/work/L-20261111-01", `${ch}:${msg}`)).toBe(`${web}/${guild}/${msg}`);
		expect(discordThreadHref(guild, `discord/ch/${ch}`, `${ch}:${msg}`)).toBe(`${web}/${guild}/${ch}/${msg}`);
		expect(discordThreadHref(null, `discord/ch/${ch}/t/${msg}`, `${ch}:${msg}`)).toBe("");
		expect(discordThreadHref(guild, "monitor/m1", `${ch}:${msg}`)).toBe("");
		expect(discordThreadHref(guild, "slack/ch/C1/t/A", "C1ABC:1794271582.056679")).toBe("");

		// The one configured server becomes the snapshot's `discordGuild`; none or several leave it null.
		const base = deps();
		const withGuilds = (guildIds: string[]) =>
			buildSnapshot({ ...base, config: { ...base.config, channels: { discord: { guildIds } } } });
		expect((await withGuilds([guild])).discordGuild).toBe(guild);
		expect((await withGuilds([guild, ch])).discordGuild).toBeNull();

		const built = await buildSnapshot(deps());
		if (!built.turns.ok) throw new Error(built.turns.error);
		const key = `discord/ch/${ch}/t/${msg}`;
		const turns = {
			...built.turns,
			threads: built.turns.threads.map((thread) =>
				thread.originKey === "slack/ch/C1/t/A" ? { ...thread, originKey: key, threadRef: `${ch}:${msg}` } : thread,
			),
		};
		const barOf = (page: string) => /<div class="detail-bar">([\s\S]*?)<\/div>/.exec(page)?.[1] ?? "";
		const bar = barOf(
			renderDashboardPage({ ...built, turns, slackTeam: "T1", discordGuild: guild }, { view: "turns", item: key }),
		);
		expect(bar).toContain(
			`id="detail-discord" class="button is-ghost detail-slack" href="${web}/${guild}/${msg}" target="_blank" rel="noopener noreferrer">디스코드에서 답하기`,
		);
		// A Discord conversation has no Slack link; without the server id its Discord link is hidden too.
		expect(bar).toMatch(/id="detail-slack"[^>]* hidden>/);
		expect(barOf(renderDashboardPage({ ...built, turns }, { view: "turns", item: key }))).toMatch(
			/id="detail-discord"[^>]* hidden>/,
		);
	});

	test("AC-3: ?view=flow&item=<closed TASK past the snapshot's limit> opens its panel with title and branch", async () => {
		const snapshot = await buildSnapshot(deps());
		const html = renderDashboardPage(snapshot, { view: "flow", item: "T-E1" });
		const head = /<div id="detail-head"[^>]*>([\s\S]*?)<\/div>\n<section id="detail-plan"/.exec(html)?.[1] ?? "";
		expect(head).toContain("title T-E1");
		expect(head).toContain("task/T-E1");
		expect(head).toContain("완료");
		expect(head).not.toContain("지금 목록에 없는");
		expect(html).toContain('<aside id="detail" class="detail is-open"');

		// An open TASK also carries the snapshot's TASK facts (AC progress line from the inbox renderer).
		const open = renderDashboardPage(snapshot, { view: "flow", item: "T-A2" });
		const openHead = /<div id="detail-head"[^>]*>([\s\S]*?)<\/div>\n<section id="detail-plan"/.exec(open)?.[1] ?? "";
		expect(openHead).toContain("title T-A2");
		expect(openHead).toContain("구현 중");
	});
});

describe("request preview without ompbot's quote wrapping", () => {
	const fence = (id: string, body: string): string => `<<<quoted-${id}>>>\n${body}\n<<<end-quoted-${id}>>>`;
	const QUOTE = `${QUOTED_HEADER}\n${fence("0123456789abcdef", "인용된 글 <https://x.test|링크>")}`;
	const clean = (line: string): void => {
		expect(line).not.toContain("인용·전달된 자료");
		expect(line).not.toContain("<<<");
	};

	test("AC-3 (a)(b)(d): only the owner's own words remain, in order; an unclosed open marker drops the rest", () => {
		const a = previewLine(`github.com/jin-doh/traceknot 분석\n\n${QUOTE}`);
		expect(a).toBe("github.com/jin-doh/traceknot 분석");
		clean(a);
		const b = previewLine(
			`앞 글\n${QUOTE}\n뒤에 붙인 글\n${INJECTION_WARNING_HEAD} 1곳 있다.\n${QUOTED_HEADER}\n${fence("fedcba9876543210", "둘째 인용")}`,
		);
		expect(b).toBe("앞 글 뒤에 붙인 글");
		clean(b);
		const d = previewLine(`표지 앞 글\n${QUOTED_HEADER}\n<<<quoted-0123456789abcdef>>>\n닫히지 않은 인용`);
		expect(d).toBe("표지 앞 글");
		clean(d);
	});

	test("AC-3 (c)(e): with nothing of the owner's left, the line is [첨부] and the file name or the fallback title", () => {
		const c = previewLine(QUOTE);
		expect(c).toBe("[첨부]");
		clean(c);
		expect(previewLine(QUOTE, "title T-D1")).toBe("[첨부] title T-D1");
		expect(previewLine("[첨부: a.png]")).toBe("[첨부] a.png");
		expect(previewLine("[첨부: /home/u/.ompbot/media/img_1.png (image/png)]")).toBe("[첨부] img_1.png");
		expect(previewLine("[첨부: a.png]", "title T-D1")).toBe("[첨부] title T-D1");
		expect(previewLine(`봐 줘 [첨부: a.png] ${TOKEN}`)).toBe("봐 줘 [첨부] [REDACTED]");
	});

	test("AC-3 (c)(e): a flow whose request is a quote only or an attachment only is titled [첨부] + its first TASK", async () => {
		const db = new Database(dbPath, { strict: true });
		db.run(
			`INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, thread_ref)
			 VALUES ('d1', 'slack/ch/C1/t/D', 1, ?, 'answered', ?, 'D')`,
			[QUOTE, NOW - 8 * DAY],
		);
		const quoted = chain(flowsOf(await buildSnapshot(deps())), "D");
		expect(quoted.title).toBe("[첨부] title T-D1");
		db.run("UPDATE inbound SET text_ref = '[첨부: a.png]' WHERE platform_message_id = 'd1'");
		db.close();
		expect(chain(flowsOf(await buildSnapshot(deps())), "D").title).toBe("[첨부] title T-D1");
	});
});

/** A flow of TASKs registered/closed at the given `+09:00` times (`closed` undefined = still open). */
const flowOf = (tasks: Array<{ id: string; created: string; closed?: string }>): FlowChainInfo => ({
	threadRef: "Q",
	originKey: "slack/ch/C1/t/Q",
	place: "채널 C1 스레드",
	title: "qa 50개",
	requestedAt: "2026-11-12T01:07:00+09:00",
	updatedAt: "2026-11-12T08:04:34+09:00",
	done: tasks.filter((task) => task.closed !== undefined).length,
	total: tasks.length,
	here: tasks.find((task) => task.closed === undefined)?.id ?? null,
	now: "지금 줄",
	tasks: tasks.map((task) => ({
		taskId: task.id,
		title: `title ${task.id}`,
		status: task.closed === undefined ? "working" : "done",
		risk: "L1",
		host: "local",
		branch: `task/${task.id}`,
		createdAt: task.created,
		...(task.closed === undefined ? {} : { closedAt: task.closed }),
		acTotal: 3,
		stage:
			task.closed === undefined ? { label: "구현 중", msg: "", tone: "run" } : { label: "끝남", msg: "", tone: "done" },
	})),
});
const at = (time: string): string => `2026-11-12T${time}+09:00`;
/** The TASK ids of each parallel group, in drawing order. */
const groupsIn = (html: string): string[][] =>
	html
		.split('<div class="flow-group"')
		.slice(1)
		.map((group) => [...group.matchAll(/<b>(T-[^<]+)<\/b>/g)].map((match) => match[1] ?? ""));
const gapsIn = (html: string): string[] =>
	[...html.matchAll(/class="flow-gap">대기 ([^<]*)</g)].map((match) => match[1] ?? "");
/** The qa50 request's real times: three rounds of 3 · 3 · 2 parallel TASKs. */
const QA50 = flowOf([
	{ id: "T-20261112-02", created: at("01:07:55"), closed: at("01:33:31") },
	{ id: "T-20261112-03", created: at("01:08:21"), closed: at("01:33:33") },
	{ id: "T-20261112-04", created: at("01:08:42"), closed: at("01:33:34") },
	{ id: "T-20261112-05", created: at("01:46:01"), closed: at("02:33:56") },
	{ id: "T-20261112-06", created: at("01:46:05"), closed: at("02:33:57") },
	{ id: "T-20261112-07", created: at("01:46:11"), closed: at("01:59:25") },
	{ id: "T-20261112-08", created: at("07:34:58"), closed: at("08:01:19") },
	{ id: "T-20261112-09", created: at("07:35:18"), closed: at("08:04:34") },
]);

/** A judged TASK with `n` steps, the first `done` of them done and `current` as PROGRESS `current`. */
const taskOf = (n: number, done: number, current: string, extra: Partial<TaskInfo> = {}): TaskInfo => ({
	taskId: "T-20261112-99",
	title: "띠",
	risk: "L1",
	status: "working",
	host: "local",
	agent: "t-20261112-99",
	branch: "task/T-20261112-99",
	open: true,
	updatedAt: at("09:00:00"),
	acChecked: 1,
	acTotal: 8,
	stepsDone: done,
	stepsTotal: n,
	progress: { status: "working", updated: at("09:00:00"), current, blockedReason: "" },
	steps: Array.from({ length: n }, (_, index) => ({
		id: `S${index + 1}`,
		text: `단계 ${index + 1}`,
		done: index < done,
	})),
	...extra,
});
/** The band's cells as `text[:tone]`, `+here` on the cell with 지금 여기. */
const bandOf = (html: string): string[] => {
	const band = /<ol class="band[^"]*" aria-label="진행 띠">([\s\S]*?)<\/ol>/.exec(html)?.[1];
	if (band === undefined) return [];
	return [...band.matchAll(/<li class="band-cell( is-[a-z]+)?"[^>]*>([^<]*)(<span class="([^"]+)")?/g)].map(
		(match) =>
			`${match[2]}${match[1] === undefined ? "" : `:${match[1].trim().slice(3)}`}${match[4] === "flow-here-chip" ? "+here" : ""}`,
	);
};

describe("parallel groups in a flow", () => {
	test("AC-1: the qa50 times draw three groups of 3 · 3 · 2 with 12분 and 5시간 1분 between them", () => {
		const html = renderFlowChain(QA50, "", false);
		expect(groupsIn(html)).toEqual([
			["T-20261112-02", "T-20261112-03", "T-20261112-04"],
			["T-20261112-05", "T-20261112-06", "T-20261112-07"],
			["T-20261112-08", "T-20261112-09"],
		]);
		expect(gapsIn(html)).toEqual(["12분", "5시간 1분"]);
		expect(html).toContain("<b>1차 · 병렬 3</b><span>25분</span>");
		expect(html).toContain("<b>3차 · 병렬 2</b><span>29분</span>");
		expect(html).not.toContain("flow-arr");
		// Inside a panel the same groups, boxes without data-item.
		const panel = renderFlowChain(QA50, "T-20261112-05", true);
		expect(groupsIn(panel).map((group) => group.length)).toEqual([3, 3, 2]);
		expect(panel).not.toContain("data-item=");
		expect(panel).toMatch(/class="flow-box t-done is-selected" href="\?view=flow&amp;item=T-20261112-05"/);
	});

	test("AC-2: open TASKs join for 10 minutes only, closed-then-registered chains split, unparsable times go last", () => {
		// (a) Three open TASKs within a minute are one group; the next group after them shows no wait.
		const together = renderFlowChain(
			flowOf([
				{ id: "T-1", created: at("10:00:00") },
				{ id: "T-2", created: at("10:00:20") },
				{ id: "T-3", created: at("10:00:50") },
				{ id: "T-4", created: at("10:30:00") },
			]),
			"",
			false,
		);
		expect(groupsIn(together)).toEqual([["T-1", "T-2", "T-3"], ["T-4"]]);
		expect(gapsIn(together)).toEqual([]);
		expect(together).toContain("<b>1차 · 병렬 3</b><span>진행 중</span>");
		expect(together).toContain("<b>2차</b>");

		// (b) An open TASK does not swallow a TASK registered two hours later.
		const later = renderFlowChain(
			flowOf([
				{ id: "T-1", created: at("10:00:00") },
				{ id: "T-2", created: at("12:00:00") },
			]),
			"",
			false,
		);
		expect(groupsIn(later)).toEqual([["T-1"], ["T-2"]]);

		// (c) Each TASK registered after the one before closed is its own group.
		const chainHtml = renderFlowChain(
			flowOf([
				{ id: "T-1", created: at("10:00:00"), closed: at("10:30:00") },
				{ id: "T-2", created: at("10:40:00"), closed: at("11:00:00") },
				{ id: "T-3", created: at("11:00:00"), closed: at("11:20:00") },
			]),
			"",
			false,
		);
		expect(groupsIn(chainHtml)).toEqual([["T-1"], ["T-2"], ["T-3"]]);
		// 10 minutes, then none (registered right at the close: under a minute).
		expect(gapsIn(chainHtml)).toEqual(["10분"]);

		// (d) A TASK whose registration time does not parse is last, alone; the rest keep their groups and order.
		const broken = renderFlowChain(
			flowOf([
				{ id: "T-1", created: at("10:00:00"), closed: at("10:30:00") },
				{ id: "T-X", created: "?", closed: at("10:35:00") },
				{ id: "T-2", created: at("10:05:00"), closed: at("10:20:00") },
				{ id: "T-3", created: at("11:00:00"), closed: at("11:20:00") },
			]),
			"",
			false,
		);
		expect(groupsIn(broken)).toEqual([["T-1", "T-2"], ["T-3"], ["T-X"]]);
		expect(gapsIn(broken)).toEqual(["30분"]);
	});
});

describe("a TASK's step band", () => {
	test("AC-2b: 12 steps fold the done run before the current step and the steps past the next two", () => {
		expect(bandOf(renderTaskFacts(taskOf(12, 7, "S8 구현")))).toEqual([
			"스펙:done",
			"S1–S6 끝남:done",
			"S7:done",
			"S8:now+here",
			"S9",
			"S10",
			"+2 남음",
			"판정 1/8",
			"리뷰",
			"착지",
		]);
		// With S2 current nothing before it folds.
		const early = bandOf(renderTaskFacts(taskOf(12, 1, "S2")));
		expect(early.slice(0, 3)).toEqual(["스펙:done", "S1:done", "S2:now+here"]);
		expect(early.some((cell) => cell.includes("끝남"))).toBe(false);
	});

	test("AC-4: a working TASK's band marks only its current step and shows the AC count", () => {
		const html = renderTaskFacts(taskOf(4, 2, "S3: 구현"));
		expect(bandOf(html)).toEqual(["스펙:done", "S1:done", "S2:done", "S3:now+here", "S4", "판정 1/8", "리뷰", "착지"]);
		const band = /<ol class="band"[\s\S]*?<\/ol>/.exec(html)?.[0] ?? "";
		expect(band.split("지금 여기").length - 1).toBe(1);
		// The band comes before the AC and step lists.
		expect(html.indexOf('aria-label="진행 띠"')).toBeLessThan(html.indexOf('aria-label="단계 목록"'));
	});

	test("AC-5: blocked shows one red cell and its reason, done is all done, no steps no band", () => {
		const blocked = renderTaskFacts(
			taskOf(4, 2, "S3", {
				status: "blocked",
				progress: { status: "blocked", updated: at("09:00:00"), current: "S3", blockedReason: "토큰 없음" },
			}),
		);
		expect(bandOf(blocked).filter((cell) => cell.includes(":blocked"))).toEqual(["S3:blocked"]);
		expect(blocked).toContain('<p class="band-blocked">막힘 토큰 없음</p>');
		// No current step: the 판정 cell turns red.
		const noStep = renderTaskFacts(
			taskOf(4, 2, "", {
				status: "blocked",
				progress: { status: "blocked", updated: at("09:00:00"), current: "", blockedReason: "x" },
			}),
		);
		expect(bandOf(noStep).filter((cell) => cell.includes(":blocked"))).toEqual(["판정 1/8:blocked"]);

		const done = bandOf(renderTaskFacts(taskOf(4, 3, "S4", { status: "done", open: false })));
		expect(done.length).toBe(8);
		expect(done.every((cell) => cell.endsWith(":done"))).toBe(true);

		const bare = renderTaskFacts(taskOf(4, 0, "", { steps: undefined }));
		expect(bare).not.toContain("진행 띠");
		expect(renderTaskFacts(taskOf(0, 0, ""))).not.toContain("진행 띠");
	});

	test("review puts 지금 여기 on 리뷰; cancelled dims the band", () => {
		expect(bandOf(renderTaskFacts(taskOf(3, 3, "S3", { status: "review" }))).slice(-3)).toEqual([
			"판정 1/8:done",
			"리뷰:now+here",
			"착지",
		]);
		expect(renderTaskFacts(taskOf(3, 1, "S2", { status: "cancelled" }))).toContain('<ol class="band is-dim"');
	});
});

describe("a working TASK's elapsed and typical time", () => {
	/**
	 * `count` closed TASKs of thread S that went to review 10, 20, … minutes after registration, plus T-W1 (thread W)
	 * registered 30 minutes ago. With the fixture's T-A1 (5 min) and T-A3 (40 min) that is count + 2 samples.
	 */
	const seedSamples = (count: number): void => {
		const db = new Database(dbPath, { strict: true });
		seed(db, [
			...Array.from({ length: count }, (_, i): Seed => {
				const created = NOW - 2 * DAY + i * HOUR;
				const review = created + (i + 1) * 10 * MIN;
				return {
					id: `T-S${i}`,
					thread: "S",
					status: "done",
					created,
					updated: review + MIN,
					closed: review + MIN,
					moves: [
						["working", "review", review],
						["review", "done", review + MIN],
					],
				};
			}),
			{ id: "T-W1", thread: "W", status: "working", created: NOW - 30 * MIN, updated: NOW - 30 * MIN },
		]);
		db.close();
	};
	const taskOfId = (snapshot: DashboardSnapshot, id: string): TaskInfo => {
		if (!snapshot.tasks.ok) throw new Error(snapshot.tasks.error);
		const found = snapshot.tasks.items.find((task) => task.taskId === id);
		if (found === undefined) throw new Error(`no task ${id}`);
		return found;
	};
	const stepOf = (snapshot: DashboardSnapshot, id: string) => {
		const found = flowsOf(snapshot)
			.flatMap((item) => item.tasks)
			.find((step) => step.taskId === id);
		if (found === undefined) throw new Error(`no step ${id}`);
		return found;
	};
	const boxOf = (html: string, id: string): string =>
		new RegExp(`<a class="flow-box[^"]*" href="\\?view=flow&amp;item=${id}"[\\s\\S]*?</a>`).exec(html)?.[0] ?? "";
	const flowHtml = (snapshot: DashboardSnapshot): string =>
		/<div id="main"[^>]*>([\s\S]*?)<\/div>\n<div class="search">/.exec(
			renderDashboardPage(snapshot, { view: "flow" }),
		)?.[1] ?? "";

	test("AC-2: 11 samples give working TASKs the nearest-rank median and p90 and the time since registration", async () => {
		seedSamples(9);
		const snapshot = await buildSnapshot(deps());
		// 5, 10, 20, 30, 40, 40, 50, 60, 70, 80, 90 minutes: the 6th is the median, the 10th the p90.
		const typical = { medianMs: 40 * MIN, p90Ms: 80 * MIN };
		for (const [id, elapsedMs] of [
			["T-W1", 30 * MIN],
			["T-A2", 2 * HOUR],
			["T-E2", DAY],
		] as const) {
			expect(taskOfId(snapshot, id)).toMatchObject({ typical, elapsedMs });
			expect(stepOf(snapshot, id)).toMatchObject({ typical, elapsedMs });
		}
		for (const id of ["T-B1", "T-A3", "T-A1", "T-S0"]) {
			const step = stepOf(snapshot, id);
			expect([step.typical, step.elapsedMs]).toEqual([undefined, undefined]);
			if (id === "T-S0") continue;
			const task = taskOfId(snapshot, id);
			expect([task.typical, task.elapsedMs]).toEqual([undefined, undefined]);
		}
	});

	test("AC-2: 9 samples leave both fields out of every TASK", async () => {
		seedSamples(7);
		const snapshot = await buildSnapshot(deps());
		if (!snapshot.tasks.ok) throw new Error(snapshot.tasks.error);
		const all = [...snapshot.tasks.items, ...flowsOf(snapshot).flatMap((item) => item.tasks)];
		expect(all.some((task) => task.status === "working")).toBe(true);
		expect(all.filter((task) => task.typical !== undefined || task.elapsedMs !== undefined)).toEqual([]);
	});

	test("AC-3: the flow box reads 보통 a~b분 within p90 and 평소보다 길어짐 past it; facts and inbox follow", async () => {
		seedSamples(9);
		const snapshot = await buildSnapshot(deps());
		const html = flowHtml(snapshot);
		expect(boxOf(html, "T-W1")).toContain('<span class="flow-bs">경과 30분 · 보통 40~80분</span>');
		expect(boxOf(html, "T-A2")).toContain('<span class="flow-bs">경과 120분 · 평소보다 길어짐(보통 40~80분)</span>');
		for (const id of ["T-B1", "T-A3", "T-A1"]) expect(boxOf(html, id)).not.toContain("경과");
		expect(renderTaskFacts(taskOfId(snapshot, "T-W1"))).toContain(
			"<dt>걸린 시간</dt><dd>경과 30분 · 보통 40~80분</dd>",
		);
		expect(renderTaskFacts(taskOfId(snapshot, "T-B1"))).not.toContain("걸린 시간");
		const inbox = renderDashboardPage(snapshot, {});
		const cardOf = (id: string) =>
			new RegExp(`<a class="card[^"]*"[^>]*data-row="${id}"[\\s\\S]*?</a>`).exec(inbox)?.[0] ?? "";
		expect(cardOf("T-A2")).toContain("평소보다 길어짐");
		expect(cardOf("T-W1")).not.toContain("평소보다 길어짐");
		expect(cardOf("T-W1")).not.toBe("");
	});

	test("AC-3: too few samples draw no elapsed line", async () => {
		seedSamples(7);
		const snapshot = await buildSnapshot(deps());
		const html = flowHtml(snapshot);
		expect(boxOf(html, "T-W1")).not.toBe("");
		for (const word of ["경과 ", "보통 ", "평소보다 길어짐"]) expect(html).not.toContain(word);
		expect(renderDashboardPage(snapshot, {})).not.toContain("평소보다 길어짐</span>");
	});
});

describe("shipped renderers", () => {
	test("AC-6: renderFlowChain and renderTaskFacts evaluated alone from toString() draw what the server draws", () => {
		const names = ["Date", "Math", "String", "Number", "Array", "Object", "encodeURIComponent"] as const;
		const values = [Date, Math, String, Number, Array, Object, encodeURIComponent];
		const isolated = <T>(fn: T): T => new Function(...names, `"use strict"; return (${String(fn)});`)(...values) as T;
		// typicalNote ships beside them (the page script), with the formatTypicalRange it calls.
		const formatTypicalRangeShipped = isolated(formatTypicalRange);
		const typicalNoteShipped = new Function("formatTypicalRange", `"use strict"; return (${String(typicalNote)});`)(
			formatTypicalRangeShipped,
		) as typeof typicalNote;
		const withNote = <T>(fn: T): T =>
			new Function(...names, "typicalNote", `"use strict"; return (${String(fn)});`)(
				...values,
				typicalNoteShipped,
			) as T;
		const flow = withNote(renderFlowChain);
		const facts = withNote(renderTaskFacts);
		const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
		for (const [focus, panel] of [
			["", false],
			["T-20261112-05", true],
		] as const) {
			expect(flow(copy(QA50), focus, panel)).toBe(renderFlowChain(QA50, focus, panel));
		}
		const task = taskOf(4, 2, "S3: 구현");
		expect(facts(copy(task))).toBe(renderTaskFacts(task));
		const folded = taskOf(12, 7, "S8");
		expect(facts(copy(folded))).toBe(renderTaskFacts(folded));
		const typical = { medianMs: 40 * MIN, p90Ms: 80 * MIN };
		const timed = { ...task, typical, elapsedMs: 30 * MIN };
		expect(facts(copy(timed))).toBe(renderTaskFacts(timed));
		expect(renderTaskFacts(timed)).toContain("경과 30분 · 보통 40~80분");
		const late: FlowChainInfo = {
			...QA50,
			tasks: QA50.tasks.map((step, i) => (i === 0 ? { ...step, typical, elapsedMs: 90 * MIN } : step)),
		};
		expect(flow(copy(late), "", false)).toBe(renderFlowChain(late, "", false));
		expect(renderFlowChain(late, "", false)).toContain("경과 90분 · 평소보다 길어짐(보통 40~80분)");
	});
});
