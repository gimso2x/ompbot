/**
 * The four task documents (context / spec / PROGRESS / outcome): renderers for the files the bot writes and parsers
 * for the files the agent edits. Renderer and parser live together so the format has one definition.
 */

import { redact } from "../redact";
import { localIso } from "../time";
import { assertCheckPlacement, checkSignalsOf, parseChecks, type Signal, SignalSyntaxError } from "./signals";

export const TASK_RISKS = ["L0", "L1", "L2", "L3", "L4"] as const;
export type TaskRisk = (typeof TASK_RISKS)[number];

export const TASK_ID_PATTERN = /^T-\d{8}-\d{2,}$/;
/** Absolute, shell-inert path: it is interpolated into ssh command lines, so nothing else is accepted. */
export const TASK_PATH_PATTERN = /^\/[A-Za-z0-9_./-]+$/;
const MAX_ORIGINAL_CHARS = 8_000;

export class TaskSpecError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TaskSpecError";
	}
}

export interface AcceptanceItem {
	id: string;
	text: string;
}

/** What the session hands to `ompbot_dispatch taskSpec` for a new task. */
export interface NewTaskSpec {
	title: string;
	risk: TaskRisk;
	goal: string;
	scope: string[];
	exclusions: string[];
	acceptance: string[];
	repo: string;
	background?: string;
	/** The session's own reading of the owner's request (the hub brief's `[가정]`), shown on the accepted card. */
	assumptions?: string;
}

export type TaskSpecInput = { kind: "new"; spec: NewTaskSpec } | { kind: "resume"; id: string };

/** Collapses whitespace runs (including newlines) so a field is always one line of a document. */
export function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

function requireText(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || oneLine(value) === "")
		throw new TaskSpecError(`taskSpec.${key}는 비어 있지 않은 문자열이어야 합니다`);
	return oneLine(value);
}

function textList(
	record: Record<string, unknown>,
	key: string,
	min: number,
	normalize: (text: string) => string = oneLine,
): string[] {
	const value = record[key] ?? [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || oneLine(item) === "")) {
		throw new TaskSpecError(`taskSpec.${key}는 비어 있지 않은 문자열 배열이어야 합니다`);
	}
	const list = (value as string[]).map(normalize);
	if (list.length < min) throw new TaskSpecError(`taskSpec.${key}는 ${min}개 이상이어야 합니다`);
	return list;
}

/** Validates the raw tool argument: `{id}` alone resumes, anything else is a full new spec. */
export function parseTaskSpecInput(raw: unknown): TaskSpecInput {
	const record = asRecord(raw);
	if (record === undefined) throw new TaskSpecError("taskSpec은 객체여야 합니다");
	if (record.id !== undefined) {
		if (Object.keys(record).length !== 1) throw new TaskSpecError("재개는 taskSpec에 id만 줍니다");
		if (typeof record.id !== "string" || !TASK_ID_PATTERN.test(record.id)) {
			throw new TaskSpecError(`taskSpec.id 형식이 아닙니다(T-YYYYMMDD-NN): ${String(record.id)}`);
		}
		return { kind: "resume", id: record.id };
	}
	const risk = record.risk;
	if (typeof risk !== "string" || !(TASK_RISKS as readonly string[]).includes(risk)) {
		throw new TaskSpecError("taskSpec.risk는 L0~L4 중 하나여야 합니다");
	}
	const repo = requireText(record, "repo");
	if (!TASK_PATH_PATTERN.test(repo) || repo.includes("..")) {
		throw new TaskSpecError(`taskSpec.repo는 대상 호스트의 git 저장소 절대경로여야 합니다(영숫자·_ . / - 만): ${repo}`);
	}
	if (repo.replace(/\/+$/, "") === "") throw new TaskSpecError(`taskSpec.repo는 루트(/)일 수 없습니다: ${repo}`);
	const background = record.background;
	if (background !== undefined && typeof background !== "string")
		throw new TaskSpecError("taskSpec.background는 문자열이어야 합니다");
	const assumptions = record.assumptions;
	if (assumptions !== undefined && typeof assumptions !== "string")
		throw new TaskSpecError("taskSpec.assumptions는 문자열이어야 합니다");
	// Masked here once: the ledger row, the four documents, the accepted card and the logs all take these values.
	// Raw here: redactCriterion validates the check block as written, then collapses only the prose around it.
	const acceptance = textList(record, "acceptance", 1, (text) => text).map(redactCriterion);
	return {
		kind: "new",
		spec: {
			title: redact(requireText(record, "title")),
			risk: risk as TaskRisk,
			goal: redact(requireText(record, "goal")),
			scope: textList(record, "scope", 0).map(redact),
			exclusions: textList(record, "exclusions", 0).map(redact),
			acceptance,
			repo: repo.replace(/\/+$/, ""),
			...(background === undefined || oneLine(background) === "" ? {} : { background: redact(background.trim()) }),
			...(assumptions === undefined || oneLine(assumptions) === ""
				? {}
				: { assumptions: redact(oneLine(assumptions)) }),
		},
	};
}

