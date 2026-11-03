#!/usr/bin/env python3
"""주간 개선 회의록 도구: 형식 게이트(check)와 오너 결정 기록(decide).

회의록 경로는 ~/.ompbot/workspace/meetings/<YYYY>-W<ww>.md(ISO 주차, KST)이고 형식은
같은 디렉터리의 README.md(회의록 형식)를 따른다.

사용:
  meeting.py check <file>
      형식을 검사한다. 위반마다 stderr에 '줄 <n>: <사유>' 한 줄.
  meeting.py decide <file> <ID>=<채택|기각|보류> … [--task <ID>=<T-YYYYMMDD-NN>]…
      결정·TASK 셀을 고친다. 전이는 대기|보류 → 채택|기각|보류만, --task는 채택 안건의
      TASK 셀이 '-'일 때만 채운다. 결과가 check를 통과할 때만 같은 디렉터리 임시 파일 +
      os.replace로 쓰고 stdout에 바뀐 행 수를 낸다. 거부되면 stderr '오류: <사유>'.

종료 코드: 0 = 통과/기록함, 2 = 형식 위반·거부·인자 오류(파일은 바뀌지 않는다)
"""

import argparse
import os
import re
import sys
import tempfile
from pathlib import Path

TITLE = re.compile(r"^# 주간 개선 회의 (\d{4})-W(\d{2})\s*$")
AGENDA_ID = re.compile(r"^P-(\d{4})W(\d{2})-([1-5])$")
EVIDENCE = re.compile(
    r"\((자체회고 \d{4}-\d{2}-\d{2}|모니터 [^)]+|TASK T-\d{8}-\d{2}|로그 event=[a-z_]+|회의 \d{4}-W\d{2})\)"
)
REVIEW_PREFIXES = ("동의:", "수정:", "반대:", "검토 실패:")
DECISIONS = ("대기", "채택", "기각", "보류")
OPEN_DECISIONS = ("대기", "보류")
NEW_DECISIONS = ("채택", "기각", "보류")
TASK_ID = re.compile(r"^T-\d{8}-\d{2}$")
COLUMNS = ["ID", "제목", "근거", "제안", "검토", "결정", "TASK"]
SEPARATOR_CELL = re.compile(r"^:?-+:?$")
MAX_ROWS = 5
NO_AGENDA = "안건 없음"
DECISION_COL, TASK_COL = 5, 6


def cells_of(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip()[1:-1].split("|")]


def agenda_rows(lines: list[str]) -> tuple[list[tuple[int, str]], list[tuple[int, str]]]:
    """('## 안건' 표의 (줄 인덱스, 줄) 목록, 위반 목록). 줄 인덱스는 0부터."""
    problems: list[tuple[int, str]] = []
    start = next((i for i, line in enumerate(lines) if line.strip() == "## 안건"), None)
    if start is None:
        return [], [(1, "'## 안건' 절 없음")]
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("#")), len(lines))
    body = [i for i in range(start + 1, end) if lines[i].strip()]
    if not body:
        return [], [(start + 1, f"'## 안건' 아래에 표나 '{NO_AGENDA}'가 없음")]
    if lines[body[0]].strip() == NO_AGENDA:
        problems.extend((i + 1, f"'{NO_AGENDA}' 뒤에 다른 내용이 있음") for i in body[1:])
        return [], problems
    header = body[0]
    if not lines[header].strip().startswith("|") or cells_of(lines[header]) != COLUMNS:
        return [], [(header + 1, "안건 표 머리글이 '| " + " | ".join(COLUMNS) + " |'가 아님")]
    sep = header + 1
    if sep >= end or not all(SEPARATOR_CELL.match(cell) for cell in cells_of(lines[sep])):
        return [], [(sep + 1, "안건 표 구분 줄(|---|…) 없음")]
    rows: list[tuple[int, str]] = []
    for i in range(sep + 1, end):
        if not lines[i].strip().startswith("|"):
            if lines[i].strip():
                problems.append((i + 1, "안건 표 뒤에 표가 아닌 내용이 있음"))
            break
        rows.append((i, lines[i]))
    if not rows:
        problems.append((header + 1, f"안건 행 없음 (0건이면 '{NO_AGENDA}' 한 줄)"))
    if len(rows) > MAX_ROWS:
        problems.append((rows[MAX_ROWS][0] + 1, f"안건 {len(rows)}행 (최대 {MAX_ROWS})"))
    return rows, problems


