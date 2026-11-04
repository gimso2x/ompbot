/*
 * Scripted OpenAI-compatible model for real-omp e2e tests: zero tokens, deterministic replies.
 * Ported from https://github.com/jryang1997/omp-bot commit 2173ea1, `test/real/mock-llm.mjs` (MIT),
 * rewritten for Bun.serve + TypeScript.
 *
 * Script syntax inside a user message:
 * - `[[tool:NAME {json}]]` — emitted as tool calls one per response, in order; once every call has a result the model
 *   answers with one text line. Arguments may nest another `[[tool:…]]` (brace-matched, strings respected).
 * - `[[sleep:MS]]` — delays the first response to that message (interrupt tests). Responses after the model already
 *   answered it (e.g. the one that follows a steer) are not delayed again.
 * The plan always counts from the LAST user message carrying a script, so steer/reminder messages that arrive in
 * between never break the tool sequence. A user message without a script gets `MOCK_PLAIN_REPLY`.
 */

import { isRecord } from "../../src/omp/type-guards";

export const MOCK_PLAIN_REPLY = "mock reply: received";
export const MOCK_DONE_PREFIX = "mock done. last result: ";

export interface MockToolStep {
	name: string;
	/** Raw JSON argument text, forwarded verbatim. */
	args: string;
}

export interface MockPlan {
	tool?: MockToolStep;
	/** Index of `tool` in the script. */
	index?: number;
	text?: string;
	sleepMs: number;
}

export interface MockChatMessage {
	role: string;
	content?: unknown;
	tool_calls?: unknown[];
}

export interface MockRequest {
	messages: MockChatMessage[];
	/** Function names of the tools omp offered in this request. */
	tools: string[];
	plan: MockPlan;
	/** True when omp cut the connection before the reply was written (abort during `[[sleep]]`). */
	aborted: boolean;
}

export interface MockLlm {
	/** OpenAI base URL including `/v1`. */
	baseUrl: string;
	/** Every `POST …/chat/completions` body, in arrival order. */
	requests: MockRequest[];
	/** Any other route omp hit (method + path), e.g. a model list probe. */
	otherRequests: string[];
	/** Resolves once `count` chat requests have been received; rejects after `timeoutMs`. */
	untilRequests(count: number, timeoutMs: number): Promise<void>;
	close(): Promise<void>;
}

const SCRIPT = /\[\[(tool|sleep):/;

/** Concatenated text of an OpenAI message `content` (string or content-part array). */
export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part: unknown) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("");
}

