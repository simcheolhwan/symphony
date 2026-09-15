import { homedir } from "node:os"
import { join, resolve } from "node:path"

const HOME = homedir()

// 이 파일은 launcher/src/에 있으므로 상위 두 단계가 저장소 루트다.
export const ROOT = resolve(import.meta.dirname, "../..")

export const REGISTRY_PATH = join(HOME, ".config", "symphony", "targets.json")
export const ENV_PATH = join(HOME, ".config", "symphony", "env")
export const WORKSPACE_ROOT = join(HOME, ".symphony")
export const LOGS_ROOT = join(HOME, ".local", "state", "symphony")
export const PROCESS_PREFIX = "symphony:"

// mise는 저장소 devDependency로 설치되므로 PATH가 아니라 저장소 경로에서 해석한다.
// pnpm의 node_modules/.bin 래퍼는 셸 스크립트라 exec하며 argv[0]을 잃고, mise는 argv[0]으로
// shim 대상을 판별하므로 패키지가 설치한 실행 파일을 직접 가리킨다.
export const MISE_PATH = join(ROOT, "node_modules", "mise", "bin", "mise")

export const NOTIFIER_ROOT = join(ROOT, "notifier")
export const NOTIFIER_PROCESS_NAME = `${PROCESS_PREFIX}notifier`