def validate(text: str) -> list[tuple[int, str]]:
    lines = text.split("\n")
    problems: list[tuple[int, str]] = []
    title = TITLE.match(lines[0]) if lines else None
    if title is None:
        problems.append((1, "제목 줄이 '# 주간 개선 회의 YYYY-Www' 형식이 아님"))
    for prefix in ("기간:", "제안자:"):
        if not any(line.startswith(prefix) for line in lines):
            problems.append((1, f"'{prefix}' 줄 없음"))
    rows, table_problems = agenda_rows(lines)
    problems.extend(table_problems)
    seen: set[str] = set()
    for index, line in rows:
        number = index + 1
        stripped = line.strip()
        if not stripped.endswith("|") or "\\|" in stripped:
            problems.append((number, "행이 '|'로 끝나지 않거나 셀 안에 '|'가 있음"))
            continue
        cells = cells_of(line)
        if len(cells) != len(COLUMNS):
            problems.append((number, f"열 {len(cells)}개 (7개여야 함, 셀 안 '|' 금지)"))
            continue
        agenda_id, title_cell, evidence, proposal, review, decision, task = cells
        match = AGENDA_ID.match(agenda_id)
        if match is None:
            problems.append((number, f"ID '{agenda_id}'가 P-<YYYY>W<ww>-<1..5> 형식이 아님"))
        elif title is not None and match.group(1, 2) != title.group(1, 2):
            problems.append((number, f"ID '{agenda_id}'의 주차가 제목 주차와 다름"))
        if agenda_id in seen:
            problems.append((number, f"ID '{agenda_id}' 중복"))
        seen.add(agenda_id)
        if not title_cell:
            problems.append((number, "제목 셀이 비어 있음"))
        if not EVIDENCE.search(evidence):
            problems.append((number, "근거 셀에 출처 태그 '(자체회고 …|모니터 …|TASK …|로그 event=…|회의 …)' 없음"))
        if not proposal:
            problems.append((number, "제안 셀이 비어 있음"))
        if not review.startswith(REVIEW_PREFIXES):
            problems.append((number, "검토 셀이 '동의:'·'수정:'·'반대:'·'검토 실패:' 중 하나로 시작하지 않음"))
        if decision not in DECISIONS:
            problems.append((number, f"결정 '{decision}'이 대기|채택|기각|보류가 아님"))
        if task != "-" and not TASK_ID.match(task):
            problems.append((number, f"TASK '{task}'가 '-'나 T-YYYYMMDD-NN이 아님"))
    return sorted(problems)


def report(problems: list[tuple[int, str]]) -> None:
    for number, message in problems:
        print(f"줄 {number}: {message}", file=sys.stderr)


class Refused(Exception):
    pass


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise Refused(f"파일을 읽을 수 없음: {path}: {error}") from error


def pairs(values: list[str], kind: str) -> dict[str, str]:
    parsed: dict[str, str] = {}
    for value in values:
        agenda_id, eq, target = value.partition("=")
        if not eq or not agenda_id or not target:
            raise Refused(f"{kind} 인자 '{value}'가 <ID>=<값> 형식이 아님")
        if agenda_id in parsed:
            raise Refused(f"{kind} 인자에 '{agenda_id}'가 두 번 있음")
        parsed[agenda_id] = target
    return parsed


def decide(path: Path, changes: list[str], task_args: list[str]) -> int:
    decisions = pairs(changes, "결정")
    tasks = pairs(task_args, "--task")
    if not decisions and not tasks:
        raise Refused("바꿀 결정이나 --task가 없음")
    text = read_text(path)
    problems = validate(text)
    if problems:
        report(problems)
        raise Refused("원본 회의록이 형식 검사를 통과하지 못함")
    lines = text.split("\n")
    rows = {cells_of(line)[0]: index for index, line in agenda_rows(lines)[0]}
    cells = {agenda_id: cells_of(lines[index]) for agenda_id, index in rows.items()}
    for agenda_id in [*decisions, *tasks]:
        if agenda_id not in rows:
            raise Refused(f"모르는 안건 ID '{agenda_id}'")
    for agenda_id, decision in decisions.items():
        current = cells[agenda_id][DECISION_COL]
        if decision not in NEW_DECISIONS or current not in OPEN_DECISIONS:
            raise Refused(f"{agenda_id}: '{current}' → '{decision}' 전이는 허용되지 않음 (대기|보류 → 채택|기각|보류)")
        cells[agenda_id][DECISION_COL] = decision
    for agenda_id, task in tasks.items():
        row = cells[agenda_id]
        if not TASK_ID.match(task):
            raise Refused(f"{agenda_id}: TASK '{task}'가 T-YYYYMMDD-NN 형식이 아님")
        if row[DECISION_COL] != "채택":
            raise Refused(f"{agenda_id}: 채택되지 않은 안건('{row[DECISION_COL]}')에는 TASK를 기록할 수 없음")
        if row[TASK_COL] not in ("-", task):
            raise Refused(f"{agenda_id}: 이미 TASK '{row[TASK_COL]}'가 기록돼 있음")
        row[TASK_COL] = task
    changed = 0
    for agenda_id, index in rows.items():
        line = "| " + " | ".join(cells[agenda_id]) + " |"
        if cells_of(line) != cells_of(lines[index]):
            lines[index] = line
            changed += 1
    updated = "\n".join(lines)
    problems = validate(updated)
    if problems:
        report(problems)
        raise Refused("결정을 반영한 회의록이 형식 검사를 통과하지 못함")
    if changed:
        write_atomic(path, updated)
    print(changed)
    return 0


def write_atomic(path: Path, text: str) -> None:
    mode = path.stat().st_mode & 0o7777
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            out.write(text)
            out.flush()
            os.fsync(out.fileno())
        os.chmod(temp, mode)
        os.replace(temp, path)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description="주간 개선 회의록 형식 게이트와 결정 기록")
    commands = parser.add_subparsers(dest="command", required=True)
    check_cmd = commands.add_parser("check", help="회의록 형식 검사")
    check_cmd.add_argument("file", type=Path)
    decide_cmd = commands.add_parser("decide", help="오너 결정 기록")
    decide_cmd.add_argument("file", type=Path)
    decide_cmd.add_argument("changes", nargs="*", metavar="ID=결정")
    decide_cmd.add_argument("--task", action="append", default=[], metavar="ID=T-YYYYMMDD-NN")
    args = parser.parse_args()
    try:
        if args.command == "check":
            problems = validate(read_text(args.file))
            report(problems)
            return 2 if problems else 0
        return decide(args.file, args.changes, args.task)
    except Refused as error:
        print(f"오류: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
