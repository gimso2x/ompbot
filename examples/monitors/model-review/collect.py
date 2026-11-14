#!/usr/bin/env python3
"""주간 모델 점검 수집기: '주간 모델 점검' 모니터가 매주 월요일 08:40(봇 시간대)에 한 번 실행한다.

지난 N일(기본 7일, 창 = [now - N일, now), 세션 레코드의 timestamp 기준) 모델 실측·폴백·현행 설정·
omp 카탈로그 변화를 읽기 전용으로 모아 마크다운으로 출력한다. 섹션 순서는 고정이다.
  1. 소스 상태: sessions·log(홈마다), omp-sessions, config, ompbot-config, db, catalog, catalog-prev, mcp-config
  2. 모델별 실측: assistant 메시지의 provider/model별 호출·비용(usage.cost.total)·출력 토큰·오류%
  3. 용도별: 세션 경로로 가른 용도(대화·omp직접·모니터·레인·리뷰·하위·기타)×모델
  4. 한도·폴백: <home>/logs/ompbot.log의 event=retry_fallback_applied, from → to 쌍(effort 뗌)
  5. MCP 호출: assistant toolCall 중 'mcp__<서버>_<도구>' 또는 write 'xd://mcp__<서버>_<도구>'의 서버·도구·용도별
     호출과 오류(같은 toolCallId의 toolResult isError). 정보 섹션 — 규칙 없음
  6. 현행 설정: omp config list --json의 modelRoles·retry.fallbackChains, <home>/config.json, DB monitors
  7. 카탈로그 변화: omp models ls --json과 직전 스냅샷(<state-dir>/catalog-<날짜>.json) 비교
  8. 규칙 판정: 아래 상수 문턱값으로 판정한 R1~R5 항목
못 읽은 소스는 '소스 상태'에 missing/error로 남기고 그 섹션은 '(소스 없음)' 한 줄로 낸다.
DB는 mode=ro로만 연다. 쓰는 파일은 <state-dir>/catalog-<YYYY-MM-DD>.json 하나뿐이다(--no-snapshot이면 없음).

입력: --home <dir>(기본 $OMPBOT_HOME), --extra-home <dir>(반복, 세션·로그만 합산),
      --allow-same-provider <provider>(반복, R4(b) 예외), --omp-sessions <dir>(기본 ~/.omp/agent/sessions),
      --state-dir <dir>(기본 <home>/workspace/model-review), --omp <path>(기본 omp),
      --now <ISO8601>(기본 현재 시각; 시간대 없으면 봇 시간대), --days N(기본 7), --no-snapshot,
      --mcp-config <file>(기본 ~/.omp/agent/mcp.json, mcpServers 키 = 서버 이름)
종료 코드: 0 = 출력함(소스 일부를 못 읽어도 0), 2 = 인자 오류
"""

import argparse
import datetime as dt
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import urllib.parse
from collections import Counter, defaultdict
from pathlib import Path
from zoneinfo import ZoneInfo

# 규칙 문턱값 (README '규칙 문턱값' 절과 같게 유지한다)
R2_FALLBACKS = 10  # 한 from 모델의 창 내 폴백 건수(홈 합산) 이상이면 R2
R2_ERROR_PCT = 3  # 한 모델 오류% 이상이면 R2 ...
R2_MIN_CALLS = 100  # ... 단 호출이 이 이상일 때만
R3_SHARE_PCT = 10  # 자동·보조 용도 하나의 비용 비중% 이상이면 R3
R5_PRICE_PCT = 20  # 현행 설정이 쓰는 모델의 input·output 단가 변동% 이상이면 R5 (카탈로그 단가 변동도 같은 값)

MAX_OUTPUT_CHARS = 20000
MAX_MODEL_ROWS = 40
MAX_R1_LINES = 20
CUT = "…(잘림)"
OMP_TIMEOUT_S = 120
USES = ["대화", "omp직접", "모니터", "레인", "리뷰", "하위", "기타"]
AUTO_USES = ("모니터", "레인", "리뷰", "하위")
CHAT_ORIGINS = ("discord", "slack", "telegram", "teams")
SNAPSHOT = re.compile(r"^catalog-(\d{4}-\d{2}-\d{2})\.json$")
LOG_FIELD = re.compile(r'(\w+)=("(?:[^"\\]|\\.)*"|\S*)')
HTTP_STATUS = re.compile(r"\b([45]\d\d)\b")
ERROR_CODE = re.compile(r'code\\*"?\s*:\s*\\*"?(\d+)')


