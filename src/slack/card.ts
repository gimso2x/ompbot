/**
 * json-render card specs (` ```card ` fences in an answer) as Slack Block Kit messages.
 *
 * `cardToBlocks`/`cardFallbackText` and their helpers are adapted from the card path of `dist/blocks.js` in
 * `@chat-adapter/slack` 4.44.0 (npm, MIT License, Copyright (c) 2026 Vercel, Inc.): header, section, fields, divider,
 * image, link, table/data_table, data_visualization and their over-limit code-block fallbacks. Not carried over:
 * buttons, selects, actions, and emoji placeholder conversion (identity here). The package itself is not a dependency.
 */
import type { CardChild } from "chat";
import { type CardElement, type CardTone, chartToAscii, tableToAscii, validateCard } from "../channel/card";
import { cutCodePointSafe } from "../channel/text";

export type SlackBlock = Record<string, unknown>;

type TableChild = Extract<CardChild, { type: "table" }>;
type ChartChild = Extract<CardChild, { type: "chart" }>;
type TextChild = Extract<CardChild, { type: "text" }>;
type FieldsChild = Extract<CardChild, { type: "fields" }>;

/** Slack's 50 blocks per message minus the redelivered, `🔔` and footer context blocks a card part may carry. */
export const CARD_MAX_BLOCKS = 47;

/** Block Kit limits the converter applies (subset of `@chat-adapter/slack` LIMITS). */
const LIMITS = {
	chartDataPoints: 20,
	chartLabel: 20,
	chartsPerMessage: 2,
	chartSegments: 12,
	chartSeries: 12,
	chartTitle: 50,
	fields: 10,
	fieldText: 2000,
	headerText: 150,
	imageAlt: 2000,
	imageUrl: 3000,
	sectionText: 3000,
	tableChars: 10_000,
	tableColumns: 20,
	tablePageSize: 100,
	tableRows: 100,
	textObject: 3000,
};
const EMPTY_TEXT = " ";

export type ParsedCard =
	| { ok: true; card: CardElement; blocks: SlackBlock[]; tone?: CardTone }
	| { ok: false; issues: string[] };

/**
 * A card fence's JSON as a validated card and its blocks; never throws. Bad JSON, a `CardSpecError` and a card over
 * `CARD_MAX_BLOCKS` blocks come back as `issues`. `charts: false` draws charts as ASCII code blocks.
 */
export function parseCard(json: string, options: { charts: boolean } = { charts: true }): ParsedCard {
	const validated = validateCard(json);
	if (!validated.ok) return validated;
	const { card, tone } = validated;
	try {
		const blocks = cardToBlocks(card, options);
		if (blocks.length > CARD_MAX_BLOCKS) {
			return { ok: false, issues: [`the card needs ${blocks.length} blocks, at most ${CARD_MAX_BLOCKS}`] };
		}
		return tone === undefined ? { ok: true, card, blocks } : { ok: true, card, blocks, tone };
	} catch (err) {
		return { ok: false, issues: [err instanceof Error ? err.message : String(err)] };
	}
}

interface ConvertState {
	charts: boolean;
	chartCount: number;
	usedTable: boolean;
}

/** The card as Block Kit blocks; `charts: false` draws every chart as an ASCII code block. */
export function cardToBlocks(card: CardElement, options: { charts: boolean } = { charts: true }): SlackBlock[] {
	const blocks: SlackBlock[] = [];
	const state: ConvertState = { charts: options.charts, chartCount: 0, usedTable: false };
	if (card.title) blocks.push({ text: plainText(card.title, LIMITS.headerText), type: "header" });
	if (card.subtitle) blocks.push({ elements: [mrkdwn(card.subtitle, LIMITS.textObject)], type: "context" });
	if (card.imageUrl) {
		blocks.push({
			alt_text: truncateText(card.title || "Card image", LIMITS.imageAlt),
			image_url: truncateText(card.imageUrl, LIMITS.imageUrl),
			type: "image",
		});
	}
	for (const child of card.children) blocks.push(...childToBlocks(child, state));
	return blocks;
}

