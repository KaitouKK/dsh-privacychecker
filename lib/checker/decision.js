// lib/checker/decision.js
// 把 PrivacyChecker 的审查结果映射为 DSH 的 PreToolDecision / PostToolDecision。
//
// 关键约束（DSH 源码确证）：
//   PreToolDecision 仅支持 allow / deny / cancel / ask，
//   且明确排除参数改写（"Input rewriting is excluded because arguments are already logged and presented."）。
//
// 因此 M1 方案：
//   ALLOW  → { kind: 'allow' }                    直接放行
//   MODIFY → 读类操作：放行，交由 post-execute 脱敏；
//            写/外发类：{ kind: 'deny', reason } 并在 reason 中给出脱敏建议，让 Agent 重试
//   BLOCK  → { kind: 'deny' } 或 { kind: 'ask' }（可配置是否转人工确认）

/**
 * 判断一个操作是否属于「读类」（可安全放行后用 post-execute 脱敏）。
 *
 * 注意：读类判定的前提是「数据流方向为 本地 → Agent」。
 * 因此这里要求：既不含写动词，也**不是命中 outbound-send 的外发操作**。
 * 例如 `search_restaurant`（向外部服务发请求并携带 PII）名字含 search，
 * 但它是外发型调用，不能按读类放行 —— 由 interceptPoint 判定优先。
 *
 * @param {string} action 工具名
 * @param {string} [interceptPoint] 分类结果（'outbound-send' 时强制非读类）
 */
export function isReadLikeOperation(action, interceptPoint = null) {
  // 命中「信息发送前」的操作一定是外发，不算读类
  if (interceptPoint === 'outbound-send') return false

  const a = String(action || '').toLowerCase()
  const readVerbs = ['read', 'get', 'list', 'search', 'fetch', 'query', 'open', 'view', 'load', 'retrieve', 'show', 'inspect', 'find']
  const writeVerbs = ['send', 'write', 'create', 'update', 'delete', 'remove', 'post', 'submit', 'publish',
    'upload', 'share', 'insert', 'put', 'patch', 'set', 'modify', 'edit', 'move', 'copy', 'exec', 'run', 'bash',
    'book', 'reserve', 'order', 'purchase', 'pay', 'booking']
  const hasRead = readVerbs.some((v) => a.includes(v))
  const hasWrite = writeVerbs.some((v) => a.includes(v))
  return hasRead && !hasWrite
}

/**
 * 构造「脱敏建议」文本，用于 deny 时告知 Agent 应如何调整。
 */
export function buildRedactionAdvice(review) {
  const parts = []
  if (review.blockedData?.length) {
    parts.push(`必须移除或泛化的字段：${review.blockedData.join('、')}`)
  }
  if (review.allowedData && Object.keys(review.allowedData).length) {
    const allowed = Object.entries(review.allowedData)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join('、')
    parts.push(`可以保留的内容：${allowed}`)
  }
  if (!parts.length && review.reason) parts.push(review.reason)
  return parts.join('；')
}

/**
 * 映射为 PreToolDecision。
 * @param {object} review  审查结果（runPrivacyReview 的返回）
 * @param {object} params  { action, config, interceptPoint }
 * @returns {{kind:string, reason?:string, displayReason?:object}}
 */
export function toPreToolDecision(review, { action, config, interceptPoint = null }) {
  const mapping = config.actionMapping || {}
  const decision = review.decision

  // observe 模式：只记录，不拦截
  if (config.mode === 'observe') {
    return { kind: 'allow' }
  }

  if (decision === 'ALLOW') {
    return mapping.ALLOW === 'allow' ? { kind: 'allow' } : { kind: 'allow' }
  }

  if (decision === 'MODIFY') {
    if (isReadLikeOperation(action, interceptPoint)) {
      // 读类：允许执行，post-execute 阶段对读回内容脱敏
      return { kind: 'allow' }
    }
    // 写/外发类：无法改参数 → deny 并给出脱敏建议
    const advice = buildRedactionAdvice(review)
    return {
      kind: 'deny',
      reason: `[PrivacyChecker] 该操作需要脱敏后才能执行。${advice}。请按建议移除或泛化敏感字段后重试。`,
    }
  }

  // BLOCK
  if (config.blockRequiresApproval) {
    return {
      kind: 'ask',
      reason: review.reason || 'PrivacyChecker 建议阻断，需人工确认',
      displayReason: {
        en: `PrivacyChecker blocked this operation: ${review.reason || 'privacy risk'}`,
        zh: `PrivacyChecker 判定该操作存在隐私风险：${review.reason || '风险较高'}。是否仍要执行？`,
      },
    }
  }
  return {
    kind: 'deny',
    reason: `[PrivacyChecker] 已阻断：${review.reason || '该披露超出授权边界'}`,
  }
}

/**
 * 生成 post-execute 阶段用于脱敏的替换内容。
 * 把 blockedData 中列出的字段从结果文本中替换为占位符。
 * @param {object} review
 * @param {string} contentText 原始结果文本
 * @returns {{text:string, replaced:number}}
 */
export function redactByReview(review, contentText) {
  if (typeof contentText !== 'string' || !contentText) {
    return { text: contentText, replaced: 0 }
  }
  let text = contentText
  let replaced = 0

  for (const field of review.blockedData || []) {
    if (!field) continue
    // 覆盖三种常见形态：
    //   1. "field": "值"   （JSON 字符串值）
    //   2. "field": 123    （JSON 数字/布尔值）
    //   3. field: 值 / field=值（纯文本键值）
    const patterns = [
      new RegExp(`("${escapeRegExp(field)}"\\s*:\\s*)"[^"]*"`, 'g'),
      new RegExp(`("${escapeRegExp(field)}"\\s*:\\s*)(?:-?\\d+(?:\\.\\d+)?|true|false|null)`, 'g'),
      new RegExp(`(\\b${escapeRegExp(field)}\\b\\s*[=:]\\s*)[^\\s,;\\n]+`, 'g'),
    ]
    for (const re of patterns) {
      text = text.replace(re, (m, prefix) => {
        // 已经是占位符则跳过，避免重复替换
        if (m.includes('REDACTED-BY-PRIVACYCHECKER')) return m
        replaced++
        return `${prefix}"[REDACTED-BY-PRIVACYCHECKER]"`
      })
    }
  }
  return { text, replaced }
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
