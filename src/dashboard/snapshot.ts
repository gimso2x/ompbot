import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { OmpbotConfig } from "../config";
import { TOP_LEVEL_TS } from "../core/normalize";
import { COMMAND_TEXT, parseCommand } from "../core/types";
import { readSweepHeartbeat } from "../daemon/heartbeat";
import {
	type DrainCounts,
	type MonitorsStatus,
	type OpenGateSummary,
	readStatusFromDb,
	type StatusReport,
} from "../daemon/status";
import { boardCardLink } from "../dispatch/board";
import {
	type HerdrAgentStatus,
	herdrAgentStatus,
	herdrSshArgv,
	type ProcessRunner,
	type RunProcessResult,
} from "../dispatch/omp";
import { MONITOR_ORIGIN_PREFIX, type MonitorSql, nextFireOf, toMonitor } from "../monitors/ledger";
import { readLockStartedAt } from "../ops/apply";
import { readStamp } from "../ops/backup";
import type { FreezeState } from "../ops/freeze";
import { collectGates, type Gate, type GateState, type GatesOptions, INBOUND_STARVATION_MS } from "../ops/gates";
import { OFFSITE_STAMP_FILE } from "../ops/offsite";
import { redact } from "../redact";
import { formatKst, type TaskRisk } from "../tasks/docs";
import { evaluateTask } from "../tasks/evaluate";
import type { TaskHostOps } from "../tasks/host";
import { parseTaskJson, type TaskRow, type TaskStatus } from "../tasks/ledger";
import { type BoardState, type BoardSummary, type BoardTaskRef, summarizeBoard } from "./board";

/** A snapshot is reused this long: IPC, herdr, ssh and git are not asked again inside it. */
export const SNAPSHOT_TTL_MS = 10_000;
/** A snapshot build still running after this is given up (answered as a failed snapshot). */
export const SNAPSHOT_BUILD_TIMEOUT_MS = 30_000;
const IPC_TIMEOUT_MS = 10_000;
const HERDR_LOCAL_TIMEOUT_MS = 10_000;
const HERDR_SSH_TIMEOUT_MS = 15_000;
const TASK_EVAL_TIMEOUT_MS = 15_000;
const GIT_TIMEOUT_MS = 5_000;
const CLOSED_TASK_DAYS = 7;
const CLOSED_TASK_LIMIT = 20;
const TURN_LIMIT = 200;
const ERROR_CHARS = 200;

/** Every section either carries its data or says why it could not; one failed section never breaks the others. */
export type Section<T> = ({ ok: true } & T) | { ok: false; error: string };

export interface DaemonInfo {
	/** True when the daemon answered over its socket; false = the numbers come from the database file. */
	running: boolean;
	ompVersion: string;
	origins: number;
	busy: number;
	ledger: StatusReport["ledger"];
	inbound: StatusReport["inbound"];
	monitors: MonitorsStatus;
	openGates: OpenGateSummary[];
	frozen?: FreezeState;
	drain?: DrainCounts;
	heartbeat?: {
		at: string;
		ageMs: number;
		loopMs?: number;
		socket?: { state: "up" | "down"; since: string };
		draining?: boolean;
	};
	/** `git rev-parse --short HEAD` of the checkout this process runs from; absent when git cannot tell. */
	commit?: string;
	/** When the running daemon took `ompbot.lock`; absent while it is down or the lock is unreadable. */
	started?: { at: string; ageMs: number };
}

export interface TurnInfo {
	inboundId: number;
	originKey: string;
	threadRef: string | null;
	state: string;
	createdAt: string;
	ageMs: number;
	/** Dispatched turns: time since the last event, else since dispatch (`inbound_starved`'s measure); null for pending. */
	silentMs: number | null;
	/**
	 * `inbound_starved`'s rule for this turn: dispatched, silent past {@link INBOUND_STARVATION_MS}, and its origin is
	 * not waiting on a live approval card (pending, `expires_at` not passed).
	 */
	stalled: boolean;
	kind: TurnKind;
	/** The request in one masked line of at most {@link PREVIEW_CHARS} chars; null for monitor turns. */
	preview: string | null;
	/** Why a pending row waits; null once dispatched. */
	waitReason: TurnWaitReason | null;
	/** A dispatched turn a restart drain is waiting for. */
	blocksRestart: boolean;
	/** Posted at the top level of its conversation (thread ref `<channel>:-`), not inside a thread. */
	topLevel: boolean;
	/** Typed as a Slack slash command (`slash:` platform message id). */
	slash: boolean;
}

export type TurnKind = "message" | "command" | "auto" | "monitor";
export type TurnWaitReason = "restart" | "frozen" | "followup" | "behind" | "queued";

