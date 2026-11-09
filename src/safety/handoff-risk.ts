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
const DEFAULT_PROTECTED_BRANCHES = ["main", "master"] as const;

/** The rest of a shell command after its verb: up to the next `;`, `&`, `|`, or the end of an inline code span. */
const SEGMENT = "[^;&|`\\n]*";

/** One argument of a git global option: a quoted string or a word without whitespace or a command separator. */
const GIT_OPTION_ARG = "(?:\"[^\"`\\n]*\"|'[^'`\\n]*'|[^\\s;&|`]+)";
/**
 * Zero or more git global options between `git` and its subcommand (`git -C <dir> reset …`). Written with explicit
 * case so the case-sensitive `branch -D` rule can use it too.
 */
const GIT_GLOBAL_OPTIONS = `(?:\\s+(?:-[Cc]\\s+${GIT_OPTION_ARG}|--(?:git-dir|work-tree|namespace)(?:=|\\s+)${GIT_OPTION_ARG}|--no-pager|-P|--bare|--no-replace-objects))*`;

const HIGH_RISK_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
	["git_reset_hard", new RegExp(`\\bgit${GIT_GLOBAL_OPTIONS}\\s+reset\\b${SEGMENT}\\s--hard\\b`, "i")],
	[
		"git_clean_force",
		new RegExp(`\\bgit${GIT_GLOBAL_OPTIONS}\\s+clean\\b${SEGMENT}\\s(?:-[a-z]*f[a-z]*|--force)(?![\\w-])`, "i"),
	],
	[
		"git_push_force",
		new RegExp(
			`\\bgit${GIT_GLOBAL_OPTIONS}\\s+push\\b${SEGMENT}\\s(?:--force(?:-with-lease)?|-[a-z]*f[a-z]*)(?![\\w-])`,
			"i",
		),
	],
	// `-d` is the safe delete, so the flag letter is matched case-sensitively; only the verb ignores case.
	[
		"git_branch_force_delete",
		new RegExp(`\\b[gG][iI][tT]${GIT_GLOBAL_OPTIONS}\\s+[bB][rR][aA][nN][cC][hH]\\b${SEGMENT}\\s-[a-zA-Z]*D`),
	],
	["sql_destructive", /\b(?:drop\s+(?:table|database)|truncate\s+table)\b/i],
	[
		"service_control",
		/\bsystemctl(?:\s+-{1,2}[\w=-]+)*\s+(?:restart|stop|start|disable|kill)\b|\b(?:docker|podman)\s+(?:(?:container|compose)\s+)?(?:rm|stop|kill|restart)\b|\bpm2\s+(?:restart|stop|delete)\b/i,
	],
	["disk_destructive", new RegExp(`\\bmkfs\\b|\\bdd\\s${SEGMENT}\\bof=/dev/`, "i")],
	["secret_path", /\.ompbot\/secrets/i],
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
	/하지\s*마|하지\s*않|않는다|금지|말\s*것|말고|\bnever\b|\bdo\s+not\b|\bdon['’]t\b|\bmust\s+not\b|\bforbidden\b|^\s*[-*]\s+no\s/i;
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
 * or a lone `후` between spaces, a Korean connector with whitespace on one side. Parentheses are handled apart
 * (`commandContext`).
 */
const CLAUSE_BOUNDARY = new RegExp(
	[
		"[;,，、]",
		"[.。!?](?=\\s)",
		"(?<=\\s)(?:and|then|but|after|before|후)(?=\\s)",
		`(?<=\\s)(?:${KOREAN_CONNECTORS})`,
		`(?:${KOREAN_CONNECTORS})(?=\\s)`,
	].join("|"),
	"gi",
);

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
	for (const match of line.matchAll(new RegExp(`\\bgit${GIT_GLOBAL_OPTIONS}\\s+push\\b(${SEGMENT})`, "gi"))) {
		const segment = match[1] ?? "";
		const found = ref.exec(segment);
		if (found === null) continue;
		const segmentAt = match.index + match[0].length - segment.length;
		hits.push({ rule: "git_push_protected", start: match.index, end: segmentAt + found.index + found[0].length });
	}
	return hits;
}

/** `rm` with recursive and force flags whose target starts at `/`, `~` or `$HOME`; a hit ends at its last such word. */
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
			} else if (/^["']?(?:\/|~|\$HOME\b|\$\{HOME\})/.test(word)) absolute = true;
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
}

/** Balanced `( )` / `（ ）` pairs of a line, by index; an unmatched one is ordinary text. */
function parenGroups(line: string): ParenGroup[] {
	const groups: ParenGroup[] = [];
	const stack: number[] = [];
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === "(" || char === "（") stack.push(i);
		else if (char === ")" || char === "）") {
			const open = stack.pop();
			if (open !== undefined) groups.push({ open, close: i });
		}
	}
	return groups;
}

