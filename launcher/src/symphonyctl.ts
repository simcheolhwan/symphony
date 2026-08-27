#!/usr/bin/env node

import { USAGE, parseCommand, parseNotifierAction } from "./command.ts"
import { runList } from "./list.ts"
import { runForeground, runLogs } from "./logs.ts"
import { serializeErrorResponse, serializeOperationResponse } from "./output.ts"
import type { WorkflowName } from "./registry.ts"
import { runNotifier, runStartOrRestart, runStop } from "./runners.ts"

const singleAlias = (aliases: string[]): string => {
  const [alias] = aliases
  if (alias === undefined) {
    throw new Error("별칭이 필요합니다.")
  }
  return alias
}

const singleWorkflow = (workflow: WorkflowName | undefined): WorkflowName => {
  if (workflow === undefined) {
    throw new Error("--workflow가 필요합니다.")
  }
  return workflow
}

const unreachableCommand = (command: never): never => {
  throw new Error(`처리할 수 없는 명령어입니다: ${String(command)}`)
}

const main = async (): Promise<number> => {
  const parsed = parseCommand(process.argv.slice(2))
  if (parsed === undefined) {
    console.info(USAGE)
    return 0
  }

  switch (parsed.command) {
    case "start":
    case "restart":
      process.stdout.write(
        `${serializeOperationResponse(
          parsed.command,
          await runStartOrRestart(parsed.command, parsed.aliases, parsed.workflow, {
            all: parsed.all,
            withNotifier: parsed.withNotifier,
          }),
        )}\n`,
      )
      return 0
    case "stop":
      process.stdout.write(
        `${serializeOperationResponse(
          "stop",
          await runStop(parsed.aliases, parsed.workflow, parsed.withNotifier),
        )}\n`,
      )
      return 0
    case "ls":
      await runList()
      return 0
    case "logs":
      return runLogs(singleAlias(parsed.aliases), singleWorkflow(parsed.workflow))
    case "run":
      return runForeground(singleAlias(parsed.aliases), singleWorkflow(parsed.workflow))
    case "notifier": {
      const action = parseNotifierAction(parsed.aliases)
      process.stdout.write(`${serializeOperationResponse(action, await runNotifier(action))}\n`)
      return 0
    }
    default:
      return unreachableCommand(parsed.command)
  }
}

try {
  process.exitCode = await main()
} catch (error) {
  process.stderr.write(`${serializeErrorResponse(error)}\n`)
  process.exitCode = 1
}
