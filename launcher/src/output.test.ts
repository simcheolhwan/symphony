import {
  OperationError,
  errorResponseSchema,
  operationResponseSchema,
  serializeErrorResponse,
  serializeOperationResponse,
} from "./output.ts"

describe("조작 명령 출력", () => {
  it("대상별 결과를 JSON 객체 하나로 직렬화한다", () => {
    const output = serializeOperationResponse("start", [
      { target: { type: "notifier" }, outcome: "unchanged" },
      {
        target: { type: "instance", alias: "alpha", workflow: "linear" },
        outcome: "started",
      },
    ])

    expect(output).not.toContain("\n")
    const parsed: unknown = JSON.parse(output)
    expect(Array.isArray(parsed)).toBe(false)
    expect(operationResponseSchema.parse(parsed)).toEqual({
      schemaVersion: 1,
      command: "start",
      results: [
        { target: { type: "notifier" }, outcome: "unchanged" },
        {
          target: { type: "instance", alias: "alpha", workflow: "linear" },
          outcome: "started",
        },
      ],
    })
  })
})

describe("오류 출력", () => {
  it("일반 오류를 JSON 한 줄로 직렬화한다", () => {
    const output = serializeErrorResponse(new Error("잘못된 인자입니다.\n상세 정보"))
    expect(output).not.toContain("\n")
    expect(errorResponseSchema.parse(JSON.parse(output))).toEqual({
      schemaVersion: 1,
      error: { message: "잘못된 인자입니다.\n상세 정보" },
    })
  })

  it("조작 오류에는 실패 단계와 대상만 추가한다", () => {
    const target = { type: "instance", alias: "alpha", workflow: "pr-author" } as const
    const output = serializeErrorResponse(
      new OperationError("start", target, new Error("PM2 start failed")),
    )
    expect(errorResponseSchema.parse(JSON.parse(output))).toEqual({
      schemaVersion: 1,
      error: { message: "PM2 start failed", stage: "start", target },
    })
  })
})
