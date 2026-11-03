import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMonitorSpec } from "../src/monitors/spec";

const PKG = join(import.meta.dir, "..", "examples", "monitors", "weekly-improvement");
const COLLECT = join(PKG, "collect.py");
const MEETING = join(PKG, "meeting.py");
const NOW = "2026-11-08T06:00:00+09:00";
const SECTIONS = ["## 소스 상태", "## 자체회고", "## 모니터 실행", "## TASK", "## 경고 이벤트", "## 지난 회의"];

const dirs: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function py(args: string[]): { code: number; out: string; err: string } {
	const run = Bun.spawnSync(["python3", ...args], { stdout: "pipe", stderr: "pipe" });
	return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const kst = (local: string): number => Date.parse(`${local}+09:00`);

function reflection(marker: string): string {
	return [
		`# ${marker}`,
		"",
		"## 어제 다음 행동 추적",
		`- 추적-${marker}`,
		"",
		"## 문제",
		`1. 문제-${marker}`,
		"",
		"## 다음 행동",
		`- 행동-${marker}`,
		"",
		"## 오너 알림 판정",
		`- 판정-${marker}`,
		"",
	].join("\n");
}

const HEADER = "| ID | 제목 | 근거 | 제안 | 검토 | 결정 | TASK |\n|---|---|---|---|---|---|---|";

function meetingDoc(week: string, rows: string[]): string {
	return [
		`# 주간 개선 회의 ${week}`,
		"기간: 2026-11-02 ~ 2026-11-08 (KST)",
		"제안자: anthropic/claude-opus-5-5 · 검토자: google-antigravity/gemini-4-argon",
		"",
		"## 안건",
		HEADER,
		...rows,
		"",
	].join("\n");
}

function row(
	id: string,
	cells: Partial<Record<"title" | "evidence" | "proposal" | "review" | "decision" | "task", string>> = {},
) {
	const c = {
		title: `제목-${id}`,
		evidence: "429 재발 (자체회고 2026-11-02)",
		proposal: "config.yml 폴백 추가",
		review: "동의: 근거 충분",
		decision: "대기",
		task: "-",
		...cells,
	};
	return `| ${id} | ${c.title} | ${c.evidence} | ${c.proposal} | ${c.review} | ${c.decision} | ${c.task} |`;
}

/** A full fixture home: 5 of 7 reflections, in- and out-of-window DB rows and log lines, two past meetings. */
function fixtureHome(): string {
	const home = tempDir("weekly-improvement-home-");
	const reflections = join(home, "workspace", "reflections");
	mkdirSync(reflections, { recursive: true });
	for (const day of ["2026-11-01", "2026-11-02", "2026-11-04", "2026-11-06", "2026-11-07"]) {
		writeFileSync(join(reflections, `${day}.md`), reflection(`회고${day}`));
	}
	writeFileSync(join(reflections, "2026-10-31.md"), reflection("창밖회고"));
	writeFileSync(join(reflections, "2026-11-08.md"), reflection("창밖오늘회고"));

	const db = new Database(join(home, "ompbot.db"));
	db.run(`CREATE TABLE monitors (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE)`);
	db.run(`CREATE TABLE monitor_events (event_id INTEGER PRIMARY KEY AUTOINCREMENT, monitor_id TEXT NOT NULL,
		stage TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL)`);
	db.run(`CREATE TABLE tasks (task_id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL,
		created_at INTEGER NOT NULL, closed_at INTEGER)`);
	db.run(`INSERT INTO monitors VALUES ('m1','자체회고'),('m2','아침 브리핑'),('m3','창밖모니터')`);
	const event = db.prepare("INSERT INTO monitor_events (monitor_id, stage, error, created_at) VALUES (?,?,?,?)");
	event.run("m1", "delivered", null, kst("2026-11-01T23:30:00"));
	event.run("m1", "delivered", null, kst("2026-11-02T23:30:00"));
	event.run("m1", "failed", "429 Weekly Limit Exhausted\nstack line", kst("2026-11-03T23:30:00"));
	event.run("m1", "failed_no_retry", "stall_abort", kst("2026-11-04T23:30:00"));
	event.run("m2", "delivered", null, kst("2026-11-07T08:00:00"));
	event.run("m2", "failed", "창밖에러", kst("2026-10-31T08:00:00"));
	event.run("m2", "failed", "창밖에러끝", kst("2026-11-08T06:00:00"));
	event.run("m3", "failed", "창밖에러3", kst("2026-10-20T08:00:00"));
	const task = db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?)");
	task.run("T-20261101-01", "열린작업", "working", kst("2026-11-01T10:00:00"), null);
	task.run("T-20261020-01", "검토작업", "review", kst("2026-10-20T10:00:00"), null);
	task.run("T-20261102-01", "끝난작업", "done", kst("2026-11-02T10:00:00"), kst("2026-11-03T10:00:00"));
	task.run("T-20261103-01", "취소작업", "cancelled", kst("2026-11-03T10:00:00"), kst("2026-11-04T10:00:00"));
	task.run("T-20261010-01", "창밖종료작업", "done", kst("2026-10-10T10:00:00"), kst("2026-10-15T10:00:00"));
	db.close();

	const logs = join(home, "logs");
	mkdirSync(logs);
	writeFileSync(
		join(logs, "ompbot.log"),
		[
			"ts=2026-10-31T20:59:59.000Z level=warn event=old_out_of_window",
			"ts=2026-10-31T21:00:00.000Z level=warn event=slack_socket_reconnecting reason=x",
			"ts=2026-11-03T01:00:00.000Z level=warn event=slack_socket_reconnecting reason=y",
			"ts=2026-11-04T01:00:00.000Z level=error event=turn_failed reason=z",
			"ts=2026-11-04T02:00:00.000Z level=info event=info_only_event",
			"not a logfmt line",
			"ts=2026-11-07T21:00:00.000Z level=error event=new_out_of_window",
			"",
		].join("\n"),
	);

	const meetings = join(home, "workspace", "meetings");
	mkdirSync(meetings);
	writeFileSync(
		join(meetings, "2026-W43.md"),
		meetingDoc("2026-W43", [
			row("P-2026W43-1", { title: "대기안건" }),
			row("P-2026W43-2", { title: "보류안건", decision: "보류" }),
		]),
	);
	writeFileSync(
		join(meetings, "2026-W44.md"),
		meetingDoc("2026-W44", [
			row("P-2026W44-1", { title: "채택무태스크", decision: "채택" }),
			row("P-2026W44-2", { title: "기각안건", decision: "기각" }),
			row("P-2026W44-3", { title: "채택유태스크", decision: "채택", task: "T-20261101-01" }),
		]),
	);
	return home;
}

