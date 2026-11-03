import { describe, expect, test } from "bun:test";
import type { ProviderLimitInfo, StallEscalation, TurnFailureEscalation } from "../src/core/mailbox";
import { COMMAND_TEXT } from "../src/core/types";
import {
	formatGateClosedNotice,
	formatGateOpenNotice,
	formatPendingDispatchNotice,
	formatProviderLimitNotice,
	formatStallNotice,
	formatTurnEscalationNotice,
} from "../src/daemon/notices";
import type { Gate } from "../src/ops/gates";

const HOUR = 3_600_000;

const escalation = (overrides: Partial<TurnFailureEscalation> = {}): TurnFailureEscalation => ({
	originKey: "slack/dm/D1",
	threadRef: "D1:1700.1",
	failures: 3,
	reason: "Could not restore model: fake/alpha",
	modelHealed: false,
	...overrides,
});

const gate = (name = "backup_age"): Gate => ({ name, state: "open", detail: "hours=40.0" });

describe("formatTurnEscalationNotice", () => {
	test("first occurrence: origin, failure count and a one-line sign; no repeat suffix, no heal note", () => {
		const text = formatTurnEscalationNotice(escalation(), 1);
		expect(text).toBe(
			[
				"🚨 [자가보고] slack/dm/D1 작업이 3번 연속 실패했습니다",
				"마지막 사인: Could not restore model: fake/alpha",
			].join("\n"),
		);
	});

	test("a repeat occurrence names its round; a healed model tells the owner to re-check", () => {
		const text = formatTurnEscalationNotice(escalation({ modelHealed: true }), 2);
		expect(text).toContain("같은 사안 반복 2회차");
		expect(text).toContain("자동 교체했습니다. 다음 메시지로 정상 동작을 확인해 주세요.");
	});

	test("a long multi-line sign collapses to one attacker-safe line", () => {
		const text = formatTurnEscalationNotice(escalation({ reason: "line1\nline2\n\nline3" }), 1);
		expect(text).toContain("마지막 사인: line1 line2 line3");
	});
});

describe("formatPendingDispatchNotice", () => {
	test("names the origin, the waiting minutes and a one-line sign; a repeat occurrence names its round", () => {
		const text = formatPendingDispatchNotice("slack/dm/D1", 90_500, "OmpDriverError: abort wedged\nline2", 1);
		expect(text).toBe(
			[
				"🚨 [자가보고] slack/dm/D1의 메시지를 2분째 보내지 못하고 있습니다",
				"마지막 사인: OmpDriverError: abort wedged line2",
				"스위프가 계속 재시도합니다 — 원인이 해소되면 자동으로 전송됩니다.",
				"대기 중인 일반 메시지는 `/queue-ompbot`에서 취소할 수 있습니다.",
			].join("\n"),
		);
		expect(formatPendingDispatchNotice("slack/dm/D1", 90_500, "boom", 2)).toContain("같은 사안 반복 2회차");
	});
});

describe("formatGateOpenNotice", () => {
	test("a fresh open names the gate and its detail, and promises the recovery report", () => {
		const now = 10 * HOUR;
		const text = formatGateOpenNotice(gate(), now - 2 * HOUR, now);
		expect(text).toBe(
			["🚨 [자가진단] 게이트 backup_age 열림", "상태: hours=40.0", "회복되면 다시 알립니다."].join("\n"),
		);
	});

	test("a gate still open past 24h says how many whole hours it has stood", () => {
		const now = 30 * HOUR;
		expect(formatGateOpenNotice(gate("turns_failing"), 0, now)).toContain("게이트 turns_failing 열림 · 30시간째 지속");
		expect(formatGateOpenNotice(gate("turns_failing"), now - 23 * HOUR, now)).not.toContain("시간째 지속");
	});
});

describe("formatGateClosedNotice", () => {
	test("the recovery line names the gate and says the problem is gone", () => {
		expect(formatGateClosedNotice(gate("lanes_stuck"))).toBe(
			"✅ [자가진단] 게이트 lanes_stuck 회복 — 이전 문제가 해결되었습니다.",
		);
	});
});

describe("formatStallNotice", () => {
	const stall = (overrides: Partial<StallEscalation> = {}): StallEscalation => ({
		originKey: "slack/dm/D1",
		threadRef: "D1:1700.1",
		opRef: "op:1",
		kind: "notify",
		count: 3,
		totalSilentMs: 33 * 60_000,
		...overrides,
	});

	test("conversation: names the origin and minutes, says the turn was not cut, points at the real new-session command", () => {
		const text = formatStallNotice(stall());
		expect(text).toContain("slack/dm/D1");
		expect(text).toContain("33분째");
		expect(text).toContain("자동으로 끊지 않았습니다");
		expect(text).toContain(COMMAND_TEXT.new);
	});

	test("monitor: says the run was aborted and recorded as a failure", () => {
		const text = formatStallNotice(stall({ originKey: "monitor/m1", kind: "abort", totalSilentMs: 20 * 60_000 }));
		expect(text).toContain("monitor/m1");
		expect(text).toContain("20분째");
		expect(text).toContain("중단");
		expect(text).not.toContain(COMMAND_TEXT.new);
	});
});

describe("formatProviderLimitNotice", () => {
	const info = (errorMessage: string): ProviderLimitInfo => ({
		originKey: "monitor/m1",
		threadRef: "m1:1",
		attempt: 1,
		maxAttempts: 10,
		errorMessage,
	});

	test("provider limit: first occurrence names the origin and the one-line error, no repeat suffix", () => {
		const text = formatProviderLimitNotice(info('429 rate_limit_error\n"[1310][Weekly/Monthly Limit Exhausted]"'), 1);
		expect(text).toBe(
			'⚠️ 모델 공급자 한도 소진(monitor/m1): 429 rate_limit_error "[1310][Weekly/Monthly Limit Exhausted]" — omp가 재시도·폴백 중이라 응답이 늦어질 수 있습니다.',
		);
	});

	test("provider limit: a repeat count is appended and the error head is capped and redacted", () => {
		const secret = `xoxb-${"1234567890-".repeat(3)}abcdefghijkl`;
		const text = formatProviderLimitNotice(info(`429 quota ${secret} ${"x".repeat(400)}`), 4);
		expect(text.startsWith("⚠️ 모델 공급자 한도 소진(")).toBe(true);
		expect(text).not.toContain(secret);
		expect(text).not.toContain("x".repeat(170));
		expect(text.endsWith(" (처음 감지 뒤 4회)")).toBe(true);
		expect(text).not.toContain("24시간 동안");
		expect(text).not.toContain("\n");
	});
});
