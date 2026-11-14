// T-20261113-23 (doc/plans/dashboard-host-checks.md): the system view's "호스트 점검" card from config
// `dashboard.opsStatus`, its `!brief` line, and the module-level 60-second cache of the command.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OmpbotConfig } from "../src/config";
import { renderBriefingHtml } from "../src/dashboard/briefing";
import {
	clearHostChecksCache,
	HOST_CHECKS_TTL_MS,
	type HostChecksInfo,
	readHostChecks,
} from "../src/dashboard/host-checks";
import { renderDashboardMain, renderDashboardPage } from "../src/dashboard/html";
import {
	buildSnapshot,
	type DashboardConfig,
	type DashboardSnapshot,
	type Section,
	type SnapshotDeps,
} from "../src/dashboard/snapshot";
import { snapshotReader } from "../src/dashboard/snapshot-assembly";
import type { ProcessRunner, RunProcessOptions, RunProcessResult } from "../src/dispatch/omp";
import type { Gate } from "../src/ops/gates";

/** 2026-11-13 17:00 KST. */
const NOW = Date.parse("2026-11-13T08:00:00Z");
const COMMAND = ["ops-status", "--json"];
const SECRET = "secret-repo-a";
/** The second OCI host's name, put together at run time so the public core carries no host-name literal. */
const SECOND_OCI_HOST = ["oci", 2].join("");

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ompbot-hostchecks-"));
	clearHostChecksCache();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const check = (id: string, state: string, extra: Record<string, unknown> = {}) => ({
	id,
	label: `${id} 점검`,
	ok: state === "ok",
	detail: state === "ok" ? "정상" : `${id} 이상`,
	severity: "alert",
	state,
	requires_host: null,
	...extra,
});

/** Three hosts: one alert failure (oci), one skipped check (the second OCI host), the repository check as the notice failure (wsl). */
const threeHosts = () => ({
	generated: NOW / 1000 - 30,
	hosts: [
		{
			host: "oci",
			label: "OCI",
			ts: NOW / 1000 - 60,
			online: true,
			checks: [check("board-http", "ok"), check("dashboard-http", "ok"), check("timer-kiro", "fail")],
		},
		{
			host: SECOND_OCI_HOST,
			label: SECOND_OCI_HOST,
			ts: NOW / 1000 - 120,
			online: true,
			checks: [
				check("svc-hub", "ok"),
				check("ver-omp", "ok", { severity: "notice" }),
				check("chrome-cdp", "skipped", { severity: "notice", requires_host: "wsl", detail: "의존 호스트 미확인" }),
			],
		},
		{
			host: "wsl",
			label: "WSL",
			ts: NOW / 1000 - 90,
			online: true,
			checks: [
				check("kakao-container", "ok"),
				check("repo-risk", "fail", {
					severity: "notice",
					detail: `${SECRET}(원격 없음), other-repo(안 올린 커밋)`,
					data: {
						repos: [
							{
								name: SECRET,
								branch: `${SECRET}-main`,
								changes: [`?? ${SECRET}/notes.md`],
								remotes: ["origin"],
								local: 2,
								dirty: 3,
								stash: 1,
							},
							{ name: "other-repo", remotes: [], local: 0, dirty: 0, stash: 2 },
						],
						containers: [{ name: `${SECRET}-db` }],
						ports: [{ port: 5432, process: SECRET }],
					},
				}),
			],
		},
	],
});

interface FakeRun {
	run: ProcessRunner;
	calls: Array<{ cmd: string[]; opts: RunProcessOptions }>;
}

/** Answers the ops-status command with `result`; every other command (git, herdr) fails like a bare test home. */
function fakeRun(result: Partial<RunProcessResult> | (() => Partial<RunProcessResult>)): FakeRun {
	const calls: FakeRun["calls"] = [];
	const run: ProcessRunner = async (cmd, opts) => {
		if (cmd[0] !== COMMAND[0]) return { code: 1, stdout: "", timedOut: false };
		calls.push({ cmd, opts });
		return { code: 0, stdout: "", timedOut: false, ...(typeof result === "function" ? result() : result) };
	};
	return { run, calls };
}

const json = (value: unknown): Partial<RunProcessResult> => ({ stdout: JSON.stringify(value) });

const withOps = (url?: string): DashboardConfig => ({
	dashboard: { port: 7331, opsStatus: { command: COMMAND, ...(url === undefined ? {} : { url }) } },
});

