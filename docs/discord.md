# Discord 봇 만들기

ompbot을 Discord에서도 쓰려면 Discord 봇이 하나 필요합니다. Slack처럼 붙여넣을 매니페스트는 Discord에 없습니다. 대신 아래 순서대로 Developer Portal에서 설정하고, 고정된 초대 URL로 서버에 넣습니다. 슬래시 명령은 Portal에서 만들지 않습니다. ompbot이 기동할 때 스스로 등록합니다(초대 URL에 `applications.commands`를 넣는 이유입니다).

진행 상태: 대화 연결(DM·서버 채널·스레드, `!`·슬래시 명령, 👀·진행 표시, 2000자 분할, `!shutup` 뮤트, 승인·질문·TASK 카드 버튼, 카드(embed)·파일 첨부·👍/👎 피드백, 재시작 중 놓친 메시지 복구, `doctor` 점검)과 운영 기능(DM 모니터, 서버 채널 스레드의 작업 레인과 그 버튼, `inject --origin discord/…`)이 들어 있어 5절의 `channels.discord` 설정을 넣으면 켜집니다. 데몬 수준 알림(게이트·한도·재시작)은 계속 Slack 오너 DM으로 갑니다.

## 요약 (이것만 맞으면 됩니다)

| 항목 | 값 |
|---|---|
| Application | 새로 하나 (이름 자유, 예: `ompbot`) |
| Installation → Install Link | **None** (Public Bot을 끄기 전에 먼저) |
| Installation → Installation Contexts | Guild Install만 (User Install 끔) |
| Bot → Public Bot | 끔 |
| Bot → Requires OAuth2 Code Grant | 끔 |
| Privileged Gateway Intents | **Message Content Intent만 켬** (Presence·Server Members는 끔) |
| OAuth2 scope | `bot`, `applications.commands` |
| 봇 권한(정수) | `309237763136` |
| 토큰 파일 | `~/.ompbot/secrets/discord-bot-token` (0600) |

권한 정수 `309237763136`은 아래 8개의 합입니다: View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History, Add Reactions, Embed Links, Attach Files. 관리자 권한이나 메시지 삭제·멤버 관리 권한은 넣지 않습니다.

## 1. Application과 봇 만들기

1. https://discord.com/developers/applications 에 오너 계정으로 로그인하고 **New Application**을 누릅니다. 이름을 넣고 약관에 동의합니다.
2. **General Information**에서 **Application ID**를 복사해 둡니다(18~19자리 숫자). 5절의 `applicationId`와 3절의 초대 URL에 씁니다. 원하면 여기서 앱 아이콘도 바꿉니다.
3. 왼쪽 **Installation** 탭에서 먼저 정리합니다. 이걸 안 하면 다음 단계에서 Public Bot을 끌 때 "비공개 애플리케이션은 기본 승인 링크를 가질 수 없어요"(Private application cannot have a default authorization link) 오류가 나고 저장되지 않습니다.
   - **Install Link**를 `Discord Provided Link`에서 **None**으로 바꿉니다. 초대는 3절의 URL로 하므로 기본 링크가 필요 없습니다.
   - **Installation Contexts**에서 **User Install**을 끄고 **Guild Install**만 둡니다.
   - **Save Changes**를 누릅니다.
4. 왼쪽 **Bot** 탭으로 갑니다.
   - **Public Bot**을 끕니다. 오너만 이 봇을 서버에 넣을 수 있게 됩니다.
   - **Requires OAuth2 Code Grant**는 끈 채로 둡니다.
   - **Privileged Gateway Intents**에서 **Message Content Intent**를 켜고 **Save Changes**를 누릅니다. 이걸 끄면 서버 채널에서 멘션 없는 글(스레드 안 답장 등)의 본문을 받지 못하고, ompbot이 이 인텐트를 요청하므로 Gateway가 닫힘 코드 4014로 연결을 끊습니다. 서버 100개 미만의 봇은 심사 없이 켤 수 있습니다.
   - **Presence Intent**, **Server Members Intent**는 켜지 않습니다(쓰지 않습니다).
   - Username과 아이콘은 여기서 바꿉니다. Username은 소문자·숫자·`_`·`.`뿐이라 한글은 못 넣습니다. 메시지 위에 한글 봇 이름을 띄우려면 5절 설정의 `displayName`을 씁니다(기동 때 봇의 글로벌 표시 이름으로 반영되어 DM·별명 없는 서버에서 보입니다. 서버에서 지은 별명이 있으면 그 별명이 우선).

