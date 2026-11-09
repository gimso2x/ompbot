#!/usr/bin/env python3
"""기억 교정 수집기: '기억 교정' 모니터가 매주 일요일 05:00 KST에 한 번 실행한다.

ompbot 세션이 쓰는 Mnemopi 은행(mnemopi.db)을 읽기 전용으로 열어 교정할 기억을 마크다운으로
출력한다. 섹션 순서는 고정이다.
  1. 소스 상태: 은행 경로와 이름, state ok/missing/error
  2. 지표: working·episodic 전체/유효/무효화/회상>0 수, 분류별 유효 수, 검사 안 한 claim 중 회상>0 수,
     facts subject version·iso_date 수(보고만)
  3. 잡음: 유효 noise-monitor 행(모니터 턴 기록) 전부, 최대 10개, 회상 내림차순
  4. 후보: 유효 claim 행 중 --recheck-days 안에 같은 내용으로 검사한 기록이 state에 없는 것,
     회상 내림차순·timestamp 오름차순 상위 --limit개와 미리보기(주입된 회상 제거, 토큰 가림)
유효 = (valid_until IS NULL OR valid_until > now) AND superseded_by IS NULL (Mnemopi 회상과 같은 조건).
은행을 못 찾거나 못 열면 '소스 상태'에 missing/error만 쓴다. DB는 mode=ro로만 열고 어떤 파일도 쓰지 않는다.

입력: --bank <mnemopi.db> 또는 --banks-root <dir>(기본 ~/.omp/agent/memories/mnemopi/banks)와
      --workspace <dir>(기본 ~/.ompbot/workspace; metadata_json cwd가 이 경로인 working 행이 가장 많은 은행),
      --state <json>(기본 ~/.ompbot/workspace/memory-audit/state.json), --limit N(기본 30, 1..40),
      --recheck-days N(기본 30), --now <ISO8601>(기본 현재 시각; 시간대 없으면 KST)
종료 코드: 0 = 출력함(은행을 못 찾거나 못 열어도 0), 2 = 인자 오류
"""

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sqlite3
import sys
import urllib.parse
from pathlib import Path
from zoneinfo import ZoneInfo

KST = ZoneInfo("Asia/Seoul")
UTC = dt.timezone.utc
DEFAULT_BANKS_ROOT = "~/.omp/agent/memories/mnemopi/banks"
DEFAULT_WORKSPACE = "~/.ompbot/workspace"
DEFAULT_STATE = "~/.ompbot/workspace/memory-audit/state.json"
MAX_NOISE = 10
MAX_LIMIT = 40
PREVIEW_CHARS = 1500
MAX_OUTPUT_CHARS = 50000
CUT = "…(잘림)"
NOISE_HEAD_CHARS = 300
ROLE_USER = "[role: user]"
CURRENT_REQUEST = re.compile(r"^\[현재 요청\]", re.M)
SECRET = re.compile(r"xox[a-z]-\S+|xapp-\S+|sk-\S+")


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


def bounded_int(low: int, high: int | None):
    def parse(value: str) -> int:
        try:
            number = int(value)
        except ValueError as error:
            raise argparse.ArgumentTypeError(f"정수가 아님: {value}") from error
        if number < low or (high is not None and number > high):
            raise argparse.ArgumentTypeError(f"{low}..{high if high is not None else ''} 범위가 아님: {value}")
        return number

    return parse


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


def kst_minute(value: object) -> str:
    parsed = parse_time(value)
    return parsed.astimezone(KST).strftime("%Y-%m-%d %H:%M") if parsed else str(value)


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


def is_noise(content: str, source: object) -> bool:
    """모니터 턴 기록: 첫 사용자 메시지가 '[모니터 '로 시작하고 앞 300자 안에 '예약된 자동 실행'이 있는 transcript."""
    if source != "coding-agent-transcript":
        return False
    head = content[:NOISE_HEAD_CHARS]
    at = head.find(ROLE_USER)
    if at < 0:
        return False
    first = head[at + len(ROLE_USER) :].lstrip()
    return first.startswith("[모니터 ") and "예약된 자동 실행" in first


def preview(content: str) -> str:
    """주입된 회상(첫 [role: user] 다음부터 [현재 요청] 줄 앞까지)을 빼고, 토큰을 가리고, 1500자로 자른다."""
    at = content.find(ROLE_USER)
    if at >= 0:
        request = CURRENT_REQUEST.search(content, at)
        if request:
            content = content[: at + len(ROLE_USER)] + "\n" + content[request.start() :]
    content = SECRET.sub("***", content.strip())
    return content if len(content) <= PREVIEW_CHARS else content[:PREVIEW_CHARS] + CUT


def load_state(path: Path) -> tuple[dict, str]:
    if not path.is_file():
        return {}, "missing"
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        return {}, f"error: {first_line(error)}"
    if not isinstance(state, dict):
        return {}, "error: JSON 객체가 아님"
    return state, "ok"


def recently_audited(state: dict, memory_id: str, content: str, now: dt.datetime, days: int) -> bool:
    entry = state.get(memory_id)
    if not isinstance(entry, dict):
        return False
    if entry.get("sha256") != hashlib.sha256(content.encode("utf-8")).hexdigest():
        return False
    audited = parse_time(entry.get("audited_at"))
    return audited is not None and now - audited < dt.timedelta(days=days)


