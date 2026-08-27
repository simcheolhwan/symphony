import { readSymphonyProcesses } from "./pm2.ts"
import type { Pm2Process } from "./pm2.ts"
import { findExecutable } from "./process.ts"
import { readRegistry } from "./registry.ts"
import type { Target } from "./registry.ts"
import { buildMachineStatus, serializeMachineStatus } from "./status.ts"

export const printMachineStatus = (
  registry: Map<string, Target>,
  processes: Map<string, Pm2Process>,
): void => {
  process.stdout.write(`${serializeMachineStatus(buildMachineStatus(registry, processes))}\n`)
}

export const runList = async (): Promise<void> => {
  const pm2Path = await findExecutable("pm2")
  const processes = await readSymphonyProcesses(pm2Path)
  printMachineStatus(await readRegistry(), processes)
}
