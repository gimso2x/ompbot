import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/log";
import type { OmpFinal, OmpSessionDriver } from "../src/omp/driver";
import { redact } from "../src/redact";
import {
	backupSkillRevision,
	buildSkillReviewPrompt,
	extractProposals,
	listSkillRevisions,
	readSessionDigest,
	renderSkillFile,
	rollbackSkill,
	runSkillReview,
	type SkillProposal,
	type SkillReviewDeps,
	savePendingProposals,
	skillDirOf,
} from "../src/review/skills";
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
			},
		]);
		expect(extractProposals("NO_PROPOSAL")).toEqual([]);
		expect(extractProposals("nothing useful")).toEqual([]);
		expect(extractProposals('[{"name":"Bad Name","description":"d","content":"c"}]')).toEqual([]);
		expect(extractProposals('[{"name":"ok","description":"","content":"c"}]')).toEqual([]);
	});

	test("a proposal carrying a token-shaped secret is refused", () => {
		const tainted = JSON.stringify([
			// Assembled at runtime so secret scanners (gitleaks) do not flag the fixture; the value is unchanged.
			{
				action: "create",
				name: "leak",
				description: "d",
				content: `token: ${["xoxb", "1234567890", "abcdefghij"].join("-")}`,
			},
		]);
		expect(extractProposals(tainted)).toEqual([]);
	});
});

describe("renderSkillFile / savePendingProposals", () => {
	test("renders frontmatter and writes 0600 pending files", () => {
		const proposal: SkillProposal = {
			action: "create",
			name: "release-checklist",
			description: "Use when cutting a release",
			content: "steps",
		};
		expect(renderSkillFile(proposal)).toBe(
			"---\nname: release-checklist\ndescription: Use when cutting a release\n---\n\nsteps\n",
		);
		const paths = savePendingProposals(dir, [proposal], 1_700_000_000_000);
		expect(paths).toHaveLength(1);
		expect(readdirSync(join(dir, "skills-pending"))).toHaveLength(1);
		expect(JSON.parse(readFileSync(paths[0] as string, "utf8"))).toMatchObject({ name: "release-checklist" });
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
		const failed = deps("approved", "boom");
		failed.makeDriver = () => fakeDriver("boom", "error");
		expect(await runSkillReview(failed, { sessionDir: join(dir, "review") })).toEqual({ proposals: 0, installed: 0 });
	});

	test("the review prompt refuses one-off narratives and secrets", () => {
		const prompt = buildSkillReviewPrompt("오너: 안녕");
		expect(prompt).toContain("일회성 작업 서사");
		expect(prompt).toContain("비밀값");
		expect(prompt).toContain("NO_PROPOSAL");
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

		const env = { OMPBOT_TEST_HOOKS: "1", OMPBOT_SKILLS_DIR: join(dir, ".omp", "agent", "skills") };
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
