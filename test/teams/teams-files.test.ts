// doc/plans/teams-inbound-files.md: the owner's Teams 1:1 takes uploaded files (`file.download.info`, pre-signed
// SharePoint/OneDrive URL, no header) and inline images (`image/*` on the Activity's own connector host, connector
// token) as `[첨부: …]` lines of the turn; group chats, guests and `qa` runs take none. A fake Microsoft answers every
// download in process and records what it was asked, Authorization included.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Daemon } from "../../src/daemon/daemon";
import type { ProcessRunner } from "../../src/dispatch/omp";
import { TEAMS_FILE_DOWNLOAD_INFO } from "../../src/teams/attachments";
import { buildTeamsManifest } from "../../src/teams/package";
import { teamsAlias } from "../../src/teams/types";
import { makeHome, type TestHome } from "../helpers/bot-home";
import {
	APP_ID,
	botFrameworkClaims,
	FakeMicrosoft,
	GUEST_AAD,
	messageActivity,
	PERSONAL_CHAT,
	postActivity,
	signJwt,
	startTeamsDaemon,
} from "./harness";

const SHAREPOINT = "https://contoso.sharepoint.com/personal/owner/_layouts/15/download.aspx";
const PDF = new TextEncoder().encode("%PDF-1.4 fake report\n");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);

interface DownloadCall {
	url: string;
	authorization: string | null;
}

let home: TestHome;
let ms: FakeMicrosoft;
let daemon: Daemon | undefined;
let logs: string[];
let downloads: DownloadCall[];

/** The fake Microsoft file and connector hosts (https), answered in process. */
const fakeDownloads = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	const headers = new Headers(init?.headers);
	downloads.push({ url: url.href, authorization: headers.get("authorization") });
	const path = `${url.hostname}${url.pathname}`;
	if (path === "contoso.sharepoint.com/personal/owner/_layouts/15/download.aspx") {
		const name = url.searchParams.get("f");
		if (name === "report.pdf") return new Response(PDF, { headers: { "content-type": "application/pdf" } });
		if (name === "hop") return new Response(null, { status: 302, headers: { location: "https://evil.example.com/x" } });
		if (name === "big") {
			return new Response(PDF, { headers: { "content-type": "application/pdf", "content-length": "99999999" } });
		}
	}
	if (url.pathname.startsWith("/v3/attachments/")) {
		return new Response(PNG, { headers: { "content-type": "image/png" } });
	}
	return new Response("not found", { status: 404 });
}) as typeof fetch;

async function boot(
	options: { teams?: Record<string, unknown>; guestRun?: ProcessRunner } = {},
): Promise<{ port: number; homeDir: string }> {
	const started = await startTeamsDaemon(home, ms, logs, {
		attachmentFetch: fakeDownloads,
		...(options.teams === undefined ? {} : { teams: options.teams }),
		...(options.guestRun === undefined ? {} : { guestRun: options.guestRun }),
	});
	daemon = started.daemon;
	return { port: started.port, homeDir: home.dir };
}

async function token(): Promise<string> {
	return signJwt(ms.botFrameworkKey, botFrameworkClaims(ms.serviceUrl.replace(/\/$/, "")));
}

function fileInfo(name: string, query: string, asString = false): Record<string, unknown> {
	const content = { downloadUrl: `${SHAREPOINT}?f=${query}`, uniqueId: `uid-${query}`, fileType: "pdf" };
	return { contentType: TEAMS_FILE_DOWNLOAD_INFO, name, content: asString ? JSON.stringify(content) : content };
}

/** An owner 1:1 Activity with `attachments`. */
function dmWith(id: string, text: string, attachments: unknown[]): Record<string, unknown> {
	return {
		...messageActivity({
			id,
			text,
			serviceUrl: ms.serviceUrl,
			conversationId: PERSONAL_CHAT,
			conversationType: "personal",
			mention: false,
		}),
		attachments,
	};
}

/** The owner turn's answer (the fake omp echoes its prompt). */
async function answerText(): Promise<string> {
	const call = await ms.waitFor((c) => c.body.type === "message" && String(c.body.text).includes("ECHO"));
	return String(call.body.text);
}

/** Every file saved under `<homeDir>/media/inbound/`, as `<folder>/<file>`. */
function savedFiles(homeDir: string): string[] {
	const root = join(homeDir, "media", "inbound");
	if (!existsSync(root)) return [];
	return readdirSync(root).flatMap((folder) => readdirSync(join(root, folder)).map((file) => `${folder}/${file}`));
}