def first_line(text: object) -> str:
    for line in str(text).splitlines():
        if line.strip():
            return line.strip()
    return ""


def bot_timezone(home: Path) -> dt.tzinfo:
    """봇 시간대: OMPBOT_TZ 환경 변수 → <home>/config.json의 timezone → 시스템 시간대."""
    name = os.environ.get("OMPBOT_TZ", "").strip()
    if not name:
        try:
            name = str(json.loads((home / "config.json").read_text(encoding="utf-8")).get("timezone") or "").strip()
        except (OSError, ValueError, AttributeError):
            name = ""
    return ZoneInfo(name) if name else dt.datetime.now().astimezone().tzinfo


def parse_now(value: str) -> dt.datetime:
    try:
        return dt.datetime.fromisoformat(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"ISO8601 시각이 아님: {value}") from error


def positive_int(value: str) -> int:
    try:
        number = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"정수가 아님: {value}") from error
    if number < 1:
        raise argparse.ArgumentTypeError(f"1 이상이어야 함: {value}")
    return number


def bare(model: str) -> str:
    """'provider/model:effort' → 'provider/model'."""
    return model.split(":", 1)[0].strip()


def pct(part: float, whole: float) -> float:
    return round(part * 100 / whole, 6) if whole else 0.0


def money(value: float) -> str:
    return f"{value:.2f}"


# ---- 세션 ----


class Usage:
    def __init__(self) -> None:
        self.calls = 0
        self.cost = 0.0
        self.output = 0
        self.errors = 0

    def add(self, cost: float, output: int, error: bool) -> None:
        self.calls += 1
        self.cost += cost
        self.output += output
        self.errors += 1 if error else 0


def origin_use(root: Path, dirpath: str) -> str:
    rel = os.path.relpath(dirpath, root)
    segment = rel.split(os.sep, 1)[0]
    if segment.startswith("ompbot%2Fwork%2F"):
        return "레인"
    head = urllib.parse.unquote(segment).split("/", 1)[0]
    if head == "monitor":
        return "모니터"
    if head == "review":
        return "리뷰"
    if head in CHAT_ORIGINS:
        return "대화"
    return "기타"


def scan_sessions(
    root: Path,
    direct: bool,
    start: dt.datetime,
    end: dt.datetime,
    by_model: dict[str, Usage],
    by_use: dict[tuple[str, str], Usage],
    mcp: "McpTally",
) -> str:
    """root 아래 jsonl을 전부 읽어 합산한다. 하위 = jsonl 파일명(확장자 제외)과 같은 이름 디렉터리 아래(깊이 무관)."""
    if not root.is_dir():
        return "missing"
    start_epoch = start.timestamp()
    files = records = 0
    under_sub: dict[str, bool] = {str(root): False}
    try:
        for dirpath, dirnames, filenames in os.walk(root, onerror=raise_error):
            sub = under_sub.pop(dirpath, False)
            stems = {name[:-6] for name in filenames if name.endswith(".jsonl")}
            for name in dirnames:
                under_sub[os.path.join(dirpath, name)] = sub or name in stems
            if not stems:
                continue
            use = "하위" if sub else ("omp직접" if direct else origin_use(root, dirpath))
            for name in filenames:
                if not name.endswith(".jsonl"):
                    continue
                path = os.path.join(dirpath, name)
                try:
                    if os.path.getmtime(path) < start_epoch:
                        continue
                    records += read_session(path, use, start, end, by_model, by_use, mcp)
                except FileNotFoundError:
                    continue  # 실행 중인 세션이 읽는 사이 옮겨졌다
                files += 1
    except OSError as error:
        return f"error: {first_line(error)}"
    return f"ok ({files}파일, 호출 {records})"


def raise_error(error: OSError) -> None:
    if not isinstance(error, FileNotFoundError):  # 읽는 사이 옮겨진 디렉터리는 건너뛴다
        raise error


