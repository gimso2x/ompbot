import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogFields, Logger } from "../src/log";
import {
	buildFloorsPrompt,
	floorsSystemPrompt,
	type PersonaFiles,
	PINNED_OWNER_DOCS_FILE,
	SOUL_MAX_BYTES,
	type SpawnPromptOptions,
	spawnSystemPrompt,
} from "../src/safety/prompt";

const NOW = Date.parse("2026-11-11T08:00:00.000Z");
const MINUTE = 60_000;
const ORIGIN = "slack/dm/D1";
const SOUL = "SOUL-MARKER-이름은떡";
const OWNER_V1 = "OWNER-MARKER-v1 오너는 결론부터 원한다";
const OWNER_V2 = "OWNER-MARKER-v2 오너는 표를 좋아한다";
const PERSONA = "PERSONA-MARKER 존댓말";

interface LogRecord {
	level: string;
	event: string;
	fields: LogFields;
}

let dir: string;
let records: LogRecord[];
let log: Logger;
let files: PersonaFiles;

const record =
	(level: string) =>
	(event: string, fields: LogFields = {}): void => {
		records.push({ level, event, fields });
	};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-spawn-prompt-"));
	records = [];
	log = { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") };
	const workspace = join(dir, "workspace");
	mkdirSync(workspace);
	files = {
		soul: join(workspace, "soul.md"),
		owner: join(workspace, "owner.md"),
		persona: join(workspace, "persona.md"),
	};
	writeFileSync(files.soul as string, SOUL);
	writeFileSync(files.owner as string, OWNER_V1);
	writeFileSync(files.persona as string, PERSONA);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const sessionDir = (epoch = 1, origin = ORIGIN): string =>
	join(dir, "sessions", encodeURIComponent(origin), `e${epoch}`);

/** An omp session file whose last model call was `ageMs` before `NOW` on `provider`. */
function sessionWithCall(dirPath: string, ageMs: number, provider = "anthropic"): void {
	mkdirSync(dirPath, { recursive: true });
	const at = new Date(NOW - ageMs).toISOString();
	const lines = [
		{ type: "session", id: "s1", timestamp: at },
		{ type: "message", id: "u1", timestamp: at, message: { role: "user", content: "hi" } },
		{
			type: "message",
			id: "a1",
			timestamp: at,
			message: {
				role: "assistant",
				provider,
				model: "claude-test",
				content: [{ type: "text", text: "ok" }],
				usage: { input: 10, cacheRead: 30_000, cacheWrite: 100 },
			},
		},
		// Written at child exit, after the last call: must not count as a call.
		{ type: "custom", customType: "session_exit", id: "x1", timestamp: new Date(NOW - 1000).toISOString() },
	];
	writeFileSync(
		join(dirPath, "2026-11-11T07-00-00-000Z_s1.jsonl"),
		`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
	);
}

function spawn(overrides: Partial<SpawnPromptOptions> = {}): string {
	return spawnSystemPrompt({
		secretsDir: "/home/test/.ompbot/secrets",
		originKey: ORIGIN,
		sessionDir: sessionDir(),
		files,
		now: NOW,
		log,
		...overrides,
	});
}

const spawnLogs = (): LogFields[] =>
	records.filter((r) => r.event === "omp_spawn_prompt" && r.level === "info").map((r) => r.fields);
const lastSpawnLog = (): LogFields => {
	const all = spawnLogs();
	const last = all[all.length - 1];
	if (last === undefined) throw new Error("no omp_spawn_prompt log");
	return last;
};
const HASH = /^[0-9a-f]{16}$/;

describe("omp_spawn_prompt log (AC-1)", () => {
	test("every spawn logs the part hashes, the dynamic line names and pinned, never the raw owner docs", () => {
		const text = spawn();
		expect(spawnLogs()).toHaveLength(1);
		const fields = lastSpawnLog();
		expect(fields.origin).toBe(ORIGIN);
		expect(fields.epoch).toBe(1);
		for (const key of ["floors_static", "owner_docs", "prompt"]) expect(String(fields[key])).toMatch(HASH);
		expect(typeof fields.floors_dynamic).toBe("string");
		expect(fields.pinned).toBe(false);
		// The text itself carries the owner docs; the log does not.
		expect(text).toContain(SOUL);
		expect(text).toContain(OWNER_V1);
		const logged = JSON.stringify(records);
		for (const raw of [SOUL, OWNER_V1, PERSONA]) expect(logged).not.toContain(raw);

		spawn();
		expect(spawnLogs()).toHaveLength(2);
	});

	test("peerTouched shows in floors_dynamic while floors_static stays the same", () => {
		spawn({ peerTouched: false });
		const clean = lastSpawnLog();
		spawn({ peerTouched: true });
		const touched = lastSpawnLog();
		expect(String(clean.floors_dynamic).split(",")).not.toContain("peerTouched");
		expect(String(touched.floors_dynamic).split(",")).toContain("peerTouched");
		expect(touched.floors_static).toBe(clean.floors_static);
		expect(touched.prompt).not.toBe(clean.prompt);
	});

	test("a lane origin logs too, with no owner docs and no sidecar", () => {
		const lane = "lane/T-1";
		const laneDir = sessionDir(1, lane);
		const text = spawn({ originKey: lane, sessionDir: laneDir });
		expect(text).not.toContain(OWNER_V1);
		expect(lastSpawnLog().origin).toBe(lane);
		expect(lastSpawnLog().pinned).toBe(false);
		expect(() => statSync(join(laneDir, PINNED_OWNER_DOCS_FILE))).toThrow();
	});

	test("the unpinned text equals floorsSystemPrompt for the same inputs", () => {
		expect(spawn()).toBe(floorsSystemPrompt("/home/test/.ompbot/secrets", ORIGIN, files));
	});
});

describe("owner docs pinned per epoch while the cache is warm (AC-2)", () => {
	test("owner.md edited within an hour of the last call: the append text stays byte-identical", () => {
		const first = spawn();
		const sidecar = join(sessionDir(), PINNED_OWNER_DOCS_FILE);
		expect(statSync(sidecar).mode & 0o777).toBe(0o600);
		sessionWithCall(sessionDir(), 10 * MINUTE);
		writeFileSync(files.owner as string, OWNER_V2);

		const second = spawn();
		expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
		expect(second).toContain(OWNER_V1);
		expect(second).not.toContain(OWNER_V2);
		expect(lastSpawnLog().pinned).toBe(true);
	});

	test("last call over an hour ago: the new owner.md goes in and the sidecar is rewritten", () => {
		spawn();
		sessionWithCall(sessionDir(), 61 * MINUTE);
		writeFileSync(files.owner as string, OWNER_V2);

		const text = spawn();
		expect(text).toContain(OWNER_V2);
		expect(lastSpawnLog().pinned).toBe(false);
		const sidecar = join(sessionDir(), PINNED_OWNER_DOCS_FILE);
		expect(readFileSync(sidecar, "utf8")).toContain(OWNER_V2);
		expect(statSync(sidecar).mode & 0o777).toBe(0o600);
	});

	test("a new epoch gets the new owner.md even when the old epoch is warm", () => {
		spawn();
		sessionWithCall(sessionDir(1), 5 * MINUTE);
		writeFileSync(files.owner as string, OWNER_V2);

		const text = spawn({ sessionDir: sessionDir(2) });
		expect(text).toContain(OWNER_V2);
		expect(lastSpawnLog().epoch).toBe(2);
		expect(lastSpawnLog().pinned).toBe(false);
	});

	test("a provider with no known cache TTL never pins", () => {
		spawn();
		sessionWithCall(sessionDir(), 5 * MINUTE, "openai");
		writeFileSync(files.owner as string, OWNER_V2);
		expect(spawn()).toContain(OWNER_V2);
		expect(lastSpawnLog().pinned).toBe(false);
	});

	test("floors are never pinned: a changed floors input shows at once next to the pinned owner docs", () => {
		const first = spawn({ herdr: false });
		sessionWithCall(sessionDir(), 10 * MINUTE);
		writeFileSync(files.owner as string, OWNER_V2);

		const second = spawn({ herdr: true });
		expect(lastSpawnLog().pinned).toBe(true);
		const newFloors = buildFloorsPrompt("/home/test/.ompbot/secrets", ORIGIN, true);
		expect(second.startsWith(newFloors)).toBe(true);
		expect(second).not.toBe(first);
		expect(second).toContain(OWNER_V1);
		// The sidecar holds only the owner docs part, never the floors.
		const sidecar = readFileSync(join(sessionDir(), PINNED_OWNER_DOCS_FILE), "utf8");
		expect(sidecar).not.toContain("ompbot operating floors");
	});
});

describe("unusable sidecar (AC-3)", () => {
	test("a corrupted sidecar: fresh owner docs, pinned=false, no throw", () => {
		spawn();
		sessionWithCall(sessionDir(), 10 * MINUTE);
		const sidecar = join(sessionDir(), PINNED_OWNER_DOCS_FILE);
		writeFileSync(sidecar, readFileSync(sidecar, "utf8").replace("OWNER-MARKER-v1", "OWNER-MARKER-vX"));
		writeFileSync(files.owner as string, OWNER_V2);

		const text = spawn();
		expect(text).toContain(OWNER_V2);
		expect(lastSpawnLog().pinned).toBe(false);
		expect(records.some((r) => r.level === "warn" && r.event === "pinned_owner_docs_unusable")).toBe(true);
		// Rewritten from the fresh text, so the next warm spawn pins it again.
		spawn();
		expect(lastSpawnLog().pinned).toBe(true);
	});

	test("an unreadable sidecar (a directory in its place): fresh owner docs, pinned=false, no throw", () => {
		sessionWithCall(sessionDir(), 10 * MINUTE);
		mkdirSync(join(sessionDir(), PINNED_OWNER_DOCS_FILE));
		writeFileSync(files.owner as string, OWNER_V2);

		let text = "";
		expect(() => {
			text = spawn();
		}).not.toThrow();
		expect(text).toContain(OWNER_V2);
		expect(lastSpawnLog().pinned).toBe(false);
		expect(records.some((r) => r.level === "warn" && r.event === "pinned_owner_docs_unusable")).toBe(true);
		expect(JSON.stringify(records)).not.toContain(OWNER_V2);
	});
});

describe("qa50b-low lane L", () => {
	const options = (extra: Partial<SpawnPromptOptions> = {}): SpawnPromptOptions => ({
		secretsDir: join(dir, "secrets"),
		originKey: ORIGIN,
		sessionDir: sessionDir(),
		files,
		herdr: true,
		ownerDialogs: true,
		peerTouched: true,
		now: NOW,
		log,
		...extra,
	});

	test("L-11 an owner doc past its cap injects its head, cut at the cap on a whole character", () => {
		// 3 bytes per character: the cap falls inside one, which must not leave a broken character.
		writeFileSync(files.soul as string, `${SOUL}\n${"가".repeat(SOUL_MAX_BYTES)}TAIL-MARKER`);
		const errors: string[] = [];
		const prompt = spawnSystemPrompt(options({ onPersonaError: (error) => errors.push(String(error)) }));
		expect(errors).toEqual([]);
		expect(prompt).toContain(SOUL);
		expect(prompt).not.toContain("TAIL-MARKER");
		expect(prompt).not.toContain("\uFFFD");
		const soulPart = prompt.slice(prompt.indexOf(SOUL), prompt.indexOf("[오너 관찰지]")).trimEnd();
		expect(Buffer.byteLength(soulPart)).toBeLessThanOrEqual(SOUL_MAX_BYTES);
		expect(prompt).toContain(OWNER_V1);
	});

	test("L-이관1 hostTools:false leaves out every host tool line (agy and claude children have none)", () => {
		const hostToolNames = [
			"slack_send_file",
			"ompbot_request_approval",
			"ompbot_monitor_add",
			"ompbot_dispatch",
			"ompbot_work_start",
		];
		const withTools = spawnSystemPrompt(options({ surface: { noLaneChannel: true } }));
		for (const name of hostToolNames.filter((n) => n !== "ompbot_work_start")) expect(withTools).toContain(name);
		const without = spawnSystemPrompt(options({ hostTools: false, surface: { noLaneChannel: true } }));
		for (const name of hostToolNames) expect({ name, found: without.includes(name) }).toEqual({ name, found: false });
		expect(without).toContain("This session has no ompbot host tools");
		// The owner docs and the hard floors stay.
		expect(without).toContain(SOUL);
		expect(without).toContain("비밀 읽기 금지");
	});
});
