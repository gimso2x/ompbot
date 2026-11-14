import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ProcessRunner, runOmpPrint } from "../dispatch/omp";
import type { Logger } from "../log";
import { byteLength, redact, truncateUtf8 } from "../redact";
import type { LaneReview, LaneRow } from "./status";
import { defaultGit, type GitRunner } from "./verify";

/**
 * The independent review of a closed lane before its auto-merge (`taskAutoLand.review`): a fresh `omp -p` with
 * read-only tools reads the lane's spec, the diff of its claim commit against the base branch and the checks the core
 * re-ran — the lane's own report last, for comparison only — and ends with `VERDICT: CLEAR` or `VERDICT: BLOCK`. The
 * receipt is bound to the claim commit. Everything that goes wrong is an `inconclusive` receipt, never a throw.
 */

/** Diff characters put into the prompt; the rest is read from the diff file. */
export const REVIEW_DIFF_PROMPT_MAX = 60_000;
/** One argv string must stay under the kernel's 128 KiB per-argument limit (`-p <prompt>`). */
const REVIEW_PROMPT_BYTES_MAX = 120_000;
const NOTES_MAX = 1_500;
const CHECK_DETAIL_MAX = 200;
/** The review run's stdout kept for the verdict (the `VERDICT` line is the last one). */
const OUTPUT_MAX = 64_000;
export const REVIEW_TOOLS = "read,grep,glob";

/**
 * omp 18.18.7 discovery provider ids the reviewer's overlay disables, so nothing in the lane's worktree (or the user's
 * agent configs) becomes the reviewer's context, rules, MCP servers or plugins. `cursor` is also a model provider id:
 * `taskAutoLand.review.model` may not start with `cursor/` (config validation).
 */
export const REVIEW_DISABLED_DISCOVERY = [
	"native",
	"agents",
	"agents-md",
	"claude-md",
	"custom-context",
	"mcp-json",
	"ssh-json",
	"omp-plugins",
	"agent-plugins",
	"claude",
	"claude-plugins",
	"codex",
	"gemini",
	"opencode",
	"cursor",
	"windsurf",
	"vscode",
	"cline",
	"github",
] as const;

/**
 * The isolation part of an isolated `omp -p` `--config` overlay (the lane reviewer's and the guest/qa runner's), built
 * from constants only (no input, so nothing to escape). Its `disabledProviders` replaces the user's list on purpose.
 */
export const ISOLATION_OVERLAY_YAML = [
	"disabledProviders:",
	...REVIEW_DISABLED_DISCOVERY.map((id) => `  - ${id}`),
	"mcp:",
	"  enableProjectConfig: false",
	"autolearn:",
	"  enabled: false",
	"memory:",
	'  backend: "off"',
	"",
].join("\n");

/**
 * The reviewer's `--config` overlay: the isolation part, and no model fallback — the receipt's `model` (and the
 * confidence scale it stands for) is the model that answered. omp's `retry.modelFallback` gates every switch to
 * `retry.fallbackChains`, and a `--config` overlay merges over the user's config.yml.
 */
export const REVIEW_OVERLAY_YAML = `${ISOLATION_OVERLAY_YAML}retry:\n  modelFallback: false\n`;

/** Section headers of the review prompt, in the order the reviewer reads them. */
export const REVIEW_SECTIONS = {
	spec: "## 1. 스펙",
	diff: "## 2. diff",
	checks: "## 3. 코어가 다시 돌린 [check:] 결과",
	claim: "## 4. 구현자 보고 — 마지막 대조용, 판정 근거로 쓰지 말 것",
} as const;

const VERDICT_LINE = /^VERDICT:\s*(CLEAR|BLOCK)\s*$/;
const CONFIDENCE_PREFIX = /^CONFIDENCE:/;
const CONFIDENCE_LINE = /^CONFIDENCE:\s*(0(?:\.\d+)?|1(?:\.0+)?)\s*$/;

