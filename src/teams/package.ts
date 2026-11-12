// The Teams app package the owner uploads ("사용자 지정 앱 업로드"): manifest.json naming the bot, and its two icons,
// zipped with no dependency — a stored (uncompressed) zip and plain PNGs are written by hand.
import { deflateSync } from "node:zlib";

export const TEAMS_MANIFEST_VERSION = "1.17";
export const TEAMS_MANIFEST_SCHEMA = `https://developer.microsoft.com/en-us/json-schemas/teams/v${TEAMS_MANIFEST_VERSION}/MicrosoftTeams.schema.json`;
export const TEAMS_BOT_SCOPES = ["personal", "groupChat"] as const;
const PROJECT_URL = "https://ompbot.invalid";

export interface TeamsManifestInput {
	appId: string;
	/** Short name shown in Teams (30 characters at most). */
	name?: string;
	version?: string;
}

export function buildTeamsManifest(input: TeamsManifestInput): Record<string, unknown> {
	const name = (input.name ?? "ompbot").slice(0, 30);
	return {
		$schema: TEAMS_MANIFEST_SCHEMA,
		manifestVersion: TEAMS_MANIFEST_VERSION,
		version: input.version ?? "1.0.0",
		id: input.appId,
		developer: {
			name: "ompbot",
			websiteUrl: PROJECT_URL,
			privacyUrl: PROJECT_URL,
			termsOfUseUrl: PROJECT_URL,
		},
		name: { short: name, full: `${name} (omp)` },
		description: {
			short: "오너의 omp 에이전트에 연결된 대화 봇",
			full: "ompbot은 오너의 omp 코딩 에이전트를 Teams 대화에 연결합니다. 1:1 대화와 그룹 채팅에서 봇을 멘션하면 답합니다.",
		},
		icons: { color: "color.png", outline: "outline.png" },
		accentColor: "#2F6FDE",
		bots: [{ botId: input.appId, scopes: [...TEAMS_BOT_SCOPES], supportsFiles: false, isNotificationOnly: false }],
		permissions: ["identity", "messageTeamMembers"],
		validDomains: [],
	};
}

function crc32(data: Uint8Array): number {
	return Bun.hash.crc32(data) >>> 0;
}

type Rgba = readonly [number, number, number, number];

/** A square RGBA PNG drawn by `pixel` (outline icons need transparency). */
export function iconPng(size: number, pixel: (x: number, y: number) => Rgba): Uint8Array {
	const stride = 1 + size * 4;
	const raw = new Uint8Array(stride * size);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) raw.set(pixel(x, y), y * stride + 1 + x * 4);
	}
	const chunk = (type: string, data: Uint8Array): Uint8Array => {
		const out = new Uint8Array(12 + data.length);
		const view = new DataView(out.buffer);
		view.setUint32(0, data.length);
		out.set(new TextEncoder().encode(type), 4);
		out.set(data, 8);
		view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
		return out;
	};
	const header = new Uint8Array(13);
	const headerView = new DataView(header.buffer);
	headerView.setUint32(0, size);
	headerView.setUint32(4, size);
	header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
	return concat([
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", new Uint8Array(0)),
	]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

/** A zip of `files` stored uncompressed (method 0), dated 1980-01-01 so the same input gives the same bytes. */
export function storedZip(files: ReadonlyArray<{ name: string; data: Uint8Array }>): Uint8Array {
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;
	for (const file of files) {
		const name = new TextEncoder().encode(file.name);
		const crc = crc32(file.data);
		const local = new Uint8Array(30 + name.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(4, 20, true);
		lv.setUint16(12, 0x21, true); // date: 1980-01-01
		lv.setUint32(14, crc, true);
		lv.setUint32(18, file.data.length, true);
		lv.setUint32(22, file.data.length, true);
		lv.setUint16(26, name.length, true);
		local.set(name, 30);
		const central = new Uint8Array(46 + name.length);
		const cv = new DataView(central.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint16(14, 0x21, true);
		cv.setUint32(16, crc, true);
		cv.setUint32(20, file.data.length, true);
		cv.setUint32(24, file.data.length, true);
		cv.setUint16(28, name.length, true);
		cv.setUint32(42, offset, true);
		central.set(name, 46);
		locals.push(local, file.data);
		centrals.push(central);
		offset += local.length + file.data.length;
	}
	const directory = concat(centrals);
	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, files.length, true);
	ev.setUint16(10, files.length, true);
	ev.setUint32(12, directory.length, true);
	ev.setUint32(16, offset, true);
	return concat([...locals, directory, end]);
}

/** The whole package: manifest.json, color.png (192×192) and outline.png (32×32, white on transparent). */
export function buildTeamsPackage(input: TeamsManifestInput): Uint8Array {
	return storedZip([
		{
			name: "manifest.json",
			data: new TextEncoder().encode(`${JSON.stringify(buildTeamsManifest(input), null, 2)}\n`),
		},
		{ name: "color.png", data: iconPng(192, () => [0x2f, 0x6f, 0xde, 0xff]) },
		{
			name: "outline.png",
			// A white square on a transparent ground.
			data: iconPng(32, (x, y) => (x >= 6 && x < 26 && y >= 6 && y < 26 ? [0xff, 0xff, 0xff, 0xff] : [0, 0, 0, 0])),
		},
	]);
}
