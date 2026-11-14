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

/** Unicode emoji for a Slack emoji name the core writes, `undefined` for any other name. */
export function unicodeOfSlackName(name: string): string | undefined {
	return SLACK_TO_UNICODE.get(name);
}
