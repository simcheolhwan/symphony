import { describe, expect, it } from "vitest"
import type { LifecycleEvent } from "./events.ts"
import { bodyText, replyBlocks, replyText } from "./templates.ts"

const base: LifecycleEvent = {
  instance: "myrepo-linear",
  workflow: "Linear",
  target: "myrepo",
  event: "blocked",
  reason: "운영자 승인 대기",
  issue: {
    id: "a1b2c3d4-0000-0000-0000-000000000000",
    identifier: "SYM-42",
    title: "알림 이벤트 발신 추가",
    url: "https://linear.app/acme/issue/SYM-42",
    state: "In Progress",
  },
}

const pullRequest: LifecycleEvent = {
  instance: "myrepo-pr-reviewer",
  workflow: "PR 리뷰어",
  target: "myrepo",
  event: "started",
  issue: {
    id: "42",
    identifier: "GH-42",
    title: "알림 개편",
    url: "https://github.com/acme/myrepo/pull/42",
    state: "open",
    pr_author: "octocat",
  },
}

const userId = "U01ABCDEFGH"

describe("bodyText", () => {
  it("워크플로와 대상, 이슈 식별자 링크를 표시한다", () => {
    expect(bodyText(base)).toBe(
      "▶️ *Linear (myrepo)* <https://linear.app/acme/issue/SYM-42|SYM-42> 알림 이벤트 발신 추가",
    )
  })

  it("workflow나 target이 없으면 인스턴스 이름으로 대체한다", () => {
    const { workflow: _, ...withoutWorkflow } = base
    expect(bodyText(withoutWorkflow)).toBe(
      "▶️ *myrepo-linear* <https://linear.app/acme/issue/SYM-42|SYM-42> 알림 이벤트 발신 추가",
    )

    const { target: __, ...withoutTarget } = base
    expect(bodyText(withoutTarget)).toBe(
      "▶️ *myrepo-linear* <https://linear.app/acme/issue/SYM-42|SYM-42> 알림 이벤트 발신 추가",
    )
  })

  it("title이 없으면 생략한다", () => {
    const { title: _, ...issue } = base.issue
    expect(bodyText({ ...base, issue })).toBe(
      "▶️ *Linear (myrepo)* <https://linear.app/acme/issue/SYM-42|SYM-42>",
    )
  })

  it("PR 식별자는 링크 텍스트를 PR 번호로 쓰고 저자를 덧붙인다", () => {
    expect(bodyText(pullRequest)).toBe(
      "▶️ *PR 리뷰어 (myrepo)* <https://github.com/acme/myrepo/pull/42|PR #42> 알림 개편 (PR 저자: octocat)",
    )
  })
})

