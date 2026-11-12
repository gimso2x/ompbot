import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SWEEP_HEARTBEAT_FILE } from "../src/daemon/heartbeat";
import { callDaemon } from "../src/daemon/ipc";
import type { StatusReport } from "../src/daemon/status";
import { renderDashboardMain, renderDashboardPage, renderItemDetail } from "../src/dashboard/html";
import { startDashboardServer } from "../src/dashboard/server";
import {
	buildSnapshot,
	createSnapshotCache,
	type DashboardSnapshot,
	SNAPSHOT_TTL_MS,
	type SnapshotDeps,
	type TaskInfo,
	type TurnInfo,
} from "../src/dashboard/snapshot";
import type { ProcessRunner, RunProcessResult } from "../src/dispatch/omp";
import { openStore } from "../src/store/db";
import type { TaskHostOps } from "../src/tasks/host";
import { makeHome, type TestHome } from "./helpers/bot-home";

const NOW = Date.parse("2026-11-04T00:00:00Z");
const INBOUND_BODY = "INBOUND-BODY-must-not-leak";
const DELIVERY_BODY = "DELIVERY-BODY-must-not-leak";
const REPLY_TEXT = "REPLY-TEXT-must-not-leak";
const XSS_TITLE = "<script>alert(1)</script>";
const WORKTREE = "/srv/work/repo-t-20261104-01";

class FakeClock {
	t = NOW;
	now = (): number => this.t;
}

let home: TestHome;
let dbPath: string;
let clock: FakeClock;

