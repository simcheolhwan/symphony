---
tracker:
  kind: linear
  provider:
    project_slug: "$LINEAR_PROJECT_SLUG"
    assignee: me
  required_labels:
    - agent
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Canceled
workspace:
  root: "$SYMPHONY_WORKSPACE_ROOT"
hooks:
  after_create: |
    gh repo clone "$GITHUB_REPO" .
agent:
  max_concurrent_agents: 3
  max_turns: 20
codex:
  command: codex ${SYMPHONY_MODEL:+--model="$SYMPHONY_MODEL"} --config shell_environment_policy.inherit=all --config model_reasoning_effort="${SYMPHONY_MODEL_REASONING_EFFORT:-xhigh}" --config approvals_reviewer=auto_review app-server
  approval_policy: on-request
  turn_sandbox_policy:
    type: workspaceWrite
    networkAccess: true
---

# Linear 구현 워크플로

Linear 이슈 `{{ issue.identifier }}`를 처리한다.

이슈 맥락:

- 제목: `{{ issue.title }}`
- 현재 상태: `{{ issue.state }}`
- 레이블: `{{ issue.labels }}`
- URL: `{{ issue.url }}`

설명:

{% if issue.description %}
{{ issue.description }}
{% else %}
설명이 없다. 요구사항을 복구할 근거가 없으므로 구현을 시작하지 말고 즉시 차단 처리하라.
{% endif %}

{% if attempt %}
이어지는 실행 #{{ attempt }}이다. 새 작업 전에 현재 워크스페이스, 브랜치, PR을 복구하고 완료된 작업을 반복하지 마라. 다음 조치를 완료하거나 차단 요인을 기록한 뒤에만 실행을 끝내라.
{% endif %}

## 기본 원칙

- 무인 세션이다. 사람에게 중간 확인을 요청하지 마라. Draft PR 생성 이후의 리뷰 대응, 최종 리뷰, 스쿼시 머지는 별도 PR 워크플로와 사람이 담당한다.
- 제공된 저장소 사본 안에서만 작업하고, 저장소 지침과 이슈의 완료 조건을 따르라.
- 상태 전환과 종료는 아래 표에서만 정의한다. 각 절차를 마치면 표로 돌아가 다음을 결정하라.
- 진행 상태는 브랜치, 커밋, PR이 보여준다. Linear에는 진행이나 완료 코멘트를 게시하지 말고 차단 코멘트와 PR attachment만 남겨라.
- 이슈 하나는 PR 하나만 소유한다. PR은 `$github-create-pr`로 Draft로만 생성하라.
- 스킬은 적용 대상을 스스로 정하지 않는다. 호출할 때 검토할 커밋 범위, 검증할 체크아웃, 게시할 PR을 명시하라. Linear 코멘트와 PR 본문 같은 외부 게시는 초안 승인 없이 바로 게시하고, 필수 정보나 권한이 없으면 질문하지 말고 차단 처리하라.
- 사용자는 검증을 마친 현재 이슈 브랜치를 `hooks.after_create`가 `$GITHUB_REPO`에서 클론한 `origin`의 같은 이름 브랜치로 강제가 아닌 푸시를 수행해 Draft PR을 생성하거나 갱신하는 것을 승인한다. 기본 브랜치, 다른 원격, 강제 푸시, 브랜치 삭제는 승인하지 않는다.
- 도구 승인 거절, 네트워크나 인증 실패, 정책 제한, 안전하게 해결할 수 없는 요구사항 등 원인과 관계없이 현재 실행에서 더 진행할 수 없으면 차단 처리하라.

## 상태와 종료

이슈를 다시 조회해 현재 사용자 할당과 `agent` 레이블을 확인하고, 이슈에 연결된 PR과 현재 브랜치의 PR을 확인하라. 위에서부터 처음 일치하는 행을 적용하라.

