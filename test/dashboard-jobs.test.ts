import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDashboardMain, renderDashboardPage, renderItemDetail } from "../src/dashboard/html";
import { buildSnapshot, type DashboardSnapshot, type JobInfo, type SnapshotDeps } from "../src/dashboard/snapshot";
import { openStore } from "../src/store/db";

const NOW = Date.parse("2026-11-04T13:50:00Z");
const MINUTE = 60_000;
const LIVE_PID = 4242;

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ompbot-jobs-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** A home with no database: only the `jobs` section is under test, every other section may fail. */
function deps(overrides: Partial<SnapshotDeps> = {}): SnapshotDeps {
	return {
		homeDir: home,
		repoDir: "/srv/ompbot",
		timezone: "Asia/Seoul",
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
		isAlive: (pid) => pid === LIVE_PID,
		...overrides,
	};
}

const iso = (ms: number): string => new Date(ms).toISOString();

function writeJob(name: string, body: unknown): void {
	mkdirSync(join(home, "jobs"), { recursive: true });
	writeFileSync(join(home, "jobs", name), typeof body === "string" ? body : JSON.stringify(body));
}

/** The turn view's side-menu count and whether it warns. */
function turnsNav(html: string): { count: number; warn: boolean } {
	const match = /data-view="turns"[^>]*><span>턴<\/span><span class="nav-count( is-warn)?">(\d+)</.exec(html);
	if (match === null) throw new Error("no turns menu item");
	return { count: Number(match[2]), warn: match[1] !== undefined };
}

/** The page script's own renderer: what the browser redraws every 15 seconds. */
function clientRender(snapshot: DashboardSnapshot): typeof renderDashboardMain {
	const script = /<script>([\s\S]*)<\/script>/.exec(renderDashboardPage(snapshot))?.[1] ?? "";
	return new Function("document", "setInterval", `${script}\nreturn renderDashboardMain;`)(
		{ getElementById: () => ({}) },
		() => 0,
	) as typeof renderDashboardMain;
}

async function jobsOf(overrides: Partial<SnapshotDeps> = {}): Promise<JobInfo[]> {
	const snapshot = await buildSnapshot(deps(overrides));
	if (!snapshot.jobs.ok) throw new Error(`jobs section failed: ${snapshot.jobs.error}`);
	return snapshot.jobs.items;
}

