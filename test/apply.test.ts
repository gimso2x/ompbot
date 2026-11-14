import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPLY_USAGE, applyCommand, homeDeps, peerApplyOptions } from "../src/cli/apply";
import { waitForDrain } from "../src/cli/drain";
import { doctorCommand } from "../src/cli/index";
import { checkCodeRollbackJournal } from "../src/daemon/doctor";
import type { SweepHeartbeat } from "../src/daemon/heartbeat";
import { RESTART_CUT_FILE } from "../src/daemon/recovery";
import {
	type ApplyDeps,
	type ApplyOptions,
	type ApplyOutcome,
	type ApplyReceipt,
	CODE_ROLLBACK_JOURNAL,
	createApplyLock,
	detachedApplyCommand,
	findDaemonUnits,
	isReportOrigin,
	type PeerApply,
	parseApplyLock,
	type RunResult,
	readAutoLandHold,
	reclaimStaleApplyLock,
	releaseApplyLock,
	reportThreadPattern,
	revertCommandFor,
	runApply,
	spawnRunner,
} from "../src/ops/apply";
import type { BackupResult } from "../src/ops/backup";
import { DEPS_MARKER, depsHash, ensureDeps, INSTALL_LOCK_FILE, INSTALL_LOCK_WAIT_MS } from "../src/ops/deps";
import type { Gate } from "../src/ops/gates";

const HEAD = "a".repeat(40);
const PREV = "b".repeat(40);
const T0 = Date.UTC(2026, 9, 30, 5, 0, 0);

let root: string;
let home: string;
let repo: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ompbot-apply-"));
	home = join(root, "home");
	repo = join(root, "repo");
	mkdirSync(home, { mode: 0o700 });
	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(join(repo, "src", "main.ts"), "");
	writeFileSync(join(repo, "package.json"), '{"name":"x"}\n');
	writeFileSync(join(repo, "bun.lock"), "lock-1\n");
	markDepsInstalled();
	mkdirSync(join(root, "gitdir"));
	writeFileSync(join(home, "config.json"), '{"v":"before"}', { mode: 0o600 });
});

/** The checkout's node_modules as installed from its current package.json and bun.lock. */
function markDepsInstalled(): void {
	mkdirSync(join(repo, "node_modules"), { recursive: true });
	writeFileSync(join(repo, DEPS_MARKER), `${depsHash(repo)}\n`);
}

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

interface World {
	clock: number;
	branch: string;
	headSha: string;
	mainSha: string;
	srcStatus: string;
	activeEnterUnix: string;
	restartRc: number;
	activeRc: number;
	drainCancels: number;
	/** `drain_cut` requests the daemon got; each one writes the cut record as the daemon would. */
	drainCuts: unknown[];
	drainCutResponse: unknown;
	/** Whether a restart yields a freshly started daemon (lock startedAt after the restart). */
	restartMakesFreshDaemon: boolean;
	lockStartedAt: number | undefined;
	/** The heartbeat stamp; default: written by the daemon holding the lock, 0.5 s after its start, transports up. */
	heartbeat: ((world: World) => SweepHeartbeat | undefined) | undefined;
	commands: string[][];
	envs: Array<Record<string, string> | undefined>;
	drainResult: Awaited<ReturnType<ApplyDeps["drain"]>>;
	injects: unknown[];
	injectError: boolean;
	/** Inject calls that fail to connect (daemon socket down) before one goes through. */
	injectConnectFailures: number;
	injectResponse: unknown;
	/** `notify` requests (`reportPlain`); answered `{ ok: true }`. */
	notifies: unknown[];
	drains: number;
	backups: number;
	/** Runs when `systemctl restart` is requested; lets a test change config.json as the new code would. */
	onRestart: (n: number) => void;
	/** `bun install` calls, with whether the deps marker still existed at the call. */
	installs: Array<{ cmd: string[]; markerAtCall: boolean }>;
	installRc: number;
	/** `systemctl --user list-units` output and the `show -p Id …` blocks of those units (default: none). */
	listUnits: string;
	unitsShow: string;
	/** `systemctl restart` of a dashboard unit. */
	dashboardRestartRc: number;
}

function makeWorld(): World {
	return {
		clock: T0,
		branch: "main",
		headSha: HEAD,
		mainSha: HEAD,
		srcStatus: "",
		activeEnterUnix: "@0",
		restartRc: 0,
		activeRc: 0,
		drainCancels: 0,
		drainCuts: [],
		drainCutResponse: { ok: true, opRefs: 1, approvals: 1 },
		restartMakesFreshDaemon: true,
		lockStartedAt: T0 - 3_600_000,
		heartbeat: undefined,
		commands: [],
		envs: [],
		drainResult: { ok: true, counts: { turns: 0, hostTools: 0, approvals: 0 } },
		injects: [],
		injectError: false,
		injectConnectFailures: 0,
		injectResponse: { ok: true, nonce: "n", threadRef: "t" },
		notifies: [],
		drains: 0,
		backups: 0,
		onRestart: () => {},
		installs: [],
		installRc: 0,
		listUnits: "",
		unitsShow: "",
		dashboardRestartRc: 0,
	};
}

let nextPid = 40_000;

function makeDeps(world: World, over: Partial<ApplyDeps> = {}): ApplyDeps {
	let restarts = 0;
	const run = async (cmd: string[], opts?: { env?: Record<string, string> }): Promise<RunResult> => {
		world.commands.push(cmd);
		world.envs.push(opts?.env);
		const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
		if (cmd[0] === "git") {
			const sub = cmd.slice(3);
			if (sub[0] === "branch") return ok(`${world.branch}\n`);
			if (sub[0] === "rev-parse" && sub.at(-1) === "HEAD") return ok(`${world.headSha}\n`);
			if (sub[0] === "rev-parse" && sub.at(-1) === "main") return ok(`${world.mainSha}\n`);
			if (sub[0] === "rev-parse" && sub.at(-1) === "--absolute-git-dir") return ok(`${join(root, "gitdir")}\n`);
			if (sub[0] === "rev-parse") return ok(`${PREV}\n`);
			if (sub[0] === "status") return ok(world.srcStatus);
		}
		if (cmd[0] === "systemctl" && cmd[2] === "is-active") return { code: world.activeRc, stdout: "", stderr: "" };
		if (cmd[0] === "systemctl" && cmd[2] === "list-units") return ok(world.listUnits);
		if (cmd[0] === "systemctl" && cmd[2] === "show" && cmd.includes("Id")) {
			// Only the blocks of the units asked for, as systemctl answers.
			const blocks = world.unitsShow.split("\n\n").filter((block) => {
				const id = /^Id=(.+)$/m.exec(block)?.[1];
				return id !== undefined && cmd.includes(id);
			});
			return ok(blocks.join("\n\n"));
		}
		if (cmd[0] === "systemctl" && cmd[2] === "show") return ok(`${world.activeEnterUnix}\n`);
		if (cmd[0] === "systemctl" && cmd[2] === "restart" && cmd[3]?.includes("dashboard")) {
			return world.dashboardRestartRc === 0
				? ok()
				: { code: world.dashboardRestartRc, stdout: "", stderr: "unit busy" };
		}
		if (cmd[0] === "systemctl" && cmd[2] === "restart") {
			restarts += 1;
			world.onRestart(restarts);
			if (world.restartRc !== 0) return { code: world.restartRc, stdout: "", stderr: "boom" };
			if (world.restartMakesFreshDaemon) world.lockStartedAt = world.clock + 1_000;
			return ok();
		}
		if (cmd[0] === "timeout" && cmd[3] === "install") {
			world.installs.push({ cmd, markerAtCall: existsSync(join(repo, DEPS_MARKER)) });
			return world.installRc === 0
				? ok("installed\n")
				: { code: world.installRc, stdout: "", stderr: Array.from({ length: 30 }, (_, i) => `err ${i}`).join("\n") };
		}
		throw new Error(`unexpected command ${cmd.join(" ")}`);
	};
	const gates: Gate[] = [
		{ name: "backup_age", state: "closed", detail: "ok" },
		{ name: "origin_silent", state: "open", detail: "1 pending" },
	];
	return {
		homeDir: home,
		unit: "ompbot",
		repoDir: repo,
		pathEnv: "/h/.local/bin:/h/.bun/bin:/usr/bin",
		now: () => world.clock,
		sleep: async (ms) => {
			world.clock += ms;
		},
		run,
		callDaemon: async (request) => {
			const op = (request as { op: string }).op;
			if (op === "inject") {
				world.injects.push(request);
				if (world.injectError) throw new Error("socket gone");
				if (world.injects.length <= world.injectConnectFailures)
					throw Object.assign(new Error("Failed to connect"), { code: "ECONNREFUSED" });
				return world.injectResponse;
			}
			if (op === "notify") {
				world.notifies.push(request);
				return { ok: true };
			}
			if (op === "drain_cancel") world.drainCancels += 1;
			if (op === "drain_cut") {
				world.drainCuts.push(request);
				writeFileSync(join(home, RESTART_CUT_FILE), '{"at":0,"applyStamp":"x","opRefs":[]}', { mode: 0o600 });
				return world.drainCutResponse;
			}
			return { ok: true, status: {} };
		},
		drain: async () => {
			world.drains += 1;
			return world.drainResult;
		},
		backup: () => {
			world.backups += 1;
			return { file: join(home, "backups", "ompbot-20261030-050000.db") } as BackupResult;
		},
		gates: () => gates,
		doctor: async () => ({ code: 1, lines: ["ok home: x", "fail omp: missing"] }),
		lockStartedAt: () => world.lockStartedAt,
		heartbeat: () => {
			if (world.heartbeat !== undefined) return world.heartbeat(world);
			if (world.lockStartedAt === undefined) return undefined;
			const since = new Date(world.lockStartedAt);
			return {
				ts: new Date(world.lockStartedAt + 500),
				loopMs: 1,
				socket: { state: "up", since },
				discord: { state: "up", since },
				draining: false,
			};
		},
		pid: nextPid++,
		isAlive: () => true,
		isExecutable: (path) => path === "/h/.local/bin/bun",
		log: () => {},
		...over,
	};
}

const restartCommands = (world: World): string[][] =>
	world.commands.filter((c) => c[0] === "systemctl" && c[2] === "restart");

function readReceipt(receipt: ApplyReceipt): ApplyReceipt {
	return JSON.parse(readFileSync(receipt.receiptPath, "utf8")) as ApplyReceipt;
}

const base: ApplyOptions = { timeoutMin: 5, stamp: "20261030-140000" };

describe("runApply precheck", () => {
	test("a checkout on another branch is SKIPPED: exit 3, nothing backed up or restarted, receipt written", async () => {
		const world = makeWorld();
		world.branch = "optimize-20261027";
		const { exitCode, receipt } = await runApply(base, makeDeps(world));
		expect(exitCode).toBe(3);
		expect(receipt.status).toBe("skipped");
		expect(receipt.steps[0]?.detail).toContain("optimize-20261027");
		expect(world.backups).toBe(0);
		expect(restartCommands(world)).toHaveLength(0);
		expect(readReceipt(receipt).receiptPath).toBe(join(home, "logs", "apply-20261030-140000.json"));
	});

	test("HEAD differing from main, uncommitted src changes and a missing bun each SKIP", async () => {
		for (const mutate of [
			(w: World) => {
				w.headSha = PREV;
			},
			(w: World) => {
				w.srcStatus = " M src/main.ts\n";
			},
		]) {
			const world = makeWorld();
			mutate(world);
			const outcome = await runApply(base, makeDeps(world));
			expect(outcome.exitCode).toBe(3);
			expect(restartCommands(world)).toHaveLength(0);
		}
		const world = makeWorld();
		const outcome = await runApply(base, makeDeps(world, { isExecutable: () => false }));
		expect(outcome.exitCode).toBe(3);
		expect(outcome.receipt.steps[0]?.detail).toContain("bun not found");
	});

	test("children run with ~/.local/bin and ~/.bun/bin first on PATH", async () => {
		const world = makeWorld();
		await runApply(base, makeDeps(world));
		for (const env of world.envs) expect(env?.PATH?.startsWith("/h/.local/bin:/h/.bun/bin")).toBe(true);
	});

	test("a daemon that started after --merged-at already runs the change: success without backup or restart", async () => {
		const world = makeWorld();
		world.activeEnterUnix = `@${Math.floor((T0 + 60_000) / 1000)}`;
		const { exitCode, receipt } = await runApply({ ...base, mergedAt: new Date(T0) }, makeDeps(world));
		expect(exitCode).toBe(0);
		expect(receipt.status).toBe("already_applied");
		expect(world.backups).toBe(0);
		expect(restartCommands(world)).toHaveLength(0);

		const older = makeWorld();
		older.activeEnterUnix = `@${Math.floor((T0 - 60_000) / 1000)}`;
		const again = await runApply({ ...base, mergedAt: new Date(T0) }, makeDeps(older));
		expect(again.receipt.status).toBe("ok");
		expect(restartCommands(older)).toHaveLength(1);
	});
});

