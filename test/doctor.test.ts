// `ompbot doctor`'s Discord lines (doc/plans/discord-channel.md TASK 4): token file mode, GET /users/@me and
// GET /gateway/bot, on a fake fetch; nothing when Discord is off.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OmpbotConfig } from "../src/config";
import { checkDiscord, countOmpModels } from "../src/daemon/doctor";
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
