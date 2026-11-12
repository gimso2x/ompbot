import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StatusReport } from "../src/daemon/status";
import { renderDashboardMain, renderDashboardPage, renderItemDetail } from "../src/dashboard/html";
import { startDashboardServer } from "../src/dashboard/server";
import {
	buildSnapshot,
	createSnapshotCache,
	type DashboardSnapshot,
	type SnapshotDeps,
} from "../src/dashboard/snapshot";
import type { ProcessRunner } from "../src/dispatch/omp";
import { STAMP_FILE } from "../src/ops/backup";
import {
	BACKUP_MAX_AGE_MS,
	type Gate,
	type GatesOptions,
	LANE_STUCK_MS,
	TURNS_FAILING_THRESHOLD,
	TURNS_FAILING_WINDOW_MS,
} from "../src/ops/gates";
import { OFFSITE_STAMP_FILE } from "../src/ops/offsite";
import { openStore } from "../src/store/db";
import { makeHome, type TestHome } from "./helpers/bot-home";

const NOW = Date.parse("2026-11-04T03:00:00Z");
const HOUR = 3_600_000;
/** A signature hash like the one the owner saw as the card title. */
const SIG = "f0a0d2da7c41e9b3";

const GATE_NAMES = [
	"backup_age",
	"offsite_age",
	"sweep_stalled",
	"slack_disconnected",
	"frozen",
	"omp_runtime",
	"inbound_starved",
	"origin_silent",
	"deliveries_overdue",
	"lanes_stuck",
	"monitors_failed",
	"monitors_stalled",
	"turns_failing",
];

/** Thirteen gates; the named ones are open, `turns_failing` carries a token in its detail. */
const gatesWith = (...open: string[]): Gate[] =>
	GATE_NAMES.map((name) => ({
		name,
		state: open.includes(name) ? "open" : "closed",
		detail: name === "turns_failing" ? "recent=0 xoxb-TEST-0" : `${name}=detail`,
	}));

const STATUS: StatusReport = {
	ompVersion: "omp 9.9.9",
	timezone: "Asia/Seoul",
	daemonRunning: true,
	origins: [{ originKey: "slack/dm/U1", epoch: 1, ompPid: 42, busy: false }],
	ledger: { pending: 0, inflight: 0, confirmed: 5, ambiguous: 0, expired: 0 },
	inbound: { pending: 0, dispatched: 0, answered: 1, failed_notified: 0, discarded: 0 },
	monitors: { count: 0, next: null },
	openGates: [],
};

let home: TestHome;
let dbPath: string;
let clock: { t: number; now: () => number };

/** Alert rows: a closed-gate record with a hash signature, an open-gate record, a chat-turn record, a resolved one. */
function seedAlerts(): void {
	openStore({ timezone: "Asia/Seoul", path: dbPath, clock: { now: () => NOW }, redact: (text) => text }).close();
	const db = new Database(dbPath, { strict: true });
	const add = (scope: string, signature: string, status: string, count: number, first: number, last: number) =>
		db.run(
			`INSERT INTO alert_incidents (scope, signature, status, count, first_at, last_at, alerted_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[scope, signature, status, count, first, last, first],
		);
	add("gate:turns_failing", SIG, "alerted", 12, NOW - 30 * HOUR, NOW - 20 * HOUR);
	add("gate:lanes_stuck", "open", "alerted", 2, NOW - 3 * HOUR, NOW - HOUR);
	add("turns:slack/dm/U1", "turn_failed", "alerted", 4, NOW - 2 * HOUR, NOW - 2 * HOUR);
	add("gate:frozen", "open", "resolved", 1, NOW - 50 * HOUR, NOW - 49 * HOUR);
	db.close();
}

function stamp(name: string, ageMs: number): void {
	const dir = join(home.dir, "backups");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, name), `ts=${new Date(NOW - ageMs).toISOString()} file=x.db\n`);
}

const gitOnly: ProcessRunner = async () => ({ code: 0, stdout: "abc1234\n", timedOut: false });

function deps(overrides: Partial<SnapshotDeps> = {}): SnapshotDeps {
	return {
		homeDir: home.dir,
		repoDir: "/srv/ompbot",
		timezone: "Asia/Seoul",
		config: { ompExecutable: home.config.ompExecutable },
		now: clock.now,
		callDaemon: async () => ({ ok: true, status: STATUS }),
		run: gitOnly,
		ompVersion: async () => "omp-stub 0.0.0",
		hostOps: () => {
			throw new Error("no task hosts in this test");
		},
		collectGates: () => gatesWith("lanes_stuck"),
		...overrides,
	};
}

const alertOf = (snapshot: DashboardSnapshot, scope: string) => {
	if (!snapshot.alerts.ok) throw new Error(snapshot.alerts.error);
	const found = snapshot.alerts.items.find((item) => item.scope === scope);
	if (found === undefined) throw new Error(`no alert ${scope}`);
	return found;
};

/** The alerts nav entry's count chip class. */
const navChip = (html: string, view: string): string =>
	new RegExp(`data-view="${view}"[^>]*><span>[^<]*</span><span class="(nav-count[^"]*)"`).exec(html)?.[1] ?? "";

