/*
 * Tool repeat-loop detection, ported to TypeScript from omp-bot:
 * https://github.com/jryang1997/omp-bot commit 2173ea1, `src/stuck.mjs` (MIT License,
 * Copyright (c) 2026 omp-bot contributors). Messages were rewritten in Korean; exempt tools were added for ompbot.
 *
 * Fingerprint = tool name + args + result (with isError). Same args with a changed result is progress (a poll that
 * reached a new state), not a repeat. Counts span the whole turn, not only consecutive calls, so an A,B,A,B loop is
 * caught too. Pure functions: no model, no process.
 */

import { createHash } from "node:crypto";
import type { OmpEvent } from "../omp/driver";

/** Machine prefix of a stuck-loop failure reason; a human sentence follows. */
export const STUCK_CODE = "stuck-loop";
/** Same fingerprint this many times in a turn: one steer asking for another approach. */
export const STUCK_STEER_AT = 3;
/** Same fingerprint this many times in a turn: the turn is aborted. */
export const STUCK_CANCEL_AT = 6;

// Timeouts, rate limits, 5xx, dropped connections: waiting may fix them, so the same error a few more times is not
// necessarily a loop — the thresholds double.
const TRANSIENT =
	/timed?\s*out|timeout|rate[\s_-]?limit|too many requests|\b429\b|\b50[234]\b|bad gateway|service unavailable|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|temporarily unavailable/i;

/**
 * omp 18.11+ appends a counter to the third identical read ("[You have received this identical output N times...]").
 * N changes every time, so it is stripped before hashing or a true repeat never matches.
 */
const OMP_REPEAT_NOTE = /\n*\[You have received this identical output \d+ times[^\]]*\]\s*$/;

function hasContent(result: unknown): result is { content: unknown } {
	return result !== null && typeof result === "object" && "content" in result;
}

function partText(part: unknown): string | undefined {
	return part !== null && typeof part === "object" && "text" in part && typeof part.text === "string"
		? part.text
		: undefined;
}

function resultText(result: unknown): string {
	if (!hasContent(result) || !Array.isArray(result.content)) return typeof result === "string" ? result : "";
	return result.content.map((part: unknown) => partText(part) ?? "").join("\n");
}

/** An error result whose text looks like a transient failure (timeout, rate limit, 5xx, connection reset). */
export function isTransientError(result: unknown, isError: boolean): boolean {
	return isError && TRANSIENT.test(resultText(result));
}

/** JSON with sorted keys: equal objects give equal strings. */
function stable(value: unknown): string {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
		.join(",")}}`;
}

function stripRepeatNote(content: unknown): unknown {
	if (!Array.isArray(content)) return content;
	return content.map((part: unknown) => {
		const text = partText(part);
		return text !== undefined && part !== null && typeof part === "object" && "type" in part && part.type === "text"
			? { ...part, text: text.replace(OMP_REPEAT_NOTE, "") }
			: part;
	});
}

/**
 * sha256(tool \0 sorted-JSON(args) \0 sorted-JSON(result.content) \0 isError), first 32 hex chars. Only the content
 * the model sees is hashed: `result.details` often carries durations and timestamps that hide a true repeat.
 */
export function toolFingerprint(toolName: string, args: unknown, result: unknown, isError: boolean): string {
	const hash = createHash("sha256");
	hash.update(toolName);
	hash.update("\0");
	hash.update(stable(args));
	hash.update("\0");
	hash.update(stable(hasContent(result) ? stripRepeatNote(result.content) : result));
	hash.update(isError ? "\0E" : "\0");
	return hash.digest("hex").slice(0, 32);
}

/** Paths of `read` calls that poll a background job or agent; the same answer there is normal waiting. */
const POLLING_READ = /^(proc|agent):\/\//;

/**
 * Tools whose identical result is normal (waiting, polling), checked against omp 18.16's built-in tool list
 * (`BUILTIN_TOOL_NAMES`; it has `wait`, no `await`) and ompbot's host tools: `wait`, `ompbot_request_approval`, and
 * `read` of a `proc://` / `agent://` path.
 */
export function isStuckExempt(toolName: string, args: unknown): boolean {
	if (toolName === "wait" || toolName === "ompbot_request_approval") return true;
	if (toolName !== "read" || args === null || typeof args !== "object") return false;
	return "path" in args && typeof args.path === "string" && POLLING_READ.test(args.path);
}

export interface StuckHit {
	action: "steer" | "cancel";
	toolName: string;
	count: number;
}

export interface StuckDetector {
	/**
	 * Feeds one omp event (`tool_execution_start` records the call's args, `tool_execution_end` counts it; other events
	 * are ignored). Returns a steer at most once per fingerprint and a cancel at most once per detector.
	 */
	observe(event: OmpEvent): StuckHit | null;
}

export interface StuckDetectorOptions {
	steerAt?: number;
	cancelAt?: number;
	exempt?: (toolName: string, args: unknown) => boolean;
}

/** One detector per turn. */
export function createStuckDetector({
	steerAt = STUCK_STEER_AT,
	cancelAt = STUCK_CANCEL_AT,
	exempt = isStuckExempt,
}: StuckDetectorOptions = {}): StuckDetector {
	const argsByCall = new Map<string, unknown>();
	const counts = new Map<string, number>();
	const steered = new Set<string>();
	let cancelled = false;
	return {
		observe(event) {
			if (cancelled) return null;
			const callId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
			if (event.type === "tool_execution_start") {
				if (callId !== undefined) argsByCall.set(callId, event.args);
				return null;
			}
			if (event.type !== "tool_execution_end") return null;
			const args = callId === undefined ? undefined : argsByCall.get(callId);
			if (callId !== undefined) argsByCall.delete(callId);
			const toolName = typeof event.toolName === "string" ? event.toolName : "";
			if (exempt(toolName, args)) return null;
			const isError = event.isError === true;
			const fingerprint = toolFingerprint(toolName, args, event.result, isError);
			const count = (counts.get(fingerprint) ?? 0) + 1;
			counts.set(fingerprint, count);
			const slack = isTransientError(event.result, isError) ? 2 : 1;
			if (count >= cancelAt * slack) {
				cancelled = true;
				return { action: "cancel", toolName, count };
			}
			if (count >= steerAt * slack && !steered.has(fingerprint)) {
				steered.add(fingerprint);
				return { action: "steer", toolName, count };
			}
			return null;
		},
	};
}

/** Steer sent to the child at the steer threshold. */
export function stuckSteerText(toolName: string, count: number): string {
	return `[ompbot 알림] 같은 인자로 ${toolName}을(를) ${count}번 불렀는데 결과가 그대로입니다. 이 단계를 되풀이하지 말고 방법을 바꾸세요. 정말 할 수 없으면 멈추고 어디서 막혔는지, 누가 무엇을 해야 하는지 말하세요.`;
}

/** Thread notice when a turn is stopped for a loop. */
export function stuckStopText(toolName: string, count: number): string {
	return `같은 \`${toolName}\` 호출을 ${count}번 했는데 결과가 그대로라 멈췄습니다. 방법을 바꿔 다시 시키거나 정보를 더 주세요.`;
}

/** Failure reason of a turn stopped for a loop: `stuck-loop: <sentence>`. */
export function stuckCancelReason(toolName: string, count: number): string {
	return `${STUCK_CODE}: 같은 ${toolName} 호출 ${count}번, 결과 그대로`;
}
