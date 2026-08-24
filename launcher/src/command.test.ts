import { parseCommand } from "./command.ts"

describe("parseCommand", () => {
  it("기계용 조회 옵션을 파싱한다", () => {
    expect(parseCommand(["ls", "--json"])).toEqual({
      command: "ls",
      aliases: [],
      workflow: undefined,
      all: false,
      json: true,
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

  it("--json을 ls 외의 명령에서 거부한다", () => {
    expect(() => parseCommand(["start", "--all", "--json"])).toThrow(
      "--json은 ls 명령어에서만 사용할 수 있습니다.",
    )
  })
})
