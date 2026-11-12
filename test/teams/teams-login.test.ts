// doc/plans/teams-graph-chat-read.md AC-3: `ompbot teams login`을 가짜 Entra·Graph 서버로 시험한다 — device code →
// pending → slow_down → 성공 폴링, 오너 id 일치 시 0600 원자 저장, 불일치 시 저장 없이 teams_graph_wrong_account,
// AADSTS65001(관리자 동의)·public client 비활성 안내 문구.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { teamsLogin } from "../../src/cli/teams";
import type { TeamsChannelConfig } from "../../src/config";
import { deviceCodePath, FakeGraph, tokenPath } from "./graph-fake";
import { APP_ID, OWNER_AAD, STRANGER_AAD, TENANT } from "./harness";

const REFRESH = "fake-login-refresh-token-0001-abcdefghij";
const ACCESS = "fake-login-access-token-0001-ABCDEFGHIJ";

let dir: string;
let graph: FakeGraph;
let teams: TeamsChannelConfig;
let out: string[];
let err: string[];
let slept: number[];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-teams-login-"));
	graph = new FakeGraph();
	graph.start();
	teams = {
		appId: APP_ID,
		tenantId: TENANT,
		clientSecretFile: join(dir, "secrets", "teams-client-secret"),
		ownerAadObjectId: OWNER_AAD,
		listen: "127.0.0.1:3978",
		graph: { tokenFile: join(dir, "secrets", "teams-graph-token") },
	};
	out = [];
	err = [];
	slept = [];
});

afterEach(async () => {
	await graph.stop();
	rmSync(dir, { recursive: true, force: true });
});

const login = (): Promise<number> =>
	teamsLogin(teams, {
		loginBase: graph.loginBase,
		graphBase: graph.graphBase,
		out: (line) => out.push(line),
		err: (line) => err.push(line),
		sleep: async (ms) => {
			slept.push(ms);
		},
	});

function deviceCodeOk(): void {
	graph.routes.set(deviceCodePath(TENANT), () =>
		Response.json({
			device_code: "fake-device-code",
			user_code: "ABCD-EFGH",
			verification_uri: "https://microsoft.com/devicelogin",
			expires_in: 900,
			interval: 2,
		}),
	);
}

/** pending → slow_down → tokens. */
function pollSequence(): void {
	const answers = [
		() => Response.json({ error: "authorization_pending" }, { status: 400 }),
		() => Response.json({ error: "slow_down" }, { status: 400 }),
		() =>
			Response.json({ access_token: ACCESS, refresh_token: REFRESH, scope: "Chat.Read User.Read", expires_in: 3600 }),
	];
	let index = 0;
	graph.routes.set(tokenPath(TENANT), () => {
		const answer = answers[index] ?? answers[answers.length - 1];
		index += 1;
		if (answer === undefined) throw new Error("no answer");
		return answer();
	});
}

describe("teams login (AC-3)", () => {
	test("pending → slow_down → 성공 폴링 뒤 오너면 0600으로 원자 저장한다", async () => {
		deviceCodeOk();
		pollSequence();
		graph.routes.set("/v1.0/me", () => Response.json({ id: OWNER_AAD.toUpperCase() }));
		expect(await login()).toBe(0);

		const device = graph.callsTo(deviceCodePath(TENANT))[0];
		expect(device?.form).toEqual({ client_id: APP_ID, scope: "offline_access Chat.Read User.Read" });
		const polls = graph.callsTo(tokenPath(TENANT));
		expect(polls).toHaveLength(3);
		expect(polls.every((call) => call.form.grant_type === "urn:ietf:params:oauth:grant-type:device_code")).toBe(true);
		expect(polls.every((call) => call.form.device_code === "fake-device-code")).toBe(true);
		// interval 2초를 지키고, slow_down 뒤에는 5초 더 늘린다.
		expect(slept).toEqual([2_000, 2_000, 7_000]);
		expect(graph.callsTo("/v1.0/me")[0]?.authorization).toBe(`Bearer ${ACCESS}`);

		const tokenFile = teams.graph?.tokenFile ?? "";
		const stored = JSON.parse(readFileSync(tokenFile, "utf8")) as Record<string, string>;
		expect(stored.refresh_token).toBe(REFRESH);
		expect(stored.accountId).toBe(OWNER_AAD);
		expect(stored.scope).toBe("Chat.Read User.Read");
		expect(Number.isNaN(Date.parse(stored.obtainedAt ?? ""))).toBe(false);
		expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
		expect(readdirSync(join(dir, "secrets"))).toEqual(["teams-graph-token"]);
		expect(out[0]).toBe("teams_login code=ABCD-EFGH url=https://microsoft.com/devicelogin");
		expect(out.at(-1)).toBe(`teams_graph_login_saved ${tokenFile}`);
		expect([...out, ...err].join("\n")).not.toContain(REFRESH);
		expect([...out, ...err].join("\n")).not.toContain(ACCESS);
	});

	test("다른 계정이면 저장하지 않고 teams_graph_wrong_account", async () => {
		deviceCodeOk();
		pollSequence();
		graph.routes.set("/v1.0/me", () => Response.json({ id: STRANGER_AAD }));
		expect(await login()).toBe(1);
		expect(err.join("\n")).toContain("teams_graph_wrong_account");
		expect(existsSync(teams.graph?.tokenFile ?? "")).toBe(false);
		expect(existsSync(join(dir, "secrets"))).toBe(false);
	});

	test("AADSTS65001이면 관리자 동의 안내, public client 비활성이면 그 설정 안내", async () => {
		deviceCodeOk();
		graph.routes.set(tokenPath(TENANT), () =>
			Response.json(
				{
					error: "invalid_grant",
					error_description: "AADSTS65001: The user or administrator has not consented to use the application.",
					error_codes: [65001],
				},
				{ status: 400 },
			),
		);
		expect(await login()).toBe(1);
		expect(err.at(-1)).toContain("teams_login_failed error=invalid_grant aadsts=65001");
		expect(err.at(-1)).toContain("관리자 동의");

		err = [];
		graph.routes.set(deviceCodePath(TENANT), () =>
			Response.json(
				{
					error: "invalid_client",
					error_description:
						"AADSTS7000218: The request body must contain the following parameter: 'client_assertion' or 'client_secret'.",
					error_codes: [7000218],
				},
				{ status: 401 },
			),
		);
		expect(await login()).toBe(1);
		expect(err.at(-1)).toContain("aadsts=7000218");
		expect(err.at(-1)).toContain("Allow public client flows");
		expect(existsSync(teams.graph?.tokenFile ?? "")).toBe(false);
	});

	test("channels.teams.graph가 없으면 아무 요청 없이 사용법 오류", async () => {
		const { graph: _graph, ...withoutGraph } = teams;
		teams = withoutGraph;
		expect(await login()).toBe(2);
		expect(err.join("\n")).toContain("channels.teams.graph");
		expect(graph.calls).toHaveLength(0);
	});
});