| 확인한 조건                   | 이슈 상태                                        | 다음                           |
| ----------------------------- | ------------------------------------------------ | ------------------------------ |
| 할당 또는 `agent` 레이블 없음 | 유지                                             | 종료                           |
| 차단                          | 확인한 열린 PR이 있으면 `In Review`, 아니면 유지 | 종료                           |
| 열린 PR                       | `In Review`                                      | 종료                           |
| 머지된 PR                     | `Done`                                           | 종료                           |
| 머지 없이 닫힌 PR             | 유지                                             | 차단 처리                      |
| `Todo`                        | `In Progress`                                    | 구현                           |
| `In Progress`                 | 유지                                             | 진행 중인 시도를 복구하고 구현 |
| 그 외 상태                    | 유지                                             | 종료                           |

이후 상태 변경은 사람이 담당한다.

## 절차

- 이슈, 코멘트, 저장소에서 요구사항을 복구하라. 합리적인 가정으로도 안전하게 구현할 수 없으면 코드를 변경하지 마라.
- 코드 변경 전에 `git fetch origin`을 실행하고 `origin/main`을 머지해 동기화하라. 이슈 브랜치가 로컬이나 `origin`에 있으면 그 브랜치를 체크아웃한 뒤 동기화하라. 강제 푸시가 승인되지 않으므로 rebase하지 마라.
- 이슈와 저장소가 요구하는 검증을 실행하라. 브라우저에 표시되는 경로는 `$playwright-test`로 검증하라. 대상은 현재 워크스페이스의 `origin/main...HEAD` 변경이 바꾼 사용자 흐름이고, 서버는 이 워크스페이스에서 프로젝트 설정의 명령과 포트로 직접 시작하라. 재현된 버그는 이슈 범위에서 수정하고 같은 시나리오를 다시 실행하라.
- `$code-review`로 현재 워크스페이스의 `origin/main...HEAD`를 검토하라. 요구사항은 이슈와 코멘트에서 찾고, 결과는 게시하지 말고 이 세션에서만 사용하라. Critical과 Important 지적 사항을 수정하고 차단 지적 사항이 없을 때까지 반복하라.
- `$git-branch`로 이슈 `{{ issue.identifier }}`의 브랜치를 만들고 변경사항을 커밋하라. 이슈 브랜치가 이미 있으면 새로 만들지 말고 `$git-commit`으로 커밋하라. 게시 전에 `origin/main`을 다시 머지하고, 동기화로 브랜치가 바뀌면 검증과 코드 리뷰를 반복하라.
- 게시 전에 푸시 대상, 로컬과 원격 브랜치, 커밋 범위를 확인하고 승인 요청에 실제 값을 명시하라. 위 승인 범위를 벗어나거나 auto review가 거절하면 재시도하지 마라.
- 이슈 브랜치를 `origin`에 푸시한 뒤 `$github-create-pr`로 base `main`, head 이슈 브랜치의 Draft PR을 생성하고 GitHub에서 번호와 URL을 확인하라. 확인한 PR을 Linear 이슈에 attachment로 연결하라.

## 차단 처리

- GitHub 접근이나 인증 실패는 대체 원격과 인증 방식을 확인한 뒤에만 차단으로 취급하라.
- 차단 사유와 사람이 수행해야 할 정확한 조치를 이슈 코멘트 하나로 게시하라. 이전 실행이 남긴 차단 코멘트가 있으면 새 코멘트 대신 그 스레드에 답글을 남겨라.
- 차단 코멘트를 게시한 직후 Linear 이슈에서 `agent` 레이블을 제거하라. Linear 접근 자체가 불가능해 제거할 수 없을 때만 실패 근거를 최종 메시지에 보고하라.

## 완료 기준

- 상태와 종료 표의 행 하나를 적용해 이슈 상태를 실제 상태와 일치시켰다.
- 최종 메시지의 첫 줄은 이번 실행이 이슈와 PR에 남긴 결과, 차단 요인을 1~3문장 평문으로 요약하라 (헤딩, 목록, 코드 블록 금지). 워크스페이스 복구, 절차 단계, 도구 호출 같은 내부 서사를 쓰지 말고 대상에 남은 관측 가능한 변화만 서술하라. 세부 내역은 둘째 줄부터 보고하고 후속 작업을 제안하지 마라.
