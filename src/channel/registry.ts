import { type ChatPlatform, parseChatOrigin } from "../core/origin-key";
import { redact } from "../redact";
import type { ChannelPort, OutboundMessage, PostTarget } from "./port";

function redactMessage(msg: OutboundMessage): OutboundMessage {
	return {
		...msg,
		text: redact(msg.text),
		...(msg.buttonsNote === undefined ? {} : { buttonsNote: redact(msg.buttonsNote) }),
	};
}

/**
 * The single outbound writer: every text, upload title and comment is masked here before an adapter sees it, so no
 * caller can skip it. Callers may redact on their own as well (masking is idempotent).
 */
function redacting(port: ChannelPort): ChannelPort {
	return {
		platform: port.platform,
		capabilities: port.capabilities,
		post: (target, msg) => port.post(target, redactMessage(msg)),
		edit: (ref, msg) => port.edit(ref, redactMessage(msg)),
		react: (ref, name, on) => port.react(ref, name, on),
		uploadFile: (target, file) =>
			port.uploadFile(target, {
				path: file.path,
				...(file.title === undefined ? {} : { title: redact(file.title) }),
				...(file.comment === undefined ? {} : { comment: redact(file.comment) }),
			}),
		permalink: (ref) => port.permalink(ref),
		mentionUser: (userId) => port.mentionUser(userId),
	};
}

/** One port per chat platform; what it hands out is always the redacting writer around the adapter. */
export class ChannelRegistry {
	readonly #ports = new Map<ChatPlatform, ChannelPort>();

	register(port: ChannelPort): void {
		if (this.#ports.has(port.platform)) throw new Error(`channel already registered: ${port.platform}`);
		this.#ports.set(port.platform, redacting(port));
	}

	/** The registered port of `platform`; throws when none is (a wiring error, not a runtime condition). */
	get(platform: ChatPlatform): ChannelPort {
		const port = this.#ports.get(platform);
		if (port === undefined) throw new Error(`no channel registered for ${platform}`);
		return port;
	}

	/** Port and post target of a chat origin key; `undefined` for non-chat origins and unregistered platforms. */
	forOrigin(originKey: string): { port: ChannelPort; target: PostTarget } | undefined {
		const ref = parseChatOrigin(originKey);
		const port = ref === undefined ? undefined : this.#ports.get(ref.platform);
		if (ref === undefined || port === undefined) return undefined;
		return {
			port,
			target: {
				conversationId: ref.conversationId,
				...(ref.threadId === undefined ? {} : { threadId: ref.threadId }),
			},
		};
	}
}
