// The Bot Framework Activity fields ompbot reads, and the ledger alias a Teams conversation id is kept under.
import { createHash } from "node:crypto";

export interface TeamsMention {
	type: string;
	mentioned?: { id?: string; name?: string };
	text?: string;
}

/** An inbound Activity as Teams posts it; every field is untrusted until checked. */
export interface TeamsActivity {
	type?: string;
	id?: string;
	timestamp?: string;
	serviceUrl?: string;
	channelId?: string;
	from?: { id?: string; name?: string; aadObjectId?: string };
	conversation?: { id?: string; conversationType?: string; tenantId?: string; isGroup?: boolean };
	recipient?: { id?: string; name?: string };
	text?: string;
	entities?: TeamsMention[];
	channelData?: { tenant?: { id?: string } };
	replyToId?: string;
	attachments?: TeamsAttachment[];
}

/**
 * One Activity attachment: a file the user uploaded (`application/vnd.microsoft.teams.file.download.info`, `content`
 * an object or its JSON string with `downloadUrl`), an inline image (`image/*` with a Bot Connector `contentUrl`), or a
 * card/HTML rendering ompbot skips.
 */
export interface TeamsAttachment {
	contentType?: string;
	contentUrl?: string;
	content?: unknown;
	name?: string;
}

/**
 * The ledger's stand-in for a Teams conversation id (which holds `:`, `@` and `;`): `t` + the first 16 lower-case hex
 * of its SHA-256 (`GRAMMAR.teams`).
 */
export function teamsAlias(conversationId: string): string {
	return `t${createHash("sha256").update(conversationId).digest("hex").slice(0, 16)}`;
}