/** The markup of one system card. */
const sysCard = (html: string, id: string): string => {
	const start = html.indexOf(`data-card="${id}"`);
	if (start < 0) throw new Error(`no card ${id}`);
	return html.slice(start, html.indexOf("</section>", start));
};

beforeEach(() => {
	home = makeHome("ompbot-dash-alerts-");
	dbPath = join(home.dir, "ompbot.db");
	clock = { t: NOW, now: () => clock.t };
	seedAlerts();
});
afterEach(() => home.remove());

describe("dashboard alerts & system snapshot", () => {
	test("AC-1: gates and backup are added; old top-level keys and alert fields stay", async () => {
		stamp(STAMP_FILE, 2 * HOUR);
		const seen: GatesOptions[] = [];
		const snapshot = await buildSnapshot(
			deps({
				collectGates: (options) => {
					seen.push(options);
					return gatesWith("lanes_stuck");
				},
			}),
		);
		for (const key of [
			"generatedAt",
			"daemon",
			"turns",
			"tasks",
			"lanes",
			"herdr",
			"approvals",
			"monitors",
			"alerts",
			"gates",
			"backup",
		]) {
			expect(snapshot).toHaveProperty(key);
		}
		expect(seen).toEqual([
			{ homeDir: home.dir, now: NOW, ompExecutable: home.config.ompExecutable, offsiteConfigured: false },
		]);
		if (!snapshot.gates.ok) throw new Error(snapshot.gates.error);
		expect(snapshot.gates.items).toHaveLength(13);
		expect(snapshot.gates.items.find((gate) => gate.name === "turns_failing")).toEqual({
			name: "turns_failing",
			state: "closed",
			detail: "recent=0 [REDACTED]",
		});
		expect(snapshot.backup).toEqual({
			ok: true,
			local: { at: "2026-11-04T10:00:00+09:00", ageMs: 2 * HOUR },
			offsite: null,
		});
		expect(alertOf(snapshot, "gate:turns_failing")).toMatchObject({
			scope: "gate:turns_failing",
			signature: SIG,
			count: 12,
			lastAt: "2026-11-03T16:00:00+09:00",
			firstAt: "2026-11-03T06:00:00+09:00",
			status: "alerted",
		});
		expect(typeof alertOf(snapshot, "gate:turns_failing").incidentId).toBe("number");

		// A configured offsite without its stamp reads as missing; with a stamp it has an age.
		const offsite = { offsite: { ssh: "backup-host", remoteDir: "/b" } };
		const missing = await buildSnapshot(deps({ config: { ompExecutable: home.config.ompExecutable, ...offsite } }));
		expect(missing.backup.ok && missing.backup.offsite).toBeUndefined();
		stamp(OFFSITE_STAMP_FILE, 5 * HOUR);
		const present = await buildSnapshot(deps({ config: { ompExecutable: home.config.ompExecutable, ...offsite } }));
		expect(present.backup.ok && present.backup.offsite).toEqual({ at: "2026-11-04T07:00:00+09:00", ageMs: 5 * HOUR });
	});

	test("AC-2: gate: alert rows carry the gate's current state from the same snapshot", async () => {
		const snapshot = await buildSnapshot(deps());
		expect(alertOf(snapshot, "gate:turns_failing").gateState).toBe("closed");
		expect(alertOf(snapshot, "gate:lanes_stuck").gateState).toBe("open");
		expect(alertOf(snapshot, "turns:slack/dm/U1").gateState).toBeUndefined();
		if (!snapshot.alerts.ok) throw new Error(snapshot.alerts.error);
		expect(snapshot.alerts.items.map((item) => item.scope)).not.toContain("gate:frozen");

		const flipped = await buildSnapshot(deps({ collectGates: () => gatesWith("turns_failing") }));
		expect(alertOf(flipped, "gate:turns_failing").gateState).toBe("open");
		expect(alertOf(flipped, "gate:lanes_stuck").gateState).toBe("closed");
		// A gate the list does not carry (omp_runtime without an omp agent, offsite without config) is unknown.
		const partial = await buildSnapshot(
			deps({ collectGates: () => gatesWith().filter((gate) => gate.name !== "lanes_stuck") }),
		);
		expect(alertOf(partial, "gate:lanes_stuck").gateState).toBe("unknown");
	});

	test("AC-6: collectGates throwing is only gates ok:false; /api/snapshot is 200 and gate cards say 상태 모름", async () => {
		const build = () =>
			buildSnapshot(
				deps({
					collectGates: () => {
						throw new Error("gates exploded xoxb-TEST-0");
					},
				}),
			);
		const server = startDashboardServer({ port: 0, hostname: "127.0.0.1", snapshot: build });
		try {
			const response = await fetch(`http://127.0.0.1:${server.port}/api/snapshot`);
			expect(response.status).toBe(200);
			const body = (await response.json()) as DashboardSnapshot;
			expect(body.gates).toEqual({ ok: false, error: "gates exploded [REDACTED]" });
			expect([body.daemon.ok, body.alerts.ok, body.backup.ok, body.turns.ok]).toEqual([true, true, true, true]);
			expect(alertOf(body, "gate:turns_failing").gateState).toBe("unknown");
			const html = renderDashboardMain(body, undefined, NOW, { view: "alerts" });
			expect(html).toContain("상태 모름");
			expect(html).not.toContain("지금 열림");
		} finally {
			server.stop(true);
		}
	});

	test("AC-7: two requests inside the 10 s cache run collectGates once", async () => {
		let calls = 0;
		const d = deps({
			collectGates: () => {
				calls += 1;
				return gatesWith();
			},
		});
		const snapshot = createSnapshotCache(() => buildSnapshot(d), clock.now);
		await Promise.all([snapshot(), snapshot()]);
		clock.t += 9_999;
		await snapshot();
		expect(calls).toBe(1);
		clock.t += 1;
		await snapshot();
		expect(calls).toBe(2);
	});
});