/** mrkdwn text of the card for notifications and block-less clients; never empty. */
export function cardFallbackText(card: CardElement): string {
	const lines: string[] = [];
	if (card.title) lines.push(`*${card.title}*`);
	if (card.subtitle) lines.push(card.subtitle);
	for (const child of card.children) {
		const text = childToFallbackText(child);
		if (text) lines.push(text);
	}
	return lines.join("\n") || "(카드)";
}

function childToBlocks(child: CardChild, state: ConvertState): SlackBlock[] {
	switch (child.type) {
		case "chart":
			return [chartToBlock(child, state)];
		case "divider":
			return [{ type: "divider" }];
		case "fields":
			return fieldsToBlocks(child);
		case "image":
			return [
				{
					alt_text: truncateText(child.alt || "Image", LIMITS.imageAlt),
					image_url: truncateText(child.url, LIMITS.imageUrl),
					type: "image",
				},
			];
		case "link":
			return [{ text: mrkdwn(`<${child.url}|${child.label}>`, LIMITS.sectionText), type: "section" }];
		case "section":
			return child.children.flatMap((nested) => childToBlocks(nested, state));
		case "table":
			return tableToBlocks(child, state);
		case "text":
			return [textToBlock(child)];
		default:
			// Actions and inputs are not in CARD_COMPONENTS, so toCard never produces them.
			throw new Error(`unsupported card element: ${child.type}`);
	}
}

function markdownBoldToSlackMrkdwn(markdown: string): string {
	return markdown.replace(/\*\*(.+?)\*\*/g, "*$1*");
}

function textToBlock(element: TextChild): SlackBlock {
	const text = markdownBoldToSlackMrkdwn(element.content);
	if (element.style === "muted") return { elements: [mrkdwn(text, LIMITS.textObject)], type: "context" };
	return { text: mrkdwn(element.style === "bold" ? `*${text}*` : text, LIMITS.sectionText), type: "section" };
}

/** One section per 10 fields (Slack's per-section limit), so no field is dropped. */
function fieldsToBlocks(element: FieldsChild): SlackBlock[] {
	const fields = element.children.map((field) =>
		mrkdwn(`*${markdownBoldToSlackMrkdwn(field.label)}*\n${markdownBoldToSlackMrkdwn(field.value)}`, LIMITS.fieldText),
	);
	const blocks: SlackBlock[] = [];
	for (let i = 0; i < fields.length; i += LIMITS.fields)
		blocks.push({ fields: fields.slice(i, i + LIMITS.fields), type: "section" });
	return blocks.length > 0 ? blocks : [{ fields: [], type: "section" }];
}

function tableToBlocks(element: TableChild, state: ConvertState): SlackBlock[] {
	const cellCharCount = [element.headers, ...element.rows].flat().reduce((total, cell) => total + cell.length, 0);
	if (
		state.usedTable ||
		element.rows.length + 1 > LIMITS.tableRows ||
		element.headers.length > LIMITS.tableColumns ||
		cellCharCount > LIMITS.tableChars
	) {
		return [{ text: fencedFallbackText(tableToAscii(element)), type: "section" }];
	}
	state.usedTable = true;
	const rows = [element.headers.map(rawText), ...element.rows.map((row) => row.map(rawText))];
	if (element.rows.length === 0) {
		return [
			compact({
				column_settings: element.align?.slice(0, LIMITS.tableColumns).map((align) => (align ? { align } : null)),
				rows,
				type: "table",
			}),
		];
	}
	return [
		compact({
			caption: element.caption || "Table",
			page_size:
				element.pageSize === undefined
					? undefined
					: Math.min(LIMITS.tablePageSize, Math.max(1, Math.floor(element.pageSize))),
			rows,
			type: "data_table",
		}),
	];
}

function chartToBlock(element: ChartChild, state: ConvertState): SlackBlock {
	const block = state.charts && state.chartCount < LIMITS.chartsPerMessage ? chartToDataVisualization(element) : null;
	if (block) {
		state.chartCount += 1;
		return block;
	}
	return { text: fencedFallbackText(chartToAscii(element)), type: "section" };
}

