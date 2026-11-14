import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeHome, type TestHome } from "./helpers/bot-home";
import { runCliCapture, runMain } from "./helpers/daemon-process";

let home: TestHome;
beforeEach(() => {
	home = makeHome("ompbot-cli-capture-");
});
afterEach(() => home.remove());

describe("runCliCapture", () => {
	test("answers like runMain: the exit code, stdout and stderr of one call", async () => {
		const listed = await runCliCapture(home.dir, ["tasks", "list", "--json"]);
		expect(listed.code).toBe(0);
		expect(listed.stdout).not.toBe("");
		for (const args of [["drain", "--bogus"], ["no-such-command"], ["tasks", "list", "--json"]]) {
			const inProcess = await runCliCapture(home.dir, args);
			expect(inProcess).toEqual(await runMain(home.dir, args));
		}
	});

	test("puts the real writers back, also after the command throws", async () => {
		const out = process.stdout.write;
		const err = process.stderr.write;
		await runCliCapture(home.dir, ["drain", "--bogus"]);
		expect(process.stdout.write).toBe(out);
		expect(process.stderr.write).toBe(err);

		// Not an argv: runCli throws before its own error handling.
		await expect(runCliCapture(home.dir, null as unknown as string[])).rejects.toThrow();
		expect(process.stdout.write).toBe(out);
		expect(process.stderr.write).toBe(err);
		expect((await runCliCapture(home.dir, ["drain", "--bogus"])).code).toBe(2);
	});

	test("a second call while one runs throws instead of sharing the writers", async () => {
		const first = runCliCapture(home.dir, ["drain", "--bogus"]);
		await expect(runCliCapture(home.dir, ["drain", "--bogus"])).rejects.toThrow("another call is still running");
		expect((await first).code).toBe(2);
	});
});
