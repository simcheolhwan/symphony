#!/usr/bin/env node

import { USAGE, parseCommand, parseNotifierAction } from "./command.ts"
import { runList } from "./list.ts"
import { runForeground, runLogs, runNotifierLogs } from "./logs.ts"
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
      await runStartOrRestart(parsed.command, parsed.aliases, parsed.workflow, {
        all: parsed.all,
        withNotifier: parsed.withNotifier,
      })
      return 0
    case "stop":
      await runStop(parsed.aliases, parsed.workflow, parsed.withNotifier)
      return 0
    case "ls":
      await runList(parsed.json)
      return 0
    case "logs":
      return runLogs(singleAlias(parsed.aliases), singleWorkflow(parsed.workflow))
    case "run":
      return runForeground(singleAlias(parsed.aliases), singleWorkflow(parsed.workflow))
    case "notifier": {
      const action = parseNotifierAction(parsed.aliases)
      if (action === "logs") return runNotifierLogs()
      await runNotifier(action)
      return 0
    }
    default:
      return unreachableCommand(parsed.command)
  }
}

try {
  process.exitCode = await main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`symphonyctl: ${message}`)
  process.exitCode = 1
}
