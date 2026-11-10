// Inbound Discord attachments come from Discord's CDN, which needs no credentials: the bot token never goes with them.
import { type DownloadResult, downloadFile } from "../channel/attachments";

/** Discord's attachment hosts; redirects are re-checked against this list. */
const DISCORD_CDN_HOSTS: Record<string, true> = { "cdn.discordapp.com": true, "media.discordapp.net": true };

export function discordCdnAllowed(url: URL): boolean {
	return url.protocol === "https:" && DISCORD_CDN_HOSTS[url.hostname.toLowerCase()] === true;
}

/** One attachment to `destPath` with the shared hardening (`downloadFile`), Discord CDN hosts only, no Authorization. */
export function downloadDiscordAttachment(args: {
	url: string;
	destPath: string;
	maxBytes: number;
	requireImageMagic?: boolean | undefined;
	fetchImpl?: typeof fetch | undefined;
	retries?: number | undefined;
	retryDelayMs?: number | undefined;
}): Promise<DownloadResult> {
	return downloadFile({ ...args, hostAllowed: discordCdnAllowed });
}
