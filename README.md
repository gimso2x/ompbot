# ompbot

Slack DM이나 봇을 초대한 채널에서 [omp](https://github.com/can1357/oh-my-pi) 코딩 에이전트에게 일을 시키는 개인 봇입니다. 오너 한 명 전용입니다.

구조: Slack Socket Mode ↔ ompbot 데몬(SQLite 수신·전달 장부) ↔ 대화방마다 하나씩 띄우는 `omp --mode rpc` 자식 프로세스. omp 자체는 고치지 않습니다.

## 기능 한눈에

| 영역 | 기능 | 자세히 |
| --- | --- | --- |
| 대화 | DM·채널·채널 스레드별 독립 대화, 일하는 중 끼워 넣기(steer)·`!followup`, 한 턴의 여러 답을 한 번에 전달, 첨부 받기·파일 올리기, Slack용 표 렌더링, 진행 상태 메시지, 같은 대화 공간의 지난 대화 자동 회상, 전달·첨부 자료의 인젝션 경고 | [대화](#대화) |
| 채팅 명령 | 모델·thinking 전환, 컨텍스트 압축, 옛 세션 이어가기, 대기열 보기·취소, 새 대화, 스레드 뮤트, 토큰·비용 사용량 | [명령](#명령) |
| 승인 | 되돌릴 수 없는 작업 전 승인 버튼(구조화된 카드, 영속 장부, escalation 채널, 카드 스레드 답장) | [승인](#승인) |
| 페르소나·답변 형식 | `workspace/persona.md`를 채팅 세션 시스템 프롬프트에 추가, 답변 형식 규율 | [페르소나와 답변 형식](#페르소나와-답변-형식) |
| 완료 사본 | `✅ 완료`로 시작하는 답을 #log 채널에 사본으로 남김 | [설정](#5-설정-파일-ompbotconfigjson) `logChannel` |
| 작업 위임 | `ompbot_dispatch` — 단발(`omp -p`)·장기(herdr)·원격 호스트, `[TASK]` 상태 문서와 5분 스윕 | [작업 위임](#작업-위임) |
| 작업 레인 | `작업: <제목> @<경로>`로 레인 스레드, 커밋으로 검증되는 완료, 저장소당 레인 하나 | [작업 레인](#작업-레인) |
| 모니터 | cron·한 번·스크립트 조건 와치, 채널 게시·사본, 모델 고정, 턴 없이 그대로 전달(verbatim), 실패 재시도·인시던트 | [모니터](#모니터) |
| 신뢰성 | 재시작 뒤 대화 유지·답 복구, 놓친 메시지 백필, 멈춘 대기 메시지 재시도, 건강 게이트와 자가 보고, drain 재시작과 재시작 알림, 재시작 없는 설정 반영 | [운영](#운영) |
| 백업 | 매일 DB 사본 + 세션·설정 번들, 성공 도장, 보존 | [백업](#백업) |
| 학습 | N턴마다 스킬 제안 → 승인 설치 → 개정 롤백 | [스킬 리뷰](#스킬-리뷰) |
| 보안 | 오너 게이트, 두 겹 비밀 마스킹, 자식 환경 정리, 업로드 차단 목록 | [보안 메모](#보안-메모) |

## 요구 사항

- Linux, systemd user 세션(재부팅 후 자동 시작을 원하면 `loginctl enable-linger $USER`)
- [Bun](https://bun.sh) 1.4 이상
- omp가 설치돼 있고 로그인돼 있어야 합니다(`omp --version`, 모델 하나 이상 사용 가능). ompbot은 omp의 기존 `~/.omp/agent` 설정을 그대로 씁니다.
- (선택) 대화 에이전트를 Claude Code CLI로 쓰려면(`"agent": "claude"`) [Claude Code](https://docs.claude.com/en/docs/claude-code/overview)가 설치돼 있고 로그인돼 있어야 합니다(`claude --version`, `claude` 한 번 실행해 `/login` 완료 — 자격은 `~/.claude/` 아래에만 둡니다). omp는 여전히 설치돼 있어야 합니다(dispatch 등 일부 도구가 씁니다). 자세한 차이는 [claude 에이전트](#claude-에이전트) 참고
- Slack 워크스페이스 관리자 권한(앱 생성용)
- (선택) 장기 위임에는 herdr와 config `"herdr": {}`가, 원격 위임에는 대상 호스트로의 ssh(`BatchMode`)가 필요합니다. [herdr(선택)](#herdr선택) 참고.

## 코어와 설치본

이 저장소(코어)는 코드만 담습니다. 설치한 사람마다 다른 것은 모두 `OMPBOT_HOME`(기본 `~/.ompbot`) 아래의 설치본입니다 — `config.json`, `secrets/`(Slack 토큰), `workspace/persona.md`, 세션, `ompbot.db`(모니터 포함), 백업, 로그. 설치본은 git에 넣지 않습니다. systemd 유닛(`packaging/*.service`·`*.timer`)은 템플릿이고 `ompbot units render`가 자기 bun·체크아웃·홈 경로로 채웁니다. `examples/`는 그대로 쓰지 않고 자기 경로로 바꿔 쓰는 예시입니다.

## 설치

### 1. 소스 받기

```sh
git clone <저장소 URL> ~/work/ompbot
cd ~/work/ompbot
bun install
bun test          # 전부 통과해야 합니다(실제 omp E2E는 기본으로 건너뜀)
```

### 2. Slack 앱 만들기

1. https://api.slack.com/apps → **Create New App** → **From a manifest** → 워크스페이스를 고릅니다.
2. **JSON** 탭에 [`packaging/slack-manifest.json`](packaging/slack-manifest.json) 내용을 그대로 붙여넣고 **Create**를 누릅니다. 검토 화면에서 권한 14개, 이벤트 4개, 슬래시 명령 8개가 보여야 합니다. 이미 만든 앱에서 권한을 뺀 매니페스트는 앱을 워크스페이스에 다시 설치(reinstall)해야 실제 앱에 반영됩니다.
3. **Install App** → **Install to <워크스페이스>** → 허용을 누르면 `xoxb-` 봇 토큰이 나옵니다.
4. **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes**에서 범위 `connections:write`를 넣어 `xapp-` 토큰을 만듭니다.

같은 워크스페이스에 봇이 여러 개면, 슬래시 명령 이름이 겹치지 않도록 매니페스트의 `/…-ompbot` 명령 이름을 바꾸세요. 같은 이름이면 마지막에 설치한 앱의 명령만 동작합니다.

### 3. 홈과 설정 만들기 (`init`)

```sh
bun src/main.ts init --owner <Slack 멤버 ID> [--omp <omp 절대경로>] [--workspace <디렉터리>]
```

- `--owner`: 명령을 받아들일 유일한 사용자. Slack 프로필 → ⋮ → **멤버 ID 복사**(`U…`). 형식이 틀리면 아무것도 만들지 않고 종료 코드 2입니다.
- `--omp`를 비우면 PATH의 `omp`를 씁니다(못 찾으면 종료 코드 2). `--workspace`를 비우면 `<홈>/workspace`입니다.
- 홈(`OMPBOT_HOME`, 기본 `~/.ompbot`, 0700), `secrets/`(0700), workspace 디렉터리, 아래 5절의 최소 키만 든 `config.json`(0600)을 만듭니다. `config.json`이 이미 있으면 아무것도 바꾸지 않고 종료 코드 2로 끝납니다(덮어쓰기 옵션은 없습니다).
- 토큰은 묻지도 쓰지도 않습니다. 끝에 토큰 파일 두 개의 경로와 다음 단계를 출력합니다.

다른 홈을 쓰려면 모든 명령 앞에 `OMPBOT_HOME=<경로>`를 붙입니다.

### 4. 토큰 파일

토큰은 파일로만 둡니다. 채팅이나 셸 기록에 남기지 마세요.

```sh
umask 077
cat > ~/.ompbot/secrets/slack-bot-token   # xoxb-… 붙여넣고 Ctrl-D
cat > ~/.ompbot/secrets/slack-app-token   # xapp-… 붙여넣고 Ctrl-D
chmod 600 ~/.ompbot/secrets/*
```

### 5. 설정 파일 `~/.ompbot/config.json`

`init`이 만든 파일은 다음과 같습니다. 선택 키는 아래 표를 보고 직접 더합니다.

```json
{
  "schemaVersion": 1,
  "ownerSlackUserId": "U0123456789",
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
| `ownerSlackUserId` | 예 | 명령을 받아들일 유일한 사용자. Slack 프로필 → ⋮ → **멤버 ID 복사** |
| `slack.botTokenFile`, `slack.appTokenFile` | 예 | 토큰 파일 경로(홈 기준 상대경로 가능). 각각 `xoxb-`, `xapp-`로 시작해야 합니다 |
| `ompExecutable` | 예 | 절대경로(`command -v omp`) |
| `workspaceDir` | 예 | 일반 대화에서 omp가 작업하는 디렉터리 |
| `agent` | 아니요 | 대화를 구동할 자식 에이전트: `"omp"`(기본) 또는 `"claude"`. [claude 에이전트](#claude-에이전트) 참고 |
| `claudeExecutable` | 아니요 | `agent`가 `"claude"`일 때 쓸 claude CLI 절대경로. 비우면 자식 PATH에서 `claude`를 찾습니다 |
| `model`, `thinking` | 아니요 | 봇 세션에 쓸 모델·thinking 수준. 비우면 omp 기본값을 씁니다 (`agent`가 `"claude"`면 `model`은 `claude/<별칭>`에서 claude 별칭만 유효: `fable`·`opus`·`sonnet`·`haiku`) |
| `sessionRetentionDays` | 아니요 | `ompbot gc`가 이전 대화 세션과 오래 쉰 채널 스레드 세션을 지우기까지의 일수(기본 30) |
| `idleTimeoutMinutes` | 아니요 | 이 시간(분) 동안 쓰지 않은 omp 프로세스를 내립니다. 세션은 유지되고 다음 메시지에서 다시 띄웁니다(기본 30, `0`이면 끄기). 모니터 자식은 일이 끝나고 2분(이 값이 더 짧으면 이 값) 뒤 내리고, `0`이면 모니터도 내리지 않습니다 |
| `skillReviewTurns` | 아니요 | 오너 DM 답변 턴 몇 회마다 백그라운드 스킬 리뷰를 돌릴지(0이면 끔, 기본 10 — 리뷰 1회는 모델 토큰 소모) |
| `mentionFreeChannels` | 아니요 | 채널 ID 배열. 이 채널에서는 오너 메시지를 멘션 없이도 받아들입니다(혼자 쓰는 채널용). 예: `["C0123456789"]` |
| `escalationChannel` | 아니요 | 승인 카드를 올릴 채널 id(`C…`/`G…`). [승인](#승인) 참고 |
| `logChannel` | 아니요 | #log 장부 채널 id(`C…`/`G…`). 슬랙 대화나 작업 레인의 답 첫 줄이 `✅ 완료`(또는 `:white_check_mark: 완료`)로 시작하면 그 답의 사본이 `📒 완료 보고 사본 · <요청 위치 + 원 스레드 링크>` 머리말과 함께 이 채널 최상위에 한 번 올라갑니다(모니터 답·알림·승인 카드·명령 답은 제외). 이 채널의 메시지는 멘션이 있어도 턴이 되지 않습니다(`inbound_dropped reason=log_channel`) |
| `herdr` | 아니요 | herdr 켜기. `{}`이면 PATH의 `herdr`, `{"bin": "/절대경로/herdr"}`이면 그 파일을 로컬 herdr로 씁니다(`bin`이 절대경로가 아니면 `config_invalid field=herdr.bin`). 없으면 꺼짐: `ompbot_dispatch`는 simple만 보이고 `[TASK]` 스윕이 돌지 않습니다. 데몬 시작 때만 읽습니다. [herdr(선택)](#herdr선택) 참고 |
| `dispatchHosts` | 아니요 | herdr 필요(`herdr` 없이 넣으면 `config_invalid field=herdr`). 원격 위임 대상. 예: `{"wsl": {"ssh": "wsl", "workDir": "/home/<user>/work", "herdrBin": "/home/<user>/.local/bin/herdr"}}`. `herdrBin`은 비대화형 ssh의 PATH에 herdr가 없을 때 절대경로로 지정합니다 |
| `herdrBoard` | 아니요 | herdr 필요(`herdr` 없이 넣으면 `config_invalid field=herdr`). herdr-web-ui 작업 보드. 예: `{"url": "https://herdr.example.com/task/", "api": "http://127.0.0.1:7317"}`(`api` 기본값이 이 값). 넣으면 위임 접수 카드·결정 요청·Outcome 알림에 `진행 보기`/`작업 보드` 카드 링크가 붙습니다. 카드 키는 `api`의 `/api/machines`로 정합니다: 로컬 에이전트는 pane id, `dispatchHosts`의 호스트는 같은 이름 머신의 `<machine id>:<pane id>`. 못 찾으면 보드 첫 화면으로 링크합니다 |
| `restartNotice` | 아니요 | `false`면 drain 재시작 알림을 보내지 않습니다(기본 `true`). [재시작과 drain](#재시작과-drain) 참고 |
| `recallEnabled` | 아니요 | `false`면 새 턴 프롬프트에 지난 대화 회상을 붙이지 않습니다(기본 `true`). [대화](#대화)의 "지난 대화 회상" 참고 |
| `watcherRoots` | 아니요 | 절대경로 배열. `watcher` 모니터 트리거가 감시할 수 있는 디렉터리의 상한입니다. 트리거의 `root`는 심볼릭 링크를 풀고 난 실제 경로가 이 중 하나 안에 있어야 하고, 비어 있으면 watcher 트리거를 만들 수 없습니다. 예: `["/home/<user>/work"]` ([모니터](#모니터) 참고) |
| `webhook` | 아니요 | `{"port": 8123, "bind": "127.0.0.1"}`. `webhook` 모니터 트리거를 받는 loopback HTTP 리스너입니다. `bind`는 `127.0.0.1`(기본)·`::1`만 허용하고 그 밖의 값이나 범위(1~65535) 밖 포트는 설정 오류입니다. 없으면 서버를 띄우지 않고 webhook 트리거를 만들 수 없습니다. 데몬 시작 때만 읽습니다([모니터](#모니터) 참고) |
| `maxBundleBytes` | 아니요 | `ompbot backup` 번들 크기 상한(바이트, 기본 512MB). 1 이상의 정수여야 합니다. 잘못된 값은 기본값으로 돌아가지 않고 config 검증(`config_invalid field=maxBundleBytes`)에서 실패하므로 backup뿐 아니라 다음 데몬 기동·`gc`도 실패합니다. `--max-bundle-bytes`를 주면 그 값이 우선하고 config의 값은 읽지 않습니다 |
| `offsite` | 아니요 | 오프사이트 백업 대상 `{ "ssh": "별칭 또는 user@host", "remoteDir": "/절대경로 또는 ~/경로", "keep": 14 }`. `ssh`는 ssh 별칭이나 `user@host`(공백·`-` 시작 불가), `remoteDir`는 `/` 또는 `~/`로 시작하는 평범한 문자(영숫자와 `._+=@%:/-`, `..` 불가)의 경로, `keep`은 원격에 남길 종류별 최신 일일 파일 수(1 이상, 기본 14)입니다. 없으면 오프사이트 복제와 `offsite_age` 게이트가 모두 꺼집니다. 잘못된 값은 `config_invalid field=offsite.…`로 실패합니다 |
| `slack.appId`, `slack.teamId`, `slack.botUserId` | 아니요 | 기록용 |

### 6. 점검

```sh
bun src/main.ts doctor
```

홈 권한 0700, 토큰 파일 0600과 접두사, omp·bun 경로와 버전, Slack `auth.test`, 백업 번들 존재·나이(36시간)를 확인하며, 토큰 값은 출력하지 않습니다. config에 `herdr`가 있으면 로컬 `<herdr.bin 또는 herdr> --version`을 돌려 `ok herdr: <경로> <버전>` 또는 `fail herdr: <경로> <사유>`를 내고, 실패면 종료 코드가 1이 됩니다. config에 `dispatchHosts`가 있으면 이어서 호스트마다 `ssh -o BatchMode=yes -o ConnectTimeout=5 <ssh> true`를 돌려 `ok dispatch host <이름>: ssh <별칭>` 또는 `fail dispatch host <이름>: <ssh stderr 첫 줄> (warning only)`를 한 줄씩 냅니다. 꺼 둔 호스트일 수 있어 이 줄은 경고일 뿐 종료 코드를 바꾸지 않습니다. 처음 설치할 때는 백업이 아직 없어 `backup bundle` 줄만 `stamp=missing`으로 실패합니다. 나머지 줄이 모두 `ok`면 다음 단계로 가고, [백업](#백업)을 등록하거나 `bun src/main.ts backup`을 한 번 돌리면 이 줄도 `ok`가 됩니다.

### 7. 서비스 등록

[`packaging/`](packaging)의 `ompbot.service`·`ompbot-backup.service`·`.timer`·`ompbot-gc.service`·`.timer`는 `@BUN@`·`@REPO_DIR@`·`@PATH@` 자리표시자가 든 템플릿입니다. `units render`가 지금 실행한 bun(`process.execPath`), 이 체크아웃, `HOME`으로 채워 씁니다. `OMPBOT_HOME`을 지정했으면 서비스마다 `Environment=OMPBOT_HOME=<경로>` 줄이 들어갑니다.

```sh
bun src/main.ts units render --dry-run   # 쓰지 않고 '# <파일 이름>'과 내용을 출력
bun src/main.ts units render             # ~/.config/systemd/user에 다섯 파일 작성(--out <디렉터리>로 바꿈)
systemctl --user daemon-reload
systemctl --user enable --now ompbot
systemctl --user status ompbot
```

`units render`는 systemctl을 실행하지 않고 실행할 명령만 출력합니다. 대상에 내용이 다른 유닛 파일이 이미 있으면 아무 파일도 쓰지 않고 그 파일 이름을 알린 뒤 종료 코드 2로 끝납니다(직접 고친 유닛을 덮어쓰지 않음). 내용이 같으면 그대로 두고 0입니다.

유닛은 `KillMode=mixed`로 정지 때 데몬 본체에만 SIGTERM을 보냅니다. 기본값이면 omp 자식이 cgroup SIGTERM을 먼저 받아 `omp_exit expected=false`가 찍히고 drain이 턴을 마무리할 시간도 없어지기 때문이며, 데몬이 끝나면 남은 프로세스는 바로, 데몬이 `TimeoutStopSec=90` 안에 끝나지 않으면 함께 SIGKILL됩니다. 이미 설치한 호스트는 설치된 `ompbot.service`를 `units render --dry-run` 출력과 맞추거나(옮겨 두고 `units render`로 다시 쓰기) 두 줄을 직접 고친 뒤 `systemctl --user daemon-reload` 하면 다음 재시작부터 적용됩니다.

봇에게 DM을 보내 👀와 답이 오면 설치가 끝난 것입니다. 매일 백업 타이머는 [백업](#백업)에서 등록합니다.

## 사용법

### 대화

- **DM**: 메시지를 보내면 👀가 달리고, omp의 답이 같은 스레드에 올라옵니다. DM의 스레드 답글도 같은 대화방입니다.
- **채널**: 봇을 초대(`/invite @ompbot`)하면 그 채널에서 대화할 수 있습니다. 채널 본문에 새로 쓴 메시지(루트)는 하나하나가 독립 대화방이 되고(아래 채널 스레드), 채널 본문 대화방(`slack/ch/<채널ID>`)에는 루트로 친 명령(`!model …`, `!new`, `!followup …` 등)과 슬래시 명령만 갑니다. 그래서 루트로 친 `!new`·`!queue`·`!followup`은 채널 본문 대화방에만 적용되고, 진행 중인 루트 작업에는 닿지 않습니다. 루트 작업을 새로 시작하거나 대기열을 보거나 끝난 뒤 이어 보내려면 그 루트 스레드에 답글로 칩니다. 오너가 봇을 멘션한 메시지(`@ompbot 빌드 고쳐줘`)와, 봇이 이미 답한 스레드 안의 오너 답글만 받습니다. 다른 사람의 메시지와 멘션은 무시하지만 봇의 답은 채널 멤버 모두가 봅니다. 명령도 `@ompbot !model`처럼 멘션과 함께 씁니다.
- **채널 스레드**: 루트 메시지와 그 스레드의 답글이 하나의 독립 대화방(`slack/ch/<채널ID>/t/<루트ts>`)입니다. 새 루트를 쓰면 새 대화방이 열리고, 그 스레드만의 omp 세션으로 이어져 채널 본문이나 다른 스레드와 컨텍스트가 섞이지 않습니다. 답·승인 요청·작업 등록·파일 올리기는 그 루트 스레드로 갑니다. 모델·thinking을 따로 고르지 않은 스레드는 채널 본문에서 고른 값을 물려받고, 스레드에서 고르면 필드별로 스레드 값이 이깁니다. `!new`·`!compact` 같은 명령은 그 스레드에만 적용됩니다. 슬래시 명령은 Slack이 스레드 정보를 주지 않아 항상 채널 본문에 적용되므로, 스레드 설정은 `!model`처럼 `!` 형태로 바꾸세요.
- **혼자 쓰는 채널**: `mentionFreeChannels`에 등록하면 멘션 없이도 오너 메시지를 받습니다. 봇이 반응하지 않길 원하는 스레드는 `!shutup`으로 뮤트합니다.
- **끼워 넣기**: omp가 일하는 중에 같은 대화방에 보낸 메시지는 진행 중인 작업에 끼워 넣습니다(steer). 채널에서는 같은 루트 스레드의 답글만 끼워 넣고, 다른 루트는 끼워 넣지 않고 자기 대화방에서 따로 돌며 자기 스레드에 답합니다. 최근 스레드를 짐작해 이어 붙이지 않으므로, 같은 작업의 후속은 그 작업의 스레드에 답글로 쓰세요. DM처럼 한 대화방 안에서 끼워 넣은 메시지가 다른 스레드에서 왔으면, 답이나 실패 알림이 기록될 때 그 스레드에 `↪ 이 요청은 진행 중이던 작업에 합쳐져서 답을 다른 스레드에 올렸어` 안내와 답 첫 줄, 답이 달린 스레드 링크를 한 번 올립니다. 끼워 넣지 않고 다음 작업으로 줄 세우려면 `!followup`을 씁니다.
- **답 전달**: 할 일 리마인더나 끼워 넣은 메시지로 턴이 이어져 한 턴에 끝맺은 답(stop)이 여럿이면, 모두 시간순으로 빈 줄을 두고 한 답에 담깁니다. 바로 앞 답을 거의 그대로 다시 쓴 답(공백을 정규화한 문자 바이그램 Dice 0.9 이상)은 뒤 답 하나만 남깁니다. 도구 호출 사이의 중간 텍스트는 보내지 않고, 모니터 답은 마지막 답만 씁니다.
- **Slack 렌더링**: markdown 표(`| … |`)는 Slack이 그리지 못하므로 고정폭 블록으로 바뀝니다.
- **진행 상태**: 진행 중인 스레드에는 `⏳ 작업 중 · mm:ss` 상태 메시지 하나가 갱신되고 끝나면 `✅`로 바뀝니다. omp가 도구를 시작할 때마다 지금 하는 일이 덧붙고(`⏳ 작업 중 · mm:ss · <활동>`), 2분 동안 이벤트가 없으면 `⏸ 응답 없음`이 표시됩니다.
- **첨부 받기**: 오너가 올린 이미지·문서는 `~/.ompbot/media/inbound/<ts>/`로 받아(메시지당 최대 6개, 병렬 다운로드, 이미지 25MB·문서 20MB까지) `[첨부: 경로]`로 omp에게 전달됩니다. 오너가 아니거나 봇을 부르지 않은 메시지의 파일은 받지 않고, 받은 파일은 24시간 뒤 지워집니다.
- **파일 올리기**: 산출물 파일은 host tool `slack_send_file`로 요청한 스레드에 바로 올라갑니다(50MB 이하, 비밀 경로와 토큰이 든 파일은 거부 — [보안 메모](#보안-메모)).
- **세션 유지**: 한동안 쓰지 않은 omp 프로세스는 내리고 세션은 남겨 둡니다(대화·레인은 `idleTimeoutMinutes`(기본 30분), 모니터는 일이 끝나고 2분). 다음 메시지가 오면 같은 세션으로 다시 띄웁니다. 봇이 재시작돼도 대화가 이어집니다.
- **인용은 자료**: 전달·인용된 글은 읽을 자료로만 취급하고 지시로 실행하지 않습니다.
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
| `/usage-ompbot` · `!usage` | 턴을 쓰지 않고 이 대화와 전체(보관 중인 omp 세션 파일)의 모델 호출 수·입력·출력·캐시 읽기 비율·비용을 답합니다. gc로 지운 옛 세션은 빠지고, `agent: "claude"`면 집계하지 않습니다. 매니페스트에 `/usage-ompbot`을 추가하기 전에는 `!usage`로 칩니다 |
| `/followup-ompbot` · `!followup <메시지>` | 같은 대화방의 진행 중인 작업에 끼워 넣지 않고, 끝난 뒤 별도 작업으로 보냅니다(답도 그 메시지 스레드에 옵니다). 채널 루트로 치면 채널 본문 대화방 작업 뒤에 줄을 서므로, 진행 중인 루트 작업 뒤에 이어 보내려면 그 루트 스레드에 답글로 칩니다 |
| `!shutup` · `!unshutup` | 채널·채널 스레드 전용. `!shutup`을 보낸 스레드는 오너 메시지에도 반응하지 않고, `!unshutup`이나 봇 멘션으로 풀립니다. 최상위에서 보내면 그 메시지의 스레드가 뮤트됩니다. 뮤트는 재시작에도 유지되고 DM에서는 안내만 합니다 |
| `작업: <제목> @<절대경로>` | 그 경로에서 작업 레인을 엽니다([작업 레인](#작업-레인)) |
| `!reopen` · `!reopen <지시>` | 작업 레인 스레드 전용. 닫힌(✅) 레인을 같은 세션으로 다시 엽니다(🔄). 다른 메시지는 레인을 닫힌 채로 두고 답만 받습니다 |

모델·thinking 선택은 대화방마다 저장되어 프로세스를 내렸다 다시 띄워도, 데몬을 재시작해도, `/new-ompbot` 뒤에도 유지됩니다. 세션 모델이 provider에서 사라졌으면 대화방에서 고른 모델, 그것도 없으면 config `model`로 바꿉니다(config `model`이 비어 있거나 없는 모델이면 바꾸지 못하고 `model_stale_no_fallback`만 남깁니다). 고른 값은 지우지 않으므로 모델이 돌아오면 다시 적용됩니다. omp 설정 파일(`~/.omp/agent`)은 바꾸지 않습니다.

### 승인

되돌릴 수 없는 작업 전에는 host tool `ompbot_request_approval`로 승인 버튼을 띄웁니다.

- 카드는 요약 아래 `할 일`/`이유`/`영향`/`되돌릴 수 없는 이유` 절로 구조화됩니다(비어 있는 절은 생략). 버튼 아래 마감 시각이 보이고, 30분 안에 버튼이나 카드 스레드 답장이 없으면 거부로 처리됩니다.
- 승인 대기는 SQLite `approvals` 장부에 영속 기록됩니다. 더블클릭은 두 번째가 무시되고, 재시작하면 대기 중이던 카드는 "만료됨"으로 바뀌며(거부로 기록하지 않음), 시간 초과분도 스윕이 정리합니다. 오너가 아닌 클릭은 무시됩니다.
- `escalationChannel`을 지정하면 카드가 그 채널 최상위에 올라가고(헤더에 오너 멘션 + `요청 위치` 링크), 요청한 대화의 스레드에는 안내 한 줄만 남습니다. 지정하지 않으면 요청한 대화에 올라갑니다.
- 카드 스레드에 오너가 단 답글은 멘션 없이도 받아들여져 대기 중인 요청을 `replied: <답글>`로 마무리하고(도구가 그 문장을 돌려받음), 이미 끝난 카드에 단 답글은 요청했던 세션으로 그 카드 스레드에서 이어집니다.
- 승인 카드를 기다리는 턴은 멈춤 알림과 `inbound_starved` 게이트에서 빠집니다.

### 페르소나와 답변 형식

- `<ompbot 홈>/workspace/persona.md`(`workspaceDir` 설정과 무관)가 있으면 슬랙 대화 세션(`slack/*`)의 시스템 프롬프트 끝에 `[페르소나]` 절로 붙습니다(4KB까지). 안전 바닥글보다 우선하지 않고, 작업 레인·모니터·스킬 리뷰 세션에는 붙지 않습니다. 파일은 omp 자식을 띄울 때마다 다시 읽으므로, 고친 내용은 다음 새 자식(유휴 해제 뒤 다음 메시지, `/new-ompbot`)부터 적용됩니다. 파일이 없는 것은 정상이지만, 있는데 읽을 수 없으면(권한·디렉터리 등) 페르소나 없이 시작하고 `persona_unreadable`을 로그에 남깁니다.
- 슬랙 대화 세션(`slack/*`: DM·채널·스레드)에는 답변 형식 규율이 실립니다(가재웨이 허브·Hermes 보고 규칙을 따름): 첫 줄은 결론 한 문장, 길이는 질문 무게에 맞추고 끝난 일은 `바뀐 것`·`확인한 것`·`남은 것`만, 결정 요청은 `질문`·`추천`·`영향` 세 줄, herdr 위임 접수는 `맡았습니다`·`진행 보기`·`[목표]`·`[가정]`, 위임 결과는 `워커가 한 일`·`내가 한 일`·`오너가 할 일`(없으면 '없음'), 링크는 끝에 라벨 줄과 원본 URL 줄로 한 번. 모니터·작업 레인·스킬 리뷰 세션에는 실리지 않습니다(답 모양을 기계가 읽음).
- 모니터 도구 안내는 오너 DM 세션에만 실립니다.
- 모든 세션에는 구조·흐름·비교를 글 대신 mermaid·SVG·HTML 파일로 만들어 `slack_send_file`로 올리라는 권고가 실립니다.

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
- **승인 연동**: 파일 편집(작업 디렉터리 안)과 일반 도구는 묻지 않고 진행하고, 위험한 bash(재귀 강제 삭제, 포맷·원시 디바이스, 서비스·컨테이너 조작, 강제 푸시, 하드 리셋 등)는 기존 승인 카드로 올라옵니다. 카드 승인에만 그 명령이 실행되고, 거부·무응답·답장은 거부로 처리됩니다. `~/.ompbot/secrets`를 만지는 bash는 카드 없이 즉시 거부됩니다.
- **호스트 도구**: `slack_send_file`, `ompbot_dispatch`, 모니터 도구는 omp 자식 전용이라 claude 세션에는 아직 없습니다. 즉 `agent: "claude"` 상태에서는 파일 업로드·작업 위임·모니터 등록을 할 수 없습니다(승인 카드는 됩니다).
- 자식은 `--setting-sources user`로만 사용자 설정을 읽습니다. 작업 저장소의 `.claude/settings.json`이 권한을 몰래 열지 못하게 하기 위함입니다.

## 작업 위임

### herdr(선택)

herdr는 config로 켜는 선택 기능입니다. herdr 없이도 데몬·대화·모니터·백업·`ompbot_dispatch` simple(`omp -p`)은 그대로 돕니다.

- 켜기: config에 `"herdr": {}`(PATH의 `herdr`) 또는 `"herdr": {"bin": "/절대경로/herdr"}`. 설치 여부를 자동으로 감지하지 않습니다. 바꾸면 `reload`가 `restart_required=herdr`를 알리고 재시작해야 적용됩니다.
- 켜짐: 아래 `mode=herdr`·`host`·`taskSpec`, [TASK] 스윕, 대화 프롬프트의 herdr 접수 형식 줄이 모두 들어갑니다. `daemon_ready` 로그에 `herdr=on`.
- 꺼짐: `ompbot_dispatch`의 스키마·설명에 `task`(simple)만 남고, 대화 프롬프트에 herdr 접수 줄이 없습니다. 스키마를 우회해 `mode=herdr`·`name`·`host`·`cwd`·`taskSpec`을 보내면 프로세스를 띄우지 않고 "herdr가 꺼져 있어 simple만 쓸 수 있습니다" 오류가 납니다. [TASK] 스윕이 돌지 않으며, 기동 때 `working`·`blocked` 작업이 있으면 `tasks_orphaned count=N` 경고를 한 번 남기고 행은 건드리지 않습니다. `ompbot tasks` list·close는 그대로 씁니다. `daemon_ready` 로그에 `herdr=off`.
- `dispatchHosts`·`herdrBoard`는 herdr 기능이라 `herdr` 없이 넣으면 config 검증(`config_invalid field=herdr`)에서 실패합니다.

### `ompbot_dispatch`

채팅 세션은 host tool `ompbot_dispatch(task, mode?, name?, host?, cwd?, taskSpec?)`로 일을 넘깁니다(레인·모니터 세션에는 없음). `mode`·`name`·`host`·`cwd`·`taskSpec`은 herdr 켜짐일 때만 있습니다.

- `mode=simple`(기본): 단순 작업. `omp -p`로 한 번 실행하고 최종 출력을 돌려줍니다(10분 상한, 출력 8천자).
- `mode=herdr`: 여러 단계·오래 걸림·계속 추적할 작업. herdr 워크스페이스에 omp 에이전트를 띄우고 프롬프트를 넘깁니다. 같은 `name`에 task를 다시 보내면 후속 지시, task 없이 name만 보내면 현재 출력 조회입니다.
- `host`(예: `host=wsl`): 설정의 `dispatchHosts`에 등록된 호스트에서 ssh로 herdr를 구동해 원격 에이전트를 띄웁니다. 원격 호스트로 넘기는 인자(herdr 경로·cwd·작업 지시문)는 하나씩 작은따옴표로 감싸 보내므로 원격 셸이 쪼개거나 해석하지 않습니다. cwd가 정확히 `~`일 때만 원격 홈으로 풀리고, `~/…`는 글자 그대로 전달되니 원격 경로는 절대경로로 주세요.
- 여러 단계이거나 하루를 넘길 작업은 `taskSpec`을 채워 [TASK] 상태 문서로 추적합니다.
- **감사 로그**: 데몬 프로세스가 띄우는 외부 호출(원격 ssh, 로컬 herdr·git·`omp -p`, tasks 스윕의 원격 읽기 포함)은 한 지점(`realProcessRunner`)에서 `~/.ompbot/logs/dispatch-audit.jsonl`에 한 줄씩 남습니다(0600, 5MB씩 최대 4개 파일로 회전). 줄 필드: `ts`, `host`(ssh 대상, 로컬이면 `local`), `argv0`, `cmd`(비밀 마스킹 후 300자 제한, ssh는 원격 명령), `cmdSha256`(마스킹된 전체 명령 해시 앞 16자), `rc`(타임아웃이면 `null`), `ms`, `timedOut`, `origin`(`ompbot_dispatch` 호출일 때). 기록 실패는 호출을 막지 않고 `dispatch_audit_write_failed`를 한 번만 남깁니다. 기록은 데몬 프로세스에서만 켜지므로 CLI로 직접 실행한 `ompbot offsite`·`backup`·`tasks`의 ssh/scp는 남지 않습니다.
- **동결**: `ompbot freeze`가 켜져 있으면 `ompbot_dispatch`는 실행하지 않고 "동결 중" 오류를 돌려줍니다(아래 '운영' 참고).
- **위임 전 위험 검사**: herdr로 나가는 지시문(taskSpec 신규는 `task`·`title`·`goal`·`scope`·`background`, 재개·후속 지시·원격 시작은 `task`)을 내보내기 전에 앞 64KiB를 줄 단위로 훑습니다. 하드 리셋·강제 clean·강제 push·보호 브랜치(`main`·`master`) push·`git branch -D`·`/`·`~`·`$HOME` 대상 `rm -rf`·`DROP TABLE` 류·서비스·컨테이너 조작(systemctl·docker·podman·pm2)·`mkfs`·`dd of=/dev/`·`.ompbot/secrets`는 고위험, 패키지 설치와 `OMP_OWNER_APPROVED`는 주의입니다. 같은 줄에 금지 표지(`하지 않는다`·`금지`·`never`·`do not`·`- no ` 등)가 있거나 그 줄이 규칙 이름 자체를 적고 있으면(검사기 설명) 주의로 내립니다. 고위험이면 오너 승인 카드를 띄워 승인일 때만 내보내고(taskSpec 신규는 등록 위험등급을 L3 이상으로 올림), 거부·시간 초과·답장·승인 장치 없음이면 워커·워크트리·등록 행을 만들지 않고 오류를 돌려줍니다. 주의는 그대로 내보내고 결과 끝에 `위험 검사: advisory (<규칙>)`를 붙입니다. simple(`omp -p`)과 조회만 하는 호출은 검사하지 않습니다. 로그: `dispatch_risk_advisory`·`dispatch_risk_high`·`dispatch_risk_approved`·`dispatch_risk_refused`.

### [TASK] 상태 문서

세션이 `taskSpec`(신규: `title, risk(L0~L4), goal, scope[], exclusions[], acceptance[](1개 이상), repo(대상 호스트의 git 저장소 절대경로), background?, assumptions?` + `task` 지시문, 재개: `{id:"T-…"}`만)을 채우면 ompbot이 한 번에 다음을 만듭니다. `taskSpec` 없는 dispatch는 달라지지 않습니다.

- TASKID `T-YYYYMMDD-NN`(KST 날짜 + 그날 순번), 대상 호스트(로컬 또는 `host` 원격)의 워크트리 `<repo>-t-yyyymmdd-nn`(branch `task/T-…`), herdr 에이전트 `t-yyyymmdd-nn`.
- 워크트리 `docs/tasks/<TASKID>/`의 4문서: `context.md`(요청 원문·배경) · `spec.md`(목표·범위·제외·수락기준 체크박스) · `PROGRESS.md`(기계가 읽는 상태 파일: `status`·`updated`·`current`·`next`·단계 목록) · `outcome.md`(맨 위 `## 요약` 2~3줄과 AC별 `commit`·`test`·`file` 증거). 에이전트는 spec.md의 체크박스만 `[x]`로 바꾸고 문구는 고치지 않습니다. 4문서는 등록 때 task 브랜치의 첫 커밋(`docs(task): <TASKID> 4문서`)으로 남고(커밋이 실패하면 등록을 되돌림), 에이전트는 문서 갱신을 단계 커밋에 함께 넣고 `updated`에 `date -Iseconds`로 얻은 실제 시각을 씁니다.
- 작업 스레드에 접수 카드 1개와 루트 메시지의 상태 반응 하나(⏳ 진행 · 🔍 리뷰 · 🚧 blocked · ✅ 완료 · ❌ 취소). [TASK] 루트에는 턴 종료 반응(✅·⚠️·❌)을 달지 않고 👀만 거둡니다.
- 5분마다 스윕이 파일과 git만 읽어(LLM 호출 없음) Outcome을 판정합니다. 도달 조건: spec.md 수락기준이 등록 스냅샷과 같고, 모든 AC가 `[x]`이고, outcome.md에 AC마다 commit/test 증거가 있고, 모든 commit이 워크트리에 실재(`git cat-file -e`)하고, PROGRESS `status`가 blocked가 아님. PROGRESS의 `review`·`done`이나 "완료" 문구는 판정에 쓰지 않습니다. 도달하면 🔍로 바꾸고 스레드에 "Outcome 도달"을 한 번 올립니다 — 리뷰 자격일 뿐 완료가 아닙니다.
- 접수 카드는 가재웨이 허브의 "맡았습니다" 보고 모양입니다: 첫 줄 `` `local`에서 `t-…`(<제목>)가 맡았습니다. 결정이 필요하거나 끝나면 이 스레드로 알려 드립니다. ``, 다음 줄 `진행 보기: <보드 카드 링크>`(`herdrBoard` 설정 시), 빈 줄 뒤 `[목표]`(spec goal)·`[가정]`(taskSpec `assumptions`, 없으면 "없음")·`[작업]`(TASKID·위험등급·브랜치·수락기준 수·워크트리). 카드를 올렸으면 도구 결과가 세션에 "카드를 되풀이하지 말라"고 알리고, 못 올렸으면 같은 모양으로 직접 쓰라고 알립니다. `taskSpec` 없이 `host`로 띄운 원격 에이전트도 도구 결과에 진행 보기 링크와 이 접수 모양이 실립니다.
- 막히면 에이전트가 PROGRESS.md에 `status: blocked`와 함께 `blocked_reason`·`question`·`recommend`·`impact`를 적고, 스윕이 이를 `🚧 멈춤 · <제목> — 결정이 필요합니다.` 결정 요청(오너 멘션, `*사유*`·`*질문*`·`*추천*`·`*영향*`·`*지금 단계*`, 끝에 `작업 보드` 링크)으로 올립니다. Outcome 도달 알림은 첫 줄(제목·AC n/m·오너 멘션) 뒤에 에이전트가 outcome.md 맨 위 `## 요약`에 쓴 한국어 2~3줄(무엇이 바뀌었나·검증 결과·스펙 밖 예외)을 `• `로 최대 3줄(줄마다 200자) 싣고, 요약이 없거나 비었으면 `⚠️ 요약 없음 — docs/tasks/<ID>/outcome.md를 직접 봐 주세요.` 한 줄을 싣습니다(요약 유무는 판정에 쓰지 않음). 이어서 두 기준 이상이 같은 커밋 증거만 댔으면 `⚠️ 증거 약함: …`(커밋이 기준을 채우는지는 봇이 판정하지 않음)·`*질문*`(머지 여부)·`*답하는 법*`·`*근거*`(`docs/tasks/<ID>/outcome.md`와 `git -C <worktree> log --oneline main..<branch>`)·`작업 보드` 순서입니다. 수락기준 목록과 AC별 증거는 카드에 싣지 않고 outcome.md에만 남습니다. 보드 링크는 알림 때마다 herdr `agent list`의 현재 pane으로 다시 구합니다.
- 그 밖에 spec 변경 경고, 30분 넘는 갱신 지연 시 에이전트 리마인더(30분에 한 번)와 2시간 넘으면 스레드 알림, 읽기 3회 연속 실패 알림이 키당 한 번씩 올라옵니다. 리마인더는 herdr `agent list`의 에이전트 상태가 `working`·`blocked`이면 끊지 않고 미뤘다가(`task_remind_deferred`) 쉬는 상태가 된 첫 스윕에 보내고, 상태를 묻지 못하거나 `unknown`이면 그대로 보냅니다. herdr에 에이전트가 없으면 리마인더 대신 `👻 에이전트 없음` 알림(오너 멘션, `taskSpec:{id}` 재개 안내)을 스레드에 한 번 올리고, 재개 뒤 다시 사라지면 다시 한 번 올립니다. PROGRESS `updated`가 미래면 지금 시각으로 보고 `task_updated_future` 경고를 남깁니다.
- 진행 중인 작업을 에이전트 이름으로 조회하면(`ompbot_dispatch {host?, mode:"herdr", name:"t-…"}`) herdr 출력 뒤에 `AC n/m · 단계 n/m · status · 마지막 갱신` 한 줄이 붙습니다.
- 완료 처리는 사람만 합니다. 봇 경로(도구·스윕)는 `done`·`cancelled`로 바꾸지 못하고 ledger가 거부합니다.
- 상태가 바뀔 때마다(등록 포함) 같은 트랜잭션에서 `task_transitions`에 `from→to`·`actor`(bot/human)·사유·시각이 한 줄씩 쌓이고(고치거나 지우지 않음, 기동 전 실패로 등록을 되돌릴 때만 함께 지움), `tasks show`의 `history` 배열로 보입니다. 도입 전 작업은 빈 배열입니다.

```sh
bun src/main.ts tasks list [--json]
bun src/main.ts tasks show <T-…>                        # 레지스트리 행 + 상태 전이 기록(history) + 지금 판정
bun src/main.ts tasks check <T-…>                       # 지금 판정; 실행 중인 데몬이 스윕과 같은 게시·반응을 합니다
bun src/main.ts tasks close <T-…> --as done|cancelled   # 사람 전용. 반응을 ✅/❌로 바꾸고 스윕 대상에서 뺍니다
```

`close`는 워크트리와 브랜치를 지우지 않습니다. 리뷰·merge 뒤에 사람이 정리합니다(원격 작업이면 그 호스트에서):

```sh
git -C <repo> merge task/T-…
git -C <repo> worktree remove <repo>-t-yyyymmdd-nn
git -C <repo> branch -d task/T-…
```

### 작업 레인

`작업: <제목> @<프로젝트 절대경로>`를 보내거나 채팅 세션이 host tool `ompbot_work_start`를 부르면, 그 경로에서 일하는 레인이 별도 스레드로 열립니다.

- 레인은 `🔄 제목` 루트와 `⏳` 상태 메시지(15분마다, 단계 보고 시 바로 갱신)를 갖고, 진행은 `ompbot_lane_progress`로 보고합니다.
- 동시에 최대 4개까지 열리고, 같은 저장소(같은 realpath 또는 상하위 경로)에는 레인 하나만 열립니다 — 진행 중인 레인이 있으면 그 이름을 알려주고 거부합니다.
- 레인은 커밋하고 `ompbot_claim_done`을 불러야 닫힙니다. 미커밋 변경이 남았거나, 시작 커밋 뒤 새 커밋이 없거나, 커밋이 그 저장소에 없으면 거부하고 사유를 레인에 되돌립니다. 검사를 바로 못 돌렸으면 5분 뒤 다시 판정합니다.
- git을 통과해도 완료 보고에 TODO/FIXME·건너뛴 테스트·스텁·가드 삭제(대응 부정 테스트 없음)·명령 없는 "통과" 주장이 있으면 무결성 거부되고, 오너 승인 버튼으로만 예외 처리합니다.
- 검증을 통과하면 루트와 상태가 ✅로 바뀌고 레인이 닫힙니다. 레인 등록은 장부에 있어 재시작해도 스레드가 이어집니다.
- 닫힌 레인의 스레드에 오너가 쓴 메시지(`!followup <메시지>`의 메시지 포함)는 질문으로 처리합니다: 레인 세션이 답하지만 레인은 ✅ 그대로 닫혀 있고 history에 `owner_question`만 남습니다. `!model`·`!new`·`!queue` 같은 채팅 명령은 원래대로 동작하고 history에 남지 않습니다. 세션에는 답만 하고 수정·커밋·완료 주장은 하지 말라는 안내가 함께 가고, 닫힌 레인에서 `ompbot_claim_done`·`ompbot_lane_progress`는 아무것도 바꾸지 않고 `!reopen` 안내를 돌려줍니다. 안내는 프롬프트 문구라 세션이 어기면 파일 수정 자체는 막지 못합니다(도구로 거부하는 것은 이 두 레인 도구뿐입니다).
- 수정을 다시 시키려면 레인 스레드에 `!reopen` 또는 `!reopen <지시>`를 씁니다. 같은 세션으로 다시 열리고(🔄) 닫힐 때의 커밋이 새 기준이 되어, 그 뒤 새 커밋과 `ompbot_claim_done` 검증을 다시 거쳐야 닫힙니다. 새 작업은 `작업: …`이나 `[TASK]`로 엽니다.

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

예시 모니터 [`examples/monitors/weekly-improvement/`](examples/monitors/weekly-improvement)(주간 개선 회의)는 설치할 때 파일 안의 `@OMPBOT_HOME@`을 자기 홈으로 바꾸고, `collect.py`·`meeting.py`·`procedure.md`를 `<홈>/scripts/weekly-improvement-<원래 이름>`으로 둔 뒤 바꾼 `monitor.json` 내용을 `monitors add --json`에 넘깁니다.

### 내보내기·적용 (설치본 저장소)

모니터 정의는 DB에만 있으므로, 설치본 저장소(예: `hosts/<host>/monitors/`)에 두려면 `export`로 파일을 만들고 다른 홈에서는 `apply`로 넣습니다.

- `export --dir <d>`: 모니터마다 `<d>/<이름>.json`을 씁니다. 파일 이름은 이름의 `/`·공백·제어문자를 `-`로 바꾼 것이고, 같아지면 이름순으로 `-2`, `-3`을 붙입니다(파일 안의 `name`이 기준입니다). 내용은 스펙 필드(`name`·`trigger`·`instruction`·`overlap`·`enabled`·`channel`·`copyChannel`·`model`·`thinking`·`deliver`·`procedureFiles`)만 고정된 키 순서로 담고, 모니터 id·커서·상태·시각은 넣지 않습니다. `<홈>/scripts/` 아래 경로는 `@SCRIPTS@/`, workspaceDir 아래 경로는 `@WORKSPACE@/`로 바꾸고, 그 밖의 절대경로는 그대로 두고 stderr에 경고를 냅니다. webhook 트리거는 `{"kind":"webhook"}`만 쓰고 id·토큰은 내보내지 않습니다. 디렉터리에 남은 이전 `*.json` 중 지금 DB에 없는 모니터의 파일은 지웁니다(다른 파일은 그대로). `--with-files`면 참조된 script·절차 파일을 `<d>/files/scripts/`·`<d>/files/workspace/`에 실행 비트와 함께 복사합니다. 출력: `exported=N removed=N`.
- `apply --dir <d>`: `<d>/*.json`의 자리표시자를 이 홈의 경로로 풀고 `monitors add`와 같은 규칙으로 모두 검증합니다. 파일 하나라도 검증에 실패하면 실패한 파일과 사유를 stderr에 쓰고 아무것도 바꾸지 않은 채 종료 코드 2로 끝납니다. 이름으로 기존 모니터를 찾아 없으면 추가하고, 내용이 다를 때만 고치며(webhook id·토큰은 유지), 같으면 건드리지 않아 `updated_at`도 그대로입니다. 파일에 없는 필드는 기본값(`overlap` queue, `enabled` true, 옵션 해제)으로 봅니다. 디렉터리에 없는 모니터는 남기고, `--prune`이면 지웁니다(슬롯·이벤트와 함께). `--dry-run`은 같은 출력만 내고 DB를 바꾸지 않습니다. 출력: `added=N updated=N unchanged=N removed=N`. 파일 복사는 하지 않으므로 script·절차 파일은 적용 전에 그 홈의 `scripts`·workspace에 먼저 두어야 합니다.

### 트리거

- `cron`: 5필드, 기본 시간대 `Asia/Seoul`(`timezone`으로 변경). 재시작 뒤 밀린 발사는 최근 24개·24시간 이내만 다시 돌리고 나머지는 건너뛴 것으로 기록합니다.
- `at`: ISO 시각. 오프셋이 없으면 Asia/Seoul로 읽고, 한 번만 발사한 뒤 꺼집니다. 24시간 넘게 지난 시각은 실행하지 않습니다.
- `script`: `~/.ompbot/scripts` 아래의 실행 파일만 허용, `intervalMs`는 60000 이상, 실행 60초 제한. exit 0이면 조건 성립으로 보고 stdout(8000자까지)이 자료로 전달됩니다. stderr는 판정에 쓰지 않고 마지막 2000자를 `monitor_script` 로그에 붙여 실패 원인을 남깁니다. `monitor_script` 로그 줄은 결과가 바뀌었을 때, 성립(exit 0)·오류·시간 초과, stderr가 있을 때만 남고, 변화 없는 조용한 미성립 검사는 기록하지 않습니다.
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
| `channel` | `C…`/`G…` 채널 id. 결과를 오너 DM 대신 그 채널 최상위에 올립니다. 긴 답의 나머지는 그 메시지 스레드에 달리고, `<@U…>`는 실제 멘션이 됩니다 |
| `copyChannel` | `C…`/`G…` 채널 id. 끝난 모든 실행의 사본을 그 채널 최상위에 더 올립니다. 조용히 넘어간 실행은 마커 줄을 뺀 답(남는 것이 없으면 `알릴 내용 없음`)으로 올리고, 실패 알림은 복사하지 않습니다 |
| `model`, `thinking` | 이 모니터 세션의 모델(`provider/id`)·thinking(`off\|minimal\|low\|medium\|high\|xhigh\|max`)을 고정합니다. 필드별로 대화방 선택보다 우선합니다 |
| `deliver` | `turn`(기본) · `verbatim`. 아래 참고 |
| `procedureFiles` | 최대 5개 파일 경로(절대, 또는 workspaceDir 기준 상대). workspaceDir 또는 `~/.ompbot/scripts` 안의 일반 파일만 허용하며(심볼릭 링크는 실제 경로로 판정) 밖이면 거부합니다. 발사할 때마다 디스크에서 다시 읽어 파일별 `[절차 파일 <경로>]` 블록으로 지시 뒤에 붙입니다. 합계 64KiB까지이고 넘으면 잘림 표시, 못 읽는 파일은 `읽기 실패` 줄로 남기고 발사는 계속합니다. 긴 절차를 4000자 지시 밖에 두는 용도입니다. `monitors update`에서 `null`이면 해제 |

`monitors update`에서 `channel`·`copyChannel`·`model`·`thinking`을 `null`로 주면 해제합니다. `monitors list`는 설정된 옵션(`channel=`·`copyChannel=`·`model=`·`thinking=`·`fire=`·`once`·`state=`·`deliver=verbatim`)을 함께 보여 주고, `monitors list --json`과 `ompbot_monitor_list`는 `deliver`를 늘 보여 줍니다.

### 실행과 전달

- **매 발사 새 세션**: 모니터가 쉬고 있으면 발사마다 새 세션으로 시작합니다(`/new`와 같은 방식). 쌓인 컨텍스트를 매번 다시 내지 않기 위해서이고, 모니터의 상태는 파일과 스크립트 출력에 둡니다. 앞 턴이 도는 중에 대기열로 들어온 발사는 그 세션을 이어 씁니다.
- **응답 억제**: 답의 첫 줄이나 마지막 줄(한 줄짜리 답이면 답 전체)이 `NO_REPORT` 또는 `[SILENT]`면 두 마커 모두 같은 규칙으로 게시하지 않고 결과만 저장합니다.
- **`deliver: "verbatim"`**(script 트리거 전용): 발사된 이벤트의 payload(스크립트 stdout 그대로)를 omp 턴 없이 `⏰ <이름>\n<payload>`로 바로 올리므로 모델·provider 장애가 전달을 막지 않습니다. 채널·사본·재시도·전달 확인은 턴 모니터와 같고, 쌓인 이벤트는 한 점검 주기에 차례로 모두 나갑니다. payload를 가공하지 않고 `NO_REPORT`·`[SILENT]`도 해석하지 않습니다(빈 payload만 `no_report`). `instruction`은 필수이지만 설명으로만 남고 `model`·`thinking`은 저장만 됩니다. verbatim 모니터의 trigger를 script가 아닌 것으로 바꾸려면 같은 update에서 `"deliver":"turn"`을 함께 줍니다.
- **실패**: 10분·1시간·4시간 뒤 재시도하고, 그래도 실패하면 알림을 한 번 보내고 멈춥니다(`failed_no_retry`). 빈 답도 실패로 셉니다. 같은 모니터가 같은 오류(지속시간과 4자리 이상 숫자는 정규화하고, 3자리 코드는 그대로 비교)로 다시 실패하면 24시간 안에는 조용하고, 성공 실행이 인시던트를 해소하면 다음 실패부터 다시 알립니다.
- `/status-ompbot`과 `ompbot status`는 모니터 개수와 다음 발사(이름·Asia/Seoul 시각)를 보여 줍니다.
- 실제 omp E2E: `OMPBOT_E2E_OMP=1 bun test test/monitor.e2e.test.ts`(토큰 소모).

## 운영

```sh
bun src/main.ts status [--json]   # 데몬이 꺼져 있으면 DB를 직접 읽습니다
bun src/main.ts doctor            # home·secrets·omp·bun·Slack auth·백업 번들 점검, herdr 켜짐이면 herdr --version, 이어서 dispatchHosts마다 ssh 도달(`ok`/`fail <사유>`, 실패해도 종료 코드는 그대로)
bun src/main.ts offsite [--json]    # 최신 백업을 오프사이트(config offsite)로 다시 복제
bun src/main.ts gates [--json]    # 읽기 전용 건강 판정 — 게이트 하나라도 열리면 exit 1
bun src/main.ts gc [--dry-run]    # 보존 기간이 지난 이전 대화 세션, 오래 쉰 채널 스레드 세션, 삭제된 모니터의 세션 정리
bun src/main.ts backup [--keep N] [--max-bundle-bytes N]
bun src/main.ts drain [--wait] [--timeout <분>] # 재시작 전 대기(--wait 없으면 걸기만 하고 바로 끝남)
bun src/main.ts drain --cancel
bun src/main.ts apply [--detach] [--stamp <YYYYMMDD-HHMMSS>] [--timeout <분>] [--merged-at <ISO>] [--report-origin slack/ch/<C>|slack/dm/<D> --report-thread <ts>] [--json]
                                  # 머지한 변경을 데몬에 반영(사전 검증→백업→drain→재시작→준비 대기→영수증)
bun src/main.ts restore <백업 db 경로> [--yes]   # 데몬이 꺼진 상태에서 ompbot.db를 백업으로 교체
bun src/main.ts freeze [--reason <이유>]  # 킬스위치: ~/.ompbot/FROZEN 작성
bun src/main.ts unfreeze          # FROZEN 삭제
bun src/main.ts reload            # 실행 중인 데몬이 config.json을 다시 읽음(SIGHUP과 같음)
bun src/main.ts daemon            # 데몬 본체(systemd 서비스가 실행)
bun src/main.ts skills rollback <이름>           # 스킬을 직전 개정으로 되돌림
bun src/main.ts inject --origin slack/dm/<DM ID>|slack/ch/<채널ID> --as-owner --text "…" [--quoted "…"] [--thread <ts>]
                                  # 로컬 소켓으로 오너 메시지를 주입(시험용, 답은 실제 Slack에 올라감)
                                  # --thread: 표식과 오너 메시지를 그 스레드(루트 ts)의 답글로 올림
bun src/main.ts tasks …           # [TASK] 상태 문서
bun src/main.ts monitors …        # 모니터
journalctl --user -u ompbot -f
```

- **로그**: `~/.ompbot/logs/ompbot.log`(키=값 형식, 10MB씩 최대 5개 파일로 회전). 토큰 모양 문자열과 알려진 비밀 값은 `[REDACTED]`로 바뀝니다. 로그 디렉터리에 쓸 수 없으면 데몬이 시작하지 않습니다(`log_dir_unwritable`).
- **로그 위생**: 반복되는 무의미한 `info` 줄은 한 줄씩 쓰지 않고 센 뒤 1시간마다 `log_summary window_s=… total=… <이벤트>=<개수> …` 한 줄로 냅니다. 대상은 `inbound_dropped`의 `reason=bot_message`·`reason=not_addressed`(키 `inbound_dropped_bot_message`, `inbound_dropped_not_addressed`)뿐이고, `warn`·`error`와 다른 이유의 drop은 그대로 한 줄씩 남습니다. 데몬이 종료될 때 남은 개수도 한 번 비웁니다. 또 1시간마다 `service_alive uptime_s=… origins=… busy=… pending=… dispatched=…`를 남기므로, 한 시간 넘게 이 줄이 없으면 데몬이 죽었거나 막힌 것입니다(`grep service_alive ~/.ompbot/logs/ompbot.log`).
- **상태 저장**: `~/.ompbot/ompbot.db`(SQLite WAL), 대화별 omp 세션은 `~/.ompbot/sessions/`. 데몬은 단일 인스턴스 잠금(`ompbot.lock`)과 0600 유닉스 소켓(`ompbot.sock`)을 씁니다.
- **omp 업그레이드**: 데몬은 시작할 때 omp 버전이 바뀌었으면 `omp_version_changed`를 남기고, omp를 띄울 때마다 필요한 RPC 메서드가 있는지 확인해 없으면 `omp_rpc_client_missing`으로 바로 실패합니다. 그보다 먼저 `ompExecutable`이 패키지 launcher(`dist/cli.js` 심링크)인지, PATH의 bun이 omp `package.json`의 `engines.bun`을 만족하는지 확인해, 단독 실행 파일이면 `omp_launcher_standalone`, bun이 낡았으면 `bun_too_old`로 실패합니다. `omp update`는 bun이 요구 버전보다 낮으면 심링크를 단독 실행 파일로 바꿔 버리므로, **omp를 올리기 전에 `bun upgrade`를 먼저 하세요**. 같은 검사가 `omp_runtime` 게이트로도 돌아 업데이트 직후 5분 안에 자가진단 DM이 갑니다. 업그레이드 뒤에는 `bun run smoke-omp`로 호환성을 확인하세요(모델 비용 발생). 임시 세션 디렉터리에서 실제 omp로 RPC 계약과 채팅 명령(모델·thinking·compact·followup·queue·idle 해제·resume)을 돌립니다. 다른 omp는 `OMPBOT_OMP_EXECUTABLE=/경로/omp`, 모델은 `OMPBOT_E2E_OMP_PROVIDER`·`OMPBOT_E2E_OMP_MODEL`로 고릅니다.
- ops-check 점검 항목 예시(`svc-ompbot.service`, `ompbot-status`, `ompbot-backup-age`, `ompbot-gates`)는 [`examples/ops-check-ompbot.json`](examples/ops-check-ompbot.json)에 있습니다. `@BUN@`·`@REPO_DIR@`·`@HOME@`·`@HOST@`를 자기 값으로 바꿔 ops-check 설정의 `checks`에 합칩니다.

### 동결(킬스위치)

`ompbot freeze --reason "…"`는 `~/.ompbot/FROZEN`(JSON: `since`, `reason`, `by`, 0600)을 씁니다. 데몬은 이 파일을 2초 안에 다시 읽어 반영하며 재시작이 필요 없습니다. 동결 중에는:

- `ompbot_dispatch`가 모든 모드(원격 포함)에서 "동결 중" 오류를 돌려주고 아무 명령도 실행하지 않습니다.
- 모니터가 발사되지 않습니다. 시각이 된 발사는 `skipped` 이벤트(사유 `frozen`)로만 남고 커서가 앞으로 가므로, 해제해도 몰아서 쏘지 않습니다. 해제 전에 이미 큐에 있던 이벤트도 `skipped`(`error=frozen`)가 되고, script 점검은 실행되지 않습니다. 시각이 된 한 번짜리 `at` 모니터는 꺼지지 않고 기다렸다가(`monitor_at_held_frozen`, 동결마다 한 번) 해제 뒤 한 번 발사됩니다(그 사이 24시간이 지나면 `catchup_age`로 건너뛰고 꺼짐). `monitors test`는 동결 중에도 수동 이벤트를 만들지만 출력에 `"frozen":true`가 붙고, 데몬은 그 이벤트를 `skipped`로 처리합니다.
- 새 작업 레인 시작이 거부되고(`lane_refused_frozen`), 실행 중인 레인에는 not-done 판정 뒤의 자동 재프롬프트를 보내지 않습니다(`lane_send_held_frozen`). 레인이 동결 중에 스스로 완료를 주장하면 판정은 그 도구 응답으로만 돌아가고, 레인은 not-done 그대로 다음 주장을 기다립니다. 코어가 미뤄 둔 완료 주장 재판정(검증을 못 끝내 5분 뒤 다시 보는 것)은 동결 동안 하지 않고, 재판정 도중(검증·무결성 승인 대기 중) 동결되면 not-done을 확정하지 않은 채(`lane_verdict_held_frozen`) 주장을 남겨 둡니다. 해제 뒤 첫 점검에서 다시 판정해 not-done이면 그때 재프롬프트합니다. [TASK] 스윕은 에이전트에게 정체 리마인더를 보내지 않습니다(`task_remind_frozen`은 동결마다 task당 한 번; 해제 뒤에도 정체면 그때 전송). 차례가 온 [스킬 리뷰](#스킬-리뷰)도 돌리지 않습니다(`skill_review_skipped_frozen`).
- 오너 메시지에 답하는 대화 턴은 계속 동작합니다. 오너가 봇과 대화하며 원인을 묻고 풀 수 있습니다. 채팅 명령은 없고, 해제는 `ompbot unfreeze`뿐입니다.
- `frozen` 게이트가 열려 있어(`ompbot gates` exit 1, 5분 안에 `🚨 [자가진단]` DM) 잊고 지나치지 않습니다. `ompbot status`/`/status-ompbot`에는 `FROZEN · <since> · <by> · <reason>` 줄이 나옵니다.

### 재시작과 drain

코드·설정 변경을 데몬에 반영할 때는 `ompbot apply` 한 줄로 합니다. 진행 중인 턴을 끊지 않도록 drain을 걸고 기다린 뒤 재시작하며, 단계마다 영수증을 남깁니다.

```sh
cd ~/work/ompbot && bun src/main.ts apply --merged-at <머지 시각 ISO> [--timeout 60]
# 봇과 대화하는 세션(턴 안)에서는 턴이 끝나야 drain이 끝나므로 분리 실행합니다:
bun src/main.ts apply --detach --merged-at <ISO> --report-origin slack/ch/<채널ID> --report-thread <요청 ts>
```

순서와 판정:

1. **사전 검증** — 이 체크아웃의 현재 브랜치가 `main`이고 `HEAD == main`, `git status --porcelain -- src`가 비어 있고, `systemctl --user is-active ompbot`이 0이어야 하고(user bus 없음 포함), `bun`을 찾을 수 있어야 합니다(프로세스 PATH 앞에 `~/.local/bin`, `~/.bun/bin`을 붙이므로 systemd user PATH에서도 찾습니다). 하나라도 어긋나면 아무것도 바꾸지 않고 SKIP(종료 코드 3)입니다. `--merged-at`을 주면 데몬 `ActiveEnterTimestamp`가 그보다 뒤일 때 이미 반영된 것으로 보고 성공(0)으로 끝납니다.
2. **백업** — `ompbot backup`과 같은 스냅샷에 더해 `config.json`을 `config.json.bak-<stamp>-apply`(0600)로 복사해 영수증용 기록으로 남깁니다(롤백 대상은 아님). config가 가장 최근 `*-apply` 사본과 바이트까지 같으면 새로 만들지 않고 그 사본 경로를 영수증 `configBackup`에 적으며, 새로 만들었으면 `*-apply` 사본을 최신 10개만 남깁니다(손으로 만든 다른 `bak` 이름은 건드리지 않음).
3. **drain** — `drain --wait`와 같은 경로(`--timeout` 분, 기본 60). 시간 초과·소켓 불통이면 재시작하지 않고 실패(1)로 끝나며, 시간 초과는 drain을 풀고 끝납니다.
4. **재시작** — `systemctl --user restart ompbot`.
5. **준비 대기** — 최대 2분 동안 IPC `status`가 응답하고 `ompbot.lock`의 `startedAt`이 재시작 요청 시각보다 뒤인 새 프로세스일 때만 통과합니다(옛 데몬이 계속 응답하는 경우는 통과하지 않음).
6. **기록** — `collectGates` 결과와 `doctor` 요약을 영수증에 적습니다. 열린 게이트·doctor 실패는 보고만 하며 반영을 되돌리지 않습니다.
7. **실패 시 롤백** — 재시작 단계 이후 실패하면 `config.json.last-good`(데몬이 부팅해 `daemon_ready`를 찍은 직후, 재시작 필요 필드 없이 `reload`가 전부 적용된 직후, apply가 새 데몬 준비를 확인한 뒤에 원자적으로 남기는 0600 사본. 데몬은 자신이 검증한 내용만 기록합니다. 부팅 때는 `loadConfig` 직전에 읽은 텍스트를 기준으로 삼아, 그사이 파일이 바뀌었거나(`config_changed_since_boot`) 그 텍스트를 읽지 못했거나(`config_unreadable`) `restart_required`가 있으면 `last_good_config_skipped`만 남깁니다)에서 `config.json`을 복원하고 한 번 더 재시작합니다. last-good이 없으면 "복원할 정상 config 없음"을 영수증에 적고 config는 건드리지 않습니다. 새 데몬을 확인하지 못한 채 끝나는 경로(재시작 실패·롤백 재시작 실패)에서는 IPC `drain_cancel`을 시도하고 결과를 영수증에 남깁니다. **코드는 자동으로 되돌리지 않고**, 영수증에 이전 HEAD sha(reflog `HEAD@{1}`)와 되돌리기 명령(`git diff --cached --quiet && git read-tree -m -u HEAD <이전> && git commit` — merge 커밋이 있어도 트리째 복원하되 무관한 로컬 수정·미추적 파일은 보존하고, staged 변경이 있으면 실행하지 않음)을 적습니다. 종료 코드는 1입니다.
8. **영수증** — `~/.ompbot/logs/apply-<stamp>.json`에 단계별 `name`·`ok`·`detail`·`ms`, 게이트·doctor 요약, 이전 HEAD, 백업 경로를 남깁니다(0600). `--report-origin`(+`--report-thread`)을 주면 성공·실패·SKIP 모두 `[자동 후속] apply 결과 … 영수증 경로`를 그 스레드에 오너 메시지로 넣고, 그 inject 결과도 영수증 `report`에 기록합니다(inject가 실패해도 종료 코드는 바뀌지 않음).

- `--detach`: 같은 인자로 `systemd-run --user --collect --unit=ompbot-apply-<stamp>`를 띄우고 유닛 이름과 영수증 예정 경로(`apply_detached unit=… receipt=…`)를 출력한 뒤 바로 끝납니다(PATH·`OMPBOT_HOME`을 유닛에 넘김). 영수증이 생기거나 `--report-origin` 보고가 오지 않으면 `journalctl --user -u ompbot-apply-<stamp>`를 보세요.
- `--stamp YYYYMMDD-HHMMSS`: 영수증·백업 이름에 쓸 stamp를 고정합니다. `--detach`가 자식 유닛에 자기 stamp를 넘길 때 쓰며, 직접 줄 일은 거의 없습니다(형식이 다르면 사용법 오류 2).
- 종료 코드: 0 성공·이미 반영, 1 실패(롤백 수행), 2 사용법 오류, 3 사전 검증 SKIP. `--json`은 영수증 JSON 한 줄만 출력합니다.
- 반영 전 코드 머지·승인은 `apply`의 일이 아닙니다. 같은 날 변경이 여럿이면 머지를 모았다가 한 번에 반영하세요(재시작마다 살아 있던 세션의 캐시가 다시 쓰입니다).

`apply` 없이 손으로 하려면 아래처럼 drain 뒤에 재시작합니다. 봇과 대화하는 세션이라면 답이 먼저 나가도록 지연 실행으로 겁니다.

```sh
systemd-run --user --on-active=90 --unit=ompbot-restart \
  bash -lc 'cd ~/work/ompbot && bun src/main.ts drain --wait --timeout 60 && systemctl --user restart ompbot'
```

- `drain`은 데몬 메모리에만 걸리고(재시작하면 풀림), 거는 동안 새 턴 시작·끼워 넣기·명령 실행·모니터 발사·스킬 리뷰를 하지 않습니다. 그동안 들어온 메시지는 👀만 달리고 `pending`으로 기록되며, 재시작한 데몬이 시작하자마자 처리합니다.
- 진행 중 턴·실행 중 호스트 도구(승인 대기·업로드·dispatch)·대기 중 승인이 모두 0이 되면 `drain --wait`가 0으로 끝나고, 시간 초과(기본 60분)면 drain을 풀고 1로 끝나므로 위 명령은 재시작하지 않습니다. `drain --cancel`로 중간에 풀면 그동안 쌓인 pending 메시지를 바로 처리합니다. drain 중에는 멈춘 대기 메시지 재시도 스윕도 쉬므로, 일부러 붙잡아 둔 메시지가 자가보고로 잘못 알려지지 않습니다. drain 중에는 `ompbot status`와 `/status-ompbot`에 `재시작 대기(drain) 중 · 진행 턴 N · 호스트 도구 N · 승인 대기 N`이 보입니다.
- **재시작 알림**: drain을 걸면 진행 중이거나 최근 30분 안에 오너 메시지가 있었던 대화(최대 10곳)의 마지막 스레드에 `🔄 ompbot을 곧 재시작합니다…`를 올리고, 그 스레드 목록을 `~/.ompbot/restart-notice.json`에 남깁니다. 재시작한 데몬은 기동하자마자 같은 스레드에 `✅ … 다시 연결됐습니다`를 올리고 파일을 지웁니다. drain이 취소되거나 시간 초과로 풀리면 `↩️ … 재시작이 취소됐습니다`를 올립니다. 3시간 넘게 지난 파일은 알림 없이 버리고(`restart_notice_dropped`), drain 없이 재시작하면 알림이 없습니다. 알림은 장부에 남지 않는 최선 노력 게시입니다. config `restartNotice: false`로 끕니다.
- SIGTERM을 받으면 진행 중인 턴이 끝나기를 최대 20초 기다린 뒤 omp 자식을 내립니다. 그 사이 끝난 턴의 답은 기록되어 다음 기동에서 전달됩니다.
- 재시작 중 끊긴 턴(drain 없이 재시작했거나 프로세스가 죽은 경우)은 세션 기록으로 답을 복구하고, 복구할 수 없으면 "다시 보내 주세요" 알림을 한 번 보냅니다. 같은 요청을 자동으로 다시 실행하지는 않습니다. 전달 중이던 답은 재전송 머리말을 붙여 다시 보냅니다.

### 재시작 없이 설정 반영

`bun src/main.ts reload`나 `kill -HUP <데몬 pid>`를 보내면 실행 중인 데몬이 `config.json`을 다시 읽습니다. 결과는 `config_reloaded changed=… restart_required=… cli=…` 한 줄로 CLI 출력과 로그에 남습니다.

- **바로 반영(`changed`)**: `mentionFreeChannels`, `logChannel`, `escalationChannel`, `skillReviewTurns`, `dispatchHosts`, `herdrBoard`, `restartNotice`, `recallEnabled`. 다음 메시지·승인 카드·답·스윕부터 새 값을 씁니다. `dispatchHosts`·`herdrBoard`는 이미 떠 있는 omp 자식의 도구에는 들어가지 않고 다음에 뜨는 자식부터 적용됩니다(스윕 알림의 보드 링크는 바로 반영).
- **재시작 필요(`restart_required`)**: `ownerSlackUserId`, `slack`, `ompExecutable`, `workspaceDir`, `model`, `thinking`, `idleTimeoutMinutes`, `watcherRoots`, `webhook`, `agent`, `claudeExecutable`, `herdr`(도구 스키마와 `[TASK]` 스윕을 시작 때 정함), `offsite`(데몬은 `offsite_age` 게이트를 둘지 판단하는 데만 읽고, 복제는 CLI가 실행할 때마다 config를 다시 읽습니다). 바뀐 것을 알려 주기만 하고 적용하지 않습니다.
- **CLI 전용(`cli`)**: `sessionRetentionDays`, `maxBundleBytes`는 `gc`·`backup`이 실행할 때마다 직접 읽으므로 데몬과 무관합니다.
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

`ompbot gates`는 다음을 읽기 전용으로 판정하고 하나라도 열리면 exit 1입니다(자동화가 "건강"으로 오판하지 못하게 하는 fail-closed 계약).

| 게이트 | 열리는 조건 |
| --- | --- |
| `backup_age` | 백업 성공 도장이 없거나 36시간 넘음 |
| `offsite_age` | config에 `offsite`가 있을 때만 존재. `backups/offsite.ok`가 없거나 36시간 넘음(오프사이트 복제가 멈춤). 도장 나이만 보므로 원격에 이미 있는 옛 백업을 다시 확인(`present`)해도 갱신됩니다 — 올라간 데이터의 나이는 `backup_age`가 봅니다 |
| `sweep_stalled` | 스윕 하트비트가 3회 스윕(기본 45초) 넘게 갱신 안 됨 — 이벤트 루프가 막혔거나 스윕 체인이 죽음 |
| `inbound_starved` | omp 이벤트 없이 10분 넘은 dispatched 턴(오래 걸려도 이벤트가 이어지면 닫힘, 만료 전 승인 카드(`expires_at`이 지나지 않은 pending)를 기다리는 대화면 제외) |
| `origin_silent` | omp에 넘어가지 못한 채 `pending`으로 15분 넘은 오너 메시지. 이벤트가 이어지는 턴 뒤에 줄 선 메시지·만료 전 승인 카드를 기다리는 대화·drain 중에는 닫힘. 열리면 다른 게이트처럼 `🚨 [자가진단]` DM이 갑니다 |
| `deliveries_overdue` | 다음 전송 시각이 10분 넘게 지난 pending·inflight 배달(멈춘 `failed_ambiguous`는 제외) |
| `lanes_stuck` | 마지막 레인 활동(생성·진행 보고·오너 답글·완료 주장·재개 등 history 항목)이 24시간 넘은 working 레인 중 실행 중인 턴(그 24시간 안에 dispatched된 레인 대화 메시지 — 그보다 먼저 시작해 이벤트만 내는 턴은 치지 않음)도 만료 전 승인 카드(`expires_at`이 지나지 않은 pending)도 없는 고아 레인. 15분마다 상태 메시지를 다시 그리는 것은 활동으로 치지 않습니다. detail은 `working_old=<고아> running=<실행 중> approval_wait=<승인 대기>`이고 실행 중·승인 대기는 게이트를 열지 않습니다 |
| `slack_disconnected` | Slack 소켓이 10분 넘게 끊겨 있음(더 짧은 끊김은 스스로 다시 연결됩니다) |
| `frozen` | `~/.ompbot/FROZEN`이 있음(`ompbot freeze` 상태). detail은 `since=… reason=…` |
| `omp_runtime` | `ompExecutable`이 단독 실행 파일이거나 없음, 또는 PATH의 bun이 omp `engines.bun`을 만족하지 못함 — 새 omp 세션이 뜨지 않는 상태. `agent: omp`이고 `config.json`이 있을 때만 판정 |
| `monitors_stalled` | 켜진 모니터의 다음 발사 시각이 15분 넘게 지났음 — 모니터 틱이 발사하지 못하는 상태. drain 중이거나 하트비트가 구버전 데몬의 것이면 닫힘 |
| `monitors_failed` | 최근 24시간 켜진 모니터의 `failed_no_retry` |
| `turns_failing` | 최근 1시간 `[turn failed]` 알림 3건 이상 |
| `ledger_unreadable` | `ompbot.db`를 읽을 수 없음(테이블 없음·손상). 이때는 DB 게이트 대신 이 게이트 하나가 열립니다 |

- 데몬은 매 스윕(기본 15초)마다 `~/.ompbot/sweep-heartbeat`을 원자적으로 갱신하고, `monitorEventLoopDelay`로 잰 최대 루프 지연을 함께 기록합니다(5초 초과 시 `event_loop_blocked` 경고).
- **게이트 알림**: 데몬이 5분마다 스스로 게이트를 산정해 닫힘→열림 전이를 오너 DM으로 알립니다(`🚨 [자가진단]`). 같은 게이트는 24시간 안에는 조용하고, 계속 열려 있으면 하루마다 다시 알립니다. 알림이 나갔던 게이트가 닫히면 `✅` 회복 알림을 보내며, `slack_disconnected`와 `monitors_stalled`도 마찬가지입니다. 시간 창이 지나 닫히는 `turns_failing`·`monitors_failed`는 회복 알림이 없습니다. `/status-ompbot`·`ompbot status` 마지막 줄에 열린 게이트 요약이 나옵니다.
- **연속 실패**: 한 대화에서 턴이 3번 연속 실패하면 오너 DM으로 `🚨 [자가보고] … N번 연속 실패`를 한 번 보냅니다(같은 사인 24시간 억제, 성공 1턴으로 해소). 실패 사인이 모델 소멸이면 살아 있는 omp 자식의 모델을 바로 고칩니다.
- **세션 복원 모델 실패 자동 치유**: 세션 파일에 남은 활성 모델이 브로커에서 사라져 세션 복원이 `Could not restore model`로 실패하면(2026-10-27 사고), 대화의 모델 설정(모니터 핀 → 오리진 → 스레드 상속 → `defaultModel`)으로 세션 파일의 마지막 `model_change`를 교정하고 같은 메시지로 턴을 1회 다시 시작합니다. 교정 직전 원본은 `~/.ompbot/session-backups/<대화>/<UTC 타임스탬프>.jsonl`에 남고, 폴백이 없거나 이미 폴백 모델이면 파일을 건드리지 않고 기존 실패 경로가 돕니다.
- **세션 이어받기 검증**: omp 자식이 세션을 열 때 이어받을 파일(`/resume-ompbot` 핀, 없으면 시작 전 에포크 디렉터리의 최신 `*.jsonl`)과 자식이 보고한 실제 파일이 다르면 `session_resume_mismatch`(warn, `expected`·`actual`)를 남기고 그 스레드에 `⚠️ 이전 세션을 잇지 못하고…`(파일 이름만)를 대화·에포크당 한 번 올립니다(재시작 복구 경로는 로그만). 턴은 막지 않고, 둘 중 하나를 모르면(빈 디렉터리, 파일을 보고하지 않는 claude) 판정하지 않습니다.
- **멈춘 대기 메시지**: 디스패치에 실패해 `pending`에 남은 메시지는 그 대화가 쉬고 있으면 스윕이 1분마다 다시 디스패치합니다. 3번 연속 그대로면 오너 DM으로 `🚨 [자가보고] <대화>의 메시지를 N분째 보내지 못하고 있습니다`를 한 번 보내고(24시간 억제), 메시지가 빠지면 인시던트를 해소합니다.
- **멈춤 알림**: 진행 중인 턴에서 omp 이벤트가 2분 넘게 없으면 첫 번째만 `stall_alert`(warn)를 남기고 상태 메시지에 표시합니다. 호스트 도구(승인 대기 등)가 도는 동안은 판정하지 않고, 도구가 끝난 시각부터 다시 잽니다. 실측(2026-10-30 DM 턴, 침묵 → 10분 도구 타임아웃 때 이벤트 1건 → 3분 뒤 다시 침묵을 5번)처럼 같은 턴이 되풀이해 멈추면 합칩니다.
  - 같은 턴의 두 번째부터는 `stall_repeat`(info, `count`·`totalSilentMs`)만 남기고, 상태 표시는 깜빡이지 않고 첫 멈춤 표시를 유지합니다. 표시는 마지막 멈춤이 끝난 뒤 5분(`STALL_RELEASE_MS`, 되풀이 사이 간격 3분보다 길다) 동안 다시 멈추지 않을 때 `stall_released`와 함께 풀립니다.
  - **대화 오리진(DM·채널·스레드)**: 한 턴의 멈춤이 3회(`STALL_NOTIFY_COUNT`)이거나 누적 침묵이 30분(`STALL_NOTIFY_MS`)이면 `stall_escalated` 로그와 함께 오너 DM `⚠️ [자가보고] … 응답 없이 N분째`를 턴당 한 번 보냅니다. 턴을 자동으로 끊지 않습니다. 끊으려면 `/new-ompbot`을 보냅니다.
  - **모니터 오리진(`monitor/…`)**: 무인 실행이라 누적 침묵이 20분(`MONITOR_STALL_ABORT_MS`)이면 omp 턴을 abort하고 그 모니터 이벤트를 `failed`(재시도·최종 알림은 기존 규칙)로 남기며 오너 DM `🚨 [자가보고] … 중단했습니다`를 한 번 보냅니다. 자식은 멈춘 상태였으므로 함께 종료하고 다음 발사가 새 세션으로 시작합니다.
  - 임계값은 `MailboxDeps`(`stallReleaseMs`·`stallNotifyCount`·`stallNotifyMs`·`monitorStallAbortMs`)로 주입할 수 있습니다. 데몬 재시작 뒤에는 카운터가 0부터이므로 같은 턴 알림이 한 번 더 갈 수 있습니다.
- **모델 공급자 한도**: 모델 공급자 한도(429·rate limit·usage limit)가 omp 재시도 이벤트(`auto_retry_start`, `auto_retry_end`)로 감지되면 오너 DM으로 `⚠️ 모델 공급자 한도 소진(<origin>): <오류 요약> — omp가 재시도·폴백 중…`를 24시간에 1회 보냅니다(모니터 턴 포함). 폴백 적용은 로그 `retry_fallback_applied`로 남습니다.

### 백업

`ompbot backup`은 라이브 DB를 `VACUUM INTO`로 단일 파일 사본(`~/.ompbot/backups/ompbot-YYYYMMDD-HHMMSS.db`)으로 만들고 `quick_check`가 `ok`일 때만 정식 이름으로 옮깁니다. 데몬이 꺼져 있어도 동작합니다.

- 검증을 통과하면 세션 원본·설정·페르소나·수집기 스크립트를 묶은 번들(`ompbot-bundle-같은타임스탬프.tar.gz`, `sessions/`+`config.json`+`workspace/`+`scripts/` 중 존재하는 것, 기본 512MB 상한)도 함께 남깁니다. 번들 만들기나 검증이 실패하면 백업 전체가 실패합니다. `~/.ompbot/secrets/`는 번들에 절대 들어가지 않습니다. `workspaceDir`을 홈 밖으로 바꾼 설치는 그 폴더가 번들에 들어가지 않습니다.
- 번들 복구(db는 기존 `ompbot restore`): `systemctl --user stop ompbot && tar -xzf ~/.ompbot/backups/ompbot-bundle-<타임스탬프>.tar.gz -C ~/.ompbot workspace scripts && systemctl --user start ompbot` 이 변경 전에 만든 번들에는 `workspace`·`scripts`가 없어 tar가 `Not found in archive`로 실패합니다(그때는 더 최근 번들을 쓰세요).
- 성공 도장(`backups/last-backup.ok`)은 성공의 맨 끝에만 갱신되고 `bundle=`·`bundle_sha256=`까지 기록합니다.
- 보존은 타임스탬프 이름 일일 파일(.db와 번들 같은 정책, 최신 `--keep`(기본 14)개)이고, `ompbot-pre-upgrade-*.db` 같은 수동 사본은 대상 밖입니다.
- 매일 자동 실행은 [`packaging/ompbot-backup.service`](packaging/ompbot-backup.service)·[.timer](packaging/ompbot-backup.timer)(매일 04:30, `Persistent=true`)입니다. [서비스 등록](#7-서비스-등록)의 `units render`가 이미 써 두었으므로 타이머만 켭니다:

  ```sh
  bun src/main.ts units render   # 아직 안 했으면
  systemctl --user daemon-reload
  systemctl --user enable --now ompbot-backup.timer
  ```

- **오프사이트 복제**: config에 `offsite`가 있으면 `ompbot backup`이 로컬 백업이 성공한 뒤 가장 최근 스냅샷·번들을 `ssh -o BatchMode=yes`(키 인증만)로 `remoteDir`(0700)에 올립니다. 순서는 `<이름>.part`로 `scp -B -p` → 원격 `sha256sum`이 로컬 도장의 sha와 같을 때만 정식 이름으로 `mv` → 원격 보존 정리(엄격한 일일 이름 패턴만, 종류별 최신 `keep`개; `.part`·수동 사본·낯선 파일은 건드리지 않음) → 로컬 `backups/offsite.ok`(`ts= file= sha256= bundle= bundle_sha256= ssh= dir=`)를 맨 끝에 원자적으로 기록합니다. sha가 다르면 `.part`를 지우고 이름을 바꾸지 않으며 도장도 갱신하지 않습니다. 원격에 이미 같은 내용이 있으면 다시 올리지 않습니다.
  - 오프사이트가 실패해도 로컬 백업과 `last-backup.ok`는 그대로이고, `offsite failed: <코드>: <사유>`를 stderr에 쓰고 종료 코드 4로 끝납니다(로컬 백업 실패는 1). 코드: `ssh_failed`, `copy_failed`, `sha_mismatch`, `no_local_backup`, `stamp_failed`.
  - 단독 재시도: `bun src/main.ts offsite [--json]`(config에 `offsite`가 없으면 2). 성공 줄은 `offsite uploaded|present file=… sha256=…`과 `offsite_done files=… removed=… stamp=…`입니다.
  - `offsite.ok`가 36시간 넘으면 `offsite_age` 게이트가 열립니다([건강 게이트](#건강-게이트와-자가-보고)). 받는 쪽 호스트에 `sha256sum`·`mkdir`·`mv`·`ls`·`rm`이 있어야 하고 ssh 키가 미리 등록돼 있어야 합니다(`ssh -o BatchMode=yes <ssh> true`로 확인).
- 보존 기간이 지난 세션을 매일 정리하는 `ompbot gc`도 같은 방식으로 등록합니다([`packaging/ompbot-gc.service`](packaging/ompbot-gc.service)·[.timer](packaging/ompbot-gc.timer), 매일 04:45, 백업이 끝난 뒤 실행). 경로는 `units render`가 채웁니다:

  ```sh
  bun src/main.ts units render   # 아직 안 했으면
  systemctl --user daemon-reload
  systemctl --user enable --now ompbot-gc.timer
  ```

- **복구** — `ompbot restore <백업 db 경로> [--yes]`. 데몬을 먼저 멈춥니다(`systemctl --user stop ompbot`). 소켓에 응답하는 데몬이 있거나 `ompbot.lock`을 쥔 프로세스가 있으면 거부합니다(종료 코드 1). 원본 옆에 `-wal`이 있으면 거부합니다(종료 코드 2). 원본은 `~/.ompbot/backups/` 안의 `ompbot-YYYYMMDD-HHMMSS.db`(이름만 줘도 됨)이거나 절대경로 파일입니다(그 밖은 종료 코드 2). 순서: 임시 사본 → `PRAGMA quick_check`=`ok` → 현재 `ompbot.db`와 `-wal`/`-shm`을 `backups/pre-restore-<stamp>/`로 이동 → rename으로 교체 → fsync. 교체 중 실패하면 이동한 파일을 원위치로 돌려놓습니다. `--yes`가 없으면 무엇을 할지만 출력하고 종료 코드 3으로 끝납니다. 세션·설정 번들은 자동으로 풀지 않으므로, 같은 타임스탬프의 번들이 있으면 `tar -xzf ~/.ompbot/backups/ompbot-bundle-YYYYMMDD-HHMMSS.tar.gz -C ~/.ompbot sessions config.json`(원본을 덮어씁니다)으로 복구한 뒤 데몬을 다시 시작하세요. 백업이 최신 스키마라면 구버전 바이너리로는 열지 못합니다.

### 스킬 리뷰

데몬이 뜬 뒤 스윕이 오너 DM을 처음 볼 때의 답한 턴 수를 기준선으로 삼고, 그 뒤 답한 턴이 `skillReviewTurns`(기본 10, 0이면 끔)만큼 쌓일 때마다 별도 omp 자식이 최근 대화 24개를 읽고 재사용할 만한 스킬을 제안합니다(재시작하면 기준선을 다시 잡습니다). 동결 중에 차례가 오면 리뷰를 돌리지 않고 `skill_review_skipped_frozen`만 남기며, 그 차례는 미뤄지지 않고 다음 `skillReviewTurns`턴 뒤에 다시 판단합니다.

- 제안은 `~/.ompbot/skills-pending/`에 0600으로 저장되고, 승인 버튼을 눌러야만 `~/.omp/agent/skills/<이름>/SKILL.md`로 설치됩니다(거부·무응답이면 설치 안 함).
- 덮어쓰기 설치는 먼저 직전 내용을 `<스킬>/revisions/<타임스탬프>.md`로 보존하고, `ompbot skills rollback <이름>` 한 번으로 되돌립니다(현재 내용은 개정 슬롯에 남아 다시 되돌릴 수도 있습니다).
- 리뷰 1회는 모델 토큰을 소모합니다.

## 보안 메모

- 오너가 아닌 사용자의 메시지, 슬래시 명령, 버튼 클릭, 파일은 모두 무시하거나 "권한 없음"으로 답합니다.
- 마스킹은 두 겹입니다. (1) 토큰 모양 형식 패턴(`xox*`, `xapp-`, `sk-*`, `gh*_`)은 항상 적용됩니다. (2) 데몬 기동 때 실제 비밀 값(Slack 토큰 파일, 비밀 이름의 환경 변수, `OMPBOT_SECRET_GUARD_FILES`의 콜론 구분 파일 — JSON은 비밀 이름 필드만)을 메모리에 색인해, 값의 16자 조각과 역순·hex·base64 변형까지 `[REDACTED]`로 바꿉니다. 로그·DB 저장·슬랙 전송 경로 전부에 적용되고 끄는 스위치는 없습니다. 색인은 기동 때만 다시 읽습니다.
- `slack_send_file`은 `~/.ompbot/secrets`, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.omp/agent`, `~/.gajaeway-hub`, `~/.git-credentials`, `~/.netrc`, `~/.config/gh` 아래 파일(링크는 실제 경로로 판정)과, 2MB 이하 파일 중 토큰 모양 내용이 든 파일을 올리지 않습니다. 2MB를 넘는 파일은 내용 검사 없이 50MB까지 올라갑니다.
- omp 자식 프로세스는 환경 변수에서 `SLACK_*`, `OMPBOT_*`를 지운 상태로 시작합니다. 시스템 프롬프트에는 위험 명령 금지 규칙과 `~/.ompbot/secrets` 읽기 금지가 붙습니다.
- 다만 omp는 ompbot과 같은 유닉스 사용자로 실행되므로, 토큰 파일 접근을 OS 권한으로 막지는 못합니다. 더 강하게 격리하려면 omp를 별도 사용자로 실행해야 합니다.
- omp 확장 `wiki-session-note`가 설치돼 있으면, 봇 세션에서는 `OMP_WIKI_NOTE_DISABLE=1`로 끕니다.

## 개발

```sh
bun test                                   # 단위 테스트
bun run check                              # biome + tsc
OMPBOT_E2E_OMP=1 bun test                  # 실제 omp를 띄우는 E2E 포함(모델 비용 발생)
```

## 라이선스

MIT
