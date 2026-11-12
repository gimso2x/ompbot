// What the daemon asks of one chat platform's adapter, and how a platform plugs into the daemon (`ChannelBinding`).
// The daemon knows platforms only through these two interfaces and the `ChannelPort`.
import type { OmpbotConfig } from "../config";
import type { ThreadSource, TurnProgress } from "../core/mailbox";
import type { ChatPlatform } from "../core/origin-key";
import type { Logger } from "../log";
import type { Store } from "../store/db";
import type { ChannelPort } from "./port";
import type { AdapterClock, CoreSink, DeliverySource, IngestOutcome } from "./types";

/** The live-reloadable inbound policy of an adapter (config reload). */
export interface ChannelPolicy {
	mentionFreeChannels?: readonly string[];
	logChannel?: string;
	peerBots?: ReadonlyArray<{ userId: string; name: string }>;
	requireMention?: boolean;
	peerHopLimit?: { turns: number; windowMinutes: number };
}

/** An owner message the daemon itself puts in (a TASK card button, an auto-merge, `inject`), as typed: not escaped. */
export interface OwnerIngest {
	conversationId: string;
	kind: "dm" | "ch";
	/** Thread root the message replies in; absent: a root message. */
	threadId?: string | undefined;
	/** The message id the owner message takes (the bot's marker already posted for it). */
	messageId: string;
	text: string;
	/** Quoted attachments, fenced like any forwarded text. */
	quoted?: readonly string[] | undefined;
	/**
	 * Put in by `ompbot inject` (anyone with the socket), not by a button the owner clicked: such a message may not
	 * answer an approval or choice card. Absent/false for the daemon's own button paths.
	 */
	injected?: boolean | undefined;
}

export interface ChannelAdapter {
	readonly platform: ChatPlatform;
	readonly botUserId: string | undefined;
	start(): Promise<void>;
	stop(): Promise<void>;
	/** Claims and posts this platform's due deliveries; returns how many were confirmed. */
	pumpDeliveries(): Promise<number>;
	/** Status message upkeep (running updates, pending finals). */
	tick(): Promise<void>;
	setStalled(threadRef: string, stalled: boolean): Promise<void>;
	setProgress(threadRef: string, progress: TurnProgress): Promise<void>;
	/** Best-effort notice (root, or a reply when `threadId` is given); never throws. */
	postNotice(conversationId: string, text: string, threadId?: string): Promise<void>;
	/** Takes `input` as if the owner wrote it, through the adapter's own message path. */
	ingestOwner(input: OwnerIngest): Promise<IngestOutcome>;
	setChannelPolicy(policy: ChannelPolicy): void;
	connectionState(): { state: "up" | "down"; since: number } | undefined;
	/** Starts one missed-message recovery pass now (reconnect, failed ingest); a no-op without recovery. */
	recover(): void;
}

/** What the daemon hands a binding to build its adapter. */
export interface AdapterDeps {
	core: CoreSink;
	/** This platform's due deliveries only. */
	deliveries: DeliverySource;
	clock: AdapterClock;
	log: Logger;
	config: OmpbotConfig;
	/** Lookups and cursors (recovery targets and watermarks, task roots). */
	store: Store;
}

export interface ChannelBinding {
	readonly port: ChannelPort;
	createAdapter(deps: AdapterDeps): ChannelAdapter;
	/** Reads a thread for turn context; absent: the platform's turns get none. */
	readThread?: ThreadSource["replies"];
}
