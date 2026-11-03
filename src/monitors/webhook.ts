import { createHash, timingSafeEqual } from "node:crypto";
import type { Server } from "bun";
import type { Logger } from "../log";
import type { MonitorLedger, MonitorRow } from "./ledger";

export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
/** The part of a body that reaches the monitor event (and so the prompt); the rest is cut and marked. */
export const WEBHOOK_MAX_PAYLOAD_BYTES = 16 * 1024;
export const WEBHOOK_PATH_PREFIX = "/hook/";
/** Reason prefix of a post recorded while frozen; the same prefix the scheduler gives held-back slots. */
const WEBHOOK_FROZEN_SKIP = "frozen";

export type WebhookBind = "127.0.0.1" | "::1";

export interface WebhookServerDeps {
	ledger: MonitorLedger;
	log: Logger;
	clock: { now(): number };
	/** `config.webhook`. `port: 0` picks a free port (tests). */
	config: { port: number; bind?: WebhookBind };
	/** Called after an event was admitted, so the scheduler routes it without waiting for the next sweep. */
	onFired?: () => void;
	/**
	 * The freeze switch (`ompbot freeze`). While it is on a post is still answered 202 but recorded as skipped
	 * (`frozen`), like a cron slot that falls due while frozen: an admitted event kept waiting would fire after unfreeze.
	 */
	frozen?: () => unknown;
}

type WebhookMonitor = MonitorRow & { trigger: { kind: "webhook"; id: string; token: string } };

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

/** Constant-time comparison of the bearer token (both sides are hashed first so the length does not leak). */
function tokenMatches(header: string | null, token: string): boolean {
	const match = header === null ? null : /^Bearer (\S+)$/i.exec(header.trim());
	const given = match?.[1];
	// Always compare, so a missing header costs the same as a wrong one.
	const equal = timingSafeEqual(digest(given ?? ""), digest(token));
	return given !== undefined && equal;
}

/** UTF-8 text of `bytes`, cut to the payload limit with a visible marker. */
export function webhookPayload(bytes: Uint8Array): string | undefined {
	if (bytes.length === 0) return undefined;
	const cut = bytes.length > WEBHOOK_MAX_PAYLOAD_BYTES;
	let text = new TextDecoder().decode(cut ? bytes.subarray(0, WEBHOOK_MAX_PAYLOAD_BYTES) : bytes);
	// A cut inside a multi-byte character leaves one replacement character at the end.
	if (cut)
		text = `${text.replace(/\uFFFD$/, "")}\n…[잘림: 본문 ${bytes.length}바이트 중 ${WEBHOOK_MAX_PAYLOAD_BYTES}바이트만 전달]`;
	return text;
}

/** The URL a client POSTs to for hook `id`. */
export function webhookUrl(config: { port: number; bind?: string } | undefined, id: string): string {
	const bind = config?.bind ?? "127.0.0.1";
	return `http://${bind === "::1" ? "[::1]" : bind}:${config?.port ?? "?"}${WEBHOOK_PATH_PREFIX}${id}`;
}

const json = (status: number, body: Record<string, unknown>, headers?: Record<string, string>): Response =>
	Response.json(body, { status, ...(headers === undefined ? {} : { headers }) });

/**
 * Loopback-only HTTP listener for `webhook` monitor triggers: `POST /hook/<id>` with `Authorization: Bearer <token>`
 * admits one event whose payload is the (UTF-8, cut) body, through the same ledger path as every other trigger, so
 * the overlap rule applies. Answers 202 + event id, 401 bad token, 404 unknown/disabled hook, 405 non-POST, 413 body
 * over 256 KiB. Nothing but the monitor id and event id is ever logged.
 */
export class WebhookServer {
	readonly #deps: WebhookServerDeps;
	#server: Server<undefined> | undefined;

	constructor(deps: WebhookServerDeps) {
		this.#deps = deps;
	}

	/** The bound port, or undefined when not listening. */
	get port(): number | undefined {
		return this.#server?.port;
	}

	/** Starts listening. A bind failure is logged and reported as false: the daemon runs on without webhooks. */
	start(): boolean {
		const { config, log } = this.#deps;
		const hostname = config.bind ?? "127.0.0.1";
		try {
			this.#server = Bun.serve({
				hostname,
				port: config.port,
				maxRequestBodySize: WEBHOOK_MAX_BODY_BYTES,
				fetch: (request) =>
					this.#handle(request).catch((error: unknown) => {
						log.error("webhook_failed", { error: String(error) });
						return json(500, { error: "internal" });
					}),
			});
		} catch (error) {
			log.error("webhook_bind_failed", { bind: hostname, port: config.port, error: String(error) });
			return false;
		}
		log.info("webhook_listening", { bind: hostname, port: this.#server.port });
		return true;
	}

	stop(): void {
		const server = this.#server;
		this.#server = undefined;
		if (server === undefined) return;
		void server.stop(true);
		this.#deps.log.info("webhook_stopped", {});
	}

	#find(id: string): WebhookMonitor | undefined {
		for (const monitor of this.#deps.ledger.listMonitors()) {
			if (monitor.enabled && monitor.trigger.kind === "webhook" && monitor.trigger.id === id) {
				return monitor as WebhookMonitor;
			}
		}
		return undefined;
	}

	async #handle(request: Request): Promise<Response> {
		const { ledger, log, clock } = this.#deps;
		const { pathname } = new URL(request.url);
		const id = pathname.startsWith(WEBHOOK_PATH_PREFIX) ? pathname.slice(WEBHOOK_PATH_PREFIX.length) : "";
		const monitor = id === "" ? undefined : this.#find(id);
		if (monitor === undefined) return json(404, { error: "not_found" });
		if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { Allow: "POST" });
		if (!tokenMatches(request.headers.get("authorization"), monitor.trigger.token)) {
			log.warn("webhook_unauthorized", { monitor: monitor.id });
			return json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
		}
		const declared = Number(request.headers.get("content-length") ?? 0);
		if (declared > WEBHOOK_MAX_BODY_BYTES) return json(413, { error: "payload_too_large" });
		const bytes = new Uint8Array(await request.arrayBuffer());
		if (bytes.length > WEBHOOK_MAX_BODY_BYTES) return json(413, { error: "payload_too_large" });
		const payload = webhookPayload(bytes);
		const frozen = this.#deps.frozen?.() !== undefined;
		for (let slotAt = clock.now(); ; slotAt += 1) {
			const claim = ledger.claimSlot({
				monitorId: monitor.id,
				slotAt,
				payload,
				...(frozen ? { forceSkipReason: WEBHOOK_FROZEN_SKIP } : {}),
			});
			if (claim.status === "duplicate") continue;
			if (!("event" in claim)) return json(404, { error: "not_found" });
			log.info("webhook_fired", {
				monitor: monitor.id,
				event: claim.event.eventId,
				stage: claim.event.stage,
				bytes: bytes.length,
			});
			this.#deps.onFired?.();
			return json(202, { eventId: claim.event.eventId, stage: claim.event.stage });
		}
	}
}
