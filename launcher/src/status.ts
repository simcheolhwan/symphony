import { z } from "zod"

import { NOTIFIER_PROCESS_NAME } from "./constants.ts"
import { PM2_STATUSES } from "./pm2.ts"
import type { Pm2Process, Pm2Status } from "./pm2.ts"
import { WORKFLOW_NAMES, parseProcessName, processName } from "./registry.ts"
import type { Target, WorkflowName } from "./registry.ts"

export const MACHINE_STATUSES = [
  "online",
  "stopped",
  "partial",
  "transitioning",
  "errored",
] as const
export type MachineAggregateStatus = (typeof MACHINE_STATUSES)[number]

interface ProcessStatus {
  status: Pm2Status
  registered: boolean
  pid: number | null
  startedAt: number | null
}

export interface InstanceStatus extends ProcessStatus {
  alias: string
  workflow: WorkflowName
}

export interface OrphanedProcessStatus extends ProcessStatus {
  processName: string
  alias: string | null
  workflow: WorkflowName | null
}

export interface MachineStatus {
  status: MachineAggregateStatus
  instances: InstanceStatus[]
  orphanedProcesses: OrphanedProcessStatus[]
  notifier: ProcessStatus
}

const processStatusJsonSchema = z.object({
  status: z.enum(PM2_STATUSES),
  registered: z.boolean(),
  pid: z.number().int().positive().nullable(),
  startedAt: z.iso.datetime().nullable(),
})

export const machineStatusJsonSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(MACHINE_STATUSES),
  instances: z.array(
    processStatusJsonSchema.extend({
      alias: z.string(),
      workflow: z.enum(WORKFLOW_NAMES),
    }),
  ),
  orphanedProcesses: z.array(
    processStatusJsonSchema.extend({
      processName: z.string(),
      alias: z.string().nullable(),
      workflow: z.enum(WORKFLOW_NAMES).nullable(),
    }),
  ),
  notifier: processStatusJsonSchema,
})

export type MachineStatusJson = z.infer<typeof machineStatusJsonSchema>

const stoppedStatus = (): ProcessStatus => ({
  status: "stopped",
  registered: false,
  pid: null,
  startedAt: null,
})

const processStatus = (processInfo: Pm2Process | undefined): ProcessStatus =>
  processInfo === undefined
    ? stoppedStatus()
    : {
        status: processInfo.status,
        registered: true,
        pid: processInfo.pid === 0 ? null : processInfo.pid,
        startedAt: processInfo.startedAt === 0 ? null : processInfo.startedAt,
      }

const aggregateStatus = (statuses: Pm2Status[]): MachineAggregateStatus => {
  if (statuses.some((status) => status === "errored")) return "errored"
  if (
    statuses.some(
      (status) =>
        status === "launching" ||
        status === "stopping" ||
        status === "waiting restart" ||
        status === "one-launch-status",
    )
  ) {
    return "transitioning"
  }
  if (statuses.every((status) => status === "stopped")) return "stopped"
  if (statuses.every((status) => status === "online")) return "online"
  return "partial"
}

export const buildMachineStatus = (
  registry: Map<string, Target>,
  processes: Map<string, Pm2Process>,
): MachineStatus => {
  const expectedProcessNames = new Set<string>()
  const instances = Array.from(registry.values())
    .flatMap((target) => Array.from(target.instances.values()))
    .toSorted((left, right) =>
      `${left.alias}\0${left.workflow}`.localeCompare(`${right.alias}\0${right.workflow}`),
    )
    .map((instance): InstanceStatus => {
      const name = processName(instance.alias, instance.workflow)
      expectedProcessNames.add(name)
      return {
        alias: instance.alias,
        workflow: instance.workflow,
        ...processStatus(processes.get(name)),
      }
    })

  const orphanedProcesses = Array.from(processes.values())
    .filter(
      (processInfo) =>
        processInfo.name !== NOTIFIER_PROCESS_NAME && !expectedProcessNames.has(processInfo.name),
    )
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .map((processInfo): OrphanedProcessStatus => {
      const ref = parseProcessName(processInfo.name)
      return {
        processName: processInfo.name,
        alias: ref?.alias ?? null,
        workflow: ref?.workflow ?? null,
        ...processStatus(processInfo),
      }
    })
  const notifier = processStatus(processes.get(NOTIFIER_PROCESS_NAME))
  const statuses = [
    ...instances.map((instance) => instance.status),
    ...orphanedProcesses.map((processInfo) => processInfo.status),
    notifier.status,
  ]
  return { status: aggregateStatus(statuses), instances, orphanedProcesses, notifier }
}

interface SerializedProcessStatus {
  status: Pm2Status
  registered: boolean
  pid: number | null
  startedAt: string | null
}

const serializeProcessStatus = (status: ProcessStatus): SerializedProcessStatus => ({
  status: status.status,
  registered: status.registered,
  pid: status.pid,
  startedAt: status.startedAt === null ? null : new Date(status.startedAt).toISOString(),
})

export const toMachineStatusJson = (status: MachineStatus): MachineStatusJson =>
  machineStatusJsonSchema.parse({
    schemaVersion: 1,
    status: status.status,
    instances: status.instances.map((instance) => ({
      alias: instance.alias,
      workflow: instance.workflow,
      ...serializeProcessStatus(instance),
    })),
    orphanedProcesses: status.orphanedProcesses.map((processInfo) => ({
      processName: processInfo.processName,
      alias: processInfo.alias,
      workflow: processInfo.workflow,
      ...serializeProcessStatus(processInfo),
    })),
    notifier: serializeProcessStatus(status.notifier),
  })

export const serializeMachineStatus = (status: MachineStatus): string =>
  JSON.stringify(toMachineStatusJson(status))