## 2. 봇 토큰을 파일로

토큰은 한 번만 보입니다. 채팅·메모·셸 기록에 붙여넣지 말고 바로 파일에 넣습니다.

1. **Bot** 탭에서 **Reset Token**을 누르고(2단계 인증이 켜져 있으면 코드 입력) 나온 토큰을 복사합니다.
2. ompbot이 도는 서버의 터미널에서:

```sh
umask 077
cat > ~/.ompbot/secrets/discord-bot-token
```

3. 토큰을 붙여넣고 Enter, 이어서 Ctrl-D를 누릅니다.
4. 권한을 확인합니다. `-rw-------`이어야 합니다.

```sh
ls -l ~/.ompbot/secrets/discord-bot-token
```

토큰이 노출됐다고 생각되면 Portal에서 **Reset Token**으로 새로 받아 같은 파일을 덮어쓰고 데몬을 재시작합니다. 이전 토큰은 즉시 무효가 됩니다.

## 3. 서버에 초대하기

봇과 DM을 하려면 오너와 봇이 같은 서버에 있어야 합니다. 그래서 DM만 쓸 때도 서버 하나에 넣습니다. 오너 혼자 있는 서버를 하나 만들어 쓰는 것을 권합니다(Discord 왼쪽 **+** → 직접 만들기 → 나와 친구들을 위한 서버).

아래 URL에서 `<APP_ID>`를 1절의 Application ID로 바꿔 브라우저에서 엽니다.

```
https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot+applications.commands&permissions=309237763136
```

서버를 고르고 권한 8개가 보이면 **승인**합니다. Portal의 **OAuth2 → URL Generator**에서 scope `bot`·`applications.commands`와 위 8개 권한을 체크해도 같은 URL이 만들어집니다.

## 4. 오너 ID와 서버 ID

1. Discord 앱 **사용자 설정 → 고급 → 개발자 모드**를 켭니다.
2. 내 프로필(이름)을 우클릭(휴대폰은 길게 누름) → **사용자 ID 복사**. 5절의 `ownerUserId`입니다. 이 사용자의 글만 명령으로 받습니다.
3. 서버 아이콘 우클릭 → **서버 ID 복사**. 5절의 `guildIds`에 넣으면 그 서버의 글만 받습니다(선택).
4. 멘션 없이 모든 글에 답할 채널이 있으면 채널 우클릭 → **채널 ID 복사**로 `mentionFreeChannels`에 넣습니다(선택).
5. DM에서 `작업: …`으로 작업 레인을 열려면 레인 스레드를 만들 서버 텍스트 채널의 ID를 같은 방법으로 복사해 `laneChannelId`에 넣습니다(선택). 봇에게 그 채널의 Create Public Threads·Send Messages in Threads 권한이 있어야 합니다.

## 5. ompbot 설정 (`channels.discord`)

Discord만 쓸 때는 홈을 만들 때 한 번에 넣습니다(Slack 설정 없이 Discord만으로 돕니다).

```sh
bun src/main.ts init --platform discord --owner <4절의 사용자 ID> --app-id <1절의 Application ID>
umask 077; cat > ~/.ompbot/secrets/discord-bot-token   # 2절의 봇 토큰 붙여넣고 Ctrl-D
```

Slack과 같이 쓰거나 서버·채널 키를 더할 때는 `~/.ompbot/config.json`의 `channels`에 직접 넣습니다. Slack을 쓰면 Slack 설정은 그대로 둡니다(`"slack"` 줄은 Discord만 쓰면 빼도 됩니다).

```json
{
  "channels": {
    "slack": { "ownerUserId": "U…" },
    "discord": {
      "ownerUserId": "<4절의 사용자 ID>",
      "botTokenFile": "secrets/discord-bot-token",
      "applicationId": "<1절의 Application ID>",
      "guildIds": ["<4절의 서버 ID>"],
      "mentionFreeChannels": [],
      "requireMention": false,
      "laneChannelId": "<4절 5단계의 채널 ID>",
      "logChannelId": "<#log로 쓸 서버 텍스트 채널 ID>",
      "escalationChannelId": "<승인 카드를 받을 서버 텍스트 채널 ID>",
      "displayName": "송박"
    }
  }
}
```

