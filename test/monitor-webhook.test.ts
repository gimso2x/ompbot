import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../src/config";
import { Daemon } from "../src/daemon/daemon";
import { createLogger } from "../src/log";
import { type MonitorEventRow, type MonitorLedger, type MonitorRow, openMonitorLedger } from "../src/monitors/ledger";
import { buildMonitorPrompt, buildProcedureBlocks } from "../src/monitors/scheduler";
import {
	MAX_PROCEDURE_BYTES,
	type MonitorSpec,
	MonitorSpecError,
	mergeMonitorSpec,
	parseMonitorSpec,
} from "../src/monitors/spec";
import { WEBHOOK_MAX_BODY_BYTES, WEBHOOK_MAX_PAYLOAD_BYTES, WebhookServer, webhookUrl } from "../src/monitors/webhook";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { SlackChannel } from "../src/slack/channel";
import { makeHome, type TestHome, WaitingTransport } from "./helpers/bot-home";

const NOW = Date.parse("2026-10-19T06:00:00Z");
let home: TestHome;
let ledger: MonitorLedger;
let logLines: string[];
let now = NOW;
let scriptsRoot: string;
let workspaceDir: string;

const ctx = () => ({ scriptsRoot, workspaceDir, webhook: { port: 1 } });
const log = () => createLogger({ sink: (line) => logLines.push(line), clock: { now: () => now }, redact });

beforeEach(() => {
	home = makeHome("ompbot-webhook-");
	scriptsRoot = join(home.dir, "scripts");
	mkdirSync(scriptsRoot);
	workspaceDir = home.config.workspaceDir;
	logLines = [];
	now = NOW;
	ledger = openMonitorLedger(join(home.dir, "ompbot.db"), { now: () => now });
});

afterEach(() => {
	ledger.close();
	home.remove();
});

function addWebhook(overrides: Partial<MonitorSpec> = {}): MonitorRow {
	return ledger.addMonitor(
		parseMonitorSpec({ name: "hook", trigger: { kind: "webhook" }, instruction: "x", ...overrides }, ctx()),
	);
}

function tokenOf(row: MonitorRow): string {
	if (row.trigger.kind !== "webhook") throw new Error("not a webhook monitor");
	return row.trigger.token;
}

function idOf(row: MonitorRow): string {
	if (row.trigger.kind !== "webhook") throw new Error("not a webhook monitor");
	return row.trigger.id;
}

describe("webhook trigger spec", () => {
	test("a new monitor draws a 128-bit id and a token; an update keeps both", () => {
		const a = addWebhook({ name: "a" });
		const b = addWebhook({ name: "b" });
		expect(idOf(a)).toMatch(/^[0-9a-f]{32}$/);
		expect(tokenOf(a)).toMatch(/^[0-9a-f]{64}$/);
		expect(idOf(a)).not.toBe(idOf(b));
		expect(tokenOf(a)).not.toBe(tokenOf(b));
		const saved = parseMonitorSpec({ name: "a", trigger: { kind: "webhook" }, instruction: "x" }, ctx());
		const kept = mergeMonitorSpec(saved, { trigger: { kind: "webhook" }, instruction: "y" }, ctx());
		expect(kept.trigger).toEqual(saved.trigger);
	});

	test("refused without config.webhook, and extra trigger fields are refused", () => {
		const input = { name: "h", trigger: { kind: "webhook" }, instruction: "x" };
		expect(() => parseMonitorSpec(input, { scriptsRoot, workspaceDir })).toThrow(/webhook/);
		expect(() => parseMonitorSpec({ ...input, trigger: { kind: "webhook", token: "mine" } }, ctx())).toThrow(
			MonitorSpecError,
		);
	});

	test("the listing text carries the path but never the token", () => {
		const row = addWebhook();
		const text = JSON.stringify(
			ledger.listMonitors().map((m) => `${m.id} ${m.trigger.kind === "webhook" ? `/hook/${m.trigger.id}` : ""}`),
		);
		expect(text).toContain(`/hook/${idOf(row)}`);
		expect(text).not.toContain(tokenOf(row));
		expect(webhookUrl({ port: 8123, bind: "::1" }, "abc")).toBe("http://[::1]:8123/hook/abc");
	});
});

