import { describe, expect, test } from "bun:test";
import { applyRiskFloor, riskFloor } from "../src/tasks/risk-floor";

describe("riskFloor", () => {
	test("an L3 topic keyword sets L3 and is named", () => {
		expect(riskFloor(["결제 모듈 수정"])).toEqual({ floor: "L3", hits: ["결제"] });
		expect(riskFloor(["authenticate 흐름"]).floor).toBe("L3");
		expect(riskFloor(["OAuth callback"]).floor).toBe("L3");
		expect(riskFloor(["prod 배포 전 확인"]).floor).toBe("L3");
	});

	test("no keyword, an LLM token or a word containing one stays L0", () => {
		expect(riskFloor(["오타 수정"])).toEqual({ floor: "L0", hits: [] });
		expect(riskFloor(["컨텍스트 토큰 한도 조정"]).floor).toBe("L0");
		expect(riskFloor(["bug reproduction steps"]).floor).toBe("L0");
		expect(riskFloor(["author 표시 수정"]).floor).toBe("L0");
		expect(riskFloor(["authored by", "product list"]).floor).toBe("L0");
	});

	test("destructive topics set L4", () => {
		expect(riskFloor(["drop table users"]).floor).toBe("L4");
		expect(riskFloor(["force push to main"]).floor).toBe("L4");
		expect(riskFloor(["강제푸시 금지 해제"]).floor).toBe("L4");
		expect(riskFloor(["DROP TABLE", "결제"])).toEqual({ floor: "L4", hits: ["DROP TABLE", "결제"] });
	});
});

describe("applyRiskFloor", () => {
	test("raises with a note, never lowers", () => {
		expect(applyRiskFloor("L1", ["결제 수정", "마이그레이션 추가"])).toEqual({
			risk: "L3",
			note: "위험등급을 L1→L3으로 올렸습니다(키워드: 결제, 마이그레이션).",
		});
		expect(applyRiskFloor("L4", ["결제"])).toEqual({ risk: "L4" });
		expect(applyRiskFloor("L3", ["결제"])).toEqual({ risk: "L3" });
		expect(applyRiskFloor("L2", ["오타"])).toEqual({ risk: "L2" });
	});
});
