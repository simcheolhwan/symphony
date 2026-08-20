import { describe, expect, it } from "vitest"
import { lifecycleEventSchema } from "./events.ts"

const valid = {
  instance: "myrepo-linear",
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

const extended = {
  ...valid,
  workflow: "PR 저자",
  target: "myrepo",
  dispatch_reasons: ["unresolved_threads:3", "failing_checks:1"],
  observed: ["PR 연결"],
  agent_message: "재시도 정책을 구현했지만 검증하지 못했다.",
  issue: { ...valid.issue, pr_author: "octocat" },
}

describe("lifecycleEventSchema", () => {
  it("정상 페이로드를 통과시킨다", () => {
    expect(lifecycleEventSchema.parse(valid)).toEqual(valid)
  })

  it("확장 필드를 포함한 페이로드를 통과시킨다", () => {
    expect(lifecycleEventSchema.parse(extended)).toEqual(extended)
  })

  it("workflow, target, dispatch_reasons, observed, agent_message, pr_author는 선택이다", () => {
    expect(lifecycleEventSchema.safeParse(valid).success).toBe(true)
  })

  it("dispatch_reasons가 문자열 배열이 아니면 거부한다", () => {
    expect(lifecycleEventSchema.safeParse({ ...valid, dispatch_reasons: "3건" }).success).toBe(false)
    expect(lifecycleEventSchema.safeParse({ ...valid, dispatch_reasons: [3] }).success).toBe(false)
  })

  it("reason과 title은 선택이다", () => {
    const { reason: _, ...rest } = valid
    const { title: __, ...issue } = valid.issue
    expect(lifecycleEventSchema.safeParse({ ...rest, issue }).success).toBe(true)
  })

  it("정의되지 않은 event 종류도 통과시킨다", () => {
    expect(lifecycleEventSchema.safeParse({ ...valid, event: "paused" }).success).toBe(true)
  })

  it("빈 event를 거부한다", () => {
    expect(lifecycleEventSchema.safeParse({ ...valid, event: "" }).success).toBe(false)
  })

  it("issue.url이 URL이 아니면 거부한다", () => {
    const payload = { ...valid, issue: { ...valid.issue, url: "not-a-url" } }
    expect(lifecycleEventSchema.safeParse(payload).success).toBe(false)
  })

  it("issue.id가 없으면 거부한다", () => {
    const { id: _, ...issue } = valid.issue
    expect(lifecycleEventSchema.safeParse({ ...valid, issue }).success).toBe(false)
  })
})
