/**
 * json-render card specs (` ```card ` fences in an answer), the platform-neutral part: cutting an answer at its card
 * fences, validating one fence into a `CardElement`, and the ASCII forms of tables and charts. Each platform draws the
 * validated card its own way (Slack Block Kit in `src/slack/card.ts`, Discord embeds in `src/discord/card.ts`).
 */
import { CardSpecError, standardComponentDefinitions, toCard } from "@json-render/chat";
import type { CardChild, CardElement } from "chat";
import { isRecord } from "../omp/type-guards";

export type { CardElement } from "chat";

type ChartChild = Extract<CardChild, { type: "chart" }>;

/** The standard json-render components without `Actions`/`Button`: a model-made button must not reach `onAction`. */
const { Actions: _actions, Button: _button, ...CARD_COMPONENTS } = standardComponentDefinitions;

export { CARD_COMPONENTS };

/** Per-card limits the spec is validated against (Slack's, kept for every platform: 1 table, 2 charts). */
export const CARD_LIMITS = { tables: 1, charts: 2, tableRows: 100, chartLabel: 20, chartTitle: 50 } as const;

/** Card fences one answer turns into card parts at most; later ones stay text. */
export const MAX_CARDS = 3;

export type CardSegment = { kind: "text"; text: string } | { kind: "card"; json: string; raw: string };

const CLOSING_FENCE = /^```\s*$/;

/**
 * The body cut at its ` ```card ` fences: one opening a line and closed by a ` ``` ` line. A ` ```card ` inside another
 * fence, an unclosed one and any after the first `MAX_CARDS` stay text. Joining every segment's `text`/`raw` with
 * "\n" gives the body back byte for byte.
 */
export function splitCards(body: string): CardSegment[] {
	const lines = body.split("\n");
	const segments: CardSegment[] = [];
	let text: string[] = [];
	let inFence = false;
	let cards = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (inFence) {
			text.push(line);
			if (CLOSING_FENCE.test(line)) inFence = false;
			continue;
		}
		if (cards < MAX_CARDS && /^```card\s*$/.test(line)) {
			const close = lines.findIndex((next, j) => j > i && CLOSING_FENCE.test(next));
			if (close > i) {
				if (text.length > 0) segments.push({ kind: "text", text: text.join("\n") });
				text = [];
				segments.push({
					kind: "card",
					json: lines.slice(i + 1, close).join("\n"),
					raw: lines.slice(i, close + 1).join("\n"),
				});
				cards += 1;
				i = close;
				continue;
			}
		}
		if (line.startsWith("```")) inFence = true;
		text.push(line);
	}
	if (text.length > 0) segments.push({ kind: "text", text: text.join("\n") });
	return segments;
}

export type ValidatedCard = { ok: true; card: CardElement } | { ok: false; issues: string[] };

/**
 * Light repair before validation: an element without `children` gets `[]`, without `props` `{}`; a spec without
 * `root` whose elements hold exactly one `Card` gets that key as root. Nothing else is touched.
 */
function repairSpec(spec: Record<string, unknown>): void {
	const elements = spec.elements;
	if (!isRecord(elements)) return;
	for (const element of Object.values(elements)) {
		if (!isRecord(element)) continue;
		element.children ??= [];
		element.props ??= {};
	}
	if (spec.root === undefined) {
		const cards = Object.entries(elements).filter(([, element]) => isRecord(element) && element.type === "Card");
		if (cards.length === 1) spec.root = cards[0]?.[0];
	}
}

/** A card fence's JSON as a validated card; never throws. Bad JSON and a `CardSpecError` come back as `issues`. */
export function validateCard(json: string): ValidatedCard {
	let spec: unknown;
	try {
		spec = JSON.parse(json);
	} catch (err) {
		return { ok: false, issues: [`JSON: ${err instanceof Error ? err.message : String(err)}`] };
	}
	if (!isRecord(spec) || Array.isArray(spec))
		return { ok: false, issues: ["spec must be a JSON object with root and elements"] };
	repairSpec(spec);
	try {
		// The spec's shape is checked by toCard itself (zod catalog and structure validation).
		const card = toCard(spec as unknown as Parameters<typeof toCard>[0], {
			components: CARD_COMPONENTS,
			limits: CARD_LIMITS,
		});
		return { ok: true, card };
	} catch (err) {
		if (err instanceof CardSpecError) return { ok: false, issues: [...err.issues] };
		return { ok: false, issues: [err instanceof Error ? err.message : String(err)] };
	}
}

/** A fixed-width table: columns padded to their widest cell, ` | ` between them. */
export function tableToAscii(table: { headers: readonly string[]; rows: ReadonlyArray<readonly string[]> }): string {
	const rows = [table.headers, ...table.rows];
	const widths = table.headers.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0)));
	return rows
		.map((row) =>
			row
				.map((cell, column) => (cell ?? "").padEnd(widths[column] ?? 0))
				.join(" | ")
				.trimEnd(),
		)
		.join("\n");
}

/** A chart as its title over an ASCII table of its values (pie: label/value; others: one column per series). */
export function chartToAscii(element: ChartChild): string {
	const { chart, title } = element;
	if (chart.type === "pie") {
		const table = tableToAscii({
			headers: ["Label", "Value"],
			rows: chart.segments.map((segment) => [segment.label, String(segment.value)]),
		});
		return `${title}\n${table}`;
	}
	const table = tableToAscii({
		headers: [chart.xLabel ?? "", ...chart.series.map((s) => s.name)],
		rows: chart.categories.map((category) => [
			category,
			...chart.series.map((s) => {
				const point = s.data.find((p) => p.label === category);
				return point ? String(point.value) : "";
			}),
		]),
	});
	return `${title}\n${table}`;
}
