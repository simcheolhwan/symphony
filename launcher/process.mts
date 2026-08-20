import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { resolve } from "node:path"
import { ROOT } from "./constants.mts"
import { isRecord } from "./guards.mts"

export const findExecutable = async (command: string): Promise<string> => {
  const pathValue = process.env["PATH"]
  if (pathValue === undefined) {
    throw new Error("PATH가 설정되지 않았습니다.")
  }
  for (const directory of pathValue.split(":")) {
    const candidate = resolve(directory || ".", command)
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch (error) {
      if (isRecord(error) && (error["code"] === "ENOENT" || error["code"] === "EACCES")) {
        continue
      }
      throw error
    }
  }
  throw new Error(`PATH에서 명령어를 찾을 수 없습니다: ${command}`)
}

export const runProcess = async (
  command: string,
  args: string[],
  stdio: "inherit" | "capture",
): Promise<string> =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    if (stdio === "capture") {
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk))
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk))
    }
    child.on("error", rejectPromise)
    child.on("close", (code, signal) => {
      const output = Buffer.concat(stdout).toString("utf8")
      const errorOutput = Buffer.concat(stderr).toString("utf8")
      if (code !== 0) {
        const detail = errorOutput.trim() || output.trim() || `시그널 ${signal ?? "알 수 없음"}`
        rejectPromise(new Error(`${command} ${args.join(" ")} 실패: ${detail}`))
        return
      }
      resolvePromise(output)
    })
  })

export const spawnForeground = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: "inherit", cwd: ROOT, env })
    child.on("error", rejectPromise)
    child.on("close", (code, signal) => resolvePromise(code ?? (signal === "SIGINT" ? 130 : 143)))
  })
