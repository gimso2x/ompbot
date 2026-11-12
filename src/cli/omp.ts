import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	type Stats,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, type OmpbotConfig } from "../config";
import { countOmpModels } from "../daemon/doctor";
import { botRpcEnv, splitModel } from "../daemon/run";
import { dispatchEnv, type ProcessRunner, realProcessRunner } from "../dispatch/omp";
import type { OmpFinal } from "../omp/driver";
import { withOmpProfile } from "../omp/env";
import { RpcOmpDriver } from "../omp/rpc-driver";
import { checkOmpRuntime, type OmpRuntimeProblem } from "../omp/runtime-check";

export const OMP_USAGE = `  omp install <version>          install @oh-my-pi/pi-coding-agent@<version> under <home>/omp/<version> (bun add; the
                                 installed --version must be omp/<version>, else the folder is removed); current is untouched
  omp use <version>              install if missing, then trial-run it (runtime check, one RPC turn, one omp -p) with the
                                 bot's env; all three pass → <home>/omp/current points at it, the old one becomes previous.
                                 Prints the ompExecutable to set; the daemon picks it up at the next restart (ompbot apply)
  omp rollback                   current ← previous (no trial run)
  omp status                     current/previous/installed versions, global omp, whether ompExecutable is current, the
                                 profile dir, last sync and pending changes, and whether the pinned omp reads the login
                                 (models --json > 0, bot env); exit 1 when that check fails
  omp prune                      remove installed versions other than current and previous
  omp sync [--init]              copy the owner's omp agent dir into the bot profile (config ompProfile): RULES.md,
                                 extensions/, skills/, models.yml, mcp.json mirrored, config.yml with its agent-dir paths
                                 rewritten, agent.db(-shm,-wal) as symlinks to the owner's login, managed-skills/ added
                                 and updated (the bot's own kept); --init also copies the mnemopi memory once
`;

export const OMP_PACKAGE = "@oh-my-pi/pi-coding-agent";
/** An npm version of omp: `18.18.9`, `18.19.0-beta.1`. */
export const OMP_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** The trial prompt of `omp use` (RPC turn and `omp -p`): the answer must contain `OK`. */
export const TRIAL_PROMPT = "OK 한 단어로만 답해";
export const TRIAL_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 600_000;
const FAIL_TAIL_LINES = 20;

/** `<home>/omp`: one folder per installed version, the `current`/`previous` links and `last-sync`. */
export const ompRoot = (homeDir: string): string => join(homeDir, "omp");
/** The launcher inside an install folder (a version folder or `current`). */
export const cliPathIn = (installDir: string): string =>
	join(installDir, "node_modules", OMP_PACKAGE, "dist", "cli.js");
/** What `ompExecutable` names once the bot runs the pinned omp. */
export const currentCliPath = (homeDir: string): string => cliPathIn(join(ompRoot(homeDir), "current"));
/** omp's agent dir of `OMP_PROFILE=<profile>` (`~/.omp/profiles/<profile>/agent`). */
export const profileAgentDir = (userHome: string, profile: string): string =>
	join(userHome, ".omp", "profiles", profile, "agent");
/** The owner's agent dir, the sync source: `PI_CODING_AGENT_DIR`, else `~/.omp/agent`. */
export const sourceAgentDir = (env: Record<string, string | undefined>): string =>
	env.PI_CODING_AGENT_DIR ?? join(userHomeOf(env), ".omp", "agent");
const userHomeOf = (env: Record<string, string | undefined>): string => env.HOME ?? homedir();

export interface TrialResult {
	ok: boolean;
	detail: string;
}

export interface OmpCliDeps {
	homeDir: string;
	/** The bot's config (ompProfile, model, ompExecutable); absent when the home has no config.json. */
	config?: OmpbotConfig;
	/** Parent env: HOME, PATH, PI_CODING_AGENT_DIR. */
	env: Record<string, string | undefined>;
	/** The bun that installs and runs omp. */
	bun: string;
	/** `bun add`, `--version` and the `omp -p` trial. */
	run: ProcessRunner;
	/** Trial ①: the launcher/bun check the RPC driver runs before every spawn. */
	runtimeCheck: (cliPath: string, bun: string) => OmpRuntimeProblem | undefined;
	/** Trial ②: one RPC turn through the driver the daemon uses. */
	rpcTrial: (input: { cliPath: string; cwd: string; profile?: string; model?: string }) => Promise<TrialResult>;
	/** `models --json` count with the bot env (number) or why it could not be read (string). */
	countModels: (cliPath: string, profile: string | undefined) => Promise<number | string>;
	out: (line: string) => void;
	now: () => number;
}

