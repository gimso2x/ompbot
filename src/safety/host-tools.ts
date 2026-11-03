import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { slackOriginChannel } from "../core/normalize";
import { buildDispatchTool, type DispatchToolDeps } from "../dispatch/tool";
import type { Logger } from "../log";
import { redact } from "../redact";
import type { SlackTransport } from "../slack/transport";
import type { ApprovalBroker, ApprovalDetail } from "./approval";
import { isInside } from "./inside";

/** A tool the host (ompbot) executes for the omp child; mirrors omp's `RpcClientCustomTool`. */
export interface HostToolDef {
	name: string;
	label: string;
	description: string;
	/** JSON schema of the arguments. */
	parameters: Record<string, unknown>;
	execute(params: Record<string, unknown>, context: { signal: AbortSignal }): Promise<string>;
}

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** Files up to this size are scanned for token-like strings before they leave the machine. */
const SCAN_BYTES = 2 * 1024 * 1024;

export interface HostToolDeps {
	originKey: string;
	transport: SlackTransport;
	broker: ApprovalBroker;
	log: Logger;
	/** The bot home; its `secrets` directory can never be uploaded. */
	homeDir: string;
	/** Relative upload paths resolve here. */
	workspaceDir: string;
	/** Owner DM channel for origins that are not a DM themselves (work lanes); default: parsed from `originKey`. */
	channel?: string;
	/**
	 * Thread the upload lands in, resolved when the tool runs (the origin's current conversation — the agent never
	 * knows Slack ts values, the host owns them). Absent/unresolvable → the channel's main view.
	 */
	threadTs?: () => string | undefined;
	/** `omp` binary for the dispatch tool's simple mode; the tool is registered only for Slack chat origins. */
	ompExecutable?: string;
	/** Home of the user running the bot (tests override); default `os.homedir()`. */
	userHome?: string;
	/** Remote dispatch targets (config `dispatchHosts`) for the dispatch tool. */
	dispatchHosts?: DispatchToolDeps["dispatchHosts"];
	/** herdr task board (config `herdrBoard`) for the dispatch tool's card links. */
	herdrBoard?: DispatchToolDeps["herdrBoard"];
	/** [TASK] state docs for the dispatch tool's `taskSpec`. */
	tasks?: DispatchToolDeps["tasks"];
	/** Freeze switch for the dispatch tool (`<home>/FROZEN`). */
	frozen?: DispatchToolDeps["frozen"];
	/** Config `herdr`: absent → the dispatch tool is simple-only. */
	herdr?: DispatchToolDeps["herdr"];
}

function realOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** Throws with a reason when the file must not be uploaded; returns the resolved real path otherwise. */
export function checkUploadable(
	rawPath: string,
	deps: Pick<HostToolDeps, "homeDir" | "workspaceDir" | "userHome">,
): string {
	const userHome = deps.userHome ?? homedir();
	const absolute = isAbsolute(rawPath) ? rawPath : resolve(deps.workspaceDir, rawPath);
	let real: string;
	try {
		real = realpathSync(absolute);
	} catch {
		throw new Error(`file not found: ${absolute}`);
	}
	const forbidden = [
		join(deps.homeDir, "secrets"),
		join(userHome, ".ompbot", "secrets"),
		join(userHome, ".ssh"),
		join(userHome, ".gnupg"),
		join(userHome, ".aws"),
		join(userHome, ".omp", "agent"),
		join(userHome, ".gajaeway-hub"),
		join(userHome, ".git-credentials"),
		join(userHome, ".netrc"),
		join(userHome, ".config", "gh"),
	].map(realOrSelf);
	if (forbidden.some((dir) => isInside(real, dir))) throw new Error("upload refused: path is in a protected directory");
	const stat = statSync(real);
	if (!stat.isFile()) throw new Error("upload refused: not a regular file");
	if (stat.size > MAX_UPLOAD_BYTES) throw new Error(`upload refused: file larger than ${MAX_UPLOAD_BYTES} bytes`);
	if (stat.size <= SCAN_BYTES) {
		const text = readFileSync(real, "utf8");
		if (redact(text) !== text) throw new Error("upload refused: file contains a token-like secret");
	}
	return real;
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
	const value = params[key];
	return typeof value === "string" && value !== "" ? value : undefined;
}

