import type { ProcessRunner } from "../dispatch/omp";
import { isRecord } from "../omp/type-guards";
import { redact } from "../redact";
import type { Section } from "./snapshot";

/**
 * The "호스트 점검" card's data: config `dashboard.opsStatus.command` prints the ops-status JSON
 * (`{generated, hosts:[{host,label,ts,online,checks:[{id,label,ok,detail,severity,state,requires_host,data?}]}]}`,
 * times in epoch seconds), read here at this boundary (outside-controlled JSON). Only counts and the abnormal checks
 * leave: a check's `data` never does, and a check carrying `data.repos` (repository names) has its `detail` replaced by
 * counts.
 */

/** One command run is reused this long, failed runs too: an ssh outage does not run it again every snapshot. */
export const HOST_CHECKS_TTL_MS = 60_000;
const HOST_CHECKS_TIMEOUT_MS = 5_000;
/** The repository snapshot in `data` grows past the runner's default 64KB cap. */
const HOST_CHECKS_STDOUT_CAP = 1_000_000;
const ERROR_CHARS = 200;

export type HostCheckState = "ok" | "fail" | "stale" | "skipped";

export interface HostCheckIssue {
	id: string;
	label: string;
	detail: string;
	/** `alert|notice|info` from ops-check; another word is kept as is and drawn like `info`. */
	severity: string;
	state: "fail" | "stale";
}

export interface RepoCounts {
	/** Repositories with local commits or no remote. */
	unpushed: number;
	/** Repositories with uncommitted changes. */
	dirty: number;
	/** Stash entries over every repository. */
	stash: number;
}

export interface HostCheckHost {
	host: string;
	label: string;
	/** Age of the host's last report at read time; null when the host never reported. */
	reportAgeMs: number | null;
	online: boolean;
	total: number;
	okCount: number;
	skipped: number;
	/** The `fail` and `stale` checks, in report order. */
	issues: HostCheckIssue[];
	repoCounts?: RepoCounts;
}

export interface HostChecksInfo {
	/** When the command's report was built (epoch ms); null when it carries no time. */
	generatedAt: number | null;
	hosts: HostCheckHost[];
}

const STATES: readonly string[] = ["ok", "fail", "stale", "skipped"];

const cache = new Map<string, { at: number; result: Promise<Section<HostChecksInfo>> }>();

/** Test only: forget every cached run. */
export function clearHostChecksCache(): void {
	cache.clear();
}

/**
 * The card's section. Cached per command at module level (a `snapshotReader` is made anew for every `!brief`): a run
 * younger than {@link HOST_CHECKS_TTL_MS}, finished or still running, is shared. Never rejects.
 */
export function readHostChecks(
	command: string[],
	run: ProcessRunner,
	now: () => number,
): Promise<Section<HostChecksInfo>> {
	const key = JSON.stringify(command);
	const started = now();
	const hit = cache.get(key);
	if (hit !== undefined && started - hit.at >= 0 && started - hit.at < HOST_CHECKS_TTL_MS) return hit.result;
	const result = runHostChecks(command, run, now).catch(
		(error: unknown): Section<HostChecksInfo> => fail(error instanceof Error ? error.message : String(error)),
	);
	cache.set(key, { at: started, result });
	return result;
}

async function runHostChecks(
	command: string[],
	run: ProcessRunner,
	now: () => number,
): Promise<Section<HostChecksInfo>> {
	const out = await run(command, { timeoutMs: HOST_CHECKS_TIMEOUT_MS, stdoutCap: HOST_CHECKS_STDOUT_CAP });
	if (out.timedOut) return fail(`${HOST_CHECKS_TIMEOUT_MS / 1000}초 안에 끝나지 않음`);
	if (out.code !== 0) {
		const reason = (out.stderr ?? "").trim().split("\n").at(-1) ?? "";
		return fail(`종료 코드 ${out.code}${reason === "" ? "" : `: ${reason}`}`);
	}
	if (out.stdout.trim() === "") return fail("빈 출력");
	let parsed: unknown;
	try {
		parsed = JSON.parse(out.stdout);
	} catch {
		return fail("JSON이 아닌 출력");
	}
	const info = parseReport(parsed, now());
	return typeof info === "string" ? fail(`모양이 다름: ${info}`) : { ok: true, ...info };
}

