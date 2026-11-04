import type { Server } from "bun";
import { type BoardPanel, type BoardSource, type BoardTaskRef, boardView } from "./board";
import { renderDashboardPage } from "./html";
import { proxyPaneGet } from "./proxy";
import type { DashboardSnapshot } from "./snapshot";

/** The agent board behind `api/board`, its event stream, the pane proxy and the page's board block. */
export interface DashboardBoardOptions {
	source: BoardSource;
	/** Open TASKs the cards are matched against (read-only database read per board view). */
	tasks: () => BoardTaskRef[];
	/** herdr-web-ui address for the cards' "herdr에서 답하기" links; absent = no link. */
	herdrWebUrl?: string;
	/** Comment line sent on an idle `api/board/events` stream. Default 15 s. */
	keepAliveMs?: number;
	/** Board changes within this window go out as one `snapshot` event with the last board. Default 200 ms; 0 = at once. */
	debounceMs?: number;
}

export interface DashboardServerOptions {
	port: number;
	/** Loopback only (`127.0.0.1` or `::1`); outside exposure is a tunnel with access control in front. */
	hostname: string;
	snapshot: () => Promise<DashboardSnapshot>;
	/** Hears a snapshot that could not be built (answered as 500). */
	onError?: (error: unknown) => void;
	/** Absent when config has no `herdrBoard`: the board routes answer 404 `board_disabled`. */
	board?: DashboardBoardOptions;
	now?: () => number;
}

/**
 * A tunnel may mount the dashboard under a prefix (`/task/…`); every API route matches with or without one. The page
 * itself is `/` or a one-segment prefix only, and never `/api/` or `/healthz/`: any other path ending in `/` is a 404.
 */
const PAGE = /^\/(?:(?!(?:api|healthz)\/)[^/]+\/)?$/;
const SNAPSHOT = /^\/(?:.*\/)?api\/snapshot$/;
const HEALTH = /^\/(?:.*\/)?healthz$/;
const BOARD = /^\/(?:.*\/)?api\/board$/;
const BOARD_EVENTS = /^\/(?:.*\/)?api\/board\/events$/;
const PANE = /^\/(?:.*\/)?api\/pane\/(conversation|plan)$/;
const KEEP_ALIVE_MS = 15_000;
const DEBOUNCE_MS = 200;

const COMMON_HEADERS = {
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
};
const PAGE_CSP =
	"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const jsonReply = (body: unknown, status: number, head: boolean): Response =>
	new Response(head ? null : JSON.stringify(body), {
		status,
		headers: { ...COMMON_HEADERS, "content-type": "application/json; charset=utf-8" },
	});

const snapshotEvent = (panel: BoardPanel): string => `event: snapshot\ndata: ${JSON.stringify(panel)}\n\n`;

/** Hands every open `api/board/events` stream the same `snapshot` event for a board change. */
interface BoardFanout {
	/** Registers a stream's sender; the returned function removes it. */
	add(send: (chunk: string) => void): () => void;
}

/**
 * One board subscription per server, held only while a stream is open. A change starts a `debounceMs` window; when it
 * ends the board view is built once and the same event goes to every stream, so a burst of changes reaches each stream
 * as one event carrying the last board.
 */
function boardFanout(board: DashboardBoardOptions, panel: () => BoardPanel): BoardFanout {
	const senders = new Set<(chunk: string) => void>();
	const debounceMs = board.debounceMs ?? DEBOUNCE_MS;
	let unsubscribe: (() => void) | undefined;
	let timer: NodeJS.Timeout | undefined;
	const flush = (): void => {
		timer = undefined;
		if (senders.size === 0) return;
		const event = snapshotEvent(panel());
		for (const send of senders) send(event);
	};
	const changed = (): void => {
		if (debounceMs <= 0) flush();
		else timer ??= setTimeout(flush, debounceMs);
	};
	return {
		add(send) {
			senders.add(send);
			unsubscribe ??= board.source.onChange(changed);
			return () => {
				if (!senders.delete(send) || senders.size > 0) return;
				clearTimeout(timer);
				timer = undefined;
				unsubscribe?.();
				unsubscribe = undefined;
			};
		},
	};
}

/** `api/board/events`: one `snapshot` event at once and one per (debounced) board change, a comment line while idle. */
function boardEvents(
	request: Request,
	board: DashboardBoardOptions,
	fanout: BoardFanout,
	panel: () => BoardPanel,
): Response {
	const encoder = new TextEncoder();
	let finish = (): void => undefined;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			let open = true;
			const send = (chunk: string): void => {
				if (!open) return;
				try {
					controller.enqueue(encoder.encode(chunk));
				} catch {
					finish();
				}
			};
			const remove = fanout.add(send);
			const timer = setInterval(() => send(": keep-alive\n\n"), board.keepAliveMs ?? KEEP_ALIVE_MS);
			finish = () => {
				if (!open) return;
				open = false;
				remove();
				clearInterval(timer);
				try {
					controller.close();
				} catch {
					// already closed by the client going away
				}
			};
			request.signal.addEventListener("abort", () => finish());
			send(snapshotEvent(panel()));
		},
		cancel() {
			finish();
		},
	});
	return new Response(body, {
		headers: { ...COMMON_HEADERS, "content-type": "text/event-stream; charset=utf-8" },
	});
}

