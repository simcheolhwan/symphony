import { NOTIFIER_PROCESS_NAME, PROCESS_PREFIX } from "./constants.mts"
import { formatUptime, readSymphonyProcesses } from "./pm2.mts"
import { findExecutable } from "./process.mts"
import { parseInstanceId } from "./registry.mts"
import { STATUS_LABELS, printTable } from "./table.mts"

export const runList = async (): Promise<void> => {
  const pm2Path = await findExecutable("pm2")
  const processes = Array.from((await readSymphonyProcesses(pm2Path)).values()).toSorted(
    (left, right) => left.name.localeCompare(right.name),
  )
  printTable([
    ["별칭", "워크플로", "상태", "실행 시간"],
    ...processes.map((processInfo) => {
      const id = processInfo.name.slice(PROCESS_PREFIX.length)
      const ref = parseInstanceId(id)
      // 알림 서버는 인스턴스가 아니라 별칭도 워크플로도 없다.
      const label = processInfo.name === NOTIFIER_PROCESS_NAME ? "알림" : id
      return [
        ref?.alias ?? label,
        ref?.workflow ?? "-",
        STATUS_LABELS[processInfo.status] ?? processInfo.status,
        processInfo.status === "online" ? formatUptime(processInfo.uptime) : "-",
      ]
    }),
  ])
}
