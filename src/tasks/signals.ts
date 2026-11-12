/**
 * Machine checks of an acceptance criterion: an optional trailing `[check: <signal>; <signal>]`. The sweep runs them
 * in the task worktree itself before the outcome, so an agent's "bun test → 0 fail" line is never the only proof.
 * The grammar follows omp-dori's Done signals, `command` and `file` only (no network, no PR flow):
 *
 *   command ["argv","as","json"] [stdout~"regex"]     no shell, worktree cwd, 300 s
 *   file <worktree-relative path> [sha256=<hex>] [json:.a.b=<json value>]
 */
import { createHash } from "node:crypto";

export const CHECK_TIMEOUT_MS = 300_000;

export type Signal =
	| { kind: "command"; argv: string[]; stdout?: RegExp }
	| { kind: "file"; path: string; sha256?: string; json?: { path: (string | number)[]; value: unknown } };

/**
 * One signal's verdict; `detail` is a short Korean line, never the command's whole output. `inconclusive`: the command
 * did not finish within `CHECK_TIMEOUT_MS` — not a violation, and never reused (the next judgement runs it again).
 * Every other failure (any exit code, a signal kill, a missing file, a malformed signal) is a violation.
 */
export interface SignalCheck {
	signal: string;
	ok: boolean;
	detail: string;
	inconclusive?: true;
}

export class SignalSyntaxError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SignalSyntaxError";
	}
}

const GRAMMAR =
	'신호는 command ["argv",...] [stdout~"regex"] 또는 file <워크트리 상대경로> [sha256=<hex>] [json:.a.b=<json>]입니다';
const CHECK_OPEN = "[check:";
/** Worktree-relative file path: the host interpolates it into a path check, so only these characters pass. */
const RELATIVE_PATH = /^[A-Za-z0-9_./-]+$/;

/** Index just past the closing quote of the JSON string opening at `i`. */
function skipString(s: string, i: number): number {
	let end = i + 1;
	while (end < s.length && s[end] !== '"') end += s[end] === "\\" ? 2 : 1;
	return end + 1;
}

/** Index of the bracket closing the one at `open` (quotes and nesting respected); `-1` when it never closes. */
function closingBracket(s: string, open: number): number {
	let depth = 0;
	for (let i = open; i < s.length; i++) {
		const c = s[i];
		if (c === '"') i = skipString(s, i) - 1;
		else if (c === "[" || c === "{") depth += 1;
		else if ((c === "]" || c === "}") && --depth === 0) return i;
	}
	return -1;
}

/**
 * The signals of the `[check: …]` that ends `text`; `[]` when the text does not end in one (a `[check:` quoted in the
 * middle of a sentence is prose). An unterminated trailing `[check:` is a syntax error, not prose, unless an earlier
 * block ending the text encloses it (a quoted argument such as `["grep","[check:"]`).
 */
