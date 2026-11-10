import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderConversation, renderDashboardMain, renderItemDetail } from "../src/dashboard/html";
import { renderMarkdown } from "../src/dashboard/markdown";
import { startDashboardServer } from "../src/dashboard/server";
import { buildSnapshot, type DashboardSnapshot, type SnapshotDeps } from "../src/dashboard/snapshot";
import { readThreadConversation } from "../src/dashboard/thread-conversation";
import { openStore } from "../src/store/db";

const NOW = Date.parse("2026-11-05T10:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ompbot-turn-board-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** A home with only a database: the turns section is under test, the other sections may fail. */
function deps(): SnapshotDeps {
	return {
		homeDir: home,
		repoDir: "/srv/ompbot",
		config: undefined,
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

interface Row {
	origin: string;
	text: string;
	state: string;
	createdAt: number;
	dispatchedAt?: number | null;
	lastEventAt?: number | null;
	opRef?: string;
}

/** Origins and their inbound rows, written through raw SQL after the schema exists. */
function seed(rows: Row[]): void {
	const dbPath = join(home, "ompbot.db");
	openStore({ path: dbPath, clock: { now: () => NOW }, redact: (text) => text }).close();
	const db = new Database(dbPath, { strict: true });
	for (const origin of new Set(rows.map((row) => row.origin))) {
		db.run("INSERT INTO origins (origin_key, epoch, session_dir, updated_at) VALUES (?, 1, ?, ?)", [
			origin,
			join(home, "sessions", encodeURIComponent(origin)),
			NOW,
		]);
	}
	for (const [index, row] of rows.entries()) {
		db.run(
			`INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at, last_event_at, thread_ref, op_ref)
			 VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
			[
				`m${index}`,
				row.origin,
				row.text,
				row.state,
				row.createdAt,
				row.dispatchedAt ?? null,
				row.lastEventAt ?? null,
				`${row.origin.split("/")[2]}:${index}.0`,
				row.opRef ?? null,
			],
		);
	}
	db.close();
}

/** AC-1's six conversations A–F. */
const SIX: Row[] = [
	{
		origin: "slack/ch/CA/t/1.0",
		text: "A 요청",
		state: "dispatched",
		createdAt: NOW - 5 * MINUTE,
		dispatchedAt: NOW - 5 * MINUTE,
		lastEventAt: NOW - MINUTE,
	},
	{
		origin: "slack/ch/CB/t/1.0",
		text: "B 첫 요청",
		state: "answered",
		createdAt: NOW - 3 * HOUR,
		dispatchedAt: NOW - 3 * HOUR,
	},
	{
		origin: "slack/ch/CB/t/1.0",
		text: "B 실패",
		state: "failed_notified",
		createdAt: NOW - HOUR,
		dispatchedAt: NOW - HOUR,
	},
	{
		origin: "slack/ch/CC/t/1.0",
		text: "C 오래됨",
		state: "answered",
		createdAt: NOW - 31 * HOUR,
		dispatchedAt: NOW - 31 * HOUR,
		lastEventAt: NOW - 30 * HOUR,
	},
	{
		origin: "slack/ch/CD/t/1.0",
		text: "D 끝남",
		state: "answered",
		createdAt: NOW - 3 * HOUR,
		dispatchedAt: NOW - 3 * HOUR,
		lastEventAt: NOW - 2 * HOUR,
	},
	{
		origin: "slack/ch/CE/t/1.0",
		text: "E 긴 턴",
		state: "answered",
		createdAt: NOW - 25 * HOUR,
		dispatchedAt: NOW - 25 * HOUR,
		lastEventAt: NOW - HOUR,
	},
	{
		origin: "slack/ch/CF/t/1.0",
		text: "F 멈춤",
		state: "dispatched",
		createdAt: NOW - 21 * MINUTE,
		dispatchedAt: NOW - 20 * MINUTE,
	},
	{ origin: "slack/ch/CF/t/1.0", text: "F 새 요청", state: "pending", createdAt: NOW - MINUTE },
];

const threadsOf = (snapshot: DashboardSnapshot) => {
	if (!snapshot.turns.ok) throw new Error(`turns section failed: ${snapshot.turns.error}`);
	return snapshot.turns.threads;
};

/** The detail tab bar of a page: whether it is hidden, its button words and the selected one. */
function tabsOf(html: string): { hidden: boolean; words: string[]; selected: string[] } {
	const match = /<div id="detail-tabs"([^>]*)>([\s\S]*?)<\/div>/.exec(html);
	if (match === null) throw new Error("no detail tabs");
	const buttons = [...(match[2] ?? "").matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].filter(
		(button) => !/\shidden\b/.test(button[1] ?? ""),
	);
	return {
		hidden: /\shidden\b/.test(match[1] ?? ""),
		words: buttons.map((button) => button[2] ?? ""),
		selected: buttons
			.filter((button) => (button[1] ?? "").includes('aria-selected="true"'))
			.map((button) => button[2] ?? ""),
	};
}

describe("turn board snapshot", () => {
	test("AC-1: threads sort into attention·working·done by their turns; one past 24 hours is gone", async () => {
		seed(SIX);
		const threads = threadsOf(await buildSnapshot(deps()));
		const column = Object.fromEntries(threads.map((thread) => [thread.originKey.split("/")[2], thread.column]));
		expect(column).toEqual({ CA: "working", CB: "attention", CD: "done", CE: "done", CF: "attention" });
		const f = threads.find((thread) => thread.originKey.includes("/CF/"));
		expect([f?.openCount, f?.stalledCount, f?.turnCount, f?.latest.state, f?.title]).toEqual([
			2,
			1,
			2,
			"pending",
			"F 멈춤",
		]);
	});

	test("messages steered into one running turn read as one run with merged messages, not a queue", async () => {
		const origin = "slack/ch/CS/t/1.0";
		const sent = (text: string, ago: number, opRef: string): Row => ({
			origin,
			text,
			state: "dispatched",
			createdAt: NOW - ago,
			dispatchedAt: NOW - ago,
			lastEventAt: NOW - MINUTE,
			opRef,
		});
		seed([
			sent("추천대로", 40 * MINUTE, "op-a"),
			sent("카톡방로그 상관없음", 39 * MINUTE, "op-a"),
			sent("엥 왜멈첫대너", 2 * MINUTE, "op-a"),
			{ origin, text: "그 다음 것", state: "pending", createdAt: NOW - MINUTE },
		]);
		const snapshot = await buildSnapshot(deps());
		const [thread] = threadsOf(snapshot);
		expect([thread?.openCount, thread?.runCount, thread?.pendingCount]).toEqual([4, 1, 1]);
		const html = renderDashboardMain(snapshot, undefined, NOW, { view: "turns" });
		expect(html).toContain("<span>실행 1 · 합쳐진 메시지 3 · 대기 1</span>");
		expect(renderItemDetail(snapshot, "turns", origin)).toContain(
			"<dt>턴</dt><dd>4 · 실행 1 · 합쳐진 메시지 3 · 대기 1</dd>",
		);
	});

	test("AC-2: past the masked 80-char line no inbound body reaches the snapshot JSON, open or finished", async () => {
		const body = (n: number): string => `${"가".repeat(80)} BODY-TAIL-${n}-must-not-leak 그 뒤 본문`;
		seed([
			{
				origin: "slack/ch/CX/t/1.0",
				text: body(1),
				state: "answered",
				createdAt: NOW - 3 * HOUR,
				dispatchedAt: NOW - 3 * HOUR,
			},
			{
				origin: "slack/ch/CX/t/1.0",
				text: body(2),
				state: "failed_notified",
				createdAt: NOW - 2 * HOUR,
				dispatchedAt: NOW - 2 * HOUR,
			},
			{
				origin: "slack/ch/CX/t/1.0",
				text: body(3),
				state: "dispatched",
				createdAt: NOW - HOUR,
				dispatchedAt: NOW - HOUR,
				lastEventAt: NOW - MINUTE,
			},
			{ origin: "slack/ch/CX/t/1.0", text: body(4), state: "pending", createdAt: NOW - MINUTE },
			{ origin: "slack/dm/UY", text: body(5), state: "answered", createdAt: NOW - HOUR, dispatchedAt: NOW - HOUR },
		]);
		const snapshot = await buildSnapshot(deps());
		expect(threadsOf(snapshot)).toHaveLength(2);
		const json = JSON.stringify(snapshot);
		for (const n of [1, 2, 3, 4, 5]) {
			const tail = Array.from(body(n)).slice(80).join("");
			expect(json).not.toContain(tail);
			expect(json).not.toContain(`BODY-TAIL-${n}`);
		}
		expect(json).toContain(`${"가".repeat(79)}…`);
	});

	test("Discord origins: a DM card reads DM, a server thread card names Discord and its channel", async () => {
		const dm = "discord/dm/123456789012345678";
		const thread = "discord/ch/111111111111111111/t/222222222222222222";
		const main = "discord/ch/111111111111111111";
		seed([
			{ origin: dm, text: "디스코드 DM", state: "answered", createdAt: NOW - HOUR, dispatchedAt: NOW - HOUR },
			{ origin: thread, text: "디스코드 스레드", state: "answered", createdAt: NOW - HOUR, dispatchedAt: NOW - HOUR },
			{ origin: main, text: "디스코드 채널 메인", state: "answered", createdAt: NOW - HOUR, dispatchedAt: NOW - HOUR },
			{ origin: "slack/dm/UY", text: "슬랙 DM", state: "answered", createdAt: NOW - HOUR, dispatchedAt: NOW - HOUR },
		]);
		const snapshot = await buildSnapshot(deps());
		expect(
			threadsOf(snapshot)
				.map((t) => t.originKey)
				.sort(),
		).toEqual([dm, main, thread, "slack/dm/UY"].sort());
		const html = renderDashboardMain(snapshot, undefined, NOW, { view: "turns" });
		const eyebrow = (key: string): string => {
			const at = html.indexOf(`data-row="${key}"`);
			if (at < 0) throw new Error(`no card ${key}`);
			const start = html.indexOf('<p class="card-eyebrow">', at);
			return html.slice(start, html.indexOf("</p>", start)).replace(/<[^>]*>/g, "");
		};
		expect(eyebrow(dm)).toEndWith(" · DM");
		expect(eyebrow("slack/dm/UY")).toEndWith(" · DM");
		expect(eyebrow(thread)).toEndWith(" · Discord 111111111111111111");
		expect(eyebrow(main)).toEndWith(" · Discord 111111111111111111 채널 메인");
	});
});

describe("turn board page", () => {
	let stop: (() => void) | undefined;
	afterEach(() => stop?.());

	test("AC-8: ?view=turns draws three columns of cards; the thread detail has 개요·대화·트레이스 tabs, 대화 chosen", async () => {
		seed(SIX);
		const snapshot = await buildSnapshot(deps());
		const server = startDashboardServer({ port: 0, hostname: "127.0.0.1", snapshot: async () => snapshot });
		stop = () => server.stop(true);
		const base = `http://127.0.0.1:${server.port}`;
		const page = async (query: string): Promise<string> =>
			(await (await fetch(`${base}/${query}`)).text()).replace(/<script>[\s\S]*<\/script>/, "");

		const board = await page("?view=turns");
		for (const label of ["확인 필요", "진행 중", "완료"]) {
			expect(board).toMatch(new RegExp(`<section class="col" [^>]*><h2 class="col-head"><span>${label}</span>`));
		}
		expect(board).toMatch(/<a class="card[^"]*"[^>]*data-row="slack\/ch\/CA\/t\/1.0"/);

		const thread = await page(`?view=turns&item=${encodeURIComponent("slack/ch/CA/t/1.0")}`);
		expect(thread).toContain('<aside id="detail" class="detail is-open"');
		expect(tabsOf(thread)).toEqual({ hidden: false, words: ["개요", "대화", "트레이스"], selected: ["대화"] });
		expect(thread).not.toMatch(/<body class="[^"]*detail-trace/);

		const card = await page("?card=w1%3Ap1");
		expect(tabsOf(card)).toEqual({ hidden: false, words: ["개요", "대화", "plan"], selected: ["개요"] });

		// The old address of one turn: that turn's conversation, on the trace tab, with the wide panel.
		const old = await page("?view=turns&item=1");
		expect(old).toContain('<aside id="detail" class="detail is-open"');
		expect(old).toContain("slack/ch/CA/t/1.0");
		expect(tabsOf(old)).toEqual({ hidden: false, words: ["개요", "대화", "트레이스"], selected: ["트레이스"] });
		expect(old).toMatch(/<body class="[^"]*detail-trace/);
	});
});

