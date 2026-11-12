import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordRest } from "../src/discord/rest";
import { DiscordCallError, DiscordRateLimitedError, UPLOAD_LIMIT_BYTES } from "../src/discord/transport";

// Not a real token: assembled at runtime so no token-shaped literal sits in the repo.
const TOKEN = ["TEST", "discord", "token"].join(".");
const CHANNEL = "111111111111111111";

interface SeenRequest {
	method: string;
	path: string;
	search: string;
	headers: Headers;
	body: string;
	/** Multipart parts by field name (uploads only). */
	parts: Map<string, unknown> | undefined;
}

interface Server {
	base: string;
	seen: SeenRequest[];
	respond: (req: SeenRequest) => Response;
	stop(): void;
}

let server: Server | undefined;
let tmp: string | undefined;

afterEach(() => {
	server?.stop();
	server = undefined;
	if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
	tmp = undefined;
});

function startServer(respond: (req: SeenRequest) => Response = () => Response.json({ id: "900" })): Server {
	const seen: SeenRequest[] = [];
	const s: Server = {
		base: "",
		seen,
		respond,
		stop: () => {},
	};
	const bun = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const isForm = (req.headers.get("content-type") ?? "").startsWith("multipart/form-data");
			const parts = isForm ? new Map<string, unknown>((await req.formData()).entries()) : undefined;
			const body = isForm ? "" : await req.text();
			const entry: SeenRequest = {
				method: req.method,
				path: url.pathname,
				search: url.search,
				headers: req.headers,
				body,
				parts,
			};
			seen.push(entry);
			return s.respond(entry);
		},
	});
	s.base = `http://localhost:${bun.port}/api/v10`;
	s.stop = () => {
		void bun.stop(true);
	};
	return s;
}

function rest(base: string, now: () => number = () => 0): DiscordRest {
	return new DiscordRest({ token: TOKEN, baseUrl: base, now });
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected a rejection");
}

