# 주간 모델 점검 절차

너는 지난 7일 모델 실측·폴백·현행 설정·카탈로그 변화를 보고 **모델 체계 변경 제안**을 최대 5건 올린다. **반영은 오너가 한다** — 이 턴은 제안만 한다. 아래 순서를 그대로 따른다.

## 1. 수집 (한 번)

주차·날짜는 다음으로 정한다(봇 시간대: `OMPBOT_TZ` → `@OMPBOT_HOME@/config.json`의 `timezone` → 시스템 시간대, ISO 주차; 출력 `<YYYY>-W<ww> <오늘> <창 시작> <창 끝>`):

```
python3 -c 'import datetime as d,json,os,zoneinfo as z;n=os.environ.get("OMPBOT_TZ") or json.load(open("@OMPBOT_HOME@/config.json")).get("timezone");t=d.datetime.now(z.ZoneInfo(n) if n else None).date();y,w,_=t.isocalendar();print(f"{y}-W{w:02d} {t} {t-d.timedelta(7)} {t-d.timedelta(1)}")'
```

그다음 수집기를 정확히 한 번 실행한다(`<날짜>`는 위 출력의 오늘):

```
mkdir -p @OMPBOT_HOME@/workspace/model-review && python3 @OMPBOT_HOME@/scripts/model-review-collect.py --home @OMPBOT_HOME@ @COLLECT_ARGS@ > @OMPBOT_HOME@/workspace/model-review/collect-<날짜>.md
```

- 실패(exit≠0)면 그 stderr를 그대로 오너에게 보고하고 끝낸다.
- 수집 파일 전문을 이후 단계의 유일한 사실 근거로 쓴다. **출력에 없는 사실은 쓰지 않는다**(다른 파일·DB·로그를 따로 열어 보충하지 않는다).
- `## 소스 상태`에 `missing`/`error`가 있으면(`catalog-prev: missing`은 첫 회차라 정상) 답 끝에 한 줄로 알린다.

## 2. 제안 고르기

- `## 규칙 판정`에 걸린 항목만 제안으로 만든다(`## MCP 호출`은 참고용 정보라 제안 근거로 쓰지 않는다). 최대 5건, R2·R4를 먼저, 그다음 R5·R3·R1 순서.
- 같은 대상의 여러 항목은 한 제안으로 묶어도 된다(근거에 태그를 모두 단다).
- 걸린 항목이 없으면(`걸린 항목 없음`) 제안 0건이다.
- 폴백 체인을 바꾸는 제안은 새 값이 R4에 걸리면 안 된다: 바꾼 체인 키(역할 키면 `## 현행 설정`의 modelRoles로 푼 모델)의 첫 항목이 같은 모델의 effort 변형이거나, 같은 공급자의 다른 모델이면(설치 인자 `--allow-same-provider`로 허용한 공급자는 예외) 그 안은 버리고 다른 공급자 모델을 첫 항목으로 고른다. 맞는 대안이 없으면 그 항목은 제안하지 않고 답 끝에 "R4를 지키는 대안 없음: <대상>" 한 줄로 알린다. 한도(429) 폴백 대응을 같은 공급자 모델로 메우는 안은 한도가 겹쳐 효과가 없다.

## 3. 보고 파일 작성

`@OMPBOT_HOME@/workspace/model-review/report-<YYYY>-W<ww>.md`에 쓴다(있으면 덮어쓴다). 형식:

```
# 주간 모델 점검 <YYYY>-W<ww>
기간: <창 시작> ~ <창 끝> (봇 시간대)

## 제안
### P1 <제목 한 줄>
- 근거: [R<n>] <규칙 판정 줄의 대상 그대로> — <수집 출력의 수치 한 줄>
- 바꿀 것: <그대로 쓸 설정 키와 새 값>
- 예상 효과: 추정 <무엇이 얼마나 줄거나 늘지>
- 반증선: <다음 주 수집 출력에서 무엇이 보이면 이 제안이 틀렸다고 볼지>
- 되돌리기: <원래 값으로 돌리는 명령·값>
```

- 근거의 `[R<n>] <대상>`은 `## 규칙 판정` 줄의 태그와 대상을 글자 그대로 옮긴다(게이트가 대조한다).
- `바꿀 것`에는 그대로 실행·입력할 수 있는 형태로 쓴다: `omp config set retry.fallbackChains '<체인 전체 JSON>'`, `modelRoles.<역할>`의 새 값, 모니터 모델은 `monitors update <id> --json '<JSON>'`(JSON에는 `model` 키와 새 모델 id만). 메인·역할 모델 교체 제안에는 "적용은 새 세션부터(캐시 재작성)"를 붙인다.
- `예상 효과`는 수집 출력 수치에서 끌어낸 추정이고 `추정`이라는 낱말을 넣는다.
- 제안 0건이면 `## 제안` 아래에 `제안 없음` 한 줄만 쓴다.

## 4. 형식 게이트

```
python3 @OMPBOT_HOME@/scripts/model-review.py check <보고 파일> --collect <수집 파일>
```

- exit 0이 될 때까지 stderr의 `줄 <n>: <사유>`를 보고 고친다(고쳐서 다시 돌리기 최대 2회). 끝내 실패하면 답 첫 줄을 `⚠️ 보고 형식 검증 실패`로 쓰고 위반 목록(stderr 전문)을 붙인다.

## 5. 답 (오너)

```
주간 모델 점검 <YYYY>-W<ww>: <결론 한 줄>
1. <P1 제목>
…
보고: @OMPBOT_HOME@/workspace/model-review/report-<YYYY>-W<ww>.md
적용하려면 이 스레드에 "N번 적용"
```

- 제안 0건이어도 `[SILENT]`를 쓰지 않는다. `주간 모델 점검 <YYYY>-W<ww>: 제안 없음 (규칙 판정 걸린 항목 없음)`과 보고 경로를 올린다.

## 6. 금지

- 설정을 바꾸지 않는다(`omp config set`·`monitors update`·`config.json` 수정 포함). 제안만 한다.
- 승인 요청·dispatch·TASK 생성을 하지 않는다. 이 세션에는 그 도구가 없거나 실패한다.
- 수집 파일·보고 파일 말고는 어떤 파일도 만들거나 고치지 않는다.
- 서비스·데몬·컨테이너를 조작하지 않는다. 하위 에이전트를 띄우지 않는다.
