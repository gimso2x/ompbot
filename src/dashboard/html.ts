import {
	BACKUP_MAX_AGE_MS,
	DELIVERY_OVERDUE_MS,
	INBOUND_STARVATION_MS,
	LANE_STUCK_MS,
	MONITOR_FAILURE_WINDOW_MS,
	MONITOR_OVERDUE_MS,
	ORIGIN_SILENT_MS,
	SOCKET_DOWN_MS,
	SWEEP_STALLED_MS,
	TURNS_FAILING_THRESHOLD,
	TURNS_FAILING_WINDOW_MS,
} from "../ops/gates";
import type { BoardCard, BoardPanel } from "./board";
import { renderMarkdown } from "./markdown";
import type { MonitorDetailRun, MonitorProcedure } from "./monitor-detail";
import type {
	DashboardSnapshot,
	FlowChainInfo,
	JobHealth,
	JobInfo,
	JobState,
	MonitorInfo,
	TaskInfo,
	TurnKind,
	TurnWaitReason,
} from "./snapshot";
import { STYLE } from "./style";
import { TRACE_CLIENT } from "./trace-client";
import { renderTrace } from "./trace-view";

/** The gate thresholds the screens put into words; shipped to the page as JSON next to the renderers. */
const GATE_LIMITS = {
	backupMaxAgeMs: BACKUP_MAX_AGE_MS,
	sweepStalledMs: SWEEP_STALLED_MS,
	socketDownMs: SOCKET_DOWN_MS,
	inboundStarvationMs: INBOUND_STARVATION_MS,
	originSilentMs: ORIGIN_SILENT_MS,
	deliveryOverdueMs: DELIVERY_OVERDUE_MS,
	laneStuckMs: LANE_STUCK_MS,
	monitorFailureWindowMs: MONITOR_FAILURE_WINDOW_MS,
	monitorOverdueMs: MONITOR_OVERDUE_MS,
	turnsFailingWindowMs: TURNS_FAILING_WINDOW_MS,
	turnsFailingThreshold: TURNS_FAILING_THRESHOLD,
};

/** Words for a turn's kind and wait reason (turn view and its detail); shipped to the page like `GATE_LIMITS`. */
const TURN_LABELS: { kind: Record<TurnKind, string>; wait: Record<TurnWaitReason, string> } = {
	kind: { message: "대화", command: "명령", auto: "자동 후속", monitor: "모니터" },
	wait: {
		restart: "재시작 대기",
		frozen: "동결 중",
		followup: "팔로업 대기",
		behind: "앞 턴 대기",
		queued: "전달 대기",
	},
};

/**
 * A background job's badge word and tone: its `health`, with `ok` told apart by `state` (running, done or stopped). Shipped to
 * the page like `TURN_LABELS`.
 */
const JOB_LABELS: Record<Exclude<JobHealth, "ok"> | Exclude<JobState, "failed">, [string, string]> = {
	running: ["진행 중", "is-info"],
	done: ["완료", "is-success"],
	stopped: ["중단", ""],
	failed: ["실패", "is-danger"],
	dead: ["멈춤(프로세스 없음)", "is-danger"],
	stale: ["갱신 끊김", "is-warning"],
	invalid: ["파일 오류", "is-warning"],
};

/** A monitor event stage's word and dot tone (list and panel). Shipped to the page like `TURN_LABELS`. */
const MONITOR_STAGES: Record<string, [string, string]> = {
	delivered: ["전달", "is-ok"],
	no_report: ["조용히 끝남", "is-quiet"],
	failed: ["실패", "is-fail"],
	failed_no_retry: ["실패", "is-fail"],
	admitted: ["대기", "is-run"],
	dispatched: ["진행 중", "is-run"],
	authored: ["작성됨", "is-run"],
	skipped: ["건너뜀", "is-skip"],
};

/** A settled approval's word and badge tone (list and panel). Shipped to the page like `TURN_LABELS`. */
const APPROVAL_OUTCOMES: Record<string, [string, string]> = {
	approved: ["승인", "is-success"],
	denied: ["거절", "is-danger"],
	expired: ["만료", "is-warning"],
	replied: ["답장", "is-info"],
};

