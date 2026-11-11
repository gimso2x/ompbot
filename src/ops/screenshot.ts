import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type ProcessRunner, realProcessRunner } from "../dispatch/omp";

/** Default width of the one-page briefing drawing (the spec's 1080px column). */
export const BRIEFING_WIDTH = 1080;
/** A capture stage still running after this is killed; the spec allows two stages, so a render can take twice this. */
export const BRIEFING_TIMEOUT_MS = 20_000;
const HEIGHT_MIN = 400;
const HEIGHT_MAX = 4000;
/** The height when the page never wrote one into `<title>` (a page taller than the content still reads well). */
const HEIGHT_FALLBACK = 1600;
/** The tail of a stage's own error kept in a thrown message. */
const STDERR_TAIL = 600;

/**
 * A briefing render is already running. The mailbox answers it with one line instead of waiting: the owner asked for
 * one picture, and a second chromium would only race the first for the same CPU.
 */
export class BriefingBusyError extends Error {
	constructor() {
		super("다른 브리핑을 그리는 중입니다");
		this.name = "BriefingBusyError";
	}
}

export interface RenderPngOptions {
	/** The chromium executable (`config.briefing.chromium`, else `chromium` from PATH). */
	chromium: string;
	width: number;
	timeoutMs: number;
	/** Injected in tests; the bot's own process runner by default. */
	run?: ProcessRunner;
}

/** The browser's own view of a finished page: the title it wrote and the image it drew. */
interface StageResult {
	stdout: string;
	stderr: string;
	code: number | null;
	timedOut: boolean;
}

/**
 * One briefing page to one PNG: chromium measures the document height in `--dump-dom` (the page writes its
 * `scrollHeight` into `<title>` on `load`), then a second run screenshots the same temp file at exactly that size.
 * One render at a time per process; a call while one runs rejects at once with {@link BriefingBusyError}.
 */
export async function renderPng(
	html: string,
	outPath: string,
	opts: RenderPngOptions,
): Promise<{ width: number; height: number }> {
	if (rendering) throw new BriefingBusyError();
	rendering = true;
	try {
		return await capture(html, outPath, opts);
	} finally {
		rendering = false;
	}
}

/** The one-render-at-a-time flag. The CLI is a separate process, so it never blocks the daemon's render. */
let rendering = false;

async function capture(
	html: string,
	outPath: string,
	opts: RenderPngOptions,
): Promise<{ width: number; height: number }> {
	const run = opts.run ?? realProcessRunner;
	// A private directory per render: two different callers never share (or delete) each other's page.
	const dir = await mkdtemp(join(tmpdir(), "ompbot-briefing-"));
	const page = join(dir, "briefing.html");
	try {
		await writeFile(page, html, "utf8");
		const url = `file://${page}`;
		const measured = await stage(
			run,
			[opts.chromium, "--headless=new", "--no-sandbox", "--disable-gpu", "--dump-dom", url],
			opts,
			"높이를 재는 중",
		);
		const height = heightOf(measured.stdout);
		await stage(
			run,
			[
				opts.chromium,
				"--headless=new",
				"--no-sandbox",
				"--disable-gpu",
				"--hide-scrollbars",
				`--window-size=${opts.width},${height}`,
				`--screenshot=${outPath}`,
				url,
			],
			opts,
			"그림을 그리는 중",
		);
		if (!existsSync(outPath)) throw new Error(`${basename(outPath)} 파일을 만들지 못했습니다`);
		return { width: opts.width, height };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Runs one chromium stage: a timeout or a non-zero exit becomes a thrown message carrying the browser's own words. */
async function stage(run: ProcessRunner, cmd: string[], opts: RenderPngOptions, doing: string): Promise<StageResult> {
	const result = await run(cmd, { timeoutMs: opts.timeoutMs });
	if (result.timedOut) throw new Error(`브리핑 ${doing} 중 시간 초과(${opts.timeoutMs}ms): 프로세스를 중단했습니다`);
	if (result.code !== 0) throw new Error(`브리핑 ${doing} 실패: ${reasonOf(result)}`);
	return {
		stdout: result.stdout,
		stderr: result.stderr ?? "",
		code: result.code,
		timedOut: result.timedOut,
	};
}

/**
 * The last stderr line, else the head of stdout: a spawn failure (`{code: null, stdout: "spawn failed: …"}`,
 * `src/dispatch/omp.ts`) writes no stderr at all, and its one line is the only account of what happened.
 */
function reasonOf(result: { stdout: string; stderr?: string | undefined }): string {
	const stderr = (result.stderr ?? "").trim();
	if (stderr !== "") {
		const lines = stderr
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "");
		return (lines.at(-1) ?? stderr).slice(0, STDERR_TAIL);
	}
	return result.stdout.trim().slice(0, 200) || "(이유 없음)";
}

/** The height the page wrote into `<title>`, cut to the drawing's bounds; a page without a number reads 1600. */
function heightOf(html: string): number {
	const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
	const height = Number(title);
	if (title === "" || !Number.isFinite(height) || height <= 0) return HEIGHT_FALLBACK;
	return Math.min(HEIGHT_MAX, Math.max(HEIGHT_MIN, Math.round(height)));
}
