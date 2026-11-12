import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMonitorLedger } from "../src/monitors/ledger";
import { parseMonitorSpec } from "../src/monitors/spec";
import { makeHome, type TestHome } from "./helpers/bot-home";
import { killSpawned, runMain } from "./helpers/daemon-process";

const cleanups: Array<() => void> = [];

afterEach(() => {
	killSpawned();
	for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A bot home with a scripts dir and a webhook listener configured, so every trigger kind under test can be created. */
function home(prefix: string): TestHome {
	const h = makeHome(prefix);
	cleanups.push(h.remove);
	mkdirSync(join(h.dir, "scripts"));
	const config = JSON.parse(readFileSync(h.config.configPath, "utf8")) as Record<string, unknown>;
	writeFileSync(h.config.configPath, JSON.stringify({ ...config, webhook: { port: 1 } }), { mode: 0o600 });
	return h;
}

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function ledgerOf(h: TestHome) {
	const ledger = openMonitorLedger(join(h.dir, "ompbot.db"));
	cleanups.push(() => ledger.close());
	return ledger;
}

function addMonitor(h: TestHome, spec: Record<string, unknown>) {
	const ctx = {
		scriptsRoot: join(h.dir, "scripts"),
		workspaceDir: h.config.workspaceDir,
		webhook: { port: 1 },
		defaultTimezone: "Asia/Seoul",
	};
	return ledgerOf(h).addMonitor(parseMonitorSpec(spec, ctx));
}

/** Home A: a script monitor, a cron monitor with procedure files in both roots, and a webhook monitor. */
function seedSource(h: TestHome): void {
	const script = join(h.dir, "scripts", "check.sh");
	writeFileSync(script, "#!/bin/sh\nexit 1\n");
	chmodSync(script, 0o755);
	writeFileSync(join(h.dir, "scripts", "steps.md"), "steps\n");
	writeFileSync(join(h.config.workspaceDir, "procedure.md"), "procedure\n");
	addMonitor(h, {
		name: "disk check",
		trigger: { kind: "script", command: [script, "--quiet"], intervalMs: 300_000, fire: "every" },
		instruction: "report disk",
		overlap: "skip",
		deliver: "verbatim",
	});
	addMonitor(h, {
		name: "morning/brief",
		trigger: { kind: "cron", schedule: "30 9 * * *" },
		instruction: "summarize",
		channel: "C0123456789",
		model: "provider/model-a",
		thinking: "low",
		procedureFiles: [join(h.config.workspaceDir, "procedure.md"), join(h.dir, "scripts", "steps.md"), "procedure.md"],
	});
	addMonitor(h, { name: "hook", trigger: { kind: "webhook" }, instruction: "handle hook", enabled: false });
}

const monitors = (h: TestHome, ...args: string[]) => runMain(h.dir, ["monitors", ...args]);

/** `*.json` file name -> bytes. */
function jsonFiles(dir: string): Record<string, string> {
	return Object.fromEntries(
		readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.sort()
			.map((f) => [f, readFileSync(join(dir, f), "utf8")]),
	);
}

/** Every monitor row as stored, keyed by name (ids, tokens, timestamps included). */
const rowsOf = (h: TestHome) =>
	Object.fromEntries(
		ledgerOf(h)
			.listMonitors()
			.map((row) => [row.name, row]),
	);

/** Places the exported script and workspace files into another home, as the instance repo's sync would. */
function syncFiles(exportDir: string, target: TestHome): void {
	cpSync(join(exportDir, "files", "scripts"), join(target.dir, "scripts"), { recursive: true });
	cpSync(join(exportDir, "files", "workspace"), target.config.workspaceDir, { recursive: true });
}

describe("ompbot monitors export/apply", () => {
	test("AC-1: export -> apply on a home with other paths -> export gives byte-identical *.json", async () => {
		const a = home("ompbot-portable-a-");
		const b = home("ompbot-portable-b-");
		seedSource(a);
		const dirA = tempDir("ompbot-export-a-");
		const dirB = tempDir("ompbot-export-b-");

		const exported = await monitors(a, "export", "--dir", dirA, "--with-files");
		expect(exported.code).toBe(0);
		expect(Object.keys(jsonFiles(dirA))).toEqual(["disk-check.json", "hook.json", "morning-brief.json"]);
		// --with-files keeps the executable bit of the script.
		expect(readdirSync(join(dirA, "files", "scripts")).sort()).toEqual(["check.sh", "steps.md"]);
		syncFiles(dirA, b);

		const applied = await monitors(b, "apply", "--dir", dirA);
		expect(applied.stderr).toBe("");
		expect(applied.code).toBe(0);
		expect(applied.stdout).toBe("added=3 updated=0 unchanged=0 removed=0\n");
		const script = rowsOf(b)["disk check"]?.trigger;
		expect(script?.kind === "script" && script.command).toEqual([join(b.dir, "scripts", "check.sh"), "--quiet"]);

		expect((await monitors(b, "export", "--dir", dirB)).code).toBe(0);
		expect(jsonFiles(dirB)).toEqual(jsonFiles(dirA));
	});

	test("AC-2: a second apply of the same dir changes nothing and keeps updated_at", async () => {
		const a = home("ompbot-portable-a-");
		const b = home("ompbot-portable-b-");
		seedSource(a);
		const dir = tempDir("ompbot-export-");
		expect((await monitors(a, "export", "--dir", dir, "--with-files")).code).toBe(0);
		syncFiles(dir, b);
		expect((await monitors(b, "apply", "--dir", dir)).code).toBe(0);
		const before = rowsOf(b);

		const again = await monitors(b, "apply", "--dir", dir);
		expect(again.code).toBe(0);
		expect(again.stdout).toStartWith("added=0 updated=0 ");
		expect(again.stdout).toBe("added=0 updated=0 unchanged=3 removed=0\n");
		const after = rowsOf(b);
		for (const [name, row] of Object.entries(before)) expect(after[name]?.updatedAt).toBe(row.updatedAt);
		expect(after).toEqual(before);
	});

	test("AC-3: exports carry no home path, token or id; apply keeps an existing webhook's id and token", async () => {
		const a = home("ompbot-portable-a-");
		seedSource(a);
		const dir = tempDir("ompbot-export-");
		expect((await monitors(a, "export", "--dir", dir)).code).toBe(0);
		const rows = rowsOf(a);
		const hook = rows.hook?.trigger;
		if (hook?.kind !== "webhook") throw new Error("seed has no webhook monitor");
		const text = Object.values(jsonFiles(dir)).join("\n");
		expect(text).not.toContain(a.dir);
		expect(text).not.toContain(hook.token);
		expect(text).not.toContain(hook.id);
		for (const row of Object.values(rows)) expect(text).not.toContain(row.id);
		expect(JSON.parse(readFileSync(join(dir, "hook.json"), "utf8")).trigger).toEqual({ kind: "webhook" });

		// Same content: untouched. Changed content: updated, the webhook URL and token still the same.
		expect((await monitors(a, "apply", "--dir", dir)).stdout).toBe("added=0 updated=0 unchanged=3 removed=0\n");
		const file = join(dir, "hook.json");
		writeFileSync(file, readFileSync(file, "utf8").replace("handle hook", "handle the hook"));
		const applied = await monitors(a, "apply", "--dir", dir);
		expect(applied.stdout).toBe("added=0 updated=1 unchanged=2 removed=0\n");
		const after = rowsOf(a).hook;
		expect(after?.instruction).toBe("handle the hook");
		expect(after?.id).toBe(rows.hook?.id as string);
		expect(after?.trigger).toEqual(hook);
	});

	test("AC-4: one invalid file fails the whole apply with exit 2 and no row changes", async () => {
		const a = home("ompbot-portable-a-");
		seedSource(a);
		const dir = tempDir("ompbot-export-");
		expect((await monitors(a, "export", "--dir", dir)).code).toBe(0);
		const before = rowsOf(a);
		// A valid change, a valid new monitor and one file whose script does not exist on this host.
		const file = join(dir, "hook.json");
		writeFileSync(file, readFileSync(file, "utf8").replace("handle hook", "changed"));
		writeFileSync(
			join(dir, "new.json"),
			JSON.stringify({ name: "new", trigger: { kind: "cron", schedule: "0 8 * * *" }, instruction: "x" }),
		);
		writeFileSync(
			join(dir, "broken.json"),
			JSON.stringify({
				name: "broken",
				trigger: { kind: "script", command: ["@SCRIPTS@/missing.sh"], intervalMs: 60_000 },
				instruction: "x",
			}),
		);

		const applied = await monitors(a, "apply", "--dir", dir, "--prune");
		expect(applied.code).toBe(2);
		expect(applied.stderr).toContain("broken.json");
		expect(rowsOf(a)).toEqual(before);
	});

	test("AC-5: monitors missing from the dir stay without --prune, go with it; --dry-run only prints", async () => {
		const a = home("ompbot-portable-a-");
		seedSource(a);
		const dir = tempDir("ompbot-export-");
		expect((await monitors(a, "export", "--dir", dir)).code).toBe(0);
		addMonitor(a, { name: "local only", trigger: { kind: "cron", schedule: "0 7 * * *" }, instruction: "x" });
		writeFileSync(
			join(dir, "extra.json"),
			JSON.stringify({ name: "extra", trigger: { kind: "cron", schedule: "0 6 * * *" }, instruction: "y" }),
		);
		const before = rowsOf(a);

		const dry = await monitors(a, "apply", "--dir", dir, "--prune", "--dry-run");
		expect(dry.code).toBe(0);
		expect(dry.stdout).toBe("added=1 updated=0 unchanged=3 removed=1\n");
		expect(rowsOf(a)).toEqual(before);

		const kept = await monitors(a, "apply", "--dir", dir);
		expect(kept.stdout).toBe("added=1 updated=0 unchanged=3 removed=0\n");
		expect(Object.keys(rowsOf(a)).sort()).toEqual(["disk check", "extra", "hook", "local only", "morning/brief"]);

		const pruned = await monitors(a, "apply", "--dir", dir, "--prune");
		expect(pruned.stdout).toBe("added=0 updated=0 unchanged=4 removed=1\n");
		expect(Object.keys(rowsOf(a)).sort()).toEqual(["disk check", "extra", "hook", "morning/brief"]);
	});

	test("export mirrors the DB: a stale *.json of a removed monitor is deleted", async () => {
		const a = home("ompbot-portable-a-");
		seedSource(a);
		const dir = tempDir("ompbot-export-");
		writeFileSync(join(dir, "gone.json"), "{}\n");
		writeFileSync(join(dir, "notes.txt"), "kept\n");
		expect((await monitors(a, "export", "--dir", dir)).code).toBe(0);
		expect(Object.keys(jsonFiles(dir))).toEqual(["disk-check.json", "hook.json", "morning-brief.json"]);
		expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("kept\n");
	});
});