/** A bot database with one row of everything the page shows, written through raw SQL after the schema exists. */
function seedDatabase(): void {
	openStore({ timezone: "Asia/Seoul", path: dbPath, clock: { now: () => NOW }, redact: (text) => text }).close();
	const db = new Database(dbPath, { strict: true });
	const hour = 3_600_000;
	db.run("INSERT INTO origins (origin_key, epoch, session_dir, updated_at) VALUES ('slack/dm/U1', 1, '/s', ?)", [NOW]);
	db.run(
		`INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at, thread_ref, last_event_at)
		 VALUES ('m1', 'slack/dm/U1', 1, ?, 'dispatched', ?, ?, 'D1:1.0', ?), ('m2', 'slack/dm/U1', 1, ?, 'pending', ?, NULL, NULL, NULL),
		        ('m3', 'slack/dm/U1', 1, ?, 'answered', ?, ?, NULL, NULL)`,
		// Every turn of the board's threads shows an 80-char masked request line; the rest of its body stays out.
		[
			`first request ${"가".repeat(80)} ${INBOUND_BODY}`,
			NOW - hour,
			NOW - hour,
			NOW - 60_000,
			"second request",
			NOW - 1_000,
			`answered request ${"나".repeat(80)} ${INBOUND_BODY}`,
			NOW - 2 * hour,
			NOW,
		],
	);
	db.run(
		`INSERT INTO deliveries (origin_key, op_ref, part, thread_ref, body, state, next_at, created_at)
		 VALUES ('slack/dm/U1', 'op1', 0, 'D1:1.0', ?, 'inflight', ?, ?)`,
		[DELIVERY_BODY, NOW, NOW],
	);
	db.run(
		`INSERT INTO approvals (approval_id, channel, message_ts, summary, status, created_at, expires_at, origin_key, reply_text)
		 VALUES ('ap1', 'C1', '1.0', 'push to main', 'pending', ?, ?, 'slack/dm/U1', ?)`,
		[NOW - 1_000, NOW + hour, REPLY_TEXT],
	);
	db.run(
		`INSERT INTO lanes (name, title, thread_ref, origin_key, cwd, session_dir, status, created_at, updated_at)
		 VALUES ('lane-a', 'open lane', 'C1:2.0', 'lane/a', '/srv/a', '/s/a', 'working', ?, ?),
		        ('lane-b', 'closed lane', 'C1:3.0', 'lane/b', '/srv/b', '/s/b', 'closed', ?, ?)`,
		[NOW, NOW, NOW, NOW],
	);
	db.run(
		`INSERT INTO monitors (id, name, trigger_json, instruction, cursor_at, created_at, updated_at)
		 VALUES ('mon1', 'nightly', ?, '야간 점검을 한다. SECRET-INSTRUCTION', ?, ?, ?)`,
		[JSON.stringify({ kind: "at", at: "2026-11-05T00:00:00.000Z" }), NOW, NOW, NOW],
	);
	db.run(
		`INSERT INTO monitor_events (monitor_id, slot_at, stage, payload, answer, created_at, updated_at)
		 VALUES ('mon1', ?, 'delivered', 'SECRET-PAYLOAD', 'SECRET-ANSWER', ?, ?)`,
		[NOW - hour, NOW - hour, NOW - hour],
	);
	db.run(
		`INSERT INTO monitor_incidents (monitor_id, signature, status, first_at, last_at, alerted_at)
		 VALUES ('mon1', 'sig', 'alerted', ?, ?, ?)`,
		[NOW, NOW, NOW],
	);
	db.run(
		`INSERT INTO alert_incidents (scope, signature, status, count, first_at, last_at, alerted_at)
		 VALUES ('daemon', 'turn_failed', 'alerted', 3, ?, ?, ?)`,
		[NOW - hour, NOW, NOW],
	);
	const acceptance = JSON.stringify([
		{ id: "AC-1", text: "first" },
		{ id: "AC-2", text: "second xoxb-TEST-0" },
	]);
	const task = (id: string, title: string, status: string, host: string | null, closedAt: number | null) =>
		db.run(
			`INSERT INTO tasks (task_id, title, risk, origin_key, thread_ref, host, repo, worktree, branch, agent, status,
				acceptance_json, created_at, updated_at, closed_at)
			 VALUES (?, ?, 'L2', 'slack/dm/U1', ?, ?, '/srv/work/repo', ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				title,
				`C1:${id}`,
				host,
				id === "T-20261104-01" ? WORKTREE : `/srv/work/repo-${id.toLowerCase()}`,
				`task/${id}`,
				id.toLowerCase(),
				status,
				acceptance,
				NOW - hour,
				NOW - hour,
				closedAt,
			],
		);
	task("T-20261104-01", XSS_TITLE, "working", null, null);
	task("T-20261104-02", "gone worker", "blocked", null, null);
	task("T-20261104-03", "remote worker", "working", "remote", null);
	task("T-20261103-01", "closed yesterday", "done", null, NOW - 24 * hour);
	task("T-20261020-01", "closed long ago", "done", null, NOW - 15 * 24 * hour);
	db.close();
}

const SPEC = `---
task: T-20261104-01
---
# 수락기준
- [x] AC-1: first
- [ ] AC-2: second xoxb-TEST-0
`;
const PROGRESS = `---
task: T-20261104-01
status: working
updated: 2026-11-04T08:30:00+09:00
current: S2
---
# 단계
- [x] S1: one | 완료 조건: x | 증거: commit abcdef1
- [ ] S2: two xoxb-TEST-0 | 완료 조건: y | 증거:
`;
const OUTCOME = `# T-20261104-01 Outcome 증거
## 요약
## AC-1
- commit: abcdef1 feat: first
`;

/** Task docs of T-20261104-01 only; every other task reads as missing files. */
const fakeHostOps = (): TaskHostOps => ({
	async readFile(path) {
		const docs: Record<string, string> = {
			[`${WORKTREE}/docs/tasks/T-20261104-01/spec.md`]: SPEC,
			[`${WORKTREE}/docs/tasks/T-20261104-01/PROGRESS.md`]: PROGRESS,
			[`${WORKTREE}/docs/tasks/T-20261104-01/outcome.md`]: OUTCOME,
		};
		return { ok: true, value: docs[path] };
	},
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

interface FakeRunner {
	run: ProcessRunner;
	calls: string[][];
	/** `agent list` calls only. */
	herdrCalls(): number;
}

/** herdr answers for the local host; the remote host answers too unless `remoteFails`; git answers a short hash. */
function fakeRunner(options: { remoteFails?: boolean } = {}): FakeRunner {
	const calls: string[][] = [];
	const ok = (stdout: string): RunProcessResult => ({ code: 0, stdout, timedOut: false });
	const run: ProcessRunner = async (cmd) => {
		calls.push(cmd);
		if (cmd[0] === "git") return ok("abc1234\n");
		if (cmd[0] === "ssh") {
			if (options.remoteFails) return { code: 255, stdout: "", stderr: "ssh: connect refused", timedOut: false };
			return ok(
				JSON.stringify({ result: { agents: [{ name: "t-20261104-03", agent_status: "idle", pane_id: "r9" }] } }),
			);
		}
		return ok(
			JSON.stringify({
				result: {
					agents: [
						{
							name: "t-20261104-01",
							agent: "omp",
							agent_status: "working",
							cwd: WORKTREE,
							pane_id: "p7",
							terminal_title: "token xoxb-TEST-0 here",
						},
						{ name: "other", agent: "omp", agent_status: "idle", cwd: "/srv", pane_id: "p8", terminal_title: "" },
					],
				},
			}),
		);
	};
	return {
		run,
		calls,
		herdrCalls: () => calls.filter((cmd) => cmd.includes("agent") || cmd.some((w) => w.includes("'agent'"))).length,
	};
}

const STATUS: StatusReport = {
	ompVersion: "omp 9.9.9",
	timezone: "Asia/Seoul",
	daemonRunning: true,
	origins: [
		{ originKey: "slack/dm/U1", epoch: 1, ompPid: 42, busy: true },
		{ originKey: "slack/ch/C1", epoch: 1, ompPid: null, busy: false },
	],
	ledger: { pending: 0, inflight: 1, confirmed: 5, ambiguous: 0, expired: 0 },
	inbound: { pending: 1, dispatched: 1, answered: 1, failed_notified: 0, discarded: 0 },
	monitors: { count: 1, next: null },
	openGates: [],
};

function deps(overrides: Partial<SnapshotDeps> = {}): SnapshotDeps & { ipcCalls: number } {
	const result = {
		ipcCalls: 0,
		homeDir: home.dir,
		repoDir: "/srv/ompbot",
		timezone: "Asia/Seoul",
		config: {
			ompExecutable: home.config.ompExecutable,
			herdr: {},
			dispatchHosts: { remote: { ssh: "remote-alias" } },
			herdrBoard: { url: "https://board.example.test/task/", api: "http://127.0.0.1:9" },
		},
		now: clock.now,
		async callDaemon() {
			result.ipcCalls += 1;
			return { ok: true, status: STATUS };
		},
		run: fakeRunner().run,
		ompVersion: async () => "omp-stub 0.0.0",
		hostOps: () => fakeHostOps(),
		fetch: (async () =>
			Response.json({
				machines: [
					{ id: "local-1", kind: "local" },
					{ id: "m-remote", name: "remote" },
				],
			})) as unknown as typeof fetch,
		...overrides,
	};
	return result;
}

const taskOf = (snapshot: DashboardSnapshot, id: string): TaskInfo => {
	if (!snapshot.tasks.ok) throw new Error(`tasks section failed: ${snapshot.tasks.error}`);
	const task = snapshot.tasks.items.find((item) => item.taskId === id);
	if (task === undefined) throw new Error(`no ${id}`);
	return task;
};

beforeEach(() => {
	home = makeHome("ompbot-dash-");
	dbPath = join(home.dir, "ompbot.db");
	clock = new FakeClock();
	seedDatabase();
});
afterEach(() => home.remove());

describe("dashboard snapshot", () => {
	test("AC-3: no daemon socket → running false, daemon/tasks/turns filled from the database", async () => {
		const snapshot = await buildSnapshot(
			deps({ callDaemon: (path, request, timeoutMs) => callDaemon(path, request, timeoutMs) }),
		);
		if (!snapshot.daemon.ok) throw new Error(snapshot.daemon.error);
		expect(snapshot.daemon.running).toBe(false);
		expect(snapshot.daemon.ompVersion).toBe("omp-stub 0.0.0");
		expect(snapshot.daemon.ledger.inflight).toBe(1);
		expect(snapshot.daemon.inbound).toMatchObject({ pending: 1, dispatched: 1, answered: 1 });
		expect(snapshot.daemon.commit).toBe("abc1234");
		if (!snapshot.turns.ok) throw new Error(snapshot.turns.error);
		expect(snapshot.turns.items.map((turn) => [turn.state, turn.ageMs, turn.silentMs])).toEqual([
			["dispatched", 3_600_000, 60_000],
			["pending", 1_000, null],
		]);
		if (!snapshot.tasks.ok) throw new Error(snapshot.tasks.error);
		expect(snapshot.tasks.items.map((task) => task.taskId)).toEqual([
			"T-20261104-01",
			"T-20261104-02",
			"T-20261104-03",
			"T-20261103-01",
		]);
	});

	test("AC-4: inflight deliveries and dispatched inbound keep their state after a snapshot", async () => {
		const states = () => {
			const db = new Database(dbPath, { readonly: true });
			try {
				return {
					deliveries: db.query("SELECT delivery_id, state, redelivered FROM deliveries ORDER BY 1").all(),
					inbound: db.query("SELECT inbound_id, state FROM inbound ORDER BY 1").all(),
				};
			} finally {
				db.close();
			}
		};
		const before = states();
		expect(before.deliveries).toEqual([{ delivery_id: 1, state: "inflight", redelivered: 0 }]);
		await buildSnapshot(deps({ callDaemon: async () => Promise.reject(new Error("no daemon")) }));
		expect(states()).toEqual(before);
	});

	test("AC-5: open task rows carry AC n/m, PROGRESS status·updated, herdr state, gone and card links", async () => {
		const snapshot = await buildSnapshot(deps());
		const first = taskOf(snapshot, "T-20261104-01");
		expect(first).toMatchObject({
			acChecked: 1,
			acTotal: 2,
			stepsDone: 1,
			stepsTotal: 2,
			progress: { status: "working", updated: "2026-11-04T08:30:00+09:00", current: "S2" },
			herdr: { ok: true, status: "working" },
			link: "https://board.example.test/task/?card=p7",
		});
		// Not in the fake list → gone; the board root is linked when the pane is unknown.
		expect(taskOf(snapshot, "T-20261104-02")).toMatchObject({
			herdr: { ok: true, status: "gone" },
			link: "https://board.example.test/task/",
		});
		expect(taskOf(snapshot, "T-20261104-03")).toMatchObject({
			herdr: { ok: true, status: "idle" },
			link: "https://board.example.test/task/?card=m-remote:r9",
		});
		const closed = taskOf(snapshot, "T-20261103-01");
		expect(closed.open).toBe(false);
		expect(closed.herdr).toBeUndefined();

		const noBoard = await buildSnapshot(deps({ config: { ompExecutable: home.config.ompExecutable, herdr: {} } }));
		expect(taskOf(noBoard, "T-20261104-01").link).toBeUndefined();
	});

	test("open tasks list their acceptance items and PROGRESS steps, redacted; existing fields unchanged", async () => {
		const snapshot = await buildSnapshot(deps());
		const first = taskOf(snapshot, "T-20261104-01");
		expect(first.acceptance).toEqual([
			{ id: "AC-1", text: "first", checked: true },
			{ id: "AC-2", text: "second [REDACTED]", checked: false },
		]);
		expect(first.steps).toEqual([
			{ id: "S1", text: "one", done: true },
			{ id: "S2", text: "two [REDACTED]", done: false },
		]);
		expect(first).toMatchObject({ acChecked: 1, acTotal: 2, stepsDone: 1, stepsTotal: 2 });
		// No documents to judge (missing files) and closed tasks carry no lists.
		expect(taskOf(snapshot, "T-20261104-03").steps).toEqual([]);
		const closed = taskOf(snapshot, "T-20261103-01");
		expect([closed.acceptance, closed.steps]).toEqual([undefined, undefined]);
	});

	test("AC-6: a failing herdr host is only that host's ok:false; tasks and daemon stay ok", async () => {
		const snapshot = await buildSnapshot(deps({ run: fakeRunner({ remoteFails: true }).run }));
		if (!snapshot.herdr.ok) throw new Error(snapshot.herdr.error);
		const hosts = Object.fromEntries(snapshot.herdr.hosts.map((host) => [host.host, host]));
		expect(hosts.local?.ok).toBe(true);
		expect(hosts.remote).toMatchObject({ ok: false });
		expect(snapshot.tasks.ok).toBe(true);
		expect(snapshot.daemon.ok).toBe(true);
		expect(taskOf(snapshot, "T-20261104-03").herdr?.ok).toBe(false);
		if (hosts.local?.ok !== true) throw new Error("local host failed");
		expect(hosts.local.agents.find((agent) => agent.name === "t-20261104-01")).toMatchObject({
			taskId: "T-20261104-01",
			paneId: "p7",
			terminalTitle: "token [REDACTED] here",
		});
	});

	test("AC-7: message bodies past the request line, approval replies, monitor payloads and instruction tails never reach the JSON", async () => {
		const json = JSON.stringify(await buildSnapshot(deps()));
		for (const secret of [
			INBOUND_BODY,
			DELIVERY_BODY,
			REPLY_TEXT,
			"SECRET-PAYLOAD",
			"SECRET-ANSWER",
			"SECRET-INSTRUCTION",
		]) {
			expect(json).not.toContain(secret);
		}
		const snapshot = JSON.parse(json) as DashboardSnapshot;
		expect(snapshot.approvals.ok && snapshot.approvals.items[0]?.summary).toBe("push to main");
		// Of the instruction only its first sentence: the rest is read through api/monitor/detail.
		expect(snapshot.monitors.ok && snapshot.monitors.items[0]).toEqual({
			id: "mon1",
			name: "nightly",
			kind: "at",
			schedule: "한 번 · 11-05 09:00",
			cron: null,
			summary: "야간 점검을 한다.",
			destination: "오너 DM",
			copyTo: null,
			model: null,
			thinking: null,
			deliver: "turn",
			overlap: "queue",
			files: [],
			nextFireAt: "2026-11-05T09:00:00+09:00",
			lastStage: "delivered",
			lastAt: "2026-11-04T08:00:00+09:00",
			openIncidents: 1,
			recent: [{ stage: "delivered", manual: false, at: "2026-11-04T08:00:00+09:00" }],
			lastRun: {
				stage: "delivered",
				at: "2026-11-04T08:00:00+09:00",
				slotAt: "2026-11-04T08:00:00+09:00",
				durationMs: 0,
				attempts: 0,
				manual: false,
			},
			scheduledRun: true,
			originKey: "monitor/mon1",
			running: false,
			failStreak: 0,
			stats: { days: 30, delivered: 1, quiet: 0, failed: 0, skipped: 0, medianMs: 0 },
		});
		expect(snapshot.lanes.ok && snapshot.lanes.items.map((lane) => lane.name)).toEqual(["lane-a"]);
		expect(snapshot.alerts.ok && snapshot.alerts.items).toEqual([
			{
				scope: "daemon",
				signature: "turn_failed",
				count: 3,
				lastAt: "2026-11-04T09:00:00+09:00",
				incidentId: 1,
				firstAt: "2026-11-04T08:00:00+09:00",
				status: "alerted",
			},
		]);
	});

	test("AC-9: within 10 s one IPC and one herdr list per host; after 10 s they are asked again", async () => {
		const runner = fakeRunner();
		const d = deps({ run: runner.run, config: { ompExecutable: home.config.ompExecutable, herdr: {} } });
		const snapshot = createSnapshotCache(() => buildSnapshot(d), clock.now);
		const [a, b] = await Promise.all([snapshot(), snapshot()]);
		expect(a).toBe(b);
		expect(d.ipcCalls).toBe(1);
		expect(runner.herdrCalls()).toBe(1);
		clock.t += 9_999;
		await snapshot();
		expect(d.ipcCalls).toBe(1);
		expect(runner.herdrCalls()).toBe(1);
		clock.t += 1;
		await snapshot();
		expect(d.ipcCalls).toBe(2);
		expect(runner.herdrCalls()).toBe(2);
	});
});

const LONG_TAIL = "TAIL-MUST-NOT-SHOW";
const MASKED_BODY = "첫 줄\n둘째 줄   xoxb-TEST-0 sk-TESTKEY123 [첨부: /home/x/media/inbound/a.png (image/png)] 끝";

/** Open turns of every kind next to the seeded ones (ids 4..12, in this order). */
function seedTurns(): void {
	const db = new Database(dbPath, { strict: true });
	for (const origin of ["slack/ch/C9", "monitor/mon1", "slack/dm/U2"]) {
		db.run("INSERT INTO origins (origin_key, epoch, session_dir, updated_at) VALUES (?, 1, '/s', ?)", [origin, NOW]);
	}
	const add = (id: string, origin: string, text: string, state: string, thread: string | null) =>
		db.run(
			`INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, thread_ref)
			 VALUES (?, ?, 1, ?, ?, ?, ?)`,
			[id, origin, text, state, NOW - 500, thread],
		);
	add("slash:C9:aa", "slack/ch/C9", "/new-ompbot", "pending", "C9:-"); // 4
	add("C9:2.0", "slack/ch/C9", "/new-ompbot", "pending", "C9:2.0"); // 5
	add("monitor:mon1:1", "monitor/mon1", "SECRET-MONITOR-PROMPT", "dispatched", null); // 6
	add("C9:3.0", "slack/ch/C9", "  [자동 후속] apply 결과 ok. 영수증을 읽고 보고", "pending", "C9:3.0"); // 7
	add("C9:4.0", "slack/ch/C9", "/followup-ompbot 이어서  해 줘", "pending", "C9:4.0"); // 8
	add("D2:5.0", "slack/dm/U2", MASKED_BODY, "pending", "D2:-"); // 9
	add("D2:6.0", "slack/dm/U2", `${"A".repeat(100)}${LONG_TAIL}`, "pending", "D2:6.0"); // 10
	db.close();
}

const turnsOf = (snapshot: DashboardSnapshot): Map<number, TurnInfo> => {
	if (!snapshot.turns.ok) throw new Error(`turns section failed: ${snapshot.turns.error}`);
	return new Map(snapshot.turns.items.map((turn) => [turn.inboundId, turn]));
};
const withStatus = (status: Partial<StatusReport>): Partial<SnapshotDeps> => ({
	callDaemon: async () => ({ ok: true, status: { ...STATUS, ...status } }),
});
const DRAIN = { drain: { turns: 2, hostTools: 0, approvals: 0 } };
const FROZEN = { frozen: { since: "2026-11-04T00:00:00.000Z", reason: "maintenance", by: "cli" } };

describe("dashboard turn context", () => {
	beforeEach(seedTurns);

	test("AC-1: every turn row carries kind·preview·waitReason·blocksRestart·topLevel next to the old fields", async () => {
		const snapshot = await buildSnapshot(deps());
		if (!snapshot.turns.ok) throw new Error(snapshot.turns.error);
		expect(snapshot.turns.items).toHaveLength(9);
		for (const turn of snapshot.turns.items) {
			for (const key of [
				"inboundId",
				"originKey",
				"threadRef",
				"state",
				"createdAt",
				"ageMs",
				"silentMs",
				"stalled",
				"kind",
				"preview",
				"waitReason",
				"blocksRestart",
				"topLevel",
			]) {
				expect(Object.hasOwn(turn, key)).toBe(true);
			}
		}
		expect(turnsOf(snapshot).get(1)).toMatchObject({
			inboundId: 1,
			originKey: "slack/dm/U1",
			threadRef: "D1:1.0",
			state: "dispatched",
			createdAt: "2026-11-04T08:00:00+09:00",
			ageMs: 3_600_000,
			silentMs: 60_000,
		});
	});

	test("AC-2: slash and /command rows are commands, monitor rows have no preview, [자동 후속] is auto", async () => {
		const turns = turnsOf(await buildSnapshot(deps()));
		const pick = (id: number) => [turns.get(id)?.kind, turns.get(id)?.preview];
		expect(pick(4)).toEqual(["command", "/new-ompbot"]);
		expect(pick(5)).toEqual(["command", "/new-ompbot"]);
		expect(pick(6)).toEqual(["monitor", null]);
		expect(turns.get(7)?.kind).toBe("auto");
		expect(turns.get(7)?.preview).toBe("[자동 후속] apply 결과 ok. 영수증을 읽고 보고");
		expect(pick(8)).toEqual(["command", "/followup-ompbot 이어서 해 줘"]);
		expect(pick(2)).toEqual(["message", "second request"]);
		expect(turns.get(9)?.kind).toBe("message");
		expect([turns.get(4)?.slash, turns.get(5)?.slash]).toEqual([true, false]);
		expect([turns.get(4)?.topLevel, turns.get(5)?.topLevel, turns.get(9)?.topLevel, turns.get(6)?.topLevel]).toEqual([
			true,
			false,
			true,
			false,
		]);
	});

	test("AC-3: the preview is masked, one line, attachments folded, 80 chars at most", async () => {
		const snapshot = await buildSnapshot(deps());
		const turns = turnsOf(snapshot);
		expect(turns.get(9)?.preview).toBe("첫 줄 둘째 줄 [REDACTED] [REDACTED] [첨부] 끝");
		const long = turns.get(10)?.preview ?? "";
		expect([...long]).toHaveLength(80);
		expect(long).toBe(`${"A".repeat(79)}…`);
		expect([...(turns.get(1)?.preview ?? "")]).toHaveLength(80);
		const html = [
			renderDashboardMain(snapshot, undefined, NOW, { view: "turns" }),
			renderItemDetail(snapshot, "turns", "9"),
		].join("");
		const json = JSON.stringify(snapshot);
		for (const leak of ["xoxb-TEST-0", "sk-TESTKEY123", LONG_TAIL, "/home/x/media", "SECRET-MONITOR-PROMPT"]) {
			expect(json).not.toContain(leak);
			expect(html).not.toContain(leak);
		}
		expect(html).toContain("첫 줄 둘째 줄 [REDACTED] [REDACTED] [첨부] 끝");
	});

	test("AC-4: waitReason follows drain > freeze > followup > behind > queued; drain marks the running turns", async () => {
		const reasons = (turns: Map<number, TurnInfo>) =>
			[...turns.values()].map((turn) => [turn.inboundId, turn.waitReason, turn.blocksRestart]);
		expect(reasons(turnsOf(await buildSnapshot(deps())))).toEqual([
			[1, null, false],
			[2, "behind", false],
			[4, "queued", false],
			[5, "queued", false],
			[6, null, false],
			[7, "queued", false],
			[8, "followup", false],
			[9, "queued", false],
			[10, "queued", false],
		]);
		const frozen = turnsOf(await buildSnapshot(deps(withStatus(FROZEN))));
		expect([...frozen.values()].filter((t) => t.state === "pending").every((t) => t.waitReason === "frozen")).toBe(
			true,
		);
		expect(reasons(turnsOf(await buildSnapshot(deps(withStatus({ ...DRAIN, ...FROZEN })))))).toEqual([
			[1, null, true],
			[2, "restart", false],
			[4, "restart", false],
			[5, "restart", false],
			[6, null, true],
			[7, "restart", false],
			[8, "restart", false],
			[9, "restart", false],
			[10, "restart", false],
		]);
	});

	test("AC-4: a drain known only from the sweep heartbeat counts too", async () => {
		writeFileSync(join(home.dir, SWEEP_HEARTBEAT_FILE), `ts=${new Date(NOW).toISOString()} loop_ms=1 draining=1\n`);
		const turns = turnsOf(await buildSnapshot(deps()));
		expect([turns.get(2)?.waitReason, turns.get(1)?.blocksRestart]).toEqual(["restart", true]);
	});

	test("AC-5: a failed daemon section still serves 200 and judges turns without drain or freeze", async () => {
		const failing = deps({
			callDaemon: async () => Promise.reject(new Error("no daemon")),
			ompVersion: async () => Promise.reject(new Error("omp missing")),
		});
		const server = startDashboardServer({ port: 0, hostname: "127.0.0.1", snapshot: () => buildSnapshot(failing) });
		try {
			const response = await fetch(`http://127.0.0.1:${server.port}/api/snapshot`);
			expect(response.status).toBe(200);
			const body = (await response.json()) as DashboardSnapshot;
			expect(body.daemon.ok).toBe(false);
			expect(body.turns.ok).toBe(true);
			const turns = turnsOf(body);
			expect([
				turns.get(1)?.blocksRestart,
				turns.get(2)?.waitReason,
				turns.get(8)?.waitReason,
				turns.get(9)?.waitReason,
			]).toEqual([false, "behind", "followup", "queued"]);
		} finally {
			server.stop(true);
		}
	});

	test("AC-6: thread cards show the first request as title, kind·place, the last turn's wait reason, and the drain line only while draining", async () => {
		const draining = await buildSnapshot(deps(withStatus(DRAIN)));
		const html = renderDashboardMain(draining, undefined, NOW, { view: "turns" });
		expect(html).toContain('<p class="card-title">/new-ompbot</p>');
		expect(html).toContain('<p class="card-title">첫 줄 둘째 줄 [REDACTED] [REDACTED] [첨부] 끝</p>');
		expect(html).toContain('<p class="card-title">nightly</p>');
		for (const label of ["대화", "명령", "모니터", "재시작 대기", "재시작이 기다리는 턴", "C9 채널 메인", "DM"]) {
			expect(html).toContain(`>${label}<`);
		}
		expect(html).toContain("진행 중인 턴 2개가 끝나면 재시작합니다 (가장 오래된 턴 경과 1시간 0분)");
		expect(html).toContain("그동안 들어온 요청은 재시작 뒤 처리됩니다.");
		const detail = renderItemDetail(draining, "turns", "4");
		for (const fact of ["명령", "재시작 대기", "/new-ompbot", "/followup-ompbot 이어서 해 줘"])
			expect(detail).toContain(fact);

		const calm = await buildSnapshot(deps());
		const plain = renderDashboardMain(calm, undefined, NOW, { view: "turns" });
		expect(plain).not.toContain("재시작 준비 중");
		expect(plain).not.toContain("재시작이 기다리는 턴");
		for (const label of ["앞 턴 대기", "전달 대기", "팔로업 대기"]) expect(plain).toContain(`>${label}<`);
		const frozen = renderDashboardMain(await buildSnapshot(deps(withStatus(FROZEN))), undefined, NOW, {
			view: "turns",
		});
		expect(frozen).toContain(">동결 중<");

		// The shipped client renderer draws the same turn view.
		const page = renderDashboardPage(draining);
		const script = /<script>([\s\S]*)<\/script>/.exec(page)?.[1] ?? "";
		const clientRender = new Function("document", "setInterval", `${script}\nreturn renderDashboardMain;`)(
			{ getElementById: () => ({}) },
			() => 0,
		) as typeof renderDashboardMain;
		expect(clientRender(draining, undefined, NOW, { view: "turns" })).toBe(html);
	});
});

