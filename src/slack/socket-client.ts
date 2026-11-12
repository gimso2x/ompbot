// Minimal native Slack Socket Mode client on Bun's global WebSocket.
// @slack/socket-mode depends on undici's ping(), which Bun does not implement, so it reconnect-loops under Bun.

export interface SocketClientHandlers {
	/** Called after the envelope is acked. */
	eventsApi(payload: unknown): Promise<void>;
	/** The returned object (if any) goes out in the ack as the slash response payload. */
	slashCommand(payload: unknown): Promise<object | undefined>;
	/** Called after the envelope is acked. */
	interactive(payload: unknown): Promise<void>;
}

export interface SocketClientOptions {
	appToken: string;
	handlers: SocketClientHandlers;
	/** Body-less errors only (never tokens). */
	onError?: (error: Error) => void;
	onHello?: () => void;
	/** Fired when a connection is being replaced (disconnect envelope, close, dead socket). */
	onReconnect?: (reason: string) => void;
	apiUrl?: string;
	fetchImpl?: typeof fetch;
	/** No traffic (message, ping or pong) for this long marks the socket dead. */
	deadAfterMs?: number;
	checkIntervalMs?: number;
	backoffBaseMs?: number;
	backoffMaxMs?: number;
	now?: () => number;
}

const FATAL_OPEN_ERRORS: Record<string, true> = {
	invalid_auth: true,
	not_authed: true,
	account_inactive: true,
	token_revoked: true,
	token_expired: true,
	missing_scope: true,
	not_allowed_token_type: true,
};

/** How long a handled envelope id is remembered against Slack's redelivery of it. */
const ENVELOPE_MEMORY_MS = 10 * 60_000;

class OpenError extends Error {
	readonly fatal: boolean;
	readonly retryAfterMs: number;
	constructor(message: string, fatal: boolean, retryAfterMs = 0) {
		super(message);
		this.name = "OpenError";
		this.fatal = fatal;
		this.retryAfterMs = retryAfterMs;
	}
}

export class SocketClient {
	private readonly opts: Required<Omit<SocketClientOptions, "onError" | "onHello" | "onReconnect">> &
		Pick<SocketClientOptions, "onError" | "onHello" | "onReconnect">;
	private ws: WebSocket | undefined;
	private stopped = true;
	private attempt = 0;
	/** Disconnect envelopes in a row on connections that carried nothing else and lived under `backoffMaxMs`. */
	private disconnectStreak = 0;
	private helloAt = 0;
	private lastTrafficAt = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private watchdog: ReturnType<typeof setInterval> | undefined;
	private firstHello: { resolve: () => void; reject: (e: Error) => void } | undefined;
	/** Bumped whenever a socket is replaced; callbacks of older sockets compare against it and bail. */
	private generation = 0;
	/** Envelope ids handled recently, oldest first (`seenEnvelope`). */
	private readonly envelopes = new Map<string, number>();

	constructor(options: SocketClientOptions) {
		this.opts = {
			apiUrl: "https://slack.com/api/apps.connections.open",
			fetchImpl: fetch,
			deadAfterMs: 120_000,
			checkIntervalMs: 15_000,
			backoffBaseMs: 1_000,
			backoffMaxMs: 30_000,
			now: Date.now,
			...options,
		};
	}

	/** Resolves on the first `hello`. Rejects when Slack refuses the app token; transient failures are retried. */
	start(): Promise<void> {
		if (!this.stopped) return Promise.reject(new Error("socket client already started"));
		this.stopped = false;
		this.attempt = 0;
		this.disconnectStreak = 0;
		const ready = new Promise<void>((resolve, reject) => {
			this.firstHello = { resolve, reject };
		});
		this.watchdog = setInterval(() => this.checkAlive(), this.opts.checkIntervalMs);
		void this.connect();
		return ready;
	}

