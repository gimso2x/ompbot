/*
 * Agent board of the dashboard. The card rules (columnFor, cardKey, buildCards, sortCards, displayLabel, deepLink)
 * and the machines stream reader follow the owner's herdr-board (shared/board.ts, server/machines-source.ts,
 * server/board-service.ts), ported to this codebase.
 */
import { redact } from "../redact";

/** herdr-web-ui's own machine: its cards are keyed by the bare pane id. */
export const LOCAL_MACHINE = "local";

export type ColumnId = "attention" | "working" | "idle" | "done";

/** The part of herdr-web-ui's pane record the board reads (outside-controlled JSON). */
export interface PaneRecord {
	pane_id?: unknown;
	workspace_id?: unknown;
	tab_id?: unknown;
	/** Agent kind (`omp`, `claude`, …); a pane without one is a plain shell and gets no card. */
	agent?: unknown;
	agent_status?: unknown;
	/** herdr agent name when the pane runs a named agent. */
	name?: unknown;
	label?: unknown;
	title?: unknown;
	terminal_title_stripped?: unknown;
	cwd?: unknown;
	foreground_cwd?: unknown;
}

interface LabelRecord {
	workspace_id?: unknown;
	tab_id?: unknown;
	label?: unknown;
}

export interface MachineRecord {
	id?: unknown;
	name?: unknown;
	kind?: unknown;
	enabled?: unknown;
	state?: unknown;
	snapshot?: { workspaces?: unknown; tabs?: unknown; panes?: unknown } | null;
}

/** One machine-message payload; pane-status and pane-exited are the ones the board uses. */
export interface MachineMessage {
	type?: unknown;
	pane_id?: unknown;
	agent_status?: unknown;
}

export interface BoardCard {
	/** `<pane>` on herdr-web-ui's local machine, `<machine id>:<pane>` elsewhere: the `?card=` value. */
	key: string;
	local: boolean;
	machineId: string;
	machineName: string;
	paneId: string;
	workspaceId: string;
	workspaceLabel: string;
	tabLabel: string;
	/** Display label (omp's `π <glyph> ` title prefix removed). */
	paneLabel: string;
	/** herdr agent name: the pane's `name`, else `<name>` of an ompbot worker workspace labelled `ompbot · <name>`. */
	name: string;
	/** Agent kind. */
	agent: string;
	status: string;
	column: ColumnId;
	/** herdr reported a status the board does not know: shown as attention, never as done. */
	unknown: boolean;
	/** Epoch ms at which this process first saw the pane in this status (restarts count again). */
	since: number;
	cwd: string | null;
	/** TASK whose agent or worktree is this pane's. */
	taskId?: string;
	/** "herdr에서 답하기" link; only with `dashboard.herdrWebUrl`. */
	replyUrl?: string;
}

export interface BoardMachine {
	id: string;
	name: string;
	connected: boolean;
}

/** `api/board` body and the `api/board/events` snapshot. */
export interface BoardView {
	ok: true;
	generatedAt: number;
	machines: BoardMachine[];
	cards: BoardCard[];
}

/** What the page draws in the board block: the live board, or why there is none. */
export type BoardPanel = BoardView | { ok: false; error: string };

/** An open TASK a card can belong to. */
export interface BoardTaskRef {
	taskId: string;
	agent: string;
	worktree: string;
}

/** herdr agent_status → column. blocked (waiting for an answer) and anything unrecognised need the owner. */
export function columnFor(status: string): { column: ColumnId; unknown: boolean } {
	switch (status) {
		case "working":
			return { column: "working", unknown: false };
		case "idle":
			return { column: "idle", unknown: false };
		case "done":
			return { column: "done", unknown: false };
		case "blocked":
			return { column: "attention", unknown: false };
		default:
			return { column: "attention", unknown: true };
	}
}

export function cardKey(machineId: string, paneId: string, local: boolean): string {
	return local ? paneId : `${machineId}:${paneId}`;
}

/** omp puts `π <state glyph> ` before its terminal title; the column already shows the state. */
export function displayLabel(label: string): string {
	return label.replace(/^π\s+\S\s+/u, "") || label;
}

