// lib/hooks/pre-tool-call.js
// 拦截位置 1 & 2：外部工具调用前 / 信息发送前。
//
// 挂载点：DSH 的 'tools/pre-execute' waterfall 事件（源码确证）：
//   'tools/pre-execute'(exec: ToolExecution, next: () => Promise<PreToolDecision>)
//     : Promise<PreToolDecision>
//
// 语义：waterfall 模式，不调用 next() 即短路（阻断）。这正是「操作前暂停并审查」的位置。
// 流程（对应设计文档的方案 B）：
//   1. 判断该调用是否属于受控类别（外发 / 外部工具）
//   2. 命中 → 提取最小上下文 → ⏸ 暂停（不调用 next）
//   3. 调 ctx.llm 执行 PrivacyChecker Prompt（独立审查轮次）
//   4. 解析 {risk, decision, reason, allowed_data, blocked_data}
//   5. 映射为 PreToolDecision 并返回

import { classifyOperation, extractDisclosureData } from '../config.js'
import { runPrivacyReview } from '../checker/evaluate.js'
import { toPreToolDecision, isReadLikeOperation } from '../checker/decision.js'

/**
 * 处理一次 pre-execute。
 * @param {object} params
 * @param {object} params.exec            DSH 的 ToolExecution（含 name / arguments / agent）
 * @param {Function} params.next          waterfall 放行函数
 * @param {object} params.ctx             Cordis 上下文
 * @param {object} params.config          已解析配置
 * @param {object} params.logger          审查日志器
 * @param {Map}    [params.pendingReviews] MODIFY 登记表（callId/action → review），供 post-execute 脱敏
 * @returns {Promise<object>} PreToolDecision
 */
export async function handlePreExecute({ exec, next, ctx, config, logger, pendingReviews }) {
  const action = exec?.name ?? exec?.toolName ?? 'unknown'
  const args = exec?.arguments ?? exec?.args ?? {}

  // 1. 分类：是否属于受控拦截位置
  const cls = classifyOperation(action, args, config)
  if (!cls.matched) {
    return next()
  }

  // 2. 提取最小上下文（不传完整对话历史）
  const dataToBeSent = extractDisclosureData(args)
  const task = ctx?.__privacycheckerTask || '(task not captured)'

  const reviewInput = {
    task,
    action,
    recipient: cls.interceptPoint === 'outbound-send' ? 'external recipient' : 'external_service',
    dataToBeSent,
    interceptPoint: cls.interceptPoint,
  }

  // 3. 暂停并执行独立审查轮次
  const review = await runPrivacyReview({
    llm: ctx?.llm,
    input: reviewInput,
    config,
  })

  // 4. 记录审计
  try {
    logger?.record({
      kind: 'pre-execute',
      interceptPoint: cls.interceptPoint,
      action,
      decision: review.decision,
      risk: review.risk,
      degraded: !!review.degraded,
      latencyMs: review.latencyMs,
      reason: review.reason,
      blockedData: review.blockedData,
      matchedReasons: cls.reasons,
    })
  } catch { /* 审计失败不影响主流程 */ }

  // 5. 映射为 DSH 决策
  const decision = toPreToolDecision(review, { action, config, interceptPoint: cls.interceptPoint })

  // MODIFY + 读类操作：登记待脱敏，供 post-execute 替换读回内容。
  // 只按 callId 登记——避免用 action 名做 key 导致不同调用互相误命中。
  if (review.decision === 'MODIFY' && isReadLikeOperation(action, cls.interceptPoint) && pendingReviews) {
    const key = exec?.callId ?? exec?.id
    if (key != null) pendingReviews.set(key, review)
  }

  if (decision.kind === 'allow') {
    return next()
  }
  return decision
}
