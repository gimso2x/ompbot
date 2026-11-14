import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callDaemon, startIpcServer } from "../src/daemon/ipc";
import { acceptanceItems } from "../src/tasks/docs";
import { openTaskLedger } from "../src/tasks/ledger";
import { runCliCapture } from "./helpers/daemon-process";

let home: string;
const stops: Array<() => void> = [];

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ompbot-tasks-ipc-"));
});

afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	rmSync(home, { recursive: true, force: true });
});

function serve(handler: (request: unknown) => Promise<unknown>): string {
	const path = join(home, "ompbot.sock");
	const server = startIpcServer(path, handler);
	stops.push(() => server.stop());
	return path;
}

describe("tasks CLI (qa-i low)", () => {
	test("tasks list on a home without a ledger does not create one", async () => {
		const result = await runCliCapture(home, ["tasks", "list"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("no tasks\n");
		expect(existsSync(join(home, "ompbot.db"))).toBe(false);
	});

	test("a daemon that answers ok:false is reported as refusing, not as unreachable", async () => {
		const ledger = openTaskLedger(join(home, "ompbot.db"), "Asia/Seoul");
		const row = ledger.register({
			title: "t",
			risk: "L2",
			originKey: "slack/dm/D1/t/1.1",
			threadRef: "D1:1.1",
			host: null,
			repo: "/r/repo",
			acceptance: acceptanceItems(["a"]),
		});
		ledger.close();
		serve(async () => ({ ok: false, error: "task not found" }));
		const result = await runCliCapture(home, ["tasks", "close", row.taskId, "--as", "cancelled"]);
		expect(result.code).toBe(0);
		expect(result.stderr).toContain("daemon refused: task not found");
		expect(result.stderr).not.toContain("not reachable");
	});
});

describe("daemon IPC (qa-i low)", () => {
	test("a timeout past the 32-bit timer limit is cut to it", async () => {
		const path = serve(async () => ({ ok: true }));
		const delays: unknown[] = [];
		const realSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = ((handler: () => void, delay?: number, ...rest: unknown[]) => {
			delays.push(delay);
			return realSetTimeout(handler, delay, ...rest);
		}) as typeof setTimeout;
		try {
			expect(await callDaemon(path, { op: "x" }, 2 ** 31 + 5)).toEqual({ ok: true });
		} finally {
			globalThis.setTimeout = realSetTimeout;
		}
		expect(Math.max(...(delays as number[]))).toBeLessThanOrEqual(2 ** 31 - 1);
	});

	test("a character split across chunks reaches the handler whole", async () => {
		const received: unknown[] = [];
		const path = serve(async (request) => {
			received.push(request);
			return { ok: true };
		});
		const bytes = Buffer.from(`${JSON.stringify({ text: "가나다" })}\n`);
		const closed = Promise.withResolvers<void>();
		const socket = await Bun.connect({
			unix: path,
			socket: {
				async open(s) {
					// One byte per write, a macrotask apart: the server reads them as separate chunks.
					for (const byte of bytes) {
						s.write(Buffer.from([byte]));
						s.flush();
						await new Promise((resolve) => setImmediate(resolve));
					}
				},
				data() {},
				close() {
					closed.resolve();
				},
			},
		});
		await closed.promise;
		socket.end();
		expect(received).toEqual([{ text: "가나다" }]);
	});

	test("a reply split inside a character reads whole in callDaemon", async () => {
		const path = join(home, "split.sock");
		const reply = Buffer.from(`${JSON.stringify({ text: "가나다" })}\n`);
		const listener = Bun.listen({
			unix: path,
			socket: {
				async data(s) {
					for (const byte of reply) {
						s.write(Buffer.from([byte]));
						s.flush();
						await new Promise((resolve) => setImmediate(resolve));
					}
					s.end();
				},
			},
		});
		stops.push(() => listener.stop(true));
		expect(await callDaemon(path, { op: "x" }, 10_000)).toEqual({ text: "가나다" });
	});

	test("a request far past the socket buffer arrives whole", async () => {
		const path = serve(async (request) => ({ length: (request as { blob: string }).blob.length }));
		const blob = "x".repeat(4 * 1024 * 1024);
		expect(await callDaemon(path, { blob }, 10_000)).toEqual({ length: blob.length });
	});
});
