// Discord buttons (doc/plans/discord-channel.md §9): `ActionButton`s go out as Action Rows of button components, with
// Discord's limits (5 per row, 80-char labels, 100-char custom ids), and `buttons: []` clears them.
import { beforeEach, describe, expect, test } from "bun:test";
import type { ActionButton } from "../src/channel/port";
import { DiscordChannel } from "../src/discord/channel";
import { type FakeDiscordCall, FakeDiscordTransport } from "../src/discord/fake-transport";
import { approvalActionId, choiceActionId } from "../src/safety/approval";
import { taskMergeActionId, taskRecommendActionId } from "../src/tasks/notify";

const OWNER = "100000000000000001";
const DM = "123456789012345678";

let transport: FakeDiscordTransport;
let port: DiscordChannel;

const calls = <M extends FakeDiscordCall["method"]>(method: M) =>
	transport.calls.filter((c): c is FakeDiscordCall & { method: M } => c.method === method);

const button = (n: number, style?: ActionButton["style"]): ActionButton => ({
	actionId: `ompbot:test:${n}`,
	label: `버튼 ${n}`,
	...(style === undefined ? {} : { style }),
});

beforeEach(() => {
	transport = new FakeDiscordTransport();
	transport.setChannel({ id: DM, type: 1 });
	port = new DiscordChannel(transport, { ownerUserId: OWNER });
});

describe("buttons as components", () => {
	test("three buttons are one Action Row of three buttons: primary→1, danger→4, no style→2", async () => {
		await port.post(
			{ conversationId: DM },
			{ text: "고르세요", buttons: [button(1, "primary"), button(2, "danger"), button(3)] },
		);
		expect(calls("createMessage")[0]?.components).toEqual([
			{
				type: 1,
				components: [
					{ type: 2, style: 1, label: "버튼 1", custom_id: "ompbot:test:1" },
					{ type: 2, style: 4, label: "버튼 2", custom_id: "ompbot:test:2" },
					{ type: 2, style: 2, label: "버튼 3", custom_id: "ompbot:test:3" },
				],
			},
		]);
	});

	test("six buttons are two Action Rows, five and one", async () => {
		await port.post({ conversationId: DM }, { text: "많음", buttons: [1, 2, 3, 4, 5, 6].map((n) => button(n)) });
		const rows = calls("createMessage")[0]?.components as Array<{ type: number; components: unknown[] }>;
		expect(rows.map((row) => [row.type, row.components.length])).toEqual([
			[1, 5],
			[1, 1],
		]);
	});

	test("a label over 80 characters is cut to 80", async () => {
		await port.post(
			{ conversationId: DM },
			{ text: "긴 라벨", buttons: [{ actionId: "ompbot:test:long", label: "가".repeat(90) }] },
		);
		const rows = calls("createMessage")[0]?.components as Array<{ components: Array<{ label: string }> }>;
		expect(rows[0]?.components[0]?.label).toBe("가".repeat(80));
	});

	test("a custom_id over 100 characters fails before anything is posted", async () => {
		const tooLong = { actionId: `ompbot:${"x".repeat(100)}`, label: "넘침" };
		await expect(port.post({ conversationId: DM }, { text: "넘침", buttons: [tooLong] })).rejects.toThrow(/custom_id/);
		expect(calls("createMessage")).toHaveLength(0);
	});

	test("an edit with buttons: [] sends components: []; an edit with buttons sends the new rows", async () => {
		const ref = await port.post({ conversationId: DM }, { text: "카드", buttons: [button(1, "primary")] });
		await port.edit(ref, { text: "결정됨", buttons: [] });
		expect(calls("editMessage")[0]).toMatchObject({ channelId: DM, messageId: ref.messageId, components: [] });
		await port.edit(ref, { text: "다시", buttons: [button(2)] });
		expect(calls("editMessage")[1]?.components).toEqual([
			{ type: 1, components: [{ type: 2, style: 2, label: "버튼 2", custom_id: "ompbot:test:2" }] },
		]);
	});

	test("like Slack's blocks: a card redrawn without buttons drops them, a plain text edit leaves components alone", async () => {
		const ref = await port.post({ conversationId: DM }, { text: "카드", title: "제목", buttons: [button(1)] });
		await port.edit(ref, { text: "카드", title: "제목", body: "결정됨" });
		await port.edit(ref, { text: "글만 수정" });
		const [card, plain] = calls("editMessage");
		expect(card?.components).toEqual([]);
		expect(plain !== undefined && "components" in plain).toBe(false);
	});

	test("the real approval, choice and TASK action ids with 19- and 20-digit ids fit in 100 characters", () => {
		for (const id of ["1234567890123456789", "12345678901234567890"]) {
			const ids = [
				approvalActionId("approve", id, id),
				approvalActionId("deny", id, id),
				approvalActionId("retry", id, id),
				choiceActionId(24, id, id),
				taskMergeActionId("T-20261110-08"),
				taskRecommendActionId("T-20261110-08"),
			];
			for (const actionId of ids) expect(actionId.length).toBeLessThanOrEqual(100);
		}
	});
});
