import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../log";
import type { OmpFinal, OmpSessionDriver } from "../omp/driver";
import { redact } from "../redact";

export interface SkillCheck {
	/** A case where the skill should — or should not — fire, stated so a later session can replay it. */
	situation: string;
	/** What correct behaviour looks like when that situation comes up. */
	expect: string;
}

export interface SkillProposal {
	action: "create" | "patch";
	name: string;
	description: string;
	content: string;
	/** Adoption gate: what actually worked in this conversation (short quote or tight summary). */
	evidence: string;
	/** Adoption gate: paired fire / do-not-fire checks (MIN_CHECKS..MAX_CHECKS) recorded into the installed skill. */
	checks: SkillCheck[];
}

export interface SkillReviewDeps {
	/** A fresh child for the review origin; stopped by the runner. */
	makeDriver(origin: string, sessionDir: string): OmpSessionDriver;
	/** Recent owner/bot conversation digest (already truncated by the caller). */
	readDigest(): Promise<string>;
	/** Persists proposals under `<home>/skills-pending/` (mode 600) and returns their paths. */
	savePending(proposals: SkillProposal[]): string[];
	/** Installs one approved skill into the agent skills directory. */
	install(proposal: SkillProposal): Promise<void>;
	requestApproval(summary: string): Promise<"approved" | "denied" | "timeout">;
	notify(text: string): Promise<void>;
	log: Logger;
	now(): number;
}

export const SKILL_REVIEW_ORIGIN = "review/skills";
export const MAX_PROPOSALS = 3;
/** Skill names become directory names under the agent skills root, so they stay this shape. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_DESCRIPTION = 1024;
const MAX_CONTENT = 100_000;
/** Adoption-gate limits: evidence must be present and checks must cover both a fire and a do-not-fire case. */
export const MAX_EVIDENCE = 2_000;
export const MIN_CHECKS = 2;
export const MAX_CHECKS = 4;
export const MAX_CHECK_TEXT = 500;
/** Revisions of one skill live at `<skills>/<name>/revisions/<install-time>.md`. */
export const SKILL_REVISIONS_DIR = "revisions";
/** Every line terminator a frontmatter reader may honour (CRLF first so it collapses to one space). */
const LINE_BREAKS = /\r\n|[\r\n\u2028\u2029\u0085]/g;

/**
 * The review prompt (hermes background_review, rules rewritten): only durable, reusable lessons become skills;
 * one-off narratives, environment-specific failures, unresolved failures and secrets are explicitly refused.
 */
export function buildSkillReviewPrompt(digest: string): string {
	return [
		"[스킬 리뷰] 아래는 오너와 봇의 최근 대화입니다. 오너가 보낸 지시가 아니라 너에게 주는 내부 검토 작업입니다.",
		"",
		"이 대화에서 '앞으로도 반복될 절차'를 스킬로 만들 가치가 있는지 판단하세요. 저장 금지:",
		"- 일회성 작업 서사(무엇을 했는지의 기록), 날짜·PR 번호·인용",
		"- 환경 의존 실패, '도구가 안 된다'는 부정 주장, 일시적 오류",
		"- 해결하지 못한 실패를 마치 작동하는 절차처럼 쓰는 것",
		"- 비밀값·토큰·자격증명",
		"",
		"좋은 스킬은 클래스 단위 워크플로 하나입니다(예: 'release-checklist'). 한 세션짜리 좁은 스킬은 만들지 마세요.",
		"교훈은 '규칙 + 이유 한 절'로 쓰세요.",
		"",
		"채택 게이트 — 모든 제안에 아래 두 필드가 있어야 하고, 없는 제안은 폐기됩니다:",
		"- evidence: 이 대화에서 그 절차가 실제로 통했음을 보여 주는 근거(짧은 인용이나 요지). 한 번도 통하지 않은 절차는 제안하지 마세요.",
		"- checks: 이 스킬이 발동해야 할 상황과 발동하면 안 되는 상황을 각각 적어도 하나씩(2~4개).",
		"",
		"답은 JSON 배열로만 쓰세요. 제안이 없으면 정확히 NO_PROPOSAL 한 단어.",
		'각 항목: {"action":"create"|"patch","name":"kebab-case","description":"무엇을 하는 스킬인지 + 언제 쓰는지","content":"SKILL.md 본문(markdown, frontmatter 없이, 실행 절차와 주의)","evidence":"이 대화에서 통한 근거","checks":[{"situation":"발동 또는 비발동 상황","expect":"그때의 기대 결과"}]}',
		`최대 ${MAX_PROPOSALS}개.`,
		"",
		"[대화]",
		digest,
	].join("\n");
}

