import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, type TeamsChannelConfig } from "../config";
import { hasConfig } from "../dashboard/snapshot-assembly";
import { DEFAULT_GRAPH_BASE, DEFAULT_LOGIN_BASE, GRAPH_SCOPE, writeGraphTokenFile } from "../teams/graph";
import { buildTeamsPackage } from "../teams/package";

export const TEAMS_USAGE =
	"  teams package --out <zip> [--app-id <bot id>] [--name <short name>]\n" +
	"                                 the Teams app package (manifest.json with the bot id and scopes personal,groupChat,\n" +
	"                                 two default icons) for Teams' custom app upload; --app-id defaults to\n" +
	"                                 channels.teams.appId\n" +
	"  teams login                    signs the owner's Microsoft account in (device code) for the Graph chat tools and\n" +
	"                                 saves the refresh token to channels.teams.graph.tokenFile (0600); another account\n" +
	"                                 is refused (teams_graph_wrong_account)\n" +
	"  teams logout                   deletes that token file\n";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usage(message: string): number {
	process.stderr.write(`teams: ${message}\n${TEAMS_USAGE}`);
	return 2;
}

/** `ompbot teams package|login|logout`. */
export async function teamsCommand(args: string[], homeDir: string): Promise<number> {
	const [sub, ...rest] = args;
	if (sub === "login" || sub === "logout") {
		if (rest.length > 0) return usage(`${sub} takes no arguments`);
		const teams = hasConfig(homeDir) ? loadConfig(homeDir, { checkTokens: false }).channels.teams : undefined;
		if (teams === undefined) return usage(`${sub} needs channels.teams in config.json`);
		return sub === "login" ? await teamsLogin(teams, {}) : teamsLogout(teams);
	}
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

/** Microsoft's device login page the owner opens (the device code response names it too). */
export const DEVICE_LOGIN_URL = "https://microsoft.com/devicelogin";
/** `slow_down` adds this many seconds to the poll interval (RFC 8628). */
const SLOW_DOWN_SECONDS = 5;

export interface TeamsLoginDeps {
	fetch?: (input: string, init?: RequestInit) => Promise<Response>;
	/** Waits one poll interval; default a timer. */
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	out?: (line: string) => void;
	err?: (line: string) => void;
	loginBase?: string;
	graphBase?: string;
}

interface OAuthError {
	error?: unknown;
	error_description?: unknown;
	error_codes?: unknown;
}

/**
 * One line naming the cause and what to do for a device code / token endpoint error. Only the OAuth error code and
 * the AADSTS number are printed, never the response body.
 */
export function explainLoginError(body: OAuthError): string {
	const code = typeof body.error === "string" ? body.error : "unknown";
	const description = typeof body.error_description === "string" ? body.error_description : "";
	const codes = Array.isArray(body.error_codes) ? body.error_codes.map(String) : [];
	const aadsts = /AADSTS(\d+)/.exec(description)?.[1] ?? codes[0];
	const tag = `teams_login_failed error=${code}${aadsts === undefined ? "" : ` aadsts=${aadsts}`}`;
	if (code === "consent_required" || aadsts === "65001") {
		return `${tag}: 관리자 동의가 필요합니다. 테넌트 관리자가 Azure 포털 → 앱 등록 → API 권한에서 Chat.Read·User.Read·offline_access에 "관리자 동의 허용"을 눌러야 합니다.`;
	}
	if (code === "invalid_client" || aadsts === "7000218" || /public client/i.test(description)) {
		return `${tag}: 앱 등록에서 public client flow가 꺼져 있습니다. Azure 포털 → 앱 등록 → 인증 → "Allow public client flows"를 예로 켜고 다시 하세요.`;
	}
	if (code === "expired_token") return `${tag}: 코드가 만료됐습니다. ompbot teams login을 다시 하세요.`;
	if (code === "authorization_declined") return `${tag}: 로그인 화면에서 거절했습니다.`;
	return `${tag}: 위 오류 코드로 Entra 문서를 확인하세요.`;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
	try {
		return (await response.json()) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/**
 * `ompbot teams login`: device code flow against the owner's tenant, polling the token endpoint at the interval Entra
 * asks for; the token is saved (0600, atomic) only when `GET /me` is the owner's object id.
 */
export async function teamsLogin(teams: TeamsChannelConfig, deps: TeamsLoginDeps): Promise<number> {
	const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
	const err = deps.err ?? ((line: string) => process.stderr.write(`${line}\n`));
	const graph = teams.graph;
	if (graph === undefined) {
		err('teams login: channels.teams.graph가 없습니다. config.json의 channels.teams에 "graph": {}를 넣고 다시 하세요.');
		return 2;
	}
	const fetchFn = deps.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
	const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
	const now = deps.now ?? (() => Date.now());
	const loginBase = (deps.loginBase ?? DEFAULT_LOGIN_BASE).replace(/\/+$/, "");
	const graphBase = (deps.graphBase ?? DEFAULT_GRAPH_BASE).replace(/\/+$/, "");
	const endpoint = `${loginBase}/${encodeURIComponent(teams.tenantId)}/oauth2/v2.0`;
	const form = (fields: Record<string, string>): RequestInit => ({
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(fields).toString(),
	});

	const started = await fetchFn(`${endpoint}/devicecode`, form({ client_id: teams.appId, scope: GRAPH_SCOPE }));
	const device = await readJson(started);
	if (!started.ok) {
		err(explainLoginError(device));
		return 1;
	}
	const deviceCode = device.device_code;
	const userCode = device.user_code;
	if (typeof deviceCode !== "string" || typeof userCode !== "string") {
		err("teams_login_failed error=malformed_device_code");
		return 1;
	}
	const verification = typeof device.verification_uri === "string" ? device.verification_uri : DEVICE_LOGIN_URL;
	out(`teams_login code=${userCode} url=${verification}`);
	out(`브라우저에서 ${verification}을 열고 코드 ${userCode}를 넣은 뒤 오너 Microsoft 계정으로 로그인하세요.`);
	let interval = typeof device.interval === "number" && device.interval > 0 ? device.interval : 5;
	const expiresIn = typeof device.expires_in === "number" ? device.expires_in : 900;
	const deadline = now() + expiresIn * 1_000;

	let tokens: Record<string, unknown> | undefined;
	while (tokens === undefined) {
		if (now() >= deadline) {
			err(explainLoginError({ error: "expired_token" }));
			return 1;
		}
		await sleep(interval * 1_000);
		const polled = await fetchFn(
			`${endpoint}/token`,
			form({
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				client_id: teams.appId,
				device_code: deviceCode,
			}),
		);
		const body = await readJson(polled);
		if (polled.ok) {
			tokens = body;
			break;
		}
		if (body.error === "authorization_pending") continue;
		if (body.error === "slow_down") {
			interval += SLOW_DOWN_SECONDS;
			continue;
		}
		err(explainLoginError(body));
		return 1;
	}
	const access = tokens.access_token;
	const refresh = tokens.refresh_token;
	if (typeof access !== "string" || typeof refresh !== "string" || refresh === "") {
		err(
			"teams_login_failed error=no_refresh_token: offline_access 권한이 빠졌습니다. 앱 등록 API 권한에 offline_access를 넣으세요.",
		);
		return 1;
	}
	const me = await fetchFn(`${graphBase}/me?$select=id`, {
		headers: { authorization: `Bearer ${access}`, accept: "application/json" },
	});
	const profile = await readJson(me);
	if (!me.ok || typeof profile.id !== "string") {
		err(`teams_login_failed error=me_unreadable status=${me.status}`);
		return 1;
	}
	const accountId = profile.id.toLowerCase();
	if (accountId !== teams.ownerAadObjectId.toLowerCase()) {
		err(
			`teams_graph_wrong_account account=${accountId}: 로그인한 계정이 channels.teams.ownerAadObjectId(오너)와 다릅니다. 토큰을 저장하지 않았습니다. 오너 계정으로 다시 하세요.`,
		);
		return 1;
	}
	writeGraphTokenFile(graph.tokenFile, {
		refresh_token: refresh,
		scope: typeof tokens.scope === "string" ? tokens.scope : GRAPH_SCOPE,
		obtainedAt: new Date(now()).toISOString(),
		accountId,
	});
	out(`teams_graph_login_saved ${graph.tokenFile}`);
	return 0;
}

/** `ompbot teams logout`: deletes the token file (the daemon's next Graph call then asks for a login). */
export function teamsLogout(teams: TeamsChannelConfig): number {
	const tokenFile = teams.graph?.tokenFile;
	if (tokenFile === undefined) {
		process.stderr.write("teams logout: channels.teams.graph가 없습니다.\n");
		return 2;
	}
	const existed = existsSync(tokenFile);
	rmSync(tokenFile, { force: true });
	process.stdout.write(`teams_graph_logout ${existed ? "removed" : "absent"} ${tokenFile}\n`);
	return 0;
}
