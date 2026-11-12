// AC-B3: `ompbot teams package` writes a zip whose manifest names the bot and its scopes and carries the fields the
// Teams manifest schema requires, with both icons at their required sizes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { APP_ID } from "./harness";

/** The manifest fields this test reads. */
interface Manifest {
	[key: string]: unknown;
	$schema: string;
	manifestVersion: string;
	version: string;
	id: string;
	accentColor: string;
	developer: Record<string, string>;
	name: { short: string; full: string };
	description: { short: string; full: string };
	icons: { color: string; outline: string };
	bots: Array<{ botId: string; scopes: string[] }>;
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-teams-package-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** The files of a zip, read through its central directory (stored or deflated entries). */
function unzip(zip: Uint8Array): Map<string, Uint8Array> {
	const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	const end = zip.length - 22;
	expect(view.getUint32(end, true)).toBe(0x06054b50);
	const count = view.getUint16(end + 10, true);
	let at = view.getUint32(end + 16, true);
	const files = new Map<string, Uint8Array>();
	for (let i = 0; i < count; i++) {
		expect(view.getUint32(at, true)).toBe(0x02014b50);
		const method = view.getUint16(at + 10, true);
		const crc = view.getUint32(at + 16, true);
		const size = view.getUint32(at + 20, true);
		const nameLength = view.getUint16(at + 28, true);
		const extraLength = view.getUint16(at + 30, true);
		const commentLength = view.getUint16(at + 32, true);
		const local = view.getUint32(at + 42, true);
		const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
		expect(view.getUint32(local, true)).toBe(0x04034b50);
		const dataAt = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
		const raw = zip.subarray(dataAt, dataAt + size);
		const data = method === 0 ? raw : new Uint8Array(inflateRawSync(raw));
		expect(Bun.hash.crc32(data) >>> 0).toBe(crc);
		files.set(name, data);
		at += 46 + nameLength + extraLength + commentLength;
	}
	return files;
}

/** Width and height of a PNG (IHDR). */
function pngSize(png: Uint8Array): [number, number] {
	expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	return [view.getUint32(16), view.getUint32(20)];
}

describe("ompbot teams package (AC-B3)", () => {
	test("the zip's manifest names the bot, scopes personal+groupChat and has every required field", async () => {
		const out = join(dir, "out", "ompbot-teams.zip");
		const proc = Bun.spawn([process.execPath, "src/main.ts", "teams", "package", "--out", out, "--app-id", APP_ID], {
			env: { ...process.env, OMPBOT_HOME: join(dir, "home") },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
		expect(stdout).toStartWith(`teams_package ${out} bytes=`);

		const files = unzip(new Uint8Array(readFileSync(out)));
		expect([...files.keys()].sort()).toEqual(["color.png", "manifest.json", "outline.png"]);
		const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json"))) as Manifest;

		// Required by the Teams manifest schema (v1.17): every one present and non-empty.
		for (const key of ["$schema", "manifestVersion", "version", "id", "accentColor"]) {
			expect(typeof manifest[key]).toBe("string");
			expect(manifest[key]).not.toBe("");
		}
		expect(manifest.$schema).toContain(`v${manifest.manifestVersion}/MicrosoftTeams.schema.json`);
		expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(manifest.accentColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
		for (const key of ["name", "websiteUrl", "privacyUrl", "termsOfUseUrl"]) {
			expect(manifest.developer[key]).toBeTruthy();
		}
		for (const key of ["websiteUrl", "privacyUrl", "termsOfUseUrl"])
			expect(manifest.developer[key]).toStartWith("https://");
		expect(manifest.name.short.length).toBeGreaterThan(0);
		expect(manifest.name.short.length).toBeLessThanOrEqual(30);
		expect(manifest.description.short.length).toBeLessThanOrEqual(80);
		expect(manifest.description.full.length).toBeLessThanOrEqual(4000);
		expect(manifest.icons).toEqual({ color: "color.png", outline: "outline.png" });

		// The bot and its scopes.
		expect(manifest.id).toBe(APP_ID);
		expect(manifest.bots.map((bot) => [bot.botId, bot.scopes])).toEqual([[APP_ID, ["personal", "groupChat"]]]);

		// The icons Teams asks for: 192×192 colour, 32×32 outline.
		expect(pngSize(files.get("color.png") ?? new Uint8Array())).toEqual([192, 192]);
		expect(pngSize(files.get("outline.png") ?? new Uint8Array())).toEqual([32, 32]);
	});

	test("without --app-id and without channels.teams it refuses (exit 2) and writes nothing", async () => {
		const out = join(dir, "never.zip");
		const proc = Bun.spawn([process.execPath, "src/main.ts", "teams", "package", "--out", out], {
			env: { ...process.env, OMPBOT_HOME: join(dir, "empty-home") },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
		expect(code).toBe(2);
		expect(stderr).toContain("--app-id is required");
		expect(Bun.file(out).size).toBe(0);
	});
});
