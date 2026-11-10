import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { COMMAND_TEXT } from "../src/core/types";

interface SlackManifest {
	features: { slash_commands: Array<{ command: string }> };
	oauth_config: { scopes: { bot: string[] } };
	settings: { event_subscriptions: { bot_events: string[] } };
}

/** The owner's 👍/👎 on an answer becomes turn feedback (`SlackAdapter.handleReaction`). */
const REACTION_EVENTS = ["reaction_added", "reaction_removed"];

/** Returns the list of problems; empty when the manifest matches the code. */
function checkManifest(manifest: SlackManifest): string[] {
	const problems: string[] = [];
	const declared = new Set(manifest.features.slash_commands.map((c) => c.command));
	// `!distill` and `!btw` are typed text only: the Slack app manifests do not register their slash names.
	const unregistered = new Set([COMMAND_TEXT.distill, COMMAND_TEXT.btw]);
	const wanted = new Set(Object.values(COMMAND_TEXT).filter((command) => !unregistered.has(command)));
	for (const command of wanted) if (!declared.has(command)) problems.push(`missing slash command ${command}`);
	for (const command of declared) if (!wanted.has(command)) problems.push(`unknown slash command ${command}`);
	for (const event of manifest.settings.event_subscriptions.bot_events) {
		if (!event.startsWith("message.") && !REACTION_EVENTS.includes(event)) {
			problems.push(`bot event ${event} is neither a message.* nor a reaction event`);
		}
	}
	return problems;
}

const manifest = JSON.parse(
	readFileSync(new URL("../packaging/slack-manifest.json", import.meta.url), "utf8"),
) as SlackManifest;

describe("packaging/slack-manifest.json", () => {
	test("slash commands equal COMMAND_TEXT and every bot event is message.* or a reaction event", () => {
		expect(checkManifest(manifest)).toEqual([]);
	});

	test("AC-8: subscribes to reaction_added and reaction_removed with reactions:read", () => {
		expect(manifest.settings.event_subscriptions.bot_events).toEqual(expect.arrayContaining(REACTION_EVENTS));
		expect(manifest.oauth_config.scopes.bot).toContain("reactions:read");
	});

	test("keeps im:write and reactions:write, drops the unused scopes", () => {
		const scopes = manifest.oauth_config.scopes.bot;
		expect(scopes).toContain("im:write");
		expect(scopes).toContain("reactions:write");
		for (const unused of ["users:read", "app_mentions:read"]) expect(scopes).not.toContain(unused);
	});

	test("negative: an app_mention event is reported", () => {
		const bad = structuredClone(manifest);
		bad.settings.event_subscriptions.bot_events.push("app_mention");
		expect(checkManifest(bad)).toEqual(["bot event app_mention is neither a message.* nor a reaction event"]);
	});

	test("negative: a missing slash command is reported", () => {
		const bad = structuredClone(manifest);
		bad.features.slash_commands.pop();
		expect(checkManifest(bad)).toHaveLength(1);
	});
});
