#!/usr/bin/env node

import { runList } from "./list.mts"
import { runForeground, runLogs, runNotifierLogs } from "./logs.mts"
import { WORKFLOW_NAMES, isWorkflowName, requireAlias } from "./registry.mts"
import type { WorkflowName } from "./registry.mts"
import { runNotifier, runStartOrRestart, runStop } from "./runners.mts"

const COMMANDS = ["start", "stop", "restart", "ls", "logs", "run", "notifier"] as const
type Command = (typeof COMMANDS)[number]

const NOTIFIER_ACTIONS = ["start", "stop", "restart", "logs"] as const
type NotifierAction = (typeof NOTIFIER_ACTIONS)[number]

interface ParsedCommand {
  command: Command
  aliases: string[]
  workflow: WorkflowName | undefined
  all: boolean
}

const USAGE = `사용법:
  symphonyctl start <별칭>... [--workflow <워크플로>] | --all
  symphonyctl restart [<별칭>...] [--workflow <워크플로>]
  symphonyctl stop [<별칭>...] [--workflow <워크플로>]
  symphonyctl ls
  symphonyctl logs <별칭> --workflow <워크플로>
  symphonyctl run <별칭> --workflow <워크플로>
  symphonyctl notifier ${NOTIFIER_ACTIONS.join("|")}

워크플로: ${WORKFLOW_NAMES.join(", ")}
--workflow를 생략하면 별칭의 활성 워크플로 전체가 대상이 된다 (logs, run 제외).`

const isCommand = (value: string | undefined): value is Command =>
  COMMANDS.some((command) => command === value)

const isNotifierAction = (value: string | undefined): value is NotifierAction =>
  NOTIFIER_ACTIONS.some((name) => name === value)

// 이 명령의 위치 인자만 별칭이 아니라 동작이다. 알림 서버는 인스턴스가 아니다.
const parseNotifierAction = (aliases: string[]): NotifierAction => {
  const [action] = aliases
  if (aliases.length !== 1 || !isNotifierAction(action)) {
    throw new Error(`notifier 명령어에는 ${NOTIFIER_ACTIONS.join(", ")} 중 하나가 필요합니다.`)
  }
  return action
}

const parseWorkflowOption = (value: string | undefined): WorkflowName => {
  if (value === undefined || !isWorkflowName(value)) {
    throw new Error(`--workflow에는 ${WORKFLOW_NAMES.join(", ")} 중 하나가 필요합니다.`)
  }
  return value
}

const parseCommand = (argv: string[]): ParsedCommand | undefined => {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "help")) {
    return undefined
  }

  const command = argv[0]
  if (!isCommand(command)) {
    throw new Error(`알 수 없는 명령어입니다: ${command}`)
  }

  const args = argv.slice(1)
  const aliases: string[] = []
  let workflow: WorkflowName | undefined
  let all = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--all") {
      all = true
      continue
    }
    if (arg === "--workflow") {
      workflow = parseWorkflowOption(args[index + 1])
      index += 1
      continue
    }
    if (arg === undefined || arg.startsWith("-")) {
      throw new Error(`알 수 없는 옵션입니다: ${arg}`)
    }
    aliases.push(requireAlias(arg))
  }

  if (command === "ls" && (aliases.length > 0 || workflow !== undefined || all)) {
    throw new Error("ls 명령어는 추가 인자를 받지 않습니다.")
  }
  if (command === "notifier" && (workflow !== undefined || all)) {
    throw new Error("notifier 명령어는 --workflow와 --all을 받지 않습니다.")
  }
  if (command === "logs" || command === "run") {
    if (aliases.length !== 1 || workflow === undefined || all) {
      throw new Error(`${command} 명령어에는 별칭 하나와 --workflow가 필요합니다.`)
    }
  }
  if (command === "start" && aliases.length === 0 && !all) {
    throw new Error("start 명령어에는 별칭 또는 --all이 필요합니다.")
  }
  if ((command === "stop" || command === "restart") && all) {
    throw new Error(`${command} 명령어는 --all을 받지 않습니다. 별칭을 생략하면 실행 중인 인스턴스 전체가 대상입니다.`)
  }
  if (all && aliases.length > 0) {
    throw new Error("--all과 별칭은 함께 지정할 수 없습니다.")
  }

  return { command, aliases, workflow, all }
}

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

const main = async (): Promise<number> => {
  const parsed = parseCommand(process.argv.slice(2))
  if (parsed === undefined) {
    console.log(USAGE)
    return 0
  }

  switch (parsed.command) {
    case "start":
    case "restart":
      await runStartOrRestart(parsed.command, parsed.aliases, parsed.workflow, parsed.all)
      return 0
    case "stop":
      await runStop(parsed.aliases, parsed.workflow)
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
      if (action === "logs") return runNotifierLogs()
      await runNotifier(action)
      return 0
    }
  }
}

try {
  process.exitCode = await main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`symphonyctl: ${message}`)
  process.exitCode = 1
}
