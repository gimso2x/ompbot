import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMonitorLedger } from "../src/monitors/ledger";
import { applyMonitors, exportMonitors } from "../src/monitors/portable";
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

	test("a cron command round-trips as @SCRIPTS@/ with its timeout, and --with-files carries the script", async () => {
		const a = home("ompbot-portable-a-");
		const b = home("ompbot-portable-b-");
		const script = join(a.dir, "scripts", "brief.sh");
		writeFileSync(script, "#!/bin/sh\necho brief\n");
		chmodSync(script, 0o755);
		addMonitor(a, {
			name: "brief",
			trigger: { kind: "cron", schedule: "0 8 * * *", command: [script, "--days", "7"], timeoutMs: 900_000 },
			instruction: "post the script output",
			deliver: "verbatim",
		});
		const dirA = tempDir("ompbot-export-a-");
		const dirB = tempDir("ompbot-export-b-");
		expect((await monitors(a, "export", "--dir", dirA, "--with-files")).code).toBe(0);
		const exported = JSON.parse(readFileSync(join(dirA, "brief.json"), "utf8")) as {
			trigger: Record<string, unknown>;
			deliver?: string;
		};
		expect([exported.trigger.command, exported.trigger.timeoutMs, exported.deliver]).toEqual([
			["@SCRIPTS@/brief.sh", "--days", "7"],
			900_000,
			"verbatim",
		]);
		expect(readdirSync(join(dirA, "files", "scripts"))).toEqual(["brief.sh"]);
		cpSync(join(dirA, "files", "scripts"), join(b.dir, "scripts"), { recursive: true });

		const applied = await monitors(b, "apply", "--dir", dirA);
		expect([applied.code, applied.stdout]).toEqual([0, "added=1 updated=0 unchanged=0 removed=0\n"]);
		const row = rowsOf(b).brief;
		expect(row?.trigger).toEqual({
			kind: "cron",
			schedule: "0 8 * * *",
			timezone: "Asia/Seoul",
			command: [join(b.dir, "scripts", "brief.sh"), "--days", "7"],
			timeoutMs: 900_000,
		});
		expect(row?.deliver).toBe("verbatim");
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

describe("monitors export --with-files: arguments with ..", () => {
	test("E-3: a script argument <scripts>/../../x writes nothing outside the export dir and warns", () => {
		const base = tempDir("ompbot-e3-");
		const scriptsRoot = join(base, "h", "a", "scripts");
		const workspaceDir = join(base, "h", "a", "workspace");
		mkdirSync(scriptsRoot, { recursive: true });
		mkdirSync(workspaceDir, { recursive: true });
		const script = join(scriptsRoot, "check.sh");
		writeFileSync(script, "#!/bin/sh\nexit 0\n");
		chmodSync(script, 0o755);
		writeFileSync(join(scriptsRoot, "data.txt"), "data\n");
		writeFileSync(join(base, "src.txt"), "planted\n");
		const outside = join(base, "out", "src.txt");
		mkdirSync(join(base, "out"));
		writeFileSync(outside, "victim\n");
		const ctx = { scriptsRoot, workspaceDir, defaultTimezone: "Asia/Seoul" };
		const ledger = openMonitorLedger(join(base, "ompbot.db"));
		cleanups.push(() => ledger.close());
		const dotted = `${scriptsRoot}/../../../src.txt`;
		ledger.addMonitor(
			parseMonitorSpec(
				{
					name: "dotted",
					trigger: { kind: "script", command: [script, dotted, join(scriptsRoot, "data.txt")], intervalMs: 300_000 },
					instruction: "x",
				},
				ctx,
			),
		);
		const dir = join(base, "out", "e");
		const result = exportMonitors(ledger, dir, ctx, { withFiles: true });
		expect(readFileSync(outside, "utf8")).toBe("victim\n");
		expect(readdirSync(join(base, "out")).sort()).toEqual(["e", "src.txt"]);
		expect(result.warnings.some((warning) => warning.includes(dotted))).toBe(true);
		expect(readFileSync(join(dir, "files", "scripts", "data.txt"), "utf8")).toBe("data\n");
		expect(readFileSync(join(dir, "files", "scripts", "check.sh"), "utf8")).toBe("#!/bin/sh\nexit 0\n");
	});
});

describe("monitors export --with-files: symlinks", () => {
	test("qa-h n60: a file under a root linking outside it is not copied and warned; a link inside is copied", () => {
		const base = tempDir("ompbot-n60-");
		const scriptsRoot = join(base, "h", "scripts");
		const workspaceDir = join(base, "h", "workspace");
		mkdirSync(scriptsRoot, { recursive: true });
		mkdirSync(join(workspaceDir, "proc"), { recursive: true });
		const script = join(scriptsRoot, "check.sh");
		writeFileSync(script, "#!/bin/sh\nexit 0\n");
		chmodSync(script, 0o755);
		writeFileSync(join(scriptsRoot, "real.txt"), "inside\n");
		const secret = join(base, "outside-secret.txt");
		writeFileSync(secret, "victim\n");
		for (const name of ["procedure.md", "inner.md", "gone.md"]) writeFileSync(join(workspaceDir, "proc", name), "x\n");
		const ctx = { scriptsRoot, workspaceDir, defaultTimezone: "Asia/Seoul" };
		const ledger = openMonitorLedger(join(base, "ompbot.db"));
		cleanups.push(() => ledger.close());
		const outArg = join(scriptsRoot, "out.txt");
		const inArg = join(scriptsRoot, "in.txt");
		writeFileSync(outArg, "x\n");
		writeFileSync(inArg, "x\n");
		ledger.addMonitor(
			parseMonitorSpec(
				{
					name: "linked",
					trigger: { kind: "script", command: [script, outArg, inArg], intervalMs: 300_000 },
					instruction: "x",
					procedureFiles: ["proc/procedure.md", "proc/inner.md", "proc/gone.md"],
				},
				ctx,
			),
		);
		// Swapped for links after the monitor was stored, the way a model can do it in the workspace.
		const relink = (path: string, target: string) => {
			rmSync(path);
			symlinkSync(target, path);
		};
		relink(join(workspaceDir, "proc", "procedure.md"), secret);
		relink(outArg, secret);
		relink(join(workspaceDir, "proc", "inner.md"), "../notes.md");
		writeFileSync(join(workspaceDir, "notes.md"), "notes\n");
		relink(inArg, "real.txt");
		relink(join(workspaceDir, "proc", "gone.md"), join(base, "nonexistent.md"));
		const dir = join(base, "export");
		const { warnings } = exportMonitors(ledger, dir, ctx, { withFiles: true });
		expect(warnings).toContain(
			`linked: referenced file resolves outside ${workspaceDir}, not copied: ${join(workspaceDir, "proc", "procedure.md")}`,
		);
		expect(warnings).toContain(`linked: referenced file resolves outside ${scriptsRoot}, not copied: ${outArg}`);
		expect(warnings).toContain(`referenced file not found, not copied: ${join(workspaceDir, "proc", "gone.md")}`);
		expect(existsSync(join(dir, "files", "workspace", "proc", "procedure.md"))).toBe(false);
		expect(existsSync(join(dir, "files", "scripts", "out.txt"))).toBe(false);
		expect(readFileSync(join(dir, "files", "workspace", "proc", "inner.md"), "utf8")).toBe("notes\n");
		expect(readFileSync(join(dir, "files", "scripts", "in.txt"), "utf8")).toBe("inside\n");
		expect(readFileSync(join(dir, "files", "scripts", "check.sh"), "utf8")).toBe("#!/bin/sh\nexit 0\n");
	});
});

describe("monitors portable apply/export on odd entries (qa-i low)", () => {
	const portableCtx = (h: TestHome) => ({
		scriptsRoot: join(h.dir, "scripts"),
		workspaceDir: h.config.workspaceDir,
		webhook: { port: 1 },
		defaultTimezone: "Asia/Seoul",
	});

	test("apply skips a FIFO and a directory named *.json instead of blocking or failing", () => {
		const h = home("portable-odd-");
		const dir = tempDir("portable-odd-dir-");
		writeFileSync(join(dir, "ok.json"), JSON.stringify({ name: "ok", trigger: { kind: "webhook" }, instruction: "x" }));
		mkdirSync(join(dir, "dir.json"));
		expect(Bun.spawnSync(["mkfifo", join(dir, "pipe.json")]).exitCode).toBe(0);
		const result = applyMonitors(ledgerOf(h), dir, portableCtx(h));
		expect(result.added).toBe(1);
		expect(result.warnings.sort()).toEqual([
			"dir.json: not a regular file, skipped",
			"pipe.json: not a regular file, skipped",
		]);
	});

	test("export --with-files warns for an unreadable referenced file and still finishes", () => {
		const h = home("portable-eacces-");
		const scripts = join(h.dir, "scripts");
		const locked = join(scripts, "locked.sh");
		writeFileSync(locked, "#!/bin/sh\nexit 0\n");
		chmodSync(locked, 0o755);
		writeFileSync(join(scripts, "fine.md"), "fine\n");
		addMonitor(h, {
			name: "m",
			trigger: { kind: "script", command: [locked, join(scripts, "fine.md")], intervalMs: 300_000 },
			instruction: "x",
		});
		chmodSync(locked, 0o200);
		const dir = join(tempDir("portable-eacces-out-"), "e");
		const { warnings } = exportMonitors(ledgerOf(h), dir, portableCtx(h), { withFiles: true });
		chmodSync(locked, 0o600);
		expect(warnings.some((w) => w.includes("referenced file not copied") && w.includes(locked))).toBe(true);
		expect(readFileSync(join(dir, "files", "scripts", "fine.md"), "utf8")).toBe("fine\n");
		expect(existsSync(join(dir, "m.json"))).toBe(true);
	});
});
