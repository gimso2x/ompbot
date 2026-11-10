import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { REDELIVERED_PREFIX } from "../src/channel/text";
import { INTERRUPTED_NOTICE } from "../src/daemon/recovery";
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
 * Restart E2E: a REAL omp behind the real daemon process (`bun src/main.ts daemon`) with the file-backed fake Slack
 * transport. For each crash hook the daemon is killed (exit 137) mid-flight and started again on the same home.
 * Costs tokens, so it only runs with OMPBOT_E2E_OMP=1 (model: OMPBOT_E2E_OMP_PROVIDER/OMPBOT_E2E_OMP_MODEL).
 */
const enabled = process.env.OMPBOT_E2E_OMP === "1";
if (!enabled) console.log("[skip] restart.e2e.test.ts: set OMPBOT_E2E_OMP=1 to run against a real omp (costs tokens)");

const PROVIDER = process.env.OMPBOT_E2E_OMP_PROVIDER ?? "zai";
const MODEL = process.env.OMPBOT_E2E_OMP_MODEL ?? "glm-5.3-flash";
const OMP_EXECUTABLE = process.env.OMPBOT_OMP_EXECUTABLE ?? Bun.which("omp") ?? "omp";
const ORIGIN = "slack/dm/D1";
const SCENARIO_TIMEOUT_MS = 420_000;
// Failure deadlines on awaited events (file changes, process exit, log lines), never a wait for time to pass.
const EVENT_TIMEOUT_MS = 180_000;

type Hook = "after_dispatch" | "after_final_before_answered" | "after_answered" | "after_post_before_confirm";

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

async function inject(homeDir: string, text: string): Promise<Injected & { threadTs: string }> {
	const result = await runMain(homeDir, ["inject", "--origin", ORIGIN, "--as-owner", "--text", text]);
	expect(result.code, result.stderr).toBe(0);
	const parsed = JSON.parse(result.stdout) as Injected;
	return { ...parsed, threadTs: parsed.threadRef.slice(parsed.threadRef.indexOf(":") + 1) };
}

const inThread = (posts: LoggedPost[], threadTs: string) => posts.filter((post) => post.threadTs === threadTs);

async function scenario(hook: Hook): Promise<void> {
	const nonceA = `nonce${randomBytes(5).toString("hex")}`;
	home = makeHome(`ompbot-e2e-${hook}-`, { ompExecutable: OMP_EXECUTABLE, model: `${PROVIDER}/${MODEL}` });
	const log = new TransportLog(join(home.dir, "transport.jsonl"));

	// Incarnation 1 dies at the hook.
	const first = spawnDaemon(home.dir, log.path, { OMPBOT_TEST_CRASH_AT: hook });
	await first.waitLog(/event=daemon_ready/);
	const a = await inject(home.dir, `Reply with exactly one line and nothing else: ECHO ${nonceA}`);
	expect(await first.exited).toBe(137);

	// Incarnation 2 recovers on the same home.
	const second = spawnDaemon(home.dir, log.path);
	await second.waitLog(/event=daemon_ready/);
	const aPosts = () => inThread(log.posts(), a.threadTs);
	const answers = () => aPosts().filter((post) => post.text.includes(nonceA));
	const notices = () => aPosts().filter((post) => post.text.includes(INTERRUPTED_NOTICE));

	if (hook === "after_dispatch") {
		await log.waitFor(
			() => answers().length + notices().length >= 1,
			"an answer or an interrupted notice for A",
			EVENT_TIMEOUT_MS,
		);
	} else if (hook === "after_post_before_confirm") {
		await log.waitFor(() => answers().length >= 2, "original and redelivered answer for A", EVENT_TIMEOUT_MS);
	} else {
		await log.waitFor(() => answers().length >= 1, "the answer for A", EVENT_TIMEOUT_MS);
	}

	if (hook !== "after_dispatch") {
		// Message B: the session must have survived the restart and still know A's nonce.
		const b = await inject(
			home.dir,
			"What was the nonce after ECHO in your previous reply? Answer with that nonce only.",
		);
		await log.waitFor(
			(posts) => inThread(posts, b.threadTs).some((post) => post.text.includes(nonceA)),
			"B's answer containing A's nonce",
			EVENT_TIMEOUT_MS,
		);
	}

	const status = await runMain(home.dir, ["status", "--json"]);
	expect(status.code, status.stderr).toBe(0);
	expect(JSON.parse(status.stdout)).toMatchObject({
		daemonRunning: true,
		ompVersion: expect.any(String),
		origins: [{ originKey: ORIGIN, epoch: 1 }],
		ledger: expect.any(Object),
		inbound: expect.any(Object),
	});

	// Graceful stop, then count: nothing else may arrive after this point.
	second.signal("SIGTERM");
	expect(await second.exited).toBe(0);

	if (hook === "after_dispatch") {
		expect(answers().length + notices().length).toBe(1);
		expect(aPosts().filter((post) => post.text.startsWith(REDELIVERED_PREFIX))).toHaveLength(0);
	} else if (hook === "after_final_before_answered") {
		expect(answers()).toHaveLength(1);
		expect(notices()).toHaveLength(0);
		await second.waitLog(/event=recovery_answered/); // the recovery path, not the live path, produced it
	} else if (hook === "after_answered") {
		expect(answers()).toHaveLength(1);
		expect(notices()).toHaveLength(0);
	} else {
		expect(answers()).toHaveLength(2);
		expect(answers().filter((post) => post.text.startsWith(REDELIVERED_PREFIX))).toHaveLength(1);
		expect(answers().filter((post) => !post.text.startsWith(REDELIVERED_PREFIX))).toHaveLength(1);
	}
}

describe.skipIf(!enabled)("daemon restart with a real omp", () => {
	for (const hook of [
		"after_dispatch",
		"after_final_before_answered",
		"after_answered",
		"after_post_before_confirm",
	] as const) {
		test(hook, () => scenario(hook), SCENARIO_TIMEOUT_MS);
	}
});
