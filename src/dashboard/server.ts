import type { Server } from "bun";
import type { LiveView } from "../core/live-turn";
import { type BoardPanel, type BoardSource, type BoardTaskRef, boardView } from "./board";
import { renderDashboardPage } from "./html";
import type { MonitorDetail } from "./monitor-detail";
import { proxyPaneGet } from "./proxy";
import type { DashboardSnapshot } from "./snapshot";
import type { ThreadConversation } from "./thread-conversation";
import type { TurnTrace } from "./trace";

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
	/** `api/turn/<id>/trace`: one turn's waterfall (read per request, never cached); absent = 404 `trace_disabled`. */
	trace?: (inboundId: number) => TurnTrace;
	/**
	 * `api/thread/conversation?origin=<key>[&before=<cursor>]`: one conversation's omp session, masked (read per
	 * request, never cached); absent = 404 `conversation_disabled`.
	 */
	conversation?: (originKey: string, before?: string) => ThreadConversation;
	/**
	 * `api/monitor/detail?id=<monitor id>`: one monitor's masked instruction, procedure file heads and last runs (read
	 * per request, never cached); absent = 404 `monitor_detail_disabled`.
	 */
	monitorDetail?: (id: string) => MonitorDetail;
	/**
	 * `api/thread/live` and its event stream: what the conversation's running turn is writing now (the daemon's `live`
	 * op); throws when the daemon cannot be asked. Absent = 404 `live_disabled`.
	 */
	live?: (originKey: string) => Promise<LiveView | null>;
	/** Wait between the end of one live read and the next one of an origin with subscribers. Default 1000 ms. */
	liveIntervalMs?: number;
	/** Schedules the next live read and returns its cancel (default `setTimeout`/`clearTimeout`); tests run it by hand. */
	liveSchedule?: (fn: () => void, ms: number) => () => void;
	/** Hears an origin's live subscriber count after every change (subscribe or the server handling a disconnect). */
	onLiveSubscribers?: (originKey: string, count: number) => void;
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
const TRACE = /^\/(?:.*\/)?api\/turn\/(\d{1,15})\/trace$/;
const THREAD_CONVERSATION = /^\/(?:.*\/)?api\/thread\/conversation$/;
const MONITOR_DETAIL = /^\/(?:.*\/)?api\/monitor\/detail$/;
const THREAD_LIVE = /^\/(?:.*\/)?api\/thread\/live$/;
const THREAD_LIVE_EVENTS = /^\/(?:.*\/)?api\/thread\/live\/events$/;
const MANIFEST = /^\/(?:.*\/)?manifest\.webmanifest$/;
const ICON = /^\/(?:.*\/)?icons\/(icon-192|icon-512|icon-maskable-512|apple-touch-icon)\.png$/;
const KEEP_ALIVE_MS = 15_000;

/** Web app manifest for "install as app" in Chrome/Edge; URLs are relative so any tunnel prefix keeps working. */
const WEB_MANIFEST = JSON.stringify({
	id: "./",
	name: "ompbot 현황판",
	short_name: "ompbot",
	start_url: "./",
	scope: "./",
	display: "standalone",
	background_color: "#0D0F12",
	theme_color: "#15181D",
	lang: "ko",
	icons: [
		{ src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
		{ src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
		{ src: "icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
	],
});
const DEBOUNCE_MS = 200;
const LIVE_INTERVAL_MS = 1000;

const COMMON_HEADERS = {
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
};
const PAGE_CSP =
	"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

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

/**
 * A `text/event-stream` response: `subscribe` registers the stream's sender (and may send at once) and returns its
 * removal, run once when the client goes; a comment line goes out every `keepAliveMs` while the stream is open.
 */
function eventStream(
	request: Request,
	keepAliveMs: number,
	subscribe: (send: (chunk: string) => void) => () => void,
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
			let remove = (): void => undefined;
			const timer = setInterval(() => send(": keep-alive\n\n"), keepAliveMs);
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
			remove = subscribe(send);
		},
		cancel() {
			finish();
		},
	});
	return new Response(body, {
		headers: { ...COMMON_HEADERS, "content-type": "text/event-stream; charset=utf-8" },
	});
}

