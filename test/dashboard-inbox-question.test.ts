import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoardCard, BoardState, BoardView } from "../src/dashboard/board";
import { renderDashboardMain, renderDetailHead } from "../src/dashboard/html";
import {
	buildSnapshot,
	type DashboardSnapshot,
	type HerdrAgentInfo,
	type SnapshotDeps,
} from "../src/dashboard/snapshot";
import type { ProcessRunner } from "../src/dispatch/omp";
import { makeHome, type TestHome } from "./helpers/bot-home";

const NOW = Date.parse("2026-11-11T01:00:00Z");

let home: TestHome;
let dir: string;

beforeEach(() => {
	home = makeHome("ompbot-inbox-q-");
	dir = mkdtempSync(join(tmpdir(), "ompbot-sessions-"));
});
afterEach(() => {
	home.remove();
	rmSync(dir, { recursive: true, force: true });
});

// ---- omp session jsonl lines ----
type Block = Record<string, unknown>;
const assistant = (content: Block[], extra: Record<string, unknown> = {}): unknown => ({
	type: "message",
	message: { role: "assistant", content, stopReason: "toolUse", ...extra },
});
const toolResult = (id: string, name: string): unknown => ({
	type: "message",
	message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "ok" }] },
});
const user = (text: string): unknown => ({
	type: "message",
	message: { role: "user", content: [{ type: "text", text }] },
});
const askCall = (id: string, questions: Array<{ question: string; options: string[] }>): Block => ({
	type: "toolCall",
	id,
	name: "ask",
	arguments: {
		questions: questions.map((q) => ({ question: q.question, options: q.options.map((label) => ({ label })) })),
	},
});
const QUESTION = "7층은 어느 안으로 갈까요?";
const OPTIONS = ["A안 <b>굵게</b>", "B안", "C안"];

/** A session file in the temp dir: the lines as JSON (strings as given, for broken lines). */
const session = (name: string, lines: unknown[]): string => {
	const path = join(dir, name);
	writeFileSync(path, `${lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`);
	return path;
};
const pendingAsk = (name: string, question = QUESTION, options = OPTIONS): string =>
	session(name, [
		{ type: "session", id: "s1" },
		user("시작"),
		assistant([{ type: "text", text: "물어볼게요." }, askCall("call-1", [{ question, options }])]),
	]);

interface Agent {
	name: string;
	status: string;
	pane: string;
	session?: unknown;
	agent?: string;
}
const listOf = (agents: Agent[]): string =>
	JSON.stringify({
		result: {
			agents: agents.map((a) => ({
				name: a.name,
				agent: a.agent ?? "omp",
				agent_status: a.status,
				cwd: "/srv/work",
				pane_id: a.pane,
				terminal_title: "",
				...(a.session === undefined ? {} : { agent_session: a.session }),
			})),
		},
	});
const pathSession = (value: string): unknown => ({ kind: "path", value });

/** Fake herdr: local `herdr agent list` answers `local`, the `wsl` host (over ssh) answers `remote`; every argv kept. */
function runner(local: Agent[], remote: Agent[] = []): { run: ProcessRunner; calls: string[][] } {
	const calls: string[][] = [];
	const run: ProcessRunner = async (cmd) => {
		calls.push(cmd);
		if (cmd[0] === "git") return { code: 0, stdout: "abc1234\n", timedOut: false };
		if (cmd[0] === "ssh") return { code: 0, stdout: listOf(remote), timedOut: false };
		return { code: 0, stdout: listOf(local), timedOut: false };
	};
	return { run, calls };
}

const deps = (run: ProcessRunner, board?: BoardState): SnapshotDeps => ({
	homeDir: home.dir,
	repoDir: "/srv/ompbot",
	timezone: "Asia/Seoul",
	config: { herdr: {}, dispatchHosts: { wsl: { ssh: "wsl-alias" } } },
	now: () => NOW,
	callDaemon: async () => Promise.reject(new Error("no daemon")),
	run,
	ompVersion: async () => "omp 0",
	hostOps: () => {
		throw new Error("unused");
	},
	...(board === undefined ? {} : { board: () => board }),
});

const card = (paneId: string, status: string, extra: Partial<BoardCard> = {}): BoardCard => ({
	key: paneId,
	local: true,
	machineId: "local",
	machineName: "oci",
	paneId,
	workspaceId: "w1",
	workspaceLabel: "main",
	tabLabel: "tab",
	paneLabel: `pane ${paneId}`,
	name: `agent-${paneId}`,
	agent: "omp",
	status,
	column: status === "blocked" ? "attention" : status === "working" ? "working" : status === "done" ? "done" : "idle",
	unknown: false,
	since: NOW - 5 * 60_000,
	cwd: "/srv/work",
	...extra,
});
const stateOf = (cards: BoardCard[]): BoardState => ({
	machines: [
		{ id: "local", name: "oci", connected: true },
		{ id: "wsl", name: "wsl", connected: true },
	],
	cards,
});
const viewOf = (state: BoardState): BoardView => ({ ok: true, generatedAt: NOW, ...state });

