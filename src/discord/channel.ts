import { stat } from "node:fs/promises";
import type { ActionButton, ChannelPort, MessageRef, OutboundMessage, PostTarget } from "../channel/port";
import { cutCodePointSafe } from "../channel/text";
import { TOP_LEVEL_TS } from "../core/normalize";
import { type DiscordEmbed, fitEmbed, subtext } from "./card";
import { toDiscordEmoji } from "./emoji";
import { mrkdwnToDiscord } from "./format";
import {
	type AllowedMentions,
	DiscordCallError,
	type DiscordChannelInfo,
	type DiscordTransport,
	MESSAGE_CONTENT_LIMIT,
	type MessageReference,
	UPLOAD_LIMIT_BYTES,
} from "./transport";

/** Discord's "a thread has already been created for this message": the thread is there. */
export const THREAD_EXISTS = 160004;
/** PUBLIC_THREAD: what a thread started from a message in a text channel is. */
export const PUBLIC_THREAD = 11;
/** Discord's limit on a thread name. */
export const THREAD_NAME_MAX = 100;

/** Channel types of threads (announcement, public, private). */
const THREAD_TYPES: ReadonlySet<number> = new Set([10, 11, 12]);
/** Channel types of direct messages (DM, group DM). */
const DM_TYPES: ReadonlySet<number> = new Set([1, 3]);

/** Buttons per Action Row, label and custom_id lengths (Components Reference). */
const ROW_BUTTONS = 5;
const LABEL_MAX = 80;
const CUSTOM_ID_MAX = 100;
const BUTTON_STYLE = { primary: 1, danger: 4 } as const;
/** SECONDARY: a button without a style. */
const DEFAULT_STYLE = 2;

/**
 * Where a button's `value` is kept: Discord components carry only `custom_id`, so the value is stored under
 * `btn:<message id>:<custom_id>` while the buttons are up (the store's key-value table).
 */
export interface ButtonValueLedger {
	getCursor(key: string): string | undefined;
	setCursor(key: string, value: string): void;
	deleteCursor(key: string): void;
	listCursorKeys(prefix: string): string[];
}

const buttonKeyPrefix = (messageId: string): string => `btn:${messageId}:`;

/**
 * Action Rows (type 1) of at most five buttons (type 2). A custom_id Discord would refuse is an error before
 * anything is sent: cutting it would change which action a click names.
 */
export function buttonRows(buttons: readonly ActionButton[]): unknown[] {
	const rows: unknown[] = [];
	for (let start = 0; start < buttons.length; start += ROW_BUTTONS) {
		rows.push({
			type: 1,
			components: buttons.slice(start, start + ROW_BUTTONS).map((button) => {
				if (button.actionId.length === 0 || button.actionId.length > CUSTOM_ID_MAX) {
					throw new DiscordCallError(
						"definitive",
						`discord custom_id must be 1-${CUSTOM_ID_MAX} characters: ${button.actionId.slice(0, 40)}… (${button.actionId.length})`,
					);
				}
				return {
					type: 2,
					style: button.style === undefined ? DEFAULT_STYLE : BUTTON_STYLE[button.style],
					label: cutCodePointSafe(button.label, LABEL_MAX),
					custom_id: button.actionId,
				};
			}),
		});
	}
	return rows;
}

/** Where a post lands: a channel (a thread is one), optionally as a reply to a message in it. */
export interface Destination {
	channelId: string;
	messageReference?: MessageReference | undefined;
}

const isCard = (msg: OutboundMessage): boolean =>
	msg.title !== undefined || msg.body !== undefined || msg.fields !== undefined;

/**
 * An outbound message as Discord content and embeds (buttons go as components). A card (`title`, `body` or `fields`)
 * is one embed — title, body (else text) as the description, fields, the note as a small last line — with `text` as
 * the content, the line a notification shows. A plain message is its text, plus the note when it has buttons.
 */
export function messageOf(msg: OutboundMessage): { content: string; embeds?: DiscordEmbed[] } {
	if (isCard(msg)) {
		const note = msg.buttonsNote === undefined ? [] : [subtext(mrkdwnToDiscord(msg.buttonsNote))];
		const embed = fitEmbed({
			...(msg.title === undefined ? {} : { title: msg.title }),
			description: [mrkdwnToDiscord(msg.body ?? msg.text), ...note].join("\n"),
			fields: (msg.fields ?? []).map((field) => ({ name: field.label, value: mrkdwnToDiscord(field.value) })),
		});
		return { content: cutCodePointSafe(mrkdwnToDiscord(msg.text), MESSAGE_CONTENT_LIMIT), embeds: [embed] };
	}
	const lines = [
		mrkdwnToDiscord(msg.text),
		...(msg.buttonsNote !== undefined && (msg.buttons?.length ?? 0) > 0 ? [mrkdwnToDiscord(msg.buttonsNote)] : []),
	];
	return { content: cutCodePointSafe(lines.join("\n"), MESSAGE_CONTENT_LIMIT) };
}

