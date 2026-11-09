#!/usr/bin/env python3
"""기억 교정 도구: 판정 파일 형식 게이트(check), 은행 스냅샷(snapshot), 교체 메모 id 찾기(find),
반영 결과 검증(verify).

판정 파일 경로는 ~/.ompbot/workspace/memory-audit/<YYYY-MM-DD>.md(KST)이고 형식은 같은 디렉터리의
README.md(판정 파일 형식)를 따른다. 은행(Mnemopi mnemopi.db)은 언제나 mode=ro로만 열고 쓰지 않는다.
무효화는 모델이 memory_edit invalidate로만 한다.

은행 고르기(snapshot·find·verify 공통): --bank <mnemopi.db>, 없으면 --banks-root
(기본 ~/.omp/agent/memories/mnemopi/banks) 아래 */mnemopi.db 중 working_memory.metadata_json의 cwd가
--workspace(기본 ~/.ompbot/workspace)인 행이 가장 많은 은행.

사용:
  audit.py check <file>
      형식을 검사한다. 위반마다 stderr에 '줄 <n>: <사유>' 한 줄.
  audit.py snapshot [은행 인자] --out-dir <dir> [--now <ISO8601>]
      sqlite3 백업 API로 <dir>/<은행 이름>-<YYYYmmdd-HHMMSS>.db(KST, --now 또는 현재 시각)에 복사하고
      경로를 stdout에 낸다.
      <dir>이 없으면 만들고, 같은 은행 스냅샷은 최신 4개만 남긴다.
  audit.py find [은행 인자] --since <ISO8601> [--now <ISO8601>]
      유효 working 행 중 source='coding-agent-retain', 본문이 '기억 교정 '으로 시작, timestamp >= since인
      행의 id를 timestamp 최신 1개 낸다.
  audit.py verify <file> [은행 인자] [--record <state.json>] [--now <ISO8601>]
      판정과 은행 상태를 대조한다(무효: valid_until <= now·superseded_by NULL, 교체: valid_until <= now·
      superseded_by = 교체 id·교체 id는 유효한 working 행, 유지: 둘 다 NULL 또는 같은 파일의 무효·교체
      working id를 summary_of에 담은 episodic 연쇄 무효화 — stdout에 '연쇄 <id>'). 어긋난 행마다 stderr
      '<id>: <사유>'. 통과하고 --record면 state에 {id: {audited_at, sha256, verdict}}를 합쳐 쓴다
      (같은 디렉터리 임시 파일 + os.replace).
--now·--since는 시간대가 없으면 KST로 본다.

종료 코드: 0 = 통과/출력함, 1 = find가 찾지 못함, 2 = 형식 위반·검증 실패·스냅샷 실패·인자 오류
(실패하면 state·스냅샷 디렉터리에 반쯤 쓴 파일을 남기지 않는다)
"""

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sqlite3
import sys
import tempfile
import urllib.parse
from pathlib import Path
from zoneinfo import ZoneInfo

KST = ZoneInfo("Asia/Seoul")
UTC = dt.timezone.utc
DEFAULT_BANKS_ROOT = "~/.omp/agent/memories/mnemopi/banks"
DEFAULT_WORKSPACE = "~/.ompbot/workspace"
TITLE = re.compile(r"^# 기억 교정 \d{4}-\d{2}-\d{2}\s*$")
MEMORY_ID = re.compile(r"^[0-9a-f]{16}$")
EVIDENCE = re.compile(r"\((코드 [^)]+|설정 [^)]+|DB [^)]+|파일 [^)]+|기록 \d{4}-\d{2}-\d{2}(?: [^)]+)?|잡음)\)")
COLUMNS = ["ID", "분류", "회상", "판정", "근거", "교체"]
KINDS = ("noise-monitor", "claim")
VERDICTS = ("유지", "무효", "교체")
SEPARATOR_CELL = re.compile(r"^:?-+:?$")
MAX_ROWS = 50
NO_CANDIDATES = "후보 없음"
KEEP_SNAPSHOTS = 4
RETAIN_SOURCE = "coding-agent-retain"
RETAIN_PREFIX = "기억 교정 "


def first_line(text: object) -> str:
    for line in str(text).splitlines():
        if line.strip():
            return line.strip()
    return ""


