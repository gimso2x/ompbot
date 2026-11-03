import { readFileSync } from "node:fs";
import type { OmpbotConfig } from "../config";
import { readSlackTokens } from "../config";
import type { Logger } from "../log";
import { indexSecretValue } from "../redact";

/**
 * Names that hold secret VALUES (upstream: SECRET_ENV_NAME). Pointer-style names (`*_FILE`, `*_PATH`, …) hold
 * locations, not values, and are skipped.
 */
const SECRET_ENV_NAME = /API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?|AUTH|COOKIE|SESSION/i;
const POINTER_ENV_NAME = /_(FILES?|PATH|DIR|URL|ENV)$/i;
/** JSON object keys whose string values are treated as secrets. */
const SECRET_JSON_KEY = /token|secret|key|password|passwd|credential|refresh|access|private|cookie|auth|session/i;
/** Value shapes that are never secrets: dates, URLs, email addresses. */
const NOT_A_SECRET = /^\d{4}-\d{2}-\d{2}(T| )|https?:\/\/|^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FILE_BYTES = 256 * 1024;

function walkJson(value: unknown, index: (candidate: string) => void): void {
	if (Array.isArray(value)) {
		for (const item of value) walkJson(item, index);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (typeof item === "string") {
			// Field-level extraction keeps non-secret metadata (model names etc.) out of the index: masking whole
			// config files caused over-masking upstream before this was tightened.
			if (SECRET_JSON_KEY.test(key) && !NOT_A_SECRET.test(item)) index(item);
		} else {
			walkJson(item, index);
		}
	}
}

function indexFile(path: string, index: (candidate: string) => void): void {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return; // a missing or unreadable source simply contributes nothing; it is logged by the caller's count
	}
	if (text.length > MAX_FILE_BYTES) text = text.slice(0, MAX_FILE_BYTES);
	const trimmed = text.trim();
	if (trimmed === "") return;
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			walkJson(JSON.parse(trimmed), index);
			return;
		} catch {
			// not valid JSON after all: fall through to whole-file indexing
		}
	}
	index(trimmed);
}

/**
 * Seeds the redaction value index with everything the daemon can legitimately know at startup: the Slack token
 * files, secret-named environment variables, and extra files listed in `OMPBOT_SECRET_GUARD_FILES`
 * (colon-separated, like upstream's guard-files env). Returns how many values were indexed.
 *
 * Startup-only on purpose: a rotated token invalidates the socket connection anyway, so the daemon restarts and
 * re-reads everything. Nothing here can be turned off per turn — the index lives below the agent.
 */
export function indexRuntimeSecrets(
	config: OmpbotConfig,
	env: Record<string, string | undefined>,
	log: Logger,
): number {
	let known = 0;
	const index = (candidate: string): void => {
		if (indexSecretValue(candidate)) known += 1;
	};

	try {
		const tokens = readSlackTokens(config);
		index(tokens.botToken);
		index(tokens.appToken);
	} catch {
		// Token problems are doctor's job; masking simply stays pattern-only until they are fixed.
	}

	for (const [name, value] of Object.entries(env)) {
		if (value === undefined || value === "" || !SECRET_ENV_NAME.test(name) || POINTER_ENV_NAME.test(name)) continue;
		index(value);
	}

	for (const path of (env.OMPBOT_SECRET_GUARD_FILES ?? "").split(":")) {
		if (path !== "") indexFile(path, index);
	}

	log.info("secret_index_loaded", { known });
	return known;
}
