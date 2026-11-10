// What the core may ask of a chat platform. Platform ids (Slack channel/ts, Telegram chat/message ids) only appear as
// opaque `conversationId`/`messageId`/`threadId` strings; each adapter maps them onto its own API.
import type { ChatPlatform } from "../core/origin-key";

export interface MessageRef {
	platform: ChatPlatform;
	conversationId: string;
	messageId: string;
	threadId?: string;
}

export interface PostTarget {
	conversationId: string;
	/** Absent: the conversation's main view. */
	threadId?: string;
}

export interface ActionButton {
	actionId: string;
	label: string;
	/** Payload the platform hands back with the click. */
	value?: string;
	style?: "primary" | "danger";
}

export interface OutboundMessage {
	/** The text as the core writes it today (Slack mrkdwn); P1 does no format conversion. */
	text: string;
	/** Buttons under the text. `[]` on an edit removes the buttons an earlier version had. */
	buttons?: readonly ActionButton[];
	/**
	 * One small line under the buttons (a deadline). A plain message shows it only together with buttons; a card
	 * (`title`/`body`/`fields`) shows it on its own too (the result line once the buttons are gone).
	 */
	buttonsNote?: string;
	/** Card title (Slack: a `header` block); a port without cards ignores it and `text` carries everything. */
	title?: string;
	/** Card body in place of `text`, which then only serves notifications and clients that cannot show the card. */
	body?: string;
	/** Labelled values under the body (Slack: one section of `fields`). */
	fields?: ReadonlyArray<{ label: string; value: string }>;
}

export interface ChannelPort {
	readonly platform: ChatPlatform;
	readonly capabilities: { permalink: boolean; reactions: boolean };
	post(target: PostTarget, msg: OutboundMessage): Promise<MessageRef>;
	edit(ref: MessageRef, msg: OutboundMessage): Promise<void>;
	/** Adds (`on`) or removes one reaction emoji by name. */
	react(ref: MessageRef, name: string, on: boolean): Promise<void>;
	uploadFile(target: PostTarget, file: { path: string; title?: string; comment?: string }): Promise<{ fileId: string }>;
	/** Link to one message (a thread root links to its thread); `undefined` when the platform has none. */
	permalink(ref: MessageRef): Promise<string | undefined>;
	mentionUser(userId: string): string;
	/**
	 * Starts the thread of the message `ref` (its id becomes the thread id), for a platform whose replies do not open
	 * one by themselves (Discord). Absent where a reply to the message is already its thread (Slack).
	 */
	openThread?(ref: MessageRef, name: string): Promise<void>;
}

/**
 * Platform-neutral mention inside core text. Formatters that have no port at hand write it; `renderMentions` swaps it
 * for the port's own mention syntax right before the post.
 */
export const mentionToken = (userId: string): string => `{{mention:${userId}}}`;

const MENTION_TOKEN = /\{\{mention:([^{}\s]+)\}\}/g;

export function renderMentions(text: string, port: Pick<ChannelPort, "mentionUser">): string {
	return text.replace(MENTION_TOKEN, (_, userId: string) => port.mentionUser(userId));
}