describe("replyText", () => {
  it("멘션과 함께 이모지와 한국어 레이블로 포맷팅한다", () => {
    expect(replyText(base, userId)).toBe("<@U01ABCDEFGH> ⛔ 차단 (In Progress) — 운영자 승인 대기")
  })

  it("reason이 없으면 생략한다", () => {
    expect(replyText({ ...base, event: "completed", reason: undefined }, userId)).toBe(
      "<@U01ABCDEFGH> ⏭️ 조치 (In Progress)",
    )
  })

  it.each([
    ["started", "<@U01ABCDEFGH> ▶️ 시작 (In Progress)"],
    ["retried", "<@U01ABCDEFGH> ⚠️ 실패 (In Progress)"],
    ["killed", "<@U01ABCDEFGH> 🛑 중단 (In Progress)"],
    ["settled", "<@U01ABCDEFGH> 💤 대기 (In Progress)"],
    ["mergeable", "<@U01ABCDEFGH> 🔔 수렴 (In Progress)"],
    ["finished", "<@U01ABCDEFGH> ✅ 종결 (In Progress)"],
  ])("%s 이벤트를 포맷팅한다", (event, expected) => {
    expect(replyText({ ...base, event, reason: undefined }, userId)).toBe(expected)
  })

  it("정의되지 않은 이벤트는 기본 템플릿으로 포맷팅한다", () => {
    expect(replyText({ ...base, event: "paused", reason: undefined }, userId)).toBe(
      "<@U01ABCDEFGH> ℹ️ paused (In Progress)",
    )
  })

  it("디스패치 사유 코드를 한국어로 렌더링한다", () => {
    const payload: LifecycleEvent = {
      ...pullRequest,
      issue: { ...pullRequest.issue, state: "open" },
      dispatch_reasons: [
        "unresolved_threads:3",
        "failing_checks:1",
        "changes_requested",
        "review_rerequest_pending",
      ],
    }
    expect(replyText(payload, userId)).toBe(
      "<@U01ABCDEFGH> ▶️ 시작 (open) — 디스패치 사유: 미해결 리뷰 스레드 3건, CI 실패 1건, 스레드 없는 Changes requested, 리뷰 재요청 대기",
    )
  })

  it("합의에 없는 디스패치 사유 코드는 원문 그대로 보여준다", () => {
    const payload: LifecycleEvent = { ...pullRequest, dispatch_reasons: ["merge_conflict:2"] }
    expect(replyText(payload, userId)).toBe(
      "<@U01ABCDEFGH> ▶️ 시작 (open) — 디스패치 사유: merge_conflict:2",
    )
  })

  it("reason, 디스패치 사유, 관측을 순서대로 이어붙인다", () => {
    const payload: LifecycleEvent = {
      ...base,
      event: "settled",
      reason: "no remaining dispatch reasons",
      dispatch_reasons: ["failing_checks:2"],
      observed: ["PR 연결"],
    }
    expect(replyText(payload, userId)).toBe(
      "<@U01ABCDEFGH> 💤 대기 (In Progress) — no remaining dispatch reasons — 디스패치 사유: CI 실패 2건 — 관측: PR 연결",
    )
  })

  it("빈 배열은 아무것도 덧붙이지 않는다", () => {
    const payload: LifecycleEvent = {
      ...base,
      reason: undefined,
      dispatch_reasons: [],
      observed: [],
    }
    expect(replyText(payload, userId)).toBe("<@U01ABCDEFGH> ⛔ 차단 (In Progress)")
  })

  it("agent_message가 없으면 요약 줄을 붙이지 않는다", () => {
    expect(replyText(base, userId)).not.toContain("에이전트 요약")
  })

  it("agent_message의 첫 줄만 요약 줄로 덧붙인다", () => {
    const payload: LifecycleEvent = {
      ...base,
      event: "completed",
      reason: undefined,
      agent_message: "재시도 정책을 구현했다.\n\n남은 작업은 통합 테스트다.",
    }
    expect(replyText(payload, userId)).toBe(
      "<@U01ABCDEFGH> ⏭️ 조치 (In Progress)\n↳ *(에이전트 요약)* 재시도 정책을 구현했다.",
    )
  })

  it("앞쪽 빈 줄을 건너뛰고 첫 번째 내용 줄을 쓴다", () => {
    const payload: LifecycleEvent = {
      ...base,
      event: "completed",
      reason: undefined,
      agent_message: "\n   \n재시도 정책을 구현했다.\n검증은 남았다.",
    }
    expect(replyText(payload, userId)).toBe(
      "<@U01ABCDEFGH> ⏭️ 조치 (In Progress)\n↳ *(에이전트 요약)* 재시도 정책을 구현했다.",
    )
  })

  it("공백뿐인 agent_message는 요약 줄을 붙이지 않는다", () => {
    const payload: LifecycleEvent = { ...base, reason: undefined, agent_message: "\n   \n" }
    expect(replyText(payload, userId)).toBe("<@U01ABCDEFGH> ⛔ 차단 (In Progress)")
  })

  it("500자를 넘는 첫 줄은 절단한다", () => {
    const payload: LifecycleEvent = {
      ...base,
      event: "completed",
      reason: undefined,
      agent_message: "가".repeat(600),
    }
    expect(replyText(payload, userId)).toBe(
      `<@U01ABCDEFGH> ⏭️ 조치 (In Progress)\n↳ *(에이전트 요약)* ${"가".repeat(500)}…`,
    )
  })

  it("reason과 디스패치 사유 뒤에 줄을 바꿔 요약을 붙인다", () => {
    const payload: LifecycleEvent = {
      ...base,
      reason: "검증 불가: 스테이징 웹훅 시크릿 미제공",
      dispatch_reasons: ["failing_checks:2"],
      agent_message: "재시도 정책 구현은 마쳤지만 검증을 끝내지 못했다.",
    }
    expect(replyText(payload, userId)).toBe(
      "<@U01ABCDEFGH> ⛔ 차단 (In Progress) — 검증 불가: 스테이징 웹훅 시크릿 미제공 — 디스패치 사유: CI 실패 2건\n↳ *(에이전트 요약)* 재시도 정책 구현은 마쳤지만 검증을 끝내지 못했다.",
    )
  })
})

