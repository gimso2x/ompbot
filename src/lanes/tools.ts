import type { HostToolDef } from "../safety/host-tools";
import type { LaneManager } from "./manager";

function stringParam(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${key} is required`);
	return value;
}

/** Offered to the owner-DM session: starts a work lane (same as the `작업: <제목> @<경로>` message). */
export function buildWorkStartTool(manager: LaneManager, channel: string): HostToolDef {
	return {
		name: "ompbot_work_start",
		label: "Start work lane",
		description:
			"Start a long task as its own work lane: a new Slack thread in the owner DM and a separate omp session running in `cwd`. Use it for tasks that take long or touch another project. Returns the lane name.",
		parameters: {
			type: "object",
			properties: {
				title: { type: "string", description: "Short title shown on the thread" },
				cwd: { type: "string", description: "Absolute path of the project directory" },
				brief: { type: "string", description: "What the lane must do" },
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
			});
			return `lane ${lane.name} started (thread ${lane.threadRef}, origin ${lane.originKey})`;
		},
	};
}

/** Offered to a lane session only. The lane reports milestones and claims completion through these. */
export function buildLaneTools(manager: LaneManager, originKey: string): HostToolDef[] {
	return [
		{
			name: "ompbot_lane_progress",
			label: "Report lane milestone",
			description: "Report a milestone of this work lane in one line; it is shown in the lane's Slack status message.",
			parameters: {
				type: "object",
				properties: { text: { type: "string", description: "One-line milestone" } },
				required: ["text"],
				additionalProperties: false,
			},
			execute: async (params) => manager.progress(originKey, stringParam(params, "text")),
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