describe("weekly-improvement collect.py", () => {
	test("AC-1: six sections in order, window-only data, missing dates, open past agenda", () => {
		const home = fixtureHome();
		const run = py([COLLECT, "--home", home, "--now", NOW]);
		expect(run.err).toBe("");
		expect(run.code).toBe(0);
		const out = run.out;

		const positions = SECTIONS.map((heading) => out.split("\n").indexOf(heading));
		expect(positions.every((at) => at >= 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);

		const status = out.slice(out.indexOf("## 소스 상태"), out.indexOf("## 자체회고"));
		expect(status).toContain("reflections: ok (5/7일, 누락 2026-11-03, 2026-11-05)");
		for (const source of ["db: ok", "log: ok", "meetings: ok"]) expect(status).toContain(source);

		expect(out).toContain("### 2026-11-01");
		expect(out).toContain("문제-회고2026-11-01");
		expect(out).toContain("행동-회고2026-11-07");
		expect(out).not.toContain("추적-회고2026-11-01");
		expect(out).not.toContain("판정-회고2026-11-01");

		expect(out).toContain("자체회고: delivered 2 · failed 1 · failed_no_retry 1");
		expect(out).toContain("429 Weekly Limit Exhausted");
		expect(out).not.toContain("stack line");
		expect(out).toContain("아침 브리핑: delivered 1");

		expect(out).toContain("T-20261101-01 working 열린작업 (경과 6일)");
		expect(out).toContain("T-20261020-01 review 검토작업 (경과 18일)");
		expect(out).toContain("done 1 · cancelled 1");

		expect(out).toContain("slack_socket_reconnecting 2");
		expect(out).toContain("turn_failed 1");
		expect(out).not.toContain("info_only_event");

		const past = out.slice(out.indexOf("## 지난 회의"));
		expect(past).toContain("P-2026W44-1 채택무태스크 채택 (2026-W44.md)");
		expect(past).toContain("P-2026W43-1 대기안건 대기 (2026-W43.md)");
		expect(past).toContain("P-2026W43-2 보류안건 보류 (2026-W43.md)");
		expect(past).toContain("P-2026W44-3 채택유태스크 채택 (2026-W44.md)");
		expect(past).toContain("T-20261101-01 working");
		expect(past).not.toContain("기각안건");

		for (const outside of [
			"창밖회고",
			"창밖오늘회고",
			"### 2026-10-31",
			"창밖에러",
			"창밖모니터",
			"창밖종료작업",
			"old_out_of_window",
			"new_out_of_window",
		]) {
			expect(out).not.toContain(outside);
		}
	});

	test("AC-2: DB untouched (sha256, no -wal/-journal); missing DB and reflections still exit 0", () => {
		const home = fixtureHome();
		const dbPath = join(home, "ompbot.db");
		const before = sha256(dbPath);
		const run = py([COLLECT, "--home", home, "--now", NOW]);
		expect(run.code).toBe(0);
		expect(sha256(dbPath)).toBe(before);
		for (const suffix of ["-wal", "-journal", "-shm"]) expect(existsSync(dbPath + suffix)).toBe(false);

		const empty = tempDir("weekly-improvement-empty-");
		const bare = py([COLLECT, "--home", empty, "--now", NOW]);
		expect(bare.code).toBe(0);
		expect(bare.out).toContain("## 소스 상태");
		for (const source of ["reflections: missing", "db: missing", "log: missing", "meetings: missing"]) {
			expect(bare.out).toContain(source);
		}
		expect(existsSync(join(empty, "ompbot.db"))).toBe(false);
	});

	test("argument errors exit 2", () => {
		for (const args of [
			["--now", "not-a-time"],
			["--days", "0"],
		]) {
			const run = py([COLLECT, ...args]);
			expect(run.code).toBe(2);
			expect(run.err).toContain("usage:");
		}
	});
});

describe("weekly-improvement meeting.py check", () => {
	const dir = tempDir("weekly-improvement-check-");
	const check = (name: string, text: string) => {
		const path = join(dir, name);
		writeFileSync(path, text);
		return py([MEETING, "check", path]);
	};

	test("AC-3: a valid minutes file and a no-agenda file pass", () => {
		const ok = check(
			"ok.md",
			meetingDoc("2026-W45", [
				row("P-2026W45-1"),
				row("P-2026W45-2", { evidence: "반복 (모니터 자체회고) (TASK T-20261027-02)", review: "수정: 범위 축소" }),
				row("P-2026W45-3", { evidence: "x (로그 event=turn_failed)", review: "반대: 근거 약함", decision: "채택" }),
				row("P-2026W45-4", { evidence: "x (회의 2026-W44)", review: "검토 실패: 시간 초과", task: "T-20261108-01" }),
				row("P-2026W45-5", { decision: "보류" }),
			]),
		);
		expect(ok.err).toBe("");
		expect(ok.code).toBe(0);
		const none = check(
			"none.md",
			"# 주간 개선 회의 2026-W45\n기간: 2026-11-02 ~ 2026-11-08 (KST)\n제안자: a/b · 검토자: c/d\n\n## 안건\n안건 없음\n",
		);
		expect(none.err).toBe("");
		expect(none.code).toBe(0);
	});

	const violations: Array<[string, string]> = [
		["bad-id", meetingDoc("2026-W45", [row("P-2026W45-6")])],
		["bad-id-shape", meetingDoc("2026-W45", [row("X-2026W45-1")])],
		["week-mismatch", meetingDoc("2026-W45", [row("P-2026W44-1")])],
		["decision", meetingDoc("2026-W45", [row("P-2026W45-1", { decision: "승인" })])],
		["no-tag", meetingDoc("2026-W45", [row("P-2026W45-1", { evidence: "그냥 느낌" })])],
		[
			"six-rows",
			meetingDoc(
				"2026-W45",
				[1, 2, 3, 4, 5, 5].map((n) => row(`P-2026W45-${n}`)),
			),
		],
		["pipe-in-cell", meetingDoc("2026-W45", [row("P-2026W45-1", { proposal: "a | b" })])],
		["review-prefix", meetingDoc("2026-W45", [row("P-2026W45-1", { review: "좋음" })])],
		["task-shape", meetingDoc("2026-W45", [row("P-2026W45-1", { task: "T-1" })])],
		["duplicate-id", meetingDoc("2026-W45", [row("P-2026W45-1"), row("P-2026W45-1")])],
		["no-title", meetingDoc("2026-W45", [row("P-2026W45-1")]).replace("# 주간 개선 회의 2026-W45", "# 회의")],
	];
	for (const [name, text] of violations) {
		test(`AC-3: violation ${name} exits 2 with a line-numbered message`, () => {
			const run = check(`${name}.md`, text);
			expect(run.code).toBe(2);
			expect(run.err).toMatch(/^줄 \d+: \S/m);
		});
	}
});

describe("weekly-improvement meeting.py decide", () => {
	const fresh = () => {
		const path = join(tempDir("weekly-improvement-decide-"), "2026-W45.md");
		writeFileSync(
			path,
			meetingDoc("2026-W45", [
				row("P-2026W45-1"),
				row("P-2026W45-2", { decision: "기각" }),
				row("P-2026W45-3", { decision: "보류" }),
			]),
		);
		return path;
	};
	const cells = (path: string, id: string) =>
		readFileSync(path, "utf8")
			.split("\n")
			.find((line) => line.startsWith(`| ${id} `))
			?.split("|")
			.map((cell) => cell.trim())
			.slice(1, -1);

	test("AC-4: 대기→채택 and --task are written, result still passes check", () => {
		const path = fresh();
		const adopt = py([MEETING, "decide", path, "P-2026W45-1=채택", "P-2026W45-3=기각"]);
		expect(adopt.err).toBe("");
		expect(adopt.code).toBe(0);
		expect(adopt.out.trim()).toBe("2");
		expect(cells(path, "P-2026W45-1")?.[5]).toBe("채택");
		expect(cells(path, "P-2026W45-3")?.[5]).toBe("기각");

		const linked = py([MEETING, "decide", path, "--task", "P-2026W45-1=T-20261108-01"]);
		expect(linked.code).toBe(0);
		expect(linked.out.trim()).toBe("1");
		expect(cells(path, "P-2026W45-1")?.slice(5)).toEqual(["채택", "T-20261108-01"]);
		expect(py([MEETING, "check", path]).code).toBe(0);
	});

	test("AC-4: decision and task in one call", () => {
		const path = fresh();
		const run = py([MEETING, "decide", path, "P-2026W45-1=채택", "--task", "P-2026W45-1=T-20261108-02"]);
		expect(run.code).toBe(0);
		expect(cells(path, "P-2026W45-1")?.slice(5)).toEqual(["채택", "T-20261108-02"]);
	});

	const rejected: Array<[string, string[]]> = [
		["unknown id", ["P-2026W45-9=채택"]],
		["기각→채택", ["P-2026W45-2=채택"]],
		["bad task shape", ["P-2026W45-1=채택", "--task", "P-2026W45-1=T-123"]],
		["task on a non-adopted row", ["--task", "P-2026W45-3=T-20261108-01"]],
		["bad decision value", ["P-2026W45-1=승인"]],
		["no change requested", []],
	];
	for (const [name, args] of rejected) {
		test(`AC-4: ${name} exits 2 and leaves the file byte-identical`, () => {
			const path = fresh();
			const before = sha256(path);
			const run = py([MEETING, "decide", path, ...args]);
			expect(run.code).toBe(2);
			expect(run.err).toMatch(/^(오류|줄 \d+): \S/m);
			expect(sha256(path)).toBe(before);
		});
	}
});

describe("weekly-improvement monitor.json", () => {
	test("AC-5: with @OMPBOT_HOME@ replaced by a temp home it parses; Sunday 06:00 KST cron, opus, one procedure file", () => {
		const home = tempDir("weekly-improvement-install-");
		const scriptsRoot = join(home, "scripts");
		mkdirSync(scriptsRoot);
		const installed = join(scriptsRoot, "weekly-improvement-procedure.md");
		copyFileSync(join(PKG, "procedure.md"), installed);
		const template = readFileSync(join(PKG, "monitor.json"), "utf8");
		expect(JSON.parse(template).procedureFiles).toEqual(["@OMPBOT_HOME@/scripts/weekly-improvement-procedure.md"]);
		const raw = JSON.parse(template.replaceAll("@OMPBOT_HOME@", home));
		expect(raw.procedureFiles).toEqual([installed]);
		const spec = parseMonitorSpec(raw, { scriptsRoot });
		expect(spec.trigger).toEqual({ kind: "cron", schedule: "0 6 * * 0", timezone: "Asia/Seoul" });
		expect(spec.model).toBe("anthropic/claude-opus-5-5");
		expect(spec.procedureFiles).toHaveLength(1);
		expect("channel" in spec).toBe(false);
	});

	test("procedure.md names installed paths only through @OMPBOT_HOME@", () => {
		const procedure = readFileSync(join(PKG, "procedure.md"), "utf8");
		expect(procedure).toContain("python3 @OMPBOT_HOME@/scripts/weekly-improvement-collect.py");
		expect(procedure).toContain("python3 @OMPBOT_HOME@/scripts/weekly-improvement-meeting.py check");
		expect(procedure).not.toMatch(/\/home\//);
	});
});
