// doc/plans/teams-graph-chat-read.md AC-1·AC-2·AC-5b·AC-6(데몬 쪽): channels.teams.graph가 없으면 도구 목록이 그대로,
// 있고 ownerMode full이면 두 도구는 피어 미개입 오너 Teams 1:1에만, qa면 어디에도 없고 경고 1줄. graph가 켜진 설정의
// teams/ch/* rpc 자식만 memory off overlay를 받는다. 데몬이 도구로 읽은 결과·로그·secret index도 여기서 본다.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { OmpbotConfig } from "../../src/config";
import type { Daemon } from "../../src/daemon/daemon";
import { rpcOverlayFor, TEAMS_GROUP_OVERLAY_YAML, teamsGroupOverlayPath } from "../../src/daemon/run";
import type { ProcessRunner } from "../../src/dispatch/omp";
import { createLogger } from "../../src/log";
import { clearSecretIndex, maskKnownFragments, REDACTED } from "../../src/redact";
import { PEER_TOOL_DENIED } from "../../src/safety/host-tools";
import { indexRuntimeSecrets } from "../../src/safety/secret-index";
import { writeGraphTokenFile } from "../../src/teams/graph";
import { teamsAlias } from "../../src/teams/types";
import { makeHome, type TestHome } from "../helpers/bot-home";
import { FakeGraph, tokenPath } from "./graph-fake";
import {
	botFrameworkClaims,
	FakeMicrosoft,
	GROUP_CHAT,
	GUEST_AAD,
	messageActivity,
	OWNER_AAD,
	PERSONAL_CHAT,
	postActivity,
	signJwt,
	startTeamsDaemon,
	TENANT,
} from "./harness";

const GRAPH_TOOLS = ["teams_list_chats", "teams_read_chat"];
/** The host tools of an owner Teams 1:1 before this feature (graph absent); no upload tool, the port cannot send files. */
const TEAMS_DM_TOOLS = ["ompbot_dispatch", "ompbot_request_approval"];
const GUEST_CHAT = "a:1guestpersonalchat";
const REFRESH = "fake-daemon-refresh-token-0001-abcdefghij";
const ACCESS = "fake-daemon-access-token-0001-ABCDEFGHIJ";

let home: TestHome;
let ms: FakeMicrosoft;
let graph: FakeGraph;
let daemon: Daemon | undefined;
let logs: string[];
let guestArgs: string[][];

const guestRun: ProcessRunner = async (cmd) => {
	guestArgs.push(cmd);
	return { code: 0, stdout: "손님 답", timedOut: false };
};

beforeEach(() => {
	home = makeHome("ompbot-teams-graph-tools-");
	logs = [];
	guestArgs = [];
	ms = new FakeMicrosoft();
	graph = new FakeGraph();
	graph.start();
	clearSecretIndex();
});

afterEach(async () => {
	await daemon?.stop();
	daemon = undefined;
	await ms.stop();
	await graph.stop();
	home.remove();
	clearSecretIndex();
});

const tokenFile = (): string => join(home.dir, "secrets", "teams-graph-token");

async function boot(teams: Record<string, unknown>): Promise<number> {
	await ms.start();
	const started = await startTeamsDaemon(home, ms, logs, {
		teams: { guestAadObjectIds: [GUEST_AAD], ...teams },
		guestRun,
		teamsGraphEndpoints: { loginBase: graph.loginBase, graphBase: graph.graphBase },
	});
	daemon = started.daemon;
	return started.port;
}

/** Posts a 1:1 / group message from `aad` and waits until the daemon has taken it (answer or guest run). */
async function say(
	port: number,
	input: { id: string; conversationId: string; personal: boolean; aad?: string },
): Promise<void> {
	const token = await signJwt(ms.botFrameworkKey, botFrameworkClaims(ms.serviceUrl.replace(/\/$/, "")));
	const response = await postActivity(
		port,
		token,
		messageActivity({
			id: input.id,
			text: `질문 ${input.id}`,
			serviceUrl: ms.serviceUrl,
			conversationId: input.conversationId,
			conversationType: input.personal ? "personal" : "groupChat",
			mention: !input.personal,
			...(input.aad === undefined ? {} : { aadObjectId: input.aad }),
		}),
	);
	expect(response.status).toBe(200);
}

const names = (origin: string): string[] => daemon?.hostToolsFor(origin).map((tool) => tool.name) ?? [];
const ownerDm = `teams/dm/${teamsAlias(PERSONAL_CHAT)}`;
const group = `teams/ch/${teamsAlias(GROUP_CHAT)}`;
const guestDm = `teams/dm/${teamsAlias(GUEST_CHAT)}`;

describe("graph 없음 (AC-1)", () => {
	test("도구 목록과 Teams 1:1 답이 지금과 같다", async () => {
		const port = await boot({});
		await say(port, { id: "dm-1", conversationId: PERSONAL_CHAT, personal: true });
		await ms.waitFor((call) => String(call.body.text).includes("ECHO 질문 dm-1"));
		expect(names(ownerDm)).toEqual(TEAMS_DM_TOOLS);
		expect(names(group)).toEqual(TEAMS_DM_TOOLS);
		expect(logs.some((line) => line.includes("teams_graph"))).toBe(false);
		expect(graph.calls).toHaveLength(0);
	});
});

