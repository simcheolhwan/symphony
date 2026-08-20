import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { LOGS_ROOT, NOTIFIER_PROCESS_NAME } from "./constants.mts"
import { buildEnv, readSharedEnv } from "./env.mts"
import { findExecutable, spawnForeground } from "./process.mts"
import { instanceId, lookupInstance, readRegistry } from "./registry.mts"
import type { WorkflowName } from "./registry.mts"
import { buildArgs, requireWorkflowFile } from "./runners.mts"

const LOG_TAIL_LINES = "100"

export const runLogs = async (alias: string, workflow: WorkflowName): Promise<number> => {
  const directory = join(LOGS_ROOT, instanceId(alias, workflow), "log")
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch (error) {
    throw new Error(`로그 디렉터리를 읽을 수 없습니다: ${directory}`, { cause: error })
  }

  const candidates = entries.filter((name) => /^symphony\.log\.\d+$/.test(name))
  if (candidates.length === 0) {
    throw new Error(`로그 파일이 없습니다: ${directory}`)
  }
  // disk_log의 wrap 로그는 파일 여러 개를 순환하므로 마지막으로 기록된 파일을 따라간다.
  const files = await Promise.all(
    candidates.map(async (name) => {
      const path = join(directory, name)
      return { path, modifiedAt: (await stat(path)).mtimeMs }
    }),
  )
  const latest = files.reduce((left, right) => (right.modifiedAt > left.modifiedAt ? right : left))
  return spawnForeground("tail", ["-n", LOG_TAIL_LINES, "-f", latest.path], process.env)
}

// PM2로 띄운 프로세스는 현재 셸이 아니라 PM2 데몬의 (대개 최소) 환경을 물려받으므로,
// 전면 실행도 시스템 필수 변수만 상속해 셸의 임시 변수가 env 파일 누락을 가리는 차이를 없앤다.
const systemEnv = (): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const key of ["HOME", "LANG", "LC_ALL", "TMPDIR"]) {
    const value = process.env[key]
    if (value !== undefined) result[key] = value
  }
  return result
}

export const runForeground = async (alias: string, workflow: WorkflowName): Promise<number> => {
  const instance = lookupInstance(await readRegistry(), { alias, workflow })
  await requireWorkflowFile(instance)
  const misePath = await findExecutable("mise")
  const env = { ...systemEnv(), ...buildEnv(instance, await readSharedEnv()) }
  return spawnForeground(misePath, buildArgs(instance), env)
}

// 알림 서버는 disk_log 대신 표준 출력만 남기므로 pm2 로그를 따라간다.
export const runNotifierLogs = async (): Promise<number> => {
  const pm2Path = await findExecutable("pm2")
  return spawnForeground(pm2Path, ["logs", NOTIFIER_PROCESS_NAME, "--lines", LOG_TAIL_LINES], process.env)
}
