// Inbound Teams attachments in the owner's 1:1 (doc/plans/teams-inbound-files.md). An uploaded file comes as
// `file.download.info` with a short-lived pre-signed SharePoint/OneDrive `downloadUrl`: fetched with no header at all.
// A pasted image comes as `image/*` with a Bot Connector `contentUrl`: the connector token goes only to the Activity's
// own (signature-checked) service host or `*.botframework.com`, every redirect hop re-checked.
import { createHash } from "node:crypto";
import { downloadFile } from "../channel/attachments";
import type { TeamsAttachment } from "./types";

export const TEAMS_FILE_DOWNLOAD_INFO = "application/vnd.microsoft.teams.file.download.info";

/** Pre-signed download hosts (exact suffix match, https only); redirects are re-checked against the same list. */
const FILE_HOST_SUFFIXES = [".sharepoint.com", ".sharepoint-df.com", ".files.1drv.com", ".livefilestore.com"];

/** Mimetypes for the prompt note of common uploaded files (the extension still comes from the file name). */
export const FILE_TYPE_MIME: Record<string, string> = {
	pdf: "application/pdf",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	txt: "text/plain",
	md: "text/markdown",
	csv: "text/csv",
	json: "application/json",
	zip: "application/zip",
};

export function teamsFileHostAllowed(url: URL): boolean {
	const host = url.hostname.toLowerCase();
	return url.protocol === "https:" && FILE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** An inline image host the connector token may go to: the Activity's service host exactly, or `*.botframework.com`. */
export function teamsImageHostAllowed(url: URL, serviceUrl: string): boolean {
	if (url.protocol !== "https:") return false;
	const host = url.hostname.toLowerCase();
	let serviceHost: string;
	try {
		serviceHost = new URL(serviceUrl).hostname.toLowerCase();
	} catch {
		return false;
	}
	return host === serviceHost || host.endsWith(".botframework.com");
}

/** Whether ompbot reads this attachment (an uploaded file or an inline image); cards and HTML renderings are not. */
export function isInboundFile(attachment: TeamsAttachment): boolean {
	const type = attachment.contentType ?? "";
	return type === TEAMS_FILE_DOWNLOAD_INFO || type.startsWith("image/");
}

/** `file.download.info` content, an object or its JSON string; `undefined` when it names no download URL. */
export function fileDownloadInfo(
	content: unknown,
): { downloadUrl: string; uniqueId: string | undefined; fileType: string | undefined } | undefined {
	let value = content;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.downloadUrl !== "string") return undefined;
	return {
		downloadUrl: record.downloadUrl,
		uniqueId: typeof record.uniqueId === "string" ? record.uniqueId : undefined,
		fileType: typeof record.fileType === "string" ? record.fileType.toLowerCase() : undefined,
	};
}

/**
 * The download folder name for an Activity: its id when it is plain (`[A-Za-z0-9._-]`, not only dots, at most 64),
 * else the id with every other character turned to `_` (Teams ids like `f:1:2`), hashed when that is still unsafe.
 */
export function activityDirName(alias: string, activityId: string): string {
	const safe = activityId.replace(/[^A-Za-z0-9._-]/g, "_");
	const name =
		safe === "" || /^\.+$/.test(safe) || safe.length > 64
			? createHash("sha256").update(activityId).digest("hex").slice(0, 16)
			: safe;
	return `${alias}-${name}`;
}

/** One download with the shared hardening; throws with the reason so `saveInboundAttachment` writes a failure line. */
export async function downloadTeamsAttachment(args: {
	url: string;
	destPath: string;
	maxBytes: number;
	requireImageMagic: boolean;
	hostAllowed: (url: URL) => boolean;
	headers?: Record<string, string> | undefined;
	fetchImpl?: typeof fetch | undefined;
}): Promise<void> {
	const result = await downloadFile(args);
	if (!result.ok) throw new Error(result.error);
}
