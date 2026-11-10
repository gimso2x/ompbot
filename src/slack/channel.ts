import type { ActionButton, ChannelPort, MessageRef, OutboundMessage, PostTarget } from "../channel/port";
import { cutCodePointSafe } from "../channel/text";
import type { SlackTransport } from "./transport";

/** Slack caps a `header` at 150 characters, a section field at 2,000 and a section at 10 fields. */
const HEADER_LIMIT = 150;
const FIELD_LIMIT = 2_000;
const MAX_FIELDS = 10;

function actionsBlock(buttons: readonly ActionButton[]): unknown {
	return {
		type: "actions",
		elements: buttons.map((button) => ({
			type: "button",
			...(button.style === undefined ? {} : { style: button.style }),
			text: { type: "plain_text", text: button.label },
			action_id: button.actionId,
			...(button.value === undefined ? {} : { value: button.value }),
		})),
	};
}

/**
 * Block Kit for a message with buttons: the text section, the buttons, and the optional note as a context line.
 * No `buttons` → no blocks at all (plain text message); `[]` → `blocks: []`, which removes earlier buttons.
 * A card (`title`, `body` or `fields` set) is header → section(body ?? text) → fields → buttons → note, each only when
 * present; `buttons: []` drops just the buttons, so the card keeps its title and fields after a decision.
 */
function blocksOf(msg: OutboundMessage): readonly unknown[] | undefined {
	const note =
		msg.buttonsNote === undefined ? [] : [{ type: "context", elements: [{ type: "mrkdwn", text: msg.buttonsNote }] }];
	if (msg.title === undefined && msg.body === undefined && msg.fields === undefined) {
		if (msg.buttons === undefined) return undefined;
		if (msg.buttons.length === 0) return [];
		return [{ type: "section", text: { type: "mrkdwn", text: msg.text } }, actionsBlock(msg.buttons), ...note];
	}
	const fields = (msg.fields ?? []).slice(0, MAX_FIELDS);
	return [
		...(msg.title === undefined
			? []
			: [
					{
						type: "header",
						text: { type: "plain_text", text: cutCodePointSafe(msg.title, HEADER_LIMIT), emoji: true },
					},
				]),
		{ type: "section", text: { type: "mrkdwn", text: msg.body ?? msg.text } },
		...(fields.length === 0
			? []
			: [
					{
						type: "section",
						fields: fields.map((field) => ({
							type: "mrkdwn",
							text: cutCodePointSafe(`*${field.label}*\n${field.value}`, FIELD_LIMIT),
						})),
					},
				]),
		...(msg.buttons === undefined || msg.buttons.length === 0 ? [] : [actionsBlock(msg.buttons)]),
		...note,
	];
}

/**
 * The Slack side of `ChannelPort`, a thin wrapper over `SlackTransport`: conversation = channel, message = ts,
 * thread = thread_ts. `transport` stays reachable for the Slack adapter's inbound side (socket, backfill), which is not
 * behind the port yet.
 */
export class SlackChannel implements ChannelPort {
	readonly platform = "slack";
	readonly capabilities = { permalink: true, reactions: true };

	constructor(readonly transport: SlackTransport) {}

	async post(target: PostTarget, msg: OutboundMessage): Promise<MessageRef> {
		const blocks = blocksOf(msg);
		const { ts } = await this.transport.postMessage({
			channel: target.conversationId,
			text: msg.text,
			...(target.threadId === undefined ? {} : { threadTs: target.threadId }),
			...(blocks === undefined ? {} : { blocks }),
		});
		return {
			platform: "slack",
			conversationId: target.conversationId,
			messageId: ts,
			...(target.threadId === undefined ? {} : { threadId: target.threadId }),
		};
	}

	async edit(ref: MessageRef, msg: OutboundMessage): Promise<void> {
		const blocks = blocksOf(msg);
		await this.transport.updateMessage({
			channel: ref.conversationId,
			ts: ref.messageId,
			text: msg.text,
			...(blocks === undefined ? {} : { blocks }),
		});
	}

	async react(ref: MessageRef, name: string, on: boolean): Promise<void> {
		const args = { channel: ref.conversationId, timestamp: ref.messageId, name };
		await (on ? this.transport.addReaction(args) : this.transport.removeReaction(args));
	}

	uploadFile(
		target: PostTarget,
		file: { path: string; title?: string; comment?: string },
	): Promise<{ fileId: string }> {
		return this.transport.uploadFile({
			channel: target.conversationId,
			...(target.threadId === undefined ? {} : { threadTs: target.threadId }),
			filePath: file.path,
			...(file.title === undefined ? {} : { title: file.title }),
			...(file.comment === undefined ? {} : { comment: file.comment }),
		});
	}

	permalink(ref: MessageRef): Promise<string> {
		return this.transport.getPermalink({ channel: ref.conversationId, ts: ref.messageId });
	}

	mentionUser(userId: string): string {
		return `<@${userId}>`;
	}
}
