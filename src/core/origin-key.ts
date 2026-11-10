// The one place that reads chat origin keys. Keys are built with `chatOriginKey` and otherwise treated as opaque
// strings; anything that needs the platform, conversation or thread of a key asks `parseChatOrigin`.

export type ChatPlatform = "slack" | "telegram" | "discord";

export interface ChatOriginRef {
	platform: ChatPlatform;
	/** `dm`: a direct conversation with the owner; `ch`: a channel or group. */
	kind: "dm" | "ch";
	conversationId: string;
	/** Thread inside the conversation (Slack root ts, Telegram forum topic, Discord thread). */
	threadId?: string;
}

/**
 * Exact id grammar per platform, the only definition of it. Slack ids start with an upper-case letter (`C…`, `D…`,
 * `G…`, `U…`) and run on alphanumeric, with `<sec>.<usec>` thread ts; Telegram group chat ids are negative
 * (`-100…`); Discord ids are snowflakes (digits only), so a Slack id and a Discord id never look alike.
 */
export const GRAMMAR: Readonly<Record<ChatPlatform, { readonly conversation: RegExp; readonly thread: RegExp }>> = {
	slack: { conversation: /^[A-Z][A-Z0-9]+$/, thread: /^[0-9.]+$/ },
	telegram: { conversation: /^-?[0-9]+$/, thread: /^[0-9]+$/ },
	discord: { conversation: /^[0-9]+$/, thread: /^[0-9]+$/ },
};

const isChatPlatform = (value: string | undefined): value is ChatPlatform =>
	value !== undefined && Object.hasOwn(GRAMMAR, value);

/**
 * Platforms a bare conversation id tells apart. Telegram is left out: its private chat ids are digits like Discord's,
 * so it will need an explicit platform on the ledger rows instead.
 */
export type IdPlatform = "slack" | "discord";
const ID_PLATFORMS: readonly IdPlatform[] = ["slack", "discord"];

/**
 * Platform of a conversation id met without an origin key (a delivery's thread ref, an approval card's channel), read
 * with GRAMMAR's own conversation pattern so it never disagrees with `parseChatOrigin`; `undefined` when no platform's
 * grammar accepts it.
 */
export function platformOfConversationId(id: string): IdPlatform | undefined {
	return ID_PLATFORMS.find((platform) => GRAMMAR[platform].conversation.test(id));
}

/**
 * Platform whose namespace `key` lives in (`slack/…`, `telegram/…`, `discord/…`), whether or not the rest is
 * well-formed; `undefined` for every other namespace. For "is this a chat surface" checks that must not depend on
 * the exact id grammar.
 */
export function chatPlatformOf(key: string): ChatPlatform | undefined {
	const slash = key.indexOf("/");
	const head = slash < 0 ? undefined : key.slice(0, slash);
	return isChatPlatform(head) ? head : undefined;
}

/**
 * `<platform>/<dm|ch>/<conversationId>[/t/<threadId>]` → its parts; `undefined` for every other key (monitors, work
 * lanes, malformed keys). Only the exact grammar is accepted: nothing is guessed or repaired.
 */
export function parseChatOrigin(key: string): ChatOriginRef | undefined {
	const parts = key.split("/");
	if (parts.length !== 3 && parts.length !== 5) return undefined;
	const [platform, kind, conversationId, marker, threadId] = parts;
	if (!isChatPlatform(platform) || (kind !== "dm" && kind !== "ch") || conversationId === undefined) return undefined;
	const grammar = GRAMMAR[platform];
	if (!grammar.conversation.test(conversationId)) return undefined;
	if (parts.length === 3) return { platform, kind, conversationId };
	if (marker !== "t" || threadId === undefined || !grammar.thread.test(threadId)) return undefined;
	return { platform, kind, conversationId, threadId };
}

/** The key of `ref`; the inverse of `parseChatOrigin`. */
export function chatOriginKey(ref: ChatOriginRef): string {
	const base = `${ref.platform}/${ref.kind}/${ref.conversationId}`;
	return ref.threadId === undefined ? base : `${base}/t/${ref.threadId}`;
}