/** A herdr conversation (no \`running\` fields) drawn before the running badge existed. */
const HERDR_BODY = {
	turns: [
		{ role: "user", ts: 1793872680000, parts: [{ kind: "text", text: "고쳐 줘" }] },
		{
			role: "assistant",
			ts: 1793872740000,
			parts: [
				{ kind: "thinking", text: "생각 중" },
				{ kind: "tool", name: "bash", summary: "ls", output: "a\nb", error: false },
				{ kind: "tool", name: "read", summary: "x", output: "", error: true },
				{ kind: "text", text: "**끝**" },
			],
		},
	],
	cursor: "c1",
};
const HERDR_HTML =
	'<h3 class="h2">대화</h3><button class="more" type="button" data-before="c1">이전 대화 더 보기</button><article class="turn is-user"><p class="turn-head"><b>나</b><span>2분 전</span></p><div class="md"><p>고쳐 줘</p></div></article><article class="turn"><p class="turn-head"><b>omp</b><span>1분 전</span></p><details class="fold"><summary>생각</summary><div class="md"><p>생각 중</p></div></details><details class="fold tool-call"><summary><code class="mono"><b>bash</b></code> <span>ls</span> <span class="badge is-success">완료</span></summary><pre class="md-code"><code>a\nb</code></pre></details><details class="fold tool-call"><summary><code class="mono"><b>read</b></code> <span>x</span> <span class="badge is-danger">실패</span></summary><p class="turn-note">출력 없음</p></details><div class="md"><p><strong>끝</strong></p></div></article>';