describe("dashboard server", () => {
	let stop: (() => void) | undefined;
	afterEach(() => stop?.());

	async function serve(snapshot: () => Promise<DashboardSnapshot>): Promise<string> {
		const server = startDashboardServer({ port: 0, hostname: "127.0.0.1", snapshot });
		stop = () => server.stop(true);
		return `http://127.0.0.1:${server.port}`;
	}

	test("AC-2: other methods are 405, unknown paths 404; HEAD and prefixed paths are served", async () => {
		const base = await serve(() => buildSnapshot(deps()));
		const post = await fetch(`${base}/api/snapshot`, { method: "POST" });
		expect(post.status).toBe(405);
		expect(post.headers.get("allow")).toBe("GET, HEAD");
		expect((await fetch(`${base}/nope`)).status).toBe(404);
		expect((await fetch(`${base}/api/snapshot`, { method: "HEAD" })).status).toBe(200);
		expect(await (await fetch(`${base}/ompbot/healthz`)).text()).toBe("ok");
		const prefixed = await fetch(`${base}/ompbot/`);
		expect(prefixed.headers.get("content-type")).toContain("text/html");
	});

	test("AC-6: /api/snapshot is 200 while one herdr host fails", async () => {
		const base = await serve(() => buildSnapshot(deps({ run: fakeRunner({ remoteFails: true }).run })));
		const response = await fetch(`${base}/api/snapshot`);
		expect(response.status).toBe(200);
		const body = (await response.json()) as DashboardSnapshot;
		expect(body.herdr.ok && body.herdr.hosts.map((host) => [host.host, host.ok])).toEqual([
			["local", true],
			["remote", false],
		]);
		expect([body.tasks.ok, body.daemon.ok]).toEqual([true, true]);
	});

	test("AC-7: a <script> task title is escaped in the page; the client renderer draws the same markup", async () => {
		const snapshot = await buildSnapshot(deps());
		const base = await serve(async () => snapshot);
		const html = await (await fetch(`${base}/`)).text();
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).not.toContain(XSS_TITLE);
		expect(html).toContain('fetch("api/snapshot"');
		expect(html).toBe(renderDashboardPage(snapshot));
		// The shipped inline script must parse as served and its renderer must draw what the server drew.
		const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
		const fakeDocument = { getElementById: () => ({}) };
		const clientRender = new Function("document", "setInterval", `${script}\nreturn renderDashboardMain;`)(
			fakeDocument,
			() => 0,
		) as typeof renderDashboardMain;
		expect(clientRender(snapshot)).toBe(renderDashboardMain(snapshot));
	});

	test("page is / and a one-segment prefix only; api·healthz-prefixed or deeper slash paths are 404", async () => {
		const base = await serve(() => buildSnapshot(deps()));
		for (const path of ["/", "/task/"]) {
			const response = await fetch(`${base}${path}`);
			expect([path, response.status, response.headers.get("content-type")]).toEqual([
				path,
				200,
				"text/html; charset=utf-8",
			]);
		}
		for (const path of ["/api/", "/api/board/", "/healthz/", "/a/b/"]) {
			const response = await fetch(`${base}${path}`);
			expect([path, response.status]).toEqual([path, 404]);
		}
		const snapshot = await fetch(`${base}/task/api/snapshot`);
		expect([snapshot.status, snapshot.headers.get("content-type")]).toEqual([200, "application/json; charset=utf-8"]);
		expect(await (await fetch(`${base}/task/healthz`)).text()).toBe("ok");
	});
});

