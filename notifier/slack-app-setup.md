# Slack 앱 설정

알림 서버용 Slack 앱을 만들어 `SYMPHONY_SLACK_BOT_TOKEN`(Bot 토큰, `xoxb-...`)과 `SYMPHONY_SLACK_CHANNEL`(채널 또는 DM 대화 ID)을 확보한다. `SYMPHONY_SLACK_USER_ID`(멘션 대상, `U...` 또는 Enterprise Grid의 `W...`)는 앱과 무관하게 Slack 프로필의 **Copy member ID**로 얻는다. `users.list`로도 조회할 수 있으나 `users:read` 스코프가 추가로 필요하다. 설정 주입과 실행은 [README](README.md)의 설정, 운영 절을 따른다.

에이전트가 Slack Web API로 진행한다. 앱 생성은 `apps.manifest.create`, 토큰 교환은 `oauth.v2.access`, 공개 채널 처리는 `conversations.list`와 `conversations.join`이다.

## 사람이 해야 하는 두 가지

Slack 보안 모델상 우회할 수 없어 사람이 웹 UI에서 처리한다. 나머지는 에이전트가 API로 끝낸다.

1. **App Configuration Token 발급**: https://api.slack.com/apps 하단 **Your App Configuration Tokens** → **Generate Token** → 워크스페이스 선택 → Access Token(`xoxe.xoxp-...`)을 에이전트에게 전달한다. 앱 생성 호출에만 쓰이며 12시간 후 만료되므로 만료됐으면 다시 발급한다. 함께 표시되는 Refresh Token(`xoxe-1-...`)은 이 절차에 필요 없다.
2. **설치 승인**: 에이전트가 제시한 `oauth_authorize_url`을 브라우저에서 열고 **Allow** 클릭. `https://localhost/oauth?code=...`로 리디렉션되며 연결 실패 페이지가 뜨는 것이 정상이다. 주소창의 URL 전체를 에이전트에게 전달한다. `code`는 10분 후 만료된다.

## 앱 정의

```json
{
  "display_information": { "name": "Symphony" },
  "features": { "bot_user": { "display_name": "symphony" } },
  "oauth_config": {
    "redirect_urls": ["https://localhost/oauth"],
    "scopes": { "bot": ["chat:write", "channels:read", "channels:join"] }
  }
}
```

