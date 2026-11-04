import type { ChannelPort } from "../channel/port";
import { parseThreadRef, TOP_LEVEL_TS } from "../core/normalize";
import type { BoardLinkResolver } from "../dispatch/board";
import {
	type HerdrRunnerOptions,
	herdrAgentExists,
	herdrPromptExisting,
	herdrRemoteStart,
	herdrStartAgent,
	type ProcessRunner,
} from "../dispatch/omp";
import { summarizeJudgement } from "./checker";
import {
	acceptanceItems,
	docsDirOf,
	type NewTaskSpec,
	renderContext,
	renderOutcome,
	renderProgress,
	renderSpec,
	type TaskDocsMeta,
} from "./docs";
import { evaluateTask } from "./evaluate";
import { resolveTaskHost, type TaskHostOps } from "./host";
import type { TaskLedger, TaskRow } from "./ledger";
import { formatAcceptedCard, postToThread, setStatusReaction, type TaskSlackLog } from "./notify";
import { buildTaskPrompt } from "./prompt";

type HostEntry = { ssh: string; workDir?: string; herdrBin?: string };

export interface TaskDispatchDeps {
	ledger: TaskLedger;
	originKey: string;
	/** The session's current conversation thread (`<channel>:<ts>`); the task thread. */
	threadRef(): string | undefined;
	/** The [TASK] root message text, from the inbound ledger. */
	rootText(threadRef: string): string | undefined;
	port: ChannelPort;
	now(): number;
	workspaceDir: string;
	dispatchHosts?: Record<string, HostEntry>;
	run?: ProcessRunner;
	/** Test seam: host ops override. */
	hostOps?: (host: string | null) => TaskHostOps;
	/** herdr board card link of a started agent (`config.herdrBoard`); absent → the card carries no link. */
	boardLink?: BoardLinkResolver;
	log: TaskSlackLog & { info(event: string, fields?: Record<string, unknown>): void };
}

function hostEntryOf(deps: TaskDispatchDeps, host: string | null): HostEntry | undefined {
	if (host === null) return undefined;
	const entry = deps.dispatchHosts?.[host];
	if (entry === undefined) {
		const known = Object.keys(deps.dispatchHosts ?? {}).join(", ") || "없음";
		throw new Error(`알 수 없는 호스트: ${host} (등록된 호스트: ${known})`);
	}
	return entry;
}

function opsFor(deps: TaskDispatchDeps, host: string | null): TaskHostOps {
	if (deps.hostOps !== undefined) return deps.hostOps(host);
	return resolveTaskHost(host, deps.dispatchHosts, deps.run === undefined ? {} : { run: deps.run });
}

function herdrOptionsFor(deps: TaskDispatchDeps, entry: HostEntry | undefined): HerdrRunnerOptions {
	return {
		cwd: deps.workspaceDir,
		...(deps.run === undefined ? {} : { run: deps.run }),
		...(entry?.herdrBin === undefined ? {} : { herdrBin: entry.herdrBin }),
		...(entry === undefined ? {} : { sshTarget: entry.ssh }),
	};
}

/** Starts the task's herdr agent in its worktree (local herdr, or the host's over ssh) with `prompt`. */
async function startAgent(
	deps: TaskDispatchDeps,
	row: TaskRow,
	prompt: string,
): Promise<{ ok: true; paneId: string } | { ok: false; error: string }> {
	const entry = hostEntryOf(deps, row.host);
	const options = herdrOptionsFor(deps, entry);
	const started =
		entry === undefined
			? await herdrStartAgent({ name: row.agent, task: prompt, cwd: row.worktree, options })
			: await herdrRemoteStart({ sshTarget: entry.ssh, name: row.agent, task: prompt, cwd: row.worktree, options });
	return started.ok ? { ok: true, paneId: started.paneId } : { ok: false, error: started.error };
}

/** The board card of a just-started agent; `undefined` when no board is configured. */
async function cardLink(deps: TaskDispatchDeps, row: TaskRow, paneId: string): Promise<string | undefined> {
	return deps.boardLink === undefined ? undefined : await deps.boardLink(row.host, paneId);
}

/** Permalink of the task thread root; the bare thread ref when the platform cannot resolve it. */
async function threadLink(port: ChannelPort, log: TaskSlackLog, threadRef: string): Promise<string> {
	const target = parseThreadRef(threadRef);
	if (target === undefined) return threadRef;
	try {
		const root = { platform: port.platform, conversationId: target.channel, messageId: target.threadTs };
		return (await port.permalink(root)) ?? threadRef;
	} catch (error) {
		log.warn("task_permalink_failed", { thread: threadRef, error: String(error) });
		return threadRef;
	}
}

