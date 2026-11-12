import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildFloorsPrompt,
	CARD_SKELETONS,
	floorsSystemPrompt,
	OMPBOT_BUN,
	OMPBOT_MAIN,
	OWNER_NOTES_MAX_BYTES,
	PERSONA_MAX_BYTES,
	type PersonaFiles,
	SOUL_MAX_BYTES,
} from "../src/safety/prompt";
import { buildTaskPrompt } from "../src/tasks/prompt";

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

describe("floorsSystemPrompt persona read errors", () => {
	test("EISDIR calls onPersonaError once with the path, a missing file stays silent, prompt is floors-only in both", () => {
		const floors = floorsSystemPrompt(SECRETS, "slack/dm/D1");
		const errors: Array<[unknown, string]> = [];
		const asDir = join(dir, "persona-dir");
		mkdirSync(asDir);
		expect(floorsSystemPrompt(SECRETS, "slack/dm/D1", { persona: asDir }, (e, path) => errors.push([e, path]))).toBe(
			floors,
		);
		expect(errors).toHaveLength(1);
		expect(((errors[0] as [unknown, string])[0] as NodeJS.ErrnoException).code).toBe("EISDIR");
		expect(errors[0]?.[1]).toBe(asDir);

		const missingErrors: unknown[] = [];
		const missing = join(dir, "nope.md");
		const all = { persona: missing, soul: missing, owner: missing };
		expect(floorsSystemPrompt(SECRETS, "slack/dm/D1", all, (e) => missingErrors.push(e))).toBe(floors);
		expect(missingErrors).toHaveLength(0);
	});

	test("an unreadable soul.md is reported once and the other files still land", () => {
		const asDir = join(dir, "soul-dir");
		mkdirSync(asDir);
		const errors: string[] = [];
		const owner = files({ owner: "관심사: 러닝" });
		const prompt = floorsSystemPrompt(SECRETS, "slack/dm/D1", { soul: asDir, owner: owner.owner }, (_e, path) =>
			errors.push(path),
		);
		expect(errors).toEqual([asDir]);
		expect(prompt).toContain("관심사: 러닝");
		expect(prompt).not.toContain("[정체성");
	});
});

describe("floorsSystemPrompt persona injection", () => {
	test("chat origins get the persona section, lanes and monitors do not", () => {
		const path = personaFile("말투: 짧고 담백하게");
		const dm = floorsSystemPrompt(SECRETS, "slack/dm/D1", path);
		const channel = floorsSystemPrompt(SECRETS, "slack/ch/C1", path);
		const lane = floorsSystemPrompt(SECRETS, "ompbot/work/readme-line", path);
		const monitor = floorsSystemPrompt(SECRETS, "monitor/m1", path);
		expect(dm).toContain("말투: 짧고 담백하게");
		expect(channel).toContain("말투: 짧고 담백하게");
		expect(lane).not.toContain("말투: 짧고 담백하게");
		expect(monitor).not.toContain("말투: 짧고 담백하게");
	});

	test("a missing or empty persona file adds nothing", () => {
		const missing = { persona: join(dir, "nope.md") };
		expect(floorsSystemPrompt(SECRETS, "slack/dm/D1", missing)).toBe(floorsSystemPrompt(SECRETS, "slack/dm/D1"));
		const empty = personaFile("   \n");
		expect(floorsSystemPrompt(SECRETS, "slack/dm/D1", empty)).toBe(floorsSystemPrompt(SECRETS, "slack/dm/D1"));
	});

	test("the persona text is capped at PERSONA_MAX_BYTES", () => {
		const path = personaFile("가".repeat(10_000));
		const prompt = floorsSystemPrompt(SECRETS, "slack/dm/D1", path);
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
		expect(floorsSystemPrompt(SECRETS, "slack/dm/D1", path)).toContain("안전 바닥글보다 우선하지 않습니다");
	});
});

