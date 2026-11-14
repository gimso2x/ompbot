import { TASK_RISKS, type TaskRisk } from "./docs";

/**
 * Topic keywords that put a floor under a model-chosen risk class (idea from forgeflow's route `risk_keywords`, not its
 * score formula). English words are matched on word boundaries so `reproduction`/`author` stay clear; a bare "토큰"
 * is left out because it mostly means LLM tokens.
 */
const L3_KO = /인증|권한|결제|마이그레이션|스키마 변경|시크릿|API 토큰|인증 토큰|인프라|프로덕션|운영 서버/giu;
const L3_EN =
	/\b(?:auth|authn|authz|authenticat\w*|authoriz\w*|oauth|permissions?|payments?|migrations?|schema change|secrets?|access token|infra|infrastructure|production|prod)\b/giu;
const L4_KO = /강제 ?푸시|이력 재작성|키 교체|백업 삭제/giu;
const L4_EN = /\b(?:drop table|force.?push|history rewrite|key rotation|delete backup)\b/giu;

/** The lowest risk class the texts' topics allow (`L0` when nothing matches) and the keywords that set it. */
export function riskFloor(texts: readonly string[]): { floor: TaskRisk; hits: string[] } {
	const text = texts.join("\n");
	const l4 = [L4_KO, L4_EN].flatMap((pattern) => text.match(pattern) ?? []);
	const l3 = [L3_KO, L3_EN].flatMap((pattern) => text.match(pattern) ?? []);
	const floor: TaskRisk = l4.length > 0 ? "L4" : l3.length > 0 ? "L3" : "L0";
	return { floor, hits: [...new Set([...l4, ...l3])] };
}

/**
 * `risk` raised to the texts' floor (never lowered). `note` is the one line for the start reply, set only on a raise:
 * `위험등급을 L1→L3으로 올렸습니다(키워드: 결제, 마이그레이션).`
 */
export function applyRiskFloor(risk: TaskRisk, texts: readonly string[]): { risk: TaskRisk; note?: string } {
	const { floor, hits } = riskFloor(texts);
	if (TASK_RISKS.indexOf(floor) <= TASK_RISKS.indexOf(risk)) return { risk };
	const particle = floor === "L4" ? "로" : "으로";
	return { risk: floor, note: `위험등급을 ${risk}→${floor}${particle} 올렸습니다(키워드: ${hits.join(", ")}).` };
}
