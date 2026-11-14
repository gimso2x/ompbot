// `!restart` (doc/plans/owner-restart-command.md): the daemon starts the same detached apply `ompbot apply --detach`
// starts, without a model turn, after refusing up front what would only end in a SKIP or a second apply. The apply
// reports back with `--report-plain` (IPC `notify`), so neither the request nor the report needs a working model.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { conversationKind, parseThreadRef, TOP_LEVEL_TS } from "../core/normalize";
import { parseChatOrigin, platformOfConversationId } from "../core/origin-key";
import { isLaneOrigin } from "../lanes/status";
import type { Logger } from "../log";
import {
	APPLY_LOCK_FILE,
	APPLY_UNIT_PREFIX,
	checkCheckout,
	detachedApplyCommand,
	findBun,
	isReportOrigin,
	parseApplyLock,
	type Runner,
	reportThreadPattern,
} from "../ops/apply";
import { backupStamp } from "../ops/backup";

/** Op ref prefix of an apply's `--report-plain` line (IPC `notify`): `notify:<stamp>`. */
export const NOTIFY_OP_PREFIX = "notify:";

/**
 * A `!restart` answer or a `notify` line: a side post in a thread whose turn may still run. Its delivery — live, or
 * resent from the outbox by the next process — keeps that thread's ⏳ status and 👀 going (`keepStatus`) and never
 * stamps a thread it did not open (`finishUntracked: false`).
 */
export const isSideOpRef = (opRef: string): boolean =>
	opRef.startsWith("restart:") || opRef.startsWith(NOTIFY_OP_PREFIX);

/** Where an apply started by `!restart` reports: `--report-origin` and, unless the command came at top level, its root. */
export interface ReportTarget {
	origin: string;
	thread?: string;
}

/**
 * The report target of a `!restart` row: its platform, conversation and thread root in the only shape apply takes
 * (`slack|discord/(dm|ch)/<id>` plus a root ts or message id). A thread origin (`…/t/<root>`) and a work lane's origin
 * resolve through the row's thread ref; anything else — or a ref that disagrees with the origin — has none.
 */
export function reportTargetOf(originKey: string, threadRef: string): ReportTarget | undefined {
	const thread = parseThreadRef(threadRef);
	if (thread === undefined) return undefined;
	let origin: string;
	const chat = parseChatOrigin(originKey);
	if (chat !== undefined) {
		if (chat.conversationId !== thread.channel) return undefined;
		origin = `${chat.platform}/${chat.kind}/${chat.conversationId}`;
	} else if (isLaneOrigin(originKey)) {
		const platform = platformOfConversationId(thread.channel);
		if (platform === undefined) return undefined;
		origin = `${platform}/${conversationKind(thread.channel)}/${thread.channel}`;
	} else return undefined;
	if (!isReportOrigin(origin)) return undefined;
	if (thread.threadTs === TOP_LEVEL_TS) return { origin };
	return reportThreadPattern(origin).test(thread.threadTs) ? { origin, thread: thread.threadTs } : undefined;
}

/**
 * How long this process's own launch counts as "in progress" by itself. Past it, the unit (active `ompbot-apply-*`)
 * and the apply lock are what show a restart still going — so an apply that ended without restarting (a late SKIP)
 * does not block the next `!restart` until a restart that never comes.
 */
export const RESTART_LAUNCH_GUARD_MS = 60_000;

export interface RestartLauncherDeps {
	homeDir: string;
	/** Checkout the daemon runs from: preflight reads it and the unit runs its `src/main.ts`. */
	repoDir: string;
	/** PATH for git, systemctl and the unit (`applyPathEnv`); bun is looked up on it. */
	pathEnv: string;
	/** Passed to the unit as `OMPBOT_HOME` when the daemon itself runs under one (as `apply --detach` does). */
	homeEnv?: string;
	run: Runner;
	isAlive: (pid: number) => boolean;
	isExecutable: (path: string) => boolean;
	now: () => number;
	/** Whether a turn runs anywhere now: the answer then says the drain waits for it, and how not to wait. */
	turnsRunning: () => boolean;
	log: Logger;
}

const refused = (reason: string): string => `⚠️ 재시작하지 않았습니다: ${reason}`;

const inProgress = (what: string): string => `이미 재시작이 진행 중입니다(${what})`;

/** Starts at most one detached apply for `!restart`; every refusal changes nothing. */
export class RestartLauncher {
	readonly #deps: RestartLauncherDeps;
	/** This process's launch (or the one being checked right now): its label and when it was taken. */
	#launch: { what: string; at: number } | undefined;

	constructor(deps: RestartLauncherDeps) {
		this.#deps = deps;
	}

