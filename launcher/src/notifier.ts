import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { NOTIFIER_PROCESS_NAME, NOTIFIER_ROOT } from "./constants.ts"
import { buildNotifierEnv } from "./env.ts"
import { OperationError } from "./output.ts"
import type { OperationResult, OperationTarget } from "./output.ts"
import { mutatePm2, startPm2App } from "./pm2-actions.ts"
import type { Pm2MutationContext } from "./pm2-actions.ts"
import type { Pm2Process } from "./pm2.ts"

const HEALTH_TIMEOUT_MS = 10_000
const HEALTH_REQUEST_TIMEOUT_MS = 1_000
const HEALTH_RETRY_MS = 100

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export interface PreparedNotifier {
  env: Record<string, string>
  healthResponse: string
  healthUrl: string
}

const NOTIFIER_TARGET: OperationTarget = { type: "notifier" }

const loadNotifierConfigModule = async (): Promise<typeof import("symphony-notifier/config")> => {
  try {
    await access(join(NOTIFIER_ROOT, "node_modules"), constants.R_OK)
    return await import("symphony-notifier/config")
  } catch (error) {
    throw new Error("알림 서버 의존성이 없습니다. notifier/에서 pnpm install을 실행하세요.", {
      cause: error,
    })
  }
}

export const prepareNotifier = async (
  sharedEnv: Record<string, string>,
): Promise<PreparedNotifier> => {
  const configModule = await loadNotifierConfigModule()
  try {
    const config = configModule.loadConfig(sharedEnv)
    return {
      env: buildNotifierEnv(sharedEnv),
      healthResponse: configModule.NOTIFIER_HEALTH_RESPONSE,
      healthUrl: `http://127.0.0.1:${config.port}${configModule.NOTIFIER_HEALTH_PATH}`,
    }
  } catch (error) {
    throw new Error(`알림 서버 설정이 올바르지 않습니다: ${errorMessage(error)}`, { cause: error })
  }
}

const notifierIsReady = async (healthUrl: string, expectedResponse: string): Promise<boolean> => {
  try {
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
    })
    return response.status === 200 && (await response.text()) === expectedResponse
  } catch (error) {
    if (!(error instanceof Error)) throw error
    // 알림 서버가 HTTP 요청을 받을 때까지 발생하는 연결 실패와 요청 타임아웃은 재시도한다.
    return false
  }
}

const waitForNotifier = async (
  healthUrl: string,
  expectedResponse: string,
  deadline = Date.now() + HEALTH_TIMEOUT_MS,
): Promise<void> => {
  if (await notifierIsReady(healthUrl, expectedResponse)) return
  const remaining = deadline - Date.now()
  if (remaining <= 0) {
    throw new Error(`알림 서버가 ${HEALTH_TIMEOUT_MS / 1_000}초 안에 준비되지 않았습니다.`)
  }
  await delay(Math.min(HEALTH_RETRY_MS, remaining))
  await waitForNotifier(healthUrl, expectedResponse, deadline)
}

export const startOrRestartNotifier = async (
  action: "start" | "restart",
  existing: Pm2Process | undefined,
  prepared: PreparedNotifier,
  mutation: Pm2MutationContext,
): Promise<OperationResult> => {
  if (action === "start" && existing?.status === "online") {
    try {
      await waitForNotifier(prepared.healthUrl, prepared.healthResponse)
    } catch (error) {
      throw new OperationError("health-check", NOTIFIER_TARGET, error)
    }
    return { target: NOTIFIER_TARGET, outcome: "unchanged" }
  }
  if (existing !== undefined) {
    try {
      await mutatePm2(mutation, ["delete", NOTIFIER_PROCESS_NAME])
    } catch (error) {
      throw new OperationError("delete", NOTIFIER_TARGET, error)
    }
  }
  try {
    await startPm2App(mutation, {
      name: NOTIFIER_PROCESS_NAME,
      script: process.execPath,
      args: ["src/main.ts"],
      cwd: NOTIFIER_ROOT,
      env: prepared.env,
    })
  } catch (error) {
    throw new OperationError("start", NOTIFIER_TARGET, error)
  }
  try {
    await waitForNotifier(prepared.healthUrl, prepared.healthResponse)
  } catch (error) {
    throw new OperationError("health-check", NOTIFIER_TARGET, error)
  }
  return {
    target: NOTIFIER_TARGET,
    outcome: action === "restart" && existing !== undefined ? "restarted" : "started",
  }
}

export const stopNotifier = async (
  existing: Pm2Process | undefined,
  mutation: Pm2MutationContext,
): Promise<OperationResult> => {
  if (existing === undefined) {
    return { target: NOTIFIER_TARGET, outcome: "unchanged" }
  }
  try {
    await mutatePm2(mutation, ["delete", NOTIFIER_PROCESS_NAME])
  } catch (error) {
    throw new OperationError("delete", NOTIFIER_TARGET, error)
  }
  return { target: NOTIFIER_TARGET, outcome: "stopped" }
}
