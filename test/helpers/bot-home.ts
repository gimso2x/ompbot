import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OmpbotConfig } from "../../src/config";
import { type FakeCall, FakeSlackTransport } from "../../src/slack/fake-transport";

export const OWNER = "UOWNER";

export interface TestHome {
	dir: string;
	/** Same shape `loadConfig` returns for this home. */
	config: OmpbotConfig;
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
			ownerSlackUserId: OWNER,
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
			ownerSlackUserId: OWNER,
			slack: { botTokenFile, appTokenFile },
			ompExecutable,
			workspaceDir,
		},
		remove: () => rmSync(dir, { recursive: true, force: true }),
	};
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
