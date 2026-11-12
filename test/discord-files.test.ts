// Discord files (doc/plans/discord-channel.md §11): `discord_send_file` uploads into the conversation (a thread, or a
// reply in a DM) after the same refusal checks as Slack, and an owner's addressed message has its attachments
// downloaded from the CDN without the bot token, within Slack's count/size/magic limits.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelPort } from "../src/channel/port";
import type { CoreSink, DeliverySource, InboundMessage } from "../src/channel/types";
import { DiscordAdapter } from "../src/discord/adapter";
import { downloadDiscordAttachment } from "../src/discord/attachments";
import { DiscordChannel } from "../src/discord/channel";
import type { DiscordAttachment, DiscordMessageEvent } from "../src/discord/transport";
import { createLogger } from "../src/log";
import { redact } from "../src/redact";
import { ApprovalBroker } from "../src/safety/approval";
import { buildHostTools, type HostToolDef } from "../src/safety/host-tools";
import { SlackChannel } from "../src/slack/channel";
import { openStore, type Store } from "../src/store/db";
import { registryOf } from "./helpers/channels";
import { type FakeDiscordCall, FakeDiscordTransport } from "./helpers/discord-fake-transport";
import { FakeSlackTransport } from "./helpers/slack-fake-transport";

const OWNER = "100000000000000001";
const STRANGER = "100000000000000002";
const BOT = "500000000000000000";
const GUILD = "300000000000000001";
const CH = "111111111111111111";
const THREAD = "222222222222222222";
const DM = "123456789012345678";
const QUESTION = "700000000000000001";
const MIB = 1024 * 1024;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const CDN = "https://cdn.discordapp.com/attachments";

let dir: string;
let homeDir: string;
let workspaceDir: string;
let store: Store;
let transport: FakeDiscordTransport;
let logs: string[];

const log = () => createLogger({ sink: (line) => logs.push(line), clock: { now: () => 0 }, redact });
const uploads = () =>
	transport.calls.filter((c): c is Extract<FakeDiscordCall, { method: "uploadFile" }> => c.method === "uploadFile");
const downloads = () =>
	transport.calls.filter(
		(c): c is Extract<FakeDiscordCall, { method: "downloadAttachment" }> => c.method === "downloadAttachment",
	);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-discord-files-"));
	homeDir = join(dir, "home");
	workspaceDir = join(homeDir, "workspace");
	mkdirSync(join(homeDir, "secrets"), { recursive: true });
	mkdirSync(workspaceDir, { recursive: true });
	store = openStore({ timezone: "Asia/Seoul", path: join(dir, "ompbot.db"), clock: { now: () => 0 }, redact });
	transport = new FakeDiscordTransport({ botUserId: BOT });
	transport.setChannel({ id: CH, type: 0, guildId: GUILD });
	transport.setChannel({ id: THREAD, type: 11, parentId: CH, guildId: GUILD });
	transport.setChannel({ id: DM, type: 1 });
	logs = [];
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("discord_send_file", () => {
	function sendFile(
		originKey: string,
		threadTs: string | undefined,
		port: ChannelPort = new DiscordChannel(transport, { ownerUserId: OWNER }),
	): HostToolDef {
		const channels = registryOf(port);
		const tools = buildHostTools({
			originKey,
			channels,
			broker: new ApprovalBroker({ timezone: "Asia/Seoul", channels, ownerUserId: OWNER, log: log(), store }),
			log: log(),
			homeDir,
			workspaceDir,
			userHome: join(dir, "user"),
			threadTs: () => threadTs,
		});
		const tool = tools.find((t) => t.name.endsWith("_send_file"));
		if (tool === undefined) throw new Error("no upload tool");
		return tool;
	}
	const ctx = { signal: new AbortController().signal };

	test("a server thread conversation: the file goes into the thread channel with the comment as content", async () => {
		writeFileSync(join(workspaceDir, "report.txt"), "보고서");
		const tool = sendFile(`discord/ch/${CH}/t/${THREAD}`, THREAD);
		expect(tool.name).toBe("discord_send_file");
		const result = await tool.execute({ path: "report.txt", comment: "*요약* 첨부" }, ctx);
		const [upload] = uploads();
		expect(uploads()).toHaveLength(1);
		expect(upload?.channelId).toBe(THREAD);
		expect(upload?.messageReference).toBeUndefined();
		expect(upload?.content).toBe("**요약** 첨부");
		expect(result).toBe(`uploaded report.txt to the conversation thread (file id ${upload?.id})`);
	});

	test("a DM: the file goes as a reply to the owner's message", async () => {
		writeFileSync(join(workspaceDir, "a.txt"), "a");
		await sendFile(`discord/dm/${DM}`, QUESTION).execute({ path: "a.txt", comment: "여기" }, ctx);
		const [upload] = uploads();
		expect(upload?.channelId).toBe(DM);
		expect(upload?.messageReference).toEqual({ messageId: QUESTION });
		expect(upload?.content).toBe("여기");
	});

	test("the result line has the same shape as slack_send_file's", async () => {
		writeFileSync(join(workspaceDir, "a.txt"), "a");
		const shape = (text: string) => text.replace(/\(file id [^)]+\)/, "(file id ID)");
		const slack = new FakeSlackTransport();
		for (const threadTs of [QUESTION, undefined]) {
			const discord = await sendFile(`discord/dm/${DM}`, threadTs).execute({ path: "a.txt" }, ctx);
			const slackResult = await sendFile(
				"slack/dm/D0OWNER",
				threadTs === undefined ? undefined : "1.2",
				new SlackChannel(slack),
			).execute({ path: "a.txt" }, ctx);
			expect(shape(discord)).toBe(shape(slackResult));
		}
	});

	test("secret paths, token-bearing files and files over 25 MiB are refused before any upload", async () => {
		const tool = sendFile(`discord/dm/${DM}`, QUESTION);
		writeFileSync(join(homeDir, "secrets", "discord-bot-token"), "x");
		await expect(tool.execute({ path: join(homeDir, "secrets", "discord-bot-token") }, ctx)).rejects.toThrow(
			"protected directory",
		);
		// Assembled at run time so no token-shaped literal sits in the source (gitleaks).
		writeFileSync(join(workspaceDir, "leak.txt"), `token ${["xo", "xb-", "1234567890", "-abcdefghijKLMNOP"].join("")}`);
		await expect(tool.execute({ path: "leak.txt" }, ctx)).rejects.toThrow("token-like secret");
		writeFileSync(join(workspaceDir, "big.bin"), "");
		truncateSync(join(workspaceDir, "big.bin"), 25 * MIB + 1);
		await expect(tool.execute({ path: "big.bin" }, ctx)).rejects.toThrow("25 MiB");
		expect(uploads()).toHaveLength(0);
	});
});

