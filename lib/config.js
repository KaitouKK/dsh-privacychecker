// lib/config.js
// 拦截点识别与配置：决定「哪些操作需要隐私审查」以及「以何种方式拦截」。
//
// 第一版聚焦两个优先拦截位置（按设计文档的决策）：
//   1. 外部工具调用前（external-tool-call）——搜索、购物、预订、第三方 API
//   2. 信息发送前（outbound-send）——发送邮件、提交表单、发布内容
//
// 注意：DSH 的 PreToolDecision 不支持改写参数（源码注释明确：
// "Input rewriting is excluded because arguments are already logged and presented."），
// 因此 MODIFY 采用 M1 方案：读操作在 post-execute 脱敏；写/外发操作 deny + 建议重试。

/**
 * 默认配置。
 */
export const DEFAULT_CONFIG = {
  /** 总开关 */
  enabled: true,
  /** 审查模式：'enforce' 真正拦截 | 'observe' 只记录不拦截（用于评估对比） */
  mode: 'enforce',
  /**
   * 受控操作分类规则：按工具名/参数特征匹配。
   * 每条规则：{ id, name, interceptPoint, weight, match(action, argsText) }
   */
  externalToolCall: {
    enabled: true,
    /** 外部服务特征：网络/第三方 API/搜索/预订 */
    patterns: [
      'search', 'web', 'browse', 'http', 'fetch', 'api', 'request',
      'booking', 'reserve', 'order', 'purchase', 'shop', 'buy',
      'map', 'weather', 'translate', 'stock', 'flight', 'hotel',
      'book', 'travel', 'delivery', 'payment', 'pay',
      '搜索', '查询', '预订', '购买', '下单', '预约', '支付',
    ],
  },
  outboundSend: {
    enabled: true,
    /**
     * 外发特征：发送/提交/发布/上传。
     * 注意：用作「动作前缀词」匹配而非任意子串，避免 gmail_search_messages
     * 这类读取工具因含 "message" 被误判为外发。
     */
    patterns: [
      'send', 'submit', 'post', 'publish', 'upload', 'share', 'email', 'mail',
      'notify', 'webhook', 'sms', 'tweet', 'comment', 'reply', 'forward',
      '发送', '提交', '发布', '上传', '分享', '回复', '转发',
    ],
    /** 出现这些词则排除（读类工具名常见词） */
    excludePatterns: ['search', 'get', 'list', 'read', 'fetch', 'query', 'view', 'history'],
  },
  /** 审查结果对应的拦截动作映射（M1 方案） */
  actionMapping: {
    ALLOW: 'allow',
    MODIFY: 'modify', // 读操作→post-execute 脱敏；写/外发→deny+建议
    BLOCK: 'deny',    // 或 'ask'（转人工确认）
  },
  /** BLOCK 时是否转人工确认（true=ask，false=deny） */
  blockRequiresApproval: false,
  /** 审查超时（毫秒）；超时按 fail-closed 处理（默认保守阻断） */
  reviewTimeoutMs: 30000,
  /** 超时/异常时的降级策略：'fail-open'（放行）| 'fail-closed'（阻断） */
  onReviewFailure: 'fail-open',
  /** 单次审查最大字符数（防止超大参数拖垮审查） */
  maxReviewChars: 8000,
  /** 是否把审查事件写入审计 */
  audit: true,
}

/** 合并用户配置（浅合并到默认值） */
export function resolveConfig(userConfig = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...userConfig,
    externalToolCall: { ...DEFAULT_CONFIG.externalToolCall, ...(userConfig.externalToolCall || {}) },
    outboundSend: { ...DEFAULT_CONFIG.outboundSend, ...(userConfig.outboundSend || {}) },
    actionMapping: { ...DEFAULT_CONFIG.actionMapping, ...(userConfig.actionMapping || {}) },
  }
}

/** 判断是否命中某个分类的模式 */
function matchesPatterns(haystack, patterns) {
  const lower = haystack.toLowerCase()
  return patterns.some((p) => lower.includes(String(p).toLowerCase()))
}

/**
 * 识别一次工具调用属于哪个拦截位置。
 * @param {string} action 工具名
 * @param {object|string} args 参数
 * @param {object} config
 * @returns {{matched: boolean, interceptPoint: string|null, reasons: string[]}}
 */
export function classifyOperation(action, args, config = DEFAULT_CONFIG) {
  const actionText = String(action || '')
  let argsText = ''
  if (typeof args === 'string') argsText = args
  else if (args && typeof args === 'object') {
    try {
      argsText = JSON.stringify(args)
    } catch {
      argsText = String(args)
    }
  }
  const haystack = `${actionText} ${argsText}`

  const reasons = []
  let interceptPoint = null

  // 优先判定「信息发送前」（安全边界更明确）
  if (config.outboundSend?.enabled) {
    const excluded = (config.outboundSend.excludePatterns || []).some((p) =>
      actionText.toLowerCase().includes(String(p).toLowerCase()),
    )
    if (!excluded && matchesPatterns(actionText, config.outboundSend.patterns)) {
      interceptPoint = 'outbound-send'
      reasons.push('工具名命中外发特征')
    }
  }

  // 其次「外部工具调用前」
  if (!interceptPoint && config.externalToolCall?.enabled &&
      (matchesPatterns(actionText, config.externalToolCall.patterns) ||
       matchesPatterns(haystack, ['http://', 'https://', '@']))) {
    interceptPoint = 'external-tool-call'
    reasons.push('命中外部服务调用特征')
  }

  return {
    matched: interceptPoint !== null,
    interceptPoint,
    reasons,
  }
}

/**
 * 从工具参数中提取将要披露的数据（供审查 prompt 使用）。
 * 采取「最小上下文」原则：只挑与披露相关的字段，忽略无关大字段。
 * @param {object} args
 * @returns {object}
 */
export function extractDisclosureData(args) {
  if (!args || typeof args !== 'object') return { raw: String(args ?? '') }
  const sensitiveKeys = [
    'to', 'cc', 'bcc', 'recipient', 'recipients', 'email', 'subject', 'body',
    'content', 'message', 'text', 'data', 'payload', 'location', 'address',
    'phone', 'phone_number', 'age', 'birth', 'birthday', 'id', 'user_id',
    'url', 'endpoint', 'query', 'params', 'headers', 'form', 'fields',
  ]
  const out = {}
  for (const key of Object.keys(args)) {
    const lower = key.toLowerCase()
    if (sensitiveKeys.some((k) => lower === k || lower.includes(k))) {
      out[key] = args[key]
    }
  }
  // 若没有命中任何敏感字段，保留全部（字段名未知时不能漏审）
  if (Object.keys(out).length === 0) {
    return { ...args }
  }
  return out
}