/** Start of the trailing `[check: …]` that `checkSignalsOf` reads in `text`; `-1` without one. */
function checkBlockStart(text: string): number {
	if (checkSignalsOf(text).length === 0) return -1;
	// The block is the last `[check:` whose own suffix still ends in a block (a later one is a quoted argument).
	for (let open = text.lastIndexOf("[check:"); open !== -1; open = text.lastIndexOf("[check:", open - 1)) {
		try {
			if (checkSignalsOf(text.slice(open)).length > 0) return open;
		} catch {
			// an unterminated quoted `[check:` inside the block; keep looking further left
		}
		if (open === 0) break;
	}
	return -1;
}

/**
 * `oneLine` for an acceptance criterion: the prose before a trailing `[check: …]` collapses, the block stays byte for
 * byte (the sweep JSON-parses it into argv) except line breaks, which a valid block only holds between tokens.
 */
export function criterionLine(text: string): string {
	let start = -1;
	try {
		start = checkBlockStart(text);
	} catch (error) {
		// A malformed block is refused at registration and reported by the checker; here it is just text.
		if (!(error instanceof SignalSyntaxError)) throw error;
	}
	if (start === -1) return oneLine(text);
	const prose = oneLine(text.slice(0, start));
	const block = text
		.slice(start)
		.trim()
		.replace(/[\r\n]+/g, " ");
	return prose === "" ? block : `${prose} ${block}`;
}

/**
 * One acceptance criterion at registration: a malformed `[check: …]` is refused here, not discovered at judgement
 * time; the prose before the block is masked; the block itself is never changed (the sweep re-runs it as written), so
 * a block `redact` would change is refused — without echoing it.
 */
function redactCriterion(text: string, index: number): string {
	let signals: Signal[];
	try {
		assertCheckPlacement(text);
		signals = parseChecks(text);
	} catch (error) {
		if (!(error instanceof SignalSyntaxError)) throw error;
		throw new TaskSpecError(`taskSpec.acceptance[${index}]의 check 형식 오류: ${redact(error.message)}`);
	}
	const line = criterionLine(text);
	const start = checkBlockStart(line);
	if (start === -1) return redact(line);
	const block = line.slice(start);
	// The decoded values too: a JSON `\u` escape spells the token differently in the block than in the argv run.
	const decoded = signals.flatMap((signal) =>
		signal.kind === "command"
			? [...signal.argv, signal.stdout?.source ?? ""]
			: [
					signal.path,
					...(signal.json === undefined ? [] : [...signal.json.path.map(String), JSON.stringify(signal.json.value)]),
				],
	);
	if (redact(block) !== block || decoded.some((value) => redact(value) !== value)) {
		throw new TaskSpecError(
			`taskSpec 수락기준 AC-${index + 1}의 [check:] 명령에 비밀값으로 보이는 문자열이 있습니다 — 환경변수나 파일 경로로 넘기세요`,
		);
	}
	return redact(line.slice(0, start)) + block;
}

// ---- ids, paths ----

export const formatTaskId = (day: string, seq: number): string => `T-${day}-${String(seq).padStart(2, "0")}`;

/** herdr agent name of a task (`t-yyyymmdd-nn`; passes `OWNER_NAME_PATTERN`). */
export const agentNameOf = (taskId: string): string => taskId.toLowerCase();
export const branchOf = (taskId: string): string => `task/${taskId}`;
export const worktreePathOf = (repo: string, taskId: string): string => `${repo}-${taskId.toLowerCase()}`;
export const docsDirOf = (worktree: string, taskId: string): string => `${worktree}/docs/tasks/${taskId}`;

/** Epoch ms of an ISO timestamp, `undefined` when it does not parse. */
export function parseIsoMs(text: string): number | undefined {
	const ms = Date.parse(text);
	return Number.isNaN(ms) ? undefined : ms;
}

// ---- renderers ----

export interface TaskDocsMeta {
	taskId: string;
	/** `<host>:<repo>`; `local:<repo>` for the bot's own machine. */
	hostLabel: string;
	repo: string;
	worktree: string;
	branch: string;
	agent: string;
	threadLink: string;
	registeredAt: number;
	/** The bot's zone (`config.timezone`): the registration time is written with its offset. */
	timezone: string;
}