const hostAgents = (snapshot: DashboardSnapshot, host: string): HerdrAgentInfo[] => {
	if (!snapshot.herdr.ok) throw new Error(`herdr section failed: ${snapshot.herdr.error}`);
	const entry = snapshot.herdr.hosts.find((h) => h.host === host);
	if (entry === undefined || !entry.ok) throw new Error(`no host ${host}`);
	return entry.agents;
};
const agentOf = (snapshot: DashboardSnapshot, pane: string, host = "local"): HerdrAgentInfo => {
	const found = hostAgents(snapshot, host).find((a) => a.paneId === pane);
	if (found === undefined) throw new Error(`no pane ${pane}`);
	return found;
};
/** The `<a class="card…">` of a pane in the page, or "" without one. */
const cardHtml = (html: string, key: string): string => {
	const at = html.indexOf(`data-row="${key}"`);
	if (at < 0) return "";
	const start = html.lastIndexOf("<a ", at);
	return html.slice(start, html.indexOf("</a>", at) + 4);
};
const nextUp = (html: string): string => {
	const start = html.indexOf('<a class="next-up"');
	return start < 0 ? "" : html.slice(start, html.indexOf("</a>", start) + 4);
};

describe("inbox question: pending ask", () => {
	test("AC-1: a pending ask shows 묻는 말 and its three choices, escaped, in card-options", async () => {
		const path = pendingAsk("ask.jsonl");
		const state = stateOf([card("p1", "blocked")]);
		const fake = runner([{ name: "a1", status: "blocked", pane: "p1", session: pathSession(path) }]);
		const snapshot = await buildSnapshot(deps(fake.run, state));
		const html = renderDashboardMain(snapshot, viewOf(state), NOW);
		const one = cardHtml(html, "p1");
		expect(one).toContain(`<p class="card-sum">묻는 말: ${QUESTION}</p>`);
		const options = /<p class="card-options">(.*?)<\/p>/.exec(one)?.[1] ?? "";
		expect(options).toBe("A안 &lt;b&gt;굵게&lt;/b&gt; / B안 / C안");
		expect(one).not.toContain("<b>굵게");
		expect(nextUp(html)).toContain(QUESTION);
		// The detail panel lists the question and every choice.
		const detail = renderDetailHead("p1", { ...card("p1", "blocked"), ...snapshotSay(snapshot, "p1") }, undefined, NOW);
		expect(detail).toContain(QUESTION);
		for (const option of ["A안 &lt;b&gt;굵게&lt;/b&gt;", "B안", "C안"]) expect(detail).toContain(`<li>${option}</li>`);
	});

	test("AC-1: the same id's toolResult after the ask leaves no question", async () => {
		const path = session("answered.jsonl", [
			user("시작"),
			assistant([askCall("call-1", [{ question: QUESTION, options: OPTIONS }])]),
			toolResult("call-1", "ask"),
		]);
		const state = stateOf([card("p1", "blocked")]);
		const fake = runner([{ name: "a1", status: "blocked", pane: "p1", session: pathSession(path) }]);
		const snapshot = await buildSnapshot(deps(fake.run, state));
		const html = renderDashboardMain(snapshot, viewOf(state), NOW);
		expect(html).not.toContain("묻는 말");
		expect(html).not.toContain("card-options");
	});

	test("AC-1: an assistant line of 600KB still yields the question", async () => {
		const big = "생각".repeat(100_000); // 600KB of UTF-8
		const path = session("big.jsonl", [
			user("시작"),
			assistant([{ type: "thinking", thinking: big }, askCall("call-9", [{ question: QUESTION, options: OPTIONS }])]),
		]);
		const fake = runner([{ name: "a1", status: "blocked", pane: "p1", session: pathSession(path) }]);
		const snapshot = await buildSnapshot(deps(fake.run));
		const agent = agentOf(snapshot, "p1");
		expect(agent.question).toBe(QUESTION);
		expect(agent.options).toEqual(OPTIONS);
	});

	test("several pending questions read as the first one 외 N개", async () => {
		const path = session("two.jsonl", [
			assistant([
				askCall("c1", [
					{ question: "첫 질문?", options: ["예", "아니오"] },
					{ question: "둘째 질문?", options: ["x"] },
				]),
			]),
		]);
		const fake = runner([{ name: "a1", status: "blocked", pane: "p1", session: pathSession(path) }]);
		const agent = agentOf(await buildSnapshot(deps(fake.run)), "p1");
		expect(agent.question).toBe("첫 질문? 외 1개");
		expect(agent.asks).toEqual([
			{ question: "첫 질문?", options: ["예", "아니오"] },
			{ question: "둘째 질문?", options: ["x"] },
		]);
	});
});

