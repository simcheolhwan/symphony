import { NOTIFIER_PROCESS_NAME } from "./constants.ts"
import { printMachineStatus } from "./list.ts"
import type { Pm2Process, Pm2Status } from "./pm2.ts"
import { parseRegistry } from "./registry.ts"
import { buildMachineStatus, machineStatusJsonSchema, toMachineStatusJson } from "./status.ts"

const registry = parseRegistry(
  JSON.stringify({
    alpha: {
      repo: "acme/alpha",
      project: "alpha-project",
      workflows: { linear: {}, "pr-author": {} },
    },
  }),
)

const pm2Process = (
  name: string,
  status: Pm2Status,
  pid = status === "online" ? 1234 : 0,
): Pm2Process => ({ name, status, pid, startedAt: pid === 0 ? 0 : 1_700_000_000_000 })

const processes = (...values: Pm2Process[]): Map<string, Pm2Process> =>
  new Map(values.map((value) => [value.name, value]))

describe("buildMachineStatus", () => {
  it("활성 인스턴스와 notifier가 모두 실행 중이면 online이다", () => {
    const status = buildMachineStatus(
      registry,
      processes(
        pm2Process("symphony-alpha-linear", "online"),
        pm2Process("symphony-alpha-pr-author", "online"),
        pm2Process(NOTIFIER_PROCESS_NAME, "online"),
      ),
    )
    expect(status.status).toBe("online")
    expect(status.notifier).toMatchObject({ status: "online", registered: true, pid: 1234 })
  })

  it("등록된 프로세스가 하나도 없으면 모든 리소스를 stopped로 명시한다", () => {
    const status = buildMachineStatus(registry, processes())
    expect(status.status).toBe("stopped")
    expect(status.instances).toEqual([
      {
        alias: "alpha",
        workflow: "linear",
        status: "stopped",
        registered: false,
        pid: null,
        startedAt: null,
      },
      {
        alias: "alpha",
        workflow: "pr-author",
        status: "stopped",
        registered: false,
        pid: null,
        startedAt: null,
      },
    ])
    expect(status.notifier).toEqual({
      status: "stopped",
      registered: false,
      pid: null,
      startedAt: null,
    })
  })

  it("실행 중과 중지 상태가 섞이면 partial이다", () => {
    const status = buildMachineStatus(
      registry,
      processes(pm2Process("symphony-alpha-linear", "online")),
    )
    expect(status.status).toBe("partial")
  })

  it.each(["launching", "stopping", "waiting restart", "one-launch-status"] as const)(
    "%s 상태를 손실 없이 유지하고 전체 상태를 transitioning으로 집계한다",
    (pm2Status) => {
      const status = buildMachineStatus(
        registry,
        processes(pm2Process("symphony-alpha-linear", pm2Status)),
      )
      expect(status.status).toBe("transitioning")
      expect(status.instances[0]?.status).toBe(pm2Status)
    },
  )

  it("인스턴스나 notifier의 오류를 errored로 집계한다", () => {
    const instanceError = buildMachineStatus(
      registry,
      processes(pm2Process("symphony-alpha-linear", "errored")),
    )
    const notifierError = buildMachineStatus(
      registry,
      processes(pm2Process(NOTIFIER_PROCESS_NAME, "errored")),
    )
    expect(instanceError.status).toBe("errored")
    expect(notifierError.status).toBe("errored")
    expect(notifierError.notifier.status).toBe("errored")
  })

  it("레지스트리에 없는 PM2 프로세스를 식별하고 집계에 포함한다", () => {
    const status = buildMachineStatus(
      registry,
      processes(
        pm2Process("symphony-orphan-pr-reviewer", "online"),
        pm2Process("symphony-legacy", "stopped"),
      ),
    )
    expect(status.orphanedProcesses).toEqual([
      {
        processName: "symphony-legacy",
        alias: null,
        workflow: null,
        status: "stopped",
        registered: true,
        pid: null,
        startedAt: null,
      },
      {
        processName: "symphony-orphan-pr-reviewer",
        alias: "orphan",
        workflow: "pr-reviewer",
        status: "online",
        registered: true,
        pid: 1234,
        startedAt: 1_700_000_000_000,
      },
    ])
    expect(status.status).toBe("partial")
  })
})

describe("ls 출력", () => {
  it("출력 스키마를 검증하고 JSON 객체 하나만 stdout에 쓴다", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    printMachineStatus(registry, processes())
    expect(write).toHaveBeenCalledTimes(1)
    const output = String(write.mock.calls[0]?.[0]).trim()
    const parsed: unknown = JSON.parse(output)
    expect(Array.isArray(parsed)).toBe(false)
    expect(machineStatusJsonSchema.parse(parsed)).toEqual(
      toMachineStatusJson(buildMachineStatus(registry, processes())),
    )
    expect(output).not.toContain(String.fromCodePoint(27))
    expect(output).not.toContain(String.fromCodePoint(155))
    write.mockRestore()
  })
})
