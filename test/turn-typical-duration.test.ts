import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runningStatusText, STALL_STATUS_TEXT } from "../src/channel/text";
import { OriginMailbox, type TurnProgress } from "../src/core/mailbox";
import { openBotStore, sessionDirFor } from "../src/core/origin";
import type { InboundRecord } from "../src/core/types";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import type { Store } from "../src/store/db";
import { typicalDuration, typicalTurnDuration } from "../src/store/turn-duration";

const DAY = 86_400_000;
const clock = {
	t: 100 * DAY,
	now(): number {
		return this.t;
	},
};

describe("typicalDuration", () => {
	const seconds = (values: number[]): number[] => values.map((s) => s * 1000);

	test("AC-1: 9 samples are too few", () => {
		expect(typicalDuration(seconds([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBeUndefined();
	});

	test("AC-1: 1..10 seconds give the nearest-rank median 5s and p90 9s, sorted or not", () => {
		expect(typicalDuration(seconds([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toEqual({ medianMs: 5000, p90Ms: 9000 });
		expect(typicalDuration(seconds([7, 10, 1, 4, 9, 2, 8, 3, 6, 5]))).toEqual({ medianMs: 5000, p90Ms: 9000 });
	});

	test("AC-1: the caller's array is left as it was", () => {
		const input = seconds([3, 1, 2, 10, 9, 8, 7, 6, 5, 4]);
		const copy = [...input];
		typicalDuration(input);
		expect(input).toEqual(copy);
	});
});

describe("runningStatusText typical", () => {
	const base: TurnProgress = { tools: 2, recentTools: [], steers: 0, retries: 0 };
	const typical = { medianMs: 81_000, p90Ms: 474_000 };

	test("AC-2: within p90 the first line ends with the rounded-up median-to-p90 range", () => {
		expect(runningStatusText(false, 30_000, { ...base, typical })).toBe("⏳ 작업 중 · 00:30 · 도구 2회 · 보통 2~8분");
		expect(runningStatusText(false, 474_000, { ...base, typical })).toBe("⏳ 작업 중 · 07:54 · 도구 2회 · 보통 2~8분");
	});

	test("AC-2: a median under a minute reads ~1분, and no tools leaves the tool count out", () => {
		expect(runningStatusText(false, 5_000, { ...base, tools: 0, typical: { medianMs: 20_000, p90Ms: 60_000 } })).toBe(
			"⏳ 작업 중 · 00:05 · 보통 ~1분",
		);
	});

	test("AC-2: past p90 it says the turn runs longer than usual", () => {
		expect(runningStatusText(false, 474_001, { ...base, typical })).toBe(
			"⏳ 작업 중 · 07:54 · 도구 2회 · 평소보다 길어짐(보통 2~8분)",
		);
	});

	test("AC-2: the other lines stay below the first line", () => {
		expect(runningStatusText(false, 30_000, { ...base, steers: 1, typical })).toBe(
			"⏳ 작업 중 · 00:30 · 도구 2회 · 보통 2~8분\n📨 추가 메시지 1건 반영",
		);
	});

	test("AC-2: without typical, and while stalled, the text is byte-for-byte the old one", () => {
		expect(runningStatusText(false, 30_000, base)).toBe("⏳ 작업 중 · 00:30 · 도구 2회");
		expect(runningStatusText(false, 30_000, undefined)).toBe("⏳ 작업 중 · 00:30");
		expect(runningStatusText(true, 600_000, { ...base, typical })).toBe(`${STALL_STATUS_TEXT} · 10:00`);
		expect(runningStatusText(true, 600_000, { ...base, typical })).toBe(runningStatusText(true, 600_000, base));
	});
});

describe("turn duration samples", () => {
	const CHAT = "slack/dm/DTYP";
	let dir: string;
	let store: Store;
	let raw: Database;
	let logLines: string[];
	let seq = 0;

	const log = () => createLogger({ sink: (line) => logLines.push(line), clock, redact });

	/** One answered turn: inbound rows dispatched at `dispatched` (steers when more than one) and its answer parts. */
	function seedTurn(originKey: string, dispatched: number[], answeredAt: number, parts = 1): void {
		const opRef = `op${++seq}`;
		raw
			.query("INSERT OR IGNORE INTO origins (origin_key, epoch, session_dir, updated_at) VALUES (?, 1, '/s', 0)")
			.run(originKey);
		for (const at of dispatched) {
			raw
				.query(
					"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at, op_ref) VALUES (?, ?, 1, 't', 'answered', ?, ?, ?)",
				)
				.run(`m${++seq}`, originKey, at - 10, at, opRef);
		}
		for (let part = 0; part < parts; part += 1) {
			raw
				.query(
					"INSERT INTO deliveries (origin_key, op_ref, part, thread_ref, body, state, next_at, created_at) VALUES (?, ?, ?, 'T', 'b', 'confirmed', 0, ?)",
				)
				.run(originKey, opRef, part, answeredAt + part * 50_000);
		}
	}

	/** `count` one-message turns of `originKey` lasting `ms(i)`, dispatched within the last day. */
	function seedTurns(originKey: string, count: number, ms: (i: number) => number): void {
		for (let i = 0; i < count; i += 1) {
			const start = clock.t - DAY + i * 1000;
			seedTurn(originKey, [start], start + ms(i));
		}
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ompbot-typical-"));
		store = openBotStore(join(dir, "ompbot.db"), clock, "Asia/Seoul");
		raw = new Database(join(dir, "ompbot.db"));
		logLines = [];
	});

	afterEach(() => {
		raw.close();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("AC-3: a steered turn (3 inbound rows, parts 0 and 1) is one sample: part 0 minus the earliest dispatch", () => {
		const start = clock.t - DAY;
		seedTurn(CHAT, [start + 20_000, start, start + 5_000], start + 90_000, 2);
		expect(store.turnDurationSamples(CHAT)).toEqual([90_000]);
	});

	test("AC-3: rows not answered, without a dispatch time, or older than 30 days are not samples", () => {
		seedTurn(CHAT, [clock.t - 31 * DAY], clock.t - 31 * DAY + 1000);
		seedTurn(CHAT, [clock.t - DAY], clock.t - DAY + 7000);
		raw.query("UPDATE inbound SET state = 'dispatched' WHERE platform_message_id = ?").run(`m${seq}`);
		seedTurn(CHAT, [clock.t - DAY], clock.t - DAY + 5000);
		raw.query("UPDATE inbound SET dispatched_at = NULL WHERE platform_message_id = ?").run(`m${seq}`);
		seedTurn(CHAT, [clock.t - DAY], clock.t - DAY + 3000);
		expect(store.turnDurationSamples(CHAT)).toEqual([3000]);
	});

	test("AC-3: with 10+ samples of the origin only the origin counts", () => {
		seedTurns(CHAT, 10, (i) => (i + 1) * 1000);
		seedTurns("slack/dm/DOTHER", 10, () => 999_000);
		expect(typicalTurnDuration(store, CHAT, log())).toEqual({ medianMs: 5000, p90Ms: 9000 });
	});

	test("AC-3: under 10 samples of the origin, all chat origins stand in, without monitor/ and ompbot/ turns", () => {
		seedTurns(CHAT, 3, (i) => (i + 1) * 1000); // 1,2,3 s
		seedTurns("discord/ch/123", 8, (i) => (i + 4) * 1000); // 4..11 s
		seedTurns("monitor/backup", 5, () => 3_600_000);
		seedTurns("ompbot/lane/l1", 5, () => 7_200_000);
		expect(store.turnDurationSamples(CHAT)).toHaveLength(3);
		expect(store.turnDurationSamples()).toHaveLength(11);
		// 1..11 s: median s[5] = 6 s, p90 s[9] = 10 s
		expect(typicalTurnDuration(store, CHAT, log())).toEqual({ medianMs: 6000, p90Ms: 10_000 });
		expect(logLines).toEqual([]);
	});

	test("AC-3: a monitor or lane origin gets no typical even with plenty of samples", () => {
		seedTurns("monitor/backup", 12, () => 1000);
		seedTurns(CHAT, 12, () => 1000);
		expect(typicalTurnDuration(store, "monitor/backup", log())).toBeUndefined();
		expect(typicalTurnDuration(store, "ompbot/lane/l1", log())).toBeUndefined();
	});

	test("AC-3: a throwing query gives undefined and one typical_duration_query_failed line", () => {
		store.turnDurationSamples = () => {
			throw new Error("disk I/O error");
		};
		expect(typicalTurnDuration(store, CHAT, log())).toBeUndefined();
		expect(logLines.filter((line) => line.includes("event=typical_duration_query_failed"))).toHaveLength(1);
	});
});

describe("OriginMailbox first progress", () => {
	let dir: string;
	let store: Store;
	let raw: Database;
	let progress: TurnProgress[];
	let logLines: string[];
	let counter = 0;

	function mailboxOf(originKey: string): OriginMailbox {
		const sessions = new FakeSessionStore();
		return new OriginMailbox({
			timezone: "Asia/Seoul",
			originKey,
			store,
			clock,
			log: createLogger({ sink: (line) => logLines.push(line), clock, redact }),
			statusProvider: () => "status: ok",
			sessionDirFor: (key, epoch) => sessionDirFor(join(dir, "sessions"), key, epoch),
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ holdTurns: true, sessionDir, store: sessions }),
			onProgress: (info) => progress.push(info.progress),
		});
	}

	const msg = (originKey: string): InboundRecord => {
		const id = `first${++counter}`;
		return { platformMessageId: id, originKey, ownerVerified: true, text: "일해", threadRef: id };
	};

	/** Ten answered one-message turns of 1..10 s for `originKey`. */
	function seedTen(originKey: string): void {
		raw
			.query("INSERT OR IGNORE INTO origins (origin_key, epoch, session_dir, updated_at) VALUES (?, 1, '/s', 0)")
			.run(originKey);
		for (let i = 0; i < 10; i += 1) {
			const at = clock.t - DAY + i * 1000;
			const op = `seed-op${++counter}`;
			raw
				.query(
					"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at, op_ref) VALUES (?, ?, 1, 't', 'answered', ?, ?, ?)",
				)
				.run(`seed${counter}`, originKey, at, at, op);
			raw
				.query(
					"INSERT INTO deliveries (origin_key, op_ref, part, thread_ref, body, state, next_at, created_at) VALUES (?, ?, 0, 'T', 'b', 'confirmed', 0, ?)",
				)
				.run(originKey, op, at + (i + 1) * 1000);
		}
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ompbot-typical-mb-"));
		store = openBotStore(join(dir, "ompbot.db"), clock, "Asia/Seoul");
		raw = new Database(join(dir, "ompbot.db"));
		progress = [];
		logLines = [];
	});

	afterEach(() => {
		raw.close();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("AC-4: right after the turn starts, before any tool call, progress carries typical once", async () => {
		const origin = "slack/dm/DFIRST";
		seedTen(origin);
		const mailbox = mailboxOf(origin);
		try {
			await mailbox.enqueue(msg(origin));
			expect(logLines.some((line) => line.includes("event=turn_start"))).toBe(true);
			expect(progress).toEqual([
				{ tools: 0, recentTools: [], steers: 0, retries: 0, typical: { medianMs: 5000, p90Ms: 9000 } },
			]);
		} finally {
			await mailbox.close();
		}
	});

	test("AC-3: a monitor origin's turn starts without typical", async () => {
		const origin = "monitor/typ";
		seedTen(origin);
		seedTen("slack/dm/DOTHER");
		const mailbox = mailboxOf(origin);
		try {
			await mailbox.enqueue(msg(origin));
			expect(logLines.some((line) => line.includes("event=turn_start"))).toBe(true);
			expect(progress.every((p) => p.typical === undefined)).toBe(true);
		} finally {
			await mailbox.close();
		}
	});

	test("AC-3: a throwing query logs once and the turn still starts", async () => {
		const origin = "slack/dm/DFAIL";
		store.turnDurationSamples = () => {
			throw new Error("disk I/O error");
		};
		const mailbox = mailboxOf(origin);
		try {
			await mailbox.enqueue(msg(origin));
			expect(logLines.filter((line) => line.includes("event=typical_duration_query_failed"))).toHaveLength(1);
			expect(logLines.some((line) => line.includes("event=turn_start"))).toBe(true);
			expect(progress.every((p) => p.typical === undefined)).toBe(true);
		} finally {
			await mailbox.close();
		}
	});
});
