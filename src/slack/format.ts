export const CHUNK_LIMIT = 3900;
export const REDELIVERED_PREFIX = "(중복 가능: 재전송)";

// Room kept in every chunk so a code fence cut by a split can be closed ("\n```") and reopened ("```\n").
const FENCE_RESERVE = 8;

/** Markdown -> Slack mrkdwn. Fenced blocks pass through untouched; GFM tables become fixed-width fenced blocks. */
export function toMrkdwn(markdown: string): string {
	// Only fences are split here: a table row carrying code spans stays one prose segment, so the
	// table detector below sees whole lines (code spans themselves are masked inside convertProse).
	const parts = markdown.split(/(```[\s\S]*?```)/g);
	return parts.map((part, i) => (i % 2 === 1 ? part : convertProse(part))).join("");
}

const CODE_SPAN = /`[^`\n]+`/g;
const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
const USER_MENTION = /<(?:@[UW]|#[CG])[A-Z0-9]+>/g;
/** Placeholder sentinels (private-use chars) so masked spans and links survive every later regex. */
const SPAN_PLACEHOLDER = /\uE001(\d+)\uE001/g;
const LINK_PLACEHOLDER = /\uE000(\d+)\uE000/g;

function convertProse(text: string): string {
	const spans: string[] = [];
	const links: string[] = [];
	const masked = text
		.replace(CODE_SPAN, (span) => `\uE001${spans.push(span) - 1}\uE001`)
		.replace(LINK, (_m, label: string, url: string) => {
			links.push(`<${url}|${label.replace(/[<>|]/g, "")}>`);
			return `\uE000${links.length - 1}\uE000`;
		})
		// Only well-formed user mentions stay live Slack tokens; every other `<...>` is still escaped below.
		.replace(USER_MENTION, (mention) => `\uE000${links.push(mention) - 1}\uE000`);
	/** Puts masked code spans and links back; inside a rendered table they show verbatim, mrkdwn never applies. */
	const restore = (s: string): string =>
		s
			.replace(LINK_PLACEHOLDER, (_m, n: string) => links[Number(n)] ?? "")
			.replace(SPAN_PLACEHOLDER, (_m, n: string) => spans[Number(n)] ?? "");
	// Each rendered table is itself masked as a span, so the fence content is safe from the conversions below.
	const withTables = maskTables(masked, (block) => `\uE001${spans.push(renderTableBlock(block, restore)) - 1}\uE001`);
	const converted = withTables
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, "*$1*")
		.replace(/\*\*(.+?)\*\*/g, "*$1*")
		.replace(/~~(.+?)~~/g, "~$1~")
		.replace(/^([ \t]*)[-*][ \t]+/gm, "$1• ");
	return restore(converted);
}

type ColumnAlign = "left" | "center" | "right";

/** Splits one table row into cells; `\|` is a literal pipe inside a cell (GFM escaping). */
function splitRowCells(line: string): string[] {
	let trimmed = line.trim();
	if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
	if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) trimmed = trimmed.slice(0, -1);
	const cells: string[] = [];
	let cell = "";
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (ch === "\\" && trimmed[i + 1] === "|") {
			cell += "|";
			i++;
			continue;
		}
		if (ch === "|") {
			cells.push(cell.trim());
			cell = "";
			continue;
		}
		cell += ch;
	}
	cells.push(cell.trim());
	return cells;
}

function hasUnescapedPipe(line: string): boolean {
	for (let i = 0; i < line.length; i++) {
		if (line[i] === "|") return true;
		if (line[i] === "\\" && line[i + 1] === "|") i++;
	}
	return false;
}

/** A delimiter-row cell: hyphens with an optional leading/trailing colon. */
function isAlignCell(cell: string): boolean {
	return /^\s*:?-+:?\s*$/.test(cell);
}

function alignOf(cell: string): ColumnAlign {
	const trimmed = cell.trim();
	const left = trimmed.startsWith(":");
	const right = trimmed.endsWith(":");
	return left && right ? "center" : right ? "right" : "left";
}

/**
 * Replaces each detected GFM table block with `render(blockLines)`. A table is a pipe row followed by a
 * delimiter row of the same cell count (>= 2 columns, so prose with a lone `|` never matches) plus the pipe
 * rows after it; anything else passes through line for line.
 */
function maskTables(text: string, render: (block: string) => string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const header = splitRowCells(lines[i] ?? "");
		const delimiter = i + 1 < lines.length ? splitRowCells(lines[i + 1] ?? "") : undefined;
		if (
			delimiter !== undefined &&
			header.length >= 2 &&
			header.length === delimiter.length &&
			delimiter.every(isAlignCell)
		) {
			let j = i + 2;
			while (j < lines.length && hasUnescapedPipe(lines[j] ?? "")) j++;
			out.push(render(lines.slice(i, j).join("\n")));
			i = j;
			continue;
		}
		out.push(lines[i] ?? "");
		i++;
	}
	return out.join("\n");
}

/** Terminal-style width: East Asian wide/fullwidth and emoji count as 2 columns, everything else as 1. */
function displayWidth(text: string): number {
	let width = 0;
	for (const ch of text) {
		const cp = ch.codePointAt(0) ?? 0;
		const wide =
			(cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
			(cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals and symbols
			(cp >= 0x3041 && cp <= 0x33ff) || // Kana, CJK compatibility
			(cp >= 0x3400 && cp <= 0x4dbf) || // CJK extension A
			(cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
			(cp >= 0xa960 && cp <= 0xa97f) || // Hangul Jamo extended-A
			(cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
			(cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
			(cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
			(cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
			(cp >= 0xffe0 && cp <= 0xffe6) ||
			(cp >= 0x1f300 && cp <= 0x1f9ff) || // emoji
			(cp >= 0x20000 && cp <= 0x3fffd); // CJK extension B and beyond
		width += wide ? 2 : 1;
	}
	return width;
}

function padCell(text: string, width: number, align: ColumnAlign): string {
	const gap = width - displayWidth(text);
	if (gap <= 0) return text;
	if (align === "right") return `${" ".repeat(gap)}${text}`;
	if (align === "center") {
		const left = Math.floor(gap / 2);
		return `${" ".repeat(left)}${text}${" ".repeat(gap - left)}`;
	}
	return `${text}${" ".repeat(gap)}`;
}

/** Slack renders no markdown tables: one is rendered as an aligned, fixed-width fenced block instead. */
function renderTableBlock(block: string, restore: (s: string) => string): string {
	const lines = block.split("\n");
	const columns = splitRowCells(lines[0] ?? "").length;
	const aligns = splitRowCells(lines[1] ?? "").map((cell) => alignOf(cell));
	// The delimiter row only sets alignment; widths come from the header and the body rows.
	const toRow = (line: string): string[] => {
		// Rows shorter than the header pad with empty cells; a longer one folds its extras into the last cell.
		const cells = splitRowCells(line).map(restore);
		while (cells.length < columns) cells.push("");
		if (cells.length > columns) {
			cells.splice(columns - 1, cells.length - columns + 1, cells.slice(columns - 1).join("|"));
		}
		return cells;
	};
	const rows = [toRow(lines[0] ?? ""), ...lines.slice(2).map(toRow)];
	const widths = Array.from({ length: columns }, (_, c) =>
		Math.max(3, ...rows.map((cells) => displayWidth(cells[c] ?? ""))),
	);
	const rowLine = (cells: string[]): string =>
		`| ${cells.map((cell, c) => padCell(cell, widths[c] ?? 3, aligns[c] ?? "left")).join(" | ")} |`;
	const separator = `| ${aligns
		.map((align, c) => padCell("-".repeat(widths[c] ?? 3), widths[c] ?? 3, align))
		.join(" | ")} |`;
	return ["```", rowLine(rows[0] ?? []), separator, ...rows.slice(1).map(rowLine), "```"].join("\n");
}

function splitAt(text: string, limit: number): [string, string] {
	if (text.length <= limit) return [text, ""];
	let cut = text.lastIndexOf("\n\n", limit);
	if (cut < limit / 2) cut = text.lastIndexOf("\n", limit);
	if (cut < limit / 2) cut = text.lastIndexOf(" ", limit);
	if (cut < limit / 2) {
		cut = limit;
		// never split a surrogate pair
		const code = text.charCodeAt(cut - 1);
		if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
	}
	return [text.slice(0, cut), text.slice(cut).replace(/^\n+/, "")];
}

/** Splits into messages of at most `limit` characters, preferring paragraph/line boundaries and keeping code fences balanced. */
export function chunkText(text: string, limit = CHUNK_LIMIT): string[] {
	const budget = limit - FENCE_RESERVE;
	const raw: string[] = [];
	let rest = text;
	while (rest.length > 0) {
		const [head, tail] = splitAt(rest, budget);
		raw.push(head);
		rest = tail;
	}
	if (raw.length === 0) return [""];
	let open = false;
	return raw.map((chunk) => {
		let out = open ? `\`\`\`\n${chunk}` : chunk;
		const fences = (chunk.match(/```/g) ?? []).length;
		if (fences % 2 === 1) open = !open;
		if (open) out = `${out}\n\`\`\``;
		return out;
	});
}

/** mrkdwn-converted, chunked message bodies for one delivery. A redelivered answer is marked in its first message. */
export function renderParts(body: string, redelivered: boolean): string[] {
	const prefix = redelivered ? `${REDELIVERED_PREFIX}\n` : "";
	const parts = chunkText(toMrkdwn(body), CHUNK_LIMIT - prefix.length);
	return parts.map((part, i) => (i === 0 ? `${prefix}${part}` : part));
}

/** Running-status text while the turn has emitted no omp event for the stall window (120 s). */
export const STALL_STATUS_TEXT = "⏸ 응답 없음 2분";

export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const mm = String(Math.floor(total / 60)).padStart(2, "0");
	const ss = String(total % 60).padStart(2, "0");
	return `${mm}:${ss}`;
}
