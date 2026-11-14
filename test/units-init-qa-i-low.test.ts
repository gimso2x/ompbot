import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCliCapture } from "./helpers/daemon-process";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

const dirs: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function render(args: string[], env: Record<string, string>, ompbotHome?: string) {
	return runCliCapture(ompbotHome, ["units", "render", ...args], env);
}

describe("units render: HOME and OMPBOT_HOME values", () => {
	test("HOME with a newline or other control character is refused (exit 2, nothing printed)", async () => {
		for (const home of ["/tmp/a\nExecStartPre=/bin/id", "/tmp/a\tb"]) {
			const run = await render(["--dry-run"], { HOME: home });
			expect(run.code).toBe(2);
			expect(run.stdout).toBe("");
		}
	});

	test("OMPBOT_HOME with a tab is refused", async () => {
		const run = await render(["--dry-run"], { HOME: "/tmp/h" }, "/tmp/a\tb");
		expect(run.code).toBe(2);
		expect(run.stdout).toBe("");
	});

	test("an empty HOME is unset: the default out dir is not relative to the cwd", async () => {
		const cwd = tempDir("ompbot-units-cwd-");
		const before = process.cwd();
		process.chdir(cwd);
		try {
			const run = await render(["--dry-run"], { HOME: "" });
			expect(run.code).toBe(0);
			expect(run.stdout).not.toMatch(/Environment=PATH=[^/\n]*(^|:)\.local/m);
			expect(run.stdout).toMatch(/Environment=PATH=.*:\/(?:[^:\n]+\/)*\.local\/bin:/);
		} finally {
			process.chdir(before);
		}
	});

	test("HOME holding $& or $' is substituted literally", async () => {
		const run = await render(["--dry-run"], { HOME: "/tmp/a$&b$'c" });
		expect(run.code).toBe(0);
		expect(run.stdout).not.toMatch(/@[A-Z_]+@/);
		expect(run.stdout).toContain("/tmp/a$&b$'c/.local/bin");
	});

	test("a % in the checkout-derived paths is escaped for systemd specifiers", async () => {
		const run = await render(["--dry-run"], { HOME: "/tmp/h%x" });
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("/tmp/h%%x/.local/bin");
		expect(run.stdout).not.toMatch(/h%x/);
	});
});

describe("units render: dangling symlinks", () => {
	test("a dangling unit file link is refused and its target is not created", async () => {
		const out = tempDir("ompbot-units-out-");
		const outside = join(tempDir("ompbot-units-outside-"), "evil.txt");
		symlinkSync(outside, join(out, "ompbot.service"));
		const run = await render(["--out", out], { HOME: "/tmp/h" });
		expect(run.code).toBe(2);
		expect(existsSync(outside)).toBe(false);
	});

	test("a dangling --out link is refused with a usage line, not a raw mkdir error", async () => {
		const base = tempDir("ompbot-units-dl-");
		symlinkSync(join(base, "missing"), join(base, "dl"));
		const run = await render(["--out", join(base, "dl")], { HOME: "/tmp/h" });
		expect(run.code).toBe(2);
		expect(run.stderr.startsWith("units: ")).toBe(true);
		expect(existsSync(join(base, "missing"))).toBe(false);
	});
});

describe("init --workspace overlapping the home", () => {
	function init(workspace: (home: string) => string) {
		const root = tempDir("ompbot-init-ws-");
		const home = join(root, ".ompbot");
		const omp = join(root, "omp");
		writeFileSync(omp, "#!/bin/sh\n", { mode: 0o755 });
		const run = Bun.spawnSync(
			[process.execPath, MAIN, "init", "--owner", "U0123456789", "--omp", omp, "--workspace", workspace(home)],
			{ env: { HOME: root, OMPBOT_HOME: home, PATH: "" }, stdout: "pipe", stderr: "pipe" },
		);
		return { code: run.exitCode, err: run.stderr.toString(), home, root };
	}

	test.each([
		["config.json", (home: string) => join(home, "config.json")],
		["secrets", (home: string) => join(home, "secrets")],
		["a dir under secrets", (home: string) => join(home, "secrets", "w")],
		["the home itself", (home: string) => home],
	])("%s is refused with exit 2 and leaves nothing behind", (_label, workspace) => {
		const run = init(workspace);
		expect(run.code).toBe(2);
		expect(run.err).toContain("init: --workspace");
		expect(existsSync(run.home)).toBe(false);
	});

	test("a sibling directory under the home still works", () => {
		const run = init((home) => join(home, "work"));
		expect(run.code, run.err).toBe(0);
	});
});