/** Rejects when `promise` has not settled within `ms` (a bound on a wait, not a sleep). */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	const { promise: late, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new Error(`${what} still pending after ${ms}ms`)), ms);
	return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const MINUTE = 60_000;

/** Two dispatched turns past the starvation limit (one on a live approval) and one 9 minutes quiet. */
function seedStalls(): { silentEvent: number; quiet: number; approved: number } {
	const db = new Database(dbPath, { strict: true });
	for (const origin of ["slack/ch/C7", "slack/ch/C8", "slack/ch/C6"]) {
		db.run("INSERT INTO origins (origin_key, epoch, session_dir, updated_at) VALUES (?, 1, '/s', ?)", [origin, NOW]);
	}
	const add = (id: string, origin: string, dispatchedAt: number, lastEventAt: number | null): number =>
		Number(
			db.run(
				`INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at, thread_ref, last_event_at)
				 VALUES (?, ?, 1, 'work', 'dispatched', ?, ?, ?, ?)`,
				[id, origin, dispatchedAt - MINUTE, dispatchedAt, `${origin.slice(-2)}:${id}`, lastEventAt],
			).lastInsertRowid,
		);
	const ids = {
		silentEvent: add("7.0", "slack/ch/C7", NOW - 11 * MINUTE, null),
		quiet: add("8.0", "slack/ch/C8", NOW - 20 * MINUTE, NOW - 9 * MINUTE),
		approved: add("6.0", "slack/ch/C6", NOW - 11 * MINUTE, null),
	};
	db.run(
		`INSERT INTO approvals (approval_id, channel, message_ts, summary, status, created_at, expires_at, origin_key)
		 VALUES ('ap6', 'C6', '6.1', 'deploy', 'pending', ?, ?, 'slack/ch/C6')`,
		[NOW - MINUTE, NOW + 60 * MINUTE],
	);
	db.close();
	return ids;
}

