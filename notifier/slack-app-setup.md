# Slack 앱 설정

알림 서버용 Slack 앱을 만들어 `SYMPHONY_SLACK_BOT_TOKEN`(Bot 토큰, `xoxb-...`)과 `SYMPHONY_SLACK_CHANNEL`(채널 ID)을 확보한다. `SYMPHONY_SLACK_USER_ID`(멘션 대상, `U...` 또는 Enterprise Grid의 `W...`)는 앱과 무관하게 Slack 프로필의 **Copy member ID**로 얻는다 — `users.list`로도 조회할 수 있으나 `users:read` 스코프가 추가로 필요하다. 설정 주입과 실행은 [README](README.md)의 설정, 운영 절을 따른다.

에이전트가 Slack Web API로 진행한다. 앱 생성은 `apps.manifest.create`, 토큰 교환은 `oauth.v2.access`, 채널 처리는 `conversations.list`와 `conversations.join`이다.

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

- 런타임에 필요한 스코프는 `chat:write`뿐이다. 사용자 멘션은 ID를 텍스트에 넣는 것이므로 추가 스코프가 없다. `channels:read`(채널 ID 조회)와 `channels:join`(봇 채널 참여)은 설치 단계를 API로 처리하기 위해 넣는다.
- 표시명은 Slack 앱 설정에만 있는 값이라 코드와 무관하다. 이미 발급받아 쓰고 있는 앱이 있으면 표시명을 바꾸지 않는다 — 기존 스레드의 발신자 표기만 바뀌고 얻는 것이 없다.
- `redirect_urls`는 HTTPS만 허용된다. `https://localhost`는 어디에도 코드를 전송하지 않기 위한 값이며 수신 서버가 필요 없다.

## 함정

- `apps.manifest.create` 응답의 `credentials.client_id`와 `client_secret`은 `oauth.v2.access` 토큰 교환에 필요하므로 응답을 버리지 말고 보관한다. 잃어버리면 웹 UI의 **Basic Information**에서 다시 확인한다.
- `apps.manifest.create`가 `internal_error`를 반환하면 같은 manifest를 `apps.manifest.validate`로 검증해 `errors` 배열에서 원인을 확인한다. 검증을 통과하는데도 실패하면 https://api.slack.com/apps 에서 같은 이름의 앱이 이미 있는지 확인한다. 이름 충돌이 `internal_error`로 나타난다. 재시도는 rate limit(Tier 1, 분당 1회 수준)을 고려해 1분 이상 간격을 둔다.
- 비공개 채널은 `conversations.join`이 불가하므로 사람이 그 채널에서 `/invite @<봇 표시명>`으로 초대한다. 봇이 채널에 없는 상태로 게시하면 `not_in_channel` 오류가 난다. 비공개 채널 ID는 `channels:read`의 `conversations.list`로 조회되지 않으므로(`groups:read` 필요) Slack UI의 채널 세부정보 하단에서 복사한다.
- 설치 후 스코프를 추가하면 앱을 재설치해야 하고, 재설치 시 토큰이 재발급될 수 있다.

## 검증

`~/.config/symphony/env`에 README 설정 표의 네 값을 기입하고, `notifier/`에서 `pnpm install`을 마친 뒤 `symphonyctl notifier start`로 실행한다. `SYMPHONY_NOTIFY_URL`로 `started` 이벤트를 보내 채널에 본문 메시지가 게시되는지 확인한다 (페이로드 형식은 README의 이벤트 인터페이스). 실패하면 `symphonyctl notifier logs`에서 Slack 오류(`invalid_auth`, `not_in_channel` 등)를 확인한다.

## 배경: 도구 선택

### Bolt 프레임워크를 쓰지 않는 이유

Bolt는 Slack → 앱 방향(이벤트 수신, slash command, 인터랙션, 서명 검증)의 인프라다. 알림 서버의 Slack 방향은 앱 → Slack 단방향(`chat.postMessage`)뿐이고, HTTP 수신은 Slack이 아니라 오케스트레이터에게서 받는다. Bolt도 아웃바운드 호출에는 `@slack/web-api`의 `WebClient`를 쓰므로 하위 계층을 직접 쓰는 현재 구성에 기능 손실이 없다. 인터랙션(버튼, slash command)이 필요해지면 Bolt를 검토한다.

### 공식 Slack CLI를 쓰지 않는 이유

공식 Slack CLI(`slack` 명령)는 앱 라이프사이클 관리 도구이지 토큰 발급 도구가 아니다. `slack run`은 CLI가 관리하는 개발 세션에만 임시 토큰을 주입하고, `slack deploy`로 배포한 앱은 웹 UI에서 잠겨 `xoxb-` 토큰을 발급받을 수 없다. Web API 직접 호출이 상시 실행 데몬용 독립 토큰을 얻는 최소 경로다.

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
