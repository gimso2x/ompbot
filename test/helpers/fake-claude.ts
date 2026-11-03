import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

/**
 * Fake `claude` CLI for wire tests: speaks the same newline-delimited stream-json
 * as claude 2.1.311 in print mode. Driven by env plus prompt markers:
 * - FAKE_CLAUDE_LOG: every argv/in/out frame is appended there as JSON lines.
 * - FAKE_CLAUDE_AUTH_FAIL=1: zeroed startup-failure result (auth text), exit 1, no init.
 * - FAKE_CLAUDE_RESUME_MISSING=1: `--resume <id>` → startup failure "No conversation found…".
 * - "@tool <command>": Bash tool_use + can_use_tool round-trip (allow → TOOL-DONE, deny → TOOL-DENIED).
 * - "@edit <path>": Edit can_use_tool (allow → EDIT-DONE, deny → EDIT-DENIED).
 * - "@steer": assistant PART1, waits for a steered user frame, answers `PART2:<text>`.
 * - "@abort": waits for the driver's interrupt control request, ends error_during_execution.
 * - "/compact": success result carrying usage.input_tokens 4321.
 */

const LOG = process.env.FAKE_CLAUDE_LOG;
const log = (entry: Record<string, unknown>): void => {
	if (LOG === undefined) return;
	try {
		appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
	} catch {
		// logging is best-effort
	}
};
const out = (frame: Record<string, unknown>): void => {
	log({ dir: "out", frame });
	process.stdout.write(`${JSON.stringify(frame)}\n`);
};

const argv = process.argv.slice(2);
log({ dir: "argv", argv });
const resumeArg = argv.includes("--resume") ? argv[argv.indexOf("--resume") + 1] : undefined;
const modelArg = argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : undefined;

function startupFailure(errors: string[]): never {
	out({ type: "result", subtype: "error_during_execution", is_error: true, errors });
	process.exit(1);
}

if (process.env.FAKE_CLAUDE_AUTH_FAIL === "1") startupFailure(["Invalid API key · Please run /login"]);
if (process.env.FAKE_CLAUDE_RESUME_MISSING === "1" && typeof resumeArg === "string") {
	startupFailure([`No conversation found with session ID ${resumeArg}`]);
}

const sessionId = typeof resumeArg === "string" ? resumeArg : (process.env.FAKE_CLAUDE_SESSION_ID ?? randomUUID());
out({
	type: "system",
	subtype: "init",
	session_id: sessionId,
	model: modelArg === undefined ? "claude-fake-5" : `claude-${modelArg}-5`,
	cwd: process.cwd(),
	permissionMode: "default",
});

let seq = 0;
let pendingPermission: { resolve: (allow: boolean) => void } | undefined;
let pendingInterrupt: (() => void) | undefined;
let waitingSteer = false;
/** The driver's last control_request, so its control_response can be matched to a subtype. */
let lastDriverControl: { id: string; subtype: string } | undefined;

function finishTurn(text: string, subtype?: string, usage?: number): void {
	out({
		type: "assistant",
		uuid: `a-${++seq}`,
		message: { model: "claude-fake-5", role: "assistant", content: [{ type: "text", text }] },
	});
	const failed = subtype !== undefined;
	out({
		type: "result",
		subtype: failed ? subtype : "success",
		is_error: failed,
		result: failed ? "" : text,
		session_id: sessionId,
		...(usage === undefined ? {} : { usage: { input_tokens: usage } }),
	});
}

function askPermission(
	toolName: string,
	input: Record<string, unknown>,
	onAllow: () => void,
	onDeny: () => void,
): void {
	out({
		type: "assistant",
		uuid: `a-${++seq}`,
		message: {
			model: "claude-fake-5",
			role: "assistant",
			content: [{ type: "tool_use", id: `tu-${seq}`, name: toolName, input }],
		},
	});
	out({
		type: "control_request",
		request_id: `perm-${++seq}`,
		request: { subtype: "can_use_tool", tool_name: toolName, input, tool_use_id: `tu-${seq - 1}` },
	});
	pendingPermission = { resolve: (allow) => (allow ? onAllow() : onDeny()) };
}

function handleUserText(text: string): void {
	if (waitingSteer) {
		waitingSteer = false;
		finishTurn(`PART2:${text}`);
		return;
	}
	if (text.startsWith("@tool ")) {
		const command = text.slice("@tool ".length);
		askPermission(
			"Bash",
			{ command },
			() => finishTurn("TOOL-DONE"),
			() => finishTurn("TOOL-DENIED"),
		);
		return;
	}
	if (text.startsWith("@edit ")) {
		askPermission(
			"Edit",
			{ file_path: text.slice("@edit ".length), old_string: "a", new_string: "b" },
			() => finishTurn("EDIT-DONE"),
			() => finishTurn("EDIT-DENIED"),
		);
		return;
	}
	if (text === "@abort") {
		pendingInterrupt = () => finishTurn("", "error_during_execution");
		return;
	}
	if (text === "@steer") {
		waitingSteer = true;
		out({
			type: "assistant",
			uuid: `a-${++seq}`,
			message: { model: "claude-fake-5", role: "assistant", content: [{ type: "text", text: "PART1" }] },
		});
		return;
	}
	if (text === "/compact" || text.startsWith("/compact ")) {
		finishTurn("COMPACT-SUMMARY", undefined, 4321);
		return;
	}
	finishTurn("FAKE-REPLY");
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
	if (line.trim() === "") return;
	let frame: Record<string, unknown>;
	try {
		frame = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return;
	}
	log({ dir: "in", frame });
	if (frame.type === "user") {
		const message = frame.message as { content?: unknown } | undefined;
		const content = message?.content;
		if (typeof content !== "string") return;
		// `--replay-user-messages`: stdin messages are echoed back for acknowledgment before processing.
		out({ type: "user", uuid: `r-${++seq}`, message: { role: "user", content } });
		handleUserText(content);
		return;
	}
	if (frame.type === "control_response") {
		const response = frame.response as { request_id?: string; response?: { behavior?: string } } | undefined;
		const requestId = response?.request_id ?? "";
		if (requestId.startsWith("perm-")) {
			pendingPermission?.resolve(response?.response?.behavior === "allow");
			pendingPermission = undefined;
			return;
		}
		if (lastDriverControl?.id === requestId) {
			if (lastDriverControl.subtype === "interrupt") pendingInterrupt?.();
			lastDriverControl = undefined;
		}
		return;
	}
	if (frame.type === "control_request") {
		const request = frame.request as { subtype?: string } | undefined;
		const subtype = request?.subtype ?? "";
		lastDriverControl = { id: String(frame.request_id), subtype };
		out({ type: "control_response", response: { subtype: "success", request_id: frame.request_id } });
		if (subtype === "interrupt") pendingInterrupt?.();
	}
});
rl.on("close", () => process.exit(0));
