// Teams as a `ChannelPort`: conversation ids are ledger aliases (`teams_conversations`), resolved here to the real
// conversation id and its Bot Connector service URL; a thread id is the original Activity id, which a post answers
// as its `replyToId`. Teams has no bot reactions, permalinks or (in this scope) file uploads.
import type { ChannelPort, MessageRef, OutboundMessage, PostTarget } from "../channel/port";
import type { TeamsConversation } from "../store/db";
import { renderOutboundText } from "./format";
import type { TeamsConnector } from "./transport";

/** Where the port reads and the adapter records the conversations behind aliases (the store). */
export interface TeamsConversations {
	teamsConversation(alias: string): TeamsConversation | undefined;
	upsertTeamsConversation(conversation: TeamsConversation): void;
	/** The owner wrote in that conversation now (a 1:1 then stays a notice-home candidate). */
	markTeamsOwnerSpoke(alias: string): void;
}

export class TeamsChannel implements ChannelPort {
	readonly platform = "teams" as const;
	readonly capabilities = { permalink: false, reactions: false };
	readonly connector: TeamsConnector;
	#conversations: TeamsConversations | undefined;

	constructor(connector: TeamsConnector) {
		this.connector = connector;
	}

	/** The ledger the aliases live in; set by the binding before the adapter starts. */
	useConversations(conversations: TeamsConversations): void {
		this.#conversations = conversations;
	}

	/** The conversation behind `alias`; throws for one no Activity ever came from (nothing to post to). */
	conversation(alias: string): TeamsConversation {
		const conversation = this.#conversations?.teamsConversation(alias);
		if (conversation === undefined) throw new Error(`unknown teams conversation ${alias}`);
		return conversation;
	}

	async post(target: PostTarget, msg: OutboundMessage): Promise<MessageRef> {
		const conversation = this.conversation(target.conversationId);
		const posted = await this.connector.sendActivity(conversation.serviceUrl, conversation.conversationId, {
			type: "message",
			text: renderOutboundText(msg),
			textFormat: "markdown",
			...(target.threadId === undefined ? {} : { replyToId: target.threadId }),
		});
		return {
			platform: "teams",
			conversationId: target.conversationId,
			messageId: posted.id ?? "",
			...(target.threadId === undefined ? {} : { threadId: target.threadId }),
		};
	}

	async edit(ref: MessageRef, msg: OutboundMessage): Promise<void> {
		if (ref.messageId === "") return;
		const conversation = this.conversation(ref.conversationId);
		await this.connector.updateActivity(conversation.serviceUrl, conversation.conversationId, ref.messageId, {
			type: "message",
			text: renderOutboundText(msg),
			textFormat: "markdown",
		});
	}

	/** Teams has no bot reaction API. */
	async react(_ref: MessageRef, _name: string, _on: boolean): Promise<void> {}

	async uploadFile(_target: PostTarget, _file: { path: string }): Promise<{ fileId: string }> {
		throw new Error("teams: file upload is not supported");
	}

	async permalink(_ref: MessageRef): Promise<string | undefined> {
		return undefined;
	}

	/** A Teams mention needs an entity next to the text; core text bound for Teams names nobody. */
	mentionUser(_userId: string): string {
		return "";
	}
}
