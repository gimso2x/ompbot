// Core code names reactions the Slack way (`eyes`, `white_check_mark`); Discord takes the unicode emoji itself.

/** Every Slack emoji name the core sends as a reaction (adapter 👀 and final marks, task status reactions). */
const SLACK_TO_UNICODE: ReadonlyMap<string, string> = new Map([
	["eyes", "👀"],
	["white_check_mark", "✅"],
	["x", "❌"],
	["warning", "⚠️"],
	["hourglass_flowing_sand", "⏳"],
	["mag", "🔍"],
	["construction", "🚧"],
]);

/** Feedback reactions read back as the Slack names `FEEDBACK_REACTIONS` knows. */
const FEEDBACK_TO_SLACK: ReadonlyMap<string, string> = new Map([
	["👍", "+1"],
	["👎", "-1"],
]);

/** Variation selector 16 and skin-tone modifiers: Discord may or may not send them; names compare without them. */
const MODIFIERS = /[\uFE0F\u{1F3FB}-\u{1F3FF}]/gu;

const UNICODE_TO_SLACK: ReadonlyMap<string, string> = new Map(
	[...SLACK_TO_UNICODE].map(([name, unicode]) => [unicode.replace(MODIFIERS, ""), name]),
);

export class UnknownEmojiError extends Error {
	constructor(name: string) {
		super(`no discord emoji for slack name "${name}"`);
		this.name = "UnknownEmojiError";
	}
}

/** Unicode emoji for a Slack reaction name; a name outside the table throws instead of being skipped. */
export function toDiscordEmoji(name: string): string {
	const unicode = SLACK_TO_UNICODE.get(name);
	if (unicode === undefined) throw new UnknownEmojiError(name);
	return unicode;
}

/** Slack name of an inbound reaction emoji (`👍`→`+1`, `👎`→`-1`); `undefined` for emoji the bot does not read. */
export function fromDiscordEmoji(emoji: string | null): string | undefined {
	if (emoji === null) return undefined;
	const bare = emoji.replace(MODIFIERS, "");
	return FEEDBACK_TO_SLACK.get(bare) ?? UNICODE_TO_SLACK.get(bare);
}
