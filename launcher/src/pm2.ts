import { z } from "zod"

import { PROCESS_PREFIX } from "./constants.ts"
import { runProcess } from "./process.ts"

export const PM2_STATUSES = [
  "online",
  "launching",
  "stopping",
  "stopped",
  "errored",
  "waiting restart",
  "one-launch-status",
] as const
export type Pm2Status = (typeof PM2_STATUSES)[number]

export interface Pm2Process {
  name: string
  status: Pm2Status
  startedAt: number
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

const pm2ProcessSchema = z
  .object({
    name: z.string(),
    pm2_env: z.object({
      status: z.enum(PM2_STATUSES),
      pm_uptime: z.number().min(0).max(253_402_300_799_999),
    }),
    // 실행 중이 아닌 프로세스는 0이다.
    pid: z.number().int().nonnegative(),
  })
  .transform(({ name, pid, pm2_env: environment }): Pm2Process => ({
    name,
    status: environment.status,
    startedAt: environment.pm_uptime,
    pid,
  }))

const pm2ProcessesSchema = z.array(pm2ProcessSchema)

const parsePm2Json = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error("pm2 jlist가 유효한 JSON을 반환하지 않았습니다.", { cause: error })
  }
}

export const parsePm2Processes = (text: string): Pm2Process[] => {
  const value = parsePm2Json(text)
  const result = pm2ProcessesSchema.safeParse(value)
  if (result.success) return result.data

  const path = result.error.issues[0]?.path ?? []
  const [index, parent] = path
  if (typeof index !== "number") {
    throw new TypeError("pm2 jlist 결과가 배열이 아닙니다.", { cause: result.error })
  }

  const field = path.at(-1)
  if (field === "pm_uptime" || field === "pid") {
    throw new TypeError(`pm2 jlist의 ${field} 값이 올바르지 않습니다.`, { cause: result.error })
  }
  if (parent === "pm2_env" && field === "status" && Array.isArray(value)) {
    const name = z.object({ name: z.string() }).safeParse(value[index])
    if (name.success) {
      throw new TypeError(`pm2 jlist의 ${name.data.name} 프로세스가 올바르지 않습니다.`, {
        cause: result.error,
      })
    }
  }
  throw new Error(`pm2 jlist의 ${index}번 프로세스가 올바르지 않습니다.`, {
    cause: result.error,
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