describe("config.webhook", () => {
	const withWebhook = (value: unknown) => {
		const path = home.config.configPath;
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		writeFileSync(path, JSON.stringify({ ...raw, webhook: value }), { mode: 0o600 });
	};

	test("absent means no listener; loopback binds and a default are accepted", () => {
		expect(loadConfig(home.dir).webhook).toBeUndefined();
		withWebhook({ port: 8123 });
		expect(loadConfig(home.dir).webhook).toEqual({ port: 8123 });
		withWebhook({ port: 8123, bind: "::1" });
		expect(loadConfig(home.dir).webhook).toEqual({ port: 8123, bind: "::1" });
	});

	test("a non-loopback bind or a bad port is a ConfigError", () => {
		for (const bad of [
			{ port: 8123, bind: "0.0.0.0" },
			{ port: 8123, bind: "::" },
			{ port: 8123, bind: "192.168.0.5" },
			{ port: 8123, bind: "localhost" },
			{ port: 0 },
			{ port: 70000 },
			{ port: "80" },
			{ bind: "127.0.0.1" },
			{ port: 8123, host: "0.0.0.0" },
			"8123",
		]) {
			withWebhook(bad);
			expect(() => loadConfig(home.dir)).toThrow(ConfigError);
		}
	});
});

describe("WebhookServer", () => {
	let server: WebhookServer;
	let fired: number;

	beforeEach(() => {
		fired = 0;
		server = new WebhookServer({
			ledger,
			log: log(),
			clock: { now: () => now },
			config: { port: 0 },
			onFired: () => {
				fired += 1;
			},
		});
		expect(server.start()).toBe(true);
	});

	afterEach(() => server.stop());

	const post = (row: MonitorRow, body: string | undefined, headers: Record<string, string> = {}) =>
		fetch(`http://127.0.0.1:${server.port}/hook/${idOf(row)}`, {
			method: "POST",
			body,
			headers: { Authorization: `Bearer ${tokenOf(row)}`, ...headers },
		});

	test("202 with the event id, and the body is the event payload", async () => {
		const row = addWebhook();
		const response = await post(row, "배포 완료 build=42");
		expect(response.status).toBe(202);
		const { eventId } = (await response.json()) as { eventId: number };
		const event = ledger.getEvent(eventId) as MonitorEventRow;
		expect(event).toMatchObject({ monitorId: row.id, stage: "admitted", payload: "배포 완료 build=42" });
		expect(fired).toBe(1);
		// Two posts in the same millisecond are two events, not a duplicate-slot failure.
		const again = (await (await post(row, "second")).json()) as { eventId: number };
		expect(again.eventId).not.toBe(eventId);
		expect(ledger.listEvents({ monitorId: row.id })).toHaveLength(2);
	});

	test("while frozen a post is answered 202 but recorded as skipped, so unfreeze replays nothing", async () => {
		let frozen: object | undefined = { since: "x" };
		const held = new WebhookServer({
			ledger,
			log: log(),
			clock: { now: () => now },
			config: { port: 0 },
			frozen: () => frozen,
		});
		expect(held.start()).toBe(true);
		try {
			const row = addWebhook();
			const url = `http://127.0.0.1:${held.port}/hook/${idOf(row)}`;
			const send = (body: string) =>
				fetch(url, { method: "POST", body, headers: { Authorization: `Bearer ${tokenOf(row)}` } });
			const first = await send("while frozen");
			expect(first.status).toBe(202);
			const { eventId } = (await first.json()) as { eventId: number };
			expect(ledger.getEvent(eventId)).toMatchObject({ stage: "skipped", payload: "frozen\nwhile frozen" });
			frozen = undefined;
			const second = (await (await send("after")).json()) as { eventId: number };
			expect(ledger.getEvent(second.eventId)?.stage).toBe("admitted");
		} finally {
			held.stop();
		}
	});

	test("an empty body admits an event without payload", async () => {
		const row = addWebhook();
		const { eventId } = (await (await post(row, undefined)).json()) as { eventId: number };
		expect(ledger.getEvent(eventId)?.payload).toBeNull();
	});

	test("401 for a missing or wrong token and nothing is admitted", async () => {
		const row = addWebhook();
		const url = `http://127.0.0.1:${server.port}/hook/${idOf(row)}`;
		expect((await fetch(url, { method: "POST", body: "x" })).status).toBe(401);
		expect((await post(row, "x", { Authorization: "Bearer nope" })).status).toBe(401);
		expect((await post(row, "x", { Authorization: tokenOf(row) })).status).toBe(401);
		expect((await post(row, "x", { Authorization: `Bearer ${tokenOf(row)}x` })).status).toBe(401);
		expect(ledger.listEvents()).toEqual([]);
		expect(fired).toBe(0);
	});

	test("404 for an unknown path or id, a disabled monitor, and another monitor's token", async () => {
		const row = addWebhook({ name: "one" });
		const other = addWebhook({ name: "two" });
		const base = `http://127.0.0.1:${server.port}`;
		const auth = { Authorization: `Bearer ${tokenOf(row)}` };
		expect((await fetch(`${base}/`, { method: "POST", headers: auth })).status).toBe(404);
		expect((await fetch(`${base}/hook/`, { method: "POST", headers: auth })).status).toBe(404);
		expect((await fetch(`${base}/hook/${"0".repeat(32)}`, { method: "POST", headers: auth })).status).toBe(404);
		expect((await fetch(`${base}/other/${idOf(row)}`, { method: "POST", headers: auth })).status).toBe(404);
		// Hook two with hook one's token.
		expect((await fetch(`${base}/hook/${idOf(other)}`, { method: "POST", headers: auth })).status).toBe(401);
		ledger.setEnabled(row.id, false);
		expect((await post(row, "x")).status).toBe(404);
		expect(ledger.listEvents()).toEqual([]);
	});

	test("only POST is served", async () => {
		const row = addWebhook();
		const response = await fetch(`http://127.0.0.1:${server.port}/hook/${idOf(row)}`, {
			headers: { Authorization: `Bearer ${tokenOf(row)}` },
		});
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("POST");
	});

	test("413 over 256 KiB, accepted at the limit", async () => {
		const row = addWebhook();
		expect((await post(row, "a".repeat(WEBHOOK_MAX_BODY_BYTES + 1))).status).toBe(413);
		expect(ledger.listEvents()).toEqual([]);
		expect((await post(row, "a".repeat(WEBHOOK_MAX_BODY_BYTES))).status).toBe(202);
	});

	test("a body over 16 KiB is cut on a character boundary and marked", async () => {
		const row = addWebhook();
		// 3-byte characters: the 16 KiB cut falls inside one.
		const { eventId } = (await (await post(row, "가".repeat(10_000))).json()) as { eventId: number };
		const payload = ledger.getEvent(eventId)?.payload ?? "";
		expect(payload).not.toContain("\uFFFD");
		expect(payload).toContain("잘림");
		expect(Buffer.byteLength(payload.split("\n…[잘림")[0] ?? "")).toBeLessThanOrEqual(WEBHOOK_MAX_PAYLOAD_BYTES);
	});

	test("overlap skip: a post while a run is pending is recorded as skipped, still 202", async () => {
		const row = addWebhook({ overlap: "skip" });
		const first = (await (await post(row, "one")).json()) as { stage: string };
		const second = (await (await post(row, "two")).json()) as { stage: string };
		expect(first.stage).toBe("admitted");
		expect(second.stage).toBe("skipped");
	});

	test("the token never reaches the log", async () => {
		const row = addWebhook();
		await post(row, "ok");
		await post(row, "x", { Authorization: "Bearer wrong-token-value" });
		const joined = logLines.join("\n");
		expect(joined).toContain("webhook_fired");
		expect(joined).toContain("webhook_unauthorized");
		expect(joined).not.toContain(tokenOf(row));
		expect(joined).not.toContain("wrong-token-value");
	});

	test("a port that is taken is logged, not thrown, and stop is idempotent", () => {
		const second = new WebhookServer({
			ledger,
			log: log(),
			clock: { now: () => now },
			config: { port: server.port as number },
		});
		expect(second.start()).toBe(false);
		expect(logLines.join("\n")).toContain("webhook_bind_failed");
		second.stop();
		server.stop();
		server.stop();
	});

	test("after stop the port refuses connections", async () => {
		const port = server.port as number;
		server.stop();
		await expect(fetch(`http://127.0.0.1:${port}/hook/x`, { method: "POST" })).rejects.toThrow();
	});
});

