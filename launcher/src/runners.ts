import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { join } from "node:path"

import { LOGS_ROOT, NOTIFIER_PROCESS_NAME, PROCESS_PREFIX, ROOT } from "./constants.ts"
import { buildEnv, readSharedEnv } from "./env.ts"
import { prepareNotifier, startOrRestartNotifier, stopNotifier } from "./notifier.ts"
import { mutatePm2, startPm2App, withSavedPm2Changes } from "./pm2-actions.ts"
import type { Pm2MutationContext } from "./pm2-actions.ts"
import { formatUptime, readSymphonyProcesses } from "./pm2.ts"
import type { Pm2Process } from "./pm2.ts"
import { findExecutable } from "./process.ts"
import {
  formatProcessName,
  formatRef,
  instanceId,
  lookupInstance,
  lookupTarget,
  parseInstanceId,
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
  join(LOGS_ROOT, instanceId(instance.alias, instance.workflow)),
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

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const matchesProcess = (
  name: string,
  alias: string | undefined,
  workflow: WorkflowName | undefined,
): boolean => {
  const ref = parseInstanceId(name.slice(PROCESS_PREFIX.length))
  // 인스턴스 ID로 해석되지 않는 프로세스(알림 서버)는 인스턴스 명령의 대상이 아니다.
  if (ref === undefined) return false
  return (
    (alias === undefined || ref.alias === alias) &&
    (workflow === undefined || ref.workflow === workflow)
  )
}

const runningRefs = (
  processes: Map<string, Pm2Process>,
  workflow: WorkflowName | undefined,
): InstanceRef[] =>
  Array.from(processes.keys())
    .toSorted()
    .flatMap((name) => {
      const ref = parseInstanceId(name.slice(PROCESS_PREFIX.length))
      if (ref === undefined || (workflow !== undefined && ref.workflow !== workflow)) return []
      return [ref]
    })

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
  return runningRefs(processes, workflow).map((ref) => lookupInstance(registry, ref))
}

interface StartContext {
  command: "start" | "restart"
  misePath: string
  processes: Map<string, Pm2Process>
  sharedEnv: Record<string, string>
  mutation: Pm2MutationContext
}

const startInstance = async (instance: Instance, context: StartContext): Promise<void> => {
  const name = processName(instance.alias, instance.workflow)
  const label = formatRef(instance)
  const existing = context.processes.get(name)
  if (context.command === "start" && existing?.status === "online") {
    console.info(`${label}: 실행 중 (${formatUptime(existing.startedAt)})`)
    return
  }
  try {
    if (existing !== undefined) {
      await mutatePm2(context.mutation, ["delete", name])
    }
    await startPm2App(context.mutation, {
      name,
      script: context.misePath,
      args: buildArgs(instance),
      cwd: ROOT,
      env: buildEnv(instance, context.sharedEnv),
    })
  } catch (error) {
    const action = context.command === "start" ? "시작" : "재시작"
    throw new Error(`${label}: ${action} 실패: ${errorMessage(error)}`, { cause: error })
  }
  console.info(`${label}: 시작됨`)
}

const startInstances = async (instances: Instance[], context: StartContext): Promise<void> => {
  const startNext = async (index: number): Promise<void> => {
    const instance = instances[index]
    if (instance === undefined) return
    await startInstance(instance, context)
    await startNext(index + 1)
  }
  await startNext(0)
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
): Promise<void> => {
  const { all, withNotifier } = options
  const registry = await readRegistry()
  const pm2Path = await findExecutable("pm2")
  const misePath = await findExecutable("mise")
  const processes = await readSymphonyProcesses(pm2Path)

  const instances = resolveStartTargets(registry, processes, { aliases, workflow, all })
  if (instances.length === 0 && !withNotifier) {
    console.info("대상 인스턴스가 없습니다.")
    return
  }

  const sharedEnv = await readSharedEnv()
  await Promise.all(instances.map((instance) => requireWorkflowFile(instance)))
  const notifier = withNotifier ? await prepareNotifier(sharedEnv) : undefined

  await withSavedPm2Changes(pm2Path, async (mutation) => {
    if (notifier !== undefined) {
      await startOrRestartNotifier(
        command === "start" ? "start" : "restart",
        processes.get(NOTIFIER_PROCESS_NAME),
        notifier,
        mutation,
      )
    }
    if (instances.length === 0) {
      console.info("대상 인스턴스가 없습니다.")
      return
    }
    await startInstances(instances, { command, misePath, processes, sharedEnv, mutation })
  })
}

const stopProcesses = async (
  context: Pm2MutationContext,
  names: string[],
  index: number,
): Promise<void> => {
  const name = names[index]
  if (name === undefined) return
  try {
    await mutatePm2(context, ["delete", name])
  } catch (error) {
    throw new Error(`${formatProcessName(name)}: 중지 실패: ${errorMessage(error)}`, {
      cause: error,
    })
  }
  console.info(`${formatProcessName(name)}: 중지됨`)
  await stopProcesses(context, names, index + 1)
}

// 등록된 프로세스는 모두 실행 중이어야 하므로 중지는 pm2 stop이 아니라 delete로 등록을 해제한다.
export const runStop = async (
  aliases: string[],
  workflow: WorkflowName | undefined,
  withNotifier = false,
): Promise<void> => {
  const pm2Path = await findExecutable("pm2")
  const processes = await readSymphonyProcesses(pm2Path)
  // 중지 대상은 레지스트리가 아니라 실행 중인 프로세스에서 해석한다.
  const names = Array.from(processes.keys())
    .toSorted()
    .filter((name) =>
      aliases.length > 0
        ? aliases.some((alias) => matchesProcess(name, alias, workflow))
        : matchesProcess(name, undefined, workflow),
    )
  const notifier = processes.get(NOTIFIER_PROCESS_NAME)
  if (names.length === 0 && (!withNotifier || notifier === undefined)) {
    console.info("대상 프로세스가 없습니다.")
    return
  }

  await withSavedPm2Changes(pm2Path, async (mutation) => {
    await stopProcesses(mutation, names, 0)
    if (withNotifier) await stopNotifier(notifier, mutation)
  })
}

// 알림 서버는 인스턴스가 아니라 머신당 하나뿐인 프로세스라 별칭도 워크플로도 없다.
export const runNotifier = async (action: "start" | "stop" | "restart"): Promise<void> => {
  const pm2Path = await findExecutable("pm2")
  const existing = (await readSymphonyProcesses(pm2Path)).get(NOTIFIER_PROCESS_NAME)

  if (action === "stop") {
    if (existing === undefined) {
      console.info("대상 프로세스가 없습니다.")
      return
    }
    await withSavedPm2Changes(pm2Path, (mutation) => stopNotifier(existing, mutation))
    return
  }

  // 기존 프로세스를 지운 뒤 시작에 실패해 아무것도 실행되지 않는 상태를 피하려고 먼저 확인한다.
  const sharedEnv = await readSharedEnv()
  const notifier = await prepareNotifier(sharedEnv)
  await withSavedPm2Changes(pm2Path, (mutation) =>
    startOrRestartNotifier(action, existing, notifier, mutation),
  )
}
