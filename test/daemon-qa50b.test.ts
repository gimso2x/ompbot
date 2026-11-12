// qa50b lane I (doc/plans/qa50b-low-fixes.md): daemon items driven through the real daemon with fake transports.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Daemon } from "../src/daemon/daemon";
import { RESTART_NOTICE_FILE, takeRestartMarker } from "../src/daemon/restart-notice";
import { fatalHandler } from "../src/daemon/run";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { createAggregatingLogger } from "../src/ops/log-hygiene";
import { redact } from "../src/redact";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import { makeHome, type TestHome, WaitingTransport } from "./helpers/bot-home";
import { makeRepo } from "./helpers/git-fixtures";
import { removeRepoAndWorktrees } from "./helpers/lane-harness";

let home: TestHome;
let repos: string[];
let daemon: Daemon | undefined;
let transport: WaitingTransport;
let logLines: string[];

beforeEach(() => {
	home = makeHome("ompbot-qa50b-i-");
	repos = [];
	transport = new WaitingTransport();
	logLines = [];
	daemon = undefined;
});

afterEach(async () => {
	await daemon?.stop();
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
});

async function startDaemon(): Promise<Daemon> {
	const sessions = new FakeSessionStore();
	const clock = { now: () => Date.now() };
	daemon = new Daemon({
		config: home.config,
		channels: [new SlackBinding(new SlackChannel(transport))],
		log: createLogger({ sink: (line) => logLines.push(line), clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot",
		driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
	});
	await daemon.start();
	return daemon;
}

describe("I-8: a lane trigger during a restart drain", () => {
	test("starts no lane (no worktree, no lane row) and says to ask again after the restart", async () => {
		const repo = makeRepo(repos);
		const d = await startDaemon();
		d.setDraining(true);
		await d.inject({ origin: "slack/dm/D1", asOwner: true, text: `작업: ask @${repo}` });
		await transport.waitForPosts((text) => text.includes("작업 레인을 시작하지 않았습니다"));
		expect(d.store.getLane("ask")).toBeUndefined();
		expect(transport.posts((text) => text.includes("시작했습니다"))).toHaveLength(0);
	});
});

describe("I-14/I-15: inject arguments", () => {
	test("a --thread that is not a Slack ts is refused before anything is posted", async () => {
		const d = await startDaemon();
		for (const thread of ["not-a-ts", "a:b", "1800000000"]) {
			await expect(d.inject({ origin: "slack/dm/D1", asOwner: true, text: "x", thread })).rejects.toThrow(
				"inject thread is not a message id",
			);
		}
		expect(transport.posts()).toHaveLength(0);
	});

	test("a Discord origin on a Slack-only install names Discord as not configured", async () => {
		const d = await startDaemon();
		await expect(
			d.inject({ origin: "discord/dm/123456789012345678", asOwner: true, text: "x" }), // gitleaks:allow (fake snowflake)
		).rejects.toThrow("discord is not configured");
	});
});

describe("I-19: a lane whose worktree was deleted by hand", () => {
	test("is refused as the child's cwd instead of falling back to the live checkout", async () => {
		const repo = makeRepo(repos);
		const d = await startDaemon();
		await d.inject({ origin: "slack/dm/D1", asOwner: true, text: `작업: ask @${repo}` });
		await transport.waitForPosts((text) => text.startsWith("ECHO ulw explore"));
		const lane = d.store.getLane("ask");
		expect(lane?.status).toBe("working");
		expect(d.cwdFor("ompbot/work/ask")).toBe(lane?.cwd ?? "");
		rmSync(lane?.cwd ?? "", { recursive: true, force: true });
		expect(() => d.cwdFor("ompbot/work/ask")).toThrow("lane_worktree_missing");
	});
});

describe("I-22: an unreadable restart marker", () => {
	test("is removed and the drop has a reason", () => {
		const path = join(home.dir, RESTART_NOTICE_FILE);
		writeFileSync(path, '{"at":1,"threads":[]}\n', { mode: 0o600 });
		chmodSync(path, 0o000);
		const reasons: string[] = [];
		expect(takeRestartMarker(home.dir, (reason) => reasons.push(reason))).toBeUndefined();
		expect(existsSync(path)).toBe(false);
		expect(reasons).toEqual(["EACCES"]);
	});

	test("the daemon logs restart_notice_dropped with the reason at start", async () => {
		const path = join(home.dir, RESTART_NOTICE_FILE);
		writeFileSync(path, "{torn", { mode: 0o600 });
		await startDaemon();
		expect(logLines.some((line) => line.includes("event=restart_notice_dropped") && line.includes("unparsable"))).toBe(
			true,
		);
		expect(existsSync(path)).toBe(false);
	});
});

describe("I-12: the crash exit path", () => {
	test("writes the folded counts (log_summary) before it exits", () => {
		const clock = { now: () => 0 };
		const lines: string[] = [];
		const sink = (line: string) => lines.push(line);
		const log = createAggregatingLogger(createLogger({ sink, clock, redact }), { clock, schedule: () => () => {} });
		log.info("inbound_dropped", { reason: "bot_message" });
		const exits: number[] = [];
		const fatal = fatalHandler(createLogger({ sink, clock, redact }), log, (code) => {
			exits.push(code);
		});
		fatal("uncaughtException", new Error("boom"));
		expect(exits).toEqual([1]);
		expect(
			lines.some((line) => line.includes("event=log_summary") && line.includes("inbound_dropped_bot_message=1")),
		).toBe(true);
		expect(lines.findIndex((line) => line.includes("daemon_fatal"))).toBeGreaterThanOrEqual(0);
	});
});
