import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Daemon } from "../src/daemon/daemon";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import { makeHome, OWNER, type TestHome, WaitingTransport } from "./helpers/bot-home";
import { git, makeRepo } from "./helpers/git-fixtures";
import { removeRepoAndWorktrees } from "./helpers/lane-harness";

// Owner messages in a closed lane's thread, driven through the real daemon -> adapter -> mailbox path. Only APIs
// that already existed before the closed-lane change are used, so this file also runs against the old code.

let home: TestHome;
let repos: string[];
let daemons: Daemon[];
let drivers: Map<string, FakeOmpDriver>;
let transport: WaitingTransport;

beforeEach(() => {
	home = makeHome("ompbot-lane-followup-");
	repos = [];
	daemons = [];
	drivers = new Map();
	transport = new WaitingTransport();
});

afterEach(async () => {
	for (const daemon of daemons) await daemon.stop();
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
});

function commitMore(repo: string): void {
	writeFileSync(join(repo, `work-${Math.random().toString(36).slice(2)}.txt`), "work\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "work");
}

/** A daemon with one lane `ask` that did real work and was closed through `ompbot_claim_done`; returns its root ts. */
async function closedLane(): Promise<{ daemon: Daemon; rootTs: string }> {
	const repo = makeRepo(repos);
	const sessions = new FakeSessionStore();
	const clock = { now: () => Date.now() };
	const daemon = new Daemon({
		config: home.config,
		channels: [new SlackBinding(new SlackChannel(transport))],
		log: createLogger({ sink: () => undefined, clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot",
		driverFactory: (origin, sessionDir) => {
			const driver = new FakeOmpDriver({ sessionDir, store: sessions });
			drivers.set(origin, driver);
			return driver;
		},
	});
	daemons.push(daemon);
	await daemon.start();
	await daemon.inject({ origin: "slack/dm/D1", asOwner: true, text: `작업: ask @${repo}` });
	await transport.waitForPosts((text) => text.startsWith("ECHO ulw explore"));
	const rootTs = transport.posts((text) => text === "🔄 ask")[0]?.ts ?? "";
	const claim = daemon.hostToolsFor("ompbot/work/ask").find((tool) => tool.name === "ompbot_claim_done");
	// The lane works in its own worktree beside `repo`; that is where its commit lands.
	const worktree = daemon.store.getLane("ask")?.cwd ?? "";
	commitMore(worktree);
	const signal = new AbortController().signal;
	expect(await claim?.execute({ repo: worktree, commit: "HEAD", summary: "done" }, { signal })).toContain("검증 통과");
	expect(daemon.store.getLane("ask")?.status).toBe("closed");
	return { daemon, rootTs };
}

const send = (text: string, ts: string, rootTs: string, user = OWNER) =>
	transport.emitMessage({ type: "message", channel: "D1", channel_type: "im", user, text, ts, thread_ts: rootTs });

const laneEvents = (daemon: Daemon) => daemon.store.getLane("ask")?.history.map((entry) => entry.event) ?? [];
const lanePrompts = () => drivers.get("ompbot/work/ask")?.calls.filter((call) => call.startsWith("prompt:")) ?? [];

describe("owner messages in a closed lane's thread", () => {
	test("a plain question is answered by the lane session and does not reopen the lane", async () => {
		const { daemon, rootTs } = await closedLane();
		await send("이거 왜 이렇게 했어?", "1900000000.000100", rootTs);
		await transport.waitForPosts((text) => text.startsWith("ECHO") && text.includes("이거 왜 이렇게 했어?"));
		// Before the change this message reopened the lane (status working, `reopened` in history).
		expect(daemon.store.getLane("ask")?.status).toBe("closed");
		expect(laneEvents(daemon)).not.toContain("reopened");
		expect(laneEvents(daemon).at(-1)).toBe("owner_question");
		expect(daemon.store.getInbound("D1:1900000000.000100")).toMatchObject({
			originKey: "ompbot/work/ask",
			state: "answered",
		});
		expect(lanePrompts().at(-1)).toContain("!reopen");
		expect(lanePrompts().at(-1)).toContain("이거 왜 이렇게 했어?");
	});

	test("control commands keep their meaning and are not recorded as questions", async () => {
		const { daemon, rootTs } = await closedLane();
		const before = laneEvents(daemon);
		await send("!queue", "1900000000.000200", rootTs);
		await transport.waitForPosts((text) => text.includes("대기열 비어 있음"));
		await send("!new", "1900000000.000300", rootTs);
		await transport.waitForPosts((text) => text.includes("새 대화를 시작했습니다"));
		expect(daemon.store.getLane("ask")?.status).toBe("closed");
		expect(laneEvents(daemon)).toEqual(before);
		expect(daemon.store.getInbound("D1:1900000000.000200")?.textRef).toBe("!queue");
		expect(daemon.store.getInbound("D1:1900000000.000300")?.textRef).toBe("!new");
		expect(lanePrompts().some((call) => call.includes("!queue") || call.includes("!new"))).toBe(false);
	});

	test("a `!followup <work>` payload runs only as an answer-only question with the closed notice", async () => {
		const { daemon, rootTs } = await closedLane();
		await send("!followup README에 한 줄 더 추가해", "1900000000.000400", rootTs);
		await transport.waitForPosts((text) => text.startsWith("ECHO") && text.includes("README에 한 줄 더 추가해"));
		expect(daemon.store.getLane("ask")?.status).toBe("closed");
		expect(laneEvents(daemon)).not.toContain("reopened");
		expect(laneEvents(daemon).at(-1)).toBe("owner_question");
		const prompt = lanePrompts().at(-1) ?? "";
		expect(prompt).toContain("README에 한 줄 더 추가해");
		expect(prompt).toContain("!reopen");
		expect(prompt).not.toContain("!followup");
	});

	test("`!reopen <지시>` reopens the lane and hands the message over as typed", async () => {
		const { daemon, rootTs } = await closedLane();
		await send("!reopen 테스트 하나 더", "1900000000.000500", rootTs);
		await transport.waitForPosts((text) => text === "ECHO !reopen 테스트 하나 더");
		expect(daemon.store.getLane("ask")?.status).toBe("working");
		// The reopened turn ends with no claim, so the core's automatic nudges may follow it in the history.
		expect(
			laneEvents(daemon)
				.filter((event) => !event.startsWith("nudge"))
				.at(-1),
		).toBe("reopened");
		expect(
			lanePrompts()
				.filter((call) => !call.includes("[자동 재촉"))
				.at(-1),
		).toBe("prompt:!reopen 테스트 하나 더");
	});

	test("a non-owner message in the thread is ignored: nothing recorded, the lane untouched", async () => {
		const { daemon, rootTs } = await closedLane();
		const before = daemon.store.getLane("ask");
		await send("이거 다시 열어줘", "1900000000.000600", rootTs, "USTRANGER");
		expect(daemon.store.getInbound("D1:1900000000.000600")).toBeUndefined();
		expect(daemon.store.getLane("ask")?.status).toBe("closed");
		expect(daemon.store.getLane("ask")?.history).toEqual(before?.history ?? []);
		expect(lanePrompts().some((call) => call.includes("이거 다시 열어줘"))).toBe(false);
	});
});
