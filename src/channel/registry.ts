import { parseThreadRef, TOP_LEVEL_TS } from "../core/normalize";
import { type ChatPlatform, parseChatOrigin, platformOfConversationId } from "../core/origin-key";
import { redact } from "../redact";
import type { ChannelPort, OutboundMessage, PostTarget } from "./port";

function redactMessage(msg: OutboundMessage): OutboundMessage {
	return {
		...msg,
		text: redact(msg.text),
		...(msg.buttonsNote === undefined ? {} : { buttonsNote: redact(msg.buttonsNote) }),
		...(msg.title === undefined ? {} : { title: redact(msg.title) }),
		...(msg.body === undefined ? {} : { body: redact(msg.body) }),
		...(msg.fields === undefined
			? {}
			: { fields: msg.fields.map((field) => ({ label: redact(field.label), value: redact(field.value) })) }),
		...(msg.buttons === undefined
			? {}
			: {
					buttons: msg.buttons.map((button) => ({
						...button,
						label: redact(button.label),
						...(button.value === undefined ? {} : { value: redact(button.value) }),
					})),
				}),
	};
}

/**
 * The single outbound writer: every text, card title/body/field, button label/value, upload title and comment is masked
 * here before an
 * adapter sees it, so no caller can skip it. Callers may redact on their own as well (masking is idempotent).
 */
function redacting(port: ChannelPort): ChannelPort {
	const openThread = port.openThread?.bind(port);
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
		...(openThread === undefined ? {} : { openThread: (ref, name) => openThread(ref, redact(name)) }),
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

	/**
	 * Port and post target of a delivery thread ref (`<conversationId>:<threadId|->`), the platform read from the
	 * conversation id's grammar; `-` (top level) leaves `threadId` out. `undefined` for a malformed ref or an
	 * unregistered platform.
	 */
	forThreadRef(threadRef: string): { port: ChannelPort; target: PostTarget } | undefined {
		const ref = parseThreadRef(threadRef);
		const route = ref === undefined ? undefined : this.forConversation(ref.channel);
		if (ref === undefined || route === undefined) return undefined;
		return ref.threadTs === TOP_LEVEL_TS
			? route
			: { port: route.port, target: { ...route.target, threadId: ref.threadTs } };
	}

	/** Port of a bare conversation id (an approval card's channel, a lane's channel); `undefined` when none fits. */
	forConversation(conversationId: string): { port: ChannelPort; target: PostTarget } | undefined {
		const platform = platformOfConversationId(conversationId);
		const port = platform === undefined ? undefined : this.#ports.get(platform);
		return port === undefined ? undefined : { port, target: { conversationId } };
	}

	/** `forConversation`'s port, for callers that cannot go on without one (a wiring error, not a runtime condition). */
	portFor(conversationId: string): ChannelPort {
		const route = this.forConversation(conversationId);
		if (route === undefined) throw new Error(`no channel registered for conversation ${conversationId}`);
		return route.port;
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
