// Inbound authentication of the Bot Framework endpoint (doc/plans/teams-channel.md TASK B): every POST to
// `/api/messages` carries `Authorization: Bearer <JWT>`. The token's `iss` picks the key set — Bot Framework's own
// metadata, or the configured tenant's Entra metadata — and nothing else is accepted. RS256 is checked with Bun's
// `crypto.subtle`; `aud` must be the bot's app id, `exp`/`nbf` hold within a 5-minute clock skew, the `serviceurl`
// claim matches the Activity's `serviceUrl` (a trailing `/` aside) and an Entra token's tenant is the configured one.

const BOT_FRAMEWORK_ISSUER = "https://api.botframework.com";
const BOT_FRAMEWORK_OPENID_URL = "https://login.botframework.com/v1/.well-known/openidconfiguration";
export const entraOpenIdUrl = (tenantId: string): string =>
	`https://login.microsoftonline.com/${tenantId}/v2.0/.well-known/openid-configuration`;

/** Clock skew allowed on `exp` and `nbf`. */
const CLOCK_SKEW_MS = 5 * 60_000;
/** How long one fetched key set is trusted. */
const JWKS_TTL_MS = 24 * 60 * 60_000;
/** An unknown `kid` refetches the key set at most this often (a stream of forged kids cannot hammer the metadata). */
const KID_REFETCH_MIN_MS = 60_000;

type TeamsAuthReason =
	| "missing_bearer"
	| "malformed"
	| "algorithm"
	| "unknown_issuer"
	| "metadata_failed"
	| "unknown_kid"
	| "bad_signature"
	| "audience"
	| "expired"
	| "not_yet_valid"
	| "service_url"
	| "tenant"
	| "endorsement";

type TeamsAuthResult = { ok: true; issuer: string } | { ok: false; reason: TeamsAuthReason };

interface TeamsAuthOptions {
	appId: string;
	tenantId: string;
	fetchImpl?: typeof fetch;
	now?: () => number;
	/** Metadata URLs; tests point them at a local server. */
	botFrameworkOpenIdUrl?: string;
	entraOpenIdUrl?: (tenantId: string) => string;
}

interface SigningKey {
	key: CryptoKey;
	/** Channels the key is endorsed for (Bot Framework keys); absent: any. */
	endorsements: readonly string[] | undefined;
}

interface KeySet {
	keys: Map<string, SigningKey>;
	fetchedAt: number;
}

/** A service URL as the claim and the Activity are compared: trailing slashes do not count. */
function normalizeServiceUrl(url: string): string {
	return url.replace(/\/+$/, "");
}

function base64UrlBytes(text: string): Uint8Array<ArrayBuffer> | undefined {
	if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
	const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
	try {
		const binary = atob(padded);
		const out = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
		return out;
	} catch {
		return undefined;
	}
}

