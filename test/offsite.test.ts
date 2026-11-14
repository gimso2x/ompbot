import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessRunner } from "../src/dispatch/omp";
import { readStamp, STAMP_FILE } from "../src/ops/backup";
import { collectGates } from "../src/ops/gates";
import { OFFSITE_STAMP_FILE, OffsiteError, runOffsite } from "../src/ops/offsite";

let home: string;
let remote: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ompbot-offsite-"));
	remote = join(mkdtempSync(join(tmpdir(), "ompbot-remote-")), "box");
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(join(remote, ".."), { recursive: true, force: true });
});

const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const DB = "ompbot-20261030-043000.db";
const BUNDLE = "ompbot-bundle-20261030-043000.tar.gz";

function seedLocal(opts: { stamp?: boolean } = {}): void {
	const dir = join(home, "backups");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, DB), "db-bytes");
	writeFileSync(join(dir, BUNDLE), "bundle-bytes");
	// an older pair that must not be the one sent
	writeFileSync(join(dir, "ompbot-20261029-043000.db"), "old-db");
	if (opts.stamp !== false) {
		writeFileSync(
			join(dir, STAMP_FILE),
			`ts=2026-10-30T04:30:00.000Z file=${DB} bytes=8 sha256=${sha("db-bytes")} integrity=ok check=quick_check bundle=${BUNDLE} bundle_bytes=12 bundle_sha256=${sha("bundle-bytes")}\n`,
		);
	}
}

interface Fake {
	run: ProcessRunner;
	calls: string[][];
	/** Mutates what lands on the "remote" after a copy (corruption). */
	corrupt: boolean;
	failCopy: boolean;
}

/** A remote host simulated on the local disk: the ssh command strings are interpreted, scp copies the file. */
function fakeRemote(): Fake {
	const fake: Fake = {
		calls: [],
		corrupt: false,
		failCopy: false,
		run: async () => ({ code: 1, stdout: "", timedOut: false }),
	};
	const ok = (stdout = "") => ({ code: 0, stdout, timedOut: false });
	fake.run = async (cmd) => {
		fake.calls.push(cmd);
		if (cmd[0] === "scp") {
			if (fake.failCopy) return { code: 1, stdout: "Permission denied", timedOut: false };
			const dest = (cmd.at(-1) as string).replace(/^[^:]+:/, "");
			mkdirSync(join(dest, ".."), { recursive: true });
			copyFileSync(cmd.at(-2) as string, dest);
			if (fake.corrupt) writeFileSync(dest, "tampered");
			return ok();
		}
		const command = cmd.at(-1) as string;
		const words = command.split(" ");
		if (command.startsWith("mkdir -p -m 700 ")) {
			mkdirSync(words.at(-1) as string, { recursive: true });
			return ok();
		}
		if (command.startsWith("sha256sum -- ")) {
			const path = words.at(-1) as string;
			if (!existsSync(path)) return { code: 1, stdout: "", timedOut: false };
			return ok(`${sha(readFileSync(path))}  ${path}\n`);
		}
		if (command.startsWith("mv -f -- ")) {
			const [from, to] = words.slice(-2) as [string, string];
			copyFileSync(from, to);
			rmSync(from);
			return ok();
		}
		if (command.startsWith("rm -f -- ")) {
			for (const path of words.slice(3)) rmSync(path, { force: true });
			return ok();
		}
		if (command.startsWith("ls -1 -- ")) return ok(`${readdirSync(words.at(-1) as string).join("\n")}\n`);
		return { code: 127, stdout: `unexpected: ${command}`, timedOut: false };
	};
	return fake;
}