export interface LaneReviewDeps {
	ompBin: string;
	/** Config `ompProfile` of the reviewer's `omp -p` (the bot's own profile: login and models). */
	ompProfile?: string;
	/** The safety floors the daemon's `omp -p` children get (`--append-system-prompt`). */
	systemPromptAppendix: string;
	/** `<ompbot home>/reviews`: where the full diff of each review is written (0700 directory, 0600 files). */
	reviewsDir: string;
	/** HEAD of the lane's worktree (it must be the claim commit). */
	headOf(worktree: string): Promise<{ sha: string; clean: boolean }>;
	now(): number;
	run?: ProcessRunner;
	git?: GitRunner;
	inheritedEnv?: Record<string, string | undefined>;
	/** Where a failed removal of the review's overlay or cwd is logged. */
	log?: Pick<Logger, "warn">;
}

export interface LaneReviewInput {
	lane: LaneRow;
	model: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

/** The diff file of one review: `<reviewsDir>/<laneId>-<sha12>.diff`. */
export const reviewDiffPath = (reviewsDir: string, lane: LaneRow, sha: string): string =>
	join(reviewsDir, `${lane.meta.laneId ?? lane.name}-${sha.slice(0, 12)}.diff`);

/**
 * The isolation files of one review: the `--config` overlay `<reviewsDir>/<laneId>-<sha12>.omp.yml` and the empty
 * cwd `<reviewsDir>/<laneId>-<sha12>.cwd/` (the worktree is never the reviewer's cwd: its `.env` would apply).
 */
export const reviewIsolationPaths = (
	reviewsDir: string,
	lane: LaneRow,
	sha: string,
): { configPath: string; cwd: string } => {
	const stem = join(reviewsDir, `${lane.meta.laneId ?? lane.name}-${sha.slice(0, 12)}`);
	return { configPath: `${stem}.omp.yml`, cwd: `${stem}.cwd` };
};

/** The reviewer's prompt: spec → diff → re-run checks → the lane's own report (for comparison only). */
export function buildReviewPrompt(input: { lane: LaneRow; diff: string; diffPath: string }): string {
	const { lane, diff, diffPath } = input;
	const acceptance = (lane.meta.acceptance ?? []).map((item) => `- ${item.id}: ${item.text}`);
	const checks = (lane.meta.checks?.head === lane.meta.sha ? (lane.meta.checks?.results ?? []) : []).map(
		(check) =>
			`- ${check.id}: ${check.ok ? "통과" : check.inconclusive ? "확인 불가" : "실패"} — ${redact(check.detail).slice(0, CHECK_DETAIL_MAX)}`,
	);
	const claim = lane.meta.claim;
	const worktree = lane.meta.worktree ?? "?";
	const head = [
		"너는 이 변경을 처음 보는 독립 리뷰어다. 파일을 고치지 말고 읽기만 한다.",
		"스펙·수락기준을 먼저 읽고, 이 diff가 그것을 실제로 충족하는지 판정한다. 아래 순서로 본다:",
		`- 스펙·수락기준을 diff가 실제로 충족하는가(필요하면 ${worktree}의 파일을 read·grep·glob으로 확인).`,
		`지금 작업 디렉터리는 빈 폴더다. grep·glob을 부를 때는 path에 반드시 위 worktree 절대경로(${worktree})를 넘겨라.`,
		"- 테스트를 빼거나 약화하지 않았는가.",
		"- 범위 밖 변경, 비밀값([REDACTED] 표시 포함), 되돌리기 어려운 부작용이 있는가.",
		"구현자 보고(4절)는 마지막에 대조만 하고 판정 근거로 쓰지 않는다.",
		"BLOCK이면 그 앞에 지적을 파일:줄과 함께 3개 이내로 쓴다.",
		"마지막 줄 바로 위에는 `CONFIDENCE: <0.00~1.00>` 한 줄을 쓴다. 이 판정이 맞을 확률이다. 스펙·수락기준을 diff에서 하나하나 확인했고 의심할 데가 없으면 0.9 이상, 일부를 확인하지 못했거나 diff가 잘려 다 못 읽었으면 0.7 이하로 쓴다. 다른 줄에는 CONFIDENCE를 쓰지 않는다.",
		"마지막 줄에는 정확히 `VERDICT: CLEAR` 또는 `VERDICT: BLOCK` 하나만 쓴다. 다른 줄에는 VERDICT를 쓰지 않는다.",
		"",
		REVIEW_SECTIONS.spec,
		`제목: ${lane.title}`,
		"",
		lane.meta.brief === undefined ? "(브리프 없음)" : lane.meta.brief,
		"",
		"수락기준:",
		...(acceptance.length === 0 ? ["(없음)"] : acceptance),
		"",
		REVIEW_SECTIONS.diff,
		`기준: git merge-base ${lane.meta.baseBranch ?? "?"} ${lane.meta.sha ?? "?"} .. ${lane.meta.sha ?? "?"}`,
	].join("\n");
	const tail = [
		"",
		REVIEW_SECTIONS.checks,
		...(checks.length === 0 ? ["(재실행 검사 없음)"] : checks),
		"",
		REVIEW_SECTIONS.claim,
		claim === undefined ? "(보고 없음)" : redact(`${claim.commit}: ${claim.summary}`),
	].join("\n");
	const longer = `\n\n(diff가 길어 여기서 잘랐다. 나머지는 이 파일을 read로 읽어라: ${diffPath})`;
	let shown = diff.slice(0, REVIEW_DIFF_PROMPT_MAX);
	// Multi-byte text can push 60000 characters past the argv limit: cut the diff further, never the other sections.
	const room = REVIEW_PROMPT_BYTES_MAX - byteLength(`${head}\n\`\`\`diff\n\n\`\`\`${longer}${tail}`);
	shown = truncateUtf8(shown, room);
	const note = shown.length < diff.length ? longer : "";
	return `${head}\n\`\`\`diff\n${shown}\n\`\`\`${note}${tail}`;
}

/**
 * The verdict of a review run's output: its last non-empty line, and that line only. The confidence is set only when
 * exactly one line starts with `CONFIDENCE:`, it is the non-empty line right above the VERDICT line and it is a number
 * from 0 to 1; anything else leaves it unset without touching the verdict. Every `CONFIDENCE:` line is dropped from
 * the notes, well-formed or not.
 */
export function parseReviewVerdict(
	output: string,
): { verdict: "CLEAR" | "BLOCK"; notes: string; confidence?: number } | { reason: string } {
	const lines = output.split("\n").map((line) => line.trim());
	if (lines.filter((line) => /^VERDICT:/.test(line)).length > 1) return { reason: "VERDICT 여러 줄" };
	const last = lines.findLastIndex((line) => line !== "");
	const match = last < 0 ? null : VERDICT_LINE.exec(lines[last] ?? "");
	if (match === null) return { reason: "VERDICT 없음" };
	const confidenceLines = lines.filter((line) => CONFIDENCE_PREFIX.test(line));
	const above = lines.slice(0, last).findLast((line) => line !== "");
	const value = confidenceLines.length === 1 && above !== undefined ? CONFIDENCE_LINE.exec(above) : null;
	return {
		verdict: match[1] as "CLEAR" | "BLOCK",
		notes: output
			.split("\n")
			.slice(0, last)
			.filter((line) => !CONFIDENCE_PREFIX.test(line.trim()))
			.join("\n")
			.trim(),
		...(value === null ? {} : { confidence: Number(value[1]) }),
	};
}

/** A review confidence as cards and events show it: two decimals (`0.80`). */
export const formatConfidence = (confidence: number): string => confidence.toFixed(2);

/** Reviews the lane's claim commit once; resolves with its receipt and never throws. */
export async function reviewLane(input: LaneReviewInput, deps: LaneReviewDeps): Promise<LaneReview> {
	const { lane, model } = input;
	const sha = lane.meta.sha ?? "";
	const receipt = (verdict: LaneReview["verdict"], text: string, reason?: string): LaneReview => {
		// The findings sit right above the VERDICT line: a long output keeps its end.
		const notes = redact(text.trim());
		return {
			sha,
			verdict,
			model,
			at: deps.now(),
			notes: notes.length > NOTES_MAX ? `…${notes.slice(-(NOTES_MAX - 1))}` : notes,
			...(reason === undefined ? {} : { reason }),
		};
	};
	const inconclusive = (reason: string, notes = ""): LaneReview => receipt("inconclusive", notes, reason);
	const { repo, worktree, baseBranch } = lane.meta;
	if (sha === "" || repo === undefined || worktree === undefined || baseBranch === undefined) {
		return inconclusive("레인에 worktree나 클레임 커밋이 없음");
	}
	try {
		const head = await deps.headOf(worktree);
		if (head.sha !== sha) return inconclusive(`worktree HEAD ${head.sha.slice(0, 12)}가 클레임 커밋이 아님`);
		const git = deps.git ?? defaultGit;
		// Not `meta.baseSha`: `!reopen` moves it to the previous claim, and the review must see the lane's whole work.
		const base = await git(["-C", repo, "merge-base", `refs/heads/${baseBranch}`, sha]);
		const baseSha = base.stdout.trim();
		if (base.code !== 0 || baseSha === "") return inconclusive("diff 기준점 없음");
		const range = `${baseSha}..${sha}`;
		const diffArgs = ["-C", repo, "-c", "core.quotepath=false", "diff", "--no-ext-diff", "--no-textconv", "--no-color"];
		const stat = await git([...diffArgs, "--stat", range]);
		const full = await git([...diffArgs, "--unified=3", range]);
		if (stat.code !== 0 || full.code !== 0) return inconclusive("diff 수집 실패");
		const diff = redact(`${stat.stdout.trimEnd()}\n\n${full.stdout}`);
		const diffPath = reviewDiffPath(deps.reviewsDir, lane, sha);
		mkdirSync(deps.reviewsDir, { recursive: true, mode: 0o700 });
		chmodSync(deps.reviewsDir, 0o700);
		writeFileSync(diffPath, diff, { mode: 0o600 });
		chmodSync(diffPath, 0o600);
		const isolation = reviewIsolationPaths(deps.reviewsDir, lane, sha);
		let result: Awaited<ReturnType<typeof runOmpPrint>>;
		try {
			result = await runIsolated(isolation, { lane, diff, diffPath, input, deps });
		} finally {
			dropIsolation(isolation, deps.log);
		}
		if (input.signal?.aborted === true) return inconclusive("중단됨");
		if (result.timedOut) return inconclusive("시간 초과", result.output);
		if (result.code !== 0) return inconclusive(`종료 코드 ${result.code ?? "없음"}`, result.output);
		const parsed = parseReviewVerdict(result.output);
		if ("reason" in parsed) return inconclusive(parsed.reason, result.output);
		const reviewed = receipt(parsed.verdict, parsed.notes);
		return parsed.confidence === undefined ? reviewed : { ...reviewed, confidence: parsed.confidence };
	} catch (error) {
		return inconclusive(`리뷰 실행 실패: ${String(error).slice(0, 200)}`);
	}
}

/** Writes the overlay (0600) and a fresh empty cwd (0700), then runs the reviewer isolated in them. */
async function runIsolated(
	isolation: { configPath: string; cwd: string },
	ctx: { lane: LaneRow; diff: string; diffPath: string; input: LaneReviewInput; deps: LaneReviewDeps },
): Promise<Awaited<ReturnType<typeof runOmpPrint>>> {
	const { lane, diff, diffPath, input, deps } = ctx;
	writeFileSync(isolation.configPath, REVIEW_OVERLAY_YAML, { mode: 0o600 });
	chmodSync(isolation.configPath, 0o600);
	// A leftover of an earlier run (killed daemon) must not be the reviewer's cwd content.
	rmSync(isolation.cwd, { force: true, recursive: true });
	mkdirSync(isolation.cwd, { mode: 0o700 });
	chmodSync(isolation.cwd, 0o700);
	return runOmpPrint({
		task: buildReviewPrompt({ lane, diff, diffPath }),
		cwd: isolation.cwd,
		isolation: { configPath: isolation.configPath },
		systemPromptAppendix: deps.systemPromptAppendix,
		ompBin: deps.ompBin,
		timeoutMs: input.timeoutMs,
		maxChars: OUTPUT_MAX,
		model: input.model,
		tools: REVIEW_TOOLS,
		...(input.signal === undefined ? {} : { signal: input.signal }),
		...(deps.run === undefined ? {} : { run: deps.run }),
		...(deps.inheritedEnv === undefined ? {} : { inheritedEnv: deps.inheritedEnv }),
		...(deps.ompProfile === undefined ? {} : { ompProfile: deps.ompProfile }),
	});
}

/** Removes a review's overlay and cwd whatever the run's end; a failure is logged, never thrown. */
function dropIsolation(isolation: { configPath: string; cwd: string }, log: LaneReviewDeps["log"]): void {
	for (const path of [isolation.configPath, isolation.cwd]) {
		try {
			rmSync(path, { force: true, recursive: true });
		} catch (error) {
			log?.warn("lane_review_file_remove_failed", { file: path, error: String(error) });
		}
	}
}