beforeEach(async () => {
	home = makeHome("ompbot-teams-files-");
	logs = [];
	downloads = [];
	ms = new FakeMicrosoft();
	await ms.start();
});

afterEach(async () => {
	await daemon?.stop();
	daemon = undefined;
	await ms.stop();
	home.remove();
});

describe("Teams app package (AC-1)", () => {
	test("the bot supports files and the package version is 1.0.1", () => {
		const manifest = buildTeamsManifest({ appId: APP_ID }) as {
			version: string;
			bots: Array<{ supportsFiles: boolean }>;
		};
		expect(manifest.version).toBe("1.0.1");
		expect(manifest.bots.map((bot) => bot.supportsFiles)).toEqual([true]);
	});
});

describe("owner 1:1 uploaded files (AC-2, AC-3, AC-4b)", () => {
	test("a file-only message becomes a turn; the file lands under <homeDir>/media/inbound/ in a colon-free folder", async () => {
		const { port, homeDir } = await boot();
		const response = await postActivity(
			port,
			await token(),
			dmWith("f:1:2", "", [fileInfo("report.pdf", "report.pdf")]),
		);
		expect(response.status).toBe(200);
		const text = await answerText();

		const saved = savedFiles(homeDir);
		expect(saved).toHaveLength(1);
		const [folder, file] = (saved[0] ?? "").split("/");
		expect(folder).toBe(`${teamsAlias(PERSONAL_CHAT)}-f_1_2`);
		expect(folder).not.toContain(":");
		expect(file).toMatch(/^doc_[0-9a-f]{12}\.pdf$/);
		const path = join(homeDir, "media", "inbound", saved[0] ?? "");
		expect(readFileSync(path)).toEqual(Buffer.from(PDF));
		expect(text).toContain(`[첨부: ${path} (application/pdf)]`);
		// The pre-signed URL gets no header at all.
		expect(downloads).toEqual([{ url: `${SHAREPOINT}?f=report.pdf`, authorization: null }]);
		expect(daemon?.store.listInbound().map((row) => row.originKey)).toEqual([`teams/dm/${teamsAlias(PERSONAL_CHAT)}`]);
	});

	test("content as a JSON string is read; refused hosts, http, a bad redirect hop and an oversize file fail per line, the turn goes on", async () => {
		const { port, homeDir } = await boot();
		const attachments = [
			fileInfo("report.pdf", "report.pdf", true),
			{
				contentType: TEAMS_FILE_DOWNLOAD_INFO,
				name: "elsewhere.pdf",
				content: { downloadUrl: "https://evil.example.com/a.pdf", uniqueId: "u-evil" },
			},
			{
				contentType: TEAMS_FILE_DOWNLOAD_INFO,
				name: "plain.pdf",
				content: { downloadUrl: "http://contoso.sharepoint.com/a.pdf", uniqueId: "u-http" },
			},
			{
				contentType: TEAMS_FILE_DOWNLOAD_INFO,
				name: "lookalike.pdf",
				content: { downloadUrl: "https://contoso.sharepoint.com.evil.example/a.pdf", uniqueId: "u-look" },
			},
			fileInfo("hop.pdf", "hop"),
			fileInfo("big.pdf", "big"),
		];
		const response = await postActivity(port, await token(), dmWith("m-2", "이거 봐줘", attachments));
		expect(response.status).toBe(200);
		const text = await answerText();

		expect(text).toContain("이거 봐줘");
		expect(text).toMatch(/\[첨부: \S+doc_[0-9a-f]{12}\.pdf \(application\/pdf\)\]/);
		expect(text).toContain("[첨부 실패: elsewhere.pdf — host_not_allowed]");
		expect(text).toContain("[첨부 실패: plain.pdf — host_not_allowed]");
		expect(text).toContain("[첨부 실패: lookalike.pdf — host_not_allowed]");
		expect(text).toContain("[첨부 실패: hop.pdf — redirect_host_not_allowed:evil.example.com]");
		expect(text).toContain("[첨부 실패: big.pdf — too_large_content_length]");
		expect(savedFiles(homeDir)).toHaveLength(1);
		// Nothing outside SharePoint was ever contacted, the redirect target included.
		expect(downloads.map((call) => new URL(call.url).hostname)).toEqual([
			"contoso.sharepoint.com",
			"contoso.sharepoint.com",
			"contoso.sharepoint.com",
		]);
	});

	test("content without downloadUrl or unparsable fails its line", async () => {
		const { port } = await boot();
		const attachments = [
			{ contentType: TEAMS_FILE_DOWNLOAD_INFO, name: "broken.pdf", content: "{not json" },
			{ contentType: TEAMS_FILE_DOWNLOAD_INFO, name: "empty.pdf", content: { uniqueId: "x" } },
		];
		await postActivity(port, await token(), dmWith("m-3", "", attachments));
		const text = await answerText();
		expect(text).toContain("[첨부 실패: broken.pdf — content에 downloadUrl 없음]");
		expect(text).toContain("[첨부 실패: empty.pdf — content에 downloadUrl 없음]");
		expect(downloads).toEqual([]);
	});
});

