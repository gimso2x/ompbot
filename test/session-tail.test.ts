import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	herdrAgentStatus,
	type RunProcessOptions,
	readRemoteLastAssistant,
	realProcessRunner,
	SESSION_TAIL_STDOUT_CAP,
	SESSION_TAIL_TIMEOUT_MS,
} from "../src/dispatch/omp";
import {
	endsWithQuestion,
	type JsonRecord,
	lastAnswerOf,
	questionOf,
	readLastAssistant,
	SESSION_TAIL_MAX_BYTES,
} from "../src/omp/session-tail";

const dir = mkdtempSync(join(tmpdir(), "session-tail-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const line = (message: JsonRecord): string => JSON.stringify({ type: "message", message });
const user = (text: string) => line({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string, over: JsonRecord = {}, extra: JsonRecord[] = []) =>
	line({ role: "assistant", content: [{ type: "text", text }, ...extra], ...over });
const toolResult = (id: string) => line({ role: "toolResult", toolCallId: id, content: [] });

function sessionFile(name: string, lines: string[]): string {
	const path = join(dir, name);
	writeFileSync(path, `${lines.join("\n")}\n`);
	return path;
}

/** The remote reader run against this machine: the fake ssh runs the stdin program with the local `python3 -`. */
async function viaPython(path: string) {
	const seen: Array<{ cmd: string[]; opts: RunProcessOptions }> = [];
	const found = await readRemoteLastAssistant("wsl", path, async (cmd, opts) => {
		seen.push({ cmd, opts });
		return realProcessRunner(["python3", "-"], { stdin: opts.stdin, stdoutCap: opts.stdoutCap, timeoutMs: 30_000 });
	});
	return { found, seen };
}

describe("AC-1: endsWithQuestion (lanes and tasks share it)", () => {
	test.each([
		["A로 할까요, B로 할까요?", true],
		["설명\n…?  \n\n", true],
		["질문？", true],
		["끝났습니다.", false],
		["`a?b`", false],
		["", false],
		["  \n\n", false],
	])("%p → %p", (text, expected) => {
		expect(endsWithQuestion(text)).toBe(expected);
	});
});

describe("AC-2: the last assistant answer of a session file, local and remote alike", () => {
	test("a 1.5MB assistant line: the local reader and the python3 program give the same answer", async () => {
		const thinking = "생각".repeat(375_000); // 1.5M characters, multi-byte across chunk edges
		const path = sessionFile("big.jsonl", [
			user("시작"),
			assistant("앞 답"),
			user("다음"),
			assistant("두 안이 있습니다.\nA로 할까요?", {}, [{ type: "thinking", thinking }]),
			JSON.stringify({ type: "custom", data: "tail" }),
		]);
		const local = readLastAssistant(path);
		const { found: remote } = await viaPython(path);
		expect(local).toBeDefined();
		expect(remote).toEqual(local);
		const answer = lastAnswerOf(local as NonNullable<typeof local>);
		expect(answer.text).toBe("두 안이 있습니다.\nA로 할까요?");
		expect(questionOf(answer)).toBe("두 안이 있습니다.\nA로 할까요?");
	});

	test("a file under 4MB keeps its first line: the only assistant there is found by both readers", async () => {
		const filler = Array.from({ length: 3_000 }, (_, i) => user(`줄 ${i} ${"x".repeat(200)}`));
		const path = sessionFile("first.jsonl", [assistant("처음 답이 질문입니까?"), ...filler]);
		const local = readLastAssistant(path);
		const { found: remote } = await viaPython(path);
		expect(local?.message.content).toEqual([{ type: "text", text: "처음 답이 질문입니까?" }]);
		expect(remote).toEqual(local);
	});

	test("no assistant within the byte cap is none for both readers", async () => {
		const filler = user("y".repeat(1_000_000));
		const path = sessionFile("none.jsonl", [
			assistant("너무 앞"),
			...Array(Math.ceil(SESSION_TAIL_MAX_BYTES / 1_000_000) + 1).fill(filler),
		]);
		expect(readLastAssistant(path)).toBeUndefined();
		expect((await viaPython(path)).found).toBeUndefined();
	});

	test("a tool call without its result, an error end or a later user message is no question", () => {
		const ask = "A로 할까요?";
		const call = { type: "toolCall", id: "c1", name: "bash", arguments: {} };
		const cases: Array<[string, string[], boolean]> = [
			["plain", [assistant(ask)], true],
			["pending tool call", [assistant(ask, {}, [call])], false],
			["answered tool call", [assistant(ask, {}, [call]), toolResult("c1")], true],
			["stopReason error", [assistant(ask, { stopReason: "error" })], false],
			["errorMessage", [assistant(ask, { errorMessage: "529 overloaded" })], false],
			["user after", [assistant(ask), user("B로 하세요")], false],
		];
		for (const [name, lines, expected] of cases) {
			const found = readLastAssistant(sessionFile(`${name.replaceAll(" ", "-")}.jsonl`, lines));
			const answer = lastAnswerOf(found as NonNullable<typeof found>);
			expect({ name, question: questionOf(answer) !== undefined }).toEqual({ name, question: expected });
		}
	});

	test("the remote read passes the path on stdin only, with a 5MB stdout cap and a 20s timeout", async () => {
		const path = sessionFile("it's a $(path).jsonl", [assistant("끝났나요?")]);
		const { found, seen } = await viaPython(path);
		expect(found?.message.content).toEqual([{ type: "text", text: "끝났나요?" }]);
		expect(seen).toHaveLength(1);
		const [{ cmd, opts }] = seen as [(typeof seen)[0]];
		expect(cmd).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "--", "wsl", "'python3'", "'-'"]);
		expect(cmd.join(" ")).not.toContain("jsonl");
		expect(opts.stdin).toContain("def main():");
		expect(opts.stdin).not.toContain(path);
		expect(opts.stdoutCap).toBe(SESSION_TAIL_STDOUT_CAP);
		expect(opts.stdoutCap).toBe(5_000_000);
		expect(opts.timeoutMs).toBe(SESSION_TAIL_TIMEOUT_MS);
		expect(opts.timeoutMs).toBe(20_000);
	});

	test("a failed remote read throws: ssh exit, timeout, or the program's own error", async () => {
		await expect(
			readRemoteLastAssistant("wsl", "/x.jsonl", async () => ({
				code: 255,
				stdout: "",
				stderr: "no route",
				timedOut: false,
			})),
		).rejects.toThrow("no route");
		await expect(
			readRemoteLastAssistant("wsl", "/x.jsonl", async () => ({ code: null, stdout: "", timedOut: true })),
		).rejects.toThrow("timed out");
		await expect(viaPython(join(dir, "missing.jsonl"))).rejects.toThrow("No such file");
	});
});

describe("herdrAgentStatus: the agent's session path", () => {
	const list = (session: unknown) =>
		herdrAgentStatus("t-1", {
			run: async () => ({
				code: 0,
				stdout: JSON.stringify({ result: { agents: [{ name: "t-1", agent_status: "idle", agent_session: session }] } }),
				timedOut: false,
			}),
		});

	test("an absolute .jsonl path comes back; anything else is left out", async () => {
		expect(await list({ kind: "path", value: "/s/a.jsonl" })).toEqual({
			ok: true,
			status: "idle",
			sessionPath: "/s/a.jsonl",
		});
		for (const bad of [
			undefined,
			null,
			{ kind: "path", value: "rel.jsonl" },
			{ kind: "path", value: "/s/a.txt" },
			{ kind: "id", value: "/s/a.jsonl" },
		]) {
			expect(await list(bad)).toEqual({ ok: true, status: "idle" });
		}
	});
});