describe("dashboard alerts & system screens", () => {
	test("AC-3: the hash is only in the detail panel; gate cards are titled from the gate constants", async () => {
		const snapshot = await buildSnapshot(deps());
		const main = renderDashboardMain(snapshot, undefined, NOW, { view: "alerts" });
		expect(main).not.toContain(SIG);
		expect(main).toContain(`최근 ${TURNS_FAILING_WINDOW_MS / HOUR}시간 턴 실패가 ${TURNS_FAILING_THRESHOLD}회 이상`);
		expect(main).toContain(`레인이 ${LANE_STUCK_MS / HOUR}시간 넘게 멈춤`);
		expect(main).toContain("대화 턴 연속 실패 · slack/dm/U1");
		expect(main).toContain("<code>turn_failed</code>");
		const id = String(alertOf(snapshot, "gate:turns_failing").incidentId);
		const detail = renderItemDetail(snapshot, "alerts", id);
		expect(detail).toContain(SIG);
		expect(detail).toContain(`data-copy="${SIG}"`);
		expect(detail).toContain("gate:turns_failing");
		expect(detail).toContain(`>${id}<`);
		expect(detail).toContain("recent=0 [REDACTED]");
		// The page the server sends for a selected alert carries the hash only inside the detail panel.
		const page = renderDashboardPage(snapshot, { view: "alerts", item: id }).replace(/<script>[\s\S]*<\/script>/, "");
		const panel = page.indexOf('id="detail-head"');
		expect(page.indexOf(SIG)).toBeGreaterThan(panel);
	});

	test("AC-4: open gates first with 지금 열림; closed ones read as records; zero open shows the notice, grey chip", async () => {
		const snapshot = await buildSnapshot(deps());
		const main = renderDashboardMain(snapshot, undefined, NOW, { view: "alerts" });
		const lanes = main.indexOf("레인이");
		const turns = main.indexOf("최근 1시간");
		expect(lanes).toBeGreaterThan(0);
		expect(turns).toBeGreaterThan(lanes);
		expect(main.slice(main.lastIndexOf('<a class="row', lanes), lanes)).toContain("지금 열림");
		expect(main.slice(main.lastIndexOf('<a class="row', turns), turns)).toContain("지금은 닫힘 · 기록만 남음");
		expect(main).not.toContain("지금 열린 알림은 없습니다");
		expect(navChip(main, "alerts")).toBe("nav-count is-warn");

		const quiet = await buildSnapshot(deps({ collectGates: () => gatesWith() }));
		const calm = renderDashboardMain(quiet, undefined, NOW, { view: "alerts" });
		expect(calm).toContain("지금 열린 알림은 없습니다. 아래는 아직 정리되지 않은 기록입니다");
		expect(calm).not.toContain("지금 열림");
		// No open alert: the badge carries no number (the records stay in the list).
		expect(navChip(calm, "alerts")).toBe("");
	});

	test("AC-2: the alerts tab badge counts open alerts only: no number for one closed record, 1 for one open", async () => {
		const quiet = await buildSnapshot(deps({ collectGates: () => gatesWith() }));
		if (!quiet.alerts.ok) throw new Error(quiet.alerts.error);
		const record = quiet.alerts.items.find((alert) => alert.gateState === "closed");
		if (record === undefined) throw new Error("no closed alert record");
		const badgeOf = (gateState: "open" | "closed"): string => {
			const html = renderDashboardMain(
				{ ...quiet, alerts: { ok: true, items: [{ ...record, gateState }] } },
				undefined,
				NOW,
				{ view: "alerts" },
			);
			return (
				/data-view="alerts"[^>]*><span>[^<]*<\/span>(<span class="nav-count[^"]*">[^<]*<\/span>)?/.exec(html)?.[1] ?? ""
			);
		};
		expect(badgeOf("closed")).toBe("");
		expect(badgeOf("open")).toBe('<span class="nav-count is-warn">1</span>');
		// The closed record stays in the tab's list.
		const calm = renderDashboardMain({ ...quiet, alerts: { ok: true, items: [record] } }, undefined, NOW, {
			view: "alerts",
		});
		expect(calm).toContain("지금은 닫힘 · 기록만 남음");
	});

	test("AC-5: seven system cards, fifteen gate lines (real collectGates), backup past its age is a warning", async () => {
		stamp(STAMP_FILE, BACKUP_MAX_AGE_MS + HOUR);
		stamp(OFFSITE_STAMP_FILE, HOUR);
		const offsite = { offsite: { ssh: "backup-host", remoteDir: "/b" } };
		const { collectGates: _real, ...realGates } = deps();
		const snapshot = await buildSnapshot({
			...realGates,
			config: { ompExecutable: home.config.ompExecutable, ...offsite },
		});
		const html = renderDashboardMain(snapshot, undefined, NOW, { view: "system" });
		const cards = [...html.matchAll(/class="sys-card[^"]*" data-card="([a-z]+)"/g)].map((match) => match[1]);
		expect(cards).toEqual(["daemon", "slack", "sweep", "ledger", "backup", "gates", "monitors"]);
		expect(html.match(/class="gate-row/g)).toHaveLength(15);
		const backup = sysCard(html, "backup");
		expect(backup).toContain("주의");
		expect(backup).toContain("is-warning");
		// backup_age is open, so its line is first in the gate card.
		expect(sysCard(html, "gates").indexOf('data-gate="backup_age" data-state="open"')).toBeGreaterThan(0);

		stamp(STAMP_FILE, HOUR);
		const fresh = renderDashboardMain(await buildSnapshot(deps()), undefined, NOW, { view: "system" });
		expect(sysCard(fresh, "backup")).toContain("정상");
		expect(sysCard(fresh, "backup")).not.toContain("is-warning");
	});

	test("the shipped client renderer draws the alerts and system views the same as the server", async () => {
		stamp(STAMP_FILE, HOUR);
		const snapshot = await buildSnapshot(deps());
		const html = renderDashboardPage(snapshot);
		const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
		const fakeDocument = { getElementById: () => ({}) };
		const client = new Function(
			"document",
			"setInterval",
			`${script}\nreturn { renderDashboardMain, renderItemDetail };`,
		)(fakeDocument, () => 0) as {
			renderDashboardMain: typeof renderDashboardMain;
			renderItemDetail: typeof renderItemDetail;
		};
		for (const view of ["alerts", "system"]) {
			expect(client.renderDashboardMain(snapshot, undefined, NOW, { view })).toBe(
				renderDashboardMain(snapshot, undefined, NOW, { view }),
			);
		}
		const id = String(alertOf(snapshot, "gate:turns_failing").incidentId);
		expect(client.renderItemDetail(snapshot, "alerts", id)).toBe(renderItemDetail(snapshot, "alerts", id));
	});
});
