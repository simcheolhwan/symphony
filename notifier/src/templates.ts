import type { LifecycleEvent } from "./events.ts"
import type { MessageBlocks } from "./slack.ts"

// 초록 체크(✅)는 워크플로 종결에만 쓰고, 빨강(⛔ 🛑)은 사람 개입이 필요한 정지,
// 노랑(⚠️)은 시스템이 자체 처리 중인 실패를 뜻한다.
const eventLabels: Record<string, { emoji: string; label: string }> = {
  started: { emoji: "▶️", label: "시작" },
  retried: { emoji: "⚠️", label: "실패" },
  blocked: { emoji: "⛔", label: "차단" },
  killed: { emoji: "🛑", label: "중단" },
  settled: { emoji: "💤", label: "대기" },
  completed: { emoji: "⏭️", label: "조치" },
  mergeable: { emoji: "🔔", label: "수렴" },
  finished: { emoji: "✅", label: "종결" },
}

const countedReasonLabels: Record<string, string> = {
  unresolved_threads: "미해결 리뷰 스레드",
  failing_checks: "CI 실패",
}

const flagReasonLabels: Record<string, string> = {
  changes_requested: "스레드 없는 Changes requested",
  review_rerequest_pending: "리뷰 재요청 대기",
}

const PR_IDENTIFIER_PATTERN = /^GH-\d+$/

const AGENT_SUMMARY_LIMIT = 500

// mrkdwn은 이 세 문자의 이스케이프를 요구하고, 하지 않으면 `<!channel>` 같은
// 특수 시퀀스가 해석되어 PR 제목처럼 외부에서 온 텍스트로 멘션을 위조할 수 있다.
const escapeMrkdwn = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

export function bodyText({ instance, workflow, target, issue }: LifecycleEvent): string {
  const heading = escapeMrkdwn(workflow && target ? `${workflow} (${target})` : instance)
  const title = issue.title ? ` ${escapeMrkdwn(issue.title)}` : ""
  const author = issue.pr_author ? ` (PR 저자: ${escapeMrkdwn(issue.pr_author)})` : ""
  return `▶️ *${heading}* <${escapeMrkdwn(issue.url)}|${escapeMrkdwn(linkText(issue))}>${title}${author}`
}

// 트래커가 PR을 이슈로 정규화하면서 붙인 식별자보다 PR 번호가 읽기 쉽다.
function linkText({ id, identifier }: LifecycleEvent["issue"]): string {
  return PR_IDENTIFIER_PATTERN.test(identifier) ? `PR #${id}` : identifier
}

/**
 * 답글의 블록 구성. 에이전트 요약은 에이전트가 쓴 표준 마크다운이라 mrkdwn으로
 * 변환하지 않고 markdown 블록에 원문 그대로 싣는다. `*강조*`처럼 두 문법의
 * 의미가 갈리는 표기가 있어 변환은 원천적으로 부정확하다. 멘션은 markdown
 * 블록에서 렌더링되지 않으므로 상태줄은 mrkdwn section 블록에 둔다.
 */
export function replyBlocks(payload: LifecycleEvent, mentionUserId: string): MessageBlocks {
  const blocks: MessageBlocks = [
    { type: "section", text: { type: "mrkdwn", text: statusLine(payload, mentionUserId) } },
  ]

  const summary = agentSummary(payload.agent_message)
  if (summary !== undefined) {
    blocks.push({ type: "markdown", text: `↳ **(에이전트 요약)** ${summary}` })
  }
  return blocks
}

/** blocks와 함께 보내는 알림 미리보기와 스크린리더 폴백. mrkdwn 문법으로 쓴다. */
export function replyText(payload: LifecycleEvent, mentionUserId: string): string {
  const line = statusLine(payload, mentionUserId)
  const summary = agentSummary(payload.agent_message)
  return summary === undefined ? line : `${line}\n↳ *(에이전트 요약)* ${escapeMrkdwn(summary)}`
}

// 스레드를 팔로우하지 않으면 답글 알림이 오지 않으므로 멘션으로 알림을 보장한다.
// 본문은 채널 메시지라 이미 알림 대상이어서 멘션하지 않는다.
function statusLine(payload: LifecycleEvent, mentionUserId: string): string {
  const { event, reason, dispatch_reasons, observed, issue } = payload
  const { emoji, label } = eventLabels[event] ?? { emoji: "ℹ️", label: event }
  const segments = [`<@${mentionUserId}> ${emoji} ${escapeMrkdwn(label)} (${escapeMrkdwn(issue.state)})`]

  if (reason) segments.push(escapeMrkdwn(reason))
  if (dispatch_reasons !== undefined && dispatch_reasons.length > 0) {
    segments.push(
      `디스패치 사유: ${dispatch_reasons.map((code) => escapeMrkdwn(dispatchReasonText(code))).join(", ")}`,
    )
  }
  if (observed !== undefined && observed.length > 0) {
    segments.push(`관측: ${observed.map(escapeMrkdwn).join(", ")}`)
  }

  return segments.join(" — ")
}

// 첫 줄을 요약으로 쓰는 요구는 워크플로 프롬프트가 걸지만 에이전트가 어길 수
// 있으므로, 표현 계층에서 첫 줄만 취하고 길이를 자른다.
function agentSummary(agentMessage: string | undefined): string | undefined {
  if (agentMessage === undefined) return undefined

  const firstLine = agentMessage
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (firstLine === undefined) return undefined

  return firstLine.length > AGENT_SUMMARY_LIMIT
    ? `${firstLine.slice(0, AGENT_SUMMARY_LIMIT)}…`
    : firstLine
}

// 사유 코드는 발신 측과 합의한 코드다. 합의에 없는 코드는 원문 그대로 보여
// 발신 측이 코드를 추가해도 알림이 비어 보이지 않게 한다.
function dispatchReasonText(code: string): string {
  const flagLabel = flagReasonLabels[code]
  if (flagLabel !== undefined) return flagLabel

  const separator = code.indexOf(":")
  if (separator > 0) {
    const countedLabel = countedReasonLabels[code.slice(0, separator)]
    if (countedLabel !== undefined) return `${countedLabel} ${code.slice(separator + 1)}건`
  }

  return code
}
