import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config";
import { hasConfig } from "../dashboard/snapshot-assembly";
import { buildTeamsPackage } from "../teams/package";

export const TEAMS_USAGE =
	"  teams package --out <zip> [--app-id <bot id>] [--name <short name>]\n" +
	"                                 the Teams app package (manifest.json with the bot id and scopes personal,groupChat,\n" +
	"                                 two default icons) for Teams' custom app upload; --app-id defaults to\n" +
	"                                 channels.teams.appId\n";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usage(message: string): number {
	process.stderr.write(`teams: ${message}\n${TEAMS_USAGE}`);
	return 2;
}

/** `ompbot teams package`: writes the zip and prints its path and size. */
export function teamsCommand(args: string[], homeDir: string): number {
	const [sub, ...rest] = args;
	if (sub !== "package") return usage(sub === undefined ? "missing subcommand" : `unknown subcommand ${sub}`);
	let values: { out?: string; "app-id"?: string; name?: string };
	try {
		({ values } = parseArgs({
			args: rest,
			options: { out: { type: "string" }, "app-id": { type: "string" }, name: { type: "string" } },
		}));
	} catch (error) {
		return usage(error instanceof Error ? error.message : String(error));
	}
	if (values.out === undefined || values.out.trim() === "") return usage("--out is required");
	const appId =
		values["app-id"] ??
		(hasConfig(homeDir) ? loadConfig(homeDir, { checkTokens: false }).channels.teams?.appId : undefined);
	if (appId === undefined) return usage("--app-id is required when config has no channels.teams");
	if (!GUID.test(appId)) return usage("--app-id must be the bot's app id (a GUID)");
	const out = resolve(values.out);
	const zip = buildTeamsPackage({
		appId: appId.toLowerCase(),
		...(values.name === undefined ? {} : { name: values.name }),
	});
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, zip);
	process.stdout.write(`teams_package ${out} bytes=${zip.length}\n`);
	return 0;
}