def parse_now(value: str) -> dt.datetime:
    try:
        parsed = dt.datetime.fromisoformat(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"ISO8601 시각이 아님: {value}") from error
    return parsed.replace(tzinfo=KST) if parsed.tzinfo is None else parsed


def parse_time(value: object) -> dt.datetime | None:
    """Mnemopi 시각 문자열(UTC ISO, 'Z' 접미)을 읽는다. 시간대가 없으면 UTC로 본다."""
    try:
        parsed = dt.datetime.fromisoformat(str(value))
    except ValueError:
        return None
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed


def is_valid(valid_until: object, superseded_by: object, now: dt.datetime) -> bool:
    if superseded_by is not None:
        return False
    if valid_until is None:
        return True
    until = parse_time(valid_until)
    if until is None:
        return str(valid_until) > now.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    return until > now


def open_ro(path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(f"file:{urllib.parse.quote(str(path))}?mode=ro", uri=True)
    db.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchall()
    return db


def same_dir(a: str, b: str) -> bool:
    return os.path.normpath(os.path.expanduser(a)) == os.path.normpath(os.path.expanduser(b))


def find_bank(bank: Path | None, banks_root: Path, workspace: str) -> Path | None:
    """--bank가 있으면 그 파일, 없으면 cwd가 workspace인 working 행이 가장 많은 은행(동률이면 경로순 첫째)."""
    if bank is not None:
        path = bank.expanduser()
        return path if path.is_file() else None
    best: tuple[int, Path] | None = None
    root = banks_root.expanduser()
    if not root.is_dir():
        return None
    for path in sorted(root.glob("*/mnemopi.db")):
        try:
            db = open_ro(path)
            try:
                rows = db.execute(
                    "SELECT metadata_json FROM working_memory WHERE metadata_json LIKE '%\"cwd\"%'"
                ).fetchall()
            finally:
                db.close()
        except sqlite3.Error:
            continue
        count = 0
        for (metadata,) in rows:
            try:
                cwd = json.loads(metadata).get("cwd")
            except (ValueError, AttributeError):
                continue
            if isinstance(cwd, str) and same_dir(cwd, workspace):
                count += 1
        if count and (best is None or count > best[0]):
            best = (count, path)
    return best[1] if best else None


class Failed(Exception):
    pass


def resolve_bank(args: argparse.Namespace) -> Path:
    bank = find_bank(args.bank, args.banks_root, args.workspace)
    if bank is None:
        where = args.bank if args.bank is not None else f"{args.banks_root} (cwd {args.workspace})"
        raise Failed(f"은행 없음: {where}")
    return bank


# ---- check ----


def cells_of(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip()[1:-1].split("|")]


def verdict_rows(lines: list[str]) -> tuple[list[tuple[int, str]], list[tuple[int, str]]]:
    """('## 판정' 표의 (줄 인덱스, 줄) 목록, 위반 목록). 줄 인덱스는 0부터."""
    problems: list[tuple[int, str]] = []
    start = next((i for i, line in enumerate(lines) if line.strip() == "## 판정"), None)
    if start is None:
        return [], [(1, "'## 판정' 절 없음")]
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("#")), len(lines))
    body = [i for i in range(start + 1, end) if lines[i].strip()]
    if not body:
        return [], [(start + 1, f"'## 판정' 아래에 표나 '{NO_CANDIDATES}'가 없음")]
    if lines[body[0]].strip() == NO_CANDIDATES:
        problems.extend((i + 1, f"'{NO_CANDIDATES}' 뒤에 다른 내용이 있음") for i in body[1:])
        return [], problems
    header = body[0]
    if not lines[header].strip().startswith("|") or cells_of(lines[header]) != COLUMNS:
        return [], [(header + 1, "판정 표 머리글이 '| " + " | ".join(COLUMNS) + " |'가 아님")]
    sep = header + 1
    if sep >= end or not all(SEPARATOR_CELL.match(cell) for cell in cells_of(lines[sep])):
        return [], [(sep + 1, "판정 표 구분 줄(|---|…) 없음")]
    rows: list[tuple[int, str]] = []
    for i in range(sep + 1, end):
        if not lines[i].strip().startswith("|"):
            if lines[i].strip():
                problems.append((i + 1, "판정 표 뒤에 표가 아닌 내용이 있음"))
            break
        rows.append((i, lines[i]))
    if not rows:
        problems.append((header + 1, f"판정 행 없음 (0건이면 '{NO_CANDIDATES}' 한 줄)"))
    if len(rows) > MAX_ROWS:
        problems.append((rows[MAX_ROWS][0] + 1, f"판정 {len(rows)}행 (최대 {MAX_ROWS})"))
    return rows, problems


