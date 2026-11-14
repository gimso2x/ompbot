/**
 * Handoff risk scan: before a brief goes to an unattended herdr worker, look for irreversible commands in it.
 * Pure — reads no files, git or network. A command in a clause that forbids it ("…은 하지 않는다", "never …") is a
 * normal worker instruction and only counts as advisory; a marker in another clause or parenthesis does not count.
 */

export type HandoffVerdict = "clear" | "advisory" | "high_risk";
export interface HandoffFinding {
	rule: string;
	line: number;
	excerpt: string;
	severity: "advisory" | "high_risk";
}
export interface HandoffScan {
	verdict: HandoffVerdict;
	findings: HandoffFinding[];
	truncated: boolean;
}

export const HANDOFF_SCAN_BYTES = 65536;
const EXCERPT_CHARS = 160;
/** Characters an excerpt keeps before a command that lies past its head. */
const EXCERPT_LEAD = 80;
const DEFAULT_PROTECTED_BRANCHES = ["main", "master"] as const;

/** The rest of a shell command after its verb: up to the next `;`, `&`, `|`, or the end of an inline code span. */
const SEGMENT = "[^;&|`\\n]*";

/**
 * One argument of a git global option: a quoted string holding a blank, or a word without whitespace or a command
 * separator (a quoted string without a blank is such a word too, so no argument has two readings).
 */
const GIT_OPTION_ARG = "(?:\"[^\"`\\s]*\\s[^\"`\\n]*\"|'[^'`\\s]*\\s[^'`\\n]*'|[^\\s;&|`]+)";
/** git global options that may take their value as the next word (`-C <dir>`, `--git-dir <dir>`), past their `-`. */
const GIT_ARG_OPTION_NAME = "(?:[Cc]|-(?:git-dir|work-tree|namespace|super-prefix|config-env|attr-source))";
/**
 * `git` and the global options before its subcommand (`git -C <dir> reset …`): one that takes the next word, or any
 * other word starting with `-` (`--literal-pathspecs`, `--exec-path=/x`), so an option missing from a list does not
 * hide the subcommand. The bare word never matches an option taking an argument, so every option run has one reading.
 */
const GIT_GLOBAL_OPTION_RUN = new RegExp(
	`\\bgit((?:\\s+(?:-${GIT_ARG_OPTION_NAME}\\s+${GIT_OPTION_ARG}|-(?!${GIT_ARG_OPTION_NAME}(?=\\s|$))[^\\s;&|\`]+))*)`,
	"gi",
);

/**
 * `text` with the global options after every `git` blanked out (newlines kept), so `git -C <dir> reset --hard` reads
 * as `git reset --hard` at the same indices. One left-to-right pass: the git rules need no option group of their
 * own, which re-walked a long option run from every `git` in it.
 */
export function blankGitGlobalOptions(text: string): string {
	return text.replace(
		GIT_GLOBAL_OPTION_RUN,
		(match: string, options: string) => `${match.slice(0, 3)}${options.replace(/[^\n]/g, " ")}`,
	);
}

/** `git branch` delete and force flags, case-sensitive: `-d` alone is the safe delete. */
const BRANCH_DELETE = "(?:--delete|-[a-zA-Z]*d[a-zA-Z]*)(?![\\w-])";
const BRANCH_FORCE = "(?:--force|-[a-zA-Z]*f[a-zA-Z]*)(?![\\w-])";