/** A monitor run's slot-to-settle time: `52초`, `5분 52초`, `6시간 15분`. Shipped to the page. */
function monitorTook(ms: number): string {
	const seconds = Math.floor(Math.max(0, ms) / 1000);
	if (seconds < 60) return `${seconds}초`;
	const minutes = Math.floor(seconds / 60);
	return minutes < 60 ? `${minutes}분 ${seconds % 60}초` : `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

/**
 * A health gate in words: the owner-facing name, its numbers taken from the gate constants, and the one thing to do
 * (backticks mark commands). A gate not listed keeps its own name. Self-contained apart from `GATE_LIMITS` (both are
 * shipped to the page).
 */
export function gateText(name: string): { label: string; todo: string } {
	const limits = GATE_LIMITS;
	const span = (ms: number): string =>
		ms % 3_600_000 === 0
			? `${ms / 3_600_000}시간`
			: ms % 60_000 === 0
				? `${ms / 60_000}분`
				: `${Math.round(ms / 1000)}초`;
	const TEXT: Record<string, [string, string]> = {
		turns_failing: [
			`최근 ${span(limits.turnsFailingWindowMs)} 턴 실패가 ${limits.turnsFailingThreshold}회 이상`,
			"최근 `turn_failed` 사유를 로그에서 확인",
		],
		lanes_stuck: [`레인이 ${span(limits.laneStuckMs)} 넘게 멈춤`, "멈춘 레인 스레드에서 이어 가거나 닫기"],
		backup_age: [`백업이 ${span(limits.backupMaxAgeMs)} 넘게 없음`, "백업 타이머·`ompbot backup` 확인"],
		offsite_age: [
			`오프사이트 백업이 ${span(limits.backupMaxAgeMs)} 넘게 없음`,
			"오프사이트 접속·`ompbot offsite` 확인",
		],
		sweep_stalled: [
			`스윕 하트비트가 ${span(limits.sweepStalledMs)} 넘게 멈춤`,
			"`systemctl --user status ompbot`으로 데몬 확인",
		],
		slack_disconnected: [`Slack 소켓이 ${span(limits.socketDownMs)} 넘게 끊김`, "네트워크·Slack 토큰과 데몬 로그 확인"],
		inbound_starved: [`턴이 ${span(limits.inboundStarvationMs)} 넘게 응답 없음`, "`ompbot status`로 멈춘 턴 확인"],
		origin_silent: [`받은 메시지가 ${span(limits.originSilentMs)} 넘게 대기`, "`ompbot status`로 대기 중인 대화 확인"],
		deliveries_overdue: [
			`Slack 전달이 ${span(limits.deliveryOverdueMs)} 넘게 밀림`,
			"데몬 로그에서 전달 실패 사유 확인",
		],
		monitors_failed: [
			`최근 ${span(limits.monitorFailureWindowMs)} 안에 모니터 실패`,
			"`ompbot monitors list`로 실패한 모니터 확인",
		],
		monitors_stalled: [`모니터 실행이 ${span(limits.monitorOverdueMs)} 넘게 밀림`, "모니터 실행·drain 상태 확인"],
		omp_runtime: ["omp 실행 환경 이상", "`omp --version`·`bun --version` 확인"],
		frozen: ["동결 켜짐", "동결 사유 확인 뒤 `ompbot unfreeze`"],
		ledger_unreadable: ["장부(DB)를 읽지 못함", "DB 파일 권한·디스크 확인"],
	};
	const known = TEXT[name];
	return known === undefined ? { label: name, todo: "`ompbot gates` 확인" } : { label: known[0], todo: known[1] };
}

/** An alert row in words: its title, the thing to do and, for `gate:` rows, the gate. Shipped to the page. */
export function alertText(scope: string): { title: string; todo: string; gate?: string } {
	const cut = scope.indexOf(":");
	const kind = cut < 0 ? scope : scope.slice(0, cut);
	const rest = scope.slice(cut + 1);
	if (kind === "gate") {
		const text = gateText(rest);
		return { title: text.label, todo: text.todo, gate: rest };
	}
	if (kind === "turns")
		return { title: `대화 턴 연속 실패 · ${rest}`, todo: "최근 `turn_failed` 사유를 로그에서 확인" };
	if (kind === "dispatch") return { title: `턴 전달 실패 · ${rest}`, todo: "데몬 로그에서 전달 재시도 실패 사유 확인" };
	if (scope === "provider:limit") return { title: "모델 공급자 사용 한도", todo: "공급자 사용량·한도 확인" };
	return { title: scope, todo: "`ompbot gates` 확인" };
}

/** What the page is showing besides the data: the chosen view, the search text, the list order, the open entry and theme. */
export interface DashboardUi {
	/** `?view=`: inbox (default), list, turns, lanes, approvals, monitors, alerts, system; anything else = inbox + notice. */
	view?: string;
	/** Search text, matched against titles, TASK IDs and machine names. */
	q?: string;
	/** List column the List view is sorted by (state, title, machine, task, ac, age); default 확인 필요 → 진행 중 → 완료·대기. */
	sort?: string;
	desc?: boolean;
	/** `data-row` of the entry open in the detail panel (card key, TASK ID or row id): drawn as selected. */
	selected?: string;
	/** Theme preference: system (default), light or dark. */
	theme?: string;
	/** `?layout=list` of the turns view: its threads as one table instead of the three columns. */
	layout?: string;
}

/**
 * The redrawn part of the page for one snapshot: the top bar, the side navigation and the chosen view. Self-contained
 * on purpose — no imports, and the only module-level helpers are `gateText`/`alertText`/`GATE_LIMITS`/`TURN_LABELS`/
 * `JOB_LABELS`/`MONITOR_STAGES`/`APPROVAL_OUTCOMES`/`monitorTook`,
 * which the page ships next to it: the page ships this very function's source as its inline script, so the server's
 * first render and every client redraw are the same code. Every free string goes through `esc`.
 *
 * Inline 16x16 SVG line icons are hand-crafted for ompbot (MIT, no external requests).
 *
 * Badge colours carry one meaning each: is-success done/healthy · is-info in progress · is-warning someone has to
 * look (blocked, stalled, open gate, frozen, waiting on the owner) · is-danger failed/down/gone · grey idle/waiting.
 * Every status pill pairs an icon shape with its word so status is never conveyed by colour alone.
 */
/**
 * A thread's open turns in words: inbound rows steered into one omp run are that run's merged messages, not a queue.
 * Empty for no open turn.
 */
export function openTurnsText(thread: { openCount: number; runCount: number; pendingCount: number }): string {
	const sent = thread.openCount - thread.pendingCount;
	const parts = [
		...(thread.runCount === 0 ? [] : [`실행 ${thread.runCount}`]),
		...(sent > thread.runCount ? [`합쳐진 메시지 ${sent}`] : []),
		...(thread.pendingCount === 0 ? [] : [`대기 ${thread.pendingCount}`]),
	];
	return parts.join(" · ");
}

export function renderDashboardMain(
	s: DashboardSnapshot,
	board?: BoardPanel,
	now?: number,
	ui: DashboardUi = {},
): string {
	const esc = (value: unknown): string =>
		String(value ?? "")
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	/** `2026-11-04T09:02:53+09:00` → `11-04 09:02` (times arrive in KST). */
	const at = (iso: string | null | undefined): string => (iso ? esc(iso.slice(5, 16).replace("T", " ")) : "-");
	const dur = (ms: number | null | undefined): string => {
		if (ms === null || ms === undefined) return "-";
		const minutes = Math.floor(ms / 60_000);
		if (minutes < 1) return `${Math.max(0, Math.floor(ms / 1000))}초`;
		if (minutes < 60) return `${minutes}분`;
		const hours = Math.floor(minutes / 60);
		return hours < 48 ? `${hours}시간 ${minutes % 60}분` : `${Math.floor(hours / 24)}일`;
	};
	const live = board?.ok ? board : undefined;
	const clock = now ?? (live === undefined ? Date.parse(s.generatedAt) : live.generatedAt);
	const ago = (since: number): string => {
		if (!since) return "-";
		const minutes = Math.floor(Math.max(0, clock - since) / 60_000);
		if (minutes < 1) return "방금";
		if (minutes < 60) return `${minutes}분 전`;
		const hours = Math.floor(minutes / 60);
		return hours < 24 ? `${hours}시간 전` : `${Math.floor(hours / 24)}일 전`;
	};
	const msOf = (iso: string | undefined): number => {
		const ms = Date.parse(iso ?? "");
		return Number.isNaN(ms) ? 0 : ms;
	};
	/** Hand-crafted 16x16 SVG line icons (MIT). */
	const svg = (paths: string, cls = "state-ico"): string =>
		`<svg class="ico ${cls}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
	const statusIcon = (tone: string): string => {
		if (tone === "is-info")
			return svg('<circle cx="8" cy="8" r="5.5" stroke-opacity="0.3"/><path d="M8 2.5A5.5 5.5 0 0 1 13.5 8"/>');
		if (tone === "is-success") return svg('<circle cx="8" cy="8" r="5.5"/><path d="m5.5 8.2 1.7 1.7 3.5-3.6"/>');
		if (tone === "is-warning")
			return svg(
				'<path d="M8 2.3 14 13H2L8 2.3Z"/><path d="M8 6.5v3"/><circle cx="8" cy="11.2" r="0.4" fill="currentColor"/>',
			);
		if (tone === "is-danger")
			return svg('<circle cx="8" cy="8" r="5.5"/><path d="m5.8 5.8 4.4 4.4M10.2 5.8l-4.4 4.4"/>');
		return svg('<circle cx="8" cy="8" r="5.5" stroke-dasharray="2.4 2"/>');
	};
	const navIcon = (id: string): string => {
		const icons: Record<string, string> = {
			inbox: '<path d="M2.5 4h11v8.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V4Z"/><path d="M2.5 9h3.2l1 1.5h2.6l1-1.5h3.2"/>',
			turns: '<polyline points="1.8 8 4.8 8 6.6 3.8 9.4 12.2 11.2 8 14.2 8"/>',
			flow: '<rect x="1.5" y="5.5" width="4" height="5" rx="1"/><rect x="10.5" y="5.5" width="4" height="5" rx="1"/><path d="M5.5 8h4.5M8.6 6.4 10.2 8l-1.6 1.6"/>',
			lanes:
				'<circle cx="4.5" cy="4" r="1.5"/><circle cx="4.5" cy="12" r="1.5"/><circle cx="11.5" cy="8" r="1.5"/><path d="M4.5 5.5v5M6 4h3.5a2 2 0 0 1 2 2v.5"/>',
			approvals:
				'<path d="M8 2 3 4.2v3.6c0 3.2 2.1 5.5 5 6.2 2.9-.7 5-3 5-6.2V4.2L8 2Z"/><path d="m5.8 8 1.6 1.6 3-3.2"/>',
			monitors: '<circle cx="8" cy="8" r="5.5"/><polyline points="8 4.8 8 8 10.4 9.4"/>',
			alerts:
				'<path d="M8 2.5a4 4 0 0 0-4 4v2.8L2.8 11h10.4L12 9.3V6.5a4 4 0 0 0-4-4Z"/><path d="M6.8 13a1.5 1.5 0 0 0 2.4 0"/>',
			system:
				'<rect x="2.5" y="3" width="11" height="4" rx="1"/><rect x="2.5" y="9" width="11" height="4" rx="1"/><circle cx="5" cy="5" r="0.6" fill="currentColor"/><circle cx="5" cy="11" r="0.6" fill="currentColor"/>',
		};
		return svg(icons[id] ?? icons.inbox ?? "", "nav-ico");
	};
	/** state → [label, badge tone]; anything not listed is grey with its raw name. */
	const STATES: Record<string, [string, string]> = {
		working: ["진행 중", "is-info"],
		dispatched: ["진행 중", "is-info"],
		pending: ["대기", ""],
		idle: ["쉬는 중", ""],
		unknown: ["알 수 없음", ""],
		cancelled: ["취소", ""],
		blocked: ["막힘", "is-warning"],
		review: ["검토 대기", "is-warning"],
		"not-done": ["미완료", "is-warning"],
		paused: ["멈춤", "is-warning"],
		done: ["완료", "is-success"],
		"done-claimed": ["완료 보고", "is-success"],
		delivered: ["전달", "is-success"],
		gone: ["사라짐", "is-danger"],
		failed: ["실패", "is-danger"],
		failed_no_retry: ["실패", "is-danger"],
		answered: ["답함", "is-success"],
		failed_notified: ["실패", "is-danger"],
		discarded: ["버림", ""],
		no_report: ["조용히 끝남", ""],
		skipped: ["건너뜀", ""],
		admitted: ["대기", ""],
		authored: ["작성됨", "is-info"],
	};
	const badge = (text: string, tone: string): string =>
		`<span class="status-pill ${tone}">${statusIcon(tone)}<span class="badge ${tone}">${esc(text)}</span></span>`;
	const state = (name: string, prefix = ""): string => {
		const known = STATES[name];
		return known === undefined ? badge(`${prefix}${name || "?"}`, "") : badge(`${prefix}${known[0]}`, known[1]);
	};
	const failed = (error: string): string =>
		`<div class="notice is-danger">${badge("읽기 실패", "is-danger")}<span>${esc(error)}</span><span class="notice-next">다음 행동: DB 파일 권한이나 디스크 상태를 확인한 뒤 새로고침하세요.</span></div>`;
	/** A to-do line: escaped, backtick spans as `<code>`. */
	const cmd = (text: string): string => esc(text).replace(/`([^`]+)`/g, "<code>$1</code>");

	const VIEWS: Array<[string, string]> = [
		["inbox", "인박스"],
		["turns", "턴"],
		["flow", "흐름"],
		["lanes", "레인"],
		["approvals", "승인 대기"],
		["monitors", "모니터"],
		["alerts", "알림"],
		["system", "시스템"],
	];
	const asked = ui.view ?? "inbox";
	const view = asked === "list" || VIEWS.some(([id]) => id === asked) ? asked : "inbox";
	const viewLabel = view === "list" ? "목록" : (VIEWS.find(([id]) => id === view)?.[1] ?? "인박스");
	const q = (ui.q ?? "").trim().toLowerCase();
	const hit = (...texts: unknown[]): boolean =>
		q === "" ||
		texts.some((text) =>
			String(text ?? "")
				.toLowerCase()
				.includes(q),
		);
	const selected = ui.selected ?? "";
	const isSel = (id: string): boolean => id !== "" && id === selected;
	const theme = ui.theme === "light" || ui.theme === "dark" ? ui.theme : "system";

	// ---- the inbox: one entry per agent pane, plus the open TASKs no pane carries ----
	type Col = "attention" | "working" | "wait";
	interface Entry {
		id: string;
		kind: "card" | "task";
		col: Col;
		since: number;
		title: string;
		machine: string;
		taskId: string;
		card?: BoardCard;
		task?: TaskInfo;
	}
	const tasks = s.tasks.ok ? s.tasks.items : [];
	const taskTrouble = (task: TaskInfo): boolean => task.status === "blocked" || task.error !== undefined;
	const loneColumn = (task: TaskInfo): Col => {
		// While the board is live, an open TASK whose pane is not on it has lost its agent: the owner should look.
		if (live !== undefined || taskTrouble(task)) return "attention";
		const herdr = task.herdr;
		if (herdr !== undefined && !herdr.ok) {
			if (herdr.error !== "herdr is not configured") return "attention";
			return task.status === "review" ? "wait" : "working";
		}
		if (herdr !== undefined && herdr.status !== "working" && herdr.status !== "idle" && herdr.status !== "done") {
			return "attention";
		}
		if (task.status === "review") return "wait";
		return herdr === undefined || herdr.status === "working" ? "working" : "wait";
	};
	const entries: Entry[] = [];
	for (const card of live?.cards ?? []) {
		const task = card.taskId === undefined ? undefined : tasks.find((item) => item.taskId === card.taskId);
		const col: Col =
			card.column === "attention" || (task !== undefined && taskTrouble(task))
				? "attention"
				: card.column === "working"
					? "working"
					: "wait";
		entries.push({
			id: card.key,
			kind: "card",
			col,
			since: card.since,
			title: task?.title || card.paneLabel,
			machine: card.machineName,
			taskId: card.taskId ?? "",
			card,
			...(task === undefined ? {} : { task }),
		});
	}
	for (const task of tasks) {
		if (!task.open || entries.some((entry) => entry.taskId === task.taskId)) continue;
		entries.push({
			id: task.taskId,
			kind: "task",
			col: loneColumn(task),
			since: msOf(task.progress?.updated) || msOf(task.updatedAt),
			title: task.title,
			machine: task.host,
			taskId: task.taskId,
			task,
		});
	}
	const RANK: Record<Col, number> = { attention: 0, working: 1, wait: 2 };
	const byDefault = (a: Entry, b: Entry): number => RANK[a.col] - RANK[b.col] || b.since - a.since;
	const shown = entries.filter((entry) =>
		hit(entry.title, entry.taskId, entry.machine, entry.card?.paneLabel, entry.card?.name),
	);
	const closed = tasks.filter((task) => !task.open && hit(task.title, task.taskId, task.host));

	const linkOf = (entry: { kind: string; id: string }): string =>
		entry.kind === "card"
			? `href="?card=${esc(encodeURIComponent(entry.id))}" data-card="${esc(entry.id)}"`
			: `href="?task=${esc(encodeURIComponent(entry.id))}" data-task="${esc(entry.id)}"`;
	const badgesOf = (entry: Entry): string => {
		const task = entry.task;
		const out: string[] = [];
		// A TASK card shows the TASK's state only; the agent's own state goes in the foot as text (`workerOf`).
		if (task !== undefined) out.push(state(task.status));
		else if (entry.card?.unknown) out.push(badge(`알 수 없음 · ${entry.card.status || "?"}`, "is-warning"));
		else if (entry.card !== undefined) out.push(state(entry.card.status));
		if (task !== undefined && entry.card === undefined && task.open) {
			const herdr = task.herdr;
			if (herdr !== undefined && !herdr.ok) out.push(badge("워커 확인 실패", "is-danger"));
			else if (herdr?.status === "gone") out.push(badge("워커 사라짐", "is-danger"));
			else if (live !== undefined) out.push(badge("에이전트 카드 없음", "is-warning"));
		}
		if (task?.error !== undefined) out.push(badge("문서 판정 실패", "is-danger"));
		return out.join("");
	};
	const summaryOf = (entry: Entry): string => {
		const task = entry.task;
		const parts: string[] = [];
		if (task?.progress?.current) parts.push(task.progress.current);
		if (task?.progress?.blockedReason) parts.push(`막힌 이유: ${task.progress.blockedReason}`);
		if (task?.error) parts.push(task.error);
		if (task?.herdr !== undefined && !task.herdr.ok && entry.card === undefined) parts.push(task.herdr.error);
		if (parts.length > 0) return parts.join(" · ");
		if (entry.card !== undefined) {
			return [entry.card.workspaceLabel, entry.card.tabLabel, entry.card.cwd ?? ""].filter((part) => part).join(" · ");
		}
		return task === undefined ? "" : `PROGRESS 없음 · ${task.branch}`;
	};
	const progressOf = (task: TaskInfo): string[] => [
		`AC ${task.acChecked ?? "-"}/${task.acTotal}`,
		`단계 ${task.stepsDone === undefined ? "-" : `${task.stepsDone}/${task.stepsTotal ?? "-"}`}`,
	];
	const workerOf = (entry: Entry): string => {
		const card = entry.card;
		if (entry.task === undefined || card === undefined) return "";
		const label = card.unknown ? `알 수 없음(${card.status || "?"})` : (STATES[card.status]?.[0] ?? card.status);
		return `<span class="card-worker">워커 ${esc(label)}</span>`;
	};
	const stateKeyOf = (entry: Entry): string => `${entry.col}:${entry.card?.status ?? ""}:${entry.task?.status ?? ""}`;
	const cardOf = (entry: Entry): string => {
		const eyebrow = entry.taskId ? `${entry.taskId} · ${entry.machine}` : entry.machine;
		const meta = entry.task !== undefined ? progressOf(entry.task) : [entry.card?.agent ?? ""];
		return `<a class="card${isSel(entry.id) ? " is-selected" : ""}" data-state="${esc(stateKeyOf(entry))}" ${linkOf(entry)} data-row="${esc(entry.id)}"${
			isSel(entry.id) ? ' aria-current="true"' : ""
		}><p class="card-eyebrow">${esc(eyebrow)}</p><p class="card-title">${esc(entry.title)}</p><p class="card-sum">${esc(
			summaryOf(entry),
		)}</p><div class="card-foot"><span class="badges">${badgesOf(entry)}</span>${workerOf(entry)}<span class="card-time">${ago(
			entry.since,
		)}</span><span class="card-meta">${meta.map((part) => `<span>${esc(part)}</span>`).join("")}</span></div></a>`;
	};

	const banners: string[] = [];
	const d = s.daemon;
	if (!d.ok) {
		banners.push(
			`<div class="notice is-danger">${badge("데몬 상태 모름", "is-danger")}<span>${esc(d.error)}</span><span class="notice-next">다음 행동: 터미널에서 <code>ompbot status</code> 또는 <code>ompbot doctor</code>로 데몬 소켓·DB 상태를 확인하세요.</span></div>`,
		);
	} else if (!d.running) {
		banners.push(
			`<div class="notice is-danger">${badge("데몬 꺼짐", "is-danger")}<span>데몬이 응답하지 않아요. 아래 내용은 DB에 남은 마지막 상태예요.</span><span class="notice-next">다음 행동: <code>systemctl --user status ompbot</code>으로 데몬 상태를 확인하고 필요하면 다시 켜세요.</span></div>`,
		);
	}
	if (board !== undefined && !board.ok) {
		banners.push(
			`<div class="notice is-danger">${badge("에이전트 보드 연결 안 됨", "is-danger")}<span>herdr-web-ui에 다시 붙는 중이에요 (${esc(board.error)}). TASK는 마지막으로 읽은 워커 상태로 보여요.</span><span class="notice-next">다음 행동: herdr-web-ui 서비스(7317)와 연결 상태를 확인하거나 자동 재연결을 잠시 기다려 주세요.</span></div>`,
		);
	}
	if (!s.tasks.ok) banners.push(failed(s.tasks.error));
	if (asked !== view) {
		banners.push(
			`<p class="notice is-warning" role="status">${badge(" 안내", "is-warning")}<span>모르는 보기 '${esc(asked)}'예요. 인박스를 보여 드려요. 왼쪽 내비나 ⌘K 명령 팔레트에서 다른 보기를 고를 수 있어요.</span></p>`,
		);
	}
	const clearBtn =
		q !== ""
			? `<button type="button" class="button is-ghost is-sm" data-clear-search>검색 '${esc(ui.q)}' 지우기 (Esc)</button>`
			: "";
	const nothing =
		q !== ""
			? `<div class="empty-box" role="status"><p class="note">'${esc(ui.q)}'와 맞는 항목이 없어요.</p><p class="note-sub">다음 행동: 검색어를 지우거나(Esc) 다른 제목·TASK ID·머신 이름으로 다시 검색해 보세요.</p><button type="button" class="button is-ghost is-sm" data-clear-search>검색어 지우기 (Esc)</button></div>`
			: "";
	const head = (title: string, count: number | string | undefined, extra = ""): string =>
		`<div class="view-head"><h1 class="view-title">${esc(title)}</h1>${
			count === undefined ? "" : `<span class="count-chip">${esc(count)}</span>`
		}${extra}${clearBtn}</div>`;

	const COLS: Array<[Col, string, string, string]> = [
		["attention", "확인 필요", "확인할 항목이 없어요", "막히거나 오너 결정이 필요한 작업이 생기면 여기에 모입니다."],
		["working", "진행 중", "진행 중인 작업이 없어요", "에이전트가 작업을 시작하면 실시간으로 카드가 표시됩니다."],
		["wait", "완료·대기", "완료·대기 항목이 없어요", "작업이 끝나거나 검토 대기 상태가 되면 여기에 표시됩니다."],
	];
	const inboxView = (): string => {
		const machines =
			live === undefined
				? ""
				: `<div class="badges">${live.machines
						.map((machine) =>
							badge(`${machine.name}${machine.connected ? "" : " · 끊김"}`, machine.connected ? "" : "is-danger"),
						)
						.join("")}</div>`;
		const chips = COLS.map(
			([id, label]) =>
				`<a class="chip" href="#col-${id}">${esc(label)} <b>${shown.filter((entry) => entry.col === id).length}</b></a>`,
		).join("");
		const columns = COLS.map(([id, label, none, hint]) => {
			const cards = shown.filter((entry) => entry.col === id).sort(byDefault);
			const body =
				cards.length === 0
					? `<div class="col-empty-wrap"><p class="col-empty">${esc(none)}</p><p class="col-empty-sub">${esc(hint)}</p></div>`
					: cards.map(cardOf).join("");
			const recent =
				id !== "wait" || closed.length === 0
					? ""
					: `<details class="closed" id="closed"><summary>최근 닫힘 <span class="count-chip">${closed.length}</span></summary>${closed
							.map(
								(task) =>
									`<a class="closed-row" ${linkOf({ kind: "task", id: task.taskId })} data-row="${esc(task.taskId)}"><b>${esc(
										task.taskId,
									)}</b> ${esc(task.title)} · ${esc(STATES[task.status]?.[0] ?? task.status)} ${at(task.closedAt)}</a>`,
							)
							.join("")}</details>`;
			return `<section class="col" id="col-${id}" aria-label="${esc(label)}"${
				cards.length === 0 && recent === "" ? " data-empty" : ""
			}><h2 class="col-head"><span>${esc(
				label,
			)}</span><span class="count-chip">${cards.length}</span></h2>${body}${recent}</section>`;
		}).join("");
		const herdr = s.herdr;
		// Without a live board, the `herdr agent list` of every host stays visible under the inbox.
		const agents =
			live !== undefined || (herdr.ok && herdr.hosts.length === 0)
				? ""
				: `<section class="rows-block" aria-label="herdr 에이전트">${head(
						"herdr 에이전트",
						herdr.ok ? herdr.hosts.reduce((sum, host) => sum + (host.ok ? host.agents.length : 0), 0) : undefined,
					)}${
						herdr.ok
							? herdr.hosts
									.map(
										(host) =>
											`<p class="group">${esc(host.host)}</p>${
												!host.ok
													? `<div class="notice is-danger">${badge("호스트 연결 실패", "is-danger")}<span>${esc(host.error)}</span><span class="notice-next">다음 행동: <code>ompbot doctor</code>로 해당 호스트의 SSH 및 herdr 경로를 점검하세요.</span></div>`
													: host.agents.length === 0
														? '<div class="empty-box"><p class="note">실행 중인 에이전트가 없어요</p><p class="note-sub">새 작업을 위임하면 이 호스트의 에이전트 목록에 나타납니다.</p></div>'
														: `<div class="rows">${host.agents
																.map(
																	(agent) =>
																		`<div class="row"><div class="row-main"><div class="badges">${state(agent.agentStatus)}</div><p class="row-title">${esc(agent.name)}</p>${
																			agent.terminalTitle ? `<p class="row-sub">${esc(agent.terminalTitle)}</p>` : ""
																		}<p class="row-sub">${agent.taskId ? `${esc(agent.taskId)} · ` : ""}${esc(agent.cwd)}</p></div></div>`,
																)
																.join("")}</div>`
											}`,
									)
									.join("")
							: `<div class="notice is-danger">${badge("herdr 조회 실패", "is-danger")}<span>${esc(herdr.error)}</span><span class="notice-next">다음 행동: 로컬 herdr 실행 파일과 데몬 설정을 확인하세요(<code>ompbot doctor</code>).</span></div>`
					}</section>`;
		// The head names what it counts: the 진행 중 column, the same number as the side nav.
		const working = shown.filter((entry) => entry.col === "working").length;
		if (q !== "" && shown.length === 0 && closed.length === 0) {
			return `${head("에이전트 인박스", undefined, `<span class="view-sum">진행 중 <b>${working}</b></span>${machines}`)}${banners.join("")}${nothing}${agents}`;
		}
		return `${head("에이전트 인박스", undefined, `<span class="view-sum">진행 중 <b>${working}</b></span>${machines}`)}${banners.join("")}${
			shown.length === 0 ? nothing : ""
		}<nav class="col-chips" aria-label="열로 이동">${chips}</nav><div class="inbox">${columns}</div>${agents}`;
	};

	const SORTS: Array<[string, string]> = [
		["state", "상태"],
		["title", "제목"],
		["machine", "머신"],
		["task", "TASK"],
		["ac", "AC"],
		["age", "경과"],
	];
	const listView = (): string => {
		const key = SORTS.some(([id]) => id === ui.sort) ? (ui.sort as string) : "state";
		const flip = ui.desc === true ? -1 : 1;
		const ratio = (entry: Entry): number =>
			entry.task === undefined || entry.task.acTotal === 0 ? -1 : (entry.task.acChecked ?? 0) / entry.task.acTotal;
		const value = (entry: Entry): string | number =>
			key === "title"
				? entry.title
				: key === "machine"
					? entry.machine
					: key === "task"
						? entry.taskId
						: key === "ac"
							? ratio(entry)
							: key === "age"
								? clock - entry.since
								: RANK[entry.col];
		const rows = shown.slice().sort((a, b) => {
			const x = value(a);
			const y = value(b);
			const order = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "ko");
			return order === 0 ? byDefault(a, b) : order * flip;
		});
		const heads = SORTS.map(([id, label]) => {
			const active = id === key;
			const sort = active ? (flip === 1 ? "ascending" : "descending") : "none";
			return `<th scope="col" aria-sort="${sort}"><button type="button" data-sort="${id}">${esc(label)}${
				active ? `<span aria-hidden="true"> ${flip === 1 ? "↑" : "↓"}</span>` : ""
			}</button></th>`;
		}).join("");
		const body = rows
			.map(
				(entry) =>
					`<tr data-row="${esc(entry.id)}" data-state="${esc(stateKeyOf(entry))}"${isSel(entry.id) ? ' class="is-selected"' : ""}><td><span class="badges">${badgesOf(
						entry,
					)}</span></td><td class="list-title"><a ${linkOf(entry)}${isSel(entry.id) ? ' aria-current="true"' : ""}>${esc(
						entry.title,
					)}</a></td><td>${esc(entry.machine)}</td><td class="mono">${esc(entry.taskId || "-")}</td><td class="num">${
						entry.task === undefined ? "-" : esc(`${entry.task.acChecked ?? "-"}/${entry.task.acTotal}`)
					}</td><td class="num">${ago(entry.since)}</td></tr>`,
			)
			.join("");
		return `${head("에이전트 목록", rows.length)}${banners.join("")}${
			rows.length === 0
				? nothing ||
					'<div class="empty-box"><p class="note">보여 줄 에이전트나 TASK가 없어요.</p><p class="note-sub">새로운 작업이 시작되면 목록에 표시됩니다.</p></div>'
				: `<table class="list"><thead><tr>${heads}</tr></thead><tbody>${body}</tbody></table>`
		}`;
	};

	/** A row of one of the other views; it opens in the detail panel as `?view=<view>&item=<id>`. */
	const row = (id: string, badges: string[], title: string, sub: string[]): string => {
		const lines = sub
			.filter((line) => line !== "")
			.map((line) => `<p class="row-sub">${line}</p>`)
			.join("");
		return `<a class="row${isSel(id) ? " is-selected" : ""}" href="?view=${view}&amp;item=${esc(encodeURIComponent(id))}" data-item="${esc(
			id,
		)}" data-row="${esc(id)}"${isSel(id) ? ' aria-current="true"' : ""}><div class="row-main">${
			badges.length === 0 ? "" : `<div class="badges">${badges.join("")}</div>`
		}<p class="row-title">${title}</p>${lines}</div></a>`;
	};
	const listOf = (title: string, rows: string[], total: number, none: string, hint: string, lead = ""): string =>
		`${head(title, total)}${banners.join("")}${lead}${
			rows.length === 0
				? total > 0
					? nothing
					: `<div class="empty-box"><p class="note">${esc(none)}</p><p class="note-sub">${esc(hint)}</p></div>`
				: `<div class="rows">${rows.join("")}</div>`
		}`;

	const sectionView = (): string => {
		if (view === "turns") {
			const turns = s.turns;
			// Background jobs (`<home>/jobs/*.json`) under the turns: they outlive the turn that started them.
			const jobs = s.jobs;
			const jobRow = (job: JobInfo): string => {
				const [word, tone] = JOB_LABELS[job.health === "ok" ? (job.state ?? "running") : job.health];
				const counts =
					job.done === undefined || job.total === undefined
						? ""
						: `${
								job.percent === undefined
									? ""
									: `<span class="meter" role="img" aria-label="진행 ${job.percent}%"><i style="width:${job.percent}%"></i></span> `
							}${esc(
								`${job.done}/${job.total}${job.unit ? ` ${job.unit}` : ""}${job.percent === undefined ? "" : ` (${job.percent}%)`}`,
							)}`;
				return row(`job:${job.name}`, [badge(word, tone)], esc(job.title), [
					counts,
					`${job.startedAt ? `시작 ${at(job.startedAt)} · ` : ""}마지막 갱신 뒤 ${dur(job.ageMs)}`,
					job.thread ? `스레드 ${esc(job.thread)}` : "",
					esc(job.detail ?? ""),
				]);
			};
			const shownJobs = jobs.ok ? jobs.items.filter((job) => hit(job.title, job.name, job.detail, job.thread)) : [];
			// Running or troubled jobs sit above the board where they are seen; cleanly finished ones fold at the bottom.
			const finished = (job: JobInfo): boolean =>
				(job.state === "done" || job.state === "stopped") && job.health === "ok";
			const liveJobs = shownJobs.filter((job) => !finished(job));
			const doneJobs = shownJobs.filter(finished);
			const jobTop = !jobs.ok
				? `<div class="view-head" id="jobs"><h2 class="h2">백그라운드 작업</h2></div>${failed(jobs.error)}`
				: liveJobs.length === 0
					? ""
					: `<div class="view-head" id="jobs"><h2 class="h2">백그라운드 작업</h2><span class="count-chip">${liveJobs.length}</span></div><div class="rows">${liveJobs.map(jobRow).join("")}</div>`;
			// `id="closed"` keeps the fold open across the 15-second redraw, like the inbox's 최근 닫힘.
			const jobDone =
				doneJobs.length === 0
					? ""
					: `<details class="closed" id="closed"><summary>끝난 백그라운드 작업 <span class="count-chip">${doneJobs.length}</span></summary><div class="rows">${doneJobs.map(jobRow).join("")}</div></details>`;
			const runningJobs = jobs.ok ? jobs.items.filter((job) => job.state === "running").length : 0;
			if (!turns.ok) return `${head("턴", undefined)}${banners.join("")}${failed(turns.error)}${jobTop}${jobDone}`;
			const draining = d.ok && (d.drain !== undefined || d.heartbeat?.draining === true);
			const holding = turns.items.filter((turn) => turn.blocksRestart);
			const oldest = holding.reduce((max, turn) => Math.max(max, turn.ageMs), 0);
			const drainLine = draining
				? `<p class="notice is-warning" role="status">${badge("재시작 준비 중", "is-warning")}<span>${
						holding.length === 0
							? "남은 도구 실행·승인이 끝나면 재시작합니다."
							: `진행 중인 턴 ${holding.length}개가 끝나면 재시작합니다 (가장 오래된 턴 경과 ${dur(oldest)}).`
					} 그동안 들어온 요청은 재시작 뒤 처리됩니다.</span></p>`
				: "";
			// One card per conversation (Slack thread = omp session), laid out like the inbox.
			const openThreads = turns.threads.filter((thread) => thread.column === "working").length;
			// Every number in the head says what it counts: open threads match the 진행 중 column, jobs link to their block.
			const title = head(
				"턴",
				undefined,
				`<span class="view-sum">진행 중 스레드 <b>${openThreads}</b>${
					runningJobs > 0 ? ` · <a href="#jobs">백그라운드 작업 <b>${runningJobs}</b></a>` : ""
				}</span>`,
			);
			// No thread but live jobs: the jobs stand in for the empty board.
			if (turns.threads.length === 0) {
				return liveJobs.length > 0
					? `${title}${banners.join("")}${drainLine}${jobTop}${jobDone}`
					: `${title}${banners.join("")}${drainLine}${jobTop}<div class="empty-box"><p class="note">최근 24시간 턴이 없어요</p><p class="note-sub">슬랙 대화나 모니터에서 새 턴이 시작되면 실시간으로 표시됩니다.</p></div>${jobDone}`;
			}
			type ThreadCol = "attention" | "working" | "done";
			const THREAD_RANK: Record<ThreadCol, number> = { attention: 0, working: 1, done: 2 };
			const threads = turns.threads.filter((thread) =>
				hit(thread.title, thread.latest.preview, thread.originKey, thread.threadRef),
			);
			const restartHeld = new Set(holding.map((turn) => turn.originKey));
			const placeOf = (key: string): string => {
				// Any platform's owner DM (`<platform>/dm/<id>`); this runs in the browser, so no parseChatOrigin here.
				if (/^[a-z]+\/dm\//.test(key)) return "DM";
				const channel = /^(slack|discord)\/ch\/([^/]+)(\/t\/[^/]+)?$/.exec(key);
				if (channel !== null) {
					const id = `${channel[1] === "discord" ? "Discord " : ""}${channel[2] ?? ""}`;
					return channel[3] === undefined ? `${id} 채널 메인` : id;
				}
				return key.startsWith("monitor/") ? "" : key;
			};
			const threadLink = (key: string): string =>
				`href="?view=turns&amp;item=${esc(encodeURIComponent(key))}" data-item="${esc(key)}"`;
			const verdicts = s.feedback.ok ? s.feedback.verdicts : {};
			/** The owner's 👍/👎 on the turn of `inboundId`; nothing without a verdict. */
			const feedbackBadge = (inboundId: number): string => {
				const verdict = verdicts[String(inboundId)];
				return verdict === undefined
					? ""
					: `<span class="badge" data-feedback="${verdict}" title="오너 피드백">${verdict === "up" ? "👍" : "👎"}</span>`;
			};
			const threadBadges = (thread: (typeof threads)[number]): string =>
				[
					state(thread.latest.state),
					feedbackBadge(thread.latest.inboundId),
					...(thread.stalledCount > 0 ? [badge("정체", "is-warning")] : []),
					...(restartHeld.has(thread.originKey) ? [badge("재시작이 기다리는 턴", "is-warning")] : []),
				].join("");
			const byRecent = (a: (typeof threads)[number], b: (typeof threads)[number]): number =>
				THREAD_RANK[a.column] - THREAD_RANK[b.column] || msOf(b.updatedAt) - msOf(a.updatedAt);
			const threadCard = (thread: (typeof threads)[number]): string => {
				const key = thread.originKey;
				const place = placeOf(key);
				const latest = thread.latest;
				const sum = [
					latest.preview !== null && latest.preview !== thread.title ? `<span>${esc(latest.preview)}</span>` : "",
					latest.waitReason === null
						? ""
						: `<span class="card-wait">${esc(TURN_LABELS.wait[latest.waitReason])}</span>`,
				]
					.filter((part) => part !== "")
					.join(" · ");
				// One open turn is already the state badge; more rows say whether they are one run or a queue.
				const meta = [`턴 ${thread.turnCount}`, ...(thread.openCount > 1 ? [openTurnsText(thread)] : [])];
				return `<a class="card${isSel(key) ? " is-selected" : ""}" data-state="${esc(`${thread.column}:${latest.state}`)}" ${threadLink(key)} data-row="${esc(key)}"${
					isSel(key) ? ' aria-current="true"' : ""
				}><p class="card-eyebrow"><span>${esc(TURN_LABELS.kind[thread.kind])}</span>${
					place === "" ? "" : ` · <span>${esc(place)}</span>`
				}</p><p class="card-title">${esc(thread.title)}</p>${sum === "" ? "" : `<p class="card-sum">${sum}</p>`}<div class="card-foot"><span class="badges">${threadBadges(
					thread,
				)}</span><span class="card-time">${ago(msOf(thread.updatedAt))}</span><span class="card-meta">${meta
					.map((part) => `<span>${esc(part)}</span>`)
					.join("")}</span></div></a>`;
			};
			const lead = `${banners.join("")}${drainLine}${threads.length === 0 ? nothing : ""}`;
			if (ui.layout === "list") {
				const TURN_SORTS: Array<[string, string]> = [
					["state", "상태"],
					["title", "제목"],
					["kind", "종류"],
					["turns", "턴 수"],
					["age", "경과"],
					["updated", "갱신"],
				];
				const key = TURN_SORTS.some(([id]) => id === ui.sort) ? (ui.sort as string) : "state";
				const flip = ui.desc === true ? -1 : 1;
				const value = (thread: (typeof threads)[number]): string | number =>
					key === "title"
						? thread.title
						: key === "kind"
							? TURN_LABELS.kind[thread.kind]
							: key === "turns"
								? thread.turnCount
								: key === "age"
									? thread.latest.ageMs
									: key === "updated"
										? clock - msOf(thread.updatedAt)
										: THREAD_RANK[thread.column];
				const sorted = threads.slice().sort((a, b) => {
					const x = value(a);
					const y = value(b);
					const order =
						typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "ko");
					return order === 0 ? byRecent(a, b) : order * flip;
				});
				const heads = TURN_SORTS.map(([id, label]) => {
					const active = id === key;
					const sort = active ? (flip === 1 ? "ascending" : "descending") : "none";
					return `<th scope="col" aria-sort="${sort}"><button type="button" data-sort="${id}">${esc(label)}${
						active ? `<span aria-hidden="true"> ${flip === 1 ? "↑" : "↓"}</span>` : ""
					}</button></th>`;
				}).join("");
				const body = sorted
					.map(
						(thread) =>
							`<tr data-row="${esc(thread.originKey)}" data-state="${esc(`${thread.column}:${thread.latest.state}`)}"${
								isSel(thread.originKey) ? ' class="is-selected"' : ""
							}><td><span class="badges">${threadBadges(thread)}</span></td><td class="list-title"><a ${threadLink(
								thread.originKey,
							)}${isSel(thread.originKey) ? ' aria-current="true"' : ""}>${esc(thread.title)}</a></td><td>${esc(
								TURN_LABELS.kind[thread.kind],
							)}</td><td class="num">${thread.turnCount}</td><td class="num">${dur(thread.latest.ageMs)}</td><td class="num">${ago(
								msOf(thread.updatedAt),
							)}</td></tr>`,
					)
					.join("");
				return `${title}${lead}${jobTop}${
					sorted.length === 0
						? ""
						: `<table class="list"><thead><tr>${heads}</tr></thead><tbody>${body}</tbody></table>`
				}${jobDone}`;
			}
			const TURN_COLS: Array<[ThreadCol, string, string, string]> = [
				["attention", "확인 필요", "확인할 스레드가 없어요", "멈췄거나 실패로 끝난 스레드가 생기면 여기에 모입니다."],
				[
					"working",
					"진행 중",
					"진행 중인 턴이 없어요",
					"슬랙 대화나 모니터에서 새 턴이 시작되면 실시간으로 표시됩니다.",
				],
				["done", "완료", "끝난 스레드가 없어요", "턴이 끝난 스레드는 마지막 활동 뒤 24시간 동안 여기에 남습니다."],
			];
			const chips = TURN_COLS.map(
				([id, label]) =>
					`<a class="chip" href="#col-${id}">${esc(label)} <b>${threads.filter((thread) => thread.column === id).length}</b></a>`,
			).join("");
			const columns = TURN_COLS.map(([id, label, none, hint]) => {
				const cards = threads.filter((thread) => thread.column === id).sort(byRecent);
				const body =
					cards.length === 0
						? `<div class="col-empty-wrap"><p class="col-empty">${esc(none)}</p><p class="col-empty-sub">${esc(hint)}</p></div>`
						: cards.map(threadCard).join("");
				return `<section class="col" id="col-${id}" aria-label="${esc(label)}"${cards.length === 0 ? " data-empty" : ""}><h2 class="col-head"><span>${esc(
					label,
				)}</span><span class="count-chip">${cards.length}</span></h2>${body}</section>`;
			}).join("");
			if (q !== "" && threads.length === 0) {
				return `${title}${lead}${jobTop}${jobDone}`;
			}
			return `${title}${lead}${jobTop}<nav class="col-chips" aria-label="열로 이동">${chips}</nav><div class="inbox">${columns}</div>${jobDone}`;
		}
		if (view === "flow") {
			const flows = s.flows;
			if (flows === undefined || !flows.ok) {
				return `${head("흐름", undefined)}${banners.join("")}${failed(flows?.error ?? "이 스냅샷에는 흐름이 없어요")}`;
			}
			const shown = flows.items.filter((chain) =>
				hit(chain.title, chain.place, ...chain.tasks.flatMap((step) => [step.taskId, step.title, step.branch])),
			);
			const cards = shown.map((chain) => {
				const first = chain.tasks[0]?.createdAt;
				return `<section class="flow-card${chain.here === null ? " is-closed" : ""}" data-thread="${esc(
					chain.threadRef,
				)}"><h2 class="flow-title"><span>${esc(chain.title)}</span><small>${chain.done}/${chain.total} 끝남</small></h2><p class="flow-meta">${esc(
					[`TASK ${chain.total}개`, `${at(first)} ~ ${at(chain.updatedAt)}`, chain.place ?? ""]
						.filter((part) => part !== "")
						.join(" · "),
				)}</p>${renderFlowChain(chain, selected, false)}</section>`;
			});
			const lead =
				'<p class="lead flow-lead">요청 하나가 어떤 TASK를 거쳐 끝나는지 등록 순서대로 보여 줘요. 노란 테두리 상자가 다음에 풀 고리예요. 상자를 누르면 오른쪽에 TASK 상세가 열려요.</p>';
			return `${head("흐름", flows.items.length)}${banners.join("")}${lead}${
				cards.length === 0
					? flows.items.length > 0
						? nothing
						: '<div class="empty-box"><p class="note">최근 7일 안에 TASK가 있는 요청이 없어요</p><p class="note-sub">요청이 TASK로 등록되면 여기에 고리로 표시됩니다.</p></div>'
					: `<div class="flow-list">${cards.join("")}</div>`
			}`;
		}
		if (view === "lanes") {
			const lanes = s.lanes;
			if (!lanes.ok) return `${head("레인", undefined)}${banners.join("")}${failed(lanes.error)}`;
			const rows = lanes.items
				.filter((lane) => hit(lane.title, lane.name, lane.cwd))
				.map((lane) =>
					row(lane.name, [state(lane.status)], esc(lane.title), [
						`${esc(lane.name)} · 갱신 ${at(lane.updatedAt)}`,
						esc(lane.cwd),
					]),
				);
			return listOf(
				"레인",
				rows,
				lanes.items.length,
				"열린 레인이 없어요",
				"슬랙에서 '작업: <제목> @<경로>'로 작업 레인을 열면 여기에 표시됩니다.",
			);
		}
		if (view === "approvals") {
			const approvals = s.approvals;
			if (!approvals.ok) return `${head("승인 대기", undefined)}${banners.join("")}${failed(approvals.error)}`;
			const rows = approvals.items
				.filter((item) => hit(item.summary, item.title, item.originKey, ...Object.values(item.detail ?? {})))
				.map((item) => {
					const minutes = Math.ceil(item.remainingMs / 60_000);
					const left =
						item.remainingMs <= 0
							? badge("만료 처리 중", "is-warning")
							: badge(`${minutes}분 남음`, minutes <= 10 ? "is-warning" : "");
					// Row ids (approval id, origin key) stay out of the text: the detail panel keeps them under 내부 정보.
					return row(
						item.approvalId,
						[left, ...(item.detail?.rollback ? [badge("되돌릴 수 없음", "is-warning")] : [])],
						esc(item.title),
						[
							`요청 ${esc(item.createdAt.slice(11, 16))} · 만료 ${esc(item.expiresAt.slice(11, 16))}`,
							item.originLabel === null ? "" : esc(item.originLabel),
						],
					);
				});
			const stats = approvals.stats;
			const settled = stats.approved + stats.denied + stats.expired + stats.replied;
			const lead =
				settled === 0
					? ""
					: `<p class="list-lead">최근 ${stats.days}일 ${[
							`승인 ${stats.approved}`,
							`거절 ${stats.denied}`,
							...(stats.replied > 0 ? [`답장 ${stats.replied}`] : []),
							`만료 ${stats.expired}`,
							...(stats.medianAnswerMs === null ? [] : [`답까지 중앙값 ${monitorTook(stats.medianAnswerMs)}`]),
						]
							.map((text) => `<span>${esc(text)}</span>`)
							.join("")}</p>`;
			const decided = approvals.recent
				.filter((item) => hit(item.summary, item.title, item.originKey, ...Object.values(item.detail ?? {})))
				.map((item) => {
					const [word, tone] = APPROVAL_OUTCOMES[item.status] ?? [item.status, ""];
					return row(item.approvalId, [badge(word, tone)], esc(item.title), [
						`요청 ${at(item.createdAt)}${item.tookMs === null ? "" : ` · ${esc(monitorTook(item.tookMs))} 뒤 ${esc(word)}`}`,
						item.originLabel === null ? "" : esc(item.originLabel),
					]);
				});
			return `${listOf(
				"승인 대기",
				rows,
				approvals.items.length,
				"기다리는 승인이 없어요",
				"승인이 필요한 작업이 올라오면 슬랙 승인 카드와 함께 여기에 표시됩니다.",
				lead,
			)}${
				decided.length === 0
					? ""
					: `<h2 class="list-section">최근 결정 <span class="count-chip">${decided.length}</span></h2><div class="rows" data-list="decided">${decided.join("")}</div>`
			}`;
		}
		if (view === "monitors") {
			const monitors = s.monitors;
			if (!monitors.ok) return `${head("모니터", undefined)}${banners.join("")}${failed(monitors.error)}`;
			// Groups by the KST day of the next fire against the snapshot's own day.
			const generated = Date.parse(s.generatedAt);
			const today = s.generatedAt.slice(0, 10);
			const tomorrow = new Date(generated + 9 * 3_600_000 + 86_400_000).toISOString().slice(0, 10);
			const dayOf = (monitor: MonitorInfo): string => {
				const day = monitor.nextFireAt?.slice(0, 10);
				return day === undefined ? "none" : day === today ? "today" : day === tomorrow ? "tomorrow" : "later";
			};
			const GROUPS: Array<[string, string]> = [
				["today", `오늘 ${today.slice(5)}`],
				["tomorrow", `내일 ${tomorrow.slice(5)}`],
				["later", "그 뒤"],
				["none", "예정 없음"],
			];
			const stageOf = (stage: string): [string, string] => MONITOR_STAGES[stage] ?? [stage || "?", ""];
			/** One of the 7 run dots, never by colour alone: its time and result are its label. */
			const dot = (event: MonitorInfo["recent"][number] | undefined): string => {
				if (event === undefined) {
					return '<span class="mon-dot is-empty" role="img" title="기록 없음" aria-label="기록 없음"></span>';
				}
				const [word, tone] = stageOf(event.stage);
				const label = `${at(event.at)} ${esc(word)}${event.manual ? " · 수동" : ""}`;
				return `<span class="mon-dot ${tone}${event.manual ? " is-manual" : ""}" role="img" title="${label}" aria-label="${label}"></span>`;
			};
			const lastLines = (monitor: MonitorInfo): string[] => {
				const run = monitor.lastRun;
				if (run === null) return ["정기 실행 아직 없음"];
				const took =
					run.durationMs === null
						? `진행 중 · 시작 후 ${dur(generated - Date.parse(run.slotAt))}`
						: `${esc(stageOf(run.stage)[0])} ${at(run.at)} · ${
								run.attempts > 0
									? `재시도 ${run.attempts}회 · 지연 포함 ${monitorTook(run.durationMs)}`
									: monitorTook(run.durationMs)
							}`;
				return [`${took}${run.manual ? " · 수동" : ""}`, ...(monitor.scheduledRun ? [] : ["정기 실행 아직 없음"])];
			};
			const monitorRow = (monitor: MonitorInfo): string => {
				const id = monitor.id;
				const selected = isSel(id) || isSel(monitor.name);
				const chips = [
					`→ ${monitor.destination}`,
					...(monitor.copyTo === null ? [] : [`+ 사본 ${monitor.copyTo}`]),
					monitor.model === null ? "기본 모델" : monitor.model.slice(monitor.model.lastIndexOf("/") + 1),
					...monitor.files.map((file) => `${file.kind === "procedure" ? "절차" : "스크립트"} ${file.name}`),
				]
					.map((text) => `<span class="mon-chip">${esc(text)}</span>`)
					.join("");
				const health = [
					...(monitor.running ? [badge("실행 중", "is-info")] : []),
					...(monitor.failStreak > 0
						? [badge(monitor.failStreak > 1 ? `연속 실패 ${monitor.failStreak}회` : "최근 실패", "is-danger")]
						: []),
					...(monitor.openIncidents > 0 ? [badge(`사건 ${monitor.openIncidents}`, "is-danger")] : []),
				];
				// Oldest on the left, empty slots before the first event.
				const dots = [
					...Array.from({ length: Math.max(0, 7 - monitor.recent.length) }, () => dot(undefined)),
					...monitor.recent.map(dot),
				].join("");
				return `<a class="row mon-row${selected ? " is-selected" : ""}" href="?view=monitors&amp;item=${esc(
					encodeURIComponent(id),
				)}" data-item="${esc(id)}" data-row="${esc(id)}" data-state="${esc(monitor.lastStage ?? "")}"${
					selected ? ' aria-current="true"' : ""
				}><div class="mon-when"><span class="mon-time">${
					monitor.nextFireAt === null ? "-" : esc(monitor.nextFireAt.slice(11, 16))
				}</span><span class="mon-sched">${esc(monitor.schedule)}</span></div><div class="row-main"><p class="row-title">${esc(
					monitor.name,
				)}</p><p class="row-sub">${esc(monitor.summary)}</p><p class="mon-chips">${chips}</p>${
					health.length === 0 ? "" : `<div class="badges">${health.join("")}</div>`
				}</div><div class="mon-side"><span class="mon-dots">${dots}</span>${lastLines(monitor)
					.map((line) => `<span class="mon-last">${line}</span>`)
					.join("")}</div></a>`;
			};
			const shown = monitors.items.filter((monitor) =>
				hit(
					monitor.name,
					monitor.summary,
					monitor.destination,
					monitor.copyTo,
					monitor.schedule,
					monitor.model ?? "기본 모델",
					...monitor.files.map((file) => file.name),
				),
			);
			// The whole list in one line: what is still due today and how the last runs ended.
			const sum = (pick: (monitor: MonitorInfo) => number): number =>
				monitors.items.reduce((total, monitor) => total + pick(monitor), 0);
			const failedRuns = sum((monitor) => monitor.stats.failed);
			const skippedRuns = sum((monitor) => monitor.stats.skipped);
			const lead =
				monitors.items.length === 0
					? ""
					: `<p class="list-lead">${[
							`오늘 남은 실행 ${monitors.items.filter((monitor) => dayOf(monitor) === "today").length}`,
							`최근 ${monitors.items[0]?.stats.days ?? 0}일 전달 ${sum((monitor) => monitor.stats.delivered)}`,
							`조용히 끝남 ${sum((monitor) => monitor.stats.quiet)}`,
							...(skippedRuns > 0 ? [`건너뜀 ${skippedRuns}`] : []),
						]
							.map((text) => `<span>${esc(text)}</span>`)
							.join("")}<span${failedRuns > 0 ? ' class="is-danger"' : ""}>실패 ${failedRuns}</span>${
							monitors.items.some((monitor) => monitor.running) ? "<span>지금 실행 중 있음</span>" : ""
						}</p>`;
			const rows = GROUPS.flatMap(([key, label]) => {
				const group = shown.filter((monitor) => dayOf(monitor) === key);
				return group.length === 0
					? []
					: [
							`<h3 class="mon-group">${esc(label)} <span class="count-chip">${group.length}</span></h3>`,
							...group.map(monitorRow),
						];
			});
			return listOf(
				"모니터",
				rows,
				monitors.items.length,
				"켜진 모니터가 없어요",
				"ompbot monitors add로 등록한 정기·조건 모니터가 여기에 표시됩니다.",
				lead,
			);
		}
		if (view === "alerts") {
			const alerts = s.alerts;
			if (!alerts.ok) return `${head("알림", undefined)}${banners.join("")}${failed(alerts.error)}`;
			// Open gates first, then the most recent; a closed gate's row is a record the daemon has not cleared yet.
			const rows = alerts.items
				.slice()
				.sort(
					(a, b) => Number(b.gateState === "open") - Number(a.gateState === "open") || msOf(b.lastAt) - msOf(a.lastAt),
				)
				.map((alert) => ({ alert, text: alertText(alert.scope) }))
				.filter(({ alert, text }) => hit(text.title, alert.scope, alert.signature))
				.map(({ alert, text }) => {
					const [word, tone] =
						alert.gateState === "open"
							? ["지금 열림", "is-danger"]
							: alert.gateState === "closed"
								? ["지금은 닫힘 · 기록만 남음", ""]
								: alert.gateState === "unknown"
									? ["상태 모름", "is-warning"]
									: ["기록만 남음", ""];
					return row(String(alert.incidentId), [badge(word, tone), badge(`${alert.count}회`, "")], esc(text.title), [
						`처음 ${at(alert.firstAt)} · 마지막 ${at(alert.lastAt)} · 지속 ${dur(msOf(alert.lastAt) - msOf(alert.firstAt))}`,
						`할 일: ${cmd(text.todo)}`,
					]);
				});
			if (alerts.items.length > 0 && !alerts.items.some((alert) => alert.gateState === "open")) {
				banners.push(
					`<p class="notice" role="status">${badge("안내", "")}<span>지금 열린 알림은 없습니다. 아래는 아직 정리되지 않은 기록입니다.</span></p>`,
				);
			}
			return listOf(
				"알림",
				rows,
				alerts.items.length,
				"열린 알림이 없어요",
				"데몬이나 모니터에서 반복 실패 인시던트가 발생하면 여기에 모입니다.",
			);
		}
		// system: one card per area, each headed by a dot and a word (정상/주의/문제) so colour is never alone.
		const facts = (rows: Array<[string, string]>): string =>
			`<dl class="facts">${rows.map(([name, value]) => `<dt>${esc(name)}</dt><dd>${value}</dd>`).join("")}</dl>`;
		const LEVELS: Record<string, [string, string]> = {
			ok: ["정상", "is-success"],
			warn: ["주의", "is-warning"],
			bad: ["문제", "is-danger"],
		};
		const cards: string[] = [];
		const pushCard = (id: string, title: string, level: string, body: string, wide = false): void => {
			const [word, tone] = LEVELS[level] ?? ["?", ""];
			if (!hit(id, title, word, body.replace(/<[^>]*>/g, " "))) return;
			cards.push(
				`<section class="sys-card${wide ? " is-wide" : ""}" data-card="${id}" aria-label="${esc(title)}"><header class="sys-head"><span class="sys-dot ${tone}" aria-hidden="true"></span><h3 class="h3">${esc(
					title,
				)}</h3>${badge(word, tone)}</header>${body}</section>`,
			);
		};
		const note = (text: string): string => `<p class="note">${esc(text)}</p>`;
		const noDaemon = note(d.ok ? "" : `데몬 상태를 읽지 못했어요: ${d.error}`);

		if (!d.ok) pushCard("daemon", "데몬", "bad", noDaemon);
		else {
			pushCard(
				"daemon",
				"데몬",
				!d.running ? "bad" : d.frozen || d.drain || d.heartbeat?.draining ? "warn" : "ok",
				facts([
					["상태", d.running ? "켜짐" : "꺼짐 · DB에서 읽음"],
					["시작 뒤", d.started ? `${dur(d.started.ageMs)} · ${at(d.started.at)}부터` : "-"],
					["커밋", d.commit ? `<code>${esc(d.commit)}</code>` : "-"],
					["omp", esc(d.ompVersion)],
					["대화", `${d.origins}개 중 ${d.busy}개 작업 중`],
					["동결", d.frozen ? `${esc(d.frozen.reason || "-")} · ${esc(d.frozen.since)}부터` : "아님"],
					[
						"drain",
						d.drain
							? `턴 ${d.drain.turns} · 도구 ${d.drain.hostTools} · 승인 ${d.drain.approvals}`
							: d.heartbeat?.draining
								? "진행 중"
								: "아님",
					],
				]),
			);
		}

		const socket = d.ok ? d.heartbeat?.socket : undefined;
		if (!d.ok) pushCard("slack", "Slack", "warn", noDaemon);
		else if (socket === undefined) pushCard("slack", "Slack", "warn", note("소켓 상태 기록이 아직 없어요."));
		else {
			pushCard(
				"slack",
				"Slack",
				socket.state === "up" ? "ok" : "bad",
				facts([
					["소켓", socket.state === "up" ? "연결" : "끊김"],
					["그 뒤", `${dur(clock - msOf(socket.since))} · ${at(socket.since)}부터`],
				]),
			);
		}
		// Only an install with Discord on records its gateway in the heartbeat; without it there is no card.
		const gateway = d.ok ? d.heartbeat?.discord : undefined;
		if (gateway !== undefined) {
			pushCard(
				"discord",
				"Discord",
				gateway.state === "up" ? "ok" : "bad",
				facts([
					["게이트웨이", gateway.state === "up" ? "연결" : "끊김"],
					["그 뒤", `${dur(clock - msOf(gateway.since))} · ${at(gateway.since)}부터`],
				]),
			);
		}

		const beat = d.ok ? d.heartbeat : undefined;
		if (!d.ok) pushCard("sweep", "스윕·하트비트", "warn", noDaemon);
		else if (beat === undefined) pushCard("sweep", "스윕·하트비트", "warn", note("하트비트 기록이 아직 없어요."));
		else {
			pushCard(
				"sweep",
				"스윕·하트비트",
				beat.ageMs > GATE_LIMITS.sweepStalledMs ? "warn" : "ok",
				facts([
					["나이", `${dur(beat.ageMs)} 전 · ${at(beat.at)}`],
					["loop", beat.loopMs === undefined ? "-" : `${beat.loopMs}ms`],
					["기준", `${dur(GATE_LIMITS.sweepStalledMs)} 넘으면 주의`],
				]),
			);
		}

		if (!d.ok) pushCard("ledger", "전달 장부", "warn", noDaemon);
		else {
			pushCard(
				"ledger",
				"전달 장부",
				d.ledger.ambiguous + d.ledger.expired > 0 ? "warn" : "ok",
				facts([
					["대기", String(d.ledger.pending)],
					["보내는 중", String(d.ledger.inflight)],
					["확인", String(d.ledger.confirmed)],
					["모호", String(d.ledger.ambiguous)],
					["만료", String(d.ledger.expired)],
				]),
			);
		}

		const backup = s.backup;
		if (!backup.ok) pushCard("backup", "백업", "bad", note(backup.error));
		else {
			const max = GATE_LIMITS.backupMaxAgeMs;
			const stale = (age: { ageMs: number } | null | undefined): boolean =>
				age === undefined || (age !== null && age.ageMs > max);
			const stamped = (age: { at: string; ageMs: number } | undefined, none: string): string =>
				age === undefined
					? none
					: `${at(age.at)} · ${dur(age.ageMs)} 전${age.ageMs > max ? ` ${badge("오래됨", "is-warning")}` : ""}`;
			pushCard(
				"backup",
				"백업",
				backup.local === undefined ? "bad" : stale(backup.local) || stale(backup.offsite) ? "warn" : "ok",
				facts([
					["로컬", stamped(backup.local, badge("기록 없음", "is-danger"))],
					[
						"오프사이트",
						backup.offsite === null ? "설정 안 됨" : stamped(backup.offsite, badge("기록 없음", "is-warning")),
					],
					["기준", `${Math.round(max / 3_600_000)}시간 안에 한 번`],
				]),
			);
		}

		const gates = s.gates;
		if (!gates.ok) pushCard("gates", "게이트", "bad", note(`게이트를 읽지 못했어요: ${gates.error}`), true);
		else {
			const filteredGates = gates.items
				.slice()
				.sort((a, b) => Number(b.state === "open") - Number(a.state === "open"))
				.filter((gate) =>
					hit(
						"gates",
						"게이트",
						gate.name,
						gateText(gate.name).label,
						gate.detail,
						gate.state === "open" ? "열림" : "닫힘",
					),
				);
			const lines = filteredGates.map((gate) => {
				const open = gate.state === "open";
				return `<li class="gate-row${open ? " is-open" : ""}" data-gate="${esc(gate.name)}" data-state="${esc(
					gate.state,
				)}"><span class="sys-dot ${open ? "is-warning" : "is-success"}" aria-hidden="true"></span><span class="gate-word">${
					open ? "열림" : "닫힘"
				}</span><span class="gate-label">${esc(gateText(gate.name).label)}</span><code class="gate-detail">${esc(
					gate.detail,
				)}</code></li>`;
			});
			if (lines.length > 0 || q === "") {
				pushCard(
					"gates",
					`게이트 ${gates.items.length}개`,
					gates.items.some((gate) => gate.state === "open") ? "warn" : "ok",
					`<ul class="gate-list">${lines.join("")}</ul>`,
					true,
				);
			}
		}

		const monitorCount = d.ok ? d.monitors.count : s.monitors.ok ? s.monitors.items.length : 0;
		const troubled = s.monitors.ok
			? s.monitors.items.filter((monitor) => monitor.openIncidents > 0 || monitor.failStreak > 0).length
			: 0;
		const herdr = s.herdr;
		const hosts = herdr.ok ? herdr.hosts.filter((host) => host.ok || host.error !== "herdr is not configured") : [];
		const machines =
			live !== undefined
				? live.machines
						.map((machine) =>
							badge(
								`${machine.name}${machine.connected ? " · 연결" : " · 끊김"}`,
								machine.connected ? "" : "is-danger",
							),
						)
						.join(" ") || "머신 없음"
				: board !== undefined
					? badge("보드 연결 안 됨", "is-danger")
					: !herdr.ok
						? badge("읽기 실패", "is-danger")
						: hosts.length === 0
							? "herdr 설정 없음"
							: hosts
									.map((host) =>
										badge(
											host.ok ? `${host.host} · 에이전트 ${host.agents.length}` : `${host.host} · 연결 실패`,
											host.ok ? "" : "is-danger",
										),
									)
									.join(" ");
		const herdrDown =
			(board !== undefined && !board.ok) ||
			live?.machines.some((machine) => !machine.connected) === true ||
			!herdr.ok ||
			hosts.some((host) => !host.ok);
		pushCard(
			"monitors",
			"모니터·herdr 머신",
			herdrDown || troubled > 0 || !s.monitors.ok ? "warn" : "ok",
			facts([
				["모니터", `${monitorCount}개${troubled > 0 ? ` · 사건 ${troubled}` : ""}`],
				["herdr 머신", machines],
			]),
		);

		return `${head("시스템", undefined)}${banners.join("")}${
			cards.length === 0 ? nothing : `<div class="sys-grid">${cards.join("")}</div>`
		}`;
	};

	// ---- top bar and side navigation ----
	const chips: string[] = [];
	if (!d.ok) chips.push(badge("데몬 상태 모름", "is-danger"));
	else {
		chips.push(d.running ? badge("데몬 켜짐", "is-success") : badge("데몬 꺼짐", "is-danger"));
		const socket = d.heartbeat?.socket;
		if (socket) chips.push(socket.state === "up" ? badge("소켓 연결", "is-success") : badge("소켓 끊김", "is-danger"));
		chips.push(
			d.openGates.length === 0
				? badge("게이트 정상", "is-success")
				: badge(`게이트 ${d.openGates.length}개 열림`, "is-warning"),
		);
		if (d.frozen) chips.push(badge("동결", "is-warning"));
		if (d.drain || d.heartbeat?.draining) chips.push(badge("drain", "is-warning"));
	}
	if (board !== undefined && !board.ok) chips.push(badge("보드 끊김", "is-danger"));
	chips.push(badge(`갱신 ${s.generatedAt.slice(11, 19)}`, ""));

	const count = <T>(section: { ok: true; items: T[] } | { ok: false; error: string }): number =>
		section.ok ? section.items.length : 0;
	const warnOf = (section: { ok: boolean }, warn: boolean): boolean => !section.ok || warn;
	/** Only alerts whose gate is open right now warn; closed-gate records are a grey count. */
	const openAlerts = s.alerts.ok ? s.alerts.items.filter((alert) => alert.gateState === "open").length : 0;
	const NAV: Record<string, [number, boolean]> = {
		// Entries in the 진행 중 column, like the turns item; an entry in 확인 필요 lights the warning.
		inbox: [
			entries.filter((entry) => entry.col === "working").length,
			!s.tasks.ok || entries.some((entry) => entry.col === "attention"),
		],
		// Threads in the 진행 중 column, the same number the column shows; a thread in 확인 필요 or a troubled job
		// lights the warning. Running jobs are counted in the view's head, not here.
		turns: [
			s.turns.ok ? s.turns.threads.filter((thread) => thread.column === "working").length : 0,
			warnOf(s.turns, s.turns.ok && s.turns.threads.some((thread) => thread.column === "attention")) ||
				warnOf(s.jobs, s.jobs.ok && s.jobs.items.some((job) => job.health !== "ok")),
		],
		lanes: [count(s.lanes), !s.lanes.ok],
		approvals: [count(s.approvals), warnOf(s.approvals, count(s.approvals) > 0)],
		monitors: [
			count(s.monitors),
			warnOf(
				s.monitors,
				s.monitors.ok && s.monitors.items.some((monitor) => monitor.openIncidents > 0 || monitor.failStreak > 0),
			),
		],
		alerts: openAlerts > 0 ? [openAlerts, true] : [count(s.alerts), !s.alerts.ok],
		system: [d.ok ? d.openGates.length : 0, !d.ok || !d.running || d.openGates.length > 0 || d.frozen !== undefined],
	};
	// The flow view is reached from a conversation's or a TASK's detail panel, not the side nav.
	const nav = VIEWS.filter(([id]) => id !== "flow")
		.map(([id, label]) => {
			const [n, warn] = NAV[id] ?? [0, false];
			const current = id === view || (id === "inbox" && view === "list");
			return `<a class="nav-item" href="${id === "inbox" ? "./" : `?view=${id}`}" data-view="${id}"${
				current ? ' aria-current="page"' : ""
			}><span>${esc(label)}</span><span class="nav-count${warn ? " is-warn" : ""}">${n}</span>${navIcon(id)}</a>`;
		})
		.join("");
	const hasLayout = view === "inbox" || view === "list" || view === "turns";
	const layout = view === "list" || (view === "turns" && ui.layout === "list") ? "list" : "board";
	// The turns view switches between its own board and table; inbox and list switch between theirs.
	const [boardHref, listHref] =
		view === "turns" ? ["?view=turns", "?view=turns&amp;layout=list"] : ["./", "?view=list"];
	const layoutSeg = hasLayout
		? `<div class="seg" role="group" aria-label="보기 방식"><a class="seg-item" href="${boardHref}" data-layout="board"${
				layout === "board" ? ' aria-current="true"' : ""
			}>Board</a><a class="seg-item" href="${listHref}" data-layout="list"${layout === "list" ? ' aria-current="true"' : ""}>List</a></div>`
		: "";
	const themeBtn = (mode: string, text: string): string =>
		`<button type="button" class="seg-item" data-theme-set="${mode}" aria-pressed="${theme === mode}">${text}</button>`;
	const topbar = `<header class="topbar"><nav class="crumbs" aria-label="위치"><span>ompbot</span><span aria-hidden="true">/</span><span aria-current="page">${esc(
		viewLabel,
	)}</span></nav><div class="status-chips" aria-label="봇 상태">${chips.join("")}</div><div class="top-tools">${layoutSeg}<div class="seg" role="group" aria-label="테마">${themeBtn("system", "시스템")}${themeBtn("light", "라이트")}${themeBtn("dark", "다크")}</div><button type="button" class="cmd-trigger" data-cmd-open aria-label="명령 팔레트 열기"><span>명령</span><kbd>⌘K</kbd></button></div></header>`;
	const content = view === "inbox" ? inboxView() : view === "list" ? listView() : sectionView();
	return `${topbar}<nav class="sidenav" aria-label="보기">${nav}</nav><main class="view" id="view" aria-label="${esc(
		viewLabel,
	)}" tabindex="-1">${content}</main>`;
}