def read_session(
    path: str,
    use: str,
    start: dt.datetime,
    end: dt.datetime,
    by_model: dict[str, Usage],
    by_use: dict[tuple[str, str], Usage],
    mcp: "McpTally",
) -> int:
    counted = 0
    calls: list[tuple[str, str, str]] = []  # (toolCallId, 서버, 도구) — 창 안 assistant toolCall만
    failed: set[str] = set()  # toolResult isError인 toolCallId
    with open(path, encoding="utf-8", errors="replace") as lines:
        for line in lines:
            if '"assistant"' not in line and '"isError":true' not in line:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if not isinstance(record, dict) or record.get("type") != "message":
                continue
            message = record.get("message")
            if not isinstance(message, dict):
                continue
            if message.get("role") == "toolResult":
                if message.get("isError") is True:
                    failed.add(str(message.get("toolCallId")))
                continue
            if message.get("role") != "assistant":
                continue
            try:
                at = dt.datetime.fromisoformat(str(record.get("timestamp", "")))
            except ValueError:
                continue
            if at.tzinfo is None or not start <= at < end:
                continue
            usage = message.get("usage") if isinstance(message.get("usage"), dict) else {}
            cost_block = usage.get("cost") if isinstance(usage.get("cost"), dict) else {}
            cost = float(cost_block.get("total") or 0)
            output = int(usage.get("output") or 0)
            model = f"{message.get('provider') or '?'}/{message.get('model') or '?'}"
            error = message.get("stopReason") == "error"
            by_model.setdefault(model, Usage()).add(cost, output, error)
            by_use.setdefault((use, model), Usage()).add(cost, output, error)
            counted += 1
            content = message.get("content")
            for block in content if isinstance(content, list) else []:
                if isinstance(block, dict) and block.get("type") == "toolCall" and (target := mcp.target(block)):
                    calls.append((str(block.get("id")), *target))
    for call_id, server, tool in calls:
        mcp.add(use, server, tool, call_id in failed)
    return counted


class McpTally:
    """MCP 호출 집계. 서버 이름은 MCP 설정의 서버 키로 가르고, 맞는 키가 없으면 'mcp__' 뒤 첫 '_' 앞까지."""

    def __init__(self, servers: list[str]) -> None:
        self.servers = sorted(servers, key=len, reverse=True)  # 긴 키 먼저(접두어가 겹치는 서버 이름)
        self.by_tool: dict[tuple[str, str], list[int]] = {}
        self.by_use: dict[tuple[str, str], list[int]] = {}

    def target(self, block: dict) -> tuple[str, str] | None:
        name = str(block.get("name") or "")
        if name == "write":
            arguments = block.get("arguments")
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except ValueError:
                    return None
            path = str(arguments.get("path") or "") if isinstance(arguments, dict) else ""
            name = path[len("xd://") :] if path.startswith("xd://mcp__") else ""
        if not name.startswith("mcp__"):
            return None
        rest = name[len("mcp__") :]
        for server in self.servers:
            if rest.startswith(server + "_"):
                return server, rest[len(server) + 1 :]
        server, _, tool = rest.partition("_")
        return server, tool

    def add(self, use: str, server: str, tool: str, error: bool) -> None:
        for counts in (self.by_tool.setdefault((server, tool), [0, 0]), self.by_use.setdefault((use, server), [0, 0])):
            counts[0] += 1
            counts[1] += 1 if error else 0

    def section(self, sessions_read: bool) -> str:
        lines = ["## MCP 호출"]
        if not sessions_read:
            return "\n".join([*lines, "(소스 없음)"])
        lines += ["| 서버 | 도구 | 호출 | 오류 |", "|---|---|---|---|"]
        totals: dict[str, list[int]] = {server: [0, 0] for server in self.servers}
        for (server, tool), (calls, errors) in sorted(self.by_tool.items(), key=lambda item: (-item[1][0], item[0])):
            lines.append(f"| {server} | {tool} | {calls} | {errors} |")
            total = totals.setdefault(server, [0, 0])
            total[0] += calls
            total[1] += errors
        lines += [f"| {server} | - | 0 | 0 |" for server in sorted(totals) if totals[server][0] == 0]
        lines.append("### 서버별 합계")
        ranked = sorted(totals.items(), key=lambda item: (-item[1][0], item[0]))
        lines += [f"- {server}: 호출 {calls} · 오류 {errors}" for server, (calls, errors) in ranked] or ["- MCP 서버·호출 없음"]
        lines += ["### 용도별", "| 용도 | 서버 | 호출 | 오류 |", "|---|---|---|---|"]
        for (use, server), (calls, errors) in sorted(self.by_use.items(), key=lambda item: (USES.index(item[0][0]), -item[1][0], item[0][1])):
            lines.append(f"| {use} | {server} | {calls} | {errors} |")
        return "\n".join(lines)


