// Slack's plug into the daemon: its port, its adapter (with the missed-message backfill behind `recover()`) and its
// thread reader for turn context.
import { join } from "node:path";
import type { AdapterDeps, ChannelAdapter, ChannelBinding } from "../channel/adapter";
import type { SlackThreadMessage } from "../core/mailbox";
import { parseChatOrigin } from "../core/origin-key";
import { SlackAdapter } from "./adapter";
import { type BackfillDeps, BackfillRunner, type ChannelTarget, channelCursorKey } from "./backfill";
import type { SlackChannel } from "./channel";

/** Pages of a thread read for turn context (oldest first); a longer thread is cut. */
const THREAD_CONTEXT_MAX_PAGES = 5;

/** Backfill thread targets: threads with activity in this window. */
const THREAD_TARGET_WINDOW_MS = 7 * 24 * 3_600_000;
const THREAD_TARGET_LIMIT = 200;

export class SlackBinding implements ChannelBinding {
	readonly port: SlackChannel;

	constructor(port: SlackChannel) {
		this.port = port;
	}

	createAdapter(deps: AdapterDeps): ChannelAdapter {
		const { config, store } = deps;
		const slackOwner = config.channels.slack?.ownerUserId;
		// Bound only when `channels.slack` is set (daemon/run.ts `channelBindings`).
		if (slackOwner === undefined) throw new Error("SlackBinding needs channels.slack");
		const transport = this.port.transport;
		// Missed-message backfill: once at startup (the daemon's `recover()`), then on every socket reconnect. The
		// adapter's live ingest failures trigger it too: they never advance the watermark, so without this a
		// transiently failed message would sit unanswered until the next reconnect. Deps are built lazily per pass,
		// so creating the runner before the adapter exists is fine.
		let adapter: SlackAdapter | undefined;
		const backfill = new BackfillRunner((): BackfillDeps => {
			if (adapter === undefined) throw new Error("backfill before adapter start");
			const live = adapter;
			const channelCursorPrefix = channelCursorKey("");
			return {
				transport,
				ingest: (event) => live.ingestRecovered(event),
				notifier: (channel, text, threadTs) => live.postNotice(channel, text, threadTs),
				cursors: store,
				log: deps.log,
				now: Date.now(),
				botUserId: live.botUserId ?? "",
				// A channel is a target once any conversation of it exists: the channel origin, or a root/thread origin
				// (`slack/ch/<C>/t/<R>`) — a plain channel root opens only its own root origin, never the channel one —
				// or once it has a stored channel watermark: `ompbot gc` removes quiet root origins but never cursors,
				// so a channel scanned before stays a target like its channel origin row used to keep it. One target
				// per channel: the `ch:<C>` watermark spans every root and reply, and replies of answered threads also
				// come back as thread targets. An unreadable (left/deleted) channel is quarantined by the backfill.
				channels: [
					...new Map([
						...store.listCursorKeys(channelCursorPrefix).map((key): [string, ChannelTarget] => {
							const channel = key.slice(channelCursorPrefix.length);
							return [channel, { channel, kind: channel.startsWith("D") ? "im" : "channel" }];
						}),
						...store.listOrigins("slack").flatMap((originKey): Array<[string, ChannelTarget]> => {
							const ref = parseChatOrigin(originKey);
							if (ref?.platform !== "slack") return [];
							const channel = ref.conversationId;
							return [[channel, { channel, kind: ref.kind === "dm" ? "im" : "channel" }]];
						}),
					]).values(),
				],
				threads: store.listThreadTargets("slack", Date.now() - THREAD_TARGET_WINDOW_MS, THREAD_TARGET_LIMIT),
			};
		});
		adapter = new SlackAdapter({
			transport,
			core: deps.core,
			deliveries: deps.deliveries,
			ownerUserId: slackOwner,
			clock: deps.clock,
			log: deps.log,
			mediaRoot: join(config.homeDir, "media"),
			...(config.mentionFreeChannels === undefined ? {} : { mentionFreeChannels: config.mentionFreeChannels }),
			...(config.logChannel === undefined ? {} : { logChannel: config.logChannel }),
			...(config.peerBots === undefined ? {} : { peerBots: config.peerBots }),
			...(config.requireMention === undefined ? {} : { requireMention: config.requireMention }),
			...(config.peerHopLimit === undefined ? {} : { peerHopLimit: config.peerHopLimit }),
			isTaskRoot: (threadRef) => store.tasks.isTaskRoot(threadRef),
			onInboundFailure: () => backfill.trigger(),
			recover: () => backfill.trigger(),
		});
		return adapter;
	}

	/** Oldest-first pages of a thread; a `limit` (root only) is a single call. */
	readonly readThread = async (channel: string, threadTs: string, limit?: number): Promise<SlackThreadMessage[]> => {
		const out: SlackThreadMessage[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < THREAD_CONTEXT_MAX_PAGES; page++) {
			const res = await this.port.transport.conversationsReplies({
				channel,
				ts: threadTs,
				...(limit === undefined ? {} : { limit }),
				...(cursor === undefined ? {} : { cursor }),
			});
			for (const m of res.messages) {
				out.push({ ts: m.ts, text: m.text ?? "", user: m.user, botId: m.bot_id });
			}
			cursor = res.nextCursor;
			if (cursor === undefined || limit !== undefined) break;
		}
		return out;
	};
}