	/** The answer line of one `!restart` from `originKey`, typed in `threadRef`. */
	async request(originKey: string, threadRef: string): Promise<string> {
		const { log } = this.#deps;
		const now = this.#deps.now();
		// Taken before the first await: two `!restart` in different conversations never both pass the checks.
		if (this.#launch !== undefined && now - this.#launch.at < RESTART_LAUNCH_GUARD_MS)
			return inProgress(this.#launch.what);
		this.#launch = { what: "접수 중", at: now };
		let launched = false;
		try {
			const answer = await this.#launchFor(originKey, threadRef);
			launched = answer.unit !== undefined;
			if (answer.unit !== undefined) this.#launch = { what: answer.unit, at: now };
			log.info(launched ? "restart_launched" : "restart_refused", {
				origin: originKey,
				...(answer.unit === undefined ? { reason: answer.text } : { unit: answer.unit }),
			});
			return answer.text;
		} finally {
			if (!launched) this.#launch = undefined;
		}
	}

	async #launchFor(originKey: string, threadRef: string): Promise<{ text: string; unit?: string }> {
		const { repoDir, pathEnv, run } = this.#deps;
		const env = { env: { PATH: pathEnv } };
		const holder = this.#lockHolder();
		if (holder !== undefined) return { text: inProgress(`apply-${holder}`) };
		const units = await run(
			[
				"systemctl",
				"--user",
				"list-units",
				"--plain",
				"--no-legend",
				"--state=active,activating",
				`${APPLY_UNIT_PREFIX}*`,
			],
			env,
		);
		if (units.code !== 0)
			return { text: refused(`systemctl --user list-units rc=${units.code}: ${units.stderr.trim()}`) };
		const active = units.stdout
			.split("\n")
			.map((line) => line.trim().split(/\s+/)[0] ?? "")
			.find((unit) => unit.startsWith(APPLY_UNIT_PREFIX));
		if (active !== undefined) return { text: inProgress(active.replace(/\.service$/, "")) };
		const target = reportTargetOf(originKey, threadRef);
		if (target === undefined)
			return {
				text: refused(
					`결과를 알릴 곳(${originKey} · ${threadRef})을 풀 수 없습니다. 서버에서 apply를 직접 돌려 주세요.`,
				),
			};
		const check = await checkCheckout((...args) => run(["git", "-C", repoDir, ...args], env), {});
		if (check.skipReasons.length > 0) {
			return {
				text: refused(
					`${check.skipReasons.join("; ")}. 체크아웃을 손으로 고친 뒤(main으로 돌리기·src 변경 커밋 등) 다시 \`!restart\`를 보내세요.`,
				),
			};
		}
		const bun = findBun(pathEnv, this.#deps.isExecutable);
		if (bun === undefined) return { text: refused(`bun을 PATH에서 찾지 못했습니다(${pathEnv})`) };
		const stamp = backupStamp(new Date(this.#deps.now()));
		const childArgs = ["apply", "--stamp", stamp, "--report-origin", target.origin];
		if (target.thread !== undefined) childArgs.push("--report-thread", target.thread);
		childArgs.push("--report-plain");
		const { unit, argv } = detachedApplyCommand({
			bun,
			repoDir,
			pathEnv,
			stamp,
			childArgs,
			...(this.#deps.homeEnv === undefined ? {} : { homeEnv: this.#deps.homeEnv }),
		});
		const started = await run(argv, env);
		if (started.code !== 0) {
			const reason = started.stderr.trim().split("\n")[0] ?? "";
			return { text: `⚠️ 재시작을 시작하지 못했습니다: systemd-run rc=${started.code} ${reason}`.trim() };
		}
		const turns = this.#deps.turnsRunning();
		const text = [
			`🔄 재시작을 접수했습니다(apply-${stamp}).`,
			...(turns ? ["돌고 있는 턴은 최대 5분 기다린 뒤 끊고 재시작 뒤 이어갑니다."] : []),
			"결과는 이 스레드에 알립니다.",
			...(turns ? ["기다리지 않으려면 먼저 `!stop`을 보내세요."] : []),
		].join(" ");
		return { text, unit };
	}

	/** Stamp of a live apply holding `<home>/apply.lock`; undefined without one (absent, unreadable or a dead holder). */
	#lockHolder(): string | undefined {
		let text: string;
		try {
			text = readFileSync(join(this.#deps.homeDir, APPLY_LOCK_FILE), "utf8");
		} catch (error) {
			// No lock: no apply of this home runs. Any other read failure is the command's failure notice.
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
			throw error;
		}
		const holder = parseApplyLock(text);
		return holder !== undefined && this.#deps.isAlive(holder.pid) ? holder.stamp : undefined;
	}
}