/**
 * A TASK's facts for the detail panel: ID and risk, branch, machine, AC and step progress, PROGRESS, blocker, worker.
 * Only what the snapshot already carries. Self-contained (shipped to the page).
 */
export function renderTaskFacts(task: TaskInfo): string {
	const esc = (value: unknown): string =>
		String(value ?? "")
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	const at = (iso: string | undefined): string => (iso ? esc(iso.slice(0, 16).replace("T", " ")) : "-");
	const percent =
		task.acChecked === undefined || task.acTotal === 0 ? 0 : Math.round((task.acChecked / task.acTotal) * 100);
	const acValue =
		task.acChecked === undefined
			? !task.open
				? `${task.acTotal}개`
				: `-/${task.acTotal}`
			: `${task.acChecked}/${task.acTotal}<span class="meter" role="img" aria-label="AC ${percent}%"><i style="width:${percent}%"></i></span>`;
	const rows: Array<[string, string]> = [
		["TASK", `<span class="mono">${esc(task.taskId)}</span> · 위험 ${esc(task.risk)}`],
		["브랜치", `<code>${esc(task.branch)}</code>`],
		["머신", `${esc(task.host)} · ${esc(task.agent)}`],
		["AC 충족", acValue],
		[
			"단계",
			`${task.stepsDone === undefined ? "-" : `${task.stepsDone}/${task.stepsTotal ?? "-"}`}${
				task.progress?.current ? ` · 지금 ${esc(task.progress.current)}` : ""
			}`,
		],
		["PROGRESS", task.progress ? `${esc(task.progress.status || "?")} · ${at(task.progress.updated)}` : "-"],
	];
	if (task.progress?.blockedReason) rows.push(["막힌 이유", esc(task.progress.blockedReason)]);
	if (task.herdr !== undefined) {
		rows.push([
			"워커",
			task.herdr.ok ? esc(task.herdr.status) : `<span class="is-error">${esc(task.herdr.error)}</span>`,
		]);
	}
	if (task.error) rows.push(["판정 오류", `<span class="is-error">${esc(task.error)}</span>`]);
	rows.push(["갱신", at(task.updatedAt)]);
	if (task.closedAt) rows.push(["닫힘", at(task.closedAt)]);
	const item = (done: boolean, word: string, tone: string, id: string, text: string): string =>
		`<li class="${done ? "is-done" : ""}"><span class="badge ${tone}">${word}</span><span><b>${esc(id)}</b> ${esc(text)}</span></li>`;
	const checks =
		task.acceptance === undefined || task.acceptance.length === 0
			? ""
			: `<h3 class="h3">AC 체크 목록</h3><ol class="checks" aria-label="AC 체크 목록">${task.acceptance
					.map((ac) =>
						item(ac.checked, ac.checked ? "충족" : "미충족", ac.checked ? "is-success" : "is-warning", ac.id, ac.text),
					)
					.join("")}</ol>`;
	const now = (task.progress?.current ?? "").split(/[\s:]/, 1)[0];
	const steps =
		task.steps === undefined || task.steps.length === 0
			? ""
			: `<h3 class="h3">단계</h3><ol class="checks" aria-label="단계 목록">${task.steps
					.map((step) =>
						step.done
							? item(true, "완료", "is-success", step.id, step.text)
							: step.id === now
								? item(false, "지금", "is-info", step.id, step.text)
								: item(false, "남음", "", step.id, step.text),
					)
					.join("")}</ol>`;
	return `<dl class="facts">${rows.map(([name, value]) => `<dt>${esc(name)}</dt><dd>${value}</dd>`).join("")}</dl>${checks}${steps}`;
}