export function checkSignalsOf(text: string): string[] {
	const t = text.trim();
	const last = t.lastIndexOf(CHECK_OPEN);
	if (last === -1) return [];
	let open = last;
	while (open !== -1 && closingBracket(t, open) !== t.length - 1)
		open = open === 0 ? -1 : t.lastIndexOf(CHECK_OPEN, open - 1);
	if (open === -1) {
		if (closingBracket(t, last) === -1)
			throw new SignalSyntaxError(`[check: …]가 닫히지 않았습니다: ${t.slice(last, last + 60)}`);
		return [];
	}
	const body = t.slice(open + CHECK_OPEN.length, t.length - 1);
	const parts: string[] = [];
	let start = 0;
	for (let i = 0; i < body.length; i++) {
		const c = body[i];
		if (c === '"') i = skipString(body, i) - 1;
		else if (c === "[" || c === "{") i = Math.max(closingBracket(body, i), i);
		else if (c === ";") {
			parts.push(body.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(body.slice(start));
	const signals = parts.map((part) => part.trim());
	if (signals.some((signal) => signal === "")) throw new SignalSyntaxError("[check: …]에 빈 신호가 있습니다");
	return signals;
}

/**
 * Registration rule (judgement keeps reading the trailing block only): one `[check: …]` per criterion, at its very end.
 * `[check:` inside a double-quoted string or inline code (a backtick run closed by a run of the same length) is a
 * quotation and does not count. Throws `SignalSyntaxError` on a second block or on text after the block.
 */
export function assertCheckPlacement(text: string): void {
	const blocks: Array<[number, number]> = [];
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '"') {
			i = skipString(text, i) - 1;
		} else if (c === "`") {
			let run = i;
			while (text[run] === "`") run += 1;
			const ticks = text.slice(i, run);
			let close = text.indexOf(ticks, run);
			while (close !== -1 && text[close + ticks.length] === "`") {
				let past = close;
				while (text[past] === "`") past += 1;
				close = text.indexOf(ticks, past);
			}
			i = close === -1 ? run - 1 : close + ticks.length - 1;
		} else if (text.startsWith(CHECK_OPEN, i)) {
			const close = closingBracket(text, i);
			// An unterminated block is `parseChecks`' syntax error.
			if (close === -1) break;
			blocks.push([i, close]);
			i = close;
		}
	}
	if (blocks.length > 1)
		throw new SignalSyntaxError(
			"한 수락기준에 [check: …]는 하나만 둘 수 있습니다 — 신호를 세미콜론(;)으로 한 블록에 묶거나 기준을 나누세요",
		);
	const close = blocks[0]?.[1];
	const after = close === undefined ? "" : text.slice(close + 1).trim();
	if (after !== "") throw new SignalSyntaxError(`[check: …]는 수락기준 맨 끝에 와야 합니다: ${after.slice(0, 40)}`);
}

/** Parses every check of `text`; throws `SignalSyntaxError` on the first malformed one. */
export function parseChecks(text: string): Signal[] {
	return checkSignalsOf(text).map(parseSignal);
}

/** A JSON value at `i`: a string, array or object (must parse), or a bare word (JSON if it parses, else text). */
function readValue(s: string, i: number): { value: unknown; text: string; end: number } {
	const open = s[i];
	let end: number;
	if (open === '"') end = skipString(s, i);
	else if (open === "[" || open === "{") end = closingBracket(s, i) + 1 || s.length;
	else {
		end = i;
		while (end < s.length && !/\s/.test(s[end] ?? "")) end += 1;
	}
	const text = s.slice(i, end);
	try {
		return { value: JSON.parse(text), text, end };
	} catch {
		if (open === '"' || open === "[" || open === "{")
			throw new SignalSyntaxError(`JSON 값이 아닙니다: ${text.slice(0, 40)}`);
		return { value: text, text, end };
	}
}

interface SignalOption {
	key: string;
	op: "=" | "~";
	value: unknown;
	text: string;
}

function readOptions(s: string, from: number, kind: string, allowed: (key: string) => boolean): SignalOption[] {
	const options: SignalOption[] = [];
	let i = from;
	while (i < s.length) {
		while (/\s/.test(s[i] ?? "")) i += 1;
		if (i >= s.length) break;
		const match = /^([a-z0-9_]+(?::[^=~\s]+)?)([=~])/i.exec(s.slice(i));
		if (match === null)
			throw new SignalSyntaxError(`${kind}: key=값 또는 key~"정규식"이 와야 합니다: ${s.slice(i, i + 30)}`);
		const key = match[1] as string;
		if (!allowed(key)) throw new SignalSyntaxError(`${kind}: 모르는 옵션 ${key}`);
		i += match[0].length;
		const read = readValue(s, i);
		options.push({ key, op: match[2] as "=" | "~", value: read.value, text: read.text });
		i = read.end;
	}
	return options;
}

function parseCommand(s: string, at: number): Signal {
	if (s[at] !== "[") throw new SignalSyntaxError('command는 JSON argv 배열을 받습니다(예: command ["bun","test"])');
	const { value, end } = readValue(s, at);
	if (!Array.isArray(value) || value.length === 0 || !value.every((arg) => typeof arg === "string" && arg !== ""))
		throw new SignalSyntaxError("command argv는 비어 있지 않은 문자열 배열이어야 합니다");
	const stdout = readOptions(s, end, "command", (key) => key === "stdout")[0];
	if (stdout === undefined) return { kind: "command", argv: value as string[] };
	if (stdout.op !== "~" || typeof stdout.value !== "string")
		throw new SignalSyntaxError('stdout은 ~"정규식"을 받습니다');
	try {
		return { kind: "command", argv: value as string[], stdout: new RegExp(stdout.value) };
	} catch {
		throw new SignalSyntaxError(`stdout: 잘못된 정규식 ${stdout.value}`);
	}
}

function parseFile(s: string, at: number): Signal {
	const token = readValue(s, at);
	const path = s[at] === '"' ? token.value : token.text;
	if (typeof path !== "string" || path === "") throw new SignalSyntaxError("file에는 경로가 필요합니다");
	const segments = path.split("/");
	if (!RELATIVE_PATH.test(path) || segments.some((part) => part === "" || part === "." || part === ".."))
		throw new SignalSyntaxError(
			`file 경로는 워크트리 안 파일의 상대경로여야 합니다(영숫자·_ . / - 만, 절대경로·. ·.. 금지): ${path}`,
		);
	const options = readOptions(s, token.end, "file", (key) => key === "sha256" || key.startsWith("json:"));
	const signal: Signal = { kind: "file", path };
	for (const option of options) {
		if (option.key === "sha256") {
			if (option.op !== "=" || !/^[0-9a-f]{64}$/i.test(option.text))
				throw new SignalSyntaxError("sha256=는 16진수 64자를 받습니다");
			signal.sha256 = option.text.toLowerCase();
			continue;
		}
		if (option.op !== "=") throw new SignalSyntaxError("json:<경로>는 =<json 값>을 받습니다");
		const fields = option.key
			.slice("json:".length)
			.replace(/^\./, "")
			.split(".")
			.filter((field) => field !== "")
			.map((field) => (/^\d+$/.test(field) ? Number(field) : field));
		if (fields.length === 0) throw new SignalSyntaxError("json:에는 json:.version 같은 필드 경로가 필요합니다");
		signal.json = { path: fields, value: option.value };
	}
	return signal;
}

export function parseSignal(raw: string): Signal {
	const s = raw.trim();
	const head = /^(command|file)\s+/i.exec(s);
	if (head === null) throw new SignalSyntaxError(`읽을 수 없는 신호: ${s.slice(0, 40)} — ${GRAMMAR}`);
	return (head[1] as string).toLowerCase() === "command"
		? parseCommand(s, head[0].length)
		: parseFile(s, head[0].length);
}

/** What the host gives a signal: the worktree is implied. */
export interface SignalIo {
	/** `argv` without a shell in the worktree under `CHECK_TIMEOUT_MS`; `output` is stdout then stderr. */
	runCheck(argv: string[]): Promise<{ code: number | null; output: string; timedOut: boolean }>;
	/** A worktree-relative file; `undefined` when it does not exist (an unreadable host throws). */
	readFile(path: string): Promise<string | undefined>;
}

/** The last characters of an output on one line: where a test runner prints its verdict. */
const tail = (text: string): string => {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > 80 ? `…${line.slice(-80)}` : line;
};

function dig(value: unknown, path: readonly (string | number)[]): { found: boolean; value: unknown } {
	let current = value;
	for (const key of path) {
		// Own fields only: `__proto__`/`constructor` are not fields of the file.
		if (current === null || typeof current !== "object" || !Object.hasOwn(current, key))
			return { found: false, value: undefined };
		current = (current as Record<string | number, unknown>)[key];
	}
	return { found: true, value: current };
}

/** Runs one signal; a malformed signal is a failed check (registration rejects them, older tasks may carry one). */
export async function runSignal(raw: string, io: SignalIo): Promise<SignalCheck> {
	const signal = raw.trim();
	let parsed: Signal;
	try {
		parsed = parseSignal(signal);
	} catch (error) {
		return { signal, ok: false, detail: error instanceof Error ? error.message : String(error) };
	}
	const verdict = (ok: boolean, detail: string): SignalCheck => ({ signal, ok, detail });
	if (parsed.kind === "command") {
		const result = await io.runCheck(parsed.argv);
		if (result.timedOut)
			return {
				signal,
				ok: false,
				detail: `${CHECK_TIMEOUT_MS / 1000}초 안에 끝나지 않았습니다(확인 불가)`,
				inconclusive: true,
			};
		if (result.code !== 0) return verdict(false, `exit ${result.code}: ${tail(result.output) || "(출력 없음)"}`);
		if (parsed.stdout !== undefined && !parsed.stdout.test(result.output))
			return verdict(false, `exit 0, 출력이 ${parsed.stdout}와 맞지 않습니다: ${tail(result.output) || "(출력 없음)"}`);
		return verdict(true, parsed.stdout === undefined ? "exit 0" : `exit 0, 출력이 ${parsed.stdout}와 맞습니다`);
	}
	const text = await io.readFile(parsed.path);
	if (text === undefined) return verdict(false, `파일이 없습니다: ${parsed.path}`);
	if (parsed.sha256 !== undefined) {
		const got = createHash("sha256").update(text, "utf8").digest("hex");
		if (got !== parsed.sha256) return verdict(false, `sha256 ${got.slice(0, 12)}… ≠ ${parsed.sha256.slice(0, 12)}…`);
	}
	if (parsed.json !== undefined) {
		let document: unknown;
		try {
			document = JSON.parse(text);
		} catch {
			return verdict(false, `JSON이 아닙니다: ${parsed.path}`);
		}
		const field = `.${parsed.json.path.join(".")}`;
		const hit = dig(document, parsed.json.path);
		const want = JSON.stringify(parsed.json.value);
		if (!hit.found) return verdict(false, `${field} 필드가 없습니다`);
		const got = JSON.stringify(hit.value) ?? "undefined";
		if (got !== want) return verdict(false, `${field}가 ${tail(got)}입니다(기대 ${tail(want)})`);
	}
	return verdict(
		true,
		`있음${parsed.sha256 === undefined ? "" : ", sha256 일치"}${parsed.json === undefined ? "" : `, .${parsed.json.path.join(".")} 일치`}`,
	);
}