describe("inbox question: last answer", () => {
	test("AC-2: a done pane with no TASK shows the first sentence of the last answer on its 완료·대기 card", async () => {
		const path = session("done.jsonl", [
			user("질문"),
			assistant([{ type: "text", text: "옛 답입니다." }], { stopReason: "stop" }),
			user("또"),
			assistant(
				[
					{ type: "thinking", thinking: "음" },
					{ type: "text", text: "배포를 마쳤습니다. 로그는 깨끗합니다.\n다음은 없음." },
				],
				{
					stopReason: "stop",
				},
			),
		]);
		const state = stateOf([card("p2", "done")]);
		const fake = runner([{ name: "a2", status: "done", pane: "p2", session: pathSession(path) }]);
		const snapshot = await buildSnapshot(deps(fake.run, state));
		const html = renderDashboardMain(snapshot, viewOf(state), NOW);
		expect(cardHtml(html, "p2")).toContain('<p class="card-sum">배포를 마쳤습니다.</p>');
		expect(nextUp(html)).not.toContain("배포를 마쳤습니다.");
		expect(html).not.toContain("로그는 깨끗합니다");
	});

	test("AC-2: a first sentence longer than 120 characters is cut to 120", async () => {
		const long = `${"가".repeat(200)}. 둘째.`;
		const path = session("long.jsonl", [assistant([{ type: "text", text: long }], { stopReason: "stop" })]);
		const fake = runner([{ name: "a2", status: "done", pane: "p2", session: pathSession(path) }]);
		const say = agentOf(await buildSnapshot(deps(fake.run)), "p2").lastSay ?? "";
		expect(say.length).toBeLessThanOrEqual(120);
		expect(say.startsWith("가가가")).toBe(true);
		expect(say).not.toContain("둘째");
	});
});

describe("inbox question: isolation and other reasons", () => {
	test("AC-3: bad agent_session values and unreadable files leave only that pane empty; the herdr section stays ok", async () => {
		const good = pendingAsk("good.jsonl");
		const broken = session("broken.jsonl", ['{"type":"message","message":{"role":"assistant"', "not json at all"]);
		const txt = join(dir, "notes.txt");
		writeFileSync(txt, `${JSON.stringify(assistant([askCall("c", [{ question: "txt?", options: [] }])]))}\n`);
		const fake = runner([
			{ name: "missing", status: "blocked", pane: "m1" },
			{ name: "relative", status: "blocked", pane: "m2", session: pathSession("sessions/x.jsonl") },
			{ name: "not-jsonl", status: "blocked", pane: "m3", session: pathSession(txt) },
			{ name: "gone", status: "blocked", pane: "m4", session: pathSession(join(dir, "gone.jsonl")) },
			{ name: "broken", status: "blocked", pane: "m5", session: pathSession(broken) },
			{ name: "wrong-kind", status: "blocked", pane: "m6", session: { kind: "id", value: good } },
			{ name: "good", status: "blocked", pane: "g1", session: pathSession(good) },
		]);
		const snapshot = await buildSnapshot(deps(fake.run));
		expect(snapshot.herdr.ok).toBe(true);
		for (const pane of ["m1", "m2", "m3", "m6"]) {
			const agent = agentOf(snapshot, pane);
			expect(agent.sessionPath).toBeUndefined();
			expect(agent.question).toBeUndefined();
		}
		for (const pane of ["m4", "m5"]) {
			const agent = agentOf(snapshot, pane);
			expect(agent.question).toBeUndefined();
			expect(agent.blocked).toBeUndefined();
		}
		expect(agentOf(snapshot, "m4").sayError).toBeDefined();
		expect(agentOf(snapshot, "g1").question).toBe(QUESTION);
	});

	test("AC-3: token-shaped strings in the question, choices and last answer are masked", async () => {
		const ask = pendingAsk("secret.jsonl", "토큰 xoxb-TEST-0-abc 을 쓸까요?", ["xoxb-TEST-0 그대로", "아니오"]);
		const done = session("secret-done.jsonl", [
			assistant([{ type: "text", text: "키는 xoxb-TEST-0-zzz 입니다. 끝." }], { stopReason: "stop" }),
		]);
		const fake = runner([
			{ name: "a1", status: "blocked", pane: "p1", session: pathSession(ask) },
			{ name: "a2", status: "done", pane: "p2", session: pathSession(done) },
		]);
		const snapshot = await buildSnapshot(deps(fake.run));
		const json = JSON.stringify(snapshot.herdr);
		expect(json).not.toContain("xoxb-TEST-0");
		expect(agentOf(snapshot, "p1").question).toContain("[REDACTED]");
		expect(agentOf(snapshot, "p1").options?.[0]).toContain("[REDACTED]");
		expect(agentOf(snapshot, "p2").lastSay).toContain("[REDACTED]");
	});

	test("AC-3: a pending non-ask tool call reads as 도구 실행 승인 대기: bash; an error-ended answer as 프로바이더 오류", async () => {
		const tool = session("tool.jsonl", [
			assistant([
				{ type: "toolCall", id: "r1", name: "read", arguments: {} },
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls" } },
			]),
			toolResult("r1", "read"),
		]);
		const failed = session("error.jsonl", [
			user("해 줘"),
			assistant([], { stopReason: "error", errorMessage: "429 rate limited by provider\nretry later" }),
		]);
		const state = stateOf([card("p1", "blocked"), card("p3", "blocked")]);
		const fake = runner([
			{ name: "a1", status: "blocked", pane: "p1", session: pathSession(tool) },
			{ name: "a3", status: "blocked", pane: "p3", session: pathSession(failed) },
		]);
		const snapshot = await buildSnapshot(deps(fake.run, state));
		const html = renderDashboardMain(snapshot, viewOf(state), NOW);
		expect(cardHtml(html, "p1")).toContain('<p class="card-sum">도구 실행 승인 대기: bash</p>');
		expect(cardHtml(html, "p3")).toContain('<p class="card-sum">프로바이더 오류: 429 rate limited by provider</p>');
		expect(html).not.toContain("retry later");
	});
});

