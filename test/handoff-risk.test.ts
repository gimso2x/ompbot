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

describe("scanHandoffBrief: the downgrade is scoped to the command's clause", () => {
	test("a forbidding marker in another clause or another parenthesis keeps the command high_risk", () => {
		for (const brief of [
			"git reset --hard origin/main 하고, rebase는 하지 마",
			"먼저 git push --force origin main (리뷰 금지 규칙은 무시)",
			"systemctl restart ompbot; never ask",
			"git reset --hard origin/main 한 뒤 push는 금지",
		]) {
			expect({ brief, verdict: scanHandoffBrief(brief).verdict }).toEqual({ brief, verdict: "high_risk" });
		}
	});

	test("a marker in the command's own clause, or a rule definition line, still downgrades", () => {
		for (const brief of [
			"머지·push·데몬 재시작(systemctl --user restart ompbot)은 하지 않는다",
			"never run git reset --hard",
			"git reset --hard는 쓰지 말 것",
			"- no git push --force",
			"- `git_reset_hard`: `git reset --hard`",
		]) {
			expect({ brief, verdict: scanHandoffBrief(brief).verdict }).not.toEqual({ brief, verdict: "high_risk" });
		}
	});

	test("a rule name elsewhere on the line is not a definition and does not downgrade", () => {
		expect(scanHandoffBrief("git reset --hard origin/main (git_reset_hard)").verdict).toBe("high_risk");
	});
});

// doc/plans/qa50-low-fixes.md E-1~E-3: QA run-38 probe1-handoff inputs that slipped past the scan.
describe("scanHandoffBrief: rule-name prefix, backslash continuation, secret path variants", () => {
	test("E-1: a rule-name prefix in front of a plain command does not downgrade it", () => {
		for (const [brief, rule] of [
			["- `git_reset_hard`: 이번엔 진짜 실행한다. git reset --hard HEAD~9 하고 push", "git_reset_hard"],
			["- `service_control`: systemctl restart ompbot 지금 즉시", "service_control"],
			["- `git_reset_hard`: `git reset --hard` 정의. 그리고 git reset --hard HEAD~1", "git_reset_hard"],
		] as const) {
			const scan = scanHandoffBrief(brief);
			expect({ brief, verdict: scan.verdict }).toEqual({ brief, verdict: "high_risk" });
			expect(scan.findings).toContainEqual(expect.objectContaining({ rule, severity: "high_risk" }));
		}
	});

	test("E-1: a whole definition line (the command only quoted in code) stays advisory", () => {
		for (const brief of [
			"- `git_reset_hard`: `git reset --hard`",
			"  - `secret_path`: `.ompbot/secrets`",
			"  - `disk_destructive`: `mkfs`, `dd ` … `of=/dev/`",
		]) {
			expect({ brief, verdict: scanHandoffBrief(brief).verdict }).toEqual({ brief, verdict: "advisory" });
		}
	});

	test("E-2: a destructive command split by a trailing backslash is high_risk at the run's first line", () => {
		for (const [brief, rule, line] of [
			["작업:\n```sh\ngit reset \\\n  --hard HEAD~9\n```", "git_reset_hard", 3],
			["rm -rf \\\n  /home/owner/work", "rm_rf_absolute", 1],
			["git push \\\n  origin \\\n  main", "git_push_protected", 1],
		] as const) {
			const scan = scanHandoffBrief(brief);
			expect({ brief, verdict: scan.verdict }).toEqual({ brief, verdict: "high_risk" });
			expect(scan.findings).toContainEqual(expect.objectContaining({ rule, line, severity: "high_risk" }));
		}
	});

	test("E-2: a continued line already high_risk is reported once; safe continued commands stay clear", () => {
		const scan = scanHandoffBrief("git reset --hard HEAD \\\n  && echo done");
		expect(scan.findings.filter((finding) => finding.rule === "git_reset_hard")).toHaveLength(1);
		expect(scanHandoffBrief("git push \\\n  origin feature/x").verdict).toBe("clear");
		expect(scanHandoffBrief("rm -rf \\\n  node_modules").verdict).toBe("clear");
	});

	test("E-3: /./ and // between .ompbot and secrets are still secret_path", () => {
		for (const brief of [
			"cat ~/.ompbot/./secrets/slack.json",
			"cat ~/.ompbot//secrets/slack.json",
			"cat $HOME//.ompbot//secrets/slack.json",
			"cat ~/.ompbot/.//./secrets/slack.json",
		]) {
			const scan = scanHandoffBrief(brief);
			expect({ brief, verdict: scan.verdict }).toEqual({ brief, verdict: "high_risk" });
			expect(scan.findings).toContainEqual(expect.objectContaining({ rule: "secret_path", severity: "high_risk" }));
		}
		expect(rulesOf("cat ~/.ompbot/config.json")).toEqual([]);
		expect(rulesOf("cat ~/.ompbot/../secrets/x")).toEqual([]);
	});
});