function deps(overrides: Partial<SnapshotDeps> = {}): SnapshotDeps {
	return {
		homeDir: home,
		repoDir: "/srv/ompbot",
		timezone: "Asia/Seoul",
		config: undefined,
		now: () => NOW,
		callDaemon: async () => {
			throw new Error("no daemon");
		},
		run: fakeRun(json(threeHosts())).run,
		ompVersion: async () => "omp-stub 0.0.0",
		hostOps: () => {
			throw new Error("no hosts");
		},
		collectGates: () => [],
		...overrides,
	};
}

const system = (snapshot: DashboardSnapshot): string =>
	renderDashboardMain(snapshot, undefined, NOW, { view: "system" });

/** The `data-card="hosts"` section of the system view, or undefined. */
function hostsCard(html: string): string | undefined {
	return /<section class="sys-card[^"]*" data-card="hosts"[\s\S]*?<\/section>/.exec(html)?.[0];
}

/** The card's level word in its head (정상/주의/문제). */
function levelOf(card: string): string | undefined {
	return /<\/h3>(?:<a [^>]*>[^<]*<\/a>)?<span class="status-pill [^"]*">[\s\S]*?<span class="badge [^"]*">([^<]+)</.exec(
		card,
	)?.[1];
}

/** The 주의 section's lines of the briefing, in order. */
function attentionItems(html: string): string[] {
	const section = /<section><h2>주의<\/h2>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? "";
	return [...section.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((match) => match[1] ?? "");
}

describe("AC-1: without dashboard.opsStatus nothing is run or shown", () => {
	test("no hostChecks, no command run, no card, no briefing line", async () => {
		const fake = fakeRun(json(threeHosts()));
		for (const config of [undefined, { dashboard: { port: 7331 } }] as Array<DashboardConfig | undefined>) {
			const snapshot = await buildSnapshot(deps({ config, run: fake.run }));
			expect("hostChecks" in snapshot).toBe(false);
			expect(system(snapshot)).not.toContain('data-card="hosts"');
			expect(renderBriefingHtml(snapshot, NOW)).not.toContain("호스트 점검");
		}
		expect(fake.calls).toHaveLength(0);
	});
});

describe("AC-2: three hosts, counts only, no repository name anywhere", () => {
	test("per-host 정상 n/m and 건너뜀, the two failures as lines, skipped not a line, level bad", async () => {
		const fake = fakeRun(json(threeHosts()));
		const snapshot = await buildSnapshot(deps({ config: withOps("https://hub.example.test/"), run: fake.run }));
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0]?.cmd).toEqual(COMMAND);
		const card = hostsCard(system(snapshot)) ?? "";
		expect(card).not.toBe("");
		expect(card).toContain("<dt>OCI</dt><dd>정상 2/3 · 1분 전</dd>");
		expect(card).toContain(`<dt>${SECOND_OCI_HOST}</dt><dd>정상 2/3 · 2분 전 · 건너뜀 1</dd>`);
		expect(card).toContain("<dt>WSL</dt><dd>정상 1/2 · 1분 전</dd>");
		expect([...card.matchAll(/data-state="fail"/g)]).toHaveLength(2);
		expect(card).toContain('data-check="oci:timer-kiro"');
		expect(card).toContain('data-check="wsl:repo-risk"');
		expect(card).not.toContain("chrome-cdp");
		expect(card).toContain("안 올림 2 · 미커밋 1 · stash 3");
		expect(card).toContain('<a class="sys-link" href="https://hub.example.test/"');
		expect(levelOf(card)).toBe("문제");

		const briefing = renderBriefingHtml(snapshot, NOW);
		expect(attentionItems(briefing)).toEqual(["호스트 점검 이상 2건(alert 1)"]);
		for (const text of [JSON.stringify(snapshot), card, system(snapshot), briefing, renderDashboardPage(snapshot)]) {
			expect(text).not.toContain(SECRET);
		}
	});

	test("an ok repository check shows its counts on the host line instead", async () => {
		const report = threeHosts();
		const wsl = report.hosts[2]?.checks[1];
		if (wsl === undefined) throw new Error("fixture");
		Object.assign(wsl, { state: "ok", ok: true });
		const snapshot = await buildSnapshot(deps({ config: withOps(), run: fakeRun(json(report)).run }));
		const card = hostsCard(system(snapshot)) ?? "";
		expect(card).toContain("<dt>WSL</dt><dd>정상 2/2 · 1분 전 · 저장소 안 올림 2 · 미커밋 1 · stash 3</dd>");
		expect(card).not.toContain("<a ");
		expect(JSON.stringify(snapshot)).not.toContain(SECRET);
	});

	test("the page script draws the same card (helpers shipped)", async () => {
		const snapshot = await buildSnapshot(deps({ config: withOps() }));
		const script = /<script>([\s\S]*)<\/script>/.exec(renderDashboardPage(snapshot))?.[1] ?? "";
		const client = new Function("document", "setInterval", `${script}\nreturn renderDashboardMain;`)(
			{ getElementById: () => ({}) },
			() => 0,
		) as typeof renderDashboardMain;
		expect(hostsCard(client(snapshot, undefined, NOW, { view: "system" }))).toBe(hostsCard(system(snapshot)));
	});
});

