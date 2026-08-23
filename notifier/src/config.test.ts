import { loadConfig } from "./config.ts"

const valid = {
  SYMPHONY_NOTIFY_URL: "http://127.0.0.1:4123/events",
  SYMPHONY_SLACK_BOT_TOKEN: "xoxb-test",
  SYMPHONY_SLACK_CHANNEL: "C0123456789",
  SYMPHONY_SLACK_USER_ID: "U0123456789",
}

describe("loadConfig", () => {
  it("발신 URL에서 수신 포트와 경로를 도출한다", () => {
    const config = loadConfig(valid)
    expect(config.port).toBe(4123)
    expect(config.path).toBe("/events")
  })

  it("경로가 없는 URL은 루트 경로가 된다", () => {
    expect(loadConfig({ ...valid, SYMPHONY_NOTIFY_URL: "http://127.0.0.1:4123" }).path).toBe("/")
  })

  it("127.0.0.1이 아닌 호스트를 거부한다", () => {
    expect(() =>
      loadConfig({ ...valid, SYMPHONY_NOTIFY_URL: "http://10.0.0.1:4123/events" }),
    ).toThrow("호스트가 127.0.0.1이어야 합니다.")
    expect(() =>
      loadConfig({ ...valid, SYMPHONY_NOTIFY_URL: "http://localhost:4123/events" }),
    ).toThrow("호스트가 127.0.0.1이어야 합니다.")
    expect(() => loadConfig({ ...valid, SYMPHONY_NOTIFY_URL: "http://[::1]:4123/events" })).toThrow(
      "호스트가 127.0.0.1이어야 합니다.",
    )
  })

  it("포트가 없으면 거부한다", () => {
    expect(() => loadConfig({ ...valid, SYMPHONY_NOTIFY_URL: "http://127.0.0.1/events" })).toThrow(
      "포트가 명시되어야 합니다.",
    )
  })

  it("http가 아닌 스킴을 거부한다", () => {
    expect(() =>
      loadConfig({ ...valid, SYMPHONY_NOTIFY_URL: "https://127.0.0.1:4123/events" }),
    ).toThrow("http 스킴이어야 합니다.")
  })

  it("형식이 아닌 사용자 ID를 거부한다", () => {
    expect(() => loadConfig({ ...valid, SYMPHONY_SLACK_USER_ID: "cheolhwan" })).toThrow(
      "Slack 사용자 ID 형식이어야 합니다.",
    )
  })

  it("값이 하나라도 없으면 거부한다", () => {
    const { SYMPHONY_SLACK_CHANNEL: _, ...rest } = valid
    expect(() => loadConfig(rest)).toThrow("SYMPHONY_SLACK_CHANNEL")
  })
})
