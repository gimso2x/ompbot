import { readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { OriginRouter, openBotStore, sessionDirFor } from "../../src/core/origin";
import { LaneManager, type LaneManagerDeps } from "../../src/lanes/manager";
import { createLogger } from "../../src/log";
import type { OmpSessionDriver } from "../../src/omp/driver";
import { FakeOmpDriver, FakeSessionStore } from "../../src/omp/fake-driver";
import { redact } from "../../src/redact";
import { SlackChannel } from "../../src/slack/channel";
import type { Store } from "../../src/store/db";
import { WaitingTransport } from "./bot-home";
import { registryOf } from "./channels";

/** 2027-01-15 KST: lane ids of a harness lane read `L-20270115-NN`. */
export const LANE_START = 1_800_000_000_000;

/** Removes a fixture repository together with the lane worktrees created beside it (`<repo>-l-<yyyymmdd>-<nn>`). */
export function removeRepoAndWorktrees(repo: string): void {
	const prefix = `${basename(repo)}-l-`;
	for (const entry of readdirSync(dirname(repo))) {
		if (entry.startsWith(prefix)) rmSync(join(dirname(repo), entry), { recursive: true, force: true });
	}
	rmSync(repo, { recursive: true, force: true });
}

export interface LaneHarness {
	manager: LaneManager;
	store: Store;
	transport: WaitingTransport;
	drivers: Map<string, FakeOmpDriver>;
	logs: string[];
	advance(ms: number): void;
	/** Resolves once every mailbox call, background verdict and other background work of the manager has been handled. */
	settle(): Promise<void>;
	/** `steer:` calls the lane's omp child received. */
	steers(originKey: string): string[];
	/** `prompt:` calls the lane's omp child received. */
	prompts(originKey: string): string[];
	close(): void;
}

/** Builds the driver the router hands a lane session (tests substitute a never-settling fake here). */
export type LaneDriverFactory = (originKey: string, sessionDir: string) => OmpSessionDriver;

/** The manager seams a harness test may replace, plus the lane session's driver. */
export type LaneHarnessExtra = Partial<
	Pick<
		LaneManagerDeps,
		| "hostOps"
		| "verify"
		| "collectDiff"
		| "frozen"
		| "maxLanes"
		| "land"
		| "autoLandPolicy"
		| "repoMatches"
		| "integrity"
		| "approvals"
		| "ownerUserId"
		| "laneBusy"
		| "reviewer"
		| "changesGit"
	>
> & { driver?: LaneDriverFactory };

/** A `LaneManager` over a real store and router with held fake omp turns, a fake clock and a fake Slack. */
export function laneHarness(homeDir: string, extra: LaneHarnessExtra = {}): LaneHarness {
	const { driver: laneDriver, ...managerExtra } = extra;
	let now = LANE_START;
	const clock = { now: () => now };
	const store = openBotStore(join(homeDir, "ompbot.db"), clock, "Asia/Seoul");
	const transport = new WaitingTransport();
	const sessions = new FakeSessionStore();
	const drivers = new Map<string, FakeOmpDriver>();
	const sessionsRoot = join(homeDir, "sessions");
	const logs: string[] = [];
	const log = createLogger({ sink: (line) => logs.push(line), clock, redact });
	// Assigned right below the router: the router tells it when a held lane's child starts working again.
	let manager!: LaneManager;
	const router = new OriginRouter({
		timezone: "Asia/Seoul",
		store,
		clock,
		log,
		sessionsRoot,
		statusProvider: () => "",
		// The registry is the single source of the hold (like the daemon): a restart keeps it.
		isHeld: (originKey) => store.getLaneByOrigin(originKey)?.status === "paused",
		onHeldWork: (info) => manager?.onHeldWork(info.originKey),
		driverFactory:
			laneDriver ??
			((origin, sessionDir) => {
				const driver = new FakeOmpDriver({ sessionDir, store: sessions, holdTurns: true });
				drivers.set(origin, driver);
				return driver;
			}),
	});
	const pending: Promise<unknown>[] = [];
	manager = new LaneManager({
		timezone: "Asia/Seoul",
		store,
		channels: registryOf(new SlackChannel(transport)),
		clock,
		log,
		sessionsRoot,
		route: (record) => {
			const run = router.route(record);
			pending.push(run);
			return run;
		},
		stopWhenIdle: (origin) => {
			const run = router.mailbox(origin).stopWhenIdle();
			pending.push(run);
			return run;
		},
		pauseTurn: (origin) => {
			const run = router.mailbox(origin).pauseTurn();
			pending.push(run);
			return run;
		},
		resumePending: (origin) => {
			const run = router.mailbox(origin).resumePending();
			pending.push(run);
			return run;
		},
		sessionDirFor: (origin) => sessionDirFor(sessionsRoot, origin, 1),
		...managerExtra,
	});
	const callsOf = (originKey: string, prefix: string) =>
		drivers.get(originKey)?.calls.filter((call) => call.startsWith(prefix)) ?? [];
	return {
		manager,
		store,
		transport,
		drivers,
		logs,
		advance: (ms) => {
			now += ms;
		},
		settle: async () => {
			// Background work (a verdict the tick started, an Outcome card, an auto-merge) may route more messages: wait
			// until none is left.
			for (let seen = -1; seen !== pending.length; ) {
				seen = pending.length;
				await Promise.all(pending);
				await manager.settledInBackground();
				await manager.idle();
			}
		},
		steers: (originKey) => callsOf(originKey, "steer:"),
		prompts: (originKey) => callsOf(originKey, "prompt:"),
		close: () => store.close(),
	};
}
