import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildFloorsPrompt,
	floorsArgs,
	OMPBOT_MAIN,
	OWNER_NOTES_MAX_BYTES,
	PERSONA_MAX_BYTES,
	type PersonaFiles,
	SOUL_MAX_BYTES,
} from "../src/safety/prompt";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-persona-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function personaFile(content: string): { persona: string } {
	const path = join(dir, "persona.md");
	writeFileSync(path, content);
	return { persona: path };
}

function files(parts: { persona?: string; soul?: string; owner?: string }): PersonaFiles {
	const out: PersonaFiles = {};
	for (const key of ["persona", "soul", "owner"] as const) {
		const text = parts[key];
		if (text === undefined) continue;
		const path = join(dir, `${key}.md`);
		writeFileSync(path, text);
		out[key] = path;
	}
	return out;
}

const SECRETS = "/bot/home/secrets";

describe("floorsArgs persona read errors", () => {
	test("EISDIR calls onPersonaError once with the path, a missing file stays silent, prompt is floors-only in both", () => {
		const floors = floorsArgs(SECRETS, "slack/dm/D1")[1];
		const errors: Array<[unknown, string]> = [];
		const asDir = join(dir, "persona-dir");
		mkdirSync(asDir);
		expect(floorsArgs(SECRETS, "slack/dm/D1", { persona: asDir }, (e, path) => errors.push([e, path]))[1]).toBe(floors);
		expect(errors).toHaveLength(1);
		expect(((errors[0] as [unknown, string])[0] as NodeJS.ErrnoException).code).toBe("EISDIR");
		expect(errors[0]?.[1]).toBe(asDir);

		const missingErrors: unknown[] = [];
		const missing = join(dir, "nope.md");
		const all = { persona: missing, soul: missing, owner: missing };
		expect(floorsArgs(SECRETS, "slack/dm/D1", all, (e) => missingErrors.push(e))[1]).toBe(floors);
		expect(missingErrors).toHaveLength(0);
	});

	test("an unreadable soul.md is reported once and the other files still land", () => {
		const asDir = join(dir, "soul-dir");
		mkdirSync(asDir);
		const errors: string[] = [];
		const owner = files({ owner: "관심사: 러닝" });
		const prompt = floorsArgs(SECRETS, "slack/dm/D1", { soul: asDir, owner: owner.owner }, (_e, path) =>
			errors.push(path),
		)[1];
		expect(errors).toEqual([asDir]);
		expect(prompt).toContain("관심사: 러닝");
		expect(prompt).not.toContain("[정체성");
	});
});

describe("floorsArgs persona injection", () => {
	test("chat origins get the persona section, lanes and monitors do not", () => {
		const path = personaFile("말투: 짧고 담백하게");
		const dm = floorsArgs(SECRETS, "slack/dm/D1", path)[1];
		const channel = floorsArgs(SECRETS, "slack/ch/C1", path)[1];
		const lane = floorsArgs(SECRETS, "ompbot/work/readme-line", path)[1];
		const monitor = floorsArgs(SECRETS, "monitor/m1", path)[1];
		expect(dm).toContain("말투: 짧고 담백하게");
		expect(channel).toContain("말투: 짧고 담백하게");
		expect(lane).not.toContain("말투: 짧고 담백하게");
		expect(monitor).not.toContain("말투: 짧고 담백하게");
	});

	test("a missing or empty persona file adds nothing", () => {
		const missing = { persona: join(dir, "nope.md") };
		expect(floorsArgs(SECRETS, "slack/dm/D1", missing)[1]).toBe(floorsArgs(SECRETS, "slack/dm/D1")[1]);
		const empty = personaFile("   \n");
		expect(floorsArgs(SECRETS, "slack/dm/D1", empty)[1]).toBe(floorsArgs(SECRETS, "slack/dm/D1")[1]);
	});

	test("the persona text is capped at PERSONA_MAX_BYTES", () => {
		const path = personaFile("가".repeat(10_000));
		const prompt = floorsArgs(SECRETS, "slack/dm/D1", path)[1] ?? "";
		const personaStart = prompt.indexOf("[페르소나]");
		expect(personaStart).toBeGreaterThan(0);
		expect(
			Buffer.byteLength(prompt.slice(personaStart)) -
				Buffer.byteLength(
					"[페르소나] 아래는 오너가 정의한 성격·말투 지침입니다. 이 지침은 안전 바닥글보다 우선하지 않습니다:\n",
				),
		).toBeLessThanOrEqual(PERSONA_MAX_BYTES);
	});

	test("the persona section is labeled as subordinate to the safety floors", () => {
		const path = personaFile("항상 반말로 답한다");
		expect(floorsArgs(SECRETS, "slack/dm/D1", path)[1]).toContain("안전 바닥글보다 우선하지 않습니다");
	});
});