function decodeJson(part: string): Record<string, unknown> | undefined {
	const bytes = base64UrlBytes(part);
	if (bytes === undefined) return undefined;
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

export class TeamsAuth {
	readonly #appId: string;
	readonly #tenantId: string;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	readonly #botFrameworkUrl: string;
	readonly #entraUrl: (tenantId: string) => string;
	readonly #sets = new Map<string, KeySet>();

	constructor(options: TeamsAuthOptions) {
		this.#appId = options.appId.toLowerCase();
		this.#tenantId = options.tenantId.toLowerCase();
		this.#fetch = options.fetchImpl ?? fetch;
		this.#now = options.now ?? Date.now;
		this.#botFrameworkUrl = options.botFrameworkOpenIdUrl ?? BOT_FRAMEWORK_OPENID_URL;
		this.#entraUrl = options.entraOpenIdUrl ?? entraOpenIdUrl;
	}

	/** The metadata URL of an accepted issuer; `undefined` for every issuer this bot does not trust. */
	#metadataUrl(issuer: string): string | undefined {
		if (issuer === BOT_FRAMEWORK_ISSUER) return this.#botFrameworkUrl;
		const tenant = this.#tenantId;
		if (
			issuer === `https://sts.windows.net/${tenant}/` ||
			issuer === `https://login.microsoftonline.com/${tenant}/v2.0`
		) {
			return this.#entraUrl(tenant);
		}
		return undefined;
	}

	async #fetchJson(url: string): Promise<Record<string, unknown>> {
		const response = await this.#fetch(url, { headers: { accept: "application/json" } });
		if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
		return (await response.json()) as Record<string, unknown>;
	}

	async #loadKeys(metadataUrl: string): Promise<KeySet> {
		const metadata = await this.#fetchJson(metadataUrl);
		const jwksUri = metadata.jwks_uri;
		if (typeof jwksUri !== "string") throw new Error(`no jwks_uri in ${metadataUrl}`);
		const jwks = await this.#fetchJson(jwksUri);
		const keys = new Map<string, SigningKey>();
		for (const jwk of Array.isArray(jwks.keys) ? jwks.keys : []) {
			if (typeof jwk !== "object" || jwk === null) continue;
			const { kty, kid, n, e, endorsements } = jwk as Record<string, unknown>;
			if (kty !== "RSA" || typeof kid !== "string" || typeof n !== "string" || typeof e !== "string") continue;
			try {
				const key = await crypto.subtle.importKey("jwk", { kty, n, e, ext: true }, RS256, false, ["verify"]);
				keys.set(kid, {
					key,
					endorsements: Array.isArray(endorsements)
						? endorsements.filter((item): item is string => typeof item === "string")
						: undefined,
				});
			} catch {
				// A key this runtime cannot import is simply not offered.
			}
		}
		const set = { keys, fetchedAt: this.#now() };
		this.#sets.set(metadataUrl, set);
		return set;
	}

	/** The signing key `kid` of the issuer's set: a cached set within its TTL, refetched once for an unknown kid. */
	async #key(metadataUrl: string, kid: string): Promise<SigningKey | undefined> {
		const now = this.#now();
		let set = this.#sets.get(metadataUrl);
		if (set === undefined || now - set.fetchedAt >= JWKS_TTL_MS) set = await this.#loadKeys(metadataUrl);
		const known = set.keys.get(kid);
		if (known !== undefined || now - set.fetchedAt < KID_REFETCH_MIN_MS) return known;
		return (await this.#loadKeys(metadataUrl)).keys.get(kid);
	}

	/**
	 * Checks one request's `Authorization` header against the Activity it carries. Never throws: a failed metadata
	 * fetch is `metadata_failed`.
	 */
	async verify(
		authorization: string | null | undefined,
		activity: { serviceUrl?: unknown; channelId?: unknown },
	): Promise<TeamsAuthResult> {
		const fail = (reason: TeamsAuthReason): TeamsAuthResult => ({ ok: false, reason });
		const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(authorization ?? "");
		if (match === null) return fail(authorization ? "malformed" : "missing_bearer");
		const [, headerPart = "", payloadPart = "", signaturePart = ""] = match;
		const header = decodeJson(headerPart);
		const claims = decodeJson(payloadPart);
		const signature = base64UrlBytes(signaturePart);
		if (header === undefined || claims === undefined || signature === undefined) return fail("malformed");
		if (header.alg !== "RS256" || typeof header.kid !== "string") return fail("algorithm");
		const issuer = typeof claims.iss === "string" ? claims.iss : "";
		const metadataUrl = this.#metadataUrl(issuer);
		if (metadataUrl === undefined) return fail("unknown_issuer");
		let key: SigningKey | undefined;
		try {
			key = await this.#key(metadataUrl, header.kid);
		} catch {
			return fail("metadata_failed");
		}
		if (key === undefined) return fail("unknown_kid");
		const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
		if (!(await crypto.subtle.verify(RS256, key.key, signature, signed))) return fail("bad_signature");

		const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
		if (!audiences.some((aud) => typeof aud === "string" && aud.toLowerCase() === this.#appId)) {
			return fail("audience");
		}
		const now = this.#now();
		if (typeof claims.exp !== "number" || now > claims.exp * 1000 + CLOCK_SKEW_MS) return fail("expired");
		if (typeof claims.nbf === "number" && now < claims.nbf * 1000 - CLOCK_SKEW_MS) return fail("not_yet_valid");

		const channelId = typeof activity.channelId === "string" ? activity.channelId : undefined;
		if (key.endorsements !== undefined && (channelId === undefined || !key.endorsements.includes(channelId))) {
			return fail("endorsement");
		}
		const serviceUrl = typeof activity.serviceUrl === "string" ? activity.serviceUrl : undefined;
		const claimed = typeof claims.serviceurl === "string" ? claims.serviceurl : undefined;
		// A Bot Framework token always names the service URL; an Entra one, when it does, must agree too.
		if ((issuer === BOT_FRAMEWORK_ISSUER && claimed === undefined) || serviceUrl === undefined) {
			return fail("service_url");
		}
		if (claimed !== undefined && normalizeServiceUrl(claimed) !== normalizeServiceUrl(serviceUrl)) {
			return fail("service_url");
		}
		if (
			issuer !== BOT_FRAMEWORK_ISSUER &&
			typeof claims.tid === "string" &&
			claims.tid.toLowerCase() !== this.#tenantId
		) {
			return fail("tenant");
		}
		return { ok: true, issuer };
	}
}