def mcp_servers(path: Path) -> tuple[str, list[str]]:
    if not path.is_file():
        return "missing", []
    try:
        servers = json.loads(path.read_text(encoding="utf-8")).get("mcpServers")
    except (OSError, ValueError, AttributeError) as error:
        return f"error: {first_line(error)}", []
    if not isinstance(servers, dict):
        return "error: mcpServers 객체가 없음", []
    return f"ok ({len(servers)}개 서버)", [str(name) for name in servers]


def models_section(by_model: dict[str, Usage], sessions_read: bool) -> str:
    lines = ["## 모델별 실측"]
    if not by_model:
        return "\n".join([*lines, "- 창 안 호출 없음" if sessions_read else "(소스 없음)"])
    lines += ["| 모델 | 호출 | 비용$ | 출력토큰 | 오류% |", "|---|---|---|---|---|"]
    ranked = sorted(by_model.items(), key=lambda item: (-item[1].cost, -item[1].calls, item[0]))
    for model, usage in ranked[:MAX_MODEL_ROWS]:
        error = pct(usage.errors, usage.calls)
        lines.append(f"| {model} | {usage.calls} | {money(usage.cost)} | {usage.output} | {error:.2f} |")
    if len(ranked) > MAX_MODEL_ROWS:
        lines.append(f"- 외 {len(ranked) - MAX_MODEL_ROWS}개 모델")
    return "\n".join(lines)


def uses_section(by_use: dict[tuple[str, str], Usage], total: float, sessions_read: bool) -> str:
    lines = ["## 용도별"]
    if not by_use:
        return "\n".join([*lines, "- 창 안 호출 없음" if sessions_read else "(소스 없음)"])
    lines += ["| 용도 | 모델 | 호출 | 비용$ | 비중% | 오류% |", "|---|---|---|---|---|---|"]
    ranked = sorted(by_use.items(), key=lambda item: (USES.index(item[0][0]), -item[1].cost, item[0][1]))
    for (use, model), usage in ranked:
        share, error = pct(usage.cost, total), pct(usage.errors, usage.calls)
        lines.append(f"| {use} | {model} | {usage.calls} | {money(usage.cost)} | {share:.1f} | {error:.2f} |")
    return "\n".join(lines)


# ---- 로그 ----


def reason_summary(reason: str) -> str:
    parts: list[str] = []
    status = HTTP_STATUS.search(reason)
    if status:
        parts.append(status.group(1))
    if "rate_limit" in reason:
        parts.append("rate_limit")
    code = ERROR_CODE.search(reason)
    if code:
        parts.append(f"code {code.group(1)}")
    return " ".join(parts) or "기타"


def scan_log(home: Path, start: dt.datetime, end: dt.datetime) -> tuple[str, dict[tuple[str, str], Counter] | None]:
    path = home / "logs" / "ompbot.log"
    if not path.is_file():
        return "missing", None
    pairs: dict[tuple[str, str], Counter] = {}
    try:
        with path.open(encoding="utf-8", errors="replace") as log:
            for line in log:
                if "event=retry_fallback_applied" not in line:
                    continue
                fields = {key: value.strip('"') for key, value in LOG_FIELD.findall(line)}
                if fields.get("event") != "retry_fallback_applied":
                    continue
                try:
                    at = dt.datetime.fromisoformat(fields.get("ts", ""))
                except ValueError:
                    continue
                if at.tzinfo is None or not start <= at < end:
                    continue
                pair = (bare(fields.get("from", "?")), bare(fields.get("to", "?")))
                pairs.setdefault(pair, Counter())[reason_summary(fields.get("reason", ""))] += 1
    except OSError as error:
        return f"error: {first_line(error)}", None
    return "ok", pairs


