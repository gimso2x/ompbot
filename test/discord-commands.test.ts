// Discord slash commands (doc/plans/discord-channel.md §12): the thirteen COMMAND_TEXT commands are registered at start
// (globally, or per allowed server), and an owner's command interaction is acknowledged (type 5, ephemeral) before
// the core's onCommand runs, then answered by filling or deleting the original response.
import { beforeEach, describe, expect, test } from "bun:test";
import { DENIED_TEXT } from "../src/channel/text";
import type { CoreSink, DeliverySource } from "../src/channel/types";
import { COMMAND_TEXT } from "../src/core/types";
import { DiscordAdapter, type DiscordAdapterOptions } from "../src/discord/adapter";
import { DiscordChannel } from "../src/discord/channel";
import { type FakeDiscordCall, FakeDiscordTransport } from "../src/discord/fake-transport";
import { DiscordCallError, type DiscordInteraction } from "../src/discord/transport";
import { createLogger } from "../src/log";
import { redact } from "../src/redact";

const OWNER = "100000000000000001";
const STRANGER = "100000000000000002";
const APP = "600000000000000000";
const GUILD = "300000000000000001";
const GUILD_2 = "300000000000000002";
const CH = "111111111111111111";
const THREAD = "222222222222222222";
const DM = "123456789012345678";
const GROUP_DM = "133333333333333333";

type Command = Parameters<CoreSink["onCommand"]>[0];

let transport: FakeDiscordTransport;
let commands: Command[];
let answer: (command: Command) => Promise<string | undefined> | string | undefined;
let inbound: number;
let logs: string[];
let seq: bigint;

const noDeliveries: DeliverySource = { claimDue: () => [], confirm: () => {}, fail: () => {}, defer: () => {} };

function core(): CoreSink {
	return {
		onInbound: () => {
			inbound += 1;
			return undefined;
		},
		onCommand: (command) => {
			commands.push(command);
			return answer(command);
		},
		onAction: () => {},
	};
}

async function boot(options: Partial<DiscordAdapterOptions> = {}): Promise<DiscordAdapter> {
	const adapter = new DiscordAdapter({
		channel: new DiscordChannel(transport, { ownerUserId: OWNER }),
		core: core(),
		deliveries: noDeliveries,
		ownerUserId: OWNER,
		clock: { now: () => 1_800_000_000_000 },
		log: createLogger({ sink: (line) => logs.push(line), clock: { now: () => 0 }, redact }),
		...options,
	});
	await adapter.start();
	await adapter.commandsReady();
	return adapter;
}

/** A slash command interaction: a DM by default, `guild` for a server channel, `channelType` for other DMs. */
function slash(
	name: string,
	options: { text?: string; user?: string; guild?: boolean; channel?: string; channelType?: number; id?: string } = {},
): DiscordInteraction {
	seq += 1n;
	const user = { id: options.user ?? OWNER };
	const guild = options.guild ?? false;
	const channel = options.channel ?? (guild ? CH : DM);
	return {
		id: options.id ?? String(810_000_000_000_000_000n + seq),
		application_id: APP,
		type: 2,
		token: `tok-${seq}`,
		channel_id: channel,
		channel: { id: channel, type: options.channelType ?? (guild ? 0 : 1) },
		...(guild ? { guild_id: GUILD, member: { user } } : { user }),
		data: {
			name,
			...(options.text === undefined ? {} : { options: [{ name: "text", type: 3, value: options.text }] }),
		},
	};
}

const calls = <M extends FakeDiscordCall["method"]>(method: M) =>
	transport.calls.filter((c): c is FakeDiscordCall & { method: M } => c.method === method);
const NAMES = Object.values(COMMAND_TEXT).map((text) => text.slice(1));

beforeEach(() => {
	transport = new FakeDiscordTransport();
	transport.setChannel({ id: CH, type: 0, guildId: GUILD });
	transport.setChannel({ id: THREAD, type: 11, parentId: CH, guildId: GUILD });
	commands = [];
	answer = () => undefined;
	inbound = 0;
	logs = [];
	seq = 0n;
});

describe("command registration", () => {
	test("start registers the thirteen commands globally, named without the slash; only the ones with an argument take text", async () => {
		await boot();
		const [registered, ...more] = transport.commandSets;
		expect(more).toHaveLength(0);
		expect(registered?.guildId).toBeUndefined();
		const byName = new Map(registered?.commands.map((command) => [command.name, command]));
		expect([...byName.keys()].sort()).toEqual([...NAMES].sort());
		expect(NAMES).toHaveLength(13);
		expect(NAMES).toContain("new-ompbot");
		expect(NAMES).toContain("distill-ompbot");
		expect(NAMES).toContain("btw-ompbot");
		expect(byName.get("btw-ompbot")?.options).toEqual([
			expect.objectContaining({ type: 3, name: "text", required: false }),
		]);
		for (const command of byName.values()) {
			expect(command.name).toMatch(/^[a-z0-9-]{1,32}$/);
			expect(command.description.length).toBeGreaterThan(0);
			expect(command.description.length).toBeLessThanOrEqual(100);
		}
		expect(byName.get("model-ompbot")?.options).toEqual([
			expect.objectContaining({ type: 3, name: "text", required: false }),
		]);
		expect(byName.get("new-ompbot")?.options ?? []).toEqual([]);
	});

	test("with guildIds every allowed server gets its own registration (the guild route)", async () => {
		await boot({ guildIds: [GUILD, GUILD_2] });
		const registered = transport.commandSets;
		expect(registered.map((call) => call.guildId)).toEqual([GUILD, GUILD_2]);
		for (const call of registered) expect(call.commands.map((c) => c.name).sort()).toEqual([...NAMES].sort());
	});

	test("a failed registration is a warning: the adapter still starts and takes messages", async () => {
		transport.failNext.registerCommands = [new DiscordCallError("definitive", "discord_http_403:50001 Missing Access")];
		const adapter = await boot();
		expect(adapter.botUserId).toBe("500000000000000000");
		expect(logs.some((line) => line.includes("event=discord_commands_register_failed"))).toBe(true);
		await transport.emitMessage({
			id: "700000000000000001",
			channel_id: DM,
			author: { id: OWNER },
			content: "안녕",
			type: 0,
		});
		expect(inbound).toBe(1);
	});
});

