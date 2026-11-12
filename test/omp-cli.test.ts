import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
	cliPathIn,
	type OmpCliDeps,
	ompCommand,
	ompRoot,
	profileAgentDir,
	runProfileSync,
	TRIAL_PROMPT,
	type TrialResult,
} from "../src/cli/omp";
import { loadConfig } from "../src/config";
import { countOmpModels } from "../src/daemon/doctor";
import type { RunProcessOptions, RunProcessResult } from "../src/dispatch/omp";
import { defaultDiskPaths } from "../src/ops/gates";

let root: string;
let home: string;
let userHome: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ompbot-omp-cli-"));
	home = join(root, "ompbot-home");
	userHome = join(root, "user");
	mkdirSync(home, { mode: 0o700 });
	mkdirSync(userHome);
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function writeConfig(extra: Record<string, unknown> = {}): void {
	writeFileSync(
		join(home, "config.json"),
		JSON.stringify({
			schemaVersion: 1,
			channels: { slack: { ownerUserId: "UOWNER0" } },
			slack: { botTokenFile: "secrets/bot.token", appTokenFile: "secrets/app.token" },
			ompExecutable: "/usr/local/bin/omp",
			workspaceDir: "workspace",
			...extra,
		}),
	);
}

interface Fake {
	/** What `bun <cli> --version` prints per installed version (default `omp/<version>`). */
	reported: Map<string, string>;
	runtime: "ok" | "fail";
	rpc: TrialResult;
	print: RunProcessResult;
	models: number | string;
	calls: Array<{ cmd: string[]; opts: RunProcessOptions }>;
	rpcCalls: Array<{ cliPath: string; profile?: string; model?: string }>;
	lines: string[];
}

function fake(): Fake {
	return {
		reported: new Map(),
		runtime: "ok",
		rpc: { ok: true, detail: "ok" },
		print: { code: 0, stdout: "OK\n", timedOut: false },
		models: 3,
		calls: [],
		rpcCalls: [],
		lines: [],
	};
}

/** `OmpCliDeps` over a fake bun: `bun add` writes a non-executable cli.js, `--version` and `omp -p` answer from `f`. */
function deps(
	f: Fake,
	env: Record<string, string> = { HOME: userHome, PATH: "/usr/bin", PI_CODING_AGENT_DIR: "/inherited/agent" },
): OmpCliDeps {
	const config = existsSync(join(home, "config.json")) ? loadConfig(home, { checkTokens: false }) : undefined;
	return {
		homeDir: home,
		...(config === undefined ? {} : { config }),
		env,
		bun: "/fake/bun",
		run: async (cmd, opts) => {
			f.calls.push({ cmd, opts });
			if (cmd[0] === "/fake/bun" && cmd[1] === "add") {
				const cli = cliPathIn(opts.cwd ?? "");
				mkdirSync(dirname(cli), { recursive: true });
				writeFileSync(cli, "#!/usr/bin/env bun\n", { mode: 0o644 });
				return { code: 0, stdout: "installed", timedOut: false };
			}
			if (cmd[0] === "/fake/bun" && cmd[2] === "--version") {
				const version = (cmd[1] ?? "").split("/omp/")[1]?.split("/")[0] ?? "";
				return { code: 0, stdout: `${f.reported.get(version) ?? `omp/${version}`}\n`, timedOut: false };
			}
			if (cmd[1] === "-p") return f.print;
			throw new Error(`unexpected command ${cmd.join(" ")}`);
		},
		runtimeCheck: () =>
			f.runtime === "ok"
				? undefined
				: { code: "bun_too_old", detail: "bun=1.0.0 need=>=9", message: "bun too old for this omp" },
		rpcTrial: async (input) => {
			f.rpcCalls.push(input);
			return f.rpc;
		},
		countModels: async () => f.models,
		out: (line) => f.lines.push(line),
		now: () => 1_000,
	};
}

const omp = (f: Fake, ...args: string[]) => ompCommand(args, home, {}, deps(f));
const link = (name: string): string | undefined => {
	try {
		return readlinkSync(join(ompRoot(home), name));
	} catch {
		return undefined;
	}
};