describe("AC-3: offline host and skipped-only", () => {
	test("online:false is 보고 끊김 with its stale checks bundled into one line; level warn", async () => {
		const report = {
			generated: NOW / 1000,
			hosts: [
				{ host: "oci", label: "OCI", ts: NOW / 1000 - 60, online: true, checks: [check("board-http", "ok")] },
				{
					host: "wsl",
					label: "WSL",
					ts: NOW / 1000 - 3 * 3600,
					online: false,
					checks: [check("a", "stale"), check("b", "stale", { severity: "notice" }), check("c", "stale")],
				},
			],
		};
		const snapshot = await buildSnapshot(deps({ config: withOps(), run: fakeRun(json(report)).run }));
		const card = hostsCard(system(snapshot)) ?? "";
		expect(card).toContain("보고 끊김 · 3시간 0분 전");
		expect([...card.matchAll(/data-state="stale"/g)]).toHaveLength(1);
		expect(card).toContain("점검 3개 판정 보류");
		expect(card).not.toContain("a 점검");
		expect(levelOf(card)).toBe("주의");
		expect(attentionItems(renderBriefingHtml(snapshot, NOW))).toEqual(["호스트 점검 이상 1건(alert 0)"]);
	});

	test("skipped checks next to ok ones are ok, with no briefing line", async () => {
		const report = {
			generated: NOW / 1000,
			hosts: [
				{
					host: SECOND_OCI_HOST,
					label: SECOND_OCI_HOST,
					ts: NOW / 1000 - 60,
					online: true,
					checks: [check("svc-hub", "ok"), check("chrome-cdp", "skipped")],
				},
			],
		};
		const snapshot = await buildSnapshot(deps({ config: withOps(), run: fakeRun(json(report)).run }));
		const card = hostsCard(system(snapshot)) ?? "";
		expect(card).toContain("정상 1/2 · 1분 전 · 건너뜀 1");
		expect(card).not.toContain("gate-row");
		expect(levelOf(card)).toBe("정상");
		expect(attentionItems(renderBriefingHtml(snapshot, NOW))).toEqual([]);
	});

	test("a non-alert failure alone is 주의", async () => {
		const report = threeHosts();
		report.hosts.splice(0, 1);
		const snapshot = await buildSnapshot(deps({ config: withOps(), run: fakeRun(json(report)).run }));
		expect(levelOf(hostsCard(system(snapshot)) ?? "")).toBe("주의");
	});
});

describe("AC-4: an unreadable report", () => {
	const broken: Array<[string, Partial<RunProcessResult>, string]> = [
		[
			"non-zero exit",
			{ code: 2, stdout: "", stderr: `ssh: connect to host ${SECOND_OCI_HOST} port 22: timed out\n` },
			"종료 코드 2",
		],
		["timeout", { code: null, stdout: "", timedOut: true }, "5초 안에 끝나지 않음"],
		["empty output", { stdout: "  \n" }, "빈 출력"],
		["broken JSON", { stdout: '{"hosts": [' }, "JSON이 아닌 출력"],
		["hosts not an array", json({ hosts: {} }), "모양이 다름: hosts"],
		["a host field of the wrong type", json({ hosts: [{ host: "x", online: "yes", checks: [] }] }), "hosts[0].online"],
		[
			"an unknown check state",
			json({ hosts: [{ host: "x", online: true, checks: [check("a", "weird")] }] }),
			"hosts[0].checks[0].state",
		],
	];
	test.each(broken)(
		"%s: card bad with the reason, other cards unchanged, briefing's last 주의 line",
		async (_, result, reason) => {
			const gates: Gate[] = [{ name: "discord_disconnected", state: "open", detail: "x" }];
			const snapshot = await buildSnapshot(
				deps({ config: withOps(), run: fakeRun(result).run, collectGates: () => gates }),
			);
			expect(snapshot.hostChecks?.ok).toBe(false);
			const html = system(snapshot);
			const card = hostsCard(html) ?? "";
			expect(levelOf(card)).toBe("문제");
			expect(card).toContain("호스트 점검을 읽지 못했어요: ");
			expect(card).toContain(reason);
			const { hostChecks: _dropped, ...without } = snapshot;
			expect(html.replace(card, "")).toBe(system(without));
			const items = attentionItems(renderBriefingHtml(snapshot, NOW));
			expect(items[0]).toBe("게이트 discord_disconnected");
			expect(items.at(-1)?.startsWith("호스트 점검 읽지 못함:")).toBe(true);
		},
	);
});

