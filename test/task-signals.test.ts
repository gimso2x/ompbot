import { describe, expect, test } from "bun:test";
import { parseTaskSpecInput, TaskSpecError } from "../src/tasks/docs";
import { checkSignalsOf, parseSignal, runSignal, SignalSyntaxError } from "../src/tasks/signals";

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

	test("a malformed signal that reached the sweep fails instead of throwing", async () => {
		const io = {
			runCheck: async () => {
				throw new Error("not run");
			},
			readFile: async () => undefined,
		};
		expect(await runSignal("command bun test", io)).toMatchObject({
			ok: false,
			detail: expect.stringContaining("JSON"),
		});
	});

	test("a timed-out command fails with the limit, not its output", async () => {
		const io = {
			runCheck: async () => ({ code: null, output: "partial", timedOut: true }),
			readFile: async () => undefined,
		};
		expect(await runSignal('command ["sleep","999"]', io)).toEqual({
			signal: 'command ["sleep","999"]',
			ok: false,
			detail: "120초 안에 끝나지 않았습니다",
		});
	});
});