function fencedFallbackText(content: string): SlackBlock {
	const fence = (body: string) => `\`\`\`\n${body}\n\`\`\``;
	const budget = LIMITS.sectionText - fence("").length;
	const text = content.length > budget ? fence(`${content.slice(0, budget - 1)}\u2026`) : fence(content);
	return { text, type: "mrkdwn" };
}

function isValidChartLabel(label: string): boolean {
	return label.length >= 1 && label.length <= LIMITS.chartLabel;
}

function chartToDataVisualization(element: ChartChild): SlackBlock | null {
	const title = element.title;
	if (title.length === 0 || title.length > LIMITS.chartTitle) return null;
	const { chart } = element;
	if (chart.type === "pie") {
		const validSegments =
			chart.segments.length >= 1 &&
			chart.segments.length <= LIMITS.chartSegments &&
			chart.segments.every((segment) => isValidChartLabel(segment.label) && segment.value > 0);
		if (!validSegments) return null;
		return {
			chart: {
				segments: chart.segments.map((segment) => ({ label: segment.label, value: segment.value })),
				type: "pie",
			},
			title,
			type: "data_visualization",
		};
	}
	const { categories, series } = chart;
	const validShape =
		categories.length >= 1 &&
		categories.length <= LIMITS.chartDataPoints &&
		categories.every(isValidChartLabel) &&
		new Set(categories).size === categories.length &&
		series.length >= 1 &&
		series.length <= LIMITS.chartSeries &&
		series.every((s) => isValidChartLabel(s.name)) &&
		new Set(series.map((s) => s.name)).size === series.length &&
		(chart.xLabel === undefined || chart.xLabel.length <= LIMITS.chartTitle) &&
		(chart.yLabel === undefined || chart.yLabel.length <= LIMITS.chartTitle);
	if (!validShape) return null;
	const normalizedSeries: Array<{ data: Array<{ label: string; value: number }>; name: string }> = [];
	for (const s of series) {
		if (s.data.length !== categories.length) return null;
		const byLabel = new Map(s.data.map((point) => [point.label, point]));
		const data: Array<{ label: string; value: number }> = [];
		for (const category of categories) {
			const point = byLabel.get(category);
			if (!point) return null;
			data.push({ label: category, value: point.value });
		}
		normalizedSeries.push({ data, name: s.name });
	}
	return {
		chart: {
			axis_config: compact({ categories, x_label: chart.xLabel, y_label: chart.yLabel }),
			series: normalizedSeries,
			type: chart.type,
		},
		title,
		type: "data_visualization",
	};
}

function childToFallbackText(child: CardChild): string | undefined {
	switch (child.type) {
		case "chart":
			return chartToAscii(child);
		case "divider":
			return "---";
		case "fields":
			return child.children.map((field) => `${field.label}: ${field.value}`).join("\n");
		case "image":
			return child.alt || undefined;
		case "link":
			return `${child.label} (${child.url})`;
		case "section":
			return child.children
				.map(childToFallbackText)
				.filter((value) => Boolean(value))
				.join("\n");
		case "table":
			return tableToAscii(child);
		case "text":
			return child.content;
		default:
			return undefined;
	}
}

function mrkdwn(text: string, maxLength: number): { text: string; type: "mrkdwn" } {
	return { text: nonemptyText(truncateText(text, maxLength)), type: "mrkdwn" };
}

function plainText(text: string, maxLength: number): { emoji: true; text: string; type: "plain_text" } {
	return { emoji: true, text: nonemptyText(truncateText(text, maxLength)), type: "plain_text" };
}

function rawText(text: string): { text: string; type: "raw_text" } {
	return { text: nonemptyText(text), type: "raw_text" };
}

function truncateText(text: string, maxLength: number): string {
	return cutCodePointSafe(text, maxLength);
}

function nonemptyText(text: string): string {
	return text.length > 0 ? text : EMPTY_TEXT;
}

function compact(value: Record<string, unknown>): SlackBlock {
	const output: SlackBlock = {};
	for (const [key, item] of Object.entries(value)) {
		if (item !== undefined) output[key] = item;
	}
	return output;
}
