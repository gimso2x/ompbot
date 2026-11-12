import type { HostToolDef } from "../safety/host-tools";
import { TASK_RISKS } from "../tasks/docs";
import type { LaneManager } from "./manager";

function stringParam(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${key} is required`);
	return value;
}

/**
 * Offered to chat sessions: starts a work lane in `channel` (same as the `작업: <제목> @<경로>` message). On Slack the
 * lane thread is in that conversation; on Discord it is a thread of that server channel.
 */
export function buildWorkStartTool(manager: LaneManager, channel: string): HostToolDef {
	return {
		name: "ompbot_work_start",
		label: "Start work lane",
		description:
			"Start a long task as its own work lane: a new chat thread and a separate omp session working in its own git worktree and branch (`lane/L-YYYYMMDD-NN`) of the repository that contains `cwd`. Use it for tasks that take long or touch another project. Returns the lane name.",
		parameters: {
			type: "object",
			properties: {
				title: { type: "string", description: "Short title shown on the thread" },
				cwd: { type: "string", description: "Absolute path of the project directory (inside a git repository)" },
				brief: { type: "string", description: "What the lane must do" },
				acceptance: {
					type: "array",
					items: { type: "string" },
					description:
						'Acceptance criteria, one per item. An item may end with `[check: command ["bun","run","check"]]` (or `file <path>`): the bot re-runs it in the lane worktree before the lane can close.',
				},
				risk: {
					type: "string",
					enum: [...TASK_RISKS],
					description: "Risk class L0 (trivial) .. L4 (dangerous); default L3",
				},
			},
			required: ["title", "cwd"],
			additionalProperties: false,
		},
		async execute(params) {
			const brief = typeof params.brief === "string" ? params.brief : undefined;
			const lane = await manager.start({
				title: stringParam(params, "title"),
				cwd: stringParam(params, "cwd"),
				brief,
				channel,
				acceptance: params.acceptance,
				risk: params.risk,
			});
			const link = await manager.threadLink(lane);
			const started = `lane ${lane.name} started (thread ${lane.threadRef}, origin ${lane.originKey})`;
			return link === undefined ? started : `${started}; tell the owner the lane thread link: ${link}`;
		},
	};
}

/** Offered to a lane session only. The lane reports milestones and claims completion through these. */
export function buildLaneTools(manager: LaneManager, originKey: string): HostToolDef[] {
	return [
		{
			name: "ompbot_lane_progress",
			label: "Report lane milestone",
			description:
				"Report a milestone of this work lane in one line; it is shown in the lane's status message in its chat thread. With `needsOwner: true` the line is the question the owner must decide: end the turn after it (the core then sends no automatic nudge).",
			parameters: {
				type: "object",
				properties: {
					text: { type: "string", description: "One-line milestone, or the owner's decision to make" },
					needsOwner: {
						type: "boolean",
						description: "True when the lane waits for the owner's decision (the turn ends after this call)",
					},
				},
				required: ["text"],
				additionalProperties: false,
			},
			execute: async (params) => manager.progress(originKey, stringParam(params, "text"), params.needsOwner === true),
		},
		{
			name: "ompbot_claim_done",
			label: "Claim lane done",
			description:
				"Claim that this lane's task is finished. The bot itself checks that `git -C <repo> status --porcelain` is empty and that the commit exists; only then the lane closes. Commit everything first.",
			parameters: {
				type: "object",
				properties: {
					repo: { type: "string", description: "Absolute path of the git repository" },
					commit: { type: "string", description: "Sha of the commit that contains the work" },
					summary: { type: "string", description: "What was done" },
				},
				required: ["repo", "commit", "summary"],
				additionalProperties: false,
			},
			execute: async (params) =>
				manager.claimDone(originKey, {
					repo: stringParam(params, "repo"),
					commit: stringParam(params, "commit"),
					summary: stringParam(params, "summary"),
				}),
		},
	];
}
