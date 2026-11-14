# 주간 모델 점검 (model-review)

매주 월요일 08:40(봇 시간대) 모니터 하나가 지난 7일 모델 실측(호출·비용·오류)·폴백·현행 설정·omp 카탈로그 변화를 결정적으로 모으고, 규칙 R1~R5에 걸린 항목만 근거와 함께 "모델 체계 변경 제안" 최대 5건으로 오너에게 올린다. 반영은 하지 않는다. 형식 게이트를 통과하지 못한 보고는 경고와 함께 올라간다.

## 파일과 설치 경로

| 저장소 파일 | 설치 경로 |
|---|---|
| `collect.py` | `<OMPBOT_HOME>/scripts/model-review-collect.py` |
| `review.py` | `<OMPBOT_HOME>/scripts/model-review.py` |
| `procedure.md` | `<OMPBOT_HOME>/scripts/model-review-procedure.md` |
| `monitor.json` | `monitors add --json` 입력 |

파이썬 표준 라이브러리만 쓴다(python3, `zoneinfo`). 실행 계정에서 `omp`가 PATH에 있어야 한다(없으면 `--omp <경로>`를 `@COLLECT_ARGS@`에 넣는다).

## 설치

저장소 루트에서, `H`에 봇 홈을 넣고 `ARGS`에 수집기 추가 인자를 넣는다.

```
H=<봇 홈>
ARGS=""   # 오너 설치 예: ARGS="--extra-home <피어 홈> --allow-same-provider zai"
mkdir -p "$H/scripts"
cp examples/monitors/model-review/collect.py "$H/scripts/model-review-collect.py"
cp examples/monitors/model-review/review.py "$H/scripts/model-review.py"
sed -e "s|@OMPBOT_HOME@|$H|g" -e "s|@COLLECT_ARGS@|$ARGS|g" examples/monitors/model-review/procedure.md > "$H/scripts/model-review-procedure.md"
bun src/main.ts monitors add --json "$(sed -e "s|@OMPBOT_HOME@|$H|g" examples/monitors/model-review/monitor.json)"
```

- `@COLLECT_ARGS@`(기본 빈 문자열): `--extra-home <피어 봇 홈>`(반복, 피어 봇의 세션·로그만 합산), `--allow-same-provider <공급자>`(반복, R4(b) 예외 — 같은 공급자 안 폴백을 의도한 경우), `--omp-sessions <dir>`, `--omp <path>`.
- 모델은 정하지 않는다(`monitor.json`에 `model` 칸이 없어 봇 기본 모델로 돈다). 오너 환경 모델로 고정하려면 설치 뒤 `bun src/main.ts monitors update <id> --json '<JSON>'`에 `model` 키 하나만 담아 덮어쓴다(고정 모델은 폴백이 없으니 한도에 걸리면 그 회차가 멈춘다).

## 수동 실행

```
python3 "$H/scripts/model-review-collect.py" --home "$H" --no-snapshot      # 스냅샷을 쓰지 않고 보기만
python3 "$H/scripts/model-review.py" check <보고 파일> --collect <수집 파일>
```

수집기 인자: `--home`(기본 `$OMPBOT_HOME`, 둘 다 없으면 exit 2), `--extra-home`, `--allow-same-provider`, `--omp-sessions`(기본 `~/.omp/agent/sessions`), `--state-dir`(기본 `<home>/workspace/model-review`), `--omp`, `--now <ISO8601>`, `--days N`(기본 7), `--no-snapshot`, `--mcp-config <file>`(기본 `~/.omp/agent/mcp.json`). 못 읽은 소스는 `## 소스 상태`에 `missing`/`error`로 남고 exit 0이다. DB는 읽기 전용으로 열고, 쓰는 파일은 `<state-dir>/catalog-<YYYY-MM-DD>.json` 하나뿐이다(같은 날 재실행은 덮어씀). 첫 회차는 비교할 스냅샷이 없어 `catalog-prev: missing`, `기준 스냅샷 저장(비교 없음)`이 정상이다.

용도는 세션 경로 첫 세그먼트로 가른다: `monitor` 모니터, `ompbot%2Fwork%2F` 레인, `review` 리뷰, `discord`·`slack`·`telegram`·`teams` 대화, 그 밖 기타, `--omp-sessions` 아래는 omp직접. jsonl 파일명(확장자 제외)과 같은 이름 디렉터리 아래의 jsonl은 깊이와 관계없이 하위로 먼저 판정한다.

`## MCP 호출`은 정보 섹션이다(규칙 없음, 제안 근거로 쓰지 않음). assistant 메시지의 toolCall 중 이름이 `mcp__<서버>_<도구>`인 것과 `write`의 `path`가 `xd://mcp__<서버>_<도구>`인 것만 센다. 서버 이름은 `--mcp-config`의 `mcpServers` 키로 가르고(못 읽으면 `mcp__` 뒤 첫 `_` 앞까지), 오류는 같은 toolCallId의 toolResult `isError`다. 창 안 호출이 없는 설정 서버는 `0`으로 나온다.

## 규칙 문턱값

`collect.py` 맨 위 상수다. 바꾸면 이 표도 고친다.

| 규칙 | 걸리는 조건 | 상수 |
|---|---|---|
| R1 신규 모델 | 직전 스냅샷에 없던 chat 모델 중 현행 설정이 쓰는 공급자의 것 | — |
| R2 폴백 과다 | 한 `from` 모델(effort 뗌, 홈 합산) 폴백 ≥ 10건, 또는 호출 ≥ 100인 모델의 오류% ≥ 3 | `R2_FALLBACKS`·`R2_ERROR_PCT`·`R2_MIN_CALLS` |
| R3 비싼 용도 | 모니터·레인·리뷰·하위 중 한 용도의 비용 비중 ≥ 10% (대화·omp직접·기타는 대상 아님) | `R3_SHARE_PCT` |
| R4 RULES §9 | 체인 키(역할 키면 `modelRoles`로 풂)의 첫 폴백이 같은 모델 effort 변형이거나, 같은 공급자의 다른 모델(`--allow-same-provider` 제외). 역할 키가 `modelRoles`에 없으면 `역할 미정의` | — |
| R5 단가 변동 | 현행 설정(역할·체인·봇·모니터)이 쓰는 모델의 input·output 단가 ±20% 이상 | `R5_PRICE_PCT` |

근거(2026-11-13 OCI 7일 실측): 합계 약 $1,800 중 omp직접 약 40%·하위 5.4%·레인 2.4%·모니터 0.6%, 메인 모델 폴백 20건(effort 둘 합산)·피어 봇 주 모델 9건, 모델별 오류% 최대 1.89%(호출 100 이상). 이 문턱값이면 R2는 메인 모델 폴백만 걸리고 R3·오류%는 걸리지 않는다.

## 반영 (오너 결정 뒤, 이 패키지 범위 밖)

오너가 스레드에 "N번 적용"이라고 답하면, 그 스레드 세션이 `omp-fallback-chain-audit` 스킬의 수정 절차(백업 → 통째로 set → 검증)로 반영하고 `experiments.md`에 항목을 등록한다. 모니터 턴은 반영하지 않는다.

## 되돌리기

```
bun src/main.ts monitors list          # id 확인
bun src/main.ts monitors remove <id>
rm "$H/scripts/model-review-collect.py" "$H/scripts/model-review.py" "$H/scripts/model-review-procedure.md"
```

`$H/workspace/model-review/`(수집·보고·스냅샷)는 기록이므로 필요할 때만 지운다.
