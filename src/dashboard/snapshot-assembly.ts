import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { OmpbotConfig } from "../config";
import { callDaemon } from "../daemon/ipc";
import { readVersion } from "../daemon/tools";
import { DEFAULT_BOARD_API } from "../dispatch/board";
import { realProcessRunner } from "../dispatch/omp";
import { resolveTaskHost } from "../tasks/host";
import { hostTimezone } from "../time";
import { BoardSource, type BoardState } from "./board";
import { buildSnapshot, createSnapshotCache, type DashboardSnapshot, type SnapshotDeps } from "./snapshot";

/** The checkout this file belongs to (src/dashboard → repo root): its short HEAD is shown on the page and the picture. */
export const REPO_DIR = resolve(import.meta.dir, "..", "..");

/** Where the board keeps each card's status and since across dashboard restarts. */
const BOARD_SINCE_FILE = "dashboard-board-since.json";

/**
 * The agent board source: only with config `herdrBoard` (read from its `api`, default the local herdr-web-ui). With
 * `homeDir` the card times are kept in `<home>/dashboard-board-since.json`.
 */
export function boardSourceFor(
	config: Pick<OmpbotConfig, "herdrBoard"> | undefined,
	homeDir?: string,
	Board: typeof BoardSource = BoardSource,
): BoardSource | undefined {
	if (config?.herdrBoard === undefined) return undefined;
	return new Board({
		origin: config.herdrBoard.api ?? DEFAULT_BOARD_API,
		...(homeDir === undefined ? {} : { sinceFile: join(homeDir, BOARD_SINCE_FILE) }),
	});
}

/** What the assembler needs that only its caller knows: where the home is and how the daemon's status is reached. */
export interface SnapshotAssemblyOptions {
	homeDir: string;
	/** The config as booted; absent for a home without config.json. */
	config: OmpbotConfig | undefined;
	/** Default `Date.now`. */
	now?: () => number;
	/** Default the daemon socket IPC; the daemon itself passes its own status instead of calling out. */
	callDaemon?: SnapshotDeps["callDaemon"];
	/** Default the real process runner; tests inject a fake. */
	run?: SnapshotDeps["run"];
	/** Checkout whose short HEAD is shown; defaults to this module's repository. */
	repoDir?: string;
	/** The live herdr board (the CLI starts one, the daemon has none); absent = no board links or counts. */
	board?: () => BoardState | undefined;
}

/**
 * The one place `buildSnapshot`'s dependencies are assembled (`doc/plans/briefing-image.md` §D): the dashboard CLI
 * and the daemon's `!brief` both describe the same status, so they must not each wire their own. The
 * daemon passes `callDaemon` that answers with its own state instead of the socket, and keeps its board out of it.
 */
export function assembleSnapshotDeps(options: SnapshotAssemblyOptions): SnapshotDeps {
	const { homeDir, config } = options;
	const run = options.run ?? realProcessRunner;
	const now = options.now ?? Date.now;
	return {
		homeDir,
		repoDir: options.repoDir ?? REPO_DIR,
		config,
		// A home without config.json takes the zone a config without `timezone` gets.
		timezone: config?.timezone ?? hostTimezone(),
		now,
		callDaemon: options.callDaemon ?? callDaemon,
		run,
		ompVersion: async () => (config === undefined ? "unknown" : await readVersion([config.ompExecutable, "--version"])),
		hostOps: (host) => resolveTaskHost(host, config?.dispatchHosts, { run }),
		...(options.board === undefined ? {} : { board: options.board }),
	};
}

/**
 * One snapshot per {@link SNAPSHOT_TTL_MS} on top of the shared assembly; the briefing and the page both read through
 * this, so a burst of calls does not ask git, herdr and the socket again for the same minute.
 */
export function snapshotReader(options: SnapshotAssemblyOptions): () => Promise<DashboardSnapshot> {
	const now = options.now ?? Date.now;
	return createSnapshotCache(() => buildSnapshot(assembleSnapshotDeps(options)), now);
}

/** Whether `<home>/config.json` exists: a home without it is a valid install with no channels and no herdr. */
export function hasConfig(homeDir: string): boolean {
	return existsSync(join(homeDir, "config.json"));
}
