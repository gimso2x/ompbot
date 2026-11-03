import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HANDOFF_SCAN_BYTES, scanHandoffBrief } from "../src/safety/handoff-risk";

const rulesOf = (brief: string, options?: { protectedBranches?: readonly string[] }) =>
	scanHandoffBrief(brief, options).findings.map((finding) => finding.rule);

describe("scanHandoffBrief: high_risk rules", () => {
	const POSITIVES: Record<string, string[]> = {
		git_reset_hard: ["git reset --hard origin/task/x", "먼저 `git reset --hard HEAD~2` 로 되돌려"],
		git_clean_force: ["git clean -f", "git clean -fd", "git clean -xdf", "git clean --force"],
		git_push_force: ["git push --force origin task/x", "git push --force-with-lease", "git push -f origin task/x"],
		git_push_protected: ["git push origin main", "git push origin HEAD:master", "git push origin refs/heads/main"],
		git_branch_force_delete: ["git branch -D task/old"],
		rm_rf_absolute: ["rm -rf /var/lib/x", "rm -fr ~/work", "rm -r -f $HOME/.cache", "sudo rm -Rf /"],
		sql_destructive: ["sqlite3 ompbot.db 'DROP TABLE tasks'", "drop database ompbot;", "TRUNCATE TABLE inbound"],
		service_control: [
			"systemctl --user restart ompbot",
			"systemctl stop nginx",
			"docker rm -f web",
			"podman restart db",
			"pm2 delete api",
		],
		disk_destructive: ["mkfs.ext4 /dev/sdb1", "dd if=/dev/zero of=/dev/sda bs=1M"],
		secret_path: ["cat ~/.ompbot/secrets/slack.json"],
	};

	for (const [rule, briefs] of Object.entries(POSITIVES)) {
		test(`${rule}: every positive is high_risk with that rule`, () => {
			for (const brief of briefs) {
				const scan = scanHandoffBrief(`작업 지시\n${brief}`);
				expect({ brief, verdict: scan.verdict }).toEqual({ brief, verdict: "high_risk" });
				expect(scan.findings).toContainEqual(
					expect.objectContaining({ rule, line: 2, severity: "high_risk", excerpt: brief }),
				);
			}
		});
	}

	test("excerpts collapse whitespace and stop at 160 characters", () => {
		const [finding] = scanHandoffBrief(`git   reset\t--hard ${"가".repeat(300)}`).findings;
		expect(finding?.excerpt).toBe(`git reset --hard ${"가".repeat(143)}`);
		expect(Array.from(finding?.excerpt ?? "")).toHaveLength(160);
	});
});

describe("scanHandoffBrief: forbidding lines", () => {
	test("a forbidden command is advisory, never high_risk", () => {
		for (const brief of [
			"머지·push·데몬 재시작(systemctl --user restart ompbot)은 하지 않는다",
			"never run git reset --hard",
			"git push --force 금지",
			"Do not touch ~/.ompbot/secrets",
			"- no git branch -D",
		]) {
			const scan = scanHandoffBrief(brief);
			expect({ brief, verdict: scan.verdict }).toEqual({ brief, verdict: "advisory" });
			expect(scan.findings.every((finding) => finding.severity === "advisory")).toBe(true);
		}
	});

	test("only the same line is downgraded", () => {
		const scan = scanHandoffBrief("push는 하지 않는다\ngit reset --hard HEAD");
		expect(scan.verdict).toBe("high_risk");
	});

	// doc/ is not exported to the public core, so this runs only in the development repository.
	const specPath = join(import.meta.dir, "..", "doc", "plans", "handoff-risk-scan.md");
	test.skipIf(!existsSync(specPath))("the handoff-risk-scan spec itself is not high_risk", () => {
		expect(scanHandoffBrief(readFileSync(specPath, "utf8")).verdict).not.toBe("high_risk");
	});
});

describe("scanHandoffBrief: negatives and advisory rules", () => {
	test("safe look-alikes raise no high_risk rule", () => {
		expect(rulesOf("git push origin task/T-20261104-01")).toEqual([]);
		expect(rulesOf("git push -u origin feature/main-fix")).toEqual([]);
		expect(rulesOf("git reset --soft HEAD~1")).toEqual([]);
		expect(rulesOf("rm -rf node_modules")).toEqual([]);
		expect(rulesOf("git branch -d task/x")).toEqual([]);
		expect(rulesOf("git clean -n")).toEqual([]);
		const korean = scanHandoffBrief(
			"로그 회전을 구현하고 테스트를 추가한다.\n바꾼 파일만 커밋하고 PROGRESS.md를 갱신한다.\n결과는 outcome.md에 적는다.",
		);
		expect(korean).toEqual({ verdict: "clear", findings: [], truncated: false });
	});

	test("package installs and the owner-approval marker are advisory", () => {
		for (const [brief, rule] of [
			["npm install left-pad", "package_install"],
			["bun add zod", "package_install"],
			["pip install requests", "package_install"],
			["sudo apt-get install jq", "package_install"],
			["OMP_OWNER_APPROVED=1 git status", "owner_gate_skip"],
		] as const) {
			expect(scanHandoffBrief(brief)).toMatchObject({
				verdict: "advisory",
				findings: [{ rule, severity: "advisory" }],
			});
		}
	});
});

describe("scanHandoffBrief: protected branches", () => {
	test("a given list replaces main and master", () => {
		const options = { protectedBranches: ["production"] };
		expect(rulesOf("git push origin production", options)).toEqual(["git_push_protected"]);
		expect(rulesOf("git push origin main", options)).not.toContain("git_push_protected");
	});
});

describe("scanHandoffBrief: size limit", () => {
	test("input over the limit is truncated and never clear", () => {
		const scan = scanHandoffBrief("가".repeat(HANDOFF_SCAN_BYTES)); // 3 bytes each
		expect(scan).toEqual({ verdict: "advisory", findings: [], truncated: true });
	});

	test("a command only past the limit is not reported", () => {
		const scan = scanHandoffBrief(`${"a".repeat(HANDOFF_SCAN_BYTES)}\ngit reset --hard HEAD`);
		expect(scan.truncated).toBe(true);
		expect(scan.findings.map((finding) => finding.rule)).not.toContain("git_reset_hard");
		expect(scanHandoffBrief(`git reset --hard HEAD\n${"a".repeat(HANDOFF_SCAN_BYTES)}`)).toMatchObject({
			verdict: "high_risk",
			truncated: true,
		});
	});

	test("input exactly at the limit is whole", () => {
		expect(scanHandoffBrief("a".repeat(HANDOFF_SCAN_BYTES)).truncated).toBe(false);
	});
});