const tail = (text: string): string => text.trimEnd().split("\n").slice(-FAIL_TAIL_LINES).join("\n");

function readLink(path: string): string | undefined {
	try {
		return readlinkSync(path);
	} catch {
		return undefined;
	}
}

/** Points `<root>/<name>` at `target` (a version folder name) atomically: a temp link, then rename over the old one. */
function swapLink(root: string, name: "current" | "previous", target: string, now: number): void {
	const temp = join(root, `.${name}-${process.pid}-${now}`);
	rmSync(temp, { force: true });
	symlinkSync(target, temp);
	renameSync(temp, join(root, name));
}

function installedVersions(homeDir: string): string[] {
	const root = ompRoot(homeDir);
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && OMP_VERSION_PATTERN.test(entry.name))
		.map((entry) => entry.name)
		.sort((a, b) => Bun.semver.order(a, b));
}

/** The version a launcher reports (`omp/<version>` → `<version>`), or the raw first line / failure. */
async function launcherVersion(deps: OmpCliDeps, cliPath: string): Promise<string> {
	const result = await deps.run([deps.bun, cliPath, "--version"], {
		timeoutMs: 30_000,
		env: dispatchEnv(deps.env),
	});
	const line = result.stdout.trim().split("\n")[0]?.trim() ?? "";
	return result.code === 0 ? line : `exit=${result.code ?? "killed"} ${line}`.trim();
}

/** `ompbot omp install <version>`. */
export async function ompInstall(version: string, deps: OmpCliDeps): Promise<number> {
	if (!OMP_VERSION_PATTERN.test(version)) {
		deps.out(`omp install: invalid version ${version}`);
		return 2;
	}
	const root = ompRoot(deps.homeDir);
	const dir = join(root, version);
	const cliPath = cliPathIn(dir);
	if (existsSync(cliPath) && (await launcherVersion(deps, cliPath)) === `omp/${version}`) {
		chmodSync(cliPath, 0o755);
		deps.out(`omp_install version=${version} dir=${dir} already_installed`);
		return 0;
	}
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(root, { recursive: true, mode: 0o700 });
	mkdirSync(dir, { mode: 0o700 });
	chmodSync(dir, 0o700);
	writeFileSync(join(dir, "package.json"), `${JSON.stringify({ private: true })}\n`, { mode: 0o600 });
	const added = await deps.run([deps.bun, "add", `${OMP_PACKAGE}@${version}`], {
		cwd: dir,
		timeoutMs: INSTALL_TIMEOUT_MS,
		env: dispatchEnv(deps.env),
	});
	const fail = (reason: string, output = ""): number => {
		rmSync(dir, { recursive: true, force: true });
		deps.out(`omp install failed: ${reason} (removed ${dir})`);
		if (output.trim() !== "") deps.out(tail(output));
		return 1;
	};
	if (added.code !== 0 || added.timedOut) {
		return fail(`bun add exit=${added.code ?? "killed"}`, `${added.stdout}\n${added.stderr ?? ""}`);
	}
	if (!existsSync(cliPath)) return fail(`${cliPath} missing after bun add`);
	// The RPC driver requires X_OK on the launcher.
	chmodSync(cliPath, 0o755);
	const reported = await launcherVersion(deps, cliPath);
	if (reported !== `omp/${version}`) return fail(`installed --version is "${reported}", expected omp/${version}`);
	deps.out(`omp_install version=${version} dir=${dir}`);
	return 0;
}

