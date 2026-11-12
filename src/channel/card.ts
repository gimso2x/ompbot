/**
 * json-render card specs (` ```card ` fences in an answer), the platform-neutral part: cutting an answer at its card
 * fences, validating one fence into a `CardElement`, and the ASCII forms of tables and charts. Each platform draws the
 * validated card its own way (Slack Block Kit in `src/slack/card.ts`, Discord embeds in `src/discord/card.ts`).
 */
import { CardSpecError, standardComponentDefinitions, toCard } from "@json-render/chat";
import type { CardChild, CardElement } from "chat";
import { isRecord } from "../omp/type-guards";
import { displayWidth } from "./text";

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
	/** Backtick run of the open fence (0 = none): only a run at least as long closes it, so ```` may quote ```. */
	let fenceRun = 0;
	let cards = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (fenceRun > 0) {
			text.push(line);
			const close = /^(`{3,})\s*$/.exec(line);
			if (close !== null && (close[1]?.length ?? 0) >= fenceRun) fenceRun = 0;
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
		if (line.startsWith("```")) fenceRun = /^`+/.exec(line)?.[0].length ?? 3;
		text.push(line);
	}
	if (text.length > 0) segments.push({ kind: "text", text: text.join("\n") });
	return segments;
}

/** A card's risk colour (root Card prop `tone`): Slack draws it as the attachment's colour bar, Discord as the embed's. */
export type CardTone = "ok" | "warn" | "danger" | "info";

/** The tone palette (Slack brand colours); Discord takes the same value as an integer (`toneColorInt`). */
export const CARD_TONE_COLORS: Readonly<Record<CardTone, string>> = {
	ok: "#2EB67D",
	warn: "#ECB22E",
	danger: "#E01E5A",
	info: "#36C5F0",
};

/** A tone's colour as the integer a Discord embed's `color` takes. */
export const toneColorInt = (tone: CardTone): number => Number.parseInt(CARD_TONE_COLORS[tone].slice(1), 16);

export type ValidatedCard = { ok: true; card: CardElement; tone?: CardTone } | { ok: false; issues: string[] };

/**
 * The root Card's `tone` prop, taken out of the spec before `toCard` (whose `buildCard` copies only title, subtitle
 * and imageUrl). A value outside the palette is dropped without an issue: the card goes out without a colour.
 */
function takeTone(spec: Record<string, unknown>): CardTone | undefined {
	const elements = spec.elements;
	if (!isRecord(elements) || typeof spec.root !== "string" || !Object.hasOwn(elements, spec.root)) return undefined;
	const root = elements[spec.root];
	if (!isRecord(root) || !isRecord(root.props) || !Object.hasOwn(root.props, "tone")) return undefined;
	const tone = root.props.tone;
	delete root.props.tone;
	return typeof tone === "string" && Object.hasOwn(CARD_TONE_COLORS, tone) ? (tone as CardTone) : undefined;
}

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

/**
 * The first top-level JSON object of `json` when only stray closing brackets follow it (a model that wrote one `}`
 * too many); undefined otherwise. Brackets inside strings are skipped.
 */
function withoutStrayClosers(json: string): string | undefined {
	const start = json.indexOf("{");
	if (start < 0) return undefined;
	let depth = 0;
	let inString = false;
	for (let i = start; i < json.length; i++) {
		const ch = json[i];
		if (inString) {
			if (ch === "\\") i++;
			else if (ch === '"') inString = false;
		} else if (ch === '"') inString = true;
		else if (ch === "{" || ch === "[") depth++;
		else if (ch === "}" || ch === "]") {
			depth--;
			if (depth === 0) {
				const rest = json.slice(i + 1);
				return /^[\s}\]]+$/.test(rest) ? json.slice(0, i + 1) : undefined;
			}
		}
	}
	return undefined;
}

/** Ids json-render would store with `out[id] = …`, where they hit the prototype instead of an own key. */
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);

/** The reserved ids the spec uses as its root, an element key or a child reference, each once in order. */
function reservedIds(spec: Record<string, unknown>): string[] {
	const elements = isRecord(spec.elements) ? spec.elements : {};
	const ids = [spec.root, ...Object.keys(elements)];
	for (const element of Object.values(elements))
		if (isRecord(element) && Array.isArray(element.children)) ids.push(...element.children);
	return [...new Set(ids.filter((id): id is string => typeof id === "string" && RESERVED_IDS.has(id)))];
}

/**
 * One issue per chart category given twice (sections searched too): every platform draws a chart's values by
 * category, so a repeated one would show the first value twice. Slack's chart block refuses it as well.
 */
function repeatedCategories(children: readonly CardChild[]): string[] {
	const issues: string[] = [];
	for (const child of children) {
		if (child.type === "section") issues.push(...repeatedCategories(child.children));
		if (child.type !== "chart" || child.chart.type === "pie") continue;
		const seen = new Set<string>();
		for (const category of child.chart.categories) {
			if (seen.has(category)) issues.push(`chart "${child.title}": category "${category}" is repeated`);
			seen.add(category);
		}
	}
	return issues;
}

/** A card fence's JSON as a validated card; never throws. Bad JSON and a `CardSpecError` come back as `issues`. */
export function validateCard(json: string): ValidatedCard {
	let spec: unknown;
	try {
		spec = JSON.parse(json);
	} catch (err) {
		const trimmed = withoutStrayClosers(json);
		try {
			if (trimmed === undefined) throw err;
			spec = JSON.parse(trimmed);
		} catch {
			return { ok: false, issues: [`JSON: ${err instanceof Error ? err.message : String(err)}`] };
		}
	}
	if (!isRecord(spec) || Array.isArray(spec))
		return { ok: false, issues: ["spec must be a JSON object with root and elements"] };
	repairSpec(spec);
	const reserved = reservedIds(spec);
	if (reserved.length > 0) return { ok: false, issues: reserved.map((id) => `element id "${id}" is reserved`) };
	const tone = takeTone(spec);
	try {
		// The spec's shape is checked by toCard itself (zod catalog and structure validation).
		const card = toCard(spec as unknown as Parameters<typeof toCard>[0], {
			components: CARD_COMPONENTS,
			limits: CARD_LIMITS,
		});
		const repeated = repeatedCategories(card.children);
		if (repeated.length > 0) return { ok: false, issues: repeated };
		return tone === undefined ? { ok: true, card } : { ok: true, card, tone };
	} catch (err) {
		// json-render measures titles and labels in UTF-16 units (an emoji counts 2) but calls them characters.
		if (err instanceof CardSpecError)
			return { ok: false, issues: err.issues.map((issue) => issue.replace(/ characters$/, " UTF-16 units")) };
		return { ok: false, issues: [err instanceof Error ? err.message : String(err)] };
	}
}

/** A fixed-width table: columns padded to their widest cell by display width (Hangul = 2), ` | ` between them. */
export function tableToAscii(table: { headers: readonly string[]; rows: ReadonlyArray<readonly string[]> }): string {
	const rows = [table.headers, ...table.rows];
	const widths = table.headers.map((_, column) => Math.max(...rows.map((row) => displayWidth(row[column] ?? ""))));
	return rows
		.map((row) =>
			row
				.map((cell, column) => {
					const text = cell ?? "";
					return text + " ".repeat(Math.max(0, (widths[column] ?? 0) - displayWidth(text)));
				})
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
