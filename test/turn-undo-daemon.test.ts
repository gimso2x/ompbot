// AC-4 of T-20261111-03: the daemon wires `turnUndo` into every mailbox — a chat turn that changes a configured
// repository leaves a snapshot row, `!undo` shows a real approval card whose approval puts the turn's files back, an
// empty configuration says so without a row, and a config reload takes effect on the next turn without a restart.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OmpbotConfig } from "../src/config";
import { Daemon } from "../src/daemon/daemon";
import { createLogger } from "../src/log";
import { FakeOmpDriver, type FakeOmpDriverOptions, FakeSessionStore } from "../src/omp/fake-driver";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import { makeHome, OWNER, type TestHome, WaitingTransport } from "./helpers/bot-home";
import { makeRepo } from "./helpers/git-fixtures";
import type { FakeCall } from "./helpers/slack-fake-transport";

const ORIGIN = "slack/dm/D1";

let home: TestHome;
let transport: WaitingTransport;
let daemon: Daemon | undefined;
let repos: string[];

beforeEach(() => {
	home = makeHome("ompbot-turn-undo-daemon-");
	transport = new WaitingTransport();
	daemon = undefined;
	repos = [];
});

afterEach(async () => {
	await daemon?.stop();
	for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
	home.remove();
});

/** The test home's config with `turnSnapshot.repos` set, the shape `loadConfig` returns. */
function withTurnSnapshot(config: OmpbotConfig, list: readonly string[]): OmpbotConfig {
	return { ...config, turnSnapshot: { repos: [...list] } };
}

async function boot(config: OmpbotConfig, driver: FakeOmpDriverOptions = {}): Promise<Daemon> {
	const instance = new FakeOmpDriver({ ...driver, sessionDir: join(home.dir, "s"), store: new FakeSessionStore() });
	const d = new Daemon({
		config,
		channels: [new SlackBinding(new SlackChannel(transport))],
		clock: { now: () => Date.now() },
		log: createLogger({ sink: () => undefined, clock: { now: () => Date.now() }, redact: (text) => text }),
		ompVersion: "omp-test 0",
		bootId: "boot",
		sweepMs: 3_600_000,
		gateSweepMs: 0,
		taskSweepMs: 0,
		driverFactory: () => instance,
	});
	daemon = d;
	await d.start();
	return d;
}

/** Approve buttons the transport received; the card's buttons go up with the edit that follows its post. */
function approveButtons(): string[] {
	return transport.calls.flatMap((call: FakeCall) => {
		if (call.method !== "postMessage" && call.method !== "updateMessage") return [];
		return (call.blocks ?? []).flatMap((block) => {
			if (typeof block !== "object" || block === null || !("elements" in block)) return [];
			const elements = block.elements;
			if (!Array.isArray(elements)) return [];
			return elements.flatMap((element: unknown) =>
				typeof element === "object" &&
				element !== null &&
				"action_id" in element &&
				typeof element.action_id === "string" &&
				element.action_id.includes(":approve:")
					? [element.action_id]
					: [],
			);
		});
	});
}

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

/** Clicks the undo card's approve button as the owner, once the buttons are on the card; returns the card's ledger key. */
async function approveUndoCard(): Promise<string> {
	await until(() => approveButtons().length > 0, "the undo card's approve button");
	const actionId = approveButtons()[0] ?? "";
	const [, , , channel, ts] = actionId.split(":");
	const key = `${channel}:${ts}`;
	await transport.emitBlockAction({
		user: { id: OWNER },
		...(channel === undefined ? {} : { channel: { id: channel } }),
		...(ts === undefined ? {} : { message: { ts } }),
		actions: [{ action_id: actionId, value: "approve" }],
	});
	return key;
}

const turnSnapshots = (d: Daemon) => d.store.listTurnSnapshots({ originKey: ORIGIN });

describe("AC-4: turnUndo is wired into the mailbox", () => {
	test("no configuration: a chat turn and !undo start no git, !undo says it is not configured, no row exists", async () => {
		const d = await boot(home.config);
		const spawn = spyOn(Bun, "spawn");
		try {
			await d.inject({ origin: ORIGIN, asOwner: true, text: "고쳐줘" });
			await transport.waitForPosts((text) => text === "ECHO 고쳐줘");
			await d.inject({ origin: ORIGIN, asOwner: true, text: "!undo" });
			await transport.waitForPosts((text) => text.includes("설정되지 않았습니다"));
			const gitRuns = spawn.mock.calls.filter(([cmd]) => Array.isArray(cmd) && cmd[0] === "git");
			expect(gitRuns).toEqual([]);
		} finally {
			spawn.mockRestore();
		}
		expect(turnSnapshots(d)).toEqual([]);
	});

	test("a configured repository: the turn leaves a row, the undo card is approved, and the file comes back", async () => {
		const repo = makeRepo(repos);
		// The turn's own work (the fake driver's reply step) creates the file, between the before and after captures.
		const d = await boot(withTurnSnapshot(home.config, [repo]), {
			respond: () => {
				writeFileSync(join(repo, "changed.txt"), "by the turn\n");
				return "고쳤습니다";
			},
		});
		await d.inject({ origin: ORIGIN, asOwner: true, text: "고쳐줘" });
		await transport.waitForPosts((text) => text === "고쳤습니다");
		await until(() => turnSnapshots(d).length > 0, "the turn's snapshot row");
		expect(turnSnapshots(d).map((row) => row.repo)).toEqual([repo]);
		expect(existsSync(join(repo, "changed.txt"))).toBe(true);

		await d.inject({ origin: ORIGIN, asOwner: true, text: "!undo" });
		const card = await approveUndoCard();
		await transport.waitForPosts((text) => text.includes("되돌림: "));
		expect(existsSync(join(repo, "changed.txt"))).toBe(false);
		// The card belongs to the asking DM conversation, not to a channel origin rebuilt from the thread ref.
		expect(d.store.getApproval(card)?.originKey).toBe(ORIGIN);
		expect(d.store.getApproval(card)?.status).toBe("approved");
	});

	test("a reload that adds a repository takes effect on the next turn, without a restart", async () => {
		const repo = makeRepo(repos);
		let turn = 0;
		// Every turn writes its own file; only the turn after the reload may leave a row.
		const d = await boot(home.config, {
			respond: () => {
				turn += 1;
				writeFileSync(join(repo, `turn-${turn}.txt`), "by the turn\n");
				return `답 ${turn}`;
			},
		});
		await d.inject({ origin: ORIGIN, asOwner: true, text: "고쳐줘" });
		await transport.waitForPosts((text) => text === "답 1");
		expect(turnSnapshots(d)).toEqual([]);

		// A reload re-reads config.json: write the repository list there, the way the owner would.
		const raw = JSON.parse(await Bun.file(join(home.dir, "config.json")).text()) as Record<string, unknown>;
		raw.turnSnapshot = { repos: [repo] };
		await Bun.write(join(home.dir, "config.json"), JSON.stringify(raw));
		d.reloadConfig("ipc");
		await d.inject({ origin: ORIGIN, asOwner: true, text: "또 고쳐줘" });
		await transport.waitForPosts((text) => text === "답 2");
		await until(() => turnSnapshots(d).length > 0, "the post-reload turn's snapshot row");
		expect(turnSnapshots(d).map((row) => row.repo)).toEqual([repo]);
	});
});