def validate(text: str) -> tuple[list[dict], list[tuple[int, str]]]:
    """(형식이 맞는 판정 행 목록, 위반 목록)."""
    lines = text.split("\n")
    problems: list[tuple[int, str]] = []
    if not lines or not TITLE.match(lines[0]):
        problems.append((1, "제목 줄이 '# 기억 교정 YYYY-MM-DD' 형식이 아님"))
    for prefix in ("은행:", "스냅샷:"):
        if not any(line.startswith(prefix) and line[len(prefix) :].strip() for line in lines):
            problems.append((1, f"'{prefix}' 줄 없음"))
    rows, table_problems = verdict_rows(lines)
    problems.extend(table_problems)
    parsed: list[dict] = []
    seen: set[str] = set()
    for index, line in rows:
        number = index + 1
        stripped = line.strip()
        if not stripped.endswith("|") or "\\|" in stripped:
            problems.append((number, "행이 '|'로 끝나지 않거나 셀 안에 '|'가 있음"))
            continue
        cells = cells_of(line)
        if len(cells) != len(COLUMNS):
            problems.append((number, f"열 {len(cells)}개 (6개여야 함, 셀 안 '|' 금지)"))
            continue
        memory_id, kind, recall, verdict, evidence, replacement = cells
        if not MEMORY_ID.match(memory_id):
            problems.append((number, f"ID '{memory_id}'가 16자리 소문자 16진수가 아님"))
        if memory_id in seen:
            problems.append((number, f"ID '{memory_id}' 중복"))
        seen.add(memory_id)
        if kind not in KINDS:
            problems.append((number, f"분류 '{kind}'가 noise-monitor|claim이 아님"))
        if not recall.isascii() or not recall.isdigit():
            problems.append((number, f"회상 '{recall}'이 0 이상 정수가 아님"))
        if verdict not in VERDICTS:
            problems.append((number, f"판정 '{verdict}'이 유지|무효|교체가 아님"))
        elif kind == "noise-monitor" and verdict != "무효":
            problems.append((number, f"noise-monitor 행의 판정은 '무효'만 (지금 '{verdict}')"))
        tags = EVIDENCE.findall(evidence)
        if not tags:
            problems.append((number, "근거 셀에 출처 태그 '(코드 …|설정 …|DB …|파일 …|기록 YYYY-MM-DD…|잡음)' 없음"))
        elif "잡음" in tags and kind != "noise-monitor":
            problems.append((number, "'(잡음)' 태그는 noise-monitor 행에만 쓸 수 있음"))
        if verdict == "교체":
            if not MEMORY_ID.match(replacement):
                problems.append((number, f"교체 행의 교체 id '{replacement}'가 16자리 소문자 16진수가 아님"))
            elif replacement == memory_id:
                problems.append((number, "교체 id가 행 ID와 같음"))
        elif replacement != "-":
            problems.append((number, f"판정 '{verdict}' 행의 교체 셀은 '-'여야 함 (지금 '{replacement}')"))
        parsed.append({"id": memory_id, "kind": kind, "verdict": verdict, "replacement": replacement})
    return parsed, sorted(problems)


def report(problems: list[tuple[int, str]]) -> None:
    for number, message in problems:
        print(f"줄 {number}: {message}", file=sys.stderr)


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise Failed(f"파일을 읽을 수 없음: {path}: {error}") from error


def check(path: Path) -> int:
    _, problems = validate(read_text(path))
    report(problems)
    return 2 if problems else 0


# ---- snapshot ----