- 런타임에 필요한 스코프는 `chat:write`뿐이다. 사용자 멘션은 ID를 텍스트에 넣는 것이므로 추가 스코프가 없다. `channels:read`(채널 ID 조회)와 `channels:join`(봇 채널 참여)은 공개 채널 설치 단계를 API로 처리하기 위해 넣는다.
- 표시명은 Slack 앱 설정에만 있는 값이라 코드와 무관하다. 이미 발급받아 쓰고 있는 앱이 있으면 표시명을 바꾸지 않는다 — 기존 스레드의 발신자 표기만 바뀌고 얻는 것이 없다. 그래도 바꿔야 하면 [앱 이름과 아이콘 변경](#앱-이름과-아이콘-변경)을 따른다.
- `redirect_urls`는 HTTPS만 허용된다. `https://localhost`는 어디에도 코드를 전송하지 않기 위한 값이며 수신 서버가 필요 없다.

## 앱 이름과 아이콘 변경

이미 만든 앱의 표시명과 아이콘을 바꾸는 절차다. 스코프를 건드리지 않으므로 재설치도 `xoxb-` 토큰 재발급도 없다. 표시명과 아이콘은 앱 프로필 값이라 코드와 무관하고, 바꾸면 기존 스레드의 표기에도 반영된다.

`xoxb-` 봇 토큰으로는 둘 다 바꿀 수 없다. 봇 토큰은 설치된 앱이 워크스페이스에 대고 하는 일(`chat.postMessage` 등)의 자격증명이지 앱 설정을 고치는 자격증명이 아니다. `chat.postMessage`의 `username`과 `icon_url` 오버라이드(`chat:write.customize` 스코프)는 메시지마다 표기를 갈아끼우는 것이라 앱 자체는 그대로고, 아이콘을 공개 URL에 호스팅해야 해서 쓰지 않는다.

아이콘 원본은 [`assets/icon.svg`](assets/icon.svg), 업로드용 렌더는 [`assets/icon.png`](assets/icon.png)다. OpenAI 블라썸 마크를 흰 배경(`#FFFFFF`)에 검정(`#000000`)으로 512x512 정사각에 배치했고 사방 여백은 변의 13%다. 512는 Slack이 요구하는 아이콘 하한이자 공식 CLI가 업로드 직전 정사각으로 리사이즈하는 크기다. SVG가 원본이므로 여백이나 크기를 바꾸려면 SVG의 `transform`을 고쳐 다시 렌더한다.

### 이름: `apps.manifest.update`

App Configuration Token(`xoxe.xoxp-...`)만 있으면 끝난다. 발급은 [사람이 해야 하는 두 가지](#사람이-해야-하는-두-가지)와 같다. manifest는 부분 갱신이 아니라 전체 교체이므로 export한 것을 고쳐서 되돌려준다.

```sh
CONFIG_TOKEN=xoxe.xoxp-...
APP_ID=A0123456789

curl -sS https://slack.com/api/apps.manifest.export \
  -H "Authorization: Bearer $CONFIG_TOKEN" \
  -d "app_id=$APP_ID" | jq .manifest > manifest.json

# manifest.json의 display_information.name과 features.bot_user.display_name을 고친다

curl -sS https://slack.com/api/apps.manifest.update \
  -H "Authorization: Bearer $CONFIG_TOKEN" \
  --data-urlencode "app_id=$APP_ID" \
  --data-urlencode "manifest=$(cat manifest.json)" | jq
```

응답의 `permissions_updated`가 `true`면 스코프가 함께 바뀐 것이라 재설치가 필요하다. 이름만 고쳤다면 `false`여야 한다.

### 아이콘: `apps.icon.set`

아이콘은 manifest 필드가 아니라서 `apps.manifest.update`로 바뀌지 않고, 공개된 Web API 메서드 목록에도 아이콘 설정 메서드가 없다. 공식 CLI가 실제로 호출하는 것은 문서화되지 않은 `apps.icon.set`이다 ([`slackapi/slack-cli`](https://github.com/slackapi/slack-cli)의 `internal/api/icon.go`). multipart로 `file`과 `app_id`를 보내고 토큰은 Bearer 헤더에 싣는다.

```sh
curl -sS https://slack.com/api/apps.icon.set \
  -H "Authorization: Bearer $CONFIG_TOKEN" \
  -F "app_id=$APP_ID" \
  -F "file=@assets/icon.png;type=image/png" | jq
```

문서화되지 않은 메서드이므로 App Configuration Token을 받아준다는 보장이 없다. `{"ok": true}`가 아니면 아래 두 경로로 내려간다.

### 대안 1: 공식 CLI

CLI는 `apps.icon.set`을 자기 로그인 토큰으로 호출한다. 아이콘 업로드는 2026년 8월 `set-icon` 실험이 종료되면서 Slack 호스팅이 아닌 앱에도 기본 지원된다.

```sh
slack login                                                    # ~/.slack/credentials.json에 토큰 저장
slack app link --team T0123456789 --app "$APP_ID" --environment deployed
slack install                                                  # notifier/에서 실행하면 assets/icon.png를 자동 인식
```

CLI는 `SLACK_CLI_APP_ICON_PATH` → manifest의 `icon` 필드 → `assets/` 다음 프로젝트 루트의 `icon.{png,jpg,jpeg,gif}` 순으로 파일을 찾는다. `notifier/`의 배치가 세 번째 규칙에 그대로 맞는다.

`slack install`은 아이콘을 올리기 전에 앱을 재설치한다. 재설치는 `xoxb-` 토큰을 재발급할 수 있으므로 이 경로를 쓴 뒤에는 `~/.config/symphony/env`의 `SYMPHONY_SLACK_BOT_TOKEN`이 여전히 유효한지 확인한다. curl 직접 호출을 먼저 시도하는 이유가 이것이다.

### 대안 2: 웹 UI

https://api.slack.com/apps 에서 앱 선택 → **Basic Information** → **Display Information**. 같은 화면에서 **App name**과 **App icon**을 모두 바꾸고 **Save Changes**를 누른다. 토큰이 필요 없고 재설치도 일어나지 않는다.

## 함정

- `apps.manifest.create` 응답의 `credentials.client_id`와 `client_secret`은 `oauth.v2.access` 토큰 교환에 필요하므로 응답을 버리지 말고 보관한다. 잃어버리면 웹 UI의 **Basic Information**에서 다시 확인한다.
- `apps.manifest.create`가 `internal_error`를 반환하면 같은 manifest를 `apps.manifest.validate`로 검증해 `errors` 배열에서 원인을 확인한다. 검증을 통과하는데도 실패하면 https://api.slack.com/apps 에서 같은 이름의 앱이 이미 있는지 확인한다. 이름 충돌이 `internal_error`로 나타난다. 재시도는 rate limit(Tier 1, 분당 1회 수준)을 고려해 1분 이상 간격을 둔다.
- 비공개 채널은 `conversations.join`이 불가하므로 사람이 그 채널에서 `/invite @<봇 표시명>`으로 초대한다. 봇이 채널에 없는 상태로 게시하면 `not_in_channel` 오류가 난다. 비공개 채널 ID는 `channels:read`의 `conversations.list`로 조회되지 않으므로(`groups:read` 필요) Slack UI의 채널 세부정보 하단에서 복사한다.
- DM은 앱의 봇이 참여하는 대화여야 한다. 두 사용자 사이의 DM에는 봇이 게시할 수 없다. 앱과의 DM을 연 뒤 Slack URL의 `/archives/D...` 부분에서 `D`로 시작하는 대화 ID를 복사한다.
- 설치 후 스코프를 추가하면 앱을 재설치해야 하고, 재설치 시 토큰이 재발급될 수 있다.

## 검증

`~/.config/symphony/env`에 README 설정 표의 네 값을 기입하고, `notifier/`에서 `pnpm install`을 마친 뒤 `symphonyctl notifier start`로 실행한다. `SYMPHONY_NOTIFY_URL`로 `started` 이벤트를 보내 대상 대화에 본문 메시지가 게시되는지 확인한다 (페이로드 형식은 README의 이벤트 인터페이스). 실패하면 `pm2 logs symphony:notifier`에서 Slack 오류(`invalid_auth`, `not_in_channel` 등)를 확인한다.

## 배경: 도구 선택

### Bolt 프레임워크를 쓰지 않는 이유

Bolt는 Slack → 앱 방향(이벤트 수신, slash command, 인터랙션, 서명 검증)의 인프라다. 알림 서버의 Slack 방향은 앱 → Slack 단방향(`chat.postMessage`)뿐이고, HTTP 수신은 Slack이 아니라 오케스트레이터에게서 받는다. Bolt도 아웃바운드 호출에는 `@slack/web-api`의 `WebClient`를 쓰므로 하위 계층을 직접 쓰는 현재 구성에 기능 손실이 없다. 인터랙션(버튼, slash command)이 필요해지면 Bolt를 검토한다.

### 공식 Slack CLI를 쓰지 않는 이유

공식 Slack CLI(`slack` 명령)는 앱 라이프사이클 관리 도구이지 토큰 발급 도구가 아니다. `slack run`은 CLI가 관리하는 개발 세션에만 임시 토큰을 주입하고, `slack deploy`로 배포한 앱은 웹 UI에서 잠겨 `xoxb-` 토큰을 발급받을 수 없다. Web API 직접 호출이 상시 실행 데몬용 독립 토큰을 얻는 최소 경로다.

아이콘 설정은 예외다. Web API에 공개된 메서드가 없어 CLI가 유일하게 지원되는 자동화 경로이므로 [앱 이름과 아이콘 변경](#앱-이름과-아이콘-변경)에서 대안으로 둔다. CLI는 `slack login`으로 얻는 자체 토큰을 쓰므로 이 문서의 App Configuration Token과 별개이고, 알림 서버가 쓰는 `xoxb-` 토큰과도 무관하다.

### 호스팅 방식 비교: 자체 서버 vs Slack 호스팅

알림 서버는 자체 서버(오케스트레이터와 같은 머신, PM2) 방식으로 운영한다. 대안인 Slack 호스팅(Run on Slack, Deno Slack SDK)은 Slack CLI가 유일한 생성·배포·관리 도구가 된다 (웹 UI는 workflow 앱 설정을 지원하지 않는다). 두 방식은 호스팅 위치만이 아니라 아키텍처 전체가 다르다.

| 관점 | 자체 서버 (현재) | Slack 호스팅 (Run on Slack) |
| --- | --- | --- |
| 스택 | Node + Hono + `@slack/web-api`, 임의 코드 | Deno Slack SDK의 workflow 앱으로 재작성 필요 |
| 수신 경로 | `127.0.0.1` HTTP POST. loopback 바인딩이 보안 경계 | Slack이 발급하는 webhook trigger URL (공개 인터넷). 비밀 URL이 보안 경계 |
| 토큰, 설정 | `xoxb-` 발급 절차(이 문서), env 파일, PM2 관리 필요 | 플랫폼이 app identity 관리. 토큰, env, 프로세스 관리 전부 불필요 |
| 스레드 매핑 | 로컬 JSON 파일로 영속화, 항목 수 상한 500 | 상시 프로세스가 없어 Datastore 저장 필수 |
| 순서 보장 | 키별 promise chain으로 직렬화 | 실행 단위가 무상태·병렬이라 datastore 수준에서 다시 설계 필요 |
| 실행 제약 | 머신 자원 내 자유 | 유료 플랜 필수, custom function 실행 시간 제한 등 서버리스 제약 |
| 운영 | PM2 재시작, 로그, 머신 장애가 우리 책임 | 인프라 운영 부담 없음. 대신 디버깅·관측 수단이 플랫폼에 종속 |

현재 요구사항(오케스트레이터와 같은 머신, 얇은 전달 계층, 유실 허용)에는 자체 서버가 맞다. 여러 머신의 이벤트를 받게 되어 loopback 경계를 어차피 포기해야 할 때 Slack 호스팅을 다시 검토한다. 그 시점에는 토큰 관리 소멸을 얻는 대신 이 코드베이스와 loopback 보안 모델을 포기하게 된다.
