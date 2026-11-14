import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parseTaskSpecInput, TaskSpecError } from "../src/tasks/docs";
import { CHECK_TIMEOUT_MS, checkSignalsOf, parseSignal, runSignal, SignalSyntaxError } from "../src/tasks/signals";

const spec = (acceptance: string[]) => ({
	title: "check",
	risk: "L2",
	goal: "g",
	acceptance,
	repo: "/r/repo",
});

/** The TaskSpecError message a registration with these criteria gets; `""` when it registers. */
function refusal(acceptance: string[]): string {
	try {
		parseTaskSpecInput(spec(acceptance));
		return "";
	} catch (error) {
		if (!(error instanceof TaskSpecError)) throw error;
		return error.message;
	}
}

describe("AC-1: [check: …] at registration", () => {
	test("well-formed checks register with the criterion text unchanged", () => {
		const acceptance = [
			'bun test가 통과한다 [check: command ["bun","test"] stdout~" 0 fail"]',
			'버전이 올라간다 [check: file package.json json:.version="0.2.0"; command ["bun","x","tsc","--noEmit"]]',
			`산출물이 같다 [check: file "dist/a.js" sha256=${"0123456789".repeat(6)}abcd]`,
			"check 없는 기준",
			'`[check: command ["x"]]`처럼 문장 가운데 인용한 check는 문구일 뿐이다',
		];
		const parsed = parseTaskSpecInput(spec(acceptance));
		expect(parsed.kind === "new" && parsed.spec.acceptance).toEqual(acceptance);
	});

	test("malformed checks are refused with TaskSpecError", () => {
		expect(refusal(["bun test [check: command bun test]"])).toContain("command는 JSON argv 배열을 받습니다");
		expect(refusal(['테스트 [check: command ["bun","test"] stdout~"(unclosed"]'])).toContain("잘못된 정규식");
		expect(refusal(["밖 [check: file ../secrets.txt]"])).toContain("워크트리 안 파일의 상대경로");
		expect(refusal(["밖 [check: file /etc/passwd]"])).toContain("워크트리 안 파일의 상대경로");
		expect(refusal(["밖 [check: file a/../../b]"])).toContain("워크트리 안 파일의 상대경로");
		expect(refusal(['열림 [check: command ["bun", "test"]'])).toContain("닫히지 않았습니다");
		expect(refusal(["네트워크 [check: url https://example.com]"])).toContain("읽을 수 없는 신호");
		expect(refusal(['옵션 [check: command ["bun"] stdout="x"]'])).toContain('stdout은 ~"정규식"');
		expect(refusal(["해시 [check: file a.txt sha256=abc]"])).toContain("16진수 64자");
		expect(refusal(['빈 신호 [check: command ["x"];]'])).toContain("빈 신호");
		expect(refusal(["첫째", "둘째 [check: file ../x]"])).toStartWith("taskSpec.acceptance[1]의 check 형식 오류");
	});

	test("two blocks or text after the block are refused; the two-block refusal points to semicolons", () => {
		const two = refusal(['x [check: command ["bun","test"]] [check: command ["echo","ok"]]']);
		expect(two).toStartWith("taskSpec.acceptance[0]의 check 형식 오류");
		expect(two).toContain("하나만");
		expect(two).toContain("세미콜론(;)");
		const after = refusal(['테스트 통과 [check: command ["bun","test"]] (근거는 outcome.md)']);
		expect(after).toStartWith("taskSpec.acceptance[0]의 check 형식 오류");
		expect(after).toContain("맨 끝에 와야 합니다: (근거는 outcome.md)");
	});

	test("one trailing block registers, including a quoted `[check:` argument and a backticked quotation", () => {
		expect(refusal(['테스트 [check: command ["bun","test"]]'])).toBe("");
		expect(refusal(['문법 검사 [check: command ["grep","[check:","x"]]'])).toBe("");
		expect(refusal(['설명의 `[check:]` 인용과 ``[check: x] `y` ``는 문구다 [check: command ["bun","test"]]'])).toBe("");
	});

	test("judgement still reads the last block of an old two-block text without throwing", () => {
		expect(checkSignalsOf('x [check: command ["bun","test"]] [check: command ["echo","ok"]]')).toEqual([
			'command ["echo","ok"]',
		]);
	});
});

