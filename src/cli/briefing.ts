import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config";
import { briefingSummaryLine, renderBriefingHtml } from "../dashboard/briefing";
import { hasConfig, snapshotReader } from "../dashboard/snapshot-assembly";
import { BRIEFING_TIMEOUT_MS, BRIEFING_WIDTH, renderPng } from "../ops/screenshot";
import { redact } from "../redact";

export const BRIEFING_USAGE =
	"  briefing --out <path>\n" +
	"                                 the same one-page status picture that !brief sends, drawn without the daemon\n" +
	"                                 (chromium at config briefing.chromium, default chromium); prints the path and\n" +
	"                                 size, exit 1 with the reason on stderr\n";

function usage(message: string): number {
	process.stderr.write(`briefing: ${message}\n${BRIEFING_USAGE}`);
	return 2;
}

/**
 * `ompbot briefing --out <path>` (doc/plans/briefing-image.md §E): the morning monitor's way to get the picture without
 * asking the daemon. Same snapshot assembly as `ompbot dashboard`, same renderer as `!brief`.
 */
export async function briefingCommand(args: string[], homeDir: string): Promise<number> {
	let values: { out?: string };
	try {
		({ values } = parseArgs({ args, options: { out: { type: "string" } } }));
	} catch (error) {
		return usage(error instanceof Error ? error.message : String(error));
	}
	if (values.out === undefined || values.out.trim() === "") return usage("--out is required");
	const out = resolve(values.out);
	const config = hasConfig(homeDir) ? loadConfig(homeDir, { checkTokens: false }) : undefined;
	const now = Date.now();
	try {
		mkdirSync(dirname(out), { recursive: true });
		const snapshot = await snapshotReader({ homeDir, config })();
		const size = await renderPng(renderBriefingHtml(snapshot, now), out, {
			chromium: config?.briefing?.chromium ?? "chromium",
			width: BRIEFING_WIDTH,
			timeoutMs: BRIEFING_TIMEOUT_MS,
		});
		process.stdout.write(`briefing ${out} ${size.width}x${size.height} ${briefingSummaryLine(snapshot)}\n`);
		return 0;
	} catch (error) {
		const reason = redact(error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
		process.stderr.write(`briefing: ${reason}\n`);
		return 1;
	}
}
