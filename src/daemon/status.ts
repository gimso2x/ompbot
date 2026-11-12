import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { isThreadOrigin } from "../core/normalize";
import { chatOriginKey, parseChatOrigin } from "../core/origin-key";
import { type MonitorRow, type MonitorSql, nextFireOf, toMonitor } from "../monitors/ledger";
import { type FreezeState, readFreeze } from "../ops/freeze";
import { collectGates } from "../ops/gates";
import type { HostLoadReader } from "../ops/host-resources";
import type { DeliveryState, InboundState, Store } from "../store/db";
import { formatLocal } from "../time";

export interface OriginStatus {
	originKey: string;
	epoch: number;
	/** Pid of the live omp child; null when none is running. */
	ompPid: number | null;
	busy: boolean;
}

export interface StatusReport {
	ompVersion: string;
	/** The bot's zone (`config.timezone`): the text output shows the next monitor fire in it. */
	timezone: string;
	/** True when the report came from the running daemon; false when read from the database file only. */
	daemonRunning: boolean;
	origins: OriginStatus[];
	ledger: { pending: number; inflight: number; confirmed: number; ambiguous: number; expired: number };
	inbound: Record<InboundState, number>;
	monitors: MonitorsStatus;
	/** Open health gates (the same projection as `ompbot gates`); empty when every gate is closed. */
	openGates: OpenGateSummary[];
	/** Present while `<home>/FROZEN` exists: no autonomous action runs, owner conversation continues. */
	frozen?: FreezeState;
	/** Present while `ompbot drain` holds new work back for a restart: what is still unfinished. */
	drain?: DrainCounts;
}

/** Unfinished work a restart drain waits for; the drain completes when all three are 0. */
export interface DrainCounts {
	turns: number;
	hostTools: number;
	approvals: number;
}

export interface OpenGateSummary {
	name: string;
	detail: string;
}

export interface MonitorsStatus {
	count: number;
	/** The soonest fire among enabled monitors; `at` is an ISO instant. */
	next: { name: string; at: string } | null;
}

export function summarizeMonitors(rows: MonitorRow[]): MonitorsStatus {
	let next: { name: string; at: number } | null = null;
	for (const row of rows) {
		const at = nextFireOf(row);
		if (at !== null && (next === null || at < next.at)) next = { name: row.name, at };
	}
	return { count: rows.length, next: next === null ? null : { name: next.name, at: new Date(next.at).toISOString() } };
}

const emptyInbound = (): Record<InboundState, number> => ({
	pending: 0,
	dispatched: 0,
	answered: 0,
	failed_notified: 0,
	discarded: 0,
});

function ledgerFrom(counts: Partial<Record<DeliveryState, number>>): StatusReport["ledger"] {
	return {
		pending: counts.pending ?? 0,
		inflight: counts.inflight ?? 0,
		confirmed: counts.confirmed ?? 0,
		ambiguous: counts.failed_ambiguous ?? 0,
		expired: counts.expired ?? 0,
	};
}

export interface LiveOrigin {
	ompPid: number | null;
	busy: boolean;
}

export function frozenField(homeDir: string): { frozen?: FreezeState } {
	const frozen = readFreeze(homeDir);
	return frozen === undefined ? {} : { frozen };
}

/** Open gates of a home, as the status lines list them; the daemon and the CLI fallback use the same projection. */
export function openGateSummary(
	dbPath: string,
	now = Date.now(),
	offsiteConfigured = false,
	dailyCap?: { usd: number; timezone: string },
	/** Test seam for `host_pressure` (default this machine's readings). */
	hostLoad?: Partial<HostLoadReader>,
): OpenGateSummary[] {
	return collectGates({
		homeDir: dirname(dbPath),
		now,
		offsiteConfigured,
		...(dailyCap === undefined ? {} : { dailyCap }),
		...(hostLoad === undefined ? {} : { hostLoad }),
	})
		.filter((gate) => gate.state === "open")
		.map((gate) => ({ name: gate.name, detail: gate.detail }));
}

