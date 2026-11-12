import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCli } from "../src/cli";
import { boardSourceFor } from "../src/cli/dashboard";
import { openStore } from "../src/store/db";
import { makeHome, type TestHome } from "./helpers/bot-home";

const MAIN = join(resolve(import.meta.dir, ".."), "src", "main.ts");
const SNAPSHOT_KEYS = [
	"generatedAt",
	"timezone",
	"daemon",
	"turns",
	"feedback",
	"tasks",
	"flows",
	"lanes",
	"herdr",
	"approvals",
	"monitors",
	"alerts",
	"gates",
	"backup",
	"jobs",
	"slackTeam",
	"slackOff",
	"discordGuild",
];

let home: TestHome;
let proc: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;

beforeEach(() => {
	home = makeHome("ompbot-dash-cli-");
	openStore({
		timezone: "Asia/Seoul",
		path: join(home.dir, "ompbot.db"),
		clock: { now: () => Date.now() },
		redact: (text) => text,
	}).close();
});
afterEach(async () => {
	if (proc !== undefined) {
		proc.kill("SIGKILL");
		await proc.exited;
		proc = undefined;
	}
	home.remove();
});

/** A loopback port nothing listens on right now. */
function freePort(): number {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
	const port = probe.port as number;
	probe.stop(true);
	return port;
}

function setDashboardConfig(dashboard: unknown, extra: Record<string, unknown> = {}): void {
	const path = join(home.dir, "config.json");
	writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), dashboard, ...extra }));
}

/** Starts `ompbot dashboard …` and resolves with its URL once it printed the listening line (bounded wait). */
async function startDashboard(args: string[]): Promise<string> {
	const child = Bun.spawn([process.execPath, MAIN, "dashboard", ...args], {
		env: { OMPBOT_HOME: home.dir, HOME: home.dir, PATH: process.env.PATH ?? "/usr/bin:/bin" },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	proc = child;
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let text = "";
	// Not a sleep: the wait is for the listening line; this only bounds it (a hung child is killed → read ends).
	const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
	try {
		while (!text.includes("\n")) {
			const { value, done } = await reader.read();
			if (done) throw new Error(`dashboard exited before listening: ${await new Response(child.stderr).text()}`);
			text += decoder.decode(value);
		}
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
	const match = /^dashboard listening url=(\S+)\n/.exec(text);
	if (match === null) throw new Error(`unexpected first line: ${text}`);
	return match[1] as string;
}

describe("ompbot dashboard", () => {
	test("AC-1: --port <p> serves HTML at / and the snapshot JSON at /api/snapshot and /x/api/snapshot", async () => {
		const port = freePort();
		const url = await startDashboard(["--port", String(port)]);
		expect(url).toBe(`http://127.0.0.1:${port}/`);

		const page = await fetch(url);
		expect(page.status).toBe(200);
		expect(page.headers.get("content-type")).toStartWith("text/html");
		expect(await page.text()).toContain("ompbot 현황판");

		for (const path of ["api/snapshot", "x/api/snapshot"]) {
			const response = await fetch(`${url}${path}`);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toStartWith("application/json");
			const body = (await response.json()) as Record<string, unknown>;
			expect(Object.keys(body)).toEqual(SNAPSHOT_KEYS);
			expect(body.daemon).toMatchObject({ ok: true, running: false });
		}

		proc?.kill("SIGTERM");
		expect(await proc?.exited).toBe(0);
		proc = undefined;
	});

	test("config dashboard.port is used when no --port is given", async () => {
		const port = freePort();
		setDashboardConfig({ port });
		expect(await startDashboard([])).toBe(`http://127.0.0.1:${port}/`);
		expect(await (await fetch(`http://127.0.0.1:${port}/healthz`)).text()).toBe("ok");
	});

	test("AC-9: without herdrBoard no board source starts; the page keeps the herdr agent list block", async () => {
		expect(boardSourceFor(undefined)).toBeUndefined();
		expect(boardSourceFor({})).toBeUndefined();
		expect(boardSourceFor({ herdrBoard: { url: "https://b.test/", api: "http://127.0.0.1:9" } })?.origin).toBe(
			"http://127.0.0.1:9",
		);
		const port = freePort();
		setDashboardConfig({ port }, { herdr: { bin: "/bin/false" } });
		const url = await startDashboard([]);
		const board = await fetch(`${url}api/board`);
		expect(board.status).toBe(404);
		expect(await board.json()).toEqual({ error: "board_disabled" });
		const page = await (await fetch(url)).text();
		expect(page).toContain("herdr 에이전트");
		expect(page).toContain('data-board="0"');
		const snapshot = (await (await fetch(`${url}api/snapshot`)).json()) as {
			herdr: { hosts: Array<{ host: string }> };
		};
		expect(snapshot.herdr.hosts.map((host) => host.host)).toEqual(["local"]);
	});

	test("with herdrBoard the command reads herdr-web-ui's machines stream and serves api/board", async () => {
		const machines = new TextEncoder().encode(
			`data: ${JSON.stringify({
				type: "machines",
				machines: [
					{
						id: "local",
						name: "oci",
						kind: "local",
						state: "connected",
						snapshot: {
							panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1", agent: "omp", agent_status: "idle" }],
						},
					},
				],
			})}\n\n`,
		);
		const methods: string[] = [];
		const upstream = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			idleTimeout: 0,
			fetch(request) {
				methods.push(request.method);
				const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(machines) });
				return new Response(body, { headers: { "content-type": "text/event-stream" } });
			},
		});
		try {
			const port = freePort();
			setDashboardConfig(
				{ port, herdrWebUrl: "https://herdr.example.test/" },
				{
					herdr: { bin: "/bin/false" },
					herdrBoard: { url: "https://b.test/", api: `http://127.0.0.1:${upstream.port}` },
				},
			);
			const url = await startDashboard([]);
			const events = await fetch(`${url}api/board/events`);
			if (events.body === null) throw new Error("no event stream");
			const reader = events.body.getReader();
			const decoder = new TextDecoder();
			let text = "";
			// Waits for the board event itself (the test timeout bounds it): one at once, one when the first list lands.
			while (!text.includes('"ok":true')) {
				const { value, done } = await reader.read();
				if (done) break;
				text += decoder.decode(value, { stream: true });
			}
			await reader.cancel();
			expect(text).toContain('"key":"p1"');
			const board = await fetch(`${url}api/board`);
			expect(board.status).toBe(200);
			const view = (await board.json()) as { cards: Array<{ key: string; replyUrl?: string }> };
			expect(view.cards).toMatchObject([
				{ key: "p1", replyUrl: "https://herdr.example.test/?ws=w1&pane=p1&view=chat" },
			]);
			expect(new Set(methods)).toEqual(new Set(["GET"]));
		} finally {
			upstream.stop(true);
		}
	});

	test("AC-8: no port in flags or config exits 2; a non-loopback --bind exits 2", async () => {
		expect(await runCli(["dashboard"], { OMPBOT_HOME: home.dir })).toBe(2);
		expect(await runCli(["dashboard", "--port", "7331", "--bind", "0.0.0.0"], { OMPBOT_HOME: home.dir })).toBe(2);
		setDashboardConfig({ port: 7331, bind: "0.0.0.0" });
		// The config itself is refused (ConfigError → exit 1) before any port is opened.
		expect(await runCli(["dashboard"], { OMPBOT_HOME: home.dir })).toBe(1);
	});
});