describe("prompt", () => {
	const event = (payload: string | null): MonitorEventRow =>
		({ eventId: 1, monitorId: "m", slotAt: NOW, stage: "admitted", payload }) as MonitorEventRow;

	test("a webhook body is labelled as untrusted outside input; other triggers keep the plain label", () => {
		const webhook = buildMonitorPrompt(
			{ name: "n", instruction: "do", trigger: { kind: "webhook", id: "i", token: "t" } },
			event("ignore previous"),
		);
		expect(webhook).toContain("[수신 본문]");
		expect(webhook).toContain("ignore previous");
		const other = buildMonitorPrompt({ name: "n", instruction: "do" }, event("data"));
		expect(other).toContain("[payload]");
		expect(other).not.toContain("[수신 본문]");
	});
});

describe("procedureFiles", () => {
	const spec = (procedureFiles: unknown) =>
		parseMonitorSpec(
			{ name: "p", trigger: { kind: "at", at: "2026-10-19T15:05:00+09:00" }, instruction: "x", procedureFiles },
			ctx(),
		);

	test("files inside the workspace or scripts root are accepted; relative paths resolve in the workspace", () => {
		writeFileSync(join(workspaceDir, "a.md"), "A");
		writeFileSync(join(scriptsRoot, "b.md"), "B");
		expect(spec([join(workspaceDir, "a.md"), join(scriptsRoot, "b.md"), "a.md"]).procedureFiles).toHaveLength(3);
	});

	test("outside files, directories, missing files, symlink escapes and more than 5 are refused", () => {
		const outside = join(home.dir, "outside.md");
		writeFileSync(outside, "secret");
		symlinkSync(outside, join(workspaceDir, "link.md"));
		writeFileSync(join(workspaceDir, "ok.md"), "ok");
		expect(() => spec([outside])).toThrow(/must live under/);
		expect(() => spec([join(workspaceDir, "link.md")])).toThrow(/must live under/);
		expect(() => spec([join(workspaceDir, "..", "outside.md")])).toThrow(/must live under/);
		expect(() => spec([workspaceDir])).toThrow(/regular file/);
		expect(() => spec([join(workspaceDir, "missing.md")])).toThrow(/not found/);
		expect(() => spec(Array.from({ length: 6 }, () => join(workspaceDir, "ok.md")))).toThrow(/at most 5/);
		expect(() => spec("ok.md")).toThrow(/array/);
		expect(() => spec([""])).toThrow(/array/);
	});

	test("update: null clears, an unrelated edit does not recheck kept files", () => {
		writeFileSync(join(workspaceDir, "a.md"), "A");
		const saved = spec([join(workspaceDir, "a.md")]);
		const row = ledger.addMonitor(saved);
		expect(row.procedureFiles).toEqual([join(workspaceDir, "a.md")]);
		// The kept file has since disappeared: renaming still works.
		unlinkSync(join(workspaceDir, "a.md"));
		const renamed = mergeMonitorSpec(saved, { name: "renamed" }, ctx());
		expect(renamed.procedureFiles).toEqual(row.procedureFiles);
		const cleared = mergeMonitorSpec(renamed, { procedureFiles: null }, ctx());
		expect(cleared.procedureFiles).toBeUndefined();
		expect(ledger.updateMonitor(row.id, cleared).procedureFiles).toEqual([]);
	});

	test("each fire reads the file again; a missing or moved file becomes a 읽기 실패 line", () => {
		const file = join(workspaceDir, "proc.md");
		writeFileSync(file, "step one");
		const roots = { workspaceDir, scriptsRoot };
		expect(buildProcedureBlocks([file], roots)).toBe(`[절차 파일 ${file}]\nstep one`);
		writeFileSync(file, "step two");
		expect(buildProcedureBlocks([file], roots)).toContain("step two");
		const outside = join(home.dir, "outside.md");
		writeFileSync(outside, "secret");
		const swapped = join(workspaceDir, "swap.md");
		symlinkSync(outside, swapped);
		const text = buildProcedureBlocks([join(workspaceDir, "gone.md"), swapped, file], roots);
		expect(text).toContain("읽기 실패");
		expect(text).not.toContain("secret");
		expect(text).toContain("step two");
		expect(text.match(/읽기 실패/g)).toHaveLength(2);
	});

	test("the total is capped at 64 KiB: the file that crosses it is cut and marked, later ones are skipped", () => {
		const big = join(workspaceDir, "big.md");
		const next = join(workspaceDir, "next.md");
		writeFileSync(big, "가".repeat(30_000));
		writeFileSync(next, "tail");
		const text = buildProcedureBlocks([big, big, next], { workspaceDir, scriptsRoot });
		expect(text).toContain("잘림");
		expect(text).toContain("건너뜀");
		expect(text).not.toContain("tail");
		expect(text).not.toContain("\uFFFD");
		expect(Buffer.byteLength(text)).toBeLessThan(MAX_PROCEDURE_BYTES + 2048);
	});
});