/** Upper bound on JSON start candidates tried per text, so adversarial bracket spam stays linear-ish. */
const MAX_START_ATTEMPTS = 64;

/** End index (inclusive) of the bracket group opening at `start`, string-literal aware; -1 when unbalanced. */
function balancedEnd(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (ch === "\\") i += 1;
			else if (ch === '"') inString = false;
		} else if (ch === '"') inString = true;
		else if (ch === "[" || ch === "{") depth += 1;
		else if (ch === "]" || ch === "}") {
			depth -= 1;
			if (depth === 0) return i;
			if (depth < 0) return -1;
		}
	}
	return -1;
}

/**
 * First JSON array of objects / object in `text` that parses. Each "[" or "{" is tried as a start (bounded), its
 * balanced end is parsed; prose brackets like "[결과]" or "[1]" simply fail or carry no objects and are skipped.
 */
function firstJsonList(text: string): unknown[] | undefined {
	let attempts = 0;
	for (let i = 0; i < text.length && attempts < MAX_START_ATTEMPTS; i++) {
		if (text[i] !== "[" && text[i] !== "{") continue;
		attempts += 1;
		const end = balancedEnd(text, i);
		if (end < 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text.slice(i, end + 1));
		} catch {
			continue;
		}
		if (!Array.isArray(parsed)) return typeof parsed === "object" && parsed !== null ? [parsed] : undefined;
		if (parsed.length === 0 || parsed.some((entry) => typeof entry === "object" && entry !== null)) return parsed;
	}
	return undefined;
}

function validProposals(list: unknown[]): SkillProposal[] {
	const proposals: SkillProposal[] = [];
	const seen = new Set<string>();
	for (const raw of list) {
		if (typeof raw !== "object" || raw === null) continue;
		const item = raw as Record<string, unknown>;
		// Missing action means create; anything other than create/patch (delete, remove, "PATCH", ...) is discarded.
		const action = item.action === undefined || item.action === "create" ? "create" : item.action;
		if (action !== "create" && action !== "patch") continue;
		const name = typeof item.name === "string" ? item.name.trim() : "";
		const description = typeof item.description === "string" ? item.description.trim() : "";
		const content = typeof item.content === "string" ? item.content.trim() : "";
		if (!NAME_PATTERN.test(name) || seen.has(name)) continue;
		if (description === "" || description.length > MAX_DESCRIPTION) continue;
		if (content === "" || content.length > MAX_CONTENT) continue;
		// Adoption gate: a proposal the conversation never actually vindicated, or whose fire/do-not-fire checks are
		// missing or malformed, never reaches an approval card (Regression Tax / SkillOpt adoption rule).
		const evidence = typeof item.evidence === "string" ? item.evidence.trim() : "";
		if (evidence === "" || evidence.length > MAX_EVIDENCE) continue;
		const rawChecks = Array.isArray(item.checks) ? item.checks : [];
		if (rawChecks.length < MIN_CHECKS || rawChecks.length > MAX_CHECKS) continue;
		const checks: SkillCheck[] = [];
		let checksOk = true;
		for (const rawCheck of rawChecks) {
			if (typeof rawCheck !== "object" || rawCheck === null) {
				checksOk = false;
				break;
			}
			const check = rawCheck as Record<string, unknown>;
			const situation = typeof check.situation === "string" ? check.situation.trim() : "";
			const expect = typeof check.expect === "string" ? check.expect.trim() : "";
			if (situation === "" || expect === "" || situation.length > MAX_CHECK_TEXT || expect.length > MAX_CHECK_TEXT) {
				checksOk = false;
				break;
			}
			checks.push({ situation, expect });
		}
		if (!checksOk) continue;
		// A proposal must not smuggle a known secret into the skills directory (name ends up in file names too).
		if (redact(name) !== name) continue;
		const gateText = `${description}\n${content}\n${evidence}\n${JSON.stringify(checks)}`;
		if (redact(gateText) !== gateText) continue;
		seen.add(name);
		proposals.push({ action, name, description, content, evidence, checks });
	}
	return proposals.slice(0, MAX_PROPOSALS);
}