describe("runApply bot omp profile sync (omp-isolation AC-6)", () => {
	test("with ompProfile the sync runs before the drain and its count is in the receipt", async () => {
		const world = makeWorld();
		let drainsAtSync = -1;
		const deps = makeDeps(world, {
			ompSync: () => {
				drainsAtSync = world.drains;
				return { changed: 3 };
			},
		});
		const { exitCode, receipt } = await runApply(base, deps);
		expect(exitCode).toBe(0);
		expect(drainsAtSync).toBe(0);
		expect(receipt.steps.map((s) => s.name)).toEqual([
			"preflight",
			"backup",
			"omp_sync",
			"drain",
			"restart",
			"ready",
			"transports",
			"verify",
			"last_good",
			"dashboard",
		]);
		expect(receipt.steps.find((s) => s.name === "omp_sync")?.detail).toBe("omp_profile_sync changed=3");
		expect(restartCommands(world)).toHaveLength(1);
	});

	test("the CLI wires the sync only for a home whose config sets ompProfile", () => {
		const config = {
			schemaVersion: 1,
			channels: { slack: { ownerUserId: "UOWNER0" } },
			slack: { botTokenFile: "secrets/bot.token", appTokenFile: "secrets/app.token" },
			ompExecutable: "/usr/local/bin/omp",
			workspaceDir: "workspace",
		};
		mkdirSync(join(home, "secrets"), { mode: 0o700 });
		writeFileSync(join(home, "secrets", "bot.token"), "xoxb-TEST-0\n", { mode: 0o600 });
		writeFileSync(join(home, "secrets", "app.token"), "xapp-TEST-0\n", { mode: 0o600 });
		writeFileSync(join(home, "config.json"), JSON.stringify(config));
		expect(homeDeps(home, "ompbot", "/usr/bin").ompSync).toBeUndefined();
		writeFileSync(join(home, "config.json"), JSON.stringify({ ...config, ompProfile: "ompbot" }));
		expect(homeDeps(home, "ompbot", "/usr/bin").ompSync).toBeFunction();
	});

	test("a failed sync ends the apply: no drain, no restart, exit 1", async () => {
		const world = makeWorld();
		const deps = makeDeps(world, {
			ompSync: () => {
				throw new Error("source agent dir /x does not exist");
			},
		});
		const { exitCode, receipt } = await runApply(base, deps);
		expect(exitCode).toBe(1);
		expect(receipt.status).toBe("failed");
		expect(receipt.steps.at(-1)).toMatchObject({
			name: "omp_sync",
			ok: false,
			detail: "source agent dir /x does not exist",
		});
		expect(world.drains).toBe(0);
		expect(restartCommands(world)).toHaveLength(0);
	});
});

describe("runApply execution", () => {
	test("success: backup, drain, one restart, fresh daemon; gates/doctor recorded; receipt has every step", async () => {
		const world = makeWorld();
		const { exitCode, receipt } = await runApply(base, makeDeps(world));
		expect(exitCode).toBe(0);
		expect(receipt.status).toBe("ok");
		expect(receipt.steps.map((s) => [s.name, s.ok])).toEqual([
			["preflight", true],
			["backup", true],
			["drain", true],
			["restart", true],
			["ready", true],
			["transports", true],
			["verify", true],
			["last_good", true],
			["dashboard", true],
		]);
		expect(receipt.steps.at(-1)?.detail).toBe("skipped: no active dashboard unit of this home");
		expect(receipt.steps.find((s) => s.name === "transports")?.detail).toBe("slack=up discord=up");
		expect(readFileSync(join(home, "config.json.last-good"), "utf8")).toBe('{"v":"before"}');
		expect(statSync(join(home, "config.json.last-good")).mode & 0o777).toBe(0o600);
		expect(restartCommands(world)).toHaveLength(1);
		expect(receipt.gates).toEqual({ open: 1, total: 2, opened: ["origin_silent(1 pending)"] });
		expect(receipt.doctor).toEqual({ code: 1, failed: ["fail omp: missing"] });
		expect(receipt.previousHead).toBe(PREV);
		expect(receipt.revertCommand).toContain(`read-tree -m -u HEAD ${PREV}`);
		const disk = readReceipt(receipt);
		expect(disk.steps.every((s) => typeof s.ms === "number")).toBe(true);
		expect(statSync(receipt.receiptPath).mode & 0o777).toBe(0o600);
		const configCopy = `${join(home, "config.json")}.bak-20261030-140000-apply`;
		expect(readFileSync(configCopy, "utf8")).toBe('{"v":"before"}');
		expect(statSync(configCopy).mode & 0o777).toBe(0o600);
	});

	test("transports: a stamp from before the restart never counts; a fresh one with a transport down rolls back", async () => {
		const world = makeWorld();
		writeFileSync(join(home, "config.json.last-good"), '{"v":"good"}', { mode: 0o600 });
		const oldStamp = new Date(T0 - 1_000); // the old daemon's last beat: transports up, but before the restart
		// The rollback restart's daemon beats with every transport up: only then is the config rollback a success.
		world.heartbeat = (w) => {
			if (restartCommands(w).length === 1)
				return {
					ts: oldStamp,
					loopMs: 1,
					socket: { state: "up", since: oldStamp },
					discord: { state: "up", since: oldStamp },
				};
			const since = new Date(w.lockStartedAt ?? 0);
			return {
				ts: new Date(since.getTime() + 500),
				loopMs: 1,
				socket: { state: "up", since },
				discord: { state: "up", since },
			};
		};
		const stale = await runApply(base, makeDeps(world));
		expect(stale.exitCode).toBe(1);
		expect(stale.receipt.steps.map((s) => [s.name, s.ok])).toEqual([
			["preflight", true],
			["backup", true],
			["drain", true],
			["restart", true],
			["ready", true],
			["transports", false],
			["rollback", true],
		]);
		expect(stale.receipt.steps.find((s) => s.name === "transports")?.detail).toContain("from before the restart");
		expect(stale.receipt.steps.at(-1)?.detail).toContain("transports ok: slack=up discord=up");
		expect(restartCommands(world)).toHaveLength(2);
		expect(readFileSync(join(home, "config.json"), "utf8")).toBe('{"v":"good"}');

		// The rollback restart answers IPC but no fresh heartbeat ever shows the transports: not a recovery, the
		// config rollback fails and the code rollback branch decides (no head.last-good here, so it is skipped).
		rmSync(join(home, "logs"), { recursive: true, force: true });
		const dead = makeWorld();
		writeFileSync(join(home, "config.json.last-good"), '{"v":"good"}', { mode: 0o600 });
		dead.heartbeat = (w) =>
			restartCommands(w).length === 1
				? {
						ts: oldStamp,
						loopMs: 1,
						socket: { state: "up", since: oldStamp },
						discord: { state: "up", since: oldStamp },
					}
				: undefined;
		const noTransports = await runApply({ ...base, stamp: "20261030-143000" }, makeDeps(dead));
		expect(noTransports.exitCode).toBe(1);
		expect(noTransports.receipt.steps.map((s) => [s.name, s.ok])).toEqual([
			["preflight", true],
			["backup", true],
			["drain", true],
			["restart", true],
			["ready", true],
			["transports", false],
			["rollback", false],
		]);
		const rollback = noTransports.receipt.steps.at(-1)?.detail;
		expect(rollback).toContain("transports failed: transports not up within 120s: no heartbeat");
		expect(rollback).toContain("code rollback skipped");
		expect(restartCommands(dead)).toHaveLength(2);

		rmSync(join(home, "logs"), { recursive: true, force: true });
		const down = makeWorld();
		down.heartbeat = (w) => {
			const since = new Date(w.lockStartedAt ?? 0);
			return { ts: new Date(w.clock), loopMs: 1, socket: { state: "up", since }, discord: { state: "down", since } };
		};
		const failed = await runApply({ ...base, stamp: "20261030-150000" }, makeDeps(down));
		expect(failed.exitCode).toBe(1);
		expect(failed.receipt.steps.find((s) => s.name === "transports")?.detail).toBe(
			"transports not up within 120s: down: discord (slack=up discord=down)",
		);
	});

	test("transports: a transport the daemon does not run (no field in the stamp) is not waited for", async () => {
		const world = makeWorld();
		world.heartbeat = (w) => ({ ts: new Date((w.lockStartedAt ?? 0) + 500), loopMs: 1 });
		const { exitCode, receipt } = await runApply(base, makeDeps(world));
		expect(exitCode).toBe(0);
		expect(receipt.steps.find((s) => s.name === "transports")?.detail).toBe("slack=off discord=off");
	});

	test("a merge landing during drain: the receipt head is the commit the restart loads, preflight head kept", async () => {
		const world = makeWorld();
		const moved = "c".repeat(40);
		const deps = makeDeps(world);
		const { exitCode, receipt } = await runApply(base, {
			...deps,
			drain: async (timeoutMin) => {
				const result = await deps.drain(timeoutMin);
				world.headSha = moved;
				world.mainSha = moved;
				return result;
			},
		});
		expect(exitCode).toBe(0);
		expect(receipt.head).toBe(moved);
		expect(receipt.headAtPreflight).toBe(HEAD);
		expect(receipt.steps.find((s) => s.name === "restart")?.detail).toBe(
			"restart requested (HEAD moved after preflight: aaaaaaa→ccccccc)",
		);
		expect(readReceipt(receipt).head).toBe(moved);
	});

	test("an old daemon still answering is not ready: waits, then rolls back config with one more restart", async () => {
		const world = makeWorld();
		world.restartMakesFreshDaemon = false; // restart returns 0 but no new process ever takes the lock
		writeFileSync(join(home, "config.json.last-good"), '{"v":"good"}', { mode: 0o600 });
		world.onRestart = (n) => {
			if (n === 1) writeFileSync(join(home, "config.json"), '{"v":"after-bad-edit"}');
		};
		const { exitCode, receipt } = await runApply(base, makeDeps(world));
		expect(exitCode).toBe(1);
		expect(receipt.status).toBe("failed");
		expect(receipt.steps.map((s) => [s.name, s.ok])).toEqual([
			["preflight", true],
			["backup", true],
			["drain", true],
			["restart", true],
			["ready", false],
			["rollback", false],
		]);
		expect(restartCommands(world)).toHaveLength(2);
		expect(readFileSync(join(home, "config.json"), "utf8")).toBe('{"v":"good"}');
		expect(world.drainCancels).toBe(1); // no fresh daemon ever came up: the old one must leave drain
		const rollback = receipt.steps.at(-1);
		expect(rollback?.detail).toContain("config restored");
		expect(rollback?.detail).toContain("code not reverted; to revert: git -C");
		// the wait is bounded by the 2 minute ready window, per attempt
		expect(world.clock - T0).toBeLessThan(5 * 60_000);
	});

	test("rollback that brings a daemon back is recorded ok but the apply still fails", async () => {
		const world = makeWorld();
		world.restartMakesFreshDaemon = false;
		let restarts = 0;
		world.onRestart = () => {
			restarts += 1;
			if (restarts === 2) world.restartMakesFreshDaemon = true;
		};
		const { exitCode, receipt } = await runApply(base, makeDeps(world));
		expect(exitCode).toBe(1);
		expect(receipt.steps.at(-1)).toMatchObject({ name: "rollback", ok: true });
	});

	test("a drain that times out fails without restarting or touching config", async () => {
		const world = makeWorld();
		world.drainResult = { ok: false, reason: "timeout", counts: { turns: 1, hostTools: 0, approvals: 0 } };
		const { exitCode, receipt } = await runApply(base, makeDeps(world));
		expect(exitCode).toBe(1);
		expect(receipt.steps.at(-1)).toMatchObject({ name: "drain", ok: false });
		expect(restartCommands(world)).toHaveLength(0);
		expect(readFileSync(join(home, "config.json"), "utf8")).toBe('{"v":"before"}');
	});

	test("a failing systemctl restart rolls back too", async () => {
		const world = makeWorld();
		world.restartRc = 1;
		const { exitCode, receipt } = await runApply(base, makeDeps(world));
		expect(exitCode).toBe(1);
		expect(receipt.steps.map((s) => s.name)).toEqual(["preflight", "backup", "drain", "restart", "rollback"]);
		expect(receipt.steps[3]?.detail).toContain("rc=1");
		expect(restartCommands(world)).toHaveLength(2);
	});

	test("a failing backup stops before drain", async () => {
		const world = makeWorld();
		const deps = makeDeps(world, {
			backup: () => {
				throw new Error("db_missing: /x");
			},
		});
		const { exitCode, receipt } = await runApply(base, deps);
		expect(exitCode).toBe(1);
		expect(receipt.steps.at(-1)).toMatchObject({ name: "backup", ok: false });
		expect(restartCommands(world)).toHaveLength(0);
	});
});

describe("runApply config copies", () => {
	const applyCopies = () =>
		readdirSync(home)
			.filter((name) => /^config\.json\.bak-.*-apply$/.test(name))
			.sort();

	test("a config unchanged since the newest apply copy reuses that copy: one copy, both receipts name it", async () => {
		const first = await runApply(base, makeDeps(makeWorld()));
		const second = await runApply({ ...base, stamp: "20261030-150000" }, makeDeps(makeWorld()));
		expect(applyCopies()).toEqual(["config.json.bak-20261030-140000-apply"]);
		expect(first.receipt.configBackup).toBe(join(home, "config.json.bak-20261030-140000-apply"));
		expect(second.receipt.configBackup).toBe(first.receipt.configBackup);
	});

	test("a new copy keeps only the newest 10 apply copies; hand-made bak names are never touched", async () => {
		for (let day = 10; day < 20; day++) {
			writeFileSync(join(home, `config.json.bak-202610${day}-090000-apply`), `{"v":"${day}"}`, { mode: 0o600 });
		}
		const manual = ["config.json.bak-20261001-hub-parity", "config.json.bak-20261001-101854-herdr-report"];
		for (const name of manual) writeFileSync(join(home, name), "{}", { mode: 0o600 });
		const { receipt } = await runApply(base, makeDeps(makeWorld()));
		expect(receipt.configBackup).toBe(join(home, "config.json.bak-20261030-140000-apply"));
		const kept = applyCopies();
		expect(kept).toHaveLength(10);
		expect(kept[0]).toBe("config.json.bak-20261011-090000-apply");
		expect(kept.at(-1)).toBe("config.json.bak-20261030-140000-apply");
		for (const name of manual) expect(existsSync(join(home, name))).toBe(true);
	});
});

