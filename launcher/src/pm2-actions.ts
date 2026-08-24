import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runProcess } from "./process.ts"

export interface Pm2App {
  name: string
  script: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

export interface Pm2MutationContext {
  pm2Path: string
  changed: boolean
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const mutatePm2 = async (context: Pm2MutationContext, args: string[]): Promise<void> => {
  // 명령이 실패해도 PM2가 일부 상태를 바꿨을 수 있으므로 실행 전에 변경으로 표시한다.
  context.changed = true
  await runProcess(context.pm2Path, args, "inherit")
}

const savePm2Changes = async (context: Pm2MutationContext): Promise<void> => {
  if (!context.changed) return
  try {
    // --force를 사용해야 프로세스가 0개인 경우에도 현재 상태가 스냅샷에 반영된다.
    await runProcess(context.pm2Path, ["save", "--force"], "inherit")
  } catch (error) {
    throw new Error(`PM2 상태 저장 실패: ${errorMessage(error)}`, { cause: error })
  }
}

export const withSavedPm2Changes = async (
  pm2Path: string,
  operation: (context: Pm2MutationContext) => Promise<void>,
): Promise<void> => {
  const context: Pm2MutationContext = { pm2Path, changed: false }
  try {
    await operation(context)
  } catch (operationError) {
    try {
      // 롤백하지 않고 성공한 변경을 현재 PM2 상태 그대로 보존한다.
      await savePm2Changes(context)
    } catch (saveError) {
      throw new Error(`${errorMessage(operationError)}; ${errorMessage(saveError)}`, {
        cause: saveError,
      })
    }
    throw operationError
  }
  await savePm2Changes(context)
}

// PM2 CLI 인자로는 `env`를 넘길 수 없어 설정 파일을 경유해 시작한다.
export const startPm2App = async (context: Pm2MutationContext, app: Pm2App): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), "symphonyctl-"))
  const configPath = join(directory, "symphony.config.json")
  const config = {
    apps: [
      {
        ...app,
        interpreter: "none",
        exec_mode: "fork",
        min_uptime: 10_000,
        max_restarts: 5,
        kill_timeout: 15_000,
        stop_signal: "SIGTERM",
      },
    ],
  }
  try {
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
    await mutatePm2(context, ["start", configPath])
  } finally {
    // 이 경로는 현재 호출이 만든 운영체제 임시 디렉터리만 가리킨다.
    await rm(directory, { recursive: true, force: true })
  }
}
