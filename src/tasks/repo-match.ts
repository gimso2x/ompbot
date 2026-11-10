import { dispatchEnv, type ProcessRunner, realProcessRunner } from "../dispatch/omp";

/**
 * Whether the repository at `path` is one of `repos` (`taskAutoLand.repos`): the same git common directory (`git
 * rev-parse --git-common-dir`), so any worktree of a listed repository matches and a look-alike path does not. A path
 * git cannot read is a mismatch. [TASK] auto-merge and work-lane landing share this one comparison.
 */
export async function repoMatchesCommonDir(
	path: string,
	repos: readonly string[],
	run: ProcessRunner = realProcessRunner,
): Promise<boolean> {
	const commonDir = async (dir: string): Promise<string | undefined> => {
		const result = await run(["git", "-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
			timeoutMs: 10_000,
			env: dispatchEnv(process.env),
		});
		const found = result.stdout.trim();
		return result.code === 0 && found !== "" ? found : undefined;
	};
	const own = await commonDir(path);
	if (own === undefined) return false;
	for (const repo of repos) if ((await commonDir(repo)) === own) return true;
	return false;
}