def snapshot(args: argparse.Namespace) -> int:
    bank = resolve_bank(args)
    name = bank.parent.name
    out_dir: Path = args.out_dir.expanduser()
    stamp = (args.now or dt.datetime.now(KST)).astimezone(KST).strftime("%Y%m%d-%H%M%S")
    target = out_dir / f"{name}-{stamp}.db"
    temp: str | None = None
    try:
        os.makedirs(out_dir, exist_ok=True)
        fd, temp = tempfile.mkstemp(dir=out_dir, prefix=f".{target.name}.", suffix=".part")
        os.close(fd)
        source = open_ro(bank)
        try:
            copy = sqlite3.connect(temp)
            try:
                source.backup(copy)
            finally:
                copy.close()
        finally:
            source.close()
        os.replace(temp, target)
    except (OSError, sqlite3.Error) as error:
        if temp is not None:
            Path(temp).unlink(missing_ok=True)
        raise Failed(f"스냅샷 실패: {first_line(error)}") from error
    pattern = re.compile(rf"^{re.escape(name)}-\d{{8}}-\d{{6}}\.db$")
    mine = sorted(path for path in out_dir.iterdir() if pattern.match(path.name))
    for old in mine[:-KEEP_SNAPSHOTS]:
        old.unlink(missing_ok=True)
    print(target)
    return 0


# ---- find ----


def find(args: argparse.Namespace) -> int:
    bank = resolve_bank(args)
    since: dt.datetime = args.since
    now: dt.datetime = args.now or dt.datetime.now(KST)
    db = open_ro(bank)
    try:
        rows = db.execute(
            "SELECT id, content, timestamp, valid_until, superseded_by FROM working_memory WHERE source = ?",
            (RETAIN_SOURCE,),
        ).fetchall()
    finally:
        db.close()
    best: tuple[dt.datetime, str] | None = None
    for memory_id, content, timestamp, valid_until, superseded_by in rows:
        at = parse_time(timestamp)
        if at is None or at < since or not (content or "").startswith(RETAIN_PREFIX):
            continue
        if not is_valid(valid_until, superseded_by, now):
            continue
        if best is None or at > best[0]:
            best = (at, memory_id)
    if best is None:
        return 1
    print(best[1])
    return 0


# ---- verify ----


def fetch(db: sqlite3.Connection, table: str, memory_id: str) -> dict | None:
    summary = "summary_of" if table == "episodic_memory" else "NULL"
    row = db.execute(
        f"SELECT id, content, valid_until, superseded_by, {summary} FROM {table} WHERE id = ?", (memory_id,)
    ).fetchone()
    if row is None:
        return None
    return {
        "table": table,
        "content": row[1] or "",
        "valid_until": row[2],
        "superseded_by": row[3],
        "summary_of": [part.strip() for part in (row[4] or "").split(",") if part.strip()],
    }


def invalidated_by_now(memory: dict, now: dt.datetime) -> str | None:
    """valid_until이 채워져 있고 now 이하면 None, 아니면 사유."""
    if memory["valid_until"] is None:
        return "valid_until이 NULL (무효화되지 않음)"
    until = parse_time(memory["valid_until"])
    if until is None:
        return f"valid_until '{memory['valid_until']}'을 시각으로 읽을 수 없음"
    if until > now:
        return f"valid_until {memory['valid_until']}이 기준 시각 뒤"
    return None