/** Longest request line a turn shows. */
export const PREVIEW_CHARS = 80;
const AUTO_FOLLOWUP_PREFIX = "[자동 후속";

export type HerdrState = { ok: true; status: HerdrAgentStatus } | { ok: false; error: string };

export interface TaskInfo {
	taskId: string;
	title: string;
	risk: TaskRisk;
	status: TaskStatus;
	/** `local` = the bot's own machine, otherwise the `dispatchHosts` name. */
	host: string;
	agent: string;
	branch: string;
	open: boolean;
	updatedAt: string;
	closedAt?: string;
	acChecked?: number;
	acTotal: number;
	stepsDone?: number;
	stepsTotal?: number;
	progress?: { status: string; updated: string; current: string; blockedReason: string };
	/** Registered acceptance items with their spec.md checkbox; open TASKs whose documents were judged. */
	acceptance?: Array<{ id: string; text: string; checked: boolean }>;
	/** PROGRESS.md steps; open TASKs whose documents were judged. */
	steps?: Array<{ id: string; text: string; done: boolean }>;
	herdr?: HerdrState;
	/** herdr board card of the task's pane (the board root when the card cannot be resolved). */
	link?: string;
	/** Why the task documents could not be judged, and/or which JSON column of the row is damaged (`… 손상`). */
	error?: string;
}

export interface LaneInfo {
	name: string;
	title: string;
	status: string;
	cwd: string;
	updatedAt: string;
}

export interface HerdrAgentInfo {
	name: string;
	agent: string;
	agentStatus: string;
	cwd: string;
	paneId: string;
	terminalTitle: string;
	taskId?: string;
}

export type HerdrHostInfo = { host: string } & Section<{ agents: HerdrAgentInfo[] }>;

export interface ApprovalInfo {
	approvalId: string;
	summary: string;
	createdAt: string;
	expiresAt: string;
	originKey: string | null;
	/** The summary's first sentence (of its first line), at most 80 characters. */
	title: string;
	/** The card's sections (할 일·이유·영향·되돌릴 수 없는 이유); null for rows without them or with a broken value. */
	detail: { action?: string; why?: string; impact?: string; rollback?: string } | null;
	/** `https://` permalinks of the card and of the asking thread; anything else is null. */
	cardUrl: string | null;
	originUrl: string | null;
	/** Until the card times out (counts as denied); never below 0. */
	remainingMs: number;
	/** `DM`, `채널 <C> 스레드`, `채널 <C> 메인` or the raw origin key. */
	originLabel: string | null;
}

export interface MonitorInfo {
	name: string;
	kind: string;
	nextFireAt: string | null;
	lastStage: string | null;
	lastAt: string | null;
	openIncidents: number;
}

export interface AlertInfo {
	scope: string;
	signature: string;
	count: number;
	lastAt: string;
	incidentId: number;
	firstAt: string;
	status: string;
	/** `gate:<name>` rows only: that gate in this snapshot's `gates`; `unknown` when gates failed or lack it. */
	gateState?: GateState | "unknown";
}

/** A backup stamp's time and age. */
export interface StampAge {
	at: string;
	ageMs: number;
}

export interface BackupInfo {
	/** `<home>/backups/last-backup.ok`; absent when no backup has stamped yet. */
	local?: StampAge;
	/** `null` when config has no `offsite`; absent when it has one but no `offsite.ok` stamp exists. */
	offsite?: StampAge | null;
}

export interface DashboardSnapshot {
	generatedAt: string;
	daemon: Section<DaemonInfo>;
	turns: Section<{ items: TurnInfo[] }>;
	tasks: Section<{ items: TaskInfo[] }>;
	lanes: Section<{ items: LaneInfo[] }>;
	/** `herdr agent list` per host; while the agent board is live, its column counts instead (`hosts` empty). */
	herdr: Section<{ hosts: HerdrHostInfo[]; board?: BoardSummary }>;
	approvals: Section<{ items: ApprovalInfo[] }>;
	monitors: Section<{ items: MonitorInfo[] }>;
	alerts: Section<{ items: AlertInfo[] }>;
	/** Every health gate, as `ompbot gates` lists them. */
	gates: Section<{ items: Gate[] }>;
	backup: Section<BackupInfo>;
}

export type DashboardConfig = Partial<
	Pick<OmpbotConfig, "agent" | "ompExecutable" | "offsite" | "herdr" | "dispatchHosts" | "herdrBoard">
>;

