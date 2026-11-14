// Text for Discord: core text written as Slack mrkdwn becomes Discord markdown (`mrkdwnToDiscord`), and a delivery body
// (the model's markdown, which Discord mostly draws as is) becomes messages of at most 2000 characters
// (`renderDiscordParts`), its valid ```card fences embeds of their own (`renderDiscordMessages`).
import { cardRuns, validateCard } from "../channel/card";
import { chunkText, errorText, escapeMrkdwn, REDELIVERED_PREFIX, tableEndAt } from "../channel/text";
import { cardToEmbed, type DiscordEmbed } from "./card";
import { MESSAGE_CONTENT_LIMIT } from "./transport";

/** Fenced blocks and inline code: copied untouched by both conversions. */
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;

/** Applies `convert` to the text between code spans only. */
export function outsideCode(text: string, convert: (plain: string) => string): string {
	let out = "";
	let last = 0;
	for (const match of text.matchAll(CODE)) {
		out += convert(text.slice(last, match.index)) + match[0];
		last = match.index + match[0].length;
	}
	return out + convert(text.slice(last));
}

function convertPlain(text: string): string {
	return (
		text
			// Slack special mentions (`<!here>`, `<!channel|@channel>`, `<!subteam^ID>`) become their bare word: Discord
			// would ping `@here`/`@everyone`, and nothing the core writes means to.
			.replace(/<!([a-z]+)[^>]*>/g, "$1")
			.replace(/<#([0-9]+)\|[^>]*>/g, "<#$1>")
			.replace(/<((?:https?|mailto):[^|>\s]+)\|([^>]+)>/g, (_, url: string, label: string) => `[${label}](${url})`)
			.replace(/<((?:https?|mailto):[^|>\s]+)>/g, "$1")
			// A `\*` / `\~` (`escapeDiscordMarkdown`) is a literal character, never a delimiter.
			.replace(/(^|[^\w*\\])\*(?=\S)([^*\n]+?)(?<=[^\s\\])\*(?![\w*])/g, "$1**$2**")
			.replace(/(^|[^\w~\\])~(?=\S)([^~\n]+?)(?<=[^\s\\])~(?![\w~])/g, "$1~~$2~~")
			// Slack's `&`/`<`/`>` escapes, undone last so a literal `<` never reads as a Slack token above.
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&amp;/g, "&")
	);
}

/**
 * Slack mrkdwn (what `OutboundMessage.text` carries) → Discord markdown: `*bold*`, `~strike~`, `<url|label>`, `<url>`
 * and the `&amp;`/`&lt;`/`&gt;` escapes. `<@id>` and `<#id>` mean the same on both. Code spans stay as they are.
 */
export function mrkdwnToDiscord(text: string): string {
	return outsideCode(text, convertPlain);
}

/**
 * Owner text quoted into core text bound for Discord (an inject marker's preview): Discord's markdown characters are
 * backslash-escaped so they show as typed, and `&`/`<`/`>` get the core text escapes `mrkdwnToDiscord` undoes.
 */
export function escapeDiscordMarkdown(text: string): string {
	return escapeMrkdwn(text.replace(/[\\*_`~|>]/g, "\\$&"));
}

/**
 * GFM tables (a header row, a `|---|` rule of 3+ hyphens a cell, more rows) outside code fences, each wrapped in a code
 * fence: Discord does not draw tables. Returns the text and the wrapped spans, which a split must keep whole.
 */
function fenceTables(text: string): { text: string; spans: Array<[number, number]> } {
	const lines = text.split("\n");
	const out: string[] = [];
	const spans: Array<[number, number]> = [];
	let offset = 0;
	let fenceRun = 0;
	const push = (line: string): void => {
		out.push(line);
		offset += line.length + 1;
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		// A fence opens on a line of 3+ backticks and an info string without backticks, and closes on a line of backticks
		// alone at least as long; a fence closed on its own line (```bash x```) opens nothing.
		if (fenceRun === 0) fenceRun = /^ {0,3}(`{3,})[^`]*$/.exec(line)?.[1]?.length ?? 0;
		else if ((/^ {0,3}(`+)[ \t]*$/.exec(line)?.[1]?.length ?? 0) >= fenceRun) fenceRun = 0;
		const end = fenceRun > 0 ? undefined : tableEndAt(lines, i, 3);
		if (end === undefined) {
			push(line);
			continue;
		}
		const start = offset;
		push("```");
		for (const row of lines.slice(i, end)) push(row);
		push("```");
		spans.push([start, offset - 1]);
		i = end - 1;
	}
	return { text: out.join("\n"), spans };
}