/**
 * Read-only: GET and HEAD of the page, the snapshot JSON, a health line and — with a board — the board JSON, its event
 * stream and GET-only reads of a board card's conversation and plan. Nothing here changes any state.
 */
export function startDashboardServer(options: DashboardServerOptions): Server<undefined> {
	const now = options.now ?? Date.now;
	const board = options.board;
	const panel = (): BoardPanel | undefined => {
		if (board === undefined) return undefined;
		const state = board.source.current();
		if (state === undefined) return { ok: false, error: "herdr_unreachable" };
		return boardView(state, {
			tasks: board.tasks(),
			now: now(),
			...(board.herdrWebUrl === undefined ? {} : { herdrWebUrl: board.herdrWebUrl }),
		});
	};
	const boardPanel = (): BoardPanel => panel() ?? { ok: false, error: "board_disabled" };
	const fanout = board === undefined ? undefined : boardFanout(board, boardPanel);
	return Bun.serve({
		port: options.port,
		hostname: options.hostname,
		// `api/board/events` stays open; its keep-alive line comes well inside this.
		idleTimeout: 60,
		async fetch(request) {
			const head = request.method === "HEAD";
			if (request.method !== "GET" && !head) {
				return new Response("method not allowed\n", {
					status: 405,
					headers: { ...COMMON_HEADERS, allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" },
				});
			}
			const reply = (body: string, contentType: string, extra: Record<string, string> = {}) =>
				new Response(head ? null : body, {
					headers: { ...COMMON_HEADERS, ...extra, "content-type": contentType },
				});
			const url = new URL(request.url);
			const { pathname } = url;
			if (HEALTH.test(pathname)) return reply("ok", "text/plain; charset=utf-8");
			const pane = PANE.exec(pathname);
			if (BOARD.test(pathname) || BOARD_EVENTS.test(pathname) || pane !== null) {
				if (board === undefined || fanout === undefined) return jsonReply({ error: "board_disabled" }, 404, head);
				if (BOARD.test(pathname)) {
					// Built per request, never cached: a new TASK shows on its card at once.
					const current = boardPanel();
					return current.ok ? jsonReply(current, 200, head) : jsonReply({ error: current.error }, 503, head);
				}
				if (BOARD_EVENTS.test(pathname)) {
					return head
						? new Response(null, {
								headers: { ...COMMON_HEADERS, "content-type": "text/event-stream; charset=utf-8" },
							})
						: boardEvents(request, board, fanout, boardPanel);
				}
				// The pane proxy needs only the live card, not the TASK-matched board view (no database read).
				const card = board.source.card(url.searchParams.get("card") ?? "");
				if (card === undefined) return jsonReply({ error: "unknown_pane" }, 404, head);
				const proxied = await proxyPaneGet(
					pane?.[1] === "plan" ? "plan" : "conversation",
					board.source.origin,
					card,
					url.searchParams,
				);
				return head ? new Response(null, { status: proxied.status, headers: proxied.headers }) : proxied;
			}
			const isPage = PAGE.test(pathname);
			if (!isPage && !SNAPSHOT.test(pathname)) {
				return new Response("not found\n", {
					status: 404,
					headers: { ...COMMON_HEADERS, "content-type": "text/plain; charset=utf-8" },
				});
			}
			let snapshot: DashboardSnapshot;
			try {
				snapshot = await options.snapshot();
			} catch (error) {
				options.onError?.(error);
				return new Response("snapshot failed\n", {
					status: 500,
					headers: { ...COMMON_HEADERS, "content-type": "text/plain; charset=utf-8" },
				});
			}
			const param = (name: string): string | undefined => url.searchParams.get(name) || undefined;
			const [view, card, task, item] = ["view", "card", "task", "item"].map(param);
			return isPage
				? reply(
						renderDashboardPage(snapshot, {
							...(board === undefined ? {} : { board: panel() }),
							...(view === undefined ? {} : { view }),
							...(card === undefined ? {} : { card }),
							...(task === undefined ? {} : { task }),
							...(item === undefined ? {} : { item }),
						}),
						"text/html; charset=utf-8",
						{ "content-security-policy": PAGE_CSP },
					)
				: reply(JSON.stringify(snapshot), "application/json; charset=utf-8");
		},
	});
}