/** `[[tool:NAME {json}]]` steps in order; the JSON is cut by brace matching so it may contain `]]` or nested scripts. */
export function toolSteps(text: string): MockToolStep[] {
	const steps: MockToolStep[] = [];
	const head = /\[\[tool:([\w.-]+)\s+\{/g;
	for (let match = head.exec(text); match !== null; match = head.exec(text)) {
		const start = match.index + match[0].length - 1;
		let depth = 0;
		let inString = false;
		let end = -1;
		for (let i = start; i < text.length && end < 0; i++) {
			const c = text[i];
			if (inString) {
				if (c === "\\") i++;
				else if (c === '"') inString = false;
			} else if (c === '"') inString = true;
			else if (c === "{") depth++;
			else if (c === "}" && --depth === 0) end = i;
		}
		if (end < 0 || !text.startsWith("]]", end + 1)) continue;
		steps.push({ name: match[1] ?? "", args: text.slice(start, end + 1) });
		head.lastIndex = end + 3;
	}
	return steps;
}

/** Next reply for a chat history, following the script of the last scripted user message. */
export function planReply(messages: MockChatMessage[]): MockPlan {
	let at = messages.findLastIndex((m) => m.role === "user" && SCRIPT.test(textOf(m.content)));
	if (at < 0) at = messages.findLastIndex((m) => m.role === "user");
	const user = at >= 0 ? textOf(messages[at]?.content) : "";
	const steps = toolSteps(user);
	const after = messages.slice(at + 1);
	const answered = after.some((m) => m.role === "assistant");
	const sleepMs = answered ? 0 : Number(/\[\[sleep:(\d+)\]\]/.exec(user)?.[1] ?? 0);
	const done = after
		.filter((m) => m.role === "assistant" && Array.isArray(m.tool_calls))
		.reduce((n, m) => n + (m.tool_calls?.length ?? 0), 0);
	const next = steps[done];
	if (next !== undefined) return { tool: next, index: done, sleepMs };
	if (steps.length === 0) return { text: MOCK_PLAIN_REPLY, sleepMs };
	const lastTool = after.findLast((m) => m.role === "tool");
	return { text: `${MOCK_DONE_PREFIX}${textOf(lastTool?.content).trim().slice(0, 300)}`, sleepMs };
}

/** Starts the mock on an ephemeral 127.0.0.1 port. Model id is `scripted`. */
export function startMockLlm(): MockLlm {
	const requests: MockRequest[] = [];
	const otherRequests: string[] = [];
	const waiters = new Set<() => void>();
	let callId = 0;

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname;
			if (req.method !== "POST" || !path.endsWith("/chat/completions")) {
				otherRequests.push(`${req.method} ${path}`);
				if (req.method === "GET" && path.endsWith("/models"))
					return Response.json({ object: "list", data: [{ id: "scripted", object: "model" }] });
				return new Response("not found", { status: 404 });
			}
			const body: unknown = await req.json().catch(() => ({}));
			const messages = isRecord(body) && Array.isArray(body.messages) ? (body.messages as MockChatMessage[]) : [];
			const tools =
				isRecord(body) && Array.isArray(body.tools)
					? body.tools.map((t: unknown) => (isRecord(t) && isRecord(t.function) ? String(t.function.name) : String(t)))
					: [];
			const plan = planReply(messages);
			const record: MockRequest = { messages, tools, plan, aborted: false };
			requests.push(record);
			for (const check of waiters) check();

			if (plan.sleepMs > 0) {
				// Simulated model latency; ends early when omp drops the connection (abort).
				const { promise, resolve } = Promise.withResolvers<void>();
				const timer = setTimeout(resolve, plan.sleepMs);
				req.signal.addEventListener("abort", () => {
					clearTimeout(timer);
					resolve();
				});
				await promise;
			}
			if (req.signal.aborted) {
				record.aborted = true;
				return new Response(null, { status: 499 });
			}

			const base = { id: "mock-1", object: "chat.completion.chunk", created: 0, model: "scripted" };
			const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
				`data: ${JSON.stringify({ ...base, choices, ...extra })}\n\n`;
			const frames: string[] = [];
			if (plan.tool) {
				const call = {
					index: 0,
					id: `call_${++callId}`,
					type: "function",
					function: { name: plan.tool.name, arguments: plan.tool.args },
				};
				frames.push(chunk([{ index: 0, delta: { role: "assistant", tool_calls: [call] } }]));
				frames.push(chunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }]));
			} else {
				frames.push(chunk([{ index: 0, delta: { role: "assistant", content: plan.text } }]));
				frames.push(chunk([{ index: 0, delta: {}, finish_reason: "stop" }]));
			}
			frames.push(chunk([], { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
			frames.push("data: [DONE]\n\n");
			return new Response(frames.join(""), {
				headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
			});
		},
	});

	return {
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		requests,
		otherRequests,
		untilRequests(count, timeoutMs) {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			const timer = setTimeout(() => {
				waiters.delete(check);
				reject(new Error(`timeout waiting for mock request #${count} (got ${requests.length})`));
			}, timeoutMs);
			const check = () => {
				if (requests.length < count) return;
				clearTimeout(timer);
				waiters.delete(check);
				resolve();
			};
			waiters.add(check);
			check();
			return promise;
		},
		async close() {
			await server.stop(true);
		},
	};
}