describe("inbound attachments", () => {
	let inbound: InboundMessage[];
	let seq: bigint;

	const noDeliveries: DeliverySource = { claimDue: () => [], confirm: () => {}, fail: () => {}, defer: () => {} };
	const core = (): CoreSink => ({
		onInbound: (message) => {
			inbound.push(message);
			return undefined;
		},
		onCommand: () => undefined,
		onAction: () => {},
		knowsThread: () => false,
	});

	async function adapter(): Promise<DiscordAdapter> {
		const made = new DiscordAdapter({
			channel: new DiscordChannel(transport, { ownerUserId: OWNER }),
			core: core(),
			deliveries: noDeliveries,
			ownerUserId: OWNER,
			clock: { now: () => 1_800_000_000_000 },
			log: log(),
			mediaRoot: join(homeDir, "media"),
		});
		await made.start();
		return made;
	}

	function file(name: string, contentType: string, bytes: Uint8Array, size = bytes.length): DiscordAttachment {
		seq += 1n;
		const id = String(400_000_000_000_000_000n + seq);
		const url = `${CDN}/${CH}/${id}/${name}`;
		transport.downloads.set(url, bytes);
		return { id, filename: name, size, url, content_type: contentType };
	}

	function dmWith(attachments: DiscordAttachment[], overrides: Partial<DiscordMessageEvent> = {}): DiscordMessageEvent {
		seq += 1n;
		return {
			id: String(700_000_000_000_000_000n + seq),
			channel_id: DM,
			author: { id: OWNER },
			content: "이거 봐줘",
			type: 0,
			attachments,
			...overrides,
		};
	}

	beforeEach(() => {
		inbound = [];
		seq = 0n;
	});

	test("an owner DM's image and document are saved and noted at the end of the text, fetched without Authorization", async () => {
		await adapter();
		const image = file("shot.png", "image/png", PNG);
		const doc = file("notes.txt", "text/plain", new TextEncoder().encode("메모"));
		await transport.emitMessage(dmWith([image, doc]));
		expect(inbound).toHaveLength(1);
		const lines = inbound[0]?.text.split("\n") ?? [];
		expect(lines[0]).toBe("이거 봐줘");
		const notes = lines.slice(1);
		expect(notes).toHaveLength(2);
		expect(notes[0]).toMatch(/^\[첨부: .+\.png \(image\/png\)\]$/);
		expect(notes[1]).toMatch(/^\[첨부: .+\.txt \(text\/plain\)\]$/);
		const imagePath = /^\[첨부: (.+) \(/.exec(notes[0] ?? "")?.[1] ?? "";
		expect(readFileSync(imagePath)).toEqual(Buffer.from(PNG));
		// The two downloads run in parallel, so they are compared by URL, not by call order.
		const caps = new Map(downloads().map((d) => [d.url, [d.maxBytes, d.requireImageMagic === true]]));
		expect(caps).toEqual(
			new Map([
				[image.url, [25 * MIB, true]],
				[doc.url, [20 * MIB, false]],
			]),
		);
		expect(transport.downloadRequests).toHaveLength(2);
		for (const request of transport.downloadRequests) {
			expect(Object.keys(request.headers).map((k) => k.toLowerCase())).not.toContain("authorization");
		}
	});

	test("a stranger's message and an unaddressed server root download nothing", async () => {
		await adapter();
		await transport.emitMessage(dmWith([file("a.png", "image/png", PNG)], { author: { id: STRANGER } }));
		await transport.emitMessage(
			dmWith([file("b.png", "image/png", PNG)], { channel_id: CH, guild_id: GUILD, content: "멘션 없음" }),
		);
		expect(inbound).toHaveLength(0);
		expect(downloads()).toHaveLength(0);
		expect(transport.downloadRequests).toHaveLength(0);
	});

	test("at most six files per message; the rest are noted as skipped", async () => {
		await adapter();
		const files = Array.from({ length: 8 }, (_, i) =>
			file(`f${i}.txt`, "text/plain", new TextEncoder().encode(`${i}`)),
		);
		await transport.emitMessage(dmWith(files));
		expect(downloads()).toHaveLength(6);
		expect(inbound[0]?.text).toContain("[첨부 생략: 2개");
	});

	test("an image over 25 MiB and a document over 20 MiB are refused without downloading", async () => {
		await adapter();
		const image = file("huge.png", "image/png", PNG, 25 * MIB + 1);
		const doc = file("huge.pdf", "application/pdf", new Uint8Array([1]), 20 * MIB + 1);
		const fine = file("ok.png", "image/png", PNG, 25 * MIB);
		await transport.emitMessage(dmWith([image, doc, fine]));
		expect(downloads().map((d) => d.url)).toEqual([fine.url]);
		const text = inbound[0]?.text ?? "";
		expect(text).toContain("[첨부 실패: huge.png");
		expect(text).toContain("[첨부 실패: huge.pdf");
	});

	test("an image whose bytes are not an image is dropped (magic check)", async () => {
		await adapter();
		const fake = file("fake.png", "image/png", new TextEncoder().encode("<html>login</html>"));
		await transport.emitMessage(dmWith([fake]));
		const text = inbound[0]?.text ?? "";
		expect(text).toContain("[첨부 실패: fake.png");
		expect(text).toContain("not_an_image");
		expect(existsSync(join(homeDir, "media", "inbound"))).toBe(true);
		const saved = /\[첨부: (.+) \(/.exec(text);
		expect(saved).toBeNull();
	});

	test("an attachment-only message still reaches the core with just the notes", async () => {
		await adapter();
		await transport.emitMessage(dmWith([file("only.png", "image/png", PNG)], { content: "" }));
		expect(inbound).toHaveLength(1);
		expect(inbound[0]?.text).toMatch(/^\[첨부: .+\.png \(image\/png\)\]$/);
	});
});

describe("downloadDiscordAttachment", () => {
	test("sends no Authorization header and refuses hosts outside the Discord CDN", async () => {
		const seen: Array<{ url: string; headers: Headers }> = [];
		const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
			seen.push({ url: String(input), headers: new Headers(init?.headers) });
			return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
		}) as typeof fetch;
		const dest = join(dir, "x.png");
		const ok = await downloadDiscordAttachment({
			url: `${CDN}/1/2/x.png`,
			destPath: dest,
			maxBytes: MIB,
			requireImageMagic: true,
			fetchImpl,
		});
		expect(ok.ok).toBe(true);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.headers.has("authorization")).toBe(false);
		const media = await downloadDiscordAttachment({
			url: "https://media.discordapp.net/attachments/1/2/y.png",
			destPath: join(dir, "y.png"),
			maxBytes: MIB,
			fetchImpl,
		});
		expect(media.ok).toBe(true);
		const refused = await downloadDiscordAttachment({
			url: "https://evil.example.com/x.png",
			destPath: join(dir, "z.png"),
			maxBytes: MIB,
			fetchImpl,
		});
		expect(refused).toEqual({ ok: false, error: "host_not_allowed" });
		expect(seen).toHaveLength(2);
	});
});
