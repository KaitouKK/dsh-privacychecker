// lib/checker/evaluate.js
// 独立审查轮次（方案 B）：暂停工具执行，用同一个 Agent 模型执行 PrivacyChecker Prompt，
// 返回结构化审查结果。不依赖独立 HTTP 推理服务。
//
// 设计要点（对应设计文档）：
//   - 最小上下文：不传完整对话历史
//   - 参数视为不可信数据（在 prompt 中已声明）
//   - 超时 + 降级策略（fail-open / fail-closed 可配）

import {
  PRIVACY_CHECKER_SYSTEM_PROMPT,
  buildReviewUserMessage,
  parseReviewResult,
} from '../prompts/privacy-checker.js'

/**
 * 构造审查请求消息数组。
 * @param {object} input { task, action, recipient, dataToBeSent, userContext, interceptPoint }
 * @returns {Array<{role:string, content:string}>}
 */
export function buildReviewMessages(input) {
  return [
    { role: 'system', content: PRIVACY_CHECKER_SYSTEM_PROMPT },
    { role: 'user', content: buildReviewUserMessage(input) },
  ]
}

/**
 * 从 lll 返回中提取纯文本（兼容多种返回形态）。
 */
function extractText(response) {
  if (response == null) return ''
  if (typeof response === 'string') return response
  if (typeof response.text === 'string') return response.text
  if (Array.isArray(response.content)) {
    return response.content
      .map((b) => (typeof b === 'string' ? b : b?.text || ''))
      .join('')
  }
  if (response.message?.content) {
    const c = response.message.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.map((b) => b?.text || '').join('')
  }
  return ''
}

/** 裁剪过长文本 */
function truncate(text, max) {
  if (!text || text.length <= max) return text
  return `${text.slice(0, max)}\n... [truncated ${text.length - max} chars]`
}

/**
 * 执行一次隐私审查（独立审查轮次）。
 *
 * @param {object} params
 * @param {object} params.llm         DSH 的 ctx.llm 服务（需具备对话能力）
 * @param {object} params.input       审查输入 { task, action, recipient, dataToBeSent, ... }
 * @param {object} [params.config]    配置
 * @param {Function} [params.invokeModel] 可选：自定义模型调用函数（便于测试注入）
 * @returns {Promise<object>} 审查结果 + 元数据
 */
export async function runPrivacyReview({ llm, input, config = {}, invokeModel = null }) {
  const maxChars = config.maxReviewChars ?? 8000
  const timeoutMs = config.reviewTimeoutMs ?? 30000

  // 序列化并裁剪参数字段，防止超大参数拖垮审查
  let dataJson
  try {
    dataJson = JSON.stringify(input.dataToBeSent ?? {}, null, 2)
  } catch {
    dataJson = String(input.dataToBeSent ?? '')
  }
  const truncatedJson = truncate(dataJson, maxChars)
  let parsedData
  try {
    parsedData = JSON.parse(truncatedJson)
  } catch {
    // 截断破坏了 JSON，回退为纯文本形式（审查仍可进行）
    parsedData = { _raw_truncated: truncatedJson }
  }

  const messages = buildReviewMessages({ ...input, dataToBeSent: parsedData })

  const startedAt = Date.now()
  let raw = ''
  let error = null

  try {
    raw = await withTimeout(async () => {
      if (typeof invokeModel === 'function') {
        return extractText(await invokeModel(messages))
      }
      // DSH 的 ctx.llm：优先使用 chat/completion 风格接口
      if (llm && typeof llm.chat === 'function') {
        return extractText(await llm.chat({ messages }))
      }
      if (llm && typeof llm.complete === 'function') {
        return extractText(await llm.complete({ messages }))
      }
      if (llm && typeof llm.generate === 'function') {
        return extractText(await llm.generate({ messages }))
      }
      throw new Error('ctx.llm 不提供可用的对话接口（chat/complete/generate）')
    }, timeoutMs)
  } catch (err) {
    error = err
  }

  const latencyMs = Date.now() - startedAt

  if (error) {
    const failClosed = config.onReviewFailure === 'fail-closed'
    return {
      ok: false,
      error: String(error.message || error),
      decision: failClosed ? 'BLOCK' : 'ALLOW',
      risk: failClosed ? 'HIGH' : 'LOW',
      reason: `审查失败：${String(error.message || error)}（降级为 ${failClosed ? 'fail-closed 阻断' : 'fail-open 放行'}）`,
      allowedData: {},
      blockedData: [],
      informationFlows: [],
      latencyMs,
      degraded: true,
    }
  }

  const parsed = parseReviewResult(raw)
  if (!parsed) {
    const failClosed = config.onReviewFailure === 'fail-closed'
    return {
      ok: false,
      error: '审查输出无法解析为结构化决策',
      raw: truncate(raw, 2000),
      decision: failClosed ? 'BLOCK' : 'ALLOW',
      risk: failClosed ? 'HIGH' : 'LOW',
      reason: '审查输出解析失败，按降级策略处理',
      allowedData: {},
      blockedData: [],
      informationFlows: [],
      latencyMs,
      degraded: true,
    }
  }

  return { ok: true, raw, latencyMs, ...parsed }
}

/** Promise 超时包装 */
function withTimeout(fn, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`审查超时（${ms}ms）`)), ms)
    Promise.resolve()
      .then(fn)
      .then((v) => { clearTimeout(timer); resolve(v) })
      .catch((e) => { clearTimeout(timer); reject(e) })
  })
}