/**
 * The `slack://` link that opens a conversation's Slack thread in the app (`<C>:<ts>`), or its channel for a ref with
 * no message ts (a monitor's `<C>:-`); "" without the workspace id or a usable ref. The dashboard only reads: the owner
 * steps into a running turn by replying in that thread. Self-contained (shipped to the page).
 */
export function slackThreadHref(team: string | null | undefined, threadRef: string | null | undefined): string {
	const ref = /^([CDG][A-Z0-9]+):(\d+\.\d+)?/.exec(threadRef ?? "");
	if (!team || ref === null) return "";
	const thread = ref[2] === undefined ? "" : `&message=${ref[2]}&thread_ts=${ref[2]}`;
	return `slack://channel?team=${encodeURIComponent(team)}&id=${ref[1]}${thread}`;
}

/**
 * The `https://discord.com/channels/…` link that opens a Discord conversation: a DM at its message
 * (`discord/dm/…`, `<dm>:<message>`), a server thread or a lane (`<parent>:<thread>`) at the thread, a server channel
 * at its message. "" for a ref that is not two snowflakes, or a server conversation without the one server id (a DM
 * needs none). Self-contained (shipped to the page).
 */
export function discordThreadHref(
	guild: string | null | undefined,
	originKey: string | null | undefined,
	threadRef: string | null | undefined,
): string {
	const ref = /^(\d{17,20}):(\d{17,20})$/.exec(threadRef ?? "");
	if (ref === null) return "";
	const key = originKey ?? "";
	if (key.startsWith("discord/dm/")) return `https://discord.com/channels/@me/${ref[1]}/${ref[2]}`;
	if (!guild) return "";
	if (/^discord\/ch\/\d+\/t\/\d+$/.test(key) || key.startsWith("ompbot/work/")) {
		return `https://discord.com/channels/${guild}/${ref[2]}`;
	}
	if (key.startsWith("discord/ch/")) return `https://discord.com/channels/${guild}/${ref[1]}/${ref[2]}`;
	return "";
}

/**
 * A request's TASK chain: the `지금` line and the row of boxes, 요청 first. `focus` marks one TASK box as selected.
 * In the flow view (`panel` false) a TASK box opens its panel in place; inside another view's detail panel (`panel`
 * true) the chain comes in its own section with the `n/m 끝남` count and the boxes go to the flow view's page, since
 * closed TASKs past the snapshot's limit only have a panel there. Self-contained (shipped to the page).
 */
export function renderFlowChain(chain: FlowChainInfo, focus: string, panel: boolean): string {
	const esc = (value: unknown): string =>
		String(value ?? "")
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	const at = (iso: string | null | undefined): string => (iso ? iso.slice(5, 16).replace("T", " ") : "-");
	/** status → [chip, tone of the chip]. */
	const CHIPS: Record<string, [string, string]> = {
		working: ["진행 중", "run"],
		blocked: ["막힘", "fail"],
		review: ["리뷰 대기", "wait"],
		done: ["완료", "done"],
		cancelled: ["취소", "off"],
	};
	const place = chain.place ?? "";
	const request = `<span class="flow-bh"><b>요청</b><span class="flow-chip c-off">${esc(
		[place, at(chain.requestedAt)].filter((part) => part !== "" && part !== "-").join(" · ") || "?",
	)}</span></span><span class="flow-bt">${esc(chain.title)}</span>`;
	const requestBox =
		chain.originKey === ""
			? `<div class="flow-box t-req">${request}</div>`
			: `<a class="flow-box t-req" href="?view=turns&amp;item=${esc(encodeURIComponent(chain.originKey))}">${request}</a>`;
	const boxes = chain.tasks
		.map((step) => {
			const [chip, chipTone] = CHIPS[step.status] ?? [step.status, "off"];
			const here = step.taskId === chain.here;
			const selected = step.taskId === focus;
			const chars = Array.from(step.stage.msg.replace(/\s+/g, " ").trim());
			const clipped = chars.length > 50 ? `${chars.slice(0, 49).join("")}…` : chars.join("");
			const msg = clipped !== "" && step.stage.tone !== "done" ? ` · ${clipped}` : "";
			const open = panel ? "" : ` data-item="${esc(step.taskId)}" data-row="${esc(step.taskId)}"`;
			return `<span class="flow-arr" aria-hidden="true">→</span><a class="flow-box t-${esc(step.stage.tone)}${
				here ? " is-here" : ""
			}${selected ? " is-selected" : ""}" href="?view=flow&amp;item=${esc(encodeURIComponent(step.taskId))}"${open} data-state="${esc(
				`${step.status}:${step.stage.label}`,
			)}"${selected ? ' aria-current="true"' : ""}><span class="flow-bh"><b>${esc(
				step.taskId,
			)}</b><span class="flow-chip c-${chipTone}">${esc(chip)}</span>${
				here ? '<span class="flow-here-chip">지금 여기</span>' : ""
			}</span><span class="flow-bt">${esc(step.title)}</span><span class="flow-bs s-${esc(step.stage.tone)}">${esc(
				step.stage.label,
			)}${esc(msg)}</span></a>`;
		})
		.join("");
	const body = `<p class="flow-now"><b>지금</b> ${esc(chain.now)}</p><div class="flow-row">${requestBox}${boxes}</div>`;
	return panel
		? `<section class="detail-flow" aria-label="흐름"><h3 class="h3">흐름 <small>${chain.done}/${chain.total} 끝남</small></h3>${body}</section>`
		: body;
}