describe("AC-5: one run per command per 60 seconds, module-wide", () => {
	test.each([
		["success", json(threeHosts())],
		["failure", { code: 1 }],
	] as Array<[string, Partial<RunProcessResult>]>)(
		"%s is cached for 60s and run again after 61s",
		async (_, result) => {
			let clock = NOW;
			const fake = fakeRun(result);
			const first = await readHostChecks(COMMAND, fake.run, () => clock);
			clock += HOST_CHECKS_TTL_MS - 1;
			expect(await readHostChecks(COMMAND, fake.run, () => clock)).toBe(first);
			expect(fake.calls).toHaveLength(1);
			clock = NOW + 61_000;
			await readHostChecks(COMMAND, fake.run, () => clock);
			expect(fake.calls).toHaveLength(2);
			expect(fake.calls[0]?.opts.stdoutCap).toBeGreaterThan(64_000);
			expect(fake.calls[0]?.opts.timeoutMs).toBe(5_000);
		},
	);

	test("a run still going is shared, and a different command is its own entry", async () => {
		const { promise: gate, resolve } = Promise.withResolvers<void>();
		const calls: string[][] = [];
		const run: ProcessRunner = async (cmd) => {
			calls.push(cmd);
			await gate;
			return { code: 0, stdout: JSON.stringify(threeHosts()), timedOut: false };
		};
		const a = readHostChecks(COMMAND, run, () => NOW);
		const b = readHostChecks(COMMAND, run, () => NOW);
		const c = readHostChecks(["ops-status"], run, () => NOW);
		resolve();
		expect(await a).toBe(await b);
		expect((await c).ok).toBe(true);
		expect(calls).toEqual([COMMAND, ["ops-status"]]);
	});

	test("two snapshotReader instances (one per !brief) run the command once", async () => {
		const fake = fakeRun(json(threeHosts()));
		const config = {
			...withOps(),
			ompExecutable: "/bin/true",
			timezone: "Asia/Seoul",
		} as unknown as OmpbotConfig;
		const options = {
			homeDir: home,
			config,
			now: () => NOW,
			run: fake.run,
			repoDir: "/srv/ompbot",
			callDaemon: async () => {
				throw new Error("no daemon");
			},
		};
		const one = await snapshotReader(options)();
		const two = await snapshotReader(options)();
		expect(one.hostChecks?.ok).toBe(true);
		expect(two.hostChecks).toEqual(one.hostChecks as Section<HostChecksInfo>);
		expect(fake.calls).toHaveLength(1);
	});
});

describe("AC-6: the briefing line goes last and moves nothing", () => {
	const gates = (n: number): Gate[] =>
		Array.from({ length: n }, (_, i) => ({ name: `gate_${i}`, state: "open" as const, detail: "x" }));

	test.each([2, 7])("with %i open gates the gate lines keep their order and text", async (n) => {
		const before = await buildSnapshot(deps({ collectGates: () => gates(n) }));
		const after = await buildSnapshot(deps({ config: withOps(), collectGates: () => gates(n) }));
		const was = attentionItems(renderBriefingHtml(before, NOW));
		const now = attentionItems(renderBriefingHtml(after, NOW));
		if (n <= 6) {
			expect(now).toEqual([...was, "호스트 점검 이상 2건(alert 1)"]);
		} else {
			// Under the 6-line cap the host line is the one folded into 외 N개; the shown lines are untouched.
			expect(now.slice(0, 6)).toEqual(was.slice(0, 6));
			expect(was.at(-1)).toBe(`외 ${n - 6}개`);
			expect(now.at(-1)).toBe(`외 ${n - 5}개`);
		}
	});
});