/** `ompbot omp use <version>`: trial-run the install with the bot's env, then switch `current` only if all three pass. */
export async function ompUse(version: string, deps: OmpCliDeps): Promise<number> {
	if (!OMP_VERSION_PATTERN.test(version)) {
		deps.out(`omp use: invalid version ${version}`);
		return 2;
	}
	const root = ompRoot(deps.homeDir);
	const dir = join(root, version);
	if (!existsSync(cliPathIn(dir))) {
		const installed = await ompInstall(version, deps);
		if (installed !== 0) return installed;
	}
	const cliPath = cliPathIn(dir);
	const profile = deps.config?.ompProfile;
	const model = deps.config?.model;
	const fail = (stage: string, detail: string): number => {
		deps.out(`omp use failed: ${stage}; current unchanged`);
		if (detail.trim() !== "") deps.out(tail(detail));
		return 1;
	};

	let real: string;
	try {
		real = realpathSync(cliPath);
	} catch (error) {
		return fail("runtime", String(error));
	}
	const problem = deps.runtimeCheck(real, deps.bun);
	if (problem !== undefined) return fail("runtime", `${problem.code} ${problem.message}`);
	deps.out("omp_use_trial stage=runtime ok=true");

	const cwd = mkdtempSync(join(tmpdir(), "ompbot-omp-trial-"));
	try {
		const rpc = await deps.rpcTrial({
			cliPath,
			cwd,
			...(profile === undefined ? {} : { profile }),
			...(model === undefined ? {} : { model }),
		});
		if (!rpc.ok) return fail("rpc", rpc.detail);
		deps.out("omp_use_trial stage=rpc ok=true");

		const print = await deps.run(
			[cliPath, "-p", "--no-title", ...(model === undefined ? [] : ["--model", model]), TRIAL_PROMPT],
			{ cwd, timeoutMs: TRIAL_TIMEOUT_MS, env: withOmpProfile(dispatchEnv(deps.env), profile) },
		);
		const printed = `${print.stdout}\n${print.stderr ?? ""}`;
		if (print.timedOut) return fail("print", `timeout after ${TRIAL_TIMEOUT_MS / 1000}s\n${printed}`);
		if (print.code !== 0) return fail("print", `exit=${print.code ?? "killed"}\n${printed}`);
		if (!print.stdout.includes("OK")) return fail("print", `no OK in the answer\n${printed}`);
		deps.out("omp_use_trial stage=print ok=true");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}

	const old = readLink(join(root, "current"));
	swapLink(root, "current", version, deps.now());
	if (old !== undefined && old !== version) swapLink(root, "previous", old, deps.now());
	deps.out(`omp_use current=${version} previous=${readLink(join(root, "previous")) ?? "none"}`);
	deps.out(`ompExecutable: ${currentCliPath(deps.homeDir)}`);
	if (deps.config !== undefined && deps.config.ompExecutable !== currentCliPath(deps.homeDir)) {
		deps.out(`config.json ompExecutable is ${deps.config.ompExecutable}; set it to the path above`);
	}
	deps.out("`ompbot apply`로 재시작해야 반영된다");
	return 0;
}

/** `ompbot omp rollback`: current ← previous, the old current becomes previous. */
export function ompRollback(deps: OmpCliDeps): number {
	const root = ompRoot(deps.homeDir);
	const previous = readLink(join(root, "previous"));
	if (previous === undefined || !existsSync(join(root, previous))) {
		deps.out("omp rollback failed: no previous version");
		return 1;
	}
	const current = readLink(join(root, "current"));
	swapLink(root, "current", previous, deps.now());
	if (current !== undefined && current !== previous) swapLink(root, "previous", current, deps.now());
	deps.out(`omp_rollback current=${previous} previous=${current ?? "none"}`);
	deps.out("`ompbot apply`로 재시작해야 반영된다");
	return 0;
}

/** `ompbot omp prune`: removes version folders other than `current` and `previous` (only under `<home>/omp`). */
export function ompPrune(deps: OmpCliDeps): number {
	const root = ompRoot(deps.homeDir);
	const keep = new Set([readLink(join(root, "current")), readLink(join(root, "previous"))]);
	let removed = 0;
	for (const version of installedVersions(deps.homeDir)) {
		if (keep.has(version)) continue;
		rmSync(join(root, version), { recursive: true, force: true });
		deps.out(`omp_prune removed=${version}`);
		removed += 1;
	}
	deps.out(`omp_prune_done removed=${removed} kept=${[...keep].filter((v) => v !== undefined).join(",") || "none"}`);
	return 0;
}

