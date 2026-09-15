import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { join } from "node:path"

import { LOGS_ROOT, MISE_PATH, NOTIFIER_PROCESS_NAME, ROOT } from "./constants.ts"
import { buildEnv, readSharedEnv } from "./env.ts"
import { prepareNotifier, startOrRestartNotifier, stopNotifier } from "./notifier.ts"
import type { PreparedNotifier } from "./notifier.ts"
import { OperationError } from "./output.ts"
import type { OperationResult, OperationTarget } from "./output.ts"
import { mutatePm2, startPm2App } from "./pm2-actions.ts"
import type { Pm2MutationContext } from "./pm2-actions.ts"
import { readSymphonyProcesses } from "./pm2.ts"
import type { Pm2Process } from "./pm2.ts"
import { findExecutable, requireExecutable } from "./process.ts"
import {
  instancePath,
  lookupInstance,
  lookupTarget,
  parseProcessName,
  processName,
  readRegistry,
  selectInstances,
  workflowPath,
} from "./registry.ts"
import type { Instance, InstanceRef, Target, WorkflowName } from "./registry.ts"

// --port를 넘기지 않으므로 상태 대시보드는 시작되지 않는다. 작업 관측은 Slack 알림과 트래커가 맡는다.
export const buildArgs = (instance: Instance): string[] => [
  "-C",
  join(ROOT, "elixir"),
  "exec",
  "--",
  "./bin/symphony",
  "--logs-root",
  join(LOGS_ROOT, instancePath(instance.alias, instance.workflow)),
  "--i-understand-that-this-will-be-running-without-the-usual-guardrails",
  workflowPath(instance),
]

export const requireWorkflowFile = async (instance: Instance): Promise<void> => {
  const path = workflowPath(instance)
  try {
    await access(path, constants.R_OK)
  } catch (error) {
    throw new Error(`워크플로 파일을 읽을 수 없습니다: ${path}`, { cause: error })
  }
}

const operationTarget = (ref: InstanceRef): OperationTarget => ({
  type: "instance",
  alias: ref.alias,
  workflow: ref.workflow,
})

const runningRefs = (
  processes: Map<string, Pm2Process>,
  aliases: string[],
  workflow: WorkflowName | undefined,
): InstanceRef[] =>
  Array.from(processes.keys())
    .toSorted()
    .flatMap((name) => {
      const ref = parseProcessName(name)
      return ref === undefined ? [] : [ref]
    })
    .filter(
      (ref) =>
        (aliases.length === 0 || aliases.includes(ref.alias)) &&
        (workflow === undefined || ref.workflow === workflow),
    )

const resolveStartTargets = (
  registry: Map<string, Target>,
  processes: Map<string, Pm2Process>,
  options: {
    aliases: string[]
    workflow: WorkflowName | undefined
    all: boolean
  },
): Instance[] => {
  const { aliases, workflow, all } = options
  if (all) {
    return Array.from(registry.values()).flatMap((target) => {
      if (workflow === undefined) return Array.from(target.instances.values())
      // 지정한 워크플로를 켜지 않은 target은 오류 없이 건너뛴다.
      const instance = target.instances.get(workflow)
      return instance === undefined ? [] : [instance]
    })
  }
  if (aliases.length > 0) {
    return aliases.flatMap((alias) => selectInstances(lookupTarget(registry, alias), workflow))
  }
  return runningRefs(processes, [], workflow).map((ref) => lookupInstance(registry, ref))
}

interface StartContext {
  command: "start" | "restart"
  processes: Map<string, Pm2Process>
  sharedEnv: Record<string, string>
  mutation: Pm2MutationContext
}

const startInstance = async (
  instance: Instance,
  context: StartContext,
): Promise<OperationResult> => {
  const name = processName(instance.alias, instance.workflow)
  const target = operationTarget(instance)
  const existing = context.processes.get(name)
  if (context.command === "start" && existing?.status === "online") {
    return { target, outcome: "unchanged" }
  }
  if (existing !== undefined) {
    try {
      await mutatePm2(context.mutation, ["delete", name])
    } catch (error) {
      throw new OperationError("delete", target, error)
    }
  }
  try {
    await startPm2App(context.mutation, {
      name,
      script: MISE_PATH,
      args: buildArgs(instance),
      cwd: ROOT,
      env: buildEnv(instance, context.sharedEnv),
    })
  } catch (error) {
    throw new OperationError("start", target, error)
  }
  return {
    target,
    outcome: context.command === "restart" && existing !== undefined ? "restarted" : "started",
  }
}