describe("replyBlocks", () => {
  it("agent_message가 없으면 상태줄 section 블록 하나만 만든다", () => {
    expect(replyBlocks(base, userId)).toEqual([
      {
        type: "section",
        text: { type: "mrkdwn", text: "<@U01ABCDEFGH> ⛔ 차단 (In Progress) — 운영자 승인 대기" },
      },
    ])
  })

  it("agent_message가 있으면 요약을 markdown 블록으로 잇는다", () => {
    const payload: LifecycleEvent = {
      ...base,
      event: "completed",
      reason: undefined,
      dispatch_reasons: ["failing_checks:2"],
      agent_message: "재시도 정책을 구현했다.\n남은 작업은 통합 테스트다.",
    }
    expect(replyBlocks(payload, userId)).toEqual([
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "<@U01ABCDEFGH> ⏭️ 조치 (In Progress) — 디스패치 사유: CI 실패 2건",
        },
      },
      { type: "markdown", text: "↳ **(에이전트 요약)** 재시도 정책을 구현했다." },
    ])
  })

  it("요약의 표준 마크다운을 변환 없이 그대로 싣는다", () => {
    const payload: LifecycleEvent = {
      ...pullRequest,
      event: "completed",
      agent_message: "[PR #197](https://github.com/acme/myrepo/pull/197)을 열고 **검증**을 마쳤다.",
    }
    expect(replyBlocks(payload, userId)[1]).toEqual({
      type: "markdown",
      text: "↳ **(에이전트 요약)** [PR #197](https://github.com/acme/myrepo/pull/197)을 열고 **검증**을 마쳤다.",
    })
  })

  it("공백뿐인 agent_message는 markdown 블록을 만들지 않는다", () => {
    const payload: LifecycleEvent = { ...base, agent_message: "\n   \n" }
    expect(replyBlocks(payload, userId)).toHaveLength(1)
  })

  it("500자를 넘는 요약은 절단해 싣는다", () => {
    const payload: LifecycleEvent = { ...base, agent_message: "가".repeat(600) }
    expect(replyBlocks(payload, userId)[1]).toEqual({
      type: "markdown",
      text: `↳ **(에이전트 요약)** ${"가".repeat(500)}…`,
    })
  })
})

describe("mrkdwn 이스케이프", () => {
  it("본문 제목의 특수 시퀀스를 이스케이프해 멘션 위조를 막는다", () => {
    const payload: LifecycleEvent = {
      ...base,
      issue: { ...base.issue, title: "<!channel> A & B" },
    }
    expect(bodyText(payload)).toBe(
      "▶️ *Linear (myrepo)* <https://linear.app/acme/issue/SYM-42|SYM-42> &lt;!channel&gt; A &amp; B",
    )
  })

  it("상태줄의 상태와 reason을 이스케이프한다", () => {
    const payload: LifecycleEvent = {
      ...base,
      reason: "agent exited: #PID<0.123.0>",
      issue: { ...base.issue, state: "<open>" },
    }
    expect(replyText(payload, userId)).toBe(
      "<@U01ABCDEFGH> ⛔ 차단 (&lt;open&gt;) — agent exited: #PID&lt;0.123.0&gt;",
    )
  })

  it("합의에 없는 디스패치 사유 코드를 이스케이프한다", () => {
    const payload: LifecycleEvent = { ...pullRequest, dispatch_reasons: ["<weird>&code"] }
    expect(replyText(payload, userId)).toBe(
      "<@U01ABCDEFGH> ▶️ 시작 (open) — 디스패치 사유: &lt;weird&gt;&amp;code",
    )
  })

  it("mrkdwn 폴백의 요약은 이스케이프하고 markdown 블록은 원문을 유지한다", () => {
    const payload: LifecycleEvent = {
      ...base,
      event: "completed",
      reason: undefined,
      agent_message: "<!here> 완료 & 검증",
    }
    expect(replyText(payload, userId)).toBe(
      "<@U01ABCDEFGH> ⏭️ 조치 (In Progress)\n↳ *(에이전트 요약)* &lt;!here&gt; 완료 &amp; 검증",
    )
    expect(replyBlocks(payload, userId)[1]).toEqual({
      type: "markdown",
      text: "↳ **(에이전트 요약)** <!here> 완료 & 검증",
    })
  })
})
