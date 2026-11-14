#!/usr/bin/env python3
"""주간 모델 점검 보고 형식 게이트: '주간 모델 점검' 모니터가 보고 파일을 쓴 뒤 실행한다.

  review.py check <보고 파일> [--collect <수집 출력 파일>]

보고 파일(<state-dir>/report-<YYYY>-W<ww>.md)을 검사한다.
  - 첫 줄 '# 주간 모델 점검 YYYY-Www', '기간:' 줄, '## 제안' 절
  - '## 제안'은 '제안 없음' 한 줄이거나 '### P<1..5> <제목>' 소절 1~5개(번호 1부터 연속)
  - 소절마다 '- 근거:'(규칙 태그 [R1]~[R5] 1개 이상), '- 바꿀 것:', '- 예상 효과:'('추정' 포함), '- 반증선:', '- 되돌리기:'
  - --collect를 주면 근거의 '[R<n>] <대상>'이 수집 출력 '## 규칙 판정'의 항목(태그+대상)과 같아야 한다

종료 코드: 0 = 통과, 2 = 위반(stderr에 위반마다 '줄 <n>: <사유>' 한 줄) 또는 인자·파일 오류('오류: <사유>')
"""

import argparse
import re
import sys
from pathlib import Path

TITLE = re.compile(r"^# 주간 모델 점검 \d{4}-W\d{2}\s*$")
SUBSECTION = re.compile(r"^### P(\d+) \S")
TAG = re.compile(r"\[(R[1-5])\]")
RULE_LINE = re.compile(r"^(?:- )?\[(R[1-5])\] (.+?) — ")
FIELDS = ["근거", "바꿀 것", "예상 효과", "반증선", "되돌리기"]
MAX_PROPOSALS = 5


def collected_rules(text: str) -> list[tuple[str, str]]:
    """수집 출력의 '## 규칙 판정' 절에서 (태그, 대상) 목록."""
    rules: list[tuple[str, str]] = []
    inside = False
    for line in text.splitlines():
        if line.startswith("## "):
            inside = line.strip() == "## 규칙 판정"
            continue
        match = RULE_LINE.match(line.strip()) if inside else None
        if match:
            rules.append((match.group(1), match.group(2)))
    return rules


def check(lines: list[str], rules: list[tuple[str, str]] | None) -> list[str]:
    problems: list[str] = []

    def bad(number: int, reason: str) -> None:
        problems.append(f"줄 {number}: {reason}")

    if not lines or not TITLE.match(lines[0]):
        bad(1, "첫 줄은 '# 주간 모델 점검 YYYY-Www'여야 함")
    if not any(line.startswith("기간:") for line in lines):
        bad(1, "'기간:' 줄이 없음")
    try:
        start = next(i for i, line in enumerate(lines) if line.strip() == "## 제안")
    except StopIteration:
        bad(len(lines) or 1, "'## 제안' 절이 없음")
        return problems
    end = next((i for i in range(start + 1, len(lines)) if re.match(r"^#{1,2} ", lines[i])), len(lines))
    body = [(i + 1, lines[i].rstrip()) for i in range(start + 1, end)]

    heads = [(number, SUBSECTION.match(line)) for number, line in body]
    heads = [(number, int(match.group(1))) for number, match in heads if match]
    if not heads:
        text = [line.strip() for _, line in body if line.strip()]
        if text != ["제안 없음"]:
            bad(start + 1, "'## 제안'은 '제안 없음' 한 줄이거나 '### P<n> <제목>' 소절이어야 함")
        return problems
    for number, line in body:
        if line.strip() == "제안 없음":
            bad(number, "소절이 있는데 '제안 없음'이 함께 있음")
    for index, (number, value) in enumerate(heads):
        if index >= MAX_PROPOSALS:
            bad(number, f"제안은 최대 {MAX_PROPOSALS}개")
        elif value != index + 1:
            bad(number, f"소절 번호는 P{index + 1}이어야 함(P{value})")

    bounds = [number for number, _ in heads] + [end + 1]
    for (number, value), stop in zip(heads, bounds[1:], strict=True):
        section = [(n, line) for n, line in body if number < n < stop]
        for field in FIELDS:
            found = [(n, line) for n, line in section if line.startswith(f"- {field}:")]
            if not found:
                bad(number, f"P{value}에 '- {field}:' 줄이 없음")
                continue
            n, line = found[0]
            content = line[len(f"- {field}:") :].strip()
            if not content:
                bad(n, f"P{value}의 '{field}'가 비어 있음")
            if field == "예상 효과" and "추정" not in content:
                bad(n, f"P{value}의 예상 효과에 '추정'이 없음")
            if field == "근거":
                check_evidence(n, value, content, rules, bad)
    return problems


def names_target(text: str, target: str) -> bool:
    """text가 target으로 시작하고 바로 뒤가 이름의 일부가 아니다('p/m-1'은 'p/m-1-mini'와 다름)."""
    if not text.startswith(target):
        return False
    rest = text[len(target) :]
    return not rest or not (rest[0].isalnum() or rest[0] in "-._/:")


def check_evidence(number: int, value: int, content: str, rules: list[tuple[str, str]] | None, bad) -> None:
    tags = list(TAG.finditer(content))
    if not tags:
        bad(number, f"P{value}의 근거에 규칙 태그([R1]~[R5])가 없음")
        return
    if rules is None:
        return
    for tag in tags:
        after = content[tag.end() :].strip()
        if not any(rule == tag.group(1) and names_target(after, target) for rule, target in rules):
            shown = after.split(" — ", 1)[0][:80]
            bad(number, f"P{value}의 근거 [{tag.group(1)}] {shown}이(가) 수집 출력 '## 규칙 판정'에 없음")


def main() -> int:
    parser = argparse.ArgumentParser(description="주간 모델 점검 보고 형식 게이트")
    commands = parser.add_subparsers(dest="command", required=True)
    check_parser = commands.add_parser("check", help="보고 파일 형식 검사")
    check_parser.add_argument("file", type=Path)
    check_parser.add_argument("--collect", type=Path, default=None)
    args = parser.parse_args()
    try:
        lines = args.file.read_text(encoding="utf-8").splitlines()
        rules = collected_rules(args.collect.read_text(encoding="utf-8")) if args.collect else None
    except (OSError, UnicodeDecodeError) as error:
        sys.stderr.write(f"오류: {error}\n")
        return 2
    problems = check(lines, rules)
    for problem in problems:
        sys.stderr.write(problem + "\n")
    return 2 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
