# Symphony

[`openai/symphony`](https://github.com/openai/symphony)의 포크. 무인 실행 환경으로 운영하기 위한 포크 고유 규칙만 기술한다.

## 기준 문서

[`VISION.md`](VISION.md)가 이 포크의 source of truth다. 사람과 에이전트의 역할 분담, 작업이 위임에서 머지까지 가는 경로를 지향점으로 서술한다.

- 워크플로 프롬프트, 어댑터의 디스패치 사유와 수렴 조건, 오케스트레이터 동작을 정할 때는 이 문서가 서술한 흐름을 기준으로 판단한다. 새 아이디어가 이 프로젝트에 맞는지도 이 문서로 판정한다.
- 이 문서는 미구현 동작도 지향점으로 서술한다. 구현이 이 문서와 어긋나면 구현을 문서에 맞추고, 문서를 현재 구현에 맞춰 내리지 않는다.
- 동료 PR을 리뷰하는 pr-reviewer 흐름은 이 문서의 범위 밖이고 지향점이 아직 명문화되지 않았다. 그 기준은 당분간 [`workflows/README.md`](workflows/README.md)의 시행착오 기록과 프롬프트 본문이 대신한다.

## 용어

- 디스패치: 오케스트레이터가 폴링에서 발견한 작업 대상(Linear 이슈, GitHub PR)에 에이전트 세션을 시작하는 것. 디스패치 사유는 그 시작을 유발한 관측 사실이다 (`agent` 레이블이 붙은 이슈, 미해결 리뷰 스레드, CI 실패 등).
- 수렴: 대상에 남은 디스패치 사유가 없어 다음 폴링에서 같은 대상이 다시 디스패치되지 않는 상태.
- 인스턴스: target 별칭과 워크플로의 조합으로 상시 실행되는 Symphony 프로세스 하나.

## 저장소 구성

```
workflows/    # 포크 소유: 워크플로 문서, 시행착오 기록(README.md)
issues/       # 포크 소유: upstream/main과의 분기 명세
launcher/     # 포크 소유: 런처 symphonyctl
notifier/     # 포크 소유: Slack 알림 서버
AGENTS.md     # 포크 소유: 루트 문서
VISION.md     # 포크 소유
CLAUDE.md     # 포크 소유
elixir/       # 업스트림 소유: 오케스트레이터와 어댑터
docs/         # 업스트림 소유
README.md     # 업스트림 소유
SPEC.md       # 업스트림 소유
```

- 업스트림 소유 파일은 수정을 최소로 유지해 업스트림 머지 비용을 낮추고, `elixir/` 작업은 [`elixir/AGENTS.md`](elixir/AGENTS.md)를 따른다.
- `SPEC.md`는 업스트림 소유지만 오케스트레이터와 어댑터의 규격 문서이므로 수정 최소화의 예외다. `elixir/`의 동작 계약을 바꾸는 변경은 같은 변경에서 `SPEC.md`의 관련 규칙, 참조 알고리즘, 테스트 매트릭스를 함께 갱신한다. 규격-구현 불일치를 남기는 것은 수정 최소화가 아니다.
- 포크 소유 컴포넌트(launcher, notifier)의 사용자 가시 동작(명령, 플래그, 설정 스키마, 환경변수, 이벤트 규격)을 바꾸는 변경은 같은 변경에서 소유 README를 갱신한다. 컴포넌트 경계를 넘는 인터페이스(이벤트 규격, 환경변수)는 소유 문서 하나를 정하고 반대쪽 문서는 참조만 남긴다.
- `issues/`는 이 포크가 `upstream/main`에서 어떻게 달라졌는지를 영역별 요구사항으로 기록한다. 개별 변경을 이력으로 쌓는 곳이 아니라 분기 상태 전체의 명세이므로, 달라진 점이 진화하면 항목을 추가하지 말고 해당 항목을 다시 쓴다.
- `issues/`의 `설계 결정` 절에는 비자명한 결정만 남긴다. 요구사항이나 코드만으로 도출되는 자명한 서술은 두지 않는다.
- 업스트림 소유 문서는 영문 원본만 두고, 포크 소유 문서는 한국어로 쓴다.

## 워크플로 문서

`workflows/<workflow>.md` 하나가 실행 단위다. frontmatter는 오케스트레이터가 파싱하는 설정이고([`elixir/WORKFLOW.md`](elixir/WORKFLOW.md)의 예시와 [`elixir/README.md`](elixir/README.md)의 어댑터별 설정 절 참조), 본문은 Codex에 전달되는 프롬프트다. 워크플로를 만들며 겪은 시행착오와 거기서 확정한 규칙은 [`workflows/README.md`](workflows/README.md)에 기록한다.

- 인스턴스마다 달라지는 설정값은 하드코딩하지 말고 런처가 주입하는 환경변수를 참조한다.
- 수렴 요구사항: 에이전트는 디스패치 사유마다 관측 가능한 응답을 트래커에 남겨야 한다. 남기지 않으면 다음 폴링에서 같은 대상이 다시 디스패치되어 무한 반복한다.
- 감독자 없는 반복은 스스로 멈춘다. 에이전트는 진행할 수 없으면 `agent` 레이블 제거나 `Needs discussion` 리뷰로 재디스패치를 스스로 끊고 사람을 부른다.
- 프롬프트가 참조하는 `$sim-*` 등 스킬은 실행 머신의 사용자 자산이라 저장소 밖에 있다. `VISION.md`가 서술한 동작 일부는 이 스킬 계층이 구현한다.

## 검증

`elixir/` 테스트는 `mise -C elixir exec -- mix test --exclude timing`으로 돌린다. `:timing` 태그가 붙은 세 테스트는 여유가 100ms 이내라 머신 부하에 따라 실패하고, 한 건만 실패해도 애플리케이션이 내려가 이후 파일이 전부 연쇄 실패한다. 제외하지 않으면 실패가 100건을 넘겨 회귀 여부를 판별할 수 없다. `elixir/AGENTS.md`의 `make all`은 `ci`를 경유해 `mix test --cover`를 실행하며 이 제외를 적용하지 않으므로 테스트 게이트로는 위 명령을 우선한다.

## 실행

런처는 `launcher/symphonyctl.mts`다. 명령, 로컬 설정 파일(`~/.config/symphony/`), 주입 환경변수, 프로세스 모델은 [`launcher/README.md`](launcher/README.md)를 따른다.

런처가 실행하는 본체는 `elixir/bin/symphony` escript다. 추적하지 않는 빌드 산출물이고 런처는 최신 여부를 알 수 없으므로, `elixir/` 소스나 워크플로 frontmatter가 쓰는 설정 규격을 바꿨으면 `mise -C elixir exec -- mix escript.build`로 다시 빌드한 뒤 인스턴스를 재시작한다. 오래된 escript는 새 설정값을 모른 채 부팅에 실패하고 PM2 재시작 한도까지 반복한다.

알림 서버는 `notifier/`다. 설계, 이벤트 규격, Slack 설정은 [`notifier/README.md`](notifier/README.md)를 따른다.
