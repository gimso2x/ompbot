// A local stand-in for Microsoft: OpenID metadata and key sets (Bot Framework and one Entra tenant), the token endpoint
// and a Bot Connector that records every activity call. Keys are local RS256 pairs; nothing leaves the machine.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OmpbotConfig, TeamsChannelConfig } from "../../src/config";
import { Daemon } from "../../src/daemon/daemon";
import type { ProcessRunner } from "../../src/dispatch/omp";
import { createLogger } from "../../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../../src/omp/fake-driver";
import { redact } from "../../src/redact";
import { TeamsAuth } from "../../src/teams/auth";
import { TeamsBinding } from "../../src/teams/binding";
import { TeamsChannel } from "../../src/teams/channel";
import { TeamsConnector } from "../../src/teams/transport";
import type { TestHome } from "../helpers/bot-home";

export const APP_ID = "3e1d5752-881a-4244-b653-9d0dacfb9013";
export const TENANT = "11111111-2222-3333-4444-555555555555";
export const OTHER_TENANT = "99999999-2222-3333-4444-555555555555";
export const OWNER_AAD = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
export const STRANGER_AAD = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
export const GUEST_AAD = "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee";
export const BOT_ID = `28:${APP_ID}`;
export const GROUP_CHAT = "19:abcdef0123456789@thread.v2";
export const PERSONAL_CHAT = "a:1personalchatid";

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

export interface KeyPair {
	kid: string;
	privateKey: CryptoKey;
	/** The public half as a JWK (`kty`, `n`, `e`). */
	jwk: Record<string, unknown>;
}