describe("AC-4: ompbot omp install/use/rollback/prune", () => {
	test("install: a version mismatch removes the folder and fails", async () => {
		const f = fake();
		f.reported.set("18.18.9", "omp/18.18.8");
		expect(await omp(f, "install", "18.18.9")).toBe(1);
		expect(existsSync(join(ompRoot(home), "18.18.9"))).toBe(false);
		expect(f.lines.join("\n")).toContain('installed --version is "omp/18.18.8", expected omp/18.18.9');
		expect(link("current")).toBeUndefined();
	});

	test("install: bun add in a 0700 folder with a private package.json; cli.js made executable; current untouched", async () => {
		const f = fake();
		expect(await omp(f, "install", "18.18.9")).toBe(0);
		const dir = join(ompRoot(home), "18.18.9");
		expect(lstatSync(dir).mode & 0o777).toBe(0o700);
		expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))).toEqual({ private: true });
		expect(f.calls[0]?.cmd).toEqual(["/fake/bun", "add", "@oh-my-pi/pi-coding-agent@18.18.9"]);
		expect(f.calls[0]?.opts.cwd).toBe(dir);
		expect(() => accessSync(cliPathIn(dir), constants.X_OK)).not.toThrow();
		expect(link("current")).toBeUndefined();
		expect(await omp(f, "install", "not-a-version")).toBe(2);
	});

	async function installed(f: Fake, ...versions: string[]): Promise<void> {
		for (const version of versions) expect(await omp(f, "install", version)).toBe(0);
	}

	for (const stage of ["runtime", "rpc", "print-exit", "print-timeout", "print-no-ok"] as const) {
		test(`use: a failing ${stage} trial leaves current unchanged and exits 1`, async () => {
			writeConfig({ ompProfile: "ompbot", model: "zai/glm-5" });
			const f = fake();
			await installed(f, "18.18.8");
			expect(await omp(f, "use", "18.18.8")).toBe(0);
			if (stage === "runtime") f.runtime = "fail";
			if (stage === "rpc") f.rpc = { ok: false, detail: "no answer within 120s" };
			if (stage === "print-exit") f.print = { code: 3, stdout: "boom", timedOut: false };
			if (stage === "print-timeout") f.print = { code: null, stdout: "", timedOut: true };
			if (stage === "print-no-ok") f.print = { code: 0, stdout: "NOPE", timedOut: false };
			f.lines.length = 0;
			expect(await omp(f, "use", "18.18.9")).toBe(1);
			expect(link("current")).toBe("18.18.8");
			expect(link("previous")).toBeUndefined();
			expect(f.lines.join("\n")).toContain("current unchanged");
		});
	}

	test("use: all three trials pass → current switched, previous recorded; trials run with the bot env", async () => {
		writeConfig({ ompProfile: "ompbot", model: "zai/glm-5" });
		const f = fake();
		await installed(f, "18.18.8");
		expect(await omp(f, "use", "18.18.8")).toBe(0);
		expect(link("current")).toBe("18.18.8");
		expect(await omp(f, "use", "18.18.9")).toBe(0); // installs it first
		expect(link("current")).toBe("18.18.9");
		expect(link("previous")).toBe("18.18.8");
		const cli = cliPathIn(join(ompRoot(home), "18.18.9"));
		expect(f.rpcCalls.at(-1)).toMatchObject({ cliPath: cli, profile: "ompbot", model: "zai/glm-5" });
		const print = f.calls.filter((c) => c.cmd[1] === "-p").at(-1);
		expect(print?.cmd).toEqual([cli, "-p", "--no-title", "--model", "zai/glm-5", TRIAL_PROMPT]);
		expect(print?.opts.env?.OMP_PROFILE).toBe("ompbot");
		expect(print?.opts.env).not.toHaveProperty("PI_CODING_AGENT_DIR");
		expect(print?.opts.timeoutMs).toBe(120_000);
		expect(f.lines).toContain(
			`ompExecutable: ${join(home, "omp", "current", "node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js")}`,
		);
		expect(f.lines.at(-1)).toBe("`ompbot apply`로 재시작해야 반영된다");
	});

	test("rollback restores previous (and swaps), fails without one; prune keeps current and previous", async () => {
		const f = fake();
		expect(await omp(f, "rollback")).toBe(1);
		await installed(f, "18.18.7", "18.18.8", "18.18.9");
		expect(await omp(f, "use", "18.18.8")).toBe(0);
		expect(await omp(f, "use", "18.18.9")).toBe(0);
		expect(await omp(f, "rollback")).toBe(0);
		expect(link("current")).toBe("18.18.8");
		expect(link("previous")).toBe("18.18.9");
		writeFileSync(join(ompRoot(home), "last-sync"), "x\n");
		expect(await omp(f, "prune")).toBe(0);
		expect(existsSync(join(ompRoot(home), "18.18.7"))).toBe(false);
		expect(existsSync(join(ompRoot(home), "18.18.8"))).toBe(true);
		expect(existsSync(join(ompRoot(home), "18.18.9"))).toBe(true);
		expect(existsSync(join(ompRoot(home), "last-sync"))).toBe(true);
		expect(f.lines).toContain("omp_prune removed=18.18.7");
	});
});

