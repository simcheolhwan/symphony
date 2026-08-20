import { PROCESS_PREFIX } from "./constants.mts"
import { isRecord } from "./guards.mts"
import { runProcess } from "./process.mts"

export interface Pm2Process {
  name: string
  status: string
  uptime: number
  pid: number
}

export const formatUptime = (startedAt: number): string => {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1_000))
  if (seconds < 60) return `${seconds}초`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}분`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}시간`
  return `${Math.floor(hours / 24)}일`
}

const parseNumber = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`pm2 jlist의 ${field} 값이 올바르지 않습니다.`)
  }
  return value
}

const parsePm2Processes = (text: string): Pm2Process[] => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error("pm2 jlist가 유효한 JSON을 반환하지 않았습니다.", { cause: error })
  }
  if (!Array.isArray(value)) {
    throw new Error("pm2 jlist 결과가 배열이 아닙니다.")
  }
  return value.map((entry, index) => {
    if (!isRecord(entry) || typeof entry["name"] !== "string" || !isRecord(entry["pm2_env"])) {
      throw new Error(`pm2 jlist의 ${index}번 프로세스가 올바르지 않습니다.`)
    }
    const environment = entry["pm2_env"]
    if (typeof environment["status"] !== "string") {
      throw new Error(`pm2 jlist의 ${entry["name"]} 프로세스가 올바르지 않습니다.`)
    }
    return {
      name: entry["name"],
      status: environment["status"],
      uptime: parseNumber(environment["pm_uptime"], "pm_uptime"),
      // 실행 중이 아닌 프로세스는 0이다.
      pid: parseNumber(entry["pid"], "pid"),
    }
  })
}

export const readSymphonyProcesses = async (pm2Path: string): Promise<Map<string, Pm2Process>> => {
  await runProcess(pm2Path, ["ping"], "capture")
  const processes = parsePm2Processes(await runProcess(pm2Path, ["jlist"], "capture")).filter(
    (processInfo) => processInfo.name.startsWith(PROCESS_PREFIX),
  )
  const result = new Map<string, Pm2Process>()
  for (const processInfo of processes) {
    if (result.has(processInfo.name)) {
      throw new Error(`pm2에 같은 이름의 프로세스가 여러 개 있습니다: ${processInfo.name}`)
    }
    result.set(processInfo.name, processInfo)
  }
  return result
}
