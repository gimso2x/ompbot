import { readFileSync } from "node:fs";
import type { OmpbotConfig } from "../config";
import { readDiscordToken, readSlackTokens, readTeamsClientSecret } from "../config";
import type { Logger } from "../log";
import { indexSecretValue } from "../redact";
import { readGraphTokenFile } from "../teams/graph";

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

	if (config.slack !== undefined) {
		try {
			const tokens = readSlackTokens(config);
			index(tokens.botToken);
			index(tokens.appToken);
		} catch {
			// Token problems are doctor's job; masking simply stays pattern-only until they are fixed.
		}
	}
	if (config.channels.discord !== undefined) {
		try {
			index(readDiscordToken(config));
		} catch {
			// Same as above: doctor reports it.
		}
	}
	if (config.channels.teams !== undefined) {
		try {
			index(readTeamsClientSecret(config));
		} catch {
			// Same as above: doctor reports it.
		}
		// The Graph refresh token `teams login` saved (reading it indexes it); none yet is not a problem.
		const graphTokenFile = config.channels.teams.graph?.tokenFile;
		if (graphTokenFile !== undefined && readGraphTokenFile(graphTokenFile) !== undefined) known += 1;
	}

	known += indexEnvSecrets(env);
	log.info("secret_index_loaded", { known });
	return known;
}

/**
 * The part of {@link indexRuntimeSecrets} that never touches the Slack token files: secret-named environment
 * variables and the files listed in `OMPBOT_SECRET_GUARD_FILES`. The dashboard seeds its index with this alone, so its
 * masking goes past the patterns without the dashboard reading the tokens. Returns how many values were indexed.
 */
export function indexEnvSecrets(env: Record<string, string | undefined>): number {
	let known = 0;
	const index = (candidate: string): void => {
		if (indexSecretValue(candidate)) known += 1;
	};

	for (const [name, value] of Object.entries(env)) {
		if (value === undefined || value === "" || !SECRET_ENV_NAME.test(name) || POINTER_ENV_NAME.test(name)) continue;
		index(value);
	}

	for (const path of (env.OMPBOT_SECRET_GUARD_FILES ?? "").split(":")) {
		if (path !== "") indexFile(path, index);
	}
	return known;
}
