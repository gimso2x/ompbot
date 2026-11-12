#!/usr/bin/env python3
"""주간 개선 회의 수집기: '주간 개선 회의' 모니터가 매주 일요일 06:00(봇 시간대)에 한 번 실행한다.

지난 N일(기본 7일, 창 = [now - N일, now), 날짜는 봇 시간대 기준) 기록을 읽기 전용으로 모아
마크다운으로 출력한다. 섹션 순서는 고정이다.
  1. 소스 상태: reflections, db, log, meetings 각각 ok/missing/error
  2. 자체회고: <home>/workspace/reflections/<날짜>.md의 '## 문제'·'## 다음 행동' 절
  3. 모니터 실행: ompbot.db monitor_events의 모니터별 stage 개수와 실패 오류 첫 줄
  4. TASK: ompbot.db tasks의 열린 TASK(working·blocked·review)와 창 안 종료 개수
  5. 경고 이벤트: <home>/logs/ompbot.log의 level=warn|error 줄 event별 개수
  6. 지난 회의: <home>/workspace/meetings/<YYYY>-W<ww>.md 중 이번 주 이전 최근 4개의 열린 안건
못 읽은 소스는 본문 섹션 대신 '소스 상태'에 missing/error로 남긴다. DB는 mode=ro로만 열고
어떤 파일도 쓰지 않는다.

입력: --home <dir>(기본 ~/.ompbot), --now <ISO8601>(기본 현재 시각; 시간대 없으면 BOT_TZ), --days N(기본 7)
종료 코드: 0 = 출력함(소스 일부를 못 읽어도 0), 2 = 인자 오류
"""

import argparse
import datetime as dt
import json
import os
import re
import sqlite3
import sys
import urllib.parse
from collections import Counter
from pathlib import Path
from zoneinfo import ZoneInfo

def bot_timezone() -> dt.tzinfo:
    """봇 시간대: OMPBOT_TZ 환경 변수 → <OMPBOT_HOME 또는 ~/.ompbot>/config.json의 timezone → 시스템 시간대."""
    name = os.environ.get("OMPBOT_TZ", "").strip()
    if not name:
        config = Path(os.environ.get("OMPBOT_HOME") or Path.home() / ".ompbot") / "config.json"
        try:
            name = str(json.loads(config.read_text(encoding="utf-8")).get("timezone") or "").strip()
        except (OSError, ValueError, AttributeError):
            name = ""
    return ZoneInfo(name) if name else dt.datetime.now().astimezone().tzinfo


BOT_TZ = bot_timezone()
MAX_SECTION_CHARS = 1500
MAX_OUTPUT_CHARS = 20000
CUT = "…(잘림)"
STAGES = ["admitted", "dispatched", "authored", "delivered", "failed", "failed_no_retry", "skipped", "no_report"]
OPEN_TASK = ("working", "blocked", "review")
MAX_ERRORS_PER_MONITOR = 3
MAX_EVENTS = 15
PAST_MEETINGS = 4
MEETING_FILE = re.compile(r"^(\d{4})-W(\d{2})\.md$")
AGENDA_ROW = re.compile(r"^\|\s*P-\d{4}W\d{2}-\d+\s*\|")
LOG_FIELD = re.compile(r'(\w+)=("(?:[^"\\]|\\.)*"|\S*)')


def first_line(text: str) -> str:
    for line in str(text).splitlines():
        if line.strip():
            return line.strip()
    return ""


def clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit] + CUT


def parse_now(value: str) -> dt.datetime:
    try:
        parsed = dt.datetime.fromisoformat(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"ISO8601 시각이 아님: {value}") from error
    return parsed.replace(tzinfo=BOT_TZ) if parsed.tzinfo is None else parsed


def positive_int(value: str) -> int:
    try:
        number = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"정수가 아님: {value}") from error
    if number < 1:
        raise argparse.ArgumentTypeError(f"1 이상이어야 함: {value}")
    return number


def markdown_sections(text: str) -> dict[str, str]:
    """'## 제목' 절 본문(다음 '#'·'##' 제목 전까지)을 제목별로 돌려준다."""
    found: dict[str, list[str]] = {}
    current: list[str] | None = None
    for line in text.splitlines():
        heading = re.match(r"^(#{1,2})\s+(.*?)\s*$", line)
        if heading:
            current = found.setdefault(heading.group(2), []) if heading.group(1) == "##" else None
            continue
        if current is not None:
            current.append(line)
    return {title: "\n".join(lines).strip() for title, lines in found.items()}


