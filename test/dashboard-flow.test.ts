import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { discordThreadHref, renderDashboardPage, slackThreadHref } from "../src/dashboard/html";
import {
	buildSnapshot,
	type DashboardSnapshot,
	type FlowChainInfo,
	type SnapshotDeps,
	type TaskInfo,
} from "../src/dashboard/snapshot";
import { openStore } from "../src/store/db";
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
	openStore({ path: dbPath, clock: { now: () => NOW }, redact: (text) => text }).close();
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
		// The flow view stays reachable by its address but is not in the side nav.
		expect(html).not.toContain('data-view="flow"');
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
