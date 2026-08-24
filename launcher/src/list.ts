import { NOTIFIER_PROCESS_NAME, PROCESS_PREFIX } from "./constants.ts"
import { formatUptime, readSymphonyProcesses } from "./pm2.ts"
import type { Pm2Process } from "./pm2.ts"
import { findExecutable } from "./process.ts"
import { parseInstanceId, readRegistry } from "./registry.ts"
import type { Target } from "./registry.ts"
import { buildMachineStatus, serializeMachineStatus } from "./status.ts"
import { STATUS_LABELS, printTable } from "./table.ts"

export const buildListRows = (processes: Map<string, Pm2Process>): string[][] => [
  ["별칭", "워크플로", "상태", "실행 시간"],
  ...Array.from(processes.values())
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .map((processInfo) => {
      const id = processInfo.name.slice(PROCESS_PREFIX.length)
      const ref = parseInstanceId(id)
      // 알림 서버는 인스턴스가 아니라 별칭도 워크플로도 없다.
      const label = processInfo.name === NOTIFIER_PROCESS_NAME ? "알림" : id
      return [
        ref?.alias ?? label,
        ref?.workflow ?? "-",
        STATUS_LABELS[processInfo.status] ?? processInfo.status,
        processInfo.status === "online" ? formatUptime(processInfo.startedAt) : "-",
      ]
    }),
]

export const printMachineStatus = (
  registry: Map<string, Target>,
  processes: Map<string, Pm2Process>,
): void => {
  process.stdout.write(`${serializeMachineStatus(buildMachineStatus(registry, processes))}\n`)
}

export const runList = async (json: boolean): Promise<void> => {
  const pm2Path = await findExecutable("pm2")
  const processes = await readSymphonyProcesses(pm2Path)
  if (!json) {
    printTable(buildListRows(processes))
    return
  }
  printMachineStatus(await readRegistry(), processes)
}
