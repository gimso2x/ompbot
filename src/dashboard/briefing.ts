import { redact } from "../redact";
import { formatLocal, localIso, nextLocalMidnight } from "../time";
import { columnFor } from "./board";
import { hostChecksProblems } from "./host-checks";
import { alertText, gateText } from "./html";
import type { DashboardSnapshot, MonitorInfo, Section, TaskInfo, TurnInfo } from "./snapshot";

/** The one-page drawing's column; the same 1080px the page's own layout uses. */
const PAGE_WIDTH = 1080;
/** A section shows at most this many lines; the rest becomes one `외 N개` line. */
const LINES_PER_SECTION = 6;
/** A section's unreadable reason keeps this many characters of the error. */
const ERROR_CHARS = 120;

/**
 * The briefing as one standalone HTML page: inline CSS, no external resource, and a `load` script that writes the
 * document height into `<title>` for the capture stage to read. Every dynamic string is escaped and then redacted, so
 * a token shape in a preview never reaches the image.
 */
export function renderBriefingHtml(snapshot: DashboardSnapshot, now: number): string {
	const attention = attentionLines(snapshot);
	const working = workingLines(snapshot);
	const monitoring = monitorLines(snapshot, now);
	const counts = summaryCounts(snapshot);
	const summary = counts.map(([label, value]) => `${label} ${value}`).join(" · ");
	const body = [
		`<h1>${esc(redact(`ompbot 브리핑 · ${minuteOf(now, snapshot.timezone)}`))}</h1>`,
		`<p class="meta">${esc(redact(daemonLine(snapshot)))}</p>`,
		`<p class="summary${attention.length > 0 ? " warn" : ""}">${esc(redact(summary))}</p>`,
		section("주의", attention, snapshot.gates),
		section("진행 중", working),
		monitorSection(snapshot, monitoring),
		section("바닥", footerLines(snapshot)),
	];
	return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title></title><style>${CSS}</style></head><body style="width:${PAGE_WIDTH}px">${body.join("")}<script>window.addEventListener("load",()=>{document.title=String(document.documentElement.scrollHeight)})</script></body></html>`;
}

/** The one-line comment that rides along with the image: the same numbers as the page's summary. */
export function briefingSummaryLine(snapshot: DashboardSnapshot): string {
	return (
		summaryCounts(snapshot)
			.filter(([, value]) => value > 0)
			.map(([label, value]) => `${label} ${value}`)
			.join(" · ") || "이상 없음"
	);
}

/** The six numbers of the page's summary line, in its order; the image comment shows the non-zero ones. */
function summaryCounts(snapshot: DashboardSnapshot): (readonly [string, number])[] {
	return [
		["주의", attentionLines(snapshot).length],
		["진행 TASK", openTasks(snapshot).length],
		["레인", snapshot.lanes.ok ? snapshot.lanes.items.filter((lane) => lane.status !== "closed").length : 0],
		["승인 대기", snapshot.approvals.ok ? snapshot.approvals.items.length : 0],
		["게이트 열림", openGates(snapshot).length],
		["모니터 실패", failedMonitors(snapshot).length],
	];
}

const CSS = `body{margin:0;padding:28px 32px;background:#f7f7f5;color:#1d1d1b;font-family:"NanumBarunGothic","NanumGothic",sans-serif;font-size:15px;line-height:1.5}
h1{font-size:24px;margin:0 0 6px;font-weight:700}
.meta{margin:0 0 12px;color:#5b5b57;font-size:14px}
.summary{margin:0 0 20px;padding:10px 14px;border-radius:8px;background:#eceae4;font-size:16px;font-weight:700}
.summary.warn{background:#fdecea;color:#a32216}
section{margin:0 0 18px}
h2{font-size:16px;margin:0 0 6px;padding-bottom:4px;border-bottom:1px solid #d8d5cd;font-weight:700}
ul{margin:0;padding-left:18px}
li{margin:2px 0;word-break:break-word}
.more{color:#5b5b57;list-style:none;margin-left:-18px}
.unread{color:#a32216}
.empty{color:#7a7a75}
footer{margin-top:18px;padding-top:10px;border-top:1px solid #d8d5cd;color:#5b5b57;font-size:13px}`;

/** One section: its lines, or the reason the section could not be read; always capped with `외 N개`. */
function section(title: string, lines: string[], source?: Section<unknown>): string {
	if (source !== undefined && !source.ok) return unreadableSection(title, source.error);
	if (lines.length === 0) return `<section><h2>${esc(title)}</h2><p class="empty">없음</p></section>`;
	return `<section><h2>${esc(title)}</h2><ul>${cappedItems(lines)}</ul></section>`;
}

/** A section that could not be read: the section stays in place with its reason, cut to one short line. */
function unreadableSection(title: string, error: string): string {
	const reason = redact(error).slice(0, ERROR_CHARS);
	return `<section><h2>${esc(title)}</h2><p class="unread">${esc(`읽지 못함: ${reason}`)}</p></section>`;
}

/** Up to {@link LINES_PER_SECTION} lines, then one `외 N개` line for the rest. */
function cappedItems(lines: string[]): string {
	const shown = lines.slice(0, LINES_PER_SECTION);
	const rest = lines.length - shown.length;
	const items = shown.map((line) => `<li>${line}</li>`);
	if (rest > 0) items.push(`<li class="more">외 ${rest}개</li>`);
	return items.join("");
}

/**
 * The monitor section: today's remaining runs under the line cap, then every failing monitor after it — a failure is
 * why the owner opens the picture, so the cap never hides one.
 */
function monitorSection(snapshot: DashboardSnapshot, upcoming: string[]): string {
	if (!snapshot.monitors.ok) return unreadableSection("모니터", snapshot.monitors.error);
	const failures = failedMonitors(snapshot).map(
		(monitor) => `실패 ${esc(redact(monitor.name))} · ${monitor.failStreak}회`,
	);
	const items = cappedItems(upcoming);
	if (items === "" && failures.length === 0) return section("모니터", []);
	const all = `${items}${failures.map((line) => `<li>${line}</li>`).join("")}`;
	return `<section><h2>모니터</h2><ul>${all}</ul></section>`;
}

/** Everything that wants the owner: open gates, alerts, waiting approvals, stalled turns, blocked TASKs. */
function attentionLines(snapshot: DashboardSnapshot): string[] {
	const lines: string[] = [];
	for (const gate of openGates(snapshot)) lines.push(`게이트 ${esc(redact(gate.name))}`);
	if (snapshot.alerts.ok) {
		for (const alert of snapshot.alerts.items) {
			const text = alertText(alert.scope);
			lines.push(`알림 ${esc(redact(text.title))}${alert.count > 1 ? ` ×${alert.count}` : ""}`);
		}
	}
	if (snapshot.approvals.ok) {
		for (const approval of snapshot.approvals.items) lines.push(`승인 대기 ${esc(redact(approval.title))}`);
	}
	if (snapshot.turns.ok) {
		for (const turn of snapshot.turns.items) {
			if (turn.stalled) lines.push(`턴 ${turn.inboundId} 정체`);
			else if (turn.state === "pending" && turn.blocksRestart) lines.push(`턴 ${turn.inboundId} 재시작 대기`);
		}
		for (const thread of snapshot.turns.threads) {
			if (thread.column !== "attention") continue;
			lines.push(`스레드 ${esc(redact(threadTitle(thread)))}`);
		}
	}
	for (const task of openTasks(snapshot)) {
		if (task.status !== "blocked" && task.error === undefined) continue;
		lines.push(`TASK ${esc(redact(`${task.taskId} ${task.title}`))} · ${esc(redact(task.status))}`);
	}
	// Last, so the bot's own lines above keep their places under the line cap; counts only, never a check's words.
	const hosts = snapshot.hostChecks;
	if (hosts !== undefined && !hosts.ok) {
		lines.push(esc(`호스트 점검 읽지 못함: ${redact(hosts.error).slice(0, ERROR_CHARS)}`));
	} else if (hosts !== undefined) {
		const problems = hostChecksProblems(hosts);
		if (problems.total > 0) lines.push(`호스트 점검 이상 ${problems.total}건(alert ${problems.alert})`);
	}
	return lines;
}

/** What is moving: open TASKs with their step, lanes, herdr agents that work or wait. */
function workingLines(snapshot: DashboardSnapshot): string[] {
	const lines: string[] = [];
	for (const task of openTasks(snapshot)) {
		if (task.status === "blocked") continue;
		const step = task.progress?.current?.trim();
		lines.push(
			`TASK ${esc(redact(`${task.taskId} ${task.title}`))} · ${esc(redact(task.status))}${step ? ` · ${esc(redact(step))}` : ""}`,
		);
	}
	if (snapshot.lanes.ok) {
		for (const lane of snapshot.lanes.items) {
			if (lane.status === "closed") continue;
			lines.push(`레인 ${esc(redact(`${lane.name} ${lane.title}`))} · ${esc(redact(lane.status))}`);
		}
	}
	if (snapshot.herdr.ok) {
		for (const host of snapshot.herdr.hosts) {
			if (!host.ok) continue;
			for (const agent of host.agents) {
				const column = columnFor(agent.agentStatus).column;
				if (column !== "working" && column !== "attention") continue;
				const state = column === "working" ? "작업 중" : "막힘";
				lines.push(`herdr ${esc(redact(host.host))} · ${esc(redact(agent.name))} ${state}`);
			}
		}
	}
	return lines;
}

/** The monitors that still fire today and the ones failing now; a failure is never cut by the line cap. */
function monitorLines(snapshot: DashboardSnapshot, now: number): string[] {
	if (!snapshot.monitors.ok) return [];
	const lines: string[] = [];
	// The snapshot's zone (`config.timezone`) says where "today" ends.
	const endOfDay = nextLocalMidnight(now, snapshot.timezone);
	for (const monitor of snapshot.monitors.items) {
		// A failing monitor is its own line below; listing it twice would spend the cap on the same name.
		if (monitor.failStreak > 0) continue;
		const next = monitor.nextFireAt === null ? undefined : Date.parse(monitor.nextFireAt);
		if (next === undefined || Number.isNaN(next) || next >= endOfDay) continue;
		lines.push(esc(redact(`${monitor.name} · ${minuteOf(next, snapshot.timezone)}`)));
	}
	return lines;
}

/** The gates the page paints as open (`state === "open"`); `unknown` is not a warning there, so it is not one here. */
function openGates(snapshot: DashboardSnapshot) {
	if (!snapshot.gates.ok) return [];
	return snapshot.gates.items.filter((gate) => gate.state === "open");
}

function failedMonitors(snapshot: DashboardSnapshot): MonitorInfo[] {
	if (!snapshot.monitors.ok) return [];
	return snapshot.monitors.items.filter((monitor) => monitor.failStreak > 0);
}

function openTasks(snapshot: DashboardSnapshot): TaskInfo[] {
	if (!snapshot.tasks.ok) return [];
	return snapshot.tasks.items.filter((task) => task.open);
}

function daemonLine(snapshot: DashboardSnapshot): string {
	if (!snapshot.daemon.ok) return `데몬 상태 읽지 못함: ${redact(snapshot.daemon.error).slice(0, ERROR_CHARS)}`;
	const daemon = snapshot.daemon;
	const parts = [daemon.running ? "데몬 실행 중" : "데몬 정지"];
	if (daemon.commit !== undefined) parts.push(daemon.commit);
	if (daemon.started !== undefined) parts.push(`${duration(daemon.started.ageMs)}째`);
	return parts.join(" · ");
}

function footerLines(snapshot: DashboardSnapshot): string[] {
	const parts: string[] = [];
	if (snapshot.backup.ok && snapshot.backup.local !== undefined) {
		parts.push(
			`백업 ${minuteOf(Date.parse(snapshot.backup.local.at), snapshot.timezone)} (${coarseAge(snapshot.backup.local.ageMs)} 전)`,
		);
	} else if (!snapshot.backup.ok) {
		parts.push("백업 기록 읽지 못함");
	} else {
		parts.push("백업 기록 없음");
	}
	const generated = Date.parse(snapshot.generatedAt);
	parts.push(`기준 ${Number.isNaN(generated) ? redact(snapshot.generatedAt) : minuteOf(generated, snapshot.timezone)}`);
	return parts.map((line) => esc(redact(line)));
}

function threadTitle(thread: { originKey: string; threadRef: string | null }): string {
	return thread.threadRef ?? thread.originKey;
}

/** `YYYYMMDD-HHmmss` in the bot's zone (`config.timezone`): the file-name stamp of the rendered picture. */
export function briefingFileName(ms: number, timezone: string): string {
	const iso = localIso(ms, timezone);
	return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
}

/** `YYYY-MM-DD HH:mm` in the zone. */
function minuteOf(ms: number, timezone: string): string {
	return formatLocal(ms, timezone).slice(0, 16);
}

/** A stamp's age in whole units: `3시간 전` reads better than `3시간 30분 전` in the footer. */
function coarseAge(ms: number): string {
	const minutes = Math.floor(Math.max(0, ms) / 60_000);
	if (minutes < 60) return `${minutes}분`;
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}시간` : `${Math.floor(hours / 24)}일`;
}

function duration(ms: number): string {
	const minutes = Math.floor(Math.max(0, ms) / 60_000);
	if (minutes < 60) return `${minutes}분`;
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}시간 ${minutes % 60}분` : `${Math.floor(hours / 24)}일 ${hours % 24}시간`;
}

function esc(text: string): string {
	return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export { gateText, type TurnInfo };
