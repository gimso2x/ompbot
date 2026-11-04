import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OmpbotConfig } from "../src/config";
import { createLogger } from "../src/log";
import { clearSecretIndex, indexSecretValue, REDACTED, redact, secretIndexSize } from "../src/redact";
import { indexEnvSecrets, indexRuntimeSecrets } from "../src/safety/secret-index";

// Assembled at runtime so secret scanners (gitleaks) do not flag the fixture; the value is unchanged.
const TOKEN = ["Tgk4dJqLm7pQ", "xZ2wVn9sBfYeHc"].join("");
const TOKEN_REVERSED = [...TOKEN].reverse().join("");

beforeEach(() => {
	clearSecretIndex();
});

afterEach(() => {
	clearSecretIndex();
});

describe("indexSecretValue + redact", () => {
	test("masks the raw value, a fragment, and the transformed forms", () => {
		expect(indexSecretValue(TOKEN)).toBe(true);
		expect(redact(`토큰은 ${TOKEN} 입니다`)).toBe(`토큰은 ${REDACTED} 입니다`);
		// A 16-char window from the middle of the value, embedded in a longer blob.
		expect(redact(`blob ${TOKEN.slice(4, 24)}x end`)).toBe(`blob ${REDACTED}x end`);
		expect(redact(`reversed: ${TOKEN_REVERSED}`)).toBe(`reversed: ${REDACTED}`);
		expect(redact(`hex: ${Buffer.from(TOKEN).toString("hex")}`)).toBe(`hex: ${REDACTED}`);
		expect(redact(`HEX: ${Buffer.from(TOKEN).toString("hex").toUpperCase()}`)).toBe(`HEX: ${REDACTED}`);
		const base64 = Buffer.from(TOKEN).toString("base64");
		expect(redact(`b64: ${base64}`)).toContain(REDACTED);
	});

	test("formatting-split copies still match", () => {
		indexSecretValue(TOKEN);
		const split = `${TOKEN.slice(0, 8)} ${TOKEN.slice(8)}`;
		expect(redact(`copy: ${split}`)).toBe(`copy: ${REDACTED}`);
	});

	test("values shorter than 16 chars are not indexed", () => {
		expect(indexSecretValue("short")).toBe(false);
		expect(redact("short")).toBe("short");
	});

	test("two disjoint secrets are masked separately, without masking the text between them", () => {
		indexSecretValue("abcdefghijklmnop");
		indexSecretValue("qrstuvwxyz012345");
		const text = "abcdefghijklmnop MIDDLE xyzqrstuvwxyz012345";
		const masked = redact(text);
		expect(masked).toContain("MIDDLE");
		expect(masked).not.toContain("abcdefghijklmnop");
		expect(masked).not.toContain("qrstuvwxyz012345");
	});

	test("an empty index leaves text untouched", () => {
		expect(redact(TOKEN)).toBe(TOKEN);
	});

	test("pattern masking keeps priority and still works with the index loaded", () => {
		const slack = `xoxb-${TOKEN}`;
		// Pattern-only (nothing indexed): the xoxb form is already masked.
		expect(redact(`t ${slack}`)).toBe(`t ${REDACTED}`);
		// With the same value indexed, the result is the same token-free text.
		indexSecretValue(slack);
		expect(redact(`t ${slack}`)).toBe(`t ${REDACTED}`);
	});

	test("secretIndexSize reflects the window count and clears", () => {
		expect(secretIndexSize()).toBe(0);
		indexSecretValue(TOKEN);
		expect(secretIndexSize()).toBeGreaterThan(0);
		clearSecretIndex();
		expect(secretIndexSize()).toBe(0);
	});
});

describe("indexRuntimeSecrets", () => {
	let home: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "ompbot-secret-index-"));
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		clearSecretIndex();
	});

	function fakeConfig(botTokenFile: string, appTokenFile: string): OmpbotConfig {
		return {
			homeDir: home,
			slack: { botTokenFile, appTokenFile },
		} as unknown as OmpbotConfig;
	}

	function tokenFile(name: string, value: string): string {
		const path = join(home, name);
		writeFileSync(path, `${value}\n`);
		chmodSync(path, 0o600);
		return path;
	}

	function logger() {
		return createLogger({ sink: () => undefined, clock: { now: () => 0 }, redact });
	}

	test("indexes token files, secret-named env vars, and extra guard files", () => {
		const botToken = `xoxb-${TOKEN}`;
		const appToken = `xapp-1-${TOKEN_REVERSED}`;
		const guardFile = join(home, "extra.json");
		writeFileSync(guardFile, JSON.stringify({ anthropic_key: `sk-ant-${TOKEN}`, model: "exampleproxy/glm-5.3-flash" }));

		indexRuntimeSecrets(
			fakeConfig(tokenFile("bot", botToken), tokenFile("app", appToken)),
			{ OMPBOT_SECRET_GUARD_FILES: guardFile },
			logger(),
		);

		expect(redact(`bot ${botToken}`)).toBe(`bot ${REDACTED}`);
		expect(redact(`app ${appToken}`)).toBe(`app ${REDACTED}`);
		expect(redact(`key sk-ant-${TOKEN}`)).toBe(`key ${REDACTED}`);
		// Non-secret metadata from the same JSON is NOT masked (the over-masking guard).
		expect(redact("model exampleproxy/glm-5.3-flash")).toBe("model exampleproxy/glm-5.3-flash");
	});

	test("secret-named env vars are indexed but pointer-style names are not read", () => {
		const value = `plain-${TOKEN}`;
		const indexed = indexRuntimeSecrets(
			fakeConfig(join(home, "missing-bot"), join(home, "missing-app")),
			{ DEPLOY_TOKEN: value, DEPLOY_TOKEN_FILE: "/etc/other-thing" },
			logger(),
		);
		// Missing token files degrade to pattern-only for those two; the env var was still indexed.
		expect(indexed).toBe(1);
		expect(redact(`v ${value}`)).toBe(`v ${REDACTED}`);
	});

	test("the dashboard path indexes env vars and guard files but never reads the Slack token files", () => {
		const envValue = `plain-${TOKEN}`;
		const guardValue = `guard-${TOKEN_REVERSED}`;
		// Shares no 16-char window with the two values above.
		const tokenValue = ["QqWwEeRrTtYyUuIi", "OoPpAaSsDdFfGgHh"].join("");
		const guardFile = join(home, "guard.json");
		writeFileSync(guardFile, JSON.stringify({ api_key: guardValue }));
		const unreadable = tokenFile("bot", tokenValue);
		chmodSync(unreadable, 0o000);

		const indexed = indexEnvSecrets({
			DEPLOY_TOKEN: envValue,
			SLACK_BOT_TOKEN_FILE: unreadable,
			SLACK_APP_TOKEN_FILE: join(home, "missing-app"),
			OMPBOT_SECRET_GUARD_FILES: `${guardFile}:${join(home, "missing-guard")}`,
		});

		expect(indexed).toBe(2);
		expect(redact(`env ${envValue}`)).toBe(`env ${REDACTED}`);
		expect(redact(`guard ${guardValue}`)).toBe(`guard ${REDACTED}`);
		chmodSync(unreadable, 0o600);
		expect(redact(`file ${tokenValue}`)).toBe(`file ${tokenValue}`);
	});
});