describe("runApply rollback and drain safety", () => {
	test("without a last-good config the failed apply leaves config.json alone and says so", async () => {
		const world = makeWorld();
		world.restartMakesFreshDaemon = false;
		world.onRestart = (n) => {
			if (n === 1) writeFileSync(join(home, "config.json"), '{"v":"bad"}');
		};
		const { receipt } = await runApply(base, makeDeps(world));
		expect(readFileSync(join(home, "config.json"), "utf8")).toBe('{"v":"bad"}');
		expect(receipt.steps.at(-1)?.detail).toContain("복원할 정상 config 없음");
	});

	test("a failed apply never records the failing config as last-good", async () => {
		const world = makeWorld();
		world.restartMakesFreshDaemon = false;
		await runApply(base, makeDeps(world));
		expect(existsSync(join(home, "config.json.last-good"))).toBe(false);
	});

	test("restart failing twice cancels the drain and records it", async () => {
		const world = makeWorld();
		world.restartRc = 1;
		const { receipt } = await runApply(base, makeDeps(world));
		expect(world.drainCancels).toBe(1);
		expect(receipt.steps.at(-1)?.detail).toContain("drain cancelled");
	});

	test("a drain that ends unreachable is cancelled, so the daemon is not left holding new turns", async () => {
		const world = makeWorld();
		world.drainResult = { ok: false, reason: "unreachable", error: "ipc timeout" };
		const { exitCode, receipt } = await runApply(base, makeDeps(world));
		expect(exitCode).toBe(1);
		expect(world.drainCancels).toBe(1);
		expect(receipt.steps.at(-1)).toMatchObject({ name: "drain", ok: false });
		expect(receipt.steps.at(-1)?.detail).toContain("drain cancelled");
	});

	test("a rollback that brings a fresh daemon back does not need a drain cancel", async () => {
		const world = makeWorld();
		world.restartMakesFreshDaemon = false;
		let n = 0;
		world.onRestart = () => {
			n += 1;
			if (n === 2) world.restartMakesFreshDaemon = true;
		};
		await runApply(base, makeDeps(world));
		expect(world.drainCancels).toBe(0);
	});

	test("an inactive ompbot unit (or no user bus) SKIPs before any change", async () => {
		const world = makeWorld();
		world.activeRc = 3;
		const { exitCode, receipt } = await runApply(base, makeDeps(world));
		expect(exitCode).toBe(3);
		expect(receipt.steps[0]?.detail).toContain("is-active");
		expect(world.backups).toBe(0);
	});
});

describe("runApply peers (other installs on the checkout)", () => {
	const peer = (exitCode: 0 | 1 | 3, status: PeerApply["status"]): PeerApply => ({
		unit: "ompbot-tteok",
		status,
		exitCode,
		receiptPath: "/t/logs/apply-x.json",
	});

	test("this install's own unit is the one restarted", async () => {
		const world = makeWorld();
		await runApply(base, makeDeps(world, { unit: "ompbot-tteok" }));
		expect(restartCommands(world)).toEqual([["systemctl", "--user", "restart", "ompbot-tteok"]]);
	});

	test("peers run after a fresh restart and after already_applied, but never after a SKIP or failure", async () => {
		let calls = 0;
		const peers = async () => {
			calls += 1;
			return [peer(0, "ok")];
		};
		const ok = await runApply(base, makeDeps(makeWorld(), { peers }));
		expect(ok.receipt.status).toBe("ok");
		expect(ok.receipt.steps.at(-1)).toMatchObject({ name: "peers", ok: true });
		expect(calls).toBe(1);

		const done = makeWorld();
		done.activeEnterUnix = `@${Math.floor((T0 + 60_000) / 1000)}`;
		const already = await runApply({ ...base, mergedAt: new Date(T0) }, makeDeps(done, { peers }));
		expect(already.receipt.status).toBe("already_applied");
		expect(calls).toBe(2);

		const skipped = makeWorld();
		skipped.branch = "other";
		await runApply(base, makeDeps(skipped, { peers }));
		const failed = makeWorld();
		failed.restartRc = 1;
		await runApply(base, makeDeps(failed, { peers }));
		expect(calls).toBe(2);
	});

	test("a peer that fails or is skipped makes the whole apply fail with exit 1", async () => {
		for (const result of [peer(1, "failed"), peer(3, "skipped")]) {
			const { exitCode, receipt } = await runApply(base, makeDeps(makeWorld(), { peers: async () => [result] }));
			expect(exitCode).toBe(1);
			expect(receipt.status).toBe("failed");
			expect(receipt.steps.at(-1)?.detail).toContain(`ompbot-tteok=${result.status}`);
		}
	});
});

describe("apply backup wiring (C-02)", () => {
	test("the CLI's real deps.backup() snapshots the db without a session bundle", () => {
		// No config.json: homeDeps would refuse the fixture's placeholder config, and the bundle needs only one source.
		rmSync(join(home, "config.json"));
		new Database(join(home, "ompbot.db")).close();
		mkdirSync(join(home, "sessions"));
		writeFileSync(join(home, "sessions", "s.jsonl"), "{}\n");

		const result = homeDeps(home, "ompbot", "/usr/bin").backup();

		expect(existsSync(result.file)).toBe(true);
		expect(result.bundle).toBeUndefined();
		expect(readdirSync(join(home, "backups")).filter((name) => name.startsWith("ompbot-bundle-"))).toEqual([]);
	});
});

describe("findDaemonUnits", () => {
	test("keeps active units running this checkout's daemon, with OMPBOT_HOME or the default home", async () => {
		const repoDir = "/w/ompbot";
		const run = async (cmd: string[]): Promise<RunResult> => {
			if (cmd[2] === "list-units")
				return {
					code: 0,
					stdout:
						"ompbot.service loaded active running x\nompbot-tteok.service loaded active running y\nompbot-dashboard.service loaded active running z\nompbot-backup.timer loaded active waiting t\n",
					stderr: "",
				};
			expect(cmd).not.toContain("ompbot-backup.timer");
			return {
				code: 0,
				stdout: [
					"ExecStart={ path=/b/bun ; argv[]=/b/bun /w/ompbot/src/main.ts daemon ; ignore_errors=no }",
					"Environment=PATH=/b",
					"Id=ompbot.service",
					"",
					"ExecStart={ path=/b/bun ; argv[]=/b/bun /w/ompbot/src/main.ts daemon ; ignore_errors=no }",
					"Environment=OMPBOT_HOME=/h/.ompbot-tteok PATH=/b",
					"Id=ompbot-tteok.service",
					"",
					"ExecStart={ path=/b/bun ; argv[]=/b/bun /w/ompbot/src/main.ts dashboard ; ignore_errors=no }",
					"Environment=PATH=/b",
					"Id=ompbot-dashboard.service",
				].join("\n"),
				stderr: "",
			};
		};
		expect(await findDaemonUnits(run, "/b", repoDir, "/h/.ompbot")).toEqual([
			{ unit: "ompbot", homeDir: "/h/.ompbot" },
			{ unit: "ompbot-tteok", homeDir: "/h/.ompbot-tteok" },
		]);
	});
});

describe("runApply dashboard step (dashboard-host-checks AC-8)", () => {
	const DAEMON_SINCE = Math.floor((T0 + 60_000) / 1000);
	/** One `systemctl show` block of a unit running `<repo>/src/main.ts <command>`. */
	const unitBlock = (id: string, command: string, homeDir: string | undefined, since: number): string =>
		[
			`ExecStart={ path=/b/bun ; argv[]=/b/bun ${repo}/src/main.ts ${command} ; ignore_errors=no }`,
			`Environment=PATH=/b${homeDir === undefined ? "" : ` OMPBOT_HOME=${homeDir}`}`,
			`ActiveEnterTimestamp=@${since}`,
			`Id=${id}.service`,
		].join("\n");
	/** The daemon of this home, plus the given pages, all active. */
	function withUnits(world: World, pages: Array<{ id: string; home: string | undefined; since: number }>): void {
		world.activeEnterUnix = `@${DAEMON_SINCE}`;
		world.listUnits = ["ompbot", ...pages.map((page) => page.id)]
			.map((id) => `${id}.service loaded active running x\n`)
			.join("");
		world.unitsShow = [
			unitBlock("ompbot", "daemon", home, DAEMON_SINCE),
			...pages.map((page) => unitBlock(page.id, "dashboard", page.home, page.since)),
		].join("\n\n");
	}
	const pageRestarts = (world: World): string[] =>
		restartCommands(world)
			.map((cmd) => cmd[3] ?? "")
			.filter((unit) => unit !== "ompbot");
	const dashboardStep = (receipt: ApplyReceipt) => receipt.steps.find((s) => s.name === "dashboard");
	const older = DAEMON_SINCE - 3600;

	test("ok and already_applied both restart this home's page that started before the daemon", async () => {
		const world = makeWorld();
		withUnits(world, [{ id: "ompbot-dashboard", home, since: older }]);
		const ok = await runApply(base, makeDeps(world));
		expect(ok.receipt.status).toBe("ok");
		expect(ok.receipt.steps.at(-1)).toMatchObject({
			name: "dashboard",
			ok: true,
			detail: "restarted ompbot-dashboard",
		});
		expect(pageRestarts(world)).toEqual(["ompbot-dashboard"]);

		const again = makeWorld();
		withUnits(again, [{ id: "ompbot-dashboard", home, since: older }]);
		const { exitCode, receipt } = await runApply({ ...base, mergedAt: new Date(T0) }, makeDeps(again));
		expect(exitCode).toBe(0);
		expect(receipt.status).toBe("already_applied");
		expect(receipt.steps.map((s) => s.name)).toEqual(["preflight", "dashboard"]);
		expect(dashboardStep(receipt)?.detail).toBe("restarted ompbot-dashboard");
		expect(pageRestarts(again)).toEqual(["ompbot-dashboard"]);
		expect(again.backups).toBe(0);
	});

	test("another home's page, an inactive page and a page newer than the daemon are left alone", async () => {
		const world = makeWorld();
		withUnits(world, [
			{ id: "ompbot-dashboard", home: undefined, since: older },
			{ id: "ompbot-dashboard-tteok", home: join(root, "other-home"), since: older },
			{ id: "ompbot-dashboard-new", home, since: DAEMON_SINCE + 10 },
		]);
		// An inactive page is not in `list-units --state=active`; its block alone does not make it a target.
		world.unitsShow += `\n\n${unitBlock("ompbot-dashboard-idle", "dashboard", home, older)}`;
		const { exitCode, receipt } = await runApply({ ...base, mergedAt: new Date(T0) }, makeDeps(world));
		expect(exitCode).toBe(0);
		expect(dashboardStep(receipt)?.detail).toBe("skipped: dashboard newer (ompbot-dashboard-new)");
		expect(pageRestarts(world)).toEqual([]);
		const listed = world.commands.find((cmd) => cmd[2] === "show" && cmd.includes("Id"));
		expect(listed).not.toContain("ompbot-dashboard-idle.service");

		const none = makeWorld();
		withUnits(none, []);
		const alone = await runApply(base, makeDeps(none));
		expect(dashboardStep(alone.receipt)?.detail).toBe("skipped: no active dashboard unit of this home");
	});

	test("a failed restart or listing is only the step's detail: status and exit code stay", async () => {
		const world = makeWorld();
		withUnits(world, [{ id: "ompbot-dashboard", home, since: older }]);
		world.dashboardRestartRc = 1;
		const ok = await runApply(base, makeDeps(world));
		expect(ok.exitCode).toBe(0);
		expect(ok.receipt.status).toBe("ok");
		expect(dashboardStep(ok.receipt)).toMatchObject({ ok: true });
		expect(dashboardStep(ok.receipt)?.detail).toStartWith("failed: systemctl restart ompbot-dashboard rc=1");
		expect(readReceipt(ok.receipt).status).toBe("ok");

		const broken = makeWorld();
		broken.activeEnterUnix = `@${DAEMON_SINCE}`;
		const deps = makeDeps(broken);
		const run = deps.run;
		deps.run = async (cmd, opts) =>
			cmd[2] === "list-units" ? { code: 1, stdout: "", stderr: "Failed to connect to bus" } : run(cmd, opts);
		const already = await runApply({ ...base, mergedAt: new Date(T0) }, deps);
		expect(already.exitCode).toBe(0);
		expect(already.receipt.status).toBe("already_applied");
		expect(dashboardStep(already.receipt)).toMatchObject({ ok: true });
		expect(dashboardStep(already.receipt)?.detail).toStartWith("failed: systemctl list-units rc=1");
	});
});

describe("revertCommandFor", () => {
	test("restores the previous tree in a real repository whose history contains a merge commit", () => {
		const r = join(root, "revrepo");
		mkdirSync(r);
		const sh = (cmd: string) => {
			const out = Bun.spawnSync(["sh", "-c", cmd], {
				cwd: r,
				env: {
					...process.env,
					GIT_AUTHOR_NAME: "t",
					GIT_AUTHOR_EMAIL: "t@t",
					GIT_COMMITTER_NAME: "t",
					GIT_COMMITTER_EMAIL: "t@t",
				},
			});
			if (out.exitCode !== 0) throw new Error(`${cmd}: ${out.stderr.toString()}`);
			return out.stdout.toString().trim();
		};
		sh("git init -q -b main && echo a > a && git add a && git commit -qm base");
		const prev = sh("git rev-parse HEAD");
		sh(
			"git checkout -q -b side && echo b > b && git add b && git commit -qm side && git checkout -q main && echo c > c && git add c && git commit -qm main-c && git merge -q --no-ff side -m merge",
		);
		sh("echo local-edit >> a && echo scratch > untracked.txt");
		sh(revertCommandFor(r, prev));
		expect(sh("git ls-tree -r --name-only HEAD")).toBe("a");
		expect(sh("git show HEAD --stat --format=")).not.toContain("untracked.txt");
		// unrelated local work survives and is not swept into the revert commit
		expect(sh("cat a")).toBe("a\nlocal-edit");
		expect(sh("cat untracked.txt")).toBe("scratch");
		expect(sh("git show HEAD:a")).toBe("a");
		// a staged change would ride along in the revert commit: the command refuses and leaves HEAD alone
		sh("echo d > d && git add d && git commit -qm d");
		const head = sh("git rev-parse HEAD");
		sh("echo staged > staged.txt && git add staged.txt");
		expect(() => sh(revertCommandFor(r, prev))).toThrow();
		expect(sh("git rev-parse HEAD")).toBe(head);
	});
});

