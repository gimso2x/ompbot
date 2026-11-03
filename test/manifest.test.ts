import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { COMMAND_TEXT } from "../src/core/types";

interface SlackManifest {
	features: { slash_commands: Array<{ command: string }> };
	oauth_config: { scopes: { bot: string[] } };
	settings: { event_subscriptions: { bot_events: string[] } };
}

/** Returns the list of problems; empty when the manifest matches the code. */
function checkManifest(manifest: SlackManifest): string[] {
	const problems: string[] = [];
	const declared = new Set(manifest.features.slash_commands.map((c) => c.command));
	const wanted = new Set(Object.values(COMMAND_TEXT));
	for (const command of wanted) if (!declared.has(command)) problems.push(`missing slash command ${command}`);
	for (const command of declared) if (!wanted.has(command)) problems.push(`unknown slash command ${command}`);
	for (const event of manifest.settings.event_subscriptions.bot_events) {
		if (!event.startsWith("message.")) problems.push(`bot event ${event} is not a message.* event`);
	}
	return problems;
}

const manifest = JSON.parse(
	readFileSync(new URL("../packaging/slack-manifest.json", import.meta.url), "utf8"),
) as SlackManifest;

describe("packaging/slack-manifest.json", () => {
	test("slash commands equal COMMAND_TEXT and every bot event is message.*", () => {
		expect(checkManifest(manifest)).toEqual([]);
	});

	test("keeps im:write and reactions:write, drops the unused scopes", () => {
		const scopes = manifest.oauth_config.scopes.bot;
		expect(scopes).toContain("im:write");
		expect(scopes).toContain("reactions:write");
		for (const unused of ["reactions:read", "users:read", "app_mentions:read"]) expect(scopes).not.toContain(unused);
	});

	test("negative: a reaction_added event is reported", () => {
		const bad = structuredClone(manifest);
		bad.settings.event_subscriptions.bot_events.push("reaction_added");
		expect(checkManifest(bad)).toEqual(["bot event reaction_added is not a message.* event"]);
	});

	test("negative: a missing slash command is reported", () => {
		const bad = structuredClone(manifest);
		bad.features.slash_commands.pop();
		expect(checkManifest(bad)).toHaveLength(1);
	});
});
