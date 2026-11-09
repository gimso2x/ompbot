import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const MAIN = join(REPO, "src", "main.ts");
const UNITS = [
	"ompbot-backup.service",
	"ompbot-backup.timer",
	"ompbot-dashboard.service",
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
			["ompbot-dashboard.service", "dashboard"],
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

describe("ompbot units render --instance", () => {
	const INSTANCE_UNITS = [
		"ompbot-tteok-backup.service",
		"ompbot-tteok-backup.timer",
		"ompbot-tteok-gc.service",
		"ompbot-tteok-gc.timer",
		"ompbot-tteok.service",
	];

	test("renames every unit, drops the dashboard and keeps the instance's OMPBOT_HOME", () => {
		const home = tempDir("ompbot-units-home-");
		const ompbotHome = join(home, "tteok-home");
		const run = render(["--instance", "tteok", "--dry-run"], home, ompbotHome);
		expect(run.err).toBe("");
		expect(run.code).toBe(0);
		expect(run.out).toContain("# ompbot-tteok.service\n");
		expect(run.out).not.toContain("ompbot-dashboard");
		const units = sections(run.out);
		expect([...units.keys()].sort()).toEqual(INSTANCE_UNITS);
		for (const name of INSTANCE_UNITS.filter((unit) => unit.endsWith(".service"))) {
			expect(units.get(name)?.split("\n")).toContain(`Environment=OMPBOT_HOME=${ompbotHome}`);
		}
		expect(units.get("ompbot-tteok.service")).toContain("Description=ompbot-tteok (Slack bot");
		expect(units.get("ompbot-tteok-gc.service")).toContain("\nAfter=ompbot-tteok-backup.service\n");
		expect(units.get("ompbot-tteok-backup.timer")).toContain("Description=ompbot-tteok daily backup timer");
	});

	test("without --instance the rendered units are the unchanged ones", () => {
		const home = tempDir("ompbot-units-home-");
		const plain = render(["--dry-run"], home, join(home, "h"));
		expect([...sections(plain.out).keys()].sort()).toEqual(UNITS);
		expect(plain.out).not.toContain("ompbot-tteok");
	});

	test("rejects a missing OMPBOT_HOME and a bad name with exit 2", () => {
		const home = tempDir("ompbot-units-home-");
		expect(render(["--instance", "tteok", "--dry-run"], home).code).toBe(2);
		for (const bad of ["Tteok", "1a", "a_b", "a".repeat(25), ""]) {
			const run = render(["--instance", bad, "--dry-run"], home, join(home, "h"));
			expect(run.code).toBe(2);
			expect(run.out).toBe("");
		}
	});

	test("--out writes the instance files", () => {
		const home = tempDir("ompbot-units-home-");
		const out = join(tempDir("ompbot-units-out-"), "user");
		const run = render(["--instance", "tteok", "--out", out], home, join(home, "h"));
		expect(run.code).toBe(0);
		expect(readdirSync(out).sort()).toEqual(INSTANCE_UNITS);
		expect(run.out).toContain("enable --now ompbot-tteok-backup.timer ompbot-tteok-gc.timer");
	});

	test("the peer manifest is the shipped one without slash commands and without turn-feedback reactions", () => {
		const read = (file: string) => JSON.parse(readFileSync(join(REPO, "packaging", file), "utf8"));
		const base = read("slack-manifest.json");
		const peer = read("slack-manifest-peer.json");
		expect(peer.features.slash_commands).toBeUndefined();
		expect([peer.display_information.name, peer.features.bot_user.display_name]).toEqual([
			"ompbot-peer",
			"ompbot-peer",
		]);
		// Owner 👍/👎 feedback is collected by the shipped app only: the peer keeps the message-only subscription.
		const feedback = new Set(["reactions:read", "reaction_added", "reaction_removed"]);
		const withoutFeedback = (list: string[]) => list.filter((entry) => !feedback.has(entry));
		expect(peer.oauth_config).toEqual({ scopes: { bot: withoutFeedback(base.oauth_config.scopes.bot) } });
		expect(peer.settings).toEqual({
			...base.settings,
			event_subscriptions: { bot_events: withoutFeedback(base.settings.event_subscriptions.bot_events) },
		});
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
