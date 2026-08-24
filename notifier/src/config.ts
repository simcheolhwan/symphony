import { z } from "zod"

export const NOTIFIER_HEALTH_PATH = "/healthz"
export const NOTIFIER_HEALTH_RESPONSE = "symphony-notifier-ready"

// 발신 측(오케스트레이터)이 쓰는 URL 하나에서 수신 포트와 경로를 도출한다.
// 포트를 따로 두면 양쪽이 어긋나도 발신 측 연결 실패 로그로만 드러난다.
// 서버는 127.0.0.1에 바인딩하므로 호스트도 그 표기 하나만 허용한다. localhost는
// 발신(Erlang)과 수신(Node)의 IPv4/IPv6 리졸브가 갈릴 수 있어 배제한다.
const notifyUrlSchema = z
  .string()
  .trim()
  .pipe(z.url())
  .transform((source) => ({ source, url: new URL(source) }))
  .refine(({ url }) => url.protocol === "http:", "http 스킴이어야 합니다.")
  .refine(({ url }) => url.hostname === "127.0.0.1", "호스트가 127.0.0.1이어야 합니다.")
  .refine(({ url }) => url.username === "" && url.password === "", "사용자 정보가 없어야 합니다.")
  .transform(({ source, url }, context) => {
    // URL은 명시된 기본 포트(:80)를 정규화하며 제거하므로 발신자와 같은 원문
    // 규칙으로 포트를 읽는다.
    const port = Number(/^http:\/\/127\.0\.0\.1:(\d+)(?:[/?#]|$)/.exec(source)?.[1])
    if (!Number.isInteger(port) || port <= 0) {
      context.addIssue({ code: "custom", message: "포트가 명시되어야 합니다." })
      return z.NEVER
    }
    return { port, url }
  })

const envSchema = z.object({
  SYMPHONY_NOTIFY_URL: notifyUrlSchema,
  SYMPHONY_SLACK_BOT_TOKEN: z.string().min(1),
  SYMPHONY_SLACK_CHANNEL: z.string().regex(/^[CG][A-Z0-9]+$/, "Slack 채널 ID 형식이어야 합니다."),
  // 잘못된 ID는 Slack이 오류 없이 평문으로 출력해 조용히 실패하므로 형식을 여기서 잡는다.
  // U는 일반 사용자, W는 Enterprise Grid 사용자 ID다.
  SYMPHONY_SLACK_USER_ID: z.string().regex(/^[UW][A-Z0-9]+$/, "Slack 사용자 ID 형식이어야 합니다."),
})

export interface Config {
  port: number
  path: string
  slackBotToken: string
  slackChannel: string
  slackUserId: string
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = envSchema.parse(env)
  return {
    port: parsed.SYMPHONY_NOTIFY_URL.port,
    path: parsed.SYMPHONY_NOTIFY_URL.url.pathname,
    slackBotToken: parsed.SYMPHONY_SLACK_BOT_TOKEN,
    slackChannel: parsed.SYMPHONY_SLACK_CHANNEL,
    slackUserId: parsed.SYMPHONY_SLACK_USER_ID,
  }
}
