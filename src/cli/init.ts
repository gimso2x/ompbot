import { accessSync, chmodSync, constants, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultHomeDir, HOME_MODE, SECRET_MODE } from "../config";

export const INIT_USAGE = `  init --owner <Slack member id> [--omp <abs path>] [--workspace <dir>] | --help
  init --platform discord --owner <Discord user id> --app-id <application id> [--omp …] [--workspace …]
  init --platform teams --owner <Entra object id> --app-id <bot id> --tenant <tenant id> [--omp …] [--workspace …]
                                 create the home (0700), secrets/ (0700), the workspace and a minimal config.json (0600);
                                 --omp defaults to omp on PATH, --workspace to <home>/workspace; never writes tokens and
                                 never touches an existing config.json (exit 2)
`;

const OWNER_ID = /^U[A-Z0-9]{8,}$/;
const SNOWFLAKE = /^[0-9]{17,20}$/;
const ENTRA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message: string): number {
	process.stderr.write(`init: ${message}\n${INIT_USAGE}`);
	return 2;
}

/** `ompbot init`: every argument is checked before anything is created, so a refused run leaves no trace. */
export function initCommand(args: string[], env: Record<string, string | undefined>): number {
	let values: {
		owner?: string;
		omp?: string;
		workspace?: string;
		help?: boolean;
		platform?: string;
		"app-id"?: string;
		tenant?: string;
	};
	try {
		({ values } = parseArgs({
			args,
			options: {
				owner: { type: "string" },
				platform: { type: "string" },
				"app-id": { type: "string" },
				tenant: { type: "string" },
				omp: { type: "string" },
				workspace: { type: "string" },
				help: { type: "boolean", short: "h" },
			},
		}));
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
	if (values.help === true) {
		process.stdout.write(INIT_USAGE);
		return 0;
	}
	const platform = values.platform ?? "slack";
	if (platform !== "slack" && platform !== "discord" && platform !== "teams") {
		return fail("--platform must be slack, discord or teams");
	}
	if (platform === "slack" && (values.owner === undefined || !OWNER_ID.test(values.owner))) {
		return fail("--owner must be a Slack member id (U followed by 8+ uppercase letters or digits)");
	}
	if (platform === "discord") {
		for (const [option, value] of [
			["--owner", values.owner],
			["--app-id", values["app-id"]],
		] as const) {
			if (value === undefined || !SNOWFLAKE.test(value)) return fail(`${option} must be a Discord id (17-20 digits)`);
		}
	}
	if (platform === "teams") {
		for (const [option, value] of [
			["--owner", values.owner],
			["--app-id", values["app-id"]],
			["--tenant", values.tenant],
		] as const) {
			if (value === undefined || !ENTRA_ID.test(value)) return fail(`${option} must be an Entra id (a GUID)`);
		}
	}
	// An empty value would resolve to the current directory; leave the option out to get the default instead.
	if (values.omp === "") return fail("--omp is empty; leave it out to use omp on PATH");
	if (values.workspace === "") return fail("--workspace is empty; leave it out to use <home>/workspace");
	const omp = values.omp === undefined ? Bun.which("omp", { PATH: env.PATH ?? "" }) : resolve(values.omp);
	if (omp === null) return fail("omp not found on PATH; pass --omp <absolute path to omp>");
	if (!existsSync(omp)) return fail(`--omp ${omp} does not exist`);
	if (!statSync(omp).isFile()) return fail(`--omp ${omp} is a directory, not the omp executable`);
	try {
		accessSync(omp, constants.X_OK);
	} catch {
		return fail(`--omp ${omp} is not executable`);
	}

	const homeDir = resolve(defaultHomeDir(env));
	const configPath = join(homeDir, "config.json");
	if (existsSync(configPath)) return fail(`${configPath} already exists; nothing changed`);
	const workspaceDir = resolve(values.workspace ?? join(homeDir, "workspace"));
	const secretsDir = join(homeDir, "secrets");
	// mkdir fails halfway (raw EEXIST/ENOTDIR, a bare home left behind) when a file sits where a directory goes.
	for (const [label, dir] of [
		["home", homeDir],
		["home", secretsDir],
		["--workspace", workspaceDir],
	] as const) {
		let existing = dir;
		while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
		if (!statSync(existing).isDirectory()) return fail(`${label} ${dir}: ${existing} is not a directory`);
	}

	mkdirSync(homeDir, { recursive: true, mode: HOME_MODE });
	chmodSync(homeDir, HOME_MODE);
	mkdirSync(secretsDir, { recursive: true, mode: HOME_MODE });
	chmodSync(secretsDir, HOME_MODE);
	mkdirSync(workspaceDir, { recursive: true });
	const chat =
		platform === "teams"
			? {
					channels: {
						teams: {
							appId: values["app-id"],
							tenantId: values.tenant,
							clientSecretFile: "secrets/teams-client-secret",
							ownerAadObjectId: values.owner,
						},
					},
				}
			: platform === "discord"
				? {
						channels: {
							discord: {
								ownerUserId: values.owner,
								botTokenFile: "secrets/discord-bot-token",
								applicationId: values["app-id"],
							},
						},
					}
				: {
						channels: { slack: { ownerUserId: values.owner } },
						slack: { botTokenFile: "secrets/slack-bot-token", appTokenFile: "secrets/slack-app-token" },
					};
	const config = {
		schemaVersion: 1,
		...chat,
		ompExecutable: omp,
		workspaceDir,
		sessionRetentionDays: 30,
	};
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: SECRET_MODE, flag: "wx" });
	chmodSync(configPath, SECRET_MODE);

	const homePrefix = env.OMPBOT_HOME === undefined || env.OMPBOT_HOME === "" ? "" : `OMPBOT_HOME=${homeDir} `;
	process.stdout.write(
		[
			`init_done home=${homeDir} config=${configPath} workspace=${workspaceDir}`,
			...(platform === "teams"
				? [
						"next: put the Teams client secret into a file (never into chat or shell history), then run doctor:",
						"  umask 077",
						`  cat > ${join(secretsDir, "teams-client-secret")}   # paste the secret then Ctrl-D`,
					]
				: platform === "discord"
					? [
							"next: put the Discord bot token into a file (never into chat or shell history), then run doctor:",
							"  umask 077",
							`  cat > ${join(secretsDir, "discord-bot-token")}   # paste the bot token then Ctrl-D`,
						]
					: [
							"next: put the two Slack tokens into files (never into chat or shell history), then run doctor:",
							"  umask 077",
							`  cat > ${join(secretsDir, "slack-bot-token")}   # paste xoxb-… then Ctrl-D`,
							`  cat > ${join(secretsDir, "slack-app-token")}   # paste xapp-… then Ctrl-D`,
						]),
			`  ${homePrefix}bun src/main.ts doctor`,
			"",
		].join("\n"),
	);
	return 0;
}
