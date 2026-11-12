import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { git, makeRepo } from "./helpers/git-fixtures";

/**
 * `release/export.ts` (public core export). `release/` itself never ships to the public tree, so this file
 * skips there; it also skips when gitleaks is not installed, since the leak gate runs the real scanner.
 */
const REPO = resolve(import.meta.dir, "..");
const EXPORT = join(REPO, "release", "export.ts");

interface ExportOptions {
	ref: string;
	to: string;
	version?: string;
	repo?: string;
	denylistFile?: string;
	installCheck?: (tree: string, print: (line: string) => void) => Promise<boolean>;
	print?: (line: string) => void;
}
interface ExportModule {
	exportRelease(options: ExportOptions): Promise<number>;
	findGitleaks(): string | undefined;
	readAllowlist(file?: string): string[];
}

// Dynamic import: release/ is absent from the exported public tree, where a static import would break tsc and bun test.
const mod = existsSync(EXPORT) ? ((await import(EXPORT)) as ExportModule) : undefined;
const gitleaks = mod?.findGitleaks();
if (mod === undefined) console.log("[skip] release-export.test.ts: release/export.ts is not in this tree");
else if (gitleaks === undefined) console.log("[skip] release-export.test.ts: gitleaks not found");

// Each test runs real git and gitleaks several times; at load 10 on 4 cores the version test alone passed 5s.
const EXPORT_TEST_TIMEOUT_MS = 30_000;

// Planted marker for the injected denylist. Not an owner identifier: the real denylist is never read here.
const PLANTED = "planted-owner-marker-4821";

