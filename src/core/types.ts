/** Already-normalized inbound message handed to the core (Slack adapter and `ompbot inject` produce the same shape). */
export interface InboundRecord {
	platformMessageId: string;
	originKey: string;
	ownerVerified: true;
	text: string;
	/** Where replies go (Slack `thread_ts`). */
	threadRef: string;
}

export type CommandKind =
	| "new"
	| "status"
	| "model"
	| "thinking"
	| "compact"
	| "resume"
	| "queue"
	| "followup"
	| "usage";

/** Slash command name of each kind (`-ompbot` suffix: several bots share the workspace). */
export const COMMAND_TEXT: Record<CommandKind, string> = {
	new: "/new-ompbot",
	status: "/status-ompbot",
	model: "/model-ompbot",
	thinking: "/thinking-ompbot",
	compact: "/compact-ompbot",
	resume: "/resume-ompbot",
	queue: "/queue-ompbot",
	followup: "/followup-ompbot",
	usage: "/usage-ompbot",
};

/** Ledger op refs of chat commands and bookkeeping answers: not a prompt that reached omp. */
export const COMMAND_OP_REF = new RegExp(`^(failed|lane|${(Object.keys(COMMAND_TEXT) as CommandKind[]).join("|")}):`);

/** Kinds that take an argument after the command word; the others only count when they are the whole message. */
const TAKES_ARG: ReadonlySet<CommandKind> = new Set(["model", "thinking", "compact", "resume", "queue", "followup"]);

export interface ParsedCommand {
	kind: CommandKind;
	/** Trimmed text after the command word; `""` when none. */
	arg: string;
}

/**
 * A message is a command when it starts with `/<name>-ompbot` or `!<name>` (the Slack client refuses unregistered
 * `/` commands typed as text, so `!model` works in a DM or channel before the app manifest has the slash command).
 */
export function parseCommand(text: string): ParsedCommand | undefined {
	const trimmed = text.trim();
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match) return undefined;
	const word = match[1] ?? "";
	const arg = (match[2] ?? "").trim();
	for (const kind of Object.keys(COMMAND_TEXT) as CommandKind[]) {
		if (word !== COMMAND_TEXT[kind] && word !== `!${kind}`) continue;
		if (arg !== "" && !TAKES_ARG.has(kind)) return undefined;
		return { kind, arg };
	}
	return undefined;
}

/** Text omp receives for a ledger row: a `followup` command's argument, the message itself otherwise. */
export function promptTextOf(text: string): string {
	const command = parseCommand(text);
	return command?.kind === "followup" ? command.arg : text;
}

/** Per-thread mute toggles the adapter handles itself (bookkeeping, never an omp prompt). */
export type ThreadMuteCommand = "shutup" | "unshutup";

/** `!shutup` / `!unshutup` — only the exact bare word counts, so a real prompt is never stolen. */
export function parseThreadMuteCommand(text: string): ThreadMuteCommand | undefined {
	const trimmed = text.trim();
	if (trimmed === "!shutup") return "shutup";
	if (trimmed === "!unshutup") return "unshutup";
	return undefined;
}

/** Response-only provider behind `/status-ompbot`; the mailbox only stores its text as a delivery. */
export type StatusProvider = (originKey: string) => string | Promise<string>;

export interface MailboxClock {
	now(): number;
}

/** Idle omp children are stopped after this long without a turn or inbound message (session kept; 0 disables). */
export const IDLE_STOP_MS = 30 * 60 * 1000;

/**
 * A monitor origin's child is stopped this soon after its work (its next run is usually hours away; a finished
 * self-retro child held 2.6 GiB for 30 minutes). Runs arriving in a burst within it still reuse the child.
 */
export const MONITOR_IDLE_STOP_MS = 2 * 60 * 1000;

/** A running turn that emits no omp event for this long is reported as stalled (log `stall_alert` + status text). */
export const STALL_MS = 120_000;

/**
 * Repeated stalls of one turn are merged: the status text of the first stall stays until the turn has run this long
 * past its last stall-clearing event without a new stall. Observed 2026-10-30: silence (2 min) → one event at the
 * 10-minute tool timeout → silence again 3 min later, 5 times — each flip of the status text was noise. 5 min is more
 * than the 3 min gap seen between such stalls and still releases a turn that is really streaming again.
 */
export const STALL_RELEASE_MS = 5 * 60 * 1000;

/** Conversation origin: a turn with this many stalls asks the owner (one DM per turn); the turn is never cut. */
export const STALL_NOTIFY_COUNT = 3;

/** Conversation origin: a turn whose accumulated silence reaches this asks the owner (one DM per turn). */
export const STALL_NOTIFY_MS = 30 * 60 * 1000;

/** Monitor origin (unattended): accumulated silence of one turn that aborts it and fails the monitor event. */
export const MONITOR_STALL_ABORT_MS = 20 * 60 * 1000;

/**
 * A running turn's latest omp event is written to `inbound.last_event_at` at most this often, so the read-only
 * `ompbot gates` can tell a long but working turn from a hung one.
 */
export const EVENT_PERSIST_MS = 60_000;