/**
 * Pulls the proposals out of a model answer that may wrap the JSON in prose or fences: fenced blocks first, then the
 * whole text.
 */
export function extractProposals(answer: string): SkillProposal[] {
	const trimmed = answer.trim();
	if (trimmed === "" || /^NO_PROPOSAL\.?$/i.test(trimmed)) return [];
	for (const fence of trimmed.matchAll(/```[^\n`]*\n([\s\S]*?)```/g)) {
		const list = firstJsonList(fence[1] ?? "");
		const proposals = list === undefined ? [] : validProposals(list);
		if (proposals.length > 0) return proposals;
	}
	const list = firstJsonList(trimmed);
	return list === undefined ? [] : validProposals(list);
}

/** Words and shapes a plain YAML scalar would be read back as a non-string. */
const YAML_RESERVED = /^(?:null|true|false|yes|no|on|off|y|n|nan|inf|~)$/i;
/** Plain scalars that need no quoting: start with a letter, no `: `/` #`/indicator characters, no edge whitespace. */
const YAML_PLAIN_SAFE = /^[A-Za-z](?:[A-Za-z0-9 _.,()/-]*[A-Za-z0-9_.,()/-])?$/;

/** One-line YAML scalar: plain when that round-trips as the same string, otherwise a double-quoted (JSON) string. */
function yamlScalar(value: string): string {
	const oneLine = value.replace(LINE_BREAKS, " ");
	return YAML_PLAIN_SAFE.test(oneLine) && !YAML_RESERVED.test(oneLine) ? oneLine : JSON.stringify(oneLine);
}

/**
 * The adoption-check section appended to an installed SKILL.md: the paired fire/do-not-fire checks from the proposal
 * plus the model-portability rule. An empty string when the body already carries the heading (never duplicated).
 */
function renderAdoptionChecks(proposal: SkillProposal): string {
	if (proposal.content.includes("## 채택 검증")) return "";
	const lines = ["", "## 채택 검증", ""];
	lines.push(
		`설치 뒤 아래 짝을 실제 대화에서 한 번씩 돌려 확인한다. 어긋나면 \`ompbot skills rollback ${proposal.name}\`.`,
	);
	lines.push("");
	for (const check of proposal.checks) lines.push(`- ${check.situation} → ${check.expect}`);
	lines.push("- 이 스킬을 만든 모델과 다른 경로(예: GLM 크론 모니터)에서 쓸 때는 그 모델에서 다시 확인한 뒤 쓴다.");
	lines.push("");
	return lines.join("\n");
}

/** Renders the SKILL.md that gets installed (frontmatter + body); unsafe name/description are double-quoted. */
export function renderSkillFile(proposal: SkillProposal): string {
	const name = yamlScalar(proposal.name);
	const description = yamlScalar(proposal.description);
	return `---\nname: ${name}\ndescription: ${description}\n---\n\n${proposal.content}\n${renderAdoptionChecks(proposal)}`;
}

/**
 * One background review: a fresh omp child on its own origin reads the digest, proposes skills, and the proposals
 * land as pending files plus one owner approval. Only an explicit click installs anything.
 */
export async function runSkillReview(
	deps: SkillReviewDeps,
	options: { sessionDir: string; timeoutMs?: number; announceEmpty?: boolean } = { sessionDir: "" },
): Promise<{ proposals: number; installed: number }> {
	const driver = deps.makeDriver(SKILL_REVIEW_ORIGIN, options.sessionDir);
	const timeoutMs = options.timeoutMs ?? 5 * 60_000;
	let final: OmpFinal | undefined;
	try {
		await driver.start();
		const finished = Promise.withResolvers<OmpFinal>();
		const off = driver.onFinal((event) => finished.resolve(event));
		try {
			await driver.prompt(buildSkillReviewPrompt(await deps.readDigest()));
			const timer = Promise.withResolvers<undefined>();
			const handle = setTimeout(() => timer.resolve(undefined), timeoutMs);
			try {
				final = await Promise.race([finished.promise, timer.promise]);
			} finally {
				clearTimeout(handle);
			}
		} finally {
			off();
		}
	} catch (error) {
		deps.log.warn("skill_review_failed", { error: String(error) });
		return { proposals: 0, installed: 0 };
	} finally {
		await driver.stop().catch(() => undefined);
	}

	if (final === undefined || final.status !== "completed") {
		deps.log.info("skill_review_skipped", { status: final?.status ?? "timeout" });
		return { proposals: 0, installed: 0 };
	}
	const proposals = extractProposals(final.text);
	if (proposals.length === 0) {
		deps.log.info("skill_review_no_proposal");
		// An explicit `!distill` ends in silence otherwise: the owner waits for a card that never comes.
		if (options.announceEmpty === true)
			await deps.notify("📝 스킬 리뷰를 끝냈습니다. 이 대화에서 제안할 만한 절차가 없었어요(승인 카드 없음).");
		return { proposals: 0, installed: 0 };
	}

	const paths = deps.savePending(proposals);
	const lines = proposals.map((p) => {
		const evidence =
			p.evidence.length <= 120 ? p.evidence : `${p.evidence.slice(0, 119).replace(/[\ud800-\udbff]$/, "")}…`;
		return `- ${p.name} (${p.action === "patch" ? "patch · 기존 스킬 덮어씀" : p.action}): ${p.description}\n  근거: ${evidence} · 검증 ${p.checks.length}짝(설치 본문 '채택 검증' 절에 기록)`;
	});
	const verdict = await deps.requestApproval(
		`📝 스킬 제안 ${proposals.length}건 — 승인하면 ${proposals.map((p) => p.name).join(", ")}를 설치합니다.\n${lines.join("\n")}`,
	);
	if (verdict !== "approved") {
		await deps.notify(
			`📝 스킬 제안 ${proposals.length}건을 보류했습니다: ${paths[0] ?? ""} (승인하지 않아 설치 안 함)`,
		);
		return { proposals: proposals.length, installed: 0 };
	}
	const installed: string[] = [];
	for (const proposal of proposals) {
		try {
			await deps.install(proposal);
			installed.push(proposal.name);
		} catch (error) {
			deps.log.warn("skill_install_failed", { name: proposal.name, error: String(error) });
		}
	}
	const failed = proposals.length - installed.length;
	await deps.notify(
		`📝 스킬 ${installed.length}개 설치: ${installed.join(", ")} — 다음 세션부터 스킬 목록에 나타납니다.${
			failed === 0 ? "" : `\n${failed}개는 설치하지 못했습니다(ompbot.log skill_install_failed).`
		}\n나빠지면 \`ompbot skills rollback <이름>\`로 직전 개정으로 되돌릴 수 있습니다.`,
	);
	return { proposals: proposals.length, installed: installed.length };
}

/** One digest entry: a user/assistant session message trimmed to `perMessage` (undefined for any other line). */
function digestMessage(line: string, perMessage: number): { role: string; text: string } | undefined {
	if (line.trim() === "") return undefined;
	try {
		const entry = JSON.parse(line) as { message?: { role?: string; content?: unknown } };
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") return undefined;
		const content = entry.message?.content;
		let text = "";
		if (typeof content === "string") text = content;
		else if (Array.isArray(content)) {
			for (const part of content) {
				if (typeof part === "object" && part !== null && "text" in part) {
					const value = part.text;
					if (typeof value === "string") text += value;
				}
			}
		}
		text = text.trim();
		if (text === "") return undefined;
		// Cut by UTF-16 units but never leave half of a surrogate pair at the cut.
		let head = text.slice(0, perMessage);
		if (head.length < text.length && /[\ud800-\udbff]$/.test(head)) head = head.slice(0, -1);
		return head === "" ? undefined : { role, text: head };
	} catch {
		// A torn last line while the child is writing is fine: skip it.
		return undefined;
	}
}

/** Splits buffer bytes on `\n` (0x0a, which never occurs inside a multi-byte UTF-8 sequence). */
function splitLines(data: Buffer): Buffer[] {
	const pieces: Buffer[] = [];
	let from = 0;
	for (let at = data.indexOf(0x0a); at !== -1; at = data.indexOf(0x0a, from)) {
		pieces.push(data.subarray(from, at));
		from = at + 1;
	}
	pieces.push(data.subarray(from));
	return pieces;
}

/**
 * Digest of the last `limit` conversation messages from a session JSONL file ("" when unreadable). Reads the file
 * backwards one `chunkSize` chunk at a time (`chunkSize` is a test seam) and stops as soon as `limit` messages are
 * gathered, so the read+parse cost tracks the digest tail (KB) instead of the whole session file (MB).
 */
export async function readSessionDigest(
	sessionDir: string,
	limit = 24,
	perMessage = 800,
	totalCap = 12_000,
	chunkSize = 64 * 1024,
): Promise<string> {
	let files: Array<{ path: string; mtimeMs: number }>;
	try {
		files = await Promise.all(
			(await readdir(sessionDir))
				.filter((name) => name.endsWith(".jsonl"))
				.map(async (name) => {
					const path = join(sessionDir, name);
					return { path, mtimeMs: (await stat(path)).mtimeMs };
				}),
		);
		files.sort((a, b) => b.mtimeMs - a.mtimeMs);
	} catch {
		return "";
	}
	const newest = files[0]?.path;
	if (newest === undefined) return "";
	const lines: Array<{ role: string; text: string }> = [];
	const handle = await open(newest, "r");
	try {
		const size = (await handle.stat()).size;
		// Suffix bytes of the line crossing the window's left edge; the next, earlier chunk completes it. Kept as bytes
		// so a chunk boundary that cuts a multi-byte character still reassembles the line intact.
		let suffix: Buffer | null = null;
		let end = size;
		let done = false;
		while (!done) {
			const start = Math.max(0, end - chunkSize);
			const buf = Buffer.alloc(end - start);
			const { bytesRead } = await handle.read(buf, 0, buf.length, start);
			if (bytesRead === 0) break;
			const data = suffix === null ? buf.subarray(0, bytesRead) : Buffer.concat([buf.subarray(0, bytesRead), suffix]);
			const pieces = splitLines(data);
			// Short of the file start, the front piece is the partial line at the window's left edge: hold it as the next
			// suffix instead of parsing it. The remaining pieces are complete lines, newest last.
			suffix = start === 0 ? null : (pieces.shift() ?? null);
			for (let piece = pieces.pop(); piece !== undefined; piece = pieces.pop()) {
				const message = digestMessage(piece.toString("utf8"), perMessage);
				if (message !== undefined) lines.push(message);
				if (lines.length >= limit) {
					done = true;
					break;
				}
			}
			if (start === 0) done = true;
			end = start;
		}
	} finally {
		await handle.close();
	}
	const recent = lines.slice(0, limit).reverse();
	const digest = recent.map((line) => `${line.role === "user" ? "오너" : "봇"}: ${line.text}`).join("\n");
	if (totalCap <= 0) return "";
	const tail = digest.slice(-totalCap);
	return tail.length < digest.length && /^[\udc00-\udfff]/.test(tail) ? tail.slice(1) : tail;
}

/** Writes pending proposals as JSON files (mode 600) under `<home>/skills-pending/`. */
export function savePendingProposals(homeDir: string, proposals: SkillProposal[], now: number): string[] {
	const dir = join(homeDir, "skills-pending");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
	const paths: string[] = [];
	const used = new Set<string>();
	for (const proposal of proposals) {
		// Same-name proposals in one batch get an index suffix instead of overwriting each other.
		let path = join(dir, `${stamp}-${proposal.name}.json`);
		for (let index = 2; used.has(path); index += 1) path = join(dir, `${stamp}-${proposal.name}-${index}.json`);
		used.add(path);
		writeFileSync(path, `${JSON.stringify(proposal, null, 2)}\n`, { mode: 0o600 });
		paths.push(path);
	}
	return paths;
}

/** The agent skills directory ompbot installs into (`~/.omp/agent/skills`); `userHome` is a test seam. */
export function agentSkillsRoot(userHome: string = homedir()): string {
	return join(userHome, ".omp", "agent", "skills");
}

/** Directory of one installed skill (`<skills>/<name>/SKILL.md` and `revisions/` live here). */
export function skillDirOf(name: string, userHome: string = homedir()): string {
	return join(agentSkillsRoot(userHome), name);
}

/**
 * Copies the skill's current SKILL.md to `revisions/<timestamp>.md` so the next install overwrites a saved copy, not
 * the only one. Returns the revision path, or `undefined` when there is nothing to keep (first install).
 */
export function backupSkillRevision(dir: string, now: number): string | undefined {
	const current = join(dir, "SKILL.md");
	if (!existsSync(current)) return undefined;
	const revisions = join(dir, SKILL_REVISIONS_DIR);
	mkdirSync(revisions, { recursive: true, mode: 0o700 });
	const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
	let path = join(revisions, `${stamp}.md`);
	for (let n = 2; existsSync(path); n += 1) path = join(revisions, `${stamp}-${n}.md`);
	copyFileSync(current, path);
	chmodSync(path, 0o600);
	return path;
}

/**
 * Installs one approved proposal into `dir` (`<skills>/<name>`) exactly as the approval card named it: a `create`
 * never replaces an existing SKILL.md (an owner-written skill included) and a `patch` needs one to replace. The
 * previous SKILL.md becomes a revision first, so an approved patch stays reversible. Returns the saved revision
 * path (`undefined` on a first install); throws when the action does not match what is on disk.
 */
export function installSkill(dir: string, proposal: SkillProposal, now: number): string | undefined {
	const exists = existsSync(join(dir, "SKILL.md"));
	if (proposal.action === "create" && exists)
		throw new Error(`create refused: ${proposal.name} already has a SKILL.md (only a patch may replace it)`);
	if (proposal.action === "patch" && !exists) throw new Error(`patch refused: ${proposal.name} is not installed`);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const revision = backupSkillRevision(dir, now);
	writeFileSync(join(dir, "SKILL.md"), renderSkillFile(proposal), { mode: 0o600 });
	return revision;
}

/** Revision files of a skill, newest first (timestamp names sort chronologically); empty when there are none. */
export function listSkillRevisions(dir: string): string[] {
	try {
		return readdirSync(join(dir, SKILL_REVISIONS_DIR))
			.filter((name) => name.endsWith(".md"))
			.sort()
			.reverse()
			.map((name) => join(dir, SKILL_REVISIONS_DIR, name));
	} catch {
		return [];
	}
}

/**
 * Rolls the skill back to its newest revision (`ompbot skills rollback`). The swap keeps today's content in the
 * revision slot, so running it again restores it — an approved patch is always reversible in both directions.
 */
export function rollbackSkill(dir: string): string {
	const current = join(dir, "SKILL.md");
	if (!existsSync(current)) throw new Error(`skill not installed: ${dir}`);
	const newest = listSkillRevisions(dir)[0];
	if (newest === undefined) throw new Error(`no saved revision for ${dir}`);
	const outgoing = readFileSync(current);
	const previous = readFileSync(newest);
	writeFileSync(current, previous, { mode: 0o600 });
	writeFileSync(newest, outgoing, { mode: 0o600 });
	return newest;
}
