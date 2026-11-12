// doc/plans/teams-graph-chat-read.md AC-4·AC-5·AC-6: 위임 토큰 관리(single-flight 갱신, 캐시, 회전 원자 저장,
// invalid_grant 재로그인 안내·하루 1번 알림, 429 Retry-After 1회 재시도)와 두 도구의 결과 모양(nextLink·limit·since,
// HTML→텍스트, redact 후 인용 펜스, null 가드, $expand=members·topic null 1:1 제목), 토큰 값이 로그·결과·env에 없음.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botRpcEnv } from "../../src/daemon/run";
import { createLogger } from "../../src/log";
import { clearSecretIndex, maskKnownFragments, REDACTED, redact } from "../../src/redact";
import {
	buildTeamsGraphTools,
	htmlToText,
	RELOGIN_TEXT,
	TeamsGraphClient,
	writeGraphTokenFile,
} from "../../src/teams/graph";
import { FakeGraph, tokenPath } from "./graph-fake";
import { APP_ID, OWNER_AAD, TENANT } from "./harness";

const REFRESH_1 = "fake-graph-refresh-token-0001-abcdefghij";
const REFRESH_2 = "fake-graph-refresh-token-0002-klmnopqrst";
const ACCESS_1 = "fake-graph-access-token-0001-ABCDEFGHIJ";
const ACCESS_2 = "fake-graph-access-token-0002-KLMNOPQRST";

let dir: string;
let tokenFile: string;
let graph: FakeGraph;
let logs: string[];
let now: number;
let notices: string[];
let slept: number[];

function client(): TeamsGraphClient {
	return new TeamsGraphClient({
		tenantId: TENANT,
		clientId: APP_ID,
		tokenFile,
		ownerAadObjectId: OWNER_AAD,
		// The raw lines: proves the client never logs a token, not that the logger masks it.
		log: createLogger({ sink: (line) => logs.push(line), clock: { now: () => now }, redact: (text) => text }),
		notifyOwner: (text) => notices.push(text),
		loginBase: graph.loginBase,
		graphBase: graph.graphBase,
		now: () => now,
		sleep: async (ms) => {
			slept.push(ms);
		},
	});
}

/** The token endpoint answers each refresh with the next of `answers` (the last one repeats). */
function tokenAnswers(...answers: Array<() => Response | Promise<Response>>): void {
	let index = 0;
	graph.routes.set(tokenPath(TENANT), () => {
		const answer = answers[Math.min(index, answers.length - 1)];
		index += 1;
		if (answer === undefined) throw new Error("no answer");
		return answer();
	});
}

const accessAnswer =
	(access: string, extra: Record<string, unknown> = {}) =>
	() =>
		Response.json({ access_token: access, expires_in: 3600, token_type: "Bearer", ...extra });

const okMe = (): void => {
	graph.routes.set("/v1.0/me", () => Response.json({ id: OWNER_AAD }));
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-teams-graph-"));
	tokenFile = join(dir, "secrets", "teams-graph-token");
	writeGraphTokenFile(tokenFile, {
		refresh_token: REFRESH_1,
		scope: "offline_access Chat.Read User.Read",
		obtainedAt: "2026-11-12T00:00:00.000Z",
		accountId: OWNER_AAD,
	});
	graph = new FakeGraph();
	graph.start();
	logs = [];
	notices = [];
	slept = [];
	now = Date.parse("2026-11-12T06:00:00Z");
	clearSecretIndex();
});

afterEach(async () => {
	await graph.stop();
	rmSync(dir, { recursive: true, force: true });
	clearSecretIndex();
});

