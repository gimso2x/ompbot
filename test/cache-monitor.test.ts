import { describe, expect, test } from "bun:test";
import {
	type CacheBaseline,
	type CacheCall,
	CacheMonitor,
	cacheCallOf,
	classifyCacheMiss,
	formatCacheMissNotice,
	formatColdCacheNotice,
	isColdCache,
} from "../src/ops/cache-monitor";

const MIN = 60_000;
const T0 = Date.parse("2026-11-10T03:00:00Z");
const MODEL = "claude-opus-5-5";

const baseline = (over: Partial<CacheBaseline> = {}): CacheBaseline => ({
	at: T0,
	provider: "anthropic",
	model: MODEL,
	prefix: 330_000,
	...over,
});

const call = (over: Partial<CacheCall> = {}): CacheCall => ({
	at: T0 + 10 * MIN,
	provider: "anthropic",
	model: MODEL,
	input: 12,
	cacheRead: 330_000,
	cacheWrite: 1_000,
	costCacheWrite: 0,
	...over,
});

const NO_FLAGS = { childRestarted: false, compacted: false };
const RESTARTED = { childRestarted: true, compacted: false };

describe("classifyCacheMiss", () => {
	test("same model, 10 minutes later, reading the whole previous prefix: no miss", () => {
		expect(classifyCacheMiss(baseline(), call(), NO_FLAGS)).toBeUndefined();
	});

	test("a restarted child that reads 28k of a 330k prefix: child_restart, 302k missed", () => {
		const miss = classifyCacheMiss(baseline(), call({ cacheRead: 28_000, cacheWrite: 302_000 }), RESTARTED);
		expect(miss).toMatchObject({
			reason: "child_restart",
			missedTokens: 302_000,
			cacheWrite: 302_000,
			prefixTokens: 330_000,
			gapMs: 10 * MIN,
		});
	});

	test("another model: model_switch, even after a restart", () => {
		const miss = classifyCacheMiss(baseline(), call({ model: "claude-haiku-5-5", cacheRead: 0 }), RESTARTED);
		expect(miss?.reason).toBe("model_switch");
		expect(classifyCacheMiss(baseline(), call({ provider: "openai", cacheRead: 0 }), NO_FLAGS)?.reason).toBe(
			"model_switch",
		);
	});

	test("anthropic 61 minutes later: expired, before child_restart", () => {
		const late = call({ at: T0 + 61 * MIN, cacheRead: 28_000 });
		expect(classifyCacheMiss(baseline(), late, RESTARTED)?.reason).toBe("expired");
		expect(classifyCacheMiss(baseline(), late, NO_FLAGS)?.reason).toBe("expired");
	});

	test("a provider with an unknown TTL is never expired", () => {
		const late = call({ at: T0 + 300 * MIN, provider: "zai", cacheRead: 28_000 });
		expect(classifyCacheMiss(baseline({ provider: "zai" }), late, NO_FLAGS)?.reason).toBe("unexplained");
	});

	test("the same restart conditions without the flag: unexplained", () => {
		const miss = classifyCacheMiss(baseline(), call({ cacheRead: 28_000, cacheWrite: 302_000 }), NO_FLAGS);
		expect(miss?.reason).toBe("unexplained");
		expect(miss?.missedTokens).toBe(302_000);
	});

	test("a compaction outranks expiry and restart", () => {
		const late = call({ at: T0 + 61 * MIN, cacheRead: 28_000 });
		expect(classifyCacheMiss(baseline(), late, { childRestarted: true, compacted: true })?.reason).toBe("compaction");
	});

	test("a 15k previous prefix is never a miss", () => {
		expect(classifyCacheMiss(baseline({ prefix: 15_000 }), call({ cacheRead: 0 }), RESTARTED)).toBeUndefined();
	});

	test("a small shortfall is no miss", () => {
		expect(classifyCacheMiss(baseline(), call({ cacheRead: 315_000 }), RESTARTED)).toBeUndefined();
	});

	test("no baseline: no miss", () => {
		expect(classifyCacheMiss(undefined, call({ cacheRead: 0 }), RESTARTED)).toBeUndefined();
	});
});