/**
 * The Discord side of `ChannelPort` over `DiscordTransport`. Ids keep the core's shape: a conversation is the channel
 * (a server thread's parent), a thread id is the Discord thread (the id of the message it started from) — or, in a DM
 * or for a root command, the message the post replies to. It also keeps the channel cache the adapter shares.
 */
export class DiscordChannel implements ChannelPort {
	readonly platform = "discord";
	readonly transport: DiscordTransport;
	readonly #ownerUserId: string;
	/** Peer bots (`channels.discord.peerBots`): they listen for mentions only, so a mention of one must notify. */
	readonly #peerUserIds: readonly string[];
	/** `null`: Discord said there is no such channel (a message id taken for a thread). */
	readonly #channels = new Map<string, DiscordChannelInfo | null>();
	/** Channel each message is in, from posts and clicks: a message id alone does not say which thread holds it. */
	readonly #messageChannels = new Map<string, string>();
	#buttonValues: ButtonValueLedger | undefined;

	constructor(
		transport: DiscordTransport,
		options: { ownerUserId: string; peerBots?: ReadonlyArray<{ userId: string }> | undefined },
	) {
		this.transport = transport;
		this.#ownerUserId = options.ownerUserId;
		this.#peerUserIds = (options.peerBots ?? []).map((peer) => peer.userId);
	}

	/** Keeps button values in `ledger` from now on (the binding passes the store). */
	useButtonValues(ledger: ButtonValueLedger): void {
		this.#buttonValues = ledger;
	}

	/** The `value` the button `customId` of `messageId` was posted with; `undefined` when it had none. */
	buttonValue(messageId: string, customId: string): string | undefined {
		return this.#buttonValues?.getCursor(`${buttonKeyPrefix(messageId)}${customId}`);
	}

	/** Records the channel a message is in (a click names it), so later edits of that message go there. */
	rememberMessage(messageId: string, channelId: string): void {
		this.#messageChannels.set(messageId, channelId);
	}