describe("dashboard review fixes", () => {
	test("a build past buildTimeoutMs rejects; the next call starts a new build and returns its snapshot", async () => {
		const good = await buildSnapshot(deps());
		let builds = 0;
		const cache = createSnapshotCache(
			() => {
				builds += 1;
				return builds === 1 ? new Promise<DashboardSnapshot>(() => undefined) : Promise.resolve(good);
			},
			clock.now,
			SNAPSHOT_TTL_MS,
			50,
		);
		const first = await within(
			cache().then(
				() => "resolved",
				(error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
			),
			2_000,
			"the hung build",
		);
		expect(first).toStartWith("rejected:");
		expect(await within(cache(), 2_000, "the second build")).toBe(good);
		expect(builds).toBe(2);
	});

	test("a broken acceptance_json or notices_json row keeps the tasks section ok, with defaults and an error", async () => {
		const db = new Database(dbPath, { strict: true });
		db.run("DELETE FROM tasks WHERE task_id IN ('T-20261104-03', 'T-20261020-01')");
		db.run("UPDATE tasks SET acceptance_json = '{not json' WHERE task_id = 'T-20261104-02'");
		db.close();
		const snapshot = await buildSnapshot(deps());
		if (!snapshot.tasks.ok) throw new Error(`tasks section failed: ${snapshot.tasks.error}`);
		expect(snapshot.tasks.items.map((task) => task.taskId).sort()).toEqual([
			"T-20261103-01",
			"T-20261104-01",
			"T-20261104-02",
		]);
		const broken = taskOf(snapshot, "T-20261104-02");
		expect(broken.acTotal).toBe(0);
		expect(broken.acceptance ?? []).toEqual([]);
		expect(broken.error).toContain("acceptance_json");
		expect(taskOf(snapshot, "T-20261104-01")).toMatchObject({ acTotal: 2, acChecked: 1 });
		expect(taskOf(snapshot, "T-20261104-01").error).toBeUndefined();
		expect(taskOf(snapshot, "T-20261103-01").error).toBeUndefined();

		const again = new Database(dbPath, { strict: true });
		again.run(
			"UPDATE tasks SET acceptance_json = (SELECT acceptance_json FROM tasks WHERE task_id = 'T-20261104-01'), notices_json = '{not json' WHERE task_id = 'T-20261104-02'",
		);
		again.run("UPDATE tasks SET notices_json = '[1]' WHERE task_id = 'T-20261103-01'");
		again.close();
		const later = await buildSnapshot(deps());
		if (!later.tasks.ok) throw new Error(`tasks section failed: ${later.tasks.error}`);
		expect(later.tasks.items).toHaveLength(3);
		expect(taskOf(later, "T-20261104-02").acTotal).toBe(2);
		expect(taskOf(later, "T-20261104-02").error).toContain("notices_json");
		expect(taskOf(later, "T-20261103-01").error).toContain("notices_json");
	});

	test("one /api/machines fetch per snapshot serves every open TASK's card link", async () => {
		let fetches = 0;
		const base = fakeRunner();
		const run: ProcessRunner = async (cmd, opts) => {
			const result = await base.run(cmd, opts);
			if (cmd.join(" ") !== "herdr agent list") return result;
			const parsed = JSON.parse(result.stdout) as { result: { agents: unknown[] } };
			parsed.result.agents.push({ name: "t-20261104-02", agent: "omp", agent_status: "idle", pane_id: "p9" });
			return { ...result, stdout: JSON.stringify(parsed) };
		};
		const snapshot = await buildSnapshot(
			deps({
				run,
				fetch: (async () => {
					fetches += 1;
					return Response.json({
						machines: [
							{ id: "local-1", kind: "local" },
							{ id: "m-remote", name: "remote" },
						],
					});
				}) as unknown as typeof fetch,
			}),
		);
		expect(["T-20261104-01", "T-20261104-02", "T-20261104-03"].map((id) => [id, taskOf(snapshot, id).link])).toEqual([
			["T-20261104-01", "https://board.example.test/task/?card=p7"],
			["T-20261104-02", "https://board.example.test/task/?card=p9"],
			["T-20261104-03", "https://board.example.test/task/?card=m-remote:r9"],
		]);
		expect(fetches).toBe(1);
	});

	test("stalled follows inbound_starved: COALESCE(last_event_at, dispatched_at) past 10 min, not on a live approval", async () => {
		const ids = seedStalls();
		const turns = turnsOf(await buildSnapshot(deps()));
		expect(turns.get(ids.silentEvent)).toMatchObject({ stalled: true, silentMs: 11 * MINUTE });
		expect(turns.get(ids.quiet)).toMatchObject({ stalled: false, silentMs: 9 * MINUTE });
		expect(turns.get(ids.approved)).toMatchObject({ stalled: false, silentMs: 11 * MINUTE });
		// A pending turn has no silence yet.
		expect([...turns.values()].filter((turn) => turn.state === "pending").map((turn) => turn.silentMs)).toEqual([null]);

		const db = new Database(dbPath, { strict: true });
		db.run(
			`INSERT INTO approvals (approval_id, channel, message_ts, summary, status, created_at, expires_at, origin_key)
			 VALUES ('ap7', 'C7', '7.1', 'push', 'pending', ?, ?, 'slack/ch/C7')`,
			[NOW - MINUTE, NOW + 60 * MINUTE],
		);
		db.close();
		expect(turnsOf(await buildSnapshot(deps())).get(ids.silentEvent)?.stalled).toBe(false);

		const expire = new Database(dbPath, { strict: true });
		expire.run("UPDATE approvals SET expires_at = ? WHERE approval_id = 'ap7'", [NOW - 1]);
		expire.close();
		expect(turnsOf(await buildSnapshot(deps())).get(ids.silentEvent)?.stalled).toBe(true);
	});

	test("only the stalled thread gets 정체; the page script has copy failure, refresh→sync and the modal Tab trap", async () => {
		seedStalls();
		const snapshot = await buildSnapshot(deps());
		const html = renderDashboardMain(snapshot, undefined, NOW, { view: "turns" });
		const stalledCards = html
			.split('<a class="card')
			.slice(1)
			.filter((card) => card.includes(">정체<"))
			.map((card) => /data-row="([^"]+)"/.exec(card)?.[1]);
		expect(stalledCards).toEqual(["slack/ch/C7"]);

		const source = await Bun.file(join(import.meta.dir, "..", "src", "dashboard", "html.ts")).text();
		expect(source).not.toContain("STALL_MS");

		const page = renderDashboardPage(snapshot);
		const script = /<script>([\s\S]*)<\/script>/.exec(page)?.[1] ?? "";
		const copy = /const copyText = async[\s\S]*?\n\t};/.exec(script)?.[0] ?? "";
		expect(copy).toContain("복사 실패");
		const refresh = /async function refresh\(\) \{([\s\S]*?)\} catch/.exec(script)?.[1] ?? "";
		expect(refresh).toMatch(/drawDetail\(\);\s*sync\(\);/);
		expect(script).toContain('event.key === "Tab"');
		// The shipped script still parses and its renderer draws what the server drew.
		const clientRender = new Function("document", "setInterval", `${script}\nreturn renderDashboardMain;`)(
			{ getElementById: () => ({}) },
			() => 0,
		) as typeof renderDashboardMain;
		expect(clientRender(snapshot, undefined, NOW, { view: "turns" })).toBe(html);
	});
});