/** Report from the daemon's own store; `live` supplies the per-origin process facts only the daemon knows. */
export function buildStatus(
	store: Store,
	ompVersion: string,
	timezone: string,
	live: (originKey: string) => LiveOrigin,
	openGates: OpenGateSummary[] = [],
): StatusReport {
	const counts = store.countInboundByState();
	const inbound = emptyInbound();
	for (const state of Object.keys(inbound) as InboundState[]) inbound[state] = counts[state] ?? 0;
	const deliveryCounts = store.countDeliveriesByState();
	const origins: OriginStatus[] = [];
	for (const originKey of store.distinctInboundOrigins()) {
		const origin = store.getOrigin(originKey);
		if (origin) origins.push({ originKey, epoch: origin.epoch, ...live(originKey) });
	}
	return {
		ompVersion,
		timezone,
		daemonRunning: true,
		origins,
		ledger: ledgerFrom(deliveryCounts),
		inbound,
		monitors: summarizeMonitors(store.monitors.listMonitors()),
		openGates,
	};
}

/** Read-only fallback when no daemon answers: never opens a `Store`, because opening one re-queues inflight deliveries. */
export function readStatusFromDb(
	dbPath: string,
	ompVersion: string,
	timezone: string,
	offsiteConfigured = false,
	dailyCapUsd?: number,
	hostLoad?: Partial<HostLoadReader>,
): StatusReport {
	const openGates = (): OpenGateSummary[] =>
		openGateSummary(
			dbPath,
			Date.now(),
			offsiteConfigured,
			dailyCapUsd === undefined ? undefined : { usd: dailyCapUsd, timezone },
			hostLoad,
		);
	let db: Database | undefined;
	let counts: Pick<StatusReport, "inbound" | "ledger" | "origins" | "monitors">;
	try {
		db = new Database(dbPath, { readonly: true, strict: true });
		counts = readCoreCounts(db);
	} catch (error) {
		// A 0-byte, corrupt or table-less ledger: the report still comes out (as JSON with --json), naming the gate the
		// `gates` command opens for the same file, instead of a raw SQLiteError and an empty stdout.
		const reason = error instanceof Error ? error.message : String(error);
		const gates = openGates();
		return {
			ompVersion,
			timezone,
			daemonRunning: false,
			origins: [],
			ledger: ledgerFrom({}),
			inbound: emptyInbound(),
			monitors: { count: 0, next: null },
			openGates: gates.some((gate) => gate.name === "ledger_unreadable")
				? gates
				: [{ name: "ledger_unreadable", detail: `error=${reason.replace(/\s+/g, " ").slice(0, 120)}` }, ...gates],
			...frozenField(dirname(dbPath)),
		};
	} finally {
		db?.close();
	}
	return {
		ompVersion,
		timezone,
		daemonRunning: false,
		...counts,
		openGates: openGates(),
		...frozenField(dirname(dbPath)),
	};
}

/** Inbound and delivery counts, origins and monitors of a read-only handle; throws on an unreadable ledger. */
function readCoreCounts(db: Database): Pick<StatusReport, "inbound" | "ledger" | "origins" | "monitors"> {
	const inbound = emptyInbound();
	for (const row of db.query("SELECT state, COUNT(*) AS n FROM inbound GROUP BY state").all() as Array<{
		state: InboundState;
		n: number;
	}>) {
		inbound[row.state] = row.n;
	}
	const deliveryCounts: Partial<Record<DeliveryState, number>> = {};
	for (const row of db.query("SELECT state, COUNT(*) AS n FROM deliveries GROUP BY state").all() as Array<{
		state: DeliveryState;
		n: number;
	}>) {
		deliveryCounts[row.state] = row.n;
	}
	const origins = (
		db.query("SELECT origin_key, epoch FROM origins ORDER BY origin_key").all() as Array<{
			origin_key: string;
			epoch: number;
		}>
	).map((row) => ({ originKey: row.origin_key, epoch: row.epoch, ompPid: null, busy: false }));
	return { inbound, ledger: ledgerFrom(deliveryCounts), origins, monitors: readMonitorsStatus(db) };
}

