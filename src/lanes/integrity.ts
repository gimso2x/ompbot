import { defaultGit, type GitRunner } from "./verify";

/** One reason a lane's "done" claim is not accepted as evidence of finished work. */
export interface IntegrityRefusal {
	category:
		| "unfinished_work_marker"
		| "skipped_test"
		| "stub_implementation"
		| "guard_deletion_without_adversarial_regression"
		| "unproven_claim_word"
		| "lane_diff_unavailable";
	excerpt: string;
	remedy: string;
}

export interface IntegrityInput {
	/** The lane's own done report (the claim summary). */
	summary: string;
	/** Unified diff of the lane's commits (`--unified=0`), or "" when it could not be collected. */
	diff: string;
}

/** Files whose added lines are judged: code only. Markdown/docs are not code and stay exempt; code under docs/ or examples/ is judged. */
const CODE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|sh|bash|go|rs|rb|java|kt|sql|json|toml|yaml|yml|css|html)$/i;
const TEST_PATH =
	/(?:^|\/)(?:tests?|__tests__|specs?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.(?:go|py|rs)$/i;
const LINKED_REASON = /(?:#\d+|https?:\/\/)/;
const UNFINISHED = /\b(?:TODO|FIXME|XXX|HACK|WIP|TBD)\b/i;
const SKIPPED_TEST = /(?:\b(?:test|it|describe)\.(?:skip|only|todo|skipIf)(?:\(|\.)|\b(?:xit|xtest|xdescribe)\()/;
const STUB = /(?:not implemented|notimplemented|todo!\(|unimplemented!)/i;
const GUARD_WORD =
	/\b(?:throw|refuse|deny|reject|validate|sanitize|permission|allowlist|forbid|guard|assert)\b|권한|거부|검증|금지/i;
const NEGATIVE_TEST = /\b(?:refuses?|rejects?|denies?|blocks?|invalid|권한 없음|거부)/i;
const CLAIM_WORD =
	/(?:통과|검증 완료|수정 완료|고쳤|해결됐|해결됨|(?<![A-Za-z0-9_-])(?:verified|passing|passed|fixed|green)(?![A-Za-z0-9_-]))/i;
const COMMAND_TOKEN =
	/(?<![A-Za-z0-9_-])(?:bun\s+(?:run\s+)?(?:test|check|typecheck|x)|bunx|(?:npm|yarn|pnpm)\s+(?:run\s+)?test|tsc|biome|pytest|go\s+test|cargo\s+test|make\s+test|vitest|jest|git(?=\s))(?![A-Za-z0-9_-])/i;
const MAX_REFUSALS = 8;

interface DiffLine {
	file: string;
	text: string;
}

const OCTAL_ESCAPE_RUN = /(?:\\[0-3][0-7]{2})+/g;

/** Decodes git's C-style quoted path (`"b/src/\355\225\234.ts"`): octal byte runs are UTF-8, plus the usual escapes. */
function unquoteGitPath(raw: string): string {
	let path = raw.replace(/\t.*$/, "").replace(/\r$/, "");
	if (!(path.length >= 2 && path.startsWith('"') && path.endsWith('"'))) return path;
	path = path.slice(1, -1).replace(OCTAL_ESCAPE_RUN, (run) => {
		const bytes = run
			.slice(1)
			.split("\\")
			.map((octal) => Number.parseInt(octal, 8));
		return new TextDecoder().decode(Uint8Array.from(bytes));
	});
	const simple: Record<string, string> = { t: "\t", n: "\n", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v" };
	return path.replace(/\\(["\\tnrabfv])/g, (_, ch: string) => simple[ch] ?? ch);
}

/**
 * Splits a unified diff into added/removed code lines, dropping non-code files. A `--- ` line is a file header only in a
 * file's header block (before its first `@@`, reset by the next `diff ` line) and only when a `+++ ` line follows it:
 * inside a hunk, `--- x`/`+++ x` are a removed `-- x` and an added `++ x` line. For a deleted file the `+++` side is
 * /dev/null, so the `---` path names the file.
 */
function parseDiff(diff: string): { added: DiffLine[]; removed: DiffLine[] } {
	const added: DiffLine[] = [];
	const removed: DiffLine[] = [];
	const lines = diff.split("\n");
	// Removed lines belong to the old path, added ones to the new: a rename to a non-code name keeps its removals judged.
	let oldFile = "";
	let newFile = "";
	let inHunk = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		if (line.startsWith("diff ")) {
			inHunk = false;
			continue;
		}
		if (!inHunk && line.startsWith("--- ") && (lines[i + 1] as string | undefined)?.startsWith("+++ ")) {
			// `a/`/`b/` prefixes are dropped after unquoting git's C-style quoting.
			const oldPath = unquoteGitPath(line.slice(4)).replace(/^[ab]\//, "");
			const newPath = unquoteGitPath((lines[i + 1] as string).slice(4)).replace(/^[ab]\//, "");
			oldFile = oldPath === "/dev/null" ? newPath : oldPath;
			newFile = newPath === "/dev/null" ? oldPath : newPath;
			i += 1;
			continue;
		}
		if (line.startsWith("@@")) {
			inHunk = true;
			continue;
		}
		if (line.startsWith("+")) {
			if (CODE_EXT.test(newFile)) added.push({ file: newFile, text: line.slice(1) });
		} else if (line.startsWith("-")) {
			if (CODE_EXT.test(oldFile)) removed.push({ file: oldFile, text: line.slice(1) });
		}
	}
	return { added, removed };
}

const isBlank = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

/**
 * Text of the trailing comment on a code line, or undefined when the line has none. String literals are skipped, so a
 * "TODO" inside quotes is not a marker; `#`, `--`, `;;` need a whitespace/line-start before them and `%`/`*` only open a
 * comment at the start of the line (modulo and multiplication stay code).
 */
function commentText(text: string): string | undefined {
	const noCloser = new Set<string>();
	let leading = true;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i] as string;
		if (ch === '"' || ch === "'" || ch === "`") {
			if (!noCloser.has(ch)) {
				let end = -1;
				for (let j = i + 1; j < text.length; j++) {
					if (text[j] === "\\") j += 1;
					else if (text[j] === ch) {
						end = j;
						break;
					}
				}
				if (end >= 0) {
					i = end;
					leading = false;
					continue;
				}
				noCloser.add(ch);
			}
		}
		const next = text[i + 1];
		if ((ch === "/" && (next === "/" || next === "*")) || text.startsWith("<!--", i)) return text.slice(i);
		const spaced = isBlank(text[i - 1]);
		if (ch === "#" && spaced && next !== "[" && next !== "!") return text.slice(i);
		if (ch === "-" && next === "-" && spaced && isBlank(text[i + 2])) return text.slice(i);
		if (ch === ";" && next === ";" && spaced) return text.slice(i);
		if (leading && (ch === "%" || ch === "*")) return text.slice(i);
		if (!isBlank(ch)) leading = false;
	}
	return undefined;
}

function isUnfinishedMarker(text: string): boolean {
	if (!UNFINISHED.test(text)) return false;
	const comment = commentText(text);
	return comment !== undefined && UNFINISHED.test(comment);
}

function refusal(category: IntegrityRefusal["category"], file: string, text: string): IntegrityRefusal {
	const remedies: Record<IntegrityRefusal["category"], string> = {
		unfinished_work_marker: "남긴 TODO/FIXME를 실제로 끝내거나, 왜 남기는지 이슈 번호(#123)를 같은 줄에 적으세요.",
		skipped_test: "건너뛴/단독 실행 테스트를 원복하거나, 건너뛰는 이유를 이슈 번호로 같은 줄에 적으세요.",
		stub_implementation: "스텁 본문을 구현하거나, 이번 범위가 아니면 해당 코드를 되돌리세요.",
		guard_deletion_without_adversarial_regression:
			"삭제한 가드/부정 테스트를 복원하거나, 같은 동작을 증명하는 부정 케이스 테스트를 추가하세요.",
		unproven_claim_word: "보고의 '통과/검증됨' 주장에 실제 실행한 검증 명령(bun test 등)을 함께 적으세요.",
		lane_diff_unavailable:
			"base 브랜치를 읽지 못해 레인의 변경을 가려낼 수 없습니다. base 브랜치가 저장소에 있는지 확인하고 다시 완료를 알리세요.",
	};
	return { category, excerpt: `${file}: ${text.trim().slice(0, 120)}`, remedy: remedies[category] };
}

/**
 * Pure judge of a lane's completion claim (hermes completion_integrity, word lists rewritten for this repo):
 * refuses added TODO/FIXME markers, skipped tests, stub bodies, guard deletions without an adversarial test, and
 * verification words with no command behind them. It runs no commands and proves nothing itself — git already
 * proved the commit; this only rejects claims whose own text/diff contradicts "done".
 */
export function classifyLaneCompletion(input: IntegrityInput): IntegrityRefusal[] {
	const refusals: IntegrityRefusal[] = [];
	const { added, removed } = parseDiff(input.diff);

	for (const line of added) {
		if (LINKED_REASON.test(line.text)) continue;
		if (isUnfinishedMarker(line.text)) refusals.push(refusal("unfinished_work_marker", line.file, line.text));
		if (SKIPPED_TEST.test(line.text)) refusals.push(refusal("skipped_test", line.file, line.text));
		if (STUB.test(line.text)) refusals.push(refusal("stub_implementation", line.file, line.text));
	}

	const addedText = new Set(added.map((line) => line.text.trim()));
	const hasAdversarialTest = added.some((line) => TEST_PATH.test(line.file) && NEGATIVE_TEST.test(line.text));
	const deletedGuards = removed.filter((line) => GUARD_WORD.test(line.text) || NEGATIVE_TEST.test(line.text));
	const stillGone = deletedGuards.filter((line) => !addedText.has(line.text.trim()));
	if (stillGone.length > 0 && !hasAdversarialTest) {
		refusals.push(
			refusal("guard_deletion_without_adversarial_regression", stillGone[0]?.file ?? "", stillGone[0]?.text ?? ""),
		);
	}

	const summary = input.summary.trim();
	if (summary !== "" && CLAIM_WORD.test(summary) && !COMMAND_TOKEN.test(summary)) {
		refusals.push(refusal("unproven_claim_word", "summary", summary));
	}

	return refusals.slice(0, MAX_REFUSALS);
}

/** Where a lane's diff starts: the commit it started (or was reopened) at, and the branch it lands on. */
export interface LaneDiffRange {
	baseSha?: string;
	baseBranch?: string;
}

/** The base branch or its tip could not be read: the lane's own changes cannot be told apart, so the check fails closed. */
export class LaneDiffUnavailable extends Error {}

/** The refusal an unreadable base becomes (the owner can still approve the claim from its card). */
export function laneDiffUnavailableRefusal(error: LaneDiffUnavailable): IntegrityRefusal {
	return refusal("lane_diff_unavailable", "base", error.message);
}

/**
 * `git diff <from>..sha` of the lane's repository. With a base branch, `from` is the merge-base of that branch's
 * current tip and `sha` — a lane rebased onto a moved base does not answer for the base's commits — unless `baseSha`
 * (a reopened lane's previous claim) is newer and still in `sha`'s history. A base branch that cannot be read throws
 * `LaneDiffUnavailable`; without one, `from` is `baseSha`. "" when the repository, a merge-base with `sha` or the diff
 * cannot be read (the classifier then only sees the claim).
 */
export async function collectLaneDiff(
	laneCwd: string,
	range: LaneDiffRange,
	sha: string,
	git: GitRunner = defaultGit,
): Promise<string> {
	const top = await git(["-C", laneCwd, "rev-parse", "--show-toplevel"]);
	const root = top.stdout.trim();
	if (top.code !== 0 || root === "") return "";
	let from = range.baseSha;
	if (range.baseBranch !== undefined) {
		const { baseBranch } = range;
		const tip = await git(["-C", root, "rev-parse", "--verify", "--quiet", `refs/heads/${baseBranch}^{commit}`]);
		const tipSha = tip.stdout.trim();
		if (tip.code !== 0 || tipSha === "")
			throw new LaneDiffUnavailable(`base 브랜치 ${baseBranch}의 tip을 읽지 못했습니다`);
		const base = await git(["-C", root, "merge-base", tipSha, sha]);
		const mergeBase = base.stdout.trim();
		// No common history with the claim commit: the diff cannot be read, like any other unreadable diff.
		if (base.code !== 0 || mergeBase === "") return "";
		from = mergeBase;
		const { baseSha } = range;
		if (baseSha !== undefined && baseSha !== mergeBase) {
			const newer = await git(["-C", root, "merge-base", "--is-ancestor", mergeBase, baseSha]);
			const inHistory = await git(["-C", root, "merge-base", "--is-ancestor", baseSha, sha]);
			if (newer.code === 0 && inHistory.code === 0) from = baseSha;
		}
	}
	if (from === undefined) return "";
	const diff = await git([
		"-C",
		root,
		"-c",
		"core.quotepath=false",
		"diff",
		"--no-ext-diff",
		"--no-textconv",
		`${from}..${sha}`,
		"--no-color",
		"--unified=0",
	]);
	return diff.code === 0 ? diff.stdout : "";
}
