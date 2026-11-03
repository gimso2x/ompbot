import { join } from "node:path";
import { type FreezeState, frozenMessage } from "../ops/freeze";
import { redact } from "../redact";
import type { ApprovalDetail, ApprovalResult } from "../safety/approval";
import { scanHandoffBrief } from "../safety/handoff-risk";
import type { HostToolDef } from "../safety/host-tools";
import { buildFloorsPrompt } from "../safety/prompt";
import { resumeTask, startTask, type TaskDispatchDeps, taskSummaryLine } from "../tasks/dispatch";
import { parseTaskSpecInput } from "../tasks/docs";
import { auditContext } from "./audit";
import { type BoardLinkResolver, boardCardLink, type HerdrBoardConfig } from "./board";
import { herdrPromptExisting, herdrReadAgent, herdrRemoteStart, OWNER_NAME_PATTERN, runOmpPrint } from "./omp";

export interface DispatchToolDeps {
	originKey: string;
	ompExecutable: string;
	homeDir: string;
	workspaceDir: string;
	/** Remote dispatch targets (hub fleet pattern): herdr runs on that host over ssh. */
	dispatchHosts?: Record<string, { ssh: string; workDir?: string; herdrBin?: string }>;
	/** Test seam: process runner override. */
	run?: import("./omp").ProcessRunner;
	/** herdr-web-ui task board (`config.herdrBoard`): started agents get a card link; absent → no links. */
	herdrBoard?: HerdrBoardConfig;
	/** [TASK] state docs (`taskSpec`); absent → `taskSpec` is refused and dispatch is exactly the plain flow. */
	tasks?: Omit<TaskDispatchDeps, "originKey" | "workspaceDir" | "dispatchHosts" | "run" | "log" | "boardLink">;
	/** Freeze switch (`<home>/FROZEN`): while it returns a state every call is refused before any command runs. */
	frozen?: () => FreezeState | undefined;
	/** Config `herdr`: present → herdr/host/taskSpec dispatch; absent → the tool is simple-only (`omp -p`). */
	herdr?: { bin?: string };
	/** Owner approval card for a high_risk herdr brief; absent → such a brief is refused (`no_approver`). */
	approve?: (summary: string, detail: ApprovalDetail, signal?: AbortSignal) => Promise<ApprovalResult>;
	log: {
		info(event: string, fields?: Record<string, unknown>): void;
		warn(event: string, fields?: Record<string, unknown>): void;
	};
}

/** With herdr off the tool is simple-only: no herdr, host, name, cwd or taskSpec in what the model sees. */
const SIMPLE_ONLY_DESCRIPTION =
	"태스크를 실행 계층에 넘긴다. `omp -p`로 한 번 실행하고 최종 출력을 돌려준다(10분 상한). 판단 기준: 조사·분석·회고·체크처럼 한 번의 답으로 끝나는 일은 세션에서 직접 하거나 이 도구로 넘긴다.";
const SIMPLE_ONLY_PARAMETERS = {
	type: "object",
	properties: { task: { type: "string", description: "실행할 작업 지시(그 자체로 완결된 지시문)" } },
	required: ["task"],
	additionalProperties: false,
};
const HERDR_OFF_MESSAGE = "herdr가 꺼져 있어 simple만 쓸 수 있습니다";
/** A brief the handoff risk scan found nothing in (or a call with no brief): the result goes out unchanged. */
const CLEAR_GATE = { suffix: "", approved: false };