def fallback_lines(pairs: dict[tuple[str, str], Counter]) -> list[str]:
    if not pairs:
        return ["- 창 안 폴백 없음"]
    lines: list[str] = []
    for (src, dst), reasons in sorted(pairs.items(), key=lambda item: (-sum(item[1].values()), item[0])):
        detail = ", ".join(f"{reason} ×{count}" for reason, count in sorted(reasons.items(), key=lambda r: (-r[1], r[0])))
        lines.append(f"- {src} → {dst}: {sum(reasons.values())}건 (사유: {detail})")
    return lines


def fallbacks_section(per_home: list[tuple[Path, dict[tuple[str, str], Counter] | None]]) -> tuple[str, Counter]:
    lines = ["## 한도·폴백"]
    readable = [(home, pairs) for home, pairs in per_home if pairs is not None]
    by_from: Counter = Counter()
    if not readable:
        return "\n".join([*lines, "(소스 없음)"]), by_from
    total: dict[tuple[str, str], Counter] = {}
    for home, pairs in readable:
        lines.append(f"### {home}")
        lines.extend(fallback_lines(pairs))
        for pair, reasons in pairs.items():
            total.setdefault(pair, Counter()).update(reasons)
            by_from[pair[0]] += sum(reasons.values())
    lines.append("### 합계")
    lines.extend(fallback_lines(total))
    return "\n".join(lines), by_from


# ---- omp·설정·DB ----


def run_omp(omp: str, args: list[str]) -> tuple[str, object]:
    try:
        run = subprocess.run([omp, *args], capture_output=True, text=True, timeout=OMP_TIMEOUT_S)
    except (OSError, subprocess.SubprocessError) as error:
        return f"error: {first_line(error)}", None
    if run.returncode != 0:
        return f"error: exit {run.returncode} {first_line(run.stderr)}".rstrip(), None
    try:
        return "ok", json.loads(run.stdout)
    except ValueError as error:
        return f"error: JSON 아님 ({first_line(error)})", None


def omp_config(omp: str) -> tuple[str, dict[str, str], dict[str, list[str]]]:
    status, data = run_omp(omp, ["config", "list", "--json"])
    if not isinstance(data, dict):
        return status if data is None else "error: 객체가 아님", {}, {}
    roles = (data.get("modelRoles") or {}).get("value") or {}
    chains = (data.get("retry.fallbackChains") or {}).get("value") or {}
    if not isinstance(roles, dict) or not isinstance(chains, dict):
        return "error: modelRoles·retry.fallbackChains 형식이 아님", {}, {}
    return status, {str(k): str(v or "") for k, v in roles.items()}, {str(k): [str(x) for x in v or []] for k, v in chains.items()}


def omp_catalog(omp: str) -> tuple[str, dict[str, dict] | None]:
    status, data = run_omp(omp, ["models", "ls", "--json"])
    models = data.get("models") if isinstance(data, dict) else None
    if not isinstance(models, list):
        return (status if data is None else "error: models 배열이 없음"), None
    catalog: dict[str, dict] = {}
    for model in models:
        if not isinstance(model, dict):
            continue
        selector = str(model.get("selector") or f"{model.get('provider')}/{model.get('id')}")
        cost = model.get("cost") if isinstance(model.get("cost"), dict) else {}
        catalog[selector] = {
            "provider": str(model.get("provider") or selector.split("/", 1)[0]),
            "kind": str(model.get("kind") or ""),
            "input": float(cost.get("input") or 0),
            "output": float(cost.get("output") or 0),
        }
    return f"ok ({len(catalog)}개)", catalog


