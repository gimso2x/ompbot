import type { OmpbotConfig } from "../config";

/**
 * Config reload without a restart (gajae-way SIGHUP reload): `ompbot reload` or SIGHUP re-reads config.json. Policy
 * fields apply live, fields bound to startup resources are reported as needing a restart and left untouched, and
 * fields only the CLI reads (gc, backup) take effect on its next run anyway. A config that fails validation changes
 * nothing.
 */

/** Read by the running daemon on every use (after reload: the next inbound, card, answer, omp child or sweep). */
export const LIVE_FIELDS = [
	"mentionFreeChannels",
	"logChannel",
	"escalationChannel",
	"skillReviewTurns",
	"dispatchHosts",
	"herdrBoard",
	"restartNotice",
	"recallEnabled",
] as const satisfies ReadonlyArray<keyof OmpbotConfig>;

/** Bound when the daemon starts (tokens, socket, omp children, scheduler). */
export const RESTART_FIELDS = [
	"ownerSlackUserId",
	"slack",
	"ompExecutable",
	"workspaceDir",
	"agent",
	"claudeExecutable",
	"model",
	"thinking",
	"idleTimeoutMinutes",
	"watcherRoots",
	// The daemon reads it only to decide whether the `offsite_age` gate exists; the CLI re-reads it on every run.
	"offsite",
	"webhook",
	// The dispatch tool schema and the [TASK] sweeper are decided when the daemon starts.
	"herdr",
] as const satisfies ReadonlyArray<keyof OmpbotConfig>;

/** Never read by the daemon: `ompbot gc` / `ompbot backup` load config.json themselves on every run. */
export const CLI_FIELDS = ["sessionRetentionDays", "maxBundleBytes"] as const satisfies ReadonlyArray<
	keyof OmpbotConfig
>;

export interface ReloadPlan {
	/** The config the daemon runs with after the reload: live fields from the new file, everything else unchanged. */
	next: OmpbotConfig;
	changed: string[];
	restartRequired: string[];
	cli: string[];
}

/** What `ompbot reload` (IPC op `reload`) answers. */
export type ReloadResult =
	| { ok: true; changed: string[]; restartRequired: string[]; cli: string[] }
	| { ok: false; error: string };

const differs = (a: unknown, b: unknown): boolean => JSON.stringify(a) !== JSON.stringify(b);

export function planReload(current: OmpbotConfig, fresh: OmpbotConfig): ReloadPlan {
	const next: OmpbotConfig = { ...current };
	const changed: string[] = [];
	for (const field of LIVE_FIELDS) {
		if (!differs(current[field], fresh[field])) continue;
		changed.push(field);
		if (fresh[field] === undefined) delete next[field];
		else (next as unknown as Record<string, unknown>)[field] = fresh[field];
	}
	return {
		next,
		changed,
		restartRequired: RESTART_FIELDS.filter((field) => differs(current[field], fresh[field])),
		cli: CLI_FIELDS.filter((field) => differs(current[field], fresh[field])),
	};
}
