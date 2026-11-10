import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { ChannelRegistry } from "../channel/registry";
import { type ChatPlatform, parseChatOrigin, platformOfConversationId } from "../core/origin-key";
import { buildDispatchTool, type DispatchToolDeps } from "../dispatch/tool";
import type { Logger } from "../log";
import { maskKnownFragments, redact, secretShapes } from "../redact";
import type { ApprovalBroker, ApprovalDetail } from "./approval";
import { isInside } from "./inside";
import { sendFileToolName } from "./prompt";

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
/** Uploads are scanned for token-like strings in chunks of this many bytes (whole-file `redact` would need GBs). */
export const UPLOAD_SCAN_CHUNK_BYTES = 1024 * 1024;
/**
 * Characters of each chunk's tail rescanned with the next chunk. Far above the longest prefix an upload pattern
 * needs (`sk-ant-` + 20) and a value-index window (16 characters, plus any separators smudged into it), so a token
 * across a chunk boundary is still caught.
 */
export const UPLOAD_SCAN_CARRY_CHARS = 4096;
/**
 * `redact`'s secret shapes, except that an `sk-` key needs 20+ characters after `sk-` / `sk-ant-`: binary data decoded
 * as UTF-8 is full of short `sk-…` runs. Chat masking (`redact`) keeps the shorter shape.
 */
const UPLOAD_SECRET_PATTERN = new RegExp(secretShapes("{20,}"));

/** The upload verdict on one scanned span: a token-shaped string or a fragment of an indexed secret value. */
export function hasUploadSecret(text: string): boolean {
	return UPLOAD_SECRET_PATTERN.test(text) || maskKnownFragments(text) !== text;
}

/** How a tool description names each platform. */
const PLATFORM_NAMES: Record<ChatPlatform, string> = { slack: "Slack", discord: "Discord", telegram: "Telegram" };

export interface HostToolDeps {
	originKey: string;
	/** Uploads go out on the port of the target conversation's platform. */
	channels: ChannelRegistry;
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
	/** Local herdr worker omp extra arguments (config `workerOmpArgs`) for the dispatch tool. */
	workerOmpArgs?: DispatchToolDeps["workerOmpArgs"];
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
		join(userHome, ".config", "gcloud"),
		join(userHome, ".npmrc"),
		join(userHome, ".kube"),
		join(userHome, ".docker"),
	].map(realOrSelf);
	if (forbidden.some((dir) => isInside(real, dir))) throw new Error("upload refused: path is in a protected directory");
	const stat = statSync(real);
	if (!stat.isFile()) throw new Error("upload refused: not a regular file");
	if (stat.size > MAX_UPLOAD_BYTES) throw new Error(`upload refused: file larger than ${MAX_UPLOAD_BYTES} bytes`);
	const fd = openSync(real, "r");
	try {
		const decoder = new TextDecoder();
		const chunk = new Uint8Array(UPLOAD_SCAN_CHUNK_BYTES);
		let carry = "";
		for (;;) {
			const read = readSync(fd, chunk, 0, chunk.length, null);
			const text = carry + decoder.decode(chunk.subarray(0, read), { stream: read > 0 });
			if (hasUploadSecret(text)) throw new Error("upload refused: file contains a token-like secret");
			if (read === 0) break;
			carry = text.slice(-UPLOAD_SCAN_CARRY_CHARS);
			// `sk-` needs a non-alphanumeric left edge that the cut hides; a key starting there was judged whole already.
			if (carry.startsWith("sk-")) carry = carry.slice(1);
		}
	} finally {
		closeSync(fd);
	}
	return real;
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
	const value = params[key];
	return typeof value === "string" && value !== "" ? value : undefined;
}

/** The host tools registered with `set_host_tools` for one origin (an owner DM). */
export function buildHostTools(deps: HostToolDeps): HostToolDef[] {
	const chatOrigin = parseChatOrigin(deps.originKey);
	const channel = deps.channel ?? chatOrigin?.conversationId;
	// The origin's own platform, else the lane's channel's; a tool without either refuses at run time (`needChannel`).
	const platform =
		chatOrigin?.platform ?? (channel === undefined ? undefined : platformOfConversationId(channel)) ?? "slack";
	const platformName = PLATFORM_NAMES[platform];
	const needChannel = (): string => {
		if (channel === undefined) throw new Error(`origin is not a Slack conversation: ${deps.originKey}`);
		return channel;
	};
	// The dispatch tool is a chat-surface feature: DM and channel sessions only (lanes, monitors, review never).
	const dispatchDeps: DispatchToolDeps | undefined =
		deps.ompExecutable !== undefined && chatOrigin !== undefined
			? {
					...deps,
					ompExecutable: deps.ompExecutable,
					// A high_risk herdr brief asks the owner on the same card as `ompbot_request_approval`.
					approve: (summary, detail, signal) => {
						const target = needChannel();
						return deps.broker.ask(target, summary, {
							signal,
							detail,
							origin: { originKey: deps.originKey, channel: target, threadTs: deps.threadTs?.() },
						});
					},
				}
			: undefined;
	const dispatch = dispatchDeps === undefined ? undefined : buildDispatchTool(dispatchDeps);
	return [
		...(dispatch === undefined ? [] : [dispatch]),
		{
			name: sendFileToolName(platform),
			label: "Send file to owner",
			description: `Upload a local file into the current conversation thread in the owner's ${platformName} (the channel's main view when there is no thread). Files in secret directories or containing tokens are refused.`,
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
				const { fileId } = await deps.channels.portFor(target).uploadFile(
					{ conversationId: target, ...(threadTs === undefined ? {} : { threadId: threadTs }) },
					{
						path: real,
						...(title === undefined ? {} : { title }),
						...(comment === undefined ? {} : { comment: redact(comment) }),
					},
				);
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
					external: {
						type: "string",
						description:
							"Where it is published outside the owner's own systems and who can see it (public GitHub issue/PR/comment, email, another workspace, a web post), one line; omit when nothing leaves",
					},
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
					external: stringParam(params, "external"),
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
