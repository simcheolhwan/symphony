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
}

export const mutatePm2 = async (context: Pm2MutationContext, args: string[]): Promise<void> => {
  await runProcess(context.pm2Path, args, "capture")
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
