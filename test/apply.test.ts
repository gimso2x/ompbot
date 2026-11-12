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
import { homeDeps } from "../src/cli/apply";
import {
	type ApplyDeps,
	type ApplyOptions,
	type ApplyReceipt,
	createApplyLock,
	findDaemonUnits,
	type PeerApply,
	parseApplyLock,
	type RunResult,
	reclaimStaleApplyLock,
	releaseApplyLock,
	revertCommandFor,
	runApply,
} from "../src/ops/apply";
import type { BackupResult } from "../src/ops/backup";
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
	writeFileSync(join(home, "config.json"), '{"v":"before"}', { mode: 0o600 });
});

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
	/** Whether a restart yields a freshly started daemon (lock startedAt after the restart). */
	restartMakesFreshDaemon: boolean;
	lockStartedAt: number | undefined;
	commands: string[][];
	envs: Array<Record<string, string> | undefined>;
	drainResult: Awaited<ReturnType<ApplyDeps["drain"]>>;
	injects: unknown[];
	injectError: boolean;
	/** Inject calls that fail to connect (daemon socket down) before one goes through. */
	injectConnectFailures: number;
	injectResponse: unknown;
	drains: number;
	backups: number;
	/** Runs when `systemctl restart` is requested; lets a test change config.json as the new code would. */
	onRestart: (n: number) => void;
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
		restartMakesFreshDaemon: true,
		lockStartedAt: T0 - 3_600_000,
		commands: [],
		envs: [],
		drainResult: { ok: true, counts: { turns: 0, hostTools: 0, approvals: 0 } },
		injects: [],
		injectError: false,
		injectConnectFailures: 0,
		injectResponse: { ok: true, nonce: "n", threadRef: "t" },
		drains: 0,
		backups: 0,
		onRestart: () => {},
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
			if (sub[0] === "rev-parse") return ok(`${PREV}\n`);
			if (sub[0] === "status") return ok(world.srcStatus);
		}
		if (cmd[0] === "systemctl" && cmd[2] === "is-active") return { code: world.activeRc, stdout: "", stderr: "" };
		if (cmd[0] === "systemctl" && cmd[2] === "show") return ok(`${world.activeEnterUnix}\n`);
		if (cmd[0] === "systemctl" && cmd[2] === "restart") {
			restarts += 1;
			world.onRestart(restarts);
			if (world.restartRc !== 0) return { code: world.restartRc, stdout: "", stderr: "boom" };
			if (world.restartMakesFreshDaemon) world.lockStartedAt = world.clock + 1_000;
			return ok();
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
			if (op === "drain_cancel") world.drainCancels += 1;
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
			"verify",
			"last_good",
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
			["verify", true],
			["last_good", true],
		]);
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