def collect(db: sqlite3.Connection, args: argparse.Namespace, now: dt.datetime) -> tuple[str, str, str, str]:
    """(state 상태, 지표, 잡음, 후보) 섹션."""
    state, state_status = load_state(args.state.expanduser())
    memories = []
    tables = {"working": "working_memory", "episodic": "episodic_memory"}
    for kind, table in tables.items():
        source = "source" if kind == "working" else "NULL"
        for memory_id, content, src, timestamp, recall, until, superseded in db.execute(
            f"SELECT id, content, {source}, timestamp, recall_count, valid_until, superseded_by FROM {table}"
        ):
            content = content or ""
            memories.append(
                {
                    "id": memory_id,
                    "kind": kind,
                    "content": content,
                    "timestamp": timestamp,
                    "recall": recall or 0,
                    "valid": is_valid(until, superseded, now),
                    "noise": kind == "working" and is_noise(content, src),
                }
            )

    lines = ["## 지표"]
    for kind in tables:
        rows = [m for m in memories if m["kind"] == kind]
        valid = sum(m["valid"] for m in rows)
        recalled = sum(m["recall"] > 0 for m in rows)
        lines.append(f"- {kind}: 전체 {len(rows)} · 유효 {valid} · 무효화 {len(rows) - valid} · 회상>0 {recalled}")
    noise = sorted((m for m in memories if m["valid"] and m["noise"]), key=lambda m: (-m["recall"], str(m["timestamp"])))
    claims = [m for m in memories if m["valid"] and not m["noise"]]
    unaudited = [
        m for m in claims if not recently_audited(state, m["id"], m["content"], now, args.recheck_days)
    ]
    lines.append(f"- 유효 분류: noise-monitor {len(noise)} · claim {len(claims)}")
    lines.append(f"- 검사 안 한 유효 claim 중 회상>0: {sum(m['recall'] > 0 for m in unaudited)}")
    try:
        facts = dict(
            db.execute(
                "SELECT subject, COUNT(*) FROM facts WHERE subject IN ('version','iso_date') GROUP BY subject"
            ).fetchall()
        )
        lines.append(f"- facts subject(보고만): version {facts.get('version', 0)} · iso_date {facts.get('iso_date', 0)}")
    except sqlite3.Error as error:
        lines.append(f"- facts: error: {first_line(error)}")

    noise_lines = ["## 잡음"]
    noise_lines.extend(f"- {m['id']} · 회상 {m['recall']} · {kst_minute(m['timestamp'])}" for m in noise[:MAX_NOISE])
    if len(noise_lines) == 1:
        noise_lines.append("잡음 없음")

    unaudited.sort(key=lambda m: (-m["recall"], parse_time(m["timestamp"]) or dt.datetime.max.replace(tzinfo=UTC)))
    blocks = [
        f"### {m['id']} · {m['kind']} · 회상 {m['recall']} · {kst_minute(m['timestamp'])}\n{preview(m['content'])}"
        for m in unaudited[: args.limit]
    ]
    return state_status, "\n".join(lines), "\n".join(noise_lines), blocks


def main() -> int:
    parser = argparse.ArgumentParser(description="기억 교정 수집기 (읽기 전용)")
    parser.add_argument("--bank", type=Path, default=None)
    parser.add_argument("--banks-root", type=Path, default=Path(DEFAULT_BANKS_ROOT))
    parser.add_argument("--workspace", default=DEFAULT_WORKSPACE)
    parser.add_argument("--state", type=Path, default=Path(DEFAULT_STATE))
    parser.add_argument("--limit", type=bounded_int(1, MAX_LIMIT), default=30)
    parser.add_argument("--recheck-days", type=bounded_int(1, None), default=30)
    parser.add_argument("--now", type=parse_now, default=None)
    args = parser.parse_args()
    now = args.now or dt.datetime.now(KST)

    bank = find_bank(args.bank, args.banks_root, args.workspace)
    if bank is None:
        sys.stdout.write("## 소스 상태\n- 은행: missing\n")
        return 0
    try:
        db = open_ro(bank)
        try:
            state_status, metrics, noise, blocks = collect(db, args, now)
        finally:
            db.close()
    except sqlite3.Error as error:
        sys.stdout.write(f"## 소스 상태\n- 은행: error: {first_line(error)}\n")
        return 0

    head = "\n".join(
        [
            "## 소스 상태",
            f"- 은행: {bank} ({bank.parent.name})",
            f"- state: {state_status}",
            f"- 기준 시각: {now.astimezone(KST):%Y-%m-%d %H:%M} KST",
        ]
    )
    fixed = "\n\n".join([head, metrics, noise, "## 후보"])
    if not blocks:
        sys.stdout.write(fixed + "\n후보 없음\n")
        return 0
    kept = list(blocks)
    while True:
        dropped = len(blocks) - len(kept)
        tail = [f"…(잘림: 후보 {dropped}개 생략)"] if dropped else []
        output = fixed + "\n" + "\n\n".join(kept + tail) + "\n"
        if len(output) <= MAX_OUTPUT_CHARS or len(kept) <= 1:
            break
        kept.pop()
    sys.stdout.write(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
