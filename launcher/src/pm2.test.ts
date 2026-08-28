import { parsePm2Processes } from "./pm2.ts"

const valid = [
  {
    name: "symphony:linear:myrepo",
    pid: 1234,
    pm2_env: { status: "online", pm_uptime: 1_700_000_000_000, ignored: true },
    ignored: true,
  },
]

describe("parsePm2Processes", () => {
  it("pm2 jlist 응답에서 필요한 프로세스 필드만 변환한다", () => {
    expect(parsePm2Processes(JSON.stringify(valid))).toEqual([
      {
        name: "symphony:linear:myrepo",
        status: "online",
        startedAt: 1_700_000_000_000,
        pid: 1234,
      },
    ])
  })

  it("유효하지 않은 JSON과 배열이 아닌 응답의 기존 오류 문맥을 유지한다", () => {
    expect(() => parsePm2Processes("invalid")).toThrow(
      "pm2 jlist가 유효한 JSON을 반환하지 않았습니다.",
    )
    expect(() => parsePm2Processes("{}")).toThrow("pm2 jlist 결과가 배열이 아닙니다.")
  })

  it("프로세스 기본 구조가 잘못되면 배열 인덱스를 보고한다", () => {
    expect(() => parsePm2Processes('[{"name":42}]')).toThrow(
      "pm2 jlist의 0번 프로세스가 올바르지 않습니다.",
    )
  })

  it("status가 잘못되면 프로세스 이름을 보고한다", () => {
    expect(() =>
      parsePm2Processes(JSON.stringify([{ ...valid[0], pm2_env: { pm_uptime: 1 } }])),
    ).toThrow("pm2 jlist의 symphony:linear:myrepo 프로세스가 올바르지 않습니다.")
    expect(() =>
      parsePm2Processes(
        JSON.stringify([{ ...valid[0], pm2_env: { status: "unknown", pm_uptime: 1 } }]),
      ),
    ).toThrow("pm2 jlist의 symphony:linear:myrepo 프로세스가 올바르지 않습니다.")
  })

  it("숫자 필드가 잘못되면 필드 이름을 보고한다", () => {
    expect(() => parsePm2Processes(JSON.stringify([{ ...valid[0], pid: "1234" }]))).toThrow(
      "pm2 jlist의 pid 값이 올바르지 않습니다.",
    )
    expect(() =>
      parsePm2Processes(
        JSON.stringify([{ ...valid[0], pm2_env: { status: "online", pm_uptime: "today" } }]),
      ),
    ).toThrow("pm2 jlist의 pm_uptime 값이 올바르지 않습니다.")
  })
})