def collect_reflections(home: Path, dates: list[dt.date]) -> tuple[str, str | None]:
    root = home / "workspace" / "reflections"
    if not root.is_dir():
        return "missing", None
    present: list[tuple[dt.date, str]] = []
    missing: list[str] = []
    try:
        for day in dates:
            path = root / f"{day.isoformat()}.md"
            if path.is_file():
                present.append((day, path.read_text(encoding="utf-8", errors="replace")))
            else:
                missing.append(day.isoformat())
    except OSError as error:
        return f"error: {first_line(error)}", None
    status = f"ok ({len(present)}/{len(dates)}일" + (f", 누락 {', '.join(missing)})" if missing else ")")
    lines = ["## 자체회고"]
    if not present:
        lines.append("- 창 안 자체회고 없음")
    for day, text in present:
        sections = markdown_sections(text)
        lines.append(f"### {day.isoformat()}")
        for title in ("문제", "다음 행동"):
            body = sections.get(title)
            lines.append(f"#### {title}")
            lines.append(clip(body, MAX_SECTION_CHARS) if body else "(절 없음)")
    return status, "\n".join(lines)


def open_db(home: Path) -> tuple[sqlite3.Connection | None, str]:
    path = home / "ompbot.db"
    if not path.is_file():
        return None, "missing"
    try:
        db = sqlite3.connect(f"file:{urllib.parse.quote(str(path))}?mode=ro", uri=True)
        db.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchall()
        return db, "ok"
    except sqlite3.Error as error:
        return None, f"error: {first_line(error)}"


def collect_monitors(db: sqlite3.Connection, start_ms: int, end_ms: int) -> str:
    rows = db.execute(
        "SELECT COALESCE(m.name, e.monitor_id), e.stage, e.error FROM monitor_events e"
        " LEFT JOIN monitors m ON m.id = e.monitor_id"
        " WHERE e.created_at >= ? AND e.created_at < ? ORDER BY e.created_at, e.event_id",
        (start_ms, end_ms),
    ).fetchall()
    stages: dict[str, Counter] = {}
    errors: dict[str, list[str]] = {}
    for name, stage, error in rows:
        stages.setdefault(name, Counter())[stage] += 1
        seen = errors.setdefault(name, [])
        line = first_line(error or "")
        if stage in ("failed", "failed_no_retry") and line and line not in seen and len(seen) < MAX_ERRORS_PER_MONITOR:
            seen.append(line)
    lines = ["## 모니터 실행"]
    if not stages:
        lines.append("- 창 안 실행 없음")
    for name in sorted(stages):
        counts = stages[name]
        order = STAGES + sorted(set(counts) - set(STAGES))
        lines.append(f"- {name}: " + " · ".join(f"{stage} {counts[stage]}" for stage in order if counts[stage]))
        lines.extend(f"  - 오류: {clip(line, 300)}" for line in errors[name])
    return "\n".join(lines)


def collect_tasks(db: sqlite3.Connection, start_ms: int, end_ms: int) -> str:
    placeholders = ",".join("?" for _ in OPEN_TASK)
    rows = db.execute(
        f"SELECT task_id, status, title, created_at FROM tasks WHERE status IN ({placeholders})"
        " ORDER BY created_at, task_id",
        OPEN_TASK,
    ).fetchall()
    closed = dict(
        db.execute(
            "SELECT status, COUNT(*) FROM tasks WHERE status IN ('done','cancelled')"
            " AND closed_at >= ? AND closed_at < ? GROUP BY status",
            (start_ms, end_ms),
        ).fetchall()
    )
    lines = ["## TASK"]
    if not rows:
        lines.append("- 열린 TASK 없음")
    for task_id, status, title, created_at in rows:
        lines.append(f"- {task_id} {status} {first_line(title)} (경과 {max(0, (end_ms - created_at) // 86_400_000)}일)")
    lines.append(f"- 창 안 종료: done {closed.get('done', 0)} · cancelled {closed.get('cancelled', 0)}")
    return "\n".join(lines)


def collect_log(home: Path, start: dt.datetime, end: dt.datetime) -> tuple[str, str | None]:
    path = home / "logs" / "ompbot.log"
    if not path.is_file():
        return "missing", None
    counts: Counter = Counter()
    try:
        with path.open(encoding="utf-8", errors="replace") as log:
            for line in log:
                fields = dict(LOG_FIELD.findall(line))
                if fields.get("level") not in ("warn", "error") or not fields.get("event"):
                    continue
                try:
                    at = dt.datetime.fromisoformat(fields.get("ts", ""))
                except ValueError:
                    continue
                if at.tzinfo is not None and start <= at < end:
                    counts[fields["event"]] += 1
    except OSError as error:
        return f"error: {first_line(error)}", None
    lines = ["## 경고 이벤트"]
    if not counts:
        lines.append("- 창 안 warn/error 없음")
    ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:MAX_EVENTS]
    lines.extend(f"- {event} {count}" for event, count in ranked)
    return "ok", "\n".join(lines)


