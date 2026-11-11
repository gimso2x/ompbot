// AC-2 of T-20261111-01: the chromium capture — two stages with the designed arguments, the height read from
// `<title>` (clamped 400..4000, non-numeric 1600), timeout kills and throws, a failure carries the last stderr line
// (or the stdout of a spawn failure), a second render while one runs is rejected at once, and no temp HTML is left.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessRunner, RunProcessResult } from "../src/dispatch/omp";
import { BriefingBusyError, renderPng } from "../src/ops/screenshot";

const WIDTH = 1080;
const html = "<html><body><h1>briefing</h1></body></html>";

/** A runner that answers each stage from a script and records the calls it saw. */
function fakeRunner(stages: Array<Partial<RunProcessResult> | (() => Partial<RunProcessResult>)>): {
	run: ProcessRunner;
	calls: string[][];
} {
	const calls: string[][] = [];
	const run: ProcessRunner = async (cmd) => {
		calls.push(cmd);
		const stage = stages[calls.length - 1] ?? {};
		const answer = typeof stage === "function" ? await stage() : stage;
		const result = { code: 0, stdout: "", timedOut: false, ...answer };
		// A real chromium writes the named file; the fake writes the PNG signature so the module's "did it exist" check
		// reads the same as in production (a stage that means to fail omits the flag or exits non-zero).
		const out = cmd.find((arg) => arg.startsWith("--screenshot="))?.slice("--screenshot=".length);
		if (out !== undefined && result.code === 0 && !result.timedOut) {
			await Bun.write(out, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		}
		return result;
	};
	return { run, calls };
}

/** The temp file URL of the first call, as a path. */
const htmlPathOf = (call: string[] | undefined): string => {
	const url = call?.find((arg) => arg.startsWith("file://")) ?? "";
	return decodeURIComponent(new URL(url).pathname);
};

const ok = (extra: Partial<RunProcessResult> = {}): Partial<RunProcessResult> => ({ code: 0, ...extra });

describe("AC-2: renderPng", () => {
	test("runs --dump-dom first and --screenshot second, both on the same temp HTML file", async () => {
		const out = join(tmpdir(), `ompbot-shot-${process.pid}-ok.png`);
		const { run, calls } = fakeRunner([ok({ stdout: "<html><head><title>1234</title></head></html>" }), ok({})]);
		const size = await renderPng(html, out, { chromium: "/usr/bin/chromium", width: WIDTH, timeoutMs: 20_000, run });
		expect(size).toEqual({ width: WIDTH, height: 1234 });
		expect(calls).toHaveLength(2);
		const [first, second] = calls;
		expect(first?.slice(0, 5)).toEqual([
			"/usr/bin/chromium",
			"--headless=new",
			"--no-sandbox",
			"--disable-gpu",
			"--dump-dom",
		]);
		expect(second).toContain("--hide-scrollbars");
		expect(second).toContain(`--window-size=${WIDTH},1234`);
		expect(second).toContain(`--screenshot=${out}`);
		// The same single temp file feeds both stages, and it is gone once the render is over.
		const htmlPath = htmlPathOf(first);
		expect(htmlPath).toContain("ompbot-briefing-");
		expect(htmlPathOf(second)).toBe(htmlPath);
		expect(existsSync(htmlPath)).toBe(false);
	});

	test("a height past 4000 is cut to 4000 and a non-numeric title gives 1600", async () => {
		const out = join(tmpdir(), `ompbot-shot-${process.pid}-clamp.png`);
		const tall = fakeRunner([ok({ stdout: "<title>5000</title>" }), ok({})]);
		expect(await renderPng(html, out, { chromium: "chromium", width: WIDTH, timeoutMs: 1000, run: tall.run })).toEqual({
			width: WIDTH,
			height: 4000,
		});
		const tiny = fakeRunner([ok({ stdout: "<title>10</title>" }), ok({})]);
		expect(await renderPng(html, out, { chromium: "chromium", width: WIDTH, timeoutMs: 1000, run: tiny.run })).toEqual({
			width: WIDTH,
			height: 400,
		});
		const garbage = fakeRunner([ok({ stdout: "<title>NaN</title>" }), ok({})]);
		expect(
			await renderPng(html, out, { chromium: "chromium", width: WIDTH, timeoutMs: 1000, run: garbage.run }),
		).toEqual({ width: WIDTH, height: 1600 });
	});

	test("a timed-out stage throws with the timeout and never starts the screenshot stage", async () => {
		const out = join(tmpdir(), `ompbot-shot-${process.pid}-timeout.png`);
		const { run, calls } = fakeRunner([{ code: null, stdout: "", timedOut: true }]);
		await expect(renderPng(html, out, { chromium: "chromium", width: WIDTH, timeoutMs: 1500, run })).rejects.toThrow(
			/시간 초과|timed out/,
		);
		expect(calls).toHaveLength(1);
		expect(existsSync(htmlPathOf(calls[0]))).toBe(false);
	});

	test("a failed stage carries the last stderr line", async () => {
		const out = join(tmpdir(), `ompbot-shot-${process.pid}-stderr.png`);
		const { run } = fakeRunner([
			ok({ stdout: "<title>1600</title>" }),
			{ code: 1, stderr: "line one\nFatal: cannot write screenshot\n" },
		]);
		await expect(renderPng(html, out, { chromium: "chromium", width: WIDTH, timeoutMs: 1000, run })).rejects.toThrow(
			/Fatal: cannot write screenshot/,
		);
	});

	test("a spawn failure with an empty stderr carries the stdout instead", async () => {
		const out = join(tmpdir(), `ompbot-shot-${process.pid}-spawn.png`);
		const { run } = fakeRunner([{ code: null, stdout: "spawn failed: ENOENT chromium", stderr: "" }]);
		await expect(renderPng(html, out, { chromium: "chromium", width: WIDTH, timeoutMs: 1000, run })).rejects.toThrow(
			/spawn failed: ENOENT chromium/,
		);
	});

	test("exit 0 without the output file is a failure too", async () => {
		const out = join(tmpdir(), `ompbot-shot-${process.pid}-missing.png`);
		// Exit 0, no file on disk: the fake never writes one (unlike the shared harness), so only the module's own
		// "did the file appear" check can catch it.
		const run: ProcessRunner = async (cmd) =>
			cmd.some((arg) => arg.startsWith("--screenshot="))
				? { code: 0, stdout: "", stderr: "nothing written", timedOut: false }
				: { code: 0, stdout: "<title>1200</title>", timedOut: false };
		await expect(renderPng(html, out, { chromium: "chromium", width: WIDTH, timeoutMs: 1000, run })).rejects.toThrow(
			/만들지 못/,
		);
	});

	test("a second render while one runs is rejected at once with BriefingBusyError", async () => {
		const out = join(tmpdir(), `ompbot-shot-${process.pid}-busy.png`);
		const release = Promise.withResolvers<void>();
		const first: ProcessRunner = async (cmd) => {
			await release.promise;
			const out = cmd.find((arg) => arg.startsWith("--screenshot="))?.slice("--screenshot=".length);
			if (out !== undefined) await Bun.write(out, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
			return { code: 0, stdout: "<title>1000</title>", timedOut: false };
		};
		const pending = renderPng(html, out, { chromium: "chromium", width: WIDTH, timeoutMs: 1000, run: first });
		// The rejection is immediate: it never waits for the running render to finish.
		const second = renderPng(html, out, { chromium: "chromium", width: WIDTH, timeoutMs: 1000, run: first });
		await expect(second).rejects.toBeInstanceOf(BriefingBusyError);
		await expect(second).rejects.toThrow("다른 브리핑을 그리는 중입니다");
		release.resolve();
		expect(await pending).toEqual({ width: WIDTH, height: 1000 });
		// The flag is released: the next render runs normally.
		const { run } = fakeRunner([ok({ stdout: "<title>900</title>" }), ok({})]);
		expect(await renderPng(html, out, { chromium: "chromium", width: WIDTH, timeoutMs: 1000, run })).toEqual({
			width: WIDTH,
			height: 900,
		});
	});
});

/** `OMPBOT_E2E_CHROMIUM=1` only: a real chromium writes a 1080-wide PNG. */
const chromium = process.env.OMPBOT_E2E_CHROMIUM === "1" ? (Bun.which("chromium") ?? undefined) : undefined;
if (process.env.OMPBOT_E2E_CHROMIUM !== "1") {
	console.log("[skip] screenshot e2e: set OMPBOT_E2E_CHROMIUM=1 to render with a real chromium");
}

// The spec itself gates the real render on OMPBOT_E2E_CHROMIUM=1 (doc/plans/briefing-image.md AC-2): plain `bun test`
// must stay green on hosts without chromium.
const chromiumE2e = describe.skipIf(chromium === undefined); // skipped only where no chromium is installed
chromiumE2e("AC-2: real chromium", () => {
	test("writes a 1080-wide PNG at the measured height", async () => {
		const out = join(tmpdir(), `ompbot-shot-e2e-${process.pid}.png`);
		const page = `<html><head><style>body{margin:0;font-family:sans-serif}div{height:600px}</style></head><body><div>briefing</div><script>window.addEventListener("load",()=>{document.title=String(document.documentElement.scrollHeight)})</script></body></html>`;
		const size = await renderPng(page, out, { chromium: chromium as string, width: WIDTH, timeoutMs: 30_000 });
		const png = readFileSync(out);
		expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		// IHDR width/height are big-endian 32-bit fields at bytes 16 and 20.
		expect(png.readUInt32BE(16)).toBe(WIDTH);
		expect(png.readUInt32BE(20)).toBe(size.height);
		expect(size.height).toBeGreaterThanOrEqual(400);
	});
});
