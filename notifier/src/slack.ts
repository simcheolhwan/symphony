import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { ChatPostMessageArguments, WebClient } from "@slack/web-api"

export const THREADS_PATH = join(homedir(), ".config", "symphony", "notifier-threads.json")

// chat.postMessage 인자는 text, blocks, attachments 변형의 유니온이라 SDK가 블록
// 배열 타입을 이름으로 노출하지 않는다. 블록 타입을 다시 정의하지 않도록 인자
// 타입에서 뽑아 쓴다.
export type MessageBlocks = Extract<ChatPostMessageArguments, { blocks: unknown }>["blocks"]

// 상한에서 밀려난 작업의 이벤트는 새 본문으로 시작한다. 항목 하나가 짧은 문자열
// 두 개라 500개는 파일 크기와 메모리 모두 무시할 수 있는 수준이다.
const MAX_THREADS = 500

/** 키별 스레드 매핑과 직렬 게시를 관리하는 WebClient 래퍼 */
export class SlackThreads {
  private readonly threadTs = new Map<string, string>()
  private readonly chains = new Map<string, Promise<void>>()
  private writes: Promise<void> = Promise.resolve()
  private readonly client: WebClient
  private readonly channel: string

  constructor(client: WebClient, channel: string) {
    this.client = client
    this.channel = channel
  }

  /**
   * 저장된 매핑을 읽어 재시작 후에도 같은 작업이 같은 스레드를 쓰게 한다.
   * 파일이 없거나 손상됐으면 빈 상태로 시작한다: 알림은 유실을 허용하는 보조
   * 채널이고, 매핑을 잃은 작업은 새 본문으로 다시 시작하면 된다.
   */
  async load(): Promise<void> {
    const text = await readFile(THREADS_PATH, "utf8").catch((error: unknown) => {
      if (isMissingFile(error)) return undefined
      console.error(`thread mapping read failed: ${THREADS_PATH}`, error)
      return undefined
    })
    if (text === undefined) return

    for (const [key, ts] of parseThreads(text)) {
      this.threadTs.set(key, ts)
    }
  }

  /**
   * 같은 키의 작업을 도착 순서대로 직렬 실행한다. 본문 게시가 끝나 ts를 확보한
   * 뒤에만 답장을 게시할 수 있으므로 이 직렬화가 스레드 정합성의 근거다.
   * 실패는 로그만 남기고 버려 이후 이벤트 게시를 막지 않는다.
   */
  enqueue(key: string, task: () => Promise<void>): void {
    const prev = this.chains.get(key) ?? Promise.resolve()
    const next = prev.then(task).catch((error) => {
      console.error(`slack post failed for ${key}:`, error)
    })
    this.chains.set(key, next)
    void next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key)
    })
  }

  getThread(key: string): string | undefined {
    return this.threadTs.get(key)
  }

  setThread(key: string, ts: string): void {
    this.threadTs.set(key, ts)
    for (const evicted of overflowKeys(this.threadTs, MAX_THREADS)) {
      this.threadTs.delete(evicted)
    }
    this.persist()
  }

  /**
   * 메시지를 게시하고 ts를 반환한다. threadTs가 있으면 스레드 답장으로 게시한다.
   * blocks를 함께 보내면 text는 알림 미리보기와 스크린리더 폴백으로 쓰인다.
   */
  async post(text: string, threadTs?: string, blocks?: MessageBlocks): Promise<string> {
    const result = await this.client.chat.postMessage({
      channel: this.channel,
      text,
      ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
      ...(blocks === undefined ? {} : { blocks }),
    })
    if (result.ts === undefined) {
      throw new Error("chat.postMessage response has no ts")
    }
    return result.ts
  }

  // 키별 게시 체인은 서로 병렬이라 저장이 겹칠 수 있다. 단일 쓰기 체인으로
  // 직렬화해 부분적으로 덮어쓴 파일이 남지 않게 한다.
  private persist(): void {
    const text = serializeThreads(this.threadTs)
    this.writes = this.writes
      .then(async () => {
        await mkdir(dirname(THREADS_PATH), { recursive: true })
        await writeFile(THREADS_PATH, text, "utf8")
      })
      .catch((error) => {
        console.error(`thread mapping persist failed: ${THREADS_PATH}`, error)
      })
  }
}

/** 저장 파일 내용을 매핑으로 되돌린다. 형식이 어긋난 값은 버린다. */
export function parseThreads(text: string): Map<string, string> {
  const threads = new Map<string, string>()

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    console.error("thread mapping file is not valid JSON:", error)
    return threads
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return threads

  for (const [key, ts] of Object.entries(parsed)) {
    if (typeof ts === "string" && ts !== "") threads.set(key, ts)
  }
  return threads
}

/** 매핑을 저장 파일 내용으로 직렬화한다. */
export function serializeThreads(threads: ReadonlyMap<string, string>): string {
  return `${JSON.stringify(Object.fromEntries(threads), null, 2)}\n`
}

/** 상한을 넘긴 만큼 삽입 순서가 오래된 키를 고른다. */
export function overflowKeys(threads: ReadonlyMap<string, string>, limit: number): string[] {
  const excess = threads.size - limit
  return excess > 0 ? Array.from(threads.keys()).slice(0, excess) : []
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}
