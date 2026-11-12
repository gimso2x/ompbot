# 기억 교정 모니터 (memory audit)

매주 일요일 05:00(봇 시간대)에 ompbot 세션이 쓰는 Mnemopi 은행에서 모니터 턴 기록(잡음)을 모두 무효화하고, 나머지 기억 중 아직 검사하지 않은 것을 회상 횟수 순으로 최대 30개 골라 현재 코드·설정·기록과 대조해 `유지`·`무효`·`교체`로 판정한다. 은행을 스냅샷한 뒤 모델이 `memory_edit invalidate`로 반영하고, `audit.py verify`가 반영 결과를 은행과 대조한다. 스크립트는 은행 DB를 읽기 전용(`mode=ro`)으로만 연다.

| 파일 | 설치 경로 | 하는 일 |
|---|---|---|
| `collect.py` | `<홈>/scripts/memory-audit-collect.py` | 은행 지표·잡음·후보 미리보기 출력 (읽기 전용) |
| `audit.py` | `<홈>/scripts/memory-audit.py` | `check`(판정 파일 형식)·`snapshot`·`find`(교체 메모 id)·`verify`(반영 검증, state 기록) |
| `procedure.md` | `<홈>/scripts/memory-audit-procedure.md` | 모니터 턴이 따르는 절차 |
| `monitor.json` | `monitors add --json` 입력 | 일요일 05:00(봇 시간대) cron, 봇 기본 모델, thinking high, 오너 DM |

`<홈>`은 `OMPBOT_HOME`(기본 `~/.ompbot`)이다. 두 스크립트의 사용법·종료 코드는 파일 맨 위 docstring에 있다.

## 설치

저장소 체크아웃에서(`HOME_DIR`·`REPO_DIR`은 자기 경로):

```
HOME_DIR=$HOME/.ompbot REPO_DIR=$PWD
install -m 0755 examples/monitors/memory-audit/collect.py "$HOME_DIR/scripts/memory-audit-collect.py"
install -m 0755 examples/monitors/memory-audit/audit.py "$HOME_DIR/scripts/memory-audit.py"
sed -e "s|@OMPBOT_HOME@|$HOME_DIR|g" -e "s|@REPO_DIR@|$REPO_DIR|g" examples/monitors/memory-audit/procedure.md > "$HOME_DIR/scripts/memory-audit-procedure.md"
mkdir -p "$HOME_DIR/workspace/memory-audit" "$HOME_DIR/backups/memory-audit"
bun src/main.ts monitors add --json "$(sed "s|@OMPBOT_HOME@|$HOME_DIR|g" examples/monitors/memory-audit/monitor.json)"
bun src/main.ts monitors list   # 기억 교정: next = 다음 일요일 05:00(봇 시간대)
```

- 스냅샷은 `<홈>/backups/memory-audit/`에 둔다. 백업 번들(`sessions`·`config.json`·`workspace`·`scripts`)과 오프사이트(`backups/`의 최신 `ompbot-*.db`와 번들)에 들어가지 않으므로 은행 크기만큼 번들이 커지지 않는다. 같은 은행 스냅샷은 최신 4개만 남는다.
- 판정 기록은 `<홈>/workspace/memory-audit/<YYYY-MM-DD>.md`, 검사 이력은 `<홈>/workspace/memory-audit/state.json`(`{id: {audited_at, sha256, verdict}}`)이다. 같은 id·같은 내용은 30일 동안 다시 후보로 나오지 않는다.

## 판정 파일 형식

```
# 기억 교정 2026-11-15
은행: workspace-hw1kg3s3ph24
스냅샷: <홈>/backups/memory-audit/workspace-hw1kg3s3ph24-20261115-050012.db

## 판정
| ID | 분류 | 회상 | 판정 | 근거 | 교체 |
|---|---|---|---|---|---|
| 62e9b09e4b2ba54c | claim | 22 | 교체 | soul.md·persona.md가 채팅·모니터에 주입된다 (코드 src/safety/prompt.ts:119) | 0f3c9a1b2c3d4e5f |
| 1a2b3c4d5e6f7a8b | noise-monitor | 47 | 무효 | 아침 브리핑 모니터 턴 기록 (잡음) | - |
```

`audit.py check`가 검사하는 규칙(위반마다 stderr `줄 <n>: <사유>`, exit 2):

- 첫 줄 `# 기억 교정 YYYY-MM-DD`, `은행:`·`스냅샷:` 줄, `## 판정` 표. 잡음·후보가 모두 없으면 표 대신 `후보 없음` 한 줄.
- 행 1~50개, 열 6개, 셀 안 `|` 금지. ID는 16자리 소문자 16진수이고 중복 없음.
- 분류 ∈ `noise-monitor|claim`, 회상은 0 이상 정수, 판정 ∈ `유지|무효|교체`. `noise-monitor` 행의 판정은 `무효`만.
- 근거 셀에 출처 태그 1개 이상: `(코드 …)`·`(설정 …)`·`(DB …)`·`(파일 …)`·`(기록 YYYY-MM-DD)`·`(기록 YYYY-MM-DD <설명>)`·`(잡음)`. `(잡음)`은 `noise-monitor` 행에만.
- 교체 셀: 판정이 `교체`면 행 ID와 다른 16자리 16진수, 아니면 `-`.

## 되돌리기

1. **특정 판정만** — ompbot이 돌고 있어도 된다:

   ```
   sqlite3 <은행 mnemopi.db> "update working_memory set valid_until=NULL, superseded_by=NULL where id in ('<id>', …)"
   ```

   working 행을 무효화하면 그 id를 `summary_of`에 담은 episodic 행도 함께 무효화된다. 이 행들은 같은 SQL을 `episodic_memory`에 실행해 되돌린다(판정 파일에 있는 것은 `verify` 출력의 `연쇄 <id>` 줄). 교체 메모는 남겨 두어도 되고, 지우려면 그 id도 `memory_edit invalidate`한다.
2. **전체** — ompbot(과 그 은행을 쓰는 omp 세션)을 멈춘 상태에서 스냅샷 파일을 은행 경로(`<은행 디렉터리>/mnemopi.db`)로 복사하고, 같은 디렉터리의 `mnemopi.db-wal`·`mnemopi.db-shm`이 남아 있으면 지운다.

모니터를 끄려면 `bun src/main.ts monitors update "기억 교정" --json '{"enabled":false}'`, 지우려면 `bun src/main.ts monitors remove "기억 교정"`.