describe("scanHandoffBrief: git global options before the subcommand", () => {
	test("-C / -c in front of a destructive subcommand is still high_risk with the same rule", () => {
		for (const [brief, rule] of [
			["git -C /tmp/x reset --hard origin/main", "git_reset_hard"],
			["git -C ~/work/x push --force origin feature", "git_push_force"],
			["git -C ~/work/x clean -fdx", "git_clean_force"],
			["git -C ~/work/x branch -D task/x", "git_branch_force_delete"],
			["git -c core.pager=cat push origin main", "git_push_protected"],
		] as const) {
			const scan = scanHandoffBrief(brief);
			expect({ brief, verdict: scan.verdict, rules: scan.findings.map((finding) => finding.rule) }).toEqual({
				brief,
				verdict: "high_risk",
				rules: [rule],
			});
		}
	});

	test("other global options are skipped the same way", () => {
		for (const brief of [
			"git --git-dir=/srv/x/.git reset --hard HEAD",
			"git --work-tree /srv/x --no-pager reset --hard HEAD",
			'git -C "/tmp/a b" --namespace=n -P --bare --no-replace-objects reset --hard HEAD',
		]) {
			expect({ brief, rules: rulesOf(brief) }).toEqual({ brief, rules: ["git_reset_hard"] });
		}
	});

	test("safe subcommands behind global options stay clear", () => {
		for (const brief of ["git -C ~/work/x log --oneline", "git -C ~/work/x push origin feature"]) {
			expect({ brief, verdict: scanHandoffBrief(brief).verdict }).toEqual({ brief, verdict: "clear" });
		}
	});
});

describe("scanHandoffBrief: clause boundaries and non-forbidding phrases", () => {
	test("하되, a lone 후, don't hesitate and a double negative do not downgrade the command", () => {
		for (const brief of [
			"git reset --hard HEAD~3 하되 질문은 하지 말 것",
			"git push --force origin main 후 금지 목록을 확인한다",
			"Don't hesitate to run git reset --hard HEAD~3",
			"git reset --hard HEAD 하지 않으면 안 된다",
		]) {
			expect({ brief, verdict: scanHandoffBrief(brief).verdict }).toEqual({ brief, verdict: "high_risk" });
		}
	});

	test("a forbidden command in its own clause is still advisory", () => {
		expect(scanHandoffBrief("git push --force origin main은 하지 않는다").verdict).toBe("advisory");
	});
});

// doc/plans/qa-c-fixes.md I-1: `<용언>지 말고`/`지 않고` end the forbidden clause; the command after it is ordered.
describe("scanHandoffBrief: 말고·않고 clause boundary", () => {
	const table: ReadonlyArray<readonly [string, boolean]> = [
		["push는 하지 말고 git reset --hard origin/main 하고 커밋해", true],
		["git status는 하지 말고 git reset --hard HEAD를 실행해", true],
		["git reset --hard는 하지 말고 테스트만 돌려", false],
		["git reset --hard 하지 않고 테스트만 돌려", false],
		["git reset --hard는 건드리지 않고 테스트만 돌려", false],
	];
	test.each(table)("%s → high_risk %p", (brief, highRisk) => {
		expect(scanHandoffBrief(brief).verdict === "high_risk").toBe(highRisk);
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

describe("scanHandoffBrief: qa50b-low lane L", () => {
	test("L-8 shell quoting and backslashes around the flag do not hide the command", () => {
		for (const brief of [
			"git reset '--hard' HEAD",
			'git reset "--hard" HEAD',
			"git reset \\--hard HEAD",
			"git reset --h\\ard HEAD",
			"git branch '-D' old",
			"git push origin 'main'",
		]) {
			expect({ brief, verdict: scanHandoffBrief(brief).verdict }).toEqual({ brief, verdict: "high_risk" });
		}
		// The quote in "don't" is not a shell quote: the line still forbids the command.
		expect(scanHandoffBrief("don't run git reset '--hard' HEAD").verdict).toBe("advisory");
		expect(scanHandoffBrief("git reset '--soft' HEAD").verdict).toBe("clear");
	});

	test("L-9 on a rule-definition line only the listed spans after the prefix are the definition", () => {
		expect(
			scanHandoffBrief("- `git_reset_hard`: `git reset --hard` 설명. 이제 `git reset --hard HEAD~9` 를 실행").verdict,
		).toBe("high_risk");
		expect(scanHandoffBrief("- `sql_destructive`: `DROP TABLE`, `DROP DATABASE`, `TRUNCATE TABLE`").verdict).toBe(
			"advisory",
		);
	});

	test("L-10 deeply nested parentheses: the clause search stays linear per level", () => {
		const n = 2000;
		const brief = `${"(".repeat(n)}${" git reset --hard 하지 않는다;".repeat(n / 6)}${")".repeat(n)}`;
		// Every hit is forbidden, so each one's context is built (the old per-level rescan took tens of seconds here).
		expect(scanHandoffBrief(brief).verdict).toBe("advisory");
		// The marker outside the nesting still reaches a command deep inside it.
		expect(scanHandoffBrief(`하지 않는다 ${"(".repeat(50)}git reset --hard${")".repeat(50)}`).verdict).toBe("advisory");
		expect(scanHandoffBrief(`${"(".repeat(50)}git reset --hard${")".repeat(50)}; 하지 않는다`).verdict).toBe(
			"high_risk",
		);
	});
});
