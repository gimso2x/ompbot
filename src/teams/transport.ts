// Outbound Bot Connector calls (doc/plans/teams-channel.md TASK B): a client-credentials token for
// `https://api.botframework.com/.default`, then `POST/PUT/DELETE <serviceUrl>/v3/conversations/{id}/activities[/{id}]`.
// The service URL comes from an inbound Activity; the bearer token only ever goes to a Microsoft Bot Connector host.

export const BOT_CONNECTOR_SCOPE = "https://api.botframework.com/.default";
export const tokenUrlOf = (tenant: string): string => `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
/** A cached token is renewed this long before it expires. */
const TOKEN_EARLY_RENEW_MS = 5 * 60_000;
/** Retry-After when a 429 names none. */
const DEFAULT_RETRY_AFTER_MS = 5_000;

/** Hosts the Bot Connector answers on for Teams (public cloud). */
const CONNECTOR_HOSTS = [".botframework.com", ".trafficmanager.net", ".teams.microsoft.com"];

/** Default `allowServiceUrl`: https on a Bot Connector host, so the bearer token never goes elsewhere. */
export function isConnectorServiceUrl(serviceUrl: string): boolean {
	try {
		const url = new URL(serviceUrl);
		return url.protocol === "https:" && CONNECTOR_HOSTS.some((suffix) => url.hostname.endsWith(suffix));
	} catch {
		return false;
	}
}

/** A refused or failed call. `definitive`: nothing was posted (4xx); `ambiguous`: it may have been (5xx, network). */
export class TeamsCallError extends Error {
	readonly status: number | undefined;
	readonly kind: "definitive" | "ambiguous";

	constructor(message: string, status: number | undefined, kind: "definitive" | "ambiguous") {
		super(message);
		this.name = "TeamsCallError";
		this.status = status;
		this.kind = kind;
	}
}

/** 429: nothing was posted; try again after `retryAfterMs`. */
export class TeamsRateLimitedError extends Error {
	readonly retryAfterMs: number;

	constructor(retryAfterMs: number) {
		super(`teams rate limited: retry after ${retryAfterMs}ms`);
		this.name = "TeamsRateLimitedError";
		this.retryAfterMs = retryAfterMs;
	}
}

/** The part of an outbound Activity ompbot sends. */
export interface OutboundActivity {
	type: "message" | "typing";
	text?: string;
	textFormat?: "markdown" | "plain";
	replyToId?: string;
}

export interface TeamsConnectorOptions {
	appId: string;
	/** Read at every token request, so a rotated secret file needs no restart of the connector. */
	clientSecret: () => string;
	/** Tenant the token is asked from (`channels.teams.tokenTenant`, default the bot's tenant). */
	tokenTenant: string;
	fetchImpl?: typeof fetch;
	now?: () => number;
	/** Token endpoint; tests point it at a local server. */
	tokenUrl?: string;
	/** Which service URLs may receive the bearer token (default `isConnectorServiceUrl`). */
	allowServiceUrl?: (serviceUrl: string) => boolean;
}

function retryAfterMs(response: Response): number {
	const seconds = Number(response.headers.get("retry-after"));
	return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : DEFAULT_RETRY_AFTER_MS;
}

export class TeamsConnector {
	readonly #options: TeamsConnectorOptions;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	readonly #allow: (serviceUrl: string) => boolean;
	#token: { value: string; renewAt: number } | undefined;

	constructor(options: TeamsConnectorOptions) {
		this.#options = options;
		this.#fetch = options.fetchImpl ?? fetch;
		this.#now = options.now ?? Date.now;
		this.#allow = options.allowServiceUrl ?? isConnectorServiceUrl;
	}

	get botId(): string {
		return `28:${this.#options.appId}`;
	}

	async #accessToken(): Promise<string> {
		const cached = this.#token;
		if (cached !== undefined && this.#now() < cached.renewAt) return cached.value;
		const body = new URLSearchParams({
			grant_type: "client_credentials",
			client_id: this.#options.appId,
			client_secret: this.#options.clientSecret(),
			scope: BOT_CONNECTOR_SCOPE,
		});
		let response: Response;
		try {
			response = await this.#fetch(this.#options.tokenUrl ?? tokenUrlOf(this.#options.tokenTenant), {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body,
			});
		} catch (err) {
			throw new TeamsCallError(
				`token request failed: ${err instanceof Error ? err.message : String(err)}`,
				undefined,
				"definitive",
			);
		}
		// Nothing is posted before a token exists, so every token failure is definitive.
		if (!response.ok)
			throw new TeamsCallError(`token request refused: HTTP ${response.status}`, response.status, "definitive");
		const json = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
		if (typeof json.access_token !== "string")
			throw new TeamsCallError("token response without access_token", 200, "definitive");
		const lifetimeMs = (typeof json.expires_in === "number" ? json.expires_in : 3600) * 1000;
		this.#token = { value: json.access_token, renewAt: this.#now() + Math.max(0, lifetimeMs - TOKEN_EARLY_RENEW_MS) };
		return json.access_token;
	}

	#url(serviceUrl: string, conversationId: string, activityId?: string): string {
		if (!this.#allow(serviceUrl)) {
			throw new TeamsCallError(`service URL not allowed: ${serviceUrl}`, undefined, "definitive");
		}
		const base = `${serviceUrl.replace(/\/+$/, "")}/v3/conversations/${encodeURIComponent(conversationId)}/activities`;
		return activityId === undefined ? base : `${base}/${encodeURIComponent(activityId)}`;
	}

	async #call(method: "POST" | "PUT" | "DELETE", url: string, body?: unknown): Promise<Response> {
		const token = await this.#accessToken();
		let response: Response;
		try {
			response = await this.#fetch(url, {
				method,
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		} catch (err) {
			throw new TeamsCallError(
				`${method} failed: ${err instanceof Error ? err.message : String(err)}`,
				undefined,
				"ambiguous",
			);
		}
		if (response.status === 429) throw new TeamsRateLimitedError(retryAfterMs(response));
		if (response.status === 401) this.#token = undefined;
		if (!response.ok) {
			throw new TeamsCallError(
				`${method} refused: HTTP ${response.status}`,
				response.status,
				response.status >= 400 && response.status < 500 ? "definitive" : "ambiguous",
			);
		}
		return response;
	}

	/** Posts into the conversation; `replyToId` (an Activity id) makes it the reply to that message. */
	async sendActivity(
		serviceUrl: string,
		conversationId: string,
		activity: OutboundActivity,
	): Promise<{ id: string | undefined }> {
		const response = await this.#call("POST", this.#url(serviceUrl, conversationId, activity.replyToId), {
			...activity,
			from: { id: this.botId },
			conversation: { id: conversationId },
		});
		// Typing activities come back with a `null` body.
		const json = (await response.json().catch(() => null)) as { id?: unknown } | null;
		return { id: typeof json?.id === "string" ? json.id : undefined };
	}

	async updateActivity(
		serviceUrl: string,
		conversationId: string,
		activityId: string,
		activity: OutboundActivity,
	): Promise<void> {
		await this.#call("PUT", this.#url(serviceUrl, conversationId, activityId), {
			...activity,
			id: activityId,
			from: { id: this.botId },
			conversation: { id: conversationId },
		});
	}

	async deleteActivity(serviceUrl: string, conversationId: string, activityId: string): Promise<void> {
		await this.#call("DELETE", this.#url(serviceUrl, conversationId, activityId));
	}
}
