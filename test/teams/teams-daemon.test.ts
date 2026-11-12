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
	test("an owner mention in a group chat takes the read-only run (no owner session) and replies to its Activity", async () => {
		const runs: string[][] = [];
		const started = await startTeamsDaemon(home, ms, logs, {
			guestRun: async (cmd) => {
				runs.push(cmd);
				return { code: 0, stdout: "그룹 답", timedOut: false };
			},
		});
		daemon = started.daemon;
		const port = started.port;
		expect(logs.some((line) => line.includes("event=daemon_ready") && line.includes("teams=on"))).toBe(true);

		const activityId = "1794445875395";
		const response = await postActivity(
			port,
			await token(),
			messageActivity({ id: activityId, text: "안녕 팀즈", serviceUrl: ms.serviceUrl }),
		);
		expect(response.status).toBe(200);

		const encoded = encodeURIComponent(GROUP_CHAT);
		const answer = await ms.waitFor(
			(call) => call.body.type === "message" && String(call.body.text).includes("그룹 답"),
		);
		expect(answer.path).toBe(`/v3/conversations/${encoded}/activities/${activityId}`);
		expect(answer.body.replyToId).toBe(activityId);
		expect(answer.authorization).toBe("Bearer fake-access-token");
		expect(runs).toHaveLength(1);
		// The owner session never sees a group chat: nothing in the owner ledger, no teams origin.
		expect(daemon.store.listInbound()).toEqual([]);
		expect(daemon.store.listOrigins("teams")).toEqual([]);
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