const startInstances = (
  instances: Instance[],
  context: StartContext,
): Promise<OperationResult[]> => {
  const startNext = async (
    index: number,
    results: OperationResult[],
  ): Promise<OperationResult[]> => {
    const instance = instances[index]
    if (instance === undefined) return results
    const result = await startInstance(instance, context)
    return startNext(index + 1, [...results, result])
  }
  return startNext(0, [])
}

const validateInstances = async (instances: Instance[]): Promise<void> => {
  await Promise.all(
    instances.map(async (instance) => {
      try {
        await requireWorkflowFile(instance)
      } catch (error) {
        throw new OperationError("validate", operationTarget(instance), error)
      }
    }),
  )
}

const prepareOperationNotifier = async (
  sharedEnv: Record<string, string>,
): Promise<PreparedNotifier> => {
  try {
    return await prepareNotifier(sharedEnv)
  } catch (error) {
    throw new OperationError("validate", { type: "notifier" }, error)
  }
}

interface StartOptions {
  all: boolean
  withNotifier: boolean
}

export const runStartOrRestart = async (
  command: "start" | "restart",
  aliases: string[],
  workflow: WorkflowName | undefined,
  options: StartOptions,
): Promise<OperationResult[]> => {
  const { all, withNotifier } = options
  const registry = await readRegistry()
  const pm2Path = await findExecutable("pm2")
  await requireExecutable(MISE_PATH)
  const processes = await readSymphonyProcesses(pm2Path)

  const instances = resolveStartTargets(registry, processes, { aliases, workflow, all })
  if (instances.length === 0 && !withNotifier) {
    return []
  }

  const sharedEnv = await readSharedEnv()
  await validateInstances(instances)
  const notifier = withNotifier ? await prepareOperationNotifier(sharedEnv) : undefined

  const mutation = { pm2Path }
  const notifierResults =
    notifier === undefined
      ? []
      : [
          await startOrRestartNotifier(
            command,
            processes.get(NOTIFIER_PROCESS_NAME),
            notifier,
            mutation,
          ),
        ]
  return [
    ...notifierResults,
    ...(await startInstances(instances, { command, processes, sharedEnv, mutation })),
  ]
}

const stopProcesses = async (
  context: Pm2MutationContext,
  refs: InstanceRef[],
  index: number,
  results: OperationResult[],
): Promise<OperationResult[]> => {
  const ref = refs[index]
  if (ref === undefined) return results
  const name = processName(ref.alias, ref.workflow)
  const target = operationTarget(ref)
  try {
    await mutatePm2(context, ["delete", name])
  } catch (error) {
    throw new OperationError("delete", target, error)
  }
  return stopProcesses(context, refs, index + 1, [...results, { target, outcome: "stopped" }])
}

// 등록된 프로세스는 모두 실행 중이어야 하므로 중지는 pm2 stop이 아니라 delete로 등록을 해제한다.
export const runStop = async (
  aliases: string[],
  workflow: WorkflowName | undefined,
  withNotifier = false,
): Promise<OperationResult[]> => {
  const pm2Path = await findExecutable("pm2")
  const processes = await readSymphonyProcesses(pm2Path)
  // 중지 대상은 레지스트리가 아니라 실행 중인 프로세스에서 해석한다.
  const refs = runningRefs(processes, aliases, workflow)
  if (refs.length === 0 && !withNotifier) {
    return []
  }

  const mutation = { pm2Path }
  const results = await stopProcesses(mutation, refs, 0, [])
  if (withNotifier) {
    results.push(await stopNotifier(processes.get(NOTIFIER_PROCESS_NAME), mutation))
  }
  return results
}

// 알림 서버는 인스턴스가 아니라 머신당 하나뿐인 프로세스라 별칭도 워크플로도 없다.
export const runNotifier = async (
  action: "start" | "stop" | "restart",
): Promise<OperationResult[]> => {
  const pm2Path = await findExecutable("pm2")
  const existing = (await readSymphonyProcesses(pm2Path)).get(NOTIFIER_PROCESS_NAME)
  const mutation = { pm2Path }

  if (action === "stop") {
    return [await stopNotifier(existing, mutation)]
  }

  // 기존 프로세스를 지운 뒤 시작에 실패해 아무것도 실행되지 않는 상태를 피하려고 먼저 확인한다.
  const sharedEnv = await readSharedEnv()
  const notifier = await prepareOperationNotifier(sharedEnv)
  return [await startOrRestartNotifier(action, existing, notifier, mutation)]
}