describe("AC-6b: login check and profile-aware doctor/gates", () => {
	test("omp status fails when the pinned omp reads no login (models=0), passes with models", async () => {
		writeConfig({ ompProfile: "ompbot" });
		const f = fake();
		expect(await omp(f, "install", "18.18.9")).toBe(0);
		expect(await omp(f, "use", "18.18.9")).toBe(0);
		f.lines.length = 0;
		f.models = 0;
		expect(await omp(f, "status")).toBe(1);
		expect(f.lines.join("\n")).toContain("login fail models=0");
		f.models = "omp models exited 1";
		expect(await omp(f, "status")).toBe(1);
		f.lines.length = 0;
		f.models = 5;
		expect(await omp(f, "status")).toBe(0);
		expect(f.lines).toContain("current=18.18.9 previous=none");
		expect(f.lines).toContain("login ok models=5");
		expect(f.lines.some((l) => l.startsWith(`profile=ompbot dir=${profileAgentDir(userHome, "ompbot")}`))).toBe(true);
		expect(f.lines).toContain(
			"last_sync=never pending_changes=unknown (source agent dir /inherited/agent does not exist)",
		);
	});

	test("countOmpModels (doctor) gives the child OMP_PROFILE and drops PI_CODING_AGENT_DIR", async () => {
		const script = join(root, "omp-models");
		writeFileSync(
			script,
			'#!/bin/sh\nif [ "$OMP_PROFILE" = ompbot ] && [ -z "$PI_CODING_AGENT_DIR" ]; then echo \'{"models":[1,2]}\'; else echo \'{"models":[]}\'; fi\n',
		);
		chmodSync(script, 0o755);
		const base = { PATH: "/usr/bin:/bin", PI_CODING_AGENT_DIR: "/inherited/agent" };
		expect(await countOmpModels(script, 10_000, "ompbot", base)).toBe(2);
		expect(await countOmpModels(script, 10_000, undefined, base)).toBe(0);
	});

	test("the disk gate's default paths include the profile agent dir", () => {
		mkdirSync(join(userHome, ".omp", "agent"), { recursive: true });
		mkdirSync(profileAgentDir(userHome, "ompbot"), { recursive: true });
		expect(defaultDiskPaths(home, undefined, userHome)).toEqual([home, join(userHome, ".omp", "agent")]);
		expect(defaultDiskPaths(home, "ompbot", userHome)).toEqual([
			home,
			join(userHome, ".omp", "agent"),
			profileAgentDir(userHome, "ompbot"),
		]);
	});
});

