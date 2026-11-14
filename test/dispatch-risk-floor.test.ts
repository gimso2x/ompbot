import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { ProcessRunner } from "../src/dispatch/omp";
import { buildDispatchTool } from "../src/dispatch/tool";
import { SlackChannel } from "../src/slack/channel";
import type { TaskHostOps, TaskResumeOps } from "../src/tasks/host";
import { TaskLedger } from "../src/tasks/ledger";
import { registryOf } from "./helpers/channels";
import { FakeSlackTransport } from "./helpers/slack-fake-transport";

const NOW = Date.parse("2026-11-13T06:00:00Z");
const SPEC = {
	title: "로그 회전",
	risk: "L1",
	goal: "로그 회전을 넣는다",
	scope: ["src/log.ts"],
	exclusions: ["배포"],
	acceptance: ["회전 테스트가 통과한다"],
	repo: "/r/repo",
};

/** A taskSpec intake against an in-memory ledger, a fake host and a fake herdr; returns the reply and the stored risk. */
async function intake(spec: Record<string, unknown>): Promise<{ reply: string; risk: string; logs: string[] }> {
	const ledger = new TaskLedger(new Database(":memory:", { strict: true }), {
		timezone: "Asia/Seoul",
		clock: { now: () => NOW },
	});
	const existing = new Set<string>();
	const unused = async (): Promise<never> => {
		throw new Error("intake never runs this");
	};
	const host: TaskHostOps & TaskResumeOps = {
		pathExists: async (path) => ({ ok: true, value: existing.has(path) }),
		createWorktree: async (input) => {
			existing.add(input.worktree);
			return { ok: true, value: null };
		},
		removeWorktree: async () => {},
		writeFile: async () => ({ ok: true, value: null }),
		readFile: async () => ({ ok: true, value: undefined }),
		readBytes: async () => ({ ok: true, value: undefined }),
		commitDocs: async () => ({ ok: true, value: "abc1234" }),
		progressLag: unused,
		commitOnTaskBranch: unused,
		runCheck: unused,
		headOf: unused,
		branchDiff: unused,
	};
	const run: ProcessRunner = async (cmd) => {
		if (cmd[1] === "agent" && cmd[2] === "list") {
			return { code: 0, stdout: '{"result":{"agents":[]}}', timedOut: false };
		}
		if (cmd[1] === "workspace" && cmd[2] === "list") {
			return { code: 0, stdout: '{"result":{"workspaces":[]}}', timedOut: false };
		}
		if (cmd[2] === "create") {
			const result = { workspace: { workspace_id: "W1" }, tab: { tab_id: "T1" }, root_pane: { pane_id: "P1" } };
			return { code: 0, stdout: JSON.stringify({ result }), timedOut: false };
		}
		return { code: 0, stdout: "{}", timedOut: false };
	};
	const logs: string[] = [];
	const record = (event: string) => logs.push(event);
	const tool = buildDispatchTool({
		originKey: "slack/ch/C1/t/100.1",
		ompExecutable: "omp",
		homeDir: "/home",
		workspaceDir: "/ws",
		herdr: {},
		run,
		log: { info: record, warn: record },
		tasks: {
			ledger,
			timezone: "Asia/Seoul",
			threadRef: () => "C1:100.1",
			rootText: () => "[TASK] L1 로그 회전",
			channels: registryOf(new SlackChannel(new FakeSlackTransport())),
			now: () => NOW,
			hostOps: () => host,
		},
	});
	const reply = await tool.execute({ taskSpec: spec, task: "구현해" }, { signal: new AbortController().signal });
	return { reply, risk: ledger.require("T-20261113-01").risk, logs };
}

describe("taskSpec intake risk floor", () => {
	test("L1 with an auth goal is stored at L3 and the reply says L1→L3", async () => {
		const { reply, risk, logs } = await intake({ ...SPEC, goal: "인증 흐름 수정" });
		expect(risk).toBe("L3");
		expect(reply).toContain("위험등급을 L1→L3으로 올렸습니다(키워드: 인증).");
		expect(logs).toContain("dispatch_risk_floor_raised");
	});

	test("L4 stays L4 under an L3 keyword", async () => {
		const { reply, risk } = await intake({ ...SPEC, risk: "L4", goal: "결제 모듈 수정" });
		expect(risk).toBe("L4");
		expect(reply).not.toContain("위험등급을");
	});

	test("a keyword only in exclusions or acceptance leaves L1", async () => {
		const { reply, risk } = await intake({
			...SPEC,
			exclusions: ["삭제 마이그레이션"],
			acceptance: ["시크릿을 출력하지 않는다"],
		});
		expect(risk).toBe("L1");
		expect(reply).not.toContain("위험등급을");
	});

	test("scope and background are scanned; L4 keywords raise to L4", async () => {
		expect((await intake({ ...SPEC, scope: ["src/payments.ts"] })).risk).toBe("L3");
		const { reply, risk } = await intake({ ...SPEC, background: "이력 재작성 뒤 force push" });
		expect(risk).toBe("L4");
		expect(reply).toContain("L1→L4로 올렸습니다");
	});
});
