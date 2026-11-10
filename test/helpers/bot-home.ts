import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OmpbotConfig } from "../../src/config";
import { type FakeDiscordCall, FakeDiscordTransport } from "../../src/discord/fake-transport";
import type { CreateMessageArgs, EditMessageArgs } from "../../src/discord/transport";
import { type FakeCall, FakeSlackTransport } from "../../src/slack/fake-transport";

export const OWNER = "UOWNER";

export interface TestHome {
	dir: string;
	/**
	 * Same shape `loadConfig` returns for this home, plus the Slack owner id under its pre-`channels` name for the
	 * tests that read it from there.
	 */
	config: OmpbotConfig & { ownerSlackUserId: string };
	remove(): void;
}

/**
 * A 0700 bot home with a config.json, 0600 fake token files (`xoxb-TEST-0`, `xapp-TEST-0`) and a stub `omp` that
 * only answers `--version`. Nothing here can talk to Slack or start a real omp.
 */
export function makeHome(
	prefix = "ompbot-home-",
	real: { ompExecutable: string; model: string } | undefined = undefined,
): TestHome {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	chmodSync(dir, 0o700);
	const secrets = join(dir, "secrets");
	mkdirSync(secrets, { mode: 0o700 });
	const botTokenFile = join(secrets, "slack-bot-token");
	const appTokenFile = join(secrets, "slack-app-token");
	writeFileSync(botTokenFile, "xoxb-TEST-0\n", { mode: 0o600 });
	writeFileSync(appTokenFile, "xapp-TEST-0\n", { mode: 0o600 });
	const ompExecutable = real?.ompExecutable ?? join(dir, "fake-omp");
	if (!real) writeFileSync(ompExecutable, '#!/bin/sh\necho "omp-stub 0.0.0"\n', { mode: 0o755 });
	const workspaceDir = join(dir, "workspace");
	mkdirSync(workspaceDir, { mode: 0o700 });
	const configPath = join(dir, "config.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			schemaVersion: 1,
			channels: { slack: { ownerUserId: OWNER } },
			slack: { botTokenFile: "secrets/slack-bot-token", appTokenFile: "secrets/slack-app-token" },
			ompExecutable,
			workspaceDir: "workspace",
			...(real ? { model: real.model } : {}),
		}),
		{ mode: 0o600 },
	);
	return {
		dir,
		config: {
			schemaVersion: 1,
			homeDir: dir,
			configPath,
			channels: { slack: { ownerUserId: OWNER } },
			ownerSlackUserId: OWNER,
			slack: { botTokenFile, appTokenFile },
			ompExecutable,
			workspaceDir,
		},
		remove: () => rmSync(dir, { recursive: true, force: true }),
	};
}

/** Whether a message's blocks still carry buttons: an approval card keeps its other blocks after the decision. */
export function hasButtons(blocks: readonly unknown[] | undefined): boolean {
	return (
		blocks?.some(
			(block) => typeof block === "object" && block !== null && "type" in block && block.type === "actions",
		) ?? false
	);
}

/** The Discord owner of a test home (`withDiscord`). */
export const DISCORD_OWNER = "100000000000000001";

/**
 * `config` with `channels.discord` on (owner `DISCORD_OWNER`) and its 0600 token file in the home. The token is a
 * fake; nothing in the tests talks to Discord.
 */
export function withDiscord(home: TestHome): OmpbotConfig {
	const botTokenFile = join(home.dir, "secrets", "discord-bot-token");
	writeFileSync(botTokenFile, `${["TEST", "discord", "0"].join("-")}\n`, { mode: 0o600 });
	return {
		...home.config,
		channels: {
			...home.config.channels,
			discord: { ownerUserId: DISCORD_OWNER, botTokenFile, applicationId: "600000000000000000" },
		},
	};
}

/** FakeDiscordTransport whose `waitForPosts` resolves on the createMessage that satisfies it (bounded, no polling). */
export class WaitingDiscordTransport extends FakeDiscordTransport {
	readonly #waiters = new Set<() => void>();

	override async createMessage(args: CreateMessageArgs): Promise<{ id: string }> {
		const result = await super.createMessage(args);
		for (const waiter of [...this.#waiters]) waiter();
		return result;
	}

	override async editMessage(args: EditMessageArgs): Promise<void> {
		await super.editMessage(args);
		for (const waiter of [...this.#waiters]) waiter();
	}

	/** Resolves with the first createMessage/editMessage call that satisfies `match` (bounded, no polling). */
	waitForCall(match: (call: FakeDiscordCall) => boolean, timeoutMs = 10_000): Promise<FakeDiscordCall> {
		const { promise, resolve, reject } = Promise.withResolvers<FakeDiscordCall>();
		const check = () => {
			const found = this.calls.find(match);
			if (found === undefined) return;
			clearTimeout(timer);
			this.#waiters.delete(check);
			resolve(found);
		};
		const timer = setTimeout(() => {
			this.#waiters.delete(check);
			reject(new Error(`timed out waiting for a matching Discord call; saw ${this.calls.length} calls`));
		}, timeoutMs);
		this.#waiters.add(check);
		check();
		return promise;
	}

	posts(match?: (text: string) => boolean): Extract<FakeDiscordCall, { method: "createMessage" }>[] {
		return this.calls.filter(
			(call): call is Extract<FakeDiscordCall, { method: "createMessage" }> =>
				call.method === "createMessage" && (match === undefined || match(call.content ?? "")),
		);
	}

	waitForPosts(match: (text: string) => boolean, count = 1, timeoutMs = 10_000): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const check = () => {
			if (this.posts(match).length < count) return;
			clearTimeout(timer);
			this.#waiters.delete(check);
			resolve();
		};
		const timer = setTimeout(() => {
			this.#waiters.delete(check);
			reject(new Error(`timed out waiting for ${count} matching Discord post(s); saw ${this.posts().length} posts`));
		}, timeoutMs);
		this.#waiters.add(check);
		check();
		return promise;
	}
}

/** FakeSlackTransport whose `waitForPosts` resolves on the post that satisfies it (no polling, bounded timeout). */
export class WaitingTransport extends FakeSlackTransport {
	readonly #waiters = new Set<() => void>();

	override async postMessage(args: {
		channel: string;
		text: string;
		threadTs?: string | undefined;
		blocks?: readonly unknown[] | undefined;
	}): Promise<{ ts: string }> {
		const result = await super.postMessage(args);
		for (const waiter of [...this.#waiters]) waiter();
		return result;
	}

	posts(match?: (text: string) => boolean): Extract<FakeCall, { method: "postMessage" }>[] {
		return this.calls.filter(
			(call): call is Extract<FakeCall, { method: "postMessage" }> =>
				call.method === "postMessage" && (match === undefined || match(call.text)),
		);
	}

	waitForPosts(match: (text: string) => boolean, count = 1, timeoutMs = 10_000): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const check = () => {
			if (this.posts(match).length < count) return;
			clearTimeout(timer);
			this.#waiters.delete(check);
			resolve();
		};
		const timer = setTimeout(() => {
			this.#waiters.delete(check);
			reject(new Error(`timed out waiting for ${count} matching post(s); saw ${this.posts().length} posts`));
		}, timeoutMs);
		this.#waiters.add(check);
		check();
		return promise;
	}
}
