import { describe, expect, test } from "bun:test";
import { ChannelRegistry } from "../src/channel/registry";
import { REDACTED } from "../src/redact";
import { SlackChannel } from "../src/slack/channel";
import { FakeSlackTransport } from "../src/slack/fake-transport";

// Assembled at run time so no token-shaped literal sits in the source (gitleaks).
const token = ["xo", "xb-", "1234567890", "-abcdefghijKLMNOP"].join("");

function setup() {
	const transport = new FakeSlackTransport();
	const registry = new ChannelRegistry();
	registry.register(new SlackChannel(transport));
	return { transport, registry, port: registry.get("slack") };
}

describe("ChannelRegistry", () => {
	test("post, edit and an upload comment reach the adapter redacted", async () => {
		const { transport, port } = setup();
		const ref = await port.post({ conversationId: "C1" }, { text: `토큰 ${token}` });
		await port.edit(ref, { text: `고침 ${token}` });
		await port.uploadFile(
			{ conversationId: "C1" },
			{ path: "/tmp/a.txt", title: `제목 ${token}`, comment: `설명 ${token}` },
		);

		const seen = JSON.stringify(transport.calls);
		expect(seen).not.toContain(token);
		expect(
			transport.calls.map((call) => ("text" in call ? call.text : call.method === "uploadFile" ? call.comment : "")),
		).toEqual([`토큰 ${REDACTED}`, `고침 ${REDACTED}`, `설명 ${REDACTED}`]);
		const upload = transport.calls[2];
		expect(upload?.method === "uploadFile" ? upload.title : "").toBe(`제목 ${REDACTED}`);
	});

	test("forOrigin resolves a chat origin to its port and target; other origins have none", () => {
		const { registry, port } = setup();
		const resolved = registry.forOrigin("slack/ch/C1/t/1.2");
		expect(resolved?.port).toBe(port);
		expect(resolved?.port.platform).toBe("slack");
		expect(resolved?.target).toEqual({ conversationId: "C1", threadId: "1.2" });
		expect(registry.forOrigin("monitor/x")).toBeUndefined();
		expect(registry.forOrigin("telegram/dm/42")).toBeUndefined();
	});
});
