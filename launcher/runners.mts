import { constants } from "node:fs"
import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LOGS_ROOT, NOTIFIER_PROCESS_NAME, NOTIFIER_ROOT, PROCESS_PREFIX, ROOT } from "./constants.mts"
import { buildEnv, buildNotifierEnv, readSharedEnv } from "./env.mts"
import { formatUptime, readSymphonyProcesses } from "./pm2.mts"
import type { Pm2Process } from "./pm2.mts"
import { findExecutable, runProcess } from "./process.mts"
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
} from "./registry.mts"
import type { Instance, InstanceRef, Target, WorkflowName } from "./registry.mts"

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

interface Pm2App {
  name: string
  script: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

// pm2 CLI 인자로는 env를 넘길 수 없어 설정 파일을 경유해 시작한다.
const startFromConfig = async (pm2Path: string, app: Pm2App): Promise<void> => {
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
    await runProcess(pm2Path, ["start", configPath], "inherit")
  } finally {
    // 이 경로는 현재 호출이 만든 운영체제 임시 디렉터리만 가리킨다.
    await rm(directory, { recursive: true, force: true })
  }
}

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
  aliases: string[],
  workflow: WorkflowName | undefined,
  all: boolean,
): Instance[] => {
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

export const runStartOrRestart = async (
  command: "start" | "restart",
  aliases: string[],
  workflow: WorkflowName | undefined,
  all: boolean,
): Promise<void> => {
  const registry = await readRegistry()
  const pm2Path = await findExecutable("pm2")
  const misePath = await findExecutable("mise")
  const processes = await readSymphonyProcesses(pm2Path)

  const instances = resolveStartTargets(registry, processes, aliases, workflow, all)
  if (instances.length === 0) {
    console.log("대상 인스턴스가 없습니다.")
    return
  }

  const sharedEnv = await readSharedEnv()
  for (const instance of instances) {
    await requireWorkflowFile(instance)
  }

  let changed = false
  try {
    for (const instance of instances) {
      const name = processName(instance.alias, instance.workflow)
      const label = formatRef(instance)
      const existing = processes.get(name)
      if (command === "start" && existing?.status === "online") {
        console.log(`${label}: 실행 중 (${formatUptime(existing.uptime)})`)
        continue
      }
      if (existing !== undefined) {
        await runProcess(pm2Path, ["delete", name], "inherit")
      }
      await startFromConfig(pm2Path, {
        name,
        script: misePath,
        args: buildArgs(instance),
        cwd: ROOT,
        env: buildEnv(instance, sharedEnv),
      })
      changed = true
      console.log(`${label}: 시작됨`)
    }
  } finally {
    // 시작 도중 실패해도 그때까지 시작한 프로세스는 재부팅 후 복원되어야 한다.
    if (changed) {
      // --force를 사용해야 프로세스가 0개인 경우에도 현재 상태가 스냅샷에 반영된다.
      await runProcess(pm2Path, ["save", "--force"], "inherit")
    }
  }
}

// 등록된 프로세스는 모두 실행 중이어야 하므로 중지는 pm2 stop이 아니라 delete로 등록을 해제한다.
export const runStop = async (
  aliases: string[],
  workflow: WorkflowName | undefined,
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
  if (names.length === 0) {
    console.log("대상 프로세스가 없습니다.")
    return
  }

  for (const name of names) {
    await runProcess(pm2Path, ["delete", name], "inherit")
    console.log(`${formatProcessName(name)}: 중지됨`)
  }
  await runProcess(pm2Path, ["save", "--force"], "inherit")
}

const requireNotifierDeps = async (): Promise<void> => {
  try {
    await access(join(NOTIFIER_ROOT, "node_modules"), constants.R_OK)
  } catch (error) {
    throw new Error("알림 서버 의존성이 없습니다. notifier/에서 pnpm install을 실행하세요.", {
      cause: error,
    })
  }
}

// 알림 서버는 인스턴스가 아니라 머신당 하나뿐인 프로세스라 별칭도 워크플로도 없다.
export const runNotifier = async (action: "start" | "stop" | "restart"): Promise<void> => {
  const pm2Path = await findExecutable("pm2")
  const existing = (await readSymphonyProcesses(pm2Path)).get(NOTIFIER_PROCESS_NAME)

  if (action === "stop") {
    if (existing === undefined) {
      console.log("대상 프로세스가 없습니다.")
      return
    }
    await runProcess(pm2Path, ["delete", NOTIFIER_PROCESS_NAME], "inherit")
    await runProcess(pm2Path, ["save", "--force"], "inherit")
    console.log("알림: 중지됨")
    return
  }

  if (action === "start" && existing?.status === "online") {
    console.log(`알림: 실행 중 (${formatUptime(existing.uptime)})`)
    return
  }

  // 기존 프로세스를 지운 뒤 시작에 실패해 아무것도 실행되지 않는 상태를 피하려고 먼저 확인한다.
  await requireNotifierDeps()
  const env = buildNotifierEnv(await readSharedEnv())
  if (existing !== undefined) {
    await runProcess(pm2Path, ["delete", NOTIFIER_PROCESS_NAME], "inherit")
  }
  await startFromConfig(pm2Path, {
    name: NOTIFIER_PROCESS_NAME,
    script: process.execPath,
    args: ["src/main.ts"],
    cwd: NOTIFIER_ROOT,
    env,
  })
  await runProcess(pm2Path, ["save", "--force"], "inherit")
  console.log("알림: 시작됨")
}
