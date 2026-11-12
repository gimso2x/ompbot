// Discord's plug into the daemon: its port, its adapter (with the missed-message recovery behind `recover()`) and its
// thread reader for turn context, built from `channels.discord`.
import { join } from "node:path";
import type { AdapterDeps, ChannelAdapter, ChannelBinding } from "../channel/adapter";
import type { SlackThreadMessage } from "../core/mailbox";
import { parseChatOrigin } from "../core/origin-key";
import { DiscordAdapter } from "./adapter";
import { type BackfillTarget, discordCursorKey, snowflakeTime } from "./backfill";
import type { DiscordChannel } from "./channel";
import type { DiscordMessageEvent } from "./transport";

/** Pages of a thread read for a whole-thread context (oldest first); a longer thread is cut. */
const THREAD_CONTEXT_MAX_PAGES = 5;
const THREAD_PAGE_LIMIT = 100;

/** A Discord message as the mailbox's thread context reads it (`ts` is the message id). */
function threadMessage(message: DiscordMessageEvent): SlackThreadMessage {
	return {
		ts: message.id,
		text: message.content,
		user: message.author.id,
		botId: message.author.bot === true ? message.author.id : undefined,
		at: snowflakeTime(message.id),
	};
}

export class DiscordBinding implements ChannelBinding {
	readonly port: DiscordChannel;
	readonly #backfillMaxPages: number | undefined;

	constructor(port: DiscordChannel, options: { backfillMaxPages?: number } = {}) {
		this.port = port;
		this.#backfillMaxPages = options.backfillMaxPages;
	}

	createAdapter(deps: AdapterDeps): ChannelAdapter {
		const discord = deps.config.channels.discord;
		if (discord === undefined) throw new Error("discord binding without channels.discord");
		const { store } = deps;
		this.port.useButtonValues(store);
		const cursorPrefix = discordCursorKey("");
		const adapter = new DiscordAdapter({
			channel: this.port,
			core: deps.core,
			deliveries: deps.deliveries,
			ownerUserId: discord.ownerUserId,
			clock: deps.clock,
			log: deps.log,
			guildIds: discord.guildIds,
			mentionFreeChannels: discord.mentionFreeChannels,
			requireMention: discord.requireMention,
			peerBots: discord.peerBots,
			peerHopLimit: deps.config.peerHopLimit,
			isTaskRoot: (threadRef) => store.tasks.isTaskRoot(threadRef),
			onInboundFailure: () => adapter.recover(),
			mediaRoot: join(deps.config.homeDir, "media"),
			// Every Discord conversation is a channel to read: a DM, a server channel (its roots open threads), and a
			// server thread, which is a channel of its own. A stored watermark keeps its channel a target after `ompbot
			// gc` removed the quiet origin; Slack's `ch:`/`thr:` watermarks are never read here.
			recovery: {
				cursors: store,
				maxPages: this.#backfillMaxPages,
				targets: () => [
					...store
						.listCursorKeys(cursorPrefix)
						.map((key): BackfillTarget => ({ channelId: key.slice(cursorPrefix.length) })),
					...store.listOrigins("discord").flatMap((originKey): BackfillTarget[] => {
						const ref = parseChatOrigin(originKey);
						if (ref?.platform !== "discord") return [];
						const conversation = { channelId: ref.conversationId, dm: ref.kind === "dm" };
						return ref.threadId === undefined ? [conversation] : [conversation, { channelId: ref.threadId, dm: false }];
					}),
				],
			},
		});
		return adapter;
	}

	/**
	 * Messages of a server thread oldest-first with its root leading. The root is the message the thread was started
	 * from: it lives in the parent channel under the thread's own id, so it is the first message after `id − 1` there.
	 * A `limit` (the root only) is that single read.
	 */
	readonly readThread = async (channel: string, threadTs: string, limit?: number): Promise<SlackThreadMessage[]> => {
		const transport = this.port.transport;
		const [root] = await transport.listMessages({ channelId: channel, after: String(BigInt(threadTs) - 1n), limit: 1 });
		const out = root === undefined ? [] : [threadMessage(root)];
		if (limit !== undefined) return out;
		let after = threadTs;
		for (let page = 0; page < THREAD_CONTEXT_MAX_PAGES; page++) {
			const messages = await transport.listMessages({ channelId: threadTs, after, limit: THREAD_PAGE_LIMIT });
			out.push(...messages.map(threadMessage));
			const last = messages.at(-1);
			if (last === undefined || messages.length < THREAD_PAGE_LIMIT) break;
			after = last.id;
		}
		return out;
	};
}
