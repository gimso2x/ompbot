import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

/** Slack file hosts that may receive the bot token. Redirects are re-checked against this list. */
const ALLOWED_HOST_SUFFIXES = [".slack.com", ".slack-files.com"];

/** Every segment must match at its offset; WebP is `RIFF....WEBP` (a bare RIFF header is also WAVE/AVI). */
export const IMAGE_MAGIC: Array<{ mime: string; segments: Array<{ offset: number; bytes: number[] }> }> = [
	{ mime: "image/png", segments: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47] }] },
	{ mime: "image/jpeg", segments: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }] },
	{ mime: "image/gif", segments: [{ offset: 0, bytes: [0x47, 0x49, 0x46] }] },
	{
		mime: "image/webp",
		segments: [
			{ offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
			{ offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
		],
	},
];
/** Longest magic prefix any entry needs. */
const MAGIC_HEAD_BYTES = 12;

export function hostAllowed(url: URL): boolean {
	if (url.protocol !== "https:") return false;
	const host = url.hostname.toLowerCase();
	return ALLOWED_HOST_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
}

/** Sniffs the first bytes; `undefined` when the content is not a supported image (HTML error pages etc.). */
export function sniffImageMime(head: Uint8Array): string | undefined {
	const hit = IMAGE_MAGIC.find((magic) =>
		magic.segments.every((segment) => segment.bytes.every((byte, i) => head[segment.offset + i] === byte)),
	);
	return hit?.mime;
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

export type DownloadResult = { ok: true; bytes: number; mime: string | undefined } | { ok: false; error: string };

/**
 * Downloads one Slack attachment to `destPath`, mirroring the hermes-agent hardening:
 * the bearer token is only ever sent to Slack-owned hosts, redirects are followed manually (max 3) and
 * re-checked every hop, 429/5xx/timeouts retry 3 times, an HTML login page is a scope error, and the size
 * cap is enforced on both Content-Length and the streamed body. The body streams straight to the tmp file
 * (chunks are never buffered in memory). The file lands atomically (tmp + rename).
 */
export async function downloadAttachmentFile(args: DownloadAttachmentArgs): Promise<DownloadResult> {
	const fetchImpl = args.fetchImpl ?? fetch;
	const retries = args.retries ?? 2;
	const retryDelayMs = args.retryDelayMs ?? 0;

	let url: URL;
	try {
		url = new URL(args.url);
	} catch {
		return { ok: false, error: "invalid_url" };
	}
	if (url.protocol !== "https:" || !hostAllowed(url)) return { ok: false, error: "host_not_allowed" };

	const destDir = dirname(args.destPath);
	try {
		await mkdir(destDir, { recursive: true, mode: 0o700 });
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	const tmpPath = `${args.destPath}.tmp-${crypto.randomUUID().slice(0, 12)}`;

	for (let attempt = 0; ; attempt++) {
		try {
			let current: URL = url;
			let response: Response | undefined;
			for (let hop = 0; hop <= 3; hop++) {
				if (!hostAllowed(current)) return await cleanup(`redirect_host_not_allowed:${current.hostname}`);
				response = await fetchImpl(current, {
					redirect: "manual",
					headers: hostAllowed(current) ? { authorization: `Bearer ${args.bearerToken}` } : {},
					signal: AbortSignal.timeout(30_000),
				});
				const location = response.headers.get("location");
				if (response.status >= 300 && response.status < 400 && location) {
					await response.body?.cancel();
					current = new URL(location, current);
					continue;
				}
				break;
			}
			if (response === undefined) return await cleanup("no_response");

			if (response.status === 429 || response.status >= 500) {
				await response.body?.cancel();
				if (attempt < retries) {
					await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
					continue;
				}
				return await cleanup(`http_${response.status}`);
			}
			if (response.status !== 200) {
				await response.body?.cancel();
				return await cleanup(`http_${response.status}`);
			}

			const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
			if (contentType.includes("text/html")) {
				await response.body?.cancel();
				return await cleanup("html_response_scope_error");
			}
			const declared = Number(response.headers.get("content-length") ?? "0");
			if (declared > args.maxBytes) {
				await response.body?.cancel();
				return await cleanup("too_large_content_length");
			}

			const reader = response.body?.getReader();
			if (reader === undefined) return await cleanup("empty_body");
			const head: number[] = [];
			let total = 0;
			// A prune pass may have collected the still-empty directory while the body was in flight.
			await mkdir(destDir, { recursive: true, mode: 0o700 });
			// Chunks stream straight to the tmp file so peak memory stays O(chunk), not O(file).
			const tmp = await open(tmpPath, "w", 0o600);
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					if (value.byteLength === 0) continue;
					total += value.byteLength;
					if (total > args.maxBytes) {
						reader.cancel();
						return await cleanup("too_large_streamed");
					}
					if (head.length < MAGIC_HEAD_BYTES) {
						for (const byte of value.subarray(0, MAGIC_HEAD_BYTES - head.length)) head.push(byte);
					}
					// FileHandle.write is a single write(2) and may short-write without error (disk filling up);
					// letting a partial chunk through would rename a silently truncated file.
					const { bytesWritten } = await tmp.write(value);
					if (bytesWritten !== value.byteLength) throw new Error("short_write");
				}
			} finally {
				await tmp.close();
			}
			if (total === 0) return await cleanup("empty_body");

			if (args.requireImageMagic) {
				const mime = sniffImageMime(new Uint8Array(head));
				if (mime === undefined) {
					await rm(tmpPath, { force: true });
					return { ok: false, error: "not_an_image" };
				}
			}
			await rename(tmpPath, args.destPath);
			return { ok: true, bytes: total, mime: contentType.split(";")[0]?.trim() || undefined };
		} catch (error) {
			if (attempt < retries && isRetryableNetworkError(error)) {
				await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
				continue;
			}
			return cleanup(error instanceof Error ? error.message : String(error));
		}
	}

	async function cleanup(error: string): Promise<DownloadResult> {
		await rm(tmpPath, { force: true });
		return { ok: false, error };
	}

	function isRetryableNetworkError(error: unknown): boolean {
		const name = error instanceof Error ? error.name : "";
		return name === "AbortError" || name === "TimeoutError" || name === "TypeError" || name === "ConnectionError";
	}
}
