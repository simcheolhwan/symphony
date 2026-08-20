import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { PROCESS_PREFIX, REGISTRY_PATH, ROOT } from "./constants.mts"
import { isRecord } from "./guards.mts"

const DEFAULT_EFFORT = "xhigh"

export const WORKFLOW_NAMES = ["linear", "pr-reviewer", "pr-author"] as const
export type WorkflowName = (typeof WORKFLOW_NAMES)[number]

const WORKFLOW_LABELS: Readonly<Record<WorkflowName, string>> = {
  linear: "Linear",
  "pr-reviewer": "PR 리뷰어",
  "pr-author": "PR 저자",
}

// 별칭은 사용자가 정하고, 인스턴스는 별칭과 워크플로의 조합이다.
interface InstanceFields {
  alias: string
  repo: string
  model: string | undefined
  effort: string
}

export type Instance =
  | (InstanceFields & { workflow: "linear"; project: string })
  | (InstanceFields & { workflow: "pr-reviewer" | "pr-author" })

export interface Target {
  alias: string
  instances: Map<WorkflowName, Instance>
}

export interface InstanceRef {
  alias: string
  workflow: WorkflowName
}

const ALIAS_PATTERN = /^[a-z0-9-]+$/

export const isWorkflowName = (value: string): value is WorkflowName =>
  WORKFLOW_NAMES.some((name) => name === value)

export const requireAlias = (value: string): string => {
  if (!ALIAS_PATTERN.test(value)) {
    throw new Error(`별칭은 소문자, 숫자, -로만 이루어져야 합니다: ${value}`)
  }
  return value
}

// pm2 프로세스 이름, 워크스페이스 경로, 로그 경로만 이 식별자에서 파생하고 사용자에게는 노출하지 않는다.
export const instanceId = (alias: string, workflow: WorkflowName): string => `${alias}-${workflow}`

export const processName = (alias: string, workflow: WorkflowName): string =>
  `${PROCESS_PREFIX}${instanceId(alias, workflow)}`

// 별칭에도 -가 들어가므로 워크플로 이름을 접미사로 떼어 별칭을 복원한다.
export const parseInstanceId = (id: string): InstanceRef | undefined => {
  const workflow = WORKFLOW_NAMES.find((name) => id.endsWith(`-${name}`))
  if (workflow === undefined) return undefined
  const alias = id.slice(0, -(workflow.length + 1))
  return alias === "" ? undefined : { alias, workflow }
}

export const formatRef = (ref: InstanceRef): string => `${ref.alias} (${ref.workflow})`

export const formatProcessName = (name: string): string => {
  const id = name.slice(PROCESS_PREFIX.length)
  const ref = parseInstanceId(id)
  return ref === undefined ? id : formatRef(ref)
}

export const workflowLabel = (workflow: WorkflowName): string => WORKFLOW_LABELS[workflow]

export const instanceName = (instance: Instance): string =>
  `${workflowLabel(instance.workflow)} · ${instance.alias}`

export const workflowPath = (instance: Instance): string =>
  join(ROOT, "workflows", `${instance.workflow}.md`)

const requireString = (record: Record<string, unknown>, field: string, context: string): string => {
  const value = record[field]
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${context}의 ${field} 값이 비어 있지 않은 문자열이어야 합니다.`)
  }
  return value.trim()
}

const optionalString = (
  record: Record<string, unknown>,
  field: string,
  context: string,
): string | undefined =>
  record[field] === undefined ? undefined : requireString(record, field, context)

const parseTarget = (alias: string, value: unknown): Target => {
  requireAlias(alias)
  if (!isRecord(value)) {
    throw new Error(`${alias} target 설정이 객체가 아닙니다.`)
  }
  const repo = requireString(value, "repo", `${alias} target`)
  const project = optionalString(value, "project", `${alias} target`)
  const workflows = value["workflows"]
  if (!isRecord(workflows)) {
    throw new Error(`${alias} target의 workflows가 객체가 아닙니다.`)
  }

  const instances = new Map<WorkflowName, Instance>()
  for (const [name, config] of Object.entries(workflows)) {
    if (!isWorkflowName(name)) {
      throw new Error(`${alias} target에 알 수 없는 워크플로가 있습니다: ${name}`)
    }
    const context = `${alias} target의 ${name} 워크플로`
    if (!isRecord(config)) {
      throw new Error(`${context} 설정이 객체가 아닙니다.`)
    }
    const fields: InstanceFields = {
      alias,
      repo,
      model: optionalString(config, "model", context),
      effort: optionalString(config, "model_reasoning_effort", context) ?? DEFAULT_EFFORT,
    }
    if (name === "linear") {
      if (project === undefined) {
        throw new Error(`${alias} target은 linear 워크플로를 켰으므로 project가 필요합니다.`)
      }
      instances.set(name, { ...fields, workflow: name, project })
    } else {
      instances.set(name, { ...fields, workflow: name })
    }
  }
  return { alias, instances }
}

export const readRegistry = async (): Promise<Map<string, Target>> => {
  let text: string
  try {
    text = await readFile(REGISTRY_PATH, "utf8")
  } catch (error) {
    throw new Error(`target 레지스트리를 읽지 못했습니다: ${REGISTRY_PATH}`, { cause: error })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`${REGISTRY_PATH}가 유효한 JSON이 아닙니다.`, { cause: error })
  }
  if (!isRecord(parsed)) {
    throw new Error(`${REGISTRY_PATH}의 최상위 값이 객체가 아닙니다.`)
  }

  const registry = new Map<string, Target>()
  for (const [alias, value] of Object.entries(parsed)) {
    registry.set(alias, parseTarget(alias, value))
  }
  return registry
}

export const lookupTarget = (registry: Map<string, Target>, alias: string): Target => {
  const target = registry.get(alias)
  if (target === undefined) {
    throw new Error(`레지스트리에 없는 별칭입니다: ${alias}`)
  }
  return target
}

// 별칭만 주면 그 별칭의 활성 워크플로 전체가 대상이다.
export const selectInstances = (
  target: Target,
  workflow: WorkflowName | undefined,
): Instance[] => {
  if (workflow === undefined) {
    const instances = Array.from(target.instances.values())
    if (instances.length === 0) {
      throw new Error(`${target.alias} target에 활성 워크플로가 없습니다.`)
    }
    return instances
  }
  const instance = target.instances.get(workflow)
  if (instance === undefined) {
    throw new Error(`${target.alias} target에 ${workflow} 워크플로가 없습니다.`)
  }
  return [instance]
}

export const lookupInstance = (registry: Map<string, Target>, ref: InstanceRef): Instance => {
  const instance = lookupTarget(registry, ref.alias).instances.get(ref.workflow)
  if (instance === undefined) {
    throw new Error(`${ref.alias} target에 ${ref.workflow} 워크플로가 없습니다.`)
  }
  return instance
}