/** Monitor count and next fire from a read-only handle; a database that predates monitors has none. */
function readMonitorsStatus(db: Database): MonitorsStatus {
	try {
		const rows = db.query("SELECT * FROM monitors ORDER BY created_at, id").all() as MonitorSql[];
		return summarizeMonitors(rows.map(toMonitor));
	} catch (error) {
		if (error instanceof Error && /no such table/.test(error.message)) return { count: 0, next: null };
		throw error;
	}
}

function renderMonitorsLine(monitors: MonitorsStatus, timezone: string): string {
	if (monitors.count === 0) return "모니터 0개";
	const next = monitors.next
		? `다음 발사 ${monitors.next.name} ${formatLocal(Date.parse(monitors.next.at), timezone)} (${timezone})`
		: "다음 발사 없음";
	return `모니터 ${monitors.count}개 · ${next}`;
}

/** One bullet per DM/channel origin; thread sessions collapse into `<channel> × N스레드` so the list stays short. */
function renderOriginLines(origins: readonly OriginStatus[]): string[] {
	const lines: string[] = [];
	const threadsPerChannel = new Map<string, number>();
	for (const o of origins) {
		if (!isThreadOrigin(o.originKey)) {
			lines.push(`• ${o.originKey} epoch=${o.epoch} omp_pid=${o.ompPid ?? "-"} ${o.busy ? "작업 중" : "대기"}`);
			continue;
		}
		const ref = parseChatOrigin(o.originKey);
		if (ref === undefined) continue;
		const channel = chatOriginKey({ platform: ref.platform, kind: ref.kind, conversationId: ref.conversationId });
		threadsPerChannel.set(channel, (threadsPerChannel.get(channel) ?? 0) + 1);
	}
	for (const [channel, count] of threadsPerChannel) lines.push(`• ${channel} × ${count}스레드`);
	return lines;
}

/** Short text for `/status-ompbot` and the human `ompbot status` output. */
export function renderStatusText(report: StatusReport): string {
	const { ledger, inbound } = report;
	const lines = [
		`ompbot · omp ${report.ompVersion} · 데몬 ${report.daemonRunning ? "실행 중" : "중지"} · origin ${report.origins.length}개`,
		...renderOriginLines(report.origins),
		`장부 p/i/c/a/e: ${ledger.pending}/${ledger.inflight}/${ledger.confirmed}/${ledger.ambiguous}/${ledger.expired}`,
		`입수 pending=${inbound.pending} dispatched=${inbound.dispatched} answered=${inbound.answered} failed=${inbound.failed_notified} discarded=${inbound.discarded}`,
		renderMonitorsLine(report.monitors, report.timezone),
	];
	if (report.frozen !== undefined) {
		const { since, reason, by } = report.frozen;
		lines.push(
			`FROZEN · ${since} · ${by}${reason === "" ? "" : ` · ${reason}`} · 모니터·위임·새 레인 시작·실행 중 레인 자동 재프롬프트·스킬 리뷰 중지, 오너 대화만 계속 (ompbot unfreeze로 해제)`,
		);
	}
	if (report.drain !== undefined) {
		const { turns, hostTools, approvals } = report.drain;
		lines.push(
			`재시작 대기(drain) 중 · 진행 턴 ${turns} · 호스트 도구 ${hostTools} · 승인 대기 ${approvals} · 새 메시지는 pending`,
		);
	}
	if (report.openGates.length === 0) lines.push("자가진단 게이트 이상 없음");
	else {
		lines.push(`자가진단 게이트 ${report.openGates.length}개 열림`);
		for (const gate of report.openGates) lines.push(`• ${gate.name} ${gate.detail}`);
	}
	return lines.join("\n");
}
