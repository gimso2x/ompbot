import { describe, expect, test } from "bun:test";
import { SlackChannel } from "../src/slack/channel";
import { FakeSlackTransport } from "./helpers/slack-fake-transport";

describe("SlackChannel over FakeSlackTransport", () => {
	test("post lands one message in the target thread; edit, react and permalink address that same message", async () => {
		const transport = new FakeSlackTransport();
		const channel = new SlackChannel(transport);
		const ref = await channel.post({ conversationId: "C1", threadId: "100.1" }, { text: "안녕" });

		const posts = transport.calls.filter((call) => call.method === "postMessage");
		expect(posts).toHaveLength(1);
		expect(posts[0]).toMatchObject({ channel: "C1", threadTs: "100.1", text: "안녕" });
		const ts = posts[0]?.method === "postMessage" ? posts[0].ts : "";
		expect(ref).toMatchObject({ platform: "slack", conversationId: "C1", messageId: ts, threadId: "100.1" });

		await channel.edit(ref, { text: "고침" });
		await channel.react(ref, "eyes", true);
		await channel.react(ref, "eyes", false);
		const link = await channel.permalink(ref);

		expect(transport.calls.slice(1)).toEqual([
			{ method: "updateMessage", channel: "C1", ts, text: "고침" },
			{ method: "addReaction", channel: "C1", timestamp: ts, name: "eyes" },
			{ method: "removeReaction", channel: "C1", timestamp: ts, name: "eyes" },
			{ method: "getPermalink", channel: "C1", ts },
		]);
		expect(link).toBe(`https://slack.test/archives/C1/p${ts.replace(".", "")}`);
	});

	test("a post without a thread goes to the channel's main view", async () => {
		const transport = new FakeSlackTransport();
		await new SlackChannel(transport).post({ conversationId: "D1" }, { text: "본문" });
		const post = transport.calls[0];
		expect(post?.method).toBe("postMessage");
		expect(post !== undefined && "threadTs" in post).toBe(false);
	});

	test("buttons reach Slack with every action id; an empty button list clears earlier blocks", async () => {
		const transport = new FakeSlackTransport();
		const channel = new SlackChannel(transport);
		const ref = await channel.post(
			{ conversationId: "C1" },
			{
				text: "고를까요",
				buttons: [
					{ actionId: "ompbot:test:yes", label: "예", style: "primary" },
					{ actionId: "ompbot:test:no", label: "아니요", style: "danger" },
				],
			},
		);
		const post = transport.calls[0];
		const blocks = JSON.stringify(post?.method === "postMessage" ? post.blocks : undefined);
		expect(blocks).toContain('"action_id":"ompbot:test:yes"');
		expect(blocks).toContain('"action_id":"ompbot:test:no"');

		await channel.edit(ref, { text: "골랐음", buttons: [] });
		expect(transport.calls[1]).toMatchObject({ method: "updateMessage", blocks: [] });
	});

	test("a card is header → section(body ?? text) → fields → actions → context; `buttons: []` drops only the actions", async () => {
		const transport = new FakeSlackTransport();
		const channel = new SlackChannel(transport);
		const header = { type: "header", text: { type: "plain_text", text: "🔐 승인 요청", emoji: true } };
		const fields = { type: "section", fields: [{ type: "mrkdwn", text: "*할 일*\n배포" }] };
		const note = { type: "context", elements: [{ type: "mrkdwn", text: "⏳ 13:30까지" }] };
		const card = {
			title: "🔐 승인 요청",
			body: "요약",
			fields: [{ label: "할 일", value: "배포" }],
			buttonsNote: "⏳ 13:30까지",
		};
		const ref = await channel.post(
			{ conversationId: "C1" },
			{ text: "알림 문구", ...card, buttons: [{ actionId: "ompbot:test:yes", label: "예" }] },
		);
		expect(transport.calls[0]).toMatchObject({
			method: "postMessage",
			text: "알림 문구",
			blocks: [
				header,
				{ type: "section", text: { type: "mrkdwn", text: "요약" } },
				fields,
				{
					type: "actions",
					elements: [{ type: "button", text: { type: "plain_text", text: "예" }, action_id: "ompbot:test:yes" }],
				},
				note,
			],
		});
		await channel.edit(ref, { text: "알림 문구", ...card, buttons: [] });
		expect(transport.calls[1]).toMatchObject({
			blocks: [header, { type: "section", text: { type: "mrkdwn", text: "요약" } }, fields, note],
		});
		// Without `body` the section shows `text`; a field longer than Slack's 2,000 characters is cut.
		await channel.edit(ref, { text: "본문", fields: [{ label: "긴 칸", value: "가".repeat(3000) }] });
		const last = transport.calls[2];
		expect(last).toMatchObject({
			blocks: [
				{ type: "section", text: { type: "mrkdwn", text: "본문" } },
				{ type: "section", fields: [{ type: "mrkdwn", text: `*긴 칸*\n${"가".repeat(2000 - "*긴 칸*\n".length)}` }] },
			],
		});
	});

	test("uploadFile keeps the thread, title and comment", async () => {
		const transport = new FakeSlackTransport();
		const { fileId } = await new SlackChannel(transport).uploadFile(
			{ conversationId: "C1", threadId: "100.1" },
			{ path: "/tmp/a.txt", title: "제목", comment: "설명" },
		);
		expect(transport.calls[0]).toEqual({
			method: "uploadFile",
			channel: "C1",
			threadTs: "100.1",
			filePath: "/tmp/a.txt",
			title: "제목",
			comment: "설명",
			fileId,
		});
	});

	test("mentionUser renders Slack's mention syntax", () => {
		expect(new SlackChannel(new FakeSlackTransport()).mentionUser("U1")).toBe("<@U1>");
	});
});
