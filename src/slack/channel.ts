import type { ChannelPort, MessageRef, OutboundMessage, PostTarget } from "../channel/port";
import type { SlackTransport } from "./transport";

/**
 * Block Kit for a message with buttons: the text section, the buttons, and the optional note as a context line.
 * No `buttons` → no blocks at all (plain text message); `[]` → `blocks: []`, which removes earlier buttons.
 */
function blocksOf(msg: OutboundMessage): readonly unknown[] | undefined {
	if (msg.buttons === undefined) return undefined;
	if (msg.buttons.length === 0) return [];
	return [
		{ type: "section", text: { type: "mrkdwn", text: msg.text } },
		{
			type: "actions",
			elements: msg.buttons.map((button) => ({
				type: "button",
				...(button.style === undefined ? {} : { style: button.style }),
				text: { type: "plain_text", text: button.label },
				action_id: button.actionId,
				...(button.value === undefined ? {} : { value: button.value }),
			})),
		},
		...(msg.buttonsNote === undefined
			? []
			: [{ type: "context", elements: [{ type: "mrkdwn", text: msg.buttonsNote }] }]),
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
