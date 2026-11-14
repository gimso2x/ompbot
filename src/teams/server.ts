// The Bot Framework endpoint: `POST /api/messages` on a loopback listener (a tunnel outside the daemon gives it its
// public HTTPS). A request is authenticated first; an accepted Activity is handed on and answered 200 at once — the
// answer itself goes out later through the Bot Connector.
import type { Logger } from "../log";
import type { TeamsAuth } from "./auth";
import type { TeamsActivity } from "./types";

/** Larger bodies are refused before parsing (a Teams message Activity is a few KB). */
const MAX_ACTIVITY_BYTES = 1024 * 1024;

interface TeamsServerOptions {
	hostname: string;
	/** 0: any free port (tests). */
	port: number;
	auth: TeamsAuth;
	log: Logger;
	/** Takes an authenticated Activity; the request is answered once it returns. Must not throw. */
	onActivity(activity: TeamsActivity): Promise<void>;
}

export class TeamsServer {
	readonly #options: TeamsServerOptions;
	#server: Bun.Server<undefined> | undefined;

	constructor(options: TeamsServerOptions) {
		this.#options = options;
	}

	/** Starts listening; returns the bound port. */
	start(): number {
		const { hostname, port } = this.#options;
		this.#server = Bun.serve({ hostname, port, fetch: (request) => this.#handle(request) });
		return this.#server.port ?? port;
	}

	async stop(): Promise<void> {
		await this.#server?.stop(true);
		this.#server = undefined;
	}

	async #handle(request: Request): Promise<Response> {
		const { auth, log, onActivity } = this.#options;
		if (new URL(request.url).pathname !== "/api/messages") return new Response("not found", { status: 404 });
		if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
		if (Number(request.headers.get("content-length") ?? 0) > MAX_ACTIVITY_BYTES) {
			return new Response("too large", { status: 413 });
		}
		const text = await request.text();
		if (text.length > MAX_ACTIVITY_BYTES) return new Response("too large", { status: 413 });
		let activity: TeamsActivity;
		try {
			const parsed: unknown = JSON.parse(text);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
			activity = parsed as TeamsActivity;
		} catch {
			return new Response("bad request", { status: 400 });
		}
		const verdict = await auth.verify(request.headers.get("authorization"), activity);
		if (!verdict.ok) {
			log.warn("teams_auth_rejected", { reason: verdict.reason });
			return new Response("unauthorized", { status: 401 });
		}
		await onActivity(activity);
		return new Response(null, { status: 200 });
	}
}
