import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/log";
import { redact } from "../src/redact";
import {
	type BackfillDeps,
	BackfillRunner,
	BOOTSTRAP_LOOKBACK_MS,
	type CursorStore,
	channelCursorKey,
	compareSlackTs,
	continuationKey,
	runBackfillPass,
	type ScanPageArgs,
	type ThreadTarget,
} from "../src/slack/backfill";
import {
	type HistoryMessage,
	type HistoryPage,
	SlackCallError,
	type SlackMessageEvent,
	type SlackTransport,
} from "../src/slack/transport";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ompbot-backfill-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

function ts(seconds: number, frac = "000000"): string {
	return `${seconds}.${frac}`;
}

const NOW_MS = 1_792_800_000_000;

function memCursors(): CursorStore & { data: Map<string, string> } {
	const data = new Map<string, string>();
	return {
		data,
		getCursor: (key) => data.get(key),
		setCursor: (key, value) => void data.set(key, value),
		deleteCursor: (key) => void data.delete(key),
	};
}

/** Newest-first window like Slack history, with offset-based cursor pagination and a `latest` bound. */
function fakeHistoryFeed(history: HistoryMessage[]) {
	return async (
		args: { channel: string } & ScanPageArgs & { oldest?: string; limit?: number },
	): Promise<HistoryPage> => {
		void args.channel;
		const upper = args.latest === undefined ? Number.POSITIVE_INFINITY : Number(args.latest);
		const lower = args.oldest === undefined ? Number.NEGATIVE_INFINITY : Number(args.oldest);
		const window = history.filter((m) => {
			const n = Number(m.ts);
			return n > lower && n < upper;
		});
		const limit = args.limit ?? 200;
		const offset = args.cursor === undefined ? 0 : Number(args.cursor);
		return {
			messages: window.slice(offset, offset + limit).map((m) => ({ ...m })),
			nextCursor: offset + limit < window.length ? String(offset + limit) : undefined,
		};
	};
}

interface Harness extends BackfillDeps {
	ingested: SlackMessageEvent[];
	notices: Array<{ channel: string; text: string }>;
	cursors: CursorStore & { data: Map<string, string> };
}

function makeDeps(overrides: {
	history?: HistoryMessage[];
	threads?: ThreadTarget[];
	withChannels?: boolean;
	ingest?: (event: SlackMessageEvent) => Promise<"recorded" | "duplicate" | "dropped">;
	pageLimit?: number;
	maxPages?: number;
}): Harness {
	const ingested: SlackMessageEvent[] = [];
	const notices: Array<{ channel: string; text: string }> = [];
	const cursors = memCursors();
	const logger = createLogger({ sink: () => undefined, clock: { now: () => NOW_MS }, redact });
	const history = overrides.history ?? [];
	const transport = {
		conversationsHistory: fakeHistoryFeed(history),
		conversationsReplies: async (args: { ts: string } & ScanPageArgs & { oldest?: string }): Promise<HistoryPage> => {
			const lower = args.oldest === undefined ? Number.NEGATIVE_INFINITY : Number(args.oldest);
			const thread = history.filter((m) => Number(m.ts) > lower && m.thread_ts === args.ts);
			return { messages: thread.map((m) => ({ ...m })), nextCursor: undefined };
		},
	} as unknown as SlackTransport;
	return {
		ingested,
		notices,
		transport,
		ingest:
			overrides.ingest ??
			((event) => {
				ingested.push(event);
				return Promise.resolve("recorded" as const);
			}),
		notifier: (channel, text) => {
			notices.push({ channel, text });
			return Promise.resolve();
		},
		cursors,
		log: logger,
		now: NOW_MS,
		botUserId: "UBOT",
		channels: overrides.withChannels === false ? [] : [{ channel: "D1", kind: "im" }],
		threads: overrides.threads ?? [],
		pageLimit: overrides.pageLimit,
		maxPages: overrides.maxPages,
	};
}

function runPass(deps: BackfillDeps, state?: { attempts: Map<string, number>; quarantine: Map<string, number> }) {
	return runBackfillPass(deps, state);
}

describe("compareSlackTs", () => {
	test("orders by integer part then fraction without float loss", () => {
		expect(compareSlackTs("1792726578.059349", "1792726578.059349")).toBe(0);
		expect(compareSlackTs("1792726578.059349", "1792726578.05935")).toBe(-1);
		expect(compareSlackTs("1792726578.059351", "1792726578.05935")).toBe(1);
		expect(compareSlackTs("1792726577.9", "1792726578.059349")).toBe(-1);
		expect(compareSlackTs("999.5", "1000.1")).toBe(-1);
	});
});

