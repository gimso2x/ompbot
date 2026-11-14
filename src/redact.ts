// Secret masking. Byte budgets are applied AFTER masking, on the UTF-8 serialized text the consumer receives:
// masking can grow a string (xoxb-a -> [REDACTED]), so a pre-mask size check would be bypassable.

export const REDACTED = "[REDACTED]";

/**
 * Discord bot token: base64url user id (23–28) . timestamp (6–7) . HMAC (27+). It must start at a base64url edge, so a
 * dotted name or the tail of a longer segment (a JWT header) never matches.
 */
const DISCORD_TOKEN_SHAPE = "(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{23,28}\\.[A-Za-z0-9_-]{6,7}\\.[A-Za-z0-9_-]{27,}";

/** Entra (Azure AD) client secret, the Teams bot's credential: 3 chars, a digit, `Q~`, then 31–34 chars. */
const ENTRA_SECRET_SHAPE = "(?<![A-Za-z0-9_~.-])[A-Za-z0-9_~.]{3}[0-9]Q~[A-Za-z0-9_~.-]{31,34}";

/** A PEM private key (`RSA`, `EC`, `OPENSSH`, `ENCRYPTED`, bare) from its BEGIN line through its END line. */
const PEM_PRIVATE_KEY_SHAPE =
	"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\\s\\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----";

/**
 * Cloud and forge keys: AWS access key id (`AKIA` + 16), Google API key (`AIza` + 35), GitLab personal token
 * (`glpat-`), each at an alphanumeric edge so a longer word holding the prefix survives.
 */
const CLOUD_KEY_SHAPES =
	"(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])|(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])|(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}";

/** Incoming webhook URLs, whose path is the credential: Slack (`hooks.slack.com/...`) and Discord (`/api/webhooks/<id>/<token>`). */
const WEBHOOK_URL_SHAPES =
	"https?://hooks\\.slack\\.com/(?:services|workflows|triggers)/[A-Za-z0-9_/-]+|https?://(?:(?:canary|ptb)\\.)?discord(?:app)?\\.com/api/webhooks/\\d+/[A-Za-z0-9_-]+";

/**
 * xox[a-z]- (Slack bot/user/app/refresh/client/cookie tokens), xapp-, sk-ant-, sk-, GitHub tokens
 * (ghp_/gho_/ghu_/ghs_/ghr_, fine-grained github_pat_), Discord bot tokens, Entra client secrets, cloud keys, webhook
 * URLs and PEM private key blocks as one regex source. `sk-` needs a non-alphanumeric left edge so words like
 * "task-1" or "risk-free" survive; `skRun` is the quantifier of the key body after `sk-` / `sk-ant-`, the only part
 * the upload check (`safety/host-tools.ts`) sets differently.
 */
export const secretShapes = (skRun: string): string =>
	`${PEM_PRIVATE_KEY_SHAPE}|${WEBHOOK_URL_SHAPES}|xox[a-z]-[A-Za-z0-9_-]*|xapp-[A-Za-z0-9_-]*|(?<![A-Za-z0-9])sk-(?:ant-)?[A-Za-z0-9_-]${skRun}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|${CLOUD_KEY_SHAPES}|${DISCORD_TOKEN_SHAPE}|${ENTRA_SECRET_SHAPE}`;
const SECRET_PATTERN = new RegExp(secretShapes("+"), "g");

export type Redactor = (text: string) => string;

// ---------------------------------------------------------------------------
// Known-secret value index. The daemon seeds it with the real credential values it reads at startup; every
// redact() call then masks not only secret-shaped strings but any fragment (16-char window) of an indexed value,
// in transformed form too (reversed, hex, base64) — the same two-layer design as upstream's secret guard.
// Values live only in memory here; they are never logged.
// ---------------------------------------------------------------------------

const WINDOW = 16;
const MIN_SECRET_LENGTH = 16;
/** Whitespace, quotes, separators and every invisible/format character are ignored on BOTH sides, so a secret
 * split or smudged by formatting (soft hyphens, LRM/RLM, joiners, BOM, …) still matches. */
