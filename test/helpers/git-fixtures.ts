import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runs `git` in `dir` with a throwaway identity; throws with stderr on failure and returns trimmed stdout. */
export function git(dir: string, ...args: string[]): string {
	const run = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-C", dir, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
	return run.stdout.toString().trim();
}

/** A real temp git repository with one initial commit, registered on `repos` for the test's afterEach cleanup. */
export function makeRepo(repos: string[], prefix = "ompbot-repo-"): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	repos.push(dir);
	git(dir, "init", "-q");
	writeFileSync(join(dir, "README.md"), "hello\n");
	git(dir, "add", "README.md");
	git(dir, "commit", "-q", "-m", "init");
	return dir;
}
