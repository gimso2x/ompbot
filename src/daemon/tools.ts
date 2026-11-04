/**
 * First stdout line of `<command...>` (e.g. `omp --version`); `unknown` when it cannot be run, exits non-zero or is
 * still running after `timeoutMs` (it is then killed and reaped, never left behind).
 */
export async function readVersion(command: string[], timeoutMs = 5_000): Promise<string> {
	try {
		const proc = Bun.spawn(command, {
			stdout: "pipe",
			stderr: "ignore",
			stdin: "ignore",
			timeout: timeoutMs,
			killSignal: "SIGKILL",
		});
		const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		const line = out.trim().split("\n")[0]?.trim();
		return code === 0 && line ? line : "unknown";
	} catch {
		return "unknown";
	}
}