def verify(args: argparse.Namespace) -> int:
    rows, problems = validate(read_text(args.file))
    if problems:
        report(problems)
        raise Failed("판정 파일이 형식 검사를 통과하지 못함")
    now: dt.datetime = args.now or dt.datetime.now(KST)
    bank = resolve_bank(args)
    db = open_ro(bank)
    try:
        memories = {
            row["id"]: fetch(db, "working_memory", row["id"]) or fetch(db, "episodic_memory", row["id"])
            for row in rows
        }
        replacements = {
            row["replacement"]: fetch(db, "working_memory", row["replacement"])
            for row in rows
            if row["verdict"] == "교체"
        }
    finally:
        db.close()
    # 같은 파일에서 무효·교체된 working id → Mnemopi가 연쇄 episodic 행에 함께 쓰는 superseded_by 값.
    cascades = {
        row["id"]: (row["replacement"] if row["verdict"] == "교체" else None)
        for row in rows
        if row["verdict"] in ("무효", "교체") and (memories[row["id"]] or {}).get("table") == "working_memory"
    }
    failures: list[str] = []
    chained: list[str] = []
    for row in rows:
        memory_id, verdict = row["id"], row["verdict"]
        memory = memories[memory_id]
        if memory is None:
            failures.append(f"{memory_id}: working_memory·episodic_memory 어디에도 없음")
            continue
        if verdict in ("무효", "교체"):
            reason = invalidated_by_now(memory, now)
            if reason:
                failures.append(f"{memory_id}: {verdict} 행인데 {reason}")
            expected = row["replacement"] if verdict == "교체" else None
            if memory["superseded_by"] != expected:
                failures.append(f"{memory_id}: superseded_by가 {memory['superseded_by']} (기대 {expected})")
            if verdict == "교체":
                replacement = replacements.get(row["replacement"])
                if replacement is None:
                    failures.append(f"{memory_id}: 교체 id {row['replacement']}가 working_memory에 없음")
                elif replacement["valid_until"] is not None or replacement["superseded_by"] is not None:
                    failures.append(f"{memory_id}: 교체 id {row['replacement']}가 무효화돼 있음")
            continue
        if memory["valid_until"] is None and memory["superseded_by"] is None:
            continue
        sources = [source for source in memory["summary_of"] if source in cascades]
        explained = (
            memory["table"] == "episodic_memory"
            and invalidated_by_now(memory, now) is None
            and any(memory["superseded_by"] == cascades[source] for source in sources)
        )
        if explained:
            chained.append(memory_id)
        else:
            failures.append(
                f"{memory_id}: 유지 행인데 무효화돼 있음 (valid_until {memory['valid_until']}, "
                f"superseded_by {memory['superseded_by']}, 같은 파일의 무효·교체 working id로 설명되지 않음)"
            )
    if failures:
        for line in failures:
            print(line, file=sys.stderr)
        return 2
    if args.record is not None:
        record(args.record.expanduser(), rows, memories, now)
    for memory_id in chained:
        print(f"연쇄 {memory_id}")
    print(f"검증 통과 {len(rows)}행")
    return 0


def record(path: Path, rows: list[dict], memories: dict, now: dt.datetime) -> None:
    state: dict = {}
    if path.exists():
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise Failed(f"state를 읽을 수 없음: {path}: {first_line(error)}") from error
        if not isinstance(state, dict):
            raise Failed(f"state가 JSON 객체가 아님: {path}")
    audited_at = now.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    for row in rows:
        content = memories[row["id"]]["content"]
        state[row["id"]] = {
            "audited_at": audited_at,
            "sha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
            "verdict": row["verdict"],
        }
    os.makedirs(path.parent, exist_ok=True)
    mode = path.stat().st_mode & 0o7777 if path.exists() else 0o600
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(state, out, ensure_ascii=False, indent=1, sort_keys=True)
            out.write("\n")
            out.flush()
            os.fsync(out.fileno())
        os.chmod(temp, mode)
        os.replace(temp, path)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description="기억 교정 판정 파일 게이트·스냅샷·교체 id 찾기·반영 검증")
    commands = parser.add_subparsers(dest="command", required=True)
    check_cmd = commands.add_parser("check", help="판정 파일 형식 검사")
    check_cmd.add_argument("file", type=Path)

    bank_args = argparse.ArgumentParser(add_help=False)
    bank_args.add_argument("--bank", type=Path, default=None)
    bank_args.add_argument("--banks-root", type=Path, default=Path(DEFAULT_BANKS_ROOT))
    bank_args.add_argument("--workspace", default=DEFAULT_WORKSPACE)
    bank_args.add_argument("--now", type=parse_now, default=None)

    snapshot_cmd = commands.add_parser("snapshot", parents=[bank_args], help="은행 스냅샷")
    snapshot_cmd.add_argument("--out-dir", type=Path, required=True)
    find_cmd = commands.add_parser("find", parents=[bank_args], help="교체 메모 id 찾기")
    find_cmd.add_argument("--since", type=parse_now, required=True)
    verify_cmd = commands.add_parser("verify", parents=[bank_args], help="반영 결과 검증")
    verify_cmd.add_argument("file", type=Path)
    verify_cmd.add_argument("--record", type=Path, default=None)
    args = parser.parse_args()
    try:
        if args.command == "check":
            return check(args.file)
        if args.command == "snapshot":
            return snapshot(args)
        if args.command == "find":
            return find(args)
        return verify(args)
    except (Failed, sqlite3.Error) as error:
        print(f"오류: {first_line(error)}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