/** `ompbot omp status`; exit 1 when the pinned omp cannot read the login (or there is no current). */
export async function ompStatus(deps: OmpCliDeps): Promise<number> {
	const root = ompRoot(deps.homeDir);
	const current = readLink(join(root, "current"));
	const previous = readLink(join(root, "previous"));
	const profile = deps.config?.ompProfile;
	let failed = false;
	deps.out(`current=${current ?? "none"} previous=${previous ?? "none"}`);
	deps.out(`installed=${installedVersions(deps.homeDir).join(",") || "none"}`);
	const globalOmp = Bun.which("omp", { PATH: deps.env.PATH ?? "" });
	if (globalOmp === null) deps.out("global=none");
	else {
		const result = await deps.run([globalOmp, "--version"], { timeoutMs: 30_000, env: dispatchEnv(deps.env) });
		deps.out(`global=${result.stdout.trim().split("\n")[0] ?? ""} (${globalOmp})`);
	}
	if (deps.config !== undefined) {
		const pinned = deps.config.ompExecutable === currentCliPath(deps.homeDir);
		deps.out(`ompExecutable=${deps.config.ompExecutable} current=${pinned ? "yes" : "no"}`);
	}
	if (profile === undefined) deps.out("profile=none (config ompProfile not set)");
	else {
		const target = profileAgentDir(userHomeOf(deps.env), profile);
		deps.out(`profile=${profile} dir=${target} exists=${existsSync(target) ? "yes" : "no"}`);
		const lastSync = existsSync(join(root, "last-sync"))
			? readFileSync(join(root, "last-sync"), "utf8").trim()
			: "never";
		let pending: string;
		try {
			pending = String(
				syncProfile({ source: sourceAgentDir(deps.env), target, userHome: userHomeOf(deps.env), dryRun: true }).changed
					.length,
			);
		} catch (error) {
			pending = `unknown (${error instanceof Error ? error.message : String(error)})`;
		}
		deps.out(`last_sync=${lastSync} pending_changes=${pending}`);
	}
	if (current === undefined) {
		deps.out("login fail: no current version (ompbot omp use <version>)");
		return 1;
	}
	const models = await deps.countModels(currentCliPath(deps.homeDir), profile);
	if (typeof models === "number" && models > 0) deps.out(`login ok models=${models}`);
	else {
		failed = true;
		deps.out(
			`login fail ${typeof models === "number" ? "models=0 (the pinned omp reads no login: agent.db schema or provider login)" : models}`,
		);
	}
	return failed ? 1 : 0;
}

// ---------------------------------------------------------------- profile sync

/** Entries mirrored from the owner's agent dir on every sync (removed from the profile when the owner has none). */
export const SYNC_MIRRORED = ["RULES.md", "extensions", "skills", "models.yml", "mcp.json"] as const;
/** The login store: always symlinks to the owner's files, never copies (two copies would refresh OAuth tokens apart). */
export const SYNC_LOGIN_LINKS = ["agent.db", "agent.db-shm", "agent.db-wal"] as const;
/** Names never copied inside a mirrored tree. */
const SKIPPED_NAME = /\.bak/;

export interface SyncResult {
	/** One line per change (`copied <path>`, `removed <path>`, `linked <path>`, …). */
	changed: string[];
	warnings: string[];
}

interface SyncContext {
	dryRun: boolean;
	result: SyncResult;
}

function lstatOrUndefined(path: string): Stats | undefined {
	return lstatSync(path, { throwIfNoEntry: false });
}

function sameFile(a: string, b: string): boolean {
	const sa = statSync(a);
	const sb = statSync(b);
	return (sa.mode & 0o777) === (sb.mode & 0o777) && sa.size === sb.size && readFileSync(a).equals(readFileSync(b));
}

function remove(path: string, rel: string, ctx: SyncContext): void {
	ctx.result.changed.push(`removed ${rel}`);
	if (!ctx.dryRun) rmSync(path, { recursive: true, force: true });
}

/**
 * Makes `dst` the same as `src`: files by content and mode, directories entry by entry (profile-only entries removed),
 * symlinks re-created as absolute links to the source link's real path (a relative link breaks two levels deeper).
 * A broken source link is skipped with a warning and leaves the profile's entry alone.
 */
