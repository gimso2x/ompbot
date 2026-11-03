import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StatusReport } from "../src/daemon/status";
import { makeHome, type TestHome } from "./helpers/bot-home";
import {
	expectNoProcessesMentioning,
	killSpawned,
	type LoggedPost,
	runMain,
	spawnDaemon,
	TransportLog,
} from "./helpers/daemon-process";

/**
 * Operations E2E: a REAL omp behind the real daemon process, file-backed fake Slack, temp OMPBOT_HOME with FAKE tokens.
 * The omp child is killed with SIGKILL right after the tool_start log line (omp's tool_execution_start event).
 * Costs tokens, so it only runs with OMPBOT_E2E_OMP=1 (model: OMPBOT_E2E_OMP_PROVIDER/OMPBOT_E2E_OMP_MODEL).
 */
const enabled = process.env.OMPBOT_E2E_OMP === "1";
if (!enabled) console.log("[skip] ops.e2e.test.ts: set OMPBOT_E2E_OMP=1 to run against a real omp (costs tokens)");

const PROVIDER = process.env.OMPBOT_E2E_OMP_PROVIDER ?? "zai";
const MODEL = process.env.OMPBOT_E2E_OMP_MODEL ?? "glm-5.3-flash";
const OMP_EXECUTABLE = process.env.OMPBOT_OMP_EXECUTABLE ?? Bun.which("omp") ?? "omp";
const ORIGIN = "slack/dm/D1";
const SCENARIO_TIMEOUT_MS = 420_000;
// Failure deadline on awaited events (log lines, file changes), never a wait for time to pass.
const EVENT_TIMEOUT_MS = 180_000;
const FAILED_NOTICE = "[turn failed] omp_exited";

let home: TestHome | undefined;

afterEach(async () => {
	killSpawned();
	if (home) await expectNoProcessesMentioning(home.dir);
	home?.remove();
	home = undefined;
});

interface Injected {
	nonce: string;
	threadRef: string;
}

async function inject(homeDir: string, text: string): Promise<{ threadTs: string }> {
	const result = await runMain(homeDir, ["inject", "--origin", ORIGIN, "--as-owner", "--text", text]);
	expect(result.code, result.stderr).toBe(0);
	const parsed = JSON.parse(result.stdout) as Injected;
	return { threadTs: parsed.threadRef.slice(parsed.threadRef.indexOf(":") + 1) };
}

const inThread = (posts: LoggedPost[], threadTs: string) => posts.filter((post) => post.threadTs === threadTs);

/** Pid of the first origin's omp child in `ompbot status --json` output; null when none is running. */
function ompPidOf(statusJson: string): number | null {
	const report: StatusReport = JSON.parse(statusJson);
	return report.origins[0]?.ompPid ?? null;
}

describe.skipIf(!enabled)("operations surface with a real omp", () => {
	test(
		"kill -9 of the omp child after tool_start: omp_exit log, one [turn failed] omp_exited reply, next inject resumes the session",
		async () => {
			const nonce = `nonce${randomBytes(5).toString("hex")}`;
			home = makeHome("ompbot-e2e-ops-", { ompExecutable: OMP_EXECUTABLE, model: `${PROVIDER}/${MODEL}` });
			const log = new TransportLog(join(home.dir, "transport.jsonl"));
			const daemon = spawnDaemon(home.dir, log.path);
			await daemon.waitLog(/event=daemon_ready/);

			const a = await inject(
				home.dir,
				`Remember this nonce: ${nonce}. Then use the bash tool to run exactly \`sleep 20\` and do not answer before the tool has run.`,
			);
			await daemon.waitLog(/event=tool_start origin=slack\/dm\/D1/, EVENT_TIMEOUT_MS);

			const status = await runMain(home.dir, ["status", "--json"]);
			expect(status.code, status.stderr).toBe(0);
			const ompPid = ompPidOf(status.stdout);
			if (typeof ompPid !== "number") throw new Error(`no live omp pid in status: ${status.stdout}`);
			expect(readFileSync(`/proc/${ompPid}/cmdline`, "utf8")).toContain("rpc");
			process.kill(ompPid, "SIGKILL");

			const exitLine = await daemon.waitLog(/event=omp_exit origin=slack\/dm\/D1 code=\S+ expected=false/);
			await log.waitFor(
				(posts) => inThread(posts, a.threadTs).some((post) => post.text.includes(FAILED_NOTICE)),
				"the [turn failed] omp_exited reply",
				EVENT_TIMEOUT_MS,
			);

			// The next message opens a new child that resumes the same session directory.
			const b = await inject(home.dir, "What nonce did I ask you to remember earlier? Answer with that nonce only.");
			await log.waitFor(
				(posts) => inThread(posts, b.threadTs).some((post) => post.text.includes(nonce) && !post.text.startsWith("⏳")),
				"B's answer containing the earlier nonce",
				EVENT_TIMEOUT_MS,
			);
			const after = await runMain(home.dir, ["status", "--json"]);
			const newPid = ompPidOf(after.stdout);
			expect(typeof newPid === "number" && newPid !== ompPid).toBe(true);

			daemon.signal("SIGTERM");
			expect(await daemon.exited).toBe(0);
			expect(inThread(log.posts(), a.threadTs).filter((post) => post.text.includes(FAILED_NOTICE))).toHaveLength(1);

			const fileLog = readFileSync(join(home.dir, "logs", "ompbot.log"), "utf8").split("\n");
			const excerpt = fileLog.filter((line) => /event=(turn_start|tool_start|omp_exit|delivery_state)/.test(line));
			expect(excerpt.some((line) => line.includes("event=omp_exit"))).toBe(true);
			console.log(`[ops-e2e] killed omp pid ${ompPid}; exit line: ${exitLine}`);
			console.log(`[ops-e2e] log excerpt:\n${excerpt.join("\n")}`);
		},
		SCENARIO_TIMEOUT_MS,
	);
});
