import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { parseEnv } from "node:util"

import { z } from "zod"

import { ENV_PATH, WORKSPACE_ROOT } from "./constants.ts"
import { isRecord } from "./guards.ts"
import { instanceName, instancePath, workflowLabel } from "./registry.ts"
import type { Instance } from "./registry.ts"

// parseEnv의 반환 타입은 값이 undefined일 수 있는 Dict라 스키마로 좁힌다.
const envSchema = z.record(z.string(), z.string())

export const readSharedEnv = async (): Promise<Record<string, string>> => {
  try {
    return envSchema.parse(parseEnv(await readFile(ENV_PATH, "utf8")))
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") {
      throw new Error(`공통 환경변수 파일이 없습니다: ${ENV_PATH}`, { cause: error })
    }
    throw error
  }
}

// pm2 데몬이 오래된 PATH를 유지하고 있어도 mise가 실행하는 도구들이 해석되도록 현재 PATH를 넘긴다.
const withCurrentPath = (env: Record<string, string>): Record<string, string> => {
  const path = process.env["PATH"]
  return path === undefined ? env : { ...env, PATH: path }
}

export const buildEnv = (
  instance: Instance,
  sharedEnv: Record<string, string>,
): Record<string, string> => {
  const path = instancePath(instance.alias, instance.workflow)
  const env: Record<string, string> = {
    ...sharedEnv,
    GITHUB_REPO: instance.repo,
    SYMPHONY_WORKSPACE_ROOT: join(WORKSPACE_ROOT, path),
    SYMPHONY_INSTANCE_NAME: instanceName(instance),
    // 알림 본문이 워크플로와 대상을 따로 표시하므로 조립된 인스턴스 이름과 별개로 넘긴다.
    SYMPHONY_WORKFLOW_LABEL: workflowLabel(instance.workflow),
    SYMPHONY_TARGET_NAME: instance.alias,
    SYMPHONY_MODEL_REASONING_EFFORT: instance.effort,
  }
  if (instance.workflow === "linear") {
    env["LINEAR_PROJECT_SLUG"] = instance.project
  }
  // 워크플로가 `${SYMPHONY_MODEL:+...}`로 분기하므로 미지정 모델은 빈 값 대신 생략한다.
  if (instance.model !== undefined) {
    env["SYMPHONY_MODEL"] = instance.model
  }
  return withCurrentPath(env)
}

export const buildNotifierEnv = (sharedEnv: Record<string, string>): Record<string, string> =>
  withCurrentPath(sharedEnv)