const repos: string[] = [];
afterEach(() => {
	for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	repos.push(dir);
	return dir;
}

function put(root: string, files: Record<string, string>): void {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
}

/** A development repository: allowlisted files plus the private ones that must never ship. */
function makeDevRepo(): string {
	const dev = makeRepo(repos, "ompbot-release-dev-");
	put(dev, {
		"src/app.ts": "export const answer = 42;\n",
		"src/old.ts": "export const legacy = true;\n",
		"test/app.test.ts": "// test\n",
		"package.json": '{ "name": "demo", "version": "1.2.3" }\n',
		"AGENTS.md": `rules for ${PLANTED}\n`,
		"doc/plans/x.md": `plan mentions ${PLANTED}\n`,
		"docs/tasks/T-1/spec.md": "spec\n",
		"release/denylist.txt": `${PLANTED}\n`,
	});
	git(dev, "add", ".");
	git(dev, "commit", "-q", "-m", "dev content");
	return dev;
}

function commitFiles(dev: string, files: Record<string, string>, message: string): void {
	put(dev, files);
	git(dev, "add", ".");
	git(dev, "commit", "-q", "-m", message);
}

function makePublic(): string {
	const pub = makeRepo(repos, "ompbot-release-pub-");
	git(pub, "config", "user.name", "release");
	git(pub, "config", "user.email", "release@example.com");
	return pub;
}

function denylist(): string {
	const file = join(tempDir("ompbot-release-deny-"), "denylist.txt");
	writeFileSync(file, `# injected for tests\n${PLANTED.replace(/\d+$/, "\\d+")}\n`);
	return file;
}

interface Run {
	code: number;
	out: string;
	installCalls: number;
}

async function runExport(dev: string, pub: string, extra: Partial<ExportOptions> = {}): Promise<Run> {
	if (mod === undefined) throw new Error("release/export.ts missing");
	const lines: string[] = [];
	let installCalls = 0;
	const code = await mod.exportRelease({
		ref: "HEAD",
		to: pub,
		repo: dev,
		denylistFile: denylist(),
		installCheck: async () => {
			installCalls++;
			return true;
		},
		print: (line) => lines.push(line),
		...extra,
	});
	return { code, out: lines.join("\n"), installCalls };
}

function snapshot(pub: string): { head: string; status: string; count: string } {
	return {
		head: git(pub, "rev-parse", "HEAD"),
		status: git(pub, "status", "--porcelain"),
		count: git(pub, "rev-list", "--count", "HEAD"),
	};
}

describe.skipIf(mod === undefined || gitleaks === undefined)("release export", () => {
	test(
		"AC-1: a denylisted string in an allowlisted file fails with exit 1, leaves the checkout alone, and is not echoed",
		async () => {
			const dev = makeDevRepo();
			commitFiles(dev, { "src/config.ts": `export const channel = "${PLANTED}";\n` }, "plant");
			const pub = makePublic();
			const before = snapshot(pub);
			const run = await runExport(dev, pub);
			expect(run.code).toBe(1);
			expect(snapshot(pub)).toEqual(before);
			expect(run.out).not.toContain(PLANTED);
			expect(run.out).not.toContain("planted-owner-marker");
			expect(run.out).toContain("src/config.ts:1");
			expect(run.installCalls).toBe(0);
		},
		EXPORT_TEST_TIMEOUT_MS,
	);

	test(
		"AC-2: a gitleaks-detectable fake key fails with exit 1 and leaves the checkout alone",
		async () => {
			const dev = makeDevRepo();
			// Assembled at runtime so this test file itself stays clean for secret scanners.
			const fakeKey = ["Tq7LmZp4", "XwRk9VbN", "c2HyJ8sD"].join("");
			commitFiles(dev, { "src/keys.ts": `export const apiToken = "${fakeKey}";\n` }, "leak");
			const pub = makePublic();
			const before = snapshot(pub);
			const run = await runExport(dev, pub);
			expect(run.code).toBe(1);
			expect(snapshot(pub)).toEqual(before);
			expect(run.out).not.toContain(fakeKey);
			expect(run.out).toContain("src/keys.ts");
			expect(run.installCalls).toBe(0);
		},
		EXPORT_TEST_TIMEOUT_MS,
	);

	test(
		"AC-3: a clean ref adds exactly one commit with only allowlisted paths and no source commit hash",
		async () => {
			if (mod === undefined) throw new Error("unreachable");
			const dev = makeDevRepo();
			const pub = makePublic();
			const before = snapshot(pub);
			const run = await runExport(dev, pub);
			expect(run.out).not.toContain(PLANTED);
			expect(run.code).toBe(0);
			expect(run.installCalls).toBe(1);
			expect(Number(git(pub, "rev-list", "--count", "HEAD"))).toBe(Number(before.count) + 1);
			expect(git(pub, "rev-parse", "HEAD~1")).toBe(before.head);
			expect(git(pub, "status", "--porcelain")).toBe("");

			const allow = mod.readAllowlist();
			const allowed = (path: string) =>
				allow.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));
			const files = git(pub, "ls-files").split("\n");
			expect(files.filter((path) => !allowed(path))).toEqual([]);
			expect(files).toEqual(expect.arrayContaining(["src/app.ts", "test/app.test.ts", "package.json"]));
			expect(files.some((path) => /^(AGENTS\.md|doc\/|docs\/|release\/)/.test(path))).toBe(false);

			const devHead = git(dev, "rev-parse", "HEAD");
			const message = git(pub, "log", "-1", "--format=%B");
			expect(message).toBe("release: v1.2.3");
			for (const hash of [devHead, devHead.slice(0, 7)]) {
				expect(message).not.toContain(hash);
				for (const path of files) expect(readFileSync(join(pub, path), "utf8")).not.toContain(hash);
			}
			expect(run.out).toContain("push");
		},
		EXPORT_TEST_TIMEOUT_MS,
	);

	test(
		"AC-4: a file dropped from the new ref is no longer tracked or present after the next export",
		async () => {
			const dev = makeDevRepo();
			const pub = makePublic();
			expect((await runExport(dev, pub)).code).toBe(0);
			expect(git(pub, "ls-files", "src/old.ts")).toBe("src/old.ts");

			git(dev, "rm", "-q", "src/old.ts");
			git(dev, "commit", "-q", "-m", "drop old");
			const run = await runExport(dev, pub, { version: "1.2.4" });
			expect(run.code).toBe(0);
			expect(git(pub, "ls-files", "src/old.ts")).toBe("");
			expect(existsSync(join(pub, "src", "old.ts"))).toBe(false);
			expect(git(pub, "status", "--porcelain")).toBe("");
			expect(git(pub, "log", "-1", "--format=%B")).toBe("release: v1.2.4");
		},
		EXPORT_TEST_TIMEOUT_MS,
	);

	test(
		"a version tag that disagrees with the manifest refuses before the install check; matching tags and branches pass",
		async () => {
			const dev = makeDevRepo();
			commitFiles(dev, { "package.json": '{ "name": "demo", "version": "0.1.0" }\n' }, "manifest 0.1.0");
			git(dev, "tag", "v9.9.9");
			const pub = makePublic();
			const before = snapshot(pub);
			const run = await runExport(dev, pub, { ref: "v9.9.9" });
			expect(run.code).toBe(1);
			expect(run.out).toContain("tag v9.9.9 != version 0.1.0");
			expect(snapshot(pub)).toEqual(before);
			expect(run.installCalls).toBe(0);

			git(dev, "tag", "v0.1.0");
			const tagged = await runExport(dev, pub, { ref: "v0.1.0" });
			expect(tagged.code).toBe(0);
			expect(git(pub, "log", "-1", "--format=%B")).toBe("release: v0.1.0");

			// A commit expression on a tag is not the tag itself, so it is not checked.
			expect((await runExport(dev, pub, { ref: "v9.9.9~0" })).code).toBe(0);

			// Only tags are checked: a branch named like a version exports with the manifest's version, as before.
			git(dev, "branch", "v8.8.8");
			expect((await runExport(dev, pub, { ref: "v8.8.8" })).code).toBe(0);
			expect(git(pub, "log", "-1", "--format=%B")).toBe("release: v0.1.0");
		},
		EXPORT_TEST_TIMEOUT_MS,
	);

	test(
		"a dirty public checkout or a failing install check refuses without touching it",
		async () => {
			const dev = makeDevRepo();
			const pub = makePublic();
			writeFileSync(join(pub, "stray.txt"), "x\n");
			const dirty = snapshot(pub);
			expect((await runExport(dev, pub)).code).toBe(1);
			expect(snapshot(pub)).toEqual(dirty);

			rmSync(join(pub, "stray.txt"));
			const clean = snapshot(pub);
			const run = await runExport(dev, pub, { installCheck: async () => false });
			expect(run.code).toBe(1);
			expect(snapshot(pub)).toEqual(clean);
		},
		EXPORT_TEST_TIMEOUT_MS,
	);

	test(
		"a relative markdown link to a path outside the exported tree fails without touching the checkout",
		async () => {
			const dev = makeDevRepo();
			// AGENTS.md and doc/ exist in the ref but are not allowlisted, so both links are dead in the public tree.
			commitFiles(
				dev,
				{
					"README.md": "# demo\n\nRules: [rules](AGENTS.md).\n\nPlan: [plan](doc/plans/x.md#design)\n",
					"examples/demo/README.md": "Code: [missing](../../src/gone.ts)\n",
				},
				"dead links",
			);
			const pub = makePublic();
			const before = snapshot(pub);
			const run = await runExport(dev, pub);
			expect(run.code).toBe(1);
			expect(snapshot(pub)).toEqual(before);
			expect(run.out).toContain("README.md:3");
			expect(run.out).toContain("README.md:5");
			expect(run.out).toContain("examples/demo/README.md:1");
			expect(run.installCalls).toBe(0);
		},
		EXPORT_TEST_TIMEOUT_MS,
	);

	test(
		"relative links to exported files and directories, anchors, web and mail links pass",
		async () => {
			const dev = makeDevRepo();
			commitFiles(
				dev,
				{
					"README.md": [
						"# demo",
						"[code](src/app.ts) [dir](src/) [line](test/app.test.ts#L1) [root](/package.json)",
						"[top](#demo) [web](https://example.com/AGENTS.md) [mail](mailto:dev@example.com)",
						'[titled](examples/demo/README.md "demo") [angle](<src/app.ts>)',
						"`[inline](AGENTS.md)` is code, not a link.",
						"```",
						"[fenced](doc/plans/x.md)",
						"```",
						"",
					].join("\n"),
					"examples/demo/README.md": "Back to [code](../../src/app.ts) and [readme](../../README.md#demo).\n",
				},
				"good links",
			);
			const pub = makePublic();
			const run = await runExport(dev, pub);
			expect(run.out).not.toContain("dead link");
			expect(run.code).toBe(0);
			expect(git(pub, "ls-files", "examples/demo/README.md")).toBe("examples/demo/README.md");
		},
		EXPORT_TEST_TIMEOUT_MS,
	);
});