/**
 * The text a forbidding marker must sit in to downgrade the command at `[start, end)`, as the line with everything
 * else masked: the command's clause, without the command itself and without the parentheses inside that clause. A
 * command inside a parenthesis adds the clause around that parenthesis, outward to the line level. Clause boundaries
 * are looked for with the command and the inner parentheses masked, so neither is ever cut.
 */
function commandContext(line: string, groups: readonly ParenGroup[], start: number, end: number): string {
	const visible = new Array<boolean>(line.length).fill(false);
	let span = { start, end };
	for (;;) {
		let enclosing: ParenGroup | undefined;
		for (const group of groups) {
			const encloses = group.open < span.start && group.close >= span.end;
			if (encloses && (enclosing === undefined || group.open > enclosing.open)) enclosing = group;
		}
		const lo = enclosing === undefined ? 0 : enclosing.open + 1;
		const hi = enclosing === undefined ? line.length : enclosing.close;
		const hidden = new Array<boolean>(hi - lo).fill(false);
		const hide = (from: number, to: number) => {
			for (let i = Math.max(from, lo); i < Math.min(to, hi); i++) hidden[i - lo] = true;
		};
		hide(span.start, span.end);
		for (const group of groups) if (group.open >= lo && group.close < hi) hide(group.open, group.close + 1);
		const level = Array.from(hidden, (masked, i) => (masked ? MASK : line[lo + i])).join("");
		let from = 0;
		let to = level.length;
		for (const boundary of level.matchAll(CLAUSE_BOUNDARY)) {
			const at = boundary.index;
			if (at + boundary[0].length <= span.start - lo) from = at + boundary[0].length;
			else if (at >= span.end - lo && at < to) to = at;
		}
		for (let i = from; i < to; i++) if (!hidden[i]) visible[lo + i] = true;
		if (enclosing === undefined) break;
		span = { start: enclosing.open, end: enclosing.close + 1 };
	}
	return Array.from(visible, (shown, i) => (shown ? line[i] : MASK)).join("");
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
 * Scans the first `HANDOFF_SCAN_BYTES` of a brief line by line for the high-risk patterns above; a hit whose own
 * clause forbids the command (`commandContext`) is downgraded to advisory.
 */
export function scanHandoffBrief(brief: string, options: { protectedBranches?: readonly string[] } = {}): HandoffScan {
	const branches = options.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES;
	const { head, truncated } = headBytes(brief);
	const findings: HandoffFinding[] = [];
	head.split("\n").forEach((text, index) => {
		const hits: Hit[] = [
			...HIGH_RISK_GLOBAL.flatMap(([rule, pattern]) =>
				Array.from(text.matchAll(pattern), (match) => ({
					rule,
					start: match.index,
					end: match.index + match[0].length,
				})),
			),
			...pushesProtected(text, branches),
			...removesAbsoluteTree(text),
		];
		const rules = [
			...new Set(hits.map((hit) => hit.rule)),
			...ADVISORY_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([rule]) => rule),
		];
		if (rules.length === 0) return;
		const groups = parenGroups(text);
		const excerpt = Array.from(text.replace(/\s+/g, " ").trim()).slice(0, EXCERPT_CHARS).join("");
		for (const rule of rules) {
			// A line defining the rule (- `git_reset_hard`: `git reset --hard`) documents this scanner, not an order.
			const defined = new RegExp(`^\\s*[-*]?\\s*\`${escapeRegExp(rule)}\`\\s*:`).test(text);
			// A marker inside a `NOT_FORBIDDING` phrase ("don't hesitate to", "…않으면 안") does not forbid.
			const ordered =
				!defined &&
				hits.some(
					(hit) =>
						hit.rule === rule &&
						!FORBIDDING.test(commandContext(text, groups, hit.start, hit.end).replace(NOT_FORBIDDING, MASK)),
				);
			const severity = HIGH_RISK_RULES.has(rule) && ordered ? "high_risk" : "advisory";
			findings.push({ rule, line: index + 1, excerpt, severity });
		}
	});
	const verdict: HandoffVerdict = findings.some((finding) => finding.severity === "high_risk")
		? "high_risk"
		: findings.length > 0 || truncated
			? "advisory"
			: "clear";
	return { verdict, findings, truncated };
}