describe("command interactions", () => {
	test("the owner's command is acknowledged (type 5, ephemeral) before onCommand ends, then the answer fills it", async () => {
		await boot();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		const called = Promise.withResolvers<void>();
		answer = () => {
			called.resolve();
			return promise;
		};
		const handled = transport.emitInteraction(slash("model-ompbot", { text: "  sonnet " }));
		await called.promise;
		expect(commands).toHaveLength(1);
		expect(calls("respondInteraction")).toEqual([
			{
				method: "respondInteraction",
				interactionId: expect.any(String),
				token: "tok-1",
				response: { type: 5, data: { flags: 64 } },
			},
		]);
		expect(calls("editInteractionResponse")).toHaveLength(0);
		resolve("모델: *sonnet* <https://x.y|문서>");
		await handled;
		expect(commands[0]).toEqual({
			command: "model",
			arg: "sonnet",
			originKey: `discord/dm/${DM}`,
			channel: DM,
			userId: OWNER,
		});
		expect(calls("editInteractionResponse")).toEqual([
			{ method: "editInteractionResponse", token: "tok-1", content: "모델: **sonnet** [문서](https://x.y)" },
		]);
		expect(calls("deleteInteractionResponse")).toHaveLength(0);
	});

	test("undefined from onCommand deletes the original response (the answer comes as its own message)", async () => {
		await boot();
		await transport.emitInteraction(slash("new-ompbot"));
		expect(commands.map((c) => c.command)).toEqual(["new"]);
		expect(calls("respondInteraction").map((c) => c.response.type)).toEqual([5]);
		expect(calls("deleteInteractionResponse")).toEqual([{ method: "deleteInteractionResponse", token: "tok-1" }]);
		expect(calls("editInteractionResponse")).toHaveLength(0);
	});

	test("a server channel runs on its channel origin; a thread on the thread's origin, answered inside the thread", async () => {
		await boot();
		await transport.emitInteraction(slash("status-ompbot", { guild: true }));
		await transport.emitInteraction(slash("queue-ompbot", { guild: true, channel: THREAD, channelType: 11 }));
		expect(commands.map(({ originKey, channel }) => ({ originKey, channel }))).toEqual([
			{ originKey: `discord/ch/${CH}`, channel: CH },
			{ originKey: `discord/ch/${CH}/t/${THREAD}`, channel: THREAD },
		]);
	});

	test("a stranger gets the ephemeral denial and onCommand never runs", async () => {
		await boot();
		await transport.emitInteraction(slash("status-ompbot", { user: STRANGER, guild: true }));
		expect(commands).toHaveLength(0);
		expect(calls("respondInteraction").map((c) => c.response)).toEqual([
			{ type: 4, data: { content: DENIED_TEXT, flags: 64 } },
		]);
	});

	test("an unknown command name gets an ephemeral hint", async () => {
		await boot();
		await transport.emitInteraction(slash("nope-ompbot"));
		expect(commands).toHaveLength(0);
		const [response] = calls("respondInteraction").map((c) => c.response);
		expect(response?.type).toBe(4);
		expect(response?.data).toEqual({ content: expect.stringContaining("알 수 없는 명령: /nope-ompbot"), flags: 64 });
	});

	test("a group DM is not a place for commands: an ephemeral hint, onCommand never runs", async () => {
		await boot();
		await transport.emitInteraction(slash("status-ompbot", { channel: GROUP_DM, channelType: 3 }));
		expect(commands).toHaveLength(0);
		const [response] = calls("respondInteraction").map((c) => c.response);
		expect(response?.type).toBe(4);
		expect(response?.data).toEqual({ content: expect.stringContaining("DM"), flags: 64 });
	});

	test("a replayed interaction id runs the command once", async () => {
		await boot();
		await transport.emitInteraction(slash("status-ompbot", { id: "820000000000000001" }));
		await transport.emitInteraction(slash("status-ompbot", { id: "820000000000000001" }));
		expect(commands).toHaveLength(1);
	});

	test("a failing onCommand fills the response with the failure line", async () => {
		await boot();
		answer = () => {
			throw new Error("boom");
		};
		await transport.emitInteraction(slash("usage-ompbot"));
		expect(calls("editInteractionResponse").map((c) => c.content)).toEqual([
			"명령 처리에 실패했습니다. 로그를 확인하세요.",
		]);
		expect(logs.some((line) => line.includes("event=command_failed"))).toBe(true);
	});

	test("a failed channel lookup still fills the deferred response with the failure line", async () => {
		await boot();
		transport.failNext.getChannel = [new DiscordCallError("ambiguous", "discord request failed: TypeError")];
		await transport.emitInteraction(slash("status-ompbot", { guild: true }));
		expect(commands).toHaveLength(0);
		expect(calls("editInteractionResponse").map((c) => c.content)).toEqual([
			"명령 처리에 실패했습니다. 로그를 확인하세요.",
		]);
	});
});