	stop(): void {
		this.stopped = true;
		this.generation++;
		clearTimeout(this.reconnectTimer);
		clearInterval(this.watchdog);
		this.reconnectTimer = undefined;
		this.watchdog = undefined;
		this.firstHello?.reject(new Error("socket client stopped before hello"));
		this.firstHello = undefined;
		this.closeSocket();
	}

	private closeSocket(): void {
		const ws = this.ws;
		this.ws = undefined;
		if (!ws) return;
		try {
			ws.close();
		} catch {
			// already closed
		}
	}

	private report(err: unknown): void {
		this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
	}

	private async openUrl(): Promise<string> {
		let res: Response;
		try {
			res = await this.opts.fetchImpl(this.opts.apiUrl, {
				method: "POST",
				headers: {
					authorization: `Bearer ${this.opts.appToken}`,
					"content-type": "application/x-www-form-urlencoded",
				},
			});
		} catch (err) {
			throw new OpenError(`apps.connections.open request failed: ${(err as Error).message}`, false);
		}
		if (res.status === 429) {
			const retry = Number(res.headers.get("retry-after") ?? 1);
			throw new OpenError("apps.connections.open rate limited", false, (Number.isFinite(retry) ? retry : 1) * 1000);
		}
		let body: { ok?: boolean; url?: string; error?: string } | null;
		try {
			body = (await res.json()) as typeof body;
		} catch {
			throw new OpenError(`apps.connections.open returned HTTP ${res.status} without JSON`, false);
		}
		if (typeof body !== "object" || body === null || Array.isArray(body))
			throw new OpenError(`apps.connections.open returned HTTP ${res.status} without a JSON object`, false);
		if (!body.ok || !body.url) {
			const code = body.error ?? `http_${res.status}`;
			throw new OpenError(`apps.connections.open failed: ${code}`, FATAL_OPEN_ERRORS[code] === true);
		}
		// The url carries a connection ticket, so it is never quoted in the error.
		const scheme = URL.parse(String(body.url))?.protocol;
		if (scheme !== "wss:" && scheme !== "ws:")
			throw new OpenError(`apps.connections.open returned a bad url (scheme ${scheme ?? "none"})`, false);
		return body.url;
	}

	private async connect(): Promise<void> {
		if (this.stopped) return;
		const gen = ++this.generation;
		let url: string;
		try {
			url = await this.openUrl();
		} catch (err) {
			if (gen !== this.generation) return;
			const open = err instanceof OpenError ? err : new OpenError(String(err), false);
			this.report(open);
			if (open.fatal && this.firstHello) {
				const first = this.firstHello;
				this.firstHello = undefined;
				this.stop();
				first.reject(open);
				return;
			}
			this.scheduleReconnect(open.retryAfterMs);
			return;
		}
		if (gen !== this.generation) return;

		let ws: WebSocket;
		try {
			ws = new WebSocket(url);
		} catch (err) {
			this.report(new Error(`websocket open failed: ${err instanceof Error ? err.name : "error"}`));
			this.scheduleReconnect(0);
			return;
		}
		this.ws = ws;
		this.lastTrafficAt = this.opts.now();
		const current = (): boolean => gen === this.generation && this.ws === ws;
		const touch = (): void => {
			if (current()) this.lastTrafficAt = this.opts.now();
		};
		ws.addEventListener("ping", touch);
		ws.addEventListener("pong", touch);
		ws.addEventListener("message", (ev) => {
			if (!current()) return;
			this.lastTrafficAt = this.opts.now();
			this.onMessage(ws, ev.data);
		});
		ws.addEventListener("error", () => {
			if (current()) this.report(new Error("websocket error"));
		});
		ws.addEventListener("close", () => {
			if (current()) this.reconnect("socket closed", false);
		});
	}

