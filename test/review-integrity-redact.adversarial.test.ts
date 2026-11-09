// A4 adversarial pass: skill review (extractProposals/renderSkillFile/savePending/digest), lane integrity
// classifier, and the secret value index in redact.ts.
// Regression suite: each DEFECT comment names the defect a test once pinned; all are fixed.
//
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyLaneCompletion, type IntegrityRefusal } from "../src/lanes/integrity";
import { clearSecretIndex, indexSecretValue, REDACTED, redact, secretIndexSize } from "../src/redact";
import {
	extractProposals,
	MAX_PROPOSALS,
	readSessionDigest,
	renderSkillFile,
	type SkillProposal,
	savePendingProposals,
} from "../src/review/skills";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-a4-"));
	clearSecretIndex();
});

afterEach(() => {
	clearSecretIndex();
	rmSync(dir, { recursive: true, force: true });
});

const item = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
	action: "create",
	name: "release-checklist",
	description: "릴리스 전 점검 절차. 배포 직전에 사용.",
	content: "1. 테스트 실행\n2. 태그",
	evidence: "이 대화에서 릴리스 절차를 두 번 통과시켰다",
	checks: [
		{ situation: "릴리스를 요청할 때", expect: "발동한다" },
		{ situation: "평소 수정 요청", expect: "발동하지 않는다" },
	],
	...over,
});

const arr = (...items: Array<Record<string, unknown>>): string => JSON.stringify(items);

