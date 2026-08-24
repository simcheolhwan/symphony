import { readFile } from "node:fs/promises"

import { NOTIFIER_HEALTH_RESPONSE } from "symphony-notifier/config"
import { z } from "zod"

import { NOTIFIER_PROCESS_NAME } from "./constants.ts"
import type { Instance, Target } from "./registry.ts"

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  failOnStart: undefined as string | undefined,
  fetch: vi.fn<typeof fetch>(),
  processes: new Map<string, { name: string; status: string; startedAt: number; pid: number }>(),
  findExecutable: vi.fn<(name: string) => Promise<string>>(),
  readRegistry: vi.fn<() => Promise<Map<string, Target>>>(),
  readSharedEnv: vi.fn<() => Promise<Record<string, string>>>(),
  runProcess:
    vi.fn<(command: string, args: string[], stdio: "inherit" | "capture") => Promise<string>>(),
}))

vi.mock("./process.ts", () => ({
  findExecutable: mocks.findExecutable,
  runProcess: mocks.runProcess,
}))

vi.mock("./registry.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./registry.ts")>()),
  readRegistry: mocks.readRegistry,
}))

vi.mock("./env.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./env.ts")>()),
  readSharedEnv: mocks.readSharedEnv,
}))

const { runStartOrRestart, runStop } = await import("./runners.ts")

const instance: Instance = {
  alias: "alpha",
  repo: "acme/alpha",
  model: undefined,
  effort: "xhigh",
  workflow: "pr-author",
}
const registry = new Map<string, Target>([
  ["alpha", { alias: "alpha", instances: new Map([["pr-author", instance]]) }],
])
const sharedEnv = {
  SYMPHONY_NOTIFY_URL: "http://127.0.0.1:4123/events",
  SYMPHONY_SLACK_BOT_TOKEN: "xoxb-test",
  SYMPHONY_SLACK_CHANNEL: "C0123456789",
  SYMPHONY_SLACK_USER_ID: "U0123456789",
}

const configSchema = z.object({ apps: z.tuple([z.object({ name: z.string() })]) })

const addOnlineProcess = (name: string): void => {
  mocks.processes.set(name, {
    name,
    status: "online",
    startedAt: 1_700_000_000_000,
    pid: 1234,
  })
}

const pm2Json = (): string =>
  JSON.stringify(
    Array.from(mocks.processes.values()).map((processInfo) => ({
      name: processInfo.name,
      pid: processInfo.pid,
      pm2_env: { status: processInfo.status, pm_uptime: processInfo.startedAt },
    })),
  )

const captureError = async (operation: Promise<void>): Promise<unknown> => {
  try {
    await operation
    return undefined
  } catch (error) {
    return error
  }
}