describe("CacheMonitor", () => {
	test("the restart flag covers the first call only; a zero-prefix call keeps the baseline", () => {
		const monitor = new CacheMonitor();
		expect(monitor.observe(call({ at: T0, cacheRead: 300_000, cacheWrite: 30_000 }))).toBeUndefined();
		expect(monitor.baseline).toMatchObject({ at: T0, prefix: 330_000 });
		monitor.markChildRestart();
		expect(monitor.observe(call({ cacheRead: 28_000, cacheWrite: 302_000 }))?.reason).toBe("child_restart");
		// The flag is down: the next miss of the same shape is unexplained.
		expect(monitor.observe(call({ at: T0 + 20 * MIN, cacheRead: 0, cacheWrite: 330_000 }))?.reason).toBe("unexplained");
		const kept = monitor.baseline;
		expect(monitor.observe(call({ at: T0 + 30 * MIN, cacheRead: 0, cacheWrite: 0 }))?.reason).toBe("unexplained");
		expect(monitor.baseline).toBe(kept);
	});

	test("seed fills an empty baseline only", () => {
		const monitor = new CacheMonitor();
		monitor.seed(call({ at: T0, cacheRead: 300_000, cacheWrite: 30_000 }));
		expect(monitor.baseline?.prefix).toBe(330_000);
		monitor.seed(call({ at: T0 + MIN, cacheRead: 1, cacheWrite: 1 }));
		expect(monitor.baseline?.prefix).toBe(330_000);
	});

	test("the write price per token comes from the calls seen", () => {
		const monitor = new CacheMonitor();
		expect(monitor.writeCostPerToken).toBeUndefined();
		monitor.observe(call({ cacheWrite: 100_000, costCacheWrite: 0.625 }));
		expect(monitor.writeCostPerToken).toBeCloseTo(0.000_006_25, 12);
	});
});

describe("cacheCallOf", () => {
	test("reads an omp assistant message", () => {
		const message = {
			role: "assistant",
			provider: "anthropic",
			model: MODEL,
			usage: { input: 3, output: 9, cacheRead: 28_312, cacheWrite: 302_000, cost: { cacheWrite: 1.8875 } },
		};
		expect(cacheCallOf(message, T0)).toEqual({
			at: T0,
			provider: "anthropic",
			model: MODEL,
			input: 3,
			cacheRead: 28_312,
			cacheWrite: 302_000,
			costCacheWrite: 1.8875,
		});
	});

	test("anything but an assistant message with usage is no call", () => {
		expect(cacheCallOf({ role: "user", usage: { cacheRead: 1 } }, T0)).toBeUndefined();
		expect(cacheCallOf({ role: "assistant" }, T0)).toBeUndefined();
		expect(cacheCallOf(undefined, T0)).toBeUndefined();
	});
});

describe("notices", () => {
	test("cache miss line names tokens, cost and reason", () => {
		expect(
			formatCacheMissNotice({
				reason: "child_restart",
				cacheWrite: 312_000,
				costCacheWrite: 2.51,
				missedTokens: 302_000,
			}),
		).toBe("⚠️ 프롬프트 캐시 재작성 312k 토큰(≈$2.51) — 원인 child_restart");
		expect(
			formatCacheMissNotice({ reason: "unexplained", cacheWrite: 312_000, costCacheWrite: 0, missedTokens: 302_000 }),
		).toBe("⚠️ 프롬프트 캐시 재작성 312k 토큰 — 원인 unexplained");
	});

	test("cold cache line: context size, idle hours, estimated cost when known", () => {
		expect(formatColdCacheNotice({ prefixTokens: 312_000, idleMs: 3 * 60 * MIN + 5 * MIN, estimatedCost: 2.5 })).toBe(
			"ℹ️ 캐시가 식은 대화입니다(컨텍스트 312k, 마지막 호출 3시간 전). 이번 턴에 약 $2.50 재작성 — 새로 시작하려면 /new-ompbot",
		);
		expect(formatColdCacheNotice({ prefixTokens: 312_000, idleMs: 2 * 60 * MIN })).toBe(
			"ℹ️ 캐시가 식은 대화입니다(컨텍스트 312k, 마지막 호출 2시간 전). 새로 시작하려면 /new-ompbot",
		);
	});

	test("isColdCache: 200k+ prefix past the provider TTL", () => {
		expect(isColdCache(baseline({ prefix: 250_000 }), T0 + 120 * MIN)).toBe(true);
		expect(isColdCache(baseline({ prefix: 150_000 }), T0 + 120 * MIN)).toBe(false);
		expect(isColdCache(baseline({ prefix: 250_000 }), T0 + 30 * MIN)).toBe(false);
		expect(isColdCache(baseline({ prefix: 250_000, provider: "zai" }), T0 + 600 * MIN)).toBe(false);
	});
});
