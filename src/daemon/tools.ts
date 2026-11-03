/** First stdout line of `<command...>` (e.g. `omp --version`); `unknown` when it cannot be run or exits non-zero. */
export async function readVersion(command: string[]): Promise<string> {
	try {
		const proc = Bun.spawn(command, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
		const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		const line = out.trim().split("\n")[0]?.trim();
		return code === 0 && line ? line : "unknown";
	} catch {
		return "unknown";
	}
}
