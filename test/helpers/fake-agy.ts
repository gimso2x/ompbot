import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

/**
 * Fake `agy` CLI for wire tests: speaks the stream-json events of agy 1.5.4 headless mode. Driven by env plus
 * prompt markers:
 * - FAKE_AGY_LOG: every argv/in/out frame is appended there as JSON lines.
 * - FAKE_AGY_UNKNOWN_CONVERSATION=1: `--conversation <id>` warns "not found" and starts a new conversation.
 * - `agy models`: prints the model table and exits.
 * - "@error": result status ERROR with error "boom".
 * - "@tool": a run_command tool step (ACTIVE then DONE) before the answer.
 * - "@hold": the turn stays open until SIGUSR1 (answers HELD-DONE) or SIGINT (interrupted result, then exit 130).
 *   With "@fail" as well, SIGUSR1 answers status ERROR with error "boom" instead.
 * - "@linger": answered normally, then a SIGTERM no longer ends the process: it logs `{dir:"term"}`, writes
 *   OLD-CHILD-STDERR to stderr and a tool step frame to stdout, and exits (143) only on SIGUSR2.
 * - anything else: answers `REPLY<n>:<last line of the message>` (n = turns of this process).
 * Lines written while a turn runs are queued and answered after it, like agy.
 */

const LOG = process.env.FAKE_AGY_LOG;
const log = (entry: Record<string, unknown>): void => {
	if (LOG !== undefined) appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
};
const out = (frame: Record<string, unknown>): void => {
	log({ dir: "out", frame });
	process.stdout.write(`${JSON.stringify(frame)}\n`);
};

const argv = process.argv.slice(2);
log({ dir: "argv", argv });

if (argv[0] === "models") {
	process.stdout.write(
		"Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n",
	);
	process.exit(0);
}

const flag = (name: string): string | undefined => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const resume = flag("--conversation");
const model = flag("--model") ?? "gemini-default";
let conversationId = resume ?? randomUUID();
if (resume !== undefined && process.env.FAKE_AGY_UNKNOWN_CONVERSATION === "1") {
	process.stderr.write(`warning: conversation "${resume}" not found\n`);
	conversationId = randomUUID();
}
out({ event: "init", conversation_id: conversationId, init: { model, cwd: process.cwd(), permission_mode: "fake" } });

let turns = 0;
const usage = { input_tokens: 100, output_tokens: 7, thinking_tokens: 3, cache_read_tokens: 40, total_tokens: 107 };
let release: ((how: "done" | "interrupt") => void) | undefined;
process.on("SIGUSR1", () => release?.("done"));
process.on("SIGINT", () => {
	if (release === undefined) process.exit(130);
	release("interrupt");
});

function result(status: "SUCCESS" | "ERROR", response: string, error?: string): void {
	out({
		event: "result",
		result: {
			conversation_id: conversationId,
			status,
			response,
			num_turns: turns,
			usage,
			...(error === undefined ? {} : { error }),
		},
	});
}

async function runTurn(content: string): Promise<void> {
	turns += 1;
	out({ event: "step_update", step_update: { step_index: 0, state: "DONE", step_type: "user_input" } });
	if (content.includes("@error")) {
		result("ERROR", "", "boom");
		return;
	}
	if (content.includes("@tool")) {
		const tool_info = { name: "run_command", parameters: { CommandLine: "echo hi" } };
		out({
			event: "step_update",
			step_update: { step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info },
		});
		out({
			event: "step_update",
			step_update: {
				step_index: 1,
				state: "DONE",
				step_type: "tool",
				tool_name: "run_command",
				tool_info: { ...tool_info, output: "hi" },
			},
		});
	}
	if (content.includes("@hold")) {
		const held = Promise.withResolvers<"done" | "interrupt">();
		release = held.resolve;
		const how = await held.promise;
		release = undefined;
		if (how === "interrupt") {
			result("ERROR", "", "interrupted");
			process.exit(130);
		}
		if (content.includes("@fail")) result("ERROR", "", "boom");
		else result("SUCCESS", "HELD-DONE");
		return;
	}
	if (content.includes("@linger")) {
		process.on("SIGTERM", () => {
			log({ dir: "term" });
			process.stderr.write("OLD-CHILD-STDERR\n");
			out({
				event: "step_update",
				step_update: { step_index: 9, state: "ACTIVE", step_type: "tool", tool_name: "late_tool", tool_info: {} },
			});
		});
		process.on("SIGUSR2", () => process.exit(143));
	}
	result("SUCCESS", `REPLY${turns}:${content.split("\n").at(-1) ?? ""}`);
}

const inbox: string[] = [];
let busy = false;
async function drain(): Promise<void> {
	if (busy) return;
	busy = true;
	for (let next = inbox.shift(); next !== undefined; next = inbox.shift()) await runTurn(next);
	busy = false;
}

createInterface({ input: process.stdin }).on("line", (line) => {
	const frame = JSON.parse(line) as { event?: string; message?: { content?: string } };
	log({ dir: "in", frame });
	if (frame.event !== "user") return;
	inbox.push(String(frame.message?.content ?? ""));
	void drain();
});
