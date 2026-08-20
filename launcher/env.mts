import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { ENV_PATH, WORKSPACE_ROOT } from "./constants.mts"
import { isRecord } from "./guards.mts"
import { instanceId, instanceName, workflowLabel } from "./registry.mts"
import type { Instance } from "./registry.mts"

// source 대신 KEY=VALUE만 해석한다. 값의 따옴표 한 겹은 벗기고 변수 확장과 이스케이프는 지원하지 않는다.
const parseEnvFile = (text: string): Record<string, string> => {
  const result: Record<string, string> = {}
  text.split("\n").forEach((rawLine, index) => {
    const line = rawLine.trim()
    if (line === "" || line.startsWith("#")) return
    const separator = line.indexOf("=")
    if (separator <= 0) {
      // 값에 비밀이 들어 있을 수 있으므로 줄 내용은 출력하지 않는다.
      throw new Error(`${ENV_PATH} ${index + 1}번째 줄이 KEY=VALUE 형식이 아닙니다.`)
    }
    const name = line
      .slice(0, separator)
      .replace(/^export\s+/, "")
      .trim()
    const value = line.slice(separator + 1).trim()
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    result[name] = quoted ? value.slice(1, -1) : value
  })
  return result
}

export const readSharedEnv = async (): Promise<Record<string, string>> => {
  try {
    return parseEnvFile(await readFile(ENV_PATH, "utf8"))
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") {
      throw new Error(`공통 환경변수 파일이 없습니다: ${ENV_PATH}`, { cause: error })
    }
    throw error
  }
}

export const buildEnv = (
  instance: Instance,
  sharedEnv: Record<string, string>,
): Record<string, string> => {
  const id = instanceId(instance.alias, instance.workflow)
  const env: Record<string, string> = {
    ...sharedEnv,
    GITHUB_REPO: instance.repo,
    SYMPHONY_WORKSPACE_ROOT: join(WORKSPACE_ROOT, id),
    SYMPHONY_INSTANCE_NAME: instanceName(instance),
    // 알림 본문이 워크플로와 대상을 따로 표시하므로 조립된 인스턴스 이름과 별개로 넘긴다.
    SYMPHONY_WORKFLOW_LABEL: workflowLabel(instance.workflow),
    SYMPHONY_TARGET_NAME: instance.alias,
  }
  if (instance.workflow === "linear") {
    env["LINEAR_PROJECT_SLUG"] = instance.project
  }
  return withCurrentPath(env)
}

export const buildNotifierEnv = (sharedEnv: Record<string, string>): Record<string, string> =>
  withCurrentPath({ ...sharedEnv })

// pm2 데몬이 오래된 PATH를 유지하고 있어도 mise를 찾도록 현재 PATH를 넘긴다.
const withCurrentPath = (env: Record<string, string>): Record<string, string> => {
  const path = process.env["PATH"]
  if (path !== undefined) {
    env["PATH"] = path
  }
  return env
}
