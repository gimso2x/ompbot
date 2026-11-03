import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
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
import { loadConfig } from "../src/config";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const OWNER = "U0123456789";

const dirs: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** `ompbot init` in a child process whose HOME and OMPBOT_HOME both point into a temp dir. */
function init(args: string[], home: string, path = ""): { code: number; out: string; err: string } {
	const run = Bun.spawnSync([process.execPath, MAIN, "init", ...args], {
		env: { HOME: join(home, ".."), OMPBOT_HOME: home, PATH: path },
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

const mode = (path: string): number => statSync(path).mode & 0o777;

function filesUnder(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name));
}

function freshHome(): string {
	return join(tempDir("ompbot-init-"), ".ompbot");
}

describe("ompbot init", () => {
	test("AC-1: creates home, secrets, workspace, config.json; loadConfig accepts it once tokens exist", () => {
		const home = freshHome();
		const run = init(["--owner", OWNER, "--omp", process.execPath], home);
		expect(run.err).toBe("");
		expect(run.code).toBe(0);
		expect(mode(home)).toBe(0o700);
		expect(mode(join(home, "secrets"))).toBe(0o700);
		expect(statSync(join(home, "workspace")).isDirectory()).toBe(true);
		expect(mode(join(home, "config.json"))).toBe(0o600);
		expect(run.out).toContain(join(home, "secrets", "slack-bot-token"));
		expect(run.out).toContain("doctor");

		writeFileSync(join(home, "secrets", "slack-bot-token"), "xoxb-TEST-0\n", { mode: 0o600 });
		writeFileSync(join(home, "secrets", "slack-app-token"), "xapp-TEST-0\n", { mode: 0o600 });
		const config = loadConfig(home);
		expect(config.ownerSlackUserId).toBe(OWNER);
		expect(config.ompExecutable).toBe(process.execPath);
		expect(config.workspaceDir).toBe(join(home, "workspace"));
		expect(config.slack.botTokenFile).toBe(join(home, "secrets", "slack-bot-token"));
		expect(config.slack.appTokenFile).toBe(join(home, "secrets", "slack-app-token"));
		expect(config.sessionRetentionDays).toBe(30);
	});

	test("AC-1: --workspace is used as an absolute workspaceDir; --omp falls back to omp on PATH", () => {
		const home = freshHome();
		const bin = tempDir("ompbot-init-bin-");
		const omp = join(bin, "omp");
		writeFileSync(omp, "#!/bin/sh\n");
		chmodSync(omp, 0o755);
		const workspace = join(tempDir("ompbot-init-ws-"), "work");
		const run = init(["--owner", OWNER, "--workspace", workspace], home, bin);
		expect(run.err).toBe("");
		expect(run.code).toBe(0);
		const raw = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
		expect(raw.ompExecutable).toBe(omp);
		expect(raw.workspaceDir).toBe(workspace);
		expect(statSync(workspace).isDirectory()).toBe(true);
	});

	test("AC-2: an existing config.json is left byte-identical and init exits 2", () => {
		const home = freshHome();
		mkdirSync(home, { recursive: true, mode: 0o700 });
		const before = '{"schemaVersion": 1, "mine": true}\n';
		writeFileSync(join(home, "config.json"), before, { mode: 0o600 });
		const run = init(["--owner", OWNER, "--omp", process.execPath], home);
		expect(run.code).toBe(2);
		expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
		expect(readdirSync(home)).toEqual(["config.json"]);
	});

	for (const [name, args] of [
		["missing --owner", ["--omp", process.execPath]],
		["lowercase owner", ["--owner", "u0123456789", "--omp", process.execPath]],
		["channel id as owner", ["--owner", "C0123456789", "--omp", process.execPath]],
		["too short owner", ["--owner", "U0123", "--omp", process.execPath]],
	] as Array<[string, string[]]>) {
		test(`AC-2: ${name} exits 2 and creates nothing`, () => {
			const home = freshHome();
			const run = init(args, home);
			expect(run.code).toBe(2);
			expect(run.err).not.toBe("");
			expect(existsSync(home)).toBe(false);
		});
	}

	test("no omp on PATH and no --omp exits 2 and creates nothing", () => {
		const home = freshHome();
		const run = init(["--owner", OWNER], home, tempDir("ompbot-init-empty-path-"));
		expect(run.code).toBe(2);
		expect(run.err).toContain("omp");
		expect(existsSync(home)).toBe(false);
	});

	test("AC-3: secrets stays empty and no file under the home holds a token prefix", () => {
		const home = freshHome();
		expect(init(["--owner", OWNER, "--omp", process.execPath], home).code).toBe(0);
		expect(readdirSync(join(home, "secrets"))).toEqual([]);
		const files = filesUnder(home);
		expect(files).toContain(join(home, "config.json"));
		for (const file of files) {
			const text = readFileSync(file, "utf8");
			expect(text).not.toContain("xoxb-");
			expect(text).not.toContain("xapp-");
		}
	});
});