/** Drops a leading `AC-<n>:` the caller already wrote, so the generated id is not shown twice. */
export const stripAcPrefix = (text: string): string => text.replace(/^AC-\d+\s*[:.)]\s*/, "");

export const acceptanceItems = (texts: readonly string[]): AcceptanceItem[] =>
	texts.map((text, index) => ({ id: `AC-${index + 1}`, text: stripAcPrefix(criterionLine(text)) }));

export function renderContext(meta: TaskDocsMeta, spec: NewTaskSpec, original: string): string {
	return [
		`# ${meta.taskId} 컨텍스트`,
		"## 요청 원문",
		original.trim().slice(0, MAX_ORIGINAL_CHARS),
		"## 배경",
		spec.background ?? "(없음)",
		"## 가정",
		spec.assumptions ?? "(없음)",
		"## 메타",
		`- 요청 위치: ${meta.threadLink} · 등록: ${localIso(meta.registeredAt, meta.timezone)} · 위험등급: ${spec.risk}`,
		`- 레포: ${meta.hostLabel}:${meta.repo} · 워크트리: ${meta.worktree} (branch ${meta.branch}) · 에이전트: ${meta.agent}`,
		"",
	].join("\n");
}

const bullets = (items: readonly string[]): string[] =>
	items.length === 0 ? ["- (없음)"] : items.map((item) => `- ${item}`);

export function renderSpec(meta: TaskDocsMeta, spec: NewTaskSpec, acceptance: readonly AcceptanceItem[]): string {
	return [
		"---",
		`task: ${meta.taskId}`,
		`title: ${spec.title}`,
		`risk: ${spec.risk}`,
		`repo: ${meta.hostLabel}:${meta.repo}`,
		"---",
		"# 목표",
		spec.goal,
		"# 범위",
		...bullets(spec.scope),
		"# 제외",
		...bullets(spec.exclusions),
		"# 수락기준",
		...acceptance.map((item) => `- [ ] ${item.id}: ${item.text}`),
		"",
	].join("\n");
}

export function renderProgress(taskId: string, now: number, timezone: string): string {
	return [
		"---",
		`task: ${taskId}`,
		"status: working",
		`updated: ${localIso(now, timezone)}`,
		"current: S1",
		"next: spec.md를 읽고 이 파일의 단계 목록을 채운다",
		"restated:",
		"needs_owner:",
		"blocked_reason:",
		"question:",
		"recommend:",
		"impact:",
		"---",
		"# 단계",
		"- [ ] S1: spec.md를 읽고 단계 목록을 채운다 | 완료 조건: 이 목록이 실제 작업 단계로 바뀌어 있다 | 증거:",
		"",
		"# 결정",
		"",
	].join("\n");
}

/** Title, then an empty `## 요약` the agent fills with the 2~3 lines the owner reads on the Outcome card. */
export const renderOutcome = (taskId: string): string => `# ${taskId} Outcome 증거\n## 요약\n`;

// ---- parsers ----

interface Parsed {
	front: Map<string, string>;
	body: string[];
}

/** Splits `---` frontmatter (flat `key: value` lines) from the body lines; no frontmatter → empty map. */
function splitFrontmatter(text: string): Parsed {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const front = new Map<string, string>();
	if (lines[0]?.trim() !== "---") return { front, body: lines };
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (end === -1) return { front, body: lines };
	for (const line of lines.slice(1, end)) {
		const colon = line.indexOf(":");
		if (colon > 0) front.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
	}
	return { front, body: lines.slice(end + 1) };
}

