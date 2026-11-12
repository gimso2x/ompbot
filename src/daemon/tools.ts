import { buildChildEnv } from "../omp/env";

/** Bound on waiting for a killed group's orphans to be reaped by init after the group SIGKILL. */
const GROUP_REAP_WAIT_MS = 500;

/**
 * Resolves once no process of group `pgid` is left (or after `GROUP_REAP_WAIT_MS`). Orphaned members are reaped by
 * init asynchronously and stay visible as zombies until then; the pgid cannot be reused while any member exists.
 */
async function groupGone(pgid: number): Promise<void> {
	const deadline = performance.now() + GROUP_REAP_WAIT_MS;
	while (performance.now() < deadline) {
		try {
			process.kill(-pgid, 0);
		} catch {
			return; // ESRCH: nothing left in the group
		}
		await Bun.sleep(5);
	}
}

/**
 * First stdout line of `<command...>` (e.g. `omp --version`); `unknown` when it cannot be run, exits non-zero or is
 * still running after `timeoutMs`. The command runs in its own process group, and on timeout the whole group is
 * killed (a launcher's grandchild holding stdout open would otherwise keep the read waiting) and the child reaped.
 * The command gets `env`, by default the turn child's env (`buildChildEnv`: no `SLACK_`/`OMPBOT_` keys), never the
 * daemon's own.
 */
export async function readVersion(
	command: string[],
	timeoutMs = 5_000,
	env: Record<string, string> = buildChildEnv(),
): Promise<string> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const proc = Bun.spawn(command, { stdout: "pipe", stderr: "ignore", stdin: "ignore", detached: true, env });
		const timedOut = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), timeoutMs);
		});
		const finished = Promise.all([new Response(proc.stdout).text(), proc.exited]);
		const result = await Promise.race([finished, timedOut]);
		if (result === "timeout") {
			try {
				process.kill(-proc.pid, "SIGKILL");
			} catch {
				// ESRCH: the group is already gone
			}
			await proc.exited;
			await groupGone(proc.pid);
			return "unknown";
		}
		const [out, code] = result;
		const line = out.trim().split("\n")[0]?.trim();
		return code === 0 && line ? line : "unknown";
	} catch {
		return "unknown";
	} finally {
		// Never fire after a normal exit: the pgid may be reused by then.
		clearTimeout(timer);
	}
}
