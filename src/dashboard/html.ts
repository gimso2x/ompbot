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
import type { DashboardSnapshot, TaskInfo, TurnKind, TurnWaitReason } from "./snapshot";
import { STYLE } from "./style";

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
}

/**
 * The redrawn part of the page for one snapshot: the top bar, the side navigation and the chosen view. Self-contained
 * on purpose — no imports, and the only module-level helpers are `gateText`/`alertText`/`GATE_LIMITS`/`TURN_LABELS`,
 * which the page ships next to it: the page ships this very function's source as its inline script, so the server's
 * first render and every client redraw are the same code. Every free string goes through `esc`.
 *
 * Inline 16x16 SVG line icons are hand-crafted for ompbot (MIT, no external requests).
 *
 * Badge colours carry one meaning each: is-success done/healthy · is-info in progress · is-warning someone has to
 * look (blocked, stalled, open gate, frozen, waiting on the owner) · is-danger failed/down/gone · grey idle/waiting.
 * Every status pill pairs an icon shape with its word so status is never conveyed by colour alone.
 */
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
		done: ["완료", "is-success"],
		"done-claimed": ["완료 보고", "is-success"],
		delivered: ["전달", "is-success"],
		gone: ["사라짐", "is-danger"],
		failed: ["실패", "is-danger"],
		failed_no_retry: ["실패", "is-danger"],
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
		["turns", "진행 중 턴"],
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
	const nothing =
		q !== ""
			? `<div class="empty-box" role="status"><p class="note">'${esc(ui.q)}'와 맞는 항목이 없어요.</p><p class="note-sub">다음 행동: 검색어를 지우거나(Esc) 다른 제목·TASK ID·머신 이름으로 다시 검색해 보세요.</p><button type="button" class="button is-ghost is-sm" data-clear-search>검색어 지우기 (Esc)</button></div>`
			: "";
	const head = (title: string, count: number | string | undefined, extra = ""): string =>
		`<div class="view-head"><h1 class="view-title">${esc(title)}</h1>${
			count === undefined ? "" : `<span class="count-chip">${esc(count)}</span>`
		}${extra}</div>`;

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
			return `<section class="col" id="col-${id}" aria-label="${esc(label)}"><h2 class="col-head"><span>${esc(
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
		return `${head("에이전트 인박스", shown.length, machines)}${banners.join("")}${
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
			if (!turns.ok) return `${head("진행 중인 턴", undefined)}${banners.join("")}${failed(turns.error)}`;
			const rows = turns.items
				.filter((turn) => hit(turn.preview, turn.originKey, turn.threadRef))
				.map((turn) =>
					row(
						String(turn.inboundId),
						[
							state(turn.state),
							badge(TURN_LABELS.kind[turn.kind], ""),
							...(turn.waitReason === null
								? []
								: [
										badge(
											TURN_LABELS.wait[turn.waitReason],
											turn.waitReason === "restart" || turn.waitReason === "frozen" ? "is-warning" : "",
										),
									]),
							...(turn.blocksRestart ? [badge("재시작이 기다리는 턴", "is-warning")] : []),
							...(turn.stalled ? [badge("정체", "is-warning")] : []),
						],
						esc(turn.preview ?? turn.originKey),
						[
							turn.preview === null ? "" : esc(turn.originKey),
							`경과 ${dur(turn.ageMs)} · 마지막 이벤트 뒤 ${dur(turn.silentMs)}`,
							turn.topLevel
								? turn.originKey.startsWith("slack/dm/")
									? "DM"
									: "채널 메인"
								: turn.threadRef
									? `스레드 ${esc(turn.threadRef)}`
									: "",
						],
					),
				);
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
			return listOf(
				"진행 중인 턴",
				rows,
				turns.items.length,
				"진행 중인 턴이 없어요",
				"슬랙 대화나 모니터에서 새 턴이 시작되면 실시간으로 표시됩니다.",
				drainLine,
			);
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
			return listOf(
				"승인 대기",
				rows,
				approvals.items.length,
				"기다리는 승인이 없어요",
				"승인이 필요한 작업이 올라오면 슬랙 승인 카드와 함께 여기에 표시됩니다.",
			);
		}
		if (view === "monitors") {
			const monitors = s.monitors;
			if (!monitors.ok) return `${head("모니터", undefined)}${banners.join("")}${failed(monitors.error)}`;
			const rows = monitors.items
				.filter((monitor) => hit(monitor.name, monitor.kind))
				.map((monitor) =>
					row(
						monitor.name,
						[
							...(monitor.lastStage ? [state(monitor.lastStage)] : []),
							...(monitor.openIncidents > 0 ? [badge(`사건 ${monitor.openIncidents}`, "is-danger")] : []),
						],
						esc(monitor.name),
						[
							`${esc(monitor.kind)} · 다음 ${at(monitor.nextFireAt)}`,
							monitor.lastAt ? `마지막 ${at(monitor.lastAt)}` : "",
						],
					),
				);
			return listOf(
				"모니터",
				rows,
				monitors.items.length,
				"켜진 모니터가 없어요",
				"ompbot monitors add로 등록한 정기·조건 모니터가 여기에 표시됩니다.",
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
								: ["상태 모름", "is-warning"];
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
		const card = (id: string, title: string, level: string, body: string, wide = false): string => {
			const [word, tone] = LEVELS[level] ?? ["?", ""];
			return `<section class="sys-card${wide ? " is-wide" : ""}" data-card="${id}" aria-label="${esc(title)}"><header class="sys-head"><span class="sys-dot ${tone}" aria-hidden="true"></span><h3 class="h3">${esc(
				title,
			)}</h3>${badge(word, tone)}</header>${body}</section>`;
		};
		const note = (text: string): string => `<p class="note">${esc(text)}</p>`;
		const noDaemon = note(d.ok ? "" : `데몬 상태를 읽지 못했어요: ${d.error}`);
		const cards: string[] = [];

		cards.push(
			!d.ok
				? card("daemon", "데몬", "bad", noDaemon)
				: card(
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
					),
		);

		const socket = d.ok ? d.heartbeat?.socket : undefined;
		cards.push(
			!d.ok
				? card("slack", "Slack", "warn", noDaemon)
				: socket === undefined
					? card("slack", "Slack", "warn", note("소켓 상태 기록이 아직 없어요."))
					: card(
							"slack",
							"Slack",
							socket.state === "up" ? "ok" : "bad",
							facts([
								["소켓", socket.state === "up" ? "연결" : "끊김"],
								["그 뒤", `${dur(clock - msOf(socket.since))} · ${at(socket.since)}부터`],
							]),
						),
		);

		const beat = d.ok ? d.heartbeat : undefined;
		cards.push(
			!d.ok
				? card("sweep", "스윕·하트비트", "warn", noDaemon)
				: beat === undefined
					? card("sweep", "스윕·하트비트", "warn", note("하트비트 기록이 아직 없어요."))
					: card(
							"sweep",
							"스윕·하트비트",
							beat.ageMs > GATE_LIMITS.sweepStalledMs ? "warn" : "ok",
							facts([
								["나이", `${dur(beat.ageMs)} 전 · ${at(beat.at)}`],
								["loop", beat.loopMs === undefined ? "-" : `${beat.loopMs}ms`],
								["기준", `${dur(GATE_LIMITS.sweepStalledMs)} 넘으면 주의`],
							]),
						),
		);

		cards.push(
			!d.ok
				? card("ledger", "전달 장부", "warn", noDaemon)
				: card(
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
					),
		);

		const backup = s.backup;
		if (!backup.ok) cards.push(card("backup", "백업", "bad", note(backup.error)));
		else {
			const max = GATE_LIMITS.backupMaxAgeMs;
			const stale = (age: { ageMs: number } | null | undefined): boolean =>
				age === undefined || (age !== null && age.ageMs > max);
			const stamped = (age: { at: string; ageMs: number } | undefined, none: string): string =>
				age === undefined
					? none
					: `${at(age.at)} · ${dur(age.ageMs)} 전${age.ageMs > max ? ` ${badge("오래됨", "is-warning")}` : ""}`;
			cards.push(
				card(
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
				),
			);
		}

		const gates = s.gates;
		if (!gates.ok) cards.push(card("gates", "게이트", "bad", note(`게이트를 읽지 못했어요: ${gates.error}`), true));
		else {
			const lines = gates.items
				.slice()
				.sort((a, b) => Number(b.state === "open") - Number(a.state === "open"))
				.map((gate) => {
					const open = gate.state === "open";
					return `<li class="gate-row${open ? " is-open" : ""}" data-gate="${esc(gate.name)}" data-state="${esc(
						gate.state,
					)}"><span class="sys-dot ${open ? "is-warning" : "is-success"}" aria-hidden="true"></span><span class="gate-word">${
						open ? "열림" : "닫힘"
					}</span><span class="gate-label">${esc(gateText(gate.name).label)}</span><code class="gate-detail">${esc(
						gate.detail,
					)}</code></li>`;
				});
			cards.push(
				card(
					"gates",
					`게이트 ${gates.items.length}개`,
					gates.items.some((gate) => gate.state === "open") ? "warn" : "ok",
					`<ul class="gate-list">${lines.join("")}</ul>`,
					true,
				),
			);
		}

		const monitorCount = d.ok ? d.monitors.count : s.monitors.ok ? s.monitors.items.length : 0;
		const troubled = s.monitors.ok ? s.monitors.items.filter((monitor) => monitor.openIncidents > 0).length : 0;
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
		cards.push(
			card(
				"monitors",
				"모니터·herdr 머신",
				herdrDown || troubled > 0 || !s.monitors.ok ? "warn" : "ok",
				facts([
					["모니터", `${monitorCount}개${troubled > 0 ? ` · 사건 ${troubled}` : ""}`],
					["herdr 머신", machines],
				]),
			),
		);

		return `${head("시스템", undefined)}${banners.join("")}<div class="sys-grid">${cards.join("")}</div>`;
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
		inbox: [entries.length, !s.tasks.ok || entries.some((entry) => entry.col === "attention")],
		turns: [count(s.turns), warnOf(s.turns, s.turns.ok && s.turns.items.some((turn) => turn.stalled))],
		lanes: [count(s.lanes), !s.lanes.ok],
		approvals: [count(s.approvals), warnOf(s.approvals, count(s.approvals) > 0)],
		monitors: [
			count(s.monitors),
			warnOf(s.monitors, s.monitors.ok && s.monitors.items.some((monitor) => monitor.openIncidents > 0)),
		],
		alerts: openAlerts > 0 ? [openAlerts, true] : [count(s.alerts), !s.alerts.ok],
		system: [d.ok ? d.openGates.length : 0, !d.ok || !d.running || d.openGates.length > 0 || d.frozen !== undefined],
	};
	const nav = VIEWS.map(([id, label]) => {
		const [n, warn] = NAV[id] ?? [0, false];
		const current = id === view || (id === "inbox" && view === "list");
		return `<a class="nav-item" href="${id === "inbox" ? "./" : `?view=${id}`}" data-view="${id}"${
			current ? ' aria-current="page"' : ""
		}><span>${esc(label)}</span><span class="nav-count${warn ? " is-warn" : ""}">${n}</span>${navIcon(id)}</a>`;
	}).join("");
	const layout = view === "list" ? "list" : "board";
	const themeBtn = (mode: string, text: string): string =>
		`<button type="button" class="seg-item" data-theme-set="${mode}" aria-pressed="${theme === mode}">${text}</button>`;
	const topbar = `<header class="topbar"><nav class="crumbs" aria-label="위치"><span>ompbot</span><span aria-hidden="true">/</span><span aria-current="page">${esc(
		viewLabel,
	)}</span></nav><div class="status-chips" aria-label="봇 상태">${chips.join("")}</div><div class="top-tools"><div class="seg" role="group" aria-label="보기 방식"><a class="seg-item" href="./" data-layout="board"${
		layout === "board" ? ' aria-current="true"' : ""
	}>Board</a><a class="seg-item" href="?view=list" data-layout="list"${layout === "list" ? ' aria-current="true"' : ""}>List</a></div><div class="seg" role="group" aria-label="테마">${themeBtn("system", "시스템")}${themeBtn("light", "라이트")}${themeBtn("dark", "다크")}</div><button type="button" class="cmd-trigger" data-cmd-open aria-label="명령 팔레트 열기"><span>명령</span><kbd>⌘K</kbd></button></div></header>`;
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
	const rows: Array<[string, string]> = [
		["TASK", `<span class="mono">${esc(task.taskId)}</span> · 위험 ${esc(task.risk)}`],
		["브랜치", `<code>${esc(task.branch)}</code>`],
		["머신", `${esc(task.host)} · ${esc(task.agent)}`],
		[
			"AC 충족",
			`${task.acChecked === undefined ? "-" : task.acChecked}/${task.acTotal}<span class="meter" role="img" aria-label="AC ${percent}%"><i style="width:${percent}%"></i></span>`,
		],
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
 * The detail panel of `?task=<ID>`: the TASK's title, status and {@link renderTaskFacts}, with a way to its agent's
 * card when the board has one. An ID not in the snapshot gets the "지금 목록에 없는 TASK" notice. Self-contained apart
 * from {@link renderTaskFacts}, which ships beside it.
 */
export function renderTaskDetail(taskId: string, task: TaskInfo | undefined, cardKey?: string): string {
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
	return `<p class="eyebrow">TASK · ${esc(task.host)}</p><h2 class="detail-title" id="detail-title" tabindex="-1">${esc(
		task.title,
	)}</h2>${actions}<p class="lead">AC ${
		task.acChecked === undefined ? "-" : task.acChecked
	}/${task.acTotal} · 단계 ${task.stepsDone === undefined ? "-" : `${task.stepsDone}/${task.stepsTotal ?? "-"}`}</p>${renderTaskFacts(task)}${card}`;
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
	)}</h2><div class="detail-actions">${badges.join("")}</div>${lines}${reply}${about}`;
}

/**
 * The detail panel of a row of the other views (`?view=<view>&item=<id>`): every field the snapshot has for it, no
 * more. An id not in the snapshot gets the "지금 목록에 없는 항목" notice. Self-contained (shipped to the page).
 */
export function renderItemDetail(s: DashboardSnapshot, view: string, id: string): string {
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
		turns: "진행 중 턴",
		lanes: "레인",
		approvals: "승인 대기",
		monitors: "모니터",
		alerts: "알림",
	};
	const show = (title: string, rows: Array<[string, string]>): string =>
		`<p class="eyebrow">${esc(LABELS[view] ?? view)}</p><h2 class="detail-title" id="detail-title" tabindex="-1">${esc(
			title,
		)}</h2><dl class="facts">${rows.map(([name, value]) => `<dt>${esc(name)}</dt><dd>${value}</dd>`).join("")}</dl>`;
	if (view === "turns" && s.turns.ok) {
		const turn = s.turns.items.find((item) => String(item.inboundId) === id);
		if (turn) {
			return show(turn.originKey, [
				["상태", esc(turn.state)],
				["종류", esc(TURN_LABELS.kind[turn.kind])],
				["대기 이유", turn.waitReason === null ? "-" : esc(TURN_LABELS.wait[turn.waitReason])],
				["요청", turn.preview === null ? "-" : esc(turn.preview)],
				["받은 경로", turn.slash ? "슬래시 명령" : "메시지"],
				...(turn.blocksRestart ? [["재시작", "이 턴이 끝나야 재시작해요"] as [string, string]] : []),
				["시작", at(turn.createdAt)],
				["경과", dur(turn.ageMs)],
				["마지막 이벤트 뒤", dur(turn.silentMs)],
				["스레드", esc(turn.threadRef ?? "-")],
				["입수 번호", esc(turn.inboundId)],
			]);
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
		const item = s.approvals.items.find((approval) => approval.approvalId === id);
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
			facts.push(
				// Rounded up like the list badge (`N분 남음`), so both read the same minute.
				["남은 시간", item.remainingMs <= 0 ? "만료 처리 중" : `${Math.ceil(item.remainingMs / 60_000)}분`],
				["요청", at(item.createdAt)],
				["만료", at(item.expiresAt)],
				["요청한 곳", esc(item.originLabel ?? "-")],
			);
			const links = [
				item.cardUrl === null
					? ""
					: `<a class="button" href="${esc(item.cardUrl)}" target="_blank" rel="noopener noreferrer">슬랙 카드 열기</a>`,
				item.originUrl === null
					? ""
					: `<a class="button is-ghost" href="${esc(item.originUrl)}" target="_blank" rel="noopener noreferrer">요청 스레드 열기</a>`,
			].join("");
			return `<p class="eyebrow">${esc(LABELS[view])}</p><h2 class="detail-title" id="detail-title" tabindex="-1">${esc(
				item.title,
			)}</h2>${item.summary.trim() === item.title ? "" : `<p class="lead detail-summary">${esc(item.summary)}</p>`}${
				item.detail === null ? '<p class="lead">세부 내용 없음(요약만 받은 요청)</p>' : ""
			}<dl class="facts">${facts.map(([name, value]) => `<dt>${esc(name)}</dt><dd>${value}</dd>`).join("")}</dl>${
				links === ""
					? '<p class="lead">슬랙의 승인 메시지에서 승인하거나 거절해요.</p>'
					: `<div class="detail-actions">${links}</div>`
			}<details class="detail-internal"><summary>내부 정보</summary><dl class="facts"><dt>승인 ID</dt><dd><code>${esc(
				item.approvalId,
			)}</code></dd><dt>대화</dt><dd><code>${esc(item.originKey ?? "-")}</code></dd></dl></details>`;
		}
	}
	if (view === "monitors" && s.monitors.ok) {
		const monitor = s.monitors.items.find((item) => item.name === id);
		if (monitor) {
			return show(monitor.name, [
				["종류", esc(monitor.kind)],
				["다음 실행", at(monitor.nextFireAt)],
				["마지막 단계", esc(monitor.lastStage ?? "-")],
				["마지막 실행", at(monitor.lastAt)],
				["열린 사건", esc(monitor.openIncidents)],
			]);
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
						: "상태 모름";
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
				return fold(
					`<code class="mono"><b>${esc(p.name)}</b></code> <span>${esc(p.summary)}</span>${p.error ? ' <span class="badge is-danger">실패</span>' : ' <span class="badge is-success">완료</span>'}`,
					output === ""
						? '<p class="turn-note">출력 없음</p>'
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
 * Inline script: the renderers above as shipped source, then the page wiring — the 15-second snapshot refresh, the
 * board stream (`api/board/events`, only with a board), view switching (`?view=`), search and List sorting, theme
 * persistence, keyboard navigation (`j`/`k`, `Enter`, `Esc`, `g <key>`, `/`, `?`, `⌘K`/`Ctrl+K`), copy toast, and the
 * detail panel (`?card=`, `?task=`, `?item=` in the address; a card's conversation and plan read through
 * `api/pane/*`). Every request is relative to the page, so any tunnel prefix works.
 */
const SCRIPT = `const GATE_LIMITS = ${JSON.stringify(GATE_LIMITS)};
const TURN_LABELS = ${JSON.stringify(TURN_LABELS)};
const gateText = ${gateText.toString()};
const alertText = ${alertText.toString()};
const renderDashboardMain = ${renderDashboardMain.toString()};
const renderTaskFacts = ${renderTaskFacts.toString()};
const renderTaskDetail = ${renderTaskDetail.toString()};
const renderDetailHead = ${renderDetailHead.toString()};
const renderItemDetail = ${renderItemDetail.toString()};
const renderPlan = ${renderPlan.toString()};
const renderConversation = ${renderConversation.toString()};
const renderMarkdown = ${renderMarkdown.toString()};
function boot() {
	const main = document.getElementById("main");
	const stale = document.getElementById("stale");
	const search = document.getElementById("search");
	const detail = document.getElementById("detail");
	const tabs = document.getElementById("detail-tabs");
	const head = document.getElementById("detail-head");
	const plan = document.getElementById("detail-plan");
	const conv = document.getElementById("detail-conv");
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
	const ui = { view: "inbox", q: "", sort: "", desc: false, theme: "system" };
	let open = null;
	let tab = "head";
	let drawnMain = "";
	let drawnHead = "";
	let loadedKey = null;
	let turns = [];
	let cursor;
	let paged = false;
	let generation = 0;
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
		for (const kind of ["card", "task", "item"]) {
			const id = query.get(kind);
			if (id) return { view, open: { kind, id } };
		}
		return { view, open: null };
	};
	const toUrl = (target) => {
		const url = new URL(location.href);
		for (const name of ["view", "card", "task", "item"]) url.searchParams.delete(name);
		if (ui.view !== "inbox") url.searchParams.set("view", ui.view);
		if (target) url.searchParams.set(target.kind, target.id);
		url.hash = "";
		return url;
	};
	const cardOf = (key) => (board && board.ok ? board.cards.find((card) => card.key === key) : undefined);
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
	function drawDetail() {
		if (!open) return;
		let html = null;
		if (open.kind === "card") {
			if (board === null) return;
			const card = cardOf(open.id);
			html = renderDetailHead(open.id, card, card && card.taskId ? taskById(card.taskId) : undefined, Date.now());
		} else if (snapshot) {
			if (open.kind === "task") {
				const card = board && board.ok ? board.cards.find((item) => item.taskId === open.id) : undefined;
				html = renderTaskDetail(open.id, taskById(open.id), card ? card.key : undefined);
			} else html = renderItemDetail(snapshot, ui.view, open.id);
		}
		if (html === null || html === drawnHead) return;
		const focused = document.activeElement && document.activeElement.id === "detail-title";
		head.innerHTML = html;
		drawnHead = html;
		const title = document.getElementById("detail-title");
		if (focused && title) title.focus({ preventScroll: true });
	}
	function setTab(name) {
		tab = name;
		const card = !!open && open.kind === "card";
		for (const button of tabs.querySelectorAll("[data-tab]")) {
			button.setAttribute("aria-selected", String(button.getAttribute("data-tab") === name));
		}
		head.hidden = card && name !== "head";
		conv.hidden = !card || name !== "conv";
		plan.hidden = !card || name !== "plan";
		detail.scrollTop = name === "conv" ? detail.scrollHeight : 0;
	}
	async function readPane(kind, before) {
		const query = new URLSearchParams({ card: open.id });
		if (before) query.set("before", before);
		const response = await fetch("api/pane/" + kind + "?" + query.toString(), { cache: "no-store" });
		if (!response.ok) throw new Error("HTTP " + response.status);
		return response.json();
	}
	async function loadConversation(mode) {
		const mine = generation;
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
			conv.innerHTML = renderConversation({ turns: turns, cursor: cursor }, card ? card.agent : "agent", renderMarkdown, Date.now());
			if (tab !== "conv") return;
			if (mode === "older") detail.scrollTop += detail.scrollHeight - height;
			else if (mode === "first" || nearEnd) detail.scrollTop = detail.scrollHeight;
		} catch (error) {
			if (mine !== generation || mode === "refresh") return;
			note(conv, "대화를 읽지 못했어요 (" + (error && error.message ? error.message : String(error)) + ")");
		}
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
	/** Starts reading the open card's pane once the board has it. */
	function sync() {
		if (!open || open.kind !== "card" || loadedKey === open.id || !cardOf(open.id)) return;
		loadedKey = open.id;
		shimmer(conv, "대화를 불러오는 중…");
		shimmer(plan, "plan을 불러오는 중…");
		loadPlan();
		loadConversation("first");
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
		detail.hidden = !open;
		detail.classList.toggle("is-open", !!open);
		detail.setAttribute("aria-label", LABELS[open ? open.kind : "card"]);
		document.body.classList.toggle("detail-open", !!open);
		tabs.hidden = !open || open.kind !== "card";
		const back = toUrl(null);
		closer.setAttribute("href", back.search || "./");
		plan.replaceChildren();
		conv.replaceChildren();
		setTab("head");
		drawMain(false);
		if (!open) {
			const row = before ? rowOf(before.id) : null;
			if (row) row.focus();
			return;
		}
		drawDetail();
		sync();
		const title = document.getElementById("detail-title");
		if (title) title.focus({ preventScroll: true });
	}
	function close() {
		if (!open) return;
		if (history.state && history.state.opened) history.back();
		else show(null, "push");
	}
	function setView(view) {
		ui.view = view;
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
			{ label: "보기: 진행 중 턴", sub: "g t", run: () => setView("turns") },
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
			const G_MAP = { i: "inbox", l: "list", t: "turns", n: "lanes", a: "approvals", m: "monitors", e: "alerts", s: "system" };
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
			const order = ["head", "conv", "plan"];
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
		const moved = state.view !== ui.view;
		ui.view = state.view;
		show(state.open, "none");
		if (moved) drawMain(true);
	});
	async function refresh() {
		try {
			const response = await fetch("api/snapshot", { cache: "no-store" });
			if (!response.ok) throw new Error("HTTP " + response.status);
			snapshot = await response.json();
			drawMain(false);
			// Without the board stream this is the only redraw: a ?card= deep link loads its conversation here too.
			drawDetail();
			sync();
			stale.hidden = true;
		} catch (error) {
			stale.textContent = "갱신 실패: " + (error && error.message ? error.message : String(error)) + " · 15초 뒤 다시 시도해요";
			stale.hidden = false;
		}
	}
	const start = fromUrl();
	ui.view = start.view;
	open = start.open;
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
}

/** The whole page: first render on the server (readable without JavaScript), then the inline script. */
export function renderDashboardPage(snapshot: DashboardSnapshot, options: DashboardPageOptions = {}): string {
	const { board, view, card, task, item } = options;
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
	let headHtml = "";
	if (open?.kind === "card") {
		const found = live?.cards.find((entry) => entry.key === open.id);
		const owner = found?.taskId === undefined ? undefined : tasks.find((entry) => entry.taskId === found.taskId);
		headHtml = renderDetailHead(open.id, found, owner, live?.generatedAt ?? 0);
	} else if (open?.kind === "task") {
		const key = live?.cards.find((entry) => entry.taskId === open.id)?.key;
		headHtml = renderTaskDetail(
			open.id,
			tasks.find((entry) => entry.taskId === open.id),
			key,
		);
	} else if (open?.kind === "item") {
		headHtml = renderItemDetail(snapshot, view ?? "inbox", open.id);
	}
	const label =
		open === undefined || open.kind === "card" ? "카드 상세" : open.kind === "task" ? "TASK 상세" : "항목 상세";
	const back =
		view !== undefined && /^(list|turns|lanes|approvals|monitors|alerts|system)$/.test(view) ? `?view=${view}` : "./";
	const ui = {
		...(view === undefined ? {} : { view }),
		...(open === undefined ? {} : { selected: open.id }),
	};
	return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ompbot 현황판</title>
<style>${STYLE}</style>
</head>
<body${open === undefined ? "" : ' class="detail-open"'}>
<div class="shell">
<div id="main" data-board="${board === undefined ? "0" : "1"}">
${renderDashboardMain(snapshot, board, undefined, ui)}
</div>
<div class="search"><input id="search" type="search" placeholder="제목·TASK·머신 검색 ( / )" aria-label="제목·TASK ID·머신 검색" autocomplete="off"></div>
${open === undefined ? `<aside id="detail" class="detail" aria-label="${label}" hidden>` : `<aside id="detail" class="detail is-open" aria-label="${label}">`}
<div class="detail-bar"><a class="detail-close" href="${back}" data-close>닫기 <kbd>Esc</kbd></a></div>
<div id="detail-tabs" class="tabs" role="tablist" aria-label="상세 보기"${open?.kind === "card" ? "" : " hidden"}><button id="tab-head" class="tab" type="button" role="tab" data-tab="head" aria-controls="detail-head" aria-selected="true">개요</button><button id="tab-conv" class="tab" type="button" role="tab" data-tab="conv" aria-controls="detail-conv" aria-selected="false">대화</button><button id="tab-plan" class="tab" type="button" role="tab" data-tab="plan" aria-controls="detail-plan" aria-selected="false">plan</button></div>
<div id="detail-head" role="tabpanel" aria-labelledby="tab-head">${headHtml}</div>
<section id="detail-plan" role="tabpanel" aria-labelledby="tab-plan" hidden></section>
<section id="detail-conv" role="tabpanel" aria-labelledby="tab-conv" hidden></section>
</aside>
<footer class="hint-bar" aria-label="단축키 안내"><span class="hint-item"><kbd>j</kbd><kbd>k</kbd><span>이동</span></span><span class="hint-item"><kbd>Enter</kbd><span>열기</span></span><span class="hint-item"><kbd>Esc</kbd><span>닫기</span></span><span class="hint-item"><kbd>/</kbd><span>검색</span></span><span class="hint-item"><kbd>g</kbd><kbd>i</kbd><span>인박스</span></span><span class="hint-item"><kbd>g</kbd><kbd>a</kbd><span>승인</span></span><button type="button" class="hint-btn" data-cmd-open><kbd>⌘K</kbd><span>명령 팔레트</span></button><button type="button" class="hint-btn" data-help-open><kbd>?</kbd><span>도움말</span></button></footer>
</div>
<div id="cmd-palette" class="modal-backdrop" role="dialog" aria-modal="true" aria-label="명령 팔레트" hidden><div class="modal-card"><div class="cmd-head"><input id="cmd-input" type="text" placeholder="보기 전환, TASK ID·카드 이동, 테마 전환…" aria-label="명령 또는 TASK 검색" autocomplete="off"><button type="button" class="detail-close" data-cmd-close>닫기 <kbd>Esc</kbd></button></div><div id="cmd-list" class="cmd-list" role="listbox" aria-label="명령 목록"></div></div></div>
<div id="kb-help" class="modal-backdrop" role="dialog" aria-modal="true" aria-label="단축키 도움말" hidden><div class="modal-card"><div class="help-head"><h2 class="h3">키보드 단축키</h2><button type="button" class="detail-close" data-help-close>닫기 <kbd>Esc</kbd></button></div><div class="help-body"><div class="help-group"><h3 class="h3">목록·상세 탐색</h3><div class="help-row"><span>다음·이전 항목</span><span><kbd>j</kbd> <kbd>k</kbd> / <kbd>↓</kbd> <kbd>↑</kbd></span></div><div class="help-row"><span>상세 열기</span><kbd>Enter</kbd></div><div class="help-row"><span>상세·창 닫기</span><kbd>Esc</kbd></div><div class="help-row"><span>검색창 포커스</span><kbd>/</kbd></div><div class="help-row"><span>명령 팔레트</span><span><kbd>⌘K</kbd> / <kbd>Ctrl+K</kbd></span></div><div class="help-row"><span>단축키 도움말</span><kbd>?</kbd></div></div><div class="help-group"><h3 class="h3">보기 바로 이동</h3><div class="help-row"><span>에이전트 인박스 (Board)</span><span><kbd>g</kbd> <kbd>i</kbd></span></div><div class="help-row"><span>에이전트 목록 (List)</span><span><kbd>g</kbd> <kbd>l</kbd></span></div><div class="help-row"><span>진행 중 턴</span><span><kbd>g</kbd> <kbd>t</kbd></span></div><div class="help-row"><span>레인</span><span><kbd>g</kbd> <kbd>n</kbd></span></div><div class="help-row"><span>승인 대기</span><span><kbd>g</kbd> <kbd>a</kbd></span></div><div class="help-row"><span>모니터 / 알림 / 시스템</span><span><kbd>g</kbd> <kbd>m</kbd> / <kbd>e</kbd> / <kbd>s</kbd></span></div></div></div></div></div>
<div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
<p id="stale" class="stale" role="status" hidden></p>
${board === undefined ? "" : `<script type="application/json" id="board-data">${JSON.stringify(board).replace(/</g, "\\u003c")}</script>\n`}<script>${SCRIPT}</script>
</body>
</html>
`;
}
