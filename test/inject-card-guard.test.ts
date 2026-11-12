// AC-1 of T-20261111-03: `ompbot inject` must not answer an approval or choice card (doc/plans/
// inject-card-guard-turn-undo-wiring.md §A). An inject into a pending approval card's thread is refused over IPC with
// the card still pending and the waiting request still waiting; the owner's own Slack reply then closes it. The same
// holds for an `ask` choice card, and a settled card is not routed to the asking conversation either.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Daemon } from "../src/daemon/daemon";
import { callDaemon } from "../src/daemon/ipc";
import { createLogger } from "../src/log";
import type { OmpDialogResponse } from "../src/omp/driver";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { approvalActionId } from "../src/safety/approval";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import { makeHome, OWNER, type TestHome, WaitingTransport } from "./helpers/bot-home";
import type { FakeCall } from "./helpers/slack-fake-transport";

const CHANNEL = "D1";
const ORIGIN = `slack/dm/${CHANNEL}`;
const REFUSAL = "approval/choice card";

let home: TestHome;
let transport: WaitingTransport;
let daemon: Daemon;
let lines: string[];
let replySeq: number;

beforeEach(async () => {
	home = makeHome("ompbot-inject-card-guard-");
	transport = new WaitingTransport();
	lines = [];
	replySeq = 0;
	const sessions = new FakeSessionStore();
	daemon = new Daemon({
		config: home.config,
		channels: [new SlackBinding(new SlackChannel(transport))],
		clock: { now: () => Date.now() },
		log: createLogger({ sink: (line) => lines.push(line), clock: { now: () => Date.now() }, redact: (text) => text }),
		ompVersion: "omp-test 0",
		bootId: "boot",
		sweepMs: 3_600_000,
		gateSweepMs: 0,
		taskSweepMs: 0,
		driverFactory: () => new FakeOmpDriver({ sessionDir: join(home.dir, "s"), store: sessions }),
	});
	await daemon.start();
});

afterEach(async () => {
	await daemon.stop();
	home.remove();
});

/** A bounded hop-by-hop wait (one macrotask per hop, no fixed delay) until `ready` holds. */
async function until(ready: () => boolean, what: string, hops = 2000): Promise<void> {
	for (let hop = 0; hop < hops; hop += 1) {
		if (ready()) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	}
	throw new Error(`never happened: ${what}`);
}

/** The ts of the first root post whose text starts with `head`. */
function postTs(head: string): string | undefined {
	return transport.posts((text) => text.startsWith(head))[0]?.ts;
}

/**
 * Waits until the card posted under `head` got its buttons: the edit that adds them comes after the ledger row and the
 * waiting request exist, so from then on a reply in its thread is a card reply.
 */
async function cardWithButtons(head: string): Promise<string> {
	await until(() => {
		const ts = postTs(head);
		return (
			ts !== undefined &&
			transport.calls.some(
				(call: FakeCall) =>
					call.method === "updateMessage" &&
					call.ts === ts &&
					(call.blocks ?? []).some((block) => typeof block === "object" && block !== null && "elements" in block),
			)
		);
	}, `buttons on the card "${head}"`);
	return postTs(head) ?? "";
}

/** An approval request of the conversation, as the model's `ompbot_request_approval` call makes it. */
function requestApproval(summary: string): { result: Promise<string>; done: () => boolean } {
	const tool = daemon.hostToolsFor(ORIGIN).find((candidate) => candidate.name === "ompbot_request_approval");
	if (tool === undefined) throw new Error("ompbot_request_approval missing");
	let finished = false;
	const result = tool.execute({ summary }, { signal: new AbortController().signal }).finally(() => {
		finished = true;
	});
	return { result, done: () => finished };
}

/** An IPC `inject` into the card's thread, exactly as `ompbot inject --as-owner --thread <ts>` sends it. */
function injectInto(threadTs: string, text: string): Promise<unknown> {
	return callDaemon(daemon.socketPath, { op: "inject", origin: ORIGIN, asOwner: true, thread: threadTs, text });
}