describe("토큰 관리 (AC-4)", () => {
	test("동시 호출 5개가 만료(없는) 토큰을 만나도 갱신 요청은 1번이고 모두 같은 access 토큰을 쓴다", async () => {
		const gate = Promise.withResolvers<void>();
		let entered = 0;
		const allIn = Promise.withResolvers<void>();
		graph.routes.set(tokenPath(TENANT), async () => {
			entered += 1;
			allIn.resolve();
			await gate.promise;
			return Response.json({ access_token: ACCESS_1, expires_in: 3600 });
		});
		okMe();
		const graphClient = client();
		const calls = Array.from({ length: 5 }, () => graphClient.get<{ id: string }>("/me"));
		await allIn.promise;
		gate.resolve();
		const results = await Promise.all(calls);
		expect(results.map((result) => result.id)).toEqual(Array(5).fill(OWNER_AAD));
		expect(entered).toBe(1);
		expect(graph.callsTo(tokenPath(TENANT))).toHaveLength(1);
		expect(graph.callsTo("/v1.0/me").map((call) => call.authorization)).toEqual(Array(5).fill(`Bearer ${ACCESS_1}`));
		const form = graph.callsTo(tokenPath(TENANT))[0]?.form;
		expect(form?.grant_type).toBe("refresh_token");
		expect(form?.refresh_token).toBe(REFRESH_1);
		expect(form?.client_id).toBe(APP_ID);
	});

	test("access 토큰은 캐시되고 만료 5분 전에 다시 받는다", async () => {
		tokenAnswers(accessAnswer(ACCESS_1), accessAnswer(ACCESS_2));
		okMe();
		const graphClient = client();
		await graphClient.get("/me");
		now += 30 * 60_000;
		await graphClient.get("/me");
		expect(graph.callsTo(tokenPath(TENANT))).toHaveLength(1);
		now += 26 * 60_000; // 56분: 만료(60분) 5분 전 안쪽
		await graphClient.get("/me");
		expect(graph.callsTo(tokenPath(TENANT))).toHaveLength(2);
		expect(graph.callsTo("/v1.0/me").map((call) => call.authorization)).toEqual([
			`Bearer ${ACCESS_1}`,
			`Bearer ${ACCESS_1}`,
			`Bearer ${ACCESS_2}`,
		]);
	});

	test("회전된 refresh 토큰은 0600 파일로 원자 저장되고 다음 갱신에 쓰인다", async () => {
		tokenAnswers(accessAnswer(ACCESS_1, { refresh_token: REFRESH_2 }), accessAnswer(ACCESS_2));
		okMe();
		const graphClient = client();
		await graphClient.get("/me");
		const stored = JSON.parse(readFileSync(tokenFile, "utf8")) as Record<string, string>;
		expect(stored.refresh_token).toBe(REFRESH_2);
		expect(stored.accountId).toBe(OWNER_AAD);
		expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
		// 임시 파일+rename: 옆에 남은 임시 파일이 없다.
		expect(readdirSync(join(dir, "secrets"))).toEqual(["teams-graph-token"]);
		now += 59 * 60_000;
		await graphClient.get("/me");
		expect(graph.callsTo(tokenPath(TENANT)).map((call) => call.form.refresh_token)).toEqual([REFRESH_1, REFRESH_2]);
	});

	test("invalid_grant면 도구 결과가 재로그인 안내이고 오너 알림은 하루 1번", async () => {
		tokenAnswers(() =>
			Response.json({ error: "invalid_grant", error_description: "AADSTS700082: expired" }, { status: 400 }),
		);
		const tools = buildTeamsGraphTools(client(), () => "f".repeat(16));
		const list = tools.find((tool) => tool.name === "teams_list_chats");
		const signal = new AbortController().signal;
		expect(await list?.execute({}, { signal })).toBe(RELOGIN_TEXT);
		expect(RELOGIN_TEXT).toContain("ompbot teams login");
		expect(await list?.execute({}, { signal })).toBe(RELOGIN_TEXT);
		expect(notices).toEqual([RELOGIN_TEXT]);
		now += 24 * 60 * 60_000 + 1;
		expect(await list?.execute({}, { signal })).toBe(RELOGIN_TEXT);
		expect(notices).toHaveLength(2);
	});

	test("Graph 429는 Retry-After를 지켜 1번 재시도하고, 두 번째 429는 상태 코드로 끝난다", async () => {
		tokenAnswers(accessAnswer(ACCESS_1));
		let meCalls = 0;
		graph.routes.set("/v1.0/me", () => {
			meCalls += 1;
			return meCalls === 1
				? Response.json({ error: { code: "TooManyRequests" } }, { status: 429, headers: { "retry-after": "2" } })
				: Response.json({ id: OWNER_AAD });
		});
		const graphClient = client();
		expect((await graphClient.get<{ id: string }>("/me")).id).toBe(OWNER_AAD);
		expect(slept).toEqual([2_000]);
		expect(meCalls).toBe(2);

		graph.routes.set("/v1.0/me/chats", () =>
			Response.json({ error: { code: "TooManyRequests" } }, { status: 429, headers: { "retry-after": "1" } }),
		);
		const list = buildTeamsGraphTools(graphClient).find((tool) => tool.name === "teams_list_chats");
		const result = await list?.execute({}, { signal: new AbortController().signal });
		expect(result).toBe("Teams Graph 요청 실패: status=429 code=TooManyRequests");
		expect(graph.callsTo("/v1.0/me/chats")).toHaveLength(2);
	});

	test("토큰 파일이 없으면 로그인 먼저 하라는 결과", async () => {
		rmSync(tokenFile);
		const list = buildTeamsGraphTools(client()).find((tool) => tool.name === "teams_list_chats");
		expect(await list?.execute({}, { signal: new AbortController().signal })).toContain("ompbot teams login");
		expect(graph.calls).toHaveLength(0);
	});
});