const IGNORED = /[\s'"`,+\\\u200b-\u200f\u2060-\u2064\ufeff\u00ad\u180e]|\u034f/gu;
const IGNORED_CHAR = /[\s'"`,+\\\u200b-\u200f\u2060-\u2064\ufeff\u00ad\u180e]|\u034f/;

const secretWindows = new Set<string>();

function normalize(text: string): string {
	return text.replace(IGNORED, "");
}

function hexEncode(text: string, upper: boolean): string {
	let out = "";
	for (const byte of new TextEncoder().encode(text)) out += byte.toString(16).padStart(2, "0");
	return upper ? out.toUpperCase() : out;
}

function base64Forms(text: string): string[] {
	const bytes = new TextEncoder().encode(text);
	const forms: string[] = [];
	// The full-value encodings (a whole-secret leak) plus per-alignment stable prefixes (a tail cut mid-value:
	// the last base64 chars depend on bytes that are not present in the fragment, so only the prefix is stable).
	const full = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")).replaceAll("=", "");
	forms.push(full, full.replaceAll("+", "-").replaceAll("/", "_"));
	for (let offset = 0; offset < 3 && offset < bytes.length; offset++) {
		let std = btoa(Array.from(bytes.slice(offset), (byte) => String.fromCharCode(byte)).join("")).replaceAll("=", "");
		if (std.length > 3) std = std.slice(0, -3);
		forms.push(std, std.replaceAll("+", "-").replaceAll("/", "_"));
	}
	return forms;
}

function addWindows(form: string): void {
	const normalized = normalize(form);
	if (normalized.length < WINDOW) return;
	for (let start = 0; start + WINDOW <= normalized.length; start++)
		secretWindows.add(normalized.slice(start, start + WINDOW));
}

/**
 * Indexes one secret value (and its transformed forms) for fragment matching. Values shorter than
 * `MIN_SECRET_LENGTH` are ignored — they cannot fill a match window and would only invite false positives.
 * Returns false when the value was not indexed.
 */
export function indexSecretValue(raw: string): boolean {
	const value = normalize(raw);
	if (value.length < MIN_SECRET_LENGTH) return false;
	// Windows come from the normalized value; byte encodings come from BOTH the raw and the normalized bytes —
	// a leaked copy is the encoding of the original bytes, which may include the ignored characters.
	for (const variant of [raw.trim(), value]) {
		addWindows(normalize(variant));
		addWindows(normalize([...variant].reverse().join("")));
		addWindows(normalize(hexEncode(variant, false)));
		addWindows(normalize(hexEncode(variant, true)));
		for (const prefix of base64Forms(variant)) addWindows(prefix);
	}
	return true;
}

/** Test seam: drops every indexed value. */
export function clearSecretIndex(): void {
	secretWindows.clear();
}

/** Number of distinct match windows currently indexed (diagnostics only). */
export function secretIndexSize(): number {
	return secretWindows.size;
}

/**
 * Replaces every maximal run of the text that covers a known 16-char window with `REDACTED`. Runs on the
 * normalization-projected text and maps hits back to original offsets, so formatting split secrets still match.
 */
export function maskKnownFragments(text: string): string {
	if (secretWindows.size === 0 || text.length < WINDOW) return text;
	const projected: string[] = [];
	const originalIndex: number[] = [];
	for (let i = 0; i < text.length; i++) {
		const ch = text.charAt(i);
		if (IGNORED_CHAR.test(ch)) continue;
		projected.push(ch);
		originalIndex.push(i);
	}
	const normalized = projected.join("");
	// Maximal ranges of projected indices whose 16-char windows are indexed; disjoint hits mask separately.
	let spanStart = -1;
	let spanEndProjected = -1;
	let replaced = "";
	let copiedTo = 0;
	const flush = (endProjectedExclusive: number) => {
		// Spans are only opened on confirmed hits, so both indices exist; the defaults only satisfy the checker.
		const from = originalIndex[spanStart] ?? 0;
		let to = (originalIndex[endProjectedExclusive - 1] ?? text.length - 1) + 1;
		// Base64 padding is not part of any indexed form; swallow it so `[REDACTED]=` does not hint at the tail.
		for (let pad = 0; pad < 2 && text.charAt(to) === "="; pad++) to++;
		replaced += text.slice(copiedTo, from) + REDACTED;
		copiedTo = to;
		spanStart = -1;
	};
	for (let start = 0; start + WINDOW <= normalized.length; start++) {
		if (!secretWindows.has(normalized.slice(start, start + WINDOW))) continue;
		if (spanStart >= 0 && start > spanEndProjected) flush(spanEndProjected);
		if (spanStart < 0) spanStart = start;
		spanEndProjected = start + WINDOW;
	}
	if (spanStart >= 0) flush(spanEndProjected);
	replaced += text.slice(copiedTo);
	return replaced;
}

const WHOLE_SECRET = new RegExp(`^(?:${secretShapes("+")})$`);

/**
 * A secret-shaped token wrapped onto the next line (a terminal paste): the shapes are matched again on the text
 * with line breaks taken out, and a hit that spans a break is masked as its whole original run — but only when the
 * part before the first break is not a complete shape by itself (then the next line is prose, as in `exit 1 with
 * <token>` + newline + `more`). Only line breaks are joined: joining spaces would swallow the words after a token.
 */
function maskWrappedShapes(text: string): string {
	if (!/[\r\n]/.test(text)) return text;
	const projected: string[] = [];
	const originalIndex: number[] = [];
	for (let i = 0; i < text.length; i++) {
		const ch = text.charAt(i);
		if (ch === "\r" || ch === "\n") continue;
		projected.push(ch);
		originalIndex.push(i);
	}
	let replaced = "";
	let copiedTo = 0;
	for (const match of projected.join("").matchAll(SECRET_PATTERN)) {
		const start = match.index ?? 0;
		if (match[0].length === 0) continue;
		const from = originalIndex[start] ?? 0;
		const to = (originalIndex[start + match[0].length - 1] ?? text.length - 1) + 1;
		const run = text.slice(from, to);
		const head = run.split(/[\r\n]/, 1)[0] ?? "";
		if (head === run || WHOLE_SECRET.test(head)) continue;
		replaced += text.slice(copiedTo, from) + REDACTED;
		copiedTo = to;
	}
	return replaced + text.slice(copiedTo);
}

/**
 * OAuth bearer credentials (the Teams Graph delegated tokens): a JWT (Entra access tokens, so also any
 * `Authorization: Bearer eyJ…` header), and the value of an `access_token` / `refresh_token` / `id_token` field in JSON
 * or a form body. Chat masking only: the upload check keeps `secretShapes`.
 */
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const TOKEN_FIELD_PATTERN = /(["']?\b(?:access|refresh|id)_token["']?\s*[:=]\s*["']?)[^"'&\s,}]{16,}/gi;

export const redact: Redactor = (text) =>
	maskKnownFragments(
		maskWrappedShapes(text)
			.replace(SECRET_PATTERN, REDACTED)
			.replace(JWT_PATTERN, REDACTED)
			.replace(TOKEN_FIELD_PATTERN, `$1${REDACTED}`),
	);

const encoder = new TextEncoder();

export function byteLength(text: string): number {
	return encoder.encode(text).length;
}

/** Longest prefix of `text` whose UTF-8 encoding fits in `maxBytes`, never splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (byteLength(text) <= maxBytes) return text;
	let bytes = 0;
	let end = 0;
	for (const ch of text) {
		const size = byteLength(ch);
		if (bytes + size > maxBytes) break;
		bytes += size;
		end += ch.length;
	}
	return text.slice(0, end);
}

/** Mask first, then enforce the byte budget on the masked output. */
export function redactToBudget(text: string, maxBytes: number, redactFn: Redactor = redact): string {
	return truncateUtf8(redactFn(text), maxBytes);
}
