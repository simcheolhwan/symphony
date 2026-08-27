import { parseCommand, parseNotifierAction } from "./command.ts"

describe("parseCommand", () => {
  it("ls를 추가 옵션 없이 파싱한다", () => {
    expect(parseCommand(["ls"])).toEqual({
      command: "ls",
      aliases: [],
      workflow: undefined,
      all: false,
      withNotifier: false,
    })
  })

  it.each([
    ["start", "--all", "--with-notifier"],
    ["restart", "--with-notifier"],
    ["stop", "--with-notifier"],
  ])("기기 전체 조작 명령을 허용한다: %s", (...args) => {
    expect(() => parseCommand(args)).not.toThrow()
  })

  it.each([
    ["start", "myrepo", "--with-notifier"],
    ["start", "--all", "--workflow", "linear", "--with-notifier"],
    ["restart", "myrepo", "--with-notifier"],
    ["restart", "--workflow", "linear", "--with-notifier"],
    ["stop", "myrepo", "--with-notifier"],
    ["ls", "--with-notifier"],
  ])("notifier를 일부 인스턴스 조작과 결합하지 않는다: %s", (...args) => {
    expect(() => parseCommand(args)).toThrow(
      "--with-notifier는 start --all, 인자 없는 restart, 인자 없는 stop에서만 사용할 수 있습니다.",
    )
  })

  it("제거된 --json 옵션을 거부한다", () => {
    expect(() => parseCommand(["ls", "--json"])).toThrow("알 수 없는 옵션입니다: --json")
  })

  it("제거된 notifier logs 동작을 거부한다", () => {
    expect(() => parseNotifierAction(["logs"])).toThrow(
      "notifier 명령어에는 start, stop, restart 중 하나가 필요합니다.",
    )
  })
})
