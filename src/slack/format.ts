import { CARD_TONE_COLORS, type CardElement, type CardRun, type CardTone, cardRuns } from "../channel/card";
import {
	CHUNK_LIMIT,
	chunkText,
	cutCodePointSafe,
	displayWidth,
	FENCE_RESERVE,
	REDELIVERED_PREFIX,
	splitRowCells,
	tableEndAt,
	tableSpans,
} from "../channel/text";
import { CARD_MAX_BLOCKS, cardFallbackText, cardToBlocks, parseCard, type SlackBlock } from "./card";

/** Markdown -> Slack mrkdwn. Fenced blocks pass through untouched; GFM tables become fixed-width fenced blocks. */
export function toMrkdwn(markdown: string): string {
	// Only fences are split here: a table row carrying code spans stays one prose segment, so the
	// table detector below sees whole lines (code spans themselves are masked inside convertProse). A last fence that
	// never closes is code to the end too: `chunkText` closes it, so converting its body would show altered code.
	const parts = splitFences(markdown);
	return parts.map((part, i) => (i % 2 === 1 ? part : convertProse(part))).join("");
}

/** A line opening a fence: up to 3 spaces, a run of 3+ backticks, an info string without backticks. */
const FENCE_OPEN = /^ {0,3}(`{3,})[^`\n]*$/gm;

/**
 * `text` cut into prose and code, code at odd indexes. A fence opens on a line starting with a run of 3+ backticks and
 * closes only on a line holding a run at least as long (else at the end), so a ```` fence may quote a ``` one.
 * Inside prose, a mid-line ``` still opens code up to the next ``` (or the end of that prose).
 */
function splitFences(text: string): string[] {
	const parts: string[] = [];
	let prose = 0;
	FENCE_OPEN.lastIndex = 0;
	for (let open = FENCE_OPEN.exec(text); open !== null; open = FENCE_OPEN.exec(text)) {
		const run = open[1]?.length ?? 3;
		const close = new RegExp(`^ {0,3}\`{${run},}[ \\t]*$`, "m").exec(text.slice(open.index + open[0].length + 1));
		const end = close === null ? text.length : open.index + open[0].length + 1 + close.index + close[0].length;
		parts.push(...splitInlineFences(text.slice(prose, open.index)), text.slice(open.index, end));
		prose = end;
		FENCE_OPEN.lastIndex = end;
	}
	parts.push(...splitInlineFences(text.slice(prose)));
	return parts;
}

/**
 * Prose cut at its mid-line ``` runs: each opens code up to the next ``` (or the end). A run inside a GFM table stays
 * prose, so the table detector sees its rows whole (a cell's ``` is a code span there).
 */
function splitInlineFences(prose: string): string[] {
	const tables = tableSpans(prose);
	const parts: string[] = [];
	let from = 0;
	let pos = 0;
	for (let open = prose.indexOf("```", pos); open >= 0; open = prose.indexOf("```", pos)) {
		const table = tables.find(([start, end]) => start <= open && open < end);
		if (table !== undefined) {
			pos = table[1];
			continue;
		}
		const close = prose.indexOf("```", open + 3);
		const end = close < 0 ? prose.length : close + 3;
		parts.push(prose.slice(from, open), prose.slice(open, end));
		from = end;
		pos = end;
	}
	parts.push(prose.slice(from));
	return parts;
}

/**
 * `text` split at its inline code spans, CommonMark style: a run of N backticks opens a span that only the next run
 * of exactly N backticks on the same line closes (`` ``a ` b`` `` is one span); a run with no closer is plain text.
 * Odd indexes are the spans, backticks included. Body blocks, the mrkdwn fallback and the header share these bounds.
 */
function splitCodeSpans(text: string): string[] {
	const parts: string[] = [];
	let prose = 0;
	let i = 0;
	while (i < text.length) {
		if (text[i] !== "`") {
			i++;
			continue;
		}
		const open = i;
		while (text[i] === "`") i++;
		const run = i - open;
		let close = -1;
		for (let k = i; k < text.length && text[k] !== "\n"; ) {
			if (text[k] !== "`") {
				k++;
				continue;
			}
			const start = k;
			while (text[k] === "`") k++;
			if (k - start === run) {
				close = k;
				break;
			}
		}
		if (close < 0) continue;
		parts.push(text.slice(prose, open), text.slice(open, close));
		prose = close;
		i = close;
	}
	parts.push(text.slice(prose));
	return parts;
}