export interface SnapshotDeps {
	homeDir: string;
	/** Checkout whose short HEAD is shown. */
	repoDir: string;
	/** Absent for a home without config.json: no herdr, no board, local tasks only. */
	config: DashboardConfig | undefined;
	now(): number;
	callDaemon(socketPath: string, request: unknown, timeoutMs: number): Promise<unknown>;
	/** herdr, ssh and git calls. */
	run: ProcessRunner;
	/** omp version line for the database fallback (the daemon reports its own). */
	ompVersion(): Promise<string>;
	/** File and git access of a task's host (`null` = local); throws for an unknown host. */
	hostOps(host: string | null): TaskHostOps;
	/** fetch used to resolve board card links. */
	fetch?: typeof fetch;
	/** The live agent board (config has `herdrBoard`); undefined before its first list or while it is down. */
	board?: () => BoardState | undefined;
	/** The health gates; default {@link collectGates}. */
	collectGates?: (options: GatesOptions) => Gate[];
}

const message = (error: unknown): string =>
	redact(error instanceof Error ? error.message : String(error)).slice(0, ERROR_CHARS);

async function section<T>(build: () => T | Promise<T>): Promise<Section<T>> {
	try {
		return { ok: true, ...(await build()) };
	} catch (error) {
		return { ok: false, error: message(error) };
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	const { promise: timeout, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Rows of a read-only query; a database that predates the table simply has none. */
function rows<T>(db: Database, sql: string, ...params: Array<string | number>): T[] {
	try {
		return db.query(sql).all(...params) as T[];
	} catch (error) {
		if (error instanceof Error && /no such table/.test(error.message)) return [];
		throw error;
	}
}

const APPROVAL_TITLE_CHARS = 80;

/** First sentence (`.`/`!`/`?` before a space, or `。`) of the first line, cut to 80 characters with `…`. */
function approvalTitle(summary: string): string {
	const line = summary.split("\n")[0]?.trim() ?? "";
	const sentence = (/^.*?(?:[.!?](?=\s)|。)/.exec(line)?.[0] ?? line).trim();
	const title = sentence === "" ? summary.trim() : sentence;
	if (title.length <= APPROVAL_TITLE_CHARS) return title;
	const last = title.charCodeAt(APPROVAL_TITLE_CHARS - 2);
	const cut = last >= 0xd800 && last <= 0xdbff ? APPROVAL_TITLE_CHARS - 2 : APPROVAL_TITLE_CHARS - 1;
	return `${title.slice(0, cut)}…`;
}

/** The stored card sections, masked again; null when absent, unparsable or empty. */
function approvalDetail(json: string | null): ApprovalInfo["detail"] {
	if (json === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const fields = new Map<string, unknown>(Object.entries(parsed));
	const detail: NonNullable<ApprovalInfo["detail"]> = {};
	for (const key of ["action", "why", "impact", "rollback"] as const) {
		const value = fields.get(key);
		if (typeof value === "string" && value.trim() !== "") detail[key] = redact(value);
	}
	return Object.keys(detail).length === 0 ? null : detail;
}

function originLabel(originKey: string | null): string | null {
	if (originKey === null) return null;
	if (originKey.startsWith("slack/dm/")) return "DM";
	const thread = /^slack\/ch\/([^/]+)\/t\/[^/]+$/.exec(originKey);
	if (thread !== null) return `채널 ${thread[1]} 스레드`;
	const main = /^slack\/ch\/([^/]+)$/.exec(originKey);
	return main === null ? originKey : `채널 ${main[1]} 메인`;
}

/** Identical commands inside one snapshot share one process (one `herdr agent list` per host). */
function sharedRunner(run: ProcessRunner): ProcessRunner {
	const calls = new Map<string, Promise<RunProcessResult>>();
	return (cmd, opts) => {
		const key = JSON.stringify(cmd);
		let call = calls.get(key);
		if (call === undefined) {
			call = run(cmd, opts);
			calls.set(key, call);
		}
		return call;
	};
}

/** GETs of one URL inside one snapshot share one request (the board's `/api/machines` once for every TASK link). */
function sharedFetch(fetcher: typeof fetch): typeof fetch {
	const calls = new Map<string, Promise<Response>>();
	return ((input: string | URL | Request, init?: RequestInit) => {
		const key = input instanceof Request ? input.url : String(input);
		let call = calls.get(key);
		if (call === undefined) {
			call = fetcher(input, init);
			calls.set(key, call);
		}
		return call.then((response) => response.clone());
	}) as typeof fetch;
}

function isStatusResponse(value: unknown): value is { ok: true; status: StatusReport } {
	return typeof value === "object" && value !== null && "ok" in value && value.ok === true && "status" in value;
}

function summarizeStatus(report: StatusReport): Omit<DaemonInfo, "heartbeat" | "commit"> {
	return {
		running: report.daemonRunning,
		ompVersion: report.ompVersion,
		origins: report.origins.length,
		busy: report.origins.filter((origin) => origin.busy).length,
		ledger: report.ledger,
		inbound: report.inbound,
		monitors: report.monitors,
		openGates: report.openGates,
		...(report.frozen === undefined ? {} : { frozen: { ...report.frozen, reason: redact(report.frozen.reason) } }),
		...(report.drain === undefined ? {} : { drain: report.drain }),
	};
}

interface TaskSql {
	task_id: string;
	title: string;
	risk: TaskRisk;
	origin_key: string;
	thread_ref: string;
	host: string | null;
	repo: string;
	worktree: string;
	branch: string;
	agent: string;
	status: TaskStatus;
	acceptance_json: string;
	created_at: number;
	updated_at: number;
	progress_at: number | null;
	reminded_at: number | null;
	notices_json: string;
	closed_at: number | null;
}

/** A task row and the JSON columns that were damaged in the database (read as `[]`/`{}`). */
interface ReadTask {
	row: TaskRow;
	broken: string[];
}

const toTaskRow = (r: TaskSql): ReadTask => {
	const { acceptance, notices, broken } = parseTaskJson(r.acceptance_json, r.notices_json);
	return {
		row: {
			taskId: r.task_id,
			title: r.title,
			risk: r.risk,
			originKey: r.origin_key,
			threadRef: r.thread_ref,
			host: r.host,
			repo: r.repo,
			worktree: r.worktree,
			branch: r.branch,
			agent: r.agent,
			status: r.status,
			acceptance,
			createdAt: r.created_at,
			updatedAt: r.updated_at,
			progressAt: r.progress_at,
			remindedAt: r.reminded_at,
			notices,
			closedAt: r.closed_at,
		},
		broken,
	};
};

interface HerdrTarget {
	/** `local` or the `dispatchHosts` name. */
	host: string;
	herdrBin: string;
	sshTarget?: string;
	timeoutMs: number;
}

type HerdrListing = { ok: true; agents: HerdrAgentInfo[] } | { ok: false; error: string };

function herdrTargets(config: DashboardConfig | undefined): HerdrTarget[] {
	if (config?.herdr === undefined) return [];
	const targets: HerdrTarget[] = [
		{ host: "local", herdrBin: config.herdr.bin ?? "herdr", timeoutMs: HERDR_LOCAL_TIMEOUT_MS },
	];
	for (const [host, entry] of Object.entries(config.dispatchHosts ?? {})) {
		targets.push({ host, herdrBin: entry.herdrBin ?? "herdr", sshTarget: entry.ssh, timeoutMs: HERDR_SSH_TIMEOUT_MS });
	}
	return targets;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** One `herdr agent list` of a host, parsed at this boundary (outside-controlled JSON). */
async function listHerdrAgents(target: HerdrTarget, run: ProcessRunner): Promise<HerdrListing> {
	const args = ["agent", "list"];
	const cmd =
		target.sshTarget === undefined ? [target.herdrBin, ...args] : herdrSshArgv(target.sshTarget, target.herdrBin, args);
	const result = await run(cmd, { timeoutMs: target.timeoutMs });
	if (result.code !== 0 || result.timedOut) {
		const detail = result.timedOut
			? "timed out"
			: result.stderr?.trim() || result.stdout.trim() || `exit ${result.code}`;
		return { ok: false, error: `agent list failed: ${message(detail)}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		return { ok: false, error: "agent list output is not JSON" };
	}
	const agents = (parsed as { result?: { agents?: unknown } } | null)?.result?.agents;
	if (!Array.isArray(agents)) return { ok: false, error: "agent list output has no agents" };
	return {
		ok: true,
		agents: agents.map((entry: Record<string, unknown>) => ({
			name: str(entry?.name),
			agent: str(entry?.agent),
			agentStatus: str(entry?.agent_status),
			cwd: str(entry?.cwd),
			paneId: str(entry?.pane_id),
			terminalTitle: redact(str(entry?.terminal_title)),
		})),
	};
}

/** A request as one masked line: secrets masked, attachment notes folded, whitespace collapsed, cut to the limit. */
function previewLine(text: string): string {
	const line = redact(text)
		.replace(/\[첨부: [^\]]*\]/g, "[첨부]")
		.replace(/\s+/g, " ")
		.trim();
	const chars = Array.from(line);
	return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS - 1).join("")}…` : line;
}

/**
 * One read-only picture of the bot. Never opens a `Store` or the task ledger (both write on open: the store re-queues
 * inflight deliveries); every table is read through a `readonly` handle. Of message bodies only open turns' are read,
 * and only their masked one-line preview leaves this function.
 */
export async function buildSnapshot(deps: SnapshotDeps): Promise<DashboardSnapshot> {
	const now = deps.now();
	const run = sharedRunner(deps.run);
	const machinesFetch = sharedFetch(deps.fetch ?? fetch);
	const { config } = deps;
	const dbPath = join(deps.homeDir, "ompbot.db");
	const db = existsSync(dbPath) ? new Database(dbPath, { readonly: true, strict: true }) : undefined;
	try {
		const needDb = (): Database => {
			if (db === undefined) throw new Error(`no database at ${dbPath}`);
			return db;
		};

		const targets = herdrTargets(config);
		// Run on first use only: with a live board and no open TASK on a host, that host's `herdr agent list` is not needed.
		const listings = new Map<string, Promise<HerdrListing>>();
		const listingOf = (host: string): Promise<HerdrListing> | undefined => {
			const target = targets.find((candidate) => candidate.host === host);
			if (target === undefined) return undefined;
			let listing = listings.get(host);
			if (listing === undefined) {
				listing = listHerdrAgents(target, run).catch((error: unknown) => ({
					ok: false as const,
					error: message(error),
				}));
				listings.set(host, listing);
			}
			return listing;
		};

		const daemon = section(async (): Promise<DaemonInfo> => {
			let report: StatusReport | undefined;
			try {
				const response = await deps.callDaemon(join(deps.homeDir, "ompbot.sock"), { op: "status" }, IPC_TIMEOUT_MS);
				if (isStatusResponse(response)) report = { ...response.status, daemonRunning: true };
			} catch {
				report = undefined; // no daemon answering: the database file tells the rest
			}
			if (report === undefined) {
				needDb();
				report = readStatusFromDb(dbPath, await deps.ompVersion(), config?.offsite !== undefined);
			}
			const info: DaemonInfo = summarizeStatus(report);
			const beat = readSweepHeartbeat(deps.homeDir);
			if (beat !== undefined) {
				info.heartbeat = {
					at: formatKst(beat.ts.getTime()),
					ageMs: now - beat.ts.getTime(),
					...(beat.loopMs === undefined ? {} : { loopMs: beat.loopMs }),
					...(beat.socket === undefined
						? {}
						: { socket: { state: beat.socket.state, since: formatKst(beat.socket.since.getTime()) } }),
					...(beat.draining === undefined ? {} : { draining: beat.draining }),
				};
			}
			const head = await run(["git", "-C", deps.repoDir, "rev-parse", "--short", "HEAD"], {
				timeoutMs: GIT_TIMEOUT_MS,
			});
			const commit = head.stdout.trim();
			if (head.code === 0 && !head.timedOut && /^[0-9a-f]{4,40}$/.test(commit)) info.commit = commit;
			const startedAt = info.running ? readLockStartedAt(deps.homeDir) : undefined;
			if (startedAt !== undefined) info.started = { at: formatKst(startedAt), ageMs: now - startedAt };
			return info;
		});

		const turns = section(async () => {
			const open = rows<{
				inbound_id: number;
				platform_message_id: string;
				origin_key: string;
				text_ref: string;
				thread_ref: string | null;
				state: string;
				created_at: number;
				dispatched_at: number | null;
				last_event_at: number | null;
			}>(
				needDb(),
				`SELECT inbound_id, platform_message_id, origin_key, text_ref, thread_ref, state, created_at, dispatched_at,
					last_event_at FROM inbound WHERE state IN ('pending','dispatched') ORDER BY created_at, inbound_id LIMIT ?`,
				TURN_LIMIT,
			);
			// Origins waiting on a live approval card, as `inbound_starved` counts them: a card past `expires_at` waits
			// on nobody even while its row still reads `pending`.
			const approvalColumns = new Set(
				rows<{ name: string }>(needDb(), "PRAGMA table_info(approvals)").map((column) => column.name),
			);
			const waitingOnOwner = new Set(
				approvalColumns.has("origin_key")
					? rows<{ origin_key: string }>(
							needDb(),
							`SELECT DISTINCT origin_key FROM approvals WHERE status = 'pending' AND origin_key IS NOT NULL${
								approvalColumns.has("expires_at") ? " AND expires_at > ?" : ""
							}`,
							...(approvalColumns.has("expires_at") ? [now] : []),
						).map((r) => r.origin_key)
					: [],
			);
			// A failed daemon section leaves drain and freeze unknown: the other wait reasons still apply.
			const status = await daemon;
			const draining = status.ok && (status.drain !== undefined || status.heartbeat?.draining === true);
			const frozen = status.ok && status.frozen !== undefined;
			const running = new Set(open.filter((r) => r.state === "dispatched").map((r) => r.origin_key));
			return {
				items: open.map((r): TurnInfo => {
					const slash = r.platform_message_id.startsWith("slash:");
					const command = parseCommand(r.text_ref);
					const kind: TurnKind = r.origin_key.startsWith(MONITOR_ORIGIN_PREFIX)
						? "monitor"
						: command !== undefined || slash
							? "command"
							: r.text_ref.trimStart().startsWith(AUTO_FOLLOWUP_PREFIX)
								? "auto"
								: "message";
					const request =
						command === undefined
							? r.text_ref
							: `${COMMAND_TEXT[command.kind]}${command.arg === "" ? "" : ` ${command.arg}`}`;
					let waitReason: TurnWaitReason | null = null;
					if (r.state === "pending") {
						if (draining) waitReason = "restart";
						else if (frozen) waitReason = "frozen";
						else if (command?.kind === "followup") waitReason = "followup";
						else if (running.has(r.origin_key)) waitReason = "behind";
						else waitReason = "queued";
					}
					const lastSign = r.state === "dispatched" ? (r.last_event_at ?? r.dispatched_at) : null;
					const silentMs = lastSign === null ? null : now - lastSign;
					return {
						inboundId: r.inbound_id,
						originKey: r.origin_key,
						threadRef: r.thread_ref,
						state: r.state,
						createdAt: formatKst(r.created_at),
						ageMs: now - r.created_at,
						silentMs,
						stalled:
							r.dispatched_at !== null &&
							silentMs !== null &&
							silentMs > INBOUND_STARVATION_MS &&
							!waitingOnOwner.has(r.origin_key),
						kind,
						preview: kind === "monitor" ? null : previewLine(request),
						waitReason,
						blocksRestart: draining && r.state === "dispatched",
						topLevel: r.thread_ref?.endsWith(`:${TOP_LEVEL_TS}`) === true,
						slash,
					};
				}),
			};
		});

		const herdrStateOf = async (row: TaskRow): Promise<HerdrState> => {
			if (config?.herdr === undefined) return { ok: false, error: "herdr is not configured" };
			const target = targets.find((candidate) => candidate.host === (row.host ?? "local"));
			if (target === undefined) return { ok: false, error: `unknown host: ${row.host}` };
			return herdrAgentStatus(row.agent, {
				herdrBin: target.herdrBin,
				timeoutMs: target.timeoutMs,
				run,
				...(target.sshTarget === undefined ? {} : { sshTarget: target.sshTarget }),
			});
		};

		const linkOf = async (row: TaskRow): Promise<string | undefined> => {
			const board = config?.herdrBoard;
			if (board === undefined) return undefined;
			const listing = await listingOf(row.host ?? "local");
			const paneId =
				listing?.ok === true ? listing.agents.find((agent) => agent.name === row.agent)?.paneId : undefined;
			return boardCardLink(board, row.host, paneId, { fetch: machinesFetch });
		};

		const describeOpen = async ({ row, broken }: ReadTask): Promise<TaskInfo> => {
			const info = baseTask({ row, broken });
			const [evaluation, herdr, link] = await Promise.all([
				withTimeout(
					(async () => evaluateTask(row, deps.hostOps(row.host)))(),
					TASK_EVAL_TIMEOUT_MS,
					`${row.taskId} evaluation`,
				).catch((error: unknown) => ({ ok: false as const, error: message(error) })),
				herdrStateOf(row),
				linkOf(row),
			]);
			if (evaluation.ok) {
				const j = evaluation.judgement;
				info.acChecked = j.acChecked;
				info.stepsDone = j.stepsDone;
				info.stepsTotal = j.stepsTotal;
				info.progress = {
					status: j.status,
					updated: j.updatedAt,
					current: redact(j.current),
					blockedReason: redact(j.blockedReason),
				};
				info.acceptance = j.acceptance.map((item) => ({ ...item, text: redact(item.text) }));
				info.steps = j.steps.map((step) => ({ ...step, text: redact(step.text) }));
			} else {
				const failure = message(evaluation.error);
				info.error = info.error === undefined ? failure : `${info.error} · ${failure}`;
			}
			info.herdr = herdr.ok ? herdr : { ok: false, error: message(herdr.error) };
			if (link !== undefined) info.link = link;
			return info;
		};

		const tasks = section(async () => {
			const handle = needDb();
			const open = rows<TaskSql>(
				handle,
				"SELECT * FROM tasks WHERE status IN ('working','blocked','review') ORDER BY task_id",
			).map(toTaskRow);
			const closed = rows<TaskSql>(
				handle,
				"SELECT * FROM tasks WHERE status IN ('done','cancelled') AND closed_at >= ? ORDER BY closed_at DESC LIMIT ?",
				now - CLOSED_TASK_DAYS * 86_400_000,
				CLOSED_TASK_LIMIT,
			).map(toTaskRow);
			return { items: [...(await Promise.all(open.map(describeOpen))), ...closed.map(baseTask)] };
		});

		const lanes = section(() => ({
			items: rows<{ name: string; title: string; status: string; cwd: string; updated_at: number }>(
				needDb(),
				"SELECT name, title, status, cwd, updated_at FROM lanes WHERE status != 'closed' ORDER BY updated_at DESC",
			).map((r) => ({
				name: r.name,
				title: redact(r.title),
				status: r.status,
				cwd: r.cwd,
				updatedAt: formatKst(r.updated_at),
			})),
		}));

		const herdr = section(async () => {
			const live = deps.board?.();
			if (live !== undefined) return { hosts: [] as HerdrHostInfo[], board: summarizeBoard(live) };
			const owners =
				db === undefined
					? []
					: rows<{ task_id: string; agent: string; host: string | null }>(db, "SELECT task_id, agent, host FROM tasks");
			if (targets.length === 0) {
				return { hosts: [{ host: "local", ok: false as const, error: "herdr is not configured" }] };
			}
			const hosts = await Promise.all(
				targets.map(async (target): Promise<HerdrHostInfo> => {
					const listing = (await listingOf(target.host)) as HerdrListing;
					if (!listing.ok) return { host: target.host, ok: false, error: listing.error };
					return {
						host: target.host,
						ok: true,
						agents: listing.agents.map((agent) => {
							const owner = owners.find((task) => task.agent === agent.name && (task.host ?? "local") === target.host);
							return owner === undefined ? agent : { ...agent, taskId: owner.task_id };
						}),
					};
				}),
			);
			return { hosts };
		});

		const approvals = section(() => {
			const handle = needDb();
			// A daemon still on the old code has not added the dashboard columns yet: read them as NULL.
			const present = new Set(rows<{ name: string }>(handle, "PRAGMA table_info(approvals)").map((c) => c.name));
			const optional = ["detail_json", "card_url", "origin_url"]
				.map((column) => (present.has(column) ? column : `NULL AS ${column}`))
				.join(", ");
			return {
				items: rows<{
					approval_id: string;
					summary: string;
					created_at: number;
					expires_at: number;
					origin_key: string | null;
					detail_json: string | null;
					card_url: string | null;
					origin_url: string | null;
				}>(
					handle,
					`SELECT approval_id, summary, created_at, expires_at, origin_key, ${optional} FROM approvals WHERE status = 'pending' ORDER BY created_at`,
				).map((r): ApprovalInfo => {
					const summary = redact(r.summary);
					return {
						approvalId: r.approval_id,
						summary,
						createdAt: formatKst(r.created_at),
						expiresAt: formatKst(r.expires_at),
						originKey: r.origin_key,
						title: approvalTitle(summary),
						detail: approvalDetail(r.detail_json),
						cardUrl: r.card_url?.startsWith("https://") ? r.card_url : null,
						originUrl: r.origin_url?.startsWith("https://") ? r.origin_url : null,
						remainingMs: Math.max(0, r.expires_at - now),
						originLabel: originLabel(r.origin_key),
					};
				}),
			};
		});

		const monitors = section(() => {
			const handle = needDb();
			return {
				items: rows<MonitorSql>(handle, "SELECT * FROM monitors WHERE enabled = 1 ORDER BY created_at, id").map(
					(sql): MonitorInfo => {
						const monitor = toMonitor(sql);
						const next = nextFireOf(monitor);
						const last = rows<{ stage: string; updated_at: number }>(
							handle,
							"SELECT stage, updated_at FROM monitor_events WHERE monitor_id = ? ORDER BY event_id DESC LIMIT 1",
							monitor.id,
						)[0];
						const incidents = rows<{ n: number }>(
							handle,
							"SELECT COUNT(*) AS n FROM monitor_incidents WHERE monitor_id = ? AND status = 'alerted'",
							monitor.id,
						)[0];
						return {
							name: redact(monitor.name),
							kind: monitor.trigger.kind,
							nextFireAt: next === null ? null : formatKst(next),
							lastStage: last?.stage ?? null,
							lastAt: last === undefined ? null : formatKst(last.updated_at),
							openIncidents: incidents?.n ?? 0,
						};
					},
				),
			};
		});

		const gates = await section(() => ({
			items: (deps.collectGates ?? collectGates)({
				homeDir: deps.homeDir,
				now,
				...((config?.agent ?? "omp") === "omp" && config?.ompExecutable !== undefined
					? { ompExecutable: config.ompExecutable }
					: {}),
				offsiteConfigured: config?.offsite !== undefined,
			}).map((gate) => ({ ...gate, detail: redact(gate.detail) })),
		}));

		const backup = section((): BackupInfo => {
			const dir = join(deps.homeDir, "backups");
			const age = (name?: string): StampAge | undefined => {
				const ts = readStamp(dir, name)?.ts.getTime();
				return ts === undefined ? undefined : { at: formatKst(ts), ageMs: now - ts };
			};
			const local = age();
			const offsite = config?.offsite === undefined ? null : age(OFFSITE_STAMP_FILE);
			return { ...(local === undefined ? {} : { local }), ...(offsite === undefined ? {} : { offsite }) };
		});

		const alerts = section(() => ({
			items: rows<{
				incident_id: number;
				scope: string;
				signature: string;
				status: string;
				count: number;
				first_at: number;
				last_at: number;
			}>(
				needDb(),
				"SELECT incident_id, scope, signature, status, count, first_at, last_at FROM alert_incidents WHERE status = 'alerted' ORDER BY last_at DESC",
			).map((r): AlertInfo => {
				const info: AlertInfo = {
					scope: r.scope,
					signature: redact(r.signature),
					count: r.count,
					lastAt: formatKst(r.last_at),
					incidentId: r.incident_id,
					firstAt: formatKst(r.first_at),
					status: r.status,
				};
				if (r.scope.startsWith("gate:")) {
					const name = r.scope.slice("gate:".length);
					info.gateState = (gates.ok ? gates.items.find((gate) => gate.name === name)?.state : undefined) ?? "unknown";
				}
				return info;
			}),
		}));

		return {
			generatedAt: formatKst(now),
			daemon: await daemon,
			turns: await turns,
			tasks: await tasks,
			lanes: await lanes,
			herdr: await herdr,
			approvals: await approvals,
			monitors: await monitors,
			alerts: await alerts,
			gates,
			backup: await backup,
		};
	} finally {
		db?.close();
	}
}

/**
 * Open TASKs (working, blocked, review) the board cards are matched against, through a read-only handle. A home
 * without a database or a tasks table has none.
 */
export function readBoardTasks(homeDir: string): BoardTaskRef[] {
	const dbPath = join(homeDir, "ompbot.db");
	if (!existsSync(dbPath)) return [];
	const db = new Database(dbPath, { readonly: true, strict: true });
	try {
		return rows<{ task_id: string; agent: string; worktree: string }>(
			db,
			"SELECT task_id, agent, worktree FROM tasks WHERE status IN ('working','blocked','review') ORDER BY task_id",
		).map((r) => ({ taskId: r.task_id, agent: r.agent, worktree: r.worktree }));
	} finally {
		db.close();
	}
}

function baseTask({ row, broken }: ReadTask): TaskInfo {
	const open = row.status !== "done" && row.status !== "cancelled";
	return {
		taskId: row.taskId,
		title: redact(row.title),
		risk: row.risk,
		status: row.status,
		host: row.host ?? "local",
		agent: row.agent,
		branch: row.branch,
		open,
		updatedAt: formatKst(row.updatedAt),
		...(row.closedAt === null ? {} : { closedAt: formatKst(row.closedAt) }),
		acTotal: row.acceptance.length,
		...(broken.length === 0 ? {} : { error: `${broken.join("·")} 손상` }),
	};
}

/**
 * The snapshot behind every request: reused for `ttlMs` after it was built, and requests that arrive while one is
 * being built wait for that same build. A failed build is not kept, and neither is one still running after
 * `buildTimeoutMs`: its waiters are rejected and the next request starts a new build.
 */
export function createSnapshotCache(
	build: () => Promise<DashboardSnapshot>,
	now: () => number,
	ttlMs: number = SNAPSHOT_TTL_MS,
	buildTimeoutMs: number = SNAPSHOT_BUILD_TIMEOUT_MS,
): () => Promise<DashboardSnapshot> {
	let cached: { at: number; snapshot: DashboardSnapshot } | undefined;
	let pending: Promise<DashboardSnapshot> | undefined;
	return () => {
		if (cached !== undefined) {
			const age = now() - cached.at;
			if (age >= 0 && age < ttlMs) return Promise.resolve(cached.snapshot);
		}
		if (pending === undefined) {
			pending = withTimeout(build(), buildTimeoutMs, "snapshot build")
				.then((snapshot) => {
					cached = { at: now(), snapshot };
					return snapshot;
				})
				.finally(() => {
					pending = undefined;
				});
		}
		return pending;
	};
}
