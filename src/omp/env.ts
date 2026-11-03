import { OmpDriverError } from "./driver";

const STRIPPED_PREFIXES = ["SLACK_", "OMPBOT_"] as const;

/**
 * Environment for the omp child: parent env minus keys starting with `SLACK_`
 * or `OMPBOT_`, plus caller extras (e.g. `OMP_WIKI_NOTE_DISABLE=1`).
 * Extras with a stripped prefix are rejected so the invariant cannot be bypassed.
 */
export function buildChildEnv(
	extras: Record<string, string> = {},
	base: Record<string, string | undefined> = process.env,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(base)) {
		if (value === undefined) continue;
		if (STRIPPED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
		env[key] = value;
	}
	for (const [key, value] of Object.entries(extras)) {
		if (STRIPPED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
			throw new OmpDriverError("invalid_env", `child env extra "${key}" uses a reserved prefix`);
		}
		env[key] = value;
	}
	return env;
}
