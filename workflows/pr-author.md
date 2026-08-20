---
tracker:
  kind: github_pr_author
  provider:
    repo: "$GITHUB_REPO"
  active_states:
    - open
  terminal_states:
    - closed
workspace:
  root: "$SYMPHONY_WORKSPACE_ROOT"
hooks:
  after_create: |
    gh repo clone "$GITHUB_REPO" .
agent:
  max_concurrent_agents: 3
  max_turns: 20
codex:
  command: codex --config shell_environment_policy.inherit=all --config model_reasoning_effort=xhigh --config approvals_reviewer=auto_review app-server
  approval_policy: on-request
  turn_sandbox_policy:
    type: workspaceWrite
    networkAccess: true
---

`{{ issue.native_ref.repo }}`에서 내가 저자인 풀 리퀘스트 `{{ issue.identifier }}`의 피드백을 처리한다.

풀 리퀘스트 맥락:

- 번호: `{{ issue.id }}`
- 제목: `{{ issue.title }}`
- URL: `{{ issue.url }}`
- head 브랜치: `{{ issue.branch_name }}`

설명:

{% if issue.description %}
{{ issue.description }}
{% else %}
설명이 없다. 대응할 근거가 없으므로 피드백 처리를 시작하지 말고, 설명 부재를 PR 코멘트로 남긴 뒤 차단 요인으로 보고하고 종료하라.
{% endif %}

{% if attempt %}
이어지는 실행 #{{ attempt }}이다. 새 작업 전에 워크스페이스와 브랜치 상태를 복구하고, 이미 답글이나 코멘트로 응답한 피드백을 반복 처리하지 마라.
{% endif %}

## 전제조건

- 대상 저장소의 `.github/CODEOWNERS`에 기본 리뷰어가 지정되어 있어야 PR에 리뷰 요청이 자동 등록되고 `pr-reviewer` 인스턴스가 그 PR을 픽업한다. 지정되어 있지 않으면 리뷰 단계로 넘어가지 못하므로 차단 사유로 보고하라.
- 기본 리뷰어는 개인 계정이어야 한다. 리뷰어 트래커는 개인 앞으로 온 리뷰 요청만 인식하므로, 팀만 지정된 CODEOWNERS는 팀 리뷰 요청만 만들어 `pr-reviewer` 인스턴스가 그 PR을 픽업하지 못한다. 이 경우도 차단 사유로 보고하라.

## 기본 원칙

- 무인 세션이다. 사람에게 중간 확인을 요청하지 마라. 동료 리뷰와 스쿼시 머지는 사람이 수행한다.
- 원격 맥락에는 주입된 `github_api`를 우선 사용하라.
- 사용자는 검증을 마친 head 브랜치를 `origin`의 같은 이름 브랜치로 강제가 아닌 푸시를 수행하는 것을 승인한다. 기본 브랜치, 다른 원격, 강제 푸시, 브랜치 삭제는 승인하지 않는다.
- 사용자는 이 PR에 이미 리뷰를 제출한 동료에게 리뷰를 재요청하는 것을 승인한다. 리뷰어 제거, 새 리뷰어 추가, Draft의 Ready 전환은 승인하지 않는다. Ready 전환은 사람의 판단 게이트다.

## 절차

1. `git fetch origin` 후 `{{ issue.branch_name }}`을 `origin`의 head로 체크아웃하라.
2. `$sim-github-resolve-feedback`로 미해결 피드백과 CI 실패를 무인 모드로 처리하라. 유효한 지적 사항은 수정·커밋·푸시하고, 무효이거나 이미 수정된 지적 사항에는 근거를 답변하라.
3. 수렴 요구사항을 지켜라. 아래 응답이 GitHub에 남아야 이 PR이 같은 사유로 다시 디스패치되지 않는다.
   - 디스패치 사유가 된 모든 미해결 스레드에 답글을 남겨라. nitpick 무시 사유와 차단 사유도 답글로 남긴다.
   - 수정하지 않기로 판정한 CI 실패는 PR 코멘트로 사유를 남겨라.
   - 스레드 없는 `CHANGES_REQUESTED` 리뷰에는 수정 푸시 또는 PR 코멘트로 응답하라.
4. 리뷰어가 아키텍처나 접근 방식을 명시적으로 거절하면 증분 수정을 시작하지 말고 `전체 재시작 필요` 판단과 대안을 PR 코멘트로 남겨라.
5. 이번 실행에서 아무것도 푸시하지 않았다면 리뷰를 재요청하라. 재요청이 없으면 `pr-reviewer` 인스턴스가 같은 PR을 다시 픽업하지 않아 리뷰 왕복이 한 번으로 끊긴다.
   - 대상은 이 PR에 리뷰를 제출한 사람 계정 중 지금 리뷰 요청 목록에 없고 최신 리뷰가 현재 head를 대상으로 하지 않는 계정이다. 세션 기억이 아니라 현재 PR 상태로 판정하므로 실행이 끊겨도 다음 실행이 그대로 이어받는다.
   - 봇은 제외하라. 리뷰 목록에서 `user.type`이 `User`인 작성자만 고르고 나 자신도 제외하라.
   - 푸시했다면 재요청하지 마라. 푸시가 깨운 리뷰봇이 지적을 남길 수 있다. 리뷰봇이 조용하면 다음 디스패치가 재요청만 남은 상태로 이 절차에 다시 들어온다.

   ```bash
   gh api repos/{{ issue.native_ref.repo }}/pulls/{{ issue.id }}/reviews --paginate --jq '.[] | select(.user.type == "User") | .user.login'
   gh api repos/{{ issue.native_ref.repo }}/pulls/{{ issue.id }}/requested_reviewers --jq '.users[].login'
   gh api repos/{{ issue.native_ref.repo }}/pulls/{{ issue.id }}/requested_reviewers -X POST -f 'reviewers[]=<login>'
   ```
6. 응답과 재요청을 마치면 세션을 끝내라. 푸시가 만든 새 리뷰나 check 결과를 세션 안에서 기다리지 마라. 새 스레드와 check 실패는 다음 폴링이 디스패치 사유로 잡는다.

## 완료 기준

- 모든 디스패치 사유(미해결 스레드, CI 실패, 스레드 없는 `CHANGES_REQUESTED`)에 수정 푸시, 답글, PR 코멘트 중 하나로 응답했다.
- 푸시 없이 재요청 사유만 남은 실행이었다면 대상 리뷰어에게 리뷰를 재요청했다.
- 최종 메시지의 첫 줄은 완료한 대응, 재요청한 리뷰어, 차단 요인을 1~3문장 평문으로 요약하라 (헤딩, 목록, 코드 블록 금지). 워크스페이스 복구, 절차 단계, 도구 호출 같은 내부 서사를 쓰지 말고 PR에 남은 관측 가능한 응답만 서술하라. 사람에게 후속 작업을 제안하지 마라.
- 둘째 줄부터는 이번에 대응한 리뷰 피드백을 각각 불릿 하나로 보고하라. 인라인 스레드뿐 아니라 리뷰 본문의 지적도 각각 하나로 센다. 코멘트 전문을 옮기지 말고, 지적 요지와 함께 어떻게 고쳤는지 또는 고칠 예정인지를 한 줄로 요약하라.
