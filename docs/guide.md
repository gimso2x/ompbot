# ompbot 사용 설명서

[← README](../README.md)

설치부터 운영까지 ompbot의 모든 동작을 정리한 레퍼런스입니다.

- **시작하기:** [요구 사항](#요구-사항) · [코어와 설치본](#코어와-설치본) · [설치](#설치) · [설정 파일](#5-설정-파일-ompbotconfigjson) · [서비스 등록](#7-서비스-등록) · [AI 에이전트에게 설치 맡기기](#ai-에이전트에게-설치-맡기기)
- **쓰기:** [대화](#대화) · [명령](#명령) · [턴 되돌리기](#턴-되돌리기undo) · [승인](#승인) · [질문 카드](#질문-카드) · [답 피드백](#답-피드백) · [페르소나와 답변 형식](#페르소나와-답변-형식) · [claude 에이전트](#claude-에이전트) · [agy 에이전트](#agy-에이전트) · [Discord](#discord선택)
- **맡기기:** [작업 위임](#작업-위임) · [`[TASK]` 상태 문서](#task-상태-문서) · [`[TASK]` 자동 머지](#task-자동-머지) · [작업 레인](#작업-레인) · [모니터](#모니터)
- **운영:** [CLI](#운영) · [현황판](#현황판) · [동결(킬스위치)](#동결킬스위치) · [재시작과 drain](#재시작과-drain) · [설정 반영](#재시작-없이-설정-반영) · [놓친 메시지 백필](#놓친-메시지-백필) · [건강 게이트](#건강-게이트와-자가-보고) · [캐시 감시·파일 겹침](#프롬프트-캐시-감시와-task-파일-겹침-알림) · [백업](#백업) · [스킬 리뷰](#스킬-리뷰)
- **그 밖:** [보안 메모](#보안-메모) · [개발](#개발)

## 기능 지도

| 영역 | 기능 | 자세히 |
| --- | --- | --- |
| 대화 | DM·채널·채널 스레드별 독립 대화, 일하는 중 끼워 넣기(steer)·`!followup`, 끝맺은 답의 턴 중간 전달, 첨부 받기·파일 올리기, Slack `markdown` 블록 답과 `card` 펜스(네이티브 카드·표·차트), 진행 상태 메시지, 같은 도구 반복 감지, 같은 대화 공간의 지난 대화 자동 회상, 전달·첨부 자료의 인젝션 경고 | [대화](#대화) |
| Discord(선택) | 오너 한 명의 Discord DM·서버 채널 대화(멘션하면 스레드), `!` 명령·슬래시 명령·진행 표시·승인·질문·TASK 카드 버튼·카드(embed)·파일·👍/👎·놓친 메시지 백필·`doctor` 점검, DM 모니터, 서버 채널 스레드의 작업 레인 | [Discord](#discord선택) |
| Teams(선택) | Microsoft Teams 1:1·그룹 채팅(멘션) 대화, 손님·`qa` 읽기 전용 답변, 앱 패키지(`teams package`), 오너 채팅 읽기(Graph) | [Teams](#teams선택) |
| 대화 에이전트 | omp(기본) 대신 Claude Code CLI(`"agent": "claude"`)나 Antigravity CLI(`"agent": "agy"`)로 대화를 구동 | [claude 에이전트](#claude-에이전트) · [agy 에이전트](#agy-에이전트) |
| 채팅 명령 | 모델·thinking 전환, 컨텍스트 압축, 옛 세션 이어가기, 대기열 보기·취소, 새 대화, 스레드 뮤트, 토큰·비용 사용량, 오늘 비용과 상한(`!budget`), 턴 되돌리기(`!undo`) | [명령](#명령) · [턴 되돌리기](#턴-되돌리기undo) |
| 비용 상한 | 턴 상한(마무리 지시 → 1.5배에서 중단)·하루 상한(모니터 정지·하루 1회 알림·`cost_cap` 게이트) | [설정](#5-설정-파일-ompbotconfigjson) `costCap` |
| 승인 | 되돌릴 수 없거나 밖으로 나가는 작업 전 승인 버튼(구조화된 카드, 외부 공개 `🌐` 카드, 영속 장부, escalation 채널과 요청 스레드 사본, 다시 요청 버튼, 카드 스레드 답장) | [승인](#승인) |
| 답 피드백 | 봇 답에 단 오너 👍/👎를 그 답을 낳은 턴에 기록, 현황판 배지·`feedback` CLI | [답 피드백](#답-피드백) |
| 질문 카드 | omp의 질문 창(select·confirm·input·editor·`ask`)을 대화 스레드의 버튼·답장 카드로, 마감 시 omp와 같은 기본값 | [질문 카드](#질문-카드) |
| 페르소나·답변 형식 | `workspace/`의 `soul.md`·`owner.md`·`persona.md`를 세션 시스템 프롬프트에 추가, 답변 형식 규율 | [페르소나와 답변 형식](#페르소나와-답변-형식) |
| 완료 사본 | `✅ 완료`로 시작하는 답을 #log 채널에 사본으로 남김 | [설정](#5-설정-파일-ompbotconfigjson) `logChannel` |
| 작업 위임 | `ompbot_dispatch` — 단발(`omp -p`)·장기(herdr)·원격 호스트, `[TASK]` 상태 문서와 5분 스윕, 머지·추천대로 버튼, 개인 저장소 자동 머지(`taskAutoLand`), 같은 저장소 TASK 파일 겹침 알림 | [작업 위임](#작업-위임) |
| 작업 레인 | `작업: <제목> @<경로>`로 레인 스레드, 레인마다 전용 worktree·브랜치, 커밋과 `[check: …]` 재실행으로 검증되는 완료, Outcome 카드의 `머지`·`폐기` 버튼, 코어가 하는 ff 머지·push·정리, 개인 저장소 자동 머지(`taskAutoLand`) | [작업 레인](#작업-레인) |
| 모니터 | cron·한 번·스크립트 조건·파일 변경(watcher)·webhook 트리거, 채널 게시·사본, 모델 고정, 절차 파일, 턴 없이 그대로 전달(verbatim), 실패 재시도·인시던트, 설치본 저장소로 내보내기·적용 | [모니터](#모니터) |
| 현황판 | 루프백 전용 읽기 전용 웹 현황판: 인박스·턴 보드(대화·생성 중 글·트레이스)·TASK 흐름 고리·모니터·승인 대기·알림·시스템 | [현황판](#현황판) |
| 신뢰성 | 재시작 뒤 대화 유지·답 복구, 놓친 메시지 백필, 멈춘 대기 메시지 재시도, 건강 게이트와 자가 보고, drain 재시작과 재시작 알림, 재시작 없는 설정 반영, 프롬프트 캐시 미스·식은 캐시 알림 | [운영](#운영) |
| 백업 | 매일 DB 사본 + 세션·설정 번들, 성공 도장, 보존 | [백업](#백업) |
| 학습 | N턴마다 또는 `!distill`로 스킬 제안(근거·검증 짝 채택 게이트) → 승인 설치 → 개정 롤백 | [스킬 리뷰](#스킬-리뷰) |
| 보안 | 오너 게이트, 두 겹 비밀 마스킹, 자식 환경 정리, 업로드 차단 목록 | [보안 메모](#보안-메모) |

## 요구 사항

- Linux, systemd user 세션(재부팅 후 자동 시작을 원하면 `loginctl enable-linger $USER`). WSL2에서도 됩니다. `/etc/wsl.conf`의 `[boot]`에 `systemd=true`를 넣고 Windows에서 `wsl --shutdown`으로 다시 시작한 뒤 `systemctl --user status`가 응답하는지 확인하세요. WSL은 마지막 창을 닫으면 멈출 수 있으니 상시 운영은 Linux 서버가 낫습니다.
- [Bun](https://bun.sh): 설치한 omp의 `engines.bun` 이상(omp 18.16 기준 1.4.4). 낮으면 `bun upgrade`. `doctor`의 `omp runtime` 줄이 이 조건을 확인합니다.
- omp(oh-my-pi)를 **bun 패키지로** 설치하고 로그인해 둡니다. ompbot은 omp의 기존 `~/.omp/agent` 설정을 그대로 씁니다.

  ```sh
  bun install -g @oh-my-pi/pi-coding-agent
  readlink -f "$(command -v omp)"   # …/@oh-my-pi/pi-coding-agent/dist/cli.js 여야 합니다
  omp login                         # 모델 공급자 하나 이상 로그인(브라우저 OAuth 또는 API 키)
  omp --version
  ```

  단독 실행 파일(컴파일된 바이너리) 형태의 omp는 ompbot이 RPC 자식으로 쓸 수 없어 `omp_launcher_standalone`으로 거부합니다. `readlink` 결과가 `dist/cli.js`가 아니면 위 명령으로 다시 설치하세요.
- (선택) 대화 에이전트를 Claude Code CLI로 쓰려면(`"agent": "claude"`) [Claude Code](https://docs.claude.com/en/docs/claude-code/overview)가 설치돼 있고 로그인돼 있어야 합니다(`claude --version`, `claude` 한 번 실행해 `/login` 완료 — 자격은 `~/.claude/` 아래에만 둡니다). omp는 여전히 설치돼 있어야 합니다(dispatch 등 일부 도구가 씁니다). 자세한 차이는 [claude 에이전트](#claude-에이전트) 참고
- (선택) 대화 에이전트를 Antigravity CLI로 쓰려면(`"agent": "agy"`) `agy --version`이 응답하고 `agy`를 한 번 실행해 Google 로그인을 마쳐야 합니다. omp는 여전히 설치돼 있어야 합니다. 자세한 차이는 [agy 에이전트](#agy-에이전트) 참고
- 채팅 앱 하나 이상: Slack 워크스페이스에 앱을 만들 권한, 또는 Discord 봇을 만들고 서버에 초대할 권한. 둘 중 하나만 있어도 되고 둘 다 써도 됩니다
- (선택) 장기 위임에는 herdr와 config `"herdr": {}`가, 원격 위임에는 대상 호스트로의 ssh(`BatchMode`)가 필요합니다. [herdr(선택)](#herdr선택) 참고.

## 코어와 설치본

이 저장소(코어)는 코드만 담습니다. 설치한 사람마다 다른 것은 모두 `OMPBOT_HOME`(기본 `~/.ompbot`) 아래의 설치본입니다 — `config.json`, `secrets/`(Slack 토큰), `workspace/persona.md`, 세션, `ompbot.db`(모니터 포함), 백업, 로그. 설치본은 git에 넣지 않습니다. systemd 유닛(`packaging/*.service`·`*.timer`)은 템플릿이고 `ompbot units render`가 자기 bun·체크아웃·홈 경로로 채웁니다. `examples/`는 그대로 쓰지 않고 자기 경로로 바꿔 쓰는 예시입니다.

## 설치

### 1. 소스 받기

```sh
git clone <이 저장소의 clone URL> ~/work/ompbot
cd ~/work/ompbot
bun install
bun test          # 전부 통과해야 합니다(실제 omp E2E는 기본으로 건너뜀)
```

### 2. Slack 앱 만들기

Slack과 Discord 중 쓸 것을 고릅니다. 하나만 써도 되고 둘 다 써도 됩니다. Discord만 쓰면 이 절을 건너뛰고 [Discord 봇 만들기](discord.md)로 봇·토큰·초대를 준비합니다.

1. https://api.slack.com/apps → **Create New App** → **From a manifest** → 워크스페이스를 고릅니다.
2. **JSON** 탭에 [`packaging/slack-manifest.json`](../packaging/slack-manifest.json) 내용을 그대로 붙여넣고 **Create**를 누릅니다. 검토 화면에서 권한 15개, 이벤트 6개(메시지 4개 + 반응 `reaction_added`·`reaction_removed`), 슬래시 명령 12개가 보여야 합니다. 반응 구독(`reactions:read`와 두 반응 이벤트)이 들어가기 전에 만든 앱은 앱 설정에서 이 셋을 더하고 다시 설치해야 [답 피드백](#답-피드백)이 들어옵니다(토큰이 바뀌면 `secrets/`의 봇 토큰도 바꿉니다). 이미 만든 앱에서 권한을 뺀 매니페스트는 앱을 워크스페이스에 다시 설치(reinstall)해야 실제 앱에 반영됩니다.
3. **Install App** → **Install to <워크스페이스>** → 허용을 누르면 `xoxb-` 봇 토큰이 나옵니다.
4. **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes**에서 범위 `connections:write`를 넣어 `xapp-` 토큰을 만듭니다.

같은 워크스페이스에 봇이 여러 개면, 슬래시 명령 이름이 겹치지 않도록 매니페스트의 `/…-ompbot` 명령 이름을 바꾸세요. 같은 이름이면 마지막에 설치한 앱의 명령만 동작합니다.

Slack과 함께 Discord도 쓰려면 [Discord 봇 만들기](discord.md)를 따라 봇·토큰·초대를 준비합니다.

### 3. 홈과 설정 만들기 (`init`)

```sh
bun src/main.ts init --owner <Slack 멤버 ID> [--omp <omp 절대경로>] [--workspace <디렉터리>]                                        # Slack
bun src/main.ts init --platform discord --owner <Discord 사용자 ID> --app-id <Application ID> [--omp …] [--workspace …]   # Discord만
```

- `--owner`: 명령을 받아들일 유일한 사용자. Slack이면 Slack 프로필 → ⋮ → **멤버 ID 복사**(`U…`), Discord면 개발자 모드에서 내 프로필 → **사용자 ID 복사**(숫자 17~20자리)입니다. `--app-id`는 Discord Developer Portal의 Application ID입니다. 형식이 틀리면 아무것도 만들지 않고 종료 코드 2입니다.
- Slack과 Discord를 같이 쓰려면 Slack으로 `init`한 뒤 `config.json`에 `channels.discord`를 더합니다([Discord(선택)](#discord선택)).
- `--omp`를 비우면 PATH의 `omp`를 씁니다(못 찾으면 종료 코드 2). `--workspace`를 비우면 `<홈>/workspace`입니다.
- 홈(`OMPBOT_HOME`, 기본 `~/.ompbot`, 0700), `secrets/`(0700), workspace 디렉터리, 아래 5절의 최소 키만 든 `config.json`(0600)을 만듭니다. `config.json`이 이미 있으면 아무것도 바꾸지 않고 종료 코드 2로 끝납니다(덮어쓰기 옵션은 없습니다).
- 토큰은 묻지도 쓰지도 않습니다. 끝에 토큰 파일 경로(Slack은 두 개, Discord는 `discord-bot-token` 하나)와 다음 단계를 출력합니다.

다른 홈을 쓰려면 모든 명령 앞에 `OMPBOT_HOME=<경로>`를 붙입니다. `OMPBOT_HOME=`(빈 값)은 설정하지 않은 것과 같아 `~/.ompbot`을 씁니다. 홈·`secrets/`·workspace 자리(또는 그 상위)에 파일이 있으면 아무것도 만들지 않고 종료 코드 2입니다.

### 4. 토큰 파일

토큰은 파일로만 둡니다. 채팅이나 셸 기록에 남기지 마세요.

```sh
umask 077
cat > ~/.ompbot/secrets/slack-bot-token   # xoxb-… 붙여넣고 Ctrl-D
cat > ~/.ompbot/secrets/slack-app-token   # xapp-… 붙여넣고 Ctrl-D
cat > ~/.ompbot/secrets/discord-bot-token # (Discord를 쓸 때) 봇 토큰 붙여넣고 Ctrl-D
chmod 600 ~/.ompbot/secrets/*
```

Slack을 쓰지 않으면 `slack-*` 두 줄을, Discord를 쓰지 않으면 `discord-bot-token` 줄을 건너뜁니다.

### 5. 설정 파일 `~/.ompbot/config.json`

`init`이 만든 파일은 다음과 같습니다. 선택 키는 아래 표를 보고 직접 더합니다.

```json
{
  "schemaVersion": 1,
  "channels": {
    "slack": { "ownerUserId": "U0123456789" }
  },
  "slack": {
    "botTokenFile": "secrets/slack-bot-token",
    "appTokenFile": "secrets/slack-app-token"
  },
  "ompExecutable": "/home/<user>/.bun/bin/omp",
  "workspaceDir": "/home/<user>/.ompbot/workspace",
  "sessionRetentionDays": 30
}
```

| 키 | 필수 | 설명 |
| --- | --- | --- |
| `schemaVersion` | 예 | 항상 `1` |
| `channels.slack.ownerUserId` | Slack을 쓸 때 | Slack 켜기. 없으면 Slack을 쓰지 않고 `channels.discord`(또는 `channels.teams`)만으로 돕니다(채널이 하나도 없으면 `config_invalid field=channels`). 명령을 받아들일 유일한 사용자. Slack 프로필 → ⋮ → **멤버 ID 복사**. 옛 키 `ownerSlackUserId`도 읽지만(기동 때 `config_deprecated_key` 경고 한 번) 두 값이 다르면 기동하지 않습니다 |
| `channels.discord` | 아니요 | Discord 켜기 `{"ownerUserId", "botTokenFile", "applicationId", "guildIds"?, "mentionFreeChannels"?, "requireMention"?, "laneChannelId"?, "logChannelId"?, "escalationChannelId"?, "displayName"?}`. 없으면 Discord 꺼짐. 키 설명은 [Discord](#discord선택), 봇 만들기는 [Discord 봇 만들기](discord.md) |
| `channels.teams` | 아니요 | Teams 켜기 `{"appId", "tenantId", "clientSecretFile", "ownerAadObjectId", "listen"?, "tokenTenant"?, "guestAadObjectIds"?, "ownerMode"?, "guestModel"?, "graph"?}`. 없으면 Teams 꺼짐. 키 설명은 [Teams](#teams선택) |
| `channels.teams.graph` | 아니요 | Teams 오너 1:1에서 오너의 Teams 채팅을 읽는 도구 켜기 `{"tokenFile"?}`(기본 `secrets/teams-graph-token`). 없으면 지금과 같습니다. 켠 뒤 `ompbot teams login`으로 오너가 한 번 로그인합니다. [Teams 채팅 읽기](#teams-채팅-읽기선택-graph) 참고 |
| `slack.botTokenFile`, `slack.appTokenFile` | Slack을 쓸 때 | 토큰 파일 경로(홈 기준 상대경로 가능). 각각 `xoxb-`, `xapp-`로 시작해야 합니다 |
| `ompExecutable` | 예 | 절대경로(`command -v omp`). 봇 전용 고정 버전을 쓰면 `~/.ompbot/omp/current/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js`([봇 전용 omp](#봇-전용-omp-버전-고정과-프로필) 참고) |
| `ompProfile` | 아니요 | 봇 omp 자식(대화·레인·모니터 턴, 레인 리뷰, `ompbot_dispatch` 단순 위임, `doctor`의 모델 점검)에 줄 `OMP_PROFILE` 이름. 에이전트 폴더가 `~/.omp/profiles/<이름>/agent`로 바뀌고, 물려받은 `PI_CODING_AGENT_DIR`는 뺍니다. omp 규칙 `^[a-z0-9][a-z0-9._-]{0,63}$`을 어기면 `config_invalid field=ompProfile`. 비우면 지금처럼 사람 omp와 같은 `~/.omp/agent`를 씁니다. 재시작해야 반영됩니다 |
| `workspaceDir` | 예 | 일반 대화에서 omp가 작업하는 디렉터리 |
| `timezone` | 아니요 | 봇 시간대(IANA 이름, 예 `"Asia/Seoul"`·`"America/New_York"`). 하루 비용 상한의 날짜 경계, TASKID·레인 ID 날짜, 브리핑·현황판·TASK 문서 시각, `timezone` 없이 등록한 cron과 오프셋 없는 `at`의 시간대가 모두 이 값을 따릅니다. 없으면 서버(호스트) 시간대, 틀린 이름이면 설정 오류로 시작하지 않습니다. 재시작해야 반영됩니다. cron 모니터는 등록할 때의 시간대를 저장하므로 나중에 이 값을 바꿔도 이미 등록한 cron은 그대로입니다 |
| `agent` | 아니요 | 대화를 구동할 자식 에이전트: `"omp"`(기본), `"claude"`, `"agy"`. [claude 에이전트](#claude-에이전트), [agy 에이전트](#agy-에이전트) 참고 |
| `claudeExecutable` | 아니요 | `agent`가 `"claude"`일 때 쓸 claude CLI 절대경로. 비우면 자식 PATH에서 `claude`를 찾습니다 |
| `agyExecutable` | 아니요 | `agent`가 `"agy"`일 때 쓸 Antigravity CLI 절대경로. 비우면 자식 PATH에서 `agy`를 찾습니다 |
| `model`, `thinking` | 아니요 | 봇 세션에 쓸 모델·thinking 수준. 비우면 omp 기본값을 씁니다 (`agent`가 `"claude"`면 `model`은 `claude/<별칭>`에서 claude 별칭만 유효: `fable`·`opus`·`sonnet`·`haiku`, `"agy"`면 `agy/<agy models의 id>`) |
| `sessionRetentionDays` | 아니요 | `ompbot gc`가 이전 대화 세션과 오래 쉰 채널 스레드 세션을 지우기까지의 일수(기본 30). 아직 처리되지 않은(pending·dispatched) 메시지가 있는 대화방은 기간이 지나도 지우지 않고, 세션 폴더가 아직 없는 대화방은 원장 행의 갱신 시각으로 판단합니다. 세션 폴더 자리에 심링크가 있으면 그 대화방은 건드리지 않습니다. `--dry-run`도 지워질 턴 스냅샷 수를 셉니다 |
| `idleTimeoutMinutes` | 아니요 | 이 시간(분) 동안 쓰지 않은 omp 프로세스를 내립니다. 세션은 유지되고 다음 메시지에서 다시 띄웁니다(기본 30, `0`이면 끄기). 모니터 자식은 일이 끝나고 2분(이 값이 더 짧으면 이 값) 뒤 내리고, `0`이면 모니터도 내리지 않습니다 |
| `skillReviewTurns` | 아니요 | 오너 DM 답변 턴 몇 회마다 백그라운드 스킬 리뷰를 돌릴지(0이면 끔, 기본 10 — 리뷰 1회는 모델 토큰 소모) |
| `mentionFreeChannels` | 아니요 | 채널 ID 배열. 이 채널에서는 오너 메시지를 멘션 없이도 받아들입니다(혼자 쓰는 채널용). 예: `["C0123456789"]` |
| `peerBots` | 아니요 | 이 봇을 멘션한 채널 글을 요청으로 받아 줄 다른 봇 목록 `[{"userId": "U…", "name": "떡"}]`(`userId`는 `U` 뒤 대문자·숫자 8자 이상이고 오너 id는 안 됨, `name`은 1~32자). 기본은 없음(모든 봇 글을 버림). [피어 봇](#피어-봇) 참고 |
| `requireMention` | 아니요 | `true`면 채널에서는 이 봇을 멘션한 글만 받습니다(`mentionFreeChannels`·스레드 참여 무시, DM은 그대로). 기본 `false` |
| `peerHopLimit` | 아니요 | 스레드마다 피어 입력 상한 `{"turns": 3, "windowMinutes": 30}`(기본값). `windowMinutes` 안에 `turns`개를 넘는 피어 글은 버립니다 |
| `escalationChannel` | 아니요 | Slack 요청의 승인 카드를 올릴 Slack 채널 id(`C…`/`G…`). Discord 요청은 `channels.discord.escalationChannelId`를 씁니다. [승인](#승인) 참고 |
| `logChannel` | 아니요 | #log 장부 채널 id(`C…`/`G…`). 슬랙 대화나 작업 레인의 답 첫 줄이 `✅ 완료`(또는 `:white_check_mark: 완료`)로 시작하면 그 답의 사본이 `📒 완료 보고 사본 · <요청 위치 + 원 스레드 링크>` 머리말과 함께 이 채널 최상위에 한 번 올라갑니다(모니터 답·알림·승인 카드·명령 답은 제외). 이 채널의 메시지는 멘션이 있어도 턴이 되지 않습니다(`inbound_dropped reason=log_channel`). Discord 대화와 Discord 스레드의 작업 레인은 `channels.discord.logChannelId`로 같게 복사되고, 한 플랫폼의 사본이 다른 플랫폼 채널로 가지는 않습니다 |
| `herdr` | 아니요 | herdr 켜기. `{}`이면 PATH의 `herdr`, `{"bin": "/절대경로/herdr"}`이면 그 파일을 로컬 herdr로 씁니다(`bin`이 절대경로가 아니면 `config_invalid field=herdr.bin`). 없으면 꺼짐: `ompbot_dispatch`는 simple만 보이고 `[TASK]` 스윕이 돌지 않습니다. 데몬 시작 때만 읽습니다. [herdr(선택)](#herdr선택) 참고 |
| `dispatchHosts` | 아니요 | herdr 필요(`herdr` 없이 넣으면 `config_invalid field=herdr`). 원격 위임 대상. 예: `{"wsl": {"ssh": "wsl", "workDir": "/home/<user>/work", "herdrBin": "/home/<user>/.local/bin/herdr"}}`. `herdrBin`은 비대화형 ssh의 PATH에 herdr가 없을 때 절대경로로 지정합니다. `ompArgs`(문자열 배열, 예: `["--prewalk"]`)를 넣으면 그 호스트에 띄우는 herdr 워커 omp에 덧붙입니다(`herdr agent start … -- <인자>`). 인자는 그 호스트의 omp 설정으로 해석되므로(`--prewalk`면 그 호스트의 smol 모델로 넘어감) 그 호스트 smol을 먼저 맞추고 켭니다. `workerOmpArgs`를 물려받지 않습니다 |
| `workerOmpArgs` | 아니요 | 로컬 herdr 워커 omp에 덧붙이는 인자(문자열 배열, 원소는 빈 문자열이면 안 됨). 예: `["--prewalk"]`이면 워커가 기본 모델로 계획을 세우고 첫 edit/write부터 smol 모델로 넘어갑니다. `ompbot_dispatch` taskSpec 신규 시작과 재개 때 죽은 에이전트 재기동에 붙고, `omp -p` 단순 위임·원격 호스트(`dispatchHosts.<h>.ompArgs`를 씀)·대화 세션에는 붙지 않습니다. 배열이 아니거나 빈 문자열이 있으면 `config_invalid field=workerOmpArgs` |
| `herdrBoard` | 아니요 | herdr 필요(`herdr` 없이 넣으면 `config_invalid field=herdr`). herdr-web-ui 작업 보드. 예: `{"url": "https://herdr.example.com/task/", "api": "http://127.0.0.1:7317"}`(`api` 기본값이 이 값). 넣으면 위임 접수 카드·결정 요청·Outcome 알림에 `진행 보기`/`작업 보드` 카드 링크가 붙습니다. 카드 키는 `api`의 `/api/machines`로 정합니다: 로컬 에이전트는 pane id, `dispatchHosts`의 호스트는 같은 이름 머신의 `<machine id>:<pane id>`. 못 찾으면 보드 첫 화면으로 링크합니다 |
| `taskAutoLand` | 아니요 | `herdr` 없이도 넣을 수 있습니다(작업 레인이 씀. `[TASK]` 스윕은 `herdr`가 있어야 돎). 조건을 채운 개인 저장소 `[TASK]`를 Outcome 도달 때, 작업 레인을 닫힐 때 봇이 스스로 머지. `{"repos": ["/절대경로/저장소", …], "maxRisk": "L2"}`(`repos`는 1개 이상의 절대경로, `maxRisk` 기본 `L2`, 선택 `review`는 레인 자동 머지 전 [독립 리뷰](#레인-자동-머지-전-독립-리뷰-review)). [`[TASK]` 자동 머지](#task-자동-머지)·[작업 레인](#작업-레인) 참고 |
| `lanes` | 아니요 | 작업 레인 설정. `{"completionNudges": 2}`(기본값): 레인 턴이 완료 주장(`ompbot_claim_done`) 없이 끝나면 코어가 그 레인에 자동 재촉을 오너 메시지마다 최대 이만큼 보냅니다. `0`이면 끕니다(0 이상의 정수만 받음). `reload`로 바로 반영. [작업 레인](#작업-레인) 참고 |
| `restartNotice` | 아니요 | `false`면 drain 재시작 알림을 보내지 않습니다(기본 `true`). [재시작과 drain](#재시작과-drain) 참고 |
| `recallEnabled` | 아니요 | `false`면 새 턴 프롬프트에 지난 대화 회상을 붙이지 않습니다(기본 `true`). [대화](#대화)의 "지난 대화 회상" 참고 |
| `costCap` | 아니요 | 비용 상한(omp 정가 환산, 실제 청구액 아님). `{"turnUsd": 20, "dailyUsd": 300}`처럼 양수만 받고 키가 없으면 그 상한은 꺼집니다. `turnUsd`에 닿으면 그 턴에 마무리 지시를 한 번 보내고, 1.5배를 넘으면 턴을 멈춥니다(하위 에이전트 비용은 이 누계에 없음). `dailyUsd`는 봇 시간대(`timezone`) 하루 합계(하위 에이전트 포함, omp가 턴 도중 죽은 턴도 한 번 포함)로, 넘으면 모니터 발화를 멈추고 오너에게 하루 한 번 알립니다. 오너 대화는 막지 않고 `!budget off`로 그날만 풀 수 있습니다. `reload`로 바로 반영 |
| `turnSnapshot` | 아니요 | `{"repos": ["/절대경로/저장소", …]}`. 대화 턴마다 그 작업 트리를 턴 앞뒤로 스냅샷해 `!undo`로 되돌릴 수 있게 합니다. 항목마다 지금 git 작업 트리여야 하고(아니면 `config_invalid field=turnSnapshot.repos`), `reload`로 바로 반영. [턴 되돌리기](#턴-되돌리기undo) 참고 |
| `watcherRoots` | 아니요 | 절대경로 배열. `watcher` 모니터 트리거가 감시할 수 있는 디렉터리의 상한입니다. 트리거의 `root`는 심볼릭 링크를 풀고 난 실제 경로가 이 중 하나 안에 있어야 하고, 비어 있으면 watcher 트리거를 만들 수 없습니다. 예: `["/home/<user>/work"]` ([모니터](#모니터) 참고) |
| `webhook` | 아니요 | `{"port": 8123, "bind": "127.0.0.1"}`. `webhook` 모니터 트리거를 받는 loopback HTTP 리스너입니다. `bind`는 `127.0.0.1`(기본)·`::1`만 허용하고 그 밖의 값이나 범위(1~65535) 밖 포트는 설정 오류입니다. 없으면 서버를 띄우지 않고 webhook 트리거를 만들 수 없습니다. 데몬 시작 때만 읽습니다([모니터](#모니터) 참고) |
| `dashboard` | 아니요 | `{"port": 7331, "bind": "127.0.0.1", "herdrWebUrl": "https://herdr.example.com/"}`. `ompbot dashboard` 현황판의 기본 포트·주소입니다(플래그 `--port`·`--bind`가 우선). `bind`는 `127.0.0.1`(기본)·`::1`만 허용하고 그 밖의 값이나 범위(1~65535) 밖 포트는 `config_invalid field=dashboard.…`입니다. `herdrWebUrl`(선택, http(s) 주소)은 에이전트 보드 카드의 "herdr에서 답하기" 링크가 여는 herdr-web-ui 주소이며, 없으면 링크를 그리지 않습니다. [현황판](#현황판) 참고 |
| `maxBundleBytes` | 아니요 | `ompbot backup` 번들 크기 상한(바이트, 기본 512MB). 1 이상의 정수여야 합니다. 잘못된 값은 기본값으로 돌아가지 않고 config 검증(`config_invalid field=maxBundleBytes`)에서 실패하므로 backup뿐 아니라 다음 데몬 기동·`gc`도 실패합니다. `--max-bundle-bytes`를 주면 그 값이 우선하고 config의 값은 읽지 않습니다 |
| `offsite` | 아니요 | 오프사이트 백업 대상 `{ "ssh": "별칭 또는 user@host", "remoteDir": "/절대경로 또는 ~/경로", "keep": 14 }`. `ssh`는 ssh 별칭이나 `user@host`(공백·`-` 시작 불가), `remoteDir`는 `/` 또는 `~/`로 시작하는 평범한 문자(영숫자와 `._+=@%:/-`, `..` 불가)의 경로, `keep`은 원격에 남길 종류별 최신 일일 파일 수(1 이상, 기본 14)입니다. 없으면 오프사이트 복제와 `offsite_age` 게이트가 모두 꺼집니다. 잘못된 값은 `config_invalid field=offsite.…`로 실패합니다 |
| `slack.appId`, `slack.teamId`, `slack.botUserId` | 아니요 | 기록용. `slack.teamId`(워크스페이스 ID `T…`)가 있으면 현황판 턴 상세에 `슬랙 스레드에서 답하기` 링크가 뜹니다 |
| `briefing` | 아니요 | `{"chromium": "<PATH의 이름 또는 절대경로>"}`. `!brief`·`ompbot briefing`이 그림을 그릴 chromium(기본 `chromium`). 기동 때 존재를 확인하지 않고, 없으면 브리핑 실패 줄로 알립니다. 브라우저가 끝난 뒤 `--out`에 새 정규 파일이 없으면(기존 파일은 그리기 전에 지움) 실패하고, 브라우저가 남긴 마지막 오류 줄을 이유로 붙입니다. `reload`로 바로 반영 |

config.json의 모르는 최상위 키, 제어문자가 든 `dispatchHosts` 이름, 슬래시만 남는 `offsite.remoteDir`(예 `//`)은 거부하지 않고 데몬 기동 때 `config_warning field=<키 이름> reason=unknown_key|unsafe_name|unusable` 경고를 남깁니다(값은 기록하지 않음). `offsite.remoteDir`의 연속 슬래시는 하나로 접어 씁니다. config.json을 읽을 수 없으면(디렉터리·권한 등) `config_unreadable: <경로> (<errno>)`이고, 파일이 없을 때만 `config_missing`입니다. 파일 앞의 UTF-8 BOM은 무시합니다. `OMPBOT_HOME=`(빈 값)은 설정하지 않은 것과 같아 `~/.ompbot`을 씁니다.

### 6. 점검

```sh
bun src/main.ts doctor
```

홈 권한 0700, 토큰 파일 0600과 접두사, omp·bun 경로와 버전(`bun` 줄은 PATH의 bun 경로와 그 bun의 `--version`을 보이고, 실행 중인 bun과 다르면 `(running <버전>)`을 붙임), omp 런타임(`omp runtime`: 패키지 launcher인지, bun이 omp의 `engines.bun`을 만족하는지 — 데몬이 omp를 띄우기 전마다 하는 검사와 같습니다), omp가 쓸 수 있는 모델 수(`omp models`: 봇이 omp에 주는 환경으로 `omp models --json`을 돌려 `available=0`이면 실패 — 로그인도 API 키도 없으면 모든 턴이 `No default model selected`로 실패하고 슬랙에는 `[turn failed] omp_no_model …` 안내가 갑니다), Slack `auth.test`(Slack을 쓰지 않으면 `ok slack: off (channels.slack not set)` 한 줄), Discord를 쓰면 토큰 파일과 `discord users/@me`·`discord gateway/bot`, 작업 레인 자동 재촉 설정(`ok lane nudges: completionNudges=2`, 끄면 `off (lanes.completionNudges=0)`), 백업 번들 존재·나이(36시간)를 확인하며(데몬이 한 번도 뜨지 않아 `ompbot.db`가 없는 첫 설치에서는 백업 줄이 `warn backup bundle: stamp=missing …`이고 종료 코드에 들어가지 않습니다 — 데몬이 처음 뜰 때 첫 백업을 만듭니다), 토큰 값은 출력하지 않습니다. 토큰 파일·omp 경로 실패 줄에는 고치는 명령(`chmod 600 …`, `command -v omp`로 `ompExecutable` 고치기 등)이 붙고, 토큰 파일에 문제가 있어도 나머지 점검은 이어서 돕니다(그때 `slack auth.test`는 `skipped`). `config.json` 문법 오류는 파서가 기대한 것과 흔한 원인(끝 쉼표·빠진 쉼표·따옴표 없는 키)을 알려 줍니다. config에 `herdr`가 있으면 로컬 `<herdr.bin 또는 herdr> --version`을 돌려 `ok herdr: <경로> <버전>` 또는 `fail herdr: <경로> <사유>`를 내고, 실패면 종료 코드가 1이 됩니다. config에 `dispatchHosts`가 있으면 이어서 호스트마다 `ssh -o BatchMode=yes -o ConnectTimeout=5 <ssh> true`를 돌려 `ok dispatch host <이름>: ssh <별칭>` 또는 `fail dispatch host <이름>: <ssh stderr 첫 줄> (warning only)`를 한 줄씩 냅니다. 꺼 둔 호스트일 수 있어 이 줄은 경고일 뿐 종료 코드를 바꾸지 않습니다. 첫 설치의 `warn backup bundle` 말고 나머지 줄이 모두 `ok`면 다음 단계로 갑니다. `ompbot.db`는 데몬이 처음 뜰 때 만들어지므로 그 전에 `bun src/main.ts backup`을 직접 돌리면 `db_missing`으로 실패합니다. 서비스를 띄우면 데몬이 첫 백업을 만들어 이 줄도 `ok`가 됩니다.

### 7. 서비스 등록

[`packaging/`](../packaging)의 `ompbot.service`·`ompbot-backup.service`·`.timer`·`ompbot-gc.service`·`.timer`·`ompbot-dashboard.service`는 `@BUN@`·`@REPO_DIR@`·`@PATH@` 자리표시자가 든 템플릿입니다. `units render`가 지금 실행한 bun(`process.execPath`), 이 체크아웃, `HOME`으로 채워 씁니다. `OMPBOT_HOME`을 지정했으면 서비스마다 `Environment=OMPBOT_HOME=<경로>` 줄이 들어갑니다.

```sh
bun src/main.ts units render --dry-run   # 쓰지 않고 '# <파일 이름>'과 내용을 출력
bun src/main.ts units render             # ~/.config/systemd/user에 여섯 파일 작성(--out <디렉터리>로 바꿈)
systemctl --user daemon-reload
systemctl --user enable --now ompbot
systemctl --user status ompbot
```

`units render`는 systemctl을 실행하지 않고 실행할 명령만 출력합니다. 대상에 내용이 다른 유닛 파일이 이미 있으면 아무 파일도 쓰지 않고 그 파일 이름을 알린 뒤 종료 코드 2로 끝납니다(직접 고친 유닛을 덮어쓰지 않음). 내용이 같으면 그대로 두고 0입니다. `OMPBOT_HOME`에 공백·`"`·`\`·`%` 같은 문자가 있으면 `Environment="OMPBOT_HOME=<경로>"`로 인용해(`%`는 `%%`) 쓰고, 개행·NUL이 들면 종료 코드 2로 거부합니다. `--out ''`, 파일인 `--out`(또는 그 상위), 디렉터리인 유닛 경로도 종료 코드 2입니다. 빈 `OMPBOT_HOME`은 설정하지 않은 것과 같습니다.

유닛은 `KillMode=mixed`로 정지 때 데몬 본체에만 SIGTERM을 보냅니다. 기본값이면 omp 자식이 cgroup SIGTERM을 먼저 받아 `omp_exit expected=false`가 찍히고 drain이 턴을 마무리할 시간도 없어지기 때문이며, 데몬이 끝나면 남은 프로세스는 바로, 데몬이 `TimeoutStopSec=90` 안에 끝나지 않으면 함께 SIGKILL됩니다. 이미 설치한 호스트는 설치된 `ompbot.service`를 `units render --dry-run` 출력과 맞추거나(옮겨 두고 `units render`로 다시 쓰기) 두 줄을 직접 고친 뒤 `systemctl --user daemon-reload` 하면 다음 재시작부터 적용됩니다.

봇에게 DM을 보내 👀와 답이 오면 설치가 끝난 것입니다. 매일 백업 타이머는 [백업](#백업)에서 등록합니다.

#### 한 호스트에 설치본 둘

같은 체크아웃으로 두 번째 봇(예: 검증자 [피어 봇](#피어-봇))을 띄울 때는 홈과 유닛 이름을 나눕니다. 홈마다 DB·소켓(`ompbot.sock`)·잠금·세션·백업이 따로 생기므로 겹치지 않고, `~/.omp/agent`(스킬·메모리)만 함께 씁니다.

```sh
OMPBOT_HOME=~/.ompbot-<이름> bun src/main.ts init --owner <Slack 멤버 ID>
OMPBOT_HOME=~/.ompbot-<이름> bun src/main.ts units render --instance <이름>   # 이름: 소문자로 시작, a-z0-9-, 24자 이내
systemctl --user daemon-reload
systemctl --user enable --now ompbot-<이름> ompbot-<이름>-backup.timer ompbot-<이름>-gc.timer
```

- `--instance`는 `OMPBOT_HOME`이 있어야 하고(없으면 종료 코드 2), `ompbot-<이름>.service`·`ompbot-<이름>-backup.service/.timer`·`ompbot-<이름>-gc.service/.timer`를 씁니다. 현황판 유닛은 만들지 않습니다. `--instance` 없는 출력은 전과 같습니다. 이름이 `backup`·`gc`·`dashboard`이거나 `-backup`·`-gc`·`-dashboard`로 끝나면 다른 유닛 이름과 겹쳐 쓸 수 없습니다(종료 코드 2).
- Slack 앱은 [`packaging/slack-manifest-peer.json`](../packaging/slack-manifest-peer.json)으로 만듭니다. 슬래시 명령이 `/…-ompbot`으로 고정이라 두 번째 앱에는 슬래시 명령을 넣지 않았고, `!` 명령은 그대로 씁니다. 매니페스트의 봇 `display_name`은 영문이어야 합니다(Slack이 사용자 이름으로 바꿀 수 없으면 매니페스트를 거부합니다). 앱 이름은 한글이어도 됩니다. 메시지 위에 한글 봇 이름을 띄우려면 앱을 만든 뒤 **설치하기 전에** App Home → App Display Name → Edit에서 Display Name을 한글로, Default Username을 영문으로 저장합니다. 설치 뒤에 바꾸면 설정에는 저장되지만 봇 사용자에는 반영되지 않습니다. 핸들(`@…`)은 처음 설치할 때 정해지고, 같은 이름이 이미 있으면 Slack이 뒤에 숫자를 붙입니다.
- `ompbot apply`는 자기 설치본을 반영한 뒤 같은 체크아웃으로 도는 다른 설치본(`ompbot-<이름>`)도 차례로 반영합니다([재시작과 drain](#재시작과-drain) 8단계). 따로 재시작하지 않아도 됩니다.

### AI 에이전트에게 설치 맡기기

사람이 해야 하는 일은 Slack 앱이나 Discord 봇 만들기, 토큰 붙여넣기, `omp login`의 브라우저 인증뿐입니다. 나머지는 저장소를 읽고 셸을 실행할 수 있는 코딩 에이전트(Claude Code, Codex, omp 등)에게 맡길 수 있습니다. `init`·`doctor`·`units render`·`gates`는 결과를 종료 코드로 알려 주므로 에이전트가 성공 여부를 스스로 확인할 수 있습니다. 아래를 그대로 붙여넣으세요.

```text
Install this repository (ompbot) into the systemd user session on this Linux machine. Follow the "요구 사항" (Requirements) and "설치" (Installation) sections of docs/guide.md.

1. Check that `systemctl --user status` responds. If this is WSL2 and it does not, tell me how to add systemd=true under [boot] in /etc/wsl.conf, then stop.
2. Check `bun --version`. If bun is missing, install it. Come back to this after step 3: if bun is older than engines.bun in the package.json of the installed omp, run `bun upgrade`.
3. If omp is missing, install it with `bun install -g @oh-my-pi/pi-coding-agent`. Do not use the standalone executable (install script or binary release); ompbot rejects it as omp_launcher_standalone. Confirm that `readlink -f "$(command -v omp)"` resolves to .../@oh-my-pi/pi-coding-agent/dist/cli.js.
4. `omp login` is interactive, so I will run it myself. Just tell me the command; when I say I am done, verify with `omp --version`, then run `omp models --json` and confirm its `models` array is not empty. It exits 0 even when the array is empty, so judge by the content, not the exit code; an empty list means every bot turn will fail.
5. Run `bun install && bun test && bun run check` and confirm 0 failures.
6. Ask me whether I use Slack or Discord (one is enough). For Slack, ask for my Slack member ID (starts with U) and run `bun src/main.ts init --owner <ID>`. For Discord, ask for my Discord user ID and the bot's Application ID (17-20 digits each) and run `bun src/main.ts init --platform discord --owner <user ID> --app-id <Application ID>`.
7. I will create the Slack app or Discord bot myself. Walk me through docs/guide.md "2. Slack 앱 만들기" (Create the Slack app) or docs/discord.md (Create the Discord bot) step by step. Never take tokens over chat. I will write them myself in a terminal with `umask 077; cat > ~/.ompbot/secrets/slack-bot-token` (bot token) and `cat > ~/.ompbot/secrets/slack-app-token` (app token) for Slack, or `umask 077; cat > ~/.ompbot/secrets/discord-bot-token` for Discord. Only check that the token files are mode 0600; never read or print their contents.
8. Run `bun src/main.ts doctor` and confirm it exits 0. The `warn backup bundle: stamp=missing` line is expected here (the daemon makes the first backup when it first starts) and does not count. If any line fails, report that line and its cause, then stop.
9. Run `bun src/main.ts units render`, then `systemctl --user daemon-reload`, then `systemctl --user enable --now ompbot ompbot-backup.timer ompbot-gc.timer`. Confirm daemon_ready appears in `journalctl --user -u ompbot -n 50`. Check `loginctl show-user "$USER" -p Linger`; if it says `Linger=no`, tell me that the bot stops when I log out and that `loginctl enable-linger "$USER"` keeps it running after logout and reboot.
10. Confirm `boot_backup_done` appears in `journalctl --user -u ompbot -n 50`, then run `bun src/main.ts doctor` again. This time every line must be ok.
11. Finally, ask me to send the bot any DM. At every step, report the actual output and any failure verbatim; never claim a success you did not verify.
```

## 사용법

### 대화

- **DM**: 메시지를 보내면 👀가 달리고, omp의 답이 같은 스레드에 올라옵니다. DM의 스레드 답글도 같은 대화방입니다.
- **채널**: 봇을 초대(`/invite @ompbot`)하면 그 채널에서 대화할 수 있습니다. 채널 본문에 새로 쓴 메시지(루트)는 하나하나가 독립 대화방이 되고(아래 채널 스레드), 채널 본문 대화방(`slack/ch/<채널ID>`)에는 루트로 친 명령(`!model …`, `!new`, `!followup …` 등)과 슬래시 명령만 갑니다. 그래서 루트로 친 `!new`·`!queue`·`!followup`은 채널 본문 대화방에만 적용되고, 진행 중인 루트 작업에는 닿지 않습니다. 루트 작업을 새로 시작하거나 대기열을 보거나 끝난 뒤 이어 보내려면 그 루트 스레드에 답글로 칩니다. 오너가 봇을 멘션한 메시지(`@ompbot 빌드 고쳐줘`)와, 봇이 이미 답한 스레드 안의 오너 답글만 받습니다. 다른 사람의 메시지와 멘션은 무시하지만 봇의 답은 채널 멤버 모두가 봅니다. 명령도 `@ompbot !model`처럼 멘션과 함께 씁니다.
- **채널 스레드**: 루트 메시지와 그 스레드의 답글이 하나의 독립 대화방(`slack/ch/<채널ID>/t/<루트ts>`)입니다. 새 루트를 쓰면 새 대화방이 열리고, 그 스레드만의 omp 세션으로 이어져 채널 본문이나 다른 스레드와 컨텍스트가 섞이지 않습니다. 답·승인 요청·작업 등록·파일 올리기는 그 루트 스레드로 갑니다. 모델·thinking을 따로 고르지 않은 스레드는 채널 본문에서 고른 값을 물려받고, 스레드에서 고르면 필드별로 스레드 값이 이깁니다. `!new`·`!compact` 같은 명령은 그 스레드에만 적용됩니다. 슬래시 명령은 Slack이 스레드 정보를 주지 않아 항상 채널 본문에 적용되므로, 스레드 설정은 `!model`처럼 `!` 형태로 바꾸세요.
- **혼자 쓰는 채널**: `mentionFreeChannels`에 등록하면 멘션 없이도 오너 메시지를 받습니다. 봇이 반응하지 않길 원하는 스레드는 `!shutup`으로 뮤트합니다.
- **끼워 넣기**: omp가 일하는 중에 같은 대화방에 보낸 메시지는 진행 중인 작업에 끼워 넣습니다(steer). 채널에서는 같은 루트 스레드의 답글만 끼워 넣고, 다른 루트는 끼워 넣지 않고 자기 대화방에서 따로 돌며 자기 스레드에 답합니다. 최근 스레드를 짐작해 이어 붙이지 않으므로, 같은 작업의 후속은 그 작업의 스레드에 답글로 쓰세요. DM처럼 한 대화방 안에서 끼워 넣은 메시지가 다른 스레드에서 왔으면, 답이나 실패 알림이 기록될 때 그 스레드에 `↪ 이 요청은 진행 중이던 작업에 합쳐져서 답을 다른 스레드에 올렸어` 안내와 답 첫 줄, 답이 달린 스레드 링크를 한 번 올립니다. 끼워 넣지 않고 다음 작업으로 줄 세우려면 `!followup`을 씁니다. 턴이 끝나는 순간 들어온 메시지는 끝난 턴에 묶이지 않고 새 턴으로 처리됩니다. 끝난 실행에 이미 전달됐을 수 있어 드물게 같은 메시지가 두 번 처리될 수 있습니다(유실보다 중복을 택함, 로그 `steer_turn_ended`).
- **omp 출력 판독 실패**: omp 자식 stdout에 JSON 객체가 아닌 줄(깨진 JSON, `null`, 배열; 빈 줄 제외)이 오면 진행 중인 턴은 `omp stream unreadable` 오류로 끝나 실패 안내가 가고, 자식을 멈춰 다음 메시지는 새 자식으로 시작합니다. 턴이 없을 때는 `omp_stream_unreadable` 경고 로그만 남습니다. 모르는 이벤트 타입(JSON 객체)은 무시합니다.
- **답 전달**: 턴이 아직 돌고 있어도 끝맺은 답(stop)은 턴이 이어지는 순간(할 일 리마인더·rule-guards 이어 가기·끼워 넣은 메시지) 바로 그 스레드로 갑니다. `wait` 호출과 같은 메시지에 쓴 20자 이상의 글(대기 중 상태, 끼워 넣은 질문의 답)도 그 순간 갑니다. 이런 중간 답은 ⏳ 상태 메시지를 끝내지 않고, 턴이 끝나면 이미 보낸 글(공백만 다르거나 거의 그대로 다시 쓴 글 — 공백을 정규화한 문자 바이그램 Dice 0.9 이상)을 뺀 나머지 답이 소요시간 푸터와 함께 가며 상태 메시지를 마무리합니다. 남은 답이 없으면 `✅ 위 답으로 마칩니다`가 그 역할을 합니다. 한 턴의 남은 답이 여럿이면 시간순으로 빈 줄을 두고 한 답에 담고, 바로 앞 답을 거의 그대로 다시 쓴 답은 뒤 답 하나만 남깁니다. 그 밖의 도구 호출 사이 텍스트는 보내지 않고, 모니터 답은 중간 전달 없이 마지막 답만 씁니다. `✅ 완료` 보고 사본과 끼워 넣은 다른 스레드 안내는 턴이 끝날 때 턴 전체 답으로 한 번만 만듭니다.
- **답 보기 전에 보낸 메시지**: 끝맺은 답이 아직 스레드에 오르기 전이거나 그 답이 오르기 전에 받은 메시지를 끼워 넣을 때는, omp에 "직전 답은 이미 전달됐으니 다시 쓰지 말고 새 질문·지시·명령만 처리하라"는 한 줄을 앞에 붙여 같은 답이 두 번 나가지 않게 합니다. 답이 오른 뒤 받은 메시지(곧바로 보낸 `취소해` 포함)에는 붙이지 않고, 장부의 메시지 원문에도 남기지 않습니다.
- **메시지 모양**: 답은 Slack `markdown` 블록으로 보내 표·헤더·구분선·인용·체크리스트를 Slack이 직접 그립니다. 11,000자까지는 글 하나이고, 더 길면 코드블록과 표가 갈라지지 않게 나눠 보냅니다. 코드블록이 조각 경계에 걸리면 줄머리 백틱 run 길이(3개 이상)를 기억해 같은 길이로 닫고 다시 열며(정보 문자열 `md`·`card` 등은 다시 붙이지 않음), 안쪽의 더 짧은 펜스로는 바깥 펜스가 끝나지 않습니다. 알림 미리보기용 `text`에는 mrkdwn 변환본 앞 3,000자가 들어갑니다. 본문(코드 밖)에 `<@U…>`·`<#C…>`·`<!here>` 같은 멘션이 있는 답도 `markdown` 블록으로 가되, 블록 안에서는 읽을 이름(오너 `@오너`, `peerBots` `@<이름>`, 그 밖의 사용자 `@사용자`, `#채널이름`·`#채널`, `@here`·`@channel`·`@everyone`·`@그룹`)으로 바뀌고, 원래 토큰은 첫 글의 markdown 바로 아래 회색 `🔔 <토큰들>` 줄(등장 순서, 중복 제거, 최대 20개·1,500자, 나머지는 `외 N개`)에 그대로 실려 알림이 가고 누를 수 있습니다. `text`에는 원래 토큰이 그대로 있고, 토큰이 든 글의 `text`는 3,000자에서 자르지 않고 그 글 전체를 담아 `text`만 읽는 피어 봇이 멘션과 요청을 그대로 받습니다. 모니터 제목 줄의 토큰도 `🔔` 줄 맨 앞에 실립니다. 코드블록·인라인 코드 안의 멘션 모양은 바꾸지 않고 `🔔` 줄에도 넣지 않습니다. 코드블록은 줄 맨 앞의 백틱 3개 이상으로 열리고 같은 개수 이상의 백틱 줄로만 닫히므로, ` ```` ` 펜스 안에 ` ``` ` 펜스를 넣은 예시도 통째로 코드로 봅니다. 모니터 글(`monitor/` origin)은 첫 줄 `⏰ <이름>`(150자 이하)이 첫 글 맨 위 제목(header) 블록이 되고 본문은 그 줄 없이 시작합니다. 한 글에 다 들어가지 않는 표가 있는 답은 예전처럼 mrkdwn 글로 가고, 이때 markdown 표는 고정폭 블록으로 바뀝니다. 두 줄 이상인 시스템 알림(놓친 메시지·게이트·지연 알림 등)은 첫 줄(150자 이하, `*`·`` ` ``·멘션 같은 서식은 벗김)이 제목, 나머지가 본문인 카드로 가고, 한 줄 알림은 그대로 글 하나입니다. Slack이 카드 블록을 거부(`invalid_blocks`)하면 로그 `notice_blocks_rejected`를 남기고 블록 없이 한 번 다시 보냅니다. Slack이 `markdown` 블록을 거부(`invalid_blocks`)하면 로그 `markdown_blocks_disabled`를 한 번 남기고 그 답부터 데몬이 다시 뜰 때까지 모든 답을 mrkdwn 글로 보냅니다. 재전송된 답은 첫 글 위에 `(중복 가능: 재전송)` 회색 줄이 붙습니다. 본문 링크 `[글](url)`의 URL에 `|`·`<`·`>`가 있으면 Slack 링크로 바꿀 때 `%7C`·`%3C`·`%3E`로 인코딩하고, 답 글에 든 사용자 영역 문자 U+E000·U+E001은 변환 중에 지웁니다. 인라인 코드는 CommonMark처럼 백틱 run 길이로 판정합니다: N개로 연 코드는 같은 줄의 정확히 N개짜리 run으로만 닫히고(``` ``a ` b`` ```는 코드 하나), 닫는 run이 없으면 그 백틱은 평문입니다. 본문 블록, `text` fallback, 헤더가 같은 경계를 씁니다.
- **카드**: 답 안에 줄 맨 앞 ` ```card `로 열고 ` ``` `로 닫은 펜스(json-render spec JSON, root는 `Card`)가 있으면, 그 자리에서 Slack 네이티브 블록 메시지 하나로 나갑니다(칸은 `section` fields, 표는 `table`/`data_table`, 차트는 `data_visualization`). 앞뒤 글은 따로 `markdown` 글로 나가므로 카드 하나가 든 답은 [글, 카드, 글] 세 메시지가 됩니다. 쓸 수 있는 컴포넌트는 Card·Section·Text·Fields/Field·Table·Chart(pie·bar·line·area)·Divider·Image이고(버튼·`Actions`는 받지 않으므로 `Actions` 안에만 둘 수 있는 LinkButton도 쓸 수 없음), 카드 하나에 표 1개·차트 2개, 표 100행, 차트 제목 50자·라벨 20자, 변환 뒤 블록 47개까지입니다. 카드는 답 하나에 3개까지이고 넘는 것, 다른 코드블록 안의 ` ```card ` 글자, 닫히지 않은 펜스는 글로 남습니다. 검증에 실패한 카드는 펜스 그대로 코드블록 글로 나가고 `card_spec_invalid` 로그에 이유(앞 5개)가 남습니다. 요소 id·root·children에 `__proto__`·`constructor`·`prototype`을 쓴 카드도 검증에서 거부됩니다. 막대·선 차트의 `categories`에 같은 값이 두 번 나와도 거부됩니다(Slack·Discord·ASCII 폴백 공통). Slack이 카드 블록을 거부(`invalid_blocks`)하면 같은 회차에 차트를 ASCII 코드블록으로 바꿔 한 번, 그래도 안 되면 펜스 원문 코드블록 글로 한 번 더 보내고(`card_blocks_rejected`), 차트를 네이티브로 그린 카드가 거부되면 재시작 전까지 모든 카드의 차트를 ASCII로 그립니다(`card_chart_blocks_disabled`). 카드 거부는 다른 글의 `markdown` 블록을 끄지 않습니다. 재전송 머리는 첫 메시지에, 걸린 시간 줄은 마지막 메시지에 붙고(카드여도 카드 블록 끝 회색 줄), `🔔` 멘션 줄은 첫 메시지가 카드면 그 카드 끝에 붙습니다. 카드 안 글의 멘션 토큰은 이름으로 바꾸지 않고 `🔔` 줄에도 모으지 않으므로, 멘션은 카드 밖 글에 씁니다. 평문 경로(markdown 블록이 꺼진 뒤)에서는 펜스가 코드블록으로 보입니다. 카드 칸(Fields)이 10개를 넘으면 Slack에서는 10칸씩 section 여러 개로 나눠 모두 보입니다. 차트 제목·라벨 길이(50·20)는 UTF-16 단위로 셉니다(이모지 하나 = 2). 표·차트가 코드블록으로 그려질 때 열 폭은 한글·이모지를 2칸으로 맞춥니다. 백틱 4개 이상으로 연 펜스는 같은 길이 이상의 백틱 줄로만 닫혀, 그 뒤의 ` ```card ` 펜스도 카드로 나갑니다.
- **카드 색(`tone`)**: 루트 `Card` props에 `tone`(`ok` 초록 `#2EB67D`·`warn` 노랑 `#ECB22E`·`danger` 빨강 `#E01E5A`·`info` 파랑 `#36C5F0`)을 넣으면 Slack은 메시지 왼쪽 색 띠(attachment `color`)로, Discord는 embed 색으로 같은 색을 보입니다. 그 밖의 값은 거부하지 않고 색 없이 나갑니다. Slack이 색 띠 카드를 거부하면 같은 블록을 색 없이(`top_blocks`), 차트가 있으면 ASCII 차트로, 그래도 안 되면 펜스 원문 글로 다시 보냅니다. 봇은 오너 결정 질문을 이 색 띠 카드(제목=질문, `✅ 추천`·`선택지` 칸만)로 쓰고 같은 답에서 `ask` 선택지 버튼을 띄웁니다.
- **진행 상태**: 진행 중인 스레드에는 상태 메시지 하나가 15초 간격으로 갱신되고, 답이 올라오면 지워집니다. 걸린 시간과 도구 수는 답의 마지막 글 아래 회색 한 줄(`✅ mm:ss · 도구 N회`, 실패면 `⚠️`, 도구 0회면 시간만)로 옮겨 가서 한 턴이 끝나면 스레드에 봇 글은 답 하나만 남습니다. 상태 메시지를 지우지 못하면 예전처럼 `✅ 완료 · mm:ss`로 바뀌고, 끼워 넣어 함께 끝난 다른 스레드와 `!queue drop`으로 취소된 스레드의 상태 메시지도 지우지 않고 `✅`·`🚫 취소됨`으로 바뀝니다. 첫 줄은 `⏳ 작업 중 · mm:ss · 도구 N회`이고, 그 아래에 todo 진행(`📋 완료/전체 · 현재 항목`), 끼워 넣은 메시지 수(`📨 추가 메시지 N건 반영`), 모델 재시도 수(`🔁 모델 재시도 N회`), 최근 도구 3개(`· <활동>`, 줄마다 60자까지)가 붙습니다. 값이 0이거나 없는 줄은 빠집니다. 2분 동안 이벤트가 없으면 첫 줄이 `⏸ 응답 없음 2분 · mm:ss`로 바뀝니다.
- **같은 도구 반복 감지**: 한 턴 안에서 같은 도구를 같은 인자로 불러 같은 결과(오류 여부 포함)를 받은 횟수를 셉니다(연속이 아니어도 셉니다). 3번째에 omp에게 방법을 바꾸라는 steer를 한 번 넣고, 6번째에는 턴을 멈춘 뒤 스레드에 멈춘 이유를 알립니다. 이 턴의 실패 사유는 `stuck-loop: 같은 <도구> 호출 <N>번, 결과 그대로`입니다. 결과가 시간 초과·rate limit·5xx·연결 끊김 같은 일시 오류면 기준이 두 배(6번째·12번째)입니다. 기다림이 정상인 `wait`·`ompbot_request_approval`과 `proc://`·`agent://` 경로의 `read`는 세지 않습니다. 턴을 멈출 때 omp 중단 요청이 실패하면 그 omp를 끄고 실패를 정산합니다(다음 메시지는 새로 띄운 omp가 같은 세션으로 받음).
- **첨부 받기**: 오너가 올린 이미지·문서는 `~/.ompbot/media/inbound/<ts>/`로 받아(메시지당 최대 6개, 병렬 다운로드, 이미지 25MB·문서 20MB까지) `[첨부: 경로]`로 omp에게 전달됩니다. 오너가 아니거나 봇을 부르지 않은 메시지의 파일은 받지 않고, 받은 파일은 24시간 뒤 지워집니다. Slack이 파일 정보 없이 보낸 파일 공유 글(삭제됐거나 볼 수 없는 파일)은 버리지 않고 본문에 `[첨부 실패: Slack이 파일 정보를 보내지 않았습니다(삭제됐거나 볼 수 없는 파일)]` 줄을 붙여 받습니다. 메시지 `ts`가 Slack 형식(`<초>.<마이크로초>`)이 아니면 첨부를 받지 않고 `[첨부 실패: N개 — 메시지 ts가 올바르지 않아 저장하지 않았습니다]` 줄을 남깁니다(로그 `attachment_bad_ts`).
- **파일 올리기**: 산출물 파일은 host tool `slack_send_file`로 요청한 스레드에 바로 올라갑니다(50MB 이하, 비밀·자격증명 경로의 파일과 내용 어디에든 토큰이 든 파일은 거부 — [보안 메모](#보안-메모)).
- **세션 유지**: 한동안 쓰지 않은 omp 프로세스는 내리고 세션은 남겨 둡니다(대화·레인은 `idleTimeoutMinutes`(기본 30분), 모니터는 일이 끝나고 2분). 다음 메시지가 오면 같은 세션으로 다시 띄웁니다. 봇이 재시작돼도 대화가 이어집니다.
- **인용은 자료**: 전달·인용된 글은 읽을 자료로만 취급하고 지시로 실행하지 않습니다.
- **스레드 맥락(봇 글이 루트인 스레드)**: 오너가 이 봇이 올린 글(⏰ 모니터 글 포함)의 스레드에 처음 답하면(그 스레드의 앞선 오너·피어 글이 장부에 없을 때만, DM·채널 공통) Slack `conversations.replies`로 루트 글 하나를 읽어 `[스레드 맥락 …]` 블록으로 프롬프트 앞에 붙입니다. 그 답이 진행 중인 턴에 끼워 넣어질(steer) 때도 같은 블록이 앞에 붙습니다. 같은 스레드의 두 번째 답부터와 오너가 연 스레드(루트가 오너 글)에는 붙지 않고, 루트 글은 비밀 가리기와 인젝션 경고 검사를 거칩니다. [피어 봇](#피어-봇) 입력에는 매번 루트와 이 봇이 그 스레드에 마지막으로 올린 글 이후의 다른 사람·봇 글(이 봇 글 제외, 30개·16KB까지, 오래된 것부터 잘림)이 인용 펜스 안에 붙습니다. Slack 호출이 실패하거나 10초 안에 끝나지 않으면 맥락 없이 본문만 전달하고 `thread_context_failed`를 로그에 남깁니다.
- **지난 대화 회상**: 새 턴을 여는 오너 메시지가 과거를 가리키면("저번에", "아까", "어제", "전에 말한", "last time" 등) 같은 대화 공간(DM이면 그 DM, 채널이면 그 채널의 모든 스레드)의 최근 90일 장부에서 관련 대목을 최대 4개(3200바이트까지) 날짜·스레드와 함께 프롬프트 앞에 `[이전 대화 회상 …]` 블록으로 붙입니다. 지금 스레드, 다른 채널·DM, 명령과 실패·끼워넣기 알림은 쓰지 않습니다. 못 찾으면 "찾지 못했다"는 한 줄이 붙고, 과거를 가리키지 않아도 새 세션의 첫 턴은 드문 단어가 2개 이상 겹치는 대목만 붙습니다. 진행 중인 턴에 끼워 넣는 메시지에는 붙지 않습니다. 붙을 때마다 로그에 `recall_injected origin=… trigger=past|fresh hits=… bytes=…`가 남고, config `recallEnabled: false`로 끕니다.
- **인젝션 경고**: 전달·인용된 Slack 글, 텍스트 첨부(`text/*` 또는 .txt .md .csv .json .log .yaml .yml .html .xml, 1MiB 이하), 회상·스레드 맥락에 다시 들어가는 봇 답에서 "이전 지시 무시" 같은 지시형 문장을 찾으면 종류와 출처만 밝힌 `⚠️` 경고를 그 자료 앞(첨부는 첨부 줄 끝)에 붙이고 `injection_flagged` 로그를 남깁니다. 경고·로그에 원문은 넣지 않고, 오너가 직접 쓴 글은 검사하지 않습니다. 규칙은 [rlaope/deepseek-bot](https://github.com/rlaope/deepseek-bot)(MIT)의 6가지를 그대로 씁니다.

### 명령

명령은 슬래시 명령(`/model-ompbot …`)으로 쓰거나, 같은 내용을 `!model …`처럼 메시지로 보냅니다. Slack 앱은 등록되지 않은 `/…`를 메시지로 보내지 않으므로, 매니페스트에 슬래시 명령을 추가하기 전에는 `!` 형태를 쓰세요. 명령은 메시지 전체가 명령일 때만 인식합니다. 슬래시 명령의 결과는 명령을 친 DM·채널에 스레드 없이 봇 메시지로 바로 올라옵니다(`/status-ompbot`만 나에게만 보이는 응답으로 즉시 답합니다).

| 입력 | 동작 |
| --- | --- |
| 아무 메시지 | omp에게 전달하고 같은 스레드에 답합니다. 같은 대화방이 작업 중이면 진행 중인 턴에 끼워 넣습니다. 채널의 새 루트는 독립 대화방이라 다른 루트의 작업에 끼워 넣지 않습니다 |
| `/new-ompbot` · `!new` | 진행 중인 턴을 멈추고 새 대화를 시작합니다. 채널 루트·슬래시로 치면 채널 본문 대화방, 루트 스레드 답글로 치면 그 루트 대화방에 적용됩니다 |
| `/status-ompbot` · `!status` | 대화별 상태, 장부 건수, omp 버전, 모니터 개수와 다음 발사, 열린 게이트, drain 상태를 보여 줍니다 |
| `/model-ompbot` · `!model` | 현재 모델과 쓸 수 있는 모델 목록(30개까지)을 보여 줍니다 |
| `!model <번호\|provider/id\|이름 일부>` | 이 대화방의 모델을 바꿉니다. 이름 일부가 여러 개에 맞으면 후보를 보여 줍니다. 작업 중에는 거부합니다 |
| `/thinking-ompbot` · `!thinking [수준]` | thinking 수준을 보여 주거나(인자 없음) 바꿉니다(`off`, `low`, `medium`, `high` 등 모델이 지원하는 값) |
| `/compact-ompbot` · `!compact [지시]` | 쉬는 동안 오래된 컨텍스트를 요약해 줄입니다. 지시를 붙이면 요약에 반영합니다 |
| `/resume-ompbot` · `!resume` | 이 대화방의 저장된 세션 목록(최근 10개)을 보여 줍니다 |
| `!resume <번호\|세션 ID 앞 4자 이상>` | 그 세션을 이어갑니다. 대기 중이던 메시지는 버려지고, 이후 대화는 그 세션에 쌓입니다 |
| `/queue-ompbot` · `!queue` | 진행 중인 작업과 대기열(끼워넣기 대기, 다음 작업)을 번호와 함께 보여 줍니다. 채널에서는 친 대화방의 것만 보이므로, 루트 작업의 대기열은 그 루트 스레드에 답글로 칩니다 |
| `!queue drop <번호>` | 대기열에서 그 번호의 항목 하나만 취소합니다. 그 스레드의 ⏳ 상태 메시지는 `🚫 취소됨`으로 마무리됩니다 |
| `/usage-ompbot` · `!usage` | 턴을 쓰지 않고 이 대화와 전체(보관 중인 omp 세션 파일)의 모델 호출 수·입력·출력·캐시 읽기 비율·비용을 답합니다. gc로 지운 옛 세션은 빠지고, `agent`가 `"claude"`·`"agy"`면 집계하지 않습니다 |
| `/budget-ompbot` · `!budget` | 오늘(봇 시간대) 비용(omp 정가 환산)·상위 오리진·턴/하루 상한([`costCap`](#5-설정-파일-ompbotconfigjson))을 봅니다 |
| `!budget off` · `!budget on` | `off`는 오늘만 하루 상한을 꺼 멈춘 모니터를 다시 돌립니다(봇 시간대 자정에 자동으로 다시 켜짐). `on`은 그날 일찍 다시 켭니다 |
| `/undo-ompbot` · `!undo` | 이 대화의 가장 최근 변경 턴을 승인 카드 뒤에 되돌립니다([턴 되돌리기](#턴-되돌리기undo)). `turnSnapshot`이 없으면 안내만 합니다 |
| `!distill` | 어느 대화(DM·채널·스레드)에서든 그 대화의 최근 세션 내용으로 [스킬 리뷰](#스킬-리뷰)를 지금 한 번 돌립니다. 제안이 있으면 같은 승인 카드가 오고, 이미 리뷰가 돌고 있으면 "이미 리뷰 중", 동결 중이면 "동결 중이라 하지 않았습니다"라고 답합니다. 세션 내용이 없는 대화방(예: 채널 최상위 — 채널 대화는 스레드마다 따로 세션)에서는 리뷰를 돌리지 않고 스레드 안에서 보내라고 답합니다. 슬랙 앱에 슬래시 명령으로는 등록하지 않았으니(`/distill-ompbot`은 매니페스트에 없음) 메시지로 보냅니다. 피어 봇 글에 든 `!distill`은 명령이 아닙니다 |
| `/followup-ompbot` · `!followup <메시지>` | 같은 대화방의 진행 중인 작업에 끼워 넣지 않고, 끝난 뒤 별도 작업으로 보냅니다(답도 그 메시지 스레드에 옵니다). 채널 루트로 치면 채널 본문 대화방 작업 뒤에 줄을 서므로, 진행 중인 루트 작업 뒤에 이어 보내려면 그 루트 스레드에 답글로 칩니다 |
| `!btw <질문>` | 곁질문. 같은 대화방의 진행 중인 작업에 끼워 넣지 않고 그 질문에만 바로 답합니다. 답은 지금까지의 대화 맥락으로 한 번 만들어 `💬 곁질문:`으로 시작하는 별도 글로 그 메시지 스레드에 오고, 진행 중인 작업과 대화 기록은 바뀌지 않습니다. 곁질문은 한 번에 하나만 돌고(도는 중에 또 보내면 실패 알림), 120초 안에 답이 없으면 취소하고 실패 알림을 남깁니다. 작업 중이 아니면 `!btw`를 뗀 질문이 일반 메시지로 처리되고, `agent: "claude"`처럼 곁질문을 지원하지 않는 에이전트면 안내만 합니다. 슬랙 앱에 슬래시 명령으로는 등록하지 않았으니(`/btw-ompbot`은 매니페스트에 없음) 메시지로 보냅니다 |
| `!home` | 보낸 대화를 데몬 알림(턴 실패·제공자 한도·게이트·정체 경고)과 채널 없는 모니터 결과를 받을 곳으로 정합니다. 정하지 않으면 Slack이 있을 때 Slack 오너 DM, 없으면 오너의 가장 최근 1:1 대화, 그것도 없으면 오너가 마지막으로 말한 대화입니다. 오너가 아직 아무 데도 말하지 않았으면 알림은 로그 `owner_notice_unroutable`만 남기고 모니터는 다음 주기로 미룹니다 |
| `!shutup` · `!unshutup` | 채널·채널 스레드 전용. `!shutup`을 보낸 스레드는 오너 메시지에도 반응하지 않고, `!unshutup`이나 봇 멘션으로 풀립니다. 최상위에서 보내면 그 메시지의 스레드가 뮤트됩니다. 뮤트는 재시작에도 유지되고 DM에서는 안내만 합니다 |
| `/brief-ompbot` · `!brief` (`!브리핑`) | 지금 상태(주의·진행·모니터·백업)를 한 장 PNG로 그려 이 스레드에 올립니다(모델 호출 없음, 작업 중에도 사용 가능). 그림은 config `briefing.chromium`으로 그립니다 |
| `작업: <제목> @<절대경로>` | 그 경로에서 작업 레인을 엽니다([작업 레인](#작업-레인)) |
| `멈춰` · `계속` (`!pause` · `!unpause`) | 작업 레인 스레드나 `[TASK]` 스레드 전용. 메시지 전체가 `멈춰`·`잠깐`·`그만`·`stop`·`pause` 같은 말이면 그 레인(또는 그 스레드의 진행 중인 TASK)을 멈추고, `계속`·`재개`·`continue`면 다시 돌립니다. 레인은 ⏸·▶ 버튼으로도 됩니다. TASK는 CLI `ompbot tasks pause|resume <ID>`도 같습니다 |
| `!reopen` · `!reopen <지시>` | 작업 레인 스레드 전용. 닫히고 아직 머지·폐기되지 않은 레인을 같은 세션으로 다시 엽니다(🔄). 다른 메시지는 레인을 닫힌 채로 두고 답만 받습니다 |

모델·thinking 선택은 대화방마다 저장되어 프로세스를 내렸다 다시 띄워도, 데몬을 재시작해도, `/new-ompbot` 뒤에도 유지됩니다. 세션 모델이 provider에서 사라졌으면 대화방에서 고른 모델, 그것도 없으면 config `model`로 바꿉니다(config `model`이 비어 있거나 없는 모델이면 바꾸지 못하고 `model_stale_no_fallback`만 남깁니다). 고른 값은 지우지 않으므로 모델이 돌아오면 다시 적용됩니다. omp 설정 파일(`~/.omp/agent`)은 바꾸지 않습니다.

### 턴 되돌리기(`!undo`)

`turnSnapshot.repos`에 저장소 절대경로를 넣으면 대화 턴마다 그 작업 트리 상태를 턴 앞뒤로 git 객체에 남기고, `!undo`(`/undo-ompbot`)로 이 대화의 가장 최근 변경 턴을 되돌립니다.

```json
"turnSnapshot": { "repos": ["/home/<user>/work/<repo>"] }
```

- 되돌릴 파일 목록을 담은 승인 카드가 먼저 오고, 승인해야 되돌립니다(거부·시간 초과면 그대로 둠). 승인 사이에 새 턴이 시작되면 되돌리지 않습니다. 턴이 도는 중에 보낸 `!undo`는 턴이 끝난 뒤 다시 보내라고 답합니다.
- 대상은 그 턴이 바꾼 파일뿐입니다. 턴 뒤에 다른 손이 고친 파일은 충돌, 동시에 돈 다른 대화의 턴도 바꾼 파일은 겹침으로 남겨 건드리지 않습니다. 턴이 커밋했다면 파일은 그대로 두고 `git revert` 안내만 합니다.
- 중첩 git 저장소(서브모듈·내장 체크아웃, gitlink)가 바뀐 경로는 되돌리지 않고 충돌로 보여 주고, 턴이 만든 파일 자리에 디렉터리가 있으면 지우지 않고 충돌로 알립니다. 되돌리다 한 파일에서 실패하면 그때까지 되돌린 수와 멈춘 파일·사유를 답하고, 그 턴은 되돌림 완료로 표시하지 않아 다시 `!undo`할 수 있습니다.
- 스냅샷은 저장소 밖 임시 인덱스로 찍어 실제 인덱스·작업 트리를 건드리지 않고, 5초를 넘기거나 실패한 저장소는 그 턴에서 빠질 뿐 턴을 막지 않습니다. 직전 턴에서 스냅샷이 빠진 저장소는 `스냅샷 없음: <저장소>`로 알리고 그보다 오래된 턴을 대신 되돌리지 않으며, 겹침 확인 자체가 실패한 저장소는 파일을 모두 겹침으로 남깁니다(`겹침 확인 실패`). 오리진마다 최근 20행만 남고 7일이 지난 행은 `ompbot gc`가 지웁니다.
- `ompbot reload`로 바로 켜고 끕니다.
- 운영 제약: 같은 체크아웃을 ompbot 대화 턴 밖(herdr 워커·사람)에서 고치면 그 변경은 그 턴의 몫으로 구분되지 않습니다. 워커는 자기 worktree를 쓰므로 섞이지 않습니다.

### 승인

되돌리기 어렵거나 오너 환경 밖에 닿는 작업 전에만 host tool `ompbot_request_approval`로 승인 버튼을 띄웁니다: 데이터·백업·사용자 파일 삭제, 강제 푸시·이력 재작성, 키·인증·결제 변경, 다른 사람이 쓰는 서비스 반영, 공개 저장소 push·외부 이슈·PR·메일·웹 게시. 오너가 시킨 범위 안에서 되돌릴 수 있는 일(커밋, 비공개 저장소의 일반 push·머지, 오너 서비스 재시작, 작업 위임)은 카드 없이 하고 보고에 한 일을 적습니다. 오너가 멈추라고 하면 바로 멈춥니다. 이 기준은 시스템 프롬프트의 안전 바닥글 6번에 있고, `persona.md`로 더 좁히거나 넓힐 수 있습니다.

- 카드는 `🔐 승인 요청` 제목, 요약, `할 일`/`이유`/`영향`/`되돌릴 수 없는 이유` 칸(비어 있는 칸은 생략), 버튼 순서로 보입니다. 버튼 아래 마감 시각이 보이고, 30분 안에 버튼이나 카드 스레드 답장이 없으면 거부로 처리됩니다. 결정 뒤에는 제목과 칸은 남고 버튼 자리에 `✅ 승인됨 · HH:MM` 같은 결과 한 줄이 남습니다. 알림 미리보기 텍스트는 예전처럼 요약과 `• 라벨: 값` 줄 전체입니다.
- **외부 공개 카드**: 도구 인자 `external`(어디에 누구에게 공개되는지)을 채우면 제목이 `🌐 외부 공개 승인 요청`이 되고 `🌐 외부 공개` 칸이 붙습니다. `external`을 비워도 `action`이나 요약에 GitHub에 쓰는 `gh` 명령(issue·pr 작성·댓글·머지, release·gist·repo 작성, 쓰기 메서드의 `gh api`)이 있으면 봇이 `GitHub에 게시합니다. 공개 저장소면 누구나 봅니다(감지: …)`를 채워 같은 카드로 띄웁니다.
- 승인 대기는 SQLite `approvals` 장부에 영속 기록됩니다. 더블클릭은 두 번째가 무시되고, 재시작하면 대기 중이던 카드는 "만료됨"으로 바뀌며(거부로 기록하지 않음), 시간 초과분도 스윕이 정리합니다. 오너가 아닌 클릭은 무시됩니다.
- `escalationChannel`을 지정하면 카드(정본)가 그 채널 최상위에 올라가고(요약 첫 줄에 오너 멘션, 끝 줄에 `요청 위치` 링크), 요청한 대화가 스레드(채널 스레드·DM 스레드)면 그 스레드에도 같은 제목·칸·버튼의 사본 카드가 뜹니다(오너 멘션 없음, 회색 줄에 `버튼으로 답해 주세요` 안내와 정본 카드 링크). 어느 쪽 버튼을 눌러도 결정은 한 번이고 두 카드가 같은 결과 줄로 바뀝니다. 사본 카드에 단 답글은 그 스레드의 일반 글이라 승인으로 세지 않습니다. 사본을 올리지 못했거나 요청이 스레드가 아니면(채널 최상위) 지금처럼 안내 한 줄만 남습니다. 지정하지 않으면 요청한 대화에 올라갑니다.
- 시간 초과로 끝난 카드와 데몬 재시작으로 만료된 카드 가운데 요청한 스레드가 있는 것은 정본·사본 모두에 `다시 요청` 버튼 하나가 남습니다. 누르면 요청한 스레드에 `🔘 다시 요청 (버튼)` 표시 글과 오너 글 `다시 요청: <요약 첫 줄>`이 들어가 새 턴이 열리고, 에이전트가 같은 요청을 다시 올리면 새 카드가 뜹니다(버튼이 승인을 대신하지 않음). 두 카드는 `▶ 다시 요청됨 · HH:MM`으로 바뀌고, 같은 카드를 두 번 눌러도 한 번만 들어갑니다. 넣지 못하면 카드에 `⚠️ 다시 요청을 넣지 못함`이 남으니 스레드에 직접 다시 요청합니다.
- 카드 스레드에 오너가 단 답글은 멘션 없이도 받아들여져 대기 중인 요청을 `replied: <답글>`로 마무리하고(도구가 그 문장을 돌려받음), 이미 끝난 카드에 단 답글은 요청했던 세션으로 그 카드 스레드에서 이어집니다.
- 승인 카드를 기다리는 턴은 멈춤 알림과 `inbound_starved` 게이트에서 빠집니다.

### 질문 카드

omp가 오너에게 묻는 창(select·confirm·input·editor·`ask`)을 띄우면 그 대화의 스레드에 `❓` 카드가 올라옵니다(agent `omp`의 채팅·레인 세션만 — 모니터, 단발 위임 `omp -p`, claude 에이전트 세션에는 답할 사람이 없어 시스템 프롬프트가 `ask`를 쓰지 말라고 합니다).

- **답하는 법**: 버튼을 누르거나 카드 스레드에 답장합니다. 선택지가 5개를 넘는 select와 `ask` 질문, 여러 개를 고르는(multi) `ask` 질문은 번호 목록으로 나오고 번호로 답장합니다(multi는 `1,3`처럼 쉼표로). 한 카드의 버튼은 Slack 한도인 25개까지라, 넘치는 `ask` 질문도 번호 답장으로 돌립니다. 목록에 없는 답장은 select에서는 그 글 자체, `ask`에서는 직접 입력한 답이 됩니다.
- **같은 대화의 다음 메시지**: 돌고 있는 턴에 열린 질문 카드가 하나뿐이면, 그 대화에 보낸 다음 일반 메시지(명령 제외)가 그 카드의 답이 되고 끼워 넣기(steer)되지 않습니다. 둘 이상이면 답으로 쓰지 않고 "카드 스레드에 답장해 달라"는 안내를 남긴 뒤 평소처럼 끼워 넣습니다. 버튼 클릭으로 카드가 막 닫힌 직후 도착한 메시지도 버리지 않고 평소처럼 끼워 넣거나 다음 턴으로 보냅니다.
- **`ask` 카드**: 질문마다 한 덩어리로 보이고, 답한 질문은 `→ 답`으로 바뀝니다. 답장은 아직 답하지 않은 첫 질문부터 채웁니다. 버튼은 카드를 만들 때 한 번 정해 끝까지 같으므로, 이미 답한 질문의 버튼을 다시 눌러도(더블클릭 포함) 다른 질문의 답이 되지 않고 무시됩니다.
- **추천 강조**: `ask` 질문에 추천 선택지(`recommended`)가 있으면 그 버튼만 강조색(Slack `primary`, Discord PRIMARY)으로, 나머지는 기본색으로 그립니다. 일부 답으로 카드를 다시 그려도 강조는 그대로입니다. select·confirm에는 추천이 없어 모두 기본색입니다.
- **마감**: omp가 준 `timeout`보다 1초 앞, 없으면 30분입니다. 마감까지 답이 없으면 omp가 읽는 결과와 같게 끝납니다 — select·input·editor는 취소, confirm은 아니오, `ask`는 질문마다 추천 선택지(없으면 1번)로 자동 선택(omp에도 "시간 초과로 자동 선택" 표시가 갑니다). 일부만 답한 `ask`는 답한 것은 그대로, 나머지는 추천(없으면 1번)으로 채워 보냅니다. omp가 준 `timeout`이 약 24.8일(2^31-1ms)을 넘으면 카드 마감은 그 상한으로 잘립니다.
- **비밀값 입력 창**(`secret`)은 슬랙으로 받지 않고 바로 취소합니다.
- 카드는 승인과 같은 `approvals` 장부에 기록됩니다. 카드 스레드 답장으로 끝난 카드는 그 답장의 ts를 남겨 백필로 다시 들어온 같은 답장을 새 메시지로 보지 않고, 데몬이 재시작하면 열려 있던 카드는 `❓ 질문` 머리로 "데몬 재시작으로 만료됨"이 됩니다.

### 답 피드백

오너가 봇 답 메시지에 👍(`+1`·`thumbsup`) 또는 👎(`-1`·`thumbsdown`) 반응을 달면, 그 답을 낳은 턴의 피드백으로 장부에 남습니다. Slack 앱에 `reactions:read`와 `reaction_added`·`reaction_removed` 구독이 있어야 합니다([Slack 앱 만들기](#2-slack-앱-만들기)).

- 대상은 대화 답(전달 장부로 보낸 글)뿐입니다. 승인·질문·TASK 카드와 알림, 오너가 아닌 사람의 반응, 다른 이모지는 무시합니다.
- 한 턴의 답이 여러 글로 나뉘었거나 여러 글에 반응을 달아도 턴마다 판정 하나로 셉니다. 가장 나중 반응이 이기고(👍 뒤 👎면 👎), 반응을 떼면 판정이 빠집니다.
- 현황판은 판정이 있는 턴에 👍·👎 배지를 붙입니다(턴 보드 카드, 턴 상세의 최근 턴 목록). 스냅샷 JSON(`api/snapshot`)의 `feedback`에는 최근 7일 👍·👎 턴 수와 최근 👎 턴 20개가 들어갑니다.
- `bun src/main.ts feedback [--days N] [--json]`은 최근 N일(기본 7) 👎 턴을 새것부터 한 줄씩(시각, 대화, 입수 번호, 마스킹한 요청 한 줄, 워터폴 경로) 보여 줍니다. 읽기 전용이고 자체회고가 이 출력을 읽습니다.

### 페르소나와 답변 형식

- `<ompbot 홈>/workspace/`(`workspaceDir` 설정과 무관)의 세 파일이 시스템 프롬프트 끝에 이 순서로 붙습니다. 모두 안전 바닥글보다 우선하지 않습니다.

  | 파일 | 절 | 상한 | 붙는 세션 |
  | --- | --- | --- | --- |
  | `soul.md` | `[정체성(soul)]` — 이름·성격·관계 | 8KB | 슬랙 대화 + 모니터 |
  | `owner.md` | `[오너 관찰지]` — 오너 선호·관심사·결정 | 16KB | 슬랙 대화 + 모니터 |
  | `persona.md` | `[페르소나]` — 운영 규칙·말투 | 8KB | 슬랙 대화만 |

  모니터 세션에서는 머리말에 "모니터 지시가 정한 답 형식(`NO_REPORT`·`[SILENT]`)이 이 지침보다 우선한다"가 붙습니다. 작업 레인·스킬 리뷰 세션에는 셋 다 붙지 않습니다. 상한을 넘는 부분은 잘립니다. 파일이 없는 것은 정상이지만, 있는데 읽을 수 없으면(권한·디렉터리 등) 그 파일만 빼고 시작하고 경로와 함께 `persona_unreadable`을 로그에 남깁니다.
- 세 파일을 고쳐도 캐시가 살아 있는 대화는 깨지 않습니다. 시스템 프롬프트가 한 글자라도 바뀌면 이어 가는 대화 전체를 프롬프트 캐시에 다시 써야 하므로, 대화(오리진의 epoch)마다 붙인 세 파일 내용을 세션 디렉터리의 `pinned-owner-docs.txt`(권한 0600)에 고정해 두고 같은 epoch의 다음 자식(재시작·유휴 해제 뒤)도 그 내용을 씁니다. 고친 내용은 그 대화의 마지막 모델 호출이 공급자 캐시 수명(Anthropic 1시간)보다 오래됐을 때, `/new-ompbot`으로 새 epoch를 열었을 때, 처음 띄울 때부터 들어갑니다. 마지막 호출 시각은 omp 세션 파일 끝에서 읽으므로, 알 수 없으면(세션 파일 없음, 캐시 수명을 모르는 공급자, claude·agy 드라이버) 고정하지 않고 매번 새로 읽습니다. 고정본이 깨졌거나 읽을 수 없으면 새로 읽은 내용으로 띄우고 `pinned_owner_docs_unusable`을 로그에 남깁니다. 안전 바닥글은 고정하지 않으므로 코드가 바뀌면 다음 자식부터 바로 새 값입니다.
- 자식을 띄울 때마다 `omp_spawn_prompt` 로그 한 줄이 남습니다: `origin`, `epoch`, `floors_static`(바닥글에서 런타임에 바뀌는 줄을 뺀 부분), `floors_dynamic`(그 줄 가운데 들어간 것의 이름: `peerTouched`·`noLaneChannel`·`resume`), `owner_docs`(세 파일 부분), `pinned`(고정본을 썼는지), `prompt`(붙인 전체). 해시는 sha256 앞 16자이고 원문은 남기지 않습니다. 재시작 뒤 캐시 미스(`cache_miss reason=child_restart`)가 ompbot 쪽 변경 때문인지 omp 쪽(스킬 목록·RULES·확장) 때문인지는 같은 오리진의 앞뒤 줄을 비교해 가립니다.
- `owner.md`는 오너만 있는 채널에 그대로 보여도 괜찮은 내용만 씁니다. 피어 봇이 들어온 세션에도 실리므로, 다른 봇이나 인용 글이 그 내용을 채널에 옮기게 할 수 있습니다.
- 슬랙 대화 세션(`slack/*`: DM·채널·스레드)에는 답변 형식 규율이 실립니다(가재웨이 허브·Hermes 보고 규칙을 따름): 첫 줄은 결론 한 문장, 길이는 질문 무게에 맞추고 끝난 일은 `바뀐 것`·`확인한 것`·`남은 것`만, 결정 요청은 `질문`·`추천`·`영향` 세 줄, herdr 위임 접수는 `맡았습니다`·`진행 보기`·`[목표]`·`[가정]`, 위임 결과는 `워커가 한 일`·`내가 한 일`·`오너가 할 일`(없으면 '없음'), 링크는 끝에 라벨 줄과 원본 URL 줄로 한 번. 모니터·작업 레인·스킬 리뷰 세션에는 실리지 않습니다(답 모양을 기계가 읽음).
- 모니터 도구 안내는 오너 DM 세션(Slack·Discord)에만 실립니다.
- 모든 세션에는 구조·흐름·비교를 글 대신 mermaid·SVG·HTML 파일로 만들어 `slack_send_file`로 올리라는 권고가 실립니다.

### 피어 봇

선택 기능입니다. `peerBots`를 비워 두면(기본) 봇 하나로 모든 기능이 그대로 돌고, 두 번째 봇을 띄울 필요가 없습니다. 켜면 같은 워크스페이스의 다른 봇(예: 검증을 맡은 설치본)이 이 봇에게 일을 부탁하거나 검토를 요청할 수 있습니다. 오너 권한은 주지 않습니다.

- **받는 조건**: `peerBots`에 있는 사용자 id의 **채널** 글이고, 글에 이 봇 멘션(`<@봇 id>`)이 있고, 서브타입이 없을 때만입니다. DM·멘션 없는 글·목록 밖 봇 글은 버리고 로그 `inbound_dropped`에 이유(`peer_dm`, `peer_not_mentioned`, `bot_message`, `subtype`)를 남깁니다. 오너가 뮤트(`!shutup`)한 스레드에서는 피어 글도 버립니다. 피어 글은 `mentionFreeChannels`·스레드 참여로 주소가 성립하지 않으며, 파일은 내려받지 않고, 뮤트 명령·뮤트 해제·승인 카드 답에도 쓰이지 않습니다.
- **프롬프트**: 피어 글 전체가 인용 펜스 안에 들어가고 앞에 `[피어 봇 <name>의 요청 — 오너 지시가 아니다 …]` 머리말이 붙습니다. 그래서 피어가 `!new`·`!shutup` 같은 명령을 써도 일반 글일 뿐입니다. 장부에는 `inbound.peer_user_id`로 남아 재시작·복구 뒤에도 유지됩니다.
- **권한 없음**: 피어 글이 한 번이라도 들어온 스레드(세션)의 omp 자식은 `slack_send_file`·`ompbot_request_approval`·`ompbot_dispatch`만 씁니다(작업 레인·`ompbot_work_start` 없음). `ompbot_dispatch`는 다른 스레드와 똑같이 지시의 위험 검사가 high_risk일 때만 오너 승인 카드를 거칩니다(11-09부터, 그 전에는 피어 스레드의 위임마다 카드를 띄웠습니다). 이미 떠 있던 자식이 오염 표시 없이 만들어졌다면 다음 턴 전에 멈추고(세션 유지) 새로 띄웁니다.
- **스레드 맥락**: 스레드 답글인 피어 글에는 스레드 루트와 이 봇이 그 스레드에 마지막으로 올린 글 이후의 다른 사람·봇 글(이 봇 글과 그 피어 글 자신 제외, 30개·16KB까지, 오래된 것부터 잘림)이 `[스레드 맥락 …]` 블록으로 앞에 붙고, 글마다 인용 펜스 안에 들어갑니다. 자세한 규칙은 [대화](#대화)의 스레드 맥락 항목을 따릅니다.
- **끼워 넣지 않음**: 피어 글은 실행 중인 턴에 끼워 넣지(steer) 않고 `!followup`처럼 턴이 끝난 뒤 다음 턴으로 기다립니다.
- **실패 알림**: 피어 입력으로 연 턴이 실패하면(턴 오류, omp 종료, 턴 시작 실패) 그 봇을 멘션한 한 줄 `<@피어> <@이 봇> 응답 실패(<사유 80자, 비밀 가림>) — 다시 요청하거나 직접 검토해 주세요`가 스레드에 남아 피어가 받습니다. 그 실패 글(`응답 실패(`와 `직접 검토해 주세요`가 둘 다 든 글)로 열린 피어 턴이 다시 실패하면 멘션 없이 `[turn failed] …`만 남겨 고리가 한 번에 끊깁니다. 오너 입력으로 연 턴의 실패 글은 그대로 `[turn failed] <사유> — 다시 보내 주세요`입니다.
- **작업 레인**: 레인 스레드의 피어 글은 행을 만들기 전에 버립니다(`peer_in_lane_thread`).
- **홉 상한**: 같은 스레드에서 `windowMinutes` 안의 피어 글이 `turns`를 넘으면 버리고(`peer_hop_cap`) 그 스레드에 "피어 대화 상한에 닿았습니다. 이어 가려면 오너가 말해 주세요."를 한 번만 올립니다(다른 봇 멘션 없음). 오너 메시지가 들어오면 그 스레드의 카운트가 초기화됩니다. 상한은 봇마다 따로 세므로 두 봇이 맞서면 최악의 경우 스레드당 `windowMinutes`마다 봇마다 `turns`턴입니다.
- **주소 규칙(오너 글)**: 채널에서 오너가 피어 봇만 멘션하고 이 봇은 멘션하지 않으면 이 봇에게 온 글이 아니라 `not_addressed`로 버립니다. 둘 다 멘션하면 받습니다.
- **재시작 없이 반영**: `peerBots`·`requireMention`·`peerHopLimit`는 `ompbot reload`로 다음 메시지부터 바뀝니다. 목록에서 뺀 봇의 지난 피어 글이 만든 "권한 없음" 표시는 장부에 남아 그 스레드에서 계속 적용됩니다.
- **백필의 한계**: [놓친 메시지 백필](#놓친-메시지-백필)은 봇 글을 건너뛰므로, 소켓이 끊긴 동안 온 피어 호출은 복구되지 않습니다. 피어가 다시 멘션해야 합니다.
- **Discord**: Discord 서버 채널·스레드에서도 같은 규칙으로 동작합니다. 목록은 `channels.discord.peerBots`(snowflake, 재시작 필요)에 따로 두고, 상한은 같은 `peerHopLimit`을 씁니다. 대화 플랫폼의 피어 봇이 프롬프트에 `이 대화의 피어 봇: <name> = <멘션>` 줄로 들어갑니다. 설정은 [Discord 안내 7절](discord.md#7-피어-봇두-번째-ompbot)을 봅니다.

### claude 에이전트

`config.json`에 `"agent": "claude"`를 넣으면 대화를 omp 대신 [Claude Code CLI](https://docs.claude.com/en/docs/claude-code/overview) 자식 프로세스(`claude -p --input-format stream-json --output-format stream-json --verbose`)로 구동합니다. 기본값은 `"omp"`이고, 이 값 하나만 바꾸면 됩니다.

```json
{
  "agent": "claude",
  "claudeExecutable": "/home/<user>/.local/bin/claude"
}
```

전제 조건:

- Claude Code CLI 설치: `claude --version`이 응답해야 합니다.
- 로그인: `claude`를 한 번 실행해 `/login`을 마칩니다. 자격 증명은 `~/.claude/.credentials.json`(0600)이나 키 환경변수로만 다뤄지고, ompbot이 값을 읽거나 옮기지 않습니다. 둘 다 없으면 데몬 시작과 `ompbot doctor`의 `claude auth` 줄이 실패합니다.
- omp는 여전히 설치돼 있어야 합니다(dispatch가 씁니다).

omp 에이전트와의 차이(1차):

- **세션 이어가기**: claude의 세션 id를 `<세션 디렉터리>/claude-session.json` 포인터에 저장하고 자식을 다시 띄울 때 `--resume`합니다. `/new-ompbot`은 포인터를 지우고 resume 없이 새로 시작합니다. `/resume-ompbot` 목록은 아직 omp 세션 파일 기준이라 claude 세션을 보여 주지 않습니다.
- **모델·thinking**: `/model-ompbot`은 `claude/fable`·`claude/opus`·`claude/sonnet`·`claude/haiku`를 받고 실행 중 세션에 `set_model`로 적용합니다. `/thinking-ompbot`은 `off|low|medium|high`를 받고 `off`는 thinking 끔, 나머지는 effort로 적용합니다.
- **승인 연동**: 파일 편집(작업 디렉터리 안)과 일반 도구는 묻지 않고 진행하고, 위험한 bash(재귀 강제 삭제, 포맷·원시 디바이스, 서비스·컨테이너 조작, 강제 푸시, 하드 리셋 등)는 기존 승인 카드로 올라옵니다. 카드 승인에만 그 명령이 실행되고, 거부·무응답·답장은 거부로 처리됩니다. `~/.ompbot/secrets`를 만지는 도구 호출은 카드 없이 즉시 거부됩니다. bash는 인자·리다이렉션(`cat<경로`처럼 붙여 써도)으로, Read·Glob·Grep·NotebookRead 등은 경로 인자로, WebFetch는 `file://` 주소로 판정하고, 심링크·`/proc/self/root`·하드링크로 돌아가는 경로도 실제 위치로 풀어 봅니다. 작업 디렉터리 안을 가리키는 링크라도 실제 위치가 밖이면 편집은 밖으로 보아 거부됩니다. bash의 가상 cwd는 `cd`뿐 아니라 `pushd`·`popd`·`cd -`도 따라가고, 앞에 `time`·`command`·`builtin`·`{`·`!`·`if`/`then`/`do`나 `HOME=… cd`가 붙어도, `-P`·`-L`·`-e`·`-@`·`--` 옵션 뒤의 대상도 풀어 봅니다. `cd "$D"`·`cd $(…)`·`pushd +1`처럼 대상을 풀 수 없는 디렉터리 이동 뒤에는 상대경로 인자가 있는 명령을 모두 거부합니다(실패 닫힘). Grep·Glob·LS의 `path`(없으면 세션 cwd)가 `~/.ompbot/secrets`이거나 그 상위(`~/.ompbot`, `~`, `/`)이면 거부하고, Grep의 `glob`·`include`는 `path` 밑으로 이어 붙여 같은 판정을 합니다. bash의 `grep -r`·`rg`도 검색 시작점(경로를 안 주면 cwd)이 비밀 디렉터리나 그 상위면 거부합니다. 디렉터리를 통째로 복사·압축하는 `cp`·`scp`(`-r`·`-R`·`-a`·`--recursive`·`--archive`), `rsync`, `tar`, `zip -r`, `7z`도 인자로 준 경로(대상 경로 포함, cwd는 덧붙이지 않음) 가운데 비밀 디렉터리나 그 상위가 있으면 거부합니다. `find`·`du`·`ls -R`은 내용을 내보내지 않으므로 대상이 아니고, `tar -C <dir>`처럼 옵션에 붙은 디렉터리는 보지 않습니다. 경로 중간 변수·`python -c`·heredoc 같은 우회는 여전히 이 가드 밖입니다.
- **호스트 도구**: `slack_send_file`, `ompbot_dispatch`, 모니터 도구는 omp 자식 전용이라 claude 세션에는 아직 없습니다. 즉 `agent: "claude"` 상태에서는 파일 업로드·작업 위임·모니터 등록을 할 수 없습니다(승인 카드는 됩니다). claude·agy 세션의 시스템 프롬프트에는 호스트 도구(파일 업로드·승인 카드·모니터·위임·레인) 안내 대신 "호스트 도구 없음" 한 줄과 도구 없는 승인 바닥글(하기 전에 답으로 묻기)이 들어갑니다.
- **권한 가드**: 인자 어디에 있든 `$HOME`·`${HOME}`, ANSI-C 인용(`$'…'`), 중괄호 확장(`{a,b}`·`{a..z}`, 최대 256개)을 풀어 비밀 디렉터리 판정에 씁니다. 링크가 2개 이상인 기존 파일(하드링크) 편집은 작업 디렉터리 안이어도 승인 필요로 거부됩니다.
- 자식은 `--setting-sources user`로만 사용자 설정을 읽습니다. 작업 저장소의 `.claude/settings.json`이 권한을 몰래 열지 못하게 하기 위함입니다.

### agy 에이전트

`"agent": "agy"`를 넣으면 대화를 Antigravity CLI 자식 프로세스(`agy --input-format stream-json --output-format stream-json -p '' --dangerously-skip-permissions`)로 구동합니다. 모델은 `"model": "agy/<id>"`로 정합니다(`agy models`가 보여 주는 id, 예: `agy/gemini-3.8-flash-high`).

```json
{
  "agent": "agy",
  "agyExecutable": "/home/<user>/.local/bin/agy",
  "model": "agy/gemini-3.8-flash-high"
}
```

전제 조건: `agy --version`이 응답하고, `agy`를 한 번 실행해 Google 로그인을 마쳐 `~/.gemini/oauth_creds.json`이 있어야 합니다(`ompbot doctor`의 `agy`·`agy auth` 줄).

omp 에이전트와의 차이:

- **권한**: 헤드리스 agy는 확인이 필요한 도구를 자동 거부하고 허용 규칙이 접두 매칭뿐이라, 자식을 `--dangerously-skip-permissions`로 띄웁니다. 승인 카드 연동은 없고, 바닥 규칙은 시스템 프롬프트로만 전달됩니다.
- **시스템 프롬프트**: agy에 `--append-system-prompt`가 없어 바닥 규칙·페르소나를 자식 프로세스마다 첫 메시지 앞에 붙여 보냅니다.
- **세션 이어가기**: agy 대화 id를 `<세션 디렉터리>/agy-conversation.json`에 저장하고 다시 띄울 때 `--conversation`으로 잇습니다. `/new-ompbot`은 포인터를 지우고 새로 시작합니다.
- **모델·thinking**: `/model-ompbot`은 `agy/<id>`를 받고 자식을 같은 대화로 다시 띄웁니다. `/thinking-ompbot`은 `low|medium|high`를 받아 모델 id 끝의 effort(`-low`/`-medium`/`-high`)를 바꿉니다.
- **끼워넣기·중단**: 작업 중 보낸 메시지는 현재 답이 끝난 뒤 같은 턴에서 이어 처리합니다. 그 메시지를 agy에 보내지 못하면 턴은 실패(`steer 전송 실패: …`)로 끝나고, 첫 답이 실패해 쌓인 메시지를 보내지 못하면 실패 알림에 `steer N건 미전달`이 붙습니다. 중단은 자식을 끊고 다음 메시지에서 같은 대화로 다시 띄웁니다.
- **자식 교체**: `/new-ompbot`·`/model-ompbot`·`/thinking-ompbot`·`/resume-ompbot`처럼 자식을 다시 띄우는 명령은 이전 agy 프로세스가 끝나기를 기다린 뒤 새로 띄워, 두 프로세스가 같은 대화를 동시에 열지 않습니다. 그때 돌던 턴은 중단(`agy restarted (<사유>)`)으로 마감됩니다.
- **미지원**: `/compact-ompbot`(거절 안내), 사용량 집계(`!usage`), 곁질문(`!btw`), 호스트 도구(`slack_send_file`·`ompbot_dispatch`·모니터·`ask`).

### Discord(선택)

Discord에서 오너 한 명의 DM·서버 채널 대화를 받습니다. Slack 없이 Discord만 써도 되고(`init --platform discord`, [설치 3절](#3-홈과-설정-만들기-init)), Slack과 같이 쓰면 같은 데몬이 두 어댑터를 함께 돌립니다. 데몬 알림(턴 실패·게이트 등)은 Slack이 있으면 Slack 오너 DM, 없으면 오너의 가장 최근 1:1 대화로 가고 `!home`으로 바꿀 수 있습니다. 봇 만들기·토큰·초대·문제 해결은 [Discord 봇 만들기](discord.md)에 있습니다.

- **켜기**: `config.json`의 `channels.discord`에 아래 키를 넣고 재시작합니다(`channels`는 `reload`로 반영되지 않음). 토큰 파일이 없으면 `secret_missing`, 0600이 아니면 `secret_permissions`로 기동하지 않습니다.

  | `channels.discord` 키 | 뜻 |
  | --- | --- |
  | `ownerUserId` | 오너의 Discord 사용자 ID(숫자 17~20자리, 필수). 이 사용자의 글만 받습니다 |
  | `botTokenFile` | 봇 토큰 파일, 홈 기준 상대경로(필수, 예: `secrets/discord-bot-token`) |
  | `applicationId` | Application ID(필수) |
  | `guildIds` | 받을 서버 ID 목록(선택, 없으면 봇이 들어간 모든 서버) |
  | `mentionFreeChannels` | 멘션 없이도 답할 채널 ID 목록(선택) |
  | `requireMention` | 서버 채널에서 멘션만 받음(선택, 기본 false) |
  | `laneChannelId` | Discord DM에서 요청한 작업 레인을 열 서버 텍스트 채널 ID(선택). 없으면 DM에서는 레인을 열지 않고 그 이유를 답합니다(서버 채널·스레드에서 요청한 레인은 그 채널에 열림) |
  | `logChannelId` | Discord #log 장부로 쓸 서버 텍스트 채널 ID(선택). Discord 대화·레인의 `✅ 완료` 답 사본이 올라가고, 이 채널과 그 스레드의 글은 턴이 되지 않습니다. `escalationChannelId`·`laneChannelId`·`mentionFreeChannels`와 같으면 `config_invalid` |
  | `escalationChannelId` | Discord 요청의 승인 카드를 받을 서버 텍스트 채널 ID(선택). 없으면 요청한 대화에 카드가 뜹니다 |
  | `displayName` | 봇의 글로벌 표시 이름(선택, 1~32자). 기동 때 `PATCH /users/@me`로 반영되어 DM·별명 없는 서버의 메시지 위에 보입니다. Username은 ASCII만 되므로 한글 봇 이름은 이 키로 씁니다. 서버 별명이 있으면 그 별명이 우선하고, 반영이 실패하면 경고 로그만 남습니다 |

- **인텐트**: Message Content Intent(`MESSAGE_CONTENT`)만 켭니다. 꺼져 있으면 Gateway가 4014로 끊고, 그때는 Discord만 멈추고 Slack을 같이 쓰면 Slack은 계속 답합니다.
- **다시 붙기**: Gateway가 연결 뒤 30초 안에 HELLO를 보내지 않거나, READY에 세션·resume 주소가 빠졌거나, `/gateway/bot`·resume 주소가 URL이 아니면 로그에 남기고 백오프(1초부터 최대 60초) 뒤 다시 붙습니다. 이때 Discord 기동을 실패로 처리하지 않습니다.
- **대화**: DM은 하나의 대화입니다. 서버 채널에서 봇을 멘션하면 봇이 그 메시지로 스레드를 만들어 답하고, 같은 스레드는 멘션 없이 이어집니다. `!status` 같은 `!` 명령, 👀·⏳ 진행 표시, 2000자 분할, `!shutup` 뮤트가 Slack과 같게 동작합니다. 양끝 `|` 없는 GFM 표(`a | b` / `--- | ---`)도 코드블록으로 감싸고, 스레드를 만들지 못한 메시지의 `⚠️ 스레드를 만들지 못해…` 공지는 백필이 다시 시도해도 메시지당 한 번만 올라갑니다. ⏳ 상태 글의 갱신·마무리와 슬래시 명령 응답 수정은 멘션 알림을 보내지 않습니다(`allowed_mentions: { parse: [] }`).
- **점검**: `ompbot doctor`가 `ok discord …` 줄로 토큰 권한·`users/@me`·`gateway/bot`을 확인하고, 데몬 `daemon_ready` 로그에 discord 상태가 함께 찍힙니다.
- **버튼**: 승인 카드(승인·거부·다시 요청), 질문 카드 선택지, TASK 카드의 `머지`·`추천대로`가 Discord 버튼(Action Row)으로 뜨고, 누르면 Slack 버튼과 같은 경로로 처리됩니다. 클릭한 사람은 그 카드가 있는 플랫폼의 오너인지로 확인하고, 오너가 아니면 본인에게만 보이는 거부 안내가 갑니다. 카드 스레드에 답장으로 답하는 방법도 그대로 됩니다.
- **카드·파일·피드백**: 승인·TASK 카드와 답 속 `card` 펜스는 embed로 보입니다(Discord embed 상한에 맞춰 자름). 검증을 통과한 카드라도 embed로 그리다 실패하면 그 카드만 펜스 원문 코드블록 글로 바꿔 보내고(`card_spec_invalid`에 이유), 답의 나머지는 그대로 나갑니다. 다만 Discord 세션의 프롬프트에는 카드 펜스 안내 줄이 없어 모델이 스스로 카드를 쓰는 일은 드뭅니다. 봇은 `discord_send_file`로 파일을 그 대화에 올리고(25 MiB 초과는 올리기 전에 거부), 오너가 보낸 이미지·문서를 내려받아 읽으며(메시지당 6개, 이미지 25 MiB·문서 20 MiB까지), 봇 답에 단 오너 👍/👎를 그 턴의 피드백으로 기록합니다.
- **슬래시 명령**: 기동 때 `COMMAND_TEXT`의 14개(`/new-ompbot` … `/brief-ompbot`)를 봇이 스스로 등록합니다. `guildIds`가 없으면 전역(DM·모든 서버, 퍼지는 데 시간이 걸릴 수 있음), 있으면 그 서버들에만 바로 등록되어 DM에서는 `!` 형태를 씁니다. 결과는 나에게만 보이는 응답으로 오고, 결과가 따로 올라오는 명령은 그 응답이 지워집니다. 서버 스레드에서 친 명령은 그 스레드 대화방에 적용됩니다. 등록이 실패해도 경고 로그만 남고 `!` 명령은 그대로 됩니다.
- **놓친 메시지**: 기동 때, Gateway가 새 세션으로 다시 붙을 때(resume이면 Discord가 다시 보내 줌), 받은 메시지 처리가 실패했을 때 Discord 대화가 있던 DM·채널·스레드를 `dc:<채널 ID>` 기준점 뒤로 100개씩 읽어 오너 글을 처리합니다. 이미 받은 글은 중복으로 걸러지고, 읽을 수 없는 채널은 재시작 전까지 건너뜁니다.
- **스레드 맥락**: 봇 글에서 만든 서버 스레드의 첫 오너 답에는 그 봇 글이 맥락으로 붙습니다(Slack과 같은 주입 경고 포함).
- **모니터**: Discord DM 세션도 모니터 도구(`ompbot_monitor_add/list/remove`)를 받고 프롬프트에 그 안내가 실립니다. `channel`을 정하지 않은 모니터는 등록한 Discord DM ID를 `channel`로 저장해 결과가 그 DM에 새 글로 옵니다(Slack DM 등록은 지금처럼 비워 두어 Slack 오너 DM). `channel`·`copyChannel`은 Slack 채널 ID(`C…`/`G…`)나 Discord 채널 ID(숫자 17~20자리)를 받습니다. 서버 스레드 세션에는 모니터 도구가 없습니다(Slack과 같음).
- **작업 레인**: 레인은 서버 텍스트 채널의 Discord 스레드에서 돕니다. 부모 채널에 `🔄 제목` 루트를 올리고 그 루트로 스레드를 만든 뒤(스레드 ID = 루트 ID, 레인 `threadRef`는 `<부모 채널>:<루트 ID>`) 상태 메시지(⏸ 버튼)와 Outcome 카드(머지·폐기)를 스레드 안에 올립니다. 스레드를 만들지 못하면 루트를 `❌ 제목`으로 고치고 worktree·브랜치를 지웁니다. 스레드 안 오너 글은 멘션 없이 레인으로 가고 `멈춰`·`계속`·`머지해`·`폐기해`·`!reopen`·버튼이 Slack 레인과 같게 동작합니다. 서버 채널·스레드에서 요청하면 그 채널에, DM에서 요청하면 `laneChannelId` 채널에 열고 요청한 곳에 레인 스레드 링크를 답합니다. `laneChannelId`가 없으면 DM 세션에는 `ompbot_work_start`가 없고 프롬프트와 `작업: …` 답이 이 설정을 안내합니다. 레인 세션은 `discord_send_file`로 레인 스레드에 파일을 올립니다.
- **inject**: `ompbot inject --origin discord/dm/<ID>|discord/ch/<ID> --as-owner --text …`가 그 대화에 `🧪 inject` 마커를 올리고 오너 글로 접수합니다(DM의 `--thread <메시지 ID>`는 그 메시지에 대한 답장, DM 대화로 접수). Discord 세션도 긴 작업의 자동 후속(`[자동 후속]`)에 이것을 씁니다.
- **로그·승인 채널**: `logChannelId`를 넣으면 Discord 대화·레인의 `✅ 완료` 답 사본이 그 채널에 올라가고 그 채널(과 스레드)의 글은 턴이 되지 않습니다. `escalationChannelId`를 넣으면 Discord 요청의 승인 카드가 그 채널에 Discord 오너 멘션·`요청 위치` 링크와 함께 뜹니다. 둘 다 없으면 사본은 없고 카드는 요청한 대화에 뜹니다. 자세한 건 [Discord 봇 만들기](discord.md) 5절.
- **Slack에만 있는 것**: 게이트·한도·재시작 같은 데몬 수준 알림, 피어 봇, App Home은 Slack에만 있습니다.
- **현황판**: Discord DM은 `DM`, 서버 채널은 `Discord <채널 ID>`로 보이고, 시스템 보기에 Discord 게이트웨이 연결 카드가 생깁니다(Discord를 끈 설치에는 없음).

### Teams(선택)

Microsoft Teams(Bot Framework)에서 오너의 1:1·그룹 채팅 대화를 받습니다. Slack·Discord 없이 Teams만 써도 되고(`init --platform teams --owner <오너 Entra object id> --app-id <봇 id> --tenant <테넌트 id>`), 다른 채널과 같이 써도 됩니다.

- **켜기**: `config.json`의 `channels.teams`에 아래 키를 넣고 재시작합니다. 클라이언트 시크릿은 `umask 077; cat > ~/.ompbot/secrets/teams-client-secret`(0600, 한 줄)로 둡니다.

  | `channels.teams` 키 | 뜻 |
  | --- | --- |
  | `appId` | 봇의 Microsoft App ID(Entra client id, GUID, 필수). 들어오는 토큰의 `aud`가 이 값이어야 합니다 |
  | `tenantId` | 오너의 Entra 테넌트 ID(GUID, 필수). 다른 테넌트의 Activity·토큰은 버립니다 |
  | `clientSecretFile` | 클라이언트 시크릿 파일, 홈 기준 상대경로(필수, 예: `secrets/teams-client-secret`) |
  | `ownerAadObjectId` | 오너의 Entra object id(GUID, 필수). 이 사용자의 글만 오너 명령으로 받습니다 |
  | `listen` | Bot Framework 엔드포인트(`POST /api/messages`)를 받을 loopback 주소(선택, 기본 `127.0.0.1:3978`, `127.0.0.1`·`localhost`·`[::1]`만). 공개 HTTPS는 데몬 밖 터널(cloudflared 등)이 이 주소로 넘겨 줍니다 |
  | `tokenTenant` | 보내는 쪽 Bot Connector 토큰을 받을 테넌트(선택, 기본 `tenantId`, 멀티 테넌트 봇이면 `botframework.com`) |
  | `guestAadObjectIds` | 손님 Entra object id 목록(선택). 손님이 봇을 멘션하면 웹 검색만 쓰는 읽기 전용 일회성 실행으로 답하고, 오너 세션·승인·레인·위임에는 닿지 않습니다 |
  | `ownerMode` | `"full"`(기본) 또는 `"qa"`. `"qa"`면 오너 글도 손님과 같은 읽기 전용 일회성 실행으로 답합니다 |
  | `guestModel` | 손님·`qa` 실행에 쓸 `--model`(선택, 없으면 omp 기본) |
  | `graph` | 오너 Teams 채팅 읽기 도구. [Teams 채팅 읽기](#teams-채팅-읽기선택-graph) 참고 |

- **앱 패키지**: `ompbot teams package --out <zip>`이 봇 id·범위(`personal`, `groupChat`)·기본 아이콘 두 개를 담은 앱 패키지를 만듭니다. Teams의 "사용자 지정 앱 업로드"로 올립니다.
- **대화**: 1:1은 모든 글을, 그룹 채팅은 봇을 멘션한 글만 받습니다. Teams에는 봇 반응·버튼이 없어 접수는 typing 표시로 알리고, 승인·질문 카드는 선택지를 글로 보여 주고 답장으로 받습니다. 오너 1:1에 올린 파일은 [Teams 1:1 파일 받기](#teams-11-파일-받기) 참고.
- **알림 목적지**: Slack이 없으면 데몬 알림은 오너의 Teams 1:1로 갑니다(다른 사람이 있는 그룹 채팅은 고르지 않음). `!home`으로 바꿀 수 있습니다.

### Teams 1:1 파일 받기

오너가 봇과의 Teams 1:1 대화(`ownerMode: "full"`)에 파일을 올리거나 이미지를 붙여 넣으면 봇이 읽습니다. 남이 공유한 PPT·Excel도 오너가 받아 1:1에 다시 올리면 됩니다. Graph 권한이나 테넌트 관리자 동의는 필요 없습니다.

- **앱 패키지 다시 올리기**: 파일 받기는 앱 manifest의 `supportsFiles`가 켜진 패키지(버전 1.0.1 이상)에서만 됩니다. `ompbot teams package --out ompbot-teams.zip`으로 새 zip을 만들어 Teams "앱 관리"에서 기존 앱을 업데이트(사용자 지정 앱 업로드)합니다. Teams는 같은 버전 재업로드를 거부합니다.
- **받는 것**: 올린 파일(`file.download.info`)은 짧게 유효한 SharePoint/OneDrive 다운로드 주소로 인증 헤더 없이 받고(`*.sharepoint.com`·`*.sharepoint-df.com`·`*.files.1drv.com`·`*.livefilestore.com`의 https만, 리다이렉트도 같은 목록), 붙여 넣은 이미지는 그 메시지를 보낸 Bot Connector 호스트(또는 `*.botframework.com`)에서만 봇 토큰을 붙여 받습니다. 저장 위치는 `~/.ompbot/media/inbound/<대화 별칭>-<Activity id>/`(id의 `:` 같은 문자는 `_`로)이고, 메시지당 최대 6개·이미지 25MB·문서 20MB까지 Slack과 같은 `[첨부: 경로 (형식)]` 줄로 omp에게 전달됩니다. 글 없이 파일만 올려도 턴이 됩니다.
- **실패**: 허용 목록 밖 주소·http·상한 초과·다운로드 실패는 `[첨부 실패: 이름 — 사유]` 줄로 남고 턴은 계속됩니다.
- **받지 않는 곳**: 그룹 채팅, 손님, `ownerMode: "qa"`의 첨부는 받지 않고 로그 `teams_attachment_ignored reason=<group|guest|qa>` 한 줄만 남깁니다. 봇이 Teams로 파일을 보내는 기능은 없습니다.

### Teams 채팅 읽기(선택, Graph)

Teams 봇은 그룹 채팅에서 자기를 멘션한 글만 받습니다. `channels.teams.graph`를 켜면 오너의 Teams 1:1 대화(`ownerMode: "full"`)에서 봇이 Microsoft Graph 위임 권한 `Chat.Read`로 오너가 속한 채팅의 목록과 메시지를 읽을 수 있습니다.

- **Azure 앱 등록에서 할 일**(봇과 같은 앱 등록): **인증** → "Allow public client flows"를 **예**로 켭니다. **API 권한** → Microsoft Graph **위임된 권한** `Chat.Read`·`User.Read`·`offline_access`를 추가합니다.
- **켜기**: `config.json`의 `channels.teams`에 `"graph": {}`(토큰 파일을 바꾸려면 `{"tokenFile": "secrets/teams-graph-token"}`)를 넣고 재시작합니다.
- **로그인**: `ompbot teams login`이 `teams_login code=<코드> url=https://microsoft.com/devicelogin`을 찍습니다. 브라우저에서 그 주소를 열고 코드를 넣은 뒤 **오너 계정**으로 로그인하면 refresh 토큰이 `tokenFile`(0600)에 저장됩니다. 로그인한 계정이 `ownerAadObjectId`와 다르면 저장하지 않고 `teams_graph_wrong_account`로 끝납니다. `ompbot teams logout`은 토큰 파일을 지웁니다. 토큰을 출력하는 조회 명령은 없습니다.
- **도구**: `teams_list_chats(query?, limit?)`는 최근 채팅(id·종류·제목 또는 참여자 이름·마지막 시각)을, `teams_read_chat(chatId, since?, limit?)`는 메시지(보낸 사람·시각·본문, 기본 50개·최대 200개, HTML은 텍스트로)를 돌려줍니다. 본문은 비밀값을 가린 뒤 인용 펜스로 감싸 데이터로만 넘깁니다.
- **어디에 있나**: 피어 봇 글이 들어오지 않은 오너 Teams 1:1 세션에만 있습니다. Teams 그룹 채팅·손님·`ownerMode: "qa"`·Slack·Discord 세션에는 없고, `qa`면 시작 때 `teams_graph_disabled reason=ownerMode_qa` 경고 한 줄을 남깁니다. 오너가 Teams 그룹 채팅에서 봇을 부르면 `ownerMode`와 상관없이 손님과 같은 읽기 전용 일회성 실행으로 답합니다(오너 세션·기억·도구가 방 사람들 앞에 나오지 않게). `ownerMode: "full"`은 오너 1:1에만 적용됩니다.
- **관리자 동의가 필요할 때**: 테넌트가 사용자 동의를 막았으면 로그인이 `teams_login_failed … aadsts=65001`(관리자 동의 필요)로 끝납니다. 테넌트 관리자가 API 권한에서 "관리자 동의 허용"을 눌러야 합니다. `aadsts=7000218`이나 `invalid_client`면 public client flow가 꺼져 있는 것입니다.
- **만료**: refresh 토큰이 만료·취소되면 도구가 "`ompbot teams login`을 다시 해야 합니다"를 돌려주고 오너 알림이 하루 한 번 갑니다.
- **주의**: 읽은 회사 메시지는 봇이 쓰는 모델 제공자에게 넘어갑니다.

## 작업 위임

### herdr(선택)

herdr는 config로 켜는 선택 기능입니다. herdr 없이도 데몬·대화·모니터·백업·`ompbot_dispatch` simple(`omp -p`)은 그대로 돕니다.

- 켜기: config에 `"herdr": {}`(PATH의 `herdr`) 또는 `"herdr": {"bin": "/절대경로/herdr"}`. 설치 여부를 자동으로 감지하지 않습니다. 바꾸면 `reload`가 `restart_required=herdr`를 알리고 재시작해야 적용됩니다.
- 켜짐: 아래 `mode=herdr`·`host`·`taskSpec`, [TASK] 스윕, 대화 프롬프트의 herdr 접수 형식 줄이 모두 들어갑니다. `daemon_ready` 로그에 `herdr=on`.
- 꺼짐: `ompbot_dispatch`의 스키마·설명에 `task`(simple)만 남고, 대화 프롬프트에 herdr 접수 줄이 없습니다. 스키마를 우회해 `mode=herdr`·`name`·`host`·`cwd`·`taskSpec`을 보내면 프로세스를 띄우지 않고 "herdr가 꺼져 있어 simple만 쓸 수 있습니다" 오류가 납니다. [TASK] 스윕이 돌지 않으며, 기동 때 `working`·`blocked` 작업이 있으면 `tasks_orphaned count=N` 경고를 한 번 남기고 행은 건드리지 않습니다. `ompbot tasks` list·close는 그대로 씁니다. `daemon_ready` 로그에 `herdr=off`.
- `dispatchHosts`·`herdrBoard`는 herdr 기능이라 `herdr` 없이 넣으면 config 검증(`config_invalid field=herdr`)에서 실패합니다.
- 워커 대기 알림은 herdr의 omp 통합(`herdr integration install omp`)이 있어야 나옵니다. `doctor`는 `herdr integration status`의 `omp:` 줄이 `current`면 `ok herdr omp integration`, 아니면(미설치·명령 실패) `fail herdr omp integration … (warning only)`을 내고, dispatchHosts마다 ssh로 같은 점검을 합니다. 이 줄들은 종료 코드를 바꾸지 않습니다.

### `ompbot_dispatch`

채팅 세션은 host tool `ompbot_dispatch(task, mode?, name?, host?, cwd?, taskSpec?)`로 일을 넘깁니다(레인·모니터 세션에는 없음). `mode`·`name`·`host`·`cwd`·`taskSpec`은 herdr 켜짐일 때만 있습니다.

- `mode=simple`(기본): 단순 작업. `omp -p`로 한 번 실행하고 최종 출력을 돌려줍니다(10분 상한, 출력 8천자).
- `mode=herdr`: 여러 단계·오래 걸림·계속 추적할 작업. 로컬 herdr에 그 `name`의 에이전트가 있으면 task는 후속 지시가 되고, 없으면 herdr 워크스페이스를 새로 만들어 omp 에이전트를 띄우고 프롬프트를 넘깁니다(접수 안내·진행 보기 링크는 원격 시작과 같은 모양). 새로 띄울 때 `cwd`(절대경로)를 주면 거기서, 안 주면 ompbot 메인 작업 디렉터리에서 일하며 결과에 "메인 작업 디렉터리에서 작업합니다 — 저장소 작업은 taskSpec이나 cwd를 주세요"가 붙습니다. TASKID 꼴 이름(`t-YYYYMMDD-NN`)으로는 새로 띄우지 않습니다 — [TASK]는 `taskSpec`으로 등록·재개합니다(이미 떠 있는 그 이름에 후속 지시를 보내는 것은 됩니다). task 없이 name만 보내면 현재 출력 조회입니다.
- `host`(예: `host=wsl`): 설정의 `dispatchHosts`에 등록된 호스트에서 ssh로 herdr를 구동해 원격 에이전트를 띄웁니다. 원격 호스트로 넘기는 인자(herdr 경로·cwd·작업 지시문)는 하나씩 작은따옴표로 감싸 보내므로 원격 셸이 쪼개거나 해석하지 않습니다. cwd가 정확히 `~`일 때만 원격 홈으로 풀리고, `~/…`는 글자 그대로 전달되니 원격 경로는 절대경로로 주세요.
- 여러 단계이거나 하루를 넘길 작업은 `taskSpec`을 채워 [TASK] 상태 문서로 추적합니다.
- **감사 로그**: 데몬 프로세스가 띄우는 외부 호출(원격 ssh, 로컬 herdr·git·`omp -p`, tasks 스윕의 원격 읽기 포함)은 한 지점(`realProcessRunner`)에서 `~/.ompbot/logs/dispatch-audit.jsonl`에 한 줄씩 남습니다(0600, 5MB씩 최대 4개 파일로 회전). 줄 필드: `ts`, `host`(ssh 대상, 로컬이면 `local`), `argv0`, `cmd`(비밀 마스킹 후 300자 제한, ssh는 원격 명령), `cmdSha256`(마스킹된 전체 명령 해시 앞 16자), `rc`(타임아웃이면 `null`), `ms`, `timedOut`, `origin`(`ompbot_dispatch` 호출일 때). 기록 실패는 호출을 막지 않고 `dispatch_audit_write_failed`를 한 번만 남깁니다. 기록은 데몬 프로세스에서만 켜지므로 CLI로 직접 실행한 `ompbot offsite`·`backup`·`tasks`의 ssh/scp는 남지 않습니다.
- **외부 호출 타임아웃**: 타임아웃이나 중단으로 프로세스 그룹을 죽이면, `setsid`로 빠져나간 자식이 출력 파이프를 쥐고 있어도 그 프로세스가 끝나거나 2초가 지나면 결과(`timedOut`)를 냅니다. 레인 `[check:]` 하나가 공용 검사 슬롯을 붙잡아 다른 레인의 검사가 멈추는 일이 없습니다.
- **동결**: `ompbot freeze`가 켜져 있으면 `ompbot_dispatch`는 실행하지 않고 "동결 중" 오류를 돌려줍니다(아래 '운영' 참고).
- **위임 전 위험 검사**: herdr나 simple(`omp -p`)로 나가는 지시문(taskSpec 신규는 `task`·`title`·`goal`·`scope`·`background`, 재개·후속 지시·원격 시작·simple은 `task`)을 내보내기 전에 앞 64KiB를 줄 단위로 훑습니다. 줄 끝 `\`로 이어진 줄들은 한 줄로 이어 붙여 한 번 더 보고, 발견은 이어진 첫 줄 번호로 알립니다(`git reset \` 다음 줄 `--hard`도 고위험). `.ompbot/secrets`는 `~/.ompbot/./secrets`, `$HOME//.ompbot//secrets`처럼 사이에 `/`·`./`가 섞여도 고위험입니다. 하드 리셋·강제 clean·강제 push·보호 브랜치(`main`·`master`) push·`git branch -D`·`/`·`~`·`$HOME` 대상 `rm -rf`·`DROP TABLE` 류·서비스·컨테이너 조작(systemctl·docker·podman·pm2)·`mkfs`·`dd of=/dev/`·`.ompbot/secrets`는 고위험, 패키지 설치와 `OMP_OWNER_APPROVED`는 주의입니다. 명령이 든 절에 금지 표지(`하지 않는다`·`금지`·`never`·`do not` 등)가 있으면 주의로 내립니다. 규칙 정의 꼴(`` - `git_reset_hard`: `git reset --hard` ``, 검사기 설명)은 명령이 접두어 뒤 인라인 코드(백틱) 안에만 있을 때만 주의로 내리고, 접두어 뒤 평문에 명령이 있으면(`` - `git_reset_hard`: 지금 git reset --hard HEAD~9 ``) 고위험입니다. 절 경계는 `;`·`,`·`，`·`、`, 공백이 뒤따르는 `.`·`。`·`!`·`?`, 앞뒤 공백이 있는 `and`·`then`·`but`·`after`·`before`, 앞이나 뒤에 공백이 있는 `하고`·`한 뒤`·`한 다음`·`한 후`·`해서`·`하여`·`그리고`·`다음에`·`후에`·`뒤에`입니다. 명령 자체의 글자와 그 절 안의 괄호 내용은 표지로 보지 않고(명령 안은 경계로 자르지도 않음), 괄호 안의 명령은 괄호 안의 절과 괄호를 감싼 바깥 절을 함께 봅니다. 줄머리 표지 `- no `는 줄 첫 절에만 적용되고, 다른 절·다른 괄호의 표지나 줄 다른 곳의 규칙 이름만으로는 내리지 않습니다(예: `git reset --hard origin/main 하고, rebase는 하지 마`는 고위험, `데몬 재시작(systemctl --user restart ompbot)은 하지 않는다`는 주의). 고위험이면 오너 승인 카드를 띄워 승인일 때만 내보내고(taskSpec 신규는 등록 위험등급을 L3 이상으로 올림), 거부·시간 초과·답장·승인 장치 없음이면 워커·워크트리·등록 행을 만들지 않고 오류를 돌려줍니다. 주의는 그대로 내보내고 결과 끝에 `위험 검사: advisory (<규칙>)`를 붙입니다. simple도 같은 규칙이라 고위험이 승인되지 않으면 `omp -p`를 띄우지 않고, 주의·승인 줄(`위험 검사: high_risk 승인됨 (<규칙>)`)은 출력 끝에 붙습니다. 조회만 하는 호출은 검사하지 않습니다. 로그: `dispatch_risk_advisory`·`dispatch_risk_high`·`dispatch_risk_approved`·`dispatch_risk_refused`.

### [TASK] 상태 문서

세션이 `taskSpec`(신규: `title, risk(L0~L4), goal, scope[], exclusions[], acceptance[](1개 이상), repo(대상 호스트의 git 저장소 절대경로), background?, assumptions?` + `task` 지시문, 재개: `{id:"T-…"}`만)을 채우면 ompbot이 한 번에 다음을 만듭니다. `taskSpec` 없는 dispatch는 달라지지 않습니다.

- TASKID `T-YYYYMMDD-NN`(봇 시간대 날짜 + 그날 순번), 대상 호스트(로컬 또는 `host` 원격)의 워크트리 `<repo>-t-yyyymmdd-nn`(branch `task/T-…`), herdr 에이전트 `t-yyyymmdd-nn`.
- 워크트리 `docs/tasks/<TASKID>/`의 4문서: `context.md`(요청 원문·배경) · `spec.md`(목표·범위·제외·수락기준 체크박스) · `PROGRESS.md`(기계가 읽는 상태 파일: `status`·`updated`·`current`·`next`·단계 목록) · `outcome.md`(맨 위 `## 요약` 2~3줄과 AC별 `commit`·`test`·`file` 증거). 에이전트는 spec.md의 체크박스만 `[x]`로 바꾸고 문구는 고치지 않습니다. 4문서는 등록 때 task 브랜치의 첫 커밋(`docs(task): <TASKID> 4문서`)으로 남고(커밋이 실패하면 등록을 되돌림), 에이전트는 문서 갱신을 단계 커밋에 함께 넣고 `updated`에 `date -Iseconds`로 얻은 실제 시각을 씁니다.
- 작업 스레드에 접수 카드 1개와 루트 메시지의 상태 반응 하나(⏳ 진행 · 🔍 리뷰 · 🚧 blocked · ✅ 완료 · ❌ 취소). [TASK] 루트에는 턴 종료 반응(✅·⚠️·❌)을 달지 않고 👀만 거둡니다.
- 5분마다 스윕이 파일과 git만 읽어(LLM 호출 없음) Outcome을 판정합니다. 도달 조건: spec.md 수락기준이 등록 스냅샷과 같고, 모든 AC가 `[x]`이고, outcome.md에 AC마다 commit/test 증거가 있고, 모든 commit이 그 task 브랜치에서 4문서 커밋(`docs(task): <ID> 4문서`) 이후에 만든 커밋이고(main에 이미 있던 커밋·다른 브랜치 커밋·4문서 커밋 자체는 인정하지 않음), PROGRESS `status`가 blocked가 아님. PROGRESS의 `review`·`done`이나 "완료" 문구는 판정에 쓰지 않습니다. 도달하면 🔍로 바꾸고 스레드에 "Outcome 도달"을 한 번 올립니다 — 리뷰 자격일 뿐 완료가 아닙니다.
- 스윕은 나머지 조건이 모두 맞을 때 task 브랜치의 4문서 커밋 이후 diff(`--unified=0`)를 레인과 같은 무결성 분류기로 봅니다. 추가된 코드 줄의 TODO·FIXME, `it.skip`·`test.only` 같은 건너뛴 테스트, `not implemented` 같은 스텁은 `무결성 <분류>: …` 미충족 조건이 되어 도달을 막고 재촉으로 에이전트에 전해집니다. 테스트 없는 가드 삭제와 명령 없는 "통과" 주장은 도달을 막지 않고 Outcome 카드 요약 아래 `*⚠️ 무결성 경고*` 줄로 나옵니다. 4문서 커밋이 없거나 git이 실패하거나 diff가 64KB를 넘으면 `diff를 읽지 못해 무결성 검사를 미룹니다`로 도달을 미룹니다. `tasks show`·현황판 판정은 diff를 읽지 않습니다.
- 접수 카드는 가재웨이 허브의 "맡았습니다" 보고 모양입니다: 첫 줄 `` `local`에서 `t-…`(<제목>)가 맡았습니다. 결정이 필요하거나 끝나면 이 스레드로 알려 드립니다. ``, 다음 줄 `진행 보기: <보드 카드 링크>`(`herdrBoard` 설정 시), 빈 줄 뒤 `[목표]`(spec goal)·`[가정]`(taskSpec `assumptions`, 없으면 "없음")·`[작업]`(TASKID·위험등급·브랜치·수락기준 수·워크트리). 카드를 올렸으면 도구 결과가 세션에 "카드를 되풀이하지 말라"고 알리고, 못 올렸으면 같은 모양으로 직접 쓰라고 알립니다. `taskSpec` 없이 `host`로 띄운 원격 에이전트도 도구 결과에 진행 보기 링크와 이 접수 모양이 실립니다.
- 막히면 에이전트가 PROGRESS.md에 `status: blocked`와 함께 `blocked_reason`·`question`·`recommend`·`impact`를 적고, 스윕이 이를 `🚧 멈춤 · <제목> — 결정이 필요합니다.` 결정 요청(오너 멘션, `*사유*`·`*질문*`·`*추천*`·`*영향*`·`*지금 단계*`, 끝에 `작업 보드` 링크)으로 올립니다.
- **막힘 재도전**: 첫 막힘은 카드 전에 워커가 재도전합니다. 스윕이 처음 blocked를 본 때 상태·반응은 그대로 두고 워커에게 "다른 접근을 한 번 더 시도하고, 그래도 막히면 시도한 2가지를 `blocked_reason`에 적어라"는 프롬프트를 한 번 보냅니다(막힘마다 1회, 등록이나 마지막 재개 뒤 3회까지). 그 뒤에도 막혀 있으면 워커가 PROGRESS를 고치고 herdr에서 일을 멈췄거나, herdr가 쉬는·대기·사라짐 상태이거나, 30분이 지난 첫 스윕에 카드가 올라가고 `*사유*` 끝에 `(재도전 1회 뒤)`가 붙습니다. 그래서 막힘 카드는 최대 30분(+스윕 5분) 늦게 올 수 있습니다. 재도전 중 워커가 `status: working`으로 돌리면 카드는 올라가지 않습니다. 승인·자격증명·실계정·오너만 정할 범위처럼 오너 몫인 막힘은 워커가 `needs_owner: yes`를 함께 적으면 재도전 없이 바로 카드로 올라갑니다. 동결·멈춤 중인 TASK, 재도전 프롬프트 전송이 실패한 막힘, 재개 구간의 3회를 다 쓴 막힘도 바로 카드로 올라갑니다. 막힌 TASK의 `[check: …]`가 모두 통과해 워커에게 보내는 "검사 통과" 프롬프트는 동결·멈춤 중에는 보내지 않고 기록도 하지 않으며(스윕 동작 `checks pass while blocked, held (frozen|paused)`), 해제 뒤 첫 스윕에서 같은 HEAD로 한 번 보냅니다.
- Outcome 도달 알림은 첫 줄(제목·AC n/m·오너 멘션) 뒤에 에이전트가 outcome.md 맨 위 `## 요약`에 쓴 한국어 2~3줄(무엇이 바뀌었나·검증 결과·스펙 밖 예외)을 `• `로 최대 3줄(줄마다 200자) 싣고, 요약이 없거나 비었으면 `⚠️ 요약 없음 — docs/tasks/<ID>/outcome.md를 직접 봐 주세요.` 한 줄을 싣습니다(요약 유무는 판정에 쓰지 않음). 이어서 두 기준 이상이 같은 커밋 증거만 댔으면 `⚠️ 증거 약함: …`(커밋이 기준을 채우는지는 봇이 판정하지 않음)·`*질문*`(머지 여부)·`*답하는 법*`·`*근거*`(`docs/tasks/<ID>/outcome.md`와 `git -C <worktree> log --oneline main..<branch>`)·`작업 보드` 순서입니다. 수락기준 목록과 AC별 증거는 카드에 싣지 않고 outcome.md에만 남습니다. 보드 링크는 알림 때마다 herdr `agent list`의 현재 pane으로 다시 구합니다.
- **카드와 머지 버튼**: 위 문구는 알림 미리보기·현황판·로그가 쓰는 `text`이고, Slack에는 같은 알림이 제목·칸·본문·회색 줄 카드로 보입니다. 접수 `🚀 접수 · <제목>`(호스트·에이전트·위험·브랜치·수락기준 수), Outcome 도달 `🔍 머지 대기 · <제목>`(수락기준 n/m·재실행 검사 p/q·브랜치·워커, 요약·경고·오너 멘션), 막힘 `🚧 막힘 · <제목>`(단계·브랜치), 리뷰 대기 `⏳ 리뷰 대기 · <제목>`(대기 시간·브랜치), 에이전트 없음 `👻`·워커 대기 `⏸`·nudge 상한 `🔁` 카드입니다. Outcome 도달과 리뷰 대기 카드에는 `머지` 버튼(primary)과 `머지 = close → ff merge → push → 정리 · 재시작은 따로 승인` 줄이 붙습니다. 버튼 한 번은 그 스레드에 "머지해"라고 답한 것과 같습니다: 봇이 스레드에 `🔘 머지 (버튼)` 표시 글을 올리고 오너 글 `머지해`를 넣어 그 스레드 세션이 지금처럼 오너 승인 규칙대로 close·머지·push를 합니다(새 권한 없음). 카드는 버튼이 빠지고 `▶ 머지 요청됨 · HH:MM`(봇 시간대)으로 바뀝니다. 같은 카드를 다시 누르면 아무것도 하지 않고(`task_merge_ignored reason=duplicate`), review가 아닌 작업·없는 작업은 `task_merge_ignored`를 남기고 카드에 이유를 적으며, 스레드에 넣지 못하면 `task_merge_inject_rejected`를 남기고 카드가 `⚠️ 머지 요청을 넣지 못함 — 스레드에 "머지해"라고 답해 주세요`로 바뀝니다. 오너가 아닌 사용자의 클릭은 다른 버튼처럼 거부됩니다.
- **막힘 카드의 `추천대로` 버튼**: 에이전트가 `recommend`를 적은 막힘 카드에는 `추천대로` 버튼(primary)과 `추천대로 = 위 추천 그대로 진행 · 다른 결정은 이 스레드에 답장` 줄이 붙습니다(추천이 비어 있으면 버튼 없음). 버튼 한 번은 그 스레드에 "추천대로"라고 답한 것과 같습니다: `🔘 추천대로 (버튼)` 표시 글과 오너 글 `추천대로 (추천: <카드의 추천 300자>)`가 들어가고, 카드는 버튼이 빠지고 `▶ 추천대로 진행 요청됨 · HH:MM — 추천: <120자>`로 바뀝니다. 같은 카드 재클릭은 `task_recommend_ignored reason=duplicate`, 이미 막힘이 아닌 작업·없는 작업은 `task_recommend_ignored`와 카드의 `이미 처리됐거나 막힌 상태가 아님 (…)`, 스레드에 넣지 못하면 `task_recommend_inject_rejected`와 `⚠️ 추천을 넣지 못함 — 스레드에 "추천대로"라고 답해 주세요`입니다. 알림 문구(`text`)는 버튼과 상관없이 그대로입니다.
- 그 밖에 spec 변경 경고, 30분 넘는 갱신 지연 시 에이전트 리마인더(30분에 한 번)와 2시간 넘으면 스레드 알림, 읽기 3회 연속 실패 알림이 키당 한 번씩 올라옵니다. 리마인더는 herdr `agent list`의 에이전트 상태가 `working`·`blocked`이면 끊지 않고 미뤘다가(`task_remind_deferred`) 쉬는 상태가 된 첫 스윕에 보내고, 상태를 묻지 못하거나 `unknown`이면 그대로 보냅니다. 에이전트가 턴을 끝내(`idle`·`done`) Outcome 미도달이면 30분을 기다리지 않고 다음 스윕에 미충족 이유 목록(앞 8개, 줄마다 200자)을 담은 재촉을 보내되 같은 이유 묶음으로는 한 번만 보내고, 30분 리마인더에도 같은 목록이 붙습니다(한 스윕에 에이전트로 가는 프롬프트는 최대 1회). herdr에 에이전트가 없으면 리마인더 대신 `👻 에이전트 없음` 알림(오너 멘션, `taskSpec:{id}` 재개 안내)을 스레드에 한 번 올리고, 재개 뒤 다시 사라지면 다시 한 번 올립니다. PROGRESS `updated`가 미래면 지금 시각으로 보고 `task_updated_future` 경고를 남깁니다.
- **워커 대기 알림**: herdr가 에이전트를 `blocked`(질문·승인 창 대기나 오류 정지)로 보고하면 다음 스윕(최대 5분)에 `⚠️ 워커 대기 · <제목>` 알림(오너 멘션, 화면 끝 12줄 코드 펜스(비밀값 모양은 가림, 읽지 못하면 `읽지 못함`), 끝에 `작업 보드` 링크)을 스레드에 한 번 올립니다. 대기 중인 에이전트는 herdr가 새 프롬프트를 거부하므로(`agent_blocked`) herdr 화면에서 직접 답합니다. 같은 대기에는 다시 올리지 않고, `working`·`idle` 등으로 바뀐 뒤 다시 대기하면 한 번 더 올립니다. 상태를 묻지 못한 스윕은 대기를 끝난 것으로 보지 않고, 동결 중에도 올라갑니다. 재시작하면 아직 대기 중인 작업에 한 번 더 올라올 수 있습니다.
- **전달 확인**: 후속 지시·재개·리마인더는 `herdr agent prompt --wait --until working --until blocked --timeout 15000`으로 보내 에이전트가 움직이는지 봅니다. 시작이 관측되지 않으면(`agent_prompt_stalled`·`timeout`) 후속 지시는 "전달은 했지만 작업 시작이 확인되지 않았습니다(<코드>)", 재개는 "(시작 확인 안 됨)"으로 알리고, 스윕 리마인더는 보낸 것으로 쳐 30분 안에 다시 보내지 않습니다(`task_remind_unconfirmed`). `--wait`를 모르는 옛 herdr에는 플래그 없이 한 번 더 보냅니다. 로컬 시작에서 `agent start`가 실패하면 그 시작이 만든 워크스페이스를 닫습니다.
- 미충족 재촉은 등록(또는 마지막 재개) 뒤 4회까지만 보냅니다. 5번째부터는 보내지 않고 스레드에 `⚠️ nudge 상한` 알림(오너 멘션, 남은 조건 목록)을 재개 전까지 한 번 올립니다(동결 중에도 올림). `taskSpec:{id}`로 재개하면 다시 4회를 셉니다. 30분 리마인더는 그대로입니다.
- **재개 점검**: `taskSpec:{id}`로 재개할 때 봇이 PROGRESS.md와 워크트리 git을 대조합니다. PROGRESS.md 마지막 커밋 뒤에 쌓인 코드 커밋(`docs/tasks/` 밖을 건드린 커밋)·빈 `next`·단계 목록에 없는 `current`·증거 없는 완료 단계(5개까지, 나머지는 `외 N개`)는 `재개 전 점검: …. 저장소 상태를 믿고 PROGRESS.md를 먼저 고친 뒤 잇는다.`로, 미커밋 변경은 지시 없는 `참고: ….`로 재개 프롬프트와 도구 결과에 실립니다(`task_resume_check` 로그). 읽지 못해도 재개는 막지 않고 `점검 읽기 실패: <오류>`를 적습니다.
- **재개 이해 알림**: 재개 프롬프트는 에이전트에게 다른 일보다 먼저 PROGRESS.md `restated`에 `과제 / 첫 next / 완료 조건`을 한 줄로 쓰게 합니다. 스윕은 처음 보는 `restated` 값을 스레드에 `🔁 재개 이해: <값>`으로 한 번 올리고(게시에 실패하면 기록하지 않고 다음 스윕에 다시), 재개 뒤 PROGRESS `updated`는 바뀌었는데 `restated`가 비었거나 재개 전과 같으면 `⚠️ 재개 뒤 PROGRESS는 갱신됐지만 재개 이해(restated)가 없습니다`를 재개당 한 번 올립니다.
- `review` 상태로 24시간이 지난 작업은 스레드에 `🔍 리뷰 대기 <N>시간` 알림(오너 멘션, 머지·취소 안내)을 24시간마다 한 번 올립니다(동결 중에도 올림). review 작업은 다시 판정하거나 herdr에 묻지 않습니다.
- 로컬 신규 작업은 `repo`의 상위 디렉터리가 있는 디스크의 여유가 5GiB 미만이거나 10% 미만이면 등록·워크트리·에이전트를 하나도 만들지 않고 `시작 거부: 디스크 여유 부족 (<경로> free_gib=<n>, 기준 5GiB·10%)`을 돌려줍니다. 원격 호스트 작업과 재개는 디스크를 보지 않습니다.
- **비밀값 가림**: 등록 때 taskSpec의 `title`·`goal`·`background`·`assumptions`·`scope`·`exclusions`, 수락기준의 `[check: …]` 앞 글, `context.md`의 요청 원문에서 토큰 모양 문자열과 알려진 비밀 값을 `[REDACTED]`로 바꾼 뒤 원장·4문서·접수 카드에 씁니다. 스윕도 PROGRESS.md의 `blocked_reason`·`question`·`recommend`·`impact`·`current`·`next`·`restated`와 outcome.md `## 요약`을 같은 방식으로 가린 뒤 원장 기록과 카드에 씁니다(워크트리 파일 자체는 고치지 않음).
- 수락기준의 `[check: …]` 블록은 재실행 명령이 바뀌지 않게 가리지 않고, 그 안에 가려질 문자열이 있으면 `taskSpec 수락기준 AC-n의 [check:] 명령에 비밀값으로 보이는 문자열이 있습니다 — 환경변수나 파일 경로로 넘기세요`로 등록을 거부합니다(원장 행·워크트리·브랜치를 만들지 않고, 메시지에 원문을 넣지 않음).
- 진행 중인 작업을 에이전트 이름으로 조회하면(`ompbot_dispatch {host?, mode:"herdr", name:"t-…"}`) herdr 출력 뒤에 `AC n/m · 단계 n/m · status · 마지막 갱신` 한 줄이 붙습니다.
- 완료 처리는 사람만 합니다. 봇 경로(도구·스윕)는 `done`·`cancelled`로 바꾸지 못하고 ledger가 거부합니다.
- 상태가 바뀔 때마다(등록 포함) 같은 트랜잭션에서 `task_transitions`에 `from→to`·`actor`(bot/human)·사유·시각이 한 줄씩 쌓이고(고치거나 지우지 않음, 기동 전 실패로 등록을 되돌릴 때만 함께 지움), `tasks show`의 `history` 배열로 보입니다. 도입 전 작업은 빈 배열입니다.

```sh
bun src/main.ts tasks list [--json]
bun src/main.ts tasks show <T-…>                        # 레지스트리 행 + 상태 전이 기록(history) + 지금 판정
bun src/main.ts tasks check <T-…>                       # 지금 판정; 실행 중인 데몬이 스윕과 같은 게시·반응을 합니다
bun src/main.ts tasks close <T-…> --as done|cancelled   # 사람 전용. 반응을 ✅/❌로 바꾸고 스윕 대상에서 뺍니다
bun src/main.ts tasks pause <T-…>                       # 오너 멈춤: 스윕의 재촉·stale 알림·자동 머지를 보류하고 워커에 Esc를 보냅니다(스레드의 `멈춰`와 같음)
bun src/main.ts tasks resume <T-…>                      # 멈춤을 풉니다(스윕 보류만 풀고 워커에 재개 프롬프트는 보내지 않음)
bun src/main.ts tasks flow --out <디렉터리> [--watch <초>] # 읽기 전용 DB로 흐름 뷰어 html + status.json을 씁니다(--watch면 status.json을 주기적으로 다시 씀, 1~2147483초. 감시 중 DB를 못 읽으면 'tasks flow: status.json not rewritten: …' 한 줄과 종료 코드 1)
```

`tasks check`는 데몬 답을 `[check:]` 신호 수 × 300초 + 60초까지 기다립니다. 소켓이 없거나 연결이 거부되면 "daemon not reachable — judging only, nothing posted"와 함께 로컬에서만 판정하고, 요청은 보냈는데 답이 그 안에 안 오면 "응답 지연 — 게시 여부 모름"을 알리고 로컬 재판정은 하지 않습니다(종료 코드 1).

`close`는 워크트리와 브랜치를 지우지 않습니다. 리뷰·merge 뒤에 사람이 정리합니다(원격 작업이면 그 호스트에서):

```sh
git -C <repo> merge task/T-…
git -C <repo> worktree remove <repo>-t-yyyymmdd-nn
git -C <repo> branch -d task/T-…
```

### `[TASK]` 자동 머지

`[TASK]`가 Outcome에 도달하면 봇은 보통 `🔍 머지 대기` 카드에 `머지` 버튼을 달고 오너의 "머지해"를 기다립니다. config `taskAutoLand`를 넣으면 아래 조건을 **모두** 채운 TASK는 봇이 그 스레드에 "머지해"를 직접 넣어 랜딩(close → ff 머지 → push → 워크트리 정리)을 시작하고, 카드는 질문 대신 `🚚 자동 머지` 알림이 됩니다. 서비스 반영(재시작)은 여전히 따로 승인받습니다.

- 봇이 도는 호스트의 TASK입니다. `dispatchHosts`의 원격 TASK는 설정과 관계없이 늘 오너에게 묻습니다.
- TASK 저장소의 git 공통 디렉터리(`git rev-parse --git-common-dir`)가 `repos` 항목 하나와 같습니다. 같은 저장소의 다른 워크트리는 맞고, 이름만 비슷한 다른 저장소는 맞지 않습니다.
- 위험등급이 `maxRisk`(기본 `L2`) 이하입니다.
- 봇이 워크트리에서 직접 다시 돌린 `[check: …]` 검사가 1개 이상이고 모두 통과했습니다.
- 무결성 경고와 "같은 커밋 증거" 경고가 없습니다.
- 봇이 동결(`ompbot freeze`) 상태가 아닙니다.

하나라도 못 채우면 `머지` 버튼 카드가 `자동 머지 안 함: <이유>` 줄과 함께 올라오고, 자동 투입이 실패하면 `⚠️ 자동 머지를 시작하지 못해 직접 정해 주세요.` 줄이 붙은 같은 카드가 올라옵니다. `ompbot reload`로 바로 켜고 끕니다(재시작 불필요).

```json
"taskAutoLand": { "repos": ["/home/me/work/ompbot", "/home/me/work/home-bot"], "maxRisk": "L2" }
```

재실행 검사는 수락기준 끝의 `[check: …]`이고 명령은 JSON argv로 씁니다. `[check: command ["bun","run","check"]]`는 받아들이지만 `[check: bun run check]`는 TASK 등록 때 거부됩니다.

작업 레인도 같은 `taskAutoLand`를 쓰지만 머지는 대화 세션이 아니라 코어가 직접 합니다. 조건과 절차는 [작업 레인](#작업-레인)의 "머지"를 보세요.

#### 레인 자동 머지 전 독립 리뷰 (`review`)

`taskAutoLand`에 `review`를 넣으면 작업 레인은 자동 머지 직전에 독립 리뷰를 한 번 받습니다. 기본은 꺼져 있고(`review` 없음 = 지금처럼 리뷰 없이 자동 머지), `[TASK]` 자동 머지에는 적용되지 않습니다.

```json
"taskAutoLand": { "repos": ["/home/me/work/ompbot"], "maxRisk": "L2", "review": { "model": "anthropic/claude-sonnet-5-5:medium", "timeoutMs": 600000 } }
```

- `model`(필수, 빈 문자열 불가, `cursor/`로 시작하면 거부)은 `omp --model`에 그대로 넘어갑니다. 마지막 줄 `VERDICT:` 형식을 잘 지키는 모델을 고르세요(예시는 sonnet). `timeoutMs`는 양의 정수, 기본 600000(10분), 최대 1800000. 다른 키는 거부됩니다.
- 다른 자동 머지 조건을 모두 채운 레인이 닫히면, 코어가 클레임 커밋에 고정한 새 `omp -p`(읽기 전용 도구 `read,grep,glob`, 아래 격리 적용)를 띄웁니다. 리뷰어는 스펙(레인 제목·브리프·수락기준) → 기준 브랜치와의 merge-base부터 클레임 커밋까지의 diff → 봇이 다시 돌린 `[check:]` 결과 순으로 읽고, 레인의 보고는 마지막에 대조만 합니다. 리뷰는 데몬 전체에서 한 번에 하나씩 백그라운드로 돕니다.
- 마지막 줄이 `VERDICT: CLEAR`면 그 커밋의 영수증이 레인에 남고 `🚚 자동 머지` 카드에 `🔎 독립 리뷰 CLEAR · <모델>` 줄이 붙어 머지됩니다. `VERDICT: BLOCK`이면 `자동 머지 안 함: 독립 리뷰 BLOCK`과 리뷰 지적 인용이 붙은 버튼 카드가, 시간 초과·종료 코드 오류·VERDICT 줄 없음/여러 줄이면 `독립 리뷰 확인 불가(<이유>)` 카드가 올라옵니다.
- 오너가 누르는 `머지`·"머지해"는 리뷰 결과와 관계없이 그대로 머지합니다(오너가 리뷰어입니다). 지적을 고치게 하려면 `!reopen <지시>`를 쓰세요. 다시 클레임하면 새 커밋을 다시 리뷰합니다.
- 같은 커밋은 재시작 뒤에도 다시 리뷰하지 않습니다. 리뷰 도중 데몬이 멈추면 영수증 없이 끝나고 다음 기동 뒤 다시 돕니다.
- 리뷰한 diff는 `<ompbot home>/reviews/<레인 ID>-<커밋 12자>.diff`(0600)에 남고, 레인이 머지·폐기·`!reopen`되면 지워집니다.
- 리뷰어 격리: 리뷰어는 레인 worktree가 아니라 빈 임시 디렉터리(`reviews/<레인 ID>-<커밋 12자>.cwd/`, 0700)에서 돌고, `--config <overlay>`(`.omp.yml`, 0600: 디스커버리 공급자 전부 끔·프로젝트 MCP 끔·autolearn 끔·memory off)와 `--no-extensions --no-skills --no-rules --no-context-files`를 받습니다. 그래서 worktree의 `.omp/extensions`·`.mcp.json`·`AGENTS.md`·`SYSTEM.md`·`.env`는 리뷰어의 설정·확장·지시·환경이 되지 않고 worktree 파일은 절대경로 read·grep·glob으로만 읽힙니다. overlay와 빈 디렉터리는 리뷰가 어떻게 끝나든 지워집니다.
- 남는 한계: 목표는 레인 파일이 리뷰어의 설정·확장·지시·환경이 되는 경로를 막는 것입니다. 리뷰어가 `read`로 worktree 밖 시스템 파일(데몬 OS 사용자가 읽을 수 있는 모든 파일)을 조회하는 위험은 OS 수준 샌드박스가 아니므로 완전히 막히지 않습니다. `[check:]`는 원래 레인 코드를 데몬 권한으로 실행합니다.

### 작업 레인

`작업: <제목> @<프로젝트 절대경로>`를 보내거나 채팅 세션이 host tool `ompbot_work_start`를 부르면, 그 경로가 속한 git 저장소에 레인 전용 worktree를 만들어 일하는 레인이 별도 스레드로 열립니다.

- 레인마다 ID `L-YYYYMMDD-NN`(봇 시간대 날짜)이 붙고, 저장소 옆 `<저장소>-l-yyyymmdd-nn` worktree에서 브랜치 `lane/L-YYYYMMDD-NN`으로 일합니다. 경로가 저장소 하위 디렉터리였으면 worktree 안의 같은 하위 경로에서 일합니다. 저장소 체크아웃 자체는 건드리지 않습니다. git 저장소가 아니거나, HEAD가 분리돼 있거나, 저장소 경로에 영숫자·`_ . / -` 밖의 문자가 있으면 시작하지 않습니다.
- 레인은 `🔄 제목` 루트와 `⏳` 상태 메시지(15분마다, 단계 보고 시 바로 갱신)를 갖고, 진행은 `ompbot_lane_progress`로 보고합니다.
- 동시에 최대 4개까지 열리고, 레인마다 worktree가 따로라 같은 저장소에도 여러 레인이 함께 열립니다.
- `ompbot_work_start`는 `acceptance`(수락기준 문자열 목록)와 `risk`(`L0`~`L4`, 생략하면 `L3`)를 받습니다. 수락기준 끝에 `[check: command ["bun","run","check"]]`(또는 `file <경로>`)를 붙일 수 있고, 형식이 틀리면 시작하지 않습니다. `작업: …` 메시지로 연 레인은 수락기준이 없습니다.
- 레인은 커밋하고 `ompbot_claim_done`을 불러야 닫힙니다. 미커밋 변경이 남았거나, 시작 커밋 뒤 새 커밋이 없거나, 커밋이 그 저장소에 없으면 거부하고 사유를 레인에 되돌립니다. 그다음 `[check: …]`가 있으면 코어가 worktree에서 하나씩 직접 다시 실행해, 하나라도 실패하면 `check AC-n 실패` 사유로 되돌립니다(클레임 커밋이 worktree HEAD가 아니면 검사 없이 되돌림, 같은 커밋은 다시 검사하지 않음). 검사를 바로 못 돌렸으면 5분 뒤 다시 판정합니다.
- **할 일 심기**: 새 레인 세션의 첫 턴 직전에 코어가 omp 할 일 목록(RPC `set_todos`)을 넣습니다: `수락기준` 단계(수락기준마다 `AC-n: <글>` 하나, `[check: …]` 꼬리는 뺌)와 `마무리` 단계(`변경 모두 커밋`, `ompbot_claim_done 호출`). 수락기준이 없으면 `마무리`만 넣고, 이어 가는 세션·`!reopen`에서는 넣지 않습니다. 첫 프롬프트의 `수락기준:` 본문은 그대로 갑니다. `agent`가 `claude`·`agy`면 할 일 목록이 없어 넣지 않고(`set_todos_unsupported` 로그), 넣기가 실패해도 경고 로그(`lane_set_todos_failed`)만 남기고 턴은 그대로 돕니다.
- **자동 재촉**: `working`·`not-done` 레인의 턴이 완료 주장 없이 정상으로 끝나면 코어가 `[자동 재촉 n/2] 턴이 완료 주장 없이 끝났습니다.`로 시작하는 메시지(미커밋 경로 수, 레인 시작 이후 커밋 수, not-done이면 마지막 거절 사유)를 레인에 넣어 이어 가게 합니다. 오너 메시지(또는 `!reopen`) 하나마다 최대 `lanes.completionNudges`(기본 2)회이고, 다 쓰고도 완료 주장이 없으면 스레드에 `⚠️ 자동 재촉 2회 뒤에도 완료 주장이 없습니다. 확인이 필요합니다.`를 한 번 남깁니다. 횟수는 장부에 있어 재시작해도 이어지고, 재촉 메시지 자신은 횟수를 되돌리지 않습니다. 실패·중단된 턴, 멈춘(`paused`)·완료 대기·닫힌 레인, 오너 답을 기다리는 질문 카드가 열린 턴, `ompbot_lane_progress`를 `needsOwner: true`로 부른 턴, 마지막 줄이 `?`로 끝나는 답, 이미 다음 메시지가 줄 서 있거나 동결 중일 때는 재촉하지 않습니다. 레인이 오너 결정을 기다릴 때는 `ompbot_lane_progress`({text, needsOwner: true})로 질문을 적고 턴을 끝냅니다.
- **레인 지켜보기**: 서버에서 `ompbot lanes watch <레인 ID|origin> [--lines N]`이 레인(또는 대화)의 omp 세션을 읽기 전용으로 따라갑니다. 사용자 글·답 글·도구 호출을 한 줄씩, 최근 N개(기본 10)를 보인 뒤 새 항목을 이어 붙이고 Ctrl-C로 멈춥니다. 데몬이 돌리는 세션 파일을 읽고, 돌고 있지 않으면 다음에 이어 갈 세션 파일을 읽습니다.
- 닫힌 레인은 머지를 기다립니다(아래 "머지"). worktree와 브랜치는 머지나 폐기가 끝날 때 지워집니다.
- git을 통과해도 완료 보고에 TODO/FIXME·건너뛴 테스트·스텁·가드 삭제(대응 부정 테스트 없음)·명령 없는 "통과" 주장이 있으면 무결성 거부되고, 오너 승인 버튼으로만 예외 처리합니다.
- 검증을 통과하면 레인이 닫히고 루트가 `🔍 제목`(머지 대기)으로 바뀝니다. ✅는 머지가 끝났을 때입니다(push가 거부되면 `⚠️`, 폐기하면 `🗑`). 레인 등록은 장부에 있어 재시작해도 스레드가 이어집니다.
- 닫힌 레인의 스레드에 오너가 쓴 메시지(`!followup <메시지>`의 메시지 포함)는 질문으로 처리합니다: 레인 세션이 답하지만 레인은 그대로 닫혀 있고 history에 `owner_question`만 남습니다(머지·폐기가 끝나 worktree가 없는 레인의 세션은 원래 저장소에서 답합니다). `!model`·`!new`·`!queue` 같은 채팅 명령은 원래대로 동작하고 history에 남지 않습니다. 세션에는 답만 하고 수정·커밋·완료 주장은 하지 말라는 안내가 함께 가고, 닫힌 레인에서 `ompbot_claim_done`·`ompbot_lane_progress`는 아무것도 바꾸지 않고 `!reopen` 안내를 돌려줍니다. 안내는 프롬프트 문구라 세션이 어기면 파일 수정 자체는 막지 못합니다(도구로 거부하는 것은 이 두 레인 도구뿐입니다).
- 수정을 다시 시키려면 레인 스레드에 `!reopen` 또는 `!reopen <지시>`를 씁니다. 같은 세션으로 다시 열리고(🔄) 닫힐 때의 커밋이 새 기준이 되어, 그 뒤 새 커밋과 `ompbot_claim_done` 검증을 다시 거쳐야 닫힙니다. 머지됐거나 폐기된 레인은 worktree가 없어 다시 열 수 없고(안내만 답함), 새 작업은 `작업: …`이나 `[TASK]`로 엽니다.

**머지(Outcome 카드).** 레인이 닫히면 레인 스레드에 `🔍 머지 대기 · <제목>` 카드가 올라옵니다: 레인의 완료 요약, 수락기준(봇이 다시 확인한 수/전체), 재실행 검사 통과 수, 브랜치와 커밋, `머지`·`폐기` 버튼. 머지는 대화 세션(모델)이 아니라 코어가 git으로 직접 합니다.

- **변경 칸**: 카드(머지 대기·자동 머지·머지 중·결과 모두)의 `변경` 칸은 기준 브랜치와의 merge-base부터 클레임 커밋까지 바뀐 파일 수와 `+추가 −삭제` 줄 수입니다(바이너리 파일은 파일 수에만 셈). 머지 대기 카드에는 많이 바뀐 파일 5개까지 `변경: 경로 (+x −y), …` 줄이 붙습니다. 카드를 처음 올릴 때 커밋마다 한 번 계산하고, git이 실패하면 칸에 `확인 실패`만 적습니다.
- **겹침 줄**: 머지 대기 카드에 `⚠️ 겹침: 레인 \`<이름>\` — 파일… · base가 그새 바꾼 파일 — 파일…`이 붙으면 같은 저장소의 아직 머지·폐기 안 된 다른 레인(대기·막힘 포함), 또는 merge-base 뒤 기준 브랜치가 같은 파일을 바꾼 것입니다. 일부를 못 읽었으면 `(일부 확인 실패)`가 붙습니다. 다른 레인은 브랜치에 커밋된 것만 보고(worktree의 미커밋 변경은 안 봄), 카드를 올린 시점 값이라 뒤에 다시 계산하지 않습니다. 겹침은 표시만 하고 자동 머지를 막지 않습니다.
- **`머지` 버튼, 또는 스레드에 `머지해`만 쓰기**: ① 기준 브랜치(레인 시작 때 저장소에 체크아웃돼 있던 브랜치)가 체크아웃돼 있고 깨끗하면 `git merge --ff-only <클레임 커밋>`, 다른 브랜치가 체크아웃돼 있으면 체크아웃·작업 트리는 건드리지 않고 `update-ref`로 기준 브랜치만 옮깁니다. ② `git push origin <클레임 커밋>:<기준 브랜치>`를 한 번 합니다(오너가 직접 요청한 머지는 저장소가 어디든 push하고, 카드에 `origin/<기준 브랜치>`를 적습니다. `origin` 원격이 없으면 push 없이 끝냅니다). ③ 머지가 확인된 뒤에만 레인 worktree와 `lane/L-…` 브랜치를 지웁니다. 끝나면 카드가 `✅ 머지 완료`로 바뀌고 머지 전 커밋(되돌리는 법)을 보여 줍니다. 서비스 반영(재시작)은 따로 승인합니다.
- **`폐기` 버튼, 또는 `폐기해`만 쓰기**: 머지하지 않고 worktree와 브랜치를 지웁니다. 커밋은 저장소 객체로 남아 `git branch <이름> <sha>`로 되살릴 수 있습니다(git이 정리하기 전까지).
- `머지해`·`폐기해`는 **메시지 전체가 그 한 마디**일 때만, 그리고 머지를 기다리는(대기·막힘) 레인에서만 명령입니다. `머지해 줘 제발`, `머지해야 하나?` 같은 문장과 이미 머지된 레인의 `머지해`는 평소처럼 레인 세션이 답하는 질문입니다. 버튼을 두 번 눌러도 머지는 한 번입니다. 동결 중에도 오너의 버튼·글은 처리합니다(동결은 봇이 스스로 하는 일만 막습니다).
- **막힘**: 체크아웃된 기준 브랜치에 커밋되지 않은 변경이 있으면 아무것도 바꾸지 않고 `🚧 머지 막힘` 카드(사유, 버튼 그대로)를 올립니다. 치운 뒤 다시 `머지`를 누르면 됩니다.
- **기준 브랜치가 앞서 나감(ff 불가)**: 기준 브랜치와 원격은 그대로 두고, 레인을 다시 🔄 working으로 돌려 "기준 브랜치 위로 rebase하고 다시 `ompbot_claim_done`"을 지시합니다. 다시 닫힐 때 검사도 다시 돕니다. 두 번째로 ff가 안 되면 레인에 돌려보내지 않고 `🚧 머지 막힘`으로 오너에게 넘깁니다.
- 완료 무결성 검사는 레인 커밋의 diff를 기준 브랜치의 현재 끝과 클레임 커밋의 merge-base부터 봅니다. 그래서 rebase한 레인이 기준 브랜치 쪽 커밋(예: 다른 작업의 `test.skip`) 때문에 거부되지 않습니다. `!reopen`으로 다시 연 레인은 직전 클레임이 아직 이력 안에 있으면 그 뒤 작업만 봅니다. 기준 브랜치가 없어졌거나 끝을 읽을 수 없으면 `lane_diff_unavailable` 거부로 닫고(오너 승인 카드로 넘길 수 있음) 조용히 통과시키지 않습니다.
- **push 거부**(원격이 앞섬, 체크아웃된 비베어 원격 등): 로컬 머지와 정리는 끝난 채 `⚠️ 머지됨 · push 안 됨` 카드에 사유를 남깁니다. 임시 브랜치로 돌려 올리는 우회는 하지 않습니다.
- **자동 머지**: config `taskAutoLand`가 있고, 저장소가 `repos` 안(같은 git 공통 디렉터리)이고, 위험등급이 `maxRisk`(기본 `L2`) 이하이고(`risk`를 생략한 레인은 `L3`), 재실행 검사가 1개 이상 모두 통과했고, 무결성 거부를 오너 승인으로 넘긴 레인이 아니고, 동결 중이 아니고, `review`를 켰으면 그 커밋의 독립 리뷰가 `CLEAR`이면([독립 리뷰](#레인-자동-머지-전-독립-리뷰-review)) 카드는 버튼 없는 `🚚 자동 머지` 알림이 되고 코어가 바로 위 절차로 머지·push합니다. 하나라도 걸리면 `자동 머지 안 함: <이유>` 줄이 붙은 버튼 카드가 올라옵니다. `작업: …` 메시지로 연 레인은 수락기준이 없어 늘 버튼으로만 머지합니다. `taskAutoLand`는 `herdr` 없이도 쓸 수 있습니다.
- 레인 세션이 아직 마무리 보고를 쓰는 중이면(그 턴이 지워질 worktree에서 돌고 있으므로) 머지는 예약만 해 두고 턴이 끝난 뒤 다음 점검(15초 주기)에 시작합니다. 그동안 `폐기`는 받지 않습니다.
- 클레임 뒤에 레인 브랜치에 커밋이 더 생겼으면(브랜치 끝이 클레임 커밋과 다르면) 머지하지 않고 사유를 알립니다 — 정리 때 브랜치를 지우므로 그 커밋이 사라지지 않게 `!reopen`으로 다시 클레임하게 합니다.
- 버튼을 눌렀는데 받을 수 없는 상태면(머지 진행 중, 마무리 보고 중 폐기 등) 레인 스레드에 이유를 답합니다.
- 같은 저장소의 머지는 한 번에 하나씩 차례로 합니다. 머지 도중 봇이 재시작되면 다음 점검 때 처음부터 다시 돌리는데, 이미 머지·push된 단계는 건너뜁니다(머지 전 커밋을 기록하기 전에 끊겼으면 카드에 reflog 안내가 나옵니다). git이나 호스트 오류로 세 번 연속 끝내지 못하면 `🚧 머지 막힘`이 됩니다.
- **컨텍스트·턴 예산**: 레인이나 TASK의 작업 범위는 단일 세션 컨텍스트 200k 토큰 이내(단계 3~5개)에서 완결되도록 작게 나눕니다. 300k를 넘어가면 프롬프트 캐시 재작성 비용과 오류율이 가파르게 상승하므로, 범위가 넓은 과제는 하나의 거대 레인 대신 단계별 연쇄 레인(기반 구현 → 어댑터 연결 → 화면/정리)으로 분할합니다.

## 모니터

봇이 묻지 않아도 정해진 때에 omp 턴을 돌려 오너 DM 최상위에 `⏰ <이름>` 메시지로 알립니다. CLI나 오너 DM 세션의 host tool `ompbot_monitor_add`/`ompbot_monitor_list`/`ompbot_monitor_remove`로 관리합니다("1분 뒤에 …라고 알려줘", "매일 …"). 스펙 검증은 둘이 같고, 모니터·레인 세션에는 이 도구가 없어 모니터가 모니터를 만들 수 없습니다.

```sh
bun src/main.ts monitors add --json '{"name":"아침","trigger":{"kind":"cron","schedule":"30 9 * * *"},"instruction":"오늘 일정 요약"}'
bun src/main.ts monitors add --json '{"name":"한번","trigger":{"kind":"at","at":"2026-12-01T09:00:00"},"instruction":"…"}'
bun src/main.ts monitors add --json '{"name":"디스크","trigger":{"kind":"script","command":["/home/me/.ompbot/scripts/disk.sh"],"intervalMs":300000},"instruction":"…","overlap":"skip"}'
bun src/main.ts monitors list [--json]
bun src/main.ts monitors show <id|이름>   # 모니터 1개 JSON, webhook이면 URL·토큰도 출력
bun src/main.ts monitors update <id|이름> --json '{"enabled":false}'
bun src/main.ts monitors test <id|이름>   # 지금 한 번 발사(script는 검사부터 실행)
bun src/main.ts monitors remove <id|이름>
bun src/main.ts monitors export --dir <디렉터리> [--with-files]       # 모니터 정의를 이식 가능한 파일로 내보내기
bun src/main.ts monitors apply --dir <디렉터리> [--prune] [--dry-run]  # 내보낸 파일을 이 홈에 적용
```

예시 모니터 [`examples/monitors/weekly-improvement/`](../examples/monitors/weekly-improvement)(주간 개선 회의)는 설치할 때 파일 안의 `@OMPBOT_HOME@`을 자기 홈으로 바꾸고, `collect.py`·`meeting.py`·`procedure.md`를 `<홈>/scripts/weekly-improvement-<원래 이름>`으로 둔 뒤 바꾼 `monitor.json` 내용을 `monitors add --json`에 넘깁니다. `procedure.md`의 `@REVIEWER_MODEL@`은 제안자(봇 기본 모델)와 다른 공급자의 검토 모델 id로 바꾸고, 없으면 그 줄을 지웁니다(자세히는 그 디렉터리의 README). 예시 모니터 두 개(`weekly-improvement`·`memory-audit`)는 `model`을 정하지 않으므로 봇 기본 모델로 돕니다.

### 내보내기·적용 (설치본 저장소)

모니터 정의는 DB에만 있으므로, 설치본 저장소(예: `hosts/<host>/monitors/`)에 두려면 `export`로 파일을 만들고 다른 홈에서는 `apply`로 넣습니다.

- `export --dir <d>`: 모니터마다 `<d>/<이름>.json`을 씁니다. 파일 이름은 이름의 `/`·공백·제어문자를 `-`로 바꾼 것이고, 같아지면 이름순으로 `-2`, `-3`을 붙입니다(파일 안의 `name`이 기준입니다). 내용은 스펙 필드(`name`·`trigger`·`instruction`·`overlap`·`enabled`·`channel`·`copyChannel`·`model`·`thinking`·`deliver`·`procedureFiles`)만 고정된 키 순서로 담고, 모니터 id·커서·상태·시각은 넣지 않습니다. `<홈>/scripts/` 아래 경로는 `@SCRIPTS@/`, workspaceDir 아래 경로는 `@WORKSPACE@/`로 바꾸고, 그 밖의 절대경로는 그대로 두고 stderr에 경고를 냅니다. webhook 트리거는 `{"kind":"webhook"}`만 쓰고 id·토큰은 내보내지 않습니다. 디렉터리에 남은 이전 `*.json` 중 지금 DB에 없는 모니터의 파일은 지웁니다(다른 파일은 그대로). `--with-files`면 참조된 script·절차 파일을 `<d>/files/scripts/`·`<d>/files/workspace/`에 실행 비트와 함께 복사합니다. 경로는 `..`·`.`을 풀어 정규화한 뒤 판정하므로 `<scripts>/../../x`처럼 루트 밖으로 나가는 인자는 루트 밖 경로로 보아 그대로 두고 경고하며, `files/` 밖에는 아무것도 복사하지 않습니다. 출력: `exported=N removed=N`.
- `apply --dir <d>`: `<d>/*.json`의 자리표시자를 이 홈의 경로로 풀고 `monitors add`와 같은 규칙으로 모두 검증합니다. 파일 하나라도 검증에 실패하면 실패한 파일과 사유를 stderr에 쓰고 아무것도 바꾸지 않은 채 종료 코드 2로 끝납니다. 이름으로 기존 모니터를 찾아 없으면 추가하고, 내용이 다를 때만 고치며(webhook id·토큰은 유지), 같으면 건드리지 않아 `updated_at`도 그대로입니다. 파일에 없는 필드는 기본값(`overlap` queue, `enabled` true, 옵션 해제)으로 봅니다. 디렉터리에 없는 모니터는 남기고, `--prune`이면 지웁니다(슬롯·이벤트와 함께). `--dry-run`은 같은 출력만 내고 DB를 바꾸지 않습니다. 출력: `added=N updated=N unchanged=N removed=N`. 파일 복사는 하지 않으므로 script·절차 파일은 적용 전에 그 홈의 `scripts`·workspace에 먼저 두어야 합니다.

### 트리거

- `cron`: 5필드, 기본 시간대는 설정 `timezone`(등록할 때 trigger에 채워 저장, `timezone`으로 모니터별 변경). 재시작 뒤 밀린 발사는 최근 24개·24시간 이내만 다시 돌리고 나머지는 건너뛴 것으로 기록합니다.
- `at`: ISO 시각. 오프셋이 없으면 설정 `timezone`의 벽시계로 읽고, 한 번만 발사한 뒤 꺼집니다. 24시간 넘게 지난 시각은 실행하지 않습니다.
- `script`: `~/.ompbot/scripts` 아래의 실행 파일만 허용, `intervalMs`는 60000 이상, 실행 60초 제한. exit 0이면 조건 성립으로 보고 stdout(8000자까지)이 자료로 전달됩니다. stderr는 판정에 쓰지 않고 마지막 2000자를 `monitor_script` 로그에 붙여 실패 원인을 남깁니다. `monitor_script` 로그 줄은 결과가 바뀌었을 때, 성립(exit 0)·오류·시간 초과, stderr가 있을 때만 남고, 변화 없는 조용한 미성립 검사는 기록하지 않습니다. 스크립트는 데몬 환경을 물려받지 않고 `PATH`·`LANG`과 그 모니터 id인 `OMPBOT_MONITOR_ID`만 받습니다.
  - `fire`(기본 `"edge"`): 성립하지 않던 상태(exit≠0, 또는 첫 관찰)에서 성립으로 바뀔 때 한 번만 발사하고, 다시 실패하면 재무장합니다. `"every"`는 성립한 검사마다 발사합니다.
  - `once: true`: 첫 발사 뒤 모니터가 꺼집니다(일회성 "…되면 알려줘"용).
  - `suppressUnchanged: true`: 성립한 실행의 stdout이 직전과 sha256까지 같으면 에이전트를 깨우지 않고 `no_change:<해시8>` 스킵으로 기록합니다. 해시는 에이전트 호출 전에 저장되므로 omp가 실패해도 같은 변경을 무한히 다시 알리지 않습니다. 다만 재무장 뒤(미성립 뒤 다시 성립)의 반복은 같은 stdout이어도 다시 발사합니다.
  - **wake gate**: stdout 마지막 줄이 정확히 `{"wakeAgent": false}`면 에이전트 실행과 전달을 모두 건너뜁니다(`wake_gate` 스킵).
- `watcher`: `{"kind":"watcher","root":"/절대/경로","debounceMs":1000}`. `root`는 존재하는 디렉터리이고 실제 경로가 config의 `watcherRoots` 안에 있어야 합니다(없으면 거부). 하위 디렉터리까지 재귀로 지켜보다가 마지막 변경 뒤 `debounceMs`(정수 100~60000, 기본 1000) 동안 조용하면 한 번 발사합니다. payload는 바뀐 상대경로 목록(줄마다 하나, 50개까지, 나머지는 `… and N more`)이고 `.git/` 안의 변경은 무시합니다. 감시는 데몬 점검 주기마다 장부와 맞춰 시작·중지되므로 CLI로 추가·수정·삭제해도 곧 반영되고, 감시 오류(루트 삭제, 파일 핸들 부족 등)는 `monitor_watch_error`로 남기고 다음 점검에서 다시 시도합니다. 변경 목록은 메모리에만 있어 재시작 때 잃고, drain 중에는 발사가 점검과 함께 미뤄집니다. `once`·`deliver:"verbatim"`은 쓸 수 없습니다.
- `webhook`: `{"kind":"webhook"}`. 모니터를 만들 때 128비트 무작위 id와 256비트 토큰이 생기고(수정해도 유지) `POST http://127.0.0.1:<port>/hook/<id>` + `Authorization: Bearer <토큰>`으로 발사합니다. `config.webhook`이 있어야 만들 수 있습니다. 토큰은 `monitors add` 출력, `monitors show`, 도구 `ompbot_monitor_add`의 응답에서만 확인하며 로그, `monitors list`(텍스트·`--json`), `monitors update` 출력, `ompbot_monitor_list`에는 나오지 않습니다(`list --json`·`update`는 `"***"`). 응답: `202 {"eventId","stage"}`(`overlap: skip`으로 건너뛴 발사도 202에 `stage:"skipped"`), 토큰 틀림 `401`, 모르는 경로·꺼진 모니터 `404`, POST 아님 `405`, 본문 256KiB 초과 `413`. 본문은 UTF-8 텍스트로 16KiB까지만(잘리면 표시) 이벤트 payload가 되어 프롬프트의 `[수신 본문]` 블록으로 들어가며, 외부 입력이라 지시가 아닌 읽을 자료로 표시됩니다. 리스너는 loopback 전용이고 포트를 못 열면 `webhook_bind_failed`를 로그에 남길 뿐 봇은 계속 돌며, `ompbot doctor`의 `webhook` 줄이 실패로 표시됩니다. 외부에서 받으려면 리버스 프록시·터널을 따로 두세요(HMAC 서명은 지원하지 않습니다). `ompbot_monitor_add` 도구 결과에 토큰이 나가므로 그 토큰은 omp 세션 기록에 남습니다.

### 옵션

| 필드 | 설명 |
| --- | --- |
| `name`, `instruction` | 이름, 지시(4000자 이하) |
| `overlap` | `queue`(기본: 앞 실행이 끝나면 이어서) · `skip`(앞 실행 중이면 건너뜀). 같은 발사 시각(슬롯)은 두 번 실행되지 않습니다 |
| `enabled` | 켜기·끄기 |
| `channel` | `C…`/`G…` 채널 id 또는 Discord 채널 id(숫자 17~20자리). 결과를 오너 DM 대신 그 채널 최상위에 올립니다. 긴 답의 나머지는 그 메시지 스레드에 달리고, `<@U…>`는 실제 멘션이 됩니다 |
| `copyChannel` | `C…`/`G…` 채널 id 또는 Discord 채널 id. 끝난 모든 실행의 사본을 그 채널 최상위에 더 올립니다. 조용히 넘어간 실행은 마커 줄을 뺀 답(남는 것이 없으면 `알릴 내용 없음`)으로 올리고, 실패 알림은 복사하지 않습니다 |
| `model`, `thinking` | 이 모니터 세션의 모델(`provider/id`)·thinking(`off\|minimal\|low\|medium\|high\|xhigh\|max`)을 고정합니다. 필드별로 대화방 선택보다 우선합니다 |
| `deliver` | `turn`(기본) · `verbatim`. 아래 참고 |
| `procedureFiles` | 최대 5개 파일 경로(절대, 또는 workspaceDir 기준 상대). workspaceDir 또는 `~/.ompbot/scripts` 안의 일반 파일만 허용하며(심볼릭 링크는 실제 경로로 판정) 밖이면 거부합니다. 발사할 때마다 디스크에서 다시 읽어 파일별 `[절차 파일 <경로>]` 블록으로 지시 뒤에 붙입니다. 합계 64KiB까지이고 넘으면 잘림 표시, 못 읽는 파일은 `읽기 실패` 줄로 남기고 발사는 계속합니다. 긴 절차를 4000자 지시 밖에 두는 용도입니다. `monitors update`에서 `null`이면 해제 |

`monitors update`에서 `channel`·`copyChannel`·`model`·`thinking`을 `null`로 주면 해제합니다. `monitors list`는 설정된 옵션(`channel=`·`copyChannel=`·`model=`·`thinking=`·`fire=`·`once`·`state=`·`deliver=verbatim`)을 함께 보여 주고, `monitors list --json`과 `ompbot_monitor_list`는 `deliver`를 늘 보여 줍니다.

### 실행과 전달

- **매 발사 새 세션**: 모니터가 쉬고 있으면 발사마다 새 세션으로 시작합니다(`/new`와 같은 방식). 쌓인 컨텍스트를 매번 다시 내지 않기 위해서이고, 모니터의 상태는 파일과 스크립트 출력에 둡니다. 앞 턴이 도는 중에 대기열로 들어온 발사는 그 세션을 이어 씁니다.
- **응답 억제**: 답의 첫 줄이나 마지막 줄(한 줄짜리 답이면 답 전체)이 `NO_REPORT` 또는 `[SILENT]`면 두 마커 모두 같은 규칙으로 게시하지 않고 결과만 저장합니다.
- **`deliver: "verbatim"`**(script 트리거 전용): 발사된 이벤트의 payload(스크립트 stdout 그대로)를 omp 턴 없이 `⏰ <이름>\n<payload>`로 바로 올리므로 모델·provider 장애가 전달을 막지 않습니다. 채널·사본·재시도·전달 확인은 턴 모니터와 같고, 쌓인 이벤트는 한 점검 주기에 차례로 모두 나갑니다. payload를 가공하지 않고 `NO_REPORT`·`[SILENT]`도 해석하지 않습니다(빈 payload만 `no_report`). `instruction`은 필수이지만 설명으로만 남고 `model`·`thinking`은 저장만 됩니다. verbatim 모니터의 trigger를 script가 아닌 것으로 바꾸려면 같은 update에서 `"deliver":"turn"`을 함께 줍니다.
- **실패**: 10분·1시간·4시간 뒤 재시도하고, 그래도 실패하면 알림을 한 번 보내고 멈춥니다(`failed_no_retry`). 빈 답도 실패로 셉니다. 같은 모니터가 같은 오류(지속시간과 4자리 이상 숫자는 정규화하고, 3자리 코드는 그대로 비교)로 다시 실패하면 24시간 안에는 조용하고, 성공 실행이 인시던트를 해소하면 다음 실패부터 다시 알립니다.
- `/status-ompbot`과 `ompbot status`는 모니터 개수와 다음 발사(이름·봇 시간대 시각)를 보여 줍니다.
- 실제 omp E2E: `OMPBOT_E2E_OMP=1 bun test test/monitor.e2e.test.ts`(토큰 소모).

## 운영

```sh
bun src/main.ts status [--json]   # 데몬이 꺼져 있으면 DB를 직접 읽습니다
bun src/main.ts doctor            # home·secrets·omp·bun·Slack auth·백업 번들 점검, herdr 켜짐이면 herdr --version과 herdr omp 통합, 이어서 dispatchHosts마다 ssh 도달과 herdr omp 통합(`ok`/`fail <사유>`, 통합·호스트 줄은 실패해도 종료 코드는 그대로)
bun src/main.ts offsite [--json]    # 최신 백업을 오프사이트(config offsite)로 다시 복제
bun src/main.ts gates [--json] [--strict]   # 읽기 전용 건강 판정 — 게이트 하나라도 열리면 exit 1, --strict는 판정불가(unknown)도 exit 1
bun src/main.ts gc [--dry-run]    # 보존 기간이 지난 이전 대화 세션, 오래 쉰 채널 스레드 세션, 삭제된 모니터의 세션, 7일 지난 `!undo` 턴 스냅샷 정리
bun src/main.ts backup [--keep N] [--max-bundle-bytes N]
bun src/main.ts drain [--wait] [--timeout <분>] # 재시작 전 대기(--wait 없으면 걸기만 하고 바로 끝남)
bun src/main.ts drain --cancel
bun src/main.ts apply [--detach] [--stamp <YYYYMMDD-HHMMSS>] [--timeout <분>] [--merged-at <ISO>] [--report-origin slack/ch/<C>|slack/dm/<D>|discord/ch/<ID>|discord/dm/<ID> --report-thread <ts|메시지 ID>] [--json]
                                  # 머지한 변경을 데몬에 반영(사전 검증→백업→drain→재시작→준비 대기→영수증)
bun src/main.ts restore <백업 db 경로> [--yes]   # 데몬이 꺼진 상태에서 ompbot.db를 백업으로 교체
bun src/main.ts freeze [--reason <이유>]  # 킬스위치: ~/.ompbot/FROZEN 작성
bun src/main.ts unfreeze          # FROZEN 삭제, 해제 시각을 ~/.ompbot/unfrozen-at에 기록
bun src/main.ts reload            # 실행 중인 데몬이 config.json을 다시 읽음(SIGHUP과 같음)
bun src/main.ts daemon            # 데몬 본체(systemd 서비스가 실행)
bun src/main.ts skills rollback <이름>           # 스킬을 직전 개정으로 되돌림
bun src/main.ts inject --origin slack/dm/<DM ID>|slack/ch/<채널ID>|discord/dm/<ID>|discord/ch/<ID> --as-owner --text "…" [--quoted "…"] [--thread <ts|메시지 ID>]
                                  # 로컬 소켓으로 오너 메시지를 주입(시험용·자동 후속, 답은 그 대화의 실제 Slack·Discord에 올라감)
                                  # --thread: 표식과 오너 메시지를 그 스레드(루트 ts·Discord 스레드 ID)의 답글로 올림(Discord DM: 그 메시지에 대한 답장)
                                  # 승인·질문 카드 스레드(대기 중·결정 끝 모두)에는 넣지 못함(inject_rejected, 표식만 남음): 카드는 오너가 직접 답함
bun src/main.ts tasks …           # [TASK] 상태 문서
bun src/main.ts monitors …        # 모니터
bun src/main.ts dashboard [--port N] [--bind 127.0.0.1|::1]   # 읽기 전용 현황판(루프백 HTTP)
bun src/main.ts feedback [--days N] [--json]   # 최근 N일(기본 7) 👎 턴 목록(읽기 전용, '답 피드백' 절)
journalctl --user -u ompbot -f
```

- **CLI 입력 오류**: 모든 CLI 명령은 모르는 옵션·값 없는 옵션·`--days -1`처럼 `-`로 시작하는 값을 `<명령>: <사유> (ompbot --help)` 한 줄과 종료 코드 2로 거부합니다(음수를 값으로 주려면 `--days=-1`). `reload`는 데몬이 없으면 `reload: daemon not reachable (…)`와 종료 코드 1입니다. `inject --text`가 비었거나 공백뿐이면 종료 코드 2입니다. `drain --timeout`은 숫자여야 합니다(빈 값 거부).
- **데몬 없을 때 `status`**: 토큰 파일을 읽지 않고 DB로 답하며, config.json이 없는 홈에서는 omp 버전을 `unknown`으로 보입니다. `ompbot.db`가 0바이트·손상·테이블 누락이면 원시 SQLiteError 대신 집계 0과 `자가진단 게이트 … ledger_unreadable error=…` 줄을 내고, `--json`도 같은 리포트를 JSON으로 냅니다(`ompbot gates`와 같은 게이트 이름).
- **omp 실행 파일 점검**: `ompExecutable`이 디렉터리·읽을 수 없는 파일이면 `ompbot doctor`·`gates`의 `omp_runtime` 줄/게이트가 `omp_launcher_unreadable`로 나옵니다.
- **로그**: `~/.ompbot/logs/ompbot.log`(키=값 형식, 10MB씩 최대 5개 파일로 회전). 토큰 모양 문자열과 알려진 비밀 값은 `[REDACTED]`로 바뀝니다. 로그 디렉터리에 쓸 수 없으면 데몬이 시작하지 않습니다(`log_dir_unwritable`). `ompbot.log`를 밖에서 지워도 데몬은 다음 줄부터 새 파일에 이어 쓰고, 보관 파일(`.1`~`.4`)은 그대로 둡니다.
- **로그 위생**: 반복되는 무의미한 `info` 줄은 한 줄씩 쓰지 않고 센 뒤 1시간마다 `log_summary window_s=… total=… <이벤트>=<개수> …` 한 줄로 냅니다. 대상은 `inbound_dropped`의 `reason=bot_message`·`reason=not_addressed`(키 `inbound_dropped_bot_message`, `inbound_dropped_not_addressed`)뿐이고, `warn`·`error`와 다른 이유의 drop은 그대로 한 줄씩 남습니다. 데몬이 종료될 때 남은 개수도 한 번 비웁니다. 또 1시간마다 `service_alive uptime_s=… origins=… busy=… pending=… dispatched=…`를 남기므로, 한 시간 넘게 이 줄이 없으면 데몬이 죽었거나 막힌 것입니다(`grep service_alive ~/.ompbot/logs/ompbot.log`).
- **상태 저장**: `~/.ompbot/ompbot.db`(SQLite WAL), 대화별 omp 세션은 `~/.ompbot/sessions/`. 데몬은 단일 인스턴스 잠금(`ompbot.lock`)과 0600 유닉스 소켓(`ompbot.sock`)을 씁니다.
- **봇 전용 omp**: 아래 [봇 전용 omp](#봇-전용-omp-버전-고정과-프로필)로 전역 omp 업데이트와 사람 omp의 설정·기억에서 봇을 떼어 낼 수 있습니다.
- **omp 업그레이드**: 데몬은 시작할 때 omp 버전이 바뀌었으면 `omp_version_changed`를 남기고, omp를 띄울 때마다 필요한 RPC 메서드가 있는지 확인해 없으면 `omp_rpc_client_missing`으로 바로 실패합니다. 그보다 먼저 `ompExecutable`이 패키지 launcher(`dist/cli.js` 심링크)인지, PATH의 bun이 omp `package.json`의 `engines.bun`을 만족하는지 확인해, 단독 실행 파일이면 `omp_launcher_standalone`, bun이 낡았으면 `bun_too_old`로 실패합니다. `omp update`는 bun이 요구 버전보다 낮으면 심링크를 단독 실행 파일로 바꿔 버리므로, **omp를 올리기 전에 `bun upgrade`를 먼저 하세요**. 같은 검사가 `omp_runtime` 게이트로도 돌아 업데이트 직후 5분 안에 자가진단 DM이 갑니다. 업그레이드 뒤에는 `bun run smoke-omp`로 호환성을 확인하세요(모델 비용 발생). 임시 세션 디렉터리에서 실제 omp로 RPC 계약과 채팅 명령(모델·thinking·compact·followup·queue·idle 해제·resume)을 돌립니다. 다른 omp는 `OMPBOT_OMP_EXECUTABLE=/경로/omp`, 모델은 `OMPBOT_E2E_OMP_PROVIDER`·`OMPBOT_E2E_OMP_MODEL`로 고릅니다.
- ops-check 점검 항목 예시(`svc-ompbot.service`, `ompbot-status`, `ompbot-backup-age`, `ompbot-gates`)는 [`examples/ops-check-ompbot.json`](../examples/ops-check-ompbot.json)에 있습니다. `@BUN@`·`@REPO_DIR@`·`@HOME@`·`@HOST@`를 자기 값으로 바꿔 ops-check 설정의 `checks`에 합칩니다.

### 봇 전용 omp: 버전 고정과 프로필

기본으로 봇은 사람이 쓰는 전역 omp와 그 에이전트 폴더(`~/.omp/agent`)를 그대로 씁니다. 그러면 `omp update`가 다음 재시작 때 봇에 바로 닿고, 사람·QA 세션과 봇이 같은 기억(mnemopi)·규칙을 씁니다. 아래 명령으로 둘을 떼어 냅니다.

- `ompbot omp install <버전>`: `~/.ompbot/omp/<버전>/`(0700)에 `bun add @oh-my-pi/pi-coding-agent@<버전>`으로 설치합니다. 설치된 `--version`이 `omp/<버전>`이 아니면 폴더를 지우고 실패합니다. `dist/cli.js`에 실행 권한을 줍니다. 쓰는 버전(`current`)은 바꾸지 않습니다.
- `ompbot omp use <버전>`: 없으면 설치한 뒤 봇과 같은 env(`ompProfile`, `model`)로 시험 실행 세 단계를 돌립니다 — ① 런타임 점검(launcher·bun), ② 대화 턴과 같은 RPC 드라이버로 "OK 한 단어로만 답해" 한 턴(120초), ③ `omp -p --no-title`로 같은 질문(120초, 종료 코드 0과 `OK`). 셋 다 통과해야 `~/.ompbot/omp/current`를 그 버전으로 바꾸고 이전 것을 `previous`로 남깁니다. 하나라도 실패하면 `current`는 그대로이고 출력 끝 20줄을 보이며 종료 코드 1입니다. ②·③은 고정 버전이 공유 로그인(`agent.db`)을 읽는지도 확인합니다. 재시작은 하지 않으니 `ompbot apply`로 반영합니다.
- `ompbot omp rollback`: `previous`를 `current`로 되돌립니다(시험 실행 없음, `previous`가 없으면 실패).
- `ompbot omp status`: `current`·`previous`·설치된 버전, 전역 omp 버전, `ompExecutable`이 `current`를 가리키는지, 프로필 폴더, 마지막 sync 시각과 지금 sync하면 바뀔 파일 수, 고정 버전이 봇 env로 `models --json`에 모델을 1개 이상 내는지(로그인 판독). 마지막 점검이 실패하면(전역 omp가 `agent.db` 스키마를 올린 경우 등) 종료 코드 1입니다. `ompbot doctor`의 `omp models` 줄도 `ompProfile`이 있으면 같은 env로 봅니다.
- `ompbot omp prune`: `current`·`previous`가 아닌 버전 폴더를 지웁니다(`~/.ompbot/omp/` 안만).
- `ompbot omp sync [--init]`: 사람 omp의 에이전트 폴더(`PI_CODING_AGENT_DIR`, 없으면 `~/.omp/agent`)를 봇 프로필 `~/.omp/profiles/<ompProfile>/agent`(0700)로 맞춥니다. `RULES.md`·`extensions/`·`skills/`·`models.yml`·`mcp.json`은 미러(원본에 없으면 지움, `*.bak*` 제외)이고, 그 안의 symlink는 원본 기준 실제 경로를 가리키는 절대경로 링크로 만듭니다(깨진 링크는 `warn` 한 줄 뒤 건너뜀). `config.yml`은 `~/.omp/agent`·`<HOME>/.omp/agent` 경로를 프로필 폴더로 바꿔 씁니다. 로그인 `agent.db`(`-shm`·`-wal`)는 복사하지 않고 원본을 가리키는 symlink로 둡니다(OAuth 갱신 토큰을 두 사본이 따로 갱신하지 않게). `managed-skills/`는 원본에만 있는 스킬을 더하고, 원본 `SKILL.md`가 다르고 더 새것이면 덮으며, 봇이 만든 스킬은 지우지 않습니다. `--init`이면 managed-skills를 원본과 같게 맞추고, 프로필에 기억이 없을 때 한 번만 `memories/mnemopi`(본 DB와 `banks/`)를 `VACUUM INTO`로 복사합니다. 세션·캐시·`history.db`·`models.db`·백업은 옮기지 않습니다. 바뀐 항목마다 한 줄, 마지막 줄 `omp_profile_sync changed=<n>`, 시각은 `~/.ompbot/omp/last-sync`에 남습니다.
- `ompbot apply`는 `ompProfile`이 있으면 drain 전에 sync를 돌려 영수증 `omp_sync` 단계에 `changed=<n>`을 남기고, sync가 실패하면 drain·재시작 없이 멈춥니다(돌고 있는 봇은 그대로).

처음 전환 절차:

```sh
ompbot omp install 18.18.9            # 전역과 같은 버전으로 시작
# config.json에 "ompProfile": "ompbot" 추가(재시작 전까지 돌고 있는 봇에는 반영되지 않음)
ompbot omp sync --init                # 프로필 폴더 채우기(기억은 이때 한 번만 복사)
ompbot omp use 18.18.9                # 시험 실행 세 단계 통과 시 current 교체, ompExecutable 경로 출력
# config.json: "ompExecutable": "<위에서 출력한 경로>"
ompbot apply                          # sync → drain → 재시작
```

이후 omp를 올릴 때는 `ompbot omp use <새 버전>` 뒤 `ompbot apply`, 문제가 있으면 `ompbot omp rollback` 뒤 `ompbot apply`입니다. Teams 손님 실행(`omp-qa`), herdr 워커, claude·agy 드라이버는 이 설정을 쓰지 않습니다.

### 현황판

`ompbot dashboard`는 데몬과 따로 도는 읽기 전용 HTTP 현황판입니다. 데몬이 죽어도 "데몬 꺼짐"과 DB에 남은 상태를 보여 줍니다.

```sh
bun src/main.ts dashboard --port 7331          # http://127.0.0.1:7331/
bun src/main.ts dashboard                      # config "dashboard": {"port": 7331}를 씀
```

- **실행**: 포트는 `--port` > config `dashboard.port` 순으로 정하고, 둘 다 없으면 usage를 내고 종료 코드 2로 끝납니다. 주소는 `--bind` > config `dashboard.bind` > `127.0.0.1`이며 `127.0.0.1`·`::1` 밖의 값은 받지 않습니다. 뜨면 `dashboard listening url=…` 한 줄을 내고 SIGTERM·SIGINT까지 돕니다. config.json은 읽지만 토큰 파일은 읽지 않습니다(슬랙 호출 없음). 화면 마스킹용 값 색인은 데몬과 같은 비밀 이름 환경변수·`OMPBOT_SECRET_GUARD_FILES` 파일로만 채웁니다(슬랙 토큰 값은 패턴 마스킹이 가립니다). 스냅샷 한 번이 30초 안에 끝나지 않으면 그 요청은 500(페이지는 "갱신 실패")이고 다음 요청이 새로 만듭니다.
- **경로**: `/`(HTML. `?view=<보기>`면 그 보기가, `?card=<key>`면 그 카드 상세가, `?task=<TASK ID>`면 그 TASK 상세가, `?view=<보기>&item=<id>`면 그 행 상세가 열린 채 그려짐), `/api/snapshot`(JSON), `/api/turn/<입수 번호>/trace`(그 턴의 트레이스 JSON, 아래 "턴 트레이스". 대기 중이거나 없는 턴은 404 `{ ok: false, error }`), `/api/thread/conversation?origin=<대화 키>[&before=<cursor>]`(그 대화의 omp 세션, 아래 "턴". 장부에 없는 대화는 404 `{"error":"unknown_origin"}`, 세션 파일이 없으면 404 `{"error":"no_session"}`), `/healthz`(`ok`), `/manifest.webmanifest`와 `/icons/{icon-192,icon-512,icon-maskable-512,apple-touch-icon}.png`(Chrome·Edge에서 주소창의 설치 아이콘으로 현황판을 앱 창으로 띄울 때 쓰는 web app manifest와 아이콘. 경로가 상대라 접두 경로 아래에서도 동작), 보드가 있으면 아래 보드 경로. GET·HEAD만 받고 그 밖의 메서드는 405, 모르는 경로는 404입니다. 같은 경로에 접두사가 붙어도(`/<접두사>/`, `/<접두사>/api/snapshot`) 같은 응답을 주고(페이지 HTML은 `/`와 한 단계 접두 `/<접두사>/`뿐이라 `/api/`·`/healthz/`·`/a/b/`처럼 `/`로 끝나는 다른 경로는 404), 페이지 안의 요청은 상대 경로라 프록시가 접두 경로 아래에 붙여도 그대로 동작합니다. 접두 경로로 열 때는 끝의 `/`까지 붙여 엽니다. 권장 노출은 접두 경로 없이 전용 호스트의 루트입니다(아래 보안 참고).
- **화면**: 데스크톱(1024px 이상)은 앱 셸입니다. 위쪽 상단 바에는 빵부스러기(`ompbot / <보기>`), 상태 칩(데몬 켜짐/꺼짐, 슬랙 소켓, 게이트, 동결·drain, 보드 끊김, 마지막 갱신 시각), Board/List 전환, 검색(`/` 키, 제목·TASK ID·머신), 명령 팔레트(`⌘K`/`Ctrl+K`), 테마 전환(`시스템`·`라이트`·`다크`, `localStorage`에 유지), 단축키 도움말(`?`)이 있습니다. 왼쪽 내비는 인박스·턴·레인·승인 대기·모니터·알림·시스템이고 항목마다 아이콘과 개수 칩이 붙습니다(승인 대기·열린 알림·사건 난 모니터·정체 턴·확인 필요 항목·게이트는 경고색). 가운데에 고른 보기가, 오른쪽에 상세 패널이 목록 옆에 열립니다. 가운데와 상세는 따로 스크롤합니다. 보기 전환은 주소에 `?view=`로 남고, 모르는 보기 이름은 안내 문구와 함께 인박스로 돌아갑니다.
  - **키보드와 명령 팔레트**: 입력창 밖에서 `j`/`k`(또는 `↓`/`↑`)로 카드·행 사이를 이동하고, `Enter`로 상세를 열며, `Escape`로 상세·명령 팔레트·도움말을 닫습니다. `g i`(인박스), `g l`(List), `g t`(턴), `g n`(레인), `g a`(승인 대기), `g m`(모니터), `g e`(알림), `g s`(시스템)로 보기를 바꾸고, `/`로 검색창에 포커스를 주며, `?`로 단축키 도움말 모달을 엽니다. `⌘K`/`Ctrl+K`를 누르면 명령 팔레트가 열려 보기 전환·카드 열기·테마 전환을 검색해 바로 실행할 수 있습니다. 데스크톱 하단 힌트 바에 주요 단축키가 안내됩니다.
  - **인박스**(기본): 열 3개(확인 필요·진행 중·완료·대기)에 카드를 놓습니다. 에이전트 패널 하나가 카드 하나이고, 패널과 짝지어진 TASK는 그 카드에 합쳐 한 번만 나옵니다. 카드에는 TASK ID·머신, 제목(TASK 제목, 없으면 패널 라벨), PROGRESS 현재 단계 요약(막혔으면 막힌 이유), 상태 배지, 경과, `AC n/m`·`단계 n/m`이 있습니다. 패널이 없는 열린 TASK는 TASK 단독 카드로 확인 필요 열에 나옵니다(보드가 없거나 끊기면 herdr 상태로 열을 고름). 닫힌 지 7일 안 된 TASK는 완료·대기 열 아래 "최근 닫힘" 접이식 목록에만 있습니다. 보드가 없는 설치본은 인박스 아래에 `herdr agent list` 결과(로컬과 `dispatchHosts` 호스트별)가 그대로 나옵니다.
  - **List**(`?view=list`): 같은 카드를 상태·제목·머신·TASK·AC·경과 열의 표 하나로 보여 줍니다. 기본 순서는 확인 필요 → 진행 중 → 완료·대기, 확인 필요 안에서는 인박스와 같은 순번, 나머지는 최근 변경 순이고, 머리글을 누르면 그 열로 정렬합니다(다시 누르면 반대로).
  - **턴**(`?view=turns`): 슬랙 스레드(= 대화 = omp 세션) 하나가 카드 하나이고, 인박스와 같은 열 3개(`확인 필요`·`진행 중`·`완료`)에 놓습니다. 열린 턴(`pending`·`dispatched`)이 있는 대화 전부와, 마지막 활동(그 대화 턴들의 `COALESCE(last_event_at, dispatched_at, created_at)` 가운데 최신)이 24시간 안인 대화가 나옵니다(최대 200개). 열은 이 순서로 처음 맞는 것입니다: 열린 턴 가운데 `정체`(`inbound_starved` 게이트와 같은 기준 — 진행 턴이 마지막 omp 이벤트, 이벤트가 없으면 dispatch 시각부터 10분 넘게 무음이고, 그 대화가 만료 전 승인 카드를 기다리는 중이 아님)가 있거나 열린 턴 없이 마지막 턴이 실패면 `확인 필요`, 열린 턴이 있으면 `진행 중`, 그 밖은 `완료`. 카드에는 머리줄(마지막 턴의 종류 `대화`·`명령`·`자동 후속`·`모니터`와 채널 ID, DM이면 `DM`, 채널 본문이면 `<채널> 채널 메인`), 제목(대화 첫 턴의 요청 한 줄 — 비밀 마스킹 → `[첨부: …]`는 `[첨부]` → 줄바꿈·연속 공백은 한 칸 → 80자 넘으면 79자+`…`, 명령은 명령과 인자, 모니터는 모니터 이름), 요약(마지막 턴의 요청 한 줄과 대기 이유 `재시작 대기`·`동결 중`·`팔로업 대기`·`앞 턴 대기`·`전달 대기`), 상태 배지·`정체`·drain 중의 `재시작이 기다리는 턴`, 마지막 활동 시각, `턴 n`(24시간 안 턴 수)·`진행 n`(열린 턴 수)이 있습니다. 열 안은 최근 활동 순입니다. List(`?view=turns&layout=list`)는 같은 카드를 상태·제목·종류·턴 수·경과·갱신 열의 표 하나로 보여 줍니다. drain 중이면 보드 위에 `진행 중인 턴 N개가 끝나면 재시작합니다 (가장 오래된 턴 경과 X). 그동안 들어온 요청은 재시작 뒤 처리됩니다.` 안내가 뜹니다. 왼쪽 메뉴 "턴" 개수는 열린 턴이 있는 대화 수 + `running` 작업 수입니다. 스냅샷 `turns.threads`가 그 재료이고, 열린 턴 행 그대로인 `turns.items`도 남아 있습니다.
    - 카드를 누르면(`?view=turns&item=<대화 키>`) 상세에 탭 `개요 / 대화 / 트레이스`가 뜨고 `대화`가 먼저 열립니다. 상세 상단 바의 `슬랙 스레드에서 답하기`는 그 Slack 스레드를 `slack://` 딥링크로 Slack 앱에서 열고(`slack.teamId`가 있어야 보임), Discord 대화는 `디스코드에서 답하기`가 `https://discord.com/channels/…`를 새 탭으로 엽니다. Discord DM은 늘 보이고, 서버 채널·스레드·Discord 작업 레인은 `channels.discord.guildIds`에 서버가 정확히 하나일 때만 보입니다(턴 기록에 서버 ID가 없음). `개요`는 마지막 턴의 상태·종류·대기 이유·요청·시작·경과·마지막 이벤트 뒤·스레드·입수 번호와 최근 턴 20개(시각·상태·요청 한 줄, 누르면 그 턴의 트레이스)입니다. `대화`는 그 대화의 omp 세션(`sessions/<대화>/e<n>/` 최신 파일, `/resume-ompbot`으로 고른 파일이 있으면 그 파일)에서 사용자 글, 모델 글, 접힌 "생각", 도구 호출(의도 한 줄, 없으면 인자 한 줄 120자)과 결과(앞 4000자, 실패면 `실패`, 결과가 아직 없으면 `진행 중`)를 인박스 카드의 대화와 같은 모양으로 보여 줍니다. 하위 에이전트는 그것을 띄운 `task` 호출의 결과 아래에 마지막 답만 붙습니다. 한 번에 최근 대화 턴(사용자 글 하나부터 다음 사용자 글 전까지) 20개이고 "이전 대화 더 보기"로 앞을 읽습니다. 스냅샷이 갱신될 때 그 대화의 마지막 활동이나 마지막 턴 상태가 바뀌었으면 다시 읽습니다(아래에 붙어 있으면 따라 내려가고, 위로 올려 읽는 중이면 위치를 지킴). 1차는 세션 기록에 남은 메시지 단위라 생성 중인 글자는 보이지 않습니다. 옛 주소 `?view=turns&item=<입수 번호>`는 그 턴이 든 대화를 `트레이스` 탭으로 엽니다.
  - **턴 트레이스**(턴 상세의 `트레이스` 탭, 기본은 마지막 턴): 그 턴의 omp 세션 기록(`sessions/<대화>/e<n>/` 최신 파일, `/resume-ompbot`으로 고른 파일이 있으면 그 파일)에서 턴이 시작된 뒤(같은 대화의 다음 턴 시작 전까지)의 모델 호출·도구 호출·하위 에이전트(`<세션 파일 이름>/<이름>.jsonl`, 2단계까지)를 시간축 막대 한 줄씩으로 그립니다. 색은 모델 호출 보라, 도구 청록, 턴·하위 에이전트 슬레이트, 실패 빨강입니다. 행마다 걸린 시간과 비용(턴·하위 에이전트는 자식 합계)을 붙이고, 끝난 호출 가운데 가장 오래 걸린 것에 "가장 느림"을 표시합니다. 위에는 전체 경과·모델·도구·하위 에이전트 수·토큰·비용 합계가 나옵니다. 턴이 도는 동안에는 실행 중 막대와 "지금" 선이 1초마다 자라고 5초마다 기록을 다시 읽으며, 새로 온 호출은 한 번 강조됩니다. 도구 결과 뒤의 모델 호출은 끝나야 기록되므로 그동안은 "응답 생성 중" 행으로 보입니다. 축은 10초·20초·30초·1분·2분·5분… 같은 둥근 단위로 늘어납니다. 끝난 하위 에이전트는 접힌 채 시작합니다. 행을 누르거나 `Enter`/`Space`로 트리 아래에 그 단계의 상세(시작 시각, 소요, 의도, 모델, 토큰, 비용, 오류)를 열고, 연 채로 `↑`/`↓`(`j`/`k`)로 옮기면 상세가 따라옵니다. `→`는 펼치기 또는 자식으로, `←`는 접기 또는 부모로, `Home`/`End`는 처음·끝 행, `Esc`는 상세를 닫습니다(상세가 닫혀 있으면 패널을 닫음). `트레이스` 탭이 열리면 데스크톱 상세 패널이 넓어지고, 560px보다 좁으면 행이 이름·시간·비용 한 줄과 막대 한 줄로 쌓입니다. 한 기록당 최근 400개 호출까지만 보여 주고 나머지는 생략을 알립니다.
  - **백그라운드 작업**(턴 보기의 보드 아래): 데몬·DB·herdr 밖에서 오래 도는 작업(예: `setsid nohup bun …`)은 `<ompbot 홈>/jobs/<이름>.json`에 진행 상태를 쓰면 여기에 행으로 나옵니다. `<이름>`은 `^[a-z0-9][a-z0-9._-]{0,63}$`이고 확장자 `.json`만 읽습니다(그 밖의 파일·디렉터리는 열지 않음). 필드는 필수 `state`(`running`|`done`|`stopped`|`failed`, `stopped`는 일부러 멈춘 작업)·`updatedAt`(ISO 8601)과 선택 `title`·`done`·`total`·`unit`·`startedAt`·`pid`·`thread`(작업을 띄운 대화 `<채널>:<ts>`, 글자로만 보임)·`detail`·`log`(경로만 보이고 파일은 읽지 않음)입니다. 예: `{"title":"oh-my-pi 코드 지도","state":"running","done":290,"total":10254,"unit":"조각","updatedAt":"2026-11-04T22:48:44+09:00","pid":494313}`. 쓰는 쪽은 같은 디렉터리의 임시 파일(예: `<이름>.json.tmp`)에 쓴 뒤 `rename`으로 바꿔 넣습니다(현황판이 반쯤 쓴 파일을 읽지 않게). `done`·`total`이 0 이상 정수이고 `done ≤ total`일 때만 진행 막대와 `done/total unit (pct%)`가 나옵니다. 상태 판정: `state=failed`는 실패, `running`인데 `pid`가 있고 그 프로세스가 없으면 멈춤(프로세스 없음), `running`인데 `updatedAt`이 10분 넘게 지났으면 갱신 끊김, JSON이 깨졌거나 `state`·`updatedAt`이 없으면 파일 오류(제목은 파일 이름, 설명은 오류 요약), 나머지는 진행 중·완료·중단입니다. 완료·중단은 보드 아래 "끝난 백그라운드 작업"에 접혀 있고 `updatedAt` 뒤 24시간까지만 보이며, 최대 50개를 최근 갱신 순으로 보입니다. `title`·`detail`은 비밀 마스킹 뒤 120자·200자로 자릅니다. 왼쪽 메뉴 "턴" 개수에는 `running` 작업 수가 더해지고, 실패·멈춤·갱신 끊김·파일 오류 작업이 있으면 경고 표시가 켜집니다. 행을 누르면 상태·진행·시작·마지막 갱신·pid·스레드·로그 경로·설명이 상세에 열립니다. 현황판은 이 디렉터리를 읽기만 하고 파일을 만들거나 지우지 않으므로 다 끝난 파일은 쓰는 쪽이 지웁니다(지우지 않아도 `done`·`stopped`는 24시간 뒤 목록에서 빠짐).
  - **모니터**(`?view=monitors`): 켜진 모니터를 다음 실행 순(`오늘`·`내일`·`그 뒤`·`예정 없음` 묶음)으로 한 행씩 보여 줍니다. 행에는 다음 실행 시각과 일정(`매일 07:30`·`평일 09:00`·`10분마다`, 그 밖의 cron은 원문, Asia/Seoul이 아니면 시간대 이름), 지시 첫 문장(마스킹, 80자), 보내는 곳(`오너 DM`·`로그 채널`·`채널 <ID>`, 사본은 `+ 사본`)·모델·절차 파일·스크립트 이름 칩, 최근 7회 점(점마다 시각과 결과 이름표, 수동은 점선), 마지막 실행(`전달 11-05 23:35 · 5분 52초`, 재시도면 `재시도 N회 · 지연 포함 …`)이 나옵니다. 마지막 실행이 아직 끝나지 않았으면 `실행 중`, 가장 최근 실행부터 연달아 실패했으면 `최근 실패`·`연속 실패 N회`(최근 7회 안에서 셈), 열린 사건이 있으면 `사건 N` 배지가 붙고, 연속 실패나 열린 사건이 있는 모니터가 있으면 내비의 모니터 숫자와 시스템 보기의 모니터 카드가 주의로 바뀝니다. 목록 위 한 줄에는 오늘 남은 실행 수와 최근 30일(예정 시각 기준) 전달·조용히 끝남·건너뜀·실패 횟수 합계가 나옵니다. 검색은 이름·지시 첫 문장·보내는 곳·일정·모델·파일 이름에 맞춥니다. 행을 누르면(`item=<모니터 id>`) 일정·보내는 곳·모델·상태(실행 중·연속 실패·열린 사건)·최근 30일 결과 횟수와 정기 실행의 끝날 때까지 걸린 시간 중앙값(재시도 대기 포함, 수동 실행 제외)이 바로 보이고, 그 모니터의 대화가 턴 보드에 있으면 `이 모니터의 대화 보기` 링크가 붙으며, 지시 원문·절차 파일 앞 2000자·최근 실행 10개는 경로 `/api/monitor/detail?id=<모니터 id>`(JSON. 빈 id는 400 `{"error":"invalid_id"}`, 없는 모니터는 404 `{"error":"unknown_monitor"}`)로 그때 읽어 채웁니다.
  - **나머지 보기**: 레인, 승인 대기, 알림, 시스템. 행을 누르면 스냅샷에 있는 필드만으로 상세가 열립니다.
  - **승인 대기**: 대기 중인 승인 카드마다 행 하나입니다. 제목은 요약 첫 줄의 첫 문장(80자 넘으면 79자+`…`)이고, 배지는 남은 시간(`N분 남음`, 10분 이하면 경고색, 만료 시각이 지났으면 `만료 처리 중`)과 되돌릴 수 없는 이유가 있는 요청의 `되돌릴 수 없음`입니다. 메타 줄은 `요청 HH:MM · 만료 HH:MM`과 요청한 곳(`DM`·`채널 <C> 스레드`·`채널 <C> 메인`)입니다. 상세에는 요약 전문, 슬랙 카드와 같은 `할 일`·`이유`·`영향`·`되돌릴 수 없는 이유`(값 있는 것만), 남은 시간·요청·만료·요청한 곳, `슬랙 카드 열기`·`요청 스레드 열기` 링크(새 탭)가 나오고, 승인 ID·대화 키는 접힌 `내부 정보` 안에 있습니다. 승인·거절은 슬랙 카드에서 합니다. 세부 항목과 링크는 승인 장부의 `detail_json`·`card_url`·`origin_url`(카드를 올릴 때 저장, permalink를 못 구하면 비움)에서 오므로, 이 칼럼이 생기기 전 행은 `세부 내용 없음(요약만 받은 요청)`과 `슬랙의 승인 메시지에서 승인하거나 거절해요.`만 보입니다. 대기 목록 위 한 줄에는 최근 7일 동안 끝난 요청의 `승인`·`거절`·`답장`(있을 때만)·`만료` 횟수와, 오너가 답한 것(만료 제외)의 카드 게시부터 답까지 걸린 시간 중앙값이 나옵니다. 대기 목록 아래 `최근 결정`에는 끝난 요청 20개가 결정 시각 최신순으로 나오고(결과 배지, `요청 MM-DD HH:MM · <걸린 시간> 뒤 <결과>`, 요청한 곳), 누르면 같은 상세가 남은 시간·만료 대신 결과·요청·결정 시각으로 열립니다. 내비의 승인 대기 숫자는 대기 중인 것만 셉니다.
  - **알림**: 아직 정리되지 않은(`alerted`) 인시던트마다 카드 하나입니다. 제목은 사람이 읽는 이름입니다 — `gate:<이름>`은 게이트 이름표(예: "최근 1시간 턴 실패가 3회 이상", "레인이 24시간 넘게 멈춤", "백업이 36시간 넘게 없음". 숫자는 `src/ops/gates.ts` 상수에서 만듦, 이름표에 없는 게이트는 이름 그대로), `turns:<대화>`는 "대화 턴 연속 실패 · <대화>", `dispatch:<대화>`는 "턴 전달 실패 · <대화>". 배지는 같은 스냅샷의 게이트 판정으로 `지금 열림`(빨강) · `지금은 닫힘 · 기록만 남음`(회색) · `상태 모름`(노랑: 게이트를 읽지 못했거나 게이트가 아닌 알림)입니다. 지금 열린 것이 먼저, 그다음 최근 발생 순이고, 카드에는 처음·마지막 시각, 횟수, 지속 시간, 할 일 한 줄이 있습니다. 열린 알림이 없고 기록만 남았으면 위에 "지금 열린 알림은 없습니다" 안내가 뜨고, 왼쪽 내비의 알림 숫자는 지금 열린 알림 수만 세어 경고색으로 보이며 열린 것이 없으면 숫자를 감춥니다(닫힌 기록은 목록에만 남음). 서명 해시·범위·인시던트 id·게이트 detail은 상세 패널에만 있고 서명은 복사 버튼으로 복사합니다.
  - **시스템**: 묶음 카드 7개(데몬: 켜짐/꺼짐·시작 뒤 경과·커밋·omp 버전·동결·drain / Slack: 소켓 상태와 그 뒤 경과 / 스윕·하트비트: 나이·loop ms, `SWEEP_STALLED_MS`를 넘으면 주의 / 전달 장부: 대기·보내는 중·확인·모호·만료, 모호·만료가 있으면 주의 / 백업: 로컬·오프사이트 마지막 시각과 나이, 36시간(`BACKUP_MAX_AGE_MS`)을 넘으면 주의 / 게이트: `ompbot gates`와 같은 게이트를 한 줄씩, 열린 것이 위 / 모니터·herdr 머신: 개수와 연결 상태)를 데스크톱 2~3열, 좁은 화면 1열로 놓습니다. 카드 머리글에는 상태 점과 `정상`·`주의`·`문제` 글자가 함께 붙습니다.
  - **상세 패널**: 카드·행을 누르면 페이지 안에서 열리고 주소에 `card=`·`task=`·`item=`이 붙습니다(새 탭으로 열지 않음. 새 탭은 "herdr에서 답하기"·"디스코드에서 답하기"·대화 속 외부 링크만). 닫기 버튼이나 Escape로 닫으면 포커스가 고른 카드로 돌아가고, 뒤로가기를 누르면 열기 전 주소로 돌아갑니다. 상세 헤더에는 `TASK ID 복사`·`브랜치 복사`·`카드 키 복사` 버튼이 있어 누르면 클립보드에 복사되고 하단 토스트(`복사됨: …`)로 알려 줍니다. TASK 상세(그리고 TASK가 짝지어진 카드 상세)에는 ID·위험 등급·브랜치·머신·AC 충족 수/전체(막대)·단계와 지금 단계·PROGRESS status·updated·막힌 이유·워커 상태, 그리고 AC 체크 목록(항목마다 충족/미충족)과 단계 목록(완료·지금·남음)이 나옵니다. 두 목록은 스냅샷의 열린 TASK에 붙는 `acceptance`(`{ id, text, checked }`)·`steps`(`{ id, text, done }`)에서 오고, 문구는 비밀 마스킹을 거칩니다. 대화 탭의 도구 호출 블록은 한 줄 요약으로 접혀 있고 눌러서 펼칠 수 있습니다.
  - **흐름 고리**: 요청 스레드 하나가 어떤 `[TASK]`들을 거쳐 어디까지 왔는지를 `요청` 상자 → 병렬 묶음 상자들로 그립니다. 대상은 최근 7일 안에 등록됐거나 아직 열린(working·blocked·review) TASK가 있는 요청 스레드이고, 상자마다 상태 칩과 지금 단계 한 줄이 붙으며, 열린 TASK 가운데 막힌 첫 TASK(없으면 가장 먼저 등록된 열린 TASK)에 `지금 여기`가 표시됩니다. `요청` 상자 제목은 그 스레드 첫 입수 글의 한 줄이며, ompbot이 붙인 인용 감싸기(`[인용·전달된 자료]` 안내 줄과 `<<<quoted-…>>>` 블록, 닫히지 않은 여는 표지 뒤 전부)는 빼고 오너 글만 잇습니다. 남은 글이 없거나 첨부뿐이면 `[첨부] <첫 TASK 제목>`입니다(턴 보드 요청 한 줄도 같은 규칙, TASK가 없으면 첨부 파일 이름). 턴·TASK·인박스 카드 상세 패널에 그 스레드의 고리가 `n/m 끝남`과 함께 따로 절로 나오고, TASK 상자를 누르면 `?view=flow&item=<TASK ID>` 페이지에서 그 TASK 상세가 열립니다. 왼쪽 내비에는 흐름 메뉴가 없고 `?view=flow` 주소로만 엽니다.
    - **병렬 묶음**: TASK를 등록 시각 순으로 놓고, 지금 묶음이 끝나기(묶음 안 TASK의 닫힌 시각 중 가장 늦은 때, 열린 TASK는 등록 뒤 10분) 전에 등록된 TASK는 같은 묶음 상자에 세로로 쌓습니다. 묶음 머리에는 `1차 · 병렬 3`과 걸린 시간(열린 TASK가 있으면 `진행 중`)이 붙고, 등록 시각을 읽을 수 없는 TASK는 맨 끝에 혼자 묶음이 됩니다. 좁은 화면에서는 묶음을 세로로 쌓습니다.
    - **대기 알약**: 묶음 사이 화살표 위의 노란 `대기 N분`(`N시간 M분`, 초는 버림)은 앞 묶음이 끝난 뒤 다음 묶음이 등록되기까지 걸린 시간입니다. 앞 묶음에 열린 TASK가 있거나 1분 미만이면 나오지 않습니다.
    - **단계 띠**: TASK 상세의 AC·단계 목록 위에 `스펙 → S1…Sn → 판정 a/b → 리뷰 → 착지` 띠가 끝남(초록)·지금(파랑, `지금 여기`)·시작 전(점선)으로 나옵니다. 단계가 9개를 넘으면 지금 단계 앞의 끝난 단계를 `S1–Sk 끝남` 한 칸으로, 지금 단계 뒤 셋째부터를 `+m 남음` 한 칸으로 접습니다. 막힌 TASK는 지금 칸(없으면 판정 칸)이 빨강이고 띠 위에 `막힘 <이유>`가 붙으며, 리뷰 대기는 리뷰 칸이 지금, 완료는 모두 끝남, 취소는 띠가 흐려집니다. 단계 목록이 없는 TASK에는 띠가 없습니다.
  - 좁은 화면(1024px 미만)에서는 내비가 줄바꿈되는 칩 줄이 되고, 인박스 열은 세로로 쌓여 열 칩으로 이동하며, 표는 카드처럼 접히고, 상세는 전체 화면으로 열려 뒤로가기로 닫힙니다.
  - **다음 줄**: 인박스 열 위에 지금 먼저 볼 확인 필요 항목 하나를 `다음 · 제목 · 이유 · 머신·TASK · 기다린 시간` 한 줄로 보입니다. 확인 필요 순번은 실패(문서 판정 실패·워커 확인 실패·워커 사라짐·알 수 없는 상태) → 막힘 → 그 밖(에이전트 카드 없음 등) → 답변 도착(TASK 없는 패널이 끝나 다음 지시를 기다림) 무리 순이고, 무리 안에서는 오래 기다린 순입니다. 이유는 실패 사유가 먼저입니다. 검색어와 무관하게 전체 첫 항목이며, 누르면 상세가 열리고 옆의 `herdr에서 답하기 ↗`(그 패널에 답하는 곳이 있을 때)는 새 탭으로 엽니다. 그 카드에는 `다음` 꼬리표가 붙고, 실패 무리 카드는 빨간 왼쪽 테두리입니다. 확인 필요가 없으면 `다음 · 기다리는 항목 없음`, 갱신 실패·데몬 꺼짐·보드 끊김이면 `다음 · 상태 모름 — 갱신 끊김`입니다. 새로 확인 필요가 되거나 열을 옮긴 카드에는 1.6초 동안 고리가 한 번 그려집니다. 카드 `since`(그 상태가 된 시각)는 `<ompbot 홈>/dashboard-board-since.json`(0600, 상태가 바뀔 때만 임시 파일 뒤 rename으로 씀, 보드에서 사라진 카드는 7일 뒤 지움)에 남아 `ompbot-dashboard`를 재시작해도 같은 상태면 이어집니다. 파일이 없거나 깨졌거나 저장된 상태와 다르면 재시작 직후 처음 본 카드는 시각을 모르는 카드(`since` 0)가 되어 카드·상세·다음 줄 경과가 `-`로 보이고, 같은 무리 안에서 시각을 아는 카드보다 뒤에 놓여 `다음`으로 뽑히지 않습니다. 현황판이 켜진 뒤 바뀐 상태는 바뀐 시각부터 셉니다.
  - **묻는 말·마지막 말**: 이 현황판이 도는 머신(local)의 omp 패널이 막혔거나(blocked) 끝났으면(done), `herdr agent list`가 주는 그 패널의 세션 파일(`agent_session` 경로, 절대경로 `.jsonl`만)을 끝에서부터 256KB씩 줄 단위로 거꾸로 읽어(최대 4MB) 마지막 assistant 메시지를 찾습니다. 막힌 패널 카드는 답을 기다리는 `ask` 질문을 `묻는 말: <질문>`(여러 개면 `외 N개`)으로, 선택지를 그 아래 한 줄(` / `로 이음)로 보이고, 결과가 안 온 다른 도구 호출이면 `도구 실행 승인 대기: <도구>`, 오류로 끝났으면 `프로바이더 오류: <첫 줄>`을 보입니다. TASK 없이 끝난 패널(답변 도착)은 마지막 답의 첫 문장(120자까지)을 보입니다. 다음 줄 이유도 같은 말로 바뀌고(`답변 도착 · <첫 문장>`), 카드 상세에는 질문 전체와 선택지 전체가 목록으로 나옵니다. 모두 비밀 마스킹을 거칩니다. 한 스냅샷에서 읽는 패널은 12개(막힌 패널 먼저)까지, 읽기 전체 1.5초까지이고, 바뀌지 않은 파일(경로·수정 시각·크기 같음)은 다시 읽지 않습니다. 깨진 줄은 건너뛰고, 파일이 없거나 읽지 못하면 그 패널만 비며 상세에 작은 글로 남습니다. 다른 호스트(`dispatchHosts`, 예: WSL) 패널의 세션 파일은 읽지 않습니다.
  - **모델 칩**: 턴 보드 카드 아래 줄과 대화 상세 `개요`에 그 대화의 omp 세션이 쓰는 모델(공급자 뺀 이름)과 thinking을 `claude-opus-5-5 · high` 칩으로 보입니다. 세션 파일(`origins.session_file`, 없으면 그 대화 `session_dir` 바로 아래 가장 최근 `*.jsonl`)의 앞 64KB와 끝 256KB(256KB 이하 파일은 통째로)에서 마지막 assistant 메시지의 모델·`thinking_level_change`를 읽고, `!model`·`!thinking`으로 정한 값이 있으면 그 값을 씁니다. 폴백 판정은 마지막으로 읽은 `model_change`의 `resolvedModelIsFallback`이 참일 때뿐이며, 그때 칩이 경고색과 `폴백` 글자로 바뀝니다. 읽지 않는 중간 구간에서 폴백으로 갔다가 돌아온 것은 보이지 않습니다. 파일이 없거나 모델을 못 찾으면 칩이 없고, 같은 파일(경로·크기·수정 시각)은 다시 읽지 않습니다.
  - **마지막 지시**: ompbot이 herdr 에이전트에 지시를 넣을 때마다(위임 새 시작·후속, `[TASK]` 시작·재개, 스위퍼 리마인더, herdr가 받았을 때만, 시작 확인이 안 된 후속도 포함) 비밀 마스킹한 한 줄 미리보기(120자)와 시각을 `herdr_prompts` 표에 남깁니다(에이전트당 최근 20개, 30일 지나면 지움, 원문은 남기지 않음). 에이전트 보드 카드에는 같은 이름의 최근 기록이 `마지막 지시 · <얼마 전>: <미리보기>` 한 줄로, 카드 상세에는 `마지막 지시` 절로 붙고, 리마인더는 `리마인더`로 표시됩니다. 로컬 카드는 로컬 herdr 기록만, 다른 머신 카드는 원격 호스트 기록 가운데 이름으로만 찾으므로 서로 다른 원격 호스트가 같은 이름을 쓰면 가장 최근 것이 보입니다. 기록이 없으면 줄이 없습니다.
  - **숫자 키**: 화면에 보이는(검색으로 걸러진 뒤) 확인 필요 카드 앞 9개에 1~9 번호가 붙고, 인박스에서 입력창·모달 밖이면 그 숫자 키로 상세를 엽니다. `r`은 다음 줄 항목의 `herdr에서 답하기`를 엽니다.
  - **탭 신호**: 탭 제목이 확인 필요 개수(`(2) 확인 필요 · ompbot 현황판`, 없으면 `ompbot 현황판`)를, 갱신 실패·데몬 꺼짐·보드 끊김이면 `(!) ompbot 현황판`을 보이고, 파비콘도 보통·빨간 점(확인 필요)·회색(이상)으로 바뀝니다. 탭이 숨어 있어도 60초마다 스냅샷만 받아 제목·파비콘을 고치고, 스냅샷 요청은 8초 안에 답이 없으면 갱신 실패로 봅니다.
  - 첫 화면은 서버가 그리고(자바스크립트 없이도 읽힘), 15초마다 `api/snapshot`을 다시 받아 다시 그립니다. 외부 CDN·폰트·스크립트는 없습니다.
- **읽기 전용**: 스냅샷은 10초 동안 재사용하고(그동안 데몬 소켓·herdr·ssh·git을 다시 부르지 않음) 동시에 온 요청은 한 계산을 함께 기다립니다. DB는 매번 읽기 전용 핸들로만 열고, 전달 장부를 건드리는 `Store`나 task 장부 쓰기 핸들은 열지 않습니다. 섹션마다 `{ ok: true, … }` 또는 `{ ok: false, error }`라 herdr 호스트 하나가 꺼져 있어도 그 항목만 실패로 보입니다. `gates`(게이트별 `name`·`state`·`detail`, `ompbot gates`와 같은 `collectGates`를 스냅샷당 한 번)와 `backup`(`local`·`offsite`의 시각과 나이, 오프사이트 미설정은 `null`)도 같은 규칙이라, 게이트 판정이 실패하면 `gates`만 `ok:false`가 되고 알림 카드는 `상태 모름`으로 보입니다. 제한시간은 데몬 소켓 10초, `herdr agent list` 로컬 10초·ssh 15초, TASK 문서 평가 행당 15초입니다.
- **보안**: 메시지 본문(입수 원문, 전달 본문, 모니터 답·payload·지시, 승인 답글)은 스냅샷에 넣지 않습니다. 예외는 턴 보드 대화들의 요청 한 줄과 모니터 지시의 첫 문장 한 줄뿐이며 비밀 마스킹을 거친 80자까지만 넣습니다(모니터 턴은 넣지 않음). 또 로컬 omp 패널이 막혔거나 끝났을 때 그 패널의 대기 중 `ask` 질문·선택지(각 400자까지)와 막힌 이유·마지막 답 첫 문장(120자까지)을 비밀 마스킹해 넣습니다(위 **묻는 말·마지막 말**). 모니터 지시·절차 파일 전문은 `api/monitor/detail`에서만, 요청할 때만, 비밀 마스킹해 내보내고 모니터 답·payload는 어디에도 내보내지 않습니다. omp 세션 본문은 `api/thread/conversation`에서만, 요청할 때만, 모든 글(사용자 글·모델 글·생각·도구 의도·출력)을 비밀 마스킹해 내보냅니다. 세션 내용이 보이므로 루프백 밖 노출은 아래 Cloudflare Access 뒤에서만 합니다. 턴 트레이스(`api/turn/<입수 번호>/trace`)는 세션 기록 가운데 도구 이름·모델 이름·시각·토큰·비용과, 비밀 마스킹을 거친 도구 의도 한 줄(60자)·실패한 도구 출력의 첫 부분(160자)·실패한 모델 호출의 오류(160자)만 내보내며, 대화 본문·도구 인자·도구 출력은 내보내지 않습니다. 제목·요약·터미널 제목·요청 한 줄 같은 자유 문자열은 비밀 마스킹을 거친 뒤 HTML escape됩니다. 앱 자체 인증은 없으므로 루프백 밖으로 열 때는 전용 호스트의 루트 경로로 열고 Cloudflare Access를 반드시 앞에 둡니다(Access 없이 공개하지 않습니다). 예: Cloudflare Tunnel ingress에 `hostname: ompbot.example.com`, `service: http://127.0.0.1:<port>` 항목을 catch-all보다 위에 넣고, 같은 호스트에 Access 애플리케이션·정책을 걸어 로그인한 사용자만 통과시킵니다.
- **에이전트 보드(herdr 작업 보드 대체)**: config에 `herdrBoard`가 있으면 현황판이 herdr-web-ui(`herdrBoard.api`, 기본 `http://127.0.0.1:7317`)의 `/api/machines/events`를 읽기 전용 GET 한 줄기로 붙잡고(끊기거나 45초 동안 heartbeat 주석 줄조차 없으면 끊긴 것으로 보고 스스로 다시 붙음), 연결된 모든 머신의 에이전트 패널을 인박스 카드로 보여 줍니다. 패널은 확인 필요(blocked·모르는 상태, 짝지어진 TASK가 blocked이거나 판정 실패, TASK 없이 done인 답변 도착)·진행 중(working)·완료·대기(idle·TASK가 있는 done) 열에 놓이고, 카드에는 머신·워크스페이스·탭 이름, 상태 배지, 그 상태가 된 뒤 지난 시간(현황판이 본 시각 기준, 재시작 뒤에도 since 파일로 이어짐, 모르면 `-`)이 붙습니다. 패널의 TASK(`tasks.agent`가 패널의 에이전트 이름과 같거나 TASK worktree가 패널 cwd와 같을 때)는 그 카드에 합쳐집니다. 보드는 `api/board/events`(변경마다 스냅샷, 15초 keep-alive)로 실시간 갱신되고, 나머지는 그대로 15초마다 갱신됩니다. 카드를 누르면(또는 `?card=<key>`로 들어오면) 상세 패널이 열리고, 개요(상태·머신·cwd, `dashboard.herdrWebUrl`이 있으면 "herdr에서 답하기" 링크, 짝지어진 TASK의 정보)·대화(최근부터, "이전 대화 더 보기")·plan 탭으로 나뉩니다. 카드 key는 herdr-web-ui의 로컬 머신이면 `<pane>`, 다른 머신이면 `<machine id>:<pane>`로 herdr 작업 보드와 같습니다. 대화·plan 본문은 비밀 마스킹 뒤 제한된 마크다운으로만 그리며(원격 이미지·스크립트·iframe 없음) 입력 보내기·패널 조작은 없습니다. `herdrBoard`가 없는 설치본은 보드 없이 `herdr agent list` 블록 그대로입니다.
  - 경로(접두사 허용, GET·HEAD만): `api/board`(`{ ok, generatedAt, machines, cards }`, 첫 목록 전이나 끊긴 동안 503 `{"error":"herdr_unreachable"}`, 보드가 꺼진 설치본은 404 `board_disabled`), `api/board/events`(SSE `event: snapshot`), `api/pane/conversation?card=<key>[&before=…]`·`api/pane/plan?card=<key>`(herdr-web-ui `/api/pane/<종류>` 또는 `/api/machines/<id>/pane/<종류>`로 GET만 전달, 상류 제한 10초, 보드에 없는 key는 404 `unknown_pane`, 상류 실패는 502 `upstream`·`herdr_unreachable`).
  - herdr 작업 보드(`~/repos/herdr-board`, 7330)에서 옮겨 오기: ① config에 `"dashboard": {"port": 7331, "herdrWebUrl": "<herdr-web-ui 공개 주소>"}`를 넣고 `herdrBoard.url`을 현황판 공개 주소(예: `https://ompbot.example.com/`)로 바꾼 뒤 `ompbot reload` — 위임 접수 카드·알림의 "진행 보기" 링크가 `<현황판>?card=<key>`로 바뀝니다(키 형식이 같아 코드 변경 없음). ② 이미 보낸 슬랙 메시지의 옛 `https://<host>/task/?card=…` 링크는 터널(예: cloudflared ingress)에서 그 호스트의 `path: ^/task(/|$)` 규칙 서비스를 `http://127.0.0.1:<현황판 포트>`로 바꾸면 그대로 열립니다(현황판은 `/task/` 같은 접두 경로와 `?card=`를 받습니다). 같은 Access 정책을 유지하고, 설정 파일은 `.bak`을 남긴 뒤 바꿉니다. ③ 옛 링크가 현황판으로 열리는 것을 확인한 뒤 herdr 작업 보드 플러그인을 멈추고 걷어냅니다.
- **서비스**: `units render`가 `ompbot-dashboard.service`(`ExecStart=… src/main.ts dashboard`, `Restart=on-failure`)도 씁니다. config에 `dashboard.port`를 넣은 뒤 `systemctl --user enable --now ompbot-dashboard`로 켭니다. 데몬 재시작은 필요 없습니다.
- **설정 바꾸기**: 현황판은 시작할 때만 config.json을 읽으므로 `dashboard` 키를 바꾸면 `ompbot reload`로는 반영되지 않습니다. `systemctl --user restart ompbot-dashboard`로 다시 띄웁니다.

### 동결(킬스위치)

`ompbot freeze --reason "…"`는 `~/.ompbot/FROZEN`(JSON: `since`, `reason`, `by`, 0600)을 씁니다. 데몬은 이 파일을 2초 안에 다시 읽어 반영하며 재시작이 필요 없습니다. 동결 중에는:

- `ompbot_dispatch`가 모든 모드(원격 포함)에서 "동결 중" 오류를 돌려주고 아무 명령도 실행하지 않습니다.
- 모니터가 발사되지 않습니다. 시각이 된 발사는 `skipped` 이벤트(사유 `frozen`)로만 남고 커서가 앞으로 가므로, 해제해도 몰아서 쏘지 않습니다. 해제 전에 이미 큐에 있던 이벤트도 `skipped`(`error=frozen`)가 되고, script 점검은 실행되지 않습니다. 시각이 된 한 번짜리 `at` 모니터는 꺼지지 않고 기다렸다가(`monitor_at_held_frozen`, 동결마다 한 번) 해제 뒤 한 번 발사됩니다(그 사이 24시간이 지나면 `catchup_age`로 건너뛰고 꺼짐). `monitors test`는 동결 중에도 수동 이벤트를 만들지만 출력에 `"frozen":true`가 붙고, 데몬은 그 이벤트를 `skipped`로 처리합니다.
- 새 작업 레인 시작이 거부되고(`lane_refused_frozen`), 실행 중인 레인에는 not-done 판정 뒤의 자동 재프롬프트를 보내지 않습니다(`lane_send_held_frozen`). 레인이 동결 중에 스스로 완료를 주장하면 판정은 그 도구 응답으로만 돌아가고, 레인은 not-done 그대로 다음 주장을 기다립니다. 코어가 미뤄 둔 완료 주장 재판정(검증을 못 끝내 5분 뒤 다시 보는 것)은 동결 동안 하지 않고, 재판정 도중(검증·무결성 승인 대기 중) 동결되면 not-done을 확정하지 않은 채(`lane_verdict_held_frozen`) 주장을 남겨 둡니다. 해제 뒤 첫 점검에서 다시 판정해 not-done이면 그때 재프롬프트합니다. [TASK] 스윕은 에이전트에게 정체 리마인더를 보내지 않습니다(`task_remind_frozen`은 동결마다 task당 한 번; 해제 뒤에도 정체면 그때 전송). 차례가 온 [스킬 리뷰](#스킬-리뷰)도 돌리지 않습니다(`skill_review_skipped_frozen`).
- 오너 메시지에 답하는 대화 턴은 계속 동작합니다. 오너가 봇과 대화하며 원인을 묻고 풀 수 있습니다. 채팅 명령은 없고, 해제는 `ompbot unfreeze`뿐입니다.
- `frozen` 게이트가 열려 있어(`ompbot gates` exit 1, 5분 안에 `🚨 [자가진단]` DM) 잊고 지나치지 않습니다. `ompbot status`/`/status-ompbot`에는 `FROZEN · <since> · <by> · <reason>` 줄이 나옵니다.
- `FROZEN`이 디렉터리면 `ompbot freeze`는 `FROZEN is not a regular file; run ompbot unfreeze first`로 실패하고(동결은 유지), `ompbot unfreeze`는 디렉터리째 지웁니다. 해제가 실패하면 `unfrozen-at`은 이전 값으로 돌아갑니다.

### 재시작과 drain

코드·설정 변경을 데몬에 반영할 때는 `ompbot apply` 한 줄로 합니다. 진행 중인 턴을 끊지 않도록 drain을 걸고 기다린 뒤 재시작하며, 단계마다 영수증을 남깁니다.

```sh
cd ~/work/ompbot && bun src/main.ts apply --merged-at <머지 시각 ISO> [--timeout 60]
# 봇과 대화하는 세션(턴 안)에서는 턴이 끝나야 drain이 끝나므로 분리 실행합니다:
bun src/main.ts apply --detach --merged-at <ISO> --report-origin slack/ch/<채널ID> --report-thread <요청 ts>
# Discord에서 받은 요청이면 Discord origin과 메시지 ID(snowflake)를 줍니다:
bun src/main.ts apply --detach --merged-at <ISO> --report-origin discord/dm/<DM ID> --report-thread <메시지 ID>
```

순서와 판정:

1. **사전 검증** — 이 체크아웃의 현재 브랜치가 `main`이고 `HEAD == main`, `git status --porcelain -- src`가 비어 있고, `systemctl --user is-active <유닛>`(4단계)이 0이어야 하고(user bus 없음 포함), `bun`을 찾을 수 있어야 합니다(프로세스 PATH 앞에 `~/.local/bin`, `~/.bun/bin`을 붙이므로 systemd user PATH에서도 찾습니다). 하나라도 어긋나면 아무것도 바꾸지 않고 SKIP(종료 코드 3)입니다. `--merged-at`을 주면 데몬 `ActiveEnterTimestamp`가 그보다 뒤일 때 이미 반영된 것으로 보고 성공(0)으로 끝납니다.
2. **백업** — `ompbot backup`과 같은 스냅샷에 더해 `config.json`을 `config.json.bak-<stamp>-apply`(0600)로 복사해 영수증용 기록으로 남깁니다(롤백 대상은 아님). config가 가장 최근 `*-apply` 사본과 바이트까지 같으면 새로 만들지 않고 그 사본 경로를 영수증 `configBackup`에 적으며, 새로 만들었으면 `*-apply` 사본을 최신 10개만 남깁니다(손으로 만든 다른 `bak` 이름은 건드리지 않음).
3. **drain** — `drain --wait`와 같은 경로(`--timeout` 분, 기본 60). 시간 초과·소켓 불통이면 재시작하지 않고 실패(1)로 끝나며, 시간 초과는 drain을 풀고 끝납니다.
4. **재시작** — `systemctl --user restart <유닛>`. 유닛은 활성 `ompbot*.service` 중 ExecStart가 이 체크아웃의 `src/main.ts daemon`이고 `OMPBOT_HOME`(없으면 `~/.ompbot`)이 이 홈인 것입니다(못 찾으면 `ompbot`). 1단계의 `is-active` 검사도 같은 유닛을 봅니다.
5. **준비 대기** — 최대 2분 동안 IPC `status`가 응답하고 `ompbot.lock`의 `startedAt`이 재시작 요청 시각보다 뒤인 새 프로세스일 때만 통과합니다(옛 데몬이 계속 응답하는 경우는 통과하지 않음).
6. **기록** — `collectGates` 결과와 `doctor` 요약을 영수증에 적습니다. 열린 게이트·doctor 실패는 보고만 하며 반영을 되돌리지 않습니다.
7. **실패 시 롤백** — 재시작 단계 이후 실패하면 `config.json.last-good`(데몬이 부팅해 `daemon_ready`를 찍은 직후, 재시작 필요 필드 없이 `reload`가 전부 적용된 직후, apply가 새 데몬 준비를 확인한 뒤에 원자적으로 남기는 0600 사본. 데몬은 자신이 검증한 내용만 기록합니다. 부팅 때는 `loadConfig` 직전에 읽은 텍스트를 기준으로 삼아, 그사이 파일이 바뀌었거나(`config_changed_since_boot`) 그 텍스트를 읽지 못했거나(`config_unreadable`) `restart_required`가 있으면 `last_good_config_skipped`만 남깁니다)에서 `config.json`을 복원하고 한 번 더 재시작합니다. last-good이 없으면 "복원할 정상 config 없음"을 영수증에 적고 config는 건드리지 않습니다. 새 데몬을 확인하지 못한 채 끝나는 경로(재시작 실패·롤백 재시작 실패)에서는 IPC `drain_cancel`을 시도하고 결과를 영수증에 남깁니다. **코드는 자동으로 되돌리지 않고**, 영수증에 이전 HEAD sha(reflog `HEAD@{1}`)와 되돌리기 명령(`git diff --cached --quiet && git read-tree -m -u HEAD <이전> && git commit` — merge 커밋이 있어도 트리째 복원하되 무관한 로컬 수정·미추적 파일은 보존하고, staged 변경이 있으면 실행하지 않음)을 적습니다. 종료 코드는 1입니다.
8. **다른 설치본** — 이 설치본이 성공(이미 반영 포함)으로 끝나면, 같은 체크아웃으로 도는 다른 활성 설치본(`units render --instance`로 만든 `ompbot-<이름>`)마다 1~7단계를 그 홈·유닛으로 차례로 돌립니다(같은 `--timeout`·`--merged-at`·stamp, 보고 inject 없음, 영수증은 각 홈의 `logs/`). 결과는 이 영수증의 `peers` 단계에 `<유닛>=<상태>(<영수증>)`로 적히고, 하나라도 성공·이미 반영이 아니면 전체가 실패(1)입니다. 이 설치본이 SKIP·실패면 다른 설치본은 건드리지 않습니다.
9. **영수증** — `~/.ompbot/logs/apply-<stamp>.json`에 단계별 `name`·`ok`·`detail`·`ms`, 게이트·doctor 요약, 이전 HEAD, 백업 경로를 남깁니다(0600). `--report-origin`(+`--report-thread`)을 주면 — origin은 `slack/ch/<C>`·`slack/dm/<D>`·`discord/ch/<ID>`·`discord/dm/<ID>`(스레드 origin은 안 됨), 스레드는 Slack origin이면 ts(`1793318305.840629`), Discord origin이면 메시지 ID(17~20자리 snowflake) — 성공·실패·SKIP 모두 `[자동 후속] apply 결과 … 영수증 경로`를 그 스레드에 오너 메시지로 넣고, 그 inject 결과도 영수증 `report`에 기록합니다(inject가 실패해도 종료 코드는 바뀌지 않음). 데몬 소켓이 연결을 받지 않으면(`Failed to connect`·ECONNREFUSED·ENOENT — 다른 apply나 수동 재시작으로 잠깐 내려간 때) 5초 간격으로 최대 6번까지 시도하고, 데몬이 응답한 거절(`ok:false`)은 다시 시도하지 않습니다. `report.detail`에 시도 횟수(`attempts=N`)가 적힙니다.

- **한 번에 하나** — 같은 홈의 apply는 `<홈>/apply.lock`(`{pid, stamp, startedAt}`, 다 쓴 임시 파일을 `link`로 걸어 반쯤 쓴 락이 없음)을 잡고 1단계부터 돕니다. 다른 apply가 쥐고 있으면 `wait_apply` 단계로 기다리며 그동안 drain·재시작을 하지 않습니다(상한 `--timeout` 분 + 2분, 넘기면 아무것도 바꾸지 않고 `failed` `apply <stamp> still running after N min`). 락을 얻으면 1단계를 돈 뒤 기다린 apply의 영수증을 보고(`prior_apply` 단계), 그 영수증이 끝나 있고 상태가 성공·이미 반영이며 `head`가 지금 HEAD와 같으면 재시작·다른 설치본 없이 `already_applied`(`applied by apply-<stamp>`)로 끝냅니다. 그 apply가 실패(다른 설치본 실패 포함)했거나 HEAD가 다르거나 영수증을 읽지 못하면 2단계부터 전부 다시 돕니다. 락 주인 프로세스가 죽었거나 JSON이 깨진 락은 기다리지 않고 회수합니다(`stale lock <stamp> taken over`, 동시에 회수해도 주인은 하나). 락은 마지막 영수증(보고 inject 결과 포함)을 쓴 뒤에 풀므로, 기다리던 apply는 늘 완결된 영수증을 읽습니다. 다른 설치본은 각자 홈의 락을 씁니다.
- `--detach`: 같은 인자로 `systemd-run --user --collect --unit=ompbot-apply-<stamp>`를 띄우고 유닛 이름과 영수증 예정 경로(`apply_detached unit=… receipt=…`)를 출력한 뒤 바로 끝납니다(PATH·`OMPBOT_HOME`을 유닛에 넘김). 영수증이 생기거나 `--report-origin` 보고가 오지 않으면 `journalctl --user -u ompbot-apply-<stamp>`를 보세요.
- `--stamp YYYYMMDD-HHMMSS`: 영수증·백업 이름에 쓸 stamp를 고정합니다. `--detach`가 자식 유닛에 자기 stamp를 넘길 때 쓰며, 직접 줄 일은 거의 없습니다(형식이 다르면 사용법 오류 2).
- 종료 코드: 0 성공·이미 반영, 1 실패(롤백 수행), 2 사용법 오류, 3 사전 검증 SKIP. `--json`은 영수증 JSON 한 줄만 출력합니다.
- 반영 전 코드 머지·승인은 `apply`의 일이 아닙니다. 같은 날 변경이 여럿이면 머지를 모았다가 한 번에 반영하세요(재시작마다 살아 있던 세션의 캐시가 다시 쓰입니다).

`apply` 없이 손으로 하려면 아래처럼 drain 뒤에 재시작합니다. 봇과 대화하는 세션이라면 답이 먼저 나가도록 지연 실행으로 겁니다.

```sh
systemd-run --user --on-active=90 --unit=ompbot-restart \
  bash -lc 'cd ~/work/ompbot && bun src/main.ts drain --wait --timeout 60 && systemctl --user restart ompbot'
```

- `drain`은 데몬 메모리에만 걸리고(재시작하면 풀림), 거는 동안 새 턴 시작·끼워 넣기·명령 실행·모니터 발사·스킬 리뷰를 하지 않습니다. 그동안 들어온 메시지는 👀만 달리고 `pending`으로 기록되며, 재시작한 데몬이 시작하자마자 처리합니다. 슬래시 명령(`/status-ompbot` 제외)도 같은 길로 기록되고, 나에게만 보이는 응답 `재시작 준비 중이라 재시작 뒤에 처리합니다. 다시 보내지 않아도 됩니다.`가 바로 옵니다.
- 진행 중 턴·실행 중 호스트 도구(승인 대기·업로드·dispatch)·대기 중 승인이 모두 0이 되면 `drain --wait`가 0으로 끝나고, 시간 초과(기본 60분)면 drain을 풀고 1로 끝나므로 위 명령은 재시작하지 않습니다. `drain --cancel`로 중간에 풀면 그동안 쌓인 pending 메시지를 바로 처리합니다. drain 중에는 멈춘 대기 메시지 재시도 스윕도 쉬므로, 일부러 붙잡아 둔 메시지가 자가보고로 잘못 알려지지 않습니다. drain 중 `작업: …` 레인 요청은 시작하지 않고 '재시작이 끝난 뒤 같은 메시지를 다시 보내 주세요'로 답합니다. drain 중에는 `ompbot status`와 `/status-ompbot`에 `재시작 대기(drain) 중 · 진행 턴 N · 호스트 도구 N · 승인 대기 N`이 보입니다.
- **재시작 알림**: drain을 걸면 진행 중이거나 최근 30분 안에 오너 메시지가 있었던 대화(최대 10곳)의 마지막 스레드에 `🔄 ompbot을 곧 재시작합니다…`를 올리고, 그 스레드 목록을 `~/.ompbot/restart-notice.json`에 남깁니다. 재시작한 데몬은 기동하자마자 같은 스레드에 `✅ … 다시 연결됐습니다`를 올리고 파일을 지웁니다. drain이 취소되거나 시간 초과로 풀리면 `↩️ … 재시작이 취소됐습니다`를 올립니다. 3시간 넘게 지난 파일은 알림 없이 버리고(`restart_notice_dropped`), drain 없이 재시작하면 알림이 없습니다. 알림은 장부에 남지 않는 최선 노력 게시입니다. config `restartNotice: false`로 끕니다.
- SIGTERM을 받으면 진행 중인 턴이 끝나기를 최대 20초 기다린 뒤 omp 자식을 내립니다. 그 사이 끝난 턴의 답은 기록되어 다음 기동에서 전달됩니다.
- 재시작 중 끊긴 턴(drain 없이 재시작했거나 프로세스가 죽은 경우)은 세션 기록으로 답을 복구하고, 복구할 수 없으면 "다시 보내 주세요" 알림을 한 번 보냅니다. 같은 요청을 자동으로 다시 실행하지는 않습니다. 전달 중이던 답은 재전송 머리말을 붙여 다시 보냅니다.

### 재시작 없이 설정 반영

`bun src/main.ts reload`나 `kill -HUP <데몬 pid>`를 보내면 실행 중인 데몬이 `config.json`을 다시 읽습니다. 결과는 `config_reloaded changed=… restart_required=… cli=…` 한 줄로 CLI 출력과 로그에 남습니다.

- **바로 반영(`changed`)**: `mentionFreeChannels`, `logChannel`, `escalationChannel`, `skillReviewTurns`, `dispatchHosts`, `workerOmpArgs`, `herdrBoard`, `taskAutoLand`, `lanes`, `restartNotice`, `recallEnabled`, `peerBots`, `requireMention`, `peerHopLimit`, `turnSnapshot`, `costCap`, `briefing`. 다음 메시지·승인 카드·답·스윕부터 새 값을 씁니다. `dispatchHosts`·`workerOmpArgs`·`herdrBoard`는 이미 떠 있는 omp 자식의 도구에는 들어가지 않고 다음에 뜨는 자식부터 적용됩니다(스윕 알림의 보드 링크는 바로 반영).
- **재시작 필요(`restart_required`)**: `channels`, `slack`, `ompExecutable`, `ompProfile`, `workspaceDir`, `timezone`, `model`, `thinking`, `idleTimeoutMinutes`, `watcherRoots`, `webhook`, `agent`, `claudeExecutable`, `agyExecutable`, `herdr`(도구 스키마와 `[TASK]` 스윕을 시작 때 정함), `offsite`(데몬은 `offsite_age` 게이트를 둘지 판단하는 데만 읽고, 복제는 CLI가 실행할 때마다 config를 다시 읽습니다). 바뀐 것을 알려 주기만 하고 적용하지 않습니다.
- **CLI 전용(`cli`)**: `sessionRetentionDays`, `maxBundleBytes`는 `gc`·`backup`이 실행할 때마다 직접 읽으므로 데몬과 무관합니다. `dashboard`는 현황판 서비스가 시작할 때 읽으므로 `systemctl --user restart ompbot-dashboard`로 반영합니다.
- 파일이 없거나 JSON·검증 오류가 있으면 아무것도 바꾸지 않고 `config_reload_failed`를 남기며, `reload`는 1로 끝납니다.

### 놓친 메시지 백필

봇이 꺼져 있거나 소켓이 끊어진 동안 오너가 보낸 메시지는 소켓 모드 특성상 이벤트로 오지 않습니다. 데몬은 시작 때와 소켓이 (재)연결될 때마다 `conversations.history`로 오너 DM과 참여 채널의 놓친 메시지를 받아 옵니다(`conversations.replies`로 봇이 답한 스레드의 답글도). 채널은 그 채널의 대화방이 하나라도 있거나(채널 본문 대화방이든 루트 대화방이든) 전에 읽은 워터마크가 남아 있으면 채널마다 한 번 읽습니다. 그래서 `ompbot gc`가 오래 조용한 루트 대화방을 지워도 그 채널은 계속 백필되고, 봇이 나간 채널은 읽기 실패 3번 뒤 격리됩니다. 놓친 루트도 새 루트처럼 자기 대화방에서 처리되고 자기 스레드에 답합니다.

- 채널·스레드마다 워터마크(`slack_cursors` 테이블)를 두고, 처음 패스는 최대 24시간까지만 거슬러 올라갑니다. 페이지당 200건, 패스당 최대 10페이지.
- 워터마크는 "끝까지 처리한 지점"만 넘습니다. 페이지 한도에 걸리면 이어가기 표식(`cont:` 커서)만 남겨 다음 패스에서 그 아래를 이어 봅니다. 살아있는 트래픽은 워터마크를 올리지 않습니다.
- 중복은 `inbound`의 `<채널>:<ts>` UNIQUE가 최종 방어선이라 백필과 실시간이 겹쳐도 한 번만 처리됩니다. 새로 기록된 메시지가 있으면 그 방에 `⏬ 봇이 응답하지 못한 동안 도착한 메시지 N건을 처리합니다` 알림을 한 번 올립니다.
- 메시지별로 일시적이지 않은 오류가 나면 어떤 오류든 3번 패스 뒤 dead-letter로 넘깁니다(로그 `backfill_dead_letter`; ledger의 busy·locked·full·io 오류는 예외로 예산을 소모하지 않습니다). 읽을 수 없는 채널(`missing_scope` 등)은 3번 연속 실패하면 데몬을 다시 시작할 때까지 건너뜁니다. 일시적 오류는 예산을 소모하지 않습니다.
- 지금보다 5분 넘게 미래인 Slack ts는 워터마크를 옮기지 않습니다.
- 백필 메시지는 살아있는 메시지와 같은 경로(steer/큐)로 들어가므로 같은 대화방의 여러 건은 한 턴에 모입니다. 채널의 서로 다른 루트는 모이지 않고 각자 처리됩니다. 평시 한 줄 로그: `slack_backfill targets=N scanned=M recovered=K`.

### 건강 게이트와 자가 보고

`ompbot gates`는 다음을 읽기 전용으로 판정합니다. 게이트마다 상태는 셋 중 하나입니다.

- **열림**(`open`): 아래 표의 조건에 걸림. 하나라도 있으면 exit 1입니다.
- **닫힘**(`closed`): 판정했고 문제없음.
- **판정불가**(`unknown`): 판정할 근거가 없음 — 하트비트 스탬프(`~/.ompbot/sweep-heartbeat`)가 없으면 `sweep_stalled`·`slack_disconnected`(detail `stamp=missing`), `ompbot.db`가 없으면 원장 게이트 7개(`inbound_starved`·`origin_silent`·`deliveries_overdue`·`lanes_stuck`·`monitors_failed`·`monitors_stalled`·`turns_failing`, detail `db=missing`). 데몬이 한 번도 돌지 않은 새 설치가 이 상태입니다. 기본은 exit 코드에 영향이 없고, `--strict`를 주면 판정불가가 하나라도 있을 때도 exit 1입니다.

자동화가 아픈 봇을 "건강"으로 오판하지 못하게 하는 계약은 판정할 수 있는 게이트에만 걸립니다. 데몬이 실제로 떠 있는지까지 확인하려면 `--strict`를 씁니다. 마지막 줄은 `gates_done open=N unknown=M total=T`이고 열린 게이트가 있으면 ` opened=이름(detail),…`, 판정불가가 있으면 ` unknown_gates=이름,…`이 붙습니다. `--json`은 `{ open, unknown, gates }`입니다. 하트비트는 있는데 `socket` 필드가 없는 옛 데몬의 `slack_disconnected`는 지금처럼 닫힘(`socket=unknown`)이고, `herdr_unreachable`의 오래된 스탬프(`stamp=stale`)도 닫힘, 백업 도장이 없으면 `backup_age`는 열림, DB가 손상되면 `ledger_unreadable`이 열림입니다.

| 게이트 | 열리는 조건 |
| --- | --- |
| `backup_age` | 백업 성공 도장이 없거나 36시간 넘음. 데몬은 기동할 때 도장이 없으면 첫 게이트 점검 전에 `ompbot backup`과 같은 로컬 백업을 한 번 만듭니다(`boot_backup_done`, 오프사이트 복제는 하지 않음). 그 백업이 실패하면(`boot_backup_failed`) 게이트가 열리고, 그 알림(`stamp=missing`)에는 `ompbot backup`을 한 번 돌리고 백업 타이머를 켜라는 안내 줄이 붙습니다 |
| `offsite_age` | config에 `offsite`가 있을 때만 존재. `backups/offsite.ok`가 없거나 36시간 넘음(오프사이트 복제가 멈춤). 도장 나이만 보므로 원격에 이미 있는 옛 백업을 다시 확인(`present`)해도 갱신됩니다 — 올라간 데이터의 나이는 `backup_age`가 봅니다 |
| `sweep_stalled` | 스윕 하트비트가 3회 스윕(기본 45초) 넘게 갱신 안 됨 — 이벤트 루프가 막혔거나 스윕 체인이 죽음 |
| `inbound_starved` | omp 이벤트 없이 10분 넘은 dispatched 턴(오래 걸려도 이벤트가 이어지면 닫힘, 만료 전 승인 카드(`expires_at`이 지나지 않은 pending)를 기다리는 대화면 제외) |
| `origin_silent` | omp에 넘어가지 못한 채 `pending`으로 15분 넘은 오너 메시지. 이벤트가 이어지는 턴 뒤에 줄 선 메시지·만료 전 승인 카드를 기다리는 대화·drain 중에는 닫힘. 열리면 다른 게이트처럼 `🚨 [자가진단]` DM이 갑니다 |
| `deliveries_overdue` | 다음 전송 시각이 10분 넘게 지난 pending·inflight 배달(멈춘 `failed_ambiguous`는 제외). 답 하나를 보내다 예외가 나면 그 답은 '보냈는지 모름'(`failed_ambiguous`)으로 기록하고 같은 묶음의 다음 답은 계속 보냅니다 |
| `lanes_stuck` | 마지막 레인 활동(생성·진행 보고·오너 답글·완료 주장·재개 등 history 항목)이 24시간 넘은 working 레인 중 실행 중인 턴(그 24시간 안에 dispatched된 레인 대화 메시지 — 그보다 먼저 시작해 이벤트만 내는 턴은 치지 않음)도 만료 전 승인 카드(`expires_at`이 지나지 않은 pending)도 없는 고아 레인. 15분마다 상태 메시지를 다시 그리는 것은 활동으로 치지 않습니다. detail은 `working_old=<고아> running=<실행 중> approval_wait=<승인 대기>`이고 실행 중·승인 대기는 게이트를 열지 않습니다 |
| `slack_disconnected` | Slack 소켓이 10분 넘게 끊겨 있음(더 짧은 끊김은 스스로 다시 연결됩니다. 연결 직후 `disconnect`를 되풀이하면 첫 번째만 바로 다시 붙고, 두 번째부터는 백오프(1초부터 최대 30초) 뒤에 붙습니다. `apps.connections.open`이 ws:/wss:가 아닌 주소를 주면 치명 종료하지 않고 `apps.connections.open returned a bad url` 오류를 남긴 뒤 백오프 재시도합니다) |
| `frozen` | `~/.ompbot/FROZEN`이 있음(`ompbot freeze` 상태). detail은 `since=… reason=…` |
| `herdr_unreachable` | herdr 켜짐 데몬이 5분마다 로컬 `herdr status server`를 확인해 `~/.ompbot/herdr-health`에 남긴 연속 실패가 3회 이상(detail `fails=N since=…`). 스탬프가 없으면(herdr 꺼짐·옛 데몬) 게이트가 없고, 15분 넘은 스탬프는 `stamp=stale`로 닫힘(데몬 정지는 `sweep_stalled`가 봄). 원격 호스트는 대상이 아닙니다 |
| `omp_runtime` | `ompExecutable`이 단독 실행 파일이거나 없음, 또는 PATH의 bun이 omp `engines.bun`을 만족하지 못함 — 새 omp 세션이 뜨지 않는 상태. `agent: omp`이고 `config.json`이 있을 때만 판정 |
| `disk_low` | 봇 홈(`~/.ompbot`)이나 `~/.omp/agent`·`ompProfile`의 `~/.omp/profiles/<이름>/agent`(있을 때) 디스크의 여유가 5GiB 미만이거나 10% 미만(먼저 걸리는 쪽). detail은 가장 부족한 경로의 `path=… free_gib=… pct=…`, 둘 다 읽지 못하면 닫힘 `statfs=unavailable` |
| `host_pressure` | 15분 평균 부하가 CPU 수의 2배 이상이거나 `/proc/meminfo`의 MemAvailable이 MemTotal의 5% 미만. detail은 `load15=… cpus=… mem_avail_pct=…`(meminfo를 못 읽으면 `unknown`, 메모리 조건은 판정하지 않음). 알림만 하고 작업 시작을 미루지 않습니다 |
| `monitors_stalled` | 켜진 모니터의 다음 발사 시각이 15분 넘게 지났음 — 모니터 틱이 발사하지 못하는 상태. drain 중이거나, 동결 중이거나(detail `frozen`, 동결은 `frozen` 게이트가 알림), 하트비트가 구버전 데몬의 것이면 닫힘. 동결 동안 밀린 발사는 해제 시각(`~/.ompbot/unfrozen-at`)에 예정된 것으로 쳐서, 해제 뒤 15분 안에 발사되면 열리지 않음 |
| `monitors_failed` | 최근 24시간 켜진 모니터의 `failed_no_retry` |
| `turns_failing` | 최근 1시간 `[turn failed]` 알림 3건 이상 |
| `cost_cap` | `costCap.dailyUsd`가 있을 때만 존재. 오늘(봇 시간대) `usage_daily` 합계가 그 상한 이상이고 `!budget off`로 끄지 않았음 — 모니터 발화가 멈춘 상태. detail은 `today=… cap=…`(끈 날은 `off=today`) |
| `ledger_unreadable` | `ompbot.db`를 읽을 수 없음(테이블 없음·손상). 이때는 DB 게이트 대신 이 게이트 하나가 열립니다 |

- 데몬은 매 스윕(기본 15초)마다 `~/.ompbot/sweep-heartbeat`을 원자적으로 갱신하고, `monitorEventLoopDelay`로 잰 최대 루프 지연을 함께 기록합니다(5초 초과 시 `event_loop_blocked` 경고). 스윕의 한 단계가 예외를 던지면 데몬은 죽지 않고 `sweep_failed`(error)를 남긴 채 그 스윕을 끝내며 하트비트를 갱신하지 않습니다. 실패가 이어지면 스탬프가 늙어 `sweep_stalled`가 열리고, 이것은 데몬 밖의 `ompbot gates`(ops-check 등)가 잡습니다.
- **watchdog**: 메인 스레드가 2분 넘게 멈추면(동기 호출·무한 루프) 별도 워커 스레드가 `watchdog_kill`(JSON 한 줄, `stalled_ms`·`pid`)을 journal과 `ompbot.log`에 남기고 프로세스를 SIGKILL합니다. systemd(`Restart=on-failure`)가 5초 뒤 다시 띄우고, 락은 죽은 pid라 교체되며 진행 중이던 턴은 재시작 복구가 처리합니다. `sweep_stalled`(45초)는 알림, watchdog은 그보다 훨씬 긴 정지에서만 죽입니다.
- **종료 원인 기록**: 처리되지 않은 예외·거부(unhandled rejection)는 `ompbot.log`에 `daemon_fatal kind=uncaughtException|unhandledRejection error=… stack=…` 한 줄을 남기고 exit 1로 끝나며, SIGKILL(watchdog 포함)이 아닌 종료는 마지막에 `daemon_exit code=N`을 남깁니다.
- **게이트 알림**: 데몬이 5분마다 스스로 게이트를 산정해 닫힘→열림 전이를 오너 DM으로 알립니다(`🚨 [자가진단]`). 판정불가(`unknown`)는 이전 상태를 그대로 둡니다 — 알림·회복 알림을 보내지 않고 인시던트를 기록하거나 해소하지도 않으며, 다음에 열림·닫힘으로 판정될 때 그 전이를 이어서 처리합니다. 같은 게이트는 24시간 안에는 조용하고, 계속 열려 있으면 하루마다 다시 알립니다. 알림이 나갔던 게이트가 닫히면 `✅` 회복 알림을 보내며, `slack_disconnected`와 `monitors_stalled`도 마찬가지입니다. 시간 창이 지나 닫히는 `turns_failing`·`monitors_failed`는 회복 알림이 없습니다. `/status-ompbot`·`ompbot status` 마지막 줄에 열린 게이트 요약이 나옵니다.
- **연속 실패**: 한 대화에서 턴이 3번 연속 실패하면 오너 DM으로 `🚨 [자가보고] … N번 연속 실패`를 한 번 보냅니다(같은 사인 24시간 억제, 성공 1턴으로 해소). 실패 사인이 모델 소멸이면 살아 있는 omp 자식의 모델을 바로 고칩니다.
- **세션 복원 모델 실패 자동 치유**: 세션 파일에 남은 활성 모델이 브로커에서 사라져 세션 복원이 `Could not restore model`로 실패하면(2026-10-27 사고), 대화의 모델 설정(모니터 핀 → 오리진 → 스레드 상속 → `defaultModel`)으로 세션 파일에서 omp가 복원에 쓰는 `model_change`(마지막 레코드, 단 마지막 레코드가 재시도 폴백이 남긴 `role: "fallback"`이면 role이 없거나 `default`인 마지막 레코드)를 교정하고 같은 메시지로 턴을 1회 다시 시작합니다. 교정 직전 원본은 `~/.ompbot/session-backups/<대화>/<UTC 타임스탬프>.jsonl`에 남고, 폴백이 없거나 이미 폴백 모델이면 파일을 건드리지 않고 기존 실패 경로가 돕니다.
- **세션 이어받기 검증**: omp 자식이 세션을 열 때 이어받을 파일(`/resume-ompbot` 핀, 없으면 시작 전 에포크 디렉터리의 최신 `*.jsonl`)과 자식이 보고한 실제 파일이 다르면 `session_resume_mismatch`(warn, `expected`·`actual`)를 남기고 그 스레드에 `⚠️ 이전 세션을 잇지 못하고…`(파일 이름만)를 대화·에포크당 한 번 올립니다(재시작 복구 경로는 로그만). 턴은 막지 않고, 둘 중 하나를 모르면(빈 디렉터리, 파일을 보고하지 않는 claude) 판정하지 않습니다.
- **멈춘 대기 메시지**: 디스패치에 실패해 `pending`에 남은 메시지는 그 대화가 쉬고 있으면 스윕이 1분마다 다시 디스패치합니다. 3번 연속 그대로면 오너 DM으로 `🚨 [자가보고] <대화>의 메시지를 N분째 보내지 못하고 있습니다`를 한 번 보내고(24시간 억제), 메시지가 빠지면 인시던트를 해소합니다.
- **멈춤 알림**: 진행 중인 턴에서 omp 이벤트가 2분 넘게 없으면 첫 번째만 `stall_alert`(warn)를 남기고 상태 메시지에 표시합니다. 호스트 도구(승인 대기 등)가 도는 동안은 판정하지 않고, 도구가 끝난 시각부터 다시 잽니다. 실측(2026-10-30 DM 턴, 침묵 → 10분 도구 타임아웃 때 이벤트 1건 → 3분 뒤 다시 침묵을 5번)처럼 같은 턴이 되풀이해 멈추면 합칩니다.
  - 같은 턴의 두 번째부터는 `stall_repeat`(info, `count`·`totalSilentMs`)만 남기고, 상태 표시는 깜빡이지 않고 첫 멈춤 표시를 유지합니다. 표시는 마지막 멈춤이 끝난 뒤 5분(`STALL_RELEASE_MS`, 되풀이 사이 간격 3분보다 길다) 동안 다시 멈추지 않을 때 `stall_released`와 함께 풀립니다.
  - **대화 오리진(DM·채널·스레드)**: 한 턴의 멈춤이 3회(`STALL_NOTIFY_COUNT`)이거나 누적 침묵이 30분(`STALL_NOTIFY_MS`)이면 `stall_escalated` 로그와 함께 오너 DM `⚠️ [자가보고] … 응답 없이 N분째`를 턴당 한 번 보냅니다. 턴을 자동으로 끊지 않습니다. 끊으려면 `/new-ompbot`을 보냅니다.
  - **모니터 오리진(`monitor/…`)**: 무인 실행이라 누적 침묵이 20분(`MONITOR_STALL_ABORT_MS`)이면 omp 턴을 abort하고 그 모니터 이벤트를 `failed`(재시도·최종 알림은 기존 규칙)로 남기며 오너 DM `🚨 [자가보고] … 중단했습니다`를 한 번 보냅니다. 자식은 멈춘 상태였으므로 함께 종료하고 다음 발사가 새 세션으로 시작합니다.
  - 임계값은 `MailboxDeps`(`stallReleaseMs`·`stallNotifyCount`·`stallNotifyMs`·`monitorStallAbortMs`)로 주입할 수 있습니다. 데몬 재시작 뒤에는 카운터가 0부터이므로 같은 턴 알림이 한 번 더 갈 수 있습니다.
- **모델 공급자 한도**: 모델 공급자 한도(429·rate limit·usage limit)가 omp 재시도 이벤트(`auto_retry_start`, `auto_retry_end`)로 감지되면 오너 DM으로 `⚠️ 모델 공급자 한도 소진(<origin>): <오류 요약> — omp가 재시도·폴백 중…`를 24시간에 1회 보냅니다(모니터 턴 포함). 폴백 적용은 로그 `retry_fallback_applied`로 남습니다.

### 프롬프트 캐시 감시와 TASK 파일 겹침 알림

- **캐시 미스**: omp 호출(assistant `message_end`의 `usage`)마다 직전 호출의 접두(`cacheRead + cacheWrite`)를 이번 호출이 얼마나 다시 읽었는지 봅니다. 직전 접두와 못 읽은 양이 모두 2만 토큰 이상이면 로그 `cache_miss`(`reason`·`missed`·`cacheWrite`·`costCacheWrite`·`gapSec`·`model`)를 남깁니다. 원인은 `model_switch`(공급자·모델 변경) → `compaction`(자동 압축·`/compact-ompbot`) → `expired`(anthropic 1시간 초과) → `child_restart`(omp 자식이 새로 뜸) → `unexplained` 순으로 정합니다. 데몬이 재시작해도 세션의 마지막 assistant 기록으로 기준을 다시 잡으므로 재시작 뒤 첫 호출도 판정합니다.
- 대화 턴에서 `child_restart`·`unexplained` 미스가 15만 토큰 이상이면 그 턴 스레드에 `⚠️ 프롬프트 캐시 재작성 312k 토큰(≈$2.51) — 원인 child_restart`를 대화방마다 24시간에 1회 올립니다.
- **식은 캐시**: 20만 토큰 이상인 대화가 마지막 호출 뒤 캐시 보존 시간(anthropic 1시간)을 넘겨 새 턴을 시작하면 그 턴 스레드에 `ℹ️ 캐시가 식은 대화입니다(컨텍스트 312k, 마지막 호출 3시간 전). 이번 턴에 약 $2.50 재작성 — 새로 시작하려면 /new-ompbot`을 한 번 올립니다(같은 기준에서는 다시 내지 않음, 단가를 모르면 금액은 뺌).
- **TASK 파일 겹침**: TASK 스윕(5분)마다 같은 저장소(경로 또는 git common dir)의 로컬 활성 TASK 둘이 `docs/tasks/**` 밖의 같은 파일을 고치고 있으면(베이스 `origin/HEAD`→`main`→`master`와의 merge-base 이후 diff + 미커밋·추적 안 된 파일) 두 TASK 스레드에 `⚠️ 파일 겹침: T-A와 T-B가 <경로>를 함께 고칩니다. 먼저 끝나는 쪽을 랜딩한 뒤 다른 쪽을 rebase하세요.`를 겹친 경로 묶음마다 한 번 올리고, 두 워커에 범위를 최소로 하라는 프롬프트를 한 번 보냅니다. 워커가 일하는 중·대기 중이거나 동결 중이거나 같은 스윕에 다른 프롬프트를 받았거나 전송이 실패하면 기록하지 않고 다음 스윕에 다시 봅니다(`task_overlap_remind_deferred`). 원격 TASK는 판정하지 않고, 경로를 읽지 못한 TASK는 그 스윕에서 빠집니다(`task_overlap_skipped`).
- 캐시 두 알림은 모니터 오리진에는 내지 않고(캐시 미스는 로그만 남김), 세 알림 모두 끄는 설정은 따로 없습니다. "24시간 1회"·"같은 기준 1회" 상태는 메모리에만 있어 데몬 재시작 직후 한 번 더 나갈 수 있습니다.

### 백업

`ompbot backup`은 라이브 DB를 `VACUUM INTO`로 단일 파일 사본(`~/.ompbot/backups/ompbot-YYYYMMDD-HHMMSS.db`)으로 만들고 `quick_check`가 `ok`일 때만 정식 이름으로 옮깁니다. 데몬이 꺼져 있어도 동작합니다.

- 검증을 통과하면 세션 원본·설정·페르소나·수집기 스크립트를 묶은 번들(`ompbot-bundle-같은타임스탬프.tar.gz`, `sessions/`+`config.json`+`workspace/`+`scripts/` 중 존재하는 것, 기본 512MB 상한)도 함께 남깁니다. 번들 만들기나 검증이 실패하면 백업 전체가 실패합니다. `~/.ompbot/secrets/`는 번들에 절대 들어가지 않습니다. 번들 소스 안의 파일이 `secrets/` 파일의 하드링크(같은 inode)이면 `bundle_failed: <경로> is a hard link to a secrets/ file`로 백업 전체가 실패합니다. `sessions`·`workspace`·`scripts`·`config.json`이 심링크여도 링크가 가리키는 실제 내용을 원래 이름(`sessions/…`)으로 담습니다. 따라가는 링크는 이 최상위 링크 하나뿐이고 그 안의 링크는 링크 그대로 담습니다. 링크가 `secrets/` 안(또는 `secrets/`를 품은 곳)을 가리키거나, 디렉터리여야 할 소스가 파일을 가리키거나, 깨졌거나 순환하면 백업 전체가 `bundle_failed`로 실패하고 성공 도장을 쓰지 않습니다. 링크 대상이 홈 밖 다른 디스크인 것은 정상입니다. `workspaceDir`을 홈 밖으로 바꾼 설치는 그 폴더가 번들에 들어가지 않습니다.
- 번들 복구(db는 기존 `ompbot restore`): `systemctl --user stop ompbot && tar -xzf ~/.ompbot/backups/ompbot-bundle-<타임스탬프>.tar.gz -C ~/.ompbot workspace scripts && systemctl --user start ompbot` 이 변경 전에 만든 번들에는 `workspace`·`scripts`가 없어 tar가 `Not found in archive`로 실패합니다(그때는 더 최근 번들을 쓰세요).
- 성공 도장(`backups/last-backup.ok`)은 성공의 맨 끝에만 갱신되고 `bundle=`·`bundle_sha256=`까지 기록합니다.
- 보존은 타임스탬프 이름 일일 파일(.db와 번들 같은 정책, 최신 `--keep`(기본 14)개)이고, `ompbot-pre-upgrade-*.db` 같은 수동 사본은 대상 밖입니다.
- 매일 자동 실행은 [`packaging/ompbot-backup.service`](../packaging/ompbot-backup.service)·[.timer](../packaging/ompbot-backup.timer)(매일 04:30, `Persistent=true`)입니다. [서비스 등록](#7-서비스-등록)의 `units render`가 이미 써 두었으므로 타이머만 켭니다:

  ```sh
  bun src/main.ts units render   # 아직 안 했으면
  systemctl --user daemon-reload
  systemctl --user enable --now ompbot-backup.timer
  ```

- **오프사이트 복제**: config에 `offsite`가 있으면 `ompbot backup`이 로컬 백업이 성공한 뒤 가장 최근 스냅샷·번들을 `ssh -o BatchMode=yes`(키 인증만)로 `remoteDir`(0700)에 올립니다. 순서는 `<이름>.part`로 `scp -B -p` → 원격 `sha256sum`이 로컬 도장의 sha와 같을 때만 정식 이름으로 `mv` → 원격 보존 정리(엄격한 일일 이름 패턴만, 종류별 최신 `keep`개; `.part`·수동 사본·낯선 파일은 건드리지 않음) → 로컬 `backups/offsite.ok`(`ts= file= sha256= bundle= bundle_sha256= ssh= dir=`)를 맨 끝에 원자적으로 기록합니다. sha가 다르면 `.part`를 지우고 이름을 바꾸지 않으며 도장도 갱신하지 않습니다. 원격에 이미 같은 내용이 있으면 다시 올리지 않습니다.
  - 오프사이트가 실패해도 로컬 백업과 `last-backup.ok`는 그대로이고, `offsite failed: <코드>: <사유>`를 stderr에 쓰고 종료 코드 4로 끝납니다(로컬 백업 실패는 1). 코드: `ssh_failed`, `copy_failed`, `sha_mismatch`, `no_local_backup`, `stamp_failed`.
  - 단독 재시도: `bun src/main.ts offsite [--json]`(config에 `offsite`가 없으면 2). 성공 줄은 `offsite uploaded|present file=… sha256=…`과 `offsite_done files=… removed=… stamp=…`입니다.
  - `offsite.ok`가 36시간 넘으면 `offsite_age` 게이트가 열립니다([건강 게이트](#건강-게이트와-자가-보고)). 받는 쪽 호스트에 `sha256sum`·`mkdir`·`mv`·`ls`·`rm`이 있어야 하고 ssh 키가 미리 등록돼 있어야 합니다(`ssh -o BatchMode=yes <ssh> true`로 확인).
- 보존 기간이 지난 세션을 매일 정리하는 `ompbot gc`도 같은 방식으로 등록합니다([`packaging/ompbot-gc.service`](../packaging/ompbot-gc.service)·[.timer](../packaging/ompbot-gc.timer), 매일 04:45, 백업이 끝난 뒤 실행). 경로는 `units render`가 채웁니다:

  ```sh
  bun src/main.ts units render   # 아직 안 했으면
  systemctl --user daemon-reload
  systemctl --user enable --now ompbot-gc.timer
  ```

- **복구** — `ompbot restore <백업 db 경로> [--yes]`. 데몬을 먼저 멈춥니다(`systemctl --user stop ompbot`). 소켓에 응답하는 데몬이 있거나 `ompbot.lock`을 쥔 프로세스가 있으면 거부합니다(종료 코드 1). 원본 옆에 `-wal`이 있거나(심링크면 실제 경로 옆도 봅니다), 원본이 하드링크(링크 수 2 이상)이면 거부합니다(종료 코드 2). 원본은 `~/.ompbot/backups/` 안의 `ompbot-YYYYMMDD-HHMMSS.db`(이름만 줘도 됨)이거나 절대경로 파일입니다(그 밖은 종료 코드 2). 순서: 임시 사본 → `PRAGMA quick_check`=`ok` → `origins`·`inbound`·`deliveries` 테이블 확인(없으면 빈 파일·다른 sqlite로 보고 `integrity_check_failed`) → 현재 `ompbot.db`와 `-wal`/`-shm`을 `backups/pre-restore-<stamp>/`(같은 초에 이미 있으면 `-2`, `-3`…)로 이동 → rename으로 교체 → fsync. 교체 중 실패하면 이동한 파일을 원위치로 돌려놓습니다. `--yes`가 없으면 무엇을 할지만 출력하고 종료 코드 3으로 끝납니다. 세션·설정 번들은 자동으로 풀지 않으므로, 같은 타임스탬프의 번들이 있으면 `tar -xzf ~/.ompbot/backups/ompbot-bundle-YYYYMMDD-HHMMSS.tar.gz -C ~/.ompbot sessions config.json`(원본을 덮어씁니다)으로 복구한 뒤 데몬을 다시 시작하세요. 백업이 최신 스키마라면 구버전 바이너리로는 열지 못합니다.

### 스킬 리뷰

데몬이 뜬 뒤 스윕이 오너 DM을 처음 볼 때의 답한 턴 수를 기준선으로 삼고, 그 뒤 답한 턴이 `skillReviewTurns`(기본 10, 0이면 끔)만큼 쌓일 때마다 별도 omp 자식이 최근 대화 24개를 읽고 재사용할 만한 스킬을 제안합니다(재시작하면 기준선을 다시 잡습니다). 동결 중에 차례가 오면 리뷰를 돌리지 않고 `skill_review_skipped_frozen`만 남기며, 그 차례는 미뤄지지 않고 다음 `skillReviewTurns`턴 뒤에 다시 판단합니다.

- 주기를 기다리지 않고 `!distill`로 지금 대화의 세션 내용을 바로 리뷰할 수 있습니다. 같은 함수·같은 승인 카드·같은 `skills-pending` 저장을 쓰고, 10턴 주기 기준선은 건드리지 않습니다. 리뷰 하나가 돌고 있으면 새로 시작하지 않고, 동결 중에는 하지 않습니다(`skill_review_skipped_frozen`, `trigger=distill`). 승인 카드는 `!distill`을 친 대화방에 오고, 제안이 없어도 "제안할 만한 절차가 없었어요" 안내가 같은 방에 옵니다(10턴 주기 리뷰는 조용히 끝냅니다).
- 제안은 `~/.ompbot/skills-pending/`에 0600으로 저장되고, 승인 버튼을 눌러야만 `~/.omp/agent/managed-skills/<이름>/SKILL.md`로 설치됩니다(거부·무응답이면 설치 안 함). omp가 `learn`·`manage_skill`로 만드는 스킬과 같은 폴더라 판 보관·주간 보고·90일 미사용 보관(omp-skill-curator)이 함께 적용됩니다.
- 채택 게이트: 모든 제안은 `evidence`(이 대화에서 그 절차가 실제로 통했는지의 근거)와 `checks`(발동해야 할 상황·발동하면 안 되는 상황 짝 2~4개)를 갖춰야 하고, 없는 제안은 승인 카드까지 못 갑니다(폐기). 승인 카드에 근거와 검증 짝 수가 같이 보이고, 설치되는 SKILL.md에는 `## 채택 검증` 절로 짝과 롤백 안내·다른 모델 경로(GLM 크론 모니터 등) 이식 전 재검증 규칙이 기록됩니다.
- 덮어쓰기 설치는 먼저 직전 내용을 `<스킬>/revisions/<타임스탬프>.md`로 보존하고, `ompbot skills rollback <이름>` 한 번으로 되돌립니다(현재 내용은 개정 슬롯에 남아 다시 되돌릴 수도 있습니다).
- 리뷰 1회는 모델 토큰을 소모합니다.

## 보안 메모

- 오너가 아닌 사용자의 메시지, 슬래시 명령, 버튼 클릭, 파일은 모두 무시하거나 "권한 없음"으로 답합니다.
- 마스킹은 두 겹입니다. (1) 토큰 모양 형식 패턴(`xox?-`(`xoxb-`·`xoxp-`·`xoxc-`·`xoxd-` 등), `xapp-`, `sk-*`, `gh*_`, `github_pat_`)은 항상 적용됩니다. (2) 데몬 기동 때 실제 비밀 값(Slack 토큰 파일, 비밀 이름의 환경 변수, `OMPBOT_SECRET_GUARD_FILES`의 콜론 구분 파일 — JSON은 비밀 이름 필드만)을 메모리에 색인해, 값의 16자 조각과 역순·hex·base64 변형까지 `[REDACTED]`로 바꿉니다. 로그·DB 저장·슬랙 전송 경로 전부(나가는 메시지의 버튼 라벨·값 포함)에 적용되고 끄는 스위치는 없습니다. 색인은 기동 때만 다시 읽습니다.
- `slack_send_file`은 `~/.ompbot/secrets`, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.omp/agent`, `~/.gajaeway-hub`, `~/.git-credentials`, `~/.netrc`, `~/.config/gh`, `~/.config/gcloud`, `~/.npmrc`, `~/.kube`, `~/.docker` 아래 파일(링크는 실제 경로로 판정, 하드링크는 링크 수가 2 이상일 때 이 디렉터리들의 파일과 inode를 대조)과, 토큰 모양 내용·개인키(`-----BEGIN … PRIVATE KEY-----`)·알려진 비밀 값이 든 파일을 올리지 않습니다. 내용 검사는 크기와 관계없이 50MB 상한까지 파일 전체를 1MB 조각(경계 4096자 겹침)으로 읽어 합니다.
- omp 자식 프로세스와 `omp`·`claude`·`agy` `--version` 확인(데몬 시작·`doctor`·`status`·현황판)은 환경 변수에서 `SLACK_*`, `OMPBOT_*`를 지운 상태로 시작합니다. 시스템 프롬프트에는 위험 명령 금지 규칙과 `~/.ompbot/secrets` 읽기 금지가 붙습니다.
- 다만 omp는 ompbot과 같은 유닉스 사용자로 실행되므로, 토큰 파일 접근을 OS 권한으로 막지는 못합니다. 더 강하게 격리하려면 omp를 별도 사용자로 실행해야 합니다.
- omp 확장 `wiki-session-note`가 설치돼 있으면, 봇 세션에서는 `OMP_WIKI_NOTE_DISABLE=1`로 끕니다.

## 개발

```sh
bun test                                   # 단위 테스트
bun run check                              # biome + tsc
OMPBOT_E2E_OMP=1 bun test                  # 실제 omp를 띄우는 E2E 포함(모델 비용 발생)
bun run smoke-omp                          # omp 업그레이드 뒤 RPC 계약·채팅 명령 확인(모델 비용 발생)
```
