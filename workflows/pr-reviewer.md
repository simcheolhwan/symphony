---
tracker:
  kind: github_pr_reviewer
  provider:
    repo: "$GITHUB_REPO"
  active_states:
    - open
  terminal_states:
    - closed
workspace:
  root: "$SYMPHONY_WORKSPACE_ROOT"
agent:
  max_concurrent_agents: 3
  max_turns: 3
codex:
  command: codex ${SYMPHONY_MODEL:+--model="$SYMPHONY_MODEL"} --config shell_environment_policy.inherit=all --config model_reasoning_effort="${SYMPHONY_MODEL_REASONING_EFFORT:-xhigh}" --config approvals_reviewer=auto_review app-server
  approval_policy: never
  turn_sandbox_policy:
    type: workspaceWrite
    networkAccess: true
---

`{{ issue.native_ref.repo }}`의 풀 리퀘스트 `{{ issue.identifier }}` 리뷰 요청을 처리한다.

풀 리퀘스트 맥락:

- 번호: `{{ issue.id }}`
- 제목: `{{ issue.title }}`
- URL: `{{ issue.url }}`
- head 브랜치: `{{ issue.branch_name }}`

설명:

{% if issue.description %}
{{ issue.description }}
{% else %}
설명이 없다. 리뷰할 근거가 없으므로 리뷰를 시작하지 말고, 설명 부재를 사유로 담은 `Needs discussion` 리뷰를 제출해 종료하라.
{% endif %}

## 기본 원칙

- 무인 세션이다. 사람에게 중간 확인을 요청하지 마라. 읽기 전용으로 실행하고 풀 리퀘스트 브랜치를 수정하지 마라.
- 원격 맥락에는 주입된 `github_api`를 우선 사용하라.
- 저장소의 GitHub Actions 검사를 로컬에서 재현하지 마라.
- 스킬은 적용 대상을 스스로 정하지 않는다. 호출할 때 대상 PR과 head SHA를 명시하라. 리뷰는 초안 승인 없이 바로 게시하고, 필수 정보나 권한이 없으면 질문하지 말고 차단 요인으로 보고하라.

## 절차

1. `$code-review`로 PR `{{ issue.id }}`를 검토하라. 대상은 `github_api`로 읽은 PR 제목, 설명, 연결된 이슈, 리뷰 스레드와 base부터 현재 head SHA까지의 diff다. 워크스페이스는 빈 디렉터리이므로 체크아웃, 의존성 설치, 빌드, 테스트 없이 읽기로만 검토하고, 변경 파일 목록은 모든 페이지를 읽어 PR의 변경 파일 수와 대조하라. 내가 이미 제출한 리뷰가 있으면 그 리뷰가 대상으로 한 head SHA 이후 변경분만 검토하고 이전 지적 사항의 해결 여부를 함께 판정하라. 리뷰가 불완전하면 리뷰를 제출하지 않고 종료하라. 다음 폴링의 재실행이 처음부터 다시 본다. 단, 세션을 다시 시작해도 해소되지 않는 사유(접근 권한 부족, diff 조회 불가 등)로 리뷰를 완성할 수 없으면 그 사유를 담은 `Needs discussion` 리뷰를 제출해 재디스패치를 멈추고 사람을 불러라.
2. 판정이 `Approve`, `Request changes`, `Needs discussion`이면 `$github-post-review`로 PR `{{ issue.id }}`에 제출하라. 이 권한은 해당 최종 GitHub Review에만 적용한다.
   - 리뷰 본문과 인라인 코멘트는 초안 승인 없이 게시하고 스크린샷 같은 증빙은 첨부하지 마라. 검증에서 제외한 지적 사항이 있으면 남은 지적 사항으로 판정을 다시 정하라.
   - 게시 직전에 head SHA, 나에게 온 리뷰 요청, check 결과를 다시 확인하라. head가 바뀌었으면 1번으로 돌아가라.
   - 리뷰 요청이 사라졌거나 실패한 check가 있으면 게시하지 말고 그대로 종료하라.

## 완료 기준

- 검증한 리뷰를 제출했거나 요청이 대상 조건을 충족하지 않게 됐거나 불완전한 리뷰를 제출하지 않았다. 세션 재시작으로 해소되지 않는 차단은 `Needs discussion` 리뷰로 남겼다.
- 최종 메시지의 첫 줄은 제출한 리뷰 판정, 지적 요지, 차단 요인을 1~3문장 평문으로 요약하라 (헤딩, 목록, 코드 블록 금지). 절차 단계, 도구 호출 같은 내부 서사를 쓰지 말고 PR에 남은 관측 가능한 결과만 서술하라. 사람에게 후속 작업을 제안하지 마라.
- 둘째 줄부터는 제출한 리뷰의 지적 사항을 각각 불릿 하나로 보고하라. 인라인 코멘트뿐 아니라 리뷰 본문의 지적도 각각 하나로 센다. 전문을 옮기지 말고 요지만 한 줄로 요약하라. 재리뷰라면 이전 리뷰에서 지적한 사항마다 PR 저자의 대처(수정 반영, 반박, 미응답)도 함께 보고하라.
