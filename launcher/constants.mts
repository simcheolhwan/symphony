import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HOME = homedir()

// 이 파일은 launcher/에 있으므로 부모가 저장소 루트다.
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

export const REGISTRY_PATH = join(HOME, ".config", "symphony", "targets.json")
export const ENV_PATH = join(HOME, ".config", "symphony", "env")
export const WORKSPACE_ROOT = join(HOME, ".symphony")
export const LOGS_ROOT = join(HOME, ".local", "state", "symphony")
export const PROCESS_PREFIX = "symphony-"

export const NOTIFIER_ROOT = join(ROOT, "notifier")
export const NOTIFIER_PROCESS_NAME = `${PROCESS_PREFIX}notifier`