/**
 * The detail panel of `?task=<ID>`: the TASK's title, status and {@link renderTaskFacts}, with a way to its agent's
 * card when the board has one. An ID not in the snapshot gets the "지금 목록에 없는 TASK" notice. Self-contained apart
 * from {@link renderTaskFacts}, which ships beside it.
 */
export function renderTaskDetail(
	taskId: string,
	task: TaskInfo | undefined,
	cardKey?: string,
	chain?: FlowChainInfo,
): string {
	const esc = (value: unknown): string =>
		String(value ?? "")
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	if (task === undefined) {
		return `<p class="eyebrow">TASK ${esc(taskId)}</p><h2 class="detail-title" id="detail-title" tabindex="-1">지금 목록에 없는 TASK예요</h2><p class="lead">닫힌 지 7일이 지났거나 ID가 틀렸어요. 인박스에서 다시 골라 주세요.</p>`;
	}
	const TONES: Record<string, [string, string]> = {
		working: ["진행 중", "is-info"],
		blocked: ["막힘", "is-warning"],
		review: ["검토 대기", "is-warning"],
		done: ["완료", "is-success"],
		cancelled: ["취소", ""],
	};
	const [label, tone] = TONES[task.status] ?? [task.status, ""];
	const card =
		cardKey === undefined
			? ""
			: `<a class="button is-ghost" href="?card=${esc(encodeURIComponent(cardKey))}" data-card="${esc(cardKey)}">에이전트 패널 보기</a>`;
	const actions = `<div class="detail-actions"><span class="badge ${tone}">${esc(label)}</span><button type="button" class="copy-btn" data-copy="${esc(task.taskId)}" data-copy-label="TASK ID" aria-label="TASK ID 복사">TASK ID 복사</button><button type="button" class="copy-btn" data-copy="${esc(task.branch)}" data-copy-label="브랜치" aria-label="브랜치 복사">브랜치 복사</button></div>`;
	const leadText =
		task.acChecked === undefined && !task.open
			? `AC ${task.acTotal}개`
			: `AC ${task.acChecked === undefined ? "-" : task.acChecked}/${task.acTotal} · 단계 ${
					task.stepsDone === undefined ? "-" : `${task.stepsDone}/${task.stepsTotal ?? "-"}`
				}`;
	return `<p class="eyebrow">TASK · ${esc(task.host)}</p><h2 class="detail-title" id="detail-title" tabindex="-1">${esc(
		task.title,
	)}</h2>${actions}<p class="lead">${leadText}</p>${renderTaskFacts(task)}${card}${
		chain === undefined ? "" : renderFlowChain(chain, task.taskId, true)
	}`;
}

/**
 * Head of the card detail panel: what the pane is, where it runs, the "herdr에서 답하기" link and — when the pane
 * carries a TASK — that TASK's facts. A key that is not on the board gets the "지금 보드에 없는 패널" notice.
 * Self-contained apart from {@link renderTaskFacts} (the browser redraws it from the board stream).
 */
export function renderDetailHead(
	key: string,
	card: BoardCard | undefined,
	task: TaskInfo | undefined,
	now: number,
	chain?: FlowChainInfo,
): string {
	const esc = (value: unknown): string =>
		String(value ?? "")
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	if (card === undefined) {
		return `<p class="eyebrow">카드 ${esc(key)}</p><h2 class="detail-title" id="detail-title" tabindex="-1">지금 보드에 없는 패널이에요</h2><p class="lead">패널이 닫혔거나 herdr-web-ui에서 아직 받지 못했어요. 보드에 다시 나타나면 여기에 열려요.</p>`;
	}
	const TONES: Record<string, [string, string]> = {
		working: ["진행 중", "is-info"],
		idle: ["쉬는 중", ""],
		done: ["완료", "is-success"],
		blocked: ["막힘", "is-warning"],
	};
	const [label, tone] = TONES[card.status] ?? [`알 수 없음 · ${card.status}`, "is-warning"];
	const minutes = Math.floor(Math.max(0, now - card.since) / 60_000);
	const ago =
		minutes < 1
			? "방금"
			: minutes < 60
				? `${minutes}분 전`
				: minutes < 1440
					? `${Math.floor(minutes / 60)}시간 전`
					: `${Math.floor(minutes / 1440)}일 전`;
	const badges = [`<span class="badge ${tone}">${esc(label)}</span>`];
	if (card.taskId) badges.push(`<span class="badge is-info">${esc(card.taskId)}</span>`);
	if (task !== undefined) {
		badges.push(
			`<button type="button" class="copy-btn" data-copy="${esc(task.taskId)}" data-copy-label="TASK ID" aria-label="TASK ID 복사">TASK ID 복사</button>`,
			`<button type="button" class="copy-btn" data-copy="${esc(task.branch)}" data-copy-label="브랜치" aria-label="브랜치 복사">브랜치 복사</button>`,
		);
	} else {
		badges.push(
			`<button type="button" class="copy-btn" data-copy="${esc(card.key)}" data-copy-label="카드 키" aria-label="카드 키 복사">카드 키 복사</button>`,
		);
	}
	const lines = [
		`${esc(card.machineName)} · ${esc(card.workspaceLabel)} · ${esc(card.tabLabel)} · ${esc(card.agent)}`,
		card.cwd ? esc(card.cwd) : "",
		`이 상태로 ${ago}부터 · 카드 ${esc(card.key)}`,
	]
		.filter((line) => line !== "")
		.map((line) => `<p class="lead">${line}</p>`)
		.join("");
	const reply = /^https?:\/\//.test(card.replyUrl ?? "")
		? `<a class="button" href="${esc(card.replyUrl)}" target="_blank" rel="noopener noreferrer">herdr에서 답하기</a>`
		: "";
	const about =
		task === undefined
			? ""
			: `<section class="detail-task" aria-label="TASK"><h3 class="h3">${esc(task.taskId)} ${esc(task.title)}</h3>${renderTaskFacts(task)}<a class="button is-ghost" href="?task=${esc(
					encodeURIComponent(task.taskId),
				)}" data-task="${esc(task.taskId)}">TASK만 보기</a></section>`;
	return `<p class="eyebrow">${esc(card.machineName)}</p><h2 class="detail-title" id="detail-title" tabindex="-1">${esc(
		card.paneLabel,
	)}</h2><div class="detail-actions">${badges.join("")}</div>${lines}${reply}${about}${
		chain === undefined || task === undefined ? "" : renderFlowChain(chain, task.taskId, true)
	}`;
}

/**
 * The detail panel of a row of the other views (`?view=<view>&item=<id>`): every field the snapshot has for it, no
 * more. An id not in the snapshot gets the "지금 목록에 없는 항목" notice. A monitor's panel ends in `monitorBody`
 * ({@link renderMonitorDetail}), a loading line until then. Self-contained (shipped to the page).
 */
export function renderItemDetail(s: DashboardSnapshot, view: string, id: string, monitorBody?: string): string {
	const esc = (value: unknown): string =>
		String(value ?? "")
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	const at = (iso: string | null | undefined): string => (iso ? esc(iso.slice(0, 16).replace("T", " ")) : "-");
	const dur = (ms: number | null): string => {
		if (ms === null) return "-";
		const minutes = Math.floor(ms / 60_000);
		if (minutes < 1) return `${Math.max(0, Math.floor(ms / 1000))}초`;
		return minutes < 60 ? `${minutes}분` : `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
	};
	const LABELS: Record<string, string> = {
		turns: "턴",
		flow: "흐름",
		lanes: "레인",
		approvals: "승인 대기",
		monitors: "모니터",
		alerts: "알림",
	};
	const show = (title: string, rows: Array<[string, string]>): string =>
		`<p class="eyebrow">${esc(LABELS[view] ?? view)}</p><h2 class="detail-title" id="detail-title" tabindex="-1">${esc(
			title,
		)}</h2><dl class="facts">${rows.map(([name, value]) => `<dt>${esc(name)}</dt><dd>${value}</dd>`).join("")}</dl>`;
	if (view === "turns" && s.jobs.ok) {
		const job = s.jobs.items.find((item) => `job:${item.name}` === id);
		if (job) {
			const [word] = JOB_LABELS[job.health === "ok" ? (job.state ?? "running") : job.health];
			return show(job.title, [
				["상태", `${esc(word)} · ${esc(job.state ?? "-")}`],
				[
					"진행",
					job.done === undefined || job.total === undefined
						? "-"
						: esc(
								`${job.done}/${job.total}${job.unit ? ` ${job.unit}` : ""}${job.percent === undefined ? "" : ` (${job.percent}%)`}`,
							),
				],
				["시작", at(job.startedAt)],
				["마지막 갱신", at(job.updatedAt)],
				["마지막 갱신 뒤", dur(job.ageMs)],
				["pid", job.pid === undefined ? "-" : `<code>${esc(job.pid)}</code>`],
				["스레드", esc(job.thread ?? "-")],
				["로그", job.log === undefined ? "-" : `<code>${esc(job.log)}</code>`],
				["설명", esc(job.detail ?? "-")],
				["파일", `<code>jobs/${esc(job.name)}.json</code>`],
			]);
		}
	}
	if (view === "turns" && s.turns.ok) {
		// A conversation by its origin key; an inbound id (the old one-turn address) finds the conversation it is in.
		const thread = /^\d+$/.test(id)
			? s.turns.threads.find((item) => item.recent.some((turn) => String(turn.inboundId) === id))
			: s.turns.threads.find((item) => item.originKey === id);
		if (thread) {
			const latest = thread.latest;
			// The conversation's TASK chain, when the request became TASKs.
			const chain = s.flows?.ok ? s.flows.items.find((item) => item.originKey === thread.originKey) : undefined;
			const verdicts = s.feedback.ok ? s.feedback.verdicts : {};
			const feedbackBadge = (inboundId: number): string => {
				const verdict = verdicts[String(inboundId)];
				return verdict === undefined
					? ""
					: `<span class="badge" data-feedback="${verdict}" title="오너 피드백">${verdict === "up" ? "👍" : "👎"}</span>`;
			};
			const recent = thread.recent
				.map(
					(turn) =>
						`<li><button type="button" class="turn-recent-item" data-trace-turn="${esc(turn.inboundId)}"><span class="mono">${at(
							turn.createdAt,
						)}</span><span class="badge">${esc(turn.state)}</span>${feedbackBadge(turn.inboundId)}<span class="turn-recent-text">${esc(
							turn.preview ?? "-",
						)}</span></button></li>`,
				)
				.join("");
			return `${show(thread.title, [
				["상태", esc(latest.state)],
				["종류", esc(TURN_LABELS.kind[thread.kind])],
				["대기 이유", latest.waitReason === null ? "-" : esc(TURN_LABELS.wait[latest.waitReason])],
				["요청", latest.preview === null ? "-" : esc(latest.preview)],
				["시작", at(latest.createdAt)],
				["경과", dur(latest.ageMs)],
				["마지막 이벤트 뒤", dur(latest.silentMs)],
				["스레드", esc(thread.threadRef ?? "-")],
				["입수 번호", esc(latest.inboundId)],
				["턴", esc(`${thread.turnCount}${thread.openCount > 0 ? ` · ${openTurnsText(thread)}` : ""}`)],
				["대화", `<code>${esc(thread.originKey)}</code>`],
			])}${chain === undefined ? "" : renderFlowChain(chain, "", true)}<h3 class="h2">최근 턴</h3><ol class="turn-recent" aria-label="최근 턴 (누르면 트레이스)">${recent}</ol>`;
		}
	}
	if (view === "flow" && s.flows?.ok) {
		// The flow carries every one of its TASKs, closed ones past the snapshot's closed-TASK limit included.
		const chain = s.flows.items.find((item) => item.tasks.some((step) => step.taskId === id));
		const step = chain?.tasks.find((item) => item.taskId === id);
		if (chain && step) {
			const STATUS: Record<string, string> = {
				working: "진행 중",
				blocked: "막힘",
				review: "리뷰 대기",
				done: "완료",
				cancelled: "취소",
			};
			const task = s.tasks.ok ? s.tasks.items.find((item) => item.taskId === id) : undefined;
			return `${show(step.title, [
				["TASK", `<code>${esc(step.taskId)}</code>`],
				["상태", esc(STATUS[step.status] ?? step.status)],
				["지금 단계", esc(`${step.stage.label}${step.stage.msg === "" ? "" : ` · ${step.stage.msg}`}`)],
				["위험", esc(step.risk)],
				["호스트", esc(step.host)],
				["브랜치", `<code>${esc(step.branch)}</code>`],
				["등록", at(step.createdAt)],
				["닫힘", at(step.closedAt)],
				["AC", `${step.acTotal}개`],
				[
					"요청",
					chain.originKey === ""
						? esc(chain.title)
						: `<a href="?view=turns&amp;item=${esc(encodeURIComponent(chain.originKey))}">${esc(chain.title)}</a>`,
				],
			])}${
				task === undefined
					? ""
					: `<section class="detail-task" aria-label="TASK 진행"><h3 class="h3">진행</h3>${renderTaskFacts(task)}</section>`
			}`;
		}
	}
	if (view === "lanes" && s.lanes.ok) {
		const lane = s.lanes.items.find((item) => item.name === id);
		if (lane) {
			return show(lane.title, [
				["이름", esc(lane.name)],
				["상태", esc(lane.status)],
				["cwd", `<code>${esc(lane.cwd)}</code>`],
				["갱신", at(lane.updatedAt)],
			]);
		}
	}
	if (view === "approvals" && s.approvals.ok) {
		// A pending one, else a settled one of 최근 결정: the same panel with the outcome in place of the countdown.
		const item =
			s.approvals.items.find((approval) => approval.approvalId === id) ??
			s.approvals.recent.find((approval) => approval.approvalId === id);
		if (item) {
			// Same order and labels as the Slack card's sections (`DETAIL_SECTIONS` in safety/approval.ts).
			const SECTIONS = [
				["action", "할 일"],
				["why", "이유"],
				["impact", "영향"],
				["rollback", "되돌릴 수 없는 이유"],
			] as const;
			const facts: Array<[string, string]> = [];
			for (const [key, label] of SECTIONS) {
				const value = item.detail?.[key];
				if (value) facts.push([label, esc(value)]);
			}
			if ("status" in item) {
				const word = (APPROVAL_OUTCOMES[item.status] ?? [item.status])[0];
				facts.push(
					["결과", `${esc(word)}${item.tookMs === null ? "" : ` · 요청 ${esc(monitorTook(item.tookMs))} 뒤`}`],
					["요청", at(item.createdAt)],
					["결정", at(item.decidedAt)],
				);
			} else {
				facts.push(
					// Rounded up like the list badge (`N분 남음`), so both read the same minute.
					["남은 시간", item.remainingMs <= 0 ? "만료 처리 중" : `${Math.ceil(item.remainingMs / 60_000)}분`],
					["요청", at(item.createdAt)],
					["만료", at(item.expiresAt)],
				);
			}
			facts.push(["요청한 곳", esc(item.originLabel ?? "-")]);
			const links = [
				item.cardUrl === null
					? ""
					: `<a class="button" href="${esc(item.cardUrl)}" target="_blank" rel="noopener noreferrer">슬랙 카드 열기</a>`,
				item.originUrl === null
					? ""
					: `<a class="button is-ghost" href="${esc(item.originUrl)}" target="_blank" rel="noopener noreferrer">요청 스레드 열기</a>`,
			].join("");
			return `<p class="eyebrow">${"status" in item ? "승인 결정" : esc(LABELS[view])}</p><h2 class="detail-title" id="detail-title" tabindex="-1">${esc(
				item.title,
			)}</h2>${item.summary.trim() === item.title ? "" : `<p class="lead detail-summary">${esc(item.summary)}</p>`}${
				item.detail === null ? '<p class="lead">세부 내용 없음(요약만 받은 요청)</p>' : ""
			}<dl class="facts">${facts.map(([name, value]) => `<dt>${esc(name)}</dt><dd>${value}</dd>`).join("")}</dl>${
				links !== ""
					? `<div class="detail-actions">${links}</div>`
					: "status" in item
						? ""
						: '<p class="lead">슬랙의 승인 메시지에서 승인하거나 거절해요.</p>'
			}<details class="detail-internal"><summary>내부 정보</summary><dl class="facts"><dt>승인 ID</dt><dd><code>${esc(
				item.approvalId,
			)}</code></dd><dt>대화</dt><dd><code>${esc(item.originKey ?? "-")}</code></dd></dl></details>`;
		}
	}
	if (view === "monitors" && s.monitors.ok) {
		// By id; a link from before ids (`item=<name>`) opens the same panel.
		const monitor = s.monitors.items.find((item) => item.id === id || item.name === id);
		if (monitor) {
			const sends = [
				monitor.destination,
				...(monitor.copyTo === null ? [] : [`사본 ${monitor.copyTo}`]),
				monitor.deliver === "verbatim" ? "원문 그대로" : "턴으로 답",
			];
			// Snapshot facts now; the rest once the page has read `api/monitor/detail`.
			return `${show(monitor.name, [
				["일정", `${esc(monitor.schedule)}${monitor.cron === null ? "" : ` <code>${esc(monitor.cron)}</code>`}`],
				["다음 실행", at(monitor.nextFireAt)],
				["겹침 정책", monitor.overlap === "skip" ? "건너뜀" : "줄 세움"],
				["보내는 곳", esc(sends.join(" · "))],
				[
					"모델",
					esc(`${monitor.model ?? "기본 모델"}${monitor.thinking === null ? "" : ` · thinking ${monitor.thinking}`}`),
				],
				[
					"상태",
					esc(
						[
							...(monitor.running ? ["실행 중"] : []),
							...(monitor.failStreak > 0 ? [`연속 실패 ${monitor.failStreak}회`] : []),
							monitor.openIncidents > 0 ? `열린 사건 ${monitor.openIncidents}` : "열린 사건 없음",
						].join(" · "),
					),
				],
				[
					`최근 ${monitor.stats.days}일`,
					esc(
						[
							`전달 ${monitor.stats.delivered}`,
							`조용히 끝남 ${monitor.stats.quiet}`,
							`실패 ${monitor.stats.failed}`,
							...(monitor.stats.skipped > 0 ? [`건너뜀 ${monitor.stats.skipped}`] : []),
							...(monitor.stats.medianMs === null ? [] : [`정기 실행 중앙값 ${monitorTook(monitor.stats.medianMs)}`]),
						].join(" · "),
					),
				],
			])}${
				// The monitor's own conversation, while the turn board still lists it.
				s.turns.ok && s.turns.threads.some((thread) => thread.originKey === monitor.originKey)
					? `<div class="detail-actions"><a class="button is-ghost" href="?view=turns&amp;item=${esc(
							encodeURIComponent(monitor.originKey),
						)}">이 모니터의 대화 보기</a></div>`
					: ""
			}<div class="mon-detail">${
				monitorBody ??
				'<div class="skeleton" role="status"><p class="note-sub">하는 일과 최근 실행을 불러오는 중…</p><div class="skeleton-bar is-w70"></div><div class="skeleton-bar is-w90"></div><div class="skeleton-bar is-w50"></div></div>'
			}</div>`;
		}
	}
	if (view === "alerts" && s.alerts.ok) {
		const alert = s.alerts.items.find((item) => String(item.incidentId) === id);
		if (alert) {
			const text = alertText(alert.scope);
			const gate = text.gate === undefined || !s.gates.ok ? undefined : s.gates.items.find((g) => g.name === text.gate);
			const state =
				alert.gateState === "open"
					? "지금 열림"
					: alert.gateState === "closed"
						? "지금은 닫힘 · 기록만 남음"
						: alert.gateState === "unknown"
							? "상태 모름"
							: "기록만 남음";
			const rows: Array<[string, string]> = [
				["상태", `${esc(state)} · 기록 ${esc(alert.status)}`],
				["할 일", esc(text.todo).replace(/`([^`]+)`/g, "<code>$1</code>")],
				["범위", `<code>${esc(alert.scope)}</code>`],
				[
					"서명",
					`<code>${esc(alert.signature)}</code><button type="button" class="copy-btn" data-copy="${esc(
						alert.signature,
					)}" data-copy-label="서명" aria-label="서명 복사">복사</button>`,
				],
				["인시던트", `<code>${esc(alert.incidentId)}</code>`],
				["횟수", `${alert.count}회`],
				["처음", at(alert.firstAt)],
				["마지막", at(alert.lastAt)],
			];
			if (text.gate !== undefined) {
				rows.push(["게이트 detail", gate === undefined ? "-" : `<code>${esc(gate.detail)}</code>`]);
			}
			return show(text.title, rows);
		}
	}
	return `<p class="eyebrow">${esc(LABELS[view] ?? "항목")}</p><h2 class="detail-title" id="detail-title" tabindex="-1">지금 목록에 없는 항목이에요</h2><p class="lead">처리됐거나 닫혀서 목록에서 빠졌어요. 왼쪽 목록에서 다시 골라 주세요.</p>`;
}