describe("runApply report", () => {
	const report: ApplyOptions = { ...base, reportOrigin: "slack/ch/C0123456789", reportThread: "1793318305.840629" };

	test("success, failure and SKIP all inject a follow-up into the requested thread with the receipt path", async () => {
		const ok = makeWorld();
		const okOutcome = await runApply(report, makeDeps(ok));
		const skip = makeWorld();
		skip.branch = "other";
		const skipOutcome = await runApply(report, makeDeps(skip));
		const fail = makeWorld();
		fail.drainResult = { ok: false, reason: "unreachable", error: "ENOENT" };
		const failOutcome = await runApply(report, makeDeps(fail));
		for (const [world, outcome, status] of [
			[ok, okOutcome, "ok"],
			[skip, skipOutcome, "skipped"],
			[fail, failOutcome, "failed"],
		] as const) {
			expect(world.injects).toHaveLength(1);
			const request = world.injects[0] as { origin: string; thread: string; asOwner: boolean; text: string };
			expect(request).toMatchObject({ origin: "slack/ch/C0123456789", thread: "1793318305.840629", asOwner: true });
			expect(request.text).toContain("[자동 후속] apply 결과");
			expect(request.text).toContain(status);
			expect(request.text).toContain(outcome.receipt.receiptPath);
			expect(readReceipt(outcome.receipt).report).toMatchObject({ ok: true });
		}
	});

	test("an inject that fails is recorded in the receipt and does not change the exit code", async () => {
		const world = makeWorld();
		world.injectError = true;
		const { exitCode, receipt } = await runApply(report, makeDeps(world));
		expect(exitCode).toBe(0);
		expect(readReceipt(receipt).report).toMatchObject({ ok: false });
		expect(readReceipt(receipt).report?.detail).toContain("socket gone");
	});

	test("no --report-origin means no inject", async () => {
		const world = makeWorld();
		await runApply(base, makeDeps(world));
		expect(world.injects).toHaveLength(0);
		expect(existsSync(join(home, "logs", "apply-20261030-140000.json"))).toBe(true);
	});

	test("AC-4: reportPlain posts one notify line (status, head, failed step) and never injects a model turn", async () => {
		const plain: ApplyOptions = { ...report, reportPlain: true };
		const ok = makeWorld();
		const okOutcome = await runApply(plain, makeDeps(ok));
		const fail = makeWorld();
		fail.drainResult = { ok: false, reason: "unreachable", error: "ENOENT" };
		const failOutcome = await runApply(plain, makeDeps(fail));
		const skip = makeWorld();
		skip.branch = "other";
		const skipOutcome = await runApply(plain, makeDeps(skip));
		for (const [world, outcome] of [
			[ok, okOutcome],
			[fail, failOutcome],
			[skip, skipOutcome],
		] as const) {
			expect(world.injects).toHaveLength(0);
			expect(world.notifies).toHaveLength(1);
			expect(world.notifies[0]).toMatchObject({
				op: "notify",
				origin: "slack/ch/C0123456789",
				thread: "1793318305.840629",
			});
			expect((world.notifies[0] as { text: string }).text).toEndWith(`영수증 ${outcome.receipt.receiptPath}`);
			expect(readReceipt(outcome.receipt).report).toMatchObject({ ok: true, detail: "notified attempts=1" });
		}
		const text = (world: World) => (world.notifies[0] as { text: string }).text;
		// The fake gates have origin_silent open: the line says so instead of "이상 없음".
		expect(text(ok)).toStartWith(`✅ 재시작 완료 · ${HEAD.slice(0, 7)} · gates 열림 1/2 (origin_silent(1 pending))`);
		expect(text(fail)).toStartWith(`⚠️ 재시작 failed · ${HEAD.slice(0, 7)} · drain:`);
		expect(text(skip)).toContain("⚠️ 재시작 skipped · ");
		expect(text(skip)).toContain('preflight: checkout is on branch "other", not main');
		expect(text(ok)).not.toContain("[자동 후속]");
	});

	test("AC-4: reportPlain with every gate closed says 이상 없음; a secret in a step detail is redacted", async () => {
		const world = makeWorld();
		await runApply({ ...report, reportPlain: true }, makeDeps(world, { gates: () => [] }));
		expect((world.notifies[0] as { text: string }).text).toStartWith(
			`✅ 재시작 완료 · ${HEAD.slice(0, 7)} · gates 이상 없음`,
		);
		const leaky = makeWorld();
		leaky.drainResult = { ok: false, reason: "unreachable", error: "token xoxb-TEST-0abcdef" };
		await runApply({ ...report, reportPlain: true }, makeDeps(leaky));
		expect((leaky.notifies[0] as { text: string }).text).not.toContain("xoxb-TEST");
	});
});

describe("detachedApplyCommand (apply --detach and !restart)", () => {
	test("AC-3: the unit name carries a random suffix after the stamp; the child runs apply with the given args", () => {
		const input = {
			bun: "/h/.bun/bin/bun",
			repoDir: "/r",
			pathEnv: "/h/.bun/bin:/usr/bin",
			stamp: "20261114-191500",
			childArgs: ["apply", "--stamp", "20261114-191500", "--report-plain"],
		};
		const a = detachedApplyCommand(input);
		const b = detachedApplyCommand({ ...input, homeEnv: "/h/.ompbot-x" });
		expect(a.unit).toMatch(/^ompbot-apply-20261114-191500-[0-9a-f]{4}$/);
		expect(b.unit).not.toBe(a.unit);
		expect(a.argv).toEqual([
			"systemd-run",
			"--user",
			"--collect",
			`--unit=${a.unit}`,
			"--working-directory=/r",
			"--setenv=PATH=/h/.bun/bin:/usr/bin",
			"/h/.bun/bin/bun",
			"/r/src/main.ts",
			"apply",
			"--stamp",
			"20261114-191500",
			"--report-plain",
		]);
		expect(b.argv).toContain("--setenv=OMPBOT_HOME=/h/.ompbot-x");
	});

	test("--report-plain without --report-origin is a usage error", async () => {
		expect(await applyCommand(["--report-plain"], home)).toBe(2);
	});
});

describe("runApply apply lock (one apply per home)", () => {
	const SECOND = "20261030-140100";
	const OTHER = "20261030-130000";
	const lockPath = () => join(home, "apply.lock");
	const okPeer: PeerApply = { unit: "ompbot-tteok", status: "ok", exitCode: 0, receiptPath: "/t/logs/apply-x.json" };

	/**
	 * Starts a first apply whose drain is held on a promise, then a second one on the same home whose every poll
	 * sleep waits for the first to finish. Resolves once the second has reported that it is waiting.
	 */
	async function overlap(input: {
		first: World;
		second: World;
		peers: () => Promise<PeerApply[]>;
		firstOver?: Partial<ApplyDeps>;
	}) {
		const drainHeld = Promise.withResolvers<void>();
		const firstDeps = makeDeps(input.first, {
			peers: input.peers,
			drain: async () => {
				input.first.drains += 1;
				await drainHeld.promise;
				return input.first.drainResult;
			},
			...input.firstOver,
		});
		const first = runApply(base, firstDeps);
		const waiting = Promise.withResolvers<void>();
		const second = runApply(
			{ ...base, stamp: SECOND },
			makeDeps(input.second, {
				peers: input.peers,
				log: (line) => {
					if (line.includes("wait_apply waiting for apply 20261030-140000")) waiting.resolve();
				},
				sleep: async (ms) => {
					input.second.clock += ms;
					await first.catch(() => undefined);
				},
			}),
		);
		await waiting.promise;
		return { first, second, firstDeps, release: () => drainHeld.resolve() };
	}

	test("a second apply waits without drain or restart, then ends already_applied by the first (one restart, one peer run)", async () => {
		const firstWorld = makeWorld();
		const secondWorld = makeWorld();
		let peerCalls = 0;
		const peers = async () => {
			peerCalls += 1;
			return [okPeer];
		};
		const run = await overlap({ first: firstWorld, second: secondWorld, peers });
		// while waiting: nothing of the second apply has touched the daemon, and the first still holds the lock
		expect(secondWorld.drains).toBe(0);
		expect(restartCommands(secondWorld)).toHaveLength(0);
		expect(secondWorld.commands).toHaveLength(0);
		expect(parseApplyLock(readFileSync(lockPath(), "utf8"))).toMatchObject({
			pid: run.firstDeps.pid,
			stamp: base.stamp,
		});
		run.release();
		const [a, b] = await Promise.all([run.first, run.second]);
		expect(a.receipt.status).toBe("ok");
		expect(b.exitCode).toBe(0);
		expect(b.receipt.status).toBe("already_applied");
		expect(b.receipt.steps.map((s) => [s.name, s.ok])).toEqual([
			["wait_apply", true],
			["preflight", true],
			["prior_apply", true],
		]);
		expect(b.receipt.steps[0]?.detail).toContain("waited for apply 20261030-140000");
		expect(b.receipt.steps[2]?.detail).toBe("applied by apply-20261030-140000");
		expect(restartCommands(firstWorld).length + restartCommands(secondWorld).length).toBe(1);
		expect(peerCalls).toBe(1);
		expect(secondWorld.drains).toBe(0);
		expect(secondWorld.backups).toBe(0);
		expect(existsSync(lockPath())).toBe(false);
	});

	test("a first apply that failed (drain, ready/rollback, a peer) makes the second run the full apply from backup", async () => {
		const failures: Array<{ name: string; setup: (first: World) => void; peerFails: boolean }> = [
			{
				name: "drain",
				setup: (w) => {
					w.drainResult = { ok: false, reason: "timeout", counts: { turns: 1, hostTools: 0, approvals: 0 } };
				},
				peerFails: false,
			},
			{
				name: "ready",
				setup: (w) => {
					w.restartMakesFreshDaemon = false;
				},
				peerFails: false,
			},
			{ name: "peers", setup: () => {}, peerFails: true },
		];
		for (const failure of failures) {
			rmSync(join(home, "logs"), { recursive: true, force: true });
			const firstWorld = makeWorld();
			failure.setup(firstWorld);
			const secondWorld = makeWorld();
			let peerCalls = 0;
			const peers = async () => {
				peerCalls += 1;
				return peerCalls === 1 && failure.peerFails
					? [{ ...okPeer, status: "failed" as const, exitCode: 1 as const }]
					: [okPeer];
			};
			const run = await overlap({ first: firstWorld, second: secondWorld, peers });
			run.release();
			const [a, b] = await Promise.all([run.first, run.second]);
			expect(a.receipt.status).toBe("failed");
			expect(b.receipt.status).toBe("ok");
			const prior = b.receipt.steps.find((s) => s.name === "prior_apply");
			expect(prior?.detail).toContain("status=failed");
			expect(b.receipt.steps.map((s) => s.name)).toContain("backup");
			expect(secondWorld.backups).toBe(1);
			expect(secondWorld.drains).toBe(1);
			expect(restartCommands(secondWorld)).toHaveLength(1);
			if (failure.peerFails) {
				// the first restarted and ran the peers once; the second does both again
				expect(restartCommands(firstWorld).length + restartCommands(secondWorld).length).toBe(2);
				expect(peerCalls).toBe(2);
			} else expect(peerCalls).toBe(1);
			expect(existsSync(lockPath())).toBe(false);
		}
	});

	test("a first apply that ended ok on another HEAD does not cover the second: full apply", async () => {
		const firstWorld = makeWorld();
		const secondWorld = makeWorld();
		secondWorld.headSha = "c".repeat(40);
		secondWorld.mainSha = secondWorld.headSha;
		let peerCalls = 0;
		const peers = async () => {
			peerCalls += 1;
			return [okPeer];
		};
		const run = await overlap({ first: firstWorld, second: secondWorld, peers });
		run.release();
		const [a, b] = await Promise.all([run.first, run.second]);
		expect(a.receipt.status).toBe("ok");
		expect(b.receipt.status).toBe("ok");
		expect(b.receipt.steps.find((s) => s.name === "prior_apply")?.detail).toContain("is not HEAD");
		expect(restartCommands(firstWorld).length + restartCommands(secondWorld).length).toBe(2);
		expect(peerCalls).toBe(2);
	});

	test("a lock of a dead pid or broken JSON is taken over without waiting and the apply runs", async () => {
		for (const [text, named] of [
			[`${JSON.stringify({ pid: 999, stamp: OTHER, startedAt: new Date(T0).toISOString() })}\n`, OTHER],
			['{"pid": 12', "(unreadable)"],
			["", "(unreadable)"],
		] as const) {
			writeFileSync(lockPath(), text, { mode: 0o600 });
			const world = makeWorld();
			const { exitCode, receipt } = await runApply(base, makeDeps(world, { isAlive: (pid) => pid !== 999 }));
			expect(exitCode).toBe(0);
			expect(receipt.steps[0]).toMatchObject({
				name: "wait_apply",
				ok: true,
				detail: `stale lock ${named} taken over`,
			});
			expect(receipt.steps.map((s) => s.name)).not.toContain("prior_apply");
			expect(world.clock).toBe(T0); // never slept
			expect(restartCommands(world)).toHaveLength(1);
			expect(existsSync(lockPath())).toBe(false);
			expect(readdirSync(home).filter((name) => name.startsWith("apply.lock"))).toEqual([]);
		}
	});

	test("two reclaimers of the same stale lock: exactly one owns the lock, the other puts the new lock back", () => {
		const stale = `${JSON.stringify({ pid: 999, stamp: OTHER, startedAt: "x" })}\n`;
		writeFileSync(lockPath(), stale, { mode: 0o600 });
		const a = { pid: 101, stamp: base.stamp ?? "", startedAt: "a" };
		const b = { pid: 202, stamp: SECOND, startedAt: "b" };
		// both read the same stale lock; A renames it first and locks, then B's rename moves A's new lock
		expect(reclaimStaleApplyLock(lockPath(), stale, a.pid).outcome).toBe("taken");
		expect(createApplyLock(lockPath(), a)).toBe(true);
		expect(reclaimStaleApplyLock(lockPath(), stale, b.pid).outcome).toBe("changed");
		expect(createApplyLock(lockPath(), b)).toBe(false);
		expect(parseApplyLock(readFileSync(lockPath(), "utf8"))).toEqual(a);
		expect(readdirSync(home).filter((name) => name.startsWith("apply.lock"))).toEqual(["apply.lock"]);
		// B never removes A's lock; A removes its own
		expect(releaseApplyLock(lockPath(), b)).toBe(false);
		expect(parseApplyLock(readFileSync(lockPath(), "utf8"))).toEqual(a);
		expect(releaseApplyLock(lockPath(), a)).toBe(true);
		// the lock vanished before B's rename: nothing to reclaim, B tries again
		expect(reclaimStaleApplyLock(lockPath(), stale, b.pid).outcome).toBe("changed");
	});

	test("the lock is a complete 0600 JSON from the moment it exists", async () => {
		const world = makeWorld();
		const seen: unknown[] = [];
		const deps = makeDeps(world, {
			log: (line) => {
				if (line.startsWith("apply lock taken")) {
					seen.push(parseApplyLock(readFileSync(lockPath(), "utf8")));
					seen.push(statSync(lockPath()).mode & 0o777);
				}
			},
		});
		await runApply(base, deps);
		expect(seen).toEqual([{ pid: deps.pid, stamp: base.stamp, startedAt: new Date(T0).toISOString() }, 0o600]);
		const direct = { pid: 7, stamp: OTHER, startedAt: "s" };
		expect(createApplyLock(lockPath(), direct)).toBe(true);
		expect(parseApplyLock(readFileSync(lockPath(), "utf8"))).toEqual(direct);
	});

	test("a live lock past the limit fails with no drain and leaves the other lock as it was", async () => {
		const text = `${JSON.stringify({ pid: 777, stamp: OTHER, startedAt: new Date(T0).toISOString() })}\n`;
		writeFileSync(lockPath(), text, { mode: 0o600 });
		const world = makeWorld();
		const { exitCode, receipt } = await runApply(base, makeDeps(world));
		expect(exitCode).toBe(1);
		expect(receipt.status).toBe("failed");
		expect(receipt.steps).toHaveLength(1);
		expect(receipt.steps[0]).toMatchObject({ name: "wait_apply", ok: false });
		expect(receipt.steps[0]?.detail).toBe(`apply ${OTHER} still running after 7 min`);
		expect(world.drains).toBe(0);
		expect(world.commands).toHaveLength(0);
		expect(world.clock - T0).toBeGreaterThanOrEqual(7 * 60_000);
		expect(readFileSync(lockPath(), "utf8")).toBe(text);
	});

	test("a lock this very apply holds (same pid and stamp) fails at once instead of waiting on itself", async () => {
		const world = makeWorld();
		const deps = makeDeps(world);
		const text = `${JSON.stringify({ pid: deps.pid, stamp: base.stamp, startedAt: "s" })}\n`;
		writeFileSync(lockPath(), text, { mode: 0o600 });
		const { receipt } = await runApply(base, deps);
		expect(receipt.steps[0]?.detail).toContain("held by this apply");
		expect(world.clock).toBe(T0);
		expect(readFileSync(lockPath(), "utf8")).toBe(text);
	});

	test("ok, failed, SKIP and a thrown apply all remove their own lock, only after the receipt carries the report", async () => {
		const report: ApplyOptions = { ...base, reportOrigin: "slack/ch/C0123456789", reportThread: "1793318305.840629" };
		const cases: Array<[ApplyReceipt["status"], (w: World) => void]> = [
			["ok", () => {}],
			[
				"failed",
				(w) => {
					w.drainResult = { ok: false, reason: "timeout", counts: { turns: 0, hostTools: 0, approvals: 0 } };
				},
			],
			[
				"skipped",
				(w) => {
					w.branch = "other";
				},
			],
		];
		for (const [status, setup] of cases) {
			const world = makeWorld();
			setup(world);
			const atRelease: Array<ApplyReceipt["report"] | boolean> = [];
			const receiptFile = join(home, "logs", `apply-${base.stamp}.json`);
			const { receipt } = await runApply(
				report,
				makeDeps(world, {
					log: (line) => {
						if (line.startsWith("apply lock released")) {
							atRelease.push(existsSync(lockPath()));
							atRelease.push((JSON.parse(readFileSync(receiptFile, "utf8")) as ApplyReceipt).report);
						}
					},
				}),
			);
			expect(receipt.status).toBe(status);
			expect(atRelease[0]).toBe(false);
			expect(atRelease[1]).toMatchObject({ ok: true, detail: "injected attempts=1" });
			expect(existsSync(lockPath())).toBe(false);
		}
		const world = makeWorld();
		const thrown = runApply(
			base,
			makeDeps(world, {
				log: (line) => {
					if (line.startsWith("apply step=drain")) throw new Error("log sink broke");
				},
			}),
		);
		await expect(thrown).rejects.toThrow("log sink broke");
		expect(existsSync(lockPath())).toBe(false);
	});
});