def collect_meetings(home: Path, now: dt.datetime, db: sqlite3.Connection | None) -> tuple[str, str | None]:
    root = home / "workspace" / "meetings"
    if not root.is_dir():
        return "missing", None
    year, week, _ = now.astimezone(BOT_TZ).isocalendar()
    this_week = (year, week)
    try:
        files = sorted(
            (int(match.group(1)), int(match.group(2)), path)
            for path in root.iterdir()
            if path.is_file() and (match := MEETING_FILE.match(path.name))
        )
        past = [path for y, w, path in files if (y, w) < this_week][-PAST_MEETINGS:]
        texts = [(path.name, path.read_text(encoding="utf-8", errors="replace")) for path in past]
    except OSError as error:
        return f"error: {first_line(error)}", None
    lines = ["## 지난 회의"]
    for name, text in reversed(texts):
        for line in text.splitlines():
            if not AGENDA_ROW.match(line):
                continue
            cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
            if len(cells) != 7:
                continue
            agenda_id, title, decision, task = cells[0], cells[1], cells[5], cells[6]
            if decision in ("대기", "보류"):
                lines.append(f"- {agenda_id} {title} {decision} ({name})")
            elif decision == "채택" and task == "-":
                lines.append(f"- {agenda_id} {title} {decision} ({name}) → TASK 없음")
            elif decision == "채택":
                lines.append(f"- {agenda_id} {title} {decision} ({name}) → {task} {task_status(db, task)}")
    if len(lines) == 1:
        lines.append(f"- 열린 안건 없음 (지난 회의 {len(texts)}개)")
    return "ok", "\n".join(lines)


def task_status(db: sqlite3.Connection | None, task_id: str) -> str:
    if db is None:
        return "(status 조회 불가)"
    try:
        row = db.execute("SELECT status FROM tasks WHERE task_id = ?", (task_id,)).fetchone()
    except sqlite3.Error as error:
        return f"(status 조회 오류: {first_line(error)})"
    return row[0] if row else "(DB에 없음)"


def main() -> int:
    parser = argparse.ArgumentParser(description="주간 개선 회의 수집기 (읽기 전용)")
    parser.add_argument("--home", type=Path, default=Path.home() / ".ompbot")
    parser.add_argument("--now", type=parse_now, default=None)
    parser.add_argument("--days", type=positive_int, default=7)
    args = parser.parse_args()
    now = args.now or dt.datetime.now(BOT_TZ)
    start = now - dt.timedelta(days=args.days)
    start_day = start.astimezone(BOT_TZ).date()
    dates = [start_day + dt.timedelta(days=offset) for offset in range(args.days)]
    start_ms, end_ms = int(start.timestamp() * 1000), int(now.timestamp() * 1000)
    home: Path = args.home.expanduser()

    status: dict[str, str] = {}
    sections: list[str] = []
    status["reflections"], body = collect_reflections(home, dates)
    sections.extend([body] if body else [])

    db, status["db"] = open_db(home)
    if db is not None:
        try:
            sections.extend([collect_monitors(db, start_ms, end_ms), collect_tasks(db, start_ms, end_ms)])
        except sqlite3.Error as error:
            status["db"] = f"error: {first_line(error)}"
            db.close()
            db = None

    status["log"], body = collect_log(home, start, now)
    sections.extend([body] if body else [])
    status["meetings"], body = collect_meetings(home, now, db)
    sections.extend([body] if body else [])
    if db is not None:
        db.close()

    window = f"{start.astimezone(BOT_TZ):%Y-%m-%d %H:%M} ~ {now.astimezone(BOT_TZ):%Y-%m-%d %H:%M %Z}"
    head = "\n".join(["## 소스 상태", f"- 창: {window}", *(f"- {name}: {value}" for name, value in status.items())])
    output = "\n\n".join([head, *sections]) + "\n"
    if len(output) > MAX_OUTPUT_CHARS:
        output = output[: MAX_OUTPUT_CHARS - len(CUT) - 1] + "\n" + CUT
    sys.stdout.write(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
