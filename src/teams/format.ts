// Teams text in and out. Out: the core writes Slack mrkdwn; Teams reads `textFormat: "markdown"` with the same `**bold**`
// and `[label](url)` Discord uses, so the Discord conversion serves. Cards and tables stay code blocks (no Adaptive
// Cards in this scope). In: `<at>…</at>` mention tags are cut out and the few HTML entities Teams writes undone.
import type { OutboundMessage } from "../channel/port";
import { chunkText, cutCodePointSafe, REDELIVERED_PREFIX } from "../channel/text";
import { unicodeOfSlackName } from "../discord/emoji";
import { mrkdwnToDiscord, outsideCode } from "../discord/format";

/**
 * Characters per Teams message. Teams refuses an Activity near 28 KB; 7000 UTF-16 units stay under it even when every
 * one is a 3-byte character. Not measured against the live service (doc/plans/teams-channel.md 확인 필요).
 */
const TEAMS_TEXT_LIMIT = 7000;

/** Slack mrkdwn → Teams markdown; Slack emoji codes the core writes (`:white_check_mark:`) become the emoji itself. */
function teamsMarkdown(text: string): string {
	return outsideCode(mrkdwnToDiscord(text), (plain) =>
		plain.replace(/:([a-z0-9_+-]+):/g, (code, name: string) => unicodeOfSlackName(name) ?? code),
	);
}

/**
 * One delivery body as Teams messages of at most `TEAMS_TEXT_LIMIT`, code fences closed in each; a redelivered answer
 * is marked in its first part and `footer` (elapsed time, tool count) closes the last one.
 */
export function renderTeamsParts(body: string, redelivered: boolean, footer?: string): string[] {
	const prefix = redelivered ? `${REDELIVERED_PREFIX}\n` : "";
	const suffix = footer === undefined ? "" : `\n\n*${footer}*`;
	const parts = chunkText(teamsMarkdown(body), TEAMS_TEXT_LIMIT - prefix.length - suffix.length);
	return parts.map((part, i) => `${i === 0 ? prefix : ""}${part}${i === parts.length - 1 ? suffix : ""}`);
}

/**
 * A port message (notice, approval card) as one Teams text: title, body, fields, and buttons as the words to answer
 * with — Teams gets no buttons here, so a card is answered in text.
 */
export function renderOutboundText(msg: OutboundMessage): string {
	const lines: string[] = [];
	if (msg.title !== undefined) lines.push(`*${msg.title}*`);
	lines.push(msg.body ?? msg.text);
	for (const field of msg.fields ?? []) lines.push(`*${field.label}*: ${field.value}`);
	const buttons = msg.buttons ?? [];
	if (buttons.length > 0) lines.push(`선택지: ${buttons.map((button) => button.label).join(" · ")}`);
	if (msg.buttonsNote !== undefined && (buttons.length > 0 || msg.title !== undefined)) lines.push(msg.buttonsNote);
	return cutCodePointSafe(teamsMarkdown(lines.join("\n")), TEAMS_TEXT_LIMIT);
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'" };

/** An inbound message text without its `<at>…</at>` mention tags, entities undone, trimmed. */
export function stripMentions(text: string): string {
	return text
		.replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, " ")
		.replace(/&(nbsp|amp|lt|gt|quot|#39|apos);/g, (_, name: string) => ENTITIES[name] ?? "")
		.trim();
}