/**
 * A monitor's `api/monitor/detail` answer as its panel's end: 하는 일, procedure files, 최근 실행; all text escaped.
 * Self-contained apart from `MONITOR_STAGES`/`monitorTook` (shipped to the page).
 */
export function renderMonitorDetail(body: unknown): string {
	const esc = (value: unknown): string =>
		String(value ?? "")
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	const answer = (body ?? {}) as {
		instruction?: string;
		procedures?: MonitorProcedure[];
		runs?: MonitorDetailRun[];
		error?: string;
	};
	if (typeof answer.instruction !== "string") {
		return `<p class="note">하는 일과 최근 실행을 읽지 못했어요 (${esc(answer.error ?? "알 수 없는 응답")})</p>`;
	}
	const at = (iso: string): string => esc(iso.slice(5, 16).replace("T", " "));
	const files = (Array.isArray(answer.procedures) ? answer.procedures : [])
		.map(
			(file) =>
				`<h3 class="h2">절차 파일 <code>${esc(file.name)}</code></h3>${
					"text" in file
						? `<pre class="mon-text">${esc(file.text)}</pre>${file.truncated ? '<p class="note-sub">앞 2000자만 보여요.</p>' : ""}`
						: '<p class="note">지금 읽을 수 없어요.</p>'
				}`,
		)
		.join("");
	const runs = (Array.isArray(answer.runs) ? answer.runs : []).map((run) => {
		const [word, tone] = MONITOR_STAGES[run.stage] ?? [run.stage || "?", ""];
		const took =
			run.durationMs === null ? "진행 중" : `${run.attempts > 0 ? "지연 포함 " : ""}${monitorTook(run.durationMs)}`;
		const notes = [
			...(run.manual ? ["수동"] : []),
			...(run.attempts > 0 ? [`재시도 ${run.attempts}회`] : []),
			...(run.error ? [run.error] : []),
		];
		return `<tr><td class="num">${at(run.slotAt)}</td><td><span class="mon-dot ${tone}${
			run.manual ? " is-manual" : ""
		}" aria-hidden="true"></span> ${esc(word)}</td><td>${esc(took)}</td><td>${
			notes.length === 0 ? "-" : esc(notes.join(" · "))
		}</td></tr>`;
	});
	return `<h3 class="h2">하는 일</h3><pre class="mon-text" data-block="instruction">${esc(
		answer.instruction,
	)}</pre>${files}<h3 class="h2">최근 실행</h3>${
		runs.length === 0
			? '<p class="note">실행 기록이 아직 없어요.</p>'
			: `<table class="mon-runs"><thead><tr><th scope="col">예정 시각</th><th scope="col">결과</th><th scope="col">끝날 때까지</th><th scope="col">비고</th></tr></thead><tbody>${runs.join(
					"",
				)}</tbody></table>`
	}`;
}

/**
 * The detail panel's tab buttons: a herdr card's 개요/대화/plan, or a conversation's 개요/대화/트레이스 (turn board).
 * Self-contained (shipped to the page).
 */
export function renderDetailTabs(mode: "card" | "thread", selected: string): string {
	const tabs =
		mode === "thread"
			? [
					["head", "개요", "detail-head"],
					["conv", "대화", "detail-conv"],
					["trace", "트레이스", "detail-trace"],
				]
			: [
					["head", "개요", "detail-head"],
					["conv", "대화", "detail-conv"],
					["plan", "plan", "detail-plan"],
				];
	return tabs
		.map(
			([id, label, panel]) =>
				`<button id="tab-${id}" class="tab" type="button" role="tab" data-tab="${id}" aria-controls="${panel}" aria-selected="${id === selected}">${label}</button>`,
		)
		.join("");
}

/** herdr-web-ui's plan answer as a step list; nothing when the pane has no plan. Self-contained (shipped to the page). */
export function renderPlan(body: unknown): string {
	const esc = (value: unknown): string =>
		String(value ?? "")
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	const steps = (body as { plan?: { steps?: unknown } | null } | null)?.plan?.steps;
	if (!Array.isArray(steps) || steps.length === 0) return "";
	const WORDS: Record<string, [string, string]> = {
		pending: ["대기", ""],
		in_progress: ["진행", "is-info"],
		completed: ["완료", "is-success"],
	};
	const items = steps.map((step: { label?: unknown; status?: unknown; active?: unknown } | null) => {
		const status = String(step?.status ?? "");
		const [word, tone] = WORDS[status] ?? [status || "?", ""];
		const active = typeof step?.active === "string" && step.active !== "" ? ` · ${esc(step.active)}` : "";
		return `<li><span class="badge ${tone}">${esc(word)}</span><span>${esc(step?.label)}${active}</span></li>`;
	});
	return `<h3 class="h2">plan</h3><ol class="plan">${items.join("")}</ol>`;
}

/**
 * herdr-web-ui's conversation answer (`{ turns, cursor }`) as turn cards, oldest first, with "이전 대화 더 보기" when
 * a page before them exists. Message text goes through `md` (the page passes {@link renderMarkdown}); every other
 * string is escaped. Self-contained (shipped to the page).
 */
export function renderConversation(body: unknown, agent: string, md: (text: string) => string, now: number): string {
	const esc = (value: unknown): string =>
		String(value ?? "")
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	const answer = (body ?? {}) as { turns?: unknown; cursor?: unknown };
	if (!Array.isArray(answer.turns)) return '<p class="block-note">대화를 읽지 못했어요</p>';
	const more =
		typeof answer.cursor === "string"
			? `<button class="more" type="button" data-before="${esc(answer.cursor)}">이전 대화 더 보기</button>`
			: "";
	if (answer.turns.length === 0) return `<h3 class="h2">대화</h3>${more}<p class="block-note">아직 대화가 없어요</p>`;
	const OUTPUT_CHARS = 4000;
	const fold = (title: string, inner: string, cls = ""): string =>
		`<details class="fold${cls ? ` ${cls}` : ""}"><summary>${title}</summary>${inner}</details>`;
	const part = (p: Record<string, unknown> | null): string => {
		const text = typeof p?.text === "string" ? p.text : "";
		switch (p?.kind) {
			case "text":
				return `<div class="md">${md(text)}</div>`;
			case "thinking":
				return fold("생각", `<div class="md">${md(text)}</div>`);
			case "compact":
				return fold("이전 대화 요약", `<div class="md">${md(text)}</div>`);
			case "tool": {
				const output = typeof p.output === "string" ? p.output : "";
				const cut =
					output.length > OUTPUT_CHARS ? `<p class="turn-note">… ${output.length - OUTPUT_CHARS}자 생략</p>` : "";
				// `running`: a call with no result yet (omp sessions); herdr parts never carry it.
				const running = p.running === true;
				return fold(
					`<code class="mono"><b>${esc(p.name)}</b></code> <span>${esc(p.summary)}</span>${
						running
							? ' <span class="badge is-info">진행 중</span>'
							: p.error
								? ' <span class="badge is-danger">실패</span>'
								: ' <span class="badge is-success">완료</span>'
					}`,
					output === ""
						? `<p class="turn-note">${running ? "결과를 기다리는 중" : "출력 없음"}</p>`
						: `<pre class="md-code"><code>${esc(output.slice(0, OUTPUT_CHARS))}</code></pre>${cut}`,
					"tool-call",
				);
			}
			case "image":
				return '<p class="turn-note">이미지</p>';
			case "notice":
				return `<p class="turn-note">${esc(text)}</p>`;
			case "skill":
				return `<p class="turn-note">스킬 ${esc((p.skill as { name?: unknown } | undefined)?.name)}</p>`;
			case "task_result":
				return `<ul class="turn-tasks">${(Array.isArray(p.tasks) ? p.tasks : [])
					.map(
						(task: { title?: unknown; status?: unknown } | null) =>
							`<li>${esc(task?.title)} · ${esc(task?.status)}</li>`,
					)
					.join("")}</ul>`;
			default:
				return "";
		}
	};
	const turns = answer.turns.map((turn: { role?: unknown; ts?: unknown; parts?: unknown } | null) => {
		const user = turn?.role === "user";
		const at = typeof turn?.ts === "number" ? turn.ts : typeof turn?.ts === "string" ? Date.parse(turn.ts) : Number.NaN;
		const minutes = Math.floor(Math.max(0, now - at) / 60_000);
		const when = Number.isNaN(at)
			? ""
			: minutes < 1
				? "방금"
				: minutes < 60
					? `${minutes}분 전`
					: minutes < 1440
						? `${Math.floor(minutes / 60)}시간 전`
						: `${Math.floor(minutes / 1440)}일 전`;
		const parts = (Array.isArray(turn?.parts) ? turn.parts : []).map(part).join("");
		return `<article class="turn${user ? " is-user" : ""}"><p class="turn-head"><b>${user ? "나" : esc(agent)}</b><span>${when}</span></p>${parts}</article>`;
	});
	return `<h3 class="h2">대화</h3>${more}${turns.join("")}`;
}

/**
 * The "생성 중" block under the conversation from a daemon `live` view: the text being written (through `md`), its
 * thinking (folded), tool calls being written, running tools with their output tail, and a retry line. `settling`:
 * the message ended and the block stays as "확정 중" until the conversation is read again; `error`: the daemon
 * cannot be asked; `fail`: that read failed; `elapsedMs`: time since the view arrived, added to tool ages. Empty when
 * there is nothing to show. Every string but the text and thinking is escaped. Self-contained (shipped to the page).
 */
