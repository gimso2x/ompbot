import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChunkReader,
	createSessionModelReader,
	type SessionModelOrigin,
	TAIL_BYTES,
} from "../src/dashboard/session-model";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-session-model-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const modelChange = (model: string, fallback: boolean, role?: string): string =>
	line({ type: "model_change", model, resolvedModelIsFallback: fallback, ...(role === undefined ? {} : { role }) });
const thinking = (level: string): string =>
	line({ type: "thinking_level_change", thinkingLevel: level, configured: null });
const assistant = (provider: string, model: string): string =>
	line({ type: "message", message: { role: "assistant", provider, model, content: [{ type: "text", text: "답" }] } });
const user = (text: string): string => line({ type: "message", message: { role: "user", content: text } });

const origin = (over: Partial<SessionModelOrigin> = {}): SessionModelOrigin => ({
	sessionDir: dir,
	sessionFile: null,
	model: null,
	thinking: null,
	...over,
});

function session(name: string, body: string): string {
	const file = join(dir, name);
	writeFileSync(file, body);
	return file;
}

const BASE =
	modelChange("anthropic/claude-opus-5-5", false) +
	thinking("high") +
	user("요청") +
	assistant("anthropic", "claude-opus-5-5");

describe("session model", () => {
	test("AC-1: model, thinking and fallback from model_change, thinking_level_change and the last assistant", () => {
		const read = createSessionModelReader();
		session("a.jsonl", BASE);
		expect(read(origin())).toEqual({ model: "anthropic/claude-opus-5-5", thinking: "high", fallback: false });
	});

	test("AC-1: a later fallback model_change makes it a fallback", () => {
		const read = createSessionModelReader();
		session("a.jsonl", BASE + modelChange("zai/glm-5.3", true, "fallback") + assistant("zai", "glm-5.3"));
		expect(read(origin())).toEqual({ model: "zai/glm-5.3", thinking: "high", fallback: true });
	});

	test("AC-1: a !model change before any new assistant reply is not a fallback", () => {
		const read = createSessionModelReader();
		session("a.jsonl", BASE + modelChange("zai/glm-5.3", false));
		expect(read(origin())).toEqual({ model: "anthropic/claude-opus-5-5", thinking: "high", fallback: false });
	});

	test("AC-2: a file past 300KB with model_change at the start and the assistant at the end", () => {
		const read = createSessionModelReader();
		const filler = user("x".repeat(1000)).repeat(320);
		const body =
			modelChange("anthropic/claude-opus-5-5", false) +
			thinking("high") +
			filler +
			assistant("anthropic", "claude-opus-5-5");
		expect(body.length).toBeGreaterThan(300 * 1024);
		session("big.jsonl", body);
		expect(read(origin())).toEqual({ model: "anthropic/claude-opus-5-5", thinking: "high", fallback: false });
	});

	test("AC-2: a file of at most 256KB keeps its first-line model_change", () => {
		const read = createSessionModelReader();
		const body =
			modelChange("anthropic/claude-opus-5-5", false) + thinking("high") + user("y".repeat(1000)).repeat(200);
		expect(body.length).toBeLessThanOrEqual(TAIL_BYTES);
		expect(body.length).toBeGreaterThan(64 * 1024);
		session("mid.jsonl", body);
		expect(read(origin())).toEqual({ model: "anthropic/claude-opus-5-5", thinking: "high", fallback: false });
	});

	test("AC-2: the origin's !model and !thinking win when not on a fallback", () => {
		const read = createSessionModelReader();
		session("a.jsonl", BASE);
		expect(read(origin({ model: "zai/glm-5.3", thinking: "low" }))).toEqual({
			model: "zai/glm-5.3",
			thinking: "low",
			fallback: false,
		});
		session("b.jsonl", BASE + modelChange("inferhub/cb/deepseek-v4.1-flash", true, "fallback"));
		utimesSync(join(dir, "b.jsonl"), new Date(), new Date(Date.now() + 60_000));
		expect(read(origin({ model: "zai/glm-5.3", thinking: "low" }))).toEqual({
			model: "anthropic/claude-opus-5-5",
			thinking: "high",
			fallback: true,
		});
	});

	test("AC-2: session_file is preferred over the newest file of session_dir; sub-agent directories are not read", () => {
		const read = createSessionModelReader();
		const own = session("own.jsonl", BASE);
		session("newer.jsonl", modelChange("zai/glm-5.3", false));
		utimesSync(join(dir, "newer.jsonl"), new Date(), new Date(Date.now() + 60_000));
		mkdirSync(join(dir, "newer"));
		writeFileSync(join(dir, "newer", "sub.jsonl"), assistant("openai", "gpt-sub"));
		expect(read(origin({ sessionFile: own }))?.model).toBe("anthropic/claude-opus-5-5");
		expect(read(origin())?.model).toBe("zai/glm-5.3");
	});

	test("AC-2: broken lines, a missing file and an empty directory are undefined without a throw", () => {
		const read = createSessionModelReader();
		expect(read(origin())).toBeUndefined();
		expect(read(origin({ sessionDir: join(dir, "absent"), sessionFile: join(dir, "absent.jsonl") }))).toBeUndefined();
		session("broken.jsonl", '{"type":"model_change","model":\n{not json\n');
		expect(read(origin())).toBeUndefined();
	});

	test("AC-2: the same (path, size, mtime) is not read again; a change is", () => {
		let reads = 0;
		const counting: ChunkReader = (file, offset, length) => {
			reads += 1;
			return readFileSync(file)
				.subarray(offset, offset + length)
				.toString("utf8");
		};
		const read = createSessionModelReader(counting);
		const file = session("a.jsonl", BASE);
		const first = read(origin());
		expect(read(origin())).toEqual(first);
		expect(reads).toBe(1);
		writeFileSync(file, BASE + modelChange("zai/glm-5.3", true, "fallback"));
		expect(read(origin())?.fallback).toBe(true);
		expect(reads).toBe(2);
	});
});