beforeEach(() => {
  mocks.events.length = 0
  mocks.failOnStart = undefined
  mocks.processes.clear()
  mocks.findExecutable.mockImplementation((name) => Promise.resolve(`/mock/${name}`))
  mocks.readRegistry.mockResolvedValue(registry)
  mocks.readSharedEnv.mockResolvedValue(sharedEnv)
  mocks.fetch.mockReset()
  mocks.fetch.mockImplementation(() => Promise.resolve(new Response(NOTIFIER_HEALTH_RESPONSE)))
  vi.stubGlobal("fetch", mocks.fetch)
  mocks.runProcess.mockImplementation(async (_command, args) => {
    const [action, target] = args
    if (action === "ping") return ""
    if (action === "jlist") return pm2Json()
    if (action === "delete" && target !== undefined) {
      mocks.events.push(`delete:${target}`)
      mocks.processes.delete(target)
      return ""
    }
    if (action === "start" && target !== undefined) {
      const config = configSchema.parse(JSON.parse(await readFile(target, "utf8")))
      const [app] = config.apps
      const { name } = app
      mocks.events.push(`start:${name}`)
      if (mocks.failOnStart === name) throw new Error("PM2 start failed")
      addOnlineProcess(name)
      return ""
    }
    if (action === "save") {
      mocks.events.push("save")
      return ""
    }
    throw new Error(`예상하지 못한 PM2 명령: ${args.join(" ")}`)
  })
  vi.spyOn(console, "info").mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("--with-notifier lifecycle", () => {
  it("알림 서버 준비를 확인한 뒤 모든 인스턴스를 시작하며 반복 호출은 변경하지 않는다", async () => {
    await runStartOrRestart("start", [], undefined, { all: true, withNotifier: true })
    expect(mocks.events).toEqual([
      `start:${NOTIFIER_PROCESS_NAME}`,
      "start:symphony-alpha-pr-author",
      "save",
    ])

    mocks.events.length = 0
    await runStartOrRestart("start", [], undefined, { all: true, withNotifier: true })
    expect(mocks.events).toEqual([])
  })

  it("알림 서버가 준비될 때까지 인스턴스를 시작하지 않는다", async () => {
    const health = Promise.withResolvers<Response>()
    mocks.fetch.mockReturnValue(health.promise)

    const operation = runStartOrRestart("start", [], undefined, {
      all: true,
      withNotifier: true,
    })
    await vi.waitFor(() => {
      expect(mocks.events).toEqual([`start:${NOTIFIER_PROCESS_NAME}`])
    })
    health.resolve(new Response(NOTIFIER_HEALTH_RESPONSE))
    await operation

    expect(mocks.events).toEqual([
      `start:${NOTIFIER_PROCESS_NAME}`,
      "start:symphony-alpha-pr-author",
      "save",
    ])
  })

  it("알림 서버 준비 확인 시간이 초과되면 인스턴스를 시작하지 않는다", async () => {
    const firstHealth = Promise.withResolvers<Response>()
    mocks.fetch
      .mockReturnValueOnce(firstHealth.promise)
      .mockImplementation(() => Promise.resolve(new Response("not-ready")))

    const operation = runStartOrRestart("start", [], undefined, {
      all: true,
      withNotifier: true,
    })
    const error = captureError(operation)
    await vi.waitFor(() => {
      expect(mocks.fetch).toHaveBeenCalledTimes(1)
    })
    vi.useFakeTimers()
    firstHealth.resolve(new Response("not-ready"))
    await vi.advanceTimersByTimeAsync(10_100)
    await expect(error).resolves.toMatchObject({
      message: "알림: 시작 실패: 알림 서버가 10초 안에 준비되지 않았습니다.",
    })

    expect(mocks.events).toEqual([`start:${NOTIFIER_PROCESS_NAME}`, "save"])
  })

  it("알림 서버 설정이 잘못됐으면 PM2 프로세스를 변경하지 않는다", async () => {
    mocks.readSharedEnv.mockResolvedValue({
      ...sharedEnv,
      SYMPHONY_SLACK_CHANNEL: "notifications",
    })

    await expect(
      runStartOrRestart("start", [], undefined, { all: true, withNotifier: true }),
    ).rejects.toThrow("알림 서버 설정이 올바르지 않습니다")
    expect(mocks.events).toEqual([])
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it("모든 인스턴스를 먼저 중지하고 notifier를 중지하며 반복 호출은 변경하지 않는다", async () => {
    addOnlineProcess("symphony-alpha-pr-author")
    addOnlineProcess(NOTIFIER_PROCESS_NAME)
    await runStop([], undefined, true)
    expect(mocks.events).toEqual([
      "delete:symphony-alpha-pr-author",
      `delete:${NOTIFIER_PROCESS_NAME}`,
      "save",
    ])

    mocks.events.length = 0
    await runStop([], undefined, true)
    expect(mocks.events).toEqual([])
  })

  it("notifier와 기존 전체 restart 대상을 함께 재시작한다", async () => {
    addOnlineProcess("symphony-alpha-pr-author")
    addOnlineProcess(NOTIFIER_PROCESS_NAME)
    await runStartOrRestart("restart", [], undefined, { all: false, withNotifier: true })
    expect(mocks.events).toEqual([
      `delete:${NOTIFIER_PROCESS_NAME}`,
      `start:${NOTIFIER_PROCESS_NAME}`,
      "delete:symphony-alpha-pr-author",
      "start:symphony-alpha-pr-author",
      "save",
    ])
  })

  it("일부 시작이 실패하면 성공한 상태를 저장하고 실패 대상을 보고한다", async () => {
    mocks.failOnStart = "symphony-alpha-pr-author"
    await expect(
      runStartOrRestart("start", [], undefined, { all: true, withNotifier: true }),
    ).rejects.toThrow("alpha (pr-author): 시작 실패: PM2 start failed")
    expect(mocks.events).toEqual([
      `start:${NOTIFIER_PROCESS_NAME}`,
      "start:symphony-alpha-pr-author",
      "save",
    ])
    expect(mocks.processes.has(NOTIFIER_PROCESS_NAME)).toBe(true)
  })
})
