import { existsSync, readdirSync, readFileSync, watch } from "node:fs";
import { basename, dirname, join } from "node:path";

const MAIN = join(import.meta.dir, "..", "..", "src", "main.ts");

export interface SpawnedDaemon {
	pid: number;
	exited: Promise<number>;
	/** Resolves with the first log line (past or future) that matches; rejects after `timeoutMs`. */
	waitLog(pattern: RegExp, timeoutMs?: number): Promise<string>;
	logs(): string;
	signal(signal: NodeJS.Signals): void;
}

const running = new Set<Bun.Subprocess>();

/** Kills every process this helper started and still owns (used from afterEach so failures never leak children). */
export function killSpawned(): void {
	for (const proc of running) proc.kill("SIGKILL");
	running.clear();
}

/**
 * `bun src/main.ts daemon` with the test-only transport (a JSONL file) so nothing reaches Slack.
 * Extra env (e.g. OMPBOT_TEST_CRASH_AT) is passed through.
 */
export function spawnDaemon(homeDir: string, transportFile: string, env: Record<string, string> = {}): SpawnedDaemon {
	const proc = Bun.spawn(["bun", MAIN, "daemon"], {
		env: {
			...process.env,
			OMPBOT_HOME: homeDir,
			OMPBOT_TEST_HOOKS: "1",
			OMPBOT_TEST_TRANSPORT: transportFile,
			OMPBOT_TEST_HOST_LOAD: "idle", // gates judge an idle host, not this machine's load
			...env,
		},
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	running.add(proc);
	const lines: string[] = [];
	const waiters = new Set<{ pattern: RegExp; resolve: (line: string) => void }>();
	void (async () => {
		const decoder = new TextDecoder();
		let pending = "";
		for await (const chunk of proc.stderr) {
			pending += decoder.decode(chunk, { stream: true });
			let newline = pending.indexOf("\n");
			while (newline !== -1) {
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				lines.push(line);
				for (const waiter of [...waiters]) {
					if (waiter.pattern.test(line)) {
						waiters.delete(waiter);
						waiter.resolve(line);
					}
				}
				newline = pending.indexOf("\n");
			}
		}
	})();
	const exited = proc.exited.then((code) => {
		running.delete(proc);
		return code;
	});
	return {
		pid: proc.pid,
		exited,
		waitLog(pattern, timeoutMs = 20_000) {
			const known = lines.find((line) => pattern.test(line));
			if (known !== undefined) return Promise.resolve(known);
			const { promise, resolve, reject } = Promise.withResolvers<string>();
			const waiter = {
				pattern,
				resolve: (line: string) => {
					clearTimeout(timer);
					resolve(line);
				},
			};
			const timer = setTimeout(() => {
				waiters.delete(waiter);
				reject(new Error(`timed out waiting for log ${pattern}; log so far:\n${lines.join("\n")}`));
			}, timeoutMs);
			waiters.add(waiter);
			return promise;
		},
		logs: () => lines.join("\n"),
		signal: (signal) => proc.kill(signal),
	};
}

export interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Runs `bun src/main.ts <args>` against a bot home. */
export async function runMain(homeDir: string, args: string[], env: Record<string, string> = {}): Promise<CliResult> {
	const proc = Bun.spawn(["bun", MAIN, ...args], {
		env: { ...process.env, OMPBOT_HOME: homeDir, ...env },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	running.add(proc);
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	running.delete(proc);
	return { code, stdout, stderr };
}

export interface LoggedPost {
	method: "postMessage";
	channel: string;
	text: string;
	threadTs?: string;
	ts: string;
}

/** Reader of the JSONL file written by `FileFakeTransport` (what the daemon "sent to Slack"). */
export class TransportLog {
	constructor(readonly path: string) {}

	/** Every logged Slack call of one method (postMessage, updateMessage, uploadFile, ...). */
	calls(method: string): Array<Record<string, unknown>> {
		if (!existsSync(this.path)) return [];
		return readFileSync(this.path, "utf8")
			.split("\n")
			.filter((line) => line.startsWith("{"))
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((entry) => entry.method === method);
	}
	posts(): LoggedPost[] {
		if (!existsSync(this.path)) return [];
		return readFileSync(this.path, "utf8")
			.split("\n")
			.filter((line) => line.startsWith("{"))
			.map((line) => JSON.parse(line) as { method: string })
			.filter((entry): entry is LoggedPost => entry.method === "postMessage");
	}

	/** Resolves when `predicate(posts)` holds; re-evaluated on every change of the file (no polling). */
	waitFor(predicate: (posts: LoggedPost[]) => boolean, what: string, timeoutMs = 120_000): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const target = basename(this.path);
		const check = () => {
			if (!predicate(this.posts())) return false;
			clearTimeout(timer);
			watcher.close();
			resolve();
			return true;
		};
		const watcher = watch(dirname(this.path), (_event, name) => {
			if (name === target) check();
		});
		const timer = setTimeout(() => {
			watcher.close();
			reject(new Error(`timed out waiting for ${what}; posts: ${JSON.stringify(this.posts().map((p) => p.text))}`));
		}, timeoutMs);
		check();
		return promise;
	}
}

/** Pids of every live process whose command line mentions `marker` (e.g. a temp home path). */
export function processesMentioning(marker: string): number[] {
	const pids: number[] = [];
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
		try {
			if (readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(marker)) pids.push(Number(entry));
		} catch {
			// the process exited while scanning
		}
	}
	return pids;
}

/**
 * Waits (event-driven: `tail --pid` returns when the pid exits) until no process mentions `marker`. Survivors are
 * killed after `timeoutMs` and reported as an error, so a failing run never leaves children behind.
 */
export async function expectNoProcessesMentioning(marker: string, timeoutMs = 30_000): Promise<void> {
	const pids = processesMentioning(marker);
	const waits = pids.map(async (pid) => {
		const waiter = Bun.spawn(["tail", "--pid", String(pid), "-f", "/dev/null"], { stdout: "ignore", stderr: "ignore" });
		const timer = setTimeout(() => waiter.kill("SIGKILL"), timeoutMs);
		await waiter.exited;
		clearTimeout(timer);
	});
	await Promise.all(waits);
	const survivors = processesMentioning(marker);
	for (const pid of survivors) process.kill(pid, "SIGKILL");
	if (survivors.length > 0) throw new Error(`processes still running after ${timeoutMs}ms: ${survivors.join(",")}`);
}
