import { homedir } from "node:os"
import { join, resolve } from "node:path"

const HOME = homedir()

// 이 파일은 launcher/src/에 있으므로 상위 두 단계가 저장소 루트다.
export const ROOT = resolve(import.meta.dirname, "../..")

export const REGISTRY_PATH = join(HOME, ".config", "symphony", "targets.json")
export const ENV_PATH = join(HOME, ".config", "symphony", "env")
export const WORKSPACE_ROOT = join(HOME, ".symphony")
export const LOGS_ROOT = join(HOME, ".local", "state", "symphony")
export const PROCESS_PREFIX = "symphony-"

export const NOTIFIER_ROOT = join(ROOT, "notifier")
export const NOTIFIER_PROCESS_NAME = `${PROCESS_PREFIX}notifier`
