// `ompbot doctor`'s Discord lines (doc/plans/discord-channel.md TASK 4): token file mode, GET /users/@me and
// GET /gateway/bot, on a fake fetch; nothing when Discord is off.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OmpbotConfig } from "../src/config";
import { checkDiscord, countOmpModels } from "../src/daemon/doctor";
import { readVersion } from "../src/daemon/tools";
import { makeHome, type TestHome, withDiscord } from "./helpers/bot-home";

let home: TestHome;
let lines: string[];
let seen: Array<{ url: string; auth: string | null }>;

const report = (ok: boolean, name: string, detail: string): void => {
	lines.push(`${ok ? "ok" : "fail"} ${name}: ${detail}`);
};

function fakeFetch(answers: Record<string, () => Response>): typeof fetch {
	const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = String(input instanceof Request ? input.url : input);
		seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
		const route = Object.keys(answers).find((path) => url.endsWith(path));
		return route === undefined ? new Response("{}", { status: 404 }) : (answers[route]?.() ?? new Response());
	};
	return Object.assign(impl, { preconnect: fetch.preconnect });
}

const healthy = {
	"/users/@me": () => Response.json({ id: "500000000000000000", username: "ompbot" }),
	"/gateway/bot": () => Response.json({ url: "wss://gateway.discord.gg", shards: 1 }),
};

beforeEach(() => {
	home = makeHome("ompbot-doctor-");
	lines = [];
	seen = [];
});

afterEach(() => home.remove());

describe("doctor: omp models", () => {
	/** A stand-in omp that answers `models --json` with the given script body. */
	function fakeOmp(body: string): string {
		const path = join(home.dir, "fake-omp");
		writeFileSync(path, `#!/bin/sh\n${body}\n`);
		chmodSync(path, 0o755);
		return path;
	}

	test("counts the models a logged-in omp lists, and 0 when no provider is logged in", async () => {
		expect(await countOmpModels(fakeOmp(`echo '{"models":[{"id":"a"},{"id":"b"}]}'`))).toBe(2);
		expect(await countOmpModels(fakeOmp(`echo '{"models":[]}'`))).toBe(0);
	});

	test("a failing, garbled or hanging omp is a reason, not a count", async () => {
		expect(await countOmpModels(fakeOmp("exit 3"))).toBe("omp models exited 3");
		expect(await countOmpModels(fakeOmp("echo not-json"))).toBe("unparsable output");
		expect(await countOmpModels(fakeOmp("exec sleep 5"), 200)).toBe("timeout after 0.2s");
		expect(await countOmpModels(home.dir)).toBe(`cannot run ${home.dir} (EACCES)`);
	});
});