/** `api/board/events`: one `snapshot` event at once and one per (debounced) board change, a comment line while idle. */
function boardEvents(
	request: Request,
	board: DashboardBoardOptions,
	fanout: BoardFanout,
	panel: () => BoardPanel,
): Response {
	return eventStream(request, board.keepAliveMs ?? KEEP_ALIVE_MS, (send) => {
		const remove = fanout.add(send);
		send(snapshotEvent(panel()));
		return remove;
	});
}

/** One origin's live reads, shared by its `api/thread/live/events` streams. */
interface LiveChannel {
	senders: Set<(chunk: string) => void>;
	/** A read is running (no next read is scheduled meanwhile). */
	running: boolean;
	/** Cancels the scheduled next read; undefined when none is scheduled. */
	cancel: (() => void) | undefined;
	/** What the last event said (`<inboundId>:<seq>`, `null` or `error`) and the event itself, for late subscribers. */
	said: string | undefined;
	event: string | undefined;
}

/**
 * Live reads per origin, held only while a stream of that origin is open: one read at a time, the next scheduled
 * `liveIntervalMs` after the previous one ended (so a stuck daemon never piles up reads), and an event only when the
 * answer changed — another seq or turn, null, or the daemon becoming unreachable.
 */
function liveFanout(
	live: (originKey: string) => Promise<LiveView | null>,
	options: Pick<DashboardServerOptions, "liveIntervalMs" | "liveSchedule" | "onLiveSubscribers">,
): { add(originKey: string, send: (chunk: string) => void): () => void } {
	const channels = new Map<string, LiveChannel>();
	const intervalMs = options.liveIntervalMs ?? LIVE_INTERVAL_MS;
	const schedule =
		options.liveSchedule ??
		((fn: () => void, ms: number) => {
			const timer = setTimeout(fn, ms);
			return () => clearTimeout(timer);
		});
	const plan = (originKey: string, channel: LiveChannel, ms: number): void => {
		channel.cancel = schedule(() => {
			channel.cancel = undefined;
			void read(originKey, channel);
		}, ms);
	};
	const read = async (originKey: string, channel: LiveChannel): Promise<void> => {
		channel.running = true;
		let said: string;
		let body: unknown;
		try {
			const view = await live(originKey);
			said = view === null ? "null" : `${view.inboundId}:${view.seq}`;
			body = { live: view };
		} catch {
			said = "error";
			body = { live: null, error: "daemon_unreachable" };
		}
		channel.running = false;
		if (channel.senders.size === 0) {
			if (channels.get(originKey) === channel) channels.delete(originKey);
			return;
		}
		if (said !== channel.said) {
			channel.said = said;
			channel.event = `event: live\ndata: ${JSON.stringify(body)}\n\n`;
			for (const send of channel.senders) send(channel.event);
		}
		plan(originKey, channel, intervalMs);
	};
	return {
		add(originKey, send) {
			let channel = channels.get(originKey);
			if (channel === undefined) {
				channel = { senders: new Set(), running: false, cancel: undefined, said: undefined, event: undefined };
				channels.set(originKey, channel);
			}
			const mine = channel;
			mine.senders.add(send);
			if (mine.event !== undefined) send(mine.event);
			if (!mine.running && mine.cancel === undefined) plan(originKey, mine, 0);
			options.onLiveSubscribers?.(originKey, mine.senders.size);
			return () => {
				if (!mine.senders.delete(send)) return;
				if (mine.senders.size === 0) {
					mine.cancel?.();
					mine.cancel = undefined;
					if (!mine.running && channels.get(originKey) === mine) channels.delete(originKey);
				}
				options.onLiveSubscribers?.(originKey, mine.senders.size);
			};
		},
	};
}

