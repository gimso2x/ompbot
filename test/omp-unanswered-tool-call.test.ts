import { describe, expect, test } from "bun:test";
import { existsSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { ompRoot } from "../src/cli/omp";
import { defaultHomeDir } from "../src/config";
import { CONTINUE_PROMPT } from "../src/daemon/recovery";

/**
 * A turn the planned restart cut leaves its session with an assistant `toolCall` that has no `toolResult`. ompbot does
 * not repair the jsonl: the pinned omp's message transform (pi-ai `providers/transform-messages.ts`) answers such a
 * call with a synthetic result before anything reaches a provider. This pins that behaviour to the omp the bot runs
 * (`ompbot omp` current), so an omp upgrade that drops it fails here first.
 */

type Message = { role: string; toolCallId?: string; content?: Array<{ type: string; text?: string; id?: string }> };
type TransformMessages = (messages: Message[], model: Record<string, unknown>) => Message[];

const transformPath = join(
	ompRoot(defaultHomeDir()),
	"current",
	"node_modules",
	"@oh-my-pi",
	"pi-ai",
	"src",
	"providers",
	"transform-messages.ts",
);

async function pinnedTransform(): Promise<TransformMessages> {
	if (!existsSync(transformPath)) {
		throw new Error(
			`pinned omp missing: ${transformPath} not found — install one with \`ompbot omp install <version>\` and \`ompbot omp use <version>\``,
		);
	}
	// Dynamic on purpose: the module lives in the install the bot pins under its home, not in this checkout's deps.
	const mod: unknown = await import(transformPath);
	if (
		typeof mod !== "object" ||
		mod === null ||
		!("transformMessages" in mod) ||
		typeof mod.transformMessages !== "function"
	) {
		throw new Error(
			`pinned omp ${readlinkSync(join(ompRoot(defaultHomeDir()), "current"))} exports no transformMessages`,
		);
	}
	const transform: TransformMessages = mod.transformMessages as TransformMessages; // the pinned pi-ai signature
	return transform;
}

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Session jsonl of a cut turn, then the resume prompt the next process sends into the same session. */
const sessionJsonl = [
	{
		type: "message",
		id: "e1",
		message: { role: "user", content: [{ type: "text", text: "배포해 줘" }], timestamp: 1 },
	},
	{
		type: "message",
		id: "e2",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "확인할게요." },
				{ type: "toolCall", id: "toolu_01CUT", name: "bash", arguments: { command: "git push" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			stopReason: "toolUse",
			usage,
			timestamp: 2,
		},
	},
	{
		type: "message",
		id: "e3",
		message: { role: "user", content: [{ type: "text", text: CONTINUE_PROMPT }], timestamp: 3 },
	},
]
	.map((entry) => JSON.stringify(entry))
	.join("\n");

const model = {
	id: "claude-test",
	name: "claude-test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
	compat: {},
};

// Fresh installs (and the release export's install check) have no pinned omp yet; a pinned one missing the module still fails.
const pinned = existsSync(join(ompRoot(defaultHomeDir()), "current"));

describe.skipIf(!pinned)("pinned omp: an unanswered tool call of a cut turn", () => {
	test("gets a synthetic tool result right after its assistant message, so every call is paired (no provider call)", async () => {
		const transformMessages = await pinnedTransform();
		const messages = sessionJsonl.split("\n").map((line): Message => {
			const entry: unknown = JSON.parse(line);
			if (typeof entry !== "object" || entry === null || !("message" in entry))
				throw new Error(`not a message entry: ${line}`);
			const message = entry.message as Message; // written above in omp's session entry shape
			return message;
		});
		const out = transformMessages(messages, model);
		expect(out.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "user"]);
		const result = out[2];
		expect(result?.toolCallId).toBe("toolu_01CUT");
		expect(result?.content?.map((c) => c.text)).toEqual(["No result provided"]);
		const calls = out.flatMap((m) => m.content?.filter((c) => c.type === "toolCall").map((c) => c.id) ?? []);
		const results = out.filter((m) => m.role === "toolResult").map((m) => m.toolCallId);
		expect(results).toEqual(calls);
	});
});
