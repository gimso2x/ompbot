import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../src/config";
import { checkCodeRollbackJournal, runDoctor } from "../src/daemon/doctor";
import { CLI_FIELDS, LIVE_FIELDS, planReload } from "../src/daemon/reload";
import { herdrSshArgv } from "../src/dispatch/omp";
import { CODE_ROLLBACK_JOURNAL } from "../src/ops/apply";
import { sshCommand } from "../src/tasks/host";
import { makeHome, type TestHome } from "./helpers/bot-home";

let home: TestHome;
beforeEach(() => {
	home = makeHome("ompbot-config-qa-i-low-");
});
afterEach(() => home.remove());

function writeConfig(patch: Record<string, unknown>): void {
	const base = {
		schemaVersion: 1,
		channels: { slack: { ownerUserId: "UOWNER0" } },
		slack: { botTokenFile: "secrets/bot.token", appTokenFile: "secrets/app.token" },
		ompExecutable: "/usr/local/bin/omp",
		workspaceDir: "workspace",
	};
	writeFileSync(join(home.dir, "config.json"), JSON.stringify({ ...base, ...patch }), { mode: 0o600 });
}

/** `loadConfig` without the token-file checks (the fixtures here only vary other fields). */
const load = (dir: string) => loadConfig(dir, { checkTokens: false });

function configError(fn: () => unknown): ConfigError {
	try {
		fn();
	} catch (error) {
		if (error instanceof ConfigError) return error;
		throw error;
	}
	throw new Error("expected ConfigError");
}

describe("config.json that is no regular file", () => {
	test("a FIFO is config_unreadable at once instead of blocking the read", () => {
		rmSync(join(home.dir, "config.json"));
		const fifo = join(home.dir, "config.json");
		expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
		// A child process with a deadline: a blocking read kills it instead of hanging the test run.
		const script = `
			import { loadConfig } from ${JSON.stringify(join(import.meta.dir, "..", "src", "config"))};
			import { readConfigText } from ${JSON.stringify(join(import.meta.dir, "..", "src", "ops", "apply"))};
			const text = readConfigText(${JSON.stringify(home.dir)});
			try { loadConfig(${JSON.stringify(home.dir)}); } catch (e) { console.log(String(text), e.code); }
		`;
		const run = Bun.spawnSync([process.execPath, "-e", script], { timeout: 10_000, stdout: "pipe", stderr: "pipe" });
		expect(run.stdout.toString().trim()).toBe("undefined config_unreadable");
	});
});

describe("dashboard in reload", () => {
	test("the daemon reads dashboard.opsStatus, so a change is live, not cli", () => {
		expect(LIVE_FIELDS as readonly string[]).toContain("dashboard");
		expect(CLI_FIELDS as readonly string[]).not.toContain("dashboard");
		const fresh = { ...home.config, dashboard: { port: 7331, opsStatus: { command: ["ops-status"] } } };
		const plan = planReload(home.config, fresh);
		expect(plan.changed).toEqual(["dashboard"]);
		expect(plan.cli).toEqual([]);
		expect(plan.next.dashboard?.opsStatus?.command).toEqual(["ops-status"]);
	});
});

describe("home and workspace layout", () => {
	test("a regular file in place of the home is not a directory", async () => {
		const file = join(home.dir, "afile");
		writeFileSync(file, "x", { mode: 0o700 });
		chmodSync(file, 0o700);
		expect(configError(() => loadConfig(file)).message).toContain("not a directory");
		const lines: string[] = [];
		await runDoctor(file, (line) => lines.push(line));
		expect(lines[0]).toBe(`fail home: ${file} is not a directory`);
	});

	test.each(["secrets", "secrets/w", ".", "config.json"])("workspaceDir %s is config_invalid", (workspaceDir) => {
		writeConfig({ workspaceDir });
		expect(configError(() => load(home.dir)).message).toContain("workspaceDir");
	});

	test("a workspace beside secrets/ is fine", () => {
		writeConfig({ workspaceDir: "work" });
		expect(load(home.dir).workspaceDir).toBe(join(home.dir, "work"));
	});
});

describe("dispatchHosts.<h>.ssh", () => {
	test.each(["-oProxyCommand=x", "a\0b", "ho st", "wsl\n", ""])("%j is config_invalid", (ssh) => {
		writeConfig({ herdr: {}, dispatchHosts: { wsl: { ssh } } });
		expect(configError(() => load(home.dir)).message).toContain("dispatchHosts.wsl.ssh");
	});

	test("an alias, user@host and an IPv6 literal pass", () => {
		for (const ssh of ["wsl", "ubuntu@10.0.0.5", "::1"]) {
			writeConfig({ herdr: {}, dispatchHosts: { wsl: { ssh } } });
			expect(load(home.dir).dispatchHosts?.wsl?.ssh).toBe(ssh);
		}
	});

	test("every ssh argv puts -- before the target", () => {
		for (const argv of [herdrSshArgv("wsl", "herdr", ["x"]), sshCommand("wsl", ["true"])]) {
			expect(argv.indexOf("--")).toBe(argv.indexOf("wsl") - 1);
		}
	});
});

describe("doctor code rollback line", () => {
	test("control characters in the journal cannot start a second line", () => {
		const repo = mkdtempSync(join(tmpdir(), "ompbot-doctor-journal-"));
		try {
			expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
			mkdirSync(join(repo, ".git"), { recursive: true });
			writeFileSync(
				join(repo, ".git", CODE_ROLLBACK_JOURNAL),
				JSON.stringify({ lastGood: "aaaaaaaa", head: "bbbbbbbb", stamp: "x\nok forged", home: home.dir }),
			);
			const warnings: string[] = [];
			checkCodeRollbackJournal(repo, (name, detail) => warnings.push(`${name}: ${detail}`));
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).not.toContain("\n");
			expect(warnings[0]).toContain("x\\u000aok forged");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
