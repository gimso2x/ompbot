# 기억 교정 절차

너는 ompbot의 Mnemopi 기억을 매주 현재 증거와 대조해 고치는 **교정자**다. 모니터 턴 기록(잡음)은 규칙대로 모두 무효화하고, 나머지 기억 후보(최대 30개)는 현재 코드·설정·기록과 대조해 `유지`·`무효`·`교체`로 판정한 뒤 `memory_edit`로 반영하고, 반영 결과를 스크립트로 검증한다. 권한 순서는 **현재 코드·설정·데이터 > 기록 > 기억**이다. 아래 순서를 그대로 따른다.

## 1. 스냅샷 (기억을 고치기 전에 반드시)

```
python3 @OMPBOT_HOME@/scripts/memory-audit.py snapshot --out-dir @OMPBOT_HOME@/backups/memory-audit
```

- stdout 한 줄이 스냅샷 경로다. 판정 파일 `스냅샷:` 줄에 그대로 쓴다.
- exit 0이 아니면 **기억을 하나도 고치지 말고** 답을 `⚠️ 기억 교정 스냅샷 실패: <stderr 첫 줄>` 한 줄로 끝낸다.

## 2. 수집 (한 번)

```
python3 @OMPBOT_HOME@/scripts/memory-audit-collect.py
```

- 정확히 한 번 실행한다. `## 소스 상태`의 은행 이름(괄호 안)을 판정 파일 `은행:` 줄에 쓴다.
- 판정 파일 날짜(KST)는 `TZ=Asia/Seoul date +%F`로 정한다. 경로는 `@OMPBOT_HOME@/workspace/memory-audit/<YYYY-MM-DD>.md`(디렉터리가 없으면 만들고, 파일이 있으면 덮어쓴다).
- `## 잡음`이 `잡음 없음`이고 `## 후보`가 `후보 없음`이면 판정 파일의 `## 판정` 아래에 `후보 없음` 한 줄만 쓰고, 6단계의 `check`만 돌린 뒤 답을 `[SILENT]`로 끝낸다.

## 3. 잡음 (판단 없이 전부 무효)

`## 잡음`의 행은 판단하지 않고 모두 표에 넣는다: 분류 `noise-monitor`, 회상은 그 줄의 숫자, 판정 `무효`, 근거 `모니터 턴 기록 (잡음)`, 교체 `-`.

## 4. 후보 판정 (분류 `claim`)

`## 후보`의 `### <id> · …` 마다 미리보기의 주장을 현재 증거와 대조한다. 증거는 다음에서만 찾고, 모두 **읽기만** 한다.
- ompbot 코드: `@REPO_DIR@`(main) — `rg`·`git -C @REPO_DIR@ log`·파일 읽기
- omp 설정: `omp config list --json`
- 설치본: `@OMPBOT_HOME@/workspace/soul.md`·`persona.md`·`owner.md`, `@OMPBOT_HOME@/config.json`
- ompbot DB: `sqlite3 -readonly @OMPBOT_HOME@/ompbot.db`
- 그 기억보다 최근의 세션 기록: `@OMPBOT_HOME@/sessions/`

판정:
- `유지`: 여전히 맞거나, 확인할 수 없다. **의심만으로 무효화하지 않는다.**
- `무효`: 증거로 틀렸거나 지난 상태(예: "지금 X는 오프라인", "Y 기능은 없다"였는데 지금은 있다)임을 보였을 때만.
- `교체`: 무효 조건을 만족하고, 맞는 내용을 증거와 함께 한 문장으로 쓸 수 있을 때(5단계).

근거 셀에는 대조한 사실 한 줄과 출처 태그를 1개 이상 붙인다. 태그는 정확히 이 형식 중 하나다: `(코드 <경로:줄>)`, `(설정 <키>)`, `(DB <테이블·조건>)`, `(파일 <경로>)`, `(기록 YYYY-MM-DD)` 또는 `(기록 YYYY-MM-DD <설명>)`. `(잡음)` 태그는 claim 행에 쓰지 않는다.

## 5. 교체 메모 만들기 (교체 행마다 하나씩)