/** The `ompbot_dispatch` host tool for chat origins; `undefined` when the omp binary is not provided. */
export function buildDispatchTool(deps: DispatchToolDeps): HostToolDef {
	const herdrOn = deps.herdr !== undefined;
	const board = deps.herdrBoard;
	const boardLink: BoardLinkResolver | undefined =
		board === undefined
			? undefined
			: (host, paneId) =>
					boardCardLink(board, host, paneId, {
						onError: (error) => deps.log.warn("dispatch_board_link_failed", { host: host ?? "local", error }),
					});
	const tool: HostToolDef = {
		name: "ompbot_dispatch",
		label: "Dispatch work",
		description:
			'태스크를 실행 계층에 넘긴다. mode=simple(기본)은 단순 작업: `omp -p`로 한 번 실행하고 최종 출력을 돌려준다(10분 상한). mode=herdr는 복잡·장기 작업: herdr 워크스페이스에 omp 에이전트를 띄우고 프롬프트를 넘긴다 — 패널에서 계속 실행되므로 이후 ompbot_dispatch mode=herdr + name 으로 진행을 확인하거나 후속 지시를 보낸다. 판단 기준: 조사·분석·회고·체크처럼 한 번의 답으로 끝나는 일은 세션에서 직접 하거나 simple. 구현은 예상 30분 초과·다단계·새 모듈·스키마 변경 중 하나라도 걸리면 무조건 herdr(+taskSpec) — 세션에서 직접 구현하지 않는다(세션 안 하위 에이전트로 구현하는 것도 직접 구현이다). 직접 구현은 설정값 변경·1~2파일 수선, 세션 컨텍스트 없이는 판단할 수 없는 긴급 디버깅만. 추가 판단: 여러 단계이거나 하루를 넘길 작업이면 taskSpec을 채운다(대상 저장소에 워크트리·4문서(context/spec/PROGRESS/outcome)·상태 파일을 만들고 TASKID로 추적, 수락기준×증거로 ompbot이 Outcome 도달을 판정한다). 단발성 작업은 taskSpec을 비운다. 시작되면 ompbot이 스레드에 접수 카드(맡았습니다·진행 보기 링크·[목표]·[가정])를 올리므로 assumptions에 오너 말을 어떻게 해석했는지 한 줄로 적는다. 막힘·Outcome 알림에 오너가 결정을 답하면 그 원문을 taskSpec:{id}와 task로 넘겨 재개한다. taskSpec 신규는 {title,risk(L0~L4),goal,scope[],exclusions[],acceptance[](1개 이상),repo(대상 호스트의 git 저장소 절대경로),background?}와 task(지시문)를 함께 주고, 재개는 taskSpec:{id:"T-…"}만 준다. taskSpec에는 name을 주지 않는다. 완료 처리·merge는 오너만 한다.',
		parameters: {
			type: "object",
			properties: {
				task: {
					type: "string",
					description: "실행할 작업 지시(그 자체로 완결된 지시문). herdr + name 만 있으면 생략(현재 출력 조회)",
				},
				mode: { type: "string", enum: ["simple", "herdr"], description: "실행 방식(기본 simple)" },
				name: {
					type: "string",
					description:
						"herdr 에이전트 이름. 같은 이름에 task를 다시 보내면 후속 지시가 되고, task 없이 보내면 현재 출력을 돌려준다",
				},
				host: {
					type: "string",
					description:
						"원격 실행 대상(config dispatchHosts 키, 예: wsl). 지정하면 그 호스트의 herdr로 omp 에이전트를 띄운다",
				},
				cwd: { type: "string", description: "원격 작업 디렉터리(host 지정 시). 기본은 호스트 설정의 workDir" },
				taskSpec: {
					type: "object",
					description:
						"여러 단계·하루 넘는 작업의 [TASK] 상태 문서 등록. 신규: title·risk·goal·acceptance·repo 필수(+scope·exclusions·background). 재개: {id}만. host가 있으면 그 호스트에, 없으면 로컬에 워크트리를 만든다",
					properties: {
						id: { type: "string", description: "재개할 TASKID(T-YYYYMMDD-NN). 이것만 준다" },
						title: { type: "string" },
						risk: { type: "string", enum: ["L0", "L1", "L2", "L3", "L4"] },
						goal: { type: "string" },
						scope: { type: "array", items: { type: "string" } },
						exclusions: { type: "array", items: { type: "string" } },
						acceptance: {
							type: "array",
							items: { type: "string" },
							description: "수락기준 문구(등록 뒤 바꿀 수 없음)",
						},
						repo: { type: "string", description: "대상 호스트의 git 저장소 절대경로" },
						background: { type: "string" },
						assumptions: {
							type: "string",
							description: "오너 대신 정한 해석 한 줄(접수 카드의 [가정]). 없으면 생략",
						},
					},
					additionalProperties: false,
				},
			},
			additionalProperties: false,
		},
		async execute(params, context) {
			const frozen = deps.frozen?.();
			if (frozen !== undefined) {
				deps.log.warn("dispatch_refused_frozen", { origin: deps.originKey });
				throw new Error(frozenMessage(frozen));
			}
			return auditContext.run({ origin: deps.originKey }, () => executeDispatch(params, context.signal));
		},
	};
	return herdrOn ? tool : { ...tool, description: SIMPLE_ONLY_DESCRIPTION, parameters: SIMPLE_ONLY_PARAMETERS };

	/**
	 * Handoff risk scan of a brief about to go to a herdr worker. clear/advisory pass (advisory adds a result line);
	 * high_risk passes only on an `approved` owner card, anything else throws before a worker is touched.
	 */
	async function gateHandoff(text: string, signal: AbortSignal): Promise<{ suffix: string; approved: boolean }> {
		const scan = scanHandoffBrief(text);
		const origin = deps.originKey;
		if (scan.verdict === "clear") return CLEAR_GATE;
		if (scan.verdict === "advisory") {
			const rules = [
				...new Set(scan.findings.map((finding) => finding.rule)),
				...(scan.truncated ? ["truncated"] : []),
			];
			deps.log.info("dispatch_risk_advisory", { origin, rules });
			return { suffix: `\n위험 검사: advisory (${rules.join(", ")})`, approved: false };
		}
		const high = scan.findings.filter((finding) => finding.severity === "high_risk");
		const rest = scan.findings.filter((finding) => finding.severity !== "high_risk");
		const rules = [...new Set(high.map((finding) => finding.rule))];
		deps.log.warn("dispatch_risk_high", { origin, rules });
		const detail: ApprovalDetail = {
			action: [...high, ...rest]
				.slice(0, 5)
				.map((finding) => `L${finding.line} ${finding.rule}: ${redact(finding.excerpt)}`)
				.join("\n"),
			impact: "승인하면 이 지시문이 사람 없이 워커에서 실행됩니다",
		};
		const answer =
			deps.approve === undefined
				? "no_approver"
				: await deps.approve("herdr 위임 지시문에 고위험 명령이 있습니다", detail, signal);
		if (answer === "approved") {
			deps.log.info("dispatch_risk_approved", { origin, rules });
			return { suffix: `\n위험 검사: high_risk 승인됨 (${rules.join(", ")})`, approved: true };
		}
		const outcome = typeof answer === "object" ? "replied" : answer;
		deps.log.warn("dispatch_risk_refused", { origin, outcome });
		throw new Error(
			`위험 검사에서 막혔습니다(${outcome}): ${rules.join(", ")}. 지시문에서 해당 명령을 빼거나 금지 문장으로 바꾸고 다시 시도하세요`,
		);
	}

	async function executeDispatch(params: Record<string, unknown>, signal: AbortSignal): Promise<string> {
		const herdrArgs =
			params.mode === "herdr" || ["name", "host", "cwd", "taskSpec"].some((key) => params[key] !== undefined);
		if (!herdrOn && herdrArgs) throw new Error(HERDR_OFF_MESSAGE);
		const task = typeof params.task === "string" ? params.task.trim() : undefined;
		const host = typeof params.host === "string" && params.host.trim() !== "" ? params.host.trim() : undefined;
		const mode = params.mode === "herdr" ? "herdr" : "simple";
		const name = typeof params.name === "string" && params.name.trim() !== "" ? params.name.trim() : undefined;
		const hostEntry = host === undefined ? undefined : deps.dispatchHosts?.[host];
		const taskDeps: TaskDispatchDeps | undefined =
			deps.tasks === undefined
				? undefined
				: {
						...deps.tasks,
						originKey: deps.originKey,
						workspaceDir: deps.workspaceDir,
						...(deps.dispatchHosts === undefined ? {} : { dispatchHosts: deps.dispatchHosts }),
						...(deps.run === undefined ? {} : { run: deps.run }),
						...(boardLink === undefined ? {} : { boardLink }),
						log: deps.log,
					};
		if (params.taskSpec !== undefined) {
			if (taskDeps === undefined) throw new Error("이 세션에서는 taskSpec을 쓸 수 없습니다");
			if (name !== undefined)
				throw new Error("taskSpec에는 name을 줄 수 없습니다(에이전트 이름은 TASKID에서 만듭니다)");
			const input = parseTaskSpecInput(params.taskSpec);
			const briefed = task !== undefined && task !== "";
			if (input.kind === "resume") {
				const gate = briefed ? await gateHandoff(task, signal) : CLEAR_GATE;
				return redact(await resumeTask(taskDeps, { id: input.id, task, host })) + gate.suffix;
			}
			// Exclusions and acceptance are forbidding/checking sentences by design; they are not scanned.
			const { spec } = input;
			const brief = [
				task,
				spec.title,
				spec.goal,
				...spec.scope,
				...(spec.background === undefined ? [] : [spec.background]),
			];
			const gate = briefed ? await gateHandoff(brief.join("\n"), signal) : CLEAR_GATE;
			const raised = gate.approved && ["L0", "L1", "L2"].includes(spec.risk) ? { ...spec, risk: "L3" as const } : spec;
			return redact(await startTask(taskDeps, { spec: raised, task, host: host ?? null })) + gate.suffix;
		}
		const herdrOptions = {
			cwd: deps.workspaceDir,
			...(deps.run === undefined ? {} : { run: deps.run }),
			...(hostEntry?.herdrBin === undefined ? {} : { herdrBin: hostEntry.herdrBin }),
		};

		if (host !== undefined) {
			// Remote dispatch (hub fleet pattern): the named host runs its own herdr+omp. The host implies herdr.
			if (hostEntry === undefined) {
				const known = Object.keys(deps.dispatchHosts ?? {}).join(", ") || "없음";
				throw new Error(`알 수 없는 호스트: ${host} (등록된 호스트: ${known})`);
			}
			const sshOptions = { ...herdrOptions, sshTarget: hostEntry.ssh };
			if (name === undefined) throw new Error("원격 실행에는 name이 필요합니다");
			if (!OWNER_NAME_PATTERN.test(name)) throw new Error(`name은 소문자·숫자·-·_ 32자 이내여야 합니다: ${name}`);
			const cwd =
				typeof params.cwd === "string" && params.cwd.trim() !== "" ? params.cwd.trim() : (hostEntry.workDir ?? "~");
			if (task === undefined || task === "") {
				const read = await herdrReadAgent(name, sshOptions);
				if (!read.ok) return `읽기 실패: ${read.error ?? "unknown"}`;
				const summary = taskDeps === undefined ? undefined : await taskSummaryLine(taskDeps, name, host);
				return `▸ ${host}/${name} 최근 출력:\n${redact(read.output ?? "")}${summary === undefined ? "" : `\n${summary}`}`;
			}
			const gate = await gateHandoff(task, signal);
			const start = await herdrRemoteStart({ sshTarget: hostEntry.ssh, name, task, cwd, options: sshOptions });
			if (!start.ok) return `시작 실패: ${start.error}`;
			deps.log.info("dispatch_remote_started", { host, agent: name, cwd });
			const link = boardLink === undefined ? undefined : await boardLink(host, start.paneId);
			return (
				[
					`${host}에서 ${name} 에이전트를 시작했습니다 (cwd ${cwd}, pane ${start.paneId}).`,
					...(link === undefined ? [] : [`진행 보기: ${link}`]),
					`오너에게는 이 모양으로 접수를 알린다: 첫 줄 '\`${host}\`에서 \`${name}\`(<제목>)가 맡았습니다. 결정이 필요하거나 끝나면 이 스레드로 알려 드립니다.'${link === undefined ? "" : ", 다음 줄 '진행 보기: <위 링크>'"}, 빈 줄 뒤 '[목표] <한 문장>'과 '[가정] <오너 대신 정한 해석, 없으면 없음>'. 그 밖의 과정은 쓰지 않는다.`,
					`후속 지시·진행 확인은 ompbot_dispatch {host:"${host}", name:"${name}"} 로.`,
				].join("\n") + gate.suffix
			);
		}

		if (mode === "herdr") {
			if (name === undefined) throw new Error("herdr 모드에는 name이 필요합니다");
			if (task === undefined || task === "") {
				const read = await herdrReadAgent(name, herdrOptions);
				if (!read.ok) return `읽기 실패: ${read.error ?? "unknown"}`;
				const summary = taskDeps === undefined ? undefined : await taskSummaryLine(taskDeps, name, null);
				return `▸ ${name} 최근 출력:\n${redact(read.output ?? "")}${summary === undefined ? "" : `\n${summary}`}`;
			}
			const gate = await gateHandoff(task, signal);
			const follow = await herdrPromptExisting(name, task, herdrOptions);
			if (!follow.ok) return `전달 실패: ${follow.error ?? "unknown"}`;
			deps.log.info("dispatch_prompted", { agent: name });
			return `후속 지시를 ${name}에 전달했습니다. 진행 확인: ompbot_dispatch {mode:"herdr", name:"${name}"}${gate.suffix}`;
		}

		if (task === undefined || task === "") throw new Error("task is required");
		deps.log.info("dispatch_simple", { origin: deps.originKey });
		const result = await runOmpPrint({
			task,
			cwd: deps.workspaceDir,
			...(deps.run === undefined ? {} : { run: deps.run }),
			systemPromptAppendix: buildFloorsPrompt(join(deps.homeDir, "secrets"), deps.originKey, herdrOn),
			ompBin: deps.ompExecutable,
			inheritedEnv: process.env,
		});
		deps.log.info("dispatch_simple_done", { ok: result.ok });
		return redact(result.output);
	}
}