/** One Graph chat message. */
function message(id: number, at: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: String(id),
		messageType: "message",
		createdDateTime: at,
		from: { user: { displayName: `사람${id}`, id: `u${id}` } },
		body: { contentType: "text", content: text },
		...extra,
	};
}

describe("teams_read_chat (AC-5)", () => {
	const chatId = "19:abc@thread.v2";
	const messagesPath = `/v1.0/chats/${encodeURIComponent(chatId)}/messages`;

	/** Three pages, newest first: m6 m5 | m4 m3 | m2 m1. */
	function pagedChat(): void {
		const pages: Record<string, Record<string, unknown>> = {
			"1": {
				value: [message(6, "2026-11-12T06:00:00Z", "여섯"), message(5, "2026-11-12T05:00:00Z", "다섯")],
				"@odata.nextLink": `${graph.graphBase}/chats/${encodeURIComponent(chatId)}/messages?page=2`,
			},
			"2": {
				value: [message(4, "2026-11-12T04:00:00Z", "넷"), message(3, "2026-11-12T03:00:00Z", "셋")],
				"@odata.nextLink": `${graph.graphBase}/chats/${encodeURIComponent(chatId)}/messages?page=3`,
			},
			"3": { value: [message(2, "2026-11-12T02:00:00Z", "둘"), message(1, "2026-11-12T01:00:00Z", "하나")] },
		};
		graph.routes.set(messagesPath, (call) => {
			const page = new URL(`http://x${call.url}`).searchParams.get("page") ?? "1";
			return Response.json(pages[page]);
		});
	}

	const read = async (params: Record<string, unknown>): Promise<string> => {
		const tool = buildTeamsGraphTools(client(), () => "a".repeat(16)).find((t) => t.name === "teams_read_chat");
		return String(await tool?.execute(params, { signal: new AbortController().signal }));
	};

	test("nextLink를 따라가다 limit에서 멈추고 오래된 순으로 낸다", async () => {
		tokenAnswers(accessAnswer(ACCESS_1));
		pagedChat();
		const result = await read({ chatId, limit: 3 });
		expect(graph.callsTo(messagesPath)).toHaveLength(2);
		expect(result).toContain("메시지 3개");
		expect(result.indexOf("사람4: 넷")).toBeLessThan(result.indexOf("사람6: 여섯"));
		expect(result).not.toContain("셋");
		const all = await read({ chatId });
		expect(all).toContain("메시지 6개");
		expect(graph.callsTo(messagesPath)).toHaveLength(5);
	});

	test("since보다 오래된 메시지가 나오면 멈춘다", async () => {
		tokenAnswers(accessAnswer(ACCESS_1));
		pagedChat();
		const result = await read({ chatId, since: "2026-11-12T03:30:00Z" });
		expect(result).toContain("메시지 3개");
		expect(result).toContain("사람4: 넷");
		expect(result).not.toContain("사람3");
		expect(graph.callsTo(messagesPath)).toHaveLength(2);
	});

	test("HTML은 텍스트로, 본문은 redact 뒤 인용 펜스, 시스템 이벤트·null 필드는 오류 없이", async () => {
		tokenAnswers(accessAnswer(ACCESS_1));
		const key = `sk-${"x".repeat(24)}`;
		graph.routes.set(messagesPath, () =>
			Response.json({
				value: [
					message(5, "2026-11-12T05:00:00Z", `<p>키는 <b>${key}</b> 입니다&nbsp;&amp; 끝</p><div>둘째 줄</div>`, {
						body: { contentType: "html", content: `<p>키는 <b>${key}</b> 입니다&nbsp;&amp; 끝</p><div>둘째 줄</div>` },
					}),
					{
						id: "4",
						messageType: "systemEventMessage",
						createdDateTime: "2026-11-12T04:00:00Z",
						from: null,
						body: null,
					},
					message(3, "2026-11-12T03:00:00Z", "보낸 사람 없음", { from: null }),
					message(2, "2026-11-12T02:00:00Z", "사용자 없음", { from: { user: null, application: null } }),
					message(1, "2026-11-12T01:00:00Z", "본문 없음", { body: null }),
					null,
				],
			}),
		);
		const result = await read({ chatId });
		expect(result).toContain("<<<quoted-aaaaaaaaaaaaaaaa>>>");
		expect(result).toContain("<<<end-quoted-aaaaaaaaaaaaaaaa>>>");
		expect(result).not.toContain(key);
		expect(result).toContain(`키는 ${REDACTED} 입니다 & 끝\n둘째 줄`);
		expect(result).not.toContain("<p>");
		expect(result).toContain("(알 수 없음): 보낸 사람 없음");
		expect(result).toContain("(알 수 없음): 사용자 없음");
		expect(result).not.toContain("본문 없음");
		expect(result).toContain("메시지 3개");
	});

	test("htmlToText는 숫자 엔터티와 줄바꿈 태그를 푼다", () => {
		expect(htmlToText("a<br>b<br/>c&#44;&#x41;&lt;x&gt;")).toBe("a\nb\nc,A<x>");
	});
});

