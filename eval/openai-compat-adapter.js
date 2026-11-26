// eval/openai-compat-adapter.js
// 把任意 OpenAI 兼容端点（/v1/chat/completions）适配为审查器的 invokeModel 函数。
// 用于第 4 步：真实模型端到端测试。

/**
 * @param {object} opts
 * @param {string} opts.url     完整 chat/completions URL
 * @param {string} opts.apiKey  Bearer 密钥
 * @param {string} [opts.model] 模型名
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxTokens]
 * @returns {(messages:Array)=>Promise<{text:string, usage:object, latencyMs:number}>}
 */
export function createOpenAICompatModel(opts) {
  const { url, apiKey, model = 'deepseek-v3', timeoutMs = 90000, maxTokens = 2048 } = opts

  return async function invoke(messages) {
    const startedAt = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0 }),
        signal: controller.signal,
      })
      const latencyMs = Date.now() - startedAt
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`)
      }
      const data = await res.json()
      const text = data?.choices?.[0]?.message?.content ?? ''
      return {
        text,
        usage: data?.usage ?? {},
        latencyMs,
        raw: data,
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * 包装为审查器可直接使用的 invokeModel（审查器只取文本）。
 */
export function asReviewInvoker(adapter, onUsage) {
  return async function invokeModel(messages) {
    const r = await adapter(messages)
    if (typeof onUsage === 'function') onUsage(r.usage || {}, r.latencyMs || 0)
    return r.text
  }
}