describe("AC-5: ompbot omp sync", () => {
	let source: string;
	let target: string;
	let shared: string;

	function sqlite(path: string, value: string): void {
		mkdirSync(dirname(path), { recursive: true });
		const db = new Database(path, { create: true });
		db.run("PRAGMA journal_mode=WAL");
		db.run("CREATE TABLE IF NOT EXISTS m (v TEXT)");
		db.run("INSERT INTO m VALUES (?)", [value]);
		db.close();
	}
	const rows = (path: string): string[] => {
		const db = new Database(path, { readonly: true });
		try {
			return db
				.query<{ v: string }, []>("SELECT v FROM m ORDER BY rowid")
				.all()
				.map((r) => r.v);
		} finally {
			db.close();
		}
	};
	const put = (path: string, text: string): void => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
	};

	beforeEach(() => {
		source = join(userHome, ".omp", "agent");
		target = profileAgentDir(userHome, "ompbot");
		shared = join(userHome, ".local", "share", "omp-sync", "skills", "s1");
		put(join(shared, "SKILL.md"), "shared skill\n");
		put(join(source, "RULES.md"), "rules\n");
		put(join(source, "RULES.md.bak-1"), "old rules\n");
		put(join(source, "models.yml"), "models: {}\n");
		put(join(source, "mcp.json"), "{}\n");
		put(join(source, "extensions", "a", "index.ts"), "export {};\n");
		put(join(source, "extensions", "a", "index.ts.bak"), "old\n");
		mkdirSync(join(source, "skills"), { recursive: true });
		symlinkSync("../../../.local/share/omp-sync/skills/s1", join(source, "skills", "s1"));
		symlinkSync("../nowhere", join(source, "skills", "broken"));
		put(
			join(source, "config.yml"),
			`extensions:\n  - ~/.omp/agent/extensions/omp-ulw\n  - ${source}/extensions/b\nkeep: ~/.omp/agentx/no\nlast: "~/.omp/agent"\n`,
		);
		put(join(source, "agent.db"), "login");
		put(join(source, "agent.db-wal"), "wal");
		put(join(source, "managed-skills", "m1", "SKILL.md"), "m1 v1\n");
		put(join(source, "managed-skills", "m2", "SKILL.md"), "m2 v1\n");
		sqlite(join(source, "memories", "mnemopi", "mnemopi.db"), "owner-1");
		sqlite(join(source, "memories", "mnemopi", "banks", "b1", "mnemopi.db"), "bank-1");
		put(join(source, "sessions", "x.jsonl"), "{}\n");
		put(join(source, "history.db"), "h");
		put(join(source, "models.db"), "m");
		writeConfig({ ompProfile: "ompbot" });
	});

	function sync(init = false): { code: number; lines: string[] } {
		const lines: string[] = [];
		const code = runProfileSync({
			homeDir: home,
			profile: "ompbot",
			env: { HOME: userHome },
			...(init ? { init: true } : {}),
			out: (line) => lines.push(line),
			now: () => Date.UTC(2026, 10, 12),
		});
		return { code, lines };
	}

	test("--init: mirrors, rewrites config.yml, absolute links, login links, managed skills and memory once", () => {
		const first = sync(true);
		expect(first.lines.at(-1)).toBe(`omp_profile_sync changed=${first.code}`);
		expect(first.code).toBeGreaterThan(0);
		expect(lstatSync(target).mode & 0o777).toBe(0o700);
		for (const rel of ["RULES.md", "models.yml", "mcp.json", "extensions/a/index.ts"]) {
			expect(readFileSync(join(target, rel), "utf8")).toBe(readFileSync(join(source, rel), "utf8"));
		}
		for (const rel of ["RULES.md.bak-1", "extensions/a/index.ts.bak", "sessions", "history.db", "models.db"]) {
			expect(existsSync(join(target, rel))).toBe(false);
		}
		const config = readFileSync(join(target, "config.yml"), "utf8");
		expect(config).toContain(`  - ${target}/extensions/omp-ulw\n`);
		expect(config).toContain(`  - ${target}/extensions/b\n`);
		expect(config).toContain("keep: ~/.omp/agentx/no\n");
		expect(config).toContain(`last: "${target}"`);
		expect(config).not.toContain(".omp/agent/");
		const s1 = join(target, "skills", "s1");
		expect(lstatSync(s1).isSymbolicLink()).toBe(true);
		expect(isAbsolute(readlinkSync(s1))).toBe(true);
		expect(readlinkSync(s1)).toBe(realpathSync(shared));
		expect(readFileSync(join(s1, "SKILL.md"), "utf8")).toBe("shared skill\n");
		expect(existsSync(join(target, "skills", "broken"))).toBe(false);
		expect(first.lines.some((l) => l.startsWith("warn skipped broken link skills/broken"))).toBe(true);
		for (const name of ["agent.db", "agent.db-shm", "agent.db-wal"]) {
			const stat = lstatSync(join(target, name));
			expect(stat.isSymbolicLink()).toBe(true);
			expect(stat.isFile()).toBe(false);
			expect(readlinkSync(join(target, name))).toBe(join(source, name));
		}
		expect(readFileSync(join(target, "managed-skills", "m1", "SKILL.md"), "utf8")).toBe("m1 v1\n");
		expect(rows(join(target, "memories", "mnemopi", "mnemopi.db"))).toEqual(["owner-1"]);
		expect(rows(join(target, "memories", "mnemopi", "banks", "b1", "mnemopi.db"))).toEqual(["bank-1"]);
		expect(readFileSync(join(ompRoot(home), "last-sync"), "utf8")).toContain("2026-11-12T00:00:00.000Z");

		// Same input again: nothing to do, with or without --init.
		const quiet = ["warn skipped broken link skills/broken -> ../nowhere", "omp_profile_sync changed=0"];
		expect(sync().lines).toEqual(quiet);
		expect(sync(true).lines).toEqual(quiet);
	});

	test("later syncs: deletions mirrored, owner skills added/updated, the bot's own skills and memory kept", () => {
		sync(true);
		rmSync(join(source, "models.yml"));
		rmSync(join(source, "extensions", "a", "index.ts"));
		put(join(source, "managed-skills", "m3", "SKILL.md"), "m3\n");
		put(join(source, "managed-skills", "m1", "SKILL.md"), "m1 v2\n");
		const later = new Date(Date.now() + 60_000);
		utimesSync(join(source, "managed-skills", "m1", "SKILL.md"), later, later);
		// The bot edited m2 after the owner's copy, and made t1 itself.
		put(join(target, "managed-skills", "m2", "SKILL.md"), "m2 by bot\n");
		utimesSync(join(target, "managed-skills", "m2", "SKILL.md"), later, later);
		put(join(target, "managed-skills", "t1", "SKILL.md"), "bot skill\n");
		sqlite(join(source, "memories", "mnemopi", "mnemopi.db"), "owner-2");
		sqlite(join(target, "memories", "mnemopi", "mnemopi.db"), "bot-1");
		// A wrong login link and a stale copy of a mirrored link are repaired.
		rmSync(join(target, "agent.db"));
		writeFileSync(join(target, "agent.db"), "copy");
		rmSync(join(target, "skills", "s1"));
		symlinkSync("../../../.local/share/omp-sync/skills/s1", join(target, "skills", "s1"));

		const { code, lines } = sync(true);
		expect(code).toBeGreaterThan(0);
		expect(existsSync(join(target, "models.yml"))).toBe(false);
		expect(existsSync(join(target, "extensions", "a", "index.ts"))).toBe(false);
		expect(lines).toContain("removed models.yml");
		expect(readFileSync(join(target, "managed-skills", "m3", "SKILL.md"), "utf8")).toBe("m3\n");
		expect(readFileSync(join(target, "managed-skills", "m1", "SKILL.md"), "utf8")).toBe("m1 v2\n");
		expect(readFileSync(join(target, "managed-skills", "t1", "SKILL.md"), "utf8")).toBe("bot skill\n");
		expect(lstatSync(join(target, "agent.db")).isSymbolicLink()).toBe(true);
		expect(readlinkSync(join(target, "skills", "s1"))).toBe(realpathSync(shared));
		// --init copies the memory only into a profile that has none.
		expect(rows(join(target, "memories", "mnemopi", "mnemopi.db"))).toEqual(["owner-1", "bot-1"]);
		expect(sync().code).toBe(0);
	});

	test("without --init a newer bot-side skill stays; with --init the owner's tree wins", () => {
		sync(true);
		const later = new Date(Date.now() + 60_000);
		put(join(target, "managed-skills", "m2", "SKILL.md"), "m2 by bot\n");
		utimesSync(join(target, "managed-skills", "m2", "SKILL.md"), later, later);
		expect(sync().code).toBe(0);
		expect(readFileSync(join(target, "managed-skills", "m2", "SKILL.md"), "utf8")).toBe("m2 by bot\n");
		expect(sync(true).code).toBe(1);
		expect(readFileSync(join(target, "managed-skills", "m2", "SKILL.md"), "utf8")).toBe("m2 v1\n");
	});

	test("ompbot omp sync: --init flag through the command, and a home without ompProfile is refused", async () => {
		const f = fake();
		expect(await ompCommand(["sync", "--init"], home, {}, deps(f, { HOME: userHome }))).toBe(0);
		expect(f.lines.at(-1)).toMatch(/^omp_profile_sync changed=\d+$/);
		writeConfig({});
		await expect(omp(fake(), "sync")).rejects.toThrow("ompProfile is not set");
	});
});