export async function makeKey(kid: string): Promise<KeyPair> {
	const pair = (await crypto.subtle.generateKey(
		{ ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Record<string, unknown>;
	return { kid, privateKey: pair.privateKey, jwk };
}

const b64url = (bytes: Uint8Array): string =>
	btoa(String.fromCharCode(...bytes))
		.replace(/=+$/, "")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");

export async function signJwt(key: KeyPair, claims: Record<string, unknown>, kid = key.kid): Promise<string> {
	const encode = (value: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(value)));
	const head = `${encode({ alg: "RS256", typ: "JWT", kid })}.${encode(claims)}`;
	const signature = await crypto.subtle.sign(RS256, key.privateKey, new TextEncoder().encode(head));
	return `${head}.${b64url(new Uint8Array(signature))}`;
}

export interface ConnectorCall {
	method: string;
	path: string;
	body: Record<string, unknown>;
	authorization: string | null;
}

/** The fake Microsoft endpoints on one loopback server. */
export class FakeMicrosoft {
	readonly calls: ConnectorCall[] = [];
	readonly #waiters = new Set<() => void>();
	#server: Bun.Server<undefined> | undefined;
	#next = 0;
	botFrameworkKey!: KeyPair;
	entraKey!: KeyPair;

	get base(): string {
		return `http://127.0.0.1:${this.#server?.port}`;
	}
	get serviceUrl(): string {
		return `${this.base}/svc/`;
	}
	get botFrameworkOpenIdUrl(): string {
		return `${this.base}/bf/openid`;
	}
	entraOpenIdUrl = (tenant: string): string => `${this.base}/entra/${tenant}/openid`;
	get tokenUrl(): string {
		return `${this.base}/token`;
	}

	async start(): Promise<void> {
		this.botFrameworkKey = await makeKey("bf-key");
		this.entraKey = await makeKey("entra-key");
		this.#server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => this.#handle(request) });
	}

	async stop(): Promise<void> {
		await this.#server?.stop(true);
	}

	async #handle(request: Request): Promise<Response> {
		const path = new URL(request.url).pathname;
		if (path === "/bf/openid") return Response.json({ jwks_uri: `${this.base}/bf/keys` });
		if (path === "/bf/keys") {
			return Response.json({ keys: [{ ...this.botFrameworkKey.jwk, kid: "bf-key", endorsements: ["msteams"] }] });
		}
		if (path === `/entra/${TENANT}/openid`) return Response.json({ jwks_uri: `${this.base}/entra/keys` });
		if (path === "/entra/keys") return Response.json({ keys: [{ ...this.entraKey.jwk, kid: "entra-key" }] });
		if (path === "/token") return Response.json({ access_token: "fake-access-token", expires_in: 3600 });
		if (path.startsWith("/svc/v3/conversations/")) {
			const text = await request.text();
			this.calls.push({
				method: request.method,
				path: path.slice("/svc".length),
				body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
				authorization: request.headers.get("authorization"),
			});
			for (const wake of [...this.#waiters]) wake();
			this.#next += 1;
			return Response.json({ id: `bot-${this.#next}` });
		}
		return new Response("not found", { status: 404 });
	}

	/** Resolves with the first recorded call `match` accepts (already there, or the next one); bounded. */
	waitFor(match: (call: ConnectorCall) => boolean, timeoutMs = 5_000): Promise<ConnectorCall> {
		const { promise, resolve, reject } = Promise.withResolvers<ConnectorCall>();
		const wake = (): void => {
			const found = this.calls.find(match);
			if (found === undefined) return;
			clearTimeout(timer);
			this.#waiters.delete(wake);
			resolve(found);
		};
		const timer = setTimeout(() => {
			this.#waiters.delete(wake);
			reject(new Error(`no matching connector call within ${timeoutMs}ms: ${JSON.stringify(this.calls)}`));
		}, timeoutMs);
		this.#waiters.add(wake);
		wake();
		return promise;
	}
}

/**
 * A daemon with Teams as its only platform (no Slack keys at all), its endpoint on a free loopback port and its
 * Microsoft calls all going to `ms`; the fake omp answers `ECHO <text>`.
 */
export async function startTeamsDaemon(
	home: TestHome,
	ms: FakeMicrosoft,
	logs: string[],
	options: {
		teams?: Partial<TeamsChannelConfig>;
		extra?: Partial<OmpbotConfig>;
		guestRun?: ProcessRunner;
		guestEnv?: Record<string, string | undefined>;
		teamsGraphEndpoints?: { loginBase: string; graphBase: string };
		attachmentFetch?: typeof fetch;
	} = {},
): Promise<{ daemon: Daemon; binding: TeamsBinding; port: number }> {
	const clientSecretFile = join(home.dir, "secrets", "teams-client-secret");
	writeFileSync(clientSecretFile, "fake-client-secret-0\n", { mode: 0o600 });
	const { slack: _slack, ...rest } = home.config;
	const config: OmpbotConfig = {
		...rest,
		channels: {
			teams: {
				appId: APP_ID,
				tenantId: TENANT,
				clientSecretFile,
				ownerAadObjectId: OWNER_AAD,
				listen: "127.0.0.1:3978",
				...options.teams,
			},
		},
		...options.extra,
	};
	const connector = new TeamsConnector({
		appId: APP_ID,
		clientSecret: () => "fake-client-secret-0",
		tokenTenant: TENANT,
		tokenUrl: ms.tokenUrl,
		allowServiceUrl: (url) => url.startsWith(ms.base),
	});
	const auth = new TeamsAuth({
		appId: APP_ID,
		tenantId: TENANT,
		botFrameworkOpenIdUrl: ms.botFrameworkOpenIdUrl,
		entraOpenIdUrl: ms.entraOpenIdUrl,
	});
	const binding = new TeamsBinding(new TeamsChannel(connector), {
		auth,
		listen: { hostname: "127.0.0.1", port: 0 },
		...(options.attachmentFetch === undefined ? {} : { attachmentFetch: options.attachmentFetch }),
	});
	const sessions = new FakeSessionStore();
	const daemon = new Daemon({
		config,
		channels: [binding],
		log: createLogger({ sink: (line) => logs.push(line), clock: { now: () => Date.now() }, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot",
		gateSweepMs: 0,
		driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		...(options.guestRun === undefined ? {} : { guestRun: options.guestRun }),
		...(options.guestEnv === undefined ? {} : { guestEnv: options.guestEnv }),
		...(options.teamsGraphEndpoints === undefined ? {} : { teamsGraphEndpoints: options.teamsGraphEndpoints }),
	});
	await daemon.start();
	const port = binding.adapter?.listenPort;
	if (port === undefined) throw new Error("teams endpoint did not start");
	return { daemon, binding, port };
}

/** Claims of a valid Bot Framework token for `serviceUrl`, valid for the next hour. */
export function botFrameworkClaims(serviceUrl: string, now = Date.now()): Record<string, unknown> {
	const seconds = Math.floor(now / 1000);
	return {
		iss: "https://api.botframework.com",
		aud: APP_ID,
		serviceurl: serviceUrl,
		nbf: seconds - 60,
		exp: seconds + 3600,
	};
}

/** A message Activity from `aadObjectId` in the chat; `mention` adds the bot mention tag and entity. */
export function messageActivity(input: {
	id: string;
	text: string;
	serviceUrl: string;
	aadObjectId?: string;
	conversationId?: string;
	conversationType?: "personal" | "groupChat";
	mention?: boolean;
	tenant?: string;
	name?: string;
}): Record<string, unknown> {
	const mention = input.mention ?? true;
	return {
		type: "message",
		id: input.id,
		channelId: "msteams",
		serviceUrl: input.serviceUrl,
		from: {
			id: `29:${input.aadObjectId ?? OWNER_AAD}`,
			aadObjectId: input.aadObjectId ?? OWNER_AAD,
			...(input.name === undefined ? {} : { name: input.name }),
		},
		conversation: {
			id: input.conversationId ?? GROUP_CHAT,
			conversationType: input.conversationType ?? "groupChat",
			tenantId: input.tenant ?? TENANT,
		},
		recipient: { id: BOT_ID, name: "ompbot" },
		text: mention ? `<at>ompbot</at> ${input.text}` : input.text,
		entities: mention ? [{ type: "mention", mentioned: { id: BOT_ID, name: "ompbot" }, text: "<at>ompbot</at>" }] : [],
		channelData: { tenant: { id: input.tenant ?? TENANT } },
	};
}

export async function postActivity(port: number, token: string | undefined, activity: unknown): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}/api/messages`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
		},
		body: JSON.stringify(activity),
	});
}