describe("runBackfillPass", () => {
	test("recovers missed messages oldest-first, advances the watermark, and posts one notice", async () => {
		const deps = makeDeps({
			history: [
				{ ts: ts(1_792_800_100, "300000"), text: "셋째", user: "UOWNER" },
				{ ts: ts(1_792_800_100, "200000"), text: "둘째", user: "UOWNER" },
				{ ts: ts(1_792_800_100, "100000"), text: "첫째", user: "UOWNER", bot_id: "BBOT" },
			],
		});
		const summary = await runPass(deps);

		// The bot's own message is skipped, the owner's two are ingested oldest-first.
		expect(deps.ingested.map((event) => event.text)).toEqual(["둘째", "셋째"]);
		expect(deps.cursors.data.get(channelCursorKey("D1"))).toBe(ts(1_792_800_100, "300000"));
		expect(summary.recovered).toBe(2);
		expect(deps.notices).toEqual([
			{ channel: "D1", text: "⏬ 봇이 응답하지 못한 동안 도착한 메시지 2건을 처리합니다" },
		]);
	});

	test("a second pass does not re-ingest covered messages", async () => {
		const deps = makeDeps({
			history: [
				{ ts: ts(1_792_800_100), text: "a", user: "UOWNER" },
				{ ts: ts(1_792_800_090), text: "b", user: "UOWNER" },
			],
		});
		await runPass(deps);
		const afterFirst = deps.ingested.length;
		await runPass(deps);
		expect(deps.ingested.length).toBe(afterFirst);
	});

	test("a page-budgeted pass stores a continuation and the next pass resumes below it", async () => {
		const deps = makeDeps({
			history: [
				{ ts: ts(1_792_800_140), text: "m4", user: "UOWNER" },
				{ ts: ts(1_792_800_130), text: "m3", user: "UOWNER" },
				{ ts: ts(1_792_800_120), text: "m2", user: "UOWNER" },
				{ ts: ts(1_792_800_110), text: "m1", user: "UOWNER" },
			],
			pageLimit: 1,
			maxPages: 2,
		});
		const first = await runPass(deps);
		expect(first.targets[0]?.truncated).toBe(true);
		expect(deps.cursors.data.get(channelCursorKey("D1"))).toBeUndefined();
		expect(deps.cursors.data.get(continuationKey(channelCursorKey("D1")))).toBe(ts(1_792_800_130));

		const second = await runPass(deps);
		expect(second.targets[0]?.truncated).toBe(false);
		// First pass ingested its newest window ascending ([m3, m4]); the continuation pass closes with [m1, m2]
		// (each pass ingests ascending). Everything up to the newest processed ts is covered.
		expect(deps.ingested.map((event) => event.text)).toEqual(["m3", "m4", "m1", "m2"]);
		expect(deps.cursors.data.get(channelCursorKey("D1"))).toBe(ts(1_792_800_140));
		expect(deps.cursors.data.get(continuationKey(channelCursorKey("D1")))).toBeUndefined();
	});

	test("definitive ingest failures retry on later passes and dead-letter after the third strike", async () => {
		const POISON = ts(1_792_800_100, "100000");
		const poisonStrikes = new Map<string, number>();
		const deps = makeDeps({
			history: [
				{ ts: ts(1_792_800_100, "200000"), text: "good", user: "UOWNER" },
				{ ts: POISON, text: "poison", user: "UOWNER" },
			],
			ingest: (event) => {
				if (event.ts === POISON) {
					const strikes = (poisonStrikes.get(event.ts) ?? 0) + 1;
					poisonStrikes.set(event.ts, strikes);
					if (strikes <= 3) {
						return Promise.reject(new SlackCallError("definitive", "slack_platform_error:invalid_params"));
					}
				}
				return Promise.resolve("recorded" as const);
			},
		});
		const state = { attempts: new Map<string, number>(), quarantine: new Map<string, number>() };

		const first = await runPass(deps, state);
		expect(first.targets[0]?.truncated).toBe(true);
		expect(deps.cursors.data.get(channelCursorKey("D1"))).toBeUndefined();

		await runPass(deps, state);
		// Third strike dead-letters the poison message and the watermark moves past it to the good message.
		const third = await runPass(deps, state);
		expect(third.targets[0]?.truncated).toBe(false);
		expect(deps.cursors.data.get(channelCursorKey("D1"))).toBe(ts(1_792_800_100, "200000"));
	});

	test("an unreadable channel is quarantined after three strikes and then skipped", async () => {
		const deps = makeDeps({ history: [] });
		const state = { attempts: new Map<string, number>(), quarantine: new Map<string, number>() };
		deps.transport = {
			...deps.transport,
			conversationsHistory: async () => {
				throw new SlackCallError("definitive", "slack_platform_error:missing_scope");
			},
		} as SlackTransport;
		await runPass(deps, state);
		await runPass(deps, state);
		const third = await runPass(deps, state);
		expect(third.targets[0]?.skipped).toBe(true);
		const fourth = await runPass(deps, state);
		expect(fourth.targets[0]?.skipped).toBe(true);
	});

	test("an empty first pass stores the bootstrap floor so older history is never rescanned", async () => {
		const deps = makeDeps({ history: [] });
		await runPass(deps);
		expect(deps.cursors.data.get(channelCursorKey("D1"))).toBe(
			String(Math.floor((NOW_MS - BOOTSTRAP_LOOKBACK_MS) / 1000)),
		);
	});

	test("thread targets force thread_ts on ingested replies and skip the parent row", async () => {
		const deps = makeDeps({
			withChannels: false,
			history: [
				{ ts: ts(1_792_800_100, "900000"), text: "reply2", user: "UOWNER", thread_ts: ts(1_792_800_100) },
				{ ts: ts(1_792_800_100), text: "parent", user: "UOWNER" },
			],
			threads: [{ channel: "C1", rootTs: ts(1_792_800_100) }],
		});
		await runPass(deps);
		expect(deps.ingested.map((event) => [event.text, event.thread_ts])).toEqual([["reply2", ts(1_792_800_100)]]);
	});

	test("BackfillRunner coalesces triggers into a follow-up pass instead of stacking", async () => {
		const deps = makeDeps({ history: [{ ts: ts(1_792_800_100), text: "a", user: "UOWNER" }] });
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		let calls = 0;
		const runner = new BackfillRunner(() => {
			calls += 1;
			return deps;
		});
		const originalIngest = deps.ingest;
		deps.ingest = async (event) => {
			await gate;
			return originalIngest(event);
		};
		runner.trigger();
		runner.trigger();
		runner.trigger();
		release();
		await runner.waitForIdle();
		// Two passes total: the running one plus ONE follow-up, no matter how many triggers arrived.
		expect(calls).toBe(2);
		expect(deps.ingested.length).toBe(1);
	});
});