describe("conversation renderer", () => {
	test("AC-9: a tool part without its result reads 진행 중; herdr conversations draw exactly as before", () => {
		const running = renderConversation(
			{
				turns: [
					{
						role: "assistant",
						ts: NOW,
						parts: [{ kind: "tool", name: "bash", summary: "ls", output: "", running: true }],
					},
				],
			},
			"omp",
			renderMarkdown,
			NOW,
		);
		expect(running).toContain('<span class="badge is-info">진행 중</span>');
		expect(running).not.toContain(">완료<");
		expect(renderConversation(HERDR_BODY, "omp", renderMarkdown, NOW)).toBe(HERDR_HTML);
	});
});

const iso = (ms: number): string => new Date(ms).toISOString();
const put = (file: string, entry: unknown): void => appendFileSync(file, `${JSON.stringify(entry)}\n`);
const user = (id: string, at: number, text: string) => ({
	type: "message",
	id,
	timestamp: iso(at),
	message: { role: "user", content: [{ type: "text", text }] },
});
const assistant = (id: string, at: number, content: unknown[]) => ({
	type: "message",
	id,
	timestamp: iso(at),
	message: { role: "assistant", content },
});
const toolResult = (callId: string, at: number, text: string, isError = false) => ({
	type: "message",
	id: `r-${callId}`,
	timestamp: iso(at),
	message: { role: "toolResult", toolCallId: callId, toolName: "x", isError, content: [{ type: "text", text }] },
});
const ORIGIN = "slack/ch/CS/t/9.0";

