import { WORKFLOW_NAMES, isWorkflowName, requireAlias } from "./registry.ts"
import type { WorkflowName } from "./registry.ts"

const COMMANDS = ["start", "stop", "restart", "ls", "logs", "run", "notifier"] as const
export type Command = (typeof COMMANDS)[number]

export const NOTIFIER_ACTIONS = ["start", "stop", "restart"] as const
export type NotifierAction = (typeof NOTIFIER_ACTIONS)[number]

export interface ParsedCommand {
  command: Command
  aliases: string[]
  workflow: WorkflowName | undefined
  all: boolean
  withNotifier: boolean
}

export const USAGE = `사용법:
  symphonyctl start <별칭>... [--workflow <워크플로>] | --all [--workflow <워크플로>] | --all --with-notifier
  symphonyctl restart [<별칭>...] [--workflow <워크플로>] | --with-notifier
  symphonyctl stop [<별칭>...] [--workflow <워크플로>] | --with-notifier
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
export const parseNotifierAction = (aliases: string[]): NotifierAction => {
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

type ParsedArguments = Omit<ParsedCommand, "command">

const parseCommandArguments = (
  args: string[],
  index = 0,
  parsed?: ParsedArguments,
): ParsedArguments => {
  const current = parsed ?? {
    aliases: [],
    workflow: undefined,
    all: false,
    withNotifier: false,
  }
  const arg = args[index]
  if (arg === undefined) return current
  if (arg === "--all") return parseCommandArguments(args, index + 1, { ...current, all: true })
  if (arg === "--with-notifier") {
    return parseCommandArguments(args, index + 1, { ...current, withNotifier: true })
  }
  if (arg === "--workflow") {
    return parseCommandArguments(args, index + 2, {
      ...current,
      workflow: parseWorkflowOption(args[index + 1]),
    })
  }
  if (arg.startsWith("-")) throw new Error(`알 수 없는 옵션입니다: ${arg}`)
  return parseCommandArguments(args, index + 1, {
    ...current,
    aliases: [...current.aliases, requireAlias(arg)],
  })
}

const validateWithNotifier = ({ command, aliases, workflow, all }: ParsedCommand): void => {
  if (command === "start" && all && aliases.length === 0 && workflow === undefined) return
  if (
    (command === "stop" || command === "restart") &&
    !all &&
    aliases.length === 0 &&
    workflow === undefined
  ) {
    return
  }
  throw new Error(
    "--with-notifier는 start --all, 인자 없는 restart, 인자 없는 stop에서만 사용할 수 있습니다.",
  )
}

const validateCommand = (parsed: ParsedCommand): void => {
  const { command, aliases, workflow, all, withNotifier } = parsed
  if (withNotifier) validateWithNotifier(parsed)
  if (command === "ls" && (aliases.length > 0 || workflow !== undefined || all || withNotifier)) {
    throw new Error("ls 명령어는 추가 인자를 받지 않습니다.")
  }
  if (command === "notifier" && (workflow !== undefined || all || withNotifier)) {
    throw new Error("notifier 명령어는 추가 옵션을 받지 않습니다.")
  }
  if (
    (command === "logs" || command === "run") &&
    (aliases.length !== 1 || workflow === undefined || all || withNotifier)
  ) {
    throw new Error(`${command} 명령어에는 별칭 하나와 --workflow가 필요합니다.`)
  }
  if (command === "start" && aliases.length === 0 && !all) {
    throw new Error("start 명령어에는 별칭 또는 --all이 필요합니다.")
  }
  if ((command === "stop" || command === "restart") && all) {
    throw new Error(
      `${command} 명령어는 --all을 받지 않습니다. 별칭을 생략하면 실행 중인 인스턴스 전체가 대상입니다.`,
    )
  }
  if (all && aliases.length > 0) {
    throw new Error("--all과 별칭은 함께 지정할 수 없습니다.")
  }
}

export const parseCommand = (argv: string[]): ParsedCommand | undefined => {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "help")) {
    return undefined
  }

  const [command] = argv
  if (!isCommand(command)) {
    throw new Error(`알 수 없는 명령어입니다: ${command}`)
  }
  const parsed = { command, ...parseCommandArguments(argv.slice(1)) }
  validateCommand(parsed)
  return parsed
}