describe("DiscordRest", () => {
	test("every request carries the bot authorization and the DiscordBot user agent", async () => {
		server = startServer();
		const created = await rest(server.base).createMessage({
			channelId: CHANNEL,
			content: "안녕",
			messageReference: { messageId: "222222222222222222" },
			allowedMentions: { parse: [] },
		});
		expect(created).toEqual({ id: "900" });
		const req = server.seen[0];
		if (req === undefined) throw new Error("no request");
		expect(req.method).toBe("POST");
		expect(req.path).toBe(`/api/v10/channels/${CHANNEL}/messages`);
		expect(req.headers.get("authorization")).toBe(`Bot ${TOKEN}`);
		expect(req.headers.get("user-agent")).toStartWith("DiscordBot (");
		expect(JSON.parse(req.body)).toEqual({
			content: "안녕",
			message_reference: { message_id: "222222222222222222", fail_if_not_exists: false },
			allowed_mentions: { parse: [] },
		});
	});

	test("patchCurrentUser PATCHes the global display name onto /users/@me", async () => {
		server = startServer();
		await rest(server.base).patchCurrentUser({ displayName: "송박" });
		const req = server.seen[0];
		if (req === undefined) throw new Error("no request");
		expect(req.method).toBe("PATCH");
		expect(req.path).toBe("/api/v10/users/@me");
		expect(req.headers.get("authorization")).toBe(`Bot ${TOKEN}`);
		expect(JSON.parse(req.body)).toEqual({ display_name: "송박" });
	});

	test("reaction emoji are URL-encoded into the path; edit, delete, threads and history hit their routes", async () => {
		server = startServer((req) => {
			if (req.method === "GET" && req.path.endsWith("/messages")) return Response.json([]);
			if (req.method === "GET") return Response.json({ id: CHANNEL, type: 11, parent_id: "5", guild_id: "6" });
			if (req.path.endsWith("/threads")) return Response.json({ id: "333" });
			return new Response(null, { status: 204 });
		});
		const client = rest(server.base);
		await client.addReaction({ channelId: CHANNEL, messageId: "2", emoji: "👀" });
		await client.removeReaction({ channelId: CHANNEL, messageId: "2", emoji: "👀" });
		await client.editMessage({ channelId: CHANNEL, messageId: "2", content: "x", components: [] });
		await client.deleteMessage({ channelId: CHANNEL, messageId: "2" });
		expect(await client.startThread({ channelId: CHANNEL, messageId: "2", name: "질문" })).toEqual({ id: "333" });
		expect(await client.getChannel(CHANNEL)).toEqual({ id: CHANNEL, type: 11, parentId: "5", guildId: "6" });
		expect(await client.listMessages({ channelId: CHANNEL, after: "10", limit: 100 })).toEqual([]);
		const encoded = encodeURIComponent("👀");
		expect(server.seen.map((r) => `${r.method} ${r.path}${r.search}`)).toEqual([
			`PUT /api/v10/channels/${CHANNEL}/messages/2/reactions/${encoded}/@me`,
			`DELETE /api/v10/channels/${CHANNEL}/messages/2/reactions/${encoded}/@me`,
			`PATCH /api/v10/channels/${CHANNEL}/messages/2`,
			`DELETE /api/v10/channels/${CHANNEL}/messages/2`,
			`POST /api/v10/channels/${CHANNEL}/messages/2/threads`,
			`GET /api/v10/channels/${CHANNEL}`,
			`GET /api/v10/channels/${CHANNEL}/messages?after=10&limit=100`,
		]);
		expect(JSON.parse(server.seen[2]?.body ?? "")).toEqual({ content: "x", components: [] });
	});

	test("Remaining 0 with Reset-After blocks the same route locally until the reset passes", async () => {
		let clock = 1_000;
		server = startServer(
			() =>
				new Response(JSON.stringify({ id: "900" }), {
					headers: {
						"content-type": "application/json",
						"x-ratelimit-remaining": "0",
						"x-ratelimit-reset-after": "2.5",
						"x-ratelimit-bucket": "abc",
					},
				}),
		);
		const client = rest(server.base, () => clock);
		await client.createMessage({ channelId: CHANNEL, content: "1" });
		expect(client.blockedUntil()).toBe(3_500);
		const blocked = await caught(client.createMessage({ channelId: CHANNEL, content: "2" }));
		expect(blocked).toBeInstanceOf(DiscordRateLimitedError);
		expect((blocked as DiscordRateLimitedError).retryAfterMs).toBe(2_500);
		expect(server.seen).toHaveLength(1);
		// Another route is not blocked.
		await client.createMessage({ channelId: "222222222222222222", content: "other" });
		expect(server.seen).toHaveLength(2);
		clock = 3_500;
		await client.createMessage({ channelId: CHANNEL, content: "3" });
		expect(server.seen).toHaveLength(3);
	});

	test("429 retry_after (body) and Retry-After (header) become retryAfterMs", async () => {
		let mode: "body" | "header" = "body";
		server = startServer(() =>
			mode === "body"
				? Response.json({ message: "You are being rate limited.", retry_after: 1.5, global: false }, { status: 429 })
				: new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
		);
		let clock = 0;
		const client = rest(server.base, () => clock);
		const fromBody = await caught(client.createMessage({ channelId: CHANNEL, content: "a" }));
		expect(fromBody).toBeInstanceOf(DiscordRateLimitedError);
		expect((fromBody as DiscordRateLimitedError).retryAfterMs).toBe(1_500);
		clock = 10_000;
		mode = "header";
		const fromHeader = await caught(client.createMessage({ channelId: CHANNEL, content: "b" }));
		expect(fromHeader).toBeInstanceOf(DiscordRateLimitedError);
		expect((fromHeader as DiscordRateLimitedError).retryAfterMs).toBe(2_000);
		expect(server.seen).toHaveLength(2);
	});

	test("400/401/403/404 are definitive and never retried; 500 is ambiguous", async () => {
		let status = 400;
		server = startServer(() => Response.json({ message: "nope", code: 50001 }, { status }));
		const client = rest(server.base);
		for (const code of [400, 401, 403, 404]) {
			status = code;
			const before = server.seen.length;
			const error = await caught(client.createMessage({ channelId: CHANNEL, content: "x" }));
			expect(error).toBeInstanceOf(DiscordCallError);
			expect((error as DiscordCallError).kind).toBe("definitive");
			expect((error as DiscordCallError).status).toBe(code);
			expect((error as DiscordCallError).code).toBe(50001);
			expect(server.seen.length - before).toBe(1);
		}
		status = 500;
		const before = server.seen.length;
		const error = await caught(client.createMessage({ channelId: CHANNEL, content: "x" }));
		expect((error as DiscordCallError).kind).toBe("ambiguous");
		expect(server.seen.length - before).toBe(1);
	});

	test("a network error is ambiguous", async () => {
		const gone = startServer();
		const base = gone.base;
		gone.stop();
		const error = await caught(rest(base).createMessage({ channelId: CHANNEL, content: "x" }));
		expect(error).toBeInstanceOf(DiscordCallError);
		expect((error as DiscordCallError).kind).toBe("ambiguous");
	});

	test("content over 2000 characters fails before any request", async () => {
		server = startServer();
		const client = rest(server.base);
		const error = await caught(client.createMessage({ channelId: CHANNEL, content: "a".repeat(2001) }));
		expect(error).toBeInstanceOf(DiscordCallError);
		expect((error as DiscordCallError).kind).toBe("definitive");
		await expect(client.editMessage({ channelId: CHANNEL, messageId: "1", content: "b".repeat(2001) })).rejects.toThrow(
			"2000",
		);
		expect(server.seen).toHaveLength(0);
		await client.createMessage({ channelId: CHANNEL, content: "a".repeat(2000) });
		expect(server.seen).toHaveLength(1);
	});

	test("upload sends files[0] and payload_json with the attachment entry", async () => {
		server = startServer(() => Response.json({ id: "901" }));
		tmp = mkdtempSync(join(tmpdir(), "discord-rest-"));
		const filePath = join(tmp, "report.md");
		writeFileSync(filePath, "# 보고서\n");
		const result = await rest(server.base).uploadFile({
			channelId: CHANNEL,
			filePath,
			content: "보고서입니다",
			messageReference: { messageId: "222222222222222222" },
			allowedMentions: { parse: [] },
		});
		expect(result).toEqual({ id: "901" });
		const parts = server.seen[0]?.parts;
		if (parts === undefined) throw new Error("no multipart request");
		const file = parts.get("files[0]");
		expect(file).toBeInstanceOf(Blob);
		expect((file as File).name).toBe("report.md");
		expect(await (file as File).text()).toBe("# 보고서\n");
		expect(JSON.parse(String(parts.get("payload_json")))).toEqual({
			content: "보고서입니다",
			attachments: [{ id: 0, filename: "report.md" }],
			message_reference: { message_id: "222222222222222222", fail_if_not_exists: false },
			allowed_mentions: { parse: [] },
		});
	});

	test("a file over 25 MiB fails before any request", async () => {
		server = startServer();
		tmp = mkdtempSync(join(tmpdir(), "discord-rest-"));
		const filePath = join(tmp, "big.bin");
		writeFileSync(filePath, "");
		truncateSync(filePath, UPLOAD_LIMIT_BYTES + 1);
		const error = await caught(rest(server.base).uploadFile({ channelId: CHANNEL, filePath }));
		expect(error).toBeInstanceOf(DiscordCallError);
		expect((error as DiscordCallError).kind).toBe("definitive");
		expect(String(error)).toContain("25 MiB");
		expect(server.seen).toHaveLength(0);
	});

	test("a global 429 blocks bot routes but not interaction routes; errors never carry the interaction token", async () => {
		server = startServer((req) => {
			if (req.path.endsWith("/messages")) return Response.json({ retry_after: 5, global: true }, { status: 429 });
			if (req.method === "PATCH") return new Response("not json", { status: 200 });
			return new Response(null, { status: 204 });
		});
		const client = new DiscordRest({ token: TOKEN, baseUrl: server.base, applicationId: "600", now: () => 0 });
		const first = await caught(client.createMessage({ channelId: CHANNEL, content: "a" }));
		expect((first as DiscordRateLimitedError).global).toBe(true);
		const blocked = await caught(client.createMessage({ channelId: "222222222222222222", content: "b" }));
		expect(blocked).toBeInstanceOf(DiscordRateLimitedError);
		expect((blocked as DiscordRateLimitedError).retryAfterMs).toBe(5_000);
		expect(server.seen).toHaveLength(1);
		await client.respondInteraction({ interactionId: "77", token: "itok-secret", response: { type: 6 } });
		const odd = await caught(client.editInteractionResponse({ token: "itok-secret", content: "done" }));
		expect((odd as DiscordCallError).kind).toBe("ambiguous");
		expect(String(odd)).not.toContain("itok-secret");
		expect(server.seen).toHaveLength(3);
	});

	test("interaction callback and the original-response follow-ups use the interaction and webhook routes", async () => {
		server = startServer((req) =>
			req.method === "PATCH" ? Response.json({ id: "1" }) : new Response(null, { status: 204 }),
		);
		const client = new DiscordRest({ token: TOKEN, baseUrl: server.base, applicationId: "600" });
		await client.respondInteraction({ interactionId: "77", token: "itok", response: { type: 6 } });
		await client.editInteractionResponse({ token: "itok", content: "done", allowedMentions: { parse: [] } });
		await client.deleteInteractionResponse({ token: "itok" });
		expect(server.seen.map((r) => `${r.method} ${r.path}`)).toEqual([
			"POST /api/v10/interactions/77/itok/callback",
			"PATCH /api/v10/webhooks/600/itok/messages/@original",
			"DELETE /api/v10/webhooks/600/itok/messages/@original",
		]);
		expect(JSON.parse(server.seen[0]?.body ?? "")).toEqual({ type: 6 });
		expect(JSON.parse(server.seen[1]?.body ?? "")).toEqual({ content: "done", allowed_mentions: { parse: [] } });
	});

	test("command registration overwrites the global set, or one server's with a guild id", async () => {
		server = startServer(() => Response.json([]));
		const client = new DiscordRest({ token: TOKEN, baseUrl: server.base, applicationId: "600" });
		const commands = [{ name: "status-ompbot", description: "상태", options: [] }];
		await client.registerCommands({ commands });
		await client.registerCommands({ guildId: "300000000000000001", commands });
		expect(server.seen.map((r) => `${r.method} ${r.path}`)).toEqual([
			"PUT /api/v10/applications/600/commands",
			"PUT /api/v10/applications/600/guilds/300000000000000001/commands",
		]);
		expect(JSON.parse(server.seen[0]?.body ?? "")).toEqual(commands);
	});
});
