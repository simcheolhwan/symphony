import { serve } from "@hono/node-server"
import { WebClient } from "@slack/web-api"
import { Hono } from "hono"
import { loadConfig } from "./config.ts"
import { eventRoutes } from "./events.ts"
import { SlackThreads } from "./slack.ts"

const config = loadConfig(process.env)
const threads = new SlackThreads(new WebClient(config.slackBotToken), config.slackChannel)
// 수신을 시작하기 전에 매핑을 복원해야 첫 이벤트가 기존 스레드를 찾는다.
await threads.load()

const app = new Hono()
app.route("/", eventRoutes(threads, config.path, config.slackUserId))

// 127.0.0.1 전용 바인딩이 보안 경계이며 요청 인증은 두지 않는다.
serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }, (info) => {
  console.log(`notifier listening on http://127.0.0.1:${info.port}${config.path}`)
})
