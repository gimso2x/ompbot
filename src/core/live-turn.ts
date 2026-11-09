/*
 * What a running turn is writing right now, for the dashboard's 대화 tab: the assistant message being generated and
 * the tools being run, from omp's agent events (`message_update`, `tool_execution_*`, `auto_retry_start`). Memory
 * only — nothing here reaches disk, the database or a log. Events are kept by reference; copying, trimming and
 * masking happen when the view is read.
 */

import type { OmpEvent } from "../omp/driver";
import { redact } from "../redact";
import type { MailboxClock } from "./types";

const TEXT_CHARS = 8000;
const THINKING_CHARS = 4000;
const OUTPUT_CHARS = 2000;
const SUMMARY_CHARS = 120;
const RETRY_ERROR_CHARS = 160;

/** `LiveTurn.view()`: every string is masked and trimmed to its tail. */
export interface LiveView {
	/** Bumped on every event that changed the state. */
	seq: number;
	updatedAt: number;
	/** Platform message id of the inbound row that started the turn. */
	inboundId: string;
	/** Text of the message being generated (last 8000 chars). */
	text: string;
	/** Its thinking (last 4000 chars). */
	thinking: string;
	/** Tool calls the message is writing (not running yet). */
	toolCalls: Array<{ name: string; summary: string }>;
	/** Tools running now, oldest first, with the tail of their partial output. */
	running: Array<{ name: string; summary: string; ageMs: number; outputTail: string }>;
	/** The provider call failed and omp is waiting to retry; the failed attempt's text is gone. */
	retry?: { attempt: number; error: string };
}

interface RunningTool {
	name: string;
	intent: string;
	startedAt: number;
	output: string;
}

const tail = (text: string, chars: number): string => redact(text).slice(-chars);

/**
 * A tool call's one-line summary: omp's `intent` (it strips `i` out of the args it executes and sends it beside them),
 * else an `i` still in the args, else the args as one JSON line.
 */
function summaryOf(args: unknown, intent?: unknown): string {
	if (typeof intent === "string" && intent.trim() !== "") return intent;
	if (typeof args === "object" && args !== null && "i" in args && typeof args.i === "string") return args.i;
	if (args === undefined) return "";
	return (JSON.stringify(args) ?? "").replace(/\s+/g, " ").slice(0, SUMMARY_CHARS);
}

/** `partialResult` as text: its `content[].text` parts joined, or the value itself when it is a string. */
function outputOf(partial: unknown): string {
	if (typeof partial === "string") return partial;
	if (typeof partial !== "object" || partial === null || !("content" in partial) || !Array.isArray(partial.content)) {
		return "";
	}
	return partial.content
		.map((part: unknown) =>
			typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "",
		)
		.join("");
}

export class LiveTurn {
	readonly #clock: MailboxClock;
	readonly #inboundId: string;
	#seq = 0;
	#updatedAt: number;
	#message: unknown;
	readonly #running = new Map<string, RunningTool>();
	#retry: { attempt: number; error: string } | undefined;

	constructor(clock: MailboxClock, inboundId: string) {
		this.#clock = clock;
		this.#inboundId = inboundId;
		this.#updatedAt = clock.now();
	}

	feed(event: OmpEvent): void {
		const callId = typeof event.toolCallId === "string" ? event.toolCallId : "";
		switch (event.type) {
			case "message_update":
				this.#message = event.message;
				this.#retry = undefined;
				break;
			case "message_end":
				this.#message = undefined;
				break;
			case "tool_execution_start": {
				this.#running.set(callId, {
					name: typeof event.toolName === "string" ? event.toolName : "",
					intent: summaryOf(event.args, event.intent),
					startedAt: this.#clock.now(),
					output: "",
				});
				break;
			}
			case "tool_execution_update": {
				const tool = this.#running.get(callId);
				if (tool === undefined) return;
				tool.output = outputOf(event.partialResult);
				break;
			}
			case "tool_execution_end":
				this.#running.delete(callId);
				break;
			case "auto_retry_start":
				this.#message = undefined;
				this.#retry = {
					attempt: typeof event.attempt === "number" ? event.attempt : 0,
					error: redact(typeof event.errorMessage === "string" ? event.errorMessage : "").slice(0, RETRY_ERROR_CHARS),
				};
				break;
			default:
				return;
		}
		this.#seq += 1;
		this.#updatedAt = this.#clock.now();
	}

	/** Null while there is nothing to show: no message being written, no tool running, no retry waiting. */
	view(): LiveView | null {
		if (this.#message === undefined && this.#running.size === 0 && this.#retry === undefined) return null;
		const content =
			typeof this.#message === "object" &&
			this.#message !== null &&
			"content" in this.#message &&
			Array.isArray(this.#message.content)
				? this.#message.content
				: [];
		let text = "";
		let thinking = "";
		const toolCalls: LiveView["toolCalls"] = [];
		for (const part of content) {
			if (typeof part !== "object" || part === null) continue;
			if (part.type === "text" && typeof part.text === "string") text += part.text;
			else if (part.type === "thinking" && typeof part.thinking === "string") thinking += part.thinking;
			else if (part.type === "toolCall") {
				toolCalls.push({
					name: redact(typeof part.name === "string" ? part.name : ""),
					summary: redact(summaryOf(part.arguments, "intent" in part ? part.intent : undefined)),
				});
			}
		}
		const now = this.#clock.now();
		return {
			seq: this.#seq,
			updatedAt: this.#updatedAt,
			inboundId: this.#inboundId,
			text: tail(text, TEXT_CHARS),
			thinking: tail(thinking, THINKING_CHARS),
			toolCalls,
			running: [...this.#running.values()].map((tool) => ({
				name: redact(tool.name),
				summary: redact(tool.intent),
				ageMs: Math.max(0, now - tool.startedAt),
				outputTail: tail(tool.output, OUTPUT_CHARS),
			})),
			...(this.#retry === undefined ? {} : { retry: { ...this.#retry } }),
		};
	}
}