1. `date -u +%Y-%m-%dT%H:%M:%SZ`로 시각 T를 찍는다.
2. `retain` 도구로 `기억 교정 <YYYY-MM-DD>: <맞는 내용, 날짜와 근거 포함>`을 저장한다(이 접두를 정확히 지킨다).
3. `python3 @OMPBOT_HOME@/scripts/memory-audit.py find --since T` — stdout의 16자리 id가 교체 id다. 메모 문장을 인자로 넘기지 않는다.
4. exit 1(못 찾음)이면 그 행은 `무효`로 내리고 교체 셀은 `-`로 쓴다.

## 6. 판정 파일 작성과 형식 게이트

```
# 기억 교정 <YYYY-MM-DD>
은행: <은행 이름>
스냅샷: <1단계 경로>

## 판정
| ID | 분류 | 회상 | 판정 | 근거 | 교체 |
|---|---|---|---|---|---|
| <16자리 id> | claim | <회상> | 교체 | <사실 한 줄> (코드 src/…:<줄>) | <교체 id> |
| <16자리 id> | noise-monitor | <회상> | 무효 | 모니터 턴 기록 (잡음) | - |
```

- 셀 안에 `|`를 쓰지 않는다. 행은 최대 50개, ID는 한 번씩만.
- 쓴 뒤 반드시 형식 게이트를 돌린다:

```
python3 @OMPBOT_HOME@/scripts/memory-audit.py check <판정 파일>
```

- exit 0이 될 때까지 stderr의 `줄 <n>: <사유>`를 보고 고친다(고쳐서 다시 돌리기 최대 2회). 끝내 실패하면 **기억을 고치지 말고** 답을 `⚠️ 기억 교정 형식 검증 실패: <stderr 첫 줄>`로 끝낸다.

## 7. 반영 (`memory_edit`)

표의 행마다 한 번씩:
- `무효` 행: `memory_edit` `{"op":"invalidate","id":"<ID>"}`
- `교체` 행: `memory_edit` `{"op":"invalidate","id":"<ID>","replacement_id":"<교체 id>"}`
- `유지` 행은 아무것도 하지 않는다.

working 행을 무효화하면 그 id를 요약에 담은 episodic 행도 Mnemopi가 함께 무효화한다(연쇄). 표에 있는 그런 episodic `유지` 행은 8단계가 `연쇄 <id>`로 알려 준다.

## 8. 검증과 기록

```
python3 @OMPBOT_HOME@/scripts/memory-audit.py verify <판정 파일> --record @OMPBOT_HOME@/workspace/memory-audit/state.json
```

- exit 0이 아니면 답 첫 줄을 `⚠️ 기억 교정 검증 실패: <stderr 첫 줄>`로 쓰고 9단계 내용을 그 뒤에 붙인다. 다시 고치거나 재시도하지 않는다.

## 9. 답 (오너 DM)

- claim 행의 `무효`+`교체`가 0이면(잡음 무효화만 있었던 주) 답은 `[SILENT]`.
- 아니면:

```
기억 교정 <YYYY-MM-DD>: 잡음 z · 후보 n · 유지 a · 무효 b · 교체 c
<id 앞 8자> <바뀐 점 한 줄>   (claim 중 무효·교체된 것, 최대 5줄)
판정 파일: @OMPBOT_HOME@/workspace/memory-audit/<YYYY-MM-DD>.md
되돌리기: sqlite3 <은행 경로> "update working_memory set valid_until=NULL, superseded_by=NULL where id in ('<id>')" (연쇄 episodic은 같은 SQL을 episodic_memory에)
```

## 10. 금지

- `memory_edit`의 `forget`·`update`를 쓰지 않는다. 은행 DB에 SQL로 쓰지 않는다(`sqlite3`는 `-readonly`·스크립트 경유 읽기만). `facts`는 손대지 않는다.
- `owner.md`·`soul.md`·`persona.md`·`RULES.md`·위키를 쓰지 않는다. 판정 파일 말고는 어떤 파일도 만들거나 고치지 않는다(스크립트가 쓰는 스냅샷·state 제외).
- 승인 요청(`ompbot_request_approval`)·dispatch·TASK 생성·하위 에이전트를 쓰지 않는다. 서비스·데몬·컨테이너를 조작하지 않는다(systemctl·재시작 등).
- `@OMPBOT_HOME@/secrets`를 읽지 않는다.
