export interface BoundedResult {
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/**
 * Runs `bun -e <code>` and kills it after `limitMs`, so a test of code that used to block forever (a read of a FIFO)
 * fails with `timedOut` instead of hanging the suite.
 */
export async function runBounded(code: string, limitMs = 20_000): Promise<BoundedResult> {
	const proc = Bun.spawn(["bun", "-e", code], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGKILL");
	}, limitMs);
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	return { stdout, stderr, timedOut };
}