/** The host tools registered with `set_host_tools` for one origin (an owner DM). */
export function buildHostTools(deps: HostToolDeps): HostToolDef[] {
	const channel = deps.channel ?? slackOriginChannel(deps.originKey);
	const needChannel = (): string => {
		if (channel === undefined) throw new Error(`origin is not a Slack conversation: ${deps.originKey}`);
		return channel;
	};
	// The dispatch tool is a chat-surface feature: DM and channel sessions only (lanes, monitors, review never).
	const dispatchDeps =
		deps.ompExecutable !== undefined && slackOriginChannel(deps.originKey) !== undefined
			? { ...deps, ompExecutable: deps.ompExecutable }
			: undefined;
	const dispatch = dispatchDeps === undefined ? undefined : buildDispatchTool(dispatchDeps);
	return [
		...(dispatch === undefined ? [] : [dispatch]),
		{
			name: "slack_send_file",
			label: "Send file to owner",
			description:
				"Upload a local file into the current conversation thread in the owner's Slack (the channel's main view when there is no thread). Files in secret directories or containing tokens are refused.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Absolute path (or relative to the workspace) of the file" },
					title: { type: "string", description: "Optional title" },
					comment: { type: "string", description: "Optional message shown with the file" },
				},
				required: ["path"],
				additionalProperties: false,
			},
			async execute(params) {
				const target = needChannel();
				const path = stringParam(params, "path");
				if (path === undefined) throw new Error("path is required");
				const real = checkUploadable(path, deps);
				const comment = stringParam(params, "comment");
				const title = stringParam(params, "title");
				const threadTs = deps.threadTs?.();
				const { fileId } = await deps.transport.uploadFile({
					channel: target,
					...(threadTs === undefined ? {} : { threadTs }),
					filePath: real,
					...(title === undefined ? {} : { title }),
					...(comment === undefined ? {} : { comment: redact(comment) }),
				});
				deps.log.info("file_uploaded", {
					origin: deps.originKey,
					file: basename(real),
					id: fileId,
					...(threadTs === undefined ? {} : { thread: threadTs }),
				});
				return `uploaded ${basename(real)} ${
					threadTs === undefined ? "to the owner DM" : "to the conversation thread"
				} (file id ${fileId})`;
			},
		},
		{
			name: "ompbot_request_approval",
			label: "Ask owner for approval",
			description:
				"Ask the owner to approve an irreversible or risky action with approve/deny buttons in Slack. Waits for the click. Result is `approved`, `denied`, `denied (timeout)` or `replied: <owner text>` (the owner answered in the card's thread instead of clicking); proceed on `approved`, or on a reply only when it plainly approves this exact action — otherwise treat it as not approved.",
			parameters: {
				type: "object",
				properties: {
					summary: { type: "string", description: "What you are about to do and why, in one or two lines" },
					action: { type: "string", description: "The exact action (command or file paths), one line" },
					why: { type: "string", description: "Why this action is needed now, one line" },
					impact: { type: "string", description: "What changes or breaks when it runs, one line" },
					rollback: { type: "string", description: "Why this cannot be undone (omit when it can), one line" },
				},
				required: ["summary"],
				additionalProperties: false,
			},
			async execute(params, context) {
				const target = needChannel();
				const summary = stringParam(params, "summary");
				if (summary === undefined) throw new Error("summary is required");
				// Empty sections are omitted by the card renderer, so a summary-only call renders exactly as before.
				const detail: ApprovalDetail = {
					action: stringParam(params, "action"),
					why: stringParam(params, "why"),
					impact: stringParam(params, "impact"),
					rollback: stringParam(params, "rollback"),
				};
				const threadTs = deps.threadTs?.();
				const outcome = await deps.broker.ask(target, summary, {
					signal: context.signal,
					detail,
					origin: { originKey: deps.originKey, channel: target, threadTs },
				});
				if (typeof outcome === "object") return `replied: ${outcome.replied}`;
				return outcome === "timeout" ? "denied (timeout)" : outcome;
			},
		},
	];
}