/** A conversation whose session file (in its `session_dir`) is returned, empty. */
function session(): string {
	seed([{ origin: ORIGIN, text: "요청", state: "dispatched", createdAt: NOW - HOUR, dispatchedAt: NOW - HOUR }]);
	const dir = join(home, "sessions", encodeURIComponent(ORIGIN));
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "s.jsonl");
	put(file, { type: "session", timestamp: iso(NOW - HOUR) });
	return file;
}

type Body = { turns: Array<{ role: string; parts: Array<Record<string, unknown>> }>; cursor?: string };

describe("api/thread/conversation", () => {
	let stop: (() => void) | undefined;
	afterEach(() => stop?.());

	function serve(withReader = true): string {
		const snapshot = async (): Promise<DashboardSnapshot> => {
			throw new Error("not asked");
		};
		const server = startDashboardServer({
			port: 0,
			hostname: "127.0.0.1",
			snapshot,
			...(withReader
				? { conversation: (origin: string, before?: string) => readThreadConversation(home, origin, before) }
				: {}),
		});
		stop = () => server.stop(true);
		return `http://127.0.0.1:${server.port}`;
	}
	const ask = async (base: string, query: string): Promise<[number, unknown]> => {
		const response = await fetch(`${base}/x/api/thread/conversation?${query}`);
		return [response.status, await response.json()];
	};

	test("AC-3: user text, model text, thinking and tool calls with their results become the renderer's parts", async () => {
		const file = session();
		put(file, user("u1", NOW - 50 * MINUTE, "질문"));
		put(
			file,
			assistant("a1", NOW - 49 * MINUTE, [
				{ type: "text", text: "답 글" },
				{ type: "thinking", thinking: "생각 글" },
				{ type: "toolCall", id: "c1", name: "read", arguments: { i: "Reading the log", path: "/x" } },
				{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "ls   -la" } },
				{ type: "toolCall", id: "c3", name: "bash", arguments: { i: "Breaking" } },
				{ type: "toolCall", id: "c4", name: "bash", arguments: { i: "Still going" } },
				{ type: "toolCall", id: "c5", name: "grep", arguments: { pattern: "x" }, intent: "Finding x" },
			]),
		);
		put(file, toolResult("c5", NOW - 48 * MINUTE, "hit"));
		put(file, toolResult("c1", NOW - 48 * MINUTE, "file body"));
		put(file, toolResult("c2", NOW - 48 * MINUTE, "total 0"));
		put(file, toolResult("c3", NOW - 48 * MINUTE, "boom", true));
		const [status, body] = await ask(serve(), `origin=${encodeURIComponent(ORIGIN)}`);
		expect(status).toBe(200);
		const { turns, cursor } = body as Body;
		expect(cursor).toBeUndefined();
		expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
		expect(turns[0]?.parts).toEqual([{ kind: "text", text: "질문" }]);
		expect(turns[1]?.parts).toEqual([
			{ kind: "text", text: "답 글" },
			{ kind: "thinking", text: "생각 글" },
			{ kind: "tool", name: "read", summary: "Reading the log", output: "file body", error: false },
			{ kind: "tool", name: "bash", summary: '{"command":"ls -la"}', output: "total 0", error: false },
			{ kind: "tool", name: "bash", summary: "Breaking", output: "boom", error: true },
			{ kind: "tool", name: "bash", summary: "Still going", output: "", error: false, running: true },
			{ kind: "tool", name: "grep", summary: "Finding x", output: "hit", error: false },
		]);
	});

	test("AC-4: a token in any text of the session never reaches the answer", async () => {
		const file = session();
		const token = "xoxb-TEST-0";
		put(file, user("u1", NOW - 50 * MINUTE, `토큰 ${token}`));
		put(
			file,
			assistant("a1", NOW - 49 * MINUTE, [
				{ type: "text", text: `글 ${token}` },
				{ type: "thinking", thinking: `생각 ${token}` },
				{ type: "toolCall", id: "c1", name: "bash", arguments: { i: `Using ${token}` } },
				{ type: "toolCall", id: "c2", name: "bash", arguments: { command: `echo ${token}` } },
			]),
		);
		put(file, toolResult("c1", NOW - 48 * MINUTE, `out ${token}`));
		put(file, toolResult("c2", NOW - 48 * MINUTE, `out ${token}`));
		const [status, body] = await ask(serve(), `origin=${encodeURIComponent(ORIGIN)}`);
		expect(status).toBe(200);
		const json = JSON.stringify(body);
		expect(json).not.toContain(token);
		expect(json).toContain("[REDACTED]");
	});

	test("AC-5: 25 dialog turns page as the last 20 with a cursor, then the first 5 without one", async () => {
		const file = session();
		for (let n = 1; n <= 25; n += 1) {
			put(file, user(`u${n}`, NOW - (60 - n) * MINUTE, `질문 ${n}`));
			put(file, assistant(`a${n}`, NOW - (60 - n) * MINUTE + 1000, [{ type: "text", text: `답 ${n}` }]));
		}
		const base = serve();
		const asked = (body: unknown): string[] =>
			(body as Body).turns.filter((turn) => turn.role === "user").map((turn) => String(turn.parts[0]?.text));
		const [, first] = await ask(base, `origin=${encodeURIComponent(ORIGIN)}`);
		expect(asked(first)).toEqual(Array.from({ length: 20 }, (_, i) => `질문 ${i + 6}`));
		const cursor = (first as Body).cursor;
		expect(cursor).toBe("u6");
		const [, rest] = await ask(base, `origin=${encodeURIComponent(ORIGIN)}&before=${cursor}`);
		expect(asked(rest)).toEqual(["질문 1", "질문 2", "질문 3", "질문 4", "질문 5"]);
		expect((rest as Body).cursor).toBeUndefined();
		expect((rest as Body).turns).toHaveLength(10);
	});

	test("AC-6: unknown origin, no session file and no reader answer 404 with their error", async () => {
		seed([{ origin: ORIGIN, text: "요청", state: "answered", createdAt: NOW - HOUR }]);
		const base = serve();
		expect(await ask(base, "origin=slack%2Fch%2FNOPE")).toEqual([404, { error: "unknown_origin" }]);
		expect(await ask(base, `origin=${encodeURIComponent(ORIGIN)}`)).toEqual([404, { error: "no_session" }]);
		stop?.();
		expect(await ask(serve(false), `origin=${encodeURIComponent(ORIGIN)}`)).toEqual([
			404,
			{ error: "conversation_disabled" },
		]);
	});

	test("AC-7: a task call carries only the last answer of each sub-agent it started, in tasks order", async () => {
		const file = session();
		const [t1, t2, t3, t4] = [NOW - 40 * MINUTE, NOW - 30 * MINUTE, NOW - 20 * MINUTE, NOW - 10 * MINUTE];
		const task = (id: string, names: string[]) => ({
			type: "toolCall",
			id,
			name: "task",
			arguments: { i: "Spawning", tasks: names.map((name) => ({ name, task: "x" })) },
		});
		put(file, user("u1", t1 - MINUTE, "나눠서 해 줘"));
		put(file, assistant("a1", t1, [task("k1", ["Alpha", "Beta"])]));
		put(file, toolResult("k1", t2 + MINUTE, "k1 결과"));
		put(file, assistant("a3", t3, [task("k3", ["Alpha", "Gamma"])]));
		put(file, toolResult("k3", t4 + MINUTE, "k3 결과"));
		const stem = file.replace(/\.jsonl$/, "");
		mkdirSync(stem);
		for (const [name, at] of [
			["Beta", t2],
			["Alpha", t4],
			["Gamma", t4],
			["Orphan", t2],
		] as const) {
			const sub = join(stem, `${name}.jsonl`);
			put(sub, { type: "title" });
			put(sub, { type: "session", timestamp: iso(at) });
			put(sub, assistant(`${name}-1`, at + 1000, [{ type: "text", text: `${name} 앞 글` }]));
			put(sub, user(`${name}-u`, at + 2000, `${name} 사용자 글`));
			put(sub, assistant(`${name}-2`, at + 3000, [{ type: "text", text: `${name} 마지막 글` }]));
		}
		const [status, body] = await ask(serve(), `origin=${encodeURIComponent(ORIGIN)}`);
		expect(status).toBe(200);
		const tools = (body as Body).turns.flatMap((turn) => turn.parts).filter((part) => part.kind === "tool");
		expect(tools.map((part) => part.output)).toEqual([
			"k1 결과\n\n— Beta\nBeta 마지막 글",
			"k3 결과\n\n— Alpha\nAlpha 마지막 글\n\n— Gamma\nGamma 마지막 글",
		]);
		const json = JSON.stringify(body);
		for (const gone of ["Orphan", "앞 글", "사용자 글"]) expect(json).not.toContain(gone);
	});

	test("AC-10: a script tag and a markdown image in the model's text draw as text, never as elements", () => {
		const file = session();
		put(file, user("u1", NOW - 50 * MINUTE, "<img src=x onerror=alert(1)>"));
		put(
			file,
			assistant("a1", NOW - 49 * MINUTE, [
				{ type: "text", text: "<script>alert(1)</script> 그리고 ![x](https://evil/x.png)" },
				{ type: "toolCall", id: "c1", name: "<b>bash</b>", arguments: { i: "<script>alert(2)</script>" } },
			]),
		);
		put(file, toolResult("c1", NOW - 48 * MINUTE, "<script>alert(3)</script>"));
		const answer = readThreadConversation(home, ORIGIN);
		const html = renderConversation(answer, "omp", renderMarkdown, NOW);
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).not.toMatch(/<script/i);
		expect(html).not.toMatch(/<img/i);
		expect(html).not.toContain("<b>bash</b>");
	});
});