describe("owner 1:1 inline images (AC-4)", () => {
	test("the connector token goes to the Activity's service host only; another host gets nothing", async () => {
		const { port, homeDir } = await boot();
		const serviceHost = new URL(ms.serviceUrl).hostname;
		const attachments = [
			{ contentType: "image/*", contentUrl: `https://${serviceHost}/v3/attachments/a1/views/original` },
			{ contentType: "image/*", contentUrl: "https://attacker.trafficmanager.net/v3/attachments/a2/views/original" },
			{ contentType: "text/html", content: "<div><img src='x'></div>" },
		];
		await postActivity(port, await token(), dmWith("m-4", "스샷", attachments));
		const text = await answerText();

		expect(downloads).toEqual([
			{ url: `https://${serviceHost}/v3/attachments/a1/views/original`, authorization: "Bearer fake-access-token" },
		]);
		expect(text).toMatch(/\[첨부: \S+img_[0-9a-f]{12}\.\S+ \(image\/\*\)\]/);
		expect(text).toContain("host_not_allowed]");
		expect(savedFiles(homeDir)).toHaveLength(1);
	});
});

describe("group chats, guests and qa take no files (AC-5)", () => {
	const guestRun: ProcessRunner = async () => ({ code: 0, stdout: "읽기 전용 답", timedOut: false });

	function ignoredLines(): string[] {
		return logs.filter((line) => line.includes("event=teams_attachment_ignored"));
	}

	test("owner in a group chat: reason=group", async () => {
		const { port, homeDir } = await boot({ guestRun });
		const activity = {
			...messageActivity({ id: "g-1", text: "그룹 파일", serviceUrl: ms.serviceUrl }),
			attachments: [fileInfo("report.pdf", "report.pdf")],
		};
		await postActivity(port, await token(), activity);
		await ms.waitFor((call) => String(call.body.text).includes("읽기 전용 답"));
		expect(ignoredLines()).toHaveLength(1);
		expect(ignoredLines()[0]).toContain("reason=group");
		expect(downloads).toEqual([]);
		expect(savedFiles(homeDir)).toEqual([]);
	});

	test("a guest in a 1:1: reason=guest", async () => {
		const { port, homeDir } = await boot({ guestRun, teams: { guestAadObjectIds: [GUEST_AAD] } });
		const activity = {
			...messageActivity({
				id: "q-1",
				text: "손님 파일",
				serviceUrl: ms.serviceUrl,
				aadObjectId: GUEST_AAD,
				conversationId: "a:1guestchat",
				conversationType: "personal",
				mention: false,
			}),
			attachments: [fileInfo("report.pdf", "report.pdf")],
		};
		await postActivity(port, await token(), activity);
		await ms.waitFor((call) => String(call.body.text).includes("읽기 전용 답"));
		expect(ignoredLines()).toHaveLength(1);
		expect(ignoredLines()[0]).toContain("reason=guest");
		expect(downloads).toEqual([]);
		expect(savedFiles(homeDir)).toEqual([]);
	});

	test("the owner's 1:1 under ownerMode qa: reason=qa", async () => {
		const { port, homeDir } = await boot({ guestRun, teams: { ownerMode: "qa" } });
		await postActivity(port, await token(), dmWith("o-1", "qa 파일", [fileInfo("report.pdf", "report.pdf")]));
		await ms.waitFor((call) => String(call.body.text).includes("읽기 전용 답"));
		expect(ignoredLines()).toHaveLength(1);
		expect(ignoredLines()[0]).toContain("reason=qa");
		expect(downloads).toEqual([]);
		expect(savedFiles(homeDir)).toEqual([]);
	});
});