/**
 * New task: ID → worktree → four documents → agent → card and ⏳. A failure before the agent runs undoes only what
 * this call created (the worktree and branch, the reserved registry row) and reports the error.
 */
export async function startTask(
	deps: TaskDispatchDeps,
	input: { spec: NewTaskSpec; task: string | undefined; host: string | null },
): Promise<string> {
	const { spec, host } = input;
	if (input.task === undefined || input.task === "") throw new Error("신규 taskSpec에는 task(지시문)가 필요합니다");
	const threadRef = deps.threadRef();
	const parsed = threadRef === undefined ? undefined : parseThreadRef(threadRef);
	if (threadRef === undefined || parsed === undefined || parsed.threadTs === TOP_LEVEL_TS) {
		throw new Error("taskSpec은 [TASK] 요청이 온 Slack 스레드 안에서만 쓸 수 있습니다(현재 스레드를 알 수 없음)");
	}
	hostEntryOf(deps, host); // unknown host fails before anything is reserved
	const ops = opsFor(deps, host);

	const row = deps.ledger.register({
		title: spec.title,
		risk: spec.risk,
		originKey: deps.originKey,
		threadRef,
		host,
		repo: spec.repo,
		acceptance: acceptanceItems(spec.acceptance),
	});
	const git = { repo: row.repo, worktree: row.worktree, branch: row.branch };
	let worktreeCreated = false;
	let paneId = "";
	const fail = async (error: string): Promise<string> => {
		if (worktreeCreated) await ops.removeWorktree(git).catch(() => undefined);
		deps.ledger.discard(row.taskId);
		deps.log.warn("task_start_failed", { task: row.taskId, error });
		return `시작 실패: ${error} (${row.taskId} 등록을 되돌렸습니다)`;
	};

	try {
		const exists = await ops.pathExists(row.worktree);
		if (!exists.ok) return await fail(exists.error);
		if (exists.value) return await fail(`워크트리 경로가 이미 있습니다: ${row.worktree}`);
		const created = await ops.createWorktree(git);
		if (!created.ok) return await fail(created.error);
		worktreeCreated = true;

		const meta: TaskDocsMeta = {
			taskId: row.taskId,
			hostLabel: row.host ?? "local",
			repo: row.repo,
			worktree: row.worktree,
			branch: row.branch,
			agent: row.agent,
			threadLink: await threadLink(deps.port, deps.log, threadRef),
			registeredAt: row.createdAt,
		};
		const dir = docsDirOf(row.worktree, row.taskId);
		const docs: Array<[string, string]> = [
			["context.md", renderContext(meta, spec, deps.rootText(threadRef) ?? input.task)],
			["spec.md", renderSpec(meta, spec, row.acceptance)],
			["PROGRESS.md", renderProgress(row.taskId, row.createdAt)],
			["outcome.md", renderOutcome(row.taskId)],
		];
		for (const [name, content] of docs) {
			const written = await ops.writeFile(`${dir}/${name}`, content);
			if (!written.ok) return await fail(written.error);
		}
		// The documents are the task's evidence trail: they start as the branch's first commit, never as `?? docs/`.
		const committed = await ops.commitDocs({ worktree: row.worktree, taskId: row.taskId });
		if (!committed.ok) return await fail(committed.error);
		const prompt = buildTaskPrompt({
			mode: "new",
			taskId: row.taskId,
			worktree: row.worktree,
			branch: row.branch,
			instruction: input.task,
		});
		const started = await startAgent(deps, row, prompt);
		if (!started.ok) return await fail(started.error);
		paneId = started.paneId;
	} catch (error) {
		return await fail(error instanceof Error ? error.message : String(error));
	}

	deps.log.info("task_started", { task: row.taskId, host: row.host, agent: row.agent });
	const link = await cardLink(deps, row, paneId);
	const posted = await postToThread(deps.port, deps.log, threadRef, formatAcceptedCard(row, spec, link));
	await setStatusReaction(deps.port, deps.log, threadRef, "working", []);
	const where = `${row.host ?? "local"}:${row.worktree}`;
	return [
		`${row.taskId} 등록·시작했습니다 (워크트리 ${where}, branch ${row.branch}, 에이전트 ${row.agent}, 기준 문서 ${docsDirOf(row.worktree, row.taskId)}).`,
		...(link === undefined ? [] : [`진행 보기: ${link}`]),
		posted
			? "접수 카드(맡았습니다·진행 보기·[목표]·[가정])를 이 스레드에 이미 올렸습니다. 답에서 카드 내용을 되풀이하지 말고, 카드에 없는 것(오너가 지금 알아야 할 위험·확인 못 한 것)만 한두 줄로 씁니다."
			: "접수 카드를 스레드에 올리지 못했습니다. 답 첫 줄에 '`<호스트>`에서 `<에이전트>`(<제목>)가 맡았습니다', 다음 줄에 진행 보기 링크, 그 아래 [목표]·[가정] 두 줄을 직접 씁니다.",
		`진행 확인: ompbot_dispatch ${row.host === null ? '{mode:"herdr"' : `{host:"${row.host}"`}, name:"${row.agent}"}. 재개·오너 결정 전달: ompbot_dispatch {taskSpec:{id:"${row.taskId}"}, task:<오너 답 원문>}. 완료 처리는 오너만 합니다.`,
	].join("\n");
}

/** Resume: a live agent gets the PROGRESS-based prompt, a missing one is started again in the same worktree. */
export async function resumeTask(
	deps: TaskDispatchDeps,
	input: { id: string; task: string | undefined; host: string | null | undefined },
): Promise<string> {
	const row = deps.ledger.get(input.id);
	if (row === undefined) throw new Error(`등록된 작업이 아닙니다: ${input.id}`);
	if (row.status === "done" || row.status === "cancelled")
		throw new Error(`${row.taskId}는 이미 ${row.status}로 닫힌 작업입니다`);
	if (input.host !== undefined && input.host !== row.host) {
		throw new Error(`${row.taskId}는 ${row.host ?? "로컬"}에서 실행되는 작업입니다(host 불일치)`);
	}
	const entry = hostEntryOf(deps, row.host);
	const options = herdrOptionsFor(deps, entry);
	const prompt = buildTaskPrompt({
		mode: "resume",
		taskId: row.taskId,
		worktree: row.worktree,
		branch: row.branch,
		...(input.task === undefined || input.task === "" ? {} : { instruction: input.task }),
	});
	const alive = await herdrAgentExists(row.agent, options);
	if (!alive.ok) return `재개 실패: ${alive.error}`;
	let how: string;
	let link: string | undefined;
	if (alive.exists) {
		const sent = await herdrPromptExisting(row.agent, prompt, options);
		if (!sent.ok) return `재개 실패: ${sent.error ?? "unknown"}`;
		how = "살아 있는 에이전트에 재개 프롬프트를 보냈습니다";
	} else {
		const present = await opsFor(deps, row.host).pathExists(row.worktree);
		if (!present.ok) return `재개 실패: ${present.error}`;
		if (!present.value) return `재개 실패: 워크트리가 없습니다: ${row.worktree}`;
		const started = await startAgent(deps, row, prompt);
		if (!started.ok) return `재개 실패: ${started.error}`;
		how = "같은 워크트리에서 새 에이전트를 시작했습니다";
		link = await cardLink(deps, row, started.paneId);
	}
	if (row.status !== "working") {
		deps.ledger.transition(row.taskId, "working", "bot", "resume dispatch");
		await setStatusReaction(deps.port, deps.log, row.threadRef, "working");
	}
	// A resumed task gets a fresh staleness baseline: the agent has not had a chance to update PROGRESS.md yet.
	deps.ledger.setProgressAt(row.taskId, deps.now());
	deps.log.info("task_resumed", { task: row.taskId, alive: alive.exists });
	return `${row.taskId}: ${how} (${row.status} → working).${link === undefined ? "" : ` 진행 보기: ${link}.`} 진행 확인: ompbot_dispatch ${row.host === null ? '{mode:"herdr"' : `{host:"${row.host}"`}, name:"${row.agent}"}`;
}

/** The one-line judgement summary appended to an output read of an agent bound to a task; `undefined` when unbound. */
export async function taskSummaryLine(
	deps: TaskDispatchDeps,
	agent: string,
	host: string | null,
): Promise<string | undefined> {
	const row = deps.ledger.getByAgent(agent, host);
	if (row === undefined) return undefined;
	const evaluation = await evaluateTask(row, opsFor(deps, row.host));
	if (!evaluation.ok) return `▸ ${row.taskId} 판정 읽기 실패: ${evaluation.error}`;
	return `▸ ${row.taskId} ${summarizeJudgement(evaluation.judgement, row.status)}`;
}
