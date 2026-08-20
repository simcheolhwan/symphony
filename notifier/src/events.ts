import { Hono } from "hono"
import { z } from "zod"
import type { SlackThreads } from "./slack.ts"
import { bodyText, replyBlocks, replyText } from "./templates.ts"

// event는 열린 집합이다. 정의되지 않은 종류도 통과시켜 발신 측이 종류를
// 추가해도 수신 측 수정이 필요 없게 한다.
export const lifecycleEventSchema = z.object({
  instance: z.string().min(1),
  workflow: z.string().optional(),
  target: z.string().optional(),
  event: z.string().min(1),
  reason: z.string().optional(),
  dispatch_reasons: z.array(z.string()).optional(),
  observed: z.array(z.string()).optional(),
  agent_message: z.string().optional(),
  issue: z.object({
    id: z.string().min(1),
    identifier: z.string().min(1),
    title: z.string().optional(),
    url: z.url(),
    state: z.string().min(1),
    pr_author: z.string().optional(),
  }),
})

export type LifecycleEvent = z.infer<typeof lifecycleEventSchema>

export function eventRoutes(threads: SlackThreads, path: string, mentionUserId: string): Hono {
  const app = new Hono()

  app.post(path, async (c) => {
    const body = await c.req.json().catch(() => undefined)
    const parsed = lifecycleEventSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: z.treeifyError(parsed.error) }, 400)
    }
    publish(threads, parsed.data, mentionUserId)
    return c.body(null, 202)
  })

  return app
}

function publish(threads: SlackThreads, payload: LifecycleEvent, mentionUserId: string): void {
  const key = `${payload.instance}:${payload.issue.id}`

  threads.enqueue(key, async () => {
    const text = replyText(payload, mentionUserId)
    const blocks = replyBlocks(payload, mentionUserId)
    const existing = threads.getThread(key)

    if (existing !== undefined) {
      await threads.post(text, existing, blocks)
      return
    }

    // 하나의 작업 대상은 스레드 하나만 쓴다. 매핑이 없는 첫 이벤트만 작업 헤더
    // 본문을 만들고, 재디스패치의 started를 포함한 모든 이벤트는 그 답글이다.
    // 본문은 mrkdwn 문법만 쓰므로 text 단독으로 게시한다.
    const ts = await threads.post(bodyText(payload))
    threads.setThread(key, ts)
    await threads.post(text, ts, blocks)
  })
}