// Long options are matched with the unique prefixes git accepts too (`--har`, `--forc`, `--del`).
const HIGH_RISK_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
	["git_reset_hard", new RegExp(`\\bgit\\s+reset\\b${SEGMENT}\\s--ha(?:rd?)?(?![\\w-])`, "i")],
	[
		"git_clean_force",
		new RegExp(`\\bgit\\s+clean\\b${SEGMENT}\\s(?:-[a-z]*f[a-z]*|--f(?:o(?:r(?:ce?)?)?)?)(?![\\w-])`, "i"),
	],
	[
		"git_push_force",
		new RegExp(`\\bgit\\s+push\\b${SEGMENT}\\s(?:--for(?:c(?:e(?:-[\\w-]*)?)?)?|-[a-z]*f[a-z]*)(?![\\w-])`, "i"),
	],
	// `-D`, or delete and force together in one word (`-df`) or two (`-d -f`, `--delete --force`); only the verb
	// ignores case.
	[
		"git_branch_force_delete",
		new RegExp(
			`\\b[gG][iI][tT]\\s+[bB][rR][aA][nN][cC][hH]\\b${SEGMENT}\\s(?:-[a-zA-Z]*D|-[a-zA-Z]*(?:d[a-zA-Z]*f|f[a-zA-Z]*d)[a-zA-Z]*(?![\\w-])|${BRANCH_DELETE}${SEGMENT}\\s${BRANCH_FORCE}|${BRANCH_FORCE}${SEGMENT}\\s${BRANCH_DELETE})`,
		),
	],
	["git_stash_discard", /\bgit\s+stash\s+(?:drop|clear)\b/i],
	// A forced checkout or switch, or a checkout / restore of the whole tree (`.`, `./`, `:/`); a restore that names
	// only `--staged` leaves the work tree alone unless `--worktree` / `-W` comes with it.
	[
		"git_discard_worktree",
		new RegExp(
			`\\bgit\\s+(?:(?:checkout|switch)\\b${SEGMENT}\\s(?:-[a-z]*f[a-z]*|--force|--discard-changes)(?![\\w-])|(?:checkout\\b|restore\\b(?:(?=${SEGMENT}\\s(?:--worktree|-[a-z]*w[a-z]*)(?![\\w-]))|(?![^;&|\`\\n]*--staged)))${SEGMENT}\\s(?:\\.\\/?|:\\/\\.?)(?=\\s|$|[;&|\`]))`,
			"i",
		),
	],
	["git_push_delete", new RegExp(`\\bgit\\s+push\\b${SEGMENT}\\s(?:--de(?:l(?:e(?:te?)?)?)?|-d)(?![\\w-])`, "i")],
	["gh_destructive", /\bgh\s+repo\s+delete\b/i],
	["crontab_remove", new RegExp(`\\bcrontab\\b${SEGMENT}\\s-[a-z]*r[a-z]*(?![\\w-])`, "i")],
	["sql_destructive", /\b(?:drop\s+(?:table|database)|truncate\s+table|delete\s+from\s+\w+\s*(?:;|$|['"`]))/i],
	[
		"service_control",
		/\bsystemctl(?:\s+-{1,2}[\w=-]+)*\s+(?:restart|stop|start|disable|kill)\b|\b(?:docker|podman)\s+(?:(?:container|compose)\s+)?(?:rm|stop|kill|restart)\b|\bpm2\s+(?:restart|stop|delete)\b/i,
	],
	["disk_destructive", new RegExp(`\\bmkfs\\b|\\bdd\\s${SEGMENT}\\bof=/dev/`, "i")],
	// `/./` and `//` between the two names are the same directory (`~/.ompbot/./secrets`, `$HOME//.ompbot//secrets`).
	["secret_path", /\.ompbot\/(?:\.?\/)*secrets/i],
];

const ADVISORY_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
	[
		"package_install",
		/\b(?:npm\s+(?:install|i)\b|bun\s+(?:add|install)\b|pip3?\s+install\b|apt(?:-get)?\s+install\b)/i,
	],
	["owner_gate_skip", /OMP_OWNER_APPROVED/i],
];

/** Forbidding markers: a high_risk hit whose clause carries one of these is downgraded to advisory. */
const FORBIDDING =
	/하지\s*마|하지\s*않|지\s*말고|지\s*않고|않는다|금지|말\s*것|말고|\bnever\b|\bdo\s+not\b|\bdon['’]t\b|\bmust\s+not\b|\bforbidden\b|^\s*[-*]\s+no\s/i;
/** Phrases that contain a forbidding marker but order the command: "don't hesitate to", a double negative "…않으면 안". */
const NOT_FORBIDDING = /\b(?:do\s+not|don['’]t)\s+hesitate\b|(?:하지\s*)?않으면\s*안/gi;

const HIGH_RISK_RULES = new Set([...HIGH_RISK_PATTERNS.map(([rule]) => rule), "git_push_protected", "rm_rf_absolute"]);

/** The high_risk patterns with the `g` flag, for the position of every match on a line. */
const HIGH_RISK_GLOBAL = HIGH_RISK_PATTERNS.map(
	([rule, pattern]) => [rule, new RegExp(pattern.source, `${pattern.flags}g`)] as const,
);

const KOREAN_CONNECTORS = "하고|하되|하며|한\\s+뒤|한\\s+다음|한\\s*후|해서|하여|그리고|다음에|후에|뒤에";
/**
 * Where one clause of a line ends and the next begins: `; , ， 、`, `. 。 ! ?` before whitespace, an English connector
 * or a lone `후` between spaces, a Korean connector with whitespace on one side. A forbidding `말고` (`<용언>지 말고`,
 * `<명사> 말고`) or `지 않고` ends its clause with a zero-width boundary after it, so the forbidding marker stays with the command before it and
 * the command after it is a clause of its own. Parentheses are handled apart (`commandContext`).
 */
const CLAUSE_BOUNDARY = new RegExp(
	[
		"(?<=말고|지\\s*않고)(?=\\s)",
		"[;,，、]",
		"[.。!?](?=\\s)",
		"(?<=\\s)(?:and|then|but|after|before|후)(?=\\s)",
		`(?<=\\s)(?:${KOREAN_CONNECTORS})`,
		`(?:${KOREAN_CONNECTORS})(?=\\s)`,
	].join("|"),
	"gi",
);

/**
 * {@link CLAUSE_BOUNDARY} for searches started at a set `lastIndex`, kept apart because `matchAll` starts from the
 * `lastIndex` of the regex it is given.
 */
const CLAUSE_BOUNDARY_FROM = new RegExp(CLAUSE_BOUNDARY.source, CLAUSE_BOUNDARY.flags);

/** Stands in for text outside a command's context: neither whitespace nor a word character, so no marker spans it. */
const MASK = "\u0000";

interface Hit {
	rule: string;
	start: number;
	end: number;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `git push … <protected branch>`: the branch as a whole ref word (`main`, `HEAD:main`, `+main`, `refs/heads/main`).
 * A hit runs from the verb to the end of the first protected ref.
 */
function pushesProtected(line: string, branches: readonly string[]): Hit[] {
	if (branches.length === 0) return [];
	const names = branches.map(escapeRegExp).join("|");
	const ref = new RegExp(`(?<![\\w./-])(?:refs/heads/)?(?:${names})(?![\\w./-])`, "i");
	const hits: Hit[] = [];
	for (const match of line.matchAll(new RegExp(`\\bgit\\s+push\\b(${SEGMENT})`, "gi"))) {
		const segment = match[1] ?? "";
		const found = ref.exec(segment);
		if (found === null) continue;
		const segmentAt = match.index + match[0].length - segment.length;
		hits.push({ rule: "git_push_protected", start: match.index, end: segmentAt + found.index + found[0].length });
	}
	return hits;
}

/**
 * `rm` with recursive and force flags whose target starts at `/`, `~`, `$HOME` or a `${HOME…}` expansion
 * (`${HOME:-/}`); a hit ends at its last such word.
 */
function removesAbsoluteTree(line: string): Hit[] {
	const hits: Hit[] = [];
	for (const match of line.matchAll(new RegExp(`\\brm\\s(${SEGMENT})`, "gi"))) {
		const segment = match[1] ?? "";
		const segmentAt = match.index + match[0].length - segment.length;
		let recursive = false;
		let force = false;
		let absolute = false;
		let end = match.index;
		for (const found of segment.matchAll(/\S+/g)) {
			const word = found[0];
			if (/^--recursive$/i.test(word)) recursive = true;
			else if (/^--force$/i.test(word)) force = true;
			else if (/^-[a-z]+$/i.test(word)) {
				if (/[rR]/.test(word)) recursive = true;
				if (/f/i.test(word)) force = true;
			} else if (/^["']?(?:\/|~|\$HOME\b|\$\{HOME(?!\w)[^}]*\})/.test(word)) absolute = true;
			else continue;
			// A clause mark glued to the target (`~/work,`) is a boundary, not part of the command.
			end = segmentAt + found.index + word.replace(/[;,，、.。!?]+$/, "").length;
		}
		if (recursive && force && absolute) hits.push({ rule: "rm_rf_absolute", start: match.index, end });
	}
	return hits;
}

interface ParenGroup {
	open: number;
	close: number;
	/** The innermost group around this one. */
	parent?: ParenGroup;
	/** The groups directly inside this one, by `open`. */
	children: ParenGroup[];
}

/** Balanced `( )` / `（ ）` pairs of a line, by `open`, with their nesting; an unmatched one is ordinary text. */
function parenGroups(line: string): { groups: ParenGroup[]; top: ParenGroup[] } {
	const groups: ParenGroup[] = [];
	const stack: number[] = [];
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === "(" || char === "（") stack.push(i);
		else if (char === ")" || char === "）") {
			const open = stack.pop();
			if (open !== undefined) groups.push({ open, close: i, children: [] });
		}
	}
	groups.sort((a, b) => a.open - b.open);
	const top: ParenGroup[] = [];
	const around: ParenGroup[] = [];
	for (const group of groups) {
		while (around.length > 0 && (around.at(-1) as ParenGroup).close < group.open) around.pop();
		const parent = around.at(-1);
		if (parent === undefined) top.push(group);
		else {
			group.parent = parent;
			parent.children.push(group);
		}
		around.push(group);
	}
	return { groups, top };
}

/** A visible run of a level string: where it starts in the level string and the line indices it copies. */
interface Run {
	at: number;
	from: number;
	to: number;
}

/**
 * One nesting level as matched for clause boundaries: its text with each hidden run standing as one {@link MASK} — no
 * boundary or marker matches a mask, so one stands for any number — the visible runs, and the boundaries found.
 */
interface Level {
	text: string;
	runs: Run[];
	/** Clause boundaries of `text` in order (they never overlap), as `[start, end)`. */
	boundaries: Array<[number, number]>;
	/** Per hidden range, the index in `text` of the mask standing for it (overlapping ranges share one). */
	maskAt: number[];
}

/** `[lo, hi)` of a line with the `hidden` line ranges (sorted by start, overlaps merged into one mask) masked. */
function maskedLevel(line: string, lo: number, hi: number, hidden: ReadonlyArray<readonly [number, number]>): Level {
	const runs: Run[] = [];
	const maskAt: number[] = [];
	let text = "";
	let pos = lo;
	for (const [from, to] of hidden) {
		if (from > pos) {
			runs.push({ at: text.length, from: pos, to: from });
			text += line.slice(pos, from);
		}
		if (from >= pos) text += MASK;
		maskAt.push(text.length - 1);
		pos = Math.max(pos, to);
	}
	if (pos < hi) {
		runs.push({ at: text.length, from: pos, to: hi });
		text += line.slice(pos, hi);
	}
	const boundaries = Array.from(text.matchAll(CLAUSE_BOUNDARY), (b): [number, number] => [
		b.index,
		b.index + b[0].length,
	]);
	return { text, runs, boundaries, maskAt };
}

/** The line ranges of `runs` that fall inside the level-string positions `[from, to)`. */
function runRanges(runs: readonly Run[], from: number, to: number): Array<[number, number]> {
	return runs.flatMap((run): Array<[number, number]> => {
		const start = Math.max(from, run.at);
		const end = Math.min(to, run.at + (run.to - run.from));
		return start < end ? [[run.from + start - run.at, run.from + end - run.at]] : [];
	});
}

/** The number of leading entries of a sorted list for which `before` holds. */
function countBefore<T>(items: readonly T[], before: (item: T) => boolean): number {
	let lo = 0;
	let hi = items.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (before(items[mid] as T)) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** The end of the last boundary ending at or before `at` (0 when none); boundaries never overlap, so ends are sorted. */
function clauseStart(boundaries: ReadonlyArray<readonly [number, number]>, at: number): number {
	const count = countBefore(boundaries, ([, end]) => end <= at);
	return count === 0 ? 0 : (boundaries[count - 1] as readonly [number, number])[1];
}

/** The level string of `[lo, hi)` with only its child groups masked, built and matched once per level and line. */
function sharedLevel(
	line: string,
	levels: Map<number, Level>,
	lo: number,
	hi: number,
	children: readonly ParenGroup[],
): Level {
	let level = levels.get(lo);
	if (level === undefined) {
		level = maskedLevel(
			line,
			lo,
			hi,
			children.map((group) => [group.open, group.close + 1] as const),
		);
		levels.set(lo, level);
	}
	return level;
}

/**
 * The visible `[from, to)` ranges (line indices) of one nesting level `[lo, hi)`: the clause holding `span`, without
 * `span` and without the groups directly inside the level, as if matched on the level string with `span` masked too.
 * The level string with only its child groups masked is built and matched once per level (`levels`) and shared by
 * every span in it, which keeps a line with many hits linear: a span that is a child group is already one mask
 * there; a span inside one visible run takes its clause start from the shared boundaries (no boundary reaches
 * across a span's first character, which is never a blank) and its clause end from one search starting right after
 * it, skipping a zero-width `말고`/`않고` boundary that would only look back into the span. A span overlapping a child
 * group is matched on its own masked string.
 */
function levelRanges(
	line: string,
	levels: Map<number, Level>,
	lo: number,
	hi: number,
	children: readonly ParenGroup[],
	span: { start: number; end: number },
): Array<[number, number]> {
	const level = sharedLevel(line, levels, lo, hi, children);
	const childIndex = countBefore(children, (group) => group.open < span.start);
	const child = children[childIndex];
	if (child !== undefined && child.open === span.start && child.close + 1 === span.end) {
		// Already one mask in the shared string: its boundaries are the ones this span sees.
		const spanAt = level.maskAt[childIndex] as number;
		const next = level.boundaries[countBefore(level.boundaries, ([start]) => start <= spanAt)];
		return runRanges(level.runs, clauseStart(level.boundaries, spanAt), next?.[0] ?? level.text.length);
	}
	const run = level.runs[countBefore(level.runs, (r) => r.to < span.end)];
	if (run !== undefined && run.from <= span.start) {
		const spanLo = run.at + (span.start - run.from);
		const spanHi = run.at + (span.end - run.from);
		// The first shared boundary ending past the span (a zero-width one right at its end ends there and is passed
		// over): starting at or after the span's end, it is the one a search from there finds; one running across that
		// end hides where such a search starts, so then the search is run.
		const next = level.boundaries[countBefore(level.boundaries, ([, end]) => end <= spanHi)];
		let to = next === undefined ? level.text.length : next[0];
		if (next !== undefined && next[0] < spanHi) {
			to = level.text.length;
			CLAUSE_BOUNDARY_FROM.lastIndex = spanHi;
			for (let boundary = CLAUSE_BOUNDARY_FROM.exec(level.text); boundary !== null; ) {
				if (boundary.index > spanHi || boundary[0].length > 0) {
					to = boundary.index;
					break;
				}
				CLAUSE_BOUNDARY_FROM.lastIndex = spanHi + 1;
				boundary = CLAUSE_BOUNDARY_FROM.exec(level.text);
			}
		}
		return [
			...runRanges(level.runs, clauseStart(level.boundaries, spanLo), spanLo),
			...runRanges(level.runs, spanHi, to),
		];
	}
	const hidden = [...children.map((group) => [group.open, group.close + 1] as const), [span.start, span.end] as const]
		.filter(([from, to]) => to > lo && from < hi)
		.sort((a, b) => a[0] - b[0]);
	const own = maskedLevel(line, lo, hi, hidden);
	const spanAt = own.maskAt[hidden.findIndex(([from, to]) => from === span.start && to === span.end)] ?? -1;
	let from = 0;
	let to = own.text.length;
	for (const [start, end] of own.boundaries) {
		if (end <= spanAt) from = end;
		else if (start > spanAt && start < to) to = start;
	}
	return runRanges(own.runs, from, to);
}

/**
 * The text a forbidding marker must sit in to downgrade the command at `[start, end)`, as the line with everything
 * else masked: the command's clause, without the command itself and without the parentheses inside that clause. A
 * command inside a parenthesis adds the clause around that parenthesis, outward to the line level. Clause boundaries
 * are looked for with the command and the inner parentheses masked, so neither is ever cut. A masked run is one
 * {@link MASK}, however long.
 */
function commandContext(
	line: string,
	parens: { groups: readonly ParenGroup[]; top: readonly ParenGroup[] },
	levels: Map<number, Level>,
	start: number,
	end: number,
): string {
	let enclosing: ParenGroup | undefined;
	for (const group of parens.groups) {
		if (group.open < start && group.close >= end && (enclosing === undefined || group.open > enclosing.open))
			enclosing = group;
	}
	const ranges: Array<[number, number]> = [];
	let span = { start, end };
	for (;;) {
		const lo = enclosing === undefined ? 0 : enclosing.open + 1;
		const hi = enclosing === undefined ? line.length : enclosing.close;
		ranges.push(...levelRanges(line, levels, lo, hi, enclosing === undefined ? parens.top : enclosing.children, span));
		if (enclosing === undefined) break;
		span = { start: enclosing.open, end: enclosing.close + 1 };
		enclosing = enclosing.parent;
	}
	ranges.sort((a, b) => a[0] - b[0]);
	let context = "";
	let pos = 0;
	for (const [from, to] of ranges) {
		if (from > pos) context += MASK;
		context += line.slice(from, to);
		pos = to;
	}
	return pos < line.length ? `${context}${MASK}` : context;
}

/** The first `HANDOFF_SCAN_BYTES` bytes of `text` (UTF-8), cut back to a whole character. */
function headBytes(text: string): { head: string; truncated: boolean } {
	const bytes = new TextEncoder().encode(text);
	if (bytes.length <= HANDOFF_SCAN_BYTES) return { head: text, truncated: false };
	let end = HANDOFF_SCAN_BYTES;
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	return { head: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}

/**
 * Whether `hit` is the quoted pattern of a line defining its rule (- `git_reset_hard`: `git reset --hard`): such a
 * line documents this scanner, not an order. Only a hit inside the inline code spans listed right after the
 * `` `rule`: `` prefix counts; the same command in the plain text, or in a code span after it, is an order like on any
 * other line.
 */
function definesRule(line: string, hit: Hit): boolean {
	const prefix = new RegExp(`^\\s*[-*]?\\s*\`${escapeRegExp(hit.rule)}\`\\s*:`).exec(line);
	if (prefix === null) return false;
	// The definition is the list of code spans right after the prefix (`DROP TABLE`, `DROP DATABASE`); a span after
	// prose (`… 이제 \`git reset --hard HEAD~9\` 를 실행`) is an order.
	const list = /^(?:[\s,，、/·|]*`[^`\n]*`)+/.exec(line.slice(prefix[0].length));
	if (list === null) return false;
	for (const span of list[0].matchAll(/`[^`\n]*`/g)) {
		const open = prefix[0].length + span.index;
		if (hit.start > open && hit.end < open + span[0].length) return true;
	}
	return false;
}

/**
 * The line as the shell reads its words: a quoted word without blanks loses its quotes (`'--hard'` → `--hard`) and a
 * backslash before a word character or `-` goes (`\\--hard`, `--h\\ard`). A quote right after a letter stays, so
 * `don't` keeps its forbidding marker.
 */
function shellSpelling(text: string): string {
	return text.replace(/(?<!\w)(['"])([^'"\s`]*)\1/g, "$2").replace(/\\(?=[\w-])/g, "");
}

/**
 * The findings of one line of a brief (`line` is its 1-based number for the report), as written and as the shell
 * reads its words (`shellSpelling`); a rule keeps the more severe of the two, with the excerpt as written.
 */
function scanLine(text: string, line: number, branches: readonly string[]): HandoffFinding[] {
	const findings = scanSpelling(text, line, branches, text);
	const plain = shellSpelling(text);
	if (plain === text) return findings;
	for (const finding of scanSpelling(plain, line, branches, text)) {
		const index = findings.findIndex((found) => found.rule === finding.rule);
		const found = findings[index];
		if (found === undefined) findings.push(finding);
		else if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[found.severity])
			findings[index] = { ...found, severity: finding.severity };
	}
	return findings;
}

/**
 * At most {@link EXCERPT_CHARS} characters of `text` with whitespace collapsed: its head, or — when the command at
 * index `at` would fall past the head — a window from {@link EXCERPT_LEAD} characters before it, marked with a
 * leading `…`, so an approval card shows the command it asks about.
 */
function excerptOf(text: string, at = 0): string {
	const chars = Array.from(text.replace(/\s+/g, " ").trim());
	const offset = Array.from(text.slice(0, at).replace(/\s+/g, " ").trimStart()).length;
	if (chars.length <= EXCERPT_CHARS || offset + EXCERPT_LEAD <= EXCERPT_CHARS)
		return chars.slice(0, EXCERPT_CHARS).join("");
	const start = Math.min(offset - EXCERPT_LEAD, chars.length - (EXCERPT_CHARS - 1));
	return `…${chars.slice(start, start + EXCERPT_CHARS - 1).join("")}`;
}

/**
 * The findings of `text`, one per rule, with the excerpt cut from `written` (the line as written, when `text` is its
 * shell spelling) around the rule's first ordered hit, else its first hit.
 */
function scanSpelling(text: string, line: number, branches: readonly string[], written: string): HandoffFinding[] {
	// The rules run on the text with git global options blanked (same indices) and, for a command inside an option's
	// value (`git -c alias.x='!rm -rf /' x`), on the text itself; a hit both find is kept once.
	const blanked = blankGitGlobalOptions(text);
	const found = new Map<string, Hit>();
	for (const spelling of blanked === text ? [text] : [blanked, text]) {
		for (const [rule, pattern] of HIGH_RISK_GLOBAL) {
			for (const match of spelling.matchAll(pattern)) {
				const hit = { rule, start: match.index, end: match.index + match[0].length };
				found.set(`${rule}:${hit.start}:${hit.end}`, hit);
			}
		}
	}
	const hits: Hit[] = [...found.values(), ...pushesProtected(blanked, branches), ...removesAbsoluteTree(text)];
	const rules = [
		...new Set(hits.map((hit) => hit.rule)),
		...ADVISORY_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([rule]) => rule),
	];
	if (rules.length === 0) return [];
	const groups = parenGroups(text);
	const levels = new Map<number, Level>();
	// A context is pieces of the line, and no phrase spans the mask between them: a line without a phrase has none.
	const phrases = text.search(NOT_FORBIDDING) >= 0;
	return rules.map((rule) => {
		const ruleHits = hits.filter((hit) => hit.rule === rule);
		// A marker inside a `NOT_FORBIDDING` phrase ("don't hesitate to", "…않으면 안") does not forbid.
		const ordered = ruleHits.find((hit) => {
			if (definesRule(text, hit)) return false;
			const context = commandContext(text, groups, levels, hit.start, hit.end);
			return !FORBIDDING.test(phrases ? context.replace(NOT_FORBIDDING, MASK) : context);
		});
		const severity = HIGH_RISK_RULES.has(rule) && ordered !== undefined ? "high_risk" : "advisory";
		const advisory = ADVISORY_PATTERNS.find(([name]) => name === rule)?.[1];
		const at = (ordered ?? ruleHits[0])?.start ?? (advisory === undefined ? 0 : Math.max(0, text.search(advisory)));
		return { rule, line, excerpt: excerptOf(written, at), severity };
	});
}

/** A line ending in a backslash (trailing blanks allowed) is continued on the next one, as in a shell script. */
const CONTINUED = /\\[ \t\r]*$/;

const SEVERITY_RANK = { advisory: 0, high_risk: 1 } as const;

/**
 * Scans the first `HANDOFF_SCAN_BYTES` of a brief line by line for the high-risk patterns above; a hit whose own
 * clause forbids the command (`commandContext`) is downgraded to advisory. Lines joined by trailing backslashes are
 * also scanned as one line — joined with a blank and without one — reported at the first of them, so a command split
 * across them, even inside a word, is still seen; a rule a joined line finds no more severely than one of its own
 * lines (or the other joining) already did is not reported twice.
 */
export function scanHandoffBrief(brief: string, options: { protectedBranches?: readonly string[] } = {}): HandoffScan {
	const branches = options.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES;
	const { head, truncated } = headBytes(brief);
	const findings: HandoffFinding[] = [];
	const lines = head.split("\n");
	for (let first = 0; first < lines.length; ) {
		let last = first;
		while (last + 1 < lines.length && CONTINUED.test(lines[last] ?? "")) last++;
		const own: HandoffFinding[] = [];
		for (let index = first; index <= last; index++) own.push(...scanLine(lines[index] ?? "", index + 1, branches));
		findings.push(...own);
		if (last > first) {
			const parts = lines
				.slice(first, last + 1)
				.map((text, offset) => (first + offset < last ? text.replace(CONTINUED, "") : text));
			// Joined with a blank (a break between words) and without one (the shell's reading of a break inside a word).
			for (const joined of [parts.join(" "), parts.join("")]) {
				for (const finding of scanLine(joined, first + 1, branches)) {
					const seen = own.some(
						(found) => found.rule === finding.rule && SEVERITY_RANK[found.severity] >= SEVERITY_RANK[finding.severity],
					);
					if (seen) continue;
					findings.push(finding);
					own.push(finding);
				}
			}
		}
		first = last + 1;
	}
	const verdict: HandoffVerdict = findings.some((finding) => finding.severity === "high_risk")
		? "high_risk"
		: findings.length > 0 || truncated
			? "advisory"
			: "clear";
	return { verdict, findings, truncated };
}
