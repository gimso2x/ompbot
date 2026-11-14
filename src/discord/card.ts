// Cards on Discord are embeds: a validated ```card fence (here) and an OutboundMessage card (`DiscordChannel`) both
// become one embed, cut to Discord's embed limits instead of being refused (doc/plans/discord-channel.md §10).
import type { CardChild } from "chat";
import { type CardElement, type CardTone, chartToAscii, tableToAscii, toneColorInt } from "../channel/card";
import { cutCodePointSafe } from "../channel/text";

/** Embed limits (Embed Limits table): title, description, field count, field name and value, all text together. */
export const EMBED_LIMITS = {
	title: 256,
	description: 4096,
	fields: 25,
	fieldName: 256,
	fieldValue: 1024,
	total: 6000,
};

export interface DiscordEmbedField {
	name: string;
	value: string;
	inline?: boolean;
}

export interface DiscordEmbed {
	title?: string;
	description?: string;
	fields?: DiscordEmbedField[];
	image?: { url: string };
	/** The colour bar on the embed's left edge (a card's `tone`). */
	color?: number;
}

/** A field name or value Discord requires non-empty: a zero-width space stands in. */
const EMPTY = "\u200b";

/** `text` cut to `limit`; a code fence the cut leaves open is closed inside the limit. */
function cutFenced(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const balanced = (part: string): boolean => (part.match(/^```/gm) ?? []).length % 2 === 0;
	const cut = cutCodePointSafe(text, limit);
	if (balanced(cut)) return cut;
	const shorter = cutCodePointSafe(text, limit - 4);
	return balanced(shorter) ? shorter : `${shorter}\n\`\`\``;
}

/**
 * The embed within every limit: each value cut, fields capped at 25, then the whole kept under 6000 characters.
 * `image` and `color` pass unchanged.
 */
export function fitEmbed(embed: DiscordEmbed): DiscordEmbed {
	const title =
		embed.title === undefined || embed.title === "" ? undefined : cutCodePointSafe(embed.title, EMBED_LIMITS.title);
	const description =
		embed.description === undefined || embed.description.trim() === ""
			? undefined
			: cutFenced(embed.description, EMBED_LIMITS.description);
	const fields = (embed.fields ?? []).slice(0, EMBED_LIMITS.fields).map((field) => ({
		name: cutCodePointSafe(field.name || EMPTY, EMBED_LIMITS.fieldName),
		value: cutCodePointSafe(field.value || EMPTY, EMBED_LIMITS.fieldValue),
		...(field.inline === undefined ? {} : { inline: field.inline }),
	}));
	const fieldsLength = () => fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
	const over = () => (title?.length ?? 0) + (description?.length ?? 0) + fieldsLength() - EMBED_LIMITS.total;
	// Over the total: the last fields give way (title and description alone stay under it).
	while (over() > 0 && fields.length > 0) fields.pop();
	return {
		...(title === undefined ? {} : { title }),
		...(description === undefined ? {} : { description }),
		...(fields.length === 0 ? {} : { fields }),
		...(embed.image === undefined ? {} : { image: embed.image }),
		...(embed.color === undefined ? {} : { color: embed.color }),
	};
}

/** Discord's small grey line (`-# `) on every line of `text`. */
export function subtext(text: string): string {
	return text
		.split("\n")
		.map((line) => (line.trim() === "" ? line : `-# ${line}`))
		.join("\n");
}

/** `text` in a fence one backtick longer than its longest run (at least 3), so a ``` inside cannot close it. */
const codeBlock = (text: string): string => {
	const fence = "`".repeat(Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length)) + 1);
	return `${fence}\n${text}\n${fence}`;
};

/** One card child as description lines; fields and the first image go to the embed itself. */
function childLines(child: CardChild, embed: { fields: DiscordEmbedField[]; image?: { url: string } }): string[] {
	switch (child.type) {
		case "text":
			return [
				child.style === "bold"
					? `**${child.content}**`
					: child.style === "muted"
						? subtext(child.content)
						: child.content,
			];
		case "fields":
			for (const field of child.children) embed.fields.push({ name: field.label, value: field.value, inline: true });
			return [];
		case "table":
			return [codeBlock(tableToAscii(child))];
		case "chart":
			return [codeBlock(chartToAscii(child))];
		case "divider":
			return [""];
		case "image":
			if (embed.image === undefined) {
				embed.image = { url: child.url };
				return [];
			}
			return [`[${child.alt || "image"}](${child.url})`];
		case "link":
			return [`[${child.label}](${child.url})`];
		case "section":
			return child.children.flatMap((nested) => childLines(nested, embed));
		default:
			// Actions and inputs are not in CARD_COMPONENTS, so a validated card never holds them.
			return [];
	}
}

/**
 * A validated card as one embed: Text → description, Fields → fields, Table/Chart → ASCII code blocks, Image → image,
 * `tone` → the embed's colour.
 */
export function cardToEmbed(card: CardElement, tone?: CardTone): DiscordEmbed {
	const parts: { fields: DiscordEmbedField[]; image?: { url: string } } = {
		fields: [],
		...(card.imageUrl ? { image: { url: card.imageUrl } } : {}),
	};
	const lines = [
		...(card.subtitle ? [subtext(card.subtitle)] : []),
		...card.children.flatMap((child) => childLines(child, parts)),
	];
	return fitEmbed({
		...(card.title ? { title: card.title } : {}),
		description: lines.join("\n"),
		fields: parts.fields,
		...(parts.image === undefined ? {} : { image: parts.image }),
		...(tone === undefined ? {} : { color: toneColorInt(tone) }),
	});
}
