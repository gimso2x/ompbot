import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const MAIN = join(REPO, "src", "main.ts");
const UNITS = [
	"ompbot-backup.service",
	"ompbot-backup.timer",
	"ompbot-gc.service",
	"ompbot-gc.timer",
	"ompbot.service",
];
const SERVICES = UNITS.filter((name) => name.endsWith(".service"));

const dirs: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** `ompbot units render …` with HOME in a temp dir; OMPBOT_HOME only when given. */
function render(args: string[], home: string, ompbotHome?: string): { code: number; out: string; err: string } {
	const run = Bun.spawnSync([process.execPath, MAIN, "units", "render", ...args], {
		env: { HOME: home, PATH: "/usr/bin:/bin", ...(ompbotHome === undefined ? {} : { OMPBOT_HOME: ompbotHome }) },
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

/** Dry-run output split back into `# <file>` sections. */
function sections(out: string): Map<string, string> {
	const result = new Map<string, string>();
	for (const chunk of out.split(/^# (?=\S+\.(?:service|timer)$)/m).slice(1)) {
		const newline = chunk.indexOf("\n");
		result.set(chunk.slice(0, newline), chunk.slice(newline + 1));
	}
	return result;
}

describe("ompbot units render --dry-run", () => {
	test("AC-4: placeholders and owner paths are gone; ExecStart is this bun and this checkout", () => {
		const home = tempDir("ompbot-units-home-");
		const run = render(["--dry-run"], home);
		expect(run.err).toBe("");
		expect(run.code).toBe(0);
		expect(run.out).not.toMatch(/@[A-Z_]+@/);
		// The renderer's own inputs (this bun, this checkout, the temp HOME) may live under a user's /home;
		// no other home path (a hardcoded owner path) may appear in the output.
		const scrubbed = run.out
			.replaceAll(process.execPath, "<bun>")
			.replaceAll(REPO, "<repo>")
			.replaceAll(dirname(process.execPath), "<bun-dir>")
			.replaceAll(home, "<home>");
		expect(scrubbed).not.toContain("/home/");

		const units = sections(run.out);
		expect([...units.keys()].sort()).toEqual(UNITS);
		for (const [name, command] of [
			["ompbot.service", "daemon"],
			["ompbot-backup.service", "backup"],
			["ompbot-gc.service", "gc"],
		] as const) {
			expect(units.get(name)).toContain(`\nExecStart=${process.execPath} ${join(REPO, "src", "main.ts")} ${command}\n`);
		}
		expect(units.get("ompbot.service")?.split("\n")).toEqual(
			expect.arrayContaining(["KillMode=mixed", "TimeoutStopSec=90"]),
		);
		const path =
			units
				.get("ompbot.service")
				?.split("\n")
				.find((line) => line.startsWith("Environment=PATH="))
				?.slice("Environment=PATH=".length)
				.split(":") ?? [];
		expect(path[0]).toBe(dirname(process.execPath));
		expect(path).toContain(join(home, ".local", "bin"));
		expect(path).toContain(join(home, ".bun", "bin"));
		expect(path.slice(-3)).toEqual(["/usr/local/bin", "/usr/bin", "/bin"]);
		expect(new Set(path).size).toBe(path.length);
		expect(run.out).not.toContain("Environment=OMPBOT_HOME=");
	});

	test("AC-4: OMPBOT_HOME adds one Environment=OMPBOT_HOME= line to every .service and none to timers", () => {
		const home = tempDir("ompbot-units-home-");
		const ompbotHome = join(home, "bot-home");
		const run = render(["--dry-run"], home, ompbotHome);
		expect(run.code).toBe(0);
		const units = sections(run.out);
		for (const name of UNITS) {
			const lines = units.get(name)?.split("\n") ?? [];
			const env = lines.filter((line) => line.startsWith("Environment=OMPBOT_HOME="));
			expect(env).toEqual(SERVICES.includes(name) ? [`Environment=OMPBOT_HOME=${ompbotHome}`] : []);
		}
	});
});

describe("ompbot units render --out", () => {
	test("AC-5: writes all units, a second run with the same content exits 0", () => {
		const home = tempDir("ompbot-units-home-");
		const out = join(tempDir("ompbot-units-out-"), "user");
		const first = render(["--out", out], home);
		expect(first.err).toBe("");
		expect(first.code).toBe(0);
		expect(readdirSync(out).sort()).toEqual(UNITS);
		const dry = sections(render(["--dry-run"], home).out);
		for (const name of UNITS) expect(readFileSync(join(out, name), "utf8")).toBe(dry.get(name) ?? "");
		expect(first.out).toContain("systemctl --user daemon-reload");

		const again = render(["--out", out], home);
		expect(again.code).toBe(0);
	});

	test("AC-5: a different existing unit is not overwritten, nothing else is written, exit 2 names it", () => {
		const home = tempDir("ompbot-units-home-");
		const out = tempDir("ompbot-units-out-");
		expect(render(["--out", out], home).code).toBe(0);
		const mine = "[Service]\nExecStart=/opt/my/bun /opt/my/ompbot/src/main.ts daemon\n";
		writeFileSync(join(out, "ompbot.service"), mine);
		rmSync(join(out, "ompbot-gc.timer"));

		const run = render(["--out", out], home);
		expect(run.code).toBe(2);
		expect(run.err).toContain(join(out, "ompbot.service"));
		expect(readFileSync(join(out, "ompbot.service"), "utf8")).toBe(mine);
		expect(existsSync(join(out, "ompbot-gc.timer"))).toBe(false);
	});
});