describe("teams_list_chats (AC-5)", () => {
	test("$expand=members를 요청하고 topic null 1:1은 상대 이름이 제목이며 query가 이름에 부분 일치한다", async () => {
		tokenAnswers(accessAnswer(ACCESS_1));
		graph.routes.set("/v1.0/me/chats", () =>
			Response.json({
				value: [
					{
						id: "19:one@unq.gbl.spaces",
						chatType: "oneOnOne",
						topic: null,
						lastUpdatedDateTime: "2026-11-12T05:00:00Z",
						members: [
							{ displayName: "오너", userId: OWNER_AAD.toUpperCase() },
							{ displayName: "홍길동", userId: "dddddddd-0000-0000-0000-000000000000" },
						],
					},
					{
						id: "19:grp@thread.v2",
						chatType: "group",
						topic: "주간 회의",
						lastUpdatedDateTime: "2026-11-12T06:00:00Z",
						members: [{ displayName: "김철수", userId: "eeeeeeee-0000-0000-0000-000000000000" }, null],
					},
					{ id: "19:nomember@thread.v2", chatType: "group", topic: null, lastUpdatedDateTime: null, members: null },
				],
			}),
		);
		const list = buildTeamsGraphTools(client(), () => "b".repeat(16)).find((tool) => tool.name === "teams_list_chats");
		const signal = new AbortController().signal;
		const hit = String(await list?.execute({ query: "길동" }, { signal }));
		expect(graph.calls.find((call) => call.path === "/v1.0/me/chats")?.url).toContain("$expand=members");
		expect(hit).toContain("채팅 1개");
		expect(hit).toContain("id=19:one@unq.gbl.spaces type=oneOnOne");
		expect(hit).toContain("title=홍길동");
		expect(hit).not.toContain("오너");
		expect(hit).toContain("<<<quoted-bbbbbbbbbbbbbbbb>>>");

		const all = String(await list?.execute({}, { signal }));
		expect(all).toContain("채팅 3개");
		expect(all.indexOf("주간 회의")).toBeLessThan(all.indexOf("홍길동"));
		expect(all).toContain("members=김철수");
		expect(all).toContain("title=(제목 없음)");
	});
});

describe("토큰 값 노출 없음 (AC-6)", () => {
	test("로그·도구 결과·자식 env에 토큰이 없고, 로드된 토큰은 secret index로 가려진다", async () => {
		tokenAnswers(accessAnswer(ACCESS_1, { refresh_token: REFRESH_2 }));
		graph.routes.set("/v1.0/me/chats", () => Response.json({ value: [] }));
		const tools = buildTeamsGraphTools(client());
		const results = await Promise.all(
			tools.map((tool) => tool.execute({ chatId: "19:x@thread.v2" }, { signal: new AbortController().signal })),
		);
		const everything = [...logs, ...results].join("\n");
		for (const value of [REFRESH_1, REFRESH_2, ACCESS_1]) {
			expect(everything).not.toContain(value);
			// 파일에서 읽은 값·받은 값 모두 index에 들어가 조각만 새도 가려진다.
			expect(maskKnownFragments(`leak ${value.slice(2, 30)} end`)).toBe(`leak ${REDACTED} end`);
			expect(redact(`Authorization: Bearer ${value}`)).not.toContain(value.slice(0, 20));
			expect(Object.values(process.env).some((env) => env?.includes(value))).toBe(false);
			expect(JSON.stringify(botRpcEnv(undefined))).not.toContain(value);
			expect(JSON.stringify(botRpcEnv("work"))).not.toContain(value);
		}
		expect(logs.some((line) => line.includes("event=teams_graph_token_refreshed"))).toBe(true);
	});

	test("JWT 모양 Bearer 헤더와 token 필드 값은 패턴으로도 가려진다", () => {
		const jwt = `eyJ${"a".repeat(20)}.eyJ${"b".repeat(20)}.${"c".repeat(30)}`;
		expect(redact(`Authorization: Bearer ${jwt}`)).toBe(`Authorization: Bearer ${REDACTED}`);
		expect(redact(`{"refresh_token":"0.AXEA${"q".repeat(40)}","x":1}`)).toBe(`{"refresh_token":"${REDACTED}","x":1}`);
		expect(redact(`grant_type=refresh_token&refresh_token=0.AXEA${"q".repeat(40)}&scope=x`)).toBe(
			`grant_type=refresh_token&refresh_token=${REDACTED}&scope=x`,
		);
	});
});