/**
 * Read-only: GET and HEAD of the page, the snapshot JSON, a turn's trace, a monitor's detail, a conversation's session and what its running
 * turn is writing (one read or an event stream), a health line, the web app manifest and its icons and — with a board — the board JSON, its event
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
	const live = options.live === undefined ? undefined : liveFanout(options.live, options);
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
			if (MANIFEST.test(pathname)) return reply(WEB_MANIFEST, "application/manifest+json; charset=utf-8");
			const icon = ICON.exec(pathname);
			if (icon !== null) {
				const file = Bun.file(new URL(`./icons/${icon[1]}.png`, import.meta.url));
				return new Response(head ? null : file, {
					headers: { ...COMMON_HEADERS, "content-type": "image/png", "cache-control": "max-age=86400" },
				});
			}
			const trace = TRACE.exec(pathname);
			if (trace !== null) {
				if (options.trace === undefined) return jsonReply({ error: "trace_disabled" }, 404, head);
				let answer: TurnTrace;
				try {
					answer = options.trace(Number(trace[1]));
				} catch (error) {
					options.onError?.(error);
					return jsonReply({ ok: false, error: "trace_failed" }, 500, head);
				}
				return jsonReply(answer, answer.ok ? 200 : 404, head);
			}
			const liveEvents = THREAD_LIVE_EVENTS.test(pathname);
			if (liveEvents || THREAD_LIVE.test(pathname)) {
				if (options.live === undefined || live === undefined) return jsonReply({ error: "live_disabled" }, 404, head);
				const origin = (url.searchParams.get("origin") ?? "").trim();
				if (origin === "") return jsonReply({ error: "invalid_origin" }, 400, head);
				if (liveEvents) {
					return head
						? new Response(null, {
								headers: { ...COMMON_HEADERS, "content-type": "text/event-stream; charset=utf-8" },
							})
						: eventStream(request, KEEP_ALIVE_MS, (send) => {
								// A first line at once: the response (and its headers) goes out before the first read ends.
								send(": live\n\n");
								return live.add(origin, send);
							});
				}
				try {
					return jsonReply({ live: await options.live(origin) }, 200, head);
				} catch {
					return jsonReply({ error: "daemon_unreachable" }, 503, head);
				}
			}
			if (THREAD_CONVERSATION.test(pathname)) {
				if (options.conversation === undefined) return jsonReply({ error: "conversation_disabled" }, 404, head);
				let answer: ThreadConversation;
				try {
					answer = options.conversation(
						url.searchParams.get("origin") ?? "",
						url.searchParams.get("before") || undefined,
					);
				} catch (error) {
					options.onError?.(error);
					return jsonReply({ error: "conversation_failed" }, 500, head);
				}
				return answer.ok
					? jsonReply(
							{ turns: answer.turns, ...(answer.cursor === undefined ? {} : { cursor: answer.cursor }) },
							200,
							head,
						)
					: jsonReply({ error: answer.error }, 404, head);
			}
			if (MONITOR_DETAIL.test(pathname)) {
				if (options.monitorDetail === undefined) return jsonReply({ error: "monitor_detail_disabled" }, 404, head);
				const id = (url.searchParams.get("id") ?? "").trim();
				if (id === "") return jsonReply({ error: "invalid_id" }, 400, head);
				let answer: MonitorDetail;
				try {
					answer = options.monitorDetail(id);
				} catch (error) {
					options.onError?.(error);
					return jsonReply({ error: "monitor_detail_failed" }, 500, head);
				}
				return answer.ok ? jsonReply(answer, 200, head) : jsonReply({ error: answer.error }, 404, head);
			}
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
			const [view, card, task, item, layout] = ["view", "card", "task", "item", "layout"].map(param);
			return isPage
				? reply(
						renderDashboardPage(snapshot, {
							...(board === undefined ? {} : { board: panel() }),
							...(view === undefined ? {} : { view }),
							...(card === undefined ? {} : { card }),
							...(task === undefined ? {} : { task }),
							...(item === undefined ? {} : { item }),
							...(layout === undefined ? {} : { layout }),
						}),
						"text/html; charset=utf-8",
						{ "content-security-policy": PAGE_CSP },
					)
				: reply(JSON.stringify(snapshot), "application/json; charset=utf-8");
		},
	});
}