describe("daemon with a webhook monitor", () => {
	test("a POST reaches the omp turn with the body and the procedure file, and the answer is delivered", async () => {
		const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
		const port = probe.port as number;
		await probe.stop(true);
		writeFileSync(join(workspaceDir, "procedure.md"), "PROCEDURE-MARKER 먼저 상태를 확인");
		const transport = new WaitingTransport();
		const sessions = new FakeSessionStore();
		const prompts: string[] = [];
		const daemon = new Daemon({
			config: { ...home.config, webhook: { port } },
			slack: new SlackChannel(transport),
			log: createLogger({ sink: () => undefined, clock: { now: () => Date.now() }, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			driverFactory: (_origin, sessionDir) =>
				new FakeOmpDriver({
					sessionDir,
					store: sessions,
					respond: (prompt) => {
						prompts.push(prompt);
						return "웹훅 처리 완료";
					},
				}),
		});
		try {
			await daemon.start();
			const row = daemon.store.monitors.addMonitor(
				parseMonitorSpec(
					{
						name: "deploys",
						trigger: { kind: "webhook" },
						instruction: "배포 알림을 요약",
						procedureFiles: [join(workspaceDir, "procedure.md")],
					},
					{ scriptsRoot, workspaceDir, webhook: { port } },
				),
			);
			const response = await fetch(`http://127.0.0.1:${port}/hook/${idOf(row)}`, {
				method: "POST",
				body: "BODY-MARKER build 42 ok",
				headers: { Authorization: `Bearer ${tokenOf(row)}` },
			});
			expect(response.status).toBe(202);
			await transport.waitForPosts((text) => text.startsWith("⏰ "));
			expect(prompts).toHaveLength(1);
			expect(prompts[0]).toContain("BODY-MARKER build 42 ok");
			expect(prompts[0]).toContain("[수신 본문]");
			expect(prompts[0]).toContain("PROCEDURE-MARKER");
			expect(transport.posts((text) => text.startsWith("⏰ "))[0]?.text).toBe("⏰ deploys\n웹훅 처리 완료");
		} finally {
			await daemon.stop();
		}
		await expect(fetch(`http://127.0.0.1:${port}/hook/x`, { method: "POST" })).rejects.toThrow();
	});

	test("a taken port does not stop the daemon", async () => {
		const blocker = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
		const daemon = new Daemon({
			config: { ...home.config, webhook: { port: blocker.port as number } },
			slack: new SlackChannel(new WaitingTransport()),
			log: log(),
			ompVersion: "omp-test 0",
			bootId: "boot",
			driverFactory: (_origin, sessionDir) =>
				new FakeOmpDriver({ sessionDir, store: new FakeSessionStore(), respond: () => "x" }),
		});
		try {
			await daemon.start();
			expect(logLines.join("\n")).toContain("webhook_bind_failed");
		} finally {
			await daemon.stop();
			await blocker.stop(true);
		}
	});
});