- `botTokenFile`은 ompbot 홈(`~/.ompbot`) 기준 상대경로입니다. 파일이 없으면 `secret_missing`, 권한이 0600이 아니면 `secret_permissions`로 기동하지 않습니다.
- `displayName`은 선택입니다. 넣으면 기동 때 봇의 글로벌 표시 이름을 이 값으로 바꿉니다(`PATCH /users/@me`, 1~32자). DM·별명 없는 서버의 메시지 위에 이 이름이 보입니다. 바꾸기가 실패하면 경고 로그만 남고 기동은 계속됩니다.
- `laneChannelId`는 선택입니다. 없으면 DM 세션에는 `ompbot_work_start`가 없고, DM의 `작업: …`에는 이 설정이 필요하다는 답이 옵니다. 서버 채널·스레드에서 요청한 레인은 설정 없이 그 채널에 열립니다.
- `logChannelId`는 선택입니다. 넣으면 Discord 대화와 Discord 스레드의 작업 레인 답 첫 줄이 `✅ 완료`로 시작할 때 그 답의 사본이 `📒 완료 보고 사본 · <요청 위치 + 원 스레드 링크>` 머리말과 함께 이 채널에 한 번 올라갑니다. Slack 대화의 사본은 지금처럼 Slack `logChannel`로만 갑니다. 이 채널과 그 스레드의 글은 멘션이 있어도 턴이 되지 않습니다(`inbound_dropped reason=log_channel`). `escalationChannelId`·`laneChannelId`·`mentionFreeChannels`와 같은 채널이면 `config_invalid field=channels.discord.logChannelId`로 기동하지 않습니다.
- `escalationChannelId`는 선택입니다. 넣으면 Discord 대화에서 올린 승인 카드가 이 채널에 뜹니다(Discord 오너 멘션, `요청 위치` 링크). 요청한 대화에 스레드가 있으면 그곳에 버튼 달린 사본 카드가 뜨고, 카드 스레드에 단 답글도 카드를 결정합니다. 없으면 지금처럼 요청한 대화에 카드가 뜹니다. Slack 요청은 Slack `escalationChannel`을 그대로 따릅니다.
- 두 채널 모두 봇이 보고 글을 쓸 수 있어야 합니다(View Channel·Send Messages). `channels`는 재시작 키라 두 값도 재시작해야 반영됩니다.
- `guildIds`·`mentionFreeChannels`·`requireMention`은 선택입니다. `guildIds`를 비우면 봇이 들어간 모든 서버의 글을 받습니다(오너 글만 처리하는 건 같습니다).
- 기존 `ownerSlackUserId` 키는 계속 읽히지만 경고가 납니다. `channels.slack.ownerUserId`로 옮기면 경고가 사라집니다.
- `channels`는 재시작이 필요한 키입니다. `reload`로는 반영되지 않습니다.

반영과 확인:

```sh
cd ~/work/ompbot
bun src/main.ts doctor          # ok discord … 줄이 나와야 함
bun src/main.ts apply --detach  # 재시작
```

## 6. 동작 확인

- 봇과의 DM에 아무 질문 → 👀 반응 → 진행 표시 → 답 → ✅.
- 질문을 보내자마자 "입력 중…" 표시가 뜨고, 첫 답이 오거나 턴이 끝나면(길어도 5분 30초 뒤) 꺼집니다.
- `!status`가 답합니다.
- 서버 채널에서 봇을 멘션 → 스레드가 생기고 답이 스레드에 옵니다. 같은 스레드에 멘션 없이 답해도 이어집니다.
- 봇 글에 Discord "답장"을 달면 멘션이 없어도 봇이 받고, 답장 대상 글의 앞부분을 참고합니다. 답장하면서 피어 봇만 멘션하면 피어 몫입니다.
- 서버 멤버 목록에서 봇이 온라인(초록불)으로 보입니다.
- 승인이 필요한 일을 시키면 버튼 카드가 오고, 누르면 결과 줄로 바뀝니다.
- 같은 시간에 Slack DM도 정상으로 답합니다.
- `/status-ompbot`이 나에게만 보이는 응답으로 답합니다.
- DM에서 `1분 뒤에 물 마시라고 알려줘` → 모니터가 등록되고(`모니터 목록 보여줘`에 보임) 1분 뒤 결과가 그 DM에 새 글로 옵니다.
- DM에서 `작업: 테스트 @/home/<user>/work/<repo>` → `laneChannelId` 채널에 `🔄 테스트` 루트와 레인 스레드가 생기고 DM에 그 스레드 링크가 옵니다. 스레드 안 ⏸ 버튼·`멈춰`·`계속`이 동작하고, 끝나면 머지·폐기 카드가 옵니다.
- `bun src/main.ts inject --origin discord/dm/<DM 채널 ID> --as-owner --text '안녕'` → DM에 `🧪 inject` 마커와 답이 옵니다.
- 데몬을 재시작하는 동안 DM을 보내 두면, 다시 뜬 뒤 그 DM에 답합니다.