	private onMessage(ws: WebSocket, data: unknown): void {
		let msg: { type?: string; envelope_id?: string; payload?: unknown; reason?: string };
		try {
			msg = JSON.parse(typeof data === "string" ? data : String(data));
		} catch {
			this.report(new Error("unparseable websocket message"));
			return;
		}
		if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
			this.report(new Error("non-object websocket message"));
			return;
		}
		if (msg.type === "hello") {
			this.attempt = 0;
			this.helloAt = this.opts.now();
			this.opts.onHello?.();
			const first = this.firstHello;
			this.firstHello = undefined;
			first?.resolve();
			return;
		}
		if (msg.type === "disconnect") {
			// A lone refresh reconnects at once; a server that keeps disconnecting right after hello gets the backoff.
			if (this.opts.now() - this.helloAt >= this.opts.backoffMaxMs) this.disconnectStreak = 0;
			this.disconnectStreak++;
			const reason = `disconnect:${msg.reason ?? "unknown"}`;
			if (this.disconnectStreak === 1) this.reconnect(reason, true);
			else {
				const delay = Math.min(this.opts.backoffMaxMs, this.opts.backoffBaseMs * 2 ** (this.disconnectStreak - 2));
				this.reconnect(reason, false, delay);
			}
			return;
		}
		if (!msg.envelope_id) return;
		this.disconnectStreak = 0;
		const id = msg.envelope_id;
		const ack = (payload?: object): void => {
			if (ws.readyState !== WebSocket.OPEN) return;
			ws.send(JSON.stringify(payload === undefined ? { envelope_id: id } : { envelope_id: id, payload }));
		};
		// Slack resends an envelope whose ack it missed: ack it again, but run its handler only once.
		if (this.seenEnvelope(id)) {
			ack();
			return;
		}
		const h = this.opts.handlers;
		switch (msg.type) {
			case "events_api":
				ack();
				void h.eventsApi(msg.payload).catch((e) => this.report(e));
				break;
			case "interactive":
				ack();
				void h.interactive(msg.payload).catch((e) => this.report(e));
				break;
			case "slash_commands":
				void h
					.slashCommand(msg.payload)
					.catch((e) => {
						this.report(e);
						return undefined;
					})
					.then((response) => ack(response));
				break;
			default:
				ack(); // unknown envelope types are acked so Slack does not redeliver them
		}
	}

	/** Whether `id` was handled within `ENVELOPE_MEMORY_MS`; remembers it otherwise. */
	private seenEnvelope(id: string): boolean {
		const now = this.opts.now();
		for (const [seen, at] of this.envelopes) {
			if (now - at < ENVELOPE_MEMORY_MS) break;
			this.envelopes.delete(seen);
		}
		if (this.envelopes.has(id)) return true;
		this.envelopes.set(id, now);
		return false;
	}

	private checkAlive(): void {
		if (this.stopped || !this.ws) return;
		const idle = this.opts.now() - this.lastTrafficAt;
		if (idle > this.opts.deadAfterMs) {
			this.reconnect(`no traffic for ${idle}ms`, true);
			return;
		}
		// Quiet but not yet dead: solicit a pong so a healthy idle socket keeps showing traffic.
		if (idle > this.opts.deadAfterMs / 2 && this.ws.readyState === WebSocket.OPEN) this.ws.ping();
	}

	private reconnect(reason: string, immediate: boolean, minDelayMs = 0): void {
		if (this.stopped) return;
		this.generation++; // detaches the old socket's callbacks
		this.closeSocket();
		this.opts.onReconnect?.(reason);
		if (immediate) {
			this.attempt = 0;
			void this.connect();
		} else {
			this.scheduleReconnect(minDelayMs);
		}
	}

	private scheduleReconnect(minDelayMs: number): void {
		if (this.stopped || this.reconnectTimer) return;
		const backoff = Math.min(this.opts.backoffMaxMs, this.opts.backoffBaseMs * 2 ** this.attempt++);
		this.reconnectTimer = setTimeout(
			() => {
				this.reconnectTimer = undefined;
				void this.connect();
			},
			Math.max(backoff, Number.isFinite(minDelayMs) ? minDelayMs : 0),
		);
	}
}