function mirror(src: string, dst: string, rel: string, ctx: SyncContext): void {
	const s = lstatOrUndefined(src);
	const d = lstatOrUndefined(dst);
	if (s === undefined) {
		if (d !== undefined) remove(dst, rel, ctx);
		return;
	}
	if (s.isSymbolicLink()) {
		let real: string;
		try {
			real = realpathSync(src);
		} catch {
			ctx.result.warnings.push(`skipped broken link ${rel} -> ${readLink(src) ?? "?"}`);
			return;
		}
		if (d?.isSymbolicLink() && readLink(dst) === real) return;
		ctx.result.changed.push(`linked ${rel} -> ${real}`);
		if (ctx.dryRun) return;
		if (d !== undefined) rmSync(dst, { recursive: true, force: true });
		symlinkSync(real, dst);
		return;
	}
	if (s.isDirectory()) {
		if (d !== undefined && !d.isDirectory()) remove(dst, rel, ctx);
		const present = d?.isDirectory() === true;
		if (!present) {
			ctx.result.changed.push(`created ${rel}/`);
			if (!ctx.dryRun) mkdirSync(dst, { recursive: true, mode: s.mode & 0o777 });
		}
		const names = new Set(readdirSync(src));
		if (present) for (const name of readdirSync(dst)) names.add(name);
		for (const name of [...names].sort()) {
			if (SKIPPED_NAME.test(name)) continue;
			mirror(join(src, name), join(dst, name), `${rel}/${name}`, ctx);
		}
		return;
	}
	if (!s.isFile()) return;
	if (d?.isFile() && sameFile(src, dst)) return;
	ctx.result.changed.push(`copied ${rel}`);
	if (ctx.dryRun) return;
	if (d !== undefined && !d.isFile()) rmSync(dst, { recursive: true, force: true });
	copyFileSync(src, dst);
	chmodSync(dst, s.mode & 0o777);
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `config.yml` text with every path into the owner's agent dir (`~/.omp/agent`, its absolute form, the source) moved to `target`. */
export function rewriteAgentPaths(text: string, source: string, target: string, userHome: string): string {
	const forms = [...new Set(["~/.omp/agent", join(userHome, ".omp", "agent"), resolve(source)])];
	const pattern = new RegExp(`(?:${forms.map(escapeRegExp).join("|")})(?=/|["'\\s,\\]}]|$)`, "gm");
	return text.replace(pattern, target);
}

function sha256(path: string): string | undefined {
	try {
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch {
		return undefined;
	}
}

function mtimeOf(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

/** A consistent copy of one SQLite file (`VACUUM INTO`), readable while the owner's omp writes to it. */
function vacuumInto(src: string, dst: string): void {
	const db = new Database(src, { readonly: true });
	try {
		db.run("VACUUM INTO ?", [dst]);
	} finally {
		db.close();
	}
	chmodSync(dst, 0o600);
}

/** `--init` only: the owner's mnemopi memory (main db and `banks/`), copied once when the profile has none. */
function initMemory(source: string, target: string, ctx: SyncContext): void {
	const srcDir = join(source, "memories", "mnemopi");
	const dstDir = join(target, "memories", "mnemopi");
	if (!existsSync(join(srcDir, "mnemopi.db")) || existsSync(join(dstDir, "mnemopi.db"))) return;
	const banksDir = join(srcDir, "banks");
	const banks = existsSync(banksDir)
		? readdirSync(banksDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
		: [];
	ctx.result.changed.push(`copied memories/mnemopi (banks=${banks.length})`);
	if (ctx.dryRun) return;
	mkdirSync(dstDir, { recursive: true, mode: 0o700 });
	for (const bank of banks) {
		const from = join(banksDir, bank.name);
		const to = join(dstDir, "banks", bank.name);
		mkdirSync(to, { recursive: true, mode: 0o700 });
		for (const entry of readdirSync(from, { withFileTypes: true })) {
			if (!entry.isFile() || /\.db-(?:wal|shm)$/.test(entry.name) || SKIPPED_NAME.test(entry.name)) continue;
			if (entry.name.endsWith(".db")) vacuumInto(join(from, entry.name), join(to, entry.name));
			else copyFileSync(join(from, entry.name), join(to, entry.name));
		}
	}
	// The main db last: its presence marks a finished init.
	vacuumInto(join(srcDir, "mnemopi.db"), join(dstDir, "mnemopi.db"));
}

/**
 * `managed-skills/`: a skill only the owner has is copied; one both have is replaced when the owner's SKILL.md differs
 * and is newer (`init`: whenever the trees differ); one only the profile has (the bot made it) stays.
 */
function syncManagedSkills(source: string, target: string, init: boolean, ctx: SyncContext): void {
	const srcRoot = join(source, "managed-skills");
	const dstRoot = join(target, "managed-skills");
	if (!existsSync(srcRoot)) return;
	if (!existsSync(dstRoot)) {
		ctx.result.changed.push("created managed-skills/");
		if (!ctx.dryRun) mkdirSync(dstRoot, { recursive: true, mode: 0o700 });
	}
	for (const name of readdirSync(srcRoot).sort()) {
		if (SKIPPED_NAME.test(name)) continue;
		const src = join(srcRoot, name);
		const dst = join(dstRoot, name);
		const rel = `managed-skills/${name}`;
		if (lstatOrUndefined(dst) === undefined || init) {
			mirror(src, dst, rel, ctx);
			continue;
		}
		const srcSkill = join(src, "SKILL.md");
		const dstSkill = join(dst, "SKILL.md");
		if (sha256(srcSkill) !== sha256(dstSkill) && mtimeOf(srcSkill) > mtimeOf(dstSkill)) mirror(src, dst, rel, ctx);
	}
}

/**
 * Brings the profile agent dir `target` in line with the owner's agent dir `source` (see `OMP_USAGE`). `dryRun` only
 * lists what would change. Sessions, caches, history, models.db and backups are never touched.
 */
export function syncProfile(input: {
	source: string;
	target: string;
	/** Whose `~/.omp/agent` the absolute config.yml paths name; default two levels above `source`. */
	userHome?: string;
	init?: boolean;
	dryRun?: boolean;
}): SyncResult {
	const { source, target } = input;
	const ctx: SyncContext = { dryRun: input.dryRun === true, result: { changed: [], warnings: [] } };
	if (!existsSync(source)) throw new Error(`source agent dir ${source} does not exist`);
	if (!existsSync(target)) {
		ctx.result.changed.push(`created ${target}`);
		if (ctx.dryRun) return ctx.result;
	}
	if (!ctx.dryRun) {
		mkdirSync(target, { recursive: true, mode: 0o700 });
		chmodSync(target, 0o700);
	}
	for (const name of SYNC_MIRRORED) mirror(join(source, name), join(target, name), name, ctx);

	const srcConfig = join(source, "config.yml");
	const dstConfig = join(target, "config.yml");
	if (!existsSync(srcConfig)) {
		if (lstatOrUndefined(dstConfig) !== undefined) remove(dstConfig, "config.yml", ctx);
	} else {
		const userHome = input.userHome ?? resolve(source, "..", "..");
		const text = rewriteAgentPaths(readFileSync(srcConfig, "utf8"), source, target, userHome);
		const d = lstatOrUndefined(dstConfig);
		if (!(d?.isFile() === true && readFileSync(dstConfig, "utf8") === text)) {
			ctx.result.changed.push("copied config.yml (agent paths rewritten)");
			if (!ctx.dryRun) {
				if (d !== undefined) rmSync(dstConfig, { recursive: true, force: true });
				writeFileSync(dstConfig, text, { mode: 0o600 });
			}
		}
	}

	for (const name of SYNC_LOGIN_LINKS) {
		const link = join(target, name);
		const want = join(source, name);
		const d = lstatOrUndefined(link);
		if (d?.isSymbolicLink() && readLink(link) === want) continue;
		ctx.result.changed.push(`linked ${name} -> ${want}`);
		if (ctx.dryRun) continue;
		if (d !== undefined) rmSync(link, { recursive: true, force: true });
		symlinkSync(want, link);
	}

	syncManagedSkills(source, target, input.init === true, ctx);
	if (input.init === true) initMemory(source, target, ctx);
	return ctx.result;
}

/**
 * `ompbot omp sync`: the profile of `config.ompProfile` from the owner's agent dir. Prints every change and ends with
 * `omp_profile_sync changed=<n>`; records the time in `<home>/omp/last-sync`. Throws when there is no profile to sync.
 */
export function runProfileSync(input: {
	homeDir: string;
	profile: string | undefined;
	env: Record<string, string | undefined>;
	init?: boolean;
	out: (line: string) => void;
	now: () => number;
}): number {
	if (input.profile === undefined) throw new Error("config ompProfile is not set: there is no bot profile to sync");
	const source = sourceAgentDir(input.env);
	const target = profileAgentDir(userHomeOf(input.env), input.profile);
	const result = syncProfile({
		source,
		target,
		userHome: userHomeOf(input.env),
		...(input.init === true ? { init: true } : {}),
	});
	for (const warning of result.warnings) input.out(`warn ${warning}`);
	for (const line of result.changed) input.out(line);
	const root = ompRoot(input.homeDir);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	writeFileSync(join(root, "last-sync"), `${new Date(input.now()).toISOString()} changed=${result.changed.length}\n`, {
		mode: 0o600,
	});
	input.out(`omp_profile_sync changed=${result.changed.length}`);
	return result.changed.length;
}

// ---------------------------------------------------------------- real trial and command

/** Trial ②: one turn through `RpcOmpDriver` (the daemon's driver, same env), `OK` expected within the deadline. */
export async function realRpcTrial(
	input: { cliPath: string; cwd: string; profile?: string; model?: string },
	bun: string,
	env: Record<string, string | undefined>,
	timeoutMs = TRIAL_TIMEOUT_MS,
): Promise<TrialResult> {
	const driver = new RpcOmpDriver({
		ompExecutable: input.cliPath,
		cwd: input.cwd,
		sessionDir: join(input.cwd, "session"),
		...splitModel(input.model),
		...botRpcEnv(input.profile, env),
		...(input.profile === undefined ? { baseEnv: env } : {}),
		bunExecutable: bun,
	});
	const final = Promise.withResolvers<OmpFinal>();
	// An exit after the answer (the stop below) rejects nothing anyone still waits on.
	final.promise.catch(() => undefined);
	driver.onFinal((f) => final.resolve(f));
	driver.onExit((info) => final.reject(new Error(`omp exited code=${info.code}: ${info.stderr.slice(-2_000)}`)));
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error(`no answer within ${timeoutMs / 1000}s`)), timeoutMs);
	try {
		await Promise.race([driver.start(), deadline.promise]);
		await Promise.race([driver.prompt(TRIAL_PROMPT), deadline.promise]);
		const answer = await Promise.race([final.promise, deadline.promise]);
		if (answer.status !== "completed") return { ok: false, detail: `turn ${answer.status}: ${answer.error ?? ""}` };
		if (!answer.text.includes("OK")) return { ok: false, detail: `no OK in the answer: ${answer.text.slice(0, 500)}` };
	} catch (error) {
		return { ok: false, detail: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timer);
		await driver.stop().catch(() => undefined);
	}
	return { ok: true, detail: "ok" };
}

function realDeps(homeDir: string, env: Record<string, string | undefined>, out: (line: string) => void): OmpCliDeps {
	const config = existsSync(join(homeDir, "config.json")) ? loadConfig(homeDir, { checkTokens: false }) : undefined;
	const bun = Bun.which("bun", { PATH: env.PATH ?? "" }) ?? process.execPath;
	return {
		homeDir,
		...(config === undefined ? {} : { config }),
		env,
		bun,
		run: realProcessRunner,
		runtimeCheck: checkOmpRuntime,
		rpcTrial: (input) => realRpcTrial(input, bun, env),
		countModels: (cliPath, profile) => countOmpModels(cliPath, 30_000, profile, env),
		out,
		now: () => Date.now(),
	};
}

/** `ompbot omp <sub>`; resolves with the exit code. */
export async function ompCommand(
	args: string[],
	homeDir: string,
	env: Record<string, string | undefined> = process.env,
	deps: OmpCliDeps = realDeps(homeDir, env, (line) => process.stdout.write(`${line}\n`)),
): Promise<number> {
	const { positionals, values } = parseArgs({
		args,
		allowPositionals: true,
		options: { init: { type: "boolean" } },
		strict: true,
	});
	const [sub, version, ...extra] = positionals;
	const usage = (): number => {
		process.stderr.write(`usage:\n${OMP_USAGE}`);
		return 2;
	};
	if (extra.length > 0 || (values.init === true && sub !== "sync")) return usage();
	switch (sub) {
		case "install":
			return version === undefined ? usage() : await ompInstall(version, deps);
		case "use":
			return version === undefined ? usage() : await ompUse(version, deps);
		case "rollback":
			return version === undefined ? ompRollback(deps) : usage();
		case "prune":
			return version === undefined ? ompPrune(deps) : usage();
		case "status":
			return version === undefined ? await ompStatus(deps) : usage();
		case "sync":
			if (version !== undefined) return usage();
			runProfileSync({
				homeDir: deps.homeDir,
				profile: deps.config?.ompProfile,
				env: deps.env,
				init: values.init === true,
				out: deps.out,
				now: deps.now,
			});
			return 0;
		default:
			return usage();
	}
}