describe("signal grammar", () => {
	test("the trailing block splits on top-level semicolons only", () => {
		expect(checkSignalsOf('x [check: command ["a;b"] stdout~"c;d"; file a.json json:.k=[1,";"]]')).toEqual([
			'command ["a;b"] stdout~"c;d"',
			'file a.json json:.k=[1,";"]',
		]);
		expect(checkSignalsOf("문구만")).toEqual([]);
	});

	test("parsed shapes", () => {
		expect(parseSignal('command ["bun","test"] stdout~" 0 fail"')).toEqual({
			kind: "command",
			argv: ["bun", "test"],
			stdout: / 0 fail/,
		});
		expect(parseSignal('file pkg/a.json json:.list.0.name="x"')).toEqual({
			kind: "file",
			path: "pkg/a.json",
			json: { path: ["list", 0, "name"], value: "x" },
		});
		expect(() => parseSignal('command [] stdout~"x"')).toThrow(SignalSyntaxError);
	});

	test("a repeated option is rejected instead of silently dropping the earlier one (qa-i #59)", () => {
		expect(() => parseSignal("file data.json json:.a=1 json:.b=2")).toThrow(SignalSyntaxError);
		expect(() => parseSignal("file data.json json:.a=1 json:.a=2")).toThrow(SignalSyntaxError);
		expect(() => parseSignal('command ["echo"] stdout~"a" stdout~"b"')).toThrow(SignalSyntaxError);
	});

	test("a malformed signal that reached the sweep fails instead of throwing", async () => {
		const io = {
			runCheck: async () => {
				throw new Error("not run");
			},
			readBytes: async () => undefined,
		};
		expect(await runSignal("command bun test", io)).toMatchObject({
			ok: false,
			detail: expect.stringContaining("JSON"),
		});
	});

	test("a timed-out command is inconclusive with the 300 s limit, not its output", async () => {
		expect(CHECK_TIMEOUT_MS).toBe(300_000);
		const io = {
			runCheck: async () => ({ code: null, output: "partial", timedOut: true }),
			readBytes: async () => undefined,
		};
		expect(await runSignal('command ["sleep","999"]', io)).toEqual({
			signal: 'command ["sleep","999"]',
			ok: false,
			detail: "300초 안에 끝나지 않았습니다(확인 불가)",
			inconclusive: true,
		});
	});

	test("sha256 hashes the file's bytes: invalid UTF-8 with its exact hash passes, a wrong hash fails (qa-i #126)", async () => {
		const bytes = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x41, 0x0a]);
		const sha = createHash("sha256").update(bytes).digest("hex");
		const io = {
			runCheck: async () => {
				throw new Error("not run");
			},
			readBytes: async (path: string) => (path === "bin.dat" ? bytes : undefined),
		};
		expect(await runSignal(`file bin.dat sha256=${sha}`, io)).toMatchObject({ ok: true });
		expect(await runSignal(`file bin.dat sha256=${"0".repeat(64)}`, io)).toMatchObject({
			ok: false,
			detail: expect.stringMatching(/^sha256 /),
		});
	});

	test("only a timeout is inconclusive: every other failure is a violation", async () => {
		const body = "hello\n";
		const commandIo = (code: number | null, output = "") => ({
			runCheck: async () => ({ code, output, timedOut: false }),
			readBytes: async () => undefined,
		});
		const fileIo = {
			runCheck: commandIo(0).runCheck,
			readBytes: async (path: string) => (path === "a.txt" ? Buffer.from(body) : undefined),
		};
		const violations = [
			await runSignal('command ["false"]', commandIo(1, "boom")),
			await runSignal('command ["./run.sh"]', commandIo(126, "permission denied")),
			await runSignal('command ["nope"]', commandIo(127, "not found")),
			await runSignal('command ["crash"]', commandIo(null, "killed")),
			await runSignal('command ["bun","test"] stdout~" 0 fail"', commandIo(0, "1 fail")),
			await runSignal("file missing.txt", fileIo),
			await runSignal(`file a.txt sha256=${"0".repeat(64)}`, fileIo),
			await runSignal("command bun test", commandIo(0)),
		];
		for (const check of violations) {
			expect(check.ok).toBe(false);
			expect(check.inconclusive).toBeUndefined();
			expect(check.detail).not.toContain("확인 불가");
		}
	});
});
