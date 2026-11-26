// lib/hooks/post-read.js
// MODIFY 的落地（M1 方案）：读类操作放行后，在 post-execute 阶段对「读回的内容」脱敏。
//
// 挂载点：DSH 的 'tools/post-execute' waterfall 事件（源码确证）：
//   'tools/post-execute'(exec, result: Readonly<ToolExecutionResult>, next)
//     : Promise<PostToolDecision>
//
// 返回 { kind:'accept', content: [...] } 即替换进入模型上下文的内容。

import { redactByReview } from '../checker/decision.js'

/**
 * 从 ToolExecutionResult 中提取文本内容。
 */
export function extractContentText(result) {
  if (!result) return ''
  if (typeof result === 'string') return result
  if (typeof result.content === 'string') return result.content
  if (Array.isArray(result.content)) {
    return result.content
      .map((b) => (typeof b === 'string' ? b : b?.text ?? ''))
      .join('')
  }
  if (typeof result.text === 'string') return result.text
  return ''
}

/**
 * 处理一次 post-execute：对读回内容做脱敏。
 * 注意：只在该次调用曾被审查（由 pendingReviews 标记）时生效，避免无差别改写。
 *
 * @param {object} params
 * @param {object} params.exec
 * @param {object} params.result
 * @param {Function} params.next
 * @param {object} params.config
 * @param {Map} params.pendingReviews  由 pre-execute 写入的待脱敏标记（callId → review）
 * @param {object} params.logger
 * @returns {Promise<object>} PostToolDecision
 */
export async function handlePostExecute({ exec, result, next, config, pendingReviews, logger }) {
  const action = exec?.name ?? exec?.toolName ?? 'unknown'

  // 找出该调用的审查记录（只按 callId 匹配，避免同名调用互相误命中）
  const key = exec?.callId ?? exec?.id ?? null
  const review = key != null ? pendingReviews?.get(key) : null
  if (!review || review.decision !== 'MODIFY' || !review.blockedData?.length) {
    return next()
  }

  const originalText = extractContentText(result)
  if (!originalText) return next()

  const { text: redacted, replaced } = redactByReview(review, originalText)
  if (replaced === 0) {
    return next()
  }

  try {
    logger?.record({
      kind: 'post-execute-redact',
      action,
      decision: 'MODIFY',
      replacedFields: replaced,
      blockedData: review.blockedData,
      latencyMs: 0,
    })
  } catch { /* noop */ }

  // 替换进入模型上下文的内容（canonical value 不动）：
  // 用整体脱敏文本替换掉纯文本块，非文本块（图片等）原样保留。
  const nonTextBlocks = Array.isArray(result?.content)
    ? result.content.filter((b) => b && b.type && b.type !== 'text')
    : []
  const replacement = [{ type: 'text', text: redacted }, ...nonTextBlocks]

  // waterfall 契约：先让下游处理，再覆盖内容；下游若明确阻断则尊重其决定。
  try {
    const downstream = await next()
    if (downstream && downstream.kind === 'block') {
      return downstream
    }
    // 无论下游返回 accept 还是其它放行形态，都用脱敏内容覆盖
    return { ...(downstream && typeof downstream === 'object' ? downstream : {}), kind: 'accept', content: replacement }
  } catch {
    return { kind: 'accept', content: replacement }
  }
}
