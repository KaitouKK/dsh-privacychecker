// lib/index.js
// dsh-privacychecker —— 操作前隐私审查（Pre-action Privacy Check）插件。
//
// 与 dsh-privacy-guard（规则引擎）的区别：
//   guard  = 确定性规则（正则/评分），快速、零模型调用
//   checker = 模型审查（独立审查轮次），语义级判断「信息是否必要、可否披露、是否越界」
// 两者互补：guard 做低成本硬拦，checker 做语义级把关。
//
// 挂载机制（源码确证，见 dsh-privacychecker-design.md）：
//   ctx.on('tools/pre-execute', handler)   → 操作前审查（ALLOW/MODIFY/BLOCK）
//   ctx.on('tools/post-execute', handler)  → 读回内容脱敏（M1 方案的 MODIFY 落地）
//
// 插件形态：Cordis 约定，导出 { name, inject, apply }。
// 注意（沿用 dsh-privacy-guard 的运行时经验）：
//   - apply 内不触碰 ctx.config（DSH 会抛 "cannot get property config without inject"）
//   - 不向 ctx 挂自定义属性（Cordis 有严格对象契约）

import { resolveConfig } from './config.js'
import { handlePreExecute } from './hooks/pre-tool-call.js'
import { handlePostExecute } from './hooks/post-read.js'
import { createReviewLogger } from './logger.js'

export const name = 'privacychecker'
export const inject = ['tools'] // 依赖工具注册表；llm 用防御式读取（激活时机靠后，不注入等待）

/** 模块级状态：供外部查询（不挂 ctx，遵守 Cordis 对象契约） */
let _logger = null
let _config = null
const _pendingReviews = new Map()

/**
 * 查询最近的审查记录（供测试/评估使用）。
 */
export function getRecentReviews(limit = 200) {
  return _logger ? _logger.getRecent(limit) : []
}

/** 审查统计（决策分布、平均延迟），供评估对比 */
export function getReviewStats() {
  return _logger ? _logger.stats() : { total: 0, byDecision: {}, avgLatencyMs: 0, degraded: 0 }
}

/**
 * 直接跑一次审查（不经过工具管线）。便于测试与其它插件复用。
 * @param {object} input { task, action, recipient, dataToBeSent }
 * @param {object} [options] { llm, config, invokeModel }
 */
export async function reviewOperation(input, options = {}) {
  const { runPrivacyReview } = await import('./checker/evaluate.js')
  return runPrivacyReview({
    llm: options.llm,
    input,
    config: options.config ?? _config ?? resolveConfig(),
    invokeModel: options.invokeModel,
  })
}

/**
 * Cordis 插件入口。
 * @param {object} ctx DSH/Cordis 上下文
 */
export function apply(ctx) {
  // 惰性读取配置：不在 apply 内触碰 ctx.config（避免 DSH 抛错）
  const getCfg = () => {
    try {
      const c = ctx.config
      return (c && (c.privacychecker || (typeof c.get === 'function' && c.get('privacychecker')))) || {}
    } catch {
      return {}
    }
  }
  const config = resolveConfig(getCfg())
  _config = config

  const logger = createReviewLogger({ logDir: '', silent: true })
  _logger = logger

  if (!config.enabled) {
    return { dispose() { logger.close() } }
  }

  // ── 拦截位置 1 & 2：外部工具调用前 / 信息发送前 ──
  // tools/pre-execute 是 waterfall：不调用 next() 即阻断。
  if (typeof ctx.on === 'function') {
    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        return await handlePreExecute({ exec, next, ctx, config, logger, pendingReviews: _pendingReviews })
      } catch (err) {
        // 审查异常不得阻断正常业务：按降级策略处理
        logger.record({
          kind: 'pre-execute-error',
          action: exec?.name ?? 'unknown',
          decision: config.onReviewFailure === 'fail-closed' ? 'BLOCK' : 'ALLOW',
          degraded: true,
          error: String(err?.message || err),
        })
        if (config.onReviewFailure === 'fail-closed') {
          return { kind: 'deny', reason: `[PrivacyChecker] 审查不可用，已按 fail-closed 阻断：${String(err?.message || err)}` }
        }
        return next()
      }
    })

    // ── MODIFY 落地：读回内容脱敏 ──
    ctx.on('tools/post-execute', async (exec, result, next) => {
      try {
        return await handlePostExecute({ exec, result, next, config, pendingReviews: _pendingReviews, logger })
      } catch (err) {
        logger.record({
          kind: 'post-execute-error',
          action: exec?.name ?? 'unknown',
          error: String(err?.message || err),
        })
        return next()
      }
    })
  }

  return {
    dispose() {
      try {
        logger.close()
        _pendingReviews.clear()
      } catch { /* noop */ }
    },
  }
}