describe("floorsSystemPrompt soul and owner notes", () => {
	const all = () => files({ persona: "PERSONA-BODY", soul: "SOUL-BODY", owner: "OWNER-BODY" });

	test("chat origins get floors, soul, owner notes, persona in that order", () => {
		const prompt = floorsSystemPrompt(SECRETS, "slack/dm/D1", all());
		const at = ["[정체성(soul)]", "SOUL-BODY", "[오너 관찰지]", "OWNER-BODY", "[페르소나]", "PERSONA-BODY"].map((m) =>
			prompt.indexOf(m),
		);
		expect(at.every((i) => i > 0)).toBe(true);
		expect(at).toEqual([...at].sort((a, b) => a - b));
		expect(at[0]).toBeGreaterThan(prompt.indexOf(SECRETS));
		expect(prompt).not.toContain("NO_REPORT·[SILENT] 등)이 이 지침보다");
	});

	test("monitor origins get soul and owner notes with the answer-format precedence line, never the persona", () => {
		const prompt = floorsSystemPrompt(SECRETS, "monitor/m1", all());
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
		const base = floorsSystemPrompt(SECRETS, "ompbot/work/readme-line");
		expect(floorsSystemPrompt(SECRETS, "ompbot/work/readme-line", all())).toBe(base);
		const review = floorsSystemPrompt(SECRETS, "review/skills");
		expect(floorsSystemPrompt(SECRETS, "review/skills", all())).toBe(review);
		expect(floorsSystemPrompt(SECRETS, undefined, all())).toBe(floorsSystemPrompt(SECRETS));
	});

	test("soul and owner notes are capped at their own limits", () => {
		const prompt = floorsSystemPrompt(
			SECRETS,
			"slack/dm/D1",
			files({ soul: "가".repeat(10_000), owner: "나".repeat(20_000) }),
		);
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
		expect(floorsSystemPrompt(SECRETS, "monitor/m1", missing, (e) => errors.push(e))).toBe(
			floorsSystemPrompt(SECRETS, "monitor/m1"),
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
				// The owner's `timezone: "Asia/Seoul"` gives the base commit's text byte for byte.
				{ timezone: { name: "Asia/Seoul", offset: "+09:00" } },
			);
			// The fixture keeps the checkout-dependent CLI path of the background-resume line as a placeholder.
			expect(actual.replaceAll(`${OMPBOT_BUN} ${OMPBOT_MAIN}`, "<bun> <ompbot>/src/main.ts")).toBe(
				base.prompts[key] ?? "",
			);
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

	test("a Discord chat origin is told it runs on Discord, with Discord links and the card line saying charts go ASCII", () => {
		for (const dialogs of [false, true]) {
			const discord = buildFloorsPrompt(BASE_SECRETS, "discord/ch/111111111111111111/t/2", false, dialogs);
			const firstLine = discord.split("\n")[1] ?? "";
			expect(firstLine).toContain("owner's Discord");
			expect(firstLine).not.toContain("Slack");
			expect(discord).toContain("`[표시명](URL)`");
			expect(discord).not.toContain("<URL|표시명>");
			expect(discord).toContain("```card 펜스로 json-render spec");
			expect(discord).toContain("표·차트는 ASCII 코드블록으로 바뀐다");
			expect(discord).toContain("디스코드 스레드");
		}
		// Its `ask` line says the owner answers with buttons, as on Slack.
		const askable = buildFloorsPrompt(BASE_SECRETS, "discord/dm/123456789012345678", false, true); // gitleaks:allow (fake snowflake)
		expect(askable).toContain("오너는 디스코드 버튼이나 답장으로 답한다");
		expect(askable).toContain("answers with Discord buttons or a reply");
	});

	test("Slack and Discord chat sessions get the decision card line and the card line; monitor and lane sessions neither", () => {
		const decision = "- 오너 결정이 필요하면 결정 카드로 묻는다";
		const card = "- 숫자 비교·추이·여러 칸 요약을 보일 때는 답 안에 ```card 펜스로";
		const lines = (prompt: string) => prompt.split("\n");
		for (const origin of [
			"slack/dm/D1",
			"slack/ch/C1/t/100.1",
			"discord/dm/123456789012345678",
			"discord/ch/111111111111111111/t/2",
		]) {
			for (const dialogs of [false, true]) {
				const prompt = buildFloorsPrompt(BASE_SECRETS, origin, false, dialogs);
				const line = lines(prompt).find((l) => l.startsWith(decision)) ?? "";
				expect(line).toContain("`tone`");
				expect(line).toContain("`✅ 추천`");
				expect(line).toContain("`선택지`");
				expect(line).toContain(CARD_SKELETONS[3]);
				// The ask clause only where the session may use `ask`.
				expect(line.includes("`ask`로 선택지 버튼을 띄운다(추천을 recommended로)")).toBe(dialogs);
				expect(lines(prompt).some((l) => l.startsWith(card))).toBe(true);
			}
		}
		for (const origin of ["monitor/m1", "ompbot/work/lane1"]) {
			for (const dialogs of [false, true]) {
				const prompt = buildFloorsPrompt(BASE_SECRETS, origin, false, dialogs);
				expect(prompt).not.toContain(decision);
				expect(prompt).not.toContain("```card");
			}
		}
	});

	test("no undo instructions in chat floors or the TASK worker prompt; the approval card's rollback guidance stays", () => {
		for (const origin of ["slack/dm/D1", "slack/ch/C1", "discord/dm/123456789012345678"]) {
			for (const herdr of [false, true]) {
				const prompt = buildFloorsPrompt(BASE_SECRETS, origin, herdr, true);
				expect(prompt).not.toContain("되돌리는 법");
				expect(prompt).not.toContain("how to undo");
				expect(prompt).toContain("보고에 한 일을 적는다");
				expect(prompt).toContain("say what was done in the report");
				expect(prompt).toContain("ompbot_request_approval(summary, external?, action?, why?, impact?, rollback?)");
				expect(prompt).toContain("되돌릴 수 없는 이유(rollback)");
				expect(prompt).toContain("fill at least `rollback` and `impact`");
			}
		}
		for (const mode of ["new", "resume"] as const) {
			const task = buildTaskPrompt({
				mode,
				taskId: "T-1",
				worktree: "/w",
				branch: "task/T-1",
				instruction: "x",
				timezone: "Asia/Seoul",
				now: 0,
			});
			expect(task).not.toContain("되돌리는 법");
			expect(task).not.toContain("how to undo");
			expect(task).toContain("`impact`(영향 한 줄)");
		}
	});
});