export function renderLiveTurn(
	live: unknown,
	md: (text: string) => string,
	state: { settling?: boolean; error?: string; fail?: string; elapsedMs?: number },
): string {
	const esc = (value: unknown): string =>
		String(value ?? "")
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	if (state.error === "daemon_unreachable") {
		return '<p class="turn-note live-down">데몬에 연결할 수 없어 실시간 내용을 못 받고 있어요</p>';
	}
	const view = (live ?? {}) as {
		text?: unknown;
		thinking?: unknown;
		toolCalls?: unknown;
		running?: unknown;
		retry?: { attempt?: unknown; error?: unknown } | null;
	};
	const text = typeof view.text === "string" ? view.text : "";
	const thinking = typeof view.thinking === "string" ? view.thinking : "";
	const calls = Array.isArray(view.toolCalls) ? view.toolCalls : [];
	const running = Array.isArray(view.running) ? view.running : [];
	const retry = view.retry ?? undefined;
	if (text === "" && thinking === "" && calls.length === 0 && running.length === 0 && retry === undefined) return "";
	const extra = Math.max(0, state.elapsedMs ?? 0);
	const age = (ms: unknown): string => {
		const seconds = Math.floor(((typeof ms === "number" ? ms : 0) + extra) / 1000);
		return seconds < 60 ? `${seconds}초` : `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
	};
	const head = state.settling
		? '<span class="live-state">확정 중</span>'
		: '<span class="live-state"><span class="live-spin" aria-hidden="true"></span>생성 중</span>';
	const parts = [
		retry === undefined ? "" : `<p class="turn-note">재시도 ${esc(retry.attempt)}회 · ${esc(retry.error)}</p>`,
		thinking === ""
			? ""
			: `<details class="fold" data-fold="thinking"><summary>생각</summary><div class="md">${md(thinking)}</div></details>`,
		text === "" ? "" : `<div class="md">${md(text)}</div>`,
		...calls.map(
			(call: { name?: unknown; summary?: unknown } | null) =>
				`<p class="live-tool"><code class="mono"><b>${esc(call?.name)}</b></code> <span>${esc(call?.summary)}</span> <span class="badge">준비 중</span></p>`,
		),
		...running.map(
			(tool: { name?: unknown; summary?: unknown; ageMs?: unknown; outputTail?: unknown } | null, i: number) =>
				`<details class="fold tool-call" data-fold="run-${i}" open><summary><code class="mono"><b>${esc(tool?.name)}</b></code> <span>${esc(tool?.summary)}</span> <span class="badge is-info">진행 중 · ${age(tool?.ageMs)}</span></summary>${
					typeof tool?.outputTail === "string" && tool.outputTail !== ""
						? `<pre class="md-code"><code>${esc(tool.outputTail)}</code></pre>`
						: '<p class="turn-note">출력을 기다리는 중</p>'
				}</details>`,
		),
		state.fail ? `<p class="turn-note">${esc(state.fail)}</p>` : "",
	];
	return `<article class="turn is-live${state.settling ? " is-settling" : ""}" aria-busy="${state.settling ? "false" : "true"}"><p class="turn-head"><b>omp</b>${head}</p>${parts.join("")}</article>`;
}

/**
 * Inline script: the renderers above as shipped source, then the page wiring — the 15-second snapshot refresh, the
 * board stream (`api/board/events`, only with a board), view switching (`?view=`), search and List sorting, theme
 * persistence, keyboard navigation (`j`/`k`, `Enter`, `Esc`, `g <key>`, `/`, `?`, `⌘K`/`Ctrl+K`), copy toast, and the
 * detail panel (`?card=`, `?task=`, `?item=` in the address; a card's conversation and plan read through
 * `api/pane/*`). Every request is relative to the page, so any tunnel prefix works.
 */
const SCRIPT = `const GATE_LIMITS = ${JSON.stringify(GATE_LIMITS)};
const TURN_LABELS = ${JSON.stringify(TURN_LABELS)};
const JOB_LABELS = ${JSON.stringify(JOB_LABELS)};
const MONITOR_STAGES = ${JSON.stringify(MONITOR_STAGES)};
const APPROVAL_OUTCOMES = ${JSON.stringify(APPROVAL_OUTCOMES)};
const monitorTook = ${monitorTook.toString()};
const gateText = ${gateText.toString()};
const alertText = ${alertText.toString()};
const openTurnsText = ${openTurnsText.toString()};
const renderDashboardMain = ${renderDashboardMain.toString()};
const renderTaskFacts = ${renderTaskFacts.toString()};
const renderFlowChain = ${renderFlowChain.toString()};
const slackThreadHref = ${slackThreadHref.toString()};
const discordThreadHref = ${discordThreadHref.toString()};
const renderTaskDetail = ${renderTaskDetail.toString()};
const renderDetailHead = ${renderDetailHead.toString()};
const renderItemDetail = ${renderItemDetail.toString()};
const renderMonitorDetail = ${renderMonitorDetail.toString()};
const renderDetailTabs = ${renderDetailTabs.toString()};
const renderPlan = ${renderPlan.toString()};
const renderConversation = ${renderConversation.toString()};
const renderLiveTurn = ${renderLiveTurn.toString()};
const renderMarkdown = ${renderMarkdown.toString()};
const renderTrace = ${renderTrace.toString()};
${TRACE_CLIENT}
function boot() {
	const main = document.getElementById("main");
	const stale = document.getElementById("stale");
	const search = document.getElementById("search");
	const detail = document.getElementById("detail");
	const tabs = document.getElementById("detail-tabs");
	const head = document.getElementById("detail-head");
	const plan = document.getElementById("detail-plan");
	const conv = document.getElementById("detail-conv");
	const traceHost = document.getElementById("detail-trace");
	const trace = traceController(traceHost);
	const closer = detail.querySelector("[data-close]");
	const cmdModal = document.getElementById("cmd-palette");
	const cmdInput = document.getElementById("cmd-input");
	const cmdList = document.getElementById("cmd-list");
	const helpModal = document.getElementById("kb-help");
	const toast = document.getElementById("toast");
	const boardOn = main.getAttribute("data-board") === "1";
	const LABELS = { card: "카드 상세", task: "TASK 상세", item: "항목 상세" };
	let snapshot = null;
	// The board the server drew the page with, so the first snapshot refresh does not redraw without it.
	const seeded = boardOn ? document.getElementById("board-data") : null;
	let board = seeded && seeded.textContent ? JSON.parse(seeded.textContent) : null;
	const ui = { view: "inbox", q: "", sort: "", desc: false, theme: "system", layout: "" };
	let open = null;
	let tab = "head";
	// The turn the 트레이스 tab shows when not the thread's last one (a 최근 턴 row, or the old one-turn address).
	let traceTurn = null;
	// The open thread's updatedAt and last turn as the snapshot last told them: a change reads its conversation again.
	let threadSeen = "";
	// The open monitor's \`api/monitor/detail\` answer as drawn by renderMonitorDetail; null while it is being read.
	let monitorHtml = null;
	let drawnMain = "";
	let drawnHead = "";
	let loadedKey = null;
	let turns = [];
	let cursor;
	let paged = false;
	let generation = 0;
	// The 대화 tab's live stream (one at a time) and its block: the last view, when it came, and while "확정 중" the
	// ended message kept on screen until a conversation read started after the end (ticket) has drawn it for good.
	let liveSource = null;
	let liveOrigin = null;
	let liveView = null;
	let liveAt = 0;
	let liveKept = null;
	let liveError = "";
	let liveFail = "";
	let drawnLive = "";
	let loadTicket = 0;
	let settleTicket = Infinity;
	let reloading = null;
	let reloadAgain = false;
	let toastTimer = null;
	let chordTimer = null;
	let gPending = false;
	let cmdItems = [];
	let cmdIdx = 0;
	let prevFocus = null;
	const prevStates = new Map();
	const changedUntil = new Map();

	const resolveTheme = (mode) => {
		if (mode === "light" || mode === "dark") return mode;
		return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
	};
	const applyTheme = (mode, save) => {
		const valid = mode === "light" || mode === "dark" ? mode : "system";
		ui.theme = valid;
		if (save) {
			try {
				localStorage.setItem("ompbot-theme", valid);
			} catch {}
		}
		document.documentElement.setAttribute("data-theme", resolveTheme(valid));
		document.documentElement.setAttribute("data-theme-mode", valid);
		for (const btn of document.querySelectorAll("[data-theme-set]")) {
			btn.setAttribute("aria-pressed", String(btn.getAttribute("data-theme-set") === valid));
		}
		if (snapshot) drawMain(false);
	};
	try {
		applyTheme(localStorage.getItem("ompbot-theme") || "system", false);
	} catch {
		applyTheme("system", false);
	}
	if (window.matchMedia) {
		window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
			if (ui.theme === "system") applyTheme("system", false);
		});
	}

	const showToast = (text) => {
		if (!toast) return;
		toast.textContent = text;
		toast.hidden = false;
		if (toastTimer) clearTimeout(toastTimer);
		toastTimer = setTimeout(() => {
			toast.hidden = true;
		}, 2200);
	};
	const copyText = async (value, label) => {
		let ok = false;
		if (navigator.clipboard && navigator.clipboard.writeText) {
			try {
				await navigator.clipboard.writeText(value);
				ok = true;
			} catch {}
		}
		if (!ok) {
			try {
				const area = document.createElement("textarea");
				area.value = value;
				area.style.position = "fixed";
				area.style.opacity = "0";
				document.body.appendChild(area);
				area.select();
				ok = document.execCommand("copy");
				area.remove();
			} catch {}
		}
		showToast((label || "값") + (ok ? " 복사됨: " + value : " 복사 실패"));
	};

	const fromUrl = () => {
		const query = new URLSearchParams(location.search);
		const view = query.get("view") || "inbox";
		const layout = query.get("layout") === "list" ? "list" : "";
		for (const kind of ["card", "task", "item"]) {
			const id = query.get(kind);
			if (id) return { view, layout, open: { kind, id } };
		}
		return { view, layout, open: null };
	};
	const toUrl = (target) => {
		const url = new URL(location.href);
		for (const name of ["view", "layout", "card", "task", "item"]) url.searchParams.delete(name);
		if (ui.view !== "inbox") url.searchParams.set("view", ui.view);
		if (ui.view === "turns" && ui.layout === "list") url.searchParams.set("layout", "list");
		if (target) url.searchParams.set(target.kind, target.id);
		url.hash = "";
		return url;
	};
	const cardOf = (key) => (board && board.ok ? board.cards.find((card) => card.key === key) : undefined);
	/** A turn-board conversation is open (any turns-view item but a background job). */
	const threadOpen = () => !!open && open.kind === "item" && ui.view === "turns" && !open.id.startsWith("job:");
	/** The snapshot's thread by origin key, or the one holding inbound id \`id\` (the old one-turn address). */
	const threadOf = (id) => {
		if (!snapshot || !snapshot.turns.ok) return undefined;
		const list = snapshot.turns.threads;
		return /^\\d+$/.test(id)
			? list.find((item) => item.recent.some((turn) => String(turn.inboundId) === id))
			: list.find((item) => item.originKey === id);
	};
	/** A monitor row is open (\`?view=monitors&item=<id or name>\`). */
	const monitorOpen = () => !!open && open.kind === "item" && ui.view === "monitors";
	const monitorOf = (id) =>
		snapshot && snapshot.monitors.ok
			? snapshot.monitors.items.find((item) => item.id === id || item.name === id)
			: undefined;
	const threadSign = (thread) => (thread ? thread.updatedAt + "|" + thread.latest.inboundId + "|" + thread.latest.state : "");
	const taskById = (id) =>
		snapshot && snapshot.tasks.ok ? snapshot.tasks.items.find((task) => task.taskId === id) : undefined;
	const rowOf = (id) => {
		for (const element of main.querySelectorAll("[data-row]")) {
			if (element.getAttribute("data-row") === id) return element.matches("a") ? element : element.querySelector("a");
		}
		return null;
	};
	const visibleRows = () => {
		const out = [];
		for (const element of main.querySelectorAll("[data-row]")) {
			const closedDetails = element.closest("details:not([open])");
			if (closedDetails) continue;
			const link = element.matches("a") ? element : element.querySelector("a");
			if (link) out.push({ id: element.getAttribute("data-row"), link });
		}
		return out;
	};
	const note = (target, text) => {
		const line = document.createElement("p");
		line.className = "note";
		line.textContent = text;
		target.replaceChildren(line);
	};
	const shimmer = (target, text) => {
		const wrap = document.createElement("div");
		wrap.className = "skeleton";
		wrap.setAttribute("role", "status");
		const label = document.createElement("p");
		label.className = "note-sub";
		label.textContent = text;
		wrap.appendChild(label);
		for (const w of ["is-w70", "is-w90", "is-w50"]) {
			const bar = document.createElement("div");
			bar.className = "skeleton-bar " + w;
			wrap.appendChild(bar);
		}
		target.replaceChildren(wrap);
	};

	function markChanges() {
		const now = Date.now();
		const hadPrev = prevStates.size > 0;
		for (const el of main.querySelectorAll("[data-row][data-state]")) {
			const id = el.getAttribute("data-row");
			const state = el.getAttribute("data-state");
			if (!id || !state) continue;
			const prev = prevStates.get(id);
			if (hadPrev && prev !== undefined && prev !== state) {
				changedUntil.set(id, now + 1300);
			}
			prevStates.set(id, state);
			const until = changedUntil.get(id) || 0;
			if (until > now) el.classList.add("is-changed");
		}
	}

	/** Redraws the bar, the navigation and the view; keeps the view's scroll, the closed list and the focused row. */
	function drawMain(top) {
		if (!snapshot) return;
		const html = renderDashboardMain(snapshot, board === null ? undefined : board, Date.now(), {
			view: ui.view,
			q: ui.q,
			sort: ui.sort,
			desc: ui.desc,
			selected: open ? open.id : "",
			theme: ui.theme,
			layout: ui.layout,
		});
		if (html === drawnMain) return;
		const view = document.getElementById("view");
		const scroll = top || !view ? 0 : view.scrollTop;
		const active = document.activeElement;
		const row = active && main.contains(active) && active.closest("[data-row]");
		const focusRow = row ? row.getAttribute("data-row") : null;
		const sorter = active && main.contains(active) ? active.getAttribute("data-sort") : null;
		const folded = document.getElementById("closed");
		const closedOpen = folded ? folded.open : false;
		main.innerHTML = html;
		drawnMain = html;
		markChanges();
		scrollToHere(main);
		const next = document.getElementById("view");
		if (next) next.scrollTop = scroll;
		if (top) window.scrollTo(0, 0);
		const again = document.getElementById("closed");
		if (again && closedOpen) again.open = true;
		if (focusRow !== null) {
			const target = rowOf(focusRow);
			if (target) target.focus({ preventScroll: true });
		} else if (sorter) {
			const target = main.querySelector('[data-sort="' + sorter + '"]');
			if (target) target.focus();
		}
	}
	/** Each flow row starts scrolled so its selected box, else its 지금 여기 box, is in sight. */
	function scrollToHere(root) {
		for (const row of root.querySelectorAll(".flow-row")) {
			const box = row.querySelector(".is-selected") || row.querySelector(".is-here");
			if (!box) continue;
			const end = box.offsetLeft + box.offsetWidth;
			if (end > row.clientWidth) row.scrollLeft = end - row.clientWidth + 4;
		}
	}
	/** The flow chain holding TASK \`id\`, for the TASK and card panels. */
	function chainOf(id) {
		if (!snapshot || !snapshot.flows || !snapshot.flows.ok) return undefined;
		return snapshot.flows.items.find((chain) => chain.tasks.some((step) => step.taskId === id));
	}
	/** The bar's 슬랙 스레드에서 답하기 / 디스코드에서 답하기 links follow the open conversation, on every tab. */
	function syncSlack() {
		const thread = threadOpen() ? threadOf(open.id) : undefined;
		const links = [
			["detail-slack", thread && snapshot ? slackThreadHref(snapshot.slackTeam, thread.threadRef) : ""],
			[
				"detail-discord",
				thread && snapshot ? discordThreadHref(snapshot.discordGuild, thread.originKey, thread.threadRef) : "",
			],
		];
		for (const [id, href] of links) {
			const link = document.getElementById(id);
			if (!link) continue;
			link.hidden = href === "";
			if (href !== "") link.setAttribute("href", href);
			// Only the Discord link leaves for another site (a new tab); \`slack://\` hands over to the app.
			if (href !== "" && id === "detail-discord") {
				link.setAttribute("target", "_blank");
				link.setAttribute("rel", "noopener noreferrer");
			}
		}
	}
	/** The bar's context title shows the open conversation or card title while on non-head tabs. */
	function syncBarTitle() {
		const barTitle = document.getElementById("detail-bar-title");
		if (!barTitle) return;
		const titleEl = document.getElementById("detail-title");
		const text = open && titleEl ? (titleEl.textContent || "").trim() : "";
		const tabbed = !!open && (open.kind === "card" || threadOpen());
		barTitle.textContent = text;
		barTitle.hidden = !tabbed || tab === "head" || text === "";
	}
	function drawDetail() {
		syncSlack();
		if (!open) {
			syncBarTitle();
			return;
		}
		let html = null;
		if (open.kind === "card") {
			if (board === null) return;
			const card = cardOf(open.id);
			html = renderDetailHead(
				open.id,
				card,
				card && card.taskId ? taskById(card.taskId) : undefined,
				Date.now(),
				card && card.taskId ? chainOf(card.taskId) : undefined,
			);
		} else if (snapshot) {
			if (open.kind === "task") {
				const card = board && board.ok ? board.cards.find((item) => item.taskId === open.id) : undefined;
				html = renderTaskDetail(open.id, taskById(open.id), card ? card.key : undefined, chainOf(open.id));
			} else html = renderItemDetail(snapshot, ui.view, open.id, monitorHtml === null ? undefined : monitorHtml);
		}
		if (html === null || html === drawnHead) {
			syncBarTitle();
			return;
		}
		const focused = document.activeElement && document.activeElement.id === "detail-title";
		head.innerHTML = html;
		drawnHead = html;
		scrollToHere(head);
		syncBarTitle();
		const title = document.getElementById("detail-title");
		if (focused && title) title.focus({ preventScroll: true });
	}
	function setTab(name) {
		tab = name;
		const card = !!open && open.kind === "card";
		const tabbed = card || threadOpen();
		for (const button of tabs.querySelectorAll("[data-tab]")) {
			button.setAttribute("aria-selected", String(button.getAttribute("data-tab") === name));
		}
		head.hidden = tabbed && name !== "head";
		conv.hidden = !tabbed || name !== "conv";
		plan.hidden = !card || name !== "plan";
		detail.scrollTop = name === "conv" ? detail.scrollHeight : 0;
		syncBarTitle();
		syncTrace();
		syncLive();
	}
	/** A herdr card's pane answer (\`api/pane/*\`), or a conversation's omp session (\`api/thread/conversation\`). */
	async function readPane(kind, before) {
		const thread = threadOpen();
		const query = new URLSearchParams(thread ? { origin: open.id } : { card: open.id });
		if (before) query.set("before", before);
		const path = thread ? "api/thread/conversation" : "api/pane/" + kind;
		const response = await fetch(path + "?" + query.toString(), { cache: "no-store" });
		if (!response.ok) throw new Error("HTTP " + response.status);
		return response.json();
	}
	async function loadConversation(mode) {
		const mine = generation;
		const ticket = ++loadTicket;
		try {
			const body = await readPane("conversation", mode === "older" ? cursor : undefined);
			if (mine !== generation) return;
			const page = Array.isArray(body.turns) ? body.turns : [];
			turns = mode === "older" ? page.concat(turns) : page;
			cursor = body.cursor;
			if (mode === "older") paged = true;
			const card = cardOf(open.id);
			const nearEnd = detail.scrollHeight - detail.scrollTop - detail.clientHeight < 40;
			const height = detail.scrollHeight;
			const agent = threadOpen() ? "omp" : card ? card.agent : "agent";
			// The read that ends "확정 중" swaps the kept block for the final text in this one DOM update.
			if (ticket >= settleTicket) {
				liveKept = null;
				liveFail = "";
				settleTicket = Infinity;
			}
			drawnLive = liveHtml();
			conv.innerHTML =
				renderConversation({ turns: turns, cursor: cursor }, agent, renderMarkdown, Date.now()) +
				(threadOpen() ? '<div class="live-slot" data-live>' + drawnLive + "</div>" : "");
			if (tab !== "conv") return;
			if (mode === "older") detail.scrollTop += detail.scrollHeight - height;
			else if (mode === "first" || nearEnd) detail.scrollTop = detail.scrollHeight;
		} catch (error) {
			if (mine !== generation) return;
			const failed = "대화를 읽지 못했어요 (" + (error && error.message ? error.message : String(error)) + ")";
			if (mode !== "refresh") note(conv, failed);
			else if (liveKept) {
				liveFail = failed;
				drawLive();
			}
		}
	}
	/** Reads the open conversation again: one read at a time, and one more right after when asked meanwhile. */
	function reloadThread() {
		if (!threadOpen() || loadedKey !== open.id || paged) return;
		if (reloading) {
			reloadAgain = true;
			return;
		}
		reloading = loadConversation("refresh").finally(() => {
			reloading = null;
			if (!reloadAgain) return;
			reloadAgain = false;
			reloadThread();
		});
	}
	const wrote = (view) => !!view && (view.text !== "" || view.thinking !== "" || view.toolCalls.length > 0);
	/** The view the block draws: while "확정 중", the kept message with whatever runs now. */
	function liveHtml() {
		const shown = liveKept
			? Object.assign({ running: [] }, liveView || {}, liveKept)
			: liveView;
		return renderLiveTurn(shown, renderMarkdown, {
			settling: !!liveKept,
			error: liveError,
			fail: liveFail,
			elapsedMs: Date.now() - liveAt,
		});
	}
	/** Redraws only the live block; keeps its open folds, and the reader's place unless they were at the bottom. */
	function drawLive() {
		const slot = conv.querySelector("[data-live]");
		if (!slot) return;
		const html = liveHtml();
		if (html === drawnLive) return;
		const folds = new Map();
		for (const fold of slot.querySelectorAll("details[data-fold]")) folds.set(fold.getAttribute("data-fold"), fold.open);
		const nearEnd = detail.scrollHeight - detail.scrollTop - detail.clientHeight < 40;
		const top = detail.scrollTop;
		slot.innerHTML = html;
		drawnLive = html;
		for (const fold of slot.querySelectorAll("details[data-fold]")) {
			const was = folds.get(fold.getAttribute("data-fold"));
			if (was !== undefined) fold.open = was;
		}
		if (tab === "conv") detail.scrollTop = nearEnd ? detail.scrollHeight : top;
	}
	/**
	 * One \`live\` event. A message that ended (the view went null, or its text, thinking and tool calls emptied) stays
	 * on screen as "확정 중" and the conversation is read again; that read replaces the block.
	 */
	function onLive(body) {
		const next = body && body.live ? body.live : null;
		const prev = liveView;
		liveError = body && body.error ? body.error : "";
		liveView = next;
		liveAt = Date.now();
		if (prev && !liveError && (next === null || (next.seq > prev.seq && wrote(prev) && !wrote(next)))) {
			if (wrote(prev) && !paged) {
				liveKept = { text: prev.text, thinking: prev.thinking, toolCalls: prev.toolCalls };
				liveFail = "";
				settleTicket = loadTicket + 1;
			}
			reloadThread();
		}
		drawLive();
	}
	/**
	 * The one live stream: open while the 대화 tab shows a conversation the snapshot counts as running. Closing it on the
	 * same conversation counts as the turn ending; another conversation starts clean.
	 */
	function syncLive() {
		const thread = threadOpen() && loadedKey === open.id && tab === "conv" ? threadOf(open.id) : undefined;
		const want = thread && thread.openCount > 0 ? open.id : null;
		if (want === liveOrigin) return;
		if (liveSource) liveSource.close();
		liveSource = null;
		const same = liveOrigin !== null && !!open && liveOrigin === open.id;
		liveOrigin = want;
		if (same) onLive({ live: null });
		else {
			liveView = null;
			liveKept = null;
			liveError = "";
			liveFail = "";
			settleTicket = Infinity;
			drawLive();
		}
		if (want === null) return;
		liveSource = new EventSource("api/thread/live/events?origin=" + encodeURIComponent(want));
		liveSource.addEventListener("live", (event) => onLive(JSON.parse(event.data)));
	}
	async function loadPlan() {
		const mine = generation;
		try {
			const body = await readPane("plan");
			if (mine !== generation) return;
			const html = renderPlan(body);
			if (html === "") note(plan, "이 패널에는 plan이 없어요");
			else plan.innerHTML = html;
		} catch (error) {
			if (mine === generation) note(plan, "plan을 읽지 못했어요 (" + (error && error.message ? error.message : String(error)) + ")");
		}
	}
	/** Reads the open monitor's instruction, procedure files and runs (\`api/monitor/detail\`) into its panel. */
	async function loadMonitor(id) {
		const mine = generation;
		let body;
		try {
			const response = await fetch("api/monitor/detail?" + new URLSearchParams({ id: id }).toString(), { cache: "no-store" });
			body = await response.json();
			if (!response.ok && !(body && body.error)) body = { error: "HTTP " + response.status };
		} catch (error) {
			body = { error: error && error.message ? error.message : String(error) };
		}
		if (mine !== generation) return;
		monitorHtml = renderMonitorDetail(body);
		drawDetail();
	}
	/** Starts reading the open card's pane once the board has it, the open conversation's session, or a monitor's detail. */
	function sync() {
		if (!open || loadedKey === open.id) return;
		if (threadOpen()) {
			// The old one-turn address waits for the snapshot to name its conversation.
			if (/^\\d+$/.test(open.id)) return;
			loadedKey = open.id;
			threadSeen = threadSign(threadOf(open.id));
			shimmer(conv, "대화를 불러오는 중…");
			loadConversation("first");
			return;
		}
		if (monitorOpen()) {
			// An old link by name waits for the snapshot to name the monitor's id.
			const monitor = monitorOf(open.id);
			if (!monitor) return;
			loadedKey = open.id;
			loadMonitor(monitor.id);
			return;
		}
		if (open.kind !== "card" || !cardOf(open.id)) return;
		loadedKey = open.id;
		shimmer(conv, "대화를 불러오는 중…");
		shimmer(plan, "plan을 불러오는 중…");
		loadPlan();
		loadConversation("first");
	}
	/**
	 * The one path from a snapshot to the open conversation: when its thread's updatedAt or last turn moved, the 대화
	 * tab reads the session again (kept at the bottom if it was there, else where the reader is). No timer of its own.
	 */
	function followThread() {
		if (!threadOpen() || loadedKey !== open.id) return;
		const seen = threadSign(threadOf(open.id));
		if (seen === threadSeen) return;
		threadSeen = seen;
		reloadThread();
	}
	/** The old one-turn address (\`?view=turns&item=<inbound id>\`) becomes its conversation's, on the 트레이스 tab. */
	function adoptOldTurn() {
		if (!threadOpen() || !/^\\d+$/.test(open.id)) return;
		const thread = threadOf(open.id);
		if (!thread) return;
		open = { kind: "item", id: thread.originKey };
		drawnHead = "";
		history.replaceState(history.state, "", toUrl(open));
	}
	function show(target, how) {
		const before = open;
		const same = before && target ? before.kind === target.kind && before.id === target.id : before === target;
		if (how === "push") {
			const opened = !!(history.state && history.state.opened);
			if (target && before) history.replaceState({ opened: opened }, "", toUrl(target));
			else if (target) history.pushState({ opened: true }, "", toUrl(target));
			else history.pushState(null, "", toUrl(null));
		}
		if (same) return;
		open = target;
		loadedKey = null;
		generation += 1;
		turns = [];
		cursor = undefined;
		paged = false;
		drawnHead = "";
		monitorHtml = null;
		const thread = threadOpen();
		traceTurn = thread && /^\\d+$/.test(open.id) ? open.id : null;
		adoptOldTurn();
		detail.hidden = !open;
		detail.classList.toggle("is-open", !!open);
		detail.setAttribute("aria-label", LABELS[open ? open.kind : "card"]);
		document.body.classList.toggle("detail-open", !!open);
		tabs.hidden = !open || (open.kind !== "card" && !thread);
		tabs.innerHTML = renderDetailTabs(thread ? "thread" : "card", thread ? (traceTurn ? "trace" : "conv") : "head");
		const back = toUrl(null);
		closer.setAttribute("href", back.search || "./");
		plan.replaceChildren();
		conv.replaceChildren();
		setTab(thread ? (traceTurn ? "trace" : "conv") : "head");
		drawMain(false);
		if (!open) {
			const row = before ? rowOf(before.id) : null;
			if (row) row.focus();
			return;
		}
		drawDetail();
		sync();
		syncLive();
		const title = document.getElementById("detail-title");
		if (title) title.focus({ preventScroll: true });
	}
	/** A conversation's 트레이스 tab carries the waterfall of its last (or chosen) turn and widens the panel. */
	function syncTrace() {
		const on = threadOpen() && tab === "trace";
		document.body.classList.toggle("detail-trace", on);
		const thread = on ? threadOf(open.id) : undefined;
		const turnId = !on ? null : traceTurn || (thread ? String(thread.latest.inboundId) : null);
		if (turnId === null) return trace.close();
		const turn = thread ? thread.recent.find((item) => String(item.inboundId) === turnId) : undefined;
		trace.open(turnId, turn && turn.preview ? turn.preview : thread ? thread.title : "");
	}
	function close() {
		if (!open) return;
		if (history.state && history.state.opened) history.back();
		else show(null, "push");
	}
	function setView(view) {
		ui.view = view;
		ui.layout = "";
		if (open) show(null, "none");
		history.pushState(null, "", toUrl(null));
		drawMain(true);
		const target = document.getElementById("view");
		if (target) target.focus({ preventScroll: true });
	}

	// ---- Command Palette (⌘K / Ctrl+K) and Shortcut Help (?) ----
	function buildCommands() {
		const list = [
			{ label: "보기: 에이전트 인박스 (Board)", sub: "g i", run: () => setView("inbox") },
			{ label: "보기: 에이전트 목록 (List)", sub: "g l", run: () => setView("list") },
			{ label: "보기: 턴", sub: "g t", run: () => setView("turns") },
			{ label: "보기: 흐름", sub: "g f", run: () => setView("flow") },
			{ label: "보기: 레인", sub: "g n", run: () => setView("lanes") },
			{ label: "보기: 승인 대기", sub: "g a", run: () => setView("approvals") },
			{ label: "보기: 모니터", sub: "g m", run: () => setView("monitors") },
			{ label: "보기: 알림", sub: "g e", run: () => setView("alerts") },
			{ label: "보기: 시스템", sub: "g s", run: () => setView("system") },
			{ label: "테마: 시스템 설정 따르기", sub: "Theme", run: () => applyTheme("system", true) },
			{ label: "테마: 라이트 모드", sub: "Theme", run: () => applyTheme("light", true) },
			{ label: "테마: 다크 모드", sub: "Theme", run: () => applyTheme("dark", true) },
		];
		if (snapshot && snapshot.tasks && snapshot.tasks.ok) {
			for (const t of snapshot.tasks.items) {
				list.push({
					label: "TASK 이동: " + t.taskId + " · " + t.title,
					sub: t.status,
					run: () => show({ kind: "task", id: t.taskId }, "push"),
				});
			}
		}
		if (board && board.ok) {
			for (const c of board.cards) {
				list.push({
					label: "카드 이동: " + c.key + " · " + c.paneLabel,
					sub: c.machineName,
					run: () => show({ kind: "card", id: c.key }, "push"),
				});
			}
		}
		return list;
	}
	function renderCmdList() {
		const q = (cmdInput ? cmdInput.value : "").trim().toLowerCase();
		const all = buildCommands();
		cmdItems = q === "" ? all : all.filter((item) => item.label.toLowerCase().includes(q) || item.sub.toLowerCase().includes(q));
		if (cmdIdx >= cmdItems.length) cmdIdx = Math.max(0, cmdItems.length - 1);
		if (!cmdList) return;
		if (cmdItems.length === 0) {
			cmdList.innerHTML = '<p class="cmd-empty">일치하는 명령이나 TASK가 없어요</p>';
			return;
		}
		cmdList.innerHTML = cmdItems
			.map(
				(item, idx) =>
					'<button type="button" class="cmd-item" role="option" data-cmd-idx="' +
					idx +
					'" aria-selected="' +
					(idx === cmdIdx) +
					'"><span>' +
					item.label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") +
					'</span><span class="cmd-item-sub">' +
					item.sub.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") +
					"</span></button>",
			)
			.join("");
	}
	function openCmd() {
		if (!cmdModal) return;
		if (!helpModal.hidden) helpModal.hidden = true;
		prevFocus = document.activeElement;
		cmdModal.hidden = false;
		cmdIdx = 0;
		if (cmdInput) {
			cmdInput.value = "";
			renderCmdList();
			cmdInput.focus();
		}
	}
	function closeCmd(restore) {
		if (!cmdModal || cmdModal.hidden) return;
		cmdModal.hidden = true;
		if (restore && prevFocus && typeof prevFocus.focus === "function") prevFocus.focus();
	}
	function openHelp() {
		if (!helpModal) return;
		if (!cmdModal.hidden) cmdModal.hidden = true;
		prevFocus = document.activeElement;
		helpModal.hidden = false;
		const closeBtn = helpModal.querySelector("[data-help-close]");
		if (closeBtn) closeBtn.focus();
	}
	function closeHelp() {
		if (!helpModal || helpModal.hidden) return;
		helpModal.hidden = true;
		if (prevFocus && typeof prevFocus.focus === "function") prevFocus.focus();
	}
	// Tab and Shift+Tab go round the open modal's focusable elements and never reach the page behind it.
	function trapTab(modal, event) {
		const items = Array.from(
			modal.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'),
		).filter((el) => el.getClientRects().length > 0);
		event.preventDefault();
		if (items.length === 0) return;
		const at = items.indexOf(document.activeElement);
		const next = event.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at < 0 || at === items.length - 1 ? 0 : at + 1;
		items[next].focus();
	}

	function moveRow(delta) {
		const list = visibleRows();
		if (list.length === 0) return;
		const active = document.activeElement;
		const currentRow = active && main.contains(active) && active.closest("[data-row]");
		const currentId = currentRow ? currentRow.getAttribute("data-row") : open ? open.id : null;
		let idx = list.findIndex((item) => item.id === currentId);
		if (idx < 0) idx = delta > 0 ? 0 : list.length - 1;
		else idx = Math.max(0, Math.min(list.length - 1, idx + delta));
		const target = list[idx];
		if (target && target.link) target.link.focus();
	}

	const plain = (event) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
	document.addEventListener("click", (event) => {
		const target = event.target instanceof Element ? event.target : null;
		if (!target) return;
		const copyBtn = target.closest("[data-copy]");
		if (copyBtn) {
			event.preventDefault();
			return copyText(copyBtn.getAttribute("data-copy") || "", copyBtn.getAttribute("data-copy-label") || "값");
		}
		const themeBtn = target.closest("[data-theme-set]");
		if (themeBtn) {
			event.preventDefault();
			return applyTheme(themeBtn.getAttribute("data-theme-set") || "system", true);
		}
		if (target.closest("[data-cmd-open]")) {
			event.preventDefault();
			return openCmd();
		}
		if (target.closest("[data-cmd-close]") || target === cmdModal) {
			event.preventDefault();
			return closeCmd(true);
		}
		const cmdBtn = target.closest("[data-cmd-idx]");
		if (cmdBtn) {
			event.preventDefault();
			const idx = Number(cmdBtn.getAttribute("data-cmd-idx"));
			const item = cmdItems[idx];
			closeCmd(false);
			if (item) item.run();
			return;
		}
		if (target.closest("[data-help-open]")) {
			event.preventDefault();
			return openHelp();
		}
		if (target.closest("[data-help-close]") || target === helpModal) {
			event.preventDefault();
			return closeHelp();
		}
		if (traceHost.contains(target) && trace.click(target)) {
			event.preventDefault();
			return;
		}
		if (target.closest("[data-clear-search]")) {
			event.preventDefault();
			search.value = "";
			ui.q = "";
			drawMain(true);
			search.focus();
			return;
		}
		const entry = target.closest("a[data-card], a[data-task], a[data-item]");
		if (entry && plain(event)) {
			event.preventDefault();
			for (const kind of ["card", "task", "item"]) {
				const id = entry.getAttribute("data-" + kind);
				if (id) return show({ kind: kind, id: id }, "push");
			}
		}
		const nav = target.closest("a[data-view], a[data-layout]");
		if (nav && snapshot && plain(event)) {
			event.preventDefault();
			const layout = nav.getAttribute("data-layout");
			// On the turns view Board/List switch its own layout and keep the open conversation.
			if (layout && ui.view === "turns") {
				ui.layout = layout === "list" ? "list" : "";
				history.pushState(history.state, "", toUrl(open));
				return drawMain(true);
			}
			return setView(layout ? (layout === "list" ? "list" : "inbox") : nav.getAttribute("data-view"));
		}
		if (target.closest("[data-close]")) {
			event.preventDefault();
			return close();
		}
		const sorter = target.closest("button[data-sort]");
		if (sorter) {
			const key = sorter.getAttribute("data-sort");
			if ((ui.sort || "state") === key) ui.desc = !ui.desc;
			else {
				ui.sort = key;
				ui.desc = false;
			}
			return drawMain(false);
		}
		const recentTurn = target.closest("button[data-trace-turn]");
		if (recentTurn) {
			traceTurn = recentTurn.getAttribute("data-trace-turn");
			return setTab("trace");
		}
		const tabButton = target.closest("button[data-tab]");
		if (tabButton) return setTab(tabButton.getAttribute("data-tab"));
		const more = target.closest("button[data-before]");
		if (more) {
			more.disabled = true;
			loadConversation("older");
		}
	});
	if (cmdInput) {
		cmdInput.addEventListener("input", () => {
			cmdIdx = 0;
			renderCmdList();
		});
	}
	document.addEventListener("keydown", (event) => {
		if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
			event.preventDefault();
			if (cmdModal && !cmdModal.hidden) closeCmd(true);
			else openCmd();
			return;
		}
		if (cmdModal && !cmdModal.hidden) {
			if (event.key === "Escape") {
				event.preventDefault();
				closeCmd(true);
			} else if (event.key === "ArrowDown") {
				event.preventDefault();
				if (cmdItems.length > 0) {
					cmdIdx = (cmdIdx + 1) % cmdItems.length;
					renderCmdList();
				}
			} else if (event.key === "ArrowUp") {
				event.preventDefault();
				if (cmdItems.length > 0) {
					cmdIdx = (cmdIdx - 1 + cmdItems.length) % cmdItems.length;
					renderCmdList();
				}
			} else if (event.key === "Enter") {
				event.preventDefault();
				const item = cmdItems[cmdIdx];
				closeCmd(false);
				if (item) item.run();
			} else if (event.key === "Tab") {
				trapTab(cmdModal, event);
			}
			return;
		}
		if (helpModal && !helpModal.hidden) {
			if (event.key === "Escape" || event.key === "?") {
				event.preventDefault();
				closeHelp();
			} else if (event.key === "Tab") {
				trapTab(helpModal, event);
			}
			return;
		}
		// Inside the waterfall its tree keys win; Escape with no details open still closes the panel below.
		if (event.target instanceof Element && traceHost.contains(event.target) && !event.metaKey && !event.ctrlKey && !event.altKey && trace.key(event)) {
			event.preventDefault();
			return;
		}
		const typing = event.target instanceof Element && Boolean(event.target.closest("input, textarea, select, [contenteditable]"));
		if (typing) {
			if (event.key === "Escape" && event.target === search) {
				if (search.value !== "") {
					search.value = "";
					ui.q = "";
					drawMain(false);
				} else {
					search.blur();
				}
			}
			return;
		}
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (gPending) {
			gPending = false;
			if (chordTimer) clearTimeout(chordTimer);
			const G_MAP = { i: "inbox", l: "list", t: "turns", f: "flow", n: "lanes", a: "approvals", m: "monitors", e: "alerts", s: "system" };
			const dest = G_MAP[event.key.toLowerCase()];
			if (dest) {
				event.preventDefault();
				setView(dest);
				return;
			}
		}
		if (event.key === "Escape") {
			if (open) {
				event.preventDefault();
				close();
			} else if (search.value !== "") {
				search.value = "";
				ui.q = "";
				drawMain(false);
			}
			return;
		}
		if (event.key === "/") {
			event.preventDefault();
			search.focus();
			search.select();
			return;
		}
		if (event.key === "?") {
			event.preventDefault();
			openHelp();
			return;
		}
		if (event.key === "g") {
			gPending = true;
			if (chordTimer) clearTimeout(chordTimer);
			chordTimer = setTimeout(() => {
				gPending = false;
			}, 1000);
			return;
		}
		if (event.key === "j" || event.key === "ArrowDown") {
			event.preventDefault();
			moveRow(1);
			return;
		}
		if (event.key === "k" || event.key === "ArrowUp") {
			event.preventDefault();
			moveRow(-1);
			return;
		}
		if (event.key === "Enter" && event.target instanceof Element) {
			const entry = event.target.closest("a[data-card], a[data-task], a[data-item]");
			if (entry) {
				event.preventDefault();
				for (const kind of ["card", "task", "item"]) {
					const id = entry.getAttribute("data-" + kind);
					if (id) return show({ kind: kind, id: id }, "push");
				}
			}
		}
		if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && event.target instanceof Element && event.target.matches("button[data-tab]")) {
			event.preventDefault();
			const order = ["head", "conv", threadOpen() ? "trace" : "plan"];
			const idx = order.indexOf(tab);
			const next = order[(idx + (event.key === "ArrowRight" ? 1 : 2)) % 3];
			setTab(next);
			const btn = tabs.querySelector('[data-tab="' + next + '"]');
			if (btn) btn.focus();
		}
	});
	search.addEventListener("input", () => {
		ui.q = search.value;
		drawMain(true);
	});
	window.addEventListener("popstate", () => {
		const state = fromUrl();
		const moved = state.view !== ui.view || state.layout !== ui.layout;
		ui.view = state.view;
		ui.layout = state.layout;
		show(state.open, "none");
		if (moved) drawMain(true);
	});
	async function refresh() {
		try {
			const response = await fetch("api/snapshot", { cache: "no-store" });
			if (!response.ok) throw new Error("HTTP " + response.status);
			snapshot = await response.json();
			adoptOldTurn();
			drawMain(false);
			// Without the board stream this is the only redraw: a ?card= deep link loads its conversation here too.
			drawDetail();
			sync();
			followThread();
			syncLive();
			// A ?view=turns&item= deep link starts its waterfall here, and the root row picks up the request line.
			syncTrace();
			stale.hidden = true;
		} catch (error) {
			stale.textContent = "갱신 실패: " + (error && error.message ? error.message : String(error)) + " · 15초 뒤 다시 시도해요";
			stale.hidden = false;
		}
	}
	const start = fromUrl();
	ui.view = start.view;
	ui.layout = start.layout;
	open = start.open;
	if (threadOpen()) {
		traceTurn = /^\\d+$/.test(open.id) ? open.id : null;
		tab = traceTurn ? "trace" : "conv";
	}
	search.value = "";
	refresh();
	// A hidden tab skips the poll (each snapshot can run herdr over ssh) and catches up the moment it shows again.
	setInterval(() => {
		if (document.visibilityState === "visible") refresh();
	}, 15000);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") refresh();
	});
	setInterval(() => {
		if (open && open.kind === "card" && loadedKey === open.id && !paged && document.visibilityState === "visible") {
			loadConversation("refresh");
		}
	}, 10000);
	// One clock for the waterfall and the live block's tool ages (no timer of its own).
	setInterval(() => {
		trace.tick();
		if (liveView && liveView.running.length > 0) drawLive();
	}, 1000);
	if (boardOn) {
		const events = new EventSource("api/board/events");
		events.addEventListener("snapshot", (event) => {
			board = JSON.parse(event.data);
			drawMain(false);
			drawDetail();
			sync();
		});
	}
}
if (typeof window !== "undefined") boot();
`.replace(/<\/script/gi, "<\\/script");

export interface DashboardPageOptions {
	/** The agent board (config has `herdrBoard`); absent = no board stream, TASKs only in the inbox. */
	board?: BoardPanel | undefined;
	/** `?view=` of the request (unknown names fall back to the inbox with a notice). */
	view?: string;
	/** `?card=` of the request: the detail panel starts open on that card. */
	card?: string;
	/** `?task=` of the request: the detail panel starts open on that TASK. */
	task?: string;
	/** `?item=` of the request: the detail panel starts open on that row of the view. */
	item?: string;
	/** `?layout=` of the request (`list`: the turns view as a table). */
	layout?: string;
}

/** The whole page: first render on the server (readable without JavaScript), then the inline script. */
export function renderDashboardPage(snapshot: DashboardSnapshot, options: DashboardPageOptions = {}): string {
	const { board, view, card, task, item, layout } = options;
	const live = board?.ok === true ? board : undefined;
	const tasks = snapshot.tasks.ok ? snapshot.tasks.items : [];
	const open =
		card !== undefined
			? { kind: "card" as const, id: card }
			: task !== undefined
				? { kind: "task" as const, id: task }
				: item !== undefined
					? { kind: "item" as const, id: item }
					: undefined;
	const chainOf = (id: string | undefined): FlowChainInfo | undefined =>
		id === undefined || !snapshot.flows?.ok
			? undefined
			: snapshot.flows.items.find((chain) => chain.tasks.some((step) => step.taskId === id));
	let headHtml = "";
	if (open?.kind === "card") {
		const found = live?.cards.find((entry) => entry.key === open.id);
		const owner = found?.taskId === undefined ? undefined : tasks.find((entry) => entry.taskId === found.taskId);
		headHtml = renderDetailHead(open.id, found, owner, live?.generatedAt ?? 0, chainOf(found?.taskId));
	} else if (open?.kind === "task") {
		const key = live?.cards.find((entry) => entry.taskId === open.id)?.key;
		headHtml = renderTaskDetail(
			open.id,
			tasks.find((entry) => entry.taskId === open.id),
			key,
			chainOf(open.id),
		);
	} else if (open?.kind === "item") {
		headHtml = renderItemDetail(snapshot, view ?? "inbox", open.id);
	}
	const label =
		open === undefined || open.kind === "card" ? "카드 상세" : open.kind === "task" ? "TASK 상세" : "항목 상세";
	const turnsList = view === "turns" && layout === "list";
	const back =
		view !== undefined && /^(list|turns|flow|lanes|approvals|monitors|alerts|system)$/.test(view)
			? `?view=${view}${turnsList ? "&amp;layout=list" : ""}`
			: "./";
	// A turn-board conversation: tabs 개요/대화/트레이스, 대화 first; the old one-turn address opens on 트레이스.
	const thread = open?.kind === "item" && view === "turns" && !open.id.startsWith("job:");
	const oldTurn = thread && /^\d+$/.test(open.id);
	const found =
		thread && snapshot.turns.ok
			? oldTurn
				? snapshot.turns.threads.find((entry) => entry.recent.some((turn) => String(turn.inboundId) === open.id))
				: snapshot.turns.threads.find((entry) => entry.originKey === open.id)
			: undefined;
	const tab = open?.kind === "card" ? "head" : thread ? (oldTurn ? "trace" : "conv") : undefined;
	const slackHref = found === undefined ? "" : slackThreadHref(snapshot.slackTeam, found.threadRef);
	const discordHref =
		found === undefined ? "" : discordThreadHref(snapshot.discordGuild, found.originKey, found.threadRef);
	const barTitle = /<h2 class="detail-title"[^>]*>([\s\S]*?)<\/h2>/.exec(headHtml)?.[1] ?? "";
	const ui = {
		...(view === undefined ? {} : { view }),
		...(open === undefined ? {} : { selected: found?.originKey ?? open.id }),
		...(turnsList ? { layout: "list" } : {}),
	};
	return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ompbot 현황판</title>
<link rel="manifest" href="manifest.webmanifest" crossorigin="use-credentials">
<link rel="icon" href="icons/icon-192.png">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#15181D" media="(prefers-color-scheme: dark)">
<style>${STYLE}</style>
</head>
<body${open === undefined ? "" : tab === "trace" ? ' class="detail-open detail-trace"' : ' class="detail-open"'}>
<div class="shell">
<div id="main" data-board="${board === undefined ? "0" : "1"}">
${renderDashboardMain(snapshot, board, undefined, ui)}
</div>
<div class="search"><input id="search" type="search" placeholder="제목·TASK·머신 검색 ( / )" aria-label="제목·TASK ID·머신 검색" autocomplete="off"></div>
${open === undefined ? `<aside id="detail" class="detail" aria-label="${label}" hidden>` : `<aside id="detail" class="detail is-open" aria-label="${label}">`}
<div class="detail-bar"><span id="detail-bar-title" class="detail-bar-title"${
		tab === undefined || tab === "head" || barTitle === "" ? " hidden" : ""
	}>${barTitle}</span><a id="detail-slack" class="button is-ghost detail-slack" href="${slackHref.replace(/&/g, "&amp;")}"${
		slackHref === "" ? " hidden" : ""
	}>슬랙 스레드에서 답하기</a><a id="detail-discord" class="button is-ghost detail-slack" href="${discordHref}"${
		discordHref === "" ? " hidden" : ' target="_blank" rel="noopener noreferrer"'
	}>디스코드에서 답하기</a><a class="detail-close" href="${back}" data-close>닫기 <kbd>Esc</kbd></a></div>
<div id="detail-tabs" class="tabs" role="tablist" aria-label="상세 보기"${tab === undefined ? " hidden" : ""}>${renderDetailTabs(
		thread ? "thread" : "card",
		tab ?? "head",
	)}</div>
<div id="detail-head" role="tabpanel" aria-labelledby="tab-head"${tab === undefined || tab === "head" ? "" : " hidden"}>${headHtml}</div>
<section id="detail-plan" role="tabpanel" aria-labelledby="tab-plan" hidden></section>
<section id="detail-conv" role="tabpanel" aria-labelledby="tab-conv"${tab === "conv" ? "" : " hidden"}></section>
<section id="detail-trace" role="tabpanel" aria-labelledby="tab-trace" aria-label="턴 트레이스" hidden></section>
</aside>
<footer class="hint-bar" aria-label="단축키 안내"><span class="hint-item"><kbd>j</kbd><kbd>k</kbd><span>이동</span></span><span class="hint-item"><kbd>Enter</kbd><span>열기</span></span><span class="hint-item"><kbd>Esc</kbd><span>닫기</span></span><span class="hint-item"><kbd>/</kbd><span>검색</span></span><span class="hint-item"><kbd>g</kbd><kbd>i</kbd><span>인박스</span></span><span class="hint-item"><kbd>g</kbd><kbd>a</kbd><span>승인</span></span><button type="button" class="hint-btn" data-cmd-open><kbd>⌘K</kbd><span>명령 팔레트</span></button><button type="button" class="hint-btn" data-help-open><kbd>?</kbd><span>도움말</span></button></footer>
</div>
<div id="cmd-palette" class="modal-backdrop" role="dialog" aria-modal="true" aria-label="명령 팔레트" hidden><div class="modal-card"><div class="cmd-head"><input id="cmd-input" type="text" placeholder="보기 전환, TASK ID·카드 이동, 테마 전환…" aria-label="명령 또는 TASK 검색" autocomplete="off"><button type="button" class="detail-close" data-cmd-close>닫기 <kbd>Esc</kbd></button></div><div id="cmd-list" class="cmd-list" role="listbox" aria-label="명령 목록"></div></div></div>
<div id="kb-help" class="modal-backdrop" role="dialog" aria-modal="true" aria-label="단축키 도움말" hidden><div class="modal-card"><div class="help-head"><h2 class="h3">키보드 단축키</h2><button type="button" class="detail-close" data-help-close>닫기 <kbd>Esc</kbd></button></div><div class="help-body"><div class="help-group"><h3 class="h3">목록·상세 탐색</h3><div class="help-row"><span>다음·이전 항목</span><span><kbd>j</kbd> <kbd>k</kbd> / <kbd>↓</kbd> <kbd>↑</kbd></span></div><div class="help-row"><span>상세 열기</span><kbd>Enter</kbd></div><div class="help-row"><span>상세·창 닫기</span><kbd>Esc</kbd></div><div class="help-row"><span>검색창 포커스</span><kbd>/</kbd></div><div class="help-row"><span>명령 팔레트</span><span><kbd>⌘K</kbd> / <kbd>Ctrl+K</kbd></span></div><div class="help-row"><span>단축키 도움말</span><kbd>?</kbd></div></div><div class="help-group"><h3 class="h3">턴 트레이스</h3><div class="help-row"><span>단계 이동</span><span><kbd>↓</kbd> <kbd>↑</kbd> · <kbd>Home</kbd> <kbd>End</kbd></span></div><div class="help-row"><span>펼치기·자식으로</span><kbd>→</kbd></div><div class="help-row"><span>접기·부모로</span><kbd>←</kbd></div><div class="help-row"><span>단계 상세 열고 닫기</span><span><kbd>Enter</kbd> / <kbd>Space</kbd></span></div><div class="help-row"><span>단계 상세 닫기</span><kbd>Esc</kbd></div></div><div class="help-group"><h3 class="h3">보기 바로 이동</h3><div class="help-row"><span>에이전트 인박스 (Board)</span><span><kbd>g</kbd> <kbd>i</kbd></span></div><div class="help-row"><span>에이전트 목록 (List)</span><span><kbd>g</kbd> <kbd>l</kbd></span></div><div class="help-row"><span>진행 중 턴</span><span><kbd>g</kbd> <kbd>t</kbd></span></div><div class="help-row"><span>흐름</span><span><kbd>g</kbd> <kbd>f</kbd></span></div><div class="help-row"><span>레인</span><span><kbd>g</kbd> <kbd>n</kbd></span></div><div class="help-row"><span>승인 대기</span><span><kbd>g</kbd> <kbd>a</kbd></span></div><div class="help-row"><span>모니터 / 알림 / 시스템</span><span><kbd>g</kbd> <kbd>m</kbd> / <kbd>e</kbd> / <kbd>s</kbd></span></div></div></div></div></div>
<div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
<p id="stale" class="stale" role="status" hidden></p>
${board === undefined ? "" : `<script type="application/json" id="board-data">${JSON.stringify(board).replace(/</g, "\\u003c")}</script>\n`}<script>${SCRIPT}</script>
</body>
</html>
`;
}
