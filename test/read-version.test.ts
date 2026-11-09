import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVersion } from "../src/daemon/tools";

test("a command that never ends gives `unknown` within 1 s of a 200 ms limit, and its process is gone", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ompbot-read-version-"));
	try {
		const pidFile = join(dir, "pid");
		const started = performance.now();
		const version = await readVersion(["sh", "-c", `echo $$ > ${pidFile}; exec sleep 30`], 200);
		expect(version).toBe("unknown");
		expect(performance.now() - started).toBeLessThan(1_000);
		const pid = Number(readFileSync(pidFile, "utf8").trim());
		expect(pid).toBeGreaterThan(0);
		expect(() => process.kill(pid, 0)).toThrow();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a grandchild holding stdout does not hold the call: `unknown` within 1.5 s and the whole group is gone", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ompbot-read-version-"));
	try {
		const pidFile = join(dir, "pid");
		const started = performance.now();
		const version = await readVersion(["sh", "-c", `sleep 5 & echo $! > ${pidFile}; wait`], 300);
		expect(version).toBe("unknown");
		expect(performance.now() - started).toBeLessThan(1_500);
		const pid = Number(readFileSync(pidFile, "utf8").trim());
		expect(pid).toBeGreaterThan(0);
		expect(() => process.kill(pid, 0)).toThrow();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a command that answers in time still gives its first line", async () => {
	expect(await readVersion(["sh", "-c", "echo 'omp 1.2.3'; echo second"], 2_000)).toBe("omp 1.2.3");
});
