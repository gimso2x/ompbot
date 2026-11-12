import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon/daemon";
import { createLogger } from "../src/log";
import type { OmpFinal, OmpSessionDriver } from "../src/omp/driver";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { writeFreeze } from "../src/ops/freeze";
import { redact } from "../src/redact";
import {
	backupSkillRevision,
	buildSkillReviewPrompt,
	extractProposals,
	installSkill,
	listSkillRevisions,
	readSessionDigest,
	renderSkillFile,
	rollbackSkill,
	runSkillReview,
	SKILL_REVIEW_ORIGIN,
	type SkillProposal,
	type SkillReviewDeps,
	savePendingProposals,
	skillDirOf,
} from "../src/review/skills";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import { makeHome, type TestHome, WaitingTransport } from "./helpers/bot-home";
import { killSpawned, runMain } from "./helpers/daemon-process";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-review-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const log = () => createLogger({ sink: () => undefined, clock: { now: () => 0 }, redact });

/** Minimal driver: one canned answer through onFinal, nothing else. */
function fakeDriver(answer: string, status: OmpFinal["status"] = "completed"): OmpSessionDriver {
	const listeners = new Set<(final: OmpFinal) => void>();
	return {
		start: async () => undefined,
		prompt: async (text: string) => {
			expect(text).toContain("[스킬 리뷰]");
			queueMicrotask(() => {
				for (const listener of listeners) listener({ opRef: "op1", status, text: answer });
			});
			return "op1";
		},
		steer: async () => undefined,
		abort: async () => undefined,
		newSession: async () => ({ cancelled: false }),
		openSession: async () => ({ resumed: false, sessionId: "s" }),
		switchSession: async () => ({ cancelled: false }),
		availableModels: async () => [],
		setModel: async (model: string) => model,
		thinkingLevels: async () => [],
		setThinking: async () => undefined,
		compact: async () => ({ tokensBefore: 0, summary: "" }),
		state: async () => ({ sessionId: "s", idle: true, settled: true, queuedMessageCount: 0, messageCount: 0 }),
		leafId: async () => null,
		entriesSince: async () => ({ entries: [], leafId: null }),
		onFinal: (listener: (final: OmpFinal) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		onEvent: () => () => undefined,
		stop: async () => undefined,
		pid: undefined,
		exited: async () => ({ code: 0, expected: true, stderr: "" }),
	} as unknown as OmpSessionDriver;
}

const PROPOSAL_JSON = JSON.stringify([
	{
		action: "create",
		name: "release-checklist",
		description: "Use when cutting an ompbot release",
		content: "1. bun test\n2. bun run check\n3. tag",
		evidence: "이 대화에서 릴리스 절차를 두 번 통과시켰다",
		checks: [
			{ situation: "오너가 릴리스를 요청할 때", expect: "스킬이 발동해 절차를 따른다" },
			{ situation: "평소 코드 수정 요청", expect: "스킬이 발동하지 않는다" },
		],
	},
]);

describe("extractProposals", () => {
	test("parses a fenced JSON array and refuses bad shapes", () => {
		expect(extractProposals(`\`\`\`json\n${PROPOSAL_JSON}\n\`\`\``)).toEqual([
			{
				action: "create",
				name: "release-checklist",
				description: "Use when cutting an ompbot release",
				content: "1. bun test\n2. bun run check\n3. tag",
				evidence: "이 대화에서 릴리스 절차를 두 번 통과시켰다",
				checks: [
					{ situation: "오너가 릴리스를 요청할 때", expect: "스킬이 발동해 절차를 따른다" },
					{ situation: "평소 코드 수정 요청", expect: "스킬이 발동하지 않는다" },
				],
			},
		]);
		expect(extractProposals("NO_PROPOSAL")).toEqual([]);
		expect(extractProposals("nothing useful")).toEqual([]);
		expect(extractProposals('[{"name":"Bad Name","description":"d","content":"c"}]')).toEqual([]);
		expect(extractProposals('[{"name":"ok","description":"","content":"c"}]')).toEqual([]);
	});

	test("adoption gate: a proposal without session evidence or with unpaired checks is dropped", () => {
		const base = { action: "create", name: "gated", description: "d", content: "c" };
		const check = { situation: "s", expect: "e" };
		expect(extractProposals(JSON.stringify([{ ...base, checks: [check, check] }]))).toEqual([]);
		expect(extractProposals(JSON.stringify([{ ...base, evidence: "통과 근거", checks: [check] }]))).toEqual([]);
		expect(
			extractProposals(
				JSON.stringify([{ ...base, evidence: "통과 근거", checks: [check, { situation: "", expect: "e" }] }]),
			),
		).toEqual([]);
		expect(
			extractProposals(
				JSON.stringify([{ ...base, evidence: "통과 근거", checks: [check, check, check, check, check] }]),
			),
		).toEqual([]);
		expect(extractProposals(JSON.stringify([{ ...base, evidence: "통과 근거", checks: [check, check] }]))).toHaveLength(
			1,
		);
	});

	test("a proposal carrying a token-shaped secret is refused", () => {
		const tainted = JSON.stringify([
			// Assembled at runtime so secret scanners (gitleaks) do not flag the fixture; the value is unchanged.
			{
				action: "create",
				name: "leak",
				description: "d",
				content: `token: ${["xoxb", "1234567890", "abcdefghij"].join("-")}`,
				evidence: "e",
				checks: [
					{ situation: "s", expect: "e" },
					{ situation: "s", expect: "e" },
				],
			},
		]);
		expect(extractProposals(tainted)).toEqual([]);
	});
});

describe("renderSkillFile / savePendingProposals", () => {
	const gated: SkillProposal = {
		action: "create",
		name: "release-checklist",
		description: "Use when cutting a release",
		content: "steps",
		evidence: "이 대화에서 통한 근거",
		checks: [
			{ situation: "릴리스 요청", expect: "발동" },
			{ situation: "평소 수정 요청", expect: "미발동" },
		],
	};

	test("renders frontmatter, appends the adoption-check section and writes 0600 pending files", () => {
		const rendered = renderSkillFile(gated);
		expect(
			rendered.startsWith("---\nname: release-checklist\ndescription: Use when cutting a release\n---\n\nsteps\n"),
		).toBe(true);
		expect(rendered).toContain("## 채택 검증");
		expect(rendered).toContain("- 릴리스 요청 → 발동");
		expect(rendered).toContain("ompbot skills rollback release-checklist");
		expect(rendered).toContain("다른 경로(예: GLM 크론 모니터)");
		const paths = savePendingProposals(dir, [gated], 1_700_000_000_000);
		expect(paths).toHaveLength(1);
		expect(readdirSync(join(dir, "skills-pending"))).toHaveLength(1);
		expect(JSON.parse(readFileSync(paths[0] as string, "utf8"))).toMatchObject({ name: "release-checklist" });
	});

	test("a body that already carries the adoption-check heading is not given a second one", () => {
		const withSection = renderSkillFile({ ...gated, content: "steps\n\n## 채택 검증\n\n직접 쓴 절" });
		expect(withSection.match(/## 채택 검증/g)).toHaveLength(1);
	});
});

describe("readSessionDigest", () => {
	test("reads the newest session file and keeps the last messages", async () => {
		const sessionDir = join(dir, "e1");
		mkdirSync(sessionDir, { recursive: true });
		const lines = [
			{ message: { role: "user", content: "첫 질문" } },
			{ message: { role: "assistant", content: [{ type: "text", text: "첫 답" }] } },
			{ message: { role: "user", content: "둘째 질문" } },
			{ message: { role: "assistant", content: "둘째 답" } },
		];
		writeFileSync(join(sessionDir, "s.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n"));
		const digest = await readSessionDigest(sessionDir, 3);
		expect(digest).toContain("오너: 둘째 질문");
		expect(digest).toContain("봇: 둘째 답");
		expect(digest).not.toContain("첫 질문");
	});

	test("keeps the last messages of a session spanning several read chunks, in order", async () => {
		const sessionDir = join(dir, "e-large");
		mkdirSync(sessionDir, { recursive: true });
		const rows: string[] = [];
		for (let i = 0; i < 4_000; i += 1) {
			rows.push(JSON.stringify({ message: { role: i % 2 === 0 ? "user" : "assistant", content: `메시지 ${i}` } }));
		}
		writeFileSync(join(sessionDir, "s.jsonl"), rows.join("\n"));
		expect(statSync(join(sessionDir, "s.jsonl")).size).toBeGreaterThan(64 * 1024);
		const digest = await readSessionDigest(sessionDir, 3);
		expect(digest).toBe("봇: 메시지 3997\n오너: 메시지 3998\n봇: 메시지 3999");
	});

	test("reassembles lines and multi-byte characters cut by chunk boundaries", async () => {
		const sessionDir = join(dir, "e-boundary");
		mkdirSync(sessionDir, { recursive: true });
		const rows = [
			{ message: { role: "user", content: "😀".repeat(10) } },
			{ message: { role: "assistant", content: "한글 답변 😀 mix" } },
			{ message: { role: "user", content: "마지막 질문" } },
		];
		writeFileSync(join(sessionDir, "s.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
		for (const chunkSize of [1, 2, 3, 4, 5, 7, 64]) {
			const digest = await readSessionDigest(sessionDir, 24, 800, 12_000, chunkSize);
			expect(digest).toBe("오너: 😀😀😀😀😀😀😀😀😀😀\n봇: 한글 답변 😀 mix\n오너: 마지막 질문");
			expect(digest.isWellFormed()).toBe(true);
		}
	});

	test("skips a torn last line while reading backwards in chunks", async () => {
		const sessionDir = join(dir, "e-torn");
		mkdirSync(sessionDir, { recursive: true });
		const rows = [
			{ message: { role: "user", content: "완전한 질문" } },
			{ message: { role: "assistant", content: "완전한 답" } },
		];
		writeFileSync(join(sessionDir, "s.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n{"torn":`);
		const digest = await readSessionDigest(sessionDir, 24, 800, 12_000, 7);
		expect(digest).toBe("오너: 완전한 질문\n봇: 완전한 답");
	});
});

describe("runSkillReview", () => {
	function deps(
		verdict: "approved" | "denied" | "timeout",
		answer = PROPOSAL_JSON,
	): SkillReviewDeps & {
		installed: string[];
		notices: string[];
	} {
		const installed: string[] = [];
		const notices: string[] = [];
		return {
			installed,
			notices,
			makeDriver: () => fakeDriver(answer),
			readDigest: () => Promise.resolve("오너: 릴리스 절차를 자주 물어봄"),
			savePending: (proposals) => savePendingProposals(dir, proposals, 1_700_000_000_000),
			install: (proposal) => {
				installed.push(proposal.name);
				return Promise.resolve();
			},
			requestApproval: () => Promise.resolve(verdict),
			notify: (text) => {
				notices.push(text);
				return Promise.resolve();
			},
			log: log(),
			now: () => 1_700_000_000_000,
		};
	}

	test("approved proposals are installed and announced", async () => {
		const d = deps("approved");
		const result = await runSkillReview(d, { sessionDir: join(dir, "review") });
		expect(result).toEqual({ proposals: 1, installed: 1 });
		expect(d.installed).toEqual(["release-checklist"]);
		expect(d.notices.at(-1)).toContain("스킬 1개 설치");
	});

	test("denied proposals stay pending and are announced as not installed", async () => {
		const d = deps("denied");
		const result = await runSkillReview(d, { sessionDir: join(dir, "review") });
		expect(result).toEqual({ proposals: 1, installed: 0 });
		expect(d.installed).toEqual([]);
		expect(d.notices.at(-1)).toContain("승인하지 않아 설치 안 함");
	});

	test("NO_PROPOSAL and failed reviews install nothing", async () => {
		const none = deps("approved", "NO_PROPOSAL");
		expect(await runSkillReview(none, { sessionDir: join(dir, "review") })).toEqual({ proposals: 0, installed: 0 });
		// The periodic review stays quiet on an empty result; an explicit !distill announces it.
		expect(none.notices).toEqual([]);
		expect(await runSkillReview(none, { sessionDir: join(dir, "review"), announceEmpty: true })).toEqual({
			proposals: 0,
			installed: 0,
		});
		expect(none.notices.at(-1)).toContain("제안할 만한 절차가 없었어요");
		const failed = deps("approved", "boom");
		failed.makeDriver = () => fakeDriver("boom", "error");
		expect(await runSkillReview(failed, { sessionDir: join(dir, "review") })).toEqual({ proposals: 0, installed: 0 });
	});

	/** Approved review whose installs run the real `installSkill` into a fake user home under `dir`. */
	function realInstall(
		answer: string,
	): SkillReviewDeps & { installed: string[]; notices: string[]; summaries: string[] } {
		const d = deps("approved", answer);
		const summaries: string[] = [];
		d.install = async (proposal) => {
			d.installed.push(proposal.name);
			installSkill(skillDirOf(proposal.name, dir), proposal, 1_700_000_000_000);
		};
		d.requestApproval = (summary) => {
			summaries.push(summary);
			return Promise.resolve("approved");
		};
		return Object.assign(d, { summaries });
	}

	test("an approved create for a name that already has a SKILL.md leaves the owner's file untouched", async () => {
		const skill = skillDirOf("release-checklist", dir);
		mkdirSync(skill, { recursive: true });
		writeFileSync(join(skill, "SKILL.md"), "오너가 직접 쓴 스킬\n");
		const d = realInstall(PROPOSAL_JSON);
		expect(await runSkillReview(d, { sessionDir: join(dir, "review") })).toEqual({ proposals: 1, installed: 0 });
		expect(readFileSync(join(skill, "SKILL.md"), "utf8")).toBe("오너가 직접 쓴 스킬\n");
		expect(listSkillRevisions(skill)).toEqual([]);
		expect(d.notices.at(-1)).not.toContain("release-checklist");
	});

	test("a patch needs an installed skill, and the approval card says it overwrites one", async () => {
		const patch = JSON.stringify([
			{
				action: "patch",
				name: "missing-skill",
				description: "Use when x",
				content: "body",
				evidence: "이 대화에서 통한 근거",
				checks: [
					{ situation: "s1", expect: "e1" },
					{ situation: "s2", expect: "e2" },
				],
			},
		]);
		const d = realInstall(patch);
		expect(await runSkillReview(d, { sessionDir: join(dir, "review") })).toEqual({ proposals: 1, installed: 0 });
		expect(existsSync(join(skillDirOf("missing-skill", dir), "SKILL.md"))).toBe(false);
		expect(d.summaries[0]).toContain("- missing-skill (patch · 기존 스킬 덮어씀): Use when x");
		expect(d.summaries[0]).toContain("근거: 이 대화에서 통한 근거 · 검증 2짝");
	});

	test("when the 2nd of 3 installs fails the notice names only the 1st and 3rd", async () => {
		const three = JSON.stringify(
			["first-skill", "second-skill", "third-skill"].map((name) => ({
				action: "create",
				name,
				description: `Use when ${name}`,
				content: "body",
				evidence: "이 대화에서 통한 근거",
				checks: [
					{ situation: "s1", expect: "e1" },
					{ situation: "s2", expect: "e2" },
				],
			})),
		);
		const d = deps("approved", three);
		d.install = async (proposal) => {
			if (proposal.name === "second-skill") throw new Error("disk full");
			d.installed.push(proposal.name);
		};
		expect(await runSkillReview(d, { sessionDir: join(dir, "review") })).toEqual({ proposals: 3, installed: 2 });
		const notice = d.notices.at(-1) ?? "";
		expect(notice).toContain("스킬 2개 설치: first-skill, third-skill —");
		expect(notice).not.toContain("second-skill");
	});

	test("the review prompt refuses one-off narratives, secrets and ungated proposals", () => {
		const prompt = buildSkillReviewPrompt("오너: 안녕");
		expect(prompt).toContain("일회성 작업 서사");
		expect(prompt).toContain("비밀값");
		expect(prompt).toContain("NO_PROPOSAL");
		expect(prompt).toContain("채택 게이트");
		expect(prompt).toContain('"evidence"');
		expect(prompt).toContain("발동하면 안 되는 상황");
	});
});

describe("skill revisions (install safety net)", () => {
	/** One skill directory under a fake user home, as the daemon would see it. */
	const skillDir = (): string => {
		const path = skillDirOf("release-checklist", dir);
		mkdirSync(path, { recursive: true, mode: 0o700 });
		return path;
	};

	test("the first install keeps nothing; every later install saves the previous SKILL.md as a 0600 revision", () => {
		const path = skillDir();
		// Install order: save what is there, then overwrite (nothing to keep on the very first install).
		expect(backupSkillRevision(path, 1_700_000_000_000)).toBeUndefined();
		writeFileSync(join(path, "SKILL.md"), "v1", { mode: 0o600 });

		const revision = backupSkillRevision(path, 1_700_000_500_000);
		expect(revision).toBeDefined();
		expect(readFileSync(revision as string, "utf8")).toBe("v1");
		expect(statSync(revision as string).mode & 0o777).toBe(0o600);
		writeFileSync(join(path, "SKILL.md"), "v2", { mode: 0o600 });
		expect(listSkillRevisions(path)).toHaveLength(1);
	});

	test("rollback swaps the current SKILL.md with the newest revision; rolling back again undoes it", () => {
		const path = skillDir();
		const install = (content: string, at: number): void => {
			const revision = backupSkillRevision(path, at);
			if (revision === undefined) expect(at).toBe(1_700_000_000_000); // only the first call keeps nothing
			writeFileSync(join(path, "SKILL.md"), content, { mode: 0o600 });
		};
		install("v1", 1_700_000_000_000);
		install("v2", 1_700_000_500_000);
		install("v3", 1_700_001_000_000);

		rollbackSkill(path);
		expect(readFileSync(join(path, "SKILL.md"), "utf8")).toBe("v2");
		rollbackSkill(path);
		expect(readFileSync(join(path, "SKILL.md"), "utf8")).toBe("v3");
		// Nothing was lost: the newest slot now holds v2 (swapped out by the second rollback), the oldest holds v1.
		expect(
			listSkillRevisions(path)
				.map((p) => readFileSync(p, "utf8"))
				.sort(),
		).toEqual(["v1", "v2"]);
	});

	test("rollback refuses a skill without an install or without revisions", () => {
		expect(() => rollbackSkill(join(dir, "never-installed"))).toThrow("skill not installed");
		const path = skillDir();
		writeFileSync(join(path, "SKILL.md"), "only", { mode: 0o600 });
		expect(() => rollbackSkill(path)).toThrow("no saved revision");
	});
});

describe("ompbot skills rollback (CLI)", () => {
	afterEach(() => {
		killSpawned();
	});

	test("restores the previous revision; usage and unknown skills fail with the right exit codes", async () => {
		const path = skillDirOf("release-checklist", dir);
		mkdirSync(path, { recursive: true, mode: 0o700 });
		// First install, then an approved patch on top (the previous content becomes a revision).
		expect(backupSkillRevision(path, 1_700_000_000_000)).toBeUndefined();
		writeFileSync(join(path, "SKILL.md"), "v1", { mode: 0o600 });
		expect(backupSkillRevision(path, 1_700_000_500_000)).toBeDefined();
		writeFileSync(join(path, "SKILL.md"), "v2", { mode: 0o600 });

		const env = { OMPBOT_TEST_HOOKS: "1", OMPBOT_SKILLS_DIR: join(dir, ".omp", "agent", "managed-skills") };
		const run = await runMain(dir, ["skills", "rollback", "release-checklist"], env);
		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout).toMatch(/^skill rollback name=release-checklist revision=\S+\.md\n$/);
		expect(readFileSync(join(path, "SKILL.md"), "utf8")).toBe("v1");

		const missing = await runMain(dir, ["skills", "rollback", "nope"], env);
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain("skill not installed");
		const usage = await runMain(dir, ["skills"], env);
		expect(usage.code).toBe(2);
		expect(usage.stderr).toContain("usage: ompbot skills rollback");
	}, 30_000);
});

describe("!distill (daemon)", () => {
	const DM = "slack/dm/D1";
	let home: TestHome;
	let daemon: Daemon | undefined;
	let transport: WaitingTransport;
	let lines: string[];
	let waiters: Array<() => void>;
	/** Every omp child the daemon started, with its origin and session dir. */
	let built: Array<{ origin: string; sessionDir: string; driver: FakeOmpDriver }>;
	let holdReview: boolean;

	async function boot(): Promise<Daemon> {
		const sessions = new FakeSessionStore();
		const clock = { now: () => Date.now() };
		const started = new Daemon({
			config: home.config,
			channels: [new SlackBinding(new SlackChannel(transport))],
			clock,
			log: createLogger({
				sink: (line) => {
					lines.push(line);
					for (const wake of [...waiters]) wake();
				},
				clock,
				redact,
			}),
			ompVersion: "omp-test 0",
			bootId: "boot-distill",
			stopDrainMs: 0,
			sweepMs: 3_600_000,
			gateSweepMs: 0,
			taskSweepMs: 0,
			driverFactory: (origin, sessionDir) => {
				const driver = new FakeOmpDriver({
					sessionDir,
					store: sessions,
					holdTurns: holdReview && origin === SKILL_REVIEW_ORIGIN,
				});
				built.push({ origin, sessionDir, driver });
				return driver;
			},
		});
		daemon = started;
		await started.start();
		return started;
	}

	/** Resolves when `done()` holds after a log line (bounded; never a sleep). */
	function until(done: () => boolean, what: string): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const check = () => {
			if (!done()) return;
			clearTimeout(timer);
			waiters = waiters.filter((w) => w !== check);
			resolve();
		};
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 4_000);
		waiters.push(check);
		check();
		return promise;
	}

	const reviews = () => built.filter((b) => b.origin === SKILL_REVIEW_ORIGIN);

	beforeEach(() => {
		home = makeHome("ompbot-distill-");
		transport = new WaitingTransport();
		lines = [];
		waiters = [];
		built = [];
		holdReview = false;
		daemon = undefined;
	});

	afterEach(async () => {
		for (const b of built) b.driver.release();
		await daemon?.stop();
		home.remove();
	});

	/** One answered DM turn, then a session file in that origin's session dir for the digest to read. */
	async function chatThenSessionFile(started: Daemon): Promise<string> {
		await started.inject({ origin: DM, asOwner: true, text: "안녕" });
		await transport.waitForPosts((text) => text.includes("ECHO 안녕"));
		const sessionDir = started.store.getOrigin(DM)?.sessionDir;
		if (sessionDir === undefined) throw new Error("DM origin missing");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(
			join(sessionDir, "s.jsonl"),
			`${JSON.stringify({ message: { role: "user", content: "DIGESTMARK 릴리스 절차를 또 물어봤다" } })}\n`,
		);
		return sessionDir;
	}

	test("starts one review of this origin's session digest and answers at once", async () => {
		const started = await boot();
		await chatThenSessionFile(started);
		await started.inject({ origin: DM, asOwner: true, text: "!distill" });
		await transport.waitForPosts((text) => text.includes("스킬 리뷰를 시작했습니다"));
		await until(() => lines.some((l) => l.includes("event=skill_review_no_proposal")), "review end");
		expect(reviews()).toHaveLength(1);
		expect(reviews()[0]?.sessionDir).toContain(encodeURIComponent(SKILL_REVIEW_ORIGIN));
		const prompt = reviews()[0]?.driver.calls.find((c) => c.startsWith("prompt:")) ?? "";
		expect(prompt).toContain("DIGESTMARK 릴리스 절차를 또 물어봤다");
		// No prompt of the command itself reached the DM's own omp child.
		const dmPrompts = built
			.filter((b) => b.origin === DM)
			.flatMap((b) => b.driver.calls.filter((c) => c.startsWith("prompt:")));
		expect(dmPrompts).toEqual(["prompt:안녕"]);
	});

	test("while a review runs, a second !distill says it is already reviewing and starts nothing", async () => {
		holdReview = true;
		const started = await boot();
		await chatThenSessionFile(started);
		await started.inject({ origin: DM, asOwner: true, text: "!distill" });
		await transport.waitForPosts((text) => text.includes("스킬 리뷰를 시작했습니다"));
		await until(() => reviews().length === 1, "review driver");
		await started.inject({ origin: DM, asOwner: true, text: "!distill" });
		await transport.waitForPosts((text) => text.includes("이미 리뷰 중"));
		expect(reviews()).toHaveLength(1);
	});

	test("a conversation with no session content (e.g. a channel top-level command) is refused without a review", async () => {
		const started = await boot();
		await started.inject({ origin: DM, asOwner: true, text: "!distill" });
		await transport.waitForPosts((text) => text.includes("리뷰할 세션 내용이 없습니다"));
		expect(reviews()).toHaveLength(0);
		expect(started.drainCounts().turns).toBe(0);
	});

	test("frozen: says it did not run and starts no omp turn", async () => {
		const started = await boot();
		await chatThenSessionFile(started);
		writeFreeze(home.dir, { reason: "test", by: "cli", now: Date.now() });
		await started.inject({ origin: DM, asOwner: true, text: "!distill" });
		await transport.waitForPosts((text) => text.includes("동결 중이라 하지 않았습니다"));
		expect(reviews()).toHaveLength(0);
		expect(started.drainCounts().turns).toBe(0);
	});
});
