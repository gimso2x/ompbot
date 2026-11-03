/**
 * Handoff risk scan: before a brief goes to an unattended herdr worker, look for irreversible commands in it.
 * Pure — reads no files, git or network. A command on a line that forbids it ("…은 하지 않는다", "never …") is a
 * normal worker instruction and only counts as advisory.
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

const HIGH_RISK_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
	["git_reset_hard", new RegExp(`\\bgit\\s+reset\\b${SEGMENT}\\s--hard\\b`, "i")],
	["git_clean_force", new RegExp(`\\bgit\\s+clean\\b${SEGMENT}\\s(?:-[a-z]*f[a-z]*|--force)(?![\\w-])`, "i")],
	[
		"git_push_force",
		new RegExp(`\\bgit\\s+push\\b${SEGMENT}\\s(?:--force(?:-with-lease)?|-[a-z]*f[a-z]*)(?![\\w-])`, "i"),
	],
	// `-d` is the safe delete, so the flag letter is matched case-sensitively; only the verb ignores case.
	["git_branch_force_delete", new RegExp(`\\b[gG][iI][tT]\\s+[bB][rR][aA][nN][cC][hH]\\b${SEGMENT}\\s-[a-zA-Z]*D`)],
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

/** Forbidding markers: a high_risk hit on a line carrying one of these is downgraded to advisory. */
const FORBIDDING =
	/하지\s*마|하지\s*않|않는다|금지|말\s*것|말고|\bnever\b|\bdo\s+not\b|\bdon['’]t\b|\bmust\s+not\b|\bforbidden\b|^\s*[-*]\s+no\s/i;

const HIGH_RISK_RULES = new Set([...HIGH_RISK_PATTERNS.map(([rule]) => rule), "git_push_protected", "rm_rf_absolute"]);

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `git push … <protected branch>`: the branch as a whole ref word (`main`, `HEAD:main`, `+main`, `refs/heads/main`). */
function pushesProtected(line: string, branches: readonly string[]): boolean {
	if (branches.length === 0) return false;
	const names = branches.map(escapeRegExp).join("|");
	const ref = new RegExp(`(?<![\\w./-])(?:refs/heads/)?(?:${names})(?![\\w./-])`, "i");
	for (const match of line.matchAll(new RegExp(`\\bgit\\s+push\\b(${SEGMENT})`, "gi"))) {
		if (ref.test(match[1] ?? "")) return true;
	}
	return false;
}

/** `rm` with recursive and force flags whose target starts at `/`, `~` or `$HOME`. */
function removesAbsoluteTree(line: string): boolean {
	for (const match of line.matchAll(new RegExp(`\\brm\\s(${SEGMENT})`, "gi"))) {
		let recursive = false;
		let force = false;
		let absolute = false;
		for (const word of (match[1] ?? "").split(/\s+/)) {
			if (word === "") continue;
			if (/^--recursive$/i.test(word)) recursive = true;
			else if (/^--force$/i.test(word)) force = true;
			else if (/^-[a-z]+$/i.test(word)) {
				if (/[rR]/.test(word)) recursive = true;
				if (/f/i.test(word)) force = true;
			} else if (/^["']?(?:\/|~|\$HOME\b|\$\{HOME\})/.test(word)) absolute = true;
		}
		if (recursive && force && absolute) return true;
	}
	return false;
}

/** The first `HANDOFF_SCAN_BYTES` bytes of `text` (UTF-8), cut back to a whole character. */
function headBytes(text: string): { head: string; truncated: boolean } {
	const bytes = new TextEncoder().encode(text);
	if (bytes.length <= HANDOFF_SCAN_BYTES) return { head: text, truncated: false };
	let end = HANDOFF_SCAN_BYTES;
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	return { head: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}

/** Scans a brief line by line; see `doc/plans/handoff-risk-scan.md` for the rules. */
export function scanHandoffBrief(brief: string, options: { protectedBranches?: readonly string[] } = {}): HandoffScan {
	const branches = options.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES;
	const { head, truncated } = headBytes(brief);
	const findings: HandoffFinding[] = [];
	head.split("\n").forEach((text, index) => {
		const rules = [
			...HIGH_RISK_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([rule]) => rule),
			...(pushesProtected(text, branches) ? ["git_push_protected"] : []),
			...(removesAbsoluteTree(text) ? ["rm_rf_absolute"] : []),
			...ADVISORY_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([rule]) => rule),
		];
		if (rules.length === 0) return;
		const forbidden = FORBIDDING.test(text);
		const lower = text.toLowerCase();
		const excerpt = Array.from(text.replace(/\s+/g, " ").trim()).slice(0, EXCERPT_CHARS).join("");
		for (const rule of rules) {
			// A line naming the rule itself (`git_reset_hard`: `git reset --hard`) documents this scanner, not an order.
			const quoted = forbidden || lower.includes(rule);
			const severity = HIGH_RISK_RULES.has(rule) && !quoted ? "high_risk" : "advisory";
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