/** herdr-web-ui deep link to a pane's chat view: `<webUrl>?[machine=<id>&]ws=<ws>&pane=<pane>&view=chat`. */
export function deepLink(
	webUrl: string,
	card: Pick<BoardCard, "local" | "machineId" | "workspaceId" | "paneId">,
): string {
	const query = new URLSearchParams();
	if (!card.local) query.set("machine", card.machineId);
	if (card.workspaceId !== "") query.set("ws", card.workspaceId);
	query.set("pane", card.paneId);
	query.set("view", "chat");
	const [base] = webUrl.split(/[?#]/);
	return `${base}?${query.toString()}`;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** One card per pane that runs an agent; `since` keeps a status's first sighting across recomputations. */
export function buildCards(
	machine: MachineRecord,
	now: number,
	since: ReadonlyMap<string, { status: string; since: number }>,
): BoardCard[] {
	const machineId = text(machine.id);
	const machineName = text(machine.name) || machineId;
	const local = machine.kind === "local" || machine.id === LOCAL_MACHINE;
	const labels = (records: unknown, idField: "workspace_id" | "tab_id") =>
		new Map(
			list(records).map((record) => [text((record as LabelRecord)?.[idField]), text((record as LabelRecord)?.label)]),
		);
	const workspaces = labels(machine.snapshot?.workspaces, "workspace_id");
	const tabs = labels(machine.snapshot?.tabs, "tab_id");
	const cards: BoardCard[] = [];
	for (const raw of list(machine.snapshot?.panes)) {
		const pane = (raw ?? {}) as PaneRecord;
		const paneId = text(pane.pane_id);
		const agent = text(pane.agent);
		if (paneId === "" || agent === "") continue;
		const status = text(pane.agent_status) || "unknown";
		const { column, unknown } = columnFor(status);
		const key = cardKey(machineId, paneId, local);
		const previous = since.get(key);
		const workspaceId = text(pane.workspace_id);
		const tabId = text(pane.tab_id);
		const tabLabel = redact(tabs.get(tabId) || tabId);
		const cwd = text(pane.foreground_cwd) || text(pane.cwd);
		cards.push({
			key,
			local,
			machineId,
			machineName,
			paneId,
			workspaceId,
			workspaceLabel: redact(workspaces.get(workspaceId) || workspaceId),
			tabLabel,
			paneLabel: redact(
				displayLabel(text(pane.label) || text(pane.title) || text(pane.terminal_title_stripped) || paneId),
			),
			name: text(pane.name) || (/^ompbot · (\S+)$/.exec(workspaces.get(workspaceId) ?? "")?.[1] ?? ""),
			agent,
			status,
			column,
			unknown,
			since: previous !== undefined && previous.status === status ? previous.since : now,
			cwd: cwd === "" ? null : cwd,
		});
	}
	return cards;
}

/** Most recently changed first, then by pane id so the order is stable. */
export function sortCards(cards: BoardCard[]): BoardCard[] {
	return [...cards].sort((a, b) => b.since - a.since || a.key.localeCompare(b.key, "en", { numeric: true }));
}

/** The live board as the source holds it (no TASK badges or links yet). */
export interface BoardState {
	machines: BoardMachine[];
	cards: BoardCard[];
}

export interface BoardSourceOptions {
	/** herdr-web-ui origin (`herdrBoard.api`). */
	origin: string;
	/** Wait before reopening a lost or refused stream. */
	retryMs?: number;
	/**
	 * A stream that sends nothing (not even a comment line) for this long counts as lost: a half-open connection
	 * never ends on its own. Default 45 s, three of herdr-web-ui's 15 s heartbeats.
	 */
	idleMs?: number;
	now?: () => number;
}

/**
 * Holds the live cards of every machine herdr-web-ui reaches, from one read-only GET of its `/api/machines/events`
 * stream, and reopens the stream whenever it ends or stays silent past `idleMs`. `current()` is undefined until the
 * first machines list and again while the stream is down (the board then answers `herdr_unreachable`).
 */
export class BoardSource {
	readonly origin: string;
	private readonly retryMs: number;
	private readonly idleMs: number;
	private readonly now: () => number;
	private machines = new Map<string, MachineRecord>();
	private since = new Map<string, { status: string; since: number }>();
	private state: BoardState | undefined;
	private cardsByKey = new Map<string, BoardCard>();
	private readonly listeners = new Set<() => void>();
	private abort: AbortController | undefined;
	private retry: NodeJS.Timeout | undefined;
	private idle: NodeJS.Timeout | undefined;
	private stopped = false;

	constructor(options: BoardSourceOptions) {
		this.origin = options.origin.replace(/\/+$/, "");
		this.retryMs = options.retryMs ?? 2_000;
		this.idleMs = options.idleMs ?? 45_000;
		this.now = options.now ?? Date.now;
	}

	current(): BoardState | undefined {
		return this.state;
	}

	/** A card on the board now; the proxy answers for these panes only. */
	card(key: string): BoardCard | undefined {
		return this.state === undefined ? undefined : this.cardsByKey.get(key);
	}

	/** Hears every change of `current()`. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	start(): void {
		this.stopped = false;
		this.connect();
	}

	stop(): void {
		this.stopped = true;
		clearTimeout(this.retry);
		this.retry = undefined;
		clearTimeout(this.idle);
		this.idle = undefined;
		this.abort?.abort();
		this.abort = undefined;
	}

	private connect(): void {
		if (this.stopped) return;
		const abort = new AbortController();
		this.abort = abort;
		void this.read(abort).then(
			() => this.lost(abort),
			() => this.lost(abort),
		);
	}

	/** (Re)starts the idle limit of the connection `abort` owns; when it runs out the connection is aborted. */
	private arm(abort: AbortController): void {
		if (this.abort !== abort) return; // stopped, or already replaced
		clearTimeout(this.idle);
		this.idle = setTimeout(() => abort.abort(), this.idleMs);
	}

	private async read(abort: AbortController): Promise<void> {
		const { signal } = abort;
		this.arm(abort);
		const response = await fetch(`${this.origin}/api/machines/events`, {
			method: "GET",
			signal,
			headers: { accept: "text/event-stream" },
		});
		if (!response.ok || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
			await response.body?.cancel().catch(() => undefined);
			throw new Error(`herdr-web-ui answered ${response.status}`);
		}
		if (response.body === null) throw new Error("herdr-web-ui sent no body");
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		while (!signal.aborted) {
			const { done, value } = await reader.read();
			if (done) return;
			this.arm(abort); // any chunk, a comment line too, shows the connection is alive
			buffer += decoder.decode(value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				if (!signal.aborted) this.dispatch(line);
				newline = buffer.indexOf("\n");
			}
		}
	}

	private lost(abort: AbortController): void {
		if (this.abort !== abort || this.stopped) return;
		this.abort = undefined;
		clearTimeout(this.idle);
		this.idle = undefined;
		this.machines = new Map();
		if (this.state !== undefined) {
			this.state = undefined;
			this.cardsByKey = new Map();
			this.emit();
		}
		this.retry = setTimeout(() => {
			this.retry = undefined;
			this.connect();
		}, this.retryMs);
	}

	private dispatch(line: string): void {
		if (!line.startsWith("data:")) return; // comments, keep-alives, other fields
		let event: { type?: unknown; machines?: unknown; machine_id?: unknown; message?: unknown };
		try {
			event = JSON.parse(line.slice(5).trimStart());
		} catch {
			return; // a broken line is dropped, the stream goes on
		}
		if (event === null || typeof event !== "object") return;
		if (event.type === "machines" && Array.isArray(event.machines)) {
			this.machines = new Map(
				(event.machines as MachineRecord[])
					.filter((machine) => machine !== null && typeof machine === "object" && typeof machine.id === "string")
					.map((machine) => [machine.id as string, machine]),
			);
			this.recompute();
		} else if (event.type === "machine-message" && typeof event.machine_id === "string" && event.message) {
			this.patch(event.machine_id, event.message as MachineMessage);
		}
	}

	private patch(machineId: string, message: MachineMessage): void {
		const machine = this.machines.get(machineId);
		const panes = machine?.snapshot?.panes;
		if (machine?.snapshot == null || !Array.isArray(panes) || typeof message.pane_id !== "string") return;
		let next: unknown[];
		if (message.type === "pane-status" && typeof message.agent_status === "string") {
			next = panes.map((pane: PaneRecord) =>
				pane?.pane_id === message.pane_id ? { ...pane, agent_status: message.agent_status } : pane,
			);
		} else if (message.type === "pane-exited") {
			next = panes.filter((pane: PaneRecord) => pane?.pane_id !== message.pane_id);
		} else {
			return;
		}
		this.machines.set(machineId, { ...machine, snapshot: { ...machine.snapshot, panes: next } });
		this.recompute();
	}

	private recompute(): void {
		const now = this.now();
		const shown = [...this.machines.values()].filter((machine) => machine.enabled !== false);
		const cards = sortCards(
			shown.flatMap((machine) =>
				machine.state === "connected" && machine.snapshot != null ? buildCards(machine, now, this.since) : [],
			),
		);
		const next: BoardState = {
			machines: shown.map((machine) => ({
				id: text(machine.id),
				name: text(machine.name) || text(machine.id),
				connected: machine.state === "connected",
			})),
			cards,
		};
		this.since = new Map(cards.map((card) => [card.key, { status: card.status, since: card.since }]));
		const same = this.state !== undefined && JSON.stringify(this.state) === JSON.stringify(next);
		this.state = next;
		this.cardsByKey = new Map(cards.map((card) => [card.key, card]));
		if (!same) this.emit();
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

/** The board as served: each card gets its TASK (agent name or worktree = cwd) and, with a herdr web URL, its link. */
export function boardView(
	state: BoardState,
	options: { tasks: BoardTaskRef[]; herdrWebUrl?: string; now: number },
): BoardView {
	return {
		ok: true,
		generatedAt: options.now,
		machines: state.machines,
		cards: state.cards.map((card) => {
			const task = options.tasks.find(
				(candidate) =>
					(candidate.agent !== "" && candidate.agent === card.name) ||
					(candidate.worktree !== "" && candidate.worktree === card.cwd),
			);
			return {
				...card,
				...(task === undefined ? {} : { taskId: task.taskId }),
				...(options.herdrWebUrl === undefined ? {} : { replyUrl: deepLink(options.herdrWebUrl, card) }),
			};
		}),
	};
}

/** Column counts for the snapshot's herdr section while the board is live. */
export interface BoardSummary {
	machines: number;
	cards: number;
	columns: Record<ColumnId, number>;
}

export function summarizeBoard(state: BoardState): BoardSummary {
	const columns: Record<ColumnId, number> = { attention: 0, working: 0, idle: 0, done: 0 };
	for (const card of state.cards) columns[card.column] += 1;
	return { machines: state.machines.length, cards: state.cards.length, columns };
}