	/** Replaces the stored values of `messageId`'s buttons with those of `buttons` (none: the keys go away). */
	#storeButtonValues(messageId: string, buttons: readonly ActionButton[]): void {
		const ledger = this.#buttonValues;
		if (ledger === undefined) return;
		const prefix = buttonKeyPrefix(messageId);
		for (const key of ledger.listCursorKeys(prefix)) ledger.deleteCursor(key);
		for (const button of buttons) {
			if (button.value !== undefined) ledger.setCursor(`${prefix}${button.actionId}`, button.value);
		}
	}

	/** Records what the adapter learnt without asking (an inbound DM, a thread it started). */
	remember(info: DiscordChannelInfo): void {
		this.#channels.set(info.id, info);
	}

	/** The channel behind `id`, cached; `undefined` when Discord has none (404 / Unknown Channel). Other errors throw. */
	async channelInfo(id: string): Promise<DiscordChannelInfo | undefined> {
		const known = this.#channels.get(id);
		if (known !== undefined) return known ?? undefined;
		try {
			const info = await this.transport.getChannel(id);
			this.#channels.set(id, info);
			return info;
		} catch (err) {
			if (err instanceof DiscordCallError && err.kind === "definitive" && err.status === 404) {
				this.#channels.set(id, null);
				return undefined;
			}
			throw err;
		}
	}

	/** Whether `conversationId` is known to be a DM (learnt from an inbound message or a lookup). */
	isDirect(conversationId: string): boolean {
		const info = this.#channels.get(conversationId);
		return info !== undefined && info !== null && DM_TYPES.has(info.type);
	}

	/**
	 * Where a post for `<conversationId>:<threadId>` goes: no thread (or `-`) → the channel itself; a thread → that
	 * thread channel; anything else (a DM message, a root command) → a reply to that message in the channel.
	 */
	async destination(conversationId: string, threadId?: string): Promise<Destination> {
		if (threadId === undefined || threadId === TOP_LEVEL_TS) return { channelId: conversationId };
		if (!this.isDirect(conversationId)) {
			const info = await this.channelInfo(threadId);
			if (info !== undefined && THREAD_TYPES.has(info.type)) return { channelId: threadId };
		}
		return { channelId: conversationId, messageReference: { messageId: threadId } };
	}

	/** The channel a message lives in: a thread's starter message stays in the parent, everything else in its thread. */
	async #messageChannel(ref: MessageRef): Promise<string> {
		const known = this.#messageChannels.get(ref.messageId);
		if (known !== undefined) return known;
		if (ref.threadId === undefined || ref.threadId === ref.messageId) return ref.conversationId;
		return (await this.destination(ref.conversationId, ref.threadId)).channelId;
	}

	/** No `@everyone`, role or user pings from content; only a mention of the owner or a peer bot notifies that user. */
	allowedMentions(content: string): AllowedMentions {
		const users = [this.#ownerUserId, ...this.#peerUserIds].filter(
			(id) => content.includes(`<@${id}>`) || content.includes(`<@!${id}>`),
		);
		return users.length > 0 ? { parse: [], users } : { parse: [] };
	}

	async post(target: PostTarget, msg: OutboundMessage): Promise<MessageRef> {
		const { content, embeds } = messageOf(msg);
		const buttons = msg.buttons ?? [];
		const components = buttons.length === 0 ? undefined : buttonRows(buttons);
		const destination = await this.destination(target.conversationId, target.threadId);
		const { id } = await this.transport.createMessage({
			channelId: destination.channelId,
			content,
			messageReference: destination.messageReference,
			allowedMentions: this.allowedMentions(content),
			...(embeds === undefined ? {} : { embeds }),
			...(components === undefined ? {} : { components }),
		});
		this.#messageChannels.set(id, destination.channelId);
		if (buttons.length > 0) this.#storeButtonValues(id, buttons);
		return {
			platform: "discord",
			conversationId: target.conversationId,
			messageId: id,
			...(target.threadId === undefined ? {} : { threadId: target.threadId }),
		};
	}

	async edit(ref: MessageRef, msg: OutboundMessage): Promise<void> {
		const { content, embeds } = messageOf(msg);
		// Like Slack's blocks: `buttons: []` removes earlier buttons, and so does a card redrawn without any.
		const buttons = msg.buttons ?? (isCard(msg) ? [] : undefined);
		const components = buttons === undefined ? undefined : buttonRows(buttons);
		await this.transport.editMessage({
			channelId: await this.#messageChannel(ref),
			messageId: ref.messageId,
			content,
			allowedMentions: this.allowedMentions(content),
			// Like Slack's `blocks: []` for a message redrawn plain with `buttons`: an earlier card's embed goes too.
			...(embeds !== undefined ? { embeds } : msg.buttons !== undefined ? { embeds: [] } : {}),
			...(components === undefined ? {} : { components }),
		});
		if (buttons !== undefined) this.#storeButtonValues(ref.messageId, buttons);
	}

	async react(ref: MessageRef, name: string, on: boolean): Promise<void> {
		const args = { channelId: await this.#messageChannel(ref), messageId: ref.messageId, emoji: toDiscordEmoji(name) };
		await (on ? this.transport.addReaction(args) : this.transport.removeReaction(args));
	}

	async uploadFile(
		target: PostTarget,
		file: { path: string; title?: string; comment?: string },
	): Promise<{ fileId: string }> {
		// Refused before any call: Discord would take the request and fail it whole.
		const { size } = await stat(file.path);
		if (size > UPLOAD_LIMIT_BYTES) {
			throw new DiscordCallError("definitive", `discord upload too large: ${size} bytes > 25 MiB`);
		}
		const destination = await this.destination(target.conversationId, target.threadId);
		const content =
			file.comment === undefined ? undefined : cutCodePointSafe(mrkdwnToDiscord(file.comment), MESSAGE_CONTENT_LIMIT);
		const { id } = await this.transport.uploadFile({
			channelId: destination.channelId,
			filePath: file.path,
			content,
			messageReference: destination.messageReference,
			allowedMentions: this.allowedMentions(content ?? ""),
		});
		return { fileId: id };
	}

	/**
	 * Starts the thread of `ref`'s message (a server channel message: the thread id is its id) and remembers it, so
	 * posts with `threadId` = that id go into it. A thread already started from it counts as started.
	 */
	async openThread(ref: MessageRef, name: string): Promise<void> {
		try {
			await this.transport.startThread({
				channelId: ref.conversationId,
				messageId: ref.messageId,
				name: cutCodePointSafe(name, THREAD_NAME_MAX),
			});
		} catch (err) {
			if (!(err instanceof DiscordCallError && err.code === THREAD_EXISTS)) throw err;
		}
		const parent = await this.channelInfo(ref.conversationId);
		this.remember({ id: ref.messageId, type: PUBLIC_THREAD, parentId: ref.conversationId, guildId: parent?.guildId });
	}

	/** `https://discord.com/channels/<guild|@me>/<channel>/<message>`; a thread's starter links into the thread. */
	async permalink(ref: MessageRef): Promise<string | undefined> {
		const conversation = await this.channelInfo(ref.conversationId);
		const guild = conversation?.guildId ?? "@me";
		const channel =
			ref.threadId !== undefined && ref.threadId === ref.messageId
				? (await this.destination(ref.conversationId, ref.threadId)).channelId
				: await this.#messageChannel(ref);
		return `https://discord.com/channels/${guild}/${channel}/${ref.messageId}`;
	}

	mentionUser(userId: string): string {
		return `<@${userId}>`;
	}
}