// ---------------------------------------------------------------------------
// extractProposals
// ---------------------------------------------------------------------------
describe("extractProposals adversarial", () => {
	test("bracketed prose BEFORE the fenced JSON must not discard the proposals", () => {
		// DEFECT (src/review/skills.ts:65): start = first "[" or "{" anywhere, so a leading "[결과]" tag (the prompt
		// itself uses "[스킬 리뷰]"/"[대화]" style) makes JSON.parse fail and every proposal is silently dropped.
		const answer = `[결과] 제안 1건입니다.\n\`\`\`json\n${arr(item())}\n\`\`\``;
		expect(extractProposals(answer).map((p) => p.name)).toEqual(["release-checklist"]);
	});

	test("bracket/brace prose AFTER the JSON must not discard the proposals", () => {
		// DEFECT (src/review/skills.ts:67-69): end = last "]" or "}" in the whole answer, so trailing prose like
		// "(위 [1] 참고)" extends the slice past the JSON and the parse fails.
		const answer = `${arr(item())}\n\n위 제안은 {일반화한 절차} 입니다 [1].`;
		expect(extractProposals(answer).map((p) => p.name)).toEqual(["release-checklist"]);
	});

	test("prose + fence mix without brackets works; single object accepted; wrapper object yields nothing", () => {
		const fenced = `검토 결과입니다.\n\`\`\`json\n${arr(item())}\n\`\`\`\n이상입니다.`;
		expect(extractProposals(fenced)).toHaveLength(1);
		expect(extractProposals(JSON.stringify(item()))).toHaveLength(1);
		// A {"proposals":[...]} wrapper is not understood: documented silent drop (no throw).
		expect(extractProposals(JSON.stringify({ proposals: [item()] }))).toEqual([]);
		expect(extractProposals("NO_PROPOSAL.")).toEqual([]);
		expect(extractProposals("[]")).toEqual([]);
		expect(extractProposals("][")).toEqual([]);
		expect(extractProposals("}{")).toEqual([]);
	});

	test("action: missing defaults to create, but unknown actions must not become create", () => {
		const noAction = item();
		delete noAction.action;
		expect(extractProposals(arr(noAction))[0]?.action).toBe("create");
		expect(extractProposals(arr(item({ action: "patch" })))[0]?.action).toBe("patch");
		// DEFECT (src/review/skills.ts:82): everything that is not exactly "patch" is coerced to "create", so a
		// proposal asking for "delete"/"remove" (or "PATCH") is silently turned into an install of a new skill.
		const coerced = ["delete", "remove", "overwrite"].filter(
			(action) => extractProposals(arr(item({ action })))[0]?.action === "create",
		);
		expect(coerced).toEqual([]);
	});

	test("names: traversal, unicode, case, dots, length boundary, embedded control chars", () => {
		const bad = [
			"../../etc/passwd",
			"..",
			".hidden",
			"a/b",
			"a\\b",
			"한글-스킬",
			"Release",
			"release checklist",
			"a\nb",
			"a\u0000b",
			"é",
			"-lead",
			"x".repeat(65),
			"",
		];
		const accepted = bad.filter((name) => extractProposals(arr(item({ name }))).length > 0);
		expect(accepted).toEqual([]);
		const ok = ["x".repeat(64), "a", "0day", "a.b_c-d", "a..b"];
		expect(ok.filter((name) => extractProposals(arr(item({ name }))).length === 0)).toEqual([]);
		// Surrounding whitespace is trimmed rather than rejected.
		expect(extractProposals(arr(item({ name: "  padded\n" })))[0]?.name).toBe("padded");
	});

	test("description and content size boundaries (trim happens before the limit)", () => {
		const d = (n: number) => "d".repeat(n);
		expect(extractProposals(arr(item({ description: d(1024) })))).toHaveLength(1);
		expect(extractProposals(arr(item({ description: d(1025) })))).toHaveLength(0);
		// 1030 chars of which 6 are padding trim down to 1024 and are accepted.
		expect(extractProposals(arr(item({ description: `   ${d(1024)}   ` })))).toHaveLength(1);
		expect(extractProposals(arr(item({ description: "   \n\t " })))).toHaveLength(0);
		// 1024 astral chars = 2048 UTF-16 units: counted in units, so rejected (documents unit semantics).
		expect(extractProposals(arr(item({ description: "😀".repeat(1024) })))).toHaveLength(0);
		expect(extractProposals(arr(item({ content: "c".repeat(100_000) })))).toHaveLength(1);
		expect(extractProposals(arr(item({ content: "c".repeat(100_001) })))).toHaveLength(0);
		expect(extractProposals(arr(item({ content: `${"c".repeat(100_000)}\n\n` })))).toHaveLength(1);
		expect(extractProposals(arr(item({ content: 5, description: null, name: ["x"] })))).toEqual([]);
	});

	test("duplicate names are collapsed to one proposal", () => {
		// DEFECT (src/review/skills.ts:79-92): no de-duplication by name. Two proposals with the same name are both
		// approved/installed (second overwrites the first) and both counted against MAX_PROPOSALS.
		const out = extractProposals(
			arr(item({ content: "first" }), item({ content: "second" }), item({ name: "other", content: "third" })),
		);
		expect(out.map((p) => p.name)).toEqual(["release-checklist", "other"]);
	});

	test("MAX_PROPOSALS applies after filtering invalid entries and keeps order", () => {
		const entries = [
			item({ name: "BAD" }),
			item({ name: "n1" }),
			item({ name: "n2", description: "" }),
			item({ name: "n3" }),
			item({ name: "n4" }),
			item({ name: "n5" }),
		];
		expect(extractProposals(arr(...entries)).map((p) => p.name)).toEqual(["n1", "n3", "n4"]);
		expect(MAX_PROPOSALS).toBe(3);
	});

	test("an indexed secret is rejected from the description alone, from content alone, and split by formatting", () => {
		const secret = ["Zq8LmN4vTr2X", "cBw7YpH3sKd9"].join(""); // runtime-assembled: keeps gitleaks quiet, same value
		expect(indexSecretValue(secret)).toBe(true);
		expect(extractProposals(arr(item({ description: `사용법: 키는 ${secret}` })))).toEqual([]);
		expect(extractProposals(arr(item({ content: `export KEY=${secret}` })))).toEqual([]);
		const split = `${secret.slice(0, 10)} ${secret.slice(10)}`;
		expect(extractProposals(arr(item({ description: split })))).toEqual([]);
		// JSON \u escapes decode before the check.
		const escaped = secret.replace(/^Zq8/, "\\u005aq8");
		expect(extractProposals(`[{"name":"a","description":"k ${escaped}","content":"x"}]`)).toEqual([]);
		// Clean proposals still pass with the index populated.
		expect(extractProposals(arr(item()))).toHaveLength(1);
	});

	test("an indexed secret smuggled through the NAME field is rejected", () => {
		// DEFECT (src/review/skills.ts:90): only description+content go through redact(); `name` (allowed [a-z0-9._-],
		// 64 chars) is not checked, yet it lands in the pending filename, the Slack approval text and the skills dir.
		const secret = ["9f86d081884c7d65", "9a2feaa0c55ad015"].join(""); // runtime-assembled: keeps gitleaks quiet, same value
		expect(indexSecretValue(secret)).toBe(true);
		expect(extractProposals(arr(item({ name: secret })))).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// renderSkillFile / savePendingProposals / readSessionDigest
// ---------------------------------------------------------------------------
function frontmatter(file: string): string {
	const match = /^---\n([\s\S]*?)\n---\n/.exec(file);
	if (match === null) throw new Error("no frontmatter");
	return match[1] ?? "";
}

function proposal(over: Partial<SkillProposal> = {}): SkillProposal {
	return {
		action: "create",
		name: "demo",
		description: "desc",
		content: "body",
		evidence: "이 대화에서 통한 근거",
		checks: [
			{ situation: "s1", expect: "e1" },
			{ situation: "s2", expect: "e2" },
		],
		...over,
	};
}

describe("renderSkillFile adversarial", () => {
	test("description cannot break out of the frontmatter via any line break or ---", () => {
		// DEFECT (src/review/skills.ts:98): only "\n" is replaced. "\r", U+2028/U+2029 and U+0085 survive and are line
		// breaks to YAML/other frontmatter readers, so `description: a\r---\rinjected: 1` escapes the block.
		const breaks = ["\r", "\u2028", "\u2029", "\u0085", "\r\n", "\n"];
		const leaked: string[] = [];
		for (const br of breaks) {
			const file = renderSkillFile(proposal({ description: `legit${br}---${br}injected: true${br}name: evil` }));
			const lines = file.split(/\r\n|[\r\u2028\u2029\u0085]|\n/);
			// Expected head: ---, name, description, --- ; a break surviving in the description adds lines before the
			// closing ---. The appended adoption-check section only adds lines after it.
			const close = lines.indexOf("---", 1);
			if (close !== 3) leaked.push(JSON.stringify(br));
		}
		expect(leaked).toEqual([]);
	});

	test("newline injection with '\\n---\\n' stays inside a single description line", () => {
		const file = renderSkillFile(proposal({ description: "a\n---\nname: evil\n---\nmore" }));
		expect(frontmatter(file).split("\n")).toHaveLength(2);
		// The body keeps its place; the adoption-check section follows it, never between frontmatter and body.
		expect(file).toContain("---\n\nbody\n\n## 채택 검증");
	});

	test("rendered frontmatter parses back to the same name/description (YAML-special descriptions)", () => {
		// DEFECT (src/review/skills.ts:98): the description is emitted as a plain YAML scalar with no quoting. The prompt
		// asks the model for "무엇을 하는 스킬인지 + 언제 쓰는지", so ": " / leading "[" / " #" are routine and break parsing.
		const descriptions = [
			"배포 점검: 릴리스 전에 사용",
			"[draft] release helper",
			"use when #release is near",
			"*important* steps",
			"> folded?",
			"- dash start",
			"'quoted' start",
			"@at-sign",
		];
		const broken: string[] = [];
		for (const description of descriptions) {
			try {
				const parsed = Bun.YAML.parse(frontmatter(renderSkillFile(proposal({ description })))) as {
					name?: unknown;
					description?: unknown;
				};
				if (parsed.description !== description) broken.push(description);
			} catch {
				broken.push(description);
			}
		}
		expect(broken).toEqual([]);
	});

	test("names that YAML reads as non-strings (null/true/numbers) round-trip as strings", () => {
		// DEFECT (src/review/skills.ts:31,98): NAME_PATTERN admits "null", "true", "123", "1.5", "0x1f" which an unquoted
		// frontmatter turns into null/bool/number, so the installed skill has no usable string name.
		const names = ["null", "true", "no", "123", "1.5", "0x1f", "1e3"];
		const wrong: string[] = [];
		for (const name of names) {
			expect(extractProposals(arr(item({ name }))).map((p) => p.name)).toEqual([name]);
			const parsed = Bun.YAML.parse(frontmatter(renderSkillFile(proposal({ name })))) as { name?: unknown };
			if (parsed.name !== name) wrong.push(name);
		}
		expect(wrong).toEqual([]);
	});
});

describe("skill persistence adversarial", () => {
	test("two proposals with the same name do not overwrite each other's pending file", () => {
		// DEFECT (src/review/skills.ts:170-172): file name is `<stamp>-<name>.json`, so same-name proposals in one batch
		// collide and the second silently replaces the first while two identical paths are returned.
		const paths = savePendingProposals(
			dir,
			[proposal({ name: "same", content: "first" }), proposal({ name: "same", content: "second" })],
			Date.UTC(2026, 9, 24, 1, 2, 3, 456),
		);
		expect(new Set(paths).size).toBe(2);
		expect(readdirSync(join(dir, "skills-pending"))).toHaveLength(2);
	});

	test("readSessionDigest never emits lone surrogates when it truncates astral text", async () => {
		// DEFECT (src/review/skills.ts:213,217): `text.slice(0, perMessage)` and `digest.slice(-totalCap)` cut by UTF-16
		// units, so an emoji can be split and the digest handed to the child (JSON-encoded) carries a lone surrogate.
		const rows = [
			{ message: { role: "user", content: "😀😀😀😀😀😀" } },
			{ message: { role: "assistant", content: [{ type: "text", text: "😀".repeat(40) }] } },
		];
		writeFileSync(join(dir, "s.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n{"torn":`);
		for (const [perMessage, totalCap] of [
			[5, 12_000],
			[7, 12_000],
			[800, 11],
			[800, 12],
		] as const) {
			const digest = await readSessionDigest(dir, 24, perMessage, totalCap);
			expect(digest.isWellFormed()).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// classifyLaneCompletion
// ---------------------------------------------------------------------------
const hunk = (header: string[], ...lines: string[]): string => [...header, "@@ -1 +1 @@", ...lines].join("\n");
const DIFF = (file: string, ...lines: string[]): string =>
	hunk([`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`], ...lines);
const cats = (summary: string, diff: string): IntegrityRefusal["category"][] =>
	classifyLaneCompletion({ summary, diff }).map((r) => r.category);

describe("classifyLaneCompletion adversarial", () => {
	test("Korean claims: bare '검증 완료' is refused, with a real command it passes", () => {
		const diff = DIFF("src/a.ts", "+export const a = 1;");
		expect(cats("검증 완료", diff)).toEqual(["unproven_claim_word"]);
		expect(cats("수정 완료했습니다. 테스트도 통과.", diff)).toEqual(["unproven_claim_word"]);
		expect(cats("검증 완료 — `bun test` 전체 통과", diff)).toEqual([]);
		expect(cats("수정 완료 (bunx tsc --noEmit, biome 통과)", diff)).toEqual([]);
		expect(cats("구현만 했습니다. 아직 실행 안 함.", diff)).toEqual([]);
		expect(cats("", diff)).toEqual([]);
		expect(cats("   \n", diff)).toEqual([]);
	});

	test("a command word hidden inside another word does not count as verification", () => {
		// DEFECT (src/lanes/integrity.ts:34-35): COMMAND_TOKEN has no word boundaries. "legit " contains "git ",
		// "fastscan" would contain "tsc", so an unproven claim passes without any command.
		const diff = DIFF("src/a.ts", "+export const a = 1;");
		expect(cats("legit 하게 전부 통과했습니다", diff)).toEqual(["unproven_claim_word"]);
		expect(cats("all tests passed, trust the digit counts", diff)).toEqual(["unproven_claim_word"]);
	});

	test("claim words embedded in unrelated words are not treated as claims", () => {
		// DEFECT (src/lanes/integrity.ts:33): no word boundaries on CLAIM_WORD. "fixed-width", "greenfield" and
		// "bypassed" are not verification claims but are refused as unproven_claim_word (false positives that
		// block lane completion until the owner approves).
		const diff = DIFF("src/a.ts", "+export const a = 1;");
		const refused = [
			"Added a fixed-width table renderer",
			"greenfield 모듈 스캐폴딩 추가",
			"cache is bypassed for health checks",
		].filter((summary) => cats(summary, diff).length > 0);
		expect(refused).toEqual([]);
	});

	test("real runner spellings (bun run test, npm run test, bun  test) count as commands", () => {
		// DEFECT (src/lanes/integrity.ts:34-35): COMMAND_TOKEN only knows "bun test"/"npm test"-style literals.
		const diff = DIFF("src/a.ts", "+export const a = 1;");
		const refused = [
			"bun run test 통과",
			"npm run test 통과",
			"bun  test 통과",
			"bun run check 통과",
			"bun run typecheck passed",
		].filter((summary) => cats(summary, diff).length > 0);
		expect(refused).toEqual([]);
	});

	test("unfinished markers: string literals and arithmetic vs. real comments in other syntaxes", () => {
		// A TODO inside a plain string literal with no comment is not a marker.
		expect(cats("done", DIFF("src/a.ts", '+const label = "TODO";'))).toEqual([]);
		expect(cats("done", DIFF("src/a.ts", '+const kind = "FIXME" as const;'))).toEqual([]);
		// Real markers.
		expect(cats("done", DIFF("src/a.ts", "+x(); // FIXME later"))).toEqual(["unfinished_work_marker"]);
		expect(cats("done", DIFF("src/a.ts", "+/* HACK */"))).toEqual(["unfinished_work_marker"]);
		// DEFECT (src/lanes/integrity.ts:26): COMMENT contains a bare `\*`, so any multiplication/glob on the same line
		// as the word "TODO" in a string is treated as a comment marker.
		expect(cats("done", DIFF("src/a.ts", '+const w = count * 2 + "TODO".length;'))).toEqual([]);
	});

	test("unfinished markers in comment styles the COMMENT regex does not know", () => {
		// DEFECT (src/lanes/integrity.ts:26-27): `#` must be followed by whitespace, SQL/Lua `--` and `;;`/`%` are missing,
		// and UNFINISHED is case-sensitive, so these added markers are never refused.
		const missed = [
			["src/a.py", "+x = 1  #TODO fix"],
			["src/a.sh", "+echo hi #FIXME"],
			["db/a.sql", "+-- TODO drop column"],
			["src/a.ts", "+// todo: handle errors"],
			["src/a.ts", "+// Todo: handle errors"],
		].filter(([file, line]) => cats("done", DIFF(file as string, line as string)).length === 0);
		expect(missed).toEqual([]);
	});

	test("docs exemption must not cover code under src/docs/ or src/examples/", () => {
		// DEFECT (src/lanes/integrity.ts:24,54): DOC_PATH matches any path SEGMENT named docs/examples/fixtures, even for
		// real source files (CODE_EXT already restricts judging to code). A lane can park TODOs, skipped tests and stubs in
		// src/docs/*.ts, src/examples/*.ts or test/fixtures/*.ts and pass the integrity gate.
		const missed = [
			["src/docs/render.ts", "+// TODO: finish"],
			["src/examples/run.ts", '+throw new Error("not implemented");'],
			["test/fixtures/a.test.ts", "+test.skip('x', () => {});"],
		].filter(([file, line]) => cats("done", DIFF(file as string, line as string)).length === 0);
		expect(missed).toEqual([]);
		// Markdown under docs/ is not code at all and stays exempt.
		expect(cats("done", DIFF("docs/guide.md", "+TODO: write"))).toEqual([]);
	});

	test("deleting a whole guard file (+++ /dev/null) is a guard deletion", () => {
		// DEFECT (src/lanes/integrity.ts:49-54): for a deleted file the "+++" header is /dev/null, so `file` never matches
		// CODE_EXT and every removed line is dropped. Removing src/guard.ts (or a whole negative test file) is invisible.
		const del = hunk(
			["diff --git a/src/guard.ts b/src/guard.ts", "deleted file mode 100644", "--- a/src/guard.ts", "+++ /dev/null"],
			"-export function check(ok: boolean) {",
			'-\tif (!ok) throw new Error("denied");',
			"-}",
		);
		expect(cats("done", del)).toEqual(["guard_deletion_without_adversarial_regression"]);
		const delTest = hunk(
			[
				"diff --git a/test/g.test.ts b/test/g.test.ts",
				"deleted file mode 100644",
				"--- a/test/g.test.ts",
				"+++ /dev/null",
			],
			"-test('refuses empty input', () => {});",
		);
		expect(cats("done", delTest)).toEqual(["guard_deletion_without_adversarial_regression"]);
	});

	test("git-quoted non-ASCII paths (core.quotepath) are still judged", () => {
		// DEFECT (src/lanes/integrity.ts:50,54): git prints `+++ "b/src/\355\225\234.ts"` for Hangul paths. The quotes break
		// the `b/` strip and the `\.ts$` test, so the whole file is skipped and TODO/skip/stub lines pass.
		const quoted = hunk(
			[
				'diff --git "a/src/\\355\\225\\234.ts" "b/src/\\355\\225\\234.ts"',
				'--- "a/src/\\355\\225\\234.ts"',
				'+++ "b/src/\\355\\225\\234.ts"',
			],
			"+// TODO: later",
			"+test.skip('x', () => {});",
		);
		expect(cats("done", quoted)).toEqual(["unfinished_work_marker", "skipped_test"]);
	});

	test("guard vocabulary that is only ADDED is never a deletion; moved guards are not flagged", () => {
		expect(cats("done", DIFF("src/a.ts", '+if (!ok) throw new Error("denied");', "+// validate input"))).toEqual([]);
		// Same guard removed here and re-added elsewhere (exact trimmed text) is a move, not a deletion.
		const moved = [
			"diff --git a/src/a.ts b/src/a.ts",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -1 +0,0 @@",
			'-\tif (!ok) throw new Error("denied");',
			"diff --git a/src/b.ts b/src/b.ts",
			"--- a/src/b.ts",
			"+++ b/src/b.ts",
			"@@ -0,0 +1 @@",
			'+if (!ok) throw new Error("denied");',
		].join("\n");
		expect(cats("done", moved)).toEqual([]);
	});

	test("an 'adversarial test' credit must come from a test file, not any added line containing 'invalid'", () => {
		// DEFECT (src/lanes/integrity.ts:95): hasAdversarialTest = any added line in ANY code file matching NEGATIVE_TEST.
		// Deleting a permission guard while adding `const msg = "invalid"` in production code clears the refusal.
		const diff = [
			"diff --git a/src/a.ts b/src/a.ts",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -1 +0,0 @@",
			'-if (!allowed) throw new Error("permission denied");',
			"diff --git a/src/b.ts b/src/b.ts",
			"--- a/src/b.ts",
			"+++ b/src/b.ts",
			"@@ -0,0 +1 @@",
			'+const label = "invalid";',
		].join("\n");
		expect(cats("done", diff)).toEqual(["guard_deletion_without_adversarial_regression"]);
		// And a genuine negative test in a test file does clear it.
		const withTest = `${diff}\ndiff --git a/test/a.test.ts b/test/a.test.ts\n--- a/test/a.test.ts\n+++ b/test/a.test.ts\n@@ -0,0 +1 @@\n+test('refuses without permission', () => {});`;
		expect(cats("done", withTest)).toEqual([]);
	});

	test("empty/garbage diff: only the claim is judged; a fix claim over zero changes is documented as accepted", () => {
		expect(cats("done", "")).toEqual([]);
		expect(cats("done", "\n\n")).toEqual([]);
		expect(cats("done", "not a diff at all\n+// TODO x")).toEqual([]);
		expect(cats("수정 완료", "")).toEqual(["unproven_claim_word"]);
		// Documented limitation: "bun test 통과" over an empty diff is accepted (diff "" also means "unreadable").
		expect(cats("수정 완료, bun test 통과", "")).toEqual([]);
	});

	test("skipped-test and stub detectors miss common spellings", () => {
		// DEFECT (src/lanes/integrity.ts:28-29,89): SKIPPED_TEST lacks xtest(/test.todo(/it.skipIf(/describe.todo, and any
		// line containing "abstract"/"overload" (even in a message string) is exempt from the stub check.
		const missed = [
			"+xtest('x', () => {});",
			'+test.todo("handle X");',
			"+it.skipIf(process.env.CI)('x', () => {});",
			"+describe.skip.each([1])('x', () => {});",
			'+throw new Error("not implemented"); // abstract',
			"+raise NotImplementedError  # overload later",
		].filter((line) => cats("done", DIFF("test/a.test.ts", line)).length === 0);
		expect(missed).toEqual([]);
	});

	test("refusals are capped at 8 and excerpts at 120 chars of text", () => {
		const lines = Array.from({ length: 30 }, (_, i) => `+// TODO item ${i} ${"x".repeat(300)}`);
		const out = classifyLaneCompletion({ summary: "수정 완료", diff: DIFF("src/a.ts", ...lines) });
		expect(out).toHaveLength(8);
		expect(out.every((r) => r.category === "unfinished_work_marker")).toBe(true);
		for (const r of out) expect(r.excerpt.length).toBeLessThanOrEqual("src/a.ts: ".length + 120);
		// Cap hides the unproven-claim refusal entirely when 8+ marker lines come first.
		expect(out.some((r) => r.category === "unproven_claim_word")).toBe(false);
	});

	test("huge diffs classify quickly and CRLF content lines still match", () => {
		const many = Array.from({ length: 200_000 }, (_, i) => `+export const v${i} = ${i};`);
		const started = performance.now();
		expect(cats("bun test 통과", DIFF("src/big.ts", ...many))).toEqual([]);
		expect(performance.now() - started).toBeLessThan(5_000);
		expect(cats("done", DIFF("src/a.ts", "+// TODO: crlf\r"))).toEqual(["unfinished_work_marker"]);
	});
});

// ---------------------------------------------------------------------------
// redact value index
// ---------------------------------------------------------------------------
// Assembled at runtime so secret scanners (gitleaks) do not flag the fixture; the value is unchanged.
const TOKEN = ["Tgk4dJqLm7pQ", "xZ2wVn9sBfYeHc"].join("");

describe("secret value index adversarial", () => {
	test("indexing does not corrupt ordinary text, including this very source file", () => {
		indexSecretValue(TOKEN);
		// Source files that mention token shapes (xapp-, sk-) are masked by the pattern layer by design; use ones that don't.
		const corpus = ["src/lanes/integrity.ts", "src/review/skills.ts"]
			.map((file) => readFileSync(join(import.meta.dir, "..", file), "utf8"))
			.join("\n");
		expect(redact(corpus)).toBe(corpus);
		expect(redact("")).toBe("");
		expect(redact("short")).toBe("short");
	});

	test("window boundary: 15 chars stay, 16 are masked, a text of exactly 16 chars works, 16-char value is indexable", () => {
		indexSecretValue(TOKEN);
		expect(redact(`a ${TOKEN.slice(0, 15)} b`)).toBe(`a ${TOKEN.slice(0, 15)} b`);
		expect(redact(`a ${TOKEN.slice(0, 16)} b`)).toBe(`a ${REDACTED} b`);
		expect(redact(TOKEN.slice(3, 19))).toBe(REDACTED);
		clearSecretIndex();
		expect(indexSecretValue("abcdefghijklmno")).toBe(false);
		expect(indexSecretValue("abcdefghijklmnop")).toBe(true);
		expect(redact("abcdefghijklmnop")).toBe(REDACTED);
		// Whitespace padding does not count toward the 16-char minimum.
		expect(indexSecretValue("  abcdefgh   ijklmno  ")).toBe(false);
	});

	test("short common-word secret made of ordinary words masks only real 16-char continuations", () => {
		expect(indexSecretValue("correct horse battery staple")).toBe(true);
		expect(redact("the horse is correct, battery low")).toBe("the horse is correct, battery low");
		expect(redact("correct horse bat")).toBe("correct horse bat");
		expect(redact("x correct horse battery y")).toBe(`x ${REDACTED} y`);
	});

	test("overlapping and adjacent secrets are fully masked", () => {
		const a = "AAAAbbbbCCCCddddEEEEffff";
		const b = "EEEEffffGGGGhhhhIIIIjjjj";
		indexSecretValue(a);
		indexSecretValue(b);
		expect(redact(`${a}${b}`)).toBe(REDACTED);
		expect(redact(`${a} ${b}`)).toBe(REDACTED);
		const joined = "AAAAbbbbCCCCddddEEEEffffGGGGhhhhIIIIjjjj";
		expect(redact(`k=${joined}!`)).toBe(`k=${REDACTED}!`);
		const sep = redact(`${b}|${a}`);
		expect(sep).toBe(`${REDACTED}|${REDACTED}`);
		expect(sep).not.toContain("bbbb");
	});

	test("repeated masking is idempotent and handles many occurrences", () => {
		indexSecretValue(TOKEN);
		const text = `${TOKEN} and ${TOKEN}\n`.repeat(2_000);
		const once = redact(text);
		// Adjacent secrets separated only by ignored chars (the "\n" between lines) merge into one span, so the exact
		// separator layout is not asserted; the invariants are: no leak, bounded growth, idempotence.
		expect(once.includes(TOKEN.slice(0, 8))).toBe(false);
		expect(once.length).toBeLessThan(text.length);
		expect(redact(once)).toBe(once);
		expect(redact(redact(once))).toBe(once);
		expect(indexSecretValue(TOKEN)).toBe(true);
		const size = secretIndexSize();
		indexSecretValue(TOKEN);
		expect(secretIndexSize()).toBe(size);
	});

	test("secrets made only of ignored characters are not indexed and cannot mask arbitrary text", () => {
		const ignoredOnly = [
			" ".repeat(40),
			"\n\t ".repeat(10),
			"\"'`,+\\".repeat(5),
			"\u200b\u200c\u200d\u2060\ufeff".repeat(5),
		];
		for (const value of ignoredOnly) expect(indexSecretValue(value)).toBe(false);
		expect(secretIndexSize()).toBe(0);
		const text = 'plain text with spaces, quotes "and" commas'.repeat(10);
		expect(redact(text)).toBe(text);
	});

	test("clearSecretIndex leaves no residue; shaped tokens are still masked by the pattern layer", () => {
		indexSecretValue(TOKEN);
		indexSecretValue("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
		expect(secretIndexSize()).toBeGreaterThan(0);
		clearSecretIndex();
		expect(secretIndexSize()).toBe(0);
		expect(redact(`v=${TOKEN} ${Buffer.from(TOKEN).toString("hex")} ${[...TOKEN].reverse().join("")}`)).toBe(
			`v=${TOKEN} ${Buffer.from(TOKEN).toString("hex")} ${[...TOKEN].reverse().join("")}`,
		);
		expect(redact("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(REDACTED);
	});

	test("zero-width and other invisible separators inserted into a leaked secret do not evade masking", () => {
		// DEFECT (src/redact.ts:22-23): IGNORED only covers \u200b-\u200d, \u2060, \ufeff. U+00AD (soft hyphen), U+200E/F
		// (LRM/RLM), U+2061-2064, U+180E and U+034F are invisible too and defeat the 16-char window when inserted
		// every few characters of an exfiltrated secret.
		indexSecretValue(TOKEN);
		const evaded = ["\u00ad", "\u200e", "\u200f", "\u2061", "\u2062", "\u180e", "\u034f", "\u2063"].filter(
			(invisible) => {
				const sneaky = TOKEN.match(/.{1,5}/g)?.join(invisible) ?? TOKEN;
				return redact(`leak: ${sneaky}`).includes(TOKEN.slice(0, 5));
			},
		);
		expect(evaded).toEqual([]);
		// Control: the already-handled separators do mask.
		expect(redact(`leak: ${TOKEN.slice(0, 9)}\u200b${TOKEN.slice(9)}`)).toBe(`leak: ${REDACTED}`);
	});

	test("a base64 copy of the secret is masked completely, including its tail", () => {
		// DEFECT (src/redact.ts:41-45): base64StablePrefixes drops the last 3 base64 chars of every alignment form, so the
		// tail of an encoded copy (and its "=" padding) stays visible: `[REDACTED]xyz=` leaks the final bytes.
		indexSecretValue(TOKEN);
		const std = Buffer.from(TOKEN).toString("base64");
		const url = Buffer.from(TOKEN).toString("base64url");
		expect(redact(`b64: ${std}`)).toBe(`b64: ${REDACTED}`);
		expect(redact(`b64: ${url}`)).toBe(`b64: ${REDACTED}`);
	});

	test("transformed copies of a secret that contains ignored characters (+ , quote) are masked", () => {
		// The index normalizes the raw value (drops + , " \ whitespace) BEFORE hex/base64 encoding, but a leaked copy is the
		// encoding of the ORIGINAL bytes. Expect no byte-level leak at the junction where the ignored char was.
		const raw = 'pa55,word+Sup3r"Secret\\Value-xyz';
		expect(indexSecretValue(raw)).toBe(true);
		expect(redact(`raw: ${raw}`)).toBe(`raw: ${REDACTED}`);
		const hex = Buffer.from(raw).toString("hex");
		expect(redact(`hex: ${hex}`)).toBe(`hex: ${REDACTED}`);
		const b64 = Buffer.from(raw).toString("base64");
		expect(redact(`b64: ${b64}`)).toBe(`b64: ${REDACTED}`);
	});

	test("Hangul and astral secrets mask whole and never leave lone surrogates", () => {
		const hangul = "비밀번호는매우길고복잡합니다만이것은테스트입니다";
		const astral = "k😀e😀y😀k😀e😀y😀k😀e😀y😀k😀e😀y😀";
		expect(indexSecretValue(hangul)).toBe(true);
		expect(indexSecretValue(astral)).toBe(true);
		expect(redact(`pw=${hangul}.`)).toBe(`pw=${REDACTED}.`);
		expect(redact(`pw=${astral}.`)).toBe(`pw=${REDACTED}.`);
		// A fragment that starts in the middle of an astral pair must not split the pair in the output.
		const fragment = `${astral.slice(1, 30)}`;
		const out = redact(`<<${fragment}>>`);
		expect(out.isWellFormed()).toBe(true);
	});

	test("multi-megabyte text is masked in bounded time and leaves no secret behind", () => {
		indexSecretValue(TOKEN);
		const filler = "lorem ipsum dolor sit amet, consectetur adipiscing elit 0123456789\n";
		const text = `${filler.repeat(40_000)}${TOKEN}\n${filler.repeat(10)}`;
		expect(text.length).toBeGreaterThan(2_500_000);
		const started = performance.now();
		const out = redact(text);
		const elapsed = performance.now() - started;
		expect(out.includes(TOKEN)).toBe(false);
		expect(out.includes(REDACTED)).toBe(true);
		expect(elapsed).toBeLessThan(15_000);
	});
});