describe("dashboard jobs section", () => {
	test("AC-1: a running job with a live pid reads as ok with its percent", async () => {
		writeJob("a.json", {
			title: "oh-my-pi 코드 지도",
			state: "running",
			done: 290,
			total: 10254,
			unit: "조각",
			startedAt: iso(NOW - 70 * MINUTE),
			updatedAt: iso(NOW - MINUTE),
			pid: LIVE_PID,
		});
		const [job] = await jobsOf();
		expect(job?.name).toBe("a");
		expect(job?.health).toBe("ok");
		expect(job?.done).toBe(290);
		expect(job?.total).toBe(10254);
		expect(job?.percent).toBeCloseTo(2.8, 1);
	});

	test("AC-2: health reads stale, dead, failed and invalid; a broken file leaves the others intact", async () => {
		const fresh = iso(NOW - MINUTE);
		writeJob("fresh.json", { state: "running", updatedAt: fresh, pid: LIVE_PID, done: 1, total: 2 });
		writeJob("stale.json", { state: "running", updatedAt: iso(NOW - 11 * MINUTE), pid: LIVE_PID });
		writeJob("dead.json", { state: "running", updatedAt: fresh, pid: 9999 });
		writeJob("failed.json", { state: "failed", updatedAt: fresh, detail: "exit 1" });
		writeJob("broken.json", '{"state": "running", ');
		writeJob("no-updated.json", { state: "running", done: 3, total: 4 });
		const snapshot = await buildSnapshot(deps());
		expect(snapshot.jobs.ok).toBe(true);
		const jobs = await jobsOf();
		const health = Object.fromEntries(jobs.map((job) => [job.name, job.health]));
		expect(health).toEqual({
			fresh: "ok",
			stale: "stale",
			dead: "dead",
			failed: "failed",
			broken: "invalid",
			"no-updated": "invalid",
		});
		const byName = new Map(jobs.map((job) => [job.name, job]));
		expect(byName.get("fresh")).toMatchObject({ state: "running", done: 1, total: 2, percent: 50 });
		expect(byName.get("broken")).toMatchObject({ title: "broken.json", state: null });
		expect(byName.get("broken")?.detail).toContain("읽기 실패");
		expect(byName.get("no-updated")?.detail).toContain("updatedAt");
		// A running job past the stale limit with no pid is stale, not dead; a done job with a gone pid is still ok.
		writeJob("stale.json", { state: "running", updatedAt: iso(NOW - 11 * MINUTE) });
		writeJob("dead.json", { state: "done", updatedAt: fresh, pid: 9999 });
		const again = new Map((await jobsOf()).map((job) => [job.name, job.health]));
		expect(again.get("stale")).toBe("stale");
		expect(again.get("dead")).toBe("ok");
	});

	test("counts outside 0 ≤ done ≤ total show no numbers; total 0 shows counts without a percent", async () => {
		const fresh = iso(NOW - MINUTE);
		writeJob("over.json", { state: "running", updatedAt: fresh, done: 5, total: 4 });
		writeJob("negative.json", { state: "running", updatedAt: fresh, done: -1, total: 4 });
		writeJob("fraction.json", { state: "running", updatedAt: fresh, done: 1.5, total: 4 });
		writeJob("empty.json", { state: "running", updatedAt: fresh, done: 0, total: 0 });
		const byName = new Map((await jobsOf()).map((job) => [job.name, job]));
		for (const name of ["over", "negative", "fraction"]) {
			expect(byName.get(name)?.done).toBeUndefined();
			expect(byName.get(name)?.total).toBeUndefined();
			expect(byName.get(name)?.percent).toBeUndefined();
		}
		expect(byName.get("empty")).toMatchObject({ done: 0, total: 0 });
		expect(byName.get("empty")?.percent).toBeUndefined();
	});

	test("a jobs path that cannot be listed fails only the jobs section", async () => {
		writeFileSync(join(home, "jobs"), "not a directory");
		const snapshot = await buildSnapshot(deps());
		expect(snapshot.jobs.ok).toBe(false);
		expect(snapshot.backup.ok).toBe(true);
	});

	test("AC-4: old done jobs drop out, misnamed files are not read, title and detail are masked and cut", async () => {
		writeJob("old-done.json", { state: "done", updatedAt: iso(NOW - 25 * 60 * MINUTE) });
		writeJob("recent-done.json", { state: "done", updatedAt: iso(NOW - 23 * 60 * MINUTE) });
		// An old failed job stays: only finished work leaves the list.
		writeJob("old-failed.json", { state: "failed", updatedAt: iso(NOW - 25 * 60 * MINUTE) });
		const valid = { state: "running", updatedAt: iso(NOW - MINUTE) };
		writeFileSync(join(home, "x.json"), JSON.stringify(valid)); // `jobs/../x.json`
		writeJob("A B.json", valid);
		writeJob("Upper.json", valid);
		writeJob(".hidden.json", valid);
		writeJob("note.txt", valid);
		writeJob("half.json.tmp", valid);
		mkdirSync(join(home, "jobs", "dir.json"));
		writeJob("masked.json", {
			...valid,
			title: `제목 xoxb-TEST-0 ${"가".repeat(200)}`,
			detail: `tokens=3298706 key=xoxb-TEST-0 ${"x".repeat(300)}`,
		});
		const jobs = await jobsOf();
		expect(jobs.map((job) => job.name)).toEqual(["masked", "recent-done", "old-failed"]);
		const masked = jobs[0] as JobInfo;
		expect(masked.title).not.toContain("xoxb-TEST-0");
		expect(masked.title).toContain("[REDACTED]");
		expect(Array.from(masked.title)).toHaveLength(120);
		expect(masked.detail).not.toContain("xoxb-TEST-0");
		expect(masked.detail).toStartWith("tokens=3298706 key=[REDACTED]");
		expect(Array.from(masked.detail ?? "")).toHaveLength(200);
	});

	test("at most 50 jobs, newest update first", async () => {
		for (let i = 0; i < 55; i += 1) {
			writeJob(`job-${i}.json`, { state: "running", updatedAt: iso(NOW - i * 1000) });
		}
		const jobs = await jobsOf();
		expect(jobs).toHaveLength(50);
		expect(jobs[0]?.name).toBe("job-0");
		expect(jobs[49]?.name).toBe("job-49");
	});

	describe("turn view", () => {
		/** A bot database with no open turn: the turns section reads ok and empty. */
		beforeEach(() => {
			openStore({
				timezone: "Asia/Seoul",
				path: join(home, "ompbot.db"),
				clock: { now: () => NOW },
				redact: (text) => text,
			}).close();
		});

		test("AC-3: no jobs directory draws today's turn view; a running job alone gets the jobs block, counted in the head only", async () => {
			const empty = await buildSnapshot(deps());
			expect(empty.jobs).toEqual({ ok: true, items: [] });
			expect(empty.turns).toEqual({ ok: true, items: [], threads: [] });
			const before = renderDashboardMain(empty, undefined, NOW, { view: "turns" });
			expect(before).not.toContain("백그라운드 작업");
			expect(before).toContain("최근 24시간 턴이 없어요");
			expect(turnsNav(before)).toEqual({ count: 0, warn: false });

			writeJob("a.json", {
				title: "oh-my-pi 코드 지도",
				state: "running",
				done: 290,
				total: 10254,
				unit: "조각",
				startedAt: iso(NOW - 70 * MINUTE),
				updatedAt: iso(NOW - MINUTE),
				pid: LIVE_PID,
				thread: "C0123456789:1793795646.437279",
				detail: "tokens=3298706 retries=41 fail=0",
				log: "/tmp/hyeon-runs/oh-my-pi.log",
			});
			const snapshot = await buildSnapshot(deps());
			const html = renderDashboardMain(snapshot, undefined, NOW, { view: "turns" });
			expect(html).toContain("백그라운드 작업");
			expect(html).toContain("290/10254 조각 (2.8%)");
			expect(html).toContain('<span class="meter" role="img" aria-label="진행 2.8%">');
			expect(html).toContain("스레드 C0123456789:1793795646.437279");
			expect(html).toContain('data-row="job:a"');
			expect(html).toContain(">진행 중<");
			expect(html).not.toContain("최근 24시간 턴이 없어요");
			// The menu counts threads like the 진행 중 column; the running job is named in the head instead.
			expect(turnsNav(html)).toEqual({ count: 0, warn: false });
			expect(html).toContain('진행 중 스레드 <b>0</b> · <a href="#jobs">백그라운드 작업 <b>1</b></a>');
			// The page's own redraw draws the same, and the system view stays as it was.
			expect(clientRender(snapshot)(snapshot, undefined, NOW, { view: "turns" })).toBe(html);
			expect(renderDashboardMain(snapshot, undefined, NOW, { view: "system" })).not.toContain("백그라운드 작업");

			const detail = renderItemDetail(snapshot, "turns", "job:a");
			expect(detail).toContain("oh-my-pi 코드 지도");
			expect(detail).toContain(`<code>${LIVE_PID}</code>`);
			expect(detail).toContain("<code>/tmp/hyeon-runs/oh-my-pi.log</code>");
			expect(detail).toContain("tokens=3298706 retries=41 fail=0");
			expect(renderItemDetail(snapshot, "turns", "job:gone")).toContain("지금 목록에 없는 항목");
		});

		test("a done job folds under the board uncounted; a stale job sits on top and lights the menu warning", async () => {
			writeJob("finished.json", { state: "done", updatedAt: iso(NOW - MINUTE), done: 4, total: 4 });
			const done = renderDashboardMain(await buildSnapshot(deps()), undefined, NOW, { view: "turns" });
			expect(done).toContain(">완료<");
			expect(done).toContain('<details class="closed" id="closed"><summary>끝난 백그라운드 작업');
			expect(done).not.toContain('id="jobs"');
			expect(done.indexOf("최근 24시간 턴이 없어요")).toBeLessThan(done.indexOf("끝난 백그라운드 작업"));
			expect(done).not.toContain("백그라운드 작업 <b>");
			expect(turnsNav(done)).toEqual({ count: 0, warn: false });

			writeJob("late.json", { state: "running", updatedAt: iso(NOW - 11 * MINUTE) });
			const stale = renderDashboardMain(await buildSnapshot(deps()), undefined, NOW, { view: "turns" });
			expect(stale).toContain(">갱신 끊김<");
			expect(stale.indexOf('id="jobs"')).toBeGreaterThan(-1);
			expect(stale.indexOf('id="jobs"')).toBeLessThan(stale.indexOf("끝난 백그라운드 작업"));
			expect(turnsNav(stale)).toEqual({ count: 0, warn: true });
		});

		test("a stopped job reads ok, folds with the finished ones, warns nothing and leaves after 24 hours", async () => {
			writeJob("halted.json", {
				state: "stopped",
				updatedAt: iso(NOW - MINUTE),
				pid: 9999,
				done: 2800,
				total: 17803,
				detail: "중단: 오너 지시",
			});
			writeJob("old-halted.json", { state: "stopped", updatedAt: iso(NOW - 25 * 60 * MINUTE) });
			const snapshot = await buildSnapshot(deps());
			const jobs = await jobsOf();
			expect(jobs.map((job) => [job.name, job.state, job.health])).toEqual([["halted", "stopped", "ok"]]);
			const html = renderDashboardMain(snapshot, undefined, NOW, { view: "turns" });
			expect(html).toContain(">중단<");
			expect(html).not.toContain(">파일 오류<");
			expect(html).not.toContain('id="jobs"');
			expect(html).toContain("끝난 백그라운드 작업");
			expect(turnsNav(html)).toEqual({ count: 0, warn: false });
			expect(clientRender(snapshot)(snapshot, undefined, NOW, { view: "turns" })).toBe(html);
			expect(renderItemDetail(snapshot, "turns", "job:halted")).toContain("중단 · stopped");
		});

		test("a jobs section that failed shows under its heading and leaves the turn list as it was", async () => {
			writeFileSync(join(home, "jobs"), "not a directory");
			const snapshot = await buildSnapshot(deps());
			const html = renderDashboardMain(snapshot, undefined, NOW, { view: "turns" });
			expect(html).toContain("최근 24시간 턴이 없어요");
			expect(html).toMatch(/백그라운드 작업<\/h2><\/div><div class="notice is-danger">.*읽기 실패/);
			expect(turnsNav(html).warn).toBe(true);
		});
	});
});
