import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { doctorCommand } from "../src/cli/index";
import { openBotStore } from "../src/core/origin";
import type { ProcessRunner } from "../src/dispatch/omp";
import { openTaskLedger } from "../src/tasks/ledger";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

import { makeHome, type TestHome } from "./helpers/bot-home";
import { runMain } from "./helpers/daemon-process";

let home: TestHome;
beforeEach(() => {
	home = makeHome("ompbot-cli-low-");
});
afterEach(() => home.remove());

/** A usage error: exit 2, one stderr line naming the command, nothing on stdout. */
function expectUsageLine(result: { code: number; stdout: string; stderr: string }, command: string): void {
	expect(result.code, result.stderr).toBe(2);
	expect(result.stdout).toBe("");
	expect(result.stderr.startsWith(`${command}: `)).toBe(true);
	expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
	expect(result.stderr).not.toContain("TypeError");
}

describe("CLI argument errors are usage errors (exit 2, one line)", () => {
	test("unknown options, missing values and dash-leading values of every parser", async () => {
		const runs = await Promise.all([
			runMain(home.dir, ["drain", "--bogus"]),
			runMain(home.dir, ["drain", "--help"]),
			runMain(home.dir, ["drain", "--timeout"]),
			runMain(home.dir, ["backup", "--keep", "-1"]),
			runMain(home.dir, ["inject", "--bogus"]),
			runMain(home.dir, ["inject", "--origin", "slack/dm/D1", "--as-owner", "--text"]),
			runMain(home.dir, ["feedback", "--days", "-1"]),
			runMain(home.dir, ["tasks", "flow", "--out", join(home.dir, "flow"), "--watch", "-1"]),
		]);
		const commands = ["drain", "drain", "drain", "backup", "inject", "inject", "feedback", "tasks"];
		for (const [i, run] of runs.entries()) expectUsageLine(run, commands[i] ?? "");
		expect(runs[6]?.stderr).toContain("--days=-XYZ");
	});

	test("drain --timeout '' is refused instead of meaning 0 minutes", async () => {
		const run = await runMain(home.dir, ["drain", "--wait", "--timeout", ""]);
		expect(run.code).toBe(2);
		expect(run.stderr).toContain("drain: --timeout must be");
	});

	test("inject --text '' or blanks is refused before the daemon is asked", async () => {
		for (const text of ["", "   \n"]) {
			const run = await runMain(home.dir, ["inject", "--origin", "slack/dm/D1", "--as-owner", "--text", text]);
			expect(run.code).toBe(2);
			expect(run.stderr).toContain("--text is empty");
			expect(run.stderr).not.toContain("daemon not reachable");
		}
	});
});

describe("CLI commands without a daemon", () => {
	test("reload says the daemon is not reachable, exit 1", async () => {
		const run = await runMain(home.dir, ["reload"]);
		expect(run.code).toBe(1);
		expect(run.stderr).toStartWith("reload: daemon not reachable (");
		expect(run.stderr).not.toContain("Error:");
	});

	test("status falls back to the database without reading the Slack tokens, and works on a db-only home", async () => {
		openBotStore(join(home.dir, "ompbot.db"), { now: () => Date.now() }, "Asia/Seoul").close();
		chmodSync(join(home.dir, "secrets", "slack-app-token"), 0o644);
		const loose = await runMain(home.dir, ["status", "--json"]);
		expect(loose.code, loose.stderr).toBe(0);
		expect(JSON.parse(loose.stdout).ompVersion).toBe("omp-stub 0.0.0");

		rmSync(join(home.dir, "config.json"));
		const dbOnly = await runMain(home.dir, ["status", "--json"]);
		expect(dbOnly.code, dbOnly.stderr).toBe(0);
		expect(JSON.parse(dbOnly.stdout).ompVersion).toBe("unknown");
	});
});