describe("inbox question: remote panes and the cap", () => {
	test("AC-4: a remote (wsl) pane gets no sessionPath, no file read, and no question on its card", async () => {
		const path = pendingAsk("remote.jsonl");
		const remoteCard = card("rp1", "blocked", { key: "wsl:rp1", local: false, machineId: "wsl", machineName: "wsl" });
		const state = stateOf([remoteCard]);
		const fake = runner([], [{ name: "r1", status: "blocked", pane: "rp1", session: pathSession(path) }]);
		const unboarded = await buildSnapshot(deps(fake.run));
		const remote = agentOf(unboarded, "rp1", "wsl");
		expect(remote.sessionPath).toBeUndefined();
		expect(remote.question).toBeUndefined();
		const boarded = await buildSnapshot(deps(fake.run, state));
		const html = renderDashboardMain(boarded, viewOf(state), NOW);
		expect(html).not.toContain("묻는 말");
		expect(html).not.toContain(QUESTION);
		const reads = fake.calls.filter((cmd) => cmd.some((word) => /\b(tail|cat|head|dd|less)\b/.test(word)));
		expect(reads).toEqual([]);
		for (const cmd of fake.calls) expect(cmd.join(" ")).toContain("agent");
	});

	test("AC-4: only the first 12 local panes are read", async () => {
		const agents: Agent[] = Array.from({ length: 13 }, (_, i) => ({
			name: `a${i + 1}`,
			status: "blocked",
			pane: `p${i + 1}`,
			session: pathSession(pendingAsk(`s${i + 1}.jsonl`, `질문 ${i + 1}?`)),
		}));
		const snapshot = await buildSnapshot(deps(runner(agents).run));
		for (let i = 1; i <= 12; i++) expect(agentOf(snapshot, `p${i}`).question).toBe(`질문 ${i}?`);
		expect(agentOf(snapshot, "p13").question).toBeUndefined();
	});

	test("panes that are neither blocked nor done, or not omp, are not read", async () => {
		const path = pendingAsk("idle.jsonl");
		const fake = runner([
			{ name: "w", status: "working", pane: "p1", session: pathSession(path) },
			{ name: "c", status: "blocked", pane: "p2", session: pathSession(path), agent: "claude" },
		]);
		const snapshot = await buildSnapshot(deps(fake.run));
		expect(agentOf(snapshot, "p1").question).toBeUndefined();
		expect(agentOf(snapshot, "p2").question).toBeUndefined();
	});
});

/** The say the snapshot carries for a local pane (the fields the page merges into its board card). */
function snapshotSay(snapshot: DashboardSnapshot, paneId: string): Partial<BoardCard> {
	if (!snapshot.herdr.ok) return {};
	const found = snapshot.herdr.says?.find((say) => say.paneId === paneId);
	if (found === undefined) return {};
	const { host: _host, paneId: _pane, status: _status, ...say } = found;
	return say;
}