describe("graph + ownerMode full (AC-2)", () => {
	test("피어 미개입 오너 1:1에만 두 도구가 있다", async () => {
		const port = await boot({ graph: { tokenFile: tokenFile() } });
		await say(port, { id: "dm-1", conversationId: PERSONAL_CHAT, personal: true });
		await ms.waitFor((call) => String(call.body.text).includes("ECHO 질문 dm-1"));

		expect(names(ownerDm)).toEqual([...TEAMS_DM_TOOLS.slice(0, 1), ...GRAPH_TOOLS, ...TEAMS_DM_TOOLS.slice(1)]);
		for (const origin of [group, "slack/dm/D0OWNER", "slack/ch/C0CHAN", "discord/dm/123456"]) {
			expect(names(origin).filter((name) => GRAPH_TOOLS.includes(name))).toEqual([]);
		}
		// 피어 봇 글이 들어온 1:1은 도구를 잃는다.
		daemon?.store.recordInbound({
			originKey: ownerDm,
			platformMessageId: `${teamsAlias(PERSONAL_CHAT)}:peer-1`,
			textRef: "peer",
			peerUserId: "29:peer",
		});
		expect(names(ownerDm).filter((name) => GRAPH_TOOLS.includes(name))).toEqual([]);
	});

	test("깨끗할 때 잡은 두 도구는 실행되다가 피어 글이 들어오면 실행 순간 거부된다 (호출 시점 가드)", async () => {
		writeGraphTokenFile(tokenFile(), {
			refresh_token: REFRESH,
			scope: "offline_access Chat.Read User.Read",
			obtainedAt: "2026-11-12T00:00:00.000Z",
			accountId: OWNER_AAD,
		});
		graph.routes.set(tokenPath(TENANT), () => Response.json({ access_token: ACCESS, expires_in: 3600 }));
		graph.routes.set("/v1.0/me/chats", () => Response.json({ value: [] }));
		graph.routes.set("/v1.0/chats/*", () => Response.json({ value: [] }));
		const port = await boot({ graph: { tokenFile: tokenFile() } });
		await say(port, { id: "dm-1", conversationId: PERSONAL_CHAT, personal: true });
		await ms.waitFor((call) => String(call.body.text).includes("ECHO 질문 dm-1"));
		const clean = daemon?.hostToolsFor(ownerDm) ?? [];
		const signal = new AbortController().signal;
		const run = (name: string, params: Record<string, unknown>) =>
			clean.find((tool) => tool.name === name)?.execute(params, { signal });
		const params: Record<string, Record<string, unknown>> = {
			teams_list_chats: {},
			teams_read_chat: { chatId: "19:one@unq.gbl.spaces" },
		};
		for (const name of GRAPH_TOOLS) expect(await run(name, params[name] ?? {})).toBeString();
		const graphCalls = graph.calls.length;

		daemon?.store.recordInbound({
			originKey: ownerDm,
			platformMessageId: `${teamsAlias(PERSONAL_CHAT)}:peer-1`,
			textRef: "peer",
			peerUserId: "29:peer",
		});
		// F \ R by name is exactly the two Graph tools.
		const reduced = new Set(names(ownerDm));
		expect(clean.map((tool) => tool.name).filter((name) => !reduced.has(name))).toEqual(GRAPH_TOOLS);
		for (const name of GRAPH_TOOLS) await expect(run(name, params[name] ?? {})).rejects.toThrow(PEER_TOOL_DENIED);
		expect(graph.calls).toHaveLength(graphCalls);
		const denied = logs.filter((line) => line.includes("event=host_tool_denied_peer"));
		expect(denied).toHaveLength(2);
		for (const name of GRAPH_TOOLS) expect(denied.some((line) => line.includes(`tool=${name}`))).toBe(true);
	});

	test("손님 1:1·그룹 질문은 읽기 전용 실행으로만 가고 도구를 받지 않는다", async () => {
		const port = await boot({ graph: { tokenFile: tokenFile() } });
		await say(port, { id: "g-1", conversationId: GUEST_CHAT, personal: true, aad: GUEST_AAD });
		await ms.waitFor((call) => String(call.body.text).includes("손님 답"));
		expect(guestArgs).toHaveLength(1);
		expect(guestArgs.flat().some((arg) => GRAPH_TOOLS.some((tool) => arg.includes(tool)))).toBe(false);
		// 손님 1:1 별칭은 오너가 쓴 1:1이 아니다: 그 origin을 물어도 도구가 없다.
		expect(names(guestDm).filter((name) => GRAPH_TOOLS.includes(name))).toEqual([]);
		// 레인·모니터 같은 채팅 밖 origin에도 없다.
		expect(names("lane/x").filter((name) => GRAPH_TOOLS.includes(name))).toEqual([]);
	});

	test("ownerMode qa면 어디에도 없고 시작 때 경고 1줄", async () => {
		const port = await boot({ graph: { tokenFile: tokenFile() }, ownerMode: "qa" });
		await say(port, { id: "dm-q", conversationId: PERSONAL_CHAT, personal: true });
		await ms.waitFor((call) => String(call.body.text).includes("손님 답"));
		for (const origin of [ownerDm, group]) {
			expect(names(origin).filter((name) => GRAPH_TOOLS.includes(name))).toEqual([]);
		}
		expect(guestArgs.flat().some((arg) => GRAPH_TOOLS.some((tool) => arg.includes(tool)))).toBe(false);
		const warnings = logs.filter((line) => line.includes("event=teams_graph_disabled"));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("level=warn");
		expect(warnings[0]).toContain("reason=ownerMode_qa");
	});
});

