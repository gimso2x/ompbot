import { resolve, sep } from "node:path";

/**
 * Whether `path` stays inside `dir`: relative segments resolve against `dir` first (an agent-supplied `..` or
 * relative path must not dodge the comparison), then `dir` itself and everything beneath it count as inside.
 */
export function isInside(path: string, dir: string): boolean {
	const abs = resolve(dir, path);
	return abs === dir || abs.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}