describe("runApply report inject retry", () => {
	const report: ApplyOptions = { ...base, reportOrigin: "slack/ch/C0123456789", reportThread: "1793318305.840629" };

	test("two refused connections then a delivery: report ok on attempt 3, 5 s apart", async () => {
		const world = makeWorld();
		world.injectConnectFailures = 2;
		const { exitCode, receipt } = await runApply(report, makeDeps(world));
		expect(exitCode).toBe(0);
		expect(world.injects).toHaveLength(3);
		expect(world.clock - T0).toBe(10_000);
		expect(readReceipt(receipt).report).toMatchObject({ ok: true, detail: "injected attempts=3" });
	});

	test("an answered ok:false refusal is asked once", async () => {
		const world = makeWorld();
		world.injectResponse = { ok: false, error: "origin_unknown" };
		const { exitCode, receipt } = await runApply(report, makeDeps(world));
		expect(exitCode).toBe(0);
		expect(world.injects).toHaveLength(1);
		expect(readReceipt(receipt).report).toMatchObject({ ok: false });
		expect(readReceipt(receipt).report?.detail).toContain("inject refused attempts=1");
	});

	test("six refused connections give up: report ok=false, exit code unchanged", async () => {
		for (const drainOk of [true, false]) {
			const world = makeWorld();
			if (!drainOk) world.drainResult = { ok: false, reason: "unreachable", error: "x" };
			world.injectConnectFailures = 99;
			const { exitCode, receipt } = await runApply(report, makeDeps(world));
			expect(world.injects).toHaveLength(6);
			expect(readReceipt(receipt).report).toMatchObject({ ok: false });
			expect(readReceipt(receipt).report?.detail).toBe("inject failed attempts=6: Failed to connect");
			expect(exitCode).toBe(drainOk ? 0 : 1); // the same exit as an apply without a report
		}
	});
});

