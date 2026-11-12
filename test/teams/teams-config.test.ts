// channels.teams: parsed alone (no Slack), its secret file held to 0600 and masked, its listener loopback only;
// `ompbot init --platform teams` writes such a config.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../../src/config";
import { REDACTED, redact } from "../../src/redact";
import { APP_ID, OWNER_AAD, TENANT } from "./harness";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ompbot-teams-config-"));
	chmodSync(home, 0o700);
	writeFileSync(join(home, "teams-client-secret"), "fake-client-secret-0\n", { mode: 0o600 });
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

function writeConfig(teams: Record<string, unknown>): void {
	writeFileSync(
		join(home, "config.json"),
		JSON.stringify({
			schemaVersion: 1,
			channels: { teams },
			ompExecutable: process.execPath,
			workspaceDir: "workspace",
		}),
		{ mode: 0o600 },
	);
}

const base = {
	appId: APP_ID,
	tenantId: TENANT,
	clientSecretFile: "teams-client-secret",
	ownerAadObjectId: OWNER_AAD,
};

describe("channels.teams", () => {
	test("Teams alone is a whole config: default listener, secret path resolved, no Slack", () => {
		writeConfig(base);
		const config = loadConfig(home);
		expect(config.channels).toEqual({
			teams: { ...base, clientSecretFile: join(home, "teams-client-secret"), listen: "127.0.0.1:3978" },
		});
		expect(config.slack).toBeUndefined();
	});

	test("a listener off loopback, a non-GUID id and an unknown key are config_invalid", () => {
		for (const [teams, field] of [
			[{ ...base, listen: "0.0.0.0:3978" }, "channels.teams.listen"],
			[{ ...base, ownerAadObjectId: "owner" }, "channels.teams.ownerAadObjectId"],
			// TASK C made `guestAadObjectIds` a key: a non-GUID entry is refused, and an unknown key still is.
			[{ ...base, guestAadObjectIds: ["guest"] }, "channels.teams.guestAadObjectIds"],
			[{ ...base, guestIds: [] }, "channels.teams.guestIds"],
			[{ ...base, ownerMode: "admin" }, "channels.teams.ownerMode"],
		] as const) {
			writeConfig(teams);
			expect(() => loadConfig(home)).toThrow(`field=${field}`);
		}
	});

	test("a secret file readable by others is refused", () => {
		writeConfig(base);
		chmodSync(join(home, "teams-client-secret"), 0o644);
		expect(() => loadConfig(home)).toThrow(ConfigError);
		expect(() => loadConfig(home)).toThrow("secret_permissions");
	});

	test("an Entra client secret shape is masked", () => {
		const secret = ["abc8Q~", "x".repeat(34)].join("");
		expect(redact(`secret=${secret} end`)).toBe(`secret=${REDACTED} end`);
	});
});

describe("ompbot init --platform teams", () => {
	test("writes a Teams-only config that loads once the secret file is in place", async () => {
		const target = join(home, "fresh");
		const proc = Bun.spawn(
			[
				process.execPath,
				"src/main.ts",
				"init",
				"--platform",
				"teams",
				"--owner",
				OWNER_AAD,
				"--app-id",
				APP_ID,
				"--tenant",
				TENANT,
				"--omp",
				process.execPath,
			],
			{ env: { ...process.env, OMPBOT_HOME: target }, stdout: "pipe", stderr: "pipe" },
		);
		const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
		expect(code).toBe(0);
		expect(stdout).toContain("teams-client-secret");
		const written = JSON.parse(readFileSync(join(target, "config.json"), "utf8")) as Record<string, unknown>;
		expect(written.slack).toBeUndefined();
		writeFileSync(join(target, "secrets", "teams-client-secret"), "fake-client-secret-0\n", { mode: 0o600 });
		expect(loadConfig(target).channels.teams?.ownerAadObjectId).toBe(OWNER_AAD);
	});
});
