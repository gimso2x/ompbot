// AC-B1 / AC-B4: a Teams-only daemon takes a signed owner Activity on /api/messages, records it under its
// `teams/ch/t…` origin and answers through the (fake) Bot Connector as a reply to the original Activity; a stranger
// and an unmentioned group chat message are recorded nowhere.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Daemon } from "../../src/daemon/daemon";
import { teamsAlias } from "../../src/teams/types";
import { makeHome, type TestHome } from "../helpers/bot-home";
import {
	botFrameworkClaims,
	FakeMicrosoft,
	GROUP_CHAT,
	messageActivity,
	PERSONAL_CHAT,
	postActivity,
	STRANGER_AAD,
	signJwt,
	startTeamsDaemon,
} from "./harness";

let home: TestHome;
let ms: FakeMicrosoft;
let daemon: Daemon | undefined;
let logs: string[];

async function boot(): Promise<number> {
	const started = await startTeamsDaemon(home, ms, logs);
	daemon = started.daemon;
	return started.port;
}

/** A Bot Framework token naming the service URL without its trailing `/` (the Activity has one). */
async function token(): Promise<string> {
	return signJwt(ms.botFrameworkKey, botFrameworkClaims(ms.serviceUrl.replace(/\/$/, "")));
}

beforeEach(async () => {
	home = makeHome("ompbot-teams-daemon-");
	logs = [];
	ms = new FakeMicrosoft();
	await ms.start();
});

afterEach(async () => {
	await daemon?.stop();
	daemon = undefined;
	await ms.stop();
	home.remove();
});

describe("Teams owner path (AC-B1)", () => {
	test("an owner mention in a group chat is recorded under teams/ch/t… and answered as a reply to its Activity", async () => {
		const port = await boot();
		expect(logs.some((line) => line.includes("event=daemon_ready") && line.includes("teams=on"))).toBe(true);
		const alias = teamsAlias(GROUP_CHAT);
		expect(alias).toMatch(/^t[0-9a-f]{16}$/);

		const activityId = "1794445875395";
		const response = await postActivity(
			port,
			await token(),
			messageActivity({ id: activityId, text: "안녕 팀즈", serviceUrl: ms.serviceUrl }),
		);
		expect(response.status).toBe(200);

		// Recorded at once (before the 200), under the group chat's origin, mention tag gone.
		const rows = daemon?.store.listInbound() ?? [];
		expect(rows.map((row) => [row.originKey, row.threadRef, row.platformMessageId])).toEqual([
			[`teams/ch/${alias}`, `${alias}:${activityId}`, `${alias}:${activityId}`],
		]);

		// The typing indicator, then the answer replying to the original Activity id.
		const encoded = encodeURIComponent(GROUP_CHAT);
		await ms.waitFor((call) => call.body.type === "typing");
		const answer = await ms.waitFor(
			(call) => call.body.type === "message" && String(call.body.text).includes("ECHO 안녕 팀즈"),
		);
		expect(answer.method).toBe("POST");
		expect(answer.path).toBe(`/v3/conversations/${encoded}/activities/${activityId}`);
		expect(answer.body.replyToId).toBe(activityId);
		expect(answer.body.textFormat).toBe("markdown");
		expect(answer.authorization).toBe("Bearer fake-access-token");

		await daemon?.pump();
		const delivered = daemon?.store.listDeliveries().map((row) => [row.originKey, row.threadRef, row.state]);
		expect(delivered).toContainEqual([`teams/ch/${alias}`, `${alias}:${activityId}`, "confirmed"]);
	});

	test("a 1:1 chat takes the owner without a mention, under teams/dm/t…", async () => {
		const port = await boot();
		const alias = teamsAlias(PERSONAL_CHAT);
		const response = await postActivity(
			port,
			await token(),
			messageActivity({
				id: "dm-1",
				text: "개인 대화",
				serviceUrl: ms.serviceUrl,
				conversationId: PERSONAL_CHAT,
				conversationType: "personal",
				mention: false,
			}),
		);
		expect(response.status).toBe(200);
		await ms.waitFor((call) => String(call.body.text).includes("ECHO 개인 대화"));
		expect(daemon?.store.listInbound().map((row) => row.originKey)).toEqual([`teams/dm/${alias}`]);
	});
});

describe("Teams owner gate and addressing (AC-B4)", () => {
	test("a stranger's mention and the owner's unmentioned group message are accepted (200) but recorded nowhere", async () => {
		const port = await boot();
		const stranger = await postActivity(
			port,
			await token(),
			messageActivity({ id: "s-1", text: "나도 써볼래", serviceUrl: ms.serviceUrl, aadObjectId: STRANGER_AAD }),
		);
		const unmentioned = await postActivity(
			port,
			await token(),
			messageActivity({ id: "u-1", text: "그냥 잡담", serviceUrl: ms.serviceUrl, mention: false }),
		);
		expect([stranger.status, unmentioned.status]).toEqual([200, 200]);
		expect(daemon?.store.listInbound()).toEqual([]);
		expect(logs.some((line) => line.includes("event=inbound_dropped") && line.includes("reason=not_owner"))).toBe(true);
		expect(logs.some((line) => line.includes("event=inbound_dropped") && line.includes("reason=not_addressed"))).toBe(
			true,
		);
		// The stranger's conversation was not even remembered.
		expect(daemon?.store.teamsConversation(teamsAlias(GROUP_CHAT))).toBeUndefined();
		expect(ms.calls).toEqual([]);
	});
});