/**
 * One delivery body as Discord messages: tables fenced, split into parts of at most 2000 characters with code fences
 * closed in each part and surrogate pairs kept whole. A redelivered answer is marked in its first part; `footer`
 * (elapsed time, tool count) closes the last one as an italic line.
 */
export function renderDiscordParts(body: string, redelivered: boolean, footer?: string): string[] {
	const prefix = redelivered ? `${REDELIVERED_PREFIX}\n` : "";
	const suffix = footer === undefined ? "" : `\n_${footer}_`;
	const parts = chunkPlain(body, MESSAGE_CONTENT_LIMIT - prefix.length - suffix.length);
	return parts.map((part, i) => `${i === 0 ? prefix : ""}${part}${i === parts.length - 1 ? suffix : ""}`);
}

/** Plain text in parts of at most `limit`: tables fenced and kept whole when they fit, fences closed in each part. */
function chunkPlain(body: string, limit: number): string[] {
	const { text, spans } = fenceTables(body);
	// A table longer than a message cannot stay whole; it is split like any fenced block.
	return chunkText(
		text,
		limit,
		spans.filter(([start, end]) => end - start <= limit),
	);
}

/** One Discord message of an answer: text, or a card's embed (whose content is only the redelivered/footer lines). */
export interface DiscordPart {
	content: string;
	embeds?: DiscordEmbed[];
}

/** `renderDiscordMessages`' result; `cardIssues` lists why card fences stayed text (`card <n>: <issue>`). */
export type DiscordParts = DiscordPart[] & { cardIssues?: readonly string[] };

/**
 * `renderDiscordParts` with cards: each valid ` ```card ` fence (see `splitCards`, at most `MAX_CARDS`) becomes a
 * message of its own in place, its embed from `cardToEmbed`; the text around it is split as usual. A fence that fails
 * validation or whose embed rendering throws stays text (a code block), its issues in `cardIssues`. The redelivered
 * line opens the first message and the footer closes the last, card or not. Without a valid card the result equals
 * `renderDiscordParts`.
 */
export function renderDiscordMessages(body: string, redelivered: boolean, footer?: string): DiscordParts {
	const issues: string[] = [];
	const prefix = redelivered ? `${REDELIVERED_PREFIX}\n` : "";
	const suffix = footer === undefined ? "" : `\n_${footer}_`;
	const limit = MESSAGE_CONTENT_LIMIT - prefix.length - suffix.length;
	const runs = cardRuns<{ embed: DiscordEmbed }>(body, issues, (json) => {
		const validated = validateCard(json);
		if (!validated.ok) return validated.issues;
		let embed: DiscordEmbed;
		try {
			embed = cardToEmbed(validated.card, validated.tone);
		} catch (err) {
			// A validated card the embed renderer still chokes on stays text, like an invalid one: the answer goes out.
			return [errorText(err)];
		}
		// A card with nothing to show (no title, text, fields or image) would be an empty message Discord refuses.
		return Object.keys(embed).every((key) => key === "color") ? ["the card has nothing to show"] : { embed };
	});
	const pieces = runs.flatMap(
		(run): Array<{ text: string } | { embed: DiscordEmbed }> =>
			run.kind === "card" ? [run] : chunkPlain(run.text, limit).map((text) => ({ text })),
	);
	const parts: DiscordParts = pieces.some((piece) => "embed" in piece)
		? pieces.map((piece, i) => {
				const head = i === 0 ? prefix : "";
				const tail = i === pieces.length - 1 ? suffix : "";
				return "embed" in piece
					? { content: `${head}${tail}`.trim(), embeds: [piece.embed] }
					: { content: `${head}${piece.text}${tail}` };
			})
		: renderDiscordParts(body, redelivered, footer).map((content) => ({ content }));
	if (issues.length > 0) parts.cardIssues = issues;
	return parts;
}