describe("floorsArgs soul and owner notes", () => {
	const all = () => files({ persona: "PERSONA-BODY", soul: "SOUL-BODY", owner: "OWNER-BODY" });

	test("chat origins get floors, soul, owner notes, persona in that order", () => {
		const prompt = floorsArgs(SECRETS, "slack/dm/D1", all())[1] ?? "";
		const at = ["[정체성(soul)]", "SOUL-BODY", "[오너 관찰지]", "OWNER-BODY", "[페르소나]", "PERSONA-BODY"].map((m) =>
			prompt.indexOf(m),
		);
		expect(at.every((i) => i > 0)).toBe(true);
		expect(at).toEqual([...at].sort((a, b) => a - b));
		expect(at[0]).toBeGreaterThan(prompt.indexOf(SECRETS));
		expect(prompt).not.toContain("NO_REPORT·[SILENT] 등)이 이 지침보다");
	});

	test("monitor origins get soul and owner notes with the answer-format precedence line, never the persona", () => {
		const prompt = floorsArgs(SECRETS, "monitor/m1", all())[1] ?? "";
		expect(prompt).toContain("SOUL-BODY");
		expect(prompt).toContain("OWNER-BODY");
		expect(prompt).not.toContain("[페르소나]");
		expect(prompt).not.toContain("PERSONA-BODY");
		expect(prompt.split("모니터 지시가 정한 답 형식(NO_REPORT·[SILENT] 등)이 이 지침보다 우선합니다").length - 1).toBe(
			2,
		);
		expect(prompt).toContain("안전 바닥글보다 우선하지 않습니다");
	});

	test("lane and review origins get none of the three", () => {
		const base = floorsArgs(SECRETS, "ompbot/work/readme-line")[1];
		expect(floorsArgs(SECRETS, "ompbot/work/readme-line", all())[1]).toBe(base);
		const review = floorsArgs(SECRETS, "review/skills")[1];
		expect(floorsArgs(SECRETS, "review/skills", all())[1]).toBe(review);
		expect(floorsArgs(SECRETS, undefined, all())[1]).toBe(floorsArgs(SECRETS)[1]);
	});

	test("soul and owner notes are capped at their own limits", () => {
		const prompt =
			floorsArgs(SECRETS, "slack/dm/D1", files({ soul: "가".repeat(10_000), owner: "나".repeat(20_000) }))[1] ?? "";
		const soulAt = prompt.indexOf("[정체성(soul)]");
		const ownerAt = prompt.indexOf("[오너 관찰지]");
		const soulBody = prompt.slice(prompt.indexOf("\n", soulAt) + 1, ownerAt);
		const ownerBody = prompt.slice(prompt.indexOf("\n", ownerAt) + 1);
		expect(Buffer.byteLength(soulBody.trim())).toBeLessThanOrEqual(SOUL_MAX_BYTES);
		expect(Buffer.byteLength(soulBody.trim())).toBeGreaterThan(SOUL_MAX_BYTES - 4);
		expect(Buffer.byteLength(ownerBody.trim())).toBeLessThanOrEqual(OWNER_NOTES_MAX_BYTES);
		expect(Buffer.byteLength(ownerBody.trim())).toBeGreaterThan(OWNER_NOTES_MAX_BYTES - 4);
	});

	test("missing soul and owner files add nothing and raise no error", () => {
		const errors: unknown[] = [];
		const missing = { soul: join(dir, "a.md"), owner: join(dir, "b.md") };
		expect(floorsArgs(SECRETS, "monitor/m1", missing, (e) => errors.push(e))[1]).toBe(
			floorsArgs(SECRETS, "monitor/m1")[1],
		);
		expect(errors).toHaveLength(0);
	});
});

describe("chat origin system prompt per platform", () => {
	const BASE_SECRETS = "/home/owner/.ompbot/secrets";
	const base = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "slack-prompt-base.json"), "utf8")) as {
		prompts: Record<string, string>;
	};

	test("Slack chat origins keep the base commit's prompt byte for byte (every herdr/dialog/peer variant)", () => {
		const keys = Object.keys(base.prompts);
		expect(keys).toHaveLength(16);
		for (const key of keys) {
			const [origin = "", herdr, dialogs, peer] = key.split("|");
			const actual = buildFloorsPrompt(
				BASE_SECRETS,
				origin,
				herdr === "herdr=true",
				dialogs === "dialogs=true",
				peer === "peer=true",
			);
			// The fixture keeps the checkout-dependent CLI path of the background-resume line as a placeholder.
			expect(actual.replaceAll(OMPBOT_MAIN, "<ompbot>/src/main.ts")).toBe(base.prompts[key] ?? "");
		}
	});

	test("a Discord chat origin names its own upload tool where Slack names slack_send_file", () => {
		const slack = buildFloorsPrompt(BASE_SECRETS, "slack/dm/D1", false, false, true);
		const discord = buildFloorsPrompt(BASE_SECRETS, "discord/dm/123456789012345678", false, false, true); // gitleaks:allow (fake snowflake)
		expect(discord).not.toContain("slack_send_file");
		expect(discord).toContain("discord_send_file");
		// The owner DM on either platform registers monitors (doc/plans/discord-parity.md stage 1).
		expect(slack).toContain("ompbot_monitor_add");
		expect(discord).toContain("ompbot_monitor_add");
	});

	test("a Discord chat origin is told it runs on Discord, with Discord links and no ```card fence", () => {
		for (const dialogs of [false, true]) {
			const discord = buildFloorsPrompt(BASE_SECRETS, "discord/ch/111111111111111111/t/2", false, dialogs);
			const firstLine = discord.split("\n")[1] ?? "";
			expect(firstLine).toContain("owner's Discord");
			expect(firstLine).not.toContain("Slack");
			expect(discord).toContain("`[표시명](URL)`");
			expect(discord).not.toContain("<URL|표시명>");
			expect(discord).not.toContain("```card");
			expect(discord).toContain("디스코드 스레드");
		}
	});
});