// doc/plans/qa50-low-fixes.md E-4: the `omp --version` probe ran with the daemon's whole env, bot secrets included.
describe("doctor: omp --version probe env", () => {
	const FAKE_SECRETS = { SLACK_BOT_TOKEN: "xoxb-TEST-0", SLACK_APP_TOKEN: "xapp-TEST-0", OMPBOT_TEST_SECRET: "fake" };
	const SRC = join(import.meta.dir, "..", "src");

	/** A stand-in omp that writes the env its `--version` call got to `dump` and answers a version. */
	function envDumpingOmp(path: string, dump: string): void {
		writeFileSync(path, `#!/bin/sh\nif [ "$1" = --version ]; then env > '${dump}'; echo 'omp 9.9.9'; fi\n`);
		chmodSync(path, 0o755);
	}

	/**
	 * Runs `code` in a fresh bun started with the fake secrets in its env, like a daemon whose unit or shell exports
	 * them (a child spawned without `env` inherits the startup env, not later `process.env` writes). Returns stdout.
	 */
	async function inBunWithSecrets(code: string): Promise<string> {
		const proc = Bun.spawn([process.execPath, "-e", code], {
			env: { ...process.env, ...FAKE_SECRETS },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect({ exitCode, err }).toEqual({ exitCode: 0, err: "" });
		return out.trim();
	}

	const namesIn = (dump: string): string[] =>
		readFileSync(dump, "utf8")
			.split("\n")
			.map((line) => line.split("=")[0] ?? "")
			.filter((name) => name !== "");

	const secretNamesIn = (dump: string): string[] =>
		namesIn(dump).filter((name) => name.startsWith("SLACK_") || name.startsWith("OMPBOT_"));

	test("readVersion gives the child no SLACK_/OMPBOT_ env by default", async () => {
		const omp = join(home.dir, "env-omp");
		const dump = join(home.dir, "env.txt");
		envDumpingOmp(omp, dump);
		const version = await inBunWithSecrets(
			`import { readVersion } from ${JSON.stringify(join(SRC, "daemon", "tools"))};
			console.log(await readVersion([${JSON.stringify(omp)}, "--version"]));`,
		);
		expect(version).toBe("omp 9.9.9");
		expect(namesIn(dump)).toContain("PATH");
		expect(secretNamesIn(dump)).toEqual([]);
	});

	test("readVersion runs the child with a caller's env when one is given", async () => {
		const omp = join(home.dir, "env-omp");
		const dump = join(home.dir, "env.txt");
		envDumpingOmp(omp, dump);
		const env = { PATH: process.env.PATH ?? "", PROBE_ONLY: "1" };
		expect(await readVersion([omp, "--version"], 2_000, env)).toBe("omp 9.9.9");
		expect(namesIn(dump)).toContain("PROBE_ONLY");
	});

	test("the doctor's omp line probes the configured omp without the bot's secret env", async () => {
		const dump = join(home.dir, "env.txt");
		envDumpingOmp(home.config.ompExecutable, dump);
		const line = await inBunWithSecrets(
			`import { runDoctor } from ${JSON.stringify(join(SRC, "daemon", "doctor"))};
			const out = [];
			await runDoctor(${JSON.stringify(home.dir)}, (line) => out.push(line));
			console.log(out.find((line) => line.includes(" omp: ")));`,
		);
		expect(line).toContain("omp 9.9.9");
		expect(secretNamesIn(dump)).toEqual([]);
		for (const value of Object.values(FAKE_SECRETS)) expect(readFileSync(dump, "utf8")).not.toContain(value);
	});
});

describe("qa50b I-18: the doctor's bun line", () => {
	test("shows the version of the bun found on PATH, not the running one's", async () => {
		const bin = join(home.dir, "fake-bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "bun"), "#!/bin/sh\necho 0.0.1\n");
		chmodSync(join(bin, "bun"), 0o755);
		const proc = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { runDoctor } from ${JSON.stringify(join(import.meta.dir, "..", "src", "daemon", "doctor"))};
				const out = [];
				await runDoctor(${JSON.stringify(home.dir)}, (line) => out.push(line));
				console.log(out.find((line) => / bun: /.test(line)));`,
			],
			{ env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }, stdout: "pipe", stderr: "pipe" },
		);
		const line = (await new Response(proc.stdout).text()).trim();
		await proc.exited;
		expect(line).toContain(`${join(bin, "bun")} 0.0.1`);
		expect(line).toContain(`running ${Bun.version}`);
	});
});

describe("doctor: discord", () => {
	test("on: token mode, the bot user and the gateway each give one ok discord line; the token never shows", async () => {
		const config: OmpbotConfig = withDiscord(home);
		const token = readFileSync(config.channels.discord?.botTokenFile ?? "", "utf8").trim();
		await checkDiscord(config, report, fakeFetch(healthy));
		expect(lines).toEqual([
			"ok discord token: mode=0600 expected=0600",
			"ok discord users/@me: bot_user_id=500000000000000000 username=ompbot",
			"ok discord gateway/bot: url=wss://gateway.discord.gg",
		]);
		expect(seen.map((s) => s.auth)).toEqual([`Bot ${token}`, `Bot ${token}`]);
		for (const line of lines) expect(line).not.toContain(token);
	});

	test("a refused token (401) is a fail discord line", async () => {
		const config = withDiscord(home);
		await checkDiscord(
			config,
			report,
			fakeFetch({
				"/users/@me": () => Response.json({ message: "401: Unauthorized", code: 0 }, { status: 401 }),
				"/gateway/bot": () => Response.json({ message: "401: Unauthorized", code: 0 }, { status: 401 }),
			}),
		);
		expect(lines[0]).toBe("ok discord token: mode=0600 expected=0600");
		expect(lines[1]?.startsWith("fail discord users/@me: ")).toBe(true);
		expect(lines[1]).toContain("401");
		expect(lines[2]?.startsWith("fail discord gateway/bot: ")).toBe(true);
	});

	test("a token file that is not 0600 fails and no request is made", async () => {
		const config = withDiscord(home);
		chmodSync(config.channels.discord?.botTokenFile ?? "", 0o644);
		await checkDiscord(config, report, fakeFetch(healthy));
		expect(lines).toEqual(["fail discord token: mode=0644 expected=0600"]);
		expect(seen).toHaveLength(0);
	});

	test("off: no discord line and no request", async () => {
		await checkDiscord(home.config, report, fakeFetch(healthy));
		expect(lines).toEqual([]);
		expect(seen).toHaveLength(0);
	});
});