/** The report, or the path of the first field that does not match. */
function parseReport(value: unknown, now: number): HostChecksInfo | string {
	if (!isRecord(value)) return "최상위";
	if (!Array.isArray(value.hosts)) return "hosts";
	const hosts: HostCheckHost[] = [];
	for (const [h, raw] of value.hosts.entries()) {
		const where = `hosts[${h}]`;
		if (!isRecord(raw)) return where;
		if (typeof raw.host !== "string") return `${where}.host`;
		if (raw.label !== undefined && typeof raw.label !== "string") return `${where}.label`;
		if (raw.ts !== undefined && raw.ts !== null && typeof raw.ts !== "number") return `${where}.ts`;
		if (typeof raw.online !== "boolean") return `${where}.online`;
		if (!Array.isArray(raw.checks)) return `${where}.checks`;
		const host: HostCheckHost = {
			host: redact(raw.host),
			label: redact(typeof raw.label === "string" && raw.label !== "" ? raw.label : raw.host),
			reportAgeMs: typeof raw.ts === "number" ? Math.max(0, now - raw.ts * 1000) : null,
			online: raw.online,
			total: raw.checks.length,
			okCount: 0,
			skipped: 0,
			issues: [],
		};
		for (const [c, check] of raw.checks.entries()) {
			const at = `${where}.checks[${c}]`;
			if (!isRecord(check)) return at;
			if (typeof check.id !== "string") return `${at}.id`;
			if (typeof check.label !== "string") return `${at}.label`;
			if (typeof check.detail !== "string") return `${at}.detail`;
			if (typeof check.severity !== "string") return `${at}.severity`;
			if (typeof check.state !== "string" || !STATES.includes(check.state)) return `${at}.state`;
			const repos = isRecord(check.data) && "repos" in check.data ? check.data.repos : undefined;
			const counts = repos === undefined ? undefined : repoCounts(repos);
			if (counts !== undefined) host.repoCounts = counts;
			if (check.state === "ok") host.okCount += 1;
			else if (check.state === "skipped") host.skipped += 1;
			else {
				host.issues.push({
					id: redact(check.id),
					label: redact(check.label),
					// Repository names live in this check's detail: only the counts are shown.
					detail: counts === undefined ? redact(check.detail) : repoCountsText(counts),
					severity: redact(check.severity),
					state: check.state as HostCheckIssue["state"],
				});
			}
		}
		hosts.push(host);
	}
	const generated = value.generated;
	return { generatedAt: typeof generated === "number" ? Math.round(generated * 1000) : null, hosts };
}

/** Counts of `data.repos`; a malformed list counts nothing (the names are still dropped). */
function repoCounts(repos: unknown): RepoCounts {
	const counts: RepoCounts = { unpushed: 0, dirty: 0, stash: 0 };
	if (!Array.isArray(repos)) return counts;
	for (const repo of repos) {
		if (!isRecord(repo)) continue;
		const local = typeof repo.local === "number" ? repo.local : 0;
		const noRemote = Array.isArray(repo.remotes) && repo.remotes.length === 0;
		if (local > 0 || noRemote) counts.unpushed += 1;
		if (repo.dirty === true || (typeof repo.dirty === "number" && repo.dirty > 0)) counts.dirty += 1;
		if (typeof repo.stash === "number" && repo.stash > 0) counts.stash += repo.stash;
	}
	return counts;
}

/** The repository counts as one phrase; self-contained, it is also shipped in the page script. */
export function repoCountsText(counts: { unpushed: number; dirty: number; stash: number }): string {
	return `안 올림 ${counts.unpushed} · 미커밋 ${counts.dirty} · stash ${counts.stash}`;
}

/**
 * The card's level: bad for an unreadable report or an `alert` failure; warn for an offline host (a PC switched off
 * after hours is routine; ops-check itself alerts on a host that stays offline) and any other `fail` or `stale`; ok
 * otherwise (`skipped` alone is ok). Self-contained, it is also shipped in the page script.
 */
export function hostChecksLevel(
	section: { ok: true; hosts: HostCheckHost[] } | { ok: false; error: string },
): "ok" | "warn" | "bad" {
	if (!section.ok) return "bad";
	let level: "ok" | "warn" | "bad" = "ok";
	for (const host of section.hosts) {
		if (!host.online) level = "warn";
		for (const issue of host.issues) {
			if (issue.state === "fail" && issue.severity === "alert") return "bad";
			level = "warn";
		}
	}
	return level;
}

/**
 * The abnormal things the card shows, counted the way it draws them: an offline host is one (its `stale` checks are
 * one bundled line under it) plus its failures; an online host's every `fail`/`stale`. `alert`: the ones that make the
 * card bad (`alert` failures).
 */
export function hostChecksProblems(info: HostChecksInfo): { total: number; alert: number } {
	let total = 0;
	let alert = 0;
	for (const host of info.hosts) {
		const failures = host.issues.filter((issue) => issue.state === "fail");
		const alerts = failures.filter((issue) => issue.severity === "alert").length;
		if (host.online) total += host.issues.length;
		else total += 1 + failures.length;
		alert += alerts;
	}
	return { total, alert };
}

function fail(error: string): Section<HostChecksInfo> {
	return { ok: false, error: redact(error).replace(/\s+/g, " ").trim().slice(0, ERROR_CHARS) };
}
