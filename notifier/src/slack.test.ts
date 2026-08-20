import { describe, expect, it, vi } from "vitest"
import { overflowKeys, parseThreads, serializeThreads } from "./slack.ts"

describe("parseThreads", () => {
  it("저장 파일 내용을 매핑으로 되돌린다", () => {
    const text = '{"myrepo-linear:issue-1":"1700000000.000100"}'
    expect(parseThreads(text)).toEqual(new Map([["myrepo-linear:issue-1", "1700000000.000100"]]))
  })

  it("손상된 파일은 빈 매핑으로 시작한다", () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    expect(parseThreads("{not json")).toEqual(new Map())
  })

  it("객체가 아닌 최상위 값은 빈 매핑으로 시작한다", () => {
    expect(parseThreads("[]")).toEqual(new Map())
    expect(parseThreads("null")).toEqual(new Map())
  })

  it("ts가 문자열이 아닌 항목은 버린다", () => {
    const text = '{"a":"1700000000.000100","b":42,"c":""}'
    expect(parseThreads(text)).toEqual(new Map([["a", "1700000000.000100"]]))
  })

  it("직렬화한 내용을 그대로 되돌린다", () => {
    const threads = new Map([
      ["a", "1700000000.000100"],
      ["b", "1700000000.000200"],
    ])
    expect(parseThreads(serializeThreads(threads))).toEqual(threads)
  })
})

describe("overflowKeys", () => {
  it("상한 이내면 축출하지 않는다", () => {
    const threads = new Map([
      ["a", "1"],
      ["b", "2"],
    ])
    expect(overflowKeys(threads, 2)).toEqual([])
  })

  it("삽입 순서가 오래된 항목부터 상한 초과분을 고른다", () => {
    const threads = new Map([
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
      ["d", "4"],
    ])
    expect(overflowKeys(threads, 2)).toEqual(["a", "b"])
  })
})
