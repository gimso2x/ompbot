import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotatingFileSink } from "../src/ops/logfile";
import { pruneMediaFiles } from "../src/ops/media";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-lane-j-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("log rotation (J-13)", () => {
	test("an archive slot that is a directory does not stop rotation or drop lines", () => {
		const path = join(dir, "ompbot.log");
		mkdirSync(`${path}.2`, { recursive: true });
		writeFileSync(join(`${path}.2`, "x"), "x");
		const sink = rotatingFileSink(path, { maxBytes: 20, files: 3 });
		sink("first-line-0123");
		sink("second-line-012");
		sink("third-line-0123");
		expect(readFileSync(path, "utf8")).toBe("third-line-0123\n");
		expect(readFileSync(`${path}.1`, "utf8")).toBe("second-line-012\n");
		expect(readFileSync(`${path}.2`, "utf8")).toBe("first-line-0123\n");
	});
});

describe("media prune (J-17)", () => {
	test("a symlinked media root is not followed: files outside the home survive", () => {
		const outside = join(dir, "outside");
		mkdirSync(outside);
		const victim = join(outside, "keep.txt");
		writeFileSync(victim, "keep");
		const old = (Date.now() - 48 * 60 * 60_000) / 1000;
		utimesSync(victim, old, old);
		const root = join(dir, "media");
		symlinkSync(outside, root);
		expect(pruneMediaFiles(root, Date.now())).toBe(0);
		expect(existsSync(victim)).toBe(true);
	});
});