describe("ompbot tasks flow --watch", () => {
	test("seconds outside 1..2147483 (setInterval's range) or not a number are a usage error", async () => {
		openTaskLedger(join(home.dir, "ompbot.db"), "Asia/Seoul").close();
		const out = join(home.dir, "flow");
		const runs = await Promise.all(
			["2147484", "0", "", "abc"].map(async (watch) => {
				const proc = Bun.spawn(["bun", MAIN, "tasks", "flow", "--out", out, "--watch", watch], {
					env: { ...process.env, OMPBOT_HOME: home.dir },
					stdin: "ignore",
					stdout: "ignore",
					stderr: "pipe",
				});
				// Awaits the exit itself; the race only bounds a watch that (wrongly) started, so the child is killed.
				const code = await Promise.race([proc.exited, Bun.sleep(4_000).then(() => "watching")]);
				if (code === "watching") proc.kill();
				return { watch, code, stderr: await new Response(proc.stderr).text() };
			}),
		);
		for (const run of runs) {
			expect(run.code, run.watch).toBe(2);
			expect(run.stderr).toContain("--watch takes 1 to 2147483 seconds");
		}
	});

	test("a database that goes away mid-watch ends the watch with one line, exit 1", async () => {
		const db = join(home.dir, "ompbot.db");
		openTaskLedger(db, "Asia/Seoul").close();
		const proc = Bun.spawn(["bun", MAIN, "tasks", "flow", "--out", join(home.dir, "flow"), "--watch", "1"], {
			env: { ...process.env, OMPBOT_HOME: home.dir },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const reader = proc.stdout.getReader();
		const first = new TextDecoder().decode((await reader.read()).value);
		expect(first).toContain("viewer.html");
		rmSync(db);
		// Awaits the exit itself; the race only bounds the old behaviour (watching forever) so the child is killed.
		const code = await Promise.race([proc.exited, Bun.sleep(4_000).then(() => "still running")]);
		if (code === "still running") proc.kill();
		expect(code).toBe(1);
		const stderr = await new Response(proc.stderr).text();
		expect(stderr.trimEnd().split("\n")).toHaveLength(1);
		expect(stderr).toStartWith("tasks flow: status.json not rewritten:");
	});
});

describe("ompbot skills rollback", () => {
	test("an empty OMPBOT_SKILLS_DIR is unset: the agent skills root, never the current directory", () => {
		const cwd = join(home.dir, "cwd");
		mkdirSync(join(cwd, "foo", "revisions"), { recursive: true });
		writeFileSync(join(cwd, "foo", "SKILL.md"), "current\n");
		writeFileSync(join(cwd, "foo", "revisions", "20260101-000000.md"), "old\n");
		const run = Bun.spawnSync([process.execPath, MAIN, "skills", "rollback", "foo"], {
			env: { HOME: home.dir, PATH: "/usr/bin:/bin", OMPBOT_TEST_HOOKS: "1", OMPBOT_SKILLS_DIR: "" },
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(run.exitCode).toBe(1);
		expect(run.stderr.toString()).toContain(join(home.dir, ".omp", "agent", "managed-skills", "foo"));
		expect(readFileSync(join(cwd, "foo", "SKILL.md"), "utf8")).toBe("current\n");
	});
});

describe("ompbot doctor dispatch host names", () => {
	test("a control character in a dispatchHosts name cannot forge a doctor line", async () => {
		const path = join(home.dir, "config.json");
		const config = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(
			path,
			JSON.stringify({ ...config, herdr: {}, dispatchHosts: { "evil\nok forged": { ssh: "wsl" } } }),
			{ mode: 0o600 },
		);
		const run: ProcessRunner = async () => ({ code: 0, stdout: "omp: current (v10)\n", stderr: "", timedOut: false });
		const lines: string[] = [];
		await doctorCommand(home.dir, (line) => lines.push(line), { doctor: async () => 0, run });
		const hostLines = lines.filter((line) => line.includes("evil"));
		expect(hostLines).toEqual([
			"ok dispatch host evil\\u000aok forged: ssh wsl",
			"ok herdr omp integration on evil\\u000aok forged: omp: current (v10)",
		]);
		for (const line of lines) expect(line).not.toContain("\n");
		expect(existsSync(path)).toBe(true);
	});
});