/** A code span's inside: its backtick runs off, and one space off each end when both ends have one (CommonMark). */
function codeSpanText(span: string): string {
	const run = /^`+/.exec(span)?.[0].length ?? 0;
	const inner = span.slice(run, span.length - run);
	return inner.startsWith(" ") && inner.endsWith(" ") && inner.trim() !== "" ? inner.slice(1, -1) : inner;
}

/** `[label](url)`; the URL may hold one level of balanced parentheses (`/wiki/Foo_(bar)`). */
const LINK = /\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/g;
/** `<@U…>`/`<#C…>`, optionally labelled (`<#C0123|general>`, `<@U0123|name>`). */
const USER_MENTION = /<(?:@[UW]|#[CG])[A-Z0-9]+(?:\|[^<>\n]*)?>/g;
/** Placeholder sentinels (private-use chars) so masked spans and links survive every later regex. */
const SPAN_PLACEHOLDER = /\uE001(\d+)\uE001/g;
const LINK_PLACEHOLDER = /\uE000(\d+)\uE000/g;

function convertProse(text: string): string {
	const spans: string[] = [];
	const links: string[] = [];
	// The input's own sentinel characters would be read back as placeholders (dropping or swapping text): drop them.
	const masked = splitCodeSpans(text.replace(/[\uE000\uE001]/g, ""))
		.map((piece, i) => (i % 2 === 1 ? `\uE001${spans.push(piece) - 1}\uE001` : piece))
		.join("")
		.replace(LINK, (_m, label: string, url: string) => {
			links.push(
				`<${url.replace(/\|/g, "%7C").replace(/</g, "%3C").replace(/>/g, "%3E")}|${label.replace(/[<>|]/g, "")}>`,
			);
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
		const end = tableEndAt(lines, i);
		if (end !== undefined) {
			out.push(render(lines.slice(i, end).join("\n")));
			i = end;
			continue;
		}
		out.push(lines[i] ?? "");
		i++;
	}
	return out.join("\n");
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

/**
 * mrkdwn-converted, chunked message bodies for one delivery. A redelivered answer is marked in its first message;
 * `footer` (elapsed time, tool count) closes the last one as an italic line.
 */
export function renderParts(body: string, redelivered: boolean, footer?: string): string[] {
	const prefix = redelivered ? `${REDELIVERED_PREFIX}\n` : "";
	const suffix = footer === undefined ? "" : `\n_${footer}_`;
	const parts = chunkText(toMrkdwn(body), CHUNK_LIMIT - prefix.length - suffix.length);
	return parts.map((part, i) => `${i === 0 ? prefix : ""}${part}${i === parts.length - 1 ? suffix : ""}`);
}

/** One message of an answer Slack renders itself (a `markdown` block); Slack caps one payload's markdown at 12,000. */
export const MARKDOWN_CHUNK_LIMIT = 11_000;
/** The hard cap of one markdown block, applied after mentions are swapped for names. */
const MARKDOWN_BLOCK_LIMIT = 12_000;
/** `text` of a markdown message: what mobile notifications and block-less clients show. */
const MARKDOWN_TEXT_LIMIT = 3_000;

/** Slack caps a `header` block's plain text at 150 characters. */
export const HEADER_LIMIT = 150;
/** Live tokens one `🔔` line carries at most, and its length budget (a context text element holds 3,000). */
const BELL_MAX_TOKENS = 20;
const BELL_MAX_CHARS = 1_500;

export type HeaderBlock = { type: "header"; text: { type: "plain_text"; text: string; emoji: true } };

export type AnswerBlock =
	| HeaderBlock
	| { type: "markdown"; text: string }
	| { type: "context"; elements: Array<{ type: "mrkdwn"; text: string }> };

export interface MarkdownPart {
	/** mrkdwn fallback for notifications. */
	text: string;
	/** A card with a `tone`: the same blocks without the colour bar, sent only when Slack refuses the attachment. */
	blocks: ReadonlyArray<AnswerBlock | SlackBlock>;
	/** A card with a `tone`: one attachment of its colour holding the part's blocks, sent instead of top-level blocks. */
	attachments?: ReadonlyArray<SlackAttachment>;
	/** Set on a card part: what its sender falls back to when Slack refuses the card's blocks. */
	card?: CardFallback;
}

/** A legacy attachment carrying Block Kit blocks: `color` draws the bar on the message's left edge. */
export interface SlackAttachment {
	color: string;
	blocks: ReadonlyArray<AnswerBlock | SlackBlock>;
	/** Notification text; set when sent, since the message's own `text` stays empty (Slack would show it above). */
	fallback?: string;
}

/** A card part's fallbacks, decorated like the part (redelivered, 🔔, footer). */
export interface CardFallback {
	/**
	 * The same card with every chart as an ASCII code block; only when the card has a chart drawn natively. A card with
	 * a `tone` sends them inside an attachment of the part's colour.
	 */
	asciiBlocks?: ReadonlyArray<AnswerBlock | SlackBlock>;
	/** The card fence's source as a code block, without blocks. */
	text: string;
}

/** `renderMarkdownParts`' result; `cardIssues` lists why card fences stayed text (`card <n>: <issue>`). */
export type MarkdownParts = MarkdownPart[] & { cardIssues?: readonly string[] };

type SlackCard = { card: CardElement; blocks: SlackBlock[]; tone?: CardTone };
type Piece = CardRun<SlackCard>;

/**
 * `content` as text and validated card pieces (see `cardRuns`). `undefined` when no card validates (the answer renders
 * exactly as without cards). With `headed` the first message opens with a header block, so a card opening the answer
 * gets one block less.
 */
function cardPieces(content: string, charts: boolean, headed: boolean, issues: string[]): Piece[] | undefined {
	const pieces = cardRuns<SlackCard>(content, issues, (json, first) => {
		const parsed = parseCard(json, { charts });
		if (!parsed.ok) return parsed.issues;
		const room = headed && first ? CARD_MAX_BLOCKS - 1 : CARD_MAX_BLOCKS;
		if (parsed.blocks.length > room) {
			return [`the card needs ${parsed.blocks.length} blocks, at most ${room} under the header`];
		}
		return { card: parsed.card, blocks: parsed.blocks, ...(parsed.tone === undefined ? {} : { tone: parsed.tone }) };
	});
	return pieces.some((piece) => piece.kind === "card") ? pieces : undefined;
}

/** Who a mention token names: the owner and the configured peer bots read as themselves, anyone else generically. */
export interface MentionNames {
	ownerUserId: string;
	peerBots: ReadonlyArray<{ userId: string; name: string }>;
}

function contextBlock(text: string): AnswerBlock {
	return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

export function headerBlock(text: string): HeaderBlock {
	return { type: "header", text: { type: "plain_text", text, emoji: true } };
}

/** `<!here>`, `<!channel>`, `<!everyone>`, `<!subteam^S…>`, optionally labelled. */
const SPECIAL_MENTION = /<!(?:here|channel|everyone|subteam\^[A-Z0-9]+)(?:\|[^<>\n]*)?>/;
/** Every live Slack token: user/channel mentions and special mentions. */
const SLACK_TOKEN = new RegExp(`${USER_MENTION.source}|${SPECIAL_MENTION.source}`, "g");

/** `@오너`, `@<peer name>`, `@사용자`, `#label`/`#채널`, `@here`/`@channel`/`@everyone`, `@그룹` for one live token. */
function readableToken(token: string, names: MentionNames): string {
	const label = /\|([^<>\n]*)>$/.exec(token)?.[1];
	if (token.startsWith("<#")) return label ? `#${label}` : "#채널";
	if (token.startsWith("<!")) {
		const kind = /^<!(here|channel|everyone)\b/.exec(token)?.[1];
		return kind === undefined ? "@그룹" : `@${kind}`;
	}
	const id = /^<@([A-Z0-9]+)/.exec(token)?.[1];
	if (id === names.ownerUserId) return "@오너";
	const peer = names.peerBots.find((bot) => bot.userId === id);
	return peer === undefined ? "@사용자" : `@${peer.name}`;
}

/** Every live token outside code (fences, inline code spans) replaced by `swap(token)`; code stays byte for byte. */
function swapTokensOutsideCode(markdown: string, swap: (token: string) => string): string {
	return splitFences(markdown)
		.map((part, i) =>
			i % 2 === 1
				? part
				: splitCodeSpans(part)
						.map((piece, j) => (j % 2 === 1 ? piece : piece.replace(SLACK_TOKEN, swap)))
						.join(""),
		)
		.join("");
}

/** `🔔 <tokens>`: the first 20 (within 1,500 chars) in order, the rest counted as `외 N개`. */
function bellLine(tokens: readonly string[]): string {
	const shown: string[] = [];
	let length = 0;
	for (const token of tokens) {
		if (shown.length === BELL_MAX_TOKENS || length + token.length + 1 > BELL_MAX_CHARS) break;
		shown.push(token);
		length += token.length + 1;
	}
	const rest = tokens.length - shown.length;
	return ["🔔", ...shown, ...(rest > 0 ? [`외 ${rest}개`] : [])].join(" ");
}

/**
 * One mrkdwn line as `header` plain text: `*x*`·`_x_`·`~x~`·`` `x` `` keep only their inside, `<url|label>` its label,
 * live tokens their readable name (`@오너`, `#label`, …); cut to the header limit.
 */
export function plainHeaderText(line: string, names: MentionNames): string {
	const unlinked = line
		.replace(SLACK_TOKEN, (token) => readableToken(token, names))
		.replace(/<[^<>|\n]+\|([^<>\n]+)>/g, "$1")
		.replace(/<([^<>|\n]+)>/g, "$1");
	const plain = splitCodeSpans(unlinked)
		.map((piece, i) => (i % 2 === 1 ? codeSpanText(piece) : piece))
		.join("")
		.replace(/(^|[^\w*])\*{1,2}([^*\n]+?)\*{1,2}(?=$|[^\w*])/g, "$1$2")
		.replace(/(^|[^\w_])_{1,2}([^_\n]+?)_{1,2}(?=$|[^\w_])/g, "$1$2")
		.replace(/(^|[^\w~])~{1,2}([^~\n]+?)~{1,2}(?=$|[^\w~])/g, "$1$2")
		.trim();
	return cutCodePointSafe(plain, HEADER_LIMIT);
}

/** A monitor delivery's `⏰ <name>` first line (at most 150 chars, with a body after it) as a header title. */
function monitorTitle(body: string, names: MentionNames): { line: string; title: string; rest: string } | undefined {
	const newline = body.indexOf("\n");
	if (newline < 0) return undefined;
	const line = body.slice(0, newline);
	const rest = body.slice(newline + 1);
	if (!line.startsWith("⏰ ") || line.length > HEADER_LIMIT || rest.trim() === "") return undefined;
	const title = plainHeaderText(line, names);
	return title === "" ? undefined : { line, title, rest };
}

const NO_NAMES: MentionNames = { ownerUserId: "", peerBots: [] };

/**
 * The answer as `markdown` blocks, one message per `MARKDOWN_CHUNK_LIMIT` chunk; a GFM table never splits across two.
 * A redelivered answer opens with a `(중복 가능: 재전송)` context block, `footer` closes the last message as one.
 * Live Slack tokens outside code read as names in the markdown (a `markdown` block is not documented to render them);
 * the originals, deduplicated in order, follow the first message's markdown as one `🔔` mrkdwn context line, which
 * notifies and stays clickable. `text` keeps them as they are. With `monitorHeader`, a `⏰ <name>` first line becomes
 * the first message's header block instead of a markdown line.
 * With `cards`, each validated ` ```card ` fence (see `splitCards`) becomes a message of its own in place: the card's
 * Block Kit blocks with `cardFallbackText` as `text`; the redelivered block, `🔔` line and footer still go to the first
 * and last messages, after the card's blocks. A card with a `tone` also gets `attachments`: one of its colour holding
 * those same blocks. A fence that fails validation stays text, its issues in `cardIssues`.
 * `charts: false` draws card charts as ASCII code blocks. Without a valid card the result equals `cards: false`.
 * `undefined` when the plain path (`renderParts`) must carry it: an empty body, or a table longer than one message.
 */
export function renderMarkdownParts(
	body: string,
	redelivered: boolean,
	footer?: string,
	options: { names?: MentionNames; monitorHeader?: boolean; cards?: boolean; charts?: boolean } = {},
): MarkdownParts | undefined {
	if (body.trim() === "") return undefined;
	const names = options.names ?? NO_NAMES;
	const titled = options.monitorHeader === true ? monitorTitle(body, names) : undefined;
	const content = titled?.rest ?? body;
	const charts = options.charts ?? true;
	const cardIssues: string[] = [];
	const cut = options.cards === true ? cardPieces(content, charts, titled !== undefined, cardIssues) : undefined;
	// Names are longer than the tokens they replace: when a swapped piece passes Slack's cap, cut again on a budget
	// scaled by how far the worst piece overshot.
	let limit = MARKDOWN_CHUNK_LIMIT;
	let pieces: Piece[];
	for (;;) {
		if (tableSpans(content).some(([start, end]) => end - start > limit - FENCE_RESERVE)) return undefined;
		const chunk = (text: string, spans: ReadonlyArray<readonly [number, number]>): Piece[] =>
			chunkText(text, limit, spans).map((chunked) => ({ kind: "text", text: chunked }));
		pieces =
			cut === undefined
				? chunk(content, tableSpans(content))
				: cut.flatMap((piece): Piece[] =>
						piece.kind === "card" ? [piece] : chunk(piece.text, tableSpans(piece.text)),
					);
		const longest = Math.max(
			...pieces.map((piece) =>
				piece.kind === "text" ? swapTokensOutsideCode(piece.text, (token) => readableToken(token, names)).length : 0,
			),
		);
		if (longest <= MARKDOWN_BLOCK_LIMIT) break;
		limit = Math.floor((limit * MARKDOWN_BLOCK_LIMIT) / longest) - 1;
	}
	const tokens: string[] = [];
	let found = 0;
	const collect = (token: string): string => {
		found += 1;
		if (!tokens.includes(token)) tokens.push(token);
		return readableToken(token, names);
	};
	// The header shows the title's tokens as names only, so its originals open the 🔔 line.
	if (titled !== undefined) swapTokensOutsideCode(titled.line, collect);
	const titleTokens = found;
	const withTokens: boolean[] = [];
	// A card's text is not markdown: its tokens are neither read as names nor collected.
	const markdowns = pieces.map((piece, i) => {
		found = i === 0 ? titleTokens : 0;
		const markdown = piece.kind === "text" ? swapTokensOutsideCode(piece.text, collect) : "";
		withTokens.push(found > 0);
		return markdown;
	});
	const prefix = redelivered ? `${REDELIVERED_PREFIX}\n` : "";
	const last = pieces.length - 1;
	const head = (i: number): AnswerBlock[] => [
		...(i === 0 && titled !== undefined ? [headerBlock(titled.title)] : []),
		...(i === 0 && redelivered ? [contextBlock(REDELIVERED_PREFIX)] : []),
	];
	const tail = (i: number): AnswerBlock[] => [
		...(i === 0 && tokens.length > 0 ? [contextBlock(bellLine(tokens))] : []),
		...(i === last && footer !== undefined ? [contextBlock(footer)] : []),
	];
	const parts: MarkdownParts = pieces.map((piece, i): MarkdownPart => {
		const title = i === 0 && titled !== undefined ? `${titled.line}\n` : "";
		if (piece.kind === "card") {
			const titleText = title === "" ? "" : toMrkdwn(title);
			const blocks = [...head(i), ...piece.blocks, ...tail(i)];
			return {
				text: cutCodePointSafe(
					`${i === 0 ? prefix : ""}${titleText}${cardFallbackText(piece.card)}`,
					MARKDOWN_TEXT_LIMIT,
				),
				blocks,
				...(piece.tone === undefined ? {} : { attachments: [{ color: CARD_TONE_COLORS[piece.tone], blocks }] }),
				card: {
					...(charts && piece.blocks.some((block) => block.type === "data_visualization")
						? { asciiBlocks: [...head(i), ...cardToBlocks(piece.card, { charts: false }), ...tail(i)] }
						: {}),
					text: [
						`${i === 0 ? prefix : ""}${titleText}${piece.raw}`,
						...(i === 0 && tokens.length > 0 ? [bellLine(tokens)] : []),
						...(i === last && footer !== undefined ? [`_${footer}_`] : []),
					].join("\n"),
				},
			};
		}
		const fallback = `${i === 0 ? prefix : ""}${toMrkdwn(`${title}${piece.text}`)}`;
		return {
			// A message carrying live tokens keeps its whole fallback: a peer bot reads only `text`, mention and request.
			text: withTokens[i] ? fallback : cutCodePointSafe(fallback, MARKDOWN_TEXT_LIMIT),
			blocks: [...head(i), { type: "markdown", text: markdowns[i] ?? piece.text }, ...tail(i)],
		};
	});
	if (cardIssues.length > 0) parts.cardIssues = cardIssues;
	return parts;
}