## 7. 피어 봇(두 번째 ompbot)

Slack의 [피어 봇](guide.md#피어-봇)과 같은 규칙으로, 같은 서버의 다른 ompbot(예: 검토를 맡은 설치본)과 서로 멘션해 요청·답을 주고받을 수 있습니다. 선택 기능이며 오너 권한은 주지 않습니다.

1. 피어용 앱을 1~3절대로 **따로** 만들고 같은 서버에 초대합니다(봇마다 토큰과 Application이 다릅니다).
2. 두 봇의 사용자 ID를 4절 방법(봇 이름 우클릭 → ID 복사)으로 얻습니다.
3. 양쪽 홈의 `channels.discord`에 서로의 봇 사용자 ID를 넣습니다. 이 봇 설정에는 상대 봇을, 상대 설정에는 이 봇을 적습니다.

```json
"discord": {
  "…": "5절의 키들",
  "peerBots": [{ "userId": "<상대 봇 사용자 ID>", "name": "떡" }]
}
```

- `userId`는 snowflake(숫자 17~20자리)이고 오너 ID는 안 됩니다. `name`은 1~32자입니다. 프롬프트에 `이 대화의 피어 봇: 떡 = <@…>` 줄로 들어가 봇이 상대를 멘션할 수 있습니다.
- 서버 채널·스레드에서만 동작합니다. Discord DM은 1:1이라 피어 글을 받지 않습니다(`peer_dm`).
- 피어 글은 이 봇 멘션(`<@봇 ID>`·`<@!봇 ID>`)이 있어야 받습니다. `mentionFreeChannels`·`requireMention`과 무관하고, 뮤트한 스레드에서는 버립니다. 명령·첨부·승인 카드 답장으로 쓰이지 않습니다.
- 채널 최상위 피어 글은 받아들여진 뒤에만 스레드를 엽니다. 상한에 걸리거나 레인 스레드라 버린 글에는 스레드가 생기지 않습니다.
- 스레드당 왕복 상한은 최상위 `peerHopLimit`(기본 30분에 3번)을 Slack과 같이 씁니다. 넘으면 한 번만 "피어 대화 상한에 닿았습니다…" 안내가 붙습니다.
- 답에 든 피어 멘션은 알림이 갑니다(오너·`peerBots`만, @everyone·역할·그 밖의 사용자는 알림 없음).
- 재시작 중 놓친 피어 글은 백필이 피어 경로로 다시 받습니다.
- `channels`라서 바꾸면 재시작(`apply --detach`)이 필요합니다.

## 문제가 생기면

| 증상 | 원인과 조치 |
|---|---|
| 로그에 Gateway 닫힘 `4004` | 토큰이 틀렸거나 리셋됨. 2절로 새 토큰을 넣고 재시작 |
| 로그에 Gateway 닫힘 `4014` | Message Content Intent가 꺼져 있음. 1절 4단계 |
| DM을 보낼 수 없다고 나옴 | 봇과 같은 서버에 있지 않음. 3절 초대 |
| 서버 채널에서 반응 없음 | 봇을 멘션하지 않았거나, `guildIds`에 그 서버가 없거나, 채널 권한에서 봇의 View Channels가 막힘 |
| 스레드를 못 만듦 | 그 채널에서 봇의 Create Public Threads·Send Messages in Threads 권한이 꺼짐 |
| 작업 레인 루트가 `❌ 제목`으로 바뀜 | 레인 채널에서 스레드를 못 만듦(위와 같은 권한). 권한을 켜고 다시 요청 |
| DM `작업: …`에 `laneChannelId`가 필요하다는 답 | 5절에 `laneChannelId`를 넣고 재시작 |
| Public Bot을 끌 때 "기본 승인 링크" 오류 | Installation 탭 Install Link가 Discord Provided Link임. None으로 바꾸고 저장한 뒤 다시 끔(1절 3단계) |
| 슬래시 명령이 안 보임 | 초대 URL에 `applications.commands`가 빠짐(3절 URL로 다시 초대). `guildIds` 없이 전역 등록이면 퍼지는 데 시간이 걸릴 수 있음. 로그의 `discord_commands_register_failed` 확인 |
