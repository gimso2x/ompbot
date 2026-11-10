import { type DownloadResult, downloadFile } from "../channel/attachments";

/** Slack file hosts that may receive the bot token. Redirects are re-checked against this list. */
const ALLOWED_HOST_SUFFIXES = [".slack.com", ".slack-files.com"];

export function hostAllowed(url: URL): boolean {
	if (url.protocol !== "https:") return false;
	const host = url.hostname.toLowerCase();
	return ALLOWED_HOST_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
}

export interface DownloadAttachmentArgs {
	url: string;
	bearerToken: string;
	destPath: string;
	maxBytes: number;
	/** Require the body to start with a known image magic (for image/* mimetypes). */
	requireImageMagic?: boolean;
	fetchImpl?: typeof fetch;
	retries?: number;
	retryDelayMs?: number;
}

/**
 * Downloads one Slack attachment to `destPath` with the shared hardening (`downloadFile`): the bearer token is only
 * ever sent to Slack-owned hosts, every redirect hop included.
 */
export function downloadAttachmentFile(args: DownloadAttachmentArgs): Promise<DownloadResult> {
	const { bearerToken, ...rest } = args;
	return downloadFile({ ...rest, hostAllowed, headers: { authorization: `Bearer ${bearerToken}` } });
}
