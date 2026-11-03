import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "./type-guards";

/**
 * Why the pinned omp install cannot host an RPC child, checked before every spawn and by the `omp_runtime` gate.
 *
 * Both failures come from one upgrade path (2026-10-29, omp 18.13.3): omp raised `engines.bun`, `omp update`
 * installed the package with bun, its launcher check failed on the old bun, and the updater replaced the
 * `~/.bun/bin/omp` symlink with the standalone binary. ompbot then looked for the RPC client next to that binary and
 * every new session failed as `omp_rpc_client_missing`, which named neither cause.
 */
export interface OmpRuntimeProblem {
	code: "omp_launcher_standalone" | "bun_too_old";
	/** Short `key=value` detail for gates and logs. */
	detail: string;
	/** Human-readable cause with the fix. */
	message: string;
}

/** Whether `path` starts with a `#!` line (the package's `dist/cli.js`), as opposed to a compiled binary. */
function isScript(path: string): boolean {
	const fd = openSync(path, "r");
	try {
		const head = Buffer.alloc(2);
		return readSync(fd, head, 0, 2, 0) === 2 && head.toString("latin1") === "#!";
	} finally {
		closeSync(fd);
	}
}

/**
 * `cliPath` is the realpath of the configured omp executable; `bun` is the bun that will run the child.
 * Returns undefined when the install looks usable (an unparseable manifest is left to the later import checks).
 */
export function checkOmpRuntime(cliPath: string, bun: string): OmpRuntimeProblem | undefined {
	const packageRoot = dirname(dirname(cliPath));
	const manifestPath = join(packageRoot, "package.json");
	if (!existsSync(manifestPath) && !isScript(cliPath)) {
		return {
			code: "omp_launcher_standalone",
			detail: `launcher=standalone path=${cliPath}`,
			message:
				`${cliPath} is a standalone omp binary, not the package launcher ompbot drives (omp update replaces the ` +
				"symlink when the installed bun is older than omp requires). Run `bun upgrade`, then point the executable " +
				"back at <global node_modules>/@oh-my-pi/pi-coding-agent/dist/cli.js.",
		};
	}

	let manifest: unknown;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch {
		return undefined;
	}
	const engines = isRecord(manifest) ? manifest.engines : undefined;
	const range = isRecord(engines) ? engines.bun : undefined;
	if (typeof range !== "string") return undefined;
	const version = Bun.spawnSync([bun, "--version"]).stdout.toString().trim();
	if (version !== "" && Bun.semver.satisfies(version, range)) return undefined;
	return {
		code: "bun_too_old",
		detail: `bun=${version || "unknown"} need=${range}`,
		message: `bun ${version || "(version unknown)"} at ${bun} does not satisfy omp's engines.bun ${range}; run \`bun upgrade\`.`,
	};
}
