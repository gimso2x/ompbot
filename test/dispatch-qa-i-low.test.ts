import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrReadAgent, type ProcessRunner, runOmpPrint } from "../src/dispatch/omp";
import { buildDispatchTool } from "../src/dispatch/tool";
import { buildFloorsPrompt, floorsSystemPrompt } from "../src/safety/prompt";

const HIGH = "git push --force origin main 로 맞춰";
const AKIA = `AKIA${"QWERTYUIOPASDFGH"}`;

describe("dispatch tool (qa-i low)", () => {
	// qa n51: a freeze that starts while the owner card waits must refuse the approved handoff.
	test("a freeze that starts during the approval card refuses the delegation", async () => {
		const runs: string[][] = [];
		let frozen: { reason: string } | undefined;
		const tool = buildDispatchTool({
			originKey: "slack/dm/D0123456789",
			ompExecutable: "omp",
			homeDir: "/h",
			workspaceDir: "/h/workspace",
			log: { info() {}, warn() {} },
			frozen: () => frozen as never,
			run: async (cmd) => {
				runs.push(cmd);
				return { code: 0, stdout: "ok", timedOut: false };
			},
			approve: async () => {
				frozen = { reason: "test" };
				return "approved";
			},
		});
		await expect(tool.execute({ task: HIGH }, { signal: new AbortController().signal })).rejects.toThrow();
		expect(runs).toEqual([]);
	});

	// qa n115 and n111: the `omp -p` child gets the caller's signal and floors without tools it does not have.
	test("simple mode passes the abort signal and a prompt without host tools", async () => {
		let seenSignal: AbortSignal | undefined;
		let cmdSeen: string[] = [];
		const tool = buildDispatchTool({
			originKey: "slack/dm/D0123456789",
			ompExecutable: "omp",
			homeDir: "/h",
			workspaceDir: "/h/workspace",
			log: { info() {}, warn() {} },
			run: async (cmd, opts) => {
				cmdSeen = cmd;
				seenSignal = opts.signal;
				return { code: 0, stdout: "ok", timedOut: false };
			},
		});
		const controller = new AbortController();
		await tool.execute({ task: "빌드 상태 요약" }, { signal: controller.signal });
		expect(seenSignal).toBe(controller.signal);
		const appendix = cmdSeen[cmdSeen.indexOf("--append-system-prompt") + 1] ?? "";
		expect(appendix).not.toContain("slack_send_file");
		expect(appendix).not.toContain("ompbot_request_approval(");
	});

	test("buildFloorsPrompt with hostTools false has no tool lines", () => {
		const text = buildFloorsPrompt("/tmp/h/secrets", undefined, false, false, false, {}, false);
		expect(text).not.toContain("slack_send_file");
		expect(text).not.toContain("ompbot_request_approval(");
		expect(buildFloorsPrompt("/tmp/h/secrets")).toContain("slack_send_file");
	});
});

describe("omp child output and env (qa-i low)", () => {
	// qa n117: a key straddling the cap must be masked before the cut.
	test("runOmpPrint masks a secret that straddles the output cap", async () => {
		const stdout = `${"x".repeat(7_984)} ${AKIA} ${"y".repeat(100)}`;
		const run: ProcessRunner = async () => ({ code: 0, stdout, timedOut: false });
		const result = await runOmpPrint({ task: "t", cwd: "/", systemPromptAppendix: "", ompBin: "omp", run });
		expect(result.output).not.toContain("AKIAQ");
	});

	// qa n114: local herdr gets the cleaned child env like every other child.
	test("herdr runs without SLACK_*, OMPBOT_* and GIT_* from the daemon env", async () => {
		const keys = ["SLACK_BOT_TOKEN", "OMPBOT_HOME", "GIT_DIR"];
		for (const key of keys) process.env[key] = "xoxb-TEST-0";
		let env: Record<string, string | undefined> | undefined;
		try {
			await herdrReadAgent("a", {
				run: async (_cmd, opts) => {
					env = opts.env;
					return { code: 0, stdout: "", timedOut: false };
				},
			});
		} finally {
			for (const key of keys) delete process.env[key];
		}
		expect(env).toBeDefined();
		for (const key of keys) expect(env?.[key]).toBeUndefined();
	});
});

describe("injected owner doc with leading blanks (qa-i low)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "qa-i-low-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	// qa n50: blanks before the text must not eat the read window.
	test("a persona.md with 8000 leading blanks still injects its capped text", () => {
		const body = "가".repeat(3_000);
		const plain = join(dir, "plain.md");
		const blanks = join(dir, "blanks.md");
		writeFileSync(plain, body);
		writeFileSync(blanks, `${" ".repeat(8_000)}${body}`);
		const a = floorsSystemPrompt("/s/secrets", "slack/dm/D1", { persona: plain });
		const b = floorsSystemPrompt("/s/secrets", "slack/dm/D1", { persona: blanks });
		expect(b).toBe(a);
	});
});