// T-20261112-36 AC-2: the apply report also goes to a Discord DM or channel, with a Discord message id as its thread.
describe("apply report origin on Discord", () => {
	const DM = "123456789012345678"; // gitleaks:allow (fake snowflake)
	const CH = "111111111111111111"; // gitleaks:allow (fake snowflake)
	const MESSAGE = "700000000000000001"; // gitleaks:allow (fake snowflake)

	test("isReportOrigin takes Slack and Discord DM/channel origins, never a thread origin", () => {
		expect(isReportOrigin(`discord/dm/${DM}`)).toBe(true);
		expect(isReportOrigin(`discord/ch/${CH}`)).toBe(true);
		expect(isReportOrigin(`discord/ch/${CH}/t/222222222222222222`)).toBe(false);
		expect(isReportOrigin("slack/ch/C0123456789")).toBe(true);
		expect(isReportOrigin("slack/dm/D0123456789")).toBe(true);
		expect(isReportOrigin("slack/ch/C1/t/100.1")).toBe(false);
		expect(isReportOrigin("telegram/dm/1")).toBe(false);
	});

	test("the report thread is a snowflake for a Discord origin and a ts for a Slack one", () => {
		expect(reportThreadPattern(`discord/dm/${DM}`).test(MESSAGE)).toBe(true);
		expect(reportThreadPattern(`discord/dm/${DM}`).test("1793318305.840629")).toBe(false);
		expect(reportThreadPattern("slack/ch/C0123456789").test("1793318305.840629")).toBe(true);
		expect(reportThreadPattern("slack/ch/C0123456789").test(MESSAGE)).toBe(false);
	});

	test("the CLI refuses a thread of the other platform's form with a usage error naming both forms", async () => {
		const written: string[] = [];
		const write = process.stderr.write;
		process.stderr.write = ((chunk: string) => {
			written.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			const home = mkdtempSync(join(tmpdir(), "ompbot-apply-cli-"));
			const codes = [
				await applyCommand(["--report-origin", `discord/dm/${DM}`, "--report-thread", "1793318305.840629"], home),
				await applyCommand(["--report-origin", "slack/ch/C0123456789", "--report-thread", MESSAGE], home),
				await applyCommand(["--report-origin", `discord/ch/${CH}/t/${MESSAGE}`], home),
			];
			rmSync(home, { recursive: true, force: true });
			expect(codes).toEqual([2, 2, 2]);
		} finally {
			process.stderr.write = write;
		}
		const text = written.join("");
		expect(text).toContain(
			"--report-origin must be slack/ch/<channel id>, slack/dm/<dm id>, discord/ch/<channel id> or discord/dm/<dm id>",
		);
		expect(text).toContain(
			"--report-thread needs --report-origin and a Slack ts like 1793318305.840629 (slack/...) or a Discord message id (discord/...)",
		);
	});

	test("APPLY_USAGE and docs/guide.md show the Discord report form", () => {
		expect(APPLY_USAGE).toContain("--report-origin <slack/ch/C|slack/dm/D|discord/ch/<id>|discord/dm/<id>>");
		const guide = readFileSync(join(import.meta.dir, "..", "docs", "guide.md"), "utf8");
		expect(guide).toContain("--report-origin discord/dm/<DM ID> --report-thread <메시지 ID>");
	});

	test("the report inject carries the Discord origin and thread as given", async () => {
		const world = makeWorld();
		await runApply({ ...base, reportOrigin: `discord/dm/${DM}`, reportThread: MESSAGE }, makeDeps(world));
		expect(world.injects).toHaveLength(1);
		expect(world.injects[0]).toMatchObject({ origin: `discord/dm/${DM}`, thread: MESSAGE, asOwner: true });
	});
});

describe("runApply drain cut (--cut-after)", () => {
	const BUSY = { ok: true as const, draining: true, turns: 1, hostTools: 0, approvals: 1 };

	/** The real drain wait against a daemon that never goes idle, on the world's clock. */
	function busyDrain(world: World): Partial<ApplyDeps> {
		return {
			drain: (timeoutMin, cutAfterMin) => {
				world.drains += 1;
				return waitForDrain({
					call: async (op) => {
						if (op === "drain_cancel") {
							world.drainCancels += 1;
							return { ...BUSY, draining: false };
						}
						return BUSY;
					},
					timeoutMin,
					...(cutAfterMin === undefined ? {} : { cutAfterMin }),
					now: () => world.clock,
					sleep: async (ms) => {
						world.clock += ms;
					},
				});
			},
		};
	}

	test("--cut-after 1 with a turn left: drain ok with cut=true, one drain_cut, the restart goes ahead, the record is removed", async () => {
		const world = makeWorld();
		let recordAtRestart = false;
		world.onRestart = () => {
			recordAtRestart = existsSync(join(home, RESTART_CUT_FILE));
		};
		const { exitCode, receipt } = await runApply({ ...base, cutAfterMin: 1 }, makeDeps(world, busyDrain(world)));
		expect(exitCode).toBe(0);
		const drain = readReceipt(receipt).steps.find((s) => s.name === "drain");
		expect(drain).toMatchObject({ ok: true, detail: "cut=true turns=1 hostTools=0 approvals=1" });
		expect(world.drainCuts).toEqual([{ op: "drain_cut", applyStamp: base.stamp }]);
		expect(world.drainCancels).toBe(0);
		expect(restartCommands(world)).toHaveLength(1);
		expect(recordAtRestart).toBe(true);
		expect(existsSync(join(home, RESTART_CUT_FILE))).toBe(false);
		// The cut comes at its limit, not at the drain timeout.
		expect(drain?.ms).toBe(60_000);
	});

	test("--cut-after 0 keeps the old behaviour: the timeout cancels the drain and nothing restarts", async () => {
		const world = makeWorld();
		const { exitCode, receipt } = await runApply({ ...base, cutAfterMin: 0 }, makeDeps(world, busyDrain(world)));
		expect(exitCode).toBe(1);
		expect(receipt.steps.at(-1)).toMatchObject({
			name: "drain",
			ok: false,
			detail: "timeout after 5 min (drain cancelled)",
		});
		expect(world.drainCuts).toEqual([]);
		expect(world.drainCancels).toBe(1);
		expect(restartCommands(world)).toHaveLength(0);
	});

	test("a drain_cut the daemon does not confirm ends like a timeout: drain cancelled, no restart", async () => {
		const world = makeWorld();
		world.drainCutResponse = { ok: false, error: "EISDIR" };
		const { exitCode, receipt } = await runApply({ ...base, cutAfterMin: 1 }, makeDeps(world, busyDrain(world)));
		expect(exitCode).toBe(1);
		const drain = receipt.steps.at(-1);
		expect(drain).toMatchObject({ name: "drain", ok: false });
		expect(drain?.detail).toContain("drain_cut refused");
		expect(drain?.detail).toContain("drain cancelled");
		expect(world.drainCancels).toBe(1);
		expect(restartCommands(world)).toHaveLength(0);
	});

	test("a rollback restart still sees the record; the failed apply removes it at its end (AC-8)", async () => {
		const world = makeWorld();
		world.restartMakesFreshDaemon = false;
		const seen: boolean[] = [];
		world.onRestart = (n) => {
			seen.push(existsSync(join(home, RESTART_CUT_FILE)));
			if (n === 2) world.restartMakesFreshDaemon = true;
		};
		const { exitCode, receipt } = await runApply({ ...base, cutAfterMin: 1 }, makeDeps(world, busyDrain(world)));
		expect(exitCode).toBe(1);
		expect(receipt.steps.map((s) => [s.name, s.ok])).toEqual([
			["preflight", true],
			["backup", true],
			["drain", true],
			["restart", true],
			["ready", false],
			["rollback", true],
		]);
		expect(seen).toEqual([true, true]);
		expect(existsSync(join(home, RESTART_CUT_FILE))).toBe(false);
	});

	test("an apply that did not cut leaves a record it did not write alone", async () => {
		const world = makeWorld();
		writeFileSync(join(home, RESTART_CUT_FILE), "{}");
		expect((await runApply(base, makeDeps(world))).exitCode).toBe(0);
		expect(existsSync(join(home, RESTART_CUT_FILE))).toBe(true);
	});

	test("the CLI rejects a --cut-after that is not a number of minutes", async () => {
		expect(await applyCommand(["--cut-after", "five"], home)).toBe(2);
		expect(APPLY_USAGE).toContain("--cut-after <min>");
	});
});

// T-20261113-08: head.last-good (AC-1), the code rollback after a failed config rollback (AC-2..AC-4), autoland.hold (AC-5).
describe("runApply head.last-good (AC-1)", () => {
	const healthy = (): Partial<ApplyDeps> => ({
		gates: () => [{ name: "origin_silent", state: "open", detail: "1 pending" }],
		doctor: async () => ({ code: 0, lines: ["ok home: x"] }),
	});
	const headFile = () => join(home, "head.last-good");

	test("a verified apply records receipt.head atomically as 0600 and removes autoland.hold", async () => {
		writeFileSync(join(home, "autoland.hold"), '{"reason":"x","at":"y"}', { mode: 0o600 });
		const { exitCode, receipt } = await runApply(base, makeDeps(makeWorld(), healthy()));
		expect(exitCode).toBe(0);
		expect(readFileSync(headFile(), "utf8").trim()).toBe(HEAD);
		expect(statSync(headFile()).mode & 0o777).toBe(0o600);
		expect(readdirSync(home).filter((name) => name.startsWith("head.last-good.tmp"))).toEqual([]);
		expect(existsSync(join(home, "autoland.hold"))).toBe(false);
		expect(receipt.steps.find((s) => s.name === "last_good")?.detail).toContain("head.last-good");
	});

	test("the head recorded is the commit the restart loaded, not the preflight HEAD", async () => {
		const world = makeWorld();
		const moved = "c".repeat(40);
		const deps = makeDeps(world, healthy());
		await runApply(base, {
			...deps,
			drain: async (timeoutMin) => {
				const result = await deps.drain(timeoutMin);
				world.headSha = moved;
				world.mainSha = moved;
				return result;
			},
		});
		expect(readFileSync(headFile(), "utf8").trim()).toBe(moved);
	});

	test.each<[string, Partial<ApplyDeps>]>([
		["doctor rc=1", { doctor: async () => ({ code: 1, lines: ["fail omp: missing"] }) }],
		["omp_runtime open", { gates: () => [{ name: "omp_runtime", state: "open", detail: "bun=missing" }] }],
		["turns_failing open", { gates: () => [{ name: "turns_failing", state: "open", detail: "recent=5" }] }],
	])("%s: the apply is ok but head.last-good is not written", async (_name, over) => {
		writeFileSync(headFile(), `${PREV}\n`, { mode: 0o600 });
		const { exitCode, receipt } = await runApply(base, makeDeps(makeWorld(), { ...healthy(), ...over }));
		expect(exitCode).toBe(0);
		expect(readFileSync(headFile(), "utf8").trim()).toBe(PREV);
		expect(receipt.steps.find((s) => s.name === "last_good")?.detail).toContain("head.last-good not recorded");
	});

	test("a failed apply never writes it; the receipt carries lastGoodHead and builds the revert from it", async () => {
		const good = "d".repeat(40);
		writeFileSync(headFile(), `${good}\n`, { mode: 0o600 });
		const world = makeWorld();
		world.restartRc = 1;
		const { receipt } = await runApply(base, makeDeps(world, healthy()));
		expect(readFileSync(headFile(), "utf8").trim()).toBe(good);
		expect(receipt.lastGoodHead).toBe(good);
		expect(receipt.previousHead).toBe(good);
		expect(receipt.revertCommand).toContain(`read-tree -m -u HEAD ${good}`);
	});
});

describe("runApply code rollback in a real git repository (AC-2..AC-5)", () => {
	const GIT_ENV = {
		GIT_AUTHOR_NAME: "t",
		GIT_AUTHOR_EMAIL: "t@t",
		GIT_COMMITTER_NAME: "t",
		GIT_COMMITTER_EMAIL: "t@t",
		GIT_CONFIG_NOSYSTEM: "1",
	};
	const sh = (cmd: string, cwd = repo): string => {
		const out = Bun.spawnSync(["sh", "-c", cmd], { cwd, env: { ...process.env, ...GIT_ENV } });
		if (out.exitCode !== 0) throw new Error(`${cmd}: ${out.stderr.toString()}`);
		return out.stdout.toString().trim();
	};
	const BUN_INSTALL = ["timeout", "300", "/h/.local/bin/bun", "install", "--frozen-lockfile"];

	interface Repo {
		good: string;
		bad: string;
		origin: string;
	}

	/** main: good (recorded as head.last-good) → bad; origin is a local bare repository holding both. */
	function initRepo(opts: { lockChanges?: boolean } = {}): Repo {
		const origin = join(root, "origin.git");
		sh(`git init -q --bare -b main ${origin}`, root);
		sh("git init -q -b main && git config commit.gpgsign false");
		writeFileSync(join(repo, "package.json"), '{"name":"x"}\n');
		writeFileSync(join(repo, "bun.lock"), "lock-1\n");
		writeFileSync(join(repo, "src", "main.ts"), "good\n");
		sh("git add package.json bun.lock src/main.ts && git commit -qm good");
		const good = sh("git rev-parse HEAD");
		writeFileSync(join(repo, "src", "main.ts"), "bad\n");
		if (opts.lockChanges === true) writeFileSync(join(repo, "bun.lock"), "lock-2\n");
		sh("git add src/main.ts bun.lock && git commit -qm bad");
		sh(`git remote add origin ${origin} && git push -q origin main`);
		writeFileSync(join(repo, "scratch.txt"), "untracked\n");
		writeFileSync(join(home, "head.last-good"), `${good}\n`, { mode: 0o600 });
		// The running (bad) code's deps are installed; a rollback to a tree with another lockfile has to install.
		markDepsInstalled();
		return { good, bad: sh("git rev-parse HEAD"), origin };
	}

	/** Real git in `repo`; systemctl from the fake world; `bun install` recorded and answered with `installRc`. */
	function repoDeps(world: World, over: Partial<ApplyDeps> & { installRc?: number } = {}) {
		const fake = makeDeps(world, over);
		const installs: Array<{ cmd: string[]; cwd: string | undefined }> = [];
		const pushes: string[][] = [];
		const run: ApplyDeps["run"] = async (cmd, opts) => {
			if (cmd[0] === "git") {
				world.commands.push(cmd);
				if (cmd[3] === "push") pushes.push(cmd);
				return spawnRunner(cmd, { env: GIT_ENV });
			}
			if (cmd[0] === "timeout") {
				world.commands.push(cmd);
				installs.push({ cmd, cwd: opts?.cwd });
				return over.installRc === undefined || over.installRc === 0
					? { code: 0, stdout: "", stderr: "" }
					: { code: over.installRc, stdout: "", stderr: Array.from({ length: 30 }, (_, i) => `err ${i}`).join("\n") };
			}
			return fake.run(cmd, opts);
		};
		return { deps: { ...fake, run }, installs, pushes };
	}

	/** The apply restart and the config rollback restart bring no fresh daemon; restart n >= `freshFrom` does. */
	function failingWorld(freshFrom = 3): World {
		const world = makeWorld();
		world.restartMakesFreshDaemon = false;
		world.onRestart = (n) => {
			world.restartMakesFreshDaemon = n >= freshFrom;
		};
		return world;
	}
	const codeStep = (receipt: ApplyReceipt) => receipt.steps.find((s) => s.name === "code_rollback");

	test("AC-2: a failed config rollback makes a revert commit with the last-good tree on main, pushes it and restarts", async () => {
		const r = initRepo();
		const world = failingWorld();
		let peerCalls = 0;
		const { deps, installs, pushes } = repoDeps(world, {
			peers: async () => {
				peerCalls += 1;
				return [{ unit: "ompbot-tteok", status: "ok", exitCode: 0, receiptPath: "/t/r.json" }];
			},
		});
		const report: ApplyOptions = { ...base, reportOrigin: "slack/ch/C0123456789", reportThread: "1793318305.840629" };
		const { exitCode, receipt } = await runApply(report, deps);
		expect(exitCode).toBe(1);
		expect(receipt.status).toBe("failed");
		expect(receipt.steps.map((s) => [s.name, s.ok])).toEqual([
			["preflight", true],
			["backup", true],
			["drain", true],
			["restart", true],
			["ready", false],
			["rollback", false],
			["code_rollback", true],
			["peers", true],
		]);
		const head = sh("git rev-parse HEAD");
		expect(head).not.toBe(r.bad);
		expect(sh("git rev-parse HEAD^")).toBe(r.bad);
		expect(sh("git rev-parse HEAD^{tree}")).toBe(sh(`git rev-parse ${r.good}^{tree}`));
		expect(sh("git branch --show-current")).toBe("main");
		expect(readFileSync(join(repo, "scratch.txt"), "utf8")).toBe("untracked\n");
		expect(readFileSync(join(repo, "src", "main.ts"), "utf8")).toBe("good\n");
		const message = sh("git log -1 --format=%B");
		expect(message.split("\n")[0]).toBe(`revert(apply): ${base.stamp} 기동 실패로 ${r.good.slice(0, 7)} 트리로 복원`);
		expect(message).toContain(`${r.good}..${r.bad}`);
		expect(message).toContain(receipt.receiptPath);
		expect(pushes).toEqual([["git", "-C", repo, "push", "origin", "main"]]);
		expect(sh(`git --git-dir=${r.origin} rev-parse main`)).toBe(head);
		expect(installs).toHaveLength(0);
		expect(restartCommands(world)).toHaveLength(3);
		expect(peerCalls).toBe(1);
		expect(codeStep(receipt)?.detail).toContain(head);
		expect(existsSync(join(home, "autoland.hold"))).toBe(true);
		expect(statSync(join(home, "autoland.hold")).mode & 0o777).toBe(0o600);
		const inject = world.injects[0] as { text: string };
		expect(inject.text).toContain(`코드 롤백함: main에 revert 커밋 ${head.slice(0, 7)}, 원인 수정 뒤 다시 머지`);
	});

	test("IMP-04: a config rollback whose daemon answers but keeps Discord down goes on to the code rollback", async () => {
		const r = initRepo();
		const world = failingWorld(2); // the config rollback restart brings a fresh daemon
		world.heartbeat = (w) => {
			if (w.lockStartedAt === undefined) return undefined;
			const since = new Date(w.lockStartedAt);
			const discordDown = restartCommands(w).length === 2;
			return {
				ts: new Date(w.lockStartedAt + 500),
				loopMs: 1,
				socket: { state: "up", since },
				discord: { state: discordDown ? "down" : "up", since },
			};
		};
		const { deps } = repoDeps(world);
		const { exitCode, receipt } = await runApply(base, deps);
		expect(exitCode).toBe(1);
		expect(receipt.steps.map((s) => [s.name, s.ok])).toEqual([
			["preflight", true],
			["backup", true],
			["drain", true],
			["restart", true],
			["ready", false],
			["rollback", false],
			["code_rollback", true],
		]);
		const rollback = receipt.steps.find((s) => s.name === "rollback")?.detail;
		expect(rollback).toContain("restart ok");
		expect(rollback).toContain("transports failed: transports not up within 120s: down: discord");
		expect(sh("git rev-parse HEAD^{tree}")).toBe(sh(`git rev-parse ${r.good}^{tree}`));
		expect(restartCommands(world)).toHaveLength(3);
	});

	test.each<[string, (r: Repo, world: World) => ApplyOptions | undefined, string]>([
		[
			"no head.last-good",
			() => {
				rmSync(join(home, "head.last-good"));
				return undefined;
			},
			"head.last-good 없음",
		],
		[
			"head.last-good is HEAD",
			(r) => {
				writeFileSync(join(home, "head.last-good"), `${r.bad}\n`);
				return undefined;
			},
			"HEAD와 같음",
		],
		[
			"head.last-good is not an ancestor of HEAD",
			(r) => {
				sh(`git checkout -q -b side ${r.good} && echo s > s.txt && git add s.txt && git commit -qm side`);
				writeFileSync(join(home, "head.last-good"), `${sh("git rev-parse HEAD")}\n`);
				sh("git checkout -q main");
				return undefined;
			},
			"조상이 아님",
		],
		[
			"the checkout left main",
			(_r, world) => {
				world.onRestart = () => {
					if (sh("git branch --show-current") === "main") sh("git checkout -q -b elsewhere");
				};
				return undefined;
			},
			"main이 아님",
		],
		[
			"an uncommitted src change",
			(_r, world) => {
				world.onRestart = () => writeFileSync(join(repo, "src", "main.ts"), "hand edit\n");
				return undefined;
			},
			"추적 파일 미커밋",
		],
		[
			"an uncommitted root file (AC-4)",
			(_r, world) => {
				world.onRestart = () => writeFileSync(join(repo, "package.json"), '{"name":"edited"}\n');
				return undefined;
			},
			"추적 파일 미커밋",
		],
		[
			"a staged change",
			(_r, world) => {
				world.onRestart = () => {
					writeFileSync(join(repo, "new.txt"), "n\n");
					sh("git add new.txt");
				};
				return undefined;
			},
			"staged",
		],
		["--no-code-rollback", () => ({ ...base, codeRollbackOff: "--no-code-rollback" }), "--no-code-rollback"],
	])("AC-3 %s: the code stays and the rollback detail says why", async (_name, setup, reason) => {
		const r = initRepo();
		const world = failingWorld();
		const options = setup(r, world) ?? base;
		const headBefore = sh("git rev-parse HEAD");
		const { deps, pushes } = repoDeps(world);
		const { exitCode, receipt } = await runApply(options, deps);
		expect(exitCode).toBe(1);
		expect(sh("git rev-parse HEAD")).toBe(headBefore);
		expect(codeStep(receipt)).toBeUndefined();
		const rollback = receipt.steps.at(-1);
		expect(rollback?.name).toBe("rollback");
		expect(rollback?.detail).toContain("code rollback skipped");
		expect(rollback?.detail).toContain(reason);
		expect(restartCommands(world)).toHaveLength(2);
		expect(pushes).toHaveLength(0);
		expect(existsSync(join(home, "autoland.hold"))).toBe(false);
	});

	test("AC-4: a lockfile that differs runs bun install --frozen-lockfile once in the checkout before the restart", async () => {
		initRepo({ lockChanges: true });
		const world = failingWorld();
		let restartsAtInstall = -1;
		const { deps, installs } = repoDeps(world);
		const run: ApplyDeps["run"] = async (cmd, opts) => {
			if (cmd[0] === "timeout") restartsAtInstall = restartCommands(world).length;
			return deps.run(cmd, opts);
		};
		const { receipt } = await runApply(base, { ...deps, run });
		expect(installs).toEqual([{ cmd: BUN_INSTALL, cwd: repo }]);
		expect(restartsAtInstall).toBe(2);
		expect(codeStep(receipt)?.ok).toBe(true);
		expect(readFileSync(join(repo, "bun.lock"), "utf8")).toBe("lock-1\n");
	});

	test("AC-4: a failed bun install keeps (and pushes) the revert, restarts nothing more and names the manual command", async () => {
		const r = initRepo({ lockChanges: true });
		const world = failingWorld();
		const { deps, installs, pushes } = repoDeps(world, { installRc: 1 });
		const { exitCode, receipt } = await runApply(base, deps);
		expect(exitCode).toBe(1);
		expect(installs).toHaveLength(1);
		expect(restartCommands(world)).toHaveLength(2);
		expect(pushes).toHaveLength(1);
		expect(sh("git rev-parse HEAD^")).toBe(r.bad);
		const step = codeStep(receipt);
		expect(step?.ok).toBe(false);
		expect(step?.detail).toContain("bun install --frozen-lockfile && systemctl --user restart ompbot");
		expect(step?.detail).toContain("err 29");
		expect(step?.detail).not.toContain("err 9\n");
		expect(world.drainCancels).toBe(1);
		expect(existsSync(join(home, "autoland.hold"))).toBe(true);
	});

	test("AC-4: rolled-back code that does not come up either: no second code rollback, failed, no peers", async () => {
		const r = initRepo();
		const world = failingWorld(99);
		let peerCalls = 0;
		const { deps } = repoDeps(world, {
			peers: async () => {
				peerCalls += 1;
				return [];
			},
		});
		const { exitCode, receipt } = await runApply(base, deps);
		expect(exitCode).toBe(1);
		expect(restartCommands(world)).toHaveLength(3);
		expect(sh("git rev-parse HEAD^")).toBe(r.bad);
		expect(sh("git rev-list --count HEAD")).toBe("3");
		expect(codeStep(receipt)?.ok).toBe(false);
		expect(receipt.steps.at(-1)?.name).toBe("code_rollback");
		expect(peerCalls).toBe(0);
	});

	test("AC-4: a failed push does not stop the rollback and is written to the detail and the hold", async () => {
		initRepo();
		sh(`git remote set-url origin ${join(root, "missing.git")}`);
		const world = failingWorld();
		const { deps, pushes } = repoDeps(world);
		const { receipt } = await runApply(base, deps);
		expect(pushes).toHaveLength(1);
		expect(restartCommands(world)).toHaveLength(3);
		expect(codeStep(receipt)?.ok).toBe(true);
		expect(codeStep(receipt)?.detail).toContain("push 실패");
		expect(readFileSync(join(home, "autoland.hold"), "utf8")).toContain("push 실패");
	});

	test("deps AC-4: the code rollback installs through ensureDeps and leaves the marker of the reverted tree", async () => {
		initRepo({ lockChanges: true });
		const badHash = depsHash(repo);
		const { deps, installs } = repoDeps(failingWorld());
		const { receipt } = await runApply(base, deps);
		expect(installs).toEqual([{ cmd: BUN_INSTALL, cwd: repo }]);
		expect(depsHash(repo)).not.toBe(badHash);
		expect(readFileSync(join(repo, DEPS_MARKER), "utf8")).toBe(`${depsHash(repo)}\n`);
		expect(codeStep(receipt)?.detail).toContain("bun install --frozen-lockfile ok");
		expect(existsSync(join(repo, ".git", INSTALL_LOCK_FILE))).toBe(false);
	});

	test("AC-5: the next successful apply removes autoland.hold", async () => {
		initRepo();
		const { deps } = repoDeps(failingWorld());
		await runApply(base, deps);
		// What the daemon's sweepers read: the reason with its time.
		expect(readAutoLandHold(home)).toMatch(
			/^코드 롤백\(apply 20261030-140000\): revert [0-9a-f]{7} → [0-9a-f]{7} 트리 \(\S+\)$/,
		);
		const next = repoDeps(makeWorld());
		const { exitCode } = await runApply({ ...base, stamp: "20261030-150000" }, next.deps);
		expect(exitCode).toBe(0);
		expect(existsSync(join(home, "autoland.hold"))).toBe(false);
		expect(readAutoLandHold(home)).toBeUndefined();
	});

	describe("apply.codeRollback detach and off (apply-rollback-mode)", () => {
		const detach: ApplyOptions = { ...base, codeRollback: "detach" };
		const journalFile = (): string => join(sh("git rev-parse --absolute-git-dir"), CODE_ROLLBACK_JOURNAL);
		const lastGoodFile = (dir = home): string => join(dir, "head.last-good");
		// A verified apply: doctor rc=0 and no runtime gate open, so a main apply records head.last-good.
		const verifiedDoctor: Partial<ApplyDeps> = { doctor: async () => ({ code: 0, lines: [] }) };

		/** A second install on the checkout, applied the way the CLI applies a peer. */
		function peerRunner(results: ApplyOutcome[], options: (afterCodeRollback: boolean) => ApplyOptions) {
			const peerHome = join(root, "peer-home");
			mkdirSync(peerHome, { recursive: true, mode: 0o700 });
			return async (afterCodeRollback = false): Promise<PeerApply[]> => {
				const { deps } = repoDeps(makeWorld(), { homeDir: peerHome, unit: "ompbot-peer", ...verifiedDoctor });
				const outcome = await runApply(options(afterCodeRollback), deps);
				results.push(outcome);
				const { status, receiptPath } = outcome.receipt;
				return [{ unit: "ompbot-peer", status, exitCode: outcome.exitCode, receiptPath }];
			};
		}

		test("AC-3: main stays, no revert or push, HEAD detached at last-good, journal in the git dir, deps installed, restarted, peers follow", async () => {
			const r = initRepo({ lockChanges: true });
			const world = failingWorld();
			const peerOutcomes: ApplyOutcome[] = [];
			const { deps, installs, pushes } = repoDeps(world, {
				peers: peerRunner(peerOutcomes, (after) => peerApplyOptions(detach, after)),
			});
			const { exitCode, receipt } = await runApply(
				{ ...detach, reportOrigin: "slack/ch/C0123456789", reportThread: "1793318305.840629" },
				deps,
			);
			expect(exitCode).toBe(1);
			expect(receipt.codeRollback).toBe("detach");
			expect(receipt.steps.map((s) => [s.name, s.ok])).toEqual([
				["preflight", true],
				["backup", true],
				["drain", true],
				["restart", true],
				["ready", false],
				["rollback", false],
				["code_rollback", true],
				["peers", true],
			]);
			expect(sh("git rev-parse main")).toBe(r.bad);
			expect(sh("git rev-list --count main")).toBe("2");
			expect(pushes).toEqual([]);
			expect(sh(`git --git-dir=${r.origin} rev-parse main`)).toBe(r.bad);
			expect(sh("git rev-parse HEAD")).toBe(r.good);
			expect(sh("git branch --show-current")).toBe("");
			expect(readFileSync(join(repo, "src", "main.ts"), "utf8")).toBe("good\n");
			expect(readFileSync(join(repo, "scratch.txt"), "utf8")).toBe("untracked\n");
			expect(JSON.parse(readFileSync(journalFile(), "utf8"))).toEqual({
				lastGood: r.good,
				head: r.bad,
				stamp: base.stamp,
				home,
			});
			expect(journalFile().startsWith(join(repo, ".git"))).toBe(true);
			// The running code's deps (lock-2) are installed; the last-good tree (lock-1) installs through ensureDeps.
			expect(installs).toEqual([{ cmd: BUN_INSTALL, cwd: repo }]);
			expect(readFileSync(join(repo, DEPS_MARKER), "utf8")).toBe(`${depsHash(repo)}\n`);
			expect(restartCommands(world)).toHaveLength(3);
			expect(codeStep(receipt)?.detail).toContain(`HEAD detached at ${r.good}, main stays at ${r.bad}`);
			expect(readAutoLandHold(home)).toContain(`detach → ${r.good.slice(0, 7)}`);
			const inject = world.injects[0] as { text: string };
			expect(inject.text).toContain(`코드 롤백함: ${r.good.slice(0, 7)}로 detached checkout(main 그대로)`);
			// 7b: the peer passes preflight on the detached commit and keeps journal and hold, recording no head.last-good.
			expect(peerOutcomes.map((o) => o.exitCode)).toEqual([0]);
			expect(peerOutcomes[0]?.receipt.steps[0]?.detail).toContain(`detached@${r.good}`);
			expect(existsSync(lastGoodFile(join(root, "peer-home")))).toBe(false);
			expect(existsSync(journalFile())).toBe(true);
			expect(existsSync(join(home, "autoland.hold"))).toBe(true);
		});

		test("AC-4/7a: a failed detach checkout leaves no journal, cancels the drain, writes no hold, HEAD stays on main", async () => {
			const r = initRepo();
			const world = failingWorld();
			const { deps } = repoDeps(world);
			const run: ApplyDeps["run"] = async (cmd, opts) => {
				if (cmd[0] === "git" && cmd[3] === "checkout") {
					// The journal is written before the checkout is tried.
					expect(existsSync(journalFile())).toBe(true);
					return { code: 1, stdout: "", stderr: "error: checkout refused" };
				}
				return deps.run(cmd, opts);
			};
			const { exitCode, receipt } = await runApply(detach, { ...deps, run });
			expect(exitCode).toBe(1);
			expect(codeStep(receipt)?.ok).toBe(false);
			expect(codeStep(receipt)?.detail).toContain("checkout refused");
			expect(existsSync(journalFile())).toBe(false);
			expect(world.drainCancels).toBe(1);
			expect(existsSync(join(home, "autoland.hold"))).toBe(false);
			expect(sh("git branch --show-current")).toBe("main");
			expect(sh("git rev-parse HEAD")).toBe(r.bad);
			expect(restartCommands(world)).toHaveLength(2);
		});

		test("7b: a retry on the detached commit keeps journal and hold and records no head.last-good", async () => {
			const r = initRepo();
			await runApply(detach, repoDeps(failingWorld()).deps);
			rmSync(lastGoodFile());
			const { exitCode, receipt } = await runApply(
				{ ...detach, stamp: "20261030-150000" },
				repoDeps(makeWorld(), verifiedDoctor).deps,
			);
			expect(exitCode).toBe(0);
			expect(receipt.steps[0]?.detail).toContain(`detached@${r.good}`);
			expect(existsSync(journalFile())).toBe(true);
			expect(existsSync(join(home, "autoland.hold"))).toBe(true);
			expect(existsSync(lastGoodFile())).toBe(false);
		});

		test("AC-5: main still at the cause SKIPs naming --clear-rollback; --clear-rollback removes the journal and applies", async () => {
			const r = initRepo();
			await runApply(detach, repoDeps(failingWorld()).deps);
			sh("git checkout -q main");
			const world = makeWorld();
			const skipped = await runApply({ ...detach, stamp: "20261030-150000" }, repoDeps(world).deps);
			expect(skipped.exitCode).toBe(3);
			expect(skipped.receipt.steps[0]?.detail).toContain(`원인 커밋 ${r.bad.slice(0, 7)}가 아직 HEAD`);
			expect(skipped.receipt.steps[0]?.detail).toContain("apply --clear-rollback");
			expect(restartCommands(world)).toHaveLength(0);
			expect(existsSync(journalFile())).toBe(true);

			const cleared = await runApply(
				{ ...detach, stamp: "20261030-160000", clearRollback: true },
				repoDeps(makeWorld(), verifiedDoctor).deps,
			);
			expect(cleared.exitCode).toBe(0);
			expect(cleared.receipt.steps[0]?.detail).toContain("cleared (--clear-rollback)");
			expect(existsSync(journalFile())).toBe(false);
			expect(readFileSync(lastGoodFile(), "utf8")).toBe(`${r.bad}\n`);
		});

		test("AC-5: a main past the cause applies and the ok apply removes journal and hold, recording head.last-good", async () => {
			initRepo();
			await runApply(detach, repoDeps(failingWorld()).deps);
			sh("git checkout -q main");
			writeFileSync(join(repo, "src", "main.ts"), "fixed\n");
			sh("git add src/main.ts && git commit -qm fixed");
			const fixed = sh("git rev-parse HEAD");
			const { exitCode, receipt } = await runApply(
				{ ...detach, stamp: "20261030-150000" },
				repoDeps(makeWorld(), verifiedDoctor).deps,
			);
			expect(exitCode).toBe(0);
			expect(receipt.steps[0]?.detail).toContain(`main@${fixed} past the cause`);
			expect(existsSync(journalFile())).toBe(false);
			expect(existsSync(join(home, "autoland.hold"))).toBe(false);
			expect(readFileSync(lastGoodFile(), "utf8")).toBe(`${fixed}\n`);
		});

		test.each<[string, () => void]>([
			["a detached HEAD that is not the rolled-back commit", () => sh("git checkout -q --detach main")],
			["another branch", () => sh("git checkout -q -b elsewhere main")],
		])("AC-5: with the journal, %s SKIPs without guessing", async (_name, move) => {
			initRepo();
			await runApply(detach, repoDeps(failingWorld()).deps);
			move();
			const world = makeWorld();
			const { exitCode, receipt } = await runApply({ ...detach, stamp: "20261030-150000" }, repoDeps(world).deps);
			expect(exitCode).toBe(3);
			expect(receipt.steps[0]?.detail).toContain("is neither the rolled-back");
			expect(restartCommands(world)).toHaveLength(0);
			expect(existsSync(journalFile())).toBe(true);
		});

		test.each<[string, ApplyOptions, string]>([
			["apply.codeRollback=off", { ...base, codeRollback: "off" }, "apply.codeRollback=off"],
			["--no-code-rollback over detach", { ...detach, codeRollbackOff: "--no-code-rollback" }, "--no-code-rollback"],
		])("AC-6: %s reverts nothing and names only the revert command", async (_name, options, reason) => {
			const r = initRepo();
			const world = failingWorld();
			const { deps, pushes } = repoDeps(world);
			const { exitCode, receipt } = await runApply(options, deps);
			expect(exitCode).toBe(1);
			expect(sh("git rev-parse HEAD")).toBe(r.bad);
			expect(sh("git branch --show-current")).toBe("main");
			expect(pushes).toEqual([]);
			expect(existsSync(journalFile())).toBe(false);
			expect(existsSync(join(home, "autoland.hold"))).toBe(false);
			expect(codeStep(receipt)).toBeUndefined();
			expect(receipt.revertCommand).toBe(revertCommandFor(repo, r.good));
			const rollback = receipt.steps.at(-1)?.detail;
			expect(rollback).toContain(`code rollback skipped: ${reason}`);
			expect(rollback).toContain(`code not reverted; to revert: ${receipt.revertCommand}`);
			expect(restartCommands(world)).toHaveLength(2);
		});

		test("AC-7: --allow-detached applies a hand-picked detached commit, also on the peers, keeping head.last-good and hold", async () => {
			const r = initRepo();
			sh(`git checkout -q --detach ${r.good}`);
			writeFileSync(join(home, "autoland.hold"), '{"reason":"hand","at":"x"}\n', { mode: 0o600 });
			writeFileSync(lastGoodFile(), `${r.bad}\n`, { mode: 0o600 });
			const without = await runApply(detach, repoDeps(makeWorld()).deps);
			expect(without.exitCode).toBe(3);
			expect(without.receipt.steps[0]?.detail).toContain('checkout is on branch "(detached)", not main');

			const options: ApplyOptions = { ...detach, stamp: "20261030-150000", allowDetached: true };
			const peerOutcomes: ApplyOutcome[] = [];
			const { deps } = repoDeps(makeWorld(), {
				...verifiedDoctor,
				peers: peerRunner(peerOutcomes, (after) => peerApplyOptions(options, after)),
			});
			const { exitCode, receipt } = await runApply(options, deps);
			expect(exitCode).toBe(0);
			expect(receipt.steps[0]?.detail).toContain(`detached@${r.good} (--allow-detached)`);
			expect(peerOutcomes.map((o) => o.exitCode)).toEqual([0]);
			expect(readFileSync(lastGoodFile(), "utf8")).toBe(`${r.bad}\n`);
			expect(existsSync(join(home, "autoland.hold"))).toBe(true);
			expect(sh("git rev-parse HEAD")).toBe(r.good);
		});

		test("AC-7: doctor warns about the journal of the checkout it is given, with the way back", async () => {
			const r = initRepo();
			await runApply(detach, repoDeps(failingWorld()).deps);
			const warnings: string[] = [];
			checkCodeRollbackJournal(repo, (name, detail) => warnings.push(`${name}: ${detail}`));
			expect(warnings).toEqual([
				`code rollback: ${r.good.slice(0, 7)}로 되돌린 상태(원인 ${r.bad.slice(0, 7)}, apply ${base.stamp}), 복귀: git checkout main && git pull --ff-only && bun src/main.ts apply`,
			]);
			rmSync(journalFile());
			const none: string[] = [];
			checkCodeRollbackJournal(repo, (name, detail) => none.push(`${name}: ${detail}`));
			expect(none).toEqual([]);
		});
	});
});

describe("apply code rollback options (apply-rollback-mode)", () => {
	test("7c: runApply without codeRollback keeps push; the receipt names the mode", async () => {
		const { receipt } = await runApply(base, makeDeps(makeWorld()));
		expect(receipt.codeRollback).toBe("push");
		expect(receipt.steps[0]?.detail).toContain("codeRollback=push");
	});

	test("AC-7: peers keep --allow-detached and the mode, never the report, --clear-rollback or the code rollback", () => {
		const mergedAt = new Date(T0);
		const options: ApplyOptions = {
			...base,
			cutAfterMin: 5,
			mergedAt,
			codeRollback: "detach",
			clearRollback: true,
			allowDetached: true,
			reportOrigin: "slack/ch/C0123456789",
		};
		const peer: ApplyOptions = {
			timeoutMin: base.timeoutMin,
			cutAfterMin: 5,
			stamp: base.stamp,
			allowDetached: true,
			codeRollback: "detach",
			codeRollbackOff: "peer install (the first home's apply owns the code rollback)",
		};
		expect(peerApplyOptions(options, false)).toEqual({ ...peer, mergedAt });
		expect(peerApplyOptions(options, true)).toEqual(peer);
		expect(peerApplyOptions(base, false)).not.toHaveProperty("allowDetached");
	});

	test("AC-7: APPLY_USAGE names --clear-rollback and --allow-detached; the CLI takes both", async () => {
		expect(APPLY_USAGE).toContain("[--clear-rollback] [--allow-detached]");
		// Parsed (an unknown flag would be usage error 2), then --help answers without applying.
		expect(await applyCommand(["--clear-rollback", "--allow-detached", "--help"], home)).toBe(0);
		expect(await applyCommand(["--clear-rollbacks", "--help"], home)).toBe(2);
	});

	test("AC-7: doctorCommand gives runDoctor this checkout", async () => {
		const seen: Array<string | undefined> = [];
		await doctorCommand(home, () => {}, {
			doctor: async (_home, _write, repoDir) => {
				seen.push(repoDir);
				return 0;
			},
		});
		expect(seen).toEqual([join(import.meta.dir, "..")]);
	});
});

describe("ensureDeps install marker (apply-deps-install)", () => {
	const BUN = "/h/.local/bin/bun";
	const INSTALL = ["timeout", "300", BUN, "install", "--frozen-lockfile"];
	const marker = (): string | undefined =>
		existsSync(join(repo, DEPS_MARKER)) ? readFileSync(join(repo, DEPS_MARKER), "utf8") : undefined;
	const lockPath = (): string => join(root, "gitdir", INSTALL_LOCK_FILE);
	function ensure(world: World, over: Partial<ApplyDeps> = {}) {
		return ensureDeps(repo, { ...makeDeps(world, over), bun: BUN, stamp: base.stamp ?? "" });
	}

	test("AC-1: a marker equal to the working tree hash installs nothing (not even a git call)", async () => {
		const world = makeWorld();
		const result = await ensure(world);
		expect(result).toEqual({ ok: true, detail: `deps up to date ${depsHash(repo).slice(0, 8)}`, noted: false });
		expect(world.installs).toHaveLength(0);
		expect(world.commands).toHaveLength(0);
	});

	test.each([
		["missing", () => rmSync(join(repo, DEPS_MARKER))],
		["different", () => writeFileSync(join(repo, DEPS_MARKER), `${"0".repeat(64)}\n`)],
	])("AC-1: a %s marker is removed, bun install runs exactly once, then the new hash is written", async (_n, setup) => {
		setup();
		const world = makeWorld();
		const result = await ensure(world);
		expect(result.ok).toBe(true);
		expect(result.noted).toBe(true);
		expect(world.installs).toEqual([{ cmd: INSTALL, markerAtCall: false }]);
		expect(marker()).toBe(`${depsHash(repo)}\n`);
		expect(existsSync(lockPath())).toBe(false);
	});

	test("AC-1: a failed install leaves no marker and returns the last 20 output lines", async () => {
		writeFileSync(join(repo, "bun.lock"), "lock-2\n");
		const world = makeWorld();
		world.installRc = 1;
		const result = await ensure(world);
		expect(result.ok).toBe(false);
		expect(result.detail).toContain("bun install --frozen-lockfile rc=1");
		expect(result.detail).toContain("err 29");
		expect(result.detail).toContain("err 10");
		expect(result.detail).not.toContain("err 9\n");
		expect(world.installs).toHaveLength(1);
		expect(marker()).toBeUndefined();
		expect(existsSync(lockPath())).toBe(false);
	});

	test("AC-3: a live install lock holder is waited for; the marker it wrote meanwhile means no second install", async () => {
		writeFileSync(join(repo, "bun.lock"), "lock-2\n");
		writeFileSync(lockPath(), `${JSON.stringify({ pid: 777, stamp: "20261030-130000", startedAt: "x" })}\n`);
		const world = makeWorld();
		let sleeps = 0;
		const result = await ensure(world, {
			isAlive: (pid) => pid === 777,
			sleep: async (ms) => {
				sleeps += 1;
				world.clock += ms;
				if (sleeps === 3) {
					// the other home's install finishes: marker first, then its lock goes
					writeFileSync(join(repo, DEPS_MARKER), `${depsHash(repo)}\n`);
					rmSync(lockPath());
				}
			},
		});
		expect(sleeps).toBe(3);
		expect(result.ok).toBe(true);
		expect(result.detail).toContain("waited for install of apply 20261030-130000");
		expect(result.detail).toContain("deps up to date");
		expect(world.installs).toHaveLength(0);
		expect(existsSync(lockPath())).toBe(false);
	});

	test("AC-3: a dead holder's install lock is taken over without waiting and the install runs", async () => {
		rmSync(join(repo, DEPS_MARKER));
		writeFileSync(lockPath(), `${JSON.stringify({ pid: 778, stamp: "20261030-130000", startedAt: "x" })}\n`);
		const world = makeWorld();
		let sleeps = 0;
		const result = await ensure(world, {
			isAlive: () => false,
			sleep: async () => {
				sleeps += 1;
			},
		});
		expect(sleeps).toBe(0);
		expect(result.ok).toBe(true);
		expect(result.detail).toContain("stale install lock 20261030-130000 taken over");
		expect(world.installs).toHaveLength(1);
		expect(marker()).toBe(`${depsHash(repo)}\n`);
		expect(existsSync(lockPath())).toBe(false);
	});

	test("a live holder past the wait limit fails without installing and leaves its lock alone", async () => {
		rmSync(join(repo, DEPS_MARKER));
		const held = `${JSON.stringify({ pid: 779, stamp: "20261030-130000", startedAt: "x" })}\n`;
		writeFileSync(lockPath(), held);
		const world = makeWorld();
		const result = await ensure(world, { isAlive: () => true });
		expect(result.ok).toBe(false);
		expect(result.detail).toContain(`install lock held by apply 20261030-130000 after ${INSTALL_LOCK_WAIT_MS / 1000}s`);
		expect(world.installs).toHaveLength(0);
		expect(readFileSync(lockPath(), "utf8")).toBe(held);
	});

	test("forward apply: a changed lockfile installs after the drain and before the restart, recorded as step deps", async () => {
		writeFileSync(join(repo, "bun.lock"), "lock-2\n");
		const world = makeWorld();
		const { exitCode, receipt } = await runApply(base, makeDeps(world));
		expect(exitCode).toBe(0);
		expect(receipt.steps.map((s) => s.name).slice(0, 5)).toEqual(["preflight", "backup", "drain", "deps", "restart"]);
		expect(receipt.steps.find((s) => s.name === "deps")?.detail).toContain("bun install --frozen-lockfile ok");
		const order = world.commands.map((c) => c[0] + (c[2] ?? ""));
		expect(order.indexOf("timeout300")).toBeLessThan(order.indexOf("systemctlrestart"));
		expect(world.installs).toHaveLength(1);
		expect(marker()).toBe(`${depsHash(repo)}\n`);
	});

	test("AC-2: a failed forward install cancels the drain, restarts nothing and fails with the manual command", async () => {
		writeFileSync(join(repo, "bun.lock"), "lock-2\n");
		const world = makeWorld();
		world.installRc = 1;
		const { exitCode, receipt } = await runApply(base, makeDeps(world));
		expect(exitCode).toBe(1);
		const onDisk = readReceipt(receipt);
		expect(onDisk.status).toBe("failed");
		expect(restartCommands(world)).toHaveLength(0);
		expect(world.drainCancels).toBe(1);
		const step = onDisk.steps.at(-1);
		expect(step?.name).toBe("deps");
		expect(step?.ok).toBe(false);
		expect(step?.detail).toContain(`by hand: cd ${repo} && bun install --frozen-lockfile && bun src/main.ts apply`);
		expect(step?.detail).toContain("drain cancelled");
		expect(marker()).toBeUndefined();
	});

	test("AC-3: two homes on one checkout apply in turn: only the first installs, the second finds it up to date", async () => {
		writeFileSync(join(repo, "bun.lock"), "lock-2\n");
		const home2 = join(root, "home2");
		mkdirSync(home2, { mode: 0o700 });
		const world = makeWorld();
		const first = await runApply(base, makeDeps(world));
		const lines: string[] = [];
		const second = await runApply(
			{ ...base, stamp: "20261030-140500" },
			makeDeps(world, { homeDir: home2, unit: "ompbot-tteok", log: (line) => lines.push(line) }),
		);
		expect([first.exitCode, second.exitCode]).toEqual([0, 0]);
		expect(world.installs).toHaveLength(1);
		expect(first.receipt.steps.map((s) => s.name)).toContain("deps");
		expect(second.receipt.steps.map((s) => s.name)).not.toContain("deps");
		expect(lines).toContain(`apply deps deps up to date ${depsHash(repo).slice(0, 8)}`);
		expect(restartCommands(world)).toHaveLength(2);
	});
});
