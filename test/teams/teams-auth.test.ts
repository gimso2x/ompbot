// AC-B2: the endpoint takes Bot Framework tokens and Entra tokens of the configured tenant, and refuses (401, or a
// silent drop for an Activity of another tenant) every other token — nothing refused reaches the ledger.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Daemon } from "../../src/daemon/daemon";
import { makeHome, type TestHome } from "../helpers/bot-home";
import {
	APP_ID,
	botFrameworkClaims,
	FakeMicrosoft,
	makeKey,
	messageActivity,
	OTHER_TENANT,
	postActivity,
	signJwt,
	startTeamsDaemon,
	TENANT,
} from "./harness";

let home: TestHome;
let ms: FakeMicrosoft;
let daemon: Daemon;
let port: number;
const logs: string[] = [];
let seq = 0;

beforeAll(async () => {
	home = makeHome("ompbot-teams-auth-");
	ms = new FakeMicrosoft();
	await ms.start();
	({ daemon, port } = await startTeamsDaemon(home, ms, logs));
});

afterAll(async () => {
	await daemon.stop();
	await ms.stop();
	home.remove();
});

/** Posts one owner mention with `token` (and the Activity's tenant); returns the status and whether it was recorded. */
async function send(token: string | undefined, tenant = TENANT): Promise<{ status: number; recorded: boolean }> {
	seq += 1;
	const id = `auth-${seq}`;
	const before = daemon.store.listInbound().length;
	const response = await postActivity(
		port,
		token,
		messageActivity({ id, text: `질문 ${seq}`, serviceUrl: ms.serviceUrl, tenant }),
	);
	const rows = daemon.store.listInbound();
	return {
		status: response.status,
		recorded: rows.length > before && rows.some((row) => row.platformMessageId.endsWith(`:${id}`)),
	};
}

const serviceUrl = (): string => ms.serviceUrl.replace(/\/$/, "");
const minutes = (n: number): number => n * 60;

function entraClaims(issuer: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	const seconds = Math.floor(Date.now() / 1000);
	return { iss: issuer, aud: APP_ID, tid: TENANT, nbf: seconds - 60, exp: seconds + 3600, ...extra };
}

describe("accepted tokens", () => {
	test("a Bot Framework token (service URL claim without the trailing /) is taken", async () => {
		expect(await send(await signJwt(ms.botFrameworkKey, botFrameworkClaims(serviceUrl())))).toEqual({
			status: 200,
			recorded: true,
		});
	});

	test("Entra tokens of the configured tenant (v1 and v2 issuers) are taken", async () => {
		const v1 = await signJwt(ms.entraKey, entraClaims(`https://sts.windows.net/${TENANT}/`));
		const v2 = await signJwt(ms.entraKey, entraClaims(`https://login.microsoftonline.com/${TENANT}/v2.0`));
		expect(await send(v1)).toEqual({ status: 200, recorded: true });
		expect(await send(v2)).toEqual({ status: 200, recorded: true });
	});

	test("an expiry 4 minutes past is still inside the 5-minute clock skew", async () => {
		const claims = { ...botFrameworkClaims(serviceUrl()), exp: Math.floor(Date.now() / 1000) - minutes(4) };
		expect(await send(await signJwt(ms.botFrameworkKey, claims))).toEqual({ status: 200, recorded: true });
	});
});

describe("refused tokens: 401 or dropped, nothing recorded", () => {
	const refused = async (token: string | undefined, reason: string, tenant = TENANT): Promise<void> => {
		expect(await send(token, tenant)).toEqual({ status: 401, recorded: false });
		expect(logs.some((line) => line.includes("event=teams_auth_rejected") && line.includes(`reason=${reason}`))).toBe(
			true,
		);
	};

	test("no Authorization header", async () => {
		await refused(undefined, "missing_bearer");
	});

	test("a signature by a key that is not the issuer's", async () => {
		const forger = await makeKey("bf-key");
		await refused(await signJwt(forger, botFrameworkClaims(serviceUrl())), "bad_signature");
	});

	test("another audience", async () => {
		const claims = { ...botFrameworkClaims(serviceUrl()), aud: "00000000-0000-0000-0000-000000000000" };
		await refused(await signJwt(ms.botFrameworkKey, claims), "audience");
	});

	test("expired beyond the 5-minute skew", async () => {
		const claims = { ...botFrameworkClaims(serviceUrl()), exp: Math.floor(Date.now() / 1000) - minutes(6) };
		await refused(await signJwt(ms.botFrameworkKey, claims), "expired");
	});

	test("not valid until more than 5 minutes from now", async () => {
		const claims = { ...botFrameworkClaims(serviceUrl()), nbf: Math.floor(Date.now() / 1000) + minutes(6) };
		await refused(await signJwt(ms.botFrameworkKey, claims), "not_yet_valid");
	});

	test("an unknown issuer", async () => {
		const claims = { ...botFrameworkClaims(serviceUrl()), iss: "https://evil.example.com" };
		await refused(await signJwt(ms.botFrameworkKey, claims), "unknown_issuer");
	});

	test("a service URL claim other than the Activity's", async () => {
		await refused(
			await signJwt(ms.botFrameworkKey, botFrameworkClaims("https://smba.trafficmanager.net/kr")),
			"service_url",
		);
	});

	test("a Bot Framework token without a service URL claim", async () => {
		const { serviceurl: _omit, ...claims } = botFrameworkClaims(serviceUrl());
		await refused(await signJwt(ms.botFrameworkKey, claims), "service_url");
	});

	test("an Entra token of another tenant (its issuer is not trusted)", async () => {
		const token = await signJwt(
			ms.entraKey,
			entraClaims(`https://sts.windows.net/${OTHER_TENANT}/`, { tid: OTHER_TENANT }),
		);
		await refused(token, "unknown_issuer");
	});

	test("an Entra token of the right issuer naming another tenant id", async () => {
		const token = await signJwt(ms.entraKey, entraClaims(`https://sts.windows.net/${TENANT}/`, { tid: OTHER_TENANT }));
		await refused(token, "tenant");
	});

	test("a valid token for an Activity of another tenant is dropped", async () => {
		const token = await signJwt(ms.botFrameworkKey, botFrameworkClaims(serviceUrl()));
		expect(await send(token, OTHER_TENANT)).toEqual({ status: 200, recorded: false });
		expect(logs.some((line) => line.includes("event=inbound_dropped") && line.includes("reason=tenant_mismatch"))).toBe(
			true,
		);
	});
});