/** The owner's own Slack reply in a thread (a real `message` event, not an inject). */
async function ownerReply(threadTs: string, text: string): Promise<void> {
	replySeq += 1;
	await transport.emitMessage({
		type: "message",
		channel: CHANNEL,
		channel_type: "im",
		user: OWNER,
		text,
		ts: `1800000999.${String(replySeq).padStart(6, "0")}`,
		thread_ts: threadTs,
	});
}

const refusedLogs = () => lines.filter((line) => line.includes("event=inject_card_reply_refused"));

describe("AC-1: inject cannot answer a card", () => {
	test("a pending approval card: inject is refused, the card stays pending, the owner's reply closes it", async () => {
		const request = requestApproval("force push main");
		const card = await cardWithButtons("🔐 승인 요청");

		const response = await injectInto(card, "진행");
		expect(response).toMatchObject({ ok: false, error: expect.stringContaining(REFUSAL) });
		expect(daemon.store.getApproval(`${CHANNEL}:${card}`)?.status).toBe("pending");
		expect(request.done()).toBe(false);
		expect(refusedLogs()).toHaveLength(1);
		// The marker stays, so the owner sees what was tried.
		expect(transport.posts((text) => text.startsWith("🧪 inject"))).toHaveLength(1);

		await ownerReply(card, "진행");
		expect(await request.result).toBe("replied: 진행");
		expect(daemon.store.getApproval(`${CHANNEL}:${card}`)?.status).toBe("replied");
	});

	test("an ask choice card: inject is refused and the dialog keeps waiting; the owner's reply answers it", async () => {
		const answer = daemon.answerDialogsFor(ORIGIN);
		if (answer === undefined) throw new Error("no dialog answerer for the DM");
		let finished = false;
		const response: Promise<OmpDialogResponse | undefined> = answer(
			{
				method: "ask",
				id: "q1",
				questions: [{ id: "pick", question: "어느 쪽으로 갈까요?", options: [{ label: "왼쪽" }, { label: "오른쪽" }] }],
			},
			new AbortController().signal,
		).finally(() => {
			finished = true;
		});
		await until(() => transport.posts((text) => text.includes("어느 쪽으로 갈까요?")).length > 0, "the ask card");
		const card = transport.posts((text) => text.includes("어느 쪽으로 갈까요?"))[0]?.ts ?? "";
		await until(
			() => transport.calls.some((call) => call.method === "updateMessage" && call.ts === card),
			"the ask card's buttons",
		);

		expect(await injectInto(card, "왼쪽")).toMatchObject({ ok: false, error: expect.stringContaining(REFUSAL) });
		expect(finished).toBe(false);
		expect(refusedLogs()).toHaveLength(1);

		await ownerReply(card, "왼쪽");
		const answered = await response;
		expect(answered !== undefined && "answers" in answered ? answered.answers[0]?.id : undefined).toBe("pick");
	});

	test("a settled card: inject is refused and nothing is routed to the asking conversation", async () => {
		const request = requestApproval("drop the cache");
		const card = await cardWithButtons("🔐 승인 요청");
		await transport.emitBlockAction({
			user: { id: OWNER },
			channel: { id: CHANNEL },
			message: { ts: card },
			actions: [{ action_id: approvalActionId("deny", CHANNEL, card), value: "deny" }],
		});
		expect(await request.result).toBe("denied");
		expect(daemon.store.getApproval(`${CHANNEL}:${card}`)?.status).toBe("denied");

		expect(await injectInto(card, "그래도 해")).toMatchObject({ ok: false, error: expect.stringContaining(REFUSAL) });
		expect(daemon.store.listInbound({ originKey: ORIGIN })).toEqual([]);
		expect(daemon.store.getApproval(`${CHANNEL}:${card}`)?.status).toBe("denied");
		expect(refusedLogs()).toHaveLength(1);

		// The owner's own late reply still goes to the asking conversation, as before.
		await ownerReply(card, "그래도 해");
		await transport.waitForPosts((text) => text === "ECHO 그래도 해");
		expect(daemon.store.listInbound({ originKey: ORIGIN })).toHaveLength(1);
	});
});