/** Lines of the `# <heading>` section (up to the next top-level heading). */
function section(body: readonly string[], heading: string): string[] | undefined {
	const start = body.findIndex((line) => line.trim() === `# ${heading}`);
	if (start === -1) return undefined;
	const rest = body.slice(start + 1);
	const end = rest.findIndex((line) => /^# /.test(line));
	return end === -1 ? rest : rest.slice(0, end);
}

export interface SpecAcceptance extends AcceptanceItem {
	checked: boolean;
}

export interface ParsedSpec {
	task: string | undefined;
	acceptance: SpecAcceptance[];
	/** Lines of the acceptance section that are neither blank nor a well-formed AC line. */
	malformed: string[];
	hasAcceptanceSection: boolean;
}

const AC_LINE = /^- \[( |x|X)\] (AC-\d+): (.*)$/;

export function parseSpec(text: string): ParsedSpec {
	const { front, body } = splitFrontmatter(text);
	const lines = section(body, "수락기준");
	const acceptance: SpecAcceptance[] = [];
	const malformed: string[] = [];
	for (const raw of lines ?? []) {
		const line = raw.trim();
		if (line === "") continue;
		const match = AC_LINE.exec(line);
		if (match === null) malformed.push(line);
		else
			acceptance.push({ id: match[2] as string, text: criterionLine(match[3] as string), checked: match[1] !== " " });
	}
	return { task: front.get("task"), acceptance, malformed, hasAcceptanceSection: lines !== undefined };
}

export interface ProgressStep {
	id: string;
	done: boolean;
	text: string;
	condition: string;
	evidence: string;
}

export interface ParsedProgress {
	task: string | undefined;
	/** The raw `status:` value, lower-cased; `review`/`done` are kept as written (the checker ignores them). */
	status: string;
	updated: string;
	current: string;
	next: string;
	/** `과제 / 첫 next / 완료 조건` the agent writes first on a resume; `""` when absent (files from before the key). */
	restated: string;
	/** `needs_owner: yes|true` (any case): the block is the owner's to decide, so the sweep skips the retry prompt. */
	needsOwner: boolean;
	blockedReason: string;
	/** Decision request written with `status: blocked` (hub `[DECISION]`): the question, a recommendation, the impact. */
	question: string;
	recommend: string;
	impact: string;
	steps: ProgressStep[];
}

const STEP_LINE = /^- \[( |x|X)\] (S\d+): (.*)$/;

export function parseProgress(text: string): ParsedProgress {
	const { front, body } = splitFrontmatter(text);
	const steps: ProgressStep[] = [];
	for (const raw of section(body, "단계") ?? []) {
		const match = STEP_LINE.exec(raw.trim());
		if (match === null) continue;
		const [stepText = "", ...parts] = (match[3] as string).split(" | ");
		const field = (label: string): string => {
			const part = parts.find((candidate) => candidate.trimStart().startsWith(`${label}:`));
			return part === undefined ? "" : part.slice(part.indexOf(":") + 1).trim();
		};
		steps.push({
			id: match[2] as string,
			done: match[1] !== " ",
			text: stepText.trim(),
			condition: field("완료 조건"),
			evidence: field("증거"),
		});
	}
	// The worker's prose goes on to the ledger (notices, history) and the owner's cards: masked as it is read.
	const prose = (key: string): string => redact(front.get(key) ?? "");
	return {
		task: front.get("task"),
		status: (front.get("status") ?? "").toLowerCase(),
		updated: front.get("updated") ?? "",
		current: prose("current"),
		next: prose("next"),
		restated: prose("restated"),
		needsOwner: ["yes", "true"].includes((front.get("needs_owner") ?? "").trim().toLowerCase()),
		blockedReason: prose("blocked_reason"),
		question: prose("question"),
		recommend: prose("recommend"),
		impact: prose("impact"),
		steps,
	};
}

export interface AcEvidence {
	/** Commit hash tokens (`commit: <hash> <subject>`), exactly as written. */
	commits: string[];
	/** `test: <command> → <result>` lines. */
	tests: string[];
	files: string[];
}

export interface ParsedOutcome {
	sections: Map<string, AcEvidence>;
	/** Non-blank lines of `## 요약`, list markers (`- `, `* `, `• `) stripped; `[]` without that section. */
	summary: string[];
}

export function parseOutcome(text: string): ParsedOutcome {
	const sections = new Map<string, AcEvidence>();
	const summary: string[] = [];
	let current: AcEvidence | undefined;
	let inSummary = false;
	for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
		const line = raw.trim();
		const heading = /^## (AC-\d+)\s*$/.exec(line);
		if (heading !== null) {
			current = sections.get(heading[1] as string) ?? { commits: [], tests: [], files: [] };
			sections.set(heading[1] as string, current);
			inSummary = false;
			continue;
		}
		if (/^#{1,2} /.test(line)) {
			current = undefined;
			inSummary = /^## 요약\s*$/.test(line);
			continue;
		}
		if (inSummary) {
			const entry = line.replace(/^[-*•]\s+/, "");
			if (entry !== "") summary.push(redact(entry));
			continue;
		}
		const item = /^- (commit|test|file):\s*(.*)$/.exec(line);
		if (current === undefined || item === null) continue;
		const value = (item[2] as string).trim();
		if (item[1] === "commit") current.commits.push(value);
		else if (item[1] === "test") current.tests.push(value);
		else current.files.push(value);
	}
	return { sections, summary };
}