describe("runOffsite", () => {
	test("sends the newest snapshot and bundle, renames only after the remote sha matches, stamps last", async () => {
		seedLocal();
		const fake = fakeRemote();
		const result = await runOffsite({
			homeDir: home,
			target: { ssh: "box", remoteDir: remote },
			run: fake.run,
			env: {},
		});

		expect(result.files.map((f) => [f.name, f.status])).toEqual([
			[DB, "uploaded"],
			[BUNDLE, "uploaded"],
		]);
		expect(readFileSync(join(remote, DB), "utf8")).toBe("db-bytes");
		expect(readFileSync(join(remote, BUNDLE), "utf8")).toBe("bundle-bytes");
		expect(readdirSync(remote).sort()).toEqual([DB, BUNDLE]);
		// every ssh/scp step is key-only, and scp is batch + preserve
		for (const cmd of fake.calls) expect(cmd.join(" ")).toContain("BatchMode=yes");
		const scp = fake.calls.find((cmd) => cmd[0] === "scp") as string[];
		expect(scp.slice(1, 3)).toEqual(["-B", "-p"]);
		expect(fake.calls.find((cmd) => cmd.at(-1)?.startsWith("mkdir"))?.at(-1)).toBe(`mkdir -p -m 700 ${remote}`);

		const stamp = readStamp(join(home, "backups"), OFFSITE_STAMP_FILE);
		expect(stamp).toMatchObject({
			file: DB,
			sha256: sha("db-bytes"),
			bundle: BUNDLE,
			bundleSha256: sha("bundle-bytes"),
		});
		expect(readFileSync(join(home, "backups", OFFSITE_STAMP_FILE), "utf8")).toContain("ssh=box");
	});

	test("a remote sha that differs never renames, removes the .part and leaves no stamp", async () => {
		seedLocal();
		const fake = fakeRemote();
		fake.corrupt = true;
		const error = await runOffsite({
			homeDir: home,
			target: { ssh: "box", remoteDir: remote },
			run: fake.run,
			env: {},
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(OffsiteError);
		expect((error as OffsiteError).code).toBe("sha_mismatch");
		expect(readdirSync(remote)).toEqual([]);
		expect(existsSync(join(home, "backups", OFFSITE_STAMP_FILE))).toBe(false);
	});

	test("a failed copy leaves the previous stamp untouched", async () => {
		seedLocal();
		const fake = fakeRemote();
		await runOffsite({ homeDir: home, target: { ssh: "box", remoteDir: remote }, run: fake.run, env: {} });
		const before = readFileSync(join(home, "backups", OFFSITE_STAMP_FILE), "utf8");
		writeFileSync(join(home, "backups", "ompbot-20261031-043000.db"), "newer");
		fake.failCopy = true;
		const error = await runOffsite({
			homeDir: home,
			target: { ssh: "box", remoteDir: remote },
			run: fake.run,
			env: {},
		}).catch((e: unknown) => e);
		expect((error as OffsiteError).code).toBe("copy_failed");
		expect(readFileSync(join(home, "backups", OFFSITE_STAMP_FILE), "utf8")).toBe(before);
	});

	test("a rerun with the same bytes already there uploads nothing", async () => {
		seedLocal();
		const fake = fakeRemote();
		await runOffsite({ homeDir: home, target: { ssh: "box", remoteDir: remote }, run: fake.run, env: {} });
		fake.calls.length = 0;
		const again = await runOffsite({
			homeDir: home,
			target: { ssh: "box", remoteDir: remote },
			run: fake.run,
			env: {},
		});
		expect(again.files.map((f) => f.status)).toEqual(["present", "present"]);
		expect(fake.calls.some((cmd) => cmd[0] === "scp")).toBe(false);
	});

	test("without a backup stamp the local sha is computed from the file", async () => {
		seedLocal({ stamp: false });
		const fake = fakeRemote();
		const result = await runOffsite({
			homeDir: home,
			target: { ssh: "box", remoteDir: remote },
			run: fake.run,
			env: {},
		});
		expect(result.files[0]?.sha256).toBe(sha("db-bytes"));
	});

	test("retention removes only strict daily names beyond keep; part files, manual copies and strangers stay", async () => {
		seedLocal();
		mkdirSync(remote, { recursive: true });
		const daily = ["20261001", "20261002", "20261003"].map((d) => `ompbot-${d}-043000.db`);
		const bundles = ["20261001", "20261002"].map((d) => `ompbot-bundle-${d}-043000.tar.gz`);
		const keepers = [
			"ompbot-pre-upgrade-20261001.db",
			"ompbot-20261001-043000.db.part",
			"notes.txt",
			"ompbot-20261001-043000.db.bak",
			"last-backup.ok",
		];
		for (const name of [...daily, ...bundles, ...keepers]) writeFileSync(join(remote, name), name);
		const fake = fakeRemote();
		const result = await runOffsite({
			homeDir: home,
			target: { ssh: "box", remoteDir: remote, keep: 2 },
			run: fake.run,
			env: {},
		});
		// keep=2 per kind: the new snapshot + the newest old one; the new bundle + the newest old one
		expect(result.removed.sort()).toEqual(
			["ompbot-20261001-043000.db", "ompbot-20261002-043000.db", "ompbot-bundle-20261001-043000.tar.gz"].sort(),
		);
		const left = readdirSync(remote);
		for (const name of keepers) expect(left).toContain(name);
		expect(left).toContain(DB);
		expect(left).toContain(BUNDLE);
		expect(left).toContain("ompbot-20261003-043000.db");
	});

	test("retention counts days: every file of the uploaded day, the latest of each other day, nothing past keep days", async () => {
		seedLocal();
		mkdirSync(remote, { recursive: true });
		const stamps = [
			"20261030-010000",
			"20261030-020000",
			"20261029-010000",
			"20261029-230000",
			"20261028-120000",
			"20261027-120000",
		];
		for (const stamp of stamps) {
			writeFileSync(join(remote, `ompbot-${stamp}.db`), stamp);
			writeFileSync(join(remote, `ompbot-bundle-${stamp}.tar.gz`), stamp);
		}
		writeFileSync(join(remote, "ompbot-pre-upgrade-20261001.db"), "manual");
		const fake = fakeRemote();
		const result = await runOffsite({
			homeDir: home,
			target: { ssh: "box", remoteDir: remote, keep: 3 },
			run: fake.run,
			env: {},
		});
		// keep=3 days: the uploaded day (all of it) + 10-29 (its latest) + 10-28; 10-27 is past the window.
		expect(result.removed).toEqual([
			"ompbot-20261029-010000.db",
			"ompbot-20261027-120000.db",
			"ompbot-bundle-20261029-010000.tar.gz",
			"ompbot-bundle-20261027-120000.tar.gz",
		]);
		const survivors = ["20261028-120000", "20261029-230000", "20261030-010000", "20261030-020000", "20261030-043000"];
		const left = readdirSync(remote).sort();
		expect(left.filter((name) => /^ompbot-\d{8}-\d{6}\.db$/.test(name))).toEqual(
			survivors.map((s) => `ompbot-${s}.db`),
		);
		expect(left.filter((name) => name.startsWith("ompbot-bundle-"))).toEqual(
			survivors.map((s) => `ompbot-bundle-${s}.tar.gz`),
		);
		expect(left).toContain("ompbot-pre-upgrade-20261001.db");
	});

	test("no local snapshot is an error, and a hostile ssh/remoteDir never reaches a process", async () => {
		const fake = fakeRemote();
		const none = await runOffsite({
			homeDir: home,
			target: { ssh: "box", remoteDir: remote },
			run: fake.run,
			env: {},
		}).catch((e: unknown) => e);
		expect((none as OffsiteError).code).toBe("no_local_backup");
		seedLocal();
		for (const target of [
			{ ssh: "-oProxyCommand=evil", remoteDir: remote },
			{ ssh: "box", remoteDir: "/srv/x; rm -rf ~" },
		]) {
			const error = await runOffsite({ homeDir: home, target, run: fake.run, env: {} }).catch((e: unknown) => e);
			expect((error as OffsiteError).code).toBe("not_configured");
		}
		expect(fake.calls).toEqual([]);
	});

	test("remoteDir is judged like config: `a..b` is a plain name, a `..` segment is refused, `//` collapses (J-이관1)", async () => {
		seedLocal();
		const fake = fakeRemote();
		await runOffsite({
			homeDir: home,
			target: { ssh: "box", remoteDir: `${remote}//a..b/` },
			run: fake.run,
			env: {},
		});
		expect(existsSync(join(remote, "a..b", DB))).toBe(true);
		expect(fake.calls.flat().some((arg) => arg.includes("//"))).toBe(false);
		const error = await runOffsite({
			homeDir: home,
			target: { ssh: "box", remoteDir: `${remote}/../x` },
			run: fake.run,
			env: {},
		}).catch((e: unknown) => e);
		expect((error as OffsiteError).code).toBe("not_configured");
	});

	test("an ssh that cannot connect fails before anything is copied", async () => {
		seedLocal();
		const run: ProcessRunner = async () => ({ code: 255, stdout: "Permission denied (publickey)", timedOut: false });
		const error = await runOffsite({ homeDir: home, target: { ssh: "box", remoteDir: remote }, run, env: {} }).catch(
			(e: unknown) => e,
		);
		expect((error as OffsiteError).code).toBe("ssh_failed");
		expect(existsSync(join(home, "backups", OFFSITE_STAMP_FILE))).toBe(false);
	});

	test("the failure reason is ssh's stderr when stdout is empty", async () => {
		seedLocal();
		const stderr = "ssh: connect to host x port 22: Connection refused";
		const run: ProcessRunner = async () => ({ code: 255, stdout: "", stderr: `${stderr}\n`, timedOut: false });
		const error = await runOffsite({ homeDir: home, target: { ssh: "x", remoteDir: remote }, run, env: {} }).catch(
			(e: unknown) => e,
		);
		expect((error as OffsiteError).code).toBe("ssh_failed");
		expect((error as OffsiteError).message).toContain(stderr);
	});
});

describe("offsite_age gate", () => {
	const now = Date.UTC(2026, 9, 30, 12);
	const find = (offsiteConfigured: boolean) =>
		collectGates({ homeDir: home, now, offsiteConfigured }).find((g) => g.name === "offsite_age");

	function stampAge(ms: number): void {
		mkdirSync(join(home, "backups"), { recursive: true });
		writeFileSync(
			join(home, "backups", OFFSITE_STAMP_FILE),
			`ts=${new Date(now - ms).toISOString()} file=x sha256=y\n`,
		);
	}

	test("does not exist without an offsite config", () => {
		expect(find(false)).toBeUndefined();
		expect(collectGates({ homeDir: home, now }).some((g) => g.name === "offsite_age")).toBe(false);
	});

	test("opens without a stamp and past 36h, closed inside", () => {
		expect(find(true)).toMatchObject({ state: "open", detail: "stamp=missing" });
		stampAge(37 * 3_600_000);
		expect(find(true)?.state).toBe("open");
		stampAge(2 * 3_600_000);
		expect(find(true)?.state).toBe("closed");
	});
});