def ompbot_config(home: Path) -> tuple[str, dict]:
    path = home / "config.json"
    if not path.is_file():
        return "missing", {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        return f"error: {first_line(error)}", {}
    return ("ok", data) if isinstance(data, dict) else ("error: 객체가 아님", {})


def db_monitors(home: Path) -> tuple[str, list[tuple[str, str | None, str | None]]]:
    path = home / "ompbot.db"
    if not path.is_file():
        return "missing", []
    try:
        db = sqlite3.connect(f"file:{urllib.parse.quote(str(path))}?mode=ro", uri=True)
        try:
            rows = db.execute("SELECT name, model, thinking FROM monitors ORDER BY name").fetchall()
        finally:
            db.close()
    except sqlite3.Error as error:
        return f"error: {first_line(error)}", []
    return "ok", rows


def settings_section(
    roles: dict[str, str], chains: dict[str, list[str]], config_ok: bool, ompbot: dict, ompbot_ok: bool,
    monitors: list[tuple[str, str | None, str | None]], db_ok: bool,
) -> str:
    rows: list[tuple[str, str]] = []
    if config_ok:
        rows += [(f"modelRoles.{key}", value) for key, value in sorted(roles.items())]
        rows += [(f"fallbackChains.{key}", json.dumps(value, ensure_ascii=False)) for key, value in sorted(chains.items())]
    if ompbot_ok:
        rows += [("ompbot.model", str(ompbot.get("model") or "(없음)")), ("ompbot.thinking", str(ompbot.get("thinking") or "(없음)"))]
    if db_ok:
        rows += [(f"monitor.{name}", f"{model or '(봇 기본)'} · {thinking or '(봇 기본)'}") for name, model, thinking in monitors]
    lines = ["## 현행 설정"]
    if not rows:
        return "\n".join([*lines, "(소스 없음)"])
    lines += ["| 항목 | 값 |", "|---|---|"]
    lines += [f"| {key} | {value.replace('|', '/')} |" for key, value in rows]
    return "\n".join(lines)


# ---- 카탈로그 ----


def latest_snapshot(state_dir: Path, today: dt.date) -> tuple[str, Path | None]:
    if not state_dir.is_dir():
        return "missing", None
    try:
        found = sorted(
            (match.group(1), path)
            for path in state_dir.iterdir()
            if path.is_file() and (match := SNAPSHOT.match(path.name)) and match.group(1) < today.isoformat()
        )
    except OSError as error:
        return f"error: {first_line(error)}", None
    return (found[-1][1].name, found[-1][1]) if found else ("missing", None)


def write_snapshot(state_dir: Path, today: dt.date, catalog: dict[str, dict]) -> None:
    state_dir.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=state_dir, prefix=".catalog-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(catalog, out, ensure_ascii=False, sort_keys=True)
        os.replace(temp, state_dir / f"catalog-{today.isoformat()}.json")
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise


def price_change(old: dict, new: dict) -> str | None:
    """input·output 중 하나라도 R5_PRICE_PCT% 이상 바뀌었으면 설명 문자열."""
    changed: list[str] = []
    for key in ("input", "output"):
        before, after = float(old.get(key) or 0), float(new.get(key) or 0)
        if before == after:
            continue
        delta = pct(abs(after - before), before) if before else float("inf")
        if delta >= R5_PRICE_PCT:
            changed.append(f"{key} {before:g}→{after:g}")
    return ", ".join(changed) or None


def used_models(roles: dict[str, str], chains: dict[str, list[str]], ompbot: dict, monitors: list) -> set[str]:
    used = {bare(v) for v in roles.values() if v}
    for key, chain in chains.items():
        if "/" in key:
            used.add(bare(key))
        used.update(bare(v) for v in chain if v)
    if ompbot.get("model"):
        used.add(bare(str(ompbot["model"])))
    used.update(bare(model) for _, model, _ in monitors if model)
    return used


# ---- 규칙 ----


def rule_r4(roles: dict[str, str], chains: dict[str, list[str]], allowed: set[str]) -> list[str]:
    lines: list[str] = []
    for key, chain in sorted(chains.items()):
        if "/" in key:
            primary = bare(key)
        else:
            primary = bare(roles.get(key) or "")
            if not primary:
                lines.append(f"[R4] {key} — 역할 미정의")
                continue
        if not chain:
            continue
        first = bare(chain[0])
        raw = f"주 모델 {primary}, 첫 폴백 {chain[0]}"
        if first == primary:
            lines.append(f"[R4] {key} — 같은 모델의 effort 변형 ({raw})")
        elif first.split("/", 1)[0] == primary.split("/", 1)[0] and primary.split("/", 1)[0] not in allowed:
            lines.append(f"[R4] {key} — 같은 공급자의 다른 모델 ({raw})")
    return lines


def main() -> int:
    parser = argparse.ArgumentParser(description="주간 모델 점검 수집기 (읽기 전용, 카탈로그 스냅샷만 씀)")
    parser.add_argument("--home", type=Path, default=os.environ.get("OMPBOT_HOME") or None)
    parser.add_argument("--extra-home", type=Path, action="append", default=[])
    parser.add_argument("--allow-same-provider", action="append", default=[])
    parser.add_argument("--omp-sessions", type=Path, default=Path.home() / ".omp" / "agent" / "sessions")
    parser.add_argument("--state-dir", type=Path, default=None)
    parser.add_argument("--omp", default="omp")
    parser.add_argument("--now", type=parse_now, default=None)
    parser.add_argument("--days", type=positive_int, default=7)
    parser.add_argument("--no-snapshot", action="store_true")
    parser.add_argument("--mcp-config", type=Path, default=Path.home() / ".omp" / "agent" / "mcp.json")
    args = parser.parse_args()
    if args.home is None:
        parser.error("--home이 없고 OMPBOT_HOME도 없음")
    home: Path = Path(args.home).expanduser()
    tz = bot_timezone(home)
    now = args.now or dt.datetime.now(tz)
    now = now.replace(tzinfo=tz) if now.tzinfo is None else now
    start = now - dt.timedelta(days=args.days)
    today = now.astimezone(tz).date()
    state_dir: Path = (args.state_dir or home / "workspace" / "model-review").expanduser()
    homes = [home, *(Path(extra).expanduser() for extra in args.extra_home)]
    multi = len(homes) > 1

    status: dict[str, str] = {}
    by_model: dict[str, Usage] = {}
    by_use: dict[tuple[str, str], Usage] = {}
    mcp_status, servers = mcp_servers(args.mcp_config.expanduser())
    mcp = McpTally(servers)
    for each in homes:
        label = f"sessions[{each}]" if multi else "sessions"
        status[label] = scan_sessions(each / "sessions", False, start, now, by_model, by_use, mcp)
    status["omp-sessions"] = scan_sessions(args.omp_sessions.expanduser(), True, start, now, by_model, by_use, mcp)
    sessions_read = any(value.startswith("ok") for value in status.values())
    per_home_logs = []
    for each in homes:
        log_status, pairs = scan_log(each, start, now)
        status[f"log[{each}]" if multi else "log"] = log_status
        per_home_logs.append((each, pairs))

    status["config"], roles, chains = omp_config(args.omp)
    status["ompbot-config"], ompbot = ompbot_config(home)
    status["db"], monitors = db_monitors(home)
    status["catalog"], catalog = omp_catalog(args.omp)
    status["catalog-prev"], prev_path = latest_snapshot(state_dir, today)
    previous: dict[str, dict] | None = None
    if prev_path is not None:
        try:
            loaded = json.loads(prev_path.read_text(encoding="utf-8"))
            previous = loaded if isinstance(loaded, dict) else None
            if previous is None:
                status["catalog-prev"] = f"error: {prev_path.name} 객체가 아님"
        except (OSError, ValueError) as error:
            status["catalog-prev"] = f"error: {first_line(error)}"
    status["mcp-config"] = mcp_status
    if catalog is not None and not args.no_snapshot:
        try:
            write_snapshot(state_dir, today, catalog)
        except OSError as error:
            status["catalog"] += f" (스냅샷 저장 실패: {first_line(error)})"

    total_cost = sum(usage.cost for usage in by_model.values())
    fallback_text, by_from = fallbacks_section(per_home_logs)
    used = used_models(roles, chains, ompbot, monitors)
    used_providers = {model.split("/", 1)[0] for model in used}
    rules: list[str] = []

    # 카탈로그 변화 + R1·R5
    catalog_lines = ["## 카탈로그 변화"]
    if catalog is None:
        catalog_lines.append("(소스 없음)")
    elif previous is None:
        catalog_lines.append("- 기준 스냅샷 저장(비교 없음)" if not args.no_snapshot else "- 직전 스냅샷 없음(비교 없음, 저장 안 함)")
    else:
        new = sorted(m for m in catalog if m not in previous and catalog[m]["provider"] in used_providers)
        gone = sorted(m for m in previous if m not in catalog)
        repriced = [(m, change) for m in sorted(catalog) if m in previous and (change := price_change(previous[m], catalog[m]))]
        catalog_lines.append(f"- 신규(현행 공급자): {', '.join(new) if new else '없음'}")
        catalog_lines.append(f"- 사라짐: {', '.join(gone) if gone else '없음'}")
        catalog_lines.append(f"- 단가 변동(±{R5_PRICE_PCT}%): " + ("없음" if not repriced else ""))
        catalog_lines.extend(f"  - {m}: {change}" for m, change in repriced)
        new_chat = [m for m in new if catalog[m]["kind"] == "chat"]
        rules.extend(f"[R1] {m} — 신규 chat 모델 (공급자 {catalog[m]['provider']})" for m in new_chat[:MAX_R1_LINES])
        if len(new_chat) > MAX_R1_LINES:
            rules.append(f"[R1] 외 {len(new_chat) - MAX_R1_LINES}개 — 카탈로그 변화 절 참고")
        rules.extend(f"[R5] {m} — 단가 {change}" for m, change in repriced if m in used)

    # R2
    for model, count in sorted(by_from.items(), key=lambda item: (-item[1], item[0])):
        if count >= R2_FALLBACKS:
            rules.append(f"[R2] {model} — 폴백 {count}건 (홈 합산, 창 {args.days}일)")
    for model, usage in sorted(by_model.items()):
        if usage.calls >= R2_MIN_CALLS and pct(usage.errors, usage.calls) >= R2_ERROR_PCT:
            rules.append(f"[R2] {model} — 오류 {pct(usage.errors, usage.calls):.2f}% ({usage.errors}/{usage.calls})")
    # R3
    use_cost: dict[str, float] = defaultdict(float)
    use_models: dict[str, list[str]] = defaultdict(list)
    for (use, model), usage in sorted(by_use.items(), key=lambda item: -item[1].cost):
        use_cost[use] += usage.cost
        use_models[use].append(f"{model} {money(usage.cost)}$")
    for use in AUTO_USES:
        share = pct(use_cost.get(use, 0.0), total_cost)
        if use in use_cost and share >= R3_SHARE_PCT:
            rules.append(f"[R3] {use} — 비중 {share:.1f}% ({', '.join(use_models[use][:5])})")
    # R4
    if status["config"] == "ok":
        rules.extend(rule_r4(roles, chains, set(args.allow_same_provider)))
    rules.sort(key=lambda line: line[:4])

    window = f"{start.astimezone(tz):%Y-%m-%d %H:%M} ~ {now.astimezone(tz):%Y-%m-%d %H:%M %Z}"
    head = "\n".join(["## 소스 상태", f"- 창: {window}", *(f"- {name}: {value}" for name, value in status.items())])
    middle = [
        uses_section(by_use, total_cost, sessions_read),
        fallback_text,
        mcp.section(sessions_read),
        settings_section(
            roles, chains, status["config"] == "ok", ompbot, status["ompbot-config"] == "ok", monitors, status["db"] == "ok"
        ),
        "\n".join(catalog_lines),
    ]
    tail = "\n".join(["## 규칙 판정", *(f"- {line}" for line in rules)] if rules else ["## 규칙 판정", "걸린 항목 없음"])
    front = "\n\n".join([head, models_section(by_model, sessions_read)])
    body = "\n\n".join(middle)
    if len(front) + len(body) + len(tail) + 4 > MAX_OUTPUT_CHARS:
        budget = MAX_OUTPUT_CHARS - len(tail) - len(CUT) - 6
        joined = front + "\n\n" + body
        output = joined[: max(0, budget)] + "\n" + CUT + "\n\n" + tail + "\n"
    else:
        output = "\n\n".join([front, body, tail]) + "\n"
    sys.stdout.write(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