describe("그룹 origin 기억 끄기 (AC-5b)", () => {
	test("graph가 켜진 설정의 teams/ch/*에만 memory off overlay가 붙는다", () => {
		const base = home.config as OmpbotConfig;
		const teams = {
			appId: "3e1d5752-881a-4244-b653-9d0dacfb9013",
			tenantId: TENANT,
			clientSecretFile: join(home.dir, "secrets", "teams-client-secret"),
			ownerAadObjectId: OWNER_AAD,
			listen: "127.0.0.1:3978",
		};
		const withGraph: OmpbotConfig = { ...base, channels: { teams: { ...teams, graph: { tokenFile: tokenFile() } } } };
		const withoutGraph: OmpbotConfig = { ...base, channels: { teams } };
		expect(rpcOverlayFor(withGraph, group)).toBe(teamsGroupOverlayPath(home.dir));
		expect(rpcOverlayFor(withGraph, `${group}/t/1794445875395`)).toBe(teamsGroupOverlayPath(home.dir));
		for (const origin of [ownerDm, "slack/ch/C0CHAN", "discord/ch/123456", "lane/x"]) {
			expect(rpcOverlayFor(withGraph, origin)).toBeUndefined();
		}
		expect(rpcOverlayFor(withoutGraph, group)).toBeUndefined();
		expect(TEAMS_GROUP_OVERLAY_YAML).toBe('memory:\n  backend: "off"\n');
	});
});

describe("데몬 경로의 토큰 노출 없음 (AC-6)", () => {
	test("오너 1:1 도구가 가짜 Graph를 읽고, 결과·로그에 토큰이 없으며 시작 때 토큰이 secret index에 들어간다", async () => {
		writeGraphTokenFile(tokenFile(), {
			refresh_token: REFRESH,
			scope: "offline_access Chat.Read User.Read",
			obtainedAt: "2026-11-12T00:00:00.000Z",
			accountId: OWNER_AAD,
		});
		graph.routes.set(tokenPath(TENANT), () => Response.json({ access_token: ACCESS, expires_in: 3600 }));
		graph.routes.set("/v1.0/me/chats", () =>
			Response.json({
				value: [
					{
						id: "19:one@unq.gbl.spaces",
						chatType: "oneOnOne",
						topic: null,
						lastUpdatedDateTime: "2026-11-12T05:00:00Z",
						members: [{ displayName: "홍길동", userId: "dddddddd-0000-0000-0000-000000000000" }],
					},
				],
			}),
		);
		const port = await boot({ graph: { tokenFile: tokenFile() } });
		await say(port, { id: "dm-1", conversationId: PERSONAL_CHAT, personal: true });
		await ms.waitFor((call) => String(call.body.text).includes("ECHO 질문 dm-1"));
		const list = daemon?.hostToolsFor(ownerDm).find((tool) => tool.name === "teams_list_chats");
		const result = String(await list?.execute({}, { signal: new AbortController().signal }));
		expect(result).toContain("title=홍길동");
		expect(graph.callsTo("/v1.0/me/chats")[0]?.authorization).toBe(`Bearer ${ACCESS}`);
		for (const value of [REFRESH, ACCESS]) {
			expect([...logs, result].join("\n")).not.toContain(value);
			expect(Object.values(process.env).some((env) => env?.includes(value))).toBe(false);
		}

		// 데몬 시작 때의 색인(indexRuntimeSecrets)이 저장된 refresh 토큰을 읽어 넣는다.
		clearSecretIndex();
		expect(maskKnownFragments(`x ${REFRESH} y`)).toBe(`x ${REFRESH} y`);
		const config = { ...(home.config as OmpbotConfig), channels: daemonTeamsChannels() };
		indexRuntimeSecrets(config, {}, createLogger({ sink: () => {}, clock: { now: () => 0 }, redact: (t) => t }));
		expect(maskKnownFragments(`x ${REFRESH} y`)).toBe(`x ${REDACTED} y`);
	});
});

/** The `channels` of the booted daemon's config with graph on (the harness's teams block). */
function daemonTeamsChannels(): OmpbotConfig["channels"] {
	return {
		teams: {
			appId: "3e1d5752-881a-4244-b653-9d0dacfb9013",
			tenantId: TENANT,
			clientSecretFile: join(home.dir, "secrets", "teams-client-secret"),
			ownerAadObjectId: OWNER_AAD,
			listen: "127.0.0.1:3978",
			graph: { tokenFile: tokenFile() },
		},
	};
}
